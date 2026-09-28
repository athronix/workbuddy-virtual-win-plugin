/**
 * WinVM Bridge —— VM 侧统一 Agent 服务
 *
 * 同时暴露：
 *   POST /mcp                        MCP（主干通道，方案 1）
 *   POST /a2a                        A2A v1.0 JSON-RPC（委派通道，方案 4）
 *   GET  /.well-known/agent-card.json A2A 发现（RFC 8615）
 *   GET  /health                     健康检查
 *
 * 两个通道**共享同一内核**：能力注册表 → 策略引擎 → 审批闸 → 审计链 → 桥接层 → 能力执行（FR-103）。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import {
  A2A,
  type AgentServiceProvider,
  type ApprovalCoordinator,
  type ApprovalRequest,
  type Artifact,
  type BridgeContext,
  type CacheHealth,
  type CapabilityDefinition,
  type CapabilityId,
  type GoalRequest,
  type HealthStatus,
  type LoggingHealth,
  type ProgressSink,
  type RiskLevel,
  makeError,
  riskAtLeast,
} from '@winvm/contracts';
import {
  CapabilityRegistry,
  CorePolicyEngine,
  HashChainAuditSink,
  SessionMonitor,
  createFileLogger,
  loadProvider,
  newId,
  newTraceId,
  resolveNetCfgTtlMs,
  resolveNetCfgPrewarmTimeoutMs,
  resolveServiceConfig,
  validateServiceConfig,
  type FileLogger,
  type ServiceConfig,
} from '@winvm/core';
import { A2AServer, TaskStore } from '@winvm/a2a-framework';
import { McpServer, type McpTool } from '@winvm/mcp-framework';
import { WINDOWS_CAPABILITIES, PsBridgeSessionProbe, createWindowsRuntime } from '@winvm/vm-capabilities';
import { raceHealthSubProbes, resolveHealthProbeTimeoutMs, resolvePsBridgeHealthState } from './health-probe.js';

export interface PendingApproval {
  readonly approvalId: string;
  readonly capabilityId: CapabilityId;
  readonly risk: RiskLevel;
  readonly params: Record<string, unknown>;
  readonly preview: Record<string, unknown>;
  readonly createdAtMs: number;
  /**
   * K4 安全点：**宿主是否已批准**。token 注册时恒为 false；宿主经 A2A `approval.reply`
   * 批准（resolveApproval(true)）后由审批协调器置 true。`/mcp` 能力层仅当本字段为 true 时才放行
   * 续跑（杜绝「不记名令牌」漏洞：谁拿到 token 谁就能续跑）。
   */
  hostApproved: boolean;
}

export interface ServiceRuntime {
  readonly server: Server;
  readonly registry: CapabilityRegistry;
  readonly provider: AgentServiceProvider | undefined;
  readonly health: () => Promise<HealthStatus>;
  readonly close: () => Promise<void>;
  readonly config: ServiceConfig;
  readonly port: number;
  readonly exposedCapabilities: readonly CapabilityDefinition[];
}

/**
 * K4 VM 侧审批协调器：桥接层（bridge）命中宿主审批拦截时，把 A2A 任务挂起为 input-required，
 * 并把对应续跑令牌（pendingApprovals 中的 token）标记为「待宿主批准」。
 *
 * 安全点：token 在 `/mcp` 能力层注册时 `hostApproved=false`；宿主经 A2A `approval.reply`
 * 批准（resolveApproval(true)）后，本协调器才把 token 置 `hostApproved=true` —— 在此之前
 * 能力层绝不放行，杜绝「不记名令牌」续跑漏洞（K3 要堵的安全点）。
 */
export class VmApprovalCoordinator implements ApprovalCoordinator {
  private activeTaskId: string | undefined;
  private tasks: TaskStore | undefined;
  private pendingApprovals: Map<string, PendingApproval> | undefined;

  /** 注入 A2A 任务存储与 MCP 续跑令牌表（createService 内二者就绪后调用一次） */
  bind(tasks: TaskStore, pendingApprovals: Map<string, PendingApproval>): void {
    this.tasks = tasks;
    this.pendingApprovals = pendingApprovals;
  }

  beginTask(taskId: string): void {
    this.activeTaskId = taskId;
  }

  endTask(): void {
    this.activeTaskId = undefined;
  }

  raise(req: ApprovalRequest): Promise<boolean> {
    if (!this.activeTaskId || !this.tasks) return Promise.resolve(false);
    const done = this.tasks.waitApproval(this.activeTaskId, req);
    // 宿主批准（resolveApproval(true)）后，才把续跑令牌置为「已批准」，能力层方可放行。
    done.then((approved) => {
      if (approved && this.pendingApprovals) {
        const p = this.pendingApprovals.get(req.approvalId);
        if (p) p.hostApproved = true;
      }
    });
    return done;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

async function readBody(req: IncomingMessage, maxBytes = 8 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/* ================================ 构建运行时 ================================ */

export async function createService(config: ServiceConfig): Promise<ServiceRuntime> {
  const issues = validateServiceConfig(config);
  if (issues.errors.length > 0) {
    throw new Error(`配置校验失败：\n${issues.errors.map((e) => `  - ${e}`).join('\n')}`);
  }
  for (const w of issues.warnings) console.warn(`[winvm][warn] ${w}`);

  const cfg = resolveServiceConfig(config);
  // CL-018 C3：控制台 + 文件双写。目录不可写时 FileLogger 内部**自行降级**（绝不抛错），
  // 服务照常启动；降级事实经 `/health.logging.degraded` 暴露（AC3.5 硬要求）。
  const logger: FileLogger = createFileLogger(cfg.logging, { base: { service: 'winvm' } });

  /* ---- 能力注册表 ---- */
  const registry = new CapabilityRegistry();
  registry.registerAll(WINDOWS_CAPABILITIES);
  const regCheck = registry.validate();
  if (!regCheck.ok) {
    throw new Error(`能力注册表校验失败：\n${regCheck.issues.map((i) => `  - ${i}`).join('\n')}`);
  }

  /* ---- 能力定义索引（供 provider 查实现绑定） ---- */
  const capabilityDefs = new Map<CapabilityId, CapabilityDefinition>();
  for (const d of registry.listDefinitions()) capabilityDefs.set(d.id, d);

  /* ---- 能力运行时（ps-bridge + 会话探针） ---- */
  const runtime = createWindowsRuntime();
  const sessionMonitor = new SessionMonitor({
    probe: runtime.sessionProbe,
    intervalMs: cfg.session.probeIntervalMs,
    onChange: (next, prev) => {
      if (next.state !== prev?.state) {
        const level = next.state === 'healthy' ? 'info' : 'warn';
        logger[level]('会话状态变化', { from: prev?.state ?? '(初始)', to: next.state, detail: next.detail ?? '' });
      }
    },
  });

  /* ---- 审计与策略 ---- */
  // D30：freshChainOnStart —— 服务启动即起新分片并以全新 genesis 起链（链基线随启动重置）。
  // 历史分片已含断链（seq=511/582 重复 seq），若续接旧链，修复部署后 chainValid 将对历史数据
  // 永远报 false；改为「新链只写新分片、历史分片仅归档」，部署后 /health 立即回 true，
  // 历史断裂仍可通过审计归档（a2a / query）追溯。
  const audit = new HashChainAuditSink({
    dir: cfg.audit.dir,
    freshChainOnStart: true,
    ...(cfg.audit.maxFileBytes !== undefined ? { maxFileBytes: cfg.audit.maxFileBytes } : {}),
    ...(cfg.audit.redactParams !== undefined ? { redactParams: cfg.audit.redactParams } : {}),
  });
  const policy = new CorePolicyEngine({ registry, config: cfg.policy });

  /* ---- 桥接上下文 ---- */
  // K4：审批协调器（须先于 bridgeCtx 创建，以便注入 provider；tasks / pendingApprovals 在其
  // 就绪后通过 bind() 注入，见下方 A2A 构建之后）。
  const approvalCoordinator = new VmApprovalCoordinator();

  const bridgeCtx = {
    config: cfg as unknown as Record<string, unknown>,
    audit,
    policy,
    capabilities: registry,
    logger,
    newTraceId,
    approvalCoordinator,
    // D1（单例）：把服务创建的唯一 ps-bridge 注入 provider，
    // 使其复用同一进程，而不是自建第二个实例（否则 ps-bridge.ps1 进程翻倍、健康态自相矛盾）。
    bridge: runtime.bridge,
    // 扩展注入（provider 通过这两个字段查实现绑定与会话状态）
    capabilityDefs,
    sessionProbe: runtime.sessionProbe,
    // D5：meta.health.check 由 provider 回调此函数，返回与 GET /health 同构的健康快照。
    healthSnapshot: (): Promise<Record<string, unknown>> =>
      buildHealth() as unknown as Promise<Record<string, unknown>>,
    // CL-020 F2：system.network.config 采集时间戳经此回调上抛写入 netCfgCache（单一数据源）。
    // provider.execute 内部成功采集后调用；MCP 与 A2A 两条路径共用同一 execute → 全覆盖。
    // 采「cast 模式」注入（与既有 healthSnapshot / sessionProbe / capabilityDefs 约定一致）：
    // 不扩 BridgeContext 契约接口，provider 侧用 `as unknown as {...}` 强转读取。
    reportNetCfg: (collectedAt: string): void => {
      netCfgCache.collectedAt = collectedAt;
      netCfgCache.ok = true;
    },
  } as unknown as BridgeContext;

  /* ---- 加载 provider（失败 → degraded，仅 meta.*） ---- */
  let provider: AgentServiceProvider | undefined;
  let providerError: string | undefined;
  try {
    await runtime.bridge.start().catch(() => undefined);
    provider = await loadProvider(cfg.agent, bridgeCtx);
    sessionMonitor.start();
    logger.info('provider 已就绪', { provider: provider.id, kind: provider.kind });
  } catch (e) {
    providerError = (e as Error).message;
    logger.error('provider 加载失败，服务进入 degraded（仅 meta.* 可用）', { error: providerError });
  }

  /* ---- 实际暴露能力集 = provider 声明 ∩ 平台已注册 ---- */
  const exposedCapabilities: readonly CapabilityDefinition[] = provider
    ? registry.intersectDeclared(provider.declareCapabilities())
    : registry.intersectDeclared(['meta.*']);

  const exposedIds = new Set(exposedCapabilities.map((c) => c.id));
  logger.info('能力暴露面已确定', { count: exposedCapabilities.length, degraded: provider === undefined });

  /* ---- K2 修复：A2A 冷启动停滞 —— 服务启动后异步预热 LLM 常驻会话 ----
   *
   * 问题：常驻 codebuddy 会话是 lazy 单例，仅首个委派（或服务重启后 / idle TTL 回收后的首调）
   * 才 spawn 并付全额进程级冷启动（auth probe + agent 端点 ≈75–107s）。此时若宿主 A2A 委派以
   * 有界超时（A5 默认 60s）等待，会返回「冷启动窗口」引导文案而非结果 —— 即 K2。
   *
   * 方案：provider 加载完成后，对 `kind='llm-agent'` 的 provider 以 `void provider.warmup?.()`
   * **fire-and-forget** 发起一条无害预热目标，让冷启动在**启动期**（用户不等待）完成；
   * 首个真实委派命中已就绪会话，仅需 ~21s 热态处理。
   *
   * 纪律（对齐 CL-018 C5 netCfg 预热）：不阻塞启动（`warmup` 内部自行捕获异常，失败只记日志），
   * 绝不阻断服务或抛到启动链路。确定性 / remote-proxy 等其他 provider 不实现 `warmup`，自然跳过。
   */
  if (provider && provider.kind === 'llm-agent') {
    void provider.warmup?.();
  }

  /* ---- CL-018 C5：网络配置进程内缓存（启动异步预热） ----
   *
   * 问题：`system.network.config`（Get-NetworkConfig）冷调用 5–8s（WMI/CIM 首次装载 + DNS 枚举），
   * 是宿主 `system.*` 调用的长尾。方案：PowerShell 侧进程内 TTL 缓存（45s，`WINVM_NETCFG_TTL_MS`），
   * 并在**服务启动后异步预热一次** —— 使「服务重启后的首次调用」也命中缓存（AC5）。
   *
   * 纪律：预热**不阻塞启动**（fire-and-forget）；失败只记日志、`cached` 保持 false，绝不阻断服务。
   * `/health.cache.netCfg` 据此暴露 `cached / ageMs / ttlMs`。
   *
   * CL-019 项①：`ageMs` 语义修正为**真实缓存新鲜度**（= `now - Date.parse(collectedAt)`），
   * 对齐 `@winvm/contracts` 的 `CacheHealth.netCfg.ageMs` 既有契约（"缓存年龄（毫秒；无缓存为 -1）"）。
   * 为此本地态额外捕获 PowerShell 回传的 `collectedAt`（预热 + 每次正常 `system.network.config` 调用）。
   */
  const netCfgCache: { warmedAtMs: number; ok: boolean; error?: string; collectedAt?: string } = {
    warmedAtMs: 0,
    ok: false,
  };
  const netCfgTtlMs = resolveNetCfgTtlMs();
  void (async (): Promise<void> => {
    try {
      // CL-018 C5 修复：预热超时**不可复用**日常调用的 20s 上限。
      // 预热发生在服务刚启动、WMI/CIM 尚未装载的极端冷态，此时 Get-NetworkConfig 真实耗时 >20s，
      // 若与日常调用同用 20s 会必然超时失败（实证 4/6 次，11:08 后 100%），缓存填不上、首调退回真冷 ~3.3s。
      // 预热是 fire-and-forget、用户不等待，故给予宽松上限（env WINVM_NETCFG_PREWARM_TIMEOUT_MS 可覆盖，默认 60s）。
      const prewarmTimeoutMs = resolveNetCfgPrewarmTimeoutMs();
      const prewarmRes = await runtime.bridge.call('system', 'Get-NetworkConfig', {}, prewarmTimeoutMs);
      netCfgCache.warmedAtMs = Date.now();
      netCfgCache.ok = true;
      // CL-019 项①：捕获 PS 回传的采集时间戳，供 /health 计算真实缓存新鲜度。
      // ps-bridge 以 `ConvertTo-Json` 原样序列化 PowerShell ordered hashtable，键名保持 camelCase `collectedAt`（未做 PascalCase 转换）。
      const prewarmCollectedAt = (prewarmRes as { collectedAt?: unknown } | undefined)?.collectedAt;
      if (typeof prewarmCollectedAt === 'string') netCfgCache.collectedAt = prewarmCollectedAt;
      logger.info('网络配置缓存预热完成', { ttlMs: netCfgTtlMs, prewarmTimeoutMs });
    } catch (e) {
      netCfgCache.error = (e as Error).message;
      logger.warn('网络配置缓存预热失败（不影响服务可用，首次调用将自行采集）', {
        error: netCfgCache.error,
      });
    }
  })();

  /* ---- 审批闸登记（MCP 侧） ---- */
  const pendingApprovals = new Map<string, PendingApproval>();

  /**
   * P3-3：A2A 审批等待（`input-required` 挂起）加 TTL 护栏（默认 30 分钟，env
   * `WINVM_APPROVAL_TTL_MS` 可覆盖）。宿主永不应答时由 TaskStore 按「拒绝」收口：
   * 挂起 Promise resolve(false) → 桥保持 K3 旧行为（ok=false，绝不自批）→ 任务转 `failed`
   * （原因 approval timeout）。令牌清理由本侧负责（TaskStore 不知道 pendingApprovals）：
   * 超时回调里删掉残留 token，使 `/mcp` 续跑闸（`hostApproved === true`）永无放行可能。
   */
  const taskStore = new TaskStore({
    onApprovalTimeout: ({ taskId, approvalId, timedOutAfterMs, ttlMs }) => {
      const removed = pendingApprovals.delete(approvalId);
      logger.warn('审批等待超时，任务按拒绝收口', {
        taskId,
        approvalId,
        timedOutAfterMs,
        ttlMs,
        tokenRemoved: removed,
      });
    },
  });

  /* ================================ MCP ================================ */

  const mcpTools: McpTool[] = exposedCapabilities.map((cap) => ({
    name: cap.id,
    title: cap.name,
    description: `${cap.description}｜风险等级 ${cap.risk}${cap.requiresSession ? '｜需交互式会话' : ''}`,
    inputSchema: {
      ...cap.input,
      // 审批续跑字段：宿主确认后带上 approvalId 重发同一请求
      properties: {
        ...((cap.input['properties'] as Record<string, unknown>) ?? {}),
        __approvalId: { type: 'string', description: '审批通过后用于续跑执行' },
      },
    },
    annotations: {
      readOnlyHint: cap.risk === 'L0',
      destructiveHint: cap.destructive,
      idempotentHint: cap.idempotent,
      openWorldHint: false,
    },
    handler: async (params, ctx) => {
      const { __approvalId, ...rest } = params;
      const approvalId = typeof __approvalId === 'string' ? __approvalId : undefined;
      // K4 安全点：token 必须已被宿主批准（hostApproved===true）才放行续跑。
      // 注册时 hostApproved=false，宿主经 A2A approval.reply 批准后由协调器置 true。
      const approved = approvalId !== undefined && pendingApprovals.get(approvalId)?.hostApproved === true;

      const verdict = policy.evaluate({
        capabilityId: cap.id,
        params: rest,
        risk: cap.risk,
        approved,
        ...(approvalId ? { approvalId } : {}),
        ...(cap.policy ? { capabilityPolicy: cap.policy } : {}),
      });

      if (!verdict.allowed) {
        if (verdict.requiresApproval) {
          const id = newId('apr');
          pendingApprovals.set(id, {
            approvalId: id,
            capabilityId: cap.id,
            risk: cap.risk,
            params: rest,
            preview: buildPreview(cap, rest),
            createdAtMs: Date.now(),
            // K4：注册时恒为「待宿主批准」，杜绝未批准即放行。
            hostApproved: false,
          });
          return {
            isError: false,
            structuredContent: {
              traceId: ctx.traceId,
              ok: false,
              error: { code: 'APPROVAL_REQUIRED', message: verdict.error?.message ?? '需审批' },
              approval: {
                approvalId: id,
                risk: cap.risk,
                capabilityId: cap.id,
                preview: buildPreview(cap, rest),
                impact: collectImpact(rest),
                resumeHint: '确认后以 __approvalId 重发同一请求',
              },
            },
          };
        }
        return {
          isError: true,
          structuredContent: {
            traceId: ctx.traceId,
            ok: false,
            error: verdict.error ?? { code: 'POLICY_DENIED', message: '被策略拒绝' },
            risk: cap.risk,
          },
        };
      }

      if (approvalId) pendingApprovals.delete(approvalId);

      if (!provider) {
        return {
          isError: true,
          structuredContent: {
            traceId: ctx.traceId,
            ok: false,
            error: { code: 'PROVIDER_UNAVAILABLE', message: providerError ?? 'provider 未就绪' },
          },
        };
      }

      const res = await provider.execute({
        traceId: ctx.traceId,
        capabilityId: cap.id,
        params: rest,
        risk: cap.risk,
        approved: true,
        ...(approvalId ? { approvalId } : {}),
        timeoutMs: cap.timeoutMs,
      });

      // CL-020 F2：采集时间戳的捕获已从 handler 层移走（避免双写、单一数据源）。
      // 现由 provider.execute 内部的 reportNetCfg 注入回调统一上抛写入 netCfgCache，
      // MCP 与 A2A 两条路径共用同一 execute，全覆盖。此处不再重复捕获。

      return {
        isError: !res.ok,
        structuredContent: {
          traceId: res.traceId,
          ok: res.ok,
          risk: cap.risk,
          data: res.data,
          ...(res.artifacts && res.artifacts.length > 0
            ? { artifacts: res.artifacts.map((a) => ({ kind: a.kind, name: a.name, mime: a.mime })) }
            : {}),
          durationMs: res.durationMs,
          ...(res.auditRef ? { auditRef: res.auditRef } : {}),
          ...(res.error ? { error: res.error } : {}),
        },
      };
    },
  }));

  const mcp = new McpServer({
    name: 'winvm-bridge',
    version: '0.1.0',
    tools: mcpTools,
    logger,
      instructions:
      'WinVM Bridge：通过 MCP 工具操作 Windows 虚拟机（系统/应用/存储/GUI/应用生产）。' +
      '工具名即能力 ID（如 system.service.control、appops.workflow.run）。风险等级 L2/L3 需先取 approvalId 再续跑。',
  });

  /* ================================ A2A ================================ */

  const a2a = new A2AServer({
    agentCard: {
      name: 'WinVM Bridge Agent',
      description:
        '在 Windows 虚拟机内执行系统管理、应用管理、存储管理、GUI 自动化与应用生产操作任务，' +
        '并回传截图、产物与变更清单',
      version: '0.1.0',
      url: cfg.server.publicBaseUrl ?? `http://${cfg.server.host}:${cfg.server.port}/a2a`,
      provider: { organization: 'WinVM Bridge' },
      capabilities: { streaming: true, pushNotifications: false },
      defaultInputModes: ['text', 'data'],
      defaultOutputModes: ['text', 'data', 'image/png'],
      supportedInterfaces: [
        {
          url: cfg.server.publicBaseUrl ?? `http://${cfg.server.host}:${cfg.server.port}/a2a`,
          protocolBinding: 'JSONRPC',
          protocolVersion: A2A.A2A_PROTOCOL_VERSION,
        },
      ],
      skills: [
        {
          id: 'system-admin',
          name: 'Windows 系统管理',
          description: '服务、进程、计划任务、注册表、网络、用户、环境变量、事件日志',
          tags: ['system', 'windows'],
        },
        {
          id: 'app-manager',
          name: 'Windows 应用管理',
          description: 'winget 安装/卸载/升级、启动激活、快捷方式、UWP 包',
          tags: ['app', 'winget'],
        },
        {
          id: 'storage-manager',
          name: 'Windows 存储管理',
          description: '空间分析、文件目录操作、搜索、压缩、回收站、清理建议',
          tags: ['storage', 'disk'],
        },
        {
          id: 'gui-automation',
          name: 'GUI 与桌面自动化',
          description: '截图、键鼠模拟、窗口控制、UIA 元素操作、剪贴板、等待条件',
          tags: ['gui', 'automation'],
        },
        {
          id: 'app-operation',
          name: 'Windows 应用生产操作',
          description:
            '操作桌面软件进行生产活动：图像处理（Photoshop/ImageMagick）、Office/WPS 文档报表、' +
            '浏览器网页生产、ffmpeg/ImageMagick 音视频批处理、IDE 研发生产。含 CLI 调用、生产型工作流、COM 自动化、GUI 多步生产',
          tags: ['appops', 'production', 'creative'],
        },
      ],
    },
    handler: {
      async runGoal(goal: GoalRequest, sink: ProgressSink) {
        if (!provider) {
          return {
            ok: false,
            summary: `VM Agent 未就绪（degraded）：${providerError ?? 'provider 未加载'}`,
            artifacts: [] as Artifact[],
            steps: [],
            error: makeError('PROVIDER_UNAVAILABLE', providerError ?? 'provider 未加载'),
          };
        }
        return provider.runGoal(goal, sink);
      },
    },
    logger,
    defaultMaxRisk: cfg.policy.defaultMaxRisk ?? 'L1',
    taskStore,
  });

  /* ---- K4：把 A2A 任务存储与 MCP 续跑令牌表注入审批协调器（二者此刻已就绪） ---- */
  approvalCoordinator.bind(a2a.tasks, pendingApprovals);

  /* ================================ HTTP ================================ */

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const path = url.pathname;

      // 仅允许 POST/GET
      if (req.method !== 'POST' && req.method !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }

      try {
        if (path === '/health' && req.method === 'GET') {
          sendJson(res, 200, await buildHealth());
          return;
        }

        if (path === '/.well-known/agent-card.json' && req.method === 'GET') {
          sendJson(res, 200, a2a.getAgentCard());
          return;
        }

        if (path === '/mcp' && req.method === 'POST') {
          const body = await readBody(req);
          const parsed = body ? JSON.parse(body) : null;
          const result = await mcp.handleRequest(parsed);
          if (result === null) {
            res.writeHead(202).end();
            return;
          }
          sendJson(res, 200, result);
          return;
        }

        if (path === '/a2a' && req.method === 'POST') {
          const body = await readBody(req);
          const parsed = body ? JSON.parse(body) : null;

          // 版本协商（A2A v1.0）
          const version = req.headers[A2A.A2A_VERSION_HEADER.toLowerCase()];
          if (version && version !== A2A.A2A_PROTOCOL_VERSION) {
            sendJson(res, 400, {
              jsonrpc: '2.0',
              id: isRecord(parsed) ? (parsed['id'] ?? null) : null,
              error: {
                code: A2A.JSON_RPC_ERRORS.INVALID_REQUEST,
                message: `不支持的 A2A 版本：${version}`,
                data: { code: A2A.A2A_ERROR_CODES.VERSION_NOT_SUPPORTED },
              },
            });
            return;
          }

          const method = isRecord(parsed) ? parsed['method'] : undefined;
          const params = isRecord(parsed) && isRecord(parsed['params']) ? parsed['params'] : {};

          // 流式方法走 SSE
          if (method === 'message/stream') {
            await writeSse(res, a2a.handleStream(params));
            return;
          }
          if (method === 'tasks/subscribe') {
            await writeSse(res, a2a.subscribeStream(params));
            return;
          }

          const result = await a2a.handleRequest(parsed);
          sendJson(res, 200, result ?? {});
          return;
        }

        sendJson(res, 404, { error: 'not found', path });
      } catch (e) {
        logger.error('请求处理异常', { path, error: String(e) });
        sendJson(res, 500, { error: (e as Error).message ?? 'internal error' });
      }
    })();
  });

  /** SSE 输出 */
  async function writeSse(res: ServerResponse, iterable: AsyncIterable<unknown>): Promise<void> {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    try {
      for await (const ev of iterable) {
        res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', result: ev })}\n\n`);
      }
    } catch (e) {
      res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: String(e) } })}\n\n`);
    } finally {
      res.end();
    }
  }

  /**
   * 健康快照。
   *
   * QA 遗留 P2（第一段）：会话子探针（psBridge.call('gui','Get-SessionHealth')）在 ps-bridge
   * 未就绪时会先走 lazy 自愈（spawn powershell + ready 握手），单个 /health 请求实测阻塞 ~27s。
   * 现加独立短超时（默认 5000ms，env WINVM_HEALTH_PROBE_TIMEOUT_MS 可覆盖）：
   *  - 超时 /health 仍返回（ok 按既有公式计算，桥进程 ready 时依旧 ok:true）；
   *  - psBridge.state='degraded'（契约 ProviderState 内的可辨识降级值）+ 扩展字段
   *    psBridge.probe='timeout' 标明降级原因（D2 扩展模式：交叉类型承载，契约未改动）；
   *  - session.state='unavailable'（结论未知，契约 SessionState 无 'unknown'）；
   *  - GUI 门禁语义不变：guiAllowed 要求 state==='healthy'，超时回退态天然不可用，
   *    仅消除长阻塞、绝不放宽 GUI 能力判定。
   *
   * QA 遗留 P2（第二段）：provider.health()（workbuddy adapter：health → sessionHealth →
   * bridge.call('gui','Get-SessionHealth', {}, 20_000)）内部会**再**同步跑一次 20s 级会话探针，
   * 此前无超时包裹 —— 5s race 只护住了第一个探针，kill ps-bridge 后总时延仍 10.4–12.5s。
   * 现由 raceHealthSubProbes 把两路子探针**并发**纳入同一短超时护栏（顺序 await 会
   * 5s+5s 叠加突破 8s 预算）：provider.health() 超时 → 降级快照
   * provider.state='degraded' + detail 记录超时事实（ok 仍由桥进程状态独立计算，
   * 既有字段不缺失，/health JSON 契约不变）；provider 为 undefined（非 workbuddy）时
   * 保持既有「provider 未加载」行为。
   */
  async function buildHealth(): Promise<HealthStatus & { degradedReason?: string; exposed: number }> {
    const probeTimeoutMs = resolveHealthProbeTimeoutMs();
    const activeProvider = provider;
    const probes = await raceHealthSubProbes({
      sessionProbe: () => runtime.sessionProbe.probe(),
      providerHealth: activeProvider
        ? (): Promise<HealthStatus> => activeProvider.health()
        : undefined,
      providerId: activeProvider?.id ?? cfg.agent.provider,
      timeoutMs: probeTimeoutMs,
    });
    const session = probes.session;
    const bridgeHealth = runtime.bridge.health();
    const chain = await audit.verifyChain();
    const providerHealth = probes.providerHealth;

    // D2：psBridge 附带回传 restarts / lastError（纯增量，既有字段语义不变）。
    // P2：state 经 resolvePsBridgeHealthState 映射 —— 桥 down → 'unavailable'（不变）；
    // 桥 ready 但子探针超时 → 'degraded'，且附 probe:'timeout' 可辨识降级原因。
    const probeDegraded = probes.sessionTimedOut && bridgeHealth.state === 'ready';
    const psBridge: NonNullable<HealthStatus['psBridge']> & {
      restarts?: number;
      lastError?: string;
      /** P2 扩展：会话子探针在短超时内未应答（降级原因标识；按时应答时字段缺省） */
      probe?: 'timeout';
    } = {
      state: resolvePsBridgeHealthState(bridgeHealth.state === 'ready' ? 'ready' : 'down', probes.sessionTimedOut),
      uptimeMs: bridgeHealth.uptimeMs,
      pending: bridgeHealth.pending,
      restarts: bridgeHealth.restarts,
      ...(bridgeHealth.lastError ? { lastError: bridgeHealth.lastError } : {}),
      ...(probeDegraded ? { probe: 'timeout' as const } : {}),
    };

    // CL-018 C1：同步取常驻会话态（不 await provider.health()，避免被 5s 护栏吞掉）。
    // 非 LLM provider 未实现该成员 → undefined → 字段缺席（纯附加语义）。
    const llmSession = provider?.llmSessionHealth?.();

    // CL-018 C3：日志落盘态（degraded=true 亦为「服务已启动」的有效状态）。
    const logStatus = logger.logging();
    const logging: LoggingHealth = {
      degraded: logStatus.degraded,
      dir: logStatus.dir,
      level: cfg.logging.level,
      ...(logStatus.reason ? { reason: logStatus.reason } : {}),
    };

    // CL-018 C5：进程内缓存态。
    // CL-019 项①：`ageMs` 为「自最近一次采集（collectedAt）起算的真实缓存新鲜度（毫秒）」——
    //   有合法 collectedAt → 真实新鲜度（now - Date.parse(collectedAt)）；
    //   collectedAt 非法（非空但 Date.parse→NaN）或缺失 → 回落到既有语义（ok ? 0 : -1）。
    // CL-019 项①（F1 硬化）：加有限性兜底 —— 杜绝 `Date.parse` 得到 NaN 时 ageMs 变 NaN
    //   （JSON 会序列化为 `null`，违反 `bridge.ts` 的 `ageMs: number` 契约）。现实不可达（PS 恒回合法 ISO），
    //   但契约须严格成立，故 ageMs 恒为有限 number。
    const parsedAt = netCfgCache.collectedAt ? Date.parse(netCfgCache.collectedAt) : Number.NaN;
    const cache: CacheHealth = {
      netCfg: {
        cached: netCfgCache.ok,
        ageMs: Number.isFinite(parsedAt)
          ? Math.max(0, Date.now() - parsedAt)
          : netCfgCache.ok
            ? 0
            : -1,
        ttlMs: netCfgTtlMs,
      },
    };

    return {
      ok: provider !== undefined && bridgeHealth.state === 'ready',
      provider: providerHealth?.provider ?? {
        id: cfg.agent.provider,
        state: 'unavailable' as const,
        detail: providerError ?? 'provider 未加载',
      },
      session,
      psBridge,
      capabilities: { count: registry.size(), available: exposedIds.size },
      // D30：透出断裂定位与原因（向后兼容：entries / chainValid 字段保留）
      audit: {
        entries: chain.entries,
        chainValid: chain.valid,
        ...(chain.brokenAt !== undefined ? { brokenAt: chain.brokenAt } : {}),
        ...(chain.reason ? { reason: chain.reason } : {}),
      },
      // CL-018 C1：常驻会话态（纯附加）。取自 provider 的**同步** SPI 成员，
      // 而不是 providerHealth —— 后者可能被短超时守卫替换为不含 llmSession 的降级快照。
      ...(llmSession !== undefined ? { llmSession } : {}),
      // CL-018 C3：日志落盘态（纯附加；degraded=true 表示目录不可写但服务仍在跑）
      logging,
      // CL-018 C5：进程内缓存态（纯附加）
      cache,
      ...(providerError ? { degradedReason: providerError } : {}),
      exposed: exposedIds.size,
    };
  }

  /* ================================ 生命周期 ================================ */

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.server.port, cfg.server.host, () => resolve());
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : cfg.server.port;

  logger.info('WinVM Bridge 服务已启动', {
    host: cfg.server.host,
    port,
    exposed: exposedCapabilities.length,
    degraded: provider === undefined,
  });

  return {
    server,
    registry,
    provider,
    health: buildHealth,
    config: cfg,
    port,
    exposedCapabilities,
    async close() {
      sessionMonitor.stop();
      if (provider) await provider.shutdown().catch(() => undefined);
      await runtime.bridge.stop().catch(() => undefined);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      logger.info('WinVM Bridge 服务已停止');
      // CL-018 C3：刷盘并停止轮转定时器（避免缓冲日志丢失 / 阻碍进程退出）
      logger.close();
    },
  };
}

/* ================================ 辅助 ================================ */

function buildPreview(cap: CapabilityDefinition, params: Record<string, unknown>): Record<string, unknown> {
  const supportsDryRun = hasDryRunParam(cap);
  return {
    capabilityId: cap.id,
    risk: cap.risk,
    destructive: cap.destructive,
    requiresSession: cap.requiresSession,
    params,
    // D11：对支持 dryRun 的能力附带 dry-run 计划摘要，
    // 使 Skill 规定的「L3 先 dry-run 再确认」在审批预览里就可看到将要发生什么。
    ...(supportsDryRun
      ? {
          dryRun: {
            supported: true,
            requested: params['dryRun'] === true,
            plan:
              params['dryRun'] === true
                ? `dryRun=true：仅返回 ${cap.id} 的执行计划，不改动系统状态（免审批）`
                : `可传 dryRun:true 免审批预览 ${cap.id} 的影响后再决定是否真实执行`,
            hint: 'params.dryRun === true 时免审批直接放行（dry-run 不改变系统状态）',
          },
        }
      : {}),
    note:
      cap.risk === 'L3'
        ? 'L3 高危操作：将造成不可恢复的影响，请逐项确认 impact 清单'
        : 'L2 破坏性操作：将改变系统状态，请确认影响范围',
  };
}

/** 能力输入 schema 是否声明了 dryRun 参数（用于 D11 的 dry-run 免审批预览） */
function hasDryRunParam(cap: CapabilityDefinition): boolean {
  const props = cap.input['properties'];
  return (
    typeof props === 'object' &&
    props !== null &&
    Object.prototype.hasOwnProperty.call(props as Record<string, unknown>, 'dryRun')
  );
}

function collectImpact(params: Record<string, unknown>): string[] {
  const out: string[] = [];
  const walk = (v: unknown, key?: string): void => {
    if (typeof v === 'string') {
      if (/^[a-z]:[\\/]/i.test(v) || v.startsWith('\\\\') || /^HK[A-Z_]+/i.test(v)) out.push(`${key ?? ''}=${v}`);
    } else if (Array.isArray(v)) {
      v.forEach((x) => walk(x, key));
    } else if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) walk(val, k);
    }
  };
  walk(params);
  // D11：若未采集到路径类影响项（如 system.power.control 只有 action/delaySeconds），
  // 退化为列出所有标量参数，避免审批预览 impact 恒为空、宿主无从判断。
  if (out.length === 0) {
    for (const [k, v] of Object.entries(params)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        out.push(`${k}=${String(v)}`);
      }
    }
  }
  return out;
}

export { riskAtLeast };

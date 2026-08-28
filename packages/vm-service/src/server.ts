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
  type Artifact,
  type BridgeContext,
  type CapabilityDefinition,
  type CapabilityId,
  type GoalRequest,
  type HealthStatus,
  type ProgressSink,
  type RiskLevel,
  makeError,
  riskAtLeast,
} from '@winvm/contracts';
import {
  CapabilityRegistry,
  ConsoleLogger,
  CorePolicyEngine,
  HashChainAuditSink,
  SessionMonitor,
  loadProvider,
  newId,
  newTraceId,
  resolveServiceConfig,
  validateServiceConfig,
  type ServiceConfig,
} from '@winvm/core';
import { A2AServer } from '@winvm/a2a-framework';
import { McpServer, type McpTool } from '@winvm/mcp-framework';
import { WINDOWS_CAPABILITIES, PsBridgeSessionProbe, createWindowsRuntime } from '@winvm/vm-capabilities';

export interface PendingApproval {
  readonly approvalId: string;
  readonly capabilityId: CapabilityId;
  readonly risk: RiskLevel;
  readonly params: Record<string, unknown>;
  readonly preview: Record<string, unknown>;
  readonly createdAtMs: number;
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
  const logger = new ConsoleLogger({ level: 'info', base: { service: 'winvm' } });

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
  const audit = new HashChainAuditSink({
    dir: cfg.audit.dir,
    ...(cfg.audit.maxFileBytes !== undefined ? { maxFileBytes: cfg.audit.maxFileBytes } : {}),
    ...(cfg.audit.redactParams !== undefined ? { redactParams: cfg.audit.redactParams } : {}),
  });
  const policy = new CorePolicyEngine({ registry, config: cfg.policy });

  /* ---- 桥接上下文 ---- */
  const bridgeCtx = {
    config: cfg as unknown as Record<string, unknown>,
    audit,
    policy,
    capabilities: registry,
    logger,
    newTraceId,
    // 扩展注入（provider 通过这两个字段查实现绑定与会话状态）
    capabilityDefs,
    sessionProbe: runtime.sessionProbe,
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

  /* ---- 审批闸登记（MCP 侧） ---- */
  const pendingApprovals = new Map<string, PendingApproval>();

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
      const approved = approvalId !== undefined && pendingApprovals.has(approvalId);

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
  });

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

  /** 健康快照 */
  async function buildHealth(): Promise<HealthStatus & { degradedReason?: string; exposed: number }> {
    const session = await runtime.sessionProbe.probe();
    const bridgeHealth = runtime.bridge.health();
    const chain = await audit.verifyChain();
    const providerHealth = provider ? await provider.health() : undefined;

    return {
      ok: provider !== undefined && bridgeHealth.state === 'ready',
      provider: providerHealth?.provider ?? {
        id: cfg.agent.provider,
        state: 'unavailable' as const,
        detail: providerError ?? 'provider 未加载',
      },
      session,
      psBridge: {
        state: bridgeHealth.state === 'ready' ? ('ready' as const) : ('unavailable' as const),
        uptimeMs: bridgeHealth.uptimeMs,
        pending: bridgeHealth.pending,
      },
      capabilities: { count: registry.size(), available: exposedIds.size },
      audit: { entries: chain.entries, chainValid: chain.valid },
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
    },
  };
}

/* ================================ 辅助 ================================ */

function buildPreview(cap: CapabilityDefinition, params: Record<string, unknown>): Record<string, unknown> {
  return {
    capabilityId: cap.id,
    risk: cap.risk,
    destructive: cap.destructive,
    requiresSession: cap.requiresSession,
    params,
    note:
      cap.risk === 'L3'
        ? 'L3 高危操作：将造成不可恢复的影响，请逐项确认 impact 清单'
        : 'L2 破坏性操作：将改变系统状态，请确认影响范围',
  };
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
  return out;
}

export { riskAtLeast };

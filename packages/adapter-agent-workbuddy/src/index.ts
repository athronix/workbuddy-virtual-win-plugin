/**
 * @winvm/adapter-agent-workbuddy —— VM 内 Agent 适配器 V1（L2）
 *
 * 实现 AgentServiceProvider SPI 的**确定性执行器**：
 *   - 不依赖 LLM：行为可预测、省资源、易审计（NFR-502 / 评估建议 §5 资源占用）
 *   - 替换成本极低：新增一个 provider 实现 + 改配置 agent.provider 即可换成 LLM Agent
 *     core / mcp-framework / a2a-framework / skills **全部零改动**
 */

import {
  type AgentServiceProvider,
  type Artifact,
  type BridgeContext,
  type CapabilityRequest,
  type CapabilityResult,
  type GoalRequest,
  type GoalResult,
  type GoalStep,
  type HealthStatus,
  type ProgressSink,
  makeError,
  riskAtLeast,
} from '@winvm/contracts';
import { newId, newTraceId } from '@winvm/core';
import { PsBridge, type PsBridgeOptions } from '@winvm/vm-capabilities';

export const PROVIDER_ID = 'workbuddy-deterministic';

/**
 * 契约层「封闭 10 码」（= `@winvm/contracts` 的 `BridgeErrorCode`）。
 * 这 10 码决定**重试 / 审批**语义，是**对外契约**，不得因新增 PS 领域码而扩张。
 */
const BRIDGE_ERROR_CODES: readonly string[] = [
  'INVALID_PARAMS',
  'UNKNOWN_CAPABILITY',
  'UNSUPPORTED_GOAL',
  'POLICY_DENIED',
  'APPROVAL_REQUIRED',
  'SESSION_UNAVAILABLE',
  'SESSION_BLACK_SCREEN',
  'PROVIDER_UNAVAILABLE',
  'TIMEOUT',
  'EXECUTION_FAILED',
];

/**
 * 领域码 → 契约层 base code 的**最小映射**（CL-017 D23）。
 *
 * 只有语义能明确归一到某契约码的领域码才在此表；其余一律 `EXECUTION_FAILED` + `reason`。
 * 这样新增 psmod 领域码**无需改契约**。
 */
const DOMAIN_CODE_TO_BASE: Readonly<Record<string, string>> = {
  INVALID_ARGUMENT: 'INVALID_PARAMS',
  INVALID_RECT: 'INVALID_PARAMS',
  INVALID_PARAMS: 'INVALID_PARAMS',
  TIMEOUT: 'TIMEOUT',
  POLICY_DENIED: 'POLICY_DENIED',
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
};

/**
 * 领域原因码形态：全大写字母/数字/下划线，以字母开头、总长 ≥3。
 * 用于把「PS 侧 `throw "UPPER_SNAKE: msg"`」与**任意英文异常消息**区分开，
 * 避免把普通字符串误当错误码透出。
 */
const DOMAIN_CODE_RE = /^[A-Z][A-Z0-9_]{2,}$/;

/**
 * 审批续跑字段名（D24）。
 *
 * MCP 侧宿主在确认审批后以 `__approvalId` 重发同一请求；服务 handler 会先 `{ __approvalId, ...rest }`
 * 剥离该字段，但为防御**未剥离的直连调用方**（A2A / 单测 / 未来通道），入参契约校验的「允许集」
 * 必须恒含它，否则会被误报为「未知参数」而破坏审批续跑。
 */
const APPROVAL_FIELD = '__approvalId';

/**
 * 数字形态字符串（整体匹配）：`'20'` / `' -3.5 '` 等。
 * 命中即认为可被 PowerShell 强转为 `[int]` / `[long]` / `[double]`。
 */
const NUMERIC_LIKE_RE = /^\s*[+-]?\d+(\.\d+)?\s*$/;

/**
 * CL-017 D26 裁决 B：`enum` 成员匹配 —— 先严格 `includes`，字符串再按**忽略大小写**比较。
 *
 * 依据：psmod 的枚举由 `[ValidateSet(...)]` 实现，而 **PowerShell 的 ValidateSet 默认忽略大小写**
 * （`[ValidateSet('start','stop','restart')][string]$Action` 会接受 `'START'`）。
 * 本校验的目标是「**预判 PS 绑定会不会失败**」，故必须与 PS 同宽 —— 否则会把 PS 本可接受的
 * 调用误拒（**我们自己引入的新失败模式，比漏放更糟**）。
 * `'bogus'` 之类**真正的越界值仍被拒绝**（大小写折叠后仍不在集合内）。
 *
 * @param enumValues 注册表 schema 的 `enum` 取值
 * @param value 调用方实参
 * @returns 该实参是否命中枚举集合（含大小写不敏感命中）
 */
function enumIncludesValue(enumValues: readonly unknown[], value: unknown): boolean {
  if (enumValues.includes(value)) return true;
  if (typeof value !== 'string') return false;
  const lower = value.toLowerCase();
  return enumValues.some((v) => typeof v === 'string' && v.toLowerCase() === lower);
}

/**
 * CL-017 D26：单值的「PS 可强转性」判定。
 *
 * 之所以按 **PS 可强转性** 而非 JS 严格类型判定，是因为参数最终由 PowerShell 参数绑定消费：
 * PS 会把 `'20'` 绑定到 `[int]`、`'true'` 绑定到 `[bool]`、数字绑定到 `[string]`、
 * **标量提升为 `[string[]]`**；而 LLM 常以字符串形式发数字。若按 JS 严格类型判，
 * 会把**合法调用误拒**，比「漏报」危害更大 —— 故本判定遵循「宁可漏报，不可误报」原则。
 *
 * 各 `type` 关键字的可接受实参：
 *   - `integer` / `number`：JS 数字，或整体为数字形态的字符串（{@link NUMERIC_LIKE_RE}）；
 *   - `boolean`：JS 布尔，或 `'true'` / `'false'`（忽略大小写与首尾空白）；
 *   - `string`：字符串 / 数字 / 布尔（PS 均可 `[string]` 强转）；
 *   - `array`：数组，**或 string / number / boolean 标量**（PS 形参如 `[string[]]` 会做标量提升）；
 *   - `object`：非 `null` 且非数组的对象；
 *   - 其它未知关键字：放行（前向兼容注册表可能引入的新关键字）。
 *
 * @param type JSON Schema `type` 关键字（单值）
 * @param value 调用方实参
 * @returns 该实参能否被 PS 参数绑定接受
 */
function isCoercibleTo(type: string, value: unknown): boolean {
  switch (type) {
    case 'integer':
    case 'number':
      return typeof value === 'number' || (typeof value === 'string' && NUMERIC_LIKE_RE.test(value));
    case 'boolean':
      if (typeof value === 'boolean') return true;
      if (typeof value === 'string') {
        const s = value.trim().toLowerCase();
        return s === 'true' || s === 'false';
      }
      return false;
    case 'string':
      return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
    case 'array':
      // 裁决 B：PS 数组形参（如 `[string[]]$Keys`）会把**标量**自动提升为单元素数组，
      // 故 string / number / boolean 标量视为可强转；object 等复合值仍拒绝。
      // 注：不校验 `items`（避免过度约束）。
      return (
        Array.isArray(value) ||
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
      );
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    default:
      return true;
  }
}

/**
 * CL-017 D26：实参「形态」描述，用于 `details.invalid[].got`。
 *
 * 只报**类型类别**（`string` / `number` / `array` …），**不回显原值** ——
 * 避免把文件内容、口令等敏感实参写入错误回包与审计日志。
 */
function describeArg(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

export interface DeterministicProviderOptions {
  readonly maxConcurrency?: number;
  /** 预留：接入 LLM 规划后开启（V1 默认 false） */
  readonly enableLlmPlanning?: boolean;
  readonly psBridge?: PsBridgeOptions;
}

export class DeterministicAgentProvider implements AgentServiceProvider {
  readonly id = PROVIDER_ID;
  readonly displayName = 'WinVM 确定性执行器（V1）';
  readonly kind = 'deterministic' as const;

  private ctx: BridgeContext | undefined;
  private bridge: PsBridge | undefined;
  private readonly maxConcurrency: number;
  private readonly enableLlmPlanning: boolean;
  private readonly bridgeOptions: PsBridgeOptions;
  private active = 0;
  /**
   * 本 provider 是否「拥有」bridge 的生命周期（即 bridge 是它自建的）。
   * D1：当 bridge 由服务侧注入时，所有权归服务，provider 不得 stop 它（否则会误停单例）。
   */
  private ownsBridge = false;

  constructor(options: DeterministicProviderOptions = {}) {
    this.maxConcurrency = options.maxConcurrency ?? 4;
    this.enableLlmPlanning = options.enableLlmPlanning === true;
    this.bridgeOptions = options.psBridge ?? {};
  }

  declareCapabilities(): readonly string[] {
    // 声明本实现能承载的全部能力域；实际暴露面会与平台能力求交集
    return ['meta.*', 'system.*', 'app.*', 'storage.*', 'gui.*', 'appops.*'];
  }

  async init(ctx: BridgeContext): Promise<void> {
    this.ctx = ctx;
    // D1（单例）：服务侧已创建并 start 了 ps-bridge，并通过 ctx.bridge 注入。
    // 旧实现无论是否注入都 `new PsBridge(...)`，导致服务与 provider 各起一个 ps-bridge.ps1
    // （进程翻倍、双跑心跳看门狗，且 /health 读的是服务侧实例、能力执行走 provider 实例 → 健康态自相矛盾）。
    // 现优先复用注入实例；仅当未注入（非 Windows / 单测 / 未走服务）时才自建兜底。
    const injected = ctx.bridge as PsBridge | undefined;
    this.bridge = injected ?? new PsBridge(this.bridgeOptions);
    this.ownsBridge = injected === undefined;

    if (injected) {
      // 注入实例的生命周期由服务统一管理（已 start）；此处不得再次 spawn。
      ctx.logger.info('复用服务注入的 ps-bridge 单例', {
        provider: this.id,
        running: injected.running,
      });
      return;
    }

    try {
      await this.bridge.start();
      ctx.logger.info('ps-bridge 已启动', { provider: this.id, uptimeMs: this.bridge.uptimeMs });
    } catch (e) {
      // 启动失败不阻断 provider 初始化：服务将进入 degraded，仅暴露 meta.*
      ctx.logger.error('ps-bridge 启动失败，服务将降级', { error: (e as Error).message });
    }
  }

  private requireCtx(): BridgeContext {
    if (!this.ctx) throw new Error('provider 尚未 init');
    return this.ctx;
  }

  /* ------------------------------ execute ------------------------------ */

  async execute(req: CapabilityRequest): Promise<CapabilityResult> {
    const ctx = this.requireCtx();
    const started = Date.now();
    const cap = ctx.capabilities.get(req.capabilityId);

    if (!cap) {
      return this.fail(req, makeError('UNKNOWN_CAPABILITY', `能力未注册：${req.capabilityId}`), started, ctx);
    }

    // —— 策略引擎（拒绝优先）——
    const verdict = ctx.policy.evaluate({
      capabilityId: req.capabilityId,
      params: req.params,
      risk: cap.risk,
      approved: req.approved,
      ...(req.approvalId ? { approvalId: req.approvalId } : {}),
    });
    if (!verdict.allowed) {
      return this.fail(
        req,
        verdict.error ?? makeError('POLICY_DENIED', `被策略拒绝：${verdict.matchedRule}`),
        started,
        ctx,
      );
    }

    // —— D24：入参契约前置校验（Node 侧；不发起桥调用，错误可路由）——
    // 必须在「会话守卫 / 并发闸门 / bridge.call」**之前**：这是纯契约检查，与机器状态无关，
    // 且能保证「参数写错」永远不会被 SESSION_UNAVAILABLE 等环境态错误抢先掩盖。
    const paramError = this.validateParams(req.capabilityId, req.params);
    if (paramError) {
      ctx.logger.warn('入参契约校验未通过，未发起桥调用', {
        capabilityId: req.capabilityId,
        reason: paramError.reason,
        ...(paramError.details ? { details: paramError.details } : {}),
      });
      return this.fail(req, paramError, started, ctx);
    }

    // —— 会话守卫：GUI 能力在无交互式会话时必须明确报错，绝不静默黑屏 ——
    if (cap.requiresSession) {
      const session = await this.sessionHealth();
      if (session.state === 'unavailable' || session.state === 'black-screen') {
        return this.fail(
          req,
          makeError(
            session.state === 'black-screen' ? 'SESSION_BLACK_SCREEN' : 'SESSION_UNAVAILABLE',
            `GUI 能力需要交互式会话。当前：${session.state}。${session.detail ?? ''}`,
          ),
          started,
          ctx,
        );
      }
    }

    // —— 并发闸门 ——
    if (this.active >= this.maxConcurrency) {
      return this.fail(req, makeError('TIMEOUT', `并发已满（${this.maxConcurrency}），请稍后重试`), started, ctx, true);
    }

    const bridge = this.bridge;
    if (!bridge) {
      return this.fail(req, makeError('PROVIDER_UNAVAILABLE', 'ps-bridge 未就绪'), started, ctx);
    }

    this.active++;
    try {
      // 能力定义 → PowerShell 模块/函数（从注册表取实现绑定）
      const impl = this.implementationOf(req.capabilityId);

      // D5：meta.health.check 由 Node 侧**内置**返回与 GET /health 同构的快照
      //     （原绑定 system.Get-SystemInfo 返回的是系统信息而非健康态，语义不符）。
      // 其余 __meta.* 仍走 ps-bridge（保持既有语义）。
      const raw =
        impl.module === '__meta' && impl.fn === 'healthCheck'
          ? await this.buildHealthSnapshot()
          : await bridge.call(impl.module, impl.fn, req.params, req.timeoutMs || 30_000);

      // D10：列表类能力强制保形为数组（空 → []，单元素 → [{...}]）。
      // 注意：bridge.call 的 lazy 自愈（D2）在此处生效 —— 进程死亡时会先自愈再执行。
      const data = this.normalizeListOutput(req.capabilityId, raw);

      const durationMs = Date.now() - started;
      const artifacts = this.extractArtifacts(req.capabilityId, data);

      // CL-020 F2：采集时间戳经注入的 reportNetCfg 上抛（覆盖 MCP + A2A 两条路径）。
      // data 此处为 system.network.config 顶层 obj（normalizeListOutput 对 object 原样返回），
      // data.collectedAt 直接可取。注入点采用 cast 模式（不扩 BridgeContext 契约接口）：
      // 服务侧把回调塞进 bridgeCtx，provider 侧用 as unknown as {...} 强转读取。
      if (req.capabilityId === 'system.network.config') {
        const ca = (data as { collectedAt?: unknown } | undefined)?.collectedAt;
        if (typeof ca === 'string') {
          (this.ctx as unknown as { reportNetCfg?: (collectedAt: string) => void } | undefined)?.reportNetCfg?.(ca);
        }
      }

      const audit = await ctx.audit.append({
        ts: new Date().toISOString(),
        traceId: req.traceId,
        auditId: newId('aud'),
        principal: { host: 'vm-service', user: process.env['USERNAME'] ?? 'unknown', channel: 'mcp' },
        capabilityId: req.capabilityId,
        risk: cap.risk,
        params: req.params,
        policyDecision: { allowed: true, matchedRule: verdict.matchedRule },
        ...(req.approvalId
          ? {
              approval: {
                approvalId: req.approvalId,
                approvedBy: 'host',
                approvedAt: new Date().toISOString(),
                previewHash: '',
              },
            }
          : {}),
        result: { ok: true, summary: `${req.capabilityId} 执行成功` },
        ...(artifacts.length > 0 ? { artifacts: artifacts.map((a) => `sha256:${a.name}`) } : {}),
        durationMs,
      });

      return { traceId: req.traceId, ok: true, data, artifacts, durationMs, auditRef: audit.auditId };
    } catch (e) {
      return this.fail(req, this.toBridgeError(e), started, ctx);
    } finally {
      this.active--;
    }
  }

  /* ------------------------------ runGoal ------------------------------ */

  async runGoal(goal: GoalRequest, sink: ProgressSink): Promise<GoalResult> {
    const ctx = this.requireCtx();
    const steps: GoalStep[] = [];
    const artifacts: Artifact[] = [];
    const started = Date.now();

    const step = async (
      capabilityId: string,
      params: Record<string, unknown>,
      summary: string,
    ): Promise<{ ok: boolean; data?: unknown; error?: string }> => {
      const traceId = newTraceId();
      sink.onStatus('working', `执行 ${capabilityId}：${summary}`);
      const res = await this.execute({
        traceId,
        capabilityId,
        params,
        risk: ctx.capabilities.get(capabilityId)?.risk ?? 'L3',
        approved: false,
        timeoutMs: goal.timeoutMs,
      });
      steps.push({
        index: steps.length,
        capabilityId,
        params,
        ok: res.ok,
        risk: ctx.capabilities.get(capabilityId)?.risk ?? 'L3',
        durationMs: res.durationMs,
        traceId,
        summary,
        ...(res.error ? { error: res.error } : {}),
      });
      for (const a of res.artifacts ?? []) {
        artifacts.push(a);
        sink.onArtifact(a);
      }
      return { ok: res.ok, data: res.data, ...(res.error ? { error: res.error.message } : {}) };
    };

    const text = goal.goal;

    /* ---- 模板 1：安装应用 ---- */
    const installMatch = /安装\s*([A-Za-z0-9\u4e00-\u9fa5._\- ]{1,40})/.exec(text);
    if (installMatch && this.allowed(goal, 'app.winget.install')) {
      const query = installMatch[1]!.trim();
      const found = await step('app.winget.search', { query, limit: 5 }, `搜索「${query}」`);
      if (!found.ok) return this.goalFail(steps, artifacts, `搜索失败：${found.error ?? '未知原因'}`, started);

      const list = (found.data as Array<{ id?: string; name?: string }> | undefined) ?? [];
      if (list.length === 0) {
        return this.goalFail(steps, artifacts, `未找到与「${query}」匹配的包，请改用 MCP 指定确切包 ID`, started);
      }
      const target = list[0]?.id;
      if (!target) {
        return this.goalFail(steps, artifacts, '搜索结果缺少包 ID，请改用 MCP 指定确切包 ID', started);
      }
      const installed = await step('app.winget.install', { id: target }, `安装 ${target}`);
      return {
        ok: installed.ok,
        summary: installed.ok ? `已安装 ${target}` : `安装失败：${installed.error ?? '未知原因'}`,
        artifacts,
        steps,
        ...(installed.ok ? {} : { error: makeError('EXECUTION_FAILED', installed.error ?? '安装失败') }),
      };
    }

    /* ---- 模板 2：磁盘空间分析（只分析，不删除 —— 安全默认） ---- */
    if (/(磁盘|空间|容量|占满|清理建议)/.test(text) && this.allowed(goal, 'storage.cleanup.analyze')) {
      const r = await step('storage.cleanup.analyze', { topLargeFiles: 30 }, '分析磁盘占用与清理建议');
      return {
        ok: r.ok,
        summary: r.ok
          ? '已完成磁盘分析并给出建议（**未执行任何删除**）。如需删除，请明确指定路径并逐项走审批。'
          : `分析失败：${r.error ?? '未知原因'}`,
        artifacts,
        steps,
        ...(r.ok ? {} : { error: makeError('EXECUTION_FAILED', r.error ?? '分析失败') }),
      };
    }

    /* ---- 模板 3：系统信息 ---- */
    if (/(系统信息|系统状态|配置|版本)/.test(text) && this.allowed(goal, 'system.info.get')) {
      const r = await step('system.info.get', {}, '获取系统信息');
      return {
        ok: r.ok,
        summary: r.ok ? '已获取系统信息' : `获取失败：${r.error ?? '未知原因'}`,
        artifacts,
        steps,
        ...(r.ok ? {} : { error: makeError('EXECUTION_FAILED', r.error ?? '获取失败') }),
      };
    }

    /* ---- 模板 4：截图 ---- */
    if (/(截图|截屏|看看屏幕|当前屏幕)/.test(text) && this.allowed(goal, 'gui.screen.capture')) {
      const r = await step('gui.screen.capture', { asBase64: true }, '截取当前屏幕');
      return {
        ok: r.ok,
        summary: r.ok ? '已截取当前屏幕（见 artifact）' : `截图失败：${r.error ?? '未知原因'}`,
        artifacts,
        steps,
        ...(r.ok ? {} : { error: makeError('EXECUTION_FAILED', r.error ?? '截图失败') }),
      };
    }

    /* ---- 模板 5：应用生产操作（appops） ---- */
    // 检测"用某个软件把活干出来"的生产意图；确定性 V1 只能调度**已登记的工作流**，
    // 开放/创意类意图（如"用 Photoshop 把大山换成海洋"）需升级 LLM VM Agent（见 SPEC-AGENT-SERVICE-BRIDGE §开放任务）。
    const productionHint = /(处理|编辑|生成|生产|转换|转码|批处理|换背景|加水印|去水印|导出|排版|报表|抠图|合成)/;
    const appHint = /(photoshop|ps\b|图片|照片|图像|excel|表格|报表|word|文档|报告|pdf|ffmpeg|视频|mp4|gif|浏览器|网页|ide|构建)/i;
    if (productionHint.test(text) && appHint.test(text) && this.allowed(goal, 'appops.workflow.run')) {
      let preferredApp = 'generic';
      if (/photoshop|ps\b|图片|照片|图像/.test(text)) preferredApp = 'photoshop';
      else if (/excel|表格|报表/.test(text)) preferredApp = 'excel';
      else if (/word|文档|报告|pdf/.test(text)) preferredApp = 'office';
      else if (/ffmpeg|视频|mp4|gif/.test(text)) preferredApp = 'ffmpeg';
      else if (/浏览器|网页/.test(text)) preferredApp = 'browser';

      const r = await step(
        'appops.workflow.run',
        { workflow: 'generic_production', params: { goal: text, preferredApp }, outputDirectory: '%USERPROFILE%\\WinVMWorkspace\\out' },
        '调度应用生产工作流',
      );
      if (r.ok) {
        return {
          ok: true,
          summary: '已调度应用生产工作流并执行成功（见 artifact）。如需更精细的开放意图处理，建议升级 VM Agent 为 LLM provider。',
          artifacts,
          steps,
        };
      }
      // 工作流未登记：明确引导（不硬猜、不伪造）
      const msg = (r.error ?? '工作流未找到') as string;
      return {
        ok: false,
        summary:
          '确定性执行器未匹配到预置的生产工作流（' + preferredApp + '）。' +
          '两种解法：① 在 VM 的 workflows 目录预置 `generic_production` 工作流脚本；' +
          '② 升级 VM Agent 为 LLM provider（改配置 agent.provider 即可），由其在 VM 内自主规划并操作应用。',
        artifacts,
        steps,
        error: makeError('UNSUPPORTED_GOAL', 'WORKFLOW_NOT_FOUND: ' + msg),
      };
    }

    /* ---- 无匹配模板：明确告知，不硬猜 ---- */
    return {
      ok: false,
      summary:
        '确定性执行器未匹配到内置目标模板。' +
        (this.enableLlmPlanning
          ? '（LLM 规划已开启但 V1 未实现该分支）'
          : '建议：① 改用 MCP 通道逐步调用具体能力；② 或升级 provider 为 LLM Agent（改配置 agent.provider 即可，框架无需改动）。'),
      artifacts,
      steps,
      error: makeError('UNKNOWN_CAPABILITY', 'UNSUPPORTED_GOAL：无匹配的目标模板'),
    };
  }

  /* ------------------------------ health / shutdown ------------------------------ */

  async health(): Promise<HealthStatus> {
    const session = await this.sessionHealth();
    const bridge = this.bridge;
    const bridgeHealth =
      bridge?.health() ?? { state: 'down' as const, uptimeMs: 0, pending: 0, lastHeartbeatAgoMs: -1 };

    let auditInfo: { entries: number; chainValid: boolean } | undefined;
    try {
      const v = await this.requireCtx().audit.verifyChain();
      auditInfo = { entries: v.entries, chainValid: v.valid };
    } catch {
      auditInfo = undefined;
    }

    const ok = bridgeHealth.state === 'ready';
    // D2：psBridge 附带 restarts / lastError（纯增量，既有字段语义不变）。
    // 用交叉类型承载扩展字段，避免在对象字面量位置触发多余属性检查（契约 HealthStatus 未改动）。
    const psBridge: NonNullable<HealthStatus['psBridge']> & {
      restarts?: number;
      lastError?: string;
    } = {
      state: bridgeHealth.state === 'ready' ? 'ready' : 'unavailable',
      uptimeMs: bridgeHealth.uptimeMs,
      pending: bridgeHealth.pending,
      ...('restarts' in bridgeHealth ? { restarts: bridgeHealth.restarts } : {}),
      ...('lastError' in bridgeHealth && bridgeHealth.lastError
        ? { lastError: bridgeHealth.lastError }
        : {}),
    };

    return {
      ok,
      provider: {
        id: this.id,
        state: ok ? 'ready' : 'degraded',
        ...(ok ? {} : { detail: 'ps-bridge 未就绪，仅 meta 能力可用' }),
      },
      session,
      psBridge,
      capabilities: {
        count: this.ctx?.capabilities.list().length ?? 0,
        available: this.ctx?.capabilities.list().length ?? 0,
      },
      ...(auditInfo ? { audit: auditInfo } : {}),
    };
  }

  async shutdown(): Promise<void> {
    // D1：仅当 bridge 由本 provider 自建时才停止；注入实例的生命周期归服务统一管理，
    // 误停会直接把单例 ps-bridge 杀掉（服务仍在运行却调用全部失败）。
    if (this.bridge && this.ownsBridge) await this.bridge.stop();
    this.bridge = undefined;
  }

  /* ------------------------------ 内部工具 ------------------------------ */

  private async sessionHealth() {
    const probe = (this.ctx as unknown as { sessionProbe?: { probe(): Promise<HealthStatus['session']> } })
      ?.sessionProbe;
    if (probe) return probe.probe();
    // 无探针（如非 Windows）：保守返回 unavailable
    return {
      sessionId: 0,
      windowStation: '',
      desktop: '',
      interactive: false,
      locked: false,
      blackScreen: false,
      state: 'unavailable' as const,
      detail: '未注入会话探针',
    };
  }

  private allowed(goal: GoalRequest, capabilityId: string): boolean {
    if (!goal.allowedCapabilities || goal.allowedCapabilities.length === 0) return true;
    return goal.allowedCapabilities.some(
      (p) => p === capabilityId || (p.endsWith('.*') && capabilityId.startsWith(p.slice(0, -1))),
    );
  }

  /** 从注册表取实现绑定（模块 + 函数） */
  private implementationOf(capabilityId: string): { module: string; fn: string } {
    const def = (
      this.ctx as unknown as {
        capabilityDefs?: Map<string, { implementation: { module: string; function: string } }>;
      }
    )?.capabilityDefs?.get(capabilityId);
    if (def) return { module: def.implementation.module, fn: def.implementation.function };
    // 兜底：按 ID 前缀推断模块
    return { module: capabilityId.split('.')[0] ?? 'system', fn: 'Get-SystemInfo' };
  }

  /**
   * 取能力的注册表定义（D24 入参契约校验用）。返回 `undefined` 表示「无定义」→ 跳过校验。
   *
   * 优先读服务注入的 `ctx.capabilityDefs`（与 {@link implementationOf} 同源）；
   * 兜底尝试 `ctx.capabilities.get()`（部分宿主把完整定义挂在注册表视图上）。
   */
  private definitionOf(capabilityId: string): { input?: Record<string, unknown> } | undefined {
    const fromMap = (
      this.ctx as unknown as {
        capabilityDefs?: Map<string, { input?: Record<string, unknown> }>;
      }
    )?.capabilityDefs?.get(capabilityId);
    if (fromMap) return fromMap;
    return (
      this.ctx as unknown as {
        capabilities?: { get?: (id: string) => { input?: Record<string, unknown> } | undefined };
      }
    )?.capabilities?.get?.(capabilityId);
  }

  /**
   * CL-017 D26：对**已提供**的单个实参做值层面校验（`enum` + `type`，均按 PS 绑定语义）。
   *
   * 设计原则（**宁可漏报，不可误报**）：
   *   - 无 `type` 声明 → 跳过（定义层未约束类型，不阻断；如 `storage.file.write.content`）；
   *   - 值为 `null` / `undefined` → 跳过（「缺省」语义交由 `required` 判定，此处不重复拦截）；
   *   - `enum`：字符串成员**忽略大小写**匹配（对齐 PS `ValidateSet`，见 {@link enumIncludesValue}）；
   *     真正的越界值（如 `'bogus'`）仍被拒绝；
   *   - `type`：按 {@link isCoercibleTo} 的 PS 可强转性判定（含标量 → 数组提升）；
   *   - `schema` 非对象时按可判定的部分判定。
   *
   * @param key 参数名
   * @param schema 该参数在 `properties` 中的声明
   * @param value 调用方实参（保证非 `null` / 非 `undefined`）
   * @returns 非法时返回 `{ key, expected, got }` 诊断；合法则返回 `undefined`
   */
  private checkParamValue(
    key: string,
    schema: Record<string, unknown>,
    value: unknown,
  ): { key: string; expected: string; got: string } | undefined {
    // ① enum：优先于 type 判定；字符串按忽略大小写匹配（PS ValidateSet 默认忽略大小写）
    const rawEnum = schema['enum'];
    if (Array.isArray(rawEnum) && rawEnum.length > 0 && !enumIncludesValue(rawEnum, value)) {
      return {
        key,
        expected: `enum(${rawEnum.map((v) => JSON.stringify(v)).join('|')})`,
        got: describeArg(value),
      };
    }

    // ② type：无声明跳过；有声明则按 PS 可强转性判定（支持 `type: string[]`）
    const rawType = schema['type'];
    const types = Array.isArray(rawType)
      ? rawType.filter((t): t is string => typeof t === 'string')
      : typeof rawType === 'string'
        ? [rawType]
        : [];
    if (types.length === 0) return undefined;
    if (types.some((t) => isCoercibleTo(t, value))) return undefined;

    return { key, expected: types.join('|'), got: describeArg(value) };
  }

  /**
   * D24 + D26：入参契约前置校验（Node 侧，不依赖 PowerShell、**不发起桥调用**）。
   *
   * 背景：当调用方把参数名写错（未知参数）、漏传必填项、或给出**值层面非法**（类型不符 /
   * 枚举越界）的实参时，旧实现会把参数原样丢给 PowerShell —— 由其参数绑定抛出**英文异常**
   * 且无领域码 → 被压成 `EXECUTION_FAILED`，调用方无法区分「我传错了参数」与「VM 执行失败」，
   * 也无法据此路由补救动作。
   *
   * 现语义：在 `execute()` 发起桥调用**之前**，用注册表 `inputSchema` 做一次契约校验：
   *   - `unknown`（D24）：`params` 中不在「允许集」的键；
   *   - `missing`（D24）：`required` 中缺失 / 为 `null` / 为 `undefined` 的键；
   *   - `invalid`（D26）：已提供但**值非法**的键（`enum` 越界 / `type` 不可强转），
   *     元素形如 `{ key, expected, got }`；
   * 任一非空即返回 `INVALID_PARAMS` + `reason = 'INVALID_ARGUMENT'`
   * （`details` 恒带 `unknown` / `missing` / `allowed` / `invalid` 四字段），**不产生任何桥往返**。
   *
   * 允许集恒含 {@link APPROVAL_FIELD}（审批续跑字段）；`required` 中非字符串项被忽略。
   * 无 schema（未声明 `properties`）时**跳过校验**，保持既有行为不变。
   *
   * @param capabilityId 能力 ID
   * @param params 调用参数（已剥离宿主侧审批字段）
   * @returns 校验失败时返回 `INVALID_PARAMS` 错误对象；通过则返回 `undefined`
   */
  private validateParams(
    capabilityId: string,
    params: Record<string, unknown>,
  ): ReturnType<typeof makeError> | undefined {
    const input = this.definitionOf(capabilityId)?.input;
    const props = input?.['properties'];
    // 无 `properties` / 非对象 → 跳过校验（宁可漏报，不可误报阻断）
    if (props === null || typeof props !== 'object' || Array.isArray(props)) return undefined;

    const propsMap = props as Record<string, unknown>;
    const allowed = Object.keys(propsMap);
    const allowedSet = new Set<string>([...allowed, APPROVAL_FIELD]);

    const rawRequired = input?.['required'];
    const required = Array.isArray(rawRequired)
      ? rawRequired.filter((k): k is string => typeof k === 'string')
      : [];

    const unknown = Object.keys(params).filter((k) => !allowedSet.has(k));
    const missing = required.filter((k) => params[k] === undefined || params[k] === null);

    // D26：对**已提供**（非 null / 非 undefined）的键做值校验
    const invalid: Array<{ key: string; expected: string; got: string }> = [];
    for (const key of allowed) {
      const value = params[key];
      if (value === undefined || value === null) continue; // 缺省 → 由 required 判定
      const schema = propsMap[key];
      if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) continue;
      const bad = this.checkParamValue(key, schema as Record<string, unknown>, value);
      if (bad) invalid.push(bad);
    }

    if (unknown.length === 0 && missing.length === 0 && invalid.length === 0) return undefined;

    const clauses: string[] = [];
    if (unknown.length > 0) clauses.push(`不支持的参数 ${unknown.join(', ')}`);
    if (missing.length > 0) clauses.push(`缺少必填参数 ${missing.join(', ')}`);
    if (invalid.length > 0) {
      clauses.push(
        `参数取值非法 ${invalid.map((b) => `${b.key}(期望 ${b.expected}，实为 ${b.got})`).join(', ')}`,
      );
    }
    const message =
      `参数校验失败：${clauses.join('；')}。该能力可用参数：${allowed.join(', ')}。`;

    return makeError('INVALID_PARAMS', message, {
      reason: 'INVALID_ARGUMENT',
      details: { unknown, missing, allowed, invalid },
    });
  }

  /**
   * D5：构造 meta.health.check 的健康快照。
   *
   * 优先复用服务侧注入的 `healthSnapshot()`（与 `GET /health` 同构）；
   * 未注入（单测 / 独立运行）时退化为 provider 自身的 health()，保证语义仍为「健康快照」。
   */
  private async buildHealthSnapshot(): Promise<Record<string, unknown>> {
    const injected = (
      this.ctx as unknown as { healthSnapshot?: () => Promise<Record<string, unknown>> } | undefined
    )?.healthSnapshot;
    if (typeof injected === 'function') return await injected();
    return (await this.health()) as unknown as Record<string, unknown>;
  }

  /**
   * D10：按能力定义声明的列表语义强制保形为数组。
   *
   * 背景：PowerShell 的 `return @(...)` 会把单元素数组「展开」为标量、空数组变成 `$null`，
   * 经 `ConvertTo-Json` 后表现为「单条命中回对象、零命中回 null/{ }」，破坏调用方的列表契约。
   * 这里依据定义层 `output.array === true` 标记，在 provider 边界统一规范化为数组。
   */
  private normalizeListOutput(capabilityId: string, data: unknown): unknown {
    if (!this.isListCapability(capabilityId)) return data;
    if (Array.isArray(data)) return data;
    if (data === null || data === undefined) return [];
    // Windows PowerShell 5.1 的 ConvertTo-Json 会把 $null 序列化成 `{}`（真机实测），
    // 故对列表能力而言「空对象」等价于「空列表」——否则空结果会回成 [{}]（比 {} 更糟）。
    if (typeof data === 'object' && Object.keys(data as Record<string, unknown>).length === 0) return [];
    return [data];
  }

  /** 能力定义是否声明了列表输出（`output.array === true`） */
  private isListCapability(capabilityId: string): boolean {
    const def = (
      this.ctx as unknown as {
        capabilityDefs?: Map<string, { output?: { array?: boolean } }>;
      }
    )?.capabilityDefs?.get(capabilityId);
    return def?.output?.['array'] === true;
  }

  private extractArtifacts(capabilityId: string, data: unknown): Artifact[] {
    if (capabilityId !== 'gui.screen.capture' || typeof data !== 'object' || data === null) return [];
    const d = data as Record<string, unknown>;
    if (typeof d['data'] !== 'string') return [];
    return [
      {
        kind: 'screenshot',
        name: `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`,
        mime: 'image/png',
        data: d['data'],
        encoding: 'base64',
      },
    ];
  }

  /**
   * 把任意异常规范化为 `BridgeError`（CL-017 D23 重写）。
   *
   * 背景：psmod 里共 35 处 `throw "UPPER_SNAKE: msg"`（如 `FILE_NOT_FOUND`、
   * `CLI_NOT_FOUND`、`SERVICE_NOT_FOUND`），ps-bridge.ps1 与 `ps-bridge.ts#call()`
   * 都已把该领域码保真上抛；但旧实现只有 9 项白名单，领域码不在其中 → **全部被压成
   * `EXECUTION_FAILED`、码丢失**，导致调用方无法按原因路由补救动作。
   *
   * 现语义（三层，顺序敏感）：
   *   ① `err.code` ∈ 契约层 10 码 → 原样透传（行为不变，details 仍不传）；
   *   ② `err.code` 匹配领域码形态 → 按**最小映射**定 base code，原领域码写入 `reason`，
   *      并透传 `err.details`（含上游 `exceptionType`）；
   *   ③ 无码 / 非法码 → `EXECUTION_FAILED`（不带 reason），与既行为完全一致。
   */
  private toBridgeError(e: unknown): ReturnType<typeof makeError> {
    const err = e as { code?: string; message?: string; details?: unknown };
    const message = err?.message ?? String(e);

    // ① 契约层 10 码：原样透传
    if (err?.code && BRIDGE_ERROR_CODES.includes(err.code)) {
      return makeError(err.code as never, message);
    }

    // ② 领域码：定 base code + 记录 reason + 透传 details
    if (err?.code && DOMAIN_CODE_RE.test(err.code)) {
      const base = (DOMAIN_CODE_TO_BASE[err.code] ?? 'EXECUTION_FAILED') as never;
      const details =
        err.details !== null && typeof err.details === 'object'
          ? (err.details as Record<string, unknown>)
          : undefined;
      return makeError(base, message, {
        reason: err.code,
        ...(details ? { details } : {}),
      });
    }

    // ③ 兜底：无码 / 非法码 → EXECUTION_FAILED（不带 reason），防止把任意字符串当码透出；
    //    D24：同时透传 `err.details`（若有），保留上游诊断信息（如 PS ParameterBindingException 详情）。
    const details =
      err?.details !== null && typeof err?.details === 'object'
        ? (err.details as Record<string, unknown>)
        : undefined;
    return makeError('EXECUTION_FAILED', message, details ? { details } : undefined);
  }

  private async fail(
    req: CapabilityRequest,
    error: ReturnType<typeof makeError>,
    started: number,
    ctx: BridgeContext,
    retryable?: boolean,
  ): Promise<CapabilityResult> {
    const durationMs = Date.now() - started;
    try {
      await ctx.audit.append({
        ts: new Date().toISOString(),
        traceId: req.traceId,
        auditId: newId('aud'),
        principal: { host: 'vm-service', user: process.env['USERNAME'] ?? 'unknown', channel: 'mcp' },
        capabilityId: req.capabilityId,
        risk: ctx.capabilities.get(req.capabilityId)?.risk ?? 'L3',
        params: req.params,
        policyDecision: { allowed: false, matchedRule: error.code },
        result: { ok: false, errorCode: error.code, summary: error.message },
        durationMs,
      });
    } catch {
      // 审计失败不得掩盖原始错误
    }
    return {
      traceId: req.traceId,
      ok: false,
      error: retryable === undefined ? error : { ...error, retryable },
      durationMs,
    };
  }

  private goalFail(
    steps: GoalStep[],
    artifacts: Artifact[],
    summary: string,
    started: number,
  ): GoalResult {
    return {
      ok: false,
      summary: `${summary}（耗时 ${Date.now() - started}ms）`,
      artifacts,
      steps,
      error: makeError('EXECUTION_FAILED', summary),
    };
  }
}

/** loader 约定导出：createProvider */
export function createProvider(options?: DeterministicProviderOptions): DeterministicAgentProvider {
  return new DeterministicAgentProvider(options ?? {});
}

export { riskAtLeast };

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
  type BridgeError,
  makeError,
  matchesCapability,
  riskAtLeast,
} from '@winvm/contracts';
import { newId, newTraceId, guiAllowed, nonGuiAllowed, describeSessionState, resolvePolicyGateWiring, foldK6Verdict } from '@winvm/core';
import { PsBridge, UNIFIED_CAPABILITIES, WINDOWS_CAPABILITIES, type PsBridgeOptions } from '@winvm/vm-capabilities';
/**
 * Step 4.2（阶段 4）：模板逻辑已搬到 `TemplatePlanner`。
 *
 * 本文件从「实现执行体」降级为「provider 外壳 + 装配」：
 * `runGoal` 只剩 `this.planner().plan(goal, sink)` 一行转发。
 */
import { TemplatePlanner } from './template-planner.js';

export const PROVIDER_ID = 'workbuddy-deterministic';

/**
 * 契约层「封闭码集」的**镜像**（权威单源 = `@winvm/contracts` 的 `BridgeErrorCode`，
 * 对外登记见 docs/02-design/INTERFACES.md §2.6）。
 * 这些码决定**重试 / 审批**语义，是**对外契约**，不得因新增 PS 领域码而扩张。
 * 本镜像只收 `toBridgeError` 通道会透传的码（批9 主理人裁定 notes §8a：两新码不经该通道；
 * 数组本体与封闭码集不逐字相等属既有裁断，动它=行为改动，phase2-mcp-signal 钉形态）。
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
  /**
   * ARCH-29（P2-T4）：ps-bridge 的本地中止 ⇒ 契约码 **必须**是 `TASK_CANCELED`。
   *
   * 若任其兜底成 `EXECUTION_FAILED`，LLM provider 的 `shouldDegrade` 会把
   * 「EXECUTION_FAILED 且零 artifact」判为「运行时不可用」并**回落确定性执行器重跑**
   * —— 等于把宿主已经走开/叫停的操作再执行一遍（Phase 1 CL-022 3a 同一条红线）。
   */
  PSBRIDGE_CANCELED: 'TASK_CANCELED',
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
 * ARCH-29（P2-T4）：宿主断连中止的**执行侧收口错误**（`TASK_CANCELED`，`reason` 记中止阶段）。
 *
 * 为什么必须是 `TASK_CANCELED`：见 `DOMAIN_CODE_TO_BASE` 中 `PSBRIDGE_CANCELED` 的同条理由 ——
 * 折叠成 `EXECUTION_FAILED` 会命中 LLM 层 `shouldDegrade` 的降级重跑判据。
 *
 * 为什么文案**只说本地停止、不说 VM 已停**：`cmd.exe` 家族无信号透传，Node 侧无法强杀
 * 已下发的操作；宣称「未执行任何变更」或「已终止」都是不实陈述（`SECURITY-GOVERNANCE.md` §2.2）。
 * `retryable:false` 由 `DEFAULT_RETRYABLE` 给出 —— 重跑必须重新发起并重新过审批闸。
 */
function hostDisconnectedError(phase: string): ReturnType<typeof makeError> {
  return makeError('TASK_CANCELED', `宿主连接断开，本地已停止跟进（中止于：${phase}）`, {
    reason: 'HOST_DISCONNECTED',
    details: { hostDisconnected: true, inFlightMayContinue: true, canceledPhase: phase },
  });
}

/**
 * ARCH-29：能力边界的「宿主是否已走」判据（**必须是函数调用**，不能内联写
 * `req.signal?.aborted === true`）。
 *
 * 为什么：`req` 是 `readonly` 形参，TS 会在**首次判定为 false 后把 `aborted` 收窄成
 * `false` 并在整个函数体内保持**（跨 `await` 也不失效）—— 而 `AbortSignal.aborted`
 * 恰恰是**会随时间翻转**的外部状态。内联写法会直接报 TS2367（比较无交集），
 * 且即便不报错也是**假守卫**：后续边界点永远读到「未取消」。
 * 走函数调用即每次真读，收窄无法跨调用传递 —— 这不是绕编译器，是**语义正确**的写法。
 */
function isHostGone(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

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

/**
 * M3（Phase 3 批4 · 3a）：模板 5 工作流缺位时的**装机证据映射**。
 * preferredApp（意图分类）→ 可直调的注册表 cliApp + registry 名称探测证据（nameMatchers）。
 * 只登记 `appops.cli.invoke` enum 有对应映射且探测证据可靠的三类；browser/generic
 * 没有免费午餐（无 CLI 映射），不映射=保持原两条解法文案。photoshop 特殊处理：
 * PS 本体不可直调，但 ImageMagick 是开源等价（水印/缩放/格式转换类意图可承接）。
 * excel **不映射**：pandoc 只读 xlsx 不能写报表（亲验其 CLI 形态），给原文案更诚实——
 * 映射了反而教 Agent 产出错误预期（名实相符纪律，与 M3 要消灭的"空转承诺"同族）。
 */
const WORKFLOW_CLI_APP: Record<
  string,
  { cliApp: 'ffmpeg' | 'magick' | 'soffice' | 'pandoc'; probeName: string; nameMatchers: RegExp[] }
> = {
  ffmpeg: { cliApp: 'ffmpeg', probeName: 'ffmpeg', nameMatchers: [/ffmpeg/i] },
  office: { cliApp: 'soffice', probeName: 'libreoffice', nameMatchers: [/libreoffice/i] },
  photoshop: { cliApp: 'magick', probeName: 'imagemagick', nameMatchers: [/imagemagick/i, /\bmagick\b/i] },
};

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
  /**
   * 批1（E-1/M2 接线 · 第三调用点门控）：双闸灰度态。deterministic 的 in-process
   * `execute` 自带一处策略评估（不经 /mcp 服务层），是宿主声明 scope 必须独立接线的
   * 第三调用点。仅 `on` 态把 goal 的**声明**两键喂进该评估——`shadow` 观测面归服务层
   * （本 provider 缺省模板全 L0/L1，scope 两闸本就不触发，shadow 在此态无额外价值），
   * `off` 逐字旧行为。缺省 shadow ⇒ 本 provider 默认零喂 scope（升级窗口安全档）。
   */
  private readonly policyGateWiring: 'off' | 'shadow' | 'on';
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
    // 批1：双闸灰度态（缺省 shadow ⇒ 本 provider 的 in-process 评估不喂 scope，逐字旧行为）。
    this.policyGateWiring = resolvePolicyGateWiring();
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

    // —— ARCH-29（P2-T4）判据 1 的**执行侧同型闸**：派发前已断连 ⇒ 零副作用直接收口 ——
    // 位置纪律：必须在「策略评估 / 入参校验 / 会话探针 / 并发闸门 / 桥调用」**全部之前**。
    // 理由：这四段各有副作用面（会话探针会打一次 `bridge.call`、并发闸门会占额度），
    // 而「宿主已经不在这条连接上了」是**比它们更优先的事实** —— 与 Phase 1 `step()` 咽喉点
    // 「取消优先于执行」同一条口径。缺席（stdio / A2A 委派 / 单测）⇒ 整段跳过，逐字旧行为。
    if (isHostGone(req.signal)) {
      return this.fail(req, hostDisconnectedError('派发前宿主连接已断开'), started, ctx);
    }

    if (!cap) {
      return this.fail(req, makeError('UNKNOWN_CAPABILITY', `能力未注册：${req.capabilityId}`), started, ctx);
    }

    // —— 策略引擎（拒绝优先）——
    // 批1（E-1/M2 双闸接线 · 第三调用点）：deterministic 的 in-process execute 不经 /mcp
    // 服务层，自带这处评估 ⇒ 必须独立接线宿主**声明**的 scope 两键（否则 deterministic
    // 委派的封顶/白名单仍是死代码）。两键只在 step() 用 goal 声明值填充时才进 req（见下），
    // 服务端回退默认绝不进这里 ⇒ 零可用性断崖。engine.ts 步骤 1/5 的「仅声明才执法」逐字适用。
    const verdict = ctx.policy.evaluate({
      capabilityId: req.capabilityId,
      params: req.params,
      risk: cap.risk,
      approved: req.approved,
      ...(req.approvalId ? { approvalId: req.approvalId } : {}),
      ...(req.scopeMaxRisk ? { maxRisk: req.scopeMaxRisk } : {}),
      ...(req.scopeAllowedCapabilities && req.scopeAllowedCapabilities.length > 0
        ? { allowedCapabilities: req.scopeAllowedCapabilities }
        : {}),
    });
    if (!verdict.allowed) {
      // E-2 最小诚实收口（批1 与 (c) 同域）：deterministic provider **不持有审批协调器**
      // （全仓 raise 生产调用点唯一在 LLM 桥 bridge.ts）⇒ 命中审批闸时它既无法注册续跑
      // 令牌、也无法挂起 input-required，只能失败收口。旧行为把这条「结构性能力缺失」藏在
      // 裸 APPROVAL_REQUIRED 里（宿主看到码、看不到出路）。此处**纯附加** details.nextActions
      // 显形两条真实出路：① 该 provider 天生只编排 L0/L1，遇 L2/L3 说明目标越界；② 换
      // LLM provider（agent.provider）或 MCP 直调委派审批。不改判定、不改码、不改 ok——
      // 只补可路由指引（fail-closed 方向不变，缺省模板全 L0/L1 触不到本分支）。
      const denyError =
        verdict.requiresApproval && verdict.error?.code === 'APPROVAL_REQUIRED'
          ? {
              ...verdict.error,
              details: {
                ...(verdict.error.details ?? {}),
                executor: 'deterministic',
                suspendSupported: false,
                nextActions: [
                  '确定性执行器不实现审批挂起（无协调器）：该能力属 L2/L3，超出本 provider 编排面',
                  '改用 LLM provider（配置 agent.provider=workbuddy）：其委派可挂起 input-required 待宿主批准后续跑',
                ],
              },
            }
          : (verdict.error ?? makeError('POLICY_DENIED', `被策略拒绝：${verdict.matchedRule}`));
      return this.fail(
        req,
        denyError,
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
    // P3-b3 A2-12（audit §3.2）：三判据真实接线 +「探测未知」与「确不可用」错误语义分流。
    //   拒绝面 = 旧态逐字一致（仅 unavailable/black-screen 拒 ⇒ 零行为回归，锁屏下只读探测类
    //   能力照旧可跑）；guiAllowed 作为「完全健康」正向判据消费，degraded/非交互的带通过
    //   经 warn 日志显形（不再是静默通过；扩 CapabilityResult 契约入回执属过度设计，不做）；
    //   describeSessionState 提供人读态；probeError
    //   在场 ⇒ 布尔是 fail-closed 兜底值（契约原文），改报可重试的 SESSION_PROBE_FAILED，
    //   旧实现把它误归"确不可用"（A2-12 病灶）。**放行结论零放宽**（PR8 红线：变的只是归因与显形）。
    if (cap.requiresSession) {
      const session = await this.sessionHealth();
      if (session.probeError) {
        // 契约层不扩码（封闭码集，单源 errors.ts）：code 沿用 SESSION_UNAVAILABLE（本就 retryable:true），
        // 归因显形走 CL-017 D23 的领域层 reason='SESSION_PROBE_FAILED'——调用方/审计据此
        // 区分「探测通路故障（查 runbook）」vs「确不可用（恢复会话）」，正是 reason 字段的设计用途。
        const probeErr = makeError(
          'SESSION_UNAVAILABLE',
          `会话状态未能探得（非确不可用）：${session.probeError}${session.probeErrorCode ? ` [${session.probeErrorCode}]` : ''}。可稍后重试；持续失败请查会话探测通路（docs/04-ops runbook）。`,
          { reason: 'SESSION_PROBE_FAILED' },
        );
        return this.fail(req, probeErr, started, ctx);
      }
      if (!nonGuiAllowed(session) || session.state === 'black-screen') {
        // 拒绝集与旧手写 `state==='unavailable'||state==='black-screen'` **逐字等价**
        // （degraded 只读探测带通过面不变——PR8 零放宽）；black-screen 显式保留：
        // nonGuiAllowed 语义只排 unavailable，黑屏下截图/UIA 同样是瞎的。
        return this.fail(
          req,
          makeError(
            session.state === 'black-screen' ? 'SESSION_BLACK_SCREEN' : 'SESSION_UNAVAILABLE',
            `GUI 能力需要交互式会话。${describeSessionState(session.state)}。${session.detail ?? ''}`,
          ),
          started,
          ctx,
        );
      }
      // 到达此 = 放行带（与旧逐字同集）；guiAllowed=false 的降级通过（如 degraded 锁屏下的
      // 只读探测）记一条 warn 显形，不再是静默通过（审计归因可查）。
      if (!guiAllowed(session)) {
        ctx.logger.warn('GUI 能力在降级会话带通过（guiAllowed=false 但 nonGuiAllowed=true）', {
          capabilityId: req.capabilityId,
          state: session.state,
          describe: describeSessionState(session.state),
        });
      }
      // ARCH-29：会话探针本身是一段真实等待（ps-bridge 往返）。断连若发生在它期间，
      // 必须在**发起能力调用之前**再问一次 —— 这是「协作式中止在每个能力边界轮询」的
      // 第二个边界点（第一个是函数入口）。
      if (isHostGone(req.signal)) {
        return this.fail(req, hostDisconnectedError('会话探针期间宿主连接已断开'), started, ctx);
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

    // ARCH-29：并发闸门与会话探针都可能等待 ⇒ 发起前最后一次边界轮询（咽喉纪律：
    // 绝不在「宿主已走」判定成立后还发起能力调用）。
    if (isHostGone(req.signal)) {
      return this.fail(req, hostDisconnectedError('发起能力调用前宿主连接已断开'), started, ctx);
    }

    this.active++;
    try {
      // 能力定义 → PowerShell 模块/函数（从注册表取实现绑定）
      const impl = this.implementationOf(req.capabilityId);

      // T02b：能力级超时以**注册表为权威**，请求级仅作回落。
      //   决策理由：
      //   1) A2A 通道透传的 metadata 超时仅 300s；K6（app.uninstall）最坏路径
      //      winget 300s + NSIS 静默回退 240s = 540s，若只看请求级超时（未带或带 300s）
      //      必被 ps-bridge 的 PSBRIDGE_TIMEOUT 掐断，
      //      把「已经成功的卸载」误报为超时失败。
      //   2) 超时属于能力自身属性（contracts `CapabilityDefinition.timeoutMs` 必填），
      //      不是调用方属性；MCP 路径 `vm-service/src/server.ts:524` 已如此
      //      注入 `cap.timeoutMs`。两条通道口径在此对齐，避免同一能力两种时限。
      //   注册表缺项（如 provider 自建兜底）才回落 `req.timeoutMs`，最后 30s 兜底。
      //   `__meta.healthCheck` 走 Node 内置快照，不经过 bridge.call，不受影响。
      const capTimeoutMs = impl.timeoutMs;

      // D5：meta.health.check 由 Node 侧**内置**返回与 GET /health 同构的快照
      //     （原绑定 system.Get-SystemInfo 返回的是系统信息而非健康态，语义不符）。
      // B-4（Phase 5 残项）：meta.capability.list 同理由 Node 侧**注册表直供**真实能力清单
      //     （原绑定 __meta.listModules 实返 ps1 文件名=模块面，与 description「列出当前
      //     已注册并暴露的能力清单」名实落差在实现侧；ps-bridge listModules 分支保留为
      //     内部诊断面，注册表不再路由到它）。
      // 其余 __meta.*（如 meta.session.status=gui.Get-SessionHealth）仍走 ps-bridge。
      //
      // ARCH-29（P2-T4）：`req.signal` 在场时走**带 signal 的分支**（ps-bridge 内部把 abort
      // 与「等回执」竞速，并从 pending 表摘除等待位 —— 因此不存在「取消后迟到的 reject 变成
      // 未处理拒绝」的风险；用外层 `Promise.race` 反而会有这个崩溃面，故不采）；
      // 缺席时**逐字节保留旧调用形态**（4 参），这条分支是 `r3-uninstall-verify` 的
      // T02b 超时形态静态钉所锁的字面量 ⇒ 不得改写。
      // B-4 拦截形态：Node 内置面置于三元链**最左**（healthCheck 判定逐字节不动，
      // r3 T02b ⑤ 静态钉依赖其字面量）；capabilityList 同样**不经 bridge.call** ⇒
      // 零桥往返、零会话依赖（degraded 窄窗下 ps-bridge 未就绪时仍可自省暴露面）。
      const raw =
        impl.module === '__meta' && impl.fn === 'healthCheck'
          ? await this.buildHealthSnapshot()
          : impl.module === '__meta' && impl.fn === 'capabilityList'
            ? this.buildCapabilityList()
            : req.signal
              ? await bridge.call(impl.module, impl.fn, req.params, capTimeoutMs ?? req.timeoutMs ?? 30_000, {
                  signal: req.signal,
                })
              : await bridge.call(impl.module, impl.fn, req.params, capTimeoutMs ?? req.timeoutMs ?? 30_000);

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

      // C0（2c）：链上审计诚实化 —— 本条目 `result.ok` 此前恒 true（bridge.call
      // 未抛=进程级送达），`data.success===false` 的 K6 失败在此被记作「执行成功」。
      // 与响应面（server.ts executeCapability 的 foldK6Verdict，2b）**同源同函数**：
      // 折叠命中 ⇒ 条目 ok=false + 诚实 summary（含残留证据截断）+ errorCode 落位。
      // 注意：provider 返回信封保持 res.ok=true（送达事实），K6 折叠呈报在服务层
      // （回执面）与本处（链条目面）各自由同一纯函数判 —— 两处不叠加、互不覆盖。
      // 消费面：delegation-audit `recordExecuted(record, record.result?.ok===true)`
      // 读此位 ⇒ 账本 executed 归因随之诚实。
      const fold = foldK6Verdict(true, data);

      const audit = await ctx.audit.append({
        ts: new Date().toISOString(),
        traceId: req.traceId,
        auditId: newId('aud'),
        // K-N1：通道真实化 —— 委派内层回连（经 /mcp?dtid=）由服务端注入 req.channel='a2a'；
        // 纯宿主直调仍 'mcp'（req.channel 缺席即旧行为）。修掉「181/181 恒 mcp」观测缺陷。
        principal: {
          host: 'vm-service',
          user: process.env['USERNAME'] ?? 'unknown',
          channel: req.channel ?? 'mcp',
        },
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
        result: fold.k6Failed
          ? {
              ok: false,
              errorCode: 'EXECUTION_FAILED',
              summary: `${req.capabilityId} 执行未成功：${fold.errorMessage ?? '执行器自报未成功（K6 核验未过）'}`,
            }
          : { ok: true, summary: `${req.capabilityId} 执行成功` },
        ...(artifacts.length > 0 ? { artifacts: artifacts.map((a) => `sha256:${a.name}`) } : {}),
        durationMs,
        // K-N1 通道 2（精确归因）：委派回连条目带 ext.delegationId（账本据此归入 executed）
        ...(req.delegationId
          ? { ext: { kind: 'inner-call' as const, delegationId: req.delegationId, channel: req.channel ?? 'a2a' } }
          : {}),
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
    /**
     * Step 4.2（阶段 4）：模板逻辑已搬到 `TemplatePlanner`（`./template-planner.js`）。
     *
     * 本方法**只剩一行转发** —— 这是「provider 降级为壳」的落点：
     * provider 负责生命周期（`init`/`health`/`shutdown`）与装配，
     * 「怎么把事情想清楚」交给 planner。
     *
     * ⚠ 两条纪律（改了就不是纯搬移了）：
     * 1. **不再在此处保留任何模板逻辑**。哪怕只留一个模板，也会形成「两套执行路径」，
     *    下次改模板必然只改一边。
     * 2. `planner` 的依赖在 **`init()` 之后**才可用（要 `ctx`），故在此处**惰性构造**
     *    而不是构造函数里建 —— 构造函数期 `ctx` 还是 `undefined`。
     *
     * 行为等价性由既有 `runGoal` 单测证明（纯搬移，零行为变化）。
     */
    return this.planner().plan(goal, sink);
  }

  /**
   * 惰性构造 `TemplatePlanner`，把 provider 的 5 个能力注入进去。
   *
   * 每次调用都新建：planner 自身无状态（状态全在入参 `steps`/`artifacts` 里），
   * 缓存反而会让「`ctx` 被替换后 planner 仍持有旧 ctx」成为隐患。
   */
  private planner(): TemplatePlanner {
    const ctx = this.requireCtx();
    return new TemplatePlanner({
      execute: (req) => this.execute(req),
      capabilityRisk: (capabilityId) => ctx.capabilities.get(capabilityId)?.risk ?? 'L3',
      newTraceId: () => newTraceId(),
      policyGateWiring: this.policyGateWiring,
      enableLlmPlanning: this.enableLlmPlanning,
    });
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


  /**
   * 从注册表取实现绑定（模块 + 函数），并**同源**带出能力级超时。
   *
   * T02b：`timeoutMs` 是注册表属性（`CapabilityDefinition.timeoutMs`，契约必填），
   * 与实现绑定同源同址，故一并在此取出，供调用方以注册表为权威设定桥调用超时。
   * 注册表缺项（自建兜底路径）时返回 `undefined`，由调用方回落到请求级超时。
   */
  private implementationOf(capabilityId: string): {
    module: string;
    fn: string;
    timeoutMs?: number;
  } {
    const def = (
      this.ctx as unknown as {
        capabilityDefs?: Map<
          string,
          { implementation: { module: string; function: string }; timeoutMs?: number }
        >;
      }
    )?.capabilityDefs?.get(capabilityId);
    if (def) {
      // 仅接受正的有限数（0/负数/NaN 一律视为「注册表未给出」，交由调用方回落）
      const t = def.timeoutMs;
      const timeoutMs =
        typeof t === 'number' && Number.isFinite(t) && t > 0 ? t : undefined;
      return {
        module: def.implementation.module,
        fn: def.implementation.function,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      };
    }
    // 兜底：按 ID 前缀推断模块（此时无注册表定义可依据，超时回落 req 层）
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
   * 构造 `meta.capability.list` 的能力清单 —— **V-NEXT 2.5（方案 B）：读统一表**
   *
   * ## 从哪来
   * 数据源是 `UNIFIED_CAPABILITIES`（112 条 = vm 54 + browser 33 + desktop 25），
   * 与 `tools/list` 的三条路由**同源**：
   *   - `/mcp`         → `exposedCapabilities`（= `WINDOWS_CAPABILITIES ∩ declareCapabilities()` = vm 54）
   *   - `/mcp/browser` → 上游 stdio `tools/list`（无白名单 ⇒ 33 全放）
   *   - `/mcp/desktop` → 上游 stdio `tools/list` ∩ `DEFAULT_DESKTOP_TOOL_ALLOWLIST`（25）
   * 三面合计 112 正是 `UNIFIED_CAPABILITIES` 的定义（见 `contracts/src/unified.ts` 文件头）。
   *
   * ## ⚠ 为什么不能沿用旧的「`WINDOWS_CAPABILITIES` ∩ `declareCapabilities()`」
   * `declareCapabilities()` 只声明六个 **vm 能力域**（`meta/system/app/storage/gui/appops`），
   * 拿它对统一表求交，`browser.*` 与 `desktop.*` 会被**全部滤掉** ⇒ 结果仍是 54（实测）。
   * 那两个面**不归 provider 声明管**：它们的可达性由「服务端是否挂载了该 stdio 上游」
   * 与「白名单」决定，与 VM 侧 provider 无关。所以本函数按面分别取判据：
   *
   * | 面 | 是否受 `declareCapabilities()` 约束 |
   * |---|---|
   * | `vm` | **受**。provider 声明收窄 ⇒ 服务端 `exposedCapabilities` 同步收窄 ⇒ 必须跟着收窄 |
   * | `browser` / `desktop` | **不受**。它们由上游挂载 + 白名单决定，与 provider 声明无关 |
   *
   * ## 字段映射（三面字段集不同，这是 B 方案的真实成本）
   * `CapabilityEntry` 是 `{id, surface, risk, title}`，而旧回执承诺的是 `{id, name, risk}`：
   * - `vm` 面的 `name` 取 `WINDOWS_CAPABILITIES` 的 `name`（真正的 `CapabilityDefinition.name`）
   * - `browser`/`desktop` 面**没有 `name`**（上游 tools/list 只有 `name`=工具名 + `description`）。
   *   这里**回落成 `title`**（中文短标题），而不是编一个假 name —— `title` 是本仓库对该
   *   上游工具唯一的自有中文描述，`name` 语义（能力名）在这两面**不存在**。
   *
   * ⚠ **已知不精确处（诚实标注，勿当 bug 修）**：
   * `WINVM_UPSTREAM_OFF=browser,desktop` 是运维回滚位（`server.ts:2079`），关掉后
   * 这两个面实际不可达，但本函数**看不到**该开关 —— `BridgeContext` 不含上游状态。
   * 故那种状态下本清单会多列 58 条。取舍理由：本函数在 **provider 侧**，
   * 而上游挂载是**服务端侧**决策；让 provider 反查服务端环境变量会形成隐式耦合。
   * 且 `capability.list` 的语义是「**已注册**并暴露」（注册表口径），不是「此刻网络可达」。
   * 若将来需要「当前实可达」口径，正确做法是服务端把上游状态注入 `BridgeContext`，
   * 而不是让本函数去读 `process.env`。
   *
   * 形态不变：`{ ok:true, count, capabilities:[{id,name,risk,surface}], domains:[...] }`
   * （`surface` 为**新增**字段，旧字段名与语义均不变，属向后兼容的加字段）。
   */
  private buildCapabilityList(): Record<string, unknown> {
    const declared = this.declareCapabilities();
    /** vm 面的 name 权威源（`CapabilityEntry` 不含 name，只有 title） */
    const vmNameById = new Map(WINDOWS_CAPABILITIES.map((c) => [c.id, c.name]));

    const exposed = UNIFIED_CAPABILITIES.filter((entry) => {
      // browser / desktop 不受 provider 声明约束：它们的可达性由上游挂载 + 白名单决定。
      if (entry.surface !== 'vm') return true;
      return declared.some((pattern) => matchesCapability(pattern, entry.id));
    });

    const capabilities = exposed
      .map((entry) => ({
        id: entry.id,
        // vm 面用真实能力名；另两面无 name，回落 title（见上「字段映射」）
        name: entry.surface === 'vm' ? (vmNameById.get(entry.id) ?? entry.title) : entry.title,
        risk: entry.risk,
        surface: entry.surface,
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const domains = [...new Set(exposed.map((entry) => entry.id.split('.')[0] ?? ''))]
      .filter(Boolean)
      .sort();
    return { ok: true, count: capabilities.length, capabilities, domains };
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
   *   ① `err.code` ∈ 契约层封闭码集（单源 errors.ts）→ 原样透传（行为不变，details 仍不传）；
   *   ② `err.code` 匹配领域码形态 → 按**最小映射**定 base code，原领域码写入 `reason`，
   *      并透传 `err.details`（含上游 `exceptionType`）；
   *   ③ 无码 / 非法码 → `EXECUTION_FAILED`（不带 reason），与既行为完全一致。
   */
  private toBridgeError(e: unknown): ReturnType<typeof makeError> {
    const err = e as { code?: string; message?: string; details?: unknown };
    const message = err?.message ?? String(e);

    // ① 契约层封闭码集：原样透传
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
        // K-N1：失败站点与成功站点同型（双写点数==2，禁第三处硬编码 channel）
        principal: {
          host: 'vm-service',
          user: process.env['USERNAME'] ?? 'unknown',
          channel: req.channel ?? 'mcp',
        },
        capabilityId: req.capabilityId,
        risk: ctx.capabilities.get(req.capabilityId)?.risk ?? 'L3',
        params: req.params,
        // D-7（Phase 6 批18）：`matchedRule` 承载**规则名/事实名**，不承载错误码。
        // 原实现写 `matchedRule: error.code` ⇒ 链上出现 `matchedRule='EXECUTION_FAILED'`
        // （真机实证 seq=16），把「运行时失败」污染成「策略规则名」，与
        // `task-evict-audit` 的同族语义（matchedRule=事实陈述、allowed=许可判定）相悖，
        // 也会让任何按规则名前缀归因的消费方（如 `isScopeGateRejection`）读到噪声。
        // 错误语义由下一行 `result.errorCode` **独立**承载，二者不互相顶替。
        // 命名沿用 server.ts 既有 `runtime:<fact>` 约定（`runtime:provider-unavailable`）。
        policyDecision: { allowed: false, matchedRule: 'runtime:execution-failed' },
        result: { ok: false, errorCode: error.code, summary: error.message },
        durationMs,
        ...(req.delegationId
          ? { ext: { kind: 'inner-call' as const, delegationId: req.delegationId, channel: req.channel ?? 'a2a' } }
          : {}),
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

}

/** loader 约定导出：createProvider */
export function createProvider(options?: DeterministicProviderOptions): DeterministicAgentProvider {
  return new DeterministicAgentProvider(options ?? {});
}

export { riskAtLeast };

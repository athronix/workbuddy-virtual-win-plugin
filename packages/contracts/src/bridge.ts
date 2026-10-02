/**
 * 标准 Agent 服务桥接转换层 SPI（SPEC-AGENT-SERVICE-BRIDGE.md）
 *
 * 这是「VM 内 Agent 可替换」的核心契约：
 *   桥接层之上不知道下面是 LLM Agent 还是确定性执行器；
 *   桥接层之下不知道上面是 MCP 还是 A2A。
 */

import type { BridgeError } from './errors.js';
import type { CapabilityId, CapabilityPolicy } from './capability.js';
import type { RiskLevel } from './risk.js';
import type { AuditPrincipal, AuditRecord } from './audit.js';

/** A2A v1.0 任务状态 */
export type TaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'rejected';

export const TERMINAL_TASK_STATES: readonly TaskState[] = [
  'completed',
  'failed',
  'canceled',
  'rejected',
] as const;

export function isTerminalTaskState(s: TaskState): boolean {
  return TERMINAL_TASK_STATES.includes(s);
}

/** 会话健康状态 */
export type SessionState = 'healthy' | 'degraded' | 'unavailable' | 'black-screen';

export interface SessionHealth {
  readonly sessionId: number;
  readonly windowStation: string;
  readonly desktop: string;
  readonly interactive: boolean;
  readonly locked: boolean;
  readonly blackScreen: boolean;
  readonly state: SessionState;
  readonly detail?: string;
}

export type ProviderState = 'ready' | 'degraded' | 'unavailable';

/* ==================== CL-018 增量：可观测性（纯附加） ====================
 *
 * 铁律：以下类型**全部为纯附加**。`/health` 上缺席这些字段即为「旧版本行为」，
 * 旧调用方不传新参数 / 不读新字段时行为不变（对齐 CL-017 的增量约束）。
 */

/**
 * LLM 常驻会话状态（CL-018 C1）。
 *
 * - `stopped`  未启动（lazy：首次委派才拉起）
 * - `starting` 已 spawn，尚未收到首个 `system/init`（冷启动窗口内）
 * - `ready`    已就绪，可投喂多轮
 * - `degraded` 会话**当前**处于失败态（进程启动失败 / 异常退出且未恢复）；经 D11 后，
 *   会话被替换/终结（killChild）时会重置为 `stopped`，`degraded` 只反映当前、不再驻留历史
 * - `disabled` 超出重启上限或本机明确禁用（此后恒定回退单次 `-p`，不再尝试常驻）
 */
export type LlmSessionState = 'stopped' | 'starting' | 'ready' | 'degraded' | 'disabled';

/** 日志级别名（CL-018 C3）。与 `@winvm/core` 的 `LogLevel` 为同一字面量集。 */
export type LogLevelName = 'debug' | 'info' | 'warn' | 'error' | 'silent';

/** `/health.llmSession` 增量（CL-018 C1）。纯附加：缺席即旧行为。 */
export interface LlmSessionHealth {
  readonly state: LlmSessionState;
  /** 常驻子进程 PID（未启动时缺省） */
  readonly pid?: number;
  /** 累计自愈/重建次数（必须计数并暴露，禁止静默） */
  readonly restarts: number;
  /** 距上次投喂的毫秒数（从未使用时为 0） */
  readonly idleMs: number;
  /** 最近一次失败原因（仅失败后出现） */
  readonly lastError?: string;
  /**
   * D11：最近一次失败**发生时刻**（ISO 8601，与 `lastError` 成对出现）。
   *
   * 让「历史上失败过」（`lastError`/`lastErrorAt`）与「此刻是否健康」（`state`）两个信号分离：
   * 会话被替换/终结后 `state` 会重置为如实的「未运行/探测中」，而失败痕迹由本字段保留。
   */
  readonly lastErrorAt?: string;
}

/**
 * `/health.logging` 增量（CL-018 C3）。纯附加。
 *
 * `degraded=true` 表示日志目录不可写、已回退控制台/静默 —— **服务仍成功启动**
 * （AC3.5 硬要求），`reason` 给出降级原因。
 */
export interface LoggingHealth {
  readonly degraded: boolean;
  /** 目标日志目录（含 %ENV% 占位符已展开） */
  readonly dir: string;
  readonly level: LogLevelName;
  /** 降级原因（仅 degraded=true 时出现） */
  readonly reason?: string;
}

/** `/health.cache` 增量（CL-018 C5）。纯附加。 */
export interface CacheHealth {
  /** `system.network.config` 进程内缓存状态（启动预热 + 正常调用均刷新） */
  readonly netCfg?: {
    /** 是否已有可用缓存（预热或任一正常调用成功即 true） */
    readonly cached: boolean;
    /**
     * 缓存年龄（毫秒；无缓存为 -1）。
     *
     * CL-019 项①：语义为「自最近一次采集（PowerShell 回传的 `collectedAt`）起算的**真实缓存新鲜度**」，
     * 即 `now - Date.parse(collectedAt)`；不再使用「距进程启动预热时长」。字段名不变（零破坏）。
     */
    readonly ageMs: number;
    /** 生效 TTL（毫秒） */
    readonly ttlMs: number;
  };
}

export interface HealthStatus {
  readonly ok: boolean;
  readonly provider: { readonly id: string; readonly state: ProviderState; readonly detail?: string };
  readonly session: SessionHealth;
  readonly psBridge?: { readonly state: ProviderState; readonly uptimeMs: number; readonly pending: number };
  readonly capabilities?: { readonly count: number; readonly available: number };
  readonly audit?: {
    readonly entries: number;
    readonly chainValid: boolean;
    /** D30：断裂位置 seq（仅 chainValid=false 时透出，向后兼容字段恒保留） */
    readonly brokenAt?: number;
    /** D30：断裂原因（SEQ_DUP / SEQ_GAP / HASH_MISMATCH / CHAIN_BREAK） */
    readonly reason?: string;
  };
  /** CL-018 C1：LLM 常驻会话状态（纯附加，非 LLM provider 时缺席） */
  readonly llmSession?: LlmSessionHealth;
  /** CL-018 C3：日志落盘状态（纯附加） */
  readonly logging?: LoggingHealth;
  /** CL-018 C5：进程内缓存状态（纯附加） */
  readonly cache?: CacheHealth;
}

/** 产出物（A2A artifact / MCP artifacts） */
export interface Artifact {
  readonly kind: 'screenshot' | 'change-list' | 'console-log' | 'steps' | 'file';
  readonly name: string;
  readonly mime: string;
  /** base64（二进制）或原始文本/对象（结构化） */
  readonly data: string | Record<string, unknown>;
  readonly encoding?: 'base64' | 'utf8' | 'json';
}

/**
 * K5（纯附加可选）：被拦截调用的**真实意图**描述，供宿主审批卡片展示。
 *
 * 背景：A2A 委派里被审批闸拦截的能力往往是「外壳」（如 `appops.workflow.run`），
 * 人工真正要批准的是内层目标（goal 文本 / 真实参数）。缺席该字段时卡片只能看到外壳名，
 * 信息量不足以做人工判断（真机取证：`preview:{}` / `impact:[]` 空 → 卡片无可读内容）。
 */
export interface ApprovalUnderlying {
  /** 内层真实能力（若已知），如 `app.winget.uninstall` */
  readonly capabilityId: CapabilityId;
  /** 真实参数摘要（人类可读，已脱敏由调用方负责），如 `packageId=WXWork` */
  readonly paramsSummary?: string;
  /** 目标文本（workflow 场景 = 内层 goal），如「卸载 VM 企业微信」 */
  readonly goalText?: string;
}

export interface ApprovalRequest {
  readonly approvalId: string;
  readonly capabilityId: CapabilityId;
  readonly risk: RiskLevel;
  readonly summary: string;
  /** dry-run 预览：将影响什么 */
  readonly preview: Record<string, unknown>;
  readonly impact: readonly string[];
  /**
   * K5（纯附加）：被拦截调用的真实意图（外层能力是壳时尤其重要）。
   * 缺席即旧行为（卡片只显示 capabilityId/summary）。
   */
  readonly underlying?: ApprovalUnderlying;
}

/**
 * K5：能力**真实执行**的结构化回执 —— 由服务端重放（replay）产生，不是 LLM 文本。
 *
 * 核心不变式：A2A 任务是否完成，**只以本回执为准**；LLM 自称完成不构成完成证据。
 */
export interface ExecutedResult {
  readonly ok: boolean;
  readonly capabilityId: string;
  /** 人类可读结果摘要（成功=做了什么；失败=为什么没做成） */
  readonly summary: string;
  /** 失败原因（ok=false 时给出） */
  readonly error?: string;
}

/**
 * K5：审批协调器 `raise` 的结果（判别联合）。
 *
 * - `approved:false` —— 拒绝 / TTL 超时 / 无挂接任务，语义与 K3/K4 完全一致：
 *   桥保持「等待审批」（ok=false），**绝不自批**。
 * - `approved:true`  —— 宿主已批准，且（`WINVM_APPROVAL_REPLAY=on` 时）**服务端已确定性重放**
 *   被拦截的原调用，`executed` 为真实执行回执。
 *   `executed` 缺席（可选）= 灰度开关 off 或未注入 replay → 退回 K4「提示词让 LLM 重发」行为。
 */
export type ApprovalOutcome =
  | { readonly approved: false; readonly reason: 'rejected' | 'timeout' | 'no-active-task' }
  | { readonly approved: true; readonly executed?: ExecutedResult };

export interface CapabilityRequest {
  readonly traceId: string;
  readonly capabilityId: CapabilityId;
  /** 已通过 input schema 校验 */
  readonly params: Record<string, unknown>;
  readonly risk: RiskLevel;
  /** 是否已过审批闸 */
  readonly approved: boolean;
  readonly approvalId?: string;
  readonly timeoutMs: number;
  /**
   * K-N1（**纯附加可选**）：调用通道。provider 审计落 `principal.channel` 时按
   * `req.channel ?? 'mcp'` 取值 —— 委派内层回连调用经 `/mcp?dtid=` 注入后真实记 `a2a`，
   * 纯宿主直调仍为 `mcp`（修掉「181/181 恒 mcp」的观测缺陷）。缺席即旧行为。
   */
  readonly channel?: AuditPrincipal['channel'];
  /**
   * K-N1（**纯附加可选**）：所属委派的 traceId（设计 §2.3 通道 2 精确归因）。
   * 存在时 provider 审计条目写 `ext: { kind:'inner-call', delegationId, channel }`。
   */
  readonly delegationId?: string;
}

export interface CapabilityResult {
  readonly traceId: string;
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: BridgeError;
  readonly artifacts?: readonly Artifact[];
  readonly durationMs: number;
  readonly auditRef?: string;
}

export interface GoalRequest {
  readonly traceId: string;
  /** 自然语言目标 */
  readonly goal: string;
  readonly context?: Record<string, unknown>;
  /** 本次委派允许的能力范围（最小权限） */
  readonly allowedCapabilities?: readonly CapabilityId[];
  /** 本次委派允许的最高风险（默认 L1） */
  readonly maxRisk?: RiskLevel;
  /** A2A 委派任务 id（由 A2A 框架在 runGoal 前注入，供审批协调器挂接 input-required） */
  readonly taskId?: string;
  readonly timeoutMs: number;
}

export interface GoalStep {
  readonly index: number;
  readonly capabilityId: CapabilityId;
  readonly params: Record<string, unknown>;
  readonly ok: boolean;
  readonly risk: RiskLevel;
  readonly durationMs: number;
  readonly traceId: string;
  readonly summary?: string;
  readonly error?: BridgeError;
}

export interface GoalResult {
  readonly ok: boolean;
  readonly summary: string;
  readonly artifacts: readonly Artifact[];
  /** 逐步执行记录 —— 破除"委派黑盒"（NFR-509） */
  readonly steps: readonly GoalStep[];
  readonly error?: BridgeError;
}

export interface ProgressSink {
  onStatus(state: TaskState, message?: string): void;
  onArtifact(artifact: Artifact): void;
  /** 阻塞式审批；返回 false 表示拒绝，实现必须中止 */
  onApprovalRequired(req: ApprovalRequest): Promise<boolean>;
}

/**
 * K4/K5 审批协调器：桥接层与 A2A 任务状态机之间的审批闸桥。
 *
 * 纯附加可选契约：VM 内 Agent（bridge）在命中宿主审批拦截时，经 `raise` 把任务挂起为
 * input-required 并等待宿主人工决议；宿主批准前，续跑令牌（pendingApprovals 中的 token）
 * 必须保持 `hostApproved=false`，绝不可被 `/mcp` 能力层放行（杜绝「不记名令牌」漏洞）。
 *
 * K5：`raise` 返回值由 `Promise<boolean>` 升级为 `Promise<ApprovalOutcome>` ——
 * 执行权收归服务端：宿主批准后由协调器**在服务进程内**用留存的原参数确定性重放被拦截的
 * 能力调用，把**真实执行回执**（`executed`）随决议一并返回，桥不再依赖 LLM 是否"愿意重发"。
 *
 * 非 A2A 场景（纯 MCP 直调 / 单测）不注入协调器，桥接层行为完全不变。
 */
export interface ApprovalCoordinator {
  /** 进入一个委派任务（记录当前 taskId，供 raise 挂接） */
  beginTask(taskId: string): void;
  /** 离开一个委派任务（清空当前 taskId） */
  endTask(): void;
  /**
   * 发出 input-required（挂起任务）并等待宿主决议；宿主批准后由**服务端重放**原调用。
   * 实现必须把对应续跑令牌标记为「待宿主批准（hostApproved=false）」，宿主经 A2A
   * `approval.reply` 批准后才置 true 并重放；重放结束（成功或失败）后令牌**一次性消费删除**。
   * 拒绝 / TTL 超时 / 无挂接任务 → `{ approved:false, reason }`，绝不放行。
   */
  raise(req: ApprovalRequest): Promise<ApprovalOutcome>;
}

export interface AuditSink {
  append(record: Omit<AuditRecord, 'hash' | 'prevHash' | 'seq'>): Promise<AuditRecord>;
  /** D30：reason 为断裂原因（SEQ_DUP / SEQ_GAP / HASH_MISMATCH / CHAIN_BREAK），valid=false 时有值 */
  verifyChain(): Promise<{ valid: boolean; brokenAt?: number; reason?: string; entries: number }>;
}

export interface PolicyVerdict {
  readonly allowed: boolean;
  readonly matchedRule: string;
  readonly requiresApproval: boolean;
  readonly error?: BridgeError;
}

export interface PolicyEvaluateInput {
  readonly capabilityId: CapabilityId;
  readonly params: Record<string, unknown>;
  readonly risk: RiskLevel;
  readonly approved: boolean;
  readonly approvalId?: string;
  readonly maxRisk?: RiskLevel;
  readonly allowedCapabilities?: readonly CapabilityId[];
  /** 能力自带策略覆盖 */
  readonly capabilityPolicy?: CapabilityPolicy;
}

export interface PolicyEngine {
  evaluate(req: PolicyEvaluateInput): PolicyVerdict;
}

export interface CapabilityRegistryView {
  get(id: CapabilityId): { readonly risk: RiskLevel; readonly requiresSession: boolean } | undefined;
  list(): readonly CapabilityId[];
  has(id: CapabilityId): boolean;
}

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * ps-bridge 常驻进程客户端句柄（由 L2 `@winvm/vm-capabilities` 实现）。
 *
 * 为什么在契约层只声明「最小形状」：服务端（vm-service）与 provider 需要共享**同一个**
 * ps-bridge 单例进程，否则会各起一个实例、双跑心跳看门狗，导致进程翻倍与健康态自相矛盾
 * （CL-017 D1）。契约层不能反向依赖 L2，故仅声明 provider 实际用到的成员。
 */
export interface BridgeHandle {
  readonly running: boolean;
  readonly uptimeMs: number;
  start(): Promise<void>;
  stop(): Promise<void>;
  call<T = unknown>(
    module: string,
    fn: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T>;
  health(): {
    readonly state: 'ready' | 'down';
    readonly uptimeMs: number;
    readonly pending: number;
    readonly lastHeartbeatAgoMs: number;
    /** 累计自愈/重启次数（CL-017 D2，纯增量） */
    readonly restarts?: number;
    /** 最近一次自愈/重启失败原因（CL-017 D2，纯增量） */
    readonly lastError?: string;
  };
}

export interface BridgeContext {
  readonly config: Record<string, unknown>;
  readonly audit: AuditSink;
  readonly policy: PolicyEngine;
  readonly capabilities: CapabilityRegistryView;
  readonly logger: Logger;
  /**
   * K4（纯附加可选）：A2A 审批协调器。VM 服务注入后，桥接层命中宿主审批拦截时经它
   * 把任务挂起为 input-required 并等待宿主人工决议；缺席即旧行为（纯 MCP / 单测）。
   */
  readonly approvalCoordinator?: ApprovalCoordinator;
  /**
   * 服务侧注入的 ps-bridge 单例（CL-017 D1）。
   * provider 必须优先复用它；仅当未注入（非 Windows / 单测）时才允许自建，避免进程翻倍。
   */
  readonly bridge?: BridgeHandle;
  newTraceId(): string;
}

/** 提供者类型 */
export type ProviderKind = 'deterministic' | 'llm-agent' | 'remote-proxy' | 'custom';

/**
 * 所有 VM 内 Agent 实现必须实现的接口。
 * V1: adapter-agent-workbuddy（确定性执行器）
 */
export interface AgentServiceProvider {
  readonly id: string;
  readonly displayName: string;
  readonly kind: ProviderKind;

  /** 声明本实现能提供的能力。支持 `domain.*` 通配。不得声明未实现的能力。 */
  declareCapabilities(): readonly CapabilityId[];

  init(ctx: BridgeContext): Promise<void>;
  execute(req: CapabilityRequest): Promise<CapabilityResult>;
  runGoal(goal: GoalRequest, sink: ProgressSink): Promise<GoalResult>;
  health(): Promise<HealthStatus>;
  shutdown(): Promise<void>;

  /**
   * K2 修复（**纯附加可选成员**）：VM 服务启动后 fire-and-forget 预热 LLM 常驻会话，
   * 消除 A2A 冷启动停滞（首个真实委派免付 codebuddy 进程级冷启动 ≈75–107s）。
   *
   * 仅 LLM provider（`kind='llm-agent'`）实现；非 LLM provider 无须实现，缺席即旧行为。
   * 调用方（vm-service server.ts）以 `void provider.warmup?.()` 触发，**不阻塞启动**；
   * 实现内部须自行捕获异常，失败只记日志、绝不抛到启动链路。
   */
  warmup?(): Promise<void>;

  /**
   * CL-018 C1（**纯附加可选成员**）：LLM 常驻会话健康快照。
   *
   * 为什么放在 SPI 而非只经 `health()`：`/health` 对 `provider.health()` 施加了 5s 短超时护栏
   * （见 vm-service health-probe），而 `provider.health()` 内部会跑 20s 级会话探针 —— 超时降级快照
   * 里就**没有** `llmSession`。把会话态做成独立同步取值，使 `/health.llmSession` 不受该护栏影响。
   *
   * 非 LLM provider（确定性执行器 / hermes 等）**无须实现**：缺席即旧行为。
   */
  llmSessionHealth?(): LlmSessionHealth | undefined;

  /**
   * L1（**纯附加可选成员**）：把常驻会话从 `disabled` 永久态复位 —— 杀子进程、
   * `spawnAttempts` 归零（累计制计数由此解开）、state 回 `stopped`、**保留** `lastError/lastErrorAt`
   * （D11 两信号分离纪律）。由 `POST /admin/llm-session/reset` 调用。
   *
   * 非 LLM provider / 未启用常驻 → 返回 undefined（视为「无可复位对象」，端点如实返回）。
   */
  llmSessionReset?(): LlmSessionHealth | undefined;

  /**
   * L1（**纯附加可选成员**）：注入 / 清除「每次 spawn 立即失败」故障钩子，供 K-N1 确定性回归。
   * 仅管理端点在 `WINVM_ADMIN_ENDPOINT=1` 且 `?faultInjection=1` 时调用；生产路径永不触达。
   */
  llmSessionInjectFault?(on: boolean): boolean;
}

/* ==================== K-N1 增量：委派真实性探针（纯附加） ==================== */

/** 委派回合的服务端活动计数（账本口径：executed + blocked + wild）。 */
export interface DelegationActivityCount {
  /** 三通道合计（判定「零活动」的唯一依据） */
  readonly total: number;
  readonly executed: number;
  readonly blocked: number;
  readonly wild: number;
}

/**
 * K-N1：委派真实性探针 —— 桥在收口处反查「本委派回合服务端是否真的有过活动」的**唯一**接口。
 *
 * 为什么是注入的 interface 而非直接依赖 vm-service：依赖方向必须保持
 * `vm-service → adapter`（provider/桥**不认识**服务端实现，实现在 server.ts 侧经 cast 注入）。
 * 桥侧对本探针 **fail-open**：抛错即透传 base + warn，绝不因取证故障挂死委派
 * （对齐 approval-replay「写失败不影响拦截结果」纪律）。
 */
export interface DelegationTruthProbe {
  /** 查询该委派回合的真实活动证据（按委派 traceId） */
  delegationActivity(delegationTraceId: string): Promise<DelegationActivityCount>;
}

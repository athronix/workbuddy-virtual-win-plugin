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

/** `/health.security` 增量（ARCH-07 A2 **纯附加**）。让「信任模型是什么」成为机器可读事实。 */
export type AuthMode = 'loopback-only' | 'bearer-enforced' | 'bearer-configured-missing';

/**
 * `/health.security` 增量（ARCH-07）。纯附加：缺席即旧行为（旧服务端不报）。
 *
 * 为什么必须透出（体检 U-P0-2 / D-10）：V1 的安全推理大量**以部署形态为公理**
 * （「仅回环 + SSH 隧道 + 审批闸」），而代码过去不保证其中任何一项。本块把生效事实
 * 而不是配置意图如实报出，运维与宿主可据此判断当前信任边界，而不是读文档猜测。
 *
 * 三态 `authMode` 判据（与 `enforceBearer` 生效条件同构，见 §8 O-9 双条件纪律）：
 * - `loopback-only` —— 未开 `enforceBearer`（默认）⇒ 服务端**不承担身份鉴权**，
 *   信任边界 = 回环绑定 + SSH 隧道（SECURITY-GOVERNANCE §2 已声明）。
 * - `bearer-enforced` —— `enforceBearer===true` **且** `process.env[tokenEnv]` 非空 ⇒ 守卫真生效。
 * - `bearer-configured-missing` —— 开了 `enforceBearer` 或配了 `tokenEnv`，但**环境无值**
 *   ⇒ 守卫不生效（"以为开了"）。这是一个**必须显形**的降级态，不得静默当作 enforced。
 */
export interface SecurityHealth {
  /** 服务端是否只允许回环绑定（V1 恒 true —— 该约束已不可关） */
  readonly loopbackOnly: boolean;
  /** 本次运行**实际**绑定的地址是否回环 */
  readonly boundLoopback: boolean;
  /** 当前生效的鉴权模式（事实，不是配置意图） */
  readonly authMode: AuthMode;
  /**
   * 类型级负空间标记：V1 **没有**端点白名单配置（豁免清单硬编码 `/health` 与
   * `/.well-known/agent-card.json` 两项并在文档中声明）。声明为 `never` ⇒ 任何实现
   * 试图经 `/health` 报出「可配端点白名单」即编译失败，防止承诺漂移。
   */
  readonly endpointAllowlist?: never;
  /**
   * Phase 2 · P2-T5（**纯附加可选**）：bearer 守卫**挂载逻辑自检**结论。
   *
   * 病灶（设计 §2.1，B3 真机实证）：`authMode` 只回答「配置意图+env 有值」，它**不能**
   * 回答「守卫代码是否真的在拒绝」。误开 `enforceBearer` 的危害形态是两段式的（宿主段
   * 当场 401 / VM 内回连段 401 打在工具面 ⇒ 委派零副作用虚假完成），根因是缺「守卫是否
   * 真的生效」这一事实。本字段把启动期的同进程正/反例求值结论（无凭据必 deny、正确
   * 凭据必 pass）机器可读地透出；守卫未挂载时为 `not-mounted`（**透出但绝不据此拒启**）。
   *
   * 缺席即旧形状（K-13 纯附加：旧读者忽略未知字段）。类型故意是本模块内的**结构子集**
   * （`vm-service/http-guard.ts` 的 `BearerSelfCheckHealth` 与之逐字段同形，避免
   * contracts → vm-service 的反向依赖）。
   */
  readonly bearerSelfCheck?: {
    readonly code:
      | 'not-mounted'
      | 'mounted-pass'
      | 'mounted-fail-guard-always-allow'
      | 'mounted-fail-guard-rejects-correct-token'
      | 'mounted-evaluator-absent';
    readonly ok: boolean;
    readonly reason: string;
  };
  /**
   * Phase 2 · P2-T5（**纯附加可选**）：VM 内回连（codebuddy CLI → 本服务 `/mcp?dtid=`）
   * 通路可用性三态。**必须能表达「未验证」**（设计 §2.2 判据 2 与 F5 E-2 同族纪律 ——
   * 探针自身不可达/超时绝不冒充 `broken`，否则 PR3 风险成真：服务因探针起不来）。
   *
   * 现况（诚实口径）：回连凭据分发通路属 P2-T6，未实现 ⇒ 守卫挂载时本判定如实报
   * `broken`（回连不带凭据必 401）；守卫未挂载时恒 `unverified`（只观测不改判）。
   */
  readonly innerReconnect?: {
    readonly status: 'ok' | 'broken' | 'unverified';
    readonly reason: string;
  };
}

/** `/health.tasks` 增量（ENG-08 **纯附加**）。长跑资源有界性的可观测面。 */
export interface TasksHealth {
  /** 当前 TaskStore 内存活任务数（= `size()`） */
  readonly live: number;
  /** 生效上限（`0` / 缺席 ⇒ 不设限，即旧行为） */
  readonly maxTasks?: number;
  /** 终态任务的驻留 TTL（毫秒；缺席 ⇒ 未启用过期驱逐） */
  readonly terminalTtlMs?: number;
  /**
   * Phase 2 · P2-T7（L1，**纯附加可选**）：本轮运行以来**累计被驱逐的任务条数**
   * （= `TaskStore.evictedCount()`，单调不减）。
   *
   * 为什么需要它：`live/maxTasks` 只能看出「快到顶了」，看不出「已经回收了多少」——
   * QA-REPORT §4-B4 / L1 的病灶正是驱逐这件事在宿主侧完全不可见，被逐 id 再查
   * `tasks/get` 也与「从未存在的 id」不可区分。本键把「回收确实发生了、发生了多少次」
   * 变成机器可读事实，与链上 `ext.kind:'task-evicted'` 聚合互为对账面。
   *
   * 缺席即旧行为（旧服务端不报 ⇒ 旧读者零感知）；驱逐关闭（`maxTasks:0` 等回退位）⇒ 恒 `0`。
   */
  readonly evictedCount?: number;
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
    /**
     * ARCH-06 A2（**纯附加可选**）：本次 `chainValid` 结论**校验了什么范围**。
     *
     * 病灶：服务端硬编码 `freshChainOnStart: true`，而 `verifyChain` 在该模式下**只读本轮
     * `activeShards`** ⇒ 历史分片永久退出校验面，但 `/health.audit` 只报一个 `chainValid`
     * 布尔，把「校验了什么」藏起来了（体检 U-P0-2：权衡未登记、结论易被误读为
     * 「全部历史证据有效」）。本字段把这个范围差**变成显式事实**：
     * - `'session'` = 仅本轮运行期（freshChain 模式）；
     * - `'full'`    = 目录下全部分片。
     * 跨轮历史的证据由启动期归档校验条目（`ext.kind:'chain-archive-verify'`）提供，
     * 而不是由 `chainValid` 冒充。
     */
    readonly scope?: 'session' | 'full';
    /** 参与本次判定的分片数 */
    readonly shardsVerified?: number;
    /** 目录下全部分片数 */
    readonly shardsTotal?: number;
    /** 未参与本次判定的分片数（= shardsTotal − shardsVerified，恒 ≥0） */
    readonly shardsArchived?: number;
  };
  /** CL-018 C1：LLM 常驻会话状态（纯附加，非 LLM provider 时缺席） */
  readonly llmSession?: LlmSessionHealth;
  /** CL-018 C3：日志落盘状态（纯附加） */
  readonly logging?: LoggingHealth;
  /** CL-018 C5：进程内缓存状态（纯附加） */
  readonly cache?: CacheHealth;
  /** ARCH-07：信任边界事实（纯附加；旧服务端不报 ⇒ 缺席） */
  readonly security?: SecurityHealth;
  /** ENG-08：TaskStore 有界化事实（纯附加；未启用驱逐时 `maxTasks` 缺席） */
  readonly tasks?: TasksHealth;
  /**
   * CL-K3R E-3：审批真值判据运行时模式（纯附加；非 LLM provider 缺席）。
   *
   * 为什么是三元组而非只给 mode：shadow 轮未命中时，`[shadow] 未决审批结构化命中`
   * 指纹不出现，仅凭 mode 无法区分「shadow 且未命中」与「根本没启用」（违反「未复现≠已修、
   * 必须确定性注入」）。`enabled` / `shadow` 两个布尔把桥构造期解析的**生效值**原样透出，
   * 与 `mode` 互为冗余校验（假指纹即不一致）。取值纪律：必须在构造 bridge 时一次性解析
   * （消费方禁止在 health() 里二次读 process.env，否则配置值≠生效值）。
   */
  readonly approvalTruth?: {
    readonly mode: 'on' | 'shadow' | 'off';
    readonly enabled: boolean;
    readonly shadow: boolean;
  };
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
  /**
   * K5（纯附加可选）：本次审批**归属**的 A2A 委派任务 id。
   *
   * 由桥从 `LlmGoalInput.taskId` 注入（见 adapter `bridge.ts` `maybeResume` 构造 `req` 处）。
   * 缺席 ⇒ 协调器回退到 `beginTask` 记录的服务级单例（**旧行为逐字不变**）。
   *
   * 存在时协调器**优先用它**挂 `input-required`，不再依赖共享单例 `activeTaskId`
   * —— 这是根治 P1 的关键：并发委派不再互相清场（根因 §3.1 / §5.2）。
   */
  readonly taskId?: string;
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
  /**
   * ARCH-29（P2-T4，**纯附加可选**）：宿主 HTTP 断连的中止信号（与 `ToolContext.signal` 同源）。
   *
   * 通路：`/mcp` 路由侦测到响应流 `close` 且未正常写完 ⇒ 框架灌进 `ToolContext.signal`
   * ⇒ MCP handler 交给你（`provider.execute`）⇒ provider 交给 ps-bridge 的 per-call signal。
   * A2A 委派通道**不经本字段**（那边由 `ProgressSink.isCancelled` / `cancellationSignal` 承载，
   * 两通道取消口径见 `docs/02-design/SECURITY-GOVERNANCE.md` §2.2）。
   *
   * 消费纪律（与 `ToolContext.signal` 逐字同口径，不得自行加码）：
   *  - **缺席即旧行为**：stdio / 单测 / A2A 委派 ⇒ 本键根本不注入；
   *  - **协作式中止**：只中止本地等待与后续副作用发起；VM 内已下发的命令无法强杀
   *    （cmd.exe 家族无信号透传），任何「已终止 VM 内进程」式表述都是不实陈述；
   *  - 收口码一律 `TASK_CANCELED`（**不得**折叠成 `EXECUTION_FAILED` —— 后者会被
   *    LLM 层的 `shouldDegrade` 判定为「运行时不可用」而回落**重跑**已叫停的操作）。
   */
  readonly signal?: AbortSignal;
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
  /**
   * K-N1 §4.4（**纯附加可选**）：本次委派是否走过「常驻会话不可用 → 单次 -p」降级，
   * 以及降级原因。设计把它放在桥的 `LlmGoalResult` 上；但壳 `delegation.complete` 审计
   * 由服务端 **delegation observer** 落（它只看得见 `GoalResult`，看不见桥内类型），
   * 故契约层同步补一个可选字段承载该事实 —— provider 在映射处透传（T03）。
   * 缺席即旧行为（不改动任何既有构造点）。登记为实现偏差。
   */
  readonly degraded?: { readonly reason: string };
}

export interface ProgressSink {
  onStatus(state: TaskState, message?: string): void;
  onArtifact(artifact: Artifact): void;
  /** 阻塞式审批；返回 false 表示拒绝，实现必须中止 */
  onApprovalRequired(req: ApprovalRequest): Promise<boolean>;
  /**
   * ARCH-22（**纯附加可选**）：宿主是否已请求取消本任务。
   *
   * 背景（病灶）：`tasks/cancel` 过去只置任务记录上的**取消标志位**，而该标志位
   * **全仓零读取**（静态守卫 `r19c-a5-approval-coordinator.test.js` C3 钉死其出现点，
   * 本注释刻意不复述该字段名以免污染该判据）⇒ 取消是外观性的：执行体照跑到底，
   * 宿主 UI 却显示「未执行任何变更」。
   * 本成员把取消从「抢占」改为**协作式**：框架提供信号，执行体在**每个可安全中断的能力边界**
   * 主动轮询并退出（框架不拥有执行体，provider 可替换 ⇒ 只能走契约化通路，
   * 与 `DelegationObserver` / `bypassTagSink` 的回调注入范式同构）。
   *
   * 缺席即旧行为（第三方 provider 不实现 ⇒ 退回外观性取消）；但框架层的 artifact 终态守卫
   * 与链上 `canceled` 终态**无条件生效**（证据面矛盾即被消除，不依赖 provider 是否配合）。
   * 消费纪律：判定用严格等值（`sink.isCancelled?.() === true`），返回真值即应停止后续副作用，
   * 并以 `makeError('TASK_CANCELED', …)`（`ok:false`）收口，**不得**静默返回成功。
   */
  isCancelled?(): boolean;
  /**
   * ARCH-22（**纯附加可选**）：取消信号，供**能 kill 子进程**的执行体消费
   * （常驻 LLM 会话的 `abortActiveTurn` / 单次 `-p` 子进程的 `ChildProcess` signal）。
   *
   * 与 `isCancelled()` 同源（同一个 `AbortController`）：`isCancelled` 面向「轮询」，
   * 本字段面向「事件」。二者都可选 ⇒ 旧 provider 一个都不实现也不破坏编译。
   * 缺席即旧行为。**禁止**用 `undefined` 显式写入任何 sink 字面量（附加成员一律条件展开）。
   */
  cancellationSignal?: AbortSignal;
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
  /**
   * 进入一个委派任务（记录当前 taskId，供 raise 挂接）。
   *
   * @deprecated P1-Fix：Fix-1B 之后归属信息已由 `ApprovalRequest.taskId` 随审批请求携带，
   * 单例仅作「`taskId` 缺席」时的兼容兜底，不再是判定的唯一依据。**本迭代不删除**；
   * `endTask` 同理。二者退化为兼容保留接口，语义见 SK-2。
   */
  beginTask(taskId: string): void;
  /**
   * 离开一个委派任务（清空当前 taskId）。
   *
   * P1-Fix（**纯附加可选**）：`taskId` 非空时按**归属**释放 —— 仅当它等于协调器当前记录的
   * 活动任务 id 才清空；不相等 ⇒ 本次收尾**不属于**当前活动任务（并发委派交叠），
   * 保持不动，绝不误清他人（根因见 a5-approval-drop-rootcause.md §3.1）。
   *
   * `taskId` 缺席（`undefined`）或空串 `''` ⇒ **旧行为逐字不变**：无条件清空
   * （调用方没有归属信息，协调器无从判断，只能按 K4 原语义释放）。
   *
   * @deprecated 与 `beginTask` 同：Fix-1B 之后退化为兼容保留接口，**本迭代不删除**。
   */
  endTask(taskId?: string): void;
  /**
   * 发出 input-required（挂起任务）并等待宿主决议；宿主批准后由**服务端重放**原调用。
   * 实现必须把对应续跑令牌标记为「待宿主批准（hostApproved=false）」，宿主经 A2A
   * `approval.reply` 批准后才置 true 并重放；重放结束（成功或失败）后令牌**一次性消费删除**。
   * 拒绝 / TTL 超时 / 无挂接任务 → `{ approved:false, reason }`，绝不放行。
   */
  raise(req: ApprovalRequest): Promise<ApprovalOutcome>;
}

/**
 * ARCH-06 A2（**契约层新增**）：单个**历史归档分片**的片内链校验结论。
 *
 * 为什么定义在 `contracts`（L0）而不是设计图标注的 `core/audit/chain.ts`（L1a）：
 * `AuditSink.verifyArchive()` 是本契约的成员，其返回形状若引用 L1a 类型就形成
 * contracts → core 的反向依赖（违反 §8「依赖方向不可逆」铁律）。登记为实现偏差 D-4；
 * `core` 侧（T2）以 `export type { ArchiveVerification }` 从本包**再导出**同一类型，
 * 全仓保持**单一权威定义**，不得出现第二份同形结构。
 */
export interface ArchiveVerification {
  /** 分片文件名（相对审计目录） */
  readonly shard: string;
  /** 该片记录条数 */
  readonly entries: number;
  /** 片内链是否完整 */
  readonly valid: boolean;
  /** 断裂处 seq（valid=false 时有值） */
  readonly brokenAt?: number;
  /** 断裂原因（与 `verifyChain` 的 reason 同一取值集：SEQ_DUP / SEQ_GAP / HASH_MISMATCH / CHAIN_BREAK） */
  readonly reason?: string;
}

export interface AuditSink {
  append(record: Omit<AuditRecord, 'hash' | 'prevHash' | 'seq'>): Promise<AuditRecord>;
  /**
   * D30：reason 为断裂原因（SEQ_DUP / SEQ_GAP / HASH_MISMATCH / CHAIN_BREAK），valid=false 时有值。
   *
   * ARCH-06 A2（**纯附加可选**）：`scope` / `shardsVerified` / `shardsTotal` / `shardsArchived`
   * 四字段透出「本次结论校验了什么范围」，与 `HealthStatus.audit` 同名同义（服务端直接透传）。
   * 缺席即旧行为；**判定逻辑不因这些字段改变**（只是将既有事实显式化，非行为变更）。
   */
  verifyChain(): Promise<{
    valid: boolean;
    brokenAt?: number;
    reason?: string;
    entries: number;
    /** ARCH-06 A2：'session' = 仅本轮运行期分片；'full' = 目录下全部分片 */
    scope?: 'session' | 'full';
    /** 参与判定的分片数 */
    shardsVerified?: number;
    /** 目录下全部分片数 */
    shardsTotal?: number;
    /** 未参与判定的归档分片数（= shardsTotal − shardsVerified） */
    shardsArchived?: number;
  }>;
  /**
   * ARCH-06 A2（**纯附加可选**）：对**历史归档分片**逐片做「片内 seq 单调 + 片内 prevHash 链式」
   * 校验，返回每片结论。跨片首条 prevHash **不比对**（历史片与新片本无链关系 ⇒ 比对必全红）。
   *
   * 为什么是可选成员而不是必选：框架/消费方不得假设服务端一定具备归档校验能力
   * （旧 sink / 内存 sink / 单测桩实现无须补齐）。缺席即「未实现」，调用方**必须**用
   * `sink.verifyArchive?.()` 取值并按 `undefined` 如实处理，**不得**当作「校验通过」。
   * 实现侧纪律：有界（最多处理 `maxShards`，默认 30，超出只计数不校验）、全程 try/catch、
   * **绝不抛**（`/health` 与启动链路都可能经它，取证不得拖垮执行）。
   */
  verifyArchive?(maxShards?: number): Promise<readonly ArchiveVerification[]>;
}

export interface PolicyVerdict {
  readonly allowed: boolean;
  readonly matchedRule: string;
  readonly requiresApproval: boolean;
  readonly error?: BridgeError;
}

/**
 * U-P0-3（A1）：dry-run 免批放行规则的**唯一哨兵值**（`PolicyVerdict.matchedRule` 取值之一）。
 *
 * 为什么提为常量（而不是各处写 `'allow:dry-run-bypass'` 字面量）：这条规则被三方读取 ——
 * ① 策略引擎产出；② 服务端审计装饰器据此落 `ext.bypass='dry-run'` 取证位；
 * ③ 单测与运维 grep。任一处拼写漂移都会让「免批执行」静默失去链上证据，
 * 而这条旁路正是审批闸上唯一的放行出口（体检 U-P0-3 / §2-QA-11）。
 */
export const POLICY_DRY_RUN_BYPASS_MATCHED_RULE = 'allow:dry-run-bypass';

/** U-P0-3（A1）：审批闸拦截的哨兵值（与 `recordBlockedApprovalAudit` 写入的 matchedRule 同源） */
export const POLICY_APPROVAL_REQUIRED_MATCHED_RULE = 'approval-required';

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

/**
 * 能力注册表的**只读投影**（策略引擎等下游按最小面消费，不得反向依赖 L2 注册表实现）。
 *
 * U-P0-3（A1 **纯附加**）：`supportsDryRun?` —— dry-run 免批的**服务端声明位**
 * （权威语义见 `capability.ts` 中 `CapabilityDefinition.supportsDryRun` 的文档）。
 * 缺席/假一律视为「不支持」，策略引擎据此 fail-closed 回落审批闸。
 */
export interface CapabilityRegistryView {
  get(
    id: CapabilityId,
  ):
    | {
        readonly risk: RiskLevel;
        readonly requiresSession: boolean;
        readonly supportsDryRun?: boolean;
      }
    | undefined;
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

  /**
   * CL-K3R（**纯附加可选成员**）：反查「本委派回合内是否仍有**未决**审批」。
   *
   * 与 `delegationActivity` 同源：桥在收口处用它替代/补强「LLM 文本是否说等待审批」的启发式
   * （根因 `APPROVAL_WAIT_PATTERN` 仅作兜底）。返回空集 ⇒ 桥回退文本启发式（旧行为逐字不变）。
   *
   * 缺席（旧服务端 / 单测 / degraded）⇒ 桥侧 `undefined` 检查后**完全退回 R19F 后现状**（fail-open），
   * 既不影响既有实现方（不强制实现），也不影响既有消费方。
   */
  approvalWait?(q: ApprovalWaitQuery): Promise<readonly PendingApprovalFact[]>;
}

/** CL-K3R：未决审批反查的入参（全部为服务端可得/桥可推算的事实） */
export interface ApprovalWaitQuery {
  /** 本委派 traceId（= `GoalRequest.traceId`，账本/令牌表键） */
  readonly delegationTraceId: string;
  /** 委派回合开始时刻（ms，= `RunContext.started`）—— R3 时间窗归因下界 */
  readonly startedAtMs: number;
  /**
   * 委派能力面（`LlmGoalInput.capabilities` = `GoalRequest.allowedCapabilities`）。
   * 非空 ⇒ 只认落在能力面的未决审批（R3 收窄串台）；空/缺席 ⇒ 不按能力过滤。
   */
  readonly capabilities?: readonly string[];
}

/** CL-K3R：一条未决审批的结构化事实（服务端权威，桥据以改判「等待审批」） */
export interface PendingApprovalFact {
  readonly approvalId: string;
  readonly capabilityId: CapabilityId;
  /** 服务端策略引擎判定值（顺带根治 `parseApprovalBlock` 的文本正则扣 risk） */
  readonly risk: RiskLevel;
  readonly createdAtMs: number;
  /** 归因方式：'exact' = dtid 精确（单次 -p 路径）/ 'window' = 时间窗兜底（常驻路径） */
  readonly attribution: 'exact' | 'window';
  /** 恒 false（探针只返回未决项；已批准/超时已被服务端 delete） */
  readonly hostApproved: boolean;
  /** 服务端可读摘要（preview/underlying 派生），供审批卡与日志 */
  readonly summary?: string;
}

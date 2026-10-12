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
  type ApprovalOutcome,
  type ApprovalRequest,
  type ApprovalUnderlying,
  type ApprovalWaitQuery,
  type Artifact,
  type BridgeContext,
  type CacheHealth,
  type CapabilityDefinition,
  type CapabilityId,
  type ExecutedResult,
  type GoalRequest,
  type HealthStatus,
  type LoggingHealth,
  type PendingApprovalFact,
  type PolicyVerdict,
  type ProgressSink,
  type RiskLevel,
  type SecurityHealth,
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
  resolveApprovalReplay,
  resolveApprovalTtlMs,
  resolveNetCfgTtlMs,
  resolveNetCfgPrewarmTimeoutMs,
  resolveEnforceBearerFailClosed,
  resolveServiceConfig,
  validateServiceConfig,
  type FileLogger,
  type ServiceConfig,
} from '@winvm/core';
import { A2AServer, TaskStore, type DelegationObserver, type DelegationTerminalSnapshot } from '@winvm/a2a-framework';
import { McpServer, type McpTool, type McpToolResult } from '@winvm/mcp-framework';
import { WINDOWS_CAPABILITIES, PsBridgeSessionProbe, createWindowsRuntime } from '@winvm/vm-capabilities';
import { raceHealthSubProbes, resolveHealthProbeTimeoutMs, resolvePsBridgeHealthState } from './health-probe.js';
/**
 * Phase 2 · P2-T6（F2 Step 2）：VM 内回连**运行期探针**（自环带凭据回连 `/mcp`，
 * 实证优先升级 `/health.security.innerReconnect`；拒启判据不受其影响，见 server 装配点）。
 */
import { probeInnerReconnect } from './inner-reconnect-probe.js';
import {
  buildChainArchiveVerifyAuditEntry,
  collectApprovalFacts,
  deriveUnderlying,
  recordApprovalDecisionAudit,
  recordBlockedApprovalAudit,
  recordPolicyDeniedAudit,
  toExecutedResult,
  type ApprovalDecision,
  type ApprovalDecisionAuditInput,
  type ApprovalDecisionSink,
} from './approval-replay.js';
import { PendingApprovalRegistry, type ApprovalTokenMap } from './pending-approvals.js';
import {
  BEARER_UNAUTHORIZED_BODY,
  buildSecurityHealth as buildSecurityHealthSnapshot,
  createBearerGuard,
  resolveBearerToken,
  // Phase 2 · P2-T5（F2 Step 1）：bearer 生效自检三件套 + 回连通路判定 + fail-closed 决策表。
  // 全部是 `http-guard` 的纯函数 ⇒ 判据可脱服务逐条断言（`phase2-bearer-selfcheck.test.js`）。
  buildBearerSelfCheckAuditEntry,
  resolveAuthMode,
  resolveInnerReconnect,
  runBearerMountSelfCheck,
  shouldFailClosedStart,
  type BearerSelfCheckHealth,
  type GuardableRequest,
  type HealthAuthMode,
  type InnerReconnectHealth,
} from './http-guard.js';
// Phase 2 · P2-T4 遗留接线转正（设计 §13.4）：宿主断连侦测 → AbortSignal → McpRequestContext。
// `mcp-transport.ts` 是 T4 新建的零反向依赖传输层模块；本文件是 Phase 2 的 server.ts 唯一
// 授权写者窗口，接线两行（signal 取用 + reqCtx 装配）与 4 处同源守卫**必须同批**（否则红）。
import { watchClientDisconnect, buildMcpRequestContext } from './mcp-transport.js';
import {
  LedgerRegistry,
  ReceiptCache,
  buildDelegationAuditEntry,
  buildReceiptResponse,
  bypassTagSink,
  wrapAuditSink,
} from './delegation-audit.js';
// Phase 2 · P2-T7（F3 / L1）：TaskStore 驱逐的链上取证（`ext.kind:'task-evicted'`）。
// 条目构造纯函数 + 突发合并投递器都在新模块里（⇒ 零既有守卫文本面），本文件只做装配：
// 把框架的 `onEviction` 结构化事件接到**原始 sink**。框架层不 import 审计语义（依赖方向铁律），
// 「落不落链」由本层决定 —— 本批裁断：**落**（设计 §3.1-1；对账口径 = 链上与 /health.tasks 同计数源）。
import { createTaskEvictedChainRecorder } from './task-evict-audit.js';

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
  /**
   * K5：拦截时的 traceId 留存 —— 重放执行段用它派生 `<traceId>-replay`，
   * 使「被拦 → 批准 → 重放执行」在审计链上串成一条可回溯的因果线。
   */
  readonly traceId?: string;
  /** K5：宿主批准前挂起的 impact 摘要留存（MCP 拦截路径写入，供 approval-request 可读化）。 */
  readonly impact?: readonly string[];
  /**
   * K5：被拦截调用的**真实意图**（外层是壳时=内层目标）。
   * 由 MCP 拦截路径尽力推断留存（workflow 外壳 → 内层 goal/真实能力），
   * 协调器 raise 时并入 approval-request 的 data part → 宿主卡片可读。
   */
  readonly underlying?: ApprovalUnderlying;
  /**
   * K-N1（**纯附加**）：拦截发生时所属的委派 traceId（由 `/mcp?dtid=` 注入的
   * `ToolContext.delegationId`）。留存它使「批准 → 服务端重放」这条**异步**执行链
   * 仍能把 executed 条目归因回原委派回合（重放没有 HTTP 上下文，只能靠留存值）。
   */
  readonly delegationId?: string;
}

/**
 * ENG-08：TaskStore 有界化在本装配层的**显式声明值**（与 `a2a-framework` 缺省逐字相同：
 * 200 条 / 1h 驻留）。框架侧的 `DEFAULT_MAX_TASKS` / `DEFAULT_TERMINAL_TTL_MS` 是刻意
 * 未导出的私有常量（T3 notes §3：导出会把内部裁断变成对外契约），而 `/health.tasks`
 * 必须如实报出「本次运行生效的上限」⇒ 在构造点把值显式写出来，比在透出侧凭记忆复写
 * 更诚实（漂移即说谎），且行为与缺省零差异（T3 notes §6-3 明示「T4 不显式传也有界」）。
 */
const TASK_STORE_MAX_TASKS = 200;
const TASK_STORE_TERMINAL_TTL_MS = 3_600_000;

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
 * K4/K5 VM 侧审批协调器：桥接层（bridge）命中宿主审批拦截时，把 A2A 任务挂起为 input-required，
 * 并把对应续跑令牌（pendingApprovals 中的 token）标记为「待宿主批准」。
 *
 * K4 安全点：token 在 `/mcp` 能力层注册时 `hostApproved=false`；宿主经 A2A `approval.reply`
 * 批准（resolveApproval(true)）后，本协调器才把 token 置 `hostApproved=true` —— 在此之前
 * 能力层绝不放行，杜绝「不记名令牌」续跑漏洞（K3 要堵的安全点）。
 *
 * K5 执行权收归服务端（根治 A2A 假成功）：宿主批准后**不再依赖 LLM 是否重发工具调用**，
 * 协调器直接用 pendingApprovals 留存的**原参数**调用注入的 `replay`（= handler 同一段真实执行
 * 段：policy(approved=true) → provider.execute → 审计），把**结构化回执** `executed` 随决议返回。
 * 重放结束（成功或失败）后 token **一次性消费删除**，杜绝同一 approvalId 被二次使用。
 *
 * 不可妥协的纪律：
 *   1. 重放**仅在** `resolveApproval(true)` 之后由本协调器触发，参数取服务端留存原值
 *      —— VM 内任何角色（含 LLM）无法伪造执行；
 *   2. 拒绝 / TTL 超时 / 无挂接任务 / 无留存 token → 一律 `approved:false`，绝不重放；
 *   3. `WINVM_APPROVAL_REPLAY=off`（灰度回滚）→ 跳过重放，仅返回 `approved:true`
 *      （`executed` 缺席）→ 桥退回 K4 提示词行为；开关只关重放，绝不放宽审批闸。
 */
export class VmApprovalCoordinator implements ApprovalCoordinator {
  private activeTaskId: string | undefined;
  /**
   * ARCH-05：判据走 `TaskStore.isCancelled()`（T3 唯一权威入口）⇒ `bind` 形参与本字段
   * 同步放宽为所需三成员的 `Pick`（真实 TaskStore 天然满足；调用文本零改动）。
   */
  private tasks: Pick<TaskStore, 'waitApproval' | 'tryGet' | 'isCancelled'> | undefined;
  /**
   * ENG-01：字段类型放宽为窄 `ApprovalTokenMap`（原 `Map`）⇒ 装配层可注入
   * `PendingApprovalRegistry`；既有单测传裸 `Map` 仍逐字可用（结构同构）。
   */
  private pendingApprovals: ApprovalTokenMap<PendingApproval> | undefined;
  /** K5：服务端重放函数（由 createService 注入；缺席即不重放，行为退回 K4）。 */
  private replay: ReplayFn | undefined;
  /** K5：重放开关（默认 on；由 createService 从 env 解析后注入，便于单测覆盖）。 */
  private replayEnabled = true;
  /**
   * K5：TTL 超时标记集 —— TaskStore 的 onApprovalTimeout 回调经 `noteTimeout` 登记。
   * raise 用它把 `false` 细分成 `timeout` / `rejected`（登记后即消费删除，不留残）。
   */
  private readonly timedOutApprovals = new Set<string>();

  /**
   * ARCH-05（**纯附加**）：**已决策**审批集合 —— 决策是一次性事实，同一 `approvalId`
   * 的第二条到达路径（TTL 回调已落、`raise` 随后收口；清扫器已落、宿主随后应答）
   * 一律**判存即返回**，绝不二次落链（顺序纪律 **O-6**；判据①「一次超时只一条」的实现点）。
   *
   * 与 `timedOutApprovals` 同风格、同生命周期；规模由 ENG-01 清扫器一并限界
   * （`pruneDecided`：令牌表里已不存在的 id 随 TTL 清扫摘除，避免长跑单调增长）。
   * 重放完成后**不清**（决策一次性，天然幂等）。
   */
  private readonly decidedApprovals = new Set<string>();

  /**
   * ARCH-05：决策取证出口（由 `createService` 注入；**缺席即 no-op** ⇒
   * `k4-*` / `k5-replay` / `r19c-a5` 既有用例脱离服务直接实例化协调器时零副作用）。
   */
  private decisionSink: ApprovalDecisionSink | undefined;

  /** ARCH-05：注入决策取证出口（`setLogger` / `setReplay` / `bind` 同范式）。 */
  setDecisionSink(sink: ApprovalDecisionSink): void {
    this.decisionSink = sink;
  }

  /**
   * ARCH-05：登记一次审批决策并交取证出口落链（**O-6 去重** + **O-5 best-effort**）。
   *
   * - 判存即返回：同一 `approvalId` 只落一条链上决策条目；
   * - 出口异常一律吞掉并 warn —— 取证失败**绝不回改**拒绝/超时/取消结论（O-5，
   *   与 `recordBlockedApprovalAudit` / `verifyArchive` 同纪律）；
   * - 公开（非 private）：ENG-01 令牌表清扫器（无 `ApprovalRequest` 上下文）复用同一入口，
   *   使「MCP 直调令牌过期」与 `raise` 收口两条路共享去重，不产生双写。
   */
  recordDecision(input: ApprovalDecisionAuditInput): void {
    if (this.decidedApprovals.has(input.approvalId)) return;
    this.decidedApprovals.add(input.approvalId);
    // 设计 §5 第 2 条（owner 默认裁断）：**approved 不落链** —— 批准后重放段天然已有一条
    // executed 条目，再落决策条会语义重叠并胀链。本处仍登记决策（幂等：批准后该令牌
    // 若被 TTL 清扫二次触达，不会再冒出一条假 timeout 决策）。
    // 函数签名与枚举**预留** 'approved'，供 ARCH-09（previewHash）批次复用。
    if (input.decision === 'approved') return;
    if (!this.decisionSink) return;
    try {
      this.decisionSink(input);
    } catch (e) {
      this.logger?.warn('审批决策取证失败（不影响决策结果）', {
        approvalId: input.approvalId,
        decision: input.decision,
        error: String(e),
      });
    }
  }

  /**
   * ENG-01 配套限界：摘除**已不在令牌表**的决策登记项（由清扫器按拍调用）。
   * 返回摘除数，仅用于日志/测试断言。
   */
  pruneDecided(liveApprovalIds: Iterable<string>): number {
    const live = new Set(liveApprovalIds);
    let removed = 0;
    for (const id of [...this.decidedApprovals]) {
      if (live.has(id)) continue;
      this.decidedApprovals.delete(id);
      removed++;
    }
    return removed;
  }

  /** 当前决策登记规模（可观测面；不入链）。 */
  get decidedSize(): number {
    return this.decidedApprovals.size;
  }

  /**
   * 注入 A2A 任务存储与 MCP 续跑令牌表（createService 内二者就绪后调用一次）。
   *
   * ARCH-05 / O-4：`tasks` 的**取消判据**（`isCancelled`）由本类读取，使「挂起中被取消」
   * 与「宿主拒绝」在决策取证上可分辨 —— 判据必须走 `TaskStore.isCancelled()`
   * （T3 提供的唯一权威入口），**不得**自行读任务状态字段或标志位（同源事实、单点判据）。
   * 形参放宽为 `Pick<TaskStore, 'waitApproval' | 'tryGet' | 'isCancelled'>`：
   * 既有调用点（真实 `TaskStore`、`bind(a2a.tasks, pendingApprovals)`）**逐字不变**，
   * 单测替身（只提供必要成员）也因此无需扩面。
   */
  bind(
    tasks: Pick<TaskStore, 'waitApproval' | 'tryGet' | 'isCancelled'>,
    pendingApprovals: ApprovalTokenMap<PendingApproval>,
  ): void {
    this.tasks = tasks;
    this.pendingApprovals = pendingApprovals;
  }

  /** K5：注入服务端重放实现（走 handler 同一段真实执行段）。 */
  setReplay(replay: ReplayFn): void {
    this.replay = replay;
  }

  /** K5：设置重放灰度开关（`WINVM_APPROVAL_REPLAY` 解析结果）。 */
  setReplayEnabled(enabled: boolean): void {
    this.replayEnabled = enabled;
  }

  /** K5：登记「该审批因 TTL 超时收口」（TaskStore onApprovalTimeout 回调调用）。 */
  noteTimeout(approvalId: string): void {
    this.timedOutApprovals.add(approvalId);
  }

  /**
   * P1-Fix：告警出口（可选）。由 `createService` 注入服务 logger；未注入时降级为 no-op，
   * 保证单测/纯逻辑场景零副作用。
   */
  private logger: ApprovalWarnSink | undefined;

  /** P1-Fix：注入告警出口（`createService` 内 `new VmApprovalCoordinator()` 之后调用一次）。 */
  setLogger(logger: ApprovalWarnSink): void {
    this.logger = logger;
  }

  beginTask(taskId: string): void {
    this.activeTaskId = taskId;
  }

  endTask(taskId?: string): void {
    // 归属语义（P1-Fix）：
    //   taskId 缺席 或 空串  ⇒ 无归属信息 ⇒ 旧行为：无条件清空（兼容既有零参调用方）
    //   taskId 非空且 !== 当前活动任务 ⇒ 本次收尾不属于当前活动任务（并发交叠）⇒ 保持不动
    //   taskId 非空且 === 当前活动任务 ⇒ 正常释放
    if (!taskId) {
      this.activeTaskId = undefined;
      return;
    }
    if (taskId !== this.activeTaskId) return;
    this.activeTaskId = undefined;
  }

  async raise(req: ApprovalRequest): Promise<ApprovalOutcome> {
    // P1-Fix：归属优先取请求自带 taskId（桥从 LlmGoalInput.taskId 注入），
    // 缺席才回退服务级单例 beginTask 记录值（旧行为逐字保留）。
    const taskId = req.taskId ?? this.activeTaskId;

    // 无挂接任务（非 A2A / 任务已结束）→ 不放行，保持「等待审批」语义
    if (!taskId || !this.tasks) {
      // P1-Fix：可观测性 —— 根因文档 §6.4 点名「零日志」是本次只能靠反证定位的原因。
      // 字段口径见 spec SK-3：缺席一律 ''（绝不输出 undefined 字面量）；hasTasks 用于把
      // 守卫的两个子条件（!taskId / !this.tasks）在日志里区分开。
      this.logger?.warn('审批协调器：无挂接任务，审批请求被丢弃（任务不会挂起 input-required）', {
        reason: 'no-active-task',
        approvalId: req.approvalId,
        capabilityId: req.capabilityId,
        reqTaskId: req.taskId ?? '',
        activeTaskId: this.activeTaskId ?? '',
        hasTasks: this.tasks !== undefined,
      });
      return { approved: false, reason: 'no-active-task' };
    }

    // K5：宿主卡片可读性 —— 拦截时服务端留存的 preview/impact/underlying 并入审批请求
    //（桥侧只能给出 LLM 回显的粗信息；真实参数只存在于服务端 token 里）。
    const token = this.pendingApprovals?.get(req.approvalId);
    const enriched: ApprovalRequest = token
      ? {
          ...req,
          // P1-Fix：风险以**服务端策略引擎判定的权威值**为准（PendingApproval.risk，:70）；
          // 桥侧值（源自 LLM 文本正则 + 兜底 'L2'）仅作 token 缺席时的降级。
          risk: token.risk ?? req.risk,
          preview: Object.keys(req.preview).length > 0 ? req.preview : token.preview,
          impact: req.impact.length > 0 ? req.impact : (token.impact ?? []),
          underlying: req.underlying ?? token.underlying,
        }
      : req;

    const done = this.tasks.waitApproval(taskId, enriched);
    const approved = await done;

    if (!approved) {
      // 拒绝 / TTL 超时 / 挂起中被取消：一律不放行，绝不重放（K3/K4 纪律逐字保持）。
      // reason 细分两个信号（任一命中即为 timeout）：
      //   ① TaskStore 把超时事实固化进 task.metadata（approvalTimedOut + 对应 approvalId）；
      //   ② 服务侧 onApprovalTimeout 回调经 noteTimeout 显式登记（metadata 被后续写覆盖时的兜底）。
      const meta = this.tasks.tryGet(taskId)?.task.metadata as Record<string, unknown> | undefined;
      const timedOut =
        this.timedOutApprovals.delete(req.approvalId) ||
        (meta?.['approvalTimedOut'] === true && meta?.['approvalTimeoutApprovalId'] === req.approvalId);
      // ARCH-05（**判据顺序写死**，顺序纪律 O-4）：`canceled` > `timeout` > `rejected`。
      // 为什么 canceled 必须最先判：宿主 `tasks/cancel` 会 `requestCancel` →
      // `pendingApproval.resolve(false)`，于是**同一条 resolve(false)** 既可能被读成
      // 「宿主拒绝」也可能被读成「取消」——把它记成 rejected 等于把「我们自己的取消」
      // 伪装成「人工否决」，取证方向性错误（设计 §1.2-3）。
      // 判据**只走** `TaskStore.isCancelled()`（T3 提供的唯一权威入口，同源含终态与标志位），
      // 不在本层另读任务状态字段（单点判据 ⇒ 无第二份真相）；可选调用 + 严格等值
      // 使既有单测替身（未提供该成员）逐字退回旧路径。
      const canceled = this.tasks.isCancelled?.(taskId) === true;
      const decision: ApprovalDecision = canceled ? 'canceled' : timedOut ? 'timeout' : 'rejected';
      // ARCH-05 决策入链（best-effort，**绝不回改**下面的返回值 —— O-5）。
      // actor 三值即三条真实路径的可 grep 归因（设计 §1.2-1 表）。
      this.recordDecision({
        traceId: token?.traceId ?? '',
        approvalId: req.approvalId,
        capabilityId: req.capabilityId,
        risk: req.risk,
        decision,
        actor: canceled ? 'cancel-request' : timedOut ? 'approval-ttl' : 'host',
        taskId,
        ...(token?.delegationId ? { delegationId: token.delegationId } : {}),
        // 生效 TTL 取自 TaskStore 固化进 metadata 的事实（`approvalTimeoutTtlMs`），
        // 不在本层另读配置 ⇒ 链上报的 TTL 与真实收口用的 TTL 同源（无第二份真相）。
        ...(typeof meta?.['approvalTimeoutTtlMs'] === 'number' ? { ttlMs: meta['approvalTimeoutTtlMs'] } : {}),
        startedAtMs: token?.createdAtMs ?? Date.now(),
        ...(token ? { params: token.params } : {}),
      });
      return { approved: false, reason: timedOut ? 'timeout' : 'rejected' };
    }

    // 宿主批准：token 置为「已批准」——保留 K4 语义，`/mcp` 人工显式续跑路径仍可用
    if (token) token.hostApproved = true;
    // ARCH-05：**登记**批准决策（判存即返回，令该 approvalId 此后不再被 TTL 清扫二次
    // 落成假 timeout）；但**不落链**（设计 §5 第 2 条 owner 默认裁断 —— 重放段已天然
    // 产出一条 executed 条目，双写会语义重叠并胀链）。
    this.recordDecision({
      traceId: token?.traceId ?? '',
      approvalId: req.approvalId,
      capabilityId: req.capabilityId,
      risk: req.risk,
      decision: 'approved',
      actor: 'host',
      hostApproved: true,
      taskId,
      ...(token?.delegationId ? { delegationId: token.delegationId } : {}),
      startedAtMs: token?.createdAtMs ?? Date.now(),
    });
    // token 已消失（超时清理 / 异常）：决议虽为 true 但无留存参数可重放 → 不放行
    if (!token) return { approved: false, reason: 'rejected' };

    // 灰度关闭 / 未注入重放：只返回批准事实（executed 缺席）→ 桥退回 K4 提示词行为，
    // token 保留（K4 /mcp 续跑路径需它放行）。
    if (!this.replayEnabled || !this.replay) return { approved: true };

    let outcome: ApprovalOutcome;
    try {
      const exec = await this.replay(token);
      outcome = { approved: true, executed: exec };
    } catch (e) {
      // 重放异常同样不得伪装成功：executed.ok=false，桥据此改判
      outcome = {
        approved: true,
        executed: {
          ok: false,
          capabilityId: token.capabilityId,
          summary: '服务端重放异常',
          error: String(e),
        },
      };
    }
    // K5 一次性消费：无论成功失败都删除 token，杜绝同一 approvalId 二次重放/二次续跑
    this.pendingApprovals?.delete(req.approvalId);
    return outcome;
  }
}

/**
 * P1-Fix：协调器告警出口的最小形状（只依赖 warn，便于单测注入 spy）。
 *
 * 不进 `ApprovalCoordinator` 契约：该接口的既有扩展方法（`bind` / `setReplay` /
 * `setReplayEnabled` / `noteTimeout`）本来就不在接口里 —— 它们是 vm-service 侧的
 * 注入式扩展，保持一致。缺席即 no-op（纯逻辑/单测场景零副作用）。
 */
export interface ApprovalWarnSink {
  warn(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * K5：服务端重放函数的形状 —— 输入被拦截时留存的 token（含原参数），输出结构化执行回执。
 * 由 createService 构造（内部复用 handler 的执行段），协调器只管调用、不认识 provider。
 */
export type ReplayFn = (pending: PendingApproval) => Promise<ExecutedResult>;

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

  /* ---- K-N1 取证件（进程内，全部有界） ----
   *  - `ledgerReg`：委派活动账本注册表 —— 每条**已落链**记录经 `wrapAuditSink` 回调喂入
   *    （通道 2 精确归因 `ext.delegationId` / 通道 1 时间窗 wild）；桥侧经
   *    `activityFor` 探针反查（`DelegationTruthProbe`），零活动 → NO_EXECUTION_RECEIPT 改判。
   *  - `receiptCache`：S-3 回执端点的有界脱敏环形缓存（≤200，重启即失，**不入链**）。
   * 纪律：`bridgeCtx.audit` 一律用包装 sink（保证 provider 落的每条 executed/blocked 记录
   * 都被账本看到）；`buildHealth` 的 `verifyChain` 走包装 sink 透传，语义不变。
   */
  const ledgerReg = new LedgerRegistry();
  const receiptCache = new ReceiptCache();
  // U-P0-3（A1）：`bypassTagSink` 套在账本装饰器**之外**，使凡经桥接层落链的记录先补上
  // `ext.bypass='dry-run'` 取证位（判据 = 策略引擎裁决的 matchedRule，不看调用方参数），
  // 再进账本与哈希链。未命中旁路的记录连 `ext` 键都不新增，既有链上形态逐字节不变。
  const auditSink = bypassTagSink(
    wrapAuditSink(audit, (record) => ledgerReg.onAuditRecord(record), logger),
  );

  /* ---- 桥接上下文 ---- */
  // K4：审批协调器（须先于 bridgeCtx 创建，以便注入 provider；tasks / pendingApprovals 在其
  // 就绪后通过 bind() 注入，见下方 A2A 构建之后）。
  const approvalCoordinator = new VmApprovalCoordinator();
  // P1-Fix：注入告警出口 —— 使 `raise` 的 no-active-task 早退**可观测**（根因文档 §6.4
  // 点名「零日志」是本次只能靠反证定位的原因）。logger 已在上方 :286 创建，顺序成立。
  approvalCoordinator.setLogger(logger);

  const bridgeCtx = {
    config: cfg as unknown as Record<string, unknown>,
    // K-N1：注入包装 sink —— provider 落的每条记录（成功/失败/blocked）都经账本过一遍
    audit: auditSink,
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
    // K-N1（设计 §3.2）：委派真实性探针 —— 桥在收口处反查「本委派回合服务端是否真有过活动」。
    // 同 reportNetCfg 惯例：不扩 BridgeContext 契约接口，provider 侧 cast 读取
    // （`adapter-agent-workbuddy-llm` 只认 `DelegationTruthProbe` 契约类型，不认服务端实现）。
    // 实现在**存活账本**上取三通道计数；账本缺席 → 三零（桥侧 fail-open + 恒落 zeroInnerCalls 兜底）。
    delegationProbe: {
      delegationActivity: async (delegationTraceId: string) => ledgerReg.activityFor(delegationTraceId),
      // CL-K3R（**纯附加可选成员**）：桥在收口处反查「本委派回合是否仍有未决审批」。
      // 两条事实通道合并返回：
      //   S1 主通道 —— 同进程 `pendingApprovals` 令牌表（`collectApprovalFacts` 按 R1/R2/R3 归因）；
      //   S2 副通道 —— 委派账本 `blockedFor`（补 V-3：常驻路径 blocked 恒空的观测断层）。
      // 缺席/抛错 ⇒ 桥侧门 3/门 4 fail-open，退回文本启发式（旧行为逐字不变）。
      approvalWait: async (q: ApprovalWaitQuery): Promise<readonly PendingApprovalFact[]> => [
        ...collectApprovalFacts(pendingApprovals, q, Date.now()),
        ...ledgerReg.blockedFor(q),
      ],
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

  /* ---- ARCH-06 A2：启动期**历史归档分片**校验（fire-and-forget，§7.2 区 2） ----
   *
   * 问题：`freshChainOnStart:true`（上方 :378 区，本批**不动其值**）使 `verifyChain()` 在
   * 每轮只读本轮活跃分片 ⇒ 历史分片永久退出判定面。`/health.audit` 若只报 `chainValid`，
   * 读者会把「本轮完好」误读成「全部历史证据完好」（体检 U-P0-2 点名「权衡未登记」）。
   * `/health.audit.scope='session'` 把范围显式化（区 9），而**跨轮事实**由本条启动校验
   * 落的一条 `ext.kind:'chain-archive-verify'` 链上条目提供 —— 免责句此才有证据支撑。
   *
   * 纪律：
   *  - **不阻塞启动**（`void` 异步）：`verifyArchive` 内部已全程 try/catch 绝不抛（T2），
   *    且有界 `ARCHIVE_VERIFY_MAX_SHARDS`（O-8，默认 30，超出只计数不校验）⇒ 无长阻塞面；
   *  - **写原始 `audit`**（顺序纪律 **O-7**）：不经 `auditSink`（= `bypassTagSink(wrapAuditSink(…))`）
   *    —— 壳/内部条目若经账本装饰器会把自己登记成「本回合有活动」= 审计自证，
   *    与 `delegation.start/complete` 同一纪律（见下方 observer 的 K-N1 注释块）；
   *  - 失败只 `logger.warn`，绝不影响服务可用性（取证面/执行面分离）。
   */
  void (async () => {
    const startedAtMs = Date.now();
    try {
      const results = await audit.verifyArchive();
      // 总数与有界结果集**分源**：verifyArchive 最多回 30 片，若不另取 shardsTotal，
      // 读者会把「30 片完好」当成「全部历史完好」（假证据形态，设计 §1.3-2 明令防）。
      const chain = await audit.verifyChain();
      const entry = buildChainArchiveVerifyAuditEntry(
        {
          traceId: newTraceId(),
          startedAtMs,
          results,
          shardsTotal: chain.shardsTotal ?? results.length,
        },
        () => newId('aud'),
      );
      await audit.append(entry);
      logger.info('启动归档校验完成', {
        shardsVerified: entry.ext.archive.shardsVerified,
        shardsTotal: entry.ext.archive.shardsTotal,
        broken: entry.ext.archive.broken.length,
      });
    } catch (e) {
      logger.warn('启动归档校验失败（不影响服务，跨轮历史证据缺席）', { error: String(e) });
    }
  })();

  /* ---- ARCH-07 / ENG-05：bearer 守卫的生效事实（§7.2 区 8 的判据源） ----
   *
   * 在**构造期**一次求值（部署期注入的凭据在进程生命周期内不重排），并把同一结论
   * 同时喂给守卫与 `/health.security.authMode` ⇒ 事实面与执行面同源，杜绝
   * 「health 报 bearer-enforced 而守卫其实停用」的自相矛盾（体检 U-P0-2 的病根之一）。
   *
   * 现网默认（P2-T5 起 `delivery/vm-service.config.json` 显式写 `enforceBearer:false`
   * 并**删掉** `tokenEnv` 键 ⇒ 默认部署是干净的 `loopback-only`，不再是半开的
   * `bearer-configured-missing`）⇒ `resolveBearerToken ⇒ undefined` ⇒ `guardActive=false`
   * ⇒ 守卫恒 pass ⇒ **路由逐字旧行为**（判据⑤关键回归）。
   * 注：`tokenEnv` 键被删**不**影响任何凭据通路（宿主侧凭据走 `--token-env` →
   * `buildTransport`/`applyBearerHeader`，与本文件的 VM 侧服务配置是两条独立面）；
   * 运维若要预先挂好变量名，写回 `tokenEnv` 即回到「有名无值 ⇒ 显形为半开态」的旧观测形态。
   */
  const bearerToken = resolveBearerToken(cfg.security.enforceBearer, cfg.security.tokenEnv);
  const guardActive = bearerToken !== undefined;
  const bearerGuard = createBearerGuard({
    enforceBearer: cfg.security.enforceBearer,
    tokenEnv: cfg.security.tokenEnv,
    logger,
  });

  /* ---- Phase 2 · P2-T5（F2 Step 1）：bearer **生效自检** —— 拒绝静默退化 ----
   *
   * `authMode` 只回答「配置意图 + env 有值」（装配事实），回答不了「守卫代码是否真在拒」
   * 与「VM 内回连在守卫生效时是否真可用」。B3 真机实证：误开 `enforceBearer`（双条件齐）
   * 的危害是**两段式**——宿主段当场 401（可见），VM 内回连段 401 打在**工具面** ⇒ 委派
   * 退化为**零副作用虚假完成**（completed + 链上 `zeroInnerCalls:true`，靠 CL-K3R 不采信兜住）。
   * 自检把这两件事变成机器可读事实，并按 Q4 裁决决定是否拒启。
   *
   * 三条纪律：
   *  1. **判据同源**：`selfCheckAuthMode` 复用 `resolveAuthMode`（与 `guardActive` 同一条
   *     `resolveBearerToken`），绝不在装配层另写条件（判据⑤的同源性要求）；
   *  2. **默认态零改判**：守卫未挂载 ⇒ `bearerSelfCheck='not-mounted'`（ok:true）+
   *     `innerReconnect='unverified'` ⇒ `shouldFailClosedStart` 恒 false ⇒ 现网逐字旧行为；
   *  3. **探针故障绝不冒充 broken**：任何不可达/超时都归 `unverified`（PR3 护栏）。
   */
  const failClosedEnabled = resolveEnforceBearerFailClosed(cfg.security);
  /** 生效中的 provider options（回连通路判定的输入面；provider 缺席 ⇒ 空视图）。 */
  const activeProviderOptions: Readonly<Record<string, unknown>> | undefined =
    cfg.agent.providers[cfg.agent.provider]?.options;
  /** 启动期自检快照（常驻只读；`/health.security` 与 fail-closed 决策**共用同一份**，杜绝两处漂移）。 */
  const selfCheckAuthMode = resolveAuthMode(cfg.security.enforceBearer, cfg.security.tokenEnv);
  const bearerSelfCheck: BearerSelfCheckHealth = runBearerMountSelfCheck({
    bearerToken,
    // 同进程直调守卫（不发真实 HTTP）：判据是「守卫代码是否在拒」，成本≈0、离线可证、真机同码。
    evaluate: (probeReq) => bearerGuard(probeReq),
  });
  /**
   * P2-T6（观测面与判决面**分离**）：
   *  - `innerReconnect`（本行，**不可变**）＝ 启动期**配置面**结论（判序①..⑥）。它是
   *    fail-closed 判决与链上取证条目（`ext.kind:'bearer-selfcheck'`）的**唯一依据**，
   *    不得被稍后的探针追溯性改写 —— 否则「本轮为什么放行/为什么拒启」这一跨轮事实会失真。
   *  - `innerReconnectObserved`（下方，**可变**）＝ `/health.security.innerReconnect`
   *    的观测面，`listen()` 之后可由运行期回连探针（`probeInnerReconnect`，实证优先 ⇒
   *    判序③ `probeStatus`）升级为 `ok` / `broken` 实形。
   *
   * 三条不变量（改这两行前先读 `inner-reconnect-probe.ts` 文件头）：
   *  1. **拒启判据只看启动值**：`failClosedDecision` 在 `createServer` 之前按本行求值
   *     （探针此刻尚未跑 ⇒ 拒启永不受观测面影响；观测手段坏不得升级为可用性事故 —— PR3）；
   *  2. **探针不跑即旧形状**：`bearerEnvName` 缺席 / 守卫未挂载 ⇒ 探针根本不发起，观测面
   *     逐字等于配置面结论（默认态零回归）；
   *  3. **覆盖只在实证态**：探针给出 `ok`（带凭据回连 HTTP 200）或 `broken`（401/403）才
   *     覆盖；`unverified`（超时/连接失败/无 fetch 等观测手段自身问题）**绝不覆盖**
   *     —— 否则会把「没测到」洗成「测过且未知」，取证时点失真。
   */
  const innerReconnect: InnerReconnectHealth = resolveInnerReconnect({
    authMode: selfCheckAuthMode,
    providerOptions: activeProviderOptions,
  });
  /** 观测面（可被探针升级；初始＝配置面结论，探针不跑则全程逐字不变）。 */
  let innerReconnectObserved: InnerReconnectHealth = innerReconnect;
  const failClosedDecision = shouldFailClosedStart({
    authMode: selfCheckAuthMode,
    innerReconnect: innerReconnect.status,
    failClosed: failClosedEnabled,
  });
  // 生命周期收口位（P2-T5 判据 c）：`close()` 一经调用即置位，自检的 fire-and-forget 落链
  // 段据此**放弃写入**（不再往已关闭的 sink 里塞条目，也不再在退出后打 warn）。
  let serviceClosed = false;

  /**
   * 自检结论**落链**（与归档校验同 **O-7** 纪律：写**原始 `audit`**、不经 `auditSink` ⇒
   * 服务端自发条目不会被账本登记成「本回合有活动」= 审计自证）。
   * `refuse` 入参把「本轮是否真的拒绝进入服务态」写进条目（回滚位轮 = false + 显式告警）。
   */
  const recordBearerSelfCheck = async (refuse: boolean): Promise<void> => {
    // 收口后不再往已关闭的 sink 里塞条目（fire-and-forget 与 close() 的竞态面）。
    if (serviceClosed) return;
    const startedAtMs = Date.now();
    try {
      // 默认态（守卫未挂载）也落一条：`authMode` 会被下次启动覆盖，而「本轮守卫是否真在拒」
      // 是跨轮取证事实；危害形态恰是「无痕的虚假完成」⇒ 证据必须无条件在场（可 grep）。
      await audit.append(
        buildBearerSelfCheckAuditEntry(
          {
            traceId: newTraceId(),
            authMode: selfCheckAuthMode,
            selfCheck: bearerSelfCheck,
            innerReconnect,
            failClosed: failClosedEnabled,
            refuse,
            startedAtMs,
          },
          () => newId('aud'),
        ),
      );
    } catch (e) {
      if (!serviceClosed) logger.warn('bearer 生效自检落链失败（不影响服务，跨轮证据缺席）', { error: String(e) });
    }
  };

  /* ---- fail-closed（§13 Q4）：**仅**「守卫真生效 ∧ 回连确证 broken ∧ 开关开」拒启 ----
   *
   * 拒启路径刻意**先落证据再抛**：这一轮「为什么起不来」必须跨轮可查（抛错后运维只会看到
   * cli 的一行 stderr，链上条目才是权威事实）。回滚位（`enforceBearerFailClosed:false`）
   * 放行但**必须**打显式告警 —— 降级事实显形、绝不静默（与 `authMode` 半开态同族纪律）。
   */
  if (failClosedDecision.refuse) {
    logger.error('bearer 生效自检判定：守卫已生效且 VM 内回连必 401 ⇒ fail-closed 拒绝进入服务态', {
      authMode: selfCheckAuthMode,
      innerReconnect: innerReconnect.status,
      reason: innerReconnect.reason,
      selfCheck: bearerSelfCheck.code,
    });
    // 顺序纪律：证据**先落链**，再置收口位、再关本轮已启动的件。
    await recordBearerSelfCheck(true);
    // 抛错前收口本轮已启动的件：会话探针监视器（interval）与 ps-bridge（常驻 spawn）——
    // 否则得到「服务没起但桥还活着」的新静默退化（泄漏面恰好是本批要杜绝的那一类）。
    serviceClosed = true;
    sessionMonitor.stop();
    await runtime.bridge.stop().catch(() => undefined);
    logger.close();
    throw new Error(
      `bearer 生效自检拒绝启动（fail-closed）：authMode=${selfCheckAuthMode} 且 VM 内回连通路=${innerReconnect.status}。` +
        `${innerReconnect.reason} 后果：VM 内委派将退化为零副作用虚假完成（completed + 链上 zeroInnerCalls:true，B3 真机实证）。` +
        `两条出路：①关掉 security.enforceBearer（回环默认态，信任边界=回环+SSH 隧道+审批闸）；` +
        `②临时回滚位 security.enforceBearerFailClosed=false（放行并打显式告警，回连通路属 P2-T6）。` +
        `详见 docs/02-design/SECURITY-GOVERNANCE.md §2.1。`,
    );
  }

  /* 自检结论落链 + 告警（fire-and-forget，**不阻塞启动**）。 */
  void (async (): Promise<void> => {
    await recordBearerSelfCheck(false);
    if (failClosedDecision.rollbackWarn) {
      logger.warn(
        'bearer 生效自检：判据成立（守卫生效 + VM 内回连必 401）但 enforceBearerFailClosed=false ⇒ 放行启动（回滚位生效）',
        { authMode: selfCheckAuthMode, innerReconnect: innerReconnect.status, reason: innerReconnect.reason },
      );
    }
    if (!bearerSelfCheck.ok) {
      // 挂载逻辑漂移 ⇒ 事实面（authMode）与执行面（守卫判决）分家，这是最隐蔽的退化。
      logger.error('bearer 生效自检不合格：守卫挂载逻辑与事实面不一致', {
        authMode: selfCheckAuthMode,
        code: bearerSelfCheck.code,
        reason: bearerSelfCheck.reason,
      });
    } else if (innerReconnect.status === 'broken') {
      logger.warn(
        'bearer 生效自检：守卫已生效但 VM 内回连通路不可用（回连必 401 ⇒ 委派将退化为零副作用虚假完成）',
        {
          authMode: selfCheckAuthMode,
          innerReconnect: innerReconnect.status,
          reason: innerReconnect.reason,
          failClosed: failClosedEnabled,
        },
      );
    } else if (innerReconnect.status === 'unverified') {
      logger.info('bearer 生效自检：回连通路状态未实证（默认态只观测不改判）', {
        authMode: selfCheckAuthMode,
        reason: innerReconnect.reason,
      });
    }
  })();

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

  /* ---- 审批闸登记（MCP 侧） ----
   * ENG-01（§7.2 区 3）：裸 Map ⇒ **有界登记表**。TTL 复用既有旋钮
   * `WINVM_APPROVAL_TTL_MS`（`resolveApprovalTtlMs()`），与 A2A 审批等待（下方 TaskStore
   * 的默认 TTL）**同一旋钮、同一语义** —— 不新造同义 env 旋钮（§8 硬纪律）。
   * 策略表里**没有**第二个审批超时旋钮可言：曾与本旋钮并提的那个默认 120s 零消费
   * 死字段已随 Phase 2 · P2-T2 删除（旧键写在配置文件里只会被 `validateServiceConfig`
   * 告警并忽略，不会生效）。
   * `PendingApprovalRegistry` 实现窄 Map 面 ⇒ 下方三处调用点（`set`/`get`/`delete`）与
   * `collectApprovalFacts(ReadonlyMap)` 形参**签名与文本逐字不变**。
   */
  const pendingApprovals = new PendingApprovalRegistry<PendingApproval>({
    ttlMs: resolveApprovalTtlMs(),
    logger,
  });

  /**
   * P3-3：A2A 审批等待（`input-required` 挂起）加 TTL 护栏（默认 30 分钟，env
   * `WINVM_APPROVAL_TTL_MS` 可覆盖）。宿主永不应答时由 TaskStore 按「拒绝」收口：
   * 挂起 Promise resolve(false) → 桥保持 K3 旧行为（ok=false，绝不自批）→ 任务转 `failed`
   * （原因 approval timeout）。令牌清理由本侧负责（TaskStore 不知道 pendingApprovals）：
   * 超时回调里删掉残留 token，使 `/mcp` 续跑闸（`hostApproved === true`）永无放行可能。
   *
   * ARCH-05（§7.2 区 4）：回调同时经 `recordDecision('timeout')` 把**超时决策入链**
   * （设计 §1.2-3 表末行）。本回调在 `TaskStore.finish()` 内先于 `resolve(false)` 触发
   * ⇒ 它会先落链，随后 `raise` 的否定分支同一 approvalId 被 **O-6 判存即返回**去重
   * ⇒ 一次超时**只落一条**（判据①）。两处都落正是为了「任一路径先到也不漏证」，
   * 去重集合保证不会双写。
   *
   * ENG-08（T3 已交付有界化）：`maxTasks` / `terminalTtlMs` 在此**显式声明**为框架缺省值
   * （`200` / `1h`）—— 二者在 `a2a-framework` 侧是刻意未导出的私有常量（T3 notes §3），
   * 而 `/health.tasks` 要如实报出「本次运行生效的上限」⇒ 与其在透出侧凭猜测复写数字
   * （漂移即说谎），不如在构造点把值钉成装配层的单一可见来源（行为与缺省逐字相同）。
   * **不新造 env 旋钮**（§8）；`service.limits` 配置面本批未开（设计 §1.6-2 列为可选）。
   *
   * P2-T7（L1，**纯附加**）：新增 `onEviction` —— 把框架的驱逐结构化事件接到链上取证
   * （`ext.kind:'task-evicted'`，突发合并，写**原始** sink，O-7 审计自证）。
   * 判据「累计驱逐数」的唯一来源仍是 `taskStore.evictedCount()`（构造点与 `/health.tasks`
   * 共用同一读数 ⇒ 链上与体检面必然同口径，两处打架即说谎）。回调异常由框架吞掉，
   * 取证失败**绝不影响**有界化本身。
   */
  /**
   * 驱逐落链投递器（先声明以便 `taskStore` 构造参数引用）。
   * `isClosed` 复用 `serviceClosed` 位（P2-T5 收口纪律）⇒ 退出路径上不再往已关闭 sink 写条目。
   */
  const taskEvictChain = createTaskEvictedChainRecorder({
    append: (entry) => audit.append(entry),
    newTraceId,
    newAuditId: () => newId('aud'),
    // 闭包延迟读取：构造 taskStore 时本函数已存在，真正调用发生在 flush（此时 taskStore 已就绪）
    evictedCount: () => taskStore.evictedCount(),
    isClosed: () => serviceClosed,
    warn: (msg, fields) => logger.warn(msg, fields),
  });
  const taskStore = new TaskStore({
    maxTasks: TASK_STORE_MAX_TASKS,
    terminalTtlMs: TASK_STORE_TERMINAL_TTL_MS,
    onEviction: taskEvictChain.onEviction,
    onApprovalTimeout: ({ taskId, approvalId, timedOutAfterMs, ttlMs }) => {
      // K5：登记超时事实，使协调器把 raise 的 false 细分成 'timeout'
      //（区别于宿主显式拒绝 'rejected'）；二者一律不放行、绝不重放。
      approvalCoordinator.noteTimeout(approvalId);
      // ARCH-05：超时决策入链（best-effort；取证失败绝不改拒绝收口 —— O-5）。
      // 令牌此刻仍在表中 ⇒ 取 capabilityId/risk/traceId/delegationId 丰富证据面。
      const stale = pendingApprovals.get(approvalId);
      approvalCoordinator.recordDecision({
        traceId: stale?.traceId ?? '',
        approvalId,
        capabilityId: stale?.capabilityId ?? 'unknown',
        risk: stale?.risk ?? 'L2',
        decision: 'timeout',
        actor: 'approval-ttl',
        taskId,
        ttlMs,
        ...(stale?.delegationId ? { delegationId: stale.delegationId } : {}),
        startedAtMs: stale?.createdAtMs ?? Date.now() - timedOutAfterMs,
        ...(stale ? { params: stale.params } : {}),
      });
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

  /* ================================ 能力执行段（K5：MCP handler 与重放共用） ================================ */

  /**
   * K5 执行段上下文。
   *
   * - `approved` 传给 provider 的审批位（重放路径恒为 true —— 宿主已批准才有重放）。
   * - `verdict` 由调用方传入（MCP handler 已在审批闸处评估过，避免二次评估漂移）；
   *   重放路径不传 → 本段内部按 `approved:true` 自行评估（命中黑名单照样拒绝，**不放行**）。
   * - `replayed=true` 时审计 traceId 带 `-replay` 后缀，使「被拦 → 批准 → 重放执行」在链上可串。
   */
  interface ExecutionSegment {
    readonly traceId: string;
    readonly approved: boolean;
    readonly approvalId?: string;
    readonly verdict?: PolicyVerdict;
    readonly replayed?: boolean;
    /**
     * K-N1（**纯附加**）：所属委派 traceId（`/mcp?dtid=` 解析值，或重放路径从
     * pendingApprovals 留存值取回）。存在时 provider 侧审计落 `channel:'a2a'` +
     * `ext.delegationId`（通道 2 精确归因）；缺席逐字节旧行为（`channel:'mcp'`，无 ext）。
     */
    readonly delegationId?: string;
  }

  /**
   * K5：把「provider.execute + 结果映射」抽成命名函数，供 MCP handler 与服务端重放**共用同一段
   * 真实执行**（杜绝两条路径行为漂移）。审计条目由 provider 内部落哈希链（重放天然再出一条
   * executed 记录，与拦截时的 blocked 记录串成完整取证线）。
   */
  async function executeCapability(
    cap: CapabilityDefinition,
    params: Record<string, unknown>,
    seg: ExecutionSegment,
  ): Promise<McpToolResult> {
    const verdict =
      seg.verdict ??
      policy.evaluate({
        capabilityId: cap.id,
        params,
        risk: cap.risk,
        approved: seg.approved,
        ...(seg.approvalId ? { approvalId: seg.approvalId } : {}),
        ...(cap.policy ? { capabilityPolicy: cap.policy } : {}),
      });

    if (!verdict.allowed) {
      // 重放路径理论上不会走到这里（宿主已批准）；若策略黑名单命中等硬拒绝，
      // 仍如实返回失败 → 重放回执 ok:false，桥据此改判，绝不伪装成功。
      // S-4 取证盲区闭合：策略硬拒绝（黑名单命中/能力未注册/超 maxRisk 等）必须入审计链，
      // 否则事后无法证明「该调用到过服务端且被策略拒绝」（与 K5 审批拦截同款落痕纪律）。
      // best-effort：审计写失败不影响拒绝结果（拒绝语义优先）。
      void recordPolicyDeniedAudit(
        audit,
        logger,
        {
          traceId: seg.traceId,
          capabilityId: cap.id,
          risk: cap.risk,
          params,
          startedAtMs: Date.now(),
          matchedRule: verdict.matchedRule ?? 'policy-denied',
          errorCode: verdict.error?.code ?? 'POLICY_DENIED',
          ...(verdict.error?.message ? { errorMessage: verdict.error.message } : {}),
        },
        () => newId('aud'),
        { channel: 'mcp' },
      );
      return {
        isError: true,
        structuredContent: {
          traceId: seg.traceId,
          ok: false,
          error: verdict.error ?? { code: 'POLICY_DENIED', message: '被策略拒绝' },
          risk: cap.risk,
          ...(seg.replayed ? { replayed: true } : {}),
        },
      };
    }

    if (!provider) {
      return {
        isError: true,
        structuredContent: {
          traceId: seg.traceId,
          ok: false,
          error: { code: 'PROVIDER_UNAVAILABLE', message: providerError ?? 'provider 未就绪' },
        },
      };
    }

    const res = await provider.execute({
      traceId: seg.traceId,
      capabilityId: cap.id,
      params,
      risk: cap.risk,
      // K5：审批位透传上下文值 —— 重放路径恒为 true（宿主已批准才有重放），
      // MCP 原路径按闸的实际判定走，绝不在此处擅自升级为「已批准」。
      approved: seg.approved,
      ...(seg.approvalId ? { approvalId: seg.approvalId } : {}),
      // K-N1：委派归因（通道 2）—— dtid 存在 ⇒ 这是 A2A 委派回合内的内层回连，
      // 通道真实化为 'a2a' 并携带 delegationId（provider 落 ext，账本据此精确归因）。
      ...(seg.delegationId ? { channel: 'a2a' as const, delegationId: seg.delegationId } : {}),
      timeoutMs: cap.timeoutMs,
    });

    // CL-020 F2：采集时间戳的捕获已从 handler 层移走（避免双写、单一数据源）。
    // 现由 provider.execute 内部的 reportNetCfg 注入回调统一上抛写入 netCfgCache，
    // MCP 与 A2A 两条路径共用同一 execute，全覆盖。此处不再重复捕获。

    // S-3（方案 B）：执行回执进**有界脱敏环形缓存**（≤200 条，不入链，重启即失）。
    // 键取 `res.traceId`（provider 回传值，与链上条目 traceId 一致）→ 端点按委派
    // traceId 直查命中壳条目自身的回执；内层回执经账本/链上 auditSeqs 展开命中。
    receiptCache.record(res.traceId, cap.id, res.ok, res.data);

    return {
      isError: !res.ok,
      structuredContent: {
        traceId: res.traceId,
        ok: res.ok,
        risk: cap.risk,
        data: res.data,
        ...(seg.replayed ? { replayed: true } : {}),
        ...(res.artifacts && res.artifacts.length > 0
          ? { artifacts: res.artifacts.map((a) => ({ kind: a.kind, name: a.name, mime: a.mime })) }
          : {}),
        durationMs: res.durationMs,
        ...(res.auditRef ? { auditRef: res.auditRef } : {}),
        ...(res.error ? { error: res.error } : {}),
      },
    };
  }

  /**
   * K5：服务端重放实现 —— 宿主批准后，直接用 pendingApprovals 留存的**原参数**走真实执行段。
   * 参数只可能来自服务端留存值，VM 内任何角色无法伪造（安全纪律 1）。
   */
  const replay: ReplayFn = async (p: PendingApproval): Promise<ExecutedResult> => {
    if (!exposedIds.has(p.capabilityId)) {
      return {
        ok: false,
        capabilityId: p.capabilityId,
        summary: '重放被拒：能力不在本服务暴露面内',
        error: 'CAPABILITY_NOT_EXPOSED',
      };
    }
    const cap = capabilityDefs.get(p.capabilityId);
    if (!cap) {
      return {
        ok: false,
        capabilityId: p.capabilityId,
        summary: '重放被拒：能力未注册',
        error: 'UNKNOWN_CAPABILITY',
      };
    }
    const traceId = `${p.traceId ?? newTraceId()}-replay`;
    logger.info('审批放行，服务端确定性重放执行', {
      approvalId: p.approvalId,
      capabilityId: p.capabilityId,
      traceId,
    });
    /* ARCH-05（§7.2 区 5 · **仅注释，零行为改动**）：本行 `approved: true` 是宿主批准后的
     * 唯一执行入口，`executeCapability` 内部策略段天然产出**一条** `executed` 条目 ⇒
     * 「批准」决策本身**不再单独落链**（设计 §5 第 2 条 owner 默认裁断：双写语义重叠且胀链）。
     * `ApprovalDecision` 枚举仍**预留** `'approved'`，供 ARCH-09（`previewHash` 绑定）批次
     * 复用；届时若要落链，落点在本函数**之外**的协调器 `recordDecision` 出口，不在这里内联。
     */
    const result = await executeCapability(cap, p.params, {
      traceId,
      approved: true,
      approvalId: p.approvalId,
      replayed: true,
      // K-N1：重放执行也要归因回原委派回合（p.delegationId 是拦截时留存的 dtid）——
      // 否则「委派内被拦 → 批准 → 服务端重放成功」这条 executed 只能靠时间窗 wild 兜底。
      ...(p.delegationId ? { delegationId: p.delegationId } : {}),
    });
    return toExecutedResult(p.capabilityId, result);
  };

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
          const impact = collectImpact(rest);
          pendingApprovals.set(id, {
            approvalId: id,
            capabilityId: cap.id,
            risk: cap.risk,
            params: rest,
            preview: buildPreview(cap, rest),
            createdAtMs: Date.now(),
            // K4：注册时恒为「待宿主批准」，杜绝未批准即放行。
            hostApproved: false,
            // K5：留存 traceId / impact / 真实意图 —— 供服务端重放（traceId 派生 -replay）
            // 与宿主审批卡片展示（impact/underlying 由协调器并入 approval-request）。
            traceId: ctx.traceId,
            impact,
            underlying: deriveUnderlying(cap.id, rest),
            // K-N1：留存委派归因 —— 批准后服务端重放（异步、无 HTTP 上下文）仍可把
            // executed 条目精确归因回原委派回合。
            ...(ctx.delegationId ? { delegationId: ctx.delegationId } : {}),
          });

          // K5 取证盲区闭合：被拦调用**必须入审计**（旧实现只在执行成功/失败时落条目，
          // 拦截路径无痕 → 事后无法证明「该调用到过、且从未执行」）。
          // best-effort：审计写失败不得影响拦截结果（拦截语义优先）。
          // K-N1：blocked 经**专用通道**登记进账本（不污染 executed 计数）——
          // 「委派内层到过但被拦」也是**非零活动证据**，桥侧据此绝不改判。
          void recordBlockedApprovalAudit(
            audit,
            logger,
            {
              traceId: ctx.traceId,
              approvalId: id,
              capabilityId: cap.id,
              risk: cap.risk,
              params: rest,
              startedAtMs: Date.now(),
            },
            () => newId('aud'),
            {
              channel: ctx.delegationId ? 'a2a' : 'mcp',
              ...(ctx.delegationId ? { delegationId: ctx.delegationId } : {}),
              onRecorded: (record) => {
                // CL-K3R：blocked 登记改走**注册表分发**（补 V-3）——
                //   - `ctx.delegationId` 存在（单次 -p / dtid 注入）→ 精确落到该委派账本（R1，与旧行为等价）；
                //   - 缺席（常驻路径：mcp.json 会话级共享，dtid 不生效）→ 按 `inWindow && isExposed`
                //     窗口归因分发，使常驻路径的「到过且被拦」不再恒空（旧实现是恒空操作）。
                ledgerReg.recordBlocked(record.seq, id, cap.id, {
                  ...(ctx.delegationId ? { delegationId: ctx.delegationId } : {}),
                  risk: cap.risk,
                });
              },
            },
          );

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
                impact,
                resumeHint: '确认后以 __approvalId 重发同一请求',
              },
            },
          };
        }
        // S-4 同上：审批路径下的策略硬拒绝也必须入审计链。
        // 它是终态拒绝而非待审批，故不登记进 ledger（onRecorded 省略）——避免被计为 blocked/wild。
        void recordPolicyDeniedAudit(
          audit,
          logger,
          {
            traceId: ctx.traceId,
            capabilityId: cap.id,
            risk: cap.risk,
            params: rest,
            startedAtMs: Date.now(),
            matchedRule: verdict.matchedRule ?? 'policy-denied',
            errorCode: verdict.error?.code ?? 'POLICY_DENIED',
            ...(verdict.error?.message ? { errorMessage: verdict.error.message } : {}),
          },
          () => newId('aud'),
          { channel: ctx.delegationId ? 'a2a' : 'mcp', ...(ctx.delegationId ? { delegationId: ctx.delegationId } : {}) },
        );
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

      // K5：执行段抽成命名函数（与重放共用），本路径按既有语义逐字保持
      return executeCapability(cap, rest, {
        traceId: ctx.traceId,
        approved,
        ...(approvalId ? { approvalId } : {}),
        verdict,
        // K-N1：dtid 存在 → 归因委派（channel 'a2a' + ext.delegationId 精确入账本）
        ...(ctx.delegationId ? { delegationId: ctx.delegationId } : {}),
      });
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

  /**
   * K-N1 委派观测点实现（设计 §2.1/§2.4）：把 A2A 委派的**壳生命周期**如实落到哈希链上。
   *
   * 为什么写在 vm-service 而不是框架：`a2a-framework` 不依赖 `@winvm/core`（依赖方向铁律），
   * 框架只留两点回调、零审计语义；语义（双态条目、账本窗口）由本层实现。
   *
   * 纪律：
   *  - 两个回调都 **fire-and-forget + catch warn** —— 取证面异常绝不影响委派（框架侧另有 observe 护栏双保险）；
   *  - `delegation.start` 落**原始 sink**（`audit`），不经 `wrapAuditSink` 回调进账本 ——
   *    壳条目自身绝不能成为自己的「活动证据」（设计 §2.3「排除两条壳条目自身」的结构性保证）；
   *    `delegation.complete` 同（账本此刻已 finish，回调通道也不会登记，双保险仍写原始 sink）。
   */
  const delegationObserver: DelegationObserver = {
    onGoalAccepted(goal: GoalRequest): void {
      const ledger = ledgerReg.begin(goal.traceId, goal.taskId ?? '', exposedIds);
      void audit
        .append(
          buildDelegationAuditEntry('start', {
            delegationTraceId: goal.traceId,
            ...(goal.taskId ? { taskId: goal.taskId } : {}),
            goal: goal.goal,
            ...(goal.maxRisk ? { maxRisk: goal.maxRisk } : {}),
            ...(goal.allowedCapabilities ? { allowedCapabilities: goal.allowedCapabilities } : {}),
            startedAtMs: ledger.startedAtMs,
            newAuditId: () => newId('aud'),
          }),
        )
        .catch((e: unknown) => logger.warn('delegation.start 落链失败（不影响委派）', { error: String(e) }));
    },

    onGoalTerminal(taskId: string, goal: GoalRequest, snap: DelegationTerminalSnapshot): void {
      const delegationTraceId = goal.traceId;
      // 收口账本：关账（迟到 append 不再污染）+ 摘除 + 取回活动事实用于 complete 条目
      const ledger = ledgerReg.finish(delegationTraceId);
      const result = snap.result;
      const ok = snap.state === 'completed' && result?.ok === true;
      // 宿主显式拒绝时 TaskStore 已置 rejected —— 终态如实透出（设计 §2.1 列了 rejected）
      const storedState = taskStore.tryGet(taskId)?.task.status.state;
      /* ---- O-3 三分支：canceled 优先直取（ARCH-22 / 判据⑦） ----
       *
       * 病灶：A2A 协作式取消后框架给的快照 `state` 可能是 `'failed'`（取消以 error 形态收口）,
       * 而 `TaskStore` 里的权威状态是 `'canceled'`。原两分支写法会把真实取消写成 `failed`
       * 或 `rejected` —— 链上终态与用户意图不符（取证面撒谎）。
       * 判据**顺序不可调换**：canceled 必须先于 failed→rejected 归正（O-4 同源纪律：
       * 取消 > 超时 > 拒绝 —— 取消是用户显式意图，权重最高）。
       * `storedState === 'canceled'` 一并前插：覆盖「快照 failed + 存储 canceled」组合。
       */
      const canceledTerminal = snap.state === 'canceled' || storedState === 'canceled';
      // ⚠ 排版纪律：下面三元式的**后两分支**（stored 为 rejected 时把 failed 回改）必须与
      // 判据源保持同一行连续 —— `r19c-kn1-e-shape` / `kn1-e-mutation` 对该段是正则文本匹配，
      // 折行即红。注释刻意不复述该表达式原文：复述会让判据在代码被摘除后仍命中注释而恒真
      //（变异检验的教训：T4 首版正是如此，被 E-6 变异检验当场抓出）。
      const terminalState = canceledTerminal
        ? 'canceled'
        : snap.state === 'failed' && storedState === 'rejected' ? 'rejected' : snap.state;
      // errorCode：completed 无；**canceled** 固定 `'TASK_CANCELED'`（判据⑦：取消不是执行失败，
      // 不得被 result.error.reason 的通用码顶替）；**failed** 取 result.error.reason（领域码，如
      // NO_EXECUTION_RECEIPT / LLM_SESSION_DISABLED），缺席退回契约码，异常路径取 error 上的码。
      // input-required（审批挂起）**不是执行错误** —— 不落 errorCode，避免把「等待人工」写成失败。
      const snapError = snap.error as { code?: string; reason?: string } | undefined;
      const errorCode =
        ok || snap.state === 'input-required'
          ? undefined
          : canceledTerminal
            ? 'TASK_CANCELED'
            : (result?.error?.reason ??
                result?.error?.code ??
                snapError?.reason ??
                snapError?.code ??
                'EXECUTION_FAILED');
      // 降级标记（T03 结构化；运行时经 LlmGoalResult 携带，缺席即 undefined → ext 不落该键）
      const degraded = (result as { degraded?: { reason: string } } | undefined)?.degraded;
      /* P2-T8 G-b：审批真值判据归因（provider 透传 GoalResult.approvalTruth）。
       * 与 degraded 同一手法：observer 只**搬运事实**、不做二次判定；缺席 ⇒ ext 不落该键
       * ⇒ 链上条目逐字节不变。读值走契约字段（不是桥内类型）—— 框架快照的 result 是
       * `GoalResult`，桥内 `LlmGoalResult` 服务端看不见（K-N1 §4.4 同一依赖方向纪律）。 */
      const approvalTruth = result?.approvalTruth;

      void audit
        .append(
          buildDelegationAuditEntry('complete', {
            delegationTraceId,
            taskId,
            goal: goal.goal,
            ...(goal.maxRisk ? { maxRisk: goal.maxRisk } : {}),
            ...(goal.allowedCapabilities ? { allowedCapabilities: goal.allowedCapabilities } : {}),
            startedAtMs: ledger?.startedAtMs ?? Date.now(),
            newAuditId: () => newId('aud'),
            ...(ledger ? { ledger } : {}),
            terminalState,
            ok,
            ...(errorCode ? { errorCode } : {}),
            ...(degraded ? { downgraded: true, downgradeReason: degraded.reason } : {}),
            // P2-T8 G-b（纯附加）：真值判据归因入链 → ext.approvalTruth（缺席即不落键）
            ...(approvalTruth ? { approvalTruth } : {}),
            ...(result && result.steps.length > 0
              ? {
                  steps: result.steps.map((s) => ({
                    capabilityId: s.capabilityId,
                    ok: s.ok,
                    ...(s.summary ? { summary: s.summary } : {}),
                  })),
                }
              : {}),
            ...(result?.summary ? { resultSummary: result.summary } : {}),
          }),
        )
        .catch((e: unknown) => logger.warn('delegation.complete 落链失败（不影响委派）', { error: String(e) }));
    },
  };

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
    // K-N1：委派观测点（见上方 delegationObserver 实现）—— 纯附加，框架零审计依赖
    delegationObserver,
  });

  /* ---- K4：把 A2A 任务存储与 MCP 续跑令牌表注入审批协调器（二者此刻已就绪） ---- */
  approvalCoordinator.bind(a2a.tasks, pendingApprovals);
  /* ---- K5：注入服务端重放实现 + 灰度开关（WINVM_APPROVAL_REPLAY，非法值回退 on） ---- */
  approvalCoordinator.setReplay(replay);
  approvalCoordinator.setReplayEnabled(resolveApprovalReplay());

  /* ---- ARCH-05（判据①②）：审批否定决策的取证装配 ----
   *
   * 协调器只负责**决策**（哪个 approvalId 被谁判成什么），落链由装配层注入 sink 完成
   * —— 框架/协调器不依赖审计是既有纪律（`a2a-framework` 零审计 import），补取证只能
   * 靠回调注入，否则依赖方向反转。
   *
   * ★ O-7：写**原始 `audit`**（不是 `auditSink`）。决策条目是服务端内部证据，经
   * `wrapAuditSink` 会被登记成「本委派回合有活动」= 审计自证；`bypassTagSink` 同理
   * 会给否定决策误贴 `ext.bypass` 位。判据②要求 sink 抛错时决策结果不变，故此处
   * 整段再包一层 try/catch + warn（双保险：协调器 `recordDecision` 内已有一层，
   * 本层兜住 `recordApprovalDecisionAudit` 自身返回 `{ok:false}` 的情形 —— 它内部
   * 已捕获链写异常，不会 reject，但 `logger` 之外的任何同步抛都要有归宿）。
   *
   * `approved` 决策在设计 §5 第 2 条裁断为**不落链**（批准本身不是"发生过的动作"，
   * 真正发生的是紧随其后的 `executed` 重放条目；落它只会把链体积翻倍）。协调器
   * `recordDecision` 已在入口拦掉 `approved`，这里的早退是第二道闸（防未来有人绕过
   * 协调器直接调 sink）。
   *
   * 通道归因：MCP 拦截令牌带 `delegationId`（委派内层回连）⇒ 归 `'a2a'`；
   * 纯宿主直调 ⇒ `'internal'`（服务端自身事实，不是宿主终端）。
   */
  approvalCoordinator.setDecisionSink((input) => {
    if (input.decision === 'approved') return;
    try {
      void recordApprovalDecisionAudit(
        audit,
        logger,
        input,
        () => newId('aud'),
        {
          channel: input.delegationId ? 'a2a' : 'internal',
          ...(input.delegationId ? { delegationId: input.delegationId } : {}),
        },
      ).then((r) => {
        if (!r.ok) logger.warn('审批决策审计未落链（不影响决策结果）', { approvalId: input.approvalId, error: r.error ?? '' });
      });
    } catch (e) {
      logger.warn('审批决策审计装配异常（不影响决策结果）', { error: String(e) });
    }
  });

  /* ---- ENG-01（判据⑥）：MCP 续跑令牌表的 TTL 清扫器 ----
   *
   * `WINVM_APPROVAL_TTL_MS`（`resolveApprovalTtlMs()`，缺省 30 分钟）—— 与 A2A 审批
   * 等待**同一旋钮、同一语义**；不新造 env 名（§8 硬纪律），策略面亦无第二个超时
   * 字段 —— 那个默认 120s、零消费、会在真人反应之前批量误逐的死字段已在
   * Phase 2 · P2-T2 删除（设计 §5 第 1 条登记的正是它）。
   *
   * 被逐条目的取证落点 = `timeout` 决策（actor `'mcp-ttl-sweep'`），使"令牌消失"
   * 这件事在链上可归因；否则只有 logger 一行，宿主侧「我申请的审批呢」无从查证。
   * `pruneDecided` 顺带回收去重集合里已不存在的 approvalId（防 `decidedApprovals`
   * 自身成为新的无界增长点 —— ENG-01 的有界性必须递归成立）。
   */
  pendingApprovals.startTimer(undefined, (swept) => {
    for (const [approvalId, token] of swept) {
      approvalCoordinator.recordDecision({
        traceId: token.traceId ?? '',
        approvalId,
        capabilityId: token.capabilityId,
        risk: token.risk,
        decision: 'timeout',
        actor: 'mcp-ttl-sweep',
        ...(token.delegationId ? { delegationId: token.delegationId } : {}),
        ttlMs: pendingApprovals.ttl,
        startedAtMs: token.createdAtMs,
        params: token.params,
      });
    }
    approvalCoordinator.pruneDecided(pendingApprovals.keys());
  });

  /* ================================ HTTP ================================ */

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const path = url.pathname;

      /* ---- ARCH-07（判据⑤）：HTTP 入口 Bearer 守卫 —— 唯一插入点 ----
       *
       * 位置纪律：必须挂在**所有路由分发之前**（`path` 解析后、方法白名单前），
       * 否则 `/admin/llm-session/reset` 这类"写在 405 判断之后"的端点会被绕过。
       * 豁免表（`/health`、`/.well-known/agent-card.json` 的 GET）由 `http-guard`
       * 内部判定，不在装配层重复实现 —— 装配层只负责"拒绝时怎么回"。
       *
       * O-9 双条件：`security.enforceBearer` **且** `tokenEnv` 指向的 env 有值
       * 才真正生效。缺任一件 ⇒ `resolveBearerToken` 返回 undefined ⇒ `guardActive`
       * 为 false ⇒ **本块整体跳过**，路由逐字保持旧行为（零回归，判据⑤）。
       * 这也是"配了开关却忘了发 token"这种半开状态的唯一安全解释：不静默放行任何
       * 已声明要保护的端点，而是**根本不进入守卫语义**（与 `validateServiceConfig`
       * 的双条件告警文案同源，见 `core/config`）。
       *
       * 取证面纪律：拒绝只写 `logger.warn`（由 `http-guard` 内部完成），**不进审计链**
       * —— 未授权的探测请求不该获得写链配额（否则 DoS 面直接映射成账本膨胀面）。
       * `/health.security.authMode` 负责把"守卫是否在位"这一事实透出给运维。
       */
      if (guardActive) {
        const verdict = bearerGuard(req as GuardableRequest);
        if (verdict.verdict === 'deny') {
          sendJson(res, 401, BEARER_UNAUTHORIZED_BODY);
          return;
        }
      }

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
          // P2-T4 遗留接线转正（设计 §13.4）：宿主断连 → AbortSignal → McpRequestContext。
          // `watchClientDisconnect` 只在「宿主没收到完整响应就走了」时 abort（正常写完不 abort，
          // 杜绝假取消）；`dispose()` 必须在 finally 里调用 —— 长连接上不摘除会残留闭包。
          const disconnect = watchClientDisconnect(res);
          try {
            const body = await readBody(req);
            const parsed = body ? JSON.parse(body) : null;
            // K-N1 通道 2（精确归因）：委派回合内层回连的 mcp 端点由桥拼成 `…/mcp?dtid=<委派traceId>`
            // （`buildMcpConfig`），此处解析注入 → handler 拿到 `ToolContext.delegationId` →
            // provider 审计落 `channel:'a2a'` + `ext.delegationId`，账本据此**精确**归入 executed。
            // 无 dtid（纯宿主直调）→ reqCtx 缺席 → ToolContext 逐字节旧形态，零回归。
            const dtid = url.searchParams.get('dtid') ?? undefined;
            // 装配交 `buildMcpRequestContext`（**存在性纪律**：dtid/signal 各自条件展开，
            // 两者都缺席 ⇒ 返回 undefined ⇒ 与接通前的调用形态逐字节等价）。
            const result = await mcp.handleRequest(parsed, buildMcpRequestContext(dtid, disconnect.signal));
            if (result === null) {
              res.writeHead(202).end();
              return;
            }
            sendJson(res, 200, result);
            return;
          } finally {
            disconnect.dispose();
          }
        }

        /* ---- S-3（方案 B，设计 §5.2）：回执查询端点（只读投影，零链体积增长） ----
         * GET /audit/receipt?traceId=<委派或单次调用 traceId>
         *  - 链上记录（证明「发生过」，附 seq/hash 供与链对齐校验）；命中委派壳 complete 条目时
         *    按 `ext.underlying[].auditSeqs` 把内层记录一并展开（内层条目经通道 2 缺席时
         *    也可由壳聚合清单定位 —— 委派 traceId 为唯一取证键）；
         *  - 进程内**有界脱敏**环形回执（字段级重建；重启即失，§10-4 已登记信任局限）。
         * 安全边界：与 /health 同级（服务仅 loopback 监听）；只读、无任何状态变更。
         * 未命中 → `{ records: [] }` + HTTP 200（设计 §9-F-3：非 4xx）。
         */
        if (path === '/audit/receipt' && req.method === 'GET') {
          const traceId = url.searchParams.get('traceId') ?? '';
          if (!traceId) {
            sendJson(res, 400, { error: 'missing traceId' });
            return;
          }
          const records = await audit.query({ traceId });
          // 仅当命中壳 complete 条目（其 ext 聚合了内层 seq）时才付出一次全量读取代价 ——
          // 有界：全量查询限量 5000，杜绝无上限扫描（链体量随运行增长）。
          const needExpand = records.some((r) => r.ext?.kind === 'delegation-complete');
          const allRecords = needExpand ? await audit.query({ limit: 5000 }) : undefined;
          // 环形回执：委派级按账本内层 traceId 展开（存活期内）+ 直查 traceId 自身；
          // receiptLookup 兜底**账本已收口**的场景 —— 按链上展开记录（ext.underlying.auditSeqs
          // → 内层条目）的 traceId 反查缓存，使事后取证同样能拿到字段级回执。
          const innerTraceIds = ledgerReg.get(traceId)?.innerCallTraceIds() ?? [];
          const receipts = receiptCache.getAll([...innerTraceIds, traceId]);
          sendJson(res, 200, buildReceiptResponse({
            traceId,
            records,
            allRecords,
            receipts,
            receiptLookup: (ids: readonly string[]) => receiptCache.getAll(ids),
          }));
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

        /* ---- L1 运维端点（设计 §6）：常驻会话复位 + 故障注入（T04 实体化转发） ----
         * POST /admin/llm-session/reset[?faultInjection=1]
         *  - **env 门控**：`WINVM_ADMIN_ENDPOINT=1` 才可达，否则 404（与路由未注册等价，
         *    不新增鉴权体系 —— 服务仅 loopback 监听，信任面与 /health 同级）；
         *  - 复位语义（§6.1）：杀子进程 → spawnAttempts 归零 → disabled → stopped，
         *    **保留 lastError/lastErrorAt**（D11 两信号分离）；非 disabled 态调用**幂等**不报错；
         *  - `?faultInjection=1`（§6.2）：复位后注入「每次 spawn 立即错误退出」，
         *    使后续 1+maxRestarts 次委派**确定性**进入 disabled（K-N1 回归不依赖真机抖动）；
         *    不带参数即复位**并清除**注入；
         *  - 日志只走 warn（运维面与证据面分离：**不入哈希链**）。
         */
        if (path === '/admin/llm-session/reset' && req.method === 'POST') {
          if (process.env['WINVM_ADMIN_ENDPOINT'] !== '1') {
            sendJson(res, 404, { error: 'not found', path });
            return;
          }
          const faultInjection = url.searchParams.get('faultInjection') === '1';
          logger.warn('管理端点：LLM 常驻会话复位', { faultInjection, provider: provider?.id ?? '(degraded)' });
          if (!provider || provider.llmSessionReset === undefined) {
            // provider 不实现（非 LLM provider / degraded）→ 如实报告不可用，绝不假成功
            sendJson(res, 503, { ok: false, error: 'llmSessionReset 不可用（provider 未实现或 degraded）' });
            return;
          }
          const before = provider.llmSessionHealth?.();
          const after = provider.llmSessionReset();
          const injected = faultInjection ? provider.llmSessionInjectFault?.(true) ?? false : provider.llmSessionInjectFault?.(false) ?? false;
          sendJson(res, 200, {
            ok: true,
            faultInjection,
            spawnFaultInjected: injected,
            before: before ?? null,
            after: after ?? null,
          });
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
  /**
   * `/health.security` 快照（ARCH-07，判据⑤的**事实面**）。
   *
   * 刻意抽成独立函数而不是内联：`authMode` 必须与守卫的生效判据**逐字同源**
   * （都经 `resolveBearerToken` 的 O-9 双条件），内联复制条件就是未来漂移的入口。
   *
   * - `loopbackOnly` —— V1 恒 `true`：`validateServiceConfig` 对非回环绑定**恒定 error**，
   *   不再看 `security.requireLoopbackBind`（该开关自 Phase 1 起失效）。把它报成
   *   可配事实就是谎言，故按「不可关」的约束本身来写。
   * - `boundLoopback` —— 读**实际** `server.address()`；listen 之前（或 address 缺席）
   *   回落配置值 ⇒ 保守不谎报。
   * - `endpointAllowlist` —— 契约类型是 `never`（负空间）：本实现**不**产出该键。
   * - **P2-T5 附加两键**（`bearerSelfCheck` / `innerReconnect`）—— 喂的是**启动期那一份**
   *   常驻结论（`selfCheckAuthMode` 与守卫挂载同源）；刻意不在请求期重复求值：探针是
   *   启动期事实，每次 /health 重复探测等于把取证面变成 DoS 自我放大面。
   */
  function buildSecurityHealth(): SecurityHealth {
    // 实际监听地址优先；`server.address()` 在 listen 前返回 null ⇒ 回落配置值（保守不谎报）。
    const actualAddress = server.address();
    const boundHost =
      typeof actualAddress === 'object' && actualAddress !== null
        ? actualAddress.address
        : cfg.server.host;
    // 纯函数在 `http-guard`（可脱服务单测）；本处只负责喂「实测地址」这一服务闭包事实
    // + 启动期自检/回连两个快照（条件展开，缺席即旧形状）。
    //
    // P2-T6：透出面喂**观测面**（`innerReconnectObserved`）—— 运行期回连探针的实证结论
    // （ok/broken）应在此显形；探针不跑（默认态 / `bearerEnvName` 缺席 / 守卫未挂载）
    // 时该变量逐字等于配置面结论 ⇒ 默认态 `/health` 形状零回归。
    // 判决面（fail-closed 与链上条目）仍喂配置面 const，二者刻意分离（见装配点不变量）。
    const innerReconnect: InnerReconnectHealth = innerReconnectObserved;
    return buildSecurityHealthSnapshot({
      enforceBearer: cfg.security.enforceBearer,
      tokenEnv: cfg.security.tokenEnv,
      boundHost,
      selfCheck: bearerSelfCheck,
      innerReconnect,
    }) as SecurityHealth;
  }

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
      // CL-K3R E-3（纯附加）：审批真值三态指纹透传 —— adapter 的 health() 已把它放在
      // providerHealth 顶层（HealthStatus.approvalTruth），此处不透传就会在最后一跳被丢弃
      //（T05 真机实测命中：/health.provider 缺 approvalTruth ⇒ shadow 轮不可证）。
      ...(providerHealth?.approvalTruth ? { providerApprovalTruth: providerHealth.approvalTruth } : {}),
      session,
      psBridge,
      capabilities: { count: registry.size(), available: exposedIds.size },
      // D30：透出断裂定位与原因（向后兼容：entries / chainValid 字段保留）
      // ARCH-06（判据③）：追加**校验范围**四字段。`freshChainOnStart:true` ⇒ `scope:'session'`，
      // 即本处 `chainValid` 只担保「本轮运行期分片完好」；跨轮历史的证据由启动期
      // `chain-archive-verify` 条目提供。`chainValid` 的既有语义与取值路径**逐字不变**
      // （只是旁边多说了实话），`cl019`/既有断言不受影响。四字段皆 `?:` 纯附加：
      // 旧 AuditSink 实现（未回吐 scopeInfo）⇒ 字段整体缺席 ⇒ 读者退回旧理解。
      audit: {
        entries: chain.entries,
        chainValid: chain.valid,
        ...(chain.brokenAt !== undefined ? { brokenAt: chain.brokenAt } : {}),
        ...(chain.reason ? { reason: chain.reason } : {}),
        ...(chain.scope !== undefined ? { scope: chain.scope } : {}),
        ...(chain.shardsVerified !== undefined ? { shardsVerified: chain.shardsVerified } : {}),
        ...(chain.shardsTotal !== undefined ? { shardsTotal: chain.shardsTotal } : {}),
        ...(chain.shardsArchived !== undefined ? { shardsArchived: chain.shardsArchived } : {}),
      },
      /* ---- ARCH-07（判据⑤事实面）+ ENG-08：信任边界与有界化的运行时事实 ----
       *
       * `authMode` 与守卫的生效判据**同源**（都走 `resolveBearerToken` 的双条件 O-9），
       * 杜绝「health 说 enforced、守卫其实停用」的自相矛盾。`bearer-configured-missing`
       * 是必须显形的降级态（配置意图开了、生效事实没开）——不得静默当 enforced。
       *
       * `boundLoopback` 读**实际** `server.address()` 而不是配置值：配置正确但被
       * 反向代理/改写的场景只有实测值能证。`server` 在 `buildHealth` 定义之前创建，
       * 而 `bridgeCtx.healthSnapshot` 只在请求期回调 ⇒ 无 TDZ 风险（listen 前
       * `address()` 返回 undefined ⇒ 回落配置值，保守不误报 true）。
       */
      security: buildSecurityHealth(),
      // ENG-08：TaskStore 有界化事实（纯附加）。`live` 是内存驻留量，
      // 配合 `maxTasks` 让运维能看出「快到顶了」而不是等驱逐发生。
      // P2-T7（L1，纯附加）：再补 `evictedCount` —— 「已经回收了多少」此前完全不可见
      // （QA §4-B4 的病灶：驱逐无计数无日志无回调）。与链上 `task-evicted` 条目的
      // `ext.evict.evictedTotal` 同一读数源（都是 `taskStore.evictedCount()`）⇒ 两面互为对账，
      // 不可能出现「体检说逐了 5 条、链上账本说 8 条」的自相矛盾。
      tasks: {
        live: taskStore.size(),
        maxTasks: TASK_STORE_MAX_TASKS,
        terminalTtlMs: TASK_STORE_TERMINAL_TTL_MS,
        evictedCount: taskStore.evictedCount(),
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

  /* ---- P2-T6：VM 内回连**运行期探针**（listen 之后 fire-and-forget） ----
   *
   * 为什么必须放在 listen **之后**：这是自环探针（打自己的 `/mcp`），放在 listen 之前
   * 等于自己等自己 ⇒ 启动依赖死锁。拒启判据已在 listen 之前按**配置面**求完值
   * （见上方 `failClosedDecision`），本探针只升级**观测面**（`/health.security.innerReconnect`）。
   *
   * 只在「守卫生效 ∧ provider 配了 bearerEnvName」时跑（其余形态跑了也只得 unverified，
   * 白增一次自环流量），且**只有实证结论（ok / broken）才覆盖**启动期的配置面结论 ——
   * `unverified`（探针自身故障）绝不覆盖（PR3 + 不变量 3）。
   */
  if (guardActive) {
    const rawBearerEnvName = activeProviderOptions?.['bearerEnvName'];
    const bearerEnvName = typeof rawBearerEnvName === 'string' ? rawBearerEnvName.trim() : '';
    const providerEndpoint =
      typeof activeProviderOptions?.['endpoint'] === 'string'
        ? (activeProviderOptions['endpoint'] as string)
        : undefined;
    if (bearerEnvName) {
      void (async (): Promise<void> => {
        try {
          const probed = await probeInnerReconnect({
            endpoint: providerEndpoint ?? `http://${cfg.server.host}:${port}/mcp`,
            bearerEnvName,
            // 拒启后 serviceClosed 已置位 ⇒ 探针结论不得再改观测面（此时服务已收口）
          });
          if (serviceClosed) return;
          if (probed.status === 'unverified') {
            logger.info('回连探针未得实证结论（保持配置面判定，不覆盖观测面）', {
              reason: probed.reason,
              innerReconnect: innerReconnectObserved.status,
            });
            return;
          }
          // 实证结论（ok / broken）⇒ 只升级观测面；配置面 const 保持不动（拒启依据与链上条目不变）。
          innerReconnectObserved = probed;
          logger.info('回连探针实证结论（升级 /health.security.innerReconnect）', {
            innerReconnect: probed.status,
            reason: probed.reason,
          });
        } catch (e) {
          // 探针函数自身按契约不抛（全分支返回 unverified）；此 catch 只兜装配漂移，
          // 任何情况下都不得让观测面的异常影响服务态。
          if (!serviceClosed) {
            logger.warn('回连探针异常（不影响服务，观测面保持配置面结论）', { error: String(e) });
          }
        }
      })();
    }
  }

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
      // P2-T5：先置收口位，使**在途**的自检 fire-and-forget 段（落链/告警）不再向已关闭的
      // sink 写条目、也不再往已 `logger.close()` 的出口打日志 —— 静默退化不允许出现在退出路径上。
      serviceClosed = true;
      sessionMonitor.stop();
      // ENG-01（判据⑥）：先停 TTL 清扫定时器，使收尾竞态里不再有"边关边扫"的写链；
      // `unref()` 已保证未决审批不拖住退出，`close()` 再保证关闭后定时器不复活。
      pendingApprovals.close();
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
  // 两个概念**刻意分离**（U-P0-3 A1）：
  //  - `hasDryRunParam(cap)`：input schema 里有 `dryRun` 属性 ⇒ 「**可以预览**」（实现接得住这个开关）；
  //  - `cap.supportsDryRun === true`：服务端声明该能力 `dryRun=true` 时**确凿零系统变更**
  //    ⇒ 策略引擎才允许「**免审批**」旁路（`engine.ts` 6 的双条件）。
  // 预览文案必须按后者的真实结论书写：旧文案无条件写「免审批直接放行」，对未声明的能力是
  // **虚假承诺**（调用方会以为传 dryRun 就能跳过审批），故按 `dryRunExempt` 分叉。
  const dryRunPreviewable = hasDryRunParam(cap);
  const dryRunExempt = dryRunPreviewable && cap.supportsDryRun === true;
  return {
    capabilityId: cap.id,
    risk: cap.risk,
    destructive: cap.destructive,
    requiresSession: cap.requiresSession,
    params,
    // D11：对支持 dryRun 的能力附带 dry-run 计划摘要，
    // 使 Skill 规定的「L3 先 dry-run 再确认」在审批预览里就可看到将要发生什么。
    ...(dryRunPreviewable
      ? {
          dryRun: {
            supported: true,
            // U-P0-3（A1）：是否真能免审批 = 服务端声明位，而非调用方是否传了 dryRun
            exempt: dryRunExempt,
            requested: params['dryRun'] === true,
            plan: !dryRunExempt
              ? `本能力未在注册表声明 supportsDryRun，${cap.id} 传 dryRun 仍需人工审批（免批旁路仅对服务端声明「dryRun 零系统变更」的能力开放）`
              : params['dryRun'] === true
                ? `dryRun=true：仅返回 ${cap.id} 的执行计划，不改动系统状态（免审批）`
                : `可传 dryRun:true 免审批预览 ${cap.id} 的影响后再决定是否真实执行`,
            hint: dryRunExempt
              ? 'params.dryRun === true 且能力声明 supportsDryRun 时免审批直接放行（dry-run 不改变系统状态）'
              : '免审批旁路需要**服务端能力声明**（supportsDryRun）+ 调用方 dryRun 两个条件同时成立',
          },
        }
      : {}),
    note:
      cap.risk === 'L3'
        ? 'L3 高危操作：将造成不可恢复的影响，请逐项确认 impact 清单'
        : 'L2 破坏性操作：将改变系统状态，请确认影响范围',
  };
}

/**
 * 能力输入 schema 是否声明了 `dryRun` 参数（用于 D11 的 dry-run 免审批预览）。
 *
 * ⚠ 语义边界（U-P0-3 A1）：本函数回答的是「**可以预览**」（schema 接得住这个开关），
 * **不是**「**可以免批**」。免批的权威判据是注册表声明位
 * `CapabilityDefinition.supportsDryRun`（由 `@winvm/core` 策略引擎消费）—— 把两者混为一谈
 * 正是旧实现「预览文案承诺免批、实际无人校验」的病灶。
 */
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

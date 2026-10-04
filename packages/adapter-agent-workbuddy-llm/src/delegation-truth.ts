/**
 * K-N1 委派真实性判据（从 `bridge.ts` / `index.ts` 拆出的**纯逻辑件**）。
 *
 * 为什么要拆（缺陷根因，见 `docs/design/kn1-delegation-audit-contract.md` §1）：
 * K5 回执反查 `reconcileExecutionTruth` 在「本任务从未 raise 审批」时**按设计退场**
 * （`bridge.ts:914` 的 `raisedApprovals.size === 0` 短路），导致委派回合**零工具调用**
 * 也能静默 `completed`，且链上无一条能证伪它的记录。
 *
 * 本文件把完成判据从「审批回执反查」**升格为「委派账本反查」**：
 *   1. `reconcileDelegationTruth` —— 完成声称 + 服务端账本零活动 → `failed(NO_EXECUTION_RECEIPT)`；
 *      **只受 taskId 门控**，不受 `replayEnabled`/`k5ReplayActive` 审批灰度门控（账本参照物与审批灰度无关）。
 *   2. `evaluateDisabledRejection` —— 常驻启用态（`persistent=true`）+ `state=disabled` 的委派
 *      **入口显式拒绝**（`LLM_SESSION_DISABLED`），使「disabled=故障」与「单次 -p=设计」两种部署态可区分。
 *
 * 纪律（对齐 `approval-replay.ts` 的纯逻辑拆分）：
 *   - 全部为**无副作用**纯函数：证据只从注入的 `probe` 取，本文件不碰审计链、不起 HTTP、不 spawn 进程；
 *   - **fail-open**：`probe` 抛错 → 透传 base + `logger.warn` 恰一条，绝不因取证故障挂死委派
 *     （对齐 approval-replay「写失败不影响拦截结果」纪律，设计 §9-B-3）；
 *   - 判「零活动」取**严格**口径（三通道全空），判「有活动」取**宽松**口径（任一非零即放过）——
 *     宁可放过 completed，不可错杀合法完成（设计 §2.3 不变式）。
 */

import type {
  ApprovalWaitQuery,
  DelegationActivityCount,
  DelegationTruthProbe,
  LlmSessionState,
  PendingApprovalFact,
} from '@winvm/contracts';
import { makeError } from '@winvm/contracts';

import { reconcileApprovalWait } from './bridge.js';
import type { LlmGoalResult } from './bridge.js';

/* --------------------------- 完成声称识别（从 bridge.ts 迁入，单一来源） --------------------------- */

/**
 * LLM 文本中的「目标已完成」声称特征（K5 回执反查与 K-N1 账本反查**共用**的触发面）。
 *
 * 真机实证（K5 根因）：宿主批准后 LLM 没有重发工具调用，却直接文本自宣完成（「已卸载」「已完成」）
 * → A2A 任务 completed 而服务端零执行记录（假成功）。K5 纪律：**服务端结构化回执是唯一完成证据**。
 *
 * ⚠ 迁出原 `bridge.ts:548`（`const` → 本文件 `export const` 并由 bridge re-export），
 * 使两条判据（审批回执反查 / 委派账本反查）共享**同一份**模式，杜绝文案漂移导致的判据分叉。
 */
export const COMPLETION_CLAIM_PATTERN =
  /(已完成|已卸载|已删除|已移除|已安装|卸载成功|删除成功|安装成功|执行成功|任务完成|目标完成|uninstalled?|deleted?|removed?|completed successfully)/i;

/* ============================ 判据 1：NO_EXECUTION_RECEIPT ============================ */

/** `reconcileDelegationTruth` 的注入面（全部可选缺席即旧行为 —— 零回归）。 */
export interface DelegationTruthDeps {
  /** 本委派的 traceId（= `GoalRequest.traceId` = 账本键）；缺席 → 门 2 直接透传 */
  readonly delegationTraceId?: string;
  /** 本委派的 A2A 任务 id；缺席（纯 MCP 直调）→ 门 2 直接透传 */
  readonly taskId?: string;
  /** 服务端账本探针（`vm-service` 实现，经 `BridgeContext` cast 注入；缺席 → 透传） */
  readonly probe?: DelegationTruthProbe;
  /** 告警出口（probe 故障时恰记一条；由桥接到服务 logger） */
  readonly warn?: (msg: string, meta?: Record<string, unknown>) => void;
}

/** 零活动改判时的 steps 文案（与既有 `reconcileExecutionTruth` 的文案**可区分**，便于取证归因）。 */
const ZERO_ACTIVITY_STEP_SUMMARY = '委派回合零服务端活动记录，完成声称不予采信';

/**
 * K-N1 判据 1：**委派账本反查**（放在 `runGoalInner` 收口链最前，先于既有 `reconcileExecutionTruth`）。
 *
 * 判定表（设计 §3.2 / §9-A-2）：
 *   门 1 `base.ok === false` → 透传（不重复改判，两判据互斥）；
 *   门 2 非委派上下文（无 `taskId` 或无 `delegationTraceId`）→ 透传（MCP 直调语义零改动）；
 *   门 3 无完成声称 → 透传（文本无承诺时改判是过度推断，登记局限 §10-1）；
 *   门 4 未注入 probe / probe 抛错 → 透传 + warn 恰一条（fail-open）；
 *   证据 `total === 0` → `failed(NO_EXECUTION_RECEIPT)`，`steps` **全量**改 `ok:false`（保留原长度）；
 *   否则透传（executed 或 blocked 或 wild 任一非零即「到过服务端」—— 保守采信）。
 *
 * 顺序理由（设计 §3.3）：零活动改判后 `base.ok===false`，既有 `reconcileExecutionTruth`
 * 的 `!base.ok` 透传分支自然不重复改判 → 两判据不可能产生矛盾终态。
 */
export async function reconcileDelegationTruth(
  base: LlmGoalResult,
  finalText: string,
  deps: DelegationTruthDeps = {},
): Promise<LlmGoalResult> {
  if (!base.ok) return base; // 门 1
  const { taskId, delegationTraceId, probe } = deps;
  if (!taskId || !delegationTraceId || !probe) return base; // 门 2 / 门 4（未注入=旧行为）
  if (!COMPLETION_CLAIM_PATTERN.test(finalText)) return base; // 门 3

  let activity: DelegationActivityCount;
  try {
    activity = await probe.delegationActivity(delegationTraceId);
  } catch (e) {
    // fail-open：取证件故障绝不挂死委派（设计 §9-B-3）
    deps.warn?.('委派账本反查探针异常（透传原结果，不改判）', {
      delegationTraceId,
      error: String(e),
    });
    return base;
  }

  if (activity.total > 0) return base; // 有活动证据 → 采信

  return {
    ...base,
    ok: false,
    summary: `执行回执缺失：委派回合服务端零活动记录（executed=0/blocked=0/wild=0），完成声称「${base.summary.slice(0, 200)}」不予采信`,
    steps: base.steps.map((s) => ({ ...s, ok: false, summary: ZERO_ACTIVITY_STEP_SUMMARY })),
    // reason 逐字复用 bridge.ts:929-931 既有值（同一 reason 断言，设计 §9-A-2-⑧）
    error: makeError('EXECUTION_FAILED', ZERO_ACTIVITY_STEP_SUMMARY, {
      reason: 'NO_EXECUTION_RECEIPT',
      details: {
        delegationTraceId,
        taskId,
        ledger: { executed: activity.executed, blocked: activity.blocked, wild: activity.wild },
      },
    }),
  };
}

/* ============================ 判据 2：disabled 显式拒绝 ============================ */

/* ==================== 判据 3（CL-K3R）：APPROVAL_REQUIRED 结构化真值 ==================== */

/**
 * `reconcileApprovalTruth` 的委派入参面（只需判定所需字段；与 `LlmGoalInput` 结构化兼容）。
 */
export interface ApprovalTruthInput {
  /** A2A 任务 id；缺席（纯 MCP 直调 / 非委派）⇒ 门 1 直接回退文本兜底 */
  readonly taskId?: string;
  /** 委派 traceId（R1 精确归因键） */
  readonly traceId?: string;
  /** 委派能力面（R3 收窄串台；空/缺席 ⇒ 不按能力过滤） */
  readonly capabilities?: readonly string[];
  /** 服务端探针（也可经 `ctx.delegationProbe` 注入） */
  readonly probe?: DelegationTruthProbe;
  readonly startedAtMs?: number;
}

/** `reconcileApprovalTruth` 的运行上下文面（与桥 `RunContext` 结构化兼容）。 */
export interface ApprovalTruthRunCtx {
  /** 本委派进入时刻（ms，R3 窗口下界） */
  readonly started?: number;
  readonly startedAtMs?: number;
  /** 本委派已 raise 过的 approvalId（门 6 去重） */
  readonly raised?: ReadonlySet<string>;
  /** 本委派已登记的服务端执行回执（approvalId → 回执；**有回执**的审批不被门 6 跳过，见下） */
  readonly receipts?: ReadonlyMap<string, unknown>;
  /** 委派 traceId（dtid 注入后的归因键） */
  readonly delegationId?: string;
  /** 服务端探针（cast 注入形态，与 `input.probe` 二选一） */
  readonly delegationProbe?: DelegationTruthProbe;
}

/** `reconcileApprovalTruth` 的注入面（全部可选；缺席即回退文本兜底 —— 零回归）。 */
export interface ApprovalTruthDeps {
  readonly input?: ApprovalTruthInput;
  readonly ctx?: ApprovalTruthRunCtx;
  /** 灰度开关：`false` ⇒ 门 2 整体短路（逐字 = R19F 后现状）；缺席 ⇒ `true` */
  readonly enabled?: boolean;
  /** `shadow` 态：命中时**只 warn、不改判**（埋点对拍，SK-K2） */
  readonly shadow?: boolean;
  /** 服务端探针（顶层形态；缺席时回退 `ctx.delegationProbe` / `input.probe`） */
  readonly probe?: DelegationTruthProbe;
  readonly warn?: (msg: string, meta?: Record<string, unknown>) => void;
}

/** 命中改判时的 steps 文案（与文本兜底路径**可区分**，便于取证归因）。 */
const APPROVAL_TRUTH_STEP_SUMMARY = '等待审批（未执行完成·服务端结构化判定）';

/** 命中改判的 `details.source` 标记（服务端权威来源，供与 A5 文本路径样本比对） */
const APPROVAL_TRUTH_SOURCE = 'server-ledger';

/**
 * CL-K3R 判据 3：**服务端结构化未决审批反查**（接在两处 `reconcileApprovalWait` 收口点，
 * 先于 `maybeResume`；文本启发式降级为**兜底**，函数体一字不改 —— SK-9 / D-2）。
 *
 * 判定表（自上而下短路，设计 §5.3）：
 *   门 0 `!base.ok` → 透传（已是失败态，不重复改判；**D-1 结论优先**）；
 *   门 1 无 `taskId`（非委派 / 纯 MCP 直调）→ 回退文本兜底（SK-1：无归属不介入）；
 *   门 2 灰度开关 `off` → 回退文本兜底（一键回滚面）；
 *   门 3 无 probe 或 `probe.approvalWait` 缺席 → 回退文本兜底（兼容旧服务端 / 单测，**绝不 warn**）；
 *   门 4 探针抛错 → 回退文本兜底 + **warn 恰一条**（fail-open，绝不挂死委派）；
 *   门 5 `facts` 为空 → 回退文本兜底（结构化说「无未决审批」时绝不强行改判）；
 *   门 6 所有 fact 都「已 raise **且尚无服务端回执**」→ 回退文本兜底（不二次挂起）；
 *   命中 → 改判 `ok:false` + `APPROVAL_REQUIRED`（服务端权威 approvalId / risk）。
 *
 * **单向 fail-closed**（SK-K6）：只做 `ok:true → ok:false`，绝不反向。门 0 +
 * 「只在有结构化证据时改判」共同保证本函数在**任何**路径上都不可能制造新的假成功。
 *
 * 门 6 的适用前提（实施偏差 E-1，见 `docs/design/cl-k3r-impl-progress.md` §6）：
 * 仅当该 approvalId **尚无服务端回执**时才跳过 —— 已有回执说明宿主已批、服务端已重放，
 * 此时必须让 `maybeResume` 走 `applyReceipt` 以**真实回执**收口；否则续跑轮会返回
 * `completed`，反而掩盖「回执其实失败」这一**新的假成功**。
 */
export async function reconcileApprovalTruth(
  base: LlmGoalResult,
  finalText: string,
  deps: ApprovalTruthDeps = {},
): Promise<LlmGoalResult> {
  if (!base.ok) return base; // 门 0：已是失败态（含 D-1 两道门的结论）→ 绝不重复改判

  const input = deps.input;
  const ctx = deps.ctx;
  const taskId = typeof input?.taskId === 'string' && input.taskId ? input.taskId : undefined;
  if (!input || !taskId) return reconcileApprovalWait(base, finalText); // 门 1：无归属不介入

  if (deps.enabled === false) return reconcileApprovalWait(base, finalText); // 门 2：一键回滚

  const probe = deps.probe ?? ctx?.delegationProbe ?? input.probe;
  const approvalWait = probe?.approvalWait;
  if (typeof approvalWait !== 'function') return reconcileApprovalWait(base, finalText); // 门 3：探针缺席 = 旧行为

  const delegationTraceId =
    (typeof ctx?.delegationId === 'string' && ctx.delegationId ? ctx.delegationId : undefined) ??
    (typeof input.traceId === 'string' ? input.traceId : '');
  const startedAtMs = ctx?.started ?? ctx?.startedAtMs ?? input?.startedAtMs ?? Date.now();
  const query: ApprovalWaitQuery = {
    delegationTraceId,
    startedAtMs,
    ...(input.capabilities && input.capabilities.length > 0
      ? { capabilities: [...input.capabilities] }
      : {}),
  };

  let raw: readonly PendingApprovalFact[];
  try {
    const awaited = await approvalWait.call(probe, query);
    raw = Array.isArray(awaited) ? awaited : [];
  } catch (e) {
    // 门 4：fail-open —— 取证故障绝不改变 base.ok，只记恰一条 warn
    deps.warn?.('未决审批反查探针异常（透传原结果，不改判）', {
      delegationTraceId,
      taskId,
      error: String(e),
    });
    return reconcileApprovalWait(base, finalText);
  }

  const facts = raw.filter((f) => !!f && typeof f.approvalId === 'string' && f.approvalId.length > 0);
  if (facts.length === 0) return reconcileApprovalWait(base, finalText); // 门 5

  const raised = ctx?.raised;
  const receipts = ctx?.receipts;
  const pending = facts.filter(
    (f) => !(raised?.has(f.approvalId) === true && receipts?.has(f.approvalId) !== true),
  );
  if (pending.length === 0) return reconcileApprovalWait(base, finalText); // 门 6

  const ordered = [...pending].sort((a, b) => (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0));
  const fact = ordered[0]!;
  const rest = ordered.slice(1);

  if (deps.shadow === true) {
    // shadow 态：只埋点对拍（结构化结论 vs 文本启发式结论），**不改判**
    deps.warn?.('[shadow] 未决审批结构化命中（不改判，供对拍）', {
      taskId,
      delegationTraceId,
      approvalId: fact.approvalId,
      attribution: fact.attribution,
      risk: fact.risk,
      structuredVerdict: 'waiting-approval',
      textHeuristicVerdict: reconcileApprovalWait(base, finalText).ok
        ? 'not-waiting'
        : 'waiting-approval',
      others: rest.map((f) => f.approvalId),
    });
    return base;
  }

  if (rest.length > 0) {
    deps.warn?.('同一委派存在多个未决审批（请宿主逐条处理）', {
      taskId,
      delegationTraceId,
      approvalId: fact.approvalId,
      others: rest.map((f) => f.approvalId),
    });
  }

  return {
    ...base,
    ok: false,
    summary:
      `等待审批：高危操作被宿主审批闸拦截（APPROVAL_REQUIRED），目标「${base.summary}」未执行完成，` +
      `须经宿主人工审批后经 MCP 直调通道续跑；approvalId=${fact.approvalId}` +
      `（来源=服务端结构化判定·${fact.attribution}）`,
    steps: base.steps.map((s) => ({ ...s, ok: false, summary: APPROVAL_TRUTH_STEP_SUMMARY })),
    error: makeError('APPROVAL_REQUIRED', '服务端结构化记录显示存在未决审批，操作未执行', {
      details: {
        approvalId: fact.approvalId,
        capabilityId: fact.capabilityId,
        risk: fact.risk,
        attribution: fact.attribution,
        source: APPROVAL_TRUTH_SOURCE,
        ...(rest.length > 0 ? { others: rest.map((f) => f.approvalId) } : {}),
      },
    }),
  };
}

/* ============================ 判据 2：disabled 显式拒绝 ============================ */

/** `evaluateDisabledRejection` 的输入（全部为服务端可得事实，不读 LLM 文本）。 */
export interface DisabledRejectionInput {
  /** 本次委派是否来自 A2A（`GoalRequest.taskId` 存在） */
  readonly hasTaskId: boolean;
  /** 配置是否启用常驻（`WINVM_LLM_PERSISTENT` 缺省 true）—— 「disabled=故障」态的前提 */
  readonly persistent: boolean;
  /** 常驻会话态（provider 未上报时传 undefined → 视为不可判定，不拒绝） */
  readonly sessionState?: LlmSessionState;
}

/** 判定结果：`reject=false` 即放行（旧行为）。 */
export interface DisabledRejectionVerdict {
  readonly reject: boolean;
  readonly reason?: 'LLM_SESSION_DISABLED';
}

/**
 * K-N1 判据 2：`disabled` **显式拒绝**（设计 §4.1 / §4.2）。
 *
 * 真值表（12 例，设计 §9-A-3）：**仅** `(有 taskId, persistent=true, state='disabled')` → 拒绝。
 * 两个边界（钉死「两种降级语义可区分」）：
 *   - `persistent=false`（显式选择「单次 -p 即设计」）：无「disabled=异常」概念 → **不拒绝**，
 *     委派正常走单次 -p，假完成由判据 1 的账本反查兜底；
 *   - 无 taskId（纯 MCP 直调）：零改动。
 *
 * 拒绝发生在 `bridge.runGoal` **之前**并直接 return，不进 `shouldDegrade` 分支
 * → 确定性执行器模板（E4 通道 B 型）不因此失去委派入口（设计 §4.3）。
 */
export function evaluateDisabledRejection(input: DisabledRejectionInput): DisabledRejectionVerdict {
  if (!input.hasTaskId) return { reject: false };
  if (!input.persistent) return { reject: false };
  if (input.sessionState !== 'disabled') return { reject: false };
  return { reject: true, reason: 'LLM_SESSION_DISABLED' };
}

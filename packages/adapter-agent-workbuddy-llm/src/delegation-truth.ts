/**
 * K-N1 委派真实性判据（从 `bridge.ts` / `index.ts` 拆出的**纯逻辑件**）。
 *
 * 为什么要拆（缺陷根因，见 `docs/design/kn1-delegation-audit-contract.md` §1）：
 * K5 回执反查 `reconcileExecutionTruth` 在「本任务从未 raise 审批」时**按设计退场**
 * （`bridge.ts:1095` 的 `if (ctx.raised.size === 0) return base;` 短路；字段已由 `raisedApprovals` 改名为 `raised`），导致委派回合**零工具调用**
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
  ApprovalTruthAttribution,
  ApprovalWaitQuery,
  DelegationActivityCount,
  DelegationTruthProbe,
  LlmSessionState,
  PendingApprovalFact,
} from '@winvm/contracts';
import { makeError } from '@winvm/contracts';

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
    // reason 逐字复用 bridge.ts:1110 既有值（同一 reason 断言，设计 §9-A-2-⑧；真正定义见本文件 :110，reason 字符串本身不改）
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
  /**
   * A2A 任务 id。
   * P2-T8（G-a）起，门 1 的归属键为 **`taskId ?? traceId`**：本键与 `traceId` **双缺**
   * 才回退文本兜底（SK-1「无归属不介入」逐字保留）；只有 `traceId`（纯 MCP 直调 /
   * 委派 CLI 回连形态）⇒ 进入结构化反查，经 R1 精确归因或 R3 窗口归因命中。
   */
  readonly taskId?: string;
  /** 委派 traceId（R1 精确归因键；G-a 后同时是门 1 的兜底归属键） */
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

/**
 * 文本兜底函数的形状（= `bridge.ts` `reconcileApprovalWait` 的签名）。
 *
 * E-2 去环：本文件**不得** `import` `bridge.ts`（否则与「bridge → delegation-truth」的既有
 * 静态依赖构成包内环）。兜底实现改为**注入**：
 *   1. 首选 `deps.reconcileApprovalWait`（桥在每个调用点传入它自己的函数引用）；
 *   2. 缺席时取模块级默认（由 `bridge.ts` 加载时 `registerApprovalWaitFallback` 注册，
 *      供直接调用方 —— 如单测 —— 拿到与生产**同一份**实现）；
 *   3. 都没有 ⇒ 恒等透传（fail-open，逐字 = 无兜底时的旧行为）。
 */
export type ApprovalWaitFallback = (base: LlmGoalResult, finalText: string) => LlmGoalResult;

/** 模块级文本兜底默认实现（由 `bridge.ts` 注册；未注册时缺席） */
let approvalWaitFallback: ApprovalWaitFallback | undefined;

/**
 * 注册文本兜底默认实现 —— 由 `bridge.ts` 在模块加载时把自己的 `reconcileApprovalWait` 注入。
 *
 * 依赖方向仍为单向 `bridge.ts → delegation-truth.ts`（本文件零反向 import），
 * 且 SK-9 的落点（`bridge.ts:615`–`:638`）**一字不动**。
 */
export function registerApprovalWaitFallback(fn: ApprovalWaitFallback | undefined): void {
  approvalWaitFallback = fn;
}

/** `reconcileApprovalTruth` 的注入面（全部可选；缺席即回退文本兜底 —— 零回归）。 */
export interface ApprovalTruthDeps {
  readonly input?: ApprovalTruthInput;
  readonly ctx?: ApprovalTruthRunCtx;
  /**
   * 文本兜底实现（E-2 依赖注入，去静态环）。
   * 桥在每个收口点传入自己的 `reconcileApprovalWait`；缺席时回退模块级默认注册。
   */
  readonly reconcileApprovalWait?: ApprovalWaitFallback;
  /** 灰度开关：`false` ⇒ 门 2 整体短路（逐字 = R19F 后现状）；缺席 ⇒ `true` */
  readonly enabled?: boolean;
  /** `shadow` 态：命中时**只 warn、不改判**（埋点对拍，SK-K2） */
  readonly shadow?: boolean;
  /** 服务端探针（顶层形态；缺席时回退 `ctx.delegationProbe` / `input.probe`） */
  readonly probe?: DelegationTruthProbe;
  readonly warn?: (msg: string, meta?: Record<string, unknown>) => void;
  /**
   * P2-T8（G-b，**纯附加可选出参**）：决策出口回调 —— 每次判定**恰好调用一次**，
   * 将「本结论由哪一侧作出 + 在哪个门退场/命中」作为**事实**透出给调用方（桥写进
   * `RunContext.approvalTruth` → `LlmGoalResult` → `GoalResult` → 服务端
   * `delegation.complete` 的 `ext.approvalTruth`，从而可入链计数）。
   *
   * 为什么走 deps 出参而**不是**返回值字段（红线，设计定稿 §0 实证）：
   *  - `phase2-approval-wait-fallback` D1 钉门 0 `out === base` **引用相等** ⇒ 门 0 绝不能在
   *    `base` 上新增任何键；
   *  - 同文件 D3b 钉门 3「回退兜底且 **warns.length === 0**」⇒ 归因不得伪装成 warn；
   *  - 兜底路径（`reconcileApprovalWait`）的返回值形状受 SK-9 文案钉约束，不得夹带新键。
   *  ⇒ 唯一**零回归**通道是 deps 上的回调。
   *
   * 缺席即零行为变化（纯附加：不改判定、不改 warn 计数、不改返回值）。
   */
  readonly onTruthDecision?: (d: ApprovalTruthAttribution) => void;
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
 *   门 1 归属键**双缺**（`taskId` 与 `traceId` 都拿不到 = 非委派、无 trace 的裸调用）
 *     → 回退文本兜底（SK-1：无归属不介入）。**P2-T8 G-a**：归属键由「必须有 `taskId`」
 *     扩为 **`taskId ?? traceId`** ⇒ 纯 MCP 直调 / 委派 CLI 回连（无 `taskId` 有 `traceId`）
 *     同样进入结构化反查；串台安全由 `collectApprovalFacts` / `LedgerRegistry.blockedFor`
 *     的 **R2 精确排除**（他人 dtid 的未决审批绝不落到本回合）+ **R3 窗口 + 能力面过滤**兜住；
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
  /* ---------------------------------------------------------------------------
   * P2-T8（G-a + G-b）：归属键与归因出口**前置**声明。
   *
   * 为什么必须前置：G-b 的 `emit` 要在**门 0** 就能报出 `taskIdPresent` /
   * `traceIdPresent`，而 G-a 的门 1 判据本身就要读 `traceId`。原实现把 `taskId`
   * 声明在 `runFallback` 之后（设计定稿 §0 记为「TDZ 隐患」），本次一并消除该隐患
   * —— 声明序调整不改变任何判定结论（门序、返回值、warn 计数逐字不变）。
   * ------------------------------------------------------------------------- */
  const input = deps.input;
  const ctx = deps.ctx;
  const taskId = typeof input?.taskId === 'string' && input.taskId ? input.taskId : undefined;
  // G-a：归属键 = `taskId ?? traceId`（两者都要求**非空串**，与 taskId 判序逐字同构）
  const traceId = typeof input?.traceId === 'string' && input.traceId ? input.traceId : undefined;

  /**
   * G-b：把本次判定的**出口**写成可计数事实（每条路径恰一次；纯附加，回调缺席即零变化）。
   * 走 deps 出参而非返回值 —— 门 0 的「引用相等」钉（D1）与门 3 的「绝不 warn」钉
   * （D3b）都不受影响，见 `ApprovalTruthDeps.onTruthDecision` 注释。
   */
  const emit = (
    decidedBy: ApprovalTruthAttribution['decidedBy'],
    gate: string,
    approvalId?: string,
  ): void => {
    deps.onTruthDecision?.({
      decidedBy,
      gate,
      taskIdPresent: !!taskId,
      traceIdPresent: !!traceId,
      ...(approvalId ? { approvalId } : {}),
    });
  };

  if (!base.ok) {
    emit('pass-through', '门0');
    return base; // 门 0：已是失败态（含 D-1 两道门的结论）→ 绝不重复改判
  }

  // E-2：文本兜底经**依赖注入**取得（deps 显式传入 > bridge 模块级注册 > 恒等透传）
  // E-2b：第三级「恒等透传」不再静默 fail-open —— 命中时（fallback 缺席）按实际触发的门
  // emit 恰一条可检索 warn（文案与 meta 见任务书 §E-2b），返回值仍为 base（判定逐字不变）。
  const fallback = deps.reconcileApprovalWait ?? approvalWaitFallback;
  const runFallback = (gate: string, b: LlmGoalResult, text: string): LlmGoalResult => {
    emit('text-fallback', gate);
    if (!fallback) {
      deps.warn?.('[k3r] 文本兜底缺席（未注入且未注册）→ 恒等透传，等同无兜底旧行为', {
        gate,
        hasTaskId: !!taskId,
      });
      return b;
    }
    return fallback(b, text);
  };
  // shadow 对拍路径复用的兜底（缺席 = 恒等透传，与 E-2 语义逐字一致）
  const fallbackOrIdentity: ApprovalWaitFallback = fallback ?? ((b: LlmGoalResult) => b);
  // 门4 专用：探针异常路径已有自己的 warn（恰一条纪律），兜底缺席时**不**再叠加 E-2b warn
  // （任务书 §E-2b 的 gate 枚举为 门1/门2/门3/门5/门6，刻意不含门4）
  const fallbackOrIdentity4: ApprovalWaitFallback = fallbackOrIdentity;

  // 门 1（G-a）：归属键 `taskId ?? traceId` **双缺**才回退 —— SK-1「无归属不介入」逐字保留
  if (!input || (!taskId && !traceId)) return runFallback('门1', base, finalText);

  if (deps.enabled === false) return runFallback('门2', base, finalText); // 门 2：一键回滚

  const probe = deps.probe ?? ctx?.delegationProbe ?? input.probe;
  const approvalWait = probe?.approvalWait;
  if (typeof approvalWait !== 'function') return runFallback('门3', base, finalText); // 门 3：探针缺席 = 旧行为

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
    // G-b：归因走 emit（**不得**再走 runFallback ⇒ 不会叠加 E-2b warn，门 4 的
    // 「恰一条 warn」纪律逐字保持；emit 不是 warn）
    emit('text-fallback', '门4');
    return fallbackOrIdentity4(base, finalText);
  }

  const facts = raw.filter((f) => !!f && typeof f.approvalId === 'string' && f.approvalId.length > 0);
  if (facts.length === 0) return runFallback('门5', base, finalText); // 门 5

  const raised = ctx?.raised;
  const receipts = ctx?.receipts;
  const pending = facts.filter(
    (f) => !(raised?.has(f.approvalId) === true && receipts?.has(f.approvalId) !== true),
  );
  if (pending.length === 0) return runFallback('门6', base, finalText); // 门 6

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
      textHeuristicVerdict: fallbackOrIdentity(base, finalText).ok
        ? 'not-waiting'
        : 'waiting-approval',
      others: rest.map((f) => f.approvalId),
    });
    // G-b：shadow 命中 = 「结构化说该改判、但灰度只记不判」，归因单列一类
    // （不得写成 text-fallback —— 那会把对拍样本混进兜底命中率）
    emit('shadow', 'shadow-hit', fact.approvalId);
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

  // G-b：结构化命中（服务端权威改判）—— 与「兜底救了」可区分的**唯一**计数依据
  emit('server', '命中', fact.approvalId);

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

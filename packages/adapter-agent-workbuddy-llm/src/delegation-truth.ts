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

import type { DelegationActivityCount, DelegationTruthProbe, LlmSessionState } from '@winvm/contracts';
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

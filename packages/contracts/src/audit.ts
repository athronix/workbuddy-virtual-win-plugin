/**
 * 审计记录模型（SECURITY-GOVERNANCE.md §4）
 *
 * 哈希链：hash_n = SHA256(canonicalJson(record_n 去掉 hash 字段))
 *         record_n.prevHash = hash_(n-1)
 * 创世记录 prevHash = "GENESIS"
 */

import type { RiskLevel } from './risk.js';

export const GENESIS_HASH = 'GENESIS';

export interface AuditPrincipal {
  /** 宿主 Agent 标识，如 "workbuddy" */
  readonly host: string;
  /** 执行身份（VM 侧用户） */
  readonly user: string;
  /** 通道：mcp | a2a | internal */
  readonly channel: 'mcp' | 'a2a' | 'internal';
}

export interface AuditPolicyDecision {
  readonly allowed: boolean;
  /** 命中的规则描述，便于回溯"为什么允许/拒绝" */
  readonly matchedRule: string;
}

export interface AuditApproval {
  readonly approvalId: string;
  readonly approvedBy: string;
  readonly approvedAt: string;
  /** dry-run 预览内容哈希，防止审批与实际执行不一致 */
  readonly previewHash: string;
}

/* ==================== K-N1 增量：委派层审计真实性（纯附加可选） ====================
 *
 * 铁律（对齐 CL-018 的「纯附加」纪律）：`AuditRecord` 只增**一个可选顶层字段 `ext`**。
 *  - 旧读者忽略未知字段；
 *  - 新记录的 ext 整体进入 `canonicalJson` 哈希（chain.ts doAppend 对 ext 递归 redact）；
 *  - 历史记录校验不受影响 —— `verifyChain` 从记录自身重算（chain.ts:299-343）。
 * 写入方**必须**用条件展开（`...(x ? { ext: x } : {})`）而非显式 `ext: undefined`：
 * 后者会让 `JSON.stringify` 落盘时丢键，而哈希计算时键仍在 → 重算不一致（假断链）。
 */

/** 委派回合内「一次真实目标能力活动」的聚合（`ext.underlying` 元素） */
export interface DelegationActivity {
  readonly capabilityId: string;
  /** 该能力的聚合结果：任一记录 ok=true 即 true（保守口径） */
  readonly ok: boolean;
  /** 聚合的记录条数 */
  readonly count: number;
  /** 关联审批 ID（blocked 条目承载） */
  readonly approvalId?: string;
  /** 链上 seq 清单（取证指针；≤50 项） */
  readonly auditSeqs: readonly number[];
}

/** `ext.stepsSummary` 元素：壳步骤摘要（≤10 项，summary 各截 200 字符） */
export interface AuditStepSummary {
  readonly capabilityId: string;
  readonly ok: boolean;
  readonly summary?: string;
}

/**
 * 审计扩展字段（K-N1 设计 §2.2 / §7）。
 *
 * 全部可选：`delegation-start` 只带 kind/delegationId/taskId；`delegation-complete` 带终态与
 * 账本聚合；内层回连条目带 `{kind:'inner-call', delegationId, channel}`（通道 2 精确归因）。
 */
export interface AuditExt {
  readonly kind?: 'delegation-start' | 'delegation-complete' | 'inner-call';
  /** 委派 traceId（= A2A goal.traceId），与内层回连调用建立归因链 */
  readonly delegationId?: string;
  readonly taskId?: string;
  /**
   * ★ 核心事实断言字段：本委派回合服务端账本**零活动**。
   * **恒落**（即使终态 completed）—— 供「零调用但 completed」形态被 grep 出来人工审视（设计 §10-1）。
   */
  readonly zeroInnerCalls?: boolean;
  /** 真实目标能力清单（账本聚合，≤50 项） */
  readonly underlying?: readonly DelegationActivity[];
  /** blocked（等待宿主审批）条目计数 */
  readonly blockedCount?: number;
  /** 常驻不可用 → 单次 -p 降级事实（结构化，替代 summary 文案匹配） */
  readonly downgraded?: boolean;
  readonly downgradeReason?: string;
  /** A2A 终态（completed / failed / rejected …；input-required 挂起不落本条） */
  readonly terminalState?: string;
  readonly stepsSummary?: readonly AuditStepSummary[];
  /** 内层回连调用的通道标注（通道 2） */
  readonly channel?: AuditPrincipal['channel'];
  /**
   * U-P0-3（**纯附加可选**）：本次放行**免除了本应触发的审批闸**时，免除依据的服务端事实。
   *
   * 为什么必须留痕：dry-run 免批是审批闸上唯一的放行旁路。若链上只有一条 `ok:true` 的
   * executed 记录、而 `policyDecision.matchedRule` 承载的免批事实又无人核对，事后就
   * **无法区分**「这次 L2/L3 免批是合法免批（能力声明 dry-run + 引擎按 A1 双条件放行）」与
   * 「免批被绕过」。grep `ext.bypass` 即得全部免批执行清单（与 `ext.zeroInnerCalls`
   * 「恒落供人工审视」是同一条取证纪律）。
   *
   * 唯一取值（当前）：`'dry-run'` —— 仅当策略引擎命中
   * `allow:dry-run-bypass`（调用方传 `dryRun:true` **且**能力声明 `supportsDryRun===true`）
   * 时，由**服务端**审计装饰器（`vm-service/src/delegation-audit.ts` 的 `bypassTagSink`）写入。
   * 写入方**不得**依据调用方参数自行判定是否免批，一律以 `PolicyVerdict.matchedRule` 为唯一
   * 判据（否则等于把免批判定权交回调用方 —— 正是 U-P0-3 的病灶）。
   */
  readonly bypass?: 'dry-run';
}

export interface AuditRecord {
  readonly seq: number;
  readonly ts: string;
  readonly traceId: string;
  readonly auditId: string;
  readonly principal: AuditPrincipal;
  readonly capabilityId: string;
  readonly risk: RiskLevel;
  /** 已脱敏的参数 */
  readonly params: Record<string, unknown>;
  readonly policyDecision: AuditPolicyDecision;
  readonly approval?: AuditApproval;
  readonly result: {
    readonly ok: boolean;
    readonly errorCode?: string;
    readonly summary?: string;
  };
  /** artifact 的 sha256（不内联大对象） */
  readonly artifacts?: readonly string[];
  /**
   * K-N1（**纯附加可选**）：审计扩展字段。缺席即旧行为（旧记录无此键，校验不受影响）。
   *
   * 写入纪律：**禁止显式 `ext: undefined`** —— `canonicalJson` 会把 undefined 序列化为 `null`
   * 参与哈希，而 `JSON.stringify` 落盘时丢键 → 重算哈希不一致（假断链）。
   * 一律用条件展开：`...(ext ? { ext } : {})`。
   */
  readonly ext?: AuditExt;
  readonly durationMs: number;
  /** 上一条记录哈希（创世为 GENESIS） */
  readonly prevHash: string;
  readonly hash: string;
}

/** 计算哈希前用于序列化的记录形态（去掉 hash 字段） */
export type HashableAuditRecord = Omit<AuditRecord, 'hash'>;

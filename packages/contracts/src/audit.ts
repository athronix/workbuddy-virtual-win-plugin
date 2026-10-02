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

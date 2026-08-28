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
  readonly durationMs: number;
  readonly prevHash: string;
  readonly hash: string;
}

/** 计算哈希前用于序列化的记录形态（去掉 hash 字段） */
export type HashableAuditRecord = Omit<AuditRecord, 'hash'>;

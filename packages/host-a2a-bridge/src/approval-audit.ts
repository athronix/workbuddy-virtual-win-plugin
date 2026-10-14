/**
 * 宿主侧审批闸留痕（CL-016）
 *
 * 目标：在**宿主侧**记录 L2/L3 审批的发起与结果，做到
 *   - approvalId ↔ traceId 双向可查（F1）
 *   - 审批预览内容哈希（previewHash），可供执行侧比对，发现"预览 ≠ 执行"（F2）
 *   - 结果四态可辨：pending / approved / rejected / timeout / canceled（F3）
 *   - **凭据类字段永不入账**（F5，双重剔除）
 *
 * 约束：
 *   - 内存索引即可，不落盘
 *   - 不改动 VM 侧任何代码，不引入平台分支
 *
 * A2-17（Phase 3 批6）：哈希/canonical 核心算法**整体上提 `@winvm/core/approval-hash`**
 * ——宿主记录 hash 与 VM 绑定校验必须逐字节一致，两份实现=漂移风险（A2-10 教训同款）。
 * 本文件保留同名 re-export（公共 API 面零破坏；`tools.ts`/测试的 import 路径不变）。
 */

import { RISK_LEVELS, type RiskLevel } from '@winvm/contracts';
import {
  CREDENTIAL_KEY_RE,
  canonicalApprovalJson,
  hashApprovalPreview,
  redactCredentials,
} from '@winvm/core';
import { REDACTED } from '@winvm/core';

/** 宿主侧审批留痕记录 */
export interface HostApprovalAudit {
  readonly approvalId: string;
  readonly traceId: string;
  readonly channel: 'mcp' | 'a2a';
  readonly capabilityId?: string;
  readonly risk?: RiskLevel;
  /** dry-run 预览内容哈希（sha256 hex），用于执行侧比对 */
  readonly previewHash: string;
  readonly result: 'pending' | 'approved' | 'rejected' | 'timeout' | 'canceled';
  /** ISO 8601 UTC 时间戳 */
  readonly at: string;
}

/* re-export 面（公共 API 零破坏；权威实现见 core/approval-hash.ts） */
export {
  CREDENTIAL_KEY_RE,
  REDACTED,
  canonicalApprovalJson as canonicalJson,
  redactCredentials,
  hashApprovalPreview,
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/* ------------------------------ 内存索引 ------------------------------ */

const byApprovalId = new Map<string, HostApprovalAudit>();
const byTraceId = new Map<string, HostApprovalAudit[]>();

function addToTrace(rec: HostApprovalAudit): void {
  const bucket = byTraceId.get(rec.traceId);
  if (bucket) bucket.push(rec);
  else byTraceId.set(rec.traceId, [rec]);
}

function removeFromTrace(rec: HostApprovalAudit): void {
  const bucket = byTraceId.get(rec.traceId);
  if (!bucket) return;
  const idx = bucket.indexOf(rec);
  if (idx >= 0) bucket.splice(idx, 1);
  if (bucket.length === 0) byTraceId.delete(rec.traceId);
}

/**
 * 记录（或更新）一条宿主审批留痕。
 *
 * - 同一 `approvalId` 重复记录 → **更新**既有条目（用于 approved/rejected/timeout/canceled 状态推进），
 *   保证 `approvalId` 唯一；旧 trace 桶中的引用会被移除以避免重复。
 * - 入口处对整条记录再过一次 `canonicalJson`（**双重剔除凭据**）。
 * - `at` 由本函数生成（ISO 8601 UTC），不接受外部注入。
 */
export function recordHostApprovalAudit(
  rec: Omit<HostApprovalAudit, 'previewHash' | 'at'> & { previewHash?: string },
): HostApprovalAudit {
  // 入口再断一次：整条记录先过 canonicalJson（剔除凭据键与 undefined）
  const clean = JSON.parse(canonicalApprovalJson({ ...rec })) as Record<string, unknown>;

  const approvalId = typeof clean['approvalId'] === 'string' ? clean['approvalId'] : '';
  const traceId = typeof clean['traceId'] === 'string' ? clean['traceId'] : '';
  const channel: HostApprovalAudit['channel'] = clean['channel'] === 'mcp' ? 'mcp' : 'a2a';
  const capabilityId = typeof clean['capabilityId'] === 'string' ? clean['capabilityId'] : undefined;
  const riskRaw = clean['risk'];
  const risk =
    typeof riskRaw === 'string' && (RISK_LEVELS as readonly string[]).includes(riskRaw)
      ? (riskRaw as RiskLevel)
      : undefined;
  const previewHash = typeof clean['previewHash'] === 'string' ? clean['previewHash'] : '';
  const resultRaw = clean['result'];
  const result: HostApprovalAudit['result'] =
    resultRaw === 'approved' || resultRaw === 'rejected' || resultRaw === 'timeout' || resultRaw === 'canceled'
      ? resultRaw
      : 'pending';

  const record: HostApprovalAudit = {
    approvalId,
    traceId,
    channel,
    ...(capabilityId ? { capabilityId } : {}),
    ...(risk ? { risk } : {}),
    previewHash,
    result,
    at: new Date().toISOString(),
  };

  const prev = byApprovalId.get(approvalId);
  if (prev) removeFromTrace(prev);
  byApprovalId.set(approvalId, record);
  addToTrace(record);
  return record;
}

/** 按 approvalId 查询（唯一） */
export function lookupByApprovalId(approvalId: string): HostApprovalAudit | undefined {
  return byApprovalId.get(approvalId);
}

/** 按 traceId 查询全部审批事件（可能有 0..n 条） */
export function lookupByTraceId(traceId: string): readonly HostApprovalAudit[] {
  const bucket = byTraceId.get(traceId);
  return bucket ? [...bucket] : [];
}

/** 清空内存索引（仅测试用） */
export function _resetAuditIndex(): void {
  byApprovalId.clear();
  byTraceId.clear();
}

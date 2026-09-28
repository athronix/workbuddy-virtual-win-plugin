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
 *   - 仅用 Node 内置 `node:crypto`（零第三方依赖）
 *   - 内存索引即可，不落盘
 *   - 不改动 VM 侧任何代码，不引入平台分支
 */

import { createHash } from 'node:crypto';

import { RISK_LEVELS, type RiskLevel } from '@winvm/contracts';

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

/**
 * 凭据键名**统一正则（唯一一份 · 并集口径）**，大小写不敏感。
 * 覆盖：password / passwd / passphrase / secret / token / apikey / api_key / credential / privatekey / private_key
 * —— `approval-audit.ts` 与 `tools.ts` 的脱敏 / 清洗**都引用本常量**，避免多处口径漂移。
 */
export const CREDENTIAL_KEY_RE =
  /(password|passwd|passphrase|secret|token|apikey|api_key|credential|privatekey|private_key)/i;

/** 凭据脱敏占位串 */
export const REDACTED = '***REDACTED***';

/**
 * 递归凭据脱敏（与 `@winvm/core` 的 `redact()` **同形**，但采用本仓**并集正则**）。
 *
 * 为什么不直接复用 `core.redact()`：
 *   1) core 的凭据正则缺 `passphrase` / `apikey` / `credential` → 会漏脱敏（违反 A7 / NFR-6）；
 *   2) core 的 `redact()` 还会对超长 base64 做截断 → 会破坏 `preview` 与 VM 下发的**逐项深等**（违反 A1/A2）。
 * 故此处只做「凭据键 → 打码」，其余内容**逐字保留**（结构不变、非凭据值原样、不输出 `undefined`）。
 */
export function redactCredentials(value: unknown, key?: string): unknown {
  if (typeof value === 'string') {
    return key !== undefined && CREDENTIAL_KEY_RE.test(key) ? REDACTED : value;
  }
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactCredentials(v, key));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === undefined) continue;
    out[k] = redactCredentials(v, k);
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 递归规范化任意值为键序稳定的纯数据（对象键按字典序排序，
 * 命中凭据键名的键**直接剔除**；数组逐元素处理）。
 */
function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map((x) => canonicalize(x));
  if (isRecord(v)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v).sort()) {
      if (CREDENTIAL_KEY_RE.test(key)) continue; // 凭据红线：直接剔除该键
      const value = v[key];
      if (value === undefined) continue; // 不输出 undefined 字面量
      out[key] = canonicalize(value);
    }
    return out;
  }
  return v;
}

/**
 * 规范化 JSON 字符串。
 * - 键排序：同内容不同键序 → 同字符串
 * - 剔除凭据键：见 `CREDENTIAL_KEY_RE`（并集口径，大小写不敏感）
 */
export function canonicalJson(v: unknown): string {
  const out = JSON.stringify(canonicalize(v));
  return out === undefined ? 'null' : out;
}

/**
 * 计算审批 dry-run 预览的内容哈希：`sha256(canonicalJson(...))` → hex。
 * 只纳入确实存在的字段；凭据键在 canonicalize 阶段被剔除。
 */
export function hashApprovalPreview(input: {
  capabilityId?: string;
  risk?: RiskLevel;
  preview?: Record<string, unknown>;
  impact?: readonly string[];
}): string {
  const payload: Record<string, unknown> = {};
  if (typeof input.capabilityId === 'string') payload['capabilityId'] = input.capabilityId;
  if (input.risk) payload['risk'] = input.risk;
  if (isRecord(input.preview)) payload['preview'] = input.preview;
  if (Array.isArray(input.impact)) payload['impact'] = input.impact;
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
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
  const clean = JSON.parse(canonicalJson({ ...rec })) as Record<string, unknown>;

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

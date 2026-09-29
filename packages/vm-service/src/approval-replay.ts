/**
 * K5 服务端重放的纯逻辑件（从 `server.ts` 拆出，便于单测与复用）。
 *
 * 为什么单独成模块：这几件事是 K5 的**安全语义载体**，必须能在不起 HTTP 服务、
 * 不拉 ps-bridge 的条件下被逐条断言（本沙箱里 `createService` 的 ps-bridge spawn 会触发
 * V8 fatal，无法作为单测入口）：
 *   1. `toExecutedResult` —— 把执行段结果映射为契约层**结构化回执**（判定只看服务端结果）；
 *   2. `recordBlockedApprovalAudit` —— 被拦调用入审计（闭合取证盲区：证明"到过且未执行"）；
 *   3. `deriveUnderlying` —— 从被拦参数尽力推断**真实意图**（宿主审批卡片信息量）。
 *
 * 纪律：全部为**无副作用或仅审计写入**的纯函数，不触碰 provider、不放行任何审批闸。
 */

import type {
  ApprovalUnderlying,
  AuditSink,
  ExecutedResult,
  Logger,
  RiskLevel,
} from '@winvm/contracts';
import { redact } from '@winvm/core';

/** 审计 sink 的最小形状（只需 append；`AuditSink` 的其余成员与本模块无关）。 */
type AuditAppender = Pick<AuditSink, 'append'>;

/**
 * 被拦调用的审计留痕入参（服务端在 MCP 审批闸拦截时构造）。
 */
export interface BlockedAuditInput {
  readonly traceId: string;
  readonly approvalId: string;
  readonly capabilityId: string;
  readonly risk: RiskLevel;
  readonly params: Record<string, unknown>;
  readonly startedAtMs: number;
}

/**
 * K5：把「被宿主审批闸拦截」这一事实写入哈希链审计（`blocked:approval-required`）。
 *
 * 为什么必须记：旧实现只在执行成功/失败时落条目，拦截路径**零记录** →
 * 真机取证时无法证明「该调用到过服务端且从未执行」，是假成功难以证伪的直接原因之一。
 * 重放执行会天然再出一条 executed 条目，两者串成完整因果线。
 *
 * 失败纪律：审计写入失败**绝不影响拦截结果**（拦截语义优先），只 warn。
 * 返回值供调用方/测试断言（best-effort，异常吞掉并记日志）。
 */
export async function recordBlockedApprovalAudit(
  audit: AuditAppender,
  logger: Logger,
  input: BlockedAuditInput,
  newAuditId: () => string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await audit.append({
      ts: new Date().toISOString(),
      traceId: input.traceId,
      auditId: newAuditId(),
      principal: {
        host: 'vm-service',
        user: process.env['USERNAME'] ?? 'unknown',
        channel: 'mcp',
      },
      capabilityId: input.capabilityId,
      risk: input.risk,
      params: input.params,
      policyDecision: { allowed: false, matchedRule: 'approval-required' },
      approval: {
        approvalId: input.approvalId,
        approvedBy: 'pending-host-approval',
        approvedAt: new Date().toISOString(),
        previewHash: '',
      },
      result: {
        ok: false,
        errorCode: 'APPROVAL_REQUIRED',
        summary: 'blocked:approval-required（未执行，等待宿主审批）',
      },
      durationMs: Date.now() - input.startedAtMs,
    });
    return { ok: true };
  } catch (e) {
    logger.warn('blocked 审计写入失败（不影响拦截结果）', { error: String(e) });
    return { ok: false, error: String(e) };
  }
}

/** MCP 执行段结果的形状（只取映射需要的字段，避免依赖 mcp-framework 类型）。 */
export interface SegmentResultLike {
  readonly isError?: boolean;
  readonly structuredContent?: unknown;
}

/**
 * K5：把执行段结果映射为契约层结构化回执 —— **判定只看服务端结果，不看任何 LLM 文本**。
 *
 * `ok` 的口径与执行段一致：`isError !== true && structuredContent.ok === true`。
 * 二者任一不满足即 `ok:false`，并给出 error 原因（桥据此改判，绝不放行"成功"）。
 */
export function toExecutedResult(
  capabilityId: string,
  result: SegmentResultLike,
): ExecutedResult {
  const sc = (result.structuredContent ?? {}) as Record<string, unknown>;
  const ok = result.isError !== true && sc['ok'] === true;
  const errorField = isRecord(sc['error']) ? sc['error'] : undefined;
  const errorMsg = typeof errorField?.['message'] === 'string' ? errorField['message'] : undefined;
  const dataSummary = summaryFromData(sc['data']);

  const summary = ok
    ? typeof sc['summary'] === 'string' && sc['summary']
      ? (sc['summary'] as string)
      : dataSummary
        ? `${capabilityId} 执行成功：${dataSummary}`
        : `${capabilityId} 执行成功`
    : typeof sc['summary'] === 'string' && sc['summary']
      ? (sc['summary'] as string)
      : `${capabilityId} 执行未成功${errorMsg ? `：${errorMsg}` : ''}`;

  return {
    ok,
    capabilityId,
    summary,
    ...(ok ? {} : { error: errorMsg ?? (result.isError === true ? '执行段返回 isError' : '执行段未报 ok:true') }),
  };
}

/**
 * 从执行结果的 `data` 里挑一句人类可读摘要（服务端结果的常见形状：
 * `{ summary | message | text | output }`）。取不到就返回 undefined（由调用方兜底文案）。
 * 截断到 200 字符，避免把整块 PowerShell 输出灌进提示词与回执。
 */
function summaryFromData(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;
  for (const key of ['summary', 'message', 'text', 'output'] as const) {
    const v = data[key];
    if (typeof v === 'string' && v.trim()) {
      const s = v.trim();
      return s.length > 200 ? `${s.slice(0, 200)}…` : s;
    }
  }
  return undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * K5：从被拦截调用的参数里**尽力推断**「真实意图」（供宿主审批卡片展示内层目标）。
 *
 * 只读结构、绝不执行任何东西；推断不出就返回 undefined（卡片退回旧信息量）。
 * 参数摘要经 `redact` 脱敏 + 截断，凭据与超长 base64 永不进卡片。
 *
 * 真机取证的痛点：A2A 里被拦的能力常是「壳」（`appops.workflow.run`），
 * 人工真正要批准的是内层目标（goal 文本 / 真实参数）；卡片只有壳名时无从判断。
 */
export function deriveUnderlying(
  capabilityId: string,
  params: Record<string, unknown>,
): ApprovalUnderlying | undefined {
  const goal = typeof params['goal'] === 'string' && params['goal'].trim() ? params['goal'].trim() : undefined;
  const innerCap = firstCapLike(params);
  const summary = summarizeParams(params);
  if (!goal && !innerCap && !summary) return undefined;
  return {
    capabilityId: innerCap ?? capabilityId,
    ...(summary ? { paramsSummary: summary } : {}),
    ...(goal ? { goalText: goal.length > 300 ? `${goal.slice(0, 300)}…` : goal } : {}),
  };
}

/** 从工作流/CLI 型参数里找「像能力 ID」的字符串（形如 `domain.some.action`）。 */
function firstCapLike(params: Record<string, unknown>): string | undefined {
  for (const key of ['capabilityId', 'capability', 'tool', 'action'] as const) {
    const v = params[key];
    if (typeof v === 'string' && /^[a-z][a-z0-9-]*(\.[a-z0-9_-]+){1,}$/i.test(v.trim())) return v.trim();
  }
  return undefined;
}

/**
 * 标量参数的紧凑摘要（`k=v` 以「 · 」连接，最多 6 项、总长 200）。
 *
 * 值经 `redact(v, k)`（凭据键名命中即打码）—— 与审计侧同一脱敏口径，避免卡片泄密。
 * `goal` 键跳过（已由 goalText 承载，不重复占位）。
 */
function summarizeParams(params: Record<string, unknown>): string | undefined {
  const items: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (k === 'goal') continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      items.push(`${k}=${String(redact(v, k))}`);
    }
    if (items.length >= 6) break;
  }
  if (items.length === 0) return undefined;
  const line = items.join(' · ');
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

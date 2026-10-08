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
  ApprovalWaitQuery,
  AuditRecord,
  AuditSink,
  ExecutedResult,
  Logger,
  PendingApprovalFact,
  RiskLevel,
} from '@winvm/contracts';
import { redact } from '@winvm/core';

/** 审计 sink 的最小形状（只需 append；`AuditSink` 的其余成员与本模块无关）。 */
type AuditAppender = Pick<AuditSink, 'append'>;

/**
 * K-N1（**纯附加可选**）：blocked 审计的通道与归因扩展。
 * 全部有默认值 —— 既有调用（不传第 5 参）行为逐字不变。
 */
export interface BlockedAuditOptions {
  /** 真实通道（委派内层回连经 dtid 注入后为 'a2a'）；默认 'mcp'（旧行为） */
  readonly channel?: 'mcp' | 'a2a' | 'internal';
  /** 所属委派 traceId（通道 2 精确归因；写入 `ext.delegationId`） */
  readonly delegationId?: string;
  /** 落链成功后的回调（携带含 seq 的记录）—— 服务端用它把 blocked 登记进委派账本 */
  readonly onRecorded?: (record: AuditRecord) => void;
}

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
 *
 * K-N1（纯附加）：第 5 参 `opts` 缺席时通道恒 `mcp`、无 ext、无回调 —— 既有调用零改动。
 */
export async function recordBlockedApprovalAudit(
  audit: AuditAppender,
  logger: Logger,
  input: BlockedAuditInput,
  newAuditId: () => string,
  opts: BlockedAuditOptions = {},
): Promise<{ ok: boolean; error?: string }> {
  try {
    const record = await audit.append({
      ts: new Date().toISOString(),
      traceId: input.traceId,
      auditId: newAuditId(),
      principal: {
        host: 'vm-service',
        user: process.env['USERNAME'] ?? 'unknown',
        channel: opts.channel ?? 'mcp',
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
      // K-N1：blocked 条目也带归因 ext（有 delegationId 时；无则整键缺席，旧形态逐字节不变）
      ...(opts.delegationId
        ? { ext: { kind: 'inner-call' as const, delegationId: opts.delegationId, channel: opts.channel ?? 'mcp' } }
        : {}),
    });
    // 账本登记（best-effort：取证失败不得影响拦截结果）
    try {
      opts.onRecorded?.(record);
    } catch (e) {
      logger.warn('blocked 账本登记失败（不影响拦截结果）', { error: String(e) });
    }
    return { ok: true };
  } catch (e) {
    logger.warn('blocked 审计写入失败（不影响拦截结果）', { error: String(e) });
    return { ok: false, error: String(e) };
  }
}

/**
 * S-4：策略硬拒绝（黑名单命中 / 能力未注册 / 超 maxRisk / 不在白名单等）的审计留痕入参。
 *
 * 与 `BlockedAuditInput` 的区别：策略硬拒绝是**终态拒绝**（不经过审批闸、不进入待审批令牌表），
 * 故无 approvalId（用固定哨兵 `'policy-denied'` 表达「终态拒绝而非待审批」）。
 */
export interface PolicyDeniedAuditInput {
  readonly traceId: string;
  readonly capabilityId: string;
  readonly risk: RiskLevel;
  readonly params: Record<string, unknown>;
  readonly startedAtMs: number;
  /** 来自 verdict.matchedRule（如 'path-blacklist' / 'capability-not-registered' / 'max-risk' 等） */
  readonly matchedRule: string;
  /** 来自 verdict.error?.code ?? 'POLICY_DENIED' */
  readonly errorCode: string;
  readonly errorMessage?: string;
}

/**
 * S-4：把「被策略引擎硬拒绝」（黑名单命中 / 能力未注册 / 超 maxRisk / 不在白名单等）这一事实
 * 写入哈希链审计（`blocked:policy-denied`）。
 *
 * 为什么必须记：旧实现两处 `POLICY_DENIED` 早退**零审计记录** → 真机事后无法在哈希审计链上
 * 证明「该调用到过服务端且被策略拒绝」（审批拦截路径已有 `recordBlockedApprovalAudit` 闭合，
 * 但策略拒绝路径此前是取证盲区）。
 *
 * 与 `recordBlockedApprovalAudit` 的关系：结构逐字镜像（同样的 try/catch、`audit.append`、
 * `opts.onRecorded` 纪律），关键差异在审计语义——终态拒绝而非等待审批，
 * 故 `policyDecision.matchedRule` 为真实拒绝规则、`approval.approvalId` 为哨兵 `'policy-denied'`。
 *
 * 失败纪律：审计写入失败**绝不影响拒绝结果**（拒绝语义优先），只 warn。
 */
export async function recordPolicyDeniedAudit(
  audit: AuditAppender,
  logger: Logger,
  input: PolicyDeniedAuditInput,
  newAuditId: () => string,
  opts: BlockedAuditOptions = {},
): Promise<{ ok: boolean; error?: string }> {
  try {
    const record = await audit.append({
      ts: new Date().toISOString(),
      traceId: input.traceId,
      auditId: newAuditId(),
      principal: {
        host: 'vm-service',
        user: process.env['USERNAME'] ?? 'unknown',
        channel: opts.channel ?? 'mcp',
      },
      capabilityId: input.capabilityId,
      risk: input.risk,
      params: input.params,
      policyDecision: { allowed: false, matchedRule: input.matchedRule },
      approval: {
        approvalId: 'policy-denied',
        approvedBy: 'policy-engine',
        approvedAt: new Date().toISOString(),
        previewHash: '',
      },
      result: {
        ok: false,
        errorCode: input.errorCode,
        summary: 'blocked:policy-denied（策略硬拒绝，未执行）',
      },
      durationMs: Date.now() - input.startedAtMs,
      // K-N1：blocked 条目也带归因 ext（有 delegationId 时；无则整键缺席，旧形态逐字节不变）
      ...(opts.delegationId
        ? { ext: { kind: 'inner-call' as const, delegationId: opts.delegationId, channel: opts.channel ?? 'mcp' } }
        : {}),
    });
    // 账本登记（best-effort：取证失败不得影响拒绝结果）
    try {
      opts.onRecorded?.(record);
    } catch (e) {
      logger.warn('policy-denied 账本登记失败（不影响拒绝结果）', { error: String(e) });
    }
    return { ok: true };
  } catch (e) {
    logger.warn('policy-denied 审计写入失败（不影响拒绝结果）', { error: String(e) });
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

/* ==================== CL-K3R · 未决审批事实采集（S1 主通道，纯函数） ==================== */

/**
 * 未决审批令牌的最小形状（`VmApprovalCoordinator.pendingApprovals` 的条目；
 * 只取本函数需要的字段，避免让纯逻辑件反向依赖 `server.ts`）。
 */
export interface PendingApprovalLike {
  readonly approvalId: string;
  readonly capabilityId: string;
  readonly risk?: RiskLevel;
  readonly createdAtMs: number;
  /** 恒 false 才是「未决」；置真/已拒绝的条目不纳入事实 */
  readonly hostApproved?: boolean;
  /** K-N1：拦截发生时的委派 traceId（`/mcp?dtid=` 注入；常驻路径**缺席**） */
  readonly delegationId?: string;
}

/**
 * CL-K3R：从服务端**同进程**的未决审批令牌表反查「属于本委派回合的未决审批」（纯函数，零副作用）。
 *
 * 这是 K3「静默假成功」根治的 **S1 主通道事实源**：拦截发生时服务端已 `pendingApprovals.set(id, …)`，
 * 该事实与「LLM 最终文本说了什么」完全无关 —— 桥据此改判，即可在 LLM 措辞漂移时仍挂起审批。
 *
 * 归因三规则**严格有序**（SK-K4，防串台误报）：
 *   - **R1（精确）**：`delegationId === q.delegationTraceId` ⇒ 命中（attribution='exact'，零歧义）；
 *   - **R2（精确排除）**：`delegationId` 存在但属于**他人** ⇒ **排除**（他人委派的拦截绝不串到本委派）；
 *   - **R3（窗口兜底）**：`delegationId` 缺席（常驻路径，dtid 不生效）且
 *     `q.startedAtMs <= createdAtMs <= nowMs` ⇒ 命中（attribution='window'）；
 *     能力面非空时按 `q.capabilities` 过滤（收窄「宿主并发直调另一 capability」的串台窗口）。
 *
 * 只返**未决**项（`hostApproved !== true`；已批准/已拒绝的条目由服务端移出或标记）。
 * 返回按 `createdAtMs` **升序**（FIFO：改判时最老的未决项优先）。
 */
export function collectApprovalFacts(
  pendingApprovals: ReadonlyMap<string, PendingApprovalLike>,
  q: ApprovalWaitQuery,
  nowMs: number,
): PendingApprovalFact[] {
  const caps =
    q.capabilities && q.capabilities.length > 0 ? new Set<string>(q.capabilities) : undefined;
  const out: PendingApprovalFact[] = [];
  for (const entry of pendingApprovals.values()) {
    if (!entry) continue;
    if (entry.hostApproved === true) continue; // 只返未决项
    const delegationId = typeof entry.delegationId === 'string' && entry.delegationId ? entry.delegationId : undefined;
    let attribution: 'exact' | 'window';
    if (delegationId) {
      if (delegationId !== q.delegationTraceId) continue; // R2 精确排除（防串台）
      attribution = 'exact'; // R1
    } else {
      // R3 窗口兜底：下界=本委派进入时刻，上界=判据执行时刻
      if (entry.createdAtMs < q.startedAtMs) continue;
      if (entry.createdAtMs > nowMs) continue;
      if (caps && !caps.has(entry.capabilityId)) continue;
      attribution = 'window';
    }
    out.push({
      approvalId: entry.approvalId,
      capabilityId: entry.capabilityId,
      risk: entry.risk ?? 'L2',
      createdAtMs: entry.createdAtMs,
      attribution,
      hostApproved: false,
    });
  }
  out.sort((a, b) => a.createdAtMs - b.createdAtMs);
  return out;
}

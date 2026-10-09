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
  ArchiveVerification,
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

/* ==================== ARCH-05 · 审批否定决策入链（T4，纯函数） ==================== */

/**
 * 一次审批的**决策**（设计 §1.2-1）。`'approved'` 为枚举预留（ARCH-09 previewHash 批次复用），
 * **本批不落链**（§5 第 2 条裁断：批准后重放段天然已有一条 executed 记录，双写语义重叠且胀链）。
 */
export type ApprovalDecision = 'approved' | 'rejected' | 'timeout' | 'canceled';

/**
 * 协调器的**决策取证出口**形状（`VmApprovalCoordinator.setDecisionSink` 注入）。
 *
 * 为什么做成注入回调而不是让协调器直接吃 sink：
 * - **依赖方向**：协调器住在 `server.ts`，但它被大量单测**脱离服务**直接实例化
 *   （`k4-approval` / `k4-p3` / `k5-replay` / `r19c-a5`）⇒ 若构造期强依赖 sink/服务闭包，
 *   这些既有用例全数打红。注入 + 缺席即 no-op 是既有四例同范式
 *   （`bind` / `setReplay` / `setReplayEnabled` / `noteTimeout`）。
 * - **取证面/执行面分离**：本回调的异常绝不得影响决策返回值（O-5），故签名返回 `void`
 *   （实现内部自 catch + warn）。
 */
export type ApprovalDecisionSink = (input: {
  readonly traceId: string;
  readonly approvalId: string;
  readonly capabilityId: string;
  readonly risk: RiskLevel;
  readonly decision: ApprovalDecision;
  /**
   * **责任主体**（不是执行主体）：`'host'` / `'approval-ttl'` / `'cancel-request'` /
   * `'mcp-ttl-sweep'` —— ARCH-05 病灶「谁拒的」的解药，必须一路带到链上
   * （落 `approval.approvedBy`）。缺它整条取证失去意义 ⇒ 必选。
   */
  readonly actor: string;
  /**
   * **可选**（与 `ApprovalDecisionAuditInput.taskId?` 同源同形）：MCP 直调
   * （无 active task）与令牌表 TTL 清扫两条决策路径本就无 taskId；落链时走
   * 条件展开 ⇒ 缺席即整键不落（纯附加纪律，禁显式 undefined）。
   */
  readonly taskId?: string;
  readonly delegationId?: string;
  readonly hostApproved?: boolean;
  readonly startedAtMs: number;
  readonly ttlMs?: number;
  readonly params?: Record<string, unknown>;
}) => void;

/**
 * 决策审计入参（服务端 `raise` 的否定分支 / `onApprovalTimeout` 兜底 / 令牌表 TTL 清扫三处构造）。
 *
 * 字段口径与设计 §1.2-1 逐字对齐：`actor` 必须是**责任主体**而不是执行主体 ——
 * `'host'`（宿主显式否决）/ `'approval-ttl'`（TTL 到点）/ `'cancel-request'`（宿主取消）/
 * `'mcp-ttl-sweep'`（MCP 令牌表清扫器，ENG-01）。四值可 grep 区分四条真实路径，
 * 这正是 ARCH-05 的病灶（「谁拒的」不可证）的解药。
 */
export interface ApprovalDecisionAuditInput {
  readonly traceId: string;
  readonly approvalId: string;
  readonly capabilityId: string;
  readonly risk: RiskLevel;
  readonly decision: ApprovalDecision;
  readonly actor: string;
  readonly taskId?: string;
  readonly delegationId?: string;
  /** `decision === 'approved'` 时为 true（本批不落链，字段随枚举预留）。 */
  readonly hostApproved?: boolean;
  /** `decision === 'timeout'` 时给生效 TTL（毫秒）。 */
  readonly ttlMs?: number;
  readonly startedAtMs: number;
  /**
   * 参数快照（**已脱敏**由 sink 侧 `redactParams` 负责，与本文件另两函数同口径）。
   * 缺席 ⇒ 落 `{}`（与 blocked 条目一致的最小信息量；决策证据的主键是 approvalId 而非参数）。
   */
  readonly params?: Record<string, unknown>;
}

/**
 * ARCH-05：把「一次审批否定决策」（rejected / timeout / canceled）写入哈希链审计。
 *
 * 为什么必须记（设计 §1.2 病灶）：三条决策路径（宿主拒绝、TTL 超时、挂起中被取消）
 * 在框架层**零 sink**（框架不依赖审计是纪律，不改），结论只进 `logger` ⇒
 * 链上「谁拒的、拒哪个 approvalId、何时拒」不可证，且 timeout 与普通 failed 折叠成一条。
 *
 * 条目形态（设计 §1.2-1 的**唯一权威定义**，逐字段实现）：
 * - `policyDecision = { allowed:false, matchedRule:'approval-decision:<decision>' }`
 * - `approval       = { approvalId, approvedBy:actor, approvedAt:<ISO now>, previewHash:'' }`
 * - `result         = { ok:false, errorCode:'APPROVAL_'+DECISION, summary:'approval-decision:<decision>（未执行）' }`
 * - `ext            = { kind:'approval-decision', decision, taskId?, delegationId?, channel }`（条件展开）
 *
 * 失败纪律（O-5）：审计写入失败**绝不回改**拒绝/超时/取消结论（决策语义优先），只 warn。
 * 返回值供调用方/测试断言（best-effort）。
 *
 * ★ 落链目标必须是**原始 sink**（O-7）：调用点传 `audit` 而非 `wrapAuditSink(audit,…)` 的
 * 包装件 —— 决策条目是**壳/内部证据**，若经账本装饰器会自我登记成「本回合有活动」，
 * 把取证面变成活动面（防审计自证，与 `delegation.start/complete` 同一纪律，
 * `server.ts` 的 K-N1 注释块已申此则）。本函数不关心 sink 来源（形参是 `AuditAppender`），
 * 该纪律由调用点与 `phase1-t4-assembly` 探针共同守住。
 */
export async function recordApprovalDecisionAudit(
  audit: AuditAppender,
  logger: Logger,
  input: ApprovalDecisionAuditInput,
  newAuditId: () => string,
  opts: BlockedAuditOptions = {},
): Promise<{ ok: boolean; error?: string }> {
  try {
    const channel = opts.channel ?? 'mcp';
    const decision = input.decision;
    const record = await audit.append({
      ts: new Date().toISOString(),
      traceId: input.traceId,
      auditId: newAuditId(),
      principal: {
        host: 'vm-service',
        user: process.env['USERNAME'] ?? 'unknown',
        channel,
      },
      capabilityId: input.capabilityId,
      risk: input.risk,
      params: input.params ?? {},
      policyDecision: { allowed: false, matchedRule: `approval-decision:${decision}` },
      approval: {
        approvalId: input.approvalId,
        approvedBy: input.actor,
        approvedAt: new Date().toISOString(),
        previewHash: '',
      },
      result: {
        ok: false,
        errorCode: `APPROVAL_${decision.toUpperCase()}`,
        summary: `approval-decision:${decision}（未执行）`,
      },
      durationMs: Date.now() - input.startedAtMs,
      // 决策条目恒带 ext（kind+decision 是本体），内部可选成员一律条件展开
      //（纯附加纪律：禁止显式 undefined —— canonicalJson 会把显式 undefined 序列化成
      //  null 参与哈希，而 JSON.stringify 落盘时丢键 ⇒ 重算哈希不一致，假断链。
      //  chain.ts:284-298 的历史教训，§8 共享知识逐字遵守）。
      ext: {
        kind: 'approval-decision' as const,
        decision,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        ...(input.delegationId ? { delegationId: input.delegationId } : {}),
        channel,
      },
    });
    // 账本登记（best-effort：取证失败不得影响决策结果）
    try {
      opts.onRecorded?.(record);
    } catch (e) {
      logger.warn('approval-decision 账本登记失败（不影响决策结果）', { error: String(e) });
    }
    return { ok: true };
  } catch (e) {
    logger.warn('approval-decision 审计写入失败（不影响决策结果）', { error: String(e) });
    return { ok: false, error: String(e) };
  }
}

/* ==================== ARCH-06 A2 · 启动归档校验条目（T4，纯函数） ==================== */

/**
 * 归档校验条目入参。
 *
 * ⚠ `shardsTotal` 与 `ArchiveVerification[]` 长度**不同源**：`verifyArchive` 有界
 * （`ARCHIVE_VERIFY_MAX_SHARDS`，默认 30），超出部分**只计数不校验**。若把
 * `archive.shardsVerified` 写成 `results.length` 而总数取自同一次调用返回，
 * 读者会把「30 片完好」误读成「全部历史完好」——这正是设计 §1.3-1 点名要防的假证据。
 */
export interface ChainArchiveVerifyAuditInput {
  readonly traceId: string;
  readonly startedAtMs: number;
  /** `verifyArchive()` 的逐片结论（永不抛，`[]` = 无归档片或读盘失败）。 */
  readonly results: readonly ArchiveVerification[];
  /** 目录下**全部**分片数（取自 `verifyChain().shardsTotal`，与有界结果集分源）。 */
  readonly shardsTotal: number;
}

/**
 * ARCH-06 A2：构造 `ext.kind:'chain-archive-verify'` **壳条目**（设计 §1.3-3 权威字段表）。
 *
 * 为什么落链而不是只进日志：`/health.audit.scope='session'` 明说了「本轮结论只覆盖本轮分片」，
 * 那么跨轮历史的证据**必须由某条链上条目提供**，否则范围限定语只是将错就错的免责声明。
 *
 * 与 `buildDelegationAuditEntry` 同款纪律：本函数**只造条目、不写链**（可脱服务单测）；
 * 写入用**原始 sink**（O-7，不经 `wrapAuditSink` ⇒ 壳条目不得自成活动证据），
 * 异常只 `logger.warn`、绝不影响启动（fire-and-forget 由调用方挂 `void`）。
 *
 * `result.ok` = 已校验范围内**无断裂**；`broken` 清单进 `ext.archive`（只记片名与聚合，
 * 不记逐片明细 ⇒ 防单条体积随分片数线性膨胀）。
 */
export function buildChainArchiveVerifyAuditEntry(
  input: ChainArchiveVerifyAuditInput,
  newAuditId: () => string,
): {
  ts: string;
  traceId: string;
  auditId: string;
  principal: { host: string; user: string; channel: 'internal' };
  capabilityId: string;
  risk: RiskLevel;
  params: Record<string, unknown>;
  policyDecision: { allowed: true; matchedRule: 'internal:chain-archive-verify' };
  result: { ok: boolean; summary: string; errorCode?: string };
  durationMs: number;
  ext: { kind: 'chain-archive-verify'; archive: { shardsTotal: number; shardsVerified: number; broken: string[] } };
} {
  const ts = new Date().toISOString();
  const broken = input.results.filter((r) => r.valid !== true).map((r) => r.shard);
  const ok = broken.length === 0;
  const shardsVerified = input.results.length;
  const notVerified = Math.max(input.shardsTotal - shardsVerified, 0);
  return {
    ts,
    traceId: input.traceId,
    auditId: newAuditId(),
    principal: {
      host: 'vm-service',
      user: process.env['USERNAME'] ?? 'unknown',
      // internal：服务端自发条目（与委派壳同口径），不是任何外部主体的请求
      channel: 'internal',
    },
    // 设计 §1.3-3 权威值：meta.audit.chain（审计子系统自证属 meta 能力域，不占业务面）
    capabilityId: 'meta.audit.chain',
    risk: 'L0',
    params: { shardsTotal: input.shardsTotal, shardsVerified, notVerified },
    policyDecision: { allowed: true, matchedRule: 'internal:chain-archive-verify' },
    result: {
      ok,
      ...(ok ? {} : { errorCode: 'ARCHIVE_CHAIN_BROKEN' }),
      // 范围诚实化（设计 §1.3-2 注释）：无断裂 ≠ 全部历史完好，越界片只计数
      summary: ok
        ? `chain-archive-verify：已校验 ${shardsVerified}/${input.shardsTotal} 片无断裂` +
          (notVerified > 0 ? `（${notVerified} 片超出上界未校验）` : '')
        : `chain-archive-verify：${broken.length} 片断裂（已校验 ${shardsVerified}/${input.shardsTotal}）`,
    },
    durationMs: Math.max(0, Date.now() - input.startedAtMs),
    ext: {
      kind: 'chain-archive-verify',
      archive: {
        shardsTotal: input.shardsTotal,
        shardsVerified,
        broken,
      },
    },
  };
}

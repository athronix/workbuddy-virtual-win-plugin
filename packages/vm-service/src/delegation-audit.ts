/**
 * K-N1 委派层审计真实性的**服务端纯逻辑件**（从 `server.ts` 拆出，设计
 * `docs/design/kn1-delegation-audit-contract.md` §2/§5）。
 *
 * 为什么单独成模块（与 `approval-replay.ts` 同一拆分纪律）：这些是 K-N1 的**安全语义载体**，
 * 必须能在不起 HTTP 服务、不拉 ps-bridge 的条件下被逐条断言（本沙箱里 `createService` 的
 * ps-bridge spawn 会触发 V8 fatal，无法作为单测入口）：
 *   1. `DelegationLedger` / `LedgerRegistry` —— 委派回合的**进程内活动账本**。
 *      通道 2（精确归因）：`ext.delegationId` 命中的 executed；
 *      blocked：审批闸拦截（approvalId + seq）；
 *      通道 1（兜底）：时间窗 + 能力域内的其他链上活动记 wild。
 *      判「有活动」取**宽松**口径（任一通道非零即采信），判「零活动」必须**三通道全空**
 *      （设计 §2.3 不变式：宁可放过 completed，不可错杀合法完成）。
 *   2. `buildDelegationAuditEntry` —— 委派壳**双态**审计条目（`delegation.start` / `delegation.complete`）
 *      的字段截断与脱敏口径（goal ≤300、summary ≤500、underlying ≤50、stepsSummary ≤10、单项 summary ≤200）。
 *   3. `ReceiptCache` —— S-3 回执端点的**有界脱敏环形缓存**（≤200 条，重启即失，不入哈希链）。
 *   4. `wrapAuditSink` —— 审计 sink 装饰器：把每条**已落链**记录（含 seq）回调给账本，
 *      零 provider 改动地实现「executed 条目 seq 回传服务端」。
 *   5. `buildReceiptResponse` —— `GET /audit/receipt?traceId=` 的响应组装（链上记录 +
 *      `ext.underlying.auditSeqs` 展开 + 环形缓存回执）。
 *
 * 纪律：
 *   - 本文件**只供事实、不改判**。改判（NO_EXECUTION_RECEIPT / LLM_SESSION_DISABLED）的
 *     纯函数在 `@winvm/adapter-agent-workbuddy-llm/src/delegation-truth.ts`（改判产物是
 *     `LlmGoalResult`，且依赖桥的收口时序；依赖方向必须保持 `vm-service → adapter`，不得反向。
 *     设计 §8-T01 把两函数都列在本文件，按实况拆分，判定表逐条等价 —— 回报中已登记偏差）；
 *   - `query({since})` 是**字符串日期比较**（`chain.ts:373`），窗口过滤绝不能用 since，
 *     一律用 `startedAtMs` 毫秒与 `seq`（设计 §2 陷阱注记）；
 *   - 所有自由文本出 `redact()`（与审计侧同一脱敏口径）后截断 —— 零新增敏感面。
 */

import type {
  ApprovalWaitQuery,
  AuditExt,
  AuditPrincipal,
  AuditRecord,
  AuditSink,
  DelegationActivity,
  DelegationActivityCount,
  Logger,
  PendingApprovalFact,
  RiskLevel,
  TaskState,
} from '@winvm/contracts';
import { redact, type AppendAuditInput } from '@winvm/core';

/* ------------------------------ 常量 ------------------------------ */

/** 委派壳能力 ID（A2A 委派在能力面上的外形）。账本登记时**排除**壳条目自身。 */
export const SHELL_CAPABILITY_ID = 'appops.workflow.run';
/** 壳双态条目的 capabilityId（与 SHELL 同值，语义上单独命名便于端点/测试断言） */
export const DELEGATION_CAPABILITY_ID = SHELL_CAPABILITY_ID;

/** 账本聚合上限（设计 §2.2：`ext.underlying` ≤50 项） */
export const MAX_UNDERLYING_ITEMS = 50;
/** `ext.stepsSummary` 上限（设计 §2.2：≤10 项） */
export const MAX_STEPS_SUMMARY = 10;
/** 单条 step summary 截断长度 */
export const MAX_STEP_SUMMARY_CHARS = 200;
/** goal 文本进 `params` 的截断长度（设计 §2.2） */
export const MAX_GOAL_CHARS = 300;
/** `result.summary` / downgradeReason 截断长度（设计 §2.1：≤500 字符） */
export const MAX_SUMMARY_CHARS = 500;
/** 回执环形缓存容量（设计 §5.2-B：≤200 条） */
export const MAX_RECEIPT_ENTRIES = 200;
/** 单条回执 `data` 脱敏后的字符上限（设计 §5.2-B：截断 1KB） */
export const MAX_RECEIPT_DATA_CHARS = 1024;

/* ------------------------------ 工具 ------------------------------ */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 截断为单行安全串 */
function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** 自由文本：脱敏（敏感键名命中即打码）→ 截断。统一口径，零新增敏感面。 */
function sanitizeText(value: unknown, key: string, max: number): string {
  const s = typeof value === 'string' ? value : String(value ?? '');
  return clip(String(redact(s, key)), max);
}

/* ============================ 1. 委派账本 ============================ */

/**
 * blocked 条目登记形状（`recordBlockedApprovalAudit` 回调携带）。
 *
 * CL-K3R（**纯附加可选**）：追加归因与事实字段，供 `LedgerRegistry.blockedFor` 构造
 * `PendingApprovalFact`（S2 副通道）。全部可选 ⇒ 既有构造点（`recordBlocked(seq, id, cap)`）行为逐字不变。
 */
export interface BlockedEntry {
  readonly approvalId: string;
  readonly capabilityId: string;
  readonly seq: number;
  /** 拦截登记时刻（R3 时间窗归因的被比较值；缺席回退所属账本 `startedAtMs`） */
  readonly createdAtMs?: number;
  /** 服务端策略引擎风险级（缺席回退 `'L1'`；S1 主通道 `pendingApprovals` 才是权威来源） */
  readonly risk?: RiskLevel;
  /** 精确归因命中时的委派 traceId（R1/R2 判定依据；缺席 ⇒ 走 R3 窗口兜底） */
  readonly delegationId?: string;
  /** 归因方式：'exact' = dtid 精确 / 'window' = 时间窗兜底（缺席按「无 delegationId」默认 'window'） */
  readonly attribution?: 'exact' | 'window';
}

/** CL-K3R：`DelegationLedger.recordBlocked` 的归因扩展（全部可选，缺席即旧行为） */
export interface BlockedRecordOptions {
  /** 拦截登记时刻（ms）；缺省 `Date.now()` */
  readonly createdAtMs?: number;
  /** 服务端策略引擎风险级 */
  readonly risk?: RiskLevel;
  /** 精确归因命中时的委派 traceId */
  readonly delegationId?: string;
  /** 归因方式；缺省：`delegationId` 存在 ⇒ 'exact'，否则 'window' */
  readonly attribution?: 'exact' | 'window';
}

/** wild 条目登记形状（窗口内不可精确归因的链上活动，仅作「非零」证据） */
export interface WildEntry {
  readonly seq: number;
  readonly capabilityId: string;
}

/**
 * 单个委派回合的活动账本（进程内；随委派生命周期存在）。
 *
 * 归入条件（设计 §2.3 通道 1）：`(ts ≥ startedAtMs) && 任务存活 && capabilityId ∈ 暴露面`，
 * **排除**两条壳条目自身。
 */
export class DelegationLedger {
  readonly delegationTraceId: string;
  readonly taskId: string;
  readonly startedAtMs: number;
  /** 本服务暴露面（空集视为全放行 —— 单测/降级场景） */
  private readonly exposed: ReadonlySet<string>;
  /** 终态收口后停止登记（迟到的异步 append 不得污染已收口账本） */
  private closed = false;

  /** capabilityId → executed 聚合 */
  private readonly executedByCap = new Map<string, { ok: boolean; count: number; seqs: number[] }>();
  private readonly blockedEntries: BlockedEntry[] = [];
  private readonly wildEntries: WildEntry[] = [];
  /** 内层调用的 traceId 清单（S-3 端点展开 + approvalId 关联） */
  private readonly innerTraceIds = new Set<string>();

  constructor(
    delegationTraceId: string,
    taskId: string,
    exposedIds: Iterable<string>,
    startedAtMs: number = Date.now(),
  ) {
    this.delegationTraceId = delegationTraceId;
    this.taskId = taskId;
    this.startedAtMs = startedAtMs;
    this.exposed = new Set(exposedIds);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** 收口：此后任何登记一律忽略（幂等） */
  close(): void {
    this.closed = true;
  }

  /** 时间窗判定（毫秒时间戳比较；**绝不用** `query({since})` 的字符串日期语义） */
  inWindow(atMs: number): boolean {
    return atMs >= this.startedAtMs;
  }

  /** 能力是否落在本服务暴露面上（wild 归入条件之一；空集=不限制） */
  isExposed(capabilityId: string): boolean {
    return this.exposed.size === 0 || this.exposed.has(capabilityId);
  }

  /** 登记一个内层调用 traceId（串匹配用，设计 §3.2「traceId 串匹配」） */
  noteInnerTraceId(traceId: string): void {
    if (!this.closed && traceId) this.innerTraceIds.add(traceId);
  }

  /** 登记 executed（通道 2 精确归因：`ext.delegationId` 命中本委派） */
  recordExecuted(
    record: Pick<AuditRecord, 'seq' | 'capabilityId' | 'traceId'>,
    ok: boolean,
  ): void {
    if (this.closed || record.capabilityId === SHELL_CAPABILITY_ID) return;
    const prev = this.executedByCap.get(record.capabilityId) ?? { ok: false, count: 0, seqs: [] };
    prev.ok = prev.ok || ok;
    prev.count += 1;
    if (prev.seqs.length < MAX_UNDERLYING_ITEMS) prev.seqs.push(record.seq);
    this.executedByCap.set(record.capabilityId, prev);
    this.innerTraceIds.add(record.traceId);
  }

  /**
   * 登记 blocked（审批拦截「到过且未执行」也是活动证据；不污染 executed 计数）。
   *
   * CL-K3R（**纯附加**第 4 参）：`opts` 携带归因事实（`createdAtMs` / `risk` / `delegationId` /
   * `attribution`），供 `blockedFor` 构造结构化 `PendingApprovalFact`。
   * 缺席（既有调用 `recordBlocked(seq, id, cap)`）时只落基础三字段 —— 行为逐字不变。
   */
  recordBlocked(
    seq: number,
    approvalId: string,
    capabilityId: string,
    opts: BlockedRecordOptions = {},
  ): void {
    if (this.closed) return;
    if (this.blockedEntries.length >= MAX_UNDERLYING_ITEMS) return;
    const entry: BlockedEntry = { approvalId, capabilityId, seq };
    this.blockedEntries.push({
      ...entry,
      createdAtMs: opts.createdAtMs ?? Date.now(),
      ...(opts.risk ? { risk: opts.risk } : {}),
      ...(opts.delegationId ? { delegationId: opts.delegationId } : {}),
      attribution: opts.attribution ?? (opts.delegationId ? 'exact' : 'window'),
    });
  }

  /**
   * CL-K3R：blocked 条目快照（供 `LedgerRegistry.blockedFor` 归因；**只读**，不改账本）。
   */
  blockedFacts(): readonly BlockedEntry[] {
    return [...this.blockedEntries];
  }

  /** 登记 wild（通道 1 时间窗兜底） */
  recordWild(seq: number, capabilityId: string): void {
    if (this.closed) return;
    if (this.wildEntries.length >= MAX_UNDERLYING_ITEMS) return;
    this.wildEntries.push({ seq, capabilityId });
  }

  /** 活动计数（判定的唯一依据：三通道全 0 才是「零活动」） */
  activityCount(): DelegationActivityCount {
    const executed = [...this.executedByCap.values()].reduce((n, a) => n + a.count, 0);
    const blocked = this.blockedEntries.length;
    const wild = this.wildEntries.length;
    return { total: executed + blocked + wild, executed, blocked, wild };
  }

  /**
   * 真实目标能力清单（≤50 项，进 `ext.underlying`）。
   *
   * 三通道**都**并入聚合（判"有活动"取宽松、取证展开同样要全）：
   *  - executed（通道 2 精确归因）→ 主体条目；
   *  - blocked（审批拦截「到过未执行」）→ 并入同能力条目并携带 approvalId（不污染 executed 计数）；
   *  - wild（通道 1 时间窗兜底，dtid 缺席时的内层活动）→ 同样并入 —— **必须入清单**，
   *    否则常驻会话路径（mcp.json 会话级共享、dtid 只能作用于单次 -p）的内层活动虽被计为
   *    非零证据，却无法经 `ext.underlying.auditSeqs` 被 S-3 端点按委派 traceId 展开（取证断层）。
   */
  underlying(): DelegationActivity[] {
    // 可变中间态（DelegationActivity 字段为 readonly，聚合完再定型）
    interface Agg {
      capabilityId: string;
      ok: boolean;
      count: number;
      approvalId?: string;
      seqs: number[];
    }
    const order: string[] = [];
    const byCap = new Map<string, Agg>();
    const push = (a: Agg): void => {
      if (byCap.has(a.capabilityId)) return;
      byCap.set(a.capabilityId, a);
      order.push(a.capabilityId);
    };

    for (const [capabilityId, agg] of this.executedByCap) {
      const blockedHits = this.blockedEntries.filter((b) => b.capabilityId === capabilityId);
      const seqs = [...agg.seqs];
      for (const b of blockedHits) {
        if (seqs.length < MAX_UNDERLYING_ITEMS) seqs.push(b.seq);
      }
      push({
        capabilityId,
        ok: agg.ok,
        count: agg.count + blockedHits.length,
        ...(blockedHits[0] ? { approvalId: blockedHits[0].approvalId } : {}),
        seqs,
      });
    }
    for (const b of this.blockedEntries) {
      if (byCap.has(b.capabilityId)) continue;
      push({ capabilityId: b.capabilityId, ok: false, count: 1, approvalId: b.approvalId, seqs: [b.seq] });
    }
    for (const w of this.wildEntries) {
      const hit = byCap.get(w.capabilityId);
      if (hit) {
        hit.count += 1;
        if (hit.seqs.length < MAX_UNDERLYING_ITEMS) hit.seqs.push(w.seq);
        continue;
      }
      push({ capabilityId: w.capabilityId, ok: false, count: 1, seqs: [w.seq] });
    }

    const out: DelegationActivity[] = [];
    for (const capId of order) {
      if (out.length >= MAX_UNDERLYING_ITEMS) break;
      const a = byCap.get(capId);
      if (!a) continue;
      out.push({
        capabilityId: a.capabilityId,
        ok: a.ok,
        count: a.count,
        ...(a.approvalId ? { approvalId: a.approvalId } : {}),
        auditSeqs: a.seqs,
      });
    }
    return out;
  }

  /** blocked 计数（`ext.blockedCount`） */
  blockedCount(): number {
    return this.blockedEntries.length;
  }

  /** 内层调用 traceId 清单（S-3 端点据此展开环形缓存回执） */
  innerCallTraceIds(): string[] {
    return [...this.innerTraceIds];
  }
}

/**
 * 委派账本注册表（进程内、**有界**）。
 *
 * 有界性：`maxLive` 超限按 `startedAtMs` 淘汰最老者；终态即删 + 保留期 TTL 兜底
 * （异常未收口的窗口不永久占位）。并发窗口重叠时互相可见对方内层条目 → 只会**更宽松**，
 * 不制造假改判（设计 §10-2，登记为可接受噪声）。
 */
export class LedgerRegistry {
  private readonly ledgers = new Map<string, DelegationLedger>();
  private readonly maxLive: number;
  private readonly retentionMs: number;
  private readonly now: () => number;

  constructor(opts: { maxLive?: number; retentionMs?: number; now?: () => number } = {}) {
    this.maxLive = opts.maxLive ?? 64;
    this.retentionMs = opts.retentionMs ?? 6 * 60 * 60 * 1000;
    this.now = opts.now ?? (() => Date.now());
  }

  /** 受理时注册（同 delegationTraceId 重复注册幂等：保留原始账本） */
  begin(delegationTraceId: string, taskId: string, exposedIds: Iterable<string>): DelegationLedger {
    const existing = this.ledgers.get(delegationTraceId);
    if (existing) return existing;
    const ledger = new DelegationLedger(delegationTraceId, taskId, exposedIds, this.now());
    this.ledgers.set(delegationTraceId, ledger);
    this.prune();
    return ledger;
  }

  get(delegationTraceId: string): DelegationLedger | undefined {
    return this.ledgers.get(delegationTraceId);
  }

  /** 终态收口：关账并摘除（返回账本供构造 complete 条目；缺席返回 undefined） */
  finish(delegationTraceId: string): DelegationLedger | undefined {
    const ledger = this.ledgers.get(delegationTraceId);
    if (!ledger) return undefined;
    ledger.close();
    this.ledgers.delete(delegationTraceId);
    return ledger;
  }

  /**
   * 链上记录 → 账本分发（`wrapAuditSink` 回调）。归因顺序（保守宽松）：
   *  1. 壳条目（capabilityId=SHELL 或 ext.kind=delegation-*）→ 忽略；
   *  2. `ext.delegationId` 命中存活账本 → 记 executed（通道 2 精确归因，**不再**进 wild）；
   *  3. 否则时间窗 + 暴露面命中的所有存活账本各记一条 wild（通道 1 兜底）。
   */
  onAuditRecord(record: AuditRecord): void {
    if (!record || record.capabilityId === SHELL_CAPABILITY_ID) return;
    const ext = record.ext;
    if (ext?.kind === 'delegation-start' || ext?.kind === 'delegation-complete') return;
    // blocked 条目走 `recordBlocked` 专用通道登记（携带 approvalId）；
    // 这里必须跳过，否则同一条拦截记录会被计两次（executed/wild + blocked）。
    if (record.policyDecision?.matchedRule === 'approval-required') return;
    const atMs = Date.parse(record.ts);
    const delegationId = typeof ext?.delegationId === 'string' ? ext.delegationId : undefined;
    if (delegationId) {
      const ledger = this.ledgers.get(delegationId);
      if (ledger && !ledger.isClosed) {
        ledger.recordExecuted(record, record.result?.ok === true);
        return;
      }
    }
    for (const ledger of this.ledgers.values()) {
      if (ledger.isClosed) continue;
      if (Number.isFinite(atMs) && !ledger.inWindow(atMs)) continue;
      if (!ledger.isExposed(record.capabilityId)) continue;
      ledger.noteInnerTraceId(record.traceId);
      ledger.recordWild(record.seq, record.capabilityId);
    }
  }

  /**
   * 探针实现（`DelegationTruthProbe` 的宿主；经 cast 注入 provider/桥）。
   * 账本缺席（已收口/重启）→ 三零。桥侧仅以 `total===0` 改判，且改判的前提是
   * 「桥在委派**进行中**反查」（收口发生在 complete 条目落链之后由 observer 负责），
   * 正常时序下账本必然存活；异常时序由桥侧 fail-open + `ext.zeroInnerCalls` 恒落兜底。
   */
  activityFor(delegationTraceId: string): DelegationActivityCount {
    const ledger = this.ledgers.get(delegationTraceId);
    if (ledger) return ledger.activityCount();
    return { total: 0, executed: 0, blocked: 0, wild: 0 };
  }

  /**
   * CL-K3R：blocked 登记入口（**窗口归因**版，补 V-3「常驻路径 `blocked` 恒空」）。
   *
   * 与 `DelegationLedger.recordBlocked` 同名同形（多一个可选归因参），使既有调用点
   * （`ledger?.recordBlocked(seq, id, cap)`）零改动即可升级为「账本分发」：
   *   - `delegationId` 存在（单次 `-p` / dtid 注入路径）→ 精确落到该委派账本（R1，零歧义）；
   *   - `delegationId` 缺席（**常驻路径**：mcp.json 会话级共享，dtid 不生效）→ 按
   *     `inWindow(atMs) && isExposed(capabilityId)` 分发到所有存活账本（R3 窗口兜底）。
   *
   * 窗口边界与 `DelegationLedger.inWindow` / `isExposed` **同源**（不另写阈值）。
   */
  recordBlocked(
    seq: number,
    approvalId: string,
    capabilityId: string,
    opts: { readonly delegationId?: string; readonly risk?: RiskLevel; readonly atMs?: number } = {},
  ): void {
    const atMs = opts.atMs ?? Date.now();
    const shared: BlockedRecordOptions = {
      createdAtMs: atMs,
      ...(opts.risk ? { risk: opts.risk } : {}),
    };
    const delegationId = opts.delegationId;
    if (delegationId) {
      const ledger = this.ledgers.get(delegationId);
      if (ledger && !ledger.isClosed) {
        ledger.recordBlocked(seq, approvalId, capabilityId, {
          ...shared,
          delegationId,
          attribution: 'exact',
        });
      }
      return;
    }
    for (const ledger of this.ledgers.values()) {
      if (ledger.isClosed) continue;
      if (!ledger.inWindow(atMs)) continue;
      if (!ledger.isExposed(capabilityId)) continue;
      ledger.recordBlocked(seq, approvalId, capabilityId, { ...shared, attribution: 'window' });
    }
  }

  /**
   * CL-K3R：反查「本委派回合内仍未决的审批拦截」（S2 副通道，供 `DelegationTruthProbe.approvalWait`）。
   *
   * 三规则**严格有序**（SK-K4）：
   *   - **R1（精确）**：`entry.delegationId === q.delegationTraceId` ⇒ 命中（attribution='exact'）；
   *   - **R2（精确排除）**：`entry.delegationId` 存在但属于**他人** ⇒ **排除**（防串台）；
   *   - **R3（窗口兜底）**：`delegationId` 缺席 且 该条落在**本委派账本**内 且
   *     `ledger.inWindow(createdAtMs)` ⇒ 命中（attribution='window'）；能力面非空时按
   *     `capabilities` 过滤（收窄宿主并发直调的串台窗口）。
   *
   * 返回按 `createdAtMs` 升序（FIFO，与 S1 主通道同序）；无账本上下文 ⇒ 空数组（绝不误报）。
   */
  blockedFor(q: ApprovalWaitQuery): PendingApprovalFact[] {
    const caps =
      q.capabilities && q.capabilities.length > 0 ? new Set<string>(q.capabilities) : undefined;
    const out: PendingApprovalFact[] = [];
    for (const [traceId, ledger] of this.ledgers) {
      for (const entry of ledger.blockedFacts()) {
        let attribution: 'exact' | 'window';
        if (entry.delegationId) {
          if (entry.delegationId !== q.delegationTraceId) continue; // R2 精确排除（防他人拦截串台）
          attribution = entry.attribution ?? 'exact';
        } else {
          // R3 窗口兜底：只认**本委派账本**内的条目（他人账本内的无主条目属串台，排除）
          if (traceId !== q.delegationTraceId) continue;
          if (!ledger.inWindow(entry.createdAtMs ?? ledger.startedAtMs)) continue;
          if (!ledger.isExposed(entry.capabilityId)) continue;
          attribution = entry.attribution ?? 'window';
        }
        if (caps && !caps.has(entry.capabilityId)) continue;
        out.push({
          approvalId: entry.approvalId,
          capabilityId: entry.capabilityId,
          risk: entry.risk ?? 'L1',
          createdAtMs: entry.createdAtMs ?? ledger.startedAtMs,
          attribution,
          hostApproved: false,
        });
      }
    }
    out.sort((a, b) => a.createdAtMs - b.createdAtMs);
    return out;
  }

  /** 按内层 traceId 关联到存活账本（dtid 缺席时 blocked/executed 的 traceId 串匹配兜底） */
  ledgerForInnerTrace(traceId: string): DelegationLedger | undefined {
    for (const ledger of this.ledgers.values()) {
      if (ledger.isClosed) continue;
      if (ledger.delegationTraceId === traceId) return ledger;
      if (ledger.innerCallTraceIds().includes(traceId)) return ledger;
    }
    return undefined;
  }

  /** 清理：超容量淘汰最老 + 超保留期摘除 */
  private prune(): void {
    const cutoff = this.now() - this.retentionMs;
    for (const [k, l] of this.ledgers) {
      if (l.startedAtMs < cutoff) {
        l.close();
        this.ledgers.delete(k);
      }
    }
    if (this.ledgers.size <= this.maxLive) return;
    const ordered = [...this.ledgers.entries()].sort((a, b) => a[1].startedAtMs - b[1].startedAtMs);
    for (const [k, l] of ordered.slice(0, this.ledgers.size - this.maxLive)) {
      l.close();
      this.ledgers.delete(k);
    }
  }
}

/* ============================ 2. 壳双态审计条目 ============================ */

/** 壳步骤摘要的输入形状（与 `GoalStep` 兼容的最小形状） */
export interface DelegationStepLike {
  readonly capabilityId: string;
  readonly ok: boolean;
  readonly summary?: string;
}

/** `buildDelegationAuditEntry` 的入参（全部为服务端可得事实，不读 LLM 文本）。 */
export interface DelegationAuditEntryInput {
  readonly delegationTraceId: string;
  readonly taskId?: string;
  /** 委派目标文本（进 `params.goal`：脱敏后截 300） */
  readonly goal: string;
  readonly maxRisk?: RiskLevel;
  readonly allowedCapabilities?: readonly string[];
  /** 受理时刻（`durationMs` 基准） */
  readonly startedAtMs: number;
  readonly newAuditId: () => string;
  /** 账本（仅 complete 态需要：`ext.underlying` / `blockedCount` / `zeroInnerCalls`） */
  readonly ledger?: DelegationLedger;
  /** —— 以下仅 complete 态 —— */
  readonly terminalState?: TaskState;
  /** 终态 ok（completed→true，其余→false） */
  readonly ok?: boolean;
  readonly errorCode?: string;
  readonly downgraded?: boolean;
  readonly downgradeReason?: string;
  readonly steps?: readonly DelegationStepLike[];
  /** 终态摘要追加（≤500 总长） */
  readonly resultSummary?: string;
  /** 执行主体（与 recordBlockedApprovalAudit 同口径：VM 侧用户） */
  readonly user?: string;
}

/**
 * 构造委派壳**双态**审计条目（设计 §2.1/§2.2）。返回 `AppendAuditInput`，
 * 交 `HashChainAuditSink.append` 取号入链（`doAppend` 对 `ext` 再递归脱敏，双保险）。
 *
 * 口径：
 *  - `principal.channel` 恒 `'a2a'` —— 委派通道的**真实**通道（修掉「181/181 恒 mcp」观测缺陷）；
 *  - `start`：`result.ok=true`、`summary='delegation.start'`；`ext` 只带 kind/delegationId/taskId
 *    （`underlying` 缺席、`zeroInnerCalls` **不落** —— 未判定）；
 *  - `complete`：`summary='delegation.complete:<终态>'`（≤500）；`ok` 与终态一致；
 *    `ext.zeroInnerCalls` **恒落**（即使 completed —— 设计 §10-1：供 grep「零调用但 completed」形态）。
 */
export function buildDelegationAuditEntry(
  kind: 'start' | 'complete',
  input: DelegationAuditEntryInput,
): AppendAuditInput {
  const ts = new Date().toISOString();
  const nowMs = Date.parse(ts);
  const activity: DelegationActivityCount = input.ledger
    ? input.ledger.activityCount()
    : { total: 0, executed: 0, blocked: 0, wild: 0 };

  const ext: AuditExt =
    kind === 'start'
      ? {
          kind: 'delegation-start',
          delegationId: input.delegationTraceId,
          ...(input.taskId ? { taskId: input.taskId } : {}),
        }
      : {
          kind: 'delegation-complete',
          delegationId: input.delegationTraceId,
          ...(input.taskId ? { taskId: input.taskId } : {}),
          // ★ 核心事实断言字段：**恒落**（即使终态 completed，设计 §10/拍板点 3）
          zeroInnerCalls: activity.total === 0,
          underlying: input.ledger ? input.ledger.underlying() : [],
          blockedCount: input.ledger ? input.ledger.blockedCount() : activity.blocked,
          ...(input.downgraded === undefined ? {} : { downgraded: input.downgraded }),
          ...(input.downgradeReason
            ? { downgradeReason: sanitizeText(input.downgradeReason, 'downgradeReason', MAX_SUMMARY_CHARS) }
            : {}),
          ...(input.terminalState ? { terminalState: input.terminalState } : {}),
          ...(input.steps && input.steps.length > 0
            ? {
                stepsSummary: input.steps.slice(0, MAX_STEPS_SUMMARY).map((s) => ({
                  capabilityId: String(redact(s.capabilityId, 'capabilityId')),
                  ok: s.ok === true,
                  ...(s.summary ? { summary: sanitizeText(s.summary, 'summary', MAX_STEP_SUMMARY_CHARS) } : {}),
                })),
              }
            : {}),
        };

  const ok = kind === 'start' ? true : input.ok === true;
  const summary =
    kind === 'start'
      ? 'delegation.start'
      : clip(
          `delegation.complete:${input.terminalState ?? (ok ? 'completed' : 'failed')}` +
            (kind === 'complete' && activity.total === 0 ? '（零工具调用；完成声称不予采信）' : '') +
            (input.resultSummary ? `：${sanitizeText(input.resultSummary, 'resultSummary', MAX_SUMMARY_CHARS)}` : ''),
          MAX_SUMMARY_CHARS,
        );

  const principal: AuditPrincipal = {
    host: 'vm-service',
    user: input.user ?? process.env['USERNAME'] ?? 'unknown',
    channel: 'a2a',
  };

  return {
    ts,
    traceId: input.delegationTraceId,
    auditId: input.newAuditId(),
    principal,
    capabilityId: DELEGATION_CAPABILITY_ID,
    risk: 'L1',
    params: {
      goal: sanitizeText(input.goal, 'goal', MAX_GOAL_CHARS),
      ...(input.maxRisk ? { maxRisk: input.maxRisk } : {}),
      ...(input.allowedCapabilities ? { allowedCapabilities: [...input.allowedCapabilities] } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
    },
    policyDecision: { allowed: true, matchedRule: 'delegation' },
    result: {
      ok,
      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      summary,
    },
    durationMs: Number.isFinite(nowMs) ? Math.max(0, nowMs - input.startedAtMs) : 0,
    ext,
  };
}

/* ============================ 3. S-3 回执环形缓存 ============================ */

/** 单条回执（脱敏 + 截断后的进程内副本；**不入链**，重启即失 —— 设计 §10-4 已登记信任局限） */
export interface ReceiptEntry {
  readonly traceId: string;
  readonly capabilityId: string;
  readonly ok: boolean;
  readonly ts: string;
  /** 脱敏 + 截 1KB 后的结构化 data（紧凑 JSON 串） */
  readonly data: string;
}

/** 结构化 data → 脱敏 + 截断 1KB 的紧凑串（导出供单测直接断言口径） */
export function clipReceipt(data: unknown): string {
  try {
    const json = JSON.stringify(redact(data) ?? null);
    return json.length > MAX_RECEIPT_DATA_CHARS ? `${json.slice(0, MAX_RECEIPT_DATA_CHARS)}…` : json;
  } catch {
    return '{"unserializable":true}';
  }
}

/**
 * 有界脱敏回执环形缓存（S-3 方案 B 的第二数据源：字段级重建）。
 *
 * 只存**脱敏后**副本（复用 `redact`）；容量 ≤200，超出按插入序淘汰最旧；
 * 不落哈希链 → 零体积增长、零新增不可删改敏感面（设计 §5.1）。
 */
export class ReceiptCache {
  private readonly map = new Map<string, ReceiptEntry>();
  private readonly capacity: number;

  constructor(capacity: number = MAX_RECEIPT_ENTRIES) {
    this.capacity = Math.max(1, capacity);
  }

  get size(): number {
    return this.map.size;
  }

  /** 写入（同 traceId 覆盖；容量淘汰按插入序 = 环形语义） */
  record(traceId: string, capabilityId: string, ok: boolean, data: unknown): void {
    if (!traceId) return;
    this.map.set(traceId, {
      traceId,
      capabilityId,
      ok,
      ts: new Date().toISOString(),
      data: clipReceipt(data),
    });
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }

  get(traceId: string): ReceiptEntry | undefined {
    return this.map.get(traceId);
  }

  /** 批量取（端点按账本 `innerCallTraceIds()` / 委派 traceId 展开） */
  getAll(traceIds: readonly string[]): ReceiptEntry[] {
    const out: ReceiptEntry[] = [];
    for (const id of traceIds) {
      const e = this.map.get(id);
      if (e) out.push(e);
    }
    return out;
  }

  clear(): void {
    this.map.clear();
  }
}

/* ============================ 4. 审计 sink 装饰器 ============================ */

/**
 * 包装 `AuditSink`：每条**成功落链**的记录（含 seq）回调 `onRecorded`（喂账本 + 回执缓存）。
 *
 * 为什么用装饰器而非「provider 经 ctx 累加器回传 seq」：`executeCapability` 直接调
 * `provider.execute(req)`，req 里没有也不该塞 ToolContext 累加器（改契约面更大）；
 * 装饰器在**服务端自己**的注入面上截获 append 返回值，零 provider 改动，
 * 与设计 §2.3 通道 1（「append 返回的 AuditRecord 经 per-call ctx 累加器回传」）语义等价
 * —— 都是「服务端进程自己知道每条记录发生过、seq 是多少」。登记为实现形态偏差。
 *
 * 纪律：回调异常一律吞掉并 warn —— 取证登记失败绝不影响审计写入结果
 * （对齐 approval-replay「写失败不影响拦截结果」纪律）。
 */
export function wrapAuditSink(
  sink: AuditSink,
  onRecorded: (record: AuditRecord) => void,
  logger: Logger,
): AuditSink {
  return {
    async append(input: AppendAuditInput): Promise<AuditRecord> {
      const record = await sink.append(input);
      try {
        onRecorded(record);
      } catch (e) {
        logger.warn('委派账本登记失败（不影响审计写入）', { error: String(e) });
      }
      return record;
    },
    verifyChain() {
      return sink.verifyChain();
    },
  };
}

/* ============================ 5. 回执端点响应组装 ============================ */

/**
 * 组装 `GET /audit/receipt?traceId=` 响应（设计 §5.2-B）。
 *
 * 两段数据源：
 *  - `records` —— 链上记录投影（附 seq/hash 供与链对齐校验）；命中**委派壳** complete 条目时
 *    按 `ext.underlying.auditSeqs` 把内层记录一并展开（若调用方传入了全量候选 `allRecords`）；
 *  - `receipts` —— 进程内环形缓存里的脱敏回执（字段级重建；重启即失）。
 *
 * 未命中 → `{ records: [], ... }`（HTTP 200，非 4xx —— 设计 §9-F-3）。
 */
export function buildReceiptResponse(args: {
  readonly traceId: string;
  readonly records: readonly AuditRecord[];
  readonly allRecords?: readonly AuditRecord[];
  readonly receipts?: readonly ReceiptEntry[];
  /**
   * T02 端点接线补充：内层记录（traceId ≠ 委派 traceId）的回执按**展开后记录的 traceId**
   * 反查环形缓存。回调由 server.ts 传入（`(ids) => receiptCache.getAll(ids)`），
   * 使「委派 traceId 为键」的端点在账本收口后仍能拿到字段级回执。
   */
  readonly receiptLookup?: (traceIds: readonly string[]) => readonly ReceiptEntry[];
}): { traceId: string; records: Record<string, unknown>[]; innerSeqs: number[]; receipts: ReceiptEntry[] } {
  const records = [...args.records];
  const innerSeqs = new Set<number>();
  for (const r of records) {
    const ext = r.ext;
    if (ext?.kind !== 'delegation-complete') continue;
    for (const a of ext.underlying ?? []) {
      for (const s of a.auditSeqs ?? []) innerSeqs.add(s);
    }
  }
  const expanded: AuditRecord[] = [...records];
  if (args.allRecords && innerSeqs.size > 0) {
    const have = new Set(records.map((r) => r.seq));
    for (const r of args.allRecords) {
      if (innerSeqs.has(r.seq) && !have.has(r.seq)) expanded.push(r);
    }
  }
  expanded.sort((a, b) => a.seq - b.seq);
  // 回执合并：调用方显式传入（按委派 traceId 直查）优先；
  // receiptLookup 再把**展开后的内层记录** traceId 的回执补齐（按 traceId 去重）。
  const receiptsById = new Map<string, ReceiptEntry>();
  for (const e of args.receipts ?? []) {
    if (!receiptsById.has(e.traceId)) receiptsById.set(e.traceId, e);
  }
  if (args.receiptLookup) {
    const innerTraceIds = [...new Set(expanded.map((r) => r.traceId))].filter(
      (id) => id !== args.traceId && !receiptsById.has(id),
    );
    if (innerTraceIds.length > 0) {
      for (const e of args.receiptLookup(innerTraceIds)) {
        if (!receiptsById.has(e.traceId)) receiptsById.set(e.traceId, e);
      }
    }
  }
  return {
    traceId: args.traceId,
    records: expanded.map((r) => toReceiptRecord(r)),
    innerSeqs: [...innerSeqs].sort((a, b) => a - b),
    receipts: [...receiptsById.values()],
  };
}

/** 链上记录 → 回执投影（只留取证必要字段；`params` 已由 sink 落链前脱敏，投影不再内联） */
function toReceiptRecord(r: AuditRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {
    seq: r.seq,
    hash: r.hash,
    ts: r.ts,
    traceId: r.traceId,
    capabilityId: r.capabilityId,
    result: r.result,
  };
  if (isRecord(r.principal)) out['channel'] = r.principal['channel'];
  if (r.ext) out['ext'] = r.ext;
  return out;
}

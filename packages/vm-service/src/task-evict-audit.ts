/**
 * Phase 2 · P2-T7（F3 / L1）：TaskStore **驱逐**的链上取证（`ext.kind:'task-evicted'`）。
 *
 * 存在理由（设计 §3.1-1 第①件）：`evictIfNeeded()` 在 T7 之前无计数、无日志、无回调，
 * 「哪些任务在长会话里被有界化回收了」这条事实**链上零痕迹**。框架侧现在给出了
 * `onEviction` 结构化回调 + 单调计数 + 有界环形日志，但框架**不 import 审计语义**
 * （依赖方向铁律，同 `DelegationObserver`）⇒ 落不落链、以什么形态落，由本层（vm-service）决定。
 *
 * 三条纪律（照既有自发条目范式，逐条对齐样板）：
 *  1. **写原始 sink**（`audit`，不经 `auditSink`/`wrapAuditSink`）—— 服务端自发条目不得把
 *     自己登记成「本回合有活动」（O-7 审计自证，与 `bearer-selfcheck` / `chain-archive-verify` 同判据）；
 *  2. **突发合并**：一次 `create()` 触发的多条逐出（一次 TTL 清扫可回收几十条）
 *     经微任务缓冲折叠成**一条**聚合条目 ⇒ 观测不得把哈希链变成新的无界增长点；
 *     稳态（满容量后每 create 逐 1）退化为「每委派至多一条」，与 `delegation-start/complete` 同阶；
 *  3. **只落元数据**：id 样本（≤10）+ 计数 + 闸门分布 + 终态分布，**不含任务内容**
 *     （审计保留期权衡 W-2 的边界：「回收发生了」可留痕，「任务里曾有什么」不可）。
 *
 * 取证失败绝不影响服务：本模块所有出口都是 fire-and-forget + catch warn（与 `onApprovalTimeout`
 * 落链、`delegation.start` 落链同一条红线 —— 观测面坏不得拖累执行面）。
 */

import type { RiskLevel } from '@winvm/contracts';
import type { EvictionRecord } from '@winvm/a2a-framework';

/** 单条链上条目里最多携带的样本 id 数（超出只计数不落 id ⇒ 条目体积与突发规模解耦） */
export const TASK_EVICT_SAMPLE_LIMIT = 10;

/** 一次落链的输入：同一微任务批次内的全部逐出事实 + 累计计数读数 */
export interface TaskEvictedAuditInput {
  readonly traceId: string;
  /** 本批次逐出的记录（按发生顺序，≥1 条） */
  readonly batch: readonly EvictionRecord[];
  /** 截至本批次结束时 TaskStore 的累计驱逐数（`evictedCount()` 读数，与 /health 同口径） */
  readonly evictedTotal: number;
  /** 本批次第一条逐出的时刻（用于如实计算 durationMs，不是「落链耗时」的假零） */
  readonly startedAtMs: number;
}

/** 自发条目形态（与 `buildBearerSelfCheckAuditEntry` 同构，字段名对齐 `AppendAuditInput`） */
export interface TaskEvictedAuditEntry {
  readonly ts: string;
  readonly traceId: string;
  readonly auditId: string;
  readonly principal: { host: string; user: string; channel: 'internal' };
  readonly capabilityId: string;
  readonly risk: RiskLevel;
  readonly params: Record<string, unknown>;
  readonly policyDecision: { allowed: true; matchedRule: 'internal:task-evicted' };
  readonly result: { ok: true; summary: string };
  readonly durationMs: number;
  readonly ext: {
    readonly kind: 'task-evicted';
    readonly evict: {
      readonly count: number;
      readonly ttlCount: number;
      readonly overflowCount: number;
      readonly sampleTaskIds: readonly string[];
      readonly evictedTotal: number;
      readonly terminalStates: Readonly<Record<string, number>>;
    };
  };
}

/**
 * 构造一条 `task-evicted` 聚合条目（**纯函数**，零 I/O ⇒ 可脱服务逐条断言，
 * 与 `buildBearerSelfCheckAuditEntry` 同手法：判据落在纯函数里，装配层只喂实值）。
 *
 * `matchedRule` 语义同族：驱逐是**事实陈述**而非许可判定 ⇒ `allowed` 恒 true，
 * 语义全在 `ext.evict` 与 summary。
 */
export function buildTaskEvictedAuditEntry(
  input: TaskEvictedAuditInput,
  newAuditId: () => string,
): TaskEvictedAuditEntry {
  const batch = input.batch;
  let ttlCount = 0;
  let overflowCount = 0;
  const terminalStates: Record<string, number> = {};
  for (const rec of batch) {
    if (rec.gate === 'ttl') ttlCount += 1;
    else overflowCount += 1;
    terminalStates[rec.terminalState] = (terminalStates[rec.terminalState] ?? 0) + 1;
  }
  const statesText = Object.entries(terminalStates)
    .map(([state, n]) => `${state}:${n}`)
    .join(' ');
  const gateText =
    ttlCount > 0 && overflowCount > 0
      ? `ttl=${ttlCount} overflow=${overflowCount}`
      : ttlCount > 0
        ? `ttl=${ttlCount}`
        : `overflow=${overflowCount}`;
  return {
    ts: new Date().toISOString(),
    traceId: input.traceId,
    auditId: newAuditId(),
    principal: {
      host: 'vm-service',
      user: process.env['USERNAME'] ?? 'unknown',
      // internal：服务端自发条目，不是任何外部主体的请求（与 chain-archive-verify 同口径）
      channel: 'internal',
    },
    // 审计子系统自证属 meta 能力域（§1.3-3 权威值），不占业务面
    capabilityId: 'meta.audit.chain',
    risk: 'L0',
    params: {
      count: batch.length,
      ttlCount,
      overflowCount,
      evictedTotal: input.evictedTotal,
    },
    policyDecision: { allowed: true, matchedRule: 'internal:task-evicted' },
    result: {
      ok: true,
      summary:
        `TaskStore 驱逐回收 ${batch.length} 条终态任务（${gateText}；累计 ${input.evictedTotal} 条）` +
        (statesText ? `；终态分布 ${statesText}` : ''),
    },
    durationMs: Math.max(0, batch[batch.length - 1]!.evictedAtMs - input.startedAtMs),
    ext: {
      kind: 'task-evicted',
      evict: {
        count: batch.length,
        ttlCount,
        overflowCount,
        // 只取本批次**最先**逐出的有限样本（溢出轮里最旧者信息量最大），其余仅计数
        sampleTaskIds: batch.slice(0, TASK_EVICT_SAMPLE_LIMIT).map((rec) => rec.id),
        evictedTotal: input.evictedTotal,
        terminalStates,
      },
    },
  };
}

/** 落链所需的装配依赖（由 server.ts 注入，本模块零全局读取） */
export interface TaskEvictedChainOptions {
  /** 写**原始**审计 sink（不经账本装饰器；O-7） */
  readonly append: (entry: TaskEvictedAuditEntry) => Promise<unknown>;
  readonly newTraceId: () => string;
  readonly newAuditId: () => string;
  /** 累计驱逐读数（直接取 `TaskStore.evictedCount()` ⇒ 链上与 /health 同口径，两处不漂移） */
  readonly evictedCount: () => number;
  /** 服务已收口 ⇒ 放弃写入（与 `serviceClosed` 位共用，杜绝往已关闭 sink 塞条目） */
  readonly isClosed: () => boolean;
  readonly warn: (msg: string, fields?: Record<string, unknown>) => void;
}

/**
 * 驱逐 → 链上条目的**突发合并**投递器。
 *
 * 为什么用微任务而不是定时器：`evictIfNeeded()` 是**同步体** ⇒ 一次 `create()` 触发的全部逐出
 * 天然落在同一个微任务边界内，`queueMicrotask` 就能精确圈出「一次突发」，
 * 且**零定时器 ⇒ 零新增生命周期面**（不必给 `close()` 再加一条清理，也就不会引入
 * 「关闭后定时器复活」这类既有测试专门钉过的坑）。
 *
 * 生命周期竞态三条（都由 `isClosed()` 一处判据覆盖）：
 *  · 收口后到达的回调 ⇒ 直接丢弃（不落条目、不打 warn，与 `recordBearerSelfCheck` 同纪律）；
 *  · 已排队的微任务在收口**之后**才执行 ⇒ flush 前再判一次；
 *  · append 失败 ⇒ 只 warn，绝不重试成环（观测失败不升级为可用性事故）。
 */
export interface TaskEvictedChainRecorder {
  /** 作为 `TaskStoreOptions.onEviction` 直接挂载 */
  readonly onEviction: (info: EvictionRecord) => void;
  /** 待 flush 的批次数（**测试与排障读侧**；稳态恒 0 或 1） */
  readonly pendingCount: () => number;
}

export function createTaskEvictedChainRecorder(
  opts: TaskEvictedChainOptions,
): TaskEvictedChainRecorder {
  let pending: EvictionRecord[] = [];
  let scheduled = false;
  let firstEvictedAtMs = 0;

  const flush = (): void => {
    scheduled = false;
    const batch = pending;
    pending = [];
    if (batch.length === 0) return;
    if (opts.isClosed()) return; // 收口后不写已关闭的 sink（静默丢弃，退出路径不留半条）
    const startedAtMs = firstEvictedAtMs || batch[0]!.evictedAtMs;
    let entry: TaskEvictedAuditEntry;
    try {
      entry = buildTaskEvictedAuditEntry(
        {
          traceId: opts.newTraceId(),
          batch,
          evictedTotal: opts.evictedCount(),
          startedAtMs,
        },
        opts.newAuditId,
      );
    } catch (e) {
      opts.warn('task-evicted 条目构造失败（不影响驱逐与服务）', { error: String(e) });
      return;
    }
    void opts.append(entry).catch((e: unknown) => {
      if (!opts.isClosed()) {
        opts.warn('task-evicted 落链失败（不影响驱逐与服务，本轮证据缺席）', { error: String(e) });
      }
    });
  };

  return {
    onEviction: (info: EvictionRecord): void => {
      if (opts.isClosed()) return;
      if (pending.length === 0) firstEvictedAtMs = info.evictedAtMs;
      pending.push(info);
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(flush);
    },
    pendingCount: () => pending.length,
  };
}

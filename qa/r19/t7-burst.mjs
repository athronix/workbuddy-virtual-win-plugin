#!/usr/bin/env node
/**
 * P2-T7 · L1 真机 **burst（突发）实证**探针 —— 溢出闸门 / evictedCount 曲线 / 归因四形态
 *
 * 背景（设计偏差登记，见 timeline step7-A/B）：VM provider=`workbuddy`（LLM 常驻会话）
 * 把 filler 目标当**无工具需求的话**直接答完 ⇒ 任务 `submitted→working→(数分钟后)completed`，
 * **不是**设计假定的「无匹配模板 ⇒ 快速 failed」。而 ENG-08/O-11 驱逐**只逐终态**、
 * **只在 create() 尾部**触发 ⇒ 在飞洪水期没有候选 ⇒ `live` 越过 `maxTasks` 而 `evictedCount`
 * 恒 0（**设计自洽**，非实现失效）。上一轮 480 并发委派（两次投递叠加）把 VM 打到
 * fork 资源耗尽 ⇒ 本版本改为**低并发慢投 + 连续超时熔断**，并把「攒终态候选 → 一次 create
 * 清扫」的完整因果写进同一脚本，单轮出证。
 *
 * 相位：
 *   P1 慢投 N 个零副作用任务（并发 CONC、批间 GAP）——提交期本身就跨过 maxTasks=200，
 *      一旦 LLM 陆续收口出候选，**后续每次 create 就会各逐出 1～k 条**（稳态：每委派至多一条），
 *      于是 P1 的逐轮采样直接给出 `evictedCount` 的**增长曲线**。
 *   P2 攒候选：轮询 `tasks/list`（四个终态）直到候选数 ≥ (live − maxTasks + 1)，
 *      即「下一次 create 一定逐得出东西」；带总时限，到点如实记录现状继续。
 *   P3 大突发：投 **1** 个任务 ⇒ 这次 `create()` 尾部把在场终态候选一次逐到上限
 *      ⇒ `evictedCount` 单点跳变、`live ≤ maxTasks`；同一条逐出链在**同一个同步体**内
 *      ⇒ 微任务合并 ⇒ 链上**净新增恰 1 条** `task-evicted` 聚合条目（合并投递器的实况实证）。
 *   P4 阶梯：重复「等收口 + 投 1」×ROUNDS ⇒ `evictedCount` **单调不减**阶梯。
 *   P5 归因四形态（同一 `tasks/get` 观测面）：
 *      C1 环窗口**内**被逐 id（链上最新 sampleTaskIds）⇒ `data={code:'TaskNotFoundError',evicted:true}`；
 *      C2 环窗口**外**被逐 id（链上最早那条的 sampleTaskIds，已被容量 64 的环覆盖）
 *        ⇒ **诚实退回旧形状**（无 `evicted` 键）—— 同一条真实被逐出的 id 仅因窗口边界结论不同；
 *      C3 从未存在的 id ⇒ 旧形状逐字节不变；
 *      C4 存活 id ⇒ 正常返回 Task（「活动任务永不被逐」的反证）。
 *
 * 零副作用纪律：`blocking:false` + `maxRisk:L0` + `allowedCapabilities:[]`（空数组 ⇒ 不声明任何能力）
 *   + 文案避开模板关键词 + 只走 /a2a 协议面。
 *
 * 用法（VM 内）：node C:/WinVMBridge/tools-t7-burst.mjs [out] [tasks=280] [conc=4] [gapMs=2500]
 *                                                     [rounds=6] [waitMs=20000] [deadlineMs=600000]
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const A2A_URL = 'http://127.0.0.1:18443/a2a';
const HEALTH_URL = 'http://127.0.0.1:18443/health';

const OUT = process.argv[2] ?? 'C:/WinVMBridge/t7-burst-result.json';
const N_TASKS = Number.parseInt(process.argv[3] ?? '280', 10) || 280;
const CONC = Number.parseInt(process.argv[4] ?? '4', 10) || 4;
const GAP_MS = Number.parseInt(process.argv[5] ?? '2500', 10) || 2500;
const P4_ROUNDS = Number.parseInt(process.argv[6] ?? '6', 10) || 6;
const WAIT_MS = Number.parseInt(process.argv[7] ?? '20000', 10) || 20_000;
const P2_DEADLINE_MS = Number.parseInt(process.argv[8] ?? '600000', 10) || 600_000;
/** 与 task-store.ts EVICTION_LOG_CAPACITY 同值（有界性本身是被判据的结论之一） */
const RING_CAP = 64;
const TERMINAL_STATES = ['completed', 'failed', 'canceled', 'rejected'];
/** 熔断阈值：连续这么多次 `/health` 取不到 ⇒ 立刻停投并落盘（保护 VM） */
const HEALTH_TIMEOUT_LIMIT = 3;
/**
 * VM 负载护栏：`/health.psBridge.pending` 连续这么多次高于阈值 ⇒ 熔断停投。
 * 上一轮 480 并发委派的后裔进程把 VM 打到 `fork: Resource temporarily unavailable`
 * （Git Bash 都无法起进程）⇒ 观测不得以打挂被观测系统为代价。
 */
const LOAD_GUARD_LIMIT = 20;

const FILLER = 'P2T7 burst gate probe (no capability requested)';

let rpcId = 1;
const t0 = Date.now();
const stamp = () => `${new Date().toISOString()} +${Date.now() - t0}ms`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let healthTimeouts = 0;

async function rpc(method, params, timeoutMs = 20_000) {
  const res = await fetch(A2A_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  return JSON.parse(line ? line.slice(6) : text);
}

async function health(timeoutMs = 8_000) {
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(timeoutMs) });
    const j = await res.json();
    healthTimeouts = 0; // 一次成功即清零（熔断只针对**连续**不可用）
    return {
      tasks: j.tasks ?? null,
      auditEntries: j.audit?.entries ?? null,
      chainValid: j.audit?.chainValid ?? null,
      auth: `${j.security?.authMode}/${j.security?.bearerSelfCheck?.code}/${j.security?.innerReconnect?.status}`,
      // VM 负载侧读数（上一轮 480 并发把 VM 打到 fork 耗尽 ⇒ 本轮全程带载护栏观测量）
      load: { psBridgePending: j.psBridge?.pending ?? null, llmPid: j.llmSession?.pid ?? null, llmRestarts: j.llmSession?.restarts ?? null },
      ok: true,
    };
  } catch (e) {
    healthTimeouts += 1;
    console.log(`${stamp()} HEALTH_TIMEOUT #${healthTimeouts} ${String(e).slice(0, 140)}`);
    return { tasks: null, ok: false, error: String(e) };
  }
}

/** 链上全部 `task-evicted` 条目（自发条目写原始 sink ⇒ 与 delegation 同分片同链） */
function readEvictEntries(limitShards = 4) {
  const dir = join(process.env.LOCALAPPDATA, 'WinVMBridge', 'audit');
  const shards = readdirSync(dir)
    .filter((x) => x.endsWith('.jsonl'))
    .map((x) => ({ x, m: statSync(join(dir, x)).mtimeMs }))
    .sort((a, b) => b.m - a.m)
    .slice(0, limitShards);
  const out = [];
  for (const s of shards) {
    for (const l of readFileSync(join(dir, s.x), 'utf8').trim().split('\n')) {
      let o;
      try {
        o = JSON.parse(l);
      } catch {
        continue;
      }
      if ((o.ext ?? {}).kind === 'task-evicted') {
        out.push({
          shard: s.x,
          seq: o.seq,
          ts: o.ts,
          traceId: o.traceId,
          channel: o.principal?.channel,
          capabilityId: o.capabilityId,
          risk: o.risk,
          allowed: o.policyDecision?.allowed,
          matchedRule: o.policyDecision?.matchedRule,
          durationMs: o.durationMs,
          resultOk: o.result?.ok,
          summary: o.result?.summary,
          evict: o.ext.evict,
        });
      }
    }
  }
  return out;
}

async function sendOne(tag) {
  try {
    const r = await rpc('message/send', {
      message: {
        kind: 'message',
        role: 'user',
        messageId: `msg_t7_burst_${tag}_${Date.now()}`,
        parts: [{ kind: 'text', text: `${FILLER} ${tag}` }],
      },
      metadata: { traceId: `tr_t7_burst_${tag}`, maxRisk: 'L0', allowedCapabilities: [] },
      configuration: { blocking: false },
    });
    return {
      tag,
      id: r.result?.id ?? null,
      state: r.result?.status?.state ?? null,
      error: r.error ? { code: r.error.code, message: r.error.message } : null,
    };
  } catch (e) {
    return { tag, id: null, state: null, error: { transport: String(e).slice(0, 160) } };
  }
}

/** 按终态统计在场任务数（tasks/list 的 totalSize 即该状态在场条数） */
async function terminalCensus() {
  const per = {};
  let total = 0;
  for (const st of TERMINAL_STATES) {
    try {
      const r = await rpc('tasks/list', { status: st, pageSize: 1 });
      const n = r.result?.totalSize ?? 0;
      per[st] = n;
      total += n;
    } catch {
      per[st] = null;
    }
  }
  return { per, total };
}

const result = {
  meta: {
    purpose: 'P2-T7 real-machine burst proof: overflow gate / evictedCount curve / attribution 4 shapes',
    zeroSideEffect: { blocking: false, maxRisk: 'L0', allowedCapabilities: [] },
    startedAt: new Date(t0).toISOString(),
    ringCap: RING_CAP,
    node: process.version,
    params: { N_TASKS, CONC, GAP_MS, P4_ROUNDS, WAIT_MS, P2_DEADLINE_MS, HEALTH_TIMEOUT_LIMIT, LOAD_GUARD_LIMIT },
  },
  phases: {},
  attribution: [],
};
const flush = () => writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');

/* ================= P1 慢投（提交期即越过 maxTasks ⇒ 曲线从这里开始） ================= */
const base = await health();
result.phases.base = base;
console.log(`${stamp()} BASE tasks=${JSON.stringify(base.tasks)}`);

let sent = 0;
let okSent = 0;
let aborted = false;
let highLoad = 0; // 连续「忙不过来」计数（负载护栏）
const curve1 = [];
let prevEvicted = base.tasks?.evictedCount ?? 0;
const errors = [];
while (sent < N_TASKS) {
  const batch = [];
  const n = Math.min(CONC, N_TASKS - sent);
  for (let i = 0; i < n; i += 1) {
    sent += 1;
    batch.push(sendOne(`P1_${sent}`));
  }
  const done = await Promise.all(batch);
  for (const d of done) {
    if (d.id) okSent += 1;
    else errors.push(d);
  }
  const h = await health();
  const nowEvicted = h.tasks?.evictedCount ?? null;
  curve1.push({
    sent,
    at: stamp(),
    live: h.tasks?.live ?? null,
    maxTasks: h.tasks?.maxTasks ?? null,
    evictedCount: nowEvicted,
    delta: nowEvicted === null ? null : nowEvicted - prevEvicted,
    auditEntries: h.auditEntries,
    chainValid: h.chainValid,
    load: h.load,
  });
  if (nowEvicted !== null) prevEvicted = nowEvicted;
  console.log(
    `${stamp()} P1 sent=${sent}/${N_TASKS} live=${h.tasks?.live} evictedCount=${nowEvicted} chain=${h.auditEntries}`,
  );
  if (healthTimeouts >= HEALTH_TIMEOUT_LIMIT) {
    aborted = true;
    result.phases.p1_abort = { at: stamp(), sent, reason: 'consecutive /health timeouts (VM resource guard)' };
    break;
  }
  // 负载护栏：桥接队列积压即 VM 已在超载 ⇒ 退避，连续三次仍积压则熔断停投
  const pending = h.load?.psBridgePending ?? 0;
  highLoad = pending > LOAD_GUARD_LIMIT ? highLoad + 1 : 0;
  if (highLoad >= 3) {
    aborted = true;
    result.phases.p1_abort = {
      at: stamp(),
      sent,
      reason: `psBridge.pending sustained > ${LOAD_GUARD_LIMIT} (VM overload guard, abort before harming the host)`,
      pending,
    };
    break;
  }
  if (pending > 4) console.log(`${stamp()} P1 BACKOFF pending=${pending}`);
  if (sent % 40 < CONC) flush();
  await sleep(pending > 4 ? GAP_MS * 4 : GAP_MS);
}
result.phases.P1 = { sent, okSent, sendErrors: errors.slice(0, 5), curve: curve1 };
flush();
if (aborted) {
  result.summary = { aborted: true, sentAtAbort: sent, note: 'VM 资源熔断：见 timeline' };
  flush();
  console.log(`${stamp()} ABORTED (VM guard) -> ${OUT}`);
  process.exit(2);
}

/* ================= P2 攒终态候选（候选 = 驱逐的入场券） ================= */
const p2Start = await health();
const sizeNow = p2Start.tasks?.live ?? 0;
const maxNow = p2Start.tasks?.maxTasks ?? 200;
const need = Math.max(1, sizeNow - maxNow + 1);
const p2Deadline = Date.now() + P2_DEADLINE_MS;
const p2Samples = [];
let census = { per: {}, total: 0 };
const p2T0 = Date.now();
while (Date.now() < p2Deadline) {
  census = await terminalCensus();
  const h = await health();
  p2Samples.push({
    at: stamp(),
    live: h.tasks?.live ?? null,
    evictedCount: h.tasks?.evictedCount ?? null,
    terminalTotal: census.total,
    terminalPer: census.per,
    need,
  });
  console.log(`${stamp()} P2 live=${h.tasks?.live} terminal=${census.total} need=${need} evicted=${h.tasks?.evictedCount}`);
  if (census.total >= need) break;
  await sleep(WAIT_MS);
}
result.phases.P2 = { need, census, waitedMs: Date.now() - p2T0, samples: p2Samples, start: p2Start };
flush();

/* ================= P3 大突发（1 次 create 把候选逐到上限） ================= */
const aBefore = await health();
const chainBefore = readEvictEntries();
const aSend = await sendOne('A');
await sleep(2500); // 微任务落链 + 分片刷盘窗口
const aAfter = await health();
const chainAfterA = readEvictEntries();
result.phases.P3 = {
  before: aBefore,
  sent: aSend,
  after: aAfter,
  terminalCensusBefore: census,
  evictedCountDelta: (aAfter.tasks?.evictedCount ?? 0) - (aBefore.tasks?.evictedCount ?? 0),
  liveDelta: (aAfter.tasks?.live ?? 0) - (aBefore.tasks?.live ?? 0),
  chainBeforeCount: chainBefore.length,
  chainAfterCount: chainAfterA.length,
  chainNetNew: chainAfterA.length - chainBefore.length,
  newEntries: chainAfterA.slice(chainBefore.length),
};
console.log(
  `${stamp()} P3 evicted ${aBefore.tasks?.evictedCount}->${aAfter.tasks?.evictedCount} (D${result.phases.P3.evictedCountDelta}) live ${aBefore.tasks?.live}->${aAfter.tasks?.live} (D${result.phases.P3.liveDelta}) chainDelta=${result.phases.P3.chainNetNew}`,
);
flush();

/* ================= P4 阶梯（单调不减曲线） ================= */
const curve4 = [];
let prevE4 = aAfter.tasks?.evictedCount ?? 0;
let prevC4 = chainAfterA.length;
for (let i = 0; i < P4_ROUNDS; i += 1) {
  await sleep(WAIT_MS); // 等 LLM 收口 ⇒ 攒新候选
  const s = await sendOne(`B${i}`);
  await sleep(2000);
  const h = await health();
  const chain = readEvictEntries();
  const now = h.tasks?.evictedCount ?? 0;
  curve4.push({
    round: i,
    sentId: s.id,
    live: h.tasks?.live ?? null,
    evictedCount: now,
    delta: now - prevE4,
    chainTaskEvicted: chain.length,
    chainNetNew: chain.length - prevC4,
    auditEntries: h.auditEntries,
    chainValid: h.chainValid,
  });
  console.log(
    `${stamp()} P4 B${i} live=${h.tasks?.live} evictedCount=${now} D${now - prevE4} chain=${chain.length}(+${chain.length - prevC4})`,
  );
  prevE4 = now;
  prevC4 = chain.length;
  flush();
}
const entriesAll = readEvictEntries();
const gates = entriesAll.reduce(
  (m, e) => {
    m.entries += 1;
    m.ttl += e.evict?.ttlCount ?? 0;
    m.overflow += e.evict?.overflowCount ?? 0;
    m.maxBatch = Math.max(m.maxBatch, e.evict?.count ?? 0);
    m.sumCounted += e.evict?.count ?? 0;
    if (e.channel === 'internal' && e.capabilityId === 'meta.audit.chain' && e.risk === 'L0' && e.matchedRule === 'internal:task-evicted') {
      m.shapeOk += 1;
    }
    return m;
  },
  { entries: 0, ttl: 0, overflow: 0, maxBatch: 0, sumCounted: 0, shapeOk: 0 },
);
result.phases.P4 = { curve: curve4, gates, chainTaskEvictedTotal: entriesAll.length, firstEntry: entriesAll[0] ?? null, latestEntries: entriesAll.slice(-3) };

/* ================= P5 归因四形态 ================= */
const inWindowIds = (entriesAll.at(-1)?.evict?.sampleTaskIds ?? []).slice(0, 3);
const outWindowIds = (entriesAll[0]?.evict?.sampleTaskIds ?? []).slice(0, 3);
const neverId = 't7-never-exists-00000000-0000-0000-0000-000000000000';

const probe = async (kind, id) => {
  if (!id) return;
  try {
    const r = await rpc('tasks/get', { id });
    const row = {
      kind,
      id,
      hasResult: r.result !== undefined,
      state: r.result?.status?.state ?? null,
      errorData: r.error?.data ?? null,
      errorMessage: r.error?.message ?? null,
    };
    result.attribution.push(row);
    console.log(`${stamp()} P5 ${kind} id=${id} data=${JSON.stringify(row.errorData)} state=${row.state}`);
  } catch (e) {
    result.attribution.push({ kind, id, transportError: String(e).slice(0, 160) });
  }
};

for (const id of inWindowIds) await probe('C1-evicted-in-window', id);
for (const id of outWindowIds) await probe('C2-evicted-out-of-window', id);
await probe('C3-never-existed', neverId);
await probe('C4-survivor-A', aSend.id ?? neverId);

const final = await health();
const grp = (k) => result.attribution.filter((a) => a.kind === k);
const ringWrapped = (result.phases.P4.gates.sumCounted ?? 0) > RING_CAP;
result.phases.final = final;
result.summary = {
  aborted: false,
  overflowGateTriggeredInP1: (result.phases.P1.curve.at(-1)?.evictedCount ?? 0) > 0,
  p1FinalEvicted: result.phases.P1.curve.at(-1)?.evictedCount ?? null,
  p3EvictedCountDelta: result.phases.P3.evictedCountDelta,
  p3LiveDelta: result.phases.P3.liveDelta,
  p3LiveWithinMax: (aAfter.tasks?.live ?? 0) <= (aAfter.tasks?.maxTasks ?? 0),
  /** 微任务突发合并：大突发的 N 条逐出只落 1 条链上条目 */
  burstCollapsedToOneChainEntry: result.phases.P3.chainNetNew === 1,
  chainEntriesCount: entriesAll.length,
  gates: result.phases.P4.gates,
  chainEntryShapeAllInternal: result.phases.P4.gates.shapeOk === entriesAll.length,
  chainVsHealthSameRuler: {
    chainSumCounted: result.phases.P4.gates.sumCounted,
    healthEvictedCount: final.tasks?.evictedCount ?? null,
    equal: result.phases.P4.gates.sumCounted === (final.tasks?.evictedCount ?? -1),
  },
  evictedCountMonotonic: [...curve1, ...curve4].every(
    (x, i, arr) => i === 0 || x.evictedCount === null || (arr[i - 1].evictedCount ?? 0) <= x.evictedCount,
  ),
  evictedCountFinal: final.tasks?.evictedCount ?? null,
  liveFinalWithinMax: (final.tasks?.live ?? 0) <= (final.tasks?.maxTasks ?? 0),
  ringWrapped,
  c1AllEvictedAttributed: grp('C1-evicted-in-window').every((a) => a.errorData?.evicted === true),
  c2NoneAttributedOutOfWindow: grp('C2-evicted-out-of-window').every((a) => a.errorData && !('evicted' in a.errorData)),
  c3NoEvictedKey: grp('C3-never-existed').every((a) => a.errorData && !('evicted' in a.errorData)),
  c4Alive: grp('C4-survivor-A').some((a) => a.hasResult === true),
  chainValid: final.chainValid,
  authTriple: final.auth,
  tasksHealthKeys: final.tasks ? Object.keys(final.tasks) : null,
};
console.log(`${stamp()} SUMMARY ${JSON.stringify(result.summary)}`);
flush();
console.log(`${stamp()} DONE -> ${OUT}`);

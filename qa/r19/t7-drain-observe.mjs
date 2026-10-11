#!/usr/bin/env node
/**
 * P2-T7 · L1 长会话驱逐观测 —— **排空 + 溢出轮 + 归因观测**（在 **VM 内**运行，走本机回环 18443）
 *
 * 背景（t7-fill 轮 1/2 现场发现）：provider=workbuddy 是 LLM 常驻会话，投递的填充任务
 * 长时间停留 `working` 由队列串行消化 ⇒ 非终态 ⇒ **不是驱逐候选** ⇒ 双闸门不动、
 * evictedCount 恒 0（这正是设计语义：活动任务永不被逐，R5 防线）。要在**默认 200/1h**
 * 参数下把溢出闸门真实打出来，需要先把在飞的 working 收口成**终态**。
 *
 * 收口手法 = **正规协议面 `tasks/cancel`**（`requestCancel`：abort + canceled 同步体 O-1）：
 *   · 只动我们**自己刚投的** filler trace（`tr_t7_fill_*` / `tr_t7_drain_*`），逐 id 精确取消，
 *     不广播式清场 ⇒ 任何非本轮的第三方任务一律不碰；
 *   · canceled 是终态，且 `evictable()` 对「已落 canceled」返回 true（防御性冗余条款：
 *     abort 与终态同一同步体，不存在「已 abort 未 canceled」滞留）；
 *   · 收口后 `size > maxTasks` 的欠账由**下一批 create() 尾部**一次清偿（O-11：驱逐只由
 *     create 触发）⇒ 填充轮第 1 条 create 即触发大批 overflow，其后逐条 +1，
 *     曲线阶梯在 /health.tasks.evictedCount 上直接可见。
 *
 * 零副作用纪律延续（与 t7-fill.mjs 同参）：blocking:false + maxRisk:'L0' +
 * allowedCapabilities:[]（空数组 ⇒ 确定性执行器 allowed() 恒 false ⇒ 零能力调用）；
 * tasks/cancel 不执行任何能力；tasks/list 纯读。全程只走 /a2a 与 /health。
 *
 * 观测面（任务书第⑥件三件事）：
 *   A. overflow 闸门实证：evictedCount 从 0 → ≥280 的曲线（逐 fill / 逐 drain 采样）；
 *   B. 被逐 id 归因形态：窗口内 id ⇒ error.data={code, evicted:true}；窗口外 id ⇒ 诚实 false
 *      （无 evicted 键，与「从未存在」逐字节同形）；从未存在 id ⇒ 旧形状不变；
 *   C. /health.tasks.evictedCount 键在场 + audit.chainValid 在落链后仍为 true（安全红线）。
 *
 * 用法（VM 内）：
 *   node C:/WinVMBridge/tools-t7-drain.mjs --fill-rounds=4 --fill-size=40 --max-ops=700 \
 *        --out=C:/WinVMBridge/t7-drain-result.json
 */

import { writeFileSync, readdirSync, readFileSync, statSync } from 'node:fs';

const A2A_URL = 'http://127.0.0.1:18443/a2a';
const HEALTH_URL = 'http://127.0.0.1:18443/health';
const AUDIT_DIR = 'C:/Users/User/AppData/Local/WinVMBridge/audit';
const FILLER_PHRASE = 'P2T7 bounded-retention pressure probe (no capability requested)';

function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? dflt : hit.slice(name.length + 3);
}
const FILL_ROUNDS = Math.max(1, Number.parseInt(arg('fill-rounds', '4'), 10) || 4);
const FILL_SIZE = Math.max(1, Number.parseInt(arg('fill-size', '40'), 10) || 40);
const MAX_OPS = Math.max(50, Number.parseInt(arg('max-ops', '700'), 10) || 700);
const CONC = Math.max(1, Number.parseInt(arg('concurrency', '8'), 10) || 8);
const OUT = arg('out', 'C:/WinVMBridge/t7-drain-result.json');

let rpcId = 1;
const t0 = Date.now();
const stamp = () => `${new Date().toISOString()} +${Date.now() - t0}ms`;

async function rpc(method, params, timeoutMs = 30_000) {
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

async function health() {
  const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(15_000) });
  const j = await res.json();
  return { tasks: j.tasks ?? null, audit: j.audit ?? null };
}

/** 并发池：fn(item) 逐个跑，返回结果数组（保序） */
async function pool(items, fn, concurrency = CONC) {
  const out = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return out;
}

/** tasks/list 按状态分页枚举（pageSize≤100，跟随 nextPageToken） */
async function enumerateByState(state, cap = 4000) {
  const ids = [];
  let token = '';
  for (let page = 0; page < 60 && ids.length < cap; page += 1) {
    const r = await rpc('tasks/list', {
      status: state,
      pageSize: 100,
      ...(token ? { pageToken: token } : {}),
    });
    const tasks = r.result?.tasks ?? [];
    for (const t of tasks) ids.push({ id: t.id, ts: t.status?.timestamp ?? '' });
    token = r.result?.nextPageToken ?? '';
    if (!token) break;
  }
  return ids;
}

async function cancelOne(id) {
  const r = await rpc('tasks/cancel', { id });
  if (r.error) {
    return { id, ok: false, err: `${r.error.code}:${r.error.message}` };
  }
  return { id, ok: true, state: r.result?.status?.state ?? null };
}

async function sendOne(seq, tag) {
  const r = await rpc('message/send', {
    message: {
      kind: 'message',
      role: 'user',
      messageId: `msg_t7_${tag}_${seq}_${Date.now()}`,
      parts: [{ kind: 'text', text: `${FILLER_PHRASE} #${tag}-${seq}` }],
    },
    metadata: {
      traceId: `tr_t7_${tag}_${seq}`,
      maxRisk: 'L0',
      timeoutMs: 300_000,
      allowedCapabilities: [],
    },
    configuration: { blocking: false },
  });
  return { seq, id: r.result?.id ?? null, state: r.result?.status?.state ?? null, error: r.error ?? null };
}

const rounds = [];
const drains = [];
let ops = 0;

async function sample(phase, extra = {}) {
  const h = await health();
  const rec = { at: stamp(), phase, ...h, ...extra };
  rounds.push(rec);
  console.log(
    `${stamp()} ${phase}: live=${h.tasks?.live} evicted=${h.tasks?.evictedCount} ` +
      `chainValid=${h.audit?.chainValid} entries=${h.audit?.entries} ${JSON.stringify(extra)}`,
  );
  return h;
}

/* ================= 0. 起点 ================= */
await sample('phase0-start');

/* ================= 1. drain#1：把存量 working 收口成 canceled ================= */
async function drain(tag) {
  let cancelled = 0;
  let failed = 0;
  const cancelledIds = [];
  let pass = 0;
  while (ops < MAX_OPS && pass < 6) {
    pass += 1;
    const list = await enumerateByState('working', MAX_OPS - ops);
    if (list.length === 0) break;
    console.log(`${stamp()} ${tag}-pass${pass}: working=${list.length}`);
    const res = await pool(list, (it) => cancelOne(it.id));
    for (const r of res) {
      ops += 1;
      if (r.ok) {
        cancelled += 1;
        cancelledIds.push(r.id);
      } else failed += 1;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  drains.push({ tag, cancelled, failed, cancelledIds, passes: pass, opsUsed: ops });
  await sample(`${tag}-done`, { cancelled, failed });
  return { cancelled, cancelledIds };
}

const drain1 = await drain('drain1');

/* ================= 2. fill 轮 ×N：create 触发 overflow 阶梯 ================= */
const fillIds = [];
for (let k = 1; k <= FILL_ROUNDS && ops < MAX_OPS; k += 1) {
  const done = await pool(
    Array.from({ length: FILL_SIZE }, (_, i) => i + 1),
    (seq) => sendOne(seq, `f${k}`),
    6,
  );
  for (const d of done) if (d.id) fillIds.push(d.id);
  await sample(`after-fill-${k}`, { sent: FILL_SIZE, fillTotal: fillIds.length });
  // 本轮新任务大概率又是 working ⇒ 增量排空，保持终态池扩大（驱逐发生在下一轮 create）
  if (k < FILL_ROUNDS) await drain(`drain-after-fill-${k}`);
}

/* ================= 3. 终局排空（把最后一轮 working 收口） ================= */
await drain('drain-final');

/* ---- 补一波 create 让新终态也被逐（终局 health 阶梯收口） ---- */
if (ops < MAX_OPS) {
  const done = await pool(
    Array.from({ length: FILL_SIZE }, (_, i) => i + 1),
    (seq) => sendOne(seq, 'fT'),
    6,
  );
  for (const d of done) if (d.id) fillIds.push(d.id);
  await sample('after-fill-final', { sent: FILL_SIZE });
}

/* ================= 4. 归因观测 ================= */
const hEnd = await health();
const endLive = hEnd.tasks?.live ?? 0;

/** 窗口内候选：audit 分片里最后一条 task-evicted 的 evict.sampleTaskIds */
function lastChainSample() {
  try {
    const files = readdirSync(AUDIT_DIR)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ f, m: readFileSync(`${AUDIT_DIR}/${f}`, 'utf8') }))
      .sort((a, b) => a.f.localeCompare(b.f));
    const hits = [];
    for (const { m } of files) {
      for (const line of m.split('\n')) {
        if (!line.includes('task-evicted')) continue;
        try {
          const e = JSON.parse(line);
          if (e?.ext?.kind === 'task-evicted') hits.push(e);
        } catch {
          /* 忽略非 JSON 行 */
        }
      }
    }
    hits.sort((a, b) => String(a.ts ?? '').localeCompare(String(b.ts ?? '')));
    return hits;
  } catch (err) {
    return { error: String(err) };
  }
}

const chainHits = lastChainSample();
const probeIds = new Set();
const windowIds = [];
if (Array.isArray(chainHits) && chainHits.length > 0) {
  // 末条 = 最后一次驱逐突发的链上快照；其 sampleTaskIds 必在环形窗口内（≤64 条前）
  for (const id of (chainHits[chainHits.length - 1]?.ext?.evict?.sampleTaskIds ?? []).slice(0, 6)) {
    windowIds.push(id);
    probeIds.add(id);
  }
}
const earlyIds = drain1.cancelledIds.slice(0, 4); // 最早取消 ⇒ 最早被逐 ⇒ 窗口外（诚实 false）
const neverId = 't7-never-exists-00000000-0000-0000-0000-000000000000';
const lateIds = fillIds.slice(-4); // 末期投递（可能仍存活）
for (const id of [...earlyIds, neverId, ...lateIds]) probeIds.add(id);

const probes = [];
for (const id of probeIds) {
  const r = await rpc('tasks/get', { id });
  probes.push({
    id,
    inWindowSample: windowIds.includes(id),
    early: earlyIds.includes(id),
    never: id === neverId,
    late: lateIds.includes(id),
    hasResult: r.result !== undefined,
    state: r.result?.status?.state ?? null,
    errorData: r.error?.data ?? null,
    errorMessage: r.error?.message ?? null,
  });
}

const hFinal = await health();
const auditFilesOnDisk = (() => {
  try {
    return readdirSync(AUDIT_DIR).filter((f) => f.endsWith('.jsonl')).length;
  } catch {
    return null;
  }
})();

const result = {
  meta: {
    purpose: 'P2-T7 L1 overflow-gate + attribution observation (drain via tasks/cancel, default 200/1h)',
    zeroSideEffect: 'tasks/cancel 只动本轮 filler；无能力执行、无审批触达',
    startedAt: new Date(t0).toISOString(),
    elapsedMs: Date.now() - t0,
    node: process.version,
    args: { FILL_ROUNDS, FILL_SIZE, MAX_OPS, CONC },
  },
  rounds,
  drains: drains.map((d) => ({
    tag: d.tag,
    cancelled: d.cancelled,
    failed: d.failed,
    passes: d.passes,
    cancelledIdsHead4: d.cancelledIds.slice(0, 4),
    cancelledIdsTail4: d.cancelledIds.slice(-4),
    totalCancelledIds: d.cancelledIds.length,
  })),
  fillIdsHead4: fillIds.slice(0, 4),
  fillIdsTail8: fillIds.slice(-8),
  chainEvictedEntries: Array.isArray(chainHits)
    ? chainHits.map((e) => ({
        ts: e.ts ?? e.timestamp ?? null,
        count: e.ext?.evict?.count ?? null,
        ttl: e.ext?.evict?.ttlCount ?? null,
        overflow: e.ext?.evict?.overflowCount ?? null,
        sampleTaskIds: e.ext?.evict?.sampleTaskIds ?? [],
      }))
    : chainHits,
  probes,
  endState: hFinal,
  summary: {
    overflowGateFired: (hFinal.tasks?.evictedCount ?? 0) > 0,
    evictedCountEnd: hFinal.tasks?.evictedCount ?? null,
    liveEnd: hFinal.tasks?.live ?? null,
    liveWithinCap: (hFinal.tasks?.live ?? 0) <= (hFinal.tasks?.maxTasks ?? 200),
    windowProbesEvictedTrue: probes
      .filter((p) => p.inWindowSample)
      .filter((p) => p.errorData && p.errorData.evicted === true).length,
    windowProbesTotal: probes.filter((p) => p.inWindowSample).length,
    earlyProbesShape: probes
      .filter((p) => p.early)
      .map((p) => ({ hasEvictedKey: p.errorData && 'evicted' in p.errorData, data: p.errorData })),
    neverProbeShape: probes
      .filter((p) => p.never)
      .map((p) => ({ hasEvictedKey: p.errorData && 'evicted' in p.errorData, data: p.errorData })),
    chainTaskEvictedEntries: Array.isArray(chainHits) ? chainHits.length : null,
    chainValidEnd: hFinal.audit?.chainValid ?? null,
    auditEntriesEnd: hFinal.audit?.entries ?? null,
    totalCancelOps: ops,
  },
};
writeFileSync(OUT, JSON.stringify({ ...result, drainsFull: drains.map((d) => d.cancelledIds) }, null, 2), 'utf8');
console.log(`${stamp()} DONE -> ${OUT}`);
console.log(`${stamp()} SUMMARY ${JSON.stringify(result.summary)}`);
console.log(`${stamp()} PROBES ${JSON.stringify(probes)}`);
console.log(`${stamp()} AUDIT_FILES=${auditFilesOnDisk} LIVE=${endLive}`);

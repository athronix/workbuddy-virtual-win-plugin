#!/usr/bin/env node
/**
 * P2-T7 · 真机 **归因四形态**探针（在 VM 内运行，只读）
 *
 * 为什么要单独一个脚本：`t7-round.mjs` 的 victim 预言假设「驱逐次序＝我的创建次序」，
 * 但真机上同时存在第二个观测轮（`t7-burst.mjs`）向**同一个 TaskStore** 投递 ⇒ 第三方 id
 * 也进了驱逐序列 ⇒ 「按序号切片」会预言错。本脚本改用**链上真值**做基准，不受并发负载影响：
 *
 *   · 环窗口**内**（C1）：审计分片里**最后**一条 `ext.kind==='task-evicted'` 的
 *     `ext.evict.sampleTaskIds` —— 该条落链时刻就在驱逐发生后的一瞬，其样本必在容量 64
 *     的环形日志内 ⇒ `tasks/get` 应返回 `error.data = {code:'TaskNotFoundError', evicted:true}`
 *   · 环窗口**外**（C2）：**最早**一条链上条目的 `sampleTaskIds`（早于最后一条 ≥64 次驱逐）
 *     ⇒ 已被环形覆盖 ⇒ **诚实退回旧形状**（`data` 仅含 `code`，无 `evicted` 键）
 *     —— 同一条**真实被逐出**的 id，仅因归因窗口边界而结论不同，这正是 L1 要的「可分且诚实」
 *   · 从未存在（C3）：随机 UUID ⇒ 旧形状逐字节不变（回归红线：纯附加不破既有错误体）
 *   · 存活（C4）：`tasks/list?status=working` 取一条 ⇒ 正常返回 Task（活动任务永不被逐的反证）
 *
 * 附带采集：`/health.tasks`（新键在场 + 曲线终值）、`/health.audit`（chainValid 必须仍 true
 * —— 自发条目不得破坏审计链）、以及本轮窗口的三值默认态（复原对账的前值）。
 * 全程只读：tasks/get + tasks/list + /health + 审计分片文件读取，零投递、零 cancel、零能力。
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const A2A_URL = 'http://127.0.0.1:18443/a2a';
const HEALTH_URL = 'http://127.0.0.1:18443/health';
const AUDIT_DIR = join(process.env.LOCALAPPDATA, 'WinVMBridge', 'audit');
const OUT = process.argv[2] ?? 'C:/WinVMBridge/t7-attribution-result.json';
const RING_CAP = 64;

let rpcId = 1;
async function rpc(method, params, timeoutMs = 15_000) {
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

/** 扫全部审计分片，按 (file,seq) 汇总 task-evicted 条目（升序） */
function chainEvictEntries() {
  const files = readdirSync(AUDIT_DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ f, m: statSync(join(AUDIT_DIR, f)).mtimeMs }));
  const hits = [];
  for (const { f } of files) {
    const raw = readFileSync(join(AUDIT_DIR, f), 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.includes('task-evicted')) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o?.ext?.kind !== 'task-evicted') continue;
      hits.push({
        shard: f,
        seq: o.seq ?? null,
        ts: o.ts ?? null,
        principalChannel: o.principal?.channel ?? null,
        capabilityId: o.capabilityId ?? null,
        risk: o.risk ?? null,
        matchedRule: o.policyDecision?.matchedRule ?? null,
        allowed: o.policyDecision?.allowed ?? null,
        traceId: o.traceId ?? null,
        durationMs: o.result?.durationMs ?? o.ext?.evict?.durationMs ?? null,
        summary: typeof o.result?.summary === 'string' ? o.result.summary.slice(0, 300) : null,
        evict: o.ext?.evict ?? null,
      });
    }
  }
  hits.sort((a, b) => String(a.ts ?? '').localeCompare(String(b.ts ?? '')) || String(a.seq).localeCompare(String(b.seq)));
  return { shards: files.length, hits };
}

/** tasks/list 按状态取 id（分页） */
async function listIds(status, limit = 5) {
  const ids = [];
  let token = '';
  for (let p = 0; p < 8 && ids.length < limit; p += 1) {
    const r = await rpc('tasks/list', { status, pageSize: 50, ...(token ? { pageToken: token } : {}) });
    for (const t of r.result?.tasks ?? []) ids.push(t.id);
    token = r.result?.nextPageToken ?? '';
    if (!token) break;
  }
  return ids.slice(0, limit);
}

async function probe(kind, id, expected) {
  const r = await rpc('tasks/get', { id }).catch((e) => ({ fetchErr: String(e?.message ?? e) }));
  const rec = {
    kind,
    id,
    expected,
    hasResult: r.result !== undefined,
    state: r.result?.status?.state ?? null,
    errorCode: r.error?.code ?? null,
    errorData: r.error?.data ?? null,
    dataKeys: r.error?.data ? Object.keys(r.error.data).sort().join(',') : null,
    hasEvictedKey: Boolean(r.error?.data && 'evicted' in r.error.data),
    evictedTrue: r.error?.data?.evicted === true,
    message: r.error?.message ?? null,
  };
  console.log(`PROBE ${JSON.stringify(rec)}`);
  return rec;
}

const { shards, hits } = chainEvictEntries();
console.log(`CHAIN task-evicted entries=${hits.length} shardsScanned=${shards}`);
for (const h of hits) {
  console.log(
    `  seq=${h.seq} ts=${h.ts} ch=${h.principalChannel} cap=${h.capabilityId} risk=${h.risk} ` +
      `rule=${h.matchedRule} count=${h.evict?.count} ttl=${h.evict?.ttlCount} overflow=${h.evict?.overflowCount} ` +
      `total=${h.evict?.evictedTotal} samples=${(h.evict?.sampleTaskIds ?? []).length} dur=${h.durationMs}`,
  );
}

const probes = [];
if (hits.length > 0) {
  const last = hits[hits.length - 1];
  const first = hits[0];
  for (const id of (last.evict?.sampleTaskIds ?? []).slice(0, 3)) {
    probes.push(await probe('C1-evicted-in-window', id, 'data={code,evicted:true}'));
  }
  if (hits.length >= 2) {
    // 窗口外候选：最早条目样本中「未出现在最近 RING_CAP 条驱逐样本并集里」的 id
    const recent = new Set();
    for (const h of hits.slice(-RING_CAP)) for (const id of h.evict?.sampleTaskIds ?? []) recent.add(id);
    const older = (first.evict?.sampleTaskIds ?? []).filter((id) => !recent.has(id));
    for (const id of older.slice(0, 2)) {
      probes.push(await probe('C2-evicted-out-of-window', id, 'legacy shape (honest false)'));
    }
    if (older.length === 0) {
      probes.push({
        kind: 'C2-evicted-out-of-window',
        note: 'no id fell out of the ring yet (chain entries too few) — rerun after more evictions',
      });
    }
  }
}
const neverId = 't7-never-exists-00000000-0000-0000-0000-000000000000';
probes.push(await probe('C3-never-existed', neverId, 'legacy shape, byte-identical'));
for (const id of await listIds('working', 2)) {
  probes.push(await probe('C4-live', id, 'hasResult (activity never evicted)'));
}

const hres = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(12_000) });
const hj = await hres.json();
const result = {
  meta: { purpose: 'P2-T7 attribution four-shape probe (ground truth from chain samples, read-only)', at: new Date().toISOString(), node: process.version, ringCap: RING_CAP },
  chain: { taskEvictedEntries: hits.length, shardsScanned: shards, entries: hits },
  probes,
  health: { tasks: hj.tasks ?? null, audit: hj.audit ?? null, security: hj.security ?? null, provider: hj.provider ?? null },
  verdict: {
    c1AllEvictedTrue: probes.filter((p) => p.kind === 'C1-evicted-in-window').every((p) => p.evictedTrue === true) && probes.some((p) => p.kind === 'C1-evicted-in-window'),
    c1DataKeysExact: probes.filter((p) => p.kind === 'C1-evicted-in-window').every((p) => p.dataKeys === 'code,evicted'),
    c2HonestFalse: (() => {
      const c2 = probes.filter((p) => p.kind === 'C2-evicted-out-of-window' && p.id);
      return c2.length > 0 ? c2.every((p) => p.hasEvictedKey === false && p.dataKeys === 'code') : 'pending';
    })(),
    c3LegacyShape: probes.filter((p) => p.kind === 'C3-never-existed').every((p) => p.dataKeys === 'code' && p.errorCode === -32602),
    c4LiveHasResult: (() => {
      const c4 = probes.filter((p) => p.kind === 'C4-live');
      return c4.length > 0 ? c4.every((p) => p.hasResult === true) : 'no-working-sample';
    })(),
    evictedKeyPresentInHealth: Boolean(hj.tasks && 'evictedCount' in hj.tasks),
    chainValid: hj.audit?.chainValid ?? null,
    threeValuesDefault:
      hj.security?.authMode === 'loopback-only' &&
      hj.security?.bearerSelfCheck?.code === 'not-mounted' &&
      hj.security?.innerReconnect?.status === 'unverified',
  },
};
writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');
console.log(`VERDICT ${JSON.stringify(result.verdict)}`);
console.log(`HEALTH tasks=${JSON.stringify(hj.tasks)} auditEntries=${hj.audit?.entries} chainValid=${hj.audit?.chainValid}`);
console.log(`DONE -> ${OUT}`);

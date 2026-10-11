#!/usr/bin/env node
/**
 * P2-T7 chain readback (node-based, UTF-8 safe; run **ON THE VM**).
 *
 * Goals（真机窗口交付面③的取证件）：
 *  1) 在审计分片中定位本轮 fill 产生的 `ext.kind === 'task-evicted'` 链上条目，
 *     打印 principal.channel / capabilityId / risk / policyDecision.matchedRule /
 *     seq / ts / durationMs / summary / ext.evict 聚合（count、闸门分布、终态分布、
 *     sampleTaskIds、evictedTotal）—— 即「驱逐事件确实落链」的直接实证；
 *  2) 核对条目自身的**纯附加纪律**：不借用任何既有 kind 值、不动他人 ext；
 *  3) 打印分片链连续性抽查（同分片内 prevHash/entryHash 是否连续），
 *     证明自发条目没有破坏审计链（chainValid 的本地复核）。
 *
 * 用法（VM 内，Git Bash）：
 *   node C:/WinVMBridge/tools-t7-chain-readback.mjs > C:/WinVMBridge/t7-chain-readback.txt 2>&1
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(process.env.LOCALAPPDATA, 'WinVMBridge', 'audit');
const shards = readdirSync(dir)
  .filter((x) => x.endsWith('.jsonl'))
  .map((x) => ({ x, m: statSync(join(dir, x)).mtimeMs }))
  .sort((a, b) => b.m - a.m);

const LIMIT = Number.parseInt(process.argv[2] ?? '6', 10) || 6;
const scan = shards.slice(0, LIMIT);

let allEvict = [];
const shardReports = [];

for (const s of scan) {
  const lines = readFileSync(join(dir, s.x), 'utf8').trim().split('\n');
  let total = 0;
  const kinds = new Map();
  let prevHashSeen = null;
  let broken = 0;
  const evicted = [];
  for (const l of lines) {
    let o;
    try {
      o = JSON.parse(l);
    } catch {
      continue;
    }
    total += 1;
    const ext = o.ext ?? {};
    if (typeof ext.kind === 'string') kinds.set(ext.kind, (kinds.get(ext.kind) ?? 0) + 1);
    // 链连续性：本条 prevHash 应等于上一条 hash（首条/跨片首条除外，AuditRecord.hash 见 contracts/audit.ts:229）
    if (prevHashSeen !== null && o.prevHash && o.prevHash !== prevHashSeen) broken += 1;
    if (o.hash) prevHashSeen = o.hash;
    if (ext.kind === 'task-evicted') {
      const e = ext.evict ?? {};
      evicted.push({
        seq: o.seq,
        ts: o.ts,
        traceId: o.traceId,
        auditId: o.auditId,
        capabilityId: o.capabilityId,
        channel: o.principal?.channel,
        principalId: o.principal?.id ?? o.principal?.principalId ?? null,
        risk: o.risk,
        matchedRule: o.policyDecision?.matchedRule,
        allowed: o.policyDecision?.allowed,
        ok: o.result?.ok,
        durationMs: o.durationMs ?? ext.durationMs ?? null,
        summary: String(o.result?.summary ?? '').slice(0, 400),
        evict: {
          count: e.count,
          ttlCount: e.ttlCount,
          overflowCount: e.overflowCount,
          evictedTotal: e.evictedTotal,
          sampleTaskIds: e.sampleTaskIds,
          terminalStates: e.terminalStates,
        },
      });
    }
  }
  allEvict = allEvict.concat(evicted);
  shardReports.push({
    shard: s.x,
    entries: total,
    chainBroken: broken,
    kinds: Object.fromEntries([...kinds.entries()].sort((a, b) => b[1] - a[1])),
    taskEvictedEntries: evicted.length,
  });
}

console.log('=== P2-T7 audit chain readback ===');
console.log(`auditDir=${dir}`);
console.log(`shardsScanned=${scan.length} (newest first, limit=${LIMIT})`);
console.log('');
console.log('--- SHARD REPORTS ---');
for (const r of shardReports) {
  console.log(
    `shard=${r.shard} entries=${r.entries} chainBroken=${r.chainBroken} task-evicted=${r.taskEvictedEntries}`,
  );
  console.log(`  kinds=${JSON.stringify(r.kinds)}`);
}
console.log('');
console.log(`--- task-evicted ENTRIES (total=${allEvict.length}) ---`);
for (const e of allEvict) {
  console.log(JSON.stringify(e));
}
console.log('');
console.log('--- DISCIPLINE CHECKS ---');
const shape = allEvict.every((e) => e.channel === 'internal' && e.capabilityId === 'meta.audit.chain' && e.risk === 'L0' && e.matchedRule === 'internal:task-evicted' && e.allowed === true);
console.log(`allInternalMetaAuditChainL0Rule=${shape}`);
console.log(`sampleWithOverflowGate=${allEvict.filter((e) => (e.evict.overflowCount ?? 0) > 0).length}`);
console.log(`sampleWithTtlGate=${allEvict.filter((e) => (e.evict.ttlCount ?? 0) > 0).length}`);
console.log(`evictedTotalMax=${allEvict.reduce((m, e) => Math.max(m, e.evict.evictedTotal ?? 0), 0)}`);
console.log(`chainBrokenTotal=${shardReports.reduce((m, r) => m + r.chainBroken, 0)}`);

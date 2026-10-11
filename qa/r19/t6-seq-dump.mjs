#!/usr/bin/env node
/** P2-T6: dump selected raw chain lines (UTF-8 safe, run ON THE VM). usage: node t6-seq-dump.mjs <shardBasename> <seq1,seq2,...> */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(process.env.LOCALAPPDATA, 'WinVMBridge', 'audit');
const shard = process.argv[2];
const want = new Set((process.argv[3] ?? '').split(',').map((x) => Number(x)));
const lines = readFileSync(join(dir, shard), 'utf8').trim().split('\n');
for (const l of lines) {
  let o;
  try { o = JSON.parse(l); } catch { continue; }
  if (want.size && !want.has(o.seq)) continue;
  console.log('--- seq=' + o.seq + ' ts=' + o.ts + ' cap=' + o.capabilityId + ' ch=' + (o.principal && o.principal.channel));
  console.log('    result.ok=' + (o.result && o.result.ok) + ' summary=' + String((o.result && o.result.summary) || '').slice(0, 300));
  console.log('    error=' + JSON.stringify((o.result && o.result.error) || null).slice(0, 300));
  console.log('    ext=' + JSON.stringify(o.ext || {}).slice(0, 500));
}
console.log('DUMP_DONE');

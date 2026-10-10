#!/usr/bin/env node
/**
 * P2-T5 refuse-path chain readback (node-based, UTF-8 safe — PS5.1 Get-Content mangles
 * the UTF-8 Chinese summaries, so we parse the shard directly with node).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(process.env.LOCALAPPDATA, 'WinVMBridge', 'audit');
const shards = readdirSync(dir)
  .filter((x) => x.endsWith('.jsonl'))
  .map((x) => ({ x, m: statSync(join(dir, x)).mtimeMs }))
  .sort((a, b) => b.m - a.m);
const active = shards[0];
console.log('ACTIVE=' + active.x + ' size=' + statSync(join(dir, active.x)).size);

const lines = readFileSync(join(dir, active.x), 'utf8').trim().split('\n');
for (const l of lines) {
  let o;
  try {
    o = JSON.parse(l);
  } catch {
    console.log('PARSE_ERR len=' + l.length);
    continue;
  }
  const rule = o.policyDecision ? o.policyDecision.matchedRule : '-';
  const ext = o.ext ?? {};
  console.log(
    'seq=' + o.seq +
    ' ts=' + o.ts +
    ' rule=' + rule +
    ' ok=' + (o.result ? o.result.ok : '-') +
    ' refused=' + ext.refused +
    ' inner=' + (ext.innerReconnect ? ext.innerReconnect.status : '-') +
    ' selfCheck=' + (ext.selfCheck ? ext.selfCheck.code : '-') +
    ' authMode=' + ext.authMode +
    ' failClosed=' + ext.failClosed +
    ' prevHash=' + String(o.prevHash).slice(0, 8) +
    ' hash=' + String(o.hash).slice(0, 8) +
    ' principal.channel=' + o.principal.channel +
    ' cap=' + o.capabilityId +
    ' risk=' + o.risk,
  );
  if (o.result && o.result.summary) console.log('  summary=' + o.result.summary);
}
console.log('SUMMARY_LINES=' + lines.length);
console.log('READBACK_DONE');

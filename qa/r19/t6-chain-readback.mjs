#!/usr/bin/env node
/**
 * P2-T6 chain readback (node-based, UTF-8 safe; run ON THE VM).
 *
 * Goals:
 *  1) locate delegation-complete entry for the E5 traceId and print zeroInnerCalls /
 *     blockedCount / underlying (the T5 harm shape is completed + zeroInnerCalls:true);
 *  2) list inner tool-call entries (channel=mcp with ext.delegationId == the traceId)
 *     => proof the VM-side CLI reconnect actually reached the service with the bearer;
 *  3) print bearer-selfcheck entries of the current boot (authMode/inner/status)
 *     => shows the config-face verdict the fail-closed decision used;
 *  4) count AUTH 401s? (refusals never enter the chain by design -> only warn log;
 *     we print the guard-reject marker if any appears in cap entries anyway).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const TRACE = process.argv[2] ?? '';
const dir = join(process.env.LOCALAPPDATA, 'WinVMBridge', 'audit');
const shards = readdirSync(dir)
  .filter((x) => x.endsWith('.jsonl'))
  .map((x) => ({ x, m: statSync(join(dir, x)).mtimeMs }))
  .sort((a, b) => b.m - a.m);

const pick = [];
for (const s of shards.slice(0, 3)) {
  const lines = readFileSync(join(dir, s.x), 'utf8').trim().split('\n');
  const selfcheck = [];
  const inner = [];
  const delegation = [];
  let total = 0;
  for (const l of lines) {
    let o;
    try { o = JSON.parse(l); } catch { continue; }
    total++;
    const ext = o.ext ?? {};
    const rule = o.policyDecision ? o.policyDecision.matchedRule : '-';
    if (ext.kind === 'bearer-selfcheck') {
      selfcheck.push(
        `  seq=${o.seq} ts=${o.ts} rule=${rule} ok=${o.result?.ok} refused=${ext.refused} ` +
        `inner=${ext.innerReconnect?.status} selfCheck=${ext.selfCheck?.code} authMode=${ext.authMode} failClosed=${ext.failClosed}`,
      );
      if (o.result?.summary) selfcheck.push(`    summary=${String(o.result.summary).slice(0, 260)}`);
    }
    if (TRACE && ext.delegationId === TRACE) {
      inner.push(
        `  seq=${o.seq} ts=${o.ts} cap=${o.capabilityId} ch=${o.principal?.channel} ok=${o.result?.ok} ` +
        `risk=${o.risk} zeroInnerCalls=${ext.zeroInnerCalls} blocked=${ext.blockedCount ?? '-'} ` +
        `underlying=${JSON.stringify(ext.underlying ?? [])} rule=${rule}`,
      );
    }
    if (TRACE && (ext.kind === 'delegation' || rule === 'delegation.complete' || String(o.capabilityId || '').startsWith('a2a.'))) {
      delegation.push(
        `  seq=${o.seq} ts=${o.ts} cap=${o.capabilityId} ext.kind=${ext.kind} terminal=${ext.terminalState} ` +
        `zeroInnerCalls=${ext.zeroInnerCalls} delegationId=${ext.delegationId} ok=${o.result?.ok} ` +
        `errorCode=${ext.errorCode ?? '-'} summary=${String(o.result?.summary ?? '').slice(0, 200)}`,
      );
    }
  }
  pick.push(`SHARD=${s.x} total=${total}`);
  pick.push('BEARER_SELFCHECK_ENTRIES:');
  pick.push(...(selfcheck.length ? selfcheck : ['  (none)']));
  pick.push(`INNER_ENTRIES_FOR_TRACE=${TRACE}: ${inner.length}`);
  pick.push(...inner.slice(0, 40));
  pick.push('DELEGATION_SHAPE:');
  pick.push(...(delegation.length ? delegation : ['  (none)']));
}
console.log(pick.join('\n'));
console.log('READBACK_DONE');

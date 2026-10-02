// R19 QA direct-call harness (MCP tools/call over POST /mcp)
// usage: node call.mjs <outFilePrefix> <toolName> '<jsonArgs>' [--timeout-ms N]
// Writes: <prefix>.req.json  <prefix>.resp.json  <prefix>.meta.json
import { writeFileSync } from 'node:fs';

const ENDPOINT = process.env.WINVM_MCP || 'http://127.0.0.1:18443/mcp';
const [, , prefix, tool, rawArgs, ...rest] = process.argv;
const timeoutFlag = rest.find((a) => a.startsWith('--timeout-ms'));
const TIMEOUT = timeoutFlag ? Number(timeoutFlag.split('=')[1]) : 660000;
const params = rawArgs ? JSON.parse(rawArgs) : {};

let sid = null;
async function rpc(method, p, id = Math.floor(Math.random() * 1e6)) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (sid) headers['Mcp-Session-Id'] = sid;
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params: p }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const s = res.headers.get('mcp-session-id');
  if (s) sid = s;
  const text = await res.text();
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  return { httpStatus: res.status, payload: JSON.parse(line ? line.slice(6) : text), raw: text };
}

await rpc('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'winvm-r19-qa', version: '1.0' },
});
try {
  await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(sid ? { 'Mcp-Session-Id': sid } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
} catch { /* ignore */ }

const startedAt = new Date().toISOString();
const t0 = Date.now();
let outcome;
try {
  const r = await rpc('tools/call', { name: tool, arguments: params });
  outcome = { ok: true, httpStatus: r.httpStatus, payload: r.payload };
} catch (e) {
  outcome = { ok: false, error: String(e && e.message || e), name: e && e.name };
}
const elapsedMs = Date.now() - t0;
const finishedAt = new Date().toISOString();

writeFileSync(`${prefix}.req.json`, JSON.stringify({ tool, arguments: params, startedAt }, null, 2));
writeFileSync(`${prefix}.resp.json`, JSON.stringify(outcome, null, 2));
writeFileSync(`${prefix}.meta.json`, JSON.stringify({
  tool, startedAt, finishedAt, elapsedMs, ok: outcome.ok,
  httpStatus: outcome.httpStatus ?? null,
  isError: !!(outcome.payload && (outcome.payload.error || outcome.payload.result?.isError)),
}, null, 2));
console.log(`### ${tool} ok=${outcome.ok} http=${outcome.httpStatus ?? '-'} ${elapsedMs}ms`);
const out = outcome.payload ? (outcome.payload.result ?? outcome.payload.error) : outcome.error;
console.log(JSON.stringify(out, null, 1).slice(0, 6000));

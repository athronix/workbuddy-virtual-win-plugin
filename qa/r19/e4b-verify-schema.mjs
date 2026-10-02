// QA read-only verification: capture tools/list schemas for OBS-E claim (no source changes)
import { writeFileSync } from 'node:fs';
const E = 'http://127.0.0.1:18443/mcp';
let sid = null;
async function rpc(method, params, id = 1) {
  const r = await fetch(E, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(sid ? { 'Mcp-Session-Id': sid } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    signal: AbortSignal.timeout(20000),
  });
  const s = r.headers.get('mcp-session-id');
  if (s) sid = s;
  const t = await r.text();
  const l = t.split('\n').find((x) => x.startsWith('data: '));
  return JSON.parse(l ? l.slice(6) : t);
}
await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'qa-r19b', version: '1' } });
const res = await rpc('tools/list', {});
const tools = res.result.tools;
writeFileSync('e4b-toolslist.json', JSON.stringify(tools.map((t) => ({ name: t.name, props: Object.keys(t.inputSchema.properties || {}) })), null, 2));
for (const n of ['storage.file.write', 'storage.dir.manage', 'appops.workflow.run', 'system.registry.read']) {
  const f = tools.find((x) => x.name === n);
  console.log(n, '->', JSON.stringify(Object.keys(f?.inputSchema.properties || {})));
}
console.log('total tools', tools.length);

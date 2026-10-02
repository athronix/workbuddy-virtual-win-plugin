// read VM audit jsonl via storage.file.read (L0) and save locally
// usage: node read-audit.mjs <vmPath> <outFile>
import { writeFileSync } from 'node:fs';
const [, , vmPath, outFile] = process.argv;
const ENDPOINT = 'http://127.0.0.1:18443/mcp';
let sid = null;
async function rpc(method, params, id = 1) {
  const h = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (sid) h['Mcp-Session-Id'] = sid;
  const r = await fetch(ENDPOINT, { method: 'POST', headers: h, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
  const s = r.headers.get('mcp-session-id');
  if (s) sid = s;
  const t = await r.text();
  const line = t.split('\n').find((l) => l.startsWith('data: '));
  return JSON.parse(line ? line.slice(6) : t);
}
await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'qa-audit', version: '1' } });
try {
  await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Mcp-Session-Id': sid }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
} catch { /* ignore */ }
const r = await rpc('tools/call', { name: 'storage.file.read', arguments: { path: vmPath } });
const sc = r.result?.structuredContent;
let content = sc?.data?.content ?? sc?.data?.text ?? sc?.content;
if (typeof content !== 'string') content = JSON.stringify(sc, null, 1);
writeFileSync(outFile, content);
console.log('saved', outFile, 'len', content.length, 'ok=', sc?.ok);

// 极简 MCP Streamable-HTTP 客户端（测试夹具）
// 用法: node mcp.mjs <capability> '<json-args>'
//       node mcp.mjs --list
const ENDPOINT = process.env.WINVM_MCP || 'http://127.0.0.1:18443/mcp';

let sid = null;
async function rpc(method, params, id = Math.floor(Math.random() * 1e6)) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (sid) headers['Mcp-Session-Id'] = sid;
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const s = res.headers.get('mcp-session-id');
  if (s) sid = s;
  const text = await res.text();
  // SSE 解析
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  const payload = JSON.parse(line ? line.slice(6) : text);
  return { httpStatus: res.status, payload };
}

async function init() {
  const r = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'winvm-e2e', version: '1.0' },
  });
  try {
    await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(sid ? { 'Mcp-Session-Id': sid } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
  } catch {}
  return r;
}

const args = process.argv.slice(2);
await init();
if (args[0] === '--list') {
  const r = await rpc('tools/list', {});
  console.log(JSON.stringify(r.payload.result.tools.map((t) => t.name), null, 0));
} else {
  const cap = args[0];
  const p = args[1] ? JSON.parse(args[1]) : {};
  const t0 = Date.now();
  const r = await rpc('tools/call', { name: cap, arguments: p });
  const ms = Date.now() - t0;
  const out = r.payload.result ?? r.payload.error;
  const isErr = !!r.payload.error || r.payload.result?.isError;
  console.log(`### ${cap}  http=${r.httpStatus} ${ms}ms  ${isErr ? 'ERROR' : 'OK'}`);
  console.log(JSON.stringify(out).slice(0, 4000));
}

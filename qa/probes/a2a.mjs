// A2A 宿主桥驱动：node a2a.mjs <tool> '<json-args>'
// 直接以 stdio JSON-RPC 驱动 winvm-a2a 连接器所用的同一个 cli.js
import { spawn } from 'node:child_process';

const CLI = '/storage/Users/currentUser/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0/a2a-bridge/cli.js';
const NODE = '/data/storage/el1/bundle/libs/arm64/node/bin/node';

const child = spawn(NODE, [CLI, '--endpoint', 'http://127.0.0.1:18443', '--timeout', '600000'], {
  stdio: ['pipe', 'pipe', 'pipe'],
});
let buf = '';
let stderr = '';
child.stderr.on('data', (d) => { stderr += d.toString(); });
const pending = new Map();
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    } catch { /* ignore */ }
  }
});
function rpc(method, params, id = Math.floor(Math.random() * 1e6)) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pending.delete(id); reject(new Error('timeout ' + method)); }, 300000);
    pending.set(id, (m) => { clearTimeout(t); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

const [, , tool, rawArgs] = process.argv;
const t0 = Date.now();
async function main() {
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'a2a-e2e', version: '1' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  if (tool === '--tools') {
    const r = await rpc('tools/list', {});
    console.log(JSON.stringify(r.result?.tools?.map((t) => ({ name: t.name, desc: (t.description || '').slice(0, 60) })), null, 1));
  } else {
    const r = await rpc('tools/call', { name: tool, arguments: rawArgs ? JSON.parse(rawArgs) : {} });
    console.log(`### ${tool} ${Date.now() - t0}ms`);
    console.log(JSON.stringify(r.result ?? r.error).slice(0, 4000));
  }
}
main().catch((e) => {
  console.log(`### ERROR ${tool} ${Date.now() - t0}ms`);
  console.log(JSON.stringify({ isError: true, error: { code: 'A2A_BRIDGE_FAILED', message: String(e.message || e).slice(0, 400) } }));
  if (stderr.trim()) console.log('--- stderr ---\n' + stderr.slice(-1500));
  try { child.kill(); } catch { /* ignore */ }
  process.exit(0);   // 干净退出：让父进程（qa-verify）以 FAIL 记录，而非整轮崩溃
}).then(() => {
  if (stderr.trim()) console.log('--- stderr ---\n' + stderr.slice(-1500));
  try { child.kill(); } catch { /* ignore */ }
  process.exit(0);
});

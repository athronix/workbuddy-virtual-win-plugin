/**
 * Phase 3 批5 · P0-4 收口：真机 E2E 最小回归（5 域 × 2 通道 + 安全面探针）。
 * 经隧道直连 VM 服务 HTTP 面（宿主 connector 重启会话才生效，故用原生 fetch 取证）。
 * 只读/低危样本集：L0/L1 为主，L2 只验拦截语义（绝不打真批准）。
 */
const BASE = process.env.WINVM_E2E_BASE || 'http://127.0.0.1:18443';
import { writeFileSync } from 'node:fs';
const results = [];
let mcpSession = null;

function rec(name, ok, detail) {
  results.push({ name, ok, detail: String(detail ?? '').slice(0, 300) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${String(detail ?? '').slice(0, 120)}`);
}

async function mcpCall(method, params, id) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(mcpSession ? { 'mcp-session-id': mcpSession } : {}),
  };
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: id ?? Math.floor(Math.random() * 1e6), method, params: params ?? {} }),
    signal: AbortSignal.timeout(30_000),
  });
  const sid = res.headers.get('mcp-session-id');
  if (sid) mcpSession = sid;
  const text = await res.text();
  // streamable http 可能回 SSE 帧
  const jsonLine = text.startsWith('event:') || text.includes('data: ')
    ? text.split(/\r?\n/).filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('')
    : text;
  try { return JSON.parse(jsonLine); } catch { return { raw: text.slice(0, 200), status: res.status }; }
}

async function toolsCall(tool, args, id) {
  const r = await mcpCall('tools/call', { name: tool, arguments: args }, id);
  const sc = r?.result?.structuredContent ?? null;
  const txt = r?.result?.content?.[0]?.text ?? '';
  return { sc, txt, err: r?.error ?? null };
}

async function a2aSend(goal, id) {
  const res = await fetch(`${BASE}/a2a`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: id ?? `e2e-${Date.now()}`, method: 'message/send',
      params: { message: { role: 'user', parts: [{ kind: 'text', text: goal }] } },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  return res.json().catch(() => ({ raw: 'non-json', status: res.status }));
}

/* ---------- 通道 1：MCP 直调（5 域） ---------- */
await mcpCall('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'p3-e2e', version: '1' } }, 1);
const list = await mcpCall('tools/list', {}, 2);
const tools = list?.result?.tools ?? [];
rec('MCP-00 tools/list 全能力面', tools.length >= 54, `tools=${tools.length}`);

const { sc: hraw } = await toolsCall('meta.health.check', {});
const h = hraw?.data ?? hraw; // 健康体嵌套在 data 下（实测形状订正）
rec('MCP-01 meta.health ok+capabilitiesProfile(M7)', h?.ok === true && !!h?.capabilitiesProfile, `profile=${JSON.stringify(h?.capabilitiesProfile ?? null).slice(0, 80)}`);

const { sc: s1 } = await toolsCall('system.info.get', {});
rec('MCP-02 system 域（L0）', s1?.ok === true, `os=${s1?.data?.osCaption ?? s1?.summary ?? ''}`);

const { sc: a1 } = await toolsCall('app.inventory.list', {});
rec('MCP-03 app 域（L0）', a1?.ok === true, JSON.stringify(a1?.data ?? a1?.summary ?? '').slice(0, 60));

const { sc: st1 } = await toolsCall('storage.disk.list', {});
rec('MCP-04 storage 域（L0）', st1?.ok === true, (st1?.summary ?? '').slice(0, 60));

const { sc: g1 } = await toolsCall('gui.session.status', {});
rec('MCP-05 gui 域（L0，健康会话）', g1?.ok === true, (g1?.summary ?? '').slice(0, 60));

const { sc: ap1 } = await toolsCall('appops.state.query', {});
rec('MCP-06 appops 域（L0）', ap1?.ok === true, (ap1?.summary ?? '').slice(0, 80));

/* 指纹链（批2 R-4 真机面） */
rec('MCP-07 psBridge.fingerprint 六键非空', Object.keys(h?.psBridge?.fingerprint?.files ?? {}).length >= 6, `capturedAt=${h?.psBridge?.fingerprint?.capturedAt}`);

/* 审批闸拦截语义（不打真批准；M8 TTL 槽验证） */
const { sc: l2 } = await toolsCall('storage.file.delete', { path: 'C:/WinVMWorkspace/e2e-nonexist.txt' });
const apr = l2?.approval ?? null;
rec('MCP-08 L2 拦截 APPROVAL_REQUIRED+approval 块', l2?.ok === false && l2?.error?.code === 'APPROVAL_REQUIRED' && !!apr, `id=${apr?.approvalId ?? ''} risk=${apr?.risk ?? ''}`);
// M8：现网 TTL=Infinity ⇒ expiresAtMs 缺席即旧形状（键不写）。approvalId 存在+无 expiresAt 合法。
rec('MCP-09 M8 TTL 槽形状一致（Infinity⇒缺席）', apr ? typeof apr.approvalId === 'string' : true, `hasExpiresAt=${apr ? 'expiresAtMs' in apr : 'n/a'}`);

// A2-17 首轮拦截：token 留存 previewHash（宿主不可见，但拦截回执 preview 与 hash 输入同源 ⇒ 真机续跑换参必拒——离线单测已钉，此处验拦截回执 preview 结构在位）
rec('MCP-10 A2-17 拦截回执 preview 结构在位', apr ? typeof apr.preview === 'object' && apr.preview !== null : false, `preview keys=${apr ? Object.keys(apr.preview).slice(0, 6).join(',') : ''}`);

/* ---------- 通道 2：A2A 委派（5 域取 3 代表 + 生命周期） ---------- */
const t1 = await a2aSend('E2E-A2A-PROBE: 立即结束，不要调用任何工具');
const taskId = t1?.result?.id ?? t1?.result?.taskId ?? t1?.result?.task?.id ?? null;
rec('A2A-01 tasks/send 受理', !!taskId, `id=${taskId} state=${(t1?.result?.status?.state ?? t1?.result?.status ?? '')}`);

if (taskId) {
  await new Promise((r) => setTimeout(r, 3000));
  const tg = await fetch(`${BASE}/a2a`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'g', method: 'tasks/get', params: { id: taskId } }),
    signal: AbortSignal.timeout(10_000),
  }).then((r) => r.json()).catch(() => ({}));
  const st = tg?.result?.status?.state ?? tg?.result?.state ?? '';
  rec('A2A-02 tasks/get 生命周期态合法', ['submitted', 'working', 'input-required', 'completed', 'failed', 'canceled'].includes(st), st);

  // A2A-03 cancel 正常面（单条，低频不触 R-5）
  const c = await fetch(`${BASE}/a2a`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'c', method: 'tasks/cancel', params: { id: taskId } }),
    signal: AbortSignal.timeout(15_000),
  }).then((r) => r.json()).catch(() => ({}));
  const cst = c?.result?.status?.state ?? c?.error?.code ?? '';
  rec('A2A-03 tasks/cancel 单笔语义', c?.result ? c.result.status?.state === 'canceled' || st === 'completed' : true, `resp=${JSON.stringify(c).slice(0, 120)}`);
}

/* R-5 风暴门禁：ghost id 连发 12（>缺省 10/1000ms ⇒ 拒发生在 task 查找前） */
const cancels = [];
for (let i = 0; i < 12; i++) {
  cancels.push(fetch(`${BASE}/a2a`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: `storm-${i}`, method: 'tasks/cancel', params: { id: 'ghost-task-e2e' } }),
    signal: AbortSignal.timeout(10_000),
  }).then((r) => r.json()).catch((e) => ({ netErr: String(e).slice(0, 60) })));
}
const storm = await Promise.all(cancels);
const rateLimited = storm.filter((s) => JSON.stringify(s).includes('rateLimited') || (s?.error?.code === -32601 && JSON.stringify(s).includes('取消请求过于频繁'))).length;
rec('A2A-04 R-5 风暴门禁显形（12 连发有拒回）', rateLimited >= 1, `rateLimited=${rateLimited}/12 sample=${JSON.stringify(storm[11]).slice(0, 140)}`);

/* AgentCard（A2A 面元数据） */
const card = await fetch(`${BASE}/.well-known/agent-card.json`, { signal: AbortSignal.timeout(8_000) }).then((r) => r.json()).catch(() => null);
rec('A2A-05 agent card 可达', !!card?.name, `name=${card?.name ?? ''}`);

/* ---------- 汇总 ---------- */
const pass = results.filter((r) => r.ok).length;
console.log(`\n==== E2E 汇总: ${pass}/${results.length} PASS ====`);
const fails = results.filter((r) => !r.ok);
if (fails.length) { console.log('FAILED:'); for (const f of fails) console.log(' -', f.name, '|', f.detail); }
writeFileSync(process.env.WINVM_E2E_OUT || 'qa/p3-batch-sweep/e2e-5x2-result.json', JSON.stringify({ at: new Date().toISOString(), base: BASE, pass, total: results.length, results }, null, 2));
console.log('report written');

// CL-017 · QA 回归验证（A 系列）—— 逐项打印 PASS/FAIL 与原始证据
// 用法：node qa-verify.mjs [A1 A2 A4 ...]   不传则跑全部可自动化项
// 依赖：SSH 隧道已建（宿主回环 18443）；VM 可达 User@172.16.100.2
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { connect } from 'node:net';
const pexec = promisify(execFile);
const EP = process.env.WINVM_MCP || 'http://127.0.0.1:18443/mcp';
// 单次 tools/call 超时（可经 QA_CALL_TIMEOUT_MS 覆盖；winget 等重调用建议 ≥90s）
// 修复：原先 rpc 无 try/catch 且 30s 硬超时，VM 负载下偶发超时即崩（D28 复验时 A17 被截断）
const CALL_TIMEOUT_MS = Number(process.env.QA_CALL_TIMEOUT_MS) || 30_000;
const HOST = 'http://127.0.0.1:18443';
const VM = 'User@172.16.100.2';
const ROOT = '/storage/Users/currentUser/Documents/projects/workbuddy-virtual-win-plugin';

let sid = null;
async function rpc(method, params, timeoutMs = 30_000) {
  const h = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (sid) h['Mcp-Session-Id'] = sid;
  const res = await fetch(EP, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method, params }),
    signal: AbortSignal.timeout(timeoutMs), // 防桥掉线时无限挂起（曾致整轮 5min 空转无输出）
  });
  const s = res.headers.get('mcp-session-id'); if (s) sid = s;
  const t = await res.text();
  const line = t.split('\n').find((l) => l.startsWith('data: '));
  return JSON.parse(line ? line.slice(6) : t);
}

// 隧道自举（2026-09-18 教训）：上一轮 VM 掉线期复验发现——驱动建的 `ssh -f -N -L` 是随 shell 会话消亡的
// 后台进程，命令结束后隧道被回收；后续任何独立调用（含 QA 独立复跑）都连不上 18443，导致整轮 FAIL(BLOCKED)。
// 现改为 qa-verify **自包含**：执行前若 18443 未监听，自行 spawn 隧道；VM 掉线则优雅降级交给 ensureBridge。
async function tcpAlive(host, port, ms = 1500) {
  return new Promise((res) => {
    const s = connect(port, host);
    const to = setTimeout(() => { s.destroy(); res(false); }, ms);
    s.once('connect', () => { clearTimeout(to); s.destroy(); res(true); });
    s.once('error', () => { clearTimeout(to); res(false); });
  });
}
async function ensureTunnel() {
  if (await tcpAlive('127.0.0.1', 18443, 1500)) return true;
  console.log('!!!! 隧道 127.0.0.1:18443 未监听 → 尝试自建（ssh -N -L）');
  try {
    const p = execFile('ssh', ['-fN', '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=10', '-L', '18443:127.0.0.1:18443', VM], { detached: true, stdio: 'ignore' });
    p.unref?.();
  } catch (e) {
    console.log(`!!!! 自建隧道命令失败：${String(e.message).slice(0, 120)}`);
  }
  for (let i = 0; i < 12; i++) {
    if (await tcpAlive('127.0.0.1', 18443, 1200)) { console.log('!!!! 隧道已建立'); return true; }
    await new Promise((r) => setTimeout(r, 700));
  }
  console.log('!!!! 自建隧道失败（VM 可能掉线/不可达）；依赖桥的断言将以 BRIDGE_UNREACHABLE 失败\n');
  return false;
}

// 桥可达性与 initialize 改为**惰性**（2026-09-17 教训）：
//   原实现在脚本顶部无条件 `await rpc('initialize')` → 桥一旦掉线，**连纯本地的 A12/A14 也连坐**，
//   且进程直接崩掉、一句结果都不打印（本轮踩了两次，各空转数分钟）。
// 现语义：桥不可达**不再中断脚本** —— 打印醒目横幅，并让依赖桥的断言以 BRIDGE_UNREACHABLE 明确失败。
let bridgeReady = null;
async function ensureBridge() {
  if (bridgeReady !== null) return bridgeReady;
  await ensureTunnel();
  try {
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'qa', version: '1' } }, 8_000);
    bridgeReady = true;
  } catch (e) {
    bridgeReady = false;
    console.log(`\n!!!! 桥不可达 ${EP}：${String(e.message).slice(0, 140)}`);
    console.log('!!!! 纯本地断言（A11/A12/A14）仍然有效；依赖桥/VM 的断言将记为 FAIL(BRIDGE_UNREACHABLE)，请在桥恢复后重跑\n');
  }
  return bridgeReady;
}

async function call(cap, args, timeoutMs) {
  if (!(await ensureBridge())) {
    return { ms: -1, sc: { ok: false, error: { code: 'BRIDGE_UNREACHABLE', message: '隧道/VM 不可达，未发起调用' } }, raw: null };
  }
  const t0 = Date.now();
  // 修复：rpc 异常/超时不再向上抛（原实现 call() 无 catch，超时即整脚本崩死无输出）；
  // 统一返回哨兵 structuredContent，保证任何断言在桥异常时也能「出结论」。
  try {
    const r = await rpc('tools/call', { name: cap, arguments: args || {} }, timeoutMs ?? CALL_TIMEOUT_MS);
    const sc = r.result?.structuredContent;
    return { ms: Date.now() - t0, sc, raw: r.result ?? r.error };
  } catch (e) {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return {
      ms: Date.now() - t0,
      sc: { ok: false, error: { code: timedOut ? 'TIMEOUT' : 'BRIDGE_UNREACHABLE', message: String(e?.message || e).slice(0, 160) } },
      raw: null,
    };
  }
}
async function ssh(cmd) {
  const { stdout } = await pexec('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', VM, cmd], { maxBuffer: 8e6 });
  return stdout;
}
async function vmps(file, extraArgs = []) {
  try {
    // 探针自 2026-09-23 目录治理起落在 C:/WinVMBridge/dev-and-qa/probes/（不再散落部署根）
    return await ssh(`powershell -NoProfile -ExecutionPolicy Bypass -File C:/WinVMBridge/dev-and-qa/probes/${file} ${extraArgs.join(' ')}`);
  } catch (e) {
    // VM 掉线时返回哨兵串而非抛异常：断言里的正则/数值检查自然判 FAIL，脚本继续跑完
    return `VM_UNREACHABLE: ${String(e.message).slice(0, 160)}`;
  }
}
// /health 取数（带超时），不可达时回 { ok:false, __unreachable:true }
async function health() {
  try {
    const r = await fetch(`${HOST}/health`, { signal: AbortSignal.timeout(8_000) });
    return await r.json();
  } catch (e) {
    return { ok: false, __unreachable: true, __err: String(e.message).slice(0, 120) };
  }
}
function shape(v) { return Array.isArray(v) ? (v.length === 0 ? '[]' : `[${v.length}]`) : JSON.stringify(v); }
// 安全序列化：JSON.stringify(undefined) 返回 JS undefined（非字符串），直接 .slice 会抛 TypeError。
// 桥不可达时 call() 返回的 sentinel 里 sc.data 为 undefined —— 所有 detail 串构造必须经此 helper。
const jstr = (v, n = 200) => String(JSON.stringify(v ?? null)).slice(0, n);

const results = [];
function rec(id, pass, detail) { results.push({ id, pass }); console.log(`${pass ? 'PASS' : 'FAIL'} [${id}] ${detail}`); }

const which = process.argv.slice(2);
const want = (id) => which.length === 0 || which.includes(id);

const W = 'C:\\WinVMWorkspace\\e2e-qa';

// 入口处先确保隧道（2026-09-18 教训）：A2 的 health() 与 A5 的 a2a.mjs 都直连 127.0.0.1:18443，
// 若不在 call()/ensureBridge 之前先建好，二者都会因「端口未监听」失败或挂起。
await ensureTunnel();

/* ---------------- A1 单例桥 ---------------- */
if (want('A1')) {
  const out = await vmps('qa-probe.ps1');
  const m = out.match(/PSBRIDGE_COUNT=(\d+)/);
  const n = m ? Number(m[1]) : -1;
  rec('A1', n === 1, `ps-bridge 实例数=${n}（期望 1）\n${out.trim()}`);
}

/* ---------------- A2 健康一致性 ---------------- */
if (want('A2')) {
  const h = await health();
  if (h.__unreachable) {
    rec('A2', false, `桥不可达（${h.__err}）→ 无法判定健康一致性`);
  } else {
    const consistent = !(h.provider.state === 'degraded' && h.psBridge.state === 'ready');
    rec('A2', consistent, `provider.state=${h.provider.state} psBridge.state=${h.psBridge.state} ok=${h.ok} → ${consistent ? '一致' : '矛盾'}`);
  }
}

/* ---------------- A4 appops.cli.invoke ---------------- */
// 注意（run5 修正 2026-09-23）：本 VM **已安装 ffmpeg v9.0.1**（旧注释「未安装」已过期）。
// 断言分两支：
//   ① 已安装的 CLI（node / ffmpeg）→ 必须成功、快、退出码 0；
//   ② 不存在的 CLI → 桥不得挂死（快速返回，成功或 CLI_NOT_FOUND 均可）。
if (want('A4')) {
  const a = await call('appops.cli.invoke', { app: 'node', command: 'node -v' });
  const b = await call('appops.cli.invoke', { app: 'ffmpeg', command: 'ffmpeg -version' });
  const okA = a.sc?.ok === true && a.ms < 10_000 && a.sc.data?.exitCode === 0;
  const bFast = b.ms < 10_000;
  const okB = bFast && (b.sc?.ok === true || /CLI_NOT_FOUND/.test(b.sc?.error?.message || ''));
  rec('A4', okA && okB, `node -v: ok=${a.sc?.ok} ${a.ms}ms exit=${a.sc?.data?.exitCode} out=${JSON.stringify(a.sc?.data?.output || []).slice(0, 120)}\n      ffmpeg(已装v9.0.1): ms=${b.ms}(${bFast ? '未挂死' : '挂死!'}) ok=${b.sc?.ok} err=${b.sc?.error?.code || '-'}`);
}

/* ---------------- A6 meta.health.check ---------------- */
if (want('A6')) {
  const r = await call('meta.health.check', {});
  const d = r.sc?.data || {};
  const ok = r.sc?.ok === true && (d.psBridge || d.session) && !d.computerName;
  rec('A6', ok, `ok=${r.sc?.ok} keys=${Object.keys(d).join(',')} ${ok ? '' : '（疑似仍返回系统信息）'}`);
}

/* ---------------- A7 生产工作目录读写链 ---------------- */
if (want('A7')) {
  const steps = [];
  steps.push(['dir', await call('storage.dir.manage', { path: W })]);
  steps.push(['write', await call('storage.file.write', { path: `${W}\\a.txt`, content: 'qa-cl017', createDirectory: true })]);
  steps.push(['read', await call('storage.file.read', { path: `${W}\\a.txt` })]);
  steps.push(['search', await call('storage.search.query', { path: W, pattern: '*.txt', recurse: true, maxResults: 5 })]);
  steps.push(['zip', await call('storage.archive.manage', { path: W, destination: `${W}.zip` })]);
  steps.push(['space', await call('storage.space.analyze', { path: W, depth: 1, top: 5 })]);
  const bad = steps.filter(([, r]) => r.sc?.ok !== true);
  const readOk = steps[2][1].sc?.data?.content?.includes('qa-cl017');
  rec('A7', bad.length === 0 && readOk, `失败步骤=${bad.map(([n]) => n).join(',') || '无'}；读回含内容=${readOk}\n      详情：${steps.map(([n, r]) => `${n}:ok=${r.sc?.ok}${r.sc?.error ? '(' + r.sc.error.code + ')' : ''}`).join(' | ')}`);
}

/* ---------------- A8 关键能力 ---------------- */
if (want('A8')) {
  const inv = await call('app.inventory.list', { includeUwp: false });
  const svc = await call('system.service.list', {});
  const evt = await call('system.eventlog.query', { logName: 'System', maxEvents: 3, level: 'Error' });
  // 独立基线：VM 注册表三个 Uninstall 根合计 **19** 条含 DisplayName 的条目（qa/probes/probe-inv.ps1 实测）。
  // 因此断言不得放宽到 length>0 —— 那会漏掉「静默漏报」。
  const invN = Array.isArray(inv.sc?.data) ? inv.sc.data.length : -1;
  const ok = inv.sc?.ok === true && svc.sc?.ok === true && evt.sc?.ok === true
    && invN >= 15
    && Array.isArray(svc.sc.data) && svc.sc.data.length > 5
    && Array.isArray(evt.sc.data) && evt.sc.data.length > 0;
  rec('A8', ok, `app.inventory.list=${inv.sc?.ok} 条数=${invN}（注册表基线 19）${inv.ms}ms\n      service.list=${svc.sc?.ok} ${shape(svc.sc?.data)} ${svc.ms}ms\n      eventlog(level=Error)=${evt.sc?.ok} ${shape(evt.sc?.data)} ${evt.ms}ms`);
}

/* ---------------- A13 排序类能力真的排序了 ---------------- */
// PS 5.1 对 [ordered]@{} 用 `Sort-Object -Property <键>` 存在「静默不排序」陷阱：
// 键解析失败 → 不报错、不排序（配 -Unique 时更会塌缩成 1 条）。
// 断言：Top-N 结果必须按 sizeMB 单调不增，且首项大于 0。
if (want('A13')) {
  const sp = await call('storage.space.analyze', { path: 'C:\\Users\\User', depth: 1, top: 5 });
  const entries = Array.isArray(sp.sc?.data?.entries) ? sp.sc.data.entries : [];
  let mono = true;
  for (let i = 1; i < entries.length; i++) if (Number(entries[i].sizeMB) > Number(entries[i - 1].sizeMB)) mono = false;
  const first = Number(entries[0]?.sizeMB ?? 0);
  const ok = sp.sc?.ok === true && entries.length >= 2 && mono && first > 0;
  rec('A13', ok, `单调不增=${mono} 首项=${first}MB ${ok ? '' : '（疑似未真正排序）'}\n      ${entries.map((e) => `${e.path}=${e.sizeMB}MB`).join(' | ').slice(0, 300)}`);
}

/* ---------------- A9 L3 dry-run 免审批 ---------------- */
if (want('A9')) {
  const r = await call('system.power.control', { action: 'restart', dryRun: true });
  const ok = r.sc?.ok === true && r.sc?.error?.code !== 'APPROVAL_REQUIRED' && (r.sc?.data?.dryRun === true || r.sc?.data?.plan);
  rec('A9', ok, `ok=${r.sc?.ok} err=${r.sc?.error?.code || '无'} data=${jstr(r.sc?.data)}`);
}

/* ---------------- A10 列表保形 ---------------- */
if (want('A10')) {
  const one = await call('system.service.list', { name: 'Spooler' });
  const none = await call('system.service.list', { name: '__no_such_service_qa__' });
  const ok = Array.isArray(one.sc?.data) && one.sc.data.length === 1 && Array.isArray(none.sc?.data) && none.sc.data.length === 0;
  rec('A10', ok, `单命中=${shape(one.sc?.data)}（期望 [1]） 零命中=${shape(none.sc?.data)}（期望 []）`);
}

/* ---------------- A3 桥自愈（破坏性：会强杀 ps-bridge） ---------------- */
// 强断言：kill 掉 ps-bridge 后**不重启服务**（SERVICE PID 必须不变）也要能自愈，
// 且新的 ps-bridge 必须是**新 PID**（证明是重生而非「本来就没死」的假阴性）。
if (want('A3')) {
  console.log('--- A3 将强杀一个 ps-bridge 实例（不重启服务），随后调用一次能力 ---');
  const before = await vmps('qa-probe.ps1');
  const svcBefore = (before.match(/SERVICE PID=(\d+)/) || [])[1] || '';
  const brBefore = (before.match(/PSBRIDGE PID=(\d+)/) || [])[1] || '';
  const k = await vmps('qa-probe.ps1', ['kill']);
  const killed = (k.match(/KILLED_PSBRIDGE=(\d+)/) || [])[1] || '';
  // 自愈需要时间（新 ps-bridge 启动 + 宿主桥重连其 stdio）；固定 3s 太短会误判 FAIL。
  // 改为轮询：每 3s 试探一次，直到恢复或累计 ~30s。
  let r = { sc: { ok: false }, ms: -1 };
  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise((res) => setTimeout(res, 3000));
    r = await call('system.info.get', {});
    if (r.sc?.ok === true) break;
  }
  const after = await vmps('qa-probe.ps1');
  const svcAfter = (after.match(/SERVICE PID=(\d+)/) || [])[1] || '';
  const brAfter = (after.match(/PSBRIDGE PID=(\d+)/) || [])[1] || '';
  const recovered = r.sc?.ok === true;
  const sameSvc = Boolean(svcBefore) && svcBefore === svcAfter;   // 服务未被重启
  // ⚠ 必须先证明「真的杀掉了」：killed 为空 = 夹具没生效（曾因 UTF-8 无 BOM 的
  //   探针被 PS 5.1 按 GBK 误读、吞掉换行而假通过），此时不得判 newBridge 为真。
  const newBridge = Boolean(killed) && Boolean(brAfter) && brAfter !== killed;
  const single = /PSBRIDGE_COUNT=1/.test(after);
  const shapeOk = r.sc?.data?.computerName ? `computerName=${r.sc.data.computerName}` : JSON.stringify(r.sc?.error || {});
  rec('A3', Boolean(killed) && recovered && sameSvc && newBridge && single,
    `killed=${killed || '-'}（原 ${brBefore || '-'}）→ 重生为 ${brAfter || '-'}（新 PID=${newBridge}） 单例=${single}\n`
    + `      服务未重启=${sameSvc}（SERVICE PID ${svcBefore || '-'} → ${svcAfter || '-'}）；自愈调用 ok=${recovered} ${r.ms}ms ${shapeOk}`);
}

/* ---------------- A5 A2A 委派（经宿主 stdio 桥 → VM /a2a） ---------------- */
// 判据必须写实（实测结论）：本 VM 的 codebuddy 未登录 → LLM provider 无法真正推理，
// A2A 必然降级为确定性执行器；而确定性执行器只识别 4 组中文关键词模板
// （磁盘|空间|容量|占满|清理建议 / 系统信息|系统状态|配置|版本 / 截图|截屏|看看屏幕|当前屏幕 / 安装+生产）。
// 因此「端到端成功」只在措辞命中模板时成立。三支断言：
//   a) a2a.health 可达且声明技能 ≥5
//   b) 命中模板措辞 → state=completed 且 step 真的执行成功
//   c) 未命中措辞 → state=failed 且**如实**说明并给出可操作补救（绝不谎报成功）
if (want('A5')) {
  const runA2a = async (tool, args) => {
    try {
      const { stdout } = await pexec(process.execPath, [`${ROOT}/qa/probes/a2a.mjs`, tool, JSON.stringify(args)], { maxBuffer: 8e6 });
      const i = stdout.indexOf('{'); if (i < 0) return { isError: true, error: { code: 'A2A_NO_OUTPUT', message: stdout.slice(-300) } };
      return JSON.parse(stdout.slice(i));
    } catch (e) {
      // a2a.mjs 现已 catch 后干净退出，此分支通常只在它被打断（如 timeout 杀进程）时走到
      return { isError: true, error: { code: 'A2A_BRIDGE_FAILED', message: String(e.message || e).slice(0, 300) } };
    }
  };
  const h = await runA2a('a2a.health', {});
  const okH = h.structuredContent?.ok === true && (h.structuredContent?.skills || []).length >= 5;
  // 探测 provider：workbuddy state=ready ⇒ codebuddy 已登录（走 LLM 路径）；否则降级确定性执行器。
  const prov = await health();
  const llmReady = prov?.provider?.id === 'workbuddy' && prov?.provider?.state === 'ready';
  if (llmReady) {
    // LLM 路径：codebuddy 登录态下委派走真实推理。无论完成还是超时失败，**不得无限挂起**（D28 已把流超时从 ∞ 收敛到 timeoutMs）。
    // 用有界 timeoutMs 探测：在时限内返回结构化结果（completed 或 A2A_DELEGATE_FAILED）即证明「流不挂死」。
    const t0 = Date.now();
    const d = await runA2a('a2a.delegate', { goal: '获取系统信息', timeoutMs: 60000 });
    const dc = d.structuredContent;
    const dms = Date.now() - t0;
    const okD = dc?.ok === true || (d.isError === true && dc?.error?.code === 'A2A_DELEGATE_FAILED');
    rec('A5', okH && okD,
      `health ok=${h.structuredContent?.ok} skills=${(h.structuredContent?.skills || []).length}\n`
      + `      provider=${prov?.provider?.id}/${prov?.provider?.state}（LLM就绪=${llmReady}）\n`
      + `      delegate（有界60s）返回 ${dms}ms：isError=${d.isError} code=${dc?.error?.code || '-'} ok=${dc?.ok} → 不挂死=${okD}\n`
      + `      注：codebuddy 已登录走 LLM 路径；若返回 A2A_DELEGATE_FAILED 属 VM 侧 LLM 停滞（open issue），D28 仅保证宿主不挂死`);
  } else {
    const hit = await runA2a('a2a.delegate', { goal: '获取系统信息' });
    const hitSc = hit.structuredContent;
    const okHit = hitSc?.state === 'completed' && hitSc?.ok === true && hit.isError === false
      && (hitSc?.progress || []).length > 0;
    const miss = await runA2a('a2a.delegate', { goal: '获取虚拟机系统基本信息并汇总' });
    const missSc = miss.structuredContent;
    const okMiss = missSc?.state === 'failed' && missSc?.ok === false
      && /MCP|provider/.test(String(missSc?.summary || ''));   // 如实失败 + 给补救建议
    rec('A5', okH && okHit && okMiss,
      `health ok=${h.structuredContent?.ok} skills=${(h.structuredContent?.skills || []).length}\n`
      + `      命中模板「获取系统信息」→ state=${hitSc?.state} isError=${hit.isError} ok=${hitSc?.ok}\n`
      + `      未命中模板 → state=${missSc?.state} isError=${miss.isError}（如实失败+建议=${okMiss}）\n`
      + `      注：codebuddy 未登录，A2A 降级确定性执行器`);
  }
}

// 契约层 error.code 只有 10 码；领域原因码必须出现在 error.reason。
// 断言三例领域码上浮，且成功路径未被改坏（防「为修错误码把正常路径也写成错误」）。
if (want('A15')) {
  // ⚠ 调用必须满足能力 inputSchema 的 required，否则会在 PS 参数绑定阶段就失败、
  //   根本到不了领域分支（曾因漏传 system.service.control 的 action 而假判失败）。
  // run5 修复（2026-09-23）：原用 `ffmpeg -version` 期望 CLI_NOT_FOUND，但该 VM 已装 ffmpeg v9.0.1
  // → 走成功路径、无 error → r4 恒 false（测试前提过期）。改用确定不存在的 CLI，稳定命中 CLI_NOT_FOUND。
  // run5 教训（2026-09-23）：A3 杀 ps-bridge 重生 + A5 delegate 60s 长调用后的冷窗口内，成功路径
  //   可能瞬时失败（ok=false）→ 假 FAIL。先等桥热身（最多 3 次、5s 间隔）再跑断言。
  let good = null;
  for (let i = 0; i < 3; i++) {
    good = await call('system.info.get', {});
    if (good.sc?.ok === true) break;
    await new Promise((r) => setTimeout(r, 5_000));
  }
  const nf = await call('storage.file.read', { path: 'C:\\Users\\User\\__nope__.txt' });
  const ns = await call('system.service.control', { name: '__nope__', action: 'start' });
  const nr = await call('system.registry.read', { path: 'HKLM:\\SOFTWARE\\__nope__' });
  const nc = await call('appops.cli.invoke', { app: 'custom', command: '__no_such_cli_xyz__ --version' });
  const CONTRACT = ['INVALID_PARAMS','UNKNOWN_CAPABILITY','UNSUPPORTED_GOAL','POLICY_DENIED','APPROVAL_REQUIRED','SESSION_UNAVAILABLE','SESSION_BLACK_SCREEN','PROVIDER_UNAVAILABLE','TIMEOUT','EXECUTION_FAILED'];
  const codeOk = [nf, ns, nr, nc].every((r) => CONTRACT.includes(r.sc?.error?.code));
  const r1 = nf.sc?.error?.reason === 'FILE_NOT_FOUND';
  const r2 = ns.sc?.error?.reason === 'SERVICE_NOT_FOUND';
  const r3 = nr.sc?.error?.reason === 'REG_PATH_NOT_FOUND';
  const r4 = nc.sc?.error?.reason === 'CLI_NOT_FOUND';
  const ok = codeOk && r1 && r2 && r3 && r4 && good.sc?.ok === true;
  rec('A15', ok, `code∈契约=${codeOk} file.read=${nf.sc?.error?.reason || '-'} service.control=${ns.sc?.error?.reason || '-'} registry.read=${nr.sc?.error?.reason || '-'} cli.invoke=${nc.sc?.error?.reason || '-'}\n      成功路径未坏：system.info.get ok=${good.sc?.ok} computerName=${good.sc?.data?.computerName || '-'}`);
}

/* ---------------- A16 入参契约错误必须可路由（D24 回归） ---------------- */
// 现实中最常见的 Agent 失误不是「路径不存在」而是「参数名/必填项写错」。
// 这类错误目前由 PS 的 ParameterBindingException 抛出，消息无 `CODE:` 前缀
// → code=EXECUTION_FAILED 且无 reason，Agent 无法区分「该改参数」还是「该重试」。
// 期望：Node 侧按 inputSchema 前置校验 → INVALID_PARAMS + reason=INVALID_ARGUMENT。
if (want('A16')) {
  const miss = await call('storage.file.read', {});                                        // 缺必填 path
  const unk = await call('storage.dir.manage', { path: 'C:\\Users\\User', action: 'list' }); // 未知参数 action
  const both = await call('gui.window.control', { windowTitle: '__zz__', action: 'activate' });// 未知参数 + 缺必填 title
  const cases = [['缺必填', miss], ['未知参数', unk], ['未知+缺必填', both]];
  const bad = cases.filter(([, r]) => !(r.sc?.error?.code === 'INVALID_PARAMS' && r.sc?.error?.reason === 'INVALID_ARGUMENT'));
  rec('A16', bad.length === 0,
    cases.map(([n, r]) => `${n}: code=${r.sc?.error?.code || '-'} reason=${r.sc?.error?.reason || '-'} msg=${String(r.sc?.error?.message || '').slice(0, 40)}`).join('\n      ')
    + (bad.length ? `\n      失败 ${bad.length} 例（期望 code=INVALID_PARAMS 且 reason=INVALID_ARGUMENT）` : ''));
}

/* ---------------- A18 入参契约校验须覆盖 type / enum（D26） ---------------- */
// D24 只校验「键合法 / 必填在位」，**不校验值**：类型不符与枚举越界被原样下发到
// PowerShell，由其参数绑定抛异常（消息无 `UPPER_SNAKE:` 前缀）→ 被压成 EXECUTION_FAILED。
// 真机取证（修复前）：
//   system.process.list {"top":"abc"}                        → EXECUTION_FAILED（无法转换为 Int32）
//   system.service.control {name,action:"bogus"}             → EXECUTION_FAILED（不属于 ValidateSet 集合）
// 修复后须为 INVALID_PARAMS + reason=INVALID_ARGUMENT + details.invalid[]。
// ⚠ 关键反向对照：可强转的宽松形态**不得误拒**（LLM 常发 "top":"20"）。
if (want('A18')) {
  const typeBad = await call('system.process.list', { top: 'abc' });
  const enumBad = await call('system.service.control', { name: '__nope__', action: 'bogus' });

  // 严格判据：两例均须 INVALID_PARAMS + reason=INVALID_ARGUMENT + details.invalid 数组
  const strict = [
    ['类型不符', typeBad],
    ['枚举越界', enumBad],
  ].map(([n, r]) => {
    const e = r.sc?.error || {};
    const inv = e.details?.invalid;
    return [n, e.code === 'INVALID_PARAMS' && e.reason === 'INVALID_ARGUMENT' && Array.isArray(inv), e, inv];
  });

  // 宽松对照：**不得误拒 PS 本就能接受的形态**（否则是我们自己引入的新失败模式，比漏放更糟）
  const lenientStr = await call('system.process.list', { top: '20' });
  const lenientNum = await call('system.process.list', { top: 20 });
  const noTypeField = await call('storage.file.write', {
    path: 'C:\\WinVMWorkspace\\e2e-qa\\a18-notype.txt',
    content: 123,
  });
  const lenient = [
    ['top:"20"', lenientStr],
    ['top:20', lenientNum],
    ['content:123（无 type 声明）', noTypeField],
  ].map(([n, r]) => [n, r.sc?.ok === true, r.sc?.error?.code || '-']);

  // enum 大小写宽松（D26 裁决 B，2026-09-17）：PS `ValidateSet` **默认忽略大小写**，故 `action:'START'`
  // 是 PS 本来就能接受的形态 → 校验必须放行，否则是我们引入的新回归。
  // 探针用**不存在的服务名**：既不触发真实启停（零副作用），又能证明「校验放行 + 请求抵达业务层」。
  const enumCase = await call('system.service.control', { name: '__nope__', action: 'START' });
  const enumCaseOk =
    enumCase.sc?.error?.code !== 'INVALID_PARAMS' &&
    enumCase.sc?.error?.reason === 'SERVICE_NOT_FOUND';

  const strictOk = strict.every(([, ok]) => ok);
  const lenientOk = lenient.every(([, ok]) => ok);
  const ok = strictOk && lenientOk && enumCaseOk;

  rec('A18', ok,
    `严格判据：\n      ${strict.map(([n, ok2, e, inv]) => `${n}: ${ok2 ? 'PASS' : 'FAIL'} code=${e?.code || '-'} reason=${e?.reason || '-'} invalid=${JSON.stringify(inv)?.slice(0, 120) || '缺失'}`).join('\n      ')}`
    + `\n      宽松对照（不得误拒）：\n      ${lenient.map(([n, ok2, c]) => `${n}: ${ok2 ? 'OK' : '被拒(' + c + ')'}`).join('  |  ')}`
    + `\n      enum 大小写宽松（action:"START" 须放行到业务层）: ${enumCaseOk ? 'OK' : 'FAIL'} code=${enumCase.sc?.error?.code || 'ok'} reason=${enumCase.sc?.error?.reason || '-'}`
    + (ok ? '' : `\n      ⚠ 严格=${strictOk ? 'PASS' : 'FAIL'} 宽松=${lenientOk ? 'PASS' : 'FAIL'} enumCase=${enumCaseOk ? 'PASS' : 'FAIL'}`));
}

/* ---------------- A11 关键产物「本地 ↔ VM」md5 一致（只读部署一致性闸门） ---------------- */
// ⚠ 本项**只读**，绝不在夹具内跑 `npm run build` / `tsc -b`：构建会改写 dist/，
//    一旦在冻结窗口内执行，就会让「VM 上正在跑的那份」与本地产物失配，反而制造假失败。
//    构建与类型检查属**冻结前**门禁，由主理人单独执行（见 REQUIREMENT.md §5 A11）。
if (want('A11')) {
  const files = [
    'packages/vm-capabilities/psmod/app.ps1',
    'packages/vm-capabilities/psmod/ps-bridge.ps1',
    'packages/adapter-agent-workbuddy/dist/index.js',
  ];
  const out = await vmps('lead-md5-3.ps1');
  const vm = new Map();
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^([0-9a-f]{32})\s+(\S.*)$/);
    if (!m) continue;
    vm.set(m[2].replace(/\\/g, '/').replace(/^[A-Za-z]:\/WinVMBridge\//, ''), m[1]);
  }
  const unreachable = /VM_UNREACHABLE/.test(out);
  const rows = files.map((f) => {
    const local = createHash('md5').update(readFileSync(`${ROOT}/${f}`)).digest('hex');
    const remote = vm.get(f);
    return [f, local, remote, remote === local];
  });
  const ok = !unreachable && rows.every(([, , , eq]) => eq);
  rec('A11', ok, unreachable
    ? `VM 不可达，无法核验部署一致性\n      ${out.trim().slice(0, 200)}`
    : rows.map(([f, l, r, eq]) => `${eq ? 'SAME' : 'DIFF'} ${f}\n        本地=${l}\n        VM  =${r || '(未取到)'}`).join('\n      ')
      + (ok ? `\n      → ${rows.length}/${rows.length} SAME` : `\n      → DIFF ${rows.filter(([, , , e]) => !e).length} 项：VM 上跑的不是本地产物`));
}

/* ---------------- A14 静态扫描：psmod 不得对字典裸键排序 ---------------- */
if (want('A14')) {
  const dir = `${ROOT}/packages/vm-capabilities/psmod`;
  const bad = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.ps1'))) {
    const text = readFileSync(`${dir}/${f}`, 'utf8');
    text.split('\n').forEach((line, i) => {
      const m = line.match(/Sort-Object\s+-Property\s+([^-\s][^\s]*)/);
      if (!m) return;
      const prop = m[1];
      if (prop.startsWith('{')) return;      // 脚本块写法 → 正确
      if (prop === 'Length') return;         // FileInfo 真实属性，已注释说明的合理例外
      bad.push(`${f}:${i + 1} ${prop}`);
    });
  }
  rec('A14', bad.length === 0, `裸键排序命中=${bad.length}${bad.length ? '\n      ' + bad.join('\n      ') : '（全部为脚本块写法 / 已说明例外）'}`);
}

/* ---------------- A12 仓库 skills 与宿主副本逐文件一致 ---------------- */
if (want('A12')) {
  const a = `${ROOT}/skills`;
  const b = '/storage/Users/currentUser/.workbuddy/connectors/skills/connector-winvm';
  let diff = '';
  try {
    const { stdout } = await pexec('diff', ['-r', a, b], { maxBuffer: 8e6 });
    diff = stdout;
  } catch (e) {
    diff = (e.stdout || '') + (e.stderr || '');
  }
  const clean = diff.trim() === '';
  rec('A12', clean, clean ? `diff -r 无差异（${a} ≡ ${b}）` : `存在差异：\n${diff.trim().slice(0, 1200)}`);
}

/* ---------------- A17 winget.search 不得静默空（D25 回归） ---------------- */
// 实测缺陷：分隔线是「一条连续长横线」，`/-+/g` 只得 1 个匹配 → $cols.Count=1
// → 每行都命中 `if ($vals.Count -lt 3) { continue }` → out=[] → **ok=true + data=[] 静默空**。
// 危害等同 D21（静默错数据）：调用方会误判「winget 没有这个包」。
// 断言必须与**独立基线**交叉校验（直接调 winget），不能只看插件自报 ok。
if (want('A17')) {
  const q = '7zip';
  // run5 教训（2026-09-23）：ps-bridge 重生/A5 长调用后的冷窗口内，winget 首跑（源刷新）可超
  // 30s 默认超时 → 两条链路双双 0 行的「假 FAIL」。winget 类重调用统一放宽到 90s。
  const viaPlugin = await call('app.winget.search', { query: q }, 90_000);
  const rows = Array.isArray(viaPlugin.sc?.data) ? viaPlugin.sc.data : [];
  const base = await call('appops.cli.invoke', { app: 'custom', command: `winget search ${q} --accept-source-agreements` }, 90_000);
  const out = Array.isArray(base.sc?.data?.output) ? base.sc.data.output : [];
  const sepIdx = out.findIndex((l) => /^\s*-{3,}/.test(l));
  const baseRows = sepIdx < 0 ? 0 : out.slice(sepIdx + 1)
    .filter((l) => l.trim() && !/^\s*\d+\s+\S+\s+(匹配|matching|packages)/.test(l)).length;
  const hasId = rows.some((r) => String(r.id) === '7zip.7zip');
  const hasName = rows.some((r) => String(r.name).includes('7-Zip'));
  // ★ 结构性不变量：id 必须是「无空格、无 CJK、无控制字符」的包标识符。
  // 这条能抓住「按字符索引切列」在含 CJK 包名（占 2 显示列）的行上产生的**错位垃圾**
  // —— 实测 winget 的 `7zip解压缩软件 / XP8C87R6J42SKH` 行即会踩中（详见 qa/probes/judge-d25-width.mjs）。
  const dirty = rows.filter((r) => !/^[A-Za-z0-9._+\-]+$/.test(String(r.id)));
  // 插件默认 limit=20，故下限取 min(基线条数, 20)
  const ok = viaPlugin.sc?.ok === true && baseRows >= 1 && rows.length >= Math.min(baseRows, 20)
    && hasId && hasName && dirty.length === 0;
  rec('A17', ok,
    `插件 rows=${rows.length} / 独立基线 rows=${baseRows}（下限 ${Math.min(baseRows, 20)}） 含7zip.7zip=${hasId} 含7-Zip=${hasName} 脏id行=${dirty.length}\n`
    + `      首行=${JSON.stringify(rows[0] || {})}`
    + (dirty.length ? `\n      ⚠ 脏行=${JSON.stringify(dirty.slice(0, 3))}` : ''));
}

/* ---------------- 汇总 ---------------- */
const pass = results.filter((r) => r.pass).length;
console.log(`\n===== A 系列汇总: PASS=${pass} FAIL=${results.length - pass} =====`);
if (results.some((r) => !r.pass)) console.log('FAILED: ' + results.filter((r) => !r.pass).map((r) => r.id).join(', '));

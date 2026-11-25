#!/usr/bin/env node
/**
 * 阶段 5 / Step 5.1 验收脚本 —— 「通道层抽出」的可机械化判据集
 *
 * 设计原则（沿用 qa/accept-step44.mjs）：
 *   - **剥注释再判**：`capability` / `policy` 这类词在解释性注释里必然出现，
 *     不剥注释的 grep 一定会误判（这既是假绿来源也是假红来源）。
 *   - **判据锚定行为**：不查"某个词出现过几次"，查"某种形状是否存在于代码路径上"。
 *   - **每条判据可被一个突变打红**：判据写完必须逐条做突变反证，
 *     否则"门禁绿"不构成证据（项目红线 8）。
 *
 * 跑法：node qa/accept-step51.mjs [--json]
 * 退出码：0 = 全过；1 = 有判据红。
 */

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (rel) => readFileSync(new URL(`../${rel.replace(/^\.\//, '')}`, import.meta.url), 'utf8');
const lines = (rel) => read(rel).split('\n');

/**
 * 轻量注释剥离状态机（处理字符串字面量内的 `//`，避免把 URL 当注释起点）。
 * 只剥 `//` 行注释与 `/* *\/` 块注释，不处理模板字符串嵌套（本仓 delivery/*.mjs 未用到）。
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  let state = 'code'; // code | line | block | single | double | template
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (state === 'code') {
      if (c === '/' && n === '/') { state = 'line'; i += 2; continue; }
      if (c === '/' && n === '*') { state = 'block'; i += 2; continue; }
      if (c === "'") { state = 'single'; out += c; i++; continue; }
      if (c === '"') { state = 'double'; out += c; i++; continue; }
      if (c === '`') { state = 'template'; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c; }
      i++; continue;
    }
    if (state === 'block') {
      if (c === '*' && n === '/') { state = 'code'; i += 2; continue; }
      if (c === '\n') out += '\n'; // 保留行号
      i++; continue;
    }
    // 字符串态：原样拷贝，遇转义跳过下一个字符
    if (c === '\\') { out += c + (n ?? ''); i += 2; continue; }
    const close = { single: "'", double: '"', template: '`' }[state];
    if (c === close) state = 'code';
    out += c; i++; continue;
  }
  return out;
}

const results = [];
function check(name, fn) {
  try {
    const r = fn();
    results.push({ name, ok: r === true || r === undefined, detail: typeof r === 'string' ? r : '' });
  } catch (e) {
    results.push({ name, ok: false, detail: e.message });
  }
}

const CC = 'delivery/connect-channel.mjs';
const IH = 'delivery/install-host.mjs';
const WP = 'delivery/winvm-plugin.mjs';
const SU = 'delivery/setup.mjs';
const PR = 'delivery/pack-release.mjs';

/* ---------- ① 新脚本存在且可独立执行 ---------- */
check('① connect-channel.mjs 存在', () => existsSync(`${ROOT}/${CC}`) || (() => { throw new Error('文件不存在'); })());

check('① connect-channel.mjs 语法可解析（node --check）', () => {
  execFileSync(process.execPath, ['--check', `${ROOT}/${CC}`], { stdio: 'pipe' });
});

/* ---------- ② 层间隔离三禁令（核心判据） ----------
 * 这三条是「通道层不许越界」的机械表达。注意必须剥注释：注释里会大量提到
 * capability/policy 这些词（本文件自己的头注就写着"不出现 capability/policy"）。
 */
const ccCode = stripComments(read(CC));

check('② 通道层不建连接（无 new Client / .connect(）', () => {
  const hits = [...ccCode.matchAll(/new\s+Client\s*\(|\.connect\s*\(/g)].map((m) => m[0]);
  // net.connect 是"探活"不是"建隧道"：本模块只需要 TCP 握手证明端口开着，
  // 不承载任何 ssh 会话。故允许 net.connect，但禁止 ssh2 的 Client 构造与 .connect 调用。
  const bad = hits.filter((h) => !/net\.connect/.test(h));
  // net.connect 以 `net.connect(` 形式出现，会被上面正则抓到；逐个排除。
  const realBad = [];
  for (const m of ccCode.matchAll(/new\s+Client\s*\(/g)) realBad.push(m[0]);
  for (const m of ccCode.matchAll(/(?<!net)\.connect\s*\(/g)) realBad.push(m[0]);
  if (realBad.length) throw new Error(`发现建连调用：${JSON.stringify(realBad)}（建连属 tunnel-daemon）`);
  void bad;
});

check('② 通道层不知道能力/策略/审批（剥注释后零命中）', () => {
  const bad = ccCode.match(/capability|policy|approval|审批|策略|能力/gi) || [];
  if (bad.length) throw new Error(`剥注释后仍有 ${bad.length} 处：${[...new Set(bad)].join(',')}`);
});

check('② 通道层不装插件（不碰 installed_plugins / mcp.json / skills）', () => {
  const bad = [];
  if (/installed_plugins/.test(ccCode)) bad.push('installed_plugins');
  if (/mcp\.json/.test(ccCode)) bad.push('mcp.json');
  if (/\bskills\b/i.test(ccCode)) bad.push('skills');
  if (bad.length) throw new Error(`通道层越界触达部署面：${bad.join(',')}`);
});

/* ---------- ③ 三副本收敛：私钥探测只有一处定义 ---------- */
check('③ probeDefaultSshKey 定义唯一（connect-channel 内 1 处）', () => {
  const defs = [];
  for (const f of [CC, IH, WP, SU]) {
    const src = stripComments(read(f));
    const m = src.match(/function\s+probeDefaultSshKey\s*\(/g);
    if (m) defs.push(`${f}×${m.length}`);
  }
  if (defs.length !== 1 || !defs[0].startsWith(CC)) throw new Error(`定义点应为 ${CC} 单处，实测 ${JSON.stringify(defs)}`);
});

check('③ resolveTunnelIdentityFile 定义唯一（connect-channel 内 1 处）', () => {
  const defs = [];
  for (const f of [CC, IH, WP, SU]) {
    const src = stripComments(read(f));
    const m = src.match(/function\s+resolveTunnelIdentityFile\s*\(/g);
    if (m) defs.push(`${f}×${m.length}`);
  }
  if (defs.length !== 1 || !defs[0].startsWith(CC)) throw new Error(`定义点应为 ${CC} 单处，实测 ${JSON.stringify(defs)}`);
});

check('③ install-host / winvm-plugin / setup 均改为 import（不再是本地实现）', () => {
  for (const f of [IH, WP, SU]) {
    const src = stripComments(read(f));
    if (!/from\s+['"]\.\/connect-channel\.mjs['"]/.test(src) && !/from\s+['"]\.\/connect-channel\.mjs['"]/.test(read(f))) {
      throw new Error(`${f} 未 import connect-channel.mjs`);
    }
  }
});

/* ---------- ④ vm-conn 单写者：定义唯一，调用点保留 ----------
 * 这是本步**偏离计划书原文**的地方，判据必须精确表达修正后的语义：
 *   - 定义只有一处（connect-channel）；
 *   - install-host 仍**保留调用**（冷装通路需要），且是再导出而非本地实现。
 */
check('④ writeVmConnConfig 定义唯一（connect-channel 内）', () => {
  const defs = [];
  for (const f of [CC, IH, WP, SU]) {
    const src = stripComments(read(f));
    const m = src.match(/function\s+writeVmConnConfig\s*\(/g);
    if (m) defs.push(`${f}×${m.length}`);
  }
  if (defs.length !== 1 || !defs[0].startsWith(CC)) throw new Error(`实测 ${JSON.stringify(defs)}`);
});

check('④ install-host 保留调用点（冷装通路：--no-tunnel 仍需落盘）', () => {
  const src = stripComments(read(IH));
  if (!/writeVmConnConfig\s*\(/.test(src)) throw new Error('调用点不得删除（否则 --no-tunnel 冷装拿不到连接信息）');
  // 且必须是"调用"，不是"定义"——定义已在上一条判为唯一
});

check('④ install-host 的再导出是纯转发（不是第二实现）', () => {
  const src = read(IH);
  const m = src.match(/export\s*\{[^}]*writeVmConnConfig[^}]*\}\s*from\s*['"]\.\/connect-channel\.mjs['"]/);
  if (!m) throw new Error('应为 `export { ... } from "./connect-channel.mjs"` 形式的纯转发');
});

/* ---------- ⑤ ssh2 分发实现唯一 ---------- */
check('⑤ copySsh2Runtime 定义唯一（connect-channel 内）', () => {
  const defs = [];
  for (const f of [CC, IH]) {
    const src = stripComments(read(f));
    const m = src.match(/function\s+copySsh2Runtime\s*\(/g);
    if (m) defs.push(`${f}×${m.length}`);
  }
  if (defs.length !== 1 || !defs[0].startsWith(CC)) throw new Error(`实测 ${JSON.stringify(defs)}`);
});

/* ---------- ⑥ 投放闭包：connect-channel 必须在册（否则包内 import 炸） ---------- */
check('⑥ install-host 三处清单均含 connect-channel.mjs', () => {
  const src = read(IH);
  const ledger = [];
  for (const m of src.matchAll(/for \(const rel of \[([^\]]+)\]\)/g)) ledger.push(...[...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
  for (const m of src.matchAll(/extraFiles: \[([^\]]+)\]/g)) ledger.push(...[...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
  const n = ledger.filter((x) => x === 'connect-channel.mjs').length;
  if (n < 3) throw new Error(`应 ≥3（integrity + 两处 extraFiles），实测 ${n}`);
});

check('⑥ pack-release HOST_DELIVERY / VM_DELIVERY / PACKAGE_REQUIRED 均含 connect-channel', () => {
  const src = read(PR);
  const host = src.slice(src.indexOf('const HOST_DELIVERY'), src.indexOf('const VM_DELIVERY'));
  const vm = src.slice(src.indexOf('const VM_DELIVERY'), src.indexOf('const OVERALL_EXTRA_DELIVERY'));
  const req = src.slice(src.indexOf('const PACKAGE_REQUIRED'));
  const tag = "'delivery/connect-channel.mjs'";
  const hits = [
    ['HOST_DELIVERY', host.includes(tag)],
    ['VM_DELIVERY', vm.includes(tag)],
    ['PACKAGE_REQUIRED', (req.match(/delivery\/connect-channel\.mjs/g) || []).length >= 3],
  ];
  const bad = hits.filter(([, ok]) => !ok).map(([k]) => k);
  if (bad.length) throw new Error(`缺登记：${bad.join(',')}`);
});

/* ---------- ⑦ 三段取证：不是"端口通则通过" ---------- */
check('⑦ 取证含三段（pidfile / state 属主 / 裸 TCP）', () => {
  const src = stripComments(read(CC));
  for (const k of ['pidfile', 'state', 'tcp']) {
    if (!new RegExp(k, 'i').test(src)) throw new Error(`缺第 ${k} 段`);
  }
  if (!/ownerMatch/.test(src)) throw new Error('缺少 state 属主与 pidfile 的一致性校验（陈旧 state 会被当绿）');
});

check('⑦ install-host 改用 ensureChannel（不再只看退出码就宣称已拉起）', () => {
  const src = stripComments(read(IH));
  if (!/ensureChannel\s*\(/.test(src)) throw new Error('install-host 未走 ensureChannel');
  // 反向判据：不得再有"直接 spawn `tunnel ensure` 然后凭退出码宣称已拉起"的旧形态。
  // ⚠ 锚定的是**调用形状**（spawnSync + 'tunnel' + 'ensure' 三个要素同现），不是变量名 ——
  // 变量名可随意改（wvPlugin/r0/x 都行），锚变量名等于让突变轻易绕过。
  const legacyShape = /spawnSync\s*\([^;]{0,200}?['"]tunnel['"][^;]{0,80}?['"]ensure['"]/s.test(src);
  if (legacyShape) throw new Error('仍残留旧形态：spawnSync(..., "tunnel", "ensure") —— 应改经 ensureChannel 做三段取证');
});

/* ---------- ⑧ --no-tunnel 冷装语义显式化 ---------- */
check('⑧ install-host 对 --no-tunnel 有显式说明（不静默跳过）', () => {
  const src = read(IH);
  if (!/--no-tunnel 跳过/.test(src)) throw new Error('缺少 --no-tunnel 的显式说明');
});

/* ---------- ⑨ CLI 可用性（真跑，不靠读源码猜） ---------- */
check('⑨ --help 退出码 0 且打印用法', () => {
  const out = execFileSync(process.execPath, [`${ROOT}/${CC}`, '--help'], { encoding: 'utf8' });
  if (!/用法/.test(out)) throw new Error('--help 未打印用法');
});

check('⑨ persist --dry-run 不写盘、退出码 0', () => {
  const home = execFileSync(process.execPath, ['-e', 'process.stdout.write(require("os").tmpdir()+"/winvm-acc51-"+Date.now())'], { encoding: 'utf8' });
  const out = execFileSync(process.execPath, [
    `${ROOT}/${CC}`, 'persist', '--vm-host', '1.2.3.4', '--vm-user', 'test', '--home', home, '--dry-run',
  ], { encoding: 'utf8' });
  if (!/\[dry-run\]/.test(out)) throw new Error('dry-run 未打印计划');
  if (existsSync(`${home}/.workbuddy/winvm/vm-conn.json`)) throw new Error('dry-run 竟然写盘了');
});

check('⑨ 未知参数退出码非 0（不静默接受）', () => {
  let code = 0;
  try {
    execFileSync(process.execPath, [`${ROOT}/${CC}`, '--bogus-flag'], { stdio: 'pipe' });
  } catch (e) { code = e.status ?? 1; }
  if (code === 0) throw new Error('未知参数应判错');
});

/* ---------- ⑩ 现有单测不回归 ---------- */
check('⑩ deploy-conn-side 单测通过（再导出契约仍成立）', () => {
  execFileSync(process.execPath, ['--test', `${ROOT}/tests/unit/deploy-conn-side.test.js`], { stdio: 'pipe' });
});

check('⑩ ssh2-client 单测通过（分发闭包对账）', () => {
  execFileSync(process.execPath, ['--test', `${ROOT}/tests/unit/ssh2-client.test.js`], { stdio: 'pipe' });
});

/* ---------- 汇总 ---------- */
const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? `  —— ${r.detail}` : ''}`);
}
console.log(`\nSUMMARY checks=${results.length} fails=${failed.length} VERDICT=${failed.length ? 'RED' : 'GREEN'}`);
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ checks: results.length, fails: failed.length, failed: failed.map((f) => f.name) }, null, 2));
}
process.exit(failed.length ? 1 : 0);
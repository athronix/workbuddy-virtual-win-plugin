#!/usr/bin/env node
/**
 * verify-release.mjs — WinVM Bridge 发布包完整性校验（G-2 收编：MANIFEST 的消费端）
 *
 * 口径与 qa/deploy-probes/verify-manifest.py 逐字一致（后者保留为无 Node 环境的兜底）：
 *   1) 逐文件 sha256 全对
 *   2) files: / bytes: 计数一致
 *   3) total-sha256 = sha256(rows.join('\n'))，行格式 `"<relpath>  <sha256>"`（双空格、
 *      按路径排序、不含 MANIFEST 自身）——与 pack-release.mjs writeManifest 同式
 *   4) 无多余/缺失文件（MANIFEST.txt 自身除外）
 * 另加 V5 硬断言（G-1 防回归，overall 包专属）：包内 delivery/install-host.mjs 必须含
 *   NON_ACCOUNT_DIRS（P2-3/856a0f4 修复的包内存在性），缺失 = 旧包事故复发，直接 FAIL。
 *
 * 用法: node delivery/verify-release.mjs <pkg-dir> [--expect-nonaccount-guard]
 *   <pkg-dir>  = 包根（含 MANIFEST.txt），如 overall-root/overall
 *   退出码: 0 PASS / 1 FAIL / 2 用法或 MANIFEST 缺失
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const [, , pkgArg, ...flags] = process.argv;
if (!pkgArg) {
  console.log('usage: node delivery/verify-release.mjs <pkg-dir> [--expect-nonaccount-guard]');
  process.exit(2);
}
const root = resolve(pkgArg);
const manPath = join(root, 'MANIFEST.txt');
if (!existsSync(manPath)) {
  console.error(`FAIL: MANIFEST.txt not found in ${root}`);
  process.exit(2);
}
const expectGuard = flags.includes('--expect-nonaccount-guard');

const sha256File = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

function walkFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}
const relOf = (p) => relative(root, p).split(sep).join('/');

// ---- parse MANIFEST ----
const text = readFileSync(manPath, 'utf8');
const lines = text.split('\n');
let declaredFiles = null;
let declaredBytes = null;
let declaredTotal = null;
const rows = [];
let inRows = false;
for (const raw of lines) {
  const line = raw.replace(/\r$/, '');
  if (line.startsWith('# ---- per-file')) { inRows = true; continue; }
  if (line.startsWith('files: ')) declaredFiles = Number.parseInt(line.slice(7), 10);
  else if (line.startsWith('bytes: ')) declaredBytes = Number.parseInt(line.slice(7), 10);
  else if (line.startsWith('total-sha256: ')) declaredTotal = line.slice(14).trim();
  else if (inRows && line.trim()) {
    const i = line.lastIndexOf('  ');
    if (i < 0) { console.error(`FAIL: unparseable manifest row: ${line.slice(0, 80)}`); process.exit(1); }
    rows.push([line.slice(0, i), line.slice(i + 2)]);
  }
}

// ---- 1) total-sha256 复算 ----
const recomputed = createHash('sha256').update(rows.map(([r, s]) => `${r}  ${s}`).join('\n')).digest('hex');
const okTotal = recomputed === declaredTotal;

// ---- 2) 逐文件校验 + 字节合计 ----
const bad = [];
let totalBytes = 0;
for (const [rel, sha] of rows) {
  const p = join(root, rel);
  if (!existsSync(p) || !statSync(p).isFile()) { bad.push([rel, 'MISSING', sha]); continue; }
  const actual = sha256File(p);
  totalBytes += statSync(p).size;
  if (actual !== sha) bad.push([rel, actual.slice(0, 12), sha.slice(0, 12)]);
}

// ---- 3) 多余文件 ----
const onDisk = new Set(walkFiles(root).map(relOf).filter((r) => r !== 'MANIFEST.txt'));
const declared = new Set(rows.map(([r]) => r));
// 安装体系在已部署包根自写的运行期产物不算"多余"（同 verify-manifest.py，10-29 三轮回环实测）：
// .env=Step 3.1 用户配置、winvm-plugin(.cmd)=install-host 管理 CLI 启动器——纯净回环解包面无此二者，白名单不削弱检出力。
const RUNTIME_OK = new Set(['.env', 'delivery/winvm-plugin', 'delivery/winvm-plugin.cmd']);
const extra = [...onDisk].filter((r) => !declared.has(r) && !RUNTIME_OK.has(r)).sort();

// ---- 4) V5 NON_ACCOUNT_DIRS 硬断言（overall 包，G-1 防回归）----
let guardCheck = { ran: false, ok: true, detail: 'skipped' };
const ihPath = join(root, 'delivery', 'install-host.mjs');
if (expectGuard || existsSync(ihPath)) {
  if (existsSync(ihPath)) {
    const src = readFileSync(ihPath, 'utf8');
    const n = (src.match(/NON_ACCOUNT_DIRS/g) || []).length;
    guardCheck = { ran: true, ok: n >= 3, detail: `NON_ACCOUNT_DIRS x${n}（P2-3 修复存在性，阈 3）` };
  } else if (expectGuard) {
    guardCheck = { ran: true, ok: false, detail: '包内缺 delivery/install-host.mjs' };
  }
}

// ---- report ----
console.log(`pkg            : ${root}`);
console.log(`files declared : ${declaredFiles}  (rows=${rows.length}, on-disk=${onDisk.size})`);
console.log(`bytes declared : ${declaredBytes}  (actual=${totalBytes})`);
console.log(`total-sha256   : ${declaredTotal}`);
console.log(`recomputed     : ${recomputed}  -> ${okTotal ? 'MATCH' : 'MISMATCH'}`);

let fail = false;
if (!okTotal) { console.log('FAIL: total-sha256 mismatch'); fail = true; }
if (declaredFiles !== null && declaredFiles !== rows.length) { console.log(`FAIL: files count ${declaredFiles} != rows ${rows.length}`); fail = true; }
if (declaredBytes !== null && declaredBytes !== totalBytes) { console.log(`FAIL: bytes ${declaredBytes} != actual ${totalBytes}`); fail = true; }
if (bad.length) {
  console.log(`FAIL: ${bad.length} file(s) mismatch`);
  for (const [rel, got, want] of bad.slice(0, 20)) console.log(`  - ${rel}  got=${got} want=${want}`);
  fail = true;
}
if (extra.length) {
  console.log(`FAIL: ${extra.length} undeclared file(s)`);
  for (const rel of extra.slice(0, 20)) console.log(`  + ${rel}`);
  fail = true;
}
if (guardCheck.ran && !guardCheck.ok) { console.log(`FAIL: V5 ${guardCheck.detail}`); fail = true; }
console.log(`V5 nonaccount-guard: ${guardCheck.ran ? (guardCheck.ok ? 'PASS' : 'FAIL') : 'SKIP'}  (${guardCheck.detail})`);
console.log('RESULT:', fail ? 'FAIL' : 'PASS');
process.exit(fail ? 1 : 0);

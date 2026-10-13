/**
 * Phase 3 批2 · R-4 psmod 版本指纹（单测）
 *
 * 覆盖：
 *  - delivery/tools/psmod-drift.mjs 纯函数（hashPsmodDir / extractFingerprint / reconcile 判读矩阵）；
 *  - ps-bridge.ps1 静态守卫（启动期指纹块存在、ping 带 fingerprint、__meta fingerprint 分支、failedLoads 点名）；
 *  - ps-bridge.ts 静态守卫（health() 透传 fingerprint、spawnAndReady 清旧值 —— 防跨进程谎报）。
 *
 * 运行（只跑本文件，绝不整批）：
 *   node --test tests/unit/phase3-b2-psmod-drift.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import {
  hashPsmodDir,
  extractFingerprint,
  reconcile,
} from '../../delivery/tools/psmod-drift.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
const PS1 = (n) => readFileSync(join(ROOT, 'packages', 'vm-capabilities', 'psmod', n), 'utf8');
const PTS = readFileSync(join(ROOT, 'packages', 'vm-capabilities', 'src', 'ps-bridge.ts'), 'utf8');

/* ======================= hashPsmodDir ======================= */

test('hashPsmodDir：与 createHash 逐文件一致；空目录返回空对象', () => {
  const dir = mkdtempSync(join(tmpdir(), 'b2-drift-'));
  try {
    const a = join(dir, 'a.ps1');
    writeFileSync(a, 'Write-Output 1');
    const expect = createHash('sha256').update('Write-Output 1').digest('hex');
    assert.deepEqual(hashPsmodDir(dir), { 'a.ps1': expect });
    assert.deepEqual(hashPsmodDir(join(dir, 'nope')), {}, '不存在目录=空对象');
    writeFileSync(join(dir, 'note.txt'), 'x');
    assert.deepEqual(Object.keys(hashPsmodDir(dir)), ['a.ps1'], '只收 .ps1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hashPsmodDir：源仓真实 psmod 六文件全覆盖（含 ps-bridge.ps1 自身）', () => {
  const dir = join(ROOT, 'packages', 'vm-capabilities', 'psmod');
  const h = hashPsmodDir(dir);
  const names = Object.keys(h).sort();
  assert.deepEqual(names, ['app.ps1', 'appops.ps1', 'gui.ps1', 'ps-bridge.ps1', 'storage.ps1', 'system.ps1']);
  for (const v of Object.values(h)) assert.match(v, /^[0-9a-f]{64}$/);
});

/* ======================= extractFingerprint ======================= */

test('extractFingerprint：形状容错（缺席/坏形状→null；合法→原样）', () => {
  assert.equal(extractFingerprint({}), null);
  assert.equal(extractFingerprint({ psBridge: {} }), null);
  assert.equal(extractFingerprint({ psBridge: { fingerprint: { files: 'str' } } }), null);
  const good = { files: { 'a.ps1': 'f'.repeat(64) }, capturedAt: '2026-10-13T00:00:00Z' };
  assert.deepEqual(extractFingerprint({ psBridge: { fingerprint: good } }), good);
});

/* ======================= reconcile 判读矩阵 ======================= */

const R = { 'a.ps1': 'a'.repeat(64), 'b.ps1': 'b'.repeat(64) };

test('reconcile：①=② ⇒ PASS（零 fail）', () => {
  const res = reconcile({ repo: R, proc: { ...R } });
  assert.equal(res.verdict, 'PASS');
  assert.equal(res.fail, false);
  assert.deepEqual(res.driftFiles, []);
});

test('reconcile：②≠① 且无磁盘面 ⇒ DRIFT（提示三方对账配方）', () => {
  const res = reconcile({ repo: R, proc: { 'a.ps1': 'x'.repeat(64), 'b.ps1': R['b.ps1'] } });
  assert.equal(res.verdict, 'DRIFT');
  assert.equal(res.fail, true);
  assert.deepEqual(res.driftFiles, ['a.ps1']);
  assert.ok(res.lines.join('\n').includes('--vm-disk'), '应指路三方对账');
});

test('reconcile：①=③ 且 ②≠① ⇒ FAIL-DRIFT"漂移未生效"+kill-restart 配方（R-4 核心场景）', () => {
  const res = reconcile({ repo: R, proc: { 'a.ps1': 'x'.repeat(64), 'b.ps1': R['b.ps1'] }, disk: { ...R } });
  assert.equal(res.verdict, 'DRIFT');
  assert.equal(res.fail, true);
  const text = res.lines.join('\n');
  assert.ok(text.includes('漂移未生效'), text);
  assert.ok(text.includes('kill-restart'), text);
});

test('reconcile：③≠① ⇒ STALE（分发落后，指 deploy-vm --apply）', () => {
  const res = reconcile({
    repo: R,
    proc: { 'a.ps1': 'x'.repeat(64), 'b.ps1': R['b.ps1'] },
    disk: { 'a.ps1': 'y'.repeat(64), 'b.ps1': R['b.ps1'] },
  });
  assert.equal(res.verdict, 'STALE');
  assert.equal(res.fail, true);
  assert.ok(res.lines.join('\n').includes('deploy-vm'));
});

test('reconcile：进程指纹缺席 ⇒ NO_FINGERPRINT（loud fail，绝不静默 PASS）', () => {
  const res = reconcile({ repo: R, proc: null });
  assert.equal(res.verdict, 'NO_FINGERPRINT');
  assert.equal(res.fail, true);
  assert.ok(res.lines.join('\n').includes('无从证明'));
});

test('reconcile：NO_FINGERPRINT + 磁盘面 ⇒ 旁证分发是否到位', () => {
  const res = reconcile({ repo: R, proc: null, disk: { ...R } });
  assert.equal(res.verdict, 'NO_FINGERPRINT');
  assert.ok(res.lines.join('\n').includes('磁盘=源仓'));
});

test('reconcile：源仓空目录 ⇒ MIXED fail（仓库损坏不可误报 PASS）', () => {
  const res = reconcile({ repo: {}, proc: { ...R } });
  assert.equal(res.verdict, 'MIXED');
  assert.equal(res.fail, true);
});

/* ======================= ps-bridge.ps1 静态守卫 ======================= */

test('ps-bridge.ps1：启动期指纹块（Get-FileHash SHA256 → ToLower，与宿主 Node 同值域）', () => {
  const t = PS1('ps-bridge.ps1');
  assert.ok(/Get-FileHash -LiteralPath .+-Algorithm SHA256\)\.Hash\.ToLower\(\)/.test(t),
    '主循环前须有启动期 SHA256 快照（小写 hex 对齐 Node createHash）');
  assert.ok(t.includes('$script:PsmodFiles'), '指纹须存脚本作用域变量（进程期恒定=漂移判据本体）');
});

test('ps-bridge.ps1：ping 带 fingerprint + __meta fingerprint 分支 + failedLoads 点名（D-3 缺口）', () => {
  const t = PS1('ps-bridge.ps1');
  assert.match(t, /fingerprint\s*=\s*\(Get-PsmodFingerprint\)/, 'ping 应答须带指纹（/health 高频面零额外往返）');
  assert.ok(t.includes("'fingerprint' {"), '__meta 须有显式 fingerprint 函数分支');
  assert.ok(t.includes('failedLoads'), 'fingerprint 分支须点名启动期加载失败模块');
});

/* ======================= ps-bridge.ts 静态守卫 ======================= */

test('ps-bridge.ts：dispatch 途经捕获指纹；spawnAndReady 清旧值（不跨进程谎报）；health 透传', () => {
  assert.ok(PTS.includes('lastFingerprint'), '桥须持有指纹字段');
  assert.match(PTS, /this\.lastFingerprint = undefined;[\s\S]{0,400}?spawn\(/,
    'spawnAndReady 须先清旧实例指纹（新进程握手 ping 再捕获）');
  assert.match(PTS, /\.\.\.\(this\.lastFingerprint \? \{ fingerprint: this\.lastFingerprint \} : \{\}\)/,
    'health() 纯附加透传（缺席即旧形状）');
  assert.ok(/\['module'\]\s*===\s*'__meta'/.test(PTS), 'dispatch 仅认 __meta 应答指纹（防误捕普通能力载荷）');
});

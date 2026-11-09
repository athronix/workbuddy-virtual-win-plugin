#!/usr/bin/env node
/**
 * p8 · probe-fresh.sh 探针新鲜复用判定单测（v1.3.0 时间预算战役，run22 账本驱动）
 *
 * 被测=deploy/skills/winvm-plugin-deploy/scripts/probe-fresh.sh（纯判定，零网络）。
 * 防假绿三防线逐条钉死：①时效窗 ②同包根 ③强制冷跑；另钉保守面（无 stamp/损坏/未来时钟=不复用）。
 * 背景：deploy C5 与 verify 探针段跑同 3 个 python 探针（a2a+example 冷跑 ~240s）；
 * 复用判定错向「复用」=假绿风险，错向「冷跑」=只是慢——单测必须钉死边界。
 *
 * 运行（只跑本文件）：node --test tests/unit/p8-probe-fresh.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASH = '/data/storage/el1/bundle/libs/arm64/bash/bin/bash';
const PF = 'deploy/skills/winvm-plugin-deploy/scripts/probe-fresh.sh';

/** 跑一次判定，返回 {reuse, reason}。env=注入变量组。 */
function run(env, now) {
  const r = spawnSync(BASH, [PF], {
    encoding: 'utf8',
    env: { ...process.env, ...env, ...(now !== undefined ? { PROBE_FRESH_NOW: String(now) } : {}) },
  });
  assert.equal(r.status, 0, 'probe-fresh 恒 exit 0（判定非错误源）');
  const out = r.stdout;
  const m = out.match(/REUSE=([01])/);
  assert.ok(m, 'stdout 必含 REUSE= 行：' + out);
  const rm = out.match(/REASON=(.+)/);
  return { reuse: m[1] === '1', reason: rm ? rm[1].trim() : '' };
}

function stampFile(content) {
  const dir = mkdtempSync(join(tmpdir(), 'p8-pf-'));
  const p = join(dir, 'stamp.txt');
  writeFileSync(p, content);
  return { dir, p };
}

const NOW = 1000000;

test('防线①内+②内：新鲜窗内同包根 ⇒ REUSE=1', () => {
  const { dir, p } = stampFile(`epoch=${NOW - 100}\npkg=/pkg/A\nrun=\n`);
  const r = run({ VMDEPLOY_PROBE_STAMP: p, PROBE_PKG: '/pkg/A' }, NOW);
  assert.equal(r.reuse, true, r.reason);
  rmSync(dir, { recursive: true, force: true });
});

test('防线①：age == budget 边界 ⇒ 不复用（>= 判）', () => {
  const { dir, p } = stampFile(`epoch=${NOW - 600}\npkg=/pkg/A\n`);
  const r = run({ VMDEPLOY_PROBE_STAMP: p, PROBE_PKG: '/pkg/A' }, NOW);
  assert.equal(r.reuse, false, '临界必须判死（与 I-6.9 阈值临界教训同械：窗语义含等号侧保守）');
  rmSync(dir, { recursive: true, force: true });
});

test('防线①：超窗 ⇒ REUSE=0（reason 点名 age/budget）', () => {
  const { dir, p } = stampFile(`epoch=${NOW - 1100}\npkg=/pkg/A\n`);
  const r = run({ VMDEPLOY_PROBE_STAMP: p, PROBE_PKG: '/pkg/A' }, NOW);
  assert.equal(r.reuse, false);
  assert.ok(/超新鲜窗/.test(r.reason), r.reason);
  rmSync(dir, { recursive: true, force: true });
});

test('防线②：包根不匹配（换版本重取包场景）⇒ REUSE=0', () => {
  const { dir, p } = stampFile(`epoch=${NOW - 10}\npkg=/pkg/A\n`);
  const r = run({ VMDEPLOY_PROBE_STAMP: p, PROBE_PKG: '/pkg/B' }, NOW);
  assert.equal(r.reuse, false);
  assert.ok(/包根不匹配/.test(r.reason), r.reason);
  rmSync(dir, { recursive: true, force: true });
});

test('防线②负例：PROBE_PKG 空（调用方未传）⇒ 保守不复用', () => {
  const { dir, p } = stampFile(`epoch=${NOW - 10}\npkg=/pkg/A\n`);
  const r = run({ VMDEPLOY_PROBE_STAMP: p, PROBE_PKG: '' }, NOW);
  assert.equal(r.reuse, false);
  rmSync(dir, { recursive: true, force: true });
});

test('防线③：VERIFY_FORCE_PROBE=1 ⇒ 即便全条件满足也冷跑', () => {
  const { dir, p } = stampFile(`epoch=${NOW - 10}\npkg=/pkg/A\n`);
  const r = run({ VMDEPLOY_PROBE_STAMP: p, PROBE_PKG: '/pkg/A', VERIFY_FORCE_PROBE: '1' }, NOW);
  assert.equal(r.reuse, false);
  assert.ok(/强制冷跑/.test(r.reason), r.reason);
  rmSync(dir, { recursive: true, force: true });
});

test('保守面：stamp 缺失 ⇒ REUSE=0（首跑/undeploy 后未重装态绝不假复用）', () => {
  const r = run({ VMDEPLOY_PROBE_STAMP: '/nonexistent/stamp.txt', PROBE_PKG: '/pkg/A' }, NOW);
  assert.equal(r.reuse, false);
  assert.ok(/stamp 缺失/.test(r.reason), r.reason);
});

test('保守面：epoch 非数字/缺失 ⇒ REUSE=0（损坏 stamp 不可信）', () => {
  const cases = ['pkg=/pkg/A\n', 'epoch=abc\npkg=/pkg/A\n', 'epoch=\npkg=/pkg/A\n'];
  for (const c of cases) {
    const { dir, p } = stampFile(c);
    const r = run({ VMDEPLOY_PROBE_STAMP: p, PROBE_PKG: '/pkg/A' }, NOW);
    assert.equal(r.reuse, false, 'case=' + JSON.stringify(c));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('保守面：stamp 时钟超未来（age<0，NTP 跳变/时区坑）⇒ REUSE=0', () => {
  const { dir, p } = stampFile(`epoch=${NOW + 500}\npkg=/pkg/A\n`);
  const r = run({ VMDEPLOY_PROBE_STAMP: p, PROBE_PKG: '/pkg/A' }, NOW);
  assert.equal(r.reuse, false);
  assert.ok(/超未来/.test(r.reason), r.reason);
  rmSync(dir, { recursive: true, force: true });
});

test('健壮面：CRLF stamp（Windows 写回污染面）⇒ 行解析仍正确 REUSE=1', () => {
  const { dir, p } = stampFile(`epoch=${NOW - 100}\r\npkg=/pkg/A\r\n`);
  const r = run({ VMDEPLOY_PROBE_STAMP: p, PROBE_PKG: '/pkg/A' }, NOW);
  assert.equal(r.reuse, true, 'CRLF 不得破坏判定（pkg 比对若残留 \\r 会假不匹配→退化为恒冷跑=可接受但本判应正确复用）');
  rmSync(dir, { recursive: true, force: true });
});

test('窗可配：PROBE_FRESH_BUDGET_S=60 时 100s 龄不复用；默认 600 时可复用', () => {
  const { dir, p } = stampFile(`epoch=${NOW - 100}\npkg=/pkg/A\n`);
  assert.equal(run({ VMDEPLOY_PROBE_STAMP: p, PROBE_PKG: '/pkg/A', PROBE_FRESH_BUDGET_S: '60' }, NOW).reuse, false);
  assert.equal(run({ VMDEPLOY_PROBE_STAMP: p, PROBE_PKG: '/pkg/A' }, NOW).reuse, true);
  rmSync(dir, { recursive: true, force: true });
});

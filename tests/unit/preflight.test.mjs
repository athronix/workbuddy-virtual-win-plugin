#!/usr/bin/env node
/**
 * delivery/preflight.mjs 单测（无网沙箱，纯 Node 内置 + 临时目录）。
 *
 * 覆盖：
 *  1. parseNodeVersion 解析 / 非法返回 null；
 *  2. versionGte 语义化比较；
 *  3. checkHostDeps — WorkBuddy 缺失（阻断）→ 整体 ok:false；
 *  4. checkHostDeps — WorkBuddy 存在（node 在测试环境 >=18）→ 整体 ok:true；
 *  5. checkLocalVmDeps — workbuddy-deterministic 下 agent CLI 缺失为 WARNING（blocking:false），整体 ok:true；
 *  6. checkLocalVmDeps — workbuddy 下 agent CLI 缺失为阻断（blocking:true, ok:false），整体 ok:false；
 *  7. printChecks — 阻断缺失含 `[缺失`、非阻断缺失含 `[警告`；
 *  8. assertDeps — 第 6 项 false、第 5 项 true。
 *
 * 约定：本文件用 `node --test tests/unit/preflight.test.mjs` 单独跑。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseNodeVersion,
  versionGte,
  checkHostDeps,
  checkLocalVmDeps,
  printChecks,
  assertDeps,
} from '../../delivery/preflight.mjs';

/** 建临时「宿主根」，返回其路径；调用方负责 rmSync。 */
function mkHome() {
  return mkdtempSync(join(tmpdir(), 'winvm-pf-'));
}

test('parseNodeVersion 解析 v18.20.4 / 非法返回 null', () => {
  assert.deepEqual(parseNodeVersion('v18.20.4'), { major: 18, minor: 20, patch: 4 });
  assert.deepEqual(parseNodeVersion('v24.13.0'), { major: 24, minor: 13, patch: 0 });
  assert.deepEqual(parseNodeVersion('18.20.4'), { major: 18, minor: 20, patch: 4 });
  assert.equal(parseNodeVersion('not-a-version'), null);
  assert.equal(parseNodeVersion(''), null);
  assert.equal(parseNodeVersion('v1.2'), null);
  assert.equal(parseNodeVersion(undefined), null);
});

test('versionGte 语义化比较', () => {
  assert.equal(versionGte('20.0.0', '18.0.0'), true);
  assert.equal(versionGte('17.0.0', '18.0.0'), false);
  assert.equal(versionGte('18.0.0', '18.0.0'), true);
  assert.equal(versionGte('18.1.0', '18.0.9'), true);
  // 任意一边无法 parse → false
  assert.equal(versionGte('xx.0.0', '18.0.0'), false);
  assert.equal(versionGte('18.0.0', 'xx.0.0'), false);
});

test('checkHostDeps — WorkBuddy 缺失 → workbuddy-host 阻断 false，整体 ok:false', () => {
  const home = mkHome();
  try {
    const res = checkHostDeps({ home });
    const wb = res.checks.find((c) => c.id === 'workbuddy-host');
    assert.ok(wb, '应包含 workbuddy-host 检查项');
    assert.equal(wb.ok, false);
    assert.equal(wb.blocking, true);
    assert.equal(res.ok, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('checkHostDeps — WorkBuddy 存在 → workbuddy-host ok:true（整体 ok:true）', () => {
  const home = mkHome();
  try {
    mkdirSync(join(home, '.workbuddy'), { recursive: true });
    const res = checkHostDeps({ home });
    const wb = res.checks.find((c) => c.id === 'workbuddy-host');
    assert.equal(wb.ok, true);
    // node 检查在测试环境应 >=18 通过，故整体 ok:true
    assert.equal(res.ok, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('checkLocalVmDeps — workbuddy-deterministic 下 agent CLI 缺失为 WARNING，整体 ok 仍 true', () => {
  const res = checkLocalVmDeps({ provider: 'workbuddy-deterministic', cli: '__definitely_not_a_real_cli_xyz__' });
  const agent = res.checks.find((c) => c.id === 'vm-agent-cli');
  assert.ok(agent, '应包含 vm-agent-cli 检查项');
  assert.equal(agent.blocking, false);
  assert.equal(agent.ok, false);
  // 确定性执行器：agent CLI 缺失仅为 WARNING，不阻断安装
  assert.equal(res.ok, true);
});

test('checkLocalVmDeps — workbuddy 下 agent CLI 缺失为阻断，整体 ok:false', () => {
  const res = checkLocalVmDeps({ provider: 'workbuddy', cli: '__definitely_not_a_real_cli_xyz__' });
  const agent = res.checks.find((c) => c.id === 'vm-agent-cli');
  assert.ok(agent, '应包含 vm-agent-cli 检查项');
  assert.equal(agent.blocking, true);
  assert.equal(agent.ok, false);
  assert.equal(res.ok, false);
});

test('printChecks — 阻断缺失含 [缺失、非阻断缺失含 [警告', () => {
  const report = {
    ok: false,
    checks: [
      { id: 'a', label: 'A 阻断项', ok: false, detail: '未满足', remedy: '去修 A', blocking: true },
      { id: 'b', label: 'B 警告项', ok: false, detail: '未满足', remedy: '去修 B', blocking: false },
    ],
  };
  const out = printChecks(report, { headline: '=== 测试预检 ===' });
  assert.ok(out.includes('[缺失'), '阻断缺失应含 [缺失 标记');
  assert.ok(out.includes('[警告'), '非阻断缺失应含 [警告 标记');
  assert.ok(out.includes('A 阻断项'));
  assert.ok(out.includes('B 警告项'));
});

test('assertDeps — 阻断缺失第 6 项返回 false，WARNING 第 5 项返回 true', () => {
  const blockingFail = checkLocalVmDeps({ provider: 'workbuddy', cli: '__definitely_not_a_real_cli_xyz__' });
  const warnOnly = checkLocalVmDeps({ provider: 'workbuddy-deterministic', cli: '__definitely_not_a_real_cli_xyz__' });
  assert.equal(assertDeps(blockingFail), false);
  assert.equal(assertDeps(warnOnly), true);
  // allowWarnings 仅语义占位，不影响结果
  assert.equal(assertDeps(blockingFail, { allowWarnings: true }), false);
  assert.equal(assertDeps(warnOnly, { allowWarnings: false }), true);
});

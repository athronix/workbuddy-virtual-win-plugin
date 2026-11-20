/**
 * V1.4.36 · 卸载器「VM 相位跳过」的意图 vs 意外（P18 同类形态修复）
 *
 * 真 bug（2026-11-20 真机，`UNDEPLOY=PASS` 却打 `uninstall_rc=1`）：
 *   deploy skill 的 1b 步**故意**以 host-only 方式调用本脚本（先屏蔽 .env、
 *   再 unset WINVM_VM_HOST，让第 2 步独占 VM 侧）。旧代码里 vm 为 null 时走
 *   `else { failures++ }`，于是每一轮 host-only 卸载都以
 *   「APPLY finished with 1 failure(s)」+ exit 1 收尾，而 11 项复验全 PASS。
 *   skill 侧只能靠「只信 HOST 行」绕过去 —— 恰恰是**人最先看的那一行数字在说谎**，
 *   与 P18（失败行打印 rc=0）同一形态。
 *
 * 修复口径：区分**显式意图**与**意外落空**
 *   --host-only 显式给           → 跳过是设计，不计失败
 *   未给且解析不到 VM 目标        → 跳过，仍计 1 次失败（真的「够不到 VM」）
 *   解析到目标                    → 跑 VM 相位，由它自己的 rc 决定
 *
 * 本文件把这条口径固化为**纯函数契约**（`planVmPhase`），不依赖真实 VM / SSH。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { planVmPhase, parseArgs } from '../../delivery/uninstall.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
const SRC = readFileSync(join(ROOT, 'delivery', 'uninstall.mjs'), 'utf8');

const VM = { host: '172.16.100.2', user: 'User', sshPort: 22 };

/* ============================================================================
 * ① 纯函数契约：三态决策
 * ========================================================================== */

describe('planVmPhase：显式意图 vs 意外落空', () => {
  test('host-only + 无 VM 目标 → 跳过且**不计**失败（本轮真 bug 的核心）', () => {
    const p = planVmPhase({ hostOnly: true, vm: null });
    assert.equal(p.action, 'skip');
    assert.equal(p.countsAsFailure, false);
    assert.match(p.note, /host-only/);
    assert.match(p.note, /by design/);
  });

  test('host-only + 目标恰好存在 → 仍按 host-only 跳过，绝不偷跑 VM 相位', () => {
    // 万一 .env / vm-conn.json 没屏蔽干净，也不许把 VM 相位重复跑一遍。
    const p = planVmPhase({ hostOnly: true, vm: VM });
    assert.equal(p.action, 'skip');
    assert.equal(p.countsAsFailure, false);
  });

  test('未给 host-only + 无目标 → 跳过，但**计 1 次失败**（真的够不到 VM）', () => {
    const p = planVmPhase({ hostOnly: false, vm: null });
    assert.equal(p.action, 'skip');
    assert.equal(p.countsAsFailure, true);
    // 提示必须给出可执行的下一步，否则用户只会看到「失败了」却不知为何
    assert.match(p.note, /--host-only/);
    assert.match(p.note, /--vm-host/);
  });

  test('有目标 → 跑 VM 相位，失败由它自己的 rc 决定（不预设计数）', () => {
    const p = planVmPhase({ hostOnly: false, vm: VM });
    assert.equal(p.action, 'run');
    assert.equal(p.countsAsFailure, false);
  });

  test('dry-run 下 host-only 的措辞区分「未执行」而非「已跳过」', () => {
    const p = planVmPhase({ hostOnly: true, vm: null, dryRun: true });
    assert.equal(p.countsAsFailure, false);
    assert.match(p.note, /dry-run/);
  });

  test('默认参数不崩（全空调用）', () => {
    const p = planVmPhase();
    assert.equal(p.action, 'skip');
    assert.equal(p.countsAsFailure, true); // 无 host-only、无 target = 意外落空
  });
});

/* ============================================================================
 * ② CLI 解析：--host-only 必须真的被识别
 * ========================================================================== */

describe('parseArgs：--host-only 开关', () => {
  test('--host-only 置位', () => {
    assert.equal(parseArgs(['--apply', '--host-only']).hostOnly, true);
  });

  test('未给时为 false（默认不改变既有调用方行为）', () => {
    assert.equal(parseArgs(['--apply']).hostOnly, false);
  });

  test('未知参数不炸（向前兼容，不能因新增开关破坏旧调用）', () => {
    assert.doesNotThrow(() => parseArgs(['--apply', '--some-future-flag']));
  });
});

/* ============================================================================
 * ③ 静态守卫：接线必须真的接上（纯函数正确但没人调用 = 白修）
 * ========================================================================== */

describe('接线守卫（防「函数对了但没接上」的假修复）', () => {
  test('main 里 VM 相位走 planVmPhase，不再裸判 `if (vm)` + 无条件 failures++', () => {
    assert.match(SRC, /planVmPhase\s*\(\s*\{\s*hostOnly:\s*args\.hostOnly/);
    assert.match(SRC, /if\s*\(\s*vmPlan\.action\s*===\s*'run'\s*\)/);
    // 旧形态：解析不到目标就直接 failures++ —— 必须彻底消失
    assert.doesNotMatch(
      SRC,
      /--- VM: SKIPPED \(no target resolved[\s\S]{0,200}?failures\+\+/,
      '旧的「跳过即计失败」形态仍在',
    );
  });

  test('计数只在 countsAsFailure 为真时发生', () => {
    assert.match(SRC, /if\s*\(\s*vmPlan\.countsAsFailure\s*\)\s*failures\+\+/);
  });

  test('复验表把 hostOnly 传下去，且 host-only 行判 PASS', () => {
    assert.match(SRC, /printVerification\([\s\S]{0,160}?args\.hostOnly\s*\)/);
    assert.match(SRC, /VM side checks skipped by design \(--host-only\)/);
    assert.match(SRC, /async function printVerification\([^)]*hostOnly = false\)/);
  });

  test('host-only 分支必须排在 `if (vm)` 之前（否则会去连 SSH 并打误导的 dry-run 措辞）', () => {
    const iHostOnly = SRC.indexOf("if (hostOnly) {\n    // 显式 host-only");
    const iIfVm = SRC.indexOf('  } else if (vm) {', iHostOnly);
    assert.ok(iHostOnly > 0, '未找到 host-only 复验分支');
    assert.ok(iIfVm > iHostOnly, 'host-only 分支必须在前，vm 分支在后（else if）');
    // 实测踩到的具体症状：--apply --host-only 却打 "skipped (dry-run)"
    assert.doesNotMatch(
      SRC,
      /rows\.push\(\['VM side checks', executed, 'skipped \(dry-run\)'\]\)/,
      '复验表仍在用 dry-run 措辞描述「VM 相位未执行」（--apply 时会误导）',
    );
  });

  test('help 文本写明 --host-only 与「不给则仍计失败」的区别', () => {
    assert.match(SRC, /--host-only\s+ONLY clean the host side/);
    assert.match(SRC, /still counts as ONE failure/);
  });
});
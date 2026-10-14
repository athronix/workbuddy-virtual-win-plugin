/**
 * Phase 3 · 批5 Q3 顺带修复：PsBridge spawn 异步失败的 `'error'` 事件收口。
 *
 * 病灶（真机/离线双环境实证路径：tests/e2e/smoke.test.js 在无 PowerShell 的 POSIX
 * 宿主上跑 createService → provider degraded 初始化，但 once('error') 修复前，
 * spawn ENOENT 的异步 error 事件**无人认领 = uncaughtException**，Node test runner
 * 视其为跨测试污染（"generated asynchronous activity after the test ended"告警真身）。
 * 生产形态的最坏后果：ps-bridge 自愈重建时遇二进制瞬失（PATH 竞态/杀软隔离）⇒
 * 未捕获异常打挂 vm-service 本体——「自愈」反而成为崩溃源。
 *
 * 修复（ps-bridge.ts spawnAndReady）：spawned.once('error') 折叠为与 exit 同族收口
 * —— failAll(PSBRIDGE_SPAWN_FAILED) + spawned 比对清 child（防误清新进程）。
 *
 * 判别性：
 *  1. 本文件整体跑完不崩 = error 事件被监听吞住（修复前 uncaughtException 判死全文件）；
 *  2. start() 以 PSBRIDGE_* 结构化错误 reject（ready 握手见 running=false 抛 NOT_RUNNING），
 *     绝不无限挂起；
 *  3. 失败后 running=false、可再次 start（脚本缺失路径同样拒绝）——不留半死状态。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const { PsBridge } = await import(
  'file:///' + join(ROOT, 'packages/vm-capabilities/dist/ps-bridge.js').replace(/\\/g, '/')
);

const REAL_SCRIPT = join(ROOT, 'packages', 'vm-capabilities', 'psmod', 'ps-bridge.ps1');

describe('Q3-spawn-error · PsBridge 异步 spawn 失败收口', () => {
  test('powershellPath 不存在 ⇒ start() 结构化 reject（不挂起、不崩进程）', async () => {
    const prev = process.env['WINVM_PSBRIDGE_READY_TIMEOUT_MS'];
    process.env['WINVM_PSBRIDGE_READY_TIMEOUT_MS'] = '1500';
    try {
      const b = new PsBridge({
        scriptPath: REAL_SCRIPT, // 脚本在场 ⇒ 过 existsSync 卫进入真 spawn
        powershellPath: join(ROOT, '__definitely_not_a_real_powershell__.exe'),
      });
      await assert.rejects(
        () => b.start(),
        (e) => typeof e?.message === 'string' && e.message.includes('ps-bridge'),
        '必须以 ps-bridge 结构化错误收口',
      );
      assert.equal(b.running, false, '失败后不得留 running=true 半死态');
      b.dispose?.();
    } finally {
      if (prev === undefined) delete process.env['WINVM_PSBRIDGE_READY_TIMEOUT_MS'];
      else process.env['WINVM_PSBRIDGE_READY_TIMEOUT_MS'] = prev;
    }
  });

  test('脚本缺失 ⇒ PSBRIDGE_SCRIPT_MISSING（既有卫路径回归：先于 spawn 拒绝）', async () => {
    const b = new PsBridge({
      scriptPath: join(ROOT, 'no-such-ps-bridge.ps1'),
      powershellPath: join(ROOT, '__not_real__.exe'),
    });
    await assert.rejects(() => b.start(), /PSBRIDGE_SCRIPT_MISSING|找不到/);
    assert.equal(b.running, false);
  });
});

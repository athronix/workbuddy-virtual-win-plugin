/**
 * Phase 3 批2 · Q1 隧道启动期退避重连 + 终态留痕 + 并发互斥（单测）
 *
 * 覆盖（audit-qa ⑥ P0/P1 行动项）：
 *  - startBackoffDelay：与 oh-tunnel 稳态退避同款公式（指数 + 上限 30s + jitter 0~30%）；
 *  - acquirePidfileExclusive：'wx' 独占语义（首得 true，再得 false）；
 *  - runDaemon 启动瞬态失败 → 退避重试后成功（不再"首连失败即退"）；
 *  - runDaemon --start-retry N 达上限 → 返回 1 且保留 state=STOPPED+reason='start-giveup'
 *    （诊断文件不被删——旧实现 giveup/失败均 rmSync，双向丢诊断）；
 *  - 构造期 throw（B 型缺参）→ 不进重试循环，留 reason='start-config-error' retryable:false；
 *  - 日志行含 pid 前缀（并发实例可机械归因）。
 *
 * 运行（只跑本文件，绝不整批）：
 *   node --test tests/unit/phase3-b2-tunnel-start.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

import {
  parseDaemonArgv,
  startBackoffDelay,
  acquirePidfileExclusive,
  runDaemon,
} from '../../delivery/tunnel-daemon.mjs';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'phase3-b2-tunnel-'));
}

const baseArgv = (pf) => [
  '--pidfile', pf,
  '--vm-host', 'h', '--vm-user', 'u',
  '--local-port', '0', '--remote-port', '18443',
];

const okLoader = async () => function C() {};

/* --------------------------- startBackoffDelay --------------------------- */

test('startBackoffDelay：公式 min(30s, 1s×2^(n-1)) + rand×0.3×delay', () => {
  const zero = () => 0;
  const full = () => 1 - Number.EPSILON;
  assert.equal(startBackoffDelay(1, zero), 1000, '第 1 次无抖动 = 1s');
  assert.equal(startBackoffDelay(2, zero), 2000, '第 2 次无抖动 = 2s');
  assert.equal(startBackoffDelay(3, zero), 4000);
  // 上限 30s：第 10 次基础值 2^9=512s → clamp 30s
  assert.equal(startBackoffDelay(10, zero), 30000);
  assert.equal(startBackoffDelay(0, zero), 1000, 'attempt<1 归 1');
  // 抖动带：delay + [0, 0.3×delay)
  const d5 = startBackoffDelay(5, full);
  assert.ok(d5 >= 16000 && d5 < 16000 * 1.3 + 1, `抖动带命中（${d5}）`);
});

/* --------------------------- pidfile 独占锁 --------------------------- */

test('acquirePidfileExclusive：首得 true（内容=pid），再得 false（EEXIST）', () => {
  const dir = tmpDir();
  try {
    const pf = join(dir, 'tunnel.pid');
    assert.equal(acquirePidfileExclusive(pf, 12345), true, '首次独占创建应成功');
    assert.equal(readFileSync(pf, 'utf8').trim(), '12345');
    assert.equal(acquirePidfileExclusive(pf, 99999), false, '已存在应返回 false（第二实例让位）');
    assert.equal(readFileSync(pf, 'utf8').trim(), '12345', '失败方不得改写他人 pidfile');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* --------------------------- runDaemon：启动退避后成功 --------------------------- */

test('runDaemon 启动瞬态失败 2 次 → 退避重试第 3 次成功（不再即退）', async () => {
  const dir = tmpDir();
  try {
    const pf = join(dir, 'tunnel.pid');
    const log = join(dir, 'tunnel.log');
    let attempts = 0;
    class MockTunnel extends EventEmitter {
      async start() {
        attempts += 1;
        if (attempts <= 2) throw new Error('connect EHOSTUNREACH 172.16.100.2');
        this.emit('ready');
      }
      async stop() {}
    }
    const code = await runDaemon(baseArgv(pf), {
      loadSsh2Client: okLoader,
      OhSshTunnel: MockTunnel,
      logPath: log,
      startRetryDelayMs: 1,
    });
    assert.equal(code, 0, '重试后成功应返回 0');
    assert.equal(attempts, 3);
    const logText = readFileSync(log, 'utf8');
    assert.match(logText, /隧道启动失败（第 1 次尝试）/);
    assert.match(logText, /隧道启动失败（第 2 次尝试）/);
    assert.match(logText, /隧道已就绪/);
    // 日志行含 pid 前缀（并发归因）
    assert.match(logText, /pid=\d+ INFO 隧道已就绪/);
    // 重试期 state 记录 startAttempt
    const st = JSON.parse(readFileSync(`${pf}.state.json`, 'utf8'));
    assert.equal(st.state, 'RUNNING', '最终 state 应为 ready 后的 RUNNING');
    assert.ok(existsSync(pf), '成功路径 pidfile 应保留');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* --------------------------- runDaemon：达上限留 STOPPED 终态 --------------------------- */

test('runDaemon --start-retry 2 恒失败 → 返回 1、STOPPED+reason 留痕、pidfile 清、state 保留', async () => {
  const dir = tmpDir();
  try {
    const pf = join(dir, 'tunnel.pid');
    const log = join(dir, 'tunnel.log');
    let attempts = 0;
    class MockTunnel extends EventEmitter {
      async start() {
        attempts += 1;
        throw new Error('connect EHOSTUNREACH');
      }
      async stop() {}
    }
    const code = await runDaemon([...baseArgv(pf), '--start-retry', '2'], {
      loadSsh2Client: okLoader,
      OhSshTunnel: MockTunnel,
      logPath: log,
      startRetryDelayMs: 1,
    });
    assert.equal(code, 1);
    assert.equal(attempts, 2, '恰尝试 start-retry 次');
    // 终态文件保留（旧实现此处 rmSync 全删 = "死无对证"）
    const stPath = `${pf}.state.json`;
    assert.ok(existsSync(stPath), 'STOPPED 终态文件必须保留');
    const st = JSON.parse(readFileSync(stPath, 'utf8'));
    assert.equal(st.state, 'STOPPED');
    assert.equal(st.reason, 'start-giveup');
    assert.equal(st.attempts, 2);
    assert.match(st.lastError, /EHOSTUNREACH/);
    assert.equal(existsSync(pf), false, 'pidfile 应清理（不残留死 pid）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* --------------------------- runDaemon：构造期错误不重试 --------------------------- */

test('runDaemon 构造期 throw（B 型缺参）→ 单次即退、STOPPED reason=start-config-error retryable:false', async () => {
  const dir = tmpDir();
  try {
    const pf = join(dir, 'tunnel.pid');
    const log = join(dir, 'tunnel.log');
    let constructed = 0;
    let started = 0;
    class MockTunnel extends EventEmitter {
      constructor(opts) {
        super();
        constructed += 1;
        if (!opts.vmHost) throw new Error('缺少必填项 vmHost');
      }
      async start() { started += 1; this.emit('ready'); }
      async stop() {}
    }
    const code = await runDaemon(
      ['--pidfile', pf, '--vm-user', 'u', '--local-port', '0', '--remote-port', '18443'],
      { loadSsh2Client: okLoader, OhSshTunnel: MockTunnel, logPath: log, startRetryDelayMs: 1 },
    );
    assert.equal(code, 1);
    assert.equal(constructed, 1, '构造期错误不得进入重试循环再构造');
    assert.equal(started, 0);
    const st = JSON.parse(readFileSync(`${pf}.state.json`, 'utf8'));
    assert.equal(st.state, 'STOPPED');
    assert.equal(st.reason, 'start-config-error');
    assert.equal(st.retryable, false);
    assert.match(st.lastError, /vmHost/);
    assert.equal(existsSync(pf), false, 'config-error 后 pidfile 清理');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* --------------------------- parseDaemonArgv：--start-retry --------------------------- */

test('parseDaemonArgv：--start-retry 缺省 Infinity，非法值回落 Infinity，正整数生效', () => {
  assert.equal(parseDaemonArgv([]).startRetry, Infinity);
  assert.equal(parseDaemonArgv(['--start-retry', '5']).startRetry, 5);
  assert.equal(parseDaemonArgv(['--start-retry', '0']).startRetry, Infinity, '0/负数按无限');
  assert.equal(parseDaemonArgv(['--start-retry', 'abc']).startRetry, Infinity);
});

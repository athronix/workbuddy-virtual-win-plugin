#!/usr/bin/env node
/**
 * T-CRASH · delivery/oh-tunnel.mjs 崩溃缺陷修复 —— 错误注入回归测试。
 *
 * 本文件归属 delivery/__tests__（software-engineer 独占区），**不触碰** QA 独占的 tests/unit/。
 *
 * 覆盖三件事：
 *  1) 分类器 isConnectionLevelError：连接层 vs 单通道错误；
 *  2) 运行时注入单次 ssh 错误（forwardOut / client 'error'，上层不注册 'error' 监听）：
 *     子进程**不崩**（无 `Unhandled 'error' event`）、走退避重连并恢复；
 *  3) 守护进程层（runDaemon）：注入后进程存活、state 文件记录原因、本地 18443 仍可用。
 *
 * 关键：崩溃只能由**独立子进程**取证（进程内 try/catch 会掩盖崩溃）。故 1/2/3 全部 spawn
 * 现成的探针脚本 delivery/__tests__/probe-tunnel-error.mjs 与 probe-daemon-error.mjs。
 *
 * 用法（务必单文件跑，勿整批）：node --test delivery/__tests__/oh-tunnel-error-handling.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { OhSshTunnel, isConnectionLevelError } from '../oh-tunnel.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TUNNEL_PROBE = join(HERE, 'probe-tunnel-error.mjs');
const DAEMON_PROBE = join(HERE, 'probe-daemon-error.mjs');
const NODE = process.execPath;

/** spawn 一个探针（独立子进程），返回 { code, signal, out, err }。 */
function runProbe(script, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, out, err }));
  });
}

/** 从探针输出中解析 PROBE_RESULT 行（容错：找不到返回 null）。 */
function parseResult(out) {
  for (const line of out.split('\n')) {
    if (line.startsWith('PROBE_RESULT ')) {
      try { return JSON.parse(line.slice('PROBE_RESULT '.length)); } catch { /* ignore */ }
    }
  }
  return null;
}

/** 从输出中挑出所有 PROBE_EVENT 行。 */
function parseEvents(out) {
  const evs = [];
  for (const line of out.split('\n')) {
    if (line.startsWith('PROBE_EVENT ')) {
      try { evs.push(JSON.parse(line.slice('PROBE_EVENT '.length))); } catch { /* ignore */ }
    }
  }
  return evs;
}

/** 判定输出是否含「进程崩溃」特征（与取证栈一致）。 */
function hasUnhandledCrash(out, err) {
  const blob = `${out}\n${err}`;
  return /Unhandled 'error' event/.test(blob) || /Emitted 'error' event on OhSshTunnel/.test(blob);
}

/* ----------------------------- 1. 分类器 ----------------------------- */

test('分类器：连接层错误（No response from server / keepalive / econnreset）应判为连接层', () => {
  assert.equal(isConnectionLevelError(new Error('No response from server')), true);
  assert.equal(isConnectionLevelError(new Error('keepalive timeout, no response')), true);
  assert.equal(isConnectionLevelError(new Error('read ECONNRESET')), true);
  assert.equal(isConnectionLevelError(new Error('connect ETIMEDOUT')), true);
  assert.equal(isConnectionLevelError(new Error('Channel open failure: administratively prohibited')), true);
});

test('分类器：非连接层错误应判为非连接层', () => {
  assert.equal(isConnectionLevelError(new Error('some generic stream error')), false);
  assert.equal(isConnectionLevelError(new Error('')), false);
  assert.equal(isConnectionLevelError(null), false);
});

/* ----------------------------- 2. 隧道类层：不崩 + 重连 ----------------------------- */

test('崩溃缺陷已修复：forwardOut 通道错误（上层不注册 error）子进程不崩且走退避重连', async () => {
  const r = await runProbe(TUNNEL_PROBE, ['--scenario=forward-out-error-no-listener']);

  assert.equal(hasUnhandledCrash(r.out, r.err), false, `不应崩溃；实测 stderr/out 含崩溃特征:\n${r.err || r.out}`);
  assert.equal(r.code, 0, `子进程应以 0 退出（存活），实得 code=${r.code}`);

  const res = parseResult(r.out);
  assert.ok(res, '应能解析 PROBE_RESULT');
  assert.equal(res.survived, true);
  assert.ok(res.reconnectingCount >= 1, `应触发退避重连，实得 reconnectingCount=${res.reconnectingCount}`);
  assert.ok(res.reconnectedCount >= 1, `应重连成功，实得 reconnectedCount=${res.reconnectedCount}`);
  assert.equal(res.stoppedCleanly, true, 'stop 不得二次崩溃');
});

test('崩溃缺陷已修复：ready 后 client 连接层错误不再「假活」（应重连恢复，而非 alive 但仍死）', async () => {
  const r = await runProbe(TUNNEL_PROBE, ['--scenario=client-error-no-listener']);

  assert.equal(hasUnhandledCrash(r.out, r.err), false, `不应崩溃；实测:\n${r.err || r.out}`);
  assert.equal(r.code, 0);

  const res = parseResult(r.out);
  assert.ok(res, '应能解析 PROBE_RESULT');
  // 修复前该场景 reconnectingCount === 0 且 aliveAtEnd === true（假活）；修复后必须重连。
  assert.ok(res.reconnectingCount >= 1, `不得再「假活」，应重连，实得 reconnectingCount=${res.reconnectingCount}`);
  assert.equal(res.aliveAtEnd, true, '重连后应恢复可用');
});

test('对照：上层注册 error 监听时错误信息仍能正确投递', async () => {
  const r = await runProbe(TUNNEL_PROBE, ['--scenario=forward-out-error-with-listener']);
  assert.equal(hasUnhandledCrash(r.out, r.err), false);
  const res = parseResult(r.out);
  assert.ok(res, '应能解析 PROBE_RESULT');
  assert.ok(
    res.tunnelErrorEvents.includes('No response from server'),
    `error 监听应收到错误，实得 ${JSON.stringify(res.tunnelErrorEvents)}`,
  );
  assert.ok(res.reconnectingCount >= 1, '即便有监听也应自愈重连');
});

/* ----------------------------- 3. 守护进程层：存活 + state 记录 ----------------------------- */

test('守护进程层：注入 forwardOut 错误后进程存活、state 记录原因、18443 仍可用', async () => {
  const r = await runProbe(DAEMON_PROBE, ['--inject=forward-out-error']);
  assert.equal(hasUnhandledCrash(r.out, r.err), false, `守护进程不应崩溃；实测:\n${r.err || r.out}`);
  assert.equal(r.code, 0, `守护进程应存活退出，实得 code=${r.code}`);

  const res = parseResult(r.out);
  assert.ok(res, '应能解析 PROBE_RESULT');
  assert.equal(res.survived, true);
  assert.equal(res.pidfileExistedAtEnd, true, '守护进程未崩 → pidfile 应仍存在');
  // 重连后应恢复 RUNNING/可用
  assert.equal(res.stateAfterInject?.state, 'RUNNING', `重连后应 RUNNING，实得 ${res.stateAfterInject?.state}`);
  // 日志/诊断里必须留下「原因」（绝不静默死）
  const logBlob = JSON.stringify(res.logTail ?? []);
  assert.ok(
    logBlob.includes('隧道错误') && logBlob.includes('No response from server'),
    `state 日志应记录原因，实得 ${logBlob}`,
  );
});

test('守护进程层：注入 ready 后 client 错误后进程存活且重连恢复', async () => {
  const r = await runProbe(DAEMON_PROBE, ['--inject=client-error']);
  assert.equal(hasUnhandledCrash(r.out, r.err), false);
  assert.equal(r.code, 0);
  const res = parseResult(r.out);
  assert.ok(res, '应能解析 PROBE_RESULT');
  assert.equal(res.stateAfterInject?.state, 'RUNNING', `重连后应 RUNNING，实得 ${res.stateAfterInject?.state}`);
});

/* ----------------------------- 4. 进程内：未注册监听也不抛 ----------------------------- */

test('进程内：未注册 error 监听时，forwardOut 失败只触发重连、不抛未捕获异常', async () => {
  const { MockClient } = await makeMockClientForInProcess();
  const port = await getFreePort();
  const tunnel = new OhSshTunnel({
    vmHost: '172.16.100.2',
    vmSshPort: 22,
    username: 'User',
    localBindHost: '127.0.0.1',
    localBindPort: port,
    remoteHost: '127.0.0.1',
    remotePort: 18443,
    password: 'test-password',
    ssh2Client: MockClient,
    hostVerifier: () => {},
    readyTimeoutMs: 3000,
  });

  let reconnecting = 0;
  tunnel.on('reconnecting', () => { reconnecting += 1; });

  await tunnel.start();
  try {
    // 故意不注册 'error' 监听（复刻守护进程历史接线）
    const sock = net.connect(tunnel.localPort, '127.0.0.1');
    await new Promise((resolve) => {
      sock.once('connect', resolve);
      sock.once('error', resolve);
    });
    sock.destroy();
    // 等待退避重连（base 1s + jitter）
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.ok(reconnecting >= 1, `应触发退避重连，实得 reconnecting=${reconnecting}`);
  } finally {
    await tunnel.stop();
  }
});

/* ----------------------------- 工具 ----------------------------- */

async function makeMockClientForInProcess() {
  const state = { forwardOutCalls: 0 };
  class MockClient extends EventEmitter {
    constructor() { super(); }
    connect(opts) {
      if (typeof opts?.hostVerifier === 'function') opts.hostVerifier(Buffer.from('k'), () => {});
      setImmediate(() => this.emit('ready'));
    }
    forwardOut(_lh, _lp, _rh, _rp, cb) {
      state.forwardOutCalls += 1;
      // 复刻 onChannelOpenFailure：以 (err) 回调
      setImmediate(() => cb(new Error('No response from server')));
      return undefined;
    }
    end() { setImmediate(() => this.emit('close')); }
  }
  return { MockClient, state };
}

/** 从 OS 申请一个当前空闲的本地端口（回环）。 */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

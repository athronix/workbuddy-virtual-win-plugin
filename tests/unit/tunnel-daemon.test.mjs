#!/usr/bin/env node
/**
 * CL-015 T12 · delivery/tunnel-daemon.mjs 单测（无网沙箱，纯逻辑 + 注入 mock）。
 *
 * 覆盖（P0-02）：
 *  - export 形态：parseDaemonArgv / isAlive / readJsonSafe / writePidfileAtomic /
 *    writeStateAtom / runDaemon 均为 function；
 *  - parseDaemonArgv：参数解析（含 --pidfile 默认落点）；
 *  - isAlive：自身 pid→true、非法/不存在 pid→false；
 *  - readJsonSafe：不存在/损坏→null，合法→对象；
 *  - writePidfileAtomic / writeStateAtom：原子写（tmp→rename），无 .tmp 残留；
 *  - runDaemon 幂等：已有存活 pidfile → 返回 0 且不构造隧道；
 *  - runDaemon 失败：ssh2 解析失败 → 返回 1、pidfile 不落盘、错误入日志；
 *  - 安全哨兵：password 经 env 传入并被透传给隧道，但 pidfile / 日志**绝不**含凭据明文。
 *
 * 约定：本文件用 `node --test tests/unit/tunnel-daemon.test.mjs` 单独跑，勿整批跑。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

import {
  parseDaemonArgv,
  isAlive,
  readJsonSafe,
  writePidfileAtomic,
  writeStateAtom,
  runDaemon,
} from '../../delivery/tunnel-daemon.mjs';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'winvm-daemon-'));
}

test('export 形态正确', () => {
  for (const fn of [parseDaemonArgv, isAlive, readJsonSafe, writePidfileAtomic, writeStateAtom, runDaemon]) {
    assert.equal(typeof fn, 'function', `${fn.name} 应为 function`);
  }
});

test('parseDaemonArgv 解析全部参数', () => {
  const o = parseDaemonArgv([
    '--vm-host', 'h', '--vm-user', 'u', '--vm-ssh-port', '2222',
    '--local-port', '9999', '--remote-port', '8888', '--key', '/k',
    '--pidfile', '/p/p.pid',
  ]);
  assert.equal(o.vmHost, 'h');
  assert.equal(o.vmUser, 'u');
  assert.equal(o.vmSshPort, 2222);
  assert.equal(o.localPort, 9999);
  assert.equal(o.remotePort, 8888);
  assert.equal(o.key, '/k');
  assert.equal(o.pidfile, '/p/p.pid');
});

test('parseDaemonArgv 默认值', () => {
  const o = parseDaemonArgv([]);
  assert.equal(o.vmSshPort, 22);
  assert.equal(o.localPort, 18443);
  assert.equal(o.remotePort, 18443);
  assert.equal(o.key, undefined);
  assert.ok(o.pidfile.endsWith('tunnel.pid'));
});

test('isAlive：自身 pid→true，非法/不存在→false', () => {
  assert.equal(isAlive(process.pid), true);
  assert.equal(isAlive(123456789), false); // 极大概率不存在
  assert.equal(isAlive(null), false);
  assert.equal(isAlive('x'), false);
  assert.equal(isAlive(undefined), false);
});

test('readJsonSafe：不存在/损坏→null，合法→对象', () => {
  const dir = tmpDir();
  try {
    assert.equal(readJsonSafe(join(dir, 'nope.json')), null);
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{not json');
    assert.equal(readJsonSafe(bad), null);
    const good = join(dir, 'good.json');
    writeFileSync(good, JSON.stringify({ a: 1 }));
    assert.deepEqual(readJsonSafe(good), { a: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writePidfileAtomic：原子写且无 .tmp 残留', () => {
  const dir = tmpDir();
  try {
    const pf = join(dir, 'sub', 'tunnel.pid');
    writePidfileAtomic(pf, { pid: 42, localPort: 18443 });
    assert.ok(existsSync(pf));
    assert.deepEqual(JSON.parse(readFileSync(pf, 'utf8')), { pid: 42, localPort: 18443 });
    // 不应留下 .tmp 中间文件
    const leftovers = readdirSync(dir).flatMap((d) => {
      const p = join(dir, d);
      return existsSync(p) && readdirSync(p).filter((f) => f.endsWith('.tmp'));
    });
    assert.equal(leftovers.length, 0, `存在 .tmp 残留：${leftovers.join(',')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeStateAtom：原子写状态心跳', () => {
  const dir = tmpDir();
  try {
    const sp = join(dir, 'tunnel.state.json');
    writeStateAtom(sp, 'RUNNING', 'ready', true, 42);
    const obj = JSON.parse(readFileSync(sp, 'utf8'));
    assert.equal(obj.state, 'RUNNING');
    assert.equal(obj.lastEvent, 'ready');
    assert.equal(obj.alive, true);
    assert.equal(obj.pid, 42);
    assert.ok(obj.updatedAt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runDaemon 幂等：已有存活 pidfile → 返回 0 且不构造隧道', async () => {
  const dir = tmpDir();
  try {
    const pf = join(dir, 'tunnel.pid');
    writePidfileAtomic(pf, { pid: process.pid, localPort: 18443 }); // 自身 pid → 存活
    let constructed = 0;
    class MockTunnel extends EventEmitter {
      constructor() { super(); constructed++; }
      async start() {}
      async stop() {}
    }
    const code = await runDaemon(
      ['--pidfile', pf, '--vm-host', 'h', '--vm-user', 'u', '--local-port', '0', '--remote-port', '18443'],
      { loadSsh2Client: async () => function C() {}, OhSshTunnel: MockTunnel, logPath: join(dir, 'tunnel.log') },
    );
    assert.equal(code, 0);
    assert.equal(constructed, 0, '幂等路径不应构造隧道实例');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runDaemon 失败：ssh2 解析失败 → 返回 1、pidfile 不落盘、错误入日志', async () => {
  const dir = tmpDir();
  try {
    const pf = join(dir, 'tunnel.pid');
    const log = join(dir, 'tunnel.log');
    const code = await runDaemon(
      ['--pidfile', pf, '--vm-host', 'h', '--vm-user', 'u', '--local-port', '0', '--remote-port', '18443'],
      {
        loadSsh2Client: async () => { throw new Error('FAKE_SSH2_MISSING'); },
        OhSshTunnel: class extends EventEmitter { async start() {} async stop() {} },
        logPath: log,
      },
    );
    assert.equal(code, 1);
    assert.equal(existsSync(pf), false, '失败路径不应写 pidfile');
    assert.ok(existsSync(log), '错误应写入日志');
    assert.match(readFileSync(log, 'utf8'), /FAKE_SSH2_MISSING/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('安全哨兵：password 透传隧道但 pidfile/日志绝不含量据明文', async () => {
  const dir = tmpDir();
  const SECRET = 'TOPSECRET_PW_9F3A2B';
  const prev = process.env['WINVM_VM_PASSWORD'];
  try {
    process.env['WINVM_VM_PASSWORD'] = SECRET;
    const pf = join(dir, 'tunnel.pid');
    const log = join(dir, 'tunnel.log');
    let capturedOpts = null;
    class MockTunnel extends EventEmitter {
      constructor(opts) { super(); capturedOpts = opts; }
      async start() { this.emit('ready'); return; }
      async stop() {}
    }
    const code = await runDaemon(
      ['--pidfile', pf, '--vm-host', 'h', '--vm-user', 'u', '--local-port', '0', '--remote-port', '18443'],
      { loadSsh2Client: async () => function C() {}, OhSshTunnel: MockTunnel, logPath: log },
    );
    assert.equal(code, 0);
    // 凭据已被透传给隧道（证明走了正常通路）
    assert.ok(capturedOpts, '隧道应被构造');
    assert.equal(capturedOpts.password, SECRET);
    // 但 pidfile 与日志绝不含凭据明文
    assert.ok(existsSync(pf), 'pidfile 应已创建');
    const pidText = readFileSync(pf, 'utf8');
    assert.doesNotMatch(pidText, new RegExp(SECRET));
    assert.doesNotMatch(pidText, /password|privateKey/i);
    const logText = existsSync(log) ? readFileSync(log, 'utf8') : '';
    assert.doesNotMatch(logText, new RegExp(SECRET));
  } finally {
    if (prev === undefined) delete process.env['WINVM_VM_PASSWORD'];
    else process.env['WINVM_VM_PASSWORD'] = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

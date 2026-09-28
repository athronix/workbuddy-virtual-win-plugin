#!/usr/bin/env node
/**
 * T05 · delivery/oh-tunnel.mjs 单测（无网沙箱，全程 mock ssh2 注入）。
 *
 * 覆盖：
 *  - 导出形态：OhSshTunnel / establishSsh2Tunnel 均为 function；
 *  - 配置校验（必须 reject）：缺 vmHost / localBindPort 非数字 / localBindHost 非回环 /
 *    缺 username / remotePort 非法；
 *  - 生命周期：start→handle、pid===undefined、localPort/baseUrl 回环、alive、端口监听、
 *    stop→alive=false/exited()=true/端口释放；
 *  - 幂等：start 两次 / stop 两次不抛错；
 *  - 重连：ready 后收到 close（非主动 stop）在退避窗口内至少重连一次，且不死循环；
 *  - 安全：hostVerifier 被调用；privateKey/password 不进入任何 console 输出；
 *  - 转发连通性（加分）：本地连接触发 forwardOut 且两端 pipe 建立、fake stream 收到数据。
 *
 * 约定：本文件用 `node --test tests/unit/oh-tunnel.test.mjs` 单独跑，勿整批跑。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';

import { OhSshTunnel, establishSsh2Tunnel } from '../../delivery/oh-tunnel.mjs';

/* ----------------------------- 测试辅助 ----------------------------- */

/** 从 OS 申请一个当前空闲的本地端口（避免并发/固定端口冲突）。 */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

/** 轮询谓词直到为真或超时（用于等待异步重连 / forwardOut 触发）。 */
function waitFor(pred, timeoutMs, intervalMs = 25) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      let ok = false;
      try {
        ok = pred();
      } catch {
        ok = false;
      }
      if (ok) return resolve(true);
      if (Date.now() - start >= timeoutMs) return reject(new Error('waitFor 超时'));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

/** 探测本地端口是否可连（用于验证「监听中」与「已释放」）。 */
function canConnect(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const s = net.connect(port, host);
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      s.destroy();
      resolve(v);
    };
    s.setTimeout(timeoutMs, () => finish(false));
    s.once('connect', () => finish(true));
    s.once('error', () => finish(false));
  });
}

/** 安装 console spy，返回 restore()。captured 收集所有输出文本。 */
function installConsoleSpy(captured) {
  const methods = ['log', 'error', 'warn', 'info', 'debug'];
  const orig = {};
  for (const m of methods) {
    orig[m] = console[m];
    console[m] = (...args) => {
      captured.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
    };
  }
  return () => {
    for (const m of methods) console[m] = orig[m];
  };
}

/**
 * 构造一个 mock 的 ssh2 Client 类（依赖注入用），并暴露共享 state 计数器。
 * - connect()：记录 hostVerifier 调用、异步 emit 'ready'；
 * - forwardOut()：返回可读写 PassThrough（fake stream），记录调用；
 * - end()：异步 emit 'close'（模拟对端断线 / 主动断开）。
 */
function makeMockClientClass() {
  const state = {
    connectCount: 0,
    forwardOutCalls: 0,
    hostVerifierCalls: 0,
    instances: [],
    lastInstance: null,
    lastStream: null,
    lastForwardArgs: null,
    lastKey: null,
  };
  class MockClient extends EventEmitter {
    constructor() {
      super();
      state.instances.push(this);
      state.lastInstance = this;
      this._connectOpts = null;
    }
    connect(opts) {
      state.connectCount += 1;
      this._connectOpts = opts;
      if (typeof opts.hostVerifier === 'function') {
        state.hostVerifierCalls += 1;
        state.lastKey = Buffer.from('mock-host-key');
        opts.hostVerifier(state.lastKey, () => {});
      }
      setImmediate(() => this.emit('ready'));
    }
    forwardOut(lh, lp, rh, rp, cb) {
      state.forwardOutCalls += 1;
      state.lastForwardArgs = { lh, lp, rh, rp };
      const stream = new PassThrough();
      state.lastStream = stream;
      cb(null, stream);
      return stream;
    }
    end() {
      setImmediate(() => this.emit('close'));
    }
  }
  return { MockClient, state };
}

/** 构造一个带合法默认配置 + 注入 mock 的隧道（每次取新空闲端口）。 */
async function makeTunnel(overrides = {}) {
  const { MockClient, state } = makeMockClientClass();
  const port = await getFreePort();
  const opts = {
    vmHost: '172.16.100.2',
    vmSshPort: 22,
    username: 'root',
    localBindHost: '127.0.0.1',
    localBindPort: port,
    remoteHost: '127.0.0.1',
    remotePort: 22,
    password: 'test-password',
    ssh2Client: MockClient,
    hostVerifier: () => {},
    readyTimeoutMs: 3000,
    ...overrides,
  };
  const tunnel = new OhSshTunnel(opts);
  return { tunnel, state, port, opts };
}

/* ----------------------------- 导出形态 ----------------------------- */

test('导出形态：OhSshTunnel 与 establishSsh2Tunnel 均为 function', () => {
  assert.equal(typeof OhSshTunnel, 'function', 'OhSshTunnel 应为 class/function');
  assert.equal(typeof establishSsh2Tunnel, 'function', 'establishSsh2Tunnel 应为 function');
});

/* ----------------------------- 配置校验 ----------------------------- */

test('配置校验：缺 vmHost 应 reject', () => {
  assert.throws(
    () => new OhSshTunnel({ localBindHost: '127.0.0.1', localBindPort: 12345, remotePort: 22, username: 'root', password: 'x' }),
    /vmHost/,
  );
});

test('配置校验：localBindPort 非数字应 reject', () => {
  assert.throws(
    () => new OhSshTunnel({ vmHost: 'h', localBindHost: '127.0.0.1', localBindPort: 'abc', remotePort: 22, username: 'root', password: 'x' }),
    /localBindPort/,
  );
});

test('配置校验：localBindHost 非回环（0.0.0.0）应 reject', () => {
  assert.throws(
    () => new OhSshTunnel({ vmHost: 'h', localBindHost: '0.0.0.0', localBindPort: 12345, remotePort: 22, username: 'root', password: 'x' }),
    /回环/,
  );
});

test('配置校验：localBindHost 公网 IP 应 reject', () => {
  assert.throws(
    () => new OhSshTunnel({ vmHost: 'h', localBindHost: '8.8.8.8', localBindPort: 12345, remotePort: 22, username: 'root', password: 'x' }),
    /回环/,
  );
});

test('配置校验：缺 username 应 reject', () => {
  assert.throws(
    () => new OhSshTunnel({ vmHost: 'h', localBindHost: '127.0.0.1', localBindPort: 12345, remotePort: 22, password: 'x' }),
    /username/,
  );
});

test('配置校验：remotePort 非法（0）应 reject', () => {
  assert.throws(
    () => new OhSshTunnel({ vmHost: 'h', localBindHost: '127.0.0.1', localBindPort: 12345, remotePort: 0, username: 'root', password: 'x' }),
    /remotePort/,
  );
});

test('配置校验：remotePort 非数字应 reject', () => {
  assert.throws(
    () => new OhSshTunnel({ vmHost: 'h', localBindHost: '127.0.0.1', localBindPort: 12345, remotePort: 'xx', username: 'root', password: 'x' }),
    /remotePort/,
  );
});

test('配置校验：合法配置可正常构造（不抛错）', () => {
  assert.doesNotThrow(() => {
    // 构造期不连接，仅做 normalizeOpts 校验
    new OhSshTunnel({ vmHost: 'h', localBindHost: '127.0.0.1', localBindPort: 12345, remotePort: 22, username: 'root', password: 'x' });
  });
});

/* ----------------------------- 生命周期 ----------------------------- */

test('生命周期：start 返回 handle，pid===undefined、baseUrl 回环、alive、端口监听', async () => {
  const { tunnel, port } = await makeTunnel();
  try {
    const handle = await tunnel.start();

    assert.equal(handle.pid, undefined, '进程内隧道 pid 应为 undefined');
    assert.equal(typeof handle.localPort, 'number');
    assert.ok(handle.localPort > 0, 'localPort 应为正端口');
    assert.ok(handle.baseUrl.startsWith('http://127.0.0.1:'), `baseUrl 应回环，实得 ${handle.baseUrl}`);
    assert.equal(tunnel.alive, true, 'start 后 alive 应为 true');
    assert.equal(handle.alive, true);

    // 本地端口确实在监听
    const ok = await canConnect('127.0.0.1', handle.localPort);
    assert.equal(ok, true, 'start 后本地端口应可连接（监听中）');
    assert.equal(handle.localPort, port, '监听端口应与分配端口一致');
  } finally {
    await tunnel.stop();
  }
});

test('生命周期：stop 后 alive=false、exited()=true、端口释放', async () => {
  const { tunnel } = await makeTunnel();
  const handle = await tunnel.start();
  await tunnel.stop();

  assert.equal(tunnel.alive, false, 'stop 后 alive 应为 false');
  assert.equal(handle.exited(), true, 'stop 后 exited() 应为 true');
  assert.equal(handle.alive, false);

  const stillOpen = await canConnect('127.0.0.1', handle.localPort);
  assert.equal(stillOpen, false, 'stop 后本地端口应已释放（不可连接）');
});

/* ----------------------------- 幂等 ----------------------------- */

test('幂等：start 两次返回同一 handle 且只建立一次连接', async () => {
  const { tunnel, state } = await makeTunnel();
  try {
    const h1 = await tunnel.start();
    const h2 = await tunnel.start();
    assert.equal(h1.localPort, h2.localPort, '两次 start 应返回同一端口');
    assert.equal(h1.pid, h2.pid);
    assert.equal(state.connectCount, 1, '重复 start 不应重复连接（connect 仅一次）');
    assert.equal(tunnel.alive, true);
  } finally {
    await tunnel.stop();
  }
});

test('幂等：stop 两次不抛错', async () => {
  const { tunnel } = await makeTunnel();
  const handle = await tunnel.start();
  await tunnel.stop();
  assert.equal(tunnel.alive, false);
  assert.equal(handle.exited(), true);
  // 第二次 stop 不应抛错
  await tunnel.stop();
  assert.equal(handle.exited(), true);
});

/* ----------------------------- 重连 ----------------------------- */

test('重连：ready 后收到 close（非主动 stop）在退避窗口内至少重连一次，且不死循环', async () => {
  const { tunnel, state } = await makeTunnel();
  try {
    await tunnel.start();
    assert.equal(state.connectCount, 1, 'start 后应已连接一次');

    // 模拟对端断线（非主动 stop）：触发 close
    state.lastInstance.end();

    // 退避窗口内（base 1s，jitter≤30%）应发生至少一次重连
    await waitFor(() => state.connectCount >= 2, 5000);
    assert.ok(state.connectCount >= 2, 'close 后应触发重连');

    // 确认不死循环：再等一段时间，无新 close 则连接数应保持（≤2）
    await new Promise((r) => setTimeout(r, 2000));
    assert.ok(state.connectCount <= 2, `不应无限重连（当前 connectCount=${state.connectCount}）`);
  } finally {
    await tunnel.stop();
  }
});

test('重连：主动 stop 触发的 close 不应引发重连', async () => {
  const { tunnel, state } = await makeTunnel();
  await tunnel.start();
  assert.equal(state.connectCount, 1);
  await tunnel.stop();
  // stop 后等待超过一次退避窗口，确认没有额外 connect
  await new Promise((r) => setTimeout(r, 2000));
  assert.equal(state.connectCount, 1, '主动 stop 不应触发重连');
});

/* ----------------------------- 安全 ----------------------------- */

test('安全：hostVerifier 被调用（传入 key 与 verify 回调）', async () => {
  let hvCalls = 0;
  let hvKey = null;
  let hvVerify = null;
  const hostVerifier = (key, verify) => {
    hvCalls += 1;
    hvKey = key;
    hvVerify = verify;
  };
  const { tunnel, state } = await makeTunnel({ hostVerifier });
  try {
    await tunnel.start();
    assert.ok(state.hostVerifierCalls >= 1, 'mock 应在 connect 时调用 hostVerifier');
    assert.ok(hvCalls >= 1, '传入的 hostVerifier 应被调用');
    assert.ok(Buffer.isBuffer(hvKey), 'hostVerifier 第一个参数应为 key Buffer');
    assert.equal(typeof hvVerify, 'function', 'hostVerifier 第二个参数应为 verify 回调');
  } finally {
    await tunnel.stop();
  }
});

test('安全：privateKey/password 不进入任何 console 输出', async () => {
  const secret = 'SUPER_SECRET_PASSWORD_xyz';
  const captured = [];
  const restore = installConsoleSpy(captured);
  try {
    const { tunnel } = await makeTunnel({ password: secret });
    const handle = await tunnel.start();
    // 触发一次转发路径，确保 connectOpts 构造也被覆盖
    const sock = net.connect(handle.localPort, '127.0.0.1');
    await once(sock, 'connect').catch(() => {});
    sock.destroy();
    await tunnel.stop();
  } finally {
    restore();
  }
  const leaked = captured.some((s) => s.includes(secret));
  assert.equal(leaked, false, `凭据不应泄漏到日志，实测输出：${captured.join(' | ') || '(空)'}`);
});

test('安全哨兵（强化）：password + privateKey 不进入 console 也不进入原始 stdout/stderr 流', async () => {
  const secretPw = 'SUPER_SECRET_PASSWORD_ABC123';
  const secretKey = '-----BEGIN FAKE PRIVATE KEY-----\nMOCKKEY\n-----END FAKE PRIVATE KEY-----';
  const captured = [];
  const origStdout = process.stdout.write;
  const origStderr = process.stderr.write;
  const origConsole = {};
  const consoleMethods = ['log', 'info', 'warn', 'error', 'debug'];
  const restore = installConsoleSpy(captured);
  process.stdout.write = ((chunk) => { captured.push(String(chunk)); return true; });
  process.stderr.write = ((chunk) => { captured.push(String(chunk)); return true; });
  for (const m of consoleMethods) { origConsole[m] = console[m]; }
  try {
    const { tunnel } = await makeTunnel({ password: secretPw, privateKey: secretKey });
    const handle = await tunnel.start();
    const sock = net.connect(handle.localPort, '127.0.0.1');
    await once(sock, 'connect').catch(() => {});
    sock.destroy();
    await tunnel.stop();
  } finally {
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
    restore();
  }
  const leaked = captured.some((s) => s.includes(secretPw) || s.includes(secretKey));
  assert.equal(leaked, false, `password/privateKey 不应泄漏到任何输出流，实测：${captured.join(' | ').slice(0, 300) || '(空)'}`);
});

/* ----------------------------- 转发连通性（加分） ----------------------------- */

test('转发连通性：本地连接触发 forwardOut 且两端 pipe 建立、fake stream 收到数据', async () => {
  const { tunnel, state } = await makeTunnel({ remotePort: 22 });
  try {
    const handle = await tunnel.start();
    assert.equal(state.forwardOutCalls, 0, '尚无本地连接时不应调用 forwardOut');

    const sock = net.connect(handle.localPort, '127.0.0.1');
    await once(sock, 'connect');

    // 等待 forwardOut 被调用
    await waitFor(() => state.forwardOutCalls >= 1, 2000);
    assert.ok(state.forwardOutCalls >= 1, '本地连接应触发 forwardOut');

    const stream = state.lastStream;
    assert.ok(stream, '应已创建远端 fake stream');
    assert.equal(state.lastForwardArgs.rh, '127.0.0.1', 'forwardOut remoteHost 应为 127.0.0.1');
    assert.equal(state.lastForwardArgs.rp, 22, 'forwardOut remotePort 应为 22');

    const received = new Promise((res, rej) => {
      stream.once('data', (d) => res(d));
      sock.once('error', rej);
    });
    sock.write(Buffer.from('HELLO'));
    const data = await received;
    assert.equal(data.toString(), 'HELLO', 'fake stream 应通过 pipe 收到本地写入的数据');

    sock.destroy();
  } finally {
    await tunnel.stop();
  }
});

/* ----------------------------- 便捷封装 ----------------------------- */

test('establishSsh2Tunnel 便捷封装：返回同构 handle', async () => {
  const { MockClient, state } = makeMockClientClass();
  const port = await getFreePort();
  const handle = await establishSsh2Tunnel({
    vmHost: '172.16.100.2',
    vmSshPort: 22,
    username: 'root',
    localBindHost: '127.0.0.1',
    localBindPort: port,
    remoteHost: '127.0.0.1',
    remotePort: 22,
    password: 'test-password',
    ssh2Client: MockClient,
    hostVerifier: () => {},
    readyTimeoutMs: 3000,
  });
  assert.equal(handle.pid, undefined);
  assert.ok(handle.baseUrl.startsWith('http://127.0.0.1:'));
  assert.ok(handle.localPort > 0);
  assert.equal(state.connectCount, 1);
  await handle.stop();
  assert.equal(handle.exited(), true);
});

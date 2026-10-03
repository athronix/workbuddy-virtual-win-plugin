#!/usr/bin/env node
/**
 * 隧道崩溃故障注入探针（delivery/__tests__ 自建，不触碰 QA 独占的 tests/**）。
 *
 * 用途：在**独立子进程**里复「单次 ssh 通道错误 → 隧道进程整进程崩溃」的缺陷，
 * 使 before/after 对照可以在进程级别取证（崩溃必然导致子进程的退出码与 stderr 变化，
 * 无法被「同一进程内 try/catch 已处理」的假象掩盖）。
 *
 * 设计约束：
 *  - 探针本身**不做断言**，只观测并汇报，便于同一份探针跑修复前后两种代码；
 *  - 注入全部走依赖注入（opts.ssh2Client），因此不需要真实 ssh2、不需要真实 VM 网络；
 *  - 仅在「no-listener」场景刻意**不注册 'error' 监听**，精确复刻
 *    delivery/tunnel-daemon.mjs 的真实接线（只注册 ready/close/reconnecting/reconnected）。
 *
 * 用法：
 *   node delivery/__tests__/probe-tunnel-error.mjs --scenario=forward-out-error-no-listener
 *   node delivery/__tests__/probe-tunnel-error.mjs --scenario=client-error-no-listener
 *   node delivery/__tests__/probe-tunnel-error.mjs --scenario=forward-out-error-with-listener
 *
 * 输出：
 *   PROBE_EVENT <json>   过程事件（每次一行）
 *   PROBE_RESULT <json>  最终结论；若进程在打印前崩溃 ⇒ 即为「崩了」的硬证据
 */

import { EventEmitter } from 'node:events';
import net from 'node:net';

import { OhSshTunnel } from '../oh-tunnel.mjs';

/** 复刻主理人取证栈中的真实错误信息。 */
const SIM_ERR_MSG = 'No response from server';

/** 观测窗口（crash 若发生会远早于此）。 */
const DEFAULT_OBSERVE_MS = 3_000;

const SCENARIOS = {
  // 关键场景：forwardOut 通道打开失败（onChannelOpenFailure）+ 上层未注册 'error' 监听
  'forward-out-error-no-listener': { inject: 'forwardOutError', withErrorListener: false },
  // 连接层错误场景：ready 之后 ssh2 Client emit('error')（keepalive 超时 / socket 断开）
  'client-error-no-listener': { inject: 'clientError', withErrorListener: false },
  // 对照场景：上层注册了 'error' 监听时本就不崩，用于证明崩溃根因是「无监听」
  'forward-out-error-with-listener': { inject: 'forwardOutError', withErrorListener: true },
};

/* ----------------------------- 参数解析 ----------------------------- */

export function parseProbeArgv(argv) {
  const o = { scenario: 'forward-out-error-no-listener', observeMs: DEFAULT_OBSERVE_MS, port: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--scenario') o.scenario = argv[++i];
    else if (a.startsWith('--scenario=')) o.scenario = a.slice('--scenario='.length);
    else if (a === '--observe-ms') o.observeMs = Number(argv[++i]);
    else if (a.startsWith('--observe-ms=')) o.observeMs = Number(a.slice('--observe-ms='.length));
    else if (a === '--port') o.port = Number(argv[++i]);
    else if (a.startsWith('--port=')) o.port = Number(a.slice('--port='.length));
  }
  return o;
}

/* ----------------------------- 工具 ----------------------------- */

function emit(obj) {
  process.stdout.write(`PROBE_EVENT ${JSON.stringify(obj)}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 申请空闲本地端口（回环）。 */
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

/**
 * mock ssh2 Client（依赖注入用）。
 * @param {object} state 共享计数器
 * @param {'forwardOutError'|'clientError'|'none'} injectKind 故障注入类型
 */
function makeMockClientClass(state, injectKind) {
  class MockClient extends EventEmitter {
    constructor() {
      super();
      state.instances.push(this);
      state.lastInstance = this;
    }

    connect(opts) {
      state.connectCount += 1;
      if (typeof opts?.hostVerifier === 'function') {
        state.hostVerifierCalls += 1;
        opts.hostVerifier(Buffer.from('mock-host-key'), () => {});
      }
      setImmediate(() => this.emit('ready'));
    }

    forwardOut(localHost, localPort, remoteHost, remotePort, cb) {
      state.forwardOutCalls += 1;
      if (injectKind === 'forwardOutError') {
        // 复刻 onChannelOpenFailure：ssh2 以 (err) 回调通道打开失败
        setImmediate(() => cb(new Error(SIM_ERR_MSG)));
        return undefined;
      }
      throw new Error(`未预期的 forwardOut 调用（injectKind=${injectKind}）`);
    }

    end() {
      setImmediate(() => this.emit('close'));
    }
  }
  return MockClient;
}

/* ----------------------------- 主流程 ----------------------------- */

/**
 * 执行一次故障注入，返回观测结论。
 * @param {{scenario:string, observeMs:number, port:number}} o 已解析参数
 * @returns {Promise<object>} 观测结论
 */
export async function runProbe(o) {
  const scenario = SCENARIOS[o.scenario];
  if (!scenario) {
    throw new Error(
      `未知 scenario：${o.scenario}；可选：${Object.keys(SCENARIOS).join(' | ')}`,
    );
  }

  const state = {
    instances: [],
    lastInstance: null,
    connectCount: 0,
    forwardOutCalls: 0,
    hostVerifierCalls: 0,
  };

  const port = o.port || (await getFreePort());
  const tunnel = new OhSshTunnel({
    vmHost: '172.16.100.2',
    vmSshPort: 22,
    username: 'User',
    localBindHost: '127.0.0.1',
    localBindPort: port,
    remoteHost: '127.0.0.1',
    remotePort: 18443,
    password: 'probe-password',
    ssh2Client: makeMockClientClass(state, scenario.inject),
    hostVerifier: () => {},
    readyTimeoutMs: 3_000,
    maxAttempts: 3,
  });

  const observed = {
    readyCount: 0,
    reconnectingCount: 0,
    reconnectedCount: 0,
    closeCount: 0,
    tunnelErrorEvents: [],
    giveupEvents: [],
  };

  // 注意：此处刻意**不注册 'error' 监听**（withErrorListener=false 时），与真实 daemon 接线一致。
  if (scenario.withErrorListener) {
    tunnel.on('error', (err) => {
      observed.tunnelErrorEvents.push(describeErr(err));
      emit({ kind: 'tunnel-error', message: describeErr(err) });
    });
  }
  tunnel.on('ready', () => {
    observed.readyCount += 1;
    emit({ kind: 'ready', count: observed.readyCount, connectCount: state.connectCount });
  });
  tunnel.on('close', () => {
    observed.closeCount += 1;
    emit({ kind: 'close', count: observed.closeCount });
  });
  tunnel.on('reconnecting', (payload) => {
    observed.reconnectingCount += 1;
    emit({ kind: 'reconnecting', attempt: payload?.attempt, delayMs: payload?.delayMs });
  });
  tunnel.on('reconnected', (payload) => {
    observed.reconnectedCount += 1;
    emit({ kind: 'reconnected', attempt: payload?.attempt });
  });
  tunnel.on('giveup', (payload) => {
    observed.giveupEvents.push(describeErr(payload?.reason ?? payload));
    emit({ kind: 'giveup', reason: describeErr(payload?.reason ?? payload) });
  });

  await tunnel.start();
  emit({ kind: 'started', port: tunnel.localPort, alive: tunnel.alive });

  // 注入故障：
  if (scenario.inject === 'forwardOutError') {
    // 本地连一条 TCP ⇒ _onLocalConnection ⇒ forwardOut ⇒ cb(err) ⇒ 原缺陷点 oh-tunnel.mjs:414
    const sock = net.connect(tunnel.localPort, '127.0.0.1');
    sock.on('error', () => {});
    await new Promise((resolve) => {
      sock.once('connect', resolve);
      sock.once('error', resolve);
    });
    emit({ kind: 'local-connection-opened' });
  } else if (scenario.inject === 'clientError') {
    // ready 之后连接层错误（keepalive 超时 / socket 断开），非单条通道错误
    state.lastInstance.emit('error', new Error(SIM_ERR_MSG));
    emit({ kind: 'client-error-emitted' });
  }

  // 观测窗口：若期间发生 unhandled 'error' ⇒ 进程在此之前就已退出
  await sleep(o.observeMs);

  const result = {
    scenario: o.scenario,
    observeMs: o.observeMs,
    survived: true,
    connectCount: state.connectCount,
    forwardOutCalls: state.forwardOutCalls,
    readyCount: observed.readyCount,
    closeCount: observed.closeCount,
    reconnectingCount: observed.reconnectingCount,
    reconnectedCount: observed.reconnectedCount,
    tunnelErrorEvents: observed.tunnelErrorEvents,
    giveupEvents: observed.giveupEvents,
    aliveAtEnd: tunnel.alive,
    localPortAtEnd: tunnel.localPort,
  };

  // 有序收尾：stop 必须也不得因注入过 error 而二次崩溃
  await tunnel.stop();
  result.stoppedCleanly = true;

  return result;
}

/** 统一错误信息提取。 */
function describeErr(err) {
  if (err instanceof Error) return err.message;
  if (err == null) return '(null)';
  return String(err);
}

/* ----------------------------- CLI 入口 ----------------------------- */

const invokedDirectly =
  process.argv[1] && process.argv[1].endsWith('probe-tunnel-error.mjs');

if (invokedDirectly) {
  const o = parseProbeArgv(process.argv.slice(2));
  try {
    const result = await runProbe(o);
    process.stdout.write(`PROBE_RESULT ${JSON.stringify(result)}\n`);
    process.exit(0);
  } catch (e) {
    process.stdout.write(`PROBE_ERROR ${e?.stack || e?.message || String(e)}\n`);
    process.exit(2);
  }
}

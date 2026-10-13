#!/usr/bin/env node
/**
 * 守护进程级故障注入探针（delivery/__tests__ 自建，不触碰 QA 独占的 tests/**）。
 *
 * 与 probe-tunnel-error.mjs（隧道类层）互补：本探针走 **runDaemon()**，验证的是
 * 「隧道出错 → 守护进程是否把原因写进 state 文件、是否仍存活」这一整条链路。
 *
 * 注入方式：全部走 runDaemon 的 deps 注入点
 *  ({ loadSsh2Client, OhSshTunnel, logPath })，不依赖真实 ssh2 / 真实 VM 网络。
 *
 * 用法：
 *   node delivery/__tests__/probe-daemon-error.mjs --inject=forward-out-error
 *   node delivery/__tests__/probe-daemon-error.mjs --inject=client-error
 *
 * 输出：
 *   PROBE_EVENT <json>
 *   PROBE_RESULT <json>
 */

import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import net from 'node:net';

import { runDaemon } from '../tunnel-daemon.mjs';

const SIM_ERR_MSG = 'No response from server';
const DEFAULT_OBSERVE_MS = 3_000;

/**
 * 取一个即时空闲端口（listen :0 → 读口 → 关掉）。
 * 历史病灶：本探针曾**硬编码 18443**，与常驻隧道 daemon（真机常态占用）端口冲突 ⇒
 * 环境性假红（EADDRINUSE 时新码走启动退避（state=DEGRADED+startAttempt），旧码 shutdown→exit(0) 删文件，
 * 两种失败形态都过不了"RUNNING+pidfile 在位"断言）。端口自分配后判活与 daemon 在位与否解耦。
 * 竞态说明：close→runDaemon 重新 bind 之间存在理论争用窗口（单机开发环境概率极低）。
 * @returns {Promise<number>}
 */
async function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

const INJECTS = {
  'forward-out-error': 'forwardOutError',
  'client-error': 'clientError',
  none: 'none',
};

/* ----------------------------- 参数解析 ----------------------------- */

export function parseProbeArgv(argv) {
  const o = { inject: 'forward-out-error', observeMs: DEFAULT_OBSERVE_MS };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--inject') o.inject = argv[++i];
    else if (a.startsWith('--inject=')) o.inject = a.slice('--inject='.length);
    else if (a === '--observe-ms') o.observeMs = Number(argv[++i]);
    else if (a.startsWith('--observe-ms=')) o.observeMs = Number(a.slice('--observe-ms='.length));
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

/** 创建隔离工作目录（pidfile / state / log 全部落在 tmp，绝不污染 ~/.workbuddy/winvm 真实实例）。 */
function makeWorkDir() {
  const base = mkdtempSync(join(tmpdir(), 'winvm-daemon-probe-'));
  return base;
}

/** 读取 state 文件（不存在返回 null；解析失败返回 {_raw:...}）。 */
function readState(statePath) {
  if (!existsSync(statePath)) return null;
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'));
  } catch (e) {
    return { _parseError: e?.message ?? String(e) };
  }
}

/**
 * 构造注入用的 mock：ssh2 Client + OhSshTunnel 子类。
 * OhSshTunnel 子类在 ready 之后由探针主动打入故障。
 */
function makeDeps(injectKind) {
  const state = { connectCount: 0, forwardOutCalls: 0, lastClient: null, lastTunnel: null };

  class MockClient extends EventEmitter {
    constructor() {
      super();
      state.lastClient = this;
    }

    connect(opts) {
      state.connectCount += 1;
      if (typeof opts?.hostVerifier === 'function') {
        opts.hostVerifier(Buffer.from('mock-host-key'), () => {});
      }
      setImmediate(() => this.emit('ready'));
      return undefined;
    }

    forwardOut(_lh, _lp, _rh, _rp, cb) {
      state.forwardOutCalls += 1;
      if (injectKind === 'forwardOutError') {
        setImmediate(() => cb(new Error(SIM_ERR_MSG)));
        return undefined;
      }
      throw new Error(`未预期的 forwardOut 调用（injectKind=${injectKind}）`);
    }

    end() {
      setImmediate(() => this.emit('close'));
      return undefined;
    }
  }

  const loadSsh2Client = async () => MockClient;

  return { deps: { loadSsh2Client }, state };
}

/* ----------------------------- 主流程 ----------------------------- */

/**
 * 执行守护进程级故障注入。
 * @param {{inject:string, observeMs:number}} o 已解析参数
 * @returns {Promise<object>} 观测结论
 */
export async function runProbe(o) {
  const injectKind = INJECTS[o.inject];
  if (!injectKind) {
    throw new Error(`未知 inject：${o.inject}；可选：${Object.keys(INJECTS).join(' | ')}`);
  }

  const workDir = makeWorkDir();
  const pidfile = join(workDir, 'tunnel.pid');
  const statePath = `${pidfile}.state.json`; // D6-A：非默认 pidfile ⇒ 旁路 state
  const logPath = join(workDir, 'tunnel.log');

  const { deps, state } = makeDeps(injectKind);

  // 动态空闲端口（解耦真机 daemon 对 18443 的常态占用；见 getFreePort 头注）。
  const localPort = await getFreePort();
  const argv = [
    '--vm-host', '172.16.100.2',
    '--vm-user', 'User',
    // 不传 --key：改用环境变量 WINVM_VM_PASSWORD 走通启动路径（凭据仅经 env 传入）。
    '--local-port', String(localPort),
    '--remote-port', String(localPort),
    '--pidfile', pidfile,
  ];

  // key 文件不存在会导致 return 1；改用环境变量密码走通启动路径
  process.env['WINVM_VM_PASSWORD'] = 'probe-password';

  const runPromise = runDaemon(argv, { ...deps, logPath });

  // runDaemon 内部会 resolve(0) 并保持存活；这里不 await 完，先等一小段让隧道进入 RUNNING
  await sleep(600);
  const code = await Promise.race([
    runPromise,
    sleep(300).then(() => 'PENDING'),
  ]);
  emit({ kind: 'daemon-start', exitSignal: String(code), connectCount: state.connectCount });

  const stateAfterStart = readState(statePath);
  emit({ kind: 'state-after-start', state: stateAfterStart });

  // 注入故障
  if (injectKind === 'clientError' && state.lastClient) {
    state.lastClient.emit('error', new Error(SIM_ERR_MSG));
    emit({ kind: 'client-error-emitted' });
  } else if (injectKind === 'forwardOutError') {
    // 由 OhSshTunnel 内部持有 client；通过反射拿到最后一个 client 实例触发
    const net = await import('node:net');
    const sock = net.connect(localPort, '127.0.0.1');
    sock.on('error', () => {});
    await new Promise((resolve) => {
      sock.once('connect', resolve);
      sock.once('error', resolve);
    });
    emit({ kind: 'local-connection-opened', forwardOutCalls: state.forwardOutCalls });
  }

  await sleep(o.observeMs);

  const stateAfterInject = readState(statePath);
  emit({ kind: 'state-after-inject', state: stateAfterInject });

  const result = {
    inject: o.inject,
    observeMs: o.observeMs,
    workDir,
    survived: true,
    connectCount: state.connectCount,
    forwardOutCalls: state.forwardOutCalls,
    stateAfterStart,
    stateAfterInject,
    pidfileExistedAtEnd: existsSync(pidfile),
    stateExistedAtEnd: existsSync(statePath),
    logTail: readLogTail(logPath),
  };
  return result;
}

/** 读取日志尾部若干行（避免日志过大）。 */
function readLogTail(logPath, maxLines = 40) {
  if (!existsSync(logPath)) return null;
  try {
    const lines = readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-maxLines);
  } catch (e) {
    return { _readError: e?.message ?? String(e) };
  }
}

/* ----------------------------- CLI 入口 ----------------------------- */

const invokedDirectly =
  process.argv[1] && process.argv[1].endsWith('probe-daemon-error.mjs');

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

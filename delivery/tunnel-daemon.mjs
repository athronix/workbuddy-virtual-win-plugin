#!/usr/bin/env node
/**
 * 常驻隧道守护进程（CL-015 T12 / P0-02）—— 内部组件，不对外暴露 CLI。
 *
 * 由 `install-host.mjs`（安装尾，仅 OH/ssh2 后端）或 `winvm-plugin tunnel start`
 * 以 `spawn(process.execPath, [...], { detached:true, stdio:'ignore' })` 拉起，父进程退出后
 * 自成进程组存活（reparent 到 init/pid1）。
 *
 * 职责：
 *  - 原子写 pidfile（tmp → rename），退出时删除；状态机心跳写 tunnel.state.json（STARTING/RUNNING/DEGRADED/STOPPING）。
 *  - 经 OhSshTunnel（进程内 ssh2 隧道）监听 127.0.0.1:<localPort>（仅回环），转发到 VM 127.0.0.1:<remotePort>。
 *  - 退避重连（复用 OhSshTunnel 既有逻辑）实现断线自愈；SSH 断线期间状态如实报 DEGRADED。
 *  - 凭据绝不进日志：password 仅经环境变量 WINVM_VM_PASSWORD 传入，privateKey 仅经 --key 文件读取。
 *
 * 返回码：就绪成功 0；启动失败 1（含缺 ssh2 → 打印三要素）。
 */

import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, renameSync, appendFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { OhSshTunnel } from './oh-tunnel.mjs';
import { loadSsh2Client } from './ssh2-resolve.mjs';

const LOG_PREFIX = '[winvm-tunnel]';

export function parseDaemonArgv(argv) {
  const o = {
    vmHost: '',
    vmUser: '',
    vmSshPort: 22,
    localPort: 18443,
    remotePort: 18443,
    key: undefined,
    pidfile: join(homedir(), '.workbuddy', 'winvm', 'tunnel.pid'),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--vm-host': o.vmHost = argv[++i]; break;
      case '--vm-user': o.vmUser = argv[++i]; break;
      case '--vm-ssh-port': o.vmSshPort = Number(argv[++i]); break;
      case '--local-port': o.localPort = Number(argv[++i]); break;
      case '--remote-port': o.remotePort = Number(argv[++i]); break;
      case '--key': o.key = argv[++i]; break;
      case '--pidfile': o.pidfile = argv[++i]; break;
      default: break;
    }
  }
  return o;
}

/** 进程是否存活（sig 0）。跨平台可用（POSIX + Windows 均支持 signal 0）。 */
export function isAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readJsonSafe(p) {
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** 原子写 pidfile（tmp → rename），避免读半截。 */
export function writePidfileAtomic(pidfile, obj) {
  mkdirSync(dirname(pidfile), { recursive: true });
  const tmp = `${pidfile}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  renameSync(tmp, pidfile);
}

/** 原子写状态心跳（同一 schema，便于 `tunnel status` 读取）。 */
export function writeStateAtom(statePath, state, lastEvent, alive, pid) {
  mkdirSync(dirname(statePath), { recursive: true });
  const tmp = `${statePath}.tmp`;
  writeFileSync(
    tmp,
    JSON.stringify({ state, lastEvent, alive, updatedAt: new Date().toISOString(), pid }, null, 2) + '\n',
    'utf8',
  );
  renameSync(tmp, statePath);
}

function logLine(logPath, level, msg) {
  const line = `${LOG_PREFIX} ${new Date().toISOString()} ${level} ${msg}\n`;
  try { appendFileSync(logPath, line); } catch { /* 日志不可写不致命 */ }
  try { process.stdout.write(line); } catch { /* ignore */ }
}

/**
 * 守护进程主入口（由 detached 子进程调用）。
 * @param {string[]} argv 命令行参数（不含 node/脚本名）
 * @param {object} [deps] 注入点（测试用）：{ loadSsh2Client, OhSshTunnel, logPath }
 * @returns {Promise<number>} 退出码
 */
export async function runDaemon(argv, deps = {}) {
  const o = parseDaemonArgv(argv);
  const homeDir = homedir();
  // D6-A：state 文件**随 pidfile 派生**，杜绝「带 --pidfile 的实例写进默认 state」的污染。
  // 默认 pidfile → 沿用历史默认 state 路径（由 pidfile 默认值同源派生，行为不变）；
  // 非默认 pidfile → 旁路 `<pidfile>.state.json`，绝不触碰默认 tunnel.state.json。
  const defaultPidfile = join(homeDir, '.workbuddy', 'winvm', 'tunnel.pid');
  const statePath = resolve(o.pidfile) === resolve(defaultPidfile)
    ? join(dirname(defaultPidfile), 'tunnel.state.json')
    : `${o.pidfile}.state.json`;
  const logPath = deps.logPath ?? join(homeDir, '.workbuddy', 'winvm', 'tunnel.log');
  const LoadSsh2 = deps.loadSsh2Client ?? loadSsh2Client;
  const Tunnel = deps.OhSshTunnel ?? OhSshTunnel;

  mkdirSync(dirname(o.pidfile), { recursive: true });

  // 幂等：已有 pidfile 且进程存活 → 不重复启动（B3/B8，不产生第二实例）。
  const prev = readJsonSafe(o.pidfile);
  if (prev?.pid && isAlive(prev.pid)) {
    logLine(logPath, 'WARN', `已有隧道进程 pid ${prev.pid}，不重复启动`);
    return 0;
  }
  if (existsSync(o.pidfile)) rmSync(o.pidfile, { force: true }); // 陈旧 pidfile 清理

  // 凭据：仅经环境变量/文件，绝不收命令行参数、绝不打印。
  const password = process.env['WINVM_VM_PASSWORD'] || null;
  let privateKey = null;
  if (o.key) {
    try {
      privateKey = readFileSync(o.key);
    } catch (e) {
      logLine(logPath, 'ERROR', `identityFile 读取失败：${e.message}`);
      return 1;
    }
  }

  let ssh2Client;
  try {
    ssh2Client = await LoadSsh2({ moduleUrl: import.meta.url });
  } catch (e) {
    logLine(logPath, 'ERROR', e.message); // 三要素引导（不含凭据）
    return 1;
  }

  writePidfileAtomic(o.pidfile, {
    pid: process.pid,
    localHost: '127.0.0.1',
    localPort: o.localPort,
    vmHost: o.vmHost,
    vmUser: o.vmUser,
    vmSshPort: o.vmSshPort,
    remotePort: o.remotePort,
    startedAt: new Date().toISOString(),
    schema: 1,
  });
  writeStateAtom(statePath, 'STARTING', 'starting', false, process.pid);

  let tunnel;
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    writeStateAtom(statePath, 'STOPPING', 'stopping', false, process.pid);
    try { await tunnel?.stop(); } catch { /* ignore */ }
    rmSync(o.pidfile, { force: true });
    rmSync(statePath, { force: true });
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('exit', () => { try { rmSync(o.pidfile, { force: true }); } catch { /* ignore */ } });

  try {
    tunnel = new Tunnel({
      vmHost: o.vmHost,
      vmSshPort: o.vmSshPort,
      username: o.vmUser,
      localBindHost: '127.0.0.1',
      localBindPort: o.localPort,
      remoteHost: '127.0.0.1',
      remotePort: o.remotePort,
      password,
      privateKey,
      ssh2Client,
      readyTimeoutMs: 15_000,
      keepaliveInterval: 30_000,
    });
    tunnel.on('ready', () => writeStateAtom(statePath, 'RUNNING', 'ready', true, process.pid));
    tunnel.on('close', () => writeStateAtom(statePath, 'DEGRADED', 'closed', false, process.pid));
    tunnel.on('reconnecting', () => writeStateAtom(statePath, 'DEGRADED', 'reconnecting', false, process.pid));
    tunnel.on('reconnected', () => writeStateAtom(statePath, 'RUNNING', 'reconnected', true, process.pid));
    await tunnel.start();
    logLine(logPath, 'INFO', `隧道已就绪：127.0.0.1:${o.localPort} → ${o.vmUser}@${o.vmHost}:${o.vmSshPort} → 127.0.0.1:${o.remotePort}`);
    return 0;
  } catch (e) {
    logLine(logPath, 'ERROR', `隧道启动失败：${e.message}`);
    await shutdown();
    return 1;
  }
}

// 仅当作为入口直接运行（非被 import）时启动。
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  // 关键修正（CL-019 隧道固化）：runDaemon 在 tunnel.start() ready 后立即 resolve(0)，
  // 但守护进程必须持续存活以承载本地转发 + 断线重连——故**成功路径不调用 process.exit**，
  // 仅靠 SIGINT/SIGTERM → shutdown() 收尾（shutdown 会清理 pidfile/tunnel.state.json 并退出）。
  // 额外加一个常驻保活 timer，防止 ssh2 连接引用被 unref 时事件循环空转退出。
  const keepAlive = setInterval(() => {}, 60_000);
  keepAlive.unref?.(); // 不阻止退出（shutdown 由信号驱动）；仅作保险，主保活来自 server/socket 引用
  runDaemon(process.argv.slice(2))
    .then(() => {
      /* 成功：保持存活，不主动退出 */
    })
    .catch((e) => {
      process.stderr.write(`${e?.stack || e?.message || String(e)}\n`);
      process.exit(1);
    });
}

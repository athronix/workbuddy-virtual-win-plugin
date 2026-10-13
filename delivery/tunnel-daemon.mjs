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
 *  - Q1（批2）：启动阶段（首连）失败**不再即退**，纳入同款指数退避重试
 *    （--start-retry N 设上限，默认无限）；giveup/启动放弃均保留
 *    state=STOPPED+reason 终态文件供诊断（不再"死无对证"）。日志行含 pid 前缀，
 *    pidfile 以 'wx' 独占创建防同毫秒双实例竞态。
 *
 * 返回码：就绪成功 0；已有实例（幂等）0；启动重试放弃 1；构造期参数错误 1（留 STOPPED 痕）。
 */

import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, renameSync, appendFileSync, openSync, closeSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { OhSshTunnel } from './oh-tunnel.mjs';
import { loadSsh2Client } from './ssh2-resolve.mjs';

const LOG_PREFIX = '[winvm-tunnel]';

/* ---- Q1（audit-qa ⑥）启动期退避重连参数：与 oh-tunnel 稳态退避同款公式 ----
 *   delay = min(START_MAX_DELAY_MS, START_BASE_DELAY_MS × 2^(attempt-1)) + rand×0.3×delay
 * 默认不限次数（VM 晚醒几分钟也必须自愈；2026-09-30 十条 EHOSTUNREACH 即"启动即退"病灶）。 */
const START_BASE_DELAY_MS = 1_000;
const START_MAX_DELAY_MS = 30_000;

export function parseDaemonArgv(argv) {
  const o = {
    vmHost: '',
    vmUser: '',
    vmSshPort: 22,
    localPort: 18443,
    remotePort: 18443,
    key: undefined,
    pidfile: join(homedir(), '.workbuddy', 'winvm', 'tunnel.pid'),
    // Q1：启动期首连失败的重试上限；Infinity=永不放弃（默认，与稳态重连 maxAttempts=Infinity 对齐）。
    startRetry: Infinity,
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
      case '--start-retry': {
        const n = Number(argv[++i]);
        o.startRetry = Number.isFinite(n) && n > 0 ? Math.floor(n) : Infinity;
        break;
      }
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

/** 原子写状态心跳（同一 schema，便于 `tunnel status` 读取）。
 * @param {string} statePath 状态文件路径
 * @param {string} state 主状态（STARTING/RUNNING/DEGRADED/STOPPING/STOPPED）
 * @param {string} lastEvent 最近事件名
 * @param {boolean} alive 隧道是否可用
 * @param {number} pid 守护进程 pid
 * @param {object|null} [extra] 额外诊断字段（如 lastError / errorCount / reason），合并进 state。
 */
export function writeStateAtom(statePath, state, lastEvent, alive, pid, extra = null) {
  mkdirSync(dirname(statePath), { recursive: true });
  const base = { state, lastEvent, alive, updatedAt: new Date().toISOString(), pid };
  const merged = extra && typeof extra === 'object' ? { ...base, ...extra } : base;
  const tmp = `${statePath}.tmp`;
  writeFileSync(
    tmp,
    JSON.stringify(merged, null, 2) + '\n',
    'utf8',
  );
  renameSync(tmp, statePath);
}

function logLine(logPath, level, msg) {
  // Q1（audit-qa ⑥）：日志行加 pid 前缀，使"同毫秒双写"能被机械归因到并发实例。
  const line = `${LOG_PREFIX} ${new Date().toISOString()} pid=${process.pid} ${level} ${msg}\n`;
  try { appendFileSync(logPath, line); } catch { /* 日志不可写不致命 */ }
  try { process.stdout.write(line); } catch { /* ignore */ }
}

/**
 * pidfile 独占创建（Q1 并发互斥；audit-qa ⑥"同毫秒双写"竞态）。
 *
 * 用 `open(path,'wx')` 独占语义：文件已存在即 EEXIST ⇒ 返回 false（调用方据此判"已有实例"），
 * 杜绝两个 daemon 在同一毫秒先后通过存活检查后双双启动的竞态。
 * 成功后先写裸 pid，pidfile 完整对象仍由 writePidfileAtomic 覆盖升级。
 *
 * @param {string} pidfile pidfile 路径
 * @param {number} pid 本进程 pid
 * @returns {boolean} true = 本进程取得独占；false = 已存在（他人持有）
 */
export function acquirePidfileExclusive(pidfile, pid) {
  mkdirSync(dirname(pidfile), { recursive: true });
  try {
    const fd = openSync(pidfile, 'wx');
    try {
      writeFileSync(fd, String(pid) + '\n');
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (e) {
    // EEXIST = 已有实例持有（保守拒绝）。其它错误（只读文件系统等）返回 true 放行，
    // 由后续 writePidfileAtomic 常规路径处理——绝不因锁机制自身故障挡住正常启动。
    if (e && e.code === 'EEXIST') return false;
    return true;
  }
}

/**
 * 启动期指数退避延时（Q1；与 oh-tunnel 稳态退避同款公式
 * delay=min(START_MAX_DELAY_MS, START_BASE_DELAY_MS×2^(n-1)) + rand×0.3×delay）。
 * @param {number} attempt 从 1 开始的尝试序号
 * @param {() => number} [rand] 注入随机源（测试用），返回 [0,1)
 * @returns {number} 毫秒延时
 */
export function startBackoffDelay(attempt, rand = Math.random) {
  const n = Math.max(1, attempt);
  const delay = Math.min(START_MAX_DELAY_MS, START_BASE_DELAY_MS * 2 ** (n - 1));
  const jitter = Math.floor(rand() * delay * 0.3);
  return delay + jitter;
}

/**
 * 有界 sleep（可注入 timer，测试零等待）。
 * @param {number} ms
 * @param {(fn: () => void, ms: number) => unknown} [setTimeoutImpl]
 * @returns {Promise<void>}
 */
function sleepBounded(ms, setTimeoutImpl = setTimeout) {
  return new Promise((res) => { setTimeoutImpl(res, ms); });
}

/**
 * 终态留痕写 STOPPED（Q1 / audit-qa ⑥ P0 建议）：
 * giveup 与启动放弃路径**先写 state=STOPPED+reason 再删 pidfile**，
 * 使"死隧道"留下可机械判读的诊断文件（运维不再只能翻日志）。
 * state 文件本身不被删除（与旧行为差异：旧实现 giveup/shutdown 均 rmSync 两文件，双向丢诊断）。
 * @param {string} statePath
 * @param {string} pidfile
 * @param {number} pid
 * @param {string} lastEvent
 * @param {object} extra
 */
function writeStoppedTrace(statePath, pidfile, pid, lastEvent, extra) {
  try {
    writeStateAtom(statePath, 'STOPPED', lastEvent, false, pid, extra);
  } catch { /* 留痕失败不致命（仍继续退出流程） */ }
  try { rmSync(pidfile, { force: true }); } catch { /* ignore */ }
}

/**
 * 守护进程主入口（由 detached 子进程调用）。
 *
 * Q1（批2）启动期退避重连：首连/启动阶段失败**不再即退**，与稳态断线共用同款
 * 指数退避（startBackoffDelay），默认不限次数；显式 `--start-retry N` 限定尝试数后
 * 放弃并留 `state=STOPPED + reason='start-giveup'` 终态文件。
 * 依赖注入（测试）：deps.startRetryDelayMs（固定延时，缺省走退避公式）、
 * deps.rand（随机源）、deps.setTimeoutImpl（计时器实现）。
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
  if (existsSync(o.pidfile)) {
    // QA 回归 D-5：acquirePidfileExclusive 独占窗口内写的是**裸 pid 文本**（非 JSON），
    // readJsonSafe 解析为 null 会把它误判"无主"删除 ⇒ 并发双实例互删对方活锁。
    // rmSync 前对裸 pid 补 kill-0 甄别（JSON 形态已判过，此处只兜非 JSON 文本）。
    let barePid = null;
    try {
      const raw = readFileSync(o.pidfile, 'utf8').trim();
      if (!prev && /^\d+$/.test(raw)) barePid = Number(raw);
    } catch { /* 读失败按陈旧处理 */ }
    if (barePid !== null && isAlive(barePid)) {
      logLine(logPath, 'WARN', `pidfile 为并发实例裸 pid 锁 pid=${barePid}（存活），不重复启动`);
      return 0;
    }
    rmSync(o.pidfile, { force: true }); // 陈旧 pidfile 清理
  }

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

  // Q1 并发互斥（audit-qa ⑥"同毫秒双写"）：存活检查通过 ≠ 端口独占 ——
  // 用 'wx' 独占创建 pidfile 关闭"两个实例同毫秒先后通过存活检查"的竞态窗口。
  // 拿到锁后立刻写裸 pid；完整对象随后由 writePidfileAtomic 升级。
  if (!acquirePidfileExclusive(o.pidfile, process.pid)) {
    logLine(logPath, 'WARN', 'pidfile 已被并发实例独占持有，本实例退出（不产生第二实例）');
    return 0;
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

  /** @type {InstanceType<typeof Tunnel> | null} 当前尝试的隧道实例（启动重试期每次重建） */
  let tunnel = null;
  let stopping = false;
  let errorCount = 0;
  let lastErrorText = '';
  let giveupReason = '';

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

  // P0-02 崩溃缺陷防护：隧道运行期单次 ssh 错误**不得**让守护进程整进程退出。
  // 这里兜底收住任何逃逸的异常，把原因写进 state 文件后**继续保活**（等 SIGNTERM 或自愈），
  // 绝不静默死、也绝不因单次错误退出。仅记录诊断，不影响事件循环。
  process.on('uncaughtException', (err) => {
    if (stopping) return;
    const msg = err instanceof Error ? `${err.message}` : String(err);
    logLine(logPath, 'ERROR', `uncaughtException（已兜底，进程保持存活）：${msg}`);
    try {
      writeStateAtom(statePath, 'DEGRADED', 'uncaughtException', tunnel?.alive ?? false, process.pid, {
        lastError: msg,
        errorCount: errorCount + 1,
        lastErrorAt: new Date().toISOString(),
      });
    } catch { /* 兜底写入失败也不致命 */ }
  });
  process.on('unhandledRejection', (reason) => {
    if (stopping) return;
    const msg = reason instanceof Error ? reason.message : String(reason ?? '(unknown)');
    logLine(logPath, 'ERROR', `unhandledRejection（已兜底，进程保持存活）：${msg}`);
    try {
      writeStateAtom(statePath, 'DEGRADED', 'unhandledRejection', tunnel?.alive ?? false, process.pid, {
        lastError: msg,
        errorCount: errorCount + 1,
        lastErrorAt: new Date().toISOString(),
      });
    } catch { /* ignore */ }
  });

  /* ---- Q1 启动期退避重试（audit-qa ⑥ P0 行动项）----
   * 旧行为：首连失败（如 VM 未醒 EHOSTUNREACH）⇒ catch → shutdown() → exit 1，零重试。
   * 新行为：启动阶段失败与稳态断线共用同款指数退避；默认无限重试（--start-retry N 可设上限），
   * 放弃时保留 state=STOPPED + reason='start-giveup' 终态文件（与 giveup 语义对齐，不再 rmSync state）。
   *
   * 构造期 throw（缺参/参数非法，B 型死法）单独处理：这类失败**重试也不会变好**，
   * 且发生在 _listen() 之前（未占端口），直接写 STOPPED 留痕退出，不进退避循环。
   */
  const retryDelayMs = deps.startRetryDelayMs ?? null; // 测试注入：固定小延时
  const setTimeoutImpl = deps.setTimeoutImpl ?? setTimeout;

  // 1) 构造隧道（参数校验在构造期，throw 即 B 型"缺参即退"——非瞬态，不重试）
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
      logger: (level, msg) => logLine(logPath, level, msg),
    });
  } catch (e) {
    logLine(logPath, 'ERROR', `隧道启动失败（参数/构造期，不可重试）：${e.message}`);
    writeStoppedTrace(statePath, o.pidfile, process.pid, 'start-config-error', {
      reason: 'start-config-error',
      lastError: e.message,
      lastErrorAt: new Date().toISOString(),
      retryable: false,
    });
    stopping = true; // 阻断信号处理器再走 shutdown（pidfile 已清理）
    return 1;
  }

  tunnel.on('ready', () => writeStateAtom(statePath, 'RUNNING', 'ready', true, process.pid));
  tunnel.on('close', () => writeStateAtom(statePath, 'DEGRADED', 'closed', false, process.pid));
  tunnel.on('reconnecting', () => writeStateAtom(statePath, 'DEGRADED', 'reconnecting', false, process.pid));
  tunnel.on('reconnected', () => writeStateAtom(statePath, 'RUNNING', 'reconnected', true, process.pid));
  // F7：注册 'error' 监听 —— 这是修复崩溃的关键接线（原实现唯独漏了它）。
  // 隧道内部已保证 emit('error') 不会 throw，此处仅把原因持久化进 state 供诊断。
  tunnel.on('error', (err) => {
    if (stopping) return;
    const msg = err instanceof Error ? err.message : String(err ?? '(unknown)');
    errorCount += 1;
    lastErrorText = msg;
    logLine(logPath, 'WARN', `隧道错误（已内部消化，走退避重连）：${msg}`);
    writeStateAtom(statePath, 'DEGRADED', 'error', tunnel.alive, process.pid, {
      lastError: msg,
      errorCount,
      lastErrorAt: new Date().toISOString(),
    });
  });
  // F7：连续重连达上限的终态事件 —— 写出可诊断状态后**有序退出**（绝不静默死）。
  tunnel.on('giveup', (payload) => {
    if (stopping) return;
    giveupReason = payload?.reason instanceof Error ? payload.reason.message : String(payload?.reason ?? '(unknown)');
    logLine(logPath, 'ERROR', `重连耗尽，有序退出：${giveupReason}`);
    // 稳态 giveup 留痕（state=STOPPED+reason 保留，不再 rmSync state；pidfile 清理）。
    try { tunnel?.stop(); } catch { /* ignore */ }
    writeStoppedTrace(statePath, o.pidfile, process.pid, 'giveup', {
      reason: giveupReason,
      attempts: payload?.attempts ?? errorCount,
      lastError: lastErrorText || payload?.lastError || '(unknown)',
      lastErrorAt: new Date().toISOString(),
    });
    process.exit(1);
  });

  // 2) 启动（含首连）：瞬态失败进退避重试；EADDRINUSE 亦属瞬态（旧实例正在退出/OS 未释放端口）。
  for (let attempt = 1; !stopping; attempt += 1) {
    try {
      await tunnel.start();
      logLine(logPath, 'INFO', `隧道已就绪：127.0.0.1:${o.localPort} → ${o.vmUser}@${o.vmHost}:${o.vmSshPort} → 127.0.0.1:${o.remotePort}`);
      return 0;
    } catch (e) {
      if (stopping) return 0; // SIGTERM 落在启动窗口：按有序停机处理
      lastErrorText = e instanceof Error ? e.message : String(e);
      const maxN = Number.isFinite(o.startRetry) ? o.startRetry : Infinity;
      logLine(logPath, 'WARN', `隧道启动失败（第 ${attempt} 次尝试）：${lastErrorText}`);
      if (attempt >= maxN) {
        logLine(logPath, 'ERROR', `启动重试达上限（${maxN}），放弃并留 STOPPED 终态：${lastErrorText}`);
        try { tunnel?.stop(); } catch { /* ignore */ }
        writeStoppedTrace(statePath, o.pidfile, process.pid, 'start-giveup', {
          reason: 'start-giveup',
          attempts: attempt,
          lastError: lastErrorText,
          lastErrorAt: new Date().toISOString(),
          retryable: true,
        });
        return 1;
      }
      // 拆除半途失败实例（端口可能已绑）：stop() 幂等，重试前必须释放本地监听，
      // 否则第二次 _listen() 会在"端口被自己占用"状态上叠加 EADDRINUSE 死循环。
      try { tunnel.stop && (await tunnel.stop()); } catch { /* ignore */ }
      const wait = retryDelayMs != null
        ? retryDelayMs
        : startBackoffDelay(attempt, deps.rand ?? Math.random);
      try {
        writeStateAtom(statePath, 'DEGRADED', 'start-retry', false, process.pid, {
          lastError: lastErrorText,
          startAttempt: attempt,
          nextRetryInMs: wait,
          lastErrorAt: new Date().toISOString(),
        });
      } catch { /* ignore */ }
      await sleepBounded(wait, setTimeoutImpl);
    }
  }
  return 0; // stopping 置位后的兜底（信号驱动退出在 shutdown 内完成）
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

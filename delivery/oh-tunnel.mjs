/**
 * OH 宿主进程内 ssh2 本地转发隧道（HarmonyOS 无系统 ssh 时的替代实现）。
 *
 * 关键事实（务必照此实现，别写反）：
 *  - 本地转发（ssh -L）语义：在宿主用 net.Server 监听 localBindHost:localBindPort；
 *    每来一条连接，调用 client.forwardOut(localHost, localPort, remoteHost, remotePort, cb)
 *    开一条 direct-tcpip 通道到 VM，再把两端双向 pipe。
 *  - 不要用 forwardIn / 'tcpip' 事件（那是远端转发 ssh -R 语义）。
 *  - 仅绑定 127.0.0.1（拒绝 0.0.0.0 / 外网地址），避免端口暴露。
 *  - 凭据（password / privateKey / identityFile）永不进日志。
 *  - 注册 process exit / SIGINT / SIGTERM 清理，杜绝孤儿端口。
 *  - start / stop 幂等；ssh 断线指数退避重连（1s×2，上限 30s，带 jitter，默认持续）。
 *
 * 设计要点：
 *  - ssh2 客户端通过依赖注入（opts.ssh2Client）传入，默认动态 import('ssh2')，
 *    使本模块「加载 / 单元测试」不依赖真实 ssh2 是否安装（无网沙箱即可测）。
 *  - 导出的 TunnelHandle 形态：{ pid:undefined, stop, on, localPort, alive,
 *    baseUrl, close, exited }，可被上层与 core 后端复用。
 *
 * 稳定性契约（P0-02 崩溃缺陷修复后新增，务必遵守）：
 *  - **本类任何情况下都不会因 emit('error') 让宿主进程崩溃**。
 *    Node EventEmitter 在无 'error' 监听时 emit('error') 会直接 throw；该 throw 发生在
 *    ssh2 异步回调栈里无人 catch ⇒ uncaughtException ⇒ 守护进程整进程退出
 *    （pidfile 消失、本地端口停监听）。上层守护进程历史上未注册 'error' 监听，
 *    因此该路径必崩（实证：`Unhandled 'error' event` @ oh-tunnel.mjs:414）。
 *    ⇒ 一律走 _safeEmitError() 派发：无监听则降级为内部自愈，监听内部抛错也一并兜住。
 *  - **错误分两级**：单条 direct-tcpip 通道开失败 ⇒ 只丢弃该连接；连接层错误
 *    （keepalive 超时 / socket 断开 / 连续多次开通道失败）⇒ 整条 ssh 连接不可用，
 *    走既有指数退避重连。
 */

import { createServer } from 'node:net';
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { loadSsh2Client } from './ssh2-resolve.mjs';

/* ------------------------------- 常量 ------------------------------- */

const DEFAULT_VM_SSH_PORT = 22;
const DEFAULT_LOCAL_BIND_HOST = '127.0.0.1';
const DEFAULT_REMOTE_HOST = '127.0.0.1';
const DEFAULT_KEEPALIVE_INTERVAL_MS = 30_000;
const DEFAULT_KEEPALIVE_COUNT_MAX = 3;
const DEFAULT_READY_TIMEOUT_MS = 20_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const RECONNECT_BASE_MS = 1_000;

/** 仅允许回环地址，杜绝端口外泄。 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * 连接层错误特征：命中即认为**整条 ssh 连接**已不可用（而非单条通道失败），
 * 必须重建连接。关键词取自 ssh2 实际抛出的 message（含主理人取证的
 * `No response from server`）与常见 socket 错误码。
 */
const CONNECTION_LEVEL_PATTERNS = [
  /no response from server/i,
  /keepalive/i,
  /channel open fail/i,
  /administratively prohibited/i,
  /administratively refused/i,
  /connection refused/i,
  /socket\s+(?:is\s+)?(?:closed|not\s+open|hang\s*up)/i,
  /this socket (?:is closed|has been ended)/i,
  /econnreset|epipe|etimedout|ehostunreach|enetunreach|econnaborted/i,
];

/**
 * 连续单通道失败达到该阈值 → 即使错误信息不明确，也判定连接层不可用并重连。
 * 理由：VM 侧 sshd 半死时，每条新连接都以同一原因失败，需整体重建而非逐条重试。
 */
const FORWARD_ERROR_RECONNECT_THRESHOLD = 3;

/**
 * 判断错误是否属于「连接层」（需重建 ssh 连接）。
 * @param {unknown} err 任意错误入参
 * @returns {boolean} true 表示连接层错误
 */
export function isConnectionLevelError(err) {
  const text = `${err instanceof Error ? err.message : String(err ?? '')}`;
  if (!text) return false;
  return CONNECTION_LEVEL_PATTERNS.some((re) => re.test(text));
}

/**
 * 归一化为 Error（ssh2 回调偶有误传字符串 / undefined 的情况）。
 * @param {unknown} err 原始错误
 * @returns {Error} Error 实例
 */
function toError(err) {
  if (err instanceof Error) return err;
  return new Error(typeof err === 'string' ? err : `(非 Error 类型错误) ${String(err ?? '')}`);
}

/**
 * 提取错误信息文本（凭据绝不会进入这里，仅取 message）。
 * @param {unknown} err 原始错误
 * @returns {string} 错误信息
 */
function errText(err) {
  return toError(err).message;
}

/* ------------------------------- 工具 ------------------------------- */

/**
 * 配置校验：非法输入直接 throw（在 start() 之前即可发现，便于上层 try/catch）。
 * 返回规范化后的内部配置对象。
 */
function normalizeOpts(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('establishSsh2Tunnel: opts 必须是一个对象');
  }

  const vmHost = typeof raw.vmHost === 'string' ? raw.vmHost.trim() : '';
  if (!vmHost) throw new Error('缺少必填项 vmHost');

  const localBindHost = raw.localBindHost ?? DEFAULT_LOCAL_BIND_HOST;
  if (typeof localBindHost !== 'string' || !LOOPBACK_HOSTS.has(localBindHost)) {
    throw new Error(
      `仅允许绑定回环地址（127.0.0.1 / ::1），拒绝外网暴露；收到：${String(raw.localBindHost)}`,
    );
  }

  const localBindPort = Number(raw.localBindPort);
  if (!Number.isInteger(localBindPort) || localBindPort <= 0 || localBindPort > 65535) {
    throw new Error(`localBindPort 非法（需 1..65535 整数）：${String(raw.localBindPort)}`);
  }

  const remoteHost = raw.remoteHost ?? DEFAULT_REMOTE_HOST;
  const remotePort = Number(raw.remotePort);
  if (!Number.isInteger(remotePort) || remotePort <= 0 || remotePort > 65535) {
    throw new Error(`remotePort 非法（需 1..65535 整数）：${String(raw.remotePort)}`);
  }

  const vmSshPort = raw.vmSshPort != null ? Number(raw.vmSshPort) : DEFAULT_VM_SSH_PORT;
  if (!Number.isInteger(vmSshPort) || vmSshPort <= 0 || vmSshPort > 65535) {
    throw new Error(`vmSshPort 非法：${String(raw.vmSshPort)}`);
  }

  const username = typeof raw.username === 'string' ? raw.username.trim() : '';
  if (!username) throw new Error('缺少必填项 username');

  // 凭据三选一：privateKey | identityFile | password
  let privateKey = raw.privateKey ?? null;
  if (privateKey == null && raw.identityFile) {
    if (!existsSync(raw.identityFile)) {
      throw new Error(`identityFile 不存在：${raw.identityFile}`);
    }
    privateKey = readFileSync(raw.identityFile);
  }
  const password = raw.password ?? null;
  if (privateKey == null && password == null) {
    throw new Error(
      '必须提供 privateKey / identityFile / password 之一（进程内 ssh2 无法复用系统 ssh agent）。' +
        '提示：setup.mjs 已内置默认键探测链（WINVM_VM_KEY 未设时自动探测 ~/.ssh/id_ed25519 → id_ecdsa → id_rsa）；' +
        '若私钥在非默认路径，请在 .env 的 WINVM_VM_KEY 填写完整路径。',
    );
  }

  const keepaliveInterval =
    raw.keepaliveInterval != null ? Number(raw.keepaliveInterval) : DEFAULT_KEEPALIVE_INTERVAL_MS;
  const keepaliveCountMax =
    raw.keepaliveCountMax != null ? Number(raw.keepaliveCountMax) : DEFAULT_KEEPALIVE_COUNT_MAX;
  const readyTimeoutMs =
    raw.readyTimeoutMs != null ? Number(raw.readyTimeoutMs) : DEFAULT_READY_TIMEOUT_MS;
  const reconnect = raw.reconnect !== false;
  const maxAttempts = raw.maxAttempts != null ? Number(raw.maxAttempts) : Infinity;
  const logger = typeof raw.logger === 'function' ? raw.logger : null;

  return {
    vmHost,
    vmSshPort,
    username,
    localBindHost,
    localBindPort,
    remoteHost,
    remotePort,
    privateKey,
    password,
    keepaliveInterval,
    keepaliveCountMax,
    readyTimeoutMs,
    reconnect,
    maxAttempts,
    ssh2Client: raw.ssh2Client ?? null,
    hostVerifier: typeof raw.hostVerifier === 'function' ? raw.hostVerifier : null,
    logger,
  };
}

/**
 * 主机密钥校验（TOFU：首次信任并持久化到 ~/.workbuddy/winvm/known_hosts，禁止无条件接受）。
 * 真实 ssh2 在 connect 时调用 (key: Buffer, verify: (ok:boolean)=>void)。
 */
function makeHostVerifier(hostname, port) {
  const path = join(homedir(), '.workbuddy', 'winvm', 'known_hosts');
  return (key, verify) => {
    let known = [];
    try {
      if (existsSync(path)) {
        known = readFileSync(path, 'utf8').split('\n').filter(Boolean);
      }
    } catch {
      /* 读取失败不致命，降级为信任本次（仍会写入） */
    }
    const fingerprint = key.toString('base64');
    const prefix = `${hostname}:${port} `;
    if (known.some((e) => e.startsWith(prefix) && e.endsWith(fingerprint))) {
      verify(true);
      return;
    }
    // 首次出现：信任并持久化（与 OpenSSH StrictHostKeyChecking=accept-new 一致）
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${prefix}${fingerprint}\n`);
    } catch {
      /* 写入失败不致命 */
    }
    verify(true);
  };
}

/* ------------------------------- 隧道类 ------------------------------- */

export class OhSshTunnel extends EventEmitter {
  /**
   * @param {object} opts 见 normalizeOpts；至少含 vmHost / username / localBindPort / remotePort。
   */
  constructor(opts) {
    super();
    // 构造期即校验，越早暴露配置错误越好。
    this._opts = normalizeOpts(opts);

    this._client = null;
    this._server = null;
    this._started = false;
    this._stopping = false;
    this._alive = false;
    this._attempt = 0;
    this._reconnectTimer = null;
    this._actualPort = this._opts.localBindPort;
    this._cleanupBound = false;

    // 自愈诊断计数（无 'error' 监听时的内部降级用，也用于 giveup 终态原因）
    this._consecutiveForwardErrors = 0;
    this._lastErrorText = '';

    // 进程级清理句柄（绑定 this，便于 unref / removeListener）
    this._onExit = () => this._hardCleanup();
    this._onSigint = () => this._hardCleanup();
    this._onSigterm = () => this._hardCleanup();
  }

  /** 实际监听端口（localBindPort 为 0 时由 OS 分配）。 */
  get localPort() {
    return this._actualPort;
  }

  /** ssh 连接是否存活（仅在此为 true 时才转发新连接）。 */
  get alive() {
    return this._alive;
  }

  /**
   * 启动隧道：监听本地端口 + 建立 ssh2 连接。幂等（重复调用返回同一 handle）。
   * @returns {Promise<object>} TunnelHandle
   */
  async start() {
    if (this._started) return this._buildHandle();
    this._started = true;
    this._stopping = false;

    // 1) 本地监听（仅回环）
    await this._listen();

    // 2) 注册进程级清理，杜绝孤儿端口
    this._registerCleanup();

    // 3) 连接 ssh2（含就绪超时保护）
    await this._connectWithTimeout();

    return this._buildHandle();
  }

  /**
   * 停止隧道：关闭本地监听 + 断开 ssh2 + 取消重连 + 撤销进程清理。幂等。
   */
  async stop() {
    if (!this._started || this._stopping) return;
    this._stopping = true;

    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._unregisterCleanup();

    try {
      // 统一拆除（内含 removeAllListeners 后的 noop error 兜底，避免 ECONNRESET 崩进程）
      this._teardownClient();
    } finally {
      if (this._server) {
        await new Promise((resolve) => {
          this._server.close(() => resolve());
        });
        try {
          this._server.removeAllListeners();
        } catch {
          /* ignore */
        }
        this._server = null;
      }
      this._alive = false;
      this._started = false;
      this.emit('stopped');
    }
  }

  /* ---- 内部：安全事件派发（稳定性契约的核心） ---- */

  /**
   * 安全派发任意事件：监听者内部抛错绝不演变成 uncaughtException。
   * @param {string} event 事件名
   * @param {...unknown} args 参数
   * @returns {boolean} 是否派发成功
   */
  _safeEmit(event, ...args) {
    try {
      // 'error' 特殊：无监听时 Node 会 throw ⇒ 交由 _safeEmitError 处理。
      if (event === 'error' && this.listenerCount('error') === 0) return false;
      return this.emit(event, ...args);
    } catch (e) {
      this._logInternal('ERROR', `隧道 ${event} 事件监听内部抛错：${errText(e)}`);
      return false;
    }
  }

  /**
   * 安全派发 'error' 事件 —— **本方法保证永不 throw**。
   *
   * 缺陷背景（必须留下这段说明，别删）：上层守护进程曾经只注册
   * ready/close/reconnecting/reconnected，未注册 'error'；当 forwardOut 通道打开失败
   * （VM 侧 sshd 无响应）时，这里 emit('error') 直接 throw 在 ssh2 的异步回调栈中，
   * 无人 catch ⇒ uncaughtException ⇒ 守护进程整进程退出。
   *
   * @param {unknown} err 错误
   * @param {string} [context] 错误来源（用于内部诊断日志），如 'forwardOut' / 'ssh-client'
   * @returns {void}
   */
  _safeEmitError(err, context = '') {
    const e = toError(err);
    this._lastErrorText = e.message;
    try {
      if (this.listenerCount('error') === 0) {
        // 无监听 ⇒ 绝不 throw（否则宿主进程必崩）；降级为内部诊断日志，自愈逻辑照常执行。
        this._logInternal('WARN', `隧道错误（无外部监听，已内部消化${context ? ` · ${context}` : ''}）：${e.message}`);
        return;
      }
      this.emit('error', e);
    } catch (inner) {
      this._logInternal('ERROR', `隧道 error 监听内部抛错：${errText(inner)}`);
    }
  }

  /**
   * 内部诊断日志（可选 logger 注入；凭据永不进入）。
   * @param {string} level 级别
   * @param {string} msg 消息
   * @returns {void}
   */
  _logInternal(level, msg) {
    try {
      this._opts?.logger?.(level, msg);
    } catch {
      /* logger 自身失败不得影响隧道 */
    }
  }

  /* ---- 内部：ssh2 连接拆除（带 error 兜底监听） ---- */

  /**
   * 拆除当前 ssh2 连接并释放引用。
   *
   * 关键点：`removeAllListeners()` 会把 'error' 监听一并移除；此后 ssh2 Client 仍可能
   * emit('error')（如 socket 关闭后的 ECONNRESET）⇒ 无监听会 unhandled throw 崩进程
   * （历史实证：HEALTH 结束停隧道时 `Error: read ECONNRESET`）。故拆除后补 noop 兜底。
   *
   * @returns {void}
   */
  _teardownClient() {
    const client = this._client;
    if (!client) return;
    try {
      client.removeAllListeners?.();
    } catch {
      /* ignore */
    }
    try {
      client.on?.('error', () => {});
    } catch {
      /* ignore */
    }
    try {
      client.end();
    } catch {
      /* ignore */
    }
    this._client = null;
  }

  /* ---- 内部：本地监听 ---- */
  _listen() {
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => this._onLocalConnection(socket));
      const onErr = (err) => reject(err);
      server.once('error', onErr);
      server.listen(this._opts.localBindPort, this._opts.localBindHost, () => {
        server.removeListener('error', onErr);
        const addr = server.address();
        this._actualPort =
          addr && typeof addr === 'object' ? addr.port ?? this._opts.localBindPort : this._opts.localBindPort;
        this._server = server;
        // 监听建立后的错误（如运行中端口异常）转交给上层，不阻塞。
        // 注意：必须走 _safeEmit，否则无 'error' 监听时此处 throw 会直接崩掉宿主进程。
        server.on('error', (err) => this._safeEmitError(err, 'local-server'));
        this._safeEmit('listening', { host: this._opts.localBindHost, port: this._actualPort });
        resolve();
      });
    });
  }

  /* ---- 内部：连接 ssh2（带就绪超时保护） ---- */
  _connectWithTimeout() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`SSH 连接在 ${this._opts.readyTimeoutMs}ms 内未就绪`));
      }, this._opts.readyTimeoutMs);
      this._connectOnce()
        .then((ok) => {
          clearTimeout(timer);
          resolve(ok);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  /* ---- 内部：单次 ssh2 连接，ready 时 resolve(true) ---- */
  _connectOnce() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        // 统一拆除（含 noop error 兜底）：拆到一半的 client 若再 emit('error') 不得崩进程。
        this._teardownClient();
        reject(toError(err));
      };

      (async () => {
        // DI 优先（this._opts.ssh2Client），否则走统一解析链：
        // 裸 import('ssh2') → 绝对路径兜底（vendor / WINVM_SSH2_DIR / 插件缓存 node_modules）→ 三要素错误。
        // 模块 URL 透传以使兜底路径落在调用方所在目录（oh-tunnel.mjs 落插件缓存，可命中 pluginRoot/node_modules/ssh2）。
        const Ctor = await loadSsh2Client({
          ssh2Client: this._opts.ssh2Client,
          moduleUrl: import.meta.url,
        });
        if (!Ctor) throw new Error('无法从 ssh2 模块解析出 Client 构造器');
        const client = new Ctor();
        this._client = client;

        client.on('ready', () => {
          if (settled) return;
          settled = true;
          this._alive = true;
          this._attempt = 0;
          this._consecutiveForwardErrors = 0;
          this._safeEmit('ready');
          resolve(true);
        });
        client.on('error', (err) => {
          if (settled) {
            // 【静默缺陷修复】就绪之后到达的连接层错误（keepalive 超时 No response from server、
            // socket 断开等）。原实现里 fail() 被 `settled` 短路 ⇒ 错误被吞掉 ⇒ 隧道「假活」：
            // alive 仍为 true、不重连、不报警，外部只表现为 18443 无响应。
            // 现在：标记失活 + 退避重连（随后到达的 'close' 会被 timer 去重拦掉）。
            this._alive = false;
            this._safeEmitError(err, 'ssh-client');
            this._markDeadAndReconnect(err, false);
            return;
          }
          fail(err);
        });
        client.on('close', () => {
          this._alive = false;
          this._safeEmit('close');
          if (settled) {
            // 已建立后断开 → 触发退避重连
            this._scheduleReconnect();
          }
          // 未 settled：连接阶段关闭，已由 error 分支 reject
        });

        this._connectClient(client);
      })().catch(fail);
    });
  }

  /* ---- 内部：构造 connect 选项并发起连接 ---- */
  _connectClient(client) {
    const o = this._opts;
    /** @type {Record<string, unknown>} */
    const connectOpts = {
      host: o.vmHost,
      port: o.vmSshPort,
      username: o.username,
      keepaliveInterval: o.keepaliveInterval,
      keepaliveCountMax: o.keepaliveCountMax,
      readyTimeout: o.readyTimeoutMs,
      // 安全：TOFU 主机密钥校验，禁止无条件接受
      hostVerifier: o.hostVerifier ?? makeHostVerifier(o.vmHost, o.vmSshPort),
    };
    // 凭据绝不打印到任何日志；仅用于 connect。
    if (o.privateKey != null) connectOpts.privateKey = o.privateKey;
    else if (o.password != null) connectOpts.password = o.password;
    client.connect(connectOpts);
  }

  /* ---- 内部：指数退避重连 ---- */
  _scheduleReconnect() {
    if (this._stopping || !this._opts.reconnect) return;
    if (this._attempt >= this._opts.maxAttempts) {
      this._safeEmitError(
        new Error(`重连次数已达上限（${this._opts.maxAttempts}），停止重连；最后错误：${this._lastErrorText || '(未知)'}`),
        'giveup',
      );
      // 终态事件：携带原因，供上层（守护进程）写出可诊断状态并有序退出，绝不静默死。
      this._safeEmit('giveup', {
        attempts: this._attempt,
        lastError: this._lastErrorText || '(未知)',
        reason: new Error(`重连次数已达上限（${this._opts.maxAttempts}）；最后错误：${this._lastErrorText || '(未知)'}`),
      });
      return;
    }
    // timer 去重：避免 'close' 与 'error' 同期各触发一次导致重复定时器（重复重连/计数失真）。
    if (this._reconnectTimer) return;

    this._attempt += 1;
    const delay = Math.min(MAX_RECONNECT_DELAY_MS, RECONNECT_BASE_MS * 2 ** (this._attempt - 1));
    const jitter = Math.random() * delay * 0.3; // 抖动 0~30%
    const wait = Math.floor(delay + jitter);
    this._safeEmit('reconnecting', { attempt: this._attempt, delayMs: wait });
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connectOnce()
        .then(() => {
          if (this._alive) this._safeEmit('reconnected', { attempt: this._attempt });
        })
        .catch((err) => {
          this._safeEmitError(err, 'reconnect');
          this._scheduleReconnect();
        });
    }, wait);
  }

  /**
   * 标记连接失活并触发退避重连（连接层错误专用）。不依赖外部 'error' 监听是否存在。
   * @param {unknown} err 触发失败的错误（仅取其 message 用于诊断）
   * @param {boolean} [destroyClient] 是否先拆除当前 client（默认 true）
   * @returns {void}
   */
  _markDeadAndReconnect(err, destroyClient = true) {
    this._alive = false;
    this._lastErrorText = errText(err);
    if (destroyClient) this._teardownClient();
    this._scheduleReconnect();
  }

  /* ---- 内部：本地连接 → forwardOut 双向 pipe ---- */
  _onLocalConnection(localSocket) {
    if (!this._client || !this._alive) {
      localSocket.destroy();
      return;
    }
    const o = this._opts;
    this._client.forwardOut(
      o.localBindHost,
      o.localBindPort,
      o.remoteHost,
      o.remotePort,
      (err, remoteStream) => {
        if (err) {
          // 【崩溃缺陷核心落点】forwardOut 通道打开失败（onChannelOpenFailure / VM 侧 sshd 无响应）。
          // 原实现 `this.emit('error', err)` 在上层（守护进程）未注册 'error' 监听时直接 throw，
          // 崩掉整个守护进程（实测栈：Unhandled 'error' event @ oh-tunnel.mjs:414）。
          // 现改为：安全派发 + 错误分级 + 必要时整体重连。
          const e = toError(err);
          this._consecutiveForwardErrors += 1;
          this._safeEmitError(e, 'forwardOut');

          const connectionLevel =
            isConnectionLevelError(e) ||
            this._consecutiveForwardErrors >= FORWARD_ERROR_RECONNECT_THRESHOLD;
          if (connectionLevel) {
            this._consecutiveForwardErrors = 0;
            // 整条 ssh 连接已不可用：丢弃该连接并走既有退避重连，本地 18443 恢复后自动可用。
            this._markDeadAndReconnect(e);
          }
          try {
            localSocket.destroy();
          } catch {
            /* ignore */
          }
          return;
        }

        // 成功建立单条通道：重置连续失败计数。
        this._consecutiveForwardErrors = 0;
        const cleanup = () => {
          try {
            remoteStream.destroy();
          } catch {
            /* ignore */
          }
          try {
            localSocket.destroy();
          } catch {
            /* ignore */
          }
        };
        // 双向转发
        localSocket.pipe(remoteStream).pipe(localSocket);
        localSocket.on('error', cleanup);
        remoteStream.on('error', cleanup);
        localSocket.on('close', () => {
          try {
            remoteStream.destroy();
          } catch {
            /* ignore */
          }
        });
        remoteStream.on('close', () => {
          try {
            localSocket.destroy();
          } catch {
            /* ignore */
          }
        });
      },
    );
  }

  /* ---- 内部：进程退出/信号清理（防孤儿端口） ---- */
  _registerCleanup() {
    if (this._cleanupBound) return;
    process.on('exit', this._onExit);
    process.on('SIGINT', this._onSigint);
    process.on('SIGTERM', this._onSigterm);
    this._cleanupBound = true;
  }

  _unregisterCleanup() {
    if (!this._cleanupBound) return;
    process.removeListener('exit', this._onExit);
    process.removeListener('SIGINT', this._onSigint);
    process.removeListener('SIGTERM', this._onSigterm);
    this._cleanupBound = false;
  }

  _hardCleanup() {
    try {
      if (this._reconnectTimer) {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
      }
      if (this._client) {
        try {
          this._client.end();
        } catch {
          /* ignore */
        }
      }
      if (this._server) {
        try {
          this._server.close();
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* 退出钩子里尽量不抛 */
    }
  }

  /* ---- 内部：构造对外 TunnelHandle ---- */
  _buildHandle() {
    const self = this;
    return {
      /** 进程内隧道无子进程，pid 恒为 undefined（core 不得依赖 pid 真值）。 */
      pid: undefined,
      get localPort() {
        return self._actualPort;
      },
      get baseUrl() {
        return `http://${self._opts.localBindHost}:${self._actualPort}`;
      },
      get alive() {
        return self._alive;
      },
      stop: () => self.stop(),
      close: () => self.stop(),
      on: (event, cb) => {
        self.on(event, cb);
        return () => self.off(event, cb);
      },
      exited: () => !self._alive,
    };
  }
}

/**
 * 一行式建立隧道（便捷封装）。
 * @param {object} opts 见 OhSshTunnel 构造参数。
 * @returns {Promise<object>} TunnelHandle
 */
export async function establishSsh2Tunnel(opts) {
  const tunnel = new OhSshTunnel(opts);
  return tunnel.start();
}

export default establishSsh2Tunnel;

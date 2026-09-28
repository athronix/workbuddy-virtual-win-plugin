/**
 * 进程内 ssh2 本地转发隧道（core 自包含实现）。
 *
 * 与 delivery/oh-tunnel.mjs 同构，但直接消费 @winvm/contracts 的 SshTunnelTransport，
 * 返回与现有 TunnelHandle 完全同构的对象（上层 transport/index.ts 零改动）。
 *
 * 为何在 core 内自包含而非 import delivery/*.mjs：
 *   - 避免跨包（packages <-> delivery）ESM 路径耦合与循环依赖风险；
 *   - 编译期不静态 import('ssh2')（用 string specifier 动态 import，缺包也能 tsc -b）。
 *
 * 语义（本地转发 ssh -L）：
 *   net.Server 监听 127.0.0.1:localPort；每来一条连接，client.forwardOut(...)
 *   开 direct-tcpip 通道到 VM，再把两端双向 pipe。绝不使用 forwardIn / 'tcpip'。
 */

import { createServer, type Server, type Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';

import type { SshTunnelTransport } from '@winvm/contracts';
import { TransportError } from './types.js';

/* ============================ 类型 ============================ */

/** 与现有 TunnelHandle 同构，额外暴露 on/alive 便于调试与事件订阅。 */
export interface Ssh2TunnelHandle {
  readonly localPort: number;
  readonly baseUrl: string;
  readonly pid: number | undefined;
  readonly alive: boolean;
  close(): Promise<void>;
  exited(): boolean;
  on(event: string, cb: (...args: unknown[]) => void): () => void;
}

interface Ssh2Stream {
  pipe(dst: unknown): unknown;
  destroy(): void;
  on(event: string, cb: (...args: unknown[]) => void): unknown;
}

interface Ssh2Client {
  connect(opts: Record<string, unknown>): void;
  on(event: string, cb: (...args: unknown[]) => void): unknown;
  removeAllListeners(): void;
  forwardOut(
    bindAddr: string,
    bindPort: number,
    remoteAddr: string,
    remotePort: number,
    cb: (err: Error | null, stream: Ssh2Stream) => void,
  ): void;
  end(): void;
}

interface Ssh2ClientCtor {
  new (): Ssh2Client;
}

interface EstablishSsh2Extra {
  readonly readyTimeoutMs?: number;
  readonly onStderr?: (chunk: string) => void;
  /** 注入 ssh2 Client 构造器（单测 mock；默认动态 import('ssh2')）。 */
  readonly ssh2Client?: Ssh2ClientCtor;
  /** 自定义 hostVerifier（默认 TOFU）。 */
  readonly hostVerifier?: (key: Buffer, verify: (ok: boolean) => void) => void;
}

interface NormalizedOpts {
  vmHost: string;
  vmSshPort: number;
  username: string;
  localBindHost: string;
  localBindPort: number;
  remoteHost: string;
  remotePort: number;
  privateKey: Buffer | string | null;
  password: string | null;
  keepaliveInterval: number;
  keepaliveCountMax: number;
  readyTimeoutMs: number;
  reconnect: boolean;
  maxAttempts: number;
  ssh2Client: Ssh2ClientCtor | null;
  hostVerifier: ((key: Buffer, verify: (ok: boolean) => void) => void) | null;
}

/* ============================ 常量 ============================ */

const DEFAULT_VM_SSH_PORT = 22;
const DEFAULT_LOCAL_BIND_HOST = '127.0.0.1';
const DEFAULT_REMOTE_HOST = '127.0.0.1';
const DEFAULT_KEEPALIVE_INTERVAL_MS = 30_000;
const DEFAULT_KEEPALIVE_COUNT_MAX = 3;
const DEFAULT_READY_TIMEOUT_MS = 20_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const RECONNECT_BASE_MS = 1_000;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/* ============================ 工具 ============================ */

function normalizeFromTransport(
  cfg: SshTunnelTransport,
  extra: EstablishSsh2Extra,
): NormalizedOpts {
  const vmHost = cfg.host?.trim() ?? '';
  if (!vmHost) throw new TransportError('SshTunnelTransport.host 为空');

  const localBindHost = DEFAULT_LOCAL_BIND_HOST; // 进程内隧道仅绑回环
  if (!LOOPBACK_HOSTS.has(localBindHost)) {
    throw new TransportError(`仅允许回环地址，拒绝：${localBindHost}`);
  }

  const localBindPort = Number(cfg.localPort);
  if (!Number.isInteger(localBindPort) || localBindPort <= 0 || localBindPort > 65535) {
    throw new TransportError(`localPort 非法：${String(cfg.localPort)}`);
  }

  const remotePort = Number(cfg.remotePort);
  if (!Number.isInteger(remotePort) || remotePort <= 0 || remotePort > 65535) {
    throw new TransportError(`remotePort 非法：${String(cfg.remotePort)}`);
  }

  const vmSshPort = cfg.port != null ? Number(cfg.port) : DEFAULT_VM_SSH_PORT;
  if (!Number.isInteger(vmSshPort) || vmSshPort <= 0 || vmSshPort > 65535) {
    throw new TransportError(`port(ssh) 非法：${String(cfg.port)}`);
  }

  const username = cfg.user?.trim() ?? '';
  if (!username) throw new TransportError('SshTunnelTransport.user 为空');

  let privateKey: Buffer | string | null = cfg.privateKey ?? null;
  if (privateKey == null && cfg.identityFile) {
    if (!existsSync(cfg.identityFile)) {
      throw new TransportError(`identityFile 不存在：${cfg.identityFile}`);
    }
    privateKey = readFileSync(cfg.identityFile);
  }
  const password = cfg.password ?? null;
  if (privateKey == null && password == null) {
    throw new TransportError('进程内 ssh2 需要 privateKey / identityFile / password 之一');
  }

  const keepaliveInterval =
    cfg.serverAliveInterval != null ? cfg.serverAliveInterval * 1000 : DEFAULT_KEEPALIVE_INTERVAL_MS;
  const keepaliveCountMax = cfg.serverAliveCountMax ?? DEFAULT_KEEPALIVE_COUNT_MAX;
  const readyTimeoutMs = extra.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const reconnect = true; // 长连接隧道默认持续重连
  const maxAttempts = Number.POSITIVE_INFINITY;

  return {
    vmHost,
    vmSshPort,
    username,
    localBindHost,
    localBindPort,
    remoteHost: DEFAULT_REMOTE_HOST,
    remotePort,
    privateKey,
    password,
    keepaliveInterval,
    keepaliveCountMax,
    readyTimeoutMs,
    reconnect,
    maxAttempts,
    ssh2Client: extra.ssh2Client ?? null,
    hostVerifier: extra.hostVerifier ?? null,
  };
}

function makeHostVerifier(hostname: string, port: number): (key: Buffer, verify: (ok: boolean) => void) => void {
  const path = join(homedir(), '.workbuddy', 'winvm', 'known_hosts');
  return (key: Buffer, verify: (ok: boolean) => void) => {
    let known: string[] = [];
    try {
      if (existsSync(path)) {
        known = readFileSync(path, 'utf8').split('\n').filter((l) => l.length > 0);
      }
    } catch {
      /* 读取失败不致命 */
    }
    const fingerprint = key.toString('base64');
    const prefix = `${hostname}:${port} `;
    if (known.some((e) => e.startsWith(prefix) && e.endsWith(fingerprint))) {
      verify(true);
      return;
    }
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${prefix}${fingerprint}\n`);
    } catch {
      /* 写入失败不致命 */
    }
    verify(true);
  };
}

/* ============================ 隧道类 ============================ */

class Ssh2LocalForwardTunnel extends EventEmitter {
  private readonly _opts: NormalizedOpts;
  private _client: Ssh2Client | null = null;
  private _server: Server | null = null;
  private _started = false;
  private _stopping = false;
  private _alive = false;
  private _attempt = 0;
  private _reconnectTimer: NodeJS.Timeout | null = null;
  private _actualPort: number;
  private _cleanupBound = false;

  private readonly _onExit = (): void => this._hardCleanup();
  private readonly _onSigint = (): void => this._hardCleanup();
  private readonly _onSigterm = (): void => this._hardCleanup();

  constructor(opts: NormalizedOpts) {
    super();
    this._opts = opts;
    this._actualPort = opts.localBindPort;
  }

  get localPort(): number {
    return this._actualPort;
  }

  get alive(): boolean {
    return this._alive;
  }

  async start(): Promise<Ssh2TunnelHandle> {
    if (this._started) return this._buildHandle();
    this._started = true;
    this._stopping = false;

    await this._listen();
    this._registerCleanup();
    await this._connectWithTimeout();
    return this._buildHandle();
  }

  async stop(): Promise<void> {
    if (!this._started || this._stopping) return;
    this._stopping = true;

    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._unregisterCleanup();

    try {
      if (this._client) {
        try {
          this._client.end();
        } catch {
          /* ignore */
        }
        try {
          this._client.removeAllListeners();
        } catch {
          /* ignore */
        }
      }
    } finally {
      if (this._server) {
        await new Promise<void>((resolve) => {
          this._server?.close(() => resolve());
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

  private _listen(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const server: Server = createServer((socket: Socket) => this._onLocalConnection(socket));
      const onErr = (err: Error): void => reject(err);
      server.once('error', onErr);
      server.listen(this._opts.localBindPort, this._opts.localBindHost, () => {
        server.removeListener('error', onErr);
        const addr = server.address();
        this._actualPort =
          addr && typeof addr === 'object' ? (addr.port ?? this._opts.localBindPort) : this._opts.localBindPort;
        this._server = server;
        server.on('error', (err: Error) => this.emit('error', err));
        this.emit('listening', { host: this._opts.localBindHost, port: this._actualPort });
        resolve();
      });
    });
  }

  private _connectWithTimeout(): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new TransportError(`SSH 连接在 ${this._opts.readyTimeoutMs}ms 内未就绪`));
      }, this._opts.readyTimeoutMs);
      this._connectOnce()
        .then((ok) => {
          clearTimeout(timer);
          resolve(ok);
        })
        .catch((err: unknown) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  private _connectOnce(): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      let settled = false;
      const fail = (err: unknown): void => {
        if (settled) return;
        settled = true;
        try {
          this._client?.removeAllListeners();
        } catch {
          /* ignore */
        }
        reject(err instanceof Error ? err : new TransportError(String(err)));
      };

      void (async (): Promise<void> => {
        let Ctor = this._opts.ssh2Client;
        if (!Ctor) {
          const spec: string = 'ssh2';
          const mod = await import(spec);
          Ctor = (mod.Client ?? mod.default?.Client ?? mod.default ?? null) as Ssh2ClientCtor | null;
          if (!Ctor) throw new TransportError('无法从 ssh2 模块解析出 Client 构造器');
        }
        const client = new Ctor();
        this._client = client;

        client.on('ready', () => {
          if (settled) return;
          settled = true;
          this._alive = true;
          this._attempt = 0;
          this.emit('ready');
          resolve(true);
        });
        client.on('error', (err: unknown) => fail(err));
        client.on('close', () => {
          this._alive = false;
          this.emit('close');
          if (settled) this._scheduleReconnect();
        });

        this._connectClient(client);
      })().catch(fail);
    });
  }

  private _connectClient(client: Ssh2Client): void {
    const o = this._opts;
    const connectOpts: Record<string, unknown> = {
      host: o.vmHost,
      port: o.vmSshPort,
      username: o.username,
      keepaliveInterval: o.keepaliveInterval,
      keepaliveCountMax: o.keepaliveCountMax,
      readyTimeout: o.readyTimeoutMs,
      hostVerifier: o.hostVerifier ?? makeHostVerifier(o.vmHost, o.vmSshPort),
    };
    if (o.privateKey != null) connectOpts.privateKey = o.privateKey;
    else if (o.password != null) connectOpts.password = o.password;
    client.connect(connectOpts);
  }

  private _scheduleReconnect(): void {
    if (this._stopping || !this._opts.reconnect) return;
    if (this._attempt >= this._opts.maxAttempts) {
      this.emit('error', new TransportError(`重连次数已达上限（${this._opts.maxAttempts}），停止重连`));
      return;
    }
    this._attempt += 1;
    const delay = Math.min(MAX_RECONNECT_DELAY_MS, RECONNECT_BASE_MS * 2 ** (this._attempt - 1));
    const jitter = Math.random() * delay * 0.3;
    const wait = Math.floor(delay + jitter);
    this.emit('reconnecting', { attempt: this._attempt, delayMs: wait });
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connectOnce()
        .then(() => {
          if (this._alive) this.emit('reconnected', { attempt: this._attempt });
        })
        .catch((err: unknown) => {
          this.emit('error', err);
          this._scheduleReconnect();
        });
    }, wait);
  }

  private _onLocalConnection(localSocket: Socket): void {
    if (!this._client || !this._alive) {
      localSocket.destroy();
      return;
    }
    const o = this._opts;
    this._client.forwardOut(o.localBindHost, o.localBindPort, o.remoteHost, o.remotePort, (err, remoteStream) => {
      if (err) {
        this.emit('error', err);
        localSocket.destroy();
        return;
      }
      const cleanup = (): void => {
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
      localSocket.pipe(remoteStream as unknown as import('stream').Duplex).pipe(localSocket);
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
    });
  }

  private _registerCleanup(): void {
    if (this._cleanupBound) return;
    process.on('exit', this._onExit);
    process.on('SIGINT', this._onSigint);
    process.on('SIGTERM', this._onSigterm);
    this._cleanupBound = true;
  }

  private _unregisterCleanup(): void {
    if (!this._cleanupBound) return;
    process.removeListener('exit', this._onExit);
    process.removeListener('SIGINT', this._onSigint);
    process.removeListener('SIGTERM', this._onSigterm);
    this._cleanupBound = false;
  }

  private _hardCleanup(): void {
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
      /* 退出钩子尽量不抛 */
    }
  }

  private _buildHandle(): Ssh2TunnelHandle {
    const self = this;
    return {
      pid: undefined,
      localPort: self._actualPort,
      baseUrl: `http://${self._opts.localBindHost}:${self._actualPort}`,
      get alive() {
        return self._alive;
      },
      close: () => self.stop(),
      exited: () => !self._alive,
      on: (event: string, cb: (...args: unknown[]) => void) => {
        self.on(event, cb);
        return () => self.off(event, cb);
      },
    };
  }
}

/**
 * 基于 SshTunnelTransport 建立进程内 ssh2 隧道。
 * 返回与 core 现有 TunnelHandle 同构的对象（上层 transport/index.ts 零改动）。
 */
export async function establishSsh2Tunnel(
  cfg: SshTunnelTransport,
  extra: EstablishSsh2Extra = {},
): Promise<Ssh2TunnelHandle> {
  const opts = normalizeFromTransport(cfg, extra);
  const tunnel = new Ssh2LocalForwardTunnel(opts);
  return tunnel.start();
}

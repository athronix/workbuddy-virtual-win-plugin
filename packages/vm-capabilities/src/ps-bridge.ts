/**
 * ps-bridge 客户端 —— 常驻 PowerShell 进程（NFR-503）
 *
 * 为什么需要：每次 `powershell -File` 冷启动约 500ms~1s，
 * 直接 spawn 无法满足 P95 < 300ms。改为常驻进程 + NDJSON over stdio 后，
 * 单次调用只有一次 JSON 往返，无进程启动开销。
 *
 * 帧协议：单行 JSON（\n 结尾），UTF-8；诊断信息走 stderr，绝不污染 stdout。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 本模块所在目录（ESM 安全）。
 *
 * ⚠️ ESM 中不存在 `__dirname`：若沿用会导致回退到 process.cwd()，
 * 进而解析出错误的脚本路径（曾解析到上级目录的 psmod/）。
 * 编译产物在 dist/、源码在 src/，向上一级均为包根，故两种形态下都正确。
 */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(MODULE_DIR, '..');

export interface PsBridgeOptions {
  /** ps-bridge.ps1 的路径 */
  readonly scriptPath?: string;
  readonly powershellPath?: string;
  readonly defaultTimeoutMs?: number;
  /** 心跳超时：超过此时间未收到心跳即判定僵死并重启 */
  readonly heartbeatTimeoutMs?: number;
  readonly workingDirectory?: string;
  readonly onStderr?: (chunk: string) => void;
}

export interface PsCallResult<T = unknown> {
  readonly ok: boolean;
  readonly data?: T;
  readonly error?: { code: string; message: string; details?: unknown };
  readonly warnings?: string[];
  readonly durationMs: number;
}

export class PsBridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'PsBridgeError';
  }
}

let seq = 0;

/** PowerShell 可执行文件名（跨平台可 fallback 到 pwsh） */
export function detectPowerShell(): string {
  if (process.platform === 'win32') return 'powershell.exe';
  return 'pwsh';
}

export class PsBridge {
  private child: ChildProcess | undefined;
  private readonly scriptPath: string;
  private readonly psExe: string;
  private readonly defaultTimeoutMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly workingDirectory?: string;
  private readonly onStderr?: (chunk: string) => void;

  private buffer = '';
  private readonly pending = new Map<
    string,
    { resolve: (v: PsCallResult) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private lastHeartbeatAtMs = 0;
  /** 自动重启进行中（防止看门狗重入） */
  private restarting = false;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private startedAtMs = 0;
  private stderrTail = '';
  private stopped = false;

  constructor(opts: PsBridgeOptions = {}) {
    // 默认指向包内 psmod 目录旁的 ps-bridge.ps1
    this.scriptPath = opts.scriptPath ?? defaultScriptPath();
    this.psExe = opts.powershellPath ?? detectPowerShell();
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 30_000;
    this.heartbeatTimeoutMs = opts.heartbeatTimeoutMs ?? 45_000;
    this.workingDirectory = opts.workingDirectory;
    this.onStderr = opts.onStderr;
  }

  get running(): boolean {
    return this.child !== undefined && !this.stopped && this.child.exitCode === null;
  }

  get uptimeMs(): number {
    return this.startedAtMs === 0 ? 0 : Date.now() - this.startedAtMs;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** 启动常驻进程并等待就绪 */
  async start(): Promise<void> {
    if (this.running) return;
    if (!existsSync(this.scriptPath)) {
      throw new PsBridgeError(
        'PSBRIDGE_SCRIPT_MISSING',
        `找不到 ps-bridge 脚本：${this.scriptPath}`,
      );
    }

    this.stopped = false;
    await this.spawnAndReady();
  }

  /** 拉起子进程、挂上看门狗并等待握手就绪（start 与自动重启共用） */
  private async spawnAndReady(): Promise<void> {
    this.lastHeartbeatAtMs = Date.now();
    this.startedAtMs = Date.now();

    this.child = spawn(
      this.psExe,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        ...(this.workingDirectory ? { cwd: this.workingDirectory } : {}),
      },
    );

    this.child.stdout?.on('data', (d: Buffer) => this.onData(d.toString('utf8')));
    this.child.stderr?.on('data', (d: Buffer) => {
      const s = d.toString('utf8');
      this.stderrTail = (this.stderrTail + s).slice(-8192);
      this.onStderr?.(s);
    });
    // 捕获本次子进程引用：exit 是异步事件，自动重启后旧进程的 exit 可能晚于新进程 spawn，
    // 若不比对就把 this.child 置空，会把**新进程**误清成 undefined，导致 running 永久 false。
    const spawned = this.child;
    spawned.once('exit', (code) => {
      const err = new PsBridgeError(
        'PSBRIDGE_EXITED',
        `ps-bridge 进程退出（code=${code}）。stderr: ${this.stderrTail.trim() || '(空)'}`,
      );
      this.failAll(err);
      if (this.child === spawned) this.child = undefined;
    });

    // 心跳看门狗
    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => {
        void this.watchdog();
      }, 5_000);
      this.heartbeatTimer.unref?.();
    }

    await this.ready();
  }

  /**
   * 看门狗：心跳超时后**先主动 ping 探测**，再决定是否重启。
   *
   * 背景（关键修复）：ps-bridge.ps1 的主循环在等待 stdin 时是阻塞的，
   * 空闲期间发不出心跳。若仅凭"长时间未收到心跳"就直接 kill，
   * 常驻服务会在空闲约 45s 后被误杀且永不恢复（表现为"刚装好能用，过一会儿就废"）。
   * 因此改为：ping 得通 → 只是没发心跳，刷新时间戳即可；ping 不通 → 判定僵死并重启。
   */
  private async watchdog(): Promise<void> {
    if (!this.running || this.restarting || this.stopped) return;
    if (Date.now() - this.lastHeartbeatAtMs <= this.heartbeatTimeoutMs) return;
    try {
      const res = await this.rawCall('__meta', 'ping', {}, 5_000);
      if (res.ok) {
        // 进程健康，仅补记心跳时间，避免误杀
        this.lastHeartbeatAtMs = Date.now();
        return;
      }
      await this.restart('ping 返回 not ok');
    } catch {
      await this.restart('ping 超时或失败');
    }
  }

  /** 判定僵死后自动重启（防重入；stop() 之后不再重启） */
  private async restart(reason: string): Promise<void> {
    if (this.restarting || this.stopped) return;
    this.restarting = true;
    try {
      this.failAll(
        new PsBridgeError(
          'PSBRIDGE_HEARTBEAT_TIMEOUT',
          `ps-bridge 超过 ${this.heartbeatTimeoutMs}ms 未心跳且探测失败（${reason}），正在重启`,
        ),
      );
      this.kill();
      await this.spawnAndReady();
      this.onStderr?.(`[ps-bridge] 已自动重启（原因：${reason}）`);
    } catch (e) {
      this.onStderr?.(`[ps-bridge] 自动重启失败：${(e as Error).message}`);
    } finally {
      this.restarting = false;
    }
  }

  /** 等待 bridge 就绪（握手） */
  private async ready(timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (!this.running) throw new PsBridgeError('PSBRIDGE_NOT_RUNNING', 'ps-bridge 未运行');
      try {
        const res = await this.rawCall('__meta', 'ping', {}, 3000);
        if (res.ok) return;
      } catch {
        // 尚未就绪，继续重试
      }
      if (Date.now() >= deadline) {
        this.kill();
        throw new PsBridgeError(
          'PSBRIDGE_READY_TIMEOUT',
          `ps-bridge 在 ${timeoutMs}ms 内未就绪。stderr: ${this.stderrTail.trim() || '(空)'}`,
        );
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // 非协议输出（理论上不应出现），忽略以免污染
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: Record<string, unknown>): void {
    if (msg['type'] === 'heartbeat') {
      this.lastHeartbeatAtMs = Date.now();
      return;
    }
    const id = msg['id'];
    if (typeof id !== 'string') return;
    const waiter = this.pending.get(id);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.pending.delete(id);
    waiter.resolve(msg as unknown as PsCallResult);
  }

  private failAll(err: Error): void {
    for (const [, w] of this.pending) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    this.pending.clear();
  }

  private rawCall(
    module: string,
    fn: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<PsCallResult> {
    if (!this.child?.stdin?.writable) {
      return Promise.reject(new PsBridgeError('PSBRIDGE_NOT_RUNNING', 'ps-bridge 未运行或 stdin 不可写'));
    }
    const id = `r${++seq}`;
    const payload = JSON.stringify({ id, module, function: fn, params, timeoutMs }) + '\n';

    return new Promise<PsCallResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PsBridgeError('PSBRIDGE_TIMEOUT', `调用 ${module}.${fn} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin!.write(payload);
    });
  }

  /** 调用一个能力函数 */
  async call<T = unknown>(
    module: string,
    fn: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<T> {
    if (!this.running) await this.start();
    const res = await this.rawCall(module, fn, params, timeoutMs ?? this.defaultTimeoutMs);
    if (!res.ok) {
      const e = res.error ?? { code: 'PSBRIDGE_UNKNOWN', message: '未知错误' };
      throw new PsBridgeError(e.code, e.message, e.details);
    }
    return res.data as T;
  }

  /** 优雅关闭 */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    this.kill();
  }

  private kill(): void {
    if (!this.child) return;
    try {
      this.child.stdin?.end();
    } catch {
      // ignore
    }
    this.child.kill();
    this.child = undefined;
  }

  /** 健康快照 */
  health(): { state: 'ready' | 'down'; uptimeMs: number; pending: number; lastHeartbeatAgoMs: number } {
    return {
      state: this.running ? 'ready' : 'down',
      uptimeMs: this.uptimeMs,
      pending: this.pending.size,
      lastHeartbeatAgoMs: this.lastHeartbeatAtMs === 0 ? -1 : Date.now() - this.lastHeartbeatAtMs,
    };
  }
}

/** ps-bridge.ps1 的默认解析路径（包根下的 psmod/ps-bridge.ps1） */
export function defaultScriptPath(): string {
  return join(PACKAGE_ROOT, 'psmod', 'ps-bridge.ps1');
}

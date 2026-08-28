/**
 * stdio JSON-RPC 通道（NDJSON over stdin/stdout）
 *
 * 用于本地测试与极简部署（含 `ssh vm ... --stdio` 变体）。
 * 与 ps-bridge 共用同一套 NDJSON 帧约定：单行 JSON，UTF-8。
 */

import { spawn, type ChildProcess } from 'node:child_process';

import { type JsonRpcChannel, TransportError } from './types.js';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function requestIdOf(payload: unknown): string | number | null | undefined {
  return isRecord(payload) ? (payload['id'] as string | number | null | undefined) : undefined;
}

export interface StdioChannelOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly defaultTimeoutMs?: number;
  readonly onStderr?: (chunk: string) => void;
}

export class StdioJsonRpcChannel implements JsonRpcChannel {
  readonly kind = 'stdio' as const;

  private readonly child: ChildProcess;
  private readonly defaultTimeoutMs: number;
  private readonly pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private readonly streamWaiters = new Set<{
    idKey: string;
    push: (v: unknown) => void;
    done: () => void;
  }>();

  private buffer = '';
  private closed = false;
  private stderrTail = '';

  constructor(opts: StdioChannelOptions) {
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 30_000;
    this.child = spawn(opts.command, [...opts.args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
    });

    this.child.stdout?.on('data', (d: Buffer) => this.onData(d.toString('utf8')));
    this.child.stderr?.on('data', (d: Buffer) => {
      this.stderrTail = (this.stderrTail + d.toString('utf8')).slice(-8192);
      opts.onStderr?.(d.toString('utf8'));
    });
    this.child.once('exit', () => {
      this.failAll(new TransportError(`子进程退出。stderr: ${this.stderrTail.trim() || '(空)'}`));
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: unknown): void {
    const idKey = requestIdOf(msg);
    const key = idKey === undefined || idKey === null ? '__null__' : String(idKey);

    // 先喂给流式等待者
    for (const w of [...this.streamWaiters]) {
      if (w.idKey === key) w.push(msg);
    }

    const waiter = this.pending.get(key);
    if (!waiter) return;

    // 通知类消息（无 result/error）不算最终响应，继续等待
    if (isRecord(msg) && !('result' in msg) && !('error' in msg)) return;

    clearTimeout(waiter.timer);
    this.pending.delete(key);
    if (isRecord(msg) && 'error' in msg) {
      waiter.reject(new TransportError(`RPC 错误：${JSON.stringify(msg['error'])}`));
    } else {
      waiter.resolve(msg);
    }
  }

  private failAll(err: Error): void {
    for (const [, w] of this.pending) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    this.pending.clear();
    for (const w of this.streamWaiters) w.done();
    this.streamWaiters.clear();
  }

  async request(
    payload: unknown,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<unknown> {
    if (this.closed) throw new TransportError('channel closed');
    if (!this.child.stdin?.writable) throw new TransportError('子进程 stdin 不可写');

    const idKey = requestIdOf(payload);
    const key = idKey === undefined || idKey === null ? '__null__' : String(idKey);
    if (this.pending.has(key)) throw new TransportError(`重复的 request id：${key}`);

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new TransportError(`请求超时（${opts?.timeoutMs ?? this.defaultTimeoutMs}ms）`));
      }, opts?.timeoutMs ?? this.defaultTimeoutMs);

      this.pending.set(key, { resolve, reject, timer });
      opts?.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        this.pending.delete(key);
        reject(new TransportError('请求被取消'));
      });

      this.child.stdin?.write(JSON.stringify(payload) + '\n');
    });
  }

  async *stream(payload: unknown, opts?: { signal?: AbortSignal }): AsyncIterable<unknown> {
    const idKey = requestIdOf(payload);
    const key = idKey === undefined || idKey === null ? '__null__' : String(idKey);

    const queue: unknown[] = [];
    let finished = false;
    let notify: (() => void) | null = null;

    const waiter = {
      idKey: key,
      push: (v: unknown) => {
        queue.push(v);
        notify?.();
      },
      done: () => {
        finished = true;
        notify?.();
      },
    };
    this.streamWaiters.add(waiter);
    this.child.stdin?.write(JSON.stringify(payload) + '\n');

    try {
      for (;;) {
        if (queue.length === 0) {
          if (opts?.signal?.aborted) break;
          await new Promise<void>((r) => {
            notify = r;
            if (queue.length > 0 || finished) r();
          });
          notify = null;
        }
        if (queue.length === 0 && finished) break;
        const item = queue.shift();
        if (item !== undefined) {
          yield item;
          // 终态事件即结束
          if (
            isRecord(item) &&
            (item['kind'] === 'status-update' && isRecord(item['status'])
              ? (item['status'] as Record<string, unknown>)['final'] === true
              : false)
          ) {
            break;
          }
          if (isRecord(item) && ('result' in item || 'error' in item)) break;
        }
        if (finished && queue.length === 0) break;
      }
    } finally {
      this.streamWaiters.delete(waiter);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.child.stdin?.end();
    } catch {
      // ignore
    }
    this.child.kill();
    await Promise.race([
      new Promise<void>((r) => this.child.once('exit', () => r())),
      new Promise<void>((r) => setTimeout(r, 3000)),
    ]);
    if (!this.child.killed) this.child.kill('SIGKILL');
  }
}

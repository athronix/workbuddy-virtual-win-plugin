/**
 * HTTP JSON-RPC 通道（同时服务 MCP Streamable HTTP 与 A2A JSON-RPC）
 *
 * - 普通请求：POST JSON，Accept 同时声明 json 与 text/event-stream；
 *   服务端可能直接回 JSON，也可能回 SSE 流 —— 两种情况都要能处理。
 * - 流式请求：以 SSE 增量产出事件。
 */

import { type JsonRpcChannel, TransportError } from './types.js';

export interface HttpChannelOptions {
  readonly baseUrl: string;
  /** RPC 路径，如 /mcp 或 /a2a */
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly defaultTimeoutMs?: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** 解析 SSE 文本流，产出 `data:` 行解析后的对象 */
export function parseSseChunk(buffer: string): { events: unknown[]; rest: string } {
  const events: unknown[] = [];
  let rest = buffer;
  let idx: number;
  while ((idx = rest.indexOf('\n\n')) !== -1) {
    const block = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    const dataLines = block
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart());
    if (dataLines.length === 0) continue;
    const payload = dataLines.join('\n');
    if (payload === '[DONE]') continue;
    try {
      events.push(JSON.parse(payload));
    } catch {
      // 忽略无法解析的事件，不阻断后续
    }
  }
  return { events, rest };
}

export class HttpJsonRpcChannel implements JsonRpcChannel {
  readonly kind = 'http' as const;
  private readonly baseUrl: string;
  private readonly path: string;
  private readonly headers: Record<string, string>;
  private readonly defaultTimeoutMs: number;
  private closed = false;

  constructor(opts: HttpChannelOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.path = opts.path.startsWith('/') ? opts.path : `/${opts.path}`;
    this.headers = { ...(opts.headers ?? {}) };
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 30_000;
  }

  get url(): string {
    return `${this.baseUrl}${this.path}`;
  }

  async request(
    payload: unknown,
    opts?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<unknown> {
    if (this.closed) throw new TransportError('channel closed');
    const timeoutMs = opts?.timeoutMs ?? this.defaultTimeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    opts?.signal?.addEventListener('abort', onAbort);

    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...this.headers,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new TransportError(`HTTP ${res.status} ${res.statusText} from ${this.url}`);
      }

      const contentType = res.headers.get('content-type') ?? '';
      if (contentType.includes('text/event-stream')) {
        // MCP/A2A 都可能以 SSE 返回；取最后一个有效事件作为最终响应
        const text = await res.text();
        const { events } = parseSseChunk(text.endsWith('\n\n') ? text : `${text}\n\n`);
        const last = events.at(-1);
        if (last === undefined) throw new TransportError('SSE 响应中未包含有效事件');
        return last;
      }

      const text = await res.text();
      if (!text.trim()) throw new TransportError('空响应');
      const parsed: unknown = JSON.parse(text);
      // 兼容：某些服务端会在 JSON 外层再包一层
      if (isRecord(parsed) && isRecord(parsed['result'])) return parsed;
      return parsed;
    } catch (e) {
      if (e instanceof TransportError) throw e;
      if (e instanceof Error && e.name === 'AbortError') {
        throw new TransportError(`请求超时（${timeoutMs}ms）：${this.url}`);
      }
      throw new TransportError(`请求失败：${(e as Error).message}`, e);
    } finally {
      clearTimeout(timer);
      opts?.signal?.removeEventListener('abort', onAbort);
    }
  }

  async *stream(payload: unknown, opts?: { signal?: AbortSignal }): AsyncIterable<unknown> {
    if (this.closed) throw new TransportError('channel closed');
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...this.headers,
      },
      body: JSON.stringify(payload),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
    if (!res.ok || !res.body) {
      throw new TransportError(`SSE 建立失败：HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { events, rest } = parseSseChunk(buffer);
        buffer = rest;
        for (const ev of events) yield ev;
      }
      // 收尾
      if (buffer.trim()) {
        const { events } = parseSseChunk(`${buffer}\n\n`);
        for (const ev of events) yield ev;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/**
 * 传输抽象（ARCHITECTURE.md §5）
 *
 * 三种传输对上层完全透明：ssh-tunnel（默认）、streamable-http、stdio。
 * 每种传输最终都归一为一个可通信的 JSON-RPC 通道。
 */

export interface JsonRpcChannel {
  readonly kind: 'http' | 'stdio';
  /** 单次请求/响应 */
  request(payload: unknown, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<unknown>;
  /** 流式响应（SSE / NDJSON），返回异步迭代器 */
  stream?(payload: unknown, opts?: { signal?: AbortSignal }): AsyncIterable<unknown>;
  close(): Promise<void>;
}

export interface TransportHandle {
  readonly kind: 'http' | 'stdio';
  /** HTTP 基址（stdio 传输为 undefined） */
  readonly baseUrl?: string;
  readonly channel: JsonRpcChannel;
  close(): Promise<void>;
}

export class TransportError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

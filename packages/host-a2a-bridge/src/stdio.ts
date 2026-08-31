/**
 * stdio MCP server 循环（NDJSON）
 *
 * mcp-framework 只提供协议处理（handleRequest），不含 stdio server transport，
 * 因此本文件补齐宿主侧的 stdio 接入：stdin 逐行读 JSON-RPC → 处理后写回 stdout。
 *
 * ⚠ stdout 只能承载 JSON-RPC 消息，任何日志必须走 stderr，否则会污染协议流。
 */

import type { McpServer } from '@winvm/mcp-framework';

export interface StdioBridgeOptions {
  readonly server: McpServer;
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
  readonly onError?: (e: unknown) => void;
}

export function startStdioBridge(opts: StdioBridgeOptions): Promise<void> {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const onError =
    opts.onError ??
    ((e: unknown) => {
      process.stderr.write(`[winvm-a2a-bridge] ${e instanceof Error ? e.message : String(e)}\n`);
    });

  if (typeof (input as { setEncoding?: unknown }).setEncoding === 'function') {
    (input as { setEncoding: (enc: string) => void }).setEncoding('utf8');
  }

  let buf = '';
  // 串行处理，保证响应顺序与请求一致
  let chain: Promise<void> = Promise.resolve();

  const write = (msg: unknown): void => {
    output.write(`${JSON.stringify(msg)}\n`);
  };

  const handle = async (line: string): Promise<void> => {
    let body: unknown;
    try {
      body = JSON.parse(line);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    try {
      const res = await opts.server.handleRequest(body);
      if (res) write(res);
    } catch (e) {
      const id =
        body && typeof body === 'object' && 'id' in body
          ? ((body as { id?: string | number | null }).id ?? null)
          : null;
      write({ jsonrpc: '2.0', id, error: { code: -32603, message: (e as Error).message || 'internal error' } });
      onError(e);
    }
  };

  return new Promise<void>((resolve) => {
    input.on('data', (chunk: unknown) => {
      buf += typeof chunk === 'string' ? chunk : String(chunk);
      let idx = buf.indexOf('\n');
      while (idx >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) chain = chain.then(() => handle(line)).catch((e) => onError(e));
        idx = buf.indexOf('\n');
      }
    });
    input.on('end', () => {
      void chain.then(() => resolve());
    });
    input.on('error', (e: unknown) => {
      onError(e);
      resolve();
    });
  });
}

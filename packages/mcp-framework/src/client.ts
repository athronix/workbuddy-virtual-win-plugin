/**
 * MCP Client —— 宿主侧工具调用客户端
 *
 * 传输无关：只依赖 JsonRpcChannel（HTTP / stdio），
 * 因此 SSH 隧道、Streamable HTTP、本地 stdio 三种传输共用同一套客户端。
 */

import type { JsonRpcChannel } from '@winvm/core';

let seq = 0;
function nextId(): number {
  seq += 1;
  return seq;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export class McpClientError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'McpClientError';
  }
}

export interface McpToolInfo {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
  readonly annotations?: Record<string, boolean>;
}

export interface McpCallResult {
  readonly content: readonly { type: string; text?: string; data?: string; mimeType?: string }[];
  readonly structuredContent?: unknown;
  readonly isError: boolean;
}

export class McpClient {
  private initialized = false;

  constructor(private readonly channel: JsonRpcChannel) {}

  private async call(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    const res = await this.channel.request(
      { jsonrpc: '2.0', id: nextId(), method, ...(params ? { params } : {}) },
      ...(timeoutMs !== undefined ? [{ timeoutMs }] : []),
    );
    if (!isRecord(res)) throw new McpClientError(-32600, '响应不是对象');
    if ('error' in res && isRecord(res['error'])) {
      const e = res['error'] as { code: number; message: string; data?: unknown };
      throw new McpClientError(e.code, e.message, e.data);
    }
    if (!('result' in res)) throw new McpClientError(-32600, '响应缺少 result');
    return res['result'];
  }

  private notify(method: string, params?: Record<string, unknown>): void {
    // 通知不等待响应；失败不阻断主流程
    void this.channel
      .request({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })
      .catch(() => undefined);
  }

  async initialize(): Promise<{ protocolVersion: string; serverInfo?: { name: string; version: string } }> {
    const res = (await this.call('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'winvm-bridge-host', version: '0.1.0' },
    })) as { protocolVersion: string; serverInfo?: { name: string; version: string } };
    this.initialized = true;
    this.notify('notifications/initialized');
    return res;
  }

  async listTools(): Promise<McpToolInfo[]> {
    if (!this.initialized) await this.initialize();
    const res = (await this.call('tools/list')) as { tools?: McpToolInfo[] };
    return res.tools ?? [];
  }

  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    opts: { timeoutMs?: number } = {},
  ): Promise<McpCallResult> {
    if (!this.initialized) await this.initialize();
    const res = (await this.call(
      'tools/call',
      { name, arguments: args },
      opts.timeoutMs,
    )) as McpCallResult;
    return { ...res, isError: res.isError === true };
  }

  /** 便捷方法：直接取结构化结果，失败时抛出 */
  async callToolStructured<T = unknown>(
    name: string,
    args: Record<string, unknown> = {},
    opts: { timeoutMs?: number } = {},
  ): Promise<T> {
    const res = await this.callTool(name, args, opts);
    if (res.isError) {
      const text = res.content.map((c) => c.text ?? '').join('\n');
      throw new McpClientError(-32000, `工具 ${name} 返回错误：${text}`);
    }
    return res.structuredContent as T;
  }

  async ping(): Promise<void> {
    await this.call('ping');
  }

  async close(): Promise<void> {
    await this.channel.close();
  }
}

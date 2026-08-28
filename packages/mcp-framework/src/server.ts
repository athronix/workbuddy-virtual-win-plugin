/**
 * MCP Server（Model Context Protocol）
 *
 * 协议版本 2025-06-18；传输无关，HTTP（Streamable HTTP）与 stdio 共用同一套处理逻辑。
 * 本文件只做协议层，**不感知能力模型** —— 能力→工具的映射在 vm-service 完成，
 * 以保证 mcp-framework 与 vm-capabilities 之间无依赖（分层铁律）。
 */

import type { Logger } from '@winvm/contracts';
import { NullLogger } from '@winvm/core';

export const MCP_PROTOCOL_VERSION = '2025-06-18';

export interface McpTool {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
  /** 标注：只读 / 破坏性 / 幂等（MCP annotations） */
  readonly annotations?: {
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
    readonly openWorldHint?: boolean;
  };
  readonly handler: McpToolHandler;
}

export interface ToolContext {
  readonly traceId: string;
  readonly signal?: AbortSignal;
}

export type McpToolHandler = (
  params: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<McpToolResult>;

export interface McpToolResult {
  /** 结构化结果（优先） */
  readonly structuredContent?: unknown;
  /** 文本/图像内容（兼容性与人类可读性） */
  readonly content?: readonly McpContent[];
  readonly isError?: boolean;
}

export type McpContent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly data: string; readonly mimeType: string }
  | { readonly type: 'resource'; readonly resource: { readonly uri: string; readonly mimeType?: string; readonly text?: string } };

export interface McpServerOptions {
  readonly name: string;
  readonly version: string;
  readonly tools: readonly McpTool[];
  readonly logger?: Logger;
  readonly instructions?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

let traceSeq = 0;
function newTraceId(): string {
  traceSeq += 1;
  return `tr_${Date.now().toString(36)}_${traceSeq}`;
}

export class McpServer {
  private readonly tools = new Map<string, McpTool>();
  private readonly logger: Logger;
  private readonly name: string;
  private readonly version: string;
  private readonly instructions?: string;
  private initialized = false;

  constructor(opts: McpServerOptions) {
    this.name = opts.name;
    this.version = opts.version;
    this.logger = opts.logger ?? new NullLogger();
    this.instructions = opts.instructions;
    for (const t of opts.tools) {
      if (this.tools.has(t.name)) throw new Error(`工具重复注册：${t.name}`);
      this.tools.set(t.name, t);
    }
  }

  registerTool(tool: McpTool): void {
    if (this.tools.has(tool.name)) throw new Error(`工具重复注册：${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  toolNames(): string[] {
    return [...this.tools.keys()].sort();
  }

  /** tools/list 的返回体 */
  listTools(): { tools: unknown[] } {
    return {
      tools: [...this.tools.values()].map((t) => ({
        name: t.name,
        ...(t.title ? { title: t.title } : {}),
        description: t.description,
        inputSchema: t.inputSchema,
        ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
        ...(t.annotations ? { annotations: t.annotations } : {}),
      })),
    };
  }

  /**
   * 处理一条 JSON-RPC 消息。
   * 返回 null 表示这是通知（notification），无需响应。
   */
  async handleRequest(body: unknown): Promise<Record<string, unknown> | null> {
    if (!isRecord(body)) return this.error(null, -32600, '请求体必须是对象');

    const id = (body['id'] ?? null) as string | number | null;
    const method = body['method'];
    if (typeof method !== 'string') return this.error(id, -32600, '缺少 method');
    const params = isRecord(body['params']) ? body['params'] : {};

    // 通知（无 id）：不需要响应
    const isNotification = !('id' in body);

    try {
      switch (method) {
        case 'initialize':
          this.initialized = true;
          return this.result(id, {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: this.name, version: this.version },
            ...(this.instructions ? { instructions: this.instructions } : {}),
          });

        case 'notifications/initialized':
        case 'notifications/cancelled':
        case 'initialized':
          return null;

        case 'ping':
          return this.result(id, {});

        case 'tools/list':
          return this.result(id, this.listTools());

        case 'tools/call':
          return await this.callTool(id, params);

        default:
          if (isNotification) return null;
          return this.error(id, -32601, `未知方法：${method}`);
      }
    } catch (e) {
      this.logger.error('MCP 处理异常', { method, error: String(e) });
      if (isNotification) return null;
      return this.error(id, -32603, (e as Error).message ?? '内部错误');
    }
  }

  private async callTool(
    id: string | number | null,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const name = params['name'];
    if (typeof name !== 'string') return this.error(id, -32602, '缺少 params.name');
    const tool = this.tools.get(name);
    if (!tool) return this.error(id, -32602, `未知工具：${name}`);

    const args = isRecord(params['arguments']) ? params['arguments'] : {};
    const traceId = newTraceId();

    try {
      const res = await tool.handler(args, { traceId });
      return this.result(id, {
        ...(res.content ? { content: res.content } : { content: [{ type: 'text', text: summarize(res.structuredContent) }] }),
        ...(res.structuredContent !== undefined ? { structuredContent: res.structuredContent } : {}),
        isError: res.isError === true,
      });
    } catch (e) {
      this.logger.warn('工具执行失败', { tool: name, error: String(e) });
      return this.result(id, {
        content: [{ type: 'text', text: `执行失败：${(e as Error).message}` }],
        isError: true,
      });
    }
  }

  private result(id: string | number | null, result: unknown): Record<string, unknown> {
    const base = { jsonrpc: '2.0' as const, id };
    return { ...base, result } as unknown as Record<string, unknown>;
  }

  private error(id: string | number | null, code: number, message: string): Record<string, unknown> {
    return { jsonrpc: '2.0', id, error: { code, message } } as unknown as Record<string, unknown>;
  }
}

function summarize(v: unknown): string {
  if (v === undefined) return '(无输出)';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

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
  /**
   * ARCH-29（P2-T4 接通，此前是**声明后从不构造、也从不消费**的死契约）：
   * 「宿主 HTTP 连接断开 ⇒ 本次 `tools/call` 的在途执行应当中止」的中止信号。
   *
   * 语义要点（消费侧必须按此理解，不得自行加码）：
   *  - **缺席即旧行为**：stdio / 单测 / 任何未接断连侦测的传输面，本键根本不注入；
   *  - **abort ⇒ 客户端已断连**：HTTP 响应流 `close` 且未正常写完（Node 里
   *    `res.on('close')` 且 `!res.writableEnded`）⇒ 框架 abort；
   *  - **协作式中止**：信号本身不杀死 VM 内的进程（cmd.exe 家族无信号透传）。
   *    消费点能做的是「中止本地等待 + 不再发起后续副作用」，取消口径与 SECURITY §2.2
   *    一致，任何「已强杀 VM 内进程」式表述都是不实陈述。
   */
  readonly signal?: AbortSignal;
  /**
   * K-N1 通道 2（**纯附加**）：委派 traceId。HTTP `/mcp` 路由从 `?dtid=` 解析后经
   * `handleRequest(body, ctx)` 注入；缺席即旧行为（纯宿主直调，provider 落 `channel:'mcp'`）。
   */
  readonly delegationId?: string;
}

/**
 * K-N1（**纯附加**）：一条 JSON-RPC 请求的传输层上下文（HTTP 路由 → callTool → ToolContext）。
 * 由 `handleRequest(body, reqCtx?)` 的第二个可选参数承载 —— 旧调用方不传即逐字旧行为。
 */
export interface McpRequestContext {
  readonly delegationId?: string;
  /**
   * ARCH-29（P2-T4，**纯附加可选**）：宿主断连中止信号。
   *
   * 为什么由**传输层**（`vm-service` 的 `/mcp` 路由）构造、而不是框架自建：
   * 「响应流是否已正常写完」（`res.writableEnded`）是 HTTP 层独有的事实，
   * `mcp-framework` 按分层铁律不感知 `ServerResponse`。框架只**消费**本字段：
   * 存在 ⇒ 灌进 `ToolContext.signal`（条件展开，缺席时 `ToolContext` 逐字节旧形态）；
   * handler 未自行消费 signal 而在途时断连 ⇒ `callTool` 兜底 abort 并转取消语义。
   */
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
   *
   * `reqCtx`（K-N1，**纯附加可选**）：HTTP 路由解析出的委派 traceId（`?dtid=`）等传输层上下文；
   * 不传 → `callTool` 组装的 `ToolContext` 逐字等于旧形态（零回归）。
   */
  async handleRequest(body: unknown, reqCtx?: McpRequestContext): Promise<Record<string, unknown> | null> {
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
          return await this.callTool(id, params, reqCtx);

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
    reqCtx?: McpRequestContext,
  ): Promise<Record<string, unknown>> {
    const name = params['name'];
    if (typeof name !== 'string') return this.error(id, -32602, '缺少 params.name');
    const tool = this.tools.get(name);
    if (!tool) return this.error(id, -32602, `未知工具：${name}`);

    const args = isRecord(params['arguments']) ? params['arguments'] : {};
    const traceId = newTraceId();
    // K-N1（纯附加）：仅当 reqCtx 携带非空 dtid 时才补 delegationId 键 ——
    // 无 dtid 时组装的 ToolContext 逐字节等于旧形态（`{ traceId }`），零回归。
    // ARCH-29（P2-T4，同为纯附加）：signal 键同样**条件展开** —— 缺席（stdio / 旧调用方）
    // ⇒ 不进 ctx 的键集，第三方 handler 看到的 ToolContext 形状与接通前逐字一致。
    const ctx: ToolContext = {
      ...(reqCtx?.delegationId ? { traceId, delegationId: reqCtx.delegationId } : { traceId }),
      ...(reqCtx?.signal ? { signal: reqCtx.signal } : {}),
    };

    // ARCH-29 判据 1（**取消优先于执行**）：signal 在派发前就已 abort（宿主断连早于本行）
    // ⇒ 绝不发起 handler（零新副作用），与 Phase 1 `step()` 咽喉范式同一口径。
    if (ctx.signal?.aborted === true) {
      this.logger.warn('工具调用未发起：宿主连接已断开', { tool: name, traceId });
      return this.result(id, {
        content: [{ type: 'text', text: CANCELED_TEXT }],
        isError: true,
      });
    }

    try {
      const res = ctx.signal
        ? await raceAbort(tool.handler(args, ctx), ctx.signal)
        : await tool.handler(args, ctx);
      return this.result(id, {
        ...(res.content ? { content: res.content } : { content: [{ type: 'text', text: summarize(res.structuredContent) }] }),
        ...(res.structuredContent !== undefined ? { structuredContent: res.structuredContent } : {}),
        isError: res.isError === true,
      });
    } catch (e) {
      // ARCH-29 判据 2（在途中止留痕）：AbortError 走**取消语义**，不得伪装成「执行失败」
      // —— 后者会被上游读成「这次调用出错了」，而真实事实是「宿主走了、本地停止等待」。
      if ((e as Error)?.name === 'AbortError') {
        this.logger.warn('工具调用因宿主断连而中止（VM 内在途副作用可能仍在继续）', {
          tool: name,
          traceId,
          inFlightMayContinue: true,
        });
        return this.result(id, {
          content: [{ type: 'text', text: CANCELED_TEXT }],
          structuredContent: { traceId, ok: false, canceled: true, inFlightMayContinue: true },
          isError: true,
        });
      }
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

/**
 * ARCH-29 取消收口文案（框架层唯一权威串，便于静态守卫与宿主侧文案对齐）。
 *
 * 只陈述**可证事实**：本地停止了等待、VM 内的在途副作用可能仍在继续
 * （cmd.exe 家族无信号透传，Node 侧无法强杀）。绝不写「未执行任何变更」。
 */
export const CANCELED_TEXT =
  '已中止等待：宿主连接断开，本地不再跟进该次调用；VM 内已下发的在途操作可能仍在继续（协作式中止，非强杀）。';

/**
 * ARCH-29：把 handler 与断连信号竞速。abort 时**reject**（`AbortError`），由
 * `callTool` 的 catch 统一转成取消语义。
 *
 * 纪律：
 *  - 监听器必须在 settle 后摘除，否则每条请求都会在 signal 上永久挂一个闭包
 *    （HTTP keep-alive 复用同一请求对象 ⇒ 无界增长点）；
 *  - handler 自己**消费** signal 并提前返回结果（能力执行侧的正常路径）时，
 *    本竞速只是兜底：谁先 settle 谁定，不重复记账、不改写 handler 的返回值。
 */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      const err = new Error('宿主连接断开，工具调用已中止');
      err.name = 'AbortError';
      reject(err);
    };
    const settle = (fn: () => void): void => {
      signal.removeEventListener('abort', onAbort);
      fn();
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    p.then((v) => settle(() => resolve(v)), (e) => settle(() => reject(e)));
  });
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

/**
 * @winvm/mcp-framework —— MCP 架构框架（L1b）
 *
 * 只做协议层（tools/list、tools/call、initialize、ping），不感知能力模型。
 * 能力 → MCP 工具的映射在 vm-service 完成，保证与 vm-capabilities 无依赖（分层铁律）。
 */

export { McpServer, MCP_PROTOCOL_VERSION, CANCELED_TEXT } from './server.js';
export type {
  McpTool,
  McpToolHandler,
  McpToolResult,
  McpContent,
  McpServerOptions,
  ToolContext,
  /**
   * ARCH-29（P2-T4）：`McpRequestContext` 与取消文案 `CANCELED_TEXT` 起对**传输层**公开 ——
   * 传输层（`vm-service` 的 `/mcp` 路由）构造 `signal` 后经 `handleRequest(body, reqCtx)`
   * 传入框架；此前它们只是模块内符号，外部（含消费侧的守卫/单测）无法引用权威串。
   */
  McpRequestContext,
} from './server.js';

export { McpClient, McpClientError } from './client.js';
export type { McpToolInfo, McpCallResult } from './client.js';

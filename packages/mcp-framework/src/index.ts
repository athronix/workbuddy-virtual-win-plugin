/**
 * @winvm/mcp-framework —— MCP 架构框架（L1b）
 *
 * 只做协议层（tools/list、tools/call、initialize、ping），不感知能力模型。
 * 能力 → MCP 工具的映射在 vm-service 完成，保证与 vm-capabilities 无依赖（分层铁律）。
 */

export { McpServer, MCP_PROTOCOL_VERSION } from './server.js';
export type {
  McpTool,
  McpToolHandler,
  McpToolResult,
  McpContent,
  McpServerOptions,
  ToolContext,
} from './server.js';

export { McpClient, McpClientError } from './client.js';
export type { McpToolInfo, McpCallResult } from './client.js';

/**
 * @winvm/host-a2a-bridge —— 宿主侧 A2A 委派桥（L3）
 *
 * 补齐"宿主机 Agent → VM 内 AI Agent"的 A2A 一跳：
 *   宿主 Agent --MCP--> 本桥（stdio MCP server） --A2A v1.0--> VM 侧 vm-service /a2a
 *
 * 宿主 Agent 通常只具备 MCP client 能力，无法直接发起 A2A；本桥以本地
 * stdio MCP server 形式提供委派工具，把 A2A 的进度 / 产物 / 审批事件翻译回 MCP 结果。
 */

export {
  A2AClient,
} from '@winvm/a2a-framework';

export {
  createA2aClient,
  createLazyClientProvider,
  type A2aClientHandle,
  type A2aDelegateClient,
  type CreateA2aClientOptions,
  type DelegateStreamOptions,
} from './client.js';

export {
  createA2aBridgeTools,
  extractApproval,
  extractText,
  buildA2aResumeHint,
  withA2aResumeHint,
  APPROVAL_PRESENTATION_DIRECTIVE,
  withPresentationDirective,
  type A2aBridgeToolOptions,
  type ExtractedApproval,
} from './tools.js';

export {
  canonicalJson,
  hashApprovalPreview,
  recordHostApprovalAudit,
  lookupByApprovalId,
  lookupByTraceId,
  _resetAuditIndex,
  CREDENTIAL_KEY_RE,
  REDACTED,
  redactCredentials,
  type HostApprovalAudit,
} from './approval-audit.js';

export { startStdioBridge, type StdioBridgeOptions } from './stdio.js';
export { buildTransport, main } from './cli.js';

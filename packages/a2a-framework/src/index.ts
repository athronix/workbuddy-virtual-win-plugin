/**
 * @winvm/a2a-framework —— A2A v1.0 架构框架（L1b）
 *
 * 提供：Agent Card 生成、Task 状态机、message/send、message/stream(SSE)、
 *       tasks/get、tasks/list、tasks/cancel、tasks/subscribe、
 *       artifact 管理、input-required 审批闸、宿主侧委派客户端。
 *
 * 依赖铁律：仅依赖 @winvm/contracts 与 @winvm/core，禁止依赖 adapter。
 */

export {
  A2AServer,
  InvalidParamsError,
} from './server.js';
export type { AgentCardInput, A2AGoalHandler, A2AServerOptions } from './server.js';

export {
  TaskStore,
  TaskNotFoundError,
  TaskNotCancelableError,
  createProgressSink,
} from './task-store.js';
export type {
  ApprovalResolution,
  ApprovalTimeoutInfo,
  InternalTask,
  ListFilter,
  ListResult,
  PendingApproval,
  TaskStoreOptions,
} from './task-store.js';

export { A2AClient, A2AClientError } from './client.js';
export type { SendMessageOptions } from './client.js';

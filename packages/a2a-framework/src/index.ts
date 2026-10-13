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
export type {
  AgentCardInput,
  A2AGoalHandler,
  A2AServerOptions,
  /** K-N1（纯附加）：委派观测点契约 —— vm-service 实现壳双态审计，框架零审计语义 */
  DelegationObserver,
  DelegationTerminalSnapshot,
} from './server.js';

export {
  TaskStore,
  TaskNotFoundError,
  TaskNotCancelableError,
  createProgressSink,
} from './task-store.js';
// R-5（Phase 3 批5，纯附加）：cancel 风暴门禁（滑动窗口限流器）
export { CancelRateLimiter } from './rate-limiter.js';
export type { CancelRateLimit } from './rate-limiter.js';
export type {
  ApprovalResolution,
  ApprovalTimeoutInfo,
  InternalTask,
  ListFilter,
  ListResult,
  PendingApproval,
  TaskStoreOptions,
  /** P2-T7（L1，纯附加）：驱逐闸门 / 单条驱逐事实（有界环形日志成员 = onEviction 入参） */
  EvictionGate,
  EvictionRecord,
} from './task-store.js';

export { A2AClient, A2AClientError } from './client.js';
export type { SendMessageOptions } from './client.js';

/**
 * @winvm/vm-service —— VM 侧标准 Agent 服务（L2）
 *
 * 统一暴露 MCP（主干）与 A2A v1.0（委派）双通道，二者共享同一内核：
 *   能力注册表 → 策略引擎 → 审批闸 → 审计链 → 桥接层 → 能力执行
 */

export { createService } from './server.js';
export type { ServiceRuntime, PendingApproval } from './server.js';
/** K4：导出审批协调器（供单测验证安全闸；生产由 createService 内部实例化并注入） */
export { VmApprovalCoordinator } from './server.js';
/** K5：导出重放函数形状与纯逻辑件（可脱离 HTTP 服务与 ps-bridge 单测） */
export type { ReplayFn } from './server.js';
export {
  collectApprovalFacts,
  deriveUnderlying,
  recordBlockedApprovalAudit,
  toExecutedResult,
} from './approval-replay.js';
export type {
  BlockedAuditInput,
  PendingApprovalLike,
  SegmentResultLike,
} from './approval-replay.js';
/** CL-K3R：未决审批事实的契约类型（桥侧判据与单测引用同一形状，避免类型漂移） */
export type { ApprovalWaitQuery, PendingApprovalFact } from '@winvm/contracts';
/** K-N1：委派层审计真实性的服务端纯逻辑件（账本 / 壳双态条目 / 回执缓存 / sink 装饰器；可脱离 HTTP 服务与 ps-bridge 单测） */
export {
  buildDelegationAuditEntry,
  buildReceiptResponse,
  clipReceipt,
  DelegationLedger,
  DELEGATION_CAPABILITY_ID,
  LedgerRegistry,
  MAX_GOAL_CHARS,
  MAX_RECEIPT_DATA_CHARS,
  MAX_RECEIPT_ENTRIES,
  MAX_STEPS_SUMMARY,
  MAX_SUMMARY_CHARS,
  MAX_UNDERLYING_ITEMS,
  ReceiptCache,
  SHELL_CAPABILITY_ID,
  wrapAuditSink,
} from './delegation-audit.js';
export type {
  BlockedEntry,
  DelegationAuditEntryInput,
  DelegationStepLike,
  ReceiptEntry,
  WildEntry,
} from './delegation-audit.js';
export {
  providerHealthTimeoutSnapshot,
  raceHealthSubProbes,
  raceSessionProbe,
  raceWithTimeout,
  resolveHealthProbeTimeoutMs,
  resolvePsBridgeHealthState,
  timeoutSessionSnapshot,
} from './health-probe.js';
export type {
  HealthSubProbesOutcome,
  RaceOutcome,
  SessionProbeOutcome,
} from './health-probe.js';
export { DEFAULT_SERVICE_CONFIG, loadServiceConfig } from '@winvm/core';
export type { ServiceConfig } from '@winvm/core';

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
  deriveUnderlying,
  recordBlockedApprovalAudit,
  toExecutedResult,
} from './approval-replay.js';
export type { BlockedAuditInput, SegmentResultLike } from './approval-replay.js';
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

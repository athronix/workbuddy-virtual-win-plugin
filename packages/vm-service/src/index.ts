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
  recordPolicyDeniedAudit,
  toExecutedResult,
  /** ARCH-05 / ARCH-06（T4）：审批决策取证件 + 启动归档校验条目构造器 */
  buildChainArchiveVerifyAuditEntry,
  recordApprovalDecisionAudit,
} from './approval-replay.js';
export type {
  BlockedAuditInput,
  BlockedAuditOptions,
  PendingApprovalLike,
  PolicyDeniedAuditInput,
  SegmentResultLike,
  /** ARCH-05 决策枚举与出口形状（桥/单测引用同一形状，避免类型漂移） */
  ApprovalDecision,
  ApprovalDecisionAuditInput,
  ApprovalDecisionSink,
  ChainArchiveVerifyAuditInput,
} from './approval-replay.js';
/**
 * ARCH-07 / ENG-05（T4）—— 服务端 bearer 守卫（**纯函数模块**，豁免表硬编码不可配）。
 * 再导出的唯一目的是让判据可脱 ps-bridge 直测：本沙箱内 `createService` 会 spawn
 * PowerShell 桥并触发 V8 fatal ⇒ 装配层入口不是可用测试面（与 `approval-replay` /
 * `health-probe` / `delegation-audit` 同一纪律）。
 */
export {
  BEARER_UNAUTHORIZED_BODY,
  buildSecurityHealth,
  createBearerGuard,
  DEFAULT_EXEMPT_PATHS,
  isLoopbackHost,
  resolveAuthMode,
  resolveBearerToken,
  /** Phase 2 · P2-T5（F2 Step 1）：bearer 生效自检纯函数四件套（决策表/回连三态/挂载求值/链上条目）。 */
  runBearerMountSelfCheck,
  resolveInnerReconnect,
  shouldFailClosedStart,
  buildBearerSelfCheckAuditEntry,
} from './http-guard.js';
/**
 * Phase 2 · P2-T6（F2 Step 2）—— VM 内回连**运行期探针**（自环一次带凭据回连，
 * 把 `/health.security.innerReconnect` 从「配置面推理」升级为「实证 ok/broken」）。
 * 与 http-guard 同一纪律：判决映射为可注入 fetch 的纯 I/O 边界 ⇒ 全分支离线可测，
 * 真机端到端由 `qa/r19/t6-*` 另证。
 */
export { probeInnerReconnect, probeInitializeBody } from './inner-reconnect-probe.js';
export type {
  InnerReconnectProbeInput,
  ProbeFetch,
  ProbeFetchResponse,
} from './inner-reconnect-probe.js';
export type {
  BearerGuardOptions,
  BearerSelfCheckCode,
  BearerSelfCheckHealth,
  InnerReconnectStatus,
  InnerReconnectHealth,
  GuardableRequest,
  GuardDenyReason,
  GuardVerdict,
  GuardWarnSink,
  HealthAuthMode,
} from './http-guard.js';
/**
 * Phase 2 · P2-T7（F3 / L1）—— TaskStore **驱逐**的链上取证（`ext.kind:'task-evicted'`）。
 * 与 http-guard / inner-reconnect-probe 同一纪律：条目构造是纯函数 ⇒ 判据可脱服务直测；
 * 投递器只做「突发合并 + 原始 sink fire-and-forget」，零定时器零 I/O 依赖注入 ⇒ 离线全分支可测。
 */
export {
  buildTaskEvictedAuditEntry,
  createTaskEvictedChainRecorder,
  TASK_EVICT_SAMPLE_LIMIT,
} from './task-evict-audit.js';
export type {
  TaskEvictedAuditEntry,
  TaskEvictedAuditInput,
  TaskEvictedChainOptions,
  TaskEvictedChainRecorder,
} from './task-evict-audit.js';
/**
 * ENG-01（T4）—— MCP 续跑令牌表的**有界化**登记处（裸 `Map` 的窄同签名替身 + TTL 清扫器）。
 * 同样为纯数据结构，零审计依赖（被逐条目回传调用方，由装配层落 `timeout` 决策）。
 */
export { PendingApprovalRegistry } from './pending-approvals.js';
export type {
  ApprovalTokenMap,
  PendingApprovalRegistryOptions,
  RegistryTimerHandle,
  SweeperEntry,
  TimerClear,
  TimerFactory,
} from './pending-approvals.js';
/** CL-K3R：未决审批事实的契约类型（桥侧判据与单测引用同一形状，避免类型漂移） */
export type { ApprovalWaitQuery, PendingApprovalFact } from '@winvm/contracts';
/** K-N1：委派层审计真实性的服务端纯逻辑件（账本 / 壳双态条目 / 回执缓存 / sink 装饰器；可脱离 HTTP 服务与 ps-bridge 单测） */
export {
  buildDelegationAuditEntry,
  buildReceiptResponse,
  bypassTagSink,
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

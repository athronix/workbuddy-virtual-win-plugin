/**
 * 批1 纯判据的 vm-service 侧**再导出垫片**（单源在 `@winvm/core/policy-gate`）。
 *
 * 为什么需要垫片：判据有两个消费方——本包 server.ts（MCP handler）与
 * `adapter-agent-workbuddy`（deterministic step 咽喉点）。依赖方向铁律禁止
 * adapter → vm-service，故权威源沉到 core；本垫片保持 `@winvm/vm-service`
 * 的既有导出面（`index.ts` re-export 与单测 import 路径零改动），对齐
 * `chain.ts` 的 `export type { ArchiveVerification }` 再导出打法。
 */
export {
  isInnerDelegation,
  scopeLookupKeys,
  shouldReturnDelegationRequired,
  scopeFeedEnabled,
  isScopeGateRejection,
  enforceScopeRejection,
  isDirectWithActiveTurn,
  buildPolicyGateHealth,
} from '@winvm/core';
export type {
  ChannelProbeInput,
  DelegationRequiredInput,
  ScopeFeedInput,
  PolicyGateHealthView,
} from '@winvm/core';

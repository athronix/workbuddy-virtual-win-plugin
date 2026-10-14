/**
 * 批1（审批闭环 P0-1 专项）—— (c) 策略化与委派 scope 回查的**纯决策判据**。
 *
 * 为什么单列模块：`(c)` 收口与「委派内层 vs 宿主直调」判据都长在 `createService` 里，
 * 而 `createService` 在本沙箱 spawn ps-bridge ⇒ V8 fatal，无法直接起服务单测（既有
 * 测试面 `phase1-t4-assembly` / `k5-replay` 都因此走「纯函数 + 源码文本钉」三条腿）。
 * 把**决策逻辑**抽成零副作用纯函数 ⇒ 判据可脱服务逐条断言（对齐 `http-guard.ts` /
 * `capabilities-profile.ts` 既有惯例）；`server.ts` 只做装配与调用。
 */

import type { RiskLevel } from '@winvm/contracts';

/** 通道判据输入（全部服务端事实，绝不采信调用方自报）。 */
export interface ChannelProbeInput {
  /** `/mcp?dtid=` 解析的委派 traceId（单次 -p / 旧版桥带标时在场） */
  readonly delegationId?: string;
  /** 协调器当前活动委派任务 id（常驻形态 dtid 不生效时唯一可用证据） */
  readonly activeTaskId?: string;
}

/**
 * 「本次调用是否来自委派内层回连」的通道判据（批1 (c)/F-2 的共同地基）。
 *
 * dtid ∨ activeTaskId 任一在场 ⇒ 委派内层（走 scope 回查 + 注册令牌审批流）；
 * 两者都缺席 ⇒ 纯宿主直调（命中审批闸时收口「须走委派」）。
 *
 * fail-safe 性（设计自查，务必保持）：误判**只可能**是「纯宿主直调恰撞并发委派 turn
 * 的毫秒窗口被当成内层」——该方向**不放宽任何放行**（审批闸与 K4 hostApproved 照旧），
 * 最坏退化为逐字旧行为。反方向（内层被判直调）在常驻形态不可能发生：`beginTask`/`endTask`
 * 包裹整个委派 turn（常驻会话物理串行 ⇒ 同刻至多一个活动 turn），与 raise 的
 * input-required 挂接读的是**同一份 activeTaskId 事实**，不新增串台面。
 */
export function isInnerDelegation(input: ChannelProbeInput): boolean {
  return input.delegationId !== undefined || input.activeTaskId !== undefined;
}

/** scope 回查的键选择（dtid 优先；常驻形态回退活动槽 taskId）。 */
export function scopeLookupKeys(
  input: ChannelProbeInput,
): { taskId?: string; delegationTraceId?: string } {
  if (input.delegationId) return { delegationTraceId: input.delegationId };
  if (input.activeTaskId) return { taskId: input.activeTaskId };
  return {};
}

/** (c) 收口触发判据。 */
export interface DelegationRequiredInput {
  /** 是否委派内层（isInnerDelegation 结果） */
  readonly inner: boolean;
  /** 策略引擎裁决 requiresApproval（命中审批闸） */
  readonly requiresApproval: boolean;
  /** WINVM_DELEGATION_REQUIRED_POLICY 解析结果（缺省 true） */
  readonly policyEnabled: boolean;
}

/**
 * 该调用是否应收口为 `DELEGATION_REQUIRED`（而非注册死令牌）。
 *
 * 命中条件 = **纯宿主直调 ∧ 审批闸 ∧ 策略开启**。委派内层**绝不**收口（它要继续走
 * 注册令牌 → input-required → 宿主批准 → 服务端重放的验收绿闭环）；策略 off ⇒ 退回
 * 旧死令牌行为（回滚保险）。
 */
export function shouldReturnDelegationRequired(input: DelegationRequiredInput): boolean {
  return !input.inner && input.requiresApproval && input.policyEnabled;
}

/** 双闸灰度对 scope feed 的裁决。 */
export interface ScopeFeedInput<S> {
  readonly wiring: 'off' | 'shadow' | 'on';
  readonly scope: S | undefined;
}

/**
 * 是否把宿主声明的 scope 两键喂进策略评估。
 * `off` ⇒ 恒空 feed（逐字旧行为）；scope 缺席 ⇒ 空 feed（无声明）；否则原样透传。
 * 泛型 S 仅为让调用方传 DelegationScopeEntry，本模块不感知其内部结构（依赖最小化）。
 */
export function scopeFeedEnabled<S>(input: ScopeFeedInput<S>): boolean {
  return input.wiring !== 'off' && input.scope !== undefined;
}

/** shadow 改道判据：拒绝是否**恰因** scope 两闸（而非黑名单/未注册等固有拒绝）。 */
export function isScopeGateRejection(matchedRule: string | undefined): boolean {
  if (!matchedRule) return false;
  return (
    matchedRule.startsWith('scope:capability-not-in-allowed-set') ||
    matchedRule.startsWith('maxRisk:')
  );
}

/**
 * 三态灰度下最终是否执法一次 scope 拒绝。
 *  - `on`：执法（true）。
 *  - `shadow`：不执法（false ⇒ 调用方按无 scope 基线重评放行，仅计数观测）。
 *  - `off`：根本不喂 scope，不会走到这里（防御性返回 true）。
 * `requiresApproval`（审批闸）**绝不**属于 scope 执法范畴，调用方须先排除再问本函数。
 */
export function enforceScopeRejection(wiring: 'off' | 'shadow' | 'on'): boolean {
  return wiring !== 'shadow';
}

/** 供 /health 与观测透出：把内部计数换算成稳定可读形状。 */
export interface PolicyGateHealthView {
  readonly wiring: 'off' | 'shadow' | 'on';
  readonly shadowHits: number;
  readonly delegationRequiredPolicy: boolean;
  readonly scopeEntries: number;
}

export function buildPolicyGateHealth(
  wiring: 'off' | 'shadow' | 'on',
  shadowHits: number,
  delegationRequiredPolicy: boolean,
  scopeEntries: number,
): PolicyGateHealthView {
  return { wiring, shadowHits, delegationRequiredPolicy, scopeEntries };
}

/** RiskLevel 再导出（便于单测构造夹具，避免各处重复 import 具体清单）。 */
export type { RiskLevel };

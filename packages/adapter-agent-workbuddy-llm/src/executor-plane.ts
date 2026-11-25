/**
 * **执行面**（executor plane）—— 本包真正需要执行体提供的能力子集（Step 4.4 收口）。
 *
 * ## 为什么不再直接引用 `AgentServiceProvider`
 *
 * 改动前，`WorkbuddyLlmProvider.executor` 与 `CliAgentPlannerDeps.executor` 的类型都是
 * 完整的 `AgentServiceProvider`（`contracts/src/bridge.ts`）。实测本包对它的消费面只有
 * **5 个方法**：
 *
 * | 成员 | 谁在用 |
 * |---|---|
 * | `init(ctx)` | `WorkbuddyLlmProvider.init()` 转交给底层执行器 |
 * | `execute(req)` | `WorkbuddyLlmProvider.execute()` 直接转发（本包不实现执行语义） |
 * | `health()` | 取底层桥健康态作为自身 health 的底座 |
 * | `shutdown()` | 服务退出时释放底层执行器 |
 * | `runGoal(goal, sink)` | D-4.4 降级路径：CLI 不可用时回落确定性执行 |
 *
 * 而 `AgentServiceProvider` 还有 `declareCapabilities()` / `kind` / `displayName` /
 * `warmup()` / `llmSessionHealth()` / `llmSessionReset()` / `llmSessionInjectFault()`。
 * 这些**本包一个都不用** —— 却因此被死死绑在「我必须是个 provider」这个身份上。
 *
 * 这正是阶段 4 要纠正的**抽象层级错配**（`13` §5.1b）：路径 2 的执行主体是
 * VM 内 native agent，它本来就不该承担「provider 三选一」的身份。把类型收窄到
 * 实际消费面，等 `DeterministicAgentProvider` 将来也摘掉 provider 身份时，
 * 本包**不需要跟着改** —— 这是收窄带来的真实解耦，不是为了让某个 grep 计数归零。
 *
 * ## 为什么叫「plane」而不是「interface」
 *
 * 本仓已有先例：`vm-service/src/capabilities-profile.ts` 用「结构子集」避免全量依赖
 * （其注释原文：「只依赖 SPI 的可选成员与方法，避免全量 AgentServiceProvider 依赖
 * （易测 + 低耦合）」）。同名同法，保持一处口径。
 *
 * ## 结构同构，不是新契约
 *
 * 本类型**不新增任何成员**，是 `AgentServiceProvider` 的严格结构子集 ⇒ 现有
 * `DeterministicAgentProvider`（仍 implements 完整 SPI，因为服务端装配面还需要它）
 * 与单测里的 mock 都能直接赋值，零改动兼容。
 */

import type {
  BridgeContext,
  CapabilityRequest,
  CapabilityResult,
  GoalRequest,
  GoalResult,
  HealthStatus,
  ProgressSink,
} from '@winvm/contracts';

export interface ExecutorPlane {
  /** 与执行体建立连接（本包只做转交，不自行初始化）。 */
  init(ctx: BridgeContext): Promise<void>;
  /** 执行一个**确定动作**（安全语义恒确定性 —— 本包不实现自己的执行路径）。 */
  execute(req: CapabilityRequest): Promise<CapabilityResult>;
  /** 底层健康快照（本包把它作为自身 health 的底座）。 */
  health(): Promise<HealthStatus>;
  /** 释放底层资源（服务退出路径）。 */
  shutdown(): Promise<void>;
  /**
   * D-4.4：CLI 不可用时的**降级路径** —— 把目标交给确定性执行器重跑。
   *
   * ⚠ 这条不是「可选优化」：`shouldDegrade` 判据触发时若没有它，委派会以
   * 「运行时不可用」直接失败，而本包承诺的是「降级到模板执行」。故它必须在
   * 窄接口里（不能为了「更窄」而把它剔出去 —— 那会让降级变成类型错误）。
   */
  runGoal(goal: GoalRequest, sink: ProgressSink): Promise<GoalResult>;
}
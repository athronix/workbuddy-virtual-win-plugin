/**
 * `Planner` 契约 —— 「谁来把事情想清楚」的**单一抽象**。
 *
 * ## 为什么要引入这一层（阶段 4 的全部动机）
 *
 * 改前 `AgentServiceProvider`（`bridge.ts:829`）一个接口扛了**五件事**：
 * `declareCapabilities` / `init` / `execute` / `runGoal` / `health` / `shutdown`，
 * 外加两个 LLM 专用可选成员（`warmup` / `llmSessionHealth`）。后果是两个实现
 * 都被迫实现一堆自己用不上的方法：
 *
 * | 实现 | 其实只需要 | 实际必须实现 |
 * |---|---|---|
 * | `workbuddy-deterministic` | 按模板走步骤（`runGoal`） | init/execute/health/shutdown/declareCapabilities |
 * | `workbuddy`（VM 内 CLI） | 把目标交给 codebuddy native agent | 同上 + warmup + llmSessionHealth |
 *
 * `Planner` 只保留**一件**事：`plan(goal, sink) → Result`。
 *
 * ## ★ `id` 为什么是 `'cli-agent'` 而不是 `'llm'`（这条很关键，别改回去）
 *
 * 路径 2 的执行主体是 **VM 内 codebuddy-lite native agent**，不是「宿主按配置去调某个
 * LLM API」。叫 `'llm'` 会把下一个维护者引到「这只是个 LLM API 适配器」的误读上，
 * 进而觉得「删掉它也没关系」—— 而实际上删掉它等于**砍掉整个路径 2**。
 * 名字本身就是防误读的文档。
 *
 * 同理 `'template'` 不叫 `'deterministic'`：`deterministic` 描述的是**行为特征**
 * （可复现），而 `template` 描述的是**机制**（按预置模板展开），后者才是它的实现方式。
 *
 * ## 与 `AgentServiceProvider` 的关系（阶段 4 的过渡态）
 *
 * 阶段 4 结束时：`Planner` 是**执行体的唯一契约**，`AgentServiceProvider` 降为
 * 「服务装配层的外壳」（只负责 `init`/`health`/`shutdown` 这类生命周期活），
 * 其 `runGoal` 变成 `this.planner.plan(...)` 的一行转发。
 *
 * ⚠ **`plan()` 不是 `runGoal()` 的改名**，两者的差异是有意的：
 * - `runGoal` 是 provider 的一等公民，provider 可以「边想边做」；
 * - `plan` 明确「我负责产出执行计划与结果」，**不持有**服务生命周期，
 *   因此可以脱离 `init(ctx)` 被单测直接驱动。
 */

import type { GoalRequest, GoalResult, ProgressSink } from './bridge.js';

/**
 * 规划器标识。
 *
 * - `'template'`：确定性模板展开（无 LLM 参与，可完全复现）。
 * - `'cli-agent'`：把目标交给 VM 内的 codebuddy native agent 执行（路径 2）。
 *
 * 这两个值是**配置面的枚举取值**（`ServiceConfig.agent.planner`），改动即配置断裂。
 */
export type PlannerId = 'template' | 'cli-agent';

/**
 * 「谁来把事情想清楚」的单一抽象。
 *
 * 实现方只需回答一个问题：**给定目标与进度出口，产出什么结果**。
 * 不承担 `init` / `health` / `shutdown` —— 那些属于服务装配层。
 */
export interface Planner {
  /** 见 `PlannerId` 的取值说明。 */
  readonly id: PlannerId;

  /**
   * 规划并执行一个目标。
   *
   * 契约要点（三条都是**既有行为**的固化，不是新增要求）：
   * 1. **必须通过 `sink` 汇报进度**，不得静默执行完毕 —— 破除「委派黑盒」（NFR-509）。
   * 2. **不得抛出未捕获异常**：失败一律折成 `GoalResult.ok=false` + `error`。
   *    （抛异常会让服务端的委派观察者拿不到终态，任务永久挂起。）
   * 3. `sink.onApprovalRequired` 返回 `false` 时**必须中止**，不得继续执行。
   */
  plan(goal: GoalRequest, sink: ProgressSink): Promise<GoalResult>;
}
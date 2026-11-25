/**
 * `CliAgentPlanner` —— 把 `WorkbuddyLlmProvider.runGoal` 包成 `Planner` 契约（Step 4.3）。
 *
 * ## 这一步到底在做什么（最容易被误读，先说清）
 *
 * **不是**「把 LLM 能力降级／削减」。路径 2 的执行主体是
 * **VM 内 codebuddy-lite native agent**（owner 2026-11-24 澄清 3）——
 * 宿主把目标交给它，它在 VM 里自己规划并操作 Windows。
 *
 * 所以本步做的只有一件事：**换外壳**。
 * - 改前：provider 是「执行体」，`runGoal` 是它的一等公民；
 * - 改后：planner 是「执行体」，provider 退成生命周期外壳（`init`/`health`/`shutdown`）。
 *
 * ## ★ 红线：`bridge.ts` / `persistent-session.ts` 一行都不能动
 *
 * 那 1993 + 1144 行是**真正干活的部分**（CLI 进程管理、常驻会话、MCP 配置注入、
 * 审批协调、真值反查）。任何导致它们变短的改法都是错的 —— 那不是「降级」，是「删除」。
 *
 * ## 为什么 `plan()` 里几乎全是转发
 *
 * 因为 `runGoal` 的 180 行里有大量**已验证的安全语义**（D-4.4 降级、D-6 抑制降级、
 * K-N1 disabled 拒绝、P2-T10 不降级码集）。这些不是「顺手的逻辑」，是踩出来的判据。
 * 本步纪律 = **逐字搬移**，不重构、不优化、不合并分支。
 *
 * ## 依赖面为什么比 `TemplatePlanner` 宽（10 项 vs 5 项）
 *
 * 因为 LLM 路径本身更复杂：它要读 `ctx.capabilities` 目录、要载入技能文档、
 * 要经委派账本反查（`probe`）、要回落确定性执行器（`executor`）。
 * 这些都是它**真实需要的**，不是可以硬砍的装饰。
 */

import {
  type BridgeContext,
  type DelegationActivityCount,
  type DelegationTruthProbe,
  type GoalRequest,
  type GoalResult,
  type LlmSessionHealth,
  type Planner,
  type PlannerId,
  type ProgressSink,
  makeError,
} from '@winvm/contracts';
import type { ExecutorPlane } from './executor-plane.js';

import type { LlmBridge, LlmGoalResult, LlmSkillDoc } from './bridge.js';
import { evaluateDisabledRejection } from './delegation-truth.js';

/**
 * `CliAgentPlanner` 的依赖面。
 *
 * 每一项都是 provider 的**现有成员**（没有新增能力，只有转发）——
 * 这本身就是「纯搬移」的证据：如果本步真的削减了能力，这里必然会出现新字段。
 */
export interface CliAgentPlannerDeps {
  /** `init()` 之后的 BridgeContext。未 init 时抛错（与 `runGoal` 原行为逐字一致）。 */
  readonly ctx: BridgeContext | undefined;

  /** CLI 桥（真正调起 VM 内 codebuddy 的地方，`bridge.ts`）。 */
  readonly bridge: LlmBridge;

  /** 确定性执行器 —— D-4.4 降级时的兜底（同时也是 `NON_DEGRADABLE_CODES` 的对侧）。 */
  readonly executor: ExecutorPlane;

  /** 委派账本探针（K-N1 / D-6）；缺席即旧行为。 */
  readonly probe: DelegationTruthProbe | undefined;

  readonly cliPath: string;
  readonly endpoint: string;
  readonly outputDir: string;
  readonly skillsRoot: string;

  /** 载入下发的技能规范（provider 的模块级函数，注入以便单测替换）。 */
  loadSkillDocs(root: string): Promise<LlmSkillDoc[]>;

  /** D-6：反查本委派回合服务端是否真有过活动。 */
  delegationActivityFor(goal: GoalRequest): Promise<DelegationActivityCount | undefined>;

  /** D-4.4：该结果是否应降级为确定性执行器（P2-T10 判据）。 */
  shouldDegrade(res: LlmGoalResult): boolean;
}

/** 不降级的契约码 / 领域原因码集合（与 provider 的 `NON_DEGRADABLE_CODES` **同源**）。 */
export type NonDegradableCodes = readonly string[];

/**
 * `'cli-agent'` 规划器：把目标交给 VM 内 codebuddy native agent。
 *
 * ⚠ `id` 必须是 `'cli-agent'`，**不是** `'llm'` —— 见 `contracts/src/planner.ts` 的说明。
 */
export class CliAgentPlanner implements Planner {
  readonly id: PlannerId = 'cli-agent';

  constructor(private readonly deps: CliAgentPlannerDeps) {}

  /**
   * 规划并执行（`runGoal` 的逐字搬移）。
   *
   * 方法体与 `WorkbuddyLlmProvider.runGoal` **完全等价**，包括：
   * 1. K-N1 §4.1 `disabled` 入口显式拒绝（先于任何桥调用）；
   * 2. 载入技能规范并经 `sink` 报进度；
   * 3. 调 `bridge.runGoal(...)` 透传 taskId / probe / warn / skills；
   * 4. 失败时 **D-6** 反查服务端是否已有活动（有活动 ⇒ **抑制降级**，别把已执行的事实改写掉）；
   * 5. 否则按 **D-4.4** 降级为确定性执行器，并把 LLM 侧真实收口码经 `details.degradedFrom*`
   *    与 summary **双通道**透出（否则链上只剩兜底码，真实病因永久丢失）；
   * 6. 成功/失败都把 `degraded` / `approvalTruth` 透传出去（服务端 observer 落审计的唯一来源）。
   */
  async plan(goal: GoalRequest, sink: ProgressSink): Promise<GoalResult> {
    const ctx = this.deps.ctx;
    if (!ctx) throw new Error('provider 尚未 init');

    /* ---- K-N1 §4.1：disabled 入口显式拒绝（先于任何桥调用） ----
     * 三态判定（纯函数 `evaluateDisabledRejection`，12 例真值表见 §9-A-3）：
     *   仅 (A2A 委派 taskId) && (persistent=true 部署态) && (会话 state='disabled') → 拒绝。
     * 拒绝**不进 bridge.runGoal**、也**不进 shouldDegrade 分支**（§4.3：确定性模板不因此
     * 失去委派入口）；A2A 框架据 result.ok=false 收口 `failed`，宿主在 message/send 响应
     * 直接拿到原因码 —— 零静默。delegation.complete 由服务端 observer 统一收口
     * （terminalState=failed, errorCode=LLM_SESSION_DISABLED, zeroInnerCalls:true）——
     * 设计 §4.1 写「rejected」，但框架 `result.ok=false → failed` 是唯一收口路径（拍板点：
     * 走 failed 收口），终态口径差异登记为偏差。
     */
    const session = this.deps.bridge.sessionHealth?.();
    const persistent = this.deps.bridge.isPersistentEnabled?.() ?? false;
    const rejection = evaluateDisabledRejection({
      hasTaskId: goal.taskId !== undefined,
      persistent,
      ...(session ? { sessionState: session.state } : {}),
    });
    if (rejection.reject) {
      const detail = session?.lastError ? `（最近错误：${session.lastError}）` : '';
      ctx.logger.warn('K-N1：disabled 委派显式拒绝（LLM_SESSION_DISABLED）', {
        taskId: goal.taskId,
        traceId: goal.traceId,
        restarts: session?.restarts ?? 0,
        lastErrorAt: session?.lastErrorAt ?? '',
      });
      return {
        ok: false,
        summary: `委派通道不可用：LLM 常驻会话已停用${detail}`,
        artifacts: [],
        steps: [],
        error: makeError('PROVIDER_UNAVAILABLE', 'LLM 常驻会话 disabled，拒绝降级委派', {
          reason: 'LLM_SESSION_DISABLED',
          details: { restarts: session?.restarts ?? 0, ...(session?.lastErrorAt ? { lastErrorAt: session.lastErrorAt } : {}) },
        }),
      };
    }

    const catalog = ctx.capabilities.list();
    sink.onStatus('working', `WinVM WorkBuddy LLM Agent 接管目标：${goal.goal}`);

    // 加载下发的技能规范，作为 VM 内 Agent 的操作指引
    const skills = await this.deps.loadSkillDocs(this.deps.skillsRoot);
    if (skills.length > 0) {
      sink.onStatus('working', `已载入 ${skills.length} 份技能规范：${skills.map((s) => s.id).join(', ')}`);
    }

    const res = await this.deps.bridge.runGoal(
      {
        goal: goal.goal,
        capabilities: catalog,
        outputDir: this.deps.outputDir,
        cliPath: this.deps.cliPath,
        endpoint: this.deps.endpoint,
        traceId: goal.traceId,
        timeoutMs: goal.timeoutMs || 300_000,
        // K4：把 A2A 任务 id 透传给桥接层，使其能经审批协调器把 input-required 挂到正确任务。
        ...(goal.taskId ? { taskId: goal.taskId } : {}),
        // 批10 N-7（F-5 收口）：P1-Fix 时代的 maxRisk 透传已退役——合成步骤 risk 改取
        // 注册表权威值（bridge.ts WORKFLOW_RUN_RISK），桥内零消费；封顶的执法通路在
        // scope 留存→evaluate（批1 F-2/F-3），不在展示面复用。
        // K-N1：逐调用下传账本探针（缺席即桥门 4 透传，零回归）与服务 logger 告警出口
        ...(this.deps.probe ? { probe: this.deps.probe } : {}),
        warn: (msg: string, meta?: Record<string, unknown>): void => ctx.logger.warn(msg, meta ?? {}),
        ...(skills.length > 0 ? { skills } : {}),
      },
      sink,
    );

    if (!res.ok) {
      // D4.4 降级：LLM 运行时不可用（ENOENT / 非零退出且无产物）时，回落到确定性执行器的
      // 内置模板（runGoal），而不是直接失败 —— 让「委派」在有确定性模板可覆盖时仍能完成任务。
      // 仅当确定性执行器也报 UNSUPPORTED_GOAL（无匹配模板）时才算真正失败。
      //
      // K-N1 边界（必须排除，否则把「假完成」洗白成「降级重试成功」）：
      //  1) 委派账本反查改判（reason=NO_EXECUTION_RECEIPT）不降级 —— 改判本身**就是终态**；
      //  2) disabled 拒绝（reason=LLM_SESSION_DISABLED）同理不进此分支（已提前 return）。
      // K5 的 REPLAY_FAILED 等既有 reason 行为不变（保持 D4.4 原语义）。
      //
      // **D-6（P2·实弹，2026-10-17 真机实证）**：降级前**必须**反查「本委派回合服务端是否
      // 真有过活动」。实证场景（`qa/p5-batch/b16/VERDICT.md`）：委派经审批放行后，服务端
      // 确定性重放**真实执行**了能力并写入诚实折叠回执（链 seq=20：`ok=false` /
      // `EXECUTION_FAILED` / K6 核验未过），但 LLM 侧收口为 `ok=false` 且零产物 ⇒ 命中本
      // 降级分支 ⇒ 确定性兜底既不复用服务端重放结果、也不知悉"已执行"事实，其失败文案成为
      // 终态 summary ⇒ **宿主读到「未匹配到模板」而真实卸载早已发生**（destructive 能力尤危），
      // 且链上 `delegation.complete` 的错误码被替换成兜底的 `UNKNOWN_CAPABILITY`，真实病因
      // 永久丢失。判据：服务端委派账本对**本 traceId** 有活动记录（executed/blocked/wild
      // 任一非零）⇒ 该回合确实到过服务端 ⇒ 降级只会把已发生的事实改写掉，故抑制降级。
      if (this.deps.shouldDegrade(res) && res.error?.reason !== 'NO_EXECUTION_RECEIPT') {
        const activity = await this.deps.delegationActivityFor(goal);
        if (activity && activity.total > 0) {
          const facts =
            `服务端已记录本委派活动（executed=${activity.executed}/blocked=${activity.blocked}/wild=${activity.wild}）`;
          ctx.logger.warn(
            'D-6：服务端已有委派活动证据，抑制降级（避免把已执行事实改写为"未匹配到模板"）',
            {
              taskId: goal.taskId ?? '',
              traceId: goal.traceId,
              llmCode: res.error?.code ?? 'UNKNOWN',
              ...(res.error?.reason ? { llmReason: res.error.reason } : {}),
              executed: activity.executed,
              blocked: activity.blocked,
              wild: activity.wild,
            },
          );
          sink.onStatus('working', `D-6：${facts}，不降级为确定性执行器`);
          return {
            ok: false,
            summary:
              `${res.summary}；${facts}，未降级为确定性执行器` +
              `（真实执行/拦截已发生，详见审计链 traceId=${goal.traceId}）`,
            artifacts: res.artifacts,
            // 与 K5 / K-N1 两条真值判据同构：终态失败时步骤不得保留 ok:true 的完成声称。
            steps: res.steps.map((s) => ({
              ...s,
              ok: false,
              summary: '服务端已记录本委派活动，LLM 侧收口失败（未降级为确定性执行器）',
            })),
            error: res.error,
            ...(res.degraded ? { degraded: res.degraded } : {}),
            ...(res.approvalTruth ? { approvalTruth: res.approvalTruth } : {}),
          };
        }

        sink.onStatus(
          'working',
          `LLM 运行时不可用（${res.error?.code ?? 'UNKNOWN'}），降级为确定性执行器`,
        );
        const fallback = await this.deps.executor.runGoal(goal, sink);
        // D-6(c)：终态 summary **必须**带 LLM 侧真实收口码 —— 否则链上/宿主只看到确定性
        // 兜底的码（`UNSUPPORTED_GOAL`），真实病因被永久抹掉（本轮即因此误判过一次归因）。
        // 兜底错误本体保留为 `error`（既有语义/守卫逐字不变），真实码经 `details.degradedFrom*`
        // 与 summary 双通道透出。
        const llmCode = res.error?.code ?? 'UNKNOWN';
        const llmReason = res.error?.reason;
        const truthTag = `（LLM 侧收口：${llmCode}${llmReason ? `/${llmReason}` : ''}）`;
        return {
          ok: fallback.ok,
          summary: fallback.ok
            ? `已降级为确定性执行：${fallback.summary}${truthTag}`
            : `已降级为确定性执行，但执行器未匹配到模板：${fallback.summary}${truthTag}`,
          artifacts: fallback.artifacts,
          steps: fallback.steps,
          ...(fallback.error
            ? {
                error: {
                  ...fallback.error,
                  details: {
                    ...(fallback.error.details ?? {}),
                    degradedFromCode: llmCode,
                    ...(llmReason ? { degradedFromReason: llmReason } : {}),
                  },
                },
              }
            : {}),
        };
      }
      return {
        ok: false,
        summary: res.summary,
        artifacts: res.artifacts,
        steps: res.steps,
        error: res.error,
        ...(res.degraded ? { degraded: res.degraded } : {}),
        // P2-T8 G-b：归因事实透传（兜底/结构化改判后的失败态同样要能入链计数）
        ...(res.approvalTruth ? { approvalTruth: res.approvalTruth } : {}),
      };
    }
    return {
      ok: true,
      summary: res.summary,
      artifacts: res.artifacts,
      steps: res.steps,
      // K-N1 §4.4：降级事实透传到 GoalResult（服务端 observer 落 ext.downgraded 的唯一来源）
      ...(res.degraded ? { degraded: res.degraded } : {}),
      // P2-T8 G-b：真值判据归因透传到 GoalResult（服务端 observer 落 ext.approvalTruth 的唯一来源）
      ...(res.approvalTruth ? { approvalTruth: res.approvalTruth } : {}),
    };
  }
}

/** `LlmSessionHealth` 的透传形态（`CliAgentPlanner` 自身不持有会话，由 provider 提供）。 */
export type CliAgentSessionHealth = LlmSessionHealth;
/**
 * @winvm/adapter-agent-workbuddy-llm —— VM 内 Agent 适配器（LLM 选型 V1，L2）
 *
 * 实现 AgentServiceProvider SPI 的 **LLM Agent**：
 *   - id = 'workbuddy'，kind = 'llm-agent'
 *   - 承接开放/创意类自然语言任务（如"用 Photoshop 把大山换成海洋"）
 *   - runGoal 经可注入的 LlmBridge（默认 CliLlmBridge 调起 VM 内 WorkBuddy codebuddy CLI）
 *   - execute / health / init / shutdown 委托 DeterministicAgentProvider，
 *     复用同一 ps-bridge 执行链路与安全内核（零重复、零回归）
 *
 * 切换方式：改 `agent.provider='workbuddy'` 一行，框架零改动。
 */

import {
  type AgentServiceProvider,
  type BridgeContext,
  type CapabilityRequest,
  type CapabilityResult,
  type GoalRequest,
  type GoalResult,
  type HealthStatus,
  type ProgressSink,
} from '@winvm/contracts';
import type { PsBridgeOptions } from '@winvm/vm-capabilities';
import { DeterministicAgentProvider } from '@winvm/adapter-agent-workbuddy';

import { CliLlmBridge, type LlmBridge } from './bridge.js';

export const PROVIDER_ID = 'workbuddy';

export interface WorkbuddyLlmProviderOptions {
  /** CLI 名（默认 codebuddy） */
  readonly runtime?: string;
  /** CLI 绝对路径（覆盖 runtime） */
  readonly cliPath?: string;
  /** 本服务 /mcp，供 LLM 运行时回连调用能力 */
  readonly endpoint?: string;
  readonly maxConcurrency?: number;
  /** 产物输出目录（支持 %USERPROFILE% 等环境变量） */
  readonly outputDir?: string;
  /** 注入用：测试注入 mock；生产省略（自动构造 DeterministicAgentProvider） */
  readonly executor?: AgentServiceProvider;
  /** 注入用：测试注入 mock；生产省略（自动构造 CliLlmBridge） */
  readonly bridge?: LlmBridge;
  readonly psBridge?: PsBridgeOptions;
}

export class WorkbuddyLlmProvider implements AgentServiceProvider {
  readonly id = PROVIDER_ID;
  readonly displayName = 'WinVM WorkBuddy LLM Agent (V1)';
  readonly kind = 'llm-agent' as const;

  private ctx: BridgeContext | undefined;
  private readonly executor: AgentServiceProvider;
  private readonly bridge: LlmBridge;
  private readonly cliPath: string;
  private readonly endpoint: string;
  private readonly outputDir: string;

  constructor(opts: WorkbuddyLlmProviderOptions = {}) {
    this.executor =
      opts.executor ?? new DeterministicAgentProvider({ psBridge: opts.psBridge, maxConcurrency: opts.maxConcurrency });
    this.bridge = opts.bridge ?? new CliLlmBridge({ runtime: opts.runtime, cliPath: opts.cliPath, endpoint: opts.endpoint });
    this.cliPath = opts.cliPath ?? opts.runtime ?? 'codebuddy';
    this.endpoint = opts.endpoint ?? 'http://127.0.0.1:18443/mcp';
    this.outputDir = opts.outputDir ?? '%USERPROFILE%\\WinVMWorkspace\\out';
  }

  declareCapabilities(): readonly string[] {
    // 与确定性执行器同域；LLM 比 V1 多做的是"在能力之上叠加语义理解与自主规划"
    return ['meta.*', 'system.*', 'app.*', 'storage.*', 'gui.*', 'appops.*'];
  }

  async init(ctx: BridgeContext): Promise<void> {
    this.ctx = ctx;
    await this.executor.init(ctx);
  }

  async execute(req: CapabilityRequest): Promise<CapabilityResult> {
    return this.executor.execute(req);
  }

  async health(): Promise<HealthStatus> {
    // 健康态由 LLM provider 自身上报身份（id/kind），底层 executor 只是实现细节
    const base = await this.executor.health();
    const bridgeOk = base.provider.state === 'ready';
    return {
      ok: bridgeOk,
      provider: {
        id: this.id,
        state: bridgeOk ? 'ready' : 'degraded',
        ...(bridgeOk ? {} : { detail: '底层 ps-bridge 未就绪，仅 meta 能力可用' }),
      },
      session: base.session,
      ...(base.psBridge ? { psBridge: base.psBridge } : {}),
      ...(base.capabilities ? { capabilities: base.capabilities } : {}),
      ...(base.audit ? { audit: base.audit } : {}),
    };
  }

  async shutdown(): Promise<void> {
    await this.executor.shutdown();
  }

  async runGoal(goal: GoalRequest, sink: ProgressSink): Promise<GoalResult> {
    if (!this.ctx) throw new Error('provider 尚未 init');
    const catalog = this.ctx.capabilities.list();
    sink.onStatus('working', `WinVM WorkBuddy LLM Agent 接管目标：${goal.goal}`);

    const res = await this.bridge.runGoal(
      {
        goal: goal.goal,
        capabilities: catalog,
        outputDir: this.outputDir,
        cliPath: this.cliPath,
        endpoint: this.endpoint,
        traceId: goal.traceId,
        timeoutMs: goal.timeoutMs || 300_000,
      },
      sink,
    );

    if (!res.ok) {
      return { ok: false, summary: res.summary, artifacts: res.artifacts, steps: res.steps, error: res.error };
    }
    return { ok: true, summary: res.summary, artifacts: res.artifacts, steps: res.steps };
  }
}

/** loader 约定导出：createProvider */
export function createProvider(options?: WorkbuddyLlmProviderOptions): WorkbuddyLlmProvider {
  return new WorkbuddyLlmProvider(options);
}

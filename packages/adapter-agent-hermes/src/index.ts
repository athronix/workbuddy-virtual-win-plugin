/**
 * @winvm/adapter-agent-hermes —— VM 内 Agent 适配器（hermes-agent 选型，L2）
 *
 * 以 **Nous Research Hermes Agent** CLI 为 VM 内推理运行时，承接开放/创意类 A2A 任务：
 *   - id = 'hermes-agent'，kind = 'llm-agent'
 *   - runGoal 经 CliLlmBridge 调起 `hermes chat -q "<prompt>" -Q --yolo --source winvm-bridge`
 *   - execute / health / shutdown 委托 DeterministicAgentProvider，复用同一 ps-bridge 与安全内核
 *   - init 时经 HermesMcpRegistrar 幂等把本服务 /mcp 注册进 hermes 配置
 *     （hermes CLI 无 --mcp 参数，MCP 必须预注册，见 ADR-13）
 *
 * 切换方式：改 `agent.provider='hermes-agent'` 一行，框架零改动。
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
import { CliLlmBridge, loadSkillDocs, type LlmBridge } from '@winvm/adapter-agent-workbuddy-llm';

import { HermesMcpRegistrar, expandEnvPath } from './mcp-registrar.js';

export const PROVIDER_ID = 'hermes-agent';

/**
 * hermes CLI 参数契约（已在本机 v0.18.2 实测 `hermes chat --help` 核对）：
 *   chat           子命令
 *   -q {prompt}    单次查询（非交互）；hermes 无独立 --system-prompt 参数，
 *                  故把 buildSystemPrompt() 产出的整段提示作为查询传入
 *   -Q             程序化输出：抑制 banner/spinner/工具预览，仅输出最终回复与会话信息
 *   --yolo         跳过危险命令审批提示（非交互必须，否则遇审批会永久挂起）
 *   --source       会话来源标签，避免这些会话污染用户会话列表
 */
export const HERMES_CLI_ARG_TEMPLATE: readonly string[] = [
  'chat',
  '-q',
  '{prompt}',
  '-Q',
  '--yolo',
  '--source',
  'winvm-bridge',
];

export interface HermesAgentProviderOptions {
  /** CLI 名（默认 hermes） */
  readonly runtime?: string;
  /** CLI 绝对路径（覆盖 runtime） */
  readonly cliPath?: string;
  /** 本服务 /mcp，供 hermes 回连调用能力 */
  readonly endpoint?: string;
  readonly maxConcurrency?: number;
  /** 产物输出目录（支持 %USERPROFILE% 等环境变量） */
  readonly outputDir?: string;
  /** VM 内共享技能目录（<root>/<slug>/SKILL.md） */
  readonly skillsRoot?: string;
  /** CLI 参数模板覆盖 */
  readonly cliArgTemplate?: readonly string[];
  /**
   * 是否在 init 时自动把本服务 /mcp 注册进 hermes 配置，默认 true。
   * 设为 false 则由运维手工执行 `hermes mcp add winvm --url <endpoint> --auth header`。
   */
  readonly registerMcp?: boolean;
  /** 注册到 hermes 的 MCP 服务器名，默认 winvm */
  readonly mcpServerName?: string;
  /** Bearer token；缺省取环境变量 WINVM_BEARER_TOKEN */
  readonly token?: string;
  /** hermes config.yaml 路径覆盖（测试/自定义部署用） */
  readonly hermesConfigPath?: string;
  /** 注入用：测试注入 mock；生产省略（自动构造 DeterministicAgentProvider） */
  readonly executor?: AgentServiceProvider;
  /** 注入用：测试注入 mock；生产省略（自动构造 CliLlmBridge） */
  readonly bridge?: LlmBridge;
  readonly psBridge?: PsBridgeOptions;
}

export class HermesAgentProvider implements AgentServiceProvider {
  readonly id = PROVIDER_ID;
  readonly displayName = 'WinVM Hermes Agent ( Nous Research )';
  readonly kind = 'llm-agent' as const;

  private ctx: BridgeContext | undefined;
  private readonly executor: AgentServiceProvider;
  private readonly bridge: LlmBridge;
  private readonly cliPath: string;
  private readonly endpoint: string;
  private readonly outputDir: string;
  private readonly skillsRoot: string;
  private readonly registrar: HermesMcpRegistrar | undefined;

  constructor(opts: HermesAgentProviderOptions = {}) {
    this.executor =
      opts.executor ??
      new DeterministicAgentProvider({ psBridge: opts.psBridge, maxConcurrency: opts.maxConcurrency });
    this.bridge =
      opts.bridge ??
      new CliLlmBridge({
        runtime: opts.runtime ?? 'hermes',
        cliPath: opts.cliPath ?? opts.runtime ?? 'hermes',
        endpoint: opts.endpoint,
        cliArgTemplate: opts.cliArgTemplate ?? HERMES_CLI_ARG_TEMPLATE,
      });
    this.cliPath = opts.cliPath ?? opts.runtime ?? 'hermes';
    this.endpoint = opts.endpoint ?? 'http://127.0.0.1:18443/mcp';
    this.outputDir = opts.outputDir ?? '%USERPROFILE%\\WinVMWorkspace\\out';
    this.skillsRoot = opts.skillsRoot ? expandEnvPath(opts.skillsRoot) : '';
    this.registrar =
      (opts.registerMcp ?? true)
        ? new HermesMcpRegistrar({
            url: this.endpoint,
            serverName: opts.mcpServerName,
            ...(opts.token !== undefined ? { token: opts.token } : {}),
            ...(opts.hermesConfigPath ? { configPath: opts.hermesConfigPath } : {}),
          })
        : undefined;
  }

  declareCapabilities(): readonly string[] {
    return ['meta.*', 'system.*', 'app.*', 'storage.*', 'gui.*', 'appops.*'];
  }

  async init(ctx: BridgeContext): Promise<void> {
    this.ctx = ctx;

    if (this.registrar) {
      try {
        const r = await this.registrar.ensureRegistered();
        if (r.ok) {
          ctx.logger?.info?.(
            `hermes MCP 注册${r.action === 'noop' ? '已就位' : '完成'}：${r.configPath}（server=${r.configPath ? '' : ''}${this.endpoint}，tokenEnv=${r.tokenEnvVar}）`,
          );
        } else {
          // 降级：注册失败不阻断启动，仅告警（hermes 仍可用其原生能力执行任务）
          ctx.logger?.warn?.(`hermes MCP 注册失败，将降级为无 WinVM 能力：${r.reason ?? '未知原因'}`);
        }
      } catch (e) {
        ctx.logger?.warn?.(`hermes MCP 注册异常，已忽略：${(e as Error).message}`);
      }
    }

    await this.executor.init(ctx);
  }

  async execute(req: CapabilityRequest): Promise<CapabilityResult> {
    return this.executor.execute(req);
  }

  async health(): Promise<HealthStatus> {
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
    sink.onStatus('working', `WinVM Hermes Agent 接管目标：${goal.goal}`);

    const skills = await loadSkillDocs(this.skillsRoot);
    if (skills.length > 0) {
      sink.onStatus('working', `已载入 ${skills.length} 份共享技能规范：${skills.map((s) => s.id).join(', ')}`);
    }

    const res = await this.bridge.runGoal(
      {
        goal: goal.goal,
        capabilities: catalog,
        outputDir: this.outputDir,
        cliPath: this.cliPath,
        endpoint: this.endpoint,
        traceId: goal.traceId,
        timeoutMs: goal.timeoutMs || 300_000,
        ...(skills.length > 0 ? { skills } : {}),
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
export function createProvider(options?: HermesAgentProviderOptions): HermesAgentProvider {
  return new HermesAgentProvider(options);
}

export {
  HermesMcpRegistrar,
  upsertMcpServerBlock,
  upsertEnvVar,
  tokenEnvVarForServer,
  expandEnvPath,
} from './mcp-registrar.js';

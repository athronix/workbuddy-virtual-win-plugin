/**
 * @winvm/adapter-agent-workbuddy —— VM 内 Agent 适配器 V1（L2）
 *
 * 实现 AgentServiceProvider SPI 的**确定性执行器**：
 *   - 不依赖 LLM：行为可预测、省资源、易审计（NFR-502 / 评估建议 §5 资源占用）
 *   - 替换成本极低：新增一个 provider 实现 + 改配置 agent.provider 即可换成 LLM Agent
 *     core / mcp-framework / a2a-framework / skills **全部零改动**
 */

import {
  type AgentServiceProvider,
  type Artifact,
  type BridgeContext,
  type CapabilityRequest,
  type CapabilityResult,
  type GoalRequest,
  type GoalResult,
  type GoalStep,
  type HealthStatus,
  type ProgressSink,
  makeError,
  riskAtLeast,
} from '@winvm/contracts';
import { newId, newTraceId } from '@winvm/core';
import { PsBridge, type PsBridgeOptions } from '@winvm/vm-capabilities';

export const PROVIDER_ID = 'workbuddy-deterministic';

export interface DeterministicProviderOptions {
  readonly maxConcurrency?: number;
  /** 预留：接入 LLM 规划后开启（V1 默认 false） */
  readonly enableLlmPlanning?: boolean;
  readonly psBridge?: PsBridgeOptions;
}

export class DeterministicAgentProvider implements AgentServiceProvider {
  readonly id = PROVIDER_ID;
  readonly displayName = 'WinVM 确定性执行器（V1）';
  readonly kind = 'deterministic' as const;

  private ctx: BridgeContext | undefined;
  private bridge: PsBridge | undefined;
  private readonly maxConcurrency: number;
  private readonly enableLlmPlanning: boolean;
  private readonly bridgeOptions: PsBridgeOptions;
  private active = 0;

  constructor(options: DeterministicProviderOptions = {}) {
    this.maxConcurrency = options.maxConcurrency ?? 4;
    this.enableLlmPlanning = options.enableLlmPlanning === true;
    this.bridgeOptions = options.psBridge ?? {};
  }

  declareCapabilities(): readonly string[] {
    // 声明本实现能承载的全部能力域；实际暴露面会与平台能力求交集
    return ['meta.*', 'system.*', 'app.*', 'storage.*', 'gui.*', 'appops.*'];
  }

  async init(ctx: BridgeContext): Promise<void> {
    this.ctx = ctx;
    this.bridge = new PsBridge(this.bridgeOptions);
    try {
      await this.bridge.start();
      ctx.logger.info('ps-bridge 已启动', { provider: this.id, uptimeMs: this.bridge.uptimeMs });
    } catch (e) {
      // 启动失败不阻断 provider 初始化：服务将进入 degraded，仅暴露 meta.*
      ctx.logger.error('ps-bridge 启动失败，服务将降级', { error: (e as Error).message });
    }
  }

  private requireCtx(): BridgeContext {
    if (!this.ctx) throw new Error('provider 尚未 init');
    return this.ctx;
  }

  /* ------------------------------ execute ------------------------------ */

  async execute(req: CapabilityRequest): Promise<CapabilityResult> {
    const ctx = this.requireCtx();
    const started = Date.now();
    const cap = ctx.capabilities.get(req.capabilityId);

    if (!cap) {
      return this.fail(req, makeError('UNKNOWN_CAPABILITY', `能力未注册：${req.capabilityId}`), started, ctx);
    }

    // —— 策略引擎（拒绝优先）——
    const verdict = ctx.policy.evaluate({
      capabilityId: req.capabilityId,
      params: req.params,
      risk: cap.risk,
      approved: req.approved,
      ...(req.approvalId ? { approvalId: req.approvalId } : {}),
    });
    if (!verdict.allowed) {
      return this.fail(
        req,
        verdict.error ?? makeError('POLICY_DENIED', `被策略拒绝：${verdict.matchedRule}`),
        started,
        ctx,
      );
    }

    // —— 会话守卫：GUI 能力在无交互式会话时必须明确报错，绝不静默黑屏 ——
    if (cap.requiresSession) {
      const session = await this.sessionHealth();
      if (session.state === 'unavailable' || session.state === 'black-screen') {
        return this.fail(
          req,
          makeError(
            session.state === 'black-screen' ? 'SESSION_BLACK_SCREEN' : 'SESSION_UNAVAILABLE',
            `GUI 能力需要交互式会话。当前：${session.state}。${session.detail ?? ''}`,
          ),
          started,
          ctx,
        );
      }
    }

    // —— 并发闸门 ——
    if (this.active >= this.maxConcurrency) {
      return this.fail(req, makeError('TIMEOUT', `并发已满（${this.maxConcurrency}），请稍后重试`), started, ctx, true);
    }

    const bridge = this.bridge;
    if (!bridge || !bridge.running) {
      return this.fail(req, makeError('PROVIDER_UNAVAILABLE', 'ps-bridge 未就绪'), started, ctx);
    }

    this.active++;
    try {
      // 能力定义 → PowerShell 模块/函数（从注册表取实现绑定）
      const impl = this.implementationOf(req.capabilityId);
      const data = await bridge.call(
        impl.module,
        impl.fn,
        req.params,
        req.timeoutMs || 30_000,
      );

      const durationMs = Date.now() - started;
      const artifacts = this.extractArtifacts(req.capabilityId, data);

      const audit = await ctx.audit.append({
        ts: new Date().toISOString(),
        traceId: req.traceId,
        auditId: newId('aud'),
        principal: { host: 'vm-service', user: process.env['USERNAME'] ?? 'unknown', channel: 'mcp' },
        capabilityId: req.capabilityId,
        risk: cap.risk,
        params: req.params,
        policyDecision: { allowed: true, matchedRule: verdict.matchedRule },
        ...(req.approvalId
          ? {
              approval: {
                approvalId: req.approvalId,
                approvedBy: 'host',
                approvedAt: new Date().toISOString(),
                previewHash: '',
              },
            }
          : {}),
        result: { ok: true, summary: `${req.capabilityId} 执行成功` },
        ...(artifacts.length > 0 ? { artifacts: artifacts.map((a) => `sha256:${a.name}`) } : {}),
        durationMs,
      });

      return { traceId: req.traceId, ok: true, data, artifacts, durationMs, auditRef: audit.auditId };
    } catch (e) {
      return this.fail(req, this.toBridgeError(e), started, ctx);
    } finally {
      this.active--;
    }
  }

  /* ------------------------------ runGoal ------------------------------ */

  async runGoal(goal: GoalRequest, sink: ProgressSink): Promise<GoalResult> {
    const ctx = this.requireCtx();
    const steps: GoalStep[] = [];
    const artifacts: Artifact[] = [];
    const started = Date.now();

    const step = async (
      capabilityId: string,
      params: Record<string, unknown>,
      summary: string,
    ): Promise<{ ok: boolean; data?: unknown; error?: string }> => {
      const traceId = newTraceId();
      sink.onStatus('working', `执行 ${capabilityId}：${summary}`);
      const res = await this.execute({
        traceId,
        capabilityId,
        params,
        risk: ctx.capabilities.get(capabilityId)?.risk ?? 'L3',
        approved: false,
        timeoutMs: goal.timeoutMs,
      });
      steps.push({
        index: steps.length,
        capabilityId,
        params,
        ok: res.ok,
        risk: ctx.capabilities.get(capabilityId)?.risk ?? 'L3',
        durationMs: res.durationMs,
        traceId,
        summary,
        ...(res.error ? { error: res.error } : {}),
      });
      for (const a of res.artifacts ?? []) {
        artifacts.push(a);
        sink.onArtifact(a);
      }
      return { ok: res.ok, data: res.data, ...(res.error ? { error: res.error.message } : {}) };
    };

    const text = goal.goal;

    /* ---- 模板 1：安装应用 ---- */
    const installMatch = /安装\s*([A-Za-z0-9\u4e00-\u9fa5._\- ]{1,40})/.exec(text);
    if (installMatch && this.allowed(goal, 'app.winget.install')) {
      const query = installMatch[1]!.trim();
      const found = await step('app.winget.search', { query, limit: 5 }, `搜索「${query}」`);
      if (!found.ok) return this.goalFail(steps, artifacts, `搜索失败：${found.error ?? '未知原因'}`, started);

      const list = (found.data as Array<{ id?: string; name?: string }> | undefined) ?? [];
      if (list.length === 0) {
        return this.goalFail(steps, artifacts, `未找到与「${query}」匹配的包，请改用 MCP 指定确切包 ID`, started);
      }
      const target = list[0]?.id;
      if (!target) {
        return this.goalFail(steps, artifacts, '搜索结果缺少包 ID，请改用 MCP 指定确切包 ID', started);
      }
      const installed = await step('app.winget.install', { id: target }, `安装 ${target}`);
      return {
        ok: installed.ok,
        summary: installed.ok ? `已安装 ${target}` : `安装失败：${installed.error ?? '未知原因'}`,
        artifacts,
        steps,
        ...(installed.ok ? {} : { error: makeError('EXECUTION_FAILED', installed.error ?? '安装失败') }),
      };
    }

    /* ---- 模板 2：磁盘空间分析（只分析，不删除 —— 安全默认） ---- */
    if (/(磁盘|空间|容量|占满|清理建议)/.test(text) && this.allowed(goal, 'storage.cleanup.analyze')) {
      const r = await step('storage.cleanup.analyze', { topLargeFiles: 30 }, '分析磁盘占用与清理建议');
      return {
        ok: r.ok,
        summary: r.ok
          ? '已完成磁盘分析并给出建议（**未执行任何删除**）。如需删除，请明确指定路径并逐项走审批。'
          : `分析失败：${r.error ?? '未知原因'}`,
        artifacts,
        steps,
        ...(r.ok ? {} : { error: makeError('EXECUTION_FAILED', r.error ?? '分析失败') }),
      };
    }

    /* ---- 模板 3：系统信息 ---- */
    if (/(系统信息|系统状态|配置|版本)/.test(text) && this.allowed(goal, 'system.info.get')) {
      const r = await step('system.info.get', {}, '获取系统信息');
      return {
        ok: r.ok,
        summary: r.ok ? '已获取系统信息' : `获取失败：${r.error ?? '未知原因'}`,
        artifacts,
        steps,
        ...(r.ok ? {} : { error: makeError('EXECUTION_FAILED', r.error ?? '获取失败') }),
      };
    }

    /* ---- 模板 4：截图 ---- */
    if (/(截图|截屏|看看屏幕|当前屏幕)/.test(text) && this.allowed(goal, 'gui.screen.capture')) {
      const r = await step('gui.screen.capture', { asBase64: true }, '截取当前屏幕');
      return {
        ok: r.ok,
        summary: r.ok ? '已截取当前屏幕（见 artifact）' : `截图失败：${r.error ?? '未知原因'}`,
        artifacts,
        steps,
        ...(r.ok ? {} : { error: makeError('EXECUTION_FAILED', r.error ?? '截图失败') }),
      };
    }

    /* ---- 模板 5：应用生产操作（appops） ---- */
    // 检测"用某个软件把活干出来"的生产意图；确定性 V1 只能调度**已登记的工作流**，
    // 开放/创意类意图（如"用 Photoshop 把大山换成海洋"）需升级 LLM VM Agent（见 SPEC-AGENT-SERVICE-BRIDGE §开放任务）。
    const productionHint = /(处理|编辑|生成|生产|转换|转码|批处理|换背景|加水印|去水印|导出|排版|报表|抠图|合成)/;
    const appHint = /(photoshop|ps\b|图片|照片|图像|excel|表格|报表|word|文档|报告|pdf|ffmpeg|视频|mp4|gif|浏览器|网页|ide|构建)/i;
    if (productionHint.test(text) && appHint.test(text) && this.allowed(goal, 'appops.workflow.run')) {
      let preferredApp = 'generic';
      if (/photoshop|ps\b|图片|照片|图像/.test(text)) preferredApp = 'photoshop';
      else if (/excel|表格|报表/.test(text)) preferredApp = 'excel';
      else if (/word|文档|报告|pdf/.test(text)) preferredApp = 'office';
      else if (/ffmpeg|视频|mp4|gif/.test(text)) preferredApp = 'ffmpeg';
      else if (/浏览器|网页/.test(text)) preferredApp = 'browser';

      const r = await step(
        'appops.workflow.run',
        { workflow: 'generic_production', params: { goal: text, preferredApp }, outputDirectory: '%USERPROFILE%\\WinVMWorkspace\\out' },
        '调度应用生产工作流',
      );
      if (r.ok) {
        return {
          ok: true,
          summary: '已调度应用生产工作流并执行成功（见 artifact）。如需更精细的开放意图处理，建议升级 VM Agent 为 LLM provider。',
          artifacts,
          steps,
        };
      }
      // 工作流未登记：明确引导（不硬猜、不伪造）
      const msg = (r.error ?? '工作流未找到') as string;
      return {
        ok: false,
        summary:
          '确定性执行器未匹配到预置的生产工作流（' + preferredApp + '）。' +
          '两种解法：① 在 VM 的 workflows 目录预置 `generic_production` 工作流脚本；' +
          '② 升级 VM Agent 为 LLM provider（改配置 agent.provider 即可），由其在 VM 内自主规划并操作应用。',
        artifacts,
        steps,
        error: makeError('UNSUPPORTED_GOAL', 'WORKFLOW_NOT_FOUND: ' + msg),
      };
    }

    /* ---- 无匹配模板：明确告知，不硬猜 ---- */
    return {
      ok: false,
      summary:
        '确定性执行器未匹配到内置目标模板。' +
        (this.enableLlmPlanning
          ? '（LLM 规划已开启但 V1 未实现该分支）'
          : '建议：① 改用 MCP 通道逐步调用具体能力；② 或升级 provider 为 LLM Agent（改配置 agent.provider 即可，框架无需改动）。'),
      artifacts,
      steps,
      error: makeError('UNKNOWN_CAPABILITY', 'UNSUPPORTED_GOAL：无匹配的目标模板'),
    };
  }

  /* ------------------------------ health / shutdown ------------------------------ */

  async health(): Promise<HealthStatus> {
    const session = await this.sessionHealth();
    const bridge = this.bridge;
    const bridgeHealth = bridge?.health() ?? { state: 'down' as const, uptimeMs: 0, pending: 0, lastHeartbeatAgoMs: -1 };

    let auditInfo: { entries: number; chainValid: boolean } | undefined;
    try {
      const v = await this.requireCtx().audit.verifyChain();
      auditInfo = { entries: v.entries, chainValid: v.valid };
    } catch {
      auditInfo = undefined;
    }

    const ok = bridgeHealth.state === 'ready';
    return {
      ok,
      provider: {
        id: this.id,
        state: ok ? 'ready' : 'degraded',
        ...(ok ? {} : { detail: 'ps-bridge 未就绪，仅 meta 能力可用' }),
      },
      session,
      psBridge: {
        state: bridgeHealth.state === 'ready' ? 'ready' : 'unavailable',
        uptimeMs: bridgeHealth.uptimeMs,
        pending: bridgeHealth.pending,
      },
      capabilities: {
        count: this.ctx?.capabilities.list().length ?? 0,
        available: this.ctx?.capabilities.list().length ?? 0,
      },
      ...(auditInfo ? { audit: auditInfo } : {}),
    };
  }

  async shutdown(): Promise<void> {
    if (this.bridge) await this.bridge.stop();
    this.bridge = undefined;
  }

  /* ------------------------------ 内部工具 ------------------------------ */

  private async sessionHealth() {
    const probe = (this.ctx as unknown as { sessionProbe?: { probe(): Promise<HealthStatus['session']> } })
      ?.sessionProbe;
    if (probe) return probe.probe();
    // 无探针（如非 Windows）：保守返回 unavailable
    return {
      sessionId: 0,
      windowStation: '',
      desktop: '',
      interactive: false,
      locked: false,
      blackScreen: false,
      state: 'unavailable' as const,
      detail: '未注入会话探针',
    };
  }

  private allowed(goal: GoalRequest, capabilityId: string): boolean {
    if (!goal.allowedCapabilities || goal.allowedCapabilities.length === 0) return true;
    return goal.allowedCapabilities.some(
      (p) => p === capabilityId || (p.endsWith('.*') && capabilityId.startsWith(p.slice(0, -1))),
    );
  }

  /** 从注册表取实现绑定（模块 + 函数） */
  private implementationOf(capabilityId: string): { module: string; fn: string } {
    const def = (
      this.ctx as unknown as {
        capabilityDefs?: Map<string, { implementation: { module: string; function: string } }>;
      }
    )?.capabilityDefs?.get(capabilityId);
    if (def) return { module: def.implementation.module, fn: def.implementation.function };
    // 兜底：按 ID 前缀推断模块
    return { module: capabilityId.split('.')[0] ?? 'system', fn: 'Get-SystemInfo' };
  }

  private extractArtifacts(capabilityId: string, data: unknown): Artifact[] {
    if (capabilityId !== 'gui.screen.capture' || typeof data !== 'object' || data === null) return [];
    const d = data as Record<string, unknown>;
    if (typeof d['data'] !== 'string') return [];
    return [
      {
        kind: 'screenshot',
        name: `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`,
        mime: 'image/png',
        data: d['data'],
        encoding: 'base64',
      },
    ];
  }

  private toBridgeError(e: unknown): ReturnType<typeof makeError> {
    const err = e as { code?: string; message?: string; details?: unknown };
    const known = [
      'INVALID_PARAMS',
      'UNKNOWN_CAPABILITY',
      'POLICY_DENIED',
      'APPROVAL_REQUIRED',
      'SESSION_UNAVAILABLE',
      'SESSION_BLACK_SCREEN',
      'PROVIDER_UNAVAILABLE',
      'TIMEOUT',
      'EXECUTION_FAILED',
    ] as const;
    if (err?.code && (known as readonly string[]).includes(err.code)) {
      return makeError(err.code as never, err.message ?? String(e));
    }
    return makeError('EXECUTION_FAILED', err?.message ?? String(e));
  }

  private async fail(
    req: CapabilityRequest,
    error: ReturnType<typeof makeError>,
    started: number,
    ctx: BridgeContext,
    retryable?: boolean,
  ): Promise<CapabilityResult> {
    const durationMs = Date.now() - started;
    try {
      await ctx.audit.append({
        ts: new Date().toISOString(),
        traceId: req.traceId,
        auditId: newId('aud'),
        principal: { host: 'vm-service', user: process.env['USERNAME'] ?? 'unknown', channel: 'mcp' },
        capabilityId: req.capabilityId,
        risk: ctx.capabilities.get(req.capabilityId)?.risk ?? 'L3',
        params: req.params,
        policyDecision: { allowed: false, matchedRule: error.code },
        result: { ok: false, errorCode: error.code, summary: error.message },
        durationMs,
      });
    } catch {
      // 审计失败不得掩盖原始错误
    }
    return {
      traceId: req.traceId,
      ok: false,
      error: retryable === undefined ? error : { ...error, retryable },
      durationMs,
    };
  }

  private goalFail(
    steps: GoalStep[],
    artifacts: Artifact[],
    summary: string,
    started: number,
  ): GoalResult {
    return {
      ok: false,
      summary: `${summary}（耗时 ${Date.now() - started}ms）`,
      artifacts,
      steps,
      error: makeError('EXECUTION_FAILED', summary),
    };
  }
}

/** loader 约定导出：createProvider */
export function createProvider(options?: DeterministicProviderOptions): DeterministicAgentProvider {
  return new DeterministicAgentProvider(options ?? {});
}

export { riskAtLeast };

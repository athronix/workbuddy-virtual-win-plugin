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

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  type AgentServiceProvider,
  type BridgeContext,
  type CapabilityRequest,
  type CapabilityResult,
  type DelegationTruthProbe,
  type GoalRequest,
  type GoalResult,
  type HealthStatus,
  type LlmSessionHealth,
  type ProgressSink,
  makeError,
} from '@winvm/contracts';
import { resolveApprovalTruth, expandEnvPath, type ApprovalTruthMode, type LlmSessionConfig } from '@winvm/core';
import type { PsBridgeOptions } from '@winvm/vm-capabilities';
import { DeterministicAgentProvider } from '@winvm/adapter-agent-workbuddy';

import { CliLlmBridge, type LlmBridge, type LlmGoalResult, type LlmSkillDoc } from './bridge.js';
import { evaluateDisabledRejection } from './delegation-truth.js';
import type { SessionLog } from './persistent-session.js';

export const PROVIDER_ID = 'workbuddy';

/**
 * K2 修复（A2A 冷启动停滞）：预热目标 —— 无害、极简，仅触发 codebuddy 冷启动 + 一次最短响应，
 * 使常驻会话在服务启动期即进入 ready，首个真实委派免付冷启动（详见 `warmup()`）。
 */
export const LLM_SESSION_WARMUP_GOAL =
  'Reply with exactly the single word OK and perform no other actions.';

/**
 * **不降级**的契约码 / 领域原因码集合（P2-T10，与确定性执行体 `step()` 保码同批）。
 *
 * 语义：**「按规则不该执行」的终态结论**。这类码是策略闸、审批闸、会话闸或用户意志的
 * 结果，不是运行时故障 —— 回落确定性执行器重跑等于「因为被拦住了，所以绕过拦我的东西
 * 再试一遍」，属安全性质倒退（Phase 1 §3a 降级红线同族）。
 *
 * 同时用于两处（一个集合、两种来路）：
 *   · `BridgeError.code` 命中 ⇒ 直接不降级；
 *   · `code==='EXECUTION_FAILED'` 时 `BridgeError.reason` 命中 ⇒ 判为「上游闸类码被折叠
 *     成通用执行失败」的残余路径，同样不降级（`adapter-agent-workbuddy` 的
 *     `toBridgeError()` 第二层会把领域码 `POLICY_DENIED` / `APPROVAL_REQUIRED` 映射成
 *     base code 并把**原码写入 reason**，故 reason 维度也需守）。
 *
 * 用 `readonly string[]` 而非 `BridgeErrorCode[]`：本集合需同时容纳契约码与领域码
 * （reason 是自由 string），收窄成契约码枚举反而无法表达 reason 侧语义。
 */
const NON_DEGRADABLE_CODES: readonly string[] = [
  'POLICY_DENIED',
  'APPROVAL_REQUIRED',
  'SESSION_UNAVAILABLE',
  'SESSION_BLACK_SCREEN',
  // 用户已叫停：重跑等于把取消操作再执行一遍（CL-022 3a）
  'TASK_CANCELED',
];

// A2-10（Phase 3 批6）：本地重复实现已收敛到 @winvm/core 权威 expandEnvPath（见文件头 import）。

/** 极简 frontmatter 解析（仅取 name / description），避免依赖宿主侧 host-sdk */
function parseFrontmatter(raw: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!m) return {};
  const out: { name?: string; description?: string } = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const km = /^(name|description)\s*:\s*(.*)$/.exec(line.trim());
    if (!km) continue;
    const key = km[1] as 'name' | 'description';
    const val = km[2]!.replace(/^['"]|['"]$/g, '').replace(/^>\s*$/, '').trim();
    if (val) out[key] = val;
  }
  return out;
}

/**
 * 从部署到 VM 的 skills 目录加载技能规范，随任务下发给 VM 内 Agent。
 * 这些 Skill 即 VM 内 Agent 的"操作规范"：告诉它按什么步骤、用什么工具、
 * 遵守哪些约束来完成任务（如 appops 生产、GUI 自动化、系统管理等）。
 */
export async function loadSkillDocs(skillsRoot: string): Promise<LlmSkillDoc[]> {
  if (!skillsRoot) return [];
  let entries;
  try {
    entries = await readdir(skillsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: LlmSkillDoc[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const p = join(skillsRoot, e.name, 'SKILL.md');
    if (!existsSync(p)) continue;
    try {
      const body = await readFile(p, 'utf8');
      const fm = parseFrontmatter(body);
      out.push({
        id: e.name,
        name: fm.name ?? e.name,
        ...(fm.description ? { description: fm.description } : {}),
        body,
      });
    } catch {
      /* 单个 Skill 读取失败不影响其余 */
    }
  }
  return out;
}

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
  /**
   * VM 内技能规范目录（随部署复制到 VM 的 skills/ 根，支持 %ENV%）。
   * 任务下发时加载其中的 SKILL.md 作为 VM 内 Agent 的操作规范。
   */
  readonly skillsRoot?: string;
  /** CLI 参数模板覆盖（真机 CLI 契约与默认不一致时使用） */
  readonly cliArgTemplate?: readonly string[];
  /** 注入用：测试注入 mock；生产省略（自动构造 DeterministicAgentProvider） */
  readonly executor?: AgentServiceProvider;
  /** 注入用：测试注入 mock；生产省略（自动构造 CliLlmBridge） */
  readonly bridge?: LlmBridge;
  readonly psBridge?: PsBridgeOptions;
  /** CL-018 C1：是否启用常驻会话（默认取 env `WINVM_LLM_PERSISTENT`，缺省启用） */
  readonly persistent?: boolean;
  /** CL-018 C1：常驻会话参数（来自 resolveServiceConfig().llmSession；未给字段回退 env/默认） */
  readonly sessionConfig?: Partial<LlmSessionConfig>;
  /** CL-018 C1：常驻会话日志出口（接到服务 logger，便于事后诊断） */
  readonly onSessionLog?: SessionLog;
  /**
   * CL-K3R：审批真值判据模式（显式配置优先；未指定时取 env `WINVM_APPROVAL_TRUTH`，缺省 `on`）。
   * `shadow` = 只 warn 不改判（灰度对拍）；`off` = 一键回滚到 R19F 后现状。
   */
  readonly approvalTruth?: ApprovalTruthMode;
  /**
   * P2-T6（**纯附加可选**）：VM 内回连凭据的**环境变量名**（原样透传给桥 ⇒
   * `buildMcpConfig` 第 3 参三态：undefined=旧行为逐字节 / null=显式关凭据 /
   * 非空串=headers `Authorization: Bearer ${<name>}` 变量引用）。
   *
   * 与 `http-guard.resolveInnerReconnect` 判序④⑤⑥消费的
   * `agent.providers.<id>.options.bearerEnvName` **同源同键**（server.ts 判据面与本
   * provider 装配读的是同一份运行时配置 ⇒ 不存在两套口径）。默认约定变量名
   * `WINVM_BEARER_TOKEN`（与服务侧 `security.tokenEnv` 默认同名：守卫比对值与
   * 回连携带值取自同一个进程 env，天然一致）。
   *
   * 纪律：**只承载变量名，绝不承载值**（NFR-511/K-17）；值缺失时本 provider **不**自行
   * 降级掉凭据（那会在「守卫未开」的默认形态误伤回连）—— 有名无值的确证归
   * T5 判序⑤ + fail-closed 拒启（启动面），运行期 init 只补一条可观测告警。
   */
  readonly bearerEnvName?: string | null;
}

export class WorkbuddyLlmProvider implements AgentServiceProvider {
  readonly id = PROVIDER_ID;
  readonly displayName = 'WinVM WorkBuddy LLM Agent (V1)';
  readonly kind = 'llm-agent' as const;

  private ctx: BridgeContext | undefined;
  /**
   * K-N1（设计 §3.2）：服务端委派账本探针（`init()` 里经 BridgeContext **cast** 读取，
   * 同 `reportNetCfg` 惯例 —— 不扩 BridgeContext 契约接口），`runGoal` 逐调用下传给桥，
   * 由桥收口处的 `reconcileDelegationTruth` 反查零活动。缺席（非 vm-service 宿主/单测）
   * → undefined → 桥门 4 透传，旧行为逐字节不变。
   */
  private probe: DelegationTruthProbe | undefined;
  private readonly executor: AgentServiceProvider;
  private readonly bridge: LlmBridge;
  private readonly cliPath: string;
  private readonly endpoint: string;
  private readonly outputDir: string;
  private readonly skillsRoot: string;
  /**
   * P2-T6：回连凭据**环境变量名**的构造期归一值（三态：undefined / null / 非空串）。
   * 与传给桥的 `bearerEnvName` 同源（同一行算出，配置值≠生效值的假指纹防线，
   * 口径对齐 CL-K3R E-3 的 `approvalTruthMode`）；`health()` 透出该事实供运维核对。
   */
  private readonly bearerEnvName: string | null | undefined;
  /**
   * CL-K3R E-3：审批真值判据的**运行时指纹**（构造期一次性解析，随 bridge 生效值同源）。
   * 必须在构造 bridge 那一行一并算出并存为 readonly 字段 —— 严禁在 health() 里二次读
   * process.env（否则配置值≠生效值，指纹失真）。取值：shadow ⇒ 'shadow'；
   * 否则 enabled ? 'on' : 'off'（与 CliLlmBridge 构造期的 enabled/shadow 两个字段逐字同源）。
   */
  private readonly approvalTruthMode: ApprovalTruthMode;

  constructor(opts: WorkbuddyLlmProviderOptions = {}) {
    this.cliPath = opts.cliPath ?? opts.runtime ?? 'codebuddy';
    this.endpoint = opts.endpoint ?? 'http://127.0.0.1:18443/mcp';
    this.outputDir = opts.outputDir ?? '%USERPROFILE%\\WinVMWorkspace\\out';
    this.skillsRoot = opts.skillsRoot ? expandEnvPath(opts.skillsRoot) : '';
    // CL-K3R E-3：构造期一次性解析（显式配置优先；否则取 env `WINVM_APPROVAL_TRUTH`，缺省 on）。
    // 同一解析值既注入 bridge（生效值）也存为本类只读指纹（上报值）——二者天然同源。
    const approvalTruthMode = opts.approvalTruth ?? resolveApprovalTruth(process.env);
    this.approvalTruthMode = approvalTruthMode;
    // P2-T6：回连凭据变量名三态归一（与桥内归一逐字同规则：null 原样、纯空白 ⇒ undefined）。
    // 同一值既注入 bridge（生效值）也存为只读指纹（health 上报值）⇒ 配置面/生效面同源。
    this.bearerEnvName =
      opts.bearerEnvName === null
        ? null
        : typeof opts.bearerEnvName === 'string' && opts.bearerEnvName.trim()
          ? opts.bearerEnvName.trim()
          : undefined;
    this.executor =
      opts.executor ?? new DeterministicAgentProvider({ psBridge: opts.psBridge, maxConcurrency: opts.maxConcurrency });
    this.bridge =
      opts.bridge ??
      new CliLlmBridge({
        runtime: opts.runtime,
        cliPath: opts.cliPath,
        endpoint: opts.endpoint,
        outputDir: this.outputDir,
        ...(opts.cliArgTemplate ? { cliArgTemplate: opts.cliArgTemplate } : {}),
        ...(opts.persistent !== undefined ? { persistent: opts.persistent } : {}),
        ...(opts.sessionConfig ? { sessionConfig: opts.sessionConfig } : {}),
        ...(opts.onSessionLog ? { onSessionLog: opts.onSessionLog } : {}),
        // CL-K3R：审批真值判据模式（显式配置优先；否则取 env `WINVM_APPROVAL_TRUTH`，缺省 on）
        approvalTruth: approvalTruthMode,
        // P2-T6：回连凭据变量名（显式透传；undefined ⇒ 桥逐字节旧行为）
        bearerEnvName: this.bearerEnvName,
      });
  }

  declareCapabilities(): readonly string[] {
    // 与确定性执行器同域；LLM 比 V1 多做的是"在能力之上叠加语义理解与自主规划"
    return ['meta.*', 'system.*', 'app.*', 'storage.*', 'gui.*', 'appops.*'];
  }

  async init(ctx: BridgeContext): Promise<void> {
    this.ctx = ctx;
    // CL-018 C1：把服务侧解析好的常驻会话配置（含 env 覆盖）注入 bridge，使配置/健康态同源。
    const raw = ctx.config['llmSession'];
    if (raw && typeof raw === 'object') {
      this.bridge.setSessionConfig?.(raw as Partial<LlmSessionConfig>);
    }
    // CL-018 C1：常驻会话日志接到服务 logger。
    // 级别纪律（C1 修复②，QA 发现「诊断黑洞」）：生命周期事件（spawn/ready/降级/杀进程/
    // 重建/轮次耗时/超时）必须走 **info** —— 原 debug 级在服务默认 info 级下一条都看不见；
    // 高频诊断细节（stderr 片段）保持 debug 以免刷屏。脱敏仍由 logger 统一处理，
    // 且会话日志本身不携带用户消息内容/凭据。
    this.bridge.setSessionLog?.((msg: string, meta?: Record<string, unknown>) => {
      if (msg.includes('stderr')) {
        ctx.logger.debug(`[llm-session] ${msg}`, meta ?? {});
      } else {
        ctx.logger.info(`[llm-session] ${msg}`, meta ?? {});
      }
    });
    // K4：把服务侧注入的审批协调器下传给桥接层（缺席即非 A2A 旧行为）。
    if (ctx.approvalCoordinator) {
      this.bridge.setApprovalCoordinator?.(ctx.approvalCoordinator);
    }
    // K-N1：读取服务端注入的委派账本探针（cast 模式，同 reportNetCfg 惯例：
    // vm-service 在 bridgeCtx 里塞 `delegationProbe`，契约接口不扩）。缺席 → 桥透传旧行为。
    this.probe = (ctx as unknown as { delegationProbe?: DelegationTruthProbe }).delegationProbe;
    /* ---- P2-T6：回连凭据接线可观测（有名无值显形，绝不静默） ----
     *
     * 只在「配了变量名 ∧ 本进程 env 里没有值」时打 warn：这正是 T5 判序⑤ 的确证形态
     * （`bearerEnvName` 有名无值 ⇒ `resolveInnerReconnect` 判 `broken` ⇒ 守卫生效时
     * fail-closed 拒启）。本 provider **不**据此自行降级掉 headers（那会在「守卫未开」
     * 的默认形态误伤回连），只把「分发通路断在哪一段」讲清楚：
     *   ① 值由 `delivery/.generated/start-hidden.ps1` 的显式 `$env:` 赋值注入服务进程
     *      （计划任务无 env 通道 ⇒ 只能走这里，见 DEPLOYMENT.md 凭据分发小节）；
     *   ② 服务进程 env 经 `launchCliProcess` 透传给 CLI 子进程 ⇒ 配置里的
     *      `Bearer ${<name>}` 由 CLI 在连接期展开；
     *   ⇒ 所以「本进程 env 无值」＝ 通路①没接好，运维可直接去查 start-hidden.ps1。
     *
     * 刻意**只读不判**：不产生错误、不改配置面结论（判决面归 http-guard）。
     * `bearerEnvName` 为 null / undefined（未接线或显式关凭据）⇒ 一个字都不打（默认态零回归）。
     */
    if (this.bearerEnvName && !process.env[this.bearerEnvName]) {
      ctx.logger.warn(
        'VM 内回连凭据变量已配置但服务进程 env 无值 ⇒ 委派回连将带空凭据（守卫生效时 401）',
        {
          bearerEnvName: this.bearerEnvName,
          hint:
            '请在生成的 start-hidden.ps1 里显式赋值 $env:' +
            this.bearerEnvName +
            '（计划任务无 env 通道），再 kill-restart.ps1 重启服务；详见 DEPLOYMENT.md「VM 内回连凭据分发」',
        },
      );
    }
    await this.executor.init(ctx);
  }

  /**
   * K2 修复（A2A 冷启动停滞）：VM 服务启动后由 server.ts 以 `void provider.warmup()` **fire-and-forget**
   * 触发，让 codebuddy 的进程级冷启动（auth probe + agent 端点 ≈75–107s）在**启动期**完成，
   * 而非阻塞首个真实 A2A 委派（否则会撞上宿主有界超时、返回「冷启动窗口」引导文案而非结果）。
   *
   * 纪律（对齐 CL-018 C5 netCfg 预热）：
   *   - **不阻塞启动**：server.ts 不 await，启动序列与预热并行；
   *   - **失败只记日志**：codebuddy 未登录 / 不可用 → 捕获并 warn，绝不抛到启动链路或阻断服务；
   *   - **幂等安全**：若会话已被真实委派抢先拉起，warmup 的 trivial 目标排队其后，无害。
   */
  async warmup(): Promise<void> {
    if (!this.ctx) return;
    try {
      this.ctx.logger.info('[llm-session] 启动预热开始（消除 A2A 冷启动停滞 K2）');
      const ok = await this.bridge.warmup?.(LLM_SESSION_WARMUP_GOAL);
      this.ctx.logger.info('[llm-session] 启动预热结束', { warmed: ok === true });
    } catch (e) {
      this.ctx.logger.warn('[llm-session] 启动预热失败（不影响服务，首调将自行冷启动）', {
        error: (e as Error).message,
      });
    }
  }

  async execute(req: CapabilityRequest): Promise<CapabilityResult> {
    return this.executor.execute(req);
  }

  async health(): Promise<HealthStatus> {
    // 健康态由 LLM provider 自身上报身份（id/kind），底层 executor 只是实现细节
    const base = await this.executor.health();
    const bridgeOk = base.provider.state === 'ready';
    // CL-K3R E-3：审批真值判据运行时指纹（三态可观测）。值取自构造期 readonly 字段
    // （不在此处读 process.env —— 生效值在 bridge 构造那行已定，配置值≠生效值会出假指纹）。
    const approvalTruth = {
      mode: this.approvalTruthMode,
      enabled: this.approvalTruthMode !== 'off',
      shadow: this.approvalTruthMode === 'shadow',
    };
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
      // CL-K3R E-3（纯附加）：审批真值判据三态指纹（`/health.provider.approvalTruth`）。
      // 值取自构造期一次性解析的 readonly 字段，禁止在此二次读 process.env（假指纹防线）。
      ...(approvalTruth !== undefined ? { approvalTruth } : {}),
    };
  }

  async shutdown(): Promise<void> {
    // CL-018 C1：先释放常驻会话（服务退出路径），再关闭确定性执行器
    try {
      await this.bridge.dispose?.();
    } catch {
      /* 释放失败不影响整体关闭 */
    }
    await this.executor.shutdown();
  }

  /**
   * CL-018 C1：常驻会话健康快照（供 `/health.llmSession`）。
   *
   * 必须**同步**返回：`health()` 可能被框架的健康探测**短超时**守卫替换为快照，
   * 导致 `/health` 缺 `llmSession` 字段；故单独提供同步 SPI 成员，由 vm-service 直接调用。
   */
  llmSessionHealth(): LlmSessionHealth | undefined {
    return this.bridge.sessionHealth?.();
  }

  /**
   * L1 §6.1（SPI 实现，薄转发）：常驻会话复位 —— 由 `POST /admin/llm-session/reset` 调用。
   * 无会话对象 / 桥未实现（Mock）→ undefined，端点如实报告。
   */
  llmSessionReset(): LlmSessionHealth | undefined {
    return this.bridge.sessionReset?.();
  }

  /**
   * L1 §6.2（SPI 实现，薄转发）：注入/清除 spawn 故障钩子（测试确定性回归专用，
   * 同一 admin env 门控；生产路径永不触达）。
   */
  llmSessionInjectFault(on: boolean): boolean {
    return this.bridge.sessionInjectFault?.(on) ?? false;
  }

  async runGoal(goal: GoalRequest, sink: ProgressSink): Promise<GoalResult> {
    if (!this.ctx) throw new Error('provider 尚未 init');

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
    const session = this.bridge.sessionHealth?.();
    const persistent = this.bridge.isPersistentEnabled?.() ?? false;
    const rejection = evaluateDisabledRejection({
      hasTaskId: goal.taskId !== undefined,
      persistent,
      ...(session ? { sessionState: session.state } : {}),
    });
    if (rejection.reject) {
      const detail = session?.lastError ? `（最近错误：${session.lastError}）` : '';
      this.ctx.logger.warn('K-N1：disabled 委派显式拒绝（LLM_SESSION_DISABLED）', {
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

    const catalog = this.ctx.capabilities.list();
    sink.onStatus('working', `WinVM WorkBuddy LLM Agent 接管目标：${goal.goal}`);

    // 加载下发的技能规范，作为 VM 内 Agent 的操作指引
    const skills = await loadSkillDocs(this.skillsRoot);
    if (skills.length > 0) {
      sink.onStatus('working', `已载入 ${skills.length} 份技能规范：${skills.map((s) => s.id).join(', ')}`);
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
        // K4：把 A2A 任务 id 透传给桥接层，使其能经审批协调器把 input-required 挂到正确任务。
        ...(goal.taskId ? { taskId: goal.taskId } : {}),
        // P1-Fix：把委派允许的最高风险透传给桥接层，用于 execution-steps 步骤 risk 如实化
        //（缺省由桥侧回退 'L2'，与主理人 Q4 裁定口径一致）。
        ...(goal.maxRisk ? { maxRisk: goal.maxRisk } : {}),
        // K-N1：逐调用下传账本探针（缺席即桥门 4 透传，零回归）与服务 logger 告警出口
        ...(this.probe ? { probe: this.probe } : {}),
        warn: (msg: string, meta?: Record<string, unknown>): void => this.ctx?.logger.warn(msg, meta ?? {}),
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
      if (this.shouldDegrade(res) && res.error?.reason !== 'NO_EXECUTION_RECEIPT') {
        sink.onStatus(
          'working',
          `LLM 运行时不可用（${res.error?.code ?? 'UNKNOWN'}），降级为确定性执行器`,
        );
        const fallback = await this.executor.runGoal(goal, sink);
        return {
          ok: fallback.ok,
          summary: fallback.ok
            ? `已降级为确定性执行：${fallback.summary}`
            : `已降级为确定性执行，但执行器未匹配到模板：${fallback.summary}`,
          artifacts: fallback.artifacts,
          steps: fallback.steps,
          ...(fallback.error ? { error: fallback.error } : {}),
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

  /**
   * 是否应降级为确定性执行（D4.4）。
   *
   * 触发条件：LLM 运行时**不可用** —— 找不到/无法启动 CLI（PROVIDER_UNAVAILABLE，如 ENOENT），
   * 或非零退出且未产出任何 artifact（EXECUTION_FAILED）。超时不降级（避免重复劳动）。
   *
   * **P2-T10（O-1 同批原子改）**：降级集必须**只**覆盖「运行时不可用」这一种事实。
   * 确定性执行体在 `step()` 保码之前会把 `POLICY_DENIED` 折叠成
   * `EXECUTION_FAILED`（丢码 + 丢 `reason`），使「策略硬拒」与「运行时炸了」在
   * 本判据下**完全同形** ⇒ 一次本应硬拒的操作被确定性执行器重跑（绕审批闸意图，
   * Phase 1 §3a 降级红线同族）。保码后该折叠不再存在，但判据侧必须**自己**守住边界，
   * 否则任何一条新的折叠路径都会把同一个洞重新打开。因此：
   *
   * 1. **闸类 / 意志类契约码一律不降级**（`NON_DEGRADABLE_CODES`）—— 这些码本身就是
   *    「按规则不该执行」的终态结论，重跑等于把闸门当故障修；
   * 2. `EXECUTION_FAILED` 且零产物时，仍要区分来路：`reason` 落在闸类码集合内
   *    （如领域码被 `toBridgeError` 最小映射后留下的 `POLICY_DENIED`）⇒ 视同策略折叠，
   *    **不降级**；真运行时失败（`LLM_PERSISTENT_TURN_FAILED` /
   *    `LLM_RUNTIME_EXIT_n`）的 `reason` 不在该集合 ⇒ **照常降级**（K2 红线不误伤）；
   * 3. K-12 五条既有降级红线**逐条保留**，本函数没有为其中任何一条改变结论：
   *    · `TASK_CANCELED` 不落入降级（CL-022 3a）—— 本码在 1 中显式列出，旧实现靠
   *      「不在触发集」得出同一结论，二者等价（`phase1-t5-*` 三条对照用例复跑为证）；
   *    · 取消收口不得走 `{unavailable}`（3b）—— 判据未改，桥侧收口形状未动；
   *    · 取消不得写 `lastError`（3c）—— 与本函数无关，未触及；
   *    · 空闲期不得误杀常驻会话（3d）—— 与本函数无关，未触及；
   *    · `NO_EXECUTION_RECEIPT`（K-N1 账本反查改判）不降级 —— 由**调用点豁免**
   *      （`:396` `res.error?.reason !== 'NO_EXECUTION_RECEIPT'`）拦下，豁免先于本函数生效；
   *      本函数**不**重复列它（该 reason 不在闸类集内），保持「单一权威拦截位」，
   *      与 r19c-kn1-d-provider 钉既有豁免位置的口径一致；
   *    · disabled 拒绝（`reason=LLM_SESSION_DISABLED`）不进本分支 —— 在 `runGoal`
   *      入口提前 return（§4.1），判据无需为此分叉。
   */
  private shouldDegrade(res: LlmGoalResult): boolean {
    const code = res.error?.code;
    if (typeof code === 'string' && NON_DEGRADABLE_CODES.includes(code)) return false;
    if (code === 'PROVIDER_UNAVAILABLE') return true;
    if (code === 'EXECUTION_FAILED') {
      // 策略折叠来路（reason 是闸类契约码）⇒ 不降级；真运行时失败 ⇒ 零产物才降级
      const reason = res.error?.reason;
      if (typeof reason === 'string' && NON_DEGRADABLE_CODES.includes(reason)) return false;
      return res.artifacts.length === 0;
    }
    return false;
  }
}

/** loader 约定导出：createProvider */
export function createProvider(options?: WorkbuddyLlmProviderOptions): WorkbuddyLlmProvider {
  return new WorkbuddyLlmProvider(options);
}

export {
  CliLlmBridge,
  DEFAULT_CLI_ARG_TEMPLATE,
  // P2-T6 纯附加再导出（供 tests/unit 直接断言凭据承载形态与反证判据，无需起服务）
  DEFAULT_BEARER_ENV_NAME,
  containsBearerCredentialLiteral,
  appendDtid,
  buildMcpConfig,
  buildSystemPrompt,
  escapeWinArg,
  flattenPromptForCli,
  isFatalRuntimeStderr,
  renderCliArgs,
  resolveCliPath,
  writeSkillPack,
} from './bridge.js';
// K-N1（设计 §8-T01/§9）：委派真实性判据与完成声称模式（单一来源）对外暴露，
// 供 `tests/unit` 直接断言判定表与 dtid 拼接形态（纯逻辑，无需起服务）。
export {
  COMPLETION_CLAIM_PATTERN,
  evaluateDisabledRejection,
  reconcileApprovalTruth,
  reconcileDelegationTruth,
  type ApprovalTruthDeps,
  type ApprovalTruthInput,
  type ApprovalTruthRunCtx,
  type DelegationTruthDeps,
  type DisabledRejectionInput,
  type DisabledRejectionVerdict,
} from './delegation-truth.js';
export type {
  CliResolveResult,
  LlmBridge,
  LlmGoalInput,
  LlmGoalResult,
  LlmSkillDoc,
} from './bridge.js';
export {
  PersistentCliSession,
  PERSISTENT_CLI_ARG_TEMPLATE,
  buildUserMessageFrame,
  extractAssistantText,
  isInitEvent,
  renderPersistentArgs,
} from './persistent-session.js';
export type {
  CliChild,
  CliSpawnFn,
  PersistentCliSessionOptions,
  SessionLog,
  TurnResult,
} from './persistent-session.js';

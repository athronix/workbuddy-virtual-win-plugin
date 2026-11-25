/**
 * `TemplatePlanner` —— 把 `DeterministicAgentProvider.runGoal` 的**模板逻辑**原样搬出来。
 *
 * ## 这是一次「纯搬移」，不是重写（Step 4.2 的全部纪律）
 *
 * 判据：**行为零变化**，由现有 `runGoal` 单测证明。所以本文件里的：
 * - 五个模板的正则、顺序、`allowed()` 判定、失败文案 —— **逐字照搬**；
 * - `goalFail` / `goalCanceled` / `templateError` 的收口语义 —— **逐字照搬**；
 * - 注释里的历史决策留痕（O-1 保码、ARCH-22 取消、M3 引导）—— **逐字照搬**。
 *
 * 唯一的结构变化：原来是 `this.xxx()` 私有方法调用，现在是**窄依赖接口** `TemplatePlannerDeps`。
 * 这样做的目的不是「解耦好看」，而是让 `planner` 能**脱离 `init(ctx)`** 被单测直接驱动。
 *
 * ## 为什么用窄依赖而不是把 provider 传进来
 *
 * 若依赖整个 `DeterministicAgentProvider`，`TemplatePlanner` 就与 provider 的
 * 14 个私有成员死绑，等于「看起来抽出来了，实际上还是连体的」—— 下次谁想把 provider
 * 删掉，会发现 planner 也跟着不能编译。窄接口只声明**真正用到的 5 个东西**，
 * 边界是可验证的（`TemplatePlannerDeps` 的成员数就是答案）。
 */

import {
  type Artifact,
  type BridgeError,
  type CapabilityRequest,
  type CapabilityResult,
  type GoalRequest,
  type GoalResult,
  type GoalStep,
  type Planner,
  type PlannerId,
  type ProgressSink,
  type RiskLevel,
  makeError,
} from '@winvm/contracts';

/**
 * 工作流缺位时，「直调哪个 CLI」的映射（原 `WORKFLOW_CLI_APP`，**逐字搬移**）。
 *
 * 只有 `cliApp` 命中本表时才做「探测是否已装机」的引导；否则不给空引导。
 * 注意 `office → soffice`、`photoshop → magick` 这两条：刻意不是「装 Photoshop 本体」，
 * 而是「装能完成那类活的可编程工具」—— 因为 `appops.cli.invoke` 要的是命令行入口。
 */
const WORKFLOW_CLI_APP: Record<
  string,
  { cliApp: 'ffmpeg' | 'magick' | 'soffice' | 'pandoc'; probeName: string; nameMatchers: RegExp[] }
> = {
  ffmpeg: { cliApp: 'ffmpeg', probeName: 'ffmpeg', nameMatchers: [/ffmpeg/i] },
  office: { cliApp: 'soffice', probeName: 'libreoffice', nameMatchers: [/libreoffice/i] },
  photoshop: { cliApp: 'magick', probeName: 'imagemagick', nameMatchers: [/imagemagick/i, /\bmagick\b/i] },
};

/**
 * `TemplatePlanner` 的**窄依赖面** —— 只有这 5 个成员，多一个都不该加。
 *
 * 每一项的来源与「为什么 planner 自己做不到」：
 *
 * | 成员 | 为什么必须在外面 |
 * |---|---|
 * | `execute` | 真正的能力执行体（含策略闸/并发/审计），provider 才有 |
 * | `ctxCapabilityRisk` | 风险级别来自注册表（`ctx.capabilities`），planner 不持有注册表 |
 * | `traceId` | traceId 由 provider 统一生成，planner 自造会与服务端归因脱节 |
 * | `policyGateWiring` | 读的是进程级 env 决议（`resolvePolicyGateWiring()`），不是 planner 的配置 |
 * | `enableLlmPlanning` | 同上，provider options 的字段，只影响一句文案 |
 */
export interface TemplatePlannerDeps {
  /** 执行一次能力调用（provider 的 `execute`）。 */
  execute(req: CapabilityRequest): Promise<CapabilityResult>;

  /**
   * 取能力风险级别（注册表权威）；未登记时调用方给 L3 保守值。
   *
   * 返回 `RiskLevel` 而非 `string`：这个值直接进 `CapabilityRequest.risk`，
   * 用 `string` 会让「拼错 L 值」在编译期逃过去（如 `'L4'`），
   * 而 `risk` 是策略闸的输入之一，拼错等于闸悄悄失效。
   */
  capabilityRisk(capabilityId: string): RiskLevel;

  /** 造一个 traceId（provider 的 `newTraceId`）。 */
  newTraceId(): string;

  /** 策略闸接线态（`off` / `shadow` / `on`）。 */
  readonly policyGateWiring: 'off' | 'shadow' | 'on';

  /** `options.enableLlmPlanning`，只用于无匹配模板时的一句提示文案。 */
  readonly enableLlmPlanning: boolean;
}

/** 模板执行中单步的返回（原 `step()` 的返回类型，**逐字搬移**）。 */
interface StepOutcome {
  ok: boolean;
  data?: unknown;
  error?: BridgeError;
  canceled?: boolean;
}

/**
 * 确定性模板规划器。
 *
 * `id` 恒为 `'template'` —— 它是**配置面枚举**，不是可配项。
 */
export class TemplatePlanner implements Planner {
  readonly id: PlannerId = 'template';

  constructor(private readonly deps: TemplatePlannerDeps) {}

  /**
   * 规划并执行。
   *
   * ## 与 `runGoal` 的关系
   *
   * 方法体是 `DeterministicAgentProvider.runGoal` 的**逐字搬移**，包括：
   * - `scopeFeed` 预计算（批1 E-1/M2 第三调用点接线，仅 `on` 态喂入）；
   * - `step()` 咽喉点（ARCH-22 §1.1-4：**取消优先于执行**，在 `execute` 之前返回哨兵）；
   * - 五个模板的判定顺序与各自收口；
   * - `canceledReturn` / `goalFail` / `templateError` 的语义。
   *
   * ⚠ 任何「顺手优化」都违反本步纪律（行为零变化）。真要改，另起一步并单独取证。
   */
  async plan(goal: GoalRequest, sink: ProgressSink): Promise<GoalResult> {
    const steps: GoalStep[] = [];
    const artifacts: Artifact[] = [];
    const started = Date.now();

    /**
     * 步骤咽喉点（ARCH-22 §1.1-4，T5）。
     *
     * **取消优先于执行**：`sink.isCancelled?.() === true` 时在 `execute` **之前**返回
     * 取消哨兵 —— 本方法是五个目标模板唯一的执行闸口，因此「取消后零新能力调用」这一
     * 安全性质在此处一次成立，无需各模板重复判定（模板只需把哨兵转成收口形状）。
     * 哨兵不 push steps、不 push artifacts、不调 onArtifact（框架 `addArtifact` 另有
     * 终态二次闸门，此处不重复推送，避免 canceled 后仍有 artifact 流出的观测矛盾）。
     *
     * 返回值新增**纯附加可选**字段 `canceled`：模板据此走 `goalCanceled()`（契约码
     * `TASK_CANCELED`）而非 `goalFail()`（`EXECUTION_FAILED`）。两者不可混用 ——
     * LLM provider 的 `shouldDegrade` 会把「EXECUTION_FAILED 且零 artifact」回落成
     * 确定性执行器**重跑**，用错码等于把用户已叫停的任务再执行一遍。
     */
    // 批1（E-1/M2 第三调用点接线）：宿主**声明**的 scope 预计算一次（runGoal 期），
    // step 全部复用。仅 `on` 态喂入——本 provider 是 in-process 执行，`shadow` 的
    // 观测/改道语义归服务层（两处都 shadow 计数会分裂成两份真相）；`off` 与旧行为逐字一致。
    // maxRisk 只取声明（goal.maxRiskDeclared===true）——框架回退默认绝不喂=零断崖。
    // 注：缺省 deterministic 模板全 L0/L1，接线在缺省形态下不改变任何裁决（fail-closed 方向
    // 仅可能让显式声明的委派更严：低 maxRisk 声明会拒高步、白名单外步被拒，二者都是宿主本意）。
    const scopeFeed =
      this.deps.policyGateWiring === 'on'
        ? {
            ...(goal.allowedCapabilities && goal.allowedCapabilities.length > 0
              ? { scopeAllowedCapabilities: goal.allowedCapabilities }
              : {}),
            ...(goal.maxRiskDeclared === true && goal.maxRisk ? { scopeMaxRisk: goal.maxRisk } : {}),
          }
        : {};
    const step = async (
      capabilityId: string,
      params: Record<string, unknown>,
      summary: string,
    ): Promise<StepOutcome> => {
      if (sink.isCancelled?.() === true) {
        // O-1（P2-T10）：哨兵也走结构化 `BridgeError`（与 `goalCanceled()` 同族契约码
        // `TASK_CANCELED`）。旧实现返回裸字符串，模板层因此无法区分「取消」与「失败」以外的
        // 任何原因码 —— 保持码形一致才能让 step() 的两条出口共用同一透传规则。
        return { ok: false, canceled: true, error: makeError('TASK_CANCELED', '任务已取消，未发起该能力调用') };
      }
      const traceId = this.deps.newTraceId();
      sink.onStatus('working', `执行 ${capabilityId}：${summary}`);
      const riskForCap = this.deps.capabilityRisk(capabilityId);
      const res = await this.deps.execute({
        traceId,
        capabilityId,
        params,
        risk: riskForCap,
        approved: false,
        timeoutMs: goal.timeoutMs,
        // 批1：宿主声明 scope（`on` 态）随 step 下发到本 provider 的策略复评（第三调用点）。
        ...scopeFeed,
        // ARCH-29（P2-T4，**纯附加条件展开**）：把 A2A 侧的取消信号（`ProgressSink
        // .cancellationSignal`，与 `isCancelled()` 同一个 AbortController）交给 execute，
        // 使**一次在途能力调用**也能在取消时停止本地等待 —— 旧实现只能在调用返回后
        // 才在边界上发现取消（长能力调用最坏 540s）。
        // 两通道口径就此对齐：A2A=委派取消信号、MCP=宿主断连信号，都走同一个 `req.signal`
        // 消费面与同一个 `TASK_CANCELED` 收口（见 SECURITY-GOVERNANCE §2.2 两通道取消口径）。
        // 缺席即旧行为：第三方 sink 不实现该成员 ⇒ 键不进对象字面量（K-13 禁显式 undefined）。
        ...(sink.cancellationSignal ? { signal: sink.cancellationSignal } : {}),
      });
      steps.push({
        index: steps.length,
        capabilityId,
        params,
        ok: res.ok,
        risk: riskForCap,
        durationMs: res.durationMs,
        traceId,
        summary,
        ...(res.error ? { error: res.error } : {}),
      });
      // 执行**期间**被取消（长能力调用跑到一半宿主叫停）：该次调用已真实发生，故 steps 照常
      // 记账（呈现面据此事实化）。产物采取**双闸分叉口径**（T3 移交第 7 条 + §8 O-2）：
      //   · 本地 `artifacts` 仍如实收纳 —— 取消收口的 `GoalResult.artifacts` 是宿主文案计数
      //     与 QA 反查唯一可读的事实源（框架 O-2 快照里 `result` 在场，`task.artifacts` 只保持
      //     取消前既有内容，不会替 provider 补记），抹掉它等于把「确实产出了这张截图」这一
      //     可证事实从账上删除；
      //   · 流出面 `sink.onArtifact` 一律不再调用 —— 外推通道必须为 0，框架 `TaskStore.addArtifact`
      //     另有终态二次闸门，两侧口径一致才不会产生「宿主收到已取消任务的产物」的观测矛盾。
      // 因此本地的产物数可以大于宿主观测到的产物数，这是设计意图而非缺陷。
      if (sink.isCancelled?.() === true) {
        for (const a of res.artifacts ?? []) artifacts.push(a);
        // O-1（P2-T10）：旧实现 `res.error.message` 把 `BridgeError` 折叠成字符串，
        // `code` / `reason` 在模板路径上消失 ⇒ POLICY_DENIED / APPROVAL_REQUIRED /
        // SESSION_UNAVAILABLE 三码不可见，LLM 层 `shouldDegrade` 会把策略硬拒当「运行时
        // 不可用」降级重跑。此处起改为**结构化透传**（零契约变更：`GoalStep.error`
        // 本就是 `BridgeError`，step() 的 `error` 是其本地内联类型）。
        return { ok: res.ok, canceled: true, data: res.data, ...(res.error ? { error: res.error } : {}) };
      }
      for (const a of res.artifacts ?? []) {
        artifacts.push(a);
        sink.onArtifact(a);
      }
      return { ok: res.ok, data: res.data, ...(res.error ? { error: res.error } : {}) };
    };

    /**
     * 取消收口（五个模板共用）。文案只陈述**可证事实**：调用了几次能力、产出了几个
     * artifact（由 steps/artifacts 数组长度得出），不宣称「未执行任何变更」。
     */
    const canceledReturn = (): GoalResult => goalCanceled(steps, artifacts, started);

    const text = goal.goal;

    /* ---- 模板 1：安装应用 ---- */
    const installMatch = /安装\s*([A-Za-z0-9\u4e00-\u9fa5._\- ]{1,40})/.exec(text);
    if (installMatch && allowed(goal, 'app.winget.install')) {
      const query = installMatch[1]!.trim();
      const found = await step('app.winget.search', { query, limit: 5 }, `搜索「${query}」`);
      if (found.canceled) return canceledReturn();
      if (!found.ok) return goalFail(steps, artifacts, `搜索失败：${found.error?.message ?? '未知原因'}`, started, found.error);

      const list = (found.data as Array<{ id?: string; name?: string }> | undefined) ?? [];
      if (list.length === 0) {
        return goalFail(steps, artifacts, `未找到与「${query}」匹配的包，请改用 MCP 指定确切包 ID`, started);
      }
      const target = list[0]?.id;
      if (!target) {
        return goalFail(steps, artifacts, '搜索结果缺少包 ID，请改用 MCP 指定确切包 ID', started);
      }
      const installed = await step('app.winget.install', { id: target }, `安装 ${target}`);
      if (installed.canceled) return canceledReturn();
      return {
        ok: installed.ok,
        summary: installed.ok ? `已安装 ${target}` : `安装失败：${installed.error?.message ?? '未知原因'}`,
        artifacts,
        steps,
        ...(installed.ok ? {} : { error: templateError(installed.error, installed.error?.message ?? '安装失败') }),
      };
    }

    /* ---- 模板 2：磁盘空间分析（只分析，不删除 —— 安全默认） ---- */
    if (/(磁盘|空间|容量|占满|清理建议)/.test(text) && allowed(goal, 'storage.cleanup.analyze')) {
      const r = await step('storage.cleanup.analyze', { topLargeFiles: 30 }, '分析磁盘占用与清理建议');
      if (r.canceled) return canceledReturn();
      return {
        ok: r.ok,
        summary: r.ok
          ? '已完成磁盘分析并给出建议（**未执行任何删除**）。如需删除，请明确指定路径并逐项走审批。'
          : `分析失败：${r.error?.message ?? '未知原因'}`,
        artifacts,
        steps,
        ...(r.ok ? {} : { error: templateError(r.error, r.error?.message ?? '分析失败') }),
      };
    }

    /* ---- 模板 3：系统信息 ---- */
    if (/(系统信息|系统状态|配置|版本)/.test(text) && allowed(goal, 'system.info.get')) {
      const r = await step('system.info.get', {}, '获取系统信息');
      if (r.canceled) return canceledReturn();
      return {
        ok: r.ok,
        summary: r.ok ? '已获取系统信息' : `获取失败：${r.error?.message ?? '未知原因'}`,
        artifacts,
        steps,
        ...(r.ok ? {} : { error: templateError(r.error, r.error?.message ?? '获取失败') }),
      };
    }

    /* ---- 模板 4：截图 ---- */
    if (/(截图|截屏|看看屏幕|当前屏幕)/.test(text) && allowed(goal, 'gui.screen.capture')) {
      const r = await step('gui.screen.capture', { asBase64: true }, '截取当前屏幕');
      if (r.canceled) return canceledReturn();
      return {
        ok: r.ok,
        summary: r.ok ? '已截取当前屏幕（见 artifact）' : `截图失败：${r.error?.message ?? '未知原因'}`,
        artifacts,
        steps,
        ...(r.ok ? {} : { error: templateError(r.error, r.error?.message ?? '截图失败') }),
      };
    }

    /* ---- 模板 5：应用生产操作（appops） ---- */
    // 检测"用某个软件把活干出来"的生产意图；确定性 V1 只能调度**已登记的工作流**，
    // 开放/创意类意图（如"用 Photoshop 把大山换成海洋"）需升级 LLM VM Agent（见 SPEC-AGENT-SERVICE-BRIDGE §开放任务）。
    const productionHint = /(处理|编辑|生成|生产|转换|转码|批处理|换背景|加水印|去水印|导出|排版|报表|抠图|合成)/;
    const appHint = /(photoshop|ps\b|图片|照片|图像|excel|表格|报表|word|文档|报告|pdf|ffmpeg|视频|mp4|gif|浏览器|网页|ide|构建)/i;
    if (productionHint.test(text) && appHint.test(text) && allowed(goal, 'appops.workflow.run')) {
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
      if (r.canceled) return canceledReturn();
      if (r.ok) {
        return {
          ok: true,
          summary: '已调度应用生产工作流并执行成功（见 artifact）。如需更精细的开放意图处理，建议升级 VM Agent 为 LLM provider。',
          artifacts,
          steps,
        };
      }
      // 工作流未登记：明确引导（不硬猜、不伪造）。
      // O-1：step() 起为结构化 `BridgeError`，文案侧取 `.message`（旧实现是 `as string` 断言）。
      // 收口码仍固定 `UNSUPPORTED_GOAL`（本模板的业务结论是「确定性执行器没有这条工作流」，
      // 与上游来路码无关；且该码不在 `shouldDegrade` 触发集内，不存在降级重跑风险）。
      //
      // M3（Phase 3 批4 · 3a 最小修，台账口径=pm2 改档采纳版）：失败**不再是死路**——
      // 用 L0 `app.inventory.list` 探测映射 CLI 是否已在 VM 装机登记，命中即在文案里
      // 给出**当下可达的直调路径**（`appops.cli.invoke`，L1 不触闸、零契约变更；处置教育
      // 在位=mcp-reference「reason=CLI_NOT_FOUND → 先装应用别重试」），未命中则给安装配方。
      // 选型勘误留痕：PM 前棒原述"先 `appops.state.query` 预检"经亲验不成立——
      // Get-AppOpState 只枚举**运行中**应用/窗口，探不到未启动的已装 CLI；
      // `app.inventory.list`（注册表卸载键）才是装机证据源。探测本身 best-effort：
      // 探测失败/超时不改变业务结论（仍 UNSUPPORTED_GOAL），只少一条引导行（fail-safe）。
      const msg = r.error?.message ?? '工作流未找到';
      const cliApp = WORKFLOW_CLI_APP[preferredApp];
      let guidance: string;
      if (cliApp) {
        let installedEvidence = false;
        try {
          if (allowed(goal, 'app.inventory.list')) {
            const probe = await step(
              'app.inventory.list',
              { name: cliApp.probeName },
              `探测 ${cliApp.probeName} 是否已装机（工作流缺位时的直调可行性证据）`,
            );
            installedEvidence =
              probe.ok === true &&
              Array.isArray(probe.data) &&
              (probe.data as Array<{ name?: unknown }>).some((row) =>
                cliApp.nameMatchers.some((re) => re.test(String(row?.name ?? ''))),
              );
          }
        } catch {
          /* 探测异常 = 无证据，走未装引导；绝不把探测失败伪装成结论 */
        }
        guidance = installedEvidence
          ? `已探测到 VM 中存在 ${cliApp.probeName} 的装机登记：可直接调 appops.cli.invoke（app="${cliApp.cliApp}"，L1 不触审批）执行你的任务，无需工作流脚本。`
          : `未发现 ${cliApp.probeName} 装机登记：可先 app.winget.install 安装该应用，再直调 appops.cli.invoke（app="${cliApp.cliApp}"）。`;
      } else {
        guidance = '';
      }
      return {
        ok: false,
        summary:
          '确定性执行器未匹配到预置的生产工作流（' + preferredApp + '）。' +
          (guidance ? guidance + ' ' : '') +
          '其余两种解法：① 在 VM 的 workflows 目录预置 `generic_production` 工作流脚本；' +
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
        (this.deps.enableLlmPlanning
          ? '（LLM 规划已开启但 V1 未实现该分支）'
          : '建议：① 改用 MCP 通道逐步调用具体能力；② 或升级 provider 为 LLM Agent（改配置 agent.provider 即可，框架无需改动）。'),
      artifacts,
      steps,
      error: makeError('UNKNOWN_CAPABILITY', 'UNSUPPORTED_GOAL：无匹配的目标模板'),
    };
  }
}

/* ============================ 以下为模块级纯函数 ============================ */
/* 从 provider 私有方法搬出。搬成模块级函数而非类方法，是因为它们**不读任何实例状态**
 * ——（goalFail/goalCanceled 只读入参，templateError/allowed 无状态），
 * 留在类里会让人误以为它们依赖 provider 的生命周期。 */

/**
 * 宿主声明的能力白名单判定（原 `private allowed`，**逐字搬移**）。
 *
 * 空/缺席 = 不限制（历史行为）；支持 `domain.*` 通配。
 */
function allowed(goal: GoalRequest, capabilityId: string): boolean {
  if (!goal.allowedCapabilities || goal.allowedCapabilities.length === 0) return true;
  return goal.allowedCapabilities.some(
    (p) => p === capabilityId || (p.endsWith('.*') && capabilityId.startsWith(p.slice(0, -1))),
  );
}

/** 失败收口（原 `private goalFail`，**逐字搬移**）。 */
function goalFail(
  steps: GoalStep[],
  artifacts: Artifact[],
  summary: string,
  started: number,
  stepError?: BridgeError,
): GoalResult {
  return {
    ok: false,
    summary: `${summary}（耗时 ${Date.now() - started}ms）`,
    artifacts,
    steps,
    error: templateError(stepError, summary),
  };
}

/**
 * 模板失败收口的契约码（**O-1 · P2-T10**，原 `private templateError`，**逐字搬移**）。
 *
 * 旧形状：四个模板内联 `makeError('EXECUTION_FAILED', <上游 .message>)` + `goalFail`
 * 一律 `makeError('EXECUTION_FAILED', summary)` —— 上游 `execute()` 已经算好的
 * `POLICY_DENIED` / `APPROVAL_REQUIRED` / `SESSION_UNAVAILABLE` 等码在这里被压平
 * （丢码现场是 `step()` 的 `.message` 折叠，压平是它的下游后果）。
 *
 * 现形状：**上游有码 ⇒ 沿用来路码**，`reason` / `details` 保真透传，`retryable`
 * 沿用来路值（来路已显式覆写的 —— 如并发闸门把 TIMEOUT 置 true —— 不得被本层改写；
 * 未覆写时由 `DEFAULT_RETRYABLE` 按码给出）。
 * `message` 参数**由调用方按旧实现逐字传入**（模板内联传上游 message、`goalFail`
 * 传合成 summary），因此本批只改码与原因面，**宿主可读文案零漂移**。
 * 上游无码（模板自身的业务判定，如「未找到匹配的包」）⇒ 仍 `EXECUTION_FAILED` 兜底，
 * 与旧行为**逐字一致**。
 *
 * 为什么必须保码（安全性质）：`WorkbuddyLlmProvider.shouldDegrade` 把
 * 「`EXECUTION_FAILED` 且零 artifact」判定为「LLM 运行时不可用」并回落确定性执行器**重跑**。
 * 策略硬拒零产物 ⇒ 折叠后即命中该判据 ⇒ 被拦截的写操作绕过审批闸再执行一遍。
 * 与 `shouldDegrade` 的排除判据属**同批原子改**，两者缺一即保码无效。
 */
function templateError(stepError: BridgeError | undefined, message: string): BridgeError {
  if (!stepError) return makeError('EXECUTION_FAILED', message);
  return makeError(stepError.code, message, {
    retryable: stepError.retryable,
    ...(stepError.reason !== undefined ? { reason: stepError.reason } : {}),
    ...(stepError.details !== undefined ? { details: stepError.details } : {}),
  });
}

/**
 * 取消收口（ARCH-22 T5，设计 §1.1-4，原 `private goalCanceled`，**逐字搬移**）。
 *
 * 与 `goalFail` 的三点区别，缺一不可：
 *   1. **契约码用 `TASK_CANCELED`**（不是 `EXECUTION_FAILED`）。LLM provider 的
 *      `shouldDegrade` 会把「EXECUTION_FAILED 且 artifacts 为空」判定为可降级并
 *      回落确定性执行器**重跑** —— 用错码等于把用户已叫停的任务再执行一遍。
 *   2. **文案只陈述可证事实**（已发起的能力调用次数 = steps.length、已产出 artifact
 *      数 = artifacts.length）。steps 里最多包含取消判定**之前**已真实完成的调用，
 *      故绝不能宣称「未执行任何变更」。
 *   3. `retryable:false`（由 `DEFAULT_RETRYABLE` 决定）—— 重跑必须重新发起委派、
 *      重新过审批闸，而不是对同一任务自动重试。
 *
 * artifacts / steps 原样透出（O-2：取消收口不改写既有内容，框架侧亦不再落新产物）。
 */
function goalCanceled(steps: GoalStep[], artifacts: Artifact[], started: number): GoalResult {
  const summary =
    `任务已取消：取消判定生效前共发起 ${steps.length} 次能力调用、产出 ${artifacts.length} 个 artifact` +
    '；此后未再发起任何能力调用（如需继续，请重新发起委派并重新过审批）';
  return {
    ok: false,
    summary: `${summary}（耗时 ${Date.now() - started}ms）`,
    artifacts,
    steps,
    error: makeError('TASK_CANCELED', summary),
  };
}
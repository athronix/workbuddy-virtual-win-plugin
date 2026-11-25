/**
 * 上游面闸门 —— `/mcp/browser`、`/mcp/desktop` 的「策略 → 审计 → 执行」入口（Step 3.2）。
 *
 * ## 病灶：58 个工具此前裸奔
 *
 * 改动前，上游分支是（`server.ts` 的 `/mcp/<id>` 路由）：
 *
 * ```ts
 * const upstreamServer = await upstreamMcp(upstreamId);
 * const result = await upstreamServer.handleRequest(parsed, ...);   // 直接执行
 * ```
 *
 * 没有策略、没有审批、没有审计。于是 `browser.meta.eval`（**页内执行任意 JS，L2**）
 * 与 `desktop.pointer.click` 在链上**一个字都没有** —— 事后无法回答「谁在什么时候
 * 通过浏览器执行了什么 JS」。这是本步要修的安全核心。
 *
 * ## 为什么不能复用 `gateAndExecute()`（实测三次推翻计划书）
 *
 * 计划书原文写的是 `gateAndExecute(entry, call.args, ctx)`。实测（2026-11-24）三处不成立：
 *
 * | # | 冲突 | 后果 |
 * |---|---|---|
 * | ① | `GateCall.cap` 要求 `CapabilityDefinition`，上游只有 `CapabilityEntry` | 类型不过 |
 * | ② | 上游 id 不在 `CAPABILITY_DOMAINS` ⇒ 注册即抛错 | 无法走 registry |
 * | ③ | 引擎第 1 步 `registry.has()`，registry 只装 vm 面 54 项 | **58 项 100% 被判 `UNKNOWN_CAPABILITY`** |
 *
 * ③ 是致命的：照计划书改，上游工具会从「裸奔但可用」变成「过闸但全拒」。
 * 那不是修安全，是把功能改挂。所以本模块**不套** `gateAndExecute`，而是复用它的
 * **判定语义**（策略 → 审批 → 审计 → 执行）与同一批设施，走一条面适配过的路径。
 *
 * ## 为什么上游参数不能交给 vm 面策略（更隐蔽的一条）
 *
 * 即使解决 registry 问题，参数仍会被误伤 —— 实测：
 *
 * | 调用 | vm 面裁决 | 错在哪 |
 * |---|---|---|
 * | `browser.nav.open {url:'https://example.com/a/b'}` | `pathAllowlist:miss` 拒 | url 被当文件路径 |
 * | `desktop.input.type {text:'C:\Windows\System32\x'}` | `pathDenylist` 拒 | 这是要**输入的文字**，不是要写的文件 |
 *
 * ⇒ 策略必须**按面隔离**（见 `surface-policy.ts`）。本模块拿到的 `engine` 已经是
 * 该面裁剪过的实例，此处不再做任何裁剪判断（单一职责）。
 *
 * ## 与 vm 面的语义差异（刻意保留的差异，不是遗漏）
 *
 * | 维度 | vm 面（`gateAndExecute`） | 上游面（本模块） |
 * |---|---|---|
 * | 执行体 | `executeCapability`（ps-bridge → PowerShell） | `handleRequest`（stdio 上游） |
 * | 审批令牌 | 注册后可服务端**重放**（参数留存、确定性执行） | **不重放**：上游是**有状态**的外部进程（浏览器会话），重放语义不成立 |
 * | 拦截后 | `APPROVAL_REQUIRED` + `__approvalId` 续跑 | `DELEGATION_REQUIRED`：L2 及以上一律走委派审批 |
 * | 审计 | executed 由 provider 落 | executed 由**本模块**落（上游无 provider） |
 *
 * 「不重放」这一条要说清楚：vm 面的重放之所以成立，是因为参数是**完整**的、执行是
 * **幂等可重演**的（PowerShell 调用）。浏览器自动化不满足 —— `click {ref:'e12'}` 的
 * ref 属于**产生它的那次快照**，重放时页面早已不同。伪造"重放"只会得到一次
 * 打空或打错目标的点击，比不重放更危险。故上游 L2 一律收口为「须走委派」，由
 * 委派回合内的 LLM 在**当时**重新决定动作。
 */

import type { AuditSink, CapabilityEntry, PolicyEngine, RiskLevel, Surface } from '@winvm/contracts';
import type { McpToolResult } from '@winvm/mcp-framework';
import type { FileLogger } from '@winvm/core';

/**
 * 上游闸的灰度三态，语义与仓内既有 `PolicyGateWiringMode` **同构**（刻意复用同一套词）。
 *
 * | 值 | 行为 | 用途 |
 * |---|---|---|
 * | `on`（缺省） | 完整判定 + 审计 + 拦截 | 正常生产 |
 * | `shadow` | **完整判定**并写审计（含"本应拦截"的记录），但**放行执行** | 灰度观察误伤率，先看再执法 |
 * | `off` | 完全跳过（逐字旧行为：直接透传） | 一键回滚 |
 *
 * 为什么 `shadow` 也要写审计：灰度期最需要的数据是「如果执法会拒掉哪些」，
 * 不写审计就失去灰度的全部意义（只能靠猜）。
 */
export type UpstreamPolicyMode = 'on' | 'shadow' | 'off';

/**
 * 上游闸依赖的设施。全部由 `createService()` 注入（本模块不构造任何一件）。
 */
export interface UpstreamGateDeps {
  /**
   * 该面**已按面隔离**的策略引擎（构造时传 `surface: 'browser' | 'desktop'`）。
   *
   * 取 contracts 的 `PolicyEngine` 契约而不是具体类：单测可注入替身，
   * 生产仍注入 `CorePolicyEngine` 实例。类型上就排除了"传错引擎"——
   * 若传入 vm 面那个实例，参数级策略会误伤（见文件头实测表）。
   */
  readonly engine: PolicyEngine;
  /**
   * 审计链写端（策略拒绝 / 拦截 / 执行三种条目都落这里）。
   *
   * ⚠ 这里曾写成 `{ append(record: Record<string, unknown>) }` —— 那是一处**结构性绕过**：
   * `Record<string, unknown>` 让本模块的 `ext` 字段完全逃过契约检查，于是
   * `surface` / `upstreamTool` / `upstreamDecision` 三个字段虽然一直在写，`AuditExt` 里却
   * 查不到它们 —— 字段名拼错、语义漂移、被静默丢弃，编译器一律不报。
   * 现已改回真实契约：类型取自 `AuditSink.append` 的入参本身（不手抄形状，
   * 否则契约演进时这份手抄版会悄悄落后），三个字段也已正式登记进 `AuditExt`。
   */
  readonly audit: Pick<AuditSink, 'append'>;
  /** 本面统一表中的条目查找（`surface + tool` → entry）。**不在表内即拒**。 */
  readonly lookupEntry: (surface: Surface, toolName: string) => CapabilityEntry | undefined;
  /**
   * 真正执行 —— 由 `server.ts` 包成「调上游 `handleRequest`」。
   *
   * 刻意让调用方提供而不是本模块持有 `McpServer`：本模块只负责**判定与取证**，
   * 不关心执行体是 stdio 上游还是别的什么。这也是它能被单测直接驱动的根本原因。
   */
  readonly execute: (toolName: string, args: Record<string, unknown>) => Promise<McpToolResult>;
  readonly mode: UpstreamPolicyMode;
  readonly newId: (prefix: string) => string;
  readonly logger: FileLogger;
}

/** 一次上游调用的描述。 */
export interface UpstreamCall {
  readonly surface: Surface;
  /** 上游工具名（如 `agent_browser_open`，**不是**统一表 id）。 */
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly ctx: {
    readonly traceId: string;
    readonly delegationId?: string;
  };
}

/**
 * 判定结果（内部形态）。抽出成类型是为了让「判定」与「呈报」分开 ——
 * 前者可以脱离 HTTP 单测，后者只管把结论翻译成信封。
 *
 * ⚠ `entry` 在「不在统一表内」的那个分支里是**合成对象**（见 `syntheticEntry`）：
 * 那种情况下表里根本没有这一条，但审计与告警仍需要 id 与 risk 才能定位。
 * 合成是显式的一步（不是"假装查到了"），并且 risk 取 `L2`（保守：宁可多报一次
 * 也不把未知工具当只读记录）。
 */
export type UpstreamVerdict =
  | {
      readonly kind: 'execute';
      readonly entry: CapabilityEntry;
      readonly rule: string;
      readonly synthetic?: false;
    }
  | {
      readonly kind: 'deny';
      readonly entry: CapabilityEntry;
      readonly code: 'UNKNOWN_UPSTREAM_TOOL' | 'POLICY_DENIED' | 'DELEGATION_REQUIRED';
      readonly rule: string;
      readonly message: string;
      /** true = entry 是合成对象（工具不在表内），审计里据此区分。 */
      readonly synthetic?: boolean;
    }
  /** shadow 态下「本应拒但放行」—— 单列一类，便于审计里一眼区分「真放行」与「灰度放行」。 */
  | {
      readonly kind: 'shadow-allow';
      readonly entry: CapabilityEntry;
      readonly wouldBe: 'POLICY_DENIED' | 'DELEGATION_REQUIRED';
      readonly rule: string;
      readonly message: string;
      readonly synthetic?: false;
    };

/**
 * 为「不在表内」的工具造一个**仅用于取证与呈报**的条目。
 *
 * 为什么要造：审计条目强制要求 `capabilityId` + `risk`。工具不在表内时这两个值
 * 客观上不存在，但「这个未知工具被调用过」恰恰是**最需要留痕**的事实
 * （白名单与统一表不同步 = fail-open 入口，必须显形）。
 *
 * 形态 `面.unregistered.工具名`：含 `unregistered` 段，任何按 id 前缀扫描的
 * 运维脚本都能一眼筛出这类异常；不会与真实 id 冲突（真实 id 中段是语义分组名）。
 * risk 取 `L2`：保守方向 —— 未知工具若被记账为 L0，看链的人会以为它无害。
 */
function syntheticEntry(surface: Surface, toolName: string): CapabilityEntry {
  return {
    id: `${surface}.unregistered.${toolName}`,
    surface,
    risk: 'L2',
    title: `未登记上游工具 ${toolName}`,
  };
}

/**
 * 判定：这次调用该不该执行。
 *
 * 判据顺序（**顺序本身是安全语义，不可重排**）：
 *
 * 1. **工具是否在本面统一表内** —— 不在即拒（fail-closed）。这条同时兜住
 *    「白名单与统一表不一致」的情况：那种不一致会让某工具**无规则可查**，
 *    若默认放行就是 fail-open。
 * 2. **策略引擎裁决**（含能力级黑名单 / risk 审批 / dry-run 双条件）。
 * 3. 裁决拒绝时区分**两种拒绝**：
 *    - `requiresApproval` ⇒ `DELEGATION_REQUIRED`（上游不重放，只能走委派）
 *    - 其它 ⇒ `POLICY_DENIED`（硬拒绝：黑名单命中、超出 maxRisk 等）
 *
 * ⚠ 第 3 步的区分**不能合并**：两者对宿主的可行动指引完全不同 ——
 * 把硬拒绝写成「请走委派审批」会诱导宿主反复尝试一条永远不会通的路
 * （这与 vm 面 P0-1「死令牌死循环」是同一类病灶，别再犯一次）。
 */
export function evaluateUpstreamCall(
  deps: Pick<UpstreamGateDeps, 'engine' | 'lookupEntry' | 'mode'>,
  call: UpstreamCall,
): UpstreamVerdict {
  const { engine, lookupEntry, mode } = deps;
  const { surface, toolName, args } = call;

  const found = lookupEntry(surface, toolName);
  if (!found) {
    // 不在统一表 ⇒ 无规则可查。**绝不默认放行**（那是 fail-open）。
    return {
      kind: 'deny',
      entry: syntheticEntry(surface, toolName),
      code: 'UNKNOWN_UPSTREAM_TOOL',
      rule: 'upstream:tool-not-in-unified-table',
      message:
        `上游工具 "${toolName}" 不在 ${surface} 面统一能力表内 ⇒ 无策略规则可查，` +
        `按 fail-closed 拒绝。请检查 upstream-tools.ts 的白名单与统一表是否同步。`,
      synthetic: true,
    };
  }
  const entry = found;

  // 走本面（已裁剪）的引擎。`approvalId` 恒不传：上游面不做续跑重放（见文件头对照表）。
  const verdict = engine.evaluate({
    capabilityId: entry.id,
    params: args,
    risk: entry.risk,
    approved: false,
  });

  if (verdict.allowed) {
    return { kind: 'execute', entry, rule: verdict.matchedRule };
  }

  // 拒绝：区分「需审批」与「硬拒绝」。
  const isApproval = verdict.requiresApproval === true;
  const rule = verdict.matchedRule;
  const message = verdict.error?.message ?? (isApproval ? '需审批' : '被策略拒绝');

  if (mode === 'shadow') {
    // 灰度：**如实记下"本应拒"**，但放行执行。
    // 注意 wouldBe 用真值而非固定值 —— 否则审计里分不清灰度拦的是哪一类。
    return {
      kind: 'shadow-allow',
      entry,
      wouldBe: isApproval ? 'DELEGATION_REQUIRED' : 'POLICY_DENIED',
      rule,
      message,
    };
  }

  return {
    kind: 'deny',
    entry,
    code: isApproval ? 'DELEGATION_REQUIRED' : 'POLICY_DENIED',
    rule,
    message,
  };
}

/** 把「拒绝」翻译成宿主能读的信封（与 vm 面 `structuredContent` 同形）。 */
function denyEnvelope(
  call: UpstreamCall,
  entry: CapabilityEntry,
  code: string,
  rule: string,
  message: string,
): McpToolResult {
  const isDelegation = code === 'DELEGATION_REQUIRED';
  return {
    isError: true,
    structuredContent: {
      traceId: call.ctx.traceId,
      ok: false,
      error: {
        code,
        message: isDelegation
          ? `能力 ${entry.id}（风险 ${entry.risk}）须经**委派审批通道**执行：` +
            '上游工具面**不提供服务端重放**（浏览器/桌面都是有状态会话，' +
            '重放时的页面与控件早已不是批准时那一个），因此不发续跑令牌。' +
            '请改用 a2a.delegate 发起（宿主批准 → 委派回合内重新决定动作）。'
          : message,
        retryable: false,
      },
      risk: entry.risk,
      surface: call.surface,
      tool: call.toolName,
      matchedRule: rule,
      ...(isDelegation ? { guidance: { via: 'a2a.delegate', reason: 'upstream-no-replay' } } : {}),
    },
  };
}

/**
 * 过闸执行：上游面的**唯一**入口。
 *
 * 返回值直接是 MCP 工具结果，调用方拿到即可原样回给宿主 —— 与 `gateAndExecute`
 * 同一契约（闸不只判定，还负责把结论翻译成信封）。
 */
export async function gateUpstreamAndExecute(
  deps: UpstreamGateDeps,
  call: UpstreamCall,
): Promise<McpToolResult> {
  const { audit, execute, newId, logger, mode } = deps;
  const startedAtMs = Date.now();

  // `off` ⇒ 逐字旧行为：不判定、不审计、直接执行。
  // ⚠ 这条分支的存在本身要被审计外的人知道（启动期已 warn 一次），但**不写链** ——
  // 写链就等于承认"我们知道这次调用没受管辖"，那不如不放这个开关。运维要的是
  // "关掉时行为完全等于改动前"，多一条审计就不等于了。
  if (mode === 'off') {
    return execute(call.toolName, call.args);
  }

  const verdict = evaluateUpstreamCall(deps, call);

  /* ---------- 拒绝分支：落审计 → 回信封（不执行） ---------- */
  if (verdict.kind === 'deny') {
    void recordUpstreamAudit(audit, logger, call, verdict.entry, newId, {
      decision: 'denied',
      rule: verdict.rule,
      code: verdict.code,
      message: verdict.message,
      startedAtMs,
    });
    return denyEnvelope(call, verdict.entry, verdict.code, verdict.rule, verdict.message);
  }

  /* ---------- shadow 放行：落"本应拒"审计 → 照常执行 ---------- */
  if (verdict.kind === 'shadow-allow') {
    void recordUpstreamAudit(audit, logger, call, verdict.entry, newId, {
      decision: 'shadow-allowed',
      rule: verdict.rule,
      message: `本应 ${verdict.wouldBe}，灰度期放行：${verdict.message}`,
      code: verdict.wouldBe,
      startedAtMs,
    });
  }

  /* ---------- 执行（真放行 或 shadow 放行） ---------- */
  const entry = verdict.entry;
  try {
    const result = await execute(call.toolName, call.args);
    // executed 审计：上游面**没有 provider**（vm 面的 executed 条目由 provider 落），
    // 因此必须由本模块落 —— 否则「执行过」这件事在链上依然无痕，等于没修。
    void recordUpstreamAudit(audit, logger, call, entry, newId, {
      decision: 'executed',
      rule: verdict.rule,
      // 仅在**失败**时带 errorCode：成功条目带 code 会让按 code 聚合的运维查询
      // 把成功与失败混在一起（vm 面 succeeded 条目也不带 errorCode，同口径）。
      ...(result.isError === true ? { code: 'EXECUTION_FAILED' } : {}),
      message:
        result.isError === true
          ? `${entry.id} 执行返回错误`
          : `${entry.id} 执行成功（上游 ${call.surface} 面）`,
      startedAtMs,
      ok: result.isError !== true,
    });
    return result;
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    void recordUpstreamAudit(audit, logger, call, entry, newId, {
      decision: 'executed',
      rule: verdict.rule,
      code: 'EXECUTION_FAILED',
      message: `${entry.id} 执行抛错：${msg}`,
      startedAtMs,
      ok: false,
    });
    // 抛错不吞：调用方（HTTP 路由）已有 502 处理分支，语义在那里更准确
    // （"上游不可用"与"策略拒绝"是不同的事，不能混成一个信封）。
    throw e;
  }
}

/**
 * 写一条上游审计。
 *
 * `void` 调用（best-effort）：审计写失败**不得**改变调用结果 ——
 * 与 `recordPolicyDeniedAudit` / `recordBlockedApprovalAudit` 同一纪律
 * （拒绝语义优先于取证；反过来的话，磁盘满时安全拦截会失效）。
 *
 * `capabilityId` 取**统一表 id**（`browser.nav.open`），不取上游 tool 名
 * （`agent_browser_open`）：链上跨面查询必须能按同一字段聚合，而 vm 面写的就是
 * 统一 id 空间。上游 tool 名另存 `ext.upstreamTool`，两者都可查、互不覆盖。
 */
async function recordUpstreamAudit(
  audit: UpstreamGateDeps['audit'],
  logger: FileLogger,
  call: UpstreamCall,
  entry: CapabilityEntry,
  /** ID 生成器由调用方传入 —— 本函数是模块级（不持有 `createService` 闭包）。 */
  newId: (prefix: string) => string,
  input: {
    readonly decision: 'denied' | 'shadow-allowed' | 'executed';
    readonly rule: string;
    readonly code?: string | undefined;
    readonly message: string;
    readonly startedAtMs: number;
    readonly ok?: boolean;
  },
): Promise<{ ok: boolean; error?: string }> {
  try {
    await audit.append({
      ts: new Date().toISOString(),
      traceId: call.ctx.traceId,
      auditId: newId('aud'),
      principal: {
        host: 'vm-service',
        user: process.env['USERNAME'] ?? 'unknown',
        channel: call.ctx.delegationId ? 'a2a' : 'mcp',
      },
      capabilityId: entry.id,
      risk: entry.risk,
      params: call.args,
      policyDecision: {
        allowed: input.decision !== 'denied',
        matchedRule: input.rule,
      },
      ...(input.decision === 'denied'
        ? {
            approval: {
              approvalId: 'policy-denied',
              approvedBy: 'policy-engine',
              approvedAt: new Date().toISOString(),
              previewHash: '',
            },
          }
        : {}),
      result: {
        ok: input.ok ?? input.decision !== 'denied',
        ...(input.code ? { errorCode: input.code } : {}),
        summary: `${input.decision === 'denied' ? 'blocked' : input.decision}:${input.message}`,
      },
      durationMs: Date.now() - input.startedAtMs,
      // 上游面归因：事后可精确回答「谁在什么时候通过哪个面上调了哪个工具、结果如何」。
      // `surface` / `upstreamTool` / `decision` 三件套是上游面**独有**的取证位 ——
      // 没有它们，链上只能看到 `browser.nav.open` 被调用过，却不知走的是哪个端点。
      ext: {
        kind: 'inner-call' as const,
        ...(call.ctx.delegationId ? { delegationId: call.ctx.delegationId } : {}),
        channel: call.ctx.delegationId ? ('a2a' as const) : ('mcp' as const),
        surface: call.surface,
        upstreamTool: call.toolName,
        upstreamDecision: input.decision,
      },
    });
    return { ok: true };
  } catch (e) {
    logger.warn('上游面审计写入失败（不影响调用结果）', {
      surface: call.surface,
      tool: call.toolName,
      error: String(e),
    });
    return { ok: false, error: String(e) };
  }
}
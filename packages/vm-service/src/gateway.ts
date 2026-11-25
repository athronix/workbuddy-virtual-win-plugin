/**
 * 统一闸门 —— 「策略 → 审批 → 执行 → 审计」的**抽取件**（Step 3.1）。
 *
 * ## 为什么单独成文件
 *
 * 这段逻辑此前内联在 `server.ts` 的 `McpTool.handler` 闭包里（约 270 行），于是它**只服务
 * 一个调用方**：`POST /mcp` 的 vm 面。上游两路（`POST /mcp/browser`、`POST /mcp/desktop`）
 * 走的是另一段完全独立的代码 —— 直接 `upstreamServer.handleRequest()`，**不过策略、不过审批、
 * 不落审计**。58 个工具因此裸奔（Step 3.2 要修的就是这个）。
 *
 * 抽出来的意义不是"文件更短"，而是让**闸成为一个可被多方调用的单元**：把这段提到闭包外面，
 * 上游分支才可能复用同一份判定，而不是抄一遍再各自漂移。
 *
 * ## ⚠ 本文件是**纯搬运**，语义一字不改
 *
 * Step 3.1 的验收要求是"搬运前后行为逐字一致"。因此本文件的函数体是原 handler 体的**逐行
 * 副本**（只做了整体缩进 −2 空格，因为从 4 空格嵌套提到模块级 2 空格）。任何"顺手优化"
 * 都违反本步纪律：想改语义请单独提交，否则无法用测试区分"搬运引入"与"优化引入"的回归。
 *
 * ## 依赖注入而不是读闭包
 *
 * 原实现直接读 `server.ts` 里 `createService()` 的局部变量（`audit` / `pendingApprovals` /
 * `evaluateScoped` / `executeCapability` …）。搬到模块级后这些名字不再在作用域内，故全部
 * 改为 `GateDeps` 的字段，并在函数入口用**同名解构**还原 —— 函数体因此能逐字不动。
 *
 * 这是有意的设计：解构行就是这份抽取件的"接线清单"，扫一眼即知它依赖哪些服务端设施。
 * 不改成 `deps.xxx` 前缀式访问，是因为那会让函数体与原实现产生 20+ 处文本差异，
 * 违背"纯搬运、逐字可比对"的纪律。
 */

import type {
  CapabilityDefinition,
  PolicyVerdict,
  RiskLevel,
} from '@winvm/contracts';
import type { McpToolResult } from '@winvm/mcp-framework';
import type { FileLogger, HashChainAuditSink } from '@winvm/core';

import type { DelegationScopeEntry } from './delegation-scope.js';
import type { PendingApproval } from './server.js';
// ⚠ 以下四个 `import type` 只为取 `typeof` —— 用真实模块的签名，不手抄一遍：
// 手抄的类型**一定会漂移**（本步首版就漂了：scopeLookupKeys 被写成返回 `readonly string[]`、
// `scopeRegistry.lookup` 被写成收 `readonly string[]`，而真实签名收的是对象查询）。
// 这类漂移在 TS 上表现为"装配点红"，但若装配处用了宽化断言就会静默放过 ⇒ 宁可用 typeof。
import type {
  deriveUnderlying as deriveUnderlyingImpl,
  recordBlockedApprovalAudit,
  recordPolicyDeniedAudit,
} from './approval-replay.js';
import type { DelegationScopeRegistry } from './delegation-scope.js';
import type * as PolicyGate from './policy-gate.js';

/**
 * 一次被闸调用的**调用方事实**。
 *
 * 与 `GateDeps` 分开：`deps` 是服务启动时就固定的**设施**（审计 sink、令牌表、执行器），
 * 而这里的字段是**每次调用**都不同的输入。混成一个对象会让"哪些是本次调用特有的"变模糊，
 * 也让单测必须伪造一堆无关设施。
 */
export interface GateCall {
  /** 能力定义（含 risk/policy/input schema —— 预览与策略都要用）。 */
  readonly cap: CapabilityDefinition;
  /** 调用方原始参数（含 `__approvalId`；函数内部自行剥离）。 */
  readonly params: Record<string, unknown>;
  /** MCP 传输层上下文：`traceId` 必填，`delegationId` 仅委派内层回连才有。 */
  readonly ctx: {
    readonly traceId: string;
    readonly delegationId?: string;
  };
}

/**
 * 闸依赖的**服务端设施**。全部由 `createService()` 注入，本模块不自行构造任何一件。
 *
 * 逐项对应原闭包里的同名字段，故函数体可逐字复用：
 *
 * | 字段 | 原闭包来源 | 用途 |
 * |---|---|---|
 * | `audit` | `HashChainAuditSink` 包装件 | 审计链写端（策略拒绝/拦截/执行） |
 * | `pendingApprovals` | `PendingApprovalRegistry` | 审批令牌表（读批准态、注册令牌） |
 * | `evaluateScoped` | `server.ts` 内函数 | 策略评估单点（含 scope 灰度三态） |
 * | `executeCapability` | `server.ts` 内函数 | 真实执行段（含 K6 折叠、回执缓存） |
 * | `ledgerReg` | `LedgerRegistry` | 委派活动账本（blocked 归因分发） |
 * | `scopeRegistry` | `DelegationScopeRegistry` | 委派 scope 留存表（内层回查） |
 * | `buildPreview` / `collectImpact` / `deriveUnderlying` | 纯函数 | 审批卡预览与影响清单 |
 * | `hashApprovalPreview` | `@winvm/core` | 预览哈希（ARCH-09 绑定） |
 * | `newId` | `@winvm/core` | 审计/令牌 ID |
 * | `logger` | `FileLogger` | 可观测面 |
 */
export interface GateDeps {
  /** 真实类型取自 `HashChainAuditSink` 的 `append`/`record` 面（见 `server.ts` 装配点）。 */
  readonly audit: HashChainAuditSink;
  readonly pendingApprovals: {
    get(id: string): PendingApproval | undefined;
    set(id: string, token: PendingApproval): void;
    delete(id: string): void;
    readonly ttl: number;
  };
  readonly evaluateScoped: (
    cap: CapabilityDefinition,
    params: Record<string, unknown>,
    approved: boolean,
    approvalId: string | undefined,
    scope: DelegationScopeEntry | undefined,
    traceId: string,
  ) => PolicyVerdict;
  readonly executeCapability: (
    cap: CapabilityDefinition,
    params: Record<string, unknown>,
    seg: ExecutionSegment,
  ) => Promise<McpToolResult>;
  readonly ledgerReg: {
    recordBlocked(
      seq: number,
      approvalId: string,
      capabilityId: string,
      meta: { delegationId?: string; risk: RiskLevel },
    ): void;
  };
  /** 真实类型取自 `DelegationScopeRegistry`（不手抄，见文件头"手抄即漂移"）。 */
  readonly scopeRegistry: Pick<DelegationScopeRegistry, 'lookup'>;
  /** 真实类型取自 `policy-gate` 模块（入参是探测器对象，**不是**键数组）。 */
  readonly scopeLookupKeys: typeof PolicyGate.scopeLookupKeys;
  readonly isInnerDelegation: typeof PolicyGate.isInnerDelegation;
  readonly isDirectWithActiveTurn: typeof PolicyGate.isDirectWithActiveTurn;
  readonly shouldReturnDelegationRequired: typeof PolicyGate.shouldReturnDelegationRequired;
  /**
   * 审批协调器 —— 函数体只用到 `getActiveTaskId()`（判「委派内层」的第二个事实来源）。
   * 注入整个对象而不是单个方法：函数体里写的是 `approvalCoordinator.getActiveTaskId()`，
   * 若改注入裸函数则函数体必须改写 ⇒ 破坏"逐字搬运"纪律。
   */
  readonly approvalCoordinator: { getActiveTaskId(): string | undefined };
  readonly policyGateWiring: 'off' | 'on' | 'shadow';
  readonly policyGateCounters: { directWithActiveTurn: number };
  readonly delegationRequiredPolicy: boolean;
  readonly buildPreview: (
    cap: CapabilityDefinition,
    params: Record<string, unknown>,
  ) => Record<string, unknown>;
  readonly collectImpact: (params: Record<string, unknown>) => string[];
  /** 真实类型取自 `approval-replay`（返回 `ApprovalUnderlying | undefined`，不是 `unknown`）。 */
  readonly deriveUnderlying: typeof deriveUnderlyingImpl;
  readonly hashApprovalPreview: (input: {
    capabilityId: string;
    risk: RiskLevel;
    preview: Record<string, unknown>;
    impact: readonly string[];
  }) => string;
  /** 真实类型取自 `approval-replay` 的两个异步写入器（都是 `void` 调用的 best-effort）。 */
  readonly recordPolicyDeniedAudit: typeof recordPolicyDeniedAudit;
  readonly recordBlockedApprovalAudit: typeof recordBlockedApprovalAudit;
  readonly newId: (prefix: string) => string;
  readonly logger: FileLogger;
}

/** 执行段入参（与 `server.ts` 的 `ExecutionSegment` 同形）。 */
export interface ExecutionSegment {
  readonly traceId: string;
  readonly approved: boolean;
  readonly approvalId?: string;
  readonly replayed?: boolean;
  readonly delegationId?: string;
  readonly scope?: DelegationScopeEntry;
  readonly verdict?: PolicyVerdict;
}

/**
 * 过闸执行：**策略 → 审批 → 执行 → 审计** 的唯一入口。
 *
 * 返回值直接是 MCP 工具结果（`isError` 与 `structuredContent` 已按各分支语义装配好），
 * 调用方拿到即可原样回给宿主 —— 这正是"闸"而不是"中间件"的边界：它不只判定，还负责
 * 把判定结果翻译成宿主能读的信封。
 */
export async function gateAndExecute(
  deps: GateDeps,
  call: GateCall,
): Promise<McpToolResult> {
  const { cap, params, ctx } = call;
  const {
    audit,
    pendingApprovals,
    evaluateScoped,
    executeCapability,
    ledgerReg,
    scopeRegistry,
    scopeLookupKeys,
    isInnerDelegation,
    isDirectWithActiveTurn,
    shouldReturnDelegationRequired,
    approvalCoordinator,
    policyGateWiring,
    policyGateCounters,
    delegationRequiredPolicy,
    buildPreview,
    collectImpact,
    deriveUnderlying,
    hashApprovalPreview,
    recordPolicyDeniedAudit,
    recordBlockedApprovalAudit,
    newId,
    logger,
  } = deps;
  /* ---- 以下为原 server.ts handler 体的逐行副本（缩进 −2）---- */
    const { __approvalId, ...rest } = params;
    const approvalId = typeof __approvalId === 'string' ? __approvalId : undefined;
    // K4 安全点：token 必须已被宿主批准（hostApproved===true）才放行续跑。
    // 注册时 hostApproved=false，宿主经 A2A approval.reply 批准后由协调器置 true。
    let approved = approvalId !== undefined && pendingApprovals.get(approvalId)?.hostApproved === true;

    // ARCH-09（A2-17 · 批6 补建，用户终裁 A）：预览↔执行哈希绑定。
    // 「批准过的那个预览」与「这次要执行的参数」必须是同一件事：放行前对**本次请求**
    // 重算 preview 哈希，与 token 留存值比对——换目标路径/换包名/翻 dryRun 一律拒绑，
    // 降级为**重新审批**（approved=false ⇒ 走既有 requiresApproval 拦截语义：
    // 新 token 新 approvalId，零新错误码、零契约扩展；旧 token 保持已批准态等 TTL 自然收口）。
    // 判别性边界（设计判断，登记 notes）：比对**仅在续跑轮**（approvalId 在场）发生——
    // 首轮拦截无留存值可比，语义上不成立；宿主侧第三面对账（approval.receipt /
    // lookupByApprovalId.previewHash ↔ 本值）见 host-a2a-bridge/approval-audit.ts。
    if (approved && approvalId) {
      const tok = pendingApprovals.get(approvalId);
      if (tok) {
        // fail-closed：token 缺合法 previewHash ⇒ 无绑定证据（只可能是装配漂移，生产
        // 唯一创建点必带此字段），storedHash='' 与任何重算 hash 都不等 ⇒ 同样拒绑重审，
        // 「续跑永远要求重审」比「静默无绑定放行」更可观测。
        const storedHash = typeof tok.previewHash === 'string' && tok.previewHash.length === 64
          ? tok.previewHash
          : '';
        const resumePreview = buildPreview(cap, rest);
        const resumeImpact = collectImpact(rest);
        const resumeHash = hashApprovalPreview({
          capabilityId: cap.id,
          risk: cap.risk,
          preview: resumePreview,
          impact: resumeImpact,
        });
        if (resumeHash !== storedHash) {
          approved = false; // 预览已非批准时那份 ⇒ 拒绑重审（绝不静默按新参数放行）
          logger.warn('ARCH-09 预览绑定校验失败：续跑参数与已批准预览不一致 ⇒ 拒绝放行，要求重新审批', {
            approvalId,
            capabilityId: cap.id,
            expectedHashPrefix: tok.previewHash.slice(0, 12),
            actualHashPrefix: resumeHash.slice(0, 12),
          });
        }
      }
    }

    // ===== 批1（F-2 通道判据 + scope 回查）=====
    // 「委派内层」判据全部取**服务端事实**，绝不信任调用方自报参数：
    //   - dtid 在场（单次 -p / 旧版桥带标）；
    //   - 常驻形态 dtid 不生效（prepareMcpConfig 会话级共享，bridge 两处亲验）⇒
    //     协调器活动委派槽兜底（beginTask/endTask 包裹整个委派 turn，常驻会话物理串行
    //     ⇒ 同一时刻至多一个活动 turn；与 raise 的 input-required 挂接**同一份事实**，
    //     不新增串台面）。
    // 误判方向的 fail-safe 性（设计自查）：纯宿主直调恰撞并发委派 turn 的毫秒窗口 ⇒
    // 被当作内层（走注册令牌旧路径/回查错 scope）——不放宽任何放行（审批闸与
    // hostApproved 照旧），最坏=逐字旧行为。反方向（内层被判直调）在本判据下不可能
    // 发生于常驻（turn 包裹整个委派期）。
    const channelProbe = {
      delegationId: ctx.delegationId,
      activeTaskId: approvalCoordinator.getActiveTaskId(),
    };
    const innerDelegation = isInnerDelegation(channelProbe);
    const segScope =
      policyGateWiring === 'off'
        ? undefined
        : scopeRegistry.lookup(scopeLookupKeys(channelProbe))?.entry;

    const verdict = evaluateScoped(cap, rest, approved, approvalId, segScope, ctx.traceId);

    if (!verdict.allowed) {
      if (verdict.requiresApproval) {
        // 批10 N-9（纯观测，零行为改动）：纯直调（无 dtid）恰撞常驻委派 turn 窗口
        // （活动槽在场）⇒ 被按 inner 处理、下面 (c) 不触发、走注册令牌窄窗 ⇒ 计数。
        // 判据走 policy-gate 纯函数（生产与单测同源）；先于 (c) 判定计数——
        // 窄窗的实况正是「(c) 在场却不收口」，与收口分支互斥。
        if (isDirectWithActiveTurn({ ...channelProbe, requiresApproval: true })) {
          policyGateCounters.directWithActiveTurn += 1;
          logger.warn('批10 N-9 观测：纯直调命中审批闸且活动委派槽在场（窄窗：被按内层处理，(c) 不触发）', {
            capabilityId: cap.id,
            activeTaskId: channelProbe.activeTaskId,
            traceId: ctx.traceId,
            directWithActiveTurn: policyGateCounters.directWithActiveTurn,
          });
        }
        // ===== 批1 出路(c)：纯宿主直调命中审批闸 ⇒ 服务端策略收口「须走委派」 =====
        // 病灶（P0-1）：直调场景无任何可达批准入口（approval.reply 需 taskId；raise 的
        // 生产调用点在委派桥内）——旧行为是注册一个**永远批不下来**的死 approvalId 令牌，
        // 宿主照文档批准→续跑→再拦截=信任核弹死循环。(c) 策略化把事实说破：L2/L3 一律
        // 经委派审批（收窄承诺，非扩实现），回执给可行动指引。
        // 判据=服务端事实（!innerDelegation），伪造无门（调用方无法伪造协调器活动槽）。
        // 灰度：WINVM_DELEGATION_REQUIRED_POLICY=off 退回旧死令牌行为（回滚保险）。
        // 决策纯函数 policy-gate.shouldReturnDelegationRequired（生产与单测同源）。
        if (shouldReturnDelegationRequired({ inner: innerDelegation, requiresApproval: true, policyEnabled: delegationRequiredPolicy })) {
          logger.info('批1(c)：纯宿主直调命中审批闸 ⇒ 策略收口 DELEGATION_REQUIRED（不再注册死令牌）', {
            capabilityId: cap.id,
            risk: cap.risk,
            traceId: ctx.traceId,
          });
          // (c) 拒绝同样必须入审计链（S-4 同款纪律：终态拒绝零审计=取证盲区）。
          void recordPolicyDeniedAudit(
            audit,
            logger,
            {
              traceId: ctx.traceId,
              capabilityId: cap.id,
              risk: cap.risk,
              params: rest,
              startedAtMs: Date.now(),
              matchedRule: 'policy:delegation-required',
              errorCode: 'DELEGATION_REQUIRED',
              errorMessage: 'L2/L3 须经委派审批（a2a.delegate），MCP 直调通道不予批准',
            },
            () => newId('aud'),
            { channel: 'mcp' },
          );
          return {
            isError: true,
            structuredContent: {
              traceId: ctx.traceId,
              ok: false,
              error: {
                code: 'DELEGATION_REQUIRED',
                message:
                  `能力 ${cap.id}（风险 ${cap.risk}）须经**委派审批通道**执行：MCP 直调` +
                  '命中 L2/L3 审批闸时服务端不再发放续跑令牌（旧令牌无宿主批准入口、永远批不下来）。' +
                  '请改用 a2a.delegate 发起（宿主批准 → 服务端重放闭环），或确认低风险替代能力。' +
                  '如需退回旧行为（发放直调令牌）：WINVM_DELEGATION_REQUIRED_POLICY=off。',
                retryable: false,
              },
              risk: cap.risk,
              guidance: { via: 'a2a.delegate', reason: 'host-direct-approval-gate' },
            },
          };
        }
        const id = newId('apr');
        const impact = collectImpact(rest);
        const preview = buildPreview(cap, rest);
        pendingApprovals.set(id, {
          approvalId: id,
          capabilityId: cap.id,
          risk: cap.risk,
          params: rest,
          preview,
          createdAtMs: Date.now(),
          // K4：注册时恒为「待宿主批准」，杜绝未批准即放行。
          hostApproved: false,
          // ARCH-09（A2-17）：预览哈希留存=续跑绑定判据（输入与拦截展示给宿主的
          // preview/impact 同源同函数 ⇒「批什么执行什么」由构造保证，不靠约定）。
          previewHash: hashApprovalPreview({
            capabilityId: cap.id,
            risk: cap.risk,
            preview,
            impact,
          }),
          // K5：留存 traceId / impact / 真实意图 —— 供服务端重放（traceId 派生 -replay）
          // 与宿主审批卡片展示（impact/underlying 由协调器并入 approval-request）。
          traceId: ctx.traceId,
          impact,
          underlying: deriveUnderlying(cap.id, rest),
          // K-N1：留存委派归因 —— 批准后服务端重放（异步、无 HTTP 上下文）仍可把
          // executed 条目精确归因回原委派回合。
          ...(ctx.delegationId ? { delegationId: ctx.delegationId } : {}),
          // 批1 F-2：留存委派 scope —— 批准后**服务端重放必须用这份留存值复评最小权限**
          //（「批准」批的是 scope 内的动作，重放不得越出宿主授权范围；与 K5「参数只取留存值」
          // 同纪律——VM 内任何角色无法在批准后扩权）。仅委派内层拦截才有 scope（宿主直调
          // 的 token 已在上面被 (c) 收口、走不到这里；或 delegationRequiredPolicy=off 时
          // segScope 缺席 ⇒ 两键不写，逐字旧行为）。
          ...(segScope?.allowedCapabilities && segScope.allowedCapabilities.length > 0
            ? { scopeAllowedCapabilities: segScope.allowedCapabilities }
            : {}),
          ...(segScope?.maxRisk ? { scopeMaxRisk: segScope.maxRisk } : {}),
        });

        // K5 取证盲区闭合：被拦调用**必须入审计**（旧实现只在执行成功/失败时落条目，
        // 拦截路径无痕 → 事后无法证明「该调用到过、且从未执行」）。
        // best-effort：审计写失败不得影响拦截结果（拦截语义优先）。
        // K-N1：blocked 经**专用通道**登记进账本（不污染 executed 计数）——
        // 「委派内层到过但被拦」也是**非零活动证据**，桥侧据此绝不改判。
        void recordBlockedApprovalAudit(
          audit,
          logger,
          {
            traceId: ctx.traceId,
            approvalId: id,
            capabilityId: cap.id,
            risk: cap.risk,
            params: rest,
            startedAtMs: Date.now(),
          },
          () => newId('aud'),
          {
            channel: ctx.delegationId ? 'a2a' : 'mcp',
            ...(ctx.delegationId ? { delegationId: ctx.delegationId } : {}),
            onRecorded: (record) => {
              // CL-K3R：blocked 登记改走**注册表分发**（补 V-3）——
              //   - `ctx.delegationId` 存在（单次 -p / dtid 注入）→ 精确落到该委派账本（R1，与旧行为等价）；
              //   - 缺席（常驻路径：mcp.json 会话级共享，dtid 不生效）→ 按 `inWindow && isExposed`
              //     窗口归因分发，使常驻路径的「到过且被拦」不再恒空（旧实现是恒空操作）。
              ledgerReg.recordBlocked(record.seq, id, cap.id, {
                ...(ctx.delegationId ? { delegationId: ctx.delegationId } : {}),
                risk: cap.risk,
              });
            },
          },
        );

        return {
          isError: false,
          structuredContent: {
            traceId: ctx.traceId,
            ok: false,
            error: { code: 'APPROVAL_REQUIRED', message: verdict.error?.message ?? '需审批' },
            approval: {
              approvalId: id,
              risk: cap.risk,
              capabilityId: cap.id,
              preview: buildPreview(cap, rest),
              impact,
              resumeHint: '确认后以 __approvalId 重发同一请求',
              // P3-b3 M8（audit §3.2 M8）：审批卡 TTL 槽——卡片文案此前无"多久失效"位，
              // 用户隔天下批准点下去恒返 APPROVAL_REQUIRED 而无归因。纯附加：
              // ttl=Infinity（未启过期清扫）⇒ expiresAtMs 不写（缺席即旧形状）。
              ...(Number.isFinite(pendingApprovals.ttl)
                ? { expiresAtMs: Date.now() + pendingApprovals.ttl, ttlMs: pendingApprovals.ttl }
                : {}),
            },
          },
        };
      }
      // S-4 同上：审批路径下的策略硬拒绝也必须入审计链。
      // 它是终态拒绝而非待审批，故不登记进 ledger（onRecorded 省略）——避免被计为 blocked/wild。
      void recordPolicyDeniedAudit(
        audit,
        logger,
        {
          traceId: ctx.traceId,
          capabilityId: cap.id,
          risk: cap.risk,
          params: rest,
          startedAtMs: Date.now(),
          matchedRule: verdict.matchedRule ?? 'policy-denied',
          errorCode: verdict.error?.code ?? 'POLICY_DENIED',
          ...(verdict.error?.message ? { errorMessage: verdict.error.message } : {}),
        },
        () => newId('aud'),
        { channel: ctx.delegationId ? 'a2a' : 'mcp', ...(ctx.delegationId ? { delegationId: ctx.delegationId } : {}) },
      );
      return {
        isError: true,
        structuredContent: {
          traceId: ctx.traceId,
          ok: false,
          error: verdict.error ?? { code: 'POLICY_DENIED', message: '被策略拒绝' },
          risk: cap.risk,
        },
      };
    }

    if (approvalId) pendingApprovals.delete(approvalId);

    // K5：执行段抽成命名函数（与重放共用），本路径按既有语义逐字保持
    return executeCapability(cap, rest, {
      traceId: ctx.traceId,
      approved,
      ...(approvalId ? { approvalId } : {}),
      verdict,
      // K-N1：dtid 存在 → 归因委派（channel 'a2a' + ext.delegationId 精确入账本）
      ...(ctx.delegationId ? { delegationId: ctx.delegationId } : {}),
      // 批1：handler 已用 evaluateScoped 评估（verdict 透传，不二次评估），scope 仅供
      // 下游观测/审计归因参考（实际执法已在 verdict 里定死）。
      ...(segScope ? { scope: segScope } : {}),
    });
}

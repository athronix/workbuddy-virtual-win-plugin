/**
 * 批1 F-2 —— 委派 scope 的服务端留存（审批闭环与双闸接线的**归因地基**）。
 *
 * ## 病灶（审计 A2-18 / arch3 F-2）
 * 宿主 `a2a.delegate` 声明的最小权限 scope（`allowedCapabilities` + 显式声明的 `maxRisk`）
 * 此前只活在 `GoalRequest` 内存对象里：VM 内 Agent（LLM provider）经 CLI 子进程**回连
 * `/mcp`** 执行内层能力时，那条 HTTP 请求不带 scope ⇒ 策略引擎的两道最小权限闸
 * （engine.ts 步骤 1 白名单 / 步骤 5 maxRisk 封顶）在生产调用路径上**永远收不到实参**
 * （E-1/M2 的"写而未接线"，其装配段之一）。`?dtid=` 通道（K-N1）在常驻形态（缺省启用）
 * 不生效——`prepareMcpConfig` 不传 delegationId（bridge.ts 两处亲验），`__mcp__` 会话级
 * 共享配置 ⇒ 任何"按 dtid 回填 scope"类修法在最常用形态下物理不可达。
 *
 * ## 设计（对齐 F-2 终裁处方：服务端按 taskId/会话键留存 scope）
 * - **注册时机**：A2A 框架 `delegationObserver.onGoalAccepted(goalWithTask)`（框架
 *   注入 taskId 后、runGoal 派发前回调）⇒ `register(goal.traceId, goal.taskId, scope)`；
 * - **消费通路**：`/mcp` 内层回连的 HTTP 请求带 `?dtask=<taskId>`（provider 桥从
 *   LlmGoalInput.taskId 拼入，同 dtid 先例的纯附加参数）⇒ `lookupByTaskId(taskId)` 取回
 *   scope 喂 evaluate；dtid（traceId 键）通路保留（单次 -p 形态）；
 * - **有界**：与 pendingApprovals 同纪律——TTL（复用 `WINVM_APPROVAL_TTL_MS` 旋钮，
 *   30min：委派生命周期上界=maxRunTimeMs 600s < TTL，正常委派绝不误逐）+ 容量上限
 *   （超限逐最老）+ 终态主动销账（onGoalTerminal → retire）+ 定时器 `unref()`；
 * - **并发委派安全**：多委派并存时各持独立条目（dtask 键=taskId 天然唯一）——这正是
 *   F-2 指出的"串台改判窗口"的反面：真值与 scope 都按任务精确归因，不靠时间窗猜测。
 * - **零审计依赖**（取证面与执行面分离的既有纪律）：本文件是**纯数据结构**，可脱服务单测。
 *
 * ## fail-closed 语义
 * scope 缺席（未注册/已销账/纯宿主直调）⇒ 两键不喂 evaluate ⇒ 逐字旧行为。
 * 本注册表**不放大**任何放行：它只可能让内层调用**更严**（多了封顶/白名单执法），
 * 绝不因"查到了别人的 scope"而放行本不该放行的调用——键精确（taskId/traceId），无模糊匹配。
 */

import type { RiskLevel } from '@winvm/contracts';

/** 一次委派留存的 scope（宿主声明的最小权限两元组）。 */
export interface DelegationScopeEntry {
  /** 委派 traceId（dtid 通路的键） */
  readonly delegationTraceId: string;
  /** A2A 任务 id（dtask 通路的键；常驻形态唯一可用键——dtid 在常驻不生效） */
  readonly taskId: string;
  /** 白名单（宿主声明的 allowedCapabilities；缺席=未声明=不执法此闸） */
  readonly allowedCapabilities?: readonly string[];
  /** 封顶风险（仅宿主**显式声明**时留存——maxRiskDeclared=false 一律不存，F-3 判源） */
  readonly maxRisk?: RiskLevel;
  /** 登记时刻（毫秒时间戳）—— TTL 起算点 */
  readonly registeredAtMs: number;
}

export interface DelegationScopeRegistryOptions {
  /** 条目 TTL（毫秒）。非法值（0/负/非有限/NaN）⇒ 不设限（纯容量上限治理）。 */
  readonly ttlMs: number;
  /** 容量硬上限（超限注册时逐最老；防长跑服务单调增长——与 pendingApprovals 病灶同治）。 */
  readonly maxEntries: number;
  /** 日志出口（缺席即 no-op；销账/逐出留痕） */
  readonly logger?: { warn(msg: string, meta?: Record<string, unknown>): void };
  /** 当前时刻提供者（默认 `Date.now`；单测可注入确定时刻） */
  readonly now?: () => number;
}

/** 查找结果的来源键（观测归因用：dtask 精确命中 vs dtid 命中）。 */
export interface ScopeLookupResult {
  readonly entry: DelegationScopeEntry;
  readonly via: 'taskId' | 'traceId';
}

export class DelegationScopeRegistry {
  /** taskId → entry（主索引：常驻形态唯一可用键） */
  private readonly byTask = new Map<string, DelegationScopeEntry>();
  /** delegationTraceId → entry（辅索引：单次 -p / dtid 通路） */
  private readonly byTrace = new Map<string, DelegationScopeEntry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly logger?: { warn(msg: string, meta?: Record<string, unknown>): void };
  private readonly now: () => number;

  constructor(opts: DelegationScopeRegistryOptions) {
    this.ttlMs = Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? opts.ttlMs : Infinity;
    this.maxEntries = Number.isFinite(opts.maxEntries) && opts.maxEntries > 0 ? opts.maxEntries : 256;
    this.logger = opts.logger;
    this.now = opts.now ?? Date.now;
  }

  /** 注册（onGoalAccepted 调用）。同 taskId 重复注册=覆盖（重投递/测试复位），不膨胀。 */
  register(input: {
    delegationTraceId: string;
    taskId: string;
    allowedCapabilities?: readonly string[];
    maxRisk?: RiskLevel;
  }): void {
    const entry: DelegationScopeEntry = {
      delegationTraceId: input.delegationTraceId,
      taskId: input.taskId,
      ...(input.allowedCapabilities && input.allowedCapabilities.length > 0
        ? { allowedCapabilities: [...input.allowedCapabilities] }
        : {}),
      ...(input.maxRisk ? { maxRisk: input.maxRisk } : {}),
      registeredAtMs: this.now(),
    };
    // 同 taskId 覆盖时先清旧 trace 索引，防孤儿引用
    const prev = this.byTask.get(input.taskId);
    if (prev) this.byTrace.delete(prev.delegationTraceId);
    this.byTask.set(input.taskId, entry);
    this.byTrace.set(input.delegationTraceId, entry);
    this.evictIfNeeded();
  }

  /**
   * 精确查找：先 taskId（dtask 通路），再 delegationTraceId（dtid 通路）。
   * 过期视同缺席并惰性清除。
   *
   * 无模糊匹配（F-2 病灶正是靠猜时间窗归因 ⇒ 串台改判窗口；本注册表的存在意义
   * 就是把"猜"清零）：两个精确键都 miss ⇒ 如实 undefined ⇒ 下游按「无 scope 声明」
   * 逐字旧行为，绝不放大任何放行。
   */
  lookup(query: { taskId?: string; delegationTraceId?: string }): ScopeLookupResult | undefined {
    if (query.taskId) {
      const hit = this.byTask.get(query.taskId);
      if (hit) {
        if (this.isExpired(hit)) {
          this.remove(hit);
        } else {
          return { entry: hit, via: 'taskId' };
        }
      }
    }
    if (query.delegationTraceId) {
      const hit = this.byTrace.get(query.delegationTraceId);
      if (hit) {
        if (this.isExpired(hit)) {
          this.remove(hit);
        } else {
          return { entry: hit, via: 'traceId' };
        }
      }
    }
    return undefined;
  }

  /** 终态销账（onGoalTerminal 调用）：两索引同除。 */
  retire(ref: { taskId?: string; delegationTraceId?: string }): void {
    const entry =
      (ref.taskId ? this.byTask.get(ref.taskId) : undefined) ??
      (ref.delegationTraceId ? this.byTrace.get(ref.delegationTraceId) : undefined);
    if (!entry) return;
    this.remove(entry);
  }

  /** 全表清扫过期（装配层定时器驱动；返回逐出数供观测）。 */
  sweepExpired(): number {
    let evicted = 0;
    for (const entry of [...this.byTask.values()]) {
      if (this.isExpired(entry)) {
        this.remove(entry);
        evicted += 1;
      }
    }
    if (evicted > 0) {
      this.logger?.warn('delegation-scope：TTL 清扫', { evicted, remaining: this.byTask.size });
    }
    return evicted;
  }

  get size(): number {
    return this.byTask.size;
  }

  /** 测试/复位用：清空两索引。 */
  clear(): void {
    this.byTask.clear();
    this.byTrace.clear();
  }

  private isExpired(entry: DelegationScopeEntry): boolean {
    return Number.isFinite(this.ttlMs) && this.now() - entry.registeredAtMs > this.ttlMs;
  }

  private remove(entry: DelegationScopeEntry): void {
    this.byTask.delete(entry.taskId);
    // trace 索引可能已被同 trace 的另一任务覆盖（traceId 重入场景）⇒ 只在确属本条时删
    if (this.byTrace.get(entry.delegationTraceId) === entry) {
      this.byTrace.delete(entry.delegationTraceId);
    }
  }

  /** 容量治理：超限逐最老（注册热路径同步判，O(1) 判 + 摊还 O(k) 逐）。 */
  private evictIfNeeded(): void {
    while (this.byTask.size > this.maxEntries) {
      let oldest: DelegationScopeEntry | undefined;
      for (const e of this.byTask.values()) {
        if (!oldest || e.registeredAtMs < oldest.registeredAtMs) oldest = e;
      }
      if (!oldest) return;
      this.remove(oldest);
      this.logger?.warn('delegation-scope：容量上限逐最老', {
        evicted: oldest.taskId,
        maxEntries: this.maxEntries,
      });
    }
  }
}

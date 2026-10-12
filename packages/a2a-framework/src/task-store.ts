/**
 * A2A Task 存储与生命周期（A2A v1.0）
 *
 * 状态机：
 *   submitted → working → input-required → working → completed
 *                      ↘ failed / canceled / rejected
 * 终态：completed / failed / canceled / rejected
 */

import { randomUUID } from 'node:crypto';

import { A2A, isTerminalTaskState, type ProgressSink, type ApprovalRequest } from '@winvm/contracts';
import { resolveApprovalTtlMs } from '@winvm/core';

/** 一次审批等待的结束原因（P3-3） */
export type ApprovalResolution = 'host-reply' | 'timeout';

/**
 * 审批等待超时事件（P3-3）。
 * 由实现方（vm-service）据此清理宿主侧残留的续跑令牌，避免「任务已收口、token 仍在」。
 */
export interface ApprovalTimeoutInfo {
  readonly taskId: string;
  readonly approvalId: string;
  /** 实际等待时长（毫秒） */
  readonly timedOutAfterMs: number;
  readonly ttlMs: number;
}

/** ENG-08：`maxTasks` 缺省上限（条数） */
const DEFAULT_MAX_TASKS = 200;
/** ENG-08：`terminalTtlMs` 缺省驻留时长（1 小时） */
const DEFAULT_TERMINAL_TTL_MS = 3_600_000;
/**
 * P2-T7（L1 驱逐可观测化）：**有界环形日志**的容量。
 *
 * 为什么固定为常量而非配置旋钮（§8「不新造 env 旋钮」同纪律）：本日志的定位是
 * 「最近发生了什么」的排障窗口，不是审计台账 —— 容量越大内存占用与「伪装成保留期承诺」
 * 的风险都上升。64 条覆盖「一次溢出轮 + 若干次 TTL 轮」的最近事实，且
 * `wasEvicted()` 的归因窗口正好等于这个容量（窗口外只承认「不知道」，绝不谎称存在过）。
 */
const EVICTION_LOG_CAPACITY = 64;
/**
 * 未知任务 id 的兜底信号：一个**永不** abort 的共享 AbortSignal。
 * 为什么共享而非每次 `AbortController` 新建：`cancellationSignal()` 可能被 provider 在循环里
 * 反复调用，共享常量零分配；且它永不置位 ⇒ 「任务不存在」不会被误读成「已取消」。
 */
const NEVER_ABORTED_SIGNAL: AbortSignal = new AbortController().signal;

/**
 * P2-T7（L1）：驱逐发生的**哪一路闸门**（与设计 §3.1「双闸门」一一对应）。
 * 由调用点**显式传入**（不在记录时反推）—— 反推需要读 `terminalAtMs + terminalTtlMs`，
 * 而溢出轮里那条任务可能同时早已过期，反推会给出错误归因。
 */
export type EvictionGate = 'ttl' | 'overflow';

/**
 * P2-T7（L1）：单条驱逐的**结构化事实**（同时是有界环形日志的成员、`onEviction` 回调的入参）。
 *
 * 只存元数据、**不存任务内容**（无 status.message / 无 artifacts / 无 history / 无 metadata）：
 * 这是设计 §3.1-1 的明写约束 —— 审计保留期权衡 W-2 不被本机制悄悄绕过
 * （「任务已回收」这件事可以留痕，「任务里曾经有什么」不可以）。
 */
export interface EvictionRecord {
  readonly id: string;
  /** 被逐时刻的任务终态（completed / failed / canceled / rejected） */
  readonly terminalState: A2A.TaskState;
  readonly evictedAtMs: number;
  readonly gate: EvictionGate;
}

export interface TaskStoreOptions {
  /**
   * 审批等待 TTL（毫秒）；未给 → env `WINVM_APPROVAL_TTL_MS` → 默认 30 分钟。
   * 传 `0` / 负数 / `Infinity` 表示不设超时（仅测试用途；生产不建议）。
   */
  readonly approvalTtlMs?: number;
  /** 审批超时回调（清理宿主侧令牌等；异常被吞，不影响任务收口） */
  readonly onApprovalTimeout?: (info: ApprovalTimeoutInfo) => void;
  /**
   * P2-T7（**纯附加可选**）：单条驱逐的结构化事件回调，与 `onApprovalTimeout` 同构同纪律 ——
   * 回调异常**一律被吞**，取证面绝不得影响驱逐本身（驱逐是内存有界性的安全阀，
   * 让它因观察者抛错而不执行 = 把可观测性换成了新的 OOM 风险）。
   *
   * 为什么框架只给回调而不落审计：`a2a-framework` 不 import 审计/领域语义（依赖方向铁律，
   * 同 `DelegationObserver` 的处理），**落不落链由 vm-service 决定**（设计 §3.1-1）。
   */
  readonly onEviction?: (info: EvictionRecord) => void;
  /**
   * ENG-08（**纯附加可选**）：内存任务条数上限，默认 200；仅在 `create()` 尾部生效（O-11）。
   * 传 `0` / 负数 / 非有限 ⇒ **完全不驱逐**（条数与 TTL 两路一起关死，旧行为逐字保留）。
   */
  readonly maxTasks?: number;
  /**
   * ENG-08（**纯附加可选**）：终态任务驻留 TTL（毫秒），默认 1 小时；仅在 `create()` 尾部清扫。
   * 传 `0` / 负数 / 非有限 ⇒ 禁用 TTL 过期驱逐（只按条数驱逐）。
   * 前置条件：`maxTasks` 必须是有限正数 —— 否则整体驱逐关闭，本 TTL 一并失效（偏差 D-18）。
   */
  readonly terminalTtlMs?: number;
}

export interface PendingApproval {
  readonly request: ApprovalRequest;
  resolve(approved: boolean): void;
  /** 挂起截止时刻（毫秒时间戳；无 TTL 时缺省），供 `/health`、tasks/get 展示与排障 */
  readonly expiresAtMs?: number;
}

export interface InternalTask {
  task: A2A.Task;
  readonly subscribers: Set<(ev: A2A.A2AStreamEvent) => void>;
  pendingApproval?: PendingApproval;
  cancelRequested: boolean;
  /**
   * ARCH-22（**纯附加**）：协作式取消的信号主干。`requestCancel()` 在 `updateStatus('canceled')`
   * **之前** `abort('canceled')`（顺序纪律 O-1）⇒ 订阅者一旦看到 canceled，信号必已置位。
   * 消费方：`createProgressSink` 把它经契约成员 `cancellationSignal` 透出给 provider
   * （常驻会话 abort / 子进程 kill），`isCancelled()` 透出轮询面。
   */
  readonly cancelController: AbortController;
  /**
   * ENG-08（**纯附加**）：进入终态的时刻（毫秒时间戳），由 `updateStatus` 盖一次（幂等）。
   * 是 `evictIfNeeded()` 的驱逐排序依据（最旧者先出）。非终态时缺省 ⇒ 序列化时条件展开，
   * 绝不写显式 undefined（`canonicalJson` 会把 undefined 变成 null 造成假断链）。
   */
  terminalAtMs?: number;
  readonly createdAtMs: number;
}

export interface ListFilter {
  readonly contextId?: string;
  readonly status?: A2A.TaskState;
  readonly pageSize?: number;
  readonly pageToken?: string;
  readonly historyLength?: number;
  readonly includeArtifacts?: boolean;
}

export interface ListResult {
  readonly tasks: readonly A2A.Task[];
  readonly nextPageToken: string;
  readonly totalSize: number;
}

export class TaskNotFoundError extends Error {
  /**
   * P2-T7（L1，**纯附加**）：本 id 是否**曾被驱逐**（判据 = 有界环形日志的归因窗口，见 `wasEvicted`）。
   *
   * 病灶：驱逐把表项删掉后，被逐 id 与「从未存在的 id」在协议面上完全同形，运维无法判断
   * 是被回收了还是记错了 id。错误**文本逐字不变**（既有断言/日志匹配不受影响），
   * 归因只走这一个结构化键 ⇒ 缺席/为 false 即旧语义。默认 `false` ⇒ 旧构造点合法且逐字旧行为。
   */
  readonly evicted: boolean;
  constructor(readonly taskId: string, evicted = false) {
    super(`任务不存在或不可访问：${taskId}`);
    this.name = 'TaskNotFoundError';
    this.evicted = evicted;
  }
}

export class TaskNotCancelableError extends Error {
  constructor(readonly taskId: string, readonly state: A2A.TaskState) {
    super(`任务处于 ${state}，不可取消`);
    this.name = 'TaskNotCancelableError';
  }
}

export class TaskStore {
  private readonly tasks = new Map<string, InternalTask>();
  /** 审批等待 TTL（毫秒；`Infinity` = 不设超时） */
  private readonly approvalTtlMs: number;
  private readonly onApprovalTimeout: ((info: ApprovalTimeoutInfo) => void) | undefined;
  /**
   * ENG-08：条数上限。`Number.POSITIVE_INFINITY` ⇒ 不设限（驱逐整体关闭，TTL 清扫一并失效）。
   * 取值归一：未给 → 200；`0` / 负数 / 非有限 → 不设限。
   */
  private readonly maxTasks: number;
  /**
   * ENG-08：终态驻留 TTL（毫秒）。`Infinity` ⇒ 禁用 TTL 过期驱逐（只按条数驱逐）。
   * 取值归一：未给 → 1h；`0` / 负数 / 非有限 → 禁用。
   */
  private readonly terminalTtlMs: number;
  /** P2-T7：驱逐事件回调（可缺席 ⇒ 只留计数与环形日志） */
  private readonly onEviction: ((info: EvictionRecord) => void) | undefined;
  /**
   * P2-T7（L1）：本轮运行以来**累计驱逐条数**（单调不减，只在 `evict()` 里自增）。
   * 刻意不设「未知 id 命中」之类的旁路写入点 —— 计数唯一的产生地就是有界化那条真实删除路径，
   * 这样 `evictedCount` 与链上聚合、`/health.tasks` 透出值三者必然同源（两处口径打架即说谎）。
   */
  private evictedTotal = 0;
  /**
   * P2-T7（L1）：**有界环形日志**（数组当环用：写满后由写指针回到 0 覆盖最旧者）。
   * `evictionLog()` 返回按「最旧 → 最新」重排后的**拷贝**，外部拿不到内部环，
   * 也就无法通过持有数组来延长元数据的驻留期（W-2 约束的落点之一）。
   */
  private readonly evictions: (EvictionRecord | undefined)[] = new Array(EVICTION_LOG_CAPACITY);
  /** 环形写指针（下一个写入位） */
  private evictCursor = 0;
  /** 已写入条数（≤ 容量），决定环形重排的起点 */
  private evictFilled = 0;

  constructor(opts: TaskStoreOptions = {}) {
    // 未显式指定 → env（非法回退 30 分钟默认）；显式传 ≤0 / 非有限 → 视为不设超时
    this.approvalTtlMs =
      opts.approvalTtlMs === undefined
        ? resolveApprovalTtlMs()
        : Number.isFinite(opts.approvalTtlMs) && opts.approvalTtlMs > 0
          ? Math.floor(opts.approvalTtlMs)
          : Number.POSITIVE_INFINITY;
    this.onApprovalTimeout = opts.onApprovalTimeout;
    this.onEviction = opts.onEviction;
    // ENG-08：与 approvalTtlMs 同构的归一纪律（非法值一律回退，不抛错、不打挂服务）
    this.maxTasks =
      opts.maxTasks === undefined
        ? DEFAULT_MAX_TASKS
        : Number.isFinite(opts.maxTasks) && opts.maxTasks > 0
          ? Math.floor(opts.maxTasks)
          : Number.POSITIVE_INFINITY;
    this.terminalTtlMs =
      opts.terminalTtlMs === undefined
        ? DEFAULT_TERMINAL_TTL_MS
        : Number.isFinite(opts.terminalTtlMs) && opts.terminalTtlMs > 0
          ? Math.floor(opts.terminalTtlMs)
          : Number.POSITIVE_INFINITY;
  }

  create(params: { contextId?: string; metadata?: Record<string, unknown> } = {}): InternalTask {
    const id = randomUUID();
    const contextId = params.contextId ?? randomUUID();
    const task: A2A.Task = {
      kind: 'task',
      id,
      contextId,
      status: { state: 'submitted', timestamp: new Date().toISOString() },
      artifacts: [],
      history: [],
      ...(params.metadata ? { metadata: params.metadata } : {}),
    };
    const rec: InternalTask = {
      task,
      subscribers: new Set(),
      cancelRequested: false,
      cancelController: new AbortController(),
      createdAtMs: Date.now(),
    };
    this.tasks.set(id, rec);
    // ENG-08 / O-11：驱逐**只在 create() 尾部**触发 —— get/list/subscribe 路径一律不驱逐，
    // 免得读侧出现「刚查到的任务下一帧消失」的意外语义。
    this.evictIfNeeded();
    return rec;
  }

  /**
   * 命中即返回，未命中抛 `TaskNotFoundError`。
   *
   * P2-T7（L1，**纯附加**）：抛出时把「本 id 是否落在驱逐归因窗口内」一并带上
   * （`error.evicted`）⇒ 与「从未存在的 id」在协议面上可分。判读点只在**这一处**，
   * 因此 `updateStatus` / `appendHistory` / `addArtifact` / `requestCancel` / `subscribe` /
   * `waitApproval` 等全部 `get()` 消费方**自动**获得同一归因，零额外接线，也不会漏。
   */
  get(id: string): InternalTask {
    const t = this.tasks.get(id);
    if (!t) throw new TaskNotFoundError(id, this.wasEvicted(id));
    return t;
  }

  tryGet(id: string): InternalTask | undefined {
    return this.tasks.get(id);
  }

  updateStatus(
    id: string,
    state: A2A.TaskState,
    message?: A2A.Message,
  ): InternalTask {
    const rec = this.get(id);
    if (isTerminalTaskState(rec.task.status.state)) {
      // 终态不可再流转（A2A 规范：终止状态的任务不再接受变更）。
      // P3-3：同态重写也拦 —— 否则 runner 收尾时的第二次 `updateStatus('failed')`
      // 会覆盖更具体的终止原因（如审批超时 `approval timeout` 的 status.message）。
      return rec;
    }
    rec.task = {
      ...rec.task,
      status: { state, timestamp: new Date().toISOString(), ...(message ? { message } : {}) },
    };
    // ENG-08：进入终态盖一次 terminalAtMs（此处已在终态守卫之后 ⇒ 只会从非终态转入终态，天然幂等）
    if (isTerminalTaskState(state)) {
      rec.terminalAtMs = Date.now();
    }
    this.emit(rec, {
      kind: 'status-update',
      taskId: id,
      contextId: rec.task.contextId,
      status: rec.task.status,
      final: isTerminalTaskState(state),
    });
    return rec;
  }

  appendHistory(id: string, message: A2A.Message): void {
    const rec = this.get(id);
    const history = [...(rec.task.history ?? []), message];
    rec.task = { ...rec.task, history };
  }

  /**
   * 追加 artifact。
   *
   * ARCH-22（**终态守卫**）：任务已处于终态 ⇒ **不落 artifact、不 emit**，返回 `false`
   * （判据与终态集合一律走 `isTerminalTaskState` 单一来源，不在此复述成员名）。
   * 这一处单独就把「已取消任务继续向宿主推 artifact」的未授权副作用关死 ——
   * 宿主 UI 上已是终止任务，任何后续产物都是把既成事实伪装成进行中输出。
   *
   * 签名 `void` → `boolean` 属**附加**（调用方丢弃返回值合法）：不读返回值即逐字旧行为，
   * 既有调用点（`createProgressSink.onArtifact`）与既有 SSE 用例均不受影响。
   */
  addArtifact(id: string, artifact: A2A.Artifact): boolean {
    const rec = this.get(id);
    if (isTerminalTaskState(rec.task.status.state)) return false;
    const artifacts = [...(rec.task.artifacts ?? []), artifact];
    rec.task = { ...rec.task, artifacts };
    this.emit(rec, {
      kind: 'artifact-update',
      taskId: id,
      contextId: rec.task.contextId,
      artifact,
      lastChunk: true,
    });
    return true;
  }

  setMetadata(id: string, metadata: Record<string, unknown>): void {
    const rec = this.get(id);
    rec.task = { ...rec.task, metadata: { ...(rec.task.metadata ?? {}), ...metadata } };
  }

  /**
   * 协作式取消的**请求侧**（ARCH-22）。
   *
   * 顺序纪律 **O-1**（必须逐字保持，四条各占一处副作用）：
   *   ① 取消标志位置位（读侧兼容 + `isCancelled()` 判据之一）
   *   → ② 挂起审批按拒绝收口 `resolve(false)`（不空等 TTL）
   *   → ③ **`rec.cancelController.abort('canceled')`**（信号置位）
   *   → ④ `this.updateStatus(id, 'canceled')`（终态 + SSE emit）。
   * 为什么 ③ 必须先于 ④：`updateStatus` 会同步向全部 SSE 订阅者 emit `final:true` 的
   * status-update —— 订阅者（宿主桥 / provider 的 `onStatus` 钩子）读到 canceled 的那一刻
   * 起就该能观测到信号已置位。反序会开出「状态已 canceled、signal.aborted 仍 false」的窗口，
   * 恰好复刻本任务要消除的「外观性取消」。该时序由行为守卫
   * `tests/unit/phase1-t3-cancel-bounded.test.js`（O-1 反例探针）钉死。
   */
  requestCancel(id: string): InternalTask {
    const rec = this.get(id);
    if (isTerminalTaskState(rec.task.status.state)) {
      throw new TaskNotCancelableError(id, rec.task.status.state);
    }
    rec.cancelRequested = true;
    // P3-3：审批挂起中被取消 → 按拒绝收口挂起的等待（resolve(false)），
    // 不让桥/runner 空等到 TTL；终态由下面的 canceled 决定（finish 的 host-reply 不改状态）。
    if (rec.pendingApproval) {
      rec.pendingApproval.resolve(false);
    }
    // ARCH-22 / O-1：先 abort 再置终态（见方法注释的顺序纪律）
    rec.cancelController.abort('canceled');
    return this.updateStatus(id, 'canceled');
  }

  /* ------------------------------ 取消探测（ARCH-22 读侧） ------------------------------ */

  /**
   * 宿主是否已请求取消本任务（协作式取消的**轮询面**）。
   * 判据：已进终态 canceled，**或**取消标志已置位（覆盖「标志已置、终态收口尚未落地」的瞬间）。
   * 未知 id ⇒ `false`（任务已被 ENG-08 驱逐时不得谎报，也不得抛错打断 provider 循环）。
   */
  isCancelled(id: string): boolean {
    const rec = this.tryGet(id);
    if (!rec) return false;
    return rec.task.status.state === 'canceled' || rec.cancelRequested;
  }

  /**
   * 取消的**事件面**（与 `isCancelled()` 同源同一个 `AbortController`）：
   * 供能 kill 子进程 / abort 常驻会话的执行体消费（`fetch`/`spawn` 的 `signal` 形参）。
   * 未知 id ⇒ 返回一个永不 abort 的共享信号（缺席即旧行为，绝不给消费方一个"已取消"的假信号）。
   */
  cancellationSignal(id: string): AbortSignal {
    return this.tryGet(id)?.cancelController.signal ?? NEVER_ABORTED_SIGNAL;
  }

  /* ------------------------------ 审批闸 ------------------------------ */

  /**
   * 置 input-required 并挂起等待宿主应答。
   *
   * P3-3（TTL）：挂起不是无限期的。超过 `approvalTtlMs`（默认 30 分钟）宿主仍无应答时，
   * 按**拒绝**收口 —— 绝不因超时而放行：
   *   ① 挂起的 Promise resolve(false)（桥/协调器走「保持 K3 旧行为 ok=false」分支，
   *      不是抛错，避免未处理 rejection）；
   *   ② 任务状态转 `failed`，status.message 与 metadata 均标注 `approval timeout`；
   *   ③ 清理 `pendingApproval`，并经 `onApprovalTimeout` 回调让实现方（vm-service）
   *      删除宿主侧残留的续跑令牌。
   * 计时器 `unref()`，服务退出时不因未决审批被拖住。
   */
  waitApproval(id: string, req: ApprovalRequest): Promise<boolean> {
    const rec = this.get(id);
    const ttlMs = this.approvalTtlMs;
    const startedAtMs = Date.now();
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      /** 唯一收口点：宿主应答与 TTL 超时都走这里，先到先得，后到忽略（消解竞态） */
      const finish = (approved: boolean, reason: ApprovalResolution): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        // 只清理本次审批的记录，避免误删后续在同一任务上新挂起的审批
        if (rec.pendingApproval?.request.approvalId === req.approvalId) {
          rec.pendingApproval = undefined;
        }
        if (reason === 'timeout') {
          const timedOutAfterMs = Date.now() - startedAtMs;
          this.updateStatus(id, 'failed', this.approvalTimeoutMessage(id, req, ttlMs));
          // 终态后 runner 仍可能再次 updateStatus('failed') 覆盖 status.message，
          // 故把超时事实固化进 metadata，保证可追溯。
          this.setMetadata(id, {
            approvalTimedOut: true,
            approvalTimeoutApprovalId: req.approvalId,
            approvalTimeoutTtlMs: ttlMs,
            approvalTimeoutAt: new Date().toISOString(),
          });
          try {
            this.onApprovalTimeout?.({ taskId: id, approvalId: req.approvalId, timedOutAfterMs, ttlMs });
          } catch {
            /* 回调异常不影响任务收口 */
          }
        }
        resolve(approved);
      };

      rec.pendingApproval = {
        request: req,
        resolve: (approved: boolean) => {
          finish(approved, 'host-reply');
        },
        ...(Number.isFinite(ttlMs) ? { expiresAtMs: startedAtMs + ttlMs } : {}),
      };
      this.updateStatus(id, 'input-required', this.approvalMessage(id, req));

      if (Number.isFinite(ttlMs) && ttlMs > 0) {
        timer = setTimeout(() => finish(false, 'timeout'), ttlMs);
        timer.unref?.();
      }
    });
  }

  private approvalMessage(id: string, req: ApprovalRequest): A2A.Message {
    // K5：外层是壳（如 appops.workflow.run）时，把内层真实目标写进人话提示 → 人工才判得准。
    // 无 underlying 时该行整体缺席（旧文案逐字不变）。
    const underlyingLine = req.underlying
      ? `真实目标：${[
          req.underlying.goalText,
          req.underlying.capabilityId ? `能力 ${req.underlying.capabilityId}` : '',
          req.underlying.paramsSummary ? `参数 ${req.underlying.paramsSummary}` : '',
        ]
          .filter(Boolean)
          .join(' · ')}\n`
      : '';
    return {
      kind: 'message',
      role: 'agent',
      messageId: randomUUID(),
      taskId: id,
      parts: [
        {
          kind: 'text',
          text:
            `需要人工审批（风险 ${req.risk}）后才能继续。\n` +
            `操作：${req.capabilityId}\n` +
            underlyingLine +
            `说明：${req.summary}\n` +
            `确认后请回复 message/send（同一 taskId），附带 DataPart：` +
            `{"approvalId":"${req.approvalId}","approved":true}\n` +
            // P3-3：把「审批有 TTL」写进人话提示，宿主/人工才知道不能无限期挂着
            (Number.isFinite(this.approvalTtlMs)
              ? `注意：审批等待有上限 ${this.approvalTtlMs}ms，超时任务按拒绝收口（不会执行该操作）。`
              : '注意：审批等待不设超时，任务将一直停在 input-required 直到应答或取消。'),
        },
        {
          kind: 'data',
          data: {
            type: 'approval-request',
            approvalId: req.approvalId,
            capabilityId: req.capabilityId,
            risk: req.risk,
            preview: req.preview,
            impact: req.impact,
            // P3-3：把「审批有 TTL」如实告知宿主（含绝对截止时刻），避免宿主以为可无限期拖延
            expiresAtMs: this.approvalExpiresAtMs(),
            // K5：真实意图（内层目标/真实参数摘要）——被拦能力是「壳」时宿主卡片才有信息量。
            // 缺席即不写该键（绝不输出 undefined 字面量，保持既有 fixture 深比对）。
            ...(req.underlying ? { underlying: req.underlying } : {}),
          },
        },
      ],
    };
  }

  /** 审批挂起的截止时刻（毫秒时间戳）；无 TTL（Infinity）时为 undefined */
  private approvalExpiresAtMs(nowMs: number = Date.now()): number | undefined {
    return Number.isFinite(this.approvalTtlMs) ? nowMs + this.approvalTtlMs : undefined;
  }

  /** 审批超时消息（P3-3）：`type: 'approval-timeout'` 与请求侧用同一 data part、靠 type 区分 */
  private approvalTimeoutMessage(id: string, req: ApprovalRequest, ttlMs: number): A2A.Message {
    // 「约 N 分钟」仅在 ≥1 分钟时有意义（短 TTL 测试不显示"约 0 分钟"）
    const human = Number.isFinite(ttlMs) && ttlMs >= 60_000 ? `（约 ${Math.round(ttlMs / 60_000)} 分钟）` : '';
    return {
      kind: 'message',
      role: 'agent',
      messageId: randomUUID(),
      taskId: id,
      parts: [
        {
          kind: 'text',
          text:
            `审批超时（approval timeout）：等待宿主人工审批超过 ${ttlMs}ms${human}` +
            `仍无应答，任务按「拒绝」收口，未执行任何高危操作。\n` +
            `操作：${req.capabilityId}\n说明：${req.summary}\napprovalId：${req.approvalId}`,
        },
        {
          kind: 'data',
          data: {
            type: 'approval-timeout',
            approvalId: req.approvalId,
            capabilityId: req.capabilityId,
            risk: req.risk,
            ttlMs,
            reason: 'approval timeout',
          },
        },
      ],
    };
  }

  /**
   * 宿主审批应答入口。返回 true = 命中并收口；false = 该审批不存在或已收口
   * （含 TTL 超时后迟到的应答 —— 此时任务已 `failed`，调用方按「已过期」提示宿主，绝不复活任务）。
   */
  resolveApproval(id: string, approvalId: string, approved: boolean): boolean {
    const rec = this.tryGet(id);
    const pending = rec?.pendingApproval;
    if (!pending || pending.request.approvalId !== approvalId) return false;
    pending.resolve(approved);
    return true;
  }

  /** 挂起中的审批（含 `expiresAtMs`），供健康快照 / 排障展示；无挂起时 undefined */
  currentApproval(id: string): PendingApproval | undefined {
    return this.tryGet(id)?.pendingApproval;
  }

  /* ------------------------------ 订阅 ------------------------------ */

  subscribe(id: string, cb: (ev: A2A.A2AStreamEvent) => void): () => void {
    const rec = this.get(id);
    rec.subscribers.add(cb);
    return () => rec.subscribers.delete(cb);
  }

  private emit(rec: InternalTask, ev: A2A.A2AStreamEvent): void {
    for (const cb of [...rec.subscribers]) {
      try {
        cb(ev);
      } catch {
        // 单个订阅者异常不影响其他人
      }
    }
  }

  /* ------------------------------ 查询 ------------------------------ */

  list(filter: ListFilter = {}): ListResult {
    const all = [...this.tasks.values()].sort(
      (a, b) => (b.task.status.timestamp ?? '').localeCompare(a.task.status.timestamp ?? ''),
    );
    const filtered = all.filter((t) => {
      if (filter.contextId && t.task.contextId !== filter.contextId) return false;
      if (filter.status && t.task.status.state !== filter.status) return false;
      return true;
    });

    const pageSize = Math.min(Math.max(filter.pageSize ?? 50, 1), 100);
    const offset = filter.pageToken ? Number.parseInt(filter.pageToken, 10) || 0 : 0;
    const slice = filtered.slice(offset, offset + pageSize);
    const nextOffset = offset + slice.length;
    const hasMore = nextOffset < filtered.length;

    return {
      tasks: slice.map((t) => this.project(t, filter)),
      nextPageToken: hasMore ? String(nextOffset) : '',
      totalSize: filtered.length,
    };
  }

  /** 投影：按 historyLength / includeArtifacts 裁剪返回体 */
  project(rec: InternalTask, filter: { historyLength?: number; includeArtifacts?: boolean } = {}): A2A.Task {
    const t = rec.task;
    let task: A2A.Task = { ...t };

    if (filter.includeArtifacts === false) {
      const { artifacts: _drop, ...rest } = task;
      task = rest as A2A.Task;
    }
    if (filter.historyLength !== undefined && task.history) {
      task = { ...task, history: task.history.slice(-filter.historyLength) };
    }
    return task;
  }

  /* ------------------------------ 有界化（ENG-08） ------------------------------ */

  /**
   * 驱逐**只**由 `create()` 尾部调用（顺序纪律 **O-11**：get / list / subscribe / updateStatus
   * 一律不触发，读侧不得出现「刚查到的任务下一帧消失」）。两条独立闸门，同一次调用内先后清扫：
   *
   * ① TTL 闸门：终态且 `terminalAtMs + terminalTtlMs` 已过 ⇒ 删（长跑内存回收主力）。
   * ② 条数闸门：仍超出 `maxTasks` ⇒ 从**最旧终态**开始删至上限。
   *
   * 驱逐候选（三者全须，缺一不可 —— R5 的防线）：
   *   · 任务态是**终态**（活动任务永不被逐，正在跑的委派绝不打断）；
   *   · **无挂起审批**（`pendingApproval` 在位 ⇒ 宿主随时可能应答续跑，逐出等于吞掉人工决策）；
   *   · **非「取消在飞」**（标志已置但尚未落 canceled 终态：此刻 runner 还在退出路上，
   *     提前逐出会让 `runGoalWithLifecycle` 的取消收口分支找不到任务记录）。   *
   * 删除时对该任务 `subscribers.clear()` —— SSE 生成器闭包若仍挂在集合上，任务对象会被
   * 闭包反向强引用而**永不回收**（有界化的意义就没了）。清空后在飞的 SSE 流自然收不到后续事件。
   *
   * `maxTasks` 非有限（`0` / 负数 / `Infinity` / NaN ⇒ 归一为 Infinity）⇒ **整体关闭**：
   * 条数与 TTL 两路一起不做，逐字保留旧行为（既有单测与 fixture 不受影响，判据④）。
   * 注意 `terminalTtlMs` 只在整体开启时生效（偏差 D-18：`maxTasks:0` 是「关掉有界化」的
   * 总开关语义，不「只按 TTL 驱逐」）。
   */
  private evictIfNeeded(): void {
    if (!Number.isFinite(this.maxTasks)) return;
    const now = Date.now();

    // ① TTL 闸门：过期终态一并删
    if (Number.isFinite(this.terminalTtlMs)) {
      for (const [id, rec] of this.tasks) {
        if (this.terminalExpired(rec, now)) this.evict(id, rec, 'ttl');
      }
    }

    // ② 条数闸门：超出上限则从最旧终态删至 maxTasks
    const overflow = this.tasks.size - this.maxTasks;
    if (overflow <= 0) return;
    const candidates = [...this.tasks.entries()]
      .filter(([, rec]) => this.evictable(rec))
      .sort((a, b) => (a[1].terminalAtMs ?? a[1].createdAtMs) - (b[1].terminalAtMs ?? b[1].createdAtMs));
    for (let i = 0; i < overflow && i < candidates.length; i += 1) {
      const [id, rec] = candidates[i]!;
      this.evict(id, rec, 'overflow');
    }
  }

  /**
   * 可驱逐判据：终态 && 无挂起审批 && 非「取消在飞」。
   * 「取消在飞」经 `cancelController.signal.aborted` 判定而**不读**取消标志位 ——
   * 一为把标志位的读取点数量压到设计强制的那一处（它的出现点数量被既有静态守卫钉死，
   *    每多一处读取就要多改一次守卫，见 T3 notes §5 D-14），
   * 二为信号与终态本就同源，语义上更贴近「取消是否真的还在退出路上」。
   * `requestCancel` 里 abort 与置终态同处一个同步体（O-1），故「已 abort 而未落 canceled」
   * 在实际路径上是**瞬时窗口**，本判据属防御性冗余（真被读到即说明存在绕过 requestCancel
   * 的写入者，此刻宁可保守不逐，也不打断在飞任务）。
   */
  private evictable(rec: InternalTask): boolean {
    if (!isTerminalTaskState(rec.task.status.state)) return false;
    if (rec.pendingApproval) return false;
    return !(rec.cancelController.signal.aborted && rec.task.status.state !== 'canceled');
  }

  /** 终态驻留是否已过期（非终态 / 未盖 terminalAtMs ⇒ 永不过期） */
  private terminalExpired(rec: InternalTask, nowMs: number): boolean {
    if (!isTerminalTaskState(rec.task.status.state)) return false;
    const at = rec.terminalAtMs;
    return at !== undefined && at + this.terminalTtlMs < nowMs;
  }

  /**
   * 逐出单条：先断开订阅（防 SSE 闭包强引用），再摘表项，**最后**落可观测面。
   *
   * P2-T7（L1）：`gate` 由调用点显式传入（①/② 两路闸门各传各的，见 `evictIfNeeded()`），
   * 计数与环形日志都在这**唯一的删除路径**上写 ⇒ 三个可见面（`evictedCount()` /
   * `evictionLog()` / `onEviction` 回调）与真实删除严格一一对应，不存在「计了没删」或
   * 「删了没计」的裂缝。顺序上放在 `delete` 之后：观察者若在回调里回头查表，
   * 看到的必须是「已经不存在」的既成事实（否则它会以为任务还在，做出错误的续跑判断）。
   */
  private evict(id: string, rec: InternalTask, gate: EvictionGate): void {
    rec.subscribers.clear();
    this.tasks.delete(id);
    this.recordEviction({
      id,
      terminalState: rec.task.status.state,
      evictedAtMs: Date.now(),
      gate,
    });
  }

  /**
   * 落驱逐可观测面：计数 → 环形日志 → 回调（回调异常被吞）。
   * 与 `onApprovalTimeout` 同纪律：取证失败**绝不影响**有界化本身（R5 防线优先于观测）。
   */
  private recordEviction(info: EvictionRecord): void {
    this.evictedTotal += 1;
    this.evictions[this.evictCursor] = info;
    this.evictCursor = (this.evictCursor + 1) % EVICTION_LOG_CAPACITY;
    if (this.evictFilled < EVICTION_LOG_CAPACITY) this.evictFilled += 1;
    try {
      this.onEviction?.(info);
    } catch {
      /* 观察者异常不影响驱逐收口 */
    }
  }

  size(): number {
    return this.tasks.size;
  }

  /* ------------------------------ 驱逐可观测面（P2-T7 / L1） ------------------------------ */

  /**
   * 本轮运行以来**累计被驱逐的任务条数**（单调不减；`maxTasks` 关闭 ⇒ 恒 0，逐字旧行为）。
   * 读侧方法与 `size()` 并列同风格 ⇒ `/health.tasks` 直接取用，无需第二份状态。
   */
  evictedCount(): number {
    return this.evictedTotal;
  }

  /**
   * **有界**驱逐日志（最近至多 {@link EVICTION_LOG_CAPACITY} 条，按「最旧 → 最新」）。
   * 返回**拷贝数组**：外部持有内部环等于悄悄延长元数据驻留期（W-2 约束）。
   * 只含元数据（id / 终态 / 时刻 / 闸门），不含任何任务内容。
   */
  evictionLog(): readonly EvictionRecord[] {
    const cap = EVICTION_LOG_CAPACITY;
    const out: EvictionRecord[] = [];
    // 未满：有效条目就在 [0, filled)；已满：写指针此刻指向「最旧的那一格」（它下一个要被覆盖）。
    const start = this.evictFilled < cap ? 0 : this.evictCursor;
    for (let i = 0; i < this.evictFilled; i += 1) {
      const rec = this.evictions[(start + i) % cap];
      if (rec) out.push(rec);
    }
    return out;
  }

  /**
   * 本 id 是否**曾被驱逐**（判据 = 环形日志的归因窗口）。
   *
   * 三条诚实边界（都不谎报）：
   *  · 命中 ⇒ true；未命中 ⇒ false —— 窗口是**有界**的，「不在窗口里」既可能是从未存在，
   *    也可能是更早被驱逐后被日志覆盖 ⇒ 本方法只在窗口内给肯定答案，窗口外一律 false
   *    （宁可让运维看到「未知/未记录」，也不给他一个无法证实的「曾存在」结论）；
   *  · `maxTasks` 关闭 ⇒ 环恒空 ⇒ 恒 false（该形态下不存在驱逐这件事）；
   *  · 本方法**不抛错**（读侧探针，被 `get()` 的失败路径调用，绝不能在这里二次抛出打断错误归因）。
   */
  wasEvicted(id: string): boolean {
    if (this.evictFilled === 0) return false;
    const cap = EVICTION_LOG_CAPACITY;
    const start = this.evictFilled < cap ? 0 : this.evictCursor;
    for (let i = 0; i < this.evictFilled; i += 1) {
      if (this.evictions[(start + i) % cap]?.id === id) return true;
    }
    return false;
  }
}

/**
 * P2-T12（L2-D）：把 `onStatus` 的进度文案整形为**合规** `A2A.Message`（wire 形状的唯一裁决点）。
 *
 * 病灶（真机实证 `qa/r19/t5-l2d-deterministic-evidence.md`）：契约声明 `onStatus(message?: string)`
 * （contracts/bridge.ts）→ provider 全部传 string → 旧实现把 string **裸 as-cast** 成
 * `A2A.Message` 直存 ⇒ wire 上是裸字符串 → 宿主 `extractText` 只认 `Message.parts[]`
 * （host-a2a-bridge/tools.ts）⇒ 恒空。有态进度文案（含确定性路径 delegate 的实时回显与
 * 有态取消文案的派生输入）对两种 provider 的生产呈现面均不可达。
 *
 * 三分支（形态对照本文件 `approvalMessage` / `approvalTimeoutMessage` 与 server.ts
 * `resultMessage` / `errorMessage` 四个既有正确样板）：
 *  · `string` 且 trim 后非空 ⇒ 构造 `{kind:'message', role:'agent', messageId: 新 UUID,
 *    taskId, parts:[{kind:'text', text: 原文案}]}`。role=agent：进度文案是 Agent 侧叙述；
 *    携带 taskId：四样板一致；text 用**原文**（trim 只用于判空，文案逐字保真——
 *    脱敏归宿主侧 scrubText，本层不加工）；单 text part：本路径不产 data part
 *    （审批结构由 `waitApproval` 独立通路，不受本修复影响）。
 *  · `string` 为空串/仅空白 ⇒ **缺席**（返回 undefined）。等价性论证：修复前空串 as-cast 后
 *    宿主 `extractText` 恒返 `''` ⇒ `if (text)` 不 push；修复后若不判空，`parts:[{text:''}]`
 *    经 join+trim 仍为 `''` ⇒ 同样不 push。两形态宿主端不可分 ⇒ 取最保守的「键整体缺席」
 *    （status 不写 message 键，emit/投影与 `onStatus(state)` 裸调用逐字同形）。
 *  · 缺席（undefined / null）⇒ 原样缺席（既有裸 `onStatus('working')` 调用面零变化）。
 *
 * 防御性宽容：其余对象形态 **verbatim 透传**（第三方 provider 若已按正确形态直传
 * Message，零重复包装、引用不变 —— 契约虽只声明 string，修复前的运行时形态本就是
 * 「任意值直存」，此处保持对合法 Message 输入幂等，同时把它显式化为一等分支）。
 * 非 string / 非 object 的杂值（number / boolean 等）归缺席 —— 契约外形态，宁可缺席
 * 也不给宿主一个谎称 Message 的脏值。
 *
 * 签名用 `unknown` 而非契约的 `string | undefined`：契约参数名 `message` 语义即
 * "状态消息"，运行时历史形态是直存任意值；以 `unknown` 收口才能把三分支写成
 * 类型完备的裁决函数（调用点上下文类型不变，纯内部收窄）。
 */
function toStatusMessage(taskId: string, message: unknown): A2A.Message | undefined {
  if (typeof message === 'string') {
    if (message.trim() === '') return undefined;
    return {
      kind: 'message',
      role: 'agent',
      messageId: randomUUID(),
      taskId,
      parts: [{ kind: 'text', text: message }],
    };
  }
  if (message !== null && typeof message === 'object') {
    return message as A2A.Message;
  }
  return undefined;
}

/**
 * 把 TaskStore 包装为 ProgressSink 供 provider 使用。
 * provider 只调用 sink，不直接接触 TaskStore —— 保持桥接层解耦。
 *
 * P2-T12：`onStatus` 的文案经 {@link toStatusMessage} 整形后才进 `updateStatus`
 * （旧裸 as-cast 是 L2-D 病灶；`TaskStore.updateStatus` 签名与行为**不动** ——
 * 终态收口等直传 store 的调用点本就传合规 Message，不经本闸）。
 */
export function createProgressSink(store: TaskStore, taskId: string): ProgressSink {
  return {
    onStatus(state, message) {
      store.updateStatus(taskId, state as A2A.TaskState, toStatusMessage(taskId, message));
    },
    onArtifact(artifact) {
      store.addArtifact(taskId, {
        artifactId: randomUUID(),
        name: artifact.name,
        ...(artifact.encoding === 'base64' && typeof artifact.data === 'string'
          ? { description: artifact.kind }
          : {}),
        parts: [toPart(artifact)],
      });
    },
    onApprovalRequired(req) {
      return store.waitApproval(taskId, req);
    },
    // ARCH-22（纯附加）：把同一 taskId 的取消探测面透出给 provider ——
    // `isCancelled` 供能力边界**轮询**，`cancellationSignal` 供**事件**（kill 子进程 / abort 常驻会话）。
    // 两者与 store 内的同一个 AbortController 同源，provider 不直接接触 TaskStore（保持桥接层解耦）。
    isCancelled: () => store.isCancelled(taskId),
    cancellationSignal: store.cancellationSignal(taskId),
  };
}

function toPart(artifact: {
  kind: string;
  name: string;
  mime: string;
  data: string | Record<string, unknown>;
  encoding?: string;
}): A2A.Part {
  if (artifact.kind === 'screenshot' || artifact.encoding === 'base64') {
    if (typeof artifact.data !== 'string') {
      return { kind: 'data', data: artifact.data };
    }
    return { kind: 'file', file: { name: artifact.name, mimeType: artifact.mime, bytes: artifact.data } };
  }
  if (typeof artifact.data === 'string') {
    return { kind: 'text', text: artifact.data };
  }
  return { kind: 'data', data: artifact.data };
}

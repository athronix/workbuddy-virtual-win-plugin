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
 * 未知任务 id 的兜底信号：一个**永不** abort 的共享 AbortSignal。
 * 为什么共享而非每次 `AbortController` 新建：`cancellationSignal()` 可能被 provider 在循环里
 * 反复调用，共享常量零分配；且它永不置位 ⇒ 「任务不存在」不会被误读成「已取消」。
 */
const NEVER_ABORTED_SIGNAL: AbortSignal = new AbortController().signal;

export interface TaskStoreOptions {
  /**
   * 审批等待 TTL（毫秒）；未给 → env `WINVM_APPROVAL_TTL_MS` → 默认 30 分钟。
   * 传 `0` / 负数 / `Infinity` 表示不设超时（仅测试用途；生产不建议）。
   */
  readonly approvalTtlMs?: number;
  /** 审批超时回调（清理宿主侧令牌等；异常被吞，不影响任务收口） */
  readonly onApprovalTimeout?: (info: ApprovalTimeoutInfo) => void;
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
  constructor(readonly taskId: string) {
    super(`任务不存在或不可访问：${taskId}`);
    this.name = 'TaskNotFoundError';
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

  constructor(opts: TaskStoreOptions = {}) {
    // 未显式指定 → env（非法回退 30 分钟默认）；显式传 ≤0 / 非有限 → 视为不设超时
    this.approvalTtlMs =
      opts.approvalTtlMs === undefined
        ? resolveApprovalTtlMs()
        : Number.isFinite(opts.approvalTtlMs) && opts.approvalTtlMs > 0
          ? Math.floor(opts.approvalTtlMs)
          : Number.POSITIVE_INFINITY;
    this.onApprovalTimeout = opts.onApprovalTimeout;
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

  get(id: string): InternalTask {
    const t = this.tasks.get(id);
    if (!t) throw new TaskNotFoundError(id);
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
        if (this.terminalExpired(rec, now)) this.evict(id, rec);
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
      this.evict(id, rec);
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

  /** 逐出单条：先断开订阅（防 SSE 闭包强引用），再摘表项 */
  private evict(id: string, rec: InternalTask): void {
    rec.subscribers.clear();
    this.tasks.delete(id);
  }

  size(): number {
    return this.tasks.size;
  }
}

/**
 * 把 TaskStore 包装为 ProgressSink 供 provider 使用。
 * provider 只调用 sink，不直接接触 TaskStore —— 保持桥接层解耦。
 */
export function createProgressSink(store: TaskStore, taskId: string): ProgressSink {
  return {
    onStatus(state, message) {
      store.updateStatus(taskId, state as A2A.TaskState, message as A2A.Message | undefined);
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

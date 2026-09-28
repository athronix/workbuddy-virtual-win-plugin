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

export interface TaskStoreOptions {
  /**
   * 审批等待 TTL（毫秒）；未给 → env `WINVM_APPROVAL_TTL_MS` → 默认 30 分钟。
   * 传 `0` / 负数 / `Infinity` 表示不设超时（仅测试用途；生产不建议）。
   */
  readonly approvalTtlMs?: number;
  /** 审批超时回调（清理宿主侧令牌等；异常被吞，不影响任务收口） */
  readonly onApprovalTimeout?: (info: ApprovalTimeoutInfo) => void;
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

  constructor(opts: TaskStoreOptions = {}) {
    // 未显式指定 → env（非法回退 30 分钟默认）；显式传 ≤0 / 非有限 → 视为不设超时
    this.approvalTtlMs =
      opts.approvalTtlMs === undefined
        ? resolveApprovalTtlMs()
        : Number.isFinite(opts.approvalTtlMs) && opts.approvalTtlMs > 0
          ? Math.floor(opts.approvalTtlMs)
          : Number.POSITIVE_INFINITY;
    this.onApprovalTimeout = opts.onApprovalTimeout;
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
      createdAtMs: Date.now(),
    };
    this.tasks.set(id, rec);
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

  addArtifact(id: string, artifact: A2A.Artifact): void {
    const rec = this.get(id);
    const artifacts = [...(rec.task.artifacts ?? []), artifact];
    rec.task = { ...rec.task, artifacts };
    this.emit(rec, {
      kind: 'artifact-update',
      taskId: id,
      contextId: rec.task.contextId,
      artifact,
      lastChunk: true,
    });
  }

  setMetadata(id: string, metadata: Record<string, unknown>): void {
    const rec = this.get(id);
    rec.task = { ...rec.task, metadata: { ...(rec.task.metadata ?? {}), ...metadata } };
  }

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
    return this.updateStatus(id, 'canceled');
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

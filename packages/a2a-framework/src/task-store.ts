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

export interface PendingApproval {
  readonly request: ApprovalRequest;
  resolve(approved: boolean): void;
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
    if (isTerminalTaskState(rec.task.status.state) && state !== rec.task.status.state) {
      // 终态不可再流转（A2A 规范：终止状态的任务不再接受变更）
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
    return this.updateStatus(id, 'canceled');
  }

  /* ------------------------------ 审批闸 ------------------------------ */

  /** 置 input-required 并挂起等待宿主应答 */
  waitApproval(id: string, req: ApprovalRequest): Promise<boolean> {
    const rec = this.get(id);
    return new Promise<boolean>((resolve) => {
      rec.pendingApproval = {
        request: req,
        resolve: (approved: boolean) => {
          rec.pendingApproval = undefined;
          resolve(approved);
        },
      };
      this.updateStatus(id, 'input-required', this.approvalMessage(id, req));
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
            `{"approvalId":"${req.approvalId}","approved":true}`,
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
          },
        },
      ],
    };
  }

  resolveApproval(id: string, approvalId: string, approved: boolean): boolean {
    const rec = this.tryGet(id);
    const pending = rec?.pendingApproval;
    if (!pending || pending.request.approvalId !== approvalId) return false;
    pending.resolve(approved);
    return true;
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

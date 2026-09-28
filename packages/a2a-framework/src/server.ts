/**
 * A2A v1.0 Server（JSON-RPC 2.0 over HTTPS）
 *
 * 严格遵循 v1.0 方法名：message/send / message/stream / tasks/get / tasks/list /
 * tasks/cancel / tasks/subscribe / agent/getAuthenticatedExtendedCard。
 * 收到已废弃的 v0.x 方法名（tasks/send 等）返回 MethodNotFound，**不做静默兼容**。
 */

import { randomUUID } from 'node:crypto';

import {
  A2A,
  type Artifact,
  type GoalRequest,
  type GoalResult,
  type Logger,
  type ProgressSink,
  type RiskLevel,
} from '@winvm/contracts';
import { NullLogger } from '@winvm/core';

import {
  type InternalTask,
  type ListFilter,
  TaskNotFoundError,
  TaskNotCancelableError,
  TaskStore,
  createProgressSink,
} from './task-store.js';

/* ------------------------------ 入参 ------------------------------ */

export interface AgentCardInput {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly url: string;
  readonly provider?: { readonly organization: string; readonly url?: string };
  readonly skills: readonly A2A.AgentSkill[];
  readonly capabilities?: A2A.AgentCapabilities;
  readonly defaultInputModes?: readonly string[];
  readonly defaultOutputModes?: readonly string[];
  readonly supportedInterfaces?: readonly A2A.AgentInterface[];
  readonly securitySchemes?: Readonly<Record<string, Record<string, unknown>>>;
  readonly security?: readonly Record<string, string[]>[];
  /** 需鉴权才返回的扩展卡（可选） */
  readonly extendedCard?: Partial<A2A.AgentCard>;
}

export interface A2AGoalHandler {
  runGoal(req: GoalRequest, sink: ProgressSink): Promise<GoalResult>;
}

export interface A2AServerOptions {
  readonly agentCard: AgentCardInput;
  readonly handler: A2AGoalHandler;
  readonly logger?: Logger;
  readonly taskStore?: TaskStore;
  /** 默认委派最高风险（未显式指定时） */
  readonly defaultMaxRisk?: RiskLevel;
}

/* ------------------------------ 工具 ------------------------------ */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function textOf(msg: A2A.Message): string {
  return msg.parts
    .map((p) => (p.kind === 'text' ? p.text : ''))
    .join('\n')
    .trim();
}

function dataPartsOf(msg: A2A.Message): Record<string, unknown>[] {
  return msg.parts.filter((p): p is A2A.DataPart => p.kind === 'data').map((p) => p.data);
}

function randomId(): string {
  return randomUUID();
}

/* ------------------------------ Server ------------------------------ */

export class A2AServer {
  private readonly card: A2A.AgentCard;
  private readonly extended?: A2A.AgentCard;
  private readonly handler: A2AGoalHandler;
  private readonly logger: Logger;
  readonly tasks: TaskStore;
  private readonly defaultMaxRisk: RiskLevel;

  constructor(opts: A2AServerOptions) {
    this.handler = opts.handler;
    this.logger = opts.logger ?? new NullLogger();
    this.tasks = opts.taskStore ?? new TaskStore();
    this.defaultMaxRisk = opts.defaultMaxRisk ?? 'L1';

    const c = opts.agentCard;
    this.card = {
      protocolVersion: A2A.A2A_PROTOCOL_VERSION,
      name: c.name,
      description: c.description,
      version: c.version,
      url: c.url,
      ...(c.provider ? { provider: c.provider } : {}),
      iconUrl: undefined,
      capabilities: c.capabilities ?? { streaming: true, pushNotifications: false },
      defaultInputModes: c.defaultInputModes ?? ['text', 'data'],
      defaultOutputModes: c.defaultOutputModes ?? ['text', 'data', 'image/png'],
      supportedInterfaces: c.supportedInterfaces ?? [
        {
          url: c.url,
          protocolBinding: 'JSONRPC',
          protocolVersion: A2A.A2A_PROTOCOL_VERSION,
        },
      ],
      skills: c.skills,
      ...(c.securitySchemes ? { securitySchemes: c.securitySchemes } : {}),
      ...(c.security ? { security: c.security } : {}),
    } as A2A.AgentCard;

    this.extended = c.extendedCard ? ({ ...this.card, ...c.extendedCard } as A2A.AgentCard) : undefined;
  }

  getAgentCard(): A2A.AgentCard {
    return this.card;
  }

  hasExtendedCard(): boolean {
    return this.extended !== undefined;
  }

  getExtendedCard(): A2A.AgentCard {
    if (!this.extended) {
      throw new Error('AuthenticatedExtendedCardNotConfiguredError');
    }
    return this.extended;
  }

  /* ------------------------------ 分发 ------------------------------ */

  async handleRequest(body: unknown): Promise<A2A.JsonRpcResponse> {
    if (!isRecord(body)) return this.fail(null, A2A.JSON_RPC_ERRORS.INVALID_REQUEST, '请求体必须是对象');

    const id = (body['id'] ?? null) as string | number | null;
    const method = body['method'];
    if (typeof method !== 'string') {
      return this.fail(id, A2A.JSON_RPC_ERRORS.INVALID_REQUEST, '缺少 method');
    }
    const params = (isRecord(body['params']) ? body['params'] : {}) as Record<string, unknown>;

    if ((A2A.A2A_DEPRECATED_METHODS as readonly string[]).includes(method)) {
      return this.fail(
        id,
        A2A.JSON_RPC_ERRORS.METHOD_NOT_FOUND,
        `方法 ${method} 在 A2A v1.0 已废弃，请使用 ${method === 'tasks/send' ? 'message/send' : 'message/stream'}`,
      );
    }
    if (!(A2A.A2A_METHODS as readonly string[]).includes(method)) {
      return this.fail(id, A2A.JSON_RPC_ERRORS.METHOD_NOT_FOUND, `未知方法：${method}`);
    }

    try {
      switch (method as A2A.A2AMethod) {
        case 'message/send':
          return this.ok(id, await this.sendMessage(params));
        case 'tasks/get':
          return this.ok(id, this.getTask(params));
        case 'tasks/list':
          return this.ok(id, this.listTasks(params));
        case 'tasks/cancel':
          return this.ok(id, this.cancelTask(params));
        case 'agent/getAuthenticatedExtendedCard':
          return this.ok(id, this.getExtendedCard());
        case 'message/stream':
          return this.fail(
            id,
            A2A.JSON_RPC_ERRORS.INVALID_REQUEST,
            'message/stream 需走 SSE 通道，请使用 handleStream()',
          );
        case 'tasks/subscribe':
          return this.fail(
            id,
            A2A.JSON_RPC_ERRORS.INVALID_REQUEST,
            'tasks/subscribe 需走 SSE 通道，请使用 subscribeStream()',
          );
        default:
          return this.fail(id, A2A.JSON_RPC_ERRORS.METHOD_NOT_FOUND, `未实现：${method}`);
      }
    } catch (e) {
      return this.mapError(id, e);
    }
  }

  /* ------------------------------ message/send ------------------------------ */

  private async sendMessage(params: Record<string, unknown>): Promise<unknown> {
    const message = params['message'] as A2A.Message | undefined;
    if (!message || !isRecord(message)) {
      throw new InvalidParamsError('缺少 params.message');
    }
    const configuration = isRecord(params['configuration'])
      ? (params['configuration'] as A2A.SendMessageParams['configuration'])
      : undefined;
    const metadata = (isRecord(params['metadata']) ? params['metadata'] : {}) as Record<
      string,
      unknown
    >;

    // 续接既有任务（审批应答或补充信息）
    const existingId = message.taskId;
    if (typeof existingId === 'string' && existingId.length > 0) {
      return this.continueTask(existingId, message);
    }

    const rec = this.tasks.create({
      ...(message.contextId ? { contextId: message.contextId } : {}),
      metadata,
    });
    this.tasks.appendHistory(rec.task.id, message);

    const goal: GoalRequest = {
      traceId: typeof metadata['traceId'] === 'string' ? metadata['traceId'] : `tr_${randomId()}`,
      goal: textOf(message),
      ...(Object.keys(message.metadata ?? {}).length > 0 ? { context: message.metadata } : {}),
      ...(Array.isArray(metadata['allowedCapabilities'])
        ? { allowedCapabilities: metadata['allowedCapabilities'] as string[] }
        : {}),
      maxRisk: (typeof metadata['maxRisk'] === 'string'
        ? (metadata['maxRisk'] as RiskLevel)
        : this.defaultMaxRisk) as RiskLevel,
      timeoutMs: typeof metadata['timeoutMs'] === 'number' ? metadata['timeoutMs'] : 300_000,
    };

    this.tasks.updateStatus(rec.task.id, 'working');
    const sink = createProgressSink(this.tasks, rec.task.id);
    const runner = this.runGoalWithLifecycle(rec, goal, sink);

    // blocking=true：等待终态后返回；否则立即返回 Task（异步继续）
    if (configuration?.blocking === true) {
      await runner;
    } else {
      void runner.catch((e) => this.logger.error('goal failed', { error: String(e) }));
    }
    return this.tasks.project(rec, {
      includeArtifacts: true,
      ...(configuration?.historyLength !== undefined
        ? { historyLength: configuration.historyLength }
        : {}),
    });
  }

  private async continueTask(taskId: string, message: A2A.Message): Promise<unknown> {
    const rec = this.tasks.get(taskId);
    this.tasks.appendHistory(taskId, message);

    // 审批应答
    for (const data of dataPartsOf(message)) {
      const approvalId = data['approvalId'];
      const approved = data['approved'];
      if (typeof approvalId === 'string' && typeof approved === 'boolean') {
        const handled = this.tasks.resolveApproval(taskId, approvalId, approved);
        if (!handled) {
          // P3-3：审批等待有 TTL。超时后任务已按「拒绝」收口为 failed，
          // 迟到的应答**绝不复活任务、更绝不放行**（故这里只报错、不做任何状态流转）。
          const timedOut = this.tasks.tryGet(taskId)?.task.metadata?.['approvalTimedOut'] === true;
          throw new InvalidParamsError(
            `任务 ${taskId} 上没有待处理的审批 ${approvalId}` +
              (timedOut
                ? '（审批等待已超时，任务按拒绝收口；如需执行请重新发起委派）'
                : '（可能已处理或已过期）'),
          );
        }
        if (!approved) {
          this.tasks.updateStatus(taskId, 'rejected');
          return this.tasks.project(rec, { includeArtifacts: true });
        }
        // 审批通过：任务由挂起的 runner 自行继续（state 回到 working）
        this.tasks.updateStatus(taskId, 'working');
        return this.tasks.project(rec, { includeArtifacts: true });
      }
    }

    // 非审批续接：把追加文本作为新的目标继续执行
    const appended = textOf(message);
    if (appended.length > 0 && rec.task.status.state === 'input-required') {
      this.tasks.updateStatus(taskId, 'working');
    }
    return this.tasks.project(rec, { includeArtifacts: true });
  }

  private async runGoalWithLifecycle(
    rec: InternalTask,
    goal: GoalRequest,
    sink: ProgressSink,
  ): Promise<void> {
    const id = rec.task.id;
    try {
      // K4：把本任务的 id 注入 goal，使桥接层能经审批协调器把 input-required 挂到正确任务上。
      // P3-2：改为**构造期注入** —— 用展开新建对象传给 handler，而不是 `Object.assign` 就地补写。
      // GoalRequest 字段全为 readonly，就地改写绕过类型系统：对象一旦被冻结（Object.freeze）
      // 就会静默失效，且会污染调用方持有的原 goal。展开构造保持不可变约定、对冻结安全。
      const goalWithTask: GoalRequest = { ...goal, taskId: id };

      const result = await this.handler.runGoal(goalWithTask, {
        ...sink,
        onStatus: (state, message) => {
          // 终态由本方法统一收口，避免 provider 与框架竞争
          if (state === 'completed' || state === 'failed') return;
          sink.onStatus(state, message);
        },
      });

      // K4 安全网：若桥接层已把任务挂起为 input-required（等待宿主审批）或仍有未决审批，
      // 绝不覆盖其状态 —— 维持 input-required，由宿主审批应答（continueTask）续跑/拒绝。
      const recNow = this.tasks.tryGet(id);
      if (recNow && (recNow.task.status.state === 'input-required' || recNow.pendingApproval)) {
        return;
      }

      for (const a of result.artifacts) {
        sink.onArtifact(a);
      }
      sink.onArtifact(stepsArtifact(result));

      const finalState: A2A.TaskState = result.ok ? 'completed' : 'failed';
      this.tasks.updateStatus(
        id,
        finalState,
        resultMessage(id, result),
      );
      this.tasks.setMetadata(id, { goalSummary: result.summary, stepCount: result.steps.length });
    } catch (e) {
      this.logger.error('runGoal 异常', { taskId: id, error: String(e) });
      this.tasks.updateStatus(id, 'failed', errorMessage(id, e));
    }
  }

  /* ------------------------------ tasks/* ------------------------------ */

  private getTask(params: Record<string, unknown>): unknown {
    const id = this.taskIdOf(params);
    const rec = this.tasks.get(id);
    const historyLength =
      typeof params['historyLength'] === 'number' ? params['historyLength'] : undefined;
    return this.tasks.project(rec, {
      includeArtifacts: params['includeArtifacts'] !== false,
      ...(historyLength !== undefined ? { historyLength } : {}),
    });
  }

  private listTasks(params: Record<string, unknown>): unknown {
    const filter: ListFilter = {
      ...(typeof params['contextId'] === 'string' ? { contextId: params['contextId'] } : {}),
      ...(typeof params['status'] === 'string' ? { status: params['status'] as A2A.TaskState } : {}),
      ...(typeof params['pageSize'] === 'number' ? { pageSize: params['pageSize'] } : {}),
      ...(typeof params['pageToken'] === 'string' ? { pageToken: params['pageToken'] } : {}),
      historyLength:
        typeof params['historyLength'] === 'number' ? params['historyLength'] : undefined,
      includeArtifacts: params['includeArtifacts'] === true,
    };
    const res = this.tasks.list(filter);
    return {
      tasks: res.tasks,
      nextPageToken: res.nextPageToken,
      pageSize: filter.pageSize ?? 50,
      totalSize: res.totalSize,
    };
  }

  private cancelTask(params: Record<string, unknown>): unknown {
    const id = this.taskIdOf(params);
    const rec = this.tasks.requestCancel(id);
    return this.tasks.project(rec, { includeArtifacts: true });
  }

  private taskIdOf(params: Record<string, unknown>): string {
    const name = params['name'];
    if (typeof name === 'string' && name.startsWith('tasks/')) return name.slice(6);
    const id = params['id'];
    if (typeof id === 'string' && id.length > 0) return id;
    throw new InvalidParamsError('缺少任务标识（params.name 或 params.id）');
  }

  /* ------------------------------ 流式 ------------------------------ */

  /** message/stream：建任务并产出 SSE 事件流 */
  async *handleStream(params: Record<string, unknown>): AsyncIterable<A2A.A2AStreamEvent> {
    const message = params['message'] as A2A.Message | undefined;
    if (!message) throw new InvalidParamsError('缺少 params.message');
    const metadata = (isRecord(params['metadata']) ? params['metadata'] : {}) as Record<
      string,
      unknown
    >;

    const rec = this.tasks.create({
      ...(message.contextId ? { contextId: message.contextId } : {}),
      metadata,
    });
    this.tasks.appendHistory(rec.task.id, message);

    const queue: A2A.A2AStreamEvent[] = [];
    let closed = false;
    let notify: (() => void) | null = null;

    const unsubscribe = this.tasks.subscribe(rec.task.id, (ev) => {
      queue.push(ev);
      notify?.();
      if (ev.kind === 'status-update' && ev.final) closed = true;
    });

    const goal: GoalRequest = {
      traceId: typeof metadata['traceId'] === 'string' ? metadata['traceId'] : `tr_${randomId()}`,
      goal: textOf(message),
      maxRisk: (typeof metadata['maxRisk'] === 'string'
        ? (metadata['maxRisk'] as RiskLevel)
        : this.defaultMaxRisk) as RiskLevel,
      timeoutMs: typeof metadata['timeoutMs'] === 'number' ? metadata['timeoutMs'] : 300_000,
    };

    this.tasks.updateStatus(rec.task.id, 'working');
    const sink = createProgressSink(this.tasks, rec.task.id);
    void this.runGoalWithLifecycle(rec, goal, sink).finally(() => {
      closed = true;
      notify?.();
    });

    try {
      for (;;) {
        if (queue.length === 0) {
          if (closed) break;
          await new Promise<void>((r) => {
            notify = r;
            setTimeout(r, 500).unref?.();
          });
          notify = null;
        }
        const ev = queue.shift();
        if (ev) {
          yield ev;
          if (ev.kind === 'status-update' && ev.final) break;
        }
      }
    } finally {
      unsubscribe();
    }
  }

  /** tasks/subscribe：订阅既有任务 */
  async *subscribeStream(params: Record<string, unknown>): AsyncIterable<A2A.A2AStreamEvent> {
    const id = this.taskIdOf(params);
    const rec = this.tasks.get(id);
    const queue: A2A.A2AStreamEvent[] = [];
    let closed = false;
    let notify: (() => void) | null = null;

    const unsubscribe = this.tasks.subscribe(id, (ev) => {
      queue.push(ev);
      notify?.();
      if (ev.kind === 'status-update' && ev.final) closed = true;
    });

    try {
      // 首个事件必须是当前 Task 快照（A2A 规范要求）
      yield {
        kind: 'status-update',
        taskId: id,
        contextId: rec.task.contextId,
        status: rec.task.status,
        final: false,
      } satisfies A2A.TaskStatusUpdateEvent;

      for (;;) {
        if (queue.length === 0) {
          if (closed) break;
          await new Promise<void>((r) => {
            notify = r;
            setTimeout(r, 500).unref?.();
          });
          notify = null;
        }
        const ev = queue.shift();
        if (ev) {
          yield ev;
          if (ev.kind === 'status-update' && ev.final) break;
        }
      }
    } finally {
      unsubscribe();
    }
  }

  /* ------------------------------ 响应构造 ------------------------------ */

  private ok(id: string | number | null, result: unknown): A2A.JsonRpcResponse {
    return { jsonrpc: '2.0', id, result };
  }

  private fail(id: string | number | null, code: number, message: string, data?: unknown): A2A.JsonRpcResponse {
    return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
  }

  private mapError(id: string | number | null, e: unknown): A2A.JsonRpcResponse {
    if (e instanceof TaskNotFoundError) {
      return this.fail(id, A2A.JSON_RPC_ERRORS.INVALID_PARAMS, e.message, {
        code: A2A.A2A_ERROR_CODES.TASK_NOT_FOUND,
      });
    }
    if (e instanceof TaskNotCancelableError) {
      return this.fail(id, A2A.JSON_RPC_ERRORS.INVALID_PARAMS, e.message, {
        code: A2A.A2A_ERROR_CODES.TASK_NOT_CANCELABLE,
      });
    }
    if (e instanceof InvalidParamsError) {
      return this.fail(id, A2A.JSON_RPC_ERRORS.INVALID_PARAMS, e.message, {
        code: A2A.A2A_ERROR_CODES.INVALID_PARAMS,
      });
    }
    this.logger.error('A2A 内部错误', { error: String(e) });
    return this.fail(id, A2A.JSON_RPC_ERRORS.INTERNAL_ERROR, (e as Error).message ?? '内部错误');
  }
}

export class InvalidParamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidParamsError';
  }
}

/* ------------------------------ 结果消息 ------------------------------ */

function resultMessage(taskId: string, result: GoalResult): A2A.Message {
  return {
    kind: 'message',
    role: 'agent',
    messageId: randomId(),
    taskId,
    parts: [
      { kind: 'text', text: result.summary },
      {
        kind: 'data',
        data: {
          ok: result.ok,
          stepCount: result.steps.length,
          steps: result.steps.map((s) => ({
            index: s.index,
            capabilityId: s.capabilityId,
            risk: s.risk,
            ok: s.ok,
            durationMs: s.durationMs,
            ...(s.summary ? { summary: s.summary } : {}),
          })),
        },
      },
    ],
  };
}

function errorMessage(taskId: string, e: unknown): A2A.Message {
  return {
    kind: 'message',
    role: 'agent',
    messageId: randomId(),
    taskId,
    parts: [{ kind: 'text', text: `任务执行失败：${(e as Error).message ?? String(e)}` }],
  };
}

/** 把逐步执行记录固化为 artifact —— 破除"委派黑盒"（NFR-509） */
function stepsArtifact(result: GoalResult): Artifact {
  return {
    kind: 'steps',
    name: 'execution-steps',
    mime: 'application/json',
    encoding: 'json',
    data: {
      ok: result.ok,
      summary: result.summary,
      steps: result.steps.map((s) => ({
        index: s.index,
        capabilityId: s.capabilityId,
        params: s.params,
        risk: s.risk,
        ok: s.ok,
        durationMs: s.durationMs,
        traceId: s.traceId,
        ...(s.summary ? { summary: s.summary } : {}),
        ...(s.error ? { error: s.error } : {}),
      })),
    },
  };
}

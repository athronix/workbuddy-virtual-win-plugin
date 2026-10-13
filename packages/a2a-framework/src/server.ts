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
import { CancelRateLimiter, type CancelRateLimit } from './rate-limiter.js';

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

/**
 * K-N1 委派观测点（**纯附加可选**；缺席零行为变化）。
 *
 * 为什么在框架只留回调、不落审计：`a2a-framework` 不拥有 `AuditSink`，依赖方向铁律是
 * 框架层不得 import `@winvm/core`（设计 §2.4）；语义（壳双态条目）由 vm-service 实现本接口完成。
 * 两点即设计 §7 时序图的 `onGoalAccepted` / `onGoalTerminal`。
 */
/** `onGoalTerminal` 的终态快照（框架据 result.ok / 异常 / 挂起 / 取消 四者之一给出；设计 §1.1-3） */
export interface DelegationTerminalSnapshot {
  /**
   * 框架写入 A2A 的任务态：completed | failed | input-required（挂起）
   * | canceled（ARCH-22 **附加枚举成员**：取消收口分支与 provider 因取消抛错的路径）。
   *
   * 附加性：旧 observer 只用三元组做 `=== 'failed'` / `=== 'completed'` 比较 ⇒ 拿到 'canceled'
   * 时既不谎报 completed 也不谎报 failed；不读该值的实现零感知。
   * 注意 **rejected 仍刻意不在本联合内**（D-5：rejected 只能由 observer 依 TaskStore
   * 实际状态回改产生，框架层不直发）—— 新增 canceled 不构成对 rejected 的放宽。
   */
  readonly state: 'completed' | 'failed' | 'input-required' | 'canceled';
  /** handler 返回值（挂起与异常路径可为 undefined） */
  readonly result?: GoalResult;
  /** runGoal 抛出的异常（仅 failed / canceled 异常路径） */
  readonly error?: unknown;
}

export interface DelegationObserver {
  /** 受理：`runGoalWithLifecycle` 调 handler 前（此时 `goal.taskId` 已注入） */
  onGoalAccepted(goal: GoalRequest): void;
  /** 终态收口：completed / failed / input-required 挂起三点均回调（设计 §2.1） */
  onGoalTerminal(taskId: string, goal: GoalRequest, snapshot: DelegationTerminalSnapshot): void;
}

export interface A2AServerOptions {
  readonly agentCard: AgentCardInput;
  readonly handler: A2AGoalHandler;
  readonly logger?: Logger;
  readonly taskStore?: TaskStore;
  /** 默认委派最高风险（未显式指定时） */
  readonly defaultMaxRisk?: RiskLevel;
  /** K-N1（**纯附加可选**）：委派观测点（见 `DelegationObserver`） */
  readonly delegationObserver?: DelegationObserver;
  /**
   * R-5（Phase 3 批5，**纯附加可选**）：`tasks/cancel` 风暴门禁（滑动窗口限流）。
   * 缺席/禁用 ⇒ 逐字旧行为。真机实证 198×并发8 cancel 打挂服务+~90 孤儿 node
   * （abort 打断常驻会话⇒重建风暴）；超限 cancel 直接拒回（拒多余 cancel 优于打挂）。
   */
  readonly cancelRateLimit?: CancelRateLimit;
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
  /** K-N1（纯附加）：委派观测点（vm-service 注入实现；缺席即旧行为） */
  private readonly delegationObserver?: DelegationObserver;
  /** R-5（纯附加）：tasks/cancel 风暴限流器；未配 ⇒ undefined ⇒ 逐字旧行为 */
  private readonly cancelLimiter?: CancelRateLimiter;

  constructor(opts: A2AServerOptions) {
    this.handler = opts.handler;
    this.logger = opts.logger ?? new NullLogger();
    this.tasks = opts.taskStore ?? new TaskStore();
    this.defaultMaxRisk = opts.defaultMaxRisk ?? 'L1';
    this.delegationObserver = opts.delegationObserver;
    this.cancelLimiter = opts.cancelRateLimit ? new CancelRateLimiter(opts.cancelRateLimit) : undefined;

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
          // R-5 风暴门禁：超限直接拒回（不进 requestCancel，不打断常驻会话、不触发重建）。
          if (this.cancelLimiter?.enabled) {
            const verdict = this.cancelLimiter.tryConsume();
            if (!verdict.allowed) {
              this.logger.warn('tasks/cancel 风暴限流：拒绝多余 cancel', { retryAfterMs: verdict.retryAfterMs });
              return this.fail(
                id,
                A2A.JSON_RPC_ERRORS.INVALID_REQUEST,
                `取消请求过于频繁（R-5 风暴门禁），请退避 ${verdict.retryAfterMs}ms 后重试`,
                { retryAfterMs: verdict.retryAfterMs, rateLimited: true },
              );
            }
          }
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

      // K-N1（纯附加）：受理观测点（服务端在此落 delegation.start 并开账本窗口）。
      // 纪律：observer 异常**绝不得**影响委派生命周期 —— 只 warn（取证面与执行面分离）。
      this.observe(() => this.delegationObserver?.onGoalAccepted(goalWithTask));

      const result = await this.handler.runGoal(goalWithTask, {
        ...sink,
        onStatus: (state, message) => {
          // 终态由本方法统一收口，避免 provider 与框架竞争
          if (state === 'completed' || state === 'failed') return;
          sink.onStatus(state, message);
        },
        // ARCH-22：取消探测面**逐字透传**给 handler（与 store 内同一个 AbortController 同源）。
        // 条件展开：sink 上缺席 ⇒ 该键整体不写，绝不落显式 undefined（旧 provider 零感知）。
        ...(sink.isCancelled ? { isCancelled: () => sink.isCancelled?.() === true } : {}),
        ...(sink.cancellationSignal ? { cancellationSignal: sink.cancellationSignal } : {}),
      });

      // K4 安全网：若桥接层已把任务挂起为 input-required（等待宿主审批）或仍有未决审批，
      // 绝不覆盖其状态 —— 维持 input-required，由宿主审批应答（continueTask）续跑/拒绝。
      const recNow = this.tasks.tryGet(id);
      if (recNow && (recNow.task.status.state === 'input-required' || recNow.pendingApproval)) {
        // K-N1：挂起也是一次终态回调（服务端据此落 delegation.complete:input-required）
        this.observe(() =>
          this.delegationObserver?.onGoalTerminal(id, goalWithTask, { state: 'input-required', result }),
        );
        return;
      }

      // ARCH-22 取消收口分支（顺序纪律 **O-2**）：handler 已返回但任务在此期间被宿主取消 ⇒
      // **不落 artifacts、不调 updateStatus**，只回调观测点。
      //   · 不落 artifacts：取消后的产物是把「既成事实」推给宿主（宿主 UI 已显示 canceled），
      //     与 sink.addArtifact 的终态守卫同一条红线，此处是它的**第二道闸**（handler 返回的
      //     result.artifacts 走的是另一条写入路径，不经 store 守卫的那次调用点之外的循环）。
      //   · 不调 updateStatus：canceled 已是终态，`TaskStore.updateStatus` 本就一律拒绝终态后
      //     的任何流转（含同态重写）—— 显式不调用是把「不覆盖取消原因」写成代码事实而非依赖巧合。
      //   · 只 observe：证据面（T4）据此落 `terminalState:'canceled'`，链上从此可证「何时被取消」。
      if (recNow && this.tasks.isCancelled(id)) {
        this.observe(() =>
          this.delegationObserver?.onGoalTerminal(id, goalWithTask, { state: 'canceled', result }),
        );
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
      // K-N1（纯附加）：终态观测点（completed / failed 均回调）
      this.observe(() =>
        this.delegationObserver?.onGoalTerminal(id, goalWithTask, {
          state: result.ok ? 'completed' : 'failed',
          result,
        }),
      );
    } catch (e) {
      this.logger.error('runGoal 异常', { taskId: id, error: String(e) });
      // ARCH-22：provider 按契约以「取消错」抛出退出（`makeError('TASK_CANCELED', …)` 或
      // AbortError）时**不误报 failed** —— 任务已是 canceled 终态，failed 会把宿主主动取消
      // 写成执行失败，取证面（O-3 的三分支）与链上 errorCode 都会跟着错。
      // 判后不改判：既不写 failed 终态（终态守卫本会拦），也只回调 canceled 一种快照。
      if (this.tasks.isCancelled(id)) {
        this.observe(() =>
          this.delegationObserver?.onGoalTerminal(id, goal, { state: 'canceled', error: e }),
        );
        return;
      }
      this.tasks.updateStatus(id, 'failed', errorMessage(id, e));
      // K-N1（纯附加）：异常路径同样回调终态（服务端据此落 delegation.complete:failed）
      this.observe(() =>
        this.delegationObserver?.onGoalTerminal(id, goal, { state: 'failed', error: e }),
      );
    }
  }

  /** K-N1：观测点统一护栏 —— 回调内任何异常只 warn，绝不影响 A2A 生命周期 */
  private observe(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.logger.warn('delegationObserver 回调异常（不影响委派）', { error: String(e) });
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

  /**
   * 错误 → JSON-RPC error 映射。
   *
   * P2-T7（L1，**纯附加**）：`TaskNotFoundError` 的 `data` 里带上 `evicted:true` —— 仅当该 id
   * 落在 TaskStore 的驱逐归因窗口内（`error.evicted`）。设计要区分的两种事实由此在协议面上可分：
   *  · 「从未存在的 id」⇒ `data` 逐字保持旧形状 `{code:'TaskNotFoundError'}`（键整体**缺席**，
   *    不是写 `evicted:false` —— 显式 false 会让旧客户端的深比对与既有 fixture 全红）；
   *  · 「已被有界化回收的 id」⇒ `data:{code:'TaskNotFoundError', evicted:true}`。
   * 错误码与 HTTP 侧形状一律不动（A2A 规范内 `TASK_NOT_FOUND` 仍是同一码），只加一个判别键。
   */
  private mapError(id: string | number | null, e: unknown): A2A.JsonRpcResponse {
    if (e instanceof TaskNotFoundError) {
      return this.fail(id, A2A.JSON_RPC_ERRORS.INVALID_PARAMS, e.message, {
        code: A2A.A2A_ERROR_CODES.TASK_NOT_FOUND,
        ...(e.evicted ? { evicted: true } : {}),
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

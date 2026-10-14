/**
 * A2A v1.0 Client —— 宿主机侧委派客户端
 *
 * 传输无关：只依赖 JsonRpcChannel（HTTP 或 stdio 均可），
 * 因此 SSH 隧道 / Streamable HTTP / 本地 stdio 三种传输共用同一套客户端。
 */

import { randomUUID } from 'node:crypto';

import { A2A, type RiskLevel } from '@winvm/contracts';
import type { JsonRpcChannel } from '@winvm/core';

let seq = 0;
function nextId(): string {
  seq += 1;
  return `a2a-${Date.now()}-${seq}`;
}

export interface SendMessageOptions {
  readonly contextId?: string;
  readonly taskId?: string;
  readonly metadata?: Record<string, unknown>;
  readonly blocking?: boolean;
  readonly historyLength?: number;
  /** 最小权限：本次委派允许的能力范围 */
  readonly allowedCapabilities?: readonly string[];
  /** 本次委派允许的最高风险 */
  readonly maxRisk?: RiskLevel;
  /**
   * 批1 F-3（**纯附加可选**）：`maxRisk` 的来源。`'agent'`=调用方显式声明；
   * `'host-default'`=宿主工具回退填充。VM 侧 `buildGoal` 据此区分声明与服务端默认，
   * 封顶闸只喂声明值（可用性断崖防线）。缺席=旧客户端，VM 侧按既有语义处理。
   */
  readonly maxRiskSource?: 'agent' | 'host-default';
  readonly traceId?: string;
  readonly timeoutMs?: number;
  /** 外部中断信号（与 timeoutMs 二选一或并用；caller 主动 abort 时立即终止流） */
  readonly signal?: AbortSignal;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export class A2AClientError extends Error {
  constructor(
    readonly code: string | number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'A2AClientError';
  }
}

export class A2AClient {
  constructor(private readonly channel: JsonRpcChannel) {}

  /** 单次 JSON-RPC 调用，自动解包 result / 抛 error */
  private async call(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    const res = await this.channel.request(
      { jsonrpc: '2.0', id: nextId(), method, params },
      ...(timeoutMs !== undefined ? [{ timeoutMs }] : []),
    );
    if (!isRecord(res)) throw new A2AClientError('INVALID_RESPONSE', '响应不是对象');
    if ('error' in res && isRecord(res['error'])) {
      const err = res['error'] as { code: number; message: string; data?: unknown };
      const dataCode = isRecord(err.data) && typeof err.data['code'] === 'string' ? err.data['code'] : undefined;
      throw new A2AClientError(dataCode ?? err.code, err.message, err.data);
    }
    if (!('result' in res)) throw new A2AClientError('INVALID_RESPONSE', '响应缺少 result');
    return res['result'];
  }

  /** 发现：拉取 Agent Card（仅 HTTP 传输可用；stdio 传输返回 undefined） */
  async getAgentCard(baseUrl?: string): Promise<A2A.AgentCard | undefined> {
    if (this.channel.kind !== 'http' || !baseUrl) return undefined;
    const url = `${baseUrl.replace(/\/+$/, '')}/.well-known/agent-card.json`;
    // 自愈超时：a2a.health 直接 fetch 无超时，VM 在线但无响应会永久挂起
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (!res.ok) throw new A2AClientError('AGENT_CARD_FETCH_FAILED', `HTTP ${res.status} from ${url}`);
      return (await res.json()) as A2A.AgentCard;
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        throw new A2AClientError('AGENT_CARD_FETCH_TIMEOUT', `拉取 Agent Card 超时（15000ms）：${url}`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 提交目标（message/send） */
  async sendMessage(text: string, opts: SendMessageOptions = {}): Promise<A2A.Task> {
    const message: A2A.Message = {
      kind: 'message',
      role: 'user',
      messageId: randomUUID(),
      parts: [{ kind: 'text', text }],
      ...(opts.contextId ? { contextId: opts.contextId } : {}),
      ...(opts.taskId ? { taskId: opts.taskId } : {}),
    };

    const metadata: Record<string, unknown> = {
      traceId: opts.traceId ?? `tr_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      ...(opts.allowedCapabilities ? { allowedCapabilities: opts.allowedCapabilities } : {}),
      ...(opts.maxRisk ? { maxRisk: opts.maxRisk } : {}),
      ...(opts.maxRiskSource ? { maxRiskSource: opts.maxRiskSource } : {}),
      ...(opts.metadata ?? {}),
    };

    const params: Record<string, unknown> = {
      message,
      metadata,
      configuration: {
        blocking: opts.blocking ?? false,
        ...(opts.historyLength !== undefined ? { historyLength: opts.historyLength } : {}),
      },
    };

    const result = await this.call('message/send', params, opts.timeoutMs);
    return result as A2A.Task;
  }

  /** 流式委派（message/stream，SSE） */
  async *streamMessage(
    text: string,
    opts: SendMessageOptions = {},
  ): AsyncIterable<A2A.A2AStreamEvent> {
    if (!this.channel.stream) {
      throw new A2AClientError('STREAM_UNSUPPORTED', '当前传输不支持流式');
    }
    const message: A2A.Message = {
      kind: 'message',
      role: 'user',
      messageId: randomUUID(),
      parts: [{ kind: 'text', text }],
      ...(opts.contextId ? { contextId: opts.contextId } : {}),
    };
    const params: Record<string, unknown> = {
      message,
      metadata: {
        traceId: opts.traceId ?? `tr_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
        ...(opts.allowedCapabilities ? { allowedCapabilities: opts.allowedCapabilities } : {}),
        ...(opts.maxRisk ? { maxRisk: opts.maxRisk } : {}),
        ...(opts.maxRiskSource ? { maxRiskSource: opts.maxRiskSource } : {}),
        ...(opts.metadata ?? {}),
      },
    };

    for await (const raw of this.channel.stream(
      { jsonrpc: '2.0', id: nextId(), method: 'message/stream', params },
      { timeoutMs: opts.timeoutMs, signal: opts.signal },
    )) {
      if (!isRecord(raw)) continue;
      if ('result' in raw && isRecord(raw['result'])) {
        yield raw['result'] as unknown as A2A.A2AStreamEvent;
      } else if (raw['kind'] === 'status-update' || raw['kind'] === 'artifact-update') {
        yield raw as unknown as A2A.A2AStreamEvent;
      }
    }
  }

  /** 查询任务（tasks/get） */
  async getTask(taskId: string, historyLength?: number): Promise<A2A.Task> {
    const params: Record<string, unknown> = { name: `tasks/${taskId}` };
    if (historyLength !== undefined) params['historyLength'] = historyLength;
    return (await this.call('tasks/get', params)) as A2A.Task;
  }

  /** 列出任务（tasks/list，游标分页） */
  async listTasks(filter: A2A.ListTasksParams = {}): Promise<{
    tasks: readonly A2A.Task[];
    nextPageToken: string;
    totalSize: number;
  }> {
    const params: Record<string, unknown> = { ...filter };
    return (await this.call('tasks/list', params)) as {
      tasks: readonly A2A.Task[];
      nextPageToken: string;
      totalSize: number;
    };
  }

  /** 取消任务（tasks/cancel） */
  async cancelTask(taskId: string): Promise<A2A.Task> {
    return (await this.call('tasks/cancel', { name: `tasks/${taskId}` })) as A2A.Task;
  }

  /** 应答审批闸：对处于 input-required 的任务回复批准/拒绝 */
  async replyApproval(
    taskId: string,
    approvalId: string,
    approved: boolean,
    opts: { traceId?: string; contextId?: string } = {},
  ): Promise<A2A.Task> {
    const message: A2A.Message = {
      kind: 'message',
      role: 'user',
      messageId: randomUUID(),
      taskId,
      parts: [{ kind: 'data', data: { approvalId, approved } }],
      ...(opts.contextId ? { contextId: opts.contextId } : {}),
    };
    const result = await this.call('message/send', {
      message,
      metadata: { traceId: opts.traceId ?? `tr_${randomUUID().replace(/-/g, '').slice(0, 20)}` },
    });
    return result as A2A.Task;
  }

  async close(): Promise<void> {
    await this.channel.close();
  }
}

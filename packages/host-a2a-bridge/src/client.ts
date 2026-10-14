/**
 * A2A 委派客户端抽象
 *
 * 宿主 Agent（WorkBuddy）只具备 MCP client 能力，不直接说 A2A。
 * 本包以「本地 stdio MCP server」形态补齐这一跳：
 *   宿主 --MCP--> 本桥 --A2A--> VM 侧 vm-service /a2a
 *
 * 传输无关：SSH 隧道 / Streamable HTTP 共用 core 的 establishTransport，
 * 仅把 path 从 /mcp 换成 /a2a 即可复用同一条隧道。
 */

import { A2AClient } from '@winvm/a2a-framework';
import { establishTransport, type ManagedTransport } from '@winvm/core';
import { A2A, type RiskLevel, type TransportDecl } from '@winvm/contracts';

export interface DelegateStreamOptions {
  readonly contextId?: string;
  readonly taskId?: string;
  readonly allowedCapabilities?: readonly string[];
  readonly maxRisk?: RiskLevel;
  /** 批1 F-3：maxRisk 的来源（'agent'=显式声明 / 'host-default'=回退填充），透传 VM 侧判源 */
  readonly maxRiskSource?: 'agent' | 'host-default';
  readonly traceId?: string;
  readonly timeoutMs?: number;
}

/**
 * 委派桥所需的 A2A 客户端最小面。
 * A2AClient 结构上完全满足，测试时可注入 mock 而不碰网络。
 */
export interface A2aDelegateClient {
  streamMessage(text: string, opts?: DelegateStreamOptions): AsyncIterable<A2A.A2AStreamEvent>;
  getTask(taskId: string, historyLength?: number): Promise<A2A.Task>;
  replyApproval(
    taskId: string,
    approvalId: string,
    approved: boolean,
    opts?: { traceId?: string; contextId?: string },
  ): Promise<A2A.Task>;
  cancelTask(taskId: string): Promise<A2A.Task>;
  getAgentCard(baseUrl?: string): Promise<A2A.AgentCard | undefined>;
  close(): Promise<void>;
}

export interface A2aClientHandle {
  readonly client: A2aDelegateClient;
  readonly transport: ManagedTransport;
  close(): Promise<void>;
}

export interface CreateA2aClientOptions {
  readonly transport: TransportDecl;
  /** A2A 端点路径，默认 /a2a */
  readonly a2aPath?: string;
  readonly timeoutMs?: number;
  /** 隧道 stderr 回调（便于把 ssh 报错透出到宿主侧日志） */
  readonly onTunnelStderr?: (chunk: string) => void;
}

/** 建立到 VM 侧 A2A 服务的客户端（同一条 SSH 隧道承载，与 MCP 通道并存） */
export async function createA2aClient(opts: CreateA2aClientOptions): Promise<A2aClientHandle> {
  const transport = await establishTransport(opts.transport, {
    path: opts.a2aPath ?? '/a2a',
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.onTunnelStderr ? { onTunnelStderr: opts.onTunnelStderr } : {}),
  });
  const client: A2aDelegateClient = new A2AClient(transport.channel);
  return {
    client,
    transport,
    async close() {
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
    },
  };
}

/**
 * 懒连接 + 复用的客户端提供者。
 * 桥启动时不连 VM（隧道可能尚未建立），首次调用工具时才建连，失败则丢弃缓存以便重试。
 */
export function createLazyClientProvider(
  opts: CreateA2aClientOptions,
): { get(): Promise<A2aDelegateClient>; close(): Promise<void> } {
  let handle: A2aClientHandle | undefined;
  let pending: Promise<A2aClientHandle> | undefined;

  const ensure = (): Promise<A2aClientHandle> => {
    if (handle) return Promise.resolve(handle);
    if (pending) return pending;
    pending = createA2aClient(opts).then(
      (h) => {
        handle = h;
        pending = undefined;
        return h;
      },
      (e) => {
        pending = undefined;
        throw e;
      },
    );
    return pending;
  };

  return {
    async get() {
      return (await ensure()).client;
    },
    async close() {
      if (handle) await handle.close();
      handle = undefined;
      pending = undefined;
    },
  };
}

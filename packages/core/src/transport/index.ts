/**
 * 传输工厂：把 TransportDecl 归一为可通信的 TransportHandle。
 * 上层（MCP / A2A 客户端）只依赖 TransportHandle，切换传输零改动。
 */

import type { TransportDecl } from '@winvm/contracts';

import { HttpJsonRpcChannel } from './http-channel.js';
import { type TunnelHandle, establishSshTunnel } from './ssh-tunnel.js';
import { StdioJsonRpcChannel } from './stdio-channel.js';
import { type JsonRpcChannel, type TransportHandle, TransportError } from './types.js';

export * from './types.js';
export { HttpJsonRpcChannel } from './http-channel.js';
export { StdioJsonRpcChannel } from './stdio-channel.js';
export { establishSshTunnel, renderSshCommand } from './ssh-tunnel.js';
export { parseSseChunk } from './http-channel.js';

export interface EstablishOptions {
  /** RPC 路径：MCP 用 /mcp，A2A 用 /a2a */
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly readyTimeoutMs?: number;
  readonly onTunnelStderr?: (chunk: string) => void;
  /** 复用已建立的隧道（避免同一 VM 重复建隧道） */
  readonly existingTunnel?: TunnelHandle;
}

export interface ManagedTransport extends TransportHandle {
  /** 若本传输自建了隧道，此处可访问；复用外部隧道时为 undefined */
  readonly tunnel?: TunnelHandle;
}

/**
 * 建立传输。
 * - ssh-tunnel：先建隧道（或复用已有隧道），再在其上开 HTTP 通道
 * - streamable-http：直接开 HTTP 通道（token 从环境变量取，禁止明文）
 * - stdio：起子进程，走 NDJSON 通道
 */
export async function establishTransport(
  decl: TransportDecl,
  opts: EstablishOptions,
): Promise<ManagedTransport> {
  switch (decl.kind) {
    case 'ssh-tunnel': {
      const tunnel =
        opts.existingTunnel ??
        (await establishSshTunnel({
          cfg: decl,
          ...(opts.readyTimeoutMs !== undefined ? { readyTimeoutMs: opts.readyTimeoutMs } : {}),
          ...(opts.onTunnelStderr ? { onStderr: opts.onTunnelStderr } : {}),
        }));
      const channel = new HttpJsonRpcChannel({
        baseUrl: tunnel.baseUrl,
        path: opts.path,
        ...(opts.headers ? { headers: opts.headers } : {}),
        ...(opts.timeoutMs !== undefined ? { defaultTimeoutMs: opts.timeoutMs } : {}),
      });
      return {
        kind: 'http' as const,
        baseUrl: tunnel.baseUrl,
        channel,
        ...(opts.existingTunnel ? {} : { tunnel }),
        async close() {
          await channel.close();
          if (!opts.existingTunnel) await tunnel.close();
        },
      };
    }

    case 'streamable-http': {
      const token = decl.tokenEnv ? process.env[decl.tokenEnv] : undefined;
      if (decl.tokenEnv && !token) {
        throw new TransportError(
          `未找到 bearer token 环境变量：${decl.tokenEnv}（禁止明文配置，需由宿主注入）`,
        );
      }
      const headers: Record<string, string> = { ...(opts.headers ?? {}) };
      if (token) headers['authorization'] = `Bearer ${token}`;

      const channel = new HttpJsonRpcChannel({
        baseUrl: decl.url,
        path: opts.path,
        headers,
        ...(opts.timeoutMs ?? decl.timeoutMs ? { defaultTimeoutMs: opts.timeoutMs ?? decl.timeoutMs ?? 30_000 } : {}),
      });
      return {
        kind: 'http' as const,
        baseUrl: decl.url,
        channel,
        close: () => channel.close(),
      };
    }

    case 'stdio': {
      const channel = new StdioJsonRpcChannel({
        command: decl.command,
        args: decl.args,
        ...(decl.env ? { env: decl.env } : {}),
        ...(opts.timeoutMs !== undefined ? { defaultTimeoutMs: opts.timeoutMs } : {}),
      });
      return { kind: 'stdio' as const, channel, close: () => channel.close() };
    }
  }
}

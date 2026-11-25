/**
 * 传输工厂：把 TransportDecl 归一为可通信的 TransportHandle。
 * 上层（MCP / A2A 客户端）只依赖 TransportHandle，切换传输零改动。
 */

import type { TransportDecl } from '@winvm/contracts';

import { HttpJsonRpcChannel } from './http-channel.js';
import { StdioJsonRpcChannel } from './stdio-channel.js';
import { type JsonRpcChannel, type TransportHandle, TransportError } from './types.js';

export * from './types.js';
export { HttpJsonRpcChannel } from './http-channel.js';
export { StdioJsonRpcChannel } from './stdio-channel.js';
export { parseSseChunk } from './http-channel.js';

export interface EstablishOptions {
  /** RPC 路径：MCP 用 /mcp，A2A 用 /a2a */
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly readyTimeoutMs?: number;
  readonly onTunnelStderr?: (chunk: string) => void;
}

/** 由本模块建立、需要显式 close 的传输句柄（`baseUrl` 仅 http 传输有）。 */
export type ManagedTransport = TransportHandle;

/**
 * ENG-23：把 bearer 凭据落到请求头上。
 *
 * 三态（与 `contracts/src/transport.ts` 的 `tokenEnv` 注释逐字对齐）：
 * 1. **未配置** ⇒ 不发 `authorization` 头 ⇒ 现网部署零变化（信任边界仍由回环 + SSH 隧道承担）；
 * 2. **配置了且 env 有值** ⇒ 带 `authorization: Bearer <token>`；
 * 3. **配置了但 env 无值** ⇒ **抛 `TransportError`**（fail-loud）。绝不静默降级成裸请求 ——
 *    静默会让运维「以为鉴权开了」。
 *
 * `env` 为可选注入位（默认 `process.env`），供离线单测覆盖三态；生产调用点不传。
 * 返回**新对象**，不改调用方传入的 headers（`EstablishOptions.headers` 是 readonly）。
 */
export function applyBearerHeader(
  headers: Readonly<Record<string, string>> | undefined,
  tokenEnv: string | undefined,
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const out: Record<string, string> = { ...(headers ?? {}) };
  if (!tokenEnv) return out;
  const token = env[tokenEnv];
  if (!token) {
    throw new TransportError(
      `未找到 bearer token 环境变量：${tokenEnv}（禁止明文配置，需由宿主注入）`,
    );
  }
  out['authorization'] = `Bearer ${token}`;
  return out;
}

/**
 * 建立传输。
 * - streamable-http：直接开 HTTP 通道（token 从环境变量取，禁止明文）
 * - stdio：起子进程，走 NDJSON 通道
 *
 * V-NEXT：`ssh-tunnel` 分支已删。隧道由宿主侧常驻 `oh-tunnel.mjs` 承担并映射到本地回环端口，
 * 上层一律用 `streamable-http` 指向该端口 —— 传输层不再自己建 SSH 连接。
 */
export async function establishTransport(
  decl: TransportDecl,
  opts: EstablishOptions,
): Promise<ManagedTransport> {
  switch (decl.kind) {
    case 'streamable-http': {
      // ENG-23：原内联逻辑抽出为 `applyBearerHeader`（行为逐字不变：无 tokenEnv ⇒ 不加头；
      // 有名无值 ⇒ 抛同一句 TransportError）。
      const headers = applyBearerHeader(opts.headers, decl.tokenEnv);

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

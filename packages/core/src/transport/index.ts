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
 * ENG-23：把 bearer 凭据落到请求头上 —— **两条远程传输分支的唯一实现**。
 *
 * 为什么抽成函数（病灶）：`authorization` 头的拼装此前只写在 `streamable-http` 分支里，
 * `ssh-tunnel` 分支**完全不消费** `tokenEnv`。服务端一旦启用 `enforceBearer`（ARCH-07 A 形态），
 * 走隧道的宿主委派会**当场 401**，而配置面上两条传输声明的是同一个 `tokenEnv` 字段 ——
 * 「配了却不生效」与「配了却漏发凭据」是同一份语义被写两遍必然漂移的结果。
 * 两条分支现在共用本函数，凭据语义只有一处定义。
 *
 * 三态（与 `contracts/src/transport.ts` 的 `tokenEnv` 注释逐字对齐）：
 * 1. **未配置** ⇒ 不发 `authorization` 头 ⇒ 现网部署零变化（信任边界仍由回环 + SSH 隧道承担）；
 * 2. **配置了且 env 有值** ⇒ 带 `authorization: Bearer <token>`；
 * 3. **配置了但 env 无值** ⇒ **抛 `TransportError`**（fail-loud）。绝不静默降级成裸请求 ——
 *    静默会让运维「以为鉴权开了」。该抛错语义自 Phase 0 起就在 `streamable-http` 分支存在，
 *    本函数是把它**原样**搬出，不是新造行为。
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
      // ENG-23：隧道只是**传输通道**，服务端是否要求 bearer 与走哪条通道无关 ⇒ 这条分支
      // 同样必须消费 `decl.tokenEnv`（三态语义见 `applyBearerHeader`）。
      //
      // 校验**前置**到建隧道之前：`tokenEnv` 有名无值是要抛的（态 3），若放在
      // `establishSshTunnel` 之后才抛，隧道子进程已经起来却被调用方拿到异常，
      // `close()` 永远不会执行 ⇒ 泄漏一条 SSH 隧道。fail-loud 必须「loud 得干净」。
      const headers = applyBearerHeader(opts.headers, decl.tokenEnv);
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
        headers,
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

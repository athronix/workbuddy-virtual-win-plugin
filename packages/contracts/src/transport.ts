/**
 * 传输声明（ARCHITECTURE.md §5）
 *
 * 三种传输对上层完全透明，切换传输不改任何业务代码。
 */

/** 默认本地转发端口（宿主侧）；VM 侧服务仅监听 127.0.0.1。 */
export const DEFAULT_LOCAL_PORT = 18443;
export const DEFAULT_REMOTE_PORT = 18443;

export interface SshTunnelTransport {
  readonly kind: 'ssh-tunnel';
  readonly host: string;
  readonly user: string;
  readonly remotePort: number;
  readonly localPort: number;
  readonly port?: number;
  readonly identityFile?: string;
  /**
   * 进程内 ssh2 后端（OH 宿主 / WINVM_TUNNEL_BACKEND=ssh2）使用的凭据。
   * 系统 ssh 分支（spawn('ssh')）会忽略这两个字段——它依赖本机 ssh agent / identityFile。
   * 三者至少其一即可：privateKey | identityFile | password。
   */
  readonly privateKey?: string;
  readonly password?: string;
  /** 隧道保活参数 */
  readonly serverAliveInterval?: number;
  readonly serverAliveCountMax?: number;
  /**
   * ENG-23（**纯附加可选**）：经本隧道访问服务端 HTTP 端点时携带的 bearer token 的
   * **环境变量名**（禁止明文落盘，NFR-511），与 `StreamableHttpTransport.tokenEnv` 同名同义、
   * 默认约定同一变量（`WINVM_BEARER_TOKEN`）。
   *
   * 为什么需要（病灶）：`ssh-tunnel` 分支过去**完全不消费** tokenEnv（只有
   * `streamable-http` 分支拼 `authorization` 头），于是服务端一旦启用 `enforceBearer`
   * （ARCH-07 A 形态），走隧道的宿主委派会**当场 401**。本字段把客户端凭据通路补齐，
   * 使「配置即生效」在两条远程传输分支上一键可用；两条分支必须复用**同一个**
   * `applyBearerHeader` 实现（`core/src/transport/index.ts`），不得各写一份导致语义漂移。
   *
   * 语义（缺席即旧行为）：
   * - 未配置 ⇒ **不发** `authorization` 头（现网部署零变化：信任边界 = 回环 + SSH 隧道）；
   * - 配置了且环境有值 ⇒ 每次请求带 `authorization: Bearer <token>`；
   * - 配置了但**环境无值** ⇒ **抛错**（fail-loud，与 `streamable-http` 分支既有语义一致，
   *   绝不静默降级成裸请求 —— 静默会让运维「以为开了」）。
   */
  readonly tokenEnv?: string;
}

export interface StreamableHttpTransport {
  readonly kind: 'streamable-http';
  readonly url: string;
  /**
   * token 的环境变量名（禁止明文落盘，NFR-511）。
   * 可选：**回环地址**（经 SSH 隧道映射到本机的 127.0.0.1）无需 bearer token，
   * 因为 VM 侧服务本身只监听 127.0.0.1 且不对外暴露；直连非回环地址时必须指定。
   */
  readonly tokenEnv?: string;
  readonly timeoutMs?: number;
}

export interface StdioTransport {
  readonly kind: 'stdio';
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

export type TransportDecl = SshTunnelTransport | StreamableHttpTransport | StdioTransport;

export type TransportKind = TransportDecl['kind'];

/** 传输建立后对外暴露的可连接基址（本地回环） */
export function transportBaseUrl(t: TransportDecl): string {
  switch (t.kind) {
    case 'ssh-tunnel':
      return `http://127.0.0.1:${t.localPort}`;
    case 'streamable-http':
      return t.url.replace(/\/+$/, '');
    case 'stdio':
      throw new Error('stdio transport has no HTTP base url');
  }
}

export function isRemoteTransport(t: TransportDecl): t is SshTunnelTransport | StreamableHttpTransport {
  return t.kind !== 'stdio';
}

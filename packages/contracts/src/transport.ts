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

/**
 * 传输声明（ARCHITECTURE.md §5）
 *
 * 两种传输对上层完全透明，切换传输不改任何业务代码。
 *
 * V-NEXT（2026-11-23）删除 `ssh-tunnel` 声明形态：隧道由宿主侧常驻 `delivery/oh-tunnel.mjs`
 * 承载并只暴露**本地回环端口**，连接器一律以 `streamable-http` 指向 `http://127.0.0.1:<port>`
 * 即可 —— 「ssh」是隧道的实现细节，不该成为传输声明的一等公民（它把 host/user/privateKey/
 * password 五个凭据字段漏进了纯数据契约里，而真正消费它们的代码在生产路径上永不执行）。
 */

/** 默认本地转发端口（宿主侧）；VM 侧服务仅监听 127.0.0.1。 */
export const DEFAULT_LOCAL_PORT = 18443;
export const DEFAULT_REMOTE_PORT = 18443;

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

export type TransportDecl = StreamableHttpTransport | StdioTransport;

export type TransportKind = TransportDecl['kind'];
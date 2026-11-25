/**
 * MCP 上游代理 —— 把 VM 内的**第三方 stdio MCP server** 转成 vm-service 的 HTTP 工具面。
 *
 * 背景（2026-11-17 真机 POC 定谳）：
 *   `agent-browser`（Vercel Labs，33 工具）与 `agent-desktop`（75 工具，无障碍树驱动桌面）
 *   都是 **stdio** MCP server，宿主无法直连；而 vm-service 已经在 SSH 隧道后面提供
 *   `POST /mcp`。本模块把前者的工具面「挂」到后者上（`/mcp/browser`、`/mcp/desktop`），
 *   宿主侧只是多两个 connector 条目，隧道与守卫代码零改动。
 *
 * 为什么由 vm-service 代理，而不是在 VM 里单独起进程：
 *   1. **会话继承**：vm-service 跑在 Session 1（InteractiveToken 计划任务），它 spawn 的
 *      上游子进程**继承交互式会话** ⇒ agent-desktop 能读到真实桌面。SSH 直启只能拿到
 *      Session 0 的空桌面（`desktop_list_apps` 返回 `apps: []`），这是本设计的决定性动机。
 *   2. **安全面复用**：`/mcp/browser`、`/mcp/desktop` 不在 `http-guard` 的硬编码豁免表里，
 *      默认 fail-closed 受同一套鉴权保护，无需新增守卫。
 *
 * 分工（分层铁律）：
 *   - `@winvm/core` 的 `StdioJsonRpcChannel`：只管 NDJSON 收发与子进程生命周期；
 *   - `@winvm/mcp-framework` 的 `McpClient`：只管 tools/list、tools/call 协议；
 *   - 本模块：只管「懒启动 + 工具缓存 + 白名单过滤 + 崩溃后重建 + 优雅关闭」。
 */

import { McpClient, type McpCallResult, type McpToolInfo } from '@winvm/mcp-framework';
import { StdioJsonRpcChannel, type StdioChannelOptions } from '@winvm/core';
// V-NEXT 阶段 2.4（方案 A）：白名单常量已下沉到 vm-capabilities（本包已依赖它，反向 import 会成环）。
// 这里既 import 又 re-export：`export ... from` 只转发、**不建本地绑定**，
// 而下方 `defaultUpstreamSpecs()` 要用到该值，所以两件事都得写。
import { DEFAULT_DESKTOP_TOOL_ALLOWLIST } from '@winvm/vm-capabilities';

/** 一个上游 stdio MCP server 的声明。 */
export interface UpstreamSpec {
  /** 路由后缀与日志标识：`/mcp/<id>` */
  readonly id: string;
  /** 人读名称（/health 与错误信息用） */
  readonly label: string;
  /** 可执行文件名（Windows 上是 `.cmd` 批处理，见 `buildChannelOptions` 的包裹说明） */
  readonly command: string;
  readonly args: readonly string[];
  /**
   * 工具白名单。`undefined` = 全量暴露；数组 = 只暴露其中列出的工具名。
   *
   * agent-desktop 的 75 个工具能读整个桌面（含剪贴板、截图）并操作任意窗口，
   * 全量暴露等于把 VM 桌面完整交给宿主 LLM。默认只放高频子集，其余由宿主侧
   * `disabledTools` 反向放开（或在此追加）。
   */
  readonly toolAllowlist?: readonly string[];
  /** 单次 `tools/call` 的超时（毫秒）。桌面快照可能 8~10s，浏览器首启 12s+。 */
  readonly callTimeoutMs: number;
  /** 启动 + tools/list 的预算（毫秒）。 */
  readonly startTimeoutMs: number;
}

/** `/health.upstreams[]` 的一条观测。 */
export interface UpstreamStatus {
  readonly id: string;
  readonly label: string;
  readonly state: 'idle' | 'starting' | 'ready' | 'error';
  readonly tools?: number;
  readonly exposed?: number;
  readonly pid?: number;
  readonly restarts?: number;
  readonly lastError?: string;
}

/**
 * agent-desktop 默认暴露的高频子集（25 个，四组闭环）。
 *
 * ## ⚠ 本常量已**下沉**到 `@winvm/vm-capabilities`（V-NEXT 阶段 2.4，owner 2026-11-24 裁定方案 A）
 *
 * 原先定义在本文件，但统一能力表（`vm-capabilities/src/registry/unified.ts`）要给 desktop 面
 * 补 25 条带 `risk` 的条目，就必须读这份白名单 —— 而本包 `package.json` **已经依赖**
 * `@winvm/vm-capabilities`，反向 import 会**成环**，dep-lint 必拦。
 *
 * 所以「下沉」而非「复制」：白名单是**可达面**的唯一事实源，统一表是同一份事实的投影。
 * 复制两份的代价不是多写 25 行，而是「加白名单忘了加统一表」⇒ 审批闸对该工具
 * **静默无规则（fail-open）**。
 *
 * 本处改为 **re-export**，保持既有 import（含 `tests/unit/mcp-upstream-connectors.test.js`
 * 从 `dist/mcp-upstream.js` 取该常量的写法）逐字不变 —— 那是本仓库的对外形状，
 * 下沉不该让调用方跟着改 import 路径。
 *
 * 分组构成、为什么是 25 而不是 75、以及「仍不默认暴露哪些」的完整说明，
 * 见 `vm-capabilities/src/registry/upstream-tools.ts` 的常量注释（单一出处）。
 */
export { DEFAULT_DESKTOP_TOOL_ALLOWLIST } from '@winvm/vm-capabilities';

/** 默认上游清单（与 `delivery/vm-service.config.json` 的说明保持同步）。 */
export function defaultUpstreamSpecs(): readonly UpstreamSpec[] {
  return [
    {
      id: 'browser',
      label: 'agent-browser',
      command: 'agent-browser.cmd',
      args: ['mcp'],
      callTimeoutMs: 120_000,
      startTimeoutMs: 25_000,
    },
    {
      id: 'desktop',
      label: 'agent-desktop',
      command: 'agent-desktop.cmd',
      args: ['mcp'],
      toolAllowlist: DEFAULT_DESKTOP_TOOL_ALLOWLIST,
      callTimeoutMs: 90_000,
      startTimeoutMs: 25_000,
    },
  ];
}

/**
 * 构造 stdio 通道参数。
 *
 * ⚠ Windows 必须经 `cmd.exe /c` 包裹：npm 全局安装产出的是 `agent-desktop.cmd` 批处理，
 * 而 `StdioJsonRpcChannel` 用的是**无 shell 的 spawn**（教训 A8：win32 下 spawn 批处理
 * 直接 ENOENT）。POC 已验证 `cmd /c agent-desktop.cmd mcp` 形态可正常握手（527ms / 75 工具）。
 */
export function buildChannelOptions(spec: UpstreamSpec, platform: NodeJS.Platform = process.platform): StdioChannelOptions {
  const isWin = platform === 'win32';
  return {
    command: isWin ? 'cmd.exe' : spec.command,
    args: isWin ? ['/c', spec.command, ...spec.args] : [...spec.args],
    // 默认超时略大于单次调用预算：真正的单调用预算由 McpClient.callTool 逐次传入，
    // 这里的默认值只兜「协议层无响应」的极端情况。
    defaultTimeoutMs: spec.callTimeoutMs + 15_000,
  };
}

/**
 * 单个上游 stdio MCP server 的代理。
 *
 * 生命周期：`idle` →（首次请求）`starting` → `ready`；子进程崩溃或调用失败时回到
 * `idle` 并记录 `lastError`，下一个请求自动重建（不主动重试，避免上游缺失时刷屏）。
 */
export class McpUpstream {
  private client: McpClient | null = null;
  private channel: StdioJsonRpcChannel | null = null;
  private tools: McpToolInfo[] = [];
  private startPromise: Promise<McpToolInfo[]> | null = null;
  private state: UpstreamStatus['state'] = 'idle';
  private lastError: string | undefined;
  private restarts = 0;
  private stderrTail = '';

  constructor(
    readonly spec: UpstreamSpec,
    private readonly log: (msg: string) => void = () => undefined,
  ) {}

  /** 已就绪则直接返回缓存的工具表；否则拉起子进程并 `tools/list`。 */
  async ensureReady(): Promise<McpToolInfo[]> {
    if (this.state === 'ready') return this.exposedTools();
    if (this.startPromise) return this.startPromise;

    this.state = 'starting';
    this.startPromise = this.start()
      .then((tools) => {
        this.tools = tools;
        this.state = 'ready';
        this.lastError = undefined;
        this.log(`${this.spec.id} 上游就绪：${tools.length} 个工具（暴露 ${this.exposedTools().length}）`);
        return this.exposedTools();
      })
      .catch((e: unknown) => {
        this.state = 'error';
        this.lastError = (e as Error)?.message ?? String(e);
        this.log(`${this.spec.id} 上游启动失败：${this.lastError}`);
        throw e;
      })
      .finally(() => {
        this.startPromise = null;
      });
    return this.startPromise;
  }

  private async start(): Promise<McpToolInfo[]> {
    await this.dispose();
    const channel = new StdioJsonRpcChannel({
      ...buildChannelOptions(this.spec),
      onStderr: (chunk: string) => {
        this.stderrTail = (this.stderrTail + chunk).slice(-2048);
      },
    });
    this.channel = channel;
    const client = new McpClient(channel);
    this.client = client;

    const listed = await withTimeout(client.listTools(), this.spec.startTimeoutMs, `${this.spec.id} tools/list 超时`);
    if (listed.length === 0) throw new Error(`${this.spec.label} 未返回任何工具`);
    return listed;
  }

  private exposedTools(): McpToolInfo[] {
    const allow = this.spec.toolAllowlist;
    if (!allow) return this.tools;
    const set = new Set(allow);
    return this.tools.filter((t) => set.has(t.name));
  }

  /** 转发一次 `tools/call`。失败即判定上游已坏，标记待重建。 */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const exposed = this.exposedTools();
    if (!exposed.some((t) => t.name === name)) {
      // 白名单外的工具：明确拒绝而不是静默代理 —— 「看起来能用但被拦」比「根本不存在」更难排查。
      throw new Error(`工具 ${name} 未在本上游的暴露清单内（${this.spec.id}）`);
    }
    if (!this.client) await this.ensureReady();
    const client = this.client;
    if (!client) throw new Error(`${this.spec.id} 上游不可用`);

    try {
      return await client.callTool(name, args, { timeoutMs: this.spec.callTimeoutMs });
    } catch (e) {
      this.state = 'idle';
      this.lastError = `${(e as Error)?.message ?? String(e)}${this.stderrTail ? ` | stderr: ${this.stderrTail.slice(-300)}` : ''}`;
      this.restarts += 1;
      await this.dispose();
      throw e;
    }
  }

  /** 关闭子进程并复位（幂等；不重置 restarts 计数，它是累计观测）。 */
  async dispose(): Promise<void> {
    const channel = this.channel;
    this.channel = null;
    this.client = null;
    this.tools = [];
    if (this.state === 'ready') this.state = 'idle';
    if (!channel) return;
    try {
      await channel.close();
    } catch {
      /* 关闭失败不影响重建 */
    }
  }

  status(): UpstreamStatus {
    return {
      id: this.spec.id,
      label: this.spec.label,
      state: this.state,
      ...(this.state === 'ready' ? { tools: this.tools.length, exposed: this.exposedTools().length } : {}),
      ...(this.restarts > 0 ? { restarts: this.restarts } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }
}

/** 带超时的 Promise 包装（上游卡死时不能拖住整个 HTTP 请求）。 */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** 上游注册表：`/mcp/<id>` 按 id 查 → 代理（懒启动）。 */
export class UpstreamRegistry {
  private readonly map = new Map<string, McpUpstream>();

  constructor(specs: readonly UpstreamSpec[], log?: (msg: string) => void) {
    for (const s of specs) this.map.set(s.id, new McpUpstream(s, log));
  }

  get(id: string): McpUpstream | undefined {
    return this.map.get(id);
  }

  ids(): string[] {
    return [...this.map.keys()];
  }

  statuses(): UpstreamStatus[] {
    return [...this.map.values()].map((u) => u.status());
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.map.values()].map((u) => u.dispose()));
  }
}

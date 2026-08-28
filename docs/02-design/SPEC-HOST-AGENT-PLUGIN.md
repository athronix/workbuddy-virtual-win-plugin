# 宿主机 Agent 插件规范（SPEC-HOST-AGENT-PLUGIN）

| 项 | 值 |
|---|---|
| 文档 ID | SPEC-HOST-AGENT-PLUGIN-v1 |
| 版本 | v1.0 |
| 层 | L0 规范（契约）+ L1c SDK（`packages/host-sdk`）+ L2 渲染器（`packages/adapter-host-*`） |
| 对应用户要求 | **RQ-5**：宿主机 Agent 的插件规范以插件框架规范形式与整体解耦，便于后续为更多类型宿主 Agent 提供适配插件 |
| 日期 | 2026-08-28 |

---

## 1. 目标

定义一套**与宿主 Agent 无关**的中性插件模型（Neutral Plugin Model），并规定"渲染器（Renderer）"契约，使得：

- **V1**：渲染到 **WorkBuddy**（`adapter-host-workbuddy`）
- **后续**：渲染到 Claude Code / Cursor / Codex / 任意宿主 —— 只需**新增一个 Renderer**
- **不受影响**：`skills/` 源、`core` / `mcp-framework` / `a2a-framework` / `vm-service` —— **全部零改动**

---

## 2. 核心抽象

```
     skills/（中性源，与宿主无关）
     packages/vm-service（能力面）
              │
              ▼
   ┌────────────────────────────┐
   │  NeutralPlugin（中性模型）  │   ← host-sdk 定义
   │  manifest / skills /       │
   │  connector / lifecycle     │
   └─────────────┬──────────────┘
                 │  Renderer 渲染
     ┌───────────┼───────────────┬──────────────┐
     ▼           ▼               ▼              ▼
 WorkBuddy    Claude Code     Cursor        <其他宿主>
 (V1 实现)    （未来）        （未来）       （未来）
```

---

## 3. 中性插件模型

```ts
export interface NeutralPlugin {
  /** 插件元信息 */
  manifest: PluginManifest;
  /** Skill 包（1+5 = 1 总控 + 5 领域，含应用生产操作 appops） */
  skills: SkillBundle[];
  /** 连接器声明（通道、传输、工具白黑名单） */
  connector: ConnectorDecl;
  /** 生命周期钩子（可选） */
  lifecycle?: LifecycleHooks;
  /** 宿主特定的补充渲染提示（可选，尽量避免使用） */
  hints?: Record<string, unknown>;
}

export interface PluginManifest {
  name: string;              // "winvm-bridge"
  version: string;           // semver
  description: string;
  author: { name: string; email?: string };
  keywords: string[];
  homepage?: string;
  license?: string;
}

export interface SkillBundle {
  /** Skill 标识，如 "winvm-orchestrator" */
  id: string;
  /** 展示名 */
  name: string;
  description: string;
  /** 触发场景（用于宿主侧路由/推荐） */
  triggers?: string[];
  /** Skill 正文（Markdown，含 frontmatter） */
  body: string;
  /** 引用知识（相对路径 → 内容） */
  references?: Record<string, string>;
  /** 多步流程（相对路径 → 内容） */
  workflows?: Record<string, string>;
  /** 该 Skill 主要涉及的能力域 */
  domains?: ('system' | 'app' | 'storage' | 'gui')[];
}

export interface ConnectorDecl {
  /** 连接器标识 */
  id: string;                        // "winvm"
  displayName: string;
  /** 传输配置（可多方案，按优先级） */
  transports: TransportDecl[];
  /** 宿主侧静态禁用的高危工具（NFR-508） */
  disabledTools: string[];
  /** 超时（毫秒） */
  timeoutMs: number;
  /** 环境变量声明（不落明文，走占位符） */
  env?: Record<string, string>;
}

export type TransportDecl =
  | { kind: 'ssh-tunnel'; host: string; user: string;
      remotePort: number; localPort: number; identityFile?: string; }
  | { kind: 'streamable-http'; url: string; tokenEnv: string; }
  | { kind: 'stdio'; command: string; args: string[]; };
```

---

## 4. Renderer 契约

```ts
export interface HostRenderer {
  /** 宿主标识："workbuddy" | "claude-code" | "cursor" | ... */
  readonly hostId: string;
  /** 该宿主的能力支持矩阵 */
  readonly support: {
    skills: boolean;          // 是否支持 Skill 机制
    mcpConnector: boolean;    // 是否支持 MCP 连接器
    disabledTools: boolean;   // 是否支持工具级禁用
    marketplace: boolean;     // 是否有插件市场
  };

  /** 计算产物清单（不落盘，便于 dry-run 与测试） */
  plan(plugin: NeutralPlugin, ctx: RenderContext): RenderPlan;

  /** 落盘安装 */
  install(plan: RenderPlan, ctx: RenderContext): Promise<InstallResult>;

  /** 卸载 */
  uninstall(pluginId: string, ctx: RenderContext): Promise<void>;

  /** 校验产物合法性（宿主格式校验） */
  validate(plan: RenderPlan): ValidationReport;
}

export interface RenderPlan {
  files: Array<{ path: string; content: string; mode?: 'overwrite' | 'merge' | 'skip-if-exists' }>;
  /** 需要合并进宿主已有 JSON 配置的补丁（避免覆盖用户其它连接器） */
  jsonPatches: Array<{ path: string; pointer: string; value: unknown }>;
  /** 需要人工执行的后置动作（如"重启 WorkBuddy"） */
  postActions: string[];
  /** 风险提示 */
  warnings: string[];
}
```

> **`jsonPatches` 是关键设计**：宿主连接器配置（如 `mcp.json`）是**共享文件**，直接覆盖会破坏用户其他连接器。规范强制要求以 JSON Patch 语义**增量合并**。

---

## 5. V1 实现：`adapter-host-workbuddy`

依据 `CONTEXT-ANALYSIS.md` §4 的实测事实：

| 中性模型 | WorkBuddy 产物 | 目标路径 |
|---|---|---|
| `manifest` | `.codebuddy-plugin/plugin.json`（`category: skill` 的插件 + marketplace 条目） | `~/.workbuddy/plugins/cache/winvm/winvm-bridge/<ver>/` |
| `skills[]` | `SKILL.md`（+ `references/` `workflows/`） | `~/.workbuddy/connectors/skills/connector-winvm/<skill-id>/` |
| `connector` | `mcpServers["connector:winvm"]` 条目（含 `disabledTools`、`timeout`） | `~/.workbuddy/connectors/<account>/mcp.json`（**增量合并**） |
| `lifecycle` | 安装/卸载脚本 | 随插件分发 |

### 5.1 生成的 `mcp.json` 条目（SSH 隧道默认）

```jsonc
{
  "connector:winvm": {
    "type": "streamableHttp",
    "url": "http://127.0.0.1:18443/mcp",   // 经 SSH 隧道转发到本地回环
    "timeout": 120000,
    "disabled": false,
    "disabledTools": [ /* L2/L3 高危工具，默认静态禁用 */ ]
  }
}
```

> 采用**端口转发**而非 `stdio+ssh`：WorkBuddy 连接器对 Streamable HTTP 支持成熟，且同一隧道可同时承载 MCP `/mcp` 与 A2A `/a2a`。

### 5.2 生成的 `plugin.json`（实测格式对齐）

```jsonc
{
  "name": "winvm-bridge",
  "version": "0.1.0",
  "description": "通过 MCP + A2A 双通道，让宿主机 Agent 完全操作 Windows 虚拟机",
  "author": { "name": "WinVM Bridge" },
  "category": "skill",
  "keywords": ["winvm", "windows", "mcp", "a2a", "vm", "automation"],
  "workbuddy": {
    "kind": "winvm-bridge",
    "bundleSegments": ["plugins", "winvm", "winvm-bridge"],
    "loadsCapabilities": true
  }
}
```

### 5.3 隧道管理

`winvm-orchestrator` Skill 负责在宿主侧**按需拉起/维持** SSH 隧道：

```bash
ssh -f -N -L 18443:127.0.0.1:18443 -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=30 -o ServerAliveCountMax=3 <user>@<vmhost>
```

- 隧道未就绪时，Skill 引导先建隧道再调用工具，避免"工具调用超时"这类难排查故障；
- 隧道断开自动重连（配合 `ServerAlive*` 与宿主侧守护）。

---

## 6. 适配新宿主的流程（后续）

1. 新建 `packages/adapter-host-<hostId>`；
2. 实现 `HostRenderer`（`plan` / `install` / `uninstall` / `validate`）；
3. 在 `support` 中如实声明宿主能力（如不支持 `disabledTools` 则需在 `warnings` 中提示"宿主侧静态风控不可用，依赖 VM 侧策略引擎"）；
4. 复用**同一份** `skills/` 源与 `NeutralPlugin` 定义；
5. `core` / frameworks / `vm-service` **零改动**。

---

## 7. 约束与红线

| 红线 | 说明 |
|---|---|
| **禁止覆盖共享配置文件** | 宿主连接器配置一律 `jsonPatches` 增量合并 |
| **禁止明文凭据落盘** | 一律走 SSH key / 环境变量占位符 `${VAR}` / 宿主加密机制 |
| **禁止渲染器反向依赖** | Renderer 只能依赖 `host-sdk` + `contracts`，**不得**依赖 `core` 之外的实现 |
| **禁止在渲染产物中暴露公网端点** | `warnings` 必须提示"VM 侧仅监听 127.0.0.1，严禁公网暴露" |
| **高危工具默认禁用** | L2/L3 能力在宿主侧写入 `disabledTools`（宿主支持时） |
| **install 必须可 dry-run** | `plan()` 与 `install()` 分离，先出计划再落盘 |

---

## 8. 与 Skills 规范的关系

- 本规范定义"**插件怎么装、连接器怎么声明**"；
- `SPEC-SKILLS.md` 定义"**Skill 内容怎么写**"；
- 二者通过 `SkillBundle` 衔接：Skills 以**中性格式**存放，由 Renderer 转译为宿主格式。

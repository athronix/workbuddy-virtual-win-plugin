/**
 * 宿主机 Agent 插件规范 —— 中性插件模型（SPEC-HOST-AGENT-PLUGIN.md）
 *
 * NeutralPlugin 与任何具体宿主无关；由 HostRenderer 渲染为宿主格式。
 * V1 渲染器：adapter-host-workbuddy（WorkBuddy）
 */

import type { TransportDecl } from './transport.js';

export interface PluginManifest {
  readonly name: string;
  readonly version: string; // semver
  readonly description: string;
  readonly author: { readonly name: string; readonly email?: string };
  readonly keywords: readonly string[];
  readonly homepage?: string;
  readonly license?: string;
}

export interface SkillBundle {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** 触发场景，供宿主路由/推荐 */
  readonly triggers?: readonly string[];
  /** Skill 正文（Markdown，含 frontmatter） */
  readonly body: string;
  /** 引用知识：相对路径 → 内容 */
  readonly references?: Readonly<Record<string, string>>;
  /** 多步流程：相对路径 → 内容 */
  readonly workflows?: Readonly<Record<string, string>>;
  /* V-NEXT（2026-11-23）删去 `domains?: readonly SkillDomain[]`。
   * 理由：能力分类的**唯一事实源**是能力 id 的点分前缀（`system.power.control` 的 `system`
   * 段），由 `CapabilityRegistry.domains()` 从 id 派生；`SkillDomain` 是同一事实的**第二份
   * 手写拷贝**，且已漂移（枚举 4 个 vs 实际 6 个前缀 —— 少了 `appops` 与 `meta`）。
   * 两份定义必然漂移 ⇒ 删掉手写那份，分类统一走派生。 */
  /** 总控 Skill 为 true（V1 中仅 winvm-orchestrator） */
  readonly entry?: boolean;
  readonly version?: string;
}

export interface ConnectorDecl {
  readonly id: string;
  readonly displayName: string;
  /** 按优先级排列的传输方案 */
  readonly transports: readonly TransportDecl[];
  /** 宿主侧静态禁用的高危工具（NFR-508） */
  readonly disabledTools: readonly string[];
  readonly timeoutMs: number;
  /** 环境变量声明（占位符，禁止明文） */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * MCP 端点路径（**纯附加可选**，默认 `/mcp`）。
   *
   * 为什么需要：一条 SSH 隧道（同一 localPort）可以承载**多个** MCP 工具面，
   * 只要服务端按路径分流（如 `/mcp`、`/mcp/browser`、`/mcp/desktop`）。
   * 宿主的 `streamableHttp` 条目本来就是「基址 + 路径」，把路径做成声明式字段
   * 即可让多个 connector 复用同一条隧道，避免为每个工具面各开一条 SSH 连接。
   */
  readonly mcpPath?: string;
}

export interface LifecycleHooks {
  readonly preInstall?: string;
  readonly postInstall?: string;
  readonly preUninstall?: string;
  readonly postUninstall?: string;
}

export interface NeutralPlugin {
  readonly manifest: PluginManifest;
  readonly skills: readonly SkillBundle[];
  /** 主连接器：MCP 直调通道（简单任务，单步、结构化、可精确控制） */
  readonly connector: ConnectorDecl;
  /**
   * A2A 委派桥连接器（可选）：宿主侧 A2A client 通道（复杂任务，多步自主规划 / 强 GUI / 开放意图）。
   *
   * 宿主 Agent 通常只具备 MCP client 能力，不直接说 A2A。因此本连接器以
   * **本地 stdio MCP server** 形态落地：宿主经 MCP 调它的委派工具，桥内部再用
   * A2A client 调 VM 侧 /a2a，并把 A2A 的进度 / 产物 / 审批事件翻译回 MCP 结果。
   */
  readonly a2aBridge?: ConnectorDecl;
  /**
   * 额外连接器（**纯附加可选**）：把 VM 内的第三方 MCP 工具面独立暴露给宿主。
   *
   * 首个用途（2026-11-17）：`/mcp/browser`（agent-browser，33 工具）与
   * `/mcp/desktop`（agent-desktop，75 工具）。独立成 connector 而不并入主 `connector`
   * 的理由是**工具面隔离**：宿主一次加载 162 个工具会显著挤占上下文，且桌面自动化的
   * 权限等级远高于结构性能力，需要单独的 `disabledTools` 与超时策略。
   *
   * 与 `connector` / `a2aBridge` 同一套声明与渲染规则（含 `mcpPath`），可复用同一条隧道。
   */
  readonly extraConnectors?: readonly ConnectorDecl[];
  readonly lifecycle?: LifecycleHooks;
}

/* ------------------------------ Renderer ------------------------------ */

export interface RenderContext {
  /** 宿主用户目录（如 ~/.workbuddy 所在的 home） */
  readonly homeDir: string;
  /** 目标根目录（如 ~/.workbuddy） */
  readonly hostRoot: string;
  /** 是否仅演练，不落盘 */
  readonly dryRun: boolean;
  /** 账户 ID（WorkBuddy 连接器按账户分目录；其它宿主可忽略） */
  readonly accountId?: string;
}

export interface PlannedFile {
  readonly path: string;
  readonly content: string;
  readonly mode: 'overwrite' | 'skip-if-exists';
}

/**
 * 增量补丁 —— 关键设计：宿主连接器配置是共享文件，
 * 直接覆盖会破坏用户其它连接器，因此强制增量合并。
 */
export interface JsonPatch {
  readonly path: string;
  /** JSON Pointer，如 "/mcpServers/connector:winvm" */
  readonly pointer: string;
  readonly value: unknown;
}

export interface RenderPlan {
  readonly hostId: string;
  readonly files: readonly PlannedFile[];
  readonly jsonPatches: readonly JsonPatch[];
  /** 需人工执行的后置动作（如"重启 WorkBuddy"） */
  readonly postActions: readonly string[];
  readonly warnings: readonly string[];
}

export interface InstallResult {
  readonly ok: boolean;
  readonly installedFiles: readonly string[];
  readonly patchedFiles: readonly string[];
  readonly skippedFiles: readonly string[];
  readonly warnings: readonly string[];
  readonly error?: string;
}

export interface ValidationIssue {
  readonly level: 'error' | 'warning';
  readonly message: string;
  readonly path?: string;
}

export interface ValidationReport {
  readonly ok: boolean;
  readonly issues: readonly ValidationIssue[];
}

export interface HostSupport {
  readonly skills: boolean;
  readonly mcpConnector: boolean;
  /** 是否支持工具级禁用（WorkBuddy 支持 disabledTools） */
  readonly disabledTools: boolean;
  readonly marketplace: boolean;
}

export interface HostRenderer {
  readonly hostId: string;
  readonly support: HostSupport;
  plan(plugin: NeutralPlugin, ctx: RenderContext): RenderPlan;
  validate(plan: RenderPlan): ValidationReport;
  install(plan: RenderPlan, ctx: RenderContext): Promise<InstallResult>;
  uninstall(pluginId: string, ctx: RenderContext): Promise<void>;
}

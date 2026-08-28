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

export type SkillDomain = 'system' | 'app' | 'storage' | 'gui';

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
  readonly domains?: readonly SkillDomain[];
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
  readonly connector: ConnectorDecl;
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

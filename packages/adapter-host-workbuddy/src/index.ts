/**
 * @winvm/adapter-host-workbuddy —— 宿主机 WorkBuddy 适配器（L2，V1）
 *
 * 依据 CONTEXT-ANALYSIS.md §4 的实测事实，把中性插件模型渲染为 WorkBuddy 原生格式：
 *   - .codebuddy-plugin/plugin.json（单插件清单）
 *   - .codebuddy-plugin/marketplace.json（市场清单）
 *   - connectors/skills/connector-winvm/<skill>/SKILL.md（connector + multi-skills 范式）
 *   - connectors/<account>/mcp.json（**增量合并**，绝不整体覆盖）
 *
 * 实测支撑：WorkBuddy 官方 wecom 连接器即采用「1 connector + N skills」范式。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type {
  ConnectorDecl,
  HostRenderer,
  HostSupport,
  InstallResult,
  JsonPatch,
  NeutralPlugin,
  PlannedFile,
  RenderContext,
  RenderPlan,
  TransportDecl,
  ValidationIssue,
  ValidationReport,
} from '@winvm/contracts';
import { assertValidPlugin, deepMerge, getAtPointer, setAtPointer } from '@winvm/host-sdk';

export const HOST_ID = 'workbuddy';

/* ------------------------------ 路径规划 ------------------------------ */

export interface WorkBuddyPaths {
  /** 插件安装根：plugins/cache/<marketplace>/<plugin>/<version> */
  readonly pluginRoot: string;
  /** 插件清单 */
  readonly pluginJson: string;
  /** 市场根与清单 */
  readonly marketplaceRoot: string;
  readonly marketplaceJson: string;
  /** connector skills 目录 */
  readonly connectorSkillsRoot: string;
  /** 连接器配置文件（共享文件，必须增量合并） */
  readonly connectorMcpJson: string;
}

export function resolveWorkBuddyPaths(
  plugin: NeutralPlugin,
  ctx: RenderContext,
): WorkBuddyPaths {
  const marketplace = 'winvm';
  const pluginName = plugin.manifest.name;
  const version = plugin.manifest.version;
  const pluginRoot = join(
    ctx.hostRoot,
    'plugins',
    'cache',
    marketplace,
    pluginName,
    version,
  );
  const marketplaceRoot = join(ctx.hostRoot, 'plugins', 'marketplaces', marketplace);
  const accountId = ctx.accountId ?? 'default';

  return {
    pluginRoot,
    pluginJson: join(pluginRoot, '.codebuddy-plugin', 'plugin.json'),
    marketplaceRoot,
    marketplaceJson: join(marketplaceRoot, '.codebuddy-plugin', 'marketplace.json'),
    connectorSkillsRoot: join(
      ctx.hostRoot,
      'connectors',
      'skills',
      `connector-${plugin.connector.id}`,
    ),
    connectorMcpJson: join(ctx.hostRoot, 'connectors', accountId, 'mcp.json'),
  };
}

/* ------------------------------ 连接器条目渲染 ------------------------------ */

/**
 * 把中性传输声明渲染为 WorkBuddy mcpServers 条目。
 *
 * 注意：SSH 隧道模式采用**本地端口转发**而非 stdio+ssh ——
 * 同一条隧道可同时承载 MCP /mcp 与 A2A /a2a，纯 stdio 方案做不到。
 */
export function renderConnectorEntry(
  connector: ConnectorDecl,
  transport: TransportDecl,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    timeout: connector.timeoutMs,
    disabled: false,
  };
  if (connector.disabledTools.length > 0) {
    base['disabledTools'] = [...connector.disabledTools];
  }

  switch (transport.kind) {
    case 'ssh-tunnel':
      return {
        ...base,
        type: 'streamableHttp',
        url: `http://127.0.0.1:${transport.localPort}/mcp`,
      };
    case 'streamable-http':
      return {
        ...base,
        type: 'streamableHttp',
        url: `${transport.url.replace(/\/+$/, '')}/mcp`,
        headers: { Authorization: `Bearer \${${transport.tokenEnv}}` },
      };
    case 'stdio':
      return {
        ...base,
        type: 'stdio',
        command: transport.command,
        args: [...transport.args],
        ...(transport.env ? { env: { ...transport.env } } : {}),
      };
  }
}

/* ------------------------------ Renderer ------------------------------ */

export class WorkBuddyRenderer implements HostRenderer {
  readonly hostId = HOST_ID;
  readonly support: HostSupport = {
    skills: true,
    mcpConnector: true,
    disabledTools: true,
    marketplace: true,
  };

  plan(plugin: NeutralPlugin, ctx: RenderContext): RenderPlan {
    assertValidPlugin(plugin);
    const paths = resolveWorkBuddyPaths(plugin, ctx);
    const files: PlannedFile[] = [];
    const warnings: string[] = [];

    /* ---- 1. 单插件清单（对齐实测格式） ---- */
    files.push({
      path: paths.pluginJson,
      mode: 'overwrite',
      content: JSON.stringify(
        {
          name: plugin.manifest.name,
          version: plugin.manifest.version,
          description: plugin.manifest.description,
          author: plugin.manifest.author,
          category: 'skill',
          keywords: [...plugin.manifest.keywords],
          ...(plugin.manifest.homepage ? { homepage: plugin.manifest.homepage } : {}),
          ...(plugin.manifest.license ? { license: plugin.manifest.license } : {}),
          workbuddy: {
            kind: `${plugin.manifest.name}`,
            bundleSegments: ['plugins', 'winvm', plugin.manifest.name],
            loadsCapabilities: true,
          },
        },
        null,
        2,
      ) + '\n',
    });

    /* ---- 2. 市场清单 ---- */
    files.push({
      path: paths.marketplaceJson,
      mode: 'overwrite',
      content:
        JSON.stringify(
          {
            name: 'winvm',
            description: 'WinVM Bridge marketplace：让宿主机 Agent 完全操作 Windows 虚拟机',
            owner: { name: plugin.manifest.author.name },
            metadata: { version: '1.0.0', phase: 'winvm-bridge' },
            plugins: [
              {
                name: plugin.manifest.name,
                description: plugin.manifest.description,
                source: `./${plugin.manifest.name}/${plugin.manifest.version}`,
                version: plugin.manifest.version,
                category: 'skill',
              },
            ],
          },
          null,
          2,
        ) + '\n',
    });

    /* ---- 3. Skills（connector + multi-skills 范式） ---- */
    const sorted = [...plugin.skills].sort((a, b) => (b.entry ? 1 : 0) - (a.entry ? 1 : 0));
    for (const skill of sorted) {
      files.push({
        path: join(paths.connectorSkillsRoot, skill.id, 'SKILL.md'),
        mode: 'overwrite',
        content: skill.body.endsWith('\n') ? skill.body : `${skill.body}\n`,
      });
      for (const [rel, content] of Object.entries(skill.references ?? {})) {
        files.push({
          path: join(paths.connectorSkillsRoot, skill.id, 'references', rel),
          mode: 'overwrite',
          content,
        });
      }
      for (const [rel, content] of Object.entries(skill.workflows ?? {})) {
        files.push({
          path: join(paths.connectorSkillsRoot, skill.id, 'workflows', rel),
          mode: 'overwrite',
          content,
        });
      }
    }

    /* ---- 4. 连接器配置（增量补丁，绝不整体覆盖） ---- */
    const transport = plugin.connector.transports[0];
    if (!transport) {
      throw new Error('connector.transports 为空，无法生成连接器配置');
    }
    const jsonPatches: JsonPatch[] = [
      {
        path: paths.connectorMcpJson,
        pointer: `/mcpServers/connector:${plugin.connector.id}`,
        value: renderConnectorEntry(plugin.connector, transport),
      },
    ];

    /* ---- 5. 风险与后置提示 ---- */
    if (transport.kind === 'ssh-tunnel') {
      warnings.push(
        `SSH 隧道模式：需先建立隧道 ` +
          `「ssh -f -N -L ${transport.localPort}:127.0.0.1:${transport.remotePort} ` +
          `${transport.user}@${transport.host}」再调用工具，否则会出现难排查的超时故障。`,
      );
      warnings.push('VM 侧服务必须仅监听 127.0.0.1；严禁将 VM 服务暴露到公网。');
    }
    if (transport.kind === 'streamable-http' && !transport.url.startsWith('https://')) {
      warnings.push(
        `连接器 URL 使用 http（${transport.url}）：明文传输。仅限本机回环或受信任内网。`,
      );
    }
    if (plugin.connector.disabledTools.length > 0) {
      warnings.push(
        `已在宿主侧静态禁用 ${plugin.connector.disabledTools.length} 个高危工具（disabledTools）：` +
          `${plugin.connector.disabledTools.slice(0, 8).join(', ')}` +
          `${plugin.connector.disabledTools.length > 8 ? '…' : ''}`,
      );
    }

    return {
      hostId: this.hostId,
      files,
      jsonPatches,
      postActions: [
        '重启 WorkBuddy 以加载新插件与连接器',
        ...(transport.kind === 'ssh-tunnel'
          ? [
              `建立 SSH 隧道：ssh -f -N -L ${transport.localPort}:127.0.0.1:${transport.remotePort} ${transport.user}@${transport.host}`,
            ]
          : []),
        '在连接器管理中确认 winvm 连接器已启用',
      ],
      warnings,
    };
  }

  validate(plan: RenderPlan): ValidationReport {
    const issues: ValidationIssue[] = [];

    for (const f of plan.files) {
      if (!f.path.endsWith('.json')) continue;
      try {
        JSON.parse(f.content);
      } catch (e) {
        issues.push({ level: 'error', message: `${f.path} 不是合法 JSON：${(e as Error).message}`, path: f.path });
      }
    }
    for (const p of plan.jsonPatches) {
      if (!p.pointer.startsWith('/')) {
        issues.push({ level: 'error', message: `JSON Pointer 非法：${p.pointer}`, path: p.path });
      }
    }
    const skillFiles = plan.files.filter((f) => f.path.endsWith('SKILL.md'));
    if (skillFiles.length === 0) {
      issues.push({ level: 'error', message: '产物中没有任何 SKILL.md' });
    }
    for (const f of skillFiles) {
      if (!f.content.includes('---')) {
        issues.push({ level: 'warning', message: `${f.path} 缺少 frontmatter`, path: f.path });
      }
    }
    return { ok: issues.every((i) => i.level !== 'error'), issues };
  }

  async install(plan: RenderPlan, ctx: RenderContext): Promise<InstallResult> {
    const report = this.validate(plan);
    if (!report.ok) {
      return {
        ok: false,
        installedFiles: [],
        patchedFiles: [],
        skippedFiles: [],
        warnings: plan.warnings,
        error: report.issues
          .filter((i) => i.level === 'error')
          .map((i) => i.message)
          .join('; '),
      };
    }

    if (ctx.dryRun) {
      return {
        ok: true,
        installedFiles: plan.files.map((f) => f.path),
        patchedFiles: plan.jsonPatches.map((p) => p.path),
        skippedFiles: [],
        warnings: [...plan.warnings, 'dry-run 模式：未实际写入磁盘'],
      };
    }

    const installed: string[] = [];
    const skipped: string[] = [];

    for (const f of plan.files) {
      if (f.mode === 'skip-if-exists') {
        try {
          await readFile(f.path, 'utf8');
          skipped.push(f.path);
          continue;
        } catch {
          // 不存在，继续写入
        }
      }
      await mkdir(dirname(f.path), { recursive: true });
      await writeFile(f.path, f.content, 'utf8');
      installed.push(f.path);
    }

    const patched: string[] = [];
    for (const p of plan.jsonPatches) {
      await mkdir(dirname(p.path), { recursive: true });
      let existing: Record<string, unknown> = {};
      try {
        existing = JSON.parse(await readFile(p.path, 'utf8')) as Record<string, unknown>;
      } catch {
        existing = {};
      }
      // 先合并到既有值（若已存在同名连接器），再 setAtPointer —— 保留用户自定义覆盖
      const prev = getAtPointer(existing, p.pointer);
      const valueToSet =
        prev !== undefined && typeof prev === 'object' && !Array.isArray(prev) && typeof p.value === 'object'
          ? deepMerge(prev as Record<string, unknown>, p.value as Record<string, unknown>)
          : p.value;

      const next = setAtPointer(existing, p.pointer, valueToSet);
      await writeFile(p.path, JSON.stringify(next, null, 2) + '\n', 'utf8');
      patched.push(p.path);
    }

    return {
      ok: true,
      installedFiles: installed,
      patchedFiles: patched,
      skippedFiles: skipped,
      warnings: [...plan.warnings],
    };
  }

  async uninstall(pluginId: string, ctx: RenderContext): Promise<void> {
    // 移除连接器条目（保留用户其它连接器）
    const accountId = ctx.accountId ?? 'default';
    const mcpPath = join(ctx.hostRoot, 'connectors', accountId, 'mcp.json');
    try {
      const raw = await readFile(mcpPath, 'utf8');
      const json = JSON.parse(raw) as Record<string, unknown>;
      if (json['mcpServers'] && typeof json['mcpServers'] === 'object') {
        delete (json['mcpServers'] as Record<string, unknown>)[`connector:${pluginId}`];
        await writeFile(mcpPath, JSON.stringify(json, null, 2) + '\n', 'utf8');
      }
    } catch {
      // 文件不存在，忽略
    }
  }
}

/** 便捷入口：直接渲染并安装 */
export async function renderAndInstall(
  plugin: NeutralPlugin,
  ctx: RenderContext,
): Promise<{ plan: RenderPlan; result: InstallResult }> {
  const renderer = new WorkBuddyRenderer();
  const plan = renderer.plan(plugin, ctx);
  const result = await renderer.install(plan, ctx);
  return { plan, result };
}

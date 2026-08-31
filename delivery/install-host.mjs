#!/usr/bin/env node
/**
 * WinVM Bridge —— 宿主机插件安装器
 *
 * 把中性 Skills 与连接器声明渲染并安装到 WorkBuddy：
 *   ~/.workbuddy/plugins/cache/winvm/winvm-bridge/<ver>/   （插件清单）
 *   ~/.workbuddy/plugins/marketplaces/winvm/               （市场清单）
 *   ~/.workbuddy/connectors/skills/connector-winvm/<skill>/ （1+5 Skills）
 *   ~/.workbuddy/connectors/<account>/mcp.json              （增量合并，不覆盖：
 *                                                              connector:winvm     = MCP 直调通道
 *                                                              connector:winvm-a2a = A2A 委派桥）
 *
 * 用法：
 *   node delivery/install-host.mjs [--dry-run] [--host <ip>] [--user <name>]
 *                                  [--local-port 18443] [--remote-port 18443]
 *                                  [--account <id>] [--uninstall]
 */

import { existsSync, mkdirSync, cpSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSkillBundles, validateNeutralPlugin } from '@winvm/host-sdk';
import {
  WorkBuddyRenderer,
  resolveWorkBuddyPaths,
} from '@winvm/adapter-host-workbuddy';
import { WINDOWS_CAPABILITIES } from '@winvm/vm-capabilities';

/* ------------------------------ 参数 ------------------------------ */

function parseArgs(argv) {
  const out = {
    dryRun: false,
    uninstall: false,
    host: process.env['WINVM_HOST'] ?? '192.168.1.50',
    user: process.env['WINVM_USER'] ?? 'vmuser',
    localPort: 18443,
    remotePort: 18443,
    account: process.env['WINVM_ACCOUNT'] ?? undefined,
    home: homedir(),
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--dry-run': out.dryRun = true; break;
      case '--uninstall': out.uninstall = true; break;
      case '--host': out.host = argv[++i]; break;
      case '--user': out.user = argv[++i]; break;
      case '--local-port': out.localPort = Number(argv[++i]); break;
      case '--remote-port': out.remotePort = Number(argv[++i]); break;
      case '--account': out.account = argv[++i]; break;
      case '--home': out.home = argv[++i]; break;
      default: break;
    }
  }
  return out;
}

/* ------------------------------ 构建中性插件 ------------------------------ */

/**
 * 高危工具（L2/L3）默认在宿主侧静态禁用（NFR-508）。
 * 这是纵深防御第 2 层：即使 VM 侧策略被误配，宿主侧仍有兜底。
 */
function highRiskTools() {
  return WINDOWS_CAPABILITIES.filter((c) => c.risk === 'L2' || c.risk === 'L3').map((c) => c.id);
}

async function buildPlugin(args, skillsRoot) {
  const skills = await loadSkillBundles(skillsRoot);
  if (skills.length === 0) {
    throw new Error(`未找到任何 Skill（期望 ${skillsRoot}/<skill-id>/SKILL.md）`);
  }

  const version = '0.1.0';
  const plugin = {
    manifest: {
      name: 'winvm-bridge',
      version,
      description: '通过 MCP + A2A 双通道，让宿主机 Agent 安全、可控、可审计地完全操作 Windows 虚拟机',
      author: { name: 'WinVM Bridge' },
      keywords: ['winvm', 'windows', 'vm', 'mcp', 'a2a', 'automation'],
      license: 'MIT',
    },
    skills,
    connector: {
      id: 'winvm',
      displayName: 'Windows 虚拟机',
      transports: [
        {
          kind: 'ssh-tunnel',
          host: args.host,
          user: args.user,
          localPort: args.localPort,
          remotePort: args.remotePort,
          serverAliveInterval: 30,
          serverAliveCountMax: 3,
        },
      ],
      disabledTools: highRiskTools(),
      timeoutMs: 120000,
    },
  };

  const report = validateNeutralPlugin(plugin);
  for (const i of report.issues) {
    console.log(`  [${i.level}] ${i.message}`);
  }
  if (!report.ok) throw new Error('中性插件模型校验失败，已中止');

  return plugin;
}

/* ------------------------------ 主流程 ------------------------------ */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const hostRoot = join(args.home, '.workbuddy');
  const repoRoot = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  const skillsRoot = join(repoRoot, 'skills');

  const ctx = {
    homeDir: args.home,
    hostRoot,
    dryRun: args.dryRun,
    ...(args.account ? { accountId: args.account } : {}),
  };

  const renderer = new WorkBuddyRenderer();

  if (args.uninstall) {
    await renderer.uninstall('winvm', ctx);
    console.log('已卸载 winvm 与 winvm-a2a 连接器条目（插件与 Skills 目录未删除，可手动清理）');
    return;
  }

  console.log(`宿主机根目录 : ${hostRoot}`);
  console.log(`Skills 源    : ${skillsRoot}`);
  console.log(`传输         : SSH 隧道 ${args.user}@${args.host} (${args.localPort}→${args.remotePort})`);
  console.log(`模式         : ${args.dryRun ? 'dry-run（不写盘）' : '实际安装'}`);
  console.log('');

  const plugin = await buildPlugin(args, skillsRoot);

  /* ---- A2A 委派桥：随插件落地，并注册为第二个连接器条目 ----
   * 宿主 Agent 只有 MCP client，桥以本地 stdio MCP server 提供 a2a.delegate，
   * 内部再用 A2A client 调 VM 侧 /a2a，补齐"复杂任务委派"这一跳。 */
  const paths = resolveWorkBuddyPaths(plugin, ctx);
  const bridgeSrc = join(repoRoot, 'packages', 'host-a2a-bridge', 'dist');
  const bridgeDest = join(paths.pluginRoot, 'a2a-bridge');
  if (!existsSync(bridgeSrc)) {
    throw new Error(`未找到 A2A 桥构建产物：${bridgeSrc}（请先执行 npm run build）`);
  }
  if (args.dryRun) {
    console.log(`A2A 委派桥 : ${bridgeSrc} → ${bridgeDest}  [dry-run 未复制]`);
  } else {
    mkdirSync(bridgeDest, { recursive: true });
    cpSync(bridgeSrc, bridgeDest, { recursive: true });
    console.log(`A2A 委派桥 : 已复制到 ${bridgeDest}`);
  }
  plugin.a2aBridge = {
    id: 'winvm-a2a',
    displayName: 'Windows 虚拟机 · A2A 委派',
    transports: [
      {
        kind: 'stdio',
        command: process.execPath,
        args: [
          join(bridgeDest, 'cli.js'),
          '--endpoint',
          `http://127.0.0.1:${args.localPort}`,
          '--timeout',
          '600000',
        ],
      },
    ],
    disabledTools: [],
    timeoutMs: 600000,
  };

  const bridgeReport = validateNeutralPlugin(plugin);
  for (const i of bridgeReport.issues) console.log(`  [${i.level}] ${i.message}`);
  if (!bridgeReport.ok) throw new Error('中性插件模型校验失败（含 A2A 委派桥），已中止');

  const plan = renderer.plan(plugin, ctx);

  console.log(`已加载 ${plugin.skills.length} 个 Skill：`);
  for (const s of plugin.skills) {
    console.log(`  - ${s.id}${s.entry ? '  (总控)' : ''}`);
  }
  console.log('');
  console.log(`产物：${plan.files.length} 个文件，${plan.jsonPatches.length} 个增量补丁`);

  const result = await renderer.install(plan, ctx);
  if (!result.ok) {
    console.error(`安装失败：${result.error}`);
    process.exit(1);
  }

  console.log('');
  console.log(`已写入文件   : ${result.installedFiles.length}`);
  console.log(`已增量合并   : ${result.patchedFiles.join(', ') || '(无)'}`);
  if (result.skippedFiles.length > 0) {
    console.log(`已跳过（存在）: ${result.skippedFiles.length}`);
  }

  if (plan.warnings.length > 0) {
    console.log('');
    console.log('注意事项：');
    for (const w of plan.warnings) console.log(`  ⚠ ${w}`);
  }

  console.log('');
  console.log('后续动作：');
  for (const a of plan.postActions) console.log(`  → ${a}`);
}

main().catch((e) => {
  console.error(`安装失败：${e.message}`);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * WinVM Bridge —— 宿主机插件安装器
 *
 * 把中性 Skills 与连接器声明渲染并安装到 WorkBuddy：
 *   ~/.workbuddy/plugins/cache/winvm/winvm-bridge/<ver>/   （插件清单 + A2A 桥，含自带 node_modules）
 *   ~/.workbuddy/plugins/marketplaces/winvm/               （市场清单）
 *   ~/.workbuddy/connectors/skills/connector-winvm/<skill>/ （1+5 Skills）
 *   ~/.workbuddy/connectors/<account>/mcp.json              （增量合并，不覆盖：
 *                                                              connector:winvm     = MCP 直调通道
 *                                                              connector:winvm-a2a = A2A 委派桥）
 *   ~/.workbuddy/plugins/installed_plugins.json            （写入 winvm-bridge@winvm 条目 → 转正，不再孤儿）
 *
 * 用法：
 *   node delivery/install-host.mjs [--dry-run] [--host <ip>] [--user <name>]
 *                                  [--local-port 18443] [--remote-port 18443]
 *                                  [--account <id>] [--home <dir>]
 *   卸载（安全）：先备份注册文件→改后打印 diff→确认(--yes)才把项目目录移入回收站；
 *              仅删除本项目部分，不动其它插件 / 连接器 / 技能。
 *     node delivery/install-host.mjs --uninstall            # 预览：备份 + diff，不移动目录
 *     node delivery/install-host.mjs --uninstall --yes      # 执行：目录移入回收站（可恢复）
 *     node delivery/install-host.mjs --uninstall --trash-dir <dir>  # 自定义回收目录（测试/非 Win）
 *     node delivery/install-host.mjs --purge-backups        # 清理卸载产生的 *.winvm-bak.* 备份
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync, renameSync, readdirSync, cpSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { loadSkillBundles, validateNeutralPlugin } from '@winvm/host-sdk';
import { deployWinvmPlugin } from './deploy-winvm-plugin.mjs';
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
    purgeBackups: false,
    yes: false,
    trashDir: undefined,
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
      case '--purge-backups': out.purgeBackups = true; break;
      case '--yes': out.yes = true; break;
      case '--trash-dir': out.trashDir = argv[++i]; break;
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

/**
 * 递归收集一个 @winvm 包（含传递依赖）所需的全部 @winvm/* 依赖名。
 * 返回形如 ['@winvm/contracts', '@winvm/core', ...] 的集合。
 * 仅收集 @winvm 作用域；本仓库 @winvm 包运行时零第三方依赖，故无需处理 npm 包。
 * 这是修复 stdio 桥「Connection closed」的关键：缓存目录必须自带 node_modules，
 * 否则 `node cli.js` 一启动就 `Cannot find module '@winvm/...'` 退出。
 * （ESM 不使用 NODE_PATH，必须真实落地 node_modules。）
 */
function collectWinvmDeps(repoRoot, pkgName, seen = new Set()) {
  const pkgDir = join(repoRoot, 'packages', pkgName.replace(/^@winvm\//, ''));
  const pkgJsonPath = join(pkgDir, 'package.json');
  if (!existsSync(pkgJsonPath)) return seen;
  const deps = JSON.parse(readFileSync(pkgJsonPath, 'utf8')).dependencies ?? {};
  for (const name of Object.keys(deps)) {
    if (!name.startsWith('@winvm/')) continue; // 跳过第三方依赖
    if (seen.has(name)) continue;
    seen.add(name);
    collectWinvmDeps(repoRoot, name, seen);
  }
  return seen;
}

/**
 * 把 @winvm/* 依赖的 dist + package.json 落地到 bridge 的 node_modules，使其自包含。
 * 同时写 a2a-bridge/package.json(type=module)，消除 MODULE_TYPELESS_PACKAGE_JSON 警告。
 */
function installBridgeDeps(bridgeDest, repoRoot, deps, dryRun) {
  if (dryRun) {
    for (const d of deps) console.log(`A2A 桥依赖 : ${d}  [dry-run 未复制]`);
    console.log(`A2A 桥依赖 : 写入 ${join(bridgeDest, 'package.json')} (type=module)  [dry-run]`);
    return;
  }
  const nm = join(bridgeDest, 'node_modules', '@winvm');
  mkdirSync(nm, { recursive: true });
  for (const dep of deps) {
    const name = dep.replace(/^@winvm\//, '');
    const src = join(repoRoot, 'packages', name, 'dist');
    const dest = join(nm, name);
    if (!existsSync(src)) {
      throw new Error(`A2A 桥依赖缺失构建产物：${src}（请先执行 npm run build）`);
    }
    mkdirSync(dest, { recursive: true });
    cpSync(src, join(dest, 'dist'), { recursive: true });
    cpSync(join(repoRoot, 'packages', name, 'package.json'), join(dest, 'package.json'));
  }
  writeFileSync(
    join(bridgeDest, 'package.json'),
    JSON.stringify({ name: 'winvm-a2a-bridge', version: '0.1.0', type: 'module', private: true }, null, 2) + '\n',
    'utf8',
  );
}

/* ------------------------------ 正式注册（WorkBuddy 插件注册表） ------------------------------
 * WorkBuddy 用 ~/.workbuddy/plugins/installed_plugins.json 记录"已正式安装"的插件（schema {version, plugins}）。
 * 缺条目时插件虽已落盘缓存，仍会被打 .orphaned_at 标记、在 UI 显示为孤儿。
 * 这里在安装器里显式写条目，使"转正"不依赖 WorkBuddy 运行时扫描时机；并清掉 .orphaned_at。
 * 该步骤失败（如注册表被其它进程锁住）不应中断安装，仅告警。 */
function registerInstalledPlugin(home, pluginRoot, version, dryRun) {
  const registryPath = join(home, '.workbuddy', 'plugins', 'installed_plugins.json');
  const key = 'winvm-bridge@winvm';
  const now = new Date().toISOString();
  if (dryRun) {
    console.log(`正式注册   : ${key} → ${registryPath}  [dry-run 未写入]`);
    return;
  }
  try {
    let reg = { version: 2, plugins: {} };
    if (existsSync(registryPath)) {
      try {
        const parsed = JSON.parse(readFileSync(registryPath, 'utf8'));
        if (parsed && typeof parsed === 'object') {
          reg.version = parsed.version ?? 2;
          reg.plugins = parsed.plugins && typeof parsed.plugins === 'object' ? parsed.plugins : {};
        }
      } catch {
        console.log(`  ⚠ 注册表 ${registryPath} 解析失败，将重建（不保留其它条目）`);
      }
    }
    reg.plugins[key] = [{ scope: 'user', installPath: pluginRoot, version, installedAt: now, lastUpdated: now }];
    mkdirSync(dirname(registryPath), { recursive: true });
    writeFileSync(registryPath, JSON.stringify(reg, null, 2) + '\n', 'utf8');
    console.log(`正式注册   : 已写入 ${key} 到 installed_plugins.json（转正，不再孤儿）`);
    const orphan = join(pluginRoot, '.orphaned_at');
    if (existsSync(orphan)) {
      try {
        rmSync(orphan);
        console.log('            已清除 .orphaned_at 孤儿标记');
      } catch {
        console.log('            ⚠ 无法删除 .orphaned_at，请手动清理');
      }
    }
  } catch (e) {
    console.log(`  ⚠ 正式注册失败（不影响其余安装）：${e.message}`);
  }
}

/* ------------------------------ 安全卸载：备份 / diff / 回收站 ------------------------------
 * 设计原则（满足"先备份→改→diff 确认→才删除备份 / 删除目录入回收站"）：
 *  1. 注册文件（installed_plugins.json、各 account 的 mcp.json）改动前先备份为 *.winvm-bak.<ts>；
 *  2. 改动后打印行级 diff，供人工确认"仅删除了本项目条目"；
 *  3. 项目自建目录（cache/marketplaces/skills）不永久删除，而是移入回收站（可恢复）；
 *  4. 默认两步：先预览（备份+diff，不移动目录），加 --yes 才把目录移入回收站；
 *  5. 备份文件默认保留；确认无误后用 --purge-backups 清理（同样移入回收站）。
 */

function ts() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** 改动前备份一个文件；返回备份路径（不存在则 null）。 */
function backupFile(p) {
  if (!existsSync(p)) return null;
  const bak = `${p}.winvm-bak.${ts()}`;
  copyFileSync(p, bak);
  return bak;
}

/** 极简 LCS 行级 diff，用于人工确认改动正确（仅项目条目被删）。 */
function lineDiff(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push(`  ${a[i]}`); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push(`- ${a[i]}`); i++; }
    else { out.push(`+ ${b[j]}`); j++; }
  }
  while (i < n) { out.push(`- ${a[i]}`); i++; }
  while (j < m) { out.push(`+ ${b[j]}`); j++; }
  return out.join('\n');
}

/**
 * 把文件/目录移入回收站（满足"删除都到 trash，可恢复"）。
 *   - 指定 --trash-dir：移到该目录（便于测试/非 Windows 移植）；
 *   - 否则走 Windows 回收站（COM Shell.Application，options=16 不弹进度框）。
 */
function trashItem(target, opts) {
  const { dryRun, trashDir, log } = opts;
  if (!existsSync(target)) { log(`  （跳过，不存在）${target}`); return; }
  if (dryRun) { log(`  (dry) 回收站← ${target}`); return; }
  try {
    if (trashDir) {
      const name = target.replace(/[/\\]$/, '').split(/[/\\]/).pop() || 'item';
      const dest = join(trashDir, `${name}.${ts()}`);
      mkdirSync(trashDir, { recursive: true });
      renameSync(target, dest);
      log(`  回收站← ${target}\n        → ${dest}`);
      return;
    }
    const e = target.replace(/'/g, "''");
    const script = `$e='${e}'; if(Test-Path $e){$s=New-Object -ComObject Shell.Application; $s.NameSpace(10).MoveHere($e,16)}`;
    const r = spawnSync('powershell', ['-NoProfile', '-Command', script], { stdio: 'ignore' });
    if (r.status !== 0) throw new Error(`recycle bin move failed (status ${r.status ?? '?'})`);
    log(`  回收站← ${target}`);
  } catch (e) {
    throw new Error(`无法移入回收站 ${target}：${e.message}（可改用 --trash-dir 指定自定义回收目录）`);
  }
}

/** 移除正式注册表条目（installed_plugins.json），仅本项目 key。 */
function uninstallRegistry(home, dryRun) {
  const p = join(home, '.workbuddy', 'plugins', 'installed_plugins.json');
  const key = 'winvm-bridge@winvm';
  if (!existsSync(p)) { console.log('正式注册   : 注册表不存在（无需改动）'); return; }
  let json;
  try { json = JSON.parse(readFileSync(p, 'utf8')); } catch { console.log('正式注册   : 注册表解析失败，跳过'); return; }
  if (!json.plugins || !json.plugins[key]) { console.log('正式注册   : 无本项目条目（无需改动）'); return; }
  if (dryRun) { console.log(`正式注册   : ${p}  [dry-run 将移除 ${key}]`); return; }
  const bak = backupFile(p);
  delete json.plugins[key];
  writeFileSync(p, JSON.stringify(json, null, 2) + '\n', 'utf8');
  console.log(`\n正式注册   : ${p}`);
  console.log(`  移除 : ${key}`);
  if (bak) { console.log(`  diff（备份 ${bak}）：`); console.log(lineDiff(readFileSync(bak, 'utf8'), readFileSync(p, 'utf8'))); }
}

/** 移除所有 account 的 mcp.json 中本项目的连接器条目（connector:winvm / connector:winvm-a2a）。 */
function uninstallConnectors(home, dryRun) {
  const root = join(home, '.workbuddy', 'connectors');
  if (!existsSync(root)) { console.log('连接器注册 : 目录不存在（无需改动）'); return; }
  const ourKeys = ['connector:winvm', 'connector:winvm-a2a'];
  let any = false;
  for (const acct of readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
    const p = join(root, acct, 'mcp.json');
    if (!existsSync(p)) continue;
    let json;
    try { json = JSON.parse(readFileSync(p, 'utf8')); } catch { continue; }
    const servers = json.mcpServers;
    if (!servers || typeof servers !== 'object') continue;
    const had = ourKeys.filter((k) => k in servers);
    if (had.length === 0) continue;
    if (dryRun) { console.log(`连接器注册 : ${p}  [dry-run 将移除 ${had.join(', ')}]`); any = true; continue; }
    const bak = backupFile(p);
    for (const k of had) delete servers[k];
    writeFileSync(p, JSON.stringify(json, null, 2) + '\n', 'utf8');
    console.log(`\n连接器注册 : ${p}`);
    console.log(`  移除 : ${had.join(', ')}`);
    if (bak) { console.log(`  diff（备份 ${bak}）：`); console.log(lineDiff(readFileSync(bak, 'utf8'), readFileSync(p, 'utf8'))); }
    any = true;
  }
  if (!any) console.log('连接器注册 : 未发现本项目的连接器条目（无需改动）');
}

/** 把项目自建目录移入回收站（仅本项目，不碰父目录里的其它条目）。 */
function uninstallDirectories(home, dryRun, trashDir, yes) {
  const wb = join(home, '.workbuddy');
  const targets = [
    join(wb, 'plugins', 'cache', 'winvm', 'winvm-bridge'),
    join(wb, 'plugins', 'marketplaces', 'winvm'),
    join(wb, 'connectors', 'skills', 'connector-winvm'),
  ];
  const log = (m) => console.log(m);
  for (const t of targets) {
    if (!existsSync(t)) { console.log(`目录       : ${t}  （不存在，跳过）`); continue; }
    if (!yes) { console.log(`目录       : ${t}\n        [待回收站←（加 --yes 执行）]`); continue; }
    trashItem(t, { dryRun, trashDir, log });
  }
  // 若 cache/winvm 已空，一并回收（该目录仅本项目使用）
  const cacheWinvm = join(wb, 'plugins', 'cache', 'winvm');
  if (yes && existsSync(cacheWinvm)) {
    try {
      if (readdirSync(cacheWinvm).length === 0) {
        console.log('目录       : 空目录 plugins/cache/winvm 一并回收');
        trashItem(cacheWinvm, { dryRun, trashDir, log });
      }
    } catch { /* noop */ }
  }
}

/** 清理本脚本产生的备份文件（*.winvm-bak.*），同样移入回收站。 */
function purgeBackups(home, trashDir) {
  const base = join(home, '.workbuddy');
  if (!existsSync(base)) { console.log('未发现待清理的备份文件'); return; }
  const log = (m) => console.log(m);
  let count = 0;
  const stack = [base];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      if (e.name.includes('.winvm-bak.')) {
        try { trashItem(full, { dryRun: false, trashDir, log }); count++; } catch (err) { console.log(`  无法清理 ${full}: ${err.message}`); }
      }
    }
  }
  console.log(count ? `已清理 ${count} 个备份文件（移入回收站）` : '未发现待清理的备份文件');
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

  if (args.purgeBackups) {
    console.log('=== WinVM Bridge · 清理卸载备份 ===');
    purgeBackups(args.home, args.trashDir);
    return;
  }

  if (args.uninstall) {
    console.log('=== WinVM Bridge · 宿主机一键卸载（安全：先备份+diff，目录入回收站） ===');
    console.log(`宿主机根目录 : ${hostRoot}`);
    console.log(`模式         : ${args.dryRun ? 'dry-run（仅预览）' : (args.yes ? '执行（已确认 --yes）' : '预览+备份（需 --yes 才移动目录到回收站）')}`);
    if (args.trashDir) console.log(`回收目录     : ${args.trashDir}（自定义，非系统回收站）`);
    console.log('');
    uninstallRegistry(args.home, args.dryRun);
    uninstallConnectors(args.home, args.dryRun);
    console.log('');
    uninstallDirectories(args.home, args.dryRun, args.trashDir, args.yes);
    console.log('');
    if (args.dryRun) {
      console.log('dry-run 完成：未做任何改动。去掉 --dry-run 以预览并备份注册文件。');
    } else if (!args.yes) {
      console.log('已备份注册文件并打印改动 diff。请确认 diff 仅含本项目条目，');
      console.log('确认无误后重新执行并加 --yes 以将项目目录移入回收站：');
      console.log('  node delivery/install-host.mjs --uninstall --yes');
      console.log('（备份文件 *.winvm-bak.* 保留以便回滚；确认后可用 --purge-backups 清理）');
    } else {
      console.log('卸载完成：注册条目已移除、项目目录已移入回收站（可恢复）。');
      console.log('   · 被移除的目录在 Windows 回收站可见（或 --trash-dir 指定目录）。');
      console.log('   · 注册文件（installed_plugins.json / mcp.json）改动前已备份为 *.winvm-bak.<时间戳>，');
      console.log('     默认保留以便回滚（故回收站里看不到这些单文件；这是预期行为，非丢失）。');
      console.log('   · 确认无误后清理备份：node delivery/install-host.mjs --purge-backups');
    }
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
    const deps = collectWinvmDeps(repoRoot, '@winvm/host-a2a-bridge');
    installBridgeDeps(bridgeDest, repoRoot, deps, false);
    console.log(`A2A 桥自包含依赖 : 已安装 ${deps.size} 个 @winvm 包到 node_modules`);
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

  /* ---- 正式注册：写入 installed_plugins.json + 清 .orphaned_at ----
   * 让插件在 WorkBuddy 里显示为"已安装"而非孤儿，不依赖运行时扫描时机。 */
  registerInstalledPlugin(args.home, paths.pluginRoot, plugin.manifest.version, args.dryRun);

  /* ---- 部署插件管理 CLI winvm-plugin（host 侧）----
   * 落盘到插件缓存根（自动识别 side=host），并额外在仓库 delivery/ 放一套启动器，
   * 使在仓库目录里也能 `./delivery/winvm-plugin <cmd>` / `node delivery/winvm-plugin.mjs <cmd>`。
   * 启动器三件套（.mjs + .cmd + 无扩展名 bash 启动器 +x）由 deployWinvmPlugin 统一生成。 */
  if (!args.dryRun) {
    deployWinvmPlugin({ targetDir: paths.pluginRoot, side: 'host', dryRun: false, log: (m) => console.log(`管理命令     : ${m}`), repoRoot });
    // 仓库 delivery 部署：不写 .winvm-context.json（避免 side:host 随 tar 发到 VM；VM 侧由 install-vm 写 side:vm）
    deployWinvmPlugin({ targetDir: join(repoRoot, 'delivery'), side: 'host', dryRun: false, writeContext: false, log: (m) => console.log(`管理命令(仓库): ${m}`), repoRoot });
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

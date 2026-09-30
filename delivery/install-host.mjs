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
 *   ~/.workbuddy/settings.json                             （merge 写入 enabledPlugins["winvm-bridge@winvm"]=true
 *                                                             → 启用插件，使其 hooks/SessionStart 生效，D16）
 *   ~/.workbuddy/plugins/cache/winvm/winvm-bridge/<ver>/hooks/ （hooks.json + session-start.sh：随 WorkBuddy
 *                                                             SessionStart 幂等拉起隧道守护进程，D16）
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
  renderConnectorEntry,
} from '@winvm/adapter-host-workbuddy';
import { WINDOWS_CAPABILITIES } from '@winvm/vm-capabilities';
import { addToUserPath, removeFromUserPath } from './path-util.mjs';
import { resolveAccountIds } from './account-resolve.mjs';
import { checkHostDeps, printChecks, assertDeps } from './preflight.mjs';

/**
 * 插件缓存根（含 winvm-plugin 启动器）的版本化路径。
 * 与 resolveWorkBuddyPaths 产出的 paths.pluginRoot 同源，供卸载时精确移除 PATH。
 */
function pluginCacheRoot(home) {
  return join(home, '.workbuddy', 'plugins', 'cache', 'winvm', 'winvm-bridge', '0.1.0');
}

/**
 * CL-018 C2：A2A 委派等待上限（落点配置）。
 *
 * 优先级：`--a2a-timeout`(CLI) > env `WINVM_A2A_TIMEOUT_MS` > 内置默认 600000。
 * 该值写入 A2A 连接器的 `--timeout` 与 `timeoutMs`，使宿主委派预算与 VM 侧冷启动窗口对齐
 * （真机实测 VM 内 LLM 首次委派需 75–107s 进程级冷启动，出厂默认 600000ms 已足够）。
 */
function resolveA2aTimeoutFromEnv() {
  const raw = process.env['WINVM_A2A_TIMEOUT_MS'];
  if (raw === undefined || raw === '') return 600000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 600000;
}

/**
 * 默认 SSH 私钥探测链（与 delivery/winvm-plugin.mjs 的 probeDefaultSshKey 行为**一致**）：
 * 未显式提供 `--vm-key` 时，按序探测 `~/.ssh/id_ed25519` → `id_ecdsa` → `id_rsa`，
 * 返回首个存在的**绝对路径**；全部不存在则返回 undefined。
 *
 * 目的（I1 / Q4 裁定）：把探测结果在**部署期**固化进 `vm-conn.json`（及连接器 identityFile），
 * 使宿主侧 health/server/command 无需每次手动 `--vm-key`，也不必仅依赖运行时兜底探测。
 */
function probeDefaultSshKey() {
  for (const name of ['id_ed25519', 'id_ecdsa', 'id_rsa']) {
    const fp = join(homedir(), '.ssh', name);
    if (existsSync(fp)) return fp;
  }
  return undefined;
}

/** 读取 JSON 文件（不存在/损坏 → null）。 */
function readJsonSafe(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 解析 VM 连接信息（D5）。优先级（高 → 低）：
 *   1) 显式 flags：`--vm-host/--vm-user/--vm-ssh-port/--vm-port`（`--host/--user` 视为等价别名）
 *   2) 已存在的持久化配置 `~/.workbuddy/winvm/vm-conn.json`
 *   3) 环境变量 `WINVM_HOST` / `WINVM_USER` / `WINVM_VM_SSH_PORT` / `WINVM_SERVICE_PORT`（或 `WINVM_VM_PORT`）
 * host / user 全缺时返回 `{ missing: true }`，由调用方**报错退出**（绝不静默回落默认值）。
 * 端口缺失时回落 22 / remotePort（默认 18443）。
 * @returns {{host:string,user:string,sshPort:number,servicePort:number,missing:boolean}}
 */
function resolveVmConnection(args, home) {
  const persisted = readJsonSafe(join(home, '.workbuddy', 'winvm', 'vm-conn.json')) || {};
  const env = process.env;
  const numOr = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  const host = args.vmHost ?? args.host ?? persisted.host ?? env['WINVM_HOST'] ?? '';
  const user = args.vmUser ?? args.user ?? persisted.user ?? env['WINVM_USER'] ?? '';
  const sshPort = numOr(args.vmSshPort ?? persisted.sshPort ?? env['WINVM_VM_SSH_PORT'], 22);
  const servicePort = numOr(
    args.vmPort ?? persisted.servicePort ?? env['WINVM_SERVICE_PORT'] ?? env['WINVM_VM_PORT'],
    args.remotePort ?? 18443,
  );
  return {
    host: host ? String(host) : '',
    user: user ? String(user) : '',
    sshPort,
    servicePort,
    missing: !host || !user,
  };
}

/* ------------------------------ 参数 ------------------------------ */

function parseArgs(argv) {
  const out = {
    dryRun: false,
    uninstall: false,
    purgeBackups: false,
    yes: false,
    trashDir: undefined,
    // D5：不再静默回落默认 IP/用户（旧值 '192.168.1.50'/'vmuser' 会把错误目标静默写进 vm-conn.json）。
    // 连接信息改为按优先级解析（flags → 已存在 vm-conn.json → WINVM_* env），全缺则报错退出，见 resolveVmConnection。
    host: undefined,
    user: undefined,
    localPort: 18443,
    remotePort: 18443,
    account: process.env['WINVM_ACCOUNT'] ?? undefined,
    home: homedir(),
    vmHost: undefined,
    vmUser: undefined,
    vmSshPort: undefined,
    vmPort: undefined,
    vmKey: undefined,
    noTunnel: false,
    noPreflight: false,
    // CL-018 C2：A2A 委派超时（落点配置；env 打底，--a2a-timeout 可覆盖）
    a2aTimeoutMs: resolveA2aTimeoutFromEnv(),
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--dry-run': out.dryRun = true; break;
      case '--uninstall': out.uninstall = true; break;
      case '--purge-backups': out.purgeBackups = true; break;
      case '--no-tunnel': out.noTunnel = true; break;
      case '--no-preflight': out.noPreflight = true; break;
      case '--yes': out.yes = true; break;
      case '--trash-dir': out.trashDir = argv[++i]; break;
      case '--host': out.host = argv[++i]; break;
      case '--user': out.user = argv[++i]; break;
      case '--local-port': out.localPort = Number(argv[++i]); break;
      case '--remote-port': out.remotePort = Number(argv[++i]); break;
      case '--vm-host': out.vmHost = argv[++i]; break;
      case '--vm-user': out.vmUser = argv[++i]; break;
      case '--vm-ssh-port': out.vmSshPort = Number(argv[++i]); break;
      case '--vm-port': out.vmPort = Number(argv[++i]); break;
      case '--vm-key': out.vmKey = argv[++i]; break;
      case '--account': out.account = argv[++i]; break;
      case '--home': out.home = argv[++i]; break;
      case '--a2a-timeout': {
        const n = Number(argv[++i]);
        if (Number.isFinite(n) && n > 0) out.a2aTimeoutMs = Math.floor(n);
        break;
      }
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
 * 仅收集 @winvm 作用域——@winvm/core 的第三方运行时依赖（ssh2 等）由 CL-015 T11 的
 * `copySsh2Runtime` 单独离线分发到插件缓存，不在此处处理。
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

/* ------------------------------ ssh2 运行时依赖离线分发（CL-015 T11 / P0-01） ------------------------------
 * @winvm/core 依赖 ssh2（及其纯 JS 传递依赖 asn1 / bcrypt-pbkdf / tweetnacl），
 * 但 collectWinvmDeps 仅收集 @winvm/*，故 ssh2 必须单独落地到插件缓存 node_modules，
 * 否则鸿蒙宿主（无系统 ssh）上进程内 ssh2 隧道 import('ssh2') 必失败。
 *  - 源优先级：<repoRoot>/vendor/ssh2（离线预置，若为包目录） → <repoRoot>/node_modules/ssh2。
 *  - 仅复制 dependencies 传递链（纯 JS）；optional 原生依赖（cpu-features / nan）缺失即跳过（ssh2 回落纯 JS，功能不受影响）。
 *  - 扁平落地到 <pluginRoot>/node_modules/<name>，版本相同则跳过（幂等）。
 *  - 对所有平台 best-effort 执行（失败仅告警）：仅新增数据文件，win32/darwin 不使用 ssh2 后端（守卫），惰性无害（NFR-2/A5）。
 */

/** 解析 ssh2 主包目录：vendor/ssh2 优先（离线预置），否则 node_modules/ssh2。 */
function resolveSsh2Source(repoRoot) {
  const vendor = join(repoRoot, 'vendor', 'ssh2');
  if (existsSync(join(vendor, 'package.json'))) return vendor;
  const nm = join(repoRoot, 'node_modules', 'ssh2');
  return existsSync(nm) ? nm : null;
}

/** 递归收集 ssh2 的纯 JS 传递依赖名（不含 ssh2 自身，不含 optional 原生依赖）。 */
function ssh2TransitiveDeps(repoRoot, pkgDir, seen = new Set()) {
  const pjPath = join(pkgDir, 'package.json');
  if (!existsSync(pjPath)) return seen;
  let deps = {};
  try {
    deps = JSON.parse(readFileSync(pjPath, 'utf8')).dependencies ?? {};
  } catch {
    return seen;
  }
  for (const name of Object.keys(deps)) {
    if (name === 'ssh2' || seen.has(name)) continue;
    seen.add(name);
    const dir = join(repoRoot, 'node_modules', name);
    if (existsSync(join(dir, 'package.json'))) ssh2TransitiveDeps(repoRoot, dir, seen);
  }
  return seen;
}

/** 把 ssh2 + 传递依赖扁平落地到 depsDest（顶层 node_modules）。dryRun 仅预览。 */
function copySsh2Runtime(depsDest, repoRoot, dryRun) {
  const src = resolveSsh2Source(repoRoot);
  if (!src) {
    console.log('  ⚠ 未找到 ssh2 源（vendor/ssh2 与 node_modules/ssh2 均不存在）；隧道将不可用（运行时报三要素引导）。');
    return;
  }
  const names = ['ssh2', ...ssh2TransitiveDeps(repoRoot, src)];
  if (dryRun) {
    for (const n of names) console.log(`ssh2 依赖   : ${n}  [dry-run 未复制]`);
    return;
  }
  mkdirSync(depsDest, { recursive: true });
  for (const n of names) {
    const s = existsSync(join(repoRoot, 'vendor', n)) ? join(repoRoot, 'vendor', n) : join(repoRoot, 'node_modules', n);
    const d = join(depsDest, n);
    if (!existsSync(join(s, 'package.json'))) {
      console.log(`  ⚠ 跳过 ${n}（源不存在；可能为 optional 原生依赖，缺失不影响功能）`);
      continue;
    }
    cpSync(s, d, { recursive: true });
  }
  console.log(`ssh2 依赖   : 已落地 ${names.length} 个包到 ${depsDest}（含纯 JS 传递依赖；optional 原生依赖跳过）`);
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

/* ------------------------------ 插件启用（enabledPlugins，D16） ------------------------------
 * D16 第二重问题：插件写入 installed_plugins.json 只代表「已注册」，**不等于「已启用」**。
 * 平台以 ~/.workbuddy/settings.json 的 `enabledPlugins` 为准（27 条内置插件均在此置 true）；
 * 缺失该键时，插件声明的 hooks（含 SessionStart 自启动）不会被加载 —— 这正是 WorkBuddy
 * 重启后隧道自启动不触发的直接原因之一。
 * 故：安装期 merge 写入该键；卸载期对称移除。merge 逻辑用**纯函数**实现并配单测。 */

/**
 * 纯函数：把插件 key 的启用态 merge 进 settings 对象（不修改入参、无 I/O）。
 *
 * 语义：
 *  - enabled=true  ：确保 `enabledPlugins[key] === true`；已为 true 则 changed=false。
 *  - enabled=false ：删除 `enabledPlugins[key]`；本就没有则 changed=false。
 *  - 保留 settings 的其它全部键；`enabledPlugins` 若原本缺失/非法则新建为普通对象。
 *
 * @param {unknown} settings 现有 settings.json 内容（任意值；非对象按空对象处理）
 * @param {string} key 插件 key，如 'winvm-bridge@winvm'
 * @param {boolean} enabled 目标启用态
 * @returns {{ next: Record<string, unknown>, changed: boolean }}
 */
export function applyEnabledPlugin(settings, key, enabled) {
  const base =
    settings && typeof settings === 'object' && !Array.isArray(settings)
      ? settings
      : {};
  const prev = base.enabledPlugins;
  const map = prev && typeof prev === 'object' && !Array.isArray(prev) ? { ...prev } : {};

  if (enabled) {
    if (map[key] === true) return { next: base, changed: false };
    map[key] = true;
    return { next: { ...base, enabledPlugins: map }, changed: true };
  }
  if (!Object.prototype.hasOwnProperty.call(map, key)) return { next: base, changed: false };
  delete map[key];
  return { next: { ...base, enabledPlugins: map }, changed: true };
}

/**
 * 写盘封装：按 enabledPlugins 语义改写 settings.json（写前备份为 *.winvm-bak.<ts>，与
 * 本文件既有 injectSandboxAllowWrite 的安全约定一致；保留其它键与 JSON 缩进风格）。
 * @param {string} key 插件 key
 * @param {string} home 用户主目录
 * @param {boolean} enabled 目标启用态
 * @param {boolean} dryRun 仅计算不写盘
 * @returns {{changed:boolean, path:string}}
 */
function mutateEnabledPlugin(key, home, enabled, dryRun) {
  const settingsPath = join(home, '.workbuddy', 'settings.json');
  let raw = {};
  if (existsSync(settingsPath)) {
    try {
      raw = JSON.parse(readFileSync(settingsPath, 'utf8'));
    } catch {
      // 解析失败绝不覆盖用户既有内容（避免写坏 settings.json），交由调用方兜底告警
      throw new Error(`${settingsPath} 解析失败，跳过 enabledPlugins 改写（请手工检查）`);
    }
  }
  const { next, changed } = applyEnabledPlugin(raw, key, enabled);
  if (!changed || dryRun) return { changed, path: settingsPath };
  backupFile(settingsPath);
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return { changed, path: settingsPath };
}

/** 安装期：启用插件（写入 settings.json.enabledPlugins）。 */
export function enablePlugin(key, home, dryRun = false) {
  return mutateEnabledPlugin(key, home, true, dryRun);
}

/** 卸载期：停用插件（移除 settings.json.enabledPlugins 中的该键）。 */
export function disablePlugin(key, home, dryRun = false) {
  return mutateEnabledPlugin(key, home, false, dryRun);
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

/* ------------------------------ 沙箱白名单（T07 / P0-R4） ------------------------------
 * 把本插件运行期需要写入的路径加入 ~/.workbuddy/settings.json 的 sandbox.extraAllowWrite，
 * 使 OH/Linux 沙箱内的 WorkBuddy 可写插件缓存根与 winvm 运行目录（known_hosts/vm-conn.json）。
 *  - 仅对「本就有 sandbox 对象」的宿主生效；Windows 无 sandbox 字段则跳过（零行为变化，见守卫）。
 *  - 写前一律先备份 settings.json 为 *.winvm-bak.<ts>，绝不整体覆盖用户既有白名单。
 */

/** 规范化白名单路径：去首尾空白、去尾随斜杠/反斜杠（与 path-util.normalizePathEntry 语义一致）。 */
function normalizeAllowWriteEntry(p) {
  return String(p).replace(/[\\/]+$/g, '').trim();
}

/**
 * 把 paths 追加进 settings.json 的 sandbox.extraAllowWrite（幂等；已存在则不重复加）。
 * @param {string} home 用户主目录
 * @param {string[]} paths 需放行的目录/文件绝对路径
 * @param {boolean} dryRun 仅计算不写盘
 * @returns {string[]} 实际新增（dryRun 下为「将新增」）的条目
 */
export function injectSandboxAllowWrite(home, paths, dryRun) {
  const settingsPath = join(home, '.workbuddy', 'settings.json');
  let json = {};
  if (existsSync(settingsPath)) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(settingsPath, 'utf8'));
    } catch {
      // 解析失败：不覆盖用户既有内容，抛错交由调用方兜底（避免写坏 settings.json）
      throw new Error(`${settingsPath} 解析失败，跳过沙箱白名单写入（请手工检查）`);
    }
    if (parsed && typeof parsed === 'object') json = parsed;
  }
  // T07 守卫：Windows 无 sandbox 概念，若 settings.json 无 sandbox 字段则跳过，
  // 绝不新建/改写用户 settings.json（保证 Windows/macOS 宿主零行为变化，与设计 §3.2.1 一致）。
  if (
    process.platform === 'win32' &&
    (!json.sandbox || typeof json.sandbox !== 'object' || Array.isArray(json.sandbox))
  ) {
    return [];
  }
  if (!json.sandbox || typeof json.sandbox !== 'object' || Array.isArray(json.sandbox)) json.sandbox = {};
  if (!Array.isArray(json.sandbox.extraAllowWrite)) json.sandbox.extraAllowWrite = [];
  const list = json.sandbox.extraAllowWrite;
  const existing = new Set(list.map((x) => normalizeAllowWriteEntry(x)));
  const added = [];
  for (const p of paths) {
    const norm = normalizeAllowWriteEntry(p);
    if (!norm || existing.has(norm)) continue;
    list.push(p);
    existing.add(norm);
    added.push(p);
  }
  if (added.length === 0) return [];
  if (dryRun) return added;
  backupFile(settingsPath);
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(json, null, 2) + '\n', 'utf8');
  return added;
}

/**
 * 从 settings.json 的 sandbox.extraAllowWrite 移除 paths（规范化后相等即移除）。
 * @param {string} home 用户主目录
 * @param {string[]} paths 待移除条目
 * @param {boolean} dryRun 仅计算不写盘
 * @returns {string[]} 实际移除（dryRun 下为「将移除」）的条目
 */
export function removeSandboxAllowWrite(home, paths, dryRun) {
  const settingsPath = join(home, '.workbuddy', 'settings.json');
  if (!existsSync(settingsPath)) return [];
  let json;
  try {
    json = JSON.parse(readFileSync(settingsPath, 'utf8'));
  } catch {
    return [];
  }
  if (
    !json ||
    typeof json !== 'object' ||
    !json.sandbox ||
    typeof json.sandbox !== 'object' ||
    Array.isArray(json.sandbox) ||
    !Array.isArray(json.sandbox.extraAllowWrite)
  ) {
    return [];
  }
  const before = json.sandbox.extraAllowWrite;
  const targets = new Set(paths.map((p) => normalizeAllowWriteEntry(p)));
  const kept = before.filter((x) => !targets.has(normalizeAllowWriteEntry(x)));
  if (kept.length === before.length) return [];
  const removed = before.filter((x) => targets.has(normalizeAllowWriteEntry(x)));
  if (dryRun) return removed;
  backupFile(settingsPath);
  json.sandbox.extraAllowWrite = kept;
  writeFileSync(settingsPath, JSON.stringify(json, null, 2) + '\n', 'utf8');
  return removed;
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
  // 非 Windows 宿主（鸿蒙/Linux）：无 Shell.Application COM，默认改走 POSIX 目录回收站
  // （~/.workbuddy/winvm-trash），保持「仅移本项目目录、可恢复」语义；Windows 行为完全不变。
  if (!opts.trashDir && process.platform !== 'win32') {
    opts = { ...opts, trashDir: join(homedir(), '.workbuddy', 'winvm-trash') };
  }
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

/** 移除全局 ~/.workbuddy/mcp.json 中的本项目条目（winvm / winvm-a2a，与安装期全局注册对称）。 */
function uninstallGlobalMcp(home, dryRun) {
  const p = join(home, '.workbuddy', 'mcp.json');
  if (!existsSync(p)) { console.log('全局 mcp.json : 不存在（无需改动）'); return; }
  let json;
  try { json = JSON.parse(readFileSync(p, 'utf8')); } catch { console.log('全局 mcp.json : 解析失败，跳过'); return; }
  const servers = json.mcpServers;
  if (!servers || typeof servers !== 'object') return;
  const ourKeys = ['winvm', 'winvm-a2a'];
  const had = ourKeys.filter((k) => k in servers);
  if (had.length === 0) { console.log('全局 mcp.json : 无本项目条目（无需改动）'); return; }
  if (dryRun) { console.log(`全局 mcp.json : ${p}  [dry-run 将移除 ${had.join(', ')}]`); return; }
  const bak = backupFile(p);
  for (const k of had) delete servers[k];
  writeFileSync(p, JSON.stringify(json, null, 2) + '\n', 'utf8');
  console.log(`\n全局 mcp.json : ${p}`);
  console.log(`  移除 : ${had.join(', ')}`);
  if (bak) { console.log(`  diff（备份 ${bak}）：`); console.log(lineDiff(readFileSync(bak, 'utf8'), readFileSync(p, 'utf8')));
}
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

async function buildPlugin(args, skillsRoot, effectiveVmKey) {
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
          identityFile: effectiveVmKey || undefined,
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

  /* ---- I1 / Q4：部署期固化默认 SSH 私钥（把探测结果写入 vm-conn.json + 连接器声明）----
   * 显式 `--vm-key` 优先；否则走默认私钥探测链（与 winvm-plugin.mjs 一致）。
   * 全部缺失时保持 undefined，交由运行时（winvm-plugin）兜底探测。 */
  const explicitVmKey = args.vmKey;
  const effectiveVmKey = explicitVmKey || probeDefaultSshKey();
  const vmKeyNote = explicitVmKey
    ? `${explicitVmKey}（显式 --vm-key）`
    : effectiveVmKey
      ? `${effectiveVmKey}（探测）`
      : '未探测到，将走运行时兜底（winvm-plugin 调用时探测）';

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
    uninstallGlobalMcp(args.home, args.dryRun);
    console.log('');
    uninstallDirectories(args.home, args.dryRun, args.trashDir, args.yes);
    console.log('');
    // 沙箱白名单：对称移除本插件追加的写路径（仅移除本插件条目，非致命）。
    try {
      const removed = removeSandboxAllowWrite(
        args.home,
        [join(args.home, '.workbuddy', 'winvm'), pluginCacheRoot(args.home), join(args.home, '.workbuddy', 'connectors')],
        args.dryRun,
      );
      console.log(`沙箱白名单 : ${args.dryRun ? '[预览] ' : ''}${removed.length ? `已移除 ${removed.length} 条本插件条目` : '无需移除（本插件条目不存在）'}`);
    } catch (e) {
      console.log(`  ⚠ 移除沙箱白名单失败（可手动删）：${e.message}`);
    }
    /* ---- 常驻隧道 daemon 自停（T12 / G2 对称）----
     * 卸载前先停掉进程内 ssh2 隧道 daemon（SIGTERM + 删 pidfile），避免卸载后残留进程持有已移走的目录。
     * 仅在真正执行（!dryRun 且 --yes）时动作；preview/dry-run 仅跳过。失败仅告警。 */
    if (!args.dryRun && args.yes) {
      try {
        const wvPlugin = join(repoRoot, 'delivery', 'winvm-plugin.mjs');
        spawnSync(process.execPath, [wvPlugin, 'tunnel', 'stop', '--force'], { stdio: 'inherit', env: process.env });
        console.log('常驻隧道   : 已请求停止（tunnel stop --force）');
        // 一并移除启动服务标记，使 WorkBuddy 启动钩子不再自动拉起已卸载插件的隧道
        const autoPath = join(args.home, '.workbuddy', 'winvm', 'tunnel-autostart.json');
        if (existsSync(autoPath)) { rmSync(autoPath, { force: true }); console.log('启动服务   : 已移除 tunnel-autostart.json'); }
        // D16 对称清理：移除 settings.json.enabledPlugins 里的本插件键。否则卸载后平台仍视其
        // 为启用态，会尝试加载已移除的 hooks（SessionStart 自启动）。
        try {
          const r = disablePlugin('winvm-bridge@winvm', args.home, args.dryRun);
          console.log(`插件启用   : ${r.changed ? '已从 enabledPlugins 移除 winvm-bridge@winvm' : 'enabledPlugins 无本插件条目（无需改动）'}`);
        } catch (e) {
          console.log(`  ⚠ 移除 enabledPlugins 条目失败（可手动删）：${e.message}`);
        }
      } catch (e) {
        console.log(`  ⚠ 隧道 daemon 停止异常（可手动 winvm-plugin tunnel stop --force）：${e.message}`);
      }
    }
    console.log('');
    // PATH：精确移除插件缓存根（与安装时加入的条目一致）。
    // 仅当真正执行（!dryRun 且 --yes）才写盘；预览/dry-run 只报告。
    try {
      const pRoot = pluginCacheRoot(args.home);
      const doWrite = !args.dryRun && args.yes;
      const changed = removeFromUserPath(pRoot, { dryRun: !doWrite });
      console.log(`PATH        : ${doWrite ? '' : '[预览] '}${changed ? `已将 ${pRoot} 从用户 PATH 移除` : `用户 PATH 不含 ${pRoot}（跳过）`}`);
    } catch (e) {
      console.log(`  ⚠ 移除 PATH 失败（可手动删除 ${pluginCacheRoot(args.home)}）：${e.message}`);
    }
    // 部署期持久化的 VM 连接配置
    try {
      const connPath = join(args.home, '.workbuddy', 'winvm', 'vm-conn.json');
      const doWrite = !args.dryRun && args.yes;
      if (existsSync(connPath)) {
        if (doWrite) { removeVmConnConfig(args.home); console.log(`VM 连接配置 : 已移除 ${connPath}`); }
        else console.log(`VM 连接配置 : ${connPath}  [预览将移除]`);
      } else {
        console.log(`VM 连接配置 : 不存在，跳过`);
      }
    } catch (e) {
      console.log(`  ⚠ 移除 VM 连接配置失败：${e.message}`);
    }
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

  /* ---- VM 连接信息解析（D5，硬门禁）----
   * 优先级：显式 flags → 已存在 vm-conn.json → WINVM_* env；全缺则**报错退出**，
   * 绝不静默回落默认 IP/用户（旧行为会把 192.168.1.50/vmuser 静默写进 vm-conn.json）。
   * 置于依赖预检之前，使「home 下无 vm-conn.json 且未传 --vm-*」时明确因**连接信息缺失**而失败。 */
  const conn = resolveVmConnection(args, args.home);
  if (conn.missing) {
    console.error('错误：未解析到 VM 连接信息（host / user）。');
    console.error('  请显式传入：node delivery/install-host.mjs --apply --yes --vm-host <ip> --vm-user <name>');
    console.error('  或先运行 node delivery/setup.mjs（会写入 ~/.workbuddy/winvm/vm-conn.json），再重跑本安装器。');
    process.exit(1);
  }
  // 归一：回填 args，供连接器声明（args.host/user）、传输打印与 vm-conn 持久化（args.vm*）复用。
  args.host = conn.host;
  args.user = conn.user;
  args.vmHost = conn.host;
  args.vmUser = conn.user;
  args.vmSshPort = conn.sshPort;
  args.vmPort = conn.servicePort;

  /* ----- 宿主环境依赖预检（硬门禁）-----
   * 在调用 buildPlugin / 写盘前，先确认宿主已部署 WorkBuddy 与 node >= 18；
   * 不满足则中止安装，要求用户先补齐依赖。--no-preflight 仅调试用。 */
  if (args.noPreflight) {
    console.log('（已跳过宿主环境依赖预检：--no-preflight）');
  } else {
    const hostDeps = checkHostDeps({ home: args.home });
    console.log(printChecks(hostDeps, { headline: '=== 宿主环境依赖预检 ===' }));
    if (!assertDeps(hostDeps)) {
      console.error('宿主环境依赖不满足，请先按上方 remedy 完成部署后再安装本项目。');
      process.exit(1);
    }
  }

  console.log(`宿主机根目录 : ${hostRoot}`);
  console.log(`Skills 源    : ${skillsRoot}`);
  console.log(`传输         : SSH 隧道 ${args.user}@${args.host} (${args.localPort}→${args.remotePort})`);
  console.log(`模式         : ${args.dryRun ? 'dry-run（不写盘）' : '实际安装'}`);
  console.log(`默认私钥    : ${vmKeyNote}`);
  console.log('');

  const plugin = await buildPlugin(args, skillsRoot, effectiveVmKey);

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
          String(args.a2aTimeoutMs),
        ],
      },
    ],
    disabledTools: [],
    timeoutMs: args.a2aTimeoutMs,
  };

  const bridgeReport = validateNeutralPlugin(plugin);
  for (const i of bridgeReport.issues) console.log(`  [${i.level}] ${i.message}`);
  if (!bridgeReport.ok) throw new Error('中性插件模型校验失败（含 A2A 委派桥），已中止');

  /* ---- 账户解析（T06 / P0-R3）----
   * 宿主机=鸿蒙场景下 ~/.workbuddy/connectors/ 以「账户 uuid 目录」组织，活跃账户未必是 default。
   * 连接器配置必须写入活跃账户目录，否则 WorkBuddy 读不到 connector:winvm / connector:winvm-a2a。
   * resolveAccountIds 优先返回已知活跃 uuid，并遍历 connectors/ 下所有账户目录做兜底。 */
  const accountIds = resolveAccountIds(hostRoot, args.account);
  console.log(`目标账户   : ${accountIds.join(', ')}`);
  console.log('');

  console.log(`已加载 ${plugin.skills.length} 个 Skill：`);
  for (const s of plugin.skills) {
    console.log(`  - ${s.id}${s.entry ? '  (总控)' : ''}`);
  }
  console.log('');

  // 以首个账户的 plan 作为「文件结构」代表打印产物规模（账户仅影响 mcp.json 落点，不影响文件数）。
  const firstPlan = renderer.plan(plugin, { ...ctx, accountId: accountIds[0] });
  console.log(`产物：${firstPlan.files.length} 个文件，${firstPlan.jsonPatches.length} 个增量补丁`);

  // 按账户循环 plan + install：每个账户各自增量合并自己的 mcp.json（绝不整体覆盖）。
  const installedFiles = [];
  const patchedFiles = [];
  const skippedFiles = [];
  const warnings = [];
  const postActions = [];
  for (const acct of accountIds) {
    const ctxFor = { ...ctx, accountId: acct };
    const planFor = renderer.plan(plugin, ctxFor);
    const resultFor = await renderer.install(planFor, ctxFor);
    if (!resultFor.ok) {
      console.error(`安装失败（账户 ${acct}）：${resultFor.error}`);
      process.exit(1);
    }
    installedFiles.push(...resultFor.installedFiles);
    patchedFiles.push(...resultFor.patchedFiles);
    skippedFiles.push(...resultFor.skippedFiles);
    warnings.push(...resultFor.warnings);
    postActions.push(...planFor.postActions);
  }

  /* ---- 全局自定义 MCP 注册（Q-connector-page）----
   * WorkBuddy「连接器 / 自定义 MCP」页面读取全局 ~/.workbuddy/mcp.json；
   * 仅写 connectors/<account>/mcp.json 时该页面看不到 winvm / winvm-a2a，
   * 会话工具面也不会注入 a2a.* 工具（9/29 卸载实战绕行手写脚本的根因之一）。
   * 同样**增量合并**：只增改本项目两条 server，不碰用户已有条目；改动前备份。 */
  {
    const globalMcpPath = join(args.home, '.workbuddy', 'mcp.json');
    const entryDirect = renderConnectorEntry(plugin.connector, plugin.connector.transports[0]);
    const entryA2a = renderConnectorEntry(plugin.a2aBridge, plugin.a2aBridge.transports[0]);
    const ourServers = { 'winvm': entryDirect, 'winvm-a2a': entryA2a };
    let globalJson = { mcpServers: {} };
    if (existsSync(globalMcpPath)) {
      try { globalJson = JSON.parse(readFileSync(globalMcpPath, 'utf8')); }
      catch { console.log(`全局 mcp.json : 解析失败（${globalMcpPath}），跳过全局注册（不影响账户级注册）`); globalJson = null; }
    }
    if (globalJson) {
      globalJson.mcpServers = globalJson.mcpServers && typeof globalJson.mcpServers === 'object' ? globalJson.mcpServers : {};
      let changed = false;
      for (const [k, v] of Object.entries(ourServers)) {
        const prev = JSON.stringify(globalJson.mcpServers[k] ?? null);
        const next = JSON.stringify(v);
        if (prev !== next) { globalJson.mcpServers[k] = v; changed = true; }
      }
      if (args.dryRun) {
        console.log(`全局 mcp.json : ${changed ? '[dry-run 将增量合并 winvm / winvm-a2a]' : 'winvm / winvm-a2a 已就位（无变化）'} → ${globalMcpPath}`);
      } else if (changed || !existsSync(globalMcpPath)) {
        const bak = backupFile(globalMcpPath);
        writeFileSync(globalMcpPath, JSON.stringify(globalJson, null, 2) + '\n', 'utf8');
        console.log(`全局 mcp.json : 已增量合并 winvm / winvm-a2a → ${globalMcpPath}${bak ? `（备份 ${bak}）` : ''}`);
        patchedFiles.push(globalMcpPath);
      } else {
        console.log(`全局 mcp.json : winvm / winvm-a2a 已就位（无变化）`);
      }
    }
  }

  // 多账户会重复同一 pluginRoot 下的文件路径与同名告警，汇总后去重再打印。
  const uniq = (arr) => [...new Set(arr)];
  const installedAll = uniq(installedFiles);
  const patchedAll = uniq(patchedFiles);
  const skippedAll = uniq(skippedFiles);
  const warningsAll = uniq(warnings);
  const postActionsAll = uniq(postActions);

  /* ---- 正式注册：写入 installed_plugins.json + 清 .orphaned_at ----
   * 让插件在 WorkBuddy 里显示为"已安装"而非孤儿，不依赖运行时扫描时机。 */
  registerInstalledPlugin(args.home, paths.pluginRoot, plugin.manifest.version, args.dryRun);

  /* ---- 启用插件（D16）：平台以 settings.json.enabledPlugins 为准 ----
   * 「已注册」(installed_plugins.json) ≠ 「已启用」。缺失 enabledPlugins 键时，插件声明的
   * hooks（含 SessionStart 隧道自启动）不会被平台加载。故与"正式注册"配套 merge 写入该键。
   * 非致命：失败仅告警，不影响安装主干（用户可手工在 settings.json 添加）。 */
  try {
    const r = enablePlugin('winvm-bridge@winvm', args.home, args.dryRun);
    console.log(
      r.changed
        ? `插件启用   : ${args.dryRun ? '[dry-run 将] ' : ''}已把 winvm-bridge@winvm 写入 enabledPlugins（${r.path}）`
        : '插件启用   : enabledPlugins 已含 winvm-bridge@winvm（跳过）',
    );
  } catch (e) {
    console.log(`  ⚠ 写入 enabledPlugins 失败（可手动在 settings.json 添加 "winvm-bridge@winvm": true）：${e.message}`);
  }

  /* ---- 部署插件管理 CLI winvm-plugin（host 侧）----
   * 落盘到插件缓存根（自动识别 side=host），并额外在仓库 delivery/ 放一套启动器，
   * 使在仓库目录里也能 `./delivery/winvm-plugin <cmd>` / `node delivery/winvm-plugin.mjs <cmd>`。
   * 启动器三件套（.mjs + .cmd + 无扩展名 bash 启动器 +x）由 deployWinvmPlugin 统一生成。 */
  if (!args.dryRun) {
    // 附带文件：把隧道运行时（oh-tunnel / ssh2-resolve / tunnel-daemon）一并落到插件缓存根，
    // 否则缓存侧启动器执行隧道路径会 ERR_MODULE_NOT_FOUND（CL-015 T13 / G3）。
    deployWinvmPlugin({ targetDir: paths.pluginRoot, side: 'host', dryRun: false, log: (m) => console.log(`管理命令     : ${m}`), repoRoot, extraFiles: ['oh-tunnel.mjs', 'ssh2-resolve.mjs', 'tunnel-daemon.mjs', 'hooks/hooks.json', 'hooks/session-start.sh'] });
    // 仓库 delivery 部署：不写 .winvm-context.json（避免 side:host 随 tar 发到 VM；VM 侧由 install-vm 写 side:vm）
    deployWinvmPlugin({ targetDir: join(repoRoot, 'delivery'), side: 'host', dryRun: false, writeContext: false, log: (m) => console.log(`管理命令(仓库): ${m}`), repoRoot, extraFiles: ['oh-tunnel.mjs', 'ssh2-resolve.mjs', 'tunnel-daemon.mjs'] });
    /* ---- 沙箱白名单注入（T07 / P0-R4）：把本插件运行期写路径加入 settings.json 的
     * sandbox.extraAllowWrite，使 OH/Linux 沙箱内的 WorkBuddy 可写插件缓存与 winvm 运行目录。
     * 非致命：失败仅告警，不影响安装主干。 */
    try {
      injectSandboxAllowWrite(
        args.home,
        [join(args.home, '.workbuddy', 'winvm'), paths.pluginRoot, join(args.home, '.workbuddy', 'connectors')],
        false,
      );
      console.log('沙箱白名单 : 已把本插件路径写入 settings.json（回滚见 *.winvm-bak.*）');
    } catch (e) {
      console.log('  ⚠ 写入沙箱白名单失败（可手动加）：' + e.message);
    }
    // PATH：把插件缓存根加入用户 PATH，使 `winvm-plugin` 全局可用（幂等）。
    try {
      const changed = addToUserPath(paths.pluginRoot, { dryRun: false });
      console.log(`管理命令     : ${changed ? `已把 ${paths.pluginRoot} 加入用户 PATH（新开终端生效）` : `用户 PATH 已含 ${paths.pluginRoot}（跳过）`}`);
    } catch (e) {
      console.log(`  ⚠ 加入 PATH 失败（不影响安装，可手动加）：${e.message}`);
    }
    /* ---- 持久化 VM 连接配置（vm-conn.json）----
     * 使宿主侧 winvm-plugin health/server/command 无需每次传 --vm-host/--vm-user。
     * 取值优先级：显式 --vm-* > 现有 --host/--user（来自 WINVM_HOST/WINVM_USER）> 默认值。 */
    try {
      const connHost = args.vmHost ?? args.host;
      const connUser = args.vmUser ?? args.user;
      const connSshPort = args.vmSshPort ?? 22;
      const connServicePort = args.vmPort ?? args.remotePort;
      const connPath = writeVmConnConfig({ host: connHost, user: connUser, sshPort: connSshPort, servicePort: connServicePort, identityFile: effectiveVmKey }, args.home);
      console.log(`VM 连接配置 : 已写入 ${connPath}（host=${connHost} user=${connUser} port=${connServicePort}）`);
    } catch (e) {
      console.log(`  ⚠ 写入 VM 连接配置失败（可忽略，手动指定 --vm-host/--vm-user 仍可用）：${e.message}`);
    }
    /* ---- ssh2 运行时依赖离线分发（T11 / P0-01）----
     * 把 ssh2 + 纯 JS 传递依赖扁平落地到插件缓存根 node_modules；
     * 使鸿蒙宿主上进程内隧道 import('ssh2') 可由 ESM 向上查找命中（pluginRoot/node_modules/ssh2）。
     * best-effort、失败仅告警；win32/darwin 不使用 ssh2 后端，文件惰性无害。 */
    try {
      copySsh2Runtime(join(paths.pluginRoot, 'node_modules'), repoRoot, false);
    } catch (e) {
      console.log(`  ⚠ ssh2 依赖分发失败（隧道将不可用）：${e.message}`);
    }
    /* ---- 常驻隧道 daemon 拉起（T12 / G2）----
     * 仅鸿蒙宿主（或因 WINVM_TUNNEL_BACKEND=ssh2 强制）且非 --no-tunnel 时，
     * 安装尾零人工动作拉起进程内 ssh2 隧道 daemon（detached + unref，父退出后存活）。
     * 使用 `tunnel ensure`（幂等：已在运行则跳过，不产生第二实例），使本步对任意（重）安装都安全。
     * 失败仅告警，不影响安装主干；用户可手动 `winvm-plugin tunnel ensure` 补拉。
     * 同时写「启动服务标记」tunnel-autostart.json，供 WorkBuddy 启动钩子（或用户手动）确认
     * 本插件需随 WorkBuddy 启动自动拉起隧道——即"注册为 WorkBuddy 启动服务"。 */
    if (!args.noTunnel && (process.platform === 'ohos' || process.platform === 'openharmony' || process.env['WINVM_TUNNEL_BACKEND'] === 'ssh2')) {
      try {
        const wvPlugin = join(repoRoot, 'delivery', 'winvm-plugin.mjs');
        const r = spawnSync(process.execPath, [wvPlugin, 'tunnel', 'ensure'], { stdio: 'inherit', env: process.env });
        if (r.status !== 0) console.log('  ⚠ 隧道 daemon 拉起失败（不影响安装，可手动 winvm-plugin tunnel ensure）');
        else console.log('常驻隧道   : 已拉起（零人工动作；winvm-plugin tunnel status 查看）');
        // 写启动服务标记：声明本插件需在 WorkBuddy 启动时自动 ensure 隧道（注册为启动服务）。
        try {
          const autoPath = join(args.home, '.workbuddy', 'winvm', 'tunnel-autostart.json');
          mkdirSync(dirname(autoPath), { recursive: true });
          writeFileSync(autoPath, JSON.stringify({ enabled: true, command: 'winvm-plugin', args: ['tunnel', 'ensure'], updatedAt: new Date().toISOString() }, null, 2) + '\n', 'utf8');
          console.log('启动服务   : 已写 tunnel-autostart.json（WorkBuddy 启动时可据此自动 ensure 隧道）');
        } catch (e) {
          console.log(`  ⚠ 写启动服务标记失败（不影响隧道，可忽略）：${e.message}`);
        }
      } catch (e) {
        console.log(`  ⚠ 隧道 daemon 拉起异常（可手动 winvm-plugin tunnel ensure）：${e.message}`);
      }
    }
  }

  console.log('');
  console.log(`已写入文件   : ${installedAll.length}`);
  console.log(`已增量合并   : ${patchedAll.join(', ') || '(无)'}`);
  if (skippedAll.length > 0) {
    console.log(`已跳过（存在）: ${skippedAll.length}`);
  }

  if (warningsAll.length > 0) {
    console.log('');
    console.log('注意事项：');
    for (const w of warningsAll) console.log(`  ⚠ ${w}`);
  }

  console.log('');
  console.log('后续动作：');
  for (const a of postActionsAll) console.log(`  → ${a}`);

  /* ---- 连接器注入自检（R17-T04 / R2-2）：安装末尾跑一次只读诊断 ----
   * 目的：全局与各 account 双处注册在“安装后即刻可验证”，并把“新会话未注入工具”的
   * 自助三步路径打印在用户眼前（trust 启用 → 重开新会话 → 诊断工具 + troubleshooting）。
   * 诊断工具为**纯只读**（零写入/零网络/零解密，见 delivery/tools/diagnose-connectors.mjs 头注）。
   * 非致命：任何异常仅告警，绝不影响安装主干。卸载相位走不到这里（--uninstall 提前 return）。 */
  runConnectorSelfCheck(args.home, args.dryRun);
}

/**
 * 安装末尾的连接器注入自检：调用只读诊断工具并打印摘要 + 自助指引。
 *
 * dry-run 语义（本仓历史踩坑，铁律）：**只打印将执行什么，绝不实际 spawn**；
 * 诊断工具自身虽只读，但 dry-run 下连子进程都不该拉起，保持“零副作用”可核验。
 *
 * @param {string} home 目标用户主目录
 * @param {boolean} dryRun 安装器 --dry-run 标志
 * @returns {{ ran: boolean, ok?: boolean, failures?: string[], warnings?: string[], error?: string }}
 */
export function runConnectorSelfCheck(home, dryRun) {
  const toolPath = join(dirname(fileURLToPath(import.meta.url)), 'tools', 'diagnose-connectors.mjs');
  if (dryRun) {
    console.log('');
    console.log(`连接器自检 : [dry-run 将执行] ${process.execPath} ${toolPath} --json（纯只读，零写入/零 spawn/零网络/零解密）`);
    return { ran: false };
  }
  console.log('');
  try {
    if (!existsSync(toolPath)) {
      console.log(`连接器自检 : ⚠ 诊断工具缺失（${toolPath}），跳过（不影响安装结果）`);
      return { ran: false, error: 'tool-missing' };
    }
    // 只读子进程：node + 诊断脚本 --json。脚本自身保证不写盘、不发网络请求。
    const r = spawnSync(process.execPath, [toolPath, '--json'], { encoding: 'utf8', timeout: 30000, env: process.env });
    if (r.error) {
      console.log(`连接器自检 : ⚠ 诊断子进程异常（${r.error.message}），跳过（不影响安装结果）`);
      return { ran: false, error: r.error.message };
    }
    let report = null;
    try {
      report = JSON.parse(r.stdout);
    } catch {
      console.log(`连接器自检 : ⚠ 诊断输出非 JSON（exit=${r.status}），可手动复跑：node ${toolPath}`);
      return { ran: false, error: 'unparsable-output' };
    }
    const failures = Array.isArray(report.failures) ? report.failures : [];
    const warnings = Array.isArray(report.warnings) ? report.warnings : [];
    console.log(`连接器自检 : ${report.ok ? '注册面就位 ✓' : `发现 ${failures.length} 项必需缺失 ✗`}（exit=${r.status}）`);
    for (const f of failures) console.log(`  ✗ ${f}`);
    for (const w of warnings) console.log(`  ⚠ ${w}`);
    console.log('  若新会话 ToolSearch 找不到 winvm__* / a2a.* 工具：');
    console.log('    ① WorkBuddy 连接器页确认 winvm / winvm-a2a 已「信任 + 启用」；');
    console.log('    ② 重开一个新会话（旧会话永不热注入，属平台会话生命周期预期行为）；');
    console.log(`    ③ 仍异常则跑 node ${toolPath} 并按 docs/INSTALL-GUIDE.md troubleshooting 处置。`);
    return { ran: true, ok: !!report.ok, failures, warnings };
  } catch (e) {
    console.log(`连接器自检 : ⚠ 自检异常（${e.message}），跳过（不影响安装结果）`);
    return { ran: false, error: e.message };
  }
}

const __filename = fileURLToPath(import.meta.url);

if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  main().catch((e) => {
    console.error(`安装失败：${e.message}`);
    process.exit(1);
  });
}

/**
 * 持久化 VM 连接配置到 ~/.workbuddy/winvm/vm-conn.json。
 * 宿主侧 winvm-plugin health/server/command 会经 loadVmConn 读取它，免去每次传 --vm-host/--vm-user。
 * @param {{host:string,user:string,sshPort?:number,servicePort?:number}} cfg
 * @param {string} [home] 目标用户主目录（默认当前用户）；测试可注入临时目录。
 * @returns {string} 写入的文件路径
 */
export function writeVmConnConfig({ host, user, sshPort = 22, servicePort = 18443, identityFile }, home = homedir()) {
  const connPath = join(home, '.workbuddy', 'winvm', 'vm-conn.json');
  mkdirSync(dirname(connPath), { recursive: true });
  // D5：**合并写入**（读旧 payload → 覆盖本次提供的字段 → 其余保留），不再整包覆盖，
  // 避免丢失 identityFile 等既有字段（旧实现只写 host/user/sshPort/servicePort，会清掉其它键）。
  const prev = readJsonSafe(connPath) || {};
  const payload = { ...prev };
  if (host !== undefined) payload.host = host;
  if (user !== undefined) payload.user = user;
  payload.sshPort = sshPort; // 端口带默认值，始终写入
  payload.servicePort = servicePort;
  if (identityFile !== undefined) payload.identityFile = identityFile;
  writeFileSync(connPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return connPath;
}

/** 移除持久化的 VM 连接配置；不存在则视为已清理（返回 false）。 */
export function removeVmConnConfig(home = homedir()) {
  const connPath = join(home, '.workbuddy', 'winvm', 'vm-conn.json');
  if (existsSync(connPath)) { rmSync(connPath, { force: true }); return true; }
  return false;
}

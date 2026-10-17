#!/usr/bin/env node
/**
 * WinVM Bridge - two-end full uninstaller (host + VM).
 *
 * Pairs with bootstrap.mjs / setup.mjs: removes EVERYTHING the delivery
 * pipeline deployed, so a fresh `bootstrap.mjs all` + `setup.mjs --apply`
 * can be run afterwards as a clean reinstall.
 *
 * Usage:
 *   node delivery/uninstall.mjs                 # DRY-RUN (default): list every planned action
 *   node delivery/uninstall.mjs --apply         # actually execute the cleanup
 *
 * Options:
 *   --apply              Execute for real (without it nothing is modified).
 *   --keep-workspace     Keep C:/WinVMWorkspace on the VM (this is the DEFAULT;
 *                        the workspace holds runtime user data. Flag exists for
 *                        explicitness only).
 *   --purge-workspace    ALSO delete C:/WinVMWorkspace on the VM (destructive:
 *                        removes runtime user data produced while the plugin ran).
 *   --keep-keys          No-op safety flag: SSH passwordless config (authorized_keys,
 *                        OpenSSH Server) is NEVER touched by this script - OS level,
 *                        not part of the plugin deployment. Flag exists to make the
 *                        intent explicit in scripted invocations.
 *   --vm-host <ip>       Override VM address (default: env WINVM_VM_HOST >
 *                        ~/.workbuddy/winvm/vm-conn.json > error).
 *   --vm-user <name>     Override VM user (same resolution chain).
 *   --vm-ssh-port <n>    Override VM SSH port (default chain, fallback 22).
 *   --host-root <dir>    Override the WorkBuddy root (default: ~/.workbuddy).
 *   --trash-dir <dir>    Override host-side trash dir (default ~/.workbuddy/winvm-trash).
 *
 * What gets removed (mirror image of install-host.mjs / install-vm.mjs / setup.mjs):
 *   HOST (this machine, e.g. HarmonyOS):
 *     - resident ssh2 tunnel daemon process (killed by recorded PID only, never pkill)
 *     - ~/.workbuddy/plugins/cache/winvm/            (plugin cache + A2A bridge + launchers)
 *     - ~/.workbuddy/plugins/marketplaces/winvm/     (marketplace manifest dir)
 *     - ~/.workbuddy/connectors/skills/connector-winvm/  (1+6 connector skills)
 *     - installed_plugins.json entry "winvm-bridge@winvm"   (backup kept)
 *     - connectors/<account>/mcp.json keys connector:winvm + connector:winvm-a2a (backup kept)
 *     - settings.json sandbox.extraAllowWrite entries added by install (backup kept)
 *     - settings.json enabledPlugins["winvm-bridge@winvm"] added by install (backup kept) [D16]
 *     - user PATH / shell profile injection (shell-init.sh line + .bashrc/.profile block)
 *     - ~/.workbuddy/winvm/ marker files: side.json, vm-conn.json, shell-init.sh,
 *       tunnel.state.json, tunnel.pid, tunnel.log, known_hosts (directory itself kept)
 *   VM (Windows, e.g. 172.16.100.2):
 *     - scheduled task WinVMBridge.Service (schtasks /End + /Delete)
 *     - vm-service node process tree + start-hidden.ps1 wrappers (identified by
 *       "C:\WinVMBridge" command-line signature - NEVER by executable path, because
 *       the service node binary lives under the user's node install, shared with
 *       WorkBuddy's own MCP servers)
 *     - C:/WinVMBridge/ (program + dist + shared-skills + all QA scratch files)
 *     - junctions under VM agent skill dirs pointing into C:\WinVMBridge\shared-skills
 *     - VM user PATH entry C:\WinVMBridge\delivery
 *     - VM-side marker ~/.workbuddy/winvm/side.json
 *     - C:/WinVMWorkspace only with --purge-workspace (default: KEPT)
 *
 * NEVER touched (by design):
 *   - the project repository itself, project .env
 *   - ~/.ssh on both ends (keys, authorized_keys), OpenSSH Server on the VM
 *   - the host WorkBuddy application, other plugins / connectors / skills
 *   - VM node runtimes, VM WorkBuddy plugin caches (workbuddy-builtin etc.)
 *
 * Remote PowerShell rule (MSYS path mangling): all VM-side logic lives in a
 * generated .ps1 that is scp'd to the VM and executed with
 * `powershell -NoProfile -ExecutionPolicy Bypass -File`. Never inline PS over ssh.
 *
 * Exit code: 0 when no hard failure; 1 when one or more apply steps failed.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  renameSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { removeFromUserPath } from './path-util.mjs';

/* ------------------------------ constants ------------------------------ */

const PLUGIN_KEY = 'winvm-bridge@winvm';
const CONNECTOR_KEYS = ['connector:winvm', 'connector:winvm-a2a'];
const SERVICE_TASK = 'WinVMBridge.Service';
const SERVICE_PORT = 18443;
const VM_BRIDGE_DIR = 'C:/WinVMBridge';
const VM_WORKSPACE_DIR = 'C:/WinVMWorkspace';
const VM_REMOTE_PS1 = 'winvm-un.ps1';
const PATH_PROFILE_MARKER = '# WinVM Bridge PATH';

const __dirname = dirname(fileURLToPath(import.meta.url));

/* ------------------------------ small helpers ------------------------------ */

function ts() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function readJsonSafe(p) {
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** Normalize a path entry for comparisons (trailing slashes / whitespace / backslashes). */
function normPath(p) {
  return String(p).replace(/[\\/]+$/g, '').trim();
}

/** Move a file or directory into the trash dir (recoverable). Returns dest path. */
function moveToTrash(target, trashBase, dryRun, log) {
  if (!existsSync(target)) {
    log(`[SKIP] not present: ${target}`);
    return null;
  }
  const name = target.replace(/[/\\]$/, '').split(/[/\\]/).pop() || 'item';
  const dest = join(trashBase, `${ts()}`, name);
  if (dryRun) {
    log(`[DRY] trash <- ${target}\n         -> ${dest}`);
    return dest;
  }
  mkdirSync(dirname(dest), { recursive: true });
  renameSync(target, dest);
  log(`[DO]  trash <- ${target}\n         -> ${dest}`);
  return dest;
}

/** Backup a file next to itself before an in-place edit. Returns backup path or null. */
function backupFile(p, dryRun) {
  if (dryRun) return null;
  if (!existsSync(p)) return null;
  const bak = `${p}.winvm-bak.${ts()}`;
  try {
    const content = readFileSync(p);
    writeFileSync(bak, content);
    return bak;
  } catch {
    return null;
  }
}

/* ------------------------------ CLI parsing ------------------------------ */

function parseArgs(argv) {
  const out = {
    apply: false,
    keepWorkspace: false,
    purgeWorkspace: false,
    keepKeys: false,
    vmHost: process.env['WINVM_VM_HOST'] || undefined,
    vmUser: process.env['WINVM_VM_USER'] || undefined,
    vmSshPort: process.env['WINVM_VM_SSH_PORT'] ? Number(process.env['WINVM_VM_SSH_PORT']) : undefined,
    hostRoot: undefined,
    trashDir: undefined,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--apply': out.apply = true; break;
      case '--keep-workspace': out.keepWorkspace = true; break;
      case '--purge-workspace': out.purgeWorkspace = true; break;
      case '--keep-keys': out.keepKeys = true; break;
      case '--vm-host': out.vmHost = argv[++i]; break;
      case '--vm-user': out.vmUser = argv[++i]; break;
      case '--vm-ssh-port': out.vmSshPort = Number(argv[++i]); break;
      case '--host-root': out.hostRoot = argv[++i]; break;
      case '--trash-dir': out.trashDir = argv[++i]; break;
      case '--help': case '-h': out.help = true; break;
      default: break; // unknown flags ignored (forward compatibility)
    }
  }
  return out;
}

function printHelp() {
  console.log(`WinVM Bridge uninstaller (host + VM)

Usage:
  node delivery/uninstall.mjs                 # dry-run: list planned actions
  node delivery/uninstall.mjs --apply         # execute the cleanup

Options:
  --apply              Execute for real (default is dry-run).
  --keep-workspace     Keep C:/WinVMWorkspace on the VM (DEFAULT behavior;
                       explicit flag for clarity). Runtime user data is kept.
  --purge-workspace    ALSO delete C:/WinVMWorkspace (destructive).
  --keep-keys          No-op: SSH keys / authorized_keys / OpenSSH Server are
                       NEVER touched (OS level, not plugin deployment).
  --vm-host <ip>       VM address (default: env WINVM_VM_HOST > vm-conn.json).
  --vm-user <name>     VM user (default: env WINVM_VM_USER > vm-conn.json).
  --vm-ssh-port <n>    VM SSH port (default chain, fallback 22).
  --host-root <dir>    Override WorkBuddy root (default ~/.workbuddy).
  --trash-dir <dir>    Override host trash dir (default ~/.workbuddy/winvm-trash).`);
}

/* ------------------------------ config resolution ------------------------------ */

/** Minimal .env parser (same semantics as setup.mjs: quotes + inline comments). */
function parseEnvFile(p) {
  if (!existsSync(p)) return {};
  const out = {};
  try {
    for (const raw of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if (val.length >= 2 && (val[0] === '"' || val[0] === "'")) {
        const q = val[0];
        const close = val.lastIndexOf(q);
        val = close > 0 ? val.slice(1, close) : val.slice(1);
      } else {
        val = val.replace(/\s+#.*$/, '');
      }
      out[key] = val;
    }
  } catch {
    /* unreadable .env - ignore */
  }
  return out;
}

/**
 * Resolve the VM target. Priority chain (read-only sources, never modified):
 * CLI flag > environment variable > persisted vm-conn.json (if still present) >
 * project .env (VM_HOST / VM_USER / VM_SSH_PORT). The .env fallback keeps the
 * script idempotent: after the first apply deletes vm-conn.json, re-runs and
 * re-verification can still reach the VM.
 */
function resolveVmTarget(args, home) {
  const conn = readJsonSafe(join(home, '.workbuddy', 'winvm', 'vm-conn.json')) || {};
  const env = parseEnvFile(resolve(__dirname, '..', '.env'));
  const host = args.vmHost || conn.host || env['VM_HOST'];
  const user = args.vmUser || conn.user || env['VM_USER'];
  const sshPort = args.vmSshPort || conn.sshPort || env['VM_SSH_PORT'] || 22;
  if (!host || !user) {
    return null;
  }
  return { host, user, sshPort: Number(sshPort) || 22 };
}

/* ------------------------------ HOST: tunnel daemon ------------------------------ */

/** Read /proc/<pid>/cmdline (best effort, '' when unavailable). */
function pidCmdline(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
  } catch {
    return '';
  }
}

function pidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function collectTunnelPids(home) {
  const winvmDir = join(home, '.workbuddy', 'winvm');
  const pids = new Set();
  const pidfile = readJsonSafe(join(winvmDir, 'tunnel.pid'));
  if (pidfile?.pid) pids.add(Number(pidfile.pid));
  const state = readJsonSafe(join(winvmDir, 'tunnel.state.json'));
  if (state?.pid) pids.add(Number(state.pid));
  // Fallback: scan /proc for the daemon signature (precise - only tunnel-daemon.mjs,
  // never the generic `ssh -N -L` suicide pattern).
  try {
    for (const ent of readdirSync('/proc')) {
      if (!/^\d+$/.test(ent)) continue;
      const pid = Number(ent);
      if (pid === process.pid) continue;
      const cmd = pidCmdline(pid);
      if (cmd.includes('tunnel-daemon.mjs') || cmd.includes('oh-tunnel.mjs')) pids.add(pid);
    }
  } catch {
    /* /proc not available - recorded PIDs only */
  }
  return [...pids].filter((p) => pidAlive(p) && p !== process.pid);
}

/**
 * Legacy plain-ssh local forwards left over from the bootstrap-era tunnel
 * (`ssh -fN -L 18443:127.0.0.1:18443 user@vm`). Identified PRECISELY by the
 * full "-L <port>:127.0.0.1:<port>" signature in the command line and killed
 * per-PID - never via a generic pkill pattern.
 */
function collectLegacySshForwardPids() {
  const signature = `-L ${SERVICE_PORT}:127.0.0.1:${SERVICE_PORT}`;
  const pids = [];
  try {
    for (const ent of readdirSync('/proc')) {
      if (!/^\d+$/.test(ent)) continue;
      const pid = Number(ent);
      if (pid === process.pid) continue;
      const cmd = pidCmdline(pid);
      if (cmd.includes('ssh') && cmd.includes(signature)) pids.push(pid);
    }
  } catch {
    /* /proc not available */
  }
  return pids.filter((p) => pidAlive(p) && p !== process.pid);
}

function stopTunnelDaemon(home, dryRun, log) {
  let ok = true;
  const pids = collectTunnelPids(home);
  if (pids.length === 0) {
    log('[SKIP] no resident tunnel daemon process found');
  }
  for (const pid of pids) {
    const cmd = pidCmdline(pid);
    // Safety: only kill if the command line really looks like our tunnel daemon.
    if (cmd && !cmd.includes('tunnel-daemon.mjs') && !cmd.includes('oh-tunnel.mjs')) {
      log(`[SKIP] pid ${pid} alive but command line is not a tunnel daemon: ${cmd.slice(0, 120)}`);
      continue;
    }
    if (dryRun) {
      log(`[DRY] kill tunnel daemon pid ${pid} (${cmd.slice(0, 120) || 'cmdline unavailable'})`);
      continue;
    }
    try {
      process.kill(pid, 'SIGTERM');
      setTimeout(() => {
        try {
          if (pidAlive(pid)) process.kill(pid, 'SIGKILL');
        } catch { /* already gone */ }
      }, 1500).unref();
      log(`[DO]  killed tunnel daemon pid ${pid}`);
    } catch (e) {
      log(`[WARN] failed to kill pid ${pid}: ${e.message}`);
      ok = false;
    }
  }
  // Legacy plain-ssh local forwards (bootstrap-era): same precise per-PID kill.
  const legacy = collectLegacySshForwardPids();
  if (legacy.length === 0) {
    log(`[SKIP] no legacy "ssh -L ${SERVICE_PORT}" forward process found`);
  }
  for (const pid of legacy) {
    const cmd = pidCmdline(pid);
    if (dryRun) {
      log(`[DRY] kill legacy ssh forward pid ${pid} (${cmd.slice(0, 140)})`);
      continue;
    }
    try {
      process.kill(pid, 'SIGTERM');
      setTimeout(() => {
        try {
          if (pidAlive(pid)) process.kill(pid, 'SIGKILL');
        } catch { /* already gone */ }
      }, 1500).unref();
      log(`[DO]  killed legacy ssh forward pid ${pid} (${cmd.slice(0, 140)})`);
    } catch (e) {
      log(`[WARN] failed to kill legacy ssh forward pid ${pid}: ${e.message}`);
      ok = false;
    }
  }
  return ok;
}

/* ------------------------------ HOST: registry / connectors / sandbox ------------------------------ */

function cleanInstalledPlugins(hostRoot, dryRun, log) {
  const p = join(hostRoot, 'plugins', 'installed_plugins.json');
  const json = readJsonSafe(p);
  if (!json || !json.plugins || !json.plugins[PLUGIN_KEY]) {
    log(`[SKIP] ${p}: no "${PLUGIN_KEY}" entry`);
    return true;
  }
  const bak = backupFile(p, dryRun);
  if (!dryRun) {
    delete json.plugins[PLUGIN_KEY];
    writeFileSync(p, JSON.stringify(json, null, 2) + '\n', 'utf8');
  }
  log(`${dryRun ? '[DRY]' : '[DO] '} installed_plugins.json: remove "${PLUGIN_KEY}"${bak ? ` (backup: ${bak})` : ''}`);
  return true;
}

function cleanConnectorMcpJson(hostRoot, dryRun, log) {
  const root = join(hostRoot, 'connectors');
  if (!existsSync(root)) {
    log('[SKIP] connectors/ not present');
    return true;
  }
  let found = 0;
  for (const ent of readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const p = join(root, ent.name, 'mcp.json');
    const json = readJsonSafe(p);
    const servers = json && json.mcpServers && typeof json.mcpServers === 'object' ? json.mcpServers : null;
    if (!servers) continue;
    const hits = CONNECTOR_KEYS.filter((k) => k in servers);
    if (hits.length === 0) continue;
    found += hits.length;
    const bak = backupFile(p, dryRun);
    if (!dryRun) {
      for (const k of hits) delete servers[k];
      writeFileSync(p, JSON.stringify(json, null, 2) + '\n', 'utf8');
    }
    log(`${dryRun ? '[DRY]' : '[DO] '} ${p}: remove ${hits.join(', ')}${bak ? ` (backup: ${bak})` : ''}`);
  }
  if (found === 0) log('[SKIP] no winvm connector entries in any connectors/*/mcp.json');
  return true;
}

/* D16 第二重问题：仅从 installed_plugins.json 移除条目 ≠ 停用插件。
 * 平台以 settings.json.enabledPlugins 为启用真相源；残留该键会让平台继续加载已移除的
 * hooks（SessionStart 隧道自启动）。故卸载必须对称地把该键移除。 */
function cleanEnabledPlugins(hostRoot, dryRun, log) {
  const p = join(hostRoot, 'settings.json');
  const json = readJsonSafe(p);
  const map =
    json && json.enabledPlugins && typeof json.enabledPlugins === 'object' && !Array.isArray(json.enabledPlugins)
      ? json.enabledPlugins
      : null;
  if (!map) {
    log('[SKIP] settings.json: no enabledPlugins map');
    return true;
  }
  if (!(PLUGIN_KEY in map)) {
    log(`[SKIP] settings.json: enabledPlugins has no "${PLUGIN_KEY}"`);
    return true;
  }
  const bak = backupFile(p, dryRun);
  if (!dryRun) {
    delete map[PLUGIN_KEY];
    writeFileSync(p, JSON.stringify(json, null, 2) + '\n', 'utf8');
  }
  log(`${dryRun ? '[DRY]' : '[DO] '} settings.json: remove "${PLUGIN_KEY}" from enabledPlugins${bak ? ` (backup: ${bak})` : ''}`);
  return true;
}

function cleanSandboxAllowWrite(hostRoot, home, dryRun, log) {
  const p = join(hostRoot, 'settings.json');
  const json = readJsonSafe(p);
  const list = json && json.sandbox && Array.isArray(json.sandbox.extraAllowWrite)
    ? json.sandbox.extraAllowWrite
    : null;
  if (!list) {
    log('[SKIP] settings.json: no sandbox.extraAllowWrite list');
    return true;
  }
  // Entries install-host.mjs injected (absolute paths); compare normalized, and
  // also allow "~/..." spellings that resolve to the same location.
  const targets = new Set([
    normPath(join(home, '.workbuddy', 'winvm')),
    normPath(join(home, '.workbuddy', 'plugins', 'cache', 'winvm', 'winvm-bridge', '0.1.0')),
    normPath(join(home, '.workbuddy', 'connectors')),
  ]);
  const isTarget = (entry) => {
    const n = normPath(entry);
    if (targets.has(n)) return true;
    const expanded = n.startsWith('~/') ? normPath(join(home, n.slice(2))) : n;
    return targets.has(expanded);
  };
  const kept = list.filter((x) => !isTarget(x));
  const removedCount = list.length - kept.length;
  if (removedCount === 0) {
    log('[SKIP] settings.json: no winvm entries in sandbox.extraAllowWrite');
    return true;
  }
  const bak = backupFile(p, dryRun);
  if (!dryRun) {
    json.sandbox.extraAllowWrite = kept;
    writeFileSync(p, JSON.stringify(json, null, 2) + '\n', 'utf8');
  }
  log(`${dryRun ? '[DRY]' : '[DO] '} settings.json: remove ${removedCount} winvm sandbox.extraAllowWrite entries${bak ? ` (backup: ${bak})` : ''}`);
  return true;
}

/* ------------------------------ HOST: PATH / profile ------------------------------ */

function cleanHostPath(pluginCacheRoot, dryRun, log) {
  try {
    const changed = removeFromUserPath(pluginCacheRoot, { dryRun });
    const verb = dryRun ? 'will remove' : 'removed';
    log(`[DO]  user PATH / shell profile: ${changed ? `${verb} winvm plugin cache entries` : 'no winvm entries present (nothing to do)'}`);
    return true;
  } catch (e) {
    log(`[WARN] PATH/profile cleanup failed: ${e.message}`);
    return false;
  }
}

/* ------------------------------ HOST: winvm marker files ------------------------------ */

function cleanWinvmMarkerFiles(home, dryRun, log) {
  const dir = join(home, '.workbuddy', 'winvm');
  if (!existsSync(dir)) {
    log('[SKIP] ~/.workbuddy/winvm/ not present');
    return true;
  }
  // Files written by install scripts / tunnel daemon / oh-tunnel (TOFU known_hosts).
  const markers = ['side.json', 'vm-conn.json', 'shell-init.sh', 'tunnel.state.json', 'tunnel.pid', 'tunnel.log', 'known_hosts'];
  for (const name of markers) {
    const p = join(dir, name);
    if (!existsSync(p)) continue;
    if (dryRun) {
      log(`[DRY] delete ${p}`);
      continue;
    }
    try {
      unlinkSync(p);
      log(`[DO]  deleted ${p}`);
    } catch (e) {
      log(`[WARN] failed to delete ${p}: ${e.message}`);
    }
  }
  // shell-init.sh may survive if it held extra user lines - path-util only removes
  // our line; report leftovers honestly instead of hard-deleting.
  const init = join(dir, 'shell-init.sh');
  if (!dryRun && existsSync(init)) {
    log(`[NOTE] ${init} kept: it contains non-plugin lines (path-util removed only our entry)`);
  }
  log('[NOTE] directory ~/.workbuddy/winvm/ itself is kept (shared runtime dir)');
  return true;
}

/* ------------------------------ HOST: directories to trash ------------------------------ */

function cleanHostDirectories(hostRoot, trashBase, dryRun, log) {
  const targets = [
    join(hostRoot, 'plugins', 'cache', 'winvm'),
    join(hostRoot, 'plugins', 'marketplaces', 'winvm'),
    join(hostRoot, 'connectors', 'skills', 'connector-winvm'),
  ];
  let ok = true;
  for (const t of targets) {
    try {
      moveToTrash(t, trashBase, dryRun, log);
    } catch (e) {
      log(`[WARN] failed to trash ${t}: ${e.message}`);
      ok = false;
    }
  }
  return ok;
}

/* ------------------------------ VM: generated PowerShell ------------------------------ */

/**
 * Build the VM-side uninstaller .ps1 (ASCII, CRLF). All remote logic lives here -
 * it is scp'd and run via `powershell -File` (never inline over ssh).
 *
 * VM 段顺序铁律（用户 2026-10-18 裁定）：**uninstall 前先查杀 VM 端本项目的
 * 看门狗与 services**。VM 侧自愈看门狗有两层，均须先于删目录熔断：
 *   ① 任务级看门狗：`WinVMBridge.Service` 的 `RestartOnFailure`（Interval PT1M /
 *      Count 3）——动作进程（start-hidden -Wait）死掉后调度器每分钟重试重启；
 *   ② 进程级看护：vm-service 对 ps-bridge 的 respawn（psBridge.restarts 字段）。
 * 故顺序为：**先 /End 熔断看门狗**（停当前实例、阻断重启窗口）→ **按签名查杀服务进程链**
 * （vm-service node / start-hidden wrapper / ps-bridge.ps1 孤儿）→ **后 /Delete 拆除
 * 看门狗注册** → 兜底复查 → 删目录。旧顺序（先 /Delete 再杀进程）在删除前留有
 * RestartOnFailure 重新拉起启动器的窗口；且未显式覆盖 ps-bridge 孤儿（vm-service
 * 先死时它脱离进程树，会继续占用 18443 令后续重装撞 EADDRINUSE）。
 *
 * Exported for unit tests (buildVmPs1 is pure: {purgeWorkspace} -> ps1 text).
 */
export function buildVmPs1({ purgeWorkspace }) {
  const lines = [
    'param(',
    '  [switch]$Apply,',
    '  [switch]$PurgeWorkspace',
    ')',
    "$ErrorActionPreference = 'Continue'",
    `$TaskName = '${SERVICE_TASK}'`,
    "$BridgeDir = 'C:\\WinVMBridge'",
    "$WorkspaceDir = 'C:\\WinVMWorkspace'",
    '$Port = ' + SERVICE_PORT,
    '$Mode = "DRY-RUN"',
    'if ($Apply) { $Mode = "APPLY" }',
    'Write-Output ("MODE=" + $Mode)',
    'function Act([string]$m) { if ($Apply) { Write-Output ("[DO]  " + $m) } else { Write-Output ("[DRY] " + $m) } }',
    '',
    '# ---------- PRE STATUS (read-only) ----------',
    "Write-Output '--- PRE STATUS ---'",
    "Write-Output ('BRIDGE_DIR=' + (Test-Path $BridgeDir))",
    "Write-Output ('WORKSPACE_DIR=' + (Test-Path $WorkspaceDir))",
    "$null = schtasks /Query /TN $TaskName 2> $null",
    "Write-Output ('TASK_EXISTS=' + ($LASTEXITCODE -eq 0))",
    "$l = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue",
    "Write-Output ('PORT_LISTEN=' + [bool]$l)",
    "$sshd = Get-Service sshd -ErrorAction SilentlyContinue",
    "Write-Output ('SSHD=' + $(if ($sshd) { $sshd.Status } else { 'NOT_FOUND' }))",
    "Write-Output ('AUTH_KEYS=' + (Test-Path \"$env:USERPROFILE\\.ssh\\authorized_keys\"))",
    '',
    '# ---------- 0) kill watchdog + services FIRST (user rule 2026-10-18) ----------',
    '# Signature-based (command-line) process kill helper - NEVER match by executable path:',
    '# node is shared with WorkBuddy MCP servers (workbuddy-builtin sheetagent / weixinpay ...);',
    '# killing by path would take those down too.',
    'function Kill-Sig([string]$label, [string]$exe, [string]$pattern) {',
    '  $procs = Get-CimInstance Win32_Process -Filter "Name=\'$exe\'" -ErrorAction SilentlyContinue | Where-Object { ($_.CommandLine -match $pattern) -and ($_.ProcessId -ne $PID) }',
    '  foreach ($p in $procs) {',
    '    Act ("taskkill /T /F " + $label + " PID " + $p.ProcessId)',
    '    if ($Apply) { $null = taskkill /PID $p.ProcessId /T /F 2> $null }',
    '  }',
    '}',
    '',
    '# 0a) Watchdog fuse: /End stops the task current running instance (start-hidden -Wait',
    '#     keeps the action process Running), blocking RestartOnFailure (PT1M x Count 3) from',
    '#     re-spawning the launcher inside the kill/delete window below.',
    "$null = schtasks /Query /TN $TaskName 2> $null",
    'if ($LASTEXITCODE -eq 0) {',
    '  Act ("schtasks /End (fuse watchdog RestartOnFailure) " + $TaskName)',
    '  if ($Apply) { $null = schtasks /End /TN $TaskName 2> $null }',
    '} else {',
    '  Write-Output ("[SKIP] task not present: " + $TaskName)',
    '}',
    '',
    '# 0b) Service process-chain kill. The ps-bridge.ps1 orphan MUST be covered explicitly:',
    '#     when vm-service dies first it leaves the process tree, taskkill /T cannot take it,',
    '#     and it keeps holding 18443 so the next redeploy VM-START hits bind EACCES.',
    "Kill-Sig 'vm-service node' 'node.exe' ([regex]::Escape($BridgeDir))",
    "Kill-Sig 'start-hidden wrapper' 'powershell.exe' 'start-hidden'",
    "Kill-Sig 'ps-bridge' 'powershell.exe' 'ps-bridge'",
    'if ($Apply) {',
    '  Start-Sleep -Seconds 2',
    '  $still = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue',
    '  if ($still) { Write-Output "[WARN] port still listening after service kills" }',
    '  else { Write-Output "[OK]  services killed, port freed" }',
    '}',
    '',
    '# ---------- 1) watchdog removal: /Delete the task (services dead - no restart risk) ----------',
    "$null = schtasks /Query /TN $TaskName 2> $null",
    'if ($LASTEXITCODE -eq 0) {',
    '  Act ("schtasks /Delete " + $TaskName)',
    '  if ($Apply) {',
    '    $null = schtasks /Delete /TN $TaskName /F 2> $null',
    '    if ($LASTEXITCODE -eq 0) { Write-Output ("[OK]  task removed: " + $TaskName) }',
    '    else { Write-Output ("[WARN] task delete exit=" + $LASTEXITCODE) }',
    '  }',
    '} else {',
    '  Write-Output ("[SKIP] task already absent: " + $TaskName)',
    '}',
    '',
    '# ---------- 2) leftover sweep: re-run signature kills for stragglers (idempotent) ----------',
    "Kill-Sig 'leftover vm-service node' 'node.exe' ([regex]::Escape($BridgeDir))",
    "Kill-Sig 'leftover start-hidden wrapper' 'powershell.exe' 'start-hidden'",
    "Kill-Sig 'leftover ps-bridge' 'powershell.exe' 'ps-bridge'",
    'if ($Apply) {',
    '  Start-Sleep -Seconds 2',
    '  $still2 = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue',
    '  if ($still2) { Write-Output "[WARN] port still listening after leftover sweep" }',
    '  else { Write-Output "[OK]  port freed (final)" }',
    '}',
    '',
    '# ---------- 3) remove C:/WinVMBridge ----------',
    'if (Test-Path $BridgeDir) {',
    '  Act ("Remove-Item -Recurse -Force " + $BridgeDir)',
    '  if ($Apply) { Remove-Item $BridgeDir -Recurse -Force }',
    '} else {',
    '  Write-Output "[SKIP] C:\\WinVMBridge not present"',
    '}',
    '',
    '# ---------- 4) workspace: kept by default, removed only with -PurgeWorkspace ----------',
    'if ($PurgeWorkspace) {',
    '  if (Test-Path $WorkspaceDir) {',
    '    Act ("Remove-Item -Recurse -Force " + $WorkspaceDir + " (--purge-workspace)")',
    '    if ($Apply) { Remove-Item $WorkspaceDir -Recurse -Force }',
    '  } else {',
    '    Write-Output "[SKIP] C:\\WinVMWorkspace not present"',
    '  }',
    '} else {',
    '  Write-Output ("[KEEP] workspace kept by default: " + $WorkspaceDir)',
    '}',
    '',
    '# ---------- 5) agent skill junctions pointing into the shared-skills root ----------',
    '$skillRoots = @("$env:USERPROFILE\\.workbuddy\\skills", "$env:USERPROFILE\\.hermes\\skills")',
    'foreach ($r in $skillRoots) {',
    '  if (-not (Test-Path $r)) { continue }',
    '  Get-ChildItem $r -ErrorAction SilentlyContinue | Where-Object { $_.LinkType -and $_.Target -like ($BridgeDir + "*") } | ForEach-Object {',
    '    Act ("remove junction " + $_.FullName)',
    '    if ($Apply) { [System.IO.Directory]::Delete($_.FullName, $false) }',
    '  }',
    '}',
    '',
    '# ---------- 6) VM user PATH: drop the dead C:\\WinVMBridge\\delivery entry ----------',
    "$deadPath = 'C:\\WinVMBridge\\delivery'",
    '$up = [Environment]::GetEnvironmentVariable("Path", "User")',
    'if ($up -and ($up -like ("*" + $deadPath + "*"))) {',
    '  Act ("remove VM user PATH entry " + $deadPath)',
    '  if ($Apply) {',
    '    $parts = $up.Split(";") | Where-Object { $_ -and ($_.TrimEnd("\\") -ne $deadPath) }',
    '    [Environment]::SetEnvironmentVariable("Path", ($parts -join ";"), "User")',
    '  }',
    '} else {',
    '  Write-Output "[SKIP] VM user PATH has no WinVMBridge entry"',
    '}',
    '',
    '# ---------- 7) VM-side side.json marker ----------',
    '$side = "$env:USERPROFILE\\.workbuddy\\winvm\\side.json"',
    'if (Test-Path $side) {',
    '  Act ("remove " + $side)',
    '  if ($Apply) { Remove-Item $side -Force }',
    '} else {',
    '  Write-Output "[SKIP] VM side.json not present"',
    '}',
    '',
    '# NEVER touched: sshd service, C:\\Users\\<user>\\.ssh (keys / authorized_keys),',
    '# C:\\WinVMWorkspace (unless -PurgeWorkspace), VM node runtimes, WorkBuddy app data.',
    '',
    '# ---------- POST STATUS (read-only verification) ----------',
    "Write-Output '--- POST STATUS ---'",
    "Write-Output ('BRIDGE_DIR=' + (Test-Path $BridgeDir))",
    "Write-Output ('WORKSPACE_DIR=' + (Test-Path $WorkspaceDir))",
    "$null = schtasks /Query /TN $TaskName 2> $null",
    "Write-Output ('TASK_EXISTS=' + ($LASTEXITCODE -eq 0))",
    "$l2 = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue",
    "Write-Output ('PORT_LISTEN=' + [bool]$l2)",
    "$leftNodes = Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match [regex]::Escape($BridgeDir) }",
    "Write-Output ('BRIDGE_NODE_LEFT=' + [bool]$leftNodes)",
    "$sshd2 = Get-Service sshd -ErrorAction SilentlyContinue",
    "Write-Output ('SSHD=' + $(if ($sshd2) { $sshd2.Status } else { 'NOT_FOUND' }))",
    "Write-Output ('AUTH_KEYS=' + (Test-Path \"$env:USERPROFILE\\.ssh\\authorized_keys\"))",
    'if ($Apply) { Write-Output "VM_CLEANUP_DONE" }',
    '',
  ];
  // CRLF line endings for PowerShell 5.1 friendliness; ASCII only.
  return lines.join('\r\n') + '\r\n';
}

/**
 * Push the generated .ps1 to the VM, run it, remove it. All output printed as-is.
 * @returns {{ok: boolean, output: string}}
 */
function runVmPhase(vm, { apply, purgeWorkspace }) {
  const ps1 = buildVmPs1({ purgeWorkspace });
  const localPath = join(tmpdir(), `winvm-un-${Date.now()}.ps1`);
  try {
    writeFileSync(localPath, ps1, 'utf8'); // ASCII source -> no BOM written by utf8
  } catch (e) {
    console.log(`[WARN] cannot write temp ps1: ${e.message}`);
    return { ok: false, output: '' };
  }
  const sshTarget = `${vm.user}@${vm.host}`;
  const sshPort = String(vm.sshPort);

  const scp = spawnSync('scp', ['-P', sshPort, '-o', 'ConnectTimeout=10', localPath, `${sshTarget}:${VM_REMOTE_PS1}`], {
    encoding: 'utf8',
  });
  if (scp.status !== 0) {
    console.log(`[WARN] scp ${VM_REMOTE_PS1} to VM failed: ${(scp.stderr || scp.stdout || '').trim().slice(0, 300)}`);
    return { ok: false, output: scp.stderr || '' };
  }
  const probeOnly = !apply;
  console.log(`${probeOnly ? '[INFO] probe-only push: ' : '[DO]  pushed '}${VM_REMOTE_PS1} to ${sshTarget}${probeOnly ? ' (read-only report mode)' : ''}`);

  const remoteArgs = [
    '-p', sshPort,
    '-o', 'ConnectTimeout=10',
    sshTarget,
    `powershell -NoProfile -ExecutionPolicy Bypass -File ${VM_REMOTE_PS1}`,
  ];
  if (apply) {
    remoteArgs[remoteArgs.length - 1] += ' -Apply';
    if (purgeWorkspace) remoteArgs[remoteArgs.length - 1] += ' -PurgeWorkspace';
  }
  const run = spawnSync('ssh', remoteArgs, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const output = `${run.stdout || ''}${run.stderr || ''}`;
  process.stdout.write(output);

  // Cleanup the remote helper script (best effort).
  spawnSync('ssh', ['-p', sshPort, '-o', 'ConnectTimeout=10', sshTarget, `rm -f ${VM_REMOTE_PS1}`], { encoding: 'utf8' });

  const ok = run.status === 0 && (!apply || output.includes('VM_CLEANUP_DONE'));
  return { ok, output };
}

/* ------------------------------ verification ------------------------------ */

/** Try to open a TCP connection to 127.0.0.1:port; resolve true when REFUSED (closed). */
function checkPortClosed(port, timeoutMs = 2000) {
  return new Promise((res) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (closed) => {
      try { sock.destroy(); } catch { /* noop */ }
      res(closed);
    };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => done(false));
    sock.on('timeout', () => done(true)); // no listener: connect hangs -> treat as closed
    sock.on('error', () => done(true));   // ECONNREFUSED -> closed
  });
}

function sshPasswordlessOk(vm) {
  const r = spawnSync('ssh', ['-p', String(vm.sshPort), '-o', 'ConnectTimeout=10', '-o', 'BatchMode=yes', `${vm.user}@${vm.host}`, 'whoami'], {
    encoding: 'utf8',
    timeout: 20000,
  });
  return { ok: r.status === 0, output: (r.stdout || r.stderr || '').trim() };
}

async function printVerification(hostRoot, home, vm, purgeWorkspace, executed) {
  const cacheWinvm = join(hostRoot, 'plugins', 'cache', 'winvm');
  const mkt = join(hostRoot, 'plugins', 'marketplaces', 'winvm');
  const connSkills = join(hostRoot, 'connectors', 'skills', 'connector-winvm');
  const reg = readJsonSafe(join(hostRoot, 'plugins', 'installed_plugins.json'));
  const side = join(home, '.workbuddy', 'winvm', 'side.json');
  const connJson = join(home, '.workbuddy', 'winvm', 'vm-conn.json');

  console.log('');
  console.log('================ POST-CLEANUP VERIFICATION CHECKLIST ================');
  const rows = [];
  rows.push(['HOST plugins/cache/winvm absent', !existsSync(cacheWinvm), !existsSync(cacheWinvm)]);
  rows.push(['HOST plugins/marketplaces/winvm absent', !existsSync(mkt), !existsSync(mkt)]);
  rows.push(['HOST connectors/skills/connector-winvm absent', !existsSync(connSkills), !existsSync(connSkills)]);
  const regClean = !reg || !reg.plugins || !reg.plugins[PLUGIN_KEY];
  rows.push(['HOST installed_plugins.json has no winvm entry', regClean, regClean]);
  const settingsJson = readJsonSafe(join(hostRoot, 'settings.json'));
  const epMap = settingsJson && settingsJson.enabledPlugins;
  const epClean = !epMap || typeof epMap !== 'object' || !(PLUGIN_KEY in epMap);
  rows.push(['HOST settings.json enabledPlugins has no winvm entry', epClean, epClean]);
  const conn = readJsonSafe(join(hostRoot, 'connectors', 'skills', 'mcp.json'));
  const connClean = !conn || !conn.mcpServers || !('connector:winvm' in conn.mcpServers);
  rows.push(['HOST connectors/skills/mcp.json has no winvm entry', connClean, connClean]);
  rows.push(['HOST ~/.workbuddy/winvm/side.json absent', !existsSync(side), !existsSync(side)]);
  rows.push(['HOST ~/.workbuddy/winvm/vm-conn.json absent', !existsSync(connJson), !existsSync(connJson)]);

  const portClosed = await checkPortClosed(SERVICE_PORT);
  rows.push([`HOST 127.0.0.1:${SERVICE_PORT} not listening`, portClosed, portClosed]);

  if (vm) {
    const vmPs1Out = executed ? lastVmPostStatus : null;
    const ssh = sshPasswordlessOk(vm);
    rows.push([`VM ssh ${vm.user}@${vm.host} passwordless ("whoami") works`, ssh.ok, ssh.ok]);
    if (vmPs1Out) {
      const get = (k) => {
        // POST STATUS repeats the same keys as PRE STATUS; take the LAST occurrence.
        const matches = [...vmPs1Out.matchAll(new RegExp(`^${k}=(.*)$`, 'gm'))];
        return matches.length ? matches[matches.length - 1][1].trim() : null;
      };
      rows.push(['VM C:/WinVMBridge absent', get('BRIDGE_DIR') === 'False', get('BRIDGE_DIR')]);
      rows.push([`VM task ${SERVICE_TASK} absent`, get('TASK_EXISTS') === 'False', get('TASK_EXISTS')]);
      rows.push([`VM port ${SERVICE_PORT} not listening`, get('PORT_LISTEN') === 'False', get('PORT_LISTEN')]);
      rows.push(['VM no vm-service node process', get('BRIDGE_NODE_LEFT') === 'False', get('BRIDGE_NODE_LEFT')]);
      rows.push(['VM OpenSSH Server still Running (must survive)', get('SSHD') === 'Running', get('SSHD')]);
      // Informational: on this VM the key may live in administrators_authorized_keys,
      // so file presence at ~/.ssh/authorized_keys alone is not a pass/fail criterion.
      // The authoritative check is the passwordless "whoami" row above.
      rows.push(['VM authorized_keys presence (info only; keys are never touched)', true, get('AUTH_KEYS')]);
      if (!purgeWorkspace) {
        rows.push(['VM C:/WinVMWorkspace kept (default)', get('WORKSPACE_DIR') === 'True', get('WORKSPACE_DIR')]);
      } else {
        rows.push(['VM C:/WinVMWorkspace purged (--purge-workspace)', get('WORKSPACE_DIR') === 'False', get('WORKSPACE_DIR')]);
      }
    } else {
      rows.push(['VM side checks', executed, 'skipped (dry-run)']);
    }
  }

  let allOk = true;
  for (const [label, pass, evidence] of rows) {
    if (!pass) allOk = false;
    const mark = executed ? (pass ? 'PASS' : 'FAIL') : 'PLAN';
    console.log(`  [${mark}] ${label}${evidence === true || evidence === false ? '' : `  (observed: ${evidence})`}`);
  }
  console.log('=====================================================================');
  return allOk;
}

/* ------------------------------ main ------------------------------ */

let lastVmPostStatus = null;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const home = homedir();
  const hostRoot = args.hostRoot ? resolve(args.hostRoot) : join(home, '.workbuddy');
  const trashBase = args.trashDir ? resolve(args.trashDir) : join(home, '.workbuddy', 'winvm-trash');
  const pluginCacheRoot = join(home, '.workbuddy', 'plugins', 'cache', 'winvm', 'winvm-bridge', '0.1.0');
  const dryRun = !args.apply;
  const tag = dryRun ? 'DRY-RUN' : 'APPLY';
  let failures = 0;
  const log = (m) => console.log(m);

  // Resolve the VM target BEFORE vm-conn.json gets deleted by the cleanup itself.
  const vm = resolveVmTarget(args, home);

  console.log('=== WinVM Bridge two-end uninstall ===');
  console.log(`mode           : ${tag}${dryRun ? ' (no changes - add --apply to execute)' : ''}`);
  console.log(`host root      : ${hostRoot}`);
  console.log(`host trash dir : ${trashBase}`);
  console.log(`vm target      : ${vm ? `${vm.user}@${vm.host}:${vm.sshPort}` : '(unavailable - VM phase will be skipped)'}`);
  console.log(`workspace      : ${args.purgeWorkspace ? 'PURGE (--purge-workspace)' : 'KEEP (default)'}`);
  console.log(`ssh keys       : NEVER touched (OpenSSH config is OS level, not plugin deployment)`);
  console.log('');

  /* ---------------- HOST phase ---------------- */
  console.log('--- HOST: resident tunnel daemon ---');
  if (!stopTunnelDaemon(home, dryRun, log)) failures++;

  console.log('--- HOST: plugin cache / marketplace / connector skills (to trash) ---');
  if (!cleanHostDirectories(hostRoot, trashBase, dryRun, log)) failures++;

  console.log('--- HOST: installed_plugins.json registry ---');
  cleanInstalledPlugins(hostRoot, dryRun, log);

  console.log('--- HOST: connectors/*/mcp.json winvm entries ---');
  cleanConnectorMcpJson(hostRoot, dryRun, log);

  console.log('--- HOST: settings.json sandbox.extraAllowWrite ---');
  cleanSandboxAllowWrite(hostRoot, home, dryRun, log);

  console.log('--- HOST: settings.json enabledPlugins ---');
  cleanEnabledPlugins(hostRoot, dryRun, log);

  console.log('--- HOST: user PATH / shell profile ---');
  cleanHostPath(pluginCacheRoot, dryRun, log);

  console.log('--- HOST: ~/.workbuddy/winvm marker files ---');
  cleanWinvmMarkerFiles(home, dryRun, log);

  /* ---------------- VM phase ---------------- */
  if (vm) {
    console.log(`--- VM: ${vm.user}@${vm.host} (generated .ps1 pushed via scp) ---`);
    const r = runVmPhase(vm, { apply: !dryRun, purgeWorkspace: args.purgeWorkspace });
    if (!dryRun) {
      lastVmPostStatus = r.output;
      if (!r.ok) {
        log('[WARN] VM cleanup did not fully complete (see output above)');
        failures++;
      }
    }
  } else {
    console.log('--- VM: SKIPPED (no target resolved; pass --vm-host/--vm-user or restore vm-conn.json) ---');
    failures++;
  }

  /* ---------------- verification ---------------- */
  const verified = await printVerification(hostRoot, home, vm, args.purgeWorkspace, !dryRun);

  console.log('');
  if (dryRun) {
    console.log('DRY-RUN complete: nothing was modified.');
    console.log('Review the actions above, then run: node delivery/uninstall.mjs --apply');
    console.log('Default keeps C:/WinVMWorkspace; add --purge-workspace to also delete it.');
  } else if (failures === 0 && verified) {
    console.log('APPLY complete: all cleanup steps done and verification checklist passed.');
    console.log('Next: fresh reinstall via node delivery/bootstrap.mjs all && node delivery/setup.mjs --apply');
  } else {
    console.log(`APPLY finished with ${failures} failure(s); see [WARN]/[FAIL] lines above.`);
    process.exitCode = 1;
  }
}

// Run only when invoked directly (import-safe for tests).
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((e) => {
    console.error(`uninstall failed: ${e?.stack || e}`);
    process.exit(1);
  });
}

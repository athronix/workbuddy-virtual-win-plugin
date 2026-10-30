#!/usr/bin/env node
/**
 * WinVM Bridge —— 插件管理 CLI（winvm-plugin）
 *
 * 部署到【宿主机】与【VM】两侧，提供统一的插件查验 / 管理命令。
 * 自动识别运行上下文（host / vm），行为随之不同：
 *
 *   · VM 侧  ：直接操作本地服务（schtasks / 本地 127.0.0.1:18443）
 *   · Host 侧：经 SSH 中继到 VM（server/health/command 走 SSH；command 用临时 SSH 隧道 + JSON-RPC 调 /mcp）
 *
 * 子命令：
 *   help                                 显示本帮助
 *   check                                查验本侧部署完整性（注册条目 / 连接器 / 任务 / 文件）
 *   health                               探测 VM 服务 /health（host 经 SSH，vm 本地）
 *   list skills                          列出已部署的共享 Skills
 *   list mcp-servers                     列出 MCP 服务（host: 连接器条目；vm: 计划任务 + 端点）
 *   list mcp-tools                       列出已暴露的 MCP 工具（按能力域分组，共 54 项）
 *   list dirs                            列出本侧关键安装目录
 *   server start|status|stop|restart     控制 VM 服务（host 经 SSH；vm 本地 schtasks）
 *   command <tool> [--args <json>]       直接调用一个 MCP 工具（host 经 SSH 隧道，vm 本地）
 *   tunnel-mode [mcp|a2a|intelligent]    查看或设置通道模式（宿主侧通道选择策略，写 vm-conn.json）
 *   uninstall [--vm]                     卸载本侧（host 加 --vm 同时卸载 VM）
 *   update                               重新应用本侧部署（等价于重跑安装器）
 *   reinstall                            卸载后重新安装本侧
 *
 * 运行上下文判定（优先级）：
 *   1. --side host|vm
 *   2. 本文件同目录下的 .winvm-context.json（{"side":"host"|"vm"}）
 *   3. 启发式：存在 connectors/skills/connector-winvm 且 installed_plugins.json 含本插件 → host；
 *      否则存在 packages/vm-service/dist/cli.js → vm
 *
 * Host 侧需要 VM 连接信息（用于 server/health/command 的 SSH 中继）：
 *   优先 --vm-host / --vm-user / --vm-ssh-port / --vm-port（另可 --vm-provider / --vm-cli），
 *   其次环境变量 WINVM_VM_HOST / WINVM_VM_USER / WINVM_VM_SSH_PORT / WINVM_VM_PORT，
 *   再次部署期持久化配置 ~/.workbuddy/winvm/vm-conn.json（宿主安装器自动写入），
 *   最后从当前/向上目录的 .env 读取（VM_HOST / VM_USER / VM_SSH_PORT / WINVM_SERVICE_PORT）。
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  rmSync,
  cpSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import { homedir } from 'node:os';
import http from 'node:http';
import net from 'node:net';

/**
 * 排除名单单一事实源（P2-4 怪癖 B）：`connectors/` 下的非账户目录（平台内部目录，非账户）。
 * 本文件侧（host 类子命令的账户罗列）用它过滤，避免把 skills / marketplace-meta 当成账户。
 *
 * 投放面（两侧均在场，故相对导入安全）：
 *   - 宿主缓存：随 winvm-plugin.mjs 经 extraFiles 一起投放（install-host.mjs 宿主缓存部署调用）；
 *   - VM 侧：setup.mjs tar 整包 delivery/ 下发；仓库 delivery/ 目录本身亦有。
 * 单一事实源在 delivery/account-resolve.mjs（install-host / diagnose-connectors / adapter 同语义）。
 */
import { NON_ACCOUNT_DIRS } from './account-resolve.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/* ============================ 通用工具 ============================ */

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return {
    status: r.status ?? (r.error ? 1 : 0),
    stdout: (r.stdout ?? '').trim(),
    stderr: (r.stderr ?? '').trim(),
    error: r.error,
  };
}

function readJsonSafe(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 向上查找首个匹配 predicate 的目录 */
function findUp(start, predicate) {
  let cur = resolve(start);
  for (;;) {
    if (predicate(cur)) return cur;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

/* ============================ 上下文识别 ============================ */

function detectSide(explicit) {
  if (explicit === 'host' || explicit === 'vm') return explicit;
  const ctxPath = join(__dirname, '.winvm-context.json');
  const ctx = readJsonSafe(ctxPath);
  if (ctx && (ctx.side === 'host' || ctx.side === 'vm')) return ctx.side;

  const home = homedir();
  const wb = join(home, '.workbuddy');
  const installed = readJsonSafe(join(wb, 'plugins', 'installed_plugins.json'));
  const hasReg =
    installed && installed.plugins && Array.isArray(installed.plugins['winvm-bridge@winvm']) &&
    installed.plugins['winvm-bridge@winvm'].length > 0;
  const hasSkills = isDir(join(wb, 'connectors', 'skills', 'connector-winvm'));
  if (hasReg && hasSkills) return 'host';

  if (existsSync(resolve(__dirname, '..', 'packages', 'vm-service', 'dist', 'cli.js'))) return 'vm';
  return 'host'; // 默认按 host 处理（管理端）
}

/* ============================ VM 连接信息（host 侧） ============================ */

function parseEnvFile(p) {
  const out = {};
  const txt = readFileSync(p, 'utf8');
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

/**
 * 纯函数：依据来源优先级解析 VM 连接信息（便于单测）。
 * 优先级（高→低）：argv(--vm-*) > 环境变量 WINVM_VM_* > .env(VM_*) > 部署期持久化 vm-conn.json > 默认值。
 */
export function resolveVmConn({ argv = {}, env = {}, dotEnv = {}, persisted = {} } = {}) {
  const host = argv.vmHost || env['WINVM_VM_HOST'] || dotEnv['VM_HOST'] || persisted.host || '';
  const user = argv.vmUser || env['WINVM_VM_USER'] || dotEnv['VM_USER'] || persisted.user || '';
  const sshPort = Number(argv.vmSshPort || env['WINVM_VM_SSH_PORT'] || dotEnv['VM_SSH_PORT'] || persisted.sshPort || 22);
  const servicePort = Number(
    argv.vmPort || env['WINVM_VM_PORT'] || dotEnv['WINVM_SERVICE_PORT'] || persisted.servicePort || 18443,
  );
  // provider/cli 也持久化，供 uninstall --vm 等命令复用
  const provider = argv.vmProvider || env['WINVM_VM_PROVIDER'] || persisted.provider || '';
  const cli = argv.vmCli || env['WINVM_VM_CLI'] || persisted.cli || '';
  // 凭据（ssh2 后端需要）：argv --vm-key > env WINVM_VM_KEY > 持久化 vm-conn.json
  const identityFile = argv.vmKey || env['WINVM_VM_KEY'] || persisted.identityFile || '';
  const privateKey = persisted.privateKey || '';
  const password = env['WINVM_VM_PASSWORD'] || persisted.password || '';
  // tunnel-mode：同一优先级惯例（argv > env > persisted > 默认），附来源供 status 展示
  const tunnel = resolveTunnelModeFromSources({ argv, env, persisted });
  return { host, user, sshPort, servicePort, provider, cli, identityFile, privateKey, password, tunnelMode: tunnel.mode, tunnelModeSource: tunnel.source, ...(tunnel.warning ? { tunnelModeWarning: tunnel.warning } : {}) };
}

/**
 * 默认 SSH 私钥探测链（与 setup.mjs 一致）：未显式提供任何凭据时，
 * 探测 ~/.ssh 下默认私钥（ed25519 → ecdsa → rsa），返回首个存在的绝对路径。
 * 使 command/server/health 等 ad-hoc 子命令无需手动传 --vm-key 即可建立进程内 ssh2 隧道。
 */
function probeDefaultSshKey() {
  const candidates = ['id_ed25519', 'id_ecdsa', 'id_rsa'];
  for (const name of candidates) {
    const fp = join(homedir(), '.ssh', name);
    if (existsSync(fp)) return fp;
  }
  return '';
}

function loadVmConn(argv) {
  const env = process.env;
  // 从 cwd / 向上目录读 .env（兼容在仓库内运行）
  const repoDir = findUp(process.cwd(), (d) => existsSync(join(d, '.env')));
  const dotEnv = repoDir ? parseEnvFile(join(repoDir, '.env')) : {};
  // 部署期持久化配置（install-host.mjs 写入 ~/.workbuddy/winvm/vm-conn.json），
  // 使宿主侧 health/server/command 无需每次传 --vm-host/--vm-user。
  const connFile = join(homedir(), '.workbuddy', 'winvm', 'vm-conn.json');
  const persisted = readJsonSafe(connFile) || {};

  // 默认键探测链（与 setup.mjs 一致）：未显式提供任何凭据时，探测 ~/.ssh 下默认私钥，
  // 注入为 argv.vmKey → resolveVmConn 映射为 identityFile，覆盖 command/server/health 等 ad-hoc 路径。
  const a = { ...argv };
  if (
    !a.vmKey && !env['WINVM_VM_KEY'] && !persisted.identityFile &&
    !persisted.privateKey && !env['WINVM_VM_PASSWORD'] && !persisted.password
  ) {
    const probed = probeDefaultSshKey();
    if (probed) a.vmKey = probed;
  }

  return resolveVmConn({ argv: a, env, dotEnv, persisted });
}

/* ============================ tunnel-mode 通道模式 ============================ */

/**
 * tunnel-mode 全部合法取值（与 packages/core/src/constants.ts 的 TUNNEL_MODES 对齐）。
 * ⚠ 内联而非 import '@winvm/core'：本文件部署到 ~/.workbuddy/plugins/cache/... 后
 * 旁边没有 node_modules（部署缓存不含 workspace 链接），import 会直接崩。
 * 修改此处时必须同步 core 常量（有单测锁定两侧一致）。
 */
const TUNNEL_MODES = ['mcp', 'a2a', 'intelligent'];
const TUNNEL_MODE_DEFAULT = 'mcp';
const ENV_TUNNEL_MODE = 'WINVM_TUNNEL_MODE';

/**
 * 纯函数：解析 tunnel-mode 原始值（与 packages/core/src/constants.ts 的
 * resolveTunnelMode 同语义）。trim + 小写；空 → 默认 mcp；非法 → mcp + warning。
 * @returns {{ mode: string, warning?: string }}
 */
export function resolveTunnelMode(raw) {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!v) return { mode: TUNNEL_MODE_DEFAULT };
  if (TUNNEL_MODES.includes(v)) return { mode: v };
  return { mode: TUNNEL_MODE_DEFAULT, warning: `未知 tunnel-mode "${raw}"，回落 mcp（可用：${TUNNEL_MODES.join('/')}）` };
}

/**
 * 纯函数：依据来源优先级解析 tunnel-mode（便于单测）。
 * 优先级（高→低）：argv(--tunnel-mode) > 环境变量 WINVM_TUNNEL_MODE
 *                > 部署期持久化 vm-conn.json 的 tunnelMode 字段 > 默认 'mcp'。
 * 非法值一律回落 mcp（r.warning 携带告警文本，由调用方决定是否打印）。
 * @returns {{ mode: string, source: 'flag'|'env'|'vm-conn'|'default', warning?: string }}
 */
export function resolveTunnelModeFromSources({ argv = {}, env = {}, persisted = {} } = {}) {
  if (argv.tunnelMode !== undefined && argv.tunnelMode !== null && argv.tunnelMode !== '') {
    const r = resolveTunnelMode(argv.tunnelMode);
    return { mode: r.mode, source: 'flag', ...(r.warning ? { warning: r.warning } : {}) };
  }
  if (env[ENV_TUNNEL_MODE] !== undefined && env[ENV_TUNNEL_MODE] !== '') {
    const r = resolveTunnelMode(env[ENV_TUNNEL_MODE]);
    return { mode: r.mode, source: 'env', ...(r.warning ? { warning: r.warning } : {}) };
  }
  if (persisted.tunnelMode !== undefined && persisted.tunnelMode !== null && persisted.tunnelMode !== '') {
    const r = resolveTunnelMode(persisted.tunnelMode);
    return { mode: r.mode, source: 'vm-conn', ...(r.warning ? { warning: r.warning } : {}) };
  }
  return { mode: TUNNEL_MODE_DEFAULT, source: 'default' };
}

/** vm-conn.json 路径（部署期持久化配置，install-host.mjs 写入；tunnel-mode 也写回这里） */
function vmConnFile() {
  return join(homedir(), '.workbuddy', 'winvm', 'vm-conn.json');
}

/**
 * 读当前 tunnel-mode（显示用）：来源优先级见 resolveTunnelModeFromSources。
 * @returns {{ mode: string, source: 'flag'|'env'|'vm-conn'|'default', warning?: string }}
 */
function loadTunnelMode(argv = {}) {
  const env = process.env;
  const persisted = readJsonSafe(vmConnFile()) || {};
  return resolveTunnelModeFromSources({ argv, env, persisted });
}

/**
 * 将 tunnelMode 写回 vm-conn.json（读改写，只改 tunnelMode 一个键，保留其它字段）。
 * 2 空格缩进，与 install-host.mjs 写入格式一致。
 */
function saveTunnelMode(mode) {
  const file = vmConnFile();
  const conn = readJsonSafe(file) || {};
  conn.tunnelMode = mode;
  writeFileSync(file, JSON.stringify(conn, null, 2) + '\n', 'utf8');
}

/**
 * `winvm-plugin tunnel-mode [mode]` 子命令：
 *   无参  → 显示当前模式 + 来源（flag/env/vm-conn/default）；
 *   带参  → 校验合法后写回 vm-conn.json 的 tunnelMode 字段（只改这一个键）。
 * 语义边界：本配置是「宿主侧通道选择策略」的事实源，供主控 skill 指引宿主 LLM
 * 选择 MCP 直调或 A2A 委派连接器；不在代码层强制拦截工具调用（无法跨越连接器边界拦截）。
 */
function cmdTunnelMode(a) {
  const cur = loadTunnelMode(a);
  if (cur.warning) console.error(`⚠ ${cur.warning}`);

  // 无参：显示当前模式与来源
  if (a.tunnelModeArg === undefined) {
    const sourceLabel = { flag: 'flag (--tunnel-mode)', env: `env (${ENV_TUNNEL_MODE})`, 'vm-conn': 'vm-conn.json', default: 'default（未配置，出厂默认）' }[cur.source];
    console.log(`通道模式    : ${cur.mode}`);
    console.log(`来源        : ${sourceLabel}`);
    console.log('可用取值    : mcp（默认，MCP 直调）/ a2a（A2A 委派）/ intelligent（智能判断）');
    console.log(`修改        : winvm-plugin tunnel-mode <mcp|a2a|intelligent>`);
    return;
  }

  // 带参：校验 + 写回
  const r = resolveTunnelMode(a.tunnelModeArg);
  if (r.warning) {
    console.error(`✗ ${r.warning}`);
    process.exitCode = 1;
    return;
  }
  saveTunnelMode(r.mode);
  console.log(`✓ tunnel-mode 已设置为 ${r.mode}（写入 ${vmConnFile()} 的 tunnelMode 字段，其它字段保留）`);
  console.log('生效方式：宿主 LLM 在下一次读取主控 skill 指引（或 env / CLI flag）时按新模式选择通道。');
}

/* ============================ HTTP（无外部依赖） ============================ */

function httpReq(url, method, bodyObj) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = bodyObj ? JSON.stringify(bodyObj) : null;
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: data
          ? { 'content-type': 'application/json', accept: 'application/json' }
          : { accept: 'application/json' },
      },
      (res) => {
        let buf = '';
        res.on('data', (d) => (buf += d));
        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function httpGetJson(url) {
  const r = await httpReq(url, 'GET');
  if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${r.body.slice(0, 200)}`);
  return JSON.parse(r.body);
}

async function httpPostJson(url, body) {
  const r = await httpReq(url, 'POST', body);
  if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${r.body.slice(0, 200)}`);
  return JSON.parse(r.body);
}

/* ============================ SSH 中继（host 侧） ============================ */

function sshExec(vm, remoteCmd, timeoutMs = 60000) {
  if (!vm.host || !vm.user) {
    throw new Error('缺少 VM 连接信息：请在仓库目录运行（读 .env）或传 --vm-host/--vm-user');
  }
  const r = sh('ssh', ['-p', String(vm.sshPort), '-o', 'BatchMode=yes', '-o', `ConnectTimeout=10`, `${vm.user}@${vm.host}`, remoteCmd], {
    timeout: timeoutMs,
  });
  if (r.status !== 0 && !r.stdout) {
    throw new Error(`SSH 执行失败（${r.stderr || r.error || 'exit ' + r.status}）`);
  }
  return r.stdout;
}

/**
 * D12：在 VM 上执行一段 **PowerShell 片段**（host→VM），规避 MSYS/Git-Bash 的 `/` 前缀参数改写。
 *
 * 根因：VM 的默认 SSH shell 是 MSYS Git-Bash，会把 `schtasks /Query` 中的 `/Query` 当作 POSIX 路径
 * 改写成 `C:/Program Files/Git/Query` → schtasks 报「无效参数」→ 上层 catch 吞掉 → 假阴性。
 * 因此 host→VM 一律改用 PowerShell 计划任务 cmdlet（参数为 `-Xxx` 破折号式，不受转换影响），
 * 且片段内**不使用 `$` 变量**（防远端 shell 展开）、不使用 `/` 前缀参数 —— bash 与 cmd 均可移植。
 *
 * ⚠ 这是把 PS「内联经 ssh」执行（与本仓 install/uninstall 偏好的「推 .ps1 + `-File`」不同）：
 * 仅用于**短小、无 `$`、无 `/` 前缀参数**的 cmdlet 片段；复杂脚本仍应走 .ps1 推送。
 * 失败（非 0 且无 stdout）时抛错，由调用方兜底。
 */
function psRemote(vm, script, timeoutMs = 60000) {
  return sshExec(vm, `powershell -NoProfile -NonInteractive -Command "${script}"`, timeoutMs);
}

/** 建立临时 SSH 隧道（localPort -> VM 127.0.0.1:servicePort），执行 fn(baseUrl) 后拆除 */
async function withTunnel(vm, fn) {
  if (!vm.host || !vm.user) {
    throw new Error('缺少 VM 连接信息：请在仓库目录运行（读 .env）或传 --vm-host/--vm-user');
  }
  const useSsh2 = process.platform === 'ohos' || process.platform === 'openharmony' || process.env['WINVM_TUNNEL_BACKEND'] === 'ssh2';
  if (useSsh2) {
    // OH 宿主 / 显式 ssh2 后端：进程内纯 JS 隧道（临时，fn 执行完即拆）。
    const { establishSsh2Tunnel } = await import('./oh-tunnel.mjs');
    const localPort = 18_443 + Math.floor(Math.random() * 1000);
    const handle = await establishSsh2Tunnel({
      vmHost: vm.host,
      vmSshPort: vm.sshPort,
      username: vm.user,
      localBindHost: '127.0.0.1',
      localBindPort: localPort,
      remoteHost: '127.0.0.1',
      remotePort: vm.servicePort,
      identityFile: vm.identityFile || undefined,
      privateKey: vm.privateKey || undefined,
      password: vm.password || undefined,
      keepaliveInterval: 30_000,
      readyTimeoutMs: 15_000,
    });
    try {
      return await fn(`http://127.0.0.1:${localPort}`);
    } finally {
      try {
        await handle.stop();
      } catch {
        /* ignore */
      }
    }
  }
  // —— 默认：系统 ssh 子进程（Windows / macOS 不变）——
  const localPort = 18_443 + Math.floor(Math.random() * 1000);
  const child = spawn(
    'ssh',
    ['-N', '-L', `${localPort}:127.0.0.1:${vm.servicePort}`, '-p', String(vm.sshPort), `${vm.user}@${vm.host}`],
    { stdio: 'ignore' },
  );
  try {
    await waitPort('127.0.0.1', localPort, 15000);
    return await fn(`http://127.0.0.1:${localPort}`);
  } finally {
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
}

function waitPort(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const sock = net.connect(port, host);
      sock.once('connect', () => {
        sock.destroy();
        resolve();
      });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() > deadline) reject(new Error('隧道建立超时'));
        else setTimeout(tryOnce, 300);
      });
    };
    tryOnce();
  });
}

/* 同步无关：用 Node net 直连探测 TCP 端口是否监听。
 * 替代 PowerShell Test-NetConnection —— 后者在 check 里曾因 { stdio: 'ignore' }
 * 吞掉 stdout、且中文 locale 下输出不稳定，导致「端口未监听」假阴性。 */
function isPortListening(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = net.connect(Number(port), host);
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

/* ============================ MCP JSON-RPC 客户端 ============================ */

async function mcpInitialize(baseUrl) {
  await httpPostJson(baseUrl + '/mcp', {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'winvm-plugin', version: '0.1.0' },
    },
  });
  // initialized 通知（服务端返回 202，无响应体，忽略即可）
  await httpReq(baseUrl + '/mcp', 'POST', {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  });
}

async function mcpPost(baseUrl, payload) {
  const r = await httpReq(baseUrl + '/mcp', 'POST', payload);
  if (r.status !== 200) throw new Error(`MCP HTTP ${r.status}: ${r.body.slice(0, 200)}`);
  const parsed = JSON.parse(r.body);
  if (parsed.error) throw new Error(`MCP error ${parsed.error.code}: ${parsed.error.message}`);
  return parsed.result;
}

async function mcpCallTool(baseUrl, name, args) {
  await mcpInitialize(baseUrl);
  const result = await mcpPost(baseUrl, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name, arguments: args ?? {} },
  });
  return result;
}

/* ============================ 能力注册表加载（list mcp-tools） ============================ */

async function loadCapabilities() {
  // 优先：直接 import 已编译注册表（VM 侧必定可用；host 侧若 dist 在则可用）
  const candidates = [
    resolve(__dirname, '..', 'packages', 'vm-capabilities', 'dist', 'registry', 'definitions.js'),
    resolve(__dirname, '..', '..', 'packages', 'vm-capabilities', 'dist', 'registry', 'definitions.js'),
    resolve(__dirname, 'node_modules', '@winvm', 'vm-capabilities', 'dist', 'registry', 'definitions.js'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        const mod = await import(pathToFileURL(p).href);
        if (Array.isArray(mod.WINDOWS_CAPABILITIES)) return mod.WINDOWS_CAPABILITIES;
      } catch {
        /* try next */
      }
    }
  }
  return null;
}

/* ============================ 路径 ============================ */

function hostPaths() {
  const home = homedir();
  const wb = join(home, '.workbuddy');
  return {
    home,
    wb,
    pluginsCache: join(wb, 'plugins', 'cache', 'winvm', 'winvm-bridge', '0.1.0'),
    installedPlugins: join(wb, 'plugins', 'installed_plugins.json'),
    connectorsDir: join(wb, 'connectors'),
    skillsDir: join(wb, 'connectors', 'skills', 'connector-winvm'),
  };
}

function vmPaths() {
  const repoRoot = resolve(__dirname, '..');
  const runtimeConfig = join(repoRoot, 'delivery', '.generated', 'vm-service.runtime.json');
  const rt = readJsonSafe(runtimeConfig) || {};
  const provider = rt.agent?.provider;
  const skillsRoot =
    rt.agent?.providers?.[provider]?.options?.skillsRoot ||
    process.env['WINVM_SKILLS_ROOT'] ||
    'C:/WinVMBridge/shared-skills';
  return {
    repoRoot,
    cliEntry: join(repoRoot, 'packages', 'vm-service', 'dist', 'cli.js'),
    runtimeConfig,
    taskName: 'WinVMBridge.Service',
    servicePort: rt.server?.port || 18443,
    sharedSkillsRoot: skillsRoot,
    repoSkills: join(repoRoot, 'skills'),
  };
}

/* ============================ 子命令实现 ============================ */

function cmdHelp() {
  console.log(USAGE);
}

function repoDirForHostInstaller() {
  return findUp(process.cwd(), (d) => existsSync(join(d, 'delivery', 'install-host.mjs')));
}

async function cmdCheck(side, vm) {
  if (side === 'host') {
    const p = hostPaths();
    console.log('== WinVM Bridge 宿主机查验 ==\n');
    const checks = [];
    const installed = readJsonSafe(p.installedPlugins);
    const regOk =
      installed?.plugins?.['winvm-bridge@winvm']?.length > 0;
    checks.push(['正式注册条目 (installed_plugins.json)', regOk, p.installedPlugins]);

    // 任意 account 的 mcp.json 含两个连接器
    let winvmOk = false;
    let a2aOk = false;
    let accounts = [];
    if (isDir(p.connectorsDir)) {
      // 非账户目录（skills / marketplace-meta，平台内部目录）排除：否则其 mcp.json 含
      // connector:winvm 时会被误判为「已注册」——修复前会导致 check 假绿（P2-4 怪癖 B）。
      for (const acct of readdirSync(p.connectorsDir).filter((d) => !NON_ACCOUNT_DIRS.has(d))) {
        const mp = join(p.connectorsDir, acct, 'mcp.json');
        const m = readJsonSafe(mp);
        if (m?.mcpServers) {
          accounts.push(acct);
          if (m.mcpServers['connector:winvm']) winvmOk = true;
          if (m.mcpServers['connector:winvm-a2a']) a2aOk = true;
        }
      }
    }
    checks.push(['MCP 直调通道 (connector:winvm)', winvmOk, `accounts: ${accounts.join(', ') || '(无)'}`]);
    checks.push(['A2A 委派桥 (connector:winvm-a2a)', a2aOk, `accounts: ${accounts.join(', ') || '(无)'}`]);
    checks.push(['插件缓存目录', isDir(p.pluginsCache), p.pluginsCache]);
    checks.push(['共享 Skills (connector-winvm)', isDir(p.skillsDir), p.skillsDir]);
    // 常驻隧道（仅 OH/ssh2 后端有；win32/darwin 由系统 ssh 提供，跳过）
    if (process.platform !== 'win32' && process.platform !== 'darwin') {
      const st = await readTunnelStatus(vm.servicePort ?? 18443);
      checks.push([`常驻隧道 (127.0.0.1:${vm.servicePort ?? 18443})`, st.state === 'RUNNING', st.state === 'RUNNING' ? `pid ${st.pid}（可连）` : st.state]);
    }

    let allOk = true;
    for (const [name, ok, detail] of checks) {
      console.log(`  ${ok ? '✅' : '❌'} ${name}`);
      if (detail) console.log(`       ${detail}`);
      if (!ok) allOk = false;
    }
    console.log(`\n结论：${allOk ? '宿主机部署完整 ✅' : '存在问题，见上方 ❌'}`);
    process.exitCode = allOk ? 0 : 1;
  } else {
    const v = vmPaths();
    console.log('== WinVM Bridge VM 查验 ==\n');
    const checks = [];
    const taskOk = sh('schtasks', ['/Query', '/TN', v.taskName], { stdio: 'ignore' }).status === 0;
    checks.push(['计划任务已注册', taskOk, v.taskName]);
    checks.push(['vm-service cli.js 存在', existsSync(v.cliEntry), v.cliEntry]);
    checks.push(['运行配置存在', existsSync(v.runtimeConfig), v.runtimeConfig]);
    checks.push(['共享 Skills 根存在', isDir(v.sharedSkillsRoot), v.sharedSkillsRoot]);
    // 端口监听（Node net 直连探测，避免 PowerShell Test-NetConnection 的 stdio/locale 陷阱）
    const portOk = await isPortListening('127.0.0.1', v.servicePort);
    checks.push(['服务端口监听中', portOk, `127.0.0.1:${v.servicePort}`]);

    let allOk = true;
    for (const [name, ok, detail] of checks) {
      console.log(`  ${ok ? '✅' : '❌'} ${name}`);
      if (detail) console.log(`       ${detail}`);
      if (!ok) allOk = false;
    }
    if (allOk) {
      console.log('\n结论：VM 部署完整且服务在线 ✅');
    } else if (!portOk) {
      console.log('\n结论：部署文件齐全，但「服务端口未监听」——计划任务含 LogonTrigger，仅在你「下次登录」时自动拉起；');
      console.log('      当前你是已登录状态下部署的（经宿主 SSH 跑了 install-vm.mjs），触发器未触发，故服务未启动。这是预期，非部署失败。');
      console.log('修复（就在本交互式窗口执行）：');
      console.log('  winvm-plugin server start          # 在当前会话拉起服务（推荐，GUI 可用）');
      console.log('  # 等价命令： schtasks /run /tn WinVMBridge.Service');
      console.log('然后再查验： winvm-plugin check   （端口应变 ✅）');
      console.log('若需 GUI 能力（截图/键鼠）： start 后跑 winvm-plugin health，确认 windowStation=WinSta0 且 interactive=true；');
      console.log('  若显示 degraded，按 Q3 在 RDP 解锁 + 普通用户 PowerShell 下再 server restart 一次。');
      process.exitCode = 1;
    } else {
      console.log('\n结论：存在问题，见上方 ❌');
      process.exitCode = 1;
    }
  }
}

function baseUrlForSide(side, vm) {
  if (side === 'vm') return `http://127.0.0.1:${vmPaths().servicePort}`;
  return null; // host 由隧道决定
}

async function cmdHealth(side, vm) {
  if (side === 'vm') {
    const url = `http://127.0.0.1:${vmPaths().servicePort}/health`;
    try {
      const h = await httpGetJson(url);
      console.log(JSON.stringify(h, null, 2));
      if (h?.session?.interactive === false) {
        console.log('\n⚠️ 服务运行在非交互式会话 → GUI 能力不可用。');
        console.log('   在 VM 交互式 PowerShell 中执行以下命令启用 GUI（杀掉非 GUI 服务、在交互式会话重启）：');
        printGuiRestart();
      }
    } catch (e) {
      console.error(`/health 探测失败（服务可能未启动）：${e.message}`);
      process.exitCode = 1;
    }
  } else {
    try {
      const out = sshExec(vm, `curl -s --noproxy 127.0.0.1 http://127.0.0.1:${vm.servicePort}/health`);
      const h = JSON.parse(out);
      console.log(JSON.stringify(h, null, 2));
      if (h?.session?.interactive === false) {
        console.log('\n⚠️ 服务运行在非交互式会话 → GUI 能力不可用。');
        console.log('   在 VM 交互式 PowerShell 中执行以下命令启用 GUI：');
        printGuiRestart();
      }
    } catch (e) {
      console.error(`/health 探测失败：${e.message}`);
      process.exitCode = 1;
    }
  }
}

function printGuiRestart() {
  console.log(
    [
      '   schtasks /end /tn WinVMBridge.Service',
      '   Start-Sleep -Seconds 2',
      '   $p = (Get-NetTCPConnection -LocalPort 18443 -ErrorAction SilentlyContinue).OwningProcess | Select-Object -Unique',
      '   if ($p) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }',
      '   Start-Sleep -Seconds 1',
      '   schtasks /run /tn WinVMBridge.Service',
    ].join('\n'),
  );
}

async function cmdList(side, vm, sub, json) {
  if (sub === 'skills') {
    if (side === 'host') {
      const p = hostPaths();
      const list = isDir(p.skillsDir) ? readdirSync(p.skillsDir).filter((d) => isDir(join(p.skillsDir, d))) : [];
      printList('宿主机共享 Skills（connector-winvm）', list, p.skillsDir, json);
    } else {
      const v = vmPaths();
      const roots = [];
      if (isDir(v.sharedSkillsRoot)) roots.push(v.sharedSkillsRoot);
      if (isDir(v.repoSkills)) roots.push(v.repoSkills);
      const seen = new Set();
      for (const root of roots) {
        for (const d of readdirSync(root)) {
          if (isDir(join(root, d))) seen.add(d);
        }
      }
      printList('VM 共享 Skills', [...seen], roots.join(' , '), json);
    }
  } else if (sub === 'mcp-servers') {
    if (side === 'host') {
      const p = hostPaths();
      const rows = [];
      if (isDir(p.connectorsDir)) {
        // 与 check 同口径：非账户目录（skills / marketplace-meta）不作为「账户」列出（P2-4 怪癖 B）
        for (const acct of readdirSync(p.connectorsDir).filter((d) => !NON_ACCOUNT_DIRS.has(d))) {
          const m = readJsonSafe(join(p.connectorsDir, acct, 'mcp.json'));
          if (m?.mcpServers) {
            for (const key of Object.keys(m.mcpServers)) {
              if (key.includes('winvm')) rows.push([acct, key, m.mcpServers[key].type || '(默认)']);
            }
          }
        }
      }
      if (json) console.log(JSON.stringify(rows, null, 2));
      else {
        console.log('== 宿主机 MCP 服务（连接器条目）==\n');
        for (const [acct, key, type] of rows) console.log(`  · [${acct}] ${key}  (${type})`);
        if (!rows.length) console.log('  （未发现 winvm 连接器条目）');
      }
    } else {
      const v = vmPaths();
      console.log('== VM MCP 服务 ==\n');
      console.log(`  计划任务      : ${v.taskName}`);
      console.log(`  MCP 主干通道  : POST http://127.0.0.1:${v.servicePort}/mcp`);
      console.log(`  A2A 委派通道  : POST http://127.0.0.1:${v.servicePort}/a2a`);
      console.log(`  健康检查      : GET  http://127.0.0.1:${v.servicePort}/health`);
    }
  } else if (sub === 'mcp-tools') {
    const caps = await loadCapabilities();
    if (caps) {
      const byDomain = {};
      for (const c of caps) (byDomain[c.domain] ||= []).push(c);
      if (json) {
        console.log(JSON.stringify(caps.map((c) => ({ id: c.id, domain: c.domain, risk: c.risk, name: c.name })), null, 2));
      } else {
        console.log(`== 已注册能力 / MCP 工具（共 ${caps.length} 项）==\n`);
        for (const domain of Object.keys(byDomain).sort()) {
          console.log(`■ ${domain}（${byDomain[domain].length}）`);
          for (const c of byDomain[domain]) {
            console.log(`    · ${c.id}  [${c.risk}]  ${c.name}`);
          }
        }
      }
    } else {
      // 回退：经服务 /mcp tools/list（需服务在线）
      const fetchTools = async (baseUrl) => {
        await mcpInitialize(baseUrl);
        const r = await mcpPost(baseUrl, { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
        return r.tools || [];
      };
      try {
        let tools;
        if (side === 'vm') tools = await fetchTools(baseUrlForSide('vm'));
        else tools = await withTunnel(vm, fetchTools);
        console.log(`== 已暴露 MCP 工具（经服务 tools/list，共 ${tools.length} 项）==\n`);
        for (const t of tools) console.log(`    · ${t.name}  ${t.description ? '— ' + t.description : ''}`);
      } catch (e) {
        console.error(`无法列举 MCP 工具（注册表不可用且服务未在线）：${e.message}`);
        process.exitCode = 1;
      }
    }
  } else if (sub === 'dirs') {
    if (side === 'host') {
      const p = hostPaths();
      printList('宿主机关键目录', [
        `插件缓存    : ${p.pluginsCache}`,
        `注册表      : ${p.installedPlugins}`,
        `连接器目录  : ${p.connectorsDir}`,
        `共享 Skills : ${p.skillsDir}`,
      ], '', json);
    } else {
      const v = vmPaths();
      printList('VM 关键目录', [
        `VM 根目录     : ${v.repoRoot}`,
        `服务入口      : ${v.cliEntry}`,
        `运行配置      : ${v.runtimeConfig}`,
        `共享 Skills   : ${v.sharedSkillsRoot}`,
        `计划任务名    : ${v.taskName}`,
      ], '', json);
    }
  } else {
    console.error(`未知 list 子命令：${sub || '(空)'}（支持 skills / mcp-servers / mcp-tools / dirs）`);
    process.exitCode = 1;
  }
}

function printList(title, items, detail, json) {
  if (json) {
    console.log(JSON.stringify(items, null, 2));
    return;
  }
  console.log(`== ${title} ==`);
  if (detail) console.log(`   (${detail})`);
  console.log('');
  if (!items.length) console.log('  （空）');
  for (const it of items) console.log(`  · ${it}`);
}

async function cmdServer(side, vm, action) {
  if (!['start', 'status', 'stop', 'restart'].includes(action)) {
    console.error(`未知 server 动作：${action || '(空)'}（支持 start / status / stop / restart）`);
    process.exitCode = 1;
    return;
  }

  const task = side === 'vm' ? vmPaths().taskName : 'WinVMBridge.Service';
  const port = side === 'vm' ? vmPaths().servicePort : vm.servicePort;

  // D12：host→VM 不再用 `schtasks /Xxx` —— VM 默认 shell 是 MSYS Git-Bash，会把 `/Xxx` 改写成
  // Windows 路径（`/Query`→`C:/Program Files/Git/Query`）导致 schtasks 报无效参数（status 假阴性）。
  // 统一改用 PowerShell 计划任务 cmdlet；片段内**无 `$`、无 `/` 前缀参数** → bash/cmd 均可移植。
  const script = {
    registered: `if (Get-ScheduledTask -TaskName '${task}' -ErrorAction SilentlyContinue) { Write-Output REGISTERED } else { Write-Output MISSING }`,
    start: `Start-ScheduledTask -TaskName '${task}'`,
    stop: `Stop-ScheduledTask -TaskName '${task}'`,
    // 强杀残留端口进程（保留 restart 的「先停后起 + 强杀残留」语义）。用 `if (命令)` 作真值判断，
    // 避免 `$` 变量；STOP 前先判有无监听，空集时不误报参数绑定错误。
    killResidual:
      `if (Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue) { ` +
      `Stop-Process -Id (Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique) -Force -ErrorAction SilentlyContinue }`,
    portProbe: `Test-NetConnection -ComputerName 127.0.0.1 -Port ${port} -InformationLevel Quiet`,
  };

  /** 在目标侧执行 PS 片段：VM 侧本机 spawn powershell；host 侧经 SSH（psRemote）。返回退出码。 */
  const runPs = async (ps, inherit = side === 'vm') => {
    if (side === 'vm') {
      return sh('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: inherit ? 'inherit' : 'ignore' }).status;
    }
    try { psRemote(vm, ps); return 0; } catch { return 1; }
  };

  if (action === 'status') {
    let q = false;
    if (side === 'vm') {
      q = sh('powershell', ['-NoProfile', '-NonInteractive', '-Command', script.registered]).stdout.includes('REGISTERED');
    } else {
      try { q = psRemote(vm, script.registered).includes('REGISTERED'); } catch { q = false; }
    }
    const listening = side === 'vm'
      ? await isPortListening('127.0.0.1', port)
      : (() => { try { return psRemote(vm, script.portProbe).trim().toLowerCase() === 'true'; } catch { return false; } })();
    console.log(`计划任务 ${task} : ${q ? '已注册' : '未注册'}`);
    console.log(`服务端口 :${port} : ${listening ? '监听中 ✅' : '未监听'}`);
    return;
  }

  if (action === 'start') {
    await runPs(script.start);
    console.log(`已触发启动（Start-ScheduledTask -TaskName ${task}）`);
    if (side === 'vm') {
      let listening = false;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 500));
        listening = await isPortListening('127.0.0.1', port);
        if (listening) break;
      }
      console.log(listening ? `✅ 服务已在 :${port} 监听` : `⚠ 已触发启动但 :${port} 仍未监听（事件日志 / 运行配置 .generated/vm-service.runtime.json 排查）`);
    }
    return;
  }

  if (action === 'stop') {
    await runPs(script.stop);
    console.log(`已请求停止（Stop-ScheduledTask -TaskName ${task}）`);
    return;
  }

  if (action === 'restart') {
    await runPs(script.stop);
    await new Promise((r) => setTimeout(r, 2000));
    // 强杀残留端口进程，确保新实例能绑定（避免 MultipleInstancesPolicy=IgnoreNew 拦截）
    await runPs(script.killResidual, false);
    await new Promise((r) => setTimeout(r, 1000));
    await runPs(script.start);
    console.log(`已重启（Stop-ScheduledTask → kill 残留 → Start-ScheduledTask -TaskName ${task}）`);
    return;
  }
}

async function cmdCommand(side, vm, tool, argsJson) {
  if (!tool) {
    console.error('用法：winvm-plugin command <tool> [--args \'<json>\']');
    console.error('      查看可用工具：winvm-plugin list mcp-tools');
    process.exitCode = 1;
    return;
  }
  let args = {};
  if (argsJson) {
    try {
      args = JSON.parse(argsJson);
    } catch (e) {
      console.error(`--args 不是合法 JSON：${e.message}`);
      process.exitCode = 1;
      return;
    }
  }

  const invoke = async (baseUrl) => {
    const res = await mcpCallTool(baseUrl, tool, args);
    const texts = (res?.content || []).filter((c) => c.type === 'text').map((c) => c.text);
    return texts.join('\n') || JSON.stringify(res, null, 2);
  };

  try {
    if (side === 'vm') {
      const out = await invoke(baseUrlForSide('vm'));
      console.log(out);
    } else {
      const out = await withTunnel(vm, invoke);
      console.log(out);
    }
  } catch (e) {
    console.error(`调用工具 ${tool} 失败：${e.message}`);
    process.exitCode = 1;
  }
}

function cmdUninstall(side, vm, withVm) {
  if (side === 'host') {
    const repo = repoDirForHostInstaller();
    if (repo) {
      console.log(`宿主机卸载：node ${join(repo, 'delivery', 'install-host.mjs')} --uninstall --yes`);
      const r = sh('node', [join(repo, 'delivery', 'install-host.mjs'), '--uninstall', '--yes'], { stdio: 'inherit' });
      if (r.status !== 0) process.exitCode = 1;
    } else {
      console.error('未找到仓库 install-host.mjs（请在项目目录运行，或 --repo 暂未支持）。');
      process.exitCode = 1;
    }
    if (withVm) {
      console.log('\n同时卸载 VM 侧...');
      try {
        // R8 根除批（2026-10-30）：旧形 `cd "<dir>" && node …` 依赖远端 shell 语义
        // （cmd 跨驱动器需 `cd /d`、Git-Bash 又走 MSYS 路径）——统一改 EncodedCommand
        // PowerShell（Set-Location + &node），单 token 跨壳（cmd/bash/pwsh）可移植。
        const dir = vmPathsForSsh(vm);
        const ps =
          `$ErrorActionPreference='Stop'; Set-Location -LiteralPath '${dir.replace(/'/g, "''")}'; ` +
          `& node delivery/install-vm.mjs --uninstall --yes --provider ${vm.provider || 'workbuddy'} --cli ${vm.cli || 'codebuddy'}`;
        const encoded = Buffer.from(ps, 'utf16le').toString('base64');
        const out = sshExec(vm, `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`);
        console.log(out);
      } catch (e) {
        console.error(`VM 卸载失败：${e.message}`);
        process.exitCode = 1;
      }
    }
  } else {
    const v = vmPaths();
    console.log(`VM 卸载：node ${join(v.repoRoot, 'delivery', 'install-vm.mjs')} --uninstall --yes`);
    const r = sh('node', [join(v.repoRoot, 'delivery', 'install-vm.mjs'), '--uninstall', '--yes'], { stdio: 'inherit' });
    if (r.status !== 0) process.exitCode = 1;
  }
}

function vmPathsForSsh(vm) {
  return process.env['WINVM_VM_DEPLOY_DIR'] || 'C:/Users/User/.WinVMBridge';
}

function cmdUpdate(side, vm) {
  if (side === 'host') {
    const repo = repoDirForHostInstaller();
    if (repo) {
      console.log(`宿主机重新部署：node ${join(repo, 'delivery', 'install-host.mjs')} --user ${vm.user || 'towyq'}`);
      const r = sh('node', [join(repo, 'delivery', 'install-host.mjs'), '--user', vm.user || 'towyq'], { stdio: 'inherit' });
      if (r.status !== 0) process.exitCode = 1;
    } else {
      console.error('未找到仓库 install-host.mjs（请在项目目录运行）。');
      process.exitCode = 1;
    }
  } else {
    const v = vmPaths();
    console.log(`VM 重新部署：node ${join(v.repoRoot, 'delivery', 'install-vm.mjs')}`);
    const r = sh('node', [join(v.repoRoot, 'delivery', 'install-vm.mjs')], { stdio: 'inherit' });
    if (r.status !== 0) process.exitCode = 1;
  }
}

function cmdReinstall(side, vm) {
  console.log('== 重新安装（先卸载后安装）==\n');
  cmdUninstall(side, vm, false);
  if (process.exitCode) return;
  console.log('');
  cmdUpdate(side, vm);
}

/* ============================ 常驻隧道（host 侧，CL-015 T12 / P0-02） ============================ */

const TUNNEL_PIDFILE = () => join(homedir(), '.workbuddy', 'winvm', 'tunnel.pid');
const TUNNEL_STATE = () => join(homedir(), '.workbuddy', 'winvm', 'tunnel.state.json');
const TUNNEL_LOG = () => join(homedir(), '.workbuddy', 'winvm', 'tunnel.log');

function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  // /proc 语义：ESRCH=进程不存在（死）；EPERM/EACCES=进程存在但无权限信号（存活）。
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code !== 'ESRCH'; }
}

/**
 * 读取隧道状态（pidfile + state + 端口探测），返回三态判定。
 *
 * D6-B（属主交叉校验）：健康判定**只**依据 pidfile 的进程存活（+ 端口可连）。
 * `tunnel.state.json` 若其 `pid` 与 pidfile 的 `pid` 不一致，即判为**陈旧**（可能来自已退出 /
 * 以临时 pidfile 启动的实例），仅作诊断展示，**绝不参与健康决策** ——
 * 从而不会因陈旧 state 把健康隧道误判为 DEGRADED，也不会让 `ensure` 误重启健康隧道。
 * @returns {{state:'RUNNING'|'DEGRADED'|'STOPPED', pid?:number, alive?:boolean, portOpen:boolean, localPort?:number, stateObj?:object, stateOwner?:number|null, ownerMatch:boolean, stateStale:boolean}}
 */
async function readTunnelStatus(localPort = 18443) {
  const pidPath = TUNNEL_PIDFILE();
  const pidObj = readJsonSafe(pidPath);
  const stateObj = readJsonSafe(TUNNEL_STATE());
  const portOpen = await isPortListening('127.0.0.1', localPort, 800);
  const pid = pidObj?.pid;
  const alive = pid ? isPidAlive(pid) : false;
  const stateOwner = stateObj?.pid ?? null;
  // 属主匹配：state 自报的 pid 必须与 pidfile 的 pid 一致，才算「本实例的状态」。
  const ownerMatch = stateObj != null && pidObj != null && stateOwner === pid;
  const stateStale = stateObj != null && !ownerMatch;
  const base = { pid, alive, portOpen, localPort, stateObj, stateOwner, ownerMatch, stateStale };
  // 进程存活 ∧ 端口可连 → 在线。**不因陈旧 state 而降级**。
  if (alive && portOpen) {
    // 仅当 state 确属本实例且明确报告未存活时才如实标注 DEGRADED；陈旧 state 一律忽略。
    const freshDegraded = ownerMatch && stateObj.alive !== true;
    return { ...base, state: freshDegraded ? 'DEGRADED' : 'RUNNING' };
  }
  // 进程存活但端口不通 → 运行中但不健康。
  if (alive) return { ...base, state: 'DEGRADED' };
  // 陈旧 pidfile：进程已不在 → STOPPED 并清理 pidfile（不动 state，避免误删诊断信息）。
  if (pidObj && !alive) { try { rmSync(pidPath, { force: true }); } catch { /* ignore */ } }
  return { ...base, state: 'STOPPED' };
}

/**
 * 拉起常驻隧道守护进程（detached，父进程退出后仍存活）。
 * @returns {Promise<number>} 0 = 已启动/已在运行（幂等）；1 = 启动失败
 */
async function spawnTunnelDaemon(vm, a) {
  const daemonPath = join(__dirname, 'tunnel-daemon.mjs');
  if (!existsSync(daemonPath)) {
    console.error(`隧道守护进程不存在：${daemonPath}`);
    return 1;
  }
  const localPort = Number(a.localPort ?? vm.servicePort ?? 18443);
  const remotePort = Number(a.remotePort ?? a.vmPort ?? vm.servicePort ?? 18443);
  const status = await readTunnelStatus(localPort);
  if (status.state !== 'STOPPED') {
    console.log(`隧道已在运行（pid ${status.pid}），未重复启动`);
    return 0; // 幂等：不报错、不产生第二实例（B3/B8）
  }
  const args = [
    daemonPath,
    '--vm-host', vm.host,
    '--vm-user', vm.user,
    '--vm-ssh-port', String(vm.sshPort ?? 22),
    '--local-port', String(localPort),
    '--remote-port', String(remotePort),
  ];
  if (vm.identityFile) args.push('--key', vm.identityFile);
  const env = { ...process.env };
  if (vm.password) env['WINVM_VM_PASSWORD'] = vm.password; // 仅经环境变量，不落命令行/日志
  try {
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env,
    });
    child.unref(); // 父事件循环不因该子进程滞留；子进程自成进程组，父退出仍存活
  } catch (e) {
    console.error(`拉起隧道失败：${e.message}`);
    return 1;
  }
  // 轮询端口可达（有界），确认守护进程已就绪。
  const deadline = Date.now() + 20_000;
  let open = false;
  while (Date.now() < deadline) {
    if (await isPortListening('127.0.0.1', localPort, 500)) { open = true; break; }
    await new Promise((r) => setTimeout(r, 400));
  }
  if (!open) {
    // Q1（批2）：daemon 现在启动期失败进退避重试而不退出进程。
    // 端口 20s 未就绪时先分辨「daemon 仍在后台自愈」与「daemon 已放弃」两种终局：
    //   - pidfile 存在且进程存活 ⇒ daemon 活着、正按指数退避重试（VM 未醒场景），
    //     报告"自愈中"并返回 0（不再是"启动超时=失败"的误导口径）；
    //   - 进程已不在 ⇒ 真失败（参数错误/重试上限放弃），返回 1 并指到 STOPPED state 留痕。
    const pidObj = readJsonSafe(TUNNEL_PIDFILE());
    if (pidObj?.pid && isPidAlive(pidObj.pid)) {
      console.log(`隧道尚未就绪（20s 内端口未监听），但守护进程存活（pid ${pidObj.pid}）——` +
        `正在按指数退避后台自愈（VM 可能未醒）。详见日志：${TUNNEL_LOG()}；` +
        `tunnel status 可随时查最新态。`);
      return 0;
    }
    const stObj = readJsonSafe(TUNNEL_STATE());
    const reason = stObj?.reason ? `（state.reason=${stObj.reason}）` : '';
    console.error('隧道启动失败：守护进程已退出' + reason + '。详见日志：' + TUNNEL_LOG());
    return 1;
  }
  console.log(`隧道已启动：127.0.0.1:${localPort} → ${vm.user}@${vm.host}:${vm.sshPort ?? 22} → 127.0.0.1:${remotePort}`);
  return 0;
}

/**
 * 停止常驻隧道（读 pidfile → SIGTERM → 有界等待端口关闭 → 删 pidfile/state）。
 * @returns {Promise<number>} 0 = 已停止/本就未运行（幂等）
 */
async function stopTunnelDaemon(localPort = 18443, force = false) {
  const pidPath = TUNNEL_PIDFILE();
  const pidObj = readJsonSafe(pidPath);
  const pid = pidObj?.pid;
  if (!pid || !isPidAlive(pid)) {
    console.log('隧道未运行（无需停止）');
    try { rmSync(pidPath, { force: true }); rmSync(TUNNEL_STATE(), { force: true }); } catch { /* ignore */ }
    return 0; // 幂等
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    if (!force) { console.error('优雅停止失败，可用 --force 强杀'); return 1; }
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) break;
    if (force) { try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ } }
    await new Promise((r) => setTimeout(r, 300));
  }
  try { rmSync(pidPath, { force: true }); rmSync(TUNNEL_STATE(), { force: true }); } catch { /* ignore */ }
  console.log('隧道已停止');
  return 0;
}

/**
 * tunnel 子命令：start | ensure | restart | stop | status。
 * 守卫：win32/darwin 不 spawn 任何进程（隧道后端仍系统 ssh），仅打印说明并 exit 0（NFR-2/B9）。
 *
 * ensure 与 start 等价：spawnTunnelDaemon 内部已按状态幂等（已在运行则跳过，不产生第二实例），
 * 故 ensure 专用于「WorkBuddy 启动时自动拉起」场景——可安全重复调用，永不重复起进程。
 * ensure 额外保证「在线健康」：RUNNING 直接跳过；DEGRADED 自动重启一次；STOPPED 才拉起。
 */
async function cmdTunnel(side, vm, a) {
  if (side !== 'host') {
    console.error('tunnel 仅用于宿主机侧（host）。VM 侧无需常驻隧道。');
    process.exitCode = 1;
    return;
  }
  if (process.platform === 'win32' || process.platform === 'darwin') {
    console.log('当前为 Windows/macOS 宿主，隧道由系统 ssh 提供，无需（也不会）拉起常驻进程。');
    return;
  }
  const action = a.tunnelAction ?? 'status';
  const localPort = Number(a.localPort ?? vm.servicePort ?? 18443);
  if (!['start', 'ensure', 'stop', 'restart', 'status'].includes(action)) {
    console.error(`未知 tunnel 动作：${action}（支持 start / ensure / status / stop / restart）`);
    process.exitCode = 1;
    return;
  }
  if (action === 'restart') {
    // 强制重启：先停（必要时强杀）再启动。用于隧道「在线但不健康」的兜底恢复。
    const st = await readTunnelStatus(localPort);
    if (st.pid && st.alive) {
      console.log(`重启隧道（当前 pid ${st.pid}，先停后起）…`);
      await stopTunnelDaemon(localPort, true);
      await new Promise((r) => setTimeout(r, 600));
    }
    process.exitCode = await spawnTunnelDaemon(vm, a);
    return;
  }
  if (action === 'start') {
    process.exitCode = await spawnTunnelDaemon(vm, a);
    return;
  }
  if (action === 'ensure') {
    // 幂等「确保在线健康」：RUNNING → 直接返回 0（不产生第二实例）；
    // DEGRADED（进程存活但 health 判定不通过）→ 重启一次以恢复；
    // STOPPED → 拉起。任意重复调用都收敛到「隧道在线健康」，故对（重）安装/启动钩子安全。
    const st = await readTunnelStatus(localPort);
    if (st.state === 'RUNNING') {
      console.log(`隧道已在线健康（pid ${st.pid}），无需拉起`);
      return; // 退出码默认 0（幂等跳过）
    }
    if (st.state === 'DEGRADED') {
      console.log(`隧道不健康（pid ${st.pid}，DEGRADED），执行一次重启以恢复…`);
      await stopTunnelDaemon(localPort, true);
      await new Promise((r) => setTimeout(r, 800));
    }
    process.exitCode = await spawnTunnelDaemon(vm, a);
    return;
  }
  if (action === 'stop') {
    process.exitCode = await stopTunnelDaemon(localPort, a.force);
    return;
  }
  // status（默认）
  const st = await readTunnelStatus(localPort);
  const out = {
    state: st.state,
    healthy: st.state === 'RUNNING',
    localHost: '127.0.0.1',
    localPort: st.localPort ?? localPort,
    vm: { host: vm.host, user: vm.user, sshPort: vm.sshPort ?? 22, servicePort: vm.servicePort ?? 18443 },
    pid: st.pid ?? null,
    lastEvent: st.stateObj?.lastEvent ?? null,
    // D6-B 诊断字段（不误导）：state 属主 vs pidfile 是否一致；陈旧 state 不参与健康判定。
    stateOwner: st.stateOwner ?? null,
    ownerMatch: st.ownerMatch ?? false,
    stateStale: st.stateStale ?? false,
    pidfile: TUNNEL_PIDFILE(),
    logPath: TUNNEL_LOG(),
  };
  if (a.json) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    const human = { RUNNING: '运行中（可连）', DEGRADED: '运行中（不健康，重连中）', STOPPED: '未运行' }[st.state];
    console.log('隧道状态 : ' + human);
    console.log(`监听     : 127.0.0.1:${out.localPort}`);
    console.log(`目标 VM  : ${out.vm.user}@${out.vm.host}:${out.vm.sshPort} → 127.0.0.1:${out.vm.servicePort}`);
    // 通道模式：宿主侧通道选择策略（MCP 直调 / A2A 委派 / 智能判断），事实源见 winvm-plugin tunnel-mode
    console.log(`通道模式  : ${vm.tunnelMode ?? 'mcp'}（来源：${vm.tunnelModeSource ?? 'default'}）`);
    if (st.pid) console.log(`进程     : pid ${st.pid}（独立进程组，终端关闭后仍存活）`);
    if (st.stateStale) {
      console.log(`诊断     : ⚠ tunnel.state.json 属主 pid ${st.stateOwner} ≠ pidfile pid ${st.pid}（陈旧，已忽略，不参与健康判定）`);
    } else if (st.ownerMatch) {
      console.log(`诊断     : tunnel.state.json 与 pidfile 属主一致（pid ${st.pid}）`);
    }
    console.log(`台账     : ${out.pidfile}`);
    console.log(`日志     : ${out.logPath}`);
  }
  process.exitCode = st.state === 'RUNNING' ? 0 : st.state === 'DEGRADED' ? 4 : 3;
}

/* ============================ 参数解析 ============================ */

function parseArgs(argv) {
  const out = { side: undefined, sub: undefined, subArg: undefined, tool: undefined, args: undefined, json: false, vmHost: undefined, vmUser: undefined, vmSshPort: undefined, vmPort: undefined, vmProvider: undefined, vmCli: undefined, vmKey: undefined, vm: false, tunnelAction: undefined, localPort: undefined, remotePort: undefined, foreground: false, force: false, tunnelMode: undefined, tunnelModeArg: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--side': out.side = argv[++i]; break;
      case '--json': out.json = true; break;
      case '--vm-host': out.vmHost = argv[++i]; break;
      case '--vm-user': out.vmUser = argv[++i]; break;
      case '--vm-ssh-port': out.vmSshPort = argv[++i]; break;
      case '--vm-port': out.vmPort = argv[++i]; break;
      case '--vm-provider': out.vmProvider = argv[++i]; break;
      case '--vm-cli': out.vmCli = argv[++i]; break;
      case '--vm-key': out.vmKey = argv[++i]; break;
      case '--tunnel-mode': out.tunnelMode = argv[++i]; break;
      case '--vm': out.vm = true; break;
      case '--local-port': out.localPort = Number(argv[++i]); break;
      case '--remote-port': out.remotePort = Number(argv[++i]); break;
      case '--foreground': out.foreground = true; break;
      case '--force': out.force = true; break;
      case '--args': out.args = argv[++i]; break;
      default:
        if (!out.sub) out.sub = a;
        else if (out.sub === 'list' && !out.subArg) out.subArg = a;
        else if (out.sub === 'server' && !out.subArg) out.subArg = a;
        else if (out.sub === 'tunnel' && !out.tunnelAction) out.tunnelAction = a;
        else if (out.sub === 'tunnel-mode' && !out.tunnelModeArg) out.tunnelModeArg = a;
        else if (out.sub === 'command' && !out.tool) out.tool = a;
        break;
    }
  }
  return out;
}

/* ============================ 入口 ============================ */

const USAGE = `
WinVM Bridge —— 插件管理命令 winvm-plugin

上下文：自动识别 host（宿主机）/ vm（虚拟机）；可用 --side host|vm 覆盖。

用法：
  winvm-plugin help
  winvm-plugin check
  winvm-plugin health
  winvm-plugin list skills|mcp-servers|mcp-tools|dirs   [--json]
  winvm-plugin server start|status|stop|restart
  winvm-plugin command <tool> [--args '<json>']
  winvm-plugin tunnel start|ensure|status|stop|restart [--local-port 18443] [--remote-port 18443] [--force]
  winvm-plugin tunnel-mode [mcp|a2a|intelligent]
                                       # 无参=显示当前通道模式与来源；带参=写回 vm-conn.json
                                       # 通道模式：宿主侧通道选择策略 —— mcp（默认，MCP 直调）/
                                       # a2a（A2A 委派）/ intelligent（按任务特征智能判断）
  winvm-plugin uninstall [--vm]          # host 加 --vm 同时卸载 VM
  winvm-plugin update
  winvm-plugin reinstall

Host 侧需要 VM 连接（server/health/command 走 SSH）：
  优先 --vm-host/--vm-user/--vm-ssh-port/--vm-port（另可 --vm-provider/--vm-cli），
  其次环境变量 WINVM_VM_*，再次从部署期持久化配置 ~/.workbuddy/winvm/vm-conn.json，
  最后从 .env（VM_HOST/VM_USER/VM_SSH_PORT/WINVM_SERVICE_PORT）读取。
  （vm-conn.json 由宿主安装器 install-host.mjs 在部署时自动写入，故通常无需手动指定。）

通道模式（tunnel-mode）优先级：--tunnel-mode <mode> > 环境变量 WINVM_TUNNEL_MODE >
  vm-conn.json 的 tunnelMode 字段 > 默认 mcp。该配置指引宿主 Agent 在 MCP 直调
  （connector:winvm）与 A2A 委派（connector:winvm-a2a）之间如何选择；详细语义见主控 skill。

示例：
  # 宿主机
  winvm-plugin list mcp-tools
  winvm-plugin health
  winvm-plugin server restart --vm-host 192.168.1.50 --vm-user vmadmin   # 不传则读 .env 的 VM_HOST / VM_USER
  winvm-plugin command meta.health.check

  # VM 内（已 RDP 登录的交互式会话）
  winvm-plugin check
  winvm-plugin server status
  winvm-plugin command system.info.query --args '{}'
`;

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const side = detectSide(a.side);
  const vm = loadVmConn(a);

  switch (a.sub) {
    case 'help':
    case undefined:
      cmdHelp();
      break;
    case 'check':
      await cmdCheck(side, vm);
      break;
    case 'health':
      await cmdHealth(side, vm);
      break;
    case 'list':
      await cmdList(side, vm, a.subArg, a.json);
      break;
    case 'tunnel':
      await cmdTunnel(side, vm, a);
      break;
    case 'tunnel-mode':
      cmdTunnelMode(a);
      break;
    case 'server':
      await cmdServer(side, vm, a.subArg);
      break;
    case 'command':
      await cmdCommand(side, vm, a.tool, a.args);
      break;
    case 'uninstall':
      cmdUninstall(side, vm, a.vm);
      break;
    case 'update':
      cmdUpdate(side, vm);
      break;
    case 'reinstall':
      cmdReinstall(side, vm);
      break;
    default:
      console.error(`未知子命令：${a.sub}\n`);
      cmdHelp();
      process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  main().catch((e) => {
    console.error(e?.stack || e?.message || String(e));
    process.exitCode = 1;
  });
}

// 导出供单测校验（resolveVmConn 已在定义处导出；loadVmConn 的 vm-conn.json 兜底来源、detectSide 的 side.json 判定）
export { loadVmConn, detectSide };

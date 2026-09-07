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
  return { host, user, sshPort, servicePort, provider, cli };
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
  return resolveVmConn({ argv, env, dotEnv, persisted });
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

/** 建立临时 SSH 隧道（localPort -> VM 127.0.0.1:servicePort），执行 fn(baseUrl) 后拆除 */
async function withTunnel(vm, fn) {
  if (!vm.host || !vm.user) {
    throw new Error('缺少 VM 连接信息：请在仓库目录运行（读 .env）或传 --vm-host/--vm-user');
  }
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
      for (const acct of readdirSync(p.connectorsDir)) {
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
    // 端口监听
    const listening = sh('powershell', ['-NoProfile', '-Command', `Test-NetConnection -ComputerName 127.0.0.1 -Port ${v.servicePort} -InformationLevel Quiet`], { stdio: 'ignore' });
    const portOk = listening.stdout.trim().toLowerCase() === 'true';
    checks.push(['服务端口监听中', portOk, `127.0.0.1:${v.servicePort}`]);

    let allOk = true;
    for (const [name, ok, detail] of checks) {
      console.log(`  ${ok ? '✅' : '❌'} ${name}`);
      if (detail) console.log(`       ${detail}`);
      if (!ok) allOk = false;
    }
    console.log(`\n结论：${allOk ? 'VM 部署完整且服务在线 ✅' : '存在问题，见上方 ❌（端口未监听不代表部署失败，可能服务未启动）'}`);
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
        for (const acct of readdirSync(p.connectorsDir)) {
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

  const runOnVm = async (remoteCmd) => {
    if (side === 'vm') {
      const r = sh('powershell', ['-NoProfile', '-Command', remoteCmd], { stdio: 'inherit' });
      return r.status;
    }
    return sshExec(vm, remoteCmd, 60000) ? 0 : 1;
  };

  const task = side === 'vm' ? vmPaths().taskName : 'WinVMBridge.Service';
  const port = side === 'vm' ? vmPaths().servicePort : vm.servicePort;

  if (action === 'status') {
    const q = side === 'vm'
      ? sh('schtasks', ['/Query', '/TN', task], { stdio: 'ignore' }).status === 0
      : (() => { try { return sshExec(vm, `schtasks /Query /TN ${task}`).includes(task); } catch { return false; } })();
    const listenCmd = `powershell -NoProfile -Command "Test-NetConnection -ComputerName 127.0.0.1 -Port ${port} -InformationLevel Quiet"`;
    const listening = side === 'vm'
      ? sh('powershell', ['-NoProfile', '-Command', `Test-NetConnection -ComputerName 127.0.0.1 -Port ${port} -InformationLevel Quiet`], { stdio: 'ignore' }).stdout.trim().toLowerCase() === 'true'
      : (() => { try { return sshExec(vm, listenCmd).trim().toLowerCase() === 'true'; } catch { return false; } })();
    console.log(`计划任务 ${task} : ${q ? '已注册' : '未注册'}`);
    console.log(`服务端口 :${port} : ${listening ? '监听中 ✅' : '未监听'}`);
    return;
  }

  if (action === 'start') {
    await runOnVm(`schtasks /run /tn ${task}`);
    console.log(`已触发启动（schtasks /run /tn ${task}）`);
    return;
  }

  if (action === 'stop') {
    await runOnVm(`schtasks /end /tn ${task}`);
    console.log(`已请求停止（schtasks /end /tn ${task}）`);
    return;
  }

  if (action === 'restart') {
    await runOnVm(`schtasks /end /tn ${task}`);
    await new Promise((r) => setTimeout(r, 2000));
    // 强杀残留端口进程，确保新实例能绑定（避免 MultipleInstancesPolicy=IgnoreNew 拦截）
    const killCmd = `powershell -NoProfile -Command "$p=(Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue).OwningProcess|Select-Object -Unique; if($p){Stop-Process -Id $p -Force -ErrorAction SilentlyContinue}"`;
    if (side === 'vm') sh('powershell', ['-NoProfile', '-Command', `$p=(Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue).OwningProcess|Select-Object -Unique; if($p){Stop-Process -Id $p -Force -ErrorAction SilentlyContinue}`], { stdio: 'ignore' });
    else try { sshExec(vm, killCmd); } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 1000));
    await runOnVm(`schtasks /run /tn ${task}`);
    console.log(`已重启（kill 残留 → schtasks /run /tn ${task}）`);
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
        const out = sshExec(vm, `cd "${vmPathsForSsh(vm)}" && node delivery/install-vm.mjs --uninstall --yes --provider ${vm.provider || 'workbuddy'} --cli ${vm.cli || 'codebuddy'}`);
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

/* ============================ 参数解析 ============================ */

function parseArgs(argv) {
  const out = { side: undefined, sub: undefined, subArg: undefined, tool: undefined, args: undefined, json: false, vmHost: undefined, vmUser: undefined, vmSshPort: undefined, vmPort: undefined, vmProvider: undefined, vmCli: undefined, vm: false };
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
      case '--vm': out.vm = true; break;
      case '--args': out.args = argv[++i]; break;
      default:
        if (!out.sub) out.sub = a;
        else if (out.sub === 'list' && !out.subArg) out.subArg = a;
        else if (out.sub === 'server' && !out.subArg) out.subArg = a;
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
  winvm-plugin uninstall [--vm]          # host 加 --vm 同时卸载 VM
  winvm-plugin update
  winvm-plugin reinstall

Host 侧需要 VM 连接（server/health/command 走 SSH）：
  优先 --vm-host/--vm-user/--vm-ssh-port/--vm-port（另可 --vm-provider/--vm-cli），
  其次环境变量 WINVM_VM_*，再次从部署期持久化配置 ~/.workbuddy/winvm/vm-conn.json，
  最后从 .env（VM_HOST/VM_USER/VM_SSH_PORT/WINVM_SERVICE_PORT）读取。
  （vm-conn.json 由宿主安装器 install-host.mjs 在部署时自动写入，故通常无需手动指定。）

示例：
  # 宿主机
  winvm-plugin list mcp-tools
  winvm-plugin health
  winvm-plugin server restart --vm-host 100.108.20.13 --vm-user User
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

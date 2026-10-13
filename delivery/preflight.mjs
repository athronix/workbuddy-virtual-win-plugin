#!/usr/bin/env node
/**
 * WinVM Bridge —— 环境依赖预检模块（零外部依赖，纯 Node 内置）
 *
 * 用途：安装脚本（install-host.mjs / install-vm.mjs）在真正执行安装/构建前，
 *       先探测宿主 / VM 本地的必备依赖，不满足则强制中止，要求用户补齐。
 *
 * 设计要点：
 *  - 只依赖 Node 内置模块（node:fs / node:os / node:child_process / node:path / node:process），
 *    不 import 任何 @winvm/* 与仓库其它文件，因此可在「尚未构建 / 离线沙箱」下被加载与单测。
 *  - 所有函数为纯函数或薄封装，便于测试注入（home / platform / minNode / provider / cli 均可参数化）。
 *  - VM 侧依赖在「VM 本地」探测（安装脚本就在 VM 内跑），不走 SSH；
 *    探测靠 spawnSync(cli,['--version'],{shell:true}) 让 shell 解析 PATH，无需固定路径。
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * @typedef {Object} NodeVersion
 * @property {number} major
 * @property {number} minor
 * @property {number} patch
 */

/**
 * @typedef {Object} Check
 * @property {string} id        检查项标识
 * @property {string} label     可读名称
 * @property {boolean} ok       是否通过
 * @property {string} detail    检测细节（路径 / 版本等）
 * @property {string} remedy    不满足时的处置指引
 * @property {boolean} blocking 是否阻断安装（false 仅 WARNING）
 */

/**
 * 从 `v18.20.4` / `18.20.4` / `v24.13.0` 之类解析语义化版本。
 * 非法（无法解析出三个数字）返回 null。
 * @param {string} v
 * @returns {NodeVersion | null}
 */
export function parseNodeVersion(v) {
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
  };
}

/**
 * 语义化比较：a >= b ?（major→minor→patch）。
 * 两边都能 parse 才比较，否则返回 false。
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function versionGte(a, b) {
  const va = parseNodeVersion(a);
  const vb = parseNodeVersion(b);
  if (!va || !vb) return false;
  if (va.major !== vb.major) return va.major > vb.major;
  if (va.minor !== vb.minor) return va.minor > vb.minor;
  return va.patch >= vb.patch;
}

/**
 * 宿主侧环境依赖预检（在宿主机本机跑；宿主=鸿蒙 HMOS，platform 报 linux/ohos）。
 * @param {{home?:string, platform?:string, minNode?:string}} [opts]
 * @returns {{ok:boolean, checks:Check[]}}
 */
export function checkHostDeps({ home = homedir(), platform = process.platform, minNode = '18.0.0' } = {}) {
  void platform; // 宿主探测与 platform 无关（只查 home 目录与本地 node），保留参数以对齐接口
  const checks = [];

  // 1. WorkBuddy 已部署：~/.workbuddy 目录存在
  const wbPath = join(home, '.workbuddy');
  const wbExists = existsSync(wbPath);
  checks.push({
    id: 'workbuddy-host',
    label: '宿主已部署 WorkBuddy',
    ok: wbExists,
    detail: wbExists ? `已找到 ${wbPath}` : `未找到 ${wbPath}`,
    remedy: '请在本机（鸿蒙宿主）安装并初始化 WorkBuddy，确保 ~/.workbuddy 目录存在后再安装本项目。',
    blocking: true,
  });

  // 2. node 版本 >= minNode
  const nodeVer = process.version; // 形如 v18.20.4
  const nodeOk = versionGte(nodeVer, minNode);
  checks.push({
    id: 'node-runtime',
    label: 'Node.js 运行时',
    ok: nodeOk,
    detail: `检测到 ${nodeVer}（要求 >= ${minNode}）`,
    remedy: '请安装 Node.js >= 18（强烈建议 >= 22）。',
    blocking: true,
  });

  // 整体结论以「阻断项」为准：警告项不计入 ok
  const ok = checks.filter((c) => c.blocking).every((c) => c.ok);
  return { ok, checks };
}

/**
 * VM 侧环境依赖预检（在 VM 本地跑，不走 SSH）。
 * 安装脚本自身就运行在 VM 内部，故依赖直接本地探测（shell 解析 PATH）。
 *
 * cli 解析优先级：显式传入 cli 优先；未传时按 provider 取默认
 *   workbuddy→codebuddy / hermes-agent→hermes，其它回落 'codebuddy'。
 *
 * @param {{provider?:string, cli?:string, minNode?:string}} [opts]
 * @returns {{ok:boolean, checks:Check[]}}
 */
export function checkLocalVmDeps({ provider = 'workbuddy-deterministic', cli, minNode = '18.0.0' } = {}) {
  // 显式 cli 优先于 provider 默认；未传时按 provider 解析
  const agentCli =
    cli ??
    (provider === 'workbuddy'
      ? 'codebuddy'
      : provider === 'hermes-agent'
        ? 'hermes'
        : 'codebuddy');

  // LLM 类 provider（workbuddy / hermes-agent）运行时 spawn 对应 CLI → 缺失即阻断；
  // workbuddy-deterministic 为确定性执行器，运行时不 spawn codebuddy → 仅 WARNING，不阻断。
  const isLlmProvider = provider === 'workbuddy' || provider === 'hermes-agent';

  const checks = [];

  // 1. VM 内有 node
  let nodeVer = null;
  let nodeOk = false;
  try {
    const r = spawnSync('node', ['-v'], { shell: true });
    if (r.status === 0) {
      nodeVer = (r.stdout?.toString() ?? '').trim();
      nodeOk = versionGte(nodeVer, minNode);
    }
  } catch {
    /* noop：探测失败按不满足处理 */
  }
  checks.push({
    id: 'vm-node',
    label: 'VM 内 Node.js',
    ok: nodeOk,
    detail: nodeVer ? `检测到 ${nodeVer}（要求 >= ${minNode}）` : '未检测到 node（command 未找到或非 0 退出）',
    remedy: '请在 VM（Windows）安装 Node.js >= 18。',
    blocking: true,
  });

  // 2. VM 内有 npm
  let npmOk = false;
  try {
    const r = spawnSync('npm', ['-v'], { shell: true });
    npmOk = r.status === 0;
  } catch {
    /* noop */
  }
  checks.push({
    id: 'vm-npm',
    label: 'VM 内 npm',
    ok: npmOk,
    detail: npmOk ? 'npm 可用' : '未检测到 npm（command 未找到或非 0 退出）',
    remedy: '请在 VM 安装 npm（随 Node.js 一并安装）。',
    blocking: true,
  });

  // 3. VM AI Agent CLI（codebuddy / hermes）
  let agentOk = false;
  try {
    // 用 --version（非 --help）避免交互；shell:true 让 Windows/Unix 都靠 PATH 解析
    const r = spawnSync(agentCli, ['--version'], { shell: true, stdio: 'ignore' });
    agentOk = r.status === 0;
  } catch {
    /* noop */
  }
  checks.push({
    id: 'vm-agent-cli',
    label: `VM AI Agent CLI（${agentCli}）`,
    ok: agentOk,
    detail: agentOk ? `${agentCli} 可用` : `未检测到 ${agentCli}（command 未找到或非 0 退出）`,
    remedy: `VM 侧 LLM provider 需要 ${agentCli} CLI；请安装 codebuddy（WorkBuddy CLI）并加入 PATH，或把 WINVM_VM_PROVIDER 改为 workbuddy-deterministic。`,
    blocking: isLlmProvider,
  });

  // 整体结论以「阻断项」为准：确定性 provider 的 agent CLI 为 WARNING，不计入 ok
  const ok = checks.filter((c) => c.blocking).every((c) => c.ok);
  return { ok, checks };
}

/**
 * Agent CLI **登录态/可用性**探测（Phase 3 批2 · DB-4/D-1 勘误口径）。
 *
 * 勘误背景：VM 内 codebuddy **安装性**检查已在两处覆盖（checkLocalVmDeps 的 vm-agent-cli
 * blocking 项 + install-vm 运行期硬门禁）；真实缺口是**登录态**——provider=workbuddy 未登录时
 * 直到首个委派才暴露为 LLM_SESSION/ENOENT。
 *
 * 真机实测局限（2026-10-13 VM 只读探针）：codebuddy CLI **无非交互身份命令**
 *（--help 全量子命令=config/mcp/sandbox/plugin/project/doctor/update/install/cleanup/daemon/
 *  ps/logs/attach/kill/stop/rm/respawn/agents/auto-mode，无 whoami/auth status/login status）。
 * 故登录态**不可被机械确证**，本函数实现的是**降级探测 + 局限显形**：
 *   - verdict='installed-unverified'：CLI 可跑（--version 通）但登录态无从证明 ⇒ WARNING，
 *     文案明说局限（红字"你现在是 deterministic；切 LLM 需先交互登录"由调用方打印）；
 *   - verdict='config-dir-present'：CLI 可跑 ∧ 配置根存在（~/.codebuddy 有 settings.json/user-state.json）
 *     ⇒ 仍只到"大概率登录过"，**不确证**（凭据不落可见文件，实测如此）；
 *   - verdict='cli-missing'：CLI 不可跑 ⇒ 由安装性检查阻断，本函数不重复定罪。
 * 注入点：runProbe 便于单测（默认不探测，返回 null=不可得）。
 *
 * @param {{provider?:string, cliExists?:boolean, configDirExists?:boolean, markerFiles?:string[]}} opts
 * @returns {{verdict:string, blocking:boolean, detail:string, remedy:string}}
 */
export function evaluateAgentLogin({ provider = 'workbuddy-deterministic', cliExists = false, configDirExists = false, markerFiles = [] } = {}) {
  const isLlm = provider === 'workbuddy' || provider === 'hermes-agent';
  if (!isLlm) {
    return {
      verdict: 'not-applicable',
      blocking: false,
      detail: `provider=${provider} 不依赖 Agent CLI 登录态（确定性执行器）`,
      remedy: '',
    };
  }
  if (!cliExists) {
    return {
      verdict: 'cli-missing',
      blocking: false, // 缺 CLI 由安装性检查定罪，此处不重复阻断
      detail: 'CLI 不可跑（安装性缺口，见 vm-agent-cli 检查项）',
      remedy: '先装 CLI，再谈登录态。',
    };
  }
  const hasMarkers = configDirExists && markerFiles.some((f) => f);
  if (hasMarkers) {
    return {
      verdict: 'config-dir-present',
      blocking: false,
      detail: `CLI 可跑 ∧ 配置根含标记文件 ⇒ 大概率已登录；⚠ 局限：codebuddy 无非交互身份命令（实测 --help 无 whoami/auth status），凭据不落可见文件，登录态无法机械确证`,
      remedy: '若委派报 LLM_SESSION/鉴权失败：VM 内交互跑一次 `codebuddy` 完成微信/GitHub 登录（结构性不可脚本化，DB-4）。',
    };
  }
  return {
    verdict: 'installed-unverified',
    blocking: false,
    detail: 'CLI 可跑（--version 通）但登录态无从证明（配置根/标记文件未见）',
    remedy: 'provider=workbuddy 需 VM 内已完成交互式登录（跑一次 `codebuddy` 走微信/GitHub 登录）。当前若为 deterministic 则不受影响。',
  };
}

/**
 * 渲染可读报告，每项一行：`[OK]/[缺失(阻断)]/[警告] label — detail`。
 * 不满足项额外附一行处置指引；末尾给整体结论。
 * @param {{ok:boolean, checks:Check[]}} result
 * @param {{headline?:string}} [opts]
 * @returns {string}
 */
export function printChecks(result, { headline } = {}) {
  const lines = [];
  if (headline) lines.push(headline);
  for (const c of result.checks) {
    let tag;
    if (c.ok) tag = '[OK]';
    else if (c.blocking) tag = '[缺失(阻断)]';
    else tag = '[警告]';
    lines.push(`${tag} ${c.label} — ${c.detail}`);
    if (!c.ok && c.remedy) {
      lines.push(`       ↳ 处置：${c.remedy}`);
    }
  }
  lines.push(
    result.ok
      ? '结论：环境依赖满足，可以继续安装。'
      : '结论：存在不满足的（阻断）依赖，请按上方处置完成部署后再安装。',
  );
  return lines.join('\n');
}

/**
 * 校验预检结果：若存在 `blocking && !ok` 则返回 false。
 * 不主动 exit，便于 CLI 入口统一处理退出码。
 * @param {{ok:boolean, checks:Check[]}} result
 * @param {{allowWarnings?:boolean}} [opts] 语义占位：警告不阻断，故不影响返回值
 * @returns {boolean}
 */
export function assertDeps(result, { allowWarnings = true } = {}) {
  void allowWarnings; // 警告项不阻断安装，仅作语义占位
  return result.checks.every((c) => !(c.blocking && !c.ok));
}

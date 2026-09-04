#!/usr/bin/env node
/**
 * WinVM Bridge —— 虚拟机侧（被控端）一键部署脚本
 *
 * 在 Windows VM 内运行，把仓库部署为常驻的 vm-service（双协议服务端）：
 *   1. 依赖解析        npm ci（按 lockfile 精确还原依赖，可复现，可 --skip-install 跳过）；
 *                      产物分发场景（宿主 setup.mjs 推来的只有 dist）改为建立
 *                      @winvm workspace 软链 node_modules/@winvm/<pkg> → packages/<pkg>
 *                      （junction，免管理员 / 免联网；见 link-workspace.mjs）
 *   2. npm run build   编译所有 packages 到 dist/
 *   3. 生成运行配置     基于 delivery/vm-service.config.json，强制 host=127.0.0.1
 *   4. 共享 Skills      发布仓库 skills/ 到独立共享根，并为各候选 Agent 建 symlink 引用
 *   5. 注册任务计划程序  登录即启、崩溃重启、仅在交互式会话运行（不注册为 Windows 服务）
 *   6. 自检            ps-bridge 模块加载 / 配置校验 / 端口回环绑定
 *
 * 与宿主侧 install-host.mjs 配对：宿主装"控制端插件"，本脚本装"被控端服务"。
 *
 * 用法：
 *   node delivery/install-vm.mjs [--dry-run] [--self-test] [--uninstall]
 *                                [--config <path>] [--port 18443]
 *                                [--provider <id>] [--cli <exe>]
 *                                [--skills-root <dir>] [--skip-skills]
 *                                [--task-name WinVMBridge.Service] [--skip-build]
 *                                [--skip-install] [--skip-links]
 *
 * 卸载（安全：仅删本项目，目录/软链移入回收站，可恢复）：
 *   node delivery/install-vm.mjs --uninstall            # 预览：打印待移除项，不删除
 *   node delivery/install-vm.mjs --uninstall --yes      # 执行：任务移除 + 软链/共享 Skills/生成目录移入回收站
 *   node delivery/install-vm.mjs --uninstall --trash-dir <dir>  # 自定义回收目录（测试/非 Win）
 *   node delivery/install-vm.mjs --uninstall --recycle-bin  # 明确走系统回收站（仅限 VM 内 RDP 交互运行；SSH 下不可见）
 *   node delivery/install-vm.mjs --uninstall --root <repoRoot>  # 指定仓库根（默认脚本所在仓库）
 * 默认回收位置（无 --trash-dir/--recycle-bin）：仓库内可恢复目录 <repoRoot>/.uninstall-trash/<时间戳>/。
 *   ⚠ 经 SSH 执行时系统回收站写入不会反映到 RDP 桌面看到的回收站（非交互会话上下文不同），
 *     故一键卸载默认落到该可恢复目录，RDP 进 VM 后即可找回/恢复；如需系统回收站请在 VM 内交互运行并加 --recycle-bin。
 * 卸载会移除：① 任务计划程序任务；② node_modules/@winvm/* 中仅指向 packages/<pkg> 的 junction；
 *           ③ 各候选 Agent 技能目录中指向共享根的 junction；④ 共享 Skills 根；⑤ delivery/.generated。
 * 源码与已编译 dist 始终保留。
 *
 * provider / cli 取值来源优先级：显式 --provider/--cli 参数 > 环境变量
 *   WINVM_VM_PROVIDER > 配置文件 agent.provider；CLI 运行时按 provider 取：
 *   workbuddy→WINVM_WORKBUDDY_CLI（默认 codebuddy）/ hermes-agent→WINVM_HERMES_CLI（默认 hermes）。
 * 可用 provider：workbuddy-deterministic（确定性）/ workbuddy（codebuddy LLM）/ hermes-agent（Hermes Agent LLM）。
 *
 * 共享 Skills 根取值优先级：--skills-root > 环境变量 WINVM_SKILLS_ROOT >
 *   所选 provider 的 options.skillsRoot > C:/WinVMBridge/shared-skills。
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
  readlinkSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deploySharedSkills,
  resolveAgentSkillDirs,
  DEFAULT_SHARED_SKILLS_ROOT,
} from './deploy-shared-skills.mjs';
import { ensureWorkspaceLinks } from './link-workspace.mjs';
import { deployWinvmPlugin } from './deploy-winvm-plugin.mjs';

/* ------------------------------ 参数 ------------------------------ */

function parseArgs(argv) {
  const out = {
    dryRun: false,
    selfTest: false,
    uninstall: false,
    yes: false,
    trashDir: undefined,
    recycleBin: false,
    root: undefined,
    skipBuild: false,
    skipInstall: false,
    skipLinks: false,
    skipSkills: false,
    config: undefined,
    port: 18443,
    taskName: 'WinVMBridge.Service',
    provider: undefined,
    cli: undefined,
    skillsRoot: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--dry-run': out.dryRun = true; break;
      case '--self-test': out.selfTest = true; break;
      case '--uninstall': out.uninstall = true; break;
      case '--yes': out.yes = true; break;
      case '--trash-dir': out.trashDir = argv[++i]; break;
      case '--recycle-bin': out.recycleBin = true; break;
      case '--root': out.root = argv[++i]; break;
      case '--skip-build': out.skipBuild = true; break;
      case '--skip-install': out.skipInstall = true; break;
      case '--skip-links': out.skipLinks = true; break;
      case '--skip-skills': out.skipSkills = true; break;
      case '--config': out.config = argv[++i]; break;
      case '--port': out.port = Number(argv[++i]); break;
      case '--provider': out.provider = argv[++i]; break;
      case '--cli': out.cli = argv[++i]; break;
      case '--skills-root': out.skillsRoot = argv[++i]; break;
      case '--task-name': out.taskName = argv[++i]; break;
      default: break;
    }
  }
  return out;
}

/* ------------------------------ 路径 ------------------------------ */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
let repoRoot = resolve(join(__dirname, '..'));
let deliveryDir = join(repoRoot, 'delivery');
let defaultConfig = join(deliveryDir, 'vm-service.config.json');
let genDir = join(deliveryDir, '.generated');
const runtimeConfig = join(genDir, 'vm-service.runtime.json');
let taskXmlPath = join(genDir, 'task.xml');
let cliEntry = join(repoRoot, 'packages', 'vm-service', 'dist', 'cli.js');

/* ------------------------------ 工具 ------------------------------ */

function run(cmd, args, opts = {}) {
  if (opts.dry) {
    console.log(`    (dry) $ ${cmd} ${args.join(' ')}`);
    return { status: 0, dry: true };
  }
  const res = spawnSync(cmd, args, { stdio: 'inherit', shell: true, ...opts });
  return { status: res.status ?? (res.error ? 1 : 0), dry: false };
}

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function writeJson(p, obj) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function taskExists(name) {
  const r = spawnSync('schtasks', ['/Query', '/TN', name], { stdio: 'ignore', shell: true });
  return r.status === 0;
}

/**
 * 停止服务并释放端口，确保后续 `schtasks /run` 能真正拉起新实例（而非被
 * 任务 XML 的 MultipleInstancesPolicy=IgnoreNew 拦截，或端口被旧实例占用 EADDRINUSE）。
 * 用于：① 卸载时先停掉运行中的服务（消除残留的 node 控制台窗口）；
 *      ② 部署重新注册任务前，清掉仍占用端口的旧实例。
 * 步骤：先 `schtasks /end` 让调度器标记任务结束 → 强杀仍占用端口的进程释放端口。
 */
function killServiceProcess(port, taskName, dryRun, log) {
  if (dryRun) { log(`停止服务   : ${taskName}（端口 ${port}）[dry-run 不杀进程]`); return; }
  // 1) 让调度器把任务标记为结束（新 run 才不会被 IgnoreNew 拦）
  spawnSync('schtasks', ['/End', '/TN', taskName], { stdio: 'ignore', shell: true });
  // 2) 兜底强杀仍占用端口的进程，确保端口释放
  const script =
    `$p=(Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue).OwningProcess ` +
    `| Select-Object -Unique; if($p){Stop-Process -Id $p -Force -ErrorAction SilentlyContinue}`;
  spawnSync('powershell', ['-NoProfile', '-Command', script], { stdio: 'ignore' });
  log(`停止服务   : 已结束 ${taskName} 并释放端口 ${port}`);
}

/**
 * 生成「隐藏窗口启动器 .ps1」+ UTF-16LE（带 BOM）任务计划 XML，供 schtasks /XML 消费。
 *
 * 为什么必须由 .ps1 启动器间接拉起 node（隐藏控制台窗口）：
 *   GUI 能力域要求服务跑在**交互式会话**（InteractiveToken，Session >= 1），否则截图全黑、
 *   SendInput 拒绝访问。而 InteractiveToken 任务下 Windows 会**忽略** <Hidden>true</Hidden>，
 *   直接把 node.exe 作为任务动作会弹出常驻控制台窗口 —— 用户看得见、易误关（一关服务即停）。
 *   因此隐藏必须在**进程创建层**完成：由 powershell 经 Start-Process -WindowStyle Hidden 拉起 node。
 *   · -WindowStyle Hidden：powershell 自身与 node 均不显示窗口；
 *   · -Wait：服务存活期间任务保持 Running，保留原有语义（schtasks /End 可终止，
 *     node 崩溃时触发 RestartOnFailure）；
 *   · 用 -File 而非 -Command：node 参数含带双引号的路径，-Command 需再嵌一层命令行引号，
 *     转义极易出错；-File 只剩一层引号，node 参数原样写入 .ps1 由 Node 直接落盘。
 */
function buildTaskXml(taskName, nodeExe, cli, port, cfg, outDir) {
  // outDir 供单测隔离；不传时沿用模块级 taskXmlPath（保持既有行为不变）
  const out = outDir ?? dirname(taskXmlPath);
  const xmlPath = outDir ? join(out, 'task.xml') : taskXmlPath;
  const workDir = dirname(cli);
  const cliArg = `"${cli}" --host 127.0.0.1 --port ${port} --config "${cfg}"`;
  // PowerShell 单引号字符串内：单引号重复两次转义，双引号可直接保留
  const psStr = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const ps1Path = join(out, 'start-hidden.ps1');
  const ps1 = [
    '# WinVM Bridge VM Service —— 隐藏窗口启动器（由 install-vm.mjs 生成，请勿手改）',
    '$nodeExe = ' + psStr(nodeExe),
    '$cliArgs = ' + psStr(cliArg),
    '$workDir = ' + psStr(workDir),
    'Start-Process -WindowStyle Hidden -FilePath $nodeExe -ArgumentList $cliArgs -WorkingDirectory $workDir -Wait',
    '',
  ].join('\r\n');
  mkdirSync(out, { recursive: true });
  writeFileSync(ps1Path, ps1, 'utf8');

  const xml =
`<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>WinVM Bridge VM Service - 在交互式会话内自动启动双协议服务端</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>powershell.exe</Command>
      <Arguments>-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${ps1Path}"</Arguments>
      <WorkingDirectory>${workDir}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>`;
  mkdirSync(out, { recursive: true });
  // schtasks /XML 要求 UTF-16LE + BOM
  writeFileSync(xmlPath, '﻿' + xml, 'utf16le');
}

/* ------------------------------ 步骤 ------------------------------ */

function planSteps(args, cfgPath) {
  const steps = [];
  steps.push(`校验配置: ${cfgPath}`);
  steps.push(
    args.skipInstall
      ? `依赖解析：建立 @winvm workspace 软链（node_modules/@winvm/<pkg> → packages/<pkg>，dist 已分发故无需 npm ci）${args.skipLinks ? '  [跳过 --skip-links]' : ''}`
      : '依赖解析：npm ci（按 lockfile 精确还原依赖）+ 确保 @winvm workspace 软链',
  );
  if (!args.skipBuild) steps.push('npm run build （编译所有 packages → dist/）');
  steps.push(`生成运行配置: ${runtimeConfig}（强制 host=127.0.0.1, port=${args.port}）`);
  steps.push(`部署共享 Skills: 仓库 skills/ → 共享根（${args.skillsRoot || 'C:/WinVMBridge/shared-skills'}），并为各候选 Agent 建 symlink 引用${args.skipSkills ? '  [跳过 --skip-skills]' : ''}`);
  steps.push(`注册任务计划程序任务: ${args.taskName}（登录即启 / 崩溃重启 / 仅交互式会话 / 隐藏窗口，避免误关）`);
  steps.push(`自检: node ${cliEntry} --self-test`);
  return steps;
}

/* ------------------------------ 安全卸载辅助 ------------------------------
 * 设计原则（满足"删除目录/软链入回收站、可恢复；仅删本项目"）：
 *  - 任务计划程序任务是系统对象，直接 schtasks /Delete；
 *  - 其余本项目产物（@winvm 软链、共享 Skills 根与 Agent 链接、生成目录）一律移入回收站；
 *  - --dry-run 仅预览；否则 --yes 才执行；无 --yes 只打印计划。
 * 所有"反向"操作只针对本项目创建的 junction：指向 packages/<pkg> 的 @winvm 软链，
 * 以及指向共享根的 Agent 技能链接；其余一律跳过，不碰其它。 */

function ts() { return new Date().toISOString().replace(/[:.]/g, '-'); }

function norm(p) { return String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(); }

function trashItem(target, { dryRun, trashDir, useRecycleBin, log }) {
  if (!existsSync(target)) { log(`  （跳过，不存在）${target}`); return; }
  if (dryRun) { log(`  (dry) 回收站← ${target}`); return; }
  try {
    // 显式回收目录：最可靠，SSH 与交互式会话均可正常落盘
    if (trashDir) {
      const name = target.replace(/[/\\]$/, '').split(/[/\\]/).pop() || 'item';
      const dest = join(trashDir, `${name}.${ts()}`);
      mkdirSync(trashDir, { recursive: true });
      renameSync(target, dest);
      log(`  回收站← ${target}\n        → ${dest}`);
      return;
    }
    // 交互式会话内（如直接在 VM 里 RDP 运行）可显式走系统回收站
    if (useRecycleBin) {
      const e = target.replace(/'/g, "''");
      const script = `$e='${e}'; if(Test-Path $e){$s=New-Object -ComObject Shell.Application; $s.NameSpace(10).MoveHere($e,16)}`;
      const r = spawnSync('powershell', ['-NoProfile', '-Command', script], { stdio: 'ignore' });
      if (r.status !== 0) throw new Error(`recycle bin move failed (status ${r.status ?? '?'})`);
      log(`  回收站← ${target}`);
      return;
    }
    // 兜底默认：VM 侧经 SSH 执行时，系统回收站写入不会反映到 RDP 桌面看到的回收站
    // （非交互会话的回收站上下文与交互桌面不同），故统一落到仓库内可恢复目录，
    // RDP 进 VM 后可在 C:/WinVMBridge/.uninstall-trash/<时间戳>/ 找回/恢复。
    const base = join(repoRoot, '.uninstall-trash', ts());
    const name = target.replace(/[/\\]$/, '').split(/[/\\]/).pop() || 'item';
    const dest = join(base, name);
    mkdirSync(base, { recursive: true });
    renameSync(target, dest);
    log(`  回收站← ${target}\n        → ${dest}  （VM 侧可恢复目录：SSH 下系统回收站不可见，故用此）`);
  } catch (e) {
    throw new Error(`无法移入回收站 ${target}：${e.message}（可改用 --trash-dir 指定自定义回收目录）`);
  }
}

/** 反向 link-workspace.mjs：移除仅指向 packages/<pkg> 的 @winvm junction。 */
function uninstallWorkspaceLinks(dryRun, trashDir, useRecycleBin, yes, log) {
  const nmWinvm = join(repoRoot, 'node_modules', '@winvm');
  if (!existsSync(nmWinvm)) { log('workspace 软链 : node_modules/@winvm 不存在（无需改动）'); return; }
  const entries = readdirSync(nmWinvm, { withFileTypes: true });
  let removed = 0;
  for (const e of entries) {
    const full = join(nmWinvm, e.name);
    let isLink = false; let target = null;
    try { target = resolve(nmWinvm, readlinkSync(full)); isLink = true; } catch {}
    if (!isLink) { log(`  （跳过，非链接）${full}`); continue; }
    const expected = join(repoRoot, 'packages', e.name);
    if (norm(resolve(target)) !== norm(expected)) { log(`  （跳过，指向其它位置）${full} → ${target}`); continue; }
    if (!yes) { log(`workspace 软链 : ${full} → ${target}\n        [待回收站←（--yes 执行）]`); continue; }
    trashItem(full, { dryRun, trashDir, useRecycleBin, log });
    removed++;
  }
  if (yes && existsSync(nmWinvm)) {
    try { if (readdirSync(nmWinvm).length === 0) trashItem(nmWinvm, { dryRun, trashDir, useRecycleBin, log }); } catch {}
  }
  if (removed === 0 && !yes) log('workspace 软链 : 无待移除的本项目 junction');
}

/** 反向 deploy-shared-skills.mjs：移除 Agent 技能目录中指向共享根的 junction，及共享根本身。 */
async function uninstallSharedSkills(skillsRoot, dryRun, trashDir, useRecycleBin, yes, log) {
  for (const a of resolveAgentSkillDirs(process.env)) {
    if (!a.dir || !existsSync(a.dir)) continue;
    const entries = readdirSync(a.dir, { withFileTypes: true });
    for (const e of entries) {
      const full = join(a.dir, e.name);
      let isLink = false; let target = null;
      try { target = resolve(a.dir, readlinkSync(full)); isLink = true; } catch {}
      if (!isLink) continue;
      if (norm(resolve(target)) !== norm(join(skillsRoot, e.name))) continue;
      if (!yes) { log(`共享技能链接: ${full} → ${target}\n        [待回收站←（--yes 执行）]`); continue; }
      trashItem(full, { dryRun, trashDir, useRecycleBin, log });
    }
  }
  if (!existsSync(skillsRoot)) { log('共享 Skills 根 : 不存在（无需改动）'); return; }
  if (!yes) { log(`共享 Skills 根 : ${skillsRoot}\n        [待回收站←（--yes 执行）]`); return; }
  trashItem(skillsRoot, { dryRun, trashDir, useRecycleBin, log });
}

/* ------------------------------ 共享 Skills 部署 ------------------------------ */

/**
 * 第 4 步：把仓库 skills/ 发布到独立共享根（单一事实源），
 * 并为各候选 VM AI Agent 的 skills 目录建立 junction 引用（不复制、不覆盖用户技能）。
 *
 * skillsRoot 取值优先级：--skills-root > WINVM_SKILLS_ROOT >
 *   所选 provider 的 options.skillsRoot > C:/WinVMBridge/shared-skills。
 */
async function deploySkillsStep(args, cfg, provider) {
  const skillsRoot =
    args.skillsRoot ??
    process.env['WINVM_SKILLS_ROOT'] ??
    cfg?.agent?.providers?.[provider]?.options?.skillsRoot ??
    DEFAULT_SHARED_SKILLS_ROOT;
  const repoSkillsDir = join(repoRoot, 'skills');
  const { publish, skills, plan, results } = await deploySharedSkills({
    sourceDir: skillsRoot,
    publishFrom: repoSkillsDir,
    dryRun: args.dryRun,
    log: (m) => console.log(`       ${m}`),
  });
  if (publish?.plan) {
    console.log(
      `      发布：新增 ${publish.plan.summary.add} / 刷新 ${publish.plan.summary.refresh} / 共享根独有保留 ${publish.plan.summary.keepExtra}`,
    );
  } else {
    console.log(`      发布：仓库 skills 源为空或不存在（${repoSkillsDir}），跳过`);
  }
  console.log(
    `      链接：技能 ${skills.length} 个 → 新建 ${plan?.summary.create ?? 0} / 已就位 ${plan?.summary.skipOk ?? 0} / 冲突跳过 ${plan?.summary.conflict ?? 0} / Agent 缺失 ${plan?.summary.skipAgent ?? 0}`,
  );
  void results;
}

/* ------------------------------ 主流程 ------------------------------ */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // 允许 --root 覆盖仓库根（主要用于隔离测试，避免触碰真实仓库）
  repoRoot = resolve(args.root ?? join(__dirname, '..'));
  deliveryDir = join(repoRoot, 'delivery');
  defaultConfig = join(deliveryDir, 'vm-service.config.json');
  genDir = join(deliveryDir, '.generated');
  taskXmlPath = join(genDir, 'task.xml');
  cliEntry = join(repoRoot, 'packages', 'vm-service', 'dist', 'cli.js');
  const cfgPath = args.config ?? defaultConfig;

  if (!existsSync(cfgPath)) {
    console.error(`找不到 VM 服务配置：${cfgPath}`);
    process.exit(1);
  }

  console.log('=== WinVM Bridge · 虚拟机侧一键部署 ===');
  console.log(`仓库根目录 : ${repoRoot}`);
  console.log(`配置文件   : ${cfgPath}`);
  console.log(`端口       : ${args.port}（仅 127.0.0.1）`);
  console.log(`任务名     : ${args.taskName}`);
  console.log(`模式       : ${args.dryRun ? 'dry-run（不写盘/不执行）' : (args.selfTest ? '仅自检' : '实际部署')}`);

  /* ----- 解析 VM 侧 AI Agent 选型（agent.provider） ----- */
  const cfg = readJson(cfgPath);
  const provider =
    args.provider ??
    process.env['WINVM_VM_PROVIDER'] ??
    cfg?.agent?.provider ??
    'workbuddy-deterministic';
  // CLI 运行时按所选 LLM provider 解析：workbuddy→WINVM_WORKBUDDY_CLI(默认 codebuddy) / hermes-agent→WINVM_HERMES_CLI(默认 hermes)
  const isLlmProvider = provider === 'workbuddy' || provider === 'hermes-agent';
  const cliEnvVar = provider === 'hermes-agent' ? 'WINVM_HERMES_CLI' : 'WINVM_WORKBUDDY_CLI';
  const cliDefault = provider === 'hermes-agent' ? 'hermes' : 'codebuddy';
  const cli = args.cli ?? process.env[cliEnvVar] ?? cliDefault;
  if (!cfg?.agent?.providers?.[provider]) {
    console.error(
      `agent.provider="${provider}" 未在配置 providers 中定义。可用：${Object.keys(cfg?.agent?.providers ?? {}).join(', ') || '(空)'}`,
    );
    process.exit(1);
  }
  console.log(`VM Agent   : agent.provider=${provider}${isLlmProvider ? `（LLM 运行时=${cli}）` : ''}`);
  console.log('');

  /* ----- 卸载（安全：仅删本项目，目录/软链移入回收站） ----- */
  if (args.uninstall) {
    const skillsRoot =
      args.skillsRoot ??
      process.env['WINVM_SKILLS_ROOT'] ??
      cfg?.agent?.providers?.[provider]?.options?.skillsRoot ??
      DEFAULT_SHARED_SKILLS_ROOT;
    const log = (m) => console.log(m);
    // 解析回收站目标：--trash-dir > --recycle-bin(交互式系统回收站) > 默认 VM 内可恢复目录
    const trashDir = args.trashDir
      ? args.trashDir
      : (args.recycleBin ? null : join(repoRoot, '.uninstall-trash', ts()));
    const useRecycleBin = !!args.recycleBin && !args.trashDir;
    console.log('=== WinVM Bridge · 虚拟机侧一键卸载（安全：目录/软链移入回收站） ===');
    console.log(`仓库根目录 : ${repoRoot}`);
    console.log(`共享根     : ${skillsRoot}`);
    console.log(`模式       : ${args.dryRun ? 'dry-run（仅预览，不删除）' : (args.yes ? '执行（已确认 --yes）' : '预览（加 --yes 才执行）')}`);
    if (args.trashDir) console.log(`回收目录   : ${args.trashDir}`);
    else if (!args.dryRun && args.yes && !args.recycleBin) console.log(`回收目录   : ${trashDir}（VM 内可恢复目录：SSH 下系统回收站不可见，故用此）`);
    console.log('');

    // 1. 任务计划程序任务（系统对象，直接删除）
    if (taskExists(args.taskName)) {
      if (args.dryRun) { log(`任务计划   : ${args.taskName}  [dry-run 将移除]`); }
      else if (args.yes) {
        // 先停掉运行中的服务（释放端口、消除残留的 node 控制台窗口），再删任务
        killServiceProcess(args.port, args.taskName, false, log);
        const r = run('schtasks', ['/Delete', '/TN', args.taskName, '/F']);
        if (r.status !== 0) { console.error('移除任务失败'); process.exit(1); }
        log(`任务计划   : 已移除 ${args.taskName}`);
      } else { log(`任务计划   : ${args.taskName}  [加 --yes 将移除]`); }
    } else {
      log(`任务计划   : ${args.taskName} 不存在，跳过`);
    }

    // 2. @winvm workspace 软链（junction）
    console.log('');
    uninstallWorkspaceLinks(args.dryRun, trashDir, useRecycleBin, args.yes, log);

    // 3. 共享 Skills（Agent 链接 + 共享根）
    console.log('');
    await uninstallSharedSkills(skillsRoot, args.dryRun, trashDir, useRecycleBin, args.yes, log);

    // 4. 生成目录
    console.log('');
    if (existsSync(genDir)) {
      if (!args.dryRun && args.yes) trashItem(genDir, { dryRun: args.dryRun, trashDir, useRecycleBin, log });
      else log(`生成目录   : ${genDir}\n        [待回收站←（--yes 执行）]`);
    } else {
      log(`生成目录   : ${genDir}  （不存在，跳过）`);
    }

    console.log('');
    if (args.dryRun) {
      console.log('dry-run 完成：未做任何改动。去掉 --dry-run 并加 --yes 以执行卸载。');
    } else if (!args.yes) {
      console.log('预览完成。确认无误后重新执行并加 --yes 以执行卸载（目录/软链移入回收站，可恢复，源码与 dist 保留）。');
    } else {
      console.log('卸载完成：任务已停止并移除、软链与共享 Skills 已移入可恢复目录，源码与已编译 dist 保留。');
      if (args.trashDir) {
        console.log(`回收目录   : ${args.trashDir}（自定义回收目录）`);
      } else if (args.recycleBin) {
        console.log('回收位置   : 系统回收站（--recycle-bin，仅限 VM 内 RDP 交互运行才可见）');
      } else {
        console.log(`⚠ 可恢复目录 : ${join(repoRoot, '.uninstall-trash')}/<时间戳>/`);
        console.log('   （VM 侧经 SSH 卸载时，系统回收站写入不会反映到 RDP 桌面看到的回收站；');
        console.log('     故删除物默认落到上述 VM 内可恢复目录，而非 Windows 回收站。RDP 进 VM 即可找回/恢复。）');
      }
    }
    return;
  }

  /* ----- 校验配置 ----- */
  const bindHost = cfg?.server?.host ?? cfg?.host;
  if (bindHost && bindHost !== '127.0.0.1' && !args.dryRun) {
    console.error(`安全红线：VM 服务必须仅监听 127.0.0.1，当前为 "${bindHost}"。已中止。`);
    process.exit(1);
  }
  if (args.dryRun) console.log(`  [校验] 配置 host=${(cfg?.server?.host ?? cfg?.host ?? '(未声明)')} ok`);

  /* ----- 仅自检 ----- */
  if (args.selfTest) {
    if (!existsSync(cliEntry)) {
      console.error(`未找到编译产物 ${cliEntry}，请先部署（或去掉 --self-test）。`);
      process.exit(1);
    }
    console.log('运行自检...');
    const r = run('node', [cliEntry, '--self-test'], {});
    process.exit(r.status === 0 ? 0 : 1);
  }

  /* ----- 打印计划 ----- */
  console.log('将执行以下步骤：');
  for (const s of planSteps(args, cfgPath)) console.log(`  → ${s}`);
  console.log('');

  if (args.dryRun) {
    console.log('dry-run 完成，未做任何改动。去掉 --dry-run 以正式部署。');
    return;
  }

  /* 1. 依赖解析：npm ci（全量安装）或 workspace 软链（产物已分发场景） */
  console.log('[1/6] 依赖解析 ...');
  let r;
  if (args.skipInstall) {
    console.log('      npm ci：跳过（--skip-install，dist 已由宿主机构建并分发）');
  } else {
    console.log('      npm ci ...');
    r = run('npm', ['ci', '--registry=https://registry.npmmirror.com'], { stdio: 'inherit' });
    if (r.status !== 0) { console.error('npm ci 失败'); process.exit(1); }
  }

  /*
   * dist 中 import 的是裸包名（from '@winvm/core'），ESM 不重写说明符，必须经 node_modules 解析。
   * 产物分发场景没有 node_modules，这里建 junction 软链补上 ——
   * 各包依赖全为内部 @winvm/*、零外部 npm 依赖，故无需 npm ci、无需联网。
   * 详见 delivery/link-workspace.mjs 头部说明。
   */
  if (args.skipLinks) {
    console.log('      @winvm workspace 软链：跳过（--skip-links）');
  } else {
    const linkRes = await ensureWorkspaceLinks({
      repoRoot,
      dryRun: args.dryRun,
      log: (m) => console.log(`      ${m}`),
    });
    if (linkRes.plan) {
      console.log(
        `      @winvm workspace 软链：包 ${linkRes.packages.length} 个 → 新建 ${linkRes.plan.summary.create} / 已就位 ${linkRes.plan.summary.skipOk} / 冲突跳过 ${linkRes.plan.summary.conflict}`,
      );
      const broken = linkRes.results.filter((x) => x.error);
      if (broken.length && !args.dryRun) {
        console.error(
          `      软链创建失败，服务将无法解析 @winvm/*：${broken.map((b) => `@winvm/${b.name}（${b.error}）`).join('; ')}`,
        );
        process.exit(1);
      }
    }
  }

  /* 2. build */
  if (!args.skipBuild) {
    console.log('[2/5] npm run build ...');
    r = run('npm', ['run', 'build'], { stdio: 'inherit' });
    if (r.status !== 0) { console.error('构建失败'); process.exit(1); }
  } else {
    console.log('[2/5] 跳过构建（--skip-build）');
  }

  /* 3. 生成运行配置（强制回环 + 应用 provider 选型） */
  console.log('[3/6] 生成运行配置 ...');
  const runtime = readJson(cfgPath);
  if (!runtime.server) runtime.server = {};
  runtime.server.host = '127.0.0.1';
  runtime.server.port = args.port;
  runtime.agent = runtime.agent ?? {};
  runtime.agent.provider = provider;
  // 把 CLI 运行时注入所选 LLM provider 的 options（workbuddy / hermes-agent 通用）
  if (isLlmProvider && runtime.agent.providers?.[provider]) {
    runtime.agent.providers[provider] = {
      ...runtime.agent.providers[provider],
      options: { ...runtime.agent.providers[provider].options, cliPath: cli },
    };
  }
  writeJson(runtimeConfig, runtime);
  console.log(`      已写入 ${runtimeConfig}（provider=${provider}）`);

  /* 4. 共享 Skills 部署（发布仓库 skills/ → 共享根，并为各候选 Agent 建 symlink） */
  console.log('[4/6] 部署共享 Skills ...');
  if (args.skipSkills) {
    console.log('      跳过（--skip-skills）');
  } else {
    await deploySkillsStep(args, cfg, provider);
  }

  /* 5. 注册任务计划程序 */
  console.log('[5/6] 注册任务计划程序任务 ...');
  if (taskExists(args.taskName)) {
    console.log(`      任务 ${args.taskName} 已存在，先停止旧实例并移除再重建`);
    run('schtasks', ['/Delete', '/TN', args.taskName, '/F']);
  }
  // 清掉仍占用端口的旧实例（如上一版 Hidden=false 的残留窗口），确保新 Hidden=true 实例能绑定
  killServiceProcess(args.port, args.taskName, args.dryRun, (m) => console.log(`      ${m}`));
  const nodeExe = process.execPath;
  buildTaskXml(args.taskName, nodeExe, cliEntry, args.port, runtimeConfig);
  r = run('schtasks', ['/Create', '/TN', args.taskName, '/XML', taskXmlPath, '/F']);
  if (r.status !== 0) { console.error('注册任务计划程序失败（需以管理员身份运行）'); process.exit(1); }
  console.log(`      已注册任务 ${args.taskName}（登录即启 / 崩溃重启 ×3 / 交互式会话 / 无控制台窗口）`);
  console.log(`      隐藏启动器：${join(genDir, 'start-hidden.ps1')}（任务经它以 -WindowStyle Hidden 拉起 node）`);

  /* 6. 自检 */
  console.log('[6/6] 自检 ...');
  r = run('node', [cliEntry, '--self-test'], {});
  if (r.status !== 0) { console.error('自检失败，请检查上方输出'); process.exit(1); }

  console.log('');
  console.log('=== 部署完成 ===');
  console.log('vm-service 将以任务计划程序任务在交互式会话登录时自动启动。');
  console.log(`手动启动（前台）：node ${cliEntry} --host 127.0.0.1 --port ${args.port} --config ${runtimeConfig}`);
  console.log('宿主侧建立 SSH 隧道后即可从 WorkBuddy 调用（见 DEPLOYMENT.md §4.2）。');

  /* 7. 部署插件管理 CLI winvm-plugin（VM 侧）—— 与 host 侧同源，自动识别 side=vm */
  if (!args.dryRun) {
    deployWinvmPlugin({ targetDir: deliveryDir, side: 'vm', dryRun: false, log: (m) => console.log(`管理命令     : ${m}`) });
  }
}

/* 仅当本文件被直接作为入口运行时才执行 main；被 import（如单测）时保持惰性，
 * 避免导入即触发真实的 npm ci / build / schtasks 注册。 */
if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  main().catch((e) => {
    console.error(e && e.stack ? e.stack : e);
    process.exit(1);
  });
}

// 导出供单测校验生成的任务 XML 与隐藏启动器（多层引号转义极易回归，必须锁住）
export { buildTaskXml };

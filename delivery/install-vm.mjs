#!/usr/bin/env node
/**
 * WinVM Bridge —— 虚拟机侧（被控端）一键部署脚本
 *
 * 在 Windows VM 内运行，把仓库部署为常驻的 vm-service（双协议服务端）：
 *   1. npm ci          按 lockfile 精确还原依赖（可复现）
 *   2. npm run build   编译所有 packages 到 dist/
 *   3. 生成运行配置     基于 delivery/vm-service.config.json，强制 host=127.0.0.1
 *   4. 注册任务计划程序  登录即启、崩溃重启、仅在交互式会话运行（不注册为 Windows 服务）
 *   5. 自检            ps-bridge 模块加载 / 配置校验 / 端口回环绑定
 *
 * 与宿主侧 install-host.mjs 配对：宿主装"控制端插件"，本脚本装"被控端服务"。
 *
 * 用法：
 *   node delivery/install-vm.mjs [--dry-run] [--self-test] [--uninstall]
 *                                [--config <path>] [--port 18443]
 *                                [--provider <id>] [--cli <exe>]
 *                                [--task-name WinVMBridge.Service] [--skip-build]
 *
 * provider / cli 取值来源优先级：显式 --provider/--cli 参数 > 环境变量
 *   WINVM_VM_PROVIDER / WINVM_WORKBUDDY_CLI > 配置文件 agent.provider。
 * 选 workbuddy 即启用 LLM Agent（VM 内 codebuddy CLI 承接开放/创意任务）。
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ------------------------------ 参数 ------------------------------ */

function parseArgs(argv) {
  const out = {
    dryRun: false,
    selfTest: false,
    uninstall: false,
    skipBuild: false,
    skipInstall: false,
    config: undefined,
    port: 18443,
    taskName: 'WinVMBridge.Service',
    provider: undefined,
    cli: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--dry-run': out.dryRun = true; break;
      case '--self-test': out.selfTest = true; break;
      case '--uninstall': out.uninstall = true; break;
      case '--skip-build': out.skipBuild = true; break;
      case '--skip-install': out.skipInstall = true; break;
      case '--config': out.config = argv[++i]; break;
      case '--port': out.port = Number(argv[++i]); break;
      case '--provider': out.provider = argv[++i]; break;
      case '--cli': out.cli = argv[++i]; break;
      case '--task-name': out.taskName = argv[++i]; break;
      default: break;
    }
  }
  return out;
}

/* ------------------------------ 路径 ------------------------------ */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(join(__dirname, '..'));
const deliveryDir = join(repoRoot, 'delivery');
const defaultConfig = join(deliveryDir, 'vm-service.config.json');
const genDir = join(deliveryDir, '.generated');
const runtimeConfig = join(genDir, 'vm-service.runtime.json');
const taskXmlPath = join(genDir, 'task.xml');
const cliEntry = join(repoRoot, 'packages', 'vm-service', 'dist', 'cli.js');

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

/** 生成 UTF-16LE（带 BOM）任务计划 XML，供 schtasks /XML 消费 */
function buildTaskXml(taskName, nodeExe, cli, port, cfg) {
  const workDir = dirname(cli);
  const cliArg = `"${cli}" --host 127.0.0.1 --port ${port} --config "${cfg}"`;
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
    <Hidden>false</Hidden>
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
      <Command>${nodeExe}</Command>
      <Arguments>${cliArg}</Arguments>
      <WorkingDirectory>${workDir}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>`;
  mkdirSync(dirname(taskXmlPath), { recursive: true });
  // schtasks /XML 要求 UTF-16LE + BOM
  writeFileSync(taskXmlPath, '﻿' + xml, 'utf16le');
}

/* ------------------------------ 步骤 ------------------------------ */

function planSteps(args, cfgPath) {
  const steps = [];
  steps.push(`校验配置: ${cfgPath}`);
  steps.push(`npm ci （按 lockfile 精确还原依赖）${args.skipInstall ? '  [跳过 --skip-install]' : ''}`);
  if (!args.skipBuild) steps.push('npm run build （编译所有 packages → dist/）');
  steps.push(`生成运行配置: ${runtimeConfig}（强制 host=127.0.0.1, port=${args.port}）`);
  steps.push(`注册任务计划程序任务: ${args.taskName}（登录即启 / 崩溃重启 / 仅交互式会话）`);
  steps.push(`自检: node ${cliEntry} --self-test`);
  return steps;
}

/* ------------------------------ 主流程 ------------------------------ */

function main() {
  const args = parseArgs(process.argv.slice(2));
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
  const cli = args.cli ?? process.env['WINVM_WORKBUDDY_CLI'] ?? 'codebuddy';
  if (!cfg?.agent?.providers?.[provider]) {
    console.error(
      `agent.provider="${provider}" 未在配置 providers 中定义。可用：${Object.keys(cfg?.agent?.providers ?? {}).join(', ') || '(空)'}`,
    );
    process.exit(1);
  }
  console.log(`VM Agent   : agent.provider=${provider}${provider === 'workbuddy' ? `（LLM 运行时=${cli}）` : ''}`);
  console.log('');

  /* ----- 卸载 ----- */
  if (args.uninstall) {
    if (taskExists(args.taskName)) {
      console.log(`移除任务计划程序任务: ${args.taskName}`);
      if (!args.dryRun) {
        const r = run('schtasks', ['/Delete', '/TN', args.taskName, '/F']);
        if (r.status !== 0) { console.error('移除任务失败'); process.exit(1); }
      }
    } else {
      console.log(`任务 ${args.taskName} 不存在，跳过`);
    }
    if (existsSync(genDir)) {
      console.log(`清理生成目录: ${genDir}`);
      if (!args.dryRun) rmSync(genDir, { recursive: true, force: true });
    }
    console.log('卸载完成（源码与已编译 dist 保留）。');
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

  /* 1. npm ci（产物已分发时可跳过） */
  let r;
  if (args.skipInstall) {
    console.log('[1/5] 跳过依赖安装（--skip-install：dist 已由宿主机构建并分发）');
  } else {
    console.log('[1/5] npm ci ...');
    r = run('npm', ['ci', '--registry=https://registry.npmmirror.com'], { stdio: 'inherit' });
    if (r.status !== 0) { console.error('npm ci 失败'); process.exit(1); }
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
  console.log('[3/5] 生成运行配置 ...');
  const runtime = readJson(cfgPath);
  if (!runtime.server) runtime.server = {};
  runtime.server.host = '127.0.0.1';
  runtime.server.port = args.port;
  runtime.agent = runtime.agent ?? {};
  runtime.agent.provider = provider;
  if (provider === 'workbuddy' && runtime.agent.providers?.['workbuddy']) {
    runtime.agent.providers['workbuddy'] = {
      ...runtime.agent.providers['workbuddy'],
      options: { ...runtime.agent.providers['workbuddy'].options, cliPath: cli },
    };
  }
  writeJson(runtimeConfig, runtime);
  console.log(`      已写入 ${runtimeConfig}（provider=${provider}）`);

  /* 4. 注册任务计划程序 */
  console.log('[4/5] 注册任务计划程序任务 ...');
  if (taskExists(args.taskName)) {
    console.log(`      任务 ${args.taskName} 已存在，先移除再重建`);
    run('schtasks', ['/Delete', '/TN', args.taskName, '/F']);
  }
  const nodeExe = process.execPath;
  buildTaskXml(args.taskName, nodeExe, cliEntry, args.port, runtimeConfig);
  r = run('schtasks', ['/Create', '/TN', args.taskName, '/XML', taskXmlPath, '/F']);
  if (r.status !== 0) { console.error('注册任务计划程序失败（需以管理员身份运行）'); process.exit(1); }
  console.log(`      已注册任务 ${args.taskName}（登录即启 / 崩溃重启 ×3 / 仅交互式会话）`);

  /* 5. 自检 */
  console.log('[5/5] 自检 ...');
  r = run('node', [cliEntry, '--self-test'], {});
  if (r.status !== 0) { console.error('自检失败，请检查上方输出'); process.exit(1); }

  console.log('');
  console.log('=== 部署完成 ===');
  console.log('vm-service 将以任务计划程序任务在交互式会话登录时自动启动。');
  console.log(`手动启动（前台）：node ${cliEntry} --host 127.0.0.1 --port ${args.port} --config ${runtimeConfig}`);
  console.log('宿主侧建立 SSH 隧道后即可从 WorkBuddy 调用（见 DEPLOYMENT.md §4.2）。');
}

main();

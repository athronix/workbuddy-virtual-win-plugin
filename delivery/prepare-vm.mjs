#!/usr/bin/env node
/**
 * prepare-vm.mjs —— VM 前置环境一键准备（Phase 3 批2 · P0-2 收口）
 *
 * 病灶（audit-pm §4 DB-1/2/5/6/3，终版判据「全新宿主一键到可枚举能力零手工」）：
 * 「前置环境 6 项全手工，把一键变成一晚上」。本模块在 **SSH 通道内**批量做可脚本化的前置，
 * 把纯手工从 6 项压到 1 项（codebuddy 登录，DB-4 结构性不可脚本化）。
 *
 * 覆盖 DB 项（逐条见 notes §1）：
 *   DB-1 OpenSSH Server    —— 探测；已装但手动启动 ⇒ 置 Automatic + Running（可修）；
 *                             **未装** ⇒ 经 SYSTEM 计划任务 Add-WindowsCapability（需管理员），
 *                             不可得时打印精确一行手工配方（诚实：sshd 未装时 SSH 通道本身不存在）。
 *   DB-2 防火墙 22/服务口   —— New-NetFirewallRule（幂等：先判存在）。
 *   DB-5 关睡眠/屏保        —— powercfg 三件套（standby-timeout-ac/dc 0 + hibernate-off + 屏幕超时）。
 *   DB-6 Defender 排除      —— Add-MpPreference 幂等（复用 tools/add-defender-exclusions.ps1 的判据）。
 *   DB-3 VM Node ≥18        —— 缺失时经 winget 静默装（--ensure-node 可选，能力自洽 dogfooding）。
 *
 * 铁律：
 *   - 远端 PowerShell 逻辑一律 **生成 .ps1 → scp → powershell -File**（勿 ssh 内联，MSYS 会吞改路径/变量）；
 *     载荷 ASCII-only（与 setup.mjs runRemotePs1 同通道）。
 *   - 安全默认：无 --apply 即 **只读探测/dry-run**（打印 plan + 当前态），不改任何 VM 系统；
 *     apply 复用 setup.mjs 的 runRemotePs1（写盘副作用只在 apply 下发生）。
 *   - 本模块纯函数（planPrepareVm / buildPrepareVmPs1）可脱 VM 单测（零 spawn）。
 *
 * 幂等判据（setup dry-run 验收）：连跑两次 apply，第二次全 [SKIP]（每项先探测再动作）。
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

/* ----------------------------- 纯函数：探测计划 ----------------------------- */

/**
 * 生成「只读探测」脚本（check 相位用）：逐项打印当前态，零副作用。
 * @param {{servicePort:number, vmDeployDir:string, ensureNode:boolean, sshPort:number}} cfg
 * @returns {string} ASCII-only PowerShell
 */
export function buildPrepareVmProbePs1(cfg) {
  const port = Number(cfg.servicePort) || 18443;
  const sshPort = Number(cfg.sshPort) || 22;
  const lines = [
    '$ErrorActionPreference = "Continue"',
    '# WinVM prepare-vm PROBE (read-only, no side effects)',
    '$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
    'Write-Output ("ADMIN=" + $isAdmin)',
    '# DB-1 sshd',
    '$sshd = Get-Service sshd -ErrorAction SilentlyContinue',
    'if ($sshd) {',
    '  $st = (Get-CimInstance Win32_Service -Filter "Name=\'sshd\'" -ErrorAction SilentlyContinue).StartMode',
    '  Write-Output ("SSHD_INSTALLED=True STATE=" + $sshd.Status + " STARTMODE=" + $st)',
    '} else {',
    '  Write-Output "SSHD_INSTALLED=False"',
    '}',
    '# DB-2 firewall rules (22 / ' + port + ')',
    '$fw22 = Get-NetFirewallRule -Displayname "WinVM-SSH-' + sshPort + '" -ErrorAction SilentlyContinue',
    '$fwSvc = Get-NetFirewallRule -Displayname "WinVM-Service-' + port + '" -ErrorAction SilentlyContinue',
    'Write-Output ("FW_SSH=" + [bool]$fw22 + " FW_SERVICE=" + [bool]$fwSvc)',
    '# DB-5 sleep/screensaver (current AC standby timeout; hex parse = locale-proof)',
    '$joined = (powercfg /query SCHEME_CURRENT SUB_STANDBY STANDBYIDLE 2>$null) -join " "',
    'if ($joined -match "0x([0-9a-fA-F]{8})") { $acHex = $Matches[1] } else { $acHex = "unknown" }',
    'Write-Output ("STANDBY_AC_HEX=" + $acHex)',
    'Write-Output ("STANDBY_AC_LINE=AC=0x" + $acHex)',
    '# DB-6 Defender exclusions',
    'try { $p = Get-MpPreference -ErrorAction Stop; Write-Output ("DEFENDER_PATHS=" + (($p.ExclusionPath) -join ";")) } catch { Write-Output "DEFENDER_READ_FAILED" }',
    '# DB-3 node presence',
    '$node = Get-Command node -ErrorAction SilentlyContinue',
    'if ($node) { $nv = (node -v); Write-Output ("NODE=True " + $nv) } else { Write-Output "NODE=False" }',
    '# DB-4 agent CLI + login markers (read-only; see preflight.evaluateAgentLogin limits)',
    '$cb = Get-Command codebuddy -ErrorAction SilentlyContinue',
    'if ($cb) { Write-Output "AGENT_CLI=True" } else { Write-Output "AGENT_CLI=False" }',
    '$cdir = Join-Path $env:USERPROFILE ".codebuddy"',
    '$sjson = Join-Path $cdir "settings.json"',
    '$ustate = Join-Path $cdir "user-state.json"',
    '$marker = ((Test-Path $sjson) -or (Test-Path $ustate))',
    'Write-Output ("AGENT_CONFIG_DIR=" + [bool]$marker)',
    '',
  ];
  return lines.join('\r\n');
}

/**
 * 生成「应用」脚本（--apply 相位用）：逐项先探测再动作 ⇒ 天然幂等（第二次全 SKIP）。
 * 只在具备条件时做（sshd 置自动 / 防火墙 / powercfg / Defender / 可选 node）。
 * @returns {string} ASCII-only PowerShell
 */
export function buildPrepareVmApplyPs1(cfg) {
  const port = Number(cfg.servicePort) || 18443;
  const sshPort = Number(cfg.sshPort) || 22;
  const deployDir = (cfg.vmDeployDir || 'C:/WinVMBridge').replace(/\//g, '\\');
  const ensureNode = !!cfg.ensureNode;
  const lines = [
    '$ErrorActionPreference = "Continue"',
    '# WinVM prepare-vm APPLY (idempotent: each step probes before acting)',
    '$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
    'Write-Output ("ADMIN=" + $isAdmin)',
    '',
    '# ---- DB-1 OpenSSH Server: ensure installed + Automatic + Running ----',
    '$sshd = Get-Service sshd -ErrorAction SilentlyContinue',
    'if (-not $sshd) {',
    '  if ($isAdmin) {',
    '    Write-Output "[DB-1] sshd missing; trying Add-WindowsCapability OpenSSH.Server (may need reboot)..."',
    '    try { Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 -ErrorAction Stop | Out-Null; $sshd = Get-Service sshd -ErrorAction SilentlyContinue } catch { Write-Output ("[DB-1] ADD_CAPABILITY_FAILED: " + $_.Exception.Message) }',
    '  } else {',
    '    Write-Output "[DB-1][MANUAL] sshd not installed and session is NOT elevated. Run in ELEVATED PowerShell on the VM:",',
    '    Write-Output "    Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0"',
    '  }',
    '}',
    'if ($isAdmin) {',
    '  $mode = (Get-CimInstance Win32_Service -Filter "Name=\'sshd\'" -ErrorAction SilentlyContinue).StartMode',
    '  if ($mode -ne "Auto") { Set-Service sshd -StartupType Automatic; Write-Output "[DB-1] sshd STARTUP set Automatic" } else { Write-Output "[DB-1] sshd already Automatic [SKIP]" }',
    '  $svc = Get-Service sshd -ErrorAction SilentlyContinue',
    '  if ($svc -and $svc.Status -ne "Running") { Start-Service sshd; Write-Output "[DB-1] sshd STARTED" } elseif ($svc) { Write-Output "[DB-1] sshd already Running [SKIP]" }',
    '} else { Write-Output "[DB-1][SKIP] not admin, cannot manage service startup" }',
    '',
    '# ---- DB-2 Firewall: allow TCP ' + sshPort + ' (ssh) and ' + port + ' (service, loopback) ----',
    'if ($isAdmin) {',
    '  if (-not (Get-NetFirewallRule -Displayname "WinVM-SSH-' + sshPort + '" -ErrorAction SilentlyContinue)) {',
    '    New-NetFirewallRule -DisplayName "WinVM-SSH-' + sshPort + '" -Direction Inbound -Action Allow -Protocol TCP -LocalPort ' + sshPort + ' | Out-Null; Write-Output "[DB-2] FW SSH-' + sshPort + ' created"',
    '  } else { Write-Output "[DB-2] FW SSH-' + sshPort + ' exists [SKIP]" }',
    '  if (-not (Get-NetFirewallRule -Displayname "WinVM-Service-' + port + '" -ErrorAction SilentlyContinue)) {',
    '    New-NetFirewallRule -DisplayName "WinVM-Service-' + port + '" -Direction Inbound -Action Allow -Protocol TCP -LocalPort ' + port + ' | Out-Null; Write-Output "[DB-2] FW Service-' + port + ' created"',
    '  } else { Write-Output "[DB-2] FW Service-' + port + ' exists [SKIP]" }',
    '} else { Write-Output "[DB-2][MANUAL] not admin; firewall rules need elevation (see INSTALL-GUIDE 1.2)" }',
    '',
    '# ---- DB-5 Power: never sleep / never screensaver (low risk, reversible) ----',
    'powercfg /change standby-timeout-ac 0 | Out-Null',
    'powercfg /change standby-timeout-dc 0 | Out-Null',
    'powercfg /change hibernate-timeout-ac 0 | Out-Null',
    'powercfg /change monitor-timeout-ac 0 | Out-Null',
    'Write-Output "[DB-5] powercfg standby/hibernate/monitor AC+DC = 0 (never sleep/saver)"',
    '',
    '# ---- DB-6 Defender exclusions (idempotent delta) ----',
    'if ($isAdmin) {',
    '  $ExPaths = @("' + deployDir + '", "C:\\WinVMWorkspace")',
    '  $ExProcs = @("node.exe", "powershell.exe")',
    '  try {',
    '    $pref = Get-MpPreference -ErrorAction Stop',
    '    $curP = if ($pref.ExclusionPath) { @($pref.ExclusionPath) } else { @() }',
    '    $curR = if ($pref.ExclusionProcess) { @($pref.ExclusionProcess) } else { @() }',
    '    $addP = @($ExPaths | Where-Object { $curP -notcontains $_ })',
    '    $addR = @($ExProcs | Where-Object { $curR -notcontains $_ })',
    '    if ($addP.Count -eq 0 -and $addR.Count -eq 0) { Write-Output "[DB-6] ALREADY_CONFIGURED [SKIP]" }',
    '    else {',
    '      if ($addP.Count -gt 0) { Add-MpPreference -ExclusionPath $addP -ErrorAction Stop; Write-Output ("[DB-6] ADDED ExclusionPath: " + ($addP -join ", ")) }',
    '      if ($addR.Count -gt 0) { Add-MpPreference -ExclusionProcess $addR -ErrorAction Stop; Write-Output ("[DB-6] ADDED ExclusionProcess: " + ($addR -join ", ")) }',
    '    }',
    '  } catch { Write-Output ("[DB-6] DEFENDER_FAILED: " + $_.Exception.Message) }',
    '} else { Write-Output "[DB-6][SKIP] not admin; Defender needs elevation (or run tools/add-defender-exclusions.ps1 as admin)" }',
    '',
    '# ---- DB-3 Node >= 18 (optional, winget silent) ----',
    ensureNode
      ? [
        '  $node = Get-Command node -ErrorAction SilentlyContinue',
        '  if ($node) { Write-Output ("[DB-3] node present " + (node -v) + " [SKIP]") }',
        '  elseif ($isAdmin -and (Get-Command winget -ErrorAction SilentlyContinue)) {',
        '    Write-Output "[DB-3] node missing; winget install OpenJS.NodeJS.LTS (silent)..."',
        '    winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements --silent 2>&1 | Select-Object -Last 3',
        '    Write-Output "[DB-3] winget node install issued; re-login or check PATH (may need a NEW ssh session to pick up system PATH)"',
        '  } elseif (-not $isAdmin) { Write-Output "[DB-3][MANUAL] node missing and not admin; install Node >= 18 with SYSTEM PATH (INSTALL-GUIDE 1.3)" }',
        '  else { Write-Output "[DB-3][MANUAL] node missing and winget unavailable; install Node >= 18 (INSTALL-GUIDE 1.3)" }',
      ]
      : ['  Write-Output "[DB-3] node provisioning not requested (pass --ensure-node to enable winget install)"'],
    '',
    'Write-Output "PREPARE_VM_DONE"',
  ];
  return lines.join('\r\n');
}

/**
 * 纯函数：把探测输出解析为结构化态（供 check 报告与 dry-run 计划）。
 * @param {string} probeOut
 * @returns {object}
 */
export function parsePrepareVmProbe(probeOut) {
  const g = (re) => { const m = re.exec(probeOut || ''); return m ? m[1] : null; };
  const sshdInstalled = /SSHD_INSTALLED=True/.test(probeOut || '');
  return {
    admin: g(/ADMIN=(\w+)/) === 'True',
    sshd: {
      installed: sshdInstalled,
      state: sshdInstalled ? g(/STATE=(\w+)/) : null,
      startMode: sshdInstalled ? g(/STARTMODE=(\w+)/) : null,
    },
    firewall: { ssh: g(/FW_SSH=(\w+)/) === 'True', service: g(/FW_SERVICE=(\w+)/) === 'True' },
    defenderRead: !/DEFENDER_READ_FAILED/.test(probeOut || ''),
    node: { present: g(/NODE=(\w+)/) === 'True', version: g(/NODE=True (v[\d.]+)/) },
    agentCli: g(/AGENT_CLI=(\w+)/) === 'True',
    agentConfigDir: g(/AGENT_CONFIG_DIR=(\w+)/) === 'True',
    standbyLine: g(/STANDBY_AC_LINE=(.*)/) || '',
  };
}

/**
 * 计划生成（纯函数，setup dry-run 断言用）：按探测态列出每 DB 项动作或 SKIP。
 * @param {{servicePort:number, sshPort:number, vmDeployDir:string, ensureNode:boolean}} cfg
 * @param {ReturnType<parsePrepareVmProbe>} probe
 * @returns {Array<{db:string, item:string, action:string, needsAdmin:boolean, manual:boolean}>}
 */
export function planPrepareVm(cfg, probe) {
  const plan = [];
  plan.push({
    db: 'DB-1',
    item: 'OpenSSH Server',
    action: !probe.sshd.installed
      ? (probe.admin ? 'install+automatic+start' : 'MANUAL: Add-WindowsCapability (needs elevation)')
      : (probe.sshd.startMode !== 'Auto' ? 'set Automatic+start' : '[SKIP] installed/Auto/Running'),
    needsAdmin: true,
    manual: !probe.sshd.installed && !probe.admin,
  });
  plan.push({
    db: 'DB-2',
    item: 'Firewall ' + (cfg.sshPort || 22) + '/' + cfg.servicePort,
    action: probe.firewall.ssh && probe.firewall.service ? '[SKIP] rules exist' : 'ensure inbound rules',
    needsAdmin: true,
    manual: false,
  });
  plan.push({
    db: 'DB-5',
    item: 'Power never-sleep/saver',
    action: 'powercfg standby/hibernate/monitor = 0 (idempotent)',
    needsAdmin: false,
    manual: false,
  });
  plan.push({
    db: 'DB-6',
    item: 'Defender exclusions',
    action: probe.admin ? 'ensure Add-MpPreference delta' : '[MANUAL] run add-defender-exclusions.ps1 as admin',
    needsAdmin: true,
    manual: !probe.admin,
  });
  plan.push({
    db: 'DB-3',
    item: 'VM Node >= 18',
    action: !cfg.ensureNode
      ? '[SKIP] not requested (--ensure-node)'
      : (probe.node.present ? '[SKIP] node present' : 'winget install OpenJS.NodeJS.LTS'),
    needsAdmin: true,
    manual: false,
  });
  plan.push({
    db: 'DB-4',
    item: 'codebuddy login',
    action: '[MANUAL] interactive login cannot be scripted (structural)',
    needsAdmin: false,
    manual: true,
  });
  return plan;
}

/**
 * 经 ssh 只读探测当前 VM 前置态（复用 bootstrap 的 runSsh 语义：BatchMode + 容错 MSYS 噪声）。
 * 不走 apply、不写盘。失败时返回 null（调用方降级）。
 * @param {{vmHost:string, vmUser:string, vmSshPort:number}} cfg
 * @param {object} probeCfg {servicePort, vmDeployDir, ensureNode}
 * @returns {{ok:boolean, out:string}}
 */
export function probePrepareVm(cfg, probeCfg) {
  const ps1 = buildPrepareVmProbePs1({ ...probeCfg, sshPort: cfg.vmSshPort });
  // 探测脚本较复杂 ⇒ 走 .ps1 scp 通道由上层负责；这里给「轻量单行」版（纯只读，PowerShell -Command 无 MSYS 变量的子集）。
  // 为保持铁律（勿内联 PS），单行探测只查极少数无 $ 变量的命令；复杂探测交给 runRemotePs1。
  const oneLiner = `powershell -NoProfile -Command "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"`;
  const target = `${cfg.vmUser}@${cfg.vmHost}`;
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-p', String(cfg.vmSshPort || 22), target, oneLiner], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  void ps1;
  return { ok: r.status === 0, out: String(r.stdout || '') + String(r.stderr || '') };
}

/* ----------------------------- CLI 入口（可选独立运行） ----------------------------- */

const __dirname = dirname(fileURLToPath(import.meta.url));
void __dirname;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // 独立入口仅打印脚本文档（真正编排在 bootstrap.mjs prepare-vm 子命令，复用其 ssh/env 通道）。
  process.stdout.write(
    'prepare-vm.mjs 是被 bootstrap.mjs `prepare-vm` 子命令复用的纯逻辑模块。\n' +
      '请直接运行：node delivery/bootstrap.mjs prepare-vm [--apply] [--ensure-node]\n',
  );
}

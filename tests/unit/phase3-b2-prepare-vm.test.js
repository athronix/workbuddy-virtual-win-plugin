/**
 * Phase 3 批2 · P0-2 prepare-vm 一键前置（单测，纯函数零 spawn）
 *
 * 覆盖：
 *  - delivery/prepare-vm.mjs：buildPrepareVmProbePs1 / buildPrepareVmApplyPs1（ASCII、.ps1 铁律、
 *    幂等"先探测再动作"形态、DB-1/2/5/6/3 全覆盖、DB-4 手工保留）+ parsePrepareVmProbe + planPrepareVm；
 *  - delivery/preflight.mjs：evaluateAgentLogin 四判定（D-1 勘误口径：安装性≠登录态；
 *    codebuddy 无非交互身份命令 ⇒ 降级探测 + 局限显形，绝不谎报"已登录"）。
 *
 * 运行（只跑本文件）：node --test tests/unit/phase3-b2-prepare-vm.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPrepareVmProbePs1,
  buildPrepareVmApplyPs1,
  parsePrepareVmProbe,
  planPrepareVm,
} from '../../delivery/prepare-vm.mjs';
import { evaluateAgentLogin } from '../../delivery/preflight.mjs';

const CFG = { servicePort: 18443, sshPort: 22, vmDeployDir: 'C:/WinVMBridge', ensureNode: false };

/* ================= .ps1 生成 ================= */

test('probe .ps1：只读探测面（Get-*/query 无写动词），DB-1/2/3/5/6 + DB-4 标记行齐', () => {
  const ps1 = buildPrepareVmProbePs1(CFG);
  // ASCII-only（鸿蒙/MSYS 传输链敏感）
  assert.ok(!/[^\x00-\x7F]/.test(ps1), '探测脚本必须 ASCII');
  // 只读动词面（无 Set-/New-/Add-/Remove-/Stop-/Start-/Restart-）
  for (const w of ['Set-Service', 'New-NetFirewallRule', 'Add-MpPreference', 'powercfg /change']) {
    assert.ok(!ps1.includes(w), `探测面禁止写动作 ${w}`);
  }
  for (const marker of ['SSHD_INSTALLED=', 'FW_SSH=', 'DEFENDER_', 'NODE=', 'AGENT_CLI=', 'AGENT_CONFIG_DIR=', 'STANDBY_AC_LINE=']) {
    assert.ok(ps1.includes(marker), `探测输出须含 ${marker}`);
  }
});

test('apply .ps1：每项先探测再动作（幂等骨架）+ [SKIP]/[MANUAL] 出口 + PREPARE_VM_DONE 哨兵', () => {
  const ps1 = buildPrepareVmApplyPs1(CFG);
  assert.ok(!/[^\x00-\x7F]/.test(ps1), 'apply 脚本必须 ASCII');
  assert.ok(ps1.includes('PREPARE_VM_DONE'), '完成哨兵（上层判成功用）');
  // DB-1：Automatic+Start 且 sshd 从未装时打印精确 Add-WindowsCapability 手工一行（鸡生蛋诚实边界）
  assert.ok(ps1.includes('Set-Service sshd -StartupType Automatic'), 'DB-1 自动化服务面');
  assert.ok(ps1.includes('Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0'), 'DB-1 首装命令显形');
  assert.ok(ps1.includes('[DB-1][MANUAL]'), 'DB-1 非管理员手工出口');
  // DB-2：防火墙先判存在（幂等 [SKIP]）
  assert.ok(ps1.includes('New-NetFirewallRule') && ps1.includes('exists [SKIP]'), 'DB-2 幂等');
  // DB-5：powercfg 三件套（ac/dc/monitor=0）
  for (const c of ['standby-timeout-ac 0', 'standby-timeout-dc 0', 'monitor-timeout-ac 0']) {
    assert.ok(ps1.includes(c), `DB-5 须含 powercfg /change ${c}`);
  }
  // DB-6：Defender delta 幂等（ALREADY_CONFIGURED [SKIP]）
  assert.ok(ps1.includes('Add-MpPreference') && ps1.includes('ALREADY_CONFIGURED [SKIP]'), 'DB-6 幂等');
  // DB-3：ensureNode=false 时**不得**执行 winget 安装命令（提示文本可含字样，命令面 `winget install --id` 必须无）
  assert.ok(!ps1.includes('winget install --id'), 'ensureNode=false 必须零 node 安装命令面');
  const ps1b = buildPrepareVmApplyPs1({ ...CFG, ensureNode: true });
  assert.ok(ps1b.includes('winget install --id OpenJS.NodeJS.LTS'), 'DB-3 --ensure-node 开时给 winget 静默装');
  // R7（2026-10-30 复盘）：winget 经 ssh=MSIX 空壳 / MSI per-user 1603 ⇒ 必须带 zip+镜像兜底
  assert.ok(ps1b.includes('cdn.npmmirror.com/binaries/node'), 'DB-3 必须带 npmmirror zip 兜底通道');
  assert.ok(ps1b.includes('Expand-Archive'), 'DB-3 zip 兜底须解压落 LOCALAPPDATA');
  assert.ok(ps1b.includes('SetEnvironmentVariable("Path"'), 'DB-3 zip 兜底须持久化用户 PATH');
  // 兜底段必须在 winget 段之后（winget 无效才落 zip）
  assert.ok(
    ps1b.indexOf('winget install --id') < ps1b.indexOf('cdn.npmmirror.com/binaries/node'),
    '顺序：winget 首选 → zip 兜底',
  );
});

/* ================= parsePrepareVmProbe ================= */

test('parsePrepareVmProbe：多行探针输出 → 结构化态（True/False 双分支）', () => {
  const out = [
    'ADMIN=False',
    'SSHD_INSTALLED=True STATE=Running STARTMODE=Manual',
    'FW_SSH=False FW_SERVICE=False',
    'STANDBY_AC_LINE=Current AC Power Setting Index : 0x00007530',
    'DEFENDER_PATHS=',
    'NODE=True v22.1.0',
    'AGENT_CLI=True',
    'AGENT_CONFIG_DIR=True',
  ].join('\r\n');
  const s = parsePrepareVmProbe(out);
  assert.equal(s.admin, false);
  assert.deepEqual(s.sshd, { installed: true, state: 'Running', startMode: 'Manual' });
  assert.deepEqual(s.firewall, { ssh: false, service: false });
  assert.equal(s.node.present, true);
  assert.equal(s.node.version, 'v22.1.0');
  assert.equal(s.agentCli, true);
  assert.equal(s.agentConfigDir, true);
});

test('parsePrepareVmProbe：全缺省态（未装 sshd / 无 node）不误判', () => {
  const s = parsePrepareVmProbe('ADMIN=True\r\nSSHD_INSTALLED=False\r\nNODE=False\r\nAGENT_CLI=False');
  assert.equal(s.sshd.installed, false);
  assert.equal(s.node.present, false);
  assert.equal(s.admin, true);
});

/* ================= planPrepareVm ================= */

test('planPrepareVm：全就绪 ⇒ 可执行项全 [SKIP]（幂等第二次判据）+ DB-4 恒 MANUAL', () => {
  const ready = planPrepareVm(CFG, {
    admin: true,
    sshd: { installed: true, state: 'Running', startMode: 'Auto' },
    firewall: { ssh: true, service: true },
    node: { present: true, version: 'v22' },
    agentCli: true,
    agentConfigDir: true,
    standbyLine: '0',
  });
  const get = (db) => ready.find((p) => p.db === db);
  assert.ok(String(get('DB-1').action).includes('[SKIP]'), 'DB-1 就绪应 SKIP');
  assert.ok(String(get('DB-2').action).includes('[SKIP]'), 'DB-2 就绪应 SKIP');
  assert.equal(get('DB-1').manual, false);
  assert.equal(get('DB-4').manual, true, 'DB-4 结构性手工（6→1 判据的唯一残留人工项）');
  assert.ok(String(get('DB-5').action).includes('powercfg'), 'DB-5 幂等写恒在');

  const bare = planPrepareVm(CFG, {
    admin: false,
    sshd: { installed: false, state: null, startMode: null },
    firewall: { ssh: false, service: false },
    node: { present: false, version: '' },
    agentCli: false,
    agentConfigDir: false,
    standbyLine: 'unknown',
  });
  const db1 = bare.find((p) => p.db === 'DB-1');
  assert.ok(db1.manual, '未装 sshd 且无管理员 ⇒ DB-1 必须 MANUAL（鸡生蛋如实申报）');
  assert.ok(String(db1.action).includes('MANUAL'));
  const db6 = bare.find((p) => p.db === 'DB-6');
  assert.ok(db6.manual, '非管理员 ⇒ DB-6 手工配方出口');
});

/* ================= evaluateAgentLogin（D-1 勘误口径） ================= */

test('evaluateAgentLogin：确定性 provider=not-applicable（零噪声）', () => {
  const r = evaluateAgentLogin({ provider: 'workbuddy-deterministic', cliExists: false });
  assert.equal(r.verdict, 'not-applicable');
  assert.equal(r.blocking, false);
});

test('evaluateAgentLogin：workbuddy ∧ CLI 可跑 ∧ 标记文件缺 ⇒ installed-unverified（绝不谎报已登录）', () => {
  const r = evaluateAgentLogin({ provider: 'workbuddy', cliExists: true, configDirExists: false, markerFiles: [] });
  assert.equal(r.verdict, 'installed-unverified');
  assert.equal(r.blocking, false, '登录态属 WARNING 面（首委派才真暴露），不得阻断安装');
  assert.match(r.detail, /无从证明|无法机械确证/);
  assert.match(r.remedy, /交互式登录|跑一次 codebuddy/);
});

test('evaluateAgentLogin：CLI 缺 ⇒ cli-missing 但 blocking=false（安装性由 vm-agent-cli 定罪，不重复阻断）', () => {
  const r = evaluateAgentLogin({ provider: 'workbuddy', cliExists: false });
  assert.equal(r.verdict, 'cli-missing');
  assert.equal(r.blocking, false);
});

test('evaluateAgentLogin：标记在 ⇒ config-dir-present ∧ detail 必含局限声明（凭据不落可见文件）', () => {
  const r = evaluateAgentLogin({ provider: 'workbuddy', cliExists: true, configDirExists: true, markerFiles: ['settings.json'] });
  assert.equal(r.verdict, 'config-dir-present');
  assert.match(r.detail, /无法机械确证|不确证|大概率/, '必须显形局限，绝不输出"已登录"确证口径');
});

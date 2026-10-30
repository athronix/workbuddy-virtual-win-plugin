// T1 目录治理单测：「按日期子目录 + MANIFEST」规则固化进部署链路（2026-09-23）
// 覆盖：buildVmInstallPs1 日志收口 dev-and-qa/logs/<date>/、buildDeployManifest 纯函数、
//       QA_PROBE_FILES 与 qa/probes/ 实体一致。
// R8 根除批（2026-10-30）：vmInstallCommand（Git-Bash 专属）→ buildVmInstallPs1（.ps1 铁律通道，
// 与远端默认 shell 无关）。新增「载荷绝不含 bash 专属语法」防回归锁。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const {
  buildVmInstallPs1,
  buildVmUninstallPs1,
  buildDeployManifest,
  VM_ARCHIVE,
  QA_PROBE_FILES,
  VM_DEVQA_DIR,
} = await import(join(ROOT, 'delivery', 'setup.mjs'));

const baseCfg = {
  vmDeployDir: 'C:/WinVMBridge',
  vmProvider: 'workbuddy',
  workbuddyCli: 'codebuddy',
};

/* ================= 跨壳防回归锁（R8） ================= */

const BASH_ONLY_TOKENS = [
  'set -o pipefail',
  'mkdir -p ',
  'rm -f ',
  'cat > ',
  ' | tee ',
  'umask ',
  'test -f ',
  '$(',
];

test('R8 锁：buildVmInstallPs1 载荷零 bash 专属语法（cmd.exe 默认壳可跑）', () => {
  const ps = buildVmInstallPs1(baseCfg, '2026-10-30');
  for (const t of BASH_ONLY_TOKENS) {
    assert.ok(!ps.includes(t), `install .ps1 载荷不得含 bash 专属片段 ${JSON.stringify(t)}`);
  }
  // ASCII-only（铁律）
  assert.ok(!/[^\x00-\x7F]/.test(ps), 'install .ps1 必须 ASCII');
});

test('R8 锁：buildVmUninstallPs1 同样零 bash 专属语法 + ASCII', () => {
  const ps = buildVmUninstallPs1(baseCfg);
  for (const t of BASH_ONLY_TOKENS) {
    assert.ok(!ps.includes(t), `uninstall .ps1 载荷不得含 bash 专属片段 ${JSON.stringify(t)}`);
  }
  assert.ok(!/[^\x00-\x7F]/.test(ps), 'uninstall .ps1 必须 ASCII');
});

/* ================= 安装 .ps1 形状 ================= */

test('buildVmInstallPs1: install log goes to dev-and-qa/logs/<date>/ (not deploy root)', () => {
  const ps = buildVmInstallPs1(baseCfg, '2026-09-23');
  assert.ok(ps.includes(`'${VM_DEVQA_DIR}' 'logs') '2026-09-23'`), 'should pre-create dated log dir (host-computed date)');
  assert.ok(
    ps.includes(`Tee-Object -FilePath $log`),
    'install log must Tee-Object into dev-and-qa/logs/<date>/（=旧 tee 语义的 PowerShell 等价）',
  );
  assert.ok(ps.includes(`Join-Path $logDir 'install-vm-run.log'`), 'log file name preserved');
  // 跨壳陷阱回归锁定：ssh 命令串里绝不允许出现 $() —— Git-Bash 报 syntax error、cmd 不展开
  assert.ok(!ps.includes('$('), 'no $() in remote payload (cross-shell trap)');
});

test('buildVmInstallPs1: still unpacks archive, removes it, and guards exit codes (behavior intact)', () => {
  const ps = buildVmInstallPs1(baseCfg);
  assert.ok(ps.includes(`tar -xzf '${VM_ARCHIVE}'`), 'tar unpack via Windows built-in tar.exe（PowerShell 原生可调用）');
  assert.ok(ps.includes(`Remove-Item -LiteralPath '${VM_ARCHIVE}'`), 'archive removed via PowerShell (was node -e rmSync)');
  assert.ok(ps.includes('--skip-install --skip-build'));
  assert.ok(ps.includes('VM_INSTALL_DONE'), 'completion sentinel（上层防假成功判据）');
  assert.ok(ps.includes('VM_INSTALL_FAILED'), 'failure sentinel');
});

/* -------- Phase 5 批14：策略闸执法灰度跨部署持久化透传 -------- */

test('buildVmInstallPs1: policyGateWiring=on/off ⇒ 透传 --policy-gate-wiring（值在 --provider 前）', () => {
  const on = buildVmInstallPs1({ ...baseCfg, policyGateWiring: 'on' });
  assert.ok(on.includes('--policy-gate-wiring on --provider'), 'on 态必须带透传参且邻接 --provider');
  const off = buildVmInstallPs1({ ...baseCfg, policyGateWiring: 'off' });
  assert.ok(off.includes('--policy-gate-wiring off --provider'), 'off 态=双闸整体关闭同样持久化');
});

test('buildVmInstallPs1: 缺省/shadow/非法值 ⇒ 不注入（产物逐字节旧形态护栏）', () => {
  for (const w of [undefined, '', 'shadow', 'ON ', 'exec']) {
    const ps = buildVmInstallPs1({ ...baseCfg, policyGateWiring: w });
    assert.ok(!ps.includes('--policy-gate-wiring'), `wiring=${JSON.stringify(w)} 不应透传（resolveConfig 已白名单化，此处防御双写）`);
  }
});

test('buildVmInstallPs1: 透传后跨壳陷阱锁仍守（无 $() 入远端载荷）', () => {
  const ps = buildVmInstallPs1({ ...baseCfg, policyGateWiring: 'on' });
  assert.ok(!ps.includes('$()'), 'no $() in remote payload');
});

test('buildVmUninstallPs1: dry-run/apply 两态 + provider/cli 透传 + 哨兵', () => {
  const dry = buildVmUninstallPs1(baseCfg, { dryRun: true });
  assert.ok(dry.includes('--uninstall --dry-run'));
  assert.ok(dry.includes('VM_UNINSTALL_DONE'));
  const yes = buildVmUninstallPs1(baseCfg, { dryRun: false });
  assert.ok(yes.includes('--uninstall --yes'));
  assert.ok(yes.includes(`--provider ${baseCfg.vmProvider} --cli ${baseCfg.workbuddyCli}`));
});

/* ================= MANIFEST 与探针清单（不受 R8 影响，原样保留） ================= */

test('buildDeployManifest: contains required fields and probe paths under dev-and-qa', () => {
  const body = buildDeployManifest({
    deployedAt: '2026-09-23T12:00:00.000Z',
    archive: VM_ARCHIVE,
    logFile: 'dev-and-qa/logs/<date>/install-vm-run.log',
    probes: QA_PROBE_FILES.map((f) => `dev-and-qa/probes/${f}`),
  });
  assert.ok(body.startsWith('# WinVM Bridge deploy manifest'));
  assert.ok(body.includes('deployedAt: 2026-09-23T12:00:00.000Z'));
  assert.ok(body.includes(`archive: ${VM_ARCHIVE}`));
  for (const f of QA_PROBE_FILES) {
    assert.ok(body.includes(`dev-and-qa/probes/${f}`), `manifest lists probe ${f}`);
  }
  assert.ok(body.includes('not deploy root'), 'documents the no-scratch-at-root rule');
});

test('VM_DEVQA_DIR + QA_PROBE_FILES contract: probes exist in repo qa/probes/', () => {
  assert.equal(VM_DEVQA_DIR, 'dev-and-qa');
  for (const f of QA_PROBE_FILES) {
    assert.ok(existsSync(join(ROOT, 'qa', 'probes', f)), `qa/probes/${f} must exist`);
  }
});

test('qa-verify.mjs references probes under dev-and-qa/probes/ (path sync)', async () => {
  const src = await import('node:fs').then((m) => m.readFileSync(join(ROOT, 'qa', 'probes', 'qa-verify.mjs'), 'utf8'));
  assert.ok(src.includes('C:/WinVMBridge/dev-and-qa/probes/'), 'vmps() must target dev-and-qa/probes/');
  assert.ok(!src.includes('-File C:/WinVMBridge/qa-probe.ps1'), 'no root-level probe path remains');
});

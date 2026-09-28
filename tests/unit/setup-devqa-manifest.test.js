// T1 目录治理单测：「按日期子目录 + MANIFEST」规则固化进部署链路（2026-09-23）
// 覆盖：vmInstallCommand 日志收口 dev-and-qa/logs/<date>/、buildDeployManifest 纯函数、
//       QA_PROBE_FILES 与 qa/probes/ 实体一致。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const { vmInstallCommand, buildDeployManifest, VM_ARCHIVE, QA_PROBE_FILES, VM_DEVQA_DIR } = await import(
  join(ROOT, 'delivery', 'setup.mjs')
);

const baseCfg = {
  vmDeployDir: 'C:/WinVMBridge',
  vmProvider: 'workbuddy',
  workbuddyCli: 'codebuddy',
};

test('vmInstallCommand: install log goes to dev-and-qa/logs/<date>/ (not deploy root)', () => {
  const cmd = vmInstallCommand(baseCfg, '2026-09-23');
  assert.ok(cmd.includes('mkdir -p dev-and-qa/logs/2026-09-23'), 'should pre-create dated log dir (host-computed date)');
  assert.ok(
    cmd.includes(`tee dev-and-qa/logs/2026-09-23/install-vm-run.log`),
    'install log must tee into dev-and-qa/logs/<date>/',
  );
  assert.ok(!cmd.includes('| tee install-vm-run.log'), 'must NOT tee into deploy root anymore');
  // MSYS 陷阱回归锁定：ssh 命令串里绝不允许出现 $() —— 会被远端 Git-Bash 报 syntax error
  assert.ok(!cmd.includes('$('), 'no $() in remote command (MSYS bash -c chokes on it)');
});

test('vmInstallCommand: still unpacks archive and removes it (existing behavior intact)', () => {
  const cmd = vmInstallCommand(baseCfg);
  assert.ok(cmd.includes(`tar -xzf ${VM_ARCHIVE}`));
  assert.ok(cmd.includes(`rmSync("${VM_ARCHIVE}"`));
  assert.ok(cmd.includes('--skip-install --skip-build'));
});

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

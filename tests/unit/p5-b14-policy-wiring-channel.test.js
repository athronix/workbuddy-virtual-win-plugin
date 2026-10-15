/**
 * Phase 5 批14 · 策略闸执法灰度跨部署持久化通道（P2 项收口）。
 *
 * 背景（批12 真机教训）：shadow→on 切换此前只能手改 VM 上 start-hidden.ps1 的临时补丁——
 * 任何 `deploy-vm --apply` 会重新生成该文件并**冲掉补丁**回到缺省 shadow（§1.8 fail-safe 提醒）。
 * 且真机证伪过：Add-Content 追加到文件尾=位于 `WaitForExit` 之后永不执行。
 *
 * 本批把开关通道化：install-vm `--policy-gate-wiring off|shadow|on`（parseArgs 白名单校验）
 * ⇒ buildTaskXml 之后经**与 bearer 同款**的 `injectBearerEnvAssignment` 通路把
 * `$env:WINVM_POLICY_GATE_WIRING = '<值>'` 插进**赋值区**（$env:WINVM_PSBRIDGE_READY_TIMEOUT_MS
 * 行后、Start-Process 之前），幂等可重入。setup.mjs 侧 resolveConfig 读 .env 键 +
 * vmInstallCommand 透传（仅 on/off 传参，''/shadow 不传 ⇒ 默认产物逐字节旧形态）。
 *
 * 覆盖：
 *  ① 注入通路行为（generic 函数对新 env 名）：插入位=赋值区、幂等、绝不文件尾；
 *  ② install-vm 主流程源码钉（白名单校验/仅非 shadow 注入/dry-run 显式打印）；
 *  ③ 默认路径零污染：不传 wiring ⇒ buildTaskXml 产物与引入前逐字节一致（GOLDEN 同构面）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const { buildTaskXml, injectBearerEnvAssignment } = await import(
  join(ROOT, 'delivery', 'install-vm.mjs')
);

const TASK = 'WinVMBridge.Service';
const NODE = 'C:\\nvm4w\\nodejs\\node.exe';
const CLI = 'C:\\WinVMBridge\\repo\\packages\\vm-service\\dist\\cli.js';
const CFG = 'C:\\WinVMBridge\\repo\\delivery\\.generated\\vm-service.runtime.json';
const PORT = 18443;
const READY_LINE = "$env:WINVM_PSBRIDGE_READY_TIMEOUT_MS = '60000'";

const INSTALL_SRC = readFileSync(join(ROOT, 'delivery', 'install-vm.mjs'), 'utf8');
const SETUP_SRC = readFileSync(join(ROOT, 'delivery', 'setup.mjs'), 'utf8');

function genPs1() {
  const dir = mkdtempSync(join(tmpdir(), 'winvm-b14-'));
  // 批14 实现=buildTaskXml 默认签名不变（产物逐字节旧形态），wiring 注入走主流程
  // 的 injectBearerEnvAssignment 同款后置通路（与 bearer 对称）⇒ 测试同构复刻该两段。
  buildTaskXml(TASK, NODE, CLI, PORT, CFG, dir, false);
  return { dir, ps1: join(dir, 'start-hidden.ps1'), text: () => readFileSync(join(dir, 'start-hidden.ps1'), 'utf8') };
}

/* ---------- ① 注入通路行为（对新 env 名复用 bearer 同款 generic 函数） ---------- */

test('① 注入位=赋值区：紧跟 READY_TIMEOUT 行后、Start-Process 之前（批12 文件尾教训钉死）', () => {
  const g = genPs1();
  const r = injectBearerEnvAssignment(g.ps1, 'WINVM_POLICY_GATE_WIRING', 'on');
  assert.equal(r.inserted, true);
  const lines = g.text().split(/\r?\n/);
  const at = lines.findIndex((l) => l === "$env:WINVM_POLICY_GATE_WIRING = 'on'");
  const ready = lines.findIndex((l) => l.startsWith('$env:WINVM_PSBRIDGE_READY_TIMEOUT_MS'));
  const sp = lines.findIndex((l) => l.includes('Start-Process'));
  assert.ok(at > 0, '赋值行必须在');
  assert.equal(at, ready + 1, '必须紧跟 READY_TIMEOUT 赋值行（env 段内聚）');
  assert.ok(at < sp, '必须在 Start-Process 之前（否则 node 继承不到，永失效）');
  assert.ok(!g.text().trimEnd().endsWith("$env:WINVM_POLICY_GATE_WIRING = 'on'"), '绝不允许落在文件尾（WaitForExit 之后）');
});

test('① 幂等三态：同值就位/异值就地替换/不重复插行', () => {
  const g = genPs1();
  injectBearerEnvAssignment(g.ps1, 'WINVM_POLICY_GATE_WIRING', 'on');
  const r2 = injectBearerEnvAssignment(g.ps1, 'WINVM_POLICY_GATE_WIRING', 'on');
  assert.equal(r2.inserted, false);
  assert.equal(r2.changed, false, '同值重复注入必须零改动');
  const r3 = injectBearerEnvAssignment(g.ps1, 'WINVM_POLICY_GATE_WIRING', 'off');
  assert.equal(r3.changed, true);
  assert.equal(r3.inserted, false, '异值应就地替换而非再插一行');
  const occurrences = (g.text().match(/WINVM_POLICY_GATE_WIRING/g) ?? []).length;
  assert.equal(occurrences, 1, '全文只允许一条赋值行');
  assert.ok(g.text().includes("$env:WINVM_POLICY_GATE_WIRING = 'off'"));
});

/* ---------- ② install-vm 主流程源码钉（未导出段以文本判据锁形态） ---------- */

test('② parseArgs：--policy-gate-wiring 白名单校验 off|shadow|on（非法值 exit 2）', () => {
  assert.match(INSTALL_SRC, /case '--policy-gate-wiring'/, 'case 分支在位');
  assert.match(INSTALL_SRC, /v !== 'off' && v !== 'shadow' && v !== 'on'/, '白名单三值校验在位');
  assert.match(INSTALL_SRC, /--policy-gate-wiring 只接受 off\|shadow\|on/, '错误文案在位');
});

test('② 主流程注入段：仅非 shadow 值触发 + 走 injectBearerEnvAssignment 通路 + dry-run 显式打印', () => {
  assert.match(
    INSTALL_SRC,
    /if \(args\.policyGateWiring && args\.policyGateWiring !== 'shadow'\) \{[\s\S]{0,400}?injectBearerEnvAssignment\(\s*join\(genDir, 'start-hidden\.ps1'\),\s*'WINVM_POLICY_GATE_WIRING',\s*args\.policyGateWiring,\s*\)/,
    '注入段：条件（非 shadow）+ generic 通路 + 实名 env',
  );
  assert.match(INSTALL_SRC, /策略闸执法 WINVM_POLICY_GATE_WIRING/, 'dry-run steps 显式打印在位（与运维端点同纪律）');
});

test('② setup.mjs 透传链：resolveConfig 读键白名单化 + vmInstallCommand 仅 on/off 传参', () => {
  assert.match(SETUP_SRC, /policyGateWiring: \(env\['WINVM_POLICY_GATE_WIRING'\] \|\| ''\)\.trim\(\)\.toLowerCase\(\)/, 'resolveConfig 键在位（trim+lower）');
  assert.match(SETUP_SRC, /cfg\.policyGateWiring === 'on' \|\| cfg\.policyGateWiring === 'off'/, 'vmInstallCommand 仅两态透传');
});

/* ---------- ③ 默认路径零污染（GOLDEN 同构面：wiring 通道不改默认产物） ---------- */

test('③ 不传 wiring：buildTaskXml 默认产物不含 WINVM_POLICY_GATE_WIRING（逐字节旧形态）', () => {
  const g = genPs1();
  assert.ok(!g.text().includes('WINVM_POLICY_GATE_WIRING'), '默认产物必须零注入');
  // READY_TIMEOUT 与 admin 缺省形态不受影响
  assert.ok(g.text().includes(READY_LINE));
  assert.ok(!g.text().includes('WINVM_ADMIN_ENDPOINT'));
});

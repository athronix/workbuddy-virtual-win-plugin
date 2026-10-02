/**
 * install-vm.mjs · --admin-endpoint 开关单元测试
 *
 * 背景：运维端点 `POST /admin/llm-session/reset`（vm-service `server.ts` L1 段）在
 * `process.env['WINVM_ADMIN_ENDPOINT'] !== '1'` 时直接 404（默认关）。而计划任务
 * `WinVMBridge.Service` 的任务 XML **不含任何 env 元素**，VM 服务能拿到环境变量的
 * **唯一来源**是生成的 `start-hidden.ps1` 里那几行显式 `$env:` 赋值
 * （node 由 `Start-Process` 从该 ps1 继承环境）。故开关只能作用在 ps1 生成源上——
 * 且该文件由 `buildTaskXml()` 每次部署**无条件重写**，手改 VM 上的文件下次部署即失效。
 *
 * 本文件锁三件事：
 *   1) 传 `--admin-endpoint` → ps1 内出现 `$env:WINVM_ADMIN_ENDPOINT = '1'`（端点可达）；
 *   2) 不传 → **不含**该行，且生成内容与引入开关前**逐字节一致**（回归护栏：冻结黄金基线）；
 *   3) 既有的 `$env:WINVM_PSBRIDGE_READY_TIMEOUT_MS` 赋值不受影响（两种模式下都存在且值不变）。
 *
 * 另含源码形态守卫：`parseArgs` 未导出（不为其扩大导出面），故对参数默认值与调用点透传
 * 做文本级断言，保证「不传即 false」这一安全定性不会在后续重构中被静默改成默认开启。
 *
 * 全部在临时目录内隔离运行，绝不触碰真实仓库 delivery/.generated。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTaskXml } from '../../delivery/install-vm.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const INSTALL_VM = join(REPO_ROOT, 'delivery', 'install-vm.mjs');
const INSTALL_VM_SRC = readFileSync(INSTALL_VM, 'utf8');

const TASK_NAME = 'WinVMBridge.Service';
const NODE_EXE = 'C:\\nvm4w\\nodejs\\node.exe';
const CLI = 'C:\\WinVMBridge\\repo\\packages\\vm-service\\dist\\cli.js';
const CFG = 'C:\\WinVMBridge\\repo\\delivery\\.generated\\vm-service.runtime.json';
const PORT = 18443;

/** ps1 中注入的两个 env 变量的字面形态（与实现同风格：单引号、等号两侧空格） */
const ADMIN_ENV_LINE = "$env:WINVM_ADMIN_ENDPOINT = '1'";
const READY_TIMEOUT_LINE = "$env:WINVM_PSBRIDGE_READY_TIMEOUT_MS = '60000'";

/**
 * 冻结黄金基线：**引入 --admin-endpoint 之前**（改动前实测取证）用同一组输入生成的
 * ps1 全文，逐字节固化。若日后有人把 adminEndpoint 默认值改成 true、或给 ps1 加了
 * 任何空行/注释/格式差异，本基线会立刻失败——这正是"默认关闭 + 不改变既有产物"的护栏。
 */
const GOLDEN_PS1_BEFORE_SWITCH =
  '# WinVM Bridge VM Service —— 隐藏窗口启动器（由 install-vm.mjs 生成，请勿手改）\r\n' +
  "$env:WINVM_PSBRIDGE_READY_TIMEOUT_MS = '60000'\r\n" +
  "$nodeExe = 'C:\\nvm4w\\nodejs\\node.exe'\r\n" +
  '$cliArgs = \'"C:\\WinVMBridge\\repo\\packages\\vm-service\\dist\\cli.js" --host 127.0.0.1 --port 18443 --config "C:\\WinVMBridge\\repo\\delivery\\.generated\\vm-service.runtime.json"\'\r\n' +
  "$workDir = '.'\r\n" +
  "$svcPort = '18443'\r\n" +
  '# 自清理：若端口已被旧实例（孤儿 node，常见于任务被 /end 后游离）占用，先强杀，\r\n' +
  '# 避免新实例 EADDRINUSE 秒退、旧实例继续以旧代码服务（GUI 判定迟迟不刷新）。\r\n' +
  '$portPid = (Get-NetTCPConnection -LocalPort $svcPort -ErrorAction SilentlyContinue).OwningProcess | Select-Object -Unique\r\n' +
  'if ($portPid) { Stop-Process -Id $portPid -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500 }\r\n' +
  '# 以 -PassThru 捕获 node 子进程；脚本退出（任务被 /end 终止）时兜底强杀 node，避免孤儿残留。\r\n' +
  '$nodeProc = Start-Process -WindowStyle Hidden -FilePath $nodeExe -ArgumentList $cliArgs -WorkingDirectory $workDir -PassThru\r\n' +
  'try { $nodeProc.WaitForExit() } finally { if ($nodeProc -and -not $nodeProc.HasExited) { try { $nodeProc.Kill() } catch {} } }\r\n';

/** 在临时目录内生成产物并返回 ps1 内容（outDir 注入，隔离真实仓库） */
async function generatePs1({ adminEndpoint, omitFlagArg = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'winvm-admin-'));
  if (omitFlagArg) {
    // 省略第 7 个参数：等价于命令行不传 --admin-endpoint（默认关闭路径）
    buildTaskXml(TASK_NAME, NODE_EXE, CLI, PORT, CFG, dir);
  } else {
    buildTaskXml(TASK_NAME, NODE_EXE, CLI, PORT, CFG, dir, adminEndpoint);
  }
  return readFileSync(join(dir, 'start-hidden.ps1'), 'utf8');
}

describe('install-vm --admin-endpoint · 开启时注入 env', () => {
  test('传开关 → ps1 含 $env:WINVM_ADMIN_ENDPOINT = \'1\'', async () => {
    const ps1 = await generatePs1({ adminEndpoint: true });
    assert.ok(
      ps1.includes(ADMIN_ENV_LINE),
      `开启时应注入 \`${ADMIN_ENV_LINE}\`（vm-service 侧唯一 env 来源），实际 ps1：\n${ps1}`,
    );
  });

  test('注入行紧跟在 READY_TIMEOUT 之后、$nodeExe 之前（env 段内聚）', async () => {
    const ps1 = await generatePs1({ adminEndpoint: true });
    const lines = ps1.split('\r\n');
    const adminAt = lines.indexOf(ADMIN_ENV_LINE);
    const readyAt = lines.indexOf(READY_TIMEOUT_LINE);
    const nodeExeAt = lines.findIndex((l) => l.startsWith('$nodeExe = '));
    assert.ok(adminAt > 0, '注入行应存在');
    assert.equal(adminAt, readyAt + 1, '应紧随 READY_TIMEOUT 赋值之后');
    assert.ok(adminAt < nodeExeAt, '必须在 Start-Process 拉起 node 之前完成赋值（否则不生效）');
  });

  test('开启只多这一行：去掉注入行后与关闭态逐字节一致', async () => {
    const on = await generatePs1({ adminEndpoint: true });
    const off = await generatePs1({ adminEndpoint: false });
    assert.equal(
      on.replace(`${ADMIN_ENV_LINE}\r\n`, ''),
      off,
      '开启态相对关闭态的唯一差异应为那一行 env 赋值（不得夹带其它格式变化）',
    );
    assert.equal(on.split('\r\n').length - off.split('\r\n').length, 1, '开启态恰好多 1 行');
  });
});

describe('install-vm --admin-endpoint · 默认关闭（安全定性）', () => {
  test('显式传 false → 不含该行', async () => {
    const ps1 = await generatePs1({ adminEndpoint: false });
    assert.ok(
      !ps1.includes('WINVM_ADMIN_ENDPOINT'),
      `默认关闭时不得出现任何 WINVM_ADMIN_ENDPOINT（否则端点意外可达），实际 ps1：\n${ps1}`,
    );
  });

  test('省略参数（= 命令行不传）→ 不含该行', async () => {
    const ps1 = await generatePs1({ omitFlagArg: true });
    assert.ok(!ps1.includes('WINVM_ADMIN_ENDPOINT'), '不传开关时不得注入 env');
  });

  test('回归护栏：不传开关时生成内容与引入前逐字节一致', async () => {
    const ps1 = await generatePs1({ omitFlagArg: true });
    assert.equal(
      ps1,
      GOLDEN_PS1_BEFORE_SWITCH,
      '默认路径的 ps1 必须与引入 --admin-endpoint 之前逐字节一致（不得多空行/注释/格式差异）',
    );
  });

  test('parseArgs 默认 adminEndpoint=false（不得被改成默认开启）', () => {
    assert.match(
      INSTALL_VM_SRC,
      /adminEndpoint:\s*false/,
      'parseArgs 的默认值必须为 false —— 端点默认 404 是安全基线',
    );
  });

  test('命令行开关形态：仅 --admin-endpoint 置 true，无隐式取值参数', () => {
    assert.match(
      INSTALL_VM_SRC,
      /case '--admin-endpoint':\s*out\.adminEndpoint = true;/,
      '应为无值布尔开关（不带 --admin-endpoint=xxx 形式，避免误传字符串 truthy）',
    );
  });
});

describe('install-vm --admin-endpoint · 不干扰既有 env 与启动语义', () => {
  test('两种模式下 WINVM_PSBRIDGE_READY_TIMEOUT_MS 赋值均存在且未被改动', async () => {
    for (const adminEndpoint of [false, true]) {
      const ps1 = await generatePs1({ adminEndpoint });
      assert.ok(
        ps1.includes(READY_TIMEOUT_LINE),
        `adminEndpoint=${adminEndpoint} 时 READY_TIMEOUT 赋值必须原样保留`,
      );
      assert.equal(
        ps1.split(READY_TIMEOUT_LINE).length - 1,
        1,
        `adminEndpoint=${adminEndpoint} 时 READY_TIMEOUT 赋值不得重复出现`,
      );
    }
  });

  test('开启时 node 仍由 Start-Process -WindowStyle Hidden 拉起（隐藏窗口语义不变）', async () => {
    const ps1 = await generatePs1({ adminEndpoint: true });
    assert.match(ps1, /Start-Process\s+-WindowStyle\s+Hidden/);
    assert.match(ps1, /\$nodeProc\.WaitForExit\(\)/);
  });

  test('buildTaskXml 第 7 参为可选且默认 false（不破坏既有 6 参调用方）', () => {
    assert.match(
      INSTALL_VM_SRC,
      /function buildTaskXml\([^)]*adminEndpoint = false\)/,
      '新增参数须带默认值，保证既有 6 参调用（tests/unit/install-vm-task.test.js）行为不变',
    );
  });

  test('部署调用点把 args.adminEndpoint 透传给 buildTaskXml', () => {
    assert.match(
      INSTALL_VM_SRC,
      /buildTaskXml\(\s*args\.taskName,\s*nodeExe,\s*cliEntry,\s*args\.port,\s*runtimeConfig,\s*undefined,\s*args\.adminEndpoint\s*\)/,
      '主流程须把命令行开关透传到 ps1 生成源，否则开关形同虚设',
    );
  });
});
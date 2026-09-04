/**
 * install-vm.mjs · buildTaskXml 单元测试
 *
 * 覆盖第十一轮「VM 残留 node.exe 日志窗口（Q3 / Q4a）」修复：
 *   GUI 能力域要求服务跑在**交互式会话**（InteractiveToken，Session >= 1），
 *   而 InteractiveToken 任务下 Windows 会**忽略** <Hidden>true</Hidden> ——
 *   直接把 node.exe 作为任务动作就会弹出常驻控制台窗口（用户可见、易误关）。
 *   修复后改为经生成的 start-hidden.ps1，用 Start-Process -WindowStyle Hidden 拉起 node。
 *
 * 这里锁住两件最容易回归的事：
 *   1) 任务动作**不再**直接是 node.exe（否则窗口重现）；
 *   2) 多层引号转义正确 —— 用 -File 只保留一层引号，node 参数原样写进 .ps1。
 *
 * 全部在临时目录内隔离运行，绝不触碰真实仓库 delivery/.generated。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTaskXml } from '../../delivery/install-vm.mjs';

const TASK_NAME = 'WinVM Bridge VM Service';
const NODE_EXE = 'C:\\nvm4w\\nodejs\\node.exe';
const CLI = 'C:\\WinVMBridge\\repo\\packages\\vm-service\\dist\\cli.js';
const CFG = 'C:\\WinVMBridge\\repo\\delivery\\.generated\\vm-service.runtime.json';
const PORT = 18443;

/** 在临时目录内生成产物并返回内容（outDir 注入，隔离真实仓库） */
async function generate({ nodeExe = NODE_EXE, cli = CLI, port = PORT, cfg = CFG } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'winvm-task-'));
  buildTaskXml(TASK_NAME, nodeExe, cli, port, cfg, dir);
  return {
    dir,
    xml: readFileSync(join(dir, 'task.xml'), 'utf16le'),
    ps1: readFileSync(join(dir, 'start-hidden.ps1'), 'utf8'),
  };
}

describe('buildTaskXml · 隐藏窗口启动器', () => {
  test('同时产出 task.xml 与 start-hidden.ps1', async () => {
    const { dir } = await generate();
    assert.ok(existsSync(join(dir, 'task.xml')), 'task.xml 应生成');
    assert.ok(existsSync(join(dir, 'start-hidden.ps1')), 'start-hidden.ps1 应生成');
  });

  test('任务动作不再直接是 node.exe（窗口重现的回归点）', async () => {
    const { xml } = await generate();
    assert.ok(
      !/<Command>[^<]*node\.exe/i.test(xml),
      '任务动作不应直接是 node.exe —— InteractiveToken 下会忽略 <Hidden> 而弹出控制台窗口',
    );
    assert.match(xml, /<Command>powershell\.exe<\/Command>/);
  });

  test('任务经 start-hidden.ps1 以 -File 启动并要求隐藏窗口', async () => {
    const { dir, xml } = await generate();
    assert.match(xml, /-File\s+"[^"]*start-hidden\.ps1"/, '应以 -File 指向生成的启动器');
    assert.ok(xml.includes(join(dir, 'start-hidden.ps1')), '启动器路径应为本次生成产物');
    assert.match(xml, /-WindowStyle\s+Hidden/, 'powershell 自身也要隐藏');
    assert.match(xml, /-ExecutionPolicy\s+Bypass/, '避免受限执行策略阻断启动器');
  });

  test('ps1 以 Start-Process -WindowStyle Hidden 拉起 node 并 -Wait', async () => {
    const { ps1 } = await generate();
    assert.match(ps1, /Start-Process\s+-WindowStyle\s+Hidden/);
    assert.match(ps1, /-FilePath\s+\$nodeExe/);
    assert.match(ps1, /-ArgumentList\s+\$cliArgs/);
    assert.match(ps1, /-WorkingDirectory\s+\$workDir/);
    assert.match(ps1, /-Wait\b/, '-Wait 让任务在服务存活期间保持 Running（/End 可终止、崩溃可重启）');
  });

  test('node 参数原样进 ps1（含带双引号的 cli 与配置路径）', async () => {
    const { ps1 } = await generate();
    const expected = `$cliArgs = '"${CLI}" --host 127.0.0.1 --port ${PORT} --config "${CFG}"'`;
    assert.ok(ps1.includes(expected), `cliArgs 未原样落地，实际 ps1：\n${ps1}`);
    assert.ok(ps1.includes(`$nodeExe = '${NODE_EXE}'`));
  });

  test('路径含单引号时按 PowerShell 规则双写转义', async () => {
    const tricky = 'C:\\my odd\'s dir\\cli.js';
    const { ps1 } = await generate({ cli: tricky });
    assert.ok(ps1.includes("''"), `单引号应双写转义，实际 ps1：\n${ps1}`);
    // 双写后 PowerShell 取值回原串：'C:\my odd''s dir\cli.js' → C:\my odd's dir\cli.js
    assert.ok(ps1.includes(`$cliArgs = '"C:\\my odd''s dir\\cli.js"`));
  });

  test('task.xml 为 UTF-16LE 且带 BOM（schtasks /XML 硬要求）', async () => {
    const { xml } = await generate();
    assert.equal(xml.charCodeAt(0), 0xfeff, '首字符应为 BOM');
  });

  test('保留 InteractiveToken（GUI 能力域前提，不可退化成服务）', async () => {
    const { xml } = await generate();
    assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/);
    assert.match(xml, /<RunLevel>HighestAvailable<\/RunLevel>/);
  });
});

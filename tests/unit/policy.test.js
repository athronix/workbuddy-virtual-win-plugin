/**
 * 策略引擎单元测试（SECURITY-GOVERNANCE.md §3）
 *
 * 核心验证：**拒绝优先** —— 黑名单最高优先级，未命中白名单同样拒绝。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CapabilityRegistry, CorePolicyEngine } from '@winvm/core';
import { defineCapability } from '@winvm/contracts';
import { WINDOWS_CAPABILITIES } from '@winvm/vm-capabilities';

const read = defineCapability({
  id: 'system.info.get',
  name: '读系统信息',
  description: 't',
  risk: 'L0',
  idempotent: true,
  requiresSession: false,
  destructive: false,
  timeoutMs: 5000,
  input: { type: 'object', properties: { path: { type: 'string' } } },
  output: { type: 'object' },
  audit: { snapshot: 'none' },
  implementation: { kind: 'powershell', module: 'system', function: 'Get-SystemInfo' },
});

const write = defineCapability({
  id: 'storage.file.write',
  name: '写文件',
  description: 't',
  risk: 'L1',
  idempotent: true,
  requiresSession: false,
  destructive: false,
  timeoutMs: 5000,
  input: { type: 'object', properties: { path: { type: 'string' } } },
  output: { type: 'object' },
  audit: { snapshot: 'after' },
  implementation: { kind: 'powershell', module: 'storage', function: 'Write-TextFileContent' },
});

const del = defineCapability({
  id: 'storage.file.delete',
  name: '删除',
  description: 't',
  risk: 'L2',
  idempotent: false,
  requiresSession: false,
  destructive: true,
  timeoutMs: 5000,
  input: { type: 'object', properties: { path: { type: 'string' } } },
  output: { type: 'object' },
  audit: { snapshot: 'before-after' },
  implementation: { kind: 'powershell', module: 'storage', function: 'Remove-FileSystemItem' },
});

/**
 * ARCH-17（Phase 1 刻意的破坏性收紧）：默认路径白名单从「全体账户」收紧为「当前 VM 用户
 * 目录」（写法 `%USERPROFILE%\**`，由引擎在**模式侧**编译时展开）。模式表在构造时编译、
 * 展开读 `process.env` ⇒ 必须在**任何引擎构造之前**把 `USERPROFILE` 钉成确定值，
 * 本文件的断言才在 POSIX 开发机与 Windows 真机上得到**同一个**结论（不钉则 POSIX 上
 * 占位符保持字面 ⇒ 该条恒不匹配 ⇒ Users 路径一律 `pathAllowlist:miss`，红的是夹具前提
 * 而不是策略行为）。
 *
 * 钉死值 `C:\Users\vmuser` 即「当前用户」基准：本用户目录 ALLOW；
 * `C:\Users\<其他人>` 现在是跨账户 ⇒ DENY（旧夹具里的 `alice` 属于后者，故样例改基准账户）。
 */
process.env.USERPROFILE = 'C:\\Users\\vmuser';

function makeEngine() {
  const registry = new CapabilityRegistry();
  registry.registerAll([read, write, del]);
  return new CorePolicyEngine({ registry });
}

describe('策略引擎 · 路径黑名单（最高优先级）', () => {
  const engine = makeEngine();

  test('C:\\Windows 系统目录一律拒绝', () => {
    const v = engine.evaluate({
      capabilityId: 'storage.file.write',
      params: { path: 'C:\\Windows\\System32\\drivers\\etc\\hosts' },
      risk: 'L1',
      approved: false,
    });
    assert.equal(v.allowed, false);
    assert.match(v.matchedRule, /pathDenylist/);
  });

  test('Program Files 一律拒绝', () => {
    const v = engine.evaluate({
      capabilityId: 'storage.file.write',
      params: { path: 'C:\\Program Files\\App\\x.dll' },
      risk: 'L1',
      approved: false,
    });
    assert.equal(v.allowed, false);
  });

  test('黑名单优先于白名单：即使显式加入白名单也拒绝', () => {
    const custom = new CorePolicyEngine({
      config: { pathAllowlist: ['C:\\Windows\\**'] },
    });
    const v = custom.evaluate({
      capabilityId: 'storage.file.write',
      params: { path: 'C:\\Windows\\x.txt' },
      risk: 'L1',
      approved: false,
    });
    assert.equal(v.allowed, false, '黑名单优先级必须高于白名单');
    assert.match(v.matchedRule, /pathDenylist/);
  });
});

describe('策略引擎 · 路径白名单（拒绝优先）', () => {
  const engine = makeEngine();

  test('用户目录放行', () => {
    const v = engine.evaluate({
      capabilityId: 'storage.file.write',
      params: { path: 'C:\\Users\\vmuser\\notes.txt' },
      risk: 'L1',
      approved: false,
    });
    assert.equal(v.allowed, true, v.error?.message);
  });

  test('非白名单目录拒绝', () => {
    const v = engine.evaluate({
      capabilityId: 'storage.file.write',
      params: { path: 'E:\\Random\\x.txt' },
      risk: 'L1',
      approved: false,
    });
    assert.equal(v.allowed, false);
    assert.match(v.matchedRule, /pathAllowlist/);
  });

  test('UNC 路径拒绝', () => {
    const v = engine.evaluate({
      capabilityId: 'storage.file.write',
      params: { path: '\\\\server\\share\\x' },
      risk: 'L1',
      approved: false,
    });
    assert.equal(v.allowed, false);
  });
});

describe('策略引擎 · 命令黑名单', () => {
  const engine = makeEngine();

  test('格式化命令拒绝', () => {
    const v = engine.evaluate({
      capabilityId: 'storage.file.write',
      params: { command: 'Format-Volume -DriveLetter D' },
      risk: 'L1',
      approved: false,
    });
    assert.equal(v.allowed, false);
    assert.match(v.matchedRule, /commandDenylist/);
  });

  test('编码混淆命令拒绝（-EncodedCommand）', () => {
    const v = engine.evaluate({
      capabilityId: 'storage.file.write',
      params: { command: 'powershell -EncodedCommand SGVsbG8=' },
      risk: 'L1',
      approved: false,
    });
    assert.equal(v.allowed, false, 'Base64 混淆执行必须被拦截（绕过审计的典型手法）');
  });

  test('takeown 提权命令拒绝', () => {
    const v = engine.evaluate({
      capabilityId: 'storage.file.write',
      params: { command: 'takeown /f C:\\x' },
      risk: 'L1',
      approved: false,
    });
    assert.equal(v.allowed, false);
  });

  test('普通命令放行', () => {
    // 命令串里内嵌的路径同样要落在允许集合内（ARCH-17 收紧后 = 当前用户目录），
    // 故样例写基准账户而不是 `C:\\Users` 根 —— 后者现在是跨账户入口，白名单必然 miss。
    const v = engine.evaluate({
      capabilityId: 'storage.file.write',
      params: { command: 'Get-ChildItem C:\\Users\\vmuser\\Documents' },
      risk: 'L1',
      approved: false,
    });
    assert.equal(v.allowed, true, v.error?.message);
  });

  test('ARCH-17：跨账户目录不在默认白名单内 → 拒绝', () => {
    const v = engine.evaluate({
      capabilityId: 'storage.file.write',
      params: { path: 'C:\\Users\\other\\x.txt' },
      risk: 'L1',
      approved: false,
    });
    assert.equal(v.allowed, false, '默认白名单已收紧到当前用户目录，跨账户必须拒');
    assert.match(v.matchedRule, /pathAllowlist/);
  });
});

describe('策略引擎 · 风险分级与审批闸', () => {
  const engine = makeEngine();

  test('L2 未审批 → APPROVAL_REQUIRED（可重试）', () => {
    const v = engine.evaluate({
      capabilityId: 'storage.file.delete',
      params: { path: 'C:\\Users\\vmuser\\old' },
      risk: 'L2',
      approved: false,
    });
    assert.equal(v.allowed, false);
    assert.equal(v.requiresApproval, true);
    assert.equal(v.error?.code, 'APPROVAL_REQUIRED');
    assert.equal(v.error?.retryable, true);
  });

  test('L2 已审批 → 放行', () => {
    const v = engine.evaluate({
      capabilityId: 'storage.file.delete',
      params: { path: 'C:\\Users\\vmuser\\old' },
      risk: 'L2',
      approved: true,
    });
    assert.equal(v.allowed, true, v.error?.message);
  });

  test('超出本次 maxRisk → 拒绝（最小权限）', () => {
    const v = engine.evaluate({
      capabilityId: 'storage.file.delete',
      params: { path: 'C:\\Users\\vmuser\\old' },
      risk: 'L2',
      approved: true,
      maxRisk: 'L1',
    });
    assert.equal(v.allowed, false);
    assert.match(v.matchedRule, /maxRisk/);
  });

  test('L3 未审批 → APPROVAL_REQUIRED（高危操作不得"先斩后奏"）', () => {
    const v = engine.evaluate({
      capabilityId: 'system.info.get',
      params: {},
      risk: 'L3',
      approved: false,
    });
    assert.equal(v.allowed, false, 'L3 未审批绝不可执行');
    assert.equal(v.requiresApproval, true);
    assert.equal(v.error?.code, 'APPROVAL_REQUIRED');
  });

  test('L3 已审批 → 可执行（审批闸是唯一闸门，而非一律禁止）', () => {
    const v = engine.evaluate({
      capabilityId: 'system.info.get',
      params: {},
      risk: 'L3',
      approved: true,
    });
    assert.equal(v.allowed, true, v.error?.message);
  });

  test('L3 在显式 maxRisk=L1 的委派范围内 → 直接拒绝（审批也无用）', () => {
    const v = engine.evaluate({
      capabilityId: 'system.info.get',
      params: {},
      risk: 'L3',
      approved: true,
      maxRisk: 'L1',
    });
    assert.equal(v.allowed, false, '超出委派范围时，即使已审批也应拒绝');
    assert.match(v.matchedRule, /maxRisk/);
  });
});

describe('策略引擎 · 最小权限与未知能力', () => {
  const engine = makeEngine();

  test('不在 allowedCapabilities 范围内 → 拒绝', () => {
    const v = engine.evaluate({
      capabilityId: 'storage.file.delete',
      params: {},
      risk: 'L2',
      approved: true,
      allowedCapabilities: ['app.*'],
    });
    assert.equal(v.allowed, false);
    assert.match(v.matchedRule, /scope/);
  });

  test('在 allowedCapabilities 范围内 → 放行', () => {
    const v = engine.evaluate({
      capabilityId: 'storage.file.delete',
      params: {},
      risk: 'L2',
      approved: true,
      allowedCapabilities: ['storage.*'],
    });
    assert.equal(v.allowed, true, v.error?.message);
  });

  test('未注册能力 → UNKNOWN_CAPABILITY', () => {
    const v = engine.evaluate({
      capabilityId: 'system.nope.nope',
      params: {},
      risk: 'L0',
      approved: false,
    });
    assert.equal(v.allowed, false);
    assert.equal(v.error?.code, 'UNKNOWN_CAPABILITY');
  });
});

describe('策略引擎 · 注册表范围', () => {
  const engine = makeEngine();

  test('HKCU 可写放行', () => {
    const v = engine.evaluate({
      capabilityId: 'system.info.get',
      params: { path: 'HKCU:\\Software\\MyApp' },
      risk: 'L0',
      approved: false,
    });
    assert.equal(v.allowed, true, v.error?.message);
  });

  test('HKLM\\SYSTEM 拒绝（写）', () => {
    const v = engine.evaluate({
      capabilityId: 'system.info.get',
      params: { path: 'HKLM:\\SYSTEM\\CurrentControlSet' },
      risk: 'L2',
      approved: true,
    });
    assert.equal(v.allowed, false);
  });
});

describe('ARCH-17 · 模式侧 %ENV% 展开（能力级白名单附带缺陷修复）', () => {
  /**
   * 用**真实注册表**（而非夹具）钉这条：`appops.cli.invoke` 的能力级 `pathAllowlist`
   * 里写着 `%USERPROFILE%\WinVMWorkspace\out`。旧实现模式侧不展开 ⇒ 该条**恒不匹配**，
   * 只是碰巧被默认表的全体账户条目兜住所以没显形；默认表收紧后若展开不到位，
   * 合法生产输出目录会被误拒 —— 即「收紧默认值」与「模式侧展开」必须同批到位。
   * `process.env.USERPROFILE` 已在本文件顶部钉成 `C:\Users\vmuser`。
   */
  const engine = (() => {
    const registry = new CapabilityRegistry();
    registry.registerAll(WINDOWS_CAPABILITIES);
    return new CorePolicyEngine({ registry });
  })();

  const cliInvoke = WINDOWS_CAPABILITIES.find((c) => c.id === 'appops.cli.invoke');

  test('真实 appops.cli.invoke 的 outputDir（当前用户目录）命中能力级 %USERPROFILE% 白名单', () => {
    assert.ok(cliInvoke?.policy?.pathAllowlist?.some((p) => p.includes('%USERPROFILE%')),
      '前提校验：真实能力声明里确有 %USERPROFILE% 形态的白名单条目');
    const v = engine.evaluate({
      capabilityId: 'appops.cli.invoke',
      params: { app: 'node', command: 'node build.js', outputDir: 'C:\\Users\\vmuser\\WinVMWorkspace\\out' },
      risk: 'L1',
      approved: false,
      capabilityPolicy: cliInvoke.policy,
    });
    assert.equal(v.allowed, true, `模式侧展开失效会误杀合法生产目录：${v.matchedRule} / ${v.error?.message ?? ''}`);
  });

  test('同能力跨账户 outputDir 拒绝（收紧后不再由默认表兜住）', () => {
    const v = engine.evaluate({
      capabilityId: 'appops.cli.invoke',
      params: { app: 'node', command: 'node build.js', outputDir: 'C:\\Users\\other\\WinVMWorkspace\\out' },
      risk: 'L1',
      approved: false,
      capabilityPolicy: cliInvoke.policy,
    });
    assert.equal(v.allowed, false);
    assert.match(v.matchedRule, /pathAllowlist/);
  });
});

describe('风险模型', () => {
  test('L2/L3 默认需审批', async () => {
    const { requiresApprovalByDefault, riskAtLeast, parseRiskLevel } = await import('@winvm/contracts');
    assert.equal(requiresApprovalByDefault('L0'), false);
    assert.equal(requiresApprovalByDefault('L1'), false);
    assert.equal(requiresApprovalByDefault('L2'), true);
    assert.equal(requiresApprovalByDefault('L3'), true);
    assert.equal(riskAtLeast('L3', 'L2'), true);
    assert.equal(riskAtLeast('L1', 'L2'), false);
    assert.equal(parseRiskLevel('l2'), 'L2');
  });
});

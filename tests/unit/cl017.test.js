/**
 * CL-017 缺陷修复单元测试（锁住关键回归点）
 *
 * 覆盖：
 *   D9  注册表路径缺冒号形式（HKLM\...）→ 自动补冒号并可读
 *   D11 dry-run 免审批（L3 先 dry-run 再确认），且 dry-run 不绕过路径黑名单
 *   D14 生产工作目录 C:\WinVMWorkspace\** 白名单存在且可读写（部署漂移锁定）
 *   D5  meta.health.check 改由 Node 侧内置（__meta.healthCheck）
 *   D10 列表类能力带 output.array 标记（provider 据此强制保形为数组）
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { CorePolicyEngine, DEFAULT_POLICY, looksLikeRegistryPath, normalizeRegistryPath } from '@winvm/core';
import { WINDOWS_CAPABILITIES } from '@winvm/vm-capabilities';

const engine = () => new CorePolicyEngine();
const byId = (id) => WINDOWS_CAPABILITIES.find((c) => c.id === id);

describe('CL-017 D9 · 注册表路径归一化', () => {
  // R19-B · S-1（契约 docs/design/r19b-s1-kn2-contract.md §2.2 B2-2）：
  // 权威归一形态 = **根键大写短名 + 冒号 + 键名段小写 + 无尾分隔符**（`HKLM:\software\…`）。
  // 键名段折叠为小写使归一成为**幂等全函数**，白名单比对据此改为**大小写敏感**
  // （`matchRegistryAllowlist`）。原 4 条断言写的是「保留用户大小写」的过渡形态，
  // 若沿用会让「`HKLM:\SOFTWARE` ≡ `hklm\software`」这条等价关系只靠 `/i` 标志维持 ——
  // 而 D9 的诉求本来就是**写法不影响成败**，把等价性显式落在归一结果上更可审计。
  // ⚠ 生效前提：`@winvm/core` 需已重建 dist（旧 dist 仍返回大小写保留形态 ⇒ 本组断言失败）。
  test('HKLM\\ 无冒号形式被识别，并归一为权威形态（根键大写 + 键名段小写）', () => {
    assert.ok(looksLikeRegistryPath('HKLM\\SOFTWARE\\Microsoft'), '无冒号也应按注册表路径识别');
    assert.equal(normalizeRegistryPath('HKLM\\SOFTWARE\\Microsoft'), 'HKLM:\\software\\microsoft');
    assert.equal(normalizeRegistryPath('HKLM:\\SOFTWARE'), 'HKLM:\\software', '冒号形态与无冒号形态归一到同一串（D9 等价性）');
    assert.equal(normalizeRegistryPath('HKCU\\Software'), 'HKCU:\\software');
    // 幂等 + 无 `::`（契约 §5 A4）：裸根键四种写法全部收敛为 `HKLM:`，二次归一不变
    for (const bare of ['HKLM:', 'HKLM:\\', 'HKLM\\', 'hklm']) {
      assert.equal(normalizeRegistryPath(bare), 'HKLM:', `裸根键 ${JSON.stringify(bare)} 应归一为 HKLM:`);
      assert.equal(normalizeRegistryPath(normalizeRegistryPath(bare)), 'HKLM:', '归一必须幂等');
    }
  });

  test('读注册表：HKLM\\SOFTWARE（无冒号）放行；HKLM\\SYSTEM 拒绝', () => {
    const e = engine();
    const ok = e.evaluate({
      capabilityId: 'system.registry.read',
      params: { path: 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion', name: 'ProductName' },
      risk: 'L0',
      approved: false,
    });
    assert.equal(ok.allowed, true, ok.error?.message);

    const denied = e.evaluate({
      capabilityId: 'system.registry.read',
      params: { path: 'HKLM\\SYSTEM\\CurrentControlSet' },
      risk: 'L0',
      approved: false,
    });
    assert.equal(denied.allowed, false, 'HKLM\\SYSTEM 不在读白名单内，应拒绝');
  });
});

describe('CL-017 D11 · dry-run 免审批', () => {
  test('L3 system.power.control {dryRun:true} 免审批放行', () => {
    const e = engine();
    const r = e.evaluate({
      capabilityId: 'system.power.control',
      params: { action: 'restart', dryRun: true },
      risk: 'L3',
      approved: false,
    });
    assert.equal(r.allowed, true, r.error?.message);
    assert.equal(r.requiresApproval, false);
  });

  test('L3 system.power.control 无 dryRun → APPROVAL_REQUIRED', () => {
    const e = engine();
    const r = e.evaluate({
      capabilityId: 'system.power.control',
      params: { action: 'restart' },
      risk: 'L3',
      approved: false,
    });
    assert.equal(r.allowed, false);
    assert.equal(r.requiresApproval, true);
  });

  test('dry-run 不能绕过路径黑名单', () => {
    const e = engine();
    const r = e.evaluate({
      capabilityId: 'storage.file.delete',
      params: { path: 'C:\\Windows\\System32\\x.dll', permanent: true, dryRun: true },
      risk: 'L2',
      approved: false,
    });
    assert.equal(r.allowed, false, 'dry-run 仍须受路径黑名单约束');
  });
});

describe('CL-017 D14 · 生产工作目录白名单（部署漂移锁定）', () => {
  test('DEFAULT_POLICY.pathAllowlist 含 C:\\WinVMWorkspace\\**', () => {
    assert.ok(
      DEFAULT_POLICY.pathAllowlist.includes('C:\\WinVMWorkspace\\**'),
      '缺少该条目会导致生产工作目录全域被拒（CL-017 D14）',
    );
  });

  test('C:\\WinVMWorkspace\\** 读写放行', () => {
    const e = engine();
    const mk = e.evaluate({
      capabilityId: 'storage.dir.manage',
      params: { path: 'C:\\WinVMWorkspace\\out' },
      risk: 'L1',
      approved: false,
    });
    assert.equal(mk.allowed, true, mk.error?.message);

    const wr = e.evaluate({
      capabilityId: 'storage.file.write',
      params: { path: 'C:\\WinVMWorkspace\\out\\a.txt', content: 'hello' },
      risk: 'L1',
      approved: false,
    });
    assert.equal(wr.allowed, true, wr.error?.message);
  });

  test('C:\\Windows\\** 仍在黑名单（不得为跑通而放宽）', () => {
    const e = engine();
    const r = e.evaluate({
      capabilityId: 'storage.file.write',
      params: { path: 'C:\\Windows\\Temp\\a.txt', content: 'x' },
      risk: 'L1',
      approved: false,
    });
    assert.equal(r.allowed, false);
  });
});

describe('CL-017 D5/D10 · 能力定义', () => {
  test('meta.health.check 绑定 Node 侧 __meta.healthCheck', () => {
    const c = byId('meta.health.check');
    assert.ok(c, 'meta.health.check 应存在');
    assert.equal(c.implementation.module, '__meta');
    assert.equal(c.implementation.function, 'healthCheck');
  });

  test('列表类能力带 output.array 标记', () => {
    const listCaps = [
      'system.service.list',
      'system.process.list',
      'system.task.scheduled',
      'system.user.manage',
      'system.eventlog.query',
      'app.inventory.list',
      'app.winget.search',
      'app.appx.manage',
      'storage.search.query',
      'gui.window.list',
    ];
    for (const id of listCaps) {
      assert.equal(byId(id)?.output?.array, true, `${id} 应带 output.array 标记`);
    }
  });

  test('对象类能力不带 array 标记', () => {
    for (const id of ['system.info.get', 'meta.health.check', 'storage.disk.list', 'gui.uia.tree']) {
      assert.notEqual(byId(id)?.output?.array, true, `${id} 不应带 output.array`);
    }
  });
});

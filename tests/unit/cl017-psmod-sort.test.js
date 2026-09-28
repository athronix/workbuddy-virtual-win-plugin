/**
 * CL-017 N1/N2 回归锁定 —— PS 5.1 `Sort-Object -Property <键>` 在 [ordered]@{} 列表上静默失效
 *
 * 背景（真机实测，静默错数据，比崩溃更危险）：
 *   PS 5.1 对 [ordered]@{}（OrderedDictionary）列表用 `Sort-Object -Property <键>` 时，键解析
 *   **失败也不报错**：
 *     · 不带 -Unique → 退化为「不排序」（Top-N 抓到的是 sizeMB=0 的链接/空目录）；
 *     · 带 -Unique  → 所有条目被判定为相等而**塌缩成 1 条**（app.inventory.list 真机 19 → 1）。
 *   修法：一律改用脚本块访问器 `{ $_.<键> }`（数值键用 `[double]` 强转）——
 *     真机对照：`-Property sizeMB -Descending` → [3,9,5]；`-Property { [double]$_.sizeMB }` → [9,5,3]。
 *
 * 本测试为**静态源码守卫**：本仓库的 `node --test` 运行环境没有 PowerShell，无法真跑 psmod；
 *   故锁死「psmod 内不得再出现对字典列表的裸键排序」这一不变量。
 *   运行时行为（条数与 Top-N 单调性）已在 VM 真机验收（见交付回报 T1/T2/T3）。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const PSMOD = join(import.meta.dirname, '..', '..', 'packages', 'vm-capabilities', 'psmod');
const read = (f) => readFileSync(join(PSMOD, f), 'utf8');
const PSMOD_FILES = ['app.ps1', 'appops.ps1', 'gui.ps1', 'ps-bridge.ps1', 'storage.ps1', 'system.ps1'];

/**
 * 文档化例外：对「具有真实属性的对象」（FileInfo 等）按真实属性排序是安全的。
 * 仅 `storage.ps1` 的 `-Property Length`（Get-ChildItem FileInfo）在列，真机实测严格降序。
 */
const ALLOWED_BARE_KEYS = new Set(['storage.ps1::Length']);

/** 抽取所有 `Sort-Object -Property <token>` 的 token（`{` 表示脚本块访问器） */
function sortPropertyTokens(src) {
  const re = /Sort-Object\s+-Property\s+([^\s|;)]+)/g;
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

describe('CL-017 N1/N2 · psmod Sort-Object 裸键陷阱守卫', () => {
  test('psmod 内所有 Sort-Object 均走 -Property（无位置参数裸键形式）', () => {
    for (const f of PSMOD_FILES) {
      const src = read(f);
      const withoutProperty = src.replace(/Sort-Object\s+-Property/g, '');
      assert.ok(
        !/Sort-Object\b/.test(withoutProperty),
        `${f}: 存在 Sort-Object 位置参数裸键形式，字典列表上会静默失效 —— 请改用 -Property { $_.<键> }`,
      );
    }
  });

  test('psmod 内 Sort-Object -Property 一律用脚本块访问器（除文档化例外）', () => {
    for (const f of PSMOD_FILES) {
      for (const tok of sortPropertyTokens(read(f))) {
        const isScriptBlock = tok.startsWith('{');
        const allowed = ALLOWED_BARE_KEYS.has(`${f}::${tok}`);
        assert.ok(
          isScriptBlock || allowed,
          `${f}: Sort-Object -Property ${tok} —— 裸键形式对 [ordered]@{} 会静默不排序/塌缩，请改为 { $_.${tok} }`,
        );
      }
    }
  });

  test('N1 · app.inventory.list 按 (name,version) 分组合并（不得按 name 去重塌缩）', () => {
    const src = read('app.ps1');
    assert.ok(
      !src.includes('Sort-Object -Property name -Unique'),
      'app.ps1 不得回退到 `-Property name -Unique`（N1 回归）',
    );
    // CL-018 C6：合并键改为 (name,version)，**不得**再按 name 去重（否则误删同名异版本）
    assert.ok(
      !src.includes('Sort-Object -Property { $_.name } -Unique'),
      'app.ps1 不得按 name 去重（CL-018 C6：同名异版本须保留两条）',
    );
    assert.ok(
      src.includes('registryKeyCount'),
      'app.ps1 应实现 (name,version) 合并并输出 registryKeyCount（CL-018 C6）',
    );
  });

  test('N2 · storage.space.analyze 的 Top-N 使用脚本块 + [double] 强转（单调降序）', () => {
    const src = read('storage.ps1');
    assert.ok(
      src.includes('Sort-Object -Property { [double]$_.sizeMB } -Descending'),
      'storage.ps1 应按 { [double]$_.sizeMB } 降序（裸键 sizeMB 会静默不排序）',
    );
    assert.ok(
      !src.includes('Sort-Object -Property sizeMB -Descending'),
      'storage.ps1 不得回退到 `-Property sizeMB -Descending`（N2 回归）',
    );
  });

  test('N2 同类 · system.process.list 的 Top-N 使用脚本块 + [double] 强转（单调降序）', () => {
    const src = read('system.ps1');
    assert.ok(
      src.includes('Sort-Object -Property { [double]$_.workingSetMB } -Descending'),
      'system.ps1 应按 { [double]$_.workingSetMB } 降序（裸键 workingSetMB 会静默不排序）',
    );
    assert.ok(
      !src.includes('Sort-Object -Property workingSetMB -Descending'),
      'system.ps1 不得回退到 `-Property workingSetMB -Descending`（N2 同类回归）',
    );
  });

  test('三处修复旁均留有「PS 5.1 静默失效」成因注释，防止被改回', () => {
    assert.ok(read('app.ps1').includes('CL-017 N1'), 'app.ps1 修复旁应注明 N1 成因');
    assert.ok(read('storage.ps1').includes('CL-017 N2'), 'storage.ps1 修复旁应注明 N2 成因');
    assert.ok(read('system.ps1').includes('CL-017 N2'), 'system.ps1 修复旁应注明 N2 同类成因');
  });
});

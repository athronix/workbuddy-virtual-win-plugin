/**
 * R19-B · S-1 单元测试：注册表路径**形态归一化**与**判定/回显一致性**
 *
 * 权威契约：`docs/design/r19b-s1-kn2-contract.md`（§1 B1 根因、§2 B2 归一权威、§3 B3 回显、
 * §5 交叉核对清单 A1–A4）。真机缺陷来源：`docs/archive/test/reports/real-test-2026-09-30-r19.md`
 * §5「S-1」行、§7 L6、§6 R-7、§3 E2「子步 BLOCKED」。
 *
 * 真机症状（本文件逐条封堵）：
 *   `system.registry.read path="HKLM\SOFTWARE\…"` → **ok:true**（`e2-reg-probe1`）
 *   `system.registry.read path="HKLM:\SOFTWARE\…"` → **POLICY_DENIED**，
 *     错误体里的路径是伪盘符 `M:\SOFTWARE\…`、`matchedRule=pathAllowlist:miss`（`e2-msi-verify`）
 *   ⇒ 同一能力两种写法一成一败，且失败归属**错到了文件系统域**，用户据此误判「键不存在」。
 *
 * 运行：node --test tests/unit/r19b-s1-registry-forms.test.js
 * ⚠ 依赖 `@winvm/core` 的**已重建 dist**（旧 dist 未含 canonicalRegistryPath ⇒ 首个用例即失败，
 *    那是构建未刷新，不是修复失效）。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  CorePolicyEngine,
  DEFAULT_POLICY,
  canonicalRegistryPath,
  normalizeRegistryPath,
  matchRegistryAllowlist,
  describeRegistryForms,
  extractPathTokens,
  looksLikeRegistryPath,
  globToRegex,
} from '@winvm/core';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
/** 读源码文本（静态守卫用；不经 dist，避免「测的是编译产物」的间接性） */
const src = (rel) => readFileSync(resolve(repoRoot, rel), 'utf8');

const engine = () => new CorePolicyEngine();
/** 真机 `e2-reg-probe1` / `e2-msi-verify` 用的同一条键（GitHub CLI 的 MSI 卸载键） */
const CLI_KEY_TAIL = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{94DF76B2-B5BE-4F59-9D1D-F76DC0F29ABF}';
const READ_FORMS = {
  noColon: `HKLM\\${CLI_KEY_TAIL}`,
  psProvider: `HKLM:\\${CLI_KEY_TAIL}`,
};

const readReq = (path) => ({
  capabilityId: 'system.registry.read',
  params: { path },
  risk: 'L0',
  approved: false,
});
const writeReq = (path) => ({
  capabilityId: 'system.registry.write',
  params: { path },
  risk: 'L2',
  approved: true,
});

/* ------------------------- 契约 §1.2 B1：采集层正则 ------------------------- */

describe('S-1 · B1 根因 A — extractPathTokens 不得把根键尾字母当盘符', () => {
  test('HKLM:\\SOFTWARE\\Microsoft 只产出一个 token，且不含任何 M:\\ 伪盘符', () => {
    const tokens = extractPathTokens('HKLM:\\SOFTWARE\\Microsoft');
    assert.deepEqual(tokens, ['HKLM:\\SOFTWARE\\Microsoft'], '旧实现会切出 M:\\SOFTWARE\\Microsoft（真机 e2-msi-verify 的错误体路径即此形态）');
    assert.ok(
      !tokens.some((t) => /^[A-Za-z]:\\SOFTWARE/.test(t) && !looksLikeRegistryPath(t)),
      `不得出现伪盘符 token：${JSON.stringify(tokens)}`,
    );
  });

  test('命令串内混排的注册表路径与真实盘符各自正确捕获', () => {
    const tokens = extractPathTokens('Get-ItemProperty HKLM:\\SOFTWARE\\X Remove-Item C:\\Temp\\a');
    assert.ok(tokens.includes('HKLM:\\SOFTWARE\\X'), '注册表路径整体捕获');
    assert.ok(tokens.includes('C:\\Temp\\a'), '真实盘符路径不得因新增左断言而漏捕');
    assert.ok(!tokens.some((t) => /^M:/i.test(t)), 'M: 伪盘符零出现');
    // 左断言的边界：盘符前邻必须不是标识符字符，故 `X:` 前是字母/数字/下划线的串一律不当盘符
    assert.deepEqual(extractPathTokens('AbC:\\Temp\\x'), [], '前邻为字母 ⇒ 不识别为盘符（HKLM: 类误切的同一机理）');
  });

  test('HKCU:/HKEY_LOCAL_MACHINE: 形态同样不被切碎（左断言只认字母数字下划线为前邻）', () => {
    assert.deepEqual(extractPathTokens('HKCU:\\Software\\Foo'), ['HKCU:\\Software\\Foo']);
    assert.deepEqual(extractPathTokens('HKEY_LOCAL_MACHINE:\\SOFTWARE\\Foo'), ['HKEY_LOCAL_MACHINE:\\SOFTWARE\\Foo']);
    // 前邻为非标识符字符（= / 空格 / 引号）时盘符仍应命中
    assert.deepEqual(extractPathTokens('"-Path D:\\Data\\x"'), ['D:\\Data\\x']);
  });
});

/* ------------------------- 契约 §2.1 B2-1：别名表恰 4 条 ------------------------- */

describe('S-1 · B2-1 归一权威 — 根键别名表恰 4 条且为大小写敏感查表', () => {
  test('源码里 REG_CANON 恰 4 条，仅 HKLM/HKCU 长短写法，无 HKU/HKCR/HKCC', () => {
    const engineSrc = src('packages/core/src/policy/engine.ts');
    const block = /const REG_CANON: readonly \[string, string\]\[\] = \[([\s\S]*?)\n\];/.exec(engineSrc);
    assert.ok(block, 'engine.ts 必须存在 REG_CANON 表');
    const entries = [...block[1].matchAll(/\[\s*'([^']+)'\s*,\s*'([^']+)'\s*\]/g)];
    assert.equal(entries.length, 4, `别名表必须恰 4 条（契约 B2-1），实得 ${entries.length}：${entries.map((e) => e[1]).join(',')}`);
    assert.deepEqual(
      entries.map((e) => e[1]).sort().join(','),
      ['HKLM', 'HKCU', 'HKEY_LOCAL_MACHINE', 'HKEY_CURRENT_USER'].sort().join(','),
      '准入集合封闭：HKLM/HKCU 的长短写法各 2 条',
    );
    assert.deepEqual(
      [...new Set(entries.map((e) => e[2]))].sort().join(','),
      ['HKCU:', 'HKLM:'].sort().join(','),
      '映射值只能是 HKCU:/HKLM: 两个 PS 驱动器名',
    );
    // 大小写敏感查表：表体是字符串等值比对，不得出现 /i 正则表
    assert.ok(!/const REG_CANON[\s\S]{0,400}?\/i/.test(block[1]), '别名表不得用带 i 标志的正则（命中集合必须可穷举审计）');
    assert.ok(!/HKU|HKCR|HKCC|HKEY_USERS|HKEY_CLASSES_ROOT|HKEY_CURRENT_CONFIG/.test(block[1]), 'HKU/HKCR/HKCC 绝不进准入清单（契约 §2.1 第 2/3 点）');
  });

  test('交叉核对 A1：表条数与文档口径一致（契约文档声明恰 4 条）', () => {
    const contract = src('docs/design/r19b-s1-kn2-contract.md');
    assert.match(contract, /B2-1[\s\S]{0,80}恰 4 条/, '契约 §2.1 标题须声明「恰 4 条」');
    assert.match(contract, /\['HKEY_LOCAL_MACHINE', 'HKLM:'\]/, '契约须给出与实现逐字一致的表体（交叉核对 A1）');
    assert.match(contract, /\['HKCU', 'HKCU:'\]/, '短形两条同样须在契约中可见');
  });
});

/* ------------------------- 契约 §2.2 B2-2：形态与敏感比对 ------------------------- */

describe('S-1 · B2-2 权威形态 — 根键大写 + 冒号 + 键名段小写 + 无尾分隔符', () => {
  test('等价写法收敛到同一权威串', () => {
    const want = 'HKLM:\\software\\microsoft';
    for (const form of [
      'HKLM:\\SOFTWARE\\Microsoft',
      'HKLM\\SOFTWARE\\Microsoft',
      'hklm\\software\\microsoft',
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft',
      'HKEY_LOCAL_MACHINE/SOFTWARE/Microsoft',
      'hklm:/SOFTWARE//Microsoft',
    ]) {
      assert.equal(canonicalRegistryPath(form), want, `形态 ${JSON.stringify(form)} 必须归一到 ${want}`);
    }
  });

  test('交叉核对 A4：裸根键四写法 → HKLM:，无 HKLM::，且归一幂等', () => {
    for (const bare of ['HKLM:', 'HKLM:\\', 'HKLM\\', 'hklm', 'HKEY_LOCAL_MACHINE', 'HKEY_LOCAL_MACHINE:\\']) {
      const c = canonicalRegistryPath(bare);
      assert.equal(c, 'HKLM:', `裸根键 ${JSON.stringify(bare)} → ${JSON.stringify(c)}（期望 HKLM:）`);
      assert.ok(!c.includes('::'), '绝不得产出 HKLM:: 双冒符（曾出现的实现缺陷）');
    }
    for (const p of ['HKLM:\\SOFTWARE\\X', 'HKEY_CURRENT_USER\\Software\\Foo', 'HKCU:', 'C:\\Windows']) {
      assert.equal(canonicalRegistryPath(canonicalRegistryPath(p)), canonicalRegistryPath(p), `归一必须幂等：${p}`);
    }
  });

  test('normalizeRegistryPath 是 canonicalRegistryPath 的等价别名（D9 历史调用点不断链）', () => {
    for (const p of ['HKLM\\SOFTWARE\\A', 'HKCR\\txtfile', 'C:\\Windows', 'HKLM:']) {
      assert.equal(normalizeRegistryPath(p), canonicalRegistryPath(p));
    }
  });

  test('matchRegistryAllowlist 为大小写敏感比对（键名段已折叠 ⇒ 等价性落在归一而非 /i）', () => {
    const read = DEFAULT_POLICY.registryReadAllowlist;
    // 敏感实现的正向证据：归一后的串匹配；未经归一的「混合大小写原样串」直接喂 regex 应不匹配
    const reSensitive = globToRegex('HKLM:\\SOFTWARE\\**', true);
    assert.equal(reSensitive.test('HKLM:\\software\\microsoft'), false, '敏感 regex 必须不匹配小写键名（证明匹配域真的敏感）');
    assert.equal(globToRegex('HKLM:\\SOFTWARE\\**', true).test('HKLM:\\SOFTWARE\\x'), true, '敏感 regex 匹配同形态');
    assert.equal(globToRegex('HKLM:\\SOFTWARE\\**').flags.includes('i'), true, '默认参仍是不敏感（文件系统域零改动，契约 §2.2）');
    // 白名单条目与入参双侧归一 ⇒ 等价写法同结论
    assert.equal(matchRegistryAllowlist('HKLM:\\SOFTWARE\\X', read), true);
    assert.equal(matchRegistryAllowlist('HKEY_LOCAL_MACHINE\\Software\\X', read), true);
    assert.equal(matchRegistryAllowlist('hklm\\software\\x', read), true);
  });

  test('文件系统白名单匹配仍大小写不敏感（敏感化只开注册表域）', () => {
    const e = engine();
    const lower = e.evaluate({
      capabilityId: 'storage.file.read',
      params: { path: 'c:\\program files (x86)\\foo\\bar.exe' },
      risk: 'L0',
      approved: false,
    });
    assert.equal(lower.allowed, false);
    assert.match(lower.matchedRule, /^pathDenylist:/, `文件系统黑名单须命中且保持大小写不敏感：${lower.matchedRule}`);
    assert.match(lower.matchedRule, /Program/, '命中的应正是 Program Files (x86) 条目（混合大小写模式 + 小写输入）');
  });
});

/* ------------------------- 契约 §5 A3：形态矩阵（≥7 形态） ------------------------- */

describe('S-1 · 交叉核对 A3 — 形态矩阵：归一 ≠ 放行', () => {
  const e = engine();
  /** 期望：[形态, allowed, matchedRule 域] */
  const matrix = [
    ['HKLM\\SOFTWARE\\Microsoft（无冒号 · 真机 ok:true 那条）', true, 'allow:policy-passed'],
    ['HKLM:\\SOFTWARE\\Microsoft（PS provider · 真机 POLICY_DENIED 那条）', true, 'allow:policy-passed'],
    ['HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft（Win32 长全称）', true, 'allow:policy-passed'],
    ['hklm:\\Software\\Foo（小写根键 + 混合键名）', true, 'allow:policy-passed'],
    ['HKCU:\\Software\\Foo（HKCU 全子树可读）', true, 'allow:policy-passed'],
    ['HKLM:\\SYSTEM\\CurrentControlSet（不在读范围）', false, 'registryReadAllowlist:miss'],
    ['HKCR:\\txtfile（合并视图 · 绝不放行）', false, 'registryReadAllowlist:miss'],
    ['HKCC:\\Control（不在准入清单）', false, 'registryReadAllowlist:miss'],
    ['HKU:\\S-1-5-21（含 .DEFAULT = SYSTEM 配置单元）', false, 'registryReadAllowlist:miss'],
    ['HKEY_USERS\\.DEFAULT（长全称同样拒）', false, 'registryReadAllowlist:miss'],
  ];
  assert.ok(matrix.length >= 7, '形态矩阵须 ≥7 条（契约 §5 A3）');

  for (const [form, allowed, rule] of matrix) {
    const path = form.replace(/^（.*$/, '').replace(/（.*$/, '').trim();
    test(`${allowed ? 'ALLOW' : 'DENY'} — ${form}`, () => {
      const v = e.evaluate(readReq(path));
      assert.equal(v.allowed, allowed, `${path} → ${JSON.stringify({ allowed: v.allowed, matchedRule: v.matchedRule, msg: v.error?.message })}`);
      assert.equal(v.matchedRule, rule);
      // 关键归属断言（真机症状复发判据）：注册表形态绝不再撞文件系统白名单
      assert.notEqual(v.matchedRule, 'pathAllowlist:miss', 'S-1 的错误归属：注册表形态不得落到 pathAllowlist:miss');
    });
  }

  test('两形态判定等价且归一后同串（一成一败即判失败）', () => {
    const a = e.evaluate(readReq(READ_FORMS.noColon));
    const b = e.evaluate(readReq(READ_FORMS.psProvider));
    assert.equal(a.allowed, b.allowed, '同一物理键的两种写法必须同结论');
    assert.equal(canonicalRegistryPath(READ_FORMS.noColon), canonicalRegistryPath(READ_FORMS.psProvider));
  });
});

/* ------------------------- 契约 §3 B3：错误回显形态 ------------------------- */

describe('S-1 · B3 回显 — details.path 为权威形态，错误体给出可用形态提示', () => {
  test('拒绝回显路径 = 权威归一形态（小写键名段），且不再是伪盘符', () => {
    const v = engine().evaluate(readReq('HKLM:\\SYSTEM\\CurrentControlSet'));
    assert.equal(v.allowed, false);
    assert.equal(v.error.details.path, 'HKLM:\\system\\currentcontrolset');
    assert.ok(!/[A-Za-z]:\\SYSTEM/.test(v.error.details.path), '错误体绝不得出现 M:\\ 一类伪盘符');
    assert.equal(v.error.details.inputPath, 'HKLM:\\SYSTEM\\CurrentControlSet', '原样入参保留供诊断');
    assert.equal(v.error.details.mode, 'read');
    assert.ok(Array.isArray(v.error.details.allowed) && v.error.details.allowed.length > 0, 'allowed 须回显白名单条目');
  });

  test('message 与 details.path 同形态，且含原样入参', () => {
    const v = engine().evaluate(readReq('HKU:\\S-1-5-21'));
    const canon = canonicalRegistryPath('HKU:\\S-1-5-21');
    assert.ok(v.error.message.includes(canon), `message 须回显权威形态 ${canon}：${v.error.message}`);
    assert.ok(v.error.message.includes('原样入参'), 'message 须同时给出原样入参');
  });

  test('details.forms 存在且给出现代可用写法（调用方一次自纠）', () => {
    const v = engine().evaluate(readReq('HKLM:\\SYSTEM\\Foo'));
    const forms = v.error.details.forms;
    assert.equal(typeof forms, 'string', '错误体必须带 forms 提示（报告建议「给出可用形态」，契约定稿两者都做）');
    assert.match(forms, /HKLM:\\/);
    assert.match(forms, /HKEY_LOCAL_MACHINE/);
    assert.match(forms, /等价互认/);
    assert.match(forms, /HKCU:\\\*\*/, '读取范围须如实说明');
  });

  test('交叉核对 A2：错误提示不得把用户往回退到旧写法', () => {
    for (const path of ['HKLM:\\SYSTEM\\Foo', 'HKCR:\\txtfile', 'HKU:\\S-1-5-19']) {
      const forms = describeRegistryForms(path);
      assert.ok(!/请改用无冒号|改用无冒号反斜杠形态/.test(forms), `forms 提示不得建议回退旧写法：${forms}`);
    }
    // 非准入根键的提示必须明说「不在准入清单」，不得暗示其形态可用
    const hkcr = describeRegistryForms('HKCR:\\txtfile');
    assert.match(hkcr, /不在归一准入清单/, 'HKCR 提示须说明根键不被准入（否则用户以为换写法即可）');
  });

  test('交叉核对 A2：全仓无「回退旧写法」文案残留', () => {
    const engineSrc = src('packages/core/src/policy/engine.ts');
    assert.ok(!/请改用无冒号反斜杠形态/.test(engineSrc), 'engine.ts 不得残留回退旧写法的文案');
    const psSrc = src('packages/vm-capabilities/psmod/system.ps1');
    assert.ok(
      !/HKEY_LOCAL_MACHINE'?\s*=|canon\[|\$canon/.test(psSrc),
      'system.ps1 不得出现第二份别名映射表（归一职责唯一在策略层，契约 §2.2）',
    );
    // ⚠ 契约 §5 A2 原文要求「双端同样宽松」也零命中，与 §2.2「system.ps1 恢复原状（零改动）」
    //    直接冲突（该短语位于 HEAD 的 D9 注释里）。本用例按**较小解释**执行：只清除
    //    真正误导性的回退建议文案，注释保留（其陈述在修复后依然成立：psmod 补冒号、策略归一，
    //    两端都宽松）。冲突已登记为契约缺陷 OQ-3（契约文档 §7），待 architect 定稿，不自行改注释。
  });

  test('交叉核对 A5：system.ps1 的 ConvertTo-RegistryPath 与 HEAD 语义一致（零改动守卫）', () => {
    const psSrc = src('packages/vm-capabilities/psmod/system.ps1');
    const fn = /function ConvertTo-RegistryPath \{([\s\S]*?)\n\}/.exec(psSrc);
    assert.ok(fn, 'ConvertTo-RegistryPath 必须存在');
    assert.match(fn[1], /\(\?!:\)/, '保持 D9 原实现：仅对无冒号形态补冒号');
    assert.ok(!/ToLower\(\)|ToUpperInvariant/.test(fn[1]), 'psmod 侧不得做大小写折叠（权威在策略层）');
    assert.ok(!/@\{/.test(fn[1]), 'psmod 侧不得出现 hashtable 映射表（双实现即契约违背）');
    assert.ok(!/'HKLM:'|'HKCU:'/.test(fn[1]), 'psmod 侧不得内建驱动器短名映射值');
  });

  test('白名单「含自身」语义：HKLM:\\SOFTWARE 子树根本身可读（与文件系统惯例一致）', () => {
    // `HKLM:\SOFTWARE\**` 表意包含 `HKLM:\SOFTWARE` 这个键本身；常规 glob 不匹配无尾分隔符串，
    // matchRegistryAllowlist 补一次「带尾分隔符」重试（只放宽到表意本身包含的那一个键，不放宽其它层级）。
    const e = engine();
    for (const p of ['HKLM:\\SOFTWARE', 'HKLM\\SOFTWARE', 'HKEY_LOCAL_MACHINE\\SOFTWARE', 'hkcu:']) {
      const v = e.evaluate(readReq(p));
      assert.equal(v.allowed, true, `${p} 应 ALLOW：${v.matchedRule} / ${v.error?.message ?? ''}`);
    }
    // 不得因此放宽任何其它层级
    const bad = e.evaluate(readReq('HKLM:\\SOFTWAREX\\Foo'));
    assert.equal(bad.allowed, false, '兄弟层级不得因尾分隔符重试而被放行');
  });
});

/* ------------------------- 交叉核对 A1：文档/能力面/实现三方一致 ------------------------- */

describe('S-1 · 交叉核对 A1 — 能力描述与规范文档同步形态口径', () => {
  const definitions = src('packages/vm-capabilities/src/registry/definitions.ts');
  const capModel = src('docs/02-design/CAPABILITY-MODEL.md');

  test('system.registry.read/write 的描述写明「写法等价 + 归一权威在策略层」', () => {
    const readBlock = /id: 'system\.registry\.read',([\s\S]*?)\n?, idempotent: true \}\)/.exec(definitions);
    assert.ok(readBlock, 'definitions.ts 应能定位 system.registry.read 块');
    assert.match(readBlock[1], /写法.{0,2}等价|写法等价/, '描述须声明写法等价（S-1 的用户可见承诺）');
    assert.match(readBlock[1], /HKEY_LOCAL_MACHINE/, '描述须给出长全称示例');
    assert.match(readBlock[1], /归一 ≠ 放行|一律拒绝/, '描述须说明非准入根键仍被拒（避免「归一即可用」的误读）');
    const writeBlock = /id: 'system\.registry\.write',([\s\S]*?)snapshot: 'before-after' \}\)/.exec(definitions);
    assert.ok(writeBlock, 'definitions.ts 应能定位 system.registry.write 块');
    assert.match(writeBlock[1], /形态规则同/, '写能力描述须引用同一形态口径（不另立规则）');
  });

  test('CAPABILITY-MODEL.md 有注册表形态小节，且与实现的权威形态逐字同串', () => {
    assert.match(capModel, /#### 3\.1\.1 注册表路径形态归一化/, '规范文档须有 §3.1.1（供人查的形态口径）');
    const sec = capModel.slice(capModel.indexOf('#### 3.1.1'));
    const body = sec.slice(0, sec.indexOf('### 3.2') > 0 ? sec.indexOf('### 3.2') : sec.length);
    assert.ok(body.includes('HKLM:\\software'), `文档权威形态须与小写化实现一致（实得示例：HKLM:\\software\\…）`);
    assert.match(body, /恰 4 条/, '文档须写明准入清单恰 4 条（与 REG_CANON 一致，交叉核对 A1）');
    assert.match(body, /大小写敏感/, '文档须写明注册表域大小写敏感');
    assert.match(body, /pathAllowlist:miss/, '文档须写明「不得退回文件系统域」这条归属约束');
    assert.match(body, /r19b-s1-kn2-contract\.md/, '文档须指向权威契约');
  });

  test('权威契约文档存在且含本修复的全部判据锚点（落盘可 grep ⇒ 不再依赖会话记忆）', () => {
    const contract = src('docs/design/r19b-s1-kn2-contract.md');
    for (const anchor of [
      '## 1. S-1 · B1',
      '### 2.1 B2-1',
      '### 2.2 B2-2',
      '## 3. S-1 · B3',
      '## 4. K-N2',
      '### 4.3 `plan` 字段契约',
      '## 5. 交叉核对清单（A1–A5',
      '## 6. 契约变更流程',
      '## 7. Open Questions',
      'OQ-1',
      'R-7',
    ]) {
      assert.ok(contract.includes(anchor), `契约文档须含小节锚点：${anchor}`);
    }
    // 契约与实现同源的关键判据必须在文档里可 grep（防止「实现改了、契约漂移」）
    assert.ok(contract.includes('(?<![A-Za-z0-9_])[A-Za-z]:\\\\'), '契约须逐字给出 B1 的盘符正则');
    assert.ok(contract.includes('恰 4 条'), '契约须写明别名表恰 4 条（与 REG_CANON 一致）');
    assert.ok(contract.includes('matchRegistryAllowlist'), '契约须给出敏感比对的函数名');
    assert.ok(contract.includes('HKLM:\\software'), '契约给出的权威形态须与小写化实现一致');
    assert.ok(contract.includes('-1978335230'), 'K-N2 须带真机错误码便于检索');
    assert.ok(/wingetInvoked/.test(contract) && /移除|不得|废弃/.test(contract), '契约须记录 wingetInvoked 已废弃');
    assert.ok(/OQ-1[\s\S]{0,400}--what-if|--what-if[\s\S]{0,600}OQ-1/.test(contract), '--what-if 的未证实状态须登记为 open question');
    assert.match(contract, /权威设计契约（定稿）/, '文档性质须声明为权威契约（定稿）');
    assert.match(contract, /唯一判定依据/, '文档须声明自己是这两项修复的唯一判定依据');
    assert.match(contract, /开新单/, '文档须含「契约缺陷先开新单」的流程约束（§6）');
    assert.match(contract, /real-test-2026-09-30-r19\.md/, '文档须锚定真机权威报告为缺陷来源');
  });
});

describe('S-1 · 域归属 — 注册表串不进文件系统白名单，文件系统串不被注册表域放行', () => {
  test('commandish 参数里的注册表路径不进文件系统候选（pathCandidates 双侧判据）', () => {
    // 键名 command ⇒ 走 token 提取；token 里的 HKLM:\… 必须交回注册表域
    const v = engine().evaluate({
      capabilityId: 'system.process.exec',
      params: { command: 'reg query HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall' },
      risk: 'L0',
      approved: false,
    });
    assert.equal(v.allowed, true, `注册表形态的命令不应撞文件系统白名单：${JSON.stringify({ rule: v.matchedRule, msg: v.error?.message })}`);
    assert.notEqual(v.matchedRule, 'pathAllowlist:miss');
  });

  test('命令里引用 HKEY_* 长全称同样不误拒（原样不像注册表前缀时靠归一后判据剔除）', () => {
    const v = engine().evaluate({
      capabilityId: 'system.process.exec',
      params: { command: 'reg query HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft' },
      risk: 'L0',
      approved: false,
    });
    assert.equal(v.allowed, true, `${v.matchedRule} / ${v.error?.message ?? ''}`);
  });

  test('文件系统越权仍拒（注册表宽松不得外溢到文件系统域）', () => {
    const e = engine();
    // 黑名单项（系统目录）
    const d = e.evaluate({
      capabilityId: 'storage.file.read',
      params: { path: 'C:\\Windows\\System32\\config\\SAM' },
      risk: 'L0',
      approved: false,
    });
    assert.equal(d.allowed, false, '系统关键目录必须仍被拒');
    assert.match(d.matchedRule, /^pathDenylist:/);
    // 白名单外的任意盘符（既非黑名单也非白名单 ⇒ 拒绝优先）
    const m = e.evaluate({
      capabilityId: 'storage.file.read',
      params: { path: 'X:\\secrets\\id_rsa' },
      risk: 'L0',
      approved: false,
    });
    assert.equal(m.allowed, false, '白名单外路径必须仍被拒');
    assert.equal(m.matchedRule, 'pathAllowlist:miss', '文件系统路径本就该落在此域（与注册表形态的归属区分开）');
  });

  test('写入能力的判定不因形态而异（范围归 S-5/#27，本文件只锁形态等价）', () => {
    const e = engine();
    // 只断言**不变式**：同一物理键的长短名/有无冒号/大小写四种写法，判定必须一致。
    // 不断言「HKLM:\SOFTWARE 是否可写」—— 那是 S-5（`isWrite` 判定恒 false 致读写白名单失去隔离，
    // 任务板 #27）的范围，本修复不重定策略边界，避免把已知缺陷固化成期望值。
    const forms = [
      'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run',
      'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run',
      'hklm:\\software\\microsoft\\windows\\currentversion\\run',
      'HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
    ];
    const verdicts = forms.map((p) => e.evaluate(writeReq(p)).allowed);
    assert.equal(new Set(verdicts).size, 1, `同键四写法判定必须一致，实得 ${JSON.stringify(verdicts)}`);
    const hkcu = e.evaluate(writeReq('HKCU:\\Software\\Foo'));
    assert.equal(hkcu.allowed, true, `HKCU 写入在读/写两表下均须允许：${hkcu.matchedRule} / ${hkcu.error?.message ?? ''}`);
  });
});

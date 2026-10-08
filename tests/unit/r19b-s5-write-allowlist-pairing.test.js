/**
 * R19-B · S-5 单元测试：注册表**读写白名单边界**修复的成对性验收
 *
 * 权威口径：`docs/design/s5-registry-write-allowlist-pairing.md`（commit `d25ee42`）。
 * 本文件逐条落实该文档 **§④ 的 6 条验收断言**，并按 §③ 末「(a)(b) 必须同 commit、
 * 缺一不可」的纪律额外补 2 条**成对性静态守卫** —— 只 (a) / 只 (b) 的半成品必须在这里红，
 * 不允许靠 review 兜（文档 §④ 叙事要求原文：按「收紧」叙事 review 极易漏掉 (b)）。
 *
 * 缺陷一句话（文档 §0）：`engine.ts` 4b 的 `isWrite` 判据 `/\.(write|set|create|delete|remove)\./i`
 * 要求动词**两侧都有点**，而真实能力 ID `system.registry.write` 的动词在**末段无尾点**
 * ⇒ 判定恒 false ⇒ 写请求一直按**读**白名单判定 ⇒ `registryWriteAllowlist` 是不可达的死配置，
 * 读写边界静默失效（文档 §② 末段实证危害：运维「只放宽读」静默等于授予写权限）。
 *
 * 成对修改（文档 §③）：
 *   (a) `isWrite` 覆盖末段动词形态 —— 本仓实现抽为导出函数 `isWriteCapability`（唯一判据）；
 *   (b) `registryWriteAllowlist` 补 `HKLM:\SOFTWARE\**` + `HKEY_LOCAL_MACHINE\SOFTWARE\**`
 *       两形态对称条目 —— 否则 (a) 之后合法写路径被**硬 DENY**（白名单 miss 发生在审批闸之前
 *       ⇒ 不转「需批准」），`SKILL.md` 承诺的「HKLM:\SOFTWARE 写入需 L2 审批」被摧毁。
 *
 * 实证方式与文档一致：**直接跑 `evaluate()`** 取三个可观测判定字段（非纸面推演）；
 * 三段实测状态表（文档 §② T0 / A / A+B）逐格落为断言。
 *
 * 运行：node --test tests/unit/r19b-s5-write-allowlist-pairing.test.js
 * ⚠ 依赖 `@winvm/core` 已重建 dist（旧 dist 仍是缺陷版 `isWrite` ⇒ 断言1 首个用例即失败，
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
  isWriteCapability,
  normalizeRegistryPath,
} from '@winvm/core';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
/** 读源码文本（静态守卫用；不经 dist，避免「测的是编译产物」的间接性） */
const src = (rel) => readFileSync(resolve(repoRoot, rel), 'utf8');

const WRITE_ID = 'system.registry.write';
const READ_ID = 'system.registry.read';
/** 文档 §③(b) 给出的 HEAD 原值 —— 作为「只修 (a)」反例配置（capabilityPolicy 是**替换**非并集） */
const HEAD_WRITE_TABLE = ['HKCU:\\**', 'HKEY_CURRENT_USER\\**'];

const engine = (opts = {}) => new CorePolicyEngine(opts);

const writeReq = (path, approved, capabilityPolicy) => ({
  capabilityId: WRITE_ID,
  params: { path, name: 'v', value: 1 },
  risk: 'L2',
  approved,
  ...(capabilityPolicy ? { capabilityPolicy } : {}),
});
const readReq = (path) => ({
  capabilityId: READ_ID,
  params: { path },
  risk: 'L0',
  approved: false,
});

/** 三段实测状态表的单元格：只取三个可观测判定字段 */
const verdict = (v) => ({ allowed: v.allowed, matchedRule: v.matchedRule, requiresApproval: v.requiresApproval });

/* ==================== 契约 §④-1：matchedRule 域必须从 Read 切到 Write ==================== */

describe('S-5 · 断言1 — system.registry.write 的判定域是 registryWriteAllowlist', () => {
  test('写请求 miss 报 **registryWriteAllowlist:miss**（不再是 registryReadAllowlist）', () => {
    const v = engine().evaluate(writeReq('HKLM:\\SYSTEM\\CurrentControlSet', true));
    assert.equal(v.allowed, false);
    assert.match(
      v.matchedRule,
      /^registryWriteAllowlist:/,
      `真机症状复发即判失败：写请求报出了读表域 ${v.matchedRule}（文档 §0 的铁证）`,
    );
    assert.equal(v.matchedRule, 'registryWriteAllowlist:miss');
  });

  test('错误体 mode=write、details.allowed 回显**写表**条目（判定依据确实换了表）', () => {
    const v = engine().evaluate(writeReq('HKLM:\\SYSTEM\\Foo', true));
    assert.equal(v.error.details.mode, 'write', '缺陷版此处恒为 read（isWrite 恒 false 的直接后果）');
    assert.deepEqual([...v.error.details.allowed], [...DEFAULT_POLICY.registryWriteAllowlist]);
    assert.ok(
      !v.error.details.allowed.some((p) => /HKLM:\\\\(SAM|SECURITY)|HKEY_LOCAL_MACHINE\\\\SYSTEM/i.test(p)),
      '(b) 只补 HKLM:\\SOFTWARE，写表不得被顺手扩到其它根键',
    );
  });

  test('读请求 miss 仍报 registryReadAllowlist:miss（读写两域各自归属，读侧不外溢）', () => {
    const v = engine().evaluate(readReq('HKLM:\\SYSTEM\\CurrentControlSet'));
    assert.equal(v.allowed, false);
    assert.match(v.matchedRule, /^registryReadAllowlist:/);
  });

  test('isWriteCapability：写动词能力 true / 读与非写能力 false（判定方向正确）', () => {
    assert.equal(isWriteCapability(WRITE_ID), true, '本次修复的核心：末段动词必须被认出来');
    for (const id of [READ_ID, 'app.winget.uninstall', 'system.network.config', 'storage.file.read', 'system.process.list']) {
      assert.equal(isWriteCapability(id), false, `${id} 不含写动词，不得误判为写`);
    }
    for (const id of ['storage.file.write', 'storage.file.delete', 'system.registry.write']) {
      assert.equal(isWriteCapability(id), true, `${id} 含写动词分段，须走写表`);
    }
    assert.equal(isWriteCapability(undefined), false, '入参缺席不得抛错（判定是策略热路径）');
  });
});

/* ==================== 契约 §④-2：默认配置四链路逐格（= 文档 §② T0 vs A+B 对照） ==================== */

describe('S-5 · 断言2 — 默认配置（含 (b) 补表）四链路逐格成立', () => {
  test('写 HKLM:\\SOFTWARE\\Foo **未批** → approval-required / requiresApproval=true', () => {
    const v = engine().evaluate(writeReq('HKLM:\\SOFTWARE\\Foo', false));
    assert.deepEqual(
      verdict(v),
      { allowed: false, matchedRule: 'approval-required', requiresApproval: true },
      '文档 §② (A+B) 行：L2 审批语义首次**真正成立**（此前只是隐式碰巧经读表放行）',
    );
    assert.equal(v.error.code, 'APPROVAL_REQUIRED');
  });

  test('同请求 **approved=true** → allow:policy-passed（与 T0 逐格相同 ⇒ 非放宽亦非收紧）', () => {
    const v = engine().evaluate(writeReq('HKLM:\\SOFTWARE\\Foo', true));
    assert.deepEqual(verdict(v), { allowed: true, matchedRule: 'allow:policy-passed', requiresApproval: false });
  });

  test('写 HKCU:\\** 同链路成立（未批 → 审批；批准后 → 放行）', () => {
    assert.deepEqual(
      verdict(engine().evaluate(writeReq('HKCU:\\Software\\Foo', false))),
      { allowed: false, matchedRule: 'approval-required', requiresApproval: true },
    );
    assert.equal(engine().evaluate(writeReq('HKCU:\\Software\\Foo', true)).allowed, true);
  });

  test('写 HKLM:\\SYSTEM\\** → registryWriteAllowlist:miss 且 **requiresApproval=false（硬拒不得转审批）**', () => {
    for (const p of ['HKLM:\\SYSTEM\\CurrentControlSet', 'HKLM:\\SAM', 'HKLM:\\SECURITY\\Policy', 'HKEY_LOCAL_MACHINE\\SYSTEM\\Foo']) {
      const v = engine().evaluate(writeReq(p, true));
      assert.equal(v.allowed, false, `${p} 必须拒（approved=true 同样拒 ⇒ miss 在审批闸之前）`);
      assert.equal(v.matchedRule, 'registryWriteAllowlist:miss');
      assert.equal(v.requiresApproval, false, `${p} 若为 true 说明边界又被挪到审批闸之后（文档 §① 关键推论被违背）`);
      assert.equal(v.error.code, 'POLICY_DENIED');
    }
  });

  test('阶段顺序锁：已批的越权写**不可能**变成 approval-required', () => {
    const v = engine().evaluate(writeReq('HKLM:\\SYSTEM\\Foo', true));
    assert.notEqual(v.matchedRule, 'approval-required', '文档 §①：白名单 miss 永远不「升级成需批准」');
    assert.equal(v.requiresApproval, false);
  });

  test('(b) 补表不产生无审批写（risk=L2 仍先被审批闸拦；含 Run 自启动面）', () => {
    const v = engine().evaluate(writeReq('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run', false));
    assert.equal(v.allowed, false, '文档 §②：危害的准确表述是**读写边界失效**，不是「存在无审批写」');
    assert.equal(v.requiresApproval, true);
  });
});

/* ==================== 契约 §④-3：读白名单扩面不授予写权限 ==================== */

describe('S-5 · 断言3 — 读表扩面 ≠ 授予写权限（文档 §② 末段实证过的漏洞场景）', () => {
  /** 运维为只读诊断往 registryReadAllowlist 加一条 `HKLM:\**`（mergePolicy 并集） */
  const leakyEngine = () => engine({ config: { registryReadAllowlist: ['HKLM:\\**'] } });

  test('读表扩 HKLM:\\** 后写 HKLM:\\SYSTEM\\CurrentControlSet\\Services（approved=true）**必须 DENY**', () => {
    const v = leakyEngine().evaluate(writeReq('HKLM:\\SYSTEM\\CurrentControlSet\\Services', true));
    assert.deepEqual(
      verdict(v),
      { allowed: false, matchedRule: 'registryWriteAllowlist:miss', requiresApproval: false },
      '缺陷版此格实跑 allowed=true（「我只放宽了读」静默等于授予写权限）—— 本条即该回归的锁',
    );
  });

  test('同一扩面配置下**读** HKLM:\\SYSTEM 仍放行（扩读有效，只是不外溢到写）', () => {
    const r = leakyEngine().evaluate(readReq('HKLM:\\SYSTEM\\CurrentControlSet\\Services'));
    assert.equal(r.allowed, true, `读扩面应仍可读取：${r.matchedRule} / ${r.error?.message ?? ''}`);
  });

  test('capabilityPolicy 覆盖写表时以覆盖为准（该配置过去整条不可达）', () => {
    const v = engine().evaluate(writeReq('HKLM:\\SOFTWARE\\Foo', true, { registryWriteAllowlist: ['HKCU:\\**'] }));
    assert.equal(v.allowed, false, '能力级写表收紧必须生效');
    assert.equal(v.matchedRule, 'registryWriteAllowlist:miss');
  });
});

/* ==================== 契约 §④-4：文档-代码一致性 ==================== */

describe('S-5 · 断言4 — SKILL.md 所述语义可被 evaluate() 用例直接复现', () => {
  const SKILL = src('skills/winvm-system-admin/SKILL.md');

  test('SKILL.md「`HKLM:\\SOFTWARE` 需 L2 审批」→ 未批 requiresApproval=true、批准后 passed（**本条挂=只做了 (a)**）', () => {
    assert.match(SKILL, /`HKLM:\\SOFTWARE` \*\*需 L2 审批\*\*/, 'SKILL.md 须明文承诺该语义（口径不得被改写成「禁止写」）');
    assert.equal(engine().evaluate(writeReq('HKLM:\\SOFTWARE\\Foo', false)).requiresApproval, true, '文档承诺的「需审批」必须在代码里拿得到');
    assert.equal(engine().evaluate(writeReq('HKLM:\\SOFTWARE\\Foo', true)).allowed, true, '批准后必须放行（只 (a) 时此处是 miss）');
  });

  test('SKILL.md「其它根键读/写一律拒绝」→ HKLM:\\SYSTEM / SAM / SECURITY 读写两路都 DENY', () => {
    assert.match(SKILL, /其它根键（`HKLM:\\SYSTEM`、`HKLM:\\SAM`、`HKLM:\\SECURITY`）\*\*读\/写一律拒绝\*\*/);
    for (const p of ['HKLM:\\SYSTEM\\Foo', 'HKLM:\\SAM', 'HKLM:\\SECURITY\\Policy']) {
      assert.equal(engine().evaluate(readReq(p)).allowed, false, `${p} 读须拒`);
      const w = engine().evaluate(writeReq(p, true));
      assert.equal(w.allowed, false, `${p} 写须拒`);
      assert.match(w.matchedRule, /^registryWriteAllowlist:/, `${p} 写须落在**写表**域（报读表 miss 即 S-5 复发）`);
    }
  });

  test('defaults.ts 写表注释与 (b) 实际条目一致（不得留「默认仅 HKCU」的过期口径）', () => {
    const d = src('packages/core/src/policy/defaults.ts');
    assert.ok(!/默认仅 HKCU/.test(d), '「默认仅 HKCU」在 (b) 之后是假信息（写表已含 HKLM:\\SOFTWARE）');
    assert.match(
      d,
      /registryWriteAllowlist:\s*\[[\s\S]*?'HKLM:\\\\SOFTWARE\\\\\*\*'[\s\S]*?'HKEY_LOCAL_MACHINE\\\\SOFTWARE\\\\\*\*'[\s\S]*?\]/,
      '写表字面量须是四条两形态（与读表形态对称，文档 §③(b)）',
    );
    assert.match(d, /S-5/, '写表须锚定权威文档，可 grep 溯源');
  });

  test('错误体 forms 的「写入范围」由写表投影而来（与 DEFAULT_POLICY 不可能漂移）', () => {
    const forms = engine().evaluate(writeReq('HKLM:\\SYSTEM\\Foo', true)).error.details.forms;
    // 归一投影：长短名折叠 ⇒ 权威形态小写键名段
    assert.match(
      forms,
      /写入范围：`HKCU:\\\*\*` 与 `HKLM:\\software\\\*\*`。/,
      `forms 写入范围须等于写表的权威形态投影，实得：${forms}`,
    );
    assert.ok(!/写入范围：[^。]*HKEY_CURRENT_USER/.test(forms), '长全称已被归一折叠，提示里不得重复出现');
    // 读范围与写范围之间用「；」分隔，写范围句末才是「。」
    assert.match(forms, /读取范围：`HKCU:\\\*\*` 与 `HKLM:\\software\\\*\*`；/, '读范围同样由读表投影');
  });
});

/* ==================== 契约 §④-5：读行为逐字不变 ==================== */

describe('S-5 · 断言5 — system.registry.read 行为逐字不变（S-5 只动写侧）', () => {
  /** 修复前后应逐格相同的读侧矩阵（与 tests/unit/r19b-s1-registry-forms.test.js 读侧同源） */
  const READ_FROZEN = [
    ['HKLM\\SOFTWARE\\Microsoft', true, 'allow:policy-passed'],
    ['HKLM:\\SOFTWARE\\Microsoft', true, 'allow:policy-passed'],
    ['HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft', true, 'allow:policy-passed'],
    ['hklm:\\Software\\Foo', true, 'allow:policy-passed'],
    ['HKCU:\\Software\\Foo', true, 'allow:policy-passed'],
    ['HKLM:\\SOFTWARE', true, 'allow:policy-passed'],
    ['HKLM:\\SOFTWAREX\\Foo', false, 'registryReadAllowlist:miss'],
    ['HKLM:\\SYSTEM\\CurrentControlSet', false, 'registryReadAllowlist:miss'],
    ['HKCR:\\txtfile', false, 'registryReadAllowlist:miss'],
    ['HKCC:\\Control', false, 'registryReadAllowlist:miss'],
    ['HKU:\\S-1-5-21', false, 'registryReadAllowlist:miss'],
    ['HKEY_USERS\\.DEFAULT', false, 'registryReadAllowlist:miss'],
  ];

  for (const [path, allowed, rule] of READ_FROZEN) {
    test(`读 ${path} → ${allowed ? 'ALLOW' : 'DENY'}`, () => {
      const v = engine().evaluate(readReq(path));
      assert.equal(v.allowed, allowed, `${path} 的读判定被 S-5 改动污染`);
      assert.equal(v.matchedRule, rule);
    });
  }

  test('读表条目本身未被本次修复改动（(b) 只动写表）', () => {
    assert.deepEqual([...DEFAULT_POLICY.registryReadAllowlist], [
      'HKCU:\\**',
      'HKEY_CURRENT_USER\\**',
      'HKLM:\\SOFTWARE\\**',
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\**',
    ]);
  });

  test('D9 归一四条不变（cl017 既有断言不得被 S-5 弄翻）', () => {
    assert.equal(normalizeRegistryPath('HKLM\\SOFTWARE\\Microsoft'), 'HKLM:\\software\\microsoft');
    assert.equal(normalizeRegistryPath('HKLM:\\SOFTWARE'), 'HKLM:\\software');
    assert.equal(normalizeRegistryPath('HKCU\\Software'), 'HKCU:\\software');
    assert.equal(normalizeRegistryPath('HKLM:'), 'HKLM:');
  });

  test('S-1 夹具的 `HKLM:\\SOFTWAREX\\Foo` DENY 未被写表补条目弄翻（兄弟层级仍拒）', () => {
    const v = engine().evaluate(readReq('HKLM:\\SOFTWAREX\\Foo'));
    assert.equal(v.allowed, false, '「白名单含自身」的尾分隔符重试只放宽条目本身所表示的那个键');
    assert.equal(v.matchedRule, 'registryReadAllowlist:miss');
    const w = engine().evaluate(writeReq('HKLM:\\SOFTWAREX\\Foo', true));
    assert.equal(w.allowed, false, '写侧同样不得因 HKLM:\\SOFTWARE\\** 而放行兄弟层级');
    assert.equal(w.matchedRule, 'registryWriteAllowlist:miss');
  });
});

/* ==================== 契约 §④-6：命名口径 ==================== */

describe('S-5 · 断言6 — 测试文件命名 .test.js（会被 test:unit 口径收录）', () => {
  test('本文件以 .test.js 结尾且被 package.json 的 test:unit 覆盖', () => {
    const self = fileURLToPath(import.meta.url);
    assert.ok(self.endsWith('.test.js'), '契约 §④-6：必须命名 .test.js');
    const pkg = JSON.parse(src('package.json'));
    const runner = pkg.scripts['test:unit'];
    // 2026-10-08 体检 §7-1/N7（QA-P0-4 · R3）：`test:unit` 原为**文档四处明令禁止**的整批 glob
    // `node --test tests/unit/*.test.js`（link-workspace 的 junction 触发 0xC0000005 假全红），
    // 已改为逐文件 spawn 版。故本断言从"匹配旧 glob 字面量"升级为**语义判据**（更强）：
    //   ① 口径覆盖 tests/unit 目录；② 收录 .test.js（本文件后缀）；
    //   ③ 不再出现会被 shell 展开的整批 `*.test.js` 字面 glob。
    assert.match(runner, /tests[/\\]unit/, 'test:unit 须指向 tests/unit 目录');
    assert.ok(
      runner.includes('.test.js'),
      'test:unit 的收录口径须含 .test.js，否则本文件被静默跳过（L8 护栏统计口径）',
    );
    assert.ok(
      !/node\s+--test\s+tests\/unit\/\*\.test\.js/.test(runner),
      'test:unit 不得回退为整批 glob（link-workspace junction ⇒ 0xC0000005 假全红，见体检 §7-1）',
    );
    assert.ok(
      !/node\s+--test\s+["']?tests\/unit["']?\s*$/.test(runner) && !/^node\s+--test\s*$/.test(runner),
      'test:unit 不得为裸 `node --test`（自动发现全部测试，同样撞 junction 崩溃坑）',
    );
  });
});

/* ==================== 成对性守卫（文档 §③ 末：只 (a) / 只 (b) 都不可接受） ==================== */

describe('S-5 · 成对性守卫 — 「只做一半」必须在这里红，不允许靠 review 兜', () => {
  test('只 (a)（写表仍只有 HKCU）→ 合法 HKLM:\\SOFTWARE 写被硬封：证明 (b) 不可省', () => {
    const no = engine().evaluate(writeReq('HKLM:\\SOFTWARE\\Foo', false, { registryWriteAllowlist: HEAD_WRITE_TABLE }));
    assert.deepEqual(verdict(no), { allowed: false, matchedRule: 'registryWriteAllowlist:miss', requiresApproval: false });
    const yes = engine().evaluate(writeReq('HKLM:\\SOFTWARE\\Foo', true, { registryWriteAllowlist: HEAD_WRITE_TABLE }));
    assert.equal(yes.allowed, false, '文档 §② (A) 行：批准了也照样拒 ⇒ L2 审批语义被摧毁（行为回归）');
  });

  test('只 (b)（isWrite 仍是「两侧有点」的旧判据）→ 写表整条不可达：证明 (a) 不可省', () => {
    const legacyIsWrite = (id) => /\.(write|set|create|delete|remove)\./i.test(String(id));
    assert.equal(legacyIsWrite(WRITE_ID), false, '旧判据对真实 ID 恒 false —— 死配置的成因');
    assert.equal(isWriteCapability(WRITE_ID), true);
    assert.notEqual(legacyIsWrite(WRITE_ID), isWriteCapability(WRITE_ID), '二者取值不同 ⇒ 缺任一半场读写边界都失效');
  });

  test('engine.ts 内不得残留旧判据的**可执行代码**形态，且 4b 必须走唯一导出判据', () => {
    // 剥掉**全部**注释（行注释 + JSDoc 块注释）后再查：修复说明里必然要引述旧正则，
    // 那不是「可执行代码形态的回归」；真正的回归是没注释的代码里又出现旧判据。
    const codeOnly = src('packages/core/src/policy/engine.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert.ok(
      !/\/\\\.\(write\|set\|create\|delete\|remove\)\\\.\//.test(codeOnly),
      '旧正则以可执行代码形态回归即判失败（文档 §0 根因行）',
    );
    assert.match(codeOnly, /isWriteCapability\(req\.capabilityId\)/, '4b 的 isWrite 必须来自导出的唯一判据函数');
  });

  test('本仓判据与契约 §③(a) 两个写法逐能力等价（分段超集的偏差方向已穷举核过）', () => {
    const WRITE_WORDS = new Set(['write', 'set', 'create', 'delete', 'remove']);
    const tailAnchored = (id) => /\.(write|set|create|delete|remove)$/i.test(id);
    const lastSegment = (id) => WRITE_WORDS.has(String(id).split('.').pop().toLowerCase());
    const ids = [...src('packages/vm-capabilities/src/registry/definitions.ts').matchAll(/id: '([a-z0-9._]+)'/g)].map((m) => m[1]);
    assert.ok(ids.length >= 50, `应抽到全部能力 ID，实得 ${ids.length}`);
    for (const id of ids) {
      assert.equal(
        isWriteCapability(id),
        tailAnchored(id),
        `${id}：与末段锚定写法结论不同 ⇒ 本仓出现中段动词 ID，须回契约重核口径（当前全仓 grep 无此类 ID）`,
      );
      assert.equal(isWriteCapability(id), lastSegment(id), `${id}：与「取末段比集合」写法结论不同`);
    }
  });

  test('权威文档在库且判据锚点可 grep（成对口径不再依赖会话记忆）', () => {
    const doc = src('docs/design/s5-registry-write-allowlist-pairing.md');
    for (const anchor of [
      '## ③ 成对修改清单（同一 commit，缺一不可）',
      '**(a) `isWrite` 改末段匹配**',
      '**(b) `registryWriteAllowlist` 补两形态对称条目**',
      '## ④ commit 叙事要求 + 验收断言',
      '### 验收断言（须全绿；命名用 `.test.js`，见末条）',
    ]) {
      assert.ok(doc.includes(anchor), `S-5 文档须含锚点：${anchor}`);
    }
    assert.match(doc, /白名单 miss 发生在审批闸（阶段 6）之前/, '关键推论（miss = 硬 DENY）须落档');
    assert.match(doc, /禁止\*\*把本改动描述为|禁用表述/, '叙事禁令须落档');
  });
});

/* ==================== 附带：mergePolicy 并集语义下写表不退化 ==================== */

describe('S-5 · 附带 — 用户配置并集不得让写表条目退化', () => {
  test('config 覆盖写表时与默认写表取并集（含 (b) 新增两条仍在）', () => {
    const v = engine({ config: { registryWriteAllowlist: ['HKU:\\**'] } }).evaluate(writeReq('HKLM:\\SYSTEM\\Foo', true));
    assert.equal(v.matchedRule, 'registryWriteAllowlist:miss', '并集后 HKLM:\\SYSTEM 仍不在写表 ⇒ 照拒');
    assert.ok(
      v.error.details.allowed.includes('HKLM:\\SOFTWARE\\**'),
      `details.allowed 须含 (b) 的短形条目，实得 ${JSON.stringify(v.error.details.allowed)}`,
    );
  });
});

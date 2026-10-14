/**
 * QA-P0-3（体检 §2-QA-03 / §8-N3）· 注册表 ↔ psmod 跨语言契约回归
 *
 * ## 为什么存在
 * `WINDOWS_CAPABILITIES` 每条都带 `implementation.{module,function}`，运行期由
 * `ps-bridge.ps1` 的 `Invoke-BridgeRequest` 按 `"$module.ps1"` 动态加载模块、再用
 * `Get-Command -Name $fn -CommandType Function` 找函数（见 `ps-bridge.ps1:102`/`:169`）。
 * 也就是说：**注册表里的函数名与 ps1 里的 `function` 定义名是一份跨语言（TS ↔ PowerShell）
 * 的隐式契约**，编译器与 `tsc` 都看不见它。
 *
 * 2026-10-08 全维度体检实测：这一致命装配约束**当时零回归**——
 * `grep -rn "implementation" tests/unit` 无等价断言，54 条映射全靠审计临时脚本才验出。
 * 后果：改了 `definitions.ts` 的 `fn` 而忘了同步 ps1（或反之改名/删函数），
 * 1054 单测基线**完全无感**，只会在真机运行期报 `UNKNOWN_FUNCTION` 才炸。
 * 本文件把那份审计脚本固化成回归护栏。
 *
 * ## 纪律
 * 纯 `readFileSync` + 正则解析，**零 PowerShell 依赖、零 spawn、不起服务**（沙箱可跑）；
 * 与 `cl017-psmod-sort.test.js` / `cl018-psmod-c456.test.js` 同款静态守卫手法。
 * 能力来源**双读**：dist 注册表（运行期真实装载物）+ `src/registry/definitions.ts`
 * 文本解析（防「src 改了但没 build」这一 dist 滞后盲区；解析式漂移由二者互校自身捕获）。
 *
 * 运行（只跑本文件，绝不整批）：
 *   node --test tests/unit/psmod-contract.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/* ============================ 路径与解析（只读） ============================ */

const ROOT = join(import.meta.dirname, '..', '..');
const PSMOD_DIR = join(ROOT, 'packages', 'vm-capabilities', 'psmod');
const DEFINITIONS_TS = join(ROOT, 'packages', 'vm-capabilities', 'src', 'registry', 'definitions.ts');
const DEFINITIONS_DIST = join(ROOT, 'packages', 'vm-capabilities', 'dist', 'registry', 'definitions.js');

/**
 * ps1 函数定义解析：`^\s*function\s+<Name>`，**大小写不敏感**（PowerShell 关键字
 * `function` / `Function` / `FUNCTION` 等价）。与 `cl017-psmod-sort` 的行首口径一致，
 * 天然排除形参列表与注释里的函数名。
 */
const PS_FUNCTION_RE = /^[ \t]*function[ \t]+([A-Za-z0-9_:.\-]+)/gim;

/** 读全部 ps1，产出 `函数名 -> { 文件, 定义名(原始大小写) }` */
function loadPsFunctions() {
  const files = readdirSync(PSMOD_DIR)
    .filter((f) => f.endsWith('.ps1'))
    .sort();
  /** @type {Map<string, {file: string, defined: string, fileText: string}>} */
  const byName = new Map();
  const perFile = new Map();
  for (const file of files) {
    const text = readFileSync(join(PSMOD_DIR, file), 'utf8');
    const names = [];
    PS_FUNCTION_RE.lastIndex = 0;
    let m;
    while ((m = PS_FUNCTION_RE.exec(text)) !== null) {
      names.push(m[1]);
      const lower = m[1].toLowerCase();
      if (byName.has(lower)) {
        // 同名跨文件重复定义 = ps-bridge 的 `Get-Command` 只会命中最后加载者，语义不确定
        throw new Error(
          `psmod 函数重名（后加载者覆盖前者，调用结果不确定）：${m[1]} 同时定义于 ` +
            `${byName.get(lower).file} 与 ${file}`,
        );
      }
      byName.set(lower, { file, defined: m[1], fileText: text });
    }
    perFile.set(file, names);
  }
  return { files, byName, perFile };
}

/**
 * 从 `definitions.ts` 源码文本抽取每条 `cap({ id, module, fn })` 三元组。
 * 不依赖 tsc/dist：用 `cap({` 起点 + 花括号配平切块，块内取首个 id/module/fn 字面量。
 */
function loadRegistryFromSource() {
  const src = readFileSync(DEFINITIONS_TS, 'utf8');
  const out = [];
  let cursor = 0;
  for (;;) {
    const start = src.indexOf('cap({', cursor);
    if (start === -1) break;
    let depth = 0;
    let end = -1;
    for (let i = start + 'cap('.length; i < src.length; i += 1) {
      const ch = src[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    assert.ok(end !== -1, `definitions.ts: cap({ 花括号未配平（起点偏移 ${start}）`);
    const body = src.slice(start + 'cap({'.length, end);
    const id = /id:\s*'([^']+)'/.exec(body)?.[1];
    const module = /module:\s*'([^']+)'/.exec(body)?.[1];
    const fn = /fn:\s*'([^']+)'/.exec(body)?.[1];
    assert.ok(id && module && fn, `definitions.ts: cap({ 缺少 id/module/fn 字面量（${id ?? '<无id>'}）`);
    out.push({ id, module, fn });
    cursor = end;
  }
  return out;
}

const PS = loadPsFunctions();
/** `ps-bridge.ps1` 里 `Invoke-MetaCapability` 的 `'<fn>' {` switch 分支名 */
const META_SWITCH_BRANCHES = (() => {
  const bridge = readFileSync(join(PSMOD_DIR, 'ps-bridge.ps1'), 'utf8');
  const body = bridge.slice(
    bridge.indexOf('function Invoke-MetaCapability'),
    bridge.indexOf('function Get-CurrentSessionId'),
  );
  return [...body.matchAll(/^[ \t]*'([A-Za-z][\w]*)'[ \t]*\{/gm)].map((m) => m[1]);
})();

/** Node 侧内置拦截的 __meta 函数（不经 bridge；权威落点见文件头注释） */
const NODE_BUILT_IN_META = new Set(['healthCheck']);

const EXPECTED_TOTAL = 54;
const EXPECTED_DOMAINS = { meta: 3, system: 14, app: 8, storage: 13, gui: 11, appops: 5 };

/* ============================ 契约主体 ============================ */

describe('psmod 契约 · 注册表 54 条实现绑定', () => {
  test('psmod 目录形态：恰好 6 个 .ps1 且均含 function 定义', () => {
    assert.deepEqual(
      PS.files,
      ['app.ps1', 'appops.ps1', 'gui.ps1', 'ps-bridge.ps1', 'storage.ps1', 'system.ps1'],
      'psmod 文件集合漂移（新增/改名/删除 .ps1 需同步本守卫与 module→文件映射）',
    );
    for (const [file, names] of PS.perFile) {
      assert.ok(names.length > 0, `${file} 解析不出任何 function 定义（解析正则失效？）`);
    }
  });

  test('注册表条数与域分布锁定 54 / {meta3,system14,app8,storage13,gui11,appops5}', () => {
    const caps = loadRegistryFromSource();
    assert.equal(caps.length, EXPECTED_TOTAL, '能力总数漂移（增删能力须同步体检口径与本守卫）');
    const domains = {};
    for (const c of caps) {
      const d = c.id.split('.')[0];
      domains[d] = (domains[d] || 0) + 1;
      assert.equal(d, c.id.split('.')[0], `${c.id}: id 必须以 <domain>.<group>.<action> 开头`);
    }
    assert.deepEqual(domains, EXPECTED_DOMAINS, '域分布漂移');
    assert.equal(
      new Set(caps.map((c) => c.id)).size,
      EXPECTED_TOTAL,
      '能力 id 重复（注册表 registerAll 会后者覆盖前者）',
    );
  });

  test('src 注册表与 dist 注册表逐条一致（防「改了 src 没 build」的静默错位）', async () => {
    assert.ok(existsSync(DEFINITIONS_DIST), 'dist/registry/definitions.js 缺失，请先 npm run build');
    const mod = await import(`file://${DEFINITIONS_DIST}`);
    const dist = mod.WINDOWS_CAPABILITIES.map(
      (c) => `${c.id}|${c.implementation.module}|${c.implementation.function}`,
    );
    const srcRows = loadRegistryFromSource().map((c) => `${c.id}|${c.module}|${c.fn}`);
    assert.equal(dist.length, EXPECTED_TOTAL, 'dist 注册表条数与体检口径不符');
    assert.deepEqual(
      srcRows.slice().sort(),
      dist.slice().sort(),
      'src 与 dist 的 implementation 绑定不一致（dist 滞后或 src 未构建）',
    );
  });
});

describe('psmod 契约 · 每条能力引用的函数必须真实存在', () => {
  /**
   * 核心不变式（体检 §2-QA-03 风险 a：改名/漏改即运行期 500/UNKNOWN_FUNCTION）：
   *   - 非 `__meta`：`<module>.ps1` 必须存在，且其中必须有 `function <fn>`（**大小写精确**匹配）。
   *   - `__meta`：Node 内置（healthCheck）或 ps-bridge 的 switch 分支（listModules）。
   */
  test('54 条 implementation.{module,function} 全部可解析到真实实现', () => {
    const caps = loadRegistryFromSource();
    const failures = [];
    for (const c of caps) {
      if (c.module === '__meta') {
        if (NODE_BUILT_IN_META.has(c.fn)) continue;
        if (META_SWITCH_BRANCHES.includes(c.fn)) continue;
        failures.push(`${c.id}: __meta.${c.fn} 既非 Node 内置(${[...NODE_BUILT_IN_META]})也无 ps-bridge switch 分支(${META_SWITCH_BRANCHES})`);
        continue;
      }
      const psFile = join(PSMOD_DIR, `${c.module}.ps1`);
      if (!existsSync(psFile)) {
        failures.push(`${c.id}: 模块文件不存在 -> ${c.module}.ps1`);
        continue;
      }
      const hit = PS.byName.get(c.fn.toLowerCase());
      if (!hit) {
        failures.push(`${c.id}: ${c.module}.ps1 里没有 function ${c.fn}（运行期 UNKNOWN_FUNCTION）`);
        continue;
      }
      if (hit.file !== `${c.module}.ps1`) {
        failures.push(`${c.id}: function ${c.fn} 定义在 ${hit.file}，而注册表 module=${c.module}`);
        continue;
      }
      if (hit.defined !== c.fn) {
        failures.push(`${c.id}: 大小写不一致 注册表='${c.fn}' ps1='${hit.defined}'`);
      }
    }
    assert.deepEqual(failures, [], `注册表↔psmod 映射断裂（共 ${failures.length} 条）:\n${failures.join('\n')}`);
    // 覆盖面自证：确实逐条校验了全部 54 条（52 条 ps1 绑定 + 2 条 __meta）
    const psBound = caps.filter((c) => c.module !== '__meta');
    assert.equal(psBound.length, 52, 'ps1 绑定的能力条数变化（须同步本注释）');
    assert.equal(caps.filter((c) => c.module === '__meta').length, 2, '__meta 能力条数变化');
  });

  test('ps1 侧函数名不得与注册表 fn 仅大小写不同（PowerShell 不敏感 / JS 敏感 = 隐性漂移）', () => {
    const caps = loadRegistryFromSource().filter((c) => c.module !== '__meta');
    const drift = [];
    for (const c of caps) {
      const exact = [...PS.byName.values()].find((v) => v.defined === c.fn);
      if (!exact) continue;
      const caseOnly = [...PS.byName.values()].filter(
        (v) => v.defined !== c.fn && v.defined.toLowerCase() === c.fn.toLowerCase(),
      );
      for (const v of caseOnly) drift.push(`${c.id}: ps1 里另有一个仅大小写不同的 ${v.file}::${v.defined}`);
    }
    assert.deepEqual(drift, [], '存在仅大小写不同的同名函数（两份实现，调用归属不确定）');
  });

  test('ps-bridge 的 module→文件解析口径未被改写（契约的地基）', () => {
    const bridge = readFileSync(join(PSMOD_DIR, 'ps-bridge.ps1'), 'utf8');
    // 注册表 module 名 → `$Name.ps1`：这条语句一旦改动，上面所有映射断言都会失真
    assert.match(
      bridge,
      /Join-Path\s+\$PSScriptRoot\s+"\$Name\.ps1"/,
      'ps-bridge 不再按 `<module>.ps1` 解析能力模块，本守卫的映射前提失效',
    );
    // 函数不存在必须显式报错，不得静默回退
    assert.match(bridge, /UNKNOWN_FUNCTION/, 'ps-bridge 缺少 UNKNOWN_FUNCTION 错误码（映射断裂会被静默吞掉）');
    // __meta 分支的 switch 形态未变
    assert.ok(META_SWITCH_BRANCHES.length >= 2, `Invoke-MetaCapability switch 分支异常：${META_SWITCH_BRANCHES}`);
  });
});

describe('psmod 契约 · 孤儿函数（登记为快照，新增即红）', () => {
  /**
   * 体检 §2-QA-03 建议②：既不被任何能力引用、也不被 ps1 内部任何位置调用的函数是死代码
   * （改名/删除无人察觉，且说明该能力其实没接上）。当前实测 4 个，逐个登记为**已知快照**：
   * 快照外新增孤儿 ⇒ 红；孤儿被真正接上（或删除）⇒ 本用例变红提醒同步快照，是期望行为。
   */
  const KNOWN_ORPHANS = [
    // M6（Phase 3 批4）：3 个写侧函数经读写分派函数接上注册表
    // （Invoke-GuiClipboardManage→Set-ClipboardTextValue / Invoke-SystemEnvManage→Set-EnvironmentVariableInfo /
    //  Invoke-StorageArchiveManage→Expand-ZipArchiveItem，内部调用即除名）——
    // 按本快照既定语义「孤儿被真正接上 ⇒ 变红提醒同步」，同步于 2026-10-14。
    // 仅剩 New-ShortcutItem：D8 决策由 Get-ShortcutInfo 内联取代（audit-pm2 差集亲验），
    // 处置=文档口径订正而非重新绑定（绑死函数=双实现漂移，与 A2-10 单源化同精神）。
    'app.ps1::New-ShortcutItem',
  ];

  test('孤儿函数集合等于已登记快照（不多不少）', () => {
    const caps = loadRegistryFromSource().filter((c) => c.module !== '__meta');
    const referenced = new Set(caps.map((c) => c.fn.toLowerCase()));
    const allText = [...PS.perFile.keys()]
      .map((f) => readFileSync(join(PSMOD_DIR, f), 'utf8'))
      .join('\n');
    const orphans = [];
    for (const [file, names] of PS.perFile) {
      for (const name of names) {
        if (referenced.has(name.toLowerCase())) continue;
        // 是否被 ps1 内部调用（去掉自身定义行后的全文出现次数 > 0）
        const occurrences = (allText.match(new RegExp(`\\b${name.replace(/-/g, '\\-')}\\b`, 'gi')) || []).length;
        const definitionOccurrences = (
          allText.match(new RegExp(`^[ \\t]*function[ \\t]+${name.replace(/-/g, '\\-')}\\b`, 'gim')) || []
        ).length;
        if (occurrences - definitionOccurrences <= 0) orphans.push(`${file}::${name}`);
      }
    }
    orphans.sort();
    assert.deepEqual(
      orphans,
      KNOWN_ORPHANS,
      `孤儿函数与登记快照不一致。新增孤儿=该实现无人可达（请接到注册表或删除）；` +
        `减少=请把 ${KNOWN_ORPHANS.filter((k) => !orphans.includes(k)).join(', ')} 从快照移除`,
    );
  });
});

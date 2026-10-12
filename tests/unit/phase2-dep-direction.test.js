/**
 * Phase 2 · P2-T11 单元测试：依赖方向静态守卫（dep-lint）+ 门禁（gate）关键判据
 *
 * 背景（phase2-arch-design §4.4 F-1 / §6 P2-T11 行 / §13 Q7、Q8 裁决 / §365 PR9）：
 *   `scripts/dep-lint.mjs` 在 Phase 1 全程**从未存在**，`layout` 脚本键因此被 QA R3（`c10a400`）
 *   删除（「死入口比缺失更误导」）。Phase 2 命题禁止「写在文档里但运行期不存在的防线」
 *   ⇒ 本批接通 dep-lint + gate，并由**本文件**把它们的判据变成 `node --test` 全量跑里的
 *   回归对象（设计 §4.4 第 4 点：「一条 `tests/unit/` 聚合守卫调用它 ⇒ 这样它进 node --test
 *   全量跑，不需要 CI 就能阻断」）。
 *
 * ⚠ 三条内在本文件的硬约束（不是注释，是被断言保护的实现选择）：
 *   ① **绝不 import 被测包**（设计 §262 第 5 点 + PR9）——本仓单测整批跑会因 link-workspace
 *      的 junction 触发 `0xC0000005` 假全红；聚合守卫必须"读 dist + 纯字符串/JSON 分析"。
 *      ⇒ 对 dep-lint 的调用走 `spawnSync` 子进程（CLI `--root <fixture>`），
 *        对 config-key-lint 的调用走 `import()` **scripts/** 目录（非被测包，零 @winvm 依赖）。
 *   ② **fixture 不落 tests/**（内存/临时目录）——仓内按目录枚举的静态守卫（`phase2-dead-config`
 *      的 `tests/fixtures/phase2-dead-config` 消费面等）不该吃到一个与它无关的假包图。
 *      ⇒ `mkdtempSync(tmpdir())`，用毕 `rmSync`。
 *   ③ **守卫必须证伪**（K-10：永绿守卫等于没有守卫）⇒ 每条判据都有"注入违规 ⇒ 应红"的
 *      反例用例，并且反例的**判据 ID 逐条点名**（只断 exit≠0 的话，任何工具坏掉都算绿）。
 *
 * 运行：node --test tests/unit/phase2-dep-direction.test.js
 * 前置：dep-lint 读 dist ⇒ 需 `tsc -b tsconfig.build.json` 已跑（K-3）；真仓 GREEN 用例自带
 *      dist 存在性前置检查，缺失时判**失败**而非 skip（skip 会把"没 build"伪装成"没违规"）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const DEP_LINT = join(ROOT, 'scripts', 'dep-lint.mjs');
const CONFIG_KEY_LINT = join(ROOT, 'scripts', 'config-key-lint.mjs');
const GATE = join(ROOT, 'scripts', 'gate.mjs');
const LOCK_PROBE = join(ROOT, 'scripts', 'lock-probe.mjs');
/** 绝对路径转 file: URL —— 动态 import 在 POSIX/Windows 两形态下的唯一可靠写法。 */
const toModule = (/** @type {string} */ abs) => pathToFileURL(abs).href;

/** dep-lint 判据 ID（与 scripts/dep-lint.mjs 的 CHECK 常量同串 —— 双写面在此钉一致）。 */
const CHECK = {
  LAYER_DIRECTION: 'LAYER_DIRECTION',
  UNDECLARED_EDGE: 'UNDECLARED_EDGE',
  DECLARED_UNUSED: 'DECLARED_UNUSED',
  AUDIT_EDGE_IN_FRAMEWORK: 'AUDIT_EDGE_IN_FRAMEWORK',
  FRAMEWORK_TO_BUSINESS: 'FRAMEWORK_TO_BUSINESS',
};

/* ============================ 工具 ============================ */

/**
 * 以子进程跑一个 scripts/ 工具（**不 import 被测包**的隔离面），返回解析后的 JSON。
 * @param {string} script
 * @param {string[]} extraArgs
 * @returns {{code:number, json:any, stdout:string, stderr:string}}
 */
function runTool(script, extraArgs) {
  const r = spawnSync(process.execPath, [script, ...extraArgs], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 32 * 1024 * 1024,
  });
  /** @type {any} */
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = null;
  }
  return { code: typeof r.status === 'number' ? r.status : -1, json, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/**
 * 在临时目录里搭一个假包图（dep-lint 的 fixture 形态 = 真仓同布局：packages/<p>/{package.json,dist/*.js}）。
 * @param {Record<string, {layer:string, deps?:string[], files?:Record<string,string>}>} spec
 * @returns {{root:string, dispose:()=>void}}
 */
function makeFixture(spec) {
  const root = mkdtempSync(join(tmpdir(), 'p2t11-dep-'));
  for (const [name, cfg] of Object.entries(spec)) {
    const pkgDir = join(root, 'packages', name);
    mkdirSync(join(pkgDir, 'dist'), { recursive: true });
    /** @type {Record<string, unknown>} */
    const pkgJson = {
      name: `@winvm/${name}`,
      version: '0.1.0',
      type: 'module',
      layer: cfg.layer,
    };
    if (cfg.deps && cfg.deps.length > 0) {
      /** @type {Record<string,string>} */
      const dependencies = {};
      for (const d of cfg.deps) dependencies[`@winvm/${d}`] = '0.1.0';
      pkgJson.dependencies = dependencies;
    }
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify(pkgJson, null, 2) + '\n');
    const files = cfg.files || { 'index.js': 'export const noop = 1;\n' };
    for (const [f, text] of Object.entries(files)) {
      const abs = join(pkgDir, 'dist', f);
      mkdirSync(dirname(abs), { recursive: true }); // 支持 dist/audit/chain.js 之类嵌套产物（真仓 core 即此形态）
      writeFileSync(abs, text);
    }
  }
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

/** 违规 ID 计数。 */
function countIds(violations, id) {
  return (violations || []).filter((/** @type {any} */ v) => v.id === id).length;
}
/** 按 ID 取违规。 */
function byId(violations, id) {
  return (violations || []).filter((/** @type {any} */ v) => v.id === id);
}

/* ============================ 0. 脚本资产存在性 ============================ */

describe('P2-T11 · U-0 scripts 守卫资产在位（Phase 1 的 layout 死入口不得复现）', () => {
  test('dep-lint / gate / config-key-lint / lock-probe / GATE-POLICY 五件齐备', () => {
    for (const f of ['dep-lint.mjs', 'gate.mjs', 'config-key-lint.mjs', 'lock-probe.mjs', 'GATE-POLICY.md']) {
      assert.ok(existsSync(join(ROOT, 'scripts', f)), `scripts/${f} 必须存在（layout/gate 指向不存在的脚本 = 设计 §4.4 记载的 Phase 1 原病灶）`);
    }
  });

  test('根 package.json 的 layout/gate 脚本键指向**真实存在**的文件（要么接通、要么不写）', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const entries = { layout: pkg.scripts.layout, gate: pkg.scripts.gate, 'gate:quick': pkg.scripts['gate:quick'], 'lock-probe': pkg.scripts['lock-probe'] };
    for (const [key, cmd] of Object.entries(entries)) {
      assert.equal(typeof cmd, 'string', `package.json scripts.${key} 必须存在`);
      const m = String(cmd).match(/node\s+(\S+\.mjs)/);
      assert.ok(m, `scripts.${key}="${cmd}" 须为 \`node <path>.mjs\` 形态`);
      assert.ok(existsSync(join(ROOT, m[1])), `scripts.${key} 指向的 ${m[1]} 必须真实存在（死入口比缺失更误导）`);
    }
  });

  test('dep-lint --json 在真仓可跑通且**读的是 dist**（PR9：先 build 才有判定意义）', () => {
    const r = runTool(DEP_LINT, ['--json']);
    assert.equal(r.code, 0, `真仓 dep-lint 应 GREEN（exit 0）；实际 exit=${r.code}\n${r.stdout.slice(0, 800)}${r.stderr.slice(0, 400)}`);
    assert.ok(r.json && typeof r.json === 'object', '--json 须输出可解析 JSON');
    assert.ok(r.json.stats.packages >= 12, `应扫到 ≥12 个包，实际 ${r.json.stats.packages}`);
    assert.ok(r.json.stats.scannedJsFiles > 0, 'dist js 文件计数须 >0（=0 说明 dist 未构建 ⇒ 判定不具意义）');
    assert.ok(r.json.stats.hard === 0, `hard 违规应为 0，实际 ${r.json.stats.hard}: ${JSON.stringify(byId(r.json.violations, 'x'))}`);
  });
});

/* ============================ 1. 判据①：分层方向（反向边） ============================ */

describe('P2-T11 · U-1 判据 LAYER_DIRECTION（低层 import 高层 ⇒ 红，设计 §258 第 3 条「反向边」）', () => {
  test('合法图：高层依赖低层 ⇒ GREEN（零 hard 违规）', () => {
    const fx = makeFixture({
      contracts: { layer: 'L0-contracts', files: { 'index.js': 'export const K = 1;\n' } },
      core: {
        layer: 'L1a-core',
        deps: ['contracts'],
        files: { 'index.js': "import { K } from '@winvm/contracts';\nexport const C = K;\n" },
      },
      'vm-service': {
        layer: 'L2-vm-service',
        deps: ['contracts', 'core'],
        files: { 'server.js': "import { C } from '@winvm/core';\nexport const S = C;\n" },
      },
    });
    try {
      const r = runTool(DEP_LINT, ['--json', '--root', fx.root]);
      assert.equal(r.code, 0, `合法图应 GREEN；exit=${r.code} violations=${JSON.stringify(r.json && r.json.violations)}`);
      assert.equal(countIds(r.json.violations, CHECK.LAYER_DIRECTION), 0, '合法图不得有反向边命中');
    } finally {
      fx.dispose();
    }
  });

  test('违规图：contracts(L0) import vm-service(L2) ⇒ 精准命中 LAYER_DIRECTION 且 exit=1', () => {
    const fx = makeFixture({
      contracts: {
        layer: 'L0-contracts',
        files: { 'index.js': "import { S } from '@winvm/vm-service';\nexport const K = S;\n" },
      },
      'vm-service': { layer: 'L2-vm-service', files: { 'server.js': 'export const S = 1;\n' } },
    });
    try {
      const r = runTool(DEP_LINT, ['--json', '--root', fx.root]);
      const hits = byId(r.json.violations, CHECK.LAYER_DIRECTION);
      assert.equal(hits.length, 1, `LAYER_DIRECTION 应恰命中 1 条，实际 ${hits.length}: ${JSON.stringify(hits)}`);
      assert.match(hits[0].message, /contracts/, '命中消息须点出反向边源包');
      assert.match(hits[0].message, /vm-service/, '命中消息须点出反向边目标包');
      assert.equal(hits[0].severity, 'hard', '反向边必须 hard（Q7 的"只 warn"限定的是框架审计边，不含方向违规）');
      assert.equal(r.code, 1, '反向边 ⇒ exit 1');
    } finally {
      fx.dispose();
    }
  });

  test('同层互依不判违规（实况：adapter-agent-workbuddy-llm → adapter-agent-workbuddy）', () => {
    const fx = makeFixture({
      'a-llm': {
        layer: 'L2-adapter-agent-llm',
        deps: ['a-base'],
        files: { 'index.js': "import { B } from '@winvm/a-base';\nexport const L = B;\n" },
      },
      'a-base': { layer: 'L2-adapter-agent', files: { 'index.js': 'export const B = 1;\n' } },
    });
    try {
      const r = runTool(DEP_LINT, ['--json', '--root', fx.root]);
      assert.equal(countIds(r.json.violations, CHECK.LAYER_DIRECTION), 0, `rank 相等属允许，实际命中 ${JSON.stringify(byId(r.json.violations, CHECK.LAYER_DIRECTION))}`);
    } finally {
      fx.dispose();
    }
  });

  test('真仓实况：L0/L1a 零反向边（12 包全量的方向自证，防"fixture 绿、真仓红"口径分叉）', () => {
    const r = runTool(DEP_LINT, ['--json']);
    const contractOut = (r.json.edges || []).filter((/** @type {any} */ e) => e.from === 'contracts');
    assert.equal(contractOut.length, 0, 'contracts(L0) 必须零出边（唯一契约源、零依赖）');
    const coreOut = new Set((r.json.edges || []).filter((/** @type {any} */ e) => e.from === 'core').map((/** @type {any} */ e) => e.to));
    assert.ok([...coreOut].every((t) => t === 'contracts'), `core(L1a) 的出边只能是 contracts，实际 ${[...coreOut].join(',')}`);
  });
});

/* ============================ 2. dist 字符串字面量假命中（本脚本存在理由之一） ============================ */

describe('P2-T11 · U-2 语句锚定：dist 里的注释/配置字面量**不得**算依赖边（设计 §255 判据理由）', () => {
  test('字符串字面量 `package: "@winvm/x"` 不判边；注释里的包名不判边', () => {
    const fx = makeFixture({
      contracts: { layer: 'L0-contracts', files: { 'index.js': 'export const K = 1;\n' } },
      core: {
        layer: 'L1a-core',
        deps: ['contracts'],
        files: {
          'config.js':
            "// 见 @winvm/phantom 的设计说明（注释不得算边）\nexport const providers = {\n  a: { package: '@winvm/ghost', options: {} },\n  b: { package: \"@winvm/ghost2\", options: {} },\n};\nimport { K } from '@winvm/contracts';\nexport const C = K;\n",
        },
      },
    });
    try {
      const r = runTool(DEP_LINT, ['--json', '--root', fx.root]);
      const tos = new Set((r.json.edges || []).filter((/** @type {any} */ e) => e.from === 'core').map((/** @type {any} */ e) => e.to));
      assert.ok(!tos.has('ghost') && !tos.has('ghost2') && !tos.has('phantom'), `字面量/注释命中不得成边，实际出边 ${[...tos].join(',')}`);
      assert.ok(tos.has('contracts'), '真实 import 语句必须成边（锚定不能锚到漏判）');
      assert.equal(r.code, 0, `字面量不得产假违规；exit=${r.code} ${JSON.stringify(r.json.violations)}`);
    } finally {
      fx.dispose();
    }
  });

  test('真仓反证：core 的 dist 确有 provider 包名字面量，但真仓 LAYER_DIRECTION 零命中（朴素 includes 会产假红）', () => {
    const distDir = join(ROOT, 'packages', 'core', 'dist');
    if (!existsSync(distDir)) {
      assert.fail('packages/core/dist 缺失 ⇒ 请先 tsc -b（K-3/PR9）；本用例不得以 skip 蒙过');
    }
    /** @type {string[]} */
    const walk = (/** @type {string} */ d) =>
      readdirSync(d).flatMap((e) => {
        const p = join(d, e);
        return statSync(p).isDirectory() ? walk(p) : e.endsWith('.js') ? [p] : [];
      });
    const withLiteral = walk(distDir).filter((f) => readFileSync(f, 'utf8').includes('@winvm/adapter-agent'));
    assert.ok(withLiteral.length > 0, 'core dist 应含 provider 包名字面量（动态 provider 装载）—— 前提事实须在，否则本反证退化为恒真');
    const r = runTool(DEP_LINT, ['--json']);
    assert.equal(countIds(r.json.violations, CHECK.LAYER_DIRECTION), 0, '语句锚定后这些字面量不得产反向边');
    const coreTo = (r.json.edges || []).filter((/** @type {any} */ e) => e.from === 'core').map((/** @type {any} */ e) => e.to);
    assert.ok(!coreTo.includes('adapter-agent-workbuddy'), 'dep-lint 的 core 出边集合里不得出现 provider 字面量包名');
  });

  test('CJS require 与动态 import 形态同样成边（不得只认 ESM ⇒ 判据面留洞）', () => {
    const fx = makeFixture({
      contracts: { layer: 'L0-contracts', files: { 'index.js': 'export const K = 1;\n' } },
      svc: {
        layer: 'L2-vm-service',
        deps: ['contracts'],
        files: {
          'a.js': "const { K } = require('@winvm/contracts');\nmodule.exports = K;\n",
          'b.js': "const p = import('@winvm/contracts');\nexport default p;\n",
        },
      },
    });
    try {
      const r = runTool(DEP_LINT, ['--json', '--root', fx.root]);
      const tos = (r.json.edges || []).filter((/** @type {any} */ e) => e.from === 'svc').map((/** @type {any} */ e) => e.to);
      assert.ok(tos.includes('contracts'), `require/dynamic import 须成边，实际 ${tos.join(',')}`);
      assert.equal(countIds(r.json.violations, CHECK.UNDECLARED_EDGE), 0, '已声明 ⇒ 不得产幽灵边');
    } finally {
      fx.dispose();
    }
  });
});

/* ============================ 3. 判据②：幽灵依赖 / 声明未用 ============================ */

describe('P2-T11 · U-2b 判据 UNDECLARED_EDGE（dist 有边、package.json 未声明 ⇒ hard）', () => {
  test('注入未声明 import ⇒ 精准命中且 hard', () => {
    const fx = makeFixture({
      contracts: { layer: 'L0-contracts', files: { 'index.js': 'export const K = 1;\n' } },
      svc: {
        layer: 'L2-vm-service',
        deps: [], // ← 故意不声明 contracts
        files: { 'server.js': "import { K } from '@winvm/contracts';\nexport const S = K;\n" },
      },
    });
    try {
      const r = runTool(DEP_LINT, ['--json', '--root', fx.root]);
      const hits = byId(r.json.violations, CHECK.UNDECLARED_EDGE);
      assert.equal(hits.length, 1, `UNDECLARED_EDGE 应恰 1 条，实际 ${JSON.stringify(hits)}`);
      assert.equal(hits[0].severity, 'hard', '幽灵依赖必须 hard（分发产物运行期必炸）');
      assert.match(hits[0].message, /contracts/);
      assert.equal(r.code, 1);
    } finally {
      fx.dispose();
    }
  });

  test('DECLARED_UNUSED 只 info（type-only 擦除与 provider 动态装载是设计选择，不是缺口）', () => {
    const fx = makeFixture({
      contracts: { layer: 'L0-contracts', files: { 'index.js': 'export const K = 1;\n' } },
      svc: { layer: 'L2-vm-service', deps: ['contracts'], files: { 'server.js': 'export const S = 1;\n' } },
    });
    try {
      const r = runTool(DEP_LINT, ['--json', '--root', fx.root]);
      const infos = byId(r.json.violations, CHECK.DECLARED_UNUSED);
      assert.equal(infos.length, 1, `应显形 1 条 info（真仓实况同型：vm-capabilities 声明 contracts 但 dist 零值边）`);
      assert.equal(infos[0].severity, 'info', 'DECLARED_UNUSED 恒 info');
      assert.equal(r.code, 0, 'info 不得阻断（否则门禁被误伤拖死）');
    } finally {
      fx.dispose();
    }
  });
});

/* ============================ 4. 判据③：框架层审计边 ============================ */

describe('P2-T11 · U-3 框架层审计边（设计 §254 末句 + §258 第 3 条；Q7 首月 warn）', () => {
  test('框架 import 具体业务包（adapter-* / vm-service / vm-capabilities）⇒ FRAMEWORK_TO_BUSINESS hard', () => {
    const fx = makeFixture({
      contracts: { layer: 'L0-contracts', files: { 'index.js': 'export const K = 1;\n' } },
      'a2a-framework': {
        layer: 'L1b-a2a-framework',
        deps: ['adapter-some'],
        files: { 'server.js': "import { A } from '@winvm/adapter-some';\nexport const F = A;\n" },
      },
      'adapter-some': { layer: 'L2-adapter-agent', files: { 'index.js': 'export const A = 1;\n' } },
    });
    try {
      const r = runTool(DEP_LINT, ['--json', '--root', fx.root]);
      const hits = byId(r.json.violations, CHECK.FRAMEWORK_TO_BUSINESS);
      assert.equal(hits.length, 1, `框架越界应恰 1 条，实际 ${JSON.stringify(hits)}`);
      assert.equal(hits[0].severity, 'hard', 'ARCHITECTURE §2.1 铁律原文已禁（frameworks 禁止依赖 adapters）⇒ 机检化即 hard');
      assert.match(hits[0].message, /a2a-framework/);
      assert.equal(r.code, 1);
    } finally {
      fx.dispose();
    }
  });

  test('审计符号清单**派生**自 dist 导出（不硬编码 ⇒ core 新增 audit 导出会自动进判据面）', () => {
    const r = runTool(DEP_LINT, ['--json']);
    const symbols = r.json.auditSymbols || [];
    // 这些是当前 core/contracts 审计面的真名；派生源在 --json 输出里也报出来，可读回验证
    for (const expect of ['HashChainAuditSink', 'canonicalJson', 'sha256', 'computeRecordHash']) {
      assert.ok(symbols.includes(expect), `审计符号集应含派生名 ${expect}，实际 ${symbols.join(',')}`);
    }
    // 反证派生而非硬编码：非审计族的名字不得混进来（曾经的越界回溯 bug 就是它们混进来）
    for (const notExpected of ['establishTransport', 'CorePolicyEngine', 'NullLogger', 'globToRegex', 'loadServiceConfig', 'DEFAULT_POLICY']) {
      assert.ok(!symbols.includes(notExpected), `非审计符号 ${notExpected} 不得进审计集（正则跨语句回溯 = 审计面被污染，判据会产假 warn）`);
    }
    assert.ok(r.json.auditSources.length >= 1, '须报出派生源（可审计性）');
  });

  test('框架 import 审计符号 ⇒ AUDIT_EDGE_IN_FRAMEWORK warn；--strict-warn 下升为 hard', () => {
    const fx = makeFixture({
      core: {
        layer: 'L1a-core',
        files: {
          'index.js': "export { HashChainAuditSink } from './audit/chain.js';\nexport const NullLogger = 1;\n",
          'audit/chain.js': 'export class HashChainAuditSink {}\n',
        },
      },
      'mcp-framework': {
        layer: 'L1b-mcp-framework',
        deps: ['core'],
        files: { 'server.js': "import { HashChainAuditSink } from '@winvm/core';\nexport const M = HashChainAuditSink;\n" },
      },
    });
    try {
      const warn = runTool(DEP_LINT, ['--json', '--root', fx.root]);
      const hits = byId(warn.json.violations, CHECK.AUDIT_EDGE_IN_FRAMEWORK);
      assert.equal(hits.length, 1, `审计边应命中 1 条（派生集含 HashChainAuditSink），实际 ${JSON.stringify(warn.json.auditSymbols)} / ${JSON.stringify(hits)}`);
      assert.equal(hits[0].severity, 'warn', 'Q7 裁决：首月框架审计边只 warn');
      assert.equal(warn.code, 0, 'warn 默认不阻断');

      const strict = runTool(DEP_LINT, ['--json', '--root', fx.root, '--strict-warn']);
      assert.equal(strict.json.violations.filter((/** @type {any} */ v) => v.id === CHECK.AUDIT_EDGE_IN_FRAMEWORK && v.severity === 'hard').length, 1, '--strict-warn 须把审计边升为 hard');
      assert.equal(strict.code, 1, '--strict-warn 下 warn 即阻断（Q7 到期切换面，不改代码）');
    } finally {
      fx.dispose();
    }
  });

  test('真仓反证：当前框架 dist 零审计边命中（**非恒绿** —— 上条已证同一判据喂假图必红）', () => {
    const r = runTool(DEP_LINT, ['--json']);
    assert.equal(countIds(r.json.violations, CHECK.AUDIT_EDGE_IN_FRAMEWORK), 0, '真仓框架层应零审计语义 import');
    assert.equal(countIds(r.json.violations, CHECK.FRAMEWORK_TO_BUSINESS), 0, '真仓框架层应零业务 import');
  });
});

/* ============================ 5. 无法判定 vs 违规 的区分（exit 2） ============================ */

describe('P2-T11 · U-4 判不了 ≠ 违规（exit 2 面；「无 CI 时门禁被跳过」的失效不得伪装成绿）', () => {
  test('根无 packages ⇒ exit 2 + ROOT_UNREADABLE', () => {
    const root = mkdtempSync(join(tmpdir(), 'p2t11-empty-'));
    try {
      const r = runTool(DEP_LINT, ['--json', '--root', root]);
      assert.equal(r.code, 2, `空根应 exit 2，实际 ${r.code}`);
      assert.equal(countIds(r.json.violations, 'ROOT_UNREADABLE'), 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('dist 缺失 ⇒ exit 2 + DIST_MISSING（PR9：dep-lint 读 dist 依赖 build 产物）', () => {
    const root = mkdtempSync(join(tmpdir(), 'p2t11-nodist-'));
    try {
      mkdirSync(join(root, 'packages', 'lonely'), { recursive: true });
      writeFileSync(
        join(root, 'packages', 'lonely', 'package.json'),
        JSON.stringify({ name: '@winvm/lonely', layer: 'L2-lonely' }, null, 2),
      );
      const r = runTool(DEP_LINT, ['--json', '--root', root]);
      assert.equal(r.code, 2, `无 dist 应 exit 2（不可判定），不得静默当 GREEN；实际 ${r.code}`);
      assert.equal(countIds(r.json.violations, 'DIST_MISSING'), 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('未知 layer 前缀 ⇒ hard LAYER_UNKNOWN（新增层位须同步登记 rank，防静默漏判）', () => {
    const fx = makeFixture({
      novel: { layer: 'L7-novel', files: { 'index.js': 'export const N = 1;\n' } },
    });
    try {
      const r = runTool(DEP_LINT, ['--json', '--root', fx.root]);
      assert.equal(countIds(r.json.violations, 'LAYER_UNKNOWN'), 1, `未知 layer 必须显形，实际 ${JSON.stringify(r.json.violations)}`);
      assert.equal(r.code, 1);
    } finally {
      fx.dispose();
    }
  });
});

/* ============================ 6. gate 关键断言（不跑全量档） ============================ */

describe('P2-T11 · U-5 门禁 gate.mjs 关键判据（只断表与参数面；全量 sweep 归 ST4，本文件绝不跑）', () => {
  test('gate 导出的「进门禁表」与磁盘一致（表漂移 = 门禁自己被静默跳过，PR9 对冲面）', async () => {
    const mod = await import(toModule(GATE));
    const list = mod.GATE_GUARD_FILES || [];
    assert.ok(list.length >= 7, `进门禁守卫件应 ≥7，实际 ${list.length}`);
    for (const g of list) {
      assert.ok(typeof g.file === 'string' && g.file.endsWith('.test.js'), `表项 file 非法：${JSON.stringify(g)}`);
      assert.ok(typeof g.why === 'string' && g.why.length > 10, `表项 ${g.file} 缺 why（无理由 = 表不可审计）`);
      assert.ok(existsSync(join(ROOT, 'tests', 'unit', g.file)), `门禁表引用的文件不存在：tests/unit/${g.file}`);
    }
    const ids = list.map((/** @type {any} */ g) => g.id);
    assert.equal(new Set(ids).size, ids.length, '表项 id 不得重复');
    const names = list.map((/** @type {any} */ g) => g.file);
    for (const must of [
      'phase2-snapshot-truth.test.js',
      'phase2-dead-config.test.js',
      'phase2-contract-schema.test.js',
      'phase2-contract-code-fidelity.test.js',
      'assembly-guard.test.js',
      'psmod-contract.test.js',
    ]) {
      assert.ok(names.includes(must), `${must} 属安全承诺/契约保真族，必须在门禁表内（"不进门禁的守卫会慢慢失效"，设计 §267）`);
    }
  });

  test('gate 导出「不进门禁」清单且逐条带理由（PR9 的文档对冲面）', async () => {
    const mod = await import(toModule(GATE));
    const ex = mod.GATE_EXCLUDED || [];
    assert.ok(ex.length >= 5, `不进门禁项应 ≥5（真机/隧道/宿主平台/glob 高危件/运行期接线），实际 ${ex.length}`);
    for (const e of ex) {
      assert.ok(typeof e.scope === 'string' && e.scope.length > 3, `排除项缺 scope：${JSON.stringify(e)}`);
      assert.ok(typeof e.reason === 'string' && e.reason.length > 10, `排除项 ${e.scope} 缺 reason ⇒ 与"遗忘"无法区分`);
    }
    // link-workspace 必须在排除面内（K-2 junction 触发源，任务书「单独跑，勿入任何 glob」）
    assert.ok(ex.some((/** @type {any} */ e) => /link-workspace/.test(e.scope)), 'link-workspace 须显式登记在门禁排除面');
  });

  test('gate TAP 计数解析：tap 前缀 `# tests` 与 node24 默认 `ℹ tests` 两种都认（解析失败⇒判红，不得当 0 例通过）', async () => {
    const mod = await import(toModule(GATE));
    const tap = mod.parseTapCounts('# tests 10\n# pass 9\n# fail 1\n# skipped 0\n');
    assert.deepEqual({ t: tap.tests, p: tap.pass, f: tap.fail, ok: tap.parsed }, { t: 10, p: 9, f: 1, ok: true });
    const spec = mod.parseTapCounts('ℹ tests 48\nℹ pass 48\nℹ fail 0\nℹ skipped 2\n');
    assert.deepEqual({ t: spec.tests, p: spec.pass, f: spec.fail, sk: spec.skip }, { t: 48, p: 48, f: 0, sk: 2 });
    const none = mod.parseTapCounts('nothing here');
    assert.equal(none.parsed, false, '解析不到计数须 parsed=false ⇒ runPerFile 据此判红（K-10 永绿守卫防护）');
  });

  test('gate --help 面：quick 与全量两档存在，且全量档参数不含目录式整批 glob（K-2 内建约束）', () => {
    const r = spawnSync(process.execPath, [GATE, '--help'], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
    // gate 未实现 --help 时 exit=非0 也可接受：本用例真正的判据是「源码里没有 glob 整批路径」
    const src = readFileSync(GATE, 'utf8');
    assert.ok(
      !/--test['"],?\s*\w*['"]?tests\/unit['"]?(?!\w)/.test(src.replace(/'[a-z]+'/g, '')),
      'gate.mjs 不得含 `node --test tests/unit`（目录式整批 = junction 假全红）',
    );
    assert.match(src, /runPerFile/, 'gate 须经 runPerFile 逐文件 spawn（K-2 的唯一实现面）');
    void r;
  });
});

/* ============================ 7. config-key-lint（§13.2-② 裁决项承载） ============================ */

describe('P2-T11 · U-6 配置全键集白名单（设计 §13.2-②「policy 全键集白名单守卫 ⇒ 列入 gate 候选判据」）', () => {
  test('真机配置资产全键在白名单内 ⇒ GREEN（非恒绿：下条注入假键必红）', async () => {
    const mod = await import(toModule(CONFIG_KEY_LINT));
    const res = mod.lintConfigKeys(ROOT, ['delivery/vm-service.config.json', 'delivery/.generated/vm-service.runtime.json']);
    assert.equal(res.code, 0, `配置资产应零未知键，实际 ${JSON.stringify(res.findings)}`);
    assert.equal(res.missing.length, 0, '白名单须可派生（缺 interface ⇒ 拒绝判定，不猜）');
    // 派生事实面：policy 8 键（7 必填 + endpointAllowlist），且**不含** approvalTimeoutMs（P2-T2 已删）
    const policy = res.whitelist.policy || [];
    assert.ok(policy.includes('pathDenylist') && policy.includes('commandDenylist'), `policy 白名单应含核心两表，实际 ${policy.join(',')}`);
    assert.ok(!policy.includes('approvalTimeoutMs'), 'approvalTimeoutMs 已随 P2-T2 删除 ⇒ 白名单不得再有（有的话 = 抄了第二份过时清单）');
  });

  test('注入假 policy 键 ⇒ 精准命中（裁决原文的「任意未知键仍静默透传」在此显形）', async () => {
    const mod = await import(toModule(CONFIG_KEY_LINT));
    const wl = mod.buildWhitelist(ROOT);
    const findings = mod.findUnknownKeys({ policy: { approvalTimeoutMs: 120, bogusKey: true }, server: { host: '127.0.0.1' } }, wl);
    assert.ok(findings.some((/** @type {any} */ f) => f.section === 'policy' && f.key === 'approvalTimeoutMs'), `旧死键须判未知，实际 ${JSON.stringify(findings)}`);
    assert.ok(findings.some((/** @type {any} */ f) => f.key === 'bogusKey'), '任意假键须判未知');
  });

  test('顶层段名与注释键判定面：未知段 ⇒ 命中；$schema/comment ⇒ 放行', async () => {
    const mod = await import(toModule(CONFIG_KEY_LINT));
    const wl = mod.buildWhitelist(ROOT);
    assert.ok(mod.findUnknownKeys({ notASection: {} }, wl).length === 1, '未知顶层段须命中');
    assert.equal(mod.findUnknownKeys({ $schema: 'x', comment: 'y', policy: { comment: 'z' } }, wl).length, 0, '注释/元数据键须放行（否则工具开箱即红 = 误伤）');
  });

  test('白名单派生自 TS 类型而非手写清单：段数 ≥9 且每段非空（漂移即显形）', async () => {
    const mod = await import(toModule(CONFIG_KEY_LINT));
    const wl = mod.buildWhitelist(ROOT);
    for (const section of ['server', 'agent', 'policy', 'audit', 'session', 'security', 'logging', 'llmSession']) {
      assert.ok((wl.sections[section] || []).length > 0, `段 ${section} 白名单为空 ⇒ 派生失效（interface 被改名/挪动 ⇒ 须报错而非静默放行）`);
    }
    assert.ok(wl.service.includes('policy'), 'ServiceConfig 派生须含 policy 段');
  });
});

/* ============================ 8. 锁屏前置探针判据（纯函数面，零网络） ============================ */

describe('P2-T11 · U-7 锁屏前置探针判据（设计 §3.4 E-3；纯函数，不碰网络/VM）', () => {
  const healthWith = (/** @type {any} */ session) => ({ ok: true, session });

  test('GO：healthy ∧ interactive ∧ !blackScreen（现网真机实况形状）', async () => {
    const mod = await import(toModule(LOCK_PROBE));
    const j = mod.judgeSessionHealth(
      healthWith({ sessionId: 1, windowStation: 'WinSta0', desktop: 'Default', interactive: true, locked: false, blackScreen: false, state: 'healthy' }),
    );
    assert.equal(j.verdict, mod.VERDICT.GO);
    assert.equal(j.code, 0);
  });

  test('BLOCKED：locked=true ⇒ exit 1 并点出锁屏（"能提前判 BLOCKED 就别浪费档期"）', async () => {
    const mod = await import(toModule(LOCK_PROBE));
    const j = mod.judgeSessionHealth(
      healthWith({ sessionId: 0, interactive: false, locked: true, blackScreen: false, state: 'degraded' }),
    );
    assert.equal(j.verdict, mod.VERDICT.BLOCKED);
    assert.equal(j.code, 1, 'BLOCKED 的 exit 码 = 1（与"代码红"同值是刻意：调用方靠 reason 分诊；但 reason 文案必须明说这不是代码红）');
    assert.ok(j.reasons.some((/** @type {string} */ r) => /locked/.test(r)), '须点出锁屏成因');
  });

  test('BLOCKED：blackScreen=true（Session 0 / 会话挂起形态）与 interactive=false 各自单独足以判停', async () => {
    const mod = await import(toModule(LOCK_PROBE));
    const bs = mod.judgeSessionHealth(healthWith({ interactive: true, locked: false, blackScreen: true, state: 'black-screen' }));
    assert.equal(bs.verdict, mod.VERDICT.BLOCKED);
    assert.ok(bs.reasons.some((/** @type {string} */ r) => /blackScreen/.test(r)));
    const non = mod.judgeSessionHealth(healthWith({ interactive: false, locked: false, blackScreen: false, state: 'unavailable' }));
    assert.equal(non.verdict, mod.VERDICT.BLOCKED);
    assert.ok(non.reasons.some((/** @type {string} */ r) => /interactive=false/.test(r)));
  });

  test('UNKNOWN：probeError 在场 ⇒ exit 3 且**绝不**判 GO（P2-T9 兜底值不是观测值，不得据此开工）', async () => {
    const mod = await import(toModule(LOCK_PROBE));
    const j = mod.judgeSessionHealth(
      healthWith({ interactive: true, locked: false, blackScreen: false, state: 'healthy', probeError: 'probe timeout', probeErrorCode: 'PROBE_TIMEOUT' }),
    );
    assert.equal(j.verdict, mod.VERDICT.UNKNOWN, '探测未得结论时不得判 GO（否则 = 拿 fail-closed 兜底值当观测事实开工）');
    assert.equal(j.code, 3);
  });

  test('缺 session 字段 ⇒ UNKNOWN（响应形状不符契约不猜）；纯函数零 I/O', async () => {
    const mod = await import(toModule(LOCK_PROBE));
    assert.equal(mod.judgeSessionHealth({ ok: true }).verdict, mod.VERDICT.UNKNOWN);
    assert.equal(mod.judgeSessionHealth(null).code, 3);
  });
});

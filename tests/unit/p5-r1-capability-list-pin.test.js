/**
 * Phase 5 残项 R1 · `meta.capability.list` 名实对齐（B-4，方案 A：Node 侧注册表直供）
 *
 * ## 钉的是什么
 * 旧病灶：注册表 description 承诺「列出当前已注册并暴露的能力清单」，但绑定
 * `__meta.listModules` 的实际应答来自 ps-bridge.ps1 的 listModules 分支——**扫 ps1
 * 文件名返回模块名**（`["app","appops","gui","storage","system"]`），不是能力 ID 清单。
 * 修法（照 D5 healthCheck 先例）：provider 在 `execute()` 的 `__meta` 拦截链上追加
 * `capabilityList` 分支，从注册表直供 `{ok, count, capabilities:[{id,name,risk}], domains}`；
 * 暴露面 = `WINDOWS_CAPABILITIES` ∩ `declareCapabilities()`，与服务端
 * `exposedCapabilities = registry.intersectDeclared(provider.declareCapabilities())`
 * **同一算法同一数据源** ⇒ 与 MCP `tools/list` 逐条一致。psmod `listModules` 分支
 * 保留为内部诊断面（注册表不再路由到它）。
 *
 * ## 判据（五条，全离线）
 *  A1 注册表绑定：`meta.capability.list` → `__meta.capabilityList`（dist 真实装载物）；
 *     description 逐字 = 「列出当前已注册并暴露的能力清单」（不改即兑现）；
 *  A2 provider 行为：execute 该能力 ⇒ 零桥往返 + 每条含 id/name/risk + count=全暴露面数
 *     （deterministic 声明六域通配 ⇒ 54）+ 无旧 `modules` 键；
 *  A3 一致性：返回 ID 集 == `WINDOWS_CAPABILITIES` 全集（∩ 全通配声明 = 恒等），排序稳定；
 *  A4 拦截定向性：非 `__meta` 能力照常走 bridge.call（拦截不是总闸）；
 *     `definitions.ts` 不再出现 `fn: 'listModules'`，而 ps-bridge.ps1 的
 *     `'listModules' {` 分支**仍在**（诊断面保留，删了=psmod 面漂移）。
 *  A5 同源假设防漂移：三个 provider（deterministic / llm / hermes）的
 *     `declareCapabilities()` 通配集必须同含六域——`buildCapabilityList` 用自身声明求交，
 *     未来某家收窄声明而未接差异进该函数 ⇒ 本条显形（登记红，不许静默失真）。
 *
 * 纪律：不碰 VM / PowerShell / HTTP；import dist 产物（O-3 范式）；SKILL 文本是
 * phase3-skill-claims-guard 的输入面，本文件只读不写。
 * 运行（只跑本文件，绝不整批）：
 *   node --test tests/unit/p5-r1-capability-list-pin.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = join(import.meta.dirname, '..', '..');
const src = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const { DeterministicAgentProvider } = await import(
  pathToFileURL(join(ROOT, 'packages', 'adapter-agent-workbuddy', 'dist', 'index.js')).href
);
const { WINDOWS_CAPABILITIES } = await import(
  pathToFileURL(join(ROOT, 'packages', 'vm-capabilities', 'dist', 'registry', 'definitions.js')).href
);
// V-NEXT 2.5（方案 B）：capability.list 的权威源已从 WINDOWS_CAPABILITIES 换成 UNIFIED_CAPABILITIES
const { UNIFIED_CAPABILITIES } = await import(
  pathToFileURL(join(ROOT, 'packages', 'vm-capabilities', 'dist', 'registry', 'unified.js')).href
);
const { UNIFIED_TOTAL, SURFACE_EXPECTED_COUNTS } = await import(
  pathToFileURL(join(ROOT, 'packages', 'contracts', 'dist', 'unified.js')).href
);

/* ============================ 夹具（与 cl017-param-guard 同形） ============================ */

/** provider `implementationOf`/`definitionOf` 的权威源：真实注册表切片 */
const capabilityDefs = new Map(
  WINDOWS_CAPABILITIES.map((d) => [d.id, d]),
);

function makeBridge() {
  const calls = [];
  return {
    calls,
    running: true,
    uptimeMs: 1,
    async start() {},
    async stop() {},
    async call(module, fn, params) {
      calls.push({ module, fn, params });
      return { fromBridge: true, module, fn };
    },
    health() {
      return { state: 'ready', uptimeMs: 1, pending: 0, lastHeartbeatAgoMs: 0 };
    },
  };
}

async function makeProvider() {
  const bridge = makeBridge();
  const ctx = {
    config: {},
    audit: {
      append: async () => ({ hash: 'h', prevHash: '', seq: 0, auditId: 'aud_x' }),
      verifyChain: async () => ({ valid: true, entries: 0 }),
    },
    policy: { evaluate: () => ({ allowed: true, matchedRule: 'test' }) },
    capabilities: {
      get: (id) => {
        const d = capabilityDefs.get(id);
        return d ? { risk: d.risk, requiresSession: d.requiresSession } : undefined;
      },
      list: () => [...capabilityDefs.keys()],
      has: (id) => capabilityDefs.has(id),
    },
    capabilityDefs,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    bridge,
    newTraceId: () => 'tr_r1',
  };
  const p = new DeterministicAgentProvider({});
  await p.init(ctx);
  return { p, bridge };
}

async function run(p, capabilityId, params = {}) {
  return p.execute({
    traceId: 'tr_r1',
    capabilityId,
    params,
    risk: 'L0',
    approved: false,
    timeoutMs: 5_000,
  });
}

/* ============================ A1 · 注册表绑定与 description 兑现 ============================ */

describe('R1-A1 · 注册表绑定 capabilityList（dist 真实装载物）', () => {
  test('meta.capability.list 绑定 __meta.capabilityList，description 逐字不变', () => {
    const c = WINDOWS_CAPABILITIES.find((d) => d.id === 'meta.capability.list');
    assert.ok(c, 'meta.capability.list 应在注册表');
    assert.equal(c.implementation.module, '__meta');
    assert.equal(c.implementation.function, 'capabilityList');
    assert.equal(c.description, '列出当前已注册并暴露的能力清单');
    assert.equal(c.risk, 'L0');
    // 不改形态承诺：这是「对象载荷」（capabilities/count/domains 三键），非裸数组
    assert.notEqual(c.output?.array, true, 'capability.list 不应带 output.array 标记');
  });

  test('definitions.ts 源文本不再出现 fn: \'listModules\'（路由已摘除）', () => {
    const defs = src('packages/vm-capabilities/src/registry/definitions.ts');
    assert.ok(!/fn:\s*'listModules'/.test(defs), '注册表仍路由 listModules = 名实落差回潮');
    assert.match(defs, /fn:\s*'capabilityList'/, '注册表须绑定 capabilityList');
  });
});

/* ============================ A2 · provider 行为（形态钉） ============================ */

describe('R1-A2 · execute(meta.capability.list) 返回真实能力清单', () => {
  test('ok:true + capabilities 每条含 id/name/risk/surface + count=112 + 零桥往返 + 无 modules 旧键', async () => {
    const { p, bridge } = await makeProvider();
    const res = await run(p, 'meta.capability.list');
    assert.equal(res.ok, true, `回执应成功：${JSON.stringify(res.error ?? {})}`);
    const data = res.data;
    assert.equal(data.ok, true);
    assert.ok(Array.isArray(data.capabilities), 'capabilities 必须是数组');
    // V-NEXT 2.5（方案 B）：口径从「vm 面注册表全集 54」升级为「三面统一表 112」
    assert.equal(data.count, UNIFIED_TOTAL, '方案 B 后 count = 统一表规模 112（vm 54 + browser 33 + desktop 25）');
    assert.equal(data.capabilities.length, data.count, 'count 必须与 capabilities 条数一致');
    for (const item of data.capabilities) {
      assert.equal(typeof item.id, 'string');
      assert.equal(typeof item.name, 'string');
      assert.equal(typeof item.risk, 'string');
      // ⚠ id 形态判据**不能用** `/^[a-z][a-z0-9]*\.[a-z][a-z0-9]*\.[a-z][a-z0-9]*$/`：
      //   统一表 112 项里有 17 项 id 含下划线（如 `browser.nav.tab_new`、
      //   `desktop.pointer.double_click`），这些是上游工具名的合法转写。
      //   契约层 `defineCapabilityEntry` 只要求「三个非空点段」，不限字符集 —— 以契约为准。
      assert.equal(item.id.split('.').length, 3, `id 必须是三段式：${item.id}`);
      assert.ok(['L0', 'L1', 'L2', 'L3'].includes(item.risk), `risk 非法：${item.risk}`);
      assert.ok(['vm', 'browser', 'desktop'].includes(item.surface), `surface 非法：${item.surface}`);
    }
    assert.equal(data.modules, undefined, '旧模块面键不得再出现在本能力回执');
    assert.deepEqual(bridge.calls, [], 'Node 拦截 ⇒ 零桥往返（degraded 窄窗下仍可用）');
  });

  test('domains 键为域前缀数组且与 capabilities 的 id 前缀集合一致（含 meta）', async () => {
    const { p } = await makeProvider();
    const res = await run(p, 'meta.capability.list');
    const derived = [...new Set(res.data.capabilities.map((c) => c.id.split('.')[0]))].sort();
    assert.deepEqual(res.data.domains, derived);
    assert.ok(res.data.domains.includes('meta'), '能力清单形态 domains 含 meta 域（区别于旧 modules 面）');
  });
});

/* ============================ A3 · 与 tools/list 同源一致 ============================ */

describe('R1-A3 · 与统一表（三面 tools/list 数据源）逐条一致', () => {
  test('返回 ID 集 === UNIFIED_CAPABILITIES id 全集，且按 id 升序稳定', async () => {
    const { p } = await makeProvider();
    const res = await run(p, 'meta.capability.list');
    const got = res.data.capabilities.map((c) => c.id);
    // V-NEXT 2.5（方案 B）：基准从 WINDOWS_CAPABILITIES 换成 UNIFIED_CAPABILITIES。
    // 同源论证：统一表 112 = vm54(/mcp 的 exposedCapabilities) + browser33(/mcp/browser 全放)
    //                   + desktop25(/mcp/desktop 白名单)，正是三条 tools/list 路由之和。
    const all = UNIFIED_CAPABILITIES.map((c) => c.id);
    assert.deepEqual([...got].sort(), [...all].sort(), '集合必须逐条一致（三面合计 112）');
    assert.deepEqual(got, [...got].sort(), 'capabilities 必须按 id 升序（输出稳定，防枚举序漂移）');
    assert.equal(got.length, UNIFIED_TOTAL, '条数 = UNIFIED_TOTAL');
  });

  test('三个面都在场且各面条数与 SURFACE_EXPECTED_COUNTS 一致', async () => {
    const { p } = await makeProvider();
    const res = await run(p, 'meta.capability.list');
    const by = {};
    for (const item of res.data.capabilities) by[item.surface] = (by[item.surface] ?? 0) + 1;
    assert.deepEqual(by, SURFACE_EXPECTED_COUNTS, '三面条数须与契约常量逐面相等（54/33/25）');
  });

  test('vm 面的 name/risk 与注册表逐条同源（不得第二处定义）', async () => {
    const { p } = await makeProvider();
    const res = await run(p, 'meta.capability.list');
    const byId = new Map(WINDOWS_CAPABILITIES.map((c) => [c.id, c]));
    let checked = 0;
    for (const item of res.data.capabilities) {
      if (item.surface !== 'vm') continue; // 另两面无 CapabilityDefinition，无从比对（见下一条）
      const def = byId.get(item.id);
      assert.ok(def, `vm 面 ${item.id} 必须在 WINDOWS_CAPABILITIES 里`);
      assert.equal(item.name, def.name, `${item.id} name 漂移`);
      assert.equal(item.risk, def.risk, `${item.id} risk 漂移`);
      checked += 1;
    }
    assert.equal(checked, SURFACE_EXPECTED_COUNTS.vm, 'vm 面必须逐条比过 54 条（防空转）');
  });

  test('browser/desktop 面的 name 回落 title（该两面无 CapabilityDefinition.name）', async () => {
    const { p } = await makeProvider();
    const res = await run(p, 'meta.capability.list');
    const entryById = new Map(UNIFIED_CAPABILITIES.map((c) => [c.id, c]));
    let checked = 0;
    for (const item of res.data.capabilities) {
      if (item.surface === 'vm') continue;
      const entry = entryById.get(item.id);
      assert.ok(entry, `${item.id} 必须在统一表里`);
      assert.equal(item.name, entry.title, `${item.id} 非 vm 面的 name 必须回落 title`);
      assert.equal(item.risk, entry.risk, `${item.id} risk 漂移`);
      checked += 1;
    }
    assert.equal(checked, SURFACE_EXPECTED_COUNTS.browser + SURFACE_EXPECTED_COUNTS.desktop,
      '非 vm 面必须逐条比过 58 条（防空转）');
  });

  test('★ vm 面仍受 provider 声明约束（收窄声明必须同步收窄，不许因方案 B 而失守）', async () => {
    // 这是方案 B 引入的真实风险：既然 browser/desktop 不再过声明过滤，
    // 若实现把「整个表」都不过滤，vm 面的收窄语义就悄悄失效了。
    // 故用子类把声明收窄到只剩 meta 域，断言 vm 面跟着缩、而 browser/desktop 不受影响。
    const { p } = await makeProvider();
    const narrow = Object.create(Object.getPrototypeOf(p));
    Object.assign(narrow, p);
    narrow.declareCapabilities = () => ['meta.*'];
    const res = await narrow.execute({
      traceId: 'tr_narrow',
      capabilityId: 'meta.capability.list',
      params: {},
      risk: 'L0',
      approved: false,
      timeoutMs: 5_000,
    });
    assert.equal(res.ok, true, `收窄声明后仍应成功：${JSON.stringify(res.error ?? {})}`);
    const by = {};
    for (const item of res.data.capabilities) by[item.surface] = (by[item.surface] ?? 0) + 1;
    const metaCount = WINDOWS_CAPABILITIES.filter((c) => c.id.startsWith('meta.')).length;
    assert.equal(by.vm, metaCount, `收窄到 meta.* 后 vm 面应只剩 ${metaCount} 条，实际 ${by.vm}`);
    assert.equal(by.browser, SURFACE_EXPECTED_COUNTS.browser, 'browser 面不受 provider 声明约束');
    assert.equal(by.desktop, SURFACE_EXPECTED_COUNTS.desktop, 'desktop 面不受 provider 声明约束');
    assert.ok(by.vm < SURFACE_EXPECTED_COUNTS.vm, 'vm 面必须真的收窄了（否则本条断言空转）');
  });
});

/* ============================ A4 · 拦截定向性 + psmod 诊断面保留 ============================ */

describe('R1-A4 · 拦截只针对 capabilityList，其余照常走桥', () => {
  test('非 __meta 能力照常 bridge.call（拦截不是总闸）', async () => {
    const { p, bridge } = await makeProvider();
    const res = await run(p, 'system.info.get');
    assert.equal(res.ok, true);
    assert.equal(bridge.calls.length, 1);
    assert.equal(bridge.calls[0].module, 'system');
    assert.equal(bridge.calls[0].fn, 'Get-SystemInfo');
  });

  test('meta.health.check 仍走 Node 内置快照分支（B-4 不得波及 D5 先例）', async () => {
    const { p, bridge } = await makeProvider();
    // 无注入 healthSnapshot ⇒ 退化 provider.health()（与 buildHealthSnapshot 注释口径一致）
    const res = await run(p, 'meta.health.check');
    assert.equal(res.ok, true);
    assert.deepEqual(bridge.calls, [], 'healthCheck 不经 bridge.call 的既有钉面不得退化');
  });

  test('ps-bridge.ps1 的 listModules 分支保留在册（内部诊断面，注册表不再引用）', () => {
    const bridgePs = src('packages/vm-capabilities/psmod/ps-bridge.ps1');
    assert.match(bridgePs, /'listModules' \{/, 'listModules 诊断分支被删 = psmod 面漂移');
    assert.match(bridgePs, /modules\s*=\s*@\(\$mods\)/, '分支体返回形态未变（仅不再被注册表路由）');
  });
});

/* ============================ A5 · 同源假设防漂移（provider 通配集） ============================ */

describe('R1-A5 · provider declareCapabilities 通配集同含六域（同源假设钉）', () => {
  /* V-NEXT（2026-11-23）：`hermes` provider 已删（provider 收敛为 workbuddy 一族），
   * 故 SOURCES 从三项收敛为两项。注意此处收的是**现存 provider 的实现文件**，
   * 删掉一项不等于放宽判据 —— 两个现存 provider 仍必须与 buildCapabilityList 的
   * 「全 provider 同声明」假设逐字一致。 */
  const SOURCES = [
    ['deterministic', 'packages/adapter-agent-workbuddy/src/index.ts'],
    ['llm', 'packages/adapter-agent-workbuddy-llm/src/index.ts'],
  ];
  for (const [label, rel] of SOURCES) {
    test(`${label} 的声明集含全部六域通配`, () => {
      const t = src(rel);
      const m = /declareCapabilities\(\): readonly string\[\] \{[\s\S]{0,160}?return \[([^\]]*)\]/.exec(t);
      assert.ok(m, `${rel}: declareCapabilities 返回体形态漂移（判据正则需随实现同步，不得空转）`);
      const arr = m[1];
      for (const domain of ['meta', 'system', 'app', 'storage', 'gui', 'appops']) {
        assert.ok(arr.includes(`'${domain}.*'`), `${label} 缺 '${domain}.*' 通配 ⇒ buildCapabilityList 的「全 provider 同声明」假设破裂，须把差异接进函数而非静默失真`);
      }
    });
  }

  test('llm 的 execute 委托确定性执行器（拦截链单点成立）', () => {
    assert.match(
      src('packages/adapter-agent-workbuddy-llm/src/index.ts'),
      /return this\.executor\.execute\(req\)/,
      'llm execute 须仍委托 executor（否则 capabilityList 拦截覆盖不到该 provider）',
    );
  });

  test('V-NEXT：hermes provider 已被彻底移除（反向钉，防复活出半套实现）', () => {
    /* 删 provider 时最容易留下的是「包删了、注册表还留着」或「包删了、测试还假装它在」。
     * 本钉把「不存在」变成可验证事实：任何一处复活都会被拦下。 */
    assert.equal(
      existsSync(join(ROOT, 'packages/adapter-agent-hermes')),
      false,
      'packages/adapter-agent-hermes 不得复活（provider 已收敛为 workbuddy 一族）',
    );
  });
});

/* ============================ A6 · SKILL 口径句回潮防线（只读文本面） ============================ */

describe('R1-A6 · 四份域 SKILL 携带「与 tools/list 同源一致」口径', () => {
  const SKILLS = [
    'skills/winvm-app-manager/SKILL.md',
    'skills/winvm-gui-automation/SKILL.md',
    'skills/winvm-storage-manager/SKILL.md',
    'skills/winvm-system-admin/SKILL.md',
  ];
  for (const rel of SKILLS) {
    test(`${rel} 口径句在册`, () => {
      const t = src(rel);
      assert.ok(
        t.includes('与 tools/list 同源一致'),
        'B-4 后 SKILL 应声明 capability.list 与 tools/list 同源（Node 侧统一表直供）——措辞被回退=文档面漂移',
      );
      /* V-NEXT 2.5（方案 B）：数据源措辞从「Node 侧注册表直供」改为「Node 侧统一表直供」。
       * 为什么必须改：「注册表」在本文档语境里特指 `WINDOWS_CAPABILITIES`（vm 面 54），
       * 而方案 B 之后权威源是 `UNIFIED_CAPABILITIES`（三面 112）。保留旧措辞会让读者
       * 以为仍是 54 面 —— 那是**比没有这句话更糟的误导**。
       * 本条同时钉住 count 口径，防止「说 112 但实际返回 54」这种半途状态被放过。 */
      assert.ok(
        t.includes('Node 侧统一表直供'),
        '同源口径须说明直供来源是「统一表」（UNIFIED_CAPABILITIES 三面 112），而非旧的「注册表」（vm 面 54）',
      );
      assert.ok(
        t.includes('112'),
        'SKILL 须写明 count 为三面合计 112（否则读者仍按 54 预期，会把正常回执当异常）',
      );
    });
  }
});

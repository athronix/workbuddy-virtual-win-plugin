/**
 * 统一能力表（阶段 2）· 结构与**派生不漂移**钉
 *
 * ## 钉的是什么
 * 阶段 2 的目标是把「三个工具面三份清单」收敛成一张表（54 + 33 + 25 = 112）。
 * 本文件只覆盖 **2.1（类型/不变式）+ 2.2（vm 面 54 项派生）** 这一半（owner 裁定先看结构）。
 * browser / desktop 两面待 2.3 / 2.4 补齐 —— 本文件对它们只钉「当前必须缺席」，
 * 防止有人先塞半张表进去把总数搞成非 112 的怪数。
 *
 * ## 为什么这组断言值得存在（三个真实失效模式）
 *  A 组 · **派生不漂移**：`VM_CAPABILITIES` 必须是 `WINDOWS_CAPABILITIES` 的**投影**，
 *     不是手抄的第二份。判据用「逐字段集合相等」而不是「长度 = 54」——
 *     后者在两者**同时**被改成 53 时仍然绿（假绿），前者不会。
 *  B 组 · **通配语义可继承**：`system.*` 这类域级通配靠「保留结尾点做前缀匹配」，
 *     所以 id 必须**恒为三段**。若将来有人加一条 `id: 'foo.bar'`（两段），
 *     `foo.bar*` 的匹配行为会静默改变 —— 这条在 C 组显形。
 *  C 组 · **surface 首段必须对得上**：把 `browser.nav.open` 误标 `surface: 'vm'` 不会让
 *     任何调用失败，只会让审批闸按**错的面的规则**放行（vm 面要审批、browser 面不要 ⇒ 漏批）。
 *     这是本表最危险的一类错标，必须能炸。
 *
 * ## 纪律
 * 不碰 VM / 网络 / 文件系统写入；只 import dist 产物（O-3 范式）。
 * 运行（只跑本文件，绝不整批）：
 *   node --test tests/unit/unified-capability-table.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = join(import.meta.dirname, '..', '..');
const dist = (...segs) => pathToFileURL(join(ROOT, 'packages', ...segs, 'dist', 'index.js')).href;

const contracts = await import(dist('contracts'));
const vmCaps = await import(dist('vm-capabilities'));

const {
  SURFACES,
  SURFACE_EXPECTED_COUNTS,
  UNIFIED_TOTAL,
  defineCapabilityEntry,
  deriveDomain,
  resolveToolName,
  validateUnifiedTable,
  InvalidCapabilityEntryError,
} = contracts;

const { VM_CAPABILITIES, UNIFIED_CAPABILITIES, WINDOWS_CAPABILITIES } = vmCaps;

/* ------------------------------- A · 派生不漂移 ------------------------------- */

describe('A · vm 面是 definitions 的投影，不是第二份手抄', () => {
  test('A1 条数 = 54，且与 WINDOWS_CAPABILITIES 逐条对齐', () => {
    assert.equal(WINDOWS_CAPABILITIES.length, 54, 'definitions 侧基线应为 54');
    assert.equal(VM_CAPABILITIES.length, 54);
    assert.equal(VM_CAPABILITIES.length, WINDOWS_CAPABILITIES.length);
  });

  test('A2 id 序列逐字相同且同序（投影不重排）', () => {
    assert.deepEqual(
      VM_CAPABILITIES.map((c) => c.id),
      WINDOWS_CAPABILITIES.map((c) => c.id),
    );
  });

  test('A3 risk 逐条相等（不是「都合法」而是「都对得上」）', () => {
    for (let i = 0; i < WINDOWS_CAPABILITIES.length; i += 1) {
      assert.equal(
        VM_CAPABILITIES[i].risk,
        WINDOWS_CAPABILITIES[i].risk,
        `risk 漂移：${WINDOWS_CAPABILITIES[i].id}`,
      );
    }
  });

  test('A4 title 逐条 = name，且无空串', () => {
    for (let i = 0; i < WINDOWS_CAPABILITIES.length; i += 1) {
      assert.equal(VM_CAPABILITIES[i].title, WINDOWS_CAPABILITIES[i].name);
      assert.ok(VM_CAPABILITIES[i].title.trim().length > 0);
    }
  });

  test('A5 vm 面不得带 tool 字段（vm 按 id 自身路由，多写一份即多一处漂移点）', () => {
    assert.equal(VM_CAPABILITIES.filter((c) => c.tool !== undefined).length, 0);
  });

  test('A6 surface 全为 vm，且整表无重复 id', () => {
    assert.equal(VM_CAPABILITIES.filter((c) => c.surface === 'vm').length, 54);
    assert.deepEqual(validateUnifiedTable(VM_CAPABILITIES), []);
  });
});

/* ------------------------------ B · 通配语义可继承 ------------------------------ */

describe('B · 三段式与域分布（域级通配 system.* 等靠它成立）', () => {
  test('B1 每条 id 恰三段、段非空', () => {
    for (const c of VM_CAPABILITIES) {
      const segs = c.id.split('.');
      assert.equal(segs.length, 3, `非三段：${c.id}`);
      assert.ok(segs.every((s) => s.length > 0), `空段：${c.id}`);
    }
  });

  test('B2 域分布 = meta3/system14/app8/storage13/gui11/appops5', () => {
    const got = {};
    for (const c of VM_CAPABILITIES) {
      const d = deriveDomain(c.id);
      got[d] = (got[d] ?? 0) + 1;
    }
    assert.deepEqual(got, {
      meta: 3,
      system: 14,
      app: 8,
      storage: 13,
      gui: 11,
      appops: 5,
    });
  });

  test('B3 域级通配 system.* 只命中 system 域（不是全部）', () => {
    const hit = VM_CAPABILITIES.filter((c) => c.id.startsWith('system.')).length;
    assert.equal(hit, 14);
    assert.ok(hit < VM_CAPABILITIES.length, '通配若命中全集则前缀匹配已失效');
  });
});

/* ---------------------------- C · 反向钉：坏条目必须炸 ---------------------------- */

describe('C · defineCapabilityEntry 拒绝坏形状（防静默错标）', () => {
  const ok = { id: 'system.service.control', surface: 'vm', risk: 'L1', title: 'ok' };

  test('C1 两段 id 必须炸（会破坏通配语义）', () => {
    assert.throws(() => defineCapabilityEntry({ ...ok, id: 'system.control' }), InvalidCapabilityEntryError);
  });

  test('C2 四段 id 必须炸', () => {
    assert.throws(() => defineCapabilityEntry({ ...ok, id: 'a.b.c.d' }), InvalidCapabilityEntryError);
  });

  test('C3 空段必须炸', () => {
    assert.throws(() => defineCapabilityEntry({ ...ok, id: 'system..control' }), InvalidCapabilityEntryError);
  });

  test('C4 surface 非三值必须炸', () => {
    assert.throws(
      () => defineCapabilityEntry({ ...ok, surface: 'mobile' }),
      InvalidCapabilityEntryError,
    );
  });

  test('C5 risk 非法必须炸', () => {
    assert.throws(() => defineCapabilityEntry({ ...ok, risk: 'L9' }), InvalidCapabilityEntryError);
  });

  test('C6 title 空必须炸', () => {
    assert.throws(() => defineCapabilityEntry({ ...ok, title: '   ' }), InvalidCapabilityEntryError);
  });

  test('C7 ★ browser/desktop 条目首段必须等于 surface（错标面 = 审批闸按错规则放行）', () => {
    assert.throws(
      () => defineCapabilityEntry({ id: 'vm.nav.open', surface: 'browser', risk: 'L1', title: 't' }),
      InvalidCapabilityEntryError,
      'browser 面却用了 vm. 前缀，必须炸',
    );
    assert.throws(
      () => defineCapabilityEntry({ id: 'desktop.x.y', surface: 'browser', risk: 'L1', title: 't' }),
      InvalidCapabilityEntryError,
    );
    // 正例：前缀对上则放行
    assert.doesNotThrow(() =>
      defineCapabilityEntry({ id: 'browser.nav.open', surface: 'browser', risk: 'L1', title: 't' }),
    );
  });

  test('C8 vm 面不校验首段是六域之一（首段是 CapabilityDomain，由 capability.ts 把关）', () => {
    // 故意用非六域首段：本层只保证「三段 + surface/risk 合法」，
    // 域合法性属执行体契约（defineCapability / parseCapabilityId 的职责），不在此重复。
    assert.doesNotThrow(() =>
      defineCapabilityEntry({ id: 'weird.group.act', surface: 'vm', risk: 'L0', title: 't' }),
    );
  });
});

/* --------------------------- D · 整表与常量自洽 --------------------------- */

describe('D · 常量与当前实际的账要对得上', () => {
  test('D1 SURFACES = vm/browser/desktop', () => {
    assert.deepEqual([...SURFACES], ['vm', 'browser', 'desktop']);
  });

  test('D2 各面预期数 54/33/25，合计 = UNIFIED_TOTAL = 112', () => {
    assert.equal(SURFACE_EXPECTED_COUNTS.vm, 54);
    assert.equal(SURFACE_EXPECTED_COUNTS.browser, 33);
    assert.equal(SURFACE_EXPECTED_COUNTS.desktop, 25);
    const sum =
      SURFACE_EXPECTED_COUNTS.vm + SURFACE_EXPECTED_COUNTS.browser + SURFACE_EXPECTED_COUNTS.desktop;
    assert.equal(sum, UNIFIED_TOTAL);
    assert.equal(UNIFIED_TOTAL, 112);
  });

  test('D3 当前 UNIFIED_CAPABILITIES = vm + browser + desktop（2.3/2.4 均已落地），总表恒等 112', () => {
    const surfaces = new Set(UNIFIED_CAPABILITIES.map((c) => c.surface));
    // 2.4（desktop 25）与 2.3（browser 33）都已落地 ⇒ 三个面必须**全部在场**。
    // 断言从「钉缺席」翻转为「钉在场 + 逐面钉条数」，覆盖面**扩大**（1 面 → 3 面）。
    assert.deepEqual([...surfaces].sort(), ['browser', 'desktop', 'vm'], '三个面都必须出现');
    const bySurface = UNIFIED_CAPABILITIES.reduce((acc, c) => {
      acc[c.surface] = (acc[c.surface] ?? 0) + 1;
      return acc;
    }, {});
    assert.equal(bySurface.vm, SURFACE_EXPECTED_COUNTS.vm);
    assert.equal(bySurface.browser, SURFACE_EXPECTED_COUNTS.browser);
    assert.equal(bySurface.desktop, SURFACE_EXPECTED_COUNTS.desktop);
    // 阶段 2 收口：总表必须**恰好**等于 UNIFIED_TOTAL —— 不再允许「差 33 也放过」。
    assert.equal(UNIFIED_CAPABILITIES.length, UNIFIED_TOTAL, '总表 = 112 = UNIFIED_TOTAL');
    assert.equal(
      UNIFIED_CAPABILITIES.length,
      SURFACE_EXPECTED_COUNTS.vm +
        SURFACE_EXPECTED_COUNTS.browser +
        SURFACE_EXPECTED_COUNTS.desktop,
      '54 + 33 + 25 = 112',
    );
  });

  test('D3b 面的**顺序** = vm → browser → desktop（与 contracts 的 SURFACES 同序）', () => {
    // 为什么顺序也要钉：`browser` 段是 2.3 晚于 2.4 才插进来的。
    // 若图省事 append 到末尾，任何「按下标定位某面第 n 项」的消费方都会错位，
    // 而这种错位**不会报错**，只会读到另一个面的条目 —— 静默错标族。
    const firstIndexOf = (s) => UNIFIED_CAPABILITIES.findIndex((c) => c.surface === s);
    const iVm = firstIndexOf('vm');
    const iBrowser = firstIndexOf('browser');
    const iDesktop = firstIndexOf('desktop');
    assert.ok(iVm >= 0 && iBrowser >= 0 && iDesktop >= 0, '三个面都必须在场');
    assert.ok(iVm < iBrowser, `vm 必须先于 browser（实得 vm=${iVm} browser=${iBrowser}）`);
    assert.ok(iBrowser < iDesktop, `browser 必须先于 desktop（实得 browser=${iBrowser} desktop=${iDesktop}）`);
  });

  test('D4 resolveToolName：无 tool 回落 id', () => {
    assert.equal(resolveToolName({ id: 'system.x.y', surface: 'vm', risk: 'L0', title: 't' }), 'system.x.y');
    assert.equal(
      resolveToolName({ id: 'browser.nav.open', surface: 'browser', risk: 'L1', title: 't', tool: 'browser_open' }),
      'browser_open',
    );
  });
});

/* ------------------------ E · 事实源交叉核对（防两面说谎） ------------------------ */

describe('E · 跨面数字必须有源码出处，不许凭记忆', () => {
  test('E1 browser = 上游 33 且**无白名单**（有白名单就必须同步下调预期数）', () => {
    const src = readFileSync(join(ROOT, 'packages/vm-service/src/mcp-upstream.ts'), 'utf8');
    // browser 的 spec 段里不得出现 toolAllowlist —— 一旦出现，33 就不再是可达数
    const browserSpec = src.slice(src.indexOf("id: 'browser'"), src.indexOf("id: 'desktop'"));
    assert.ok(browserSpec.length > 0, '找不到 browser 的 upstream spec');
    assert.equal(
      /toolAllowlist/.test(browserSpec),
      false,
      'browser 若加了白名单，SURFACE_EXPECTED_COUNTS.browser 必须同步改为白名单长度',
    );
  });

  test('E2 desktop 白名单长度 = 25 = 预期数（不是上游 75）', () => {
    // ⚠ 2026-11-24 阶段 2.4（方案 A）：白名单常量已**下沉**到 vm-capabilities，
    // `vm-service/src/mcp-upstream.ts` 只剩 `export ... from`（一行转发，无字面量）。
    // 所以本断言的事实源同步改为新家 —— 不是在放宽断言，而是**跟着事实源搬家**。
    // 搬家前后覆盖面完全相同：仍逐项取出字面量、仍钉长度/去重/前缀三件事。
    const src = readFileSync(
      join(ROOT, 'packages/vm-capabilities/src/registry/upstream-tools.ts'),
      'utf8',
    );
    const m = src.match(/DEFAULT_DESKTOP_TOOL_ALLOWLIST[^=]*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/);
    assert.ok(m, '找不到 DEFAULT_DESKTOP_TOOL_ALLOWLIST 字面量');
    // ⚠ 必须**按行**取，不能 `split(',')`：白名单每组前面有一行 `// A 目标发现与窗口` 注释，
    // 逗号切分会把「注释 + 组内第一个元素」并进同一段，导致每组漏掉首个元素
    // （实测漏 5 个 = 20 而非 25，且恰好是 snapshot/launch/click/type/get）。
    const items = m[1]
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith("'") && line.endsWith("',"))
      .map((line) => line.slice(1, -2));
    assert.equal(items.length, SURFACE_EXPECTED_COUNTS.desktop, '白名单长度必须等于预期可达数');
    assert.equal(new Set(items).size, items.length, '白名单内不得重复');
    assert.ok(
      items.every((t) => t.startsWith('desktop_')),
      `白名单项应全部形如 desktop_*，异常项：${items.filter((t) => !t.startsWith('desktop_')).join(',')}`,
    );
  });

  test('E2b 下沉后的 re-export 仍在原位置可 import（对外形状不因搬家而变）', async () => {
    // 下沉只是内部整理。`vm-service/dist/mcp-upstream.js` 对外仍导出该常量，
    // 否则 `tests/unit/mcp-upstream-connectors.test.js` 等既有消费方会静默断链。
    const upstream = await import(
      pathToFileURL(join(ROOT, 'packages/vm-service/dist/mcp-upstream.js')).href
    );
    assert.equal(
      typeof upstream.DEFAULT_DESKTOP_TOOL_ALLOWLIST,
      'object',
      'vm-service 必须继续 re-export 该常量（下沉不该让调用方改 import 路径）',
    );
    assert.equal(
      upstream.DEFAULT_DESKTOP_TOOL_ALLOWLIST.length,
      SURFACE_EXPECTED_COUNTS.desktop,
      're-export 的必须是同一份（长度与下沉后的定义一致）',
    );
    // 与 vm-capabilities 侧是**同一个对象**（而非各留一份副本）
    assert.equal(
      upstream.DEFAULT_DESKTOP_TOOL_ALLOWLIST,
      vmCaps.DEFAULT_DESKTOP_TOOL_ALLOWLIST,
      '两处必须是同一引用；若是两份副本，说明有人复制了一份「以防万一」',
    );
  });

  test('E2c DESKTOP_TOOLS 与白名单**同源派生**：条数相等且 tool 逐条命中', () => {
    // 这是 2.4 的核心不变式：统一表不是手抄第二份，而是白名单的投影。
    // 若两边可以独立编辑，就会出现「白名单放行 25 个、统一表只登记 24 条」⇒
    // 多出来的那个工具在审批闸里**无规则可查**（fail-open）。
    assert.equal(vmCaps.DESKTOP_TOOLS.length, vmCaps.DEFAULT_DESKTOP_TOOL_ALLOWLIST.length);
    const allowed = new Set(vmCaps.DEFAULT_DESKTOP_TOOL_ALLOWLIST);
    for (const entry of vmCaps.DESKTOP_TOOLS) {
      assert.ok(entry.tool, `条目 ${entry.id} 缺 tool 字段（desktop 面必须指明上游工具名）`);
      assert.ok(allowed.has(entry.tool), `条目 ${entry.id} 的 tool=${entry.tool} 不在白名单里`);
      assert.equal(entry.surface, 'desktop');
    }
    // 反向：白名单每一项都被登记了
    const declared = new Set(vmCaps.DESKTOP_TOOLS.map((e) => e.tool));
    for (const tool of allowed) {
      assert.ok(declared.has(tool), `白名单工具 ${tool} 未登记进 DESKTOP_TOOLS`);
    }
  });

  test('E2d desktop 面 risk 分级：只读 8 / 可回滚写 17 / 无 L2（白名单已排除破坏性动作）', () => {
    const byRisk = vmCaps.DESKTOP_TOOLS.reduce((acc, c) => {
      acc[c.risk] = (acc[c.risk] ?? 0) + 1;
      return acc;
    }, {});
    assert.equal(byRisk.L0, 8, 'L0 = snapshot/find/screenshot/list_apps/list_windows/get/is/wait');
    assert.equal(byRisk.L1, 17, 'L1 = 其余 17 项（窗口/指针/输入，均可复原）');
    assert.equal(
      byRisk.L2 ?? 0,
      0,
      '本白名单不含破坏性动作。若将来加入 close_app / 原始鼠标事件，必须标 L2 —— ' +
        '否则审批闸会按 L1 静默放行（这条断言就是那时的提醒）',
    );
    // L0 集合逐条钉死（改一条就要显式说明理由）
    const l0 = vmCaps.DESKTOP_TOOLS.filter((c) => c.risk === 'L0')
      .map((c) => c.tool)
      .sort();
    assert.deepEqual(l0, [
      'desktop_find',
      'desktop_get',
      'desktop_is',
      'desktop_list_apps',
      'desktop_list_windows',
      'desktop_screenshot',
      'desktop_snapshot',
      'desktop_wait',
    ]);
  });

  test('E3 desktop 上游真实面是 75（白名单是 25 的子集，不是全量）', () => {
    const src = readFileSync(join(ROOT, 'packages/vm-service/src/mcp-upstream.ts'), 'utf8');
    assert.ok(
      /agent-desktop（75 工具/.test(src) || /75 工具/.test(src),
      '上游 75 个工具这一事实必须留在源码注释里，否则 25 会被误读成「上游只有 25」',
    );
  });
});
/* --------------------- F · browser 面（阶段 2.3 新增，33 项） --------------------- */

describe('F · browser 面与上游真实工具面钉死', () => {
  test('F1 BROWSER_TOOLS 恰 33 条，且与 references/ 的 33 份逐条对齐（双向）', () => {
    // 这条断言是本面**唯一的**防漂移手段：browser 没有白名单，
    // 上游加一个工具不会自动进来，少了也不会报错 —— 只能靠静态清单与目录对账。
    const dir = join(ROOT, 'skills/agent-browser-skill/references');
    const real = readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, ''))
      .sort();
    assert.equal(real.length, 33, `references/ 应恰 33 份，实得 ${real.length}`);

    const declared = vmCaps.BROWSER_TOOLS.map((c) => c.tool).sort();
    assert.equal(vmCaps.BROWSER_TOOLS.length, 33, 'BROWSER_TOOLS 应恰 33 条');

    const missing = real.filter((r) => !declared.includes(r));
    const extra = declared.filter((d) => !real.includes(d));
    assert.deepEqual(missing, [], `漏声明（上游有、表里没有 ⇒ 该工具审批闸无规则）: ${missing}`);
    assert.deepEqual(extra, [], `多声明（表里有、上游没有 ⇒ 表在承诺调不到的能力）: ${extra}`);
  });

  test('F2 browser 33 项的 tool 全部与 id 不同（本面 tool 必填，不存在「回落 id」）', () => {
    // vm 面 54 条靠 `tool` 缺省回落到 id；browser 面是 `agent_browser_xxx` vs `browser.x.y`，
    // 两者形状完全不同 ⇒ 任何一条忘了写 tool，都会被 resolveToolName 回落到 id，
    // 从而去调一个**不存在的工具名**（`browser.nav.open`）。这种失败只在真机才暴露。
    for (const c of vmCaps.BROWSER_TOOLS) {
      assert.ok(c.tool, `${c.id} 缺 tool：会回落成 id 并去调一个不存在的上游工具名`);
      assert.notEqual(c.tool, c.id, `${c.id} 的 tool 不应等于 id`);
      assert.ok(
        c.tool.startsWith('agent_browser_'),
        `${c.id} 的 tool 应以 agent_browser_ 开头，实得 ${c.tool}`,
      );
    }
  });

  test('F3 browser risk 分布：14 L0 / 18 L1 / 1 L2，且 L2 **必须**是 eval', () => {
    const byRisk = vmCaps.BROWSER_TOOLS.reduce((acc, c) => {
      acc[c.risk] = (acc[c.risk] ?? 0) + 1;
      return acc;
    }, {});
    assert.deepEqual(byRisk, { L0: 14, L1: 18, L2: 1 }, '分布变了必须显式改这里并说明理由');

    const l2 = vmCaps.BROWSER_TOOLS.filter((c) => c.risk === 'L2').map((c) => c.tool);
    // ★ 本面最关键的一条：eval 能页内执行任意 JS，绕过其余 32 项的一切限制。
    // 若被降成 L1，审批闸会**静默放行任意 JS 执行** —— 单点最高风险。
    assert.deepEqual(l2, ['agent_browser_eval'], 'L2 有且只有 eval');
  });

  test('F4 browser 面 L0 集合逐条钉死（改一条就要显式说明理由）', () => {
    const l0 = vmCaps.BROWSER_TOOLS.filter((c) => c.risk === 'L0')
      .map((c) => c.tool)
      .sort();
    assert.deepEqual(l0, [
      'agent_browser_flow_list',
      'agent_browser_flow_steps',
      'agent_browser_get_text',
      'agent_browser_get_title',
      'agent_browser_get_url',
      'agent_browser_read',
      'agent_browser_screenshot',
      'agent_browser_snapshot',
      'agent_browser_tab_list',
      'agent_browser_tools_profiles',
      'agent_browser_wait_for_load',
      'agent_browser_wait_for_selector',
      'agent_browser_wait_for_text',
      'agent_browser_wait_ms',
    ]);
  });

  test('F5 browser 面的 id / tool 都无重复（加载期已校验，这里再钉一次可见面）', () => {
    const ids = vmCaps.BROWSER_TOOLS.map((c) => c.id);
    const tools = vmCaps.BROWSER_TOOLS.map((c) => c.tool);
    assert.equal(new Set(ids).size, ids.length, 'id 不得重复');
    assert.equal(new Set(tools).size, tools.length, 'tool 不得重复');
  });
});

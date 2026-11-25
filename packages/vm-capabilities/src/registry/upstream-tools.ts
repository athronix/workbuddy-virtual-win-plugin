/**
 * 上游工具面的事实源（`/mcp/browser` 33 项、`/mcp/desktop` 25 项）
 *
 * ## 为什么这些清单住在本包（而不是 `vm-service`）
 *
 * 原本 `DEFAULT_DESKTOP_TOOL_ALLOWLIST` 住在 `vm-service/src/mcp-upstream.ts`。
 * 统一能力表（`registry/unified.ts`）要给 desktop 面补 25 条带 `risk` 的条目，
 * 就必须读这份白名单 —— 但 `vm-service` 的 `package.json` **已经依赖**本包
 * （`"@winvm/vm-capabilities": "0.1.0"`），反向 import 会**成环**，dep-lint 必拦。
 *
 * 处置（owner 2026-11-24 裁定 **方案 A**）：把常量**下沉到本包**
 * （`vm-capabilities/src/registry/`，与 `definitions.ts` 同层），
 * `vm-service/src/mcp-upstream.ts` 改为从本包 re-export。
 *
 * 「下沉」而非「复制」的理由：白名单是**可达面**的唯一事实源（`McpUpstream.exposedTools()`
 * 靠它过滤），统一表是同一份事实的**投影**。复制成两份的代价不是多写 25 行，
 * 而是「加白名单忘了加统一表」⇒ 审批闸对该工具**静默无规则**（fail-open）。
 *
 * ## 本文件的两个导出，职责不同，别混
 *
 * - `DEFAULT_DESKTOP_TOOL_ALLOWLIST`：**上游工具名字面量**（`desktop_*`），
 *   供 `McpUpstream` 过滤 `tools/list` 结果。它是「放不放行」的开关。
 * - `DESKTOP_TOOLS`：**统一表条目**（`desktop.<组>.<动作>` + `risk` + `title`），
 *   供策略闸/审批/清单展示。它是「放行后按什么风险级别审」的规则。
 *
 * 两者的连接是 `tool` 字段：`DESKTOP_TOOLS` 逐条**从**白名单派生，长度必须相等，
 * 且每个 `tool` 都必须能在白名单里找到 —— 这三条由 `defineDesktopTools()` 在
 * **模块加载期**强校验（不是测试期），因为「白名单多一个而统一表少一个」正是
 * fail-open 的入口，不能等到跑测试才发现。
 */

import type { CapabilityEntry } from '@winvm/contracts';
import { defineCapabilityEntry } from '@winvm/contracts';
import type { RiskLevel } from '@winvm/contracts';

/**
 * agent-desktop 默认暴露的高频子集（25 个，四组闭环）。
 *
 * v2.2.0 按场景调宽（原 10 项＝「观察→定位→交互→等待」最小面，实测缺口见各组注释）：
 *   A 目标发现与窗口（5）：snapshot / find / screenshot / list_apps / list_windows
 *      —— 观察面基础，缺一不可。
 *   B 启动与窗口管理（4）：launch / focus_window / maximize / resize_window
 *      —— 原白名单只有「看窗口」没有「开应用/切窗口/摆窗口」：多窗口场景下
 *         click 的坐标会因窗口位置漂移而打错目标；maximize 是最廉价的坐标稳定器。
 *   C 指针与滚动（6）：click / double_click / right_click / hover / scroll / scroll_to
 *      —— 列表项打开要 double_click，上下文菜单要 right_click，长页/树要 scroll；
 *         scroll_to 让「滚动到某元素」一次到位，避免盲滚多次截图。
 *   D 键盘与表单（7）：type / set_value / press / check / uncheck / select / toggle
 *      —— 复选框/单选/下拉在真实业务里比纯 type 更高频，且都天然幂等。
 *   E 读取与等待（3）：get / is / wait
 *      —— get 读元素值（校验「输入框里到底是什么」），is 做存在/可见/可用断言，
 *         两者让「操作后校验」不必再截图做视觉比对。
 *
 * ⇒ 5 + 4 + 6 + 7 + 3 = **25**。⚠ 上一版注释把 C 记作 5、D 记作 4、合计记作「21」，
 *   与数组实际长度（25）不符 —— 属**注释漂移**，已订正。数组本身一直是对的。
 *   本数字是「**可达**面」，不是上游全量（agent-desktop 共 75 工具，其余 50 个默认不代理）。
 *
 * 仍**不**默认暴露：破坏性动作（close_app / drag / clipboard_set / clipboard_clear /
 * sandbox_*）、鼠标原始事件（mouse_down/up/move/click/wheel）、通知与会话管理、
 * trace 导出。需要时按 SKILL 「解禁三步」显式加白名单，不要整体放开 75 个。
 *
 * ⚠ 改动本数组 = **改变对外可达面**。必须同步：
 *   ① `DESKTOP_TOOLS`（下方派生，长度不一致会在模块加载期抛错）；
 *   ② `contracts/src/unified.ts` 的 `SURFACE_EXPECTED_COUNTS.desktop`；
 *   ③ `tests/unit/unified-capability-table.test.js` 的 E2/E3 断言。
 */
export const DEFAULT_DESKTOP_TOOL_ALLOWLIST: readonly string[] = Object.freeze([
  // A 目标发现与窗口
  'desktop_snapshot',
  'desktop_find',
  'desktop_screenshot',
  'desktop_list_apps',
  'desktop_list_windows',
  // B 启动与窗口管理
  'desktop_launch',
  'desktop_focus_window',
  'desktop_maximize',
  'desktop_resize_window',
  // C 指针与滚动
  'desktop_click',
  'desktop_double_click',
  'desktop_right_click',
  'desktop_hover',
  'desktop_scroll',
  'desktop_scroll_to',
  // D 键盘与表单
  'desktop_type',
  'desktop_set_value',
  'desktop_press',
  'desktop_check',
  'desktop_uncheck',
  'desktop_select',
  'desktop_toggle',
  // E 读取与等待
  'desktop_get',
  'desktop_is',
  'desktop_wait',
]);

/**
 * 上游工具名 → 统一表 `id` / `risk` / `title` 的**手工标注表**（V-NEXT 阶段 2.4）。
 *
 * 为什么必须手工而**不能**从工具名机械推导：
 *   - `id` 要三段式且中段是**语义分组**（`observe` / `window` / `pointer` / `input` / `query`），
 *     从 `desktop_snapshot` 推不出它属于「目标发现」还是「窗口管理」；
 *   - `risk` 是**安全判据**，只能逐条对照实现体语义判断。写错的后果不对称：
 *     标高了只是多一次审批，标低了是**破坏性动作无审批直接执行**。
 *
 * ## risk 分级依据（owner 确认的判据，改动需重新裁定）
 *
 * | risk | 判据 | 本面成员 |
 * |---|---|---|
 * | `L0` 只读 | 不改变系统状态 | snapshot / find / screenshot / list_apps / list_windows / get / is / wait |
 * | `L1` 可回滚写 | 状态改变但可撤销（窗口位置、输入框内容、滚动位置、勾选态均可复原） | 其余 17 项 |
 * | `L2` 破坏性 | 不可逆或影响面大 | **无**（本白名单已排除 close_app / drag / clipboard_set 等） |
 *
 * ⚠ `desktop_launch` 判 `L1` 而非 `L2`：它只启动应用、不装不卸，关掉即复原。
 *   真正的「装/卸」在 vm 面的 `app.winget.*`，那两条另有分级，不要混。
 *
 * ⚠ 本表现有 `L2` 为空**不代表**本面安全——只说明**默认白名单**里没有破坏性动作。
 *   若将来把 `desktop_close_app` 或原始鼠标事件加进白名单，必须同步标 `L2`，
 *   否则审批闸会按 L1 静默放行。
 */
const DESKTOP_TOOL_META: Readonly<
  Record<string, { readonly id: string; readonly risk: RiskLevel; readonly title: string }>
> = Object.freeze({
  // A 目标发现与窗口 —— 纯观察，L0
  desktop_snapshot: { id: 'desktop.observe.snapshot', risk: 'L0', title: '无障碍树快照' },
  desktop_find: { id: 'desktop.observe.find', risk: 'L0', title: '查找元素' },
  desktop_screenshot: { id: 'desktop.observe.screenshot', risk: 'L0', title: '截屏' },
  desktop_list_apps: { id: 'desktop.observe.list_apps', risk: 'L0', title: '列出应用' },
  desktop_list_windows: { id: 'desktop.observe.list_windows', risk: 'L0', title: '列出窗口' },
  // B 启动与窗口管理 —— 可复原，L1
  desktop_launch: { id: 'desktop.window.launch', risk: 'L1', title: '启动应用' },
  desktop_focus_window: { id: 'desktop.window.focus', risk: 'L1', title: '切换窗口焦点' },
  desktop_maximize: { id: 'desktop.window.maximize', risk: 'L1', title: '最大化窗口' },
  desktop_resize_window: { id: 'desktop.window.resize', risk: 'L1', title: '调整窗口尺寸' },
  // C 指针与滚动 —— 可复原，L1
  desktop_click: { id: 'desktop.pointer.click', risk: 'L1', title: '单击' },
  desktop_double_click: { id: 'desktop.pointer.double_click', risk: 'L1', title: '双击' },
  desktop_right_click: { id: 'desktop.pointer.right_click', risk: 'L1', title: '右键点击' },
  desktop_hover: { id: 'desktop.pointer.hover', risk: 'L1', title: '悬停' },
  desktop_scroll: { id: 'desktop.pointer.scroll', risk: 'L1', title: '滚动' },
  desktop_scroll_to: { id: 'desktop.pointer.scroll_to', risk: 'L1', title: '滚动到元素' },
  // D 键盘与表单 —— 可复原，L1
  desktop_type: { id: 'desktop.input.type', risk: 'L1', title: '输入文本' },
  desktop_set_value: { id: 'desktop.input.set_value', risk: 'L1', title: '设置控件值' },
  desktop_press: { id: 'desktop.input.press', risk: 'L1', title: '按键' },
  desktop_check: { id: 'desktop.input.check', risk: 'L1', title: '勾选' },
  desktop_uncheck: { id: 'desktop.input.uncheck', risk: 'L1', title: '取消勾选' },
  desktop_select: { id: 'desktop.input.select', risk: 'L1', title: '下拉选择' },
  desktop_toggle: { id: 'desktop.input.toggle', risk: 'L1', title: '开关切换' },
  // E 读取与等待 —— L0（wait 不改状态，只是时钟流逝）
  desktop_get: { id: 'desktop.query.get', risk: 'L0', title: '读取元素值' },
  desktop_is: { id: 'desktop.query.is', risk: 'L0', title: '元素状态断言' },
  desktop_wait: { id: 'desktop.query.wait', risk: 'L0', title: '等待条件' },
});

/**
 * 从白名单派生统一表条目，并在**模块加载期**校验三件事。
 *
 * 为什么校验放在加载期而不是测试期：本函数产出的表是审批闸的**规则来源**。
 * 「白名单有 26 项、统一表只有 25 条」这种不一致会让多出来的那个工具
 * **无规则可查** ⇒ 按 fail-open 语义可能直接放行。这种洞不能等到 CI 才发现，
 * 宁可在 `import` 那一刻就抛错（服务起不来，比带病运行安全）。
 */
function defineDesktopTools(): readonly CapabilityEntry[] {
  const entries: CapabilityEntry[] = [];
  for (const tool of DEFAULT_DESKTOP_TOOL_ALLOWLIST) {
    const meta = DESKTOP_TOOL_META[tool];
    if (!meta) {
      // 白名单加了工具但没标注 ⇒ 该工具在统一表里缺席 ⇒ 审批闸对它无规则（fail-open）
      throw new Error(
        `[upstream-tools] 白名单工具 "${tool}" 缺少 DESKTOP_TOOL_META 标注：` +
          `请补 id/risk/title（risk 必须对照实现体语义判断，不可默认 L1）`,
      );
    }
    entries.push(
      defineCapabilityEntry({
        id: meta.id,
        tool,
        surface: 'desktop',
        risk: meta.risk,
        title: meta.title,
      }),
    );
  }
  // 反向：标注表里有、白名单里没有 ⇒ 表在说谎（承诺了一条实际调不到的能力）
  const declared = new Set(Object.keys(DESKTOP_TOOL_META));
  const allowed = new Set(DEFAULT_DESKTOP_TOOL_ALLOWLIST);
  for (const tool of declared) {
    if (!allowed.has(tool)) {
      throw new Error(
        `[upstream-tools] DESKTOP_TOOL_META 声明了 "${tool}"，但它不在白名单里 ⇒ ` +
          `统一表会承诺一条实际不可达的能力（表说谎）`,
      );
    }
  }
  // 长度相等是前两条的推论，但单独钉一条更直观（也防「两边同时漏掉同一个」这类共模错误）
  if (entries.length !== DEFAULT_DESKTOP_TOOL_ALLOWLIST.length) {
    throw new Error(
      `[upstream-tools] 派生条数 ${entries.length} != 白名单长度 ${DEFAULT_DESKTOP_TOOL_ALLOWLIST.length}`,
    );
  }
  return Object.freeze(entries);
}

/**
 * desktop 面 25 条统一表条目（`desktop.<组>.<动作>`）。
 *
 * 与 `DEFAULT_DESKTOP_TOOL_ALLOWLIST` 的关系：**同源派生**，不是第二份事实。
 * 条数恒等于白名单长度；`tool` 字段逐条指回白名单里的上游工具名。
 */
export const DESKTOP_TOOLS: readonly CapabilityEntry[] = defineDesktopTools();
/* ==========================================================================
 * browser 面（33 项）—— V-NEXT 阶段 2.3
 * ==========================================================================
 *
 * ## 与 desktop 面的三处关键差异（照抄 desktop 的写法会出错）
 *
 * 1. **没有白名单**。`defaultUpstreamSpecs()` 里 browser 条目**不传** `toolAllowlist`
 *    ⇒ 上游 33 个工具**全量暴露**。所以这里没有「白名单 vs 标注表」的一致性问题，
 *    但也**失去了 desktop 那种「上游加工具不会自动进来」的天然保护**。
 * 2. **`tool` 字段必填且与 `id` 不同**。desktop 的 `tool` 是 `desktop_snapshot`，
 *    id 是 `desktop.observe.snapshot`；browser 同理 `agent_browser_open` vs `browser.nav.open`。
 *    `CapabilityEntry.tool` 的语义是「仅当 ≠ id 时才出现」，browser 33 项**全部需要写**。
 * 3. **风险分布必然含 L2**。desktop 的 L2=0 是因为白名单刻意排除了破坏性动作；
 *    browser 是全量，`eval`（页内执行任意 JS）在里面 ⇒ **`eval` = L2**。
 *    ⚠ 把 eval 降成 L1 会让审批闸**静默放行任意 JS 执行**，是本面单点最高风险。
 *
 * ## risk 判据（对照 `contracts/src/risk.ts` 的定义，逐条判断）
 *
 * | risk | 判据 | 本面成员 |
 * |---|---|---|
 * | `L0` 只读 | 不改变系统状态 | observe 7 + wait 4 + flow 2（list/steps）+ meta 1（tools_profiles）= **14** |
 * | `L1` 可回滚写 | 状态改变但可撤销 | nav 8 + act 6 + scroll 2 + flow 2（run/save）= **18** |
 * | `L2` 破坏性 | 不可逆或影响面大 | **`eval`**（meta 2 的另一项）= **1** |
 *
 * ⇒ 14 + 18 + 1 = **33**。⚠ 首版注释漏计 `meta.tools_profiles` 写成 L0=13，与实测不符，已订正。
 *
 * ⚠ 两处**不照抄上游 ref 自述**的判断（ref 的「标注」字段有误）：
 *   - `screenshot` ref 标「会改变状态」，但它只读取渲染结果、不改页面/站点任何状态 ⇒ **L0**。
 *     若照抄成 L1，后果是每次截屏都多走一次策略判定与审计（噪声，非安全损失）。
 *   - `tools_profiles` ref 标「会改变状态」，但它只是**列出** MCP 工具档位及启用方法 ⇒ **L0**。
 *   ref 的「标注」字段看起来是按「是否触达外部世界」打标，而非按「是否改变状态」——
 *   与 `risk.ts` 的 L0 定义（不改变系统状态）**不是同一个判据**，不能直接映射。
 */

/** browser 面 33 项统一表条目（`browser.<组>.<动作>`）。 */
export const BROWSER_TOOLS: readonly CapabilityEntry[] = Object.freeze(
  (
    [
      // ---- nav（导航，8）—— 改变浏览器状态但可回退/重开，L1 ----
      ['browser.nav.open', 'agent_browser_open', 'L1', '打开网址'],
      ['browser.nav.close', 'agent_browser_close', 'L1', '关闭浏览器'],
      ['browser.nav.reload', 'agent_browser_reload', 'L1', '重新加载'],
      ['browser.nav.back', 'agent_browser_back', 'L1', '后退'],
      ['browser.nav.forward', 'agent_browser_forward', 'L1', '前进'],
      ['browser.nav.tab_new', 'agent_browser_tab_new', 'L1', '新建标签页'],
      ['browser.nav.tab_switch', 'agent_browser_tab_switch', 'L1', '切换标签页'],
      ['browser.nav.tab_close', 'agent_browser_tab_close', 'L1', '关闭标签页'],
      // ---- observe（观察，7）—— 纯读取，L0 ----
      ['browser.observe.read', 'agent_browser_read', 'L0', '读取网页正文'],
      ['browser.observe.snapshot', 'agent_browser_snapshot', 'L0', '无障碍树快照'],
      ['browser.observe.get_text', 'agent_browser_get_text', 'L0', '读取元素文本'],
      ['browser.observe.get_title', 'agent_browser_get_title', 'L0', '读取页面标题'],
      ['browser.observe.get_url', 'agent_browser_get_url', 'L0', '读取当前网址'],
      ['browser.observe.tab_list', 'agent_browser_tab_list', 'L0', '列出标签页'],
      ['browser.observe.screenshot', 'agent_browser_screenshot', 'L0', '网页截屏'],
      // ---- act（交互，6）—— 表单/点击均可回滚，L1 ----
      ['browser.act.click', 'agent_browser_click', 'L1', '点击元素'],
      ['browser.act.fill', 'agent_browser_fill', 'L1', '填充输入框'],
      ['browser.act.select', 'agent_browser_select', 'L1', '下拉选择'],
      ['browser.act.check', 'agent_browser_check', 'L1', '勾选'],
      ['browser.act.uncheck', 'agent_browser_uncheck', 'L1', '取消勾选'],
      ['browser.act.type', 'agent_browser_type', 'L1', '输入文本'],
      // ---- wait（等待，4）—— 只是时钟/条件等待，不改状态，L0 ----
      ['browser.wait.for_load', 'agent_browser_wait_for_load', 'L0', '等待加载状态'],
      ['browser.wait.for_selector', 'agent_browser_wait_for_selector', 'L0', '等待元素出现'],
      ['browser.wait.for_text', 'agent_browser_wait_for_text', 'L0', '等待文本出现'],
      ['browser.wait.ms', 'agent_browser_wait_ms', 'L0', '固定等待毫秒'],
      // ---- scroll（滚动/按键，2）—— 改变视口与页面焦点，可复原，L1 ----
      ['browser.scroll.scroll', 'agent_browser_scroll', 'L1', '滚动页面'],
      ['browser.scroll.press', 'agent_browser_press', 'L1', '按键'],
      // ---- flow（任务流，4）—— list/steps 只读 L0；run/save 会重放/写入 L1 ----
      ['browser.flow.list', 'agent_browser_flow_list', 'L0', '列出已保存任务流'],
      ['browser.flow.steps', 'agent_browser_flow_steps', 'L0', '列出已捕获步骤'],
      ['browser.flow.run', 'agent_browser_flow_run', 'L1', '重放任务流'],
      ['browser.flow.save', 'agent_browser_flow_save', 'L1', '保存任务流'],
      // ---- meta（元，2）—— profiles 只读；eval 能绕过其余 32 项的一切限制，L2 ----
      ['browser.meta.tools_profiles', 'agent_browser_tools_profiles', 'L0', '列出工具档位'],
      ['browser.meta.eval', 'agent_browser_eval', 'L2', '页内执行 JS'],
    ] as const
  ).map(([id, tool, risk, title]) =>
    defineCapabilityEntry({ id, tool, surface: 'browser', risk, title }),
  ),
);

// ---- 加载期校验（不是测试期）----
// browser 没有白名单可以「派生 + 双向比对」，所以校验换成三条**等价的完整性断言**：
//   ① 条数恰 33（漏一项 ⇒ 该工具在审批闸无规则 ⇒ fail-open，与 desktop 同类风险）
//   ② id 无重复（三段式与 surface 首段由 defineCapabilityEntry 保证）
//   ③ tool 无重复（两个 id 指向同一个上游工具 ⇒ 同一工具的 risk 可能不一致）
{
  const expected = 33;
  if (BROWSER_TOOLS.length !== expected) {
    throw new Error(
      `[upstream-tools] BROWSER_TOOLS 条数 ${BROWSER_TOOLS.length} != ${expected}：` +
        `browser 面无白名单，条数即上游全量面；少了会让对应工具静默无规则。`,
    );
  }
  const ids = new Set<string>();
  const tools = new Set<string>();
  for (const e of BROWSER_TOOLS) {
    if (ids.has(e.id)) throw new Error(`[upstream-tools] BROWSER_TOOLS id 重复：${e.id}`);
    ids.add(e.id);
    const t = e.tool ?? e.id;
    if (tools.has(t)) {
      throw new Error(
        `[upstream-tools] BROWSER_TOOLS tool 重复：${t} —— 同一上游工具被两个 id 指向，` +
          `两处 risk 可能不一致，审批闸会按先命中的那条放行。`,
      );
    }
    tools.add(t);
  }
}

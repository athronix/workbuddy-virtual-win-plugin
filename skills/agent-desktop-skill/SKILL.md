---
name: agent-desktop-skill
version: 1.0.0
agent_created: true
description: "Windows VM 桌面应用自动化的工具选型与用法速查（agent-desktop MCP，75 工具 / 默认暴露 10）。当任务需要**操作 GUI 应用本身**——按按钮、填表单、选菜单、切页签、拖拽、读窗口内容、启动/关闭应用、多窗口排布、读剪贴板、关通知——而不是操作文件系统或系统服务时触发。含场景→工具映射、十个核心工具的用法与参数、白名单机制、与 winvm gui.* 的分工、失败判据。每个工具的完整参数表见 references/<tool-name>.md。"
---

# agent-desktop-skill：Windows 桌面应用自动化

> 服务形态：VM 内 `agent-desktop mcp`（stdio）由 **vm-service 反向代理**成 `POST /mcp/desktop`，与 winvm 主工具面**共用同一条 SSH 隧道**（宿主）或**同一个回环端口**（VM 内）。
>
> **端点自适（本 skill 两端共用，按你所在一端读）**：
> - **鸿蒙宿主 Agent**：经 `connector:winvm-desktop` → 本地 `127.0.0.1:18443/mcp/desktop`（**由常驻隧道守护进程转发，勿手工建 SSH 转发**）；
> - **VM 内 Agent（codebuddy-lite）**：经 `mcpServers.winvm-desktop` → 同一 `127.0.0.1:18443/mcp/desktop`（**VM 内是直连回环，无隧道**）。
>
> 工具名、参数、白名单机制、Session 1 判据、失败判据**两端完全一致** —— 下面的 §0–§11 与端无关。
> 唯一例外：**§5 的「解禁白名单」只有宿主/VM 内**两边都需改**服务端**（`DEFAULT_DESKTOP_TOOL_ALLOWLIST`），改宿主侧 `disabledTools` 无效。
> 全部 75 个工具的逐条参数与示例在 `references/`，本文只讲「什么时候用哪个、怎么用对」。

## 0. 一句话规则

**「界面上的东西，用 agent-desktop 按语义操作；文件系统/系统服务/注册表，用 winvm 54 能力。」**

agent-desktop 走**操作系统无障碍（accessibility / UIA）接口**：拿到的是带 `@ref` 的元素树，动作是「按这个元素」而不是「点这个坐标」。所以它天然抗分辨率、抗窗口位置、抗 DPI 缩放——这是它相对坐标级键鼠的决定性优势。

## 1. 能做什么 / 不做什么

| 能做 | 典型任务 |
|---|---|
| 观察界面 | 列应用/窗口、抓无障碍树、按角色名称检索元素、读元素属性与状态、窗口截图 |
| 操作控件 | 点击、输入、直接设值、下拉选择、勾选/取消、展开/收起、滚动、按键组合 |
| 管窗口 | 启动/关闭应用、置前、移动、改尺寸、最小化/最大化/还原 |
| 系统面 | 开始菜单/任务栏/托盘等系统面、通知中心（列/关/点动作按钮）、剪贴板读写 |
| 同步 | 等到元素出现/文本出现/窗口出现/通知出现，而不是 sleep 猜 |

| 不做（走别的通道） |
|---|
| 文件读写/复制/删除/搜索 → `winvm storage.*` |
| 服务/进程/注册表/计划任务/电源 → `winvm system.*` |
| 装软件/卸载/盘点已装应用 → `winvm app.winget.*`（非交互会话限制见 `hos-win-skill`） |
| 网页内容抓取与网页内交互 → `agent-browser-skill`（见 §5 分工） |
| 坐标级物理输入（双击/拖拽/滚轮） → 本项目服务端**默认无头**，会返回 `POLICY_DENIED`，别硬试 |

## 2. 三条铁律

1. **先看后动**：任何动作前必须先有 `desktop_snapshot`（或 `desktop_find`）拿到 `ref_id`。**凭空猜 ref 一定失败**。
2. **ref 一次性**：`@ref` / `ref_id` 只在产生它的那次快照里有效。界面一变（点了一下、切了页签、弹了框）就**重新快照**，不要复用旧 ref 重试。
3. **动完必同步**：动作 → `desktop_wait`（等元素/文本/窗口，不睡固定秒数）→ 再快照校验。GUI 是异步的，`click` 返回 ≠ 界面已就绪。

## 3. 标准工作流（95% 的任务都是这个形状）

```
desktop_list_apps                      ← 目标应用在不在跑？（不在先 desktop_launch）
desktop_list_windows {app}             ← 有几个窗口？拿 window_id 收敛范围
desktop_focus_window {window_id}       ← 置前（否则无障碍动作可能打到后台窗口）
desktop_snapshot {app|window_id, interactive_only:true}
   ↓ 从树里挑 ref_id
desktop_click {ref_id} | desktop_set_value {ref_id,value} | desktop_press {combo}
desktop_wait {event:"element"|"text"|"window", ...}
desktop_snapshot                        ← 校验结果（或 desktop_get / desktop_is 单点确认）
```

写进一次调用的捷径：`desktop_batch`（顺序执行多条命令、非原子、默认遇错停）。只在步骤完全确定时用，排障时仍建议逐条可见。

## 4. 十个默认工具（服务端白名单）——核心用法

白名单 = 「观察 → 定位 → 交互 → 等待」闭环的最小面。这十个**开箱即用**，其余 65 个需解禁（§5）。

| 工具 | 什么时候用 | 关键参数与坑 |
|---|---|---|
| `desktop_list_apps` | 每轮开始必跑一次 | 返回正在跑的 GUI 应用。**返回空数组 = 你的进程不在 Session 1**（见 §6），不是安装坏了 |
| `desktop_list_windows` | 应用有多个窗口 / 要拿 `window_id` | `app` 过滤；同名多窗口时后续动作必须带 `window_id` |
| `desktop_snapshot` | 拿 ref 的唯一来源 | `app`/`window_id` 限定范围；`interactive_only:true` 只留可交互元素（推荐）；`max_depth` 默认 10，深树可 `skeleton` 先看轮廓；`timeout_ms` 默认 3000，Chromium 慢时抬高 |
| `desktop_find` | 已知名称/角色，不想 dump 全树 | 按 `role`/`name`/`value`/`text` 检索，直接给 ref；`first`/`last`/`nth`/`count` 处理多个匹配 |
| `desktop_click` | 语义点击（首选交互方式） | 只吃 `ref_id`；不移动真实指针 ⇒ 不要求 headed、不受遮挡影响 |
| `desktop_set_value` | 填输入框（首选） | 走属性写入，比逐字输入快、不受输入法与中文影响 |
| `desktop_type` | 需要「模拟真人逐字输入」时 | 先聚焦；`interval_ms` 控速 |
| `desktop_press` | 键盘快捷键 / 提交 / Esc | `combo` 如 `ctrl+s`、`shift+tab`、`return`；打到当前焦点，必要时带 `app`/`window_id` |
| `desktop_wait` | 每步动作后的同步点 | 用 `event`/`element`/`text`/`window` 等条件，别用 `ms` 猜；`timeout` 给足 |
| `desktop_screenshot` | 视觉取证 / 无障碍树不可靠时（自绘界面、游戏、Canvas） | 只回 PNG 路径，**不产生 ref**；后续操作仍需 snapshot 或坐标 |

## 5. 白名单机制（75 → 10，为什么要解禁、怎么解禁）

- 原因：这 75 个工具能读整个桌面（含剪贴板、全屏截图）并操作任意窗口。全量暴露 = 把 VM 桌面完整交给宿主 LLM。默认只给高频安全子集，**破坏性动作（`desktop_close_app` / `clipboard_set` / `drag` / `sandbox_*`）默认不给**。
- 解禁方式（按改动成本从低到高）：
  1. **交付层**：`delivery/install-host.mjs` 里该 connector 的 `disabledTools` 是反向放开面——白名单外的工具在服务端就被过滤，宿主侧 `disabledTools` 只能再收紧、不能放宽，所以**真正解禁必须改服务端**。
  2. **服务端**：母项目 `packages/vm-service/src/mcp-upstream.ts` 的 `DEFAULT_DESKTOP_TOOL_ALLOWLIST` 追加工具名 → `tsc -b` → 重推 VM/native → 重启 `WinVMBridge.Service`。
  3. 临时验证：直接 `POST /mcp/desktop` 打 `tools/call`（服务端仍按白名单拒），或改白名单后重启服务。
- 常见需要解禁的：`desktop_focus_window`（多窗口置前）、`desktop_resize_window` / `desktop_move_window`（窗口排布）、`desktop_launch`（启动应用）、`desktop_get` / `desktop_is`（单点读状态）、`desktop_select` / `desktop_check`（表单控件）、`desktop_scroll`、窗口最小化/最大化。
- **白名单外的工具调用会收到明确错误**（"未在本上游的暴露清单内"），不会静默失败——看到这个错误就是白名单问题，不是权限或通道问题。

## 6. 为什么它必须跑在 Session 1（读不到桌面时先看这条）

`agent-desktop` 读的是**当前登录会话的桌面**。Windows 服务/SYSTEM 会话必落 **Session 0**，那里没有用户桌面 ⇒ `desktop_list_apps` 返回 `[]`。

本项目的解法：vm-service 由**计划任务 + InteractiveToken + LogonTrigger** 托管在 **Session 1**，`agent-desktop` 是它的子进程 ⇒ **继承 Session 1**。

**因此：SSH 直启 `agent-desktop` 永远拿不到真实桌面**（SSH 落到 Session 0）。必须经 `/mcp/desktop`（隧道 → vm-service → 子进程）调用。

判据：`GET /health` 的 `session.windowStation = "WinSta0"`、`session.interactive = true`、`session.state = "healthy"`。三项不满足时桌面类工具全是空的，先修会话再谈工具。

## 7. 场景 → 工具速查

| 我要… | 用 |
|---|---|
| 知道桌面现在有什么 | `desktop_list_apps` → `desktop_list_windows` |
| 打开一个应用 | `desktop_launch {app}`（`activate:true` 等窗口出现）— 需解禁 |
| 关掉一个应用 | `desktop_close_app {app, force}` — 需解禁；**破坏性，A2A 委派更合适** |
| 找到「保存」按钮 | `desktop_find {app, role:"button", name:"保存"}`；找不到再 `desktop_snapshot` 看树 |
| 填一个输入框 | `desktop_set_value {ref_id, value}`（首选）／`desktop_type`（要逐字效果） |
| 勾选复选框 | `desktop_check` / `desktop_uncheck`（幂等）/ `desktop_toggle`（取反）— 需解禁 |
| 选下拉项 | `desktop_select {ref_id, value}` — 需解禁 |
| 键盘快捷键 | `desktop_press {combo:"ctrl+s"}` |
| 滚动列表 | `desktop_scroll {ref_id, direction, amount}` / `desktop_scroll_to` — 需解禁 |
| 等某个对话框弹出 | `desktop_wait {window:"标题"}` 或 `{text:"已完成"}` |
| 确认某个控件是否可用 | `desktop_is {ref_id, property:"enabled"}` — 需解禁 |
| 读控件上的文字 | `desktop_get {ref_id, property:"text"}` — 需解禁 |
| 界面自绘、无障碍树是空的 | `desktop_screenshot` 人工/多模态判断；必要时降级到 `winvm gui.*` 坐标方案 |
| 把窗口摆好位置 | `desktop_focus_window` / `move_window` / `resize_window` / `minimize` / `maximize` — 需解禁 |
| 读写剪贴板 | `desktop_clipboard_get` / `_set` / `_clear` — 需解禁（`winvm gui.clipboard.manage` 亦可用） |
| 清掉右下角通知 | `desktop_list_notifications` → `desktop_dismiss_all_notifications` — 需解禁 |
| 打开开始菜单/任务栏 | `desktop_open_system_surface {surface}` — 需解禁 |

## 8. 常见失败与判据

| 现象 | 根因 | 处置 |
|---|---|---|
| `desktop_list_apps` 返回 `apps: []` | 进程不在 Session 1（SSH 直启 / 服务落在 Session 0） | 查 `/health` 的 `session.*`；改走 `/mcp/desktop`；重启用 `schtasks /End` + `/Run` |
| `工具 xxx 未在本上游的暴露清单内` | 白名单外 | 按 §5 解禁后重启服务 |
| 动作报 `POLICY_DENIED` | 物理输入类工具需要 `--headed`，本服务默认无头 | 换语义动作（`click`/`set_value`/`press`）；或改服务启动参数后重启 |
| `stale ref` / 找不到元素 | 界面已变，ref 过期 | 重新 `desktop_snapshot` 取新 ref，不要重试旧 ref |
| `desktop_find` 命中多个 | 名称/角色不够特异 | 加 `role`、`nth`、`first`/`last`，或先收敛到 `window_id` |
| 点了没反应 | 窗口未置前（动作打到后台）/ 需要等异步 | 先 `desktop_focus_window`；动作后 `desktop_wait` 再校验 |
| 中文输入乱码/丢失 | 逐字输入受输入法影响 | 改用 `desktop_set_value` |
| 首次调用 ~8–12s 才返回 | 上游懒启动 + 桌面树首次抓取 | 正常；之后同进程内快得多 |

## 9. 分工：agent-desktop vs winvm gui.* vs agent-browser

| 场景 | 选谁 | 理由 |
|---|---|---|
| 操作原生 Windows 应用（Office/记事本/设置/自研客户端） | **agent-desktop** | 语义树 + 语义动作，稳；`winvm gui.uia.*` 是同一套 UIA 的项目内封装，能力更窄（只到 UIA 树与调用） |
| 需要窗口管理、启动应用、通知、剪贴板 | **agent-desktop** | 这些 `winvm gui.*` 没有 |
| 需要精确坐标、像素级校验、看屏决策循环 | `winvm gui.screen.capture/analyze` + `gui.input.*` | 像素级；代价是脆（分辨率/DPI 变就失效） |
| 网页内容与网页内交互 | **agent-browser** | 走 Playwright/CDP，比操作浏览器窗口的 a11y 树稳定得多 |
| 文件/服务/注册表/装软件 | `winvm storage.* / system.* / app.*` | 与 GUI 无关，别用界面绕 |

## 10. 参考索引（75 个工具）

### 观察与读取
[desktop_snapshot](references/desktop_snapshot.md) · [desktop_find](references/desktop_find.md) · [desktop_screenshot](references/desktop_screenshot.md) · [desktop_get](references/desktop_get.md) · [desktop_is](references/desktop_is.md) · [desktop_list_apps](references/desktop_list_apps.md) · [desktop_list_windows](references/desktop_list_windows.md) · [desktop_list_displays](references/desktop_list_displays.md) · [desktop_list_surfaces](references/desktop_list_surfaces.md) · [desktop_status](references/desktop_status.md) · [desktop_permissions](references/desktop_permissions.md) · [desktop_version](references/desktop_version.md)

### 控件交互（语义）
[desktop_click](references/desktop_click.md) · [desktop_type](references/desktop_type.md) · [desktop_set_value](references/desktop_set_value.md) · [desktop_clear](references/desktop_clear.md) · [desktop_focus](references/desktop_focus.md) · [desktop_select](references/desktop_select.md) · [desktop_toggle](references/desktop_toggle.md) · [desktop_check](references/desktop_check.md) · [desktop_uncheck](references/desktop_uncheck.md) · [desktop_expand](references/desktop_expand.md) · [desktop_collapse](references/desktop_collapse.md) · [desktop_scroll](references/desktop_scroll.md) · [desktop_scroll_to](references/desktop_scroll_to.md) · [desktop_press](references/desktop_press.md)

### 物理输入（需 `--headed`）
[desktop_double_click](references/desktop_double_click.md) · [desktop_triple_click](references/desktop_triple_click.md) · [desktop_right_click](references/desktop_right_click.md) · [desktop_hover](references/desktop_hover.md) · [desktop_drag](references/desktop_drag.md) · [desktop_mouse_move](references/desktop_mouse_move.md) · [desktop_mouse_click](references/desktop_mouse_click.md) · [desktop_mouse_down](references/desktop_mouse_down.md) · [desktop_mouse_up](references/desktop_mouse_up.md) · [desktop_mouse_wheel](references/desktop_mouse_wheel.md) · [desktop_key_down](references/desktop_key_down.md) · [desktop_key_up](references/desktop_key_up.md)

### 应用与窗口
[desktop_launch](references/desktop_launch.md) · [desktop_close_app](references/desktop_close_app.md) · [desktop_focus_window](references/desktop_focus_window.md) · [desktop_resize_window](references/desktop_resize_window.md) · [desktop_move_window](references/desktop_move_window.md) · [desktop_minimize](references/desktop_minimize.md) · [desktop_maximize](references/desktop_maximize.md) · [desktop_restore](references/desktop_restore.md) · [desktop_open_system_surface](references/desktop_open_system_surface.md)

### 通知与剪贴板
[desktop_list_notifications](references/desktop_list_notifications.md) · [desktop_dismiss_notification](references/desktop_dismiss_notification.md) · [desktop_dismiss_all_notifications](references/desktop_dismiss_all_notifications.md) · [desktop_notification_action](references/desktop_notification_action.md) · [desktop_clipboard_get](references/desktop_clipboard_get.md) · [desktop_clipboard_set](references/desktop_clipboard_set.md) · [desktop_clipboard_clear](references/desktop_clipboard_clear.md)

### 同步与批处理
[desktop_wait](references/desktop_wait.md) · [desktop_batch](references/desktop_batch.md)

### 会话 / 轨迹 / 光标（调试取证）
[desktop_session_start](references/desktop_session_start.md) · [desktop_session_end](references/desktop_session_end.md) · [desktop_session_list](references/desktop_session_list.md) · [desktop_session_gc](references/desktop_session_gc.md) · [desktop_trace_show](references/desktop_trace_show.md) · [desktop_trace_export](references/desktop_trace_export.md) · [desktop_cursor_overlay_enable](references/desktop_cursor_overlay_enable.md) · [desktop_cursor_overlay_disable](references/desktop_cursor_overlay_disable.md)

### 内置技能与沙箱（本项目默认不用）
[desktop_skills_list](references/desktop_skills_list.md) · [desktop_skills_get](references/desktop_skills_get.md) · [desktop_skills_path](references/desktop_skills_path.md) · [desktop_sandbox_install](references/desktop_sandbox_install.md) · [desktop_sandbox_create](references/desktop_sandbox_create.md) · [desktop_sandbox_start](references/desktop_sandbox_start.md) · [desktop_sandbox_stop](references/desktop_sandbox_stop.md) · [desktop_sandbox_status](references/desktop_sandbox_status.md) · [desktop_sandbox_list](references/desktop_sandbox_list.md) · [desktop_sandbox_rm](references/desktop_sandbox_rm.md) · [desktop_sandbox_exec](references/desktop_sandbox_exec.md)

## 11. 与其它技能的关系

| Skill | 关系 |
|---|---|
| `hos-win-skill` | 上层分派：判定走不走向 Windows、走哪条通道（MCP 直调 / A2A 委派） |
| `agent-browser-skill` | 平级：网页内的一切操作归它；二者都经同一条隧道 |
| `winvm-orchestrator` / `winvm-gui-automation` | VM 侧的总控与 GUI 域细则；跨多能力编排时以它们为准 |
| `winvm-plugin-deploy` | 本 MCP 的装机/卸载/复验权威（第 4 步 4a 装上游、4c 判据、第 2 步卸载清理） |

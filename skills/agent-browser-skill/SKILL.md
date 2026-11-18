---
name: agent-browser-skill
version: 1.0.0
agent_created: true
description: "Windows VM 浏览器自动化的工具选型与用法速查（agent-browser MCP，33 工具全量暴露）。当任务需要**打开网页、读网页内容、点网页元素、填网页表单、抓数据、多标签页操作、截图存证、在页面里跑 JS** 时触发。含场景→工具映射、核心工作流（open→snapshot→动作→wait）、与 agent-desktop / WebFetch 的分工、失败判据。每个工具的完整参数表见 references/<tool-name>.md。"
---

# agent-browser-skill：Windows VM 浏览器自动化

> 服务形态：VM 内 `agent-browser mcp`（stdio）由 **vm-service 反向代理**成 `POST /mcp/browser`，宿主侧 connector = `connector:winvm-browser`，与 winvm 主连接器**共用同一条 SSH 隧道**。
> 33 个工具全量暴露（服务端不设白名单）；逐条参数与示例在 `references/`。

## 0. 一句话规则

**「网页里的事归它：能 `read` 就别 `open`，能 `snapshot` 就别 `eval`，能用 `@ref` 就别用坐标。」**

它跑的是真实 Chromium（Playwright/CDP），**在 VM 内渲染**——这意味着：① 出口 IP 是 VM 的，能访问 VM 能访问的内网/企业系统；② 有真实登录态与 Cookie（可人工先在 VM 里登录一次）；③ 不受宿主沙箱限制。

## 1. 三条路先分清：read / open / WebFetch

| 我要… | 选谁 | 说明 |
|---|---|---|
| 只读一篇网页/文档的文字 | **`agent_browser_read`**（首选） | 不开浏览器，直接取 text/markdown，最快最省。`url` 省略时读当前标签页 |
| 页面要登录、要 JS 渲染、要交互（点/填/翻页） | `agent_browser_open` → 后续交互工具 | 真实浏览器，慢但全能 |
| 宿主自己就能取到的公开网页（无登录、无地域限制） | 宿主侧 WebFetch | 不必绕 VM，少一跳 |

## 2. 标准工作流

```
agent_browser_open {url}                ← 首个调用，冷启约 8~13s（含浏览器拉起），正常
agent_browser_snapshot {interactive:true}   ← 拿 @ref（后续动作的唯一坐标）
   ↓ 挑 ref
agent_browser_click {selector:"@e12"}
agent_browser_wait_for_selector {selector:"#result", state:"visible"}   ← 别用 wait_ms 猜
agent_browser_snapshot                  ← 校验新状态
agent_browser_screenshot {fullPage:true}     ← 需要存证时
agent_browser_close {all:true}          ← 收尾，释放 VM 资源
```

- **`@ref` 一次性**：只在产生它的快照内有效。动作报 stale ref ⇒ 重新快照，**不要重试旧 ref**。
- 表单：`fill`（清空后填）> `type`（逐字，可 `delayMs`）；`select` 选下拉；`check`/`uncheck` 处理勾选。
- 提交：`click` 提交按钮，或 `press {key:"Enter"}`。
- 等：优先 `wait_for_selector` / `wait_for_text` / `wait_for_load`；`wait_ms` 只在没有可等待判据时兜底。

## 3. 场景 → 工具速查

| 我要… | 用 |
|---|---|
| 打开一个网址 | `agent_browser_open {url}` |
| 读网页文字（不开浏览器） | `agent_browser_read {url}` / `{url, raw:true}` / `{outline:true}` 看结构 |
| 看页面上有什么可点的 | `agent_browser_snapshot {interactive:true}`（`compact`/`depth` 控体积，`delta` 只回变化） |
| 点按钮/链接 | `agent_browser_click {selector:"@e12"}`（`newTab:true` 开新页签） |
| 填搜索框 | `agent_browser_fill {selector:"@e5", text:"..."}` |
| 选下拉 | `agent_browser_select {selector:"@e9", values:["A"]}` |
| 勾选协议框 | `agent_browser_check {selector:"@e20"}` |
| 翻页 / 加载更多 | 先 `agent_browser_scroll {direction:"down", amount:N}`，再等文本/元素 |
| 等页面加载完 | `agent_browser_wait_for_load {state:"networkidle"}`（超时会报错，不静默） |
| 等某段文字出现 | `agent_browser_wait_for_text {text:"提交成功"}` |
| 取某个元素的文字 | `agent_browser_get_text {selector:"@e30"}` |
| 取当前 URL / 标题 | `agent_browser_get_url` / `agent_browser_get_title` |
| 截图存证 | `agent_browser_screenshot {fullPage:true, annotate:true}` |
| 页面里跑一段 JS 取结构化数据 | `agent_browser_eval {script:"..."}`（脚本走 stdin，无 shell 转义问题） |
| 多标签页 | `agent_browser_tab_new {url}` → `tab_list` → `tab_switch {tab:"t2"}` → `tab_close` |
| 后退/前进/刷新 | `agent_browser_back` / `forward` / `reload` |
| 重放固定流程（实验性） | `capture` 录制 → `flow_save` → `flow_run {name}`（优先于快照+点击） |
| 关掉浏览器释放资源 | `agent_browser_close {all:true}` |

## 4. 核心工具用法细节

| 工具 | 关键点 |
|---|---|
| `agent_browser_open` | `headed:true` 开可视窗口（人工介入/排障时用）；`session` 隔离实例（并行任务不互踩标签页）；`allowedDomains` 限制域名；`restore` 复用浏览器状态（登录态）；`timeoutMs` 默认 120s |
| `agent_browser_read` | 返回 agent 友好文本，优先 text/markdown。`filter` 截取片段、`outline` 只看大纲、`raw` 原始内容、`requireMd` 强制 markdown、`llms` 走站点的 llms.txt |
| `agent_browser_snapshot` | `interactive:true` 只留可交互元素（推荐）；`compact` 压缩；`depth` 限深；`delta:true` 相对上次只回变化；`includeUrls` 带链接地址；`selector` 限定子树 |
| `agent_browser_click` | `selector` 可为 `@ref` 或 CSS；`human:true` 拟人化移动；`newTab:true` 新页签打开 |
| `agent_browser_fill` | 先清空再填（等价「全选删除+输入」）；需要逐字效果改用 `type` |
| `agent_browser_type` | `clear:true` 先清空；`delayMs` 控速 |
| `agent_browser_wait_for_selector` | `state` 支持 visible/hidden/attached/detached；**裸数字选择器被拒绝**（数字 id 用 `#123` 之类 CSS 语法） |
| `agent_browser_screenshot` | `fullPage` 整页；`selector` 只截元素；`annotate` 标注可交互元素；`ifChanged`/`threshold` 只在变化时重截；小幅图会以图片内容直回 |
| `agent_browser_eval` | 在页面上下文执行 JS；顶层结果无法 JSON 表示时返回 `data.unserializable` 标记 |
| `agent_browser_close` | `all:true` 关全部会话；只关当前可省略参数 |

## 5. 常见失败与判据

| 现象 | 根因 | 处置 |
|---|---|---|
| 首次 `open` 8~13s | 冷启动（拉 Chromium + 首帧） | 正常，非故障；后续调用快 |
| `stale ref` | 界面已变 | 重新 `snapshot` 取新 ref |
| 选择器找不到元素 | 页面还在渲染 / 选择器写错 / 在 iframe 内 | 先 `wait_for_selector`；跨 iframe 用快照里的 Iframe 角色节点定位 |
| `wait_for_selector` 报裸数字非法 | 传了 `123` 这样的纯数字 | 改 CSS（`#123`）或改用 `wait_ms` |
| 打开的是空白页 | `url` 省略 / 被 `allowedDomains` 拦 | 显式给 `url`；检查域名白名单 |
| 站点要求登录 | VM 内无会话 | 人工在 VM 里 `headed:true` 登录一次，配合 `restore` 复用状态；或改用带凭据的接口 |
| 页面语言/内容与预期不符 | 站点按 IP/UA/地区分流（VM 出口 IP） | 属环境差异；必要时 `extraArgs` 指定 UA/engine，或改由宿主 WebFetch |
| 调用返回 502 | VM 内 `agent-browser` 未安装（部署时 `--skip-upstreams` 或 npm 失败） | 重跑部署第 4 步装上游；`/health.upstreams` 看 `state` |
| 多个任务互相踩标签页 | 共用默认 session | 每个任务显式传 `session` |

## 6. 与相邻能力的分工

| 场景 | 选谁 | 理由 |
|---|---|---|
| 网页内容 / 网页交互 | **agent-browser** | 真实浏览器 + 语义 ref |
| 原生 Windows 应用界面（Office/客户端/设置） | `agent-desktop-skill` | 无障碍树，不是网页 |
| 需要「在浏览器窗口里模拟真人点击可见位置」 | `desktop_*`（同一条隧道） | 但通常没必要——CDP 更稳 |
| 宿主本地公开网页快读 | 宿主 WebFetch | 少一跳，不必绕 VM |
| 下载文件后的落盘处理 | `winvm storage.*` | 浏览器只管页面，文件操作归存储域 |

## 7. 参考索引（33 个工具）

### 会话与导航
[agent_browser_open](references/agent_browser_open.md) · [agent_browser_read](references/agent_browser_read.md) · [agent_browser_close](references/agent_browser_close.md) · [agent_browser_back](references/agent_browser_back.md) · [agent_browser_forward](references/agent_browser_forward.md) · [agent_browser_reload](references/agent_browser_reload.md) · [agent_browser_get_url](references/agent_browser_get_url.md) · [agent_browser_get_title](references/agent_browser_get_title.md)

### 观察与取值
[agent_browser_snapshot](references/agent_browser_snapshot.md) · [agent_browser_screenshot](references/agent_browser_screenshot.md) · [agent_browser_get_text](references/agent_browser_get_text.md) · [agent_browser_eval](references/agent_browser_eval.md)

### 交互
[agent_browser_click](references/agent_browser_click.md) · [agent_browser_fill](references/agent_browser_fill.md) · [agent_browser_type](references/agent_browser_type.md) · [agent_browser_press](references/agent_browser_press.md) · [agent_browser_select](references/agent_browser_select.md) · [agent_browser_check](references/agent_browser_check.md) · [agent_browser_uncheck](references/agent_browser_uncheck.md) · [agent_browser_scroll](references/agent_browser_scroll.md)

### 等待与同步
[agent_browser_wait_for_selector](references/agent_browser_wait_for_selector.md) · [agent_browser_wait_for_text](references/agent_browser_wait_for_text.md) · [agent_browser_wait_for_load](references/agent_browser_wait_for_load.md) · [agent_browser_wait_ms](references/agent_browser_wait_ms.md)

### 标签页
[agent_browser_tab_new](references/agent_browser_tab_new.md) · [agent_browser_tab_list](references/agent_browser_tab_list.md) · [agent_browser_tab_switch](references/agent_browser_tab_switch.md) · [agent_browser_tab_close](references/agent_browser_tab_close.md)

### 任务流（实验性）
[agent_browser_flow_list](references/agent_browser_flow_list.md) · [agent_browser_flow_run](references/agent_browser_flow_run.md) · [agent_browser_flow_steps](references/agent_browser_flow_steps.md) · [agent_browser_flow_save](references/agent_browser_flow_save.md) · [agent_browser_tools_profiles](references/agent_browser_tools_profiles.md)

## 8. 与其它技能的关系

| Skill | 关系 |
|---|---|
| `hos-win-skill` | 上层分派：判定何时该走浏览器而不是别的手段 |
| `agent-desktop-skill` | 平级：原生应用界面归它；二者共用同一条隧道 |
| `winvm-plugin-deploy` | 本 MCP 的装机/卸载/复验权威（第 4 步 4a 装上游、4c 判据、第 2 步卸载清理） |

---
id: winvm-gui-automation
name: Windows GUI 与桌面自动化
description: >
  在 Windows 虚拟机内做图形化操作：截图与判读、键鼠模拟、窗口枚举与控制、
  UIA 元素定位与点击、剪贴板（只读）、等待条件。网页操作经 UIA+键鼠完成
  （CDP 浏览器直驱为 V2 规划·当前不可用）。用于"看看虚拟机屏幕"
  "点开某个窗口""在虚拟机里登录某网站"等。
version: 0.1.0
domains: [gui]
triggers:
  - 虚拟机屏幕
  - 虚拟机截图
  - 虚拟机窗口
relatedSkills:
  - winvm-orchestrator
---

# Windows GUI 与桌面自动化

> **前置（隧道在线健康）**：任何工具调用前先确保隧道在线健康 ——
> 运行 `~/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0/winvm-plugin tunnel ensure`（幂等；不健康自动重启）→ 再 `… health` 需 `ok:true`（**部署态命令，任意 cwd 可用**）。
> 详见 [`winvm-orchestrator`](../winvm-orchestrator/SKILL.md) §前置检查：tunnel 在线健康。

## ⚠ 最重要的前提：交互式会话

本域所有能力都**要求 Windows 交互式会话**（`WinSta0\Default`，Session ≥ 1）。

| 症状 | 根因 | 处置 |
|---|---|---|
| 截图全黑、键鼠 `Access denied` | 服务跑在 **Session 0**（被注册成了 Windows 服务） | 改为在用户登录会话内启动（登录自启 / 计划任务「仅在用户登录时运行」/ 托盘程序） |
| 之前能用，RDP 断开后失效 | 会话被挂起为无头状态 | **需人工在 VM 物理控制台（或 Hyper-V 会话窗口）操作恢复**：`tscon <sessionId> /dest:console` 归还控制台属**手工配方**——本插件无自动恢复实现（session-guard 为规划项）、工具面也不透出 sessionId 数据源，**Agent 不可自动执行**，只向用户转述该人工路径；配置自动登录同理（人工） |
| 锁屏状态 | LogonUI 占据前台 | 先解锁 |

**规则**：`meta.session.status` 返回 `unavailable` 或 `black-screen` 时，
**不要重试** —— 明确告知用户并给出上述修复建议。系统对此有专门检测，
黑屏会被识别并报 `SESSION_BLACK_SCREEN`，而不是静默返回一张黑图。

## 适用与不适用

**适用**：需要"看见并操作"的任务 —— 图形应用、安装向导、浏览器流程、无法用命令行的界面。

**不适用**：能用命令行/API 完成的事。GUI 自动化**更慢、更脆**，
能用 `winget`/PowerShell 完成时应优先走命令行（见 `winvm-system-admin` / `winvm-app-manager`）。

## 前置检查（本域额外增加）

1. 总控 §前置检查（隧道 / 健康）
2. **会话检查**：`meta.session.status` 必须 `state == healthy`
3. **屏幕校验**：`gui.screen.analyze` 确认非黑屏

## 通道选择

- **单次截图** → **MCP 直调**（`gui.screen.capture`，结果直接作为 artifact 回传）
- **"看屏幕→决定→再操作"的循环** → **A2A 委派**（截图作为 artifact，Agent 内部完成闭环）
- **多步 GUI 流程** → **A2A 委派**（有进度流与逐步 artifact）

## 能力清单

| 能力 ID | 风险 | 说明 |
|---|---|---|
| `gui.session.status` | L0 | 会话健康检查（SessionId/窗口站/桌面/锁屏/黑屏） |
| `gui.screen.capture` | L0 | 截图：`asBase64:true`（默认）回 base64 PNG；`asBase64:false` 落盘并回路径 |
| `gui.screen.analyze` | L0 | 黑屏检测（灰度方差） |
| `gui.window.list` | L0 | 枚举有主窗口的进程 |
| `gui.window.control` | L1 | 最小化/最大化/还原/关闭/激活 |
| `gui.input.keyboard` | L1 | 文本（Unicode）或组合键 |
| `gui.input.mouse` | L1 | 移动/点击/双击/右键/滚轮/拖拽 |
| `gui.uia.tree` | L0 | UIA 元素树 |
| `gui.uia.invoke` | L1 | 按 AutomationId/Name/ControlType 点击/设值/切换 |
| `gui.clipboard.manage` | L1 | 剪贴板文本**读写**（带 `text` ⇒ 写入；不带 ⇒ 读取。M6 起写侧已挂载） |
| `gui.wait.condition` | L0 | 等窗口出现/消失/进程退出/屏幕稳定 |

## 标准流程：观察—决策—操作 循环

```
1. gui.screen.capture  { asBase64: true }        # 看现状
2. 判读截图 → 决定下一步
3. gui.uia.tree 或 window.list                    # 优先 UIA，其次坐标
4. gui.uia.invoke / gui.input.mouse               # 操作
5. gui.wait.condition { condition: "screenStable" }   # 等界面稳定
6. gui.screen.capture                             # 验证结果
7. 未达预期 → 回到 1，但要**限制重试次数**（建议 ≤5 次）并逐步报告
```

**关键**：每一步的截图都回传给你（作为 artifact）。**先看图再决定下一步**，
不要盲发点击序列。

### `gui.screen.capture` 的两种形态

| 形态 | 入参 | 出参 | 何时用 |
|---|---|---|---|
| **base64 回传**（默认） | `asBase64: true`（或省略） | `{ width, height, bytes, base64 }` | 需要**立刻看图判读**（观察—决策循环） |
| **落盘 + 路径** | `asBase64: false` | `{ width, height, bytes, path, savedTo }` | 需要**留档 / 多处引用 / 大图**；图落盘到产物目录（`%USERPROFILE%\WinVMWorkspace\out\screen_<时间戳>.png`），返回 `path`（等价 `savedTo`） |

> 区域/窗口截图用 `x`/`y`/`width`/`height` 或 `windowTitle` 指定范围。
> 若用的是 **LLM VM Agent（A2A）** 且只拿到 `{width,height,bytes}` 而没有图 —— 说明调的是
> 旧版能力，升级后 `asBase64:false` 会同时回**落盘路径**，不再"只报尺寸不给图"。

## 定位策略：UIA 优先于坐标

| 方式 | 何时用 | 稳定性 |
|---|---|---|
| **UIA**（`gui.uia.invoke` 按 `AutomationId`） | 首选 | 高 —— 不随分辨率/主题变化 |
| UIA 按 `Name` | 无 AutomationId 时 | 中 —— 受多语言影响 |
| **坐标**（`gui.input.mouse`） | 自定义绘制、游戏、无 UIA 的界面 | 低 —— 分辨率/缩放一变就失效 |

**先 `gui.uia.tree` 拿到元素树，再按 ID 定位**；坐标点击是最后手段。

## 浏览器操作（当前：UIA + 键鼠；CDP 直驱为 V2 规划）

> ⚠ **`gui.browser.control`（CDP 直驱）当前未注册、不可调用**（V2 规划·当前不可用），
> 不要向用户承诺"浏览器自动化/取 DOM/精确选择器"类 CDP 能力。

当前网页操作一律用**已注册能力组合**完成：

```
1. app.process.launch { target: "<url>" }              # 打开浏览器/导航
2. gui.uia.tree { windowTitle: "…" }                   # 页面 DOM 经 UIA 暴露，优先元素定位
3. gui.uia.invoke / gui.input.keyboard / gui.input.mouse  # 点击/填表/滚动
4. gui.wait.condition { condition: "screenStable" }    # 等页面稳定
5. gui.screen.capture                                  # 看图判读 / 结果存档
```

- **优先 UIA 定位，其次坐标**（与桌面应用同一策略，见上节）
- 多步登录/填表流程可封装为 `appops.gui.produce` 步骤序列（A2A 委派，带进度与 artifact）
- 验证码、"看屏决策"类环节按观察—决策循环逐步处理，重试 ≤5 次并逐步报告

## 高危清单

> 审批卡片：统一模板见 [`../winvm-orchestrator/approval-card.md`](../winvm-orchestrator/approval-card.md)（§审批卡片模板 · 唯一正文；本文件不复制正文）

| 操作 | 风险 | 强制动作 |
|---|---|---|
| `gui.window.control { state: "close" }` | L1（可能丢失未保存工作） | **先确认窗口内容**；关闭前截图，提示用户可能有未保存数据 |
| 在登录/支付/权限弹窗中输入 | L1（凭据风险） | **必须先取得用户明确许可**；输入的凭据经脱敏后入审计 |
| `gui.clipboard.manage` 读取 | L1 | 剪贴板是共享资源，可能含敏感数据；读出内容入日志前须脱敏，不向无关方转呈 |

**风险上限与跨域升级**：本域能力**最高 L1**，故 GUI 自身**不产生 L2/L3 审批卡片**。但**经 A2A 委派的多步 GUI 任务可能命中跨域 L2 步骤**（如 `appops.gui.produce` 导出并覆盖写盘），此时按模板出卡片、走审批闸。

> 示例（跨域 L2 步骤「导出并覆盖源文件」命中审批闸时的卡片要点；卡片首行等填充格式以模板为准，本文件不复制模板正文）：
>
> - 操作：`appops.gui.produce`（导出并覆盖源文件）
> - 目标：`C:\WinVMWorkspace\in\poster.psd`（原地覆盖）
> - 通道：A2A 委派 · `task_xxx`
> - 风险：L2 — 破坏性
> - 影响清单：1 项 —— 覆盖写入 `C:\WinVMWorkspace\in\poster.psd`，原内容被替换
> - 可逆性：不可逆 —— 原地覆盖，原内容不可自动回滚
> - dry-run 预览：将覆盖导出 1 个文件；**建议改输出到 `out/` 以避免覆盖**（产物与源分离）
> - 审批 ID + 续跑：见模板（A2A 用 `a2a.approval.reply`）

## 入参契约错误处理（`INVALID_PARAMS` / `INVALID_ARGUMENT`）

调用本域工具若返回 `error.code == "INVALID_PARAMS"` 且 `error.reason == "INVALID_ARGUMENT"`，
说明**入参不符合能力契约**（参数名写错 / 漏传必填 / 取值非法），由 VM 服务在发起 PowerShell **之前**拦截，
**不产生桥往返**（毫秒级返回）。

- **不重试**（`retryable=false`）：参数不变，重试必然再次失败。
- **看 `error.details`**：`missing`（缺失的必填）、`unknown`（不支持的参数名）、`allowed`（该能力可用参数）、
  `invalid`（已提供但取值非法的键，含 `expected`/`got`）；
  按 `error.message` 中的「该能力可用参数：…」改正参数后**再调用**。
- **先查 `inputSchema`**：`tools/list` 中该工具的 `inputSchema.required`（必填）与
  `inputSchema.properties`（可用参数）即**权威契约**，调用前先比对可避免此类错误。
- GUI 域注意：`gui.window.control` 的窗口参数是 **`title`**（不是 `windowTitle`）；
  `gui.uia.tree` / `gui.uia.invoke` 才用 `windowTitle`。命名相近，最易踩此错误。

## 已知陷阱

- **黑屏 ≠ 成功**：本系统会检出黑屏并报错。若你拿到一张纯黑截图，
  说明是会话问题，**不是界面本来就是黑的**
- **DPI 缩放**：高 DPI 下坐标与截图尺寸可能不一致；用 UIA 规避
- **Unicode 文本输入**：`gui.input.keyboard` 的 `text` 走
  `KEYEVENTF_UNICODE`，中文可直接输入，无需切输入法
- **组合键写法**：`keys: ["ctrl", "s"]` 表示按下并释放 Ctrl+S
  （支持 enter/tab/esc/space/backspace/delete/方向键/home/end/f1-f5/win 等）
- **等待优于硬 sleep**：用 `gui.wait.condition` 代替固定延时，
  界面响应慢时尤其重要
- **拖拽**：用 `action: "drag"` 并给 `toX/toY`，不要拆成 move+click
- **剪贴板读写（M6 已挂载）**：`gui.clipboard.manage` **带 `text` 参数 ⇒ 写入**（空串=清空剪贴板），
  不带 ⇒ 读取当前文本。需 GUI 交互式会话（requiresSession）。读出内容含敏感数据时入日志前须脱敏；
  写入成功回执含 `length`，**失败或未经本能力不得向用户宣称"已写入剪贴板"**

## 参考

- 会话保活与降级矩阵：`docs/02-design/SECURITY-GOVERNANCE.md` §5
- 能力定义：`docs/02-design/CAPABILITY-MODEL.md` §3.4
- 接口契约：`docs/02-design/INTERFACES.md` §2
- 错误码：`SESSION_UNAVAILABLE` / `SESSION_BLACK_SCREEN`（`retryable=true`，但**恢复会话无可调用动作**——插件未实现自动恢复、54 能力与会话面无 restore/unlock 类工具；判据用 `meta.session.status` 或 `winvm-plugin health` 确认会话态，恢复本身**只能人工**（用户在 VM 控制台解锁/重连 RDP/按上表 tscon 手工配方），Agent 的正确动作 = **告知用户并等待**，不要反复重试，不要宣称"已恢复会话"）

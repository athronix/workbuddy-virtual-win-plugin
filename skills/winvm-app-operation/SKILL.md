---
id: winvm-app-operation
name: Windows 应用生产操作
description: >
  操作 Windows 虚拟机内的桌面软件进行**生产活动**：用 Photoshop/美图类工具做图像处理、
  用 Office/WPS 生成文档报表、用浏览器完成网页端生产、用 ffmpeg/ImageMagick 做音视频与
  图像批处理、用 IDE 跑构建与脚本。当用户要"在 VM 里用某个软件把活干出来"（而非仅仅
  安装/启动应用）时，优先加载本 Skill。本 Skill 承载**应用专属的生产知识**，具体执行走
  MCP 工具或 A2A 委派。
version: 0.1.0
domains: [appops]
entry: false
triggers:
  - 用 Photoshop / 美图 / 画图 处理图片
  - 用 Word / Excel / PPT / WPS 生成或转换文档
  - 用浏览器在网页里完成操作（登录、填表、下载、截图）
  - 用 ffmpeg / ImageMagick 转码、裁剪、批量处理
  - 用 IDE（VS / Cursor / PyCharm）跑命令、构建、运行脚本
  - 把这张照片的背景换成海洋 / 给这张图加水印 / 把这段视频转成 gif
relatedSkills:
  - winvm-orchestrator
  - winvm-gui-automation
  - winvm-storage-manager
  - winvm-app-manager
riskProfile:
  min: L0
  max: L2
---

# Windows 应用生产操作（winvm-app-operation）

> **前置（隧道在线健康）**：任何工具调用前先确保隧道在线健康 ——
> 运行 `~/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0/winvm-plugin tunnel ensure`（幂等；不健康自动重启）→ 再 `… health` 需 `ok:true`（**部署态命令，任意 cwd 可用**）。
> 详见 [`winvm-orchestrator`](../winvm-orchestrator/SKILL.md) §前置检查：tunnel 在线健康。

你负责在 Windows 虚拟机里**操作桌面软件把生产任务完成**。你不是"应用管理员"
（那归 `winvm-app-manager`，只管安装/卸载/启动），你是"生产工"——用软件把素材变成产物。

本 Skill 与 `winvm-gui-automation` 的关系：GUI 自动化是**通用原语**（点击、键鼠、UIA、
截图），本 Skill 是**应用专属知识**（Photoshop 的"滤镜→选择→内容识别填充"、Excel 的
"数据→透视表"、浏览器的"登录→导航→填表"）。两者配合：本 Skill 给出"点哪里、点什么"，
GUI 原语负责"真的点下去"。

## 适用与不适用

**适用**：任何需要在 VM 内用某个桌面软件产出文件/成果的任务。典型：
- 图像处理：换背景、去水印、加水印、批量压缩、格式转换
- 文档生产：从模板生成 Word/PDF、Excel 报表、PPT 排版、Markdown→DOCX
- 网页生产：登录后台、批量下载、表单提交、网页截图存档
- 音视频：ffmpeg 转码/裁剪/合并、ImageMagick 批处理
- 研发生产：IDE 内构建、跑测试、执行脚本

**不适用 / 必须升级**：
- 任务极度开放、无法预先给出步骤序列（"帮我随便把这图弄好看点"）→ 改走 **A2A 委派 + LLM VM Agent**（见下"开放任务"），让 VM 内 AI Agent 自主规划。
- 要求关闭审批闸、绕过路径白名单 → 拒绝。
- 要求把 VM 服务暴露公网 → 拒绝。

## 前置检查

1. **隧道 + 健康**：同 `winvm-orchestrator` 前置检查（隧道存活、`meta.health.check` 通过）。
2. **会话状态**：凡涉及 GUI 应用（Photoshop、Office、浏览器、IDE），必须确认
   `gui.session.status` 的 `state == healthy` 且非锁屏、非黑屏。无头/黑屏下 GUI 操作必败。
3. **应用就绪**：`appops.state.query` 或 `app.inventory.list` 确认目标应用已安装；未安装先转
   `winvm-app-manager`（winget 安装），不要硬跑。
4. **工作区就绪**：生产产物默认落在 `C:\WinVMWorkspace\out`（或
   `%USERPROFILE%\WinVMWorkspace\out`）。首任务前用 `storage.dir.manage` 建好目录，并确认
   输入素材已传到 VM（用 `winvm-storage-manager` 传文件或 VM 内下载）。

## 通道选择

```
任务是否可预先分解为确定步骤（点哪里、调什么 CLI）？
├─ 是 → MCP 直调（appops.* / gui.* / storage.* 逐步执行，透明可复现）
│       例：ffmpeg 转码、soffice 转 PDF、已知步骤的批量处理
└─ 否（开放/需看屏幕反复判断）→ A2A 委派（VM Agent 自主规划，
         artifact 回传截图与产物；若是 LLM provider 还能理解自然语言目标）
```

| 场景 | 通道 | 关键能力 |
|---|---|---|
| "用 ffmpeg 把 A.mp4 转成 720p 的 B.mp4" | MCP | `appops.cli.invoke`(ffmpeg) |
| "把这张照片的大山背景换成海洋" | A2A（开放/需常识）| LLM VM Agent 规划 + `appops.*` |
| "用 Excel 打开 数据.xlsx，按 部门 做透视表并存 PDF" | MCP | `appops.com.automate`(Excel) 或 `workflow.run` |
| "登录后台，把 1~50 页报表逐页截图" | A2A | `winvm-gui-automation` + `appops.gui.produce` |
| "用 ImageMagick 给 100 张图加水印" | MCP | `appops.workflow.run`(批处理脚本) |

## 标准流程（确定性生产任务）

1. 前置检查（隧道/健康/会话/应用/工作区）
2. 把自然语言目标翻译成**可执行步骤**（本 Skill 的"应用知识库"给出映射）
3. 若步骤固定且可用 CLI/API：优先 `appops.cli.invoke` 或预置 `appops.workflow.run`
4. 若必须 GUI：用 `appops.gui.produce` 提交步骤序列，或 MCP 逐步调 `gui.*`
5. 每步后 `gui.screen.capture` 截图核对（强 GUI 任务必做，破除黑盒）
6. 产物落 `out/` 目录，回传路径/截图作为 artifact
7. 高风险（L2）步骤先走审批闸

## 应用知识库（核心）

> 以下给出**代表性**生产配方。更多应用按需扩充——这就是本 Skill 存在的意义：
> 它把"某个软件怎么用"沉淀为可复用的生产步骤。

### Photoshop / 图像类（换背景、去水印、批处理）

- **换背景（开放意图）**：需语义理解（识别山、生成海洋），确定性工具无法一步完成。
  路径：A2A 委派给 **LLM VM Agent**，由它在 VM 内调用 Photoshop（UXP/COM 脚本或
  `appops.com.automate`）或本地扩散模型完成；或宿主先把任务拆成"抠图→合成"等可枚举步骤再 MCP 执行。
- **批量加水印/压缩（确定意图）**：优先 `appops.cli.invoke`(magick)：
  `magick in.png -gravity SouthEast -annotate +10+10 "© VM" out.png`
  或 `appops.workflow.run` 跑一个 ImageMagick 批处理脚本。
- **已知步骤的修图**：`appops.gui.produce` 提交步骤序列（打开→滤镜→导出）。

### Office / WPS（文档报表生产）

- **Word→PDF / 报表生成**：`appops.com.automate`(progId `Word.Application`) 脚本块：
  打开 docx → 替换书签/占位符 → `ExportAsFixedFormat` 存 PDF。
- **Excel 透视表/报表**：`appops.com.automate`(progId `Excel.Application`) 或预置
  `appops.workflow.run`（PowerShell 调 ImportExcel / 直接 COM）。
- **Markdown/DOCX 互转**：`appops.cli.invoke`(pandoc)：
  `pandoc report.md -o report.docx`。

### 浏览器（网页端生产）

- 优先 `gui.browser.control`（CDP）做导航/点击/填表/取 DOM；
- 登录态、验证码等需"看屏幕决策"的，用 `appops.gui.produce` + 周期性 `gui.screen.capture`；
- 结果页 `gui.screen.capture` 截图存档（落 `out/`）。

### 音视频（ffmpeg / ImageMagick）

- 转码：`appops.cli.invoke`(ffmpeg) `ffmpeg -i in.mp4 -vf scale=1280:720 out.mp4`
- 视频→GIF：`ffmpeg -i in.mp4 -vf "fps=10,scale=480:-1" out.gif`
- 批量：写成 `appops.workflow.run` 脚本（遍历 `in/` → 处理 → 写 `out/`）。

### IDE / 研发生产

- 构建/测试：优先 `appops.cli.invoke`(node/python) 或 `appops.workflow.run`；
- 需要 GUI 的（如打开 IDE 跑某菜单）：`appops.gui.produce`。

## 开放任务与 LLM VM Agent（重要）

V1 默认 VM Agent 是**确定性执行器**（`adapter-agent-workbuddy`，`kind: deterministic`），
它只认**预置工作流**和**模板化目标**，对"用 Photoshop 把大山换成海洋"这类开放任务会返回
`UNSUPPORTED_GOAL`。要让 VM 真正具备"理解开放意图、自主操作任意 Windows 应用"的能力，需要：

1. 在 VM 内署一个 **LLM Agent provider**（如把 VM 内的 WorkBuddy `codebuddy` CLI 作为
   `agent.provider=workbuddy-llm` 接入，SPI 已支持，改一行配置即可，框架零改动）；
2. 通过 **A2A 委派**把自然语言目标发给该 VM Agent，由它自主规划并调用本 Skill 承载的
   应用知识 + `appops.*` / `gui.*` 工具分步完成，回传截图与产物。

> 简言之：**确定性 V1 解决"已知步骤的生产"；开放/创意类生产靠升级到 LLM VM Agent。**
> 两者共用同一套 `appops` 能力与 Skill，只是"谁来规划步骤"不同。

## 工具契约与降级语义（重要）

### `appops.cli.invoke` 参数契约

| 参数 | 必填 | 说明 |
|---|---|---|
| `app` | 是 | 选择可执行文件：`ffmpeg` / `magick` / `soffice` / `pandoc` / `node` / `python` / `custom`（决定用哪个 exe 与套用哪套安全校验） |
| `command` | 是 | **完整命令行**。可含可执行名——含时自动**剥离前缀**再与 `arguments` 拼接 |
| `arguments` | 否 | 与 `command` 拼接的附加参数（多用于「app=exe + arguments」写法） |
| `workingDirectory` | 否 | 子进程工作目录 |
| `outputDirectory` | 否 | 输出目录（受策略白名单约束，见下） |

> ⚠ **不要只填 `app` 而不给 `command`**：那会以**零参数**启动（`node.exe`/`python.exe` 会进入 REPL）
> 并挂起整条 ps-bridge —— 该用法会被拦截并返回 `INVALID_ARGUMENT`。
> 子进程已强制：stdin 立即关闭（不吃桥的管道）、独立超时（默认 120s，超限 **kill 进程树**并返回 `TIMEOUT`）。

### 产物目录（统一）

**所有 `appops` 产物一律写 `C:\WinVMWorkspace\out`**（或用 `%USERPROFILE%\WinVMWorkspace\out`，二者都在白名单内）。
`appops.cli.invoke` 的输出目录白名单即 `C:\WinVMWorkspace\out`、`%USERPROFILE%\WinVMWorkspace\out`；越界会被策略拒绝。

### LLM 委派降级语义

经 A2A 委派时，若 VM 内 **LLM 运行时不可用**（未安装 / **未登录** / 非零退出且无产物），
provider 会**降级为确定性执行器**继续尝试完成目标，并在 `summary` 中**明确标注「已降级为确定性执行」**
——**不等于**「LLM 已完成」。看到该标注时：

- 目标可由预置工作流/模板覆盖 → 任务仍会完成，按 `steps` 与产物核对即可；
- 确定性执行器也无模板（返回 `UNSUPPORTED_GOAL`）→ 才是**真正失败**，需登录/安装 LLM 运行时，或改走 MCP 直调。
- 另有「桥自愈」场景：若报 `PROVIDER_UNAVAILABLE`，桥会**自动重建** ps-bridge，可**有界退避重试**（至多 1–2 次）。

## 高危清单（L2/L3，强制动作）

> 审批卡片：统一模板见 [`../winvm-orchestrator/approval-card.md`](../winvm-orchestrator/approval-card.md)（§审批卡片模板 · 唯一正文；本文件不复制正文）

| 风险 | 典型操作 | 强制动作 |
|---|---|---|
| L2 | `appops.gui.produce`（会改文件/导出覆盖）、`com.automate` 写盘 | 审批 + before/after 快照 + 产物先落 `out/` 不覆盖源 |
| L2 | 批量覆盖源文件（如 ImageMagick 原地处理） | 审批 + 强制输出到独立 `out/` 目录 |
| L3 | 不在本域范围（格式化/系统级） | 本系统不提供，需人工在 VM 内执行 |

额外约定：
- **产物与源分离**：所有 `appops` 产出写入 `out/`，绝不原地覆盖输入，便于回溯与审计。
- **删除默认进回收站**：清理中间产物用 `storage.file.delete`（回收站优先），不永久删。
- **路径白名单**：`appops.cli.invoke` / `workflow.run` 的输出目录受 `pathAllowlist`
  约束（`C:\WinVMWorkspace`、`%USERPROFILE%\WinVMWorkspace`），越界会被策略拒绝。

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
- 本域高频：`appops.cli.invoke` 必填 **`app` 与 `command`**；`appops.workflow.run` 必填 **`workflow`**。

## 已知陷阱

- **把"应用管理"当"应用生产"**：安装/启动是 `winvm-app-manager`；真正"用软件干活"才是本 Skill。
- **无头环境跑 GUI 应用**：Session 0 / 锁屏下 Photoshop/Office 起得来但截图黑屏、SendInput
  被拒——务必先确认 `gui.session.status == healthy`。
- **开放任务硬塞确定性模板**：会返回 `UNSUPPORTED_GOAL`；应改走 LLM VM Agent（A2A）。
- **产物路径越白名单**：`appops.*` 输出目录受限，写到 `C:\Windows` 等会被拒。
- **COM 对象未释放**：`appops.com.automate` 已做 Quit + ReleaseComObject + GC，调用方不要在脚本里
  长时间持有 COM 不退出。

## 参考

- 能力清单：`docs/02-design/CAPABILITY-MODEL.md` §3.5 `appops`
- 总控与安全：`skills/winvm-orchestrator/SKILL.md`、`docs/02-design/SECURITY-GOVERNANCE.md`
- GUI 原语：`skills/winvm-gui-automation/SKILL.md`
- 开放任务/LLM Agent：`docs/02-design/SPEC-AGENT-SERVICE-BRIDGE.md` §开放任务

---
id: winvm-app-manager
name: Windows 应用管理
description: >
  在 Windows 虚拟机内管理应用：查询已装清单、用 winget 搜索/安装/卸载/升级、
  启动应用（激活窗口经 gui.window.control）、读取快捷方式与 UWP 包。
  用于"装个软件""卸载某某""升级全部应用"等。默认程序设置当前不可用（V2 规划）。
version: 0.1.0
domains: [app]
triggers:
  - 虚拟机安装软件
  - 虚拟机应用
  - 虚拟机卸载
relatedSkills:
  - winvm-orchestrator
---

# Windows 应用管理

> **前置（隧道在线健康）**：任何工具调用前先确保隧道在线健康 ——
> 运行 `~/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0/winvm-plugin tunnel ensure`（幂等；不健康自动重启）→ 再 `… health` 需 `ok:true`（**部署态命令，任意 cwd 可用**）。
> 详见 [`winvm-orchestrator`](../winvm-orchestrator/SKILL.md) §前置检查：tunnel 在线健康。

## 适用与不适用

**适用**：包管理器（winget）可覆盖的安装/卸载/升级，以及应用启动、快捷方式**读取**、UWP 包查询。

**不适用 / 需人工**：
- 需要交互式安装向导的应用（改用 `gui.*` 能力驱动安装器，或走 A2A 委派）
- 需要图形激活的序列号输入（A2A + GUI）
- Microsoft Store 付费应用的购买环节
- **默认程序/文件类型关联**（原设想 `app.default.manage`）→ 能力**当前未注册、不可调用**（V2 规划），需人工在 VM 内"设置→默认应用"操作
- **快捷方式创建/删除** → 当前 `app.shortcut.manage` **只读**（创建函数 `New-ShortcutItem` 已实现待挂载），不要承诺"已创建快捷方式"
- **激活已运行窗口** → 本域无 `app.process.activate`（未注册）；用已注册能力 **`gui.window.control { state: "activate" }`**（见 `winvm-gui-automation`）

## 前置检查

按 `winvm-orchestrator` §前置检查 执行（隧道 / 健康）。
安装类操作**建议**先确认磁盘余量（见 `winvm-storage-manager`）。

## 通道选择

- **精确安装**（已知包名）→ **MCP 直调**：`search → install → 验证`
- **模糊诉求**（"装个能看 PDF 的"）→ **A2A 委派**：需搜索、比对、决策
- **交互式安装** → **A2A 委派**（配合 `gui.*`）

## 能力清单

| 能力 ID | 风险 | 说明 |
|---|---|---|
| `app.inventory.list` | L0 | 已装应用清单（可选含 UWP） |
| `app.winget.search` | L0 | 搜索可安装包 |
| `app.winget.install` | L1 | 安装包（无人值守） |
| `app.winget.uninstall` | L2 | 卸载包（**需审批**） |
| `app.winget.upgrade` | L1 | 升级指定包或全部 |
| `app.process.launch` | L1 | 启动应用/打开文件/打开 URL |
| `app.shortcut.manage` | L1 | **只读** .lnk（返回 targetPath/arguments/workingDirectory；创建函数已实现待挂载，当前不可用） |
| `app.appx.manage` | L0 | 列出 UWP 包（安装/移除当前不可用；移除可试 `app.winget.uninstall`） |

## 标准流程

### 安装应用（推荐顺序）

```
1. app.winget.search  { query: "<关键词>", limit: 10 }     # L0
2. 向用户确认确切的包 ID（不要替用户猜）
3. app.winget.install { id: "<确切ID>" }                   # L1
4. app.inventory.list { name: "<应用名>" }                 # L0 验证
```

要点：winget 输出的是**表格文本**，现已按 `----` 分隔线做**定宽列解析**（跳过表头/汇总行）。
但列宽可能随版本变化，若搜索结果拿不到确切 ID，改为让用户提供，或加 `dryRun: true` 先预览。

### 卸载应用

```
1. app.inventory.list { name: "<应用名>" }        # 确认已装与版本
2. 展示影响 → 取得审批（L2）
3. app.winget.uninstall { id: "<确切ID>" }
4. app.inventory.list   { name: "<应用名>" }      # 验证已移除
```

### 升级

- 单个：`app.winget.upgrade { id: "<包ID>" }`
- 全部：`app.winget.upgrade { all: true }`（**建议先 `app.winget.upgrade` 不带参数预览**，
  或明确告知用户将升级全部可升级包）

### 读取快捷方式（当前只读）

```
# 读取：返回 targetPath / arguments / workingDirectory
app.shortcut.manage { path: "C:\\Users\\<user>\\Desktop\\MyApp.lnk" }
```

> **契约**：`path` 必填，是 `.lnk` 文件的读取路径。
> ⚠ **创建/覆盖快捷方式当前不可用**：入参 `targetPath`/`arguments`/`workingDirectory`
> 虽在 schema 中保留，但传入**不会产生写入**，回执仍只返回读取结果
> （写侧 `New-ShortcutItem` 已实现待挂载）。用户要求"建快捷方式"时如实说明现状。
> 如需代用路径：`appops.cli.invoke` 的 `app` 枚举**无 powershell**（直传恒 `INVALID_PARAMS`；合法值
> ffmpeg/magick/soffice/pandoc/node/python/custom），可行形态为 **`{ app: "custom", command: "powershell -NoProfile -Command \"<WScript.Shell 建 .lnk 脚本>\"" }`**
> （写入目标仍受路径白名单约束，`%USERPROFILE%` 下桌面可写；L1 免审批）；或人工创建——**不要静默声称成功**。

## 高危清单（L2 强制动作）

> 审批卡片：统一模板见 [`../winvm-orchestrator/approval-card.md`](../winvm-orchestrator/approval-card.md)（§审批卡片模板 · 唯一正文；本文件不复制正文）

| 操作 | 风险 | 强制动作 |
|---|---|---|
| `app.winget.uninstall` | L2 | 展示应用名+版本+影响范围 → 审批 → 执行 → 验证；回执 `success=false` 时必须如实转呈 `residualEvidence` 与 `verified`，不得改写为成功（详见 `docs/02-design/CAPABILITY-MODEL.md` §3.2.1） |
| 批量 `upgrade --all` | L1（影响面大） | 先列出可升级包清单，取得用户确认 |

> 上表「应用名 + 版本 + 影响范围」即模板的 **操作**、**目标**、**影响清单** 槽位；卡片格式与填充规则以模板为准（引用见本节开头），本文件不复制正文。

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

## 已知陷阱

- **winget 搜索结果**：已按 `----` 分隔线做**定宽列解析**，跳过表头行与汇总行 ——
  不再出现「把表头当数据、列错位」（如 `id: "Version"`、`name: "Name  Id"`）的乱码。
  但列宽仍可能随 winget 版本/本地化变化 —— **仍建议让用户确认确切 ID**，或先用 `dryRun: true` 预览安装计划
- **必须加无人值守参数**：本系统已内置
  `--accept-package-agreements --accept-source-agreements --disable-interactivity`，
  任何交互式提示都会导致**超时**而非失败 —— 表现为"卡住"
- **安装耗时可能很长**：`app.winget.install` 超时上限 600s；
  大型软件（VS、Office）建议走 **A2A 委派**以获得进度回传
- **作用域**：winget 默认当前用户；部分包需管理员权限，会失败并给出提示
- **卸载残留**：winget 卸载不清理用户配置目录。
  若用户要求"彻底清理"，需结合 `storage.*` 能力**逐项审批**删除，禁止批量推断
- **UWP 包**：`app.appx.manage` 仅查询；移除 UWP 走 `app.winget.uninstall`

## 参考

- 能力定义：`docs/02-design/CAPABILITY-MODEL.md` §3.2
- 接口契约：`docs/02-design/INTERFACES.md` §2
- 安全设计：`docs/02-design/SECURITY-GOVERNANCE.md`

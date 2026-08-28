---
id: winvm-app-manager
name: Windows 应用管理
description: >
  在 Windows 虚拟机内管理应用：查询已装清单、用 winget 搜索/安装/卸载/升级、
  启动与激活应用、管理快捷方式与 UWP 包。用于"装个软件""卸载某某""升级全部应用"等。
version: 0.1.0
domains: [app]
triggers:
  - 安装/卸载/升级软件
  - 查看已安装的软件
  - 启动某个应用
  - 创建桌面快捷方式
relatedSkills:
  - winvm-orchestrator
---

# Windows 应用管理

## 适用与不适用

**适用**：包管理器（winget）可覆盖的安装/卸载/升级，以及应用启动、快捷方式、UWP 包查询。

**不适用 / 需人工**：
- 需要交互式安装向导的应用（改用 `gui.*` 能力驱动安装器，或走 A2A 委派）
- 需要图形激活的序列号输入（A2A + GUI）
- Microsoft Store 付费应用的购买环节

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
| `app.shortcut.manage` | L1 | 读取或创建 .lnk |
| `app.appx.manage` | L0 | 列出 UWP 包 |

## 标准流程

### 安装应用（推荐顺序）

```
1. app.winget.search  { query: "<关键词>", limit: 10 }     # L0
2. 向用户确认确切的包 ID（不要替用户猜）
3. app.winget.install { id: "<确切ID>" }                   # L1
4. app.inventory.list { name: "<应用名>" }                 # L0 验证
```

要点：winget 输出的是**表格文本**，解析可能不精确。
若搜索结果拿不到确切 ID，改为让用户提供，或加 `--dry-run` 先预览。

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

## 高危清单（L2 强制动作）

| 操作 | 风险 | 强制动作 |
|---|---|---|
| `app.winget.uninstall` | L2 | 展示应用名+版本+影响范围 → 审批 → 执行 → 验证 |
| 批量 `upgrade --all` | L1（影响面大） | 先列出可升级包清单，取得用户确认 |

## 已知陷阱

- **winget 输出解析不精确**：表格列宽不定，解析出的 ID 可能有误。
  优先让用户确认确切 ID；无法确认时用 `dryRun: true` 预览
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

# 统一能力模型规范（CAPABILITY-MODEL）

| 项 | 值 |
|---|---|
| 文档 ID | CAPABILITY-MODEL-winvm-bridge-v1 |
| 版本 | v1.1（R17-T01：`app.winget.uninstall` 回执语义增补 §3.2.1） |
| 层 | L0 规范层（`packages/contracts`） |
| 日期 | 2026-08-28 |

---

## 1. 定位

能力模型是**全系统的最小语义单元**：MCP 工具、A2A Skill、VM 侧 PowerShell 实现、策略引擎规则，**全部围绕同一份能力定义展开**。

> 这是 FR-103「两通道共享同一套能力注册表与策略引擎」的落地基础。

---

## 2. 能力标识（CapabilityId）

格式：`<domain>.<group>.<action>`

| 段 | 取值 | 说明 |
|---|---|---|
| `domain` | `system` \| `app` \| `storage` \| `gui` \| `appops` \| `meta` | 五大能力域 + 元能力 |
| `group` | 见 §3 | 域内分组 |
| `action` | 动词或名词短语 | 具体动作 |

示例：`system.service.start`、`app.winget.install`、`storage.disk.analyze`、`gui.screen.capture`、`appops.workflow.run`、`meta.health.check`

> `app`（应用**管理**：安装/卸载/启动）与 `appops`（应用**生产操作**：用软件把活干出来）是两个不同域，请勿混淆。

---

## 3. 能力域清单

### 3.1 `system` —— 系统管理（FR-201）

| 能力 ID | 说明 | 风险 | PowerShell 依托 |
|---|---|---|---|
| `system.info.get` | 操作系统/版本/内存/CPU/域/启动时间 | L0 | `Get-CimInstance Win32_OperatingSystem` |
| `system.service.list` | 服务清单与状态 | L0 | `Get-Service` |
| `system.service.control` | 启动/停止/重启服务 | L1 | `Start/Stop/Restart-Service` |
| `system.service.configure` | 改启动类型/恢复策略 | L2 | `Set-Service` / `sc.exe config` |
| `system.process.list` | 进程清单（CPU/内存/命令行） | L0 | `Get-CimInstance Win32_Process` |
| `system.process.terminate` | 结束进程（含进程树） | L2 | `Stop-Process` / `taskkill /T` |
| `system.task.scheduled` | 计划任务增删改查 | L2 | `*-ScheduledTask` |
| `system.registry.read` | 读注册表 | L0 | `Get-ItemProperty` |
| `system.registry.write` | 写注册表（受限根键白名单） | L2 | `Set-ItemProperty` |
| `system.network.config` | 网卡/IP/DNS/路由查看与配置 | L2 | `Get/Set-NetIPAddress` 等 |
| `system.user.manage` | 本地用户与组 | L2 | `*-LocalUser` / `*-LocalGroup*` |
| `system.env.manage` | 环境变量读写 | L1 | `[Environment]::SetEnvironmentVariable` |
| `system.eventlog.query` | 事件日志查询 | L0 | `Get-WinEvent` |
| `system.power.control` | 关机/重启/休眠 | **L3** | `Stop-Computer` / `Restart-Computer` |
| `system.update.manage` | Windows 更新查看与安装 | L2 | `PSWindowsUpdate` / UsoClient |

### 3.2 `app` —— 应用管理（FR-202）

| 能力 ID | 说明 | 风险 | 依托 |
|---|---|---|---|
| `app.inventory.list` | 已安装应用清单（含 UWP/Store） | L0 | 注册表卸载键 + `Get-AppxPackage` |
| `app.winget.search` | 搜索可安装包 | L0 | `winget search` |
| `app.winget.install` | 安装应用 | L1 | `winget install --exact --id` |
| `app.winget.uninstall` | 卸载应用（**卸载后核验 + NSIS 静默回退**，回执语义见 §3.2.1） | L2 | `winget uninstall` + 事后磁盘/注册表核验 |
| `app.winget.upgrade` | 升级应用（可批量） | L1 | `winget upgrade` |
| `app.process.launch` | 启动应用/打开文件/打开 URL | L1 | `Start-Process` |
| `app.process.activate` | 激活已运行窗口 | L0 | `AppActivate` |
| `app.shortcut.manage` | 快捷方式增删改 | L1 | `WScript.Shell` COM |
| `app.default.manage` | 默认程序关联 | L2 | 注册表 UserChoice |
| `app.appx.manage` | UWP 包安装/移除 | L2 | `Add/Remove-AppxPackage` |

#### 3.2.1 `app.winget.uninstall` 回执语义（R17 / K6 契约）

> 背景：winget 对 NSIS 安装包可能**假成功**（exit 0 但磁盘/注册表无变化）。自 R17 起该能力的
> `success` **不再等价于 `exitCode === 0`**，而以卸载后核验为准。实现状态机见
> `docs/design/r17-design.md` §A1.3/§A5；契约字段以 `packages/vm-capabilities/src/registry/definitions.ts`
> 的 output schema 为唯一权威，判定规则基线见 `tests/unit/r3-uninstall-verify.test.js`。

回执结构：`{ id, dryRun, exitCode, success, verified, fallbackUsed, residualEvidence?, output }`

| 字段 | 语义 |
|---|---|
| `success` | **以最终核验为准**：`exitCode=0` 且（首次核验通过 **或** NSIS 回退后核验通过）才为 `true`。winget exit 0 但核验未过（且不可回退/回退后仍残留）→ `success=false` |
| `verified` | 事后核验证据对象：`{ exeGone:boolean, dirGone:boolean\|null, registryGone:boolean, installLocation?:string, installerType:'nsis'\|'msi'\|'other'\|'unknown' }`。核验目标派生：优先注册表 `InstallLocation`；缺失时按 `UninstallString` 去引号/参数取所在目录反推；仍派生不出 → `dirGone=null`（只做注册表核验，如实标注）。**不在 PS 内全盘扫描** |
| `fallbackUsed` | 是否触发 NSIS 静默回退（`Uninstall.exe /S`）。回退仅在卸载键判定为 NSIS 型（`UninstallString` 指向 `Uninstall.exe` 且无 `QuietUninstallString`）时触发；**MSI（`msiexec`）及其它类型永不回退** |
| `residualEvidence` | 核验失败（`success=false`）时的残留证据（残留 exe/目录/注册表键清单）。**宿主/调用方必须如实向用户转呈，不得改写为成功** |
| `exitCode` | 仅为 winget 原始退出码，保留供诊断，**不得**单独作为成功依据 |

特殊语义：
- **dryRun**：不核验、不回退，`verified=null` 且 `fallbackUsed=false`（免审批语义保持，`success` 退化为 `exitCode=0`）。
- **超时预算**：维持能力级 600s 总预算（严禁突破），内部软分配 winget ≤300s / NSIS 回退 ≤240s / 核验 ≤30s。
- **winget 非零退出**：不触发回退（`fallbackUsed=false`），`success=false`，`verified` 为核验前证据。

### 3.3 `storage` —— 存储管理（FR-203）

| 能力 ID | 说明 | 风险 | 依托 |
|---|---|---|---|
| `storage.disk.list` | 物理磁盘/分区/卷 | L0 | `Get-Disk` / `Get-Partition` / `Get-Volume` |
| `storage.space.analyze` | 目录体积分析（Top-N 大目录） | L0 | 递归 `EnumerateFileSystemInfos` |
| `storage.file.read` | 读文件（文本/Base64） | L0 | `Get-Content` |
| `storage.file.write` | 写文件 | L1 | `Set-Content` |
| `storage.file.delete` | 删除文件/目录（**进回收站优先**） | L2 | `Microsoft.VisualBasic.FileIO.FileSystem::DeleteFile` |
| `storage.file.move` | 移动/重命名 | L1 | `Move-Item` |
| `storage.file.copy` | 复制 | L1 | `Copy-Item` |
| `storage.dir.manage` | 创建/删除目录 | L2（删）/L1（建） | `New/Remove-Item` |
| `storage.search.query` | 文件名/内容搜索 | L0 | `Get-ChildItem -Recurse` / `Select-String` |
| `storage.archive.manage` | 压缩/解压 | L1 | `Compress/Expand-Archive` |
| `storage.link.manage` | 符号链接/硬链接/ junction | L2 | `New-Item -ItemType SymbolicLink` |
| `storage.recycle.manage` | 回收站查看与清空 | L2 | Shell API |
| `storage.cleanup.analyze` | 清理建议（**只分析不执行**） | L0 | 规则引擎 |

> **红线**：分区/格式化/卷删除（`storage.volume.destructive`）列为 **L3**，V1 **不注册为可用能力**，仅在文档中说明需人工在 VM 内执行。

### 3.4 `gui` —— 图形化与桌面自动化（FR-204）

| 能力 ID | 说明 | 风险 | 依托 |
|---|---|---|---|
| `gui.session.status` | 会话健康检查（SessionId/窗口站/桌面/是否锁屏） | L0 | `Get-Process -Name explorer` 等 + 自研探针 |
| `gui.screen.capture` | 截图（全屏/窗口/区域）+ Base64 回传 | L0 | `System.Drawing` + `CopyFromScreen` |
| `gui.screen.analyze` | 黑屏/纯色检测（熵判定） | L0 | 像素方差统计 |
| `gui.window.list` | 窗口枚举（标题/句柄/位置/进程） | L0 | `EnumWindows` P/Invoke |
| `gui.window.control` | 置顶/最小化/最大化/关闭/移动/改尺寸 | L1 | `SetWindowPos` / `ShowWindow` |
| `gui.input.keyboard` | 键盘输入（文本 / 组合键 / 虚拟键码） | L1 | `SendInput` P/Invoke |
| `gui.input.mouse` | 鼠标（移动/点击/双击/右键/拖拽/滚轮） | L1 | `SendInput` P/Invoke |
| `gui.uia.tree` | UIA 元素树（按窗口/按坐标命中） | L0 | `System.Windows.Automation` |
| `gui.uia.invoke` | 按 AutomationId/Name/ControlType 定位并点击/设值 | L1 | UIA Patterns（Invoke/Value/Toggle） |
| `gui.clipboard.manage` | 剪贴板读/写 | L1 | `System.Windows.Forms.Clipboard` |
| `gui.wait.condition` | 等待条件（窗口出现/图像稳定/进程退出/元素存在） | L0 | 轮询 + 超时 |
| `gui.browser.control` | 浏览器自动化（导航/点击/填表/截图/取 DOM） | L1 | CDP over WebSocket（Chrome/Edge DevTools Protocol） |

### 3.5 `appops` —— 应用生产操作（FR-205）

> 与 `app` 域区分：`app` 是"应用**管理**"（安装/卸载/启动/快捷方式），`appops` 是
> "应用**生产**"——操作桌面软件把素材变成产物。开放/创意类意图（如"用 Photoshop 把
> 大山背景换成海洋"）属于本域，但需要 **LLM VM Agent provider** 才能自主规划（见
> SPEC-AGENT-SERVICE-BRIDGE §开放任务）。确定性 V1 只调度预置工作流与已知 CLI。

| 能力 ID | 说明 | 风险 | 依托 |
|---|---|---|---|
| `appops.state.query` | 查应用生产上下文（运行应用/打开文档/活动窗口） | L0 | `Get-Process` + 窗口枚举 |
| `appops.cli.invoke` | 调应用自带 CLI（ffmpeg/magick/soffice/pandoc…） | L1 | `Start-Process` 调应用 CLI |
| `appops.workflow.run` | 运行 VM 内已登记的生产型工作流（按名称+参数） | L1 | `Start-AppOpWorkflow`（ps1/js/py） |
| `appops.com.automate` | 通过 COM 自动化驱动 Office 等桌面应用 | L1 | `New-Object -ComObject` |
| `appops.gui.produce` | 基于 GUI 自动化的多步生产（步骤序列由 Skill 提供） | **L2** | 复用 `gui.*` 原语 |

`appops.*` 的输出目录受 `pathAllowlist` 约束（默认 `C:\WinVMWorkspace`、`%USERPROFILE%\WinVMWorkspace`），产物与源分离，便于审计与回溯。

---

## 4. 能力定义结构（契约）

每个能力在 `packages/contracts` 中以如下结构声明（JSON Schema：`contracts/schemas/capability.schema.json`）：

```jsonc
{
  "id": "system.service.control",          // 唯一标识
  "domain": "system",                      // system|app|storage|gui|meta
  "name": "控制 Windows 服务",
  "description": "启动、停止或重启指定的 Windows 服务",
  "risk": "L1",                            // L0|L1|L2|L3
  "idempotent": false,                     // 是否幂等
  "requiresSession": false,                // 是否依赖交互式会话（GUI 能力为 true）
  "requiresApproval": false,               // 是否强制审批（可由 risk 推导，L2/L3 默认 true）
  "destructive": false,                    // 是否破坏性
  "timeoutMs": 30000,
  "input":  { /* JSON Schema */ },
  "output": { /* JSON Schema */ },
  "policy": {                              // 策略引擎附加约束
    "commandAllowlist": [],                // 正则白名单
    "pathAllowlist": [],                   // 路径前缀白名单
    "pathDenylist": [],                    // 路径黑名单（优先级最高）
    "processAllowlist": []
  },
  "audit": { "snapshot": "none" },         // none|after|before-after
  "implementation": {                      // 实现绑定（VM 侧）
    "kind": "powershell",                  // powershell|native|external
    "module": "system",
    "function": "Control-Service"
  }
}
```

---

## 5. 元能力（`meta`）

| 能力 ID | 说明 | 风险 |
|---|---|---|
| `meta.health.check` | 服务健康（含会话状态、ps-bridge 状态） | L0 |
| `meta.capability.list` | 列出当前已注册能力（供宿主发现） | L0 |
| `meta.audit.query` | 查询审计日志（只读） | L0 |
| `meta.policy.describe` | 查询当前生效策略 | L0 |
| `meta.task.status` | A2A 任务状态查询（桥接到 A2A） | L0 |

---

## 6. 能力到双通道的映射规则

| 通道 | 映射方式 |
|---|---|
| **MCP** | 每个能力 → 一个 MCP tool，工具名 = 能力 ID 的驼峰化（如 `system.service.control` → `system_service_control`），**保持点分原名**以便追溯 |
| **A2A** | 按 domain 聚合成 5 个 A2A Skill + 1 个编排 Skill，写进 Agent Card 的 `skills[]`；任务内部再下钻到具体能力 |

> 工具名统一保留点分形式（`system.service.control`），避免驼峰化导致的能力 ID 反查丢失。

---

## 7. 新增能力的扩展流程（FR-206）

1. 在 `packages/vm-capabilities/powershell/<domain>/` 增加实现函数；
2. 在 `packages/vm-capabilities/registry/<domain>.ts` 增加能力定义（含 risk / policy / input-output schema）；
3. 运行契约校验（自动校验 schema + 风险分级合法性）；
4. MCP 工具与 A2A Skill **自动出现**，无需改框架代码；
5. 若风险为 L2/L3，宿主适配器会自动将其加入 `disabledTools` 建议清单。

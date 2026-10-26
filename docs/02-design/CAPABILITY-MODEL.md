# 统一能力模型规范（CAPABILITY-MODEL）

| 项 | 值 |
|---|---|
| 文档 ID | CAPABILITY-MODEL-winvm-bridge-v1 |
| 版本 | v1.5（M6 读写分派挂载：§3.1.2 三条写侧经分派函数接上（54 计数不变）、shortcut 死函数裁认定册；v1.4（Phase0 文档止血：§3 各域清单按 `definitions.ts` **54 条注册表现状**对齐 —— 7 条幽灵能力摘除并标「V2 规划·当前不可用」、名实不符条目如实化、「已实现待挂载」函数就地标注；v1.3：S-1 §3.1.1 注册表路径形态归一化；K-N2 §3.2.1 dryRun 预览；R17-T01 回执语义） |
| 层 | L0 规范层（`packages/contracts`） |
| 日期 | 2026-10-08（v1.4，最后对账：以 `packages/vm-capabilities/src/registry/definitions.ts` 为准）；2026-10-02（v1.3）；2026-08-28（v1.0） |

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

示例：`system.service.control`、`app.winget.install`、`storage.space.analyze`、`gui.screen.capture`、`appops.workflow.run`、`meta.health.check`

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
| `system.task.scheduled` | 计划任务**查询**（最近/下次运行时间；写侧 V2） | L0 | `Get-ScheduledTaskInfo` |
| `system.registry.read` | 读注册表（路径**形态等价**，见 §3.1.1） | L0 | `Get-ItemProperty` |
| `system.registry.write` | 写注册表（受限根键白名单；路径形态规则同 §3.1.1） | L2 | `Set-ItemProperty` |
| `system.network.config` | 网卡/IP/DNS/路由**查询**（配置侧 V2） | L0 | `Get-NetworkConfig` |
| `system.user.manage` | 本地用户与组**查询**（改密/启停/组成员等写侧 V2） | L0 | `Get-LocalUserInfo` |
| `system.env.manage` | 环境变量**读写**（M6 挂载：带 `value` ⇒ 写入/空串=删除；不带 ⇒ 读取） | L1 | `Invoke-SystemEnvManage` → Get/Set-EnvironmentVariableInfo |
| `system.eventlog.query` | 事件日志查询 | L0 | `Get-WinEvent` |
| `system.power.control` | 关机/重启/休眠 | **L3** | `Stop-Computer` / `Restart-Computer` |

> **Windows 更新管理（原 `system.update.manage`）：V2 规划 · 当前不可用**，未在能力注册表
> `packages/vm-capabilities/src/registry/definitions.ts` 注册，VM 侧亦无对应实现，
> **不得作为可调用能力对外承诺**。落地建议分两阶（L0 检查可装清单先行、L2 安装含重启联动后随），
> 见 `docs/archive/audit/2026-10-08-product-audit.md` PM-07。

#### 3.1.2 名实口径与读写分派挂载（M6 已完成）

> 口径：**能力名实以注册表为唯一事实源**。派发严格按注册 `fn` 发送，故 `ps1` 里已实现但
> 未挂到注册 `fn` 的函数**对外不可用**，文档不得写成"可做"。

| 能力 | 挂载前（历史口径） | **现绑定（M6 · Phase 3 批4）** | 写侧归宿 |
|---|---|---|---|
| `system.env.manage` | L1 只读 | `Invoke-SystemEnvManage`（带 `value` ⇒ 写） | Set-EnvironmentVariableInfo 已接 |
| `storage.archive.manage` | L1 仅压缩 | `Invoke-StorageArchiveManage`（`mode=expand` ⇒ 解压） | Expand-ZipArchiveItem 已接 |
| `app.shortcut.manage` | L1 只读 | `Get-ShortcutInfo`（不变——D8 已内联创建分支） | `New-ShortcutItem`=死函数，裁不重新绑定（双实现漂移风险，audit-pm2 差集亲验；psmod-contract 孤儿快照在册） |
| `gui.clipboard.manage` | L1 只读 | `Invoke-GuiClipboardManage`（带 `text` ⇒ 写） | Set-ClipboardTextValue 已接 |

> 入参提示（M6 后更新）：`system.env.manage` 带 `value`、`gui.clipboard.manage` 带 `text`、
> `storage.archive.manage` 带 `mode:"expand"` 均**真实产生写入/解压**，回执以写侧形状返回
> （set / changedAt / extracted）；不带相应参数 ⇒ 读侧与挂载前逐字同行为。历史"传入不产生写入"
> 警示**作废**——分派由注册表绑定（fn=Invoke-* 三处）与 psmod-contract 守卫共同看护，防口径回潮。

#### 3.1.1 注册表路径形态归一化（S-1 · R19-B）

> 权威契约：`docs/design/r19b-s1-kn2-contract.md` §1–§3（B1 根因 / B2 归一权威 / B3 回显）。
> 判定实现唯一在**策略层** `packages/core/src/policy/engine.ts`（`canonicalRegistryPath` +
> `matchRegistryAllowlist`）；`psmod/system.ps1` 的 `ConvertTo-RegistryPath` 保持 D9 原实现
> （仅补冒号），**不实现第二份归一** —— 双实现正是 S-1 的病灶类型。
> 回归护栏：`tests/unit/r19b-s1-registry-forms.test.js`、`tests/unit/cl017.test.js`（D9 四条）。

- **权威归一形态**：`HKLM:\software\…` —— 根键大写短名 + `:` + 反斜杠 + **键名段小写** + 无尾分隔符。
  该形态同时用于白名单比对与错误回显（判定 / 日志 / 回执三处同一串）。
- **写法不影响成败**（D9 + S-1）：有无冒号（`HKLM:\` ≡ `HKLM\`）、长短根键
  （`HKLM` ≡ `HKEY_LOCAL_MACHINE`）、任意大小写（`hklm:\Software` ≡ `HKLM:\SOFTWARE`）、
  正/反斜杠一律等价 —— 归一后在同一字符串上比对。
- **归一 ≠ 放行**：根键**准入清单恰 4 条**（HKLM/HKCU 的长短写法）。
  `HKU`/`HKEY_USERS`、`HKCR`、`HKCC` **不被铸造合法形态**，且必被拒；
  它们的判定仍落在**注册表域**（`registry{Read,Write}Allowlist:miss`），
  不会退回文件系统域撞 `pathAllowlist:miss`（真机 S-1 的错误归属即在此）。
- **比对大小写敏感**（仅注册表域）：文件系统匹配保持大小写不敏感（NTFS 不敏感但保留大小写，
  且默认表含 `C:\Program Files (x86)\**` 一类混合大小写条目）。
- **错误体**：`POLICY_DENIED.details.path` 回显**权威形态**，`details.inputPath` 保留原样入参，
  `details.forms` 给出等价可用写法与读写范围；**不得**建议「改回某一种写法」，也不得出现
  `M:\…` 一类伪盘符（旧 `extractPathTokens` 盘符正则把 `HKLM:` 尾字母当盘符所致的真机症状）。

### 3.2 `app` —— 应用管理（FR-202）

| 能力 ID | 说明 | 风险 | 依托 |
|---|---|---|---|
| `app.inventory.list` | 已安装应用清单（含 UWP/Store） | L0 | 注册表卸载键 + `Get-AppxPackage` |
| `app.winget.search` | 搜索可安装包 | L0 | `winget search` |
| `app.winget.install` | 安装应用 | L1 | `winget install --exact --id` |
| `app.winget.uninstall` | 卸载应用（**卸载后核验 + NSIS 静默回退**，回执语义见 §3.2.1） | L2 | `winget uninstall` + 事后磁盘/注册表核验 |
| `app.winget.upgrade` | 升级应用（可批量） | L1 | `winget upgrade` |
| `app.process.launch` | 启动应用/打开文件/打开 URL | L1 | `Start-Process` |
| `app.shortcut.manage` | 快捷方式**读取与创建**（Get-ShortcutInfo 内已含「无 path+targetPath ⇒ 创建」分支，D8 决策；`New-ShortcutItem` 系被其内联取代的死函数，不重新绑定） | L1 | `Get-ShortcutInfo` |
| `app.appx.manage` | UWP 包**查询**（安装/移除 V2；移除可先试 `app.winget.uninstall`） | L0 | `Get-AppxPackageInfo` |

> **已摘除条目（V2 规划 · 当前不可用）**：
> - `app.process.activate`（激活已运行窗口）—— **未注册**。需要激活前台窗口时请用已注册能力
>   **`gui.window.control { state: "activate" }`**（§3.4）；本文档不再单列幽灵 ID，避免误调。
> - `app.default.manage`（默认程序关联，注册表 UserChoice）—— **未注册**，V2 规划。
>   当前如需改默认程序，须人工在 VM 内设置，不得对用户承诺本能力。

#### 3.2.1 `app.winget.uninstall` 回执语义（R17 / K6 契约）

> 背景：winget 对 NSIS 安装包可能**假成功**（exit 0 但磁盘/注册表无变化）。自 R17 起该能力的
> `success` **不再等价于 `exitCode === 0`**，而以卸载后核验为准。实现状态机见
> `docs/design/r17-design.md` §A1.3/§A5；契约字段以 `packages/vm-capabilities/src/registry/definitions.ts`
> 的 output schema 为唯一权威，判定规则基线见 `tests/unit/r3-uninstall-verify.test.js`。

回执结构：`{ id, dryRun, exitCode, success, verified, fallbackUsed, residualEvidence?, plan?, output }`

| 字段 | 语义 |
|---|---|
| `success` | **以最终核验为准**：`exitCode=0` 且（首次核验通过 **或** NSIS 回退后核验通过）才为 `true`。winget exit 0 但核验未过（且不可回退/回退后仍残留）→ `success=false` |
| `verified` | 事后核验证据对象：`{ exeGone:boolean, dirGone:boolean\|null, registryGone:boolean, installLocation?:string, installerType:'nsis'\|'msi'\|'other'\|'unknown' }`。核验目标派生：优先注册表 `InstallLocation`；缺失时按 `UninstallString` 去引号/参数取所在目录反推；仍派生不出 → `dirGone=null`（只做注册表核验，如实标注）。**不在 PS 内全盘扫描** |
| `fallbackUsed` | 是否触发 NSIS 静默回退（`Uninstall.exe /S`）。回退仅在卸载键判定为 NSIS 型（`UninstallString` 指向 `Uninstall.exe` 且无 `QuietUninstallString`）时触发；**MSI（`msiexec`）及其它类型永不回退** |
| `residualEvidence` | 核验失败（`success=false`）时的残留证据（残留 exe/目录/注册表键清单）。**宿主/调用方必须如实向用户转呈，不得改写为成功** |
| `plan` | **仅 `dryRun`**（K-N2）：宿主侧纯查询预览载荷 `{ packageId:string, displayName:string, version:string, installerType:'nsis'\|'msi'\|'other'\|'unknown', installed:boolean, registryKey:string, hive:string, installRoot:string, expectedAction:'uninstall-via-winget'\|'winget-uninstall-expected-nonzero-exit', actions:string[], systemImpact:string }`（权威字段表见 `docs/design/r19b-s1-kn2-contract.md` §4.3，三方一致：本表 / `definitions.ts` output schema / `app.ps1` `Get-UninstallDryRunPlan`）。取不到卸载键时 `installed=false`、`installerType='unknown'`、`expectedAction='winget-uninstall-expected-nonzero-exit'`，字符串字段一律为空串（不得缺字段）。**`installed` 是包存在性的唯一事实** —— `success=true` 只代表「预览构造成功」，不代表「包已安装」。已废弃、不得复活的字段：`id`/`name`/`key`（改名）、`uninstallCommand`/`quietUninstallCommand`（可执行命令串不入免审批回执）、`wingetInvoked`（零调用由 `exitCode` 恒 0 + 参数错误码缺席 + 源码静态守卫保证，不靠运行期自宣） |
| `exitCode` | 仅为 winget 原始退出码，保留供诊断，**不得**单独作为成功依据；`dryRun` 预览不发起 winget ⇒ **恒为 0** |

特殊语义：
- **dryRun**（K-N2 起为**宿主侧纯查询预览**）：**零 winget 调用、零子进程**（连 `winget list` 这类只读调用也不发起 —— 预览走 `allow:dry-run-bypass` 免审批通道，任何子进程都等于在无人批准的路径上执行；真机 R19 §2 OBS-B 记录过同族命令 `dur=38307/42467ms` 打到 ps-bridge 45s 心跳阈值），只读注册表卸载键后输出 `plan`；
  回执 `success=true`、`exitCode=0`、`verified=null`、`fallbackUsed=false`（零系统变更 ⇒ 免审批语义保持）。
  ⚠ **严禁**给 `winget uninstall` 追加 `--dry-run` 或 `--what-if`：`Windows Package Manager v1.29.380` 的 uninstall 子命令
  只有 `--install-mode`，预览开关会在参数解析阶段即失败（`exitCode=-1978335230`＝`0x8A150002`
  `Argument name was not recognized`）；真机 R19 `seq157`/`seq165` 跨天逐字段复现（`qa/r19/e2-dryrun.resp.json`、
  `qa/r19/e3-dryrun.resp.json`），故该路径必须由宿主侧预览承担。`app.winget.install` / `app.winget.upgrade`
  侧的 `--dry-run` 不受影响（install/upgrade 子命令支持）。
  运维事实：修改 `psmod/app.ps1` 后**必须重启 VM 服务**才生效（ps-bridge 常驻进程按启动时快照加载 psmod）。
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
| `storage.dir.manage` | **创建**目录（幂等；删除目录请用 `storage.file.delete`） | L1 | `New-DirectoryItem` |
| `storage.search.query` | 文件名/内容搜索 | L0 | `Get-ChildItem -Recurse` / `Select-String` |
| `storage.archive.manage` | zip **压缩/解压**（M6 挂载：`mode=expand` ⇒ 解压；缺省压缩） | L1 | `Invoke-StorageArchiveManage` → New/Expand-ZipArchiveItem |
| `storage.link.manage` | 符号链接/硬链接/ junction | L2 | `New-LinkItem` |
| `storage.recycle.manage` | 回收站**查看**（清空侧 V2；如需删除请按 `storage.file.delete` 逐项审批） | L0 | `Get-RecycleBinInfo` |
| `storage.cleanup.analyze` | 清理建议（**只分析不执行**） | L0 | 规则引擎 |

> **红线**：分区/格式化/卷删除（`storage.volume.destructive`）列为 **L3**，V1 **不注册为可用能力**，仅在文档中说明需人工在 VM 内执行。

### 3.4 `gui` —— 图形化与桌面自动化（FR-204）

| 能力 ID | 说明 | 风险 | 依托 |
|---|---|---|---|
| `gui.session.status` | 会话健康检查（SessionId/窗口站/桌面/是否锁屏） | L0 | `Get-Process -Name explorer` 等 + 自研探针 |
| `gui.screen.capture` | 截图（全屏/窗口/区域）+ Base64 回传 | L0 | `System.Drawing` + `CopyFromScreen` |
| `gui.screen.analyze` | 黑屏/纯色检测（熵判定） | L0 | 像素方差统计 |
| `gui.window.list` | 窗口枚举（标题/句柄/位置/进程） | L0 | `EnumWindows` P/Invoke |
| `gui.window.control` | 窗口状态：最小化/最大化/还原/关闭/激活（`state` 枚举 `minimize\|maximize\|restore\|close\|activate`；**置顶/移动/改尺寸 V2**） | L1 | `Set-WindowState` |
| `gui.input.keyboard` | 键盘输入（文本 / 组合键 / 虚拟键码） | L1 | `SendInput` P/Invoke |
| `gui.input.mouse` | 鼠标（移动/点击/双击/右键/拖拽/滚轮） | L1 | `SendInput` P/Invoke |
| `gui.uia.tree` | UIA 元素树（按窗口/按坐标命中） | L0 | `System.Windows.Automation` |
| `gui.uia.invoke` | 按 AutomationId/Name/ControlType 定位并点击/设值 | L1 | UIA Patterns（Invoke/Value/Toggle） |
| `gui.clipboard.manage` | 剪贴板文本**读写**（M6 挂载：带 `text` ⇒ 写入/空串=清空；图片/文件格式仍不支持） | L1 | `Invoke-GuiClipboardManage` → Get-ClipboardText/Set-ClipboardTextValue |
| `gui.wait.condition` | 等待条件（枚举 `windowExists\|windowGone\|processExited\|screenStable`；"元素存在/图像匹配" V2） | L0 | 轮询 + 超时 |

> **浏览器自动化（原 `gui.browser.control`）：V2 规划 · 当前不可用**，未在 `definitions.ts`
> 注册，VM 侧 `psmod/gui.ps1` 亦无任何浏览器/CDP 代码。
> **当前网页端操作的可用路径**（全部为已注册能力）：
> `app.process.launch`（打开浏览器/URL）→ `gui.session.status` / `gui.screen.capture`（看屏）→
> `gui.uia.tree` / `gui.uia.invoke`（元素定位，浏览器 DOM 经 UIA 暴露）→
> `gui.input.keyboard` / `gui.input.mouse`（填表/点击）→ `gui.wait.condition`（等稳定）→
> `gui.screen.capture`（结果存档），多步序列可封装为 `appops.gui.produce`。
> 依赖 CDP 直驱的增强（取 DOM、精确选择器）待 `gui.browser.control` 注册后再启用
> （实现建议见 `docs/archive/audit/2026-10-08-product-audit.md` NP-04）。

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

每个能力在 `packages/contracts` 中以如下结构声明（JSON Schema：`contracts/schemas/capability.schema.json`）。**schema 资产口径（Phase 2 · P2-T1）**：该 schema 是**被消费的交付面资产** —— `packages/contracts/src/schema-check.ts` 的纯函数 `validateCapabilityShape(def, schema)` 以本 JSON 为判据唯一来源，由 `tests/unit/phase2-contract-schema.test.js` 对注册表全量能力逐条校验，并以 `checkSchemaDomainDrift` 钉住 schema `domain.enum`/`id.pattern` 首段 ⇔ TS 事实源 `CAPABILITY_DOMAINS` 集合一致（新增域漏改 schema ⇒ 测试必红）。运行实例**不**校验能力定义（裁决 Q1=(b)：定义源自代码内常量，运行期校验增益≈0 且徒增启动风险面）：

```jsonc
{
  "id": "system.service.control",          // 唯一标识
  "domain": "system",                      // system|app|storage|gui|appops|meta（事实源 CAPABILITY_DOMAINS，capability.ts）
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
    // ⚠ ARCH-18（Phase 1 已裁断＝删除）：命令面**只有黑名单**，本对象不再有 `commandAllowlist`。
    // 它从未被引擎读取（死配置），全仓唯一写入点（`appops.workflow.run` 的 9 个解释器正则）已同批移除；
    // 解释器准入改由 `appops.cli.invoke` 的 `input.app` 枚举 + 登记期 `validateParams`（早于执行）把守。
    // ★ 运维注意：`capability.schema.json` 的 `policy.additionalProperties === false` ⇒ 旧能力定义
    //   若仍写 `commandAllowlist`，会被 schema **直接拒绝**（不是静默忽略）。兑现面（Phase 2 · P2-T1 起）：
    //   该拒绝由**交付面**执行——`schema-check.ts#validateCapabilityShape` 读本 schema 为判据、
    //   `tests/unit/phase2-contract-schema.test.js` 逐条校验并含 commandAllowlist 拒收自证用例；
    //   运行实例不校验（裁决 Q1=(b)）⇒ 升级前仍必须主动删该键，勿指望运行期报错。
    "pathAllowlist": [],                   // 路径前缀白名单（支持 `%ENV%\**` 模式侧运行时展开，ARCH-17）
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
| `meta.session.status` | Windows 交互式会话健康度（SessionId/窗口站/桌面/锁屏/黑屏） | L0 |

> **已摘除条目（V2 规划 · 当前不可用）**：`meta.audit.query`、`meta.policy.describe`、
> `meta.task.status` 三条**未在 `definitions.ts` 注册**，不得作为可调用能力对外承诺。
> 当前替代路径：
> - 审计回看 → SSH 进 VM 读 `%LOCALAPPDATA%\WinVMBridge\audit\audit-YYYYMMDD.jsonl`，
>   完整性经 `GET /health` 的 `chainValid` 侧漏（内容级查询能力属 V2，见 PM-06/NP-06）；
> - 生效策略 → 读 `packages/core/src/policy/defaults.ts` 与部署配置（查询能力属 V2）；
> - A2A 任务状态 → 走 A2A 协议 `tasks/get`（见 `INTERFACES.md`），非能力注册表条目。
>
> 补齐注册（三条均为 L0 只读，成本低且直接兑现"可监管"卖点）属工程师范围，
> 完成前本文档不恢复其"已注册"外观。

---

## 6. 能力到双通道的映射规则

| 通道 | 映射方式 |
|---|---|
| **MCP** | 每个能力 → 一个 MCP tool，工具名 = 能力 ID 的驼峰化（如 `system.service.control` → `system_service_control`），**保持点分原名**以便追溯 |
| **A2A** | 按 domain 聚合成 5 个 A2A Skill + 1 个编排 Skill，写进 Agent Card 的 `skills[]`；任务内部再下钻到具体能力 |

> 工具名统一保留点分形式（`system.service.control`），避免驼峰化导致的能力 ID 反查丢失。

---

## 7. 新增能力的扩展流程（FR-206）

> **路径订正（2026-10-13 · Phase 3 批0，J 系漂移/audit-arch ⑤ D-6a）**：本节原写 `packages/vm-capabilities/powershell/<domain>/` 与 `packages/vm-capabilities/registry/<domain>.ts` ——**两个路径都不存在**（实况：PowerShell 实现是 `packages/vm-capabilities/psmod/<domain>.ps1` 单文件六域：system/app/storage/gui/appops/ps-bridge；能力定义是**单文件** `packages/vm-capabilities/src/registry/definitions.ts`，54 条全量同文件，无分域 `.ts`）。照旧文"新增能力"会第一时间翻车。流程按实况重列：

1. 在 `packages/vm-capabilities/psmod/<domain>.ps1` 增加 PowerShell 实现函数（函数名 = 注册表 `fn:` 字段，跨语言隐式契约）；
2. 在 `packages/vm-capabilities/src/registry/definitions.ts` 以 `cap({ id, module, fn, risk, ... })` 增加能力定义（含 risk / policy / input-output schema；risk 必填勿靠缺省）；
3. 手改 `tests/unit/psmod-contract.test.js` 的 `EXPECTED_TOTAL`（54→N）与域分布断言，跑 `node --test tests/unit/psmod-contract.test.js` 对账命名成对性；
4. **契约校验现状如实化**：schema + 风险分级合法性校验**不是自动运行期校验**——落点在测试/门禁面（`phase2-contract-schema.test.js` + `npm run gate`，裁决 Q1=(b)），故第 3 步与门禁必须人工触发；
5. MCP 工具与 A2A Skill **自动出现**（由注册表派生，无需改框架代码）；
6. 若风险为 L2/L3，宿主适配器会自动将其加入 `disabledTools` 建议清单；同步更新 `skills/*/SKILL.md`（若涉对外语义）与本文件 §3 清单；
7. **重装/重启 VM 侧**（psmod 变更不重启服务不生效——改 `.ps1` 必须让常驻 ps-bridge 重载，见 `docs/05-peripherals/DEPLOYMENT.md`）。

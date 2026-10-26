# CL-017 · 真机 E2E 能力巡检缺陷修复（鸿蒙宿主 → Windows VM）

> 变更标识：`CL-017` ｜ 性质：缺陷修复 + 韧性增强（不改协议方法名/端点/既有字段语义）
> 触发：2026-09-17 在**鸿蒙宿主** WorkBuddy 内对插件做「5 域 × 2 通道」真机巡检（54 能力抽测 + 审批闸 + A2A 委派）
> 目标：让 **Skill 文档里写明的用法在真机上真正跑通**；桥不再因单次失败永久不可用
> 证据来源：`qa/probes/`（本次巡检夹具与原始输出）

## 0. 巡检覆盖与结论

| 域 | 抽测 | 通过 | 失败 |
|---|---|---|---|
| meta | 3 | 1 | `meta.health.check` 返回错载荷 |
| system | 12 | 8 | 服务列表超时、事件日志 level 恒空、注册表路径形态、网络配置载荷膨胀 |
| app | 6 | 3 | 已装应用崩、快捷方式契约不符、winget 解析错位 |
| storage | 14 | 6 | **生产工作目录被策略拒绝（8 项连带失败）** |
| gui | 6 | 4 | `screen.capture` 非 base64 形态无产物 |
| appops | 5 | 1 | **`cli.invoke` 挂死 ps-bridge → 全桥级联失败** |
| 审批闸（MCP） | 3 | 3 | L3 dry-run 被审批闸挡住 |
| A2A 委派 | 3 | 2 | **LLM 委派必失败**（spawn + CLI 契约双错） |

---

## 1. P0 缺陷（阻塞级，必须修）

### D1 · 双 PsBridge 实例 → 健康检查撒谎 + 进程翻倍

**现象**：`/health` 同时返回 `provider.state="degraded"` 与 `psBridge.state="ready"`；一次超时后所有能力调用永久 `PROVIDER_UNAVAILABLE`，而 `/health` 依旧报 ps-bridge ready。

**证据**：
- 重启服务后 `Get-CimInstance Win32_Process` 过滤 `ps-bridge.ps1` → **count=2**，两个实例 **PPID 相同**（同一个 vm-service node 进程）。
- 挂死后只剩 1 个（runtime 那侧存活、provider 那侧死亡）。

**根因**：
- `packages/vm-service/src/server.ts:143-153` 构造 `bridgeCtx` **未注入 `bridge`**。
- `packages/adapter-agent-workbuddy/src/index.ts:59-61` `init()` 里 `this.bridge = new PsBridge(this.bridgeOptions)` —— 自建实例。
- `server.ts:480` `buildHealth()` 读的是 `runtime.bridge.health()`（实例 A），而能力执行走 provider 的实例 B。
- 两实例各自 spawn 一个 `ps-bridge.ps1`，各自跑心跳看门狗。

**修复要求**：全程**单例**。
1. `bridgeCtx` 注入 `bridge: runtime.bridge`。
2. provider `init()` 改为 `this.bridge = ctx.bridge ?? new PsBridge(...)`（保留兜底以便非 Windows/测试）。
3. `server.ts` 只保留一次 `runtime.bridge.start()`，provider 不得二次 spawn。
4. 契约层（`packages/contracts`）给 `BridgeContext` 增加可选 `bridge` 字段。

### D2 · 桥死亡永不自愈 → 一次失败即永久不可用

**现象**：`appops.cli.invoke` 触发 45s 心跳超时后，后续**所有**能力（含 `meta.capability.list`）永久返回 `ps-bridge 未就绪`，必须重启服务。

**根因**（`packages/vm-capabilities/src/ps-bridge.ts`）：
- `watchdog()` 首行 `if (!this.running || this.restarting || this.stopped) return;` —— `running` 一旦为 false，看门狗直接返回，**永远不会再拉起**。
- `restart()` 的 `catch` 只 `onStderr?.(...)` 吞掉异常，无状态暴露；`ready()` 失败路径会 `kill()` 清空 child。
- `start()` 有 `if (this.running) return;` 早退，所以外部也无从自愈。

**修复要求**：
1. `watchdog()` 改为：`stopped`/`restarting` 才早退；`running === false` 时尝试自愈 `spawnAndReady()`。
2. `call()` 入口加 **lazy 自愈**：未 running 且未 stopped → 先尝试 `start()`（带退避，避免风暴），失败再报 `PROVIDER_UNAVAILABLE`。
3. `restart()` 失败必须**计数并暴露**到 `health()`（如 `restarts`/`lastError`），禁止静默。
4. `health()` 增加 `restarts`、`lastError`（保持既有字段不变，纯增量）。

### D3 · `appops.cli.invoke` 用 `command` 却只执行 `arguments` → 挂死全桥

**现象**：`{"app":"node","command":"node -v"}` → **51s** 无响应 → 桥被判僵死；随后级联失败。skill 文档里给出的示例（`{"app":"ffmpeg","command":"ffmpeg -i in/a.mp4 ..."}`）**必然复现**。

**根因**（`packages/vm-capabilities/psmod/appops.ps1` `Invoke-AppCli`）：
```powershell
$out = & $exe @(if ($App -ne 'custom') { $Arguments -split '\s+' | Where-Object { $_ } } else { @() }) 2>&1
```
- `command` 参数**除 `custom` 外完全未使用**；`arguments` 缺省为 `''` → **零参数启动** `node.exe`/`python.exe` → 进入 REPL，阻塞读 **ps-bridge 的 stdin 管道** → 全桥死锁。
- 子进程无独立超时；子进程继承管道。

**修复要求**：
1. 参数来源：优先用 `Command` 作为参数串；若 `Command` 以 `<exe>` 或 `$App` 名开头，**剥掉可执行名前缀**后再拼 `Arguments`。
2. 子进程**必须**：`RedirectStandardInput = $true` 且立即关闭（`stdin.Close()`），`RedirectStandardOutput/Error = $true`，用 `System.Diagnostics.Process` + `WaitForExit(timeoutMs)`。
3. 加**硬超时**（能力级，默认 120s，超时 kill 进程树并返回 `TIMEOUT`），保证单次调用无法拖死桥。
4. 兜底：若解析后参数为空且 app 属于 `node/python`，返回明确错误 `INVALID_ARGUMENT`，不得静默零参启动。
5. `appops.ps1` 所有函数同样禁止任何 stdout 杂散输出。

### D4 · codebuddy CLI 契约错误（真机已核实）

**现象**：A2A `a2a.delegate` 立即失败：`LLM 运行时错误：spawn codebuddy ENOENT`。

**根因**（`packages/adapter-agent-workbuddy-llm/src/bridge.ts`）：
1. `spawn(this.cliPath, args, { windowsHide: true, env: process.env })` —— Windows 下 npm 安装的 CLI 是 `codebuddy.cmd`，Node `spawn` **不解析 `.cmd`/`.bat` 且不读 PATHEXT**，也不带 `shell:true` → ENOENT。真机实测 `where codebuddy` → `...\nvm\installs\v24.21.0\codebuddy.cmd`。
2. `DEFAULT_CLI_ARG_TEMPLATE = ['--goal','{goal}','--system-prompt','{prompt}','--mcp','{endpoint}','--output','{output}']` —— 真机 `codebuddy --version` = `2.149.0`，`--help` 显示**这四个选项全部不存在**。真实契约：
   - 非交互：`-p/--print`，提示词为**位置参数**；无 `--system-prompt`（须把系统提示与目标合并进位置提示词）
   - 输出：`--output-format text|json|stream-json`
   - MCP：`--mcp-config <fileOrString>`（JSON，**不是** URL）+ `--strict-mcp-config`
   - 目录授权：`--add-dir <dirs...>`
   - 免交互：`--permission-mode bypassPermissions`（或 `-y, --dangerously-skip-permissions`）
   - **无 `--output`** → 产物靠扫描 `outputDir`（现有 `collectArtifacts` 已实现，保留）

**修复要求**：
1. `resolveCliPath()`：On win32 依 `PATHEXT` 依次探测 `codebuddy.exe/.cmd/.bat`；支持绝对路径、`~/`、`%ENV%` 展开；解析失败给出**可操作**错误（含搜索过的目录与建议的 `cliPath` 写法）。
2. 非 `.exe` 一律以 `cmd.exe /d /s /c "<quoted cmdline>"` 方式启动（或 `shell:true` + 安全引用），保证 `.cmd` 可跑。
3. `DEFAULT_CLI_ARG_TEMPLATE` 改为真机契约：
   `['-p','{prompt}','--output-format','text','--permission-mode','bypassPermissions','--add-dir','{output}','--mcp-config','{mcpConfig}']`
   其中 `{prompt}` = 「系统提示 + 目标 + 产物目录 + 能力清单」合并文本；`{mcpConfig}` = `{"mcpServers":{"winvm":{"type":"streamableHttp","url":"<endpoint>"}}}`。
   保留 `cliArgTemplate` 可覆盖能力。
4. **降级**：LLM 运行时不可用（ENOENT / 非零退出且无产物）时，回落到确定性执行器的模板 `runGoal`（`UNSUPPORTED_GOAL` 才真正失败）。委派结果需在 `summary` 里标明「已降级为确定性执行」。

---

## 1.5 修复轮次中新发现（P0 · 静默错数据，比崩溃更危险）

> 来源：team-lead 对首轮修复做**独立基线核对**时发现（不采信工程师自述）。

### D21 · `app.inventory.list` 静默漏报 19 → 1

**真机基线**（`qa/probes/probe-inv.ps1`）：三个 Uninstall 根合计含 `DisplayName` 条目 = 11 + 5 + 3 = **19**；
修复首轮后 `Get-InstalledApps` 只返回 **1** 条（Microsoft Edge）。

**二分定位**（`qa/probes` 探针）：
```
A 原始 count=19
B Sort-Object -Property name -Unique          → 1   ← 错
C Sort-Object -Property { $_.name } -Unique   → 18  ← 对（RustDesk 重复，18 正解）
D Sort-Object -Property name（无 -Unique）     → 19（数量对，但排序是空操作）
```

**根因**：**PS 5.1 对 `[ordered]@{}` 用 `Sort-Object -Property <键>` 时键解析失败且不报错** ——
不带 `-Unique` 退化为不排序；带 `-Unique` 时所有条目被判等而**塌缩为 1 条**。
这是**静默错数据**缺陷：D13 修掉崩溃后，它才从「崩」暴露成「悄悄少给」。

**修复**：`packages/vm-capabilities/psmod/app.ps1:46`
→ `$apps = @($apps | Sort-Object -Property { $_.name } -Unique)`

### D22 · `storage.space.analyze` 的 Top-N 未真正排序

`storage.space.analyze {path:'C:\Users\User',depth:1,top:5}` 实际返回
`NetHood=0, My Documents=0, PrintHood=0, Pictures=0, Links=0` —— 不是最大的 5 个目录，同根因。

**修复**：
- `packages/vm-capabilities/psmod/storage.ps1:106` → `Sort-Object -Property { [double]$_.sizeMB } -Descending`
- `packages/vm-capabilities/psmod/system.ps1:154` → `Sort-Object -Property { [double]$_.workingSetMB } -Descending`
- 复核 `storage.ps1:322`（对 `FileInfo.Length`，理论无影响，需实测 `storage.cleanup.analyze` 的 topLargeFiles 降序）

**约定**：psmod 中一切对 `[ordered]@{}` 列表的排序/去重**必须**用脚本块属性访问器（`{ $_.key }`），
并在每处写明原因，防止回退。

---

## 2. P1 缺陷

| ID | 缺陷 | 证据 | 修复要求 |
|---|---|---|---|
| D5 | `meta.health.check` 绑定到 `Get-SystemInfo`，返回系统信息而非健康快照 | `definitions.ts:62-72` `module:'system', fn:'Get-SystemInfo'` | 改由 **Node 侧内置**（`module:'__meta'`）返回与 `GET /health` 同构的快照（provider/psBridge/session/capabilities/audit/restarts） |
| D6 | `system.service.list` 无 name 过滤时 **30s 超时** | 逐个 `Get-CimInstance Win32_Service -Filter` | 改为**一次** `Get-CimInstance Win32_Service` 建 `Name→StartMode` 字典，O(1) 查表 |
| D7 | `system.eventlog.query` 的 `level` **任何取值都返回空** | `FilterHashtable @{LevelDisplayName=...}` 非 PS 5.1 合法键 | 映射为数字 `Level`：`Critical=1,Error=2,Warning=3,Information=4,Verbose=5`，并接受中英文别名（错误/警告/信息、Error/Warning/Information） |
| D8 | `app.shortcut.manage` schema 暴露 `targetPath/arguments/workingDirectory`，PS 只收 `path` | 调用报「找不到与参数名称 targetPath 匹配的参数」 | PS `Get-ShortcutInfo` 补齐参数并在提供 `targetPath` 时**创建/覆盖** .lnk；读取时返回 target/args/workingDir |
| D9 | 注册表路径必须带冒号，`HKLM\...` 形式被拒，Skill 未说明 | `HKLM\SOFTWARE\...` → POLICY_DENIED；`HKLM:\SOFTWARE\...` → OK | 策略层 `normalizeRegistryPath()` 自动补根键冒号（`HKLM\`→`HKLM:\`），并同步 Skill 写明合法根键白名单 |
| D10 | 列表能力空/单元素返回 `{}` / 对象而非 `[]` / `[{...}]` | `system.service.list` 命中 1 条回对象、命中 0 条回 `{}` | ps-bridge 按能力声明的列表语义**强制保形**（返回数组）；定义层补 `output.array` 标记（或 PS 侧用不展开的返回写法） |
| D11 | L3 的 `dryRun:true` 也被审批闸拦截 → Skill 规定的「L3 先 dry-run 再确认」**无法执行**；L3 审批 `impact` 为空、无 dry-run 结果 | `system.power.control {dryRun:true}` → APPROVAL_REQUIRED，`impact: []` | 策略层：`params.dryRun === true` **免审批**放行（dry-run 不改系统状态）；审批预览对支持 dryRun 的能力附带 dry-run 计划摘要 |
| D12 | `system.network.config` 返回未投影 CIM 对象（`CimClass`/`CimSuperClass` 递归），12.5s | `gateway` 直接回 `$_.IPv4DefaultGateway` | 投影为 `[{nextHop, routeMetric}]`；`dnsServers` 去重；总时长目标 < 3s |
| D13 | `app.inventory.list` 真机直接崩（`找不到属性 InstallDate`） | VM 跑的是 **2026-09-10** 的 `ps-bridge.ps1`（`Set-StrictMode -Version Latest`）；本地已改 `Version 1` 但**未部署** | 属部署漂移 → 由 D15 统一重新分发解决；同时在 `app.ps1` 内对可选属性加 `PSObject.Properties` 守卫，双保险 |
| D14 | `C:\WinVMWorkspace\**` 白名单未生效 → **文档承诺的生产工作目录全域被拒**（storage 8 项连带失败） | VM `core/dist/policy/defaults.js` 为 **09-16 18:11** 旧构建，缺该条目；本地源码已有 | 属部署漂移 → D15；并补单测锁定该条目存在 |

### D15 · 部署漂移（横切，必须收口）

VM `C:/WinVMBridge` 与本地仓库已漂移，实测差异：

| 文件 | 本地 | VM | 影响 |
|---|---|---|---|
| `packages/core/dist/policy/defaults.js` | 含 `C:\WinVMWorkspace\**` | **缺**（09-16 18:11） | D14：生产工作目录被拒 |
| `packages/vm-capabilities/psmod/ps-bridge.ps1` | `Set-StrictMode -Version 1` | `Latest`（**09-10 15:29**） | D13：`app.inventory.list` 崩 |
| `packages/vm-capabilities/psmod/{system,app,appops}.ps1` | 本次将新增修复 | 旧 | D3/D6/D7/D8 |

**要求**：`npm run build` → 走 `delivery/` 既有部署路径把 `psmod/*.ps1` + 全部 `dist/` 重新分发到 `C:/WinVMBridge` → 重启 `WinVMBridge.Service` → 复核 `/health` 与能力抽测。
**注意**：`ps-bridge` 不可热更（启动时 dot-source 全部模块），**必须重启服务**才生效。

---

## 3. P2 缺陷（记录，酌情修）

| ID | 说明 |
|---|---|
| D16 | `app.winget.search` 解析把表头当数据行、列错位（回 `id:"Version"`、`name:"Name  Id"`）→ 需按 `----` 分隔线做定宽列解析 |
| D17 | `gui.screen.capture {asBase64:false}` 只回 `{width,height,bytes}`，无落盘路径/内容，调用方拿不到图 → 非 base64 形态应落盘到产物目录并返回路径 |
| D18 | `storage.file.write` 写入带 UTF-8 BOM（`\ufeff`），读回内容含 BOM |
| D19 | 服务无日志落盘（`ConsoleLogger` 写隐藏进程 stdout，丢失）→ 故障不可诊断；建议落 `%LOCALAPPDATA%/WinVMBridge/logs/` |
| D20 | `appops.state.query` 把安装器/框架宿主窗口（`...tmp Setup`、`ApplicationFrameHost`）也列为「生产型应用」 |

---

## 4. Skill 文档需同步的更正（本变更强制项）

| Skill | 需更正内容 |
|---|---|
| `winvm-orchestrator` | ①`appops.cli.invoke` 示例改为**真实契约**（见 D3：参数走 `command`，不可只填 `app`）；②L3 流程补「`dryRun:true` 免审批」说明，删掉「dry-run 预览未就绪即阻断」的不可达分支；③补 `PROVIDER_UNAVAILABLE` 的**有界重试**指引（自愈后 1–2 次退避重试），与「不要靠重试硬扛」区分开：区分「桥自愈中」与「配置错误」 |
| `winvm-system-admin` | ①注册表必须用 `HKLM:\`/`HKCU:\` 带冒号形式，并列出可读根键白名单（`HKLM:\SOFTWARE\**`、`HKCU:\**`）；②`eventlog.query` 的 `level` 用英文枚举 `Error/Warning/Information/Critical/Verbose`（已做中文别名，但推荐英文）；③`service.list` 说明 name 为**模糊匹配**且已优化 |
| `winvm-storage-manager` | 明确**路径白名单**：`C:\Users\**`、`C:\Temp\**`、`C:\WinVMWorkspace\**`、`D:\Data\**`；黑名单 `C:\Windows\**`、`C:\Program Files*\**`、`C:\ProgramData\**` 一律拒绝 → 引导产物写 `C:\WinVMWorkspace\` |
| `winvm-app-manager` | `app.shortcut.manage` 用法更新（`path` + `targetPath` 即创建）；winget 解析修复说明 |
| `winvm-gui-automation` | `screen.capture` 两种形态说明（base64 回传 vs 落盘路径） |
| `winvm-app-operation` | 产物目录统一 `C:\WinVMWorkspace\out`；`cli.invoke` 参数契约；LLM 委派降级语义 |
| `winvm-mcp-reference` | 补「桥自愈与有界重试」「服务日志位置」「D15 部署漂移自检（md5 比对）」排查项 |

> 同步约束：`skills/`（仓库权威源）与 `~/.workbuddy/connectors/skills/connector-winvm/`（宿主已部署副本）**必须一致**。

---

## 5. 验收标准

| # | 标准 | 判定方式 |
|---|---|---|
| A1 | 单例：服务启动后 `ps-bridge.ps1` 进程数 **= 1** | 远端进程枚举 |
| A2 | `/health` 的 `provider.state` 与 `psBridge.state` **不再矛盾** | 构造失败后读 `/health` |
| A3 | 死亡自愈：kill 掉 ps-bridge 后，**不重启服务**，下一次调用能自动恢复（须同时证明：新 PID ≠ 被杀 PID、服务 PID 未变、实例数仍为 1） | 远端探针 + 调用（`qa/probes/qa-verify.mjs A3`） |
| A4 | `appops.cli.invoke {app:'node',command:'node -v'}` 在 **10s 内**返回 0 退出码与版本号；`ffmpeg` 同理 | 真机调用 |
| A5 | A2A 委派**如实可用**（判据按实测收紧为三支）：① `a2a.health` 可达且声明技能 ≥5；② 命中确定性执行器模板的措辞（如「获取系统信息」）→ `state=completed`、`isError=false`、step 真的执行成功；③ **未命中模板的措辞 → `state=failed` 且如实说明并给出可操作补救，绝不谎报成功**。⚠ 本 VM 的 codebuddy 未登录 → LLM 路径必然降级，故本项**只验降级链路与诚实性**，不验 LLM 真实推理 | 宿主 stdio 桥三调用（`qa/probes/qa-verify.mjs A5`） |
| A6 | `meta.health.check` 返回健康快照（含 `psBridge.state`、`capabilities`、`audit`） | 真机调用 |
| A7 | `C:\WinVMWorkspace\**` 可读写：建目录→写文件→读回→搜索→压缩 全通 | 真机调用 |
| A8 | `app.inventory.list`（**条数 ≥ 15**，注册表基线 19；不得只断言 >0）、`system.service.list {}`、`system.eventlog.query {level:'Error'}` 三项返回正确 | 真机调用 + `probe-inv.ps1` 独立基线 |
| A9 | L3 `system.power.control {action:'restart',dryRun:true}` **无需审批**即返回 dry-run 计划 | 真机调用 |
| A10 | 列表类能力空结果回 `[]`、单元素回 `[{...}]` | 真机调用 |
| A11 | **拆为两半（避免自相矛盾）**：**A11（夹具内·只读）**= 关键产物「本地 ↔ VM」md5 一致（app.ps1 / ps-bridge.ps1 / adapter `dist/index.js`）；**A11-B（冻结前门禁·主理人单独跑）**= `npm run build` 干净通过 + 单测逐文件 `node --test --test-reporter=tap` 全绿。⚠ **A11 绝不进夹具跑构建**——构建会改写 `dist/`，反而让「VM 上正在跑的那份」与本地产物失配，制造假失败 | `node qa/probes/qa-verify.mjs A11`（只读）+ 主理人构建门禁 |
| A12 | 仓库 `skills/` 与宿主 `connectors/skills/connector-winvm/` 内容逐文件一致 | `diff -r` |
| A13 | Top-N 类能力**真的排序**：`storage.space.analyze` 的 `entries[].sizeMB` 单调不增且首项 > 0；`system.process.list {top:5}` 的 `workingSetMB` 单调不增 | 真机调用（`qa/probes/qa-verify.mjs A13`） |
| A14 | 隐藏陷阱不再回退：psmod 中不存在对 `[ordered]@{}` 直接 `Sort-Object -Property <键>` 的写法 | 静态扫描 |
| A15 | **错误码分层可用**：`error.code` 仍属契约层 10 码；领域原因码出现在 `error.reason`。四例：`storage.file.read` 不存在文件 → `reason=FILE_NOT_FOUND`；`system.service.control {name,action}` 不存在服务 → `reason=SERVICE_NOT_FOUND`；`system.registry.read` 不存在键 → `reason=REG_PATH_NOT_FOUND`；`appops.cli.invoke {app:'ffmpeg'}` → `reason=CLI_NOT_FOUND`。且**成功路径未被改坏** | 真机四调用 + 贴原始返回（`qa/probes/qa-verify.mjs A15`） |
| A16 | **入参契约错误可路由**：缺必填 / 未知参数 / 两者兼有，三类均返回 `code=INVALID_PARAMS` + `reason=INVALID_ARGUMENT`，且 `details` 含 `missing`/`unknown`/`allowed`；**不发起桥往返** | 真机三调用（`qa/probes/qa-verify.mjs A16`） |
| A17 | **`app.winget.search` 不再静默空**：与**独立基线**（同 VM 直接 `winget search`）交叉校验，条数 ≥ min(基线,20) 且含 `7zip.7zip`；含 CJK 行时**脏 id 行数 = 0**（不变量 `^[A-Za-z0-9._+\-]+$`）。禁止只断言插件自报 `ok` | 真机调用 + 独立基线（`qa/probes/qa-verify.mjs A17`） |
| A18 | **入参契约校验覆盖 `type` / `enum`**（D26）：`system.process.list {top:"abc"}` 与 `system.service.control {name,action:"bogus"}` 均返回 `code=INVALID_PARAMS` + `reason=INVALID_ARGUMENT`，`details` 指明字段与期望；**且可强转的宽松形态不得误拒**（`top:"20"` 仍成功）；无 `type` 声明的字段（`value`/`content`）不受影响 | 真机两调用 + 两例宽松对照（`qa/probes/qa-verify.mjs A18`） |

---

## 6. 复核阶段追加（主理人实证 → 插队修复）

### D23 · PS 领域错误码被压平为 `EXECUTION_FAILED`（P1 · 系统性）

**现象**：psmod 内全部 `throw "UPPER_SNAKE: msg"` 的真实码**在到达调用方前丢失**，统一变成 `EXECUTION_FAILED`，仅在 `message` 里留下 `CODE: ...` 前缀文本。

**真机证据**（2026-09-17，修复前）：

| 调用 | `error.code` | `error.message` |
|---|---|---|
| `storage.file.read {path:'C:\Users\User\__nope__.txt'}` | `EXECUTION_FAILED` | `FILE_NOT_FOUND: C:\Users\User\__nope__.txt` |
| `system.service.control {name:'__nope__'}` | `EXECUTION_FAILED` | `SERVICE_NOT_FOUND: 服务不存在 —— __nope__` |
| `appops.cli.invoke {app:'ffmpeg'}` | `EXECUTION_FAILED` | `CLI_NOT_FOUND: 未找到 ffmpeg.exe...` |

**根因（链路只有一处断点，上游是对的）**：

| 层 | 状态 |
|---|---|
| `psmod/ps-bridge.ps1:182` catch 段 `if ($ex.Message -match '^([A-Z_]+):') { $code = $Matches[1] }` | ✅ 已正确提取 |
| `packages/vm-capabilities/src/ps-bridge.ts`（`call()` 末尾）`throw new PsBridgeError(e.code, e.message, e.details)` | ✅ 已正确上抛 |
| `packages/adapter-agent-workbuddy/src/index.ts:513-530` `toBridgeError()` | ❌ **唯一断点**：仅 9 项白名单，领域码不命中 → 第 529 行 `makeError('EXECUTION_FAILED', err.message)`，**message 保留、code 丢弃** |

**影响**：psmod 内共 **35 处** `throw "UPPER_SNAKE: msg"`（`FILE_NOT_FOUND`/`PATH_NOT_FOUND`/`CLI_NOT_FOUND`/`SERVICE_NOT_FOUND`/`PROCESS_NOT_FOUND`/`WINDOW_NOT_FOUND`/`ELEMENT_NOT_FOUND`/`WINGET_NOT_FOUND`/`REG_PATH_NOT_FOUND`/`UNSUPPORTED_APP`/`UNSUPPORTED_KEY`/`INVALID_ARGUMENT`/`INVALID_RECT`/`FILE_TOO_LARGE`/`PROTECTED_PROCESS`/`COM_NOT_FOUND`/`COM_AUTOMATION_FAILED`/`PATTERN_UNSUPPORTED`/`MODULE_NOT_FOUND`/`UNKNOWN_FUNCTION`/`INVALID_JSON` …）全部塌缩为同一码 → **Skill/Agent 失去按错误码路由的能力**：
「`CLI_NOT_FOUND` → 先装应用」「`PATH_NOT_FOUND` → 换白名单目录」「`TIMEOUT` → 调大 `timeoutMs`」三种完全不同的补救动作不可区分。**这直接违背本变更的首要目标**（让 Skill 指引在真机上真正跑通）。

**修复设计（勿把 35 个领域码塞进契约联合类型）**：

1. `packages/contracts/src/errors.ts`：`BridgeError` 增可选 `readonly reason?: string`；`makeError(code, message, options?)` 的 options 增 `reason?: string`，仅提供时写入。**`DEFAULT_RETRYABLE` 与既有 10 码不得改动**（保持向后兼容）。
2. `packages/adapter-agent-workbuddy/src/index.ts` `toBridgeError()`：
   - `err.code` ∈ `BridgeErrorCode`（10 码）→ 原样透传；
   - `err.code` 匹配 `/^[A-Z][A-Z0-9_]{2,}$/` → 查**最小映射表**定 base code，原领域码写入 `reason`，透传 `err.details`：
     `INVALID_ARGUMENT`/`INVALID_RECT`/`INVALID_PARAMS` → `INVALID_PARAMS`；`TIMEOUT` → `TIMEOUT`；`POLICY_DENIED` → `POLICY_DENIED`；`APPROVAL_REQUIRED` → `APPROVAL_REQUIRED`；**其余一律** `EXECUTION_FAILED` + `reason`；
   - 缺失/不匹配 → `EXECUTION_FAILED` 且无 `reason`（与现状一致，防止任意字符串当码透出）。
3. 核对 `packages/vm-service/src/server.ts` 的 MCP 结果序列化完整透传 `error`（含 `reason`）——不得有字段裁剪白名单。

**约定（新增）**：错误码分两层，**契约层 `code`（10 码，决定重试/审批语义）+ 领域层 `reason`（决定具体补救动作）**。新增 psmod 错误码**只需**在 `throw` 里用规范前缀，不再需要改契约。

**验收**：见 §5 A15。

### D24 · 入参契约错误无法路由（P1 · 主理人复核阶段实证）

**现象**：Agent 按 Skill 指引执行时**最高频的失误形态**（参数名凭记忆写、漏必填项）返回的是不可路由的错误：既不说「参数错了」，也不给「正确参数」，典型后果是**原样重试同一调用**或误判为环境故障。

**真机证据**（2026-09-17，D23 修复后）：

| 调用 | `error.code` | `error.reason` | `error.message` |
|---|---|---|---|
| `storage.file.read {}`（缺必填 `path`） | `EXECUTION_FAILED` | 无 | `无法处理命令，因为一个或多个强制参数丢失:  Path。` |
| `storage.dir.manage {path, action:'list'}`（未知参数） | `EXECUTION_FAILED` | 无 | `找不到与参数名称"action"匹配的参数。` |
| `gui.window.control {windowTitle, action}`（未知 + 缺必填 `title`） | `EXECUTION_FAILED` | 无 | `找不到与参数名称"windowTitle"匹配的参数。` |

**根因**：这三类错误由 PowerShell **参数绑定**在「进入能力函数之前」抛出（`ParameterBindingException`），消息**不含 `UPPER_SNAKE:` 前缀** → `ps-bridge.ps1` 的码提取不命中 → 落到 adapter `toBridgeError()` 第 ③ 段兜底 → `code=EXECUTION_FAILED`、无 `reason`、**连 `details.exceptionType` 也丢失**（第 ③ 段未透传 details）。

**修复设计（选 Node 侧前置校验，而非 PS 侧异常分类）**，理由：
1. registry 的 `inputSchema` 已权威且全量（实测 **54/54 有 `properties`**、27 个有 `required`）；
2. 前置校验**与语言无关**，不依赖中文/英文 PS 报错文本；
3. **零桥往返**，比「让 PS 抛异常再分类」更快；
4. 能直接给出**可用参数清单**——这才是 Skill 需要的可执行信息；
5. 不会把能力函数**内部**的 PS 参数错误误判成用户输入错误（异常分类方案有此风险）。

**实现**（`packages/adapter-agent-workbuddy/src/index.ts`，`execute()` 内、策略放行之后、`bridge.call` 之前）：
1. 取能力定义的输入 schema；**无 schema 的能力跳过校验**（保持行为不变）。
2. 允许集 = `properties` 键（**含** `__approvalId` 等 `__` 前缀内部键）。
3. 收集 `unknown`（params 中不在允许集的键）与 `missing`（`required` 中缺失/为 `null`/`undefined` 的键）。
4. 任一非空 → 直接 `fail()`，**不发起桥调用**：
   `makeError('INVALID_PARAMS', msg, { reason: 'INVALID_ARGUMENT', details: { unknown, missing, allowed } })`；
   `msg` 形如 `参数校验失败：不支持的参数 action；缺少必填参数 path。该能力可用参数：path, maxBytes, asBase64。`
5. **兜底分支补 details**：`toBridgeError()` 第 ③ 段透传 `err.details`（`null`/`undefined` 时不写）——否则再次丢掉 `exceptionType`，本次排查即受此影响。

**Skill 同步**：`winvm-orchestrator` 与各域 skill 增「入参契约错误处理」段：`reason=INVALID_ARGUMENT` → **不要重试**，按 message 的「可用参数」与 `details.missing/unknown` 修正后重调；并提醒调用前先核对 tool 的 `inputSchema.required`。

**验收**：见 §5 A16。

---

## 7. 明确不纳入本变更（backlog）

| ID | 说明 | 处理 |
|---|---|---|
| D19 | 服务日志未落盘（`ConsoleLogger` 写隐藏进程 stdout → 丢失），故障不可诊断 | 单开变更：落 `%LOCALAPPDATA%/WinVMBridge/logs/` |
| D20 | `appops.state.query` 把安装器/框架宿主窗口列为「生产型应用」 | 单开变更（过滤规则） |
| — | ~~`install-vm-task.test.js` 断言陈旧（含 `-Wait`）~~ **前提已被主理人证伪**：全仓无任何测试含 `-Wait`，且该文件断言**已是新契约**（`-PassThru` + `$nodeProc.WaitForExit()`），单独跑 **8/8 通过** | **不做**（原 #13 撤销）。见下方 §7.1 |

### 7.1 A11 论断归因纠正（主理人取证）

工程师报告「全量 `tests/unit/*.test.js` → 279/280，唯一失败 = `install-vm-task.test.js` 的 `-Wait` 断言」。主理人取证后**该归因不成立**：

| 取证 | 结果 |
|---|---|
| 全仓搜索 `-Wait` | **0 命中**（`tests/unit` 下 21 个测试文件均无此断言） |
| `node --test tests/unit/install-vm-task.test.js` | **8/8 pass**（断言已是 `-PassThru` + `$nodeProc.WaitForExit()`，注释标注「现实现」） |
| **逐文件**跑完 21 个测试文件 | **21/21 文件全绿，合计 290 用例 / 0 失败** |

**结论**：不存在需要修的失败断言；「279/280」与逐文件的 290 口径也不一致，判定为**整批运行导致的假红**（`link-workspace` 的 junction symlink 污染共享 runner —— 与项目既定纪律一致：单测**必须逐文件** `node --test <file>`，绝不整批跑）。

**处置**：撤销原 #13「修陈旧断言」（避免「修」一个本就健康的断言反而引入风险）；A11 的判定口径明确为「`npm run build` 通过 + **逐文件**单测全绿」。

---

## 8. 复核第二轮追加（D25）

### D25 · `app.winget.search` 静默返回空（P1 · 比原 D16 更危险）

**现象**：`app.winget.search {query:'7zip'}` → `ok=true, data=[], warnings=[]`。而同一 VM 上直接跑 `winget search 7zip` **有 11 条真实结果**（含 `7-Zip / 7zip.7zip`）。

**危害**：原 D16 是「表头当数据行、列错位」（至少能看到东西）；现已退化为**静默空结果**——调用方会误判「winget 没有这个包」，与 D21（`app.inventory.list` 19→1 静默漏报）同属**静默错数据**，级别应视为 P1 而非 P2。

**根因（主理人二分证明，非推断）**：`packages/vm-capabilities/psmod/app.ps1:84-122` 的「定宽列解析」**逻辑不可能工作**：
1. winget 的分隔线是**一条连续长横线**（实测 98 个 `-`），不是按列分段；
2. 故 `[regex]::Matches($lines[$sepIdx], '-+')` **只得 1 个匹配** → `$cols.Count = 1`；
3. 于是每行 `$vals` 只有 1 个元素，全部命中 `if ($vals.Count -lt 3 -or -not $vals[1]) { continue }`；
4. → `$out = @()` → `ok=true + data=[]`，**且无任何告警**。

**二分证据**（`qa/probes/bisect-d16.mjs`，用真机原始输出复现）：

| 分支 | 实现 | 结果条数 |
|---|---|---|
| A | 现实现（分隔线定列） | **0**（与插件实测 `data=[]` 一致） |
| B | 改由**表头行**定列边界 | **11**，且正确解出含空格的 `name`（`Advanced Archive Password Recovery`）与 `id=7zip.7zip` |

**修复要求**：
1. **改列边界来源**：用分隔线**上一行的表头**（`Name|Id|Version|Match|Source`）中各标签的**起始索引**作为列起点，切片区间为 `[start_i, start_{i+1})`。参考实现见 `qa/probes/bisect-d16.mjs` 分支 B（已实测可用）。
2. **必须 fail-loud**：若分隔线之后**存在真实数据行**但解析得到 0 条 → **`throw 'WINGET_PARSE_FAILED: <首行原文>'`**，绝不允许 `ok=true + data=[]`。这是本缺陷的核心教训：**宁可报错，不可静默给空**。
3. 保留跳过表头行 / 分隔线行 / winget 汇总行（`N 个包匹配`、`matching`）的逻辑。

**验收**：见 §5 A17（须与**独立基线**交叉校验，不得只看插件自报 `ok`）。

> **方法论补记（主理人要求）**：D16 在工程师报告中被标为「✅ 已修」并附证据「`app.ps1:81` 按 `----` 定宽列解析（跳过表头/汇总行）」——**代码位置不是行为证据**。凡声明「已修」必须附**真机行为证据**（正例 + 边界例），否则按未修计。

---

## 9. 复核第三轮追加（D26）

### D26 · 入参契约校验不覆盖 `type` / `enum` → 类型/枚举写错仍以 `EXECUTION_FAILED` 返回（P1 · D24 的剩余缺口）

**发现路径**：主理人核对 D24 覆盖面时做了一次交叉审计——客户端的 `tools/list` 里 54 个能力**只有 27 个声明了 `required`**，故 27 个不受 D24「缺必填」保护。逐一把这 27 个映射到 psmod 函数后，**未发现 `Mandatory` 参数漏声明**（即不存在 schema 声明缺失），但审计过程暴露了真正的问题：**D24 只校验「键是否合法 / 必填是否在」，完全不校验值的类型与枚举**。

**真机证据**（2026-09-17，修复前，`qa/probes/mcp.mjs` 直调）：

| # | 调用 | schema 声明 | D24 | 实际返回 |
|---|---|---|---|---|
| 1 | `system.process.list {"top":"abc"}` | `top: integer` | 放行 | `code=EXECUTION_FAILED`，message=ˊ无法处理对参数"Top"的参数转换。无法将值"abc"转换为类型"System.Int32"ˊ |
| 2 | `system.service.control {"name":"__nope__","action":"bogus"}` | `action: enum[start,stop,restart]` | 放行 | `code=EXECUTION_FAILED`，message=ˊ不属于 ValidateSet 属性指定的集合"start,stop,restart"ˊ |

**危害**：与 D24 同族但更隐蔽——调用方（尤其 LLM provider）会把自己「参数写错」误判为「VM 执行失败」，进而重试或降级，而不是纠正入参。修复前的两例都被归到兜底支（`EXECUTION_FAILED`），因为 PS 的异常消息**没有 `UPPER_SNAKE:` 前缀**，领域码提取天然不命中。

**根因**：`packages/adapter-agent-workbuddy/src/index.ts#validateParams()`（D24 落点）只做两件事：
1. `unknown`：`params` 的键是否在 `inputSchema.properties` 的键集合内；
2. `missing`：`required` 中的键是否缺失 / 为 `null` / 为 `undefined`。

**未做**：值的 `type` 与 `enum` 校验 → 类型不符、枚举越界的参数被原样下发到 PowerShell，由其参数绑定抛出**英文/中文异常且无领域码**，最终在 `toBridgeError()` ③ 支被压成 `EXECUTION_FAILED`。

**修复要求（两层，主次分明）**：

1. **主修复（adapter 侧，不发起桥往返）**：扩展 `validateParams()`，对**已提供**的键按 `inputSchema.properties[key]` 追加两项校验：
   - `enum`：声明了 `enum` 数组且值不在其中 → 违规；
   - `type`：声明了 `type` 时校验 JSON 类型，但**必须按「PS 可强转性」判定，禁止严格 JSON 类型相等**——`integer`/`number` 应接受 JS 数字**或**整体数字形态的字符串（`"20"` 合法、`"abc"` 非法）；`boolean` 接受 `true/false` 或 `'true'/'false'`；`string` 接受字符串/数字/布尔（PS 能字符串化）；`array` 必须是数组；`object` 必须是普通对象。
   - **无 `type` 声明的字段必须跳过**（如 `system.registry.write.value`、`storage.file.write.content` 都声明为 `{}`），否则会误拒合法调用。
   - 违规时返回 `INVALID_PARAMS` + `reason='INVALID_ARGUMENT'`，`details` 至少含 `invalid: [{ key, expected, got }]`（与既有 `unknown`/`missing`/`allowed` 并列，保持向后兼容）。
   - **设计约束（关键）**：本校验的目的是「预判 PS 绑定会不会失败」，**不是**做严格 JSON Schema 校验。宁可放过可强转的形态，不可误拒 LLM 常发的 `"top":"20"` 这类字符串数字。
2. **兜底（PS 侧，纵深防御）**：`ps-bridge.ps1` 的 catch 段对 `[System.Management.Automation.ParameterBindingException]`（其子类 `ParameterBindingValidationException` 亦覆盖 ValidateSet 场景）**按异常类型**判定并重抛 `INVALID_ARGUMENT: <原消息>`。按 `DOMAIN_CODE_TO_BASE` 既有映射（`:53`）落地为 `INVALID_PARAMS` + `reason='INVALID_ARGUMENT'`，与主修复同形。**不得**用宽泛的 message 关键词匹配。

**反向对照（防误伤，必须验）**：修复后 `system.process.list {"top":20}` 与 `{"top":"20"}` **都必须成功**；`system.registry.write` 传任意类型 `value` 不得因校验被拒。

**验收**：见 §5 A18。

> **方法论补记**：本项由「统计 27 个无 `required` 能力」这一**交叉审计**触发，但真正的缺陷不在 `required` 声明上——而在校验维度的缺失。教训：**审计某个断言的覆盖面时，要连带问「这个校验总共覆盖了哪几个维度、漏了哪几个维度」**，否则容易在正确的方向上得出错误的结论（差点把「27 个能力无 required」误报为 schema 缺陷）。

### §9.1 D26 语义边界裁决（主理人，2026-09-17）

工程师在实现后主动提报两处「严格校验会引入回归」的边界，并请裁决。**裁决：采纳「按 PS 语义对齐」（方案 B）**，理由与 §9 既定设计约束一致——本校验的目的是**预判 PS 绑定会不会失败**，不是做严格 JSON Schema 校验；**我们引入的新失败模式比漏放更糟**。

| 边界 | 现象 | 方案 A（严格 JSON Schema） | **方案 B（对齐 PS，已采纳）** |
|---|---|---|---|
| `enum` vs `ValidateSet` 大小写 | PS `ValidateSet` **默认忽略大小写**，`action:'START'` 本可执行 | 拒绝 → **新增回归** | 字符串成员**忽略大小写**比较（`'bogus'` 仍拒） |
| `type:'array'` vs PS 标量提升 | PS `[string[]]$Keys` 接受标量 `'enter'` → `@('enter')` | 拒绝 → **新增回归** | 标量（string/number/boolean）视为可强转数组；**不校验 `items`**（避免新误拒） |

**主理人自认**：上一条指令中我把 `type` 定为「按可强转性」、却把 `enum` 写成「严格 `includes`」——**二者自相矛盾**，工程师指出的正是这处不一致。以本条裁决为准。

**验收增补**：A18 增加**真机**宽松探针 `system.service.control {name:'__nope__', action:'START'}` → 必须**放行到业务层**（返回 `reason=SERVICE_NOT_FOUND`），**不得**为 `INVALID_PARAMS`。选用不存在的服务名作探针：**零副作用**（不会真的启停任何服务），同时能证明「校验放行 + 请求抵达业务层」。

> **未做真机探针的部分（诚实标注）**：`type:'array'` 的标量提升**只由单测覆盖**，未加真机断言——本仓库仅两个能力含数组参数（`gui.input.keyboard.keys` / `appops.gui.produce.steps`），前者放行后会向 VM 桌面**真实发送按键**，不宜写入回归夹具；后者的审批闸与校验的相对顺序尚未实测。故该边界以单测为准，等 VM 恢复后如需真机验证再单独构造。

---

## 10. 复核第四轮追加（D27）· 记录不修

### D27 · 「隧道半死」时宿主 stdio 桥长挂起且零输出（P2 · 可用性隐患）

**现象**：VM 掉线但**宿主隧道进程仍存活**（`ssh -N -L 18443:127.0.0.1:18443` 占着监听）时，宿主侧表现为：

| 探针 | 结果 |
|---|---|
| `TCP connect 127.0.0.1:18443` | **成功**（15ms） |
| `GET /health` | **黑洞**：`http_code=000`、8s 超时（exit 28），既不响应也不 RST |
| `ssh User@172.16.100.2` | `Host is unreachable`；`ping` 100% 丢包 |
| **宿主 stdio 桥** `a2a.health` | **rc=124（被外部 40s 超时杀死）、输出 0 字节** —— 其内部预算达 **600s** |

**机制**：`ssh -L` 的本地监听会**接受** TCP，但经 SSH 转发到不可达的 VM 时**永不返回** → 对外呈现「端口连得上、请求全挂起」。宿主 stdio 桥不做隧道就绪探测，因此**无法快速失败**，调用方既拿不到错误码也拿不到进度，**无法区分「慢」与「死」**。

**危害定级 P2（与 D21/D25 同族）**：本变更已确立的教训是「**静默比报错危险**」——D21 是「静默漏报」、D25 是「静默给空」，D27 是「**静默挂起**」。三者共同点是**调用方得不到任何可路由的信号**。本轮主理人的 QA 夹具也因此连坐空转两次（各约 5 分钟、零输出），即该危害的真实复现。

**为何记录不修**：修复方向（隧道守护进程加就绪探测 / 给 stdio 桥设短超时预算 / fail-fast 至 `PROVIDER_UNAVAILABLE`）**不属于本次变更的验证范围**，且 VM 掉线期间**无法验证修复效果**。故记入 backlog，待 VM 可用且隧道实现对范围内时再做。

**已采纳的缓解（本变更内）**：`qa-verify.mjs` 的桥初始化改为**惰性 + 非致命**（`AbortSignal.timeout` + `BRIDGE_UNREACHABLE` 标记），使夹具在隧道半死时**8 秒内**给出明确结论而非长挂起——可作为未来 stdio 桥改造的参照实现。`d26-deploy-verify.mjs` 亦已带**有界探测**（`AbortController` 硬超时，黑洞态实测 214ms 返回 false）与**陈旧隧道幂等清理**。

**补充实测（2026-09-17 深夜：黑洞自行消失）**：该状态是**瞬态、会自愈**——ssh 客户端最终察觉对端不可达后**自行退出**，端口随即释放。实测对比：

| 探针 | 黑洞期 | 自愈后 |
|---|---|---|
| ssh 隧道进程 | PID 33148 存活 | **无** |
| `TCP 127.0.0.1:18443` | `CONNECTED` | **`ECONNREFUSED` 14ms** |
| `GET /health` | 黑洞，8s 超时（`http_code=000`） | **立即拒绝** |
| `ping` / `ssh` 到 VM | 100% 丢包 / `Host is unreachable` | 同（VM 仍未恢复） |

**对修复设计的直接影响（写清以免将来走弯路）**：
1. **危害窗口有界但长度未知**（取决于 ssh 客户端自身的 TCP 超时，可达数分钟乃至更久）→ **不能依赖传输层「最终会失败」来判活**，必须用**短超时的就绪探测**主动判定。
2. **隧道重建须同时处理两种状态**：① listener 仍在（陈旧 → 需先按 PID 清理，否则新 `ssh -L` 因端口占用 + `ExitOnForwardFailure` 直接退出）；② listener 已消失（直接新建）。两种都是常态，故清理必须是**幂等空操作**。
3. 本项由团队成员**主动复核后标注**「现象已消失、非我所杀」，并给出 `ps` / 端口 / curl 三组对照——这种「**旧结论在环境变化后主动复核**」的做法应成为惯例（避免把过期现象当现状继续排查）。
4. **关于清理后是否会有端口竞态：无。** 被 `SIGKILL` 终止的是 ssh 客户端的 **LISTEN 套接字**；**监听套接字关闭即释放端口，不进入 TIME_WAIT**（TIME_WAIT 只作用于**已建立**的连接）。故「杀掉旧隧道 → 立即新建」不存在端口占用竞态；**真正需要防的只是「旧 listener 仍然活着」这一态**，已由 PID 清理覆盖。（此项由工程师补充，确认后入档，避免将来为此白查一轮。）

> **方法论补记（证据的作用域纪律）**：本轮出现一次归因争议——「MCP 返回 `SESSION_UNAVAILABLE`/`PROVIDER_UNAVAILABLE`」实为**上一轮**（VM 在线、ps-bridge 被强杀做自愈测试）的观察，与「VM/隧道 down」是**两种不同失效模式**。教训：**每条证据都必须标注「本轮取数」或「上轮遗留」及其环境前提**，否则同一句话会在不同环境下被读成互相矛盾的结论。

---

## 11. 第五轮追加（D28）· A2A 流式委派无超时 → 宿主进程长挂死（P1 · 必修）

**现象（2026-09-18，VM 在线 + codebuddy 已登录）**：`a2a.delegate` 走 LLM 委派路径时，宿主侧**挂起约 300s**（由外部杀进程才结束）；`a2a.mjs` 因无 try/catch 导致未捕获异常冲垮整轮验收（`EXIT=1`，A5 之后 A11–A18 全部没跑）。VM 掉线态下该路径因 `TUNNEL_UNAVAILABLE` 秒回，且 codebuddy 未登录时走确定性执行器路径秒过——故此前未被暴露。

**根因（传输层，代码级确凿）**：
- `packages/core/src/transport/http-channel.ts` 的 `stream()` 异步生成器**完全没有超时 / AbortController**；同文件 `request()`（66–119 行）有完整的 `AbortController + setTimeout(()=>controller.abort(), timeoutMs)` + `AbortError→TransportError` 处理，而 `stream()` 仅在 `opts?.signal` 存在时转发，且调用链全程未传 signal。
- `packages/a2a-framework/src/client.ts` 的 `streamMessage()`（107–140 行）调用 `this.channel.stream(payload)` 时**未透传 `timeoutMs`/`signal`**。
- `packages/host-a2a-bridge/src/tools.ts` 的 `delegate`（318–330 行）虽有 `if (Date.now() > deadline){ timedOut=true; break; }` 守卫，但**只在事件到达时才求值**；当 VM 侧 A2A 服务接受 SSE 连接却**不发任何数据**（`reader.read()` 永久阻塞）时，循环永不推进，deadline 形同虚设。

**修复要求（已派 `software-engineer` 落地）**：
1. `http-channel.ts` `stream()` 签名加 `opts?: { timeoutMs?: number; signal?: AbortSignal }`，照搬 `request()` 的 `AbortController + setTimeout + AbortError→TransportError` 超时逻辑，并对 `fetch` 恒传 `signal: controller.signal`。
2. `a2a-framework/client.ts` `streamMessage()` 透传 `{ timeoutMs: opts.timeoutMs, signal: opts.signal }` 到 `channel.stream()`；并给 `getAgentCard()` 的裸 `fetch` 加 15s 自包含超时（防御 `a2a.health` 挂死）。
3. `tools.ts` `delegate` 已把 `timeoutMs` 塞进 `streamOpts`（301–307 行），**无需改动**；其 deadline 守卫保留为二级兜底。
4. 夹具侧：`a2a.mjs` 的 `rpc()` 已在上一轮加 try/catch 干净退出（`.catch()` 输出 `A2A_BRIDGE_FAILED` + `exit(0)`），避免未捕获异常冲垮整轮；`qa-verify.mjs` 顶部 `ensureTunnel()` 自举隧道、`A5 runA2a` 包 try/catch——均已落地。

**状态**：✅ 已修复。`software-engineer` 落地 4 文件（含 `packages/core/src/transport/types.ts` 接口加 `timeoutMs`）→ `npm run build` 全绿（0 错误）；重建 dist md5：`packages/core/dist/transport/http-channel.js=14b7c1e3aac90036e948a13409ecae99`、`packages/a2a-framework/dist/client.js=5f69fc8bbf2cf64633cd609ffe7fc415`。**不依赖 VM 的运行期复现已通过**（`qa/probes/d28-stream-timeout-repro.mjs`：本地起「回 SSE 头但永不发数据」服务器复现挂死，断言 `stream()` 在 `timeoutMs` 内抛 `TransportError: 请求超时` 并干净退出，实测 1508ms/1500ms、`EXIT=0`）。待 VM 在线后随 `d26-deploy-verify.mjs` 重新部署，并由 `software-qa-engineer` 用**受控 A2A 探针**（VM 在线 + codebuddy 登录态） + 全量 `qa-verify.mjs` 复验（预期 A5：`a2a.delegate` 在 `timeoutMs` 内以 `A2A_DELEGATE_FAILED`（超时）干净返回，不再长挂死）。

---

## 12. 第六轮追加（D29）· `{"path":123}` 通过桥层校验直达业务层（P2 · 记录不修）

**现象（QA 报告）**：调用人对 storage 能力传 `{"path":123}`（数字形态路径）不被桥层入参校验拦截，直达业务层后返回 `FILE_NOT_FOUND`，误以为 123 是合法路径。

**前提更正（本轮调研证伪「path 无 type 声明」的说法）**：storage 域含 `path` 参数的能力**全部已声明 `type: 'string'`**——`packages/vm-capabilities/src/registry/definitions.ts` L143（`storage.space.analyze`）、L144（`storage.file.read`）、L146（`storage.file.delete`）、L147（`storage.file.move`）、L148（`storage.file.copy`）、L149（`storage.dir.manage`）、L150（`storage.search.query`）、L151（`storage.archive.manage`）、L152（`storage.link.manage`）。`{"path":123}` 之所以放行，根因是 `packages/adapter-agent-workbuddy/src/index.ts` L135-136 `isCoercibleTo` 的 `string` 分支**有意接受 string/number/boolean**（对齐 PowerShell `[string]` 强转语义）：

> L106-109 设计意图原文：「之所以按 **PS 可强转性** 而非 JS 严格类型判定，是因为参数最终由 PowerShell 参数绑定消费：PS 会把 `'20'` 绑定到 `[int]`、`'true'` 绑定到 `[bool]`、数字绑定到 `[string]`、**标量提升为 `[string[]]`**；而 LLM 常以字符串形式发数字。若按 JS 严格类型判，会把**合法调用误拒**，比「漏报」危害更大 —— 故本判定遵循「宁可漏报，不可误报」原则。」

**真正无 `type` 声明的仅两处，且均为有意为之**（`definitions.ts`）：L118 `system.registry.write` 的 `value: {}`、L145 `storage.file.write` 的 `content: {}`（大文本参数故意不约束类型，`index.ts` L631 注释明示「如 `storage.file.write.content`」）。

**裁决（采纳工程师调研结论 C：记录不修）**：
1. **补 `type:'string'` 声明形同虚设**——`path` 本就带声明仍放行（`checkParamValue` → `isCoercibleTo('string', 123)` → true），给 content/value 补声明同样不拦数字形态。
2. **不得按 D26 语义边界裁决 B 收紧**：PS 对 `[string]$Path` 传 123 会强转成 `"123"` 绑定成功，误拒 `{"path":123}` 与误拒 `{"top":"20"}` 同属「我们自己引入的新失败模式」（L88-89 原话），违反「宁可放过可强转形态，不可误拒 LLM 常发形态」红线。
3. **实际后果可控**：`"123"` 会被 PS 当路径名查找 → 返回 `FILE_NOT_FOUND`（领域码、可路由），不存在 D24 所指的「无法路由」问题，仅错误码不如 `INVALID_PARAMS` 精确。

**未来方向（本轮不实现）**：错误呈现层 hint 增强——在 `FILE_NOT_FOUND` 回包附提示「path 应为路径字符串（当前收到 number）」，而非收紧校验。校验层语义保持与 PS 绑定同宽，不再改动。

---

## 13. 第六轮追加（D31）· ps-bridge 重生风暴致 vm-service 监听消失（P2 · 记录不修）

**现象（19:49 事故，QA-REPORT-e1.md 附录 C）**：A3 第三次强杀 ps-bridge 后，ps-bridge 进入**重生风暴**（密集自愈重启），vm-service 的 18443 监听随之消失、服务死亡。疑似与 VM 侧 codebuddy A2A 委派负载并发相关（自愈重启窗口恰逢委派流量）。

**裁决（本轮不修）**：复现条件复杂（强杀时机 × 委派负载并发），需专门构造复现实验（受控强杀节奏 + A2A 并发压测）定位重生风暴与监听消失的因果链后再修。在此之前，运维上以「重启 `WinVMBridge.Service` + `start-hidden`」为恢复手段。后续若复现成功，优先排查方向：ps-bridge 自愈计数退避缺失（无指数退避 → 重启风暴）、bridge.call 在 ps-bridge 死亡窗口的并发重入。

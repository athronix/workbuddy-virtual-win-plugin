# Phase0 文档止血 notes（P0-5 · 任务 #3）

| 项 | 值 |
|---|---|
| 执行人 | 许清楚（software-product-manager） |
| 日期 | 2026-10-08 |
| 依据 | `docs/audit/2026-10-08-product-audit.md` PM-03/PM-04、owner 批准的止血口径 |
| 原则 | **只改文档口径，不新增能力实现**；一切能力名实以 `packages/vm-capabilities/src/registry/definitions.ts` 当前 54 条注册表为准 |
| 范围外 | `docs/audit/` 五份报告（历史记录）；`packages/`、`delivery/` 源码；`.workbuddy/memory/`；`C:/WinVMBridge/`（gitignore 的裸跑物化证据，见 §10）；qa/ 归档 |

## 0. 盘点结论（改动前事实）

**注册表实况（definitions.ts，54 条）**：meta 3 / system 14 / app 8 / storage 13 / gui 11 / appops 5。
幽灵 7 条全部不在册。文档侧幽灵 ID 裸引用（排除 audit 与 gitignore 物化目录）命中：

1. `docs/02-design/CAPABILITY-MODEL.md`（:56,:91,:93,:161,:223-225）
2. `docs/02-design/INTERFACES.md`（:43）
3. `docs/05-peripherals/SCENARIOS.md`（:15,:118,:224,:315）
4. `skills/winvm-gui-automation/SKILL.md`（:111）
5. `skills/winvm-app-operation/SKILL.md`（:120）

文本面（非 ID）幽灵引用：README.md §2.2、SPEC-SKILLS.md §2/§4.1、USER-MANUAL.md §1（"装更新"）、
`winvm-system-admin`（"电源与更新"）、`winvm-app-manager`（"启动与激活"）、`winvm-orchestrator`（"默认程序"）等——同属"对外教用户调用幽灵能力"，一并止血。

**重要盘点发现**：仓库 `skills/*.md` 与 connector 侧 `/storage/Users/currentUser/.workbuddy/connectors/skills/connector-winvm/*/SKILL.md` 经逐文件 `diff` 验证**当前逐字节相同**（与任务书"有差异的独立副本"描述不符——以实测为准）。因此采用"仓库侧编辑 → cp 同步 connector 侧 → diff 校验 SAME"策略，保证两侧同口径。

**幽灵能力处置裁量**（7 条）：

| 幽灵 ID | 处置 | 理由 |
|---|---|---|
| `system.update.manage` | 摘除主册 → 标 **V2 规划·当前不可用** | 纯 roadmap（PM-07/NP 未排期），无在册场景依赖 |
| `app.process.activate` | **摘除**（不再单列规划） | 功能面已被注册能力 `gui.window.control {state:"activate"}` 覆盖，文档需指向真实入口，留"幽灵名"只会诱导错调 |
| `app.default.manage` | 摘除主册 → 标 **V2 规划·当前不可用** | 纯 roadmap；无场景门面依赖 |
| `gui.browser.control` | 摘除主册 → 标 **V2 规划·当前不可用**，**并重写场景 C/E 文本**改走已注册能力（`app.process.launch` + `gui.*` 原语 + `appops.gui.produce`） | 场景门面主能力（影响最大），owner 口径：必须摘除或改写场景文本——两者都做 |
| `meta.audit.query` | 摘除主册 → 标 **V2 规划·当前不可用** | 纯 roadmap（PM-06/NP-06 明确列为后续项） |
| `meta.policy.describe` | 摘除主册 → 标 **V2 规划·当前不可用** | 同上（PM-06） |
| `meta.task.status` | 摘除主册 → 标 **V2 规划·当前不可用** | A2A 侧已有 `tasks/get` 协议查询（INTERFACES §A2A），能力面属 roadmap |

**名实不符**（owner 口径 6 条含 clipboard；实测 CAPABILITY-MODEL 背离面更多，全部如实化，超出部分一并记录）：

| 条目 | 文档原口径 | 注册表实况 | 处置 |
|---|---|---|---|
| `gui.clipboard.manage` | 剪贴板读/写（入参含 text） | 只绑 `Get-ClipboardText`，只读 | 改"只读"；写侧标 **已实现待挂载**（`gui.ps1 Set-ClipboardTextValue`） |
| `system.env.manage` | 环境变量读写 | 只绑 `Get-EnvironmentVariableInfo` | 改"只读"；写侧标 **已实现待挂载**（`system.ps1 Set-EnvironmentVariableInfo`） |
| `storage.archive.manage` | 压缩/解压 | 只绑 `New-ZipArchiveItem` | 改"仅压缩"；解压标 **已实现待挂载**（`storage.ps1 Expand-ZipArchiveItem`） |
| `app.shortcut.manage` | 快捷方式增删改 / "读取或创建" | 只绑 `Get-ShortcutInfo` | 改"只读"；创建标 **已实现待挂载**（`app.ps1 New-ShortcutItem`） |
| `system.task.scheduled` | L2 增删改查 | L0 只绑 `Get-ScheduledTaskInfo` | 改"L0 查询（写侧 V2）" |
| `system.network.config` | L2 查看与配置 | L0 只读查询 | 改"L0 查询（配置侧 V2）" |
| `system.user.manage` | L2 本地用户与组 | L0 只读查询 | 改"L0 查询（写侧 V2）" |
| `app.appx.manage` | L2 UWP 包安装/移除 | L0 只绑 `Get-AppxPackageInfo` | 改"L0 查询（安装/移除 V2）"；移除替代路径：`app.winget.uninstall` |
| `storage.recycle.manage` | L2 回收站查看与清空 | L0 只查看 | 改"L0 查看（清空 V2）" |
| `storage.dir.manage` | L2（删）/L1（建）创建/删除目录 | L1 仅创建 | 改"L1 创建"；删除走 `storage.file.delete` |
| `gui.window.control` | 置顶/移动/最大化/关闭/移动/改尺寸 | state 枚举仅 minimize/maximize/restore/close/activate | 按枚举如实化 |
| `gui.wait.condition` | 窗口出现/图像稳定/进程退出/元素存在 | 枚举 windowExists/windowGone/processExited/screenStable | 按枚举如实化 |

**已实现未挂载（4 条，psmod 有函数、注册表无调用点）**：`Set-EnvironmentVariableInfo`、`Expand-ZipArchiveItem`、`New-ShortcutItem`、`Set-ClipboardTextValue`。文档处置 = 在上表对应条目就地标注"已实现待挂载"（不新增能力条目、不动 definitions.ts——挂载归工程师）。

**meta 域补正**：CAPABILITY-MODEL §5 与 INTERFACES §2.3 均漏列已注册的 `meta.session.status`，一并补上（文档追随注册表）。

---

## 1. docs/02-design/CAPABILITY-MODEL.md ✅（v1.3→v1.4）

改动摘要：
- 头部版本行升 v1.4，标注"最后对账 definitions.ts 54 条"（响应 ARCH-14 对账要求）。
- §3.1：`system.task.scheduled` L2 增删改查→**L0 查询（写侧 V2）**；`system.network.config` L2→**L0 查询**；`system.user.manage` L2→**L0 查询（写侧 V2）**；`system.env.manage` "读写"→**L1 读取**（指向新增 §3.1.2）；**`system.update.manage` 整行摘除**→表后注记「V2 规划·当前不可用」（原句：`| system.update.manage | Windows 更新查看与安装 | L2 | PSWindowsUpdate / UsoClient |`）。
- 新增 **§3.1.2 名实口径与"已实现待挂载"**：4 条死代码函数（Set-EnvironmentVariableInfo / Expand-ZipArchiveItem / New-ShortcutItem / Set-ClipboardTextValue）逐条标注，含"传写侧参数不产生写入、不得向用户宣称已写"的调用方禁令。
- §3.2：`app.shortcut.manage` 增删改→**读取**；`app.appx.manage` L2 安装/移除→**L0 查询**（替代路径 `app.winget.uninstall`）；**`app.process.activate` 摘除**（原句：`| app.process.activate | 激活已运行窗口 | L0 | AppActivate |`；处置=改指已注册 `gui.window.control {state:"activate"}`，不留幽灵名）；**`app.default.manage` 摘除**（原句：`| app.default.manage | 默认程序关联 | L2 | 注册表 UserChoice |`；标 V2）。
- §3.3：`storage.dir.manage` 创建/删除→**L1 仅创建**（删除指到 `storage.file.delete`）；`storage.archive.manage` 压缩/解压→**L1 仅创建 zip**；`storage.recycle.manage` L2 查看与清空→**L0 查看（清空 V2）**。
- §3.4：`gui.window.control` 摘掉"置顶/移动/改尺寸"（按 state 枚举如实化）；`gui.clipboard.manage` 读/写→**只读**；`gui.wait.condition` 摘掉"元素存在"（按枚举如实化，标 V2）；**`gui.browser.control` 整行摘除**（原句：`| gui.browser.control | 浏览器自动化（导航/点击/填表/截图/取 DOM） | L1 | CDP over WebSocket… |`），表后注记「V2 规划·当前不可用」+ 给出**当前可用组合路径**（app.process.launch → gui.session/screen → gui.uia.* → gui.input.* → gui.wait → capture / appops.gui.produce）。
- §5：`meta.audit.query` / `meta.policy.describe` / `meta.task.status` 三行摘除（原句见 §5 旧表），补列已注册 `meta.session.status`，注记三条标「V2 规划·当前不可用」及替代路径（audit jsonl 文件 / /health chainValid / 读 defaults.ts / A2A tasks/get）。
- §2 示例行 `system.service.start`（不存在）改为已注册 `system.service.control`，`storage.disk.analyze`→`storage.space.analyze`。

## 2. docs/02-design/INTERFACES.md ✅

- §2.3：`meta.*` 五项清单修正为已注册 3 项；补 §3.5 appops 行；各项计数按注册表修正（15→14、10→8、12→11）；加注"以 definitions.ts 54 条为唯一事实源 + 2026-10-08 对账记录"（原句：`| meta.* | meta.health.check、meta.capability.list、meta.audit.query、meta.policy.describe、meta.task.status |`）。
- Agent Card 样例（§A2A）：app 描述"启动激活…UWP"→"启动应用、快捷方式（读取）、UWP（查询）"；gui 描述"…浏览器自动化"→"剪贴板（只读）、等待条件"。

## 3. docs/05-peripherals/SCENARIOS.md ✅

- 场景总览表 C 行：关键能力域 `gui.browser.control + appops.gui.produce` → `gui.* 原语（截图/UIA/键鼠）+ appops.gui.produce`（原句：`| C. 网页端生产 | 半确定（需看屏决策） | A2A 委派 | gui.browser.control + appops.gui.produce | 否（确定性可枚举）|`）。
- 场景 C 流程图：`gui.browser.control(CDP): 导航登录` → `app.process.launch 打开浏览器并导航 + gui.uia.*/gui.input.keyboard 登录`，loop 内补 `gui.wait.condition(screenStable)`；流程后加注"CDP 直驱当前未注册（V2），以已注册原语组合实现，落地后可无缝升级"。
- 场景 E 流程①：`gui.browser.control 抓 3 个竞品首页` → `app.process.launch + gui.* 原语…抓 3 个竞品首页`。
- §H 速查表：`gui.browser.control` 行 → 改为 `gui.uia.tree/invoke + gui.input.*`（注 CDP 为 V2 规划·当前不可用）。
- C 场景 A2A demo 的 `allowedCapabilities: ["gui.*","appops.gui.produce","storage.*"]` 为通配且全部在册，未动。
- §F 监管流程图：`可 --audit verify 校验完整性`（不存在的 CLI）→ 改为 `GET /health 的 chainValid 校验 + 读 audit/*.jsonl`，并注明 `--audit` CLI 与 `meta.audit.query` 均为 V2（原句：``可 `--audit verify` 校验完整性``）。

## 4. docs/05-peripherals/USER-MANUAL.md ✅（幽灵能力文本面 + 不存在的 CLI）

- §1 能力表：`winvm-system-admin` 行删"装更新"（幽灵面），改注"Windows 更新管理当前不可用（V2 规划）"（原句：`查系统/服务/进程/事件日志/注册表、重启服务、装更新`）；`winvm-app-manager` 行删"启/停应用"歧义（停无对应能力），改"列出/安装/卸载/升级/启动应用…；结束进程走 `system.process.terminate`"；`winvm-storage-manager` 行删"配额/去重"（三份能力清单均无条目，PM-04 附带发现），改"磁盘/分区/卷/文件/回收站（查看）的查询与整理"。
- §5 审计与回放：摘除两条**不存在的命令**示例 `node packages/vm-service/dist/cli.js --audit tail 50 / --audit verify`（实测 cli.ts 仅 `--config/--port/--host/--self-test/--help`，PM-06 证实），改为"SSH 读 jsonl + /health chainValid"的当前真实路径，并显式警示 CLI 无 `--audit` 子命令、`meta.audit.query` 属 V2。审计条目字段说明保留。

## 5. docs/02-design/SPEC-SKILLS.md ✅（Skill 规范册文本面）

- §2 清单表 2/3/4/5 行：同步 system（查询/读取括注 + 更新 V2）、app（启动激活→启动、快捷方式/默认程序/UWP 如实化）、storage（压缩→仅创建 zip、回收站→查看）、gui（剪贴板→只读、浏览器自动化→UIA+键鼠、CDP V2）。
- §4.1 领域路由表四行：与 orchestrator SKILL 同口径加括注（原句：`| 安装/卸载/升级/启动应用/快捷方式/默认程序 | winvm-app-manager |` 等）。

## 6. README.md ✅

- §2.2 五域覆盖表：同 USER-MANUAL 口径逐行如实化（更新/激活/默认程序/解压/置顶/浏览器自动化全部改为已注册表述或标 V2 不可用）。
- §9.4 "每域 5–8 个工具"与实数不符（PM-14 口径债）→ 改为注册表实数"54 个能力，meta 3 / system 14 / app 8 / storage 13 / gui 11 / appops 5，以 definitions.ts 为准"（原句：`五大模块当前为代表性能力集（每域 5–8 个工具）`）。

## 7. skills/winvm-gui-automation/SKILL.md ✅（重灾区，体检 J5 点名）

- frontmatter description：删"浏览器自动化"承诺，改"剪贴板（只读）；网页操作经 UIA+键鼠（CDP 直驱为 V2 规划·当前不可用）"。
- §能力清单：`gui.clipboard.manage` "读写剪贴板"→"**只读**剪贴板文本"。
- §浏览器自动化整节重写：原句 `gui.browser.control 通过 CDP（Chrome DevTools Protocol）驱动 Chrome/Edge。能力：导航、点击、填表、截图、取 DOM。`→ 改为⚠警示（当前未注册、不可调用）+ 已注册能力五步组合流程（app.process.launch→uia.tree→uia.invoke/input→wait→capture）+ "不要向用户承诺取 DOM/浏览器自动化"。
- §高危清单：`gui.clipboard.manage 写入` 行→读取行（脱敏要求）。
- §已知陷阱：原句 `剪贴板读到的可能是旧内容：写入后稍等再读`→改"剪贴板当前只读，入参 text 不生效（写侧已实现待挂载），需粘贴改用键盘输入或请用户手工复制"。

## 8. skills/winvm-app-operation/SKILL.md ✅（重灾区之二，体检 J5/FR-306 点名）

- §浏览器（网页端生产）：原句 `- 优先 gui.browser.control（CDP）做导航/点击/填表/取 DOM；`→ 改为⚠警示 + 已注册组合（app.process.launch 导航 / gui.uia.* 定位填表 / 坐标兜底 / appops.gui.produce 序列 / screen.capture 存档）。

## 9. skills/winvm-system-admin / winvm-app-manager / winvm-storage-manager / winvm-orchestrator ✅

- **system-admin**：description"电源与更新"→"电源；更新管理当前不可用（V2）"；§适用面补写侧限制（计划任务/网络/用户只读、env 只读）；§不适用新增首条"Windows 更新管理未注册不可调用，如实告知+建议人工 Windows Update"；能力清单 `system.env.manage`"读写"→"只读（写入待挂载）"（原句：`| system.env.manage | L1 | 读写用户/系统环境变量 |`）；已知陷阱"改 Machine 通常需管理员权限"→"只读，不要宣称已设置"。（task.scheduled/network/user 清单行原本已是 L0 查询口径，未动。）
- **app-manager**：description"启动与激活…管理快捷方式与 UWP 包"→"启动应用（激活窗口经 gui.window.control）…读取快捷方式与 UWP 包查询；默认程序当前不可用（V2）"；§不适用新增三条：默认程序未注册（人工"设置→默认应用"）、快捷方式创建不可用、激活窗口改用 `gui.window.control {state:"activate"}`（明示"本域无 app.process.activate"）；能力清单 shortcut/appx 两行如实化；§"创建 / 读取快捷方式"整节改为"读取快捷方式（当前只读）"，删除创建示例与原契约句（原句：`提供了 targetPath → 创建/覆盖该 .lnk；未提供 targetPath → 按读取处理`），改为"传写侧参数不产生写入；用户要建快捷方式时如实说明/改走审批 CLI/人工——不要静默声称成功"。
- **storage-manager**：description 标注解压与清空不可用；能力清单 archive（仅创建）/recycle（清空不可用 V2）两行如实化；已知陷阱两条改写（原句：`真正清空回收站需用户明确要求并单独审批`→清空当前不可用+人工/逐项 delete；archive 补充"解压函数 Expand-ZipArchiveItem 已实现待挂载，可改走 appops.cli.invoke(powershell) Expand-Archive 审批替代——不要静默声称已解压"）。
- **orchestrator**：§领域路由表四行加括注（计划任务查询/网络查询/用户查询/环境变量读取；默认程序路由到 app 但标当前不可用；压缩仅创建 zip；回收站查看；剪贴板只读；浏览器经 UIA+键鼠、CDP V2）。:178"打开浏览器登录某网站→A2A"为意图描述非能力名，可用组合路径存在，保留。

## 10. connector 侧同步（/storage/Users/currentUser/.workbuddy/connectors/skills/connector-winvm/）✅

盘点实测：connector 9 个 SKILL.md 与仓库 skills/ **逐字节相同**（`diff -q` 全 SAME；与任务书"独立副本有差异"预期不符——以实测为准）。同步方式：仓库侧编辑完成后 `cp` 覆盖 + `diff` 校验，6 个受影响文件全部 SAME：
winvm-system-admin / winvm-app-manager / winvm-storage-manager / winvm-gui-automation / winvm-app-operation / winvm-orchestrator。
未改动 3 个：winvm-mcp-reference（含 references/mcps-reference.md，无幽灵引用）、winvm-orchestrator/references/approval-card.md（"回收站还原"指 OS 行为，非能力承诺）。
connector 侧 grep 复核：幽灵 ID 仅存于"⚠ 当前未注册/V2 规划"标注段，零裸引用。

**其他副本面盘点**：
- `plugins/cache/winvm/winvm-bridge/0.1.0/`：仅部署脚本（无 SKILL.md），无需改。
- 仓库 `C:/WinVMBridge/shared-skills/`（2 文件命中幽灵）：`.gitignore` 明确列为"鸿蒙宿主裸跑盘符路径物化"的**证据目录（保留不删）**，非活部署面（真正的 VM 侧共享根在 VM 内 `C:\WinVMBridge\shared-skills`，本机不可达）。列入遗留项交主理人/工程师走 `deploy-shared-skills.mjs --publish-from` 在 VM 侧重发布。
- `.workbuddy/memory/*.md`：工作日志/历史叙事，非对外文档，不改（同 audit 原则）。
- `qa/archive/.e2e-backup-*.tar.gz`：gitignore 归档，不触碰。

## 11. docs/02-design/REQUIREMENTS.md ✅（需求池，加口径注记不删需求）

- §2.2 表格前新增"口径注记（2026-10-08 止血）"：声明 FR-201~204 各行是**需求面**而非"当前可用清单"，
  当前兑现面以 definitions.ts 54 条 + CAPABILITY-MODEL §3 为准，未注册项对用户一律"当前不可用
  （V2 规划/待挂载）"。FR 行本体保留（需求文档记录应有意图，止血口径不动需求池只动能力文档/Skill）。

## 12. 自查结果（IS_PASS）

- `grep -rE "7 条幽灵 ID" docs skills README.md overview.md`（排除 docs/audit/）：命中全部位于"V2 规划·当前不可用/已摘除/未注册"标注句或本 notes 文件内，**零裸引用** → 达标。
- connector 侧同 pattern：仅标注句 → 达标。
- 7 幽灵处置：6 条标 V2 摘除（update/activate→改指 gui.window.control/default/browser(重写场景C/E)/audit/policy/task.status）✔
- 名实不符 12 条如实化（owner 6 条含 clipboard + 同族 6 条）✔；写侧死代码 4 条均标"已实现待挂载"✔
- 顺带清偿：meta.session.status 补列、INTERFACES 计数、README"5–8 工具"、USER-MANUAL/SCENARIOS 假 CLI `--audit`、示例 ID `system.service.start`。
- **IS_PASS: YES**

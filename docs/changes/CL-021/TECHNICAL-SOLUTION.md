# CL-021 · 技术方案（TECHNICAL-SOLUTION）

> 对应 `REQUIREMENT.md`。含 **R3/K6 卸载核验状态机**、**R1 审批卡两段式渲染**、**R2 只读诊断与安装自检**、**T02b 超时链**四组改动的设计要点、关键代码锚点、数据流、风险与回滚、以及可复跑的验证命令。
> 全部行号锚点以 CL-021 收尾提交 `a3308ae` 为准；因后续变更集产生漂移的，另行标注「当前 HEAD」实测值。

---

## 0. 总览：三组改动在架构中的位置

```
宿主 WorkBuddy                      │              VM（Windows）
────────────────────────────────────┼──────────────────────────────────────────
L2 Renderer                         │  vm-capabilities
  adapter-host-workbuddy/           │    psmod/app.ps1          ← R3 状态机 ★
    src/approval-card.ts      ★ R1  │    src/registry/
    src/index.ts (plan 注入)        │      definitions.ts  ★ R3 契约
        │ 产物写进 skill references │
        ▼                           │  adapter-agent-workbuddy
skills/winvm-orchestrator/          │    src/index.ts  ★ T02b 超时取值
  SKILL.md（门禁：show_widget →     │        │ bridge.call(mod, fn, params, timeoutMs)
  AskUserQuestion → reply）         │        ▼ ps-bridge → app.ps1
  references/approval-card.md v1.1  │
                                    │
delivery/                           │
  tools/diagnose-connectors.mjs ★ R2│
  install-host.mjs（末尾自检）  ★ R2│
```

**本轮零新增包、零新增进程**（沿用既有分层：L0 contracts → L1 host-sdk/core → L1.5 host-a2a-bridge → L2 Renderer → skills 产物 → delivery）。

---

## A 项 · R3/K6 卸载核验状态机（T01 契约 + T02 能力层）

### A.1 设计原则

| 原则 | 说明 |
|---|---|
| **核验才是事实** | `success` 由「exit code」改为「**卸载后的磁盘/注册表核验**」；winget 自述成功不再可信 |
| **失败也要真** | 核验失败 ⇒ `success=false` + `residualEvidence`（残留 exe / 目录 / 键，**单串**，见回执契约）；宿主必须如实转呈，不得改写为成功 |
| **绝不误伤 MSI** | 回退触发条件被收窄到「注册表键**明确**为 NSIS」；MSI / other / unknown 一律不回退 |
| **dry-run 语义不变** | `$DryRun` 时不做核验也不回退，`verified=null, fallbackUsed=false`（免审批语义保持） |

### A.2 回执契约变更（破坏性字段，消费者全清单）

```ts
// 旧回执（app.ps1 产出，经 ps-bridge 透传为能力结果）
{ id, dryRun, exitCode, success /* = exitCode === 0 */, output }

// 新回执（CL-021）
{ id, dryRun, exitCode, success, verified, fallbackUsed, output, residualEvidence? }

// verified: {
//   exeGone: boolean,                // 可执行文件是否消失
//   dirGone: boolean | null,         // 安装目录是否消失（无法派生 InstallLocation 时为 null，三态）
//   registryGone: boolean,           // 卸载注册表键是否消失
//   installLocation?: string,        // 仅派生成功时出现（契约 optional）
//   installerType: 'nsis' | 'msi' | 'other' | 'unknown'
// }
// success 以最终核验为准；dryRun ⇒ verified=null, fallbackUsed=false
// residualEvidence: string          // 仅失败时出现（契约 optional），单串
```

| # | 消费者 | 文件 | 本轮处置 |
|---|---|---|---|
| 1 | 能力注册表 output schema / 描述 | `packages/vm-capabilities/src/registry/definitions.ts`（`:172-222` 区） | **必改**（T01）：schema 增 `verified` / `fallbackUsed`；描述补核验语义与 600s 预算 |
| 2 | PS 侧产出源 | `packages/vm-capabilities/psmod/app.ps1`（`:505-853` 区） | **必改**（T02）：回执构造 + 状态机 |
| 3 | 透传层 | `packages/vm-capabilities/src/ps-bridge.ts` | **复核→零改动**（回执为动态对象透传） |
| 4 | 宿主 skill 文档语义 | `skills/winvm-orchestrator/SKILL.md` 及各 app 能力 skill | **复核**：旧 skills 从未出现 `exitCode=0 即成功` 类可漂移口径（grep 零命中）⇒ 不构成回归；缺口记为 F-2（见 `QA-REPORT.md` §4） |
| 5 | 设计文档 | `docs/02-design/CAPABILITY-MODEL.md` | **必改**：§3.2.1 升 v1.1 |
| 6 | 测试 | `tests/unit/r3-uninstall-verify.test.js`（新增）；`cl017-winget-parse` 等既有 winget 测试 | 既有断言仅覆盖 search/install 路径 ⇒ 零改动 |
| 7 | 审计链路 | 宿主侧 `approval-audit.ts` | 走 `previewHash`，不消费回执字段 ⇒ 零改动 |

### A.3 A5 勘误：R-0 entry **预捕获先于 winget**（`0d7f58c` 回写）

> 这是本组最容易退化的细节，**实现与评审必须按此顺序**。

**为什么必须前置**：真卸载成功后，注册表 `Uninstall` 键**随即消失**。若把 `Get-PackageUninstallEntry` 放在 `exitCode=0` 之后：
- 取不到 `InstallLocation` / `UninstallString` / `QuietUninstallString`；
- `installerType` 被误降级为 `unknown`，`dirGone` 退化为 `null`；
- ⇒ **把一次真成功核验成「无法判定」**。假失败与假成功同样是假，与 R3 的「以最终核验为准」目标相反。

**勘误后顺序**（`packages/vm-capabilities/psmod/app.ps1`）：

```
Uninstall-WingetPackage(Id, DryRun)
  ├─ DryRun        → winget uninstall --dry-run ⇒ { verified: null, fallbackUsed: false }
  └─ 正常卸载
       ├─【R-0 预捕获】Get-PackageUninstallEntry(Id)      ← 必须先于 winget
       │     HKLM / HKLM-WOW6432Node / HKCU 卸载键匹配
       │     ⇒ InstallLocation / UninstallString / QuietUninstallString
       ├─ winget uninstall --id <Id>                       （≤300s 软预算）
       ├─ exitCode ≠ 0 → { success:false, verified=由预捕获 entry 构造, fallbackUsed:false }
       └─ exitCode = 0
             ├─ 派生核验目标：InstallLocation → 缺失则按 UninstallString 去引号去参数后
             │                 取目录**反推**安装根（MSI 型禁止反推）
             │                 → 仍缺失 ⇒ dirGone = null（只做注册表核验）
             ├─ Test-UninstallState：exeGone / dirGone / registryGone（≤30s；≤30s 为本地
             │     stat + registry 读取，实际秒级）+ installerType
             ├─ 全通过              → { success:true, verified, fallbackUsed:false }
             ├─ 失败 且 installerType='nsis'（Uninstall.exe 且无 QuietUninstallString）
             │     → Invoke-NsisSilentFallback：Uninstall.exe /S -Wait（≤240s）
             │     → 再核验 Test-UninstallState
             │        ├ 通过 → { success:true, verified, fallbackUsed:true }
             │        └ 仍失败 → { success:false, verified, fallbackUsed:true, residualEvidence }
             └─ 失败 且 installerType ≠ 'nsis' → { success:false, fallbackUsed:false, residualEvidence }
```

**与单测夹具同构**：`tests/unit/r3-uninstall-verify.test.js` 的三参数分离（`entry` / `disk` / `registryKeyExists`）正是该时序的等价镜像 —— `entry` 是**卸载前的事实**，后两者是**卸载后的观测**。

### A.4 PS 侧静态结构佐证（沙箱无 PowerShell，行为验证归真机）

QA 在剥离字符串与注释后的 Tokens 上做了结构核算（`r17-qa-2026-09-30.md` §3）：

| 检查 | 实测 |
|---|---|
| 大括号配平 | **0**（最低点 0） |
| 圆括号配平 | **0** |
| 函数重名 | **25 个函数，零重名** |
| `Uninstall-WingetPackage` 存在 | ✅ |
| `R-1 … R-8` 函数族 | **13 个齐备**（与 r3 守卫「函数头标注 R 编号」互证） |

---

## B 项 · R1 审批卡两段式原生渲染（T03）

### B.1 为什么不「插件画布」，为什么是「两段式」

| 候选机制 | 可行性 | 结论 |
|---|---|---|
| `show_widget`（会话内 HTML/SVG 可视组件） | ✅ 宿主 agent 工具面原生提供；自包含 HTML 片段（无 `<html>/<head>/<body>`） | **主选：视觉载体** |
| `AskUserQuestion`（结构化二选一） | ✅ 答案**结构化、不可被措辞稀释** | **主选：权威收口** |
| interactive widget 按钮直调 MCP 工具 | ❌ WB 未提供 widget→MCP 回调的运行时权限 | 否决（与裁定 Q2 一致） |
| 插件自定义卡片 / 插件面板 | ❌ 本插件是 MCP server + Skill 形态，无常驻 UI 进程 | 否决 |
| MCP App artifact 面板 | ⚠️ 可展示但脱离会话流、审批时效性差、无结构化交互回传 | 备选不做 |
| 纯文本转呈（`approval-card.md` v1） | ✅ 现状行为，零依赖 | **强制兜底路径**（裁定 Q1） |

**定稿**：`show_widget`（HTML 卡片，视觉）→ `AskUserQuestion`（批准/拒绝，权威）→ 宿主 agent 经工具面 `a2a.approval.reply`。任一环不可用 ⇒ **逐字降级**为 `approval-card.md` v1 文本模板。

### B.2 卡片渲染模块（`packages/adapter-host-workbuddy/src/approval-card.ts`）

新增文件（`0adcc97`）；**当前 HEAD 实测 821 行**（`wc -l` 可复核）。

**关键导出与失败码（拒卡 reason）判定链 —— 源码逐行读实测（`packages/adapter-host-workbuddy/src/approval-card.ts`）**：

```ts
// :461
function skipReasonFor(input: ApprovalCardInput | ApprovalCardApprovalLike | null | undefined): ApprovalCardSkipReason | null {
  if (input === null || input === undefined || typeof input !== 'object') return 'NO_INPUT';   // :462
  // 数组同为 typeof === 'object'，但不是合法审批载荷形态 → 归入 NO_INPUT（R18-F3）          // :463
  if (Array.isArray(input)) return 'NO_INPUT';                                                 // :464
  const raw = readRawFields(input);                                                            // :465
  if (!raw.approvalId) return 'MISSING_APPROVAL_ID';                                            // :466
  // 「没下发」与「下发了但畸形」必须分别报错（§4：风险缺失 → 不出卡并明确报错）               // :467
  if (!raw.riskGiven) return 'MISSING_RISK';                                                    // :468
  if (!RISK_VALUES.includes(raw.riskRaw)) return 'INVALID_RISK';                                // :469
  // §7：L0/L1 直接执行，不产生审批卡片与二次确认                                              // :470
  if (raw.riskRaw === 'L0' || raw.riskRaw === 'L1') return 'L0_L1_NO_CARD';                     // :471
  // 续跑途径：至少其一，否则确认后无从应答                                                     // :472
  if (!raw.resumeHint && !raw.taskId) return 'NO_RESUME_PATH';                                  // :473
  return null;                                                                                  // :474
}
```

> **F-3 补记（源���可读 + 仓库文档双痕迹）**：`:463-464` 的 `Array.isArray → 'NO_INPUT'` 分支**当前确实存在于源码**（行注释即标明 `R18-F3`），说明 CL-021 交付当时登记的 F-3 缺口**已被后续变更集消除**。该修复另有仓库文档痕迹：`.workbuddy/memory/2026-09-30.md:54` 记「`4495156` fix(R18-F3)——`skipReasonFor` … 补 `Array.isArray→NO_INPUT` … r1 测试 68→69」。**若不接受该 hash 归因，只看源码现行状态即可 —— 「CL-021 交付当时存在、现已不存在」的结论不变。**

失败码语义（`:440-453`，`:448-453` 为 union 类型字面量，共 6 个成员）：

| 码 | 含义 | 后果 |
|---|---|---|
| `NO_INPUT` | 输入缺失 / 非对象 / 数组 | 不出卡 → `null` |
| `L0_L1_NO_CARD` | **§7 不弹卡清单**：L0/L1 直接执行，**既不弹卡也不产生二次确认**（`:471`） | 独立降级码（**刻意与「文本兜底」区分** —— 它不是换种确认方式，见 `:555-557` `needsTextFallback()` 与 `:559-562` `isTextFallbackReason()`） |
| `MISSING_APPROVAL_ID` | 缺少 `approvalId`（`:466`） | 拒卡 `null` |
| `MISSING_RISK` | **风险字段未下发**（`:468`，`riskGiven` 判据）—— 与「下发了但畸形」必须分别报错（`:467` 注释） | 拒卡 `null` |
| `INVALID_RISK` | risk 非封闭字面值（L0–L3 之外，`:469`），**不得猜测归一** | 拒卡 `null` |
| `NO_RESUME_PATH` | 既无 `resumeHint` 又无 `taskId` —— 用户确认后无从应答 | 拒卡 `null` |

> **设计要点**：降级结果统一为 `fillApprovalCard(...) === null`，交由 SKILL 门禁强制走逐字降级文本模板 —— **无放行面**。

### B.3 哨兵：为什么 `MCP_RESUME_MARKER` 必须保持 v1 拼接字面

```ts
// packages/adapter-host-workbuddy/src/approval-card.ts:62
export const MCP_RESUME_MARKER: string = '__' + 'approval' + 'Id';
```

- 该标记代表 **MCP 通道续跑字段**；A2A 通道产物中**绝不允许**出现它（CL-016 通道隔离红线，详见 `docs/changes/CL-016/` 的 D2 / A3 条款）。
- 采用**拼接构造**而非字面量，使 `packages/adapter-host-workbuddy/` 的源码与 dist 中该字符串**零完整出现**，从而让「A2A 侧输出零标记」可被 grep 判据锁定。
- **硬纪律**：不得把它改写成 `__approvalId` 字面常量 —— 一旦改写，CL-016 的静态守卫（全仓该字面量命中数）会随之为 >1 而失效。
- 双向实证（QA §2a 自构反例）：喂 `resumeHint='确认后以 __approvalId 重发同一请求'` ⇒ 仍出卡但 `resumeHintSanitized=true`、产物 HTML **零标记**、续跑指令替换为本地标准 `a2a.approval.reply` 文本；反向 `approval-card.md` §9 串仍在（守卫 R1-10 pass）。

### B.4 数据与产物流向

```
host-a2a-bridge/src/tools.ts（零改动）
  extractApproval / withA2aResumeHint
      ⇒ { approvalId, risk, capabilityId, impact[], preview, resumeHint, underlying }
              │  structuredContent.approval
              ▼
adapter-host-workbuddy/src/approval-card.ts
  fillApprovalCard(input) ── 失败码 ⇒ null（SKILL 走逐字降级文本模板）
              │ 成功：七槽位 + 审批 ID + 续跑指令 ⇒ 自包含 HTML
              ▼
index.ts plan() 把 HTML 作为 reference 注入 skills/winvm-orchestrator/references/approval-card.md §10
              ▼
SKILL.md 门禁（宿主 agent 执行）
  结构化数据 → show_widget(HTML 卡) → AskUserQuestion(批准/拒绝) → a2a.approval.reply
              ▼
VM 侧 K5 服务端确定性重放（审计 -replay executed 条目）
```

---

## C 项 · R2 只读诊断与安装末尾自检（T04）

### C.1 `delivery/tools/diagnose-connectors.mjs`（新增；当前 HEAD 实测 515 行）

探测面：① `~/.workbuddy/mcp.json` 全局注册；② 各 `connectors/<account>/mcp.json` 增量注册；③ `connector-states.v3.json`（trust/enabled 态，**只读解析不写回、不解密落地**）；④ stdio 条目 `winvm-a2a` 的 command 可执行性（**只读 stat，不拉起子进程**）。输出结构化摘要（`--json`）+ 人读文本。

**只读性是可判据的**（QA §4 抽测）：import 仅 `existsSync` / `readFileSync` / `readdirSync` / `statSync` + `os.homedir` + `path.join`；剥离注释后**零写 API / 零 spawn / 零网络**（唯一命中为 banner 文案字符串）。

| 用例 | 判据 | 实测 |
|---|---|---|
| 本机直跑 | exit 0 + WARN 如实 | **EXIT=0**；WARN 两条：①账户 `8dd0df6a…` 无 winvm 条目（活跃账户不受影响）②`connector-states.v3.json` 不存在 ⇒ `state=missing` + trust/启用指引文案 |
| `--home` 指空目录 | exit 1 | **EMPTY_EXIT=1**，FAIL 两条如实（全局 `mcp.json` 缺失、stdio command 不可得）；**空目录内零文件生成** |
| 零写入 | `mcp.json` md5 不变 | 跑前后 **`49055ffb…` 一致**；`install-host --dry-run` 后再验仍一致 |

### C.2 `delivery/install-host.mjs` 末尾自检（`runConnectorSelfCheck(home, dryRun)`）

- **调用点**：安装主干末尾 —— `:1172` 起为「连接器注入自检（R17-T04 / R2-2）」注释块，`:1177` 调用 `runConnectorSelfCheck(args.home, args.dryRun)`；函数本体 `export function runConnectorSelfCheck(home, dryRun)` 在 **`:1197`**（以上行号均为当前 HEAD 直接读文件实测）。
- **dry-run 语义（本仓历史踩坑铁律）**：dry-run 下**只打印将执行什么，绝不实际 spawn** —— 诊断工具自身虽只读，但 dry-run 下连子进程都不该拉起，保持「零副作用」可核验。实测末行输出 `连接器自检 : [dry-run 将执行] …（纯只读…）`，宿主面 `find -newermt` 命中 0。
- **非致命**：任何异常（工具缺失 / 子进程异常 / 输出非 JSON / 其它 throw）仅告警并跳过，**绝不影响安装主干**；卸载相位走不到这里（`--uninstall` 提前 return）。
- 正常路径输出：`连接器自检 : 注册面就位 ✓（exit=<n>）` 或 `发现 <k> 项必需缺失 ✗`。

### C.3 文档与门禁链接

| 落点 | 内容 |
|---|---|
| `docs/INSTALL-GUIDE.md` **§8.1「连接器已注册但会话未注入工具（R2 · R17-T04）」** | 自助三步：到连接器页信任启用 → 重开新会话 → 用诊断工具验证 |
| `docs/design/r17-connector-injection-diagnosis.md` | 根因诊断报告骨架（真机探测后填充） |
| `skills/winvm-orchestrator/SKILL.md` | 「工具缺失指引」（L51-56）三步：跑只读诊断 → 指引用户启用连接器 + 重开会话 → 「严禁手写脚本绕行不变 —— 停下等待用户启用连接器，是本 Skill **唯一**允许的等待态」 |

> QA §2b 复核：**零自动批准 / 零跳过确认**被引入；「严格禁止」恰 5 条；标准执行路径四步完整。

---

## D 项 · T02b 能力超时取值链（`586c003` + `4976146`）

**问题**：K6 引入回退后，`app.winget.uninstall` 最坏耗时 = winget 300s + NSIS 回退 240s = **540s**；而 A2A 通道 metadata 只给 **300s**。旧写法 `req.timeoutMs || 30_000` 会让 600s 的能力级预算在 A2A 路径被 300s 掐断。

**为什么超时是「能力自身属性」**：`CapabilityDefinition.timeoutMs` 是 **contracts 契约必填字段**（单时间为能力的固有预算），而非调用方的临时要求；两条通道（MCP / A2A）口径必须对齐，避免同一能力两种时限。

```ts
// packages/adapter-agent-workbuddy/src/index.ts（execute 内，QA 报告 §6 记 L325）
const capTimeoutMs = impl.timeoutMs;          // implementationOf() 从注册表带出
…
: await bridge.call(impl.module, impl.fn, req.params, capTimeoutMs ?? req.timeoutMs ?? 30_000);
```

- `implementationOf()` 同源带出注册表 `timeoutMs`，并带**正的有限数守卫**（0 / 负数 / NaN ⇒ `undefined`，回落 `req`）；兜底路径不带 `timeoutMs`。
- `ps-bridge.call` 第 4 参即 `timeoutMs`（签名核对），**传参位正确**。
- K6 的 `timeoutMs=600_000`（`definitions.ts`）经注册表注入 ⇒ **600s 总预算不被 300s A2A metadata 掐断的代码路径成立**；真机不掐断实测 BLOCKED（`QA-REPORT.md` §8-④）。
- 静态守卫：`r3-uninstall-verify.test.js` 第 35 条「不得残留裸 `req.timeoutMs` 写法」；`4976146` 把守卫改为**剥离注释后**比对代码形态，避免注释中的旧写法字面量造成误报。

---

## 风险与回滚

| # | 风险 | 触发 | 缓解 | 兜底 |
|---|---|---|---|---|
| **R-A1** | NSIS 误判 ⇒ 对非 NSIS 包误触发 `/S` 回退 | 卸载键形似 NSIS | 判定三重 AND（键存在 ∧ `UninstallString` 指向 `Uninstall.exe`（大小写不敏感）∧ **无** `QuietUninstallString`）；MSI（`UninstallString` 含 `msiexec`）**永不回退**（R3-5） | 回退后仍失败 ⇒ `success=false` + `residualEvidence`，如实上抛 |
| **R-A2** | 总时长突破能力级 600s | 大包卸载 + 回退都很慢 | 内部软分配 winget ≤300s / 回退 ≤240s / 核验 ≤30s；**总预算严禁突破 600s** | 超时 ⇒ 非零退出 ⇒ `success=false`（失败方向安全） |
| **R-A3** | 假失败（把真成功核验成「无法判定」） | `R-0` 预捕获被误挪到 winget 之后 | **§A5 已勘误并固化为纪律**：entry 必须在 winget 之前预捕获；`registryGone` 由卸载后的独立重查决定 | 单测三参数夹具（`entry` / `disk` / `registryKeyExists`）可作回归锚 |
| **R-B1** | 宿主不支持原生卡（设计 U2 未知深度） | `show_widget` / `AskUserQuestion` 缺失或受限 | **强制文本兜底路径**（裁定 Q1）：逐字降级 `approval-card.md` v1，行为与现状完全一致 | 卡片 HTML 自包含，无外部依赖、无私钥注入面（R1-8/9 已锁，含 dist） |
| **R-B2** | 卡片产物混入 MCP 通道标记 `__approvalId` | 模板被改写 | `MCP_RESUME_MARKER` 拼接构造 + `containsMcpMarker` 净化 + `auditApprovalCardHtml` 自检（`:796`）/ 静态守卫（`:574`）；A2A 侧源码与 dist grep 零命中 | 一旦误改哨兵字面，静态守卫立即红（`r1-approval-card.test.js:603/610/645`） |
| **R-C1** | 诊断/自检产生副作用（写脏文件或拉起子进程） | 后续改动引入写 API 或 spawn / stdio command 探测误 spawn | import 面收敛为只读 4 函数 + `os.homedir` + `path.join`；stdio 可执行性**只 stat 不 spawn**；dry-run 下连子进程都不拉起 | QA 已用 md5 不变 + 空目录零文件 + `find -newermt` 命中 0 三路实证 |
| **R-C2** | 自检失败阻断安装 | 诊断工具缺失 / 异常 / 输出非 JSON | **非致命**：全部走告警 + skip，不改安装退出码 | —— |
| **R-D1** | A2A 长卸载被 300s metadata 掐断 | 超时取值未走注册表 | `capTimeoutMs` 优先 + 正数有限守卫；两条通道同口径 | 静态守卫第 35 条拦截裸写法回归 |

**回滚路径**：本变更 11 个 commit 按任务切分，`git revert` 可整段或分任务回退 ——
- R1 回滚 ⇒ 卡片退出分支回到「文本模板转呈」（既有行为，无下游依赖被破）；
- R2 回滚 ⇒ 移除诊断脚本与自检，安装主干行为回到 CL-020 终态；
- R3 回滚 ⇒ **注意**回执语义回到 `success = (exitCode===0)`，即**重新引入 K6 假成功**，属安全回退，须谨慎评估。

---

## 验证方法

### 1. 构建（TS 改动必须经 build 验证）

```bash
/data/storage/el1/bundle/libs/arm64/node/bin/node node_modules/.bin/tsc -b tsconfig.build.json
# 期望 EXIT=0（QA 实测 EXIT=0）
```

### 2. 新增单测（**单文件跑**，禁止整批；R1 须先 build dist —— 部分用例读 dist 产物）

```bash
NODE=/data/storage/el1/bundle/libs/arm64/node/bin/node
npx tsc -b tsconfig.build.json                      # R1-8 读 dist/approval-card.js
$NODE --test tests/unit/r1-approval-card.test.js    # 期望 68/68 pass
$NODE --test tests/unit/r3-uninstall-verify.test.js # 期望 35/35 pass（第 35 条为超时守卫）
$NODE --test tests/unit/sandbox-allowwrite.test.mjs # 期望 9/9 pass（含 a3308ae 的桩修复）
```

### 3. 全量离线回归（`tests/unit/` 逐文件，51 个文件）

```bash
# 期望：739 tests / 736 pass / 0 fail / 2 skipped
# 2 skipped = ssh2-resolve.test.mjs 两条离线专用用例因本机可解析 ssh2 而 skip（OFFLINE_SKIP 设计行为）
```

### 4. 诊断工具（T04）与哨兵（R1）静态核验

```bash
node delivery/tools/diagnose-connectors.mjs                 # EXIT=0 + WARN 如实
node delivery/tools/diagnose-connectors.mjs --home <空目录>  # EXIT=1 + FAIL 如实 + 零新文件
grep -rn "__approvalId" packages/adapter-host-workbuddy/     # 含 dist，期望零命中
node delivery/install-host.mjs --dry-run                     # 期望自检块只预告不执行
```

### 5. 真机（**本轮 BLOCKED**，需在 Windows VM + 宿主 WorkBuddy 会话内补，清单见 `QA-REPORT.md` §8）

```bash
# R3：企业微信（NSIS）卸载 → success=true 且 verified 齐全、WXWork.exe 磁盘消失；MSI 对照不回退
# T02b：构造 >300s 的长卸载，确认 A2A 通道不被 metadata 掐断
# R1：委派含 L2/L3 步骤的任务 → 原生卡 → 批准 → 服务端重放 → completed + 审计 -replay executed
# R2：连续 ≥3 个新会话 ToolSearch 命中 winvm__ / a2a. 且 a2a.health 成功
```

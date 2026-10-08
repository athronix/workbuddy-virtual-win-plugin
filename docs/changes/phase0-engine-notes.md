# Phase 0 · 引擎修复笔记（U-P0-1 路径穿越 + U-P0-3 dry-run A1 收紧）

- 执行人：software-engineer（寇豆码）
- 任务：#1（engine.ts 批）
- 依据：`docs/audit/2026-10-08-comprehensive-assessment.md` §2 表格 U-P0-1 / U-P0-3、
  `docs/audit/2026-10-08-architecture-audit.md` ARCH-02 §A1 方案、
  `docs/audit/2026-10-08-test-docs-audit.md` §2-QA-11
- 硬约束：**零 git 写操作**；增量落盘（本文件）；单测**逐文件**跑；tsc 必须 EXIT=0。

## 计划单元（每完成一个立即追加结论）

| # | 单元 | 状态 |
|---|---|---|
| U1 | `normalizePath` 段消解（win32 resolve 语义）+ 黑白名单「先归一后匹配」 | ✅ 完成 |
| U2 | 穿越负向单测 `tests/unit/p0-path-traversal.test.js` | ✅ 完成（84 用例全绿） |
| U3 | `CapabilityDefinition.supportsDryRun` 字段（契约 + CapSpec + 能力标注） | ✅ 完成（声明 5 条） |
| U4 | 引擎双条件（dryRun 且 supportsDryRun）+ 旁路唯一哨兵常量 | ✅ 完成 |
| U5 | 审计链 `ext.bypass='dry-run'` 标记（契约字段 + provider 写入点） | ✅ 完成（装饰器集中覆盖） |
| U6 | SECURITY-GOVERNANCE.md §3.4 措辞同步为 A1（服务端能力声明制） | ✅ 完成（新增 §3.4.1） |
| U7 | 变异验证（旧 normalizePath / 旧单条件各证会红） | ✅ 完成（磁盘级 M1/M2 + 内存级 X1–X4） |
| U8 | 全局一致性自查（tsc + 受影响单测逐文件 + 无遗留 TODO） | ✅ 完成（28 文件 / 746 用例 / 0 失败） |

---

## U1 · normalizePath 段消解 + 先归一后匹配

**实现**（`packages/core/src/policy/engine.ts`）：`normalizePath` 改为委托段消解内核
`foldWin32Segments` + `foldSegList(body, rooted)`，语义对齐 win32 `path.resolve`：

- `.` 段与空段丢弃；`..` 弹出一个**普通**段；
- **锚定形态**（盘符根 `C:\` / UNC `\\server\share` / 根相对 `\a\b`）`rooted=true`：
  栈空时多余 `..` **丢弃** ⇒ 绝不逃到根外；
- **相对形态**（无盘符无 UNC）`rooted=false`：栈空时 `..` **原样保留** —— 引擎不知调用方 CWD，
  伪造绝对路径等于替判定编造事实；保留后必然无法命中前缀式白名单 ⇒ `pathAllowlist:miss` **fail-closed**；
- **total**：非字符串/空串/纯分隔符/畸形 UNC/控制字符一律返回字符串，绝不抛
  （归一抛错会被上游 catch 成「执行失败」而非「拒绝」= 又一个绕过面）；**幂等**已测；
- **UNC 不误伤**：`server`+`share` 作为不可弹出锚点（`\\server\share\..` → `\\server\share`）；
  畸形（`\\`、`\\onlyserver`）原样返回，不臆造形态；
- **设备命名空间 `\\?\` / `\\.\` 逐字节透传**（Windows 对该前缀不做归一；默认黑名单 `\\?\**` 已整体拒）。

**先归一后匹配（两侧同一通路）**：

| 位置 | 改动 |
|---|---|
| 构造函数 `pathDenyRe` / `pathAllowRe` | `globToRegex(normalizePath(p))` —— **模式侧**也归一 |
| 步骤 2 能力级覆盖 `capPathDeny` | 同上 |
| 步骤 4 能力级覆盖 `capPathAllow` | 同上 |
| 步骤 2 黑名单比对点 | `const p = normalizePath(candidate)`（原有，语义已变强） |
| 步骤 4 白名单比对点 | `const p = normalizePath(candidate)`（原有） |

**旁路排查结论**（任务书 U1「检查全部路径比对调用点无绕过归一的旁路」）：全量核对后**新发现并修掉一处
真正的旁路** —— 它不在比对点，而在**采集层**：

> `extractPathTokens` 的盘符正则原为 `[A-Za-z]:\\`（**只认反斜杠**），于是命令串里嵌的
> 正斜杠盘符路径（`node C:/Users/a/../../Windows/System32/evil.js`）**一个 token 都提不出来** ⇒
> 整条命令完全不进入文件系统策略视野。这不是「归一得对不对」，而是**根本没走到归一**：
> `normalizePath` 已把 `C:/…` 与 `C:\…` 视为同一形态，采集层却只认一种写法 ⇒ 黑名单在
> `path` 参数通路生效、在 `command` 通路失效。现改为 `[A-Za-z]:[\\/]`；
> `https://` 类 scheme 因冒号前邻是字母仍被 S-1 的左断言排除（既有 `M:\` 伪盘符零出现断言不回归，
> `r19b-s1-registry-forms.test.js` 35/35 绿）。

静态守卫（`p0-path-traversal.test.js` 的 `auditNormalizationBypass`）把上述 5 个比对点 +
「负面判据：`pathMatchesAny(candidate` 直连原始串」钉成可执行断言。

**与注册表域的边界**：`canonicalRegistryPath` 只做别名收敛 + 冒号形态补齐，**从来不做** `.`/`..` 消解。
本单元曾一度把文件系统内核接进注册表归一，经主理人裁定**回退**（见「偏差登记 D-1」）——
注册表域残留面独立登记为 U-P0-1b 提案，见文末。

## U2 · 穿越负向单测

新增 `tests/unit/p0-path-traversal.test.js`（风格参照 `tests/unit/r19c-*.test.js`：
`node:test` + `assert/strict`，纯逻辑，不起 HTTP / 不 spawn ps-bridge / 不落盘）。
**84 用例全绿**，分 5 个 describe：

1. **段消解语义**（10）：必测串 `C:\Users\a\..\..\Windows\System32\evil.dll` →
   `C:\Windows\System32\evil.dll`；`.`/重复分隔符/弹栈；正斜杠·混合·尾分隔符形态等价；
   大小写三形态判定一致且命中 `pathDenylist`；无盘符形态 `..` 保留；UNC 锚点；`\\?\`/`\\.\` 透传且被
   `\\?\**` 拒；根与空串；★ total + 幂等（hostile 列表含 40 层 `..`、控制字符、畸形 UNC）；
   穿越串归一后不再以 `C:\Users\` 起头（黑名单可见性充分条件）。
2. **策略判定**（48）：10 条带路径能力 × 4 个参数键（`path`/`destination`/`outputPath`/`target`）
   穿越串一律 DENY 且 `requiresApproval=false`（硬拒不是「等审批」）；`TRAVERSALS` 9 形态全集 DENY；
   命令内嵌穿越 DENY（正反斜杠各一例，锁住 U1 采集层修正）；★ **不回归**：7 条合法白名单路径仍
   `allow:policy-passed`；`.`/冗余分隔符等价写法同结论；黑名单原生命中形态（Program Files /
   ProgramData / Recovery / `C:\Windows\System32\drivers\etc\hosts`）不回归；★ 无归一旁路静态守卫；
   模式侧归一；注册表域与基线一致（本任务零波及）；`DEFAULT_POLICY` 表项归一后不变。
3. **dry-run 双条件**（10）：★ 未声明 `supportsDryRun` 的 L2 能力传 `dryRun` →
   `requiresApproval=true` / `matchedRule='approval-required'`；已声明 + `dryRun` →
   `allow:dry-run-bypass`；已声明但未传 → 仍走审批闸；`dryRun:false` / 字符串 `"true"` → 不免批；
   `supportsDryRun:false` 显式声明 → 不免批；★ fail-closed（引擎未注入注册表）；
   免批不得绕过黑名单/白名单；经真实注册表装配的端到端免批；★ **声明位集合钉死**（5 条 ID 全集）；
   哨兵常量单值源（契约常量 = core 别名 = 引擎产出串）。
4. **链上取证 `ext.bypass`**（5）：命中旁路补写 `ext.bypass='dry-run'`；与 K-N1 归因 ext **合并不覆盖**；
   ★ 非旁路记录**连 `ext` 键都不新增**（纯附加）；判据只看服务端裁决不回看调用方参数；`verifyChain` 透传。
5. **变异自检**（11）：见 U7。

## U3 · supportsDryRun 字段

| 文件 | 改动 |
|---|---|
| `packages/contracts/src/capability.ts` | `CapabilityDefinition` 在 `requiresApproval?` 与 `destructive` 之间新增 `readonly supportsDryRun?: boolean;`，注释写明「为什么必须服务端声明 + 标注纪律 + 与 `REG_CANON`『既是映射也是准入』同构」 |
| `packages/contracts/schemas/capability.schema.json` | 因 `additionalProperties: false`，补 `"supportsDryRun": { "type": "boolean" }`（否则注册即被 schema 拒） |
| `packages/contracts/src/bridge.ts` | `CapabilityRegistryView.get` 返回类型放宽为 `… \| { risk; requiresSession; supportsDryRun?: boolean } \| undefined`（纯附加） |
| `packages/vm-capabilities/src/registry/definitions.ts` | `CapSpec` 增 `supportsDryRun?`；`cap()` 条件展开 `...(spec.supportsDryRun !== undefined ? { supportsDryRun: spec.supportsDryRun } : {})`（**未声明即缺席**，不写 `false`，保持「默认不支持」的显式语义） |

**已标注 5 条**（每条附 psmod 代码级证据，注释里逐条列行号）：

| 能力 ID | 风险 | psmod 证据 |
|---|---|---|
| `system.power.control` | L3 | `system.ps1:470-476 Invoke-PowerControl`（`$DryRun` 早返回） |
| `app.winget.install` | L1 | `app.ps1:239/249` |
| `app.winget.uninstall` | L2 | `app.ps1:693 Get-UninstallDryRunPlan` / `:797-812` |
| `app.winget.upgrade` | L1 | `app.ps1:984/989` |
| `storage.file.delete` | L2 | `storage.ps1:166-178 Remove-FileSystemItem` |

`packages/core/src/registry/capability-registry.ts` 的 `get()` **保持返回完整 `CapabilityDefinition`**：
曾改为最小投影后回退并加注释 —— 收窄会使 provider 的 `definitionOf()` 兜底拿不到 `input`，
静默放松 D24 入参契约校验 = **安全方向劣化**；完整定义在结构上已满足放宽后的视图契约。

## U4 · 引擎双条件

审批闸（`engine.ts` 步骤 6，现 755–778 行区段）：

```ts
if (riskAtLeast(req.risk, 'L2') && !req.approved) {
  if (req.params['dryRun'] === true) {                       // ① 意图（调用方自报）
    if (this.capabilitySupportsDryRun(req.capabilityId)) {   // ② 服务端事实
      return { allowed: true, matchedRule: POLICY_DRY_RUN_BYPASS_MATCHED_RULE, requiresApproval: false };
    }
  }
  return { allowed: false, matchedRule: POLICY_APPROVAL_REQUIRED_MATCHED_RULE, requiresApproval: true, … };
}
```

- 新增私有方法 `capabilitySupportsDryRun(capabilityId)`：唯一判据 = 注册表投影 `supportsDryRun === true`；
  注册表缺席（无从核实）→ `false`（fail-closed）。**不读 `req.params`**、不看 input schema 有无 `dryRun`
  属性（schema 有该键只说明「实现接得住开关」，不等于「开关为真时零系统变更」）。
- **哨兵常量单值源**：`POLICY_DRY_RUN_BYPASS_MATCHED_RULE` / `POLICY_APPROVAL_REQUIRED_MATCHED_RULE`
  定义在 `packages/contracts/src/bridge.ts`，core 侧 `export const DRY_RUN_BYPASS_MATCHED_RULE = …` 别名再导出，
  `packages/core/src/index.ts` 对外导出 —— 三方（引擎产出 / 审计装饰器 / 测试与运维 grep）共用一个字面量。
- **既有合法链路不破坏**：`server.ts` 的 `buildPreview` 区分
  `dryRunPreviewable = hasDryRunParam(cap)`（可预览）与 `dryRunExempt = dryRunPreviewable && cap.supportsDryRun === true`
  （可免批），新增 `exempt` 字段并按 `dryRunExempt` 分叉 `plan`/`hint` —— 未声明能力不再**虚假承诺**
  「免审批直接放行」；`hasDryRunParam` 补文档注释「可预览 ≠ 可免批」。
- **锚点纪律**（与 QA 交付件共存，`assembly-guard.test.js` 未改）：`if (req.params['dryRun'] === true) {`
  这一行的字面量是 QA 侧 `indexOf` **取首个命中**的切片锚点。engine.ts 注释里原会复现该完整字面量 ⇒
  守卫会切到注释而非代码、静默失效。已改写注释使其不复现完整字面量，全文件该字面量**出现 1 次**（代码行）。

## U5 · 审计 bypass 标记

`packages/contracts/src/audit.ts`：`AuditExt` 末尾新增 `readonly bypass?: 'dry-run';`
（注释：grep `ext.bypass` 即得全部免批执行清单；写入方为服务端；判据一律取 `PolicyVerdict.matchedRule`）。

写入点采用**装饰器集中覆盖**（`packages/vm-service/src/delegation-audit.ts` 新增 `bypassTagSink(sink)`），
装配点 `server.ts:399` 套在 `wrapAuditSink` **之外**：

```ts
const auditSink = bypassTagSink(wrapAuditSink(audit, (record) => ledgerReg.onAuditRecord(record), logger));
```

理由：链写入点分散（provider 成功/失败 + 两处 blocked + 委派壳，共 4+ 处），逐点注入必然漏；
装饰器一处覆盖全部经桥接层落链的记录。纪律三条：① **只读服务端裁决**（`input.policyDecision?.matchedRule`），
绝不回看 `params.dryRun`；② **纯附加** —— 非旁路记录原样透传，连 `ext` 键都不新增（既有链上形态逐字节不变）；
③ `ext` 参与 `canonicalJson` 哈希 ⇒ 必须在 `sink.append` **之前**整形，故只能靠装饰器而非事后补写。
`packages/vm-service/src/index.ts` 具名导出 `bypassTagSink`。

## U6 · SECURITY §3.4 同步

`docs/02-design/SECURITY-GOVERNANCE.md`：

- 原第 1 条红线「**任何情况下**不得提供绕过审批闸的**配置开关或代码路径**」措辞收窄为
  「不得提供绕过审批闸的**配置开关**（`PolicyConfig` 中不存在、也不得新增『跳过审批』类字段）」——
  保留其绝对性但不再与 §3.4.1 登记的例外自相矛盾；
- 新增 **§3.4.1 `dry-run` 免审批：服务端能力声明制（A1）**，6 条约束表格（双条件 / 显式白名单式标注 /
  fail-closed / `ext.bypass` 取证位 / 只豁免审批闸不豁免任何黑白名单 / 声明集以注册表为唯一事实源且
  新增标注 = 新增免批通道须有 psmod 代码级证据），每条给出落点；
- 末尾附「若某天决定彻底删除该通道，应同时删除声明位与本小节并把红线恢复为绝对表述」的回退指引。

## U7 · 变异验证

**内存级**（在 `p0-path-traversal.test.js` describe 5 内，随单测常跑，11 用例）：

| 变异 | 做法 | 期望 | 实测 |
|---|---|---|---|
| X1 | 内核还原 HEAD 三行浅归一 | 段消解判据变红 | ✅ 红（并精确报出「不识别 `..` 段」等） |
| X2 | `foldSegList(…, false)` → `true` | 段消解判据变红 | ✅ 红（`problems` 精确含 `/rooted=false/`） |
| X3 | 旁路还原为单条件放行 | dry-run 判据变红 | ✅ 红（精确含「服务端声明位缺失」） |
| X4 | 等价改写 4 种（尾随空格 / 参数换行 / 常量换等值字面量 / 内核调用折行加尾逗号） | 判据**仍绿** | ✅ 绿 |
| — | 判据自身有效性：注释里贴满旧实现特征串 | 判据仍为空 | ✅（`stripComments` 前置，守卫不被注释干扰） |

**磁盘级**（真实改盘 + `tsc -b` 重建 dist + 单文件复跑 + 按 SHA-256 还原，一次性驱动器已删除）：

- `engine.ts` 基线 `sha256=91e31056377f9e0961f6fb0e9a18d0ea22fd3b47589afebdd711ee3b897c7d8c`
- **M1 还原旧 `normalizePath`（浅归一）** → `p0-path-traversal` 84 用例中 **57 红 / 27 绿**，
  首条即「★ 必测串：穿越到 System32 必须收敛为真实目标」，且 10 能力 × 4 参数键的穿越 DENY 全部转 ALLOW
  ⇒ **新测试确实能抓住原缺陷，不是装饰品**。
- **M2 还原旧单条件旁路** → `p0-path-traversal` **7 红 / 77 绿**（含「★ 未声明 supportsDryRun 的 L2 能力传
  dryRun → requiresApproval=true」「★ fail-closed 未注入注册表」「X3/X4/真实源码判据」），
  同时 `cl017.test.js` **1 红 / 11 绿**（D11 收紧用例）⇒ 双条件守卫有两条独立测试线把守。
- 两次变异后均 `cp` 回备份并校验 SHA-256 **与基线逐字节相同**，再 `tsc -b` EXIT=0，复跑全绿。
  `.tmp/` 下本次新建的 3 个一次性脚本与备份文件已全部清理（不属于交付物）。

**X4 期间发现并修掉的守卫脆性（属我新增文件自身缺陷）**：
`auditSegmentFolding` 的 rooted 实参提取第一版用 `[^)]*` 正则（被实参内 `s.slice(…)` 的右括号截断），
第二版按行取（prettier 折行 + **尾逗号**使末分段为空 ⇒ 漏计一处，`rooted=true` 数出 2 而非 3 ⇒ X4 假红）。
现改为**括号配平扫描 + 顶层逗号分段 + 取最后一个非空分段**（`callLastArgs`），对换行/缩进/嵌套括号/尾逗号
全部免疫，并对配平失败显式收束（绝不静默给出「看起来对」的实参）。

## U8 · 全局自查

`node_modules/.bin/tsc -b tsconfig.build.json` → **EXIT=0**（12 包 project references，全程两次复跑均 0）。

**受影响既有测试逐文件复跑**（`node` 用全路径 `/data/storage/el1/bundle/libs/arm64/node/bin/node`；
**绝不整批** —— junction 会触发原生崩溃形成假全红）：

| # | 文件 | tests | pass | fail |
|---|---|---|---|---|
| 1 | `p0-path-traversal`（**新增**） | 84 | 84 | 0 |
| 2 | `cl017` | 12 | 12 | 0 |
| 3 | `assembly-guard` | 24 | 24 | 0 |
| 4 | `policy` | 22 | 22 | 0 |
| 5 | `path-util` | 9 | 9 | 0 |
| 6 | `r19b-s1-registry-forms` | 35 | 35 | 0 |
| 7 | `r19b-s5-write-allowlist-pairing` | 39 | 39 | 0 |
| 8 | `host-adapter` | 35 | 35 | 0 |
| 9 | `k5-replay` | 41 | 41 | 0 |
| 10 | `r19c-s4-policy-denied-audit` | 7 | 7 | 0 |
| 11 | `r19c-kn1-a-pure` | 76 | 76 | 0 |
| 12 | `r19c-kn1-b-bridge` | 23 | 23 | 0 |
| 13 | `r19c-kn1-c-session` | 17 | 17 | 0 |
| 14 | `r19c-kn1-d-provider` | 28 | 28 | 0 |
| 15 | `r19c-kn1-e-shape` | 33 | 33 | 0 |
| 16 | `r19c-kn1-e-mutation` | 49 | 49 | 0 |
| 17 | `r19c-kn1-f-chain` | 16 | 16 | 0 |
| 18 | `r19c-k3r-bridge-integ` | 2 | 2 | 0 |
| 19 | `r1-approval-card` | 69 | 69 | 0 |
| 20 | `r3-uninstall-verify` | 39 | 39 | 0 |
| 21 | `r19c-a5-fix4-risk` | 4 | 4 | 0 |
| 22 | `psmod-contract` | 7 | 7 | 0 |
| 23 | `sandbox-allowwrite` | 9 | 9 | 0 |
| 24 | `cl017-param-guard` | 10 | 10 | 0 |
| 25 | `cl017-param-value` | 34 | 34 | 0 |
| 26 | `cl017-error-reason` | 10 | 10 | 0 |
| 27 | `cl017-psmod-sort` | 6 | 6 | 0 |
| 28 | `cl017-winget-parse` | 6 | 6 | 0 |
| | **合计（28 文件）** | **746** | **746** | **0** |

选取依据：`grep -rl "normalizePath\|dry-run-bypass\|supportsDryRun\|canonicalRegistryPath\|extractPathTokens" tests/`
∪ `grep -rl "dryRun\|dry-run" tests/` ∪ `grep -rl "WINDOWS_CAPABILITIES\|capability.schema" tests/`
∪ `grep -rl "wrapAuditSink\|delegation-audit" tests/` ∪ `ls tests/unit/ | grep -i cl017`
（cl017 家族 6 个文件全纳：`cl017.test.js` 被我改过夹具，其余 5 个共享同一注册表/引擎装配路径，
主理人裁定记录亦点名 `cl017-param-guard` / `cl017-param-value`）。

**交叉一致性**：哨兵常量全仓唯一定义点已核（`bridge.ts:387/390` + core 别名 1 处）；
`supportsDryRun` 贯通契约→schema→CapSpec→definitions→registry.get→engine→server.preview→测试；
`bypassTagSink` 定义 1 处 / 装配 1 处 / 导出 1 处；本人改动文件内 `TODO`/`FIXME`/占位符 **0 命中**；
范围外文件（`skills/`、README、`.dev/`、`package.json`、`psmod-contract.test.js`、`assembly-guard.test.js`）
**未写入**（后两者出现在 mtime 列表里是 QA 并行交付件，非本任务改动）。

---

## 偏差登记（与任务书/上游设计的差异及理由）

- **D-1｜注册表域段消解：曾实施后按主理人裁定回退。**
  我实现 U1 时把文件系统内核接进 `canonicalRegistryPath`（`HKLM:\SOFTWARE\..\SYSTEM\…`
  确凿以 `HKLM:\SOFTWARE\` 前缀命中读表 ⇒ ALLOW，而真实目标是 `HKLM:\SYSTEM\…`，属同族逃逸）。
  主理人在测试文件注释中裁定该面「扩大范围需改契约语义并连带核验 S-1 纪律，本任务不动实现」，
  故**已回退**（`engine.ts` SHA-256 与回退基线一致，`r19b-s1-registry-forms` 35/35 绿），
  并把它保留为**已钉死的可执行记录**（`p0-path-traversal` 用例「注册表域与基线一致：不经 normalizePath」
  同时断言结构性判据 + HKU/HKCR/SAM 仍拒 + `..\` 不改结论）。残留证据见文末提案。
- **D-2｜`extractPathTokens` 盘符正则扩为正斜杠（任务书未点名，属「无归一旁路」排查所得）。**
  不改它则「`command` 通路根本没走到归一」，U1 的修复在命令参数上是空的；这是任务书
  「检查全部路径比对调用点无绕过归一的旁路」的直接产出，非范围扩张。
- **D-3｜任务书所写 `appops.app.manage` 在仓内不存在。** 该 dryRun 真功能（`app.ps1:693
  Get-UninstallDryRunPlan`）对应的真实 ID 是 `app.winget.uninstall`，声明位标在它身上。
- **D-4｜`tests/unit/cl017.test.js` 夹具必要修正**（任务书允许「触及这两处的既有测试复跑」，此处是修夹具）：
  旧夹具 `new CorePolicyEngine()` 不注入注册表 ⇒ A1 第二条件无从核实 ⇒ 合法 dryRun 链路**假红**。
  改为与生产同构 `new CorePolicyEngine({ registry: makeRegistry() })`，并补 D11 的
  `matchedRule==='allow:dry-run-bypass'`、`byId('system.power.control')?.supportsDryRun===true` 断言
  与「未声明能力（`system.registry.write`）传 dryRun → requiresApproval=true」新用例。
- **D-5｜审计写入点由「逐点注入」改为「装饰器集中覆盖」。** 任务书 U5 提示「找现有链写入点如
  `recordPolicyDeniedAudit` 的同级注入面」；实测写入点分散 4+ 处、逐点注入必漏，
  且 `ext` 参与哈希必须在 `append` 前整形 ⇒ 装饰器是唯一能同时满足「全覆盖 + 纯附加 + 哈希前整形」的形态。
- **D-6｜`capabilityRegistry.get()` 返回类型放宽在契约侧、实现侧保持完整定义**（见 U3 表末行）：
  收窄返回会静默放松 D24 入参校验，方向上是安全劣化。

---

## 提案（不在本任务范围，供主理人裁决）

**U-P0-1b｜注册表域 `.`/`..` 段消解（同族残留，P1）**
现状实测（回退后，`system.registry.read` / L0）：

| 入参 | 结论 | 权威归一形态 |
|---|---|---|
| `HKLM:\SOFTWARE\..\SYSTEM\CurrentControlSet` | **ALLOW**（`allow:policy-passed`） | `HKLM:\software\..\system\currentcontrolset` |
| `HKLM:\SOFTWARE\..\SAM\SAM` | **ALLOW** | `HKLM:\software\..\sam\sam` |
| `HKLM:\SOFTWARE\CurrentControlSet` | ALLOW | `HKLM:\software\currentcontrolset` |
| `HKU:\S-1-5-21` / `HKCR:\Applications\x` / `HKLM:\SAM\SAM` | DENY（`registryReadAllowlist:miss`） | — |

即「一条 `..\` 逃出自己被允许的键树」，读表命中靠的是**字面前缀**而非真实落点；
写侧（`system.registry.write` L2）今天被审批闸兜住，但兜住它的是**风险等级**而不是路径判定。
修复面：`canonicalRegistryPath` 复用同一 `foldSegList(hive 为 rooted 锚)`，
连带需重钉 `r19b-s1-registry-forms` 的 S-1 别名/伪盘符纪律与 `docs/design/r19b-s1-kn2-contract.md` 契约断言。
已回退的实现草稿可直接复用（一次 Edit 即可重新挂上）。

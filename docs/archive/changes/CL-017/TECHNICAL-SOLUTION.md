# CL-017 · 技术方案与关键修复记录

> 本文件记录 CL-017 中**成因复杂、易被后续重构误删**的两处修复的技术细节与判决依据。
> 需求与验收口径见同目录 `REQUIREMENT.md`。

---

## 1. D25 · `app.winget.search` 静默返回空（P1）

### 1.1 现象

```
app.winget.search {query:'7zip'}  →  ok=true, data=[], warnings=[]      ← 静默空
同一 VM 直接跑 `winget search 7zip`  →  11 条真实结果（含 7-Zip / 7zip.7zip）  ← 独立基线
```

危害：调用方据「`ok=true` + `data=[]`」会误判「winget 没有这个包」。这属**静默错数据**，
比旧缺陷（表头当数据行、列错位 —— 至少能看到东西）更危险。

### 1.2 根因（二分证明，非推断）

winget 的列分隔线是**一整条连续长横线**（真机实测 **98** 个 `-`），**不是按列分段**。

```
[regex]::Matches($lines[$sepIdx], '-+')   →  只得到 1 个匹配   →  $cols.Count = 1
每行 $vals.Count = 1
$vals.Count -lt 3  →  全部 continue
$out = @()  →  返回 ok=true + data=[]   （无告警）
```

即：**逻辑上不可能工作**。旧实现（D16）「按分隔线定列」从起点就是错的。

### 1.3 修法

`packages/vm-capabilities/psmod/app.ps1`

1. **列边界取自分隔线上一行的表头**（非分隔线）：在表头行定位
   `Name|Id|Version|Match|Source` 各标签的**起始显示列**，切片区间 `[start_i, start_{i+1})`
   （`:156` 附近，`$header = $lines[$sepIdx - 1]`）。
2. **显示宽度补偿**（见 1.4）：`Get-DisplayCharWidth`（`:81`）、`Get-DisplayColumnMap`（`:97`）、
   `Get-CharIndexAtDisplay`（`:113`）—— 先把「显示列」换算为字符索引，再做 `Substring` 切片。
3. **fail-loud**（`:193` 附近）：分隔线之后**确存在数据行**却解析出 0 条 →
   `throw 'WINGET_PARSE_FAILED: <首行原文>'`。**宁可报错，绝不静默给空。**
4. 保留跳过表头 / 分隔线 / 汇总行的逻辑。

### 1.4 ⚠ 显示宽度补偿 —— **裁决保留项，不可回退**

winget 按**显示宽度（display width）对齐**，而非按字符数对齐。CJK / 全角字符占 **2 个显示列**，
故含中文包名的行用「字符索引」直接切列会整体错位。真机第 10 行：

| 模式 | 条数 | 脏 id 行 | 该行解析结果 |
|---|---|---|---|
| `char`（纯表头定列，无补偿） | 11 | **1** | `id="7R6J42SKH            Unkno"`、`version="wn"` |
| `width`（表头定列 + 宽度补偿） | 11 | **0** | `{"name":"7zip解压缩软件","id":"XP8C87R6J42SKH","version":"Unknown"}` |

实测依据：该行 `indexOf('XP8C87R6J42SKH') = 30`，而表头 `Id` 起始字符索引 = 35；
差 **5** 恰等于该行 5 个 CJK 字符多占的 5 列。ASCII 行两者等价（宽度 == 字符数）。

> **主理人裁决**：批准保留宽度补偿，驳回「逐字对齐分支 B（char 模式）」的原始指令 ——
> 后者会产出 1 行垃圾 id（另一类静默错数据）。
> **请勿以「逐字对齐表头」为由简化删除本补偿**；删了即退回静默错数据。
> 该约束已同时写入 `app.ps1` 的源码注释（防后续重构误删）。

### 1.5 验证

- 真机：`app.winget.search {query:'7zip'}` → 11 条；首行 `{"name":"7-Zip","id":"7zip.7zip","version":"26.03"}`；
  CJK 行 `{"name":"7zip解压缩软件","id":"XP8C87R6J42SKH","version":"Unknown"}`。
- 验收 `A17`：插件 rows=11 / 独立基线 rows=11（下限 11），含 `7zip.7zip`=true、含 `7-Zip`=true、**脏 id 行=0**。
- 单测 `tests/unit/cl017-winget-parse.test.js`：静态（表头定列 / 无 `-+` 分段 / 含 fail-loud）
  + 行为（内嵌真机夹具 → 11 条 / CJK 行正确 / fail-loud 抛错）。

---

## 2. D25-② · PS 参数绑定异常 → `INVALID_ARGUMENT`（纵深防御）

### 2.1 定位与分工

| 层 | 位置 | 覆盖 |
|---|---|---|
| **前置·名**（D24） | `adapter-agent-workbuddy` `validateParams()` | **参数名**类：未知参数名 / 缺必填；**仅对声明了 `required` 的能力**（54 个能力里只有 27 个有 `required`） |
| **前置·值**（D26，见 §3） | `adapter-agent-workbuddy` `validateParams()` | **值**类：`enum` 越界 / `type` 不可强转（按注册表 schema 的 `type`/`enum` 判定），`details.invalid[]` |
| **纵深**（D25-②，本节） | `ps-bridge.ps1` catch | D24/D26 够不到的形态：**schema 未声明**、只有 PS 侧绑定才拦得下的值层面失败（类型不符 / 枚举越界），与能力是否声明 `required` 无关 |

两条路径对外**完全同形**：`code=INVALID_PARAMS` + `reason='INVALID_ARGUMENT'`，调用方无须学第二套语义。

### 2.2 实现

`packages/vm-capabilities/psmod/ps-bridge.ps1`

- 新增 `Test-ParameterBindingException`（`:65`）：**仅按异常类型**判定，并遍历 `InnerException` 链防包装。
  真机实测顶级类型均为 `System.Management.Automation.ParameterBindingException` 或其派生类：
  - 缺必填 → `ParameterBindingException`
  - 类型不符 → `ParameterBindingArgumentTransformationException`
  - ValidateSet 违规 → `ParameterBindingValidationException`
- catch 内（`:212` 附近）：`elseif (Test-ParameterBindingException -Exception $ex) { $code = 'INVALID_ARGUMENT' }`；
  映射为领域码 `INVALID_ARGUMENT`（Node 侧 `DOMAIN_CODE_TO_BASE['INVALID_ARGUMENT']='INVALID_PARAMS'` 已存在）。
- `details.exceptionType` 原样保留（`:221`）；message 统一补 `INVALID_ARGUMENT: ` 前缀。

**约束**：不引入新领域码；**禁止**「消息含 parameter 字样」之类模糊匹配（跨语言不可靠，易误判）；
真实执行失败（`CommandNotFoundException` 等）**不得**被判为 `INVALID_PARAMS`。

### 2.3 验证

- 单测 `tests/unit/cl017-error-reason.test.js`（新增 3 例）：
  - 契约链路：`code=INVALID_ARGUMENT` + `details.exceptionType` → `INVALID_PARAMS` + `reason` + `details` 保留；
  - **反向对照**：真实执行失败（无领域码）→ `EXECUTION_FAILED`，**不**判为 `INVALID_PARAMS`；
  - 静态守卫：`ps-bridge.ps1` 按类型判定、映射 `INVALID_ARGUMENT`、无模糊匹配、无新领域码。
- 真机（同一能力、无 `required`）：
  - **修复前** `system.process.list {top:'abc'}` → `code=EXECUTION_FAILED`（无 `reason`）；
  - **修复后** → `code=INVALID_PARAMS` + `reason=INVALID_ARGUMENT` + `details.exceptionType=…ParameterBindingArgumentTransformationException`。

---

## 3. D26 · 入参契约校验须覆盖**值层面**（`type` / `enum`）

### 3.1 为什么 D24 / D25-② 不够（真机证据）

D24 只校验「键合法 / 必填在位」，**不校验值**；D25-② 虽把 PS 绑定异常归一为 `INVALID_ARGUMENT`，
但那是**事后兜底** —— 两者都不满足「**前置、可路由、零桥往返**」这一目标。

真机取证（D26 修复前，两条值层面错误均由 PS 绑定抛出、被压成**无 `reason`** 的 `EXECUTION_FAILED`）：

| 调用 | 修复前返回 | 期望返回 |
|---|---|---|
| `system.process.list {"top":"abc"}` | `code=EXECUTION_FAILED`、无 `reason` | `INVALID_PARAMS` + `reason=INVALID_ARGUMENT` + `details.invalid` |
| `system.service.control {"name":"__nope__","action":"bogus"}` | `code=EXECUTION_FAILED`、无 `reason` | 同上 |

> ⚠ **反向对照**：可强转的宽松形态**不得误拒** —— LLM 常以字符串发数字（`"top":"20"`）。
> 若按 JS 严格类型判，会把合法调用误拒，**危害大于漏报**。

### 3.2 修法：adapter 侧**前置**值校验（主修复）

`packages/adapter-agent-workbuddy/src/index.ts`

- 在 `validateParams()` 内，对**已提供**（非 `null` / 非 `undefined`）的键追加两条判定：
  - `enum`：字符串成员**忽略大小写**匹配（对齐 PS `ValidateSet`，见 §3.2.1）；真正的越界值仍拒绝；
  - `type`：按 `isCoercibleTo()` 的 **PS 可强转性**（**非** JS 严格类型）判定。
- 新增 `details.invalid: [{ key, expected, got }]`；`details` 恒含 `unknown` / `missing` / `allowed` / `invalid` 四字段。
- `got` 只回**类型类别**（`string` / `number` / `array` …），**不回显原值**（避免把文件内容 / 口令写入错误回包与审计日志）。
- 严格判据必须由**主修复**命中（`details.invalid` 非空且 `bridge.call` 未被调用），**不再是走到 PS 兜底**。

**`type` 可强转性表**（对齐 PowerShell 参数绑定）：

| schema `type` | 接受 | 说明 |
|---|---|---|
| `integer` / `number` | JS 数字；整体数字形态字符串 `/^\s*[+-]?\d+(\.\d+)?\s*$/` | PS 把 `'20'` / `' -3 '` / `'2.5'` 强转为 `[int]` / `[double]` |
| `boolean` | JS 布尔；`'true'` / `'false'`（忽略大小写与首尾空白） | |
| `string` | 字符串 / 数字 / 布尔 | PS 均可 `[string]` 强转 |
| `array` | 数组，**或 string / number / boolean 标量** | PS 数组形参（如 `[string[]]$Keys`）会做**标量提升**；不校验 `items` |
| `object` | 非 `null` 非数组对象 | |
| 未声明 `type` | **跳过**（不阻断） | 如 `storage.file.write.content`（声明为 `{}`） |
| 值为 `null` | **跳过**（交由 `required` 判定） | 避免与「缺省」语义重复拦截 |
| 未知 `type` 关键字 | **放行**（前向兼容） | |

#### 3.2.1 裁决 B —— 与 PS 绑定**同宽**（2026-09-17 团队裁决）

初版把 `enum` 写成「严格 `includes`」（大小写敏感），与「`type` 按 PS 可强转性」**自相矛盾** ——
本校验的目的是「**预判 PS 绑定会不会失败**」，不是严格 JSON Schema 校验；**我们自己引入的新失败模式（误拒）比漏放更糟**。
故裁决 **B（对齐 PS 语义）**：

| 边界 | 采纳做法 | 依据（psmod 真机绑定） |
|---|---|---|
| `enum` 大小写 | 字符串成员**忽略大小写**比较 | `system.ps1:88 [ValidateSet('start','stop','restart')]`、`system.ps1:343`、`gui.ps1:224`、`storage.ps1:275` 等 —— **PS `ValidateSet` 默认忽略大小写**；`'START'` 本就能过 PS |
| `type:'array'` 标量提升 | string / number / boolean 标量视为可强转数组 | `gui.ps1` `Send-KeyboardInput` 的 `[string[]]$Keys` 会把标量 `'enter'` 抬成 `@('enter')` |

**边界保持严格**：`'bogus'` 等**折叠大小写后仍不在集合内**的值**必须拒绝**（A18 严格判据不松）；
`array` 收到 `object` 等**不可提升**的复合值仍拒绝。

### 3.3 补充发现：**未知参数名在 PS 层被静默忽略**

真机探针实测：PowerShell 高级函数对**未声明的形参名**不报错、**静默忽略**（不落入
`ParameterBindingException`）。因此「参数名写错」在 PS 侧**不可能**被 D25-② 兜住 ——
这正是 D24 必须在 **Node 侧前置**校验的根本原因（而非可选优化）。

### 3.4 验证

- 单测 `tests/unit/cl017-param-value.test.js`（**表驱动** 34 例）：
  - 严格判据 9 例（integer/number 类型不符、enum 越界与「折叠大小写后仍越界」、boolean 非法串、array 收对象、object 收数组）→ 均 `INVALID_PARAMS` + `reason` + `details.invalid`，且**未发起桥调用**；
  - 宽松对照 17 例（`"20"` / `20` / `' -3 '` / `'2.5'` / `'true'` / 数字→string / 数组 / **标量→array** / 对象 / 无 `type` / `null` 跳过 / **enum 大小写变体 `START`、`macHINE`**）→ 均放行打到桥；
  - 契约 / 文案 / 裁决 B 显式回归 8 例（四字段恒定、与 D24 叠加、消息含「参数取值非法」、未声明键不误报 invalid、enum 大小写放行 + array 标量放行 + `"bogus"` 反向保险）。
- 真机 A18（**待 VM 恢复执行**）：严格两例转绿；宽松三例（`top:"20"` / `top:20` / `content:123`）保持 `ok=true`；
  **enum 大小写宽松例**（`action:"START"` → 须放行至业务层、`reason=SERVICE_NOT_FOUND`）。

### 3.5 PS 侧注释校正（仅注释，不改行为）

`ps-bridge.ps1` 原注释把 D25-② 的覆盖范围写成「无 `required` 的能力的类型不符」，**过窄且误导**。
已更正为：D25-② 覆盖的是**值层面的失败（类型不符 / 枚举越界）**，与能力是否声明 `required` **无关**；
且随 D26 落地，adapter 侧已能前置拦截**注册表 schema 已声明**的类型 / 枚举约束，本分支退为
**纵深防御**（schema 未声明、只有 PS 绑定才拦得下的形态）。

### 3.6 skill 文档同步的分类（范围说明）

D26 改变了「入参错误如何暴露给调用方」的语义（新增 `details.invalid`），故**凡描述该处置流程的 skill 都必须同步**，
否则读到旧描述即为错误指引。按语义来源分类：

- **D23（错误分层）**：`error.code`（契约 10 码）vs `error.reason`（领域原因码）—— 见 `winvm-mcp-reference`；
- **D24（前置·名）**：未知参数名 / 缺必填 → `details.unknown` / `missing` / `allowed`；
- **D25 / D25-②（winget 解析 + PS 绑定兜底）**：`WINGET_PARSE_FAILED`、`details.exceptionType`；
- **D26（前置·值，本次新增）**：`enum` / `type` 取值非法 → `details.invalid:[{key,expected,got}]`。

涉及文件（7 个，均已同步至 **repo 与宿主 `connectors/skills/connector-winvm/` 两侧**）：`winvm-orchestrator`、
`winvm-mcp-reference`、`winvm-system-admin`、`winvm-app-manager`、`winvm-app-operation`、`winvm-gui-automation`、
`winvm-storage-manager` 的 `SKILL.md`。

---

## 4. 变更清单（本文件涉及）

| 文件 | 变更 |
|---|---|
| `packages/vm-capabilities/psmod/app.ps1` | D25：表头定列 + 显示宽度补偿 + fail-loud（`:70`–`:193`） |
| `packages/vm-capabilities/psmod/ps-bridge.ps1` | D25-②：`Test-ParameterBindingException`（`:65`）+ catch 映射（`:212`）；D26：注释范围校正（`:204`–`:211`） |
| `packages/adapter-agent-workbuddy/src/index.ts` | D24（前置·名）+ D26（前置·值：`enum` 忽略大小写 / `type` PS 可强转性 + `details.invalid`）；`DOMAIN_CODE_TO_BASE` 未改 |
| `tests/unit/cl017-param-value.test.js` | D26 回归（**表驱动 34 例**，含裁决 B 显式回归） |
| `tests/unit/cl017-winget-parse.test.js` | D25 回归（新增） |
| `tests/unit/cl017-error-reason.test.js` | D25-② 回归（新增 3 例） |
| `skills/{winvm-orchestrator,winvm-mcp-reference,winvm-system-admin,winvm-app-manager,winvm-app-operation,winvm-gui-automation,winvm-storage-manager}/SKILL.md` | D26：`details.invalid` 与「取值非法」子场景同步（7 文件，repo + 宿主双向） |
| 宿主 `~/.workbuddy/connectors/skills/connector-winvm/**` | 与 repo `skills/**` 逐字节同步（A12 PASS） |

# CL-016 · QA 独立验证报告（审批闸 UX · L2/L3）

> 验证者：QA 严过关 ｜ 日期：2026-09-15（第 1 轮）· 2026-09-16（第 2 轮复跑）
> 立场：**独立验证**（未参与实现，不采信任何自述；一切以亲手执行/亲手读码为准）
> 权威输入：`REQUIREMENT.md`（§5/§8）、`TECHNICAL-SOLUTION.md`、`DELIVERY.md`（**待验证主张**）
> 判定规则（PRD §8）：D1–D13 全 PASS → 完成；任一 FAIL → 升级 blocker。

---

## 0. 最终判定（第 2 轮后）

- **D1–D13 全 PASS（13/13）** → **可交付（GO）**。
- 第 1 轮的 FAIL（D5 凭据红线）**已由本轮修复闭合**：本轮以**定向证伪**（非复跑工程师路径）复验 —— harness **19/19 PASS**。
- 附**两项文档级 open nit**（不阻塞交付，见 §4b）+ **一项已声明的范围外残余 R1**（`progress[]`，见 §4c）。
- 交付前置：真机 `npm i && npm run build` 后逐文件复跑全部 `tests/unit/*.test.{js,mjs}`（离线沙箱不可复现，见 §3）。

---

## 1. 验证方法与可信度声明

**沙箱约束（如实计入，非代码缺陷）**：无 `node_modules`/`dist`/`tsc`；`git`/`rm` 不可用；仓库根 `grep` 对**多分支正则 `a|b` 会偶发假阴性**，故关键结论一律**单模式 grep + Read 复核**。

**真实执行手段（非静态审查）**：Node 24 类型擦除直跑真实 TS —— 把 **现版** `tools.ts` / `approval-audit.ts` **原文**复制到仓库外 `$HOME/.cache/cl016qa/`（仅将内部 `./approval-audit.js` 改写为 `./approval-audit.ts` 以离线解析，**零逻辑改动**；stub `@winvm/contracts` 提供 `RISK_LEVELS=['L0'..'L3']`，与 `packages/contracts/src/risk.ts:12` 逐字一致），harness 调用真实 `extractApproval` / `createA2aBridgeTools` 的 delegate 与 task.get handler / 审计函数。

| 轮次 | 结果 |
|---|---|
| 第 1 轮（改前） | 22 PASS / **2 FAIL**（D5 凭据泄漏，`approval.preview` 原样回显明文） |
| 第 2 轮（改后） | **19 PASS / 0 FAIL**；≥10 项断言对 D5 做定向证伪，另有 3 条探测记录边界 |

---

## 2. 逐条门禁判定表（D1–D13 · 第 2 轮）

| 门禁 | 结论 | 证据（文件:行号 / 命令 + 关键事实） |
|---|---|---|
| **D1** A2A 载荷含 `impact`/`preview` 且与 VM 下发逐项一致 | **PASS** | VM 形状 `task-store.ts:181-191`；桥字段名/形状逐一对应 `tools.ts:104-158`；**真实执行**：完整 fixture `preview` `deepEqual` 通过、3 项 impact **顺序与字符串全等**；无凭据键时 impact/preview **未被脱敏破坏**（A1/A2 深等成立）。 |
| **D2** 两通道续跑提示不串用（A2A 无 `__approvalId`） | **PASS** | **真实执行**：`buildA2aResumeHint`/`withA2aResumeHint` 输出、delegate 全量 `JSON.stringify` **均无 `__approvalId`**。全仓该串仅存于注释（`tools.ts:47`）/文档对照/MCP 侧。 |
| **D3** 缺字段宽容降级，既有 fixture 与断言不破 | **PASS** | **真实执行**：极简 fixture（`:43-69`，无 `type`）仍返回 `approvalId`+非空 `message`、`impact/preview` 缺省、无 `undefined`；`type` 非 approval-request → undefined。追加用例在 `:461` 分隔之后。 |
| **D4** 可读摘要与影响清单并存；七槽非空且 A2A 不劣于 MCP | **PASS** | **真实执行**：`summary` 与 `impact` 并存；A2A 字段集 `{approvalId,message,risk,capabilityId,kind,summary,impact,preview,resumeHint}` **⊇ MCP 的 6 项**（`server.ts:230-237`）。 |
| **D5** 审批承载物无凭据（结构化 + 呈现文本 + 审计） | **PASS**（本轮闭合） | 见 §4a：三承载物（`approval` 结构化对象 / 卡片呈现文本 `content[0].text` / 审计行）**均无明文**；定向证伪（嵌套/键名变体/数组/impact/端到端）全绿。 |
| **D6** 模板唯一、7 槽完备、纯文本可读 | **PASS** | 三唯一串各 **=1**（`APPROVAL-CARD-TEMPLATE`/L2 首行/L3 首行，均 `approval-card.md`）；7 槽 `:16-26` 齐备；卡片在 ```text``` 块内、关键信息不依赖表格。 |
| **D7** 对照表齐备、有降级文案、「展示先于执行」在位 | **PASS** | 对照表 `:80-89`；6 条降级固定串 `:93-100`；`:7` 明写「未经展示与用户确认不得执行」；无「可跳过/可自动批准」正向表述。 |
| **D8** L2/L3 分层；L3 二次确认 + dry-run 前置（缺则阻断） | **PASS** | L2 `:11-35` / L3 `:39-61`；L3 含「不可逆」`:50` + 完整确认短句 `:54-56`；缺预览阻断态 `:65-74`；`orchestrator/SKILL.md:176` 引用。 |
| **D9** 可逆性如实、未注册能力无卡片、L1 不弹卡 | **PASS** | `:104-113` 删除族默认「可逆·回收站还原」；`storage-manager/SKILL.md:93` 同源；`:117-124` 未注册能力无卡 + L0/L1 不弹卡。 |
| **D10** 6 份 Skill 引用齐全 + gui/mcp-reference 补齐 + 无绕过表述 | **PASS** | 6/6 引用行（`唯一正文` 单模式 grep：`app-manager:84`/`app-operation:150`/`gui-automation:106`/`orchestrator:141`/`storage-manager:84`/`system-admin:86`）；`gui-automation:114-125`、`mcp-reference:78-96` 齐；`跳过审批/免审批/自动批准/直接执行不确认` 全仓 0 命中。 |
| **D11** 三路径文案互不混淆；「超时 ≠ 批准」 | **PASS** | **真实执行**三终止串互斥、timeout 含「挂起+未获批准+不会被执行」；全仓无「超时默认批准」。 |
| **D12** 审计可还原 `approvalId`↔`traceId`，含预览哈希与四态 | **PASS** | **真实执行**：双向可查；**换 traceId 更新时旧桶摘除**、同 trace 不重复；`previewHash` 稳定/敏感/64hex；五值可辨。 |
| **D13** Windows/macOS 宿主与 VM 侧零改动；214 基线不破 | **PASS**（含部分无法验证） | **mtime 取证**：`vm-service/a2a-framework/vm-capabilities/mcp-framework/contracts` 均停留 `2026-09-10`（未动）；`host-a2a-bridge/src` 无 `process.platform`；214 基线不可执行（§3）。 |

---

## 3. 无法验证项（环境限制，**非 PASS，也非缺陷**）

| # | 项 | 原因 | 间接证据 |
|---|---|---|---|
| U1 | `node --test` 逐文件全绿 | 无 `node_modules`/`dist` → `import '@winvm/*'` 报 `ERR_MODULE_NOT_FOUND`（9 文件同因） | 真实源码 harness 19/19；`node --check` 两 `.js` 语法通过 |
| U2 | 既有 214 断言逐条未改（NFR-5） | 无 `git`/基线副本，无法 diff | append-only 分隔存在、既有 `describe` 段完整；**不能证明零改动** |
| U3 | TS 类型检查 | 无 `tsc` | `index.ts:34-45` 新增导出名与实现一致、`tools.ts:12-18` 导入源存在 |
| U4 | VM 运行时是否真填 `preview`/`impact` | 生产 provider 实现不在本仓 | 契约 `bridge.ts:70-78` + `task-store.ts:181-191` + PRD F4 |

---

## 4. 第 2 轮定向证伪结果

### 4a. D5 复验（**19/19 PASS**）—— 定向证伪，非复跑工程师路径

| 证伪向量 | 结果 | 证据 |
|---|---|---|
| **嵌套深层** `preview.params.creds.password` / `preview.params.items[0].token` | ✅ 打码 | `redactCredentials` 递归 `approval-audit.ts:53-65`；实测嵌套值与数组元素内层键均 `***REDACTED***`，同层 `user:'alice'`/`id:7` 原样 |
| **键名变体** `PassWord` / `private_key` / `api_key` | ✅ 打码 | 正则 `i` 标志 → 大小写不敏感 |
| **数组值在凭据键下** `preview.tokens:['T1','T2']` | ✅ 逐元素打码 | 数组元素继承父键名（`:58`） |
| **`impact` 内 `passphrase=xxx`** | ✅ 打码；纯路径项逐字不变、顺序保持 | `redactImpactItem` `tools.ts:36-42`（按 `=` 前 key 判定） |
| **文本** `message`/`summary` 中 `password: xxx` | ✅ `password=***REDACTED***` | `scrubText` `tools.ts:30-33` |
| **端到端** `a2a.delegate` / `a2a.task.get` 全量 `JSON.stringify` | ✅ 无任一哨兵 | 哨兵置于审批载荷（preview/impact/message）时 |
| **不过度脱敏**（A1/A2 深等未破） | ✅ | 非凭据 `preview` `deepEqual` 通过；纯路径 impact 逐字未变 |
| **审计侧** `canonicalJson` 并集剔除 + 入口双重剔除 | ✅ | `approval-audit.ts:75-88,145-150` |
| **#2 闭合** `isRecord` 排除数组 | ✅ | `tools.ts:23-25`；`preview:[1,2]` → 字段省略；data part 为数组 → 不识别 |

> 印证设计取舍：**不复用 `core.redact()` 是正确的** —— ① `core.redact()` 对超长 base64 截断（`chain.ts:50-52`）会**破坏 A1/A2 逐项深等**；② `core` 是宿主公共审计模块，改它会**改变 win32/darwin 宿主审计行为 → 违 NFR-4**。本轮在 CL-016 包内自建同形函数，合规且不扰动既有审计。

### 4b. 仍开着的**文档级 nit**（不阻塞交付）

| # | 位置 | 现象 | 期望 |
|---|---|---|---|
| **N1** | `packages/host-a2a-bridge/src/approval-audit.ts:93` | `canonicalJson()` 的 JSDoc 仍只列 **5 个键名**（password/privateKey/passphrase/token/secret），未跟上并集口径 | 改为「剔除凭据键：见 `CREDENTIAL_KEY_RE`（并集口径，大小写不敏感）」（**当前未改**） |
| **N2** | `docs/changes/CL-016/DELIVERY.md` §已知风险 | **未补**第 4 条残余（core 正则口径）——全文 `SENSITIVE_KEY_RE` 0 命中 | 补一条；并**更正事实**：`core` 的 `SENSITIVE_KEY_RE`（`core/src/audit/chain.ts:42`）**已含** apikey/api_key/credential，与 CL-016 的**唯一差集是 `passphrase`**（CL-016 = core ∪ {passphrase}） |

### 4c. 已声明的**范围外残余**（供决策，非 D5 阻断）

- **R1 · `progress[]` 文本未清洗**：实测 —— 把凭据哨兵放进**同消息的 text part**（而非审批 data part）时，`structuredContent.progress[]` 携带明文 → 整个 `JSON.stringify(res)` 含哨兵；而 `approval` 对象与 `content[0].text`（卡片文本）**仍为已脱敏**。**注**：`progress[]` 属 VM 执行进度日志、非审批承载物，且 VM 审批 text part 实际只含 `操作：<capabilityId>`/`说明：<summary>`（`task-store.ts:172-180`）不含原始参数 → 现实可利用性低。已在 `DELIVERY.md:130` 声明为范围外。
  - 可选低成本加固：`tools.ts` delegate 循环把 `progress.push({message: text})` 改为 `scrubText(text)`（若产品接受该范围扩边）。
- **R2 · artifact 段未清洗**（`artifactToContents`，非审批载荷）——同 `DELIVERY.md:130`，范围外。
- **R3 · `impact` 粒度**：仅 `key=value` 且 key 命中者打码，纯路径项保留 —— 符合 A1/A2（`DELIVERY.md:131`）。
- **R4 · MCP 直调 `preview.params` 由 VM 侧产出**，本轮不改（受 VM 零改动约束）——`DELIVERY.md:129`。

---

## 5. 改动集核对

本轮（第 2 轮修复）新增/修改集中在 `packages/host-a2a-bridge/src/{tools,approval-audit,index}.ts` + 两个测试文件 + `skills/winvm-orchestrator/SKILL.md`（`:150-151` 已更新为 8 字段 + 脱敏说明）。**VM 侧与契约 mtime 仍为 `2026-09-10`（未动）** → NFR-1/3/4 成立（§2 D13）。

## 6. 复现命令

```bash
node --check tests/unit/host-a2a-bridge.test.js && node --check tests/unit/approval-audit.test.js
# 唯一性（single-pattern）: grep -rn "APPROVAL-CARD-TEMPLATE" skills/  -> 1 file
# 真实源码离线执行（仓库外）:
#   WD=$HOME/.cache/cl016qa ; cp packages/host-a2a-bridge/src/{tools,approval-audit}.ts $WD/
#   node -e '改写 tools.ts 内 "./approval-audit.js" -> "./approval-audit.ts"'
#   node $WD/harness.mjs            -> 19 passed / 0 failed
#   node $WD/probe_residual.mjs     -> 定位 progress[] 残余
```

---

## 7. 结论

- **D1–D13 全 PASS（13/13）→ 可交付（GO）**。第 1 轮唯一 blocker（D5）经本轮**定向证伪**复验闭合（19/19）。
- **未发现**任何绕过审批、超时默认批准、协议破坏、VM 侧/契约越界改动；**未发现新的漏脱敏入口**（新增的嵌套/键名变体/数组/impact/文本诸路径均命中并打码）。
- 剩余为 **2 项文档 nit（N1/N2）** 与 **4 条已声明残余（R1–R4，范围外）**，均**不阻塞交付**；建议随下次变更顺手闭合 N1/N2，并考虑低成本加固 R1。
- 交付前置：联网机真机构建后逐文件复跑 `tests/unit/*.test.{js,mjs}` 与 TS 类型检查（离线沙箱不可复现）。

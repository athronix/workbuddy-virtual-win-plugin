# CL-016 交付报告 · 审批闸 UX（L2/L3）· 两通道审批上下文拉平

> 变更标识：`CL-016` ｜ 性质：新增产品能力（**审批闸 UX / 可理解性**，纯增量）
> 场景：宿主 WorkBuddy 插件经**两条通道**操作 Windows VM —— **MCP 直调**（`winvm` 连接器）与 **A2A 委派**（`winvm-a2a` 桥）
> 不变量：**VM 侧（Windows）零改动；Windows/macOS 宿主零行为回归；不改 MCP/A2A 协议方法名、端点与既有字段语义；`packages/contracts` 零改动**
> 上游：`docs/changes/CL-016/REQUIREMENT.md`（PRD）＋ 架构师系统设计（T2/T1/T3/T4 任务分解）

## TL;DR

本轮把「同一件 L2/L3 操作，走 MCP 直调看得到影响清单、走 A2A 委派只剩一句人话」的**信息不对称抹平**：宿主 A2A 桥不再丢弃 VM 已下发的 `preview`/`impact`，新增一套**唯一**的 L2/L3 审批卡片模板供 6 域 Skill 引用，并补上「审批载荷排查」「三终止文案」「宿主侧审批留痕（预览哈希 + 四态）」三处收口。F1–F12 与 T2–T4 全部落地；**未新增能力、未动协议、VM 侧零改动**。

## 交付概览（需求池覆盖）

| 需求 ID | 需求 | 状态 | 落点 |
|---|---|---|---|
| CL016-P0-01 | A2A 审批载荷补齐（`impact`/`preview`/通道正确续跑提示），与 MCP 等价 | ✅ | `packages/host-a2a-bridge/src/tools.ts`（`extractApproval` 透传 + `buildA2aResumeHint`/`withA2aResumeHint`） |
| CL016-P0-02 | 统一「审批卡片」呈现规格（纯文本/Markdown 模板） | ✅ | `skills/winvm-orchestrator/approval-card.md`（唯一正文） |
| CL016-P0-03 | 分层展示规则（L2 vs L3；L3 二次确认 + dry-run 前置） | ✅ | `approval-card.md` §1/§2/§3；`winvm-orchestrator`、`winvm-system-admin` 规则引用 |
| CL016-P1-01 | 总控 + 5 域 Skill 统一引用；补 `gui-automation`/`mcp-reference` 审批指引 | ✅ | 6 份 SKILL.md 引用行 + `winvm-gui-automation` 跨域升级说明 + `winvm-mcp-reference` 排查小节 |
| CL016-P1-02 | 拒绝 / 超时 / 取消 三种终止路径的用户可见文案 | ✅ | `packages/host-a2a-bridge/src/tools.ts`（`delegate` 分级 summary） |
| CL016-P2-01 | 审批上下文审计留痕（`approvalId` ↔ `traceId` 互查 + 预览哈希） | ✅ | `packages/host-a2a-bridge/src/approval-audit.ts`（宿主侧降级形态） |

> 计数：**P0 × 3、P1 × 2、P2 × 1 → 6/6 ✅**。

## 验收对照（PRD §5 CL016-P0-01 · A1–A8）

| # | 验收项 | 本轮落点 | 状态 |
|---|---|---|---|
| A1 | A2A 审批返回结构化影响清单（逐项与 VM 下发一致） | `extractApproval` 透传 `impact`（顺序与字符串全等） | ✅ |
| A2 | A2A 审批返回 dry-run 预览（深等；未下发时省略，不抛错/不输出 `undefined`） | `extractApproval` 透传 `preview` | ✅ |
| A3 | 续跑提示按通道给对语义；A2A 中不得出现 `__approvalId` | `buildA2aResumeHint` / `withA2aResumeHint` | ✅ |
| A4 | 可读摘要与影响清单并存；摘要缺失回落文本首段 | `deriveSummary`（`data.summary` → `说明：`行 → text 首行） | ✅ |
| A5 | 信息量不劣于 MCP（7 槽位 A2A 侧均非空） | Skill 模板槽位 + 桥透传 | ✅ |
| A6 | 字段缺失时宽容降级（不破既有断言） | `type` 缺失放行 + 条件展开省略 | ✅ |
| A7 | 凭据不入载荷 / 呈现 | 模板填充红线 + `canonicalJson` 凭据剔除（审计侧） | ✅ |
| A8 | 审批闸不可绕过语义不变 | 桥侧只写 `pending`，无旁路 | ✅ |

## 用户故事覆盖（PRD §4 · US-1–US-7）

| US | 场景 | 本轮覆盖 |
|---|---|---|
| US-1 | MCP 直调 L2（删旧日志） | 模板 L2 版 + `storage.file.delete` 可逆性规则 |
| US-2 | A2A 委派 L2（清理 C 盘） | 桥透传 `impact`/`preview` → 卡片 7 槽非空 |
| US-3 | L3 高危（重启 VM） | 模板 L3 版 + 二次确认短句 + 缺 dry-run 阻断 |
| US-4 | 用户拒绝 | `delegate` rejected 文案「未执行任何变更」 |
| US-5 | 审批超时（fail-closed） | `delegate` timedOut 文案「审批未获批准」 |
| US-6 | GUI 域 L2（导出覆盖原图） | `winvm-gui-automation` 跨域升级说明 + 示例卡片要点 |
| US-7 | 审批信息完整性自检 | `winvm-mcp-reference` 审批载荷排查小节 |

## 文件清单

**新增**
- `skills/winvm-orchestrator/approval-card.md` — 审批卡片**唯一正文**（L2 版 / L3 版 / L3 阻断态 / 槽位来源表 / 可逆性规则 / 不弹卡清单 / 填充红线 / 两通道续跑指令）
- `packages/host-a2a-bridge/src/approval-audit.ts` — 宿主侧审批留痕（`canonicalJson`、`hashApprovalPreview`、`recordHostApprovalAudit`、双向查询、`_resetAuditIndex`）
- `tests/unit/approval-audit.test.js` — 留痕单测（哈希稳定/敏感、键序无关、凭据哨兵、双向可查、四态可辨）
- `docs/changes/CL-016/DELIVERY.md` — 本文件

**修改（代码）**
- `packages/host-a2a-bridge/src/tools.ts` — `ExtractedApproval` 追加全可选字段（`kind`/`summary`/`impact`/`preview`/`resumeHint`）；`extractApproval()` 改写为**原样透传 + 向后兼容**；新增两个导出函数；`delegate`/`a2a.task.get` 组装点补挂续跑提示与留痕；三终止文案分级
- `packages/host-a2a-bridge/src/index.ts` — 导出新函数与类型
- `tests/unit/host-a2a-bridge.test.js` — **只追加**用例（透传深等、续跑串不含 `__approvalId`、三终止文案互斥、A6 极简 fixture 回归、留痕 pending），未改既有断言

**修改（Skill 呈现层）**
- `skills/winvm-orchestrator/SKILL.md` — §审批闸协议加统一引用行 + L3 规则引用（指向模板 §2/§3）
- `skills/winvm-system-admin/SKILL.md` — §高危清单加引用行 + 「展示现状/进程清单/旧值」归位到模板槽位
- `skills/winvm-storage-manager/SKILL.md` — §高危清单加引用行 + 可逆性规则 + `storage.volume.destructive` V1 未注册不弹卡
- `skills/winvm-app-manager/SKILL.md` — §高危清单加引用行 + 「应用名/版本/影响范围」归位到槽位
- `skills/winvm-app-operation/SKILL.md` — §高危清单加引用行（形状对齐）
- `skills/winvm-gui-automation/SKILL.md` — §高危清单加引用行 + 本域最高 L1/跨域 L2 说明 + 「导出并覆盖源文件」示例卡片要点
- `skills/winvm-mcp-reference/SKILL.md` — 新增「审批载荷排查」小节（残缺判定 + 两通道续跑差异表），**不写引用行**

**修改（设计文档）**
- `docs/02-design/INTERFACES.md` — §3.5 追加「宿主桥义务」段（原样透传 + 按通道续跑）
- `docs/02-design/SECURITY-GOVERNANCE.md` — §3.3 审批结果改**四态**并补 `previewHash` 归属；§3.4 补 fail-closed **成立方式**与「V1 未实现 TTL 回收」

## 关键实现决定

1. **缺数据「原样透传 vs 省略」规则（唯一规则）**：`impact`/`preview` **存在且类型合法 → 原样透传（含空数组 `[]` / 空对象 `{}`）；不存在或类型非法 → 省略该字段**。合法性：`impact` = `Array.isArray && every(typeof === 'string')`；`preview` = `isRecord`。全链路用条件展开 `...(cond ? { k: v } : {})`，**不输出 `undefined` 字面量**。
2. **向后兼容怎么落的**：识别条件为 `data.type === 'approval-request'` **或 `data.type` 缺失但 `approvalId` 为字符串**（既有 fixture 无 `type`，路径 `tests/unit/host-a2a-bridge.test.js:42-68` 原样通过）；仅当 `type` 存在且 ≠ `approval-request` 时才跳过。`message` 语义保持不变；`summary` 派生优先级 `data.summary` → 同消息 `说明：` 行 → text 首行。
3. **通道隔离（A2A 无 `__approvalId`）**：`resumeHint` 由桥合成，逐字含 `a2a.approval.reply`；A2A 通道输出**绝不出现** `__approvalId`（`__approvalId` 仅作 MCP 通道标记，出现在模板文档的对照说明里）。`withA2aResumeHint` 幂等。
4. **可逆性判定归 Skill（呈现）层**：代码**不硬编码**可逆性；由模板 §6 规则在呈现层判定 —— 删除族默认「可逆（回收站还原）」；`preview.params.permanent === true` → 「不可逆」；`risk === 'L3'` → 「不可逆 / 无法自动回滚」；未知 → 「未知 —— 按不可逆处理」。
5. **审计降级宿主侧**：预览哈希与审批四态记录落在**宿主侧**（`packages/host-a2a-bridge/src/approval-audit.ts`），不改 VM 侧、不落盘（内存索引）；`previewHash = sha256(canonicalJson({ capabilityId, risk, preview, impact }))`；`canonicalJson` 键排序并按 **`CREDENTIAL_KEY_RE`（并集口径，唯一来源）剔除凭据键**，`recordHostApprovalAudit` 入口**再剔一次**（双重）；桥侧只写 `pending`，**绝不自行判定 `approved = true`**。

## 数据流：A2A 审批载荷拉平前后

**拉平前**：VM `task-store.approvalMessage()` 已下发 text（人话说明 + 续跑指引）与 data part（`{ type: 'approval-request', approvalId, capabilityId, risk, preview, impact }`）→ 宿主桥 `extractApproval()` **只读 4 字段，丢弃 `preview`/`impact`** → 宿主只剩一句人话摘要。

**拉平后**：同一 data part → 宿主桥 `extractApproval()` 按唯一规则**原样透传** `preview`/`impact`（含空 `[]`/`{}`），派生 `summary`、标注 `kind`；组装点再补挂 `resumeHint`（A2A 语义）与宿主侧 `approvalAudit` → 宿主拿到与 MCP 等价的审批上下文，照模板填空即得卡片。

> **缺口归属**：这不是 VM→宿主的数据缺失，而是**宿主桥读取时的丢弃**；因此修复全部落在宿主侧，VM 零改动。

## T2 / T3 交付明细（逐文件）

**T2 · 审批卡片模板（`skills/winvm-orchestrator/approval-card.md`）**
- 顶部哨兵行 `<!-- APPROVAL-CARD-TEMPLATE v1 · 唯一正文 · 不得复制 -->`；L2 版首行逐字 `🔐 需要你确认（L2 破坏性操作）`；L3 版首行逐字 `⛔ 高危操作，需要二次确认（L3）`；L3 阻断态首行逐字 `⛔ 高危操作已阻断：dry-run 预览未就绪，无法进入确认流程。`
- 含 7 槽（操作 / 目标 / 通道 / 风险 / 影响清单 / 可逆性 / dry-run 预览）+ 审批 ID 与续跑方式；槽位↔数据来源对照表（MCP / A2A 两列 + 降级文案列）；可逆性判定规则；不弹卡清单（L0/L1、未注册能力）；填充红线；降级固定串；两通道续跑指令各一行。
- 第 5 行统一为 Markdown 相对链接形式；**全仓唯一正文，其它 Skill 只引用不复制**。

**T3 · 6 份 Skill 引用 + 2 个空白域补齐**
- 6 份编号 Skill（`winvm-orchestrator`、`winvm-system-admin`、`winvm-storage-manager`、`winvm-app-manager`、`winvm-app-operation`、`winvm-gui-automation`）各加 1 条逐字引用行；`winvm-orchestrator` 用同目录形式（`./approval-card.md`），其余用相对形式（`../winvm-orchestrator/approval-card.md`）。
- 空白域 A（`winvm-gui-automation`）：声明本域能力最高 L1、GUI 自身不产生 L2/L3 卡片，但经 A2A 委派的多步 GUI 任务可能命中跨域 L2 步骤（如 `appops.gui.produce` 覆盖写盘）→ 按模板出卡；给「导出并覆盖源文件」示例卡片要点。
- 空白域 B（`winvm-mcp-reference`）：新增「审批载荷排查」小节 —— ① 残缺失判定（缺 `impact` = 宿主桥未透传 / 桥版本过旧）；② 两通道续跑方式差异速查表。该文件**不写引用行**。
- 约束符合：diff 仅落在审批呈现相关章节；未增删能力 ID、未改任何风险等级、未动 `id`/`domains`/`triggers`。

## 验证情况（如实）

**已通过**
- `node --check tests/unit/host-a2a-bridge.test.js`、`node --check tests/unit/approval-audit.test.js` ✅（`.js` 语法检查）
- **唯一性三 grep**：《`APPROVAL-CARD-TEMPLATE` 命中文件数 = 1；`🔐 需要你确认（L2 破坏性操作）` = 1；`⛔ 高危操作，需要二次确认（L3）` = 1》✅
- **引用齐全（逐成员核）**：`winvm-orchestrator` / `winvm-system-admin` / `winvm-storage-manager` / `winvm-app-manager` / `winvm-app-operation` / `winvm-gui-automation` **各 ≥1**（逐个 `grep -c` = 2/1/1/1/1）；全仓 `approval-card.md` 命中 = **7**（6 Skill + 模板自身）✅
- **静态自查**：TS 无 `tsc` 可用，逐行静态审查（导入路径/导出名一致、无循环依赖、条件展开正确、无 `undefined` 字面量、零第三方依赖 = 仅 `node:crypto`）；跨仓一致性复查未发现外部消费者被破坏
- **真实源码离线执行（D5 修复自证）**：把 `tools.ts` / `approval-audit.ts` **原文**复制到**仓库外**临时目录（仅将内部 `./approval-audit.js` 改写为 `.ts` 以便离线解析，**零逻辑改动**），用 stub 提供 `@winvm/contracts`（`RISK_LEVELS`/`A2A`），在 **Node 24 类型擦除**下直跑真实 `extractApproval` / `buildA2aResumeHint` / `createA2aBridgeTools` 与 `canonicalJson` / `redactCredentials` → **10/10 断言 PASS**（A7 凭据在 preview / impact / 文本三类载体均脱敏；A1/A2 非凭据内容深等不变；A3 续跑串；A6 向后兼容；统一并集正则）✅
- **外部独立验证（QA 复跑 · 本轮唯一外部证据）**：QA 严过关独立复跑 → **D5 闭合 = PASS，D1–D13 全 PASS（13/13），判定 GO（可交付）**；其 harness **19/19** 通过（嵌套深层 / 键名变体 / 数组值 / `impact` / 文本五条路径全命中，且**未过度脱敏**）。

**未能通过 / 未执行（环境限制，非代码缺陷）**
- `node --test` **无法运行**：本离线沙箱**无 `node_modules`、无 `dist`**，`import '@winvm/*'` 的测试文件报 `ERR_MODULE_NOT_FOUND`。受影响文件共 **9 个**（`host-a2a-bridge.test.js`、`approval-audit.test.js` 等），**同因**。
- **TS 无 `tsc` 可用**：`packages/*/src/*.ts` 仅做静态审查，未做类型编译。
- → **真机执行 `npm i && npm run build` 后需复跑**：全部 `tests/unit/*.test.{js,mjs}`（含本轮新增用例）与 TS 类型检查。

## Q5 · 测试文件计数订正（单行）

`tests/unit/` 基线为 **23** 个测试文件（CL-015 文档记为 20，属既有文档债）；本轮 CL-016 新增 `approval-audit.test.js` 后为 **24** 个。**本轮不做索引收口**（`.dev/`、测试计数不重开范围）。

## 已知风险 / 遗留

- **模板唯一性靠人工纪律**：`approval-card.md` 为唯一正文，其它 Skill 只写引用行、不得复制正文；后续若有副本漂移，需人工/校验脚本兜底。
- **`extractApproval` 对未知 `type` 的处理策略**：现要求 `type === undefined`（向后兼容）或 `type === 'approval-request'`；若 VM 未来新增其它携带 `approvalId` 的 `type` 值，需重新评估是否放行。
- **审批记录的显式 TTL 回收 / 过期作废未实现**（V1）：fail-closed 由「未获批准即不执行」成立，不依赖主动回收（见 `SECURITY-GOVERNANCE.md` §3.4）。
- **真机复跑项**：`npm i && npm run build` 后的全量单测与类型检查（离线沙箱不可复现）。
- **MCP 通道凭据由 VM 侧产出（本轮不改）**：MCP 直调的 `approval.preview.params` 由 `vm-service` 侧生成，本轮仅修**宿主 A2A 桥**的脱敏（受「VM 侧零改动」约束）；当前 L2/L3 能力**无凭据类参数**（全仓 `password/privateKey/passphrase/token` 在 `vm-capabilities` 命中 0），故可利用性有限。
- **未纳入脱敏的载体（范围外）**：`content` 中 artifact 段（VM 执行过程产物，非审批载荷）未做凭据清洗；若未来引入凭据类参数需一并覆盖。（`progress[]` 已于本轮 R1 闭合 —— 同源文本经 `scrubText()` 清洗。）
- **`impact` 脱敏粒度**：仅对 `key=value` 形式中 **key 命中凭据正则**的项打码（如 `password=…` → `password=***REDACTED***`）；非 `key=value` 形式（如纯路径项）原样保留。
- **R4（既有缺口，本轮范围外）**：`packages/core/src/audit/chain.ts` 的 `SENSITIVE_KEY_RE` 与 CL-016 的 `CREDENTIAL_KEY_RE` **唯一差集为 `passphrase`**（即 `CREDENTIAL_KEY_RE` = `SENSITIVE_KEY_RE` ∪ {`passphrase`}）。core 审计链因此不覆盖 `passphrase` 类键。**本轮不动 core** —— 修改它会改变 win32/darwin 宿主的审计脱敏行为，违反 NFR-4；记为**后续变更候选**。

## 硬约束符合性自检

| 约束 | 自检 |
|---|---|
| TS strict + ESM，零新增依赖 | ✅ 仅用 `node:crypto`（内置），无第三方包 |
| 不改协议方法名 / 端点 / 既有字段语义；`packages/contracts` 零改动 | ✅ 新字段全部可选、仅宿主桥包内扩展 |
| VM 侧零改动 | ✅ 未触碰 `vm-service` / `vm-capabilities` / `a2a-framework` |
| Windows/macOS 宿主零行为回归 | ✅ 未新增平台分支 |
| 审批闸不可绕过 | ✅ 无「跳过 / 自动批准」路径；桥侧只写 `pending` |
| `ExtractedApproval` 追加字段全可选 | ✅ 既有调用方行为不变 |
| no-bypass 表述扫描 | ✅ 全文无「跳过审批 / 免审批 / 自动批准 / 直接执行不确认」类建议 |

## 用户下一步建议

1. **真机构建复核**：联网机执行 `npm i && npm run build`，再逐文件复跑全部 `tests/unit/*.test.{js,mjs}`（离线沙箱无法复现含 `@winvm/*` 的 9 文件基线）。
2. **端到端冒烟**：分别走 MCP 直调与 A2A 委派触发同一 L2 意图，比对两侧 7 槽位是否等价；确认 A2A 结果中不含 `__approvalId`。
3. **L3 阻断态验证**：构造缺 `preview` 的 L3 审批，确认输出阻断态而非确认卡片。

## 零改动证明

- **VM 侧（Windows）**：`packages/vm-service`、`packages/vm-capabilities`、`packages/a2a-framework` **零改动** —— 本轮全部修复落在宿主桥与 Skill/文档层。
- **Windows/macOS 宿主**：不新增任何平台分支逻辑，**零行为回归**。
- **`packages/contracts`**：**零改动**（仅只读引用既有类型；`ExtractedApproval` 的扩展在宿主桥包内，且新增字段全部可选）。

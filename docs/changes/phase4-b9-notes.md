# Phase 4 · 批9 施工记录 —— 教学与登记诚实化（N-2/N-3/N-4/N-5/N-6）

> 施工日期：2026-10-14。依据 = `docs/audit/2026-10-14-full-audit.md` §1/§4 批9 处方。
> 提交：**48472da**（A+B docs）、**09d89b4**（C+D）、**9e77690**（E+F）、本件+台账为第四笔。
> 环境纪律全程遵守：git 全路径、单测逐文件（绝不整批 glob）、tsc -b 复验。

## 0. 事实底账（施工前亲验）

- A2A 服务端 dispatch（`packages/a2a-framework/src/server.ts:254-283`）实有面 =
  `message/send`、`message/stream`（SSE 引导）、`tasks/get|list|cancel|subscribe`、
  `agent/getAuthenticatedExtendedCard`；`tasks/resubscribe` **零命中**（全仓 git grep，除 audit/qa 留痕）。
- 审批应答真实通路（亲读三处对齐）：宿主工具 `a2a.approval.reply`
  （`packages/host-a2a-bridge/src/tools.ts:646-661`，required=[taskId, approvalId, approved]）
  → `client.replyApproval`（`client.ts:197-216`：`message/send` 携 `message.taskId` +
  parts data `{approvalId, approved}`）→ 服务端 `continueTask`（server.ts:344+）→ `tasks.resolveApproval`。
- `errors.ts` 封闭码集实测 **12 码**（含 ARCH-22 `TASK_CANCELED`、批1(c) `DELEGATION_REQUIRED`）；
  `DEFAULT_RETRYABLE` 穷举 12 项。
- `SECURITY-GOVERNANCE.md` §2.3（批1 终态口径权威源）要点：三处生产调用点已接线 ∧ 缺省灰度=
  `shadow`（评估+观测不执法）⇒ 不得读作已生效封顶/过滤闸；执法需显式 `WINVM_POLICY_GATE_WIRING=on`；
  (c) 直调收口缺省生效（独立开关 `WINVM_DELEGATION_REQUIRED_POLICY=on`）。

## 1. N-5（P1）三册假方法 `tasks/resubscribe` 改写 —— 改动前→后

| # | 文件:行（改前行号） | 改前 | 改后 |
|---|---|---|---|
| 1 | USER-MANUAL.md:56 | 你回复"继续/取消/改参数"，WorkBuddy 用 `tasks/resubscribe` 续跑 | 你批准后，WorkBuddy 经 `a2a.approval.reply` 应答（底层是带审批结果的 `message/send`），VM 服务端收到批准后续跑 |
| 1+ | USER-MANUAL.md:42 | 走 A2A：`tasks/send` → … | 走 A2A：`message/send` 委派 → …你批准后经 `a2a.approval.reply` 续跑（**加改**：`tasks/send` 同为服务端显式拒绝的废弃旧名，protocols.test.js:115 钉 MethodNotFound，属同一假方法教学族） |
| 2 | DEPLOYMENT.md:281 | 宿主确认后才 `tasks/resubscribe` 续跑 | 宿主经 `a2a.approval.reply`（底层=带审批结果的 `message/send`）批准后，服务端重放续跑；**新增一行**：纯 MCP 直调命中 L2/L3 ⇒ 服务端收口 `DELEGATION_REQUIRED`（批1(c)），不发放续跑令牌，须改走委派 |
| 3 | SCENARIOS.md:262 | 宿主确认后 resubscribe 续跑；超时 fail-closed 拒绝 | 宿主经 `a2a.approval.reply` 批准后服务端重放续跑；超时 fail-closed 拒绝 |
| 4 | SCENARIOS.md:277 Demo 块 | `PUT /a2a { "method":"tasks/resubscribe", … }` | `a2a.approval.reply { taskId, approvalId:"apr_8f3c", approved:true }` + 等价底层 JSON-RPC（`POST /a2a message/send` 携 `message.taskId` + `parts:[{kind:"data",data:{approvalId,approved}}]`）+ 服务端 continueTask→resolveApproval 注；VM 挂起响应行未动 |

**撞守卫预检**（任务书命令实跑，EXIT=1 零命中）：`tasks/resubscribe`/`resubscribe` 在 05-peripherals
之外（docs/README、overview、06-OVERVIEW、INSTALL-GUIDE、skills、tests、scripts）**零命中**；
`docs/audit/` 内命中为历史留痕（2026-10-08-product-audit J1/PM-22 等），按纪律不改。
改后全域复验：`grep -rn "resubscribe" docs/（排除 audit）skills/ tests/ scripts/ README.md overview.md` = 0 命中。

## 2. N-3（P2）批1 终态口径两处（+1 同族）

| 文件:行 | 改前 | 改后 |
|---|---|---|
| DEPLOYMENT.md:279 | 现状 2026-10-13 批0：声明记录于审计链、服务端执行面尚未接线＝Phase 3 批1 在建，不是已生效授权闸 | 现状 2026-10-14 批1 后：执行面**已接线**，但缺省灰度=`shadow`（只评估观测、不执法），**不得读作已生效授权闸**；执法需运维显式 `WINVM_POLICY_GATE_WIRING=on`，口径详见 §2.3 |
| SCENARIOS.md:153 | 批0 E-1：尚未接线（=Phase 3 批1 在建） | 批1 接线已落地·2026-10-14 订正：三处生产调用点已接线 ∧ 缺省 shadow 不执法 ∧ 不得读作已生效（执法需显式 on，口径见 §2.3）；补"真正拦阻=审批闸+直调 DELEGATION_REQUIRED 收口" |
| SCENARIOS.md:226（**加改**） | 批0 E-1：执行面尚未接线（批1 在建） | 同口径终态（§2.3 同源）——任务书点名两处之外 `git grep "批1 在建" -- docs/05-peripherals/` 实测的第 3 命中，同族同治 |

保留读法约束词族（已接线/shadow/不得读作/WINVM_POLICY_GATE_WIRING=on/§2.3）与 §2.3 权威源一致。

## 3. N-2（P1）INTERFACES §2.6 错误码表补齐 —— 核对结论

- 亲读 `errors.ts:16-46`：封闭集 **12 码**；原表 9 行缺 `UNSUPPORTED_GOAL`/`TASK_CANCELED`/
  `DELEGATION_REQUIRED` 三码，**拼写无其它出入**。
- 补三行（行序=枚举声明序）；`DELEGATION_REQUIRED` 可重试=否（语义注"须转委派，重试同一请求无益"）。
- **额外订正（任务书"retryable 列取实况值"授权范围内）**：原表 `TIMEOUT`「视能力」与
  `DEFAULT_RETRYABLE.TIMEOUT=true` 不符、`EXECUTION_FAILED`「视能力」与实值 `false` 不符 ⇒ 两行按
  实况改为 是/否（语义列补注"重跑必须重新委派"等）。INTERFACES.md:96 示例行
  `APPROVAL_REQUIRED retryable:true` 与实值一致，不动。
- 表头新增单源声明行（`> 单源=errors.ts…双向对账由 p4-b9-errcode-registration-pin 钉死`）。

## 4. N-6（P2）"封闭 10 码"数字复写消除

| 位置 | 改前 | 改后 |
|---|---|---|
| errors.ts:54 | `code` 是**契约层封闭 10 码** | `code` 是**契约层封闭码集（单源=本文件；对外登记见 docs/02-design/INTERFACES.md §2.6）** |
| errors.ts:58（**加改**，同文件同病灶） | 契约层 10 码与 `DEFAULT_RETRYABLE` 语义保持不变 | 契约层封闭码集与 `DEFAULT_RETRYABLE` 语义保持不变 |
| INSTALL-GUIDE.md:301 | 契约层 `code`（封闭 10 码，管重试/审批） | 契约层 `code`（封闭码集，单源 errors.ts、登记 §2.6，管重试/审批） |

改后 `npx tsc -b tsconfig.build.json` EXIT=0（注释面改动，编译复验通过）。
errors.ts:79「既有 10 码的取值逐字不变」= 历史变更陈述（指 CL-017 时点的存量码），非码集规模复写，保留。

## 5. N-4（P2）claims-guard 治理面扩收集

- `governanceDocs()`：fixed 追加 `docs/INSTALL-GUIDE.md`；目录追加 `collectMd('docs/05-peripherals')`、
  `collectMd('docs/04-ops')`。现量 **30 件**（5 固定 + 02-design 12 + skills 9 + 05-peripherals 3 +
  04-ops 1，实测脚本复算一致）；下限断言 ≥20 → **≥28**。
- **E-1 定性钉**收集面由 `collectMd('docs/02-design')` 换为 `governanceDocs()` 全集，两键承诺在外圈同钉。
- 判据词表（APPROVAL_CALIBER/CLAIM_CALIBER/E-1 豁免词）**零放宽**。
- 扩收集后新入文件 b/c/E-1 命中处置表（内存模拟判据全量扫描 + 11/11 实测绿双重确认）：

| 命中行 | 判据 | 处置 |
|---|---|---|
| DEPLOYMENT.md:279（maxRisk+授权/封顶词族） | E-1 | 已因本批 §2 改口携带「批1/§2.3/不得读作/声明记录」⇒ 天然豁免，零额外改动 |
| SCENARIOS.md:153（同上） | E-1 | 同上 |
| SCENARIOS.md:226（同上） | E-1 | 同上 |
| （`__approvalId`/`hostApproved`/`session-guard`/`Origin 校验` 在新五件） | b/c | **实测零命中**（grep 亲跑） |

## 6. E（新守卫）p4-b9-errcode-registration-pin.test.js

- 纯函数判据（仿 assembly-guard 打法）：`extractCodeSet`（errors.ts 联合成员 `| 'CODE'` 切片提取，
  下限 ≥12 防空转）↔ `extractTableRows`（§2.6 表 `| \`CODE\` |` 行提取，下限 ≥10 留变异余量）+
  `extractRetryable`（DEFAULT_RETRYABLE 实值表）。R1 缺码 / R2 幽灵码 / R3 retryable 漂移 /
  R4 数字复写钉（errors.ts+INSTALL-GUIDE 不含 `/封闭\s*\d+\s*码/`）。
- 变异自证 4 例（内存注入零写盘）：M1 删 TASK_CANCELED 行⇒R1 红；M2 加幽灵行⇒R2 红；
  M3 APPROVAL_REQUIRED 反写「否」⇒R3 红；M4 回写「封闭 10 码」⇒R4 红；SHA-256 三源基线自证没改盘。
- **进 ST3 门禁**（台账处方"进 ST3 门禁件"）：`scripts/gate.mjs` GATE_GUARD_FILES 追加
  `{file:'p4-b9-errcode-registration-pin.test.js', id:'errcode-registration-pin', why:…}`，
  `scripts/GATE-POLICY.md` 表同批双写登记。`phase2-dep-direction.test.js`（门禁表↔磁盘一致性守卫）32/32 绿。

## 7. 过关记录

| 件 | 结果 |
|---|---|
| `node --test tests/unit/p4-b9-errcode-registration-pin.test.js` | **8 pass / 0 fail** |
| `node --test tests/unit/phase3-skill-claims-guard.test.js` | **11 pass / 0 fail** |
| `node --test tests/unit/phase2-contract-code-fidelity.test.js` | **22 pass / 0 fail** |
| `node --test tests/unit/phase2-dep-direction.test.js`（门禁表一致性，扩表后复跑） | **32 pass / 0 fail** |
| docs 链接面：任务书所指 `docs-link-reachability` **件名不存在**；link 面实际两件 `link-workspace.test.js` **16/0**、`phase3-b2-deadlink-fix.test.js` **6/0** 全绿 |
| `PATH=… npx tsc -b tsconfig.build.json` | **EXIT=0** |
| 假方法教学全域 grep（排除 audit/qa 留痕） | **0 命中** |

## 8. 残留（不闭项如实登记）

| 级别 | 项 | 现场 | 建议去向 |
|---|---|---|---|
| P2 | `skills/winvm-mcp-reference/SKILL.md:83`、`skills/winvm-orchestrator/SKILL.md:352` 两处「封闭 10 码」表头**且表体只列 10 码**（缺 `TASK_CANCELED`/`DELEGATION_REQUIRED`） | 不在批9 处方点名面（D 项处方=errors.ts:54+INSTALL-GUIDE:301 两处）；新漂移钉 R4 收集面亦仅钉 errors.ts+INSTALL-GUIDE 两文件 ⇒ 该两表头暂不受钉。2026-10-12 audit-pm2 §SKILL 表 A/B 早有同案记录，未处置 | 批10 或随修小批：两 SKILL 码表补两码+去数字表头；可选把 R4/漂移钉收集面扩至 skills 码表（属扩判据面，需授权） |
| P3 | USER-MANUAL.md:55 `requiresApproval: true` 非实现字段形态（audit PM-22 同案遗留） | 不在批9 处方点名面（N-5 仅点名 resubscribe 四处） | 随 USER-MANUAL 下轮整订处理 |
| — | 台账 N-5 证据列"USER-MANUAL:42"的 `tasks/send` | **已闭**（§1 加改行 1+） | — |

## 9. 分笔提交

1. `48472da` docs(p4-b9): N-5 三册假方法改写 + N-3 批1终态口径（含 §D 两键注 SCENARIOS:226 加改）
2. `09d89b4` docs(p4-b9): N-2 §2.6 补三码 + N-6 数字复写消除
3. `9e77690` test(p4-b9): 漂移钉进门禁 + claims-guard 扩收集
4. （本笔）docs(p4-b9): 施工记录 + 台账批9 行完赛标记

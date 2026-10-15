# P4 批9 独立回归验证报告（教学与登记诚实化 · N-2/N-3/N-4/N-5/N-6）

- **QA**: 严过关（Edward）· 2026-10-15
- **被验对象**: commits `48472da` / `09d89b4` / `9e77690` / `f49377f`（HEAD=`f49377f`）
- **验证方式**: 全项亲跑，不采信工程师自报；变异注入仅内存/仅 wbtmp 副本，**仓库零写盘**（除本报告）

## 终判：**IS_PASS: YES**（V1–V7 全过；2 项 ⚠ 为非本轮处方面的登记完整性问题，路由批10，不阻塞）

---

## V1 六件测试文件逐件亲跑 ✅

| 文件 | 期望 | 实际（亲跑） | EXIT |
|---|---|---|---|
| p4-b9-errcode-registration-pin | 8 | **tests 8 / pass 8 / fail 0** | 0 |
| phase3-skill-claims-guard | 11 | **11 / 11 / 0** | 0 |
| phase2-contract-code-fidelity | 22 | **22 / 22 / 0** | 0 |
| phase2-dep-direction | 32 | **32 / 32 / 0** | 0 |
| link-workspace | 16 | **16 / 16 / 0** | 0 |
| phase3-b2-deadlink-fix | 6 | **6 / 6 / 0** | 0 |

全部逐件 `node --test tests/unit/<单文件>`，无 glob 整批（K-2 junction 0xC0000005 规避）。计数与工程师自报**逐一吻合**。

## V2 构建 ✅

`npx tsc -b tsconfig.build.json`（首次）EXIT=0；为排除管道掩码又跑 `--force` 增量重建：**TSC_EXIT=0，输出 0 行**（真全量编译通过）。

## V3 漂移钉活性反证（本次核心）✅ ACTIVE_GUARD_OK

判据实现（`checkRegistration` R1 缺码/R2 幽灵/R3 retryable 对账 + R4 数字钉 `/封闭\s*\d+\s*码/`）读毕；提取器全部带**非空+数量下限**前置断言（codes≥12、rows≥10、map≥12），indexOf=-1 型假绿路径被封死。

**独立变异注入**（wbtmp 脚本直调被测判据、内存副本、与测试件自带 M1–M4 用不同码/不同注入点）：

| 变异 | 期望 | 实际 | 结论 |
|---|---|---|---|
| 基线（未变异） | 全空 | `{"missing":[],"ghosts":[],"mismatch":[]}` | ✅ 前提成立 |
| ① 删表行 `DELEGATION_REQUIRED` | R1 红 | `missing=["DELEGATION_REQUIRED"]` | ✅ 点名精确 |
| ② 加幽灵行 `FAKE_CODE` | R2 红 | `ghosts=["FAKE_CODE"]` | ✅ 点名精确 |
| ③ `TIMEOUT` 可重试反写「否」 | R3 红 | `mismatch=["TIMEOUT：表写「否」但 DEFAULT_RETRYABLE=true"]` | ✅ 点名精确 |

自带 M1–M4 自证段核对：**确为"只因源码被改而红"**——M1 断言 `missing` 恰为被删单码、M2 断言 `ghosts` 恰为注入幽灵码、M3 断言 `mismatch.length===1` 且含 APPROVAL_REQUIRED、M4 双向断言（变异体命中正则 ∧ 真源不命中）；另有 SHA-256 三源基线自证未写盘。**非装饰品守卫。**

## V4 claims-guard 扩收集活性 ✅ ACTIVE（差分证明）

① 收集面读毕：`governanceDocs()` = 5 固定件（README/overview/06/GATE-POLICY/**INSTALL-GUIDE**）+ `docs/02-design`(12) + `skills`(9) + **`docs/05-peripherals`(3)** + **`docs/04-ops`(1)**。逐目录 find 实测 = **30 件**，与 :172-174 现量注释逐目录吻合；下限断言 ≥28 在位。

② 灵敏度反证（wbtmp 补丁副本，仓库未动）：向 `docs/05-peripherals/DEPLOYMENT.md` 文本副本注入两行违规现时态行（b 判据 `__approvalId` 裸承诺 + E-1 判据 `maxRisk` 已生效授权话术）——
- **扩面版**（HEAD 判据）：11 例中**恰 2 红**（b 判据、E-1 判据），其余 9 绿；失败信息点名 `docs/05-peripherals/DEPLOYMENT.md:564: 注入变异A…` ⇒ 外圈文件**真的被扫**；
- **差分**（批0 旧收集面=剔除 05-peripherals/04-ops）：注入**全逃逸**（11 绿——需同时把下限降回才跑得到扫描步，下限 ≥28 本身还先拦一层 26 件红=防空转的活性自证）⇒ 同一注入"旧面漏、新面捕"，**扩收集生效实证**；
- 旧文本核对：`git show 48472da^` 的 DEPLOYMENT:279 旧 L3 行含"批1 在建/尚未接线"口径词、SCENARIOS 两键注亦含口径词，按 b/E-1 词表本判绿（N-5 假方法行亦不在 claims-guard 词表扫描键内）——旧文本无判据命中面，灵敏度以注入变异实证，机理如实记录。

## V5 全域残留独立扫描 ✅（含 2 ⚠）

| 子项 | 期望 | 实际 | 结论 |
|---|---|---|---|
| ①a `resubscribe`（docs/skills/README/overview，排除 audit/qa/changes） | 0 | **0** | ✅ |
| ①b `tasks/send`（同排除面） | 少量且须为"已废弃"注 | 4 处：INTERFACES:153 / REQUIREMENTS:76 / CONTEXT-ANALYSIS:288 / orchestrator:475 **均为"旧名已废、返回 MethodNotFound"合法教学**；1 处 `docs/design/cl-k3r-…:134`（**⚠-2**，见下） | ✅⚠ |
| ② "批1 在建" in docs/05-peripherals | 0 | **0** | ✅ |
| ③ "封闭 10 码" 全仓（排除 audit/qa/phase4-b9-notes） | 工程师自报 2 处 | 自报 2 处**属实**（skills 两表头+表体确缺 2 码、确不在 D 项处方点名面=errors.ts+INSTALL-GUIDE）；**但同病灶实为 7 处未登记**（**⚠-1**，见下）。errors.ts:79"既有 10 码取值逐字不变"=历史性陈述，判良性 | ⚠ 登记可接受、清单不全 |
| ④ §2.6 表 vs errors.ts | 12=12 | **codes=12 / rows=12 / map=12**；抽验：UNSUPPORTED_GOAL 否↔false、TASK_CANCELED 否↔false、DELEGATION_REQUIRED 否(须转委派)↔false、TIMEOUT 是↔true、EXECUTION_FAILED 否↔false **全一致** | ✅ |

**⚠-1（登记不完整，P2，路由批10）** — 现象：批9 notes §8 仅登记 skills 两处「封闭 10 码」；亲扫另有 `packages/adapter-agent-workbuddy/src/index.ts`（:31-32/:393/:1141/:1150 数字复写注释 + `:34-44` **10 元素数组镜像**缺 `TASK_CANCELED`/`DELEGATION_REQUIRED`）、`tests/unit/cl017-error-reason.test.js`（:8/:90）、`packages/vm-capabilities/src/ps-bridge.ts`（:480）。根因：R4 数字钉收集面处方即限定两文件，同病灶外圈无机检。证据：上列行号 + `toBridgeError` 分支②会把裸 `err.code='DELEGATION_REQUIRED'` 压平为 `EXECUTION_FAILED+reason`（TASK_CANCELED 有 `PSBRIDGE_CANCELED` 显式映射、DELEGATION_REQUIRED 产生于 vm-service MCP 面，实际暴露有限）。路由：批10 小批——两 SKILL 码表补 2 码+去数字表头（notes 已计划）、adapter 数组改派生自 contracts 或补 2 码、§8 补登 7 处；可选扩 R4 收集面（需授权）。**非本轮阻塞**：均不在批9 点名处方面。

**⚠-2（历史草稿，登记即可，P3）** — `docs/design/cl-k3r-silent-false-success-design.md:134` 时序图仍以 `tasks/send` 画调用边。STATUS: DRAFT（基线 6dca16e 的旧设计稿，非用户教学面）；该设计若复活需订正方法名。路由：登记，批10 顺手加废弃注即可。

## V6 改写质量抽查（文案 vs 实现）✅ 语义正确

- **USER-MANUAL §3.2/§4**（:42/:56）：真实通路=宿主工具 `a2a.approval.reply`（`host-a2a-bridge/tools.ts:678` → `client.replyApproval`）→ 底层 `message/send` 携 `message.taskId` + `parts:[{kind:'data',data:{approvalId,approved}}]`（`a2a-framework/client.ts:197-216` 逐字段核对一致）→ 服务端 `continueTask`→`resolveApproval`（`server.ts:344-359` 一致）；「VM 服务端收到批准后续跑」与 `tools.ts:213-214` 提示行一致。✅
- **SCENARIOS Demo 块**（:276-283）：`a2a.approval.reply {taskId,approvalId,approved:true}` 参数形与宿主工具入参一致；等价 JSON-RPC `method:"message/send"`、`message{role:"user",taskId,parts:[{kind:"data",data:{approvalId,approved}}]}` 与 client.ts 实况**逐字段一致**；「服务端 dispatch 只认 message/send / tasks/get·list·cancel·subscribe / agent card」与 `server.ts:254-283` case 面一致（确无其它续跑方法）。✅
- **DEPLOYMENT:281 新增行**：「纯 MCP 直调命中 L2/L3 ⇒ 收口 `DELEGATION_REQUIRED`（批1(c)），不发放续跑令牌，须转委派」与 `vm-service/server.ts:1429-1555`（不再注册死令牌、灰度 `WINVM_DELEGATION_REQUIRED_POLICY=off` 回滚保险）及 :1711 工具描述一致。✅ 教的路径真实存在。

## V7 门禁登记 ✅

- `scripts/gate.mjs:111` GATE_GUARD_FILES 含 `p4-b9-errcode-registration-pin.test.js`（id=errcode-registration-pin，ST3）✅；`scripts/GATE-POLICY.md:108` 表行在位（判据/理由齐）✅。
- `node scripts/gate.mjs --quick`（先读 :21 确认 quick=ST1+ST2+ST2b+ST3 真实存在）：**EXIT=0，VERDICT: GREEN** —— ST1 tsc 12 包 GREEN / ST2 dep-lint hard=0 / ST2b 未知键=0 / ST3 守卫件 **9 件逐文件全绿（174 tests / 174 pass / 0 fail，含本钉 8/8）**。

---

## 结论

四笔 commit 交付物经亲跑**全部达标**：六件测试 95/95 绿、构建 0 错、漂移钉与扩收集守卫均通过独立变异反证（**非装饰品**）、假方法教学面清零、改写文案与 `client.ts`/`server.ts`/`tools.ts` 实现逐字段一致、门禁登记+quick 档 GREEN。两条 ⚠ 均为批9 处方点名面之外的登记完整性问题（⚠-1 残留清单不全 7 处待补登、⚠-2 历史 DRAFT 图注），路由批10 处置，不构成回退。

**IS_PASS: YES**

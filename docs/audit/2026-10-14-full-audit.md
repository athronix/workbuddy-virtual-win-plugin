# WinVM Bridge · Phase 4 全面再审计 终版台账（2026-10-14）

> 基线 `63832ad`（批1 七笔全收官；全量 gate **114件/2079例 GREEN**，2077 pass/0 fail/2 skip=ssh2-resolve，`qa/p3-batch-sweep/gate-b1-cl7.txt`）。
> 前序：`docs/audit/2026-10-12-full-audit.md`（P0×4 已全部收敛）+ Phase 3 批0-6 施工记录（`docs/changes/phase3-b*-notes.md`）。
> **组织实况**：六只读审计棒（prod/arch/impl/qa/docs/ops+真机）派出后全波撞 API 配额限流（429，含 resume 实例）；按"20 分钟静默熔断"纪律 5 棒判中断，**本次改主理人亲验串行执行**（锚点全部当场可复跑）。ops 棒留有部署前基线双件证据（与主理人独立探针三源互证）。原始工作稿 `qa/audit-2026-10-14-raw/ledger-lead.md`。
> **定位**：Phase 3 是"承诺兑现面"补课；本轮 Phase 4 是"新落地面自洽性 + 教学/登记漂移 + 分发纪律"三层再扫。**P0=0**（无"正在发生∧无人工规避"的安全/可用事故；最高级 P1×3 全有明确人工规避或批内可闭）。

---

## 1. 发现台账（9 项：P1×3 / P2×6，另 1 项反证确认+在册项复验表见 §3）

| # | 级别 | 维 | 发现 | 锚点（亲验可复跑） | 处置路由 |
|---|---|---|---|---|---|
| **N-1** | **P1** | 部署运维 | **批1 分发未跟批**（版本时差窗口）：仓库+gate 全绿，但 `deploy-vm` 从未执行——现网 VM 服务仍是批1 前行为（直调 L2 返 `APPROVAL_REQUIRED+approvalId+resumeHint` 旧死令牌全形，无 `DELEGATION_REQUIRED`、`/health` 无 `policyGate` 块）。"仓库≠分发真相源"结构性缺陷**第三复现**，新亚型=分发滞后于批 | 三源互证：主理人 19:5x 探针；ops 棒 20:02 部署前基线（`qa/audit-2026-10-14-raw/aud-ops/v17-0-pre-direct-baseline.txt`+`v17-0-pre-health.txt`）；主理人 20:14 复测同形 | **批8**：deploy-vm --apply→kill-restart→行为指纹复验→V17-2/3 端到端；runbook 把"每批合并→部署→行为指纹"写成例行动作（治本） |
| **N-5** | **P1** | 产品/文档 | **产品三册教不存在的协议方法 `tasks/resubscribe`**（承诺失实级教学）：A2A 框架 dispatch 实有面=message/send、tasks/get/list/cancel/subscribe、agent card（**零 resubscribe**）；审批应答真实通路=`client.replyApproval(taskId,approvalId,approved)`→`message/send` 携 taskId+data part→`continueTask`→`resolveApproval`。USER-MANUAL:42/56、SCENARIOS:262/270-277（含 PUT 示例 JSON）、DEPLOYMENT:281 全在教假方法——用户照做必撞 method-not-found | dispatch case 表 `packages/a2a-framework/src/server.ts:254-283`；真实通路 `client.ts:197-216`+`server.ts:313-353`；三册行 `grep -n resubscribe docs/05-peripherals/*.md`（4 命中亲验） | **批9**：三册改写真实通路；SCENARIOS 示例 JSON 一并改 |
| **N-2** | **P1** | 文档/规范 | **INTERFACES §2.6 错误码表漂移**：表列 9 码 vs `errors.ts` 封闭集 12 码（缺 `UNSUPPORTED_GOAL`/`TASK_CANCELED`/`DELEGATION_REQUIRED`——前两个欠得更早，批1 添第三码时又欠=同病再发） | `docs/02-design/INTERFACES.md:110-121` vs `packages/contracts/src/errors.ts:17-40`；计数亲跑 9 vs 12 | **批9**：补三行+配**漂移钉守卫**（errors.ts 码枚举⊆§2.6 表行，缺即红；对齐 fidelity 守卫族打法） |
| N-4 | P2 | 测试/守卫 | **N-3/N-5 漏网的守卫根因**：`phase3-skill-claims-guard.governanceDocs()` 收集面=README/overview/06/GATE-POLICY+02-design+skills，**不含 05-peripherals/INSTALL-GUIDE/04-ops** ⇒ 治理面文档改口时外圈静默漏、判据 b/E-1 钉对漏网区失明 | `tests/unit/phase3-skill-claims-guard.test.js:144-148`（函数体亲读） | **批9**：扩收集面（件数下限同步抬）；判据本身不放宽 |
| N-3 | P2 | 文档 | **批1 口径订正漏网族（05-peripherals 域两处）**：DEPLOYMENT.md:279、SCENARIOS.md:153 仍是批0 口径"尚未接线＝Phase 3 批1 **在建**"（批1 已落地；CL5 只改 02-design+skills） | `git grep -n "批1 在建" -- docs/05-peripherals/`（2 命中亲跑） | **批9**：改终态口径（接线落地∧缺省 shadow 不执法⇒"不得读作已生效"读法约束保留） |
| N-6 | P2 | 文档/实现 | **"封闭 10 码"注释漂移**：errors.ts:54 注释与 INSTALL-GUIDE.md:301 均称 10 码，实数 12；INTERFACES:96 示例行 retryable 值待与 DEFAULT_RETRYABLE 表统一核对（批1 新码 retryable=false） | `grep -n "封闭 10 码" packages/contracts/src/errors.ts docs/INSTALL-GUIDE.md` 亲跑 | **批9**：句式改"封闭集（见 errors.ts 单源）"消数字复写；N-2 漂移钉一并覆盖 |
| N-7 | P2 | 实现 | **F-5 残余（上轮点名"批4 或批1 顺带"未落）**：LLM provider 两处合成步骤 `risk: input.maxRisk ?? 'L2'`（bridge.ts:1545/1844）仍以"委派上限"冒充"该步骤实际风险"，与 :98-105"步骤 risk 如实化"宣称相悖 | `grep -n "maxRisk ?? 'L2'" packages/adapter-agent-workbuddy-llm/src/bridge.ts`（2 命中亲验） | **批10/P2 随修族**：取 cap.risk 服务端权威值（合成步骤 capabilityId=workflow.run ⇒ 该能力注册风险）或改字段名为 delegationMaxRisk 显义 |
| N-9 | P2 | 架构 | **(c) 并发窄窗残余**（设计自查的镜像面如实登记）：纯宿主直调恰撞常驻委派 turn 进行中窗口 ⇒ `getActiveTaskId()` 在场 ⇒ 被判 innerDelegation ⇒ 不被 (c) 收口而注册令牌（=旧死令牌行为在毫秒窗内复活）。方向 fail-safe（无放宽放行、无串台），但 (c) 的"根治"表述应带此限定；传输层显式身份标方案被 `buildMcpConfig` LEGACY_OUT 逐字节守卫挡死（38 处，批1 亲验返工教训） | handler 判据现场 `server.ts:1498-1522`；残余形态=`delegationRequiredPolicy=on` 下直调+并发 turn 理论交错 | **批10 注记**：`/health.policyGate` 加 `directWithActiveTurn` 观测计数（warn-only 零行为）；文档补一句窄窗限定，不作修复承诺 |
| N-10 | P2 | 测试 | **批1 无服务级端到端**：双闸 scope 执法/activeTaskId 路径/shadow→on 执法切换/replay-scope 复评，现仅单元件+源码钉（p3-b1-policy-gate 33 例全离线）；smoke 仅覆盖直调 (c)+dtid 内层对照——常驻形态（缺省启用！）的 scope 回查链端到端零覆盖 | `git grep -ln "scopeRegistry\|WINVM_POLICY_GATE_WIRING" -- tests/` 仅 p3-b1 一件（亲跑） | **批10**：smoke/e2e 补常驻委派→内层回连→scope 命中链（含 shadow 改道计数断言）；与 N-1 部署后真机 V17 并窗 |

### 反证确认（不立案，正向结论）
- **N-8（候选推翻）**：(c)"转委派"指引有真实可达通道——`install-host.mjs:1162` 默认装 `winvm-a2a` 连接器、`a2a.delegate` 工具真实注册（tools.ts:395）、审批闭环链路 k4/k5/a5/smoke 204 例零回归。**产品口径自洽** ✅（若未反证将误报 P0 级"指引指向不存在工具"）。

## 2. 上轮在册项复验（账实相符抽查，防"✅ 复潮"）
| 项 | 上轮裁处 | 本轮亲验 | 结论 |
|---|---|---|---|
| C-3 ExecutedResult.error 裸串抹码 | P2 在册未修 | `bridge.ts:364` 仍在 | ✅ 账实相符（欠账在册，非复潮） |
| C-5 /health approvals 观测块+size getter 死码 | P2 在册 | `/health` 无 approvals 块；`pendingApprovals.size`(pending-approvals.ts:136) 服务层零消费者 | ✅ 账实相符 |
| D-3 schema 运行期零消费 | Q1=(b) 已裁交付面+漂移钉 | vm-service 运行期仍零命中 | ✅ 与裁断一致 |
| M6 后 7 份 SKILL 缺 `meta.capability.list` 声明 | 批4 只挂写侧，声明面在册 | 亲数：7 份域技能中仅 orchestrator(3)/app-operation(1) 命中，4 份域技能=0 | ⚠ 仍在册（文档债，并入批10 随修） |
| GATE-POLICY 静态数字 | 批0 已删静态列 | :96 现为"查法"口径 | ✅ 已闭 |
| 54 能力计数守卫 | phase2-contract-schema 钉 | :41 条数守卫在位 | ✅ 已闭 |
| 批1 设计面（F-1/F-2/F-3/E-2/A2-1） | 七笔链交付 | 判源链/装配单源/scope 留存/重放复评/三处早退注入 全锚点复核在位+33 例行为面 | ✅ 已闭（唯分发未跟=N-1、端到端薄=N-10） |

## 3. 结构性结论（三棒教训的 Phase 4 延伸）
1. **分发纪律缺口是本轮最重发现**（N-1）：批1 后"文档改口（CL5 宣布已落地）"与"现网实况（旧码）"之间出现真实时差——**凡承诺类改动，验收必须含部署后行为指纹**，gate 绿只证仓库。runbook 补"合并→deploy→指纹复验"闭环条目＝治本。
2. **教学文档与协议面的双源漂移**（N-5/N-2/N-6）：错误码封闭集三次添码两次欠表、协议方法教学凭空发明——登记守卫（N-2 漂移钉+claims-guard 扩收集面 N-4）比逐次人工订正更可靠，对齐"派生式守卫"既有打法。
3. **常驻缺省形态的端到端盲区**（N-10）：缺省 provider 是 LLM+常驻（dtid 不生效那条路径），但测试矩阵重心在 dtid/send 形态——缺省形态的 scope/审批链应有真服务级用例，否则"缺省最常用=最没验过"。

## 4. Phase 4 完善路径（批次表，可证伪验收）

| 批 | 内容 | 台账映射 | 改动面 | 可证伪验收 |
|---|---|---|---|---|
| **批8 分发跟批+真机收口** | deploy-vm --apply + kill-restart → 行为指纹（直调 L2=DELEGATION_REQUIRED∧/health.policyGate 在册∧链上 matchedRule=policy:delegation-required）→ V17-2/3 端到端 → shadow 期 shadowHits 观测基线；runbook 新增"批合并→部署→指纹"闭环条目+文档时差声明（改口=部署后生效） | N-1 | ~2 文件+qa 证据 | 现网三指纹齐+runbook 条目在位；主理人真机窗执行 |
| **批9 教学与登记诚实化** ✅ **完赛（2026-10-14，commits 48472da/09d89b4/9e77690/本笔；施工记录 `docs/changes/phase4-b9-notes.md`。验收实测：全域假方法 grep=0（audit/qa 留痕除外）；漂移钉 8/8 绿含 M1–M4 变异自检；claims-guard 扩收集后收集面 30 件、11/11 绿；tsc EXIT=0。残留：skills 两 SKILL「封闭 10 码」表头+缺 2 码不在本批处方面，P2 随修——见 notes §8）** | 三册 resubscribe→真实通路改写；§2.6 补 3 码+retryable 统一核；"封闭 10 码"句式去数字；05-peripherals 批1 口径 2 处改口；claims-guard 治理面扩收集（05-peripherals/INSTALL-GUIDE/04-ops）；**新漂移钉**：errors.ts 枚举↔INTERFACES §2.6 双向 ⊆ 守卫（进 ST3 门禁件） | N-2/N-3/N-4/N-5/N-6 | ~10 文件 | 假方法教学 grep=0；漂移钉变异自检（删表行⇒红）；claims-guard 收集面≥30 件 |
| **批10 缺省形态端到端+P2 随修** | 常驻委派 scope 链 E2E（含 shadow 改道计数断言、(c) 不误伤内层）；N-9 观测计数+窄窗限定句；F-5 合成步骤 risk 如实化；M6 SKILL 声明位补齐 | N-7/N-9/N-10/M6 声明 | ~6 文件 | 新 E2E 件在 gate 枚举面且绿；F-5 grep 清零；声明位 7/7 |
| 观察窗（不立批） | 现网 shadowHits 7 天归稳→运维 on 评估；A5/V3/V4/V14/V15 既有真机观察件随批8 窗口顺带 | — | — | 登记 V17 系列终态于台账 §8 |

**依赖主线**：批8（真机窗独占）∥ 批9（纯文档+守卫，可先行）→ 批10（部分依赖批8 部署后的真机面）。批9 的漂移钉若触既有源码字符串守卫，按受契约保护变更流程同批同步。

---
*审计棒中断说明：5 棒 429 熔断残骸已清（留痕本节）；ops 棒部署前基线证据两份有效采信。若后续棒复活，其产出与本文互证后并入（冲突以锚点复跑裁定为准，权威层级=仓库文档>本台账>聊天）。*

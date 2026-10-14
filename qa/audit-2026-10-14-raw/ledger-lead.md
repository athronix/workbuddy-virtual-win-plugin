# Phase 4 再审计 · 主理人亲验发现账本（2026-10-14 · 串行推进）

> 组织实况：六只读审计棒（prod/arch/impl/qa/docs/ops）派出后全部撞 API 波状限流（429 Allocated quota exceeded，
> 六棒+resume 全中招）⇒ 主理人裁定改**亲验串行**执行（我对批1 七笔+上轮台账是最完整索引）。
> 若成员棒复活，其产出降级为交叉验证源（先与本草稿互证再并册）。基线 `63832ad`（批1 全收官，114件/2079例 GREEN）。

| # | 级别 | 维 | 发现 | 锚点（主理人亲验） | 建议处置 |
|---|---|---|---|---|---|
| N-1 | **P1** | 运维/分发 | **批1 分发未跟批**（版本时差窗口）：仓库+gate 全绿但 `deploy-vm` 从未执行——现网 VM 服务仍是批1 前行为 | 19:5x 直调 `storage.file.delete`（WinVMWorkspace 白名单内）经隧道返 `APPROVAL_REQUIRED+approvalId`（旧死令牌），而非 `DELEGATION_REQUIRED`；aud-ops 证据 `qa/audit-2026-10-14-raw/aud-ops/v17-0-pre-direct-baseline.txt`（含 resumeHint:"确认后以 __approvalId 重发同一请求"全形旧码） | 补 deploy-vm --apply + kill-restart → 行为指纹复验（=批1 真机收口前置）；"仓库≠分发真相源"第三复现新亚型=**分发滞后于批**，升级 runbook 应把"每批合并后部署+指纹复验"写成门禁外例行动作 |
| N-2 | P1 | 文档 | **INTERFACES §2.6 错误码表漂移**：表列 9 码，`errors.ts` 封闭集实为 12（缺 `UNSUPPORTED_GOAL`/`TASK_CANCELED`/`DELEGATION_REQUIRED`）——"契约要素必登记"纪律的历史欠账（前两码欠得更早，批1 添第三码时未补表） | `docs/02-design/INTERFACES.md:112-121` vs `packages/contracts/src/errors.ts`（git grep 计数 9 vs 12，亲跑） | 补三行入表；配**漂移钉**（静态守卫：errors.ts 码枚举 ⊆ §2.6 表行，缺即红）——对齐 phase2 既有 fidelity 守卫族打法 |
| N-3 | P2 | 文档 | **批1 文档订正漏网族（05-peripherals 域）**：DEPLOYMENT.md:279 与 SCENARIOS.md:153 仍是批0 口径"尚未接线＝Phase 3 批1 **在建**"（批1 已落地）——批1 CL5 只改 02-design+skills，未扫 05-peripherals | `git grep -n "批1 在建" -- docs/05-peripherals/` 两处命中 | 改批1 终态口径（接线落地∧缺省 shadow 不执法⇒"不得读作已生效"读法约束保留）；治理面**收集范围扩大**入 claims-guard（02-design/skills/README/overview 之外纳入 05-peripherals/INSTALL-GUIDE/04-ops——否则每轮订正都要重新漏） |
| N-4 | P2 | 文档 | **N-3 的守卫面根因**：phase3-skill-claims-guard `governanceDocs()` 收集面=README/overview/06-OVERVIEW/GATE-POLICY + docs/02-design + skills——**不含** 05-peripherals/INSTALL-GUIDE/04-ops ⇒ 判据 b/E-1 钉对漏网区静默 | tests/unit/phase3-skill-claims-guard.test.js:144-148 | 扩治理面收集目录（≥34 件下限同步抬）；claims-guard 判据本身不放宽 |
| N-5 | **P1** | 产品/文档 | **产品三册教不存在的协议方法 `tasks/resubscribe`**（审批续跑教学失真）：框架 dispatch 实有面=message/send、tasks/get|list|cancel|subscribe、agent card；审批应答**真实通路**=`client.replyApproval(taskId,…)` → `message/send` 携 taskId+data{approvalId,approved} → `continueTask` 处理。USER-MANUAL.md:42/56、SCENARIOS.md:262/270-277、DEPLOYMENT.md:281 全部在教 `tasks/resubscribe` | dispatch case 表亲读 server.ts:254-283（零 resubscribe 命中，git grep 全 framework=0）；client.ts:197-216 replyApproval 实现亲读；三册命中行亲 grep | 三册改写为真实通路（宿主面=`a2a.approval.reply` 工具/底层=message/send data-part）；SCENARIOS:275 示例 JSON 一并改；属**承诺失实级**教学（用户照做必撞 method not found）→ 修复批优先 |
| N-6 | P2 | 文档/实现 | **"封闭 10 码"注释漂移**：errors.ts:54 注释与 INSTALL-GUIDE.md:301 均称 10 码，实数已 12（TASK_CANCELED 入册时欠、DELEGATION_REQUIRED 批1 又欠）；INTERFACES 示例行 :96 `APPROVAL_REQUIRED retryable:true` 等与 DEFAULT_RETRYABLE 表核对待做（修复批时统一核） | grep 锚点两处亲验 | 注释改"封闭集（见 errors.ts 单源）"句式消除数字复写；漂移钉守卫（N-2 处置）一并覆盖码数 |
| （续） | | | | | |

## 已闭合项抽查复验（防"✅ 复潮"，主理人亲验）
- **C-3 裸串抹码**：`ExecutedResult.error?: string`（bridge.ts:364）**仍在**——上轮裁 P2 未修，账实相符（不是复潮，是欠账在册）。
- **D-3 schema 死配置**：运行期仍无消费者（vm-service src 零命中 schema.json）——批6 已裁"交付面校验+漂移钉、运行期不接"，Q1=(b) 在册，账实相符。
- **(c) 现网行为**（N-1 前置）：文档说 shadow/收口，现网实为旧码——**部署后**才算数；批1 真机窗=部署+V17-2/3 对照（aud-ops 在执行，主理人 19:5x 基线已留证）。
- 批1 面专项：maxRiskSource 判源链已闭合（宿主桥打标→client 透传→buildGoal 判源→observer 留存→handler 回查，CL1/CL2 七笔链全绿+26 例行为面）；唯一在途=现网分发（N-1）。
- 待抽查（下轮）：USER-MANUAL 整体时效（N-5 仅是其一处）、GATE-POLICY:98、tunnel-runbook、SCENARIOS F 族审批描述、INSTALL-VERIFY-REPORT 陈旧度。

## 真机窗观察记录
- 20:02 aud-ops 留部署前基线两件（health 无 policyGate 块 + 直调旧码全形）——与主理人 19:5x 独立探针互证一致（双源）。
- ops 棒 20:02 后静默（疑 deploy-vm 长步骤或 429），20:2x 巡检判活：timeline mtime+进程面。

# Phase 6 · 批17 决策族裁决单

> 状态：**待用户裁决**（每项给「事实 / 选项 / 主理人建议」三项，裁决后由主理人落档执行）
> 来源：`docs/audit/2026-10-16-panorama-phase6.md` §四 批17（原 N-4 旧 backlog 复宣）
> 生成：2026-10-17（主理人亲验，含本轮新证据对原条目的**推翻/升级**）
> 用法：对每项回「①A ②A ③…」即可；未裁决项维持现状不动代码。

**本轮重要修正**：经逐项回仓核验 + 三轮真机采样，原决策族 5 项中 **1 项已不成立（D-1，应销账）**、**1 项定性被推翻升级（D-5）**、**2 项维持（D-2/D-3/D-4）**；并**新增 2 项真机暴露项（D-6 呈报失真、D-7 字段漂移）**。决策族现为 **6 项**。
> D-6 是本轮唯一**实弹级**新发现，来源与证据见 `qa/p5-batch/b16/VERDICT.md`。

---

## D-1｜capability.schema.json 是否接入运行期校验 —— **建议销账（事实面已不成立）**

**原条目（N-4 复宣）**：`capability.schema.json` 的 `domain.enum` / `id.pattern` 缺 `appops`，且全仓无运行期校验器消费（`additionalProperties:false` 的拒止能力从未兑现）。

**本轮核验结果（推翻原事实面）**：
| 原指控 | 现状 | 证据锚点 |
|---|---|---|
| 缺 `appops` 枚举 | ❌ 不成立。`domain.enum` 已含 `appops`/`meta` | `packages/contracts/schemas/capability.schema.json` L29 |
| `id.pattern` 缺 `appops` | ❌ 不成立。pattern 已含 `appops` | 同文件 L26 |
| 无校验器消费 | ⚠ 半成立但**已被裁断**：`contracts/src/schema-check.ts` 存在 | `packages/contracts/src/schema-check.ts` |
| —— | 且存在**反向守卫**钉住"运行期不接"这一裁决 | `tests/unit/phase2-contract-schema.test.js` L237「vm-capabilities / vm-service 源码不 import schema-check（校验只活在测试/门禁面）」 |

⇒ 该条目在 Phase 3 批6 已实际销账（枚举补齐 + 裁决"校验活在测/门禁面，不接运行期"），N-4 属**陈旧复宣**。

**选项**：
- **A（建议）**：维持现裁决，本项销账（零成本）。
- B：另开改造——把 schema 校验接进注册期（运行期），需同步拆除上述反向守卫。

**建议 A**。影响=零。不做会怎样：条目长期挂账制造**虚假待办**（与本轮批15 教训同源——"写了≠执行了"的镜像形态："已执行了却仍记着没做"）。

---

## D-2｜K3 文本启发式（`reconcileApprovalWait`）保留 / 移除 / 根治 —— **建议保留**

**事实**：`reconcileApprovalWait`（`packages/adapter-agent-workbuddy-llm/src/bridge.ts` L825）仍是文本启发式（依赖 LLM 措辞），但它**已不是主判据**——结构化判据任一门退场时才回退该启发式（同文件 L973、L1524-1532、L992 注入）。C0 折叠已消化其最大病灶面（K6 假成功），启发式降为第二层。

**选项**：
- **A（建议）**：保留现状（fail-safe 兜底），并把"根治"登记为长期债。
- B：移除启发式 ⇒ 结构化判据失效时直接坦白"未知"。
- C：根治——bridge 直读 MCP 结构化结果（较大改造）。

**建议 A**。理由：选 B 会让"判据失效"退化为**静默 completed**，即 K5 假成功回潮（这正是 CL-K3R 与 C0 花大力气根治的面），收益小而风险大；C 成本大且当前无实弹驱动。
**保留的代价**（如实登记）：极端情况下启发式可能误判（依赖 LLM 措辞）——但它是**兜底不是主判据**，误判方向是"更保守"而非"更放行"。
**配套**：backlog 已有"补 `reconcileApprovalWait` 直接单测"，建议与本项同批做（低成本）。

---

## D-3｜载荷是否全量落审计链 —— **建议维持摘要口径 + 文档固化**

**事实**：链条目当前已含 `params`（`packages/adapter-agent-workbuddy/src/index.ts` L551），`result` 只落 `{ok, errorCode, summary}` 三元 + `artifacts`（`sha256:<name>`）；完整 `data`（含 K6 `residualEvidence`）仅以 **200 字符截断**进 summary（`k6-verdict.ts` `residualEvidenceSummary`）。

**选项**：
- **A（建议）**：维持摘要口径，并在文档显式声明"链=归因账本，不是数据湖；完整产物走 artifacts"。
- B：全量 `data` 落链。
- C：落 `data` 但脱敏 + 外链存 artifacts。

**建议 A**。理由：全量落链会让**不可篡改哈希链**体积爆炸，且把可能敏感的输出（文件内容、路径清单）永久写进**无法删除**的账本——与保留期策略（90 天 / 2GB 超限删最老）和删除权直接冲突。
**不做会怎样**：无实际风险，仅口径需文档固化。建议顺手补进 `docs/SECURITY-GOVERNANCE.md`（与 C0 §4.5"回执诚实"同章节），声明"链存归因、不存全量载荷"。

---

## D-4｜deterministic 是否补"真挂起" —— **建议不补**

**事实**：deterministic = `adapter-agent-workbuddy` 的 **in-process step 咽喉点**（不经 `/mcp` 服务层，见 `packages/core/src/policy-gate.ts` L6 头注）。当前 L2/L3 命中走 `DELEGATION_REQUIRED` 收口（拒绝并要求改走委派），**不产生 `input-required` 真挂起**。

**选项**：
- **A（建议）**：维持——deterministic 不挂起，直接以 `DELEGATION_REQUIRED` 收口。
- B：为 deterministic 实现真挂起（`input-required` + 令牌生命周期 + replay）。

**建议 A**。理由：① deterministic 的定位是**基准/测试执行器**，非生产委派通路；② 挂起要引入令牌生命周期 + 重放语义，成本显著；③ 当前收口方向是 **fail-safe（拒绝而非放行）**，不存在安全缺口；④ "审批挂起"E2E 场景已由 workbuddy(LLM) provider 真机实锤覆盖（批13/C0 复验）。
**代价（如实登记）**：deterministic 永远无法单独覆盖"审批挂起"端到端回归，该场景必须依赖 LLM provider 或 MCP 直调面。

---

## D-5｜llmSession 深度空闲冷启动 —— **定性被推翻升级，建议先诊断**

> 原 N-3 口径："深度空闲冷启动 ~49s"（慢，但能用）。
> 本轮实测：**不止是慢，而是会概率性撞判死阈值并降级**，且已影响委派质量。

**本轮证据链（2026-10-17 00:2x–00:3x，`qa/p5-batch/b16/v20-warm2.txt` + `v20-trace2.txt`）**：
1. 起始：`llmSession={state:"stopped", restarts:1, idleMs:17505715(≈4.86h), lastError:"常驻会话在 60000ms 内未收到 system/init（首条用户消息已写出）", firstCallLatencyMs:49278}`。
2. 暖身（零工具 goal）**completed，但路径是降级**：返回文本自证 `…（常驻会话不可用：常驻会话在 60000ms 内未收到 system/init（首条用户消息已写出），已降级为单次 -p 路径）`；收尾 `state=stopped, restarts=2`。
3. 随即发起真委派（V20）：挂起 ✅（`input-required`，`apr_fa556138d46c40aca0d6`）→ 批准 ✅（`working`）→ 续跑 **failed**，呈报"**已降级为确定性执行，但执行器未匹配到模板**…建议①改用 MCP 通道逐步调用；②或升级 provider 为 LLM Agent"。
4. 同一轮收尾：`llmSession={state:"ready", pid:6092, restarts:3, idleMs:23532, wsLatestMb:7.1}` ⇒ **第 3 次重启后常驻会话自愈成功**。

**精确定性（推翻原"只是慢"）**：深度空闲后首次调用常驻会话冷启动 **49.3s**，逼近 **60s `system/init` 判死阈值** ⇒ **概率性撞阈值失败** ⇒ 该次委派落在**单次 `-p` 降级路径**；降级路径下本轮委派**未发起工具调用**，被确定性执行器接管并因无匹配模板而 failed。即：**冷启动问题已从"体验慢"升级为"影响委派执行质量的功能性缺陷"**（代价是委派失败，不是等待）。

**选项**：
- **A（建议）**：**先诊断**——拉 VM 侧 codebuddy 会话启动日志/进程与 session 目录，确认 49s 花在哪（进程冷启动 / MCP 握手 / 授权等待），并以"调大 init 阈值"做对照实验分离变量。
- B：直接调大 `system/init` 超时（60s → 与 `WINVM_LLM_SESSION_WARMUP_MS`(180s) 对齐）。
- C：接受降级路径为常态——把单次 `-p` 路径文档化为受支持形态，并让 `/health` 显形"当前处于降级路径"（避免静默）。

**建议 A 优先，B 紧随**。理由：B 在无诊断时是"调阈值掩盖病因"（若 49s 是可优化的握手开销，调阈值只是把失败概率压低而不消除）；C 只有在 A 证明"VM 侧 codebuddy 已不具备常驻能力"后才成立。
**不做会怎样**：CL-018（常驻会话）交付物在现网**静默部分失效**，健康面 `state=stopped` 长期挂红无人认领，且委派质量随机退化。

**补充（同轮后续证据，收窄定性）**：轮3 起始 `llmSession` 已是 `ready`（pid 6092）**却仍失败** ⇒ **冷启动不是委派失败的主因**（主因见 D-6）。日志显示自愈形态为：attempt3 `就绪超时`（60s 判死）→ attempt4 `就绪`（35.8s，`16:33:21`）⇒ **重建一次即可恢复**，故 D-5 的严重度应由"影响委派执行质量"下调为"影响首轮延迟与降级路径概率"，真正的执行质量问题是 D-6。

---

## D-6｜委派呈报失真：服务端已真实执行，任务层却报"未匹配到模板"（P2 · 实弹）—— **建议批18 修复**

**完整证据与定位**：`qa/p5-batch/b16/VERDICT.md` §二/§三（链上 seq=20 + VM 日志 + 任务终态三方互证）。

**一句话**：委派经审批放行后，服务端确定性重放**真实执行** `app.winget.uninstall` 并写入诚实折叠回执（`ok=false / EXECUTION_FAILED / K6 核验未过`），但 A2A 任务终态呈报「已降级为确定性执行，但执行器未匹配到模板」且 `steps=[]`。**同一事实两个相反陈述**。

**根因面**：`packages/adapter-agent-workbuddy-llm/src/index.ts` `shouldDegrade()` —— LLM 侧收口 `ok=false` 且零产物 ⇒ 命中降级 ⇒ 确定性兜底既不复用服务端重放结果、也不知悉"已执行"，其失败文案成为终态 summary，**真实错误码被丢**（只出现在瞬时 `working` 状态）。

**危害**：对 destructive 能力尤其危险（**真实卸载已发生，宿主却读到"没匹配到模板"**）；并使「委派完成步携带折叠回执」（V20）结构性不可达。

**选项**：
- **A（建议，批18 修）**：按修法 (a)+(c)——降级前按 traceId 反查服务端回执，命中即不降级并复用；且终态 summary **必须**带真实 `res.error.code` 与「服务端已执行，见 traceId」。
- B：只做 (c) 最小诚实收口（成本低，消除误导，但不消除重复/脱节执行）。
- **C（建议同时采纳）**：把「服务端已重放执行」提升为 `NON_DEGRADABLE` 信号（与既有 `NO_EXECUTION_RECEIPT` 豁免同位）。

**建议 A+C**（B 为不可接受的兜底：只改文案不改行为，destructive 场景仍有脱节风险）。
**不做会怎样**：destructive 委派存在"已执行却报未执行"的静默窗口，是本项目 K3/C0 一路根治的「假成功」同源病灶的**镜像形态**（假失败同样危险——它会让宿主重试真实操作）。

---

## D-7｜失败路径把错误码写进 `policyDecision.matchedRule`（P3 · 字段漂移）—— **建议顺手订正**

**事实**：链上 seq=16（ps-bridge 未心跳重启导致的基础设施失败）条目中，`policyDecision.matchedRule = "EXECUTION_FAILED"` —— 该字段语义应为**命中的策略规则名**，失败路径被填成错误码。

**选项**：A 订正（失败路径填规则名或留空，`errorCode` 已独立承载错误语义）；B 维持（视为既有约定并写进文档）。
**建议 A**（低成本，与 N-2"错误码表漂移"同族，趁批18 一并清）。

---

## 裁决回执表

> **状态：7 项全部已裁决并执行完毕（2026-10-17 批18）**。施工记录与真机复验见
> `docs/changes/phase6-b18-notes.md`。

| 项 | 裁决 | 执行批 | 落档 |
|---|---|---|---|
| D-1 | ✅ **A（销账）** | 无需 | 本单 + 全景 N-4 订正 |
| D-2 | ✅ **A（保留）** | 批18（单测**早已存在**：`phase2-approval-wait-fallback.test.js` 24 例全绿，backlog 销账） | 本单 + b18 notes §四 |
| D-3 | ✅ **A（维持摘要口径）** | 批18（仅文档） | `SECURITY-GOVERNANCE.md` 新增 §4.6 |
| D-4 | ✅ **A（不补）** | 无需（仅文档） | `SECURITY-GOVERNANCE.md` 新增 §4.7 |
| D-5 | ✅ **B（阈值对齐，A 的诊断随修复自然获得）** | 批18 | `constants.ts` 60s→180s + b18 notes §三 |
| **D-6** | ✅ **A+C（已修复）** | **批18（实弹级，优先）** | `qa/p5-batch/b16/VERDICT.md` §六（V20 达成） |
| D-7 | ✅ **A（订正）** | 批18（顺手） | `adapter-agent-workbuddy` 失败站点 |

**门禁**：全量 gate **GREEN · 124 文件 / 2179 例 / 0 fail / 2 skip**
（`qa/p3-batch-sweep/gate-p6-b18-final.txt`；基线 121/2162 → +3 文件 +17 例）。
**真机复验**：`deploy-vm --apply` EXIT=0；D-6 委派层折叠回执达成、链上 `err` 由
`UNKNOWN_CAPABILITY` → `REPLAY_FAILED`；D-7 `matchedRule=runtime:execution-failed`；
D-5 `llmSession restarts=0`、`firstCallLatencyMs` 49278 → 12858。

---

*留痕：本单由主理人亲验产出（仓库逐项回仓核验 + 现网真机两轮 A2A 委派 + 健康面四采），未派审计棒（沿用上轮"覆盖面已足 + 429 波状"教训）。*

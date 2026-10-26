# WinVM Bridge · 项目全景综述（第二轮）与 Phase 6 路径（2026-10-16 18:3x）

> 基线 HEAD `a7a57ab`；全量 gate **121 文件 / 2162 例（2160 pass / 0 fail / 2 skip=ssh2-resolve）GREEN DISK=RUN=MATCH**（`qa/p3-batch-sweep/gate-p5-c0-final.txt`）。今日 23 笔提交。
> 对比第一轮（`2026-10-15-panorama-phase5.md`）：那份的问题清单 B-1~B-8 已全部处置或转化（见 §三销账表）；本轮=新一轮六维体检。

## 一、进展综述

| 阶段 | 状态 |
|---|---|
| V1.0.0→CL-021 / Phase 1-4 | ✅ 全收官（P0×4、P1×3、P2×6 全销账，两轮 QA IS_PASS=YES+活性反证） |
| **Phase 5（价值兑现与运营期）** | ✅ **本轮全部完赛**：批11 外宣对齐（RELEASE-NOTES 权威链）/ 批12 执法 shadow→**on 现网切换**（三查回验+两条真机证伪教训入 §1.8）/ 批13 **服务层真卸载窗闭合**（审批闭环端到端真机实锤：挂起→批准→链上 replay 24.9s 真实执行→复原零遗留）/ 批14 **执法通道化**（.env 声明式跨部署持久，两次实战验证）/ 残项 R1 capability.list 名实对齐（现网 54 条与 tools/list 逐条一致）/ **C0 转呈面专项**（K6 假成功回潮面根治：折叠单源三面消费+真机链上实证+QA 三组变异反证 IS_PASS=YES） |
| 工程健康度 | 基线单周 116→121 件/2103→2162 例单调演进；分发跟批闭环（§1.7）现行两次抓到并修复（批9/10 VM 侧、本轮宿主侧见 §二）；对抗 429 的"极小增量步"方法论沉淀入记忆 |

**安全模型现状（一句话）**：风险分级+双闸执法在网（wiring=on 声明式持久）+审批闭环真机实弹+回执诚实折叠（响应/receiptCache/链上三面同源）——"从承诺到生效"的纵深已闭合到呈报层。

## 二、本轮新发现问题清单

| # | 级别 | 维 | 项 | 现场证据 | 定性/建议 |
|---|---|---|---|---|---|
| **N-1** | ~~P2~~ **✅ 当日闭合（批15）** | 部署运维 | **宿主分发面未跟批**（§1.7-5 现行第一击）：插件缓存 a2a-bridge dist mtime=10-14 11:07，而 10-15~16 三笔 SKILL 修正文本（d038964 五处归因修正、1e1f81e G4 声明段、7d80416 同源句）未同步宿主——宿主 LLM 读到的技能指引仍是旧文（本轮亲验缓存内 grep 修正句零命中） | `ls -la` 缓存目录 + 缓存内 grep 修正句零命中（仅 contracts 源码 -32602 在册，非 SKILL 文案） | 跑一次 `install-host` 跟批+§1.7-5 行为指纹核（工具描述新文案可见+缓存 mtime 跟批）。成本低，Phase 6 批15 |
| **N-2** | P2 | 测试/运维 | **C0 折叠的委派完成步自然样本未直达**：真机复验两层实证（回执+链上）达成，但委派终报携折叠回执那一发被 VM 失联后 LLM 瞬态降级干扰（VERDICT 已如实标"可选观察"，未冒充全绿） | `qa/p5-batch/c0/VERDICT.md` 分层矩阵 | 观察项 V20：会话健康期一次自然带 scope 委派即收口；不强造 |
| **N-3** | P3 | 运维 | 现网 `llmSession.state=stopped`（restarts=0，idle≈83min）：VM 重启后按需形态，首调付 49.3s 冷启动（`firstCallLatencyMs`）——K2 预热只覆盖重启后紧随委派的旧口径仍有效，深度空闲首调成本属已知 | pano2 health 实采 | 无需动作；若运营期在意首响延迟，候选=idleTtl 回收+预热参数联动（登记不紧迫） |
| **N-4** | P3 | 治理 | 旧 backlog 复宣 —— **批18/批19/批20 逐项回仓核验后全部订正**：①「D-3 schema 缺 appops 且零消费者」**已不成立**（`domain.enum`/`id.pattern` 均已含 `appops`，且 `tests/unit/phase2-contract-schema.test.js:237` 有反向守卫钉住"运行期不接"这一**既有裁决** ⇒ Phase 3 批6 已实际销账，本条属陈旧复宣，**批18 销账**）；②K3 兜底启发式：裁决**保留**（fail-safe 兜底，C0 已消化其最大病灶面），且"补直接单测"这一 backlog **亦已不成立** —— `tests/unit/phase2-approval-wait-fallback.test.js`（P2-T10 K3-C4）就是直接单测，24 例全绿；"根治暂缓"分支**批20 销账**（`reconcileApprovalTruth` 缺省 on 早已兑现）；③`SessionHealth` 无法表达"未知"（**批19 销账**：E-2 早已根治+原措辞被 E5 钉禁+IF-6 补准确注）；④非 winvm 团队残骸 45 个（用户裁永久不动） | MEMORY backlog 区 | **①②③④全部销账**（①批18；②批18+批20；③批19；④Phase2(10-12) 用户终裁"一律不动（永久纪律）"——`phase2-arch-design.md` §7-③ + `2026-10-12-full-audit.md` 台账行3 + phase5 全景 B-6 三处互证，非待裁项） |

**未发现新 P0/P1**。健康面复核：policyGate 在册（on/hits=0/dWAT=1 重启新纪元）、capability.list=54 与 tools/list 逐条、`cache.netCfg ageMs=5145264∧ttl=45000` 属诚实显形（陈旧即示陈旧，CL-019 语义正确工作）、ws 读数新 epoch（2.1/3.8MB）正常。

## 三、第一轮问题销账表（B-1~B-8）

| 项 | 终态 |
|---|---|
| B-1 release-notes 停 09-10 | ✅ `docs/RELEASE-NOTES.md` 权威链，旧件冻结头注 |
| B-2 shadow 从未执法 | ✅ 现网 **on**（批12 切换三查+批14 通道化两次部署实战保态） |
| B-3 V3/V4 真卸载窗 | ✅ 主体闭（批13 审批闭环实锤+超时树杀分支维持离线 39 例钉+真实挂起窗观察） |
| B-4 capability.list 名实 | ✅ Node 拦截直供 54 条，现网与 tools/list 双向差集空 |
| B-5 V14 读数/eviction | 半闭：读数在网（双 epoch 采样），evictions>0 待长跑量（不低阈值强触发裁定在册） |
| B-6 团队残骸 | ✅ 按纪律处置（winvm 域清零；非 winvm 域不动） |
| B-7 §1.7 宿主侧对称条目 | ✅ 条目已写——**但本轮现行命中 N-1 证明"写了≠执行了"，条目自身经受住了检验** |
| B-8 skip 档 | ✅ tmp-copy 可跑例+skip 语义终态口径 |
| C0（V19 转化） | ✅ 根治闭合（六笔+真机链上实证+QA IS_PASS=YES） |

## 四、Phase 6 完善路径（运营深化期）

| 批 | 内容 | 验收 | 前置 |
|---|---|---|---|
| **批15 宿主跟批同步** ✅ **当日完赛（2026-10-16 18:3x）**：`install-host --yes` EXIT=0（H1 双连接器四账户断言全过）→ §1.7-5 指纹三中：① 插件缓存 a2a-bridge/cli.js+winvm-plugin.mjs mtime 10-14→**18:37 跟批**；② SKILL 真实落点=`~/.workbuddy/connectors/skills/connector-winvm/`（非插件缓存，教训补录 §1.7-5 见下），system-admin(-32602 修正句 1 处)/orchestrator(降级句+同源句) 与仓库 **git diff --no-index 逐字节 IDENTICAL×2**；③ H1 断言在册。证据 `qa/p3-batch-sweep/install-host-p6.txt`。runbook 补句："VM+宿主双通道跟批"——deploy-vm 后若同批含 skills/host 面改动，必跑 install-host 并按上②落点核对（差分判据用逐字节 diff 不靠短语 grep） | ✅ 指纹三中已登记 | 无 |
| **批16 观察窗收口**（轻批） | V20（委派携折叠回执自然样本）/ B-5 evictions 长跑读数 / shadowHits 恒 0 周报；命中即登记销账，未命中如实 | VERDICT 增补行 | 自然运行期 |
| **批17 决策族**（需用户裁） | ①D-3：schema 接入运行期校验 or 判死配置删除；②K3 启发式第二层保留/移除；③载荷全落链（C0 真机窗曾登记）；④deterministic 真挂起对齐；⑤llmSession 深度空闲冷启动优化是否值得做 | 各一条裁决落档 | 用户点头 |
| **批18 决策族执行** ✅ **完赛（2026-10-17）**：用户 7 项全按建议处置。**D-6（N-5 委派呈报失真，实弹级）已根治** —— 降级前经 `DelegationTruthProbe.delegationActivity` 反查服务端活动，有活动即抑制降级并复用服务端事实（终态带 K6 折叠回执 + traceId，错误码不再被兜底码顶替）；D-7 `matchedRule` 订正为 `runtime:execution-failed`；D-5 就绪超时 60s→180s 与预热对齐；D-1/D-2 销账（两项 backlog 经核验早已完成）；D-3/D-4 文档固化（SECURITY-GOVERNANCE §4.6/§4.7）。全量 gate **GREEN 124/2179**（基线 121/2162），真机复验：V20 目标达成、链上 `delegation.complete` err `UNKNOWN_CAPABILITY`→`REPLAY_FAILED`、`llmSession restarts=0`/`firstCallLatencyMs` 49278→12858 | ✅ 7/7 闭合 | `docs/changes/phase6-b17-decisions.md` + `phase6-b18-notes.md` + `qa/p5-batch/b16/VERDICT.md` §六 |
| **批19 SessionHealth 文档注明** ✅ **完赛（2026-10-17）**：用户裁"文档注明、不改代码"。**施工发现建议措辞撞 E5 静态守卫**（「仅 state==='healthy' 才有意义」是 E-2 前的未兑现临时口径，四份活文档钉禁回潮）⇒ 第三例 stale backlog（E-2 早已以 `probeError`/`probeErrorCode` 三码根治并三处载明）；以准确措辞补 INTERFACES IF-6 消费者注（state 四值均有效观测/无 unknown 枚举系 B6 设计裁定/不得把非 healthy 反推为未知）。零 src；gate GREEN 124/2179 零漂移；**教训=裁决建议措辞也是静态守卫输入面** | ✅ 销账 | `docs/changes/phase6-b19-notes.md` |
| **批20 四项技术债修复** ✅ **完赛（2026-10-17）**：software-company 团队 SOP（PM→工程师→QA，快速模式路由）。PM 核验发现 **4 项中 2 项 stale backlog**（K3：`reconcileApprovalTruth` 缺省 on 早已根治；bearer 自检：P2-T5/T6 早已落地——第 5、6 例 stale）；GUI 锁屏**不可代码修复**（Winlogon 安全桌面+tscon 需提升；§5.4"工具面无 sessionId 数据源"过期注释订正并补 E2E 人工配方）；冷启动**用户裁定 TTL 保持 5min**（转观察项）。**零 src 改动**，3 commit；QA 独立验证 IS_PASS:YES（8 单测 215 例+全量 gate GREEN 124/2179/0fail/2skip，DISK=RUN=MATCH） | ✅ 四项闭合（2 销账/1 定性/1 观察项） | `docs/changes/phase6-b20-prd.md` + `phase6-b20-notes.md` + `qa/p3-batch-sweep/gate-p6-b20-final.txt` |

**优先级**：批15 立即（唯一现行失配，10 分钟成本）；批16 零成本顺带；批17 择机集中裁决。

---

## 四·补｜批16 观察窗结果（2026-10-17 补记，主理人亲验）

**批16 完赛（结果 ≠ 原预期）**：V20（委派完成步携折叠回执）**未命中**，但三轮真机采样暴露 **1 项实弹级新缺陷**，V20 由「待自然样本」转「结构性不可达（依附 N-5）」销账。

| 新项 | 级别 | 一句话 | 证据 |
|---|---|---|---|
| **N-5** | **P2** | 委派放行后服务端**真实执行**并写入诚实折叠回执（链 seq=20，`ok=false/EXECUTION_FAILED/K6 核验未过`），A2A 任务层却呈报「已降级为确定性执行，但执行器未匹配到模板」且 `steps=[]` —— 同一事实两个相反陈述；对 destructive 能力尤危（已卸载却报未匹配），且真实错误码在终态被丢弃 | `qa/p5-batch/b16/VERDICT.md` §二/§三 |
| **N-5 状态** | — | **✅ 已根治（2026-10-17 批18 D-6）**：降级前反查服务端委派活动，有活动即抑制降级；真机复验任务层已携带折叠回执（`stepCount=1`）、链上 `delegation.complete` err `UNKNOWN_CAPABILITY`→`REPLAY_FAILED`；回归 `tests/unit/p6-d6-degrade-suppress.test.js`（10 例） | `docs/changes/phase6-b18-notes.md` §一/§9.4 |
| N-6 | P3 | 单个工具调用却产生「同一委派存在多个未决审批」（两轮日志均现）。**批18 定性完成 = 设计行为非缺陷**：`delegation-truth.ts` 判据 3 取**最旧**一条改判，其余经 warn + `error.details.others` 透出提示宿主逐条处理。残留观察（不修）：宿主只批最旧一条时其余按 TTL 收口 | 同上 §五-1 + `docs/changes/phase6-b18-notes.md` §七 |
| N-7 | P3 | 失败路径把错误码写进 `policyDecision.matchedRule`（seq=16 该字段 = `EXECUTION_FAILED`），字段语义漂移 | 同上 §五-2 |
| D-5 定性修订 | — | 原「冷启动 49s」升级后又**收窄**：轮3 起始 `llmSession=ready` 仍失败 ⇒ 冷启动**非**委派失败主因（主因=N-5）；自愈形态=重建一次即就绪（attempt3 超时→attempt4 35.8s 就绪） | `v20-warm2.txt` / `vm-log-excerpt.txt` |

**正向收获**：链上 seq=20 是 **C0 折叠在「委派批准→服务端确定性重放」真实通路上的第二次独立实证**（首次为 C0 真机复验 seq=5，本次 `matchedRule=allow:policy-passed` 与之互补）⇒ **C0 折叠在生产通路已双样本闭合**。

**批17 决策族随之增补**：D-6（N-5 呈报失真，建议 A+C 修复）、D-7（matchedRule 漂移）；原 D-1 销账、D-5 严重度下调。裁决单见 `docs/changes/phase6-b17-decisions.md`。

---
*方法留痕：本轮=主理人亲验（仓库链/现网健康指纹四采/宿主缓存差分/backlog 复宣），沿用上轮"不再派审计棒"教训（429 波状+覆盖面已足）。*

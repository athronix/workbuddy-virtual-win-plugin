# WinVM Bridge 架构与实现质量全面审计报告（Phase 2 收官后体检）

- 审计人：Bob（架构）
- 时间：2026-10-12 19:42–22:20（全程只读；`npm run layout` 实况 = VERDICT: GREEN，hard=0/warn=0/info=11）
- 范围：①分层与契约 ②实现面技术债 ③安全兑现度 ④可靠性架构 ⑤扩展性 ⑥性能与规模 ⑦架构裁决
- 仓库：/storage/Users/currentUser/Documents/projects/workbuddy-virtual-win-plugin
- 纪律：结论均附文件路径+行号/摘录；证据不足处显式标注。

---

## 摘要（TL;DR）

| 维度 | 一句话结论 |
|---|---|
| ①分层契约 | 机检自洽（dep-lint GREEN）；偏差全在**文档侧**（ARCHITECTURE 缺 2 包 / host-a2a-bridge 层级表与字段不符 / "口径注记"零命中）；DECLARED_UNUSED 11 边逐条归因 = 8 type-only + 2 动态装载 + **1 真幽灵声明**（hermes←core，package.json:13，根因＝该复用却复制，见 ⑦.9）；contracts 包内文件级内环**无机检**。 |
| ②实现债 | 任务书预设的 K3/schema 缺口**已被 Phase 2 闭环**；实证残余 6 项，其中 **D-2=4 处终态拒绝零审计（P1）**、D-3=E-1 度量零读数 + `wsProbe` 死参数⇒死配置。 |
| ③安全 | bearer 自检**已交付**（五码+六级判序+Q4 fail-closed），残余="开 enforceBearer 的 config-lint 硬前置"（P1）；shadow→on 是时代错置（默认已 on）；回环 fail-closed 闭环 **唯一 listen 点实证**；**Origin 校验为文档谎报**；T13 裁决=**只登记不修复**。 |
| ④可靠性 | 隧道确为单点但三层缓解（退避/pidfile/SessionStart 钩子 ensure），残余=daemon giveup 退出后**复活通路绑人在场**；VM 侧兜底强于宿主侧（任务计划双触发+崩溃×3+ps-bridge 看门狗 D2 已修）；**R-4=version 三处硬编码无守卫 + psmod 无产物指纹（P1）**。 |
| ⑤扩展性 | provider 扩展**零代码改动**（loader SPI 配置驱动）；能力暴露面**单一事实源派生**（MCP/policy/审批全自动）；新能力 5 触点、skill 加目录即生效；**CAPABILITY-MODEL §7 路径漂移（照做必翻车）**；hermes/codebuddy 预注册差异**不该统一**（根因是上游 CLI），但要显形。 |
| ⑥性能 | 内存态**全面有界**（200/50/200/30+64MiB 轮转+驱逐上链）是亮点；残余=零 RSS 仪表、`/health` 内 `verifyChain` 无缓存无节流（随运行时长线性退化）、gate 串行（--quick 档已是正解）。 |
| ⑦裁决 | **P0=空**（附升级条件）；P1=4 条；Phase 3 建议 6 个小批（B-1 安全收口 / B-2 文档诚实化 / B-3 机制化 / B-4 观测性 / B-5 T13 登记 / B-6 wsProbe 决断）；7 项**永久接受并文档化**；8 条架构不变量登记；元结论=**任务书 5 处前提已过时**，Phase 3 应加"前序裁决时效性复核"环节。 |

**新增旁证发现 N-1（⑦.9）**：跨平台占位符 `expandEnvPath` 在仓库内有 **6 份实现**（仅 1 份走 core 权威通路），且默认配置值为 Windows 模板 ⇒ POSIX/鸿蒙宿主上字面量 `%LOCALAPPDATA%` 被当目录名创建（仓库根实测到该垃圾目录）。定级 P2，处置＝收口（同时消除 ① 节的幽灵声明）。

**P0 技术债清单：空。** **P1（4 条，Phase 3 首批）**：①D-2 四处终态拒绝零审计（server.ts:1162-1168/:1170-1177/:1103-1112/:1534-1540）；②R-4 version 三处硬编码无同源守卫 + psmod 无产物指纹（运行期跨语言契约不可验证）；③P-6/D-3 E-1 度量承诺零真机读数（无读数即无裁决依据）；④B-1' 设 enforceBearer:true 缺 config-lint 硬前置（现仅告警，运行期才暴露）。

---

## ① 分层与契约一致性核对结果

### 1.1 dep-lint 实况

`node scripts/dep-lint.mjs`（=`npm run layout`）：**12 包 / 66 js 文件 / 39 import 语句 / 22 包级边 / 审计符号 7**；违规 11 条全部 `info`（DECLARED_UNUSED），hard=0 warn=0 ⇒ **VERDICT: GREEN**。分层方向、幽灵边、框架审计边三条判据当前均无命中。

### 1.2 rank 表 vs package.json layer vs ARCHITECTURE.md 三方核对

| 包 | package.json `layer` | dep-lint rank | ARCHITECTURE.md §2.2 表 | 一致性 |
|---|---|---|---|---|
| contracts | L0-contracts | 0 | L0 | ✅ |
| core | L1a-core | 10 | L1a | ✅ |
| mcp-framework / a2a-framework | L1b-* | 20 | L1b | ✅ |
| host-sdk | L1c-host-sdk | 30 | L1c | ✅ |
| vm-capabilities | L2-vm-capabilities | 40 | L2 | ✅ |
| adapter-agent-workbuddy | L2-adapter-agent | 40 | L2 | ✅ |
| adapter-agent-workbuddy-llm | L2-adapter-agent-llm | 40 | **表中缺失** | ⚠️ 文档缺口 |
| adapter-agent-hermes | **L2-adapter-agent-llm** | 40 | **表中缺失** | ⚠️⚠️ 见 1.3 |
| adapter-host-workbuddy | L2-adapter-host | 40 | L2 | ✅ |
| vm-service | **L2-vm-service** | 40 | L2（dep-lint 头注 L90-93 自述设计 §254 曾写作 L3） | ✅（叙述差残留，见 1.2 末段） |
| host-a2a-bridge | **L3-host-bridge** | 50 | **表中写 L2**（ARCHITECTURE.md:126） | ⚠️ 三方叙述不一，rank 语义无碍 |

**结论**：机检三方（LAYER_RANK 表 ↔ layer 字段 ↔ 实际 dist 边）**自洽**；不一致全部集中在**文档侧**——ARCHITECTURE.md §2.2 包清单落后于 packages/ 实况（缺 hermes、llm-adapter 两包，host-a2a-bridge 层位标注 L2 而字段为 L3）。dep-lint L92-93 承诺「散文与字段分歧由本批 README/ARCHITECTURE 口径注记显形」，但 `git grep "口径注记"` 在 ARCHITECTURE.md 与 README.md **零命中** ⇒ 该承诺未兑现（登记偏差 D-α，P2：补一段口径注记即可，零代码）。

### 1.3 adapter-agent-hermes 的 layer 字段值复制粘贴错位

`packages/adapter-agent-hermes/package.json` 的 `layer = "L2-adapter-agent-llm"` 与 `adapter-agent-workbuddy-llm` 层名**逐字相同**。hermes 是独立 provider（PROVIDER_ID='hermes-agent'，index.ts:30），建议改 `L2-adapter-agent-hermes`。当前无 rank 后果（同 40），纯命名卫生（P2）。

### 1.4 DECLARED_UNUSED（info=11）逐边归因

逐 src 验证后 11 条边分三类：

- **type-only 擦除（8 条，真实设计选择）**：hermes←contracts（index.ts:14-23 混入式 type import）、hermes←vm-capabilities（:24 `import type PsBridgeOptions`）、workbuddy-llm←vm-capabilities（index.ts:32 import type）、adapter-host-workbuddy←contracts、host-sdk←contracts、mcp-framework←contracts（server.ts:9 `import type Logger`）、vm-capabilities←contracts、vm-capabilities←core（index.ts:14 `import type SessionProbe`）。
- **动态 provider 装载（2 条，设计选择）**：vm-service←adapter-agent-workbuddy / adapter-agent-workbuddy-llm，经 `core/bridge/loader.ts:90` `await import(entry.package)`，provider 表在 `core/src/config/index.ts:166-186` + `delivery/vm-service.config.json:21-44`（hermes 亦配置装载）。
- **幽灵声明（1 条，真缺口）**：**hermes←core** —— `packages/adapter-agent-hermes/src/` 全目录对 `@winvm/core` **零提及**（grep 仅命中 package.json:13 声明自身）。既非 type-only 也非动态装载，是**多余的 dependencies 条目**。危害：不炸运行期（UNDECLARED_EDGE 管反方向），但虚增 `delivery/link-workspace.mjs` 按声明补的 junction 闭包与分发面。**处置建议修订（见 §7.9，审计后期补证）：不要"删声明"，而要"用起来"** —— 该包对 core 唯一本该有的用法是 `expandEnvPath`，而它目前在 `adapter-agent-hermes/src/mcp-registrar.ts:29` 与 `adapter-agent-workbuddy-llm/src/{index.ts:75, bridge.ts:291,1006,1113}` 长出了 **5 份本地/内联副本**（未走 `core/src/constants.ts:31` 权威通路）。改为 `import { expandEnvPath } from '@winvm/core'` 可一条修复同时消除幽灵声明 **与** 展开语义漂移风险面（6→1）。两条路径均自洽，但"收口"收益严格优于"删除"，故选前者；改后 `npm run layout` 的 info 同样降为 10，可当回归钉。

**是否升级治理（改运行时显式注册表）？——裁决：不需要。** loader 已有 `registerProviderFactory` 进程内注册表（loader.ts:37-50）作为动态 import 的前置优先路径；动态装载是「换 VM 内 Agent 只需新增实现包 + 改 agent.provider 一行」这一 SPI 卖点（loader.ts:4-5）的实现基础。type-only 盲区已在 GATE-POLICY.md:55/63-65/131 如实登记（含「人工核对，承诺不成立 ⇒ 不写成成立」的诚实条款）。若将来要收紧**类型级**边，正确工具是 src 层扫描（`import type` 文本判据或 tsc 元数据），不是运行时注册表——后者解决部署闭包，前者才解决 lint 可见性。列 P2 可选。

### 1.5 contracts 包「契约内环」与同形漂移

- **内环实况（src 级 import 图）**：risk.ts ← {audit, capability, bridge}；capability ← schema-check；transport ← host；**audit.ts → 仅 risk.js；bridge.ts → {errors, capability, risk, audit}**。⇒ `audit.ts ↛ bridge.ts` 单向成立，AuditExt.approvalTruth 刻意内联（audit.ts:206-209 自述理由）的**登记偏差成立且必要**。但 dep-lint 只查**包间**边，**契约内文件级环无任何机检**——当前纯靠人治（P2 债：dep-lint 加 contracts 内部 import 图判据，~50 行，判 hard 零误报；进 Phase 3 守卫小批）。
- **同形漂移钉核验**（内联结构 vs bridge.ts:478 `ApprovalTruthAttribution`）：
  - 有钉：`tests/unit/phase2-truth-mcp-direct.test.js` **E5**（L665-672 钉 GoalResult 末尾键序+契约导出在场）、**E6**（L674-679 钉 audit.ts 内联为可选键且四值枚举正则逐字）。⇒ **同步守卫在册，无"零守卫"缺口**。
  - 但钉形态脆：源码文本正则——合法重构（如把内联改名成命名类型再引用）会打爆测试而非被豁免；新增第三处同形复刻不受约束。同族更优先例：`ArchiveVerification` 权威定义在 contracts、core `export type { ArchiveVerification } from '@winvm/contracts'` 再导出（core/src/index.ts:56-60，登记偏差 D-4），**单一权威**。approvalTruth 内联前提（audit↛bridge）只对"类型引用"成立；把共享接口挪到中性叶模块（如 risk.ts 同级新文件）即可让两侧同时 import、消除复刻。**裁决建议**：已接受债 + 文档化「下次触碰该契约时迁共享类型模块、删内联」（P2 非紧急）。
  - 同形族全景（治理时一并盘点）：`bridge.ts:194` 注释自述 BearerSelfCheckHealth 与 http-guard 逐字段同形、`host-a2a-bridge/approval-audit.ts:46` redact 同形复刻（有 approval-audit.test.js parity 钉）、`chain.ts:22`/`core/index.ts:57` 禁止第二份 ArchiveVerification。**建议**：GATE-POLICY 加《同形结构登记表》：每处同形必须「再导出」或「E6 式钉」二选一，显式列出当前豁免（见 D-5/③ 表）。P2。

### 1.6 框架层审计边（Q7 首月 warn）现状

`AUDIT_EDGE_IN_FRAMEWORK` 派生符号 7 个（GENESIS_HASH/HashChainAuditSink/canonicalJson/computeRecordHash/redact/sha256/ARCHIVE_VERIFY_MAX_SHARDS）。src 级复核：a2a-framework 全仓对 audit 的唯一提及是 server.ts:57 注释（"框架只留回调、不落审计"），mcp-framework 零提及 ⇒ **warn=0 与叙事一致，判据非恒绿**（dep-direction U-3 组已含假图必红自证）。类型级耦合（`import type { AuditRecord }`）盲区按 GATE-POLICY:131 口径人工核对——本轮人工核对结果：**框架 src 零 `AuditRecord` import**（git grep 零命中）。Q7 首月到期后可评估 `--strict-warn`，当前无触发项。

---

---

## ② 实现面技术债清单（代码实证）

> 每项：病灶 / 证据 / 影响面 / 改造面估计 / 优先级。

### D-1（原审计问题 2a）delegation-truth 兜底启发式依赖 LLM 措辞 —— **残余债比任务书假设的小，大头已还**

- **实况**：任务书把它记作"K3 遗留待根治"，但 Phase 2 · P2-T8 已把设计 §3.2 拆出的三个真缺口闭环（docs/changes/phase2-arch-design.md §13.9）：
  - **G-a**（纯 MCP 直调无真值层）已修：`delegation-truth.ts:316` 门 1 归属键 = `taskId ?? traceId` 双缺才回退；
  - **G-b**（兜底触发不可观测）已修：`onTruthDecision` 出参回调 + `ext.approvalTruth` 入链（delegation-truth.ts:201-216、audit.ts:211-217），`decidedBy:'text-fallback'` 可计数；
  - **G-c**（措辞脆弱性无回归样本）已修：`APPROVAL_WAIT_KEYWORDS` 常量钉（bridge.ts:746）+ `tests/unit/phase2-approval-wait-fallback.test.js`（276 行，判据 a/b/c/d 四组，含"同义改写不命中"反例集——bridge.ts:741-744 诚实登记「"已提交审批，请人工确认"不命中 ⇒ 漏判由结构化反查承担」）。
- **残余病灶（真还欠着的）**：兜底路径 `reconcileApprovalWait` 本身仍是文本正则（bridge.ts:805-806），**且它兜的不再是"审批等待"这一件事**——K5 完成声称反查（`reconcileDelegationTruth`，delegation-truth.ts:46-47 的 `COMPLETION_CLAIM_PATTERN`）的门 3「无完成声称 ⇒ 透传」依旧是措辞依赖：LLM 用未登记的同义措辞自宣完成（如"搞定了""已经弄好"）时，**零活动改判根本不触发**。这是"假成功"面上唯一还靠文本触发的判据。
- **"根治=bridge 直读 MCP 结构化结果"评估**：结构化数据源已存在且判据已消费它（probe.approvalWait / delegationActivity 全走服务端账本）——**不需要"新数据源"，需要的是把"是否要采信完成声称"的触发门从文本改为本轮工具调用计数**（execTurn 侧统计本回合是否有内层回连；delegation-audit 的 ledger 已能提供）。改造面：medium（bridge 收口链一处 + 判据门 3 语义重定义 + 约 15-25 例回归），风险：门 3 改为"恒查账本"后，非委派裸调用仍由门 2 挡住，委派形态多一次 probe 调用（本地回环，成本可忽略）。
- **优先级：P2**（shadow→on 全量后 `text-fallback` 占比可观测，若占比高再升 P1）。**不建议现在"根治"**——G-b 归因链刚建，先用它对拍 2-4 周再决定，符合设计 §5.1"先度量后优化"的同一纪律。

### D-2（原 2b）approval-replay / server.ts 早退路径零审计口子 —— **S-4 同族缺口还剩 4 处，其中 2 处在审批重放链上（真口子）**

- 装配守卫现状：`tests/unit/assembly-guard.test.js` `auditS4()` 钉死 `if (!verdict.allowed)` 两处拒绝分支必在 return 前调 `recordPolicyDeniedAudit`（计数恰 2、import 源单一、块长下限、审计先于 return、channel 归因）——**S-4 修复的两处本身已防复活**。
- 但对照同一纪律（"终态拒绝必须能在链上证明'到过服务端且被拒'"），其余早退仍有缺口，按危害排序：
  1. **`replay` 拒绝 ×2（server.ts:1161-1177）**：宿主批准后重放段里 `CAPABILITY_NOT_EXPOSED`（:1162-1168）与 `UNKNOWN_CAPABILITY`（:1170-1177）两个 return **零审计**。危害：批准后重放被拒 = 审批链上"批准已发出、执行未发生"的断层——事后取证只见 approval approved（且 approved 决策本就裁定不落链，server.ts:1571-1574）不见任何 executed/blocked 条目，**与 S-4 病灶同构**。S-4 修复时按 `!verdict.allowed` 锚点找口子，这两处挂在方法入口守卫上、锚点没扫到。
  2. **`executeCapability` 的 `!provider` 拒绝（server.ts:1103-1112）**：`PROVIDER_UNAVAILABLE` return 零审计。链上表现为"请求到过执行段但无任何终态条目"。
  3. **`runGoal` 的 `!provider` 拒绝（server.ts:1534-1540）**：degraded 态委派被拒零链痕（框架侧 observer 的 onGoalTerminal 只在 handler 被调后才有事件，:1531 handler 内早退 return 的对象不经 provider.runGoal ⇒ `delegationObserver` 是否落条目取决于 a2a-framework server.ts:401 的 result.ok=false 路径——框架侧会落 failed 壳条目，**此项危害降级**，证据不足判"零审计"；但壳条目内无拒绝原因归因，只有 summary 文本）。
- 改造面：small——`approval-replay.ts` 已导出两个 best-effort 审计函数，补 2-3 个调用点 + 把 assembly-guard 的 S-4 判据从"锚点扫 `!verdict.allowed`"升级为"**扫全部终态拒绝 return**（按 errorCode 常量表核对：POLICY_DENIED / CAPABILITY_NOT_EXPOSED / UNKNOWN_CAPABILITY / PROVIDER_UNAVAILABLE 每码对应一个审计注入点）"。建议列入下一批（与 bearer 自检同批或先于它——这是取证面，不是防线面，风险低于 R4 但同样"在册未做"级别的欠账）。**优先级：P1**（取证缺口，改动小、纯附加）。

### D-3（原 2c）persistent-session 冷启动与 firstCallLatencyMs 口径

- **冷启动**：K2 预热只覆盖"服务重启后首调"；`tick()` 空闲回收（persistent-session.ts:956-961）后 `lastUsedMs` 不重置为 0，下次 `runTurn→ensureReady` 重建子进程 = 再付一次冷启动。设计 §5.1 的裁断是**先度量后优化**，P2-T9 已交付 `firstCallLatencyMs` 采样（:614-637）。**但全仓（qa/ docs/ delivery/）grep `firstCallLatencyMs` 零真机数据落盘**（仅设计/测试文档命中）⇒ 度量件在、读数无人看过，"先度量"闭环没走完。真机窗口开工时应把 `/health.llmSession.firstCallLatencyMs` + `restarts` 纳入例行读数清单（文档级动作，零代码）。
- **restartFresh 不清零**（persistent-session.ts:216-223 注释自述"保守口径，避免复位被误读为冷启动已消失"）：**不留坑，且口径正确**——指标语义是"服务生命周期内首调"，复位≠重启。但有两个衍生观察：
  - 语义盲区：一次性采样 ⇒ 复位后/回收后的**后续冷启动全不记**（只有第一次付冷启动的人有数）。若度量目的含"冷启动发生率"，该指标只支持分子为 0/1 的粗测。**建议**：若数据证明冷启动频繁，把它升级为 ring-last-3 或加 `sessionSpawns` 计数（`spawnAttempts` 已在，snapshot 已透出 restarts，够用）。当前不动。
  - `tick()` 的 `wsProbe` 工作集护栏是**死参数**：全仓（src+tests+dist 消费面）零注入点——`PersistentCliSessionOptions.wsProbe?`（:93）与 `maxWsBytes` 全链路透传（config→bridge:1350→构造）后在 `tick()` :963 处恒 undefined ⇒ **`WINVM_LLM_SESSION_MAX_WS_BYTES` 是一个有名无消费的 env 旋钮**（config-key-lint 视其为合法键，snapshot-truth/dead-config 守卫均不覆盖它）。这属 P2-T2 清扫漏网的**真死配置**（见 D-4）。**优先级：P1-lite/P2**：要么接一个 `wsProbe`（tasklist/Get-Process 读工作集，一行 PowerShell），要么在文档与 config 注释里如实标注"未接线，护栏不生效"。
- 其余：`idleTimer.unref`、`restartFresh` 重挂 timer（:1000-1004）、树杀兜底（:137-151 taskkill /T /F）实现质量良好。

### D-4（原 2d）死配置面清点 —— **核心面已闭环，全仓仍有 3 处残余**

- 任务书锚点"capability.schema.json 缺 appops 且无运行期校验器"已过时：P2-T1 修了漂移（schema :26/:29 已含 appops），裁决 Q1=(b) 明确**运行期不接线是设计选择**（schema-check.ts:13-16 原文"禁止在 vm-capabilities 或 vm-service 启动路径调用"），交付面强制力由 gate ST3 `phase2-contract-schema.test.js`（23 例，含注入假域必红、漂移反例双组）承载 + gate.mjs:77-79 在册。**此项无债**。
- 残余死配置 grep 实证（P2-T2 清扫口径之外）：
  1. `llmSession.maxWsBytes` / `wsProbe`（上节，**运行期护栏未接线**——区别于 snapshot 的"裁决不实现"，这里注释宣称"工作集超限→释放重建"的机制半实现：消费点写了、探针源没接，是最坏的一种——看起来在工作）；
  2. `SessionConfig.probeIntervalMs`——**证据不足判死**：`core/src/session/health.ts` 的 SessionMonitor 接受 interval，server.ts 装配处是否传 cfg.session.probeIntervalMs 未逐行核验（需补验）；
  3. `DEFAULT_SERVICE_CONFIG.transport.preferred: []`（config/index.ts:165）——未发现消费证据；`policy: {}` 空段是占位不算。
  - （正面记录：`audit.snapshot` 26+2 处是**裁决级**信息性声明，有 `phase2-snapshot-truth.test.js` 事实三元组守卫 + ARCHITECTURE.md:297 划线诚实化，不是债；`AgentCard.signature`、`policy.approvalTimeoutMs`、`endpointAllowlist?:never` 均已删/转负类型并有 dead-config 守卫钉。）
- **建议**：把 `maxWsBytes` 处置（接线或诚实标注）并入 D-3；config 键 lint 只能管"未知键"，管不了"已知但无消费者的键"——可在 Phase 3 给 config-key-lint 加一条**反向判据**（每个叶子键 grep 消费点，白名单登记裁决级零消费键）。

### D-5（原 2e）同名异物/命名冲突族 —— **不建议重命名治理，建议"登记+定向钉"**

- 实证核对的 `probeError` 两处：`contracts/bridge.ts:56` `SessionHealth.probeError`（会话探针三码 PROBE_NOT_WIRED/TIMEOUT/EXCEPTION）vs `vm-service/http-guard.ts:236` `InnerReconnectView.probeError`（回连探针故障）——语义**同构**（都是"探针自身故障 ⇒ 结论未知、绝不据此升级判断"），不是冲突；两者无交集消费点（一个进 isGuiAllowed/lock-probe，一个进 resolveInnerReconnect 判序②），**误读风险低**。重命名的改动面（契约键+四处生产点+至少 5 个测试钉）大于收益。
- 真冲突风险在**同名单异语义**（比异名同物更危险）：已登记的 `IMPLEMENTATION_DRIFT` 双源（http-guard.ts:574 注释明令"不要再开同形函数"）、`redact` 同形复刻（host-a2a-bridge/approval-audit.ts:46，有 approval-audit.test.js 钉 parity）。**建议**：不立"重命名治理"专项；在 GATE-POLICY.md 加一节《同名单复义登记表》（名称/两处语义/消费面是否相交/守卫件），新增登记项必须有 E6 式钉——成本≈0，覆盖同类漂移。优先级 P2。

### D-6 附加发现（审计问题外，实证于本轮）

- **D-6a 文档↔实现漂移（CAPABILITY-MODEL §7）**：docs/02-design/CAPABILITY-MODEL.md:290-295"新增能力扩展流程"写的是 `powershell/<domain>/` 与 `registry/<domain>.ts`——**两个路径都不存在**（实况：`psmod/<domain>.ps1` + 单文件 `src/registry/definitions.ts`，54 条全量同文件）。该节是 FR-206 的对外承诺口径，且第 3 步"运行契约校验（自动）"实际是**手动测试+门禁**（Q1=(b)）。→ 归入扩展性改造（见⑤），P2。
- **D-6b 内联同形结构第三例**（见①1.5），P2。
- **D-6c dep-lint 头注 L90-93 与设计 §254 的 vm-service L2/L3 叙述差**在 T11 后仍未回写设计侧（文档单侧闭环即可），P2 卫生项。

---

## ③ 安全兑现度评估

### 3.1 审批链现状与灰度进度 —— **默认已是 on，"shadow 转全量"是个已被时代抛下的问题**

- 分级/闸：L0-L2（实为 L0-L3 策略面）分级在 contracts/risk.ts + 每条能力声明（definitions.ts 54 条全带 risk）；审批闸双通道（MCP=`__approvalId` 续跑 + A2A=input-required）经 K4/K5（服务端重放 + 参数只取服务端留存，server.ts:1156-1200）。
- **真值层三态默认值**：`APPROVAL_TRUTH_DEFAULT='on'`（core/constants.ts:246，"K3 是 fail-open 洞，默认必须补上"）；非法值/缺席回退 on（:249-254）。**K5 重放默认亦 on**（`APPROVAL_REPLAY_DEFAULT=true`，:216）。
- ⇒ **任务书问"shadow 何时可全量转 on"与仓库实况不符**：on 已是出厂默认，shadow 只是 `WINVM_APPROVAL_TRUTH=shadow` 的部署期灰度位。真正的"转全量"问题是**现网 VM 部署是否已跑在 on**——delivery/vm-service.config.json 的 provider options 未写 `approvalTruth` 键 ⇒ 走 env/默认 ⇒ **默认即 on**（除非 VM 的 start-hidden 环境变量显式置 shadow/off）。
- **K5 双通道口径**：delegation-complete 的 `ext.approvalTruth` 只在 ok:true 收口点落（门 0 pass-through 生产不可达，§13.9 裁断），双通道（常驻/单次 -p）共用 `attachTruthAttribution` 逐字同形（bridge.ts:1548/1814）。
- **给运维的可执行结论（shadow→on 观察期判据，若现网确有 shadow 部署）**：`grep '"decidedBy":"server"'` 链上计数 ÷ `(server+text-fallback)` 连续 ≥2 周 ≥99% 且 `textHeuristicVerdict` 对拍分歧样本逐条归因完 ⇒ 撤 shadow env。数据键已齐（G-b），**只差读数动作**。

### 3.2 bearer 生效自检（R4）—— **机制已在，缺的是"常开+强制前置"，优先级应升 P1**

- 病灶（误开 enforceBearer ⇒ 委派零副作用虚假完成）的三层现状：
  1. **启动期自检已落地**（P2-T5）：`runBearerMountSelfCheck` 同进程正/反例直调守卫探针（server.ts:762），五码枚举；`resolveInnerReconnect` 六级判序（http-guard.ts:243-286：探针故障≠broken、实证优先、无名⇒broken 明说未接线、有名无值⇒broken、有名有值⇒unverified 不谎称已证）；
  2. **Q4 fail-closed**：`enforced ∧ broken ∧ failClosed(默认 true)` ⇒ 拒启，拒前先落 `bearer-selfcheck` 链上条目（§13.5，证据无条件在场）；
  3. **运行期探针**（P2-T6）：listen 后自环回连探针（server.ts:2046-2049）+ `innerReconnectObserved` 可变观测面。
- **在册未做的"bearer 生效自检"缺口精确定位**：自检是**一次性启动期**的；`/health.security.authMode/bearerSelfCheck` 两键纯附加已透出（ARCHITECTURE.md:338 口径注记），但——
  - (a) 自检结论**无周期复检**（守卫挂载后 token env 被人撤掉 ⇒ authMode 面 `resolveAuthMode` 是请求期同源计算，401 会即时生效，拒的是"新挂载"场景，风险不大）；
  - (b) **`enforceBearer` 开启 runbook 尚未把"看 bearerSelfCheck=mounted-pass ∧ innerReconnect∈{ok,wired}"写成硬前置**——DEPLOYMENT 457-471 有三步开启叙述（§13.6），但"误开"路径仍只靠 fail-closed 兜（而 fail-closed 的 `enforceBearerFailClosed` 有一键回滚位 false ⇒ 现网若有人写过 false，开 bearer 就退化为"放行+告警"）；
  - (c) **hermes provider 的 bearer 通路不对称**：hermes registrar 已支持 `Bearer ${MCP_WINVM_API_KEY}` 预注册（mcp-registrar.ts:13-15/66-67，token 写 `.env` 文件 :15:338 行——**明文落盘**，与 codebuddy 通路的"env 名引用、值不落盘"纪律相悖，NFR-511 的例外面，登记：hermes .env 是 CLI 生态强制格式，风险=VM 内文件系统可读性，VM 内本就在信任域内（ARCHITECTURE.md:338"VM 内任意本地进程都在信任域内"），**可接受但须文档显形**）。
- **裁决建议**：`innerReconnect` 三态在 **provider options 未含 bearerEnvName 时判 broken** 已把"开了守卫忘接回连"钉死；剩余动作是把 (b) 的 runbook 硬前置（开 enforceBearer 必须同时显式写 `enforceBearerFailClosed` 保持 true 的**配置 lint 判据**——config-key-lint 可加一条"security.enforceBearer===true ∧ enforceBearerFailClosed!==true ⇒ HARD"）排进下一批。**优先级 P1**（成本低、堵住的是已实证过的"虚假完成"高危病灶的残余路径）。

### 3.3 回环绑定 + fail-closed 闭环性 —— **基本闭环，留两处显形缺口**

- 监听面（grep `listen(` 全仓 src）：服务侧唯一 `server.listen(cfg.server.port, cfg.server.host)`（server.ts:2040），host=a2a-bridge=本地 stdio MCP server 零网络监听（connector entry 走 stdio），隧道 daemon 仅 `127.0.0.1:localPort`（tunnel-daemon.mjs:224）。**非回环 host 恒拒**（config/index.ts:294-300：不看 requireLoopbackBind 取值，false 只得 warning + error；`/health.security.boundLoopback` 读**实际** `server.address()`（server.ts:1872-1880），谎报配置面不可能）。✅ 真闭环。
- **Host 头**：`req.headers.host` 仅用于 URL 解析（server.ts:1633），无 allowed-hosts 校验；**Origin/CORS**：全仓 `packages/vm-service/src` 零 origin 比对、零 Access-Control 头。SECURITY-GOVERNANCE.md:38 声称"HTTPS + bearer + **Origin 校验**（HTTP 模式）"——**文档宣称的 Origin 校验在代码中不存在**（第四种状态病灶的同族：写在文档里但运行期不存在）。缓解事实：HTTP 面全部 POST 需 `content-type: application/json` 吗——**不**（readBody 不校验 content-type，简单表单跨源 POST 形态可打 `/mcp`，但浏览器简单请求无法带 `application/json` CT 却可带 `text/plain` ⇒ JSON-RPC 仍会被解析——`/health` 的 GET 面本来即无鉴权豁免位）。⇒ 在纯回环+隧道拓扑下 DNS-rebinding/本地恶意页是理论面（VM 内信任域已声明包含任意本地进程；宿主侧隧道 18443 若宿主浏览器访问=自己打自己 VM，危害自洽）。**处置**：改 SECURITY-GOVERNANCE 文案（不假装 Origin 校验存在）或补一条 Origin/CT 拒否（改动小）。P2，文档诚实化优先。
- **fail-closed 三件套**核对：非回环拒启✅、bearer 自检拒启✅（带回滚位，见 3.2b）、`ProviderLoadError` ⇒ degraded + 仅 meta.* 暴露（loader.ts:70-71 注释 + server.ts degradedReason 面）✅。审计链写失败**不**阻断业务（best-effort 纪律，方向=可用性优先，取证面由 `/health.audit.chainValid` + archive-verify 条目显形）——这是**已裁断的**设计选择，注意它不等于 fail-open：链断不制造放行，只损失事后取证。

### 3.4 T13 断片（audit-20260918.jsonl entry#512）—— **verifyArchive 框架足以承载"标记断片+不可修复声明"，无需修复写路径**

- 断片性质（qa/evidence/audit/analyze.out:3）：`chainOk=false hashOk=true`、brokenAt seq=511、上条 hash=6ef553af25b2 而 entry#512 的 prevHash 指错——**条目自身重算哈希全对**，是"当日两次进程以同一链基线并发写"导致的分叉痕迹（历史遗留，2026-09-18；8 分片自 10-09 起恒在场，早于 Phase 2，§13.5 已记 backlog）。
- 架构处置评估，两条路的对价：
  - **修复写路径不可取**：改历史 jsonl 内容=制造篡改事实（哈希链的取证价值恰在"不可改"）；重签链需创世重放，破坏"当日快照"证据。
  - **verifyArchive 框架足够**：契约 `ArchiveVerification{shard,valid,brokenAt,reason}` 已是**分片粒度**的断裂事实载体（contracts/bridge.ts:600-611）；`/health` 的 archive 校验条目走**原始 audit sink** 落链（O-7 纪律，server.ts:801-812），且 `verifyChain` 只看 activeShards（chain.ts:88"已含断链的历史数据不会拖累新链 chainValid"）⇒ **新链健康度与历史断片天然解耦**。缺的只是一份**登记**：把"已知断片清单+成因定性（并发写分叉，非篡改）"写成静态事实源（qa/evidence/audit/known-broken.json 或 SECURITY-GOVERNANCE 附录），archive-verify 读到断片 ∈ 已知清单时把 `/health` 聚合文案从"链异常"降为"已知断片 N 片（登记原因：X）+ 新链 valid"。改造面：small（一处聚合文案 + 一份清单文件 + 2-3 例测试）。**裁决：走登记路线，P2**；不排修复批（P2-T13 候选可关闭——以"断片不可修复+已登记"终态结案）。
- 结构性防复发：断片成因的并发写防护**至今靠纪律不靠机制**（见 ④.3——同任务双棒与双服务实例是同族问题；`start-hidden-vm.ps1` 自清理强杀端口占用者=部署面已机制化，链写面（单进程内 seq 单调）本无并发问题，历史分叉来自"两个 vm-service 同时在跑"⇒ 部署面防双实例即链面防分叉，闭环成立）。

---

## ④ 可靠性架构评估

> 审计问题：隧道是否单点？看门狗兜底力度够不够？服务版本漂移有无防护？双进程并发是否机制化？

### 4.1 隧道链路：单点事实确认，但"单点"已被三层缓解，残余风险是**无人值守时的复活通路**

**架构事实（实证）**：宿主 → VM 的全部流量唯一经过 `127.0.0.1:<tunnelLocalPort>` 这条 SSH 本地转发，承载体是宿主侧常驻 `tunnel-daemon.mjs`（进程内 ssh2）。没有备用通路（无第二端口、无直连、无 HTTP 代理回落）——**拓扑上确实是单点**，这不是缺陷而是设计选择（VM 只监听 127.0.0.1:18443，安全模型决定了必须有一条穿透通道）。真正要审的是**单点失效后的恢复力**，分三层看：

| 层 | 机制 | 实证 | 裁决 |
|---|---|---|---|
| L1 连接内自愈 | `oh-tunnel.mjs` 指数退避重连：base 1s / max 30s / jitter 30%，`maxAttempts=Infinity`（L170） | delivery/oh-tunnel.mjs:47-48、537-554 | ✅ 覆盖网络抖动、VM 短暂重启（30s 内恢复的故障全部静默吃掉） |
| L2 进程级重挂 | `tunnel-daemon.mjs` 退避耗尽 ⇒ `giveup` ⇒ **`exit 1`**（不僵尸驻留）；pidfile 原子写；state 文件随 pidfile 派生（D6-A） | delivery/tunnel-daemon.mjs 全文（giveup⇒exit1 / uncaughtException 保活） | ⚠️ 设计正确（退出可被观测），但**退出后无人拉起**——见 4.2 |
| L3 复活触发 | ① WorkBuddy `SessionStart` 钩子 → `session-start.sh` → `winvm-plugin tunnel ensure`（幂等，已在线秒回 0）；② `setup.mjs` TUNNEL 相位 daemon-aware（复用→ensure→回落自建）；③ 插件启动服务标记 `tunnel-autostart.json` | delivery/hooks/hooks.json（SessionStart, timeout:5, `&` 后台）、delivery/hooks/session-start.sh 头部注释+尾部 ensure、delivery/setup.mjs:170-171/758/836、delivery/install-host.mjs:1132-1147 | ⚠️ 复活通路存在但**全部绑定"人/会话在场"** |

**关键残余风险（R-1，P2）**：L3 的三个触发源都是**事件驱动且事件源是人机交互**——新会话启动、跑 setup、跑安装。若 daemon `giveup` 退出（例如 VM 关机过夜、ssh 认证持续失败超过退避预算），且期间**没有新 WorkBuddy 会话**，隧道将保持死亡直到下一次人肉动作。全仓 grep `respawn|relaunch|selfHeal` 在 delivery/ **零命中**（仅 `packages/vm-capabilities/src/ps-bridge.ts` 有 VM 侧内部 selfHeal）⇒ **宿主侧没有面向 daemon 进程本身的外部看护者**（nohup + pidfile 模式的天花板，任务书预设成立）。

缓解建议（按侵入度递增）：(a) 诚实文档化——把"隧道非常驻自愈，长时间无人会话后需 `winvm-plugin tunnel ensure`"写进运维口径（当前 `adapter-host-workbuddy/src/index.ts:307-309` 的提示文案已经描述了真实机制，方向对，但未覆盖"daemon 已退出"这一态）；(b) 复用已有 HOURLY 自动化通道做一次 `tunnel status` 探活 + `ensure`（成本极低，但注意：**现存的 HOURLY 看门狗是团队级自动化，不是隧道级**，需要新注册一条，属运维配置不属代码）；(c) systemd/服务化——鸿蒙 NEXT 用户态无 systemd，不可行，永久排除。裁决：**(a) 必做（P2 文档批）、(b) 可选运维增强，(c) 永久接受**。

### 4.2 `giveup ⇒ exit 1` 的取舍是正确的，要保护它不被"好意"改坏

daemon 穷尽重试后**主动退出**而非无限挂起，配合 pidfile 消失 + state 派生（D6-A：pidfile 不在 ⇒ 权威态不可能是 RUNNING），使 `readTunnelStatus` 能给出诚实的 DEAD（delivery/winvm-plugin.mjs:1005-1030，且 pidfile 存活与端口可连交叉校验，state 陈旧仅用于诊断 = D6-B）。这是把"不可观测的僵尸"换成"可观测的死亡"，正确。**登记为架构不变量**：任何后续改动若引入"daemon 永不自杀"或"state 独立于 pidfile"，都在破坏可观测性。建议进 Phase 3 的守卫候选（同族手法已有先例：`assembly-guard.test.js` 纯函数判据）。

### 4.3 VM 侧服务可靠性：这一层的兜底**强于宿主侧**，是本次审计的正面发现

任务书预设"nohup+pidfile 天花板"仅适用于**宿主侧隧道**；VM 侧 vm-service 的可靠性设计成熟一档：

- 注册为**任务计划程序**任务，双触发器 BootTrigger + LogonTrigger（开机即起 + 登录即起），`RestartOnFailure` 崩溃自动重启 ×3 —— delivery/install-vm.mjs:241、329-332、360、794、820；
- GUI 域约束被显式建模：InteractiveToken + Session≥1 才有桌面，故 XML 的 `<Hidden>` 在交互式任务下会被 Windows 忽略 ⇒ 改用 `start-hidden.ps1` 经 `Start-Process -WindowStyle Hidden` 在**进程创建层**隐藏（install-vm.mjs:232-245 注释把 why 写透了，这是文档诚实化的优例）；
- ps-bridge 看门狗：**已修复"一次失败即永久不可用"的历史缺陷**（旧实现 `if (!this.running) return` 早退）——现语义 `stopped/restarting` 才早退，不 running ⇒ 带退避自愈（`HEAL_BACKOFF_MS=3_000`，防 spawn 风暴），running 但心跳超时（45s）⇒ **先 ping 再判死**，ping 通只补时间戳（空闲不发心跳属正常）—— packages/vm-capabilities/src/ps-bridge.ts:195-265、115、122、186-191（看门狗 `setInterval 5_000` + `unref`）。这套"探测优先于重启"的判据是对的，避免把忙当作死。

**残余（R-2，P2 观测性）**：`RestartOnFailure` 上限 ×3 意味着**连续第 4 次崩溃后调度器放手**，而宿主侧对"服务彻底死亡"的感知只有 `/health` 连不通（隧道在、服务亡 ⇒ 隧道 healthy 探针失败，`probeTunnelHttp` 返 false，install-vm.mjs:803 自检按"最多 3 次"耐心重试）。缺一个**跨侧的终态告警**：崩溃次数（`psBridge.restarts`）已经回传到 `/health`（server.ts:buildHealth D2 纯增量字段），但没有阈值判据把它升级为 degraded。建议：`/health.degradedReason` 纳一条 `restarts >= N`（Phase 3 小批，P2）。

### 4.4 双进程并发防护：**半机制化**，宿主侧强、VM 侧靠"抢端口自杀"兜底

| 场景 | 防护 | 实证 | 评价 |
|---|---|---|---|
| 第二个 tunnel-daemon | pidfile 幂等（`tunnel ensure` 已运行秒回 0、不建第二实例） | session-start.sh 注释 3)、setup.mjs:836 复用日志 | ✅ 机制化 |
| 部署脚本 vs 常驻 daemon 抢端口 | D14 决策顺序：复用→ensure→回落自建**并显式告警**可能冲突 | setup.mjs:823-870 注释与实现 | ✅ 历史 EADDRINUSE 事故的根治，且把"回落"标注为安全网非主路径（措辞诚实） |
| 第二个 vm-service | `start-hidden.ps1` 生成时内置**自清理**：`Get-NetTCPConnection -LocalPort` 命中即 `Stop-Process -Force` + 500ms 等待，再拉新 | install-vm.mjs:270-273 | ⚠️ 有效但属"后到者杀先到者"，非锁；孤儿 node 被强杀是可接受的（它本就该死），但**两个都健康时**语义变成"谁最后启动谁赢" |
| 卸载残留 | `schtasks /End` + 端口占用进程强杀 + `start-hidden.ps1` 包装进程强杀；`/proc` 扫 `tunnel-daemon.mjs` 签名兜底 | install-vm.mjs:213-229、uninstall.mjs:282-330 | ✅ |

**裁决（R-3，P2）**：并发防护**不建议**再往"分布式锁/租约"方向加码——单宿主 + 单 VM + 回环服务拓扑下，pidfile + 端口自清理已覆盖实际故障面，锁机制带来的死锁/陈旧锁清理反而增加不确定性。要做的是**把"后到者胜"显式写进文档**并加一条轻量守卫（`/health` 返回 pid + 启动时刻，运维脚本比对 pidfile 与实测 pid 是否同源；实证 `buildHealth` 已有 `server.address()` 实测 `boundLoopback`（server.ts:2007 区注记），加 pid 是纯附加，成本一次字段）。**永久接受当前机制，Phase 3 只做观测性补齐。**

### 4.5 服务与 psmod 版本漂移：**无任何指纹机制，实锤缺口（R-4，P1 候选）**

实证链：

1. psmod 是 **PowerShell 常驻进程启动期一次性 dot-source**：`packages/vm-capabilities/psmod/ps-bridge.ps1:226-243` —— `foreach ($mod in (Get-ChildItem -Path $PSScriptRoot -Filter '*.ps1' | Where Name -ne 'ps-bridge.ps1')) { . $mod.FullName; $script:LoadedModules[$mod.BaseName] = $true }`，注释明确"必须在**脚本作用域**（而非任何函数内部）dot-source"（函数作用域 dot-source 的函数返回即消失 ⇒ "模块已加载但找不到函数"的诡异故障）。推论：**改了 `*.ps1` 必须重启 ps-bridge 进程才生效，热更新在架构上不可能**。同时注意 L238-242 的容错设计：**单个域模块加载失败不拖垮 bridge**，只记"未加载"、调用时才明确报错 —— 这既是优点（局部故障隔离）也是漂移放大器（半部署状态下 bridge 照常 ready，缺的域要到首次调用才暴露）。启动诊断行已带 `已加载模块数=$($script:LoadedModules.Count)`（L246），是现成的指纹挂载点。
2. 部署链是**整目录复制**：`delivery/setup.mjs:600` `packagePayloadPaths`（无内容寻址、无清单哈希）。
3. 全仓 grep `sha256|createHash|checksum|指纹` 在 `delivery/*.mjs` 的**唯一命中是 `oh-tunnel.mjs:209-218` 的 SSH host key base64 指纹（TOFU known_hosts）**——即"指纹"一词在本仓库只用于对端身份，**产物完整性指纹为零**（哈希只用于审计链，不用于部署物）。
4. **`version: '0.1.0'` 三处硬编码字面量**：server.ts:1356（McpServer name+version）、server.ts:1483（agentCard.version）、`packages/vm-service/package.json:3`（根 package.json:3 亦 0.1.0）—— 目前"看着一致"，但 tests/ 里出现的 `'0.1.0'` **全部是测试内联 fixture**（phase2-dep-direction.test.js:90/97 构造假 package.json、protocols.test.js:314 构造期望对象），**没有任何守卫把 server.ts 的字面量与 package.json 的 version 对齐**。Phase 3 一旦升版本，极易出现"MCP 报 0.1.0、agentCard 报 0.2.0、实际包 0.3.0"的三方漂移，而 `/.well-known/agent-card.json`（server.ts:1674）和 `/mcp`（:1679）是**对外契约面**——外部 agent 会据此判能力版本，漂移即对外说谎。

漂移的实际后果（这才是它为什么值得 P1）：VM 侧 `definitions.ts`（TS 能力注册表）与 `psmod/<domain>.ps1`（PowerShell 实现）是**跨语言双写**，二者由 `tests/unit/psmod-contract.test.js` 在**构建期**钉死（54 条注册表↔函数映射、`EXPECTED_TOTAL=54` L126、域分布 meta3/system14/app8/storage13/gui11/appops5，且**双读 dist + src** L20/L36-37）——机制化程度很高，**这是本仓库最好的一条守卫**。但构建期守卫**管不到运行期**：VM 上跑着的 ps-bridge 常驻进程可能加载的是上一次部署的 `.ps1`，而 node 侧已是新 dist（因为 node 由任务重启拉起、PowerShell 子进程由 node 拉起——两者重启时机不同步）。`/health` 里没有 psmod 内容指纹，宿主无从发现。

裁决：**R-4 建议进 Phase 3，且成本可控**——(i) 把 `version` 三处字面量改为读包 `version`（或加一条构建期守卫：比对 server.ts 字面量 ↔ package.json version，手法同 assembly-guard 纯函数）；(ii) `ps-bridge.ps1` 启动时计算并回传自身（含 6 个域文件）的合并 sha256 前 12 位作为 `psmodFingerprint`，经 `/health` 透出，部署脚本在重启服务后**校验指纹已翻**（把"改 ps1 必须重启"这条隐性约束变成机器可验证）；(iii) 若 (ii) 判定过重，至少 (i) + 文档化"psmod 改动 ⇒ 必须整服务重启"。

### 4.6 可靠性小结

| ID | 项 | 等级 | 处置 |
|---|---|---|---|
| R-1 | daemon `giveup` 退出后无自动复活（复活通路绑会话） | P2 | 文档化 + 可选运维探活 |
| R-2 | `RestartOnFailure ×3` 后无跨侧终态告警；`restarts` 已回传但无阈值判据 | P2 | Phase 3 小批：`degradedReason` 纳 `restarts>=N` |
| R-3 | vm-service 并发靠"后到者杀端口持有者" | P2 | **机制永久接受**；补 pid+启动时刻观测面 |
| R-4 | 无产物/版本指纹：psmod 热更不可能 + version 三处硬编码无守卫 | **P1** | Phase 3：version 同源守卫 + psmod 指纹 |
| — | psmod-contract 跨语言契约守卫（构建期） | ✅ 优例 | 保持，作为其他契约的模板 |
| — | 隧道退避 / pidfile / state 派生 / D14 幂等复用 | ✅ 达标 | 登记不变量，加守卫候选 |

## ⑤ 扩展性改造建议

> 审计问题：新增一个能力 / 一个 provider / 一个 skill 分别要碰几处？checklist 是否缺失？hermes 与 codebuddy 的 MCP 预注册差异应否统一？

### 5.1 三条扩展通路的**实测触点数**

| 扩展动作 | 触点（实测） | 机制化程度 | 结论 |
|---|---|---|---|
| **新增 provider（Agent 后端）** | ①`packages/adapter-agent-<name>/src/index.ts`（实现 SPI）②同包 `package.json`（layer + `@winvm/core` 依赖）③`tsconfig.build.json` references（现 15 条）④`delivery/vm-service.config.json` `providers` 表 ⑤（可选）`contracts` 若有新契约类型 | **高**：装载侧零改动 —— `packages/core/src/bridge/loader.ts:73-111` `loadProvider` 走 `await import(entry.package)` + `registerProviderFactory`（L40-42）进程内注册表，SPI 卖点写在 L4-5；配置驱动而非代码驱动 | ✅ **本仓库扩展性最好的一条**。新 provider 不需要改 loader/server/路由，只加包 + 改配置。唯一硬前置：动态装载依赖 dist 产物存在（PR9 只读 dist 的既有约束，见 ⑥） |
| **新增能力（VM 侧操作）** | ①`packages/vm-capabilities/src/registry/definitions.ts`（`cap({id,module,fn,risk,...})`，现 54 条，`grep -c "cap({"`=54）②`packages/vm-capabilities/psmod/<domain>.ps1` 实现同名 PowerShell 函数 ③`tests/unit/psmod-contract.test.js:126` `EXPECTED_TOTAL` 必须手改（54→N）+ 域分布断言 ④（若涉对外语义）`skills/*/SKILL.md` 文档 ⑤`docs/02-design/CAPABILITY-MODEL.md` 清单 | **中**：跨语言成对性由守卫强制（好），但**总数断言需手改**、文档更新全靠自觉 | ⚠️ 主要缺口是**没有 checklist**，且文档 §7 路径已漂移，见 5.2/5.3 |
| **新增 skill（宿主侧使用说明）** | ①`skills/<name>/SKILL.md` 建目录即可 | **高**：`delivery/install-host.mjs:720-722` `loadSkillBundles(skillsRoot)` 从 `repoRoot/skills` **动态枚举**，无硬编码清单、无注册表 | ✅ 加目录即生效（重装插件后）。零代码触点 |

**暴露面自动派生（正面确认）**：`server.ts:652-657` `exposedCapabilities = provider ? registry.intersectDeclared(provider.declareCapabilities()) : registry.intersectDeclared(['meta.*'])`，`:1204` `mcpTools = exposedCapabilities.map(...)` ⇒ MCP 工具表、`/health.exposed`（:2099）、审批与策略评估（:1229-1236 `policy.evaluate({capabilityId, risk: cap.risk, ...})`）**全部从注册表单一事实源派生**。新增能力只要在 `definitions.ts` 落一条，MCP/A2A/policy/审批预览（`buildPreview`/`collectImpact`/`deriveUnderlying`）自动获得，**不需要在 server.ts 里加 if**。这是"高内聚"的实证，也是我最想在 Phase 3 保住的红线。

### 5.2 `CAPABILITY-MODEL.md §7` 新增能力流程**已文档漂移**（P2，必须修）

`docs/02-design/CAPABILITY-MODEL.md:290-295`（§7）描述的路径与实况**不符**：

| 文档写的 | 实况 | 后果 |
|---|---|---|
| `packages/vm-capabilities/psmod/<domain>/`（目录形态，暗示一能力一文件） | `psmod/` 下是 **6 个平铺文件**：`app.ps1 / appops.ps1 / gui.ps1 / storage.ps1 / system.ps1 / ps-bridge.ps1` | 照文档建目录 → dot-source 的 `Get-ChildItem -Filter '*.ps1' -File` 用 **`-File`** 过滤（ps-bridge.ps1:232）⇒ **子目录里的 .ps1 永远不会被加载**，且加载失败静默（只记"未加载"），首次调用才报错 |
| `packages/vm-capabilities/src/registry/<domain>.ts`（按域分文件） | 实况只有**单文件** `registry/definitions.ts`（54 条全在其中），`registry/` 目录内**无 index.ts** | 照文档建新文件 → 无人 import ⇒ 能力不存在，`intersectDeclared` 交集为空，MCP 少一个工具，排查成本高 |

裁决：**这是纯文档 bug，改动量 <10 行，但它是扩展性入口的第一道门**（新人照做必翻车）。归入 Phase 3 "文档诚实化批"（与 ① 节 ARCHITECTURE §2.2 缺两包、③ 节 Origin 宣称谎报同批，一次做完）。

### 5.3 缺一份《新增能力 checklist》——建议写成**可机检**的守卫而非散文

实测当前"5 个触点"里只有 ①② 被 `psmod-contract.test.js` 覆盖（TS 注册表 ↔ PowerShell 函数名成对、`EXPECTED_TOTAL=54`、域分布）。**未被覆盖的漂移面**：
- `EXPECTED_TOTAL` 手改：加了能力忘改数字 ⇒ 测试红（好，有信号）；但**同时改了**数字与断言 ⇒ 守卫被绕过（散文 checklist 也防不住，接受）；
- `risk` 分级与 `policy`：新能力若忘标 risk，会落到默认档 —— 无守卫比对"写操作系统类能力必须 ≥ 某 risk 档"；
- `skills/*/SKILL.md` 与能力集的一致性：skill 文档描述的能力清单与 `definitions.ts` 无任何机检绑定（与 `r19b-s5-write-allowlist-pairing.test.js` 的"成对性守卫"手法相比，这是空白区）；
- `CAPABILITY-MODEL.md` 清单：纯人工。

**建议（Phase 3，P2 一批）**：仿 `assembly-guard.test.js` / `psmod-contract.test.js` 的既有手法（纯函数判据 + 读 dist/src 双源），加一条 `capability-onboarding.test.js`：
1. 每条 `cap()` 必须有 `risk ∈ {read, write, destructive}` 且**非默认值静默**（缺省即红）；
2. `module` 必须 ∈ 6 个已知域（防"建新目录"错误）；
3. 文档清单条数 == `EXPECTED_TOTAL`（把文档纳入守卫，治 5.2 的病根）；
散文 checklist 写在 `docs/02-design/CAPABILITY-MODEL.md` §7 修正时一并补（步骤化：改 definitions → 加 ps1 函数 → 改 EXPECTED_TOTAL+域分布 → 跑 `npm run gate --quick` → 更新文档清单 → 重装 VM）。

### 5.4 MCP 预注册差异（hermes vs codebuddy）：**不该统一，但必须显形**（P2 安全面）

事实：`packages/adapter-agent-hermes/src/index.ts:9` 注释 + ADR-13 明确"hermes CLI 无 `--mcp` 参数，MCP 必须预注册"⇒ `mcp-registrar.ts:155-215` 把 `Bearer ${MCP_WINVM_API_KEY}` **写进 hermes 的 config.yaml 与 .env**（token 明文落盘）。codebuddy 侧则是启动时经参数/env 注入，不落盘。

**架构裁决：不要为"统一"去做抽象**。两者差异的根因是**上游 CLI 的能力差异**（hermes 没有运行时注入通道），不是本仓库的设计随意性；强行统一要么给 hermes 造一个 wrapper（增加一层不透明进程），要么把 codebuddy 也改成落盘（**降低安全性**）。正确处置是三点：
1. **文档显形**：在 `docs/02-design/SECURITY-GOVERNANCE.md` 增加一节"bearer 存置面不对称"，明写"hermes provider 存在 token 明文落盘（config.yaml/.env），VM 单机回环场景下接受；若 VM 变为多用户/可共享主机，此项升级为阻断项"；
2. **权限收敛**：部署脚本对 hermes 落盘文件做 `0600` 校验（若无法设权限则在 `preflight` 出 warn），把"接受"变成"有边界的接受"；
3. **配置面一致性守卫**：`config-key-lint`（gate ST2b）已管 key 漂移，可加一条"provider 表里出现 hermes 时必须存在 `MCP_WINVM_API_KEY` 来源声明"——避免半配置状态下 registrar 静默写空 token。

### 5.5 扩展性小结

| 项 | 等级 | 处置 |
|---|---|---|
| provider 扩展通路（loader SPI 零改动） | ✅ 优 | 保持；Phase 3 勿引入按 provider 分支的 if |
| 能力暴露面单一事实源（`intersectDeclared` 派生 MCP/policy/审批） | ✅ 优 | **登记为红线不变量**，加守卫候选 |
| `CAPABILITY-MODEL.md` §7 路径漂移（psmod 目录形态 / registry 分域文件均不存在） | P2 | 文档诚实化批，必做 |
| 无《新增能力 checklist》 | P2 | 补散文 checklist + `capability-onboarding.test.js` 机检 |
| `EXPECTED_TOTAL`/域分布需手改 | P3 | **永久接受**（手改即"有意识地确认"，自动派生反而会失去信号） |
| hermes bearer 明文落盘 vs codebuddy env 注入不对称 | P2 | **不统一**；文档显形 + 0600 校验 + 配置一致性守卫 |

## ⑥ 性能与规模隐忧

> 审计问题：长跑是否有无界增长？/health 热路径成本？gate 能否随规模演进？构建产物依赖会不会咬人？

### 6.1 无界增长面：**内存态已全面有界（正面发现），磁盘态与进程 RSS 是两处观测空白**

**已机制化的有界性（逐条实证）**：

| 有界对象 | 上限 | 实证 | 超限行为 |
|---|---|---|---|
| 委派回执条目 | `MAX_RECEIPT_ENTRIES = 200` | packages/vm-service/src/delegation-audit.ts:66 | 环形/截断 |
| 归因 underlying 项 | `MAX_UNDERLYING_ITEMS = 50` | delegation-audit.ts:56、:194（`if (prev.seqs.length < MAX) push`）、:213/:234（`if (length >= MAX) return`） | **静默丢弃新增**，保留先到项 |
| 任务存储 | `TASK_STORE_MAX_TASKS = 200` | server.ts:157、:990（构造注入）、:2020（`/health` 透出 maxTasks） | 驱逐 + **驱逐上链取证**（`ext.kind:'task-evicted'`，server.ts:110 / index.ts:81-95 P2-T7 F3/L1） |
| 归档校验代价 | `ARCHIVE_VERIFY_MAX_SHARDS = 30` | chain.ts:105 + :93-104 注记（"写死而不做成配置项"的理由：`/health` 级路径不可长阻塞）、:443/:451 | 超出**只计数不校验**，调用方可对比 `shardsTotal` 看出"还有多少没看" |
| 审批令牌表 | TTL 扫描 + 驱逐回调 | pending-approvals.ts:182-191（`sweepExpired`）、:240（定时触发）、:20 **O-10 在途保护**（跳过 `hostApproved===true`） | 模块**零审计依赖**（不 import sink，被逐条目返回给调用方处置）——分层洁癖的好例子 |
| 审计分片体积 | `maxFileBytes = 64 MiB`（默认值 `opts.maxFileBytes ?? 64*1024*1024`） | chain.ts:79（选项声明）、:142（字段）、:157（默认值）、:254-284（轮转找空位、满则跳下一轮转位） | 轮转新片 |

**结论：进程内 Map/Set 型增长面已全部收口，且有配套"驱逐即取证"纪律**。这是本次审计第二处强正面确认（第一处见 ④ 的 psmod 契约守卫）。

**观测空白两处**：

- **P-1（P2）零内存仪表**：全仓 grep `memoryUsage|heapUsed|process.report` 在 `packages/*/src`、`delivery/*.mjs`、`scripts/*.mjs` **零命中**。而本项目的常驻进程链相当长：宿主侧 `tunnel-daemon.mjs`（node）+ WorkBuddy；VM 侧 `vm-service`（node）+ `ps-bridge`（powershell 常驻，dot-source 6 域模块）+ `persistent-session` 拉起的 **codebuddy agent node 进程**（冷启动实测口径 75–107s，见 server.ts:652 下方 K2 注记）。孤儿/残留防护是有的（`start-hidden.ps1` 的 `finally { Kill }`、install-vm `killServiceProcess`、uninstall `/proc` 签名扫描、ps-bridge `treeKill/taskkill /T /F`），但**"活着的进程吃多少内存"全链路无一处读数**。风险形态：persistent-session 长跑 + 大 `wsProbe` 载荷（当前该护栏还**没接线**，见 6.3）⇒ 唯一能提前看见问题的仪表恰好不存在。建议 Phase 3 小批：`/health` 增加 `process.memoryUsage().rss`（纯附加，一字段），并把 `restarts`/`uptimeMs` 与 rss 放同一视图供趋势判断。
- **P-2（P3）审计日志磁盘无保留策略**：`maxFileBytes=64MiB` 只约束**单片**体积，轮转产生新片，但**没有任何"总片数上限/最老片删除"的保留策略**（chain.ts 全文无 prune/retention 逻辑）。长跑部署 + 高频审批/委派 ⇒ 审计目录单向增长。这是**合规取向的有意取舍**（审计数据不该被自动删），我裁决为**永久接受**，但必须文档化到运维口径："审计目录需纳入 VM 磁盘配额巡检"，否则第一次"VM 磁盘满"事故的现场会非常难解释（满盘时 `appendFile` 失败 ⇒ 审计写不进 ⇒ 是否有 fail-open？`server.ts:575` 包装 sink 的语义要复核 —— 记为 Phase 3 待验项 V-1）。

### 6.2 `/health` 热路径：`verifyChain()` 全量重算且**无缓存无节流**（P2，长跑退化）

实证：`buildHealth`（server.ts:1903）内 `const chain = await audit.verifyChain()`；`verifyChain`（chain.ts:348-398）每次执行 = `ensureLoaded()`（memoize，OK）+ `listShards()`（一次 readdir）+ 对 `activeShards` **逐分片 `readFile` + 逐行 `JSON.parse` + 逐条 `sha256(canonicalJson(rest))`**。chain.ts 全文 grep `cache|throttle|lastVerify|ttl` **零命中**。

代价模型：freshChain 模式下 `activeShards` 从空起、按 64MiB 轮转 ⇒ 校验量 = **自本次启动以来的全部审计条目**，随运行时长**线性增长**。每条一次 sha256（含 canonicalJson 递归字符串化），条目数上万时单次 `/health` 可达数百 ms–秒级；而 `/health` 是被多处调用的：`probeTunnelHttp`（setup.mjs:806，curl）、服务自检、宿主态查询。更关键的是**它发生在请求处理路径上**（`server.ts:1669` 直接 `await buildHealth()`），不是后台聚合。

这不是当前故障（Phase 2 真机基线只有数百条，见 `qa/evidence/audit/analyze.out` 量级），是**可预期的长跑退化**，且已被 ARCH-06 A2 的 `scope:'session'` 四字段"说清楚了"（诚实化做到了，优化没做）。裁决：
- Phase 3 做**节流而非缓存语义改动**：同一时间窗（如 15s）内复用上次 `verifyChain` 结果并附 `chainVerifiedAtMs`/`chainFreshnessMs` 两字段，保持判定口径不变（`valid` 语义逐字不动，只是"多久算一次"变了）。这与 `verifyArchive` 用 `ARCHIVE_VERIFY_MAX_SHARDS` 写死有界的既有思路同族，工程师有先例可循。
- **不要**改成"增量校验游标"——哈希链的 `prevHash` 语义使增量正确性证明成本高，收益/风险不划算。列为 P2（当前）→ 若 Phase 3 长跑出现 `/health` p95 抬升则升 P1。

### 6.3 LLM 会话护栏 `wsProbe` / `WINVM_LLM_SESSION_MAX_WS_BYTES`：**死参数 ⇒ 死配置**（P2，但语义敏感）

实证链（同 ② 节 D-3，此处按性能视角裁定处置）：`persistent-session.ts` 实现了 `wsProbe` 与 `maxWsBytes`（tick 内 L953-970 有 wsProbe 分支），但 `bridge.ts:1341-1358` 构造 `PersistentLlmSession` 时**传 `maxWsBytes` 而不传 `wsProbe`** ⇒ 该分支永不被触发 ⇒ `config` 里的 `WINVM_LLM_SESSION_MAX_WS_BYTES` 成为**真死配置**（有值、有注释、无效果）。

为什么这属于性能隐忧而不只是技术债：**唯一针对"常驻会话 WebSocket 缓冲膨胀"的护栏当前是纸面的**。叠加 6.1 的零内存仪表，形成"护栏没接 + 仪表也没有"的组合，最坏情形是 VM 侧长跑会话内存缓涨且无人先看见。处置二选一，必须显式（Phase 3 批）：
1. **接线**：构造处补 `wsProbe`（一次 `ws.diagnostics` 探测，代价与现有 tick 同频），保留配置项；
2. **诚实化**：若判定不需要，则删 `wsProbe`/`maxWsBytes` 与常量，并删配置注释，**不留"看着像护栏"的死码**。
我倾向 (1)——因为 `firstCallLatencyMs` 采样已证明冷启动代价在几十秒级，说明这条会话链路是系统里最贵的资源，值得有活体护栏。这是架构裁决，不是必须，故 P2。

### 6.4 冷启动与首调延迟：**K2 已根治，但 `firstCallLatencyMs` 一次性采样使指标只描述"今天的第一次"**

实证：K2 修复 = 服务启动后**异步预热** LLM 常驻会话（server.ts:652 下注记 + persistent-session `warmup`），把 A2A 首调从"必然落入 75–107s 冷启动窗口"变成后台付费。`firstCallLatencyMs` 在 `runTurn/recordFirstCall`（L614-642）一次性采样，**`restartFresh`（L988-1010）不清零**（L216-223 注记明确这是"保守口径"：宁可报旧的高值，也不报因重启归零的假低值）。

裁决：**口径选择是对的，永久接受并已在代码内文档化**。但 ② 节 D-3 的另一半仍然挂着：**Phase 2 承诺的"E-1 只度量不修"至今零真机读数**——预热是否真的把首调 P95 压进 SLA、`warmup` 失败率多少，没有任何数据。这条不是性能问题，是**性能决策无证据**问题，Phase 3 必须收口（读数 → 才有资格谈"要不要修"）。

### 6.5 门禁（gate）随规模的演进成本：设计对，但**全量档串行且逐文件起进程**

实证：`runPerFile`（scripts/gate.mjs:235-266）`for (const f of files)` **严格串行**，每文件一次 `node --test --test-reporter=tap <abs>` 子进程，单文件 `timeoutMs=600000`（10 分钟）。当前规模：`tests/unit` 92 个文件（`.test.js` 85 个，`readdirSync` 于 :274-275 枚举），基线 1889 例全绿。

- 成本模型：总时长 ≈ Σ(每文件 node 进程冷启动 + 用例时长)。文件数从 92 涨到 150–200（Phase 3 若按 Phase 2 的守卫增速完全可能），**全量档时间线性上涨**，且串行无法摊薄。
- 已有的正确缓解：`--quick` 档 = ST1+ST2+ST2b+ST3（**约 1–2 分钟**，gate.mjs:21 注释明确定位为"提交前/改完即跑的廉价档"）⇒ 把昂贵档从开发循环里摘出去了，这是**用分层档次管理规模**的正解，不需要重写。
- 并行化要谨慎：`GATE-POLICY.md:127` + K-1/K-2 纪律记录了两条既有事实——隧道/传输件测试恒含 `OFFLINE_SKIP`（权威口径不得当回归）与 **junction 0xC0000005 崩溃（故 ST4 禁用 glob、必须逐文件）**。"逐文件"这个约束本身就是为绕开批量崩溃留下的；一旦并行度上去，同机子进程争用可能重新诱发该类崩溃。建议：若必须提速，按已有的**分类元数据**分组并行——`GATE_GUARD_FILES`（gate.mjs:65）与 `GATE_EXCLUDED`（:112）都已为每个文件登记 `scope` 字段（如 :118 "SSH 隧道与传输件"一族），可直接以 `scope` 为分组键做**组间并行、组内仍逐文件、并行度≤2**，且以"能复现 0xC0000005"为红线预试验（注意：仓库中**不存在**现成的 groups 结构，分组需新建，但分组依据已在册）。裁决：P3 现状可接受，Phase 3 仅在体感成为交付瓶颈时动手。
- `GATE_EXCLUDED`（:112-）带理由登记 + `GATE_GUARD_FILES` 存在性校验（:361 `missing` 判红）——这套"排除必须写理由、守卫缺失必须判红"的纪律是规模化的护栏，**值得在文档里点名表扬并推广到 scripts/ 其他枚举面**。

### 6.6 脚本读 dist 的 freshness 依赖：ST1 前置已正确消解，但需登记不变量

`dep-lint.mjs` 读 dist 产物（L90-93 注记说明事实源选择理由），`gate` PR9 零依赖纪律要求脚本不 import 被测包 ⇒ 校验对象必然是构建产物 ⇒ 潜在"拿旧 dist 当被测物"。当前由**阶段顺序**消解：ST1 `tsc -b tsconfig.build.json`（:288，`timeoutMs=1800000`）在前，ST2 dep-lint 在后 ⇒ dist 必然新鲜。**登记为架构不变量**：任何新增守卫若把"读 src"改成"读 dist"（或反之），必须在脚本头说明理由——现成优例：`psmod-contract.test.js:20` 明确**双读** dist（运行期真实装载物）+ src（`DEFINITIONS_TS`/`DEFINITIONS_DIST` :36-37），因为它要防的正是"src 改了没重编"。这类"读哪个源"的决定应写进 `GATE-POLICY.md` 成为规则，而不是散在测试注释里。

### 6.7 性能小结

| ID | 项 | 等级 | 处置 |
|---|---|---|---|
| — | 内存态全面有界（200/50/200/30 + 64MiB 轮转 + 驱逐上链） | ✅ 优 | 保持；作为新 Map/Set 的默认纪律 |
| P-1 | 零 RSS/内存仪表（4 类常驻进程无任何读数） | P2 | `/health` 加 `memoryUsage().rss` |
| P-2 | 审计目录无保留/上限策略（单向增长） | P3 | **永久接受**（合规取舍）+ 运维巡检文档；V-1：满盘时审计写失败是否 fail-open 待验 |
| P-3 | `/health` 内 `verifyChain` 全量重算，无缓存无节流，随运行时长线性退化 | P2 | 加节流窗 + `chainVerifiedAtMs`（判定语义不动）；**不做**增量游标 |
| P-4 | `wsProbe` 未接线 ⇒ `WINVM_LLM_SESSION_MAX_WS_BYTES` 死配置（唯一 ws 膨胀护栏成纸面） | P2 | 接线（优先）或整体删除；**不得留死码** |
| P-5 | `firstCallLatencyMs` 一次性采样 / `restartFresh` 不清零 | — | **永久接受**（保守口径，已代码内文档化） |
| P-6 | E-1 度量承诺零真机读数 | **P1** | Phase 3 收口：读数→决策 |
| P-7 | gate 全量档串行逐文件（92→N 线性） | P3 | **--quick 分层档已是正解**；并行仅在瓶颈时按组做（防 0xC0000005 复发） |
| P-6' | 脚本读 dist 的 freshness | ✅ 已消解 | ST1 前置不变量 + "读 src/dist 须说明理由"入 GATE-POLICY |

## ⑦ 架构裁决与 Phase 3 立项建议

> 本节是审计的结论层：给出 P0/P1 清单、Phase 3 立项批次（含验收判据）、**永久接受并文档化**清单、以及必须保护的**架构不变量**。

### 7.1 裁决标准（先说尺子，再说结论）

| 级别 | 判据（三条同时满足才够格） |
|---|---|
| **P0** | ①当前正在发生（非"可能发生"）②影响安全承诺/审计可信/服务可用 ③无现成人工规避手段 |
| **P1** | 契约面/安全面存在**可证明的洞**（有明确触发路径），或决策**无证据**（承诺度量但零读数）；可在 Phase 3 首批收口 |
| **P2** | 观测性/诚实性/机制化补齐；不做不会坏，做了才"看得懂、改得动" |
| **P3 / 永久接受** | 有代价但收益不抵风险，或属**有意的架构取舍**（安全/合规/上游约束驱动），只需文档化 + 不变量登记 |

### 7.2 **P0 清单：空**（明确裁决，但附一条升级条件）

六维实证未发现任何满足 P0 三条判据的缺陷。特别说明最接近的一条：

- **D-2（② 节）4 处终态拒绝零审计** —— `server.ts:1162-1168`（replay `CAPABILITY_NOT_EXPOSED`）、`:1170-1177`（replay `UNKNOWN_CAPABILITY`）、`:1103-1112`（`executeCapability` !provider）、`:1534-1540`（`runGoal` !provider）。它违反 S-4 纪律（"终态拒绝必落 `recordPolicyDeniedAudit`"），是**安全取证面的真实洞**，但触发前提是 `provider === undefined`（degraded 启动态）或 replay 命中未注册 id —— 正常运行下 provider 必装载、id 必在册，故**非"正在发生"** ⇒ 定 **P1**。
  **升级条件（写给 QA 与运维）**：一旦真机出现 degraded 常态化（`/health.degraded:true` 持续存在，或 replay 命中未注册 id 的记录在任何 log 里出现），D-2 **立即升 P0**，因为那时"被拒的调用"会静默消失于审计面，破坏哈希链作为"完整事实面"的根本定位。

### 7.3 **P1 清单（4 条，Phase 3 首批）**

| ID | 缺陷 | 触发路径（实证） | 修复代价 | 验收判据 |
|---|---|---|---|---|
| **D-2** | 终态拒绝零审计口子 ×4 | 见 7.2 | 小（注入 `recordPolicyDeniedAudit`，纯审计附加） | ①新增守卫（仿 `assembly-guard.test.js` 纯函数判据）断言"4 个拒绝分支各恰 1 处审计调用、且在 return 之前"；②`npm run gate --quick` 绿 |
| **R-4** | `version: '0.1.0'` 三处硬编码（server.ts:1356 McpServer / :1483 agentCard / package.json:3）**无同源守卫**；psmod **无产物指纹**（dot-source 于 ps-bridge.ps1:226-243，全仓 delivery/ 零内容哈希） | Phase 3 升版本即漂移；改 `.ps1` 忘重启服务 ⇒ node 新 dist + PowerShell 旧函数，跨语言契约只在构建期成立（`psmod-contract.test.js`），运行期无校验 | 小-中 | ①守卫：比对 server.ts 字面量 ↔ `packages/vm-service/package.json` version；②`/health` 透出 `psmodFingerprint`（6 域文件合并 sha256 前 12 位，可复用启动诊断已有的 `LoadedModules.Count` 挂载点 ps-bridge.ps1:246）；③部署脚本重启服务后**校验指纹已翻** |
| **P-6 / D-3** | E-1 度量承诺**零真机读数**（K2 预热、`firstCallLatencyMs`、`persistent-session` 冷启动代价 75–107s 全无量表） | `docs/changes/phase2-arch-design.md` P2-T? 明确"只度量不修"，但 `qa/evidence/` 无对应读数产物 | 极小（纯采集） | 出一次真机读数报告（首调 P50/P95、warmup 成功率、restarts 分布），据此裁决"是否立项修" —— **没有读数就没有修的权利** |
| **B-1'** | 开启 `enforceBearer` 缺 **config-lint 硬前置** | ③ 节：`runBearerMountSelfCheck` 五码 + `resolveInnerReconnect` 六级判序 + Q4 fail-closed（`enforced∧broken∧failClosed⇒拒启`）**均已交付**，即"敢开"的机器条件已具备；缺的是 `config-key-lint` 里"设 `enforceBearer:true` 时 tokenEnv 必须有来源"的**前置拒绝**（现仅在 `core/src/config/index.ts:321` 出告警文案） | 小 | 造一个 `enforceBearer:true` 且无 token 来源的配置 ⇒ `npm run gate` ST2b 判红（而不是运行期才发现回环暴露） |

### 7.4 Phase 3 立项批次建议（按批次而非按缺陷，便于工程排期）

| 批次 | 内容 | 归因维度 | 建议优先级 | 备注 |
|---|---|---|---|---|
| **B-1「安全面收口」** | D-2 四处补审计 + 守卫；B-1' config-lint bearer 前置 | ②③ | **P1** | 两件事都改 `server.ts`/`config` 邻域，合成一批减少回归面 |
| **B-2「诚实化批」** | ① ARCHITECTURE §2.2 补两包（adapter-agent-workbuddy-llm / hermes）+ host-a2a-bridge 表 L2→字段 L3-host-bridge 对齐 + 删除"口径注记"承诺（零命中）；② SECURITY-GOVERNANCE.md:38 **Origin 校验宣称代码零命中** ⇒ 改述为"未实现"（第四种状态同族）；③ CAPABILITY-MODEL.md §7 路径修正（psmod 目录形态、registry 分域文件均不存在）；④ `hermes .env` 明文 bearer 不对称显形（新增"bearer 存置面"节）；⑤ `readTunnelStatus` 运维口径补"daemon 已退出需手动 ensure" | ①③④⑤ | P2（其中 ②③ 建议并入 B-1 同期做，因为它们是新人第一道门的误导源） | 纯文档，但**必须有守卫防再漂**：加"文档条数 == 代码事实"机检（见 B-3） |
| **B-3「机制化补齐」** | ① dep-lint 扩展**contracts 包内文件级内环**检查（现无守卫，audit.ts↛bridge.ts 仅靠注释）；② `capability-onboarding.test.js`（risk 必填非默认 / module∈6 已知域 / 文档清单条数==EXPECTED_TOTAL）；③《同名单复义登记表》与《同形结构登记表》纳入 docs/（D-5 治理：`probeError` 两处语义同构**不重命名**，改登记）；④ 隧道不变量守卫（giveup⇒exit、state 随 pidfile 派生 D6-A，仿 assembly-guard 手法）；⑤ **N-1 收口（新增，见 §7.9）**：`expandEnvPath` 的 6 份实现收口到 `core/src/constants.ts:31` 权威通路（同时消除 hermes←core 幽灵声明）+ 跨平台默认值诚实化 + `config-key-lint` 增加“占位符不可展开”判据 + `layer` 元数据校正 | ①②⑤⑦.9 | P2 | dep-lint 扩展要小心中环检查的**假阳性**（type-only 盲区已存在，勿在内环上再加一层误判）；⑤ 优先级建议在 ①之前，因为它是“一行 import 换掉 5 份副本”的最高性价比项 |
| **B-4「观测性批」** | ① `/health` 加 `memoryUsage().rss`；② `degradedReason` 纳 `psBridge.restarts >= N`；③ `verifyChain` 节流窗 + `chainVerifiedAtMs`/`chainFreshnessMs`；④ vm-service 透出 pid + 启动时刻（供与 pidfile 交叉校验） | ④⑥ | P2 | 全部为**纯附加字段**，不改任何判定语义，风险最低、收益是"长跑可解释" |
| **B-5「T13 登记批」** | known-broken 分片清单 + 聚合文案降级（`chainOk=false ∧ hashOk=true` = 并发写分叉，非篡改；写路径已由 `writeQueue` 串行根治 chain.ts:300-310） | ③ | P2（**关闭 P2-T13 修复候选**） | 架构裁决：修复历史分片 = 制造篡改事实，**只登记不修** |
| **B-6「wsProbe 决断」** | 二选一：接线（补 `bridge.ts:1341-1358` 构造处传 `wsProbe`）或整体删除（含 `WINVM_LLM_SESSION_MAX_WS_BYTES`）。我的倾向是**接线** | ②⑥ | P2 | **红线：不得留"看着像护栏"的死码 + 死配置并存** |

**明确不建议现在做**（反过度设计清单）：
- ❌ 隧道多通路/服务化（鸿蒙 NEXT 用户态无 systemd；单点已被三层缓解）；
- ❌ vm-service 分布式锁/租约（pidfile + 端口自清理已覆盖实际故障面，锁引入的死锁/陈旧锁清理更贵）；
- ❌ 哈希链增量校验游标（`prevHash` 语义下正确性证明成本高）；
- ❌ 统一 hermes/codebuddy MCP 预注册方式（差异根因是**上游 CLI 能力差异**，见 ADR-13）；
- ❌ gate 并行化（`--quick` 已是分层档正解；并行可能复发 K-2 junction 0xC0000005）；
- ❌ 重命名 `probeError` 等同名异物（两处语义**同构非冲突**，改名会打断跨包注记链，代价大于收益，改为登记）。

### 7.5 永久接受并文档化清单（"这不是债，是取舍"）

| 项 | 为何接受 | 必须文档化的措辞要点 |
|---|---|---|
| **type-only import 擦除盲区**（dep-lint 判据固有） | TS 编译期擦除 ⇒ dist 产物上不可见，任何基于 dist 的静态检查都必然漏这类边；改读 src 会破坏"事实源=运行期真实装载物"的选择（dep-lint.mjs:90-93 注记） | 在 GATE-POLICY 明写"DECLARED_UNUSED 11 边中 8 条为 type-only，属**已知不可判**，不得当回归、也不得靠加豁免清零" |
| **`freshChainOnStart: true` 历史分片退出判定面** | 语义正确（链基线随启动重置，防历史断片污染新链 chainValid）；ARCH-06 A2 已用 `scope`/`shardsVerified`/`shardsTotal`/`shardsArchived` 四字段把范围说清（chain.ts:117-129"本批不改，P0 根治另立项"） | 保留 P0 另立项占位，但**先做 B-5 登记**，避免把"已诚实披露"当"已根治" |
| **审计目录无保留/上限策略** | 合规取向：审计数据不应被自动删除 | 运维口径：VM 磁盘配额巡检；**V-1 待验**：满盘时 `appendFile` 失败的 sink 语义是否 fail-open（`server.ts:575` 包装 sink 需复核） |
| **`firstCallLatencyMs` 一次性采样、`restartFresh` 不清零** | 保守口径：宁可报旧高值，不报归零假低值（persistent-session.ts:216-223 注记已诚实） | 指标定义文档写"描述本轮首个调用，非稳态延迟" |
| **`EXPECTED_TOTAL` / 域分布需手改** | 手改 = 有意识确认；自动派生会静默吞掉"我加了个能力"这个信号 | checklist 里明写"改数字是特性不是负担" |
| **hermes token 明文落盘** | 上游 CLI 无运行时注入通道（ADR-13）；VM 单机回环场景下风险可容忍 | 文档明写边界条件："若 VM 变为多用户/可共享主机，此项**升级为阻断项**"；配套 0600 校验 |
| **隧道单点拓扑** | 安全模型（VM 只监听 127.0.0.1:18443）必然要求一条穿透通道；无备份通路是设计选择 | 运维口径 + hooks 文案已对齐真实机制（`adapter-host-workbuddy/src/index.ts:307-309`） |

### 7.6 架构不变量登记册（建议进 `docs/02-design/`，供后续所有变更比对）

1. **能力暴露面单一事实源**：`registry.intersectDeclared(provider.declareCapabilities())`（server.ts:652-657）⇒ `mcpTools`（:1204）、`/health.exposed`（:2032，另 :1983 `capabilities.count/available`）、`policy.evaluate({risk: cap.risk})`（:1229-1236）、审批预览（`buildPreview`/`collectImpact`/`deriveUnderlying`）**全部派生，禁止在 server.ts 里加按能力/按 provider 的 if 分支**；
2. **provider 装载零代码改动**：`loader.loadProvider` = `await import(entry.package)` + `registerProviderFactory`（loader.ts:73-111/:40-42）；
3. **内存态必带界**：任何新增进程内 Map/Set 必须给出上限常量 + 超限行为 + 若驱逐则驱逐上链（`task-evict-audit` 范式）；
4. **终态拒绝必上链**（S-4）：所有返回拒绝/失败的**终态**分支必须在 return 前落审计 —— 这是 D-2 的规范依据；
5. **可观测性优先于永活**：守护进程穷尽重试后**退出**（giveup⇒exit 1）而非挂起；pidfile 是权威态唯一来源（D6-A/D6-B）；
6. **构建期跨语言契约**（`psmod-contract.test.js`，54 条 + 域分布 + dist/src 双读）为**模板**：新增任何跨语言/跨产物契约须仿此"双读 + 总数断言 + 分布断言"；
7. **gate 事实源选择须显式**：读 src 还是读 dist 必须写明理由（防旧 dist 当被测物；ST1 `tsc -b` 前置为唯一保障）；
8. **文档"条数即事实"**：清单型文档（能力表、分层表）应被机检绑定到代码事实（B-3 ②），否则视同宣称。

### 7.7 对任务书原始前提的**实证纠偏**（审计的元结论）

本次体检最重要的一条发现不是某个缺陷，而是**任务书前提有 5 处已过时**，说明 Phase 2 交付质量高于其自身登记文档的时效性：

| 任务书前提 | 实况 | 证据 |
|---|---|---|
| "K3 依赖兜底措辞，需评估改造" | 兜底已由 P2-T8 **G-a/b/c 闭环**；残余仅是"完成声称文本触发门"的措辞面（P2 先度量） | `delegation-truth.ts` 门0-门6 判定表 L229-249、`onTruthDecision` 归因回调、`ext.approvalTruth` |
| "bearer 生效自检在册未做" | **已交付**：`runBearerMountSelfCheck` 五码 + `resolveInnerReconnect` 六级判序 + Q4 fail-closed + P2-T6 回连通路 + `boundLoopback` 实测 `server.address()` | http-guard.ts:243-286/:236、config/index.ts:112/:321/:343、server.ts:2007 区 |
| "shadow→on 需决策转全量" | **时代错置**：默认已是 `on`（`APPROVAL_TRUTH_DEFAULT='on'` constants.ts:246）；残余是"读数动作"（判据：server 命中占比 ≥99% 连续 2–4 周） | constants.ts:246、`APPROVAL_REPLAY_DEFAULT=true` :216 |
| "approval-replay 早退有零审计口子（未定位）" | **已定位为 4 处**，且对照出与 replay 分支同类缺口（可精确修复） | server.ts:1162-1168/:1170-1177/:1103-1112/:1534-1540 |
| "schema 死配置面需清理" | schema 面**已闭环**；残余死配置仅 3 处，其中 `WINVM_LLM_SESSION_MAX_WS_BYTES` 因 `wsProbe` 未接线而真死（新增发现） | bridge.ts:1341-1358（传 maxWsBytes 不传 wsProbe） |

**由此得出一条流程级建议**：Phase 3 立项文档应增加"**前序裁决时效性复核**"环节 —— 本次若照任务书原样去"做 bearer 自检"，就会重复交付已存在的功能。这条建议本身零代码成本，属团队实践，转给 PM/QA 与我（架构侧）共同遵守。

### 7.8 一句话总判

**WinVM Bridge 的分层纪律、契约守卫与有界性设计高于同类项目常见水准（三处强正面确认：`intersectDeclared` 单一事实源派生、`psmod-contract` 跨语言双读守卫、内存态全面有界+驱逐上链）；真实风险集中在"对外宣称与代码事实的时效差"（文档漂移 5 处、Origin 谎报 1 处、version 无同源守卫）与"运行期观测面缺失"（零 RSS 仪表、`/health` 无节流、psmod 无指纹、E-1 零读数）两类，均可在 Phase 3 以 B-1~B-6 六个小批收口，无需架构重构。**

### 7.9 审计期间旁证发现：跨平台占位符展开漂移（N-1，含根因）与只读纪律自证

#### 7.9.1 旁证：审计窗口内仓库唯一写入 = 一个 `%LOCALAPPDATA%` 字面量目录

只读自证（mtime 扫描，非口头保证）：以 19:42（本审计启动时刻）为界递归扫仓库（排除 `node_modules/dist/.git/coverage`），窗口内**唯一**发生写入的仓库内路径是

```
%LOCALAPPDATA%/WinVMBridge/logs/winvm-service-2026-10-12.log   （mtime 2026-10-12 21:12）
```

即仓库根下存在一个**名字就是 `%LOCALAPPDATA%` 的字面量目录**。该文件不是本会话产物（我在本审计中的全部写入仅落在 `/storage/Users/currentUser/wbtmp/`）；同目录另有 09-28 / 10-08 / 10-09 三个同类文件 ⇒ 有**周期性执行体**在反复写它。本环境 `git` 不可用（多条命令返回 `git: command not found`），故我不以 `git status` 作证，以下判断基于 `.gitignore` 规则文本与 `ls -la` 实测：`.gitignore:20` = `*.log` 只覆盖目录内的日志文件，**目录本身未被忽略** ⇒ 它会以未跟踪垃圾的形式出现在任何 `git status` / 目录枚举结果里。

#### 7.9.2 根因：`expandEnvPath` 语义 + Windows 模板默认值在 POSIX 上必然原样保留

- 权威实现 `packages/core/src/constants.ts:31`：`p.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name) => env[name] ?? m)` —— 未命中即**原样保留**，且 L21-23 注记明确写了"**非 Windows 环境下同样按字面处理**"（这是有意的"绝不吞成空串"纪律，方向对）；
- 但默认配置值是 Windows 模板：`packages/core/src/config/index.ts:188` `audit: { dir: '%LOCALAPPDATA%/WinVMBridge/audit' }`、`:180` `outputDir: '%USERPROFILE%\\WinVMWorkspace\\out'`、`LOG_DIR_TEMPLATE`（`:193-194` 注记"保持 `%LOCALAPPDATA%` 模板，在 resolveServiceConfig 展开，使 DEFAULT_SERVICE_CONFIG 在不同环境下保持确定性"）。

⇒ **在 `LOCALAPPDATA` 未设的宿主（鸿蒙 NEXT / 任何 POSIX）上，这个"确定性"就是字面量 `%LOCALAPPDATA%`**，随后被 `mkdir`/`appendFile` 消费 ⇒ 当前工作目录下生成垃圾目录。这是设计组合出的**必然结果**，不是偶发。

#### 7.9.3 真正的架构问题：该逻辑被复制成 **6 份**，其中 3 份是未走权威通路的本地实现

`grep -rn "replace(/%" packages/*/src --include=*.ts`（排除 dist）实测：

| # | 位置 | 是否权威 | 说明 |
|---|---|---|---|
| 1 | `packages/core/src/constants.ts:31` `expandEnvPath` | ✅ 权威（L1a 叶） | `constants.ts:24-30` 的 T2/ARCH-17 注记写明了收口理由："策略引擎模式侧（`policy/engine.ts` 路径白/黑名单）与本函数的既有消费方（audit 目录、日志目录、provider `outputDir`）**必须走同一条展开通路** —— 若两处各有一份实现，运维在配置里写 `%USERPROFILE%` 与在默认策略里写 `%USERPROFILE%` 的展开语义就会漂移"；该下沉**已完成**（config 与 policy 都从 core 引，且注明"不构成包内环边"） |
| 2 | `packages/adapter-agent-hermes/src/mcp-registrar.ts:29` | ❌ 本地实现 | 与 #1 **逐字符同构** |
| 3 | `packages/adapter-agent-workbuddy-llm/src/index.ts:75` | ❌ 本地实现 | 同上，同构 |
| 4 | `packages/adapter-agent-workbuddy-llm/src/bridge.ts:291` | ❌ 内联 | 同上 |
| 5 | `packages/adapter-agent-workbuddy-llm/src/bridge.ts:1006` | ❌ 内联 | `outputDir` 解析点 |
| 6 | `packages/adapter-agent-workbuddy-llm/src/bridge.ts:1113` | ❌ 内联 | 同上（第二处 outputDir 消费点） |

即 **ARCH-17 的收口在 core 内做到了，但在两个 adapter 包里重新长出了 5 份本地实现**（两个具名函数 + 三处内联正则），而这两个包**本可以合法依赖 core**（L2 → L1a 方向，dep-lint 允许）。

**这与我 ① 节找到的那条"真幽灵声明"是同一根因的两个症状**：`packages/adapter-agent-hermes/package.json:13` 声明 `@winvm/core` 却 src 零 import（dep-lint DECLARED_UNUSED）—— 实测 `packages/adapter-agent-hermes/src/*.ts` 里 **`@winvm/core` 零命中**，而它对 core 唯一"本该有的用法"正是 `expandEnvPath`（`mcp-registrar.ts:29` 的本地分身）。对照组：**llm 包不在幽灵名单里**，因为它确实引了 core（`src/bridge.ts:36`、`src/index.ts:31`）。所以：**幽灵声明是"该复用却复制"的记账表现，漂移风险是它的运行期后果**，一条修复同时治两条。

#### 7.9.4 附带发现：`layer` 标签被两个包共用同一个字符串（元数据漂移，P3）

实测 `node -e require(...package.json)`：`adapter-agent-hermes` 与 `adapter-agent-workbuddy-llm` 的 `layer` 字段**都等于 `"L2-adapter-agent-llm"`** —— 即 hermes 的层级标签里写着另一个包的名字。机检不受影响（dep-lint 按 L2 前缀解析 rank=40），但分层表按 layer 字符串比对时会误合并两个包。与 ① 节"文档侧 3 处偏差"同族，属低成本元数据校正。

#### 7.9.5 危害与定级

**N-1 定级 P2**（观测面 / 工作区整洁面，**非安全事故**），三条真实后果：
1. 仓库根出现未被 `.gitignore` 覆盖的垃圾目录，污染工作区与一切目录枚举工具（本次 mtime 扫描正是靠它现形）；
2. 日志/审计/`outputDir` 实际落到未预期路径，而 `file-logger` 的降级纪律（目录不可写 ⇒ `/health.logging.degraded=true`，`packages/core/src/file-logger.ts:10`/`:42`/`:290`）会把它呈现为"**日志降级**"而非"**路径错了**"，排障时极易误读成磁盘/权限问题；
3. 展开语义漂移风险面被放大：6 份实现中任何一份被改写（例如有人加 `~` 支持或改成 `$VAR` 语法），策略白/黑名单与 provider `outputDir` 就会不一致 —— 而这正是 `constants.ts:26-29` 注记点名要防的事，**现在正以 5 份副本的形式发生**。

#### 7.9.6 建议（并入 B-3 机制化批，代价 = 一次改动 + 一条 lint 判据）

1. **收口到权威通路（同时治 N-1 与幽灵边）**：删除 5 份本地/内联实现，两个 adapter 包统一 `import { expandEnvPath } from '@winvm/core'`（L2→L1a 合法）。收益：`DECLARED_UNUSED` 的 hermes←core 幽灵声明自动消失（变成真实依赖），分层表少一条豁免，漂移风险面从 6 收到 1。
2. **跨平台默认值诚实化**：`expandEnvPath` 增加"未命中 ⇒ 按平台回落默认根（POSIX ⇒ `~/.workbuddy/winvm/...`；win32 ⇒ 保留原语义）"，或在 `resolveServiceConfig` 层对 `%...%` 残留做显式校验，不要静默把字面量交给 `mkdir`。
3. **配置 lint 判据**：`config-key-lint`（gate ST2b，已在册）新增"路径型配置值含 `%VAR%` 且当前平台无法展开 ⇒ warn"，纳入既有死配置/键漂移治理面（手法一致，无需新框架）。
4. **元数据校正**：`adapter-agent-hermes` 的 `layer` 改为自身名（如 `L2-adapter-agent-hermes`），并让 `npm run layout` 顺带比对"layer 标签 ↔ 包名"一致性。

#### 7.9.7 审计元纪律复核与待验项

**纪律复核**：全程未修改任何仓库文件、未执行 git 写操作。任务书允许的两条机检中，`npm run layout` 已执行并记录（VERDICT: GREEN，hard=0 / warn=0 / info=11）；`gate --quick` **主动未执行** —— 其 ST1 为 `tsc -b tsconfig.build.json`（`scripts/gate.mjs:288`），会重写各包 `dist/` 与 `**/*.tsbuildinfo`，与"全程只读"存在张力；两者冲突时我选择更严格的"不跑"。**建议把该取舍写进审计纪律**（"允许跑 gate"与"禁止重写产物"不可并存时必须显式裁决），并给 dep-lint 增加 `--allow-stale-dist` 显式声明，避免只读检查误把旧 dist 当被测物（呼应 ⑥.6）。

**待验项（证据不足，显式标注，移交 QA / 后续批）**：
- **V-1**：磁盘写满时 `appendFile`（`packages/core/src/audit/chain.ts:339`）抛错 ⇒ 审计写失败是否 fail-open（调用方是否仍放行）？`server.ts:575` 的包装 sink 我只读了注记，未逐行追完异常传播路径，**不下结论**；
- **V-2**：`%LOCALAPPDATA%/WinVMBridge/logs` 具体由**哪个执行体**在宿主侧创建（我只证明了：默认值是 Windows 模板 + 展开在 env 缺失时原样保留 + 周期内有文件被写）。候选面 = 以 `DEFAULT_SERVICE_CONFIG` 为配置源在 POSIX 上实例化的进程（`tests/unit/cl018-config.test.js`、`phase2-dep-direction.test.js` 等引用该默认值），但**我未跟踪到具体调用栈**，故记为待验而非结论；
- **V-3**：`RestartOnFailure ×3`（`delivery/install-vm.mjs:329-332`）之后 Windows 任务计划程序是永久放手还是按周期再试 —— 属外部系统语义，未实测，④ 节已按"上限 ×3"保守表述。

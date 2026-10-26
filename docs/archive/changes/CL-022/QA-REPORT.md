# CL-022（Phase 1 安全兑现批）P4 集成回归 QA-REPORT

> **状态**：**离线可证部分全绿；真机判据 B1–B3 已完成并归档证据；QA 收官批复核栏已填（2026-10-10 严过关独立复跑）** ⇒ 终判见 §6。
> **权威数据来源**：工程侧实测留档 `$HOME/wbtmp/t5-*.txt` + `docs/changes/phase1-t{1..5}-notes.md`；**QA 独立复跑留档 `$HOME/wbtmp/qa-t5-full-run.txt`**（§4.1）。
> **口径纪律**：本文只记录**已实测**的数字；凡未实测一律写「未记录 / 待 QA 收官批」，不作推测、不搬用他批数字。
> **本文与 CL-021 的 QA-REPORT 差异**：CL-021 是对**已归档**独立 QA 报告的收录版；CL-022 的独立 QA 报告即本文（团队任务 #4 统一落守卫测试 + 收官批复跑）⇒ 本文上半为**工程侧自证**，§4.1/§4.1-B5/§6 为 **QA 收官批复核与终判**（QA 权威判定权栏）。

---

## 1. 构建与测试统计

| 项 | 结果 | 证据 |
|---|---|---|
| `tsc -b tsconfig.build.json --force`（全 workspace） | **EXIT=0** ✅ | `$HOME/wbtmp/t5-tsc-3.txt`（空文件＝无诊断） |
| T5 新增守卫 `phase1-t5-provider-cancel.test.js` | **11 / 11 pass / 0 fail** ✅ | 单跑 3 次 + 复跑 1 次，四次一致 |
| T5 新增守卫 `phase1-t5-llm-cancel.test.js` | **12 / 12 pass / 0 fail** ✅ | `$HOME/wbtmp/t5-per-file/` |
| T5 新增守卫 `phase1-t5-token-env.test.js` | **13 / 13 pass / 0 fail** ✅ | 同上 |
| T5 新增守卫 `phase1-t5-cancel-consume.test.js` | **17 / 17 pass / 0 fail** ✅ | 同上 |
| `host-a2a-bridge.test.js`（R3 旧断言同步后） | **38 / 38 pass / 0 fail** ✅ | 同步前 35 例；净 +3 |
| 全量离线回归（`tests/unit/` 逐文件，**79 个文件**） | **1456 tests / 1454 pass / 0 fail / 2 skipped** ✅ | `$HOME/wbtmp/t5-full-run.txt` 末行 `SUMMARY filesRun=79 failFiles=0 tests=1456 pass=1454 fail=0 skipped=2` |
| **QA 收官批独立复跑**（HEAD `2b2f241`，逐文件，**79 个文件**） | **1457 tests / 1455 pass / 0 fail / 2 skipped** ✅ | `$HOME/wbtmp/qa-t5-full-run.txt`（84 行/7307 字节）；对账式核验见 **§4.1**，终判见 **§6** |

**与 T4 基线对账**：`75 / 1400 / 1398 / 0 / 2` → **`79 / 1456 / 1454 / 0 / 2`**（**+4 文件 / +56 例 / fail 保持 0**）→ **`79 / 1457 / 1455 / 0 / 2`**（T5 收官小修 `2b2f241` **+1 例**，双侧守卫用例）。
`2 skipped` 恒为 `ssh2-resolve.test.mjs` 的两条 `OFFLINE_SKIP`（本机可解析 ssh2 即跳过，设计行为，非回归）。

**口径备忘**（沿用既有纪律，非本批新增）：
- 单文件跑法：目录式/整批 glob 在本仓会 `MODULE_NOT_FOUND`，且 junction 用例并发会触发 `0xC0000005` 假红。
- 先 build dist 再跑读 dist 的用例（`cl020-f2-*` 直接 import `adapter-agent-workbuddy/dist/index.js`）。
- 计数只取 `ℹ tests / pass / fail / skipped` 前缀行；不用 `node -e` 内联正则。

---

## 2. 判据逐条核验（§7.4-T5 六判据）

| 判据 | 离线可证 | 结论 | 证据 |
|---|---|---|---|
| **①** 确定性 provider：取消后模板不再发起下一次能力调用（`step()` 咽喉） | ✅ | **PASS** | `provider-cancel` A 组 4 例：入口取消 `bridge.call` 恰 0；**安装模板**「搜索已执行 / 安装调用零发起」（`counts['app/Install-Winget']===0`）；调用期间取消不外推 artifact；未取消逐字回归 |
| **②** LLM provider：取消时 `abortActiveTurn` 被调 | ⚠ 半 | **离线 PASS / 真机待证** | `llm-cancel` L1（FakeChild：在飞 ⇒ kill 恰 1 次 + `state=stopped` + 不写 lastError；空闲 ⇒ false 且**不动进程**）、L2（取消 ⇒ spawn 恰 1 次，崩溃 ⇒ 仍重建 的对照）、L3-a（真 spawn 假 stream-json CLI：终态 `TASK_CANCELED` + `restarts=0` + CLI 恰启动 1 次 + 零 spawn 入口闸）。真机侧的「CLI 思考期无状态上报时由 signal 事件路径打断」离线已构造（纯 signal 无 onStatus 也能打断），但真实 codebuddy 行为未测 |
| **③** 单次 `-p` 子进程被 kill + 宿主文案两态可分 | ✅ | **PASS** | `llm-cancel` L3-a 第三例：**真起 sh 子进程 + `trap TERM` 落盘为证**（`kills.log` 含 `killed`）+ 终态 `TASK_CANCELED` + 恰一次启动；signal 透传形态钉（两条 spawn 分支恰 2）+ **变异自证**（摘一处即变红）。两态可分：`host-a2a-bridge` 三例（零痕迹不附该键 / 有痕迹 `{steps:1,artifacts:1}` / `execution-steps` 权威源 `{steps:3,artifacts:0}`） |
| **④** `--token-env` 真给值时隧道请求带 header | ✅ | **PASS** | `token-env` D 组：起 `127.0.0.1` 回显 http server，真实 fetch 后服务端收到 `authorization: Bearer tok-42`；未配置 ⇒ 服务端收到**无** authorization。另含形态层（`buildTransport` 键有/无）、纯函数层（三态 + 无副作用）、装配层（ssh-tunnel 校验前置、错误串不含隧道字样、authorization 赋值点恰 1）、文案层（usage 不再谎称默认值） |
| **⑤** 文档判据 | ✅ | **PASS** | SECURITY §2.1 信任边界声明 + §2.2 取消语义 + §3.2 与 `defaults.ts` 逐字（六条）+ §4.3.1 校验范围限定语 + §6.4 两项权衡（W-1 freshChain / W-2 保留期）+ §7「回环绑定：不可关」行；ARCHITECTURE 机制表与 §10 风险表缓解改述；CAPABILITY-MODEL `policy` 示例去 `commandAllowlist`；CL-022 三件套含**三条刻意破坏性**；`winvm-storage-manager` SKILL 白名单六条逐字对齐 |
| **⑥** 旧断言同步 | ✅ | **PASS** | `host-a2a-bridge.test.js:418` 原「canceled：取消文案明确审批通道已关闭」→ 改写为事实化用例；原负向守卫（默认批准 / 超时文案）逐条保留；超时用例的 `!includes('任务已取消')` 仍成立。全仓 `grep "审批通道已关闭"` ⇒ 代码与测试无残留（仅历史 CL-016 归档与设计文档病灶描述，属应当保留） |

---

## 3. 安全语义独立核查（不只信守卫）

| # | 核查项 | 方法 | 结果 |
|---|---|---|---|
| 3a | **取消码必须是 `TASK_CANCELED`**（降级红线） | grep `shouldDegrade` 条件 + 守卫内**对照实验**（同形状只换码） | ✅ `TASK_CANCELED` 组 executor 零调用；`EXECUTION_FAILED` 组确实重跑 ⇒ 红线性质被证明，非空断言 |
| 3b | 取消收口**不得**走 `{unavailable}`（会降级单次 `-p` 再跑） | 读 `runGoalCore` 分支 + `llm-cancel` 断 `result.degraded === undefined` | ✅ 收口全部经 `canceledResult()` |
| 3c | 取消**不得**被写成 `lastError`（取消不是故障） | `llm-cancel` L1 断 `snapshot().lastError === undefined` | ✅ |
| 3d | 空闲期不得误杀常驻会话（会打断预热） | `llm-cancel` L1 断 `abortActiveTurn` 在无在飞轮次时返回 false 且 `killCount===0` | ✅ |
| 3e | 宿主文案不得宣称"未执行任何变更"（不实陈述） | `host-a2a-bridge` 有痕迹态负向 + `provider-cancel` 双态负向 + `cl018-a2a-timeout` 剥注释后禁「已修复/已解决」 | ✅ 三处均绿 |
| 3f | 凭据不落明文：`buildTransport`/decl 只承载**变量名** | `token-env` 断 `JSON.stringify(decl)` 不含 `Bearer` 形态 | ✅ |
| 3g | `applyBearerHeader` 无副作用（readonly 入参不被改写） | `token-env` 用 `Object.freeze` 入参断言 | ✅ |
| 3h | 白名单文档与代码**逐字一致** | 对照 `defaults.ts:71-78` 六条 ↔ SECURITY §3.2 ↔ SKILL.md | ✅ 三处同串（含 `%USERPROFILE%\**`，且明确"白名单里没有 `C:\Users\**`"） |
| 3i | 未破坏 K-N1 审计真实性守卫输入面 | `r19c-kn1-e-shape`（计数钉：`channel: req.channel ?? 'mcp'`＝2、`channel: 'mcp'`＝0、inner-call ext＝2）+ `-mutation` 54 例 + `assembly-guard` A5 + `r19c-a5` C6 两行门 | ✅ 全绿，未放宽任何判据 |

---

## 4. BLOCKED / 未覆盖清单

| # | 项 | 为何 BLOCKED | 归属 |
|---|---|---|---|
| B1 | §7.4-T5 **①②③真机端到端**（真实 codebuddy CLI + 真实委派途中取消） | ~~需 VM 部署 T5 码后执行~~ **已完成（2026-10-09/10 主理人+成员真机）**：deploy-vm 五阶段绿后 task `cde70b18` 取消 ⇒ `/health.llmSession` pid 4536→stopped/restarts 0（CLI 真杀+重建闸守住）+ 链上 `TASK_CANCELED` | ✅ PASS，证据 `qa/r19/t5-b1-evidence.md` / `t5-b1-cancel.out.json`（commit 6792413）；晚取消态（`executedBeforeCancel` 有态）QA 收官可按 notes §10-3 两趟口径补跑 |
| B2 | win32 `cmd.exe` 包装路径的 signal 透传**实跑** | 本仓 POSIX 无法真起 `cmd /c` ⇒ 已改 VM 实测 | ✅ PASS：VM 内 `resolveCliPath('codebuddy.cmd')` isScript=true；launch+50ms abort ⇒ AbortError→SIGTERM exit/close 全序实证（`qa/r19/t5-b2-cmdsignal.result.txt`） |
| B3 | `enforceBearer=true` 的失败形态演练（原表述"委派必 401"已被实测订正） | 需双条件齐（enforceBearer+env 值），单开开关守卫不挂 | ✅ 已完成（2026-10-10 成员真机演练+复原复验）：宿主无凭据段当场 401 `{error:'unauthorized',code:'AUTH_REQUIRED'}`；VM 内回连段 401 打在工具面 ⇒ 委派退化为**零副作用虚假完成**（`completed`+`zeroInnerCalls:true`，CL-K3R 兜住）。证据 `$HOME/wbtmp/b3/b3-probes.json`/`b3-delegate.json`；措辞订正已随本次提交入 SECURITY/DEPLOYMENT/ARCHITECTURE/TECHNICAL-SOLUTION/源码注释 |
| B4 | TaskStore 驱逐在真实长会话中的宿主可见行为（R5：旧 `taskId` 查不到） | 需 ≥200 任务或 1h 驻留窗口 | 未记录（框架层 T3 已离线证驱逐规则） |
| B5 | QA 独立复跑与智能路由判定 | 团队任务 #4 / QA 收官批统一执行 | ✅ **已由 QA 独立复跑闭环（2026-10-10，HEAD `2b2f241`）** —— 详见下方 **§4.1**；智能路由终判见 **§6** |
| B6 | 测试基线数字对外口径（1247→1400→1456 的表述） | 属 QA 收官批统一口径，工程侧不动 | ✅ **已统一写数**：`README.md` §8、`docs/06-OVERVIEW.md`（首行 + §四 实测验证表）两处对外口径已更新为 QA 实测权威数字 **79 / 1457（1455 pass / 0 fail / 2 skipped）**；`docs/changes/phase0-delivery-summary.md` **保留 Phase 0 历史事实（71/1247）不改写**，仅文末追加"基线演进注记"一行并指向本文。演进链 `1247(Phase0)→1253(T1/T2)→1283(T3)→1400(T4)→1456(T5)→1457(T5 收官小修)` 已逐环对账（T3 环见 `phase1-t3-notes.md:189`、T4 环见 `phase1-t4-notes.md:279`、T5 环见 `phase1-t5-notes.md:71,248`）。改前经 grep 核验 `tests/unit/` **无任何静态守卫断言** README/OVERVIEW 的基线数字文本 ⇒ 无需同步改断言。 |

### 4.1 QA 独立复跑（B5 兑现 · 对账式）

> 执行人：QA（严过关）· 时点 2026-10-10 · HEAD `2b2f241`（T5 收官小修后）· 独占全量跑进程
> 方式：`tsc -b tsconfig.build.json`（exit 0）→ **逐文件** `node --test <单文件>` 全 79 文件（绝不整批）
> 留档：`$HOME/wbtmp/qa-t5-full-run.txt`（**84 行 / 7307 字节**，逐文件行 + `SUMMARY` 尾行，fsync 后读回自证非空）
> 原始日志：`$HOME/wbtmp/qa-run-logs/<file>.log`（79 份）；runner：`$HOME/wbtmp/qa-run-all.sh`（可复现）

| 项 | 工程侧 T5 留档（§1） | QA 独立复跑（本次） | 对账 |
|---|---|---|---|
| 测试文件数 | 79 | **79** | ✅ 一致 |
| tests | 1456 | **1457** | ✅ 差异可解释：`2b2f241`（§1 数字之后的收官小修）新增 **1** 例 ⇒ `1456 + 1 = 1457` |
| pass | 1454 | **1455** | ✅ 同上（净 +1 且为 pass） |
| fail | 0 | **0** | ✅ 一致 |
| skipped | 2 | **2** | ✅ 一致，恒为 `ssh2-resolve.test.mjs` 的 `OFFLINE_SKIP` |
| `host-a2a-bridge.test.js` | 38（§1 R3 同步后） | **39** | ✅ 差异 = `2b2f241` 双侧守卫用例（`38 + 1`），与 commit message「+1 双侧守卫用例 39/39」逐字吻合 |
| T5 四守卫 | 11 / 12 / 13 / 17 | **11 / 12 / 13 / 17** | ✅ 四文件逐字等值（provider-cancel / llm-cancel / token-env / cancel-consume） |

**结论**：QA 复跑与工程侧数字**完全对账一致**（唯一增量 1 例可归因到 `2b2f241`，非口径漂移）。逐行交叉校验四项全通过：① 79 行 `fail` 列全 0；② 每行 `tests == pass + fail + skipped` 算术自洽；③ `SUMMARY` 由逐文件行累加得出（非 node 汇总，可防漏文件）；④ 分段口径 `.test.js` **71 文件 / 1387 例** ＋ `.test.mjs` **8 文件 / 70 例** = 79 / 1457。无 flaky、无需隔离复跑（本次独占）。

### 4.2 QA 行为守卫抽查（证伪式，非复跑）

> 目的：验证守卫**真的会红**（不是永绿装饰），并核对 B3 订正在全仓的一致性。三项均为"构造反例 → 跑 → 断言按预期红/绿 → 恢复现场"。

| # | 抽查项 | 构造 | 预期 | 实测 | 现场恢复 |
|---|---|---|---|---|---|
| **D-1** | 取消收口码红线：`TASK_CANCELED` 不得被 `shouldDegrade` 命中 | 读 `adapter-agent-workbuddy-llm/src/index.ts:437-442` 判据 + 编译产物 `dist/index.js:367-373` 对照 + 全仓扫"degrade/fallback/unavailable 与 TASK_CANCELED 同现"位点 + 既有用例引用（不重复造） | 判据只认 `PROVIDER_UNAVAILABLE` 与 `EXECUTION_FAILED`+零产物；源码与 dist **逐字一致**（防"源码对、产物错"） | ✅ 判据无 `TASK_CANCELED` 分支；src↔dist 一致；唯二同现处是 `bridge.ts:1306/1390` **注释**（正是"用 TASK_CANCELED 规避降级"的说明）。守卫有证：`phase1-t5-cancel-consume.test.js:330`「降级红线：TASK_CANCELED 不落入 shouldDegrade ⇒ 确定性执行器不得被重跑」断 `executorCalls.length===0`，且 `:383` **对照组**（同形状换码 `EXECUTION_FAILED`）断 `executorCalls.length===1` ⇒ 上一条非恒真。本次复跑该文件 **17/17 绿** | 只读，未改动 |
| **D-2** | cancel ok 分层（`2b2f241`）守卫非永绿 | 临时删除 `host-a2a-bridge/src/tools.ts:694` description 中的「以 `cancelObserved` 为准」字样（改为"是否生效另有判据"）⇒ `tsc -b`（exit 0）⇒ 单跑 `host-a2a-bridge.test.js` | 该用例应**红**（若仍绿 ⇒ 守卫是装饰） | ✅ **红，命中精准**：`tests 39 / pass 38 / fail 1`，失败点=`host-a2a-bridge.test.js:272`「T5 cancel ok 语义澄清…」，栈顶正是 `:279`（description 的 `cancelObserved` 断言行）⇒ 证伪成功，守卫有效且非永绿。同时反证：`false 态回包文本`断言未受影响（只动 description） | ✅ `cp` 备份复原，`md5sum` 与改动前**等值**（`a055a539…`）；`git status` 该文件**无差异**；`tsc -b` exit 0；复跑 **39/39 绿**（`$HOME/wbtmp/qa-D2-{mutated,restored}.log`） |
| **D-3** | B3 订正一致性：「当场 401 / 必 401 / 当场失败」不得作为**现行承诺**残留 | 全仓 grep（排除 `qa/`、`node_modules/`、`**/dist/`、`$HOME`；`phase1-t5-notes.md` 历史引文与 D-43、`CL-022/REQUIREMENT.md` 问题描述按任务书豁免） | 现行文档应改述为"VM 内回连段 ⇒ 零副作用虚假完成；宿主不带凭据段 ⇒ 当场 401"两段式 | 见下方**留痕/真残留分列** | 只读 |

**D-3 分列结论**：

*A. 算留痕（历史引文，应当保留，不判残留）*
- `docs/changes/phase1-t5-notes.md`（:38/:130/:199(D-43)/:281/:336-342/:425）—— 任务书明示豁免；:199 正是 D-43 订正本体，:339-340 是"原判据 vs 实况"落差留痕。
- `.dev/changed-log.md:638`、`.workbuddy/memory/{MEMORY.md:48,2026-10-10.md:31}` —— 提交/记忆流水，且 MEMORY 已明写"非'当场 401'…文档六处已订正"。
- `docs/02-design/SECURITY-GOVERNANCE.md:83` —— 文中以"原'委派主链路当场 401'表述只写对了宿主段"的**订正引文**形态出现，属正当留痕。
- `packages/contracts/src/transport.ts:36` / `packages/core/src/transport/index.ts:40` —— 描述的是 ENG-23 **修复前的病灶**（"`ssh-tunnel` 分支过去完全不消费 tokenEnv ⇒ 走隧道的宿主委派会当场 401"），本批正是为补齐该通路而生；语义正确，**非残留**。
- `tests/unit/phase1-t4-http-guard.test.js:7`、`docs/changes/phase1-t4-notes.md:272` —— T4 守卫判据"非豁免端点 ⇒ 401"（HTTP 层事实），与 B3 议题（委派形态）无关。

*B. 真残留（**3 处，现行承诺口径未跟上 D-43 订正**，路由=docs/主理人；非源码缺陷，不影响 §6 PASS 终判）*
1. **`docs/05-peripherals/DEPLOYMENT.md:518`**（§8.5 活文档）—— 括注"见 §8.1 警告块：VM 内回连凭据通路未实现 ⇒ **委派主链路会 401**"。§8.1（:455）已订正为两段式，此处**回指旧结论**，形成同一文档内自相矛盾。⇒ 建议改述为「VM 内回连段 ⇒ 零副作用虚假完成（非链路失败），宿主不带凭据段 ⇒ 当场 401」。
2. **`delivery/vm-service.config.json:59`**（现网配置注释面）—— "开 enforceBearer 前必须先补齐 VM 内回连（/mcp?dtid=）的凭据通路，否则**委派执行会 401**"。作为运维会直接读到的**现行警示**，形态描述错误。⇒ 建议同 1 改述（并指向 `SECURITY-GOVERNANCE.md §2.1`）。
3. **`docs/changes/CL-022/REQUIREMENT.md:34`**（B-3 行"误开 ⇒ 委派主链路 401，见 §2.4"）—— 该句是被订正对象的**同批现行表述**（任务书豁免的是"问题描述"引文；此处为承诺口径本身）。⇒ 建议补一句"实况经 B3 订正，见 §2.1/D-43"。

*C. 另列（设计时点快照，建议加前向指针，本批不改写）*
- `docs/changes/phase1-arch-design.md:359`（§5 第 3 条"否则委派执行必 401"）、`:488`（§10 R4"委派主链路 401"）—— 属 Phase 1 设计时的**风险预判快照**，其结论已被 B3 实测推翻（D-43 即此）。历史快照可保留，但**建议主理人加一行指向 D-43 的订正指针**，否则读者按 §5 第 3 条字面理解会重蹈 R4 误判（已登记 §6 遗留 L5）。

---

## 5. 缺陷与修复记录（本批 T5 内）

| # | 现象 | 判因 | 处置 | 复跑 |
|---|---|---|---|---|
| 1 | `tsc` 报 TS2393 Duplicate function implementation（`persistent-session.ts:584` / `:672`） | **并发双写**：两名工程师各写一份 `abortActiveTurn`（一份带 `killChild`、一份不带） | 保留带 kill 语义版 + `turnAbortedByCancel` 重建闸；删除薄封装版；裁定理由登记 D-31/D-35 | exit 0 ✅ |
| 2 | 全量跑测两份 SUMMARY 交错，其一记 `provider-cancel fail=1` | **档期污染**：两个全量 sweep 同时刻共用 `$HOME/wbtmp/t5-full-run.txt`，期间该测试正被编辑、dist 正被 `--force` 重写 | 该文件单跑 3 次 + 复跑 1 次全 11/11；改为各成员独立留档路径；建议写入团队纪律 | 11/11 ✅ |
| 3 | `provider-cancel`「非取消失败仍走 goalFail」用例期望 `POLICY_DENIED` 实得 `EXECUTION_FAILED` | **判据错误（测试侧）**：`step()` 只把 `res.error.message` 上抛为字符串，模板层统一包 `EXECUTION_FAILED` —— 属既有行为，不在 T5 改动范围 | 断言改为钉既有折叠形态，并登记为观察项 **O-1**（后续批次决定是否让 step() 保留契约码）；**未反向改实现迁就** | ✅ |
| 4 | `token-env` 中「ssh-tunnel 未配置 tokenEnv」用例若直跑会真起 SSH 隧道 | **测试设计缺陷**：离线守卫不应引入网络依赖 | 改为源码形态钉（调用点位序 + 两分支各一处 + authorization 赋值点恰 1），不发真实 SSH 连接 | ✅ |
| 5 | `llm-cancel` 首跑整文件 `SyntaxError`（import 包级不存在的 `launchCliProcess`） | **契约认知**：该函数是 `bridge.ts` 内部导出，未再从包 index 透出 | 测试直连 `dist/bridge.js` 取用（与 `cl020-f2-*` 同范式）；**不为测试擅自扩包公共导出面**，登记观察 **O-3** | ✅ |

**判因纪律小结**（与 T4 结论一致）：本批红点中「实现缺口 / 测试侧判据错误 / 环境档期」三类皆有 ⇒ 见到红必须先分诊，禁止默认"改测试让它绿"或"改实现让它绿"。

---

## 6. 智能路由判定

**终判：`NoOne`（QA 独立判定，非照抄工程侧建议）** —— 判定对象=无需路由回工程侧修源码；Phase 1 安全兑现批 T1–T5 在 HEAD `2b2f241` 上判定为 **PASS（可交付态）**。

**判定依据（逐条可核）**：
1. **零红**：QA 独立复跑全 79 文件 `fail=0`、`nosummary=0`、逐文件 `rc=0`（§4.1）；与工程侧 T5 数字**对账式一致**（唯一增量 1 例归因 `2b2f241`）。基线 **79 / 1457 / 1455 pass / 0 fail / 2 skip**。
2. **无放宽判据**：§5 五条红点的处置全部为"改测试侧判据/独立留档/源码形态钉"，**未见任何反向改实现迁就测试**，也未见删除或弱化既有守卫（§3 的 3a–3i 独立核查含对照实验，红线性质被证明而非空断言）。
3. **安全红线性质被实证**：`TASK_CANCELED` 不落入 `shouldDegrade`（`adapter-agent-workbuddy-llm/src/index.ts:437-442` 判据只认 `PROVIDER_UNAVAILABLE` 与 `EXECUTION_FAILED`+零产物），且 `phase1-t5-cancel-consume.test.js:330` 红线用例 + `:383` **对照组**（同形状换码 `EXECUTION_FAILED` ⇒ 确定性执行器确被重跑 1 次）双向成立 ⇒ "零重跑"非恒真断言（D-1 抽查复核）。
4. **真机 B1–B3 已闭环非缺陷**：`qa/r19/t5-b1-*`（cancel.out.json / cancel.timeline.log / chain.ps1 / evidence.md）、`t5-b2-cmdsignal-probe.mjs` / `t5-b2-cmdsignal.result.txt`、`t5-b3-delegate.json` / `t5-b3-delegate.timeline.txt` / `t5-b3-probes.json` **九份证据文件存在性已 ls 核对**，报告引用不悬空；宿主侧 `$HOME/wbtmp/b3/{b3-probes,b3-delegate}.json` 亦在位。B3 的"当场 401 ⇒ 零副作用虚假完成"措辞订正已落入 SECURITY §2.1/§6.4、ARCHITECTURE 信任边界行、DEPLOYMENT §8.1、TECHNICAL-SOLUTION、`bridge.ts`/`config/index.ts` 源码注释（D-3 核查）。
5. **对外口径已统一**：B6 三处写数完成，Phase 0 历史事实未被改写。
6. **行为守卫抽查三项通过**（§4.2）：D-1 红线判据 src↔dist 一致且有对照组非恒真；D-2 对 `2b2f241` 新守卫做了**证伪实验**（删 description 字样 ⇒ 精准红在 `host-a2a-bridge.test.js:279` ⇒ 恢复后 39/39 绿 ⇒ 守卫非永绿）；D-3 一致性核查中现行承诺文档（SECURITY/ARCHITECTURE/DEPLOYMENT §8.1/TECHNICAL-SOLUTION/源码注释）均已订正到位，但**另发现 3 处措辞残留 + 1 组设计快照需前向指针**（见 L5/L6，属**文档口径**问题、非源码缺陷 ⇒ 不改变 NoOne 终判，随主理人提交轮一并清）。

**遗留清单（不构成路由回 engineering，均为已登记的后续项）**：

| # | 遗留项 | 性质 | 归属/去向 |
|---|---|---|---|
| L1 | §4-B4 TaskStore 驱逐的真实长会话可见性（R5） | 需 ≥200 任务或 1h 驻留窗口的真机长跑；框架层驱逐规则 T3 已离线证 | Phase 2 运维窗口；交付说明保持"框架已证、长会话未观测"口径 |
| L2 | `notes §10-3` 两趟口径中的**晚取消态**（`executedBeforeCancel` 有态）真机补跑 | 早取消态已由 B1 证据覆盖；离线侧两态呈现由 `host-a2a-bridge` 三例覆盖 | 不阻塞交付；下次真机窗口顺手补，补后回写 §4-B1 |
| L3 | 观察项 **O-1**（`step()` 把契约码折叠为 `EXECUTION_FAILED`）、**O-3**（`launchCliProcess` 未从包 index 透出，测试直连 `dist/bridge.js`） | 既有行为，非本批引入，本批未扩公共导出面 | Phase 2 二选一处置（保留码 or 契约评审后透出） |
| L4 | **R4 根治**：`enforceBearer` 开启前的 bearer 生效自检 + VM 内回连凭据分发通路 | 本批**刻意只注释+文档，不实现**（设计决定）；误开形态已由 CL-K3R `zeroInnerCalls` 真值层兜住 | Phase 2 backlog（MEMORY.md 已登记） |
| L5 | `docs/changes/phase1-arch-design.md` §5 第 3 条 / §10 R4 行仍写旧式"委派执行必 401 / 委派主链路 401" | 属 Phase 1 **设计时点快照**，其"当场 401"结论已被 B3 实测订正推翻；现行承诺文档（SECURITY/ARCHITECTURE/DEPLOYMENT）与源码注释均已订正到位 | **建议主理人**在 design 文档加一行"已被 B3 实测订正，见 D-43"的前向指针（本文不擅改设计快照 ⇒ 不判为残留缺陷，详见 D-3） |
| L6 | **D-3 真残留 3 处**：`DEPLOYMENT.md:518`（§8.5 回指旧结论，与同文档 §8.1 自相矛盾）、`delivery/vm-service.config.json:59`（运维直读的现行警示仍写"委派执行会 401"）、`CL-022/REQUIREMENT.md:34`（B-3 行承诺口径仍为"委派主链路 401"） | **纯措辞残留**，零行为影响、零测试红（复跑 fail=0 已证）；风险面=运维/读者按旧形态理解 ⇒ 误判"任务成功即守卫未生效" | 路由=**文档面（主理人执笔，同 D-43 处置惯例）**，三处改述为两段式（宿主段当场 401 / VM 内回连段零副作用虚假完成）。QA **不擅改**他人变更集文件与现网配置注释；本批交付判定**不受阻** |

> 判据①②③④⑤⑥（§2）全部离线 PASS，真机侧 B1/B2/B3 已闭环 ⇒ **无源码缺陷需路由 engineering，无测试缺陷需自修**；§6 终判 `NoOne` 针对**代码面**成立，L6 为**文档措辞**后续项（由主理人统一处置），不构成回归失败。

---

## 7. 变更集清单（工作区，未提交）

| 文件 | numstat | 层 |
|---|---|---|
| `packages/adapter-agent-workbuddy/src/index.ts` | +75 / −1 | 执行体（确定性） |
| `packages/adapter-agent-workbuddy-llm/src/bridge.ts` | +168 / −1 | 执行体（LLM 桥） |
| `packages/adapter-agent-workbuddy-llm/src/persistent-session.ts` | +48 / −0 | 执行体（常驻会话） |
| `packages/host-a2a-bridge/src/tools.ts` | +96 / −4 | 宿主呈现 |
| `packages/host-a2a-bridge/src/cli.ts` | +5 / −1 | 客户端 CLI |
| `tests/unit/host-a2a-bridge.test.js` | +64 / −3 | 判据⑥同步 |
| `tests/unit/phase1-t5-{provider-cancel,llm-cancel,token-env,cancel-consume}.test.js` | 新建（53 例） | 判据①②③④守卫 |
| `docs/02-design/{SECURITY-GOVERNANCE,ARCHITECTURE,CAPABILITY-MODEL}.md` | +103/−14 · +7/−5 · +6/−2 | 文档兑现 |
| `docs/changes/CL-022/{REQUIREMENT,TECHNICAL-SOLUTION,QA-REPORT}.md` | 新建 | 变更集 |
| `docs/changes/phase1-t5-notes.md` | 新建 | 实施记录 |
| `skills/winvm-storage-manager/SKILL.md` | +9 / −1 | D-13 白名单口径 |

> 提交由主理人独立核验后统一执行；本批工程侧**未做任何 git 写操作**。

### 7.1 QA 收官批新增工作区改动（本栏自证 · 亦零 git 写）

| 文件 | numstat | 层 |
|---|---|---|
| `README.md` | +11 / −5 | 对外测试基线口径（§8） |
| `docs/06-OVERVIEW.md` | +2 / −2 | 对外测试基线口径（首行 + §四） |
| `docs/changes/phase0-delivery-summary.md` | +4 / −0 | 文末「基线演进注记」（**历史事实未改写**） |
| `docs/changes/CL-022/QA-REPORT.md` | +86 / −7 | §4.1 QA 复跑 / §4.2 守卫抽查 / §4-B5·B6 填栏 / §6 终判 / §7.1 本栏（含本行） |

**现场纪律自证**：`git status --porcelain` 非 `??` 行**仅上表 4 个文件 ＋ 主理人自有 `.workbuddy/memory/…/memory.md`**；D-2 抽查对 `packages/host-a2a-bridge/src/tools.ts` 的临时改动已按 `md5sum` 等值复原（`git status` 该文件**无差异**）；`**/dist/` 被 `.gitignore` 覆盖不入工作区差异，且恢复后已 `tsc -b`（exit 0）重建。QA **未执行任何** add/commit/push，**未触碰 VM（172.16.100.2）**。

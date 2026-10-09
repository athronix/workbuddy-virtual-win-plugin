# CL-022（Phase 1 安全兑现批）P4 集成回归 QA-REPORT

> **状态**：**离线可证部分全绿；真机判据 BLOCKED（待主理人部署后执行）**；**QA 收官批复核栏留空**。
> **权威数据来源**：工程侧实测留档 `$HOME/wbtmp/t5-*.txt` + `docs/changes/phase1-t{1..5}-notes.md`。
> **口径纪律**：本文只记录**已实测**的数字；凡未实测一律写「未记录 / 待 QA 收官批」，不作推测、不搬用他批数字。
> **本文与 CL-021 的 QA-REPORT 差异**：CL-021 是对**已归档**独立 QA 报告的收录版；CL-022 尚无独立 QA 报告（团队任务 #4 统一落守卫测试 + 收官批复跑）⇒ 本文为**工程侧自证 + QA 待复核栏**。

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

**与 T4 基线对账**：`75 / 1400 / 1398 / 0 / 2` → **`79 / 1456 / 1454 / 0 / 2`**（**+4 文件 / +56 例 / fail 保持 0**）。
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
| B5 | QA 独立复跑与智能路由判定 | 团队任务 #4 / QA 收官批统一执行 | **本栏留空待 QA 填写** |
| B6 | 测试基线数字对外口径（1247→1400→1456 的表述） | 属 QA 收官批统一口径，工程侧不动 | QA |

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

**待 QA 收官批填写**。工程侧建议：**NoOne**（本批 T5 无遗留红点、无放宽判据；真机 B1–B3 属部署后验证而非缺陷）。

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

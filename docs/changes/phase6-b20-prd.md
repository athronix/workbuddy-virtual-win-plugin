# Phase 6 · 批20 增量 PRD —— 四项技术债修复（只读分析产出）

| 项 | 值 |
|---|---|
| 文档 ID | phase6-b20-prd |
| 语言 | 简体中文 |
| 日期 | 2026-10-17 |
| 输入 | `.workbuddy/memory/MEMORY.md` backlog 区四条未修项 + `docs/audit/2026-10-16-panorama-phase6.md`（N-1~N-7 问题账）+ 批18/批19 施工记录 |
| 基线 | HEAD `3d07b05`；全量 gate 124 文件 / 2179 例 GREEN（`qa/p3-batch-sweep/gate-p6-b19-t1.txt`） |
| 原始需求复述 | 为 backlog 四项技术债编制增量 PRD：①真实 GUI 自动化点击端到端回归受远端锁屏限制；②深度空闲冷启动 ~49.3s 未消除；③K3 审批对账兜底仍为启发式；④R4 enforceBearer 误开实况缺乏生效自检。每项须给可行性裁定、最小修复范围、可机检验收标准、风险与回滚。 |

---

## 一、产品目标

对四项登记在册的技术债完成回仓核验与分级处置：**两项经核验属「backlog 陈旧——根治已在前期批次（CL-K3R/P2-T8、P2-T5/T6）落地并缺省在网」，按销账模式关闭；一项（GUI 锁屏）诚实定性为「锁屏态不可代码修复」，只做过期注释订正 + E2E 前置人工配方文档化；一项（深度空闲冷启动）做唯一一处真实代码修复（延长 idle TTL 默认值，最小变更）**。本批不新增契约面、不改门禁判据、不动运行态，把技术债池收敛到真实剩余项并为后续观察项（保活机制、E2E preflight）立档。

---

## 二、用户故事

- 作为**运维者**，我希望 `/health.security` 上 bearer 自检状态可信且文档与代码一致，以便误开 `enforceBearer` 时被 fail-closed 拒启止损而不是静默虚假完成——（已兑现，本批关闭该 backlog）。
- 作为**运维者**，我希望知道 GUI 锁屏导致 E2E 回归失败时该查什么，以便按一次性人工配方消除锁屏，而不是误以为插件漏接了自动恢复——（本批文档化）。
- 作为**Agent 使用者**，我希望深度空闲后的首次委派不必每次付 ~49s 冷启动，以便首响延迟可预期——（本批延长 idle TTL，多数场景消除）。
- 作为**审计/监管者**，我希望审批等待判定以服务端结构化账本为权威、文本启发式仅为兜底且其命中率可计数，以便「谁改判的」可归因——（已兑现，本批固化观测口径）。
- 作为**维护者**，我希望 backlog 不含已修复项，以便排期不被陈旧条目污染——（本批销账两项 + 周边订正一项）。

---

## 三、核验总览（四债可行性裁定一句话表）

| # | 技术债 | 裁定 | 一句话依据 |
|---|---|---|---|
| 债1 | GUI 锁屏限制 E2E 回归 | **不可代码修复**（锁屏态本身）+ 可文档修复（周边） | 锁屏=Winlogon 安全桌面，同会话进程无法合成输入解锁；tscon 需管理员；§5.4「无 sessionId 数据源」注释已过期（契约必填+探针实测采集），须订正 |
| 债2 | 深度空闲冷启动 ~49.3s | **部分可代码修复** | 延长 idle TTL 默认值=最小变更可消除多数场景；保活=可选 P2（有串行链排队副作用）；进程级冷启动本身是 codebuddy CLI 外部特性，不可根除 |
| 债3 | K3 兜底仍启发式 | **已根治（无需新代码）** | `reconcileApprovalTruth` 服务端审批账本结构化反查已在网且 `WINVM_APPROVAL_TRUTH` 缺省 `on`；文本兜底按用户裁决（SK-9）保留作 fail-safe；backlog「暂缓」陈述陈旧 |
| 债4 | bearer 误开缺乏生效自检 | **已根治（无需新代码）** | P2-T5（`d277882`）已落地挂载自检五码 + `innerReconnect` 三态 + fail-closed 拒启 + 链上取证（45 例）；P2-T6（`e0b6945`）补齐回连凭据通路；backlog「待补」陈旧（第 4 例 stale backlog，命中批19 判别式） |

---

## 四、需求池

### P0-1 · 债1：GUI 锁屏 —— 过期注释订正 + E2E 前置配方文档化（纯文档，零 src）

**现状（锚点可复核）**
- `docs/02-design/SECURITY-GOVERNANCE.md` §5.4 恢复动作表：session-guard 自动恢复标注「规划项·未实现；工具面无 sessionId 数据源，Agent 不可自动执行」；§5.3 会话健康探针（锁屏→`degraded`）；§5.5 降级语义（`degraded`→GUI 明确报错）。
- `packages/contracts/src/bridge.ts:38-45`：`SessionHealth.sessionId: number` 为**必填字段**（自契约建立起）。
- `packages/vm-capabilities/psmod/gui.ps1:15-86`：`Get-SessionHealth` 第 16 行采集 `SessionId`、第 71 行回包 `sessionId`。
- `docs/02-design/INTERFACES.md` IF-6 样例即含 `"sessionId": 2`；`psmod/ps-bridge.ps1:147/185-190` 另有 `Get-CurrentSessionId`。
- 全仓 `tscon` / `session-guard` 源码零实现（grep 命中仅 `tsconfig.json` 子串假阳性）。

**根因**
§5.4 表中「工具面无 sessionId 数据源」是**过期注释**：sessionId 自契约起必填、VM 侧探针实测采集、`/health` 已透出 ⇒ 该理由不成立。真实约束另有三条且均在档：① `tscon <sessionId> /dest:console` 需管理员（§5.4 原文本已注明），而 ps-bridge 以登录用户（非提升）运行；② 锁屏态 = Winlogon 安全桌面，同会话内进程**无法**向其发送合成输入（`SendInput` 不可达），这是 Windows 安全边界而非实现缺口；③ 自动登录涉及凭据，§6 载明 DPAPI/凭据管理器且归人工配置。「E2E 回归受锁屏限制」的根因是**环境缺一次性防锁屏配置**，非插件缺陷。

**可行性裁定**
- 锁屏态自动恢复：**不可代码修复**（现行信任模型内——不提权、不落凭据、不破安全桌面隔离）。tscon/自动登录/powercfg 策略均维持「人工配方」定性（§5.4 诚实化注记延续）。
- 可修周边：§5.4 过期注释订正（文档）；E2E 前置人工配方文档化（文档）；E2E preflight 检查（P2，测试基建，可选）。

**建议修复范围（最小变更）**
1. `SECURITY-GOVERNANCE.md` §5.4 表格注记订正：删除/改写「工具面无 sessionId 数据源」为事实陈述（sessionId 在 `SessionHealth` 必填、`gui.session.status` 回包与 `/health.session.sessionId` 在场）；session-guard 未实现的真实理由改写为「需管理员提升（tscon）+ 锁屏态安全桌面隔离（会话内不可合成输入解锁）」。
2. 同节（或 `DEPLOYMENT.md`）增补「E2E 回归前置 · VM 一次性人工配方」：`powercfg /change monitor-timeout-ac 0`、`standby-timeout-ac 0`、`powercfg /h off`（禁休眠）、屏幕保护关闭（`HKCU\Control Panel\Desktop` `ScreenSaveActive=0`）；注明属环境配置、一次性、人工执行；并提示 E2E 开跑前应以 `/health.session.state==='healthy'` 为前置（探针已在位，§5.3）。
3. **不动**：§5.3 探针、`guiAllowed` 判据（PR8 红线）、任何 src/psmod。

**验收标准（可机检）**
- `tests/unit/phase2-session-unknown.test.js` 复跑 **48/48 全绿**（E5 禁字守卫：新文案不得出现「才有意义」裸表述——批19 教训，落字前先 grep 同名断言）。
- SECURITY-GOVERNANCE.md 中 grep「sessionId 数据源」**零命中**，且新注含锚点字样（`gui.session.status` 或 `/health.session.sessionId`）。
- 配方落点文档含「powercfg」与「锁屏」关键词段。
- `git status` 仅文档文件变更（零 src/psmod/dist）。

**风险与回滚**
- 风险≈0（纯文档）。唯一真实风险=文案撞静态守卫（E5/文档守卫族）⇒ 缓解=落字前 grep 断言面（同批19 方法论）。
- 回滚=单文档 commit `git revert`。

---

### P0-2 · 债4：bearer 生效自检 —— backlog 销账（纯文档，零 src）

**现状（锚点可复核）**
- `packages/vm-service/src/http-guard.ts:117-341`：P2-T5 自检三件——`runBearerMountSelfCheck`（五结论码 `not-mounted/mounted-pass/mounted-fail-guard-always-allow/mounted-fail-guard-rejects-correct-token/mounted-evaluator-absent`，同进程正/反例直调守卫产物、零真实 HTTP）、`resolveInnerReconnect`（三态六判序，探针故障绝不冒充 broken）、`shouldFailClosedStart`（18 格决策表，唯一拒启格=`bearer-enforced ∧ broken ∧ failClosed=true`）+ `buildBearerSelfCheckAuditEntry`（链上 `ext.kind:'bearer-selfcheck'`，默认态恒落一条）。
- `packages/vm-service/src/server.ts:108-112/830-943/2302-2325`：启动期装配（先落链证据再抛、拒启先于 createServer、收口桥/监视器）、`/health.security` 纯附加两键喂启动期快照。
- `packages/adapter-agent-workbuddy-llm/src/bridge.ts` `buildMcpConfig`：P2-T6 回连凭据通路（`headers.Authorization = Bearer ${<envName>}` 引用形态，值不落盘）。
- `tests/unit/phase2-bearer-selfcheck.test.js`：**45 例**（A-G 组含 server.ts 装配面静态守卫）。
- git 史：`d277882`（P2-T5 落地）、`e0b6945`（P2-T6 通路）、`ccf8a86`（批6 A2-13 诚实化订正）。
- B3 实况（commit `7e5e6c1`）与文档订正已在档：SECURITY-GOVERNANCE §2.1 警告块（两段式退化：宿主段当场 401 / VM 内回连段 401 打工具面⇒零副作用虚假完成）、§6.1 第 3 点、§7 汇总表、DEPLOYMENT.md、ARCHITECTURE.md、06-OVERVIEW.md 等。

**根因**
backlog「待补 bearer 生效自检」是 B3 演练后、P2-T5 落地**前**的止损计划。P2-T5 已交付「挂载求值自检 + 回连三态 + fail-closed 拒启 + 链上取证」全套，P2-T6 补齐回连凭据分发通路。该条目命中批19 所立判别式（「含『待补』字样 ⇒ 高嫌疑陈旧」）——**第 4 例 stale backlog**（前三例：批18 D-1 schema、D-2 K3 单测、批19 T1 SessionHealth）。

**可行性裁定**
**已根治（无需新代码）**。残留形态均已在档且非缺陷：误开+未接线 ⇒ fail-closed 拒启止损（SECURITY §2.1 判据第 4 点）；`innerReconnect=ok` 的端到端实证走运行期自环探针观测面（`qa/r19/t6-*`），启动自检刻意不谎称已证（判序⑥ `unverified`）。**不得**为凑数新造「再自检」。

**建议修复范围（最小变更）**
- `MEMORY.md` backlog 区该条按销账模式替换：标注已由 P2-T5/P2-T6 落地，举证锚点（45 例测试 + http-guard.ts 三件 + git `d277882`/`e0b6945`）；保留 B3 两段式实况引用（其作为 R4 残留风险登记的语义不变，只是「待补自检」分支关闭）。
- 零 src、零契约、零 `/health` 形状改动。

**验收标准（可机检）**
- `node --test tests/unit/phase2-bearer-selfcheck.test.js` **45/45 全绿**（单文件，不整批）。
- `git grep -l bearerSelfCheck -- packages/*/src` 命中在册（http-guard / server / contracts / core）。
- MEMORY.md 该条含销账标记与举证锚点；`git status` 仅文档文件。

**风险与回滚**
- 纯文档，运行面风险≈0。回滚=单文档 commit `git revert`。

---

### P0-3 · 债3：K3 审批对账兜底 —— backlog 销账 + 观测口径固化（纯文档，零 src）

**现状（锚点可复核）**
- `packages/adapter-agent-workbuddy-llm/src/delegation-truth.ts:251-418`：`reconcileApprovalTruth`——服务端审批账本**结构化反查**（`DelegationTruthProbe.approvalWait` 未决审批事实），门 0-6 判定表；P2-T8（G-a）归属键放宽为 `taskId ?? traceId`（纯 MCP 直调 / 委派 CLI 回连接入结构化覆盖面）；单向 fail-closed（只做 `ok:true→ok:false`）。
- `packages/adapter-agent-workbuddy-llm/src/bridge.ts:825-848`：`reconcileApprovalWait` 文本启发式兜底——**函数体与文案一字未改**（SK-9），角色已降为「结构化退场时」的 fail-safe（门 1/2/3/5/6）。
- 灰度 `WINVM_APPROVAL_TRUTH=on|shadow|off`，**缺省 `on`**（bridge.ts:701/931、index.ts:155/215/240、core constants.ts:307）。
- 链上可计数：每条 `delegation.complete` 可带 `ext.approvalTruth = { decidedBy:'server'|'text-fallback'|'shadow'|'pass-through', gate, ... }`（SECURITY-GOVERNANCE §3.3 审批真值层注记）。
- 测试：`tests/unit/phase2-approval-wait-fallback.test.js` **24 例**（批18 D-2 销账举证：与 `reconcileApprovalTruth` 门序交互 D3a/D3b/D4）；`tests/unit/phase2-truth-mcp-direct.test.js` D 组六条同义改写漏判反例（兜底边界的**诚实登记**）。

**根因**
backlog「根治=bridge 直读 MCP 结构化结果，暂缓」的**根治已兑现**：CL-K3R 起结构化通道上位、P2-T8 扩归属键+归因入链，且缺省 `on` 在网；文本启发式按用户裁决（批17 决策族 / 批18 D-2、SK-9）保留为 fail-safe。真实剩余缺口只剩：兜底命中率的**运营观测口径**未落文档。

**关于 D-6 `delegationActivity` 的评估（任务书指定核验项）**
`delegationActivityFor`（index.ts:591，按 traceId 反查 executed/blocked/wild 三通道活动计数）与 `approvalWait`（未决审批事实）是**两个不同判据**：前者答「服务端有没有活动」，后者答「有没有未决审批」——活动计数无法区分「等待审批」与「已执行/已拦截」。对账兜底应继续消费 `approvalWait`（现位），**不需要也不应该**改消费 `delegationActivity`。结论：已消费正确的结构化信号，无需改动。

**可行性裁定**
**已根治（无需新代码）**。兜底按用户已裁事项保留（SK-9：判定逻辑与回包文案一字未改）——本 PRD **不提议删除兜底**；其已知漏判面（六反例）由结构化通道覆盖，属登记的兜底边界而非待修缺陷。

**建议修复范围（最小变更）**
1. `MEMORY.md` backlog 区该条按销账模式替换：举证=结构化通道缺省 on（`reconcileApprovalTruth` + P2-T8 G-a）+ 24 例直测 + 链上归因字段；「暂缓」表述订正为「已兑现」。
2. SECURITY-GOVERNANCE §3.3（审批真值层注记）补一段**运营观测口径**：`ext.approvalTruth.decidedBy='text-fallback'` 的计数即兜底命中率，作长期观察项（不设门禁、不强触发）；若长期 >0 且集中于某门（如门 5「结构化说无未决审批」），再评估针对性收敛。
3. 零 src 改动。

**验收标准（可机检）**
- `node --test tests/unit/phase2-approval-wait-fallback.test.js` **24/24 全绿**（SK-9：兜底函数体一字未改的守卫面）。
- `node --test tests/unit/phase2-truth-mcp-direct.test.js` 复跑全绿（含 D 组六反例登记）。
- MEMORY.md 该条含销账标记与举证锚点；`git status` 仅文档文件。

**风险与回滚**
- 纯文档，运行面风险≈0。回滚=单文档 commit `git revert`。

---

### P1-1 · 债2：深度空闲冷启动 ~49.3s —— 延长 idle TTL 默认值（唯一真实代码变更）

**现状（锚点可复核）**
- `packages/core/src/constants.ts:107-108`：`ENV_LLM_SESSION_IDLE_MS` / `LLM_SESSION_IDLE_MS_DEFAULT = 300_000`（5min）。
- `packages/adapter-agent-workbuddy-llm/src/persistent-session.ts`：`tick()`（:997-1006）空闲超 TTL 即 `dispose()` 软回收（`plannedRecycles` 记账、不计故障熔断）；`warmup()`（:760-847）仅启动期由 `server.ts:741` `void provider.warmup?.()` fire-and-forget 触发；`firstCallLatencyMs` 一次性采样（:216-223/:677-681）。
- `packages/adapter-agent-workbuddy-llm/src/bridge.ts:1360-1372`：`resolveLlmSessionConfig(process.env)` + `new PersistentCliSession({ idleTtlMs: cfg.idleTtlMs, ... })`。
- 真机证据：深度空闲首调 `firstCallLatencyMs=49278`（全景 N-3；批18 D-5）；D-5 已将 ready 判死 60s→180s（constants.ts:126，`tests/unit/p6-d5-ready-timeout-align.test.js` 5 例）⇒ 不再误杀，但**延迟本身未消除**。
- 已存在的资源护栏：`maxWsBytes=512MB`（constants.ts:132）+ ws 超限软释放 + `wsEvictions` 观测（persistent-session.ts:1008-1023）。

**根因**
idle TTL（5min）回收后，下次委派重建常驻 CLI 必付 codebuddy **进程级冷启动**（auth probe + agent 端点 ≈75–107s 量级，实测 49.3s）。K2 预热只覆盖「服务启动后紧随委派」窗口，不覆盖深度空闲场景。这是 TTL 回收语义的固有代价，不是缺陷；D-5 只修了「误杀」未修「延迟」。

**可行性裁定**
**部分可代码修复**：
- ① **延长 idle TTL 默认值（推荐，本批实施）**：最小变更（一个常量）、零新语义、直接消除多数运营场景的冷启动；副作用=空闲进程内存驻留更久（ws 峰值百 MB 量级，512MB 护栏 + wsEvictions 软释放在位；idle 定时器 1s 级近零 CPU）。
- ② 空闲期保活（周期 `warmup()`）：可行但**改变 idle 回收语义**、引入周期性 LLM 往返、且经串行链与真实轮排队（保活轮在飞时首调要等其 `result`，可能**增加**首调延迟）⇒ 列 P2，先评估后决定。
- ③ 回收前预热：无意义（冷启动成本在 spawn，提前 spawn 只是提前付费）。
- ④ 按需预热触发：无法预知委派到达，不可行。
- 根治「消除进程级冷启动」不可行——codebuddy CLI 外部特性。

**建议修复范围（最小变更）**
- `LLM_SESSION_IDLE_MS_DEFAULT` 300_000 → **1_800_000**（30min；建议值，待主理人/用户裁定，见待确认问题①）。env 覆盖（`WINVM_LLM_SESSION_IDLE_MS`）与 provider options 覆盖通道已在位，无需新配置面。
- **同 commit 同步更新两处硬编码基线**（批18 中间态 RED 教训：cl018-config.test.js 曾硬编码 `readyTimeoutMs: 60_000` 致首跑 RED）：
  - `tests/unit/cl018-config.test.js:45`（`idleTtlMs: 300_000`）；
  - `tests/unit/cl018-constants.test.js:89`（`assert.equal(cfg.idleTtlMs, 300_000)`；:90 引常量行自适配）。
- 复跑 `tests/unit/phase3-b5-idle-recycle-budget.test.js`（idle 回收/预算语义钉，注入 TTL 不受默认值影响，防意外回归）。
- 文档：INTERFACES IF-6 `llmSession` 注或 MEMORY 关键口径处订正默认值陈述（5min→30min）。

**验收标准（可机检）**
- `LLM_SESSION_IDLE_MS_DEFAULT === 1_800_000`（constants.ts）；env 覆盖仍生效（cl018-constants 单测含 `WINVM_LLM_SESSION_IDLE_MS=222222/60000` 用例）。
- `node --test` 单文件复跑：`cl018-config.test.js`、`cl018-constants.test.js`、`phase3-b5-idle-recycle-budget.test.js` 全绿；全量 gate 无新增 RED（门禁按团队既有流程）。
- 真机复测（**观察项，不作门禁**——依赖自然空闲窗，同批18 D-5「待自然窗」登记）：深度空闲后首调 `firstCallLatencyMs` 显著下降；`restarts` 不因回收递增（`plannedRecycles` 语义保持）。
- 文档默认值陈述与代码一致（grep 对账）。

**风险与回滚**
- 风险：空闲进程常驻内存更久（有 512MB 护栏 + wsEvictions 软释放兜底）；回收变慢（运维可 env 调小）；单测基线漏改⇒门禁中间态 RED（已在最小变更清单内防控）。
- 回滚：常量改回 300_000 或部署侧 env 覆盖；零数据迁移、零契约变更。

---

### P2-1 · 债2 附项：空闲期保活机制（观察/评估项，本批不实施）

**现状/根因**：同 P1-1。保活（TTL 内按比例触发 `warmup()` 写无害消息并消费 `result`，天然重置 `lastUsedMs`）可保会话跨 idle 存活，但副作用未量化：串行链排队对首调延迟的影响、周期 LLM 往返成本、对「provider=workbuddy 禁批量 cancel」红线族的相邻性。
**可行性裁定**：可代码修复但**风险/收益未证**，本批只登记评估任务，不实施。
**建议修复范围（评估产出，非代码）**：一份保活副作用评估（串行链排队时延上界、周期往返成本、ws 曲线），作为后续批次的决策输入。
**验收标准（可机检）**：评估文档落盘 `docs/changes/` 并含真机或离线数据。
**风险与回滚**：不涉及代码，无回滚项。

### P2-2 · 债1 附项：E2E preflight 门（测试基建，可选）

**现状/根因**：同 P0-1。E2E 回归目前跑到一半才被锁屏探针拒（GUI 明确报错），浪费回归窗。
**可行性裁定**：可代码修复（测试框架侧）；价值中等，依赖 P0-2 配方文档作失败指引。
**建议修复范围（最小变更）**：E2E 入口处读 `/health.session.state`，非 `healthy` 即早失败并输出配方指引（探针与字段已在位，不新增能力）。
**验收标准（可机检）**：preflight 失败路径有确定性单测或脚本级判据；不触碰 `guiAllowed` 门禁判据。
**风险与回滚**：仅测试面；回滚=移除 preflight 钩子。

---

## 五、诚实性铁律（本 PRD 裁定声明）

- 债1 锁屏态**不可代码修复**：不以「自动恢复」名义编造实现；替代方案=过期注释订正 + E2E 人工配方文档化（已给）。
- 债3/债4 **已根治**：不新造「再自检/再根治」类凑数修复；仅销账 + 观测口径。
- 债2 **部分可修**：延长 TTL 为最小真实修复；保活未经评估不实施；「消除进程级冷启动」明确不可行。
- 四项均零契约面新增、零门禁判据变更（PR8 红线延续）。

## 六、实施顺序与依赖

1. **P0-2 债4 销账 + P0-3 债3 销账**（纯文档，可并行，零依赖）——先把技术债池收敛到真实剩余项。建议同一提交或相邻两提交（MEMORY.md 同文件，注意行区冲突则串行）。
2. **P0-1 债1 订正 + 配方**（纯文档；与 1 可并行，落点不同文件；依赖=落字前 grep E5/文档守卫断言面，方法同批19）。
3. **P1-1 债2 TTL 延长**（唯一代码变更；依赖=先改两处硬编码基线再改常量，同 commit；建议在 1/2 之后单独提交，便于门禁 RED 定位）。
4. **P2-1 保活评估 / P2-2 E2E preflight**（后续批次；P2-2 依赖 P0-1 配方文档）。

可并行：1 与 2（不同文件、同为文档动作）；3 独立；4 为后续。**无跨债代码依赖**（bearer 自检不依赖 /health 新字段——两键 P2-T5 已在位；本批无新字段设计）。

## 七、待确认问题（不阻塞 PRD 主体）

1. **债2 TTL 目标值**：30min（1_800_000）是否合适？备选 15min / 60min。考量：VM 内存（ws 峰值百 MB 量级）、运营期委派间隔分布、回收语义。需主理人/用户裁定默认值（env/provider options 覆盖不变）。
2. **债2 保活是否进入设计评估**：建议本批仅登记观察（P2-1），或授权一次离线副作用评估；不宜直接实施。
3. **债1 E2E 配方落点**：`DEPLOYMENT.md` vs `qa/` 下 runbook；配方是否含 Autologon（涉凭据管理口径，§6 载明 DPAPI/人工，默认不含）。
4. **销账写法**：MEMORY backlog 三条（债3/债4 整条 + 债1 周边部分）按批18/19 销账模式替换，是否本批一次完成（MEMORY.md 属文档动作，但按仓库纪律修改需经主理人核验流程）。
5. **债2 真机复测窗口**：深度空闲冷启动复测依赖自然空闲窗（批18 D-5 同款登记），本批是否接受「离线门禁 GREEN + 真机观察项」的验收形态。

---

## 八、最 risky 项（产品经理判断）

**P1-1（债2 TTL 延长）**——四项中唯一触及运行行为（会话状态机回收时序）且默认值变更影响现网全部部署的项。风险集中在三点：① 单测硬编码基线漏改导致门禁中间态 RED（批18 已演过一次，本 PRD 已列两处必改点）；② TTL 延长与 ws 护栏/`plannedRecycles` 记账在更长空闲期下的交互（离线可测，但真机内存曲线待观察）；③ 真机收益不可即时验证（依赖自然空闲窗），存在「离线绿≠现网生效」的证明缺口。缓释：最小变更（单常量+两基线）、env 一键回滚、真机观察项如实登记。其余三项均为文档动作，风险接近零。

# Phase 3 批5 · 验证面恢复 施工记录（主理人亲自实现，分批推进中）

> 范围=audit 终版 §6 批5 行：A2-14 审计链保留期（**用户终裁参数 90 天 ∧ <2GB 超限删最老**）+ R-5 取消风暴门禁化（用户 B）+ T13 防再发（用户 A+要求）+ Q2/Q3/长跑四债/真机 E2E。
> 本文件先记 A2-14，其余项随进度 append。

## A2-14 · 审计链保留期（已落地）

### 设计（纯附加，缺席即逐字旧行为）
- `RetentionPolicy { maxAgeDays, maxTotalBytes, minKeepShards?=2 }`，两标准**各自独立**判定（超龄 OR 超体积命中任一即入可删集）。
- `planShardPrune(shards, {policy, protectedNames, nowMs})` **纯函数判定面**（不触盘），单测可直接断言，无需真建真删。
- `HashChainAuditSink.pruneShards()` 执行面 + `startRetentionSweep(intervalMs, onPrune)` 低频定时器（unref，不阻退出）。

### 五条安全红线（写进 planShardPrune 守卫）
1. **活动片保护**：`protectedNames = activeShards ∪ 最新一片`，永不删（现部署 freshChainOnStart=true ⇒ 活动链与新链分离，删归档片不伤 verifyChain 判定，这是安全前提）；
2. **年龄取文件名日期**（`prefix-YYYYMMDD[-idx].jsonl`，UTC）而非 mtime——规避 QA 在基线查法发现的"mtime 被 checkout 复制重置⇒判据失准"同族坑；文件日期解析失败⇒视为"最新"绝不删（对删除保守）；
3. **minKeepShards 下限**（默认 2）：无论判多超龄，存活片数绝不跌破下限——防"配置写错/时钟漂移一次性清空整目录"；
4. **两阶段**：先标记"过期事实"（体积累计 + 年龄），再从最老落地且守 minKeep——removable 严格按从老到新序，杜绝混序裁错；
5. **fail-safe 全程不抛**：stat 读不到的片不纳入判据（不删看不见的东西）；unlink 单片失败跳过下轮再试；清理异常绝不冒泡到主写入路径。

### 删除留痕（审计自证纪律）
prune 删片这件事本身**必须入链**，否则保留期=静默抹除通道。`onPrune` 回调落一条 `__meta.retention.prune`（channel:'internal'，风险 L0），清理事实放 `params`（分片名非敏感键，redact 原样保留）——**不新增 ext 枚举成员**（扩 union 类型需跨契约一致性，成本高于收益，登记为设计选择）。

### 配置装配（用户"默认即安全"哲学）
- `AuditConfig` 平铺 `retentionMaxAgeDays/retentionMaxTotalBytes/retentionMinKeepShards`（不走嵌套对象，config-key-lint 白名单派生面最稳）；
- **出厂 DEFAULT_SERVICE_CONFIG 即启用 90 天 ∧ 2GB**（与 fail-closed 显式默认同族："磁盘无上界增长"是默认事实而非需用户想起来配置）；两标准全 ≤0 ⇒ 禁用逐字旧行为；
- server.ts 装配点：listen 后 `startRetentionSweep`（6h 低频 + 启动先跑一次），close() 首步 `stopRetention`（退出竞态里不"边关边删"，同 pendingApprovals.close 纪律）。

### 验证
- `planShardPrune` 纯函数 8 例 + `pruneShards` 端到端（真实 tmpdir）5 例 = **13/13 绿**（`tests/unit/phase3-b5-audit-retention.test.js`）；
- 回归亲跑全绿：audit 既有链 / cl018-config 7 / host-adapter 35 / k5-replay 41 / assembly-guard 24 / phase2-dead-config 14（retention 缺席=禁用故既有测试零影响）；
- `tsc -b` RC=0；`gate --quick` VERDICT GREEN（config-keys 未知键=0=新三键被类型派生白名单放行；guards files=8 166 例含新 skill-claims）。

## T13 防再发（已落地：写路径串行修复本就到位，本批补"回归锁死 + 跨片接链"）

### 亲验结论：分叉根因修复**早已在位**（不是待修，是待钉）
chain.ts:481-494 `append()` 的 D30 竞态修复注释白纸黑字——旧实现"进串行区之前同步取号（seq/prevHash），状态回写延后到写盘完成 ⇒ 并发取到同 seq/同 prevHash ⇒ 链分叉（真机实证三天分片 672 条恰两处重复 seq：511 与 582）"，**现全部状态读写移入 `writeQueue` 串行闭包**。用户要的"确保以后不再出现存档指向错乱"= 把这条修复**锁死成回归**（否则某次重构悄悄把取号挪回串行外，1889 单测无感——正是 psmod-contract 那类"跨函数隐式契约编译器看不见"的同款失效）。

### 新增 `tests/unit/phase3-b5-chain-fork-guard.test.js`（3 例）
1. **50 条并发齐射**（单 tick Promise.all，非串行 await）⇒ 断言落盘 seq 恰为 1..50 无重无漏 + verifyChain valid（重复 seq=D30 分叉复活当场红）；
2. **并发 + 强制轮转**（maxFileBytes=200 逼出多片）⇒ "存档指向错乱"就发生在片边界接链；独立复核（不依赖 verifyChain 内部）逐条验 prevHash==前驱 hash + 自哈希重算，跨片全链 valid；
3. **两轮重启续链** ⇒ 第二轮接第一轮尾 hash、seq 延续不重置（跨轮接链正确性）。

### 为何不新增"跨片 prevHash 连续性判据进 verifyArchive"
verifyArchive 的**片内基线取自本片首条**（O-8 设计：轮转片首条 prevHash 指向上一片尾条，若硬用 GENESIS 起步则每片正常历史全报 CHAIN_BREAK=噪音，正是设计点名要防的形态）。跨片首条接链关系在片内**无从**校验，其可信性由写它那天的 verifyChain 全链判定负责——而 verifyChain 现已并发安全（本批锁死）。**扩 verifyArchive 做跨片比对 = 与 O-8 设计冲突**，采"锁死写路径串行"这一更根本的处方（分叉在生产侧被杜绝 ⇒ 归档侧自然无分叉可检）。登记为设计判断，交后续 review。

## Q2 守卫三修 / Q3 孤儿接线 / A2-3/5/6/7 长跑四债 / R-5 取消风暴门禁化 / 真机 E2E（待做，部分依赖真机窗口）

## R-5 · 取消风暴门禁化（已落地 2026-10-13）

### 病灶与处方
真机实证 198 任务 × 并发 8 的 `tasks/cancel` 打挂 vm-service + ~90 孤儿 node。根因链：每次 `requestCancel` → `cancelController.abort` + `updateStatus('canceled')`，对 provider=workbuddy 的 LLM **常驻会话**而言 abort 打断当前轮 ⇒ 触发会话重建；批量并发 cancel ⇒ 重建风暴 ⇒ 崩溃。MEMORY 红线"单条 cancel 端到端 ~3.4s 已属重操作"。**用户终裁 B=主动排期**（不等触发器 T-2 再赌运气）。

### 落点（纯附加，缺省禁用逐字旧行为）
- `packages/a2a-framework/src/rate-limiter.ts`：`CancelRateLimiter` 滑动窗口限流器（纯函数式计数，可注入 now 供离线单测零等待；无定时器、无状态泄漏——旧桶随窗口滑出丢弃；被拒不入窗口=不消耗预算也不污染）。
- `A2AServer` 装配 `cancelRateLimit?: CancelRateLimit`（opts 纯附加）；tasks/cancel 分支**前置消费闸**：超限直接 `fail` 拒回（不进 requestCancel ⇒ 不打断常驻会话、不触发重建）。**拒绝发生在 task 查找之前**（测试用 ghost id 证明：首个到 requestCancel 报 TaskNotFound，第二个必 rateLimited 而非 TaskNotFound ⇒ 坐实挡在风暴源头之前）。
- `resolveCancelRateLimit(env)`（constants.ts，照 resolveApprovalTtlMs 先例）：**缺省 10/1000ms**——判据=人工/单 Agent 串行取消（198 串行需 198×3.4s）远低于此，只有批量并发风暴触顶；env 显式 `WINVM_CANCEL_RATE_MAX=0` ⇒ 禁用（保留旧行为），非 0 非法值回退默认。
- vm-service 装配 `cancelRateLimit: resolveCancelRateLimit(process.env)`。
- 测试 `phase3-b5-cancel-storm-gate.test.js` 12 例（限流器 5 + env 4 + A2AServer 端到端 3，含 200 齐射仅 10 过）。

## A2-3 · idle 回收不再吃故障重启预算（已落地 2026-10-13）

### 病灶（主理人逐行亲验坐实）
`spawnOnce()` 无条件 `spawnAttempts += 1` → `restarts = spawnAttempts - 1` 单调爬升；而 idle TTL 回收（`tick()→dispose()` 软释放回 stopped）与 ws 超限回收**都走同一条 dispose 路径**，其后的重建照样占计数 ⇒ 长跑挂机（每 idleTtl 周期自然回收一次）把"计划内正常回收"与"真故障重建"混记同一本账，累计到 `maxRestarts` 即 `disabled` 永久停用（仅 restartFresh 手工可解，正常路径无自动复位）。

### 修复（最小侵入，保留观测价值）
- 新增两私有字段 `plannedRecycles`（计划内回收计数）+ `recyclePending`（一次回收待其重建消费的标志）；
- `tick()` 两处软释放（idle TTL / ws 超限）各置 `recyclePending=true`；`spawnOnce()` 消费（`recyclePending` 在场 ⇒ `plannedRecycles++` 并清标志，**一次回收只抵消一次重建，绝不虚增**；回收后若不重建则标志保留，不虚增 plannedRecycles）；
- `ensureReady()` 熔断判据改 `faultRestarts = max(0, restarts − plannedRecycles)`；**`restarts` getter 不动**（/health 仍如实反映总重建数=观测价值保留，只是不再是熔断判据的唯一来源）；
- `restartFresh()` 复位时 `plannedRecycles/recyclePending` 一并清零（与 spawnAttempts 归零同义"状态机从头开始"）；
- **无计划内回收时 plannedRecycles=0 ⇒ 判据逐字等于旧行为** ⇒ 既有故障路径测试（spawnFault/r19c/cl018 走的是不经 tick 的路径）恒不受影响（已亲验 restartF=0，既有 4 件全绿）。

### 判别性测试 `phase3-b5-idle-recycle-budget.test.js` 5 例
① 6 轮 idle 回收在 maxRestarts=2 下永不 disabled（**修复前此处必红**=判别力证明）；② 纯故障重建（spawnFault 不经 tick）仍正常熔断 ⇒ 修复未削弱真故障保护；③ 混合（先回收后故障）故障预算足额可用（回收未预支）；④ ws 超限回收 5 轮同不占预算；⑤ restartFresh 清零两新计数。复刻 r19c FakeChild 夹具 + 可控时钟，零真实 CLI 依赖。

## 仍待做（依赖真机窗口或后续批次）
Q2 守卫三修（snapshot-truth 解构绕过/config-key-lint 静默绿/s5 恒真）、Q3 孤儿测试接线（e2e/smoke + delivery/__tests__）、A2-5/6/7 长跑债（ps-bridge 自愈文案/重放不 settle/SSE 空转）、真机 E2E 回归批（P0-4：5域×2通道 18 例重跑 + V1-V13 psmod 生效窗口）。

## 批6 移交登记（2026-10-14，主理人直接实现，续 §批5）

### D-3 台账销账（对账=已闭环，非本批新增）
亲验 `packages/contracts/src/schema-check.ts` 头注释+实现：Phase 2 · P2-T1（裁决 Q1=(b)）已把
capability.schema.json 变成**被消费资产**（validateCapabilityShape/checkSchemaDomainDrift，
appops 已入 enum/pattern:26/29）；消费面=测试（phase2-contract-schema.test.js 23 例，ST3 门禁在册）
+交付门禁，运行期零接入是**裁决明令**（"运行期校验只在校验自己编译出来的东西，安全增益≈0"）。
⇒ audit §3.3 的"全仓无运行期校验器消费"是 Phase 1 时点旧账，Phase 2 已按裁决 (b) 路径闭环。销账。

### A2-9 enforceBearer 配置层硬前置（本批）
- config-key-lint.mjs 新增导出 `checkBearerPrecondition(cfg)`（纯静态、零 env 依赖=价值本体）：
  ① enforceBearer===true ∧ tokenEnv 缺席/trim 空白 ⇒ HARD ENFORCE_BEARER_MISSING_TOKEN_ENV
  ② enforceBearer 存在但非布尔 ⇒ HARD ENFORCE_BEARER_NOT_BOOLEAN（=== true 恒假=假开关；类型坏不叠加①噪音）
- lintConfigKeys 集成：bearer findings 与 UNKNOWN_CONFIG_KEY 并列进同一 findings[]（rule 字段区分）；
  formatConfigKeyReport 与 gate.mjs ST2b 打印面双写适配；现网两配置资产 enforceBearer:false ⇒ 零误伤（实测 GREEN）。
- 与运行期 validateServiceConfig 的 warning 关系：**双层不互替**——运行期报"有名无值"（读得到 env），
  门禁钉"结构上第二条件永假"（读不到 env 正是价值）；这正是 A2-9"config-lint 硬前置"的本体。
- 测试 tests/unit/phase3-b6-bearer-precondition.test.js 8 例（判别性双向：注入必红 tmpdir 陷阱=buildWhitelist
  需真实 TS 源 ⇒ 临时文件落项目根；现网必绿）。

### A2-11 wsProbe 死配置终结（本批）
- 新模块 packages/adapter-agent-workbuddy-llm/src/working-set-probe.ts：createWorkingSetProbe 四红线
  （绝不抛=未知不触发误回收 / 自带 5s 采样节流窗（tick 1–30s 高频，防每 tick spawn tasklist）/
  pid 变更缓存作废 / 失败进节流窗防重试风暴）；parseTasklistMemUsage（CSV 千分位）+parseProcStatusRss（/proc VmRSS）双平台纯函数。
- constants.ts：ENV_LLM_WS_PROBE（缺省启用，显式 0/false/off 关=逃生舱逐字旧行为）+ENV_LLM_WS_PROBE_INTERVAL_MS。
- bridge.ensureSession 接线：win32 ∧ enabled ⇒ wsProbe: createWorkingSetProbe({pidOf: () => self?.snapshot().pid})。
  **关键设计**：ws 超限回收走 ensureReady→spawnOnce 同一实例（pid 变），不走 ensureSession 重建 ⇒
  探针必须绑本实例当前 pid（let self 延迟引用，构造期不调用 TDZ 安全）；snapshot().pid 回收后自动缺席⇒探针 undefined，语义自洽。
- 与 A2-3 咬合：tick ws 分支早已置 recyclePending（批5 双写）⇒ ws 回收不占故障预算，护栏激活无副作用放大。
- 测试 tests/unit/phase3-b6-ws-probe.test.js 13 例（四红线判别性双向+平台分支+env 开关+tick 语义兼容）。
- 真机面：VM=win32 ⇒ 本批 dist 推 VM 重启后探针真实激活（列入 V14）。

### A2-13 probeError/probeStatus 死判据 → 诚实化订正（批6 part2，主理人终裁）
实况复核（三处行号亲验）：`resolveInnerReconnect` 判序②③的生产装配点 `server.ts:798` 只传
authMode+providerOptions 两键（恒不喂 probe*）；拒启 `:806` 取 `innerReconnect.status`（配置面 const）；
运行期探针 `:2149 probeInnerReconnect` 的实证结论经 `:2163 innerReconnectObserved = probed` **直接赋值**
升级观测面（`:1917` 透出面读观测面）——即"实证优先"语义已在生产以另一条通路达成，且该通路**刻意**
绕开本函数以守 PR3 红线（拒启恒按配置面，观测面坏不得影响启动面）。
⇒ 主理人裁**诚实化**而非接线：接线（观测面回流判决）=违反 PR3；删除（D 组单测 319-335 钉语义契约）无增益。
订正=http-guard.ts 两处注释：旧 probeStatus 注释"由调用方（server.ts 启动期 fire-and-forget）回填"是
失实表述（server.ts 从不回填本函数），已改为"纯函数契约面+生产不喂+观测面经直接赋值升级"三层口径显形。
判据行号勘误：arch3 原述 server.ts:785 → 实装配点 :798；:2066"覆盖不回灌" → 实况 :2163 直接赋值升级观测面（非覆盖字段）。
验证：tsc RC=0；phase2-inner-credential 38/38 + phase2-bearer-selfcheck 45/45 全绿。

## 真机窗口执行记录（2026-10-14，VM 恢复后可达窗口，主理人执行）

**前置复核**：VM ping 0% 丢 + ssh VM_UP + 隧道 daemon pid4357 RUNNING（reconnecting 自愈到位=批2 Q1 活证）+ /health ok。deploy-vm --apply 前置安全确认：VM runtime.json 与本地生成模板差异全部=已入库演进口（P2-T5/Phase2 注释、批5 retention 走 DEFAULT 内置）⇒ 铁律"先部署→后补丁"无待补手工补丁，可安全直跑（1011 现网永久留档 qa/p3-batch-sweep/vm-runtime-config-20261011.pre-p3b2.json；deploy 后对账 IDENTICAL=零漂移实证，二次 deploy 复跑同结论）。

| V | 结果 | 证据 |
|---|---|---|
| V1 | ✅ PASS | deploy-vm 管线 BUILD→分发→install→VM-START 全绿；psmod-drift NO_FINGERPRINT→**PASS**（六键非空 capturedAt=重启时刻）；capabilitiesProfile（M7）在 VM 实况 |
| V2 | ✅ 三态闭环 | 源仓探针→DRIFT（两方）→带 --vm-disk 三方判 **STALE**→scp 磁盘同步→**FAIL-DRIFT**（deploy 到位进程旧版=R-4 核心场景）→还原+同步→回 **PASS**（STALE/DRIFT/PASS 三判据全实跑显形） |
| V5 | ✅ | prepare-vm --apply ×2：首遍 DB-2 created×2+DB-5 三件套+DB-6 SKIP；次遍**全 [SKIP]**+PREPARE_VM_DONE；DB-4 保持 [MANUAL] 不谎报（手工 6→2 达成，DB-2 防火墙已实补） |
| V6 | ✅ | 只读探测面 RC=0（探针先行→apply 幂等计划 [SKIP]/DO/[MANUAL] 三分=设计自洽） |
| V10 | ✅ | 再启 daemon 第二实例被 wx 独占挡回"已有隧道进程 pid 4357，不重复启动"rc=0；日志行 **pid= 前缀在场**=批2 新产物运行直接实证；现有隧道零干扰 |
| V11 | ✅ 闭环 | 部署前 --check-fresh RC=1 点名 8 MISSING（批4/6 新产物）+68 MISMATCH（仓库≠分发真相源活例）；install-host --apply --yes RC=0（尾相位自动对账 ✓FRESH 178 文件）；复跑 check-fresh **RC=0 FRESH**（DEP-02/05 解药实跑达成） |
| 审计链 | ✅ | 87 片/3657 条生产权威三维复核：仅 3 异常全为 T13 已销账化石（seq511/582/693=D30 注释现场）；**D30 修复后 60+ 天零复现 ⇒ T13 防再发实证成立**；首轮自造脚本"41 跨片断"系判据口径误用（轮转片各自 seq=1 起链=verifyArchive 设计），以权威复核订正留痕 audit-chain-live-verify.md |
| retention | ✅ 观察 | 现网 0.003GB（<2GB）/最老 28 天（<90）⇒ 双阈值正确不触发零删除；出厂默认在位（DEFAULT_SERVICE_CONFIG 三键实证） |
| E2E 5×2 | ✅ 16/16 | qa/harness/e2e-p3-5x2.mjs（提交 235ca81）；首跑 9/14 四 FAIL 全部定性=harness 形状误判（health 嵌 data 下/app.inventory 参数/message/send/agent-card.json——服务错误回执自指引清晰），修后 16/16 |
| V8 旁证 | ✅ 隐性达成 | VM 关机期 daemon 退避存活（隧道日志 EHOSTUNREACH 内部消化+退避重连行在场）→VM 拉起后自动 reconnected（state.json RUNNING+lastEvent）=启动退避+稳态重连全链活证 |

**未执行项与路由**：V3/V4（winget 树杀真弹）=需真实卸载窗口，V2 的 app.ps1 已在 VM 生效（指纹含 app.ps1），判据面=下次真卸载时观察 output 含 [k6]/[q5]；V7（登录前后二态）=VM 已登录态仅实测 config-dir-present 态（前态不可回退复现，结构性）；V12（死链双侧收敛）=fix-approval-deadlinks 宿主侧已实跑+install-host 分发面已同步，VM shared-skills 面待下轮 deploy-vm 自然覆盖（本已跑过）；V13=winvm-plugin health 播报需连接器会话面，离线单测已钉；**V14（wsProbe 真机采样显形）=新登**：批6 A2-11 已随 deploy 推 VM，实证法=长跑后 /health llmSession 观察或日志"工作集超限"行；V15（A2-17 端到端）=新登：批准→换参续跑拒→重审。

**VM-START 超时归因（假阴性）**：deploy 尾报"启动触发失败 TIMEOUT"但服务实际在监听（owner PID 18948，health 200）——端口轮询竞态（start-hidden 重启窗口 >轮询预算）；判据以 /health 实证为准，登记为交付脚本已知观察项（不中伤流程：二次 deploy p3b6 同形态同结论）。

## 批5-Q3 孤儿接线 + ps-bridge spawn-error 真缺陷修复 + V12 残余收官（2026-14 下午）

### Q3 孤儿（audit §3.2 Q3）
gate.mjs 新增 `listSweepFiles()`（tests/unit 裸文件名 → ROOT 相对路径 `tests/unit/**` + `delivery/__tests__/**` 合流）；`runPerFile` 双形态兼容（含 `/` 者按 ROOT 相对解析，裸名维持 tests/unit——ST3 门禁表消费端零改动）；`stageSweep` alreadyRun 按 basename 剔除；`diskTestFileCount`/DISK 旁证同源 `listSweepFiles`（防"磁盘计数落后实跑清单"假 MISMATCH）。`delivery/__tests__/oh-tunnel-error-handling.test.mjs`（8 例，CL-016 起孤儿）首次进全量 sweep（gate-q3-final.txt 行 `GREEN delivery/__tests__/...` 为激活铁证）。同目录 probe-*.mjs 系被 spawn 夹具非测试文件，天然不入列。tests/e2e/smoke.test.js 不并档：真起服务依赖 pwsh（POSIX 恒 ENOENT），保留为 VM 真机窗口专用件（其"16 例全绿"须在有 PowerShell 的环境判定——本机跑时见下述 smoke 修正）。

### smoke 用例修正（Q3 侦察中揪出的真因）
"L2 删除触发审批闸"用 `C:\Users\alice\old`——**不在 pathAllowlist**（离线 createService 环境 USERPROFILE≠alice）⇒ 策略在审批闸**之前**以 pathAllowlist:miss 拒（POLICY_DENIED 是正确行为）⇒ 用例期待 APPROVAL_REQUIRED 永不可达（真机恰 alice=当前用户才绿的侥幸面）。改 `C:\WinVMWorkspace\drafts\old.txt`（defaults.ts 硬编码生产目录白名单）⇒ 离线 16/16 全绿、两环境同判据。

### ps-bridge spawn 'error' 盲区（真缺陷，生产形态=自愈反成崩溃源）
spawnAndReady 只挂 once('exit') 无 'error'——Windows 上 spawn ENOENT/EACCES（自愈重建时 PATH 竞态/杀软隔离）Node 只发 error 不发 exit ⇒ 未捕获异常可打挂 vm-service + pending 呼叫悬挂。修：spawned.once('error') 折叠为与 exit 同族收口（failAll(PSBRIDGE_SPAWN_FAILED)+spawned 比对清 child 防误清新进程）。判别测试 tests/unit/phase3-b5-psbridge-spawn-error.test.js 2 例（跑完不崩=事件被吞的判别面本身）。

### V12 残余 2 处收官（三面 6+6+6 之外）
mcp-reference:203 纯文本指涉 `winvm-orchestrator/approval-card.md`（无 ../ 前缀，脚本规则盲区）与 approval-card.md:7 唯一性红线**示例链接本身即死链**（教人写错形态！）——均已订正为 references/ 真身路径；grep 全 skills 复验零残留。

### 终态
全量 gate **VERDICT GREEN = 新基线 112 件/2046 例（2044 pass/0 fail/2 skip）**，DISK=112 RUN=112 MATCH（110→112=孤儿 8 例并入+spawn-error 新测 2 例，精确吻合）；证据 qa/p3-batch-sweep/gate-q3-final.txt。批5 离线面自此**全部收官**（真机窗余 V3/V4/V14 采样显形/V15 端到端）。

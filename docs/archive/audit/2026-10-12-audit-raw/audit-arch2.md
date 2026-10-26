# WinVM Bridge 全面审计（架构棒 2 · 续维②–⑦）

- 审计人：Bob②（software-architect-2，接力，只读）
- 开工：2026-10-12 20:28（接棒点=维②）
- 仓库：/storage/Users/currentUser/Documents/projects/workbuddy-virtual-win-plugin
- 纪律：结论均附文件路径+行号/摘录；本文件**独立成篇**，供主理人与 audit-arch.md 顺序合并。

---

## ⓪ 接力状态变更与差分登记（2026-10-12 21:57 追加）

**前棒复活**：`audit-arch.md` 于 21:33 由 7798B 增至 28062B，已完整写出维①②③并推进至维④（4.1–4.5，末行截在 4.5 表格首行）。按并发保险铁律我**未触碰该文件**，本节登记两棒重叠与增量，供主理人合并去重：

**维②（重叠度高，各有独占项）**

| 主题 | 审计①（audit-arch.md） | 审计②（本文件） | 合并建议 |
|---|---|---|---|
| K3 兜底残余面 | D-1：门 3 措辞依赖是"假成功"唯一文本触发判据；根治=改本轮工具调用计数触发门，medium，P2 | 2.a：**常驻 turn 失败态甄别**（bridge.ts:1497 只走文本启发式、门 0 `!base.ok` 拒绝）；"直读 MCP 结果"**不可达**（NDJSON 协议无 tool_result）；①okFalseBranch 双源化 1–2 人日 | **互补保留**。①抓的是门 3 触发门，②抓的是 ok:false 分支——同一判据的两个不同缺口 |
| 早退零审计口子 | D-2：replay 拒绝 ×2（server.ts:1161-1177）+ `!provider` ×2（:1103/:1534），P1 | 2.b：**`raise()` no-active-task 早退（:363）**——①未列；且给出普查口径（approval-replay.ts 14 处 return 零放行口） | **②的 raise 口子为增量，P1 保留**；其余四处两棒同名同结论，合并为一条 |
| 冷启动/首调口径 | D-3：warmup 只覆盖重启后首调；firstCallLatencyMs 全仓零真机读数 | 2.c：口径坑①深度空闲双份冷启动、坑②warmup 不经 runTurn 采样不到（INTERFACES.md:299 缺警示）、**坑③ idle 回收吃 maxRestarts 预算 ⇒ ≈5 周期后恒 disabled** | **坑③为两棒均未登记的新发现（P1）**；"零读数"结论①独有，采纳 |
| 死配置族 | D-4：`maxWsBytes`/`wsProbe` 有名无消费（P1-lite）；schema-check 无债 | 2.d：D-3 两项均已过时（backlog 口径滞后）；6 个 WINVM_* 裸读绕单源；文档幽灵 `WINVM_A2A_REJECT_ON_DISABLED`；`probeIntervalMs` **①判"证据不足"，②已实核为活消费**（见下修订） | 合并；②的裸读单源破口与文档幽灵为增量 |
| 同名异物 | D-5：不建议重命名，登记+定向钉 | 2.e：probeError 治理必要性低（结论一致）；snapshot 守卫"形状保留、口径升格"+注释含字样即改措辞实证 | 结论一致，②的成本案例并入 |

**维③（重叠，②有独占取证）**：审批真值默认 on（两棒同结论）、T13 走登记路线不修写路径（两棒同结论）。②独占增量：(a) **bearer 自检判决面/观测面分离三不变量**（server.ts:745-860 装配实证：`innerReconnect` 判决用静态接线事实、运行期探针只进 `innerReconnectObserved`，两者混用会让"token env 被撤"误判成 bearer broken 而拒启）；(b) **拒启先落证据**（:843-860 无条件在场）；(c) `WINVM_APPROVAL_TRUTH` env 与 `delivery/vm-service.config.json` 未写该键 ⇒ 现网默认 on，①问的"shadow 何时转 on"同样被时代抛下。①独占且采纳：Origin/CORS **文档宣称在代码中不存在**（SECURITY-GOVERNANCE.md:38 假宣称，P2 文档诚实化）。

**维④（分工，无冲突）**：①已在写 4.1–4.5（隧道三层缓解 / giveup⇒exit1 不变量 / VM 侧强于宿主侧 / 双进程防护 / 版本漂移 R-4）。②从 4.5 之后续，独占素材：隧道**今日死因三例逐条归因**（`~/.workbuddy/winvm/tunnel.log` 实证）、psmod **无内容版本指纹**的实核路径、"同任务严禁双棒"机制化评估（`lock-probe.mjs` 非此用途已确认）。重叠部分（退避参数、pidfile、RestartOnFailure）**不再重述**，只出增量。

**②自我修订两处（按实况更正，主理人合并时以本表为准）**：
1. 2.c-① "深度空闲冷启动"我原判"**半登记**"，据 ①D-3 与 phase2-arch-design.md:580 更正为**已登记**（K2 遗留，"本批只度量不优化"），故坑①降为 P2（不新立项）；**坑③维持 P1**（两棒文档均未登记该交互项；CL-018 只核查过 idleTtlMs/maxRestarts 各自实现，未考察二者交互，见 2.c-③ 校准；测试钉亦无覆盖，实核证据：`tick()` 走 `void this.dispose()`（persistent-session.ts:959→:1063 `killChild`+`state='stopped'`），下次 `ensureReady` → `spawnOnce` → `spawnAttempts += 1`（:426），`restarts = spawnAttempts - 1`（:280）；`restartFresh()` 清零计数**仅运维 `POST /admin/llm-session/reset` 触发**（:990，调用链 bridge.ts:1081），无任何自动复位 ⇒ 计划内回收与计划外崩溃共用一张预算表）。
2. 2.d 中我提"`probeIntervalMs` 未逐行核验"——现核清：`server.ts:547` `intervalMs: cfg.session.probeIntervalMs` **活消费**，非死配置（与 ①D-4 第 2 条"证据不足"同项，两棒一并销案）。同时确认 ①D-3 的 `wsProbe` 结论：全仓 `wsProbe` 仅 4 处命中（persistent-session.ts:93 类型、:949 注释、:963/964 消费点），**bridge 构造点（bridge.ts:1341-1356）不注入** ⇒ `WINVM_LLM_SESSION_MAX_WS_BYTES`（config/index.ts:263-265 → bridge.ts:1350 → 构造）链路透传完好而探针源恒 undefined，护栏**永不触发**——最坏形态（参数可配、日志文案像在工作）。两棒同结论，**P1-lite**。

---

## ② 实现面技术债清单

### 2.a · delegation-truth.ts 兜底启发式（K3 遗留）——真实残余面比 backlog 口径窄，但有三处未登记尾巴

**判据现状（结构化主判据已在册）**：`reconcileApprovalTruth`（delegation-truth.ts:251-418）门 0–6 + `probe.approvalWait` 结构化反查，桥两处 `ok:true` 收口点接线（bridge.ts:1513-1536 常驻 / :1813-1835 单次，均经 `attachTruthAttribution`:1559）；文本兜底 `reconcileApprovalWait`（bridge.ts:805-828）已降为第二道闸且函数体一字未改（SK-9）。

**残余的措辞依赖面（逐一实证）**：

1. **常驻 turn 失败审批暂停态甄别**：bridge.ts:1478-1509 —— `turn.ok=false` 时**只**调文本启发式 `reconcileApprovalWait(failedBase, turn.text)`（:1497），**不调**结构化判据（代码注释 :1488 自述理由：门 0 `!base.ok` 透传纪律会拒绝 ok:false）。即：codebuddy 安全策略在调工具**前**拦截、以 is_error result 上报的形态，其「是否审批等待」仍 100% 靠措辞判定；shadow 态对拍也只 warn（:1499-1504）。⇒ 这是「bridge 直读 MCP 结构化结果」未覆盖的**真实残余通道**。
2. **漏判关键词面**：`APPROVAL_WAIT_KEYWORDS = ['APPROVAL_REQUIRED','等待审批']`（bridge.ts:746），同义改写不命中已诚实登记（:741-744 + 六条反例钉在 phase2-truth-mcp-direct.test.js D 组）。
3. **G-a/G-b/G-c 已闭环**（P2-T8 交付，phase2-arch-design.md:566 实录）：归属键 `taskId ?? traceId` 双缺才回退（delegation-truth.ts:316）；归因 `onTruthDecision`→`ext.approvalTruth` 链上可计数（:275-287）；`registerApprovalWaitFallback` 注入链 + E-2b warn（:300-307）。**backlog 里「根治」一词的剩余工程量应按上表第 1 项重新校准**。

**「bridge 直读 MCP 结构化结果」终极形态改造面估计**：桥的 stdout 是 NDJSON 事件流，`onEvent` 现只消费 `system/init | assistant | result`（persistent-session.ts:496-507 dispatch、:850-873 execTurn onEvent；`extractAssistantText` :176-194 注释明言「tool_use 等忽略」）；`result` 事件仅取 `{type:'result', is_error, result:string}`（:863-871）——**工具级结构化结果在 LLM CLI 输出协议层根本不存在**（全仓 qa/docs 无一条 tool_result 形态样本可证 codebuddy 会发）。⇒ 直读路线**不可达**，除非上游 CLI 协议暴露 tool_result。真正可比的「直读」已由 **S1 主通道**兑现（collectApprovalFacts 读服务端同进程 pendingApprovals，approval-replay.ts:348-382）。**残余可改造点仅两处**：
- ①第 1 项失败态双源化：给 `reconcileApprovalTruth` 增设 `okFalseBranch` 入口（跳过门 0，复用门 3–6 逻辑），把 :1497 处文本判定降为兜底。估计 **1–2 人日**：判据 +60 行、新收口接线、补 D 组式直接单测约 10 例；红线同 K3（单向 fail-closed，不得把真失败改判成等待审批之外的任何形态）。
- ②措辞漂移监控自动化：链上已有 `ext.approvalTruth.decidedBy` 全量落计数（SECURITY-GOVERNANCE.md:173），「text-fallback 命中率」看板只差消费端——估计 **≤1 人日**（analyze 脚本一条）。
**裁决建议**：①并入 Phase 3「真值层收尾」小批（P1 优先）；②随运维看板批。原「根治」大改造**不立项**——主通道已直读服务端事实源，剩余是边角。

> **②棒对前棒 D-1 的独立复核（22:30 补，合并时归 D-1 名下）**：前棒指出"门 3 完成声称仍措辞依赖"（LLM 用未登记同义词自宣完成时改判不触发）——我实核该行确在：`delegation-truth.ts:88` `if (!COMPLETION_CLAIM_PATTERN.test(finalText)) return base; // 门 3`，且同族门 3 还有"探针缺席即透传"分支（:322 `门3：探针缺席 = 旧行为`）。⇒ 前棒 D-1 的"改造=把是否采信完成声称的门从文本改为本轮工具调用计数"**成立且与本棒 2.a 的 okFalseBranch 双源化互补**（一个治 `ok:true` 的触发门、一个治 `ok:false` 的判据源），**建议 Phase 3 合并为同一批"真值层收尾"**（两处同文件、同判据链、同回归族，分开做会重复跑 15–25 例回归）。

### 2.b · approval-replay.ts / server.ts 早退 return 零审计口子普查

**grep 普查口径**：approval-replay.ts 全文件 `return` 14 处中**零个**是「拒绝/拦截早退」——三个 `record*Audit` 函数各自 `try{append}catch{warn;return{ok:false}}`（:111-115/:195-199/:532-536）均为 best-effort 出口而非放行口；S-4 两处已修落点实核（server.ts:1075 executeCapability 策略段、:1313 MCP handler 审批路径硬拒绝段）。

**server.ts 侧残留口子分级**：

| 位置 | 形态 | 是否入链 | 判级 |
|---|---|---|---|
| :363 `raise()` no-active-task 早退 | `logger.warn` 有（:352-362，A5 修复产物）、**链上零记录**；且该路径**不落 pendingApprovals**（handler 侧 set 在 :1242 先于桥侧 raise，但被拦审批的 `blocked:approval-required` 条目已入链 ⇒ 委派账本非零） | ❌ | **P1 真口子**：后果可观测——审批静默丢弃时，外部审计者只见 blocked 永无 decision，与「宿主正在考虑」不可区分；危害=审批挂起丢失不可证（A5 类问题复发时链上仍只能靠反证）。修法小：复用 `recordApprovalDecisionAudit`，decision 位新增 `'dropped'` 或复用 rejected+actor `'no-active-task'`，~10 行 + 1 测试组 |
| :1103 `!provider` PROVIDER_UNAVAILABLE 执行段早退 | 仅日志 | ❌ | **P2**：非拒绝语义（执行体未就绪），链上语义属委派壳 `delegation.complete error` 可反证；与 :1161-1177 重放预检 CAPABILITY_NOT_EXPOSED/UNKNOWN_CAPABILITY 同族 |
| :1162/:1171 replay 预检两处早退 | 返回 ok:false 经 `toExecutedResult` 桥接，**无独立链条目** | ❌ | **P2**：同上，理论不可达（令牌必来自注册表），钉测试即可 |
| :445 `!replayEnabled` 早退 | 灰度 off 设计行为 | ❌（不该入链） | ✅ 非口子 |
| :1000/:1613 TTL 超时、mcp-ttl-sweep | `recordDecision` 入链 | ✅ | 已闭合 |

**系统性登记缺口**：`scripts/config-key-lint.mjs:15` 的病灶话术「假安全感」目前**没有任何守卫**枚举「四条审批决策路径 × 是否入链」——S-4 修复靠人肉点名。建议 Phase 3 加一条**白名单式守卫**（仿 phase2-snapshot-truth.test.js:120-161 形态：server.ts 中 `return {.*ok: false` 早退行集 = 登记名单，新增行不在名单即红），把「拒绝路径必入链或显式登记豁免」固化为机检。**这是本维最重要的机制化建议**。

### 2.c · persistent-session.ts 冷启动与 firstCallLatencyMs 口径坑

1. **深度空闲冷启动（口径坑①，半登记）**：服务启动 warmup 成功（server.ts:673 唯一触发点）→ 空闲 TTL 300s（constants.ts:108）`tick()` 回收（persistent-session.ts:953-961，`void this.dispose()` 软释放）→ **无任何再预热机制**（warmup 全仓仅启动期一次；execTurn 重建路径 :682-692 走 `readyTimeoutMs=60s` 短等待）→ 下一委派 init 等待大概率超时（真机冷启动 ≈75–107s > 60s，constants.ts:112/:128 实测注记）→ `unavailable` → **降级单次 `-p` 再付一次全额冷启动**（:811-812 注释自认）。即：24×7 挂机形态下，每个「静默>5min 后的首委派」都是**双份冷启动**。Phase 2 P2-T9 已登记为 K2 遗留留观察数据（phase2-arch-design.md:580「本批只度量不优化」）——**非隐瞒，属已裁未做**。改造选项（Phase 3 裁）：(a) tick 回收后 arm 延迟再预热（改动最小，代价=VM 空闲期偶发冷启 CPU）；(b) 委派入口探测到 `state='stopped' && restarts>0` 时临时放大 init bound 至 warmupReadyMs；(c) 接受+文档化（当前口径）。推荐 (a)。
2. **firstCallLatencyMs 口径坑②（未登记）**：度量点 `runTurn→recordFirstCall`（:634-637 幂等一次性；:220-223 restartFresh 有意不清零）+ 测试钉 D5（phase2-session-unknown.test.js:584）⇒ 语义=「服务生命周期内首个 runTurn 整轮耗时」。**warmup 不经 runTurn ⇒ 采样不到**（钉 D2 :520）⇒ 运维把该键当「首调延迟看板」时，`warmup=true` 的静默服务**永远不出键**，出键时又必是（首次委派 or 深度空闲后首次委派，两者混在一起都表现为"冷"）。文档面核查：INTERFACES.md:299 只写「服务生命周期内首调」，未警示 warmup 不参与采样 ⇒ **补一行口径注记**（P2，文档任务）。**②棒 22:52 校准**：重读 INTERFACES.md:299-300 全文，原文实为"服务生命周期内**首个真实委派轮**的入口→settle 毫秒数，一次性采样；**缺席=尚未发生首调**"——"真实委派轮"四字已隐含排除 warmup、"缺席="语义也已给出 ⇒ **前棒 D-3 与我原报的"文档缺警示"均判重**，实际欠的只是**一句正面话**（"预热成功的服务在首个真实委派到来前该键恒缺席，这是预期而非仪表故障"）。降级为 **P3 文档润色**，不再算坑。
3. **口径坑③（未登记，最尖锐）：空闲回收被计入重建预算**。`restarts = spawnAttempts - 1`（:219/:280）且每次 `ensureReady→spawnOnce` 递增（:426）；`tick()` 回收 `void dispose()` 后 `lastUsedMs` **不复位**（:953-961 路径不清）→ 子进程已死 → 回收条件 :956 `childAlive()` 为假不再重复回收（无风暴），**但**每次深度空闲后的重建都消耗一格 maxRestarts=5（constants.ts:120）→ **约 5 个空闲周期后（无运维介入即 ≈25h 正常使用节奏）会话恒 disabled**，`evaluateDisabledRejection`（delegation-truth.ts:450-455）对常驻启用态的 A2A 委派直接拒 `LLM_SESSION_DISABLED`。设计意图「累计重建上限防 crash-loop」是好的，但把**计划内回收**与**计划外崩溃重建**记在同一张预算表里 = 长期挂机形态自杀。测试钉只覆盖故障注入路径（r19c-kn1-c-session.test.js:187-204），**没有钉住「正常 idle 循环不应耗尽预算」**——属真实缺口（P1）。修法二选一裁断：tick 回收走独立的 `reclaimCount` 不占 restarts；或回收后重置 spawnAttempts 为「连续失败计数」语义。改动 ~15 行 + 1 反例测试。**校准（22:30 复核）**：非"两棒文档均无覆盖"——`CL-018/TECHNICAL-SOLUTION.md:608` 已把两参数并列核查（原文"`idleTtlMs = 300000` 与就绪上限**无耦合**，无需调整；`maxRestarts = 5`（累计）与「每轮重建 ≤1」并存且均已实现，无需调整"），但**该核查只断言二者各自实现正确，从未考察"idle 回收会消耗 maxRestarts 预算"这条交互**；负向 `grep '回收.*maxRestarts|maxRestarts.*idle'` 全 docs/qa 零命中 ⇒ 定性改为「**已核查过相邻事实、漏判了交互项**」，比"完全未登记"更温和但结论不变（P1，因长期挂机形态恒 disabled 是可用性硬损伤，且现网 VM 恰是 24×7 挂机）。

### 2.d · capability.schema.json（D-3）现状与「死配置族」顺扫

**D-3 结论修正（实证，勿再按 backlog 口径立项）**：「缺 appops 且无运行期校验器消费」两条**均已过时**——
- appops 漂移已修：schema `id.pattern`/`domain.enum` 现含 appops（packages/contracts/schemas/capability.schema.json:26/30），提交 `664eff9` 自述；漂移守卫 `checkSchemaDomainDrift`（schema-check.ts:267-296）+ 测试 23 例（phase2-contract-schema.test.js）。
- 「无消费者」已改述：`validateCapabilityShape` 被**测试/门禁面**消费，运行期零接入是用户裁决 **Q1=(b)**（schema-check.ts:13-16 头注、gate.mjs:77-79 登记 contract-schema 进门禁）。SECURITY §3.2 承诺措辞已同步改述。⇒ **此项关闭**，进交付报告时记「backlog 口径滞后于仓库实况」。

**死配置族顺扫结果（新发现为主）**：
1. `audit.snapshot` 声明族：Q2 裁断降级为信息性声明，三侧口径（交付面 schema 校验/运行面零消费/承载面无字段）已文档化（capability.ts:58-73、SECURITY-GOVERNANCE.md:153/409）并由 `phase2-snapshot-truth.test.js` 白名单钉死（消费文件集=12，:120-161）。**已闭环**，但 26 处 `before-after` 标注（definitions.ts）作为「永不兑现的声明数据」保留——裁断已做，无需再动。
2. `policy.approvalTimeoutMs`/`AgentCard.signature`/`commandAllowlist` 均已删（config/index.ts:364-374 删除告警在位）。**已闭环**。
3. **ENV 单源纪律破口（新登记，P2 命名卫生）**：`core/constants.ts` 的 22 个 `ENV_*` 常量自身零裸读 ✅，但 6 个运行期 env 绕过单源在消费者文件内裸读字面量/自带 resolve：`WINVM_ADMIN_ENDPOINT`（server.ts:1790）、`WINVM_HEALTH_PROBE_TIMEOUT_MS`（health-probe.ts:24）、`WINVM_PSBRIDGE_READY_TIMEOUT_MS`（ps-bridge.ts:298）、`WINVM_BEARER_TOKEN`（mcp-registrar.ts:196 + bridge.ts:160 DEFAULT_BEARER_ENV_NAME）、`WINVM_APPOPS_*`/`WINVM_WORKFLOW_*`（ps 侧）。危害面：`config-key-lint` 的白名单派生自 config interface 而非 ENV 面 ⇒ 改名漂移不会红。修法：挪进 constants 并让 lint 加一条「src 内裸 WINVM_* 字面量 ∉ 白名单即红」（~30 行）。
4. **文档态 env 幽灵（P2）**：`WINVM_A2A_REJECT_ON_DISABLED`（kn1-delegation-audit-contract.md:220/504「留接口位」**从未实现**，src 零命中）——文档承诺与实现脱节的登记样本，建议文档划线注记「未实现，仅裁断记录」。
5. `WINVM_VM_HOST/PORT/USER/KEY/PASSWORD`、`WINVM_SERVICE_PORT`、`WINVM_WORKBUDDY_CLI` 等宿主/connector 侧 env 不在本包 constants 单源面（属插件配置面），**不算死配置**，但其中 `WINVM_VM_PASSWORD` 出现在文档 INSTALL-GUIDE/CL-015 与 tunnel-daemon.test——凭据走 env 名而非值，纪律未破。

### 2.e · 同名异物命名冲突治理必要性

1. **`probeError` 双语义**：①契约成员 `SessionHealth.probeError/probeErrorCode`（contracts/bridge.ts:56-64，纯附加，PROBE_NOT_WIRED/TIMEOUT/EXCEPTION 三码，测试 phase2-session-unknown B/C 组钉）；②`HttpGuardView.probeError`（http-guard.ts:236/274-275，回连探针自证失败的**局部形参**，语义=「unverified 归因」）。两者类型不同面、消费者不交叉，**治理必要性：低**——但 ②与 ①的 `PROBE_*` 码族长得像，跨文件检索会串。建议下次触碰 http-guard 时局部改 `innerProbeError`（P2 顺手改，不单独立项）。
2. **`snapshot` 字样守卫面**：一词三义——审计快照（SnapshotPolicy，信息性）、`DelegationTerminalSnapshot`（a2a-framework/server.ts:83 委派终态快照，活消费）、`health snapshot`（persistent-session.ts:283 `snapshot()` 方法、restartFresh 返回）。守卫 `phase2-snapshot-truth.test.js` 用**全仓 src 大小写不敏感 grep + 12 文件白名单**把三义一锅端：**任何**含该字样的新文件（哪怕是第三种无关语义）都会打爆守卫——实锤成本案例：design §13 记录 `delegation-audit.ts:566` 一条**注释含字样**即被迫改措辞。⇒ 守卫是过宽还是必要？我判**形状保留、口径升格**：白名单法误伤的代价是一次改名（已实证可操作），换来「悄悄接上快照消费」必红；真正的问题是守卫文档没把「本名单保护的是第三种语义之外的哪两义」写清——建议名单条目加行尾语义标注（P2，纯文档）。
3. 其余冲突（`reconcile*` 家族四函数名相近：reconcileApprovalWait/reconcileApprovalTruth/reconcileDelegationTruth/reconcileExecutionTruth）：注释互引齐全（delegation-truth.ts:9-20、bridge.ts:1036-1049），且收口顺序有设计理由，**不改名**（改名会打爆 SK-9/D1 系文本钉，负收益）。

> **②棒对"probeError 治理必要性低"的自我修正（22:50，交叉复核棒 3 的 C-2 结论后）**：我原判"两处语义同构、消费者不交叉 ⇒ 治理必要性低"——**命名面结论不变（仍不改名）**，但**活性面我漏判了**。实核：`resolveInnerReconnect` 的**唯一生产调用点**（server.ts:785-788）只传 `{authMode, providerOptions}`，**不含 `probeError`**；`inner-reconnect-probe.ts:24` 注释更明写"fail-closed 判决仍**只按配置面**（`resolveInnerReconnect` 不喂 probeStatus）"——这是有意的判决面/观测面分离（见本文件 3.5-1），但后果是 **http-guard.ts:274-275 那条 `if (view.probeError)` 分支在生产路径不可达**（只有测试构造 view 时才走到）。⇒ 棒 3 C-2 的"死判据"成立，级别按它的 P1；我的处置建议随之改向：**问题不是命名，而是"该分支作为六级判序的第二级，实际永不参与判决"**——修法二选一：①把 probeError 归入观测面并在 `/health` 显形（诚实化，符合 3.5-1 分离纪律）；②在 http-guard 头注里明写"probeError 仅供测试与未来接入，生产判决面不含它"（纯注释，最省）。**推荐 ②**，因为它零风险且防后人误接（若真把探针故障喂进判决面，会把"没测到"洗成"测过且未知"——:783 注释已警告的正是这件事）。

---

## ③ 安全兑现度（增量取证；与 audit-arch.md §3 合并阅读）

### 3.5 · bearer 生效自检的**判决面/观测面分离**三不变量（server.ts:745-860 实证，前棒未展开）

装配段实核出的三条隐式不变量（值得进 §7.6 不变量册）：

1. **判决用静态接线事实，不用运行期探针**：`shouldFailClosedStart` 的输入是 `resolveInnerReconnect` 的**判决面**（由配置 tokenEnv 名 + env 值 + 守卫挂载状态静态推出，http-guard.ts:243-286 六级判序）；listen 后的自环回连探针结论只写 `innerReconnectObserved`（观测面，server.ts:2046-2049）。⇒ 语义后果：**运行期探针失败绝不会把已启动的服务翻成 fail-closed 拒启**（否则"token env 被人事后撤掉"会表现为服务自杀，把可用性问题伪装成安全问题）。这个分离是对的，但代码里只以变量名区分，**无守卫**——Phase 3 若有人"顺手"把 observed 并入判决，属高危改动。建议登记不变量 + 一条 assembly-guard 式纯函数判据（判决面入参集合冻结）。
2. **拒启前无条件先落证据**：`bearer-selfcheck` 条目在 `shouldFailClosedStart` 为真时**先 append 后 return 拒启**（server.ts:843-860），保证"被拒的启动"本身可取证。这是 S-4 纪律在启动面的正确推广，✅ 正面确认（前棒 §3.2 只写了"证据无条件在场"，此处补精确行号）。
3. **回滚位是双刃**：`security.enforceBearerFailClosed` 默认 true（config/index.ts:192 显式写出，注释"使默认即安全成为可 grep 的事实"），但存在 false 一键 ⇒ 现网若历史写过 false，开 enforceBearer 即退化为"放行+告警"。前棒 3.2(b) 的 config-lint 硬前置建议我**支持并加码**：不止 `enforceBearer===true ∧ failClosed!==true ⇒ HARD`，还应包含 **`enforceBearer` 由 false 翻 true 的部署动作必须伴随一次 `/health.security.bearerSelfCheck` 读数确认**（runbook 步骤，非代码）。

### 3.6 · 回环 fail-closed 的**闭环度精确刻画**（补前棒 §3.3）

- 代码不变量面成立：非回环 host **恒 error**、`requireLoopbackBind=false` 只得一条"已失效"warning（config/index.ts:293-306 实核，注释原文"只要这个公理能被一个配置项静默放宽，得到的是『文档说有防护、实际裸 HTTP 零鉴权』的服务"——这是全仓最好的安全叙述之一）。`/health.security.boundLoopback` 读**实测** `server.address()` ⇒ 配置谎报无效。✅
- **残余缺口两处（前棒列了 Origin/Host 头；此处补另一类更实际的）**：
  1. **回环 ≠ 无攻击面**：VM 内的隧道反向端口同样落在 127.0.0.1（宿主侧 localPort 转发进 VM 的 18443），VM 内任意本地进程可直接打 `/mcp` 免鉴权（bearer 默认关）。信任域声明（ARCHITECTURE.md:338"VM 内任意本地进程都在信任域内"）把它裁为可接受——**该裁断我认同，但它在 SECURITY-GOVERNANCE 里是隐含前提而非显式条款**。建议在安全模型节明写"V1 的鉴权豁免建立在『VM 为单租户可信主机』公理上；该公理失效（多用户/共享 VM）时 bearer 从可选变必选"，并把这一条件写进 `enforceBearer` 的 runbook 判据。
  2. **审批令牌的生命周期面**：`pendingApprovals` 表 TTL 扫描 + O-10 在途保护（pending-approvals.ts:182-191/:240/:20）已机制化，且 sweep TTL 与 raise 收口共享去重（server.ts:215/:242 注释）⇒ 无"过期令牌仍可重放"的口子。**但**：令牌内容 = 服务端留存参数（K4/K5 的设计核心是"参数只取服务端"），一旦 `replayEnabled=false`（server.ts:445 早退，灰度位）则批准后**不执行**而链上也无 decision（approved 决策本就裁定不落链，:1571-1574）——这是"灰度位与取证位的耦合"，Phase 3 若长期保持 on 可忽略，若引入按能力灰度则必须让"因开关未重放"显式入链。

### 3.7 · T13 断片形态的**独立复算与前棒同结论、依据不同**（增量证据）

我独立读了 `qa/evidence/audit/analyze.out`/`analyze2.out`，与 ①§3.4"只登记不修"结论一致，但把**成因精确到可验证**：
- entry#512 现场 = **seq=511 出现两次**，且当日两次进程各自以同一链基线续写（04:07 一对 `84293af`/`d4a15885`、07:05 一对 `6ef553a`/`92fe765`）；post-break 的 162 条 `expected prevHash` 恒为 `d4a15885` ⇒ 说明"校验时的文件序"取的是前棒分叉中的一支，另一支的条目在其后被读到 ⇒ 表现为"哈希全对但 prevHash 指错"。
- 关键：**这不是"历史数据不可信"，而是"取号竞态"的化石**。chain.ts:299-303 的 D30 注释自述真机实证"三天分片 672 条恰两处重复 seq：511 与 582"——与我看到的 511 完全对上 ⇒ 写路径已根治（`append` 全程在 `writeQueue` 串行闭包内取号+写盘+回写基线，:303-310/:337-345）。
- 因此 ①§3.4 的"登记路线"成立且**已部分落地**：verifyShardIntraChain 把 seq 单调纳入断裂判定（chain.ts:388-389 注释原文"重复 seq/跳号即使 hash 与 prevHash 自洽也是断链"）⇒ 框架已能识别该形态，**缺的只是 known-broken 清单文件与 /health 聚合文案降级**（B-5 批，前棒已列，采纳）。
- 补一条前棒未提的取证细节：D30 同时引入 `freshChainOnStart:true` + `this.freshShard`（chain.ts:85/:152/:176/:245）⇒ **新链不再续接旧基线**，历史分叉在结构上不可能再污染 activeShards 判定；这意味着 B-5 的"聚合文案降级"其实是纯展示层改动，**风险为零**，可与 B-2 诚实化批合并做。

---

## ④ 可靠性架构（增量：4.5 之后 + 前棒未覆盖的真机取证）

### 4.5+ · psmod 版本漂移的**实证补充**（支撑前棒 R-4，并修正其一处细节）

- 前棒 4.5 的机制描述正确（dot-source 启动期一次性、函数作用域陷阱、单域失败不拖垮 bridge）。我实核到**两条可直接落地的现成挂载点**，把 R-4 的代价从"小-中"降为"小"：
  1. `ps-bridge.ps1` 的 **ping 元能力已回传 `loaded = @($script:LoadedModules.Keys)` 与 `psVersion`/`pid`/`sessionId`**（ps-bridge.ps1:123 区，`Invoke-MetaCapability` 的 `ping` 分支）⇒ 加 `psmodFingerprint` 只是**在该 ordered 字典里多一项**，TS 侧 `health()` 透传即可，零协议改动。这比前棒建议的"启动诊断行挂载点"更稳（诊断行是 stderr 文本，元能力是结构化帧）。
  2. **`MODULE_NOT_PRELOADED` 已是半机制化的漂移探针**（ps-bridge.ps1:100-104：`LoadedModules` 命中即放行，未命中且文件存在 ⇒ 抛 `MODULE_NOT_PRELOADED: 模块 X 未在启动时加载，请重启 ps-bridge`）⇒ **"新增了一个 .ps1 但没重启"这一类漂移已被运行期显式拒绝**（文件级），但**"修改已加载的 .ps1 内容但没重启"完全没有拒绝**（内容级）——这精确划出了 R-4 的真实边界：**漂移风险面只剩"内容改动"，不覆盖"新增文件"**。裁决建议据此收窄：指纹只需覆盖 6 个既有 .ps1 的**内容哈希**，不需要覆盖文件集合（集合面已由 MODULE_NOT_PRELOADED 兜住）。这个区分前棒没有做，直接影响实现范围。
  3. `version: '0.1.0'` 三处硬编码（server.ts:1356/:1483 + package.json:3）我复核确认，且补充一点：**`/.well-known/agent-card.json` 与 `/mcp` 是两个对外契约面**，一旦 Phase 3 升版本，外部 agent 看到的版本可能与实际执行面不一致 ⇒ 前棒 B-1/R-4 的"同源守卫"应**优先于指纹**做（纯构建期比对，零运行期风险）。
- **DEPLOYMENT 侧的既有手工纪律**（前棒未列，属缓解现状）：`docs/changes/CL-018/REQUIREMENT.md:189` 与 `TECHNICAL-SOLUTION.md:256/539` 已明文"改 psmod 必须重启服务 + 改后做『本地↔VM』md5 一致校验（对齐 CL-017 A11/D15）"⇒ 也就是说**md5 校验是写在变更文档里的人工纪律，但脚本化程度为零**（全仓 `md5|createHash` 在 delivery/ 零命中，与前棒 §4.5-3 一致）。这更加说明 R-4 的正确处置是"把已有的人工纪律机器化"，而非新增机制——立项理由因此更强（不是新想法，是欠账）。

### 4.7 · 隧道**真机死因逐条归因**（`~/.workbuddy/winvm/tunnel.log` 只读，前棒未做真机日志取证）

任务书问"今日三死"。实测该日志（456 行）10-12 当日事件序列：

| 时刻 | 事件 | 判读 |
|---|---|---|
| 01:27 | `Keepalive timeout` + `No response` 簇（WARN 级） | L1 指数退避消化成功（1s base / 30s max + 30% jitter），会话随后恢复 ⇒ **非死亡，是抖动** |
| 01:41 | `缺少必填项 vmHost` ×2（ERROR 级） | **真死因 #1：配置缺失**，且属"启动即死"型（不重试、不可自愈）——退避机制对配置类错误是浪费（重试 100 次也不会有 vmHost） |
| 01:43 / 02:35 / 07:40 | 就绪 | 三次成功建立（01:41 之后有人补了配置；07:40 一次来自会话启动钩子） |
| 07:49 | 双条"已有隧道进程 pid 51633，不重复启动" | **pidfile 幂等生效实证**（前棒 R-3/D14 的机制真机成立）；pid 51633 经 `ps` 实测仍存活 |

⇒ **结论与任务书预设不同**：今日并无"三次隧道崩溃"，实况是**一次配置类启动失败 + 一次已自愈的网络抖动 + 正常重启若干次**。架构含义有二：
1. **退避策略缺少"永久性错误快速放弃"分类**：`maxAttempts=Infinity`（oh-tunnel.mjs:170）对瞬断正确，对"vmHost 缺失/密钥不可读/认证永久失败"这类**确定性失败**应当首次即 giveup 并落诊断（当前行为：配置校验在启动前置，所以这条 ERROR 其实是被正确拦下的——**该子项无债**；但"ssh 认证永久失败"仍会走无限重试，浪费且掩盖根因）。建议 Phase 3 观察：若 tunnel.log 出现 `All configured authentication methods failed` 类错误，应归入 permanent ⇒ 立即退出。改造面：错误分类一处（~20 行）。**P2**。
2. **可观测性缺口（比前棒 R-1 更具体的表现）**：01:41 那次 ERROR 之后**没有任何对外暴露**（宿主插件的 `tunnel status` 只在被查询时读 pidfile/state；配置错误的死因只在日志文本里）。⇒ 前棒 R-1"daemon 退出后无人复活"的完整叙述应当是"**退出原因不可达**"：pidfile 消失 + state 派生 DEAD 是可信的，但**为什么死**要人去 tail 日志。建议 B-4 观测性批加一项：state 文件增加 `lastErrorKind`（配置缺失/认证失败/网络穷尽/未捕获异常）四分类枚举（纯附加，写入点集中在现有 giveup/uncaughtException 分支）。

### 4.8 · "同任务严禁双棒"的机制化评估（任务书维④第 3 子项，前棒未覆盖）

- 已核对：`scripts/lock-probe.mjs:1-40` 是**真机锁屏/交互会话前置探针**（GO/BLOCKED/不可达/UNKNOWN 四退出码，只读 GET /health），**不是棒次互斥锁**，不可复用。
- 现状机制盘点：**pidfile（隧道级）✅、端口自清理（服务级）✅、`activeTaskId` 单例 + `bindTask` 归属（审批协调器级）✅、任务计划程序 `RestartOnFailure ×3`（进程级）✅**。⇒ 项目内的"双实例"面已被 pidfile/端口/任务三种锁覆盖；**唯二未覆盖的两个面**是：
  1. **同一 LLM 委派会话被两个调用方并发驱动**：`PersistentCliSession` 是**单实例串行链**（`this.chain` 串行化 runTurn，:1063-1070 dispose 等链排空），所以"双棒同任务"落到会话面表现为**排队而非冲突**——但前棒 ⑥ 未列的这条真机红线值得登记：`docs/changes/phase2-arch-design.md:538` 实录"198 个 working 任务并发 8 `tasks/cancel` ⇒ 每次 requestCancel abort 打断**同一常驻会话**当前轮 ⇒ 重建风暴（attempt2..6）⇒ vm-service 崩溃（0 listeners、**~90 孤儿 node**）"。**这正是任务书维⑥说的 ~90 孤儿事故**：根因不是"缺少树杀"，而是**并发取消把串行会话打成重建风暴**——防护靠的是纪律（"本 provider 禁批量 cancel 排空"），不是机制。⇒ **本维最重要结论**：双棒/并发同类问题在项目里已经真机炸过一次（T7 事故），而现有机制只有"provider 内部禁止"的口头纪律，**没有服务端并发取消的门卫**。取消通路实核定位：`a2a-framework/src/server.ts:467-469 cancelTask() → this.tasks.requestCancel(id)`（task-store.ts:352，ARCH-22 协作式取消信号主干，:115 注记）⇒ 该路径**逐请求即时下发 abort**，没有任何"同一常驻会话上正在重建则合并/排队"的闸——放大机制正是"每次 abort 触发一轮 `killChild`+`ensureReady` 重建"。建议 Phase 3 加一条**会话级取消并发闸**（同一 sessionId 上 in-flight cancel 数上限 = 1，其余合并等待；闸点在 provider 侧 requestCancel→abort 的落点，不在 a2a-framework 侧，以免框架层承载业务语义、违反 dep-lint ③-FRAMEWORK_TO_BUSINESS 铁律）。这条与前棒维⑥ P-系列都不重合，级别我判 **P1**（有真机崩溃实证 + 触发路径清晰 = 满足前棒 §7.1 的 P1 判据）。
  2. **文件总线/工作目录级棒次互斥**（本次审计流程本身遇到的前棒停摆/复活）：属团队协作面，不属产品架构面。我的评估结论：**不值得产品化**（引锁文件=新增陈旧锁清理面，与前棒 R-3"不上分布式锁"的裁决同理）；应在**流程文档**里落"心跳 + 单一写入路径 + stat 互检"三条（本次双棒实战已验证可行：我 6 次 stat 到 audit-arch.md 增长，全程未双写同一文件）。

### 4.9 · 可靠性小结（②棒增量）

| ID | 项 | 等级 | 处置 |
|---|---|---|---|
| **R-5** | 并发取消打挂串行会话（真机 ~90 孤儿实证，现仅口头纪律） | **P1** | 会话级 cancel 并发闸（≤1）+ 回归；并入 B-1 或新批 B-7 |
| R-4' | psmod 内容级漂移无指纹（文件级已由 `MODULE_NOT_PRELOADED` 兜住） | P1（范围收窄，代价降级） | version 同源守卫优先；ping 元能力加 `psmodFingerprint`；md5 纪律机器化 |
| R-1' | 隧道死因不可达（state 只有 DEAD，无原因分类） | P2 | state 加 `lastErrorKind` 四分类 |
| R-6 | 永久性错误走无限退避（认证失败型） | P2 | 错误分类首次 giveup |
| — | 双实例防护（pidfile/端口/任务/activeTaskId 四层） | ✅ 达标 | 机制化不升级（采纳前棒 R-3 裁决） |
| — | 棒次互斥产品化 | ❌ 不立项 | 流程文档三条即可 |

---

## ⑤ 可扩展性（增量：前棒 §5 触点数已实核，此处只补其未覆盖的两条通路 + 单点注册表性价比）

### 5.6 · 前棒未数的两条扩展通路

| 扩展动作 | 触点（实测） | 结论 |
|---|---|---|
| **新增审批/风险语义（risk 级或策略规则）** | ①`contracts/risk.ts` 枚举；②`definitions.ts` 每条 `cap({risk})` 必填（54 条全带）；③`CorePolicyEngine` 规则表（`cfg.policy` 面 + `bypassTagSink` 的 matchedRule 判据，server.ts:579-582）；④审批预览三兄弟 `buildPreview`/`collectImpact`/`deriveUnderlying`（ps 侧 or 注册表侧按域分置）；⑤门禁 `psmod-contract.test.js` 域分布断言 | **4–5 处，跨 TS/PS 双语言**。前棒的"新增能力 2–3 处"是对注册表通路；**风险语义是更隐蔽的第二条通路**，且**无 checklist**。建议并入前棒 5.3 的 `capability-onboarding.test.js` 判据（risk 非默认值时必须同时提供 preview 三件套，否则判红）——这一条能覆盖跨语言漏配，成本 ~40 行测试 |
| **新增宿主侧能力消费（connector skill / MCP 工具集裁剪）** | ①`declareCapabilities()`（provider 侧）；②`delivery/vm-service.config.json` provider options；③`skills/<name>/SKILL.md`（动态枚举，前棒 5.1）；④（若要改工具表对外形态）`mcp-framework` 映射层 | **1–2 处即生效**（`exposedCapabilities = registry.intersectDeclared(...)` 单一事实源，server.ts:652-657）。✅ 裁剪能力面**零代码**，是本项目扩展性最好的一处，建议进 §7.6 不变量册（前棒已列为不变量 1，一致） |

### 5.7 · "单点注册表"性价比裁决（任务书维⑤第 1 子项的直接回答）

前棒 5.1 实测显示能力定义集中在**单文件** `definitions.ts`（54 条同文件）。是否值得引入"分域多文件 + 生成索引"或"配置文件驱动"？**判否**，三条实证理由：
1. `grep -c "cap({"` = 54 的**可 grep 性**是当前守卫（`psmod-contract.test.js:126 EXPECTED_TOTAL` + 域分布断言）的实现基础；拆文件会强制引入索引/聚合层，而聚合层本身需要新守卫防漂移——**净增机制，零增防护**；
2. 单文件的真实痛点是**合并冲突**（同一 PR 加两个能力改同一文件相邻行），但这是团队协作成本、非架构成本，且被"一次只加一个域"的 PR 纪律低成本化解；
3. 文档已漂移到错误路径（前棒 5.2 D-6a：CAPABILITY-MODEL §7 写了不存在的 `powershell/<domain>/` 与 `registry/<domain>.ts`）⇒ **前一次设计意图确实是分域，但实现选择了单文件而文档未回写**。裁决：以实况为准修文档（B-2 批），不回补分域。
- 唯一值得做的机制化是**把"新增能力"的 5 个手工触点中的 3 个变为机检**：①EXPECTED_TOTAL 手改保留（前棒 7.5"手改=有意识确认"我完全认同）；②文档条数==代码条数（新增守卫）；③risk 非默认 ⇒ preview 必填（新增守卫）。

### 5.8 · hermes 预注册 vs workbuddy provider 抽象（任务书维⑤第 2 子项）

- 实况差异根因（采纳前棒 ADR-13 的"不该统一"裁决并补机制面）：hermes 走 **MCP 预注册文件**（`mcp-registrar.ts` 写配置 + token 落 `.env`），workbuddy 走 **provider 动态装载 + 运行期 headers 注入**（`buildMcpConfig` 写 `Bearer ${env}` 名引用）。两者不可统一的原因是**上游 CLI 是否支持运行期 env 注入**，属外部约束。
- 架构代价评估：**provider 抽象已经把它隔离住了**（`adapter-agent-hermes/src/mcp-registrar.ts` 是包内私有细节，`loader.ts` 零特判）——即差异没有泄漏到核心层，扩展性评级仍为"高"。真正的残留风险是**安全面**：`.env` 明文 token 落盘（前棒 3.2(c) / 7.5 已裁决"可接受但须文档显形"）。我补一条机检建议使显形可维护：`config-key-lint` 或新守卫断言"**任何写 token 值到磁盘的代码路径必须位于 adapter-agent-hermes 包内**"（判据=全仓 grep `writeFile.*token|\.env`，白名单=该包），这样"未来第二个 provider 也偷偷明文落盘"会当场判红。成本 ~20 行，**P2**，可与 B-2/B-3 合并。

---

## ⑥ 规模与性能隐忧（增量：任务书三子项实证，前棒 §6 已覆盖者不重述）

### 6.8 · VM 侧 node 孤儿进程防护（任务书维⑥第 1 子项，前棒未独立展开）

- **防护面现状（逐层）**：①常驻会话 `killChild()` 走 `taskkill /T /F` 连树终结 + 先清引用（persistent-session.ts:532-564，注释明说"只 `child.kill()` 会终止 cmd 包装进程，node 孙进程孤儿化——孤儿迟到的事件靠事件门卫拦截"，:441 门卫）；②shutdown 路径补杀真实子进程（:1041 注释"spawnFn 可能已拉起 cmd 包装进程——不留孤儿"）；③会话进程归属 vm-service 进程（:32"服务停即回收，避免孤儿与第二实例"）；④VM 服务启动脚本 `start-hidden.ps1` 端口自清理强杀旧实例 + `finally { Kill }`（install-vm.mjs:270-276）；⑤卸载 `/proc` 签名扫描（uninstall.mjs:282-330，前棒 4.4 已记）；⑥ps-bridge `treeKill`（:1053-1060）。
- **真机证据（防护有效的正面确认，前棒未引用）**：`qa/evidence/cl018-eng/summary.md:356` "重启服务 → `CODEBUDDY_PROCS=0`，无孤儿 node 残留"；`qa/evidence/cl018-qa/REPORT.md:371/398` 两次独立清点 `CODEBUDDY_COUNT=0 / PERSISTENT_CLI_COUNT=0`，且记录"cmd 被杀后 node 孙进程自退（≤15s 有界窗口）"⇒ **正常路径的孤儿防护经真机验证成立**。
- **但历史 ~90 孤儿事故（`docs/r19/t7-evidence.md:126`、`phase2-arch-design.md:538`）不是防护缺失，而是"崩溃即无防护"**：事故形态是 **vm-service 自身崩溃**（0 listeners）⇒ 所有 `killChild`/`finally`/门卫路径**根本没机会执行**（父进程死了，子进程自然成孤儿）。⇒ 真正的残余缺口是**崩溃场景下的孤儿清算**：
  - VM 侧任务计划程序会在 `RestartOnFailure` 下拉起新 vm-service，新服务**不会收编也不会清杀**上一代遗留的 `winvm-persistent` 孤儿（`start-hidden.ps1` 只按端口找持有者，孤儿 CLI 不占 18443）；
  - 现有唯一兜底是**手工/脚本级**：`qa/harness/.restart-svc.ps1:3` "杀端口占用（孤儿 node）"、`qa/probes/start-hidden-vm.ps1:6` 同款；
  - **建议（P2，机制化成本低）**：vm-service 启动期做一次**一次性孤儿清算**——`taskkill /FI "WINDOWTITLE eq winvm-persistent*"` 或按"父 pid 不存在 + 命令行含 `--session-id`"的 PowerShell 过滤器清扫（`Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where ParentProcessId 不存在`）。风险：可能误杀并存的合法第二实例——**但这恰是我们想杀的**（前棒 R-3 已裁"后到者胜"，孤儿无合法并存的正当理由）。改造 ~40 行 + 一条 `/health` 计数透出 `orphanReaped`。**这条与前棒 6.1 P-1（零内存仪表）互补：一个管数量、一个管体量。**
- 结论：**孤儿防护"正常路径达标、崩溃路径靠运气"**。级别 P2（真机已发生过一次，但触发条件是并发取消风暴，已用纪律避开；若采纳 R-5 取消闸则风险进一步收敛）。

### 6.9 · gate 全量档 200 件规模外推（任务书维⑥第 2 子项）

- 前棒 6.5 已给出成本模型（串行逐文件、每文件一次 `node --test`、单文件 timeout 600s）与"--quick 分层是正解"的裁决。**我的增量是给外推数字，供排期判断**：现 92 文件/1889 例，全量档（含 ST4 逐文件）实测口径量级为分钟级；按"每文件一次进程冷启动（~0.4–0.6s node bootstrap）+ 用例时长"线性外推 **200 文件 ⇒ 冷启动项 ≈80–120s 纯固定开销**，用例项按当前 1889→~4000 例增长约 ×2。**⇒ 全量档将从"分钟级"进入"5–10 分钟级"**，仍在可接受带（提交前跑 --quick、合并前跑全量的纪律不需改）。
- **真正的规模风险不是时长而是"逐文件"这个约束的可扩展性**：前棒指出 ST4 禁用 glob 是为绕开 junction `0xC0000005` 崩溃。该崩溃的触发面与 `node_modules` junction 数量正相关（workspace 12 包已是当前形态，Phase 3 若加包，风险面扩大而非缩小）。⇒ 建议登记为**规模红线**：**包数增长（当前 12）比测试文件增长更值得警惕**，每加一包需复跑一次批量 glob 实验确认 0xC0000005 未复发（一条 qa 脚本，零代码成本）。**P2**。
- `dep-lint` 读 dist 的预置要求（任务书维⑥第 3 子项）：实核 dep-lint.mjs 头注 L82-93"dist 字符串字面量陷阱"+`--root <dir>` 支持单测 fixture ⇒ 它**要求被测物必须先 build**；当前由 gate ST1 `tsc -b` 前置消解（前棒 6.6 同结论，采纳）。补一条**环境预置缺口的实际影响**：新环境（或 CI runner）若无 `dist`，`node scripts/dep-lint.mjs` 的行为是**扫不到任何 import 边 ⇒ 静默 0 违规通过**（不是报错）。这正是本仓库最怕的"第四种状态/永绿守卫"（K-10）形态——守卫在缺失产物时看起来全绿。**建议**：dep-lint 开头加一条前置断言"每个包的 `dist/index.js` 必须存在，否则 exit 2 并提示先 `npm run build`"（~10 行）。**P1-lite**（与 B-1 同批做，成本极低，堵的是门禁自身可信度）。

### 6.10 · V-1 待验项的实证结论（前棒 §6.1 留的钩子，我直接验完了）

前棒 P-2 记"满盘时 `appendFile` 失败是否 fail-open 待验（V-1）"。实核：`chain.append()` 的串行队列**单条失败只向调用方抛错、不中断后续写入**（chain.ts:303-310 `run.then(()=>undefined, ()=>undefined)`），`doAppend` 内 `await appendFile` 抛出 ⇒ 基线 `seq/lastHash` **不回写**（:337-345 写盘成功后才回写）⇒ 下一条记录以**同一基线**重新取号，链不会因一次写失败而永久错位。**调用方侧**：`wrapAuditSink`（delegation-audit.ts:758）与三处 `record*Audit`（approval-replay.ts:111-115/:195-199/:532-536）均 `try{...}catch{warn}` ⇒ **业务不因审计写失败被阻断（可用性优先，已裁设计），但会留下"该条目从未落链"的仅日志痕迹**。⇒ 满盘形态：**真 fail-open（取证缺失）但非放行型 fail-open（不制造批准/执行）**，且**链结构在盘恢复后自愈**。
- 残余可改进点（P2，一句话量级）：满盘是**可预期且可显形**的——`/health.audit` 加一项"最近一次 append 失败计数"（sink 内计数器，失败点 :303 的 reject 分支）即把"只在日志里的取证缺失"升级为可见指标。**强烈建议并入 B-4 观测性批**：这是本轮唯一一处"安全取证面静默降级且无任何指标"的形态，比 P-2 的磁盘增长本身更值得先修。

---

## ⑦ 架构裁决（增量：对前棒 §7 清单的修正、新增项与优先级变化）

> 前棒 §7.1 尺子、§7.2 P0 空、§7.3 四条 P1、§7.4 六批、§7.5 永久接受、§7.6 不变量、§7.7 前提纠偏、§7.8 总判——我**总体采纳**，不重复。本节只出**差异**。

### 7.9 · 对前棒 P1 清单的修正

- **D-2（终态拒绝零审计 ×4）**：✅ 采纳并**扩容为 ×5**——本棒新增 `raise()` no-active-task 早退（server.ts:363，见 2.b）。该处与前四处的关键差别：前四处需 degraded/未注册 id 才触发，**raise() 口子在正常审批链上即可触发**（非 A2A 形态 / 任务已结束但审批迟到），是五条里唯一"常态可达"的取证缺失。⇒ **建议把它列为 D-2 家族的第一位修复项**（同批同代价，~10 行 + decision 位新增 `'dropped'`）。
- **R-4（版本/指纹）**：✅ 采纳，范围按 4.5+ 收窄（内容级指纹；文件级已由 `MODULE_NOT_PRELOADED` 兜住），并把"version 同源守卫"排到指纹之前。
- **P-6（E-1 零读数）**：✅ 采纳，追加本棒发现的第二个零读数面：`firstCallLatencyMs` 不仅在 qa/docs 零真机数据，其**采样口径须随读数一并解释**（2.c-②：warmup 不经 runTurn ⇒ 预热成功的静默服务该键恒缺席，属预期而非仪表故障；文档已隐含此义，见 2.c-② 校准，降为 P3 润色）⇒ 读数批必须**在报告里写明"键缺席=无真实委派"这条判读规则**，否则采到的数会被误读为"首调延迟无记录 ⇒ 冷启动已消失"。
- **B-1'（bearer config-lint 前置）**：✅ 采纳，按 3.5-3 加码（runbook 须含 `/health` 读数确认步骤，非纯代码）。

### 7.10 · 本棒新增的 Phase 3 立项项（前棒清单之外）

| ID | 缺陷 | 判据（对齐 §7.1） | 代价 | 验收 | 级别 |
|---|---|---|---|---|---|
| **R-5** | 并发取消打挂同一串行会话（真机实证：198 任务×并发 8 cancel ⇒ 重建风暴 ⇒ vm-service 崩溃 + ~90 孤儿 node） | 触发路径清晰、有历史事故、现仅"provider 禁批量 cancel"口头纪律 | 中（会话级 cancel 并发闸，~30 行） | ①新守卫/单测：同 sessionId 上 in-flight cancel>1 时后到者合并等待；②批量 cancel 压测不再打挂服务（真机） | **P1** |
| **A-1** | idle 回收计入 `maxRestarts` 预算 ⇒ 长期挂机 ≈5 周期后恒 `disabled`（拒绝 A2A 委派 `LLM_SESSION_DISABLED`） | 计划内回收与计划外崩溃共用一张预算表；测试钉只覆盖故障注入路径（r19c-kn1-c-session.test.js:187-204），无 idle 循环反例 | 小（~15 行 + 1 反例测试；方案见 2.c-③） | 反例测试：连续 N 次 idle 回收+重建不进入 disabled；`restartFresh` 语义不变 | **P1** || **G-1** | dep-lint 在 `dist` 缺失时**静默全绿**（永绿守卫形态，违反 K-10） | 新环境/CI 未 build 即跑门禁 ⇒ 依赖方向纪律看似成立 | 极小（前置断言 ~10 行，exit 2） | 删 dist 后跑 dep-lint 必须非零退出并提示 build | **P1-lite** |
| **O-1** | 审计 append 写失败仅日志、无指标（满盘/IO 故障时取证静默降级） | §6.10 实核：结构可自愈但缺失不可见 | 小（sink 计数器 + `/health.audit.appendFailures`） | 注入写失败（只读目录）后 `/health` 可见计数 | P2（并入 B-4） |
| **O-2** | 隧道 state 无死因分类（DEAD 但为何死要 tail 日志） | 4.7 实证 01:41 配置类死亡对外不可达 | 小（`lastErrorKind` 四分类） | `tunnel status` 输出含原因枚举 | P2（并入 B-4） |
| **P-8** | 崩溃场景遗留孤儿 CLI 无启动期清算 | 6.8：防护覆盖正常路径，崩溃路径靠 `RestartOnFailure` 后无人清扫 | 小（一次性 `Get-CimInstance` 过滤 + `orphanReaped` 计数） | 模拟 SIGKILL vm-service → 重启后孤儿数归零且 `/health` 有记录 | P2（并入 B-4） |
| **S-1** | 写 token 明文到盘的路径未机检（hermes `.env` 例外的边界） | 5.8；安全面例外的"防扩大"措施 | 小（grep 白名单守卫 ~20 行） | 在 hermes 包外新增 token 落盘 ⇒ 门禁红 | P2（并入 B-3） |
| **K-1** | 审批"因灰度位未重放"不入链（`replayEnabled=false` + approved 不落链的组合=链上无痕） | 3.6-2；当前默认 on 故非活动风险 | 小 | 仅当引入按能力灰度时必须做；现在**登记为待触发项** | P3 |

### 7.11 · 永久接受清单的本棒追加（对齐前棒 §7.5）

| 项 | 为何接受 |
|---|---|
| 回环即免鉴权（VM 内任意本地进程可打 `/mcp`） | "VM 单租户可信主机"公理成立期间无需 bearer；须按 3.6-1 把公理失效条件写进安全模型条款（文档动作，非代码） |
| `MODULE_NOT_PRELOADED` 之外的 psmod 热更不可能 | PowerShell dot-source 语义决定的硬约束（ps-bridge.ps1:226-233 注释已写透函数作用域陷阱）；只能靠指纹+重启纪律，无法靠机制热更 |
| 审计链写失败不阻断业务（可用性优先） | 已裁设计选择；本棒只做"让降级可见"（O-1），不改判据 |
| 串行 LLM 会话的吞吐天花板（单实例 `this.chain`） | 常驻会话的价值恰在复用上下文，并行化=多进程=冷启动成本重付；Phase 3 若上多会话池另立项，当前接受 |
| 同一文件单测/门禁的 junction 崩溃风险 | 上游 node/Windows junction 问题，非本仓可控；用 `--quick` 档 + 逐文件跑法规避（前棒 6.5 同结论） |

### 7.12 · 建议追加的架构不变量（并入前棒 §7.6 册）

9. **判决面与观测面分离**：fail-closed 启动判据只用静态接线事实，运行期探针只进观测字段（server.ts:745-860），二者不得混用；
10. **计划内回收不占故障预算**：任何"设计内的资源释放/重建"（idle 回收、运维复位）不得计入"异常重建上限"类计数器（A-1 的规范依据）；
11. **门禁在缺失被测物时必须报错而非通过**（G-1 的规范依据，K-10 的门禁自指版本）；
12. **安全例外的边界守卫**：任何"已裁可接受"的安全例外（hermes 明文 token、回环免鉴权）必须配一条防其扩大的白名单守卫（S-1 的规范依据）。

### 7.13 · ②棒一句话总判（与前棒 §7.8 并列，供主理人取舍）

**Phase 2 的 WinVM Bridge 在"机制化防护"上是真材实料（三层退避、pidfile 幂等、跨语言构建期契约、内存态全面有界、bearer fail-closed 六码判序均经代码与真机双重确认），本次审计新发现的四个 P1（并发取消风暴 R-5、idle 回收吃故障预算 A-1、终态拒绝零审计第五处 raise()、dep-lint 无产物静默通过 G-1）全部属于"防护建好了但边界条件没穷举"这一同族缺陷，而非架构缺陷；真正的系统性欠债只有一条：全链路"度量件在场、读数缺席、口径无警示"——Phase 3 的第一优先级应是把手工纪律（md5 校验、禁批量 cancel、shadow 观察期）逐条变成机检与指标，而不是新增功能。**

---

## ⓪-b · 与棒 3（audit-arch3.md，维②–⑤）的重叠与分歧（22:45 补，仅供主理人去重）

棒 3 与我覆盖同一维②③④⑤，交叉点如下（**我不修改他人文件，只在此登记**）：

| 主题 | 棒 3 | 本棒（②） | 处置建议 |
|---|---|---|---|
| 早退零审计口子 | A-2：5 处（含 `raise()` no-active-task = 其第 4 条） | 2.b：同一处 + 普查口径 | **同一缺陷**，合并为一条；棒 3 多出的**第 5 条**（`server.ts:441` 令牌 TTL 抢先 ⇒ 返回 `rejected` 但链上是 `timeout`，归因错位）本棒未覆盖，**建议采纳为独立项**（比我的四处危害更细，属"两侧口径不一致"） |
| 审批真值/措辞 | 未做（其维②聚焦可达性与取消/进度链） | 2.a + 对 D-1 的复核 | 无冲突，本棒独有 |
| 取消链 | "扎实，两处小口子"（逐请求路径正确性） | 4.8 **R-5（P1）**：并发取消把串行会话打成重建风暴（真机 ~90 孤儿实证） | **两者不矛盾且必须并列**：棒 3 审的是**单笔取消的语义正确性**（我复核其证据链成立），本棒审的是**并发取消的资源放大**（证据源不同：`phase2-arch-design.md:538` 事故实录）。⇒ 合并时把两条并列写，不要以后者推翻前者 |
| `probeError` 语义 | C-2（P1）：同名异义 + `InnerReconnectView.probeError` 是**死判据** | 2.e：判"治理必要性低、不重命名" | **实质分歧，需主理人裁决**：若棒 3 的"死判据"（写了但无消费者）成立，则我的"语义同构非冲突"只覆盖了命名面、未覆盖活性面——两条可并存（不重命名 + 判据活性另立），建议按棒 3 的活性结论升 P1，我的命名结论保留为"不改名" |
| psmod 版本漂移 | 未做（棒 3 止于维⑤前半） | 4.5+：范围收窄 + 两个现成挂载点 | 本棒独有 |
| 隧道可靠性 | 未做 | 4.7 真机日志归因 + R-1'/R-6 | 本棒独有 |
| 孤儿/规模/gate | 未做 | 6.8/6.9/6.10 | 本棒独有 |

---

## 附 · 交付物与合并说明

- 本文件：`/storage/Users/currentUser/wbtmp/audit-arch2.md`（②棒全量：⓪差分登记 + ②③④⑤⑥⑦）
- 前棒：`/storage/Users/currentUser/wbtmp/audit-arch.md`（①棒全量：①②③④⑤⑥⑦，21:33 起复活并持续写入，我全程未触碰该文件）
- **合并建议顺序**：`audit-arch.md` 作主干（它含维①且已成篇），本文件按节次**并入对应维度尾部**——
  - ②：本文件 2.a/2.b/2.c/2.d/2.e 接在 D-1~D-6 之后，其中 **raise() 零审计口子（2.b 表首行）**与 **A-1（2.c-③）**为唯一新增缺陷项；两处自我修订见 ⓪节末段（坑①降 P2、`probeIntervalMs` 销案）。
  - ③：本文件 3.5–3.7 接 §3.4 之后。
  - ④：本文件 4.5+/4.7/4.8/4.9 接 §4.6 之后（4.5+ 是对 §4.5 的范围收窄修正，合并时以 4.5+ 为准）。
  - ⑤：本文件 5.6–5.8 接 §5.5 之后。
  - ⑥：本文件 6.8–6.10 接 §6.7 之后（6.10 销掉 §6.1 的 V-1 待验钩子）。
  - ⑦：本文件 7.9–7.13 接 §7.8 之后（7.9 修正 §7.3 P1 清单，7.10 为本棒新增立项项，7.12 追加 §7.6 不变量）。
- 心跳：`/storage/Users/currentUser/wbtmp/audit-arch2-timeline.log`

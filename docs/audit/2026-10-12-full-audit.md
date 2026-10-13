# WinVM Bridge 全面体检终版报告（2026-10-12）

> 主理人齐活林（Qi）· 交付总监 汇编。审计编制=七棒三域（PM×2 / 架构×3 / QA×2），全部只读；
> 本报告为唯一权威终版，七份原始报告全文归档于 `docs/audit/2026-10-12-audit-raw/`，
> 逐条结论均可回溯到原始报告与主理人亲验锚点（附录B）。

---

## 0. TL;DR

项目**门禁之内极稳、门禁入口与门禁之外缺可验证性**。离线基线 92 文件 / 1889 例全绿、守卫基建四件套真实生效；但对外承诺面存在 4 个 P0（审批闭环不可达、部署首步断裂、失实承诺族——含"最小权限双闸写而未接线"、真机验证断供 18 天），承诺兑现与代码实况之间缺少一根"诚实性"守卫。完善路径给出 7 个批次（批0–批6），以"文档止血→装得上→停得下→批得准→生产生态→验证面恢复→深债"为用户价值主轴，两处排期分歧已由主理人终裁。

---

## 1. 审计编制与方法

| 棒 | 交付物（归档后路径） | 体量 | 结局 |
|---|---|---|---|
| PM 前棒（许清楚） | `raw/audit-pm.md` ①–⑧（含 Phase3 批次候选表） | 76KB | 唯一权威产品主干，已撤 |
| PM 接力棒 pm2 | `raw/audit-pm2.md` §2/§8×2/§9/§10 | 55.8KB | 交叉验证+对抗复核附件，已撤 |
| 架构前棒（高见远） | `raw/audit-arch.md` 维①–⑦+裁决 | 88.5KB | 架构主干，已撤 |
| 架构接力棒 arch2 | `raw/audit-arch2.md` 维②–⑦差分 | 59.2KB | 交叉验证附件，已撤 |
| 架构接力棒 arch3 | `raw/audit-arch3.md` **四维全量版（维②③④⑤+E-1..E-5 双通道对等/provider 抽象）** | 88KB | 熔断判停后**复活完赛**（首例），全维收录；23:08 残版已被 00:39 全量版替换归档 |
| QA 前棒（严过关） | `raw/audit-qa.md` ①–⑫+汇总 | 72.9KB | 测试/运维/文档主干，已撤 |
| QA 接力棒 qa2 | `raw/audit-qa2.md` ⑥–⑫差分+勘误节 | 41.4KB | 交叉验证附件，已撤 |

**方法三支柱**：
1. **双棒/三棒独立复现**——三个维度全部出现"前棒 completed 后复活续写 + 接力棒并行"，经"分文件不合并、交叉互证"处置后转化为可信度加权：P0-1 审批断裂获三棒独立复现；"仓库≠分发真相源"获三棒+VM 侧只读实证；preflight 失实靠对抗核查揪出。
2. **主理人亲验关**——成员每条进入台账的断言，均经我 `git grep`/`sed`/`node` 实测抽验（附录B 代表性 30+ 锚点）；两处成员断言被我推翻或改判（见 §5 改判记录）。
3. **双尺子口径对账**——产品维按"承诺-兑现断裂"定级；架构维按"正在发生 ∧ 无人工规避手段"取证定级（其结论 P0=空）。**两把尺子并存收录，不强行归一**；架构棒另交回两条"升级触发器"（§4）。

**审计基线**：REPO@13b8705；七棒对 REPO 零写入（工作树既存 14 项脏文件属团队作业与自动化遗留，与审计无关；卫生项见 P2 族）。

---

## 2. 三大结构性结论（多棒独立交叉命中）

### 结论一：仓库 ≠ 分发真相源
宿主插件缓存 `~/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0/` 才是运行态真相源，但分发链零防呆：
- `widget.html` git 全史零命中，运行态却存在（审批卡原生渲染 CL-021 依赖它）；
- `install-host.mjs` 零哈希校验（`createHash` grep=0），本次 cmp 全 SAME 属侥幸；
- 版本三处硬编码 `0.1.0` 零守卫；psmod/version 零产物指纹（R-4）——改 psmod/*.ps1 必须重启 VM 服务这条铁律没有任何机制兜底，漂移静默不可见。

### 结论二：门禁面极强，真实世界验证面极弱
- 门禁五段（tsc→dep-lint→config-keys→守卫件→逐文件 sweep）真实生效、fail-loud（dep-lint DIST_MISSING→exit2→gate UNJUDGED→RED 全链我亲验）；
- 但最后一次**全量真机 E2E=run7（2026-09-24）**，其后 59 批提交/98 文件（含 psmod 三批）零真机回归；1889 例全绿与"VM 里能不能装个软件"之间没有一根线；psmod-contract 守卫自述零 spawn，只证命名一致性；e2e/smoke 16 例与 delivery/__tests__ 8 例是"从未被任何门禁跑到"的沉默孤儿。

### 结论三：高纪律、低索引
26 条 K-x 执行留痕充分（"写了未执行"仅 2 条），但**入口文档不参与任何门禁 ⇒ 最先腐化**：`.dev` 断供、ARCHITECTURE 分层三源矛盾、K5 状态行停更 13 天、11 条审批卡死链污染宿主+VM 双侧运行态、session-guard/Origin/最小权限双闸三处失实承诺。失实承诺家族（宣称有→代码零实现）是同一根因：**没有"宣称-实现一致性"守卫**；"写了没接"在实现面同样成族（wsProbe/两 size getter/C-1 三判据/E-1 双闸四例——arch3 对旧审计"dead-config 已闭环"判"不完全成立"，经我 grep 复核坐实）。

---

## 3. 统一分级台账

### 3.1 P0（4 项，终版唯一口径）

| # | 条目 | 口径 | 证据锚点（主理人亲验） | 出路 |
|---|---|---|---|---|
| **P0-1** | **审批闭环不可达**：L2/L3 能力"宿主批准→续跑"在生产路径无入口 | PM 承诺尺（PM+pm2+arch3 三棒独立复现） | 唯一置位点 `vm-service/server.ts:424`（raise 批准分支）；`raise` 生产调用点全仓唯一 `bridge.ts:1232`（maybeResume）=自引用闭环缺外部入口（全仓 `raise(` 仅 3 命中：契约:588/实现:345/调用:1232，arch3 复核）；`approval.reply` 仅走 `/a2a`（a2a-framework/server.ts:301→task-store.ts:550）⇒**纯 MCP 直调无任何宿主可达置批路径**；tests 无闭环用例；**arch3 独家机理**：批准即删 token（`server.ts:464`"无论成功失败都无条件删除"）⇒缺省灰度 on 下 `__approvalId` 续跑为**事实死字段**，而 **四处文档仍在承诺**（INTERFACES.md:212、winvm-mcp-reference:213、server.ts:1213 inputSchema、:1361 instructions）；K5 文档 :67/:91 自相矛盾 | 批1，出路 **(c) 策略化**（主理人终裁，见 §6），硬前置=maxRisk 接线（P1-M2）同一 CL；四处承诺文案随批0 一并订正 |
| **P0-2** | **prepare-vm 部署断点**：新用户从零到能操作 VM 在准备步断裂 | PM 承诺尺 | `raw/audit-pm.md` §4 DB-1..12 部署断点清单（其中"VM 内 codebuddy 未预检"一条经 pm2 勘误+我亲验修正为：安装性已覆盖 `preflight.mjs:119-195` checkLocalVmDeps 三项 blocking + `install-vm.mjs:643-652` 运行期硬门禁；**缺的是登录态/可用性探测**） | 批2（主理人终裁前置批1，见 §6） |
| **P0-3** | **失实承诺族**：对外文档宣称的安全/能力无实现支撑 | PM 承诺尺（QA ⑪、arch③、arch3 维⑤ 交叉命中） | ①session-guard：`ARCHITECTURE.md:71/276-278` 宣称 tscon/自动登录/禁休眠，代码零命中（grep 词边界精确化后零；首轮 tsconfig 命中系子串假阳）——且 `docs/audit/2026-10-08` A-14 旧账在册=**旧账未清+后续复宣**；②Origin 校验：`SECURITY-GOVERNANCE.md:38` 宣称"HTTPS+bearer+Origin 校验（HTTP 模式）"，vm-service/host-a2a-bridge 源码零命中（我 23:4x 亲验）；③**最小权限双闸写而未接线（E-1，arch3 独家、七棒安全语义最重）**：`allowedCapabilities`+`maxRisk` 宿主可填（tools.ts:368/373/400-430）、框架透传不判、三处生产 `policy.evaluate` 实参均不含两键、`engine.ts:603-615/759` 两闸**唯一喂入者=测试**（policy.test.js:239/273）——而 5 处文档写成安全机制（SECURITY-GOVERNANCE:53、SPEC-SKILLS:124-125、DEPLOYMENT:279、INTERFACES:195-196、SCENARIOS:144/210）；我 grep 独立复核一致。**arch3 补遗收窄（F-1，我亲验 :265-270 vs :509-513）**：`allowedCapabilities` 并非全链零消费者——非流式 `handleSend` 路径装配 GoalRequest 时透传、且 **deterministic provider 白名单过滤真实在跑**（adapter index.ts:755-756）；失实点收窄为 **maxRisk 生产零消费+流式路径连装配都缺（两路不对称遗漏）**+审批卡不呈现白名单（E-4）。批1 接线处方据此修正=流式路径补装配+VM 侧两键进 evaluate 实参；provider 白名单已有先例可循。整改面 2→**4 处**（pm2 §9② 补 `gui SKILL:32` tscon 配方行、`approval-card.md:33/60/142` 用户照做文案） | **批0 文案诚实化 + 批1 接线补齐（同一 CL 两副面孔，"诚实化 vs 补齐"合并专项——arch3 主张采纳）**；session-guard 实现侧包级立项降 P2（powercfg 三行+文档已够，pm2 改档采纳） |
| **P0-4** | **真机验证断供 18 天**：离线全绿与真实链路健康之间无线 | QA 取证尺 | run7=09-24 后 59 批提交/98 文件、psmod 3 批零真证；T4 三条真机遗留零闭合、T7 曲线未产；CL-017"18/18"不可引用为现状；smoke/e2e 不在门禁枚举面 | 批5 验证面恢复 + **新纪律：每批收官必跑真机子集回归**（写入验收判据） |

**架构尺口径声明（保留原文）**：架构棒（前棒+arch2）按"正在发生 ∧ 影响安全承诺/审计可信/服务可用 ∧ 无人工规避手段"三条尺裁**维⑦ P0=空**，附升级触发器（§3.4）。与 PM 尺 P0×4 并存不矛盾——分属承诺兑现面与故障现场面，本台账按条目合并标注。

### 3.2 P1（32 项，按六维分组）

**产品/交互维**
| # | 条目 | 锚点 |
|---|---|---|
| M1 | 直调取消被吞：`notifications/cancelled` 三 case 合并 `return null` | `mcp-framework/server.ts:177-180`（我亲验）；修复零新契约单文件 ⇒ 速赢并入批3 |
| M2 | **maxRisk 封顶未接线=死代码**："自报了也不生效"（pm2 §9③，我代码面独立坐实：全仓生产 `policy.evaluate` 恰 3 处调用点 `server.ts:1060/:1229`、`adapter:295`，入参全部不传 maxRisk；`engine.ts:759` 封顶分支永不可达；goal.maxRisk 只落审计条目 :1387/:1450 与步骤展示字段）| P0-1 出路(c) 硬前置，同一 CL；HOST-A2A §4.2"最小权限"话术同步订正（失实承诺族+1） |
| M3 | 生产就绪包 3a 最小修（**P0→P1 改档采纳**：README:3/44 亲读=能力域承诺非开箱成品；直调 cli.invoke 可用且 CLI_NOT_FOUND 命中 mcp-reference:89 已教处置=可路由；预检选型应改 `app.inventory.list`——前棒选的 `appops.state.query` 探不到未装 CLI） | 批4 |
| M4 | 审计查询面：README"可审计"头条卖点 vs `/audit/receipt`（`vm-service/server.ts:1576` 已建）**零消费者零桥接**（P2→P1 采纳，成本=包装） | 批3 |
| M5 | NEW-UX 族（SKILL 教做不到的动作，参数/枚举层；工具名层经 pm2 穷举=**零例**正面结论）：NEW-UX-01 双 skill 教 `appops.cli.invoke`(powershell) 而 enum 无 powershell 恒 INVALID_PARAMS（`storage-manager:143`/`app-manager:100` vs `definitions.ts:381` 我亲验）；健康门 `available==count` 在 degraded 恒不成立⇒**Agent 永久自锁**（`orchestrator:140` vs `server.ts:1983/651-657` 我亲验）；`gui:188`"需先恢复会话"幻影动作；S-2 approval-card 四处同窗口；S-3 dryRun 泛化句双口径；S-5 取消教学缺失 | 批0（文案）+批3（健康门降级路径） |
| M6 | 挂载 4 写侧（回收站清空/解压/快捷方式写/更新管理；差集交叉验证：psmod 90 函数 vs definitions 绑定 53，真未挂载成品恰 3+第 4 条文档低报，**无第 5 条遗漏**）与 7 份 SKILL 缺 `meta.capability.list` 声明（**文档债，与幻觉指引分列**） | 批4 |
| M7 | provider 差集不显形：`agent.provider` 切换后能力面坍缩无提示；hermes 机制在但未接线（B 级）；USER-MANUAL 需重写 | 批4 |
| M8 | 审批卡 TTL 槽 + 直调拒绝回执（POLICY_DENIED 已有审计 S-4，但用户侧无回执） | 批3 |

**架构/实现维**
| # | 条目 | 锚点 |
|---|---|---|
| A2-1 | D-2/D-2⁺ 终态拒绝零审计（5 处：raise no-active-task 首位 + PROVIDER_UNAVAILABLE×2/CAPABILITY_NOT_EXPOSED/UNKNOWN_CAPABILITY；arch3 A-2 并入同条，含 `:441` "决议 true→token 消失→报 rejected 而链上 timeout 归因错"新发现） | 升级触发器 T-1；批1 顺带 |
| A2-2 | R-5 并发取消风暴：真机实证 198 任务×并发 8 cancel ⇒ vm-service 崩溃+~90 孤儿 node，**目前仅口头纪律无门禁** | **已裁 B（§7-2）：不等触发器，批5 直接立项"取消风暴门禁化"**（限流+串行化判据，lock-probe 同族） |
| A2-3 | A-1 idle 回收吃 maxRestarts 预算：`spawnOnce` 无条件 `spawnAttempts+=1`（persistent-session.ts:426），idle 软释放（:956-960 dispose 不清计数）⇒挂机长跑恒 disabled，仅 `POST /admin/llm-session/reset` 手工可解（我逐行亲验） | 批5；修复=idle 来源重建不计入故障预算（或窗口化） |
| A2-4 | R-4 版本零指纹：psBridge 只有 uptime 无版本字段，改 psmod 不重启静默失效（arch3 D-3：psmod 变更不重启即不生效+启动期加载失败永久化+ping 不点名失败模块） | 批2 |
| A2-5 | ps-bridge 自愈窗口快速失败且文案失实（"自愈失败"实为在途，lastError 残值冒充现因；arch3 D-2） | 批5 |
| A2-6 | 重放不 settle ⇒ token+去重项永久驻留且无信号（arch3 D-5：依赖"重放有界"这一未证明前提） | 批5（豁免二次上限+外层超时+/health.approvals 读数） |
| A2-7 | SSE 客户端断开后 500ms 空转永不停止+优雅关闭不摘连接（arch3 D-6） | 批5 |
| A2-8 | P-6/E-1 度量落地零真机读数——"没有读数就没有修的权利" | 批5（与 P0-4 同批互锁） |
| A2-9 | B-1' enforceBearer 缺 config-lint 硬前置（双条件齐误开 ⇒ 委派零副作用虚假完成，R4 在册根治=B3 实测） | 批6 |
| A2-10 | N-1 expandEnvPath 6 份实现，仅 constants.ts:31 走权威通路 ⇒ 默认 Windows 模板值在 POSIX 宿主创建 `%LOCALAPPDATA%/`+`C:/` 垃圾目录（项目快照两目录仍在互证）；处置=import 用起来而非删幽灵声明 | 批6 |
| A2-11 | wsProbe 死配置：`persistent-session.ts:93` 定义+tick 消费，全仓生产注入点零命中（我亲验）⇒工作集护栏永不生效 | 批6（接线或显式删除） |
| A2-12 | C-1 GUI 门禁判据三函数零消费：`guiAllowed/nonGuiAllowed/describeSessionState` 导出后全仓 src 零调用点（我亲验，命中仅注释/再导出/文档）；真实门禁 adapter index.ts:325-336 把**探测未知误归"确不可用"** | 批3（判据接线+未知态语义） |
| A2-13 | C-2 probeError **死判据活性面**（自 P2 命名族上移）：`InnerReconnectView.probeError/probeStatus` 零生产喂入（server.ts:785 只传两键、:2066 覆盖不回灌，注释承诺从未发生的回填）——inner-reconnect-probe.ts:24 注释自证判决面只按配置面 | 批6（接线或删除判据） |
| A2-14 | D-1 审计链分片**全仓零保留期实现**：chain.ts:337-339 只增不减，verifyArchive 是限数校验非回收，docs/04-ops 零 retention 条文 | 批5（保留期方案属产品裁定，见 §7 第4项） |
| A2-15 | E-2 缺省 provider `step()` 恒传 `approved:false`（index.ts:498 + config/index.ts:167）⇒A2A 委派遇 L2/L3 **既不执行也不挂起**（MCP 半区 server.ts:1238-1303 完好）；方向 fail-closed+默认全 L0/L1 不触闸 ⇒ **主理人裁维持 P1 不升**（arch3 自请考虑升 P0 的口径我驳回，与 P0-1 爆炸半径实测同据） | 批1 顺带（与审批闭环同域） |
| A2-16 | E-3 hermes 掉档根因=**SPI 无 capability-negotiation**（三家 declareCapabilities() 逐字相同、approvalCoordinator 可选注入无对外表达面、hermes 不传 probe/taskId/maxRisk 且 health 不透 approvalTruth）；`--yolo` 只是表象——provider 分级 B- 的机理性解释 | 批4（SPI 协商面，与差集显形同批） |
| A2-17 | **ARCH-09 旧账未清**（2026-10-08 旧审计在册）：previewHash 服务端恒 `''`、"预览≠执行"比对从未实现（server.ts:250/1187 注释自证"预留供 ARCH-09 批次复用"），两侧数据物理上永不相遇+host 侧仅进程内 Map | 批6（**已裁 A 补建**：两侧数据打通+哈希绑定；批0 文档按"绑定在建"措辞） |
| A2-19 | **F-1 主用通道静默丢弃**：`allowedCapabilities` 客户端两路都发（a2a-framework/client.ts:106/:144 亲验含此键），但服务端**流式路径 `handleStream` 装配 GoalRequest 只解析 maxRisk/timeoutMs 不解析 allowedCapabilities**（server.ts:509-518 vs 非流式 :261-272 亲验对比）⇒ 宿主工具 schema 里"本次允许的能力范围"在缺省主用通道（message/stream, tools.ts:444）上**从未抵达 VM**，即使按 E-1 修法接线也接不上 ⇒ **E-1/批1 落地的硬前置**（两处 goal 装配应共抽一函数防再漂移） | 批1（前置项） |
| A2-18 | **F-2 回填路径物理不可达**：常驻形态（缺省启用）`prepareMcpConfig` 不传 delegationId（bridge.ts:1115/:1399 两处亲验），`__mcp__` 会话级共享 ⇒ 服务端 ctx.delegationId 缺席 ⇒ 真值归因退化到 R3 时间窗，叠加 E-5 收窄虚设 ⇒ 并发委派/直调存在**串台改判窗口**；"按 dtid 回填 scope"类修法在最常用形态下不成立，须服务端按 taskId/会话键留存 scope | 批1（与双闸接线同域，回填机制是审批闭环的归因地基） |

**测试/运维维**
| # | 条目 | 锚点 |
|---|---|---|
| Q1 | 隧道启动失败不重试+三型死法（僵尸转发/缺参即退/pid 回收+state 撒谎）+同毫秒双写并发实例竞态；runbook 未成文（前棒裁 P0，**主理人改裁 P1**，判据：有 HOURLY watchdog 自动化+手工复活配方存在=人工规避手段在） | 批2 |
| Q2 | 守卫三瑕疵：snapshot-truth 白名单可被解构绕过（永红风险面）、config-key-lint 缺 target 文件静默跳过不判红、s5 样板 1 恒真 | 批5 |
| Q3 | 孤儿测试接线：e2e/smoke 16 例+delivery/__tests__ 8 例沉默；README 基线查法 `sort|tail -1` 返过期 t9（**基线倒挂实验**：sort 与 ls -1t 双失效，机理=mtime 被 checkout 重置）⇒查法改 `sort -V` 或权威源=qa/ 最新 sweep-result | 批5 |
| Q4 | 11 条审批卡死链污染宿主 connector+VM shared-skills 双侧运行态；CL-016"唯一模板 6/6 引用"承诺破功；无链接可达性守卫（新守卫候选） | 批2 |
| Q5 | winget 无 `/T` 树杀（超时后孤儿子进程） | 批2 |

**文档维**：J-1..J-7 漂移族（分层三源矛盾/K5:3 状态行停更 13 天/CAPABILITY-MODEL §7 路径漂移/overview 双概览）+ GATE-POLICY:98 静态"17 例"违自家 K-18 ⇒ 全部并入批0 文档止血。

### 3.3 P2 族（16 项，登记不展开）
D-3 capability.schema.json 缺 appops 且全仓无运行期校验器消费（additionalProperties:false 零兑现）｜SessionHealth 无法表达"未知"态｜dep-lint"缺包 vs 缺 dist"形态差（meta=null 静默 continue 不触发 DIST_MISSING；消费方应查 `!==0` 非 `===1`）——**G-1 主案被驳回后的残余窄面**｜cfg-* 已 tracked ⇒ .gitignore 无效，改 fixture/tmpdir｜238 个 tests/*.log 夹具归档规则化｜凭据面 P2×3（扫描合格，加分项留档）｜`.workbuddy/**` 与仓库根 `v3-kn2.*`/`commit_msg*` 卫生项入 .gitignore 或移出（14 项脏文件噪声削弱 git status 判据可执行性）｜K3 兜底启发式根治（bridge 直读 MCP 结构化结果）+reconcileApprovalWait 直接单测｜预热 idle 回收后深度空闲首调冷启动（K2 只覆盖重启后）｜C-3 `ExecutedResult.error?: string` 裸串抹码+两处旁路 makeError（server.ts:1109/1299）｜C-5 `/health` 缺 approvals 观测块+两 size getter 死代码（同病未同治对照 ENG-08）｜E-5 K3R R3 能力过滤喂全平台目录⇒收窄虚设（**旧审计"K3 残余只在措辞面"被 arch3 判为有活性残余**）｜D-4' 隧道 maxAttempts 默认 Infinity=待决旧账（tunnel-crash-fix-progress.md:153 明写"主理人裁定"从未裁——我此裁：维持 Infinity 但在配置注释显式化缺省语义）｜restartFresh 口径坑延伸（ps-bridge restarts 单调无窗口且无对应运维复位端点，arch3 同族延伸）｜**F-3 接线安全性**：框架恒注入 maxRisk（缺省 L1 最严档），直连 evaluate=当场把全部 L2/L3 委派默认拒绝，"修安全承诺"顺手做成"可用性断崖"——接线必须区分"宿主声明 vs 服务端默认"（maxRiskSource 标记或未声明传 undefined）+灰度位（批1 处方内置，防以修复名义引入新 P0）｜**F-5 展示面语义混用**：LLM provider 两处合成步骤 `risk: input.maxRisk ?? 'L2'`（bridge.ts:1526/1825）把"委派上限"冒充"该步骤实际风险"，与 :98-105 注释宣称的"步骤 risk 如实化"相悖——应取 cap.risk 服务端权威值（批4 或批1 顺带）。

### 3.4 升级触发器（在册机制，两棒共认）
- **T-1**：D-2 终态拒绝零审计 ⇒ 若 degraded 常态化（有实例进入 degraded 且无自动恢复），即升 P0；
- **T-2**：R-5 并发取消风暴 ⇒ ~~再发生一次即升 P0~~ **2026-10-13 用户终裁：此被动触发器作废，直接随批5 门禁化（§7-2=B）**。

---

## 4. 交叉验证与改判记录（主理人终裁留痕）

| 原判断 | 终裁 | 依据 |
|---|---|---|
| pm2 候选 P0"伪造 maxRisk 逃逸审批" | **推翻→P1（M2，定性反转为"自报了也不生效"）** | req.risk 恒服务端权威（server.ts:1063/1097/1118 `risk: cap.risk`）；封顶只紧不松（engine.ts:759）；未知值 fail-closed（node 实测 `riskAtLeast('L9','L2')=false`）；真缺陷方向相反=封顶未接线 |
| PM 前棒"生产就绪 100% 必空转" P0 | **降 P1（M3）** | pm2 §9① 三实证+我亲读 README:3/44 与 mcp-reference:89；WORKFLOW_NOT_FOUND 三源形态订正（appops.ps1:433 恰证机制活） |
| PM 前棒"preflight 未覆盖 VM 内 codebuddy 已装" | **勘误改述** | checkLocalVmDeps:119-195 三项 blocking+install-vm.mjs:643-652 运行期硬门禁存在；真实缺口=登录态探测 |
| QA 前棒⑥ 隧道 P0 | **改裁 P1（Q1）** | 人工规避手段在（watchdog 自动化+复活配方），不满足 arch 尺"无人工规避" |
| arch2 G-1"dep-lint 无 dist 静默全绿" | **驳回，残余窄面降 P2** | dep-lint:347→exit2→gate UNJUDGED→RED 全链 fail-loud，双通路亲验 |
| arch3 自请"若按缺省配置功能断裂口径 E-2 可升 P0" | **驳回，维持 P1** | 默认 provider 全 L0/L1 永不触闸（PM 风险分布实测+我复核），默认形态不发生，方向 fail-closed |
| 我对 arch3 的 41 分钟熔断判停+"缺维⑤由棒1/棒2 兜底" | **判停≠死亡：arch3 00:39 复活完赛，维⑤全量独立成稿转为主干**；缺口判定作废，归档替换 | 88KB 四维全量版落盘+八项式回报；教训第 6 条登记 |
| arch2"38 分钟零心跳判死"/qa 前棒"completed 无回报" | **复活误判登记** | 磁盘实况=持续心跳/五连增长；教训：判活双源（timeline+产物 mtime），熔断线 20 分钟执行但停摆≠死亡 |

---

## 5. 过程教训登记（供 Phase 3 团队协作沿用）
1. **同任务严禁双进程并发**第三次复现（pm2 foreign §8=自己前一轮迟到落盘；署名"续棒第二轮"实为双实例竞写）——"宣布零落盘"后延迟补落会伪装成第三方写入；处置=分文件互证不合并、所有权注记、主理人合并。
2. **LLM 成员长静默写作期与致死窗口外观同形**（arch3 两次 41 分钟零落盘）——唯一解药是任务书内置"每文件/半节即落盘心跳"；判活优先看双 timeline+git status 差异。
3. **跨棒信息一律经主理人中转**（pm2 直发前棒 maxRisk 硬事实，违反协议且可能唤醒已撤棒）——不追责，登记。
4. **成员"更严重新发现"必须过主理人反证关才能进台账**（P0 攻防两例）——本报告 §4 即反证留痕。
5. **失实承诺家族是系统性根因**（session-guard/Origin/最小权限双闸三例同族+arch3 判词"危害不在故障率而在使用者据以做安全假设"）——Phase 3 立项文档增加"**前序裁决时效性复核**"环节（arch 前棒元结论采纳：任务书 5 处前提过时；arch3 实证一例=旧审计 §3.2-1"maxRisk 只 A2A 侧传"前提今天两侧都不再传，登记为"旧账失效+升级新 P0"而非重复报旧账）。
6. **判停≠死亡第四次复现且本次为"撤棒令后复活完赛"**：arch3 被 23:51 熔断撤棒后 00:39 交付 88KB 全量四维版（含独家最重发现 E-1）——熔断处置的"缺维兜底"判定须设计为可撤销（本次兜底声明即时作废、归档替换、台账增补，成本可控）；对复活棒的产出**全量收录不追责**，其纪律自证（八项式+局限声明四条）反而是全部七棒中格式最完备的一份。

---

## 6. 完善路径：Phase 3 批次（合并版，主理人终裁）

骨架=PM §8 批0–5 × Arch B-1–6 合并；**两处 PM 留给主理人的分歧已终裁**：
- **终裁1**：批2（部署可达）**前置**批1（审批闭环）——首日必撞（"装不上"）优先于非首日必撞（默认 provider 全 L0/L1 永不触闸，L2=7/L3=1 深水区）；批0 与批2 文件零交叠可并行。
- **终裁2**：批1 出路取 **(c) 策略化**（>(b)>(a)）；**maxRisk 接线为硬前置、同一 CL**（M2：出路(c) 依赖封顶真实生效）。

| 批 | 内容 | 台账映射 | 改动面 | 可证伪验收 |
|---|---|---|---|---|
| **批0 文档止血** | 失实承诺诚实化 **9 处**（session-guard/Origin/gui:32/approval-card×3/INTERFACES:212/mcp-reference:213+inputSchema:1213+instructions:1361 四处续跑承诺）+**E-1 五处最小权限话术改口**（SECURITY-GOVERNANCE:53/SPEC-SKILLS:124-125/DEPLOYMENT:279/INTERFACES:195-196/SCENARIOS:144·210）+K5:3 状态行+分层三源统一+CAPABILITY-MODEL §7+GATE-POLICY:98+基线查法 sort -V+SKILL 三处 powershell 教学订正 | P0-3、M5（文案半）、J-1..7 | ~10 文件 | 词边界 grep 宣称项=命中实现或文档改口；`docs-link-reachability`+`SKILL 点分 token∈注册 id∪白名单` 两新守卫（候选，派生式，pm2 提出）进门禁 |
| **批2 部署可达** | prepare-vm 修复+preflight 登录态探测+R-4 版本指纹（/health 增 psmod hash+service build）+install-host 哈希防呆+Q4 死链清理+Q5 winget /T+隧道启动重试+runbook 成文 | P0-2、A2-4、Q1、Q4、Q5 | ~11 文件 | 全新宿主一键到"可枚举能力"零手工；psmod 改后 /health 指纹变化可见 |
| **批3 速赢交互包** | M1 取消接通（单文件）+M4 receipt 桥接+M8 审批卡 TTL 槽/拒绝回执+健康门 degraded 降级路径+A2-12 GUI 判据接线（未知态≠确不可用） | M1、M4、M8、M5（健康门）、A2-12 | ~15 文件 | 直调取消端到端 cancelled=true；degraded 下 Agent 有可执行的降级指引非自锁；guiAllowed 出现生产调用点 |
| **批1 审批闭环** | 出路(c) 策略化+maxRisk **与 allowedCapabilities 双闸**接线（三调用点补传+端到端用例）+A2-1 早退审计顺带+E-2 缺省 step approved:false 挂起语义对齐 | **P0-1**、M2、A2-1、A2-15 | ~8-12 文件 | L2 能力直调批准→续跑闭环测试用例存在且绿；maxRisk:L1 委派下 L2 步 POLICY_DENIED 实锤；allowed 白名单外能力 DENY 实锤 |
| **批4 生产生态** | M6 挂载 4 写侧+M3 3a 最小修（预检改 app.inventory.list）+M7 provider 差集显形/hermes 接线或显形（A2-16 SPI 协商面为其根因处方）+USER-MANUAL | M3、M6、M7、A2-16 | ~12-14 文件 | workflow 模板实体≥1 真机跑通；切换 provider 能力差集有回执字段；declareCapabilities 差异真实可表达 |
| **批5 验证面恢复** | P0-4 真机 E2E 回归批（5域×2通道最小 18 例重跑+T4 三条闭合+T7 曲线）+Q2 守卫三修+Q3 孤儿接线+A2-3/A2-5/A2-6/A2-7 长跑四债+A2-2 取消风暴门禁化+A2-8 度量读数（**注：此 A2-8=P-6/E-1 度量，非 arch3 E-1**）+A2-14 保留期落地（**已裁：90 天 ∧ 总量 <2GB 双标准，超限删最老，处理方式=删除**）+T13 防再发（§7-1=A：历史只登记；新增链写分叉防护/verifyArchive 扩展 prevHash 连续性判据，确保不再出现存档指向错乱） | P0-4、A2-2/3/5/6/7/8/14、Q2、Q3 | ~8-10 文件+qa 证据 | **每批收官必跑真机子集**新纪律生效；real-test 命名合规（K-18）；磁盘占用有 retention 上限 |
| **批6 深债** | A2-9 bearer 自检+config-lint 硬前置+A2-10 expandEnvPath 统一+A2-11 wsProbe 接线或删除+A2-13 probeError 死判据接线或删除+**A2-17 ARCH-09 previewHash 比对补建或裁"承诺降级"改口**+D-3 schema 裁断（接入运行期校验或删除）+P2 族清扫（C-3 裸串抹码/C-5 approvals 观测块/E-5 收窄实装） | A2-9/10/11/13/17、D-3、P2 族 | 按需 | dep-lint 消费 schema 或 schema 删除；单实现 expandEnvPath 全仓唯一；死判据清零 |

**依赖主线**：批0 ∥ 批2 → 批3 → 批1（M2 同 CL）→ 批4 → 批5（真机面全程互锁）→ 批6。立项文档首节=「前序裁决时效性复核」。

---

## 7. 待用户裁断（5 项）——**2026-10-13 已全部终裁**

| # | 事项 | 用户终裁 | 落地批次 |
|---|---|---|---|
| 1 | T13 审计断片 | **A 销账**：历史只登记不修复；**确保今后不再出现存档指向错乱**（写路径加并发分叉防护+verifyArchive 判据扩展 prevHash 链连续性） | 登记随批5；防再发（链写入串行化/分叉检测告警）入批5 子项 |
| 2 | R-5 取消风暴 | **B 主动排期**：不等触发器 T-2，直接随批5 门禁化（限流+串行化判据，lock-probe 同族） | 批5 |
| 3 | teams 45 非 winvm 残骸 | **不动**：非 winvm 项目数据遗留一律不触碰 | —（触发器 T-2 作废保留于 winvm 自身域） |
| 4 | 审计链保留期 | **双标准**：90 天 **且** 总大小 <2GB，超限时删除最老数据；处理方式=删除 | 批5（A2-14 retention 落地按此参数实现） |
| 5 | ARCH-09 previewHash | **A 补建**：预览↔执行哈希绑定打通（两侧数据通路+绑定校验） | 批6（A2-17 由"或改口"改判为补建；批0 文档随之写"绑定在建"而非降级） |

**Phase 3 启动令（同批下达）**：批0（文档止血）∥ 批2（装得上）双轨开工。

---

## 附录A：证据归档清单
目录 `docs/audit/2026-10-12-audit-raw/`（本报告相对路径简称 `raw/` = 该目录）：audit-pm.md / audit-pm2.md / audit-arch.md / audit-arch2.md / audit-arch3.md / audit-qa.md / audit-qa2.md + 7 份 timeline（-timeline.txt，循例避 .gitignore `*.log`）。

## 附录B：主理人亲验锚点（代表性摘录，全部只读实测）
- 审批链：server.ts:400-466（置位/删 token 原文）、:1229（放行闸 approved 判定）、bridge.ts:1232 唯一 raise 调用点；
- 策略引擎：engine.ts:740-775（maxRisk 注释原文+D11 双条件 supportsDryRun∧dryRun）、defaults.ts:136 defaultMaxRisk:'L1'、risk.ts RISK_ORDER+riskAtLeast 全文+`node wbtmp/risk-l9-test.mjs` 实测 fail-closed；三 evaluate 调用点入参清单逐读（:1060/:1229/adapter:295 全裸 maxRisk）；goal.maxRisk 去向=仅审计条目 :1387/:1450；
- 注册表面：definitions.ts risk 计数 L0:27/L1:19/L2:7/L3:1（实测复核一致）、supportsDryRun 真 5 条（:41 系 grep 指引注释）、cli.invoke app enum 无 powershell（:381）、meta.* 三注册 :94/:107/:118；
- 取消面：mcp-framework/server.ts:177-180 三 case return null；TUNNEL_UNAVAILABLE 五处发射 tools.ts:419/577/659/711/765；
- 文档宣称面：ARCHITECTURE.md:71/276-278（session-guard 零实现，tsconfig 假阳排除）、SECURITY-GOVERNANCE.md:38（Origin 零实现）、README:3/44（"可审计"）、orchestrator:140/137、storage-manager:143、app-manager:100、gui:188/32；
- 长跑面：persistent-session.ts:341-347/:426/:956-960/:988-1004（A-1 全链）、wsProbe 注入点全仓零命中；
- 门禁面：dep-lint.mjs:347-365/:560、gate.mjs:321/:505/:521（G-1 驳回链）；
- 部署面：preflight.mjs:119-195、install-vm.mjs:643-652、appops.ps1:384/:433（WORKFLOW_NOT_FOUND 三形态）；
- 分发面：install-host createHash=0、widget.html git 全史零命中（成员取证+我 git grep 复核）、版本 0.1.0 三处硬编码。

*（本报告由七棒 ~360KB 原始取证汇编，任何条目如需全文证据，按附录A 路径回溯。）*

---

## 8. Phase 3 执行状态（截至 2026-10-13 · 主理人跟踪，不改 §3 原始判定）

> 本节为落地进度跟踪；原始判定=历史取证件不动。每批收官更新对应行。权威细节见各批 notes（`docs/changes/phase3-b*-notes.md`）与 git log。

| 批次 | 状态 | 关键提交 | 覆盖台账项 | 剩余 |
|---|---|---|---|---|
| 批0 文档止血 | ✅ 完赛+QA 回归过 | `f568427` | **P0-3** 全族诚实化（session-guard/Origin/E-1 话术）、M5 文案、J-1..7 漂移、E-1 五处文档话术改口 | — |
| 批2 部署可达 | ✅ 完赛+QA 回归过 | `235d7a0` | **P0-2**（DB-1..12 一键前置，手工 6→2）、A2-4 R-4 版本指纹全链、Q1 隧道自愈、Q4 死链脚本、Q5 树杀 | 真机 V1-V13（psmod 生效须 kill-restart） |
| 批3 速赢交互包 | ✅ 完赛 | `2bfaf95` | M1 notifications/cancelled 主动取消接通、M4 audit.receipt 桥、M8 TTL 槽、A2-12 GUI 三判据接线+probeError 归因分流 | — |
| 批5-1 保留期+防分叉 | ✅ 完赛 | `6f350de` | A2-14（90天∧<2GB 五安全红线）、T13 防再发（写路径串行锁死+跨片接链回归） | Q2 守卫三修、A2-5/6/7 长跑债 |
| 批5-2 R-5+A2-3 | ✅ 完赛 | `da4abc4` | R-5 取消风暴门禁化（用户 B）、A2-3 idle 回收不占故障预算（判别性测试） | Q3 孤儿接线、真机 E2E |
| 批4 M7 provider 差集 | ✅ 完赛（离线面） | `0fc388e` | M7（/health.capabilitiesProfile 派生+install-vm 横幅+SKILL 对照表，三面同源）、A2-16 | M3 预检改 app.inventory.list、M6 三成品绑定 → 阻塞于真机窗口 |
| 批6 A2-10 expandEnvPath | ✅ 完赛 | `e72c1d8` | 包内 src 单源化（hermes 幽灵声明边转真实，dep-lint info 11→10 铁证） | A2-9/A2-11/A2-17/D-3（待后续批6 项） |
| QA 独立回归（启动批） | ✅ IS_PASS=YES | `ed07434` | 新基线 99/1945 重锚、六发现 D-1~D-6 全裁处（含 D-3 补 ST3 双写、D-5 活锁 kill-0） | 批3/5 全量重锚 105/1993（`d09caab`）→ **批4/6 收官重锚 106/1999（1997 pass/0 fail/2 skip，gate-b46-full.txt，VERDICT GREEN）** |

**P0 收敛态势**：P0-2 ✅ / P0-3 ✅ / P0-1（审批闭环，待批1）/ P0-4（真机断供，待真机窗口）。**永久纪律**（用户追加，§7-③）：`~/.workbuddy/teams` 非 winvm 域任何批次不得触碰。

**⚠ 真机窗口 BLOCKED（2026-10-13 18:1x 复核）**：隧道 daemon pid 4357 存活（DEGRADED/reconnecting），但 VM `172.16.100.2` 网络层不可达（ping 100% 丢包 + ssh Host is unreachable）= **VM 已关机/掉线**，无法从鸿蒙沙箱内启动。待用户拉起 VM 后一并执行：批2 psmod/ps-bridge 新逻辑生效（kill-restart 一次→psmod-drift 转 PASS+fingerprint 非空）、批4 M3 预检改 `app.inventory.list`、批4 M6 三成品绑定+参数运行期验证+54 计数三处同步、批5 真机 E2E（5域×2通道 18 例）+ V1-V13 清单。离线可验证项已全部交付完毕。

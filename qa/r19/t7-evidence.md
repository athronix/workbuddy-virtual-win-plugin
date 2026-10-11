# P2-T7 真机长会话驱逐观测窗口 · 证据（L1 / QA §4-B4 闭环）

日期：2026-10-11（VM = User@172.16.100.2，服务 = C:\WinVMBridge，18443 回环）
配置：**全程默认 200/1h**（`maxTasks=200 / terminalTtlMs=3600000`），未打任何配置补丁，
未改 `vm-service.runtime.json` / `start-hidden.ps1` / `task.xml`（三哈希见 §复原对账，BYTE_IDENTICAL）。

版本指纹：部署后 `/health.tasks` 出现新键 ⇒ VM 实跑本任务版本：
`{"live":0,"maxTasks":200,"terminalTtlMs":3600000,"evictedCount":0}`

---

## 0. 真机前置发现（设计假定修正，非实现缺陷）

任务书/设计假定「filler 零能力 ⇒ 快速 `failed` 终态」。**实测不成立**：
provider=`workbuddy` 是 LLM **常驻会话**，它把 filler 文案当普通话直接答完 ⇒
`submitted→working`（队列串行消化，实测 **≈5s/任务**）→ **`completed`**（非 failed）。
在飞洪水期没有任何终态候选 ⇒ 双闸门不动 ⇒ `live` 越 `maxTasks` 而 `evictedCount` 恒 0。
这正是 **R5（活动任务永不被逐）+ O-11（驱逐只由 create 尾部触发）** 的设计自洽表现。

- 取证：`p2t7-fill-result.json`（`sent` 240 条 `state` 全 `working`、`summary.evictedCountEnd=0`）
- 收敛实测：`p2t7-t7-converge-result.json`（5 个 filler：`+6s` 全 working → `+22s` 全 `completed`；
  `tasks` 全程 `evictedCount=0`；step 记录 `capabilityId=appops.workflow.run / risk=L0`，
  由常驻会话纯文本自规划，**无系统能力执行**）

由此本窗口的构造手法改为：**低并发慢投 + 自然收口**（绝不批量 cancel，见 §4 事故）。

---

## 1. overflow 闸门实证

### 1a. 本任务慢投轮 `qa/r19/t7-overflow-round.mjs`（280 任务 / 30 一波 / 波间 settle 轮询）
`/health.tasks.evictedCount` 增长曲线（`p2t7-t7-round-result.json` → `curve`）：

| 相位 | sent | live | evictedCount |
|---|---|---|---|
| boot | 0 | 5 | 0 |
| wave-3-sent | 90 | — | — |
| wave-3-settled | 90 | 208 | **123** |
| wave-4-sent | 120 | 241 | 124 |
| wave-5-sent | 150 | 251 | **184** |
| wave-7-settled | 210 | 238 | 257 |
| wave-8-sent | 240 | 232 | **293** |
| 终局 | 280 | 224 | **341** |

- `summary.curveMonotonic = true`（计数单调不减）
- `summary.overflowGateFired = true`
- `summary.chainValid = true`（自发条目未破坏审计链）
- `summary.threeValuesDefault = true`

> 注：曲线**含**同期第二个观测轮的贡献，故 evictedCount 的绝对值不等于我的投递数（341 > 280−200=141）；
> 闸门「被打出来」这一事实与单调性不受影响。§1b 给出单轮自洽的严格同尺对账。

### 1b. 突发轮 `qa/r19/t7-burst.mjs`（P1 慢投 280 → P2 攒候选 → P3 单条大突发 → P4 阶梯 → P5 归因）
`p2t7-t7-burst-result.json` → `SUMMARY`（逐字）：

```
aborted=false · overflowGateTriggeredInP1=true · p1FinalEvicted=129
P3: evicted 341->366 (Δ25)，live 224->200 (Δ-24)，live<=maxTasks ✔，
    burstCollapsedToOneChainEntry=true   ← 微任务突发合并：一次 create 的 25 条逐出净新增恰 1 条链上条目
闸门分布 gates: entries=142, ttl=0, overflow=372, maxBatch=63, sumCounted=372, shapeOk=142
链上求和 vs /health 同尺: chainSumCounted=372 == healthEvictedCount=372 → equal=true
evictedCountMonotonic=true · evictedCountFinal=372 · liveFinalWithinMax=true
ringWrapped=true（驱逐总量 372 > 环形容量 64）
gates.ttl=0（本轮未触发 TTL，符合默认 1h 的构造）⇒ 闸门可分（gate 字段真值）
chainEntryShapeAllInternal=true（principal.channel=internal / cap=meta.audit.chain / risk=L0 / rule=internal:task-evicted）
tasksHealthKeys=["live","maxTasks","terminalTtlMs","evictedCount"]
authTriple="loopback-only/not-mounted/unverified"（观测全程三值默认）
chainValid=true
```

`maxBatch=63` 是单批逐出规模的上界读数（受当次候选数决定）；**环形有界性**本身的实证是 §2 的
C1/C2 对照（同一条真实被逐 id，窗口内给 `evicted:true`、滑出容量 64 的窗口后诚实退回旧形状），
离线侧由 `phase2-task-store-evict-observe.test.js` ①b/②f 组钉死。

---

## 2. 被逐 id 归因形态（链上真值基准，只读）`qa/r19/t7-attribution.mjs`

为何用链上真值：两轮共用同一 TaskStore ⇒ 「victim = 我的创建序前 N 名」会被第三方 id 污染
（`p2t7-t7-round-result.json` 中该预言式切片 `inWindowEvictedTrue=0/5`，属**预言构造失效**，非归因失效；
同文件里 `outWindowHonestFalse=3/3`、`neverLegacyShape=1/1` 均正确）。
链上条目自带 `ext.evict.sampleTaskIds`（框架写入的真实被逐 id）⇒ 以其为基准与并发负载无关。

`p2t7-t7-attribution-result.json` → `VERDICT`（逐字）：

```json
{"c1AllEvictedTrue":true, "c1DataKeysExact":true, "c2HonestFalse":true,
 "c3LegacyShape":true, "c4LiveHasResult":true,
 "evictedKeyPresentInHealth":true, "chainValid":true, "threeValuesDefault":true}
```

四形态现场记录（逐字一条）：

- **C1 环窗口内被逐 id** ⇒ `error.data={"code":"TaskNotFoundError","evicted":true}`（键集恰 `code,evicted`）
  `id=7da00e4b-e34a-49b9-9544-22cc54e1797d`，message=`任务不存在或不可访问：<id>`（文本逐字未变）
- **C2 环窗口外被逐 id** ⇒ `error.data={"code":"TaskNotFoundError"}`（**无 `evicted` 键**，诚实退回旧形状）
  `id=28a822a0-…`（该 id 确实是被逐出的真实任务——收敛探测第一个，早于容量 64 的环窗口）
- **C3 从未存在 id** ⇒ 同 C2 形状，`dataKeys="code"`，`errorCode=-32602`（既有错误体逐字节不变）
- **C4 存活 working id** ×2 ⇒ `hasResult=true, state="working"`（「活动任务永不被逐」反证）

⇒ **归因可分（C1 vs C2/C3）+ 窗口外诚实（不因新键而误报）+ 旧客户端零破坏**，三条同时成立。

链上条目形态抽样（分片扫描，节选）：

```
seq=1034 ts=04:08:26.634Z ch=internal cap=meta.audit.chain risk=L0 rule=internal:task-evicted
       count=21 ttl=0 overflow=21 total=341 samples=10
seq=1196 ts=04:11:05.011Z … count=1 ttl=0 overflow=1 total=369 samples=1
```
`total` 与 `/health.tasks.evictedCount` 同尺单调（341→366→367→368→369→370→372），零 `ttl` 误标。

---

## 3. `/health` 新键透出（交付面③实测）

`tasks` 块键序：`live, maxTasks, terminalTtlMs, evictedCount`（新键**末位纯附加**，
既有三键顺序与取值逐字不变）；观测期间读数见 §1 表。`audit.entries` 随链上条目增长（1092→1245），
`audit.chainValid` **全程 true**（自发条目走原始 `audit` sink，O-7 审计自证未破）。

---

## 4. 事故与纪律修正（范围外发现，已落 timeline step7-C）

`tasks/cancel` 批量排空（198 个 working，并发 8）⇒ 每次 `requestCancel` 的 abort 打断
**同一个 LLM 常驻会话**当前轮 ⇒ 服务日志出现「重建 attempt2…6 / restarts:5 / 会话已停用」
⇒ **vm-service 崩溃**（`HTTP=000`、18443 无监听、~90 个孤儿 node.exe 常驻会话进程）。

- 根因归属：**T3 取消通路 × workbuddy provider 的交互放大**（每个取消都要求会话中断+重建），
  **与 T7 无关**（T7 只在 `create()` 尾部追加只读观测面，不触取消/会话通路）。
- 恢复：`taskkill /IM node.exe /F` 清孤儿 + `schtasks /Run /TN WinVMBridge.Service` 拉起
  → `/health` 恢复、三值默认、`tasks` 归零、新键在场。
- **纪律修正（写入本证据）**：本 provider 上**禁止批量 cancel 排空**；长会话观测一律
  「低并发慢投 + 自然收口 + 只读轮询」。已把该护栏写进 `t7-overflow-round.mjs`（无 cancel 通路）
  与 burst 轮（连续 health 超时熔断 + `psBridge.pending` 负载上限）。

另一范围外观察：`t7-drain-observe.mjs` 的 `tasks/cancel` 单条耗时可达 **3.4s**（会话重建代价），
30s fetch 超时会被打穿 —— 若将来要做取消 SLA，需单独立项（不在 T7 面）。

---

## 5. 复原对账

- `qa/r19` 手法：`powershell -File C:/WinVMBridge/kill-restart.ps1`
  （`owner_before=8812 → kill → schtasks /Run → owner_after_run=5812`，psbridge 子进程随新服务起）
- **三哈希 BYTE_IDENTICAL**（`certutil -hashfile … SHA256`）：

  | 文件 | 基线（step0b 现场取） | 复原后 |
  |---|---|---|
  | `vm-service.runtime.json` | `f61dd89f9d558ef6b82dbeee35348eb5e21691c7e507db52cf103046c0b36d4e` | 同 |
  | `start-hidden.ps1` | `801038bc95a21b6eb49596ebdab3e1ca43b30f3996247689f30359215ba55179` | 同 |
  | `task.xml` | `90fee7a47ea610411311795f2c447b8dc848d87254d490f6cbf7ebd024d42832` | 同 |

  （部署链 `deploy-vm.mjs --apply` 重写这三文件后哈希即与基线一致，说明分发内容幂等；
  本窗口**未**做任何临时配置补丁，故无 restore 环节。）
- `/health` **三值回默认实测**：`authMode="loopback-only"` ·
  `bearerSelfCheck.code="not-mounted"` · `innerReconnect.status="unverified"` ✔
- `tasks={"live":0,"maxTasks":200,"terminalTtlMs":3600000,"evictedCount":0}`（新键在场，计数归零）✔
- `audit.chainValid=true` ✔；`node.exe` 进程数 7（服务 + ps-bridge + 常驻会话等本体进程，洪水残留已清）

---

## 6. TTL 闸门：本轮**未做**真机 TTL 轮（裁断，理由如下）

1. 默认 `terminalTtlMs=3600000` ⇒ 真机触发需驻留 >1h 或在窗口内临时改配置。
   改配置 = 污染态 + 额外 patch/restore 风险面，与「三哈希 BYTE_IDENTICAL」的复原纪律对撞；
2. TTL 分支的可观测性（`gate:'ttl'` 归因、计数、落链分布）**已由单测覆盖**：
   `tests/unit/phase2-task-store-evict-observe.test.js` ①c 组用 1ms TTL 直接打 TTL 闸门并断言
   `gate==='ttl'`、`ttlCount` 分布与 `overflowCount=0`；
3. 真机侧已反向实证「闸门可分」：burst 轮 `gates.ttl=0 / overflow=372`（构造上只有 overflow 发生，
   框架如实只标 overflow，**没有误标**），这正是 gate 字段真实性的现场证据。
⇒ 综合裁断：不做 TTL 轮，把风险留给 QA 长跑窗口（如需，改 `terminalTtlMs` 到分钟级 + 本证据同法复跑即可）。

---

## 7. 脚本与产物清单

| 件 | 用途 |
|---|---|
| `qa/r19/t7-fill.mjs` | 首轮 240 任务慢投（发现 working 滞留事实） |
| `qa/r19/t7-converge-probe.mjs` | 5 任务自然收口时序（≈5s/任务 → completed） |
| `qa/r19/t7-drain-observe.mjs` | 排空版尝试（**触发 §4 事故后废弃其 cancel 通路**，保留作反例） |
| `qa/r19/t7-overflow-round.mjs` | 主观测轮（无 cancel，自然收口 + 真值预言 + 归因） |
| `qa/r19/t7-burst.mjs` | 突发合并 / 阶梯 / 同尺对账轮（含熔断与负载护栏） |
| `qa/r19/t7-attribution.mjs` | 链上真值归因四形态探针（纯只读） |
| `qa/r19/t7-chain-readback.mjs` | 链上条目读回（形态 + 分片链连续性抽查） |

VM 侧产物：`C:\WinVMBridge\t7-{fill,converge,round,burst,attribution}-result.json`、`t7-burst.log`
宿主留档：`~/wbtmp/p2t7-t7-*.json`、`p2t7-t7-burst.log`、`p2t7-timeline.log`

---

## 8. 本窗口**终局**复原对账（burst 轮收口后现场重取，`qa/r19/t7-reconcile.ps1` → `t7-reconcile.txt`）

§5 是主观测轮后的对账；本节是**整窗口结束时**的终局对账（在 burst 轮 + 一次负载清理之后现场重取，
不与 §5 互相替代）。取法：`Get-FileHash -Algorithm SHA256`（小写归一），与 step0b 基线前缀逐位比对。

| 文件 | step0b 基线（现场取） | 终局重取 | 判定 |
|---|---|---|---|
| `vm-service.runtime.json` | `f61dd89f9d558ef6b82dbeee35348eb5e21691c7e507db52cf103046c0b36d4e` | 同（4606B） | **BYTE_IDENTICAL** |
| `start-hidden.ps1` | `801038bc95a21b6eb49596ebdab3e1ca43b30f3996247689f30359215ba55179` | 同（1312B） | **BYTE_IDENTICAL** |
| `task.xml` | `90fee7a47ea610411311795f2c447b8dc848d87254d490f6cbf7ebd024d42832` | 同（4332B） | **BYTE_IDENTICAL** |

`.generated` 目录清点（同次输出留档）：`start-hidden.ps1`(+`.bak-p2t5/.bak-p2t6`)、`task.xml`、
`vm-service.runtime.json`(+`.bak-on/.bak-p2t5/.bak-p2t6`) ⇒ **T7 未生成/未改动任何配置面文件**，
备份件均为 T5/T6 遗留；任务书里提到的 `start-hidden.vbs` 在本 VM 上**不存在**（实体是 `.ps1`，
已按实况对账，见 timeline step7-C）。

终局 `/health`（同次 curl，`curl_rc=0`）：

```
tasks   = {"live":0,"maxTasks":200,"terminalTtlMs":3600000,"evictedCount":0}
三值     = authMode="loopback-only" · bearerSelfCheck.code="not-mounted" · innerReconnect.status="unverified"
audit   = {"entries":2,"chainValid":true,"shardsTotal":83,"shardsArchived":82}   ← 新会话从创世重新计数
provider= workbuddy / ready
```

⇒ **三值回默认实测通过、`tasks` 全键回默认态（新键在场、计数归零）、链有效性保持**。

## 9. 负载事故二则与护栏（范围外发现补记，均已落 timeline）

1. **脱管双重投递**：首轮用 `ssh "… node … &"` 启动填充器，Git Bash 下该后台进程**不随 ssh 断开而终止**
   ⇒ orphan 轮 + 后续同步轮叠加成 **480 个并发委派**（设计值 240 的两倍），随后 VM 出现
   `fork: retry: Resource temporarily unavailable` / `0xC000012D`，`/health` 6s 无响应。
   处置：`qa/r19/t7-recover.ps1`（node 进程普查 → 父进程已亡的孤儿逐个 `taskkill /T /F` →
   `schtasks /End` + `/Run` → 端口轮询 60s → `/health` 复测）⇒ 服务 PID=560 恢复监听，
   `node.exe` 由 44 降至 5，`tasks` 归零。留档 `t7-recover.txt`。
   **纪律修正**：VM 侧长任务一律 `ssh` 前台同步执行（或经 `.ps1` + `Start-Process`），
   禁止裸 `&` 脱管；已在 burst 轮内置**连续 3 次 `/health` 超时熔断** + `psBridge.pending>20`
   连续三次即停投退避。
2. **Git Bash 吞 schtasks 开关**：`kill-restart.ps1` 经 ssh 直调时，`schtasks /Run /TN …` 的
   `/Run`、`/TN` 被 Git Bash 当作路径转换（报错 `C:/Program Files/Git/Query`）⇒ 脚本"成功"退出
   但服务**没被拉起**。处置：所有含 `/FLAG` 的原生命令必须经
   `powershell -NoProfile -Command "…"` 包裹调用（`t7-recover.ps1` 即为此而写）。
   这条与 T7 代码无关，属远端执行环境陷阱，建议写入 QA 手册。

以上两则都不是 T7 变更引入（T7 只在 `create()` 尾部挂只读观测面 + 一条自发审计条目），
但都发生在 T7 窗口内，如实登记并已在脚本层加固。

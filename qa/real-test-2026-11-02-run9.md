# run9 验证报告 · SWEEP 实弹取证轮（V1.4.15 · deploy.prompt v3.0.5 + undeploy.prompt v2.4）

- 轮次定位：run8（YES-with-nits，干净现场）的脏场景补验——任务 #13 部署前注入诱饵，本轮（#14/#15）取证 I-6.16 签名清扫实弹行为
- 执行分工：A=software-qa-engineer-4（拆除+脏注入，18:30 交付 rc=0 19/19）；B/C=software-qa-engineer-3（本人，重装+SWEEP 取证+报告）
- 关键结果先行：**部署流程一次过全绿（Step0→6 零重跑），但 SWEEP 实弹取证揭示 I-6.16 修复本体无效（NOT-EFFECTIVE，阻断级新缺陷 D-R9-1/D-R9-2）**

## 0. 取证设计（如何做到"实弹"）

run8 的覆盖空洞=现场太干净（$sig.Count=0，SWEEP 分支不触发）。本轮：
1. run9-A（队友）undeploy 前注入诱饵；其 `cmd /c start /min` 宿主 cmd.exe 命令行无签名串，**对签名面天然免疫**（诱饵形态缺陷，非产品缺陷，但导致 A 侧"诱饵被签名扫掉"口径失实，已在过程中回正）。
2. 本人接管后重注入**签名匹配形态**诱饵（powershell -Command 含 WinVMBridge-decoy 字样，PID 5592/2292，不占端口）；另注入 node/decoy 对（6508/9552）因 ssh 会话 Job Object 随通道退出被系统回收（消亡原因记录备查，非 SWEEP 所为）。
3. undeploy apply 完成后 VM 复核 SIGCOUNT 基线；deploy 全程照脚本原文执行；**apply 后验诱饵存活 + 1:1 同构复现 VM-START 签名清扫段抓 stdout 与错误**。

## 1. 双向总表

### Phase A · undeploy v2.4（队友执行，取证复核）
| 步/判据 | 实际 | 结论 |
|---|---|---|
| U0~U1（含诱饵在场）| dry 正常；PRE 端口/任务在 | PASS |
| U2/3 apply | **rc=0，19/19 [PASS]**（18:30:00）| PASS |
| U4 独立复核 | 000 / GLOBAL_MCP_CLEAN / VM False,False,0,Running,True | PASS |
| 诱饵去向复核（本人）| A 侧 cmd 宿主 4752/7580 从未匹配签名（其消亡=start 目标被 undeploy taskkill 后自然退出）；undeploy 相位清理靠 taskkill/端口反查（有效层），**非** v2.4 卖点签名清扫 | 口径修正 |

### Phase B · deploy v3.0.5（本人，18:33~18:48）
| 步/判据 | 期望 | 实际 | 结论 |
|---|---|---|---|
| D1 探测（独立重跑）| NODE/PY 非空冒烟 | bundle node / bundle py | PASS |
| Step0.2/0.4 | vmssh 可达 / Profile 匹配 | rc=0 / Private=Private | PASS |
| Step2.0→2.3 | 本地判定→verify-manifest PASS | MATCH（881 文件）| PASS |
| Step3.0 硬门禁 | PASS / BLOCKERS=none | 达成 | PASS |
| Step3.1 .env 八字段 | 齐全 | 齐全 | PASS |
| Step3.2 dry→apply | 一次过 rc=0 | **rc=0，净 107s**（18:37:33→18:39:20，诱饵在场+VM 重装）| PASS |
| 3.2 日志 SWEEP | 脚本判据"日志应显形" | **0 行（含 VM_START_TRIGGERED 也无）** | **偏差 D-R9-2** |
| 3.2 apply 后诱饵 | I-6.16 承诺被清 | **5592/2292 存活** | **偏差 D-R9-1** |
| Step3.3 vmcheck 7 判据 | 全符 | Running/127.0.0.1/1/true/true/200/ok=true，session healthy，caps 54/54 | PASS |
| Step4.1 install-host | rc=0 | rc=0（18:46:08）| PASS |
| 4.2~4.5 | 隧道/FRESH/health/8 | RUNNING+ownerMatch / FRESH(187) / 200 / 8 | PASS |
| Step5.1 MCP | 20/20 | **20/20 PASS** | PASS |
| Step5.2 A2A | 5/5 | **5/5 PASS** | PASS |
| Step5.3 示例 | 13/13，E7 首跑 | **13/13 PASS，E7 首跑即 PASS**（链 66s，窗 330s）| PASS |
| Step6.1 | skill==8 含两指名 | 8 / hos-win-skill+winvm-orchestrator 在 | PASS |
| VM 五点终态 | True/Running/1/Running/True | 全符 | PASS |
| 现场卫生 | 诱饵清场+辅助件回收 | Stop-Process 5592/2292 → KILLED；17 个辅助 .ps1/.js Remove-Item 完毕 | PASS |

## 2. SWEEP 实弹结论：**I-6.16 = NOT-EFFECTIVE（两个阻断级子缺陷）**

### D-R9-1【阻断·修复本体无效】签名清扫杀不掉任何进程
1:1 同构复现 VM-START 清扫段（manual-sweep.log）实证：
- 匹配面**正常**：显形 5 行 `VM_START_SWEEP PID=…`（含诱饵 5592/2292 与当时在册服务进程）
- 执行面**全灭**：`$sig | ForEach-Object { $null = $_.Terminate() }` 对每个目标抛 **`MethodNotFound`（CimInstance 无 Terminate() 方法）**——PS 5.1 `Get-CimInstance` 返回 CimInstance，不携带 WMI legacy 的 Terminate 方法（需 `Invoke-CimMethod -MethodName Kill` 或 `Get-WmiObject(...).Terminate()`）；`$null =` 又把异常吞进错误流。
- 实弹后果：deploy apply 期间诱饵未被清（apply 后 Get-Process 5592/2292 ALIVE 为铁证）；复现时 5 次 Terminate 全抛错、进程全部存活（含服务本体）——**该分支是自欺清扫：打条（且打不到日志）+杀 0 个**。
- 为何部署仍成功：残留实例不占 18443；真正的韧性来自**其它层**（install-vm killServiceProcess 的端口反查 Stop-Process、start-hidden 的自清理预杀、undeploy 的 taskkill）——run7 420s 痛点在 run8/run9 不复现系多层冗余，不是 I-6.16 的功劳。

### D-R9-2【阻断·判据不可达】SWEEP/ZOMBIE 哨兵成功路径永不进日志
deploy-vm.mjs L139-151：`ps.out` 仅在失败分支被 slice(0,300) 打印，成功路径**整体丢弃**（连 VM_START_TRIGGERED 都不显示）。任务书/脚本读者按"日志里 grep VM_START_SWEEP"取证必然为 0——**run8 当时把 grep=0 判读为"设计预期（现场干净未触发）"不完整**，真实根因是即便触发也不显形。修正 run8 的 §2 nit 结论。

### 对 run7 两大痛点的再判读
- 痛点①（VM-START 首跑 420s）：本轮诱饵在场仍一次过 107s → 现象层面不复现，但**归因应修正**=端口反查+start-hidden 自清理层兜住，I-6.16 签名清扫层从未生效。
- 痛点②（僵尸连锁拆除 3 FAIL）：undeploy 侧（taskkill/CIM 独立实现）本轮两次实测 rc=0 19/19；但 VM-START 面的防僵尸承诺（SWEEP/ZOMBIE 哨兵）因 D-R9-1/2 双双落空，**若再现"游离实例抢端口"形态，本修复不提供任何保护**。

## 3. 效率对比

| 环节 | run8 | run9 | 说明 |
|---|---|---|---|
| undeploy apply | 13s | ~25s（18:29:35→18:30:00 自报段）| 均一次过 |
| deploy VM-START apply | 48s | **107s** | 含诱饵在场、VM 全量重装；一次过、无重试 |
| Step5 三探针链 | ~97s | ~123s | E7 均首跑 PASS |
| 全程（拆除开始→Step6）| 515s | ≈**1320s（22 分）**含取证往返 | 纯脚本链 B 侧 18:33→18:48:58≈950s |

## 4. 新偏差清单

| # | 级别 | 描述 | 定位 | 建议修复 |
|---|---|---|---|---|
| D-R9-1 | **阻断** | VM-START 签名清扫 `$_.Terminate()` 在 CimInstance 上 MethodNotFound，杀 0 进程；`$null=` 吞错 | delivery/setup.mjs L753（buildVmStartPs1）| 改 `Invoke-CimMethod -InputObject $s -MethodName Kill`（或回退 taskkill /PID $s.ProcessId /T /F）；zombie 判定前先验证杀死 |
| D-R9-2 | **阻断（取证面）** | SWEEP/ZOMBIE/TRIGGERED 哨兵成功路径不透传 stdout，日志恒 0 行，脚本宣称的判据不可达 | delivery/deploy-vm.mjs L139-151（setup.mjs 同型 L1234+ 亦仅 log 摘要）| apply 成功时仍打印 r.out 关键行（VM_START_* 白名单透传），与 undeploy 显形面语义对齐 |
| D-R9-3 | 误导 | 部署前脚本 L175 `/End+端口反查后按命令行签名…Terminate 残留并显形 VM_START_SWEEP` 的能力描述与实际不符（读代码的人/agent 会信其保护力）| docs/deploy/*.md 能力叙事 | 修复 D-R9-1/2 后补实弹回归用例（本报告的注入法可复用：签名形态诱饵+apply 后 Get-Process 复核）|
| N-9a | 体验 | install-host 平台账户态 2 ⚠ 文案（run8 已提，本轮再现）| step4-install-host.log | 降噪注一句 |
| N-9b | 观察 | 经 ssh 会话 Start-Process 起的"诱饵"会被 Windows OpenSSH Job Object 随会话回收（6508/9552 秒逝）——未来 QA 注入需用 schtasks/游离父进程形态 | QA 方法论 | 报告记录即可 |

## 5. 最终矩阵（部署态本身全绿）

38/38（20+5+13）· E7 首跑 PASS（窗 330s）· FRESH(187 文件) · disabledTools=8 · 隧道 RUNNING/healthy/ownerMatch/!stale · skill=8（含 hos-win-skill+winvm-orchestrator）· health=200 · VM 五点 True/Running/1/Running/True · undeploy 19/19×2 次 rc=0

## 6. 结论

- **流程维度**：YES——两份脚本 Step 0→6/U0→U5 照原文一次过（零跳步/零重跑），矩阵全绿。
- **本轮靶心维度（SWEEP 实弹）**：**NO**——I-6.16 判定 **NOT-EFFECTIVE**：D-R9-1 清扫本体无效 + D-R9-2 哨兵不可见。run8 得出的"FIXED-VERIFIED（一次过维度）"需限定：**一次过属实但归因错位**，420s 不复现由其它多层兜底。
- 建议：**下一轮（run10）验证 D-R9-1/2 修复包**——按 §4 修法收编后，用本报告同款签名诱饵复测"apply 后诱饵 GONE + 日志显形 VM_START_SWEEP 行"双判据；在此之前 V1.4.15 的 VM-START 防僵尸承诺不应对外宣称。

日志：~/wbtmp/run9-20261102/（phaseA.log=队友、presweep-inject.log、sig-detail.log、step3.0/3.2/3.3/step4/step5.1-3、manual-sweep.log=核心证据、step3.2-apply-timing.txt）

────────────────────────────────────────────────────────────────────────
## 附录 B · qa4（A 侧+第一 B 轨）交叉对账与修正（18:58 追加，软件-qa-engineer-4）

**背景**：本轮 VM 现场存在两条并行轨道——qa4（Phase A 18:29:16→18:30:26；注入 18:32:18→18:32:28；
轨1 deploy 18:34:12→18:45:25，全绿：APPLY 123s rc=0 一次过、vmcheck 7/7、38 探针全 PASS、E7 首跑即过）
与 qa3（轨2 deploy 18:37:33→18:48:58，同样全绿）。合并版 REPORT.md（qa3）与本附录互为印证，
**总判定一致：SWEEP NOT-EFFECTIVE、本轮 NO**。以下三点修正/补强：

### B.1 §0.1 诱饵形态归因失实（修正）
qa4 的**正式诱饵并非 `cmd /c start /min` 形态**。实为两拍：
- 第一拍（18:31）：铁律通道内联 `Start-Process powershell`（PID 13208/5284）→ 通道关闭即被
  Windows OpenSSH 会话 Job Object 回收（≈10s 消亡，与 SWEEP 无关）=合并版 N-9b 的 qa4 侧独立发现（D9）；
- 第二拍（18:32:18，正式诱饵）：`Invoke-CimMethod Win32_Process Create` 直接派生
  **powershell.exe，存活进程自身命令行含签名串**（`... -Command "Start-Sleep 900 # WinVMBridge-decoy-A/B"`，
  PID 5592/2292）→ 完美命中 SWEEP 匹配面。4752/7580（cmd 宿主、对签名免疫）属 qa3 早期轨注入，
  合并版把"cmd 诱饵免疫"记在"A=队友注入"名下有误；该免疫性本身作为方法论结论保留（诱饵必须让
  存活进程命令行带签名，勿依赖 start 派生链）。

### B.2 "SWEEP 无目标"不成立（关键补强，D-R9-1/2 因此获得产品真路实弹证据）
合并版 §0.2/§2 称 qa3 18:30:2x 实测 SIGCOUNT=0、"deploy 侧 VM-START 的 SWEEP 将无目标、预期显形 0 行"。
该判读的时间窗有误：5592/2292 存活区间 18:32:20→18:47:20（TTL），**完整覆盖两次轨 apply 的 VM-START 相位**
（轨1 ≈18:35-36、轨2 ≈18:38），且：
- qa3 自己的 presweep-inject.log（18:35）SIGCOUNT=7 含 5592/2292；
- 轨1 产品路径 apply（18:35:04→18:37:07）后 18:37:22 复查：**5592/2292 仍 ALIVE**（phaseB-sweep.log）；
- 轨2 合并版表格自记"3.2 apply 后诱饵 5592/2292 存活"——同一条款即本证据。
结论：**产品真路 VM-START 确有目标、一枪未杀（D-R9-1 真路实证，非仅同构复现）、日志零显形（D-R9-2 真路实证）**。
run9-B 不存在"干净现场覆盖空洞"——run8 空洞的意义被 D-R9-2 取代：即便有目标也不会显形。

### B.3 qa4 独立证据链（与 manual-sweep.log 互证）
- 逐字节同源 repro（buildVmStartPs1 导出直调，1220B，18:39:50）：显形 `VM_START_SWEEP PID=5592/2292` 2 行
  + `MethodNotFound`（CimInstance 无 Terminate）×2 + `VM_START_TRIGGERED` rc=0——与 qa3 manual-sweep.log
  （18:43，显形 5 行含服务三体）构成双次击杀空转复现；
- 差分对照（诱饵-C=13928 牺牲品）：`Invoke-CimMethod -InputObject -MethodName Terminate` → RC=0、C_KILLED_OK；
  qa3 cleanup 用 `Stop-Process -Id 5592,2292` 亦即杀——共同证明诱饵非免疫型僵尸，纯系 L753 API 形态断裂；
- 服务本体无损：轨1 repro（含 /End→/Run）后 vmcheck 七判据 7/7、host health=200、ps-bridge 正常换新；
- ZOMBIE 哨兵未显形=符合设计（诱饵 WS≈76MB ≫100KB），但按 D-R9-1 其前置击杀从未成功，该哨兵语义需随修复重审。

### B.4 现场终态快照（18:53-18:58，FINAL-FIELD-1850.log）
health=200、listen=1、task=Running、签名在位三体=服务本体（start-hidden 6496 / vm-service node 12316 /
ps-bridge 6328）、诱饵 5592/2292/13928 及 4752/7580 全部不存在（TTL 自然退出+Stop-Process 清场，非 SWEEP 所为）、
C:\WinVMBridge\vm-decoy1.ps1=False。VM 侧辅助件已被 qa3 cleanup 回收（其中 vmcheck.ps1 被清导致 qa4 18:58
终验 vmcheck 需重推——非缺陷，QA 辅助件清理属 U5 存留项正常处置）。

### B.5 编号对照（便于 ISSUES 收编）
qa4 D7 = 合并版 D-R9-1；qa4 D8 = D-R9-2；qa4 D9 = N-9b；qa4 O-1 = N-9a；qa4 D10（cmd 宿主签名免疫）
=合并版 §0.1 首条（归因已修正）。qa3 独有的 D-R9-3（docs 能力叙事误导）qa4 侧无异议附议。
**双侧合并判定维持：NO（I-6.16 承诺未兑现）；run10 复验判据=「apply 后诱饵 GONE + 日志显形 SWEEP 行」双绿。**

# run7 · WinVM Bridge 第二轮 prompt 真机往返验证报告（V1.4.12 安装态 · deploy.prompt v3.0.3 / undeploy.prompt v2.3）

- 执行人：software-qa-engineer-2（QA）
- 日期：2026-11-02（15:22~16:15 本地）
- 仓库：/storage/Users/currentUser/Documents/projects/workbuddy-virtual-win-plugin（HEAD=2151421，clean）
- 操作文档：包根 ~/winvm-deploy/overall-root/docs/deploy/*.prompt，与仓库 v3.0.3/v2.3 逐字节一致（md5 复核：deploy=4df9e6a2…、undeploy=8f23ae38…）
- 日志目录：~/wbtmp/run7-20261102/（各步 `*.out` 全留 + TRANSSCRIPT.txt）
- 解释器（按文档探测块产出）：NODE=/data/storage/el1/bundle/libs/arm64/node/bin/node，PY=/data/service/hnp/bin/python3
- VM：172.16.100.2 User@（ssh whoami 免密可达；sshd 默认壳 cmd.exe；全程未动 ~/.ssh、authorized_keys、C:/WinVMWorkspace）

说明：本轮不重做主理人已完成的 deploy 侧探测抽取实验（其结论「冒烟门禁正确选中 bundle node、拒掉脆弱 hnp node」与本轮 S0/S0b 现场一致，直接引用）。

---

## 1. 双向总表（文档判据 → 实际 → 结论）

### Phase A · undeploy.prompt v2.3

| 步骤 | 文档判据 | 实际 | 结论 |
|---|---|---|---|
| 前置·探测块（L25-36） | NODE/PY 非空且过冒烟 | NODE=bundle node PY=hnp python3；`NODE_SMOKE_OK`+`-c` 双冒烟过；重复 3 次稳定（S0/S0b） | PASS |
| U0.1 免密通道 | vmssh whoami=用户名+rc0 | `win-hos-ywang-s\user` rc=0 | PASS |
| U0.2 | WINVM_DRY_RUN=0 | 0 | PASS |
| U0.3 基线 | find ~/.workbuddy -iname '*winvm*' + mcp 键 + VM 存在性 | 644 落点（含历次 winvm-bak）；全局键=winvm,winvm-a2a；connector 键 2 账户各 2；VM 五点=True/True/1/Running/True；health=200 | PASS |
| U1 DRY-RUN | mode 行 + 逐项 [DRY]/[KEEP]，无越界删除 | `mode : DRY-RUN`；workspace=KEEP、keys=NEVER touched；VM 相位计划完整（task/进程/junction×7/PATH/side.json） | PASS |
| U2/3 --apply | rc=0 + POST-CLEANUP 全 PASS + [FAIL]=0 | rc=0；**19/19 [PASS]**；WARN×1（tunnel.state.json ENOENT，=文档 D3 预告）；G1 兼容判据未触发（V1.4.12 无 I-6.7 误报，workspace kept 直接 PASS） | PASS |
| U4.2 独立复核 | health=000 / cache absent / GLOBAL_MCP_CLEAN / VM 五点 False,False,0,Running,True | 四项逐一实测相符（U4.out） | PASS |
| U5 存留项 | 不动、仅记录可操作性 | 密钥在（id_ed25519 + VM 双位 authorized_keys 可查）；trash=78 批次 145M；fs.rmSync/unlinkSync=function（node 通道可用）；rm shim 确认 bad interpreter；下载物保留 | PASS（记录） |

### Phase B · deploy.prompt v3.0.3

| 步骤 | 文档判据 | 实际 | 结论 |
|---|---|---|---|
| Step0 探测块（L25-36） | 同构 D1 | NODE=bundle node PY=hnp python3（同 Phase A） | PASS |
| 0.1/0.3 | 提醒项 | 免密已在→密码相位 N/A；hypervisor 电源=用户侧 N/A-USER（记录） | N/A |
| 0.2 OpenSSH | vmssh whoami 可达 | rc=0 + TCP22=open | PASS |
| 0.4 防火墙（**D4 通道**） | 按注记 .ps1→vmscp→vmssh -File | 通道零异常执行：CAT(Tailscale\|Private, 以太网\|Private)、RULE=OpenSSH-Server-In-TCP Enabled=True Profile=Private → 匹配、无需修复（接口名 GBK 乱码属 VM 控制台码页，判读不受影响） | PASS |
| 0.5 重试面 | 抖动走 vmssh/vmscp | 全程 ssh/scp 零重试触发 | PASS |
| Step1 复核 | 1.5 whoami | rc=0（1.1-1.4 免密已在跳过） | PASS |
| Step2.0（**D5**） | ls MANIFEST.txt+delivery 双命中→跳下载 | BOTH_HIT → 直入 2.3 | PASS |
| Step2.3 | verify-manifest RESULT: PASS | PASS（881 files/7,692,893 bytes、total-sha 789c9ab4…复算 MATCH、0.79s）；判据③六件+包内 docs 五件齐 | PASS |
| 3.0 ENV_PRECHECK | =PASS 且 BLOCKERS=none | ENV_PRECHECK=PASS BLOCKERS=none（NODE_OK/NPM_FOUND/CLI_OK 全 true；AUTH_VERDICT=config-dir-present） | PASS |
| 3.1 .env | 八字段逐项核 | 8/8 符合期望值 | PASS |
| 3.2 dry+apply | dry rc0；apply rc=0 | dry rc=0；**apply 首跑 rc=1**（VM-START 后 420s 未监听；现场=首实例 PID16332 僵而不绑、终态僵尸不可杀）→按脚本打印的文档指引「重跑本脚本」**复跑 rc=0（127s，VM-START ✅）** | PASS（经重试路径，见偏差 N2） |
| 3.3 vmcheck 七判据 | task=Running/127.0.0.1/count=1/side/bridge/200/ok=true | 首查（APPLY2 后即测）：listen/…/health 六项全符但 **task_state=Ready**（任务包装器 result=0 正常退出、服务以游离实例存续）；会话处置+重触发后终查（SB33-final）：**七项全符 Running** | PASS（经会话处置路径，task_state 判据语义见偏差 N1） |
| 4.1 install-host | rc=0 | rc=0（1s；13 文件、3 mcp.json 合并、H1 断言 2/2、**隧道自动拉起成功**——run6 需手工 ensure 的 ENOMEM 坑本轮被 v3.0.3 探测块根除） | PASS |
| 4.2 隧道四判据 | RUNNING/healthy/ownerMatch/stateStale | state=RUNNING healthy=true ownerMatch=true stateStale=false pid=17933 | PASS |
| 4.3 --check-fresh | FRESH | FRESH（187 文件逐 SHA 一致） | PASS |
| 4.4 health | 200 | 200 | PASS |
| 4.5 disabledTools | =8 | 8（system.service.configure/system.process.terminate/system.registry.write/system.power.control/app.winget.uninstall/storage.file.delete/storage.link.manage/appops.gui.produce） | PASS |
| （4 段排错速查 L230） | 隧道 ENOMEM 行 | 未触发（隧道一次起成）——可用性=文案在位、与探测块互证 | N/A |
| 5.1 mcp-probe（仓库 HEAD） | 20/20 PASS | **首跑 18/20**：A3 会话健康 + C5 gui.session.status FAIL=服务实例被拉起在 **Session 0**（sessionId=0, interactive=false）；vm-diag11 按 schtasks /End+/Run 重触发后落入 Session 1 → **复跑 20/20** | PASS（经会话重触发，见偏差 N1） |
| 5.2 a2a-probe（仓库 HEAD） | 5/5 PASS | 5/5（E4 走 LLM 委派真实完成，71s） | PASS |
| 5.3 example-probe（仓库 HEAD，E7_TIMEOUT=300） | 13/13 PASS；E7 首跑应直接 PASS | **首跑 12/13**：E7 服务端 **EXECUTION_TIMEOUT**（traceId=tr_mvyzhx3b_14、durationMs=120081，恰=服务端 definitions.ts:328 `timeoutMs:120_000` 闸；客户端 300s 窗未掐线、拿到结构化错误应答）；单发复测 ok=true 104.7s；**整跑复跑 13/13**（103s，E7 PASS≈72s 档） | **NOT-EFFECTIVE（半）**：客户端窗修复生效、服务端 120s 闸成为新瓶颈 → 新偏差 N3 |
| 6.1 | 连接器 8 skill 且含 hos-win-skill/winvm-orchestrator | ls=8、两者在列 | PASS |

## 2. 修复面逐项复验

| 面 | 结论 | 证据 |
|---|---|---|
| **D1**（NODE/PY 冒烟门禁，I-6.11） | **FIXED-VERIFIED** | S0/S0b.out：探测块选中 bundle node；本宿主 hnp node 的 .mjs 冒烟在循环内出现 rc=1（间歇不稳，直跑 5 次却偶成——恰证「仅 -x 不够」），门禁正确拒之；连锁收益=run6 的 install-host 隧道 V8 ENOMEM 手工兜底本轮**不再需要**（SB4.out 4.1 隧道一次拉起） |
| **D2**（U4.2 @(Get-NetTCPConnection...).Count） | **FIXED-VERIFIED** | 文档 L123 原文含 `@(Get-NetTCPConnection -LocalPort 18443 -State Listen -ErrorAction SilentlyContinue).Count`（awk 抄录见 U4 段）；照抄执行输出 False/False/**0**/Running/True；对照实验（D2b-trap.out）实证 PS5.1.26100 下未包 @() 的裸 `.Count` 在单对象上打出字面量 `[…].Count` 形态——陷阱真实、@() 版正确 |
| **D3**（U2.3 良性 WARN 说明） | **FIXED-VERIFIED** | apply 日志恰现 1 条 `[WARN] … tunnel.state.json … ENOENT … rename → Trash`（U2.out），与 L102-103「daemon 自清与拆除器竞态、不影响 rc」描述完全吻合；rc=0、19/19 无停顿 |
| **D4**（0.4 通道注记 .ps1→vmscp→-File） | **FIXED-VERIFIED** | v3.0.3 L85「宿主远程执行按铁律=写 .ps1 → vmscp → vmssh powershell -File，勿内联」按文执行一次通过（SB0.out 0.4 段），无 ParserError/无内联歧义 |
| **D5**（Step 2.0 包根 ls 机械判定） | **FIXED-VERIFIED** | v3.0.3 L124-125 新增判定行；实测 BOTH_HIT→跳过 2.1/2.2 直入 2.3 且 PASS（SB12.out）——run6「反复清场后误走下载路径」歧义消除 |
| **I-6.13**（探针 300s 窗） | **FIXED-VERIFIED（客户端）** | 仓库 HEAD 探针（E7_TIMEOUT=300 + rpc timeout 形参）：E7 首跑不再出现 `EXC timed out` 掐线，而是拿到服务端结构化 EXECUTION_TIMEOUT 应答——客户端窗确已加宽；但由此暴露服务端 120s 能力闸（见 N3），修复**不完整** |

## 3. 新偏差清单

- **N1（P2·判据/文档面·deploy.prompt Step 3.3 + 产品行为）**：服务落点会话漂移+任务态语义漂移。①APPLY2 触发的服务实例落 **Session 0**（Get-Process.SessionId=0）→ GUI 面判据（mcp A3/C5、潜在 E3*）FAIL；需 schtasks /End + /Run 重触发才落 Session 1（Console）。②同窗口 vmcheck task_state=**Ready**（包装器 result=0 已退出、服务成游离实例）而非文档判据 Running；后经重触发循环恢复 Running。**判据本身没错，错在「一次性通过」的前提不稳**：run6 未遇（当时 console 会话已在）。建议：Step 3.3 判据补一行兜底文案「task_state=Ready 且 listen_count=1 且 health 200 → 服务存活但任务包装器已退出（瞬态等价，可继续）；A3/C5 或 GUI 能力报 SESSION_UNAVAILABLE → schtasks /End /TN WinVMBridge.Service && schtasks /Run /TN WinVMBridge.Service（触发落非交互会话的通用解）」；产品侧长期解=install-vm 确保任务以交互令牌注册。证据：SB33.out / SB33-taskstate.out / SB32-diag9.out / SB51.out / SB32-diag11.out / SB51b.out。
- **N2（P3·脚本韧性·deploy-vm VM-START）**：apply 首跑 420s 轮询失败——首个实例（PID16332）诞生即 8K 工作集僵死、从未绑端口，且此后成为不可杀僵尸（taskkill/Stop-Process 均报「没有此任务的实例在运行」，query 仍在）。脚本自带指引「重跑本脚本」有效（复跑 127s rc=0），文档韧性成立；但 start-hidden 的「端口旧实例自清」逻辑对僵而未绑的实例无感知（本例 LISTEN=0 无从自清）。建议 ISSUES 开账观察项：VM-START 前若发现 WinVMBridge 命令行 node 存续但未监听，先 taskkill 树再触发（现只按端口反查 PID）。证据：SB32a.out（rc=1 duration=533s）/ SB32-diag.out / SB32-diag3.out / SB32-diag6.out（EADDRINUSE 假象——僵尸半持有）/ SB32-rerun.out。
- **N3（P2·产品/探针缝·storage.cleanup.analyze 服务端闸）**：服务端 per-capability `timeoutMs: 120_000`（packages/vm-capabilities/src/registry/definitions.ts:328）与本能力真实耗时带（本现场：半冷 120081ms 越闸 FAIL、暖 72.2s/104.7s PASS；run6 冷态 ≥120s）冲突——I-6.13 把客户端窗放宽到 300s 后，**服务端 120s 闸成为下一个确定性瓶颈**，冷盘首跑必现 ok:false EXECUTION_TIMEOUT。这不是探针窗问题，是「修复面只改了一半」。建议：该能力 timeoutMs 提至 ≥300_000 与 E7_TIMEOUT 对齐（同族 storage.search.query/space.analyze 120s 窗同评估）；短期在 deploy.prompt 5.3 注记「E7 报 EXECUTION_TIMEOUT（非 timed out）=服务端闸，复跑或按排错重触发即可，属 I-6.13 延伸」。证据：SB53.out（tr_mvyzhx3b_14, durationMs=120081, code EXEC…截断段已由 E7-solo 交叉+源码常量对齐）/ E7-solo.out（104.7s ok=true）/ SB-cmp120.out（72.2s ok=true）。
- **N4（P4·文案·undeploy.prompt 版本头）**：L2 标题仍写「undeploy.prompt **v2.2**」，而 L12 要点段已是 v2.3——版本横幅漏 bump，dogfooding 时易误读为旧版。建议下一修订把 L2 改 v2.3。
- **N5（P4·环境噪音，非文档缺陷）**：①本会话 shell 每条命令 stderr 出现 getcwd 警告（hmdfs 沙箱特性）；②0.4 输出接口中文名 GBK 乱码（VM 控制台码页，判据字段不受影响）；③宿主 find ~/.workbuddy 含 95 个历史 *.winvm-bak.* 备份文件，uninstall 不回收（设计如此，U4 判据无冲突），仅提示长期膨胀。
- **已知滞后面（非新缺陷，口径引用）**：包根 qa/deploy-probes 为 V1.4.12 打包时旧版——mcp-probe.py/example-probe.py 无 I-6.13 超时形参（cmp 实测 DIFF；其余四件 SAME），按主理人指令 Step 5 全部改用仓库 HEAD 版执行。ISSUES I-6.13 状态列「随下次 pack 分发」口径维持。

## 4. I-6.9 / I-6.10 持续生效证据

- **I-6.9（忙态看门狗误杀修复）**：全程 E7/E8 **零** `PSBRIDGE_HEARTBEAT_TIMEOUT`/`PSBRIDGE_EXITED`；所有 vmcheck 快照 `psBridge.restarts=0`、state=ready；a2a E4 真实 LLM 委派 71s 长调用无瞬态（llmSession restarts=1 系 idle 超时正常回收，非看门狗）。E7 首跑 FAIL 形态已从「掐线/心跳超时」转变为服务端结构化 EXECUTION_TIMEOUT 应答——正是 I-6.9 修复后的预期形态（监管不误杀、错误如实回报）。
- **I-6.10（setup 假败修复）**：deploy-vm APPLY2 rc=0 与 vmcheck listen_count=1/health=200 交叉印证「完成=真起」；install-host rc=0 与四判据（FRESH/200/RUNNING/8）互相印证；无「✅ 完成但服务没起」形态。首跑失败为显式 rc=1+指引（非假败），韧性成立。

## 5. 最终运行态矩阵（终查实测）

| 维度 | 值 |
|---|---|
| health | 200（宿主 127.0.0.1:18443） |
| 隧道 | RUNNING / healthy / ownerMatch / !stale（pid=17933） |
| --check-fresh | FRESH（187 文件） |
| disabledTools | 8 |
| 三探针 | 20/20 + 5/5 + 13/13 = **38/38**（终态；各自首跑插曲见 N1/N3） |
| capabilities | 54/54 available |
| vmcheck 七判据 | Running / 127.0.0.1 / count=1 / side_json / bridge_dir / 200 / ok=true（SB33-final） |
| VM 五点 | Bridge=True、Task=Running、Listen=1@127.0.0.1、sshd=Running、Workspace=True（保留） |
| 会话 | sessionId=1 interactive=true state=healthy |
| psBridge / llmSession | ready restarts=0 / restarts=1(idle 回收) wsPeak15.4MB |
| 交付面 | connector-winvm skills=8（含 hos-win-skill、winvm-orchestrator） |
| 存留项 | 密钥、trash(78 批/145M)、下载物——全保留未动 |

## 6. 结论

**YES-with-nits。** v3.0.3/v2.3 相对 v2.0.2/v2.2 的五个修复面（D1~D5）**全部真机兑现**，且 D1 带来可量化的连锁收益（隧道拉起不再需要手工兜底）；undeploy v2.3 清理链一次通过 19/19 零误报。nits 集中在三处：
1. I-6.13 修复只覆盖客户端窗，**服务端 120s 能力闸**在冷/半盘场景取代掐线成为新的首跑 FAIL 来源（N3，建议提闸或加注记）；
2. 服务落点会话与任务态的**双漂移**（N1）使 Step 3.3/mcp 判据出现「文档判据正确但首跑不可达」窗口，需把 /End+/Run 重触发写成标准兜底行；
3. VM-START 对「僵而不绑」实例的自清盲区（N2，观察级）。
另版本横幅漏 bump（N4）为纯文案。两份 .prompt 的判据面本身**无一出现与实际相悖的假 PASS**，本轮全部 FAIL 均可被文档既有或建议的兜底路径在 2 步内收敛——脚本可用性判定为真机成立。

（第 2 测试轮上限内收敛：Phase A 无返工；Phase B 的重跑/重触发均为文档指引内的操作，非修复轮次。剩余未修项已按 N1~N3 清单化，不再扩环。）


---

## 附 · 发布态复验与 V1.4.14 上架（主理人收口，同夜）

- **V1.4.13 发布态 --wipe**：包根匿名解包（三向 sha `cfeeee88…`）→ 首拆遇 **僵尸 node（PID 16332，8K 工作集/无子/不绑端口）三式强杀全免疫**（管理员 taskkill /F、Process.Kill、CIM Terminate）→ uninstall rc=1 三 FAIL → **VM 内 `shutdown /r /t 5 /f` 重启 guest**（~60s sshd 恢复）→ 复拆 **19/19 PASS rc=0** + 独立复核 000/GLOBAL_MCP_CLEAN → setup rc=0「部署全部完成」→ **38/38 全绿**（E7 首跑直接 PASS=包内 300s 服务端闸+330s 探针窗双修复面发布态实证）。
- 应急路径成文=**deploy.prompt v3.0.5**（排错段+僵尸特征）/ **undeploy.prompt v2.4**（FAIL 特征串→重启→复拆三步）；pack **V11d** 断言（包内 deploy.prompt 必含 shutdown /r 应急行；正反例 HEAD PASS / V1.4.13 包内 FAIL 拦截滞后）。
- **V1.4.14**（纯文档/脚本面，运行码与 V1.4.13 diff -rq 机械证一致，免 --wipe 重跑=同 V1.4.12 先例）：先 commit（f660e2a）后 pack（V1–V11 全绿、V11d 首战）→ tag V1.4.14@f660e2a → publish → latest API=V1.4.14 → 匿名回环三向 sha 一致（`5ccd8acf…`/881/7706110/`bbdc464b…`），解包两 .prompt 与仓库逐字节一致（v3.0.5/v2.4，shutdown /r 在册）。
- V1.4.14 宿主缓存切换（install-host rc=0）：FRESH、disabledTools=8、隧道 RUNNING/healthy、连接器 8 skill、health=200。
- **当前线上=V1.4.14；两轮 dogfooding（run6/run7）+一次发布态复验全部闭环，缺陷台账 I-6.1~6.15+G-1/2/3+R8 无悬挂项（I-6.15b 观察项在册=VM-START 前扫描先行清理的根治候选，待频次数据）。**

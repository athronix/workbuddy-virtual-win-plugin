# run8 验证报告 · V1.4.15 包内 deploy.prompt v3.0.5 + undeploy.prompt v2.4

- 被测对象：V1.4.15 包内两份智能体安装脚本 + 新修复 I-6.16（VM-START 命令行签名清扫）
- 现场：VM=172.16.100.2 User 免密在；NODE=bundle node（/data/storage/el1/bundle/libs/arm64/node/bin/node）；PY=bundle python3
- 全程：拆除开始 18:16:44 → Step6 完成 18:25:19 = **515s（8分35秒）**
- 纪律：严格照脚本原文 Step 顺序执行，零跳步；删文件走 node fs；远端 PS 全走 .ps1+File 铁律通道；禁动项零触碰

## 1. 双向总表

### Phase A · undeploy.prompt v2.4
| 步/判据 | 期望 | 实际 | 结论 |
|---|---|---|---|
| D1 NODE/PY 探测冒烟 | 两者非空（.mjs/-c 门禁）| NODE=bundle node、PY=bundle python3 | PASS |
| U0.1 免密通道 vmssh whoami | 用户名+rc0 | win-hos-ywang-s\user rc=0 | PASS |
| U0.2 WINVM_DRY_RUN=0 | 0 | 0 | PASS |
| U0.3 基线 VM | BRIDGE/TASK 存在 | True/True | PASS |
| U1 dry-run | mode:DRY-RUN 逐项清单 | 全 [DRY]/[KEEP]/[SKIP]，无异常落点 | PASS |
| U2/U3 apply | rc=0，全 [PASS] | **rc=0，19/19 [PASS]，净 13s** | PASS |
| D3 良性 WARN | tunnel.state ENOENT 竞态可容忍 | 出现 1 行，rc/PASS 不受影响，照文档不处置 | PASS |
| U4.2 独立复核(宿主) | 000/cache absent/GLOBAL_MCP_CLEAN | 000 / No such dir / GLOBAL_MCP_CLEAN | PASS |
| U4.2 独立复核(VM) | False/False/0/Running/True | False/False/0/Running/True | PASS |
| U5 存留项 | 默认保留（密钥/trash/下载物）| 全保留，trash 84 项在 | PASS（遵禁令）|

### Phase B · deploy.prompt v3.0.5
| 步/判据 | 期望 | 实际 | 结论 |
|---|---|---|---|
| Step0.2 vmssh | 可达 | whoami rc=0 | PASS |
| Step0.4 防火墙 Profile | 匹配 | NetCat=Private / 规则=Private | PASS（无需修）|
| Step1 免密 | 已在可跳过 | 通道在，跳过建通道 | PASS |
| Step2.0 本地包根判定(D5) | MANIFEST+delivery 命中→跳下载 | 命中，直入 2.3 | PASS |
| Step2.3 verify-manifest | RESULT: PASS | total-sha256 MATCH，881 文件 | PASS |
| Step2.3 关键件③ | 六件+docs五件在 | 全 OK | PASS |
| Step3.0 环境硬门禁 | ENV_PRECHECK=PASS/BLOCKERS=none | PASS / none（NODE_OK/NPM/CLI 全 true）| PASS |
| Step3.1 .env 八字段 | 齐全 | cp -n 后逐项符合 | PASS |
| Step3.2 DRY | 规划无改动 | DRY-RUN 正常 | PASS |
| **Step3.2 apply(VM-START)** | **一次过 rc=0** | **rc=0，净 48s，[VM-START]✅已监听127.0.0.1:18443** | **PASS（一次过）** |
| Step3.3 vmcheck 判据 | Running/127.0.0.1/1/true/true/200/ok | 7/7 全符（interactive Session healthy，无需 N1 兜底）| PASS |
| Step4.1 install-host | rc=0 自动拉隧道 | rc=0，隧道自动起 | PASS |
| Step4.2 隧道状态 | RUNNING/healthy/ownerMatch/!stale | 四项全符 | PASS |
| Step4.3 --check-fresh | FRESH | FRESH（187 文件 SHA256 一致）| PASS |
| Step4.4 health | 200 | 200 | PASS |
| Step4.5 disabledTools | 8 | 8 | PASS |
| Step5.1 MCP 20 项 | RESULT: PASS | 20/20 PASS | PASS |
| Step5.2 A2A 5 项 | RESULT: PASS | 5/5 PASS | PASS |
| Step5.3 示例 13 项 | RESULT: PASS | 13/13 PASS（E7 首跑即 PASS，5.3 净 42s）| PASS |
| Step6.1 skill 就位 | ==8 且含 hos-win-skill+winvm-orchestrator | 8，两项均在 | PASS |
| Step6 VM 五点终态 | True/Running/1/Running/True | 全符 | PASS |

## 2. I-6.16 验证结论 —— **FIXED-VERIFIED（一次过维度）**

- **VM-START 一次过 = 已验证**：Step3.2 apply rc=0、净 48s、服务监听 127.0.0.1:18443 正常。对比 run7 首跑 420s rc=1 失败 + 复跑 127s，本轮首跑即成，痛点消失。
- **VM_START_SWEEP / VM_START_ZOMBIE_PID 哨兵实态**：两份日志 grep 计数 = **0**（未显形）。
  - 定性：buildVmStartPs1 中哨兵仅在 `if ($sig.Count -gt 0)`（存在命令行签名残留进程）时打印。本轮为**干净现场重装**（前置刚 19/19 全绿拆除，VM 无任何残留 node），签名清扫分支 $sig.Count=0 → 不打印属**设计预期**，非缺陷、非未生效。
  - **验证覆盖提示（nit）**：SWEEP/ZOMBIE 分支的"实战显形"本轮**未覆盖**——需带残留实例的脏场景（如上次崩溃后未清）才能触发出 SWEEP 行。本轮只能证明：①一次过（无 420s 复现）②清扫代码在位（setup.mjs 签名清扫逻辑源码核实到位，行 737-762）。僵尸免疫三式的老连锁拆除 3 FAIL 亦未复现（本轮拆除 13s 一次过）。
- 结论：run7 两大痛点（VM-START 首跑 420s 超时 + 僵尸连锁拆除 3 FAIL）在 run8 **双双消失**，与 I-6.16 修复方向一致，判定 FIXED-VERIFIED（一次过+服务健康面）；SWEEP 实弹显形列为观察项（非阻断）。

## 3. 效率对比（run8 vs run7）

| 环节 | run7 | run8 | 增益 |
|---|---|---|---|
| undeploy apply | 僵尸连锁 3 FAIL + 需 VM 重启 ~60s | **13s 一次过 19/19** | 免除重启排错 |
| deploy VM-START | 首跑 420s rc=1 失败 + 复跑 127s | **48s 一次过 rc=0** | 省 ~372s 首跑浪费 |
| Step5.3 E7 | ≤旧窗侥幸/触闸 | 首跑即 PASS，整链 42s（窗=330s，包内探针 E7_TIMEOUT=330 已入）| 冷启动不再触闸 |
| 全程（拆除→Step6）| —（含失败重跑）| **515s（8分35秒）** | 单轮完整闭环 |

## 4. 新偏差清单

**无阻断级、无误导级偏差。** 全脚本判据与实机 100% 一致，零重跑、零跳步、零纠正。仅以下观察项（均体验级，脚本已文档化）：

- [体验] Step4.1 install-host 连接器自检末尾报 2 条 ⚠（default 账户无 connector-states.v3.json；winvm 账户 states 未列 winvm 条目）。脚本正文已注明"多账户场景属平台侧行为、注册面就位 exit=0"，不影响 FRESH/health/disabledTools 判据。执行者易误读为告警，建议文案补一句"此两 ⚠ 为平台账户态噪声，注册面 ✓ 即可继续"。
- [观察] I-6.16 SWEEP/ZOMBIE 分支本轮因现场干净未显形（见 §2），实弹验证需脏场景，非缺陷。

## 5. 最终矩阵

| 维度 | 判据 | 结果 |
|---|---|---|
| 三探针总数 | 20+5+13 | **38/38 PASS** |
| 分发新鲜度 | FRESH | **FRESH**（187 文件）|
| 高危闸门 | disabledTools=8 | **8** |
| 隧道 | RUNNING/healthy/ownerMatch/!stale | **全 PASS** |
| skill 就位 | ==8（含 hos-win-skill+orchestrator）| **8** |
| 宿主健康 | /health=200 | **200** |
| VM 五点 | Bridge存在/task Running/1监听/sshd Running/Workspace在 | **True/Running/1/Running/True** |
| 拆除核验 | 19/19 rc=0 | **19/19 PASS** |

## 6. 结论

**YES-with-nits。**
- 「完全按两份脚本可高效顺利完成」核心达成：Step 0→6 全程照原文一次过、无跳步、无重跑，38/38、FRESH、disabledTools=8、隧道、8 skill、health=200、VM 五点全绿；I-6.16 靶心 VM-START 一次过（48s vs run7 420s 失败）验证通过；拆除 13s 一次过（vs run7 僵尸 3 FAIL）。
- nits（不阻断，属文档/验证覆盖）：① install-host 平台账户态 2 ⚠ 建议文案降噪；② SWEEP 实弹显形本轮脏场景缺失未覆盖（观察项）。
- 连续验证系列：run8（本轮）达成"完全按脚本顺利完成"目标主体，建议 run9 可注入脏场景补验 SWEEP 显形，或对 nits 收编后复跑。

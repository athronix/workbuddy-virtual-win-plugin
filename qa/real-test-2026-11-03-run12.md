# run12 测试报告 — V1.4.17 包根 deploy/undeploy prompt 完整往返 + X 避坑条款验证

- 执行：QA Edward · 2026-11-03 02:17~02:40 UTC · 宿主=鸿蒙 WorkBuddy · VM=172.16.100.2
- 被测：undeploy.prompt v2.5（U0→U5）+ deploy.prompt v3.0.6（Step 0→6），包根 `/storage/Users/currentUser/winvm-deploy/overall-root`（V1.4.17 安装态起步）
- 双重目的：①流程可重复性 ②**X-1~X-5 避坑条款是否消灭 run11 执行者返工**

## ① 分步计时表（39 行，列含 solution；全表见 timings.csv）

### Phase A undeploy v2.5（13 行 / 90s）
| 步 | 内容 | 时长 | rc | 判据 | issues/solution |
|---|---|---|---|---|---|
| U0.1 | vmssh whoami 免密自检 | 1s | 0 | PASS win-hos-ywang-s\user | none |
| U0.2 | WINVM_DRY_RUN=0 | 1s | 0 | PASS | none |
| U0.3 | 拆前基线（宿主 find+VM .ps1） | 27s | 0 | PASS 安装态落点齐全 | X-3 姿势 |
| U1.1 | dry-run 规划 | 17s | 0 | mode:DRY-RUN | none |
| U1.2 | 判读 [DRY]/[DO]/[SKIP]/[KEEP] | 1s | 0 | PASS | none |
| U1.3 | 人工安全阀核对 | 0s | 0 | PASS 无意外落点 | none |
| U2.1 | **--apply 真拆** | 27s | 0 | rc=0 | none |
| U2.2 | 内部序列核对 | 1s | 0 | PASS 与 2.2 文档一致 | none |
| U2.3 | 判据核验 | 1s | 0 | PASS 19/19 [FAIL]=0 | **X-4②命中** line34 [WARN] tunnel.state.json ENOENT→登记放行未停顿 |
| U4.1 | 自报清单判读 | 1s | 0 | PASS 宿主10+VM9 全[PASS] | none |
| U4.2 | 独立复核 | 12s | 0 | PASS curl=000/cache absent/GLOBAL_MCP_CLEAN/VM 五点=False,False,0,Running,True | X-3 |
| U4.3 | 双信源汇总 | 1s | 0 | PASS | none |
| U5 | 存留项处置 | 0s | 0 | PASS 全默认保留（密钥/trash 95 目录/pkg/automation 无关项不动） | 禁 rm 遵守 |

### Phase B deploy v3.0.6（26 行 / 461s）
| 步 | 内容 | 时长 | rc | 判据 | issues/solution |
|---|---|---|---|---|---|
| 0.1~0.3 | 密码/新宿/电源提醒项核 | 3s | 0 | PASS 现场确认 | none |
| 0.4 | 防火墙诊断(.ps1) | 12s | 0 | PASS 网卡 Private+规则 Private 匹配 | **X-4③命中** 以太网卡名 GBK 乱码→放行 |
| 0.5 | 抖动观察 | 1s | 0 | PASS 0 重试 | none |
| 1 | 免密已在,1.5 复核 | 2s | 0 | PASS 跳过 1.1~1.4 | none |
| 2.0 | 本地包根判定 D5 | 0s | 0 | PASS 跳下载 | none |
| 2.3 | verify-manifest.py | 2s | 0 | PASS RESULT:PASS | none |
| 2.3b | 关键六件+docs 在位 | 1s | 0 | PASS | none |
| 3.0 | vm-env-check 硬门禁 | 33s | 0 | PASS ENV_PRECHECK=PASS BLOCKERS=none | none |
| 3.1 | .env 八字段 | 1s | 0 | PASS 相符无需改 | none |
| 3.2a | deploy-vm dry | 1s | 0 | PASS | none |
| 3.2b | **deploy-vm apply** | **137s** | 0 | PASS 服务监听 127.0.0.1:18443 | none |
| 3.3 | vmcheck 探针 | 19s | 0 | PASS 7/7（Running/127.0.0.1/1/true/true/200/ok=true） | none |
| 4.1 | install-host | 3s | 0 | rc=0 | **X-4④命中** line73-74 connector-states ⚠×2→登记放行 |
| 4.2/4.2j | tunnel status | 2s | 0 | PASS RUNNING/true/true/false | — |
| 4.3 | --check-fresh | 1s | 0 | PASS FRESH | none |
| 4.4 | curl health | 1s | 0 | PASS 200 | none |
| 4.5 | disabledTools | 0s | 0 | PASS =8 | none |
| 4x | Step4 汇总 | 1s | 0 | PASS ①~④全中 | X-4④ |
| 5.1 | mcp-probe | 23s | 0 | PASS 20/20 | none |
| 5.2 | a2a-probe | 38s | 0 | PASS 5/5 | none |
| 5.3 | example-probe | **178s** | 0 | PASS 13/13 E7 一次过 | X-5 带宽观察（见⑤D-3） |
| 5.4 | Step5 汇总 | 1s | 0 | PASS 零复跑零超时 | 链 239s 超 145s 带→按 X-5"无超时零复跑=正常"继续 |
| 6.1 | skill 就位 | 1s | 0 | PASS 8=8 含 hos-win-skill+winvm-orchestrator | none |

**全程 X-4① getcwd 警告（每次 shell 调用）**：均登记放行。

## ② X 条款验证结论
- **X-1（source 会话态）→ VERIFIED-EFFECTIVE**：第一步即落盘 `~/wbtmp/run12-env.sh`（运行期注入整段），此后 39 步每条命令开头 source。vmssh/vmscp 全轮零 `command not found`（run11 U0.3 坑零复发）。
- **X-2（路径绝对化）→ VERIFIED-EFFECTIVE**：全部日志/探针/计时文件绝对路径；U1.1/U2.1 的 `cd $PKG_ROOT &&` 与命令同串。零相对路径读不到 log 返工（run11 U4.1 坑零复发）。
- **X-3（本地侧 $ 展开同禁）→ VERIFIED-EFFECTIVE**：6 个 PS 载荷（vm-baseline/vm-recheck/fw-check + 包内三探针）一律单引号 heredoc→.ps1→vmscp→`powershell -File`。零 ParserError（run11 0.4 坑零复发）。
- **X-4（噪音放行表）→ VERIFIED-EFFECTIVE**：四类噪音**全部实际命中**（①getcwd 每调用、②ENOENT line34、③以太网卡名 GBK、④connector-states ⚠×2），全部"登记后继续"零停顿零误处置。免疑惑目的达成。附带发现：X-4① 的 stderr 曾被我的 `2>&1` 判据捕获卷入计时字段（0.2 行撕裂）——收集姿势问题，见 D-2。
- **X-5（探针带内+E7 窗）→ 判定面 VERIFIED-EFFECTIVE / 数值带需上修**：E7 一次过（178s<330s 窗），零超时零复跑，"勿误判回归"条款使我正确放行；但三探针链 **239s 超声明带 97~145s** 约 94s（深冷场景=完整往返后重装即刻跑探针，llmSession 尚在 starting）。见 D-3 修订建议。

## ③ 重试/返工计数
- **因被测脚本的返工 = 0**（对比 run11：3 返工 ~55s → 本轮零复发，X-1/X-2/X-3 直接归因）。
- vmssh/vmscp 内部重试 = 0（全部首发成功）。
- QA 自身工具插曲 1 次（D-1，与被测无关，不计返工）。

## ④ Top5 耗时与总步时
Top5：5.3=178s ｜ 3.2b apply=137s ｜ 5.2=38s ｜ 3.0=33s ｜ U0.3=27s（并列 U2.1=27s）。
总步时 **551s**（A=90s / B=461s）。vs run11 408s（65+343）：增量 ≈143s，几乎全部由探针链深冷带宽（+94s）与本轮显式拆分基线/诊断行（U0.3 27s、0.4 12s 等）解释；**无任何返工贡献**。剔除本轮新增判据汇总辅助行（~20s）后的可比口径 ≈530s。

## ⑤ 新偏差清单
- **D-1（QA 工具/宿主 shim）**：辅助脚本 shebang `#!/bin/bash` 在本宿主 bad interpreter（与 undeploy 已知的 /bin rm shim 损坏同源）。建议：X 条款或 ISSUES 补一行"鸿蒙宿主辅助脚本 shebang 用 bash 实际路径（`command -v bash` 全展开）"。
- **D-2（X-4 补强建议）**：X-4① getcwd 噪音可经 `2>&1` 卷入判据捕获字段撕裂记录行。建议 X-4 追加半句："判据捕获用 `2>/dev/null` 或先落盘再摘 ASCII 字段"。
- **D-3（X-5 数值带）**：三探针链声明带 97~145s 低估深冷态（完整 undeploy→deploy 往返后即刻测）：本轮 239s（E7 无超时特征，链仍全 PASS 零复跑）。建议表述改"热 ~97s / 常规冷 ~145s / 往返后深冷 ≤250s；判据以零超时零复跑为准"。
- 无被测脚本功能性偏差；无 FAIL 步。

## ⑥ 终态矩阵（全绿）
| 项 | 期望 | 实测 |
|---|---|---|
| undeploy 自报核验 | 全[PASS] | **19/19**，[FAIL]=0 |
| deploy 三探针 | RESULT:PASS | **38/38**（20/20+5/5+13/13） |
| --check-fresh | FRESH | **FRESH** |
| 高危闸门 | disabledTools=8 | **8** |
| 隧道 | RUNNING/healthy/ownerMatch/!stale | **true×全中** |
| skill 就位 | 8 项 | **8**（含 hos-win-skill、winvm-orchestrator） |
| 宿主健康 | 200 | **200** |
| VM 五点（拆前→装后闭环） | 拆=False,False,0,Running,True；装=bridge_dir/task Running/listen 127.0.0.1:18443 1/sshd Running/workspace True | **两侧全符** |

## ⑦ 判定
**YES-with-nits** — 往返完整成功、判据全绿、**X-1/X-2/X-3 零复发（run11 三类返工全部消灭）、X-4 四类噪音实际命中且全部免疑惑放行**；nits 仅为 X-5 带宽数值上修建议（D-3）与两条采集姿势类小补充（D-1/D-2），不触及脚本功能性正确性。

数据文件：`~/wbtmp/run12-20261103/timings.csv`（39 行+表头）、`out/`（u1-dryrun/u2-apply/s23-verify/s32-dry/s32-apply/s41-install-host/s42-tunnel/s51/s52/s53 日志）、`ps1/`（heredoc 载荷留底）。

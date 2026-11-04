# 已知良好流程（判据摘录与耗时带宽）

用途：判断「慢是不是异常」「这步本来该输出什么」。数据源=run8/11/12 真机实测（V1.4.16/17 代际）。
判据权威原文始终以 docs/deploy/{deploy,undeploy}.prompt 为准，本文只摘数值与形态。

## 一、各环节预期耗时带（干净场景，宿主→VM 全链）

| 环节 | 预期带 | 异常信号 |
|---|---|---|
| U0 基线（find+VM 五点） | 15~30s | >1min=通道拥塞（查 timeout 挂起） |
| U1 DRY-RUN | 12~18s | — |
| U2 apply（真拆） | 13~27s | rc≠0 或 FAIL>0=按 troubleshooting B 表 |
| U4 独立复核 | 8~12s | 任何一项与期望不符=假拆嫌疑，立即停 |
| 3.0 ENV_PRECHECK | 20~35s | BLOCKERS≠none=按 P-2 审批补齐 |
| 3.2 deploy/setup apply | **125~140s**（热）；冷机首次可达 ~6min（420s 监听窗内即正常） | 超 420s 未监听=僵尸行处置 |
| 3.3 vmcheck | 15~20s | 七判据任一不符 |
| 4.1 install-host | 2~5s | errno=12=脆弱 node 行 |
| 5.1/5.2/5.3 探针 | 20~25 / 34~40 / 60~180s（链合计**热 ~97 / 冷 ~145 / 深冷 ≤250**） | 判据=零超时零复跑；单项 >300s 查服务端闸/网络 |
| 全程往返参考 | run8=8m35s · run11=408s 步时 · run12=551s（含深冷 +94s） | 显著超带且无新现象=先查 sshd 占满 |

## 二、拆除侧关键判据原文（形态）

- U1 首行必见 `mode : DRY-RUN`；KEEP 项至少含 workspace/authorized_keys；无意外 `[DO]` 越界项。
- U2 POST-CLEANUP 条数动态（宿主 9~11 + VM 8，历轮 19 条）=全 `[PASS]` 零 `[FAIL]`；`APPLY complete`。
- U4：`health=000`（拒连）/ cache absent / `GLOBAL_MCP_CLEAN` / VM 五点=`False False 0 Running True`（注意第 4 位 sshd 是 must-survive=Running）。

## 三、安装侧关键判据原文（形态）

- Step 0.2：`vmssh whoami` 出 `域\用户`；0.4：`NetworkCategory` 与规则 `Profile` 匹配即过（Private/Private OK）。
- 2.3 `RESULT: PASS`（files 881；已装态包根=883 on-disk 属运行期豁免，I-6.4 白名单）。
- 3.3 vmcheck 七判据：`task_state=Running`（或 N1 兜底态）、`listen_addr=127.0.0.1`、`listen_count=1`、`side_json=true`、`bridge_dir=true`、`health_http=200`、`health_body.ok=true`；V1.4.15+ 日志可含 `VM_START_SWEEP PID=…` 清扫显形。
- Step 4：隧道四判据全符（RUNNING/healthy/ownerMatch/!stale）+`FRESH`+`200`+`disabledTools=8`；`connector-states ⚠×2`=平台账户噪声放行。
- Step 5：`RESULT: PASS` ×3（20/20+5/5+13/13）；E7 记录耗时对 X-5 带。
- Step 6：连接器目录=8（含 hos-win-skill、winvm-orchestrator）。

## 四、拆除⇄安装回环验收基线

一轮干净往返的"完全合格"= 上述环节**零重试、零人工纠正、每步 rc=0**（run10/12 达成态）；任何一次脚本面 RETRY 都要在报告 issues 列写明「现象/根因/方案」——driver 的 steps.tsv 即为该报告数据源（`step.sh report` 直出 Top5/问题行）。

# run11 分步计时往返测试报告（V1.4.16 · undeploy v2.4 + deploy v3.0.5）

- 执行人：Edward（QA）｜日期：2026-11-02（UTC）｜场景：干净往返（无脏注入）
- 数据源：`~/wbtmp/run11-20261102/timings.csv`（39 行=36 有效步 + 3 重试运行记录）
- 纪律：单轨操作 VM；判据全按脚本原文；每步前后 `date -u +%FT%TZ` 原样落盘

## ① 双向分步计时表

### Phase A — undeploy v2.4（U0→U5）

| 步 | 内容 | 耗时s | rc | 结果 | 问题 |
|---|---|---|---|---|---|
| INJ | NODE/PY 探测（.mjs 冒烟门禁） | 0 | 0 | PASS（bundle node/PY 命中） | 噪音：宿主 getcwd 报错（沙箱固有） |
| U0.1 | 免密通道 vmssh whoami | 1 | 0 | PASS | none |
| U0.2 | WINVM_DRY_RUN=0 确认 | 0 | 0 | PASS | none |
| U0.3 | 拆除前基线（重试后） | 18 | 0 | PASS | 首次 3s RETRY=QA脚手架 env 未传（误导级，自查纠） |
| U1 | DRY-RUN 规划+安全阀核对 | 14 | 0 | PASS | none（1.2/1.3 判据全符，无越权落点） |
| U2.1 | 宿主+VM 一次性 --apply | 21 | 0 | PASS | 噪音：D3 良性 WARN×1（tunnel.state.json ENOENT 竞态，脚本已注明勿处置） |
| U4.1 | 复核自报清单 | 0 | 0 | PASS（19/19 全 [PASS]） | 首次 0s RETRY=QA脚手架相对路径（误导级，自查纠） |
| U4.2 | 独立复核：宿主 3 项+VM 五点 | 9 | 0 | PASS（000/absent/CLEAN + False/False/0/Running/True） | none |
| U5 | 存留项全默认保留 | 2 | 0 | PASS | none |

Phase A 有效合计 **65s**（含 3 次重试浪费 3s，共 68s）。

### Phase B — deploy v3.0.5（Step 0→6）

| 步 | 内容 | 耗时s | rc | 结果 | 问题 |
|---|---|---|---|---|---|
| 0.1 | 非空密码提醒（卡点①） | 0 | 0 | PASS | none |
| 0.2 | OpenSSH 在位探测 | 4 | 0 | PASS（whoami+sshd Running） | none |
| 0.3 | 电源设置提醒+guest 佐证 | 3 | 0 | PASS | 噪音：powercfg GBK 乱码（VM 码页，不影响判据） |
| 0.4 | 防火墙 Profile 诊断 | 10 | 0 | PASS（Private/Private 匹配） | 首次 15s RETRY=QA脚手架 $_ 本地展开（误导级——恰为脚本"禁内联含 $ 远端 PS"警告的本地翻版） |
| 0.5 | vmssh/vmscp 重试面确认 | 3 | 0 | PASS | none |
| 1.5 | 免密复核（1.1~1.4 跳过） | 2 | 0 | PASS | none |
| 2.0 | 本地包根判定 | 0 | 0 | PASS→跳下载 | none |
| 2.1/2.2 | 下载/解压 | — | — | SKIP（判据允许） | none |
| 2.3 | 三重校验 verify-manifest | 1 | 0 | PASS（881 声明/883 实存=I-6.4 豁免生效；total-sha MATCH） | none |
| 3.0 | 运行时硬门禁 vm-env-check | 26 | 0 | PASS（ENV_PRECHECK=PASS BLOCKERS=none） | none |
| 3.1 | .env 八字段逐项核 | 0 | 0 | PASS（8/8 OK） | none |
| 3.2d | deploy-vm DRY-RUN | 1 | 0 | PASS | none |
| 3.2a | deploy-vm --apply | **125** | 0 | PASS（VM/VM-START/QA-PROBE 全 ✅） | none |
| 3.3 | vmcheck 探针一次取全 | 18 | 0 | PASS（8 项判据全符；N1 兜底未触发） | none |
| 4.1 | install-host --yes | 3 | 0 | PASS（H1 双账户断言过） | 噪音：connector-states ⚠×2（平台账户态噪声，脚本已注明） |
| 4.2 | 判据①隧道 | 0 | 0 | PASS（RUNNING/healthy/ownerMatch/!stale） | none |
| 4.3 | 判据②FRESH | 0 | 0 | PASS（187 文件 SHA 一致） | none |
| 4.4 | 判据③health=200 | 2 | 0 | PASS | none |
| 4.5 | 判据④disabledTools=8 | 0 | 0 | PASS（落点=全局 mcp.json） | none |
| 5.1 | MCP 面 20 项 | 21 | 0 | PASS 20/20 | none |
| 5.2 | A2A 面 5 项 | 34 | 0 | PASS 5/5 | none |
| 5.3 | 示例能力 13 项 | 90 | 0 | PASS 13/13（E7 330s 窗内一次稳过；E11 sent=2 真跑） | none |
| 5.4 | 报告落仓库 | — | — | SUPERSEDED（按主理人指令改本文件） | none |
| 6.1 | skill 就位 ==8 | 0 | 0 | PASS（含 hos-win-skill+winvm-orchestrator） | none |
| 6.2/6.3 | 交付引导 | — | — | ADVISORY | none |

Phase B 有效合计 **343s**（含重试浪费 15s，共 358s）。

## ② 耗时 Top5 与占比（按有效总 408s）

| # | 步 | 耗时s | 占比 |
|---|---|---|---|
| 1 | B/3.2a deploy-vm --apply | 125 | 30.6% |
| 2 | B/5.3 example-probe（13 项） | 90 | 22.1% |
| 3 | B/5.2 a2a-probe（5 项） | 34 | 8.3% |
| 4 | B/3.0 vm-env-check 硬门禁 | 26 | 6.4% |
| 5 | B/5.1 + A/U2.1（并列 21s） | 21 | 5.1% |

Top5 合计 296s ≈ 72.6%。三探针链（5.1+5.2+5.3）=145s 占 35.5%，为最大可优化面；3.2a apply 为刚性长任务。

## ③ 问题清单（12 条记录，分级归因）

- **阻断级：0**（无任何产品脚本 FAIL）
- **误导级：3**——全部为 QA 脚手架自纠，非脚本缺陷：
  1. U0.3 helper 未 source env → vmssh/vmscp 未定义，且 tee 尾吞错致 rc 假 0（若未复核会掩盖失败；已重跑）
  2. U4.1 相对路径与计时器 cd 冲突
  3. B0.4 命令串 `$_` 被本地 bash 二次展开 → 远端 ParserError。**反向印证脚本 U4.2/1.4 "禁止内联含 $ 的远端 PS" 红线有效**——该坑真实存在，只是脚本已给出正确通道
- **体验级：0**
- **噪音级：4**（均已被脚本自身预言/注记，无需处置）：宿主 getcwd shim 报错、D3 tunnel.state.json ENOENT WARN（2.3 已注记良性）、powercfg GBK 乱码、connector-states.v3.json ⚠×2（4.1 注记平台账户态噪声）
- 其余记录行 issues=none（共 20 步）

## ④ 与 run8/run10 基线对比

| 指标 | run8 | run10 | run11（本轮） | 判读 |
|---|---|---|---|---|
| 往返总步耗时 | 515s | ~600s | **408s**（不含重试）/426s（含） | 显著优于两轮基线（-21% vs run8）；本轮口径=纯步内计时，不含 agent 思考间隙，与基线口径略有差异但同数量级 |
| 拆除链 | 13s | 16.6s | U2.1 apply=21s（全链含复核 65s） | apply 单项略升 5~8s，因 vmssh 三试封装+基线对照推送差异，链健康度无变化；run8/10 口径若仅 apply，则 21s 带内合理 |
| VM-START/3.2 apply | 48s | 127.4s | 125s | 与 run10 同带（±2%）；run8 的 48s 为更热 VM 态 |
| 三探针链 | ~97s | — | 145s | +48s：a2a E4 delegate 与 example E7/E8 走 LLM 常驻会话，本轮 llmSession 处于 starting 冷启窗口（vmcheck 侧证 wsLatestMb 15.2MB）拖慢首批调用；无超时、无复跑 |
| 重试次数 | — | — | 3（全为 QA 脚手架，产品 0） | 干净场景判据零漂移 |

## ⑤ 终态矩阵（全部实测，非自报）

| 项 | 期望 | 实测 | 证据步 |
|---|---|---|---|
| 三探针 | PASS | **38/38（20/20+5/5+13/13）** | B5.1/5.2/5.3 |
| 对账面 | FRESH | FRESH（187 文件） | B4.3 |
| disabledTools | 8（全局 mcp.json） | 8 | B4.5 |
| 隧道 | RUNNING 全项符 | RUNNING/healthy/ownerMatch/!stale | B4.2 |
| skill | 8（含两大件） | 8 + hos-win-skill + winvm-orchestrator | B6.1 |
| 宿主 health | 200 | 200（收尾复测仍 200） | B4.4+定稿核验 |
| VM 五点（安装态） | Running/127.0.0.1/1/200/side | vmcheck 8 判据全符（task_state=Running、listen_count=1、bridge_dir=true、side_json=true、会话 interactive healthy、sshd 存活经通道证明） | B3.3 |
| 存留项 | 全默认保留 | 密钥/trash×3/pkg/解包目录均在 | A-U5 |
| 包完整性 | PASS | verify-manifest PASS（883 文件含 I-6.4 豁免） | B2.3 |

## 结论

**可交付。** V1.4.16 双脚本在干净场景完成一次完整往返：拆除 19/19、三探针 38/38、全部判据按脚本原文一次通过（3 次重试均为 QA 脚手架自身缺陷并已自纠，产品脚本零缺陷零阻断）。噪音类 4 项均被脚本既有注记覆盖，无需产品侧改动。观察项 1 个：三探针链在 llmSession 冷启窗口下 +48s（run8 基线 97s → 本轮 145s），属运行时会话预热效应而非脚本缺陷，建议后续轮次在 E4/E7 前加 warm-up 等待或纳入趋势观察。

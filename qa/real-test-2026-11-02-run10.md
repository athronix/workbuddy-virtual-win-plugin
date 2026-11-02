# run10（终局轮）验证报告 · 脏场景 SWEEP 实弹复验 V1.4.16

日期：2026-11-02 · 执行人：software-qa-engineer-5（单轨授权）
包：V1.4.16（MANIFEST commit 102c3ea · verify-manifest RESULT: PASS 881 files · total-sha256 MATCH）
脚本：undeploy.prompt v2.4（包根原文逐段）+ deploy.prompt v3.0.5（包根原文逐段，Step 5 三探针=包根 qa/deploy-probes/）
日志全量：~/wbtmp/run10-20261102/

## 1 · 总表（步/判据/实际/PASS-偏差）

### Phase 1 拆除（U0→U5）
| 步 | 判据 | 实际 | 结论 |
|---|---|---|---|
| U0.1 | vmssh whoami rc=0 | `win-hos-ywang-s\user` rc=0 | PASS |
| U0.2/0.3 | DRY_RUN=0；基线在册 | 宿主/VM 基线全录 | PASS |
| U1 | DRY-RUN 清单核对零越界 | rc=0，KEEP 项正确（workspace/keys） | PASS |
| U2/U3 | --apply rc=0 + 19/19 [PASS] | rc=0，19/19（宿主11+VM8），无 D3 WARN | PASS |
| U4.2 | health=000 / cache absent / GLOBAL_MCP_CLEAN / VM 五连 False,False,0,Running,True | 逐项命中 | PASS |
| U5 | 全默认保留 | 密钥/trash/下载物/工作区未动 | PASS |

### Phase 2 脏注入
| 步 | 判据 | 实际 | 结论 |
|---|---|---|---|
| WMI Create ×2 | rc=0 + 2/2 ALIVE + 命令行含 WinVMBridge | INJECT1 rc=0 pid=13500 / INJECT2 rc=0 pid=8420；ALIVE_COUNT=2；CMD 均含 `WinVMBridge-decoy-R10` | PASS |
| 有效性 | VM-START 落存活窗 | t0=11:25:54Z，TTL 到期≈11:40:54Z，VM-START 相位≈11:31:00Z（窗内，且诱饵已跨 D9 10s 回收窗存活 5min+） | PASS |

### Phase 3 重装（Step 0→6）
| 步 | 判据 | 实际 | 结论 |
|---|---|---|---|
| 0 | 0.2 whoami 可达 / 0.4 Profile 匹配 | rc=0；Private/Private+Enabled=True（0.1/0.3 既有事实） | PASS |
| 1 | 已免密→1.5 复核 | publickey whoami rc=0 | PASS |
| 2 | 2.0 包根判定；2.3 三重校验 | MANIFEST+delivery 命中跳下载；RESULT: PASS；六关键件+docs 五件俱在 | PASS |
| 3.0 | ENV_PRECHECK=PASS & BLOCKERS=none | PASS / none（NODE_OK/NPM/CLI_OK 全 true；AUTH=config-dir-present） | PASS |
| 3.1 | .env 八字段 | 逐项核符（172.16.100.2/User/22/C:/WinVMBridge/18443/workbuddy/codebuddy/0） | PASS |
| 3.2 | DRY-RUN rc=0 → apply rc=0 | DRY rc=0；**apply rc=0（127.4s）** | PASS |
| 3.3 | vmcheck 七判据 | task=Running/127.0.0.1/count=1/side=true/dir=true/http=200/ok=true 全中；54 能力；session healthy（无 N1 Ready 兜底需求） | PASS |
| 4.1 | install-host rc=0 | rc=0（1.5s），13 写入+3 mcp 合并 | PASS |
| 4.2 | 隧道 RUNNING/healthy/ownerMatch/stateStale=false | true/true/true/false（pid 9757） | PASS |
| 4.3 | --check-fresh=FRESH | FRESH（187 文件） | PASS |
| 4.4 | health=200 | 200 | PASS |
| 4.5 | disabledTools=8 | len=8 | PASS |
| 5 | 三探针 RESULT: PASS ×3 | 20/20 + 5/5 + 13/13（E7 首跑即过·E7_TIMEOUT=330 在册·E11 真跑·E10 如实回报）rc 全 0 | PASS |
| 6.1 | skill=8 含 hos-win-skill+winvm-orchestrator | 8/8 含二者 | PASS |

## 2 · I-6.17 双判据结论：**FIXED-VERIFIED**

**时间线（VM 时钟 UTC）**：
- t0 注入 = **11:25:54.060Z**（PID 13500/8420，TTL 900s → 自然到期应≈11:40:54Z）
- VM-START .ps1 推送 = **11:30:48.263Z**（文件名 winvm-setup-1793619048263.ps1）
- SWEEP 击杀 ≈ **11:31:00~04Z**（脚本序列：SWEEP 显形→Terminate→sleep2→僵尸查→sleep1→/Run 反推）
- 新 vm-service 实例诞生 = **11:31:08.245Z**（PID 972 CreationDate）
- 独立确认 GONE = **11:32:15Z** 复查 `ALIVE_COUNT=0`；按 PID 直查 `PID13500=GONE / PID8420=GONE`

**判据A（动作生效）= PASS**：诱饵消失于 VM-START 相位后数秒内（11:31:00~08 窗），比 TTL 自然到期早 **≈9.9 分钟**；诱饵系 WMI 派生（非 ssh 后代，D9 排除 job object 回收假象），且已证明跨 10s 回收窗存活 5 分钟——死亡唯一解释=SWEEP 击杀。僵尸检查零 `VM_START_ZOMBIE_PID` 行=清扫彻底。
**判据B（日志显形）= PASS**：setup 日志恰含 2 行哨兵（计数≥2 达成）：
```
   [VM-START] VM_START_SWEEP PID=13500 NAME=powershell.exe
   [VM-START] VM_START_SWEEP PID=8420 NAME=powershell.exe
```
（D8 转印修复兑现——run9 中哨兵被 runRemotePs1 成功路径吞没，本轮经 forwardVmStartEvidence 显形且 PID 与注入 PID 精确对应。）
**服务本体无损 = PASS**：SWEEP 未误杀——vmcheck 七判据全中、health=200、54 能力、audit chainValid=true、psBridge ready restarts=0。

## 3 · 效率
- **总耗时**：Phase1 拆除 16.6s + Phase2 注入≈25s + Phase3 重装 538.3s（8m58s）≈ **10m00s**
- 对照 run8（干净场景）8m35s：Phase3 +23s——增项为诱饵注入/ALIVE 取证/GONE 取证三探针往返（实验固有开销），非流程退化
- 拆除 16.6s vs 基线 13s：+3.6s ssh 往返噪音，非阻断
- **重试次数：脚本面零**（vmssh/vmscp 三试面全程未触发第二试；deploy 链 rc 全 0 一次过）

## 4 · 新偏差清单
- **阻断**：零
- **误导**：零
- **体验**：2 条 nits——
  - N-A（记法歧义）：undeploy/deploy U0.1/1.5/0.2 写作"vmssh whoami 即 ssh -o …"，可被误读为把整条 ssh 命令作为 vmssh 参数传入（我实操首轮即中招一次：嵌套致远端自连 Host key verification failed rc=1；自查改回 `vmssh whoami` 即过。**脚本本体无错**，属阅读歧义，可在下版把"即"改为"等价于直连命令（勿嵌套）"）
  - N-B（计时观察）：拆除 +3.6s / 重装 +23s 均为取证探针与通道往返，列入观察非偏差

## 5 · 最终矩阵
| 维度 | run8（干净） | run9（脏·修复前） | **run10（脏·修复后）** |
|---|---|---|---|
| 拆除 19/19 rc=0 | ✅ | ✅ | ✅ |
| 重装全步 rc=0 一次过 | ✅ | ⚠（SWEEP 空转） | ✅ |
| 判据A 击杀生效 | n/a | ❌ I-6.17 | ✅ **GONE（TTL 前 9.9min）** |
| 判据B 日志显形 | n/a | ❌ 哨兵被吞 | ✅ **2 行 PID 精确对应** |
| 服务无损 | ✅ | ✅ | ✅ |
| 38 探针 | ✅ | ✅ | ✅ |
| 零重试 | ✅ | ✅ | ✅ |

## 6 · 终局判定：**YES**
脏场景下两脚本（undeploy v2.4 + deploy v3.0.5）完全按文一次过、零跳步、零脚本面重试；I-6.17 双判据 FIXED-VERIFIED；无阻断/误导级新偏差（2 条体验级 nits 记录在案，不构成停线）。**用户目标「直到完全按照 undeploy.prompt 和 deploy.prompt 进行测试验证可以高效顺利完成」达成。**

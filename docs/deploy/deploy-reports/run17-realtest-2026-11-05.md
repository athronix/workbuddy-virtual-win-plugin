# run17 · ssh2 后端独立验收（QA Edward，2026-11-05）

对象：commit **40c6c5d**（未 push）——ssh2-conn.mjs 新增 + vm-conn.sh 挂钩（VM_SSH_BACKEND=key|ssh2|auto）+ p7-ssh2-conn 单测。
视角：新鲜眼睛独立证明/证伪，未沿用实现者结论。产物日志：`~/wbtmp/vmdeploy-run17/`（steps.tsv、logs/*.log、taskB-probe.log、t0-undeploy.txt）。

## 判定：**NO（ssh2 新代码本体合格；全链往返被预存缺陷 D-1 + 覆盖缺口 D-2 挡住，deploy rc=1 不达三段全 0 标准）**

一句话：ssh2-conn.mjs 与 vm-conn.sh 挂钩本身实机恒通（ping 0.7s、put/exec/clean 全绿、run17 零 124 零挂死），**但 deploy.sh 在 C3/3.3 确定性硬败——根因不是 ssh2，是 ps-run.sh 子进程拿不到 vmssh 函数的预存缺陷（D-1），被 ssh2 快路径 1s export VM_CHANNEL=key 变成必现**。修 D-1（3 行）即可复跑全链。

---

## 任务 A 静态复查：结论与缺陷

### 独立复跑结果（全部本人实跑）

| 检查 | 结果 |
|---|---|
| `git show 40c6c5d --stat` | 3 文件 +480/-4，与自报一致 |
| `bash -n vm-conn.sh` | OK |
| `node --check ssh2-conn.mjs` | OK |
| `node --test tests/unit/p7-ssh2-conn.test.js` | **8/8 pass**（462ms） |
| `npm run gate:quick`（PATH=node） | **VERDICT: GREEN**（13 文件 269 测）；⚠ 注意：**gate 清单不含 p7-ssh2-conn**（GATE_GUARD_FILES 未登记，见 N-1） |
| 离线冒烟：loadClientCtor→ssh2-resolve 解析链 | `typeof Ctor=function (Client)`——仓库根 delivery/ssh2-resolve.mjs 候选①命中，解析链成立 |
| resolvePrivateKeyForConnect 报错形态 | 缺文件→「私钥文件不存在: <path>」；目录→EISDIR 原始码；经 main().catch 打印 rc=1，**均无密钥内容泄漏** |
| console.log 泄漏面扫描 | ssh2-conn.mjs **零 console.log**；仅 console.error（host 名/路径/e.message≤120 字符）；VM_HOST 未设时 stderr 只打「VM_HOST 未设（问用户）」不打 env 值；password 从不入任何输出 |
| ssh2 分支重试语义审查 | 111/124 才重试/兜底、远端码透传**自洽**（见 D-4 缺陷：重试与二进制保险丝交织的次序问题） |
| vmscp 判形审查 | 真实调用面（ps-run.sh:30 恒为 `<local> user@host:base`）判形正确；缺陷面见 D-5 |
| probe ssh2 快路径回退审查 | 回退完整（ping 失败→落 run15 五试全探）；但吞错见 D-8 |

### 缺陷四元组（现象/根因线索/复现/影响）

**D-1【阻断·预存缺陷（13efed0 引入，非 40c6c5d），被 ssh2 快路径变必现】ps-run.sh 子进程无 vmssh/vmscp 函数**
- 现象：run17 实机命中 4 处——`undeploy U0 0.3 baseline.log`、`U4 4.2 复核`、`deploy P0 preflight/C3.0 env-check`、`C3.3 vmcheck` 全部输出 `ps-run.sh: line 15: vmssh: command not found`；deploy.sh 于 C3.3 硬败 **rc=1 exit**。
- 根因线索：ps-run.sh:13 `if [ -z "${VM_CHANNEL:-}" ]; then . vm-conn.sh; vm_channel_probe; fi` ——deploy.sh:10/undeploy.sh:9/verify.sh:31 **source** vm-conn.sh 后 probe 快路径 `export VM_CHANNEL=key`（vm-conn.sh:144）；随后 deploy.sh:54/74、undeploy.sh:28/58、verify.sh:22/33 以 `bash ps-run.sh`（子进程）调用：子进程继承**变量** VM_CHANNEL 但**不继承 shell 函数** → line 13 条件为假不 source → vmssh 127。
- 复现（零 VM 触网）：`VM_CHANNEL=key bash deploy/skills/winvm-plugin-deploy/scripts/ps-run.sh -c 'Write-Output x' </dev/null` → line 15 `vmssh: command not found` rc=127。对照组：`env -u VM_CHANNEL ...` 同命令 → 自 source+probe → **rc=0 七判据全绿**（12:06:13Z 实测，见下）。
- 影响：deploy 链必断于 C3.3；VM 侧基线/终态行（task/listen/sshd）全被吞且**假绿**（D-3）；binary 后端理论同病（五试成功同样 export），但历史上 deploy 在相位挂下从未活着跑到 C3——本缺陷随 ssh2 快路径（1s 即 export）首次确定性暴露。修复属工程师业务代码动作：ps-run.sh:13 无条件 `. "$_here/vm-conn.sh"`，仅 `[ -z "${VM_CHANNEL:-}" ]` 时才 vm_channel_probe。

**D-2【阻断·结构性覆盖缺口】delivery 层不认 VM_SSH_BACKEND，仍全走 OpenSSH 二进制**
- 现象：deploy C3.2 的 prepare-vm/setup/uninstall 实际调用 `spawnSync('ssh'/'scp')`：bootstrap.mjs:164/167（runSsh）、prepare-vm.mjs:298、setup.mjs:327/364/678/**739（runRemotePs1 的 scp，全部 VM 侧 .ps1 铁律通道走它）**、uninstall.mjs:784/804/812/836。
- 根因线索：ssh2-conn.mjs:8-9 文档声称「vmssh/vmscp 加 ssh2 后端即可**全链**受益（driver：deploy/preflight/verify/ps-run/step 等）」——仅覆盖 skill shell 层（vm-conn.sh），delivery Node 层无挂钩点。
- 复现：run17 实测 prepare-vm.log 含远端 PS ParserError 输出（=ssh 真执行了→好相位+node 30s timeout 兜底未挂死）；undeploy U2 30s 完成同理。
- 影响：**灭相位下 deploy C3.2 与 undeploy U2 预期仍死**（二进制挂死点原样存在）；run17 通过是相位运气，不是 ssh2 防护。全链真豁免需 delivery 层 run()/runRemotePs1 认 VM_SSH_BACKEND 或统一走 ssh2（范围裁定：team-lead）。

**D-3【高·假绿纪律】失败被吞 + STEP 无条件 PASS**
- 现象：run17 steps.tsv 中 **C3/3.0 PASS** 而 env-check.log=`VMS scp 失败`（deploy.sh:54 `|| true` + 行 56 无条件 PASS）；**C2/2.3 PASS** 而 manifest.log=`RESULT: FAIL（882 undeclared file(s)`（deploy.sh:50 grep READINESS=RED 判据不覆盖 manifest rc，行 51 无条件 PASS）；U0 0.3/U4 4.2 PASS 而 VM 基线缺失（127 不置错 rc）；verify.sh:32-33 `&&` 短路吞 ps-run 失败后 STEP end 0 PASS。deploy.sh:52 READINESS=RED 才拦，preflight 把「PS 执行 rc=1（通道问题）」归 YELLOW 放行。
- 复现：本次 run17 即活体证据链。
- 影响：steps.tsv「6/6 PASS」的 undeploy 实际 VM 侧证据行为空转；计时表可信但判定列不可信。C2 manifest FAIL 是否历史已知无旧日志对照（run13/14/15 的 logs/ 均无 manifest.log——历史 deploy 没到过 C2 之后），按未定谳缺陷处理。

**D-4【中】vmssh ssh2 分支重试与二进制保险丝交织次序不自洽（vm-conn.sh:54-74）**
- 现象：backend=ssh2 时 i=1/2 传输层失败（111/124）→ 循环体继续走到 case 段**各多打一次二进制 ssh**（VM_CHANNEL 被 probe 置 key；灭相位时每发挂满 `timeout VM_SSH_TIMEOUT`=白等 25-30s）；i=3 才「3 试尽」退出（vm-conn.sh:61-63）——i=3 反而**不**跑二进制，与 i=1/2 行为不一致；且「ssh2 分支不依赖 VM_CHANNEL」的宣称（vm-conn.sh:141）与 case 段依赖 `${VM_CHANNEL:-key}` 矛盾。
- 复现：静态推读即得；实机因零 111/124 未触发。
- 影响：最坏延迟翻倍 + 兜底次序随机。建议 backend=ssh2 时二进制只在末次（i=3）跑一次，或加 VM_SSH2_NO_FALLBACK=1 纯 ssh2。

**D-5【中】vmscp(ssh2) 判形边角与 VM_CHANNEL=password 组合的隐性代价（vm-conn.sh:76-129）**
- 判形逻辑：a1 存在性检查在前，宿主上恰有同名**目录**（非 -f）且 a1 无 `:` → 静默落二进制兜底（backend=ssh2）→ 相位挂时整链死。当前唯一调用方（ps-run.sh:30）形态恒定，风险低但文档应写明「ssh2 后端仅保证 user@host: 与绝对正斜杠两形态」。
- 组合代价：VM_CHANNEL=password + backend=ssh2 时，put/get **成功**（rc=0 return 0）不受影响，但失败路径经 case password 分支跑 askpass 二进制（挂满 timeout）。真实调用面 password+ssh2 双开罕见。
- `_strip_scp_target` 只剥 `${VM_USER}@${VM_HOST}:` 前缀——异形 host 前缀（如别的 IP）原样透传 sftp 必失败，错误由远端码报出（可接受，建议报错文案点名「异形前缀未剥」）。

**D-6【低】配置类错误 rc=1 与 RC_INFRA=111 契约偏差（ssh2-conn.mjs:286-289）**
- 现象：VM_HOST 缺失/端口非法/私钥缺失/ssh2 解析失败均在 `main().catch` → **rc=1**（非 111）→ vm-conn.sh ssh2 分支把 rc=1 当「远端码」原样透传即停（不重试不兜底）。实机：`env -u VM_HOST node ssh2-conn.mjs exec whoami` → rc=1 stderr「VM_HOST 未设（问用户）」。
- 影响：方向保守（配置错误误重试反而有害），可接受；但「基础设施失败恒 rc=111」的 env 契约文案与实现有出入，建议文档校正或 catch 里按错误类别映射 111/2。

**D-7【低】put/get 工程细节**：无整体传输超时（靠外层 timeout+10s 兜底）；`mkdirRemoteP` 只建父目录一级（`C:/a/b/c.ps1` 若 a/b 不存在则 sftp 失败→111）；get 先攒内存再 writeFileSync（大文件内存占用）；stream 'close' 不触发时依赖外层 timeout。当前面全部 ≤ 探针 .ps1/日志体积，无实害。

**D-8【低】vm_channel_probe ssh2 ping 吞错（vm-conn.sh:143）**：`>/dev/null 2>&1` 失败仅报「回退二进制探测」不带 rc/stderr，违反本文件自己的四元组纪律（对比 run15 五试段的末次证据打印）；`VM_SSH_READY_TIMEOUT_MS/1000` 整除，<1000ms 时变 0（timeout 5=0+5 尚可，但语义应 clamp≥1s）。

**N-1【测试覆盖 nit】** p7-ssh2-conn.test.js 8 测仅覆盖 buildConnectOptions/resolvePrivateKeyForConnect/`--check`；exec/put/get/ping 透传语义、withConnection 超时、_ssh2_infra_rc、vmscp 判形（纯 shell，可用 bash 级 fixture）均无测——本轮实机恰好把测试缺口区全部走通并暴露 D-1，但回归防护为零。且 **GATE_GUARD_FILES 未登记 p7-ssh2-conn**：gate:quick GREEN 不含新测试文件（自报「gate GREEN」属实，但「8 测进门禁」不属实）。

---

## 任务 B 零冲击回归：**通过**

`unset VM_SSH_BACKEND` source vm-conn.sh 后（11:45:16Z，灭相位）：
- xtrace 证据：`[ key != key ]` 短路**不进 ssh2 分支**；五试全为 `timeout 25 ssh -o BatchMode=yes ... whoami`，last_rc=**124** 空 stderr×5，NO_CHANNEL 五试形态输出（taskB-probe.log，grep BatchMode=5 行）——与改前行为完全一致。
- 同刻对照：11:44:39Z `ssh2-conn.mjs ping` rc=0 **732ms**。
- 结论：默认后端零冲击成立；相位画像再添一组「二进制灭窗（11:45 五试全灭）↔ ssh2 恒通」实锤。

## 任务 C run17 实机全链往返：**undeploy ✓ / deploy ✗(D-1) / verify ✓ 38/38 + 终态全绿**

### 三段 rc 与时长（11:57:34Z → 12:15:49Z，串行、单轨、零并发）

| 段 | 窗口(UTC) | 真实 rc | 墙钟 | 依据 |
|---|---|---|---|---|
| undeploy.sh --apply | 11:57:34–11:58:34 | **0**（语义判据：steps 6/6 PASS + apply.log `APPLY complete... 19 项 [PASS]` + U4 GLOBAL_MCP_CLEAN + health=000） | 60s | ⚠ 当场 `UNDEPLOY_RC=$?` 取自管道 tail=0 非脚本 rc——结论靠上述独立证据钉死 |
| deploy.sh --apply | 11:59:27–12:03:40 | **1**（C3/3.3 FAIL→exit 1；stdout 无 DEPLOY_APPLY_DONE） | 253s（4m13.5s） | 同上，`DEPLOY_RC=0` 是 tail 假象，已在报告校正；steps.tsv C3.3 rc=1 FAIL |
| verify.sh | 12:10:15–12:15:49 | **0**（`VERIFY_RC=${PIPESTATUS[0]}` 正确取法 + VERIFY=PASS） | 334s（5m33.8s） | 探针 38/38 + 终态矩阵 |

### step.sh report Top5（run17 全 16 步 sum=638s）

```
244s  C3/3.2   prepare-vm --ensure-node + setup --apply --skip-build   （setup.log：部署全部完成✅ VM-START 36.7s/TUNNEL 51.4s/daemon pid 39980）
167s  VERIFY/5-example-probe   RESULT: PASS (13/13)
134s  VERIFY/5-a2a-probe       SUMMARY: 5/5 PASS
 30s  U2/2     --apply 真拆（APPLY complete 19 项全 PASS）
 24s  VERIFY/5-mcp-probe       SUMMARY: 20/20 PASS
```

### 探针计数（logs/*.log 原文）
- mcp-probe：`SUMMARY: 20/20 PASS, 0 FAIL` → RESULT: PASS
- a2a-probe：`SUMMARY: 5/5 PASS, 0 FAIL` → RESULT: PASS
- example-probe：`RESULT: PASS (13/13)`

### 终态矩阵（verify 原文 + 复核）
```
FRESH：缓存与仓库构建物逐文件 SHA256 全部一致（"实跑了 install-host 且此后未改 dist"已被当场证明）
winvm disabledTools=8
winvm-a2a disabledTools=0        ← 矩阵口径仅 winvm 行；a2a 行如实补记
health=200
connector skills=8
VM: task=... listen=... sshd=... ← 缺失行：ps-run.sh line15 vmssh 127 被 && 短路吞（D-1/D-3），
                                    但独立诊断证明 VM 侧实际健康：env -u VM_CHANNEL ps-run vmcheck.ps1
                                    → task_state=Running listen_count=1 health_http=200 session=healthy interactive=true
```
四项核心判据全绿；VM 行由 12:06:13Z 隔离诊断补齐（七判据全绿，rc=0，全程 ssh2）。

### 相位对照记录（run17 窗口内）
| UTC | 动作 | 结果 |
|---|---|---|
| 11:44:39 | ssh2 ping | rc=0（732ms） |
| 11:45:16–11:46 | 二进制五试（task B） | **5×rc=124**（灭相位） |
| 11:52:29 | 二进制 whoami | rc=0（**相位已翻好**） |
| 11:52:39 | ssh2 exec whoami | rc=0（<1s） |
| 11:57–12:15 | run17 全链（ssh2） | **零 124、零挂死**；每次 ssh2 子进程 0.3–1s 完成 |

C 的「ssh2 分支被真正用上」判定：C1/U0 probe 快路径打印「VM_SSH_BACKEND=ssh2：ssh2-conn ping 单发即通」，隔离诊断 xtrace 级复核 put→exec→clean 全走 ssh2 rc=0——**成立**；三段失败点全部可归因到非 ssh2 路径（D-1 函数缺失 / D-3 rc 吞没 / delivery 二进制段靠好相位幸存）。

## 系统终态
undeploy→deploy 完整重走一遍后：**已部署健康态**（服务 VM-START 拉起、隧道 daemon RUNNING、38/38 探针、FRESH）。修复 D-1 后复跑成本低：deploy.sh --apply + verify.sh（undeploy 可省，deploy 幂等）。

## 复跑清单（给工程师）
1. D-1：ps-run.sh:13 改无条件 source vm-conn.sh（probe 仅 VM_CHANNEL 空时）——3 行。
2. D-3：deploy.sh C3.0/C2、verify.sh VM 行、undeploy U0.3/U4 补 rc 检查，失败如实 FAIL。
3. D-2 范围裁定：delivery 层是否纳入 ssh2（setup/uninstall/bootstrap）——需 team-lead 拍板。
4. 复跑验收：VM_CHANNEL 预置场景加 bash 级回归测（哪怕 bats-less 的 bash -c 断言）+ p7-ssh2-conn 进 GATE_GUARD_FILES。

# run18 · D-1/D-3/D-4 回修独立复验（QA Edward，2026-11-05，收官轮）

对象：commit **cc07f54**（未 push，9 files +288/-83，delivery/ 零改动）——run17 判定 NO 后工程师回修。
视角：新鲜眼睛独立实跑，未采信任何自报（含「D1FIX_1236 rc=0」）。
产物证据：`~/wbtmp/vmdeploy-run18/`（steps.tsv、logs/*.log、undeploy-stdout.log、deploy-stdout.log、verify-stdout.log）。

## 判定：**NO（全链收官口径：deploy 出链 rc=1，未达「三段 rc 全 0」）**
### 但：**D-1 / D-3 / D-4 三项回修的独立复验 = 全部 PASS**；系统实质功能全绿（verify 38/38 + 终态矩阵含真实 VM 行）

deploy rc=1 的两个来源都不是 cc07f54 引入的回归，而是 **D-3 止血让两类一直存在的真实缺陷如实暴露**——这恰是 D-3 的正确职责（run17 判定的「假绿」被终结），按任务书预案「D-1 修好但新阻断=C2，报四元组交 team-lead 转工程师，勿自修」处置。

## 一、逐项复验依据（全部本人实跑）

| # | 检查 | 结果 |
|---|---|---|
| 1 | `git show cc07f54 --stat` | 9 files +288/-83，与自报一致 ✓ |
| 2 | `bash -n` ×5 driver（vm-conn/ps-run/deploy/undeploy/verify） | 全 OK ✓ |
| 3 | `node --check` ssh2-conn.mjs | OK ✓ |
| 4 | `node --test tests/unit/p7-ssh2-conn.test.js` | **12/12 pass**（应 12/12 ✓） |
| 5 | `npm run gate:quick` | **VERDICT: GREEN，files=14 tests=281**，且 ST3 清单含 `GREEN tests/unit/p7-ssh2-conn.test.js rc=0 tests=12 pass=12`（N-1 修复实锤——run17 时 files=13 不含）✓ |
| 6 | **D-1 复验·离线复现** | `env -u VM_HOST VM_CHANNEL=key VM_SSH_BACKEND=ssh2 bash ps-run.sh -c 'Write-Output x'` → **`ssh2-conn: VM_HOST 未设（问用户）` rc=1**（run17 前=127 command not found）——明确配置报错取代函数缺失，**PASS** ✓ |
| 7 | **D-1 复验·实机文件版**（run17 失败形态复跑） | 12:58:47Z `env VM_CHANNEL=key ... bash ps-run.sh vmcheck.ps1` → **rc=0**，七判据真输出（task_state=Running/listen_count=1/health_http=200/side_json=true/bridge_dir=true），19s ✓ |
| 8 | **D-1 复验·全链** | run18 U0 0.3 baseline.log **含真实 VM 行** `BRIDGE=True TASK=True LISTEN=1 SSHD=Running WS=True`（run17=vmssh 127 空转）；C3.0 env-check.log **含 `ENV_PRECHECK=PASS BLOCKERS=none NODE_OK=true CLI_OK=true`**（run17=VMS scp 失败）；C3.3 vmcheck.log 有七判据（run17 无→FAIL）；verify.sh 终态矩阵 **`VM: task=Running listen=1 sshd=Running` 真行在场**（run17 该行空转假绿）→ **D-1 修复确认生效** ✓ |
| 9 | **D-3 复验·steps.tsv 判定列** | run18 全 19 行**零假 PASS**：C2/2.3 rc=1 FAIL、C3/3.2 rc=1 FAIL 如实入表，report 的问题行/失败行两条均正确呈现；undeploy 6/6 PASS 经 baseline 真 BRIDGE= 行 + U4 真 VM 终态行核实为**真绿非假绿** → **D-3 修复确认生效** ✓ |
| 10 | **D-3 语义核 (a) 硬阻断是否真保留** | deploy.sh 静态复核：C1（probe 失败）/C2 取包（`STEP end C2 2.1 … exit 1`）/C3.2 setup（`if [ $SRC -ne 0 ] … exit 1`）/C3.3（`if [ $VC -ne 0 ] … exit 1`）/C4.1 install-host（`[ $HC -eq 0 ] || { … exit 1 }`）**五处即时 exit 原样保留**；FAILED_STEPS 仅接管非阻断段（C2 manifest/C3.0/C3.2 prepare-rc/C4.5/C5/C6）。undeploy：U0 0.1/U2 即时 exit 保留。→ **自洽，无「聚合替代阻断」的降级** ✓ |
| 11 | **D-3 语义核 (b) report 准确性** | issue_rows/失败行准确（见 #9）；但**发现计时失真**：C2/2.3、C4/4.5、C5/5.3 三行 `dur_s` 空白 → 见新缺陷 **P-5**（begin/end step-id 错位）|
| 12 | **D-4 复验·有界失败离线实测**（TEST-NET 192.0.2.1，不打真 VM） | 13:11:16Z `VM_SSH_TIMEOUT=1 VM_CHANNEL=key vmssh whoami` → stderr `vmssh: ssh2 传输层失败 rc=124（3 试尽）→ 二进制兜底一发`，**rc=124 透传**，总耗时 **29.5s**（TEST-NET 文档地址=必然超时形态，三试各撞满外层 timeout 6s + 2×5s 间隔 + 二进制兜底 1s，合计 29.5s 与拆解吻合）。**新序兑现：三试→兜底一发→透传，无旧「i=1/2 各混插一次二进制」交错，行为有界** ✓ |
| 13 | **D-8 复验** | `classifyScpShape`/`isRemoteLike` 纯函数入单测（含 D-5 目录名 unknown 负例 + shape CLI 零连接）；probe ping 失败现打 `rc=… stderr=[…前120]`，超时 clamp ≥1s ✓ |
| 14 | 凭据纪律 | ssh2-conn.mjs 仍零 console.log；shape 子命令不触凭据 ✓ |
| 15 | 相位 | 全程 13:00–13:15 ssh2 路径**零 124、零挂死**；无灭相位事件需记录（D-4 兜底行为以离线法取证，见 #12） |

## 二、run18 三段真实 rc 与计时表（13:00:01Z → 13:15:27Z，串行单轨零并发；rc 直取不接管道）

| 段 | 窗口(UTC) | **真实 rc** | 墙钟 | 出链哨兵 |
|---|---|---|---|---|
| undeploy.sh --apply | 13:00:01–13:01:24 | **0** | 1m23s | `UNDEPLOY_DONE`（steps 6/6 真 PASS） |
| deploy.sh --apply | 13:02:05–13:10:37 | **1** | 8m32s | `DEPLOY_APPLY_WITH_FAILURES: C2/2.3-manifest C3/3.2-prepare(rc=1)` |
| verify.sh | 13:12:00–13:15:27 | **0** | 3m27s | `VERIFY=PASS` |
| 全程 | 13:00:01→13:15:27 | — | **15m26s** | steps.tsv 19 步 sum_dur=604s |

### step.sh report Top5
```
229s  C3/3.2  prepare-vm --ensure-node + setup --apply --skip-build   （FAIL：prepare rc=1；setup 本体「部署全部完成✅」）
119s  VERIFY/5-example-probe   RESULT: PASS (13/13)
 62s  VERIFY/5-a2a-probe       SUMMARY: 5/5 PASS, 0 FAIL
 37s  C3/3.0  ENV_PRECHECK     （PASS，真 ENV_PRECHECK=PASS 行在场；旧 `|| true` 版仅 1s 空转）
 34s  U2/2    --apply 真拆     （APPLY complete 19 项全 PASS）
```

### 探针与终态矩阵（logs 原文）
- mcp-probe `SUMMARY: 20/20 PASS, 0 FAIL` / a2a-probe `SUMMARY: 5/5 PASS, 0 FAIL` / example-probe `RESULT: PASS (13/13)` → **38/38** ✓
- 矩阵：`FRESH：…SHA256 全部一致` / `winvm disabledTools=8`（winvm-a2a disabledTools=0 如实补记）/ `health=200` / `connector skills=8` / **`VM: task=Running listen=1 sshd=Running`**（run17 缺失行，本轮真在场）→ **终态矩阵全绿** ✓

## 三、新缺陷四元组（非 ssh2 引入，均系真实问题如实暴露）

**P-1（阻断=任务书预案命中项）deploy C2 manifest `RESULT: FAIL：882 undeclared file(s)`**
- 现象：deploy.sh:52-55 rc-capture 后 C2/2.3 rc=1 FAIL → FAILED_STEPS 聚合 → 出链 rc=1。
- 根因线索：overall-root 包内 882 个文件不在 MANIFEST.txt 声明集（`+ overall/delivery/setup.mjs` 等整目录级 undeclared）=发布清单与包内容漂移；**run17 同一命令即 `RESULT: FAIL`（日志活体），非本轮新增**，旧版被「无条件 PASS」吞掉。
- 复现：`cd ~/winvm-deploy/overall-root && /data/storage/el1/bundle/libs/arm64/python/bin/python3 qa/deploy-probes/verify-manifest.py .` → MRC_true=**1**（QA 独立复跑钉死；此前一次得 rc=0 系 `| tail` 管道末级假象，已按 run17 教训改用重定向取证）。
- 影响：deploy 全链 rc 永 1；属 publish/打包面（pack-release MANIFEST 生成）问题，**不在 skill 代码、不在 cc07f54 改动面**。处置权归 team-lead：或修 pack-release 声明集，或让 C2 判据降级为 YELLOW 注记。

**P-2（阻断同级）prepare-vm --apply DB-3 PowerShell ParserError rc=1**
- 现象：C3.2 `prepare rc=1`（steps.tsv rc=1 FAIL）；prepare-vm.log：`+ ... mand winget -ErrorAction SilentlyContinue) {,    Write-Output "[DB-3] …` → `CategoryInfo : ParserError` `FullyQualifiedErrorId : MissingExpressionAfterOperator` → `[FAIL] apply .ps1 非零退出（code=1）`。
- 根因线索：delivery/bootstrap.mjs 生成的 DB-3 apply .ps1 中 `{,` 数组拼接语法 PowerShell 不接受（`{ ,` 前置逗号=表达式缺失）——与 13efed0 自报「I-6.20 prepare-vm DB-3 三元数组展开（X-5，两态零逗号实证）」相悖，**疑该修复未覆盖本分支或发生漂移**；delivery/ 在 cc07f54 零改动，属预存问题在 ssh2 通道下首次可达暴露（run17/此前 deploy 从未活着到 C3.2 之后？——注：run17 到过 C3.2 且 rc=1 同错，只是被吞成 PASS 判据文本）。
- 影响：prepare-vm 的 DB-5 powercfg/DB-6 defender 幂等补齐段实际未执行（DB-1/2/3 探测 SKIP 正常）；setup.mjs rc=0 覆盖主干，功能面被掩盖但留痕失真。归工程师（delivery/bootstrap.mjs prepare-vm .ps1 生成）。

**P-3（中·D-3 残余面）verify.sh:37 VM 行管道末级 `tr` 吞 ps-run rc**
- 现象：`ps-run.sh -c '…' | tr -d '\r' || VRC=1`——ps-run 非零时管道 rc 取末级 tr=0，`|| VRC=1` 永不触发。
- 根因线索：作者已在 health 行正确规避（注释「管道末级 tee 恒 0，判据取内容」并 grep 内容判），但 VM 行未同法。
- 复现（离线）：`bash -c 'false | tr -d "\r" || echo detected'` → 不打印（实测）。
- 影响：VM 通道再坏（如 127/远端码非 0）时 VRC 不计数、终态矩阵可能假绿——**本轮恰好该 VM 行真输出成功，未触发；但假绿面残留**。建议：内容判据（`grep -q "VM: task=" `）或 `set -o pipefail` 局部化。

**P-4（中·潜在）undeploy.sh U4 health 双重吞**
- 现象：`HCODE="$(curl … )" || true`（命令替换内失败被外置 `|| true` 抹平）+ 判据 `HCODE=000`（curl 连不上时 -w 仍打 000，与「服务已拆」同值，无法区分 curl 自身失败）。
- 复现：静态推读 + U4 段 curl rc 未入判据（deploy.sh 对应段已入 HCRC）。
- 影响：拆不净时若 curl 异常返回空/000 仍可能判 PASS。建议与 deploy C4.5 对称：`HCRC` 入判。

**P-5（低·计时表失真）step.sh begin/end step-id 错位 → dur_s 空白**
- 现象：run18 steps.tsv C2/2.3、C4/4.5、C5/5.3 三行 dur 空；Top5/sum_dur 漏算（P-1 表可见）。
- 根因线索：deploy.sh `STEP begin C2 2`(:47)/`end C2 2.3`(:58)、`begin C4 4.1`(:102)/`end C4 4.5`(:111/114)、`begin C5 5`(:118)/`end C5 5.3`(:128)——stamp 文件以 id 命名，begin/end 不同 id 则 end 找不到 stamp（step.sh:31 `st="$RUN_DIR/stamps/$step"` 空→dur 空）。此错位 run17 已存在（steps.tsv C2/2.3、C4/4.5、C5/5.3 dur 同为空），属预存，但影响本轮「step.sh report 准确性」核项 (b)，如实登记。
- 复现：`grep -E "2\.3|4\.5|5\.3" ~/wbtmp/vmdeploy-run18/steps.tsv` 第 4 列空。
- 影响：慢步归因失真（本 deploy 8m32s 墙钟 vs tsv 求和少 ~3.5m）。建议 end 的 id 对齐 begin。

**P-6（低）ssh2-conn.mjs cmdExec stdout 无背压处理**：`stream.on('data', d => process.stdout.write(d))`——宿主 stdout 慢消费时 ssh2 流无暂停（大输出有 OOM/截断风险面；探针 .ps1 级输出无实害）。建议改 `pipeline`/`stdout.write 返 false 时 stream.pause()`。

**P-7（低·已声明面）withConnection 的 'error' 仅 pre-ready**：`settled=true` 后 conn 运行期 error 无监听 → 长 exec/put 中途断流靠 stream 'close'(code=null→111) 兜底。语义基本自洽（stream 级有 error/close），列此仅提示文档可注「ready 后错误走 stream 事件面」。

### run17 缺陷闭环确认（除登记外均已修）
| run17 | 状态 |
|---|---|
| D-1 | **修复生效**（#6/7/8 三态证据） |
| D-3 | **修复生效**（#9/10），残余=P-3/P-4（新登记，同级假绿面） |
| D-4 | **修复生效**（#12 有界 29.5s，次序统一） |
| N-1 | **修复生效**（#5 files=14 含 ssh2-conn 实跑行；12 测入 gate） |
| D-8 | **修复生效**（#13） |
| D-5（vmscp 判形目录名） | 修复：判形不了即显式报错（`return 2`），不猜——单测钉住 ✓ |
| D-2（delivery 层不认 VM_SSH_BACKEND） | **未动（任务书明示）**：P-2 的 prepare-vm、C3.2 的 setup.mjs、U2 的 uninstall 仍走 ssh/scp 二进制；本轮好相位幸存（U2 34s/C3.2 229s 无挂死），灭相位预期仍死 |
| D-6/D-7 | 未改（低优，配置错误 rc=1 语义保守可接受） |

## 四、终态与建议
- 系统现状：已部署健康态（undeploy→deploy 完整重走 + verify 38/38 + 矩阵全绿含 VM 行）；`DEPLOY_APPLY_DONE` 未现（聚合 rc=1），功能面无损。
- 全链 rc=0 的路径 = 处置 **P-1**（发布清单漂移）+ **P-2**（DB-3 .ps1 语法）；两者均非 ssh2/skill 后端缺陷，建议转工程师各开小修，QA 复跑 deploy+verify 两段即收官（~12min）。
- 零冲击回归：gate 14 件 281 测全绿覆盖原路径；默认 key 后端逻辑本轮 diff 未触碰非 ssh2 分支（vmssh/vmscp 的 for-case 循环原样），run17 任务 B 结论继续有效。

# 智能体安装脚本 Dogfooding 验证报告（prompt-verify-20261102）

被测对象：docs/deploy/undeploy.prompt v2.2 + docs/deploy/deploy.prompt v2.0.2（仓库 HEAD=6d03b5e，与运行态包根 /storage/Users/currentUser/winvm-deploy/overall-root 逐字节一致，cmp 实证）
执行人：software-qa-engineer (Edward)；日志目录 ~/wbtmp/prompt-verify-20261102/

## 1. 双向结果总表

### Phase 1 · 清理（undeploy.prompt v2.2）

| 步骤 | 文档判据 | 实际观测 | 裁决 |
|---|---|---|---|
| U0.1 免密 | vmssh whoami 输出用户名 rc=0 | win-hos-ywang-s\user, rc=0 | PASS |
| U0.2 | WINVM_DRY_RUN=0 | =0 | PASS |
| U0.3 基线 | 落点动态口径 find ~/.workbuddy -iname '*winvm*' + VM 两点 | 宿主 596 命中；mcp.json KEYS=winvm,winvm-a2a；disabledTools=8；VM BRIDGE/TASK/WORKSPACE=True, SSHD=Running | PASS |
| U1 DRY-RUN | rc=0；首行 "mode : DRY-RUN"；[DRY]/[DO]/[SKIP]/[KEEP] 逐项；安全阀核对 | 全部符合；trash 路径、两键、VM 相位计划清晰列出；无越界删除项 | PASS |
| U2/U3 --apply | rc=0；APPLY complete；核验清单全 PASS；[FAIL]=0 | EXIT=0；"APPLY complete…"；19/19 [PASS]；[FAIL]=0 | PASS |
| U2.3 旧包误报兼容判据 | V1.4.11 不应触发 G1 误报条款 | 未触发（无 "kept (observed: False)" FAIL、无 0 failure(s) 矛盾） | PASS（判据本身验证无误） |
| U4.2 独立复核·宿主 | curl→000；cache/winvm absent；GLOBAL_MCP_CLEAN | 000（拒连 rc=7）；No such file；GLOBAL_MCP_CLEAN；connectors 两账户 mcp.json CLEAN | PASS |
| U4.2 独立复核·VM 五点 | False/False/0/Running/True | False/False/0/Running/True 逐位一致 | PASS |
| U5 存留项 | 默认全保留、记录可操作性 | 密钥/trash/下载物均保留未动；5.1 子流程脚本可执行性评价=文案完整、命令与本轮实操通道一致 | 留（按指令） |

### Phase 2 · 重装（deploy.prompt v2.0.2）

| 步骤 | 文档判据 | 实际观测 | 裁决 |
|---|---|---|---|
| S0.1/S0.3 用户侧 | 提醒文案存在即判 OK | 行 61「非空密码」、行 74「电源"从不"」在文档内 | PASS |
| S0.2 | vmssh whoami 可达 | rc=0 全程可达 | PASS |
| S0.4 防火墙 | NetworkCategory 与规则 Profile 匹配 | 以太网=Private；OpenSSH-Server-In-TCP Enabled=True Profile=Private | PASS 无需修复 |
| S1（已在免密） | 1.5 判据复核即过，不重建 | publickey whoami rc=0 | PASS |
| S2 已有包根 | 2.3 判据② RESULT: PASS | 881 declared/883 on-disk（.env+winvm-plugin 豁免生效=I-6.4）；total-sha256 MATCH；RESULT: PASS | PASS |
| S2 判据③ | 六关键件+docs/deploy 五件 | 6/6 OK + 5 件齐 | PASS |
| S3.0 硬门禁 | ENV_PRECHECK=PASS 且 BLOCKERS=none | NODE_OK/CLI_OK=true、AUTH=config-dir-present、BLOCKERS=none、ENV_PRECHECK=PASS | PASS |
| S3.1 .env | 八字段核对 | 逐项相符（VM_HOST/USER/PORT/DEPLOY_DIR/18443/workbuddy/codebuddy/DRY_RUN=0） | PASS |
| S3.2 | DRY-RUN 后 --apply，rc=0 | dryrun_rc=0；apply_rc=0，[VM]/[VM-START]/[QA-PROBE] 三 ✅；cmd.exe 默认壳跨壳通道无碍（R8 实证） | PASS |
| S3.3 vmcheck | task=Running,listen=127.0.0.1,count=1,side_json,bridge_dir,health=200,ok=true | 七项全符（JSON 一次取全） | PASS |
| S4.1 install-host | rc=0 | install_rc=0；H1 断言 2/2；13 文件写入、3 mcp.json 合并 | PASS |
| S4.1 附 隧道自起 | （文档默认尾步自动拉起） | 自动拉起失败：V8 FATAL errno=12（hnp node 解释器继承，详见偏差 D2）；按文档兜底手动 ensure（换 bundle node）成功 | PASS（经文档兜底路径） |
| S4.2 | state=RUNNING, healthy=true, ownerMatch=true, stateStale=false | 四项全符，pid=22163 | PASS |
| S4.3 | --check-fresh → FRESH | FRESH（187 文件 SHA256 全一致） | PASS |
| S4.4 | health=200 | 200 | PASS |
| S4.5 | 全局 mcp.json winvm disabledTools=8 | winvm=8（winvm-a2a 键为连接器条目，无 disabledTools 属正常） | PASS |
| S5.1 mcp-probe | 20/20 RESULT: PASS | 20/20 PASS rc=0 | PASS |
| S5.2 a2a-probe | 5/5 RESULT: PASS | 5/5 PASS rc=0 | PASS |
| S5.3 example-probe | 13/13 RESULT: PASS；E7 首跑应直接 PASS | 13/13 首跑全绿 rc=0；E7 首跑直接 PASS 无瞬态；未触发复跑条件 | PASS |
| S6.1 | connector-winvm 8 skill + 含 hos-win-skill/winvm-orchestrator | 8 项、两关键件在 | PASS |

## 2. 脚本偏差清单（本次验证核心产出）

### D1【误导级】NODE 自动探测循环「后验覆盖」在 hnp-node 宿主上选中脆弱解释器，导致 4.2 隧道判据命令与隧道自启失败
- 文档原文位置：deploy.prompt 行 23-25（undeploy.prompt 行 21-23 同构）：
  `for c in /data/storage/el1/bundle/libs/arm64/node/bin/node /data/service/hnp/bin/node; do [ -x "$c" ] && NODE=$c; done`
- 实机事实：本宿主两候选均 -x，循环取**最后一个** → $NODE=/data/service/hnp/bin/node（symlink→node.org）。该二进制在本机当前内存压力下**执行 .mjs 文件即 V8 FATAL "Check failed: 12 == (*__errno_location())"（errno=12 ENOMEM）**，`-e` 内联却可用（诡异但可复现：winvm-plugin.mjs/tunnel-daemon.mjs/triv.mjs 均崩，uninstall.mjs/deploy-vm.mjs/install-host.mjs 侥幸通过——与文件驻留目录/加载路径相关性未深究，属宿主环境脆弱性而非脚本缺陷，但脚本选中了它）。install-host 尾步 spawn(process.execPath)=hnp node → daemon 即崩；文档 4.2 原命令按 $NODE 执行输出为空+崩溃横幅（pipe 掩盖 rc）。换 bundle node（文档候选第一位）则一切正常且一次拉起成功。
- 建议修正文案：探测循环改为「**首个可执行且通过最小冒烟测试**」：
  ```
  for c in /data/storage/el1/bundle/libs/arm64/node/bin/node /data/service/hnp/bin/node; do
    [ -x "$c" ] && "$c" -e '1' >/dev/null 2>&1 && printf 'x' > /tmp/.nw$$.mjs && "$c" /tmp/.nw$$.mjs >/dev/null 2>&1 && NODE=$c && rm -f /tmp/.nw$$.mjs && break; done
  ```
  并在 Step 4 排错速查补一行：「隧道 daemon 拉起报 V8 Fatal errno=12 / 无输出 → $NODE 选中了 hnp symlink node 的宿主内存压力缺陷，改用 bundle 路径 node 重跑 tunnel ensure，并检查 4.2 判据」。

### D2【体验级】undeploy U4.2 VM 复测模板 `(Get-NetTCPConnection...).Count` 在「有监听单对象」时输出空行
- 文档原文位置：undeploy.prompt 行 112-115。
- 实机事实：PS5.1 下单对象 `.Count`=$null（打印空行），仅 0 结果或数组时正常。拆除态恰好无监听输出 0，判据本次成立；但同模板若复用于「在装态应=1」核验会拿空值（对照实验：18443 有监听时 DOC_EXPR=空/ISNULL=True，`@(...)` 包裹=1）。
- 建议修正文案：模板改为 `( @(Get-NetTCPConnection -LocalPort 18443 -State Listen -ErrorAction SilentlyContinue).Count )`。

### D3【体验级】undploy U2 apply 对已被 daemon 自清的文件报 [WARN] ENOENT 噪音
- 实机事实：杀 tunnel daemon 后其退出钩子已删 tunnel.state.json，uninstall 再 trash 时报 `[WARN] failed to delete ... tunnel.state.json: ENOENT`，不影响 rc/清单/判据（该文件不在 4.1 必核清单），但智能体可能误停顿。
- 建议修正文案：undeploy.prompt U2.3 或排错速查补一句：「marker 文件 [WARN] ENOENT（daemon 自清竞态）属良性，判据以 POST-CLEANUP 清单为准，勿停下重拆」；或 uninstall.mjs 对 absent 文件静默 [SKIP]。

### D4【体验级】deploy Step 0.4 防火墙诊断命令是 VM 内 PowerShell 原生命令，未注明远程执行需转 .ps1 通道
- 文档原文位置：deploy.prompt 行 78-83。
- 实机事实：智能体在宿主执行时按铁律须包装成 .ps1→vmscp→-File（本次即如此操作，中文网卡名在 GBK 控制台显示乱码但 NetworkCategory 字段可读）。判据可达，但缺一句通道说明。
- 建议修正文案：0.4 诊断行后追加「（宿主远程执行：写入 .ps1 → vmscp → `powershell -File`，勿 ssh 内联）」。

### D5【体验级】deploy Step 2 对「本地已有包根直接复用」的入口可更显式
- 实机事实：标题行 116「（包已在本地可跳下载，直接 2.3 校验）」已覆盖本场景，实操顺畅；仅建议 2.3 前加一行 `ls $PKG_ROOT/MANIFEST.txt $PKG_ROOT/delivery/install-host.mjs || 回退 2.1 下载` 作为机械化判定，免智能体自行推断。属可选优化，非缺陷。

### 无偏差项（正面确认）
- undeploy v2.2 G1 旧包误报兼容判据：V1.4.11 不触发，判据描述与行为一致。
- deploy v2.0.2 Step 2 下载假设：与本地复用兼容（标题即许可）。
- R8 跨壳通道：deploy-vm apply / 全部手工 .ps1 / EncodedCommand 在 cmd.exe 默认壳下零失败。
- vmssh/vmscp 重试封装：全程未触发重试（本机桥接稳定），封装语法可粘贴可用。
- rm 禁令与 $NODE fs 兜底：本次宿主删除均由 uninstall.mjs 内部完成，未需手工兜底，纪律条款无冲突。

## 3. I-6.9 / I-6.10 修复表现证据
- **I-6.9（看门狗忙态误杀）**: example-probe E7 storage.cleanup.analyze **首跑直接 PASS**（traceId tr_mvyps0e1_14），无 HEARTBEAT_TIMEOUT、无复跑。v2.0.2 行 190-194 新口径（"首跑瞬态"预期退役）与实机行为一致——瞬态条款本轮零触发。
- **I-6.10（setup 假败）**：deploy-vm --apply **rc=0** 且末尾真实监听（VM-START ✅ + vmcheck listen_count=1/health 200 交叉证实），无「✅ 完成但服务没起」形态；install-host rc=0 与四项判据（FRESH/200/RUNNING/8）互相印证。

## 4. 最终运行态矩阵
| 维度 | 值 |
|---|---|
| health (127.0.0.1:18443) | **200** |
| 全局 mcp.json winvm.disabledTools | **8** |
| tunnel | **RUNNING**, healthy=true, ownerMatch=true, stateStale=false, pid=22163（bundle node 拉起） |
| 三探针 | **20/20 + 5/5 + 13/13 = 38/38**，全首跑全绿，RESULT: PASS ×3 |
| VM 五点 | task=**Running**；C:/WinVMBridge=**True**；listen=**1**@127.0.0.1；sshd=**Running**；C:/WinVMWorkspace=**True**（保留） |
| 交付面 | connector-winvm skills=**8**（含 hos-win-skill/winvm-orchestrator）；--check-fresh=**FRESH** |
| 存留项 | SSH 密钥、trash（~/.workbuddy/winvm-trash/ 含本轮 2026-11-02 时间戳批次）、下载物均保留 |

## 5. 结论
**YES-with-nits。** 两份 prompt 作为智能体安装脚本可直接交付：完整「清理→重装→全维度验证」往返在真机一次性走通，所有核心判据（rc、清单、三探针 38 项、VM 五点、对账/闸门）与文档描述逐项吻合，G1 兼容判据与 I-6.9/I-6.10 新口径经实测验证准确。唯一实质问题是 D1（NODE 探测循环在本宿主选中脆弱 hnp node，隧道段需手动换 bundle node 才过——文档自带 tunnel ensure 兜底使流程未阻断，但判据 4.2 的 $NODE 原命令在该态下不可用，建议下一版按 D1 文案修正）；D2-D5 为体验级小项。

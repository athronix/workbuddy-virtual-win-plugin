# 项目长期记忆 · winvm-virtual-win-plugin
> 跨会话事实。交接=`.workbuddy/README.md`；批次细节=`docs/archive/changes/`、`qa/p3-batch-sweep/`；决策台账=`~/winvm-deploy/deploy-session.md`（新会话先读）。

## 架构与拓扑
- 宿主 WB 插件操作 Win11 VM `172.16.100.2`：54 能力（system14/app8/appops5/storage13/gui11/meta3；L0:27/L1:19/L2:7/L3:1），工具名点分 `winvm__system.info.get`。双通道 `/mcp`（直调）+ `/a2a`（委派，审批流）同进程同隧道。VM 服务只听 `127.0.0.1:18443`，计划任务 `WinVMBridge.Service` 托管 `ps-bridge.ps1`（改 psmod/*.ps1 必重启）。
- VM：ssh 用户=**User**（非 towyq），密码非空**不落库**；Node=nvm-windows（prefix `%LOCALAPPDATA%\Author Software\nvm\installs\vXX`；**切版本→全局 CLI 消失需重装**；`npm i -g` 免提权；**winget 经 ssh=MSIX 空壳不可用**）。`C:/WinVMBridge` 程序、`C:/WinVMWorkspace` 工作区、`~/.workbuddy/winvm/side.json`。
- 宿主（鸿蒙沙箱 uid 20020171，$HOME 唯一跨 App 通道）：插件缓存 `~/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0/`＝运行态真相源（单文件白名单 9 件；**winvm-plugin.mjs 新增相对 import 必须同进 install-host extraFiles + buildIntegrityFilePairs** 再 `--check-fresh` 对账）；skills 缓存 `~/.workbuddy/connectors/skills/connector-winvm/`（**7 个 winvm-*；hos-win-skill host-only 在 `~/.workbuddy/skills/`；仓库共 8 Skill**）；`~/.workbuddy/winvm/{vm-conn.json,tunnel.*}`；`disabledTools` 落点=**全局 `~/.workbuddy/mcp.json`**。
- provider：默认 `workbuddy`+`WINVM_WORKBUDDY_CLI=codebuddy`（stream-json 常驻非 ACP）；对照档 `workbuddy-deterministic`；`hermes-agent`。ACP 方案=CL-WBNATIVE **DEFERRED**（取证在 archive）。安装一律 **@latest 不锁版本**。npm workspaces 12 包 TS ESM：`tsc -b tsconfig.build.json`；**单测禁整批**→`node --test <单文件>`。

## 关键坑（改码前必扫）
- MSYS：远端逻辑 `.ps1→scp→powershell -File`；ASCII 载荷；`$_` 内联必坏；公钥等参数 **base64 单参**传；杀隧道直 kill PID 勿 pkill -f。
- **空密码网络登录=两层串联**（PermitEmptyPasswords 默认 no + LimitBlankPasswordUse=1），只改一层必败；两层同改后建好免密**立即回滚**（deploy-strategy §2.1-B）。
- **大文档多轮 Edit 必静默缩水/回退（10-26 两次）**：改前 `git show HEAD:` 留基线；批量改动=一次性脚本+每处 assert count==1+不匹配整体拒写；写后立即 `wc -l`+锚点 grep+扫控制字符（python 普通串写 Win 路径 `\n\v` 会转义！）；commit 前后各核一次。
- 搜索假阴性：**Grep 工具与 `git grep` 都漏过** →清点用文件系统 `grep -rn` 交叉；仓库清点 `git ls-files`。
- provider=workbuddy **禁批量 tasks/cancel**（真机红线）。ssh `cmd &` 脱管、schtasks 拖死通道→轮询 /health。VM-START bind EACCES=socket 未 drain→清持有者+等待重试。
- 沙箱路径：git/node/python3 全路径（`.harmonybrew/opt/git` / `el1/bundle/libs/arm64/node` / `/data/service/hnp`）；/tmp 只读→`$HOME/wbtmp`；rm shim 坏→fs.unlinkSync；getcwd 异常→绝对路径。
- 隧道黑洞判据 ping 100% 丢；tunnel-daemon.mjs + HOURLY watchdog `aaa87da4`。版本指纹>uptime。改源必即 tsc -b；守卫经 dist 消费；**注释文本也是守卫输入面**。spawn 必挂 exit+error。GitHub 与 VM **两把密钥**（id_ed25519_github）。PS5.1 Sort-Object 裸键失效。GUI 依赖 LogonTrigger 已登录会话，锁屏不可解。

## 口径与纪律
- 测试基线权威=`qa/p3-batch-sweep/` 最新 gate-*.txt 汇总行（现 2280 GREEN；文档禁硬编码）。门禁 `npm run gate`。
- 发布：旧包 `release/V<ver>.superseded-itN`；台账 `docs/release/ISSUES.md`（hmdfs 大小写不敏感以 git 索引为准）；每迭代 --wipe 重验；完成必 push origin。V1.4.2=当前线上。
- 文档：导航权威 `.dev/docs-index.md`；归档 `docs/archive/{changes,audit,test}`+legacy-*（10-26 两次归位：OPS-OVERVIEW/INSTALL-VERIFY/根 overview/V1.0.0 notes；铠大师中文名保留——活引用+契约锚点）；**qa/ 保原位**（setup/pack-release 活引用）；改路径前先查活引用。证据每轮一份 real-test-<date>-runN.md；FAIL 四元组；裁决落档再引用。⚠ hmdfs `core.ignorecase=true`：git mv 改大小写**磁盘名可能不变**（ISSUES.md 案，10-26 两步 rename 实修），大小写敏感 glob/脚本会踩空。
- 团队派发：fresh Agent+窄任务书+即 commit+按 HEAD 独立核验；worker 静默 20min 熔断（主理人巡检 mtime+探针）。

## backlog（P2）
- **G-1 发 V1.4.3**（待用户批准）：V1.4.2 包(eba187e)早于 P2-3/4 修复→Release 安装回归非账户污染、缺 delivery/tools/；发版时把 `delivery/tools/`+`qa/deploy-probes/`(G-3) 收编 overall 并加 NON_ACCOUNT_DIRS 硬断言。污染回收站 `~/wbtmp/winvm-nonaccount-trash-20261026/`。
- **G-2** MANIFEST 无消费者→宜收编 `delivery/verify-release.mjs`（口径：per-file 段 `"<rel>  <sha>"` 双空格排序不含自身，total-sha256=sha256(rows)）。
- **G-3** deploy-probes 不进包：兜底=内联 `node -v; npm -v; codebuddy --version`。
- 其他：冷启动 49.3s TTL 保持 5min；teams 残骸永久不动；GUI preflight P2 观察。**VM 10-26 18:05 起不可达**（根因在 VM 自身），恢复后跑 mcp/a2a/example 三探针回归。

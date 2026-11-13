# 项目长期记忆 · winvm-virtual-win-plugin
> 跨会话事实。交接=`.workbuddy/README.md`；批次细节=`docs/archive/changes/`、`qa/p3-batch-sweep/`；决策台账=`~/winvm-deploy/deploy-session.md`（新会话先读）；发布台账=`docs/release/ISSUES.md`。

## 架构与拓扑
- 宿主 WB 插件操作 Win11 VM `172.16.100.2`：54 能力（system14/app8/appops5/storage13/gui11/meta3；L0:27/L1:19/L2:7/L3:1），工具名点分 `winvm__system.info.get`。双通道 `/mcp`（直调）+ `/a2a`（委派，审批流）同进程同隧道。VM 服务只听 `127.0.0.1:18443`，计划任务 `WinVMBridge.Service` 托管 `ps-bridge.ps1`（改 psmod/*.ps1 必重启）。
- VM：ssh 用户=**User**（非 towyq），密码非空**不落库**；Node=nvm-windows（切版本→全局 CLI 消失需重装；`npm i -g` 免提权；winget 经 ssh=MSIX 空壳不可用）。`C:/WinVMBridge` 程序、`C:/WinVMWorkspace` 工作区、`~/.workbuddy/winvm/side.json`。
- 宿主（鸿蒙沙箱 uid 20020171，$HOME 唯一跨 App 通道）：插件缓存 `~/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0/`＝运行态真相源（winvm-plugin.mjs 新增相对 import 必同进 install-host extraFiles + buildIntegrityFilePairs，再 `--check-fresh` 对账）；skills 缓存 `~/.workbuddy/connectors/skills/connector-winvm/`（7 个 winvm-*；hos-win-skill host-only 在 `~/.workbuddy/skills/`）；`~/.workbuddy/winvm/{vm-conn.json,tunnel.*}`；`disabledTools` 落全局 `~/.workbuddy/mcp.json`。
- provider：默认 `workbuddy`+`WINVM_WORKBUDDY_CLI=codebuddy`（stream-json 常驻非 ACP）；对照档 `workbuddy-deterministic`；`hermes-agent`。ACP 方案 DEFERRED。安装一律 **@latest 不锁版本**。npm workspaces 12 包 TS ESM：`tsc -b tsconfig.build.json`；**单测禁整批**→`node --test <单文件>`。
- 部署唯一执行权威=**winvm-plugin-deploy skill**（canonical `athronix/winvm-plugin-deploy`，使用侧 symlink；11-11 迭代28 用户裁定），两 `.prompt` 已退役=历史档案不入包。SSH 免密通道生命周期外委 **hos-winvm-ssh-tunnel**（唯一人工步骤=VM 管理员 PowerShell 粘一次公钥脚本）。

## 关键坑（改码前必扫）
- 远端壳双坑：Git-Bash/MSYS 路径转换 + Windows OpenSSH 出厂默认 cmd.exe（POSIX 语法必败；`ssh VM 'ver'` 出 Windows 版本行即 cmd.exe）。正解=复合逻辑 `.ps1→scp→powershell -File`、短片段 `-EncodedCommand`（base64 UTF-16LE）、写文件直 scp；**注释/文档文本也是断言输入面**。ASCII 载荷；杀隧道直 kill PID 勿 pkill -f。
- 空密码网络登录=两层串联（PermitEmptyPasswords no + LimitBlankPasswordUse=1），两层同改建好免密立即回滚。
- **大文档多轮 Edit 必静默缩水/回退**：改前 `git show HEAD:` 留基线；批量改动=一次性脚本+每处 assert count==1+不匹配整体拒写；写后 `wc -l`+锚点 grep+扫控制字符；commit 前后各核一次。
- 版本升版批必须 grep 全仓旧 tag 清点同步面（声称≠已改）；搜索假阴性：Grep/git grep 都漏过→`grep -rn` 交叉 + `git ls-files`。
- **动作级观测链三坑**（v1.7.0 E2E3 实证）：① `grep … | cut || echo "-"` 的 `||` 永不触发（管道退码取末命令）→ 先捕获再归一；② 日志名按**动作**（`env-check`）而环节号是 **`3.0`**，不建索引则 `log_path` 恒 `-` → `logs/.index` 记 epoch→名 + 时间窗解析；③ 沙箱每次 bash 启动的 `getcwd/chdir` 提示含 `error` 关键字，会污染 PASS 行错误摘录 → deny-list。
- **鸿蒙沙箱批量删除护栏（11-13 实证）**：单回合删除 >50 个文件会拦 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`，拦到的是**进程内 unlink/rmtree**（python shutil 也会被拦），表现为「子进程 rc=1 但一行 FAIL 都没打」→ 极易被误读成断言失效。对策：工具/门禁**默认零删除**（每例独立目录 + 原位还原，工作区保留并打印路径），要清才显式开；凡是「批量造→删」型测试脚本都要先算删除量。
- **探针口径必须可证伪**：「首跑 FAIL 复跑即稳」若含阈值临界（45s 心跳 vs 46s 冷）即确定性缺陷；客户端超时窗贴能力耗时跑=假 FAIL（判据窗须带实测耗时+余量）。
- **绝不自启 VM/guest 重启（最高红线）**：通道坏=探测利用健康窗跑最短链或止损上报。
- **WEDGE 持久态**：真凶=guest sshd 认证/会话建立段间歇挂起（banner 后 rc=124 空 stderr；网络层无罪）。窗口判定必用**新建连接实测**（长连健康≠新建可用）。**ssh2 后端**（`VM_SSH_BACKEND=ssh2` / ssh2-conn.mjs）是 WB 沙箱相位挂的正解（同秒 124 vs READY 654ms 实锤）；delivery 层已 ssh2 化（V1.4.21，三级默认 auto）。宿主重启可擦除 connector skills（mtime 取证）→`install-host --yes` 幂等恢复。
- provider=workbuddy **禁批量 tasks/cancel**；ssh `cmd &` 脱管、schtasks 拖死通道→轮询 /health；Windows OpenSSH sshd=job object 管会话，跨会话存活须 WMI Win32_Process Create 派生；**PS5.1 CIM 对象无 .Terminate()**（须 Invoke-CimMethod -InputObject）。
- 沙箱路径：git/node/python3 全路径（`.harmonybrew/opt/git` / `el1/bundle/libs/arm64/node` / `/data/service/hnp`）；/tmp 只读→`$HOME/wbtmp`；rm shim 坏→fs.unlinkSync；getcwd 异常→绝对路径。脆弱 node：`/data/service/hnp/bin/node` 跑 .mjs 内存压力下 V8 ENOMEM（`-e` 正常）→解释器必须冒烟门禁。
- **symlink 化改变路径等价性**：argv 字符串自比判 CLI main 永假（须 realpath 比对）；cpSync filter 黑名单对 symlink 源不可靠→发布复制必改白名单正向枚举（copySkillEntry）。改 skill 前必先 status 查 canonical 防就地漂移副本。
- 隧道黑洞判据 ping 100% 丢；tunnel-daemon.mjs + HOURLY watchdog `aaa87da4`；版本指纹>uptime；改源必即 tsc -b；**注释文本也是守卫输入面**；spawn 必挂 exit+error。GitHub 与 VM 两把密钥（id_ed25519_github）；PS5.1 Sort-Object 裸键失效；GUI 依赖 LogonTrigger 已登录会话，锁屏不可解。
- **skill 发布链规范（11-12 用户规范）**：双端 commit/push → 触发 GitHub `athronix/skills` 聚合同步（workflow_dispatch）→ 等 run 完成 → marketplace 版本比对 → 触发 Gitee `athronix/skills` 从 GitHub 聚合仓镜像同步（remote_mirror/pull）+ HEAD 追平确认。skill-dev-git canonical=`athronix/skill-dev-git` v1.5.1（gh 主路径候选回退 PATH→harmonybrew→~/.local/bin + run() PATH 注入；gh 缺位 REST API 降级；token 链 env>hosts.yml(workflow scope)>credentials）。
- **跨技能写接线契约前必实核双方代码**（迭代27 第一版三处臆测全错）；URL 分发形态改变路径拓扑，相对自身定位仓库的硬编码候选必走状态文件/env 单一事实源。

## 口径与纪律
- 测试基线权威=`qa/p3-batch-sweep/` 最新 gate-*.txt 汇总行（文档禁硬编码）；门禁 `npm run gate`。**当前线上 V1.4.28**（技能包同步 v1.9.0）。v1.4.28=探针 verdict 前置（C3.0 判据行早于 `npm ls -g` 等慢探测）+ 技能 v1.9.0 载荷预算分离入包；真机 e2e5 `ACTION=full` **VERDICT=YES**（23/23 动作 0 失败，1245s，从零安装）。前史：V1.4.27（迭代29 四批合一 + V11-6 自检门禁入包）。发布链断言面=V1–V11（V11 重构版六断言，钉技能四件+URL 章+roundtrip+通道外委章+四 driver+selfcheck）。旧包 `release/V<ver>.superseded-itN`；每迭代 `--wipe` 重验；完成必 push origin；发布顺序 pack→push origin→push gitee main+tag→publish --apply --mirror-gitee。
- **传输预算 ≠ 载荷预算（F-26，最高频误判）**：`vm-conn.sh` 的 `VM_SSH_TIMEOUT`(25s) 只管连接/握手/scp；远端 PowerShell **载荷**执行走 `ps-run.sh` 的 `_payload` → `VM_PS_TIMEOUT`(180s, 2 试)。本机探针载荷实测 47~56s（`Get-ScheduledTask`+`Get-NetTCPConnection`+`/health`+PS 冷启），旧版混用 30s 窗 ⇒ **`-File` 载荷超时=零输出**，形态酷似「通道彻底不通」（e2e4 vmcheck 153s rc=124 零输出，同通道 ping 2.6s 通）。**判据：rc=124 + 载荷零输出 → 先量载荷耗时，勿先怀疑通道**；禁为过关全局抬 `VM_SSH_TIMEOUT`。
- 文档：导航权威 `.dev/docs-index.md`；归档 `docs/archive/{changes,audit,test}`；**qa/ 保原位**（setup/pack-release 活引用）；改路径前先查活引用。证据每轮一份 `real-test-<date>-runN.md`；FAIL 四元组（现象/根因/证据/处置）；裁决落档再引用。⚠ hmdfs `core.ignorecase=true`：git mv 改大小写磁盘名可能不变。
- 团队派发：fresh Agent+窄任务书+即 commit+按 HEAD 独立核验；worker 静默 20min 熔断（主理人巡检 mtime+探针）。

## backlog / 当前态
- 技能 winvm-plugin-deploy **v1.9.0 已双端发布**（11-13 迭代33：传输预算/载荷预算解耦 —— `vm-conn.sh` 新增 `VM_SSH_EXEC_TIMEOUT`/`VM_SSH_TRIES`，`ps-run.sh` 载荷执行经 `_payload` 走 `VM_PS_TIMEOUT=180s`/2 试；自检 **16 项** + `--mutate` **6 组**（新增 F-26/M6）；另修一处空断言=`entries` 无条件预置 `RELEASE-VERSION.txt` 使子断言恒真。commit `7d92ea0` / tag v1.9.0 / marketplace 1.9.0 / Gitee 聚合 HEAD `5aa23d27`）。**e2e5 真机全绿**：`ACTION=full UNDEPLOY=PASS DEPLOY=PASS VERIFY=PASS WALL_S=1245`，23 动作 0 失败、0 失败四元组，强制重下 V1.4.28 真实分发包后从零安装，未重启 VM 未重建通道。前史：v1.8.0 门禁收编（`fa3697b`）、v1.7.0 统一入口（`ae5de39`）、v1.6.0 融入 hos（`68a3974`）。报告=`qa/real-test-2026-11-13-e2e5.md`、`qa/real-test-2026-11-13-e2e3.md`。
- **合并口径**：`Documents/Projects` 与 `Documents/projects` 是同一 inode（hmdfs 大小写不敏感）；hos 无 assets/templates；脚本靠 `SKILLDIR="$(dirname $0)/.."` 自定位故原名并入零逻辑改动；运行期状态目录 `$HOME/.workbuddy/.state/hos-winvm-ssh-tunnel/` 刻意共用；pack V11 断言面为字符串包含、改名「内置」后仍全绿。
- 母项目 **V1.4.28 已双端发布**（tag `V1.4.28`，GitHub 4 资产 + Gitee `id=1305949` 4 资产；overall zip 3081K sha256 `1417c4f798460509…`，skill zip 220K/40 文件 sha256 `c8999df0db08b788…`）。pack 的 V11 need 列表已显式钉死 6 个通道脚本 + v1.7.0 四新件 + `selfcheck.sh`（靠目录白名单自动收=静默漏件风险，勿退回）。
- **真机 E2E 第三轮**（`qa/real-test-2026-11-13-e2e3.md`）：F-17~F-25 全闭环，F-23/24/25 为动作观测链三修（驱动日志名 vs 环节号解耦 / 空摘录归一 `-` / 沙箱 getcwd 噪声 deny-list）。**仍未覆盖**：VM 侧合并包路径（通道坏→`NEED_USER_ACTION=1`）仅静态验证，需一次「先毁通道再卸载」真机演练（要用户执行合并包）。
- E2E 两轮记录 `qa/real-test-2026-11-12-e2e{,2}.md` + 原子台账 `qa/e2e2-ops-ledger.md`；第二轮终态 VERIFY=PASS。
- 低优：VM 内 codebuddy 交互登录待办、假绿残留 CLIXML 噪音、pkg-root bash 冒烟、Task #201 三处挂载 symlink 化收尾。

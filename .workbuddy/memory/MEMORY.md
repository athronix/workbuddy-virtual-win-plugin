# 项目长期记忆 · winvm-virtual-win-plugin
> 跨会话事实。交接=`.workbuddy/README.md`；批次细节=`docs/archive/changes/`、`qa/`；决策台账=`~/winvm-deploy/deploy-session.md`（新会话先读）；发布台账=`docs/release/ISSUES.md`。
> 本文件曾超限被截断，2026-11-17 精简；**完整旧版**=`MEMORY-full-20261117-1706.md`（含 V1.4.x / v1.9.x 逐版流水）。

## 架构与拓扑
- 宿主 WB 插件操作 Win11 VM `172.16.100.2`：54 能力（system14/app8/appops5/storage13/gui11/meta3；L0:27/L1:19/L2:7/L3:1），工具名点分 `winvm__system.info.get`。`/mcp`（直调）+ `/a2a`（委派审批）同进程同隧道。VM 服务只听 `127.0.0.1:18443`，计划任务 `WinVMBridge.Service` 托管 `ps-bridge.ps1`（改 psmod/*.ps1 必重启）。
- **另挂两个 stdio 上游工具面**（2026-11-17）：`/mcp/browser`（agent-browser 33 工具）+ `/mcp/desktop`（agent-desktop 75→白名单 10），宿主侧 `connector:winvm-browser` / `connector:winvm-desktop`，**共用同一条隧道**只差路径（`ConnectorDecl.mcpPath`）。由 vm-service spawn ⇒ **继承 Session 1** 才能读真实桌面；SSH 直启必得空桌面。见 `docs/02-design/MCP-UPSTREAM.md`、`packages/vm-service/src/mcp-upstream.ts`。
- VM：ssh 用户=**User**；密码非空**不落库**。Node=nvm-windows（切版本→全局 CLI 消失需重装；winget 经 ssh=MSIX 空壳不可用）。`C:/WinVMBridge` 程序、`C:/WinVMWorkspace` 工作区、`~/.workbuddy/winvm/side.json`。
- 宿主（鸿蒙沙箱 uid 20020171，$HOME 唯一跨 App 通道）：插件缓存 `~/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0/`＝运行态真相源（新增相对 import 必同进 install-host extraFiles + buildIntegrityFilePairs，再 `--check-fresh` 对账）；connector skills `~/.workbuddy/connectors/skills/connector-winvm/`；`~/.workbuddy/winvm/{vm-conn.json,tunnel.*}`；`disabledTools` 落 `~/.workbuddy/mcp.json`。
- provider：默认 `workbuddy`+`WINVM_WORKBUDDY_CLI=codebuddy`（stream-json 常驻非 ACP）；ACP DEFERRED。安装一律 **@latest**。npm workspaces 12 包 TS ESM：`tsc -b tsconfig.build.json`；**单测禁整批**→`node --test <单文件>`。
- 部署唯一执行权威=**winvm-plugin-deploy skill**（canonical `athronix/winvm-plugin-deploy`，使用侧 symlink），两 `.prompt` 已退役。SSH 通道生命周期外委 **hos-winvm-ssh-tunnel**（唯一人工步骤=VM 管理员粘一次公钥脚本）。

## 关键坑（改码前必扫）
- **通道后端默认必须 `auto`（不许退回 `key`）**：legacy 三层都是 `:-ssh2`；退化成 `key` ⇒ 鸿蒙宿主走 OpenSSH 二进制、认证段相位挂 `rc=124`、误报 `NO_CHANNEL`（同秒 `ssh2-conn.mjs ping`=pong ready + 裸 TCP 190ms 出 banner 即坐实）。门禁 `backend-default` + M16 双锁。
- **`All configured authentication methods failed` = 钥配错，不是通道坏**：`ssh2-conn.mjs` 默认读 `~/.ssh/id_ed25519`；技能层 `_common.sh` 才统一 `WINVM_VM_KEY=$HOME/.ssh/id_ed25519_winvm`。**绕过 `_common.sh` 直调必须自己带该变量**（11-17 实测踩到）。
- **载荷脚本必须 UTF-8 无 BOM，首行不许 `#requires`**（11-17 真机）：`-File` 解码时吞 BOM，`irm|iex` / `[scriptblock]::Create(<已解码串>)` 留着 BOM ⇒ 首行不再是指令 ⇒ `param` 脱离参数区 ⇒ 满屏「意外的属性 CmdletBinding / 意外的标记 param」，**脚本一行未执行**。另 `Invoke-RestMethod` 对 text/plain 可能返回 `string[]`，`Create` 会按 `$OFS` 拼成一行 ⇒ 1c 备选命令必须 `[string]::Join([char]10,@($s))`。门禁 `iex-safe` + M21/M22。
- **`ps-run.sh` 载荷含任何非 ASCII 即被门禁拒（`NON_ASCII_PAYLOAD`），中文注释也算**（11-19 实测踩 3 次）：表现是**约 1.6s 就返回、零输出**，酷似「脚本跑了但结论正常」⇒ 极易把假空当实测结论。判据：总耗时远小于脚本该有的耗时（如造 5000 文件却 1.6s 结束）就先查 `NON_ASCII_PAYLOAD`。备用判据：`grep -a`（输出含 CLIXML 二进制，普通 grep 会静默漏）。
- 远端壳双坑：Git-Bash/MSYS 路径转换 + Windows OpenSSH 出厂默认 cmd.exe（`ssh VM 'ver'` 出 Windows 版本行即 cmd.exe）。正解=复合逻辑 `.ps1→scp→powershell -File`、短片段 `-EncodedCommand`、写文件直 scp；**注释/文档文本也是断言输入面**；ASCII 载荷；杀隧道直 kill PID 勿 pkill -f。
- 空密码网络登录=两层串联（PermitEmptyPasswords no + LimitBlankPasswordUse=1），建好免密立即回滚。
- **大文档多轮 Edit 必静默缩水/回退**：改前 `git show HEAD:` 留基线；批量改=一次性脚本 + 每处 `assert count==1` + 不匹配整体拒写；写后 `wc -l` + 锚点 grep + 扫控制字符。
- 升版批必 grep 全仓旧 tag 清点同步面（声称≠已改）；搜索假阴性→`grep -rn` 交叉 + `git ls-files`。
- **动作级观测链三坑**：① `grep|cut || echo "-"` 的 `||` 永不触发（管道退码取末命令）→ 先捕获再归一；② 日志名按**动作**而环节号是 `3.0`，不建索引 `log_path` 恒 `-`；③ 沙箱每次 bash 启动的 `getcwd/chdir` 提示含 `error`，污染 PASS 行摘录 → deny-list。
- **鸿蒙沙箱批量删除护栏**：单回合删 >50 文件拦 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`，拦的是**进程内 unlink/rmtree**（python shutil 也拦），表现「子进程 rc=1 但一行 FAIL 没打」→ 易误读成断言失效。对策：门禁**默认零删除**（独立目录 + 原位还原 + 打印路径）。
- **探针口径必须可证伪**：「首跑 FAIL 复跑即稳」若含阈值临界即确定性缺陷；客户端超时窗贴能力耗时跑=假 FAIL。
- **绝不自启 VM/guest 重启（最高红线）**。
- **WEDGE 持久态**：guest sshd **预认证段**停摆（TCP 连上但 12s 零 banner，网络层无罪）。**`health=200` 是长连口径，不是通道判据**（「health 恒 200 + 新建全死」可长期共存）。三段取证=`ping` / **裸 TCP 读 banner** / 宿主 health。**复活法（不重启 VM，用户批准后）**：隧道长连可用时经 MCP `system.service.control{name:"sshd",action:"restart"}`，修完 `ssh2-conn.mjs ping`=pong ready。反证过：静默 180s 后仍超时 ⇒ 非探测风暴；VM 内仅 2 个 sshd-session ⇒ 非会话堆积。**11-17 实例**：ping 0% 丢包 + 裸 TCP 12s 零 banner + 隧道/health 均不在 ⇒ 由 oneclick 的 `[9/9]` 重启 sshd 顺带修复。宿主重启会擦空 connector skills（mtime 取证）→ `install-host --yes` 幂等恢复。
- provider=workbuddy **禁批量 tasks/cancel**；ssh `cmd &` 脱管、schtasks 拖死通道→轮询 /health；sshd=job object 管会话，跨会话存活须 WMI `Win32_Process Create` 派生；**PS5.1 CIM 对象无 .Terminate()**（须 `Invoke-CimMethod -InputObject`）。
- 沙箱路径：git=`$HOME/.harmonybrew/opt/git/bin`、node=`/data/storage/el1/bundle/libs/arm64/node/bin`、python3=`/data/service/hnp/bin`；/tmp 只读→`$HOME/wbtmp`；rm shim 坏→fs.unlinkSync；`/data/service/hnp/bin/node` 跑 .mjs 内存压力下 V8 ENOMEM（`-e` 正常）→解释器必冒烟门禁。
- **symlink 化改变路径等价性**：argv 字符串自比判 CLI main 永假（须 realpath）；cpSync filter 黑名单对 symlink 源不可靠→发布复制改白名单正向枚举（`copySkillEntry`）。改 skill 前必 status 查 canonical 防就地漂移。
- 隧道黑洞判据 ping 100% 丢；`tunnel-daemon.mjs` + HOURLY watchdog `aaa87da4`；版本指纹>uptime；改源必即 `tsc -b`；spawn 必挂 exit+error。GitHub 与 VM 两把钥（`id_ed25519_github` / `id_ed25519_winvm`）；PS5.1 `Sort-Object` 裸键失效；GUI 依赖 LogonTrigger 已登录会话，锁屏不可解。
- **skill 发布链**：双端 commit/push → GitHub `athronix/skills` 聚合同步（workflow_dispatch）→ 等 run → marketplace 版本比对 → Gitee `athronix/skills` 镜像同步 + HEAD 追平。skill-dev-git canonical v1.5.1（PATH 候选回退 + REST 降级 + token 链）。
- **跨技能写接线契约前必实核双方代码**（曾三处臆测全错）；URL 分发形态改变路径拓扑，硬编码候选必走状态文件/env 单一事实源。

## 口径与纪律
- 测试基线权威=`qa/p3-batch-sweep/` 最新 gate-*.txt 汇总行（**文档禁硬编码**）；门禁 `npm run gate`；技能门禁 `bash scripts/selfcheck.sh --mutate`。
- **传输预算 ≠ 载荷预算（F-26，最高频误判）**：`VM_SSH_TIMEOUT`(25s) 只管连接/握手/scp；远端 PS **载荷**走 `ps-run.sh` 的 `_payload`→`VM_PS_TIMEOUT`(180s, 2 试)。载荷实测 47~56s，混用 30s ⇒ `-File` 超时=**零输出**，酷似「通道彻底不通」。**判据：rc=124 + 零输出 → 先量载荷耗时**；禁为过关全局抬 `VM_SSH_TIMEOUT`。
- 文档：导航 `.dev/docs-index.md`；归档 `docs/archive/{changes,audit,test}`；**qa/ 保原位**（活引用）；证据每轮一份 `real-test-<date>-runN.md`；FAIL 四元组（现象/根因/证据/处置）。⚠ hmdfs `core.ignorecase=true`：`git mv` 改大小写磁盘名可能不变。
- 团队派发：fresh Agent + 窄任务书 + 即 commit + 按 HEAD 独立核验；worker 静默 20min 熔断。
- 发布顺序：pack → push origin → push gitee main+tag → `publish --apply --mirror-gitee`；**tag 打在 pack 提交**，不是 pack 后的 HEAD；旧包 `release/V<ver>.superseded-itN`；每迭代 `--wipe` 重验。

## 当前态（2026-11-18 11:55）
- **母项目线上 V1.4.32**（tag `V1.4.32`=`e63300e`，双端一致）：overall 3285135B / sha256 `018f8ff4…`；GitHub 4 资产（overall asset 761824572）+ Gitee release id=1322433。内容 = 桌面白名单 **10→25**、两个上游技能面、`uninstall` 键表修复、4a 合并探测 + 上游 npm 合并 + PATH 单次 PS + **防火墙注册表直读**。
- **技能仓 main = v2.3.0**（tag 由 `skill_dev.py release` 创建；marketplace **已追平 2.3.0**；Gitee 镜像 HEAD `ab02cfa2`），包 **28 文件/184K**。5 步部署（4 步含 4d、5 步含 5e）+ 3 步卸载。
  - **门禁 `ALL_GREEN checks=25 fails=0` / `ALL_CAUGHT 29/29`**。
- **1p 三级策略（v2.3.0）**：准入只看「能登录」（口令 **或** 空口令 `WINVM_SSH_PASSWORD_EMPTY=1`）→ `net session` 判身份选授权文件（管理员→`%ProgramData%\ssh\administrators_authorized_keys`；否则→用户级 `.ssh`）→ **ACL 用 SID、不重启 sshd** ⇒ S1 约 3~5s 不断连；S1 回验不通过才 S2 oneclick；仍不通 S3 退 2 回人工 1c。
- **11-18 真机**：`deploy.sh --only 4` → `DEPLOY=PASS` WALL **323s**（4.0=2s / 4a=60s / **4b=218s**[VM 155.7+VM-START 47.3+QA-PROBE 14.8] / 4c=34s / 4d=8s，**desktop=25** 已确认）。
- **待办**：
  1. 🔴 **`4b` 加「内容未变则短路」** —— 仍是最大头：每轮无条件 tar+scp+install+重启。正解=VM 侧 `MANIFEST-deploy-*.txt` 补 `total-sha256`（源内容哈希，与 tar 时间戳无关）比对后短路，预计 **-100~140s/轮**。
  2. 小项：QA-PROBE 两次 scp + MANIFEST 写两遍（日志重复两行）≈ -5s；4a 的 `--apply` 段 43s 未拆；VM-START 轮询细化 -3~5s（收益不抵风险）。
  3. 上游 `npm i -g` 首装 47.9s：不需要时 `SKIP_UPSTREAMS=1`。
  4. 第 1 步「从零通道」真实演练（1p 的 S1 是直调载荷验证 + 口令错误/空口令降级验证，**未在真·从零机器上端到端跑过**）；低优：codebuddy 交互登录、CLIXML 噪音、pkg-root bash 冒烟、Task #201 symlink 化。
- **坑**：`skill_dev.py release` 自己建 tag，**先手动打 tag 会报 `tag already exists — bump frontmatter version`**（正确顺序：commit/push → release 建 tag）。项目门禁 `RED` 要先做 `git stash` 归因实验（11-18 实测 5 文件/17 用例为沙箱缺 fixture 的既有失败，如 `p8-probe-fresh` 依赖的 `deploy/skills/.../probe-fresh.sh` 不存在 ⇒ `status=127`）。
- **合并口径**：`Documents/Projects` 与 `Documents/projects` 同 inode；hos 无 assets/templates；运行期状态目录 `$HOME/.workbuddy/.state/hos-winvm-ssh-tunnel/` 刻意共用。

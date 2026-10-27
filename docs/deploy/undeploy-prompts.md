# WinVM Bridge · 卸载 Prompt 总集（undeploy-prompts）

> 文档 ID：UNDEPLOY-PROMPTS-v1
> 状态：**卸载器已真机实测通过**（dry-run→apply→POST-CLEANUP 核验全 PASS、零 FAIL；清单按运行态动态生成，判据=全 [PASS] 零 [FAIL]，历史 16~17 项、修复不对称后 19 项）
> **2026-10-27 回环实测（run1）**：按本文 U0~U4 拆除 → deploy-prompts Step 3~5 重装 → 三探针 38/38 全绿；
> 实测揪出并修复两处镜像不对称（U-1 全局 mcp.json 不清、U-2 tunnel-autostart.json 残留，见 §9 v1.1）。
> 证据：`qa/evidence/uninstall-pre-run3.log`（16 项）、`qa/evidence/cleanup-20261026/uninstall-apply-*.log`（17 项）、`qa/real-test-2026-10-27-run1.md`（拆除 19/19 + 重装回绿）
> 更新：2026-10-27
> 上游：`delivery/uninstall.mjs`（双端一键卸载器，本文件的判据真源）、`docs/deploy/deploy-strategy.md` §6（回滚与清理）、`docs/INSTALL-GUIDE.md`（逐项细节）
> 对偶：`docs/deploy/deploy-prompts.md`（部署 Prompt 总集）——本文件是它的**逆向镜像**
> 用途：把本文档的 Prompt 块粘给 WorkBuddy（鸿蒙宿主），即可把双端部署**干净拆除**，或为清场重装（`--wipe`）做准备

---

## 1. 使用方式

| 场景 | 用哪块 |
|---|---|
| 一次拆干净（推荐） | §3 总 Prompt（单块，含 U1~U5 与判据） |
| 分步做、每步人工确认 | §4 分步 Prompt（U1~U5 独立可粘） |
| 只为清场重装（`--wipe` 前置） | §3 总 Prompt + 保留 SSH 密钥（见 §7 存留项，**不删 `~/.ssh`**） |
| 彻底告别（连密钥/工作区一起清） | §3 后追加 §7 的「彻底清理」分支 |
| 只想复跑拆除核验 | §5 核验速查 |
| 出问题了 | §6 排错速查 |
| 换机器/换环境拆除 | 先改 §2 变量表，再粘 Prompt |

**前置**：宿主侧需有 `ssh` / `scp` / `node`；拆除**不需要** Release 包与下载物（卸载器读运行态即可）。
VM 侧免密通道需**仍然可用**（`ssh User@$VM_HOST whoami` 成功）——卸载器的 VM 相位靠它下发 `.ps1`。

> **与部署的关键差异**：部署是「从零装到 25/25」，卸载是「从有到零且**不越界**」。
> 卸载器的设计红线是**镜像拆除**——只删安装体系自己放下去的东西，OS 级配置（SSH 服务、密钥、
> Node 运行时、其它插件）一律**不动**。判断"该不该删"的唯一标准：是不是 `install-host/install-vm/setup/deploy-vm` 放进去的。

---

## 2. 卸载变量（粘 Prompt 前先确认）

> 与部署共用同一批环境值（见 `deploy-prompts.md` §2），此处只列**影响拆除范围**的项。
> ⚠️ 密码不入库、不写文件：只经运行期环境变量 `WINVM_SSH_PASSWORD` 注入（仅当免密已失效需重建时）。

### 2.1 目标环境（与部署一致）

| 变量 | 默认值 | 说明 | 确认 |
|---|---|---|---|
| `VM_HOST` | `172.16.100.2` | Windows VM IP | ☐ |
| `VM_USER` | `User` | VM 账户 | ☐ |
| `VM_SSH_PORT` | `22` | sshd 端口 | ☐ |
| `HOST_WB_HOME` | `~/.workbuddy` | WorkBuddy 主目录（拆除根） | ☐ |

### 2.2 拆除范围开关（`uninstall.mjs` 的形参）

| 变量 / 形参 | 默认 | 含义 | 确认 |
|---|---|---|---|
| `--apply` | **关**（缺省=DRY-RUN 只列清单） | 不带 `--apply` 一律只规划、**零改动**；确认可执行后再加 | ☐ |
| `WINVM_DRY_RUN` | `0` | ⚠ **=1 会把 `--apply` 也降级成 dry-run**（与部署同一坑，假"已拆除"） | ☐ |
| `--keep-workspace` | **默认即保留** | 保留 `C:/WinVMWorkspace`（运行期用户数据）；形参只为显式表达意图 | ☐ |
| `--purge-workspace` | **关** | **连带删除 `C:/WinVMWorkspace`（不可逆，毁运行期数据）** | ☐ |
| `--keep-keys` | **无行为**（设计即不碰密钥） | 显式声明"不动 SSH"；卸载器**永不**删 `~/.ssh`/`authorized_keys`/OpenSSH Server | ☐ |
| `--vm-host/--vm-user/--vm-ssh-port` | env > `~/.workbuddy/winvm/vm-conn.json` > 报错 | 覆盖 VM 地址（vm-conn.json 已不在时须显式传） | ☐ |
| `--host-root <dir>` | `~/.workbuddy` | 覆盖 WorkBuddy 根 | ☐ |
| `--trash-dir <dir>` | `~/.workbuddy/winvm-trash` | 宿主侧删除物**移入此处**（非直接 rm，可回滚） | ☐ |

### 2.3 拆除落点（`uninstall.mjs` 头注的镜像清单，逐项对应安装体系；18 项=10-27 回环修复后全貌）

| # | 端 | 落点 | 谁放的 | 动作 |
|---|---|---|---|---|
| 1 | 宿主 | 常驻 ssh2 隧道 daemon 进程 | `install-host` 末尾自拉 | **按记录的 PID 精确 kill，绝不 pkill -f** |
| 2 | 宿主 | `~/.workbuddy/plugins/cache/winvm/` | `install-host` | 移入 trash |
| 3 | 宿主 | `~/.workbuddy/plugins/marketplaces/winvm/` | `install-host` | 移入 trash |
| 4 | 宿主 | `~/.workbuddy/connectors/skills/connector-winvm/`（8 skill） | `install-host` | 移入 trash |
| 5 | 宿主 | `installed_plugins.json` 键 `winvm-bridge@winvm` | `install-host` | 删键（**先备份**） |
| 6 | 宿主 | `connectors/*/mcp.json` 键 `connector:winvm`+`connector:winvm-a2a` | `install-host` | 删键（**先备份**） |
| 7 | 宿主 | `settings.json` `sandbox.extraAllowWrite` 安装追加项 | `install-host` | 删项（**先备份**） |
| 8 | 宿主 | `settings.json` `enabledPlugins["winvm-bridge@winvm"]` | `install-host` | 删项（**先备份**）[D16] |
| 9 | 宿主 | 用户 PATH / shell profile（`shell-init.sh` 行 + `.bashrc`/`.profile` 块） | `install-host` | 按标记 `# WinVM Bridge PATH` 去段 |
| 10 | 宿主 | `~/.workbuddy/winvm/` 标记文件 `side.json`/`vm-conn.json`/`shell-init.sh`/`tunnel.state.json`/`tunnel.pid`/`tunnel.log`/`tunnel-autostart.json`/`known_hosts` | 各相位（autostart=WorkBuddy 会话自启标记，install-host 写） | 删文件（**目录本身保留**；`nonaccount-mcp-trash-*` 等无关子目录不动） |
| 11 | VM | 计划任务 `WinVMBridge.Service` | `deploy-vm`/`setup` | `schtasks /End` + `/Delete` |
| 12 | VM | `vm-service` node 进程树 + `start-hidden.ps1` | 计划任务托管 | **按命令行 `C:\WinVMBridge` 签名杀，绝不按可执行路径**（node 二进制与宿主共享） |
| 13 | VM | `C:/WinVMBridge/`（程序+dist+shared-skills+QA scratch） | `deploy-vm`/`setup` | 删目录 |
| 14 | VM | VM agent skill 目录下指向 `C:\WinVMBridge\shared-skills` 的 junction | `deploy-shared-skills` | 删 junction（`.workbuddy`/`.hermes` 各 7 个） |
| 15 | VM | VM 用户 PATH 项 `C:\WinVMBridge\delivery` | `install-vm` | 去项 |
| 16 | VM | VM 标记 `~/.workbuddy/winvm/side.json` | `setup` | 删 |
| 17 | VM | `C:/WinVMWorkspace` | 运行期 | **仅 `--purge-workspace` 才删**（默认保留） |
| 18 | 宿主 | **全局 `~/.workbuddy/mcp.json`** 键 `winvm`/`winvm-a2a`（连接器页面读取面、disabledTools 落点） | `install-host` 全局注册 | 删键（**先备份**）⚠ 10-27 回环实测补齐——旧版只清 `connectors/*/mcp.json` 不清全局 |

### 2.4 宿主工具路径（鸿蒙沙箱必须绝对路径）

| 用途 | 路径 |
|---|---|
| node | `/data/storage/el1/bundle/libs/arm64/node/bin/node` |
| python3 | `/data/service/hnp/bin/python3` |
| git | `/storage/Users/currentUser/.harmonybrew/opt/git/bin/git` |

---

## 3. 总 Prompt（一键粘贴）

```text
你是 WinVM Bridge 的拆除执行者。请把双端部署干净拆回"未安装"态：严格按 U1→U5 顺序执行，
每一步用「判据」自检；任何判据不通过就立即停下并报告（现象 / 根因 / 证据 / 建议），
不要跳步硬推，不要用"应该删干净了"代替实测。

【设计红线】卸载 = 镜像拆除。只删 install-host/install-vm/setup/deploy-vm 自己放下去的东西；
  OS 级配置（VM 的 OpenSSH Server、两端 ~/.ssh、VM Node 运行时、宿主其它插件/连接器）一律不动。
  宿主删除物一律**移入 trash 目录**（~/.workbuddy/winvm-trash/<时间戳>/）而非直接 rm —— 可回滚。

【环境常量】
  VM_HOST=172.16.100.2   VM_USER=User   VM_SSH_PORT=22
  HOST_ROOT=~/.workbuddy   PKG_ROOT=~/winvm-deploy/overall-root/overall
【宿主工具】node=/data/storage/el1/bundle/libs/arm64/node/bin/node（必须绝对路径）
【安全红线】
  - 默认**保留** C:/WinVMWorkspace 与所有 SSH 密钥；除非用户明确要求 --purge-workspace / 删密钥。
  - 密码只走运行期 WINVM_SSH_PASSWORD；禁止落文件、禁止提交、禁止日志回显。

────────────────────────────────────────
U0 · 拆除前置检查（只读）
  0.1 免密通道仍在（卸载器 VM 相位依赖它）：
      ssh -o BatchMode=yes -o PreferredAuthentications=publickey \
          -o NumberOfPasswordPrompts=0 User@$VM_HOST whoami
      判据：输出用户名 + 退出码 0。若已失效 → 需先用 deploy-prompts P1 重建通道再拆，
            或经用户同意后改用密码通道（WINVM_SSH_PASSWORD + askpass）。
  0.2 WINVM_DRY_RUN=0（否则 --apply 会被降级，出现"假已拆"）。
  0.3 记录拆除前基线（供 U5 对照）：当前 ~/.workbuddy 下 winvm 落点清单、VM 上
      C:/WinVMBridge 与计划任务是否存在。

────────────────────────────────────────
U1 · 规划：先跑 DRY-RUN，逐行核对清单（**零改动**）
  1.1 cd $PKG_ROOT（若在包内）或仓库内均可，卸载器只读运行态、不依赖 src：
      $NODE delivery/uninstall.mjs
  1.2 判据：输出以 "mode : DRY-RUN" 开头，逐项列出 [DRY]/[DO]/[SKIP]/[KEEP]。
  1.3 人工核对：trash 目标路径、要删的 mcp.json 键、VM 相位计划（task/进程/目录/junction/PATH/side.json）。
      ⚠ 这一步就是安全阀：清单里出现"你以为不该删"的落点，立即停并报告，不要进 U2。

────────────────────────────────────────
U2 · 宿主相位：执行拆除（--apply）
  2.1 $NODE delivery/uninstall.mjs --apply
      （保留工作区=默认；彻底清另加 --purge-workspace，须用户明确同意）
  2.2 卸载器内部按序：停隧道（按 PID）→ 插件缓存/marketplace/connector skill 移入 trash
      → 删 installed_plugins.json 键 → 删 connectors/*/mcp.json 两键 → 删**全局 ~/.workbuddy/mcp.json**
        两键（winvm/winvm-a2a，10-27 回环补齐） → 删 settings.json 追加项
      → 去 PATH/shell profile 段 → 删 ~/.workbuddy/winvm 标记文件（含 tunnel-autostart.json）。
  2.3 判据：退出码 0；"APPLY complete" 且核验清单全 [PASS]（见 U4）。

────────────────────────────────────────
U3 · VM 相位：随同 --apply 一并完成（同一次调用）
  3.1 卸载器生成 .ps1 → scp 到 VM → powershell -NoProfile -ExecutionPolicy Bypass -File 执行：
      schtasks /End + /Delete WinVMBridge.Service → 按命令行签名杀 vm-service node 进程树
      → 删 C:/WinVMBridge → 删 shared-skills junction（.workbuddy/.hermes 各 7）
      → 去 VM 用户 PATH 项 → 删 VM side.json →（仅 --purge-workspace 时删 WinVMWorkspace）。
  3.2 ⚠ 远端逻辑一律 .ps1 + powershell -File（MSYS 规则）：禁止内联 powershell -Command
      （本地 bash 会展开 $_ 导致 ParserError）；载荷保持 ASCII。
  3.3 判据：VM 输出 POST-CLEANUP 段（见 U4）。

────────────────────────────────────────
U4 · 拆除核验（POST-CLEANUP 清单全 [PASS]；清单按运行态动态生成，实测 16~17 项）
  4.1 卸载器末尾自动打印 POST-CLEANUP VERIFICATION CHECKLIST，判据**全部 [PASS]**、零 [FAIL]：
      宿主（8~9，settings.json enabledPlugins 项按运行态有无出现）：
        [PASS] plugins/cache/winvm absent
        [PASS] plugins/marketplaces/winvm absent
        [PASS] connectors/skills/connector-winvm absent
        [PASS] installed_plugins.json has no winvm entry
        [PASS] settings.json enabledPlugins has no winvm entry（安装过 [D16] 则必列）
        [PASS] connectors/skills/mcp.json has no winvm entry
        [PASS] ~/.workbuddy/winvm/side.json absent
        [PASS] ~/.workbuddy/winvm/vm-conn.json absent
        [PASS] HOST global ~/.workbuddy/mcp.json has no winvm entry（10-27 补齐）
        [PASS] ~/.workbuddy/winvm/tunnel-autostart.json absent（10-27 补齐）
        [PASS] 127.0.0.1:18443 not listening
      VM（8）：
        [PASS] VM ssh passwordless ("whoami") works     ← 拆完密钥仍在、通道仍可用
        [PASS] VM C:/WinVMBridge absent
        [PASS] VM task WinVMBridge.Service absent
        [PASS] VM port 18443 not listening
        [PASS] VM no vm-service node process
        [PASS] VM OpenSSH Server still Running（must survive）
        [PASS] VM authorized_keys presence（info only; keys never touched）
        [PASS] VM C:/WinVMWorkspace kept（默认保留；--purge-workspace 时该条如实显示 purged）
  4.2 独立复核（不依赖卸载器自报，防假 PASS）：
      $NODE ~/.workbuddy/plugins/cache/winvm/.../winvm-plugin.mjs tunnel status --json 2>&1 | tail -3
        → 期望：插件已不在 → 报模块不存在/无 RUNNING（不能再是 state=RUNNING）
      curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18443/health  → 期望 000（拒连）
      读 ~/.workbuddy/mcp.json → winvm/winvm-a2a 条目应已消失（键不存在，而非 disabledTools 残留空壳）
  4.3 判据：4.1 全 [PASS] + 4.2 三项均指向"已拆除"。任一不符 → 停并给失败四元组。
  4.4 历史口径说明：清单为**动态生成**（按运行态落点有无增减行），10-27 修复不对称前实测 16~17 项、
      修复后 19 项——**判据永远是"全 [PASS] 零 [FAIL]"，不是固定条数**。

────────────────────────────────────────
U5 · 存留项处置（卸载器**按设计不动**，逐项问用户）
  5.1 SSH 密钥与免密通道：uninstall 永不删。彻底告别才单独清（见 §7，⚠ 注意 id_ed25519 一号多用坑）。
  5.2 运行态目录 `~/.workbuddy/winvm/`（目录本身保留；卸载后应只剩与本项目无关的历史子目录如
      `nonaccount-mcp-trash-*`，标记文件含 tunnel-autostart.json 已全清）、trash 目录（可回滚来源，用户确认后可清）。
  5.3 下载物 `~/winvm-deploy/`（pkg zip + overall-root 解包）：非部署产物，属获取阶段，按需手动清。
  5.4 仓库 `/.env`：uninstall 不动（设计约束）。
  5.5 定时自动化/看门狗：经 `automation_update list` 核实是否有与本项目相关的 ACTIVE 自动化
      （如隧道/部署健康巡检看门狗），有则逐个 `mode="update" status="PAUSED"` 或 `mode="delete"`；
      **ID 不写死**，一律先 list 再处置，避免误停无关任务。
  5.6 会话重载：拆除后**新开一个 WorkBuddy 会话**（连接器 mcp.json 变更在新会话才生效），
      新会话里 `winvm__*` 工具应不再出现 → 佐证拆除生效。

【排错速查】
- "--apply 说拆完了但 18443 还在听" → 查 WINVM_DRY_RUN 是否 =1（降级成 dry-run 假拆）。
- VM 相位报 ssh 拒绝/超时 → 免密通道已失效（U0 判据没真过）；先重建通道再拆。
- 远端 ParserError / 乱码 → 内联 -Command 被本地 bash 展开；改 .ps1 + powershell -File + ASCII 载荷。
- 杀进程误伤宿主自己的 node/MCP → 卸载器按命令行 `C:\WinVMBridge` 签名杀，不按可执行路径；
  若手工兜底，也必须 `Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%WinVMBridge%'"`。
- 隧道 kill 失败想 pkill -f → **禁止**；只按 tunnel.pid 记录的 PID 精确 kill（pkill -f 会连坐宿主）。
- mcp.json 里还留着 winvm → 分清落点：`connectors/<acct>/mcp.json` 与 `connectors/skills/mcp.json`
  都要清；另 `settings.json` 的 enabledPlugins/sandbox.extraAllowWrite 也各自独立。
- git push 突然 Permission denied (publickey) → 你在 U5.1 删掉了**兼作 GitHub 推送凭据**的 id_ed25519
  （一号多用）。处置：恢复为独立文件 id_ed25519_github（600），推送用 GIT_SSH_COMMAND 指定；长期正解两把密钥。
```

---

## 4. 分步 Prompt（U1~U5，需人工逐步确认时逐段粘）

### U1 · 规划（只读，零改动）

```text
拆除前先做只读规划，把"会删哪些东西"完整列出来人工核对，本步不做任何改动。
1) 确认免密通道仍在：ssh -o BatchMode=yes User@172.16.100.2 whoami（卸载器 VM 相位要用）。
   不在 → 停下：要么先按 deploy-prompts P1 重建，要么经用户同意用密码通道。
2) 确认 WINVM_DRY_RUN=0。
3) 跑规划：node delivery/uninstall.mjs   （不带 --apply = DRY-RUN）
   判据：输出首段 mode : DRY-RUN，逐项 [DRY]/[DO]/[SKIP]/[KEEP]。
4) 把清单里所有落点对照 §2.3 表逐条核：trash 目标、mcp.json 两键、VM task/进程/目录/junction/PATH/side.json。
   ⚠ 出现"不该删的"（如别的插件、OS 配置、他人 SSH key）→ 停并报告四元组，绝不进 U2。
停止条件：清单未逐条核对完，不得 --apply。
```

### U2+U3 · 执行拆除（宿主 + VM 一次调用）

```text
执行双端拆除（卸载器一条命令内同时完成宿主相位与 VM 相位）。
1) node delivery/uninstall.mjs --apply
   （默认保留 C:/WinVMWorkspace 与所有 SSH 密钥；彻底清工作区须用户明确同意后加 --purge-workspace）
2) 宿主相位：停隧道（只按 tunnel.pid 记录的 PID kill，**绝不 pkill -f**）
   → 插件缓存/marketplace/connector skill **移入** ~/.workbuddy/winvm-trash/<时间戳>/（非 rm，可回滚）
   → 删 installed_plugins.json / connectors/*/mcp.json / settings.json 里的 winvm 键与项（各自先备份）
   → 去 PATH/shell profile 的 "# WinVM Bridge PATH" 段 → 删 ~/.workbuddy/winvm 标记文件（目录保留）。
3) VM 相位：卸载器生成 .ps1 → scp → powershell -NoProfile -ExecutionPolicy Bypass -File 执行
   （**禁止内联 -Command**，本地 bash 会展开 $_）：
   schtasks /End+/Delete WinVMBridge.Service → 按命令行 C:\WinVMBridge 签名杀 vm-service
   → 删 C:/WinVMBridge → 删 shared-skills junction → 去 VM PATH 项 → 删 VM side.json。
4) 判据：退出码 0，末尾出现 "APPLY complete" 且核验清单全 [PASS]（见 U4）。
注意：WINVM_DRY_RUN=1 会让 --apply 变假拆（服务照旧在听）；先确保 =0。
```

### U4 · 拆除核验（防假 PASS）

```text
对已执行的拆除做双重核验：既看卸载器自报清单，也独立复核落点。
1) 卸载器自报 POST-CLEANUP VERIFICATION CHECKLIST：全 [PASS]、零 [FAIL]（清单动态生成，实测宿主 8~9 + VM 8，共 16~17 项）。
2) 独立复核（不信自报）：
   - 18443 已停：curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18443/health → 000
   - 插件缓存没了：ls ~/.workbuddy/plugins/cache/winvm 应不存在
   - connector skills 没了：ls ~/.workbuddy/connectors/skills/ | grep -i winvm 应空
   - mcp.json 干净：读 ~/.workbuddy/mcp.json，winvm 键不存在（非残留空壳）
   - VM 侧：ssh 进去 schtasks /query /tn WinVMBridge.Service 应报"找不到"；Test-Path C:\WinVMBridge=False；
     Get-NetTCPConnection -LocalPort 18443 应无监听；sshd 仍 Running（must survive）。
3) 关键"必须存活"项确认（拆除不应误伤）：VM OpenSSH Server=Running、authorized_keys 未被删、
   C:/WinVMWorkspace 默认仍在。
判据：自报 17 全 PASS + 独立复核一致 + 三个"必须存活"仍在 → 拆除成功。
```

### U5 · 存留项处置（逐项问用户，卸载器不动这些）

```text
拆除完成后，处理卸载器按设计**刻意保留**的存留物——每一项都要用户点头才做，不得自行清理。
1) SSH 密钥/免密通道：uninstall 永不删。仅"彻底告别"才清：
   - VM：只删本项目那一条 key（C:\ProgramData\ssh\administrators_authorized_keys 去行 + 重建 ACL），保留他人 key
   - 宿主：删 ~/.ssh/id_ed25519{,.pub}；从 ~/.ssh/known_hosts 去掉 VM 行
   ⚠ 血泪坑：id_ed25519 常**一号多用**（既是 VM 免密又是 GitHub 推送凭据）。删前先确认它不是推送密钥；
     若是，改用独立文件 id_ed25519_github（chmod 600）+ GIT_SSH_COMMAND 指定，长期正解是两把密钥分开。
2) 运行态目录 ~/.workbuddy/winvm/（目录本身保留）、~/.workbuddy/winvm-trash/<时间戳>/（回滚来源；用户确认后才清）。
3) 下载物 ~/winvm-deploy/（pkg zip + overall-root）：属获取阶段残留，非部署产物，可按需手动清。
4) 仓库 ./.env：uninstall 不动（设计约束），由用户自行决定。
5) 相关定时自动化/看门狗：先 automation_update mode="list" 核实有无与本项目相关的 ACTIVE 项，
   有则逐个 update status="PAUSED" 或 delete（**ID 不写死**，误停无关任务属事故）。
6) 新开会话验证：mcp.json 变更仅新会话生效，新会话里 winvm__* 工具应彻底消失。
停止条件：任何"删密钥/清工作区/清 trash"类不可逆动作，必须先取得用户明确同意，列清单再执行。
```

---

## 5. 核验速查

```sh
NODE=/data/storage/el1/bundle/libs/arm64/node/bin/node

# 规划（零改动，先看清单）
$NODE delivery/uninstall.mjs

# 执行拆除（默认保留工作区与密钥）
$NODE delivery/uninstall.mjs --apply
# 彻底清工作区（不可逆，须用户同意）
$NODE delivery/uninstall.mjs --apply --purge-workspace

# —— 拆除后独立复核（防假 PASS）——
# 端口已停
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18443/health          # 期望 000
# 插件缓存 / 连接器 skills 已清
ls ~/.workbuddy/plugins/cache/winvm 2>/dev/null || echo CACHE_GONE
ls ~/.workbuddy/connectors/skills/ 2>/dev/null | grep -i winvm || echo SKILLS_GONE
# mcp.json 无 winvm 键
$NODE -e "const j=require(process.env.HOME+'/.workbuddy/mcp.json');console.log('winvm keys:',Object.keys(j.mcpServers||j).filter(k=>/winvm/i.test(k)))"

# VM 侧（免密通道应仍在）
ssh User@172.16.100.2 'powershell -NoProfile -Command "Get-ScheduledTask -TaskName WinVMBridge.Service -ErrorAction SilentlyContinue; Test-Path C:\WinVMBridge; (Get-NetTCPConnection -LocalPort 18443 -ErrorAction SilentlyContinue).Count; (Get-Service sshd).Status"'
#   期望：task 空 / Test-Path=False / 监听计数 0 / sshd=Running
```

---

## 6. 排错速查

| 现象 | 根因 | 处置 |
|---|---|---|
| `--apply` 报拆完但 18443 仍在听 | `.env`/环境 `WINVM_DRY_RUN=1`，把 apply 降级成 dry-run（假拆） | 置 `0` 重跑 `uninstall.mjs --apply` |
| VM 相位 ssh 拒绝/超时 | 免密通道 U0 判据没真过（已失效） | 先按 deploy-prompts P1 重建通道，或经同意改用密码通道再拆 |
| 远端 `ParserError` / 乱码 | 内联 `powershell -Command` 被本地 bash 展开 `$_` | 写 `.ps1` → `scp` → `powershell -File`；ASCII 载荷 |
| 杀 vm-service 误伤宿主 node/MCP | 按可执行路径杀（node 二进制宿主共享） | 只按命令行 `C:\WinVMBridge` 签名杀；兜底用 `Win32_Process -Filter "CommandLine LIKE '%WinVMBridge%'"` |
| 隧道 kill 想 `pkill -f` | `pkill -f node` 会连坐宿主其它进程 | **禁止**；只按 `tunnel.pid` 记录的 PID 精确 kill |
| `mcp.json` 仍留 winvm | 落点分散：`connectors/<acct>/mcp.json`、`connectors/skills/mcp.json`、`settings.json`(enabledPlugins/sandbox.extraAllowWrite) 各自独立 | 逐文件核；确认卸载器版本覆盖全部落点 |
| 拆完会话里仍见 `winvm__*` | 连接器配置变更**仅新会话**注入 | 新开 WorkBuddy 会话验证 |
| `git push` Permission denied (publickey) | U5.1 删掉了兼作 GitHub 推送凭据的 `id_ed25519`（一号多用） | 恢复为独立 `id_ed25519_github`（600）+ `GIT_SSH_COMMAND` 指定；长期正解两把密钥分开 |
| 想连 trash 一起清又怕丢回滚 | trash 是可回滚来源 | 用户明确确认"不再需要回滚"后才清 `~/.workbuddy/winvm-trash/` |
| 拆除误删了 `C:/WinVMWorkspace` | 加了 `--purge-workspace`（默认不删） | 该标志不可逆；如需数据请先备份再拆 |
| 重装 setup TUNNEL 相位报 `EADDRINUSE 18443`、HEALTH 相位却 ✅ | daemon 正持端口 + 黑洞预热竞态（VM 服务刚起、回落自建撞端口） | 瞬态：直接 `curl /health`=200 + `tunnel status`=RUNNING 即已自愈，无需处理；反复出现才按隧道黑洞判据排查 |
| example-probe 首跑 E7/E8 `PSBRIDGE_EXITED`（stderr 双份「ps-bridge 启动」banner） | 重装窗口内 ps-bridge 重启竞态（首次调用打在换代瞬间） | 复跑 example-probe 即稳（10-27 run1 实测：首跑 11/13→复跑 13/13）；稳定复现才按 VM 侧热更路径排查 |

---

## 7. 卸载后仍存留 / 需单独决策项

> 卸载器的定位是**镜像拆除部署产物**，以下不属部署产物，刻意保留，需用户单独决定是否清理。

| # | 存留项 | 默认 | 彻底告别时的处置 | 需谁决定 |
|---|---|---|---|---|
| 1 | SSH 密钥对 + 免密通道（两端 `~/.ssh`、VM `authorized_keys`） | **保留** | VM 去本项目那一条 key + 重建 ACL；宿主删 `id_ed25519{,.pub}` + `known_hosts` 去 VM 行 | 用户（⚠ 一号多用坑） |
| 2 | VM `C:/WinVMWorkspace`（运行期用户数据） | **保留** | `--purge-workspace`（不可逆） | 用户 |
| 3 | `~/.workbuddy/winvm/` 目录骨架（标记文件已删，目录留） | 保留 | 手动 `rmdir` | 用户 |
| 4 | `~/.workbuddy/winvm-trash/<时间戳>/`（拆除回滚来源） | 保留 | 确认不再回滚后清 | 用户 |
| 5 | 下载物 `~/winvm-deploy/pkg/*.zip` + `overall-root/` 解包 | 保留 | 手动 `rm -rf`（非部署产物） | 用户 |
| 6 | 项目仓库 `./.env` | 保留（设计约束） | 用户自行删 | 用户 |
| 7 | VM 的 OpenSSH Server / Node 运行时 | 保留（OS 级，非本项目安装） | **不属卸载范围**，如需撤 OS 服务另议 | 用户 |
| 8 | 相关 ACTIVE 自动化（隧道/巡检看门狗） | 不动 | 先 `automation_update list` 核实，再逐个 PAUSED/DELETE | 用户（ID 不写死） |

---

## 8. 与"清场重装（`--wipe`）"的衔接

发布验证每迭代都要 `--wipe` 清场后重装复验。清场 = **拆除 + 重装**，此时：

```text
1) 拆除（本文件 U1~U4）：**保留** SSH 密钥与下载物（马上要用），不加 --purge-workspace。
   → $NODE delivery/uninstall.mjs --apply   核验 POST-CLEANUP 清单全 PASS
   ⚠ 反复清场时 `vm-conn.json` 首轮即被删——再跑 uninstall 须显式传
     `--vm-host $VM_HOST --vm-user $VM_USER`（或保留 vm-conn.json 到重装前），否则 VM 相位 SKIPPED+fail。
2) 重装（deploy-prompts.md 总 Prompt，从 Step 2 起即可，免密通道仍在可跳 Step 1）。
3) 判据：重装后 25/25（mcp-probe 20 + a2a-probe 5）+ example-probe 全绿。
```

> ⚠ 清场重装**不要删 `~/.ssh`**：删了免密断，重装 Step 1 还得重建，且可能连带废掉 GitHub 推送密钥（§7-1 坑）。
> 卸载器默认不碰密钥，正是为 `--wipe` 场景留的——按默认走即可。

---

## 9. 变更记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-10-27 | v1.0 | 首版：作为 `deploy-prompts.md` 的逆向镜像。结构对齐部署文档（使用方式/变量表/总 Prompt U1~U5/分步 Prompt/核验速查/排错/存留项/清场重装衔接/变更记录）。拆除清单取自 `delivery/uninstall.mjs` 头注（§2.3 逐条镜像安装体系 17 落点）；核验判据取自真机 `qa/evidence/uninstall-pre-run3.log`（16 项）与 `qa/evidence/cleanup-20261026/uninstall-apply-*.log`（17 项）的 POST-CLEANUP VERIFICATION；强调三条设计红线（镜像拆除不越界、宿主删除移入 trash 可回滚、OS 级配置与 SSH 密钥永不触碰）+ 独立复核防假 PASS + 一号多用密钥坑 + `--wipe` 清场重装衔接（保留密钥） |
| 2026-10-27 | v1.1 | **回环实测（run1，`qa/real-test-2026-10-27-run1.md`）驱动修订**：U0~U4 拆除→Step 3~5 重装→三探针 38/38 全绿。揪出并修复 `uninstall.mjs` 两处镜像不对称——**U-1 全局 `~/.workbuddy/mcp.json` 的 winvm/winvm-a2a 键不清**（install-host 全局注册面，disabledTools 落点；新增 `cleanGlobalMcpJson`+核验行）、**U-2 `tunnel-autostart.json` 不在 markers**（会话自启标记残留=拆后重开 WB 会 ensure 死隧道；补入 markers+核验行）。落点表 17→**18 项**、核验清单口径改「全 PASS 零 FAIL，动态 16→19 项」；§8 补反复清场 `--vm-host` 兜底（vm-conn.json 首轮即删）；排错表补 TUNNEL EADDRINUSE 瞬态与 ps-bridge 换代抖动（E7/E8 首跑 FAIL 复跑稳）两条。⚠ 修复晚于 V1.4.4 打包 → 包内 uninstall.mjs 仍旧版（ISSUES I-6.3；用户裁定：随下迭代收编，pack V7 硬断言钉死「包内 uninstall 必含 cleanGlobalMcpJson」） |

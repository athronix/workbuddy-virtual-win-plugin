# WinVM Bridge · 部署 Prompt 总集（deploy-prompts）

> 文档 ID：DEPLOY-PROMPTS-v1
> 状态：**六步已真机实测通过**（验收 25/25，见 `qa/real-test-2026-10-26-run1.md`）
> 更新：2026-10-30（v2.4：新宿主机实跑复盘收编——新增 Step 0 前置检查（VM 密码/OpenSSH 安装法/虚拟机电源/防火墙 Profile）、NODE/PY 自动探测、ssh 重试封装、执行协议 P-1/P-2；R8 根除：安装链 cmd.exe 兼容化（.ps1/EncodedCommand 跨壳），不再要求 Git-Bash 默认 shell）
> 上游：`docs/deploy/deploy-strategy.md`（论证与实测记录）、`docs/INSTALL-GUIDE.md`（逐项细节）
> 对偶：`docs/deploy/undeploy-prompts.md`（卸载 Prompt 总集，本文件的逆向镜像；清场重装 `--wipe` 前置拆除见彼文 §8）
> 用途：把本文档的 Prompt 块粘给 WorkBuddy（鸿蒙宿主），即可从零驱动双端安装

---

## 1. 使用方式

| 场景 | 用哪块 |
|---|---|
| 一次装完（推荐） | §3 总 Prompt（单块，含全部 5 步与判据） |
| 分步做、每步人工确认 | §4 分步 Prompt（P1~P5 独立可粘） |
| 只想复跑验收 | §5 验收命令速查 |
| 出问题了 | §6 排错速查 |
| 换机器/换网络 | 先改 §2 变量表，再粘 Prompt |

**前置**：宿主侧需有 `ssh` / `scp` / `unzip` / `sha256sum` / `curl` / `node`；
VM 侧需 `sshd` 运行中、Windows 账户**有非空密码**、已装 Node ≥ 18。
**sshd 默认 shell 保持 cmd.exe 即可（V1.4.9 起无需 Git-Bash，R8 根除）**；VM 内其他项见 §3 Step 0 前置检查。

---

## 2. 部署变量（粘 Prompt 前先确认）

> 所有值均为**本机实测默认值**。换环境只改本表。
> ⚠️ 密码不入库、不写文件：只经运行期环境变量 `WINVM_SSH_PASSWORD` 注入。
> 确认方式：逐行打勾或在「本轮值」列改写。

### 2.1 目标环境

| 变量 | 默认值 | 本轮实测 | 说明 | 确认 |
|---|---|---|---|---|
| `VM_HOST` | `172.16.100.2` | 同左 | Windows VM IP | ☐ |
| `VM_USER` | `User` | 同左 | VM 账户（**Administrators 组成员**） | ☐ |
| `VM_PASSWORD` | `<运行时注入>` | `WINVM_SSH_PASSWORD` | **必须非空**（空密码被 Windows 两层串联拦截，见 `VM_PW_MODE`） | ☐ |
| `VM_PW_MODE` | `normal` | `normal` | `normal` 设非空密码（推荐）／`blank-allow` 两层放行空密码（`PermitEmptyPasswords yes`+`LimitBlankPasswordUse=0`，**建好免密后必须回滚**） | ☐ |
| `VM_SSH_PORT` | `22` | 同左 | sshd 端口 | ☐ |
| `VM_DEPLOY_DIR` | `C:/WinVMBridge` | 同左 | VM 侧程序目录 | ☐ |
| `VM_WORKSPACE` | `C:/WinVMWorkspace` | 同左 | VM 侧工作区 | ☐ |

### 2.2 分发包

| 变量 | 默认值 | 本轮实测 | 说明 | 确认 |
|---|---|---|---|---|
| `GITHUB_REPO` | `athronix/workbuddy-virtual-win-plugin` | 同左 | 仓库全名 | ☐ |
| `RELEASE_URL` | `https://github.com/athronix/workbuddy-virtual-win-plugin/releases/latest` | 解析到 `V1.4.2` | latest 跳转页 | ☐ |
| `RELEASE_TAG` | `V1.4.9`（**示例值——以 `releases/latest` API 现解为准**，见 `RELEASE_URL` 行与 deploy.prompt 注入段指引） | 10-29 上架 latest=V1.4.6 | 发布标签（V1.4.6=.prompt 两脚本+README §5.4 入包版；V1.4.5=I-6.3 收编版；V1.4.4=I-6.1 补发版） | ☐ |
| `ZIP_NAME` | `winvm-overall-<RELEASE_TAG>.zip`（示例 V1.4.9） | 随 latest 现解（旁挂 91 B sidecar 现取现验） | 分发单元 | ☐ |
| `ZIP_SHA256` | **不在文档硬编码**（`MANIFEST-sidecar-authoritative`）：以 release 旁挂 `winvm-overall-<TAG>.zip.sha256` 为准，`sha256sum -c` 当场验 | V1.4.6 回环实测一致 | 整包校验值（取包时现取现验，永不陈旧） | ☐ |
| `PKG_FILES`/`PKG_BYTES`/`PKG_TOTAL` | **不在文档硬编码**（同上 `MANIFEST-sidecar-authoritative`）：以**包内 `MANIFEST.txt` 头七行**为准，`$PY qa/deploy-probes/verify-manifest.py .` 复算即验 | V1.4.6=881/7606427/`2562a598…`（历史样例） | MANIFEST 三元组（Step 2.3 判据②的输入源=包内文件，非本文档） | ☐ |
| `DEPLOY_ROOT` | `~/winvm-deploy` | 同左 | 宿主解压根 | ☐ |
| `PKG_ROOT` | `$DEPLOY_ROOT/overall-root/overall` | 同左 | 包根（zip 内含顶层 `overall/`） | ☐ |

### 2.3 服务与端口

| 变量 | 默认值 | 本轮实测 | 说明 | 确认 |
|---|---|---|---|---|
| `VM_SERVICE_PORT` | `18443` | 同左 | VM-service 端口 | ☐ |
| `VM_SERVICE_BIND` | `127.0.0.1` | 同左 | **仅回环**，VM 零对外暴露 | ☐ |
| `TUNNEL_LOCAL_PORT` | `18443` | 同左 | 宿主隧道本地端口 | ☐ |
| `MCP_PATH` | `/mcp` | 同左 | MCP 直调通道（简单任务） | ☐ |
| `A2A_PATH` | `/a2a` | 同左 | A2A 委派通道（复杂任务） | ☐ |
| `A2A_CARD` | `/.well-known/agent-card.json` | 200 | A2A 发现端点（**无 `/a2a/health`**） | ☐ |
| `SCHEDULED_TASK` | `WinVMBridge.Service` | Running | VM 计划任务名 | ☐ |

### 2.4 宿主落点

| 变量 | 默认值 | 本轮实测 | 说明 | 确认 |
|---|---|---|---|---|
| `HOST_WB_HOME` | `~/.workbuddy` | 同左 | WorkBuddy 主目录 | ☐ |
| `HOST_GLOBAL_MCP` | `~/.workbuddy/mcp.json` | `winvm.disabledTools=8` | **`disabledTools` 的真实落点** | ☐ |
| `HOST_STATE_DIR` | `~/.workbuddy/winvm` | `vm-conn.json`/`tunnel.*` | 运行态 | ☐ |
| `HOST_PLUGIN_CACHE` | `~/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0` | 9 文件 | 插件缓存（单文件白名单） | ☐ |
| `HOST_SKILL_DIR` | `~/.workbuddy/connectors/skills/connector-winvm` | 实测 8（V1.4.3 起各包与 HEAD 均 8，含 hos-win） | Skill 缓存落点（历史 V1.4.2 包=7 属 G-1，已收敛） | ☐ |
| `SSH_KEY` | `~/.ssh/id_ed25519` | 同左 | 宿主身份密钥 | ☐ |
| `ASKPASS` | `~/wbtmp/askpass.sh` | 同左 | 密码非交互化（`chmod 700`） | ☐ |

### 2.5 行为开关

| 变量 | 默认值 | 本轮实测 | 说明 | 确认 |
|---|---|---|---|---|
| `WINVM_VM_PROVIDER` | `workbuddy` | `state=ready` | VM 侧 Agent（**用户裁定为默认**） | ☐ |
| `WINVM_WORKBUDDY_CLI` | `codebuddy` | 同左 | `provider=workbuddy` 时的 LLM CLI | ☐ |
| `WINVM_DRY_RUN` | `0`（真装时） | `0` | **=1 会把 `--apply` 降级成 dry-run** | ☐ |
| `WINVM_DELEGATION_REQUIRED_POLICY` | `on` | `true` | 服务端审批闸 | ☐ |
| `READY_BUDGET` / `IDLE_TTL` | `180s` / `300s` | — | 就绪预算 / 空闲回收 | ☐ |

### 2.6 VM 侧运行时前提（Step 3.0 自检项）

| 变量 | 默认值 | 本轮实测 | 说明 | 确认 |
|---|---|---|---|---|
| `VM_MIN_NODE` | `18.0.0` | `v24.21.0` | Node 版本下限（`preflight.vm-node` 判据） | ☐ |
| `VM_NPM_REQUIRED` | `true` | `11.19.0` | npm 必须可用（`preflight.vm-npm`） | ☐ |
| `VM_AGENT_CLI` | `codebuddy` | `2.167.0` | `provider=workbuddy` 时探测的 CLI 名（`preflight.vm-agent-cli`） | ☐ |
| `VM_AGENT_CLI_PKG` | `@tencent-ai/codebuddy-code@latest` | `latest=2.176.0`（VM 现装 2.167.0） | 缺失时 `npm i -g` 的包名；**默认 latest，不锁版本** | ☐ |
| `VM_NODE_PM` | `nvm-windows 2.0.0` | `* 24.21.0 (default)` | Node 版本管理器（**切版本会使全局 CLI 失效**） | ☐ |
| `VM_AUTH_DIR` | `~/.codebuddy` | `settings.json,user-state.json` | 登录态探测标记（`evaluateAgentLogin` 同源） | ☐ |
| `VM_CLI_CHECK` | `qa/deploy-probes/vm-env-check.ps1` | 三例 PASS | 三合一探针（`-Fix` 只补 CLI，`-SimulateMissing` 自测） | ☐ |

> **版本策略已定（用户裁定 2026-10-26）**：所有安装一律取 **`@latest`**，**不锁定版本号**。
> 文档中出现的 `2.167.0` / `2.176.0` 只是**当轮实测快照**，不是要钉住的版本。

### 2.7 宿主工具路径（鸿蒙沙箱必须绝对路径）

| 用途 | 路径 |
|---|---|
| node | `/data/storage/el1/bundle/libs/arm64/node/bin/node` |
| python3 | `/data/service/hnp/bin/python3` |
| git | `/storage/Users/currentUser/.harmonybrew/opt/git/bin/git` |

---

## 3. 总 Prompt（一键粘贴）

```text
你是 WinVM Bridge 的部署执行者。请从零完成本项目的双端安装：严格按 Step 1→5 顺序执行，
每一步用「判据」自检；任何判据不通过就立即停下并报告（现象 / 根因 / 证据 / 建议），
不要跳步硬推，不要用「应该可以」代替实测。

【环境常量】
  VM_HOST=172.16.100.2   VM_USER=User   VM_SSH_PORT=22
  VM_DEPLOY_DIR=C:/WinVMBridge   VM_WORKSPACE=C:/WinVMWorkspace
  SERVICE_PORT=18443（仅回环 127.0.0.1）
  PROVIDER=workbuddy   WORKBUDDY_CLI=codebuddy
  RELEASE_TAG=V1.4.9   ZIP=winvm-overall-V1.4.9.zip
  REPO=athronix/workbuddy-virtual-win-plugin
  DEPLOY_ROOT=~/winvm-deploy   PKG_ROOT=~/winvm-deploy/overall-root/overall
【宿主工具】node=/data/storage/el1/bundle/libs/arm64/node/bin/node（必须绝对路径）
  python3=/data/service/hnp/bin/python3；有 ssh/scp/unzip/sha256sum/curl；无 sshpass
【安全红线】
  - 密码只走运行期环境变量 WINVM_SSH_PASSWORD；禁止写入任何文件、禁止提交、禁止日志回显。
  - 不要为了让密码登录通过而把 VM 的 LimitBlankPasswordUse 改成 0（等于局域网免密登录管理员）。

────────────────────────────────────────
Step 0 · 前置检查（开工前逐项确认；不满足即按执行协议处置）
  【执行协议】P-1 缺信息/信息错（VM IP、账号、密码）→ 停下问用户，不猜不硬试；
    P-2 环境缺失：可自动化项（prepare-vm --ensure-node 覆盖 node/codebuddy/防火墙/
    睡眠/sshd 启动型）→ **报告发现+将执行动作，取得用户审批后**自动跑并回报；
    必须人工项（VM 内管理员操作、codebuddy 登录）→ 给精确到命令的方法，
    请用户完成后通知继续；P-3 其余步骤 AI 自主推进并汇报，仅三类人工卡点暂停
    （①VM 密码 ②VM 内管理员操作 ③方案拍板）。
  0.1 提醒用户为 VM Windows 账户设**非空密码**：空密码不安全，且被两层串联拦截
      （PermitEmptyPasswords=no + LimitBlankPasswordUse=1）使免密通道建立复杂化。
  0.2 提醒用户安装并启动 OpenSSH Server（VM 内管理员 PowerShell）：
        Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
        Start-Service sshd
        Set-Service sshd -StartupType Automatic
      （或 设置→可选功能→OpenSSH 服务器。）判据：宿主 TCP 探测 22 开放 / vmssh whoami 可达。
      ⚠ **默认 shell 保持 cmd.exe（出厂默认）即可**——V1.4.9 起安装链全走跨壳通道
      （.ps1 推送 / powershell -EncodedCommand），无需改 DefaultShell、无需装 Git for
      Windows（复盘旧案 R8"apply 失败 183 次"自此根除）。
  0.3 提醒用户在虚拟机管理端设置：电源策略**"从不"自动暂停** + **开机自启**，
      避免 VM 后台睡眠导致隧道黑洞/服务假死（宿主侧 prepare-vm DB-5 只兜底 guest 内 powercfg，
      hypervisor 层暂停必须用户在虚拟机管理界面设置）。
  0.4 防火墙 Profile 匹配（R3 坑：sshd 在跑端口在听但连接超时=Public/Private 不匹配）：
      诊断（VM PS）：Get-NetConnectionProfile | Select InterfaceAlias, NetworkCategory
                   Get-NetFirewallRule -Name OpenSSH-Server-In-TCP | Select Name, Enabled, Profile
      修复（VM **管理员** PS）：Set-NetFirewallRule -Name OpenSSH-Server-In-TCP -Profile Any
      本项目自建规则（prepare-vm DB-2）默认全 Profile，无此问题。
  0.5 ssh/scp 偶发一两次失败=桥接抖动（R4）：所有远端操作包重试循环
      （vmssh()/vmscp() 三试+sleep 2s；deploy.prompt v2.0 已内置），非配置错误。

────────────────────────────────────────
Step 1 · 密码登录 → 建立免密通道
  1.1 造 askpass 脚本（只从环境变量取值）：
      printf '#!/bin/sh\nprintf "%%s\\n" "$WINVM_SSH_PASSWORD"\n' > ~/wbtmp/askpass.sh
      chmod 700 ~/wbtmp/askpass.sh
  1.2 密码通道自检：
      WINVM_SSH_PASSWORD=*** DISPLAY=:0 SSH_ASKPASS=$HOME/wbtmp/askpass.sh \
        SSH_ASKPASS_REQUIRE=force ssh -o PubkeyAuthentication=no \
        -o PreferredAuthentications=password -o NumberOfPasswordPrompts=1 \
        User@$VM_HOST "echo PASSWORD_AUTH_OK"
      判据：输出 PASSWORD_AUTH_OK。
      若 Permission denied → 账户可能是空密码（Windows 禁止空密码网络登录），停下请用户设密码。
  1.3 生成宿主密钥（已存在则跳过）：
      [ -f ~/.ssh/id_ed25519 ] || ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519
  1.4 写公钥到 VM 的两处并收紧 ACL：
      - C:/Users/<user>/.ssh/authorized_keys
      - C:/ProgramData/ssh/administrators_authorized_keys（Administrators 组成员只认这个）
      - 对后者：icacls <file> /inheritance:r /grant '*S-1-5-32-544:F' /grant '*S-1-5-18:F'
      ⚠ 公钥含空格与 +/，禁止内联拼进 ssh 命令；base64 传参，由远端 .ps1 解码。
      ⚠ 远端逻辑一律写 .ps1 → scp → powershell -NoProfile -ExecutionPolicy Bypass -File；
        禁止内联 powershell -Command（本地 bash 会展开 $_ 导致 ParserError）。
      ⚠ 追加而非覆盖：已存在则去重跳过，绝不覆盖他人 key。
  1.5 判据（免密）：
      ssh -o BatchMode=yes -o PreferredAuthentications=publickey \
          -o NumberOfPasswordPrompts=0 User@$VM_HOST whoami
      → 输出用户名且退出码 0。
      注意：icacls 输出里仍可能存在 User/(R) 等历史显式 ACE，只要公钥能登就算通过。

────────────────────────────────────────
Step 2 · 获取 Release 并三重校验
  2.1 下载（用绝对 URL，不要 releases/latest；github.com 本网段有抖动）：
      BASE=https://github.com/$REPO/releases/download/$RELEASE_TAG
      curl -fsSL --connect-timeout 20 --max-time 900 --retry 5 --retry-delay 3 \
           --retry-all-errors -C - -o ~/winvm-deploy/pkg/$ZIP $BASE/$ZIP
      curl -fsSL --connect-timeout 20 --max-time 120 --retry 5 --retry-delay 3 \
           --retry-all-errors -o ~/winvm-deploy/pkg/$ZIP.sha256 $BASE/$ZIP.sha256
      判据①：sha256sum -c $ZIP.sha256 → OK
  2.2 解压（zip 内含顶层 overall/）：
      mkdir -p ~/winvm-deploy/overall-root
      unzip -q -o ~/winvm-deploy/pkg/$ZIP -d ~/winvm-deploy/overall-root
      包根 = ~/winvm-deploy/overall-root/overall
  2.3 包内完整性：
      python3 qa/deploy-probes/verify-manifest.py $PKG_ROOT
      判据②：RESULT: PASS（逐文件 sha256 + files/bytes 计数 + total-sha256 复算 + 无多余/缺失；已装态包根下 .env 与 delivery/winvm-plugin(.cmd) 为运行期自写产物，V1.4.8 起白名单豁免=ISSUES I-6.4）
      判据③：README.md / MANIFEST.txt / delivery/install-host.mjs / delivery/deploy-vm.mjs 均在
  若下载 connect timeout：先 curl -I https://github.com 数次，能拿到 200 即链路抖动，重试即可。

────────────────────────────────────────
Step 3 · 部署 VM-service（用免密通道）
  3.0 运行时前置自检（**硬门禁：缺一即中止，安装器不会代装**）：
      scp qa/deploy-probes/vm-env-check.ps1 User@$VM_HOST:C:/Users/User/vm-env-check.ps1
      ssh User@$VM_HOST 'powershell -NoProfile -ExecutionPolicy Bypass -File C:/Users/User/vm-env-check.ps1'
      判据：ENV_PRECHECK=PASS 且 BLOCKERS=none（NODE_OK / NPM_FOUND / CLI_OK 全 true）。
      缺失按序补齐（前一项是后一项前提）：
        - node<18 或无 node：有 nvm → `nvm install 24.21.0 && nvm use 24.21.0`；
          无 nvm → 官方 MSI 静默装（需管理员 + 桌面会话）。
          ⚠ 不要用 winget：经 ssh 非交互会话是 MSIX alias 空壳（--version 输出空且 exit 0）。
        - 无 npm：随 Node 一起装，不要单独补。
        - 无 codebuddy：`npm i -g @tencent-ai/codebuddy-code@latest`（写用户目录，无需提权；默认 latest 不锁版本）。
          ⚠ nvm 切版本会使全局 CLI 失效 → 换版本后必须重装。
        - AUTH_VERDICT=installed-unverified → 属人工项：请用户在 VM 内交互式跑一次
          `codebuddy` 完成登录（DB-4 结构性不可脚本化），完成后通知继续。
      自动化（审批后一条命令补齐 node/codebuddy/防火墙/睡眠/sshd 启动型）：
        cd $PKG_ROOT && $NODE delivery/bootstrap.mjs prepare-vm --apply --ensure-node
        （DB-3 node：winget 首选→失败自动落 **zip+cdn.npmmirror.com 镜像**兜底
         （R7 复盘：MSI per-user 1603、winget 经 ssh=MSIX 空壳；zip 免管理员）；
         只补 CLI 时探针加 `-Fix` 亦可。装完重跑 3.0 确认 BLOCKERS=none。）
  3.1 准备 .env：
      cd $PKG_ROOT && cp -n .env.example .env
      确认 VM_HOST/VM_USER/VM_SSH_PORT/VM_DEPLOY_DIR/WINVM_SERVICE_PORT
      以及 WINVM_VM_PROVIDER=workbuddy、WINVM_WORKBUDDY_CLI=codebuddy
      ⚠ 必须把 WINVM_DRY_RUN 改成 0，否则即使加 --apply 也只 dry-run（假成功）
  3.2 先规划再执行：
      $NODE delivery/deploy-vm.mjs --skip-build --env=.env
      $NODE delivery/deploy-vm.mjs --apply --skip-build --env=.env
      （--skip-build 必须加：发布包不含 src/tsc，dist 已构建且指纹在 MANIFEST）
  3.3 判据（VM 本机，用 .ps1 探针一次取全）：
      scp qa/deploy-probes/vmcheck.ps1 User@$VM_HOST:C:/Users/User/vmcheck.ps1
      ssh User@$VM_HOST 'powershell -NoProfile -ExecutionPolicy Bypass -File C:/Users/User/vmcheck.ps1'
      要求：task_state=Running、listen_addr=127.0.0.1、listen_count=1、side_json=true、
            bridge_dir=true、health_http=200、health_body.ok=true

────────────────────────────────────────
Step 4 · 安装宿主插件 + 隧道
  4.1 一条命令（末尾会自动拉起常驻隧道，一般无需再 tunnel ensure）：
      cd $PKG_ROOT
      $NODE delivery/install-host.mjs --yes --vm-host $VM_HOST --vm-user $VM_USER --vm-ssh-port 22
  4.2 判据①隧道：
      $NODE ~/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0/winvm-plugin.mjs tunnel status --json
      → state=RUNNING、healthy=true、ownerMatch=true、stateStale=false
  4.3 判据②对账面：
      $NODE delivery/install-host.mjs --check-fresh  → FRESH
  4.4 判据③宿主健康：
      curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18443/health  → 200
  4.5 判据④高危闸门（注意落点是全局文件，不是 connectors/<acct>/）：
      读 ~/.workbuddy/mcp.json，winvm 条目的 disabledTools 长度必须为 8

────────────────────────────────────────
Step 5 · 全维度测试并出报告
  5.1 MCP 面 20 项：python3 qa/deploy-probes/mcp-probe.py
      覆盖：健康 6 项 / MCP 面 7 项 / 跨域功能抽样 5 项 / A2A 发现 2 项
  5.2 A2A 面 5 项：python3 qa/deploy-probes/a2a-probe.py
      覆盖：cli 存在 / stdio initialize / a2a 工具在册 / a2a.health / a2a.delegate 真委派
  判据：两个脚本都输出 RESULT: PASS（合计 25/25）
  5.3 出报告 qa/real-test-<日期>-run<N>.md：
      健康 / 连接（MCP+A2A）/ 功能抽样 / 失败四元组 四张表，
      并给「可交付 / 有阻塞」明确结论。

────────────────────────────────────────
Step 6 交付引导（不参与部署判据，但决定后续任务通道路由是否正确）
  6.1 加载 skill（顺序不能反）：
      @skill:hos-win-skill         # 仓库第 8 Skill（host-only，VM 不分发）；宿主可用户级或连接器目录供入
      由它带入 winvm-orchestrator    # 连接器 7 个 winvm-* skill 之一
      判据（R11 修正，V1.4.3 起包与 HEAD 均=8）：
            ls ~/.workbuddy/connectors/skills/connector-winvm/ | wc -l == 8
            且目录内含 hos-win-skill 与 winvm-orchestrator；宿主用户级 ~/.workbuddy/skills/hos-win-skill/SKILL.md 任一供入亦可
  6.2 通道路由三条铁律（优先级从高到低）：
      ① 风险优先：L2/L3（service.configure/process.terminate/registry.write/winget.uninstall/
         file.delete/link.manage/appops.gui.produce/power.control）一律 a2a.delegate；
      ② 步骤定界：1~2 步可穷举、无中间判断 → MCP 直调；依赖上一步结果/需看屏/只给目标态 → 委派；
      ③ 先探后定：先直调 L0 读能力取事实；收到 DELEGATION_REQUIRED 立即转委派，不要重试。
  6.3 给用户 3 个可直接粘贴的示范（每条注明通道）：
      - 直调读：「在 Windows 虚拟机里列出所有已安装软件，按名称排序，只查不改，给表格」
        → app.inventory.list
      - 直调诊断：「分析 VM 的 C 盘空间占用，给我前 10 大目录，只读」
        → storage.disk.list + storage.space.analyze
      - 委派多步：「VM 上 WinVMBridge.Service 停了，查明原因并恢复，最后确认 /health 正常」
        → a2a.delegate（goal 传自然语言目标，不是 capability）
  6.4 明确告知用户：**不要**让助手 ssh 进 VM 裸跑 PowerShell —— 会绕过审批卡与审计回执，
      等于把安全边界从使用面拆掉。
  6.5 交付自检 3 条：skill 就位 / curl 宿主 18443/health=200 / 实跑「查一下 VM 的系统信息」有真实返回。

【排错速查】
- 密码拒绝 → 先区分密码错 / 空密码。空密码是两层串联拦截（OpenSSH PermitEmptyPasswords=no
  默认 + LSA LimitBlankPasswordUse=1）→ 首选设非空密码；用户同意降级时两层同时放行
  （PermitEmptyPasswords yes + Restart-Service sshd + LimitBlankPasswordUse=0），判据 BLANK_PW_OK，
  建好免密通道后立即回滚两层。
- 公钥无效 → 写错了落点：Administrators 组成员必须写
  C:/ProgramData/ssh/administrators_authorized_keys；icacls 用 SID 不用名称。
- 远端 ParserError / 中文乱码 → 改 .ps1 文件 + powershell -File；载荷保持 ASCII。
- 部署报「✅ 完成」但服务没起 → 检查 .env 的 WINVM_DRY_RUN 是否为 1。
- 下载 (28) connect timeout → 链路抖动，加 --retry-all-errors -C - 重试。
- 隧道 TCP 通但 HTTP 黑洞 → 看 tunnel status 的 ownerMatch/stateStale，kill 旧 pid 后 ensure。
- tools/list 能看到高危工具 → 正常（原始面恒列全 54），闸门在宿主 mcp.json 的 disabledTools。
- a2a.delegate 报 goal 必填 → 参数是 goal（自然语言），不是 capability/input。
- /a2a/health 404 → 该路由不存在；发现用 /.well-known/agent-card.json，健康用 a2a.health。
- app.inventory.list 报不支持 limit → 该能力无 limit 形参，传 {}。
```

---

## 4. 分步 Prompt（P1~P6）

需要人工逐步确认时，逐段粘贴；每段自带判据。

### P1 · 建立免密通道

```text
在鸿蒙宿主上完成「密码登录 → 建立免密 ssh 通道」，目标 VM=172.16.100.2 用户=User 端口=22。
1) 建 ~/wbtmp/askpass.sh（只从 $WINVM_SSH_PASSWORD 取值，chmod 700）。
2) 用 SSH_ASKPASS + SSH_ASKPASS_REQUIRE=force + DISPLAY=:0，禁用公钥、只走 password，
   执行 echo PASSWORD_AUTH_OK。判据：输出 PASSWORD_AUTH_OK。
   若 Permission denied：先区分「密码错」与「空密码」。空密码是两层串联拦截
   （OpenSSH PermitEmptyPasswords 默认 no + LSA LimitBlankPasswordUse=1）：
     a. 首选：请用户设一个非空密码，然后从 2) 重跑（不改任何系统策略）。
     b. 仅当用户明确同意降级时，**两层同时**放行：
        sshd_config(C:\ProgramData\ssh\sshd_config) 置 PermitEmptyPasswords yes → Restart-Service sshd；
        注册表 HKLM\SYSTEM\CurrentControlSet\Control\Lsa 的 LimitBlankPasswordUse(DWORD) 置 0。
        判据：空密码 askpass 登录输出 BLANK_PW_OK。
        ⚠ 风险须用户确认：等于所有空密码本地账户可被网络登录（SSH/RDP/SMB）。
        ⚠ 免密通道建成后**立即回滚**两层（改回 no / 1 并 Restart-Service sshd）——后续全程只用公钥。
3) 无则 ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519。
4) 公钥写入 VM 两处（~/.ssh/authorized_keys 与 C:/ProgramData/ssh/administrators_authorized_keys），
   后者 icacls /inheritance:r 并只授 Administrators(F)+SYSTEM(F)（用 SID）。
   公钥用 base64 传参、远端 .ps1 解码；远端逻辑一律 .ps1 + powershell -File。
   已存在则去重跳过，绝不覆盖他人 key。
5) 判据：ssh -o BatchMode=yes -o PreferredAuthentications=publickey
        -o NumberOfPasswordPrompts=0 User@172.16.100.2 whoami 成功。
停止条件：任一判据不过即停并报告四元组；空密码分支必须先取得用户对"降级"的明确同意，
且回滚未完成不得进入下一步。
```

### P2 · 获取并校验 Release

```text
从 GitHub Release 取 WinVM Bridge 分发包并做三层校验。
  REPO=athronix/workbuddy-virtual-win-plugin  TAG=V1.4.9  ZIP=winvm-overall-V1.4.9.zip
1) 用绝对 URL（不要 releases/latest）下载 zip 与 .zip.sha256 到 ~/winvm-deploy/pkg/，
   带 --connect-timeout 20 --max-time 900 --retry 5 --retry-delay 3 --retry-all-errors -C -。
   判据①：sha256sum -c 通过。
2) 解压到 ~/winvm-deploy/overall-root（zip 内含顶层 overall/，包根为 .../overall-root/overall）。
3) 判据②：python3 qa/deploy-probes/verify-manifest.py <包根> 输出 RESULT: PASS。
4) 判据③：包根下存在 README.md / MANIFEST.txt / delivery/install-host.mjs / delivery/deploy-vm.mjs。
若 connect timeout，先 curl -I https://github.com 判抖动还是断网，抖动则重试。
```

### P3 · 部署 VM-service

```text
在包根内用免密通道部署 VM 侧服务。
0) 先做运行时前置自检（硬门禁，缺一即中止）：
   scp qa/deploy-probes/vm-env-check.ps1 User@172.16.100.2:C:/Users/User/vm-env-check.ps1
   ssh User@172.16.100.2 'powershell -NoProfile -ExecutionPolicy Bypass -File C:/Users/User/vm-env-check.ps1'
   判据：ENV_PRECHECK=PASS 且 BLOCKERS=none（NODE_OK / NPM_FOUND / CLI_OK 全 true）。
   缺失按序补齐：node<18 → nvm install/use（无 nvm 用 MSI，勿用 winget）；
                 npm 缺 → 随 Node 装；codebuddy 缺 → npm i -g @tencent-ai/codebuddy-code@latest
                 （默认 latest，不锁版本）。
1) cp -n .env.example .env；确认 VM_HOST=172.16.100.2 / VM_USER=User / VM_SSH_PORT=22 /
   VM_DEPLOY_DIR=C:/WinVMBridge / WINVM_SERVICE_PORT=18443 /
   WINVM_VM_PROVIDER=workbuddy / WINVM_WORKBUDDY_CLI=codebuddy；并把 WINVM_DRY_RUN 改为 0。
2) node delivery/deploy-vm.mjs --skip-build --env=.env 看规划，确认后
   node delivery/deploy-vm.mjs --apply --skip-build --env=.env 真执行。
3) 判据：scp qa/deploy-probes/vmcheck.ps1 到 VM 并 powershell -File 执行，得到
   task_state=Running、listen_addr=127.0.0.1、listen_count=1、side_json=true、
   bridge_dir=true、health_http=200、health_body.ok=true。
注意：--skip-build 必须加；WINVM_DRY_RUN=1 会让 --apply 变 dry-run（假成功）。
```

### P4 · 安装宿主插件与隧道

```text
在包根内安装宿主侧插件、连接器与隧道。
1) node delivery/install-host.mjs --yes --vm-host 172.16.100.2 --vm-user User --vm-ssh-port 22
   （末尾会自动拉起常驻隧道）
2) 判据①：node ~/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0/winvm-plugin.mjs
          tunnel status --json → state=RUNNING healthy=true ownerMatch=true stateStale=false
3) 判据②：node delivery/install-host.mjs --check-fresh → FRESH
4) 判据③：curl http://127.0.0.1:18443/health → 200
5) 判据④：读 ~/.workbuddy/mcp.json，winvm 条目 disabledTools 长度=8
额外自检：安装日志若出现「连接器自检 ⚠ 诊断工具缺失」，说明包内缺 delivery/tools/，
属发布包内容缺口，请在报告中记录（不影响安装结果）。
若安装后 connectors/skills/mcp.json 或 connectors/marketplace-meta/mcp.json 被写入 winvm，
说明用的是早于 P2-3 修复的旧包，请把这些文件移入可恢复备份并在报告中记录。
```

### P5 · 全维度测试与报告

```text
对已完成的部署做全维度验收并出报告。
1) python3 qa/deploy-probes/mcp-probe.py   → 20 项（健康 6 / MCP 面 7 / 跨域功能 5 / A2A 发现 2）
2) python3 qa/deploy-probes/a2a-probe.py   → 5 项（stdio 桥 / a2a 工具 / health / 真委派）
判据：两个脚本均 RESULT: PASS（合计 25/25）。
3) 写 qa/real-test-<日期>-run<N>.md，含四张表：健康、连接（MCP+A2A）、功能抽样、失败四元组，
   并给出「可交付 / 有阻塞」结论。
断言注意：
 - 不要断言「/mcp 的 tools/list 不含 8 个高危工具」——原始面恒列全 54，闸门在宿主 disabledTools。
 - app.inventory.list 不接受 limit，传 {}。
 - a2a.delegate 必填 goal（自然语言），不是 capability/input。
 - 没有 /a2a/health 路由；发现用 GET /.well-known/agent-card.json，健康用 MCP 工具 a2a.health。
```

---

### P6 · 交付引导（加载 hos-win-skill 并示范任务下发）

```text
部署已通过，现在进入交付引导：让用户能正确下发 Windows 任务。
1) 加载 @skill:hos-win-skill（host-only：VM 侧不分发；宿主侧用户级 ~/.workbuddy/skills/ 或连接器目录
   任一供入即可——V1.4.3 起各包/HEAD 安装连接器=8 含之；历史 V1.4.2 包=7 时靠用户级副本），由它带入 winvm-orchestrator。
   判据：connector-winvm 目录数=8（V1.4.3 起包与 HEAD 均 8，含 hos-win；历史 V1.4.2 包=7）；hos-win-skill 用户级或连接器内任一供入即可。
2) 向用户复述通道三铁律：风险优先（L2/L3 必走 a2a.delegate）／步骤定界（1~2 步可穷举走 MCP 直调）
   ／先探后定（先 L0 读能力取事实，遇 DELEGATION_REQUIRED 立即转委派）。
3) 给 3 个可直接粘贴的示范（覆盖两条通道）：
   - 「在 Windows 虚拟机里列出所有已安装软件，只查不改，给表格」（MCP 直调）
   - 「分析 VM 的 C 盘空间占用，给前 10 大目录，只读」（MCP 直调）
   - 「VM 上 WinVMBridge.Service 停了，查明原因并恢复，最后确认 /health 正常」（A2A 委派）
4) 反例提醒：不要让助手「ssh 进 VM 跑 Get-Service」——会绕过审批闸，且不留审计回执；
   L2 动作（删除/卸载/写注册表）必须走委派以取得审批卡。
5) 能力实测状态见 `deploy-strategy.md` §9.2：标 ⏳ 的场景**语义已核但未实跑**，不要对用户
   宣称"已验证"。VM 恢复后跑 `python3 qa/deploy-probes/example-probe.py` 补测（只读）。
```

---

## 5. 验收命令速查

```sh
NODE=/data/storage/el1/bundle/libs/arm64/node/bin/node
PY=/data/service/hnp/bin/python3
PKG=~/winvm-deploy/overall-root/overall

# 包完整性（以包内 MANIFEST.txt 为准；历史样例 V1.4.6=881/7,606,427 B）
$PY qa/deploy-probes/verify-manifest.py "$PKG"

# VM 运行时前置（node / npm / codebuddy CLI / 登录态）——部署前必过
scp qa/deploy-probes/vm-env-check.ps1 User@172.16.100.2:C:/Users/User/vm-env-check.ps1
ssh User@172.16.100.2 'powershell -NoProfile -ExecutionPolicy Bypass -File C:/Users/User/vm-env-check.ps1'
#   → ENV_PRECHECK=PASS / BLOCKERS=none / CLI_VERSION=2.167.0 / AUTH_VERDICT=config-dir-present
#   自测：加 -SimulateMissing 应得 FAIL+三条 hint；已装时加 -Fix 应短路不重装
#   兜底（探针不在发布包时，实测可原样跑）：三项都出版本号即 PASS
ssh User@172.16.100.2 'powershell -NoProfile -Command "node -v; npm -v; codebuddy --version"'

# VM 侧判据（任务 / 端口 / side.json / health 一次取全）
scp qa/deploy-probes/vmcheck.ps1 User@172.16.100.2:C:/Users/User/vmcheck.ps1
ssh User@172.16.100.2 'powershell -NoProfile -ExecutionPolicy Bypass -File C:/Users/User/vmcheck.ps1'

# 宿主侧隧道与对账
$NODE ~/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0/winvm-plugin.mjs tunnel status --json
cd "$PKG" && $NODE delivery/install-host.mjs --check-fresh

# 健康 + A2A 发现
curl -s http://127.0.0.1:18443/health
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18443/.well-known/agent-card.json

# 全维度验收（25 项）
$PY qa/deploy-probes/mcp-probe.py
$PY qa/deploy-probes/a2a-probe.py
```

---

## 6. 排错速查

| 现象 | 根因 | 处置 |
|---|---|---|
| 密码登录 `Permission denied` | 密码错 / 账户禁用 / **空密码**（两层串联拦截） | 先 `Get-LocalUser User` 看 `Enabled`/`PasswordRequired`。空密码 → **首选设非空密码**；次选两层同时放行（`PermitEmptyPasswords yes`+`Restart-Service sshd`，`LimitBlankPasswordUse=0`），判据 `BLANK_PW_OK`，**建好免密后立即回滚**。**不要**只改其中一层（一定失败） |
| key 登录仍要密码 | 管理员组成员写了 `~/.ssh/authorized_keys`（被忽略） | 写 `C:\ProgramData\ssh\administrators_authorized_keys` + `icacls /inheritance:r`（用 SID） |
| `ssh` 卡在密码提示 | 无 TTY 且未设 askpass | `SSH_ASKPASS` + `SSH_ASKPASS_REQUIRE=force` + `DISPLAY=:0` |
| 下载 `curl (28)` connect timeout | 链路抖动（非封禁） | `--retry 5 --retry-all-errors -C -`；用 `releases/download/<TAG>/` 绝对 URL |
| 部署打「✅ 完成」但服务没起 | `.env` 的 `WINVM_DRY_RUN=1` | 改 `0` 重跑 |
| 部署前 preflight 报 `vm-node` 失败 | VM 无 Node 或 <18（`blocking`，直接中止） | Step 3.0：有 nvm → `nvm install 24.21.0 && nvm use 24.21.0`；无 nvm → MSI 静默装（需桌面会话） |
| preflight 报 `vm-npm` 失败 | 有 node 无 npm（安装残缺） | 重装完整 Node 发行版，不要单独补 npm |
| preflight 报 `vm-agent-cli` 失败 | VM 内 `codebuddy --version` 非 0 | `npm i -g @tencent-ai/codebuddy-code@latest`；或临时切 `workbuddy-deterministic` 先通链路（**须用户同意**） |
| 装完 codebuddy 又「找不到命令」 | `nvm use` 切了 Node 版本，全局包在旧 prefix | 当前版本重装 CLI；核对 `npm config get prefix` |
| 想用 `winget` 装 Node | ssh 非交互会话 MSIX alias 空壳（`--version` 空、exit 0） | `prepare-vm --ensure-node` 的 zip+npmmirror 兜底（V1.4.9 起内置）；或 nvm/MSI |
| sshd 在跑、端口在听，但宿主连不上（超时） | 防火墙规则 Profile 与网卡 Profile 不匹配（规则=Private，网卡=Public） | VM 管理员 PS：`Set-NetFirewallRule -Name OpenSSH-Server-In-TCP -Profile Any`（Step 0.4） |
| Step3 apply 报「cd C:/WinVMBridge 找不到路径」反复失败 | ≤V1.4.8 安装载荷为 Git-Bash 专属语法而 sshd 默认 shell=cmd.exe（R8 隐藏前置） | V1.4.9 起已根除（.ps1/EncodedCommand 跨壳通道）；旧包临时兜底=VM 管理员 PS 设 `HKLM:\SOFTWARE\OpenSSH` DefaultShell=Git-Bash 后重启 sshd |
| Node MSI 静默装报 1603 / `Start-Process` 报 MissingArgument | per-user 不支持该机 MSI 形态 / PS 引号塌缩 | zip+镜像方案（prepare-vm DB-3 兜底）或 schtasks 拉起脱离 SSH 会话 |
| 偶发 ssh/scp 一两次失败 | 桥接链路抖动 | 重试封装（vmssh/vmscp 三试）内自愈；不要当配置错误排查 |
| VM 一段时间后隧道黑洞/服务无响应 | hypervisor 自动暂停/睡眠 | Step 0.3：虚拟机设"从不"自动暂停+开机自启 |
| 远端 `ParserError` / 乱码 | 内联 `-Command` 被本地 bash 展开 `$_` | 写 `.ps1` → `scp` → `powershell -File`；ASCII 载荷 |
| `--check-fresh` 报 MISSING/多余 | 缓存白名单与 integrity 面不同源 | 两处名单同名同源（SECURITY-GOVERNANCE §9.2） |
| 会话里看不到 `winvm__*` 工具 | 连接器配置在**新会话**才注入 | 重跑 `install-host` 后新开会话 |
| VM `/health` 通、宿主不通 | 隧道未起/旧隧道占监听 | `tunnel status` 看 `ownerMatch`/`stateStale`，kill 旧 pid 后 `ensure` |
| GUI 能力失败 | 会话非交互/已锁屏 | 用 LogonTrigger 已登录会话；锁屏属 Windows 安全边界 |
| `tools/list` 有高危工具 | 正常（原始面恒 54） | 闸门在宿主 `mcp.json` 的 `disabledTools`（8 条） |
| `a2a.delegate` 报 `goal 必填` | 参数是 `goal` | 传 `{"goal":"…"}`，可带 `maxRisk` |
| `/a2a/health` 404 | 路由不存在 | 发现用 `agent-card.json`，健康用 MCP `a2a.health` |
| `app.inventory.list` 不支持 `limit` | 无形参 | 传 `{}` |
| 安装后 `connectors/skills/mcp.json` 被写 winvm | 用了早于 P2-3 修复的旧包 | 移入可恢复备份；从 HEAD 重打并发布新版本 |
| 清理后 `git push` 报 `Permission denied (publickey)` | 删掉的 `~/.ssh/id_ed25519` 同时是 GitHub 推送凭据（一号多用） | 从清理备份恢复为独立文件 `~/.ssh/id_ed25519_github`（600），推送时 `GIT_SSH_COMMAND="ssh -i … -o IdentitiesOnly=yes"`；**长期正解是 GitHub 与 VM 各用一把密钥** |

---

## 7. 已知待确认 / 待处置

| # | 项 | 现状 | 需谁决定 |
|---|---|---|---|
| 1 | ~~是否发布 V1.4.3~~ | **已裁决并执行（10-26 用户批准）**：V1.4.3 已上架（G-1 修复入包+V5 断言），清场重装 run2 复验非账户零污染 | ✅ 关闭 |
| 2 | ~~G-2 MANIFEST 无消费者~~ | **已收编**：`delivery/verify-release.mjs`（四判据+V5）随包分发，Step 2 判据二入口 | ✅ 关闭 |
| 3 | **本轮变量是否即为长期默认** | 见 §2 全表（`172.16.100.2` / `User` / `18443` / `workbuddy` / latest 现解，示例 `V1.4.9`）；provider/@latest 两项已裁定 | 用户：其余项逐项确认 |
| 4 | **VM 密码管理方式** | 当前经 `WINVM_SSH_PASSWORD` 运行期注入，未落任何文件 | 用户：确认是否维持该方式 |
| 5 | ~~G-3 deploy-probes 不进包~~ | **已收编**：V1.4.3 包内 `qa/deploy-probes/` 6 件 + `delivery/tools/diagnose-connectors.mjs`（PACKAGE_REQUIRED 必存断言兜底），纯 Release 安装链零仓库依赖 | ✅ 关闭 |
| 6 | ~~VM 默认 shell=Git-Bash 隐藏前置~~ | **已根除（V1.4.9/迭代12）**：安装/拆除/探针全部远端命令改跨壳通道（cmd.exe 兼容），sshd 保持出厂默认即可；新宿主机复盘 R8 落账 ISSUES I-6.5 | ✅ 关闭 |

---

## 8. 异常处置与决策交互协议（执行中遇到困难时）

> 这一节是**给执行者的行为约束**：部署的目标不是"一次就过"，而是**遇到问题能挖到根因、
> 把选择权交回用户、并最终跑通**。**禁止**静默降级、禁止把警告当通过、禁止同一动作反复盲试。

### 8.1 三段式（每次失败都必须走完，缺一不可）

**① 定位根因 → ② 给方案 → ③ 要决策。** 只报"失败了"属不合格。

取证最小集（缺任一项都算没定位）：

| 要素 | 具体要抓什么 |
|---|---|
| 原始退出码 | `$?` / `$LASTEXITCODE` / 命令自身的 exit code |
| stderr **首行** | 不要贴整段日志（首行通常就是根因） |
| 该步**判据字段**实际值 | `ENV_PRECHECK` / `BLOCKERS` / `task_state` / `health_body.ok` / `tunnel.state` / `tunnel.ownerMatch` |
| 一条**对照证据** | 同命令换 provider/端口/路径的结果，或"已知可用基线值"（如 `latest=2.176.0`） |

### 8.2 问题分类 → 根因定位 → 候选方案

| 类别 | 典型现象 | 根因定位（具体做法） | 方案（推荐在前） |
|---|---|---|---|
| **版本问题** | `vm-agent-cli` 失败；`codebuddy --version` 非 0；切 Node 版本后命令消失 | `npm ls -g --depth=0`；`npm config get prefix`；`Get-Command codebuddy` | ① `npm i -g @tencent-ai/codebuddy-code@latest`（默认策略）② 切回原 Node 版本 ③ 临时改 `workbuddy-deterministic`（**须用户同意**） |
| **依赖缺失** | `NODE_OK=false` / `NPM_FOUND=false` | `node -v`；`npm -v`；`nvm list` | ① 有 nvm：`nvm install <LTS> && nvm use …` ② 无 nvm：MSI 静默装（需桌面会话）③ 改 deterministic（**须用户同意**） |
| **变量默认值错误** | 端口占用 / IP 不通 / 路径不存在 / 开关不生效 | 逐项核 §2 变量表 vs 实际：`Get-NetTCPConnection -State Listen`、`ping`、`Test-Path` | ① 改 `.env` 单键重跑（**唯一正确做法**）② 改能力入参 ③ 换端口/目录（须说明原因） |
| **网络 / 链路** | `curl (28)`、`npm ERR! network`、`Host is unreachable` | `ping -c3`；`curl -I` 连试 3 次；`npm view` | ① `--retry-all-errors -C -` 重试 ② 换绝对 URL ③ 断点续传重下（瞬时抖动 ≠ 封禁） |
| **权限 / ACL** | `Permission denied (publickey)`；sshd 拒绝 key 文件 | `icacls <file>`；`Get-Acl`；`Get-LocalUser` | ① 写 `administrators_authorized_keys` + `icacls /inheritance:r`（用 SID）② 核对账户是否在 Administrators |
| **状态冲突** | 端口被占 / 旧隧道黑洞 / 计划任务卡住 / 服务起不来 | `Get-NetTCPConnection`；`tunnel status --json`；`schtasks /query`；`kill-restart.ps1` | ① kill 旧 PID 后 `ensure` ② `kill-restart.ps1` ③ 清场重装（`--wipe`，**须用户同意**） |
| **断言写错（非缺陷）** | 「`tools/list` 里不该有高危工具」这类失败 | 对照 §5 踩坑：原始 MCP 面恒列 54，闸门在宿主 `mcp.json` | ① 改断言（读 `disabledTools.length===8`）② 报告里注明"验收口径问题，非产品缺陷" |

### 8.3 必须先问用户的 5 类动作（不得自行决定）

1. **降低安全基线**：`LimitBlankPasswordUse=0`、`PermitEmptyPasswords yes`、关防火墙、删 `disabledTools`。
2. **不可逆数据操作**：批量 `file.delete`、`--purge-workspace`、清回收站。
3. **破坏性系统动作**：`power.control`（L3）、终止系统进程、改服务启动类型。
4. **换版本 / 换 provider**：`nvm use` 切 Node、`WINVM_VM_PROVIDER` 改档、升到 `@latest` 改变已验证基线。
5. **放宽验收判据**：「这步先跳过」「警告也算过」。

### 8.4 交互模板（照抄填写即可）

```text
【卡在哪】Step 3.0 / 判据 ENV_PRECHECK
【现象】CLI_OK=false，`codebuddy --version` 退出码 1
【证据】Get-Command codebuddy → %LOCALAPPDATA%\Author Software\nvm\installs\v24.21.0\codebuddy.ps1
        npm ls -g --depth=0 → 无 @tencent-ai/codebuddy-code
        npm config get prefix → %LOCALAPPDATA%\Author Software\nvm\installs\v24.21.0
        对照：npm view @tencent-ai/codebuddy-code version → 2.176.0（registry 可达）
【根因】当前 nvm 版本 prefix 下未安装该包（此前的安装在别的 Node 版本下，切版本后失效）
【方案】A. npm i -g @tencent-ai/codebuddy-code@latest（约 16s，可逆，只影响 VM 用户目录）★推荐
        B. nvm use <旧版本> 回退（可逆，但 Node 可能低于 18 要求）
        C. 临时改 workbuddy-deterministic 先通链路（能力降级，需你同意）
【影响】A 不改服务与数据；B 会导致 requirements 不满足；C 失去 LLM 编排能力
【请选】A / B / C ？
```

### 8.5 重试与收敛纪律

- **同一判据连续失败 2 次 ⇒ 停下来问**（不许第 3 次盲试）；重试前必须改动至少一个变量
  （端口/超时/顺序/凭据/版本），否则是"同样的实验期待不同结果"。
- **多轮交互**：一次问不动就换角度再问（补数据、给对比、给可选项）；每次必须带**可选项 + 推荐项**，
  不许开放式"你说怎么办"。用户不表态时默认选**可逆**方案，并在报告里写明"默认选择"。
- **决策台账**：每轮结论追加到 `~/winvm-deploy/deploy-session.md`
  （步骤 / 现象 / 根因 / 决策 / 结果）。上下文丢失后**先读它**，不要重复问同一件事。
- **成功定义**：Step 0~5 判据全过 + 25 项验收全绿。有阻塞必须给
  「可交付 / 有阻塞（阻塞点 + 影响 + 建议）」明确结论，**不许把警告当通过**。

---

## 9. 变更记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-10-26 | v1.0 | 首版：变量表（待确认）+ 总 Prompt + 分步 Prompt P1~P5 + 验收速查 + 排错 + 待确认清单；依据 `qa/real-test-2026-10-26-run1.md`（25/25 PASS） |
| 2026-10-26 | v1.1 | P3 新增 **3.0 运行时前置自检**（node≥18 / npm / codebuddy CLI / 登录态）+ §2.6 VM 运行时前提变量表（原 2.6 → 2.7）+ 验收速查与排错各补条目 + §7-6 CLI 版本策略待确认。三例真机验证：正例 PASS / `-SimulateMissing` FAIL+hint / `-Fix` 幂等短路 |
| 2026-10-26 | v1.2 | P1 新增 **空密码分支**（首选设密码／次选两层同时放行 + 建好即回滚，判据 `BLANK_PW_OK`）+ `VM_PW_MODE` 变量 + 排错拆「有密码/空密码」两条 + 总 Prompt 与排错速查同步。双层实测取证：`LimitBlankPasswordUse=1`、`PermitEmptyPasswords` 默认 `no`（两行均注释） |
| 2026-10-26 | v1.3 | ① 安装统一 **`@latest` 不锁版本**（§2.6 注明，全文命令改 `@latest`，原待确认第 6 项已裁定并移除）② 新增 **§8 异常处置与决策交互协议**（三段式取证/7 类问题定位与方案/5 类必问动作/交互模板/2 次重试熔断/决策台账）③ 新增 **P6 交付引导**（加载 `hos-win-skill`+`winvm-orchestrator`、通道三铁律、示范 prompt、反例提醒）；原 §8 变更记录顺延为 §9 |
| 2026-10-26 | v1.4 | P6 增加「能力实测状态」提示（引用 strategy §9.2）；新增只读补测脚本 `qa/deploy-probes/example-probe.py`。**本轮 VM 于 18:05 起从宿主不可达**（网关通、VM 不应答），Step 6 示例中 7 项标 ⏳ 未实跑 |
| 2026-10-26 | v1.5 | **V1.4.3 发布同步**：RELEASE_TAG/ZIP_NAME/HOST_SKILL_DIR（实测 8）升版；总 Prompt/P2/P3/P6 版本引用同步；§7 待确认 1/2/5（G-1/2/3）销账关闭；Step 2 判据二入口=包内 verify-release.mjs |
| 2026-10-27 | v1.6 | **V1.4.4 版本引用同步**（10-27 回环实测时发现 v1.5 仍写 V1.4.3——本次回环 Step 3~5 走既有包根未触发下载面，故此前未暴露）：§2.2 RELEASE_TAG/ZIP_NAME/ZIP_SHA256/PKG 三元组、总 Prompt、P2、§5 速查升 V1.4.4（03cef597…/876/7422500/5f50a2c2…）；头注加对偶行（undeploy-prompts） |
| 2026-10-30 | v2.4 | **新宿主机复盘收编（迭代12/V1.4.9）**：`deploy.prompt` 升 v2.0——新增 Step 0 前置检查（0.1 VM 非空密码提醒/0.2 OpenSSH Server 安装启动方法/0.3 虚拟机电源"从不暂停+自动开机"/0.4 防火墙 Profile 诊断修复/0.5 桥接抖动重试），执行协议 P-1~P-3（缺信息问用户；可自动化项**审批后**补齐、人工项给精确方法），NODE/PY 自动探测多候选回退（R5），vmssh/vmscp 重试封装（R4），Step 6.1 判据改连接器目录=8 为准（R11）；母本同步 Step 0/执行协议/排错 +6 行。代码面=I-6.5 R8 根除：vmInstallCommand（Git-Bash 专属）→ buildVmInstallPs1（.ps1 铁律通道），bootstrap trust/marker、uninstall 清理、winvm-plugin 卸载远程段全改跨壳形态；prepare-vm DB-3 增 zip+npmmirror 兜底（R7）。**sshd 默认 shell 不再要求 Git-Bash，cmd.exe 出厂默认可直装** |
| 2026-10-29 | v2.3 | **I-6.4 入包+V9 断言（迭代11/V1.4.8）**：run2 抓出的探针双缺陷修复随本迭代入包（V9 机械化核验包内 verify-manifest/verify-release/vmcheck 三特征）；§2.2 RELEASE_TAG/ZIP 示例值升 V1.4.8；§5 速查包完整性行改指包内 MANIFEST（sha 自指彻底不写） |
| 2026-10-29 | v2.1 | **文档自指根除（迭代10/V1.4.7）**：§2.2 `ZIP_SHA256`/`PKG 三元组`不再硬编码逐版本值→改「现取现验：旁挂 sidecar + 包内 MANIFEST.txt 头七行，verify-manifest 复算即验」（标记 `MANIFEST-sidecar-authoritative`）——从此**包内快照与仓库正文口径一致、永不过期**（此前每包内文档恒落后一版的结构性陈旧被根除，非再订正一次而是取消硬编码）；`RELEASE_TAG` 行标注示例值+latest 现解为准；pack-release 新增 **V8 断言**（包内两篇部署文档必含该标记，缺失 fail-loud 拒产包=口径倒退机械化封堵） |
| 2026-10-29 | v2.0 | **迭代9 · V1.4.6 版本引用同步**：§2.2/总 Prompt/§5 速查升 V1.4.6（zip `dc417bf2…`/2,846,225 B/三元组 881/7606427/`2562a598…`，匿名回环三向一致）；清场重装=包内 uninstall 实弹 19/19+独立复核零残留+setup 七相位+38/38。⚠ **结构性口径**：V1.4.6 包内快照的本文版本表仍写 V1.4.5——zip sha 自指（打包在同步前，同步后订正属仓库面，再重打会再次自指），**包的权威校验值以包内 `MANIFEST.txt` 与旁挂 `.zip.sha256` 为准**（verify-manifest/verify-release 即读它） |
| 2026-10-29 | v1.9 | **`.prompt` 入包裁定落地（迭代9/V1.4.6）**：用户裁定 `deploy.prompt`/`undeploy.prompt` 并入 `OVERALL_DOCS`（连同 PACKAGE_REQUIRED 存在性断言+包 README「快速部署/卸载」四步指引）——纯 Release 装机者解包即得可整段粘贴的安装/卸载脚本；仓库 README 新增 §5.4 配置与用法说明。⚠ 时序教训沿用：**pack 前文档先 commit** |
| 2026-10-29 | v1.8 | **纯 Prompt 脚本抽面**：新增 `docs/deploy/deploy.prompt`（本文 §3 总 Prompt + 运行期注入变量段的独立可粘贴脚本，v1.0）；同日与 `undeploy.prompt` 一并真机回环验证（拆除 19/19+独立复核零残留 → 部署 Step 3.0~6.1 判据逐条一致，三探针 38/38 首跑即稳，报告 `qa/real-test-2026-10-29-run1.md`）。脚本自纠两口径：PKG_ROOT 双布局判定法（S-1）、U4.2 VM 复核禁内联 -Command 改 .ps1 -File（S-2，踩坑即固化警示）。是否入 OVERALL_DOCS 随包分发=下迭代统一裁定（backlog） |
| 2026-10-28 | v1.7 | **V1.4.5 版本引用同步（迭代8）**：§2.2/总 Prompt/P2/§5 升 V1.4.5（zip `a225cc95…`/三元组 879/7580107/`88fd11c1…`——首打包早于 docs 同步，@6745a50 包已被 `V1.4.5.superseded-it1` 封存，**重打包 @76c0c65**）；V1.4.5=I-6.3 收编版（uninstall 对称修复入包+pack V7 断言）且**包内新带 docs/deploy/ 三篇 Prompt 总集**——Step 2 起包根内即可直读本文与 undeploy-prompts |

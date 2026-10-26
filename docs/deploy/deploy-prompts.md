# WinVM Bridge · 部署 Prompt 总集（deploy-prompts）

> 文档 ID：DEPLOY-PROMPTS-v1
> 状态：**六步已真机实测通过**（验收 25/25，见 `qa/real-test-2026-10-26-run1.md`）
> 更新：2026-10-26
> 上游：`docs/deploy/deploy-strategy.md`（论证与实测记录）、`docs/INSTALL-GUIDE.md`（逐项细节）
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
| `VM_PASSWORD` | `<运行时注入>` | `WINVM_SSH_PASSWORD` | **必须非空**（空密码被 Windows LSA 禁网登） | ☐ |
| `VM_SSH_PORT` | `22` | 同左 | sshd 端口 | ☐ |
| `VM_DEPLOY_DIR` | `C:/WinVMBridge` | 同左 | VM 侧程序目录 | ☐ |
| `VM_WORKSPACE` | `C:/WinVMWorkspace` | 同左 | VM 侧工作区 | ☐ |

### 2.2 分发包

| 变量 | 默认值 | 本轮实测 | 说明 | 确认 |
|---|---|---|---|---|
| `GITHUB_REPO` | `athronix/workbuddy-virtual-win-plugin` | 同左 | 仓库全名 | ☐ |
| `RELEASE_URL` | `https://github.com/athronix/workbuddy-virtual-win-plugin/releases/latest` | 解析到 `V1.4.2` | latest 跳转页 | ☐ |
| `RELEASE_TAG` | `V1.4.2` | 同左 | 发布标签（**建议升 V1.4.3**，见 §7） | ☐ |
| `ZIP_NAME` | `winvm-overall-V1.4.2.zip` | 2,722,056 B | 分发单元 | ☐ |
| `ZIP_SHA256` | `a06e7520…d00e149` | 一致 | 整包校验值 | ☐ |
| `PKG_FILES`/`PKG_BYTES`/`PKG_TOTAL` | `867` / `7313511` / `8d753c70…ecdd3a3` | 一致 | MANIFEST 三元组 | ☐ |
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
| `HOST_SKILL_DIR` | `~/.workbuddy/connectors/skills/connector-winvm` | 8 个 Skill | Skill 缓存 | ☐ |
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

### 2.6 宿主工具路径（鸿蒙沙箱必须绝对路径）

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
  RELEASE_TAG=V1.4.2   ZIP=winvm-overall-V1.4.2.zip
  REPO=athronix/workbuddy-virtual-win-plugin
  DEPLOY_ROOT=~/winvm-deploy   PKG_ROOT=~/winvm-deploy/overall-root/overall
【宿主工具】node=/data/storage/el1/bundle/libs/arm64/node/bin/node（必须绝对路径）
  python3=/data/service/hnp/bin/python3；有 ssh/scp/unzip/sha256sum/curl；无 sshpass
【安全红线】
  - 密码只走运行期环境变量 WINVM_SSH_PASSWORD；禁止写入任何文件、禁止提交、禁止日志回显。
  - 不要为了让密码登录通过而把 VM 的 LimitBlankPasswordUse 改成 0（等于局域网免密登录管理员）。

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
      判据②：RESULT: PASS（逐文件 sha256 + files/bytes 计数 + total-sha256 复算 + 无多余/缺失）
      判据③：README.md / MANIFEST.txt / delivery/install-host.mjs / delivery/deploy-vm.mjs 均在
  若下载 connect timeout：先 curl -I https://github.com 数次，能拿到 200 即链路抖动，重试即可。

────────────────────────────────────────
Step 3 · 部署 VM-service（用免密通道）
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
【排错速查】
- 密码拒绝 → 账户空密码（LSA 禁网登）→ 请用户设非空密码。
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

## 4. 分步 Prompt（P1~P5）

需要人工逐步确认时，逐段粘贴；每段自带判据。

### P1 · 建立免密通道

```text
在鸿蒙宿主上完成「密码登录 → 建立免密 ssh 通道」，目标 VM=172.16.100.2 用户=User 端口=22。
1) 建 ~/wbtmp/askpass.sh（只从 $WINVM_SSH_PASSWORD 取值，chmod 700）。
2) 用 SSH_ASKPASS + SSH_ASKPASS_REQUIRE=force + DISPLAY=:0，禁用公钥、只走 password，
   执行 echo PASSWORD_AUTH_OK。判据：输出 PASSWORD_AUTH_OK。
3) 无则 ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519。
4) 公钥写入 VM 两处（~/.ssh/authorized_keys 与 C:/ProgramData/ssh/administrators_authorized_keys），
   后者 icacls /inheritance:r 并只授 Administrators(F)+SYSTEM(F)（用 SID）。
   公钥用 base64 传参、远端 .ps1 解码；远端逻辑一律 .ps1 + powershell -File。
   已存在则去重跳过，绝不覆盖他人 key。
5) 判据：ssh -o BatchMode=yes -o PreferredAuthentications=publickey
        -o NumberOfPasswordPrompts=0 User@172.16.100.2 whoami 成功。
停止条件：任一判据不过即停并报告四元组，不要尝试改 LimitBlankPasswordUse。
```

### P2 · 获取并校验 Release

```text
从 GitHub Release 取 WinVM Bridge 分发包并做三层校验。
  REPO=athronix/workbuddy-virtual-win-plugin  TAG=V1.4.2  ZIP=winvm-overall-V1.4.2.zip
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

## 5. 验收命令速查

```sh
NODE=/data/storage/el1/bundle/libs/arm64/node/bin/node
PY=/data/service/hnp/bin/python3
PKG=~/winvm-deploy/overall-root/overall

# 包完整性（867 文件 / 7,313,511 B / total-sha256）
$PY qa/deploy-probes/verify-manifest.py "$PKG"

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
| 密码登录 `Permission denied` | 账户空密码（`LimitBlankPasswordUse=1`）或密码错 | 设非空密码；**不要**把该注册表改 0 |
| key 登录仍要密码 | 管理员组成员写了 `~/.ssh/authorized_keys`（被忽略） | 写 `C:\ProgramData\ssh\administrators_authorized_keys` + `icacls /inheritance:r`（用 SID） |
| `ssh` 卡在密码提示 | 无 TTY 且未设 askpass | `SSH_ASKPASS` + `SSH_ASKPASS_REQUIRE=force` + `DISPLAY=:0` |
| 下载 `curl (28)` connect timeout | 链路抖动（非封禁） | `--retry 5 --retry-all-errors -C -`；用 `releases/download/<TAG>/` 绝对 URL |
| 部署打「✅ 完成」但服务没起 | `.env` 的 `WINVM_DRY_RUN=1` | 改 `0` 重跑 |
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
| 1 | **是否发布 V1.4.3** | V1.4.2 包（`eba187e`/10-21）早于 10-24~10-25 的 P2 修复，用 Release 安装会带回已修缺陷并污染非账户目录；包内亦缺 `delivery/tools/` | 用户：批准发版 → 后续按 P2/G-1 处置 |
| 2 | **`MANIFEST.txt` 无消费者校验（G-2）** | 已用 `qa/deploy-probes/verify-manifest.py` 临时补齐第 2 步能力 | 用户：是否收编为 `delivery/verify-release.mjs` 正式入口 |
| 3 | **本轮变量是否即为长期默认** | 见 §2 全表（`172.16.100.2` / `User` / `18443` / `workbuddy` / `V1.4.2`） | 用户：逐项确认或改写 |
| 4 | **VM 密码管理方式** | 当前经 `WINVM_SSH_PASSWORD` 运行期注入，未落任何文件 | 用户：确认是否维持该方式 |
| 5 | **`qa/deploy-probes/` 是否进发布包** | 目前随仓库发布（`pack-release` 会带上），第 5 步依赖它 | 用户：确认保留 |

---

## 8. 变更记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-10-26 | v1.0 | 首版：变量表（待确认）+ 总 Prompt + 分步 Prompt P1~P5 + 验收速查 + 排错 + 待确认清单；依据 `qa/real-test-2026-10-26-run1.md`（25/25 PASS） |

# 通过铠大师 App 在新鸿蒙机上安装部署 WinVM Bridge（Release 版）

> 状态：设计方案（V1，2026-10-18）· **R2（REL-11，2026-10-18）：分发起点改为 GitHub Release 匿名下载**（仓库已 public）· 适用发布版本：**V1.4.0+**（`release/{version}/overall` 三包发布形态 + `winvm-overall-<version>.zip` 分发单元）
> 关联文档：`docs/05-peripherals/DEPLOYMENT.md` §9（发布包与一键部署 + §9.1a zip/上架）、`docs/release/RELEASE-V1.4.0.md`、`docs/release/issues.md`

## 1. 背景与目标

本项目部署横跨 **5 个环境层**，其中两层对 WorkBuddy 是硬边界：

| 层 | 说明 | WorkBuddy 可达性 |
|---|---|---|
| L1 鸿蒙宿主 OS | HarmonyOS NEXT，每 App 独立沙箱 + HMMAC，无 root 概念 | ❌ 仅 `$HOME`（hmdfs 共享目录）可读写 |
| L2 WorkBuddy App 沙箱 | `com.tencent.workbuddy`（uid 20020171），自带 node/electron | ✅ 本尊（工作区/沙箱私有 fs） |
| L3 用户共享数据目录 | `/storage/Users/currentUser/`（hmdfs） | ✅ 读写（跨 App 唯一通道） |
| L4 VM Windows 系统层 | OpenSSH Server 安装/防火墙/电源策略等 OS 级前置 | ⚠️ 仅 SSH **之后**可达；sshd 未装时通道不存在（鸡生蛋） |
| L5 VM↔宿主 SSH/隧道 | `ssh/scp` 免密通道 + tunnel-daemon | ✅ 通道建立后 |

**铠大师 App**（自有，鸿蒙端高权限，可在 VM 内安装软件）恰好补齐 WorkBuddy 做不了或做不好的三件事：
1. **L3 落包**：把 release 包放进共享目录（比任何沙箱内传输都稳）；
2. **L4 前置**：VM 侧 OpenSSH Server / 防火墙 / Node /（可选）SSH 公钥注入——解决「sshd 未装则 SSH 通道不存在」的鸡生蛋；
3. **交互降维**：把 WorkBuddy 侧的多步命令压缩成**一条可复制的 install prompt**。

**目标 UX（用户裁定的极简标准）**：铠大师 ≤3 次点击 + 一次粘贴 → 全自动部署 + 验证报告。

## 2. 三方职责矩阵

```
┌─ 铠大师 App ──────────────┐   ┌─ WorkBuddy（宿主沙箱）──────────┐
│ ① 取包落 L3（GitHub        │   │ ④ 解包 → bootstrap check/env    │
│    Release curl+sha256；    │──▶│ ⑤ prepare-vm --apply（幂等兜底） │
│    离线兜底=内置目录复制）  │   │ ⑥ deploy-all.sh --wipe          │
│ ② VM 一键前置（L4）        │   │ ⑦ 验证矩阵 7 项 + 落 report     │
│ ③ 生成并复制 install prompt│   └───────────────┬─────────────────┘
└────────────────────────────┘                    │
        （用户动作：粘贴 prompt，仅此一次）          │
                                ┌────────────────▼────────────────┐
                                │ ⑧ deploy-report.json 写回 L3     │
                                │    铠大师读回 → 状态面板显示 ✅/❌ │
                                └──────────────────────────────────┘
```

- **铠大师**：L3 落包 + L4 前置 + prompt 生成 + 结果读回（新功能规格见 §4）。
- **WorkBuddy**：L5 通道（tunnel-daemon）+ 插件安装 + VM 服务部署 + 功能验证——全部由 prompt 驱动，无交互。
- **用户**：点 3 下 + 粘贴 1 次。

## 3. 端到端流程（新鸿蒙机 SOP）

### 阶段 A：铠大师侧（约 1 分钟，3 次点击）

> **分发链起点（REL-11 起变更）**：仓库已 public（GitHub `athronix/workbuddy-virtual-win-plugin`），
> overall 包以 **GitHub Release 匿名下载资产** `winvm-overall-<version>.zip` 分发——新鸿蒙机
> 任何环境 `curl -L` 即得，不再依赖「本地复制包」。sha256 校验值以 `qa/release/<version>-pack.txt`
> 的 `overall-zip:` 行与 Release 说明正文为准（两处由同一次 pack/publish 产出，一字不差）。

```
A1 [取包]     下载 + 校验 + 解包（Release 资产，匿名可取）：
              · curl -L https://github.com/athronix/workbuddy-virtual-win-plugin/releases/download/V1.4.0/winvm-overall-V1.4.0.zip \
                  -o /storage/Users/currentUser/Downloads/winvm-release/winvm-overall-V1.4.0.zip
              · 旁挂校验（Q-2）：同目录取 winvm-overall-V1.4.0.zip.sha256 → `sha256sum -c` 整包校验
                （旁挂与 zip 同为 Release 资产；校验值另见 qa/release/V1.4.0-pack.txt 的 overall-zip 行）
              · unzip（保留 0755 可执行位，沙箱实测 zip/unzip 往返 rwx 不丢）→ 得 overall/ 目录
              （离线/弱网兜底：仍可由铠大师内置目录直接复制到 ~/Downloads/winvm-release/，G7 真实目录复制）
A2 [VM 前置]  对 VM 执行「WinVM 环境准备」（经铠大师既有 VM 软件安装/PowerShell 通道，
              推送执行 tools/winvm-prepare.ps1 —— 单一真相源，见 §4.3）：
              · OpenSSH Server：Installed 检查 → Add-WindowsCapability（离线回退 MSI）→ Automatic + Running
              · 防火墙：入站 22（仅对内网/虚拟网卡段，服务口 18443 只绑 VM 回环、**无需**开）
              · Node ≥18：缺则静默装（VM 侧服务运行依赖；provider=workbuddy 还依赖 codebuddy CLI，见 §9-G4）
              · 公钥注入（快路径，可选）：从 hmdfs 读 WorkBuddy 摆渡的
                `/storage/Users/currentUser/.workbuddy/winvm/id_ed25519.pub` 写入
                `~/.ssh/authorized_keys` **及** `C:/ProgramData/ssh/administrators_authorized_keys`（icacls 修 ACL）
                ※ Windows OpenSSH 对 Administrators 组成员**忽略** per-user authorized_keys——不注入此文件免密必失败
                ※ Q-1 首机时序：公钥尚不存在 ⇒ K2 不带 -PubKey 先跑（输出 PUBKEY_*=SKIPPED 两行，
                  契约恒在）→ 粘贴 prompt（步骤 1 keygen+摆渡 .pub，trust 一次密码）→ 公钥从此在 hmdfs；
                  **二机起** K2 注入公钥 → prompt 第 4 步 BatchMode 秒过，全链零密码
A3 [复制指令] 表单填 VM IP / 用户名 / provider（版本缺省=latest，§5.2 Q-5 注）→ 生成 install prompt → 复制到剪贴板
```

### 阶段 B：用户（10 秒）

打开 WorkBuddy → 新建任务 → **粘贴 A3 的 prompt** → 发送。

### 阶段 C：WorkBuddy 自动执行（约 6–8 分钟，零交互）

prompt 指令 WB 依次做（细节见 §5）：
1. `curl -L` 取 GitHub Release zip（+旁挂 `.zip.sha256` `sha256sum -c` 整包校验，Q-2）→ 解压到工作区（§5.2 第 1 步；首机含公钥摆渡子步，§5.4）→ `bootstrap.mjs check`（依赖自检）+ `env`（非交互生成 .env）
2. SSH 免密验证：`ssh -o BatchMode=yes … whoami`——若铠大师 A2 已注入公钥则秒过；失败回退 `bootstrap.mjs trust`（一次密码交互，§9-G2）
3. `bootstrap.mjs prepare-vm --apply --ensure-node`（经 SSH 对阶段 A 做幂等兜底，全 [SKIP] 即证 A2 生效；**必须在免密建立之后**——它经 ssh 执行）
4. `cd release && bash deploy-all.sh --wipe`（发布迭代铁律：先清空历史部署→七相位重装；`bash` 前缀防 hmdfs 丢执行位，Q-4）
5. 验证矩阵 7 项（§6）→ 结果写 `/storage/Users/currentUser/.workbuddy/winvm/deploy-report.json`

### 阶段 D：铠大师读回（1 次点击）

铠大师轮询/手动刷新 `deploy-report.json` → 状态面板显示 `ok` / 失败相位 + traceId 证据。

## 4. 铠大师 App 新功能规格（最小集）

按「越简单越好」原则，功能面 = **一个页面 + 三个按钮 + 一个脚本资产**：

### 4.1 UI：「WinVM 部署」页（新增）

```
┌ WinVM Bridge 部署助手 ────────────────────────────┐
│ 发布包来源: ☑ GitHub Release(V1.4.0)  [选择版本▾]  │
│             （兜底：本地包目录 [选择…]）            │
│             → 目标: ~/Downloads/winvm-release      │
│ VM 地址:     [172.16.100.__]  用户: [User]  ☑ 提供 SSH 公钥注入 │
│ Provider:    [workbuddy ▾]                          │
│                                                     │
│ [① 获取发布包]   [② VM 环境准备]   [③ 复制安装指令] │
│ ─────────────────────────────────────────────────── │
│ 部署状态:  ● 等待粘贴安装  /  ✅ 成功(03:41)  /  ❌ VM-START 失败 │
└─────────────────────────────────────────────────────┘
```

### 4.2 按钮契约

| 按钮 | 内部动作 | 失败呈现 |
|---|---|---|
| ① 获取发布包 | 默认：`curl -L` 下载 GitHub Release 资产 `winvm-overall-<version>.zip` → `sha256sum` 对照发布说明/pack 证据 → `unzip` 落 `~/Downloads/winvm-release/`（hmdfs，WB 可读；zip/unzip 往返保留 0755 执行位，沙箱实测）；离线兜底：拷内置 `overall` 目录 | sha256 不符/下载失败/空间不足 → toast（可切兜底） |
| ② VM 环境准备 | 经**既有 VM 软件安装通道**推送并执行 `tools/winvm-prepare.ps1`（§4.3 单一真相源），解析 `KV=VALUE` 输出打勾列表 | 逐项 ❌ + 一行修复建议 |
| ③ 复制安装指令 | 按模板（§5.2）填参生成 prompt 到剪贴板 | — |
| （自动）状态读回 | 每 10s 读 `deploy-report.json`（存在即显示），完成后停止轮询 | 超 30min 无文件 → 「WorkBuddy 尚未开始，请粘贴指令」 |

### 4.3 `tools/winvm-prepare.ps1`（**单一真相源**：本仓库 `tools/` 已落地；ASCII-only，幂等）

> REL-11 起：脚本正式文件 = **`tools/winvm-prepare.ps1`**（本仓库内，已落地并纳入
> 门禁守卫 `tests/unit/winvm-prepare-ps1.test.js`）。本文档不再维护内嵌骨架副本——
> 下方步骤摘要**只作规格说明**，逐字实现以脚本文件为准（防文档与脚本分叉）。

探测先行、只改缺项（与 `delivery/prepare-vm.mjs` DB-1/2/3/公钥注入的判据**保持同一口径**，双实现互证）：

```text
1) sshd: Get-Service → 缺则 Add-WindowsCapability OpenSSH.Server~~~~0.0.1.0
         → Set-Service Automatic → Start-Service
2) firewall: New-NetFirewallRule WinVM-SSH-<port>（先判存在；Profile Any）
3) node: Get-Command node → 缺则 winget install --id OpenJS.NodeJS.LTS --silent
4) pubkey（若提供 -PubKey）：写入 ~/.ssh/authorized_keys + administrators_authorized_keys
   + icacls /inheritance:r /grant 收紧 ACL（bootstrap.mjs trust 同款判据，G1）
输出（KV=VALUE 每行一条，供铠大师解析；契约由守卫单测钉死，改名即门禁红）：
  ADMIN / SSHD_STATE / SSHD_STARTMODE / FW_SSH / NODE /
  PUBKEY_USER_AK / PUBKEY_ADMIN_AK / PREPARE_DONE=True
※ Q-3 契约：**八键恒定出现**——功能跳过时值为 SKIPPED（如无 -PubKey ⇒
  PUBKEY_USER_AK=SKIPPED + PUBKEY_ADMIN_AK=SKIPPED），App 解析器不需要猜缺省。
※ KV 口径定稿（team-lead 裁决）：上列**八核心键恒定输出**；`SSH_PORT` 为附加诊断键。
  App 判据=**八核心键缺失才判异常，未知/附加键忽略**（前向兼容——脚本后续增键不破坏解析）。
```

> 该脚本同时被仓库 `tests/unit/winvm-prepare-ps1.test.js`（编码/锚点/KV 契约）与 WorkBuddy `prepare-vm.mjs`（VM 侧行为）双保险覆盖；铠大师只做「通道执行 + 展示」，**不 fork 脚本**——直接引用 `tools/winvm-prepare.ps1` 同一资产（单一真相源）。

### 4.4 发布流程（仓库侧，一次发布 = 两步命令）

```bash
# ① 打包：三包组装 + V1-V4 包内验证 + overall zip + 旁挂 .sha256（Q-2）
npm run build
node delivery/pack-release.mjs --version V1.4.0
#    产出 release/V1.4.0/{host,vm,overall} + winvm-overall-V1.4.0.zip + winvm-overall-V1.4.0.zip.sha256
#    证据 qa/release/V1.4.0-pack.txt 含两行：
#      overall-zip: <path> sha256=<hex> bytes=<n>
#      overall-zip-sha256-file: <path>     ← 旁挂校验文件（sha256sum -c 兼容，一行 `<hex>  <zipname>`）

# ② 上架 GitHub Release（默认 dry-run 只打印计划；--apply 才真实创建/上传；zip+旁挂两资产一并上架）
git push origin V1.4.0                       # tag 必须先在 GitHub 存在（publish 不建 tag）
node delivery/publish-release.mjs --tag V1.4.0 \
    --zip release/V1.4.0/winvm-overall-V1.4.0.zip          # dry-run 预览
node delivery/publish-release.mjs --tag V1.4.0 \
    --zip release/V1.4.0/winvm-overall-V1.4.0.zip --apply  # 真上架
#    成功打印 Release html_url + 匿名下载 URL（zip 与 zip.sha256 两条）
#    https://github.com/athronix/workbuddy-virtual-win-plugin/releases/download/V1.4.0/winvm-overall-V1.4.0.zip
```

- token 解析顺序 `GH_TOKEN` env → `--token` → `~/.config/gh/hosts.yml`（值绝不打印）。
- 重复发布同 tag：复用既有 release、zip 与旁挂**各自**先删同名旧 asset 再传（幂等，Q-2）。
- 新机侧校验优先 `sha256sum -c winvm-overall-<V>.zip.sha256`（旁挂与 zip 同上架、同目录可比对）；pack 证据 `overall-zip` 行为第二对账源，三处由同一次 pack 产出、一字不差。
- 旁挂缺失 ⇒ publish **warn 继续、只上架 zip**（兼容旧包；新机侧回退包内 MANIFEST/pack 证据校验，WARN 在计划打印中显形、不静默）。

## 5. WorkBuddy 侧：部署执行契约

### 5.1 前置事实（prompt 设计依据，勿依赖未验证能力）

- WB 沙箱内 node = 自带 `/data/storage/el1/bundle/libs/arm64/node/bin/node`；`deploy-all.sh` 已内置探测回退，**无需**配 PATH。
- `ssh/scp/curl/tar` 经 hish 工具链可用；`deploy-all.sh` 无密码交互路径（trust 已免密时）。
- 沙箱写 `~/Downloads` 可行但跨 App 协调弱 → 落包优先走 **GitHub Release 匿名 curl**（WB 自己即可执行，§5.2 第 1 步）；离线兜底才由铠大师复制内置目录（阶段 A1 兜底行）。
- 服务绑定 VM `127.0.0.1:18443`，宿主只经 SSH 隧道访问 → **VM 防火墙只需 22**，服务口不开任何洞。

### 5.2 install prompt 模板（铠大师 A3 生成，逐字可粘贴）

```text
请在本鸿蒙机上安装部署 WinVM Bridge 发布版 {VERSION}，全程自动执行、无需向我确认，最后输出验证报告：

包来源：GitHub Release（匿名下载，见步骤 1）→ 落包目录：~/Downloads/winvm-release/
VM 地址：{VM_HOST}   VM 用户：{VM_USER}   SSH 端口：22   Provider：{WINVM_VM_PROVIDER}

步骤：
1. 从 GitHub Release 匿名下载发布包并校验（REL-11 起的分发起点）：
   mkdir -p ~/Downloads/winvm-release && cd ~/Downloads/winvm-release
   curl -L https://github.com/athronix/workbuddy-virtual-win-plugin/releases/download/V1.4.0/winvm-overall-V1.4.0.zip -o winvm-overall-V1.4.0.zip
   curl -L https://github.com/athronix/workbuddy-virtual-win-plugin/releases/download/V1.4.0/winvm-overall-V1.4.0.zip.sha256 -o winvm-overall-V1.4.0.zip.sha256
   sha256sum -c winvm-overall-V1.4.0.zip.sha256 —— 非 OK 即弃包重取（旁挂校验文件与 zip 同为 Release 资产，Q-2）；
   校验通过后解压（unzip），cd <解压目录>/overall
   首机公钥摆渡（Q-1，一次性；已有 keypair 则整段跳过）：
   [ -f ~/.ssh/id_ed25519 ] || ssh-keygen -t ed25519 -N '' -f ~/.ssh/id_ed25519
   mkdir -p /storage/Users/currentUser/.workbuddy/winvm && cp ~/.ssh/id_ed25519.pub /storage/Users/currentUser/.workbuddy/winvm/id_ed25519.pub
   ※ 只摆渡 .pub 到共享目录（供铠大师后续机注入）；**私钥 id_ed25519 绝不出沙箱**。
2. 写 .env：VM_HOST/VM_USER/VM_SSH_PORT=22/WINVM_VM_PROVIDER={provider}，WINVM_DRY_RUN=0、HOST_DEPLOY=1、VM_DEPLOY=1、
   WINVM_SETUP_TUNNEL=1、WINVM_TUNNEL_LOCAL_PORT=18443、WINVM_TUNNEL_REMOTE_PORT=18443、WINVM_SERVICE_PORT=18443。
3. 前置自检（只读）：node delivery/bootstrap.mjs check —— 有阻塞项先停下并把明细写进报告。
4. SSH 免密验证：ssh -o BatchMode=yes {VM_USER}@{VM_HOST} whoami —— 成功=铠大师公钥注入生效；
   失败则跑 node delivery/bootstrap.mjs trust（可能需要我输一次 VM 密码）；再失败即中止并写报告。
5. VM 前置兜底（须在第 4 步免密之后，本命令经 SSH 执行）：node delivery/bootstrap.mjs prepare-vm --apply --ensure-node
   —— 若铠大师「VM 环境准备」已做完，预期全 [SKIP]（幂等互证）。
6. 按发布铁律清空重装：bash deploy-all.sh --wipe（先双端 uninstall 清场，再 HOST→VM→VM-START→TUNNEL→TEST→QA-PROBE→HEALTH 七相位）。用 `bash <script>` 而非 `./<script>`——hmdfs 落包可能丢执行位，bash 显式解释不依赖 mode 位（Q-4）。
7. 部署成功后跑验证矩阵 7 项并把结果 JSON 写入 /storage/Users/currentUser/.workbuddy/winvm/deploy-report.json：
   {version, ok, finishedAt, phases:{...耗时}, checks:[{id,pass,evidence(traceId/字段摘要)}], failures:[...]}
8. 同时把同样内容贴回对话作为最终回复。任何一步失败：停止后续，report 里写明失败相位、错误原文、根因初判。
```

> 模板中 `V1.4.0` 为示例值；K3 参数化时 `{VERSION}` **缺省=latest**（Q-5）：经匿名 API
> `https://api.github.com/repos/athronix/workbuddy-virtual-win-plugin/releases/latest` 解析 JSON 的 `tag_name`
> 后代入 URL——注意 GitHub 返回**紧凑 JSON**（`"tag_name":"V1.4.0"` 冒号后无空格）；解析结果为空
> **必须停下报「latest 解析失败」，绝不带空 tag 拼 URL 继续**。演练时记录实际解析值。
> （等价快捷形态 `…/releases/latest/download/winvm-overall-<VERSION>.zip` 可免 API 解析，但资产名里
> 的版本段仍需已知 ⇒ 对「完全不知版本」的场景无用，仍需 latest 解析拿 tag。演练时记录实际解析值。）


### 5.3 `deploy-report.json` 契约（铠大师/WB 唯一交接口）

```json
{
  "version": "V1.4.0", "ok": true, "finishedAt": "2026-10-18T10:41:00+08:00",
  "phases": { "WIPE": "17/17 PASS", "HOST": 1.3, "VM": 32.7, "VMSTART": 18.2,
              "TUNNEL": 8.4, "TEST": 0.4, "QAPROBE": 67.1, "HEALTH": 0.5 },
  "checks": [
    { "id": "health",      "pass": true, "evidence": "ok:true provider=workbuddy/ready" },
    { "id": "capabilities","pass": true, "evidence": "count=54 domains=6 tr_xxx" },
    { "id": "systeminfo",  "pass": true, "evidence": "Win11 26200 ARM64 tr_xxx" },
    { "id": "a2a",         "pass": true, "evidence": "steps[0] ok 12.8s tr_xxx" },
    { "id": "gui",         "pass": true, "evidence": "healthy interactive=true" },
    { "id": "audit",       "pass": true, "evidence": "chain=37 receipt=1 card=5skills" },
    { "id": "bothends",    "pass": true, "evidence": "cache=0.1.0 task=Running" }
  ],
  "failures": []
}
```

- 路径固定（L3 共享目录，WB 可写、铠大师可读）；**写完再读**自证（项目坑：写入窗口内读到 0B 假空——WB 落盘后 `stat` 二次确认字节数>0）。

### 5.4 首机公钥摆渡闭环（Q-1，时序说明）

首台新鸿蒙机上 WorkBuddy 沙箱里**还没有** SSH keypair，铠大师 K2 也就无从注入——闭环由 prompt 步骤 1 的摆渡子步补齐：

```
首机（一次性）：
  K2 先跑（无 .pub 可读 ⇒ 不带 -PubKey）→ 输出 PUBKEY_USER_AK=SKIPPED / PUBKEY_ADMIN_AK=SKIPPED（Q-3：键恒在）
  → 用户粘贴 prompt → WB 步骤1：id_ed25519 不存在则 ssh-keygen（-N '' 空口令，全程无交互）
      → cp id_ed25519.pub → /storage/Users/currentUser/.workbuddy/winvm/id_ed25519.pub
      ※ 只摆渡 .pub；**私钥永不离开 WB 沙箱**（L2→L3 单向公开值，安全红线）
  → 步骤4 trust 输一次 VM 密码（§9-G2 兜底路径，仅首机发生）
  → 部署完成；此后 hmdfs 上恒有 .pub 可供 K2 读取

二机起（零密码全链）：
  K2 读 hmdfs .pub → -PubKey 注入 → prompt 步骤4 BatchMode 秒过 → 全链零交互
```

- 摆渡目录 `.workbuddy/winvm/` 与 report 同根（§5.3 路径契约），铠大师已有读权限，无需新增接口。
- `bootstrap.mjs trust` 本身已是双文件+icacls 判据（G1），首机 trust 成功后 VM 侧 ACL 即正确——K2 的二机路径与 trust 殊途同归。
- 多机复用同一 WB keypair：**每台新鸿蒙机沙箱各自 keygen**（互不共享私钥）；摆渡的是「该机 WB → 该 VM」的公钥对。

## 6. 验证矩阵（与 DEPLOYMENT.md §9.4 同源，prompt 第 7 步即执行）

| # | 项 | 判据 | 通道 |
|---|---|---|---|
| 1 | /health | ok:true、provider ready、session healthy | 隧道 curl |
| 2 | meta.capability.list | count=54、六域 | MCP 直调 |
| 3 | system.info.get | OS/CPU/内存/isAdmin 实返 | MCP 直调 |
| 4 | a2a.delegate | L1 goal 终态 ok、steps 结构化回执 | A2A |
| 5 | gui.session.status | healthy、interactive、explorerAlive | MCP 直调 |
| 6 | 审计链+Agent Card | 委派 traceId 在链、字段级回执、五技能 | audit.receipt / a2a.health |
| 7 | 双侧部署态 | 宿主缓存版本路径在册、VM 任务 Running、MANIFEST | ls + schtasks |

## 7. 降级路径（无铠大师时仍可部署）

纯 WorkBuddy + 手工：用户自行在 VM 内装 OpenSSH Server（管理员 PowerShell 一行 `Add-WindowsCapability`，或直接跑 `tools/winvm-prepare.ps1`）、`bootstrap.mjs trust` 输一次密码、**`curl -L` 从 GitHub Release 取包**（public 仓库匿名可取，sha256 对照 pack 证据）——其余步骤（§5.2 的 2–8）完全相同。**铠大师方案没有引入任何新部署语义，只做了「权限补位 + 交互降维」，两条路径共用同一条发布链**（这是方案可行性的根基：发布包/脚本矩阵已被 run1–run4 真机反复验证；发布链见 §4.4）。

## 8. 实施分工建议（可直接拆任务）

| # | 工作项 | 落点 | 状态 |
|---|---|---|---|
| K1 | 「WinVM 部署」页 + ①③按钮 + report 轮询（含 GitHub Release 取包 UI） | 铠大师 App | **待铠大师侧** |
| K2 | `winvm-prepare.ps1` 资产 + ②按钮（走既有 VM 软件安装通道） | 脚本资产=本仓库 `tools/winvm-prepare.ps1`（**已落地**，守卫单测 `tests/unit/winvm-prepare-ps1.test.js` 钉编码/KV 契约）；②按钮接入待铠大师侧 | **资产已落地 / 通道接入待铠大师侧** |
| K3 | prompt 模板（§5.2）参数化生成 | 铠大师 K1 内 | **待铠大师侧** |
| W1 | `bootstrap.mjs check` 增「离线公钥模式」文档说明（公钥由铠大师注入时 trust 跳过密码路径的行为已在 BatchMode 验证中天然覆盖，只需文档确认） | 本仓库 docs | 极小 |
| W2 | 新鸿蒙机真机演练一次（吃自己的狗粮），结果按发布纪律记 `docs/release/issues.md` 或演练报告 | 联调 | 1 轮真机 |
| W3 | 发布链仓库侧资产：pack zip 产物（§4.4 ①）+ GitHub Release 上架器（§4.4 ②）+ 文档改造 | 本仓库 `delivery/pack-release.mjs` / `delivery/publish-release.mjs` / 本文档 | **已落地（REL-11）** |

## 9. 风险与已知坑清单（务必逐条设计规避）

| ID | 风险 | 规避（已内化在上文设计中） |
|---|---|---|
| G1 | Windows OpenSSH **Administrators 组忽略 per-user authorized_keys** | 公钥必写 `administrators_authorized_keys` + icacls ACL（A2-④、prepare 脚本、bootstrap trust 三处同判据） |
| G2 | `bootstrap trust` 需一次密码，与「零交互」冲突 | 快路径=铠大师 A2 注入公钥 → prompt 第 4 步 BatchMode 秒过；密码交互仅兜底 |
| G3 | 新 VM 镜像 sshd 未装（鸡生蛋） | 正是铠大师核心价值：L4 前置在 SSH 之前完成 |
| G4 | provider=workbuddy 依赖 VM 内 codebuddy CLI **登录态**（DB-4 结构性不可脚本化） | 首台机建议先 `WINVM_VM_PROVIDER=workbuddy-deterministic` 跑通全链（零登录依赖），再引导用户完成一次 codebuddy 登录切回 workbuddy；prompt 模板已参数化 |
| G5 | VM 掉线旧隧道黑洞（TCP 通/HTTP 死） | 迭代2 已修：TUNNEL 相位后端 /health 硬判据（evaluateTunnelReuse） |
| G6 | 重装撞 18443 bind EACCES（ps-bridge 孤儿/端口未 drain） | 迭代3 已修：uninstall 先熔断看门狗+三签名查杀；部署端递增等待重试 |
| G7 | hmdfs 不建符号链接 | 落包用**真实目录复制**（K1），勿在共享盘做 junction |
| G8 | 中文文件名路径经 ssh/PS 码页腐化 | 包路径全 ASCII（`winvm-release/winvm-overall-V1.4.0.zip`）；PS 载荷 ASCII-only |
| G9 | 铁律「每轮重部署前清空历史部署」 | prompt 第 6 步固定 `--wipe`，不可省略 |
| G10 | report 文件写入窗口假空 | §5.3：写完 stat 二次确认；铠大师读 `finishedAt` 字段存在才采信 |
| G11 | 新鸿蒙机 WB 未安装/未登录 | K1 页面顶部前置检测项①：共享目录存在 + WB 版本探测（可读 `~/.workbuddy/` 结构）；缺则提示用户装 WB |
| G12 | `bootstrap.mjs env --参数` 模式不覆盖 `WINVM_DRY_RUN`（模板缺省=1），而 setup 有「`WINVM_DRY_RUN=1` 时即便 `--apply` 也强制 dry-run」的防呆兜底 → 新机器部署会**全程假成功**（只打印计划不动真格） | prompt 第 2 步**显式写** `WINVM_DRY_RUN=0`；§6 验证矩阵的 traceId 实调证据天然不可伪造，report 缺 traceId 即可判此坑 |

## 附录 A：winvm-prepare.ps1（已转正：单一真相源 = `tools/winvm-prepare.ps1`）

REL-11 起本附录**不再维护骨架代码**（文档内嵌副本=分叉温床，旧骨架已删）。
正式实现见仓库文件 **[`tools/winvm-prepare.ps1`](../../tools/winvm-prepare.ps1)**：

- 参数：`-PubKey '<ssh public key line>'`（可选）、`-SshPort 22`（默认）
- 四步：① sshd（Add-WindowsCapability→Automatic→Running）② 防火墙入站（`WinVM-SSH-<port>` 先判存在）
  ③ node（缺则 `winget install --id OpenJS.NodeJS.LTS --silent`）④ 公钥双文件注入 + icacls 收紧（G1）
- 编码铁律：ASCII-only + CRLF + 无 BOM（PS 5.1 码页坑），由 `tests/unit/winvm-prepare-ps1.test.js` 机检钉死
- KV 输出契约：`ADMIN / SSHD_STATE / SSHD_STARTMODE / FW_SSH / NODE / PUBKEY_USER_AK / PUBKEY_ADMIN_AK / PREPARE_DONE`（八核心键恒定；`SSH_PORT` 附加诊断键，App 对未知/附加键忽略——§4.3 口径）
- 判据口径：与 `delivery/prepare-vm.mjs`（DB-1/2/3）、`delivery/bootstrap.mjs trust`（G1 双文件+ACL）同源互证

铠大师接入方式：把该文件随 App 资产内置或运行时拉取（public 仓库 raw URL 亦可），经既有 VM 软件安装通道
推送执行、解析 KV——**不要 fork 修改**；需求变更走本仓库 PR + 守卫单测。

## 附录 B：时序图

```
用户            铠大师                     共享目录 L3            WorkBuddy(L2)          VM(L4/L5)
 │ ① 打开页面     │                            │                      │                    │
 │                │（A1 兜底=内置目录复制；    │◀──curl -L GitHub Release zip+旁挂.sha256───│ （仓库 public，
 │                │  默认 WB 粘贴后自取包）     │      sha256sum -c → unzip → overall/      │  匿名下载，Q-2/Q-5）
 │ ② 点「VM准备」 │──tools/winvm-prepare.ps1(既有通道)─┼───────────────┼───────────────────▶│ sshd/FW/node/pubkey
 │                │◀──KV 输出（全 ✅；无公钥时 PUBKEY=SKIPPED 两行恒在，Q-3/Q-1 首机时序见 §5.4）──│
 │ ③ 点「复制指令」│─按模板生成 prompt（版本缺省=latest 解析，Q-5）      │                    │
 │ ④ 切到 WB 粘贴 ─┼────────────────────────────┼─▶ 取包校验/摆渡.pub/check/env/prepare兜底/trust(BatchMode秒过)
 │                │                            │   bash deploy-all.sh --wipe ────────────▶│ 清场→七相位（Q-4）
 │                │                            │   验证矩阵 7 项 ◀─────────────────────────│ 54能力/A2A/审计
 │                │                            │◀─deploy-report.json──│                    │
 │ ⑤ 看结果      │◀─轮询读 report──────────────│                      │   （或对话内报告）  │
```

# 部署分割：两端产物 + 一份通道配置脚本

> 定位：本文是 `11-ARCHITECTURE-VNEXT.md` 的**部署层**配套。架构讲「运行时怎么跑」，本文讲「怎么装」。
> 核心要求（owner 原话）：**部署安装分割成完全独立的 3 部分** ——
> ① host WorkBuddy 沙箱端 ② VM 端 ③ 通道。
> 后续澄清：**release 包包括 2 端 + 通道配置 scripts；通道仅仅是最简单的配置脚本（现在的 oneclick）**。
>
> 判据：**两个产物各自可以单独安装、单独升级、单独卸载、单独排障**；
> 通道作为 host 包内的一个**配置脚本**，不构成第三份产物。

---

## 0. 先说结论：为什么不能简单「拆成三份」，卡在哪

我实测了当前 22 个交付脚本的调用链，**当前形态是「一个 setup.mjs 串起全部」**：

```
setup.mjs (1794 行)
  ├─ BUILD     npm run build
  ├─ HOST      → install-host.mjs (1655)
  ├─ VM        → 经 SSH 调 install-vm.mjs (1104)
  ├─ VM-START  → 经 SSH 起服务
  ├─ TUNNEL    → oh-tunnel
  ├─ TEST / QA-PROBE / HEALTH
  └─ 全部共享同一份 args/env 解析（setup.mjs 内联 1400+ 行辅助函数）
```

**三个真实耦合点**（实测，非推断）：

| # | 问题 | 证据 |
|---|---|---|
| 1 | VM 端安装**无法脱离通道**触发 | `deploy-vm.mjs` 通过 SSH 调 `install-vm.mjs`；`setup.mjs` 把产物推过 SSH |
| 2 | host 端安装**携带并覆盖通道配置** | `install-host.mjs:1393` 调 `writeVmConnConfig`，把私钥路径写进 `vm-conn.json` |
| 3 | host 端安装**替通道打包依赖** | `install-host.mjs:452-511` 把 ssh2 + 传递依赖复制进插件缓存 |

**但有个决定性发现**（决定了重构成本）：

```
delivery/install-vm.mjs 中 ssh2/sshExec/runRemote 出现次数 = 0
delivery/install-host.mjs 中 new Client / .connect( 出现次数 = 0
```

**两个安装脚本本身都不建 SSH 连接。**
VM 端的独立性**已经存在**（它设计上就是在 VM 内本地跑）；host 端也不建连接，只是**替通道做了准备工作**（vendoring + 写配置）。

> **结论**：卡点不是「代码耦合」，而是「**通道的职责错位在 host 安装里**」。
> 重构的本质是「**把通道相关的 3 块从 install-host 里抽成一个独立脚本**」，
> 而不是「造第三份产物」。

---

## 1. 修正：release 包 = 2 端产物 + 1 份通道配置脚本

> **本节是对初稿的修正。** 初稿把通道做成第三个独立产物（`release/channel/`），
> 这是**过度设计**。owner 的澄清更准确：**通道只需要配置脚本，不需要产物**。

### 1.1 为什么通道不该做成产物

通道的全部内容是 **5 个 .mjs、2013 行**（`oh-tunnel` 736 / `tunnel-daemon` 473 /
`ssh2-client` 559 / `ssh2-resolve` 139 / `ssh2-backend` 106），加上 ssh2 vendor。

它**没有独立生命周期**：

| 维度 | 通道 | 对比：host / vm |
|---|---|---|
| 版本号 | 不需要（跟随 host 发版） | 各自需要 |
| 单独升级 | 无意义（没人会为了修隧道单独发版） | 有意义 |
| 单独卸载 | 无意义（卸了隧道两端就断，等于全卸） | 有意义 |
| 配置面 | `host/user/port/key` 4 个值 | 复杂（插件路径 / 服务名 / 策略） |
| 排障入口 | 只需「通/不通」 | 需要详细诊断 |

**且实测：通道相关文件本来就在 `release/host/delivery/` 里**：

```
release/V1.4.37/host/delivery/
  oh-tunnel.mjs  tunnel-daemon.mjs  ssh2-backend.mjs  ssh2-client.mjs  ssh2-resolve.mjs
```

通道是**宿主机侧的东西**（tunnel-daemon 跑在 host，通过 SSH 连 VM 的 127.0.0.1）。
把它拆成独立产物，等于把一个跑在 host 上的进程从 host 包里赶出去，**增加成本不增加价值**。

### 1.2 修正后的产物结构

```
release/<version>/
├── host/                       ← 产物 A：host 端（含通道运行时）
│   ├── MANIFEST.txt
│   ├── deploy-host.sh          ★ 一键入口（已有）
│   ├── delivery/
│   │   ├── install-host.mjs    ← host 安装主体
│   │   ├── oh-tunnel.mjs       ┐
│   │   ├── tunnel-daemon.mjs   │ 通道运行时（宿主侧进程）
│   │   ├── ssh2-*.mjs          ┘
│   │   └── connect-channel.mjs ★ 新增：通道配置脚本（唯一新增件）
│   ├── packages/  node_modules/  skills/
│   └── .env.example            含 VM_HOST / VM_USER / 通道参数
│
├── vm/                         ← 产物 B：VM 端
│   ├── MANIFEST.txt
│   ├── deploy-vm.sh            ★ 一键入口（已有，但从 host 驱动改为 VM 内自跑）
│   ├── delivery/install-vm.mjs
│   ├── packages/  skills/  qa/
│   └── .env.example
│
└── overall/                    ← 组装包 = host ∪ vm + docs + 编排
    ├── deploy-all.sh
    └── ...
```

**通道 = 产物 A 里的 `connect-channel.mjs`（约 150 行）+ `.env` 里的 4 个参数。**

它不是新产物，是 host 包里的一个**配置脚本**——正是 owner 说的「大概就是现在的 oneclick 脚本」。

### 1.3 `connect-channel.mjs` 要做的事（只有 4 步）

```bash
node delivery/connect-channel.mjs --host 172.16.100.2 --user User [--key ~/.ssh/id_ed25519]
```

```
1. 校验/探测私钥            （迁自 install-host.mjs:275-292 的 probeDefaultSshKey）
2. 写 vm-conn.json           （迁自 install-host.mjs:1634 writeVmConnConfig，唯一写入方从此明确）
3. 起/重启 tunnel-daemon     （复用 tunnel-daemon.mjs 现有 CLI）
4. 三段取证                  （ping → 裸 TCP banner → /health，绝不只看 health=200）
```

**就这四步，约 150 行**。当前这些逻辑散在 `install-host.mjs`（`:452-511` vendoring、
`:985-1002` 私钥探测、`:1393` 写 vm-conn、`setup.mjs` 的 TUNNEL 段）里，共约 300 行 + 复杂交织。

**抽取的收益**：`install-host.mjs` 从 1655 行降到约 1350 行，且**不再写通道配置**。

### 1.4 独立性判据（修正后仍然成立）

| 判据 | 命令 | 期望 |
|---|---|---|
| A 可单独装（不含通道） | `cd release/host && ./deploy-host.sh --dry-run` | 完成，输出「下一步：connect-channel」 |
| B 可单独装 | VM 内 `powershell -File install.ps1 -WhatIf` | 完成，不要求 host 已装 |
| 通道可单独配 | `node delivery/connect-channel.mjs --dry-run` | 完成，不要求 A/B 已装 |
| 单独卸载 | `deploy-host.sh --uninstall` / `install.ps1 -Uninstall` | 只删自己，不误删通道配置 |

**关键变化**：通道从「产物」降为「脚本」，所以判据也随之简化——
不再需要「通道单独卸载」（卸隧道 = 断服务，本来就该跟 host 一起卸）。

---

## 2. 逐部分重构方案

### 2.1 产物 A：host WorkBuddy 沙箱端

**从 `install-host.mjs`（1655 行）拆出通道相关的两块，只保留插件本体**：

| 块 | 行数（估） | 去向 |
|---|---|---|
| 插件落位 + 连接器条目渲染 + skill 注入 + 权限 | ~900 | **保留**（A 本体） |
| ssh2 依赖 vendoring（`:452-511`） | ~60 | **迁到 `connect-channel.mjs`**（通道的依赖，不是插件的） |
| SSH 私钥探测 + `vm-conn.json` 写入（`:275-292` / `:985-1002` / `:1393` / `:1634`） | ~80 | **迁到 `connect-channel.mjs`**（通道的配置，不是插件的） |
| 全局 mcp.json 手写（`:1288`） | ~40 | 保留但改为经 Renderer 契约（见 `11` 号文决策 F） |
| 其余（路径解析 / 环境 / 日志 / 校验） | ~575 | 保留 |

**改造后的 host 安装不再知道 vm-conn 的存在**。它只做：

```
1. 读 MANIFEST.txt 校验完整性
2. 解析 WorkBuddy 插件根（鸿蒙沙箱路径 / win32 路径）
3. plan() → PlannedFile[] + plannedGlobalMcpEntries[]
4. 落盘：plugin/ + runtime/ + skills/
5. 渲染连接器条目（4 个 streamableHttp）
   └─ 端口读 vm-conn.json（若存在），否则用默认 18443
6. 打印「下一步：connect-channel」（不自己连）
```

**关键：host 端不再探测私钥、不再写 vm-conn.json**。
它只**读** vm-conn.json 拿端口；不存在就用默认 18443。

> 这个改动消灭了一个长期隐患：当前 host 安装会**覆盖** vm-conn.json 里的私钥路径
> （`:994` 读既有值，`:1002` 决定是否覆盖）。装 host 不该改通道配置。

### 2.2 产物 B：VM 端

**这一块改动最小**，因为 `install-vm.mjs` 已经是独立的（ssh2 出现 0 次）。

要做的只有两件：

```
1. install-vm.mjs 确认走产物路径（已有 --skip-install / --skip-build 双开关）
   - 实测 :404-408 已支持「dist 已分发故无需 npm ci」这条路径
   - 目标：release/vm/deploy-vm.sh 默认带上这两个开关（当前 deploy-vm.sh 已带 --skip-build）
   - 补：--skip-install 也要默认带上（产物已含 node_modules）

2. 新增 install.ps1 作为 VM 原生入口
   - 当前用户需要粘贴一条 PowerShell 命令来跑 node install-vm.mjs
   - 目标：install.ps1 内部自己找 node（PATH → 常见位置 → 报错带下载链接）
```

> **修正初稿**：初稿写「当前在 VM 里跑 npm ci && npm run build，需改造成预编译」——
> 这**低估了现状**。`install-vm.mjs:404-408` 已有 `--skip-install`/`--skip-build` 双路径，
> 其中 `--skip-install` 分支的注释原话就是「dist 已分发故无需 npm ci」。
> 且 `release/vm/deploy-vm.sh` 默认已传 `--apply --skip-build`。
> **所以 VM 端的产物化基本已完成，只差把 `--skip-install` 也设为默认 + 加一个 ps1 壳。**

**产物 B 的独立性证据**（改造后）：

```powershell
# 在 VM 内，不需要 host、不需要通道
PS> .\install.ps1 -Port 18443 -ServiceName WinVMBridge.Service
# → 解压 packages/ + psmod/ 到 C:\WinVMBridge\
# → 写 config\vm-service.config.json（host 恒 127.0.0.1）
# → 注册计划任务（登录即启、崩溃重启、交互式会话）
# → 自检：ps-bridge 模块加载 + 端口绑定
```

### 2.3 通道：host 包内的配置脚本（不是产物）

**通道不独立成产物**（见 §1.1 的五条理由）。它是 `release/host/delivery/connect-channel.mjs`。

**内容来源**（全部从现有 host 安装里抽出，不新写逻辑）：

| 逻辑 | 迁自 |
|---|---|
| 私钥探测 | `install-host.mjs:275-292` `probeDefaultSshKey()` |
| 写 vm-conn.json | `install-host.mjs:1634` `writeVmConnConfig()` |
| ssh2 vendoring | `install-host.mjs:452-511` |
| 起 daemon | `tunnel-daemon.mjs` 现有 CLI |
| 三段取证 | `setup.mjs` 的 TEST/HEALTH 段判据 |

**入口形态**：

```bash
node delivery/connect-channel.mjs --host <ip> --user <u> [--key <path>] [--dry-run]
  → 探测/校验私钥
  → 写 vm-conn.json（这是它唯一的写入权）
  → 起 tunnel-daemon（常驻，PID 文件 ~/.workbuddy/winvm/tunnel.pid）
  → 三段取证：ping → 裸 TCP banner → /health
```

**它的依赖声明必须诚实**：

```bash
$ node delivery/connect-channel.mjs --host 172.16.100.2 --user User --dry-run
  通道计划：
    私钥         : ~/.ssh/id_ed25519（探测命中）
    VM 侧服务    : 172.16.100.2:18443（假定 VM 端已装）
    本地端口     : 18443
    vm-conn.json : ~/.workbuddy/winvm/vm-conn.json（将写入）
    daemon       : 将启动（PID 文件 ~/.workbuddy/winvm/tunnel.pid）
```

「假定 VM 端已装」——**这是诚实的依赖声明，不是隐藏耦合**。
它不会去检查 VM 端是否装了（那需要连上 VM，而它还没连），只在最后取证时发现不通并明确报「VM 端服务未就绪」。

---

## 3. 唯一交接契约：`vm-conn.json`

三部分唯一的共享状态，**必须定义成这样且只有这些字段**：

> ⚠ 注意：当前仓库里这个文件的实际字段是 `host` / `user` / `sshPort` / `servicePort` /
> `identityFile`（见 `install-host.mjs:1634` 的 `writeVmConnConfig`），**没有** `schemaVersion`。
> 下面的 `vmHost`/`vmUser`/`localPort`/`schemaVersion` 是目标形态。
> 改名会破坏现有 `winvm-plugin.mjs` 的读取，**建议保留旧字段名，只新增 `localPort` 与 `schemaVersion`**。

```json
{
  "schemaVersion": 1,
  "host": "172.16.100.2",
  "user": "User",
  "sshPort": 22,
  "servicePort": 18443,
  "localPort": 18443,
  "identityFile": "~/.ssh/id_ed25519"
}
```

**写入权与读取权的严格分配**（这是解耦的核心纪律）：

| 字段 | 唯一写入方 | 读取方 |
|---|---|---|
| `host` / `user` / `sshPort` / `identityFile` | **`connect-channel.mjs`** | `install-host`（渲染连接器 url）、`winvm-plugin.mjs`、通道自己 |
| `servicePort` | `connect-channel.mjs`（从 VM 端 manifest 读出后写入） | 同上 |
| `localPort` | **`connect-channel.mjs`** | `install-host`（渲染 url 端口） |
| `schemaVersion` | `connect-channel.mjs` | 所有读取方（做兼容判据） |

**规则**：
1. **`install-host.mjs` 只读不写**。当前 `:1393` 调 `writeVmConnConfig` 是**错的**——host 安装在改通道配置
2. **VM 端完全不碰它**。VM 在另一台机器，物理上不该知道宿主路径
3. **`connect-channel.mjs` 是唯一 owner**。它是唯一天生知道两端信息的部分

**兼容性**：`schemaVersion` 缺失或不匹配时，读取方必须**告警并降级**（用默认端口 18443），不能崩。
理由：先装 host 后配通道是正常顺序，此时文件不存在。

---

## 4. 与 runtime 层的关系（回应 owner「不要黏合」）

两个产物 + 一份通道脚本解耦后，runtime 层的边界也清晰了：

```
┌────────────────────────────────────────────────┐
│ release/host（产物 A）                          │
│   plugin/  ← 连接器条目 + skill + 审批卡模板     │
│             这些是 runtime 的「配置」，不是代码  │
│   delivery/install-host.mjs   插件落位          │
│   delivery/connect-channel.mjs 通道配置 ← 新增   │
│   delivery/oh-tunnel.mjs 等   通道运行时（宿主进程）│
└────────────────┬───────────────────────────────┘
                 │ TCP 127.0.0.1:18443（tunnel-daemon 建的本地转发）
┌────────────────▼───────────────────────────────┐
│ release/vm（产物 B）                            │
│   config/     ← runtime 配置（provider/端口/策略）│
│   packages/   ← runtime 代码（vm-service）       │
│   psmod/      ← 能力实现（PowerShell）           │
└────────────────────────────────────────────────┘
```

**三条黏合禁令**（写进 review checklist）：

| 禁令 | 检查方法 |
|---|---|
| A 的安装脚本不许连 SSH | `grep -cE "new Client\|\.connect\(" release/host/delivery/install-host.mjs` = 0 |
| 通道脚本不许知道能力/策略/审批 | `grep -rniE "capability\|policy\|approval" release/host/delivery/connect-channel.mjs` = 0 |
| B 不许写宿主路径 | `grep -rn "\.workbuddy\|com.tencent.workbuddy" release/vm/` = 0 |

> **第一条现在已成立**：实测 `install-host.mjs` 里 `new Client` / `.connect(` 出现 **0 次**。
> 但 `connect-channel.mjs` 抽出后必须**保持**这一点——新脚本也不该建 SSH 连接
> （它只写配置 + 起 daemon，daemon 才是建连接的那个）。

---

## 5. 安装顺序：三种都合法，但推荐一种

```
推荐：B → C → A
  ① 先装 VM 端（服务起来，端口就绪）
  ② 再配通道（连上去，取证通过）
  ③ 最后装 host（渲染连接器时端口一定准）

也合法：
  C → B → A    先配通道（会报「VM 未就绪」，属正常）
  A → B → C    host 先装（用默认 18443），配完通道不必重装 host
               ↑ 这就是为什么 localPort 默认必须等于 servicePort

不推荐但允许：
  A 单独装     → 插件在，连接器指向的端口无服务（工具列表空）
  C 单独配     → 隧道通，但 VM 无服务（TCP 能连，HTTP 无响应）
  B 单独装     → 服务在，但只有 127.0.0.1 可达（物理上需要隧道才能从宿主访问）
```

**每种「单独装」都必须有明确的诊断输出**，而不是默默能跑：

```bash
$ cd release/host && ./deploy-host.sh --apply
  ✓ 插件已落位
  ✓ 4 个连接器条目已写入（端口 18443）
  ⚠ 未检测到 vm-conn.json（通道尚未配置）
    → 使用默认端口 18443
    → 下一步：node delivery/connect-channel.mjs --host <ip> --user <u>
```

这就是「完全独立」的正确体验：**装完立刻知道还缺什么，且能自己去配**。

---

## 6. 两部分的验收矩阵

每一部分独立验收，不依赖其他部分：

| 部分 | 单元验收（不需要别的东西） | 集成验收（需要全装） |
|---|---|---|
| **A host** | `deploy-host.sh --dry-run` 输出完整计划<br>`--apply` 后插件目录与 MANIFEST.txt 一致<br>`--uninstall` 后目录干净 | WorkBuddy 里能看到 4 个连接器 + 10 个 skill |
| **B vm** | `install.ps1 -WhatIf` 输出计划<br>`install.ps1` 后计划任务存在且 Running<br>VM 内 `curl 127.0.0.1:18443/health` = 200 | 探针 34（→112）全通 |
| **通道** | `connect-channel.mjs --dry-run` 输出计划<br>配完后 daemon 有 PID 且存活<br>**裸 TCP banner 探测通** | 从宿主 `curl 127.0.0.1:18443/health` 通，且 **MCP initialize 握手成功**（不只是 TCP 通） |

> **通道的验收必须三段取证**（这是历史踩过的坑）：
> `health=200` 是长连口径，可能来自缓存/旧连接。必须
> ① `ping` 通 → ② 裸 TCP banner 通 → ③ 完整 MCP initialize 握手成功。
> **顺序不能颠倒**，因为后一段成功会掩盖前一段的失败。

---

## 7. 与 `11-ARCHITECTURE-VNEXT.md` 的工序合并

两篇文档的工序有重叠，合并后的真实执行顺序：

```
阶段 1  删除（3d）     ssh-tunnel 死代码 / SkillDomain / hermes
阶段 2  统一（5d）     112 项能力表 + surface
阶段 3  闸门（4d）     gateway.ts 三个入口统一
阶段 4  降级（4d）     llm: provider → planner
─────── 以上是 runtime 层，以下是部署层 ───────
阶段 5  解耦（3d）     ★ 本文核心
        5a  抽 connect-channel.mjs（1d）
            └─ 迁出私钥探测 + vm-conn 写入 + ssh2 vendoring
            └─ install-host.mjs 1655 → ~1350，且不再写通道配置
        5b  install.ps1 壳 + skip-install 默认化（1d）
            └─ 注：--skip-install/--skip-build 已存在，只需默认化 + 加 ps1
        5c  MANIFEST 补充 + 两产物边界断言（1d）
阶段 6  验收（2d）     两部分独立装 + 三顺序 + 单独卸
```

**总工期从 19-20d 增至 22-23d**。增量 3d 全在阶段 5-6。

> **比初稿少 2d**：因为通道不独立成产物，省掉了造 manifest + 造第三份 install.mjs 的工作。
> 这也是「不过度设计」的直接体现。

**进一步压缩**：若工期紧，阶段 5 只做 **5a**（1d）。
它是唯一有实质价值的解耦动作——**让 host 安装不再写通道配置**，消灭当前最严重的错位。

---

## 8. 本方案明确不做

| 不做 | 理由 |
|---|---|
| **把通道做成第三个独立产物** | 通道没有独立生命周期（不单独发版、不单独升级、不单独卸载）。它跑在 host 上，就该在 host 包里。初稿曾设计 `release/channel/`，**已自我否决** |
| 三个独立 npm 包 / 三个 git 仓库 | 产物独立 ≠ 仓库独立。同仓多产物能共享 `contracts` 类型，拆仓引入版本同步噩梦 |
| 通道做成 Windows 服务 / systemd unit | 鸿蒙宿主没有 systemd；daemon 模式（PID 文件 + 自拉起）已验证可行 |
| VM 端做成 MSI 安装包 | 需要 WiX + 签名证书，收益不抵成本。`install.ps1` + 计划任务已够 |
| host 端做成 WorkBuddy 官方插件格式 | 需跟随官方规范演进，当前 `deployWinvmPlugin` 的落位方式已稳定 |
| 两部分之间做版本协商协议 | `MANIFEST.txt` + 安装期检查即可，运行时不协商 |
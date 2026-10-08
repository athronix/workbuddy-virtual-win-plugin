# 安全与监管设计（SECURITY-GOVERNANCE）

| 项 | 值 |
|---|---|
| 文档 ID | SECURITY-GOVERNANCE-v1 |
| 版本 | v1.0 |
| 对应用户要求 | **"最可监管"** + 评估建议 §5 风险缓解 |
| 日期 | 2026-08-28 |

---

## 1. 威胁认知（首要前提）

> **本系统本质上是在 Windows 虚拟机上开放了一条高权限执行通道（等同 RCE）。**
> 所有设计必须以"凭据泄露 / 宿主被诱导 / Agent 误判"为前提假设，而非以"一切正常"为前提。

### 1.1 威胁模型（STRIDE 摘要）

| 威胁 | 场景 | 缓解措施 |
|---|---|---|
| **S**poofing 伪装 |  attacker 冒充宿主连 VM 服务 | SSH 密钥鉴权（默认）；HTTP 模式 bearer token + 可选 mTLS；**VM 仅监听 127.0.0.1** |
| **T**ampering 篡改 | 篡改审计日志掩盖操作 | **哈希链审计**（§4），任一改动即校验失败 |
| **R**epudiation 抵赖 | 否认执行过某操作 | 全程 traceId + 签名审计 + before/after 快照 |
| **I**nfo disclosure 泄露 | 凭据/文件内容外泄 | 无明文凭据落盘；凭据走 SSH key / `${VAR}` 占位 / 宿主加密 header |
| **D**oS 拒绝服务 | 长任务/批量操作拖垮 VM | 请求超时、并发上限、任务取消（`tasks/cancel`）、ps-bridge 心跳重启 |
| **E**oP 权限提升 | 借通道执行未授权高危操作 | **拒绝优先白名单** + L2/L3 审批闸 + 宿主侧 `disabledTools` 静态禁用 |

---

## 2. 纵深防御分层

```
┌─ 第 0 层：网络隔离 ────────────────────────────────────────┐
│  VM 服务仅绑定 127.0.0.1；SSH 隧道本地端口转发；           │
│  VM 对外零监听端口；严禁公网暴露模板                        │
└──────────────────────┬────────────────────────────────────┘
┌─ 第 1 层：传输与鉴权 ──────────────────────────────────────┐
│  SSH 密钥（默认）｜HTTPS + bearer + Origin 校验（HTTP 模式）│
└──────────────────────┬────────────────────────────────────┘
┌─ 第 2 层：宿主侧静态风控（NFR-508）──────────────────────┐
│  WorkBuddy 原生 disabledTools：L2/L3 工具默认静态禁用      │
└──────────────────────┬────────────────────────────────────┘
┌─ 第 3 层：能力面收敛 ──────────────────────────────────────┐
│  declareCapabilities() ∩ 平台可用能力；未声明 = 不存在      │
└──────────────────────┬────────────────────────────────────┘
┌─ 第 4 层：策略引擎（NFR-505）────────────────────────────┐
│  拒绝优先：命令/路径/进程白名单 + 黑名单；L0-L3 风险分级    │
└──────────────────────┬────────────────────────────────────┘
┌─ 第 5 层：审批闸（NFR-506）──────────────────────────────┐
│  L2/L3 强制人工确认；A2A → input-required；MCP → 待确认    │
└──────────────────────┬────────────────────────────────────┘
┌─ 第 6 层：执行最小权限 ────────────────────────────────────┐
│  委派携带 allowedCapabilities + maxRisk；删除优先回收站     │
└──────────────────────┬────────────────────────────────────┘
┌─ 第 7 层：审计与回溯（NFR-507/509）──────────────────────┐
│  哈希链 append-only；traceId 全链路；before/after 快照      │
└───────────────────────────────────────────────────────────┘
```

---

## 3. 策略引擎（`packages/core/policy`）

### 3.1 判定顺序（**黑名单优先级最高**）

```
1. 能力未注册？            → POLICY_DENIED
2. 命中 pathDenylist？     → POLICY_DENIED（立即，不再往下）
3. 命中 commandDenylist？  → POLICY_DENIED（立即）
4. 未命中白名单？          → POLICY_DENIED（拒绝优先）
5. 风险 ≥ L2 且未审批？     → APPROVAL_REQUIRED
6. 会话要求不满足？         → SESSION_UNAVAILABLE
7. 超出本次 maxRisk？       → POLICY_DENIED
8. 通过 → 执行
```

### 3.2 默认策略基线（`policy.default.json`）

| 项 | 默认值 |
|---|---|
| 路径黑名单（**最高优先级**） | `C:\Windows\**`、`C:\Program Files\**`、`C:\Program Files (x86)\**`、`C:\ProgramData\**`、`C:\System Volume Information\**`、`C:\Boot*`、`C:\Recovery\**`、`\\?\**` |
| 路径白名单 | `C:\Users\<vmuser>\**`、`C:\Temp\**`、`C:\Users\Public\**`、`D:\Data\**`（可配） |
| 命令黑名单 | `format`、`diskpart`、`bcdedit`、`cipher /w`、`del /s /q C:\`、`reg delete HKLM\SYSTEM`、`net user * /add`、`takeown`、`icacls * /grant *:(F)`、`powershell -enc`、Base64 混淆执行 |
| 进程黑名单 | `lsass`、`csrss`、`winlogon`、`services`、`smss`、`wininit`、`ntoskrnl` |
| 注册表可写根键白名单 | `HKCU:\**` 为主；`HKLM:\SOFTWARE\**` 需 L2 审批；**禁止** `HKLM:\SYSTEM\**`、`HKLM:\SAM\**`、`HKLM:\SECURITY\**` |
| 默认 `maxRisk`（委派） | `L1` |
| 删除默认行为 | 进回收站（除非显式 `--permanent` + 已审批） |
| L2/L3 是否强制快照 | 是（before/after） |

### 3.3 审批闸

| 通道 | 形态 |
|---|---|
| MCP | 返回 `APPROVAL_REQUIRED` + `approvalId` + dry-run 预览；宿主确认后带 `approvalId` 重发 |
| A2A | Task 置 `input-required`，`status.message` 附预览与结构化影响清单；宿主 `message/send` 带同 `taskId` 继续 |

审批记录包含：审批者、时间、预览内容哈希、审批结果（**批准 / 拒绝 / 超时 / 取消** 四态，不得折叠为「未批准」）。

预览内容哈希（`previewHash`）**V1 由宿主侧计算并记录**，落点 `packages/host-a2a-bridge/src/approval-audit.ts`，算法为 `sha256(canonicalJson({ capabilityId, risk, preview, impact }))`；用于比对「当时给用户看的」与「实际执行的」（哈希不一致即标记，不静默通过）。凭据类字段（`password` / `privateKey` / `passphrase` / token / secret）**永不入账**。

### 3.4 关键红线

- ❌ **任何情况下不得提供绕过审批闸的配置开关**（`PolicyConfig` 中不存在、也不得新增「跳过审批」类字段）
- ❌ 不得因"用户说快点"而跳过 dry-run 或审批

#### 3.4.1 `dry-run` 免审批：服务端能力声明制（A1）

审批闸上**唯一**存在的免批通道，是一条**由服务端声明位授权、且必须留链上证据**的窄口子，
不是「调用方自报参数即可放行」的后门。约束（缺一不可，`engine.ts` 与单测逐条钉死）：

| # | 约束 | 落点 |
|---|---|---|
| 1 | 免批判定为**双条件**：调用方传 `params.dryRun === true`（意图）**且** 注册表内该能力声明 `supportsDryRun === true`（服务端事实）。条件之间是 `&&`，**没有任何一条单独成立即可放行** | `packages/core/src/policy/engine.ts` 审批闸 + `CapabilityDefinition.supportsDryRun` |
| 2 | 声明位是**显式白名单式标注**：默认（字段缺席）= **不支持**。新能力不会因为「`input` schema 里写了 `dryRun`」而自动获得免批通道 —— schema 有该键只说明实现接得住开关，**不等于**开关为真时零系统变更 | `packages/contracts/src/capability.ts` + `packages/vm-capabilities/src/registry/definitions.ts` |
| 3 | **fail-closed**：严格等值 `=== true`；`undefined` / `false` / 引擎未注入注册表（无从核实）一律回落 `approval-required`（`requiresApproval:true`，审批流程照旧） | 同上 + `tests/unit/p0-path-traversal.test.js` |
| 4 | 免批执行**必须**在审计链上留下 `ext.bypass='dry-run'` 取证位，判据取服务端裁决 `PolicyVerdict.matchedRule`（= 哨兵常量 `allow:dry-run-bypass`），**绝不回看调用方参数**。运维据此 grep 即可拉出全部免批执行清单 | `packages/vm-service/src/delegation-audit.ts` 的 `bypassTagSink` + `AuditExt.bypass` |
| 5 | 免批**只**豁免审批闸，**不**豁免路径/命令/进程/注册表任何一条黑白名单（旁路位置在全部校验之后） | `engine.ts` 判定顺序 + 同上单测 |
| 6 | 登记在案的声明能力以注册表为唯一事实源（当前为 `system.power.control`、`app.winget.install`、`app.winget.uninstall`、`app.winget.upgrade`、`storage.file.delete`）；**新增一条标注 = 新增一条免审批通道**，必须有 psmod 侧「`$DryRun` 为真即早返回、零副作用」的代码级证据，并由单测「声明位集合钉死」用例显形 | `definitions.ts` 标注注释（逐条附 psmod 行号） |

> 本条是对体检 U-P0-3（原报 P0、取证后降 P1 高，架构审计 ARCH-02）的裁决落地：
> 旧实现**只**判 `req.params['dryRun'] === true` 即放行 L2/L3，与本节第 1 条红线**文本直接冲突**且无裁决依据。
> 若某天决定彻底删除该通道，应同时删除 `supportsDryRun` 声明位与本小节，并把第 1 条红线恢复为绝对表述。
- ✅ 审批超时默认**拒绝**（fail-closed）。**成立方式**：未获批准一律**不执行**（MCP 侧未携带有效 `approvalId` 的 L2/L3 请求永远返回 `APPROVAL_REQUIRED`；A2A 侧任务在 VM 侧持续挂起）。**注意**：V1 **未实现**审批记录的显式 TTL 回收 / 过期作废，本项为后续变更。
- ✅ provider 异常时服务降级为仅 `meta.*`，**绝不降级为无限制执行**

---

## 4. 审计（`packages/core/audit`）

### 4.1 存储

| 项 | 值 |
|---|---|
| 位置（VM） | `%LOCALAPPDATA%\WinVMBridge\audit\audit-<yyyyMMdd>.jsonl` |
| 格式 | 每行一条 JSON（NDJSON），append-only |
| 轮转 | 按天；单文件 ≥ 64MB 切分 |
| 权限 | 仅服务运行用户可写（ACL 收紧） |

### 4.2 记录结构

```jsonc
{
  "seq": 128,
  "ts": "2026-08-28T12:15:00.123Z",
  "traceId": "tr_01J...",
  "auditId": "aud_01J...",
  "principal": { "host": "workbuddy", "user": "<vmuser>", "channel": "mcp" },
  "capabilityId": "storage.file.delete",
  "risk": "L2",
  "params": { /* 脱敏后的参数，敏感值打码 */ },
  "policyDecision": { "allowed": true, "matchedRule": "pathAllowlist:C:\\Users\\*" },
  "approval": { "approvalId": "apr_01J...", "approvedBy": "human", "approvedAt": "..." },
  "result": { "ok": true, "affected": 12, "bytesFreed": 10485760 },
  "artifacts": ["sha256:ab12...", "sha256:cd34..."],   // 快照哈希
  "durationMs": 2331,
  "prevHash": "sha256:9f2a...",
  "hash": "sha256:7c1e..."      // = SHA256(canonicalJson(this without hash))
}
```

### 4.3 哈希链（防篡改，NFR-507）

```
hash_n = SHA256( canonicalJson(record_n 去掉 hash 字段) )
record_n.prevHash = hash_(n-1)
```

- 创世记录 `prevHash = "GENESIS"`；
- 校验：`verifyChain()` 逐条重算，任一不符立即失败并报告断裂位置；
- 定期（每日 + 每次服务启动）自动校验，结果写入 `meta.health.check` 的 `audit.chainValid`。

### 4.4 脱敏规则

| 字段模式 | 处理 |
|---|---|
| `*password*`、`*secret*`、`*token*`、`*key*` | 替换为 `***REDACTED***` |
| Base64 长串（>200 字符） | 截断 + 记长度 + 记 sha256 前缀 |
| 截图 artifact | 只存 sha256 + 路径，不内联进审计行 |

---

## 5. Windows 会话保活（NFR-502，评估建议 §二）

### 5.1 铁律

> 承载 GUI 的服务进程**必须运行在交互式用户会话**（`WinSta0\Default`，Session ≥ 1），
> **禁止**注册为 Windows 服务（Session 0 必然黑屏，`SendInput` 报 `Access denied`）。

### 5.2 启动形态（三选一，推荐组合）

| 形态 | 说明 |
|---|---|
| **登录自启**（推荐） | `HKCU\...\Run` 或 `shell:startup` 快捷方式 |
| 计划任务「仅在用户登录时运行」 | `schtasks /create /sc onlogon`（**不得**用 `/ru SYSTEM`） |
| 托盘常驻 | 附带 GUI，便于人工观察与手动启停 |

### 5.3 会话健康探针（每 15s）

| 检查项 | 方法 | 失败判定 |
|---|---|---|
| SessionId ≥ 1 | `[System.Diagnostics.Process]::GetCurrentProcess().SessionId` | = 0 → `unavailable` |
| 窗口站/桌面 | `GetProcessWindowStation` / `GetThreadDesktop` | 非 `WinSta0\Default` → `degraded` |
| 未锁屏 | 检测 `LogonUI.exe` 是否在前台 | 锁屏 → `degraded`（提示先解锁） |
| **屏幕非黑屏** | 截图后算像素方差；方差 ≈ 0 → 黑屏 | 黑屏 → `blackScreen` |
| Explorer 存活 | `Get-Process explorer` | 无 → `degraded` |

### 5.4 恢复动作

| 场景 | 动作 |
|---|---|
| RDP 断开导致挂起 | `tscon <sessionId> /dest:console`（需管理员） |
| 重启后无人登录 | 自动登录（Sysinternals Autologon 风格配置，**凭据由 VM 侧安全存储，不落明文**） |
| 锁屏/休眠 | 调整电源与屏幕保护策略（禁休眠、禁锁屏超时） |
| 无法恢复 | 服务置 `degraded`，GUI 能力返回 `SESSION_UNAVAILABLE`，**明确报错而非静默黑图** |

### 5.5 降级语义（重要）

| 会话状态 | 可用能力 |
|---|---|
| `healthy` | 全部（含 GUI） |
| `degraded` | L0/L1 非 GUI 能力（GUI 明确报错） |
| `unavailable` / `blackScreen` | 仅 `meta.*` + 无 GUI 依赖的 L0/L1（GUI 明确报错） |

---

## 6. 凭据管理

| 凭据 | 处理 |
|---|---|
| SSH 私钥 | 宿主侧 `~/.ssh/`；**不进插件包、不进仓库** |
| Bearer token（非回环直连） | 环境变量 `WINVM_BEARER_TOKEN`，由宿主注入；**不落明文配置** |
| WorkBuddy header 覆盖 | 走宿主 `connector-states.v3.json` 的 AEAD 加密机制（实测 `aes-256-gcm` + `hkdf-sha256`） |
| VM 自动登录凭据 | 用 Windows DPAPI / 凭据管理器；**禁止**明文写注册表 |

### 6.1 认证是两件事，别混为一谈（双层模型）

| 层 | 认证对象 | 机制 | 何时需要 |
|----|----------|------|----------|
| **SSH 层** | 宿主 ↔ 被控端 Windows（scp 推包 / `ssh -L` 开隧道） | **SSH 公钥**（默认）；密码不可行 | 始终（部署 + 隧道） |
| **Bearer 层** | 宿主 connector ↔ `vm-service`（MCP/A2A 协议） | `WINVM_BEARER_TOKEN` | **仅非回环直连**；走回环隧道时免校验 |

> 默认部署走 `ssh -L … 127.0.0.1:18443`，隧道两端都是回环地址，Bearer 层**免校验**；`vm-service.config.json` 仅当 `bind ≠ 127.0.0.1` 才强制 `tokenEnv: WINVM_BEARER_TOKEN`。所以绝大多数场景你**只需要配好 SSH 密钥**，无需碰 bearer token。

### 6.2 SSH 认证：只用密钥，不用密码

`setup.mjs` / `install-vm.mjs` / `install-host.mjs` 内部的 `ssh` / `scp` / `ssh -L` 都是**直接调用系统 `ssh`**，脚本本身**不接收、不传递任何密码**——`.env` 里只有 `VM_HOST` / `VM_USER` / `VM_SSH_PORT`，**没有密码字段**。因此认证完全交给操作系统 SSH：

- ✅ **密钥（推荐，可无人值守）**：`ssh-keygen -t ed25519` 生成，把 `~/.ssh/id_ed25519.pub` 追加进远端 `%USERPROFILE%\.ssh\authorized_keys`，并修 ACL（仅本人可读，否则 OpenSSH 会无视该文件）。若默认密钥非 `id_ed25519`，须在宿主 `~/.ssh/config` 按 `VM_HOST` 配 `IdentityFile`。
- ❌ **密码（不建议）**：Windows 自带 `ssh`/`scp` 交互式读密码，脚本不传密码、`.env` 无密码字段；原生 Windows 不随附 `sshpass`（脚本调用 `ssh`/`scp` 而非 PuTTY `plink`），`setup.mjs --apply` 这类一次性多步 SSH 流程会卡在交互要密码。密码只适合本人终端偶尔手动连一下。

### 6.3 远程 Windows（非本地 VM）同样适用

被控端是不是真·虚拟机不影响架构——`vm-service` 只要跑在一台 Windows 上、经隧道在 `127.0.0.1:18443` 可达即可。把 `VM_HOST` 指向远程 Windows（物理机 / 云主机 / 内网机器），本地当宿主、远程当"VM"，即"本地操作远程 Windows"。唯一额外前置：远程 Windows 需 **OpenSSH Server 监听 22 且宿主可路由**（完整步骤见 `DEPLOYMENT.md §7`）。其余认证、隧道、能力边界与本地 VM 完全一致。

---

## 7. 安全默认值汇总（Secure by Default）

| 项 | 默认 |
|---|---|
| 传输 | SSH 隧道（VM 仅回环监听） |
| 策略 | **拒绝优先** |
| L2/L3 | 强制审批 + before/after 快照 |
| L3 分区/格式化 | **不注册为可用能力** |
| 删除 | 进回收站 |
| 委派 `maxRisk` | L1 |
| 审批超时 | 拒绝（fail-closed） |
| 公网暴露 | 无此配置模板；检测到非回环绑定即告警 |
| 审计 | 全量开启 + 哈希链 |
| provider 异常 | 降级为仅 `meta.*` |

---

## 8. 与评估建议 §5 风险清单的对应

| 评估建议风险 | 本设计缓解 | 落点 |
|---|---|---|
| 等于给 VM 开 RCE | 七层纵深防御（§2） | 全局 |
| GUI 黑屏/失效 | 会话探针 + tscon + 自动登录 + 降级语义（§5） | `core/session`、`vm-capabilities` |
| 委派"黑盒" | 强制 artifact（steps/screenshots/change-list）+ traceId（§IF-2.6） | `a2a-framework`、`vm-service` |
| 资源占用 | V1 用确定性执行器（无 LLM 开销）；并发上限；任务可取消 | `adapter-agent-workbuddy`、`core` |

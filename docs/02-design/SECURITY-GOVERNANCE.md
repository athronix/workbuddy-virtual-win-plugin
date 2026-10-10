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
| **T**ampering 篡改 | 篡改审计日志掩盖操作 | **哈希链审计**（§4）——**本轮运行期内**任一改动即校验失败；跨轮历史由启动归档校验条目提供证据（范围限定语见 §4.3.1，残留风险见 §6.4 权衡一） |
| **R**epudiation 抵赖 | 否认执行过某操作 | 全程 traceId + 签名审计 + before/after 快照 |
| **I**nfo disclosure 泄露 | 凭据/文件内容外泄 | 无明文凭据落盘；凭据走 SSH key / `${VAR}` 占位 / 宿主加密 header |
| **D**oS 拒绝服务 | 长任务/批量操作拖垮 VM | 请求超时、并发上限、任务取消（`tasks/cancel`，**Phase 1 起为协作式真取消**，见 §2.2）、ps-bridge 心跳重启 |
| **E**oP 权限提升 | 借通道执行未授权高危操作 | **拒绝优先白名单**（路径/进程/注册表；命令面**只有黑名单**，ARCH-18）+ L2/L3 审批闸 + 宿主侧 `disabledTools` 静态禁用 |

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

### 2.1 信任边界声明（**必读**，ARCH-07 裁决结果）

> **本系统的信任边界 = 「回环绑定 + SSH 隧道 + 审批闸」，服务端不承担身份鉴权。**

这不是实现缺口，而是 Phase 1 的**明确设计选择**（裁决全文见 `docs/changes/phase1-arch-design.md` §2.2）。三点含义：

1. **谁能连上 `vm-service`，等价于谁能在那台 Windows 上发起本地回环连接。** VM 内任意本地进程（含被诱导的桌面应用、低权限账户）都能裸调 MCP/A2A 端点 —— 此时**唯一的拦阻是策略引擎与审批闸（第 4/5 层）**，不存在"凭据不对就连不上"这第三道。所以第 2/4/5 层的任何放宽都必须按"暴露给本机所有进程"来评估。
2. **回环约束不可关**：非回环绑定（如 `0.0.0.0`）一律判 **error** 且启动被拒，`security.requireLoopbackBind=false` **自 Phase 1 起不再能放宽该约束**（只额外产生一条 warning）。理由：一旦允许配置漂移成"对外裸 HTTP"，第 0 层（网络隔离）整体消失，其风险远大于"少一层 bearer 校验"的收益。运维若确需跨机访问，唯一受支持形态是在宿主侧用 `ssh -L` 把远端端口映射到本机回环（见 §6.1、`DEPLOYMENT.md §7`）。
3. **bearer 是可选加固，不是默认事实**：`security.enforceBearer` 默认 `false`。开启需**双条件**（`enforceBearer===true` **且** `tokenEnv` 指向的 env 有值）守卫才真正挂载；缺任一条件即逐字旧行为，且该降级由 `/health.security.authMode` 显形为三态而非静默：

   `authMode` 由 `resolveAuthMode()`（`http-guard.ts`，与 `resolveBearerToken()` 同源）按**四步判序**产出，三种取值各自的成立条件如下：

   | `authMode` | 含义 | 判序 |
   |---|---|---|
   | `bearer-enforced` | 守卫在位，非豁免端点要求正确 token | ① `resolveBearerToken()` 返回**非空** —— 即 `enforceBearer===true` **且** `tokenEnv` 有指向名 **且** 该 env 有值（双/三条件全成立） |
   | `bearer-configured-missing` | **两种"想开而没开成"的降级态**，必须显形、拒绝静默 | ② `enforceBearer===true` 但 token 解析为空（配了开关却没配到值，含 `tokenEnv` 根本没给名）；**或** ③ `enforceBearer` 缺席/false，但 `tokenEnv` **给了变量名而该 env 无值** —— **现网 `vm-service.config.json` 正落这一支**（它写了 `"tokenEnv": "WINVM_BEARER_TOKEN"` 却没写 `enforceBearer`，且服务进程环境未设该变量，故真机 `/health` 报此值） |
   | `loopback-only` | 守卫停用，纯回环 | ④ 以上皆非 —— 未配 `enforceBearer` **且**（未配 `tokenEnv` 名，**或** 配了名且 env 有值）。即"干净的回环默认态" |

   > ⚠ 别把"默认部署"简单等同于 `loopback-only`：**只要配置文件写了 `tokenEnv` 名而运行环境没有对应值，就会落 `bearer-configured-missing`**（判序③，与 `enforceBearer` 是否 true 无关）。这是刻意设计——"配了变量名却拿不到值"和"想开守卫开不起来"同样属于**必须显形的半开态**，不能静默归入"正常回环"，否则运维会误以为一切就位。现网要得到 `loopback-only`，要么删掉配置里的 `tokenEnv` 键，要么让服务环境真正设上该变量。

   `authMode` 与守卫生效判据**同源**（同一 `resolveBearerToken()`），杜绝"health 说已强制、守卫其实停用"的自相矛盾。

> ⚠ **开 `enforceBearer` 前必须先补齐 VM 内回连凭据通路（尚未实现）**
> `vm-service` 会经 `buildMcpConfig()`（`packages/adapter-agent-workbuddy-llm/src/bridge.ts`）向 VM 内的 agent CLI 下发 `mcpServers` 条目（回连本服务的 `/mcp?dtid=…`），该条目**不含任何凭据**。因此一旦在真机误开 `enforceBearer`（双条件齐），危害**分两段、形态不同**（2026-10-10 B3 真机演练实测订正，原"委派主链路当场 401"表述只写对了宿主段）：
> - **宿主→服务段**：宿主请求不带凭据 ⇒ **HTTP 层当场 401**（`{"error":"unauthorized","code":"AUTH_REQUIRED"}`，fail-loud，传输层直接可见，宿主侧 `--token-env` 即覆盖此段）。
> - **VM 内回连段**：401 打在**工具面**（CLI 回连 `/mcp` 与 `/.well-known/oauth-protected-resource/mcp` 全被拒 ⇒ 无工具可列可调用），LLM 会话**不因此失败**，而是"口头收尾"⇒ 委派退化为**零副作用的虚假完成**：A2A 终态 `completed`、artifacts 仅 `execution-steps` 载体（零能力产物）、链上 `ext.zeroInnerCalls:true / underlying:[] / blockedCount:0`、summary 标注「零工具调用；完成声称不予采信」。**真正兜住的是 CL-K3R 真值层的不采信判定，不是链路失败**——这比"当场失败"更隐蔽，切勿因任务"成功"而认为守卫没生效。演练证据：`$HOME/wbtmp/b3/b3-probes.json` / `b3-delegate.json`（链 `audit-20261009-6.jsonl`，traceId `tr_b3_mv1djyru`）；拒绝只进 `logger.warn` 不入审计链。
> 这是 §10 R4 的残留风险，属**中**级，不是理论风险；`zeroInnerCalls` 判据因此**不可移除**。上线前置条件（含"bearer 生效自检"：开守卫后应主动探测一次 VM 内回连并拒绝静默退化，已列 Phase 2）与客户端侧通路现状见 §6.1 与 `DEPLOYMENT.md`。

### 2.2 取消的真实语义（ARCH-22）

`tasks/cancel` 是**协作式**取消，不是抢占式终止：信号在每一个"能力调用边界"被消费，正在执行的那一次调用会跑完。因此：

- 取消**成立**意味着「取消点之后的操作绝不发起」，**不**意味着「虚拟机未发生任何变更」。宿主呈现面据此事实化（两态文案 + `executedBeforeCancel`，见 `HOST-A2A-BRIDGE.md`），任何"未执行任何变更"式承诺都是不实陈述。
- 常驻 LLM 会话被打断时会**终结其 CLI 子进程**（只 resolve promise 而留 CLI 活着 ⇒ VM 内 agent 会继续自行发起工具调用，取消成假动作）。
- 证据面：取消终态以 `terminalState:'canceled'` + `errorCode:'TASK_CANCELED'` 入链（可审计、可与 failed/rejected 区分）。

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

### 3.2 默认策略基线（**与代码逐字一致**）

> 事实源是 `packages/core/src/policy/defaults.ts` 的 `DEFAULT_POLICY`（本节下表**逐条照抄**代码写法与顺序，不是"设计意图"）。二者不符时以代码为准并立即回改本节。
> 运维追加走 `mergePolicy()`：数组做**并集** ⇒ **只能加不能减**，因此收紧后的默认值一经合入即永久生效，任何部署都无法靠"少配一条"把它删掉。

| 项 | 默认值（照抄 `DEFAULT_POLICY`） |
|---|---|
| 路径黑名单（**最高优先级**） | `C:\Windows\**`、`C:\Program Files\**`、`C:\Program Files (x86)\**`、`C:\ProgramData\**`、`C:\System Volume Information\**`、`C:\Recovery\**`、`C:\Boot*`、`C:\bootmgr*`、`C:\hiberfil*`、`C:\pagefile*`、`C:\swapfile*`、`\\?\**`、`\\*` |
| 路径白名单（**与 `packages/core/src/policy/defaults.ts` 逐字对齐**） | `%USERPROFILE%\**`、`C:\Users\Public\**`、`C:\Temp\**`、`C:\tmp\**`、`D:\Data\**`、`C:\WinVMWorkspace\**` |
| 命令黑名单 | `\bformat\b`、`\bdiskpart\b`、`\bbcdedit\b`、`\bdel\s+/s\s+/q`、`\brm\s+-rf\s+/`、`\bcipher\s+/w`、`\breg\s+delete\s+HKLM\SYSTEM`、`\bnet\s+user\b.*\/add`、`\bnet\s+localgroup\b.*\/add`、`\btakeown\b`、`\bicacls\b.*\bgrant\b.*:\(F\)`、`\-enc(odedcommand)?\b`、`\-e\s+[A-Za-z0-9+/]{100,}={0,2}`、`FromBase64String`、`Invoke-Expression`、`\biex\b` |
| 进程黑名单 | `lsass`、`csrss`、`winlogon`、`services`、`smss`、`wininit`、`ntoskrnl`、`system`、`winvm-service` |
| 注册表可写根键白名单 | `HKCU:\**`、`HKEY_CURRENT_USER\**`、`HKLM:\SOFTWARE\**`（写入仍受 L2 审批闸拦）、`HKEY_LOCAL_MACHINE\SOFTWARE\**`；**禁止** `HKLM:\SYSTEM\**`、`HKLM:\SAM\**`、`HKLM:\SECURITY\**` |
| 注册表可读根键白名单 | 与写表**同四条**（两表必须成对存在，见下方第 4 条） |
| 默认 `maxRisk`（委派） | `L1` |
| 删除默认行为 | 进回收站（除非显式 `--permanent` + 已审批） |
| L2/L3 是否强制快照 | **信息性声明，运行期不产快照**（Phase 2 · P2-T3，用户裁决 Q2 2026-10-10：降级为信息性，**不实现** before/after）。声明位**在场且必填**，参与**交付面**形状校验 —— `capability.schema.json` 的 allOf 条件约束「risk ∈ {L2,L3} ⇒ `audit.snapshot ≠ 'none'`」由 `schema-check.ts` 的 `validateCapabilityShape` 消费（P2-T1 裁决 Q1=(b)：只在测试/门禁面，运行期不校验能力定义）。**运行面零消费**（core / vm-service / adapter-* / delivery / psmod 无读取点），**承载面亦无字段**（`contracts/src/audit.ts` 的 `AuditRecord`/`AuditExt` 没有落快照的位置）⇒ 高危操作的事后证据仍只有哈希链 + `artifacts` 哈希，**本行不再构成快照防线承诺**；事实三元组由 `tests/unit/phase2-snapshot-truth.test.js` 钉死，出处见 `docs/audit/2026-10-08-architecture-audit.md` ARCH-04 勘误指针 |

**五条必须知道的口径**：

1. **路径白名单里没有 `C:\Users\**`**。旧写法覆盖全体账户，而 `storage.file.read` 是 **L0 免审批** ⇒ 跨账户桌面/下载在策略层被直接放行，与本节历史承诺的 `C:\Users\<vmuser>\**` 不符。ARCH-17 已收紧为 `%USERPROFILE%\**`；**跨账户访问恒 DENY**（`matchedRule:'pathAllowlist:miss'`），确有需要由运维显式追加。
2. **占位符在模式侧运行时展开**（`engine.ts` 的 `expandPolicyPathPattern`，先展开后归一，与 config 层 audit/log/outputDir 共用同一份 `expandEnvPath`）。env 缺席时占位符**保持字面原样** ⇒ 该条目永不匹配 ⇒ 绝对路径一律 DENY —— 方向是 fail-closed：非 Windows/离线环境只会更严，不会误放。附带修复：`appops.cli.invoke` 的 `outputDir: %USERPROFILE%\...` 此前因模式未展开而**恒不匹配**。
3. **命令面只有黑名单**（ARCH-18）。`commandAllowlist` 已从契约 `CapabilityPolicy`、`PolicyConfig`、`capability.schema.json` 三处同批删除（它从未被引擎读取，唯一写入点亦已移除）。⚠ **`capability.schema.json` 的 `policy.additionalProperties === false` ⇒ 旧配置若仍写 `commandAllowlist` 会被 schema 直接拒绝（不是静默忽略）**——**拒止兑现面（Phase 2 · P2-T1 起）**：该 schema 已被**交付面校验**消费——`packages/contracts/src/schema-check.ts` 的 `validateCapabilityShape` 以 schema JSON 为判据源，`tests/unit/phase2-contract-schema.test.js` 对注册表全量能力逐条校验并另有 schema↔`CAPABILITY_DOMAINS` 漂移守卫（本条承诺的拒绝行为有 `policy.additionalProperties=false` 用例逐字自证）；**运行实例仍不校验能力定义**（用户裁决 Q1=(b)：能力定义源自代码内常量，运行期校验只在校验自己编译出来的东西，增益≈0 且给启动加风险面）⇒ 升级前删该键仍是**运维必做动作**——红的是测试/门禁，不是运行期报错。解释器约束由 `appops.cli.invoke` 的 `input.app` 枚举 + `validateParams`（早于执行）承担。
4. **注册表写/读两表必须成对存在**。历史上写表是死配置（`isWrite` 要求动词两侧都有点，真实 ID `system.registry.write` 末段无尾点 ⇒ 恒 false ⇒ 写请求一直按读表判定）。修 `isWrite` 与补写表**必须同 commit**，否则会把「`HKLM:\SOFTWARE` 写入走 L2 审批」这条 SKILL.md 明文承诺的流程直接封死 —— 白名单 miss 发生在审批闸**之前**，miss = 硬 DENY 而非转"需批准"。
5. **策略表里没有任何"超时"字段**（Phase 2 · P2-T2）。历史的 `approvalTimeoutMs` 与本节第 3 条被删的 `commandAllowlist` 是同款病灶（"配了却不生效"的假安全感），已连同默认值（`DEFAULT_POLICY`）与合并逻辑（`mergePolicy`）一并删除；`AgentCard.signature`（JWS 签名卡）同批删除（仅剩类型声明、全仓零实现）。旧配置键不会静默失效 —— `validateServiceConfig` 对 `policy.approvalTimeoutMs` 给出**恰一条**告警（不阻断启动，判据钉在 `tests/unit/phase2-dead-config.test.js`）；契约面删除经 `tsc -b` 全量编译自证无残余引用。


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
- ✅ 审批超时默认**拒绝**（fail-closed）。**成立方式**：未获批准一律**不执行**（MCP 侧未携带有效 `approvalId` 的 L2/L3 请求永远返回 `APPROVAL_REQUIRED`；A2A 侧任务挂起至 TTL 到期即落 `timeout` 决策）。**Phase 1 现状**：两条 TTL 回收均已实现 —— A2A 审批等待由 `task-store.waitApproval` 按 `WINVM_APPROVAL_TTL_MS`（默认 30 分钟）计时；MCP 侧待批令牌由 `PendingApprovalRegistry.sweepExpired()` 定时清扫（同一 env 旋钮，**不新造同义配置**）。**Phase 2 · P2-T2 现状**：曾与本旋钮并提的 `policy.approvalTimeoutMs`（默认 120s、引擎与审批闸全仓零消费的**历史死字段**）已从 `PolicyConfig` / `DEFAULT_POLICY` / `mergePolicy` **三处删除** —— 删除属破坏性契约变更，故 `validateServiceConfig` 对旧配置键**显式告警而非静默忽略**（含旧键 ⇒ warnings 恰一条、不阻断启动；判据钉在 `tests/unit/phase2-dead-config.test.js`）。超时/拒绝/取消三种否定决策均入链（`ext.kind:'approval-decision'`），不得折叠为"未批准"。
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

#### 4.3.1 校验范围的限定语（**重要，别把 `chainValid:true` 读成"全链完好"**）

`vm-service` 装配链时固定 `freshChainOnStart: true`（本轮起新分片，不接续历史 seq/hash）。因此：

| 事实 | 说明 |
|---|---|
| `verifyChain()` 在 freshChain 模式下**只校验本轮运行的分片** | 历史分片永久退出判定面 |
| 该范围是**机器可读**的 | 返回体与 `/health.audit` 透出 `scope: 'session' | 'full'`、`shardsVerified`、`shardsTotal`、`shardsArchived`（= total − verified）；freshChain ⇒ `scope='session'`，否则 `'full'` |
| 跨轮历史改由**启动归档校验**提供证据 | `verifyArchive()` 对非本轮分片**逐片独立**跑「片内 seq 单调 + 片内 prevHash 链式」，结果落一条 `ext.kind:'chain-archive-verify'` 审计条目；有界 `maxShards=30`（超出只计数不校验），全程 `try/catch` 绝不抛 |
| 为什么只能**片内**校验 | 历史片彼此无链关系，且与本轮新片也无关系（freshChain 以 GENESIS 重开）；若比对跨片首条 `prevHash` 则必然全红 |

⇒ 运维读法：`audit.chainValid` 回答的是「**本轮运行期内**任一改动即校验失败」；「历史分片是否完好」是另一条证据（归档校验条目），两者不得混为一谈。§1.1 威胁表里的「篡改即校验失败」须按本限定语理解。

**权衡登记**见 §6.4（本批刻意不改 `freshChainOnStart` 行为，根治另立项）。

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
| Bearer token | 环境变量 `WINVM_BEARER_TOKEN`（名称由宿主 `--token-env` / `tokenEnv` 指定），由宿主注入；**不落明文配置**；仅在 VM 侧开 `enforceBearer` 时参与校验（见 §6.1） |
| WorkBuddy header 覆盖 | 走宿主 `connector-states.v3.json` 的 AEAD 加密机制（实测 `aes-256-gcm` + `hkdf-sha256`） |
| VM 自动登录凭据 | 用 Windows DPAPI / 凭据管理器；**禁止**明文写注册表 |

### 6.1 认证是两件事，别混为一谈（双层模型）

| 层 | 认证对象 | 机制 | 何时需要 |
|----|----------|------|----------|
| **SSH 层** | 宿主 ↔ 被控端 Windows（scp 推包 / `ssh -L` 开隧道） | **SSH 公钥**（默认）；密码不可行 | 始终（部署 + 隧道） |
| **Bearer 层** | 宿主 connector ↔ `vm-service`（MCP/A2A 协议） | `WINVM_BEARER_TOKEN`（宿主侧经 `--token-env` 给出**变量名**） | **仅当 VM 侧显式开启 `security.enforceBearer` 且 `tokenEnv` 有值**（双条件，O-9）；默认 `false` ⇒ 走回环隧道时免校验。⚠ 注意"非回环直连"在本系统**不是**可用形态（非回环绑定即启动 `error`，§2.1 第 2 条），所以 bearer 只在"回环 + 显式开守卫"这一组合下生效 |

> 默认部署走 `ssh -L … 127.0.0.1:18443`，隧道两端都是回环地址，Bearer 层**免校验**；`vm-service.config.json` 默认**不开** `enforceBearer`。所以绝大多数场景你**只需要配好 SSH 密钥**，无需碰 bearer token。

**读 §6.1 必须同时知道的三件事**（口径权威在 §2.1，此处只列操作面）：

1. **"Bearer 层免校验"是信任边界声明的一部分，不是待补的漏洞**：本系统对"谁在调用"的答案是**回环 + SSH 隧道 + 审批闸**，不是凭据。不要因为"bearer 更保险"就顺手打开 `security.enforceBearer`。
2. **`enforceBearer` 是"配置即生效"的可选加固，双条件成立才挂载**（`enforceBearer===true` **且** `tokenEnv` 有值，O-9），生效与否由 `/health.security.authMode` 三态显式透出。宿主侧客户端通路已就绪：`--token-env`（`host-a2a-bridge/src/cli.ts`）→ `buildTransport` → `applyBearerHeader`（`core/src/transport`，两条远程传输分支**共用同一实现**，避免两份漂移），三态语义为「无 tokenEnv ⇒ 不加头／有值 ⇒ `authorization: Bearer <token>`／有名无值 ⇒ **fail-loud 抛 `TransportError`**，绝不静默降级成无凭据请求；ssh-tunnel 分支的校验还**前置到建隧道之前**」。
3. ⚠ **VM 内回连凭据通路本批未实现 ⇒ 误开后 VM 内回连全 401、委派退化为零副作用的虚假完成**（2026-10-10 B3 真机演练实测订正，原"当场失败"表述与实况不符）：`buildMcpConfig()` 下发给 VM 内 agent CLI 的 `mcpServers` 条目（回连 `/mcp?dtid=…`）**不含凭据**。开 `enforceBearer`（双条件齐）后：宿主不带凭据 ⇒ HTTP 层当场 401（可见）；但 VM 内回连段 401 只打在**工具面** ⇒ LLM"无工具可用仍口头收尾"⇒ 终态 `completed` + 零能力产物 + 链上 `zeroInnerCalls:true`，由 CL-K3R 真值层「完成声称不予采信」兜住（详见 §2.1 警告块）。启用前置条件（需定 env 分发机制 + 部署脚本发 token + 两侧回归 + bearer 生效自检）与残留风险登记见 §2.1 与 `docs/changes/phase1-arch-design.md` §5 第 3 条 / §10 R4。

#### 6.1.1 两项已登记的权衡（Phase 1 裁决结果，**非缺陷**，别"顺手修掉"）

本节是"认证/凭据"讨论的落点，因此把与 §6.1 直接相关的两条权衡在此**登记在册**（详细四件套——风险 / 为什么不根治 / 现有缓解 / 运维动作 / 根治归属——在 §6.4，权威表在 `docs/changes/CL-022/TECHNICAL-SOLUTION.md` 风险与回滚）：

| # | 权衡 | 与 §6.1 的关系 | 裁定 |
|---|---|---|---|
| **W-1** | `freshChainOnStart: true`（每次服务启动起新分片 + 新 genesis）⇒ `verifyChain()` 只证明「本轮连续」（`scope='session'`），跨轮完整性退出判定面 | 与"bearer 可选加固"同构的取舍：**默认形态不追求全覆盖，但必须把覆盖范围显式说清楚**（凭据面靠 `authMode` 三态、审计面靠 `scope`/`shardsArchived`，都拒绝静默降级） | 保持真值、**不列为可关项**（§8 锚点纪律）；跨轮证据 = §4.3.1 的启动 `verifyArchive()` + `chain-archive-verify` 条目。根治（启动即全量校验并阻断就绪）另立 P0，不在本批夹带 |
| **W-2** | 审计**保留期不设上限**（无到期删除、无容量水位清理，仅按天 / ≥64MB 轮转切分） | 凭据"不落明文"与审计"永不删除"是同一条纪律的两面：都拒绝给攻击者留可配置的消证开关 | 默认保留、**不由本服务自动删除**；收缩由运维在 VM 外做（**先导出归档再收缩**，不要靠删文件腾空间——那会同时销毁 W-1 仅剩的历史证据） |

> 登记来源：`docs/changes/phase1-arch-design.md` §2.2 裁决 + §10 风险表；实施记录 `docs/changes/phase1-t5-notes.md`、变更集 `docs/changes/CL-022/`。

### 6.2 SSH 认证：只用密钥，不用密码

`setup.mjs` / `install-vm.mjs` / `install-host.mjs` 内部的 `ssh` / `scp` / `ssh -L` 都是**直接调用系统 `ssh`**，脚本本身**不接收、不传递任何密码**——`.env` 里只有 `VM_HOST` / `VM_USER` / `VM_SSH_PORT`，**没有密码字段**。因此认证完全交给操作系统 SSH：

- ✅ **密钥（推荐，可无人值守）**：`ssh-keygen -t ed25519` 生成，把 `~/.ssh/id_ed25519.pub` 追加进远端 `%USERPROFILE%\.ssh\authorized_keys`，并修 ACL（仅本人可读，否则 OpenSSH 会无视该文件）。若默认密钥非 `id_ed25519`，须在宿主 `~/.ssh/config` 按 `VM_HOST` 配 `IdentityFile`。
- ❌ **密码（不建议）**：Windows 自带 `ssh`/`scp` 交互式读密码，脚本不传密码、`.env` 无密码字段；原生 Windows 不随附 `sshpass`（脚本调用 `ssh`/`scp` 而非 PuTTY `plink`），`setup.mjs --apply` 这类一次性多步 SSH 流程会卡在交互要密码。密码只适合本人终端偶尔手动连一下。

### 6.3 远程 Windows（非本地 VM）同样适用

被控端是不是真·虚拟机不影响架构——`vm-service` 只要跑在一台 Windows 上、经隧道在 `127.0.0.1:18443` 可达即可。把 `VM_HOST` 指向远程 Windows（物理机 / 云主机 / 内网机器），本地当宿主、远程当"VM"，即"本地操作远程 Windows"。唯一额外前置：远程 Windows 需 **OpenSSH Server 监听 22 且宿主可路由**（完整步骤见 `DEPLOYMENT.md §7`）。其余认证、隧道、能力边界与本地 VM 完全一致。

### 6.4 两项已知安全权衡（显式登记，Phase 1 刻意不根治）

> 体检曾点名「权衡未登记于 SECURITY 文档」。安全文档里**没有**登记的权衡等于不存在，因此本节按"风险 + 为什么不修 + 怎么观测 + 何时根治"四件套逐条写黑。

**权衡一：`freshChainOnStart = true` ⇒ 跨轮篡改不在 `chainValid` 判定面内**

| 项 | 内容 |
|---|---|
| 风险 | 攻击者若能在两次服务启动之间改写/删除**历史审计分片**，`/health.audit.chainValid` 仍会报 `true`；单看该位无法发现跨轮篡改。更弱的一环是"整片删除"—— freshChain 模式每轮都以 `GENESIS` 重开，本就不校验上一轮的链头衔接，删掉整片不会留下断裂痕迹。 |
| 为什么不根治 | 根治要改成持久 seq/hash 续链（跨进程唯一链头），这会与既有分片文件、`activeShards` memoize、以及所有以"本轮链"为前提的断言同时冲突，属独立 P0 立项；把它塞进安全兑现批会让本批 5 个任务的回归面失控。 |
| 现有缓解 | ① 校验范围**机器可读**（`scope`/`shardsArchived`，见 §4.3.1）—— "我这一轮验了多少"不再是隐藏信息；② 启动 fire-and-forget `verifyArchive()` 落一条 `chain-archive-verify` 条目，历史片**至少**得到片内校验；③ 审计文件 ACL 仅服务运行用户可写（§4.1）；④ `maxShards` 有界，不为取证引入可挂死 IO。 |
| 运维动作 | 别只读 `chainValid`。要看 `audit.scope` 与 `shardsArchived`，并把历史分片**异地留存**（每日轮转文件推到 VM 之外）。 |
| 根治归属 | Phase 2 独立变更（持久链头 + 跨片衔接校验 + 分片外部锚定/签名）。 |

**权衡二：审计无保留期（retention）与自动归档策略**

| 项 | 内容 |
|---|---|
| 风险 | 与权衡一**同源方向相反**：审计**永不删除** ⇒ 磁盘单调增长；分片数一多，`verifyArchive()` 在 `maxShards=30` 处截断（超出只计数不校验），最老的分片会退出任何校验面，而"没被校验"与"完好"是两件事。同时全量留存会把凭据明文之外的敏感操作细节长期堆积在本机。 |
| 为什么不根治 | 保留期涉及合规口径（监管要求"留多久"与"能不能删"由业务与法规决定，不是工程默认值）；V1 选择**只追加不删除**，避免工程侧擅自清理出"审计被抹"的可疑窗口。 |
| 现有缓解 | 按天轮转 + 单文件 ≥64MB 切分（§4.1）；`shardsTotal` 透出使增长可观测；归档校验条目可反查每片的 `entries`/`valid`。 |
| 运维动作 | 自行设定**外部留存 + 冷备**策略（VM 外只读副本），并核对 `shardsTotal - shardsVerified` 是否已超 `maxShards`（超了就说明有片退出校验）。**不要**靠删文件腾空间——那会同时销毁权衡一仅剩的历史证据。 |
| 根治归属 | Phase 2/3 与合规口径一并定：导出签名归档 + 保留期 + `verifyArchive` 全量覆盖方案。 |

---

## 7. 安全默认值汇总（Secure by Default）

| 项 | 默认 |
|---|---|
| 传输 | SSH 隧道（VM 仅回环监听） |
| **回环绑定** | **不可关**：非回环 ⇒ 启动 `error`，`security.requireLoopbackBind=false` 自 Phase 1 起不再能放宽（只额外产生 warning）—— 见 §2.1 |
| 服务端身份鉴权 | `security.enforceBearer` 默认 `false`（可选加固，双条件生效，`/health.security.authMode` 三态透出）；开启前置条件见 §2.1 警告块 |
| 策略 | **拒绝优先** |
| L2/L3 | 强制审批 + before/after 快照 |
| L3 分区/格式化 | **不注册为可用能力** |
| 删除 | 进回收站 |
| 委派 `maxRisk` | L1 |
| 审批超时 | 拒绝（fail-closed） |
| 公网暴露 | **恒不可**：非回环绑定即启动 `error`（Phase 1 起从"告警"升为"拒绝启动"，见 §2.1）；无公网暴露配置模板 |
| 任务取消 | **协作式真取消**（能力调用边界生效）；取消终态以 `terminalState:'canceled'` + `errorCode:'TASK_CANCELED'` 入链；呈现面禁止"未执行任何变更"式承诺 —— 见 §2.2 |
| 审计 | 全量开启 + 哈希链（**校验范围 = 本轮**，跨轮见 §4.3.1 与 §6.4 权衡一） |
| provider 异常 | 降级为仅 `meta.*` |

---

## 8. 与评估建议 §5 风险清单的对应

| 评估建议风险 | 本设计缓解 | 落点 |
|---|---|---|
| 等于给 VM 开 RCE | 七层纵深防御（§2）+ 信任边界声明与回环不可关（§2.1） | 全局 |
| GUI 黑屏/失效 | 会话探针 + tscon + 自动登录 + 降级语义（§5） | `core/session`、`vm-capabilities` |
| 委派"黑盒" | 强制 artifact（steps/screenshots/change-list）+ traceId（§IF-2.6） | `a2a-framework`、`vm-service` |
| 资源占用 | V1 用确定性执行器（无 LLM 开销）；并发上限；任务可取消 | `adapter-agent-workbuddy`、`core` |

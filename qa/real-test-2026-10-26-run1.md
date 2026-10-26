# WinVM Bridge · 部署策略 v2 全流程真机验证报告（run1）

> 报告 ID：REAL-TEST-2026-10-26-run1
> 日期：2026-10-26 16:00 ~ 16:35（GMT+8）
> 被测对象：`docs/deploy/deploy-strategy.md` 六步策略（从零安装）
> 环境：鸿蒙宿主（WorkBuddy 沙箱）→ Win11 VM `172.16.100.2`
> 分发包：`winvm-overall-V1.4.2.zip`（commit `eba187e`，2,722,056 B）
> 结论：**PASS — 六步全部实测通过，验收 25/25，可交付；但发现 2 处发布链缺口（见 §6）**

---

## 1. 环境基线

| 项 | 值 | 取证 |
|---|---|---|
| 宿主 OS | HarmonyOS NEXT / WB 沙箱 | `process.platform=openharmony` |
| 宿主 node | `v24.13.0`（`/data/storage/el1/bundle/libs/arm64/node/bin/node`） | `node -v` |
| 宿主 ssh | `OpenSSH_9.6p1`；**无 `sshpass`** | `command -v` |
| VM | Windows 11 `WIN-HOS-YWANG-S`，用户 `User`（Administrators 组） | `system.info.get` |
| VM IP / SSH | `172.16.100.2:22` | `vm-conn.json` |
| VM-service | `127.0.0.1:18443`（**仅回环**） | `Get-NetTCPConnection` |

## 2. 清理起点（前置条件已满足）

`delivery/uninstall.mjs --apply --purge-workspace` → **17/17 PASS**，双端零残留：
宿主插件缓存/市场/连接器/`installed_plugins`/`settings`/`mcp.json` 无 winvm；
VM 计划任务删除、`C:/WinVMBridge` 与 `C:/WinVMWorkspace` 清空、7 个 skills junction 移除、
PATH 与 `side.json` 移除；免密 ssh 通道清除（仅删本项目 key，保留他人 key 1 条）。
证据：`qa/evidence/cleanup-20261026/uninstall-apply-20261026-160055.log`

## 3. 六步执行结果

| 步 | 内容 | 判据 | 结果 | 耗时 |
|---|---|---|---|---|
| 1 | 密码登录 → 建立免密通道 | `PASSWORD_AUTH_OK` + `whoami` 公钥登录成功 | ✅ PASS | ~2 min |
| 2 | 获取 Release 并三重校验 | `sha256sum -c` OK + `verify-manifest.py` PASS | ✅ PASS | ~20 s（含 1 次抖动重试） |
| 3 | 部署 VM-service | `Running` / `127.0.0.1:18443` / `ok:true` | ✅ PASS | 71 s（deterministic）/ 53 s（workbuddy） |
| 4 | 安装宿主插件 + 隧道 | `RUNNING` + `FRESH` + `/health` 200 | ✅ PASS | ~1 s（隧道自动拉起） |
| 5 | 全维度测试 | MCP 20/20 + A2A 5/5 | ✅ PASS | ~5 min |

### 3.1 Step 2 三重校验实测值

| 层 | 校验对象 | 实测值 |
|---|---|---|
| 1 | zip 整包 | `a06e75206dadb4a895bdd3b02762aca7315f3973845c6f99d86eb54a9d00e149` |
| 2 | MANIFEST 三元组 | `867` 文件 / `7,313,511` B / `total-sha256 8d753c700848c9ef4280038497db8009f5d8d359be0a129e01721b7abecdd3a3` |
| 3 | 逐文件 sha256 | 867/867 一致，无多余、无缺失 |

### 3.2 Step 3 健康指纹（两 provider 对照）

| 字段 | `workbuddy-deterministic` | `workbuddy`（默认） |
|---|---|---|
| `provider.state` | `ready` | `ready` |
| `capabilitiesProfile.kind` | `deterministic` | `llm-agent` |
| `persistentSession` / `warmup` | `false` / `false` | `true` / `true` |
| `approvalTruth` | `null` | `{mode:"on", enabled:true, shadow:false}` |
| `capabilities.count` | 54 | 54 |
| `security.loopbackOnly` | `true` | `true` |
| `audit.chainValid` | `true` | `true` |

## 4. Step 5 全维度验收明细（25/25）

### A. 健康与版本指纹（6/6）

| # | 项 | 实测 |
|---|---|---|
| A1 | `/health ok:true` | provider=`workbuddy` state=`ready` |
| A2 | 能力数 54 | count=54 avail=54 |
| A3 | 会话健康 | state=`healthy` locked=`false` |
| A4 | 仅回环绑定 | `authMode=loopback-only` |
| A5 | 审计链完整 | `chainValid=true` |
| A6 | 审批闸在线 | `delegationRequiredPolicy=true` wiring=`shadow` |

### B. MCP 面（7/7）

| # | 项 | 实测 |
|---|---|---|
| B1 | initialize | server=`winvm-bridge` v=`0.1.0` |
| B2 | tools/list 非空 | total=54 |
| B3 | 工具名点分形态 | 54/54 |
| B4 | 工具数 54 | 54 |
| B5 | 原始面含全 54（高危 8 个由宿主过滤） | raw 暴露=8 |
| B6 | 关键抽样工具在册 | 缺失=[] |
| B7 | 宿主 `~/.workbuddy/mcp.json` `disabledTools` | 8 条 |

### C. 跨域功能抽样（5/5）

| # | 能力 | 域 | 结果 |
|---|---|---|---|
| C1 | `meta.capability.list` | meta | ok:true, count=54 |
| C2 | `system.info.get` | system | ok:true, 返回真实主机名/用户 |
| C3 | `storage.disk.list` | storage | ok:true, 返回真实磁盘 |
| C4 | `app.inventory.list` | app | ok:true, 返回真实已装软件 |
| C5 | `gui.session.status` | gui | ok:true, sessionId=1 interactive |

### D. A2A 发现（2/2）

| # | 项 | 实测 |
|---|---|---|
| D1 | `GET /.well-known/agent-card.json` | 200，name=`WinVM Bridge Agent`，skills=5 |
| D2 | `POST /a2a` 存活 | 200 |

### E. A2A 委派（5/5）

| # | 项 | 实测 |
|---|---|---|
| E1 | stdio 桥 initialize | `winvm-a2a-bridge` v0.1.0 |
| E2 | a2a 工具在册 | delegate / task.get / approval.reply / task.cancel / health / audit.receipt |
| E3 | `a2a.health` | VM Agent 可达，声明 5 个技能 |
| E4 | `a2a.delegate`（deterministic） | `steps[0]` = `system.info.get`，`risk=L0`，`ok=true`，1262ms |
| E4' | `a2a.delegate`（workbuddy） | `steps[0]` = `appops.workflow.run`，LLM 编排，`ok=true` |

## 5. 本轮修复的探针缺陷（属断言错误，非产品缺陷）

| # | 原断言 | 问题 | 订正 |
|---|---|---|---|
| 1 | 「`/mcp` 的 `tools/list` 不含 8 个高危工具」 | 原始 MCP 面**恒列全 54**，`disabledTools` 是宿主侧过滤 | 改读 `~/.workbuddy/mcp.json` 的 `disabledTools.length===8` |
| 2 | `app.inventory.list {"limit":5}` | 该能力无 `limit` 形参 → `INVALID_PARAMS` | 传 `{}` |
| 3 | `a2a.delegate {"capability":…,"input":…}` | 必填参数是 `goal`（自然语言） | 传 `{"goal":"…"}` |
| 4 | `GET /a2a/health` | **该路由不存在**（404 ≠ 故障） | 发现用 `agent-card.json`，健康用 MCP `a2a.health` |

## 6. 发现的两处发布链缺口

| # | 缺口 | 证据 | 影响 |
|---|---|---|---|
| G-1 | V1.4.2 包早于 HEAD 的 P2 修复（包 `eba187e`/10-21；修复 10-24~10-25） | ① 包内 `install-host.mjs` 无 `NON_ACCOUNT_DIRS`（0 次 vs 仓库 3 次）；② 安装后 `connectors/skills/mcp.json`、`connectors/marketplace-meta/mcp.json` 被写入 `connector:winvm`；③ 包内缺 `delivery/tools/diagnose-connectors.mjs`，连接器自检被跳过 | 用 Release 安装会带回已修缺陷并污染非账户目录 |
| G-2 | `MANIFEST.txt` 无消费者校验 | 全仓仅 `pack-release.mjs` 生成 | 包内损坏无法在安装前发现 |

**本轮手工处置**：把两个被污染文件（各 956 B，仅含 winvm 条目）移入可恢复备份
`~/wbtmp/winvm-nonaccount-trash-20261026/`，随后复跑 MCP 探针 **20/20 仍全绿**，
两个真账户（`default`、`8dd0df6a…`）的 winvm 条目完好。

## 7. 交付物清单

| 文件 | 说明 |
|---|---|
| `docs/deploy/deploy-strategy.md` | 策略文档 v2.1（含 §0.5 变量表 + 各步实测记录 + §9.1 缺口台账） |
| `docs/deploy/deploy-prompts.md` | 总 Prompt 文档（可直接粘贴驱动全流程安装） |
| `qa/deploy-probes/verify-manifest.py` | 第 2 步第三层校验（867 文件 + total-sha256） |
| `qa/deploy-probes/vmcheck.ps1` | 第 3 步 VM 侧判据（任务/端口/side.json/health 一次取全） |
| `qa/deploy-probes/mcp-probe.py` | 第 5 步 MCP 面 20 项验收 |
| `qa/deploy-probes/a2a-probe.py` | 第 5 步 A2A 面 5 项验收 |
| `qa/deploy-probes/vm-env-check.ps1` | 第 3.0 步 VM 运行时前置（node/npm/CLI/登录态，含 `-Fix`） |

### 7.1 补充验证 · Step 3.0 运行时前置（同日 17:3x）

> 用户裁定：维持 `WINVM_VM_PROVIDER=workbuddy` + `WINVM_WORKBUDDY_CLI=codebuddy`（不引入
> `workbuddy-native`），但 Step 3 前必须先自检并补齐 VM 运行时（node / npm / codebuddy CLI）。

| 例 | 命令 | 关键输出 | 判定 |
|---|---|---|---|
| 正例 | `vm-env-check.ps1` | `NODE v24.21.0` / `NPM 11.19.0` / `CLI 2.167.0` / `GLOBAL_PKG=@tencent-ai/codebuddy-code@2.167.0` / `AUTH_VERDICT=config-dir-present` / `ENV_PRECHECK=PASS` | ✅ |
| 负例 | `vm-env-check.ps1 -SimulateMissing` | `BLOCKERS=node,npm,cli` / `ENV_PRECHECK=FAIL` / `NEEDS_RUNTIME=true` / `CLI_INSTALL_CMD=npm i -g @tencent-ai/codebuddy-code` + 3 条 `RUNTIME_HINT_*` | ✅ 双向正确 |
| 幂等 | `vm-env-check.ps1 -Fix` | 无 `installing`、无 `AFTER_FIX_*`，直接 `PASS` | ✅ 不重复安装 |
| 安装可行性 | `npm i -g … --dry-run` | `DRYRUN_EXIT=0` / `changed 102 packages in 16s`；`npm view … version` → `2.176.0` | ✅ 用户目录写入，无需提权 |
| preflight 阻断 | `checkLocalVmDeps({provider:'workbuddy', cli:'no-such-cli-xyz'})` | `vm-agent-cli FAIL(blocking)` → `ok=false`；对照 `deterministic` 同项 `FAIL` 但 `blocking=false` → `ok=true` | ✅ 缺 CLI 确实中止 |
| 内联兜底 | `powershell -Command "node -v; npm -v; codebuddy --version"` | `v24.21.0` / `11.19.0` / `2.167.0` | ✅ 无探针时可用 |

补充事实：**`winget` 在 ssh 非交互会话不可用**（`--version` 输出为空且 `exit 0`，MSIX alias 空壳）；
VM 的 Node 由 **nvm-windows 2.0.0** 管理，故 `nvm use` 切版本会使全局 `codebuddy` **失效**。

新增缺口 **G-3**：`qa/deploy-probes/` **不在发布包内**（`pack-release` 只带 `qa/probes/` 两件；
V1.4.2 包 `MANIFEST` 搜 `deploy-probes` = 0 命中）→ 纯 Release 安装拿不到探针，已给内联兜底。

## 8. 结论

1. **六步策略可行且已实测**：从「密码登录」到「全维度测试」全程由宿主 WorkBuddy 单侧驱动，
   无需人在 VM 上操作。
2. **两种 VM provider 均通过**：`workbuddy-deterministic`（基准）与 `workbuddy`（LLM 常驻，
   用户裁定为默认）各 25/25。
3. **有阻塞但不阻断本次交付**：G-1/G-2 属发布链质量债，建议先发 `V1.4.3`
   （`tsc -b` → `pack-release` → `publish-release`，纳入 `delivery/tools/`），
   再复跑本报告流程取 run2。

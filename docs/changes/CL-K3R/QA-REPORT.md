# CL-K3R · T05 真机验证 QA-REPORT

> **权威数据源**：`docs/test/reports/k3r-t05-runbook-2026-10-05.md`（可执行 Runbook）· `k3r-t05-phase-d-blocker-2026-10-05.md`（Phase D 阻塞根因 + 修复）· `k3r-t05-real-machine-2026-10-06.md`（A~F 真机完成报告）
> **执行者**：主理人（齐活林）—— 子 agent 无 VM 路由，隧道只存在于主理人网络命名空间
> **辅助**：宿主侧离线门禁与单测由 Engineer / 既有四道闸承担；`tests/unit/cl-k3r-runpersistent-approval-routing.test.js` 为 Phase D 新增宿主单测
> **环境**：宿主 HarmonyOS NEXT 沙箱 + Windows VM（`User@172.16.100.2`，服务 `127.0.0.1:18443`）
> **最终结论**：**PASS** —— **K3 静默假成功已根治**：`on` 模式 **3/3** 真机委派终态 **`input-required`**（而非 `completed`），未出现 `ok:true` 却未执行的假成功。
> **说明**：本文为三份真机报告的**变更集归档版**，数字与证据一律逐字取自源报告；源报告未记录处写「未记录」。

---

## 1. 前置门禁（G0~G4）全部通过

| 门禁 | 判据 | 实测 |
|---|---|---|
| **G0** 隧道存活 | `~/.workbuddy/winvm/tunnel.state.json` `state=RUNNING && alive=true` | ✅ pid **22335**（2026-10-04 13:23 起，经 ~11.7h 浸泡未换 pid） |
| **G1** VM 可达 | `GET http://127.0.0.1:18443/health` → `ok=true` | ✅ **`ok=true`（200）** |
| **G2** 本地构建干净 | `npx tsc -b tsconfig.build.json --force` → 0 error | ✅ **0 error** |
| **G3** 四道闸 + K-N1 | 11/11、10/10、2/2、41/41、242/242，fail 全 0 | ✅ **310/310**，fail 全 0 |
| **G4** E-3 指纹已合入 | 运行时三态可观测字段存在 | ✅ VM `/health` **`providerApprovalTruth = {"mode":"on","enabled":true,"shadow":false}`**（**顶层**，非 `provider.approvalTruth`，见 §3） |

> **G3 分项口径提示**：源报告给的合计为 **310/310**；按报告正文列出的分项相加为 `11+10+2+41+242 = 306`。**差额 4 源报告未说明**（疑为 K-N1 某文件在后续补录后的计数）。本文以报告的 **310/310** 为准，差额如实登记，不作调和。

**为什么 G4 不可省（Runbook §2 原话摘录）**：唯一的行为学指纹 `[shadow] 未决审批结构化命中` **只在命中时出现**。若 shadow 轮没命中（LLM 措辞碰巧带关键词），就无法区分「shadow 且未命中」与「根本没启用」 ⇒ 整轮测量不可证，违反本项目「未复现 ≠ 已修、必须确定性注入」的口径。

---

## 2. 阶段 A｜部署新构建

- 命令：`node delivery/deploy-vm.mjs --env=.env.deploy-vm --apply`（流程：BUILD `npm run build` → scp/install → VM-START → QA-PROBE → 端口轮询）。全程 ✅。
- **关键**：本沙箱 git 受限，deploy 走**本地 dist 打包**（非 `git archive`），故**未提交的修复**（`bridge.ts` + 单测）随 dist 一并上 VM。
- VM 侧 `dist/bridge.js` 已含修复标记（grep 实证）：`LLM_PERSISTENT_TURN_FAILED` **×1**、`approvalTruthShadow` **×4**、`reconcileApprovalWait` **×9**。

> **为什么要先跑 A（背景基线，2026-10-05 实测取证）**：T05 开工前 VM 跑的是 **K3R 前的旧构建**（`psBridge.uptimeMs ≈ 89,181,399` ≈ 24.8h，即 10-04 01:40 那次部署），而本地 dist 已含新代码。
> **⇒ 关键结论：必须先部署，否则真机跑的是旧代码，任何「验证通过」都是假的。**

---

## 3. 阶段 B｜版本指纹（证明跑的是新代码）

| 指纹 | 实测 |
|---|---|
| `psBridge.uptimeMs` | **≈ 69,684**（部署后刚重启；对比旧构建 ≈ 24.8h）⇒ 新构建确实上线 |
| `providerApprovalTruth` | **`{"mode":"on","enabled":true,"shadow":false}`** —— E-3 指纹存在（旧构建无此字段） |
| 其它 | `llmSession.state=ready`；`capabilities` 正常 |

> **⚠ 版本口径修正**：指纹位于 **顶层 `providerApprovalTruth`**（**非** `provider.approvalTruth`）。Runbook §2 G4 的假设路径需修正。**成因未在报告中记录，待核实**（可确证的实测事实：Phase B 取到 `{mode:"on",enabled:true,shadow:false}` 位于顶层字段）。
> **纪律**：**只用 uptime 不足以证明版本；指纹 > uptime**（既有教训）。

---

## 4. 阶段 C｜切 `shadow` + 断言指纹

1. 备份 `vm-service.runtime.json` → `vm-service.runtime.json.bak-on`；
2. 在 `agent.providers.workbuddy.options` 内加 `"approvalTruth": "shadow"`；
3. `powershell -File C:/WinVMBridge/kill-restart.ps1`；
4. 轮询 `/health` 直到 `ok=true`，**断言 `providerApprovalTruth.mode === "shadow"`** ⇒ ✅（`uptime ~102s`，新重启）。

> 断言不通过则**停止**，不得进入阶段 D。

---

## 5. 阶段 D｜shadow 测量（≥3 次）

- 命令：`node qa/r19/a2a-extra.mjs k3r --prefix=<abs>/k3r-shadow-{1,2,3} --truth=shadow`，**3 次**。
- **终态：3/3 均为 `completed`** —— **符合 G4 纪律**（shadow 只观察、不改判）。
- VM 服务日志 `[shadow] 未决审批结构化命中` warn **命中 2/3 次**（run 1、run 2/3 中两次）。
- **「1/3 未命中」的根因（T2 歧义实测显形）**：k3r 目标引导 LLM「不要用 `APPROVAL_REQUIRED` 字眼」，codebuddy **偶尔绕过 `app.winget.uninstall` 改走 `appops.workflow.run`**（终态 step `capabilityId:appops.workflow.run`）⇒ **服务端无 `APPROVAL_REQUIRED` 事实** ⇒ 该次结构化判据无物可查、warn 不触发。
  - 属「调用前合成 / 工具未被实际调用」分支，是**结构化探针的固有限制，非修复缺陷**。
  - 2/3 命中已足够证明 shadow **观察纪律成立**。
- 对照证据：`providerApprovalTruth.mode` 全程为 `shadow`；串台核对未记录异常（`未记录`）。

---

## 6. 阶段 E｜切 `on` 复跑（≥3）—— 根治成立 ⭐

1. 改回 `"approvalTruth": "on"` → `kill-restart.ps1` → 断言 `mode==="on"` ✅；
2. `k3r` × 3 次，**全部 `K3R_INPUT_REQUIRED`**，`verdict = PASS: 结构化判据命中 ⇒ 终态 input-required（K3 假成功被根治）`。

**命中明细（3 次一致）**：

```
approvalId:   apr_1bdd3e1e4b9e4e318b7e
capabilityId: app.winget.uninstall        ← 高风险工具确被调用并被拦截
risk:         L2
params:       { id: "Microsoft.WindowsCalculator", dryRun: false }
```

**对照结论**：同一委派在 shadow 轮 `completed`（仅 warn），在 `on` 轮 **`input-required`**（真正改判）⇒ **shadow 轮 2/3 的 `completed` 样本在 `on` 轮全部转为 `input-required`** ⇒ **治愈成立**。
**指纹纪律**：`[shadow]` warn 总数停在 **3**（全部来自 shadow 轮），**on 轮零 warn** ⇒ 灰度过账干净。

---

## 7. I1 真机确认（stream-json 是否回 `is_error=true`）

- **孤立的 stream-json 复现文件无结论**：取回滞留 VM 的 `k3r-repro-stream-en.txt` 时，其中**仅含 PowerShell 横幅 + EXIT_MARKER**（复现脚本未重定向 codebuddy stdout）。
- 但 **I1 已由更强证据闭环**：
  1. **F3**（旧 `winvm-service-2026-10-05.log` 记 `[llm-session] LLM 常驻会话轮次完成 durationMs=1723 ok=false`）；
  2. **本轮 on 轮显示工具确被调用并触发服务端 `APPROVAL_REQUIRED` 事实**，桥（`on`）据此改判 `input-required`。
- **结论**：**无论 `is_error=true`（走修复的 `!turn.ok` 文本启发式分支）还是 `ok=true` + 服务端事实（走 `reconcileApprovalTruth` 结构化分支），修复均正确** —— 两条路径在 `on` 模式都会把审批暂停态收敛为 `input-required`。

**附：I1 取证过程中的两个绕路（均已记录，供复跑者省时间）**
1. `k3r-goal.txt` 是 **GBK 编码**，PS `[IO.File]::ReadAllText(..., UTF8)` 误解码 ⇒ 中文乱码 ⇒ codebuddy 收不到干净目标、只会追问澄清（首轮复现即因此只得到 mojibake + `is_error=false`）。
2. `codebuddy` 在 VM 上解析为 **`.ps1` 包装器**（`C:\Users\User\AppData\Local\Author Software\nvm\...\codebuddy.ps1`，路径含空格）；`Start-Process` 系列**无法直接以 stdin 重定向启动 `.ps1`** ⇒ 须改用 `powershell.exe -File codebuddy.ps1 -p ...` 作为宿主承载。

---

## 8. 宿主离线验证（不需 VM）

| 项 | 结果 |
|---|---|
| Phase D 宿主单测 `tests/unit/cl-k3r-runpersistent-approval-routing.test.js` | **4/4 PASS** |
| ├ A | `!turn.ok` + 审批文本 → `APPROVAL_REQUIRED`（`input-required` 前置） |
| ├ B | `!turn.ok` + 无审批文本（真错） → `EXECUTION_FAILED` |
| ├ C | `turn.ok=true` → `ok:true`（**回归护栏**） |
| └ D | `shadow` + 审批文本 → **仅 `[shadow]` warn、不改判**（保持 `EXECUTION_FAILED`） |
| 四道闸 + K-N1（G3） | **310/310**，fail 全 0 |
| `npx tsc -b tsconfig.build.json --force` | **0 error** |
| E-3 三态指纹自证（`wbtmp/e3-fingerprint.mjs`） | **3/3** 档逐字对应（`mode`/`enabled`/`shadow`），三态互异 |
| E-2 加载序验证（A/B/C 三序） | 序 A / 序 B 文本兜底生效；序 C 降级透传、不抛、不改 `ok` |
| D-4 守门（`docs/design/cl-k3r-impl-progress.md` §6 红线自检结论） | **`packages/a2a-framework/src/**` 零改动**（本环境无版本控制系统，未独立复核） |
| SK-9 守门（`bridge.ts` `APPROVAL_WAIT_PATTERN` / `parseApprovalBlock` / `function reconcileApprovalWait` / `return base` 的 +/- 行） | **零命中**（grep 退出码 1） |

---

## 9. 收尾补充｜k3r harness 收紧（2026-10-06）

**owner 决策**：harness 收紧与 git 提交都作。

| 改动 | 内容 |
|---|---|
| 默认 `goal` | 强制**直接调 `app.winget.uninstall`、禁止 `appops.workflow.run` 间接方式**（消除 §5 的 T2 歧义根因） |
| 新增助手 | `capabilityIdsOf(task)`（`qa/r19/a2a-extra.mjs:134`）：从任务 data 段收集团队**实际调用**的能力 |
| 新增断言分支 | `sidestepDetected`（`:671`）：`capabilityIds` **不含** `app.winget.uninstall` **且含** `appops.workflow.run` ⇒ `INCONCLUSIVE_SIDESTEP`（判据分支 `:677` 的 else-if；赋值起始 `:678`，**字符串在 `:679`）—— 明确区分「真失败」与「harness 构造问题」 |

**收紧后复验（刚恢复的 VM，`on` 态，`uptime≈2.3h`）**：实跑 1 次 **PASS** —— `capabilityId=app.winget.uninstall`、`capabilityIds=["app.winget.uninstall"]`、`sidestepDetected=false` ⇒ **绕路消除、探针干净命中**；并顺带**复证治愈态在重启后依然有效**。

- 证据：`wbtmp/k3r-tighten-1.out.json`；taskId `72f30a22-34b7-4a27-b716-dbecbde17242`；`approvalId apr_7e7b60b61a0c4075b510`。
- 测试遗留的 `input-required` 任务已**驳回（`rejected`）**以保持 VM 整洁。

---

## 10. 判定

### 10.1 总体判定：**PASS**

| 判据 | 结论 |
|---|---|
| K3 根治 | ✅ `on` 模式 **3/3** 真机委派终态 `input-required`，**未出现** `ok:true` 却未执行的假成功 |
| 双路径收敛 | ✅ `ok:true` 结构化分支由**真机**证明；`!turn.ok` 文本分支由**宿主单测 4/4** 证明 |
| 灰度纪律 | ✅ shadow 仅观察（`completed` + warn）、on 真正改判（`input-required`）—— G4 的「不可证」问题已被顶层 `providerApprovalTruth` 指纹 + `[shadow]` warn 解掉 |
| 回归护栏 | ✅ 310/310 + `tsc -b --force` 0 error + D-4/SK-9 守门干净 |

### 10.2 遗留项

| # | 项 | 性质 | 建议处置 |
|---|---|---|---|
| **L-1** | k3r 目标下 codebuddy 偶发**绕路** `appops.workflow.run` ⇒ 结构化探针无事实可查 | **harness 构造问题，非修复缺陷** | 2026-10-06 已通过 harness 收紧缓解（`sidestepDetected` 明确区分）；若再出现，判 `INCONCLUSIVE_SIDESTEP` 而非 FAIL |
| **L-2** | **git 提交待在真实开发机执行**（沙箱环境限制）：`bridge.ts`（Phase D 修复）、`qa/r19/a2a-extra.mjs`（harness 收紧）、`tests/unit/cl-k3r-runpersistent-approval-routing.test.js`（新增）、两份真机报告（新增）均未入库 | **流程性遗留**（非质量问题） | 建议 commit message：`fix(k3r): runPersistent !turn.ok 分支补审批暂停甄别 + T05 真机验证通过`，harness 收紧追加 `+ k3r harness 收紧` |
| **L-3** | 孤立复现文件 `k3r-repro-stream-en.txt` 无结论（脚本未重定向 stdout） | 取证脚本缺陷（已被更强证据替代） | 若需再次做 I1 孤立复现，须先修脚本的 stdout 重定向 |
| **L-4** | VM 曾多次出现「可达 → 休眠 → 不可达」（隧道存活但上游断连，回环呈「TCP 通 / HTTP 黑洞」） | 环境可用性 | 恢复条件：VM 重新上电 / RDP 唤醒后，隧道守护进程（指数退避重连）自动恢复 |

### 10.3 建议的后续观测项（非本轮）

- `pendingApprovals` 在长会话下的累积观测（Q5，本轮不实现）；
- V-4（`recordBlockedApprovalAudit` 的 `channel` 误标 `mcp`）归 K-N1 收口；
- V-5（`LedgerRegistry.ledgerForInnerTrace()` 死代码）清理候选。

---

## 11. 证据清单

| 位置 | 内容 |
|---|---|
| 宿主侧 `wbtmp/` | `k3r-shadow-{1,2,3}.out.json`（shadow 轮证据）· `k3r-on-{1,2,3}.out.json`（on 轮 PASS 证据，含 `approvalId` / `capabilityId`）· `vm-health.json`（Phase B 指纹）· `vm-service-2026-10-06.log`（VM 服务日志，`[shadow]` warn + 重启记录）· `k3r-tighten-1.out.json`（harness 收紧复验） |
| VM 侧 `C:/WinVMBridge/` | `k3r-repro-oneshot.ps1` · `k3r-repro-stream.ps1` · `k3r-repro-out.txt` / `k3r-repro-stream.txt` · `k3r-goal.txt` · `k3r-goal-en.txt` |
| 真机日志 | `C:/Users/User/AppData/Local/WinVMBridge/logs/winvm-service-2026-10-05.log` |

---

## 12. 已知坑（本轮已踩 / 既有教训，写给下一次复跑）

| 坑 | 说明 |
|---|---|
| **`k3r` 子命令没有 dry-run** | `qa/r19/a2a-extra.mjs` **任何参数组合都会真的下发一次委派**（曾误以为 `--help` 是试运行，实际发出 L2 卸载任务）。下发即产生真实拦截，须按协议回 `approved:false` 收尾 |
| **远端 shell = Git Bash(MSYS)** | `/` 开头参数被路径转换 ⇒ 远端逻辑一律写 `.ps1` → scp（**远端路径须 `C:/…`**）→ `powershell -NoProfile -ExecutionPolicy Bypass -File` 执行 |
| **配置会被重新生成** | 只有 `install-vm`（即 `deploy-vm.mjs --apply`）会重新生成 `.generated/`；`kill-restart.ps1` 不会（顺序必须是「先部署 → 后打补丁 → 再重启」） |
| **证据文件「写完再读」** | 读取落在写入窗口内会得到未 flush 的 0B 假空文件；任何「为空」结论须二次确认（mtime + 字节 + 进程存活） |
| **隧道假活** | TCP 通但 HTTP 黑洞时判据是 ping 100% 丢包；`alive=true` 才可信 |
| **版本证明** | 只用 uptime 不足以证明版本；**指纹 > uptime**（本轮的顶层 `providerApprovalTruth` 即指纹） |

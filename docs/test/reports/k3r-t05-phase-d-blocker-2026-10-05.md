# CL-K3R · T05 Phase D 阻塞根因诊断报告

- 日期：2026-10-05
- 作者：主理人（齐活林）
- 关联：`k3r-t05-runbook-2026-10-05.md`、`cl-k3r-e2b-e3-taskbook.md`、`cl-k3r-silent-false-success-design.md`

## 1. 结论速览

T05 Phase D「shadow 轮 1」返回 **INCONCLUSIVE** 的根因已定位：

> codebuddy 在 **stream-json（常驻会话）模式**下，对「高风险能力被审批闸拦截（APPROVAL_REQUIRED）」
> 这一**暂停态**回吐 `result` 事件并置 `is_error=true`；而 `CliLlmBridge.runPersistent`
>（`bridge.ts:1236`）在 `!turn.ok` 时**直接返回 `EXECUTION_FAILED`**，**先于**
> `reconcileApprovalTruth`（K3R 结构化 + 文本判据，`bridge.ts:779-795`）的执行。
> 于是「审批暂停态」被误判为「硬执行失败」→ D4.4 降级 → 终态 `failed` → K3R 的「真值判据」
> 从未被触发，Phase D 永远 INCONCLUSIVE。

附带发现两处**真实 bug / 验收缺陷**，与 K3R 是否「正确闭合」直接相关。

---

## 2. 已确认事实（真机实测 + 源码核对）

### F1. 鉴权不是阻塞原因（已排除）
- 持久会话生成的 `mcp.json` 由 `buildMcpConfig`（`bridge.ts:159-166`）产出，**不含任何鉴权头**：
  ```json
  {"mcpServers":{"winvm":{"type":"streamableHttp","url":"http://127.0.0.1:18443/mcp"}}}
  ```
- winvm `/mcp` POST 处理器（`server.ts:1043-1058`）**不校验 `security.tokenEnv`**，仅 `mcp.handleRequest`。
- 结论：服务端不强制 bearer，codebuddy 可达工具；**鉴权与本次阻塞无关**。

### F2. 单次 `-p`（文本）路径下，目标会被正确处理
真机 `codebuddy`（v2.x）以 **`-p text` + `--permission-mode bypassPermissions` + `--mcp-config`**
对 k3r 目标「卸载 Microsoft.WindowsCalculator（高风险，会被安全策略拦截）」：
- 正确理解目标；
- winvm `app.winget.uninstall` 工具被调用后回吐 `APPROVAL_REQUIRED`（服务端审批 id `apr_8379ba256c2c4379921f`），操作**未实际执行**；
- codebuddy 以**正常 stdout 文本**（exit 0、`is_error=false`）回吐该拦截结论（含 `APPROVAL_REQUIRED` 字样）。
- 在 `runOneShot` 路径下，文本启发式 `reconcileApprovalWait`（匹配 `APPROVAL_REQUIRED`/`等待审批`）
  **能命中** → 正确转 `input-required`。

### F3. 常驻会话（stream-json）路径下，同一回合返回 `is_error=true`
真机日志（`winvm-service-2026-10-05.log`）：
```
[llm-session] LLM 常驻会话就绪
[llm-session] LLM 常驻会话轮次完成 durationMs=1723 ok=false
```
会话 warm+ready 后，1723ms 即结束且 `ok=false`（= `result.is_error=true`，见 `persistent-session.ts:772-781`）。
→ 在 `runPersistent` 路径下，因 `bridge.ts:1236` 提前 return，**K3R 判据被绕过**。

### F4. 桥侧代码确认：`runPersistent` 在 `!turn.ok` 跳过 K3R
`bridge.ts:1236-1246`：
```ts
if (!turn.ok) {
  return { result: { ok:false, summary:`...${turn.error ?? '未知原因'}`,
    error: makeError('EXECUTION_FAILED','LLM_PERSISTENT_TURN_FAILED') } };
}
// reconcileApprovalTruth 仅 turn.ok 分支执行（:1248-1277）
```
`reconcileApprovalTruth` / `reconcileApprovalWait`（K3R 结构化 + 文本判据）**只在 `turn.ok` 时执行**。
`!turn.ok` 一律判 `EXECUTION_FAILED`，**漏掉「审批暂停态被误标 is_error」** 这一情形。

---

## 3. 关键推断（待 clean 真机复现最终确认）

- **I1**：stream-json 模式下，codebuddy 把「审批闸拦截（APPROVAL_REQUIRED 暂停态）」作为
  `result.is_error=true` 回吐（文本模式则作为正常结果）。这是两类调用模式的差异，也是 Phase D 阻塞的**直接触发点**。
- **I2**：由于 `runPersistent` 提前 return，K3R 的**结构化判据**（依赖服务端「winvm 工具回吐 APPROVAL_REQUIRED」的事实）
  在真实（常驻）路径上**完全失效**——即便 codebuddy 文本完全漂移、彻底回避 `APPROVAL_REQUIRED` 字眼，
  K3R 也读不到服务端结构化事实。

---

## 4. 测试设计问题（K3R 验收本身难以成立）

- **T1**：k3r 测试目标显式要求「不要用『等待审批』/『APPROVAL_REQUIRED』字眼」。
  但实测 F2 显示 codebuddy 仍写出了 `APPROVAL_REQUIRED`，文本启发式仍能命中；
  若 codebuddy 真正漂移、彻底回避该词，则**只能靠 K3R 结构化判据**——而该判据恰因 F4 在真实路径上被绕过。
- **T2（更深层）**：本目标触发的「安全策略拦截」是发生在「winvm 工具**实际被调用**并回吐 APPROVAL_REQUIRED」之后
  （服务端有结构化事实），还是 codebuddy 安全策略在「调用前」拦截（合成 APPROVAL_REQUIRED、服务端无事实）？
  - F2 出现 `apr_` 服务端 id → 倾向「工具已调用、服务端有事实」；
  - 但 codebuddy 文本称「在发起前被策略拦截」「未对 VM 造成任何更改」→ 存在歧义。
  - 若属「调用前合成」，则 K3R 结构化判据对这一类**永远**无事实可查，验收目标需换成
    「确保 winvm 工具被调用并回吐 APPROVAL_REQUIRED」的场景。

---

## 5. 已落地修复（`bridge.ts` `runPersistent` 的 `!turn.ok` 分支）

> ✅ **2026-10-06 已实施并宿主单测通过（4/4）**。代码位置：`packages/adapter-agent-workbuddy-llm/src/bridge.ts:1236` 起。

实施要点（与原「建议」有偏差，见下方 ⚠️）：

```ts
if (!turn.ok) {
  const failedBase = { ok:false, summary:`...${turn.error ?? '未知原因'}`, artifacts, steps:[],
    error: makeError('EXECUTION_FAILED','LLM_PERSISTENT_TURN_FAILED') };
  const reconciled = reconcileApprovalWait(failedBase, turn.text);   // 既有 K3 文本启发式（非新建结构化探针）
  const isApprovalWait = reconciled.error?.code === 'APPROVAL_REQUIRED';
  if (this.approvalTruthShadow) {                                    // shadow 态：仅 warn 不改判（G4 纪律）
    this.onSessionLog?.('[shadow] 常驻会话失败态命中审批等待文本模式（不改判，供对拍）', { taskId, textHeuristicVerdict: isApprovalWait ? 'waiting-approval' : 'not-waiting' });
    return { result: failedBase };
  }
  if (isApprovalWait) return { result: await this.maybeResume(reconciled, input, sink, ctx, 'persistent') };
  return { result: failedBase };
}
```

- 在 `!turn.ok` 分支**先跑文本启发式 `reconcileApprovalWait`**（识别 `APPROVAL_REQUIRED`/`等待审批` + `apr_` token）：
  - 命中 → 改判 `ok:false + APPROVAL_REQUIRED` 并经 `maybeResume` 路由到 `input-required`；
  - 未命中 → 维持原 `EXECUTION_FAILED`（真实执行失败照常降级）。
- **shadow 门控**：`shadow` 态下**仅 warn 不改判**（保持 `EXECUTION_FAILED` 以「观察」修复前假失败），与 `reconcileApprovalTruth` 的结构化探针 shadow 纪律**逐字一致**（G4 要求：shadow 必须能区分「未命中」与「根本没启用」）；`on`/`off` 态才真正改判。
- 文本启发式是既有 K3 机制（函数体一字未改，SK-9），与 `on`/`off` 路径下 `reconcileApprovalTruth` 把文本启发式作兜底的行为**同源**。

### ⚠️ 与原「建议修复」的关键偏差（必须记录）

原 §5 建议「在 `!turn.ok` 分支调 `reconcileApprovalTruth` 兜底」。**该方案是 no-op**，原因：
`reconcileApprovalTruth`（`delegation-truth.ts:227`）有 **门 0：`if (!base.ok) return base;`** ——
对 `ok:false` 的 `failedBase` 会**直接透传、绝不改判**（D-1 两道门结论优先）。
故「调 reconcileApprovalTruth」无法在 `!turn.ok` 分支生效；正确做法是**直接复用 `reconcileApprovalWait` 文本启发式**
（它不拒绝 `ok:false`，且正是 `reconcileApprovalTruth` 在 `on`/`off` 态下的兜底实现）。

### 为何不依赖结构化探针（K3R）命中

审批闸拦截有两类（见 T2）：「winvm 工具被调用、服务端回吐 APPROVAL_REQUIRED（有结构化事实）」vs
「codebuddy 安全策略调用前合成 APPROVAL_REQUIRED（服务端无事实）」。本目标属后者概率更高
（F2 文本称「发起前被策略拦截」）。**结构化探针对此类永远无事实可查**，故 `!turn.ok` 分支只能、也必须
靠**文本启发式**兜底——这与设计 §5.3「结构化退场时回退文本启发式」完全一致。

### 宿主单测（不需 VM）

新增 `tests/unit/cl-k3r-runpersistent-approval-routing.test.js`（4/4 PASS）：
1. `!turn.ok` + 审批文本 → `APPROVAL_REQUIRED`（input-required 前置）；
2. `!turn.ok` + 无审批文本 → `EXECUTION_FAILED`；
3. `turn.ok=true` → `ok:true`（回归守卫）；
4. `shadow` + 审批文本 → 仅 `[shadow]` warn、不改判（保持 `EXECUTION_FAILED`）。


---

## 6. 当前状态（2026-10-06）

- **修复已落地 + 宿主单测 4/4 通过**（见 §5）。逻辑正确性已由宿主单测独立证明，无需 VM。
- **VM（172.16.100.2）仍间歇性不可达**：本会话内多次出现「可达 → 休眠 → 不可达」。隧道守护进程存活但上游断连，
  回环 `127.0.0.1:18443` 呈「TCP 通 / HTTP 黑洞」。
  - 影响：**clean stream-json 复现的 I1 取证**与 **Phase D/E/F 真机实测**仍无法进行。
  - 恢复条件：VM 重新上电 / RDP 唤醒后，隧道守护进程（指数退避重连）自动恢复。
- **I1 真机复现的实际阻碍（已厘清，比预期更绕）**：
  1. `k3r-goal.txt` 是 **GBK 编码**，PS `[IO.File]::ReadAllText(..., UTF8)` 误解码 → 中文变乱码 →
     codebuddy 收不到干净目标 → 只会追问澄清、**到不了审批暂停态**（首轮 stream-json 复现即因此只得到 mojibake + `is_error=false`）。
  2. `codebuddy` 在 VM 上解析为 **`.ps1` 包装器**（`C:\Users\User\AppData\Local\Author Software\nvm\...\codebuddy.ps1`，
     路径含空格）；`System.Diagnostics.Process.Start` / `Start-Process` 均**无法直接以 stdin 重定向启动 `.ps1`**
     （`Win32Exception` / `InvalidOperationException`）。须改用 `powershell.exe -File codebuddy.ps1 -p ...` 作为宿主承载。
  3. 规避：改用 **ASCII/英文目标**（`k3r-goal-en.txt`）+ `powershell.exe -File` 宿主，已构造出可启动的复现脚本
     `k3r-repro-stream-en.ps1`。该脚本在 VM 活跃时**已成功执行**（XNOZo4，2026-10-06 01:10），但结果文件
     `k3r-repro-stream-en.txt` 因 VM 随后休眠而**未能取回**——I1 结论待 VM 恢复后补取。

---

## 7. 状态（2026-10-06 更新）

- ✅ **T05 全阶段 A~F 已于真机完成**，详见 `k3r-t05-real-machine-2026-10-06.md`（on 模式 3/3 委派终态 `input-required`，K3 假成功被根治）。
- ✅ VM 已恢复；I1 取回文件无结论（复现脚本未重定向 codebuddy stdout），但由 F3 + on 轮「工具确被调用并触发服务端 APPROVAL_REQUIRED 事实」实证闭环——**无论 `is_error=true`（走修复的 `!turn.ok` 文本分支）或 `ok=true+服务端事实`（走 `reconcileApprovalTruth` 结构化分支），修复均正确**。
- ✅ 部署含修复的新构建（VM 旧构建已替换）；灰度 `approvalTruth=on`（治愈态）；VM 临时脚本已清理。
- ⏳ **git 提交待用户在真实开发机执行**（HarmonyOS 沙箱无 git 二进制）：见新报告 §10.1。
- ⚠ 遗留（非阻塞）：k3r harness 目标下 codebuddy 偶发绕过目标工具改走 `appops.workflow.run`（§8.4 / runbook T2 歧义），属测试构造问题，不影响修复正确性。

---

## 附录：本次排查用到的真机脚本与产物（VM 侧）
- `C:/WinVMBridge/k3r-repro-oneshot.ps1`（单次 -p + bypassPermissions + mcp-config，文本）
- `C:/WinVMBridge/k3r-repro-stream.ps1`（stream-json 帧 + bypassPermissions + mcp-config，UTF-8 直写 stdin）
- `C:/WinVMBridge/k3r-repro-out.txt` / `k3r-repro-stream.txt`（codebuddy 输出）
- `C:/WinVMBridge/k3r-goal.txt`（k3r 测试目标，UTF-8 源）
- 真机日志：`C:/Users/User/AppData/Local/WinVMBridge/logs/winvm-service-2026-10-05.log`

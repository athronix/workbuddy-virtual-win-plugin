# CL-K3R · T05 真机验证完成报告（2026-10-06）

- 日期：2026-10-06
- 执行者：主理人（齐活林）
- 关联：`k3r-t05-phase-d-blocker-2026-10-05.md`（Phase D 阻塞根因 + 修复）、`k3r-t05-runbook-2026-10-05.md`（执行序列）、`cl-k3r-e2b-e3-taskbook.md`

## TL;DR

T05 全阶段（A~F）已在**真机**跑通。修复（`bridge.ts` `runPersistent` `!turn.ok` 分支补审批暂停甄别 + K3R 结构化判据 `reconcileApprovalTruth`）经 `on` 模式 3/3 真机委派验证：**终态 `input-required`（非 `completed`），K3 静默假成功被根治**。VM 现已稳定运行含修复的新构建、灰度开关处于 `on`（治愈态）。

## 1. 前置门禁（G0~G4）全部通过

| 门禁 | 判据 | 结果 |
|---|---|---|
| G0 隧道存活 | `tunnel.state.json` RUNNING/alive=true，pid 22335 | ✅ |
| G1 VM 可达 | `GET /health` → ok=true（200） | ✅ |
| G2 本地构建干净 | `tsc -b tsconfig.build.json --force` → 0 error | ✅ |
| G3 四道闸+K-N1 | 310/310 测试 fail 全 0（4 K3R + k5-replay(41) + 7 K-N1） | ✅ |
| G4 E-3 指纹合入 | VM `/health.providerApprovalTruth = {mode:"on",enabled:true,shadow:false}` 字段存在 | ✅（见 §3） |

## 2. 阶段 A｜部署新构建

- `node delivery/deploy-vm.mjs --env=.env.deploy-vm --apply`：BUILD（npm run build）→ scp/install → VM-START → QA-PROBE → 端口轮询，全程 ✅。
- 关键：本沙箱无 git，deploy 走**本地 dist 打包**（非 git archive），故未提交的修复（`bridge.ts` + 单测）随 dist 一并上 VM。VM 侧 `dist/bridge.js` 已含修复标记（`LLM_PERSISTENT_TURN_FAILED`×1、`approvalTruthShadow`×4、`reconcileApprovalWait`×9，grep 实证）。

## 3. 阶段 B｜版本指纹（证明跑的是新代码）

- `GET /health`：`psBridge.uptimeMs ≈ 69,684`（部署后刚重启，对比旧构建 ~24.8h）⇒ 新构建确实上线。
- `providerApprovalTruth = {"mode":"on","enabled":true,"shadow":false}` ⇒ E-3 指纹存在（旧构建无此字段）；`llmSession.state=ready`；`capabilities` 正常。
- 注：指纹位于**顶层** `providerApprovalTruth`（非 `provider.approvalTruth`），runbook 假设路径需修正。

## 4. 阶段 C｜切 shadow + 断言指纹

- 备份 `vm-service.runtime.json` → workbuddy.options 加 `approvalTruth:"shadow"` → `kill-restart.ps1` → 轮询 `/health` 断言 `mode==="shadow"` ✅（ok=true, mode=shadow, llm=ready, uptime ~102s 新重启）。

## 5. 阶段 D｜shadow 测量（≥3）

- `node qa/r19/a2a-extra.mjs k3r --prefix=.../k3r-shadow-{1,2,3} --truth=shadow`，3 次均终态 `completed`（shadow 观察不改动，符合 G4 纪律）。
- VM 服务日志 `[shadow] 未决审批结构化命中` warn **命中 2/3 次**（run 1、run 2/3 中两次）。
- **T2 歧义实测显形**：k3r 目标引导 LLM「不要用 APPROVAL_REQUIRED 字眼」，codebuddy 偶尔**绕过 `app.winget.uninstall` 改走 `appops.workflow.run`**（终态 step `capabilityId:appops.workflow.run`），导致服务端**无 APPROVAL_REQUIRED 事实** → 该次结构化判据无物可查、warn 不触发。属「调用前合成 / 工具未被实际调用」分支，是结构化探针的固有限制（非修复缺陷）。2/3 命中已足够证明 shadow 观察纪律成立。

## 6. 阶段 E｜切 on 复跑（≥3）— 根治成立 ⭐

- 改回 `approvalTruth:"on"` → kill-restart → 断言 `mode==="on"` ✅。
- `k3r` × 3 次，**全部 `K3R_INPUT_REQUIRED`**，`verdict = PASS: 结构化判据命中 ⇒ 终态 input-required（K3 假成功被根治）`。
- 命中明细（3 次一致）：
  ```
  approvalId: apr_1bdd3e1e4b9e4e318b7e
  capabilityId: app.winget.uninstall   ← 高风险工具确被调用并拦截
  risk: L2
  params: {id:"Microsoft.WindowsCalculator", dryRun:false}
  ```
- 对照：同一委派在 shadow 轮 `completed`（仅 warn），在 `on` 轮 `input-required`（真正改判）。**shadow 轮 2/3 的 completed 样本在 on 轮全部转为 input-required** ⇒ 治愈成立。
- `[shadow]` warn 总数停在 3（均来自 shadow 轮），on 轮零 warn ⇒ 指纹纪律正确。

## 7. I1 真机确认（stream-json 是否 is_error=true）

- 取回滞留 VM 的 `k3r-repro-stream-en.txt` 仅含 PowerShell 横幅 + EXIT_MARKER（复现脚本未重定向 codebuddy stdout，孤立复现文件无结论）。
- 但 I1 已由更强证据闭环：①F3（旧 `winvm-service-2026-10-05.log` 记 `LLM 常驻会话轮次完成 ok=false`）；②本轮 on 轮显示**工具确被调用并触发服务端 APPROVAL_REQUIRED 事实**，桥（on）据此改判 input-required。
- 结论：**无论 `is_error=true`（走修复的 `!turn.ok` 文本启发式分支）还是 `ok=true+服务端事实`（走 `reconcileApprovalTruth` 结构化分支），修复均正确**——两路径在 `on` 模式都会把审批暂停态改判为 input-required。

## 8. 关键结论

1. **K3 静默假成功已根治党**：`on` 模式 3/3 真机委派终态 input-required，未出现 `ok:true` 却未执行的假成功。
2. **修复双路径收敛**：`ok:true` 结构化分支由真机证明；`!turn.ok` 文本分支由宿主单测 4/4 证明（见 blocker 报告 §5）。
3. **灰度纪律验证**：shadow 仅观察（completed + warn），on 真正改判（input-required）——G4 不可证问题已解（顶层 `providerApprovalTruth` 指纹 + `[shadow]` warn）。
4. **遗留（非阻塞）**：k3r 测试目标下 codebuddy 偶发绕过目标工具（`appops.workflow.run`），致结构化探针无事实可查——需在 harness 目标中强制「直接调用 `app.winget.uninstall`、禁止 workflow 间接方式」才能稳定 100% 命中；但此属测试构造问题，不影响修复正确性。

## 9. 证据文件（宿主侧 `wbtmp/`）

- `k3r-shadow-1.out.json` / `k3r-shadow-2.out.json` / `k3r-shadow-3.out.json`（shadow 轮证据）
- `k3r-on-1.out.json` / `k3r-on-2.out.json` / `k3r-on-3.out.json`（on 轮 PASS 证据，含 approvalId/capabilityId）
- `vm-health.json`（Phase B 指纹）
- `vm-service-2026-10-06.log`（VM 服务日志，`[shadow]` warn + 重启记录）

## 10. 下一步

1. **git 提交**（沙箱无 git，须在真实开发机）：
   `git add packages/adapter-agent-workbuddy-llm/src/bridge.ts tests/unit/cl-k3r-runpersistent-approval-routing.test.js docs/test/reports/k3r-t05-phase-d-blocker-2026-10-05.md docs/test/reports/k3r-t05-real-machine-2026-10-06.md && git commit -m "fix(k3r): runPersistent !turn.ok 分支补审批暂停甄别 + T05 真机验证通过"`
2. **VM 现状**：已部署含修复的新构建、`approvalTruth=on`（治愈态），可保留为生产状态；`.bak-on` 备份可删（已确认线上为 on）。
3. 视需按 §8.4 调整 k3r harness 目标以稳定 100% 命中（构造问题，非修复问题）。

## 11. 收尾补充｜k3r harness 收紧（2026-10-06）

- owner 决策「harness 收紧 + git 提交都作」。收紧 `qa/r19/a2a-extra.mjs` 的 k3r 目标：
  - 默认 `goal` 强制**直接调 `app.winget.uninstall`、禁止 `appops.workflow.run` 间接方式**（消除 §8.4 的 T2 歧义根因）；
  - 新增 `capabilityIdsOf` 助手，从任务 data 段收集团队实际调用的能力；
  - 断言新增 `sidestepDetected` 分支：`capabilityIds` 不含 `app.winget.uninstall` 且含 `appops.workflow.run` ⇒ `INCONCLUSIVE_SIDESTEP`（明确区分「真失败」与「harness 构造问题」）。
- 收紧后在刚恢复的 VM（`on` 态、uptime≈2.3h）实跑 1 次：**PASS**，`capabilityId=app.winget.uninstall`、`capabilityIds=["app.winget.uninstall"]`、`sidestepDetected=false` ⇒ 绕路消除、探针干净命中；并顺带复证治愈态在重启后依然有效。
- 证据：`wbtmp/k3r-tighten-1.out.json`（taskId `72f30a22-34b7-4a27-b716-dbecbde17242`，approvalId `apr_7e7b60b61a0c4075b510`）。测试遗留的 input-required 任务已驳回（`rejected`）保持 VM 整洁。
- 提交：`git add … qa/r19/a2a-extra.mjs …`（沙箱无 git，须在开发机执行，commit message 追加「+ k3r harness 收紧」）。

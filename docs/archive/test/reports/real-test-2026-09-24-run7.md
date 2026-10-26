# 真机测试报告 · run7（2026-09-24）

> 迭代测试第 7 轮（用户口径「第 6 轮迭代测试」的续轮）。前置：K2（A2A 冷启动停滞）修复 **两版迭代**、
> `setup.mjs --apply` 全量重部署（八相位 EXIT=0）+ VM 服务重启复验。
> 本轮为 K2 修复后的第一个全量真机轮次。

## TL;DR

- **A 系列 18 项：18/18 全 PASS**（run6 的 A1/A3 BLOCKED 本轮补齐；A5 首次在 LLM 热态下真实完成委派）。
- **K2 修复验证闭环**：服务重启 → 启动期预热 → `llmSession.state=ready`（T+~60s）→ 首个 A2A 委派
  **18.4s 真实完成**（run6 同探针为 60.8s 超时返回 `A2A_DELEGATE_FAILED`）。
- 单测 482/482 全 PASS、`tsc -b` 0 错误；部署端与仓库逐字节一致（A11 3/3 SAME）。

## 测试矩阵

| 项 | 结果 | 说明 |
|---|---|---|
| A1 单例桥 | PASS | 实例数=1（run6 曾被 termination-pending 僵尸阻断） |
| A2 provider/桥状态一致 | PASS | ready/ready |
| A3 桥自愈 | PASS | 强杀 4396 → 重生 12468（新 PID），服务未重启，自愈调用 8.4s ok |
| A4 CLI 调用 | PASS | node 1.3s / ffmpeg v9.0.1 1.1s |
| **A5 A2A 委派（K2 专项）** | **PASS** | **18427ms isError=false ok=true**（LLM 热态真实完成；run6=60824ms 超时） |
| A6 meta.health.check | PASS | 10 大字段齐（含 llmSession/cache） |
| A7 存储五件套 | PASS | dir/write/read/search/zip/space 全 ok |
| A8 应用清单/服务/日志 | PASS | inventory 24、service 264、eventlog 3 |
| A9 dry-run 免审批 | PASS | restart dryRun 计划返回 |
| A10 风险闸路由 | PASS | 单命中/零命中 |
| A11 目录治理/部署一致性 | PASS | 3/3 SAME（app.ps1 / ps-bridge.ps1 / adapter dist） |
| A12 宿主-VM 技能同步 | PASS | diff 无差异 |
| A13 空间分析 | PASS | 单调不增，首项 1090.27MB |
| A14 PS 5.1 裸键排序审计 | PASS | 命中=0 |
| A15 领域错误码上浮 | PASS | FILE/SERVICE/REG_PATH/CLI 四分支全正确 |
| A16 入参契约 | PASS | INVALID_PARAMS+INVALID_ARGUMENT |
| A17 winget 不静默空 | PASS | 插件 11 ≡ 基线 11，7zip 在列，脏行 0 |
| A18 type/enum 校验 | PASS | 含宽松形态反向对照 |

**证据**：`qa/evidence/run7-qa-a-full.out`（汇总行 `PASS=18 FAIL=0`，QA_EXIT=0）。

## K2 修复全记录（A2A 冷启动停滞 · 本轮核心工作）

### 根因（run6 已定性）

常驻 codebuddy 会话是 `PersistentCliSession` **lazy 单例**：VM 服务重启/空闲回收后首个 A2A 委派
必付进程级冷启动（auth probe + agent 端点 ≈75–107s）> 宿主 A5 探针 60s 有界超时 → 返回
「冷启动窗口」引导文案而非结果。

### 第一版（已部署后判失效，未进入报告口径）

`provider.warmup()` 复用 `runGoal(180s)`。部署日志
（`qa/evidence/run7-deploy.log`）HEALTH 暴露：
`llmSession.state=stopped, lastError="常驻会话在 60000ms 内未收到 system/init"`。
根因：`execTurn` 的 init 等待上界恒为 `min(readyTimeoutMs=60s, 预算)` 且**超时即 killChild**——
冷机 codebuddy init >60s → 预热亲手杀死了自己拉起的会话。

### 第二版（本轮落仓库 + 部署，最终生效）

**预热改走独立路径，与真实轮次的 60s init 上限/杀会话语义解耦**：

| 文件 | 改动 |
|---|---|
| `packages/core/src/constants.ts` | 新增 `ENV_LLM_SESSION_WARMUP_MS`（默认 180_000）+ `LlmSessionConfig.warmupReadyMs`；`config/index.ts` 默认值与 env 覆盖同步 |
| `packages/adapter-agent-workbuddy-llm/src/persistent-session.ts` | `PersistentCliSession` 新增 `warmup(prompt, budgetMs)`：**init 上界取 `warmupReadyMs`（180s）且超时仅返回、不置 degraded、不写 lastError、绝不 killChild**；经串行链 `enqueue` 与真实 `runTurn` 互斥；消费本轮 `result` 后才判 ready（防残留 result 污染首个真实轮次）；`warmupInFlight` 单飞防重入 |
| `packages/adapter-agent-workbuddy-llm/src/bridge.ts` | `LlmBridge` 接口新增可选 `warmup?(prompt)`；`CliLlmBridge.warmup()` 用**与真实 runGoal 同一 outputDir** 构造会话单例（确保预热的就是首调复用的对象）；`CliLlmBridgeOptions.outputDir` 新增 |
| `packages/adapter-agent-workbuddy-llm/src/index.ts` | provider `warmup()` 改调 `bridge.warmup(LLM_SESSION_WARMUP_GOAL)`；构造期把 `outputDir` 传入 bridge |
| `packages/vm-service/src/server.ts` | provider 加载后 `void provider.warmup?.()`（fire-and-forget，仅 `kind==='llm-agent'`；对齐 CL-018 netCfg 预热先例） |
| `tests/unit/llm-provider.test.js` | warmup 测试改断言 bridge.warmup 委托 + 未 init no-op |
| `tests/unit/cl018-persistent-session.test.js` | 新增 4 个 K2 warmup 专项：达成/超时不杀会话/幂等/disabled 安全 |
| `tests/unit/cl018-config.test.js` | llmSession 基线补 `warmupReadyMs: 180_000` |

**验证证据链**：

1. **代码层**：`tsc -b` 0 错误；`npm run test:unit` **482/482 PASS**（含 4 个新 warmup 专项）。
2. **部署层**：`setup.mjs --apply` 八相位全绿（`qa/evidence/run7-deploy-v2.log`，EXIT=0）；
   HEALTH 段 `llmSession.state=ready, pid=1216` —— **v1 的 init 超时 lastError 彻底消失**。
3. **运行层（服务重启复验）**：`kill-restart.ps1` 重启 WinVMBridge.Service → T+8s
   `state=starting(pid=9416)`（预热进行中）→ **T+~60s `state=ready`**（预热达成，无 lastError）。
4. **端到端（A5）**：预热 ready 后首个真实委派 **18427ms ok=true**，对比 run6 冷态 60824ms 超时。

### K2 修复前后对比

| 指标 | run6（修复前） | run7（修复后） |
|---|---|---|
| 服务重启后 llmSession | stopped + init 超时 lastError | **ready**（T+~60s 预热达成） |
| 首个 A2A 委派 | 60.8s 超时 → `A2A_DELEGATE_FAILED` | **18.4s ok=true**（真实完成） |
| A5 判定 | PASS 仅因「不挂死」（功能未达成） | PASS 且**功能真实达成** |

### 已知边界（如实记录）

- 预热达成的会话 idle 5min（`idleTtlMs=300_000`）后仍会被软回收（`state=stopped`，无 lastError）——
  下次委派重建并冷启动，属**设计内**行为；K2 的目标场景是「服务重启后紧随的委派」（部署/重启窗口），
  已达成。若需覆盖「深度空闲后首调」，须再评估预热调度策略（backlog，非本轮范围）。
- A2A 冷启动停滞的宿主侧防线（有界超时 + 引导文案，D28）保留不变，双保险。

## 部署记录

- `setup.mjs --apply`（2026-09-24 12:11 完成）：BUILD→HOST→VM→VM-START→TUNNEL→TEST→QA-PROBE→HEALTH
  八相位全绿，EXIT=0（`qa/evidence/run7-deploy-v2.log`）。
- QA 探针夹具 2/2 推送 VM（`C:/WinVMBridge/dev-and-qa/probes`），部署 MANIFEST
  `MANIFEST-deploy-2026-09-24.txt`。
- 隧道：daemon 常驻（pid 18710，2026-09-24 11:17 起 RUNNING）。

## 单测与构建

- `npm run build`：0 错误。
- `npm run test:unit`：**482/482 PASS**（106 suites）。

## 结论

- **18/18 全绿**，无 FAIL、无 BLOCKED；K2 从「open issue」转「已修·已部署·真机复验」。
- 权威报告链：run6（K2 定性 + A1/A3 BLOCKED）→ **run7（K2 修复 + 全绿收口）**。

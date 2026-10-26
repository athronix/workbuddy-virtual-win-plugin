# Phase 6 · 批20 施工记录（4 项技术债修复 · 纯文档批次）

> 输入：用户「4 项技术债请修复」；团队：software-company（PM 许清楚 → 工程师 寇豆码 → QA 严过关；主理人合成/核验）
> 路由：快速模式（≤10 文件；PRD 已含实施方案与行级锚点，架构阶段不重复造）
> 结论：**四项全部闭合**（2 项 stale 销账 / 1 项诚实定性 / 1 项转观察项）；**零 src 改动**；全量 gate **GREEN 124/2179** 零漂移。

---

## 一、PM 核验结论（`docs/changes/phase6-b20-prd.md`，225 行）

| # | 技术债 | 裁定 | 一句话依据 |
|---|---|---|---|
| 债1 | GUI 点击 E2E 回归受远端锁屏限制 | **不可代码修复**（锁屏态）+ 可文档修复（周边） | 锁屏=Winlogon 安全桌面，同会话进程无法合成输入解锁；tscon 需管理员提升；全仓 session-guard/tscon 源码零实现 |
| 债2 | 深度空闲冷启动 ~49.3s | **部分可修**（PM 建议 TTL 5min→30min） | 最小变更可消除多数场景；保活有串行链排队副作用列 P2；进程级冷启动是 codebuddy CLI 外部特性不可根除 |
| 债3 | K3 兜底仍启发式 | **已根治（stale backlog，第 5 例）** | `reconcileApprovalTruth` 服务端审批账本结构化反查 + P2-T8 归属键放宽 + `WINVM_APPROVAL_TRUTH` 缺省 **on**（constants.ts:316）；文本兜底按用户裁决（SK-9）保留 |
| 债4 | bearer 误开缺乏生效自检 | **已根治（stale backlog，第 6 例）** | P2-T5（`d277882`）挂载自检五码+innerReconnect 三态+fail-closed 拒启+链上取证（45 例）；P2-T6（`e0b6945`）补齐回连凭据通路 |

**顺带核验（第 5 例陈旧文档注）**：§5.4「工具面无 sessionId 数据源」不成立——`SessionHealth.sessionId` 自契约起必填（bridge.ts:39）、VM 探针实测采集（gui.ps1:16/71）、`/health` 已透出。session-guard 未自动化的真实约束是：tscon 需管理员提升 + 锁屏态安全桌面隔离。

**PRD 关键判断（任务书指定核验项）**：D-6 的 `delegationActivity`（活动计数）与 `approvalWait`（未决审批）是不同判据，对账兜底不应改消费前者——已消费正确的结构化信号，无需改动。

## 二、用户裁定（主理人转问，2026-10-17）

- **债2 TTL：保持 5min（300_000）不变** ⇒ 冷启动定性为 TTL 回收语义的固有代价，转观察项；本批零代码变更
- 其余按 PM 建议：保活仅登记 P2 不实施；E2E 配方落 §5.4 不含 Autologon；三条 backlog 本批销账；债2 真机复测按「离线门禁 + 观察项」形态（同批18 D-5）

## 三、实施（工程师寇豆码，主理人逐 commit 核验 diff）

| commit | 文件 | 内容 |
|---|---|---|
| `b04cdef` | `docs/02-design/SECURITY-GOVERNANCE.md` | §5.4 RDP 行订正（删过期"无 sessionId 数据源"，换真实约束）+ E2E 前置人工配方 blockquote（powercfg 三项+ScreenSaveActive=0+`/health.session.state==='healthy'` 前置门）；§3.3 固化 approvalTruth 兜底命中率长期观测口径 |
| `09a4b95` | `.workbuddy/memory/MEMORY.md` | backlog 四项销账/定性（4 增 4 删；SessionHealth 行与 teams 残骸行逐字未动） |
| `6b534d6` | `docs/changes/phase6-b20-prd.md` | PRD 落档（主理人提交） |

`git diff 3d07b05..HEAD`：3 个文档文件，237 增 5 删；`packages/ tests/ dist/` 空。

## 四、验证

### 4.1 工程师自检（A4）
phase2-session-unknown **48/48**、phase2-snapshot-truth **17/17**；`grep -c "sessionId 数据源"`=0、`grep -c "才有意义"`=0；每 commit 单文件变更。IS_PASS: YES。

### 4.2 QA 独立验证（严过关，fresh eyes，IS_PASS: YES）
- **V1 零 src**：diff --name-only 恰 3 文档；constants.ts:108 仍 `300_000`；cl018 两基线逐字未动
- **V2 债1**：双 grep=0；§5.4 双锚点在场；**锚点事实抽查全部属实**（bridge.ts:39 必填 / gui.ps1:16 采集·L71 回传 / HealthStatus.session 透出 / gui.session.status=Get-SessionHealth）
- **V3 销账举证**：MEMORY 恰 4 增 4 删；K3/R4 锚点（constants.ts:316、delegation-truth.ts:251、http-guard.ts:179、d277882/e0b6945）均在册
- **V4 单测复跑**：8 份 215 例全绿（48+17+24+58+45+7+11+5）
- **V5 全量 gate**：`FILES=124 FAILED_FILES=0 TOTAL_TESTS=2179 TOTAL_FAIL=0 TOTAL_SKIP=2`、`DISK=RUN=MATCH`、`VERDICT: GREEN`（`qa/p3-batch-sweep/gate-p6-b20-final.txt`，基线零漂移）
- **V6 越界**：§3.2 策略表/§5.3 探针段/guiAllowed 相关零改动，无夹带

### 4.3 真机复验
本批零 src 改动 ⇒ 现网运行态与批19 结束时一致，**无需 deploy/重启**；债2 真机收益（深度空闲首调延迟）依赖自然空闲窗，按 PRD 登记为**观察项**（不作门禁，同批18 D-5 形态）。

## 五、观察项登记（后续批次候选）

1. **债2 保活机制评估**（P2-1）：TTL 内按比例触发 warmup 保会话跨 idle 存活；副作用未量化（串行链排队对首调延迟影响、周期 LLM 往返成本、ws 曲线）
2. **E2E preflight 门**（P2-2）：E2E 入口读 `/health.session.state`，非 healthy 早失败并输出配方指引（依赖本批 §5.4 配方）
3. **approvalTruth 兜底命中率长期观测**（§3.3 已固化口径）：链上 `decidedBy='text-fallback'` 计数；长期 >0 且集中单门再评估收敛

## 六、变更清单

| 文件 | 变更 |
|---|---|
| `docs/changes/phase6-b20-prd.md` | 新建（PM 增量 PRD，225 行） |
| `docs/02-design/SECURITY-GOVERNANCE.md` | §5.4 订正+E2E 配方；§3.3 观测口径（+8/-1） |
| `.workbuddy/memory/MEMORY.md` | backlog 四项销账/定性（4 增 4 删） |
| `qa/p3-batch-sweep/gate-p6-b20-final.txt` | 全量 gate 证据 |
| `docs/audit/2026-10-16-panorama-phase6.md` | 批19/批20 行 + N-4 收口 |

## 七、方法论留痕

1. **stale backlog 判别式再命中两例（累计 6 例）：批18 D-1/D-2、批19 T1、批20 K3/bearer。判别式**：backlog 含「待补/暂缓/先…」字样 ⇒ 高嫌疑陈旧，裁决前回仓核验现行测试钉与缺省值——本轮两项的根治均早已**缺省在网**（APPROVAL_TRUTH_DEFAULT='on'、bearer 挂载自检 45 例）。
2. **团队 SOP 在小变更上的路由**：≤10 源文件且 PRD 已含实施方案 ⇒ 快速模式（跳过独立架构文档），但 PM 核验阶段保留——本轮最大收益（2 项 stale + 1 处过期文档注）正是 PM 回仓核验产出，证明"分析阶段不能省"。
3. **文档声称须过锚点事实抽查**：QA 对 §5.4 新注的四个锚点（契约必填/探针采集//health 透出/工具名映射）逐一对源核验——文档修订的验收不仅是 grep 关键词，更是"文档说的每件事都属实"。
4. 环境注记：QA 回传时 SendMessage 因会话 teamContext 丢失被拒（环境问题），结果经 agent 通知链完整收回，未影响结论。

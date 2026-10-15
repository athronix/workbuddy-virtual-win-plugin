# WinVM Bridge · Release Notes（演进链 V1.0.0 → V1.4 · 2026-10-15）

> 本文取代 `V1.0.0-release-notes.md` 的"演进路线"职能（后者已加冻结头注留痕）。**权威口径**：里程碑链来自 git log + `docs/changes/` 各批 notes + 两份终版台账（`docs/audit/2026-10-12-full-audit.md`、`docs/audit/2026-10-14-full-audit.md`），数字均实测登记值。

## 一、能力面总览（当前实况）

- **形态**：鸿蒙宿主 WorkBuddy 插件 ⇄ Windows VM（Win11）双协议服务 `vm-service`。
- **能力**：54 条（system/app/storage/gui/appops 五域 × 读写分派），契约注册表单源，`phase2-contract-schema` 逐条形状守卫+计数钉。
- **双通道**：MCP 直调（简单任务，`/mcp`）∥ A2A 委派（复杂任务，`/a2a`，streaming 进度+input-required 审批挂起）。
- **VM 侧 Agent 选型**（`WINVM_VM_PROVIDER`）：`workbuddy-deterministic`（确定性基准）/ `workbuddy`（LLM 常驻会话，缺省）/ `hermes-agent`（MCP 预注册）。
- **治理栈**：风险分级 L0-L3 + 双闸（`allowedCapabilities` 白名单/`maxRisk` 封顶，**接线在位，执法灰度现况见 §3**）+ 审批闭环（委派通道：挂起→宿主批准→服务端留存值重放，批准即删一次性令牌+previewHash 换参拒绑）+ 哈希链审计（终态拒绝全入链：策略硬拒/审批拦截/委派收口/早退族）。
- **测试**：**116 文件 / 2103 例（2101 pass / 0 fail / 2 skip）GREEN**（`qa/p3-batch-sweep/gate-b10-final.txt`）；门禁 FULL/QUICK 双档 + 守卫基建四件套（dep-lint/config-key-lint/gate/lock-probe），「跳过门禁即未验收」（GATE-POLICY）。
- **分发**：双端一键（`setup.mjs`/`install-host`/`deploy-vm`），preflight 登录态探测、psmod/服务版本指纹、隧道守护（进程内 ssh2+指数退避+仅绑回环）、分发跟批闭环（DEPLOYMENT §1.7）。

## 二、里程碑链

| 期 | 里程碑 | 要点 |
|---|---|---|
| V1.0.0（09-10） | 1+4 架构落地 | 双通道、54 能力、provider 三选型、初版部署 |
| CL-015~021（09 下旬~10 上旬） | 生产化冲刺 | 鸿蒙适配、审批闸 UX、5域×2通道 E2E 18/18、常驻会话（PersistentCliSession+预热 K2）、缓存新鲜度/路由度量、隧道生产化、R17 审批卡原生渲染+诊断+K6 卸载状态机 |
| Phase 1（10-11~12） | 契约与内核基座 | contracts/core/a2a/vm-service 分层重铸、真取消、TaskStore 有界化、CLI 消费面 |
| Phase 2（10-12） | 治理纵深 | T1–T12 全交付；守卫基建入门禁；QA 严过关 IS_PASS=YES（92/1889）；K3 假成功根治、S-4 策略拒绝入审计 |
| Phase 3（10-13~14） | 承诺兑现（P0×4 收敛） | 批0 文档止血；批2 部署可达（DB-1..12 一键化）；批3 速赢交互；批4 M7 provider 差集/M3 预检/M6 读写分派；批5 保留期/取消风暴/孤儿门禁化；批6 深债（bearer 自检/wsProbe/schema 漂移钉）；**批1 审批闭环专项**：出路(c) `DELEGATION_REQUIRED`（纯直调 L2/L3 收口"须走委派"，根治"死令牌信任核弹"）+双闸三调用点接线+F-1/F-2/F-3 装配单源/scope 留存/判源零断崖 |
| Phase 4（10-14~15） | 再审计补课（P1×3+P2×6 销账） | 批8 分发跟批+真机 V17 指纹；批9 教学诚实化（三册假方法 `tasks/resubscribe`→真实通路、§2.6 码表补齐+**漂移钉入 ST3**、claims-guard 治理面 25→30 件）；批10 缺省形态 E2E（常驻 scope 链五象限）、F-5 合成步骤 risk 如实化、`directWithActiveTurn` 窄窗观测、llmSession 工作集读数透传、SKILL 码表双向对账。两轮 QA 独立回归 **IS_PASS=YES + 活性反证**（防装饰品守卫/侥幸绿） |

## 三、已知限制（如实，缺省态）

1. **双闸执法仍为 shadow 灰度**：`allowedCapabilities`/`maxRisk` 接线与端到端拦截用例在位（离线实锤），现网 `WINVM_POLICY_GATE_WIRING` 缺省 shadow（评估观测不执法）；`shadowHits` 观察期归稳后运维显式 on——切换 runbook 见 DEPLOYMENT「策略闸执法切换」条目。
2. **V3/V4 服务层真卸载实弹窗**：`app.winget.uninstall`/树杀 `[k6]/[q5]` 分支离线单测钉死（r3-uninstall-verify 39 例）；真卸载经交互会话服务可用（宿主 RDP 或经委派实弹），SSH 非交互会话直调 winget 属结构性不可用（MSIX alias），已在 preflight/文档显形。
3. **V14 eviction 长跑触发**未自然显形：`/health.llmSession.wsLatestMb/wsPeakMb/wsEvictions` 读数已在（10-15 真机首采 18.3MB），"超限回收"待长跑委派量自然触发或注入压测。
4. `meta.capability.list` 运行期返回**模块名**而非能力 ID 全清单（能力 ID 权威面=`tools/list`，SKILL 措辞已规避；实现对齐入 Phase 5 批14）。
5. 审批挂起完整对齐（deterministic provider 真挂起 input-required）为登记 backlog：该形态触闸面为零，现以 `suspendSupported:false` 显形诚实收口。

## 四、Phase 5 路线（价值兑现与运营期）

- **批11 外宣对齐**（本文件即交付）：RELEASE-NOTES 链 + 旧文档冻结 + 索引同步。
- **批12 shadow→on 执法切换评估**：读数标准+切换 runbook+真机切换执行+回滚位。
- **批13 真卸载验证窗**：经 a2a 委派实弹卸载→审批→重放→[k6] 核验→复原，顺带 V14 观察。
- **批14 小修族**：capability.list 名实、§1.7 宿主侧对称条目、skip 档登记。

*维护纪律：每批完赛后增改本文 §2/§3；测试基线数字只写实测（引用最新 `qa/p3-batch-sweep/gate-*.txt` 汇总行）。*

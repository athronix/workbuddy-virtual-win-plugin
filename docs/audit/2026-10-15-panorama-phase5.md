# WinVM Bridge · 项目全景综述与完善路径（Phase 5 开档 · 2026-10-15）

> 基线 HEAD `6082df9`；全量 gate **116 测试文件 / 2103 例（2101 pass / 0 fail / 2 skip=ssh2-resolve）GREEN**（`qa/p3-batch-sweep/gate-b10-final.txt`，DISK=RUN=MATCH）。
> **现网分发新鲜度：刚跟批（本日 17:4x `deploy-vm --apply` EXIT=0）**，行为指纹复验全中：`/health.policyGate` 含 `directWithActiveTurn`（批10 G3）✓；`llmSession` 工作集读数 `wsLatestMb:18.3/wsPeakMb:18.3/wsEvictions:0` **真机首次显形**（批10 G7，V14 观测面交付即生效）✓；直调 L2=`DELEGATION_REQUIRED`+retryable:false 不发令牌（批1(c)）✓；内层回归正常。
> 本轮附带处置：① 清理两支已解散团队的运行残骸（software-bugfix-s4 补删、software-cl018-closeout）；② CL-018 两项遗留**实测已落地**（`persistent-session.ts:372` ensureReady 预算纳点 / `appops.ps1:34-36` procDeny 进程名级），关闭该悬案。

---

## 一、进展综述（五阶段纵向）

| 阶段 | 时间 | 交付 | 状态 |
|---|---|---|---|
| V1.0.0 + CL-001~014 | ~09-10 | 1+4 架构、双通道（MCP 直调/A2A 委派）、54 能力、provider 三选型 | ✅ |
| CL-015~021 | 09 下旬~10 上旬 | 鸿蒙适配、审批闸 UX、常驻会话、缓存新鲜度、隧道生产化、R17 审批卡原生渲染 | ✅ |
| Phase 1（契约基座） | 10-11~12 | 契约/配置、core 执行内核、a2a 真取消、vm-service 装配、执行体消费+CLI | ✅ |
| Phase 2（治理纵深） | 10-12 | T1–T12+T3b；守卫基建四件套（dep-lint/config-key-lint/gate/lock-probe）；QA 严过关 IS_PASS=YES（92/1889 终态基线） | ✅ |
| Phase 3（承诺兑现） | 10-13~14 | 批0-6+批1 **八批全收官**：P0×4 全收敛（P0-1 审批闭环=出路(c) DELEGATION_REQUIRED+双闸三调用点接线）；真机 E2E 16/16 | ✅ |
| Phase 4（再审计补课） | 10-14~15 | 批8/9/10 全完赛：P1×3+P2×6 **全销账**；漂移钉入 ST3；缺省形态 E2E 落地；两次 QA 独立回归 IS_PASS=YES+活性反证 | ✅ |

**工程健康度**：测试基线 21→116 件/2103 例单调演进（"只进不退"K-1）；门禁 FULL/QUICK 双档+GATE-POLICY；受契约保护变更流程已跑熟（计数同步非放宽）；治理面文档收集面 30 件+双向对账机检；分发跟批闭环（DEPLOYMENT §1.7）当日即验证有效——本轮正是靠它发现"批9/10 未分发"并当场补齐。

## 二、当前问题与缺失清单（按严重度）

| # | 级别 | 维 | 项 | 现场 | 定性 |
|---|---|---|---|---|---|
| B-1 | P2 | 产品/文档 | **V1.0.0-release-notes 严重过期**（09-10）：此后 CL-015~021、Phase1-4 全部里程碑未入；对外"演进路线"口径失真 | 仓库根该文件 mtime | 唯一明显陈旧对外件，建议重写为 V1.x 交接结论+Phase5 路线 |
| B-2 | P2 | 运维/策略 | **双闸缺省 shadow，on 执法从未真机评估**：`shadowHits=0` 仅观测至今；"缺省封顶/白名单"承诺在执法意义上仍未现网生效（文档口径诚实，但价值未兑现） | `/health.policyGate.wiring=shadow` | 观察窗在途；需一个"on 切换评估"决策点 |
| B-3 | P2 | 测试/运维 | **V3/V4 真卸载窗未闭**：SSH 非交互会话 winget（MSIX alias）拒绝访问=结构性限制；服务层委派真卸载（走审批闭环）未实弹 | notes §9 登记 | 需桌面会话或经 a2a 委派+人工批准路径；破坏性待用户节奏 |
| B-4 | P2 | 实现/文档 | **`meta.capability.list` 名实窄面**：psmod `listModules` 返模块名非能力 ID 全清单（G4 已措辞规避，实现未改） | notes §9 | 后续可修小项 |
| B-5 | P2 | 测试 | **V14 长跑显形只完成半程**：ws 读数已在（18.3MB 首采 ✓），但"长跑⇒超限 eviction 路径"未自然触发（wsEvictions=0） | 现网 llmSession | 观察窗：等委派量或注入压测 |
| B-6 | P3 | 治理 | **团队残骸纪律**：`~/.workbuddy/teams` 非 winvm 域 45 个历史残骸（§7-③ 永久不动用户裁）；winvm 域本轮已清 2 支 | teams 目录 | 无需动作，留痕即可 |
| B-7 | P3 | 运维 | **宿主分发面跟批**未单列检查：本轮只跑 `deploy-vm`；宿主侧 `install-host` 是否需随批9/10 刷新未指纹核（批9/10 无宿主桥源码改动，预判无需，但 §1.7 只写了 VM 侧动作） | DEPLOYMENT §1.7 | runbook 补"宿主侧改动→install-host→连接器缓存指纹"对称条目 |
| B-8 | P3 | 测试 | 2 skip 恒 ssh2-resolve OFFLINE_SKIP：隧道解析件无在线档；可选做 CI 分层 | gate 汇总行 | 不阻塞，登记 |

**未发现新 P0/P1**（六维亲验+两轮 QA 活性反证+漂移钉机检的叠加覆盖面下，承诺面/教学面/分发面/观测面本轮全部扫过）。

## 三、建议与 Phase 5 完善路径

**定性**：项目已过"还债期"（Phase 3/4 = 承诺兑现+补课），进入**价值兑现与运营期**。Phase 5 处方从"修欠账"转向"把已建的闸用起来、把外宣赶上来"：

| 批 | 内容 | 映射 | 验收（可证伪） | 前置 |
|---|---|---|---|---|
| **批11 外宣对齐**（小批，纯文档） | 重写 `V1.0.0-release-notes.md`→`V1.x-release-notes`：里程碑链（CL-015~021/Phase1-4）+当前能力面（54 能力×3 provider×双通道+治理栈）+已知限制如实（shadow 缺省/V3V4 窗）+Phase5 路线；README/06-OVERVIEW 索引同步 | B-1 | 旧文件 mtime/口径终结于 09-10 的形态消失；claims-guard 全绿 | 无 |
| **批12 shadow→on 执法切换评估**（运维决策批） | 观察窗收口：① `shadowHits`/`directWithActiveTurn` 现网读数标准（连续 N 天 0 或低个位数=宿主声明形态健康）；② 切换 runbook（provider options 打 `agent.providers.<id>.options.policyGateWiring=on`→kill-restart→行为回验→/health 指纹）；③ 回滚位文档化；④ 切换后首周观察件 | B-2 | runbook 条目落 DEPLOYMENT/§1.7 族；如用户批准可直接执行切换+指纹 | 用户裁"是否现在要执法" |
| **批13 真卸载验证窗**（破坏性，需用户在场） | V3/V4 经**服务层委派**实弹：a2a.delegate 卸载一个可控包（建议先 inventory 选测试性质包）→ 宿主审批 reply → 服务端重放 → 回执核 `[k6] TIMED-OUT/[q5]` 分支（正常路径+预算压测路径）→ 重装复原；顺带闭 V14 eviction（长跑委派中观察 ws 读数爬升） | B-3/B-5 | 回执原文入 qa/；复原确认；V14 读数曲线或"未触发"如实登记 | 用户点头+VM 桌面会话可用 |
| **批14 小修族**（随做） | B-4 `listModules` 名实对齐（或裁"措辞规避即终态"）；B-7 §1.7 补宿主侧对称条目；B-8 可选在线档 | B-4/7/8 | 各自单点回归 | 无 |

**优先级裁决建议**：批11（外宣）与批12（执法决策）并行先做——批12 需要用户一个决策（"双闸要不要现在真执法"）；批13 需用户在场配合；批14 穿插。**若只做一件事：批12**——它是本项目安全模型"从承诺到生效"的最后一步。

---
*方法留痕：本轮=主理人亲验（六维抽查+CL-018 悬案核验+现网分发/指纹）+既有三台账（2026-10-12-full-audit / 2026-10-14-full-audit / 各批 notes）交叉；未再派审计棒（历史波状 429 教训+覆盖面已足）。*

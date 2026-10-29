# WinVM Bridge · Release Notes（演进链 V1.0.0 → V1.4.0 → V1.4.2 → V1.4.3 → V1.4.4 → V1.4.5 → V1.4.6 · 2026-10-29 同步）

> 本文取代 `V1.0.0-release-notes.md` 的"演进路线"职能（后者已加冻结头注留痕）。**权威口径**：里程碑链来自 git log + `docs/archive/changes/` 各批 notes + 两份终版台账（`docs/archive/audit/2026-10-12-full-audit.md`、`docs/archive/audit/2026-10-14-full-audit.md`），数字均实测登记值。

## 一、能力面总览（当前实况）

- **形态**：鸿蒙宿主 WorkBuddy 插件 ⇄ Windows VM（Win11）双协议服务 `vm-service`。
- **能力**：54 条（system/app/storage/gui/appops 五域 × 读写分派），契约注册表单源，`phase2-contract-schema` 逐条形状守卫+计数钉。
- **双通道**：MCP 直调（简单任务，`/mcp`）∥ A2A 委派（复杂任务，`/a2a`，streaming 进度+input-required 审批挂起）。
- **VM 侧 Agent 选型**（`WINVM_VM_PROVIDER`）：`workbuddy-deterministic`（确定性基准）/ `workbuddy`（LLM 常驻会话，缺省）/ `hermes-agent`（MCP 预注册）。
- **治理栈**：风险分级 L0-L3 + 双闸（`allowedCapabilities` 白名单/`maxRisk` 封顶，**接线在位，执法灰度现况见 §3**）+ 审批闭环（委派通道：挂起→宿主批准→服务端留存值重放，批准即删一次性令牌+previewHash 换参拒绑）+ 哈希链审计（终态拒绝全入链：策略硬拒/审批拦截/委派收口/早退族）。
- **测试**：基线**以 `qa/` 最新 `gate-*.txt` 汇总行为准**（当前 2280 例：`qa/p3-batch-sweep/gate-docs-overview.txt`，128 文件 / 0 fail / 2 skip GREEN，2026-10-23；历史演进 2193→2265（V1.4.1 批）→2280（V1.4.2 批）逐档刷新，本文不静态维护数字，口径与 README §8 一致）；门禁 FULL/QUICK 双档 + 守卫基建四件套（dep-lint/config-key-lint/gate/lock-probe），「跳过门禁即未验收」（GATE-POLICY）。
- **分发**：双端一键（`setup.mjs`/`install-host`/`deploy-vm`），preflight 登录态探测、psmod/服务版本指纹、隧道守护（进程内 ssh2+指数退避+仅绑回环）、分发跟批闭环（DEPLOYMENT §1.7）。
- **发布工程（V1.4.0 新增）**：`release/V1.4.0/{host,vm,overall}` 三包一键部署（`delivery/pack-release.mjs` 构建，逐文件 sha256 MANIFEST + 包内 V1-V4 验证 + `--skip-build`）；发布问题按「版本→迭代」记 `docs/release/ISSUES.md`。

## 二、里程碑链

| 期 | 里程碑 | 要点 |
|---|---|---|
| V1.0.0（09-10） | 1+4 架构落地 | 双通道、54 能力、provider 三选型、初版部署 |
| CL-015~021（09 下旬~10 上旬） | 生产化冲刺 | 鸿蒙适配、审批闸 UX、5域×2通道 E2E 18/18、常驻会话（PersistentCliSession+预热 K2）、缓存新鲜度/路由度量、隧道生产化、R17 审批卡原生渲染+诊断+K6 卸载状态机 |
| Phase 1（10-11~12） | 契约与内核基座 | contracts/core/a2a/vm-service 分层重铸、真取消、TaskStore 有界化、CLI 消费面 |
| Phase 2（10-12） | 治理纵深 | T1–T12 全交付；守卫基建入门禁；QA 严过关 IS_PASS=YES（92/1889）；K3 假成功根治、S-4 策略拒绝入审计 |
| Phase 3（10-13~14） | 承诺兑现（P0×4 收敛） | 批0 文档止血；批2 部署可达（DB-1..12 一键化）；批3 速赢交互；批4 M7 provider 差集/M3 预检/M6 读写分派；批5 保留期/取消风暴/孤儿门禁化；批6 深债（bearer 自检/wsProbe/schema 漂移钉）；**批1 审批闭环专项**：出路(c) `DELEGATION_REQUIRED`（纯直调 L2/L3 收口"须走委派"，根治"死令牌信任核弹"）+双闸三调用点接线+F-1/F-2/F-3 装配单源/scope 留存/判源零断崖 |
| Phase 4（10-14~15） | 再审计补课（P1×3+P2×6 销账） | 批8 分发跟批+真机 V17 指纹；批9 教学诚实化（三册假方法 `tasks/resubscribe`→真实通路、§2.6 码表补齐+**漂移钉入 ST3**、claims-guard 治理面 25→30 件）；批10 缺省形态 E2E（常驻 scope 链五象限）、F-5 合成步骤 risk 如实化、`directWithActiveTurn` 窄窗观测、llmSession 工作集读数透传、SKILL 码表双向对账。两轮 QA 独立回归 **IS_PASS=YES + 活性反证**（防装饰品守卫/侥幸绿） |
| Phase 5（10-15~16） | C0 转呈面专项 + 残项 | 批11~14 完赛；C0：`foldK6Verdict` 把 `data.success===false` 折叠为诚实失败终态（呈报回执/重放转呈/环形缓存/链条目四点同源），假成功压平面离线钉死 + 三组变异反证；批14 执法通道化（`--policy-gate-wiring`） |
| Phase 6（10-16~18） | 全景再审计 + 决策族 + 技术债 + **V1.4.0 发布** | 批15 宿主跟批闭合；批16 V20 观察窗（暴露 N-5 实弹级委派呈报失真）；批17 决策族 7 项用户全裁；批18 **D-6 根治**（`DelegationTruthProbe.delegationActivity` 降级抑制，V20 达成、链上 err `UNKNOWN_CAPABILITY`→`REPLAY_FAILED`）+ D-5 就绪超时 60s→180s + D-7 matchedRule 订正；批19 SessionHealth 语义边界文档注明（销账模式）；批20 四项技术债闭合（2 项 stale 销账 / GUI 锁屏诚实定性 / 冷启动用户裁保持 5min 转观察项）；**REL-V1.4.0**：tag V1.4.0（SHA 见 `git rev-list -n1 V1.4.0`） + `release/V1.4.0/{host,vm,overall}` 三包 + 清空历史部署真机重装 + 完整功能验证（54 能力/双通道/审计链）全过（`docs/release/ISSUES.md` 迭代1 关闭） |
| V1.4.0 迭代2~4（10-18~19） | 发布工程加固 + GitHub Release 上架 | 迭代2 OBS-1 TUNNEL 相位判据收紧；迭代3 清场强化（uninstall 前先查杀 VM 端看门狗与 services）；迭代4 发布包上 GitHub Release（仓库转 public、匿名下载、双资产 zip+sha256 旁挂三方一致回环实测）+ **I-4.1 安全缺陷根治**（zip 卷入真机 `.env`/shim 而双道校验检不出多余文件 ⇒ `pack-release.mjs` 增「zip 条目集 ⊆ MANIFEST ∪ {MANIFEST.txt}」fail-loud 纯净断言）+ I-4.2/I-4.3 上架真网络 bug（upload URL RFC6570 模板剥离、Content-Type 头合并反压）即修即验（`docs/release/ISSUES.md` 迭代4） |
| V1.4.1（10-20） | CL-026 审批卡强制呈现闭环 | 病灶=出卡全凭 agent 自由发挥、R17 两段式契约缺触发面。`tools.ts` 权威串 `APPROVAL_PRESENTATION_DIRECTIVE` 五携带面（delegate 早退 / `approval.presentationDirective` 纯附加幂等字段 / `task.get` 挂起观测 / delegate+reply 双 description 闭合）；SKILL.md 审批协议升 MUST ①-④（show_widget 七槽位 → AskUserQuestion 批准/拒绝/暂不 → 禁止纯文本转呈代批 → reply+task.get 至终态）；守卫 31 例 + ST3 升格双写；tag SHA 见 `git rev-list -n1 V1.4.1`，证据 `docs/design/cl026-approval-presentation.md` + `qa/release/V1.4.1-pack.txt`（V1-V4 全过），全量 gate 127 文件/2265 例 GREEN |
| V1.4.2（10-21） | CL-026b 真机挂起路径根治 + run5 清场实录 | 主理人真机实测暴露 mock 盲区：VM 侧挂起 `input-required` 即掐 SSE，桥 for-await 抛 undici terminated 落 catch 分支返回纯 error 形态无 directive（CL-026 五携带面全在 approval 正分支，真机走不到）。修复=catch 双条件短路挂起收口（isError:false/无 error 字段/三面 directive/留痕 pending）+ 单源化 `suspendSummaryText`/`buildApprovalCarriers` 三面逐字同源守卫钉全等 + 行为级守卫 15 例（terminated mock stream 驱动整条 delegate）；全量 gate 128/2280 GREEN。发布侧 run5 清场插曲 I-5.1（空目录骨架被 VM 活 cwd 顶住，fail-loud 正确中止）+ run5b 七相位全过；tag SHA 见 `git rev-list -n1 V1.4.2`，证据 `docs/release/ISSUES.md` 迭代5 + `qa/release/V1.4.2-pack.txt` / `V1.4.2-deploy-run5.log`。**V1.4.1/V1.4.2 均已上架 GitHub Release（双资产匿名回环 SIDECAR/PACK 双匹配）** |
| V1.4.3（10-26） | 发布链缺口收编 G-1/G-2/G-3 + V5 防回归断言 | **G-1**：P2-3/P2-4 修复（NON_ACCOUNT_DIRS 非账户目录排除）随 a63146b 入包，终结「V1.4.2 包早于修复→Release 安装回归污染」；打包机新增 V5 硬断言（host+overall 包内 install-host 必含 NON_ACCOUNT_DIRS≥3，fail-loud）。**G-2**：`delivery/verify-release.mjs`（MANIFEST 消费端 Node 版，与 verify-manifest.py 四判据逐字一致+V5）入包，Step 2 第三层校验纯 Release 可跑。**G-3**：`qa/deploy-probes/` 六探针+`delivery/tools/diagnose-connectors.mjs`（install-host 自检硬依赖）入 overall 包（876 文件/2,764,412 B）。tag V1.4.3 上架；回环三向对账（远端旁挂=本地旁挂=下载实算 2e1de077…）；github.com 直连不稳时切 api.github.com asset 端点。清场重装 run2 七相位 164s + **25/25** + example-probe 8/8 + 非账户零污染 + 连接器 8 skill（hos-win 随包，G-1 连带症状消失）。详见 `docs/release/ISSUES.md` 迭代6、`qa/release/V1.4.3-pack.txt` |
| V1.4.4（10-27） | I-6.1 键鼠真 bug 入包 + V6 发布链盲区断言 | **I-6.1 闭环**：`psmod/gui.ps1` 两处 `Marshal::SizeOf([Type])` 静态重载在 PS5.1 对运行时结构必抛「不能封送」→ 键鼠输入自上线从未真跑通；实例重载 `SizeOf($arr[0])` + 防回归钉 example-probe E11；`pack-release.mjs` 新增 **V6 硬断言**（包内 gui.ps1 必含 `cbSize`，发布链「修复晚于打包」盲区机械化封堵）。tag V1.4.4（2789957，基于 2671f0f）上架；回环三向对账 `03cef597…`（2,768,597 B）；清场重装 `--wipe` 七相位 2m6s + **25/25** + example-probe **13/13** + VM 侧 gui.ps1 含 cbSize + 非账户零污染 + 连接器 8 skill。详见 `docs/release/ISSUES.md` 迭代7、`qa/release/V1.4.4-pack.txt` |
| V1.4.5（10-28） | I-6.3 卸载对称修复入包 + Prompt 总集入发布包 + V7 断言 | **I-6.3 闭环**：undeploy⇄deploy 回环（10-27 run1，`qa/real-test-2026-10-27-run1.md`）经 U4 独立复核抓出 `uninstall.mjs` 两处镜像不对称（全局 `~/.workbuddy/mcp.json` winvm 键不清 / `tunnel-autostart.json` 残留）→ HEAD 修复（cleanGlobalMcpJson+markers 补名，核验清单 17→19）；本迭代打包 **V7 硬断言**当场核验入包（V1-V7 全绿）。**打包面收编**：OVERALL_DOCS 增 `docs/deploy/` 三篇（部署策略+部署 Prompt+卸载 Prompt 总集，PACKAGE_REQUIRED 存在性断言）——纯 Release 装机者零仓库依赖。tag V1.4.5（76c0c65；首打包早于 docs 同步=superseded-it1 重打，教训「pack 前文档先 commit」入册）；回环三向对账 `a225cc95…`（2,833,330 B）；包内 uninstall 实弹拆除 **19/19** + 重装七相位 rc=0 + **25/25** + example **13/13** + disabledTools=8 + 连接器 8 skill + VM gui.ps1 cbSize×4。详见 `docs/release/ISSUES.md` 迭代8、`qa/release/V1.4.5-pack.txt` |
| V1.4.6（10-29） | 纯 Prompt 一键脚本入包分发（deploy.prompt / undeploy.prompt） | **打包面收编第二弹**：用户裁定两 `.prompt`（总集 §3 的独立可粘贴版+运行期注入变量段）并入 `OVERALL_DOCS`+`PACKAGE_REQUIRED` 断言；仓库 README 新增 §5.4「用 .prompt 一键安装/卸载」（变量配置含义/DRY-RUN 安全阀/存留项逐项问），包 README 生成面加「快速部署/卸载」四步——纯 Release 装机者解包即得整段粘贴的安装/卸载脚本。运行码与 V1.4.5 同（纯打包面变更）。打包 @71cda55（先 commit 后 pack，时序教训沿用），V1–V7 全绿；tag V1.4.6@71cda55；zip `dc417bf2…c4d468`（2,846,225 B）三元组 `881/7606427/2562a598…`；匿名回环三向一致+解包 `docs/deploy/` 五件核验；清场重装=包内 uninstall 实弹 **19/19**+独立复核零残留（000/GLOBAL_MCP_CLEAN）→ setup 七相位 rc=0 → mcp 20/20 + a2a 5/5 + example 13/13（**38/38**）+ FRESH + disabledTools=8 + 连接器 8 skill + VM cbSize×4。详见 `docs/release/ISSUES.md` 迭代9、`qa/release/V1.4.6-pack.txt` |

## 三、已知限制（如实，2026-10-15 批11~14 后态）

1. ~~双闸执法仍为 shadow~~ **已转 on（批12/14）**：现网 `policyGate.wiring=on` 三查回验全中；声明式持久=宿主 `.env` `WINVM_POLICY_GATE_WIRING`（批14 通道化，跨部署不丢）；回滚=清键重部署。执法实弹样本 V18 已由批13 委派链自然覆盖（replay `allow:policy-passed` 在链）；`shadowHits>0` 的"声明即自缚"形态样本仍未自然出现（离线 p3-b1/E2E 已实锤拦阻行为）。
2. ~~V3/V4 服务层真卸载未实弹~~ **批13 已实弹 ✅**：审批闭环端到端真机实锤（挂起→批准→replay 24.9s 真实执行→复原零遗留）。**残余**：超时树杀 `[k6] TIMED-OUT/[q5]` 孤儿分支未自然触发（保留在册）；**V19 新观察**：portable 包卸载回执 `ok=true` 但 inventory 短暂残留（K6 核验矛盾面），后续专项定性——SSH 非交互会话直调 winget 属结构性不可用（MSIX alias）不变。**V19 定性收口（C0 立案）→ 仓库面已根治（Phase 5 C0 批，`foldK6Verdict` 折叠在服：呈报回执/重放转呈/环形缓存/链条目四点同源消费 `data.success`，假成功压平面离线钉死）**；真机复验随主理人窗。
3. ~~V14 长跑 eviction 未显形~~ **读数已在（批10 G7+批13 真机验证）**：`wsLatestMb/wsPeakMb/wsEvictions` 现网在册（峰值 18.5MB）；**残余**=超限 eviction 回收路径（`wsEvictions>0`）未自然触发，属长跑量问题非观测缺失。
4. ~~`meta.capability.list` 运行期返回**模块名**而非能力 ID 全清单~~ **名实对齐已修（Phase 5 残项 R1·方案A，仓库面）**：provider 照 D5 healthCheck 先例 Node 侧拦截（`__meta.capabilityList`，注册表 ∩ declareCapabilities 直供 `{capabilities:[{id,name,risk}],count,domains}`，与 `tools/list` 同源一致）；ps-bridge `listModules` 分支保留为内部诊断面。**现网生效随下次 deploy-vm + 服务重启**（psmod 外 Node 面，同样受部署节奏约束）。
5. 审批挂起完整对齐（deterministic provider 真挂起 input-required）为登记 backlog：该形态触闸面为零，现以 `suspendSupported:false` 显形诚实收口。
6. **`directWithActiveTurn`（(c) 并发窄窗）已有实况样本**：批13 实弹期计数=2（观测面按设计显形；方向 fail-safe 无放行放宽，限定句见 SECURITY-GOVERNANCE §2.3）。

## 四、Phase 5 路线（价值兑现与运营期）——批11~14 全部完赛（2026-10-15）

- **批11 外宣对齐** ✅：本文件 + 旧 `V1.0.0-release-notes` 冻结头注 + README §10 索引五补行。
- **批12 shadow→on 执法切换** ✅：现网 `policyGate.wiring=on` 三查回验全中（`qa/p5-batch/b12-wiring-on-evidence.md`）；真机证伪两条 runbook 修正回写 §1.8（赋值区插入位置硬约束 / ssh schtasks 拖通道改健康轮询）。
- **批13 服务层真卸载验证窗** ✅：审批闭环端到端真机实锤——LLM 常驻委派挂起 `input-required` → `message/send` 批准 → 链 seq26 `replay approvedBy=host + allow:policy-passed + 24.9s 真实执行` → 复原 ripgrep 在位零遗留（`qa/p5-batch/b13/VERDICT.md`）。超时树杀 `[k6] TIMED-OUT/[q5]` 分支仍未自然触发（保留在册）。**V14 读数真机显形 ✅**（wsLatestMb/wsPeakMb 在 /health）。新观察 **V19** 登记：portable 包"卸载 ok=true 但 inventory 残留"矛盾面，后续专项定性（不冒判）。
- **批14 执法通道化** ✅：`--policy-gate-wiring off|shadow|on`（install-vm 白名单校验+bearer 同款赋值区注入+幂等）/ `.env WINVM_POLICY_GATE_WIRING` → deploy-vm 自动透传 / dry-run 计划显式打印；测试 p5-b14 6 例+devqa +3 例，GOLDEN 逐字节护栏未破；§1.8 首选路径改通道化。skip 档/`capability.list` 名实窄面维持登记（非阻塞）。

**执法态现为 on（声明式持久，经批14 通道）**；回滚位=`.env` 清键重部署（§1.8 第 3 步）。运维纪律：任何 `deploy-vm --apply` 后按 §1.7 指纹复验，`.env` 的 wiring 键值即执法真值。

*维护纪律：每批完赛后增改本文 §2/§3；测试基线数字只写实测（引用最新 `qa/p3-batch-sweep/gate-*.txt` 汇总行）。*

# WinVM Bridge 全维度体检 · 综合评估与完善路径（2026-10-08）

> 主理人：齐活林（交付总监）｜方法：四专业域并行只读审计 + 主理人逐项源码级独立核验 + 冲突裁定。
> 分报告（均含文件:行号证据，本综合报告不重复细节，只做合并、定级、排程）：
> - 产品：`2026-10-08-product-audit.md`（PM-01…22：4P0/9P1/9P2）
> - 架构：`2026-10-08-architecture-audit.md`（ARCH-01…33 + 债务 D-1…12：1P0/15P1/17P2）
> - 实现+运维：`2026-10-08-implementation-ops-audit.md`（ENG/PSM/DEP/OPS 共 50 条：0P0/18P1/32P2）
> - 测试+文档：`2026-10-08-test-docs-audit.md`（盲区 4P0/4P1/3P2 + backlog 核实 10 + 未登记裸奔 11）

---

## 1. 执行摘要

**总体判断：骨架优秀、内核真实、但"承诺超前于兑现"。**

1. **真材实料的部分**（多域独立证实，不是自吹）：双通道"同一内核"是**物理共用**（MCP 与 A2A 内层汇聚同一 `executeCapability`，server.ts:583）；单向依赖铁律 0 反向 import；1054/1054 基线**抽验无虚报**、构建新鲜；审批闸 K4/K5、ps-bridge 自愈、TaskStore TTL 等关键位置防御式设计成熟。团队有把最难安全语义啃到底的纪律（K3/S-4/K-N1 修复史）。
2. **系统性短板**：**安全边界类承诺的兑现率显著低于执行链**——dryRun 旁路、路径 `..` 穿越、服务端零鉴权、审计链重启重置、快照/previewHash/命令白名单/审批三态"写了没接"。根因不是能力问题，而是**没有任何机器门禁**：dep-lint 不存在、契约字段无消费检查、文档与注册表无对账——全靠人肉纪律（架构报告 §7.2 的四条根因归纳成立）。
3. **口径发现**：测试基线实际为 **60 个 `.test.js`**（此前文档写 59）；`.mjs` 70 例、delivery 8 例、e2e 17 例**从来不在 1054 口径内**；`npm run test:unit` 是文档四处明令禁止的整批 glob；e2e 在本机 1 fail（pwsh ENOENT 无守卫）。

**合并去重后定级：P0×5、P1×24（估）、P2×60+（估）。** 四条 P0 有跨域互证或主理人复现背书（见 §2）。

## 2. 合并 P0 台账（含冲突裁定）

| ID | 问题 | 来源 | 主理人核验 | 定级裁定 |
|---|---|---|---|---|
| **U-P0-1** | **策略引擎不消解 `..`**：`normalizePath`（engine.ts:151-159）不解析相对段，黑白名单纯字符串 glob → `C:\Users\a\..\..\Windows\System32\x.dll` 同时绕过黑名单与白名单 | ENG-24 | ✅ **我以 dist 引擎独立复现**：穿越串原样透传；工程师 7 例 evaluate 复现表含 ALLOW | **P0（置顶）**。工程师原报 P1，我上调：这是策略层的直接绕过面，修复成本 S |
| **U-P0-2** | **审计链基线随重启重置**：`freshChainOnStart:true`（server.ts:379），历史分片永久退出校验面 → 重启前记录被篡改/整段删除不可检出，"任一改动即校验失败"实际只覆盖本轮进程 | ARCH-06 = OPS-02 | ✅ 源码证实（server.ts:377-382 + chain.ts:312-313，注释自陈权衡） | **P0**。取证承诺实质失效，且权衡未登记于 SECURITY 文档 |
| **U-P0-3** | **dryRun 免审批旁路**：`engine.ts:597-600` 仅凭调用方自报 `params.dryRun===true` 即放行 L2/L3；5/8 未声明 dryRun 的能力可塞入并通过 policy 层，现防线是"D24 参数校验恰好排在 policy 之后"这一顺序巧合 + PS 侧人工纪律，**零断言零测试** | QA-P0-1 = ARCH-02 | ✅ 源码证实；架构逐层取证后今日无可利用路径，**降 P1（高）** | **折中裁定：P1（高）但并入 Phase 0 修复**——与红线文本（SECURITY §3.4:103）直接冲突，成本 S，没有推迟的理由 |
| **U-P0-4** | **已修复项无回归护栏 + 最大静默面零映射测试**：`r19c-s4-*` 直调函数而不断言 server.ts:605/837 仍调用它（重构删注入点 1054 照样全绿）；注册表↔psmod 54 条映射无回归（psmod 90 函数仅 34 被测试名字触达） | QA-P0-2/3 | ✅ `git grep dry-run-bypass tests/`=0 证实；QA 报告 8 节完整 | **P0**（治理性：它决定其余一切修复的可持续性）。~70 行测试可关 |
| **U-P0-5** | **幽灵能力与名实不符面向用户**：7 条文档在册/注册表不存在的能力（含 `gui.browser.control` 为 SCENARIOS 场景 C/E 门面主能力、**两个已部署 Skill 仍在教用户调用**）；`gui.clipboard.manage` 等"名义可写实际只读" | PM-03/04 | ✅ definitions.ts 全读零命中、文档/Skill 确在引用；剪贴板抽查证实（definitions.ts:309 绑 `Get-ClipboardText`、全仓无 Set 实现） | **P0**。用户当下就会踩；但**修复是文档口径+补挂载**，属止血批非大改 |

**次高优先（P1 高，值得点名）**：ARCH-22 `tasks/cancel` 外观性取消（`cancelRequested` 全仓零读取，取消后继续执行完、宿主 UI 却显示"未执行任何变更"——真机可复现的用户信任事故）；ARCH-05 审批拒绝/超时/取消三态不入链；ARCH-18 命令白名单整体失效（`cmdAllowRe` 编译后零消费，✅我证实）；ARCH-17 默认路径白名单实为 `C:\Users\**` 全员目录（✅defaults.ts:54-60 证实）；ARCH-07/PM-02/ENG-05/23 服务端零鉴权四域互证（回环+隧道部署形态下受控，但 `requireLoopbackBind` 可关即裸 HTTP）；PM-01/ARCH-04 快照纯元数据；ARCH-09 previewHash 恒空。

## 3. 六维评分（10 分制，体检裁定）

| 维度 | 分 | 一句话判词 |
|---|---|---|
| 产品功能 | 7 | 三域真场景（巡检/卸载/生产）扎实可交付；广度口径超前（幽灵能力、静默缩水），"54"的宣传面需要管理 |
| 技术方案 | 8 | 双通道/同内核/SPI/分层解耦设计成熟且**经证实落地**；短板在安全边界设计未闭环（三态审计、dry-run 语义） |
| 技术实现 | 7.5 | 防御式设计高于平均水位（16/16 --check、K3/S-4 注释取证文化）；扣分项是资源有界化（ENG-01/08）、ps-bridge 监听器卫生（ENG-02/03）、路径归一（U-P0-1） |
| 部署运维 | 6.5 | 七阶段一键+幂等+回收站可恢复是亮点；无告警出口（OPS-01）、无版本核验/回滚入口（OPS-07）、卸载路径部署根不一致（OPS-10）、WINVM_NODE 逃生门未接电（OPS-11）——"运维完备性"是六维中最薄面 |
| 测试验证 | 7 | 数字诚实、纪律真实；但口径滞后（60≠59、mjs/e2e 在外）、装配点守卫缺失、新人一键复现必红（test:unit 违禁 glob + e2e 无 pwsh 守卫） |
| 文档规范 | 7 | 六索引无造假；但 changed-log 漏记 S-4 代码修复（DDD 回路 10-08 断了一次）、HANDOVER 三处 214/214 会被照做、Skill 计数 6/7 三处残留、`changing-log.md:4-9` 与 README"已闭环"口径互斥 |

## 4. 完善路径（五阶段，含验收门禁）

**Phase 0 · 止血（≤1 天，零产品风险，多数为纯测试/小改动）**
- P0-1 修 `normalizePath`：用 `path.win32.resolve` 语义消解 `.`/`..`/大小写，黑白名单先归一后匹配；负向单测（穿越串打 `storage.file.manage`/`appops.cli.invoke` → DENY）——**变异验证证明会红**。
- P0-3 dry-run bypass 收紧（采纳架构 A1：`CapabilityDefinition.supportsDryRun` 显式声明 + 引擎双条件 + 链上 `ext.bypass='dry-run'`）；SECURITY §3.4 措辞同步。
- P0-4 QA-R1 psmod-contract.test.js（~30 行）+ R2 S-4/A5 装配点源码守卫（~40 行）。
- P0-5 PM-NP-03 文档口径止血：7 幽灵能力从 CAPABILITY-MODEL/SCENARIOS/两 Skill 摘除或标 V2；剪贴板等 6 条改"只读"口径；4 条已实现未挂载函数补注册。
- QA-R3 package.json 三脚本修复 + R4 changed-log 补 S-4 条目、勾掉 changing-log/README 互斥项、project-dev-status Skills(6)→7。
- 验收：1054 基线全绿 + 新增守卫全绿 + `npm run test:unit` 在新机可安全执行。

**Phase 1 · 安全边界兑现批（2~3 天 + 一轮真机）**
- ARCH-06 A2：`/health.audit` 透出 `chain.scope/shardsVerified/shardsTotal` + 启动归档校验单独落条目（最小止血即可把 P0 转"可见事实"）；根治（历史重算后关开关）另立项。
- ARCH-22 真取消：`cancelRequested` 接入 runner 循环 + aborted 终态审计 + 宿主 UI 语义对齐；ARCH-05 审批三态落链（`recordApprovalDecisionAudit`，复用 delegationObserver 注入面）。
- ARCH-07/D-10：服务端 bearer 校验（消费 `tokenEnv`）或将 `requireLoopbackBind` 设为不可关 + SECURITY §2 明写信任边界；ARCH-17/18 白名单收紧（`C:\Users\<vmuser>\**` + cmdAllowRe 实现或删除，owner 二选一）。
- ENG-01~08 批次 A（有界化：pendingApprovals TTL/TaskStore 上限/ps-bridge 监听器清理/child error/HTTP 护栏）。
- 真机轮 R15：**A5 修复后未真机复验**（唯一"修了没证实"高危项）+ 以上安全批一次真机验收。⚠ 顺序纪律：psmod 改动须落在构建指纹（R1'，见 Phase 2）之后，否则真机不可归因。

**Phase 2 · 治理门禁批（1~2 天）——防止欠账再生的机制**
- 补 `scripts/dep-lint.mjs`（≤80 行）并入 build/verify；契约字段消费计数 lint（D-3 死字段群防复发）；注册表↔文档↔Skill 一致性门禁（PM-NP-02）；测试口径派生化（tests/MANIFEST.md + 计数脚本，R10）。
- e2e pwsh 守卫（R5）+ 基线口径重述为"60 js / 8 mjs / e2e 分环境"。

**Phase 3 · 卖点兑现批（V1.1）**
- PM-NP-01 快照执行器最小实现（L2/L3 前后截图+变更清单入 artifacts）或正式改口径登记 V2；ARCH-09 previewHash 服务端计算+比对；NP-06 审计查询能力（把"最可监管"变成用户看得见）。

**Phase 4 · 运维完备批**
- OPS-01 告警出口（最简：/health 差分 + 宿主侧轮询提示）；OPS-07/10/11 版本指纹端点 + deployDir 持久化 + WINVM_NODE 接电；R2' `.generated` 配置声明式（三段顺序铁律的门禁化）；R13 owner 授权清 `.tmp` 跟踪。

**Phase 5 · 功能广度（明确**排在 Phase 2 门禁建立之后**）
- NP-04 浏览器能力、NP-08 素材通道、NP-05 更新管理；多 VM 预留（D-7 有界化+taskId 显式化）作为 V2 架构议题单独立项。
- **产品建议（PM）**：门禁建立前不扩大"54"数字；对外口径阶段性收敛为"巡检/卸载/生产三类场景完全可操作，其余高频运维逐步开放"。

## 5. 裁定与待 owner 确认项

1. U-P0-1 定级上调（P1→P0）与 U-P0-3 折中（P1高但 Phase 0 修）由主理人裁定，依据见 §2 核验列。
2. 需 owner 拍板：① dry-run 修复走 A1 方案（推荐）；② ARCH-18 命令白名单"实现 vs 删除"二选一；③ R13 涉 `git rm --cached` 仓库卫生授权；④ Phase 1 真机轮时间窗（VM 需可达 + 交互式会话）。
3. 本次体检**零源码改动**；四域报告与本报告为全部产出。

*附：本次核验方法记录——主理人对 ARCH-06/17/18/20、QA-P0-1/4、PM-01/03/04、ENG-24（含 dist 引擎独立复现）共 11 项关键结论做了源码/实测二次证实，全部成立；未发现成员虚报。成员纪律核查：git status 证实四成员除各自报告外零越界改动。*

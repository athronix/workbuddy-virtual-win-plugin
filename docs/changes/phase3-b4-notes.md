# Phase 3 批4 · 生产生态 施工记录（主理人亲自实现）

> 范围=audit 终版 §6 批4 行：M6 挂载写侧 + M3 生产就绪包 3a + M7 provider 差集显形（+A2-16 hermes SPI 根因）+ USER-MANUAL。
> 本批执行策略经主理人判断收窄：**先做离线可验证的 M7，M3/M6 因涉运行期 PS 参数绑定/新写侧 capability 动 54 硬钉，转"设计+真机清单"不盲目改**（与批2 psmod 生效窗口一并真机验证）。

## M7 · provider 能力差集显形（已落地 2026-10-13，离线可验证）

### 病灶（PM §3 / audit §3.2 M7 / A2-16）
hermes-agent 与 workbuddy-llm **同为 `kind='llm-agent'`**，但 SPI 实现面差很远：
- workbuddy-llm 实现 `warmup()`（K2 预热）、`llmSessionHealth()`（CL-018 C1 常驻会话）、`health()` 回报 `approvalTruth` 三元组（CL-K3R 真值层）；
- hermes 三皆无（mcp-registrar 机制在但未接审批重放/真值反查/常驻会话）。
若按 kind 硬分判能力 ⇒ 正是 PM §3 要消灭的「用户以为安全特性跟 provider kind 走」的**静默降级**（P1 建议按 P0 排期讨论）。

### 三面处方（deploy 预告 + 运行实况 + 决策指引，同源一致）
1. **运行实况 = `/health.capabilitiesProfile`**：抽 `packages/vm-service/src/capabilities-profile.ts` 纯函数 `deriveCapabilitiesProfile(provider, providerApprovalTruth)`——三键**派生自 SPI 可选成员的方法存在性**（`typeof === 'function'` 严判，非按 kind 猜、非触 health()）：`persistentSession←llmSessionHealth?`、`warmup←warmup?`、`approvalTruth←已算好的 providerHealth.approvalTruth ?? null`。**零新增 SPI 成员**（provider SPI 零改动红线不破）。provider 未加载（degraded）⇒ 整块缺席该键（"缺席即旧行为"，同 providerApprovalTruth 条件展开）。buildHealth 返回类型附 `capabilitiesProfile?:` 满足契约扩展。
2. **装机预告 = install-vm 降级横幅**：deploy 期 provider 未起，按已知三档**静态画像常量**（PROFILE 表）预告差异；与运行时自省互补（装机前告知 vs 运行实况）。命中"非全特性"provider 才打印，含指向 `/health.capabilitiesProfile` 的实况入口。
3. **决策指引 = orchestrator SKILL provider 子集对照表**：三档 × 三特性矩阵 + "切非全特性 provider 处理 L2/L3 勿假设批准即续跑/真值可反查"话术。新增的 `capabilitiesProfile` 是**无点名单词**，不落在 skill-claims 守卫 a 判据的 `[a-z]+\.[a-z]+\.[a-z]+` 三段式点分 token 扫描面内 ⇒ 不触幻觉能力判据；亦无 `__approvalId`/`hostApproved` 承诺词 ⇒ 不触 b/c 回潮判据（守卫 11/11 实测绿）。

### 判别性测试 `phase3-b4-capabilities-profile.test.js` 6 例
决定性例：hermes mock（kind 同 llm-agent、SPI 成员缺席）⇒ `persistentSession/warmup=false、approvalTruth=null`，且 `assert.notDeepEqual(hermes, llm)`——**kind 相同画像必须不同**=派生正确、按 kind 硬分错误。另含：三 SPI 齐全 true、deterministic 全 false/null、逐成员独立判（warmup 在场不代表 llmSession 在场）、三元组透传不加工、非函数值 typeof 严判防 truthy 假阳。

### 验证
`tsc -b` RC=0；新测 6/6 绿；批0 skill-claims 守卫 11/11 绿（SKILL 新增零回潮）；install-vm 相关回归 4 件全绿（task 8/admin-endpoint 12/deploy-shared-skills 8/enabled-plugins 9）；gate quick VERDICT GREEN。

## M3 · 生产就绪包 3a（转设计+真机清单，不盲改）
- 现状亲验：`adapter-agent-workbuddy/src/index.ts:666` 硬编码 `workflow:'generic_production'`；`appops.ps1:384` 无该工作流实体 ⇒ 默认形态生产路 WORKFLOW_NOT_FOUND（**仅模板 5 命中预检可走 cli.invoke 活路**，pm2 §9① 已改档 P0→P1，非"100% 空转"）。
- 处方（真机窗口随批2 V1-V13）：预检选型改 `app.inventory.list`（探未装 CLI，前棒选的 `appops.state.query` 探不到）；或交付 ≥1 个 workflow 模板实体。**均涉真机验证**，离线改不可证=登记。

## M6 · 挂载写侧（探测修正原述，转真机窗口）
- **差集亲验修正 PM 原述**：psmod 未绑定函数 41 个（多为 helper/私有）。审计点名的"4 写侧"实况分两类——
  - **真"已实现待挂载"成品**：`Expand-ZipArchiveItem`（storage.ps1:263）/`Set-ClipboardTextValue`（gui.ps1:483）/`Set-EnvironmentVariableInfo`（system.ps1:398）——3 条，与 pm2 差集交叉验证"真未挂载成品恰 3"**吻合**；
  - **"回收站清空 / Windows 更新管理"psmod 内无实现体**（grep `Clear-RecycleBin`/`Invoke-WindowsUpdate` 零命中）⇒ 属 **V2 未做**，非"已实现待挂载"，USER-MANUAL 已注"当前不可用 V2 规划"；
  - **`New-ShortcutItem` 是死函数**：`Get-ShortcutInfo`（app.ps1:1138）已在 D8 批次内联实现"提供 targetPath 即创建/覆盖"双形态，`New-ShortcutItem` 未被任何绑定引用 ⇒ 挂它=造双实现漂移，与刚做的 A2-10 单源化冲突。**处置=文档口径修正（"支持创建"）而非绑死函数**（PM §288 判据本就写"Get-ShortcutInfo 文档口径改为支持创建"）。
- **为何不现在绑 3 成品**：新增写侧 capability ⇒ 动 `EXPECTED_TOTAL=54` + `EXPECTED_DOMAINS`（storage 13→14 / gui 11→12 / system 14→15）硬钉 + "54 能力"文档面（批0 刚统一）三处计数；且参数绑定语义（env `value` 键 vs `value=`、clipboard 读写分派）psmod-contract **只证命名一致不证运行期**，须 kill-restart 真机验。离线绑=交付未验证的高危 PS 变更，违背本批"改不可证之物登记而非盲改"纪律。**转真机窗口设计**：绑定清单 + 白名单（env/registry 沿用既有 policy）+ 3 能力 input schema + 计数同步点（注册表/SKILL×3/README/CAPABILITY-MODEL/两测试硬钉）全部列出，随批2 V 清单一并执行。

## USER-MANUAL 重写（P1，未起）
体量独立、纯文档；列入后续（可与 M6 文档面同批）。

## 仍待真机窗口（本批与批2/批5 合并执行）
M3 预检改 app.inventory.list / M6 三成品绑定 + 参数运行期验证 / 计数三处同步。

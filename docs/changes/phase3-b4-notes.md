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

## M3 落地（2026-10-14，批4 part2）

### 实现（探测与引导，零契约变更）
模板 5 workflow.run 未命中路径改为三步：①`WORKFLOW_CLI_APP` 映射（ffmpeg→ffmpeg / office→soffice / photoshop→magick[开源等价]；**excel 不映射**=pandoc 只读 xlsx 不能写报表，映射反而教错误预期，名实相符纪律）；②L0 `app.inventory.list`(name 过滤) 探装机登记（best-effort：探测炸不改业务结论、不谎报，fail-safe）；③命中⇒给当下可达直调路径（appops.cli.invoke app=映射值，L1 不触审批——处置教育 mcp-reference:89 在位互证）；未命中⇒安装配方（app.winget.install）。收口码恒 UNSUPPORTED_GOAL（上游 WORKFLOW_NOT_FOUND 不改变业务结论，不在 shouldDegrade 集内）。

### PM 原述选型勘误（亲验坐实，采纳 pm2 §9① 反证）
`appops.state.query`(Get-AppOpState) 只枚举**运行中**应用/窗口，探不到未启动的已装 CLI ⇒ 预检证据源改 `app.inventory.list`（注册表卸载键）。原述"预检→命中即走 cli.invoke 替代 workflow"的**执行替代**版未采：确定性 provider 无法从自由文本生成合法 ffmpeg/magick 命令行（猜参数=造新空转），改为**失败路径的可达引导**（Agent/用户照文案直调即可）——3a 的本体收益=死路变有据可查的活路，且不引入"猜错命令执行失败"新病灶。批4 验收判据③原文"模板 5 走 cli.invoke 而非 WORKFLOW_NOT_FOUND"据此**改述**：workflow 仍首调（有脚本就真执行），未命中时不再空转而是给直调配方；离线判别=测试件。

### 测试
tests/unit/phase3-b4-m3-production-guidance.test.js 5 例（生产同构夹具=真注册表 schema，U-P0-3 教训口径：空 schema 会绕过 validateParams 校验面）：①探到装机⇒summary 含 cli.invoke+app 值+免审批说明+探测确实发起；②未探到⇒安装配方+绝不谎称可直调+原两条解法保留；③excel 不映射⇒无引导行+**零探测往返**；④探测抛错⇒业务结论不变+归因诚实；⑤workflow 成功路径零变化（不触发探测）。5/5 绿；回归 5 件全绿（t5-provider 12/kn1-d 28/cl017 12/code-fidelity 22/k3r-routing 4）。

### 真机确认（V16，待 VM 回线窗口）
P1 `app.inventory.list(name=ffmpeg)` 命中形状与 nameMatchers 匹配实证；P2 `appops.cli.invoke(app=ffmpeg,command="-version")` 直调真实可用=引导文案承诺的现实依据。E2E-03 已实证 inventory 数组形状（name 字段在位），P2 未跑（本轮 VM 在跑批5/6 时二次掉线）。

## M6 真机绑定完成（2026-10-14 批4 part3，读写分派保 54 计数）

### 交付（读-写分派，非新增能力）
三域各建分派函数（注册表唯一绑定 fn）：
- `Invoke-GuiClipboardManage`（gui.ps1）：带 `text`⇒Set-ClipboardTextValue / 不带⇒Get-ClipboardText；
- `Invoke-SystemEnvManage`（system.ps1）：带 `value`⇒Set-EnvironmentVariableInfo（空串=删除变量，name 必填守卫）/ 不带⇒Get；
- `Invoke-StorageArchiveManage`（storage.ps1）：`mode=expand`⇒Expand-ZipArchiveItem / 缺省 compress⇒New；**非法 mode 显式 throw 不静默回退**。
New-ShortcutItem 裁**不绑定**（D8 已被 Get-ShortcutInfo 内联取代=死函数，双实现漂移风险，与 A2-10 单源化同精神）→ 孤儿快照 `KNOWN_ORPHANS` 从 4 缩到 1（既定"接上即变红同步"语义兑现）。
文档/教学同窗：CAPABILITY-MODEL §3.1.2 表+四条能力行+v1.5 版本行；gui/storage/system-admin 三 SKILL 的"只读/仅压缩/待挂载"口径改读写实况；**"传入不产生写入"历史警示作废**（防回潮=skill-claims 守卫+psmod-contract 分派绑定双看护）。
离线验证：tsc RC=0；psmod-contract 7/7、contract-schema 23（src↔dist 绑定一致）、snapshot-truth 17、sort 6、p0-path 87、skill-claims 11 全绿；gate quick GREEN。

### 真机验证（VM 在线，deploy-vm 推新版+计划任务重启后）
| 能力 | 读侧 | 写侧 | 边界 |
|---|---|---|---|
| clipboard | `readback="M6-V2-CLIP"` ✓ | `set:true length:10` ✓ | requiresSession 健康会话 |
| env | `read="hello-m6"` ✓ | `write`+`del.ok`+`afterDel=null` ✓（写读删全循环） | Machine 需管理员令牌（未测） |
| archive | `compress bytes=135` ✓ | `expand extracted:true` ✓（压缩解压回环） | **badmode⇒INVALID_PARAMS 枚举拒**（不静默回退实证） |
指纹 `fpFiles=6` 在场=M6 新 psmod 确已加载（分派函数生效铁证）。

### V16（M3 双探针真机）
- **P1 inventory 探测证据源**：`app.inventory.list(name=ffmpeg)` 命中 1 条 **name="FFmpeg"**（首字母大写）⇒ 我的 `nameMatchers[/ffmpeg/i]` 大小写不敏感设计正确命中；imagemagick 命中 0 ⇒ 走"未装配方"分支（与引导逻辑一致）。
- **P2 cli.invoke 直调可达性**：`appops.cli.invoke(app=python,command="--version")` ok=true exit=0 out="Python 3.14.7" ⇒ M3 引导文案承诺的"直调可达"现实依据实证。

### ⚠ 生产级根因发现：VM-START TIMEOUT 真身 = Node Windows SO_EXCLUSIVEADDRUSE EACCES（非幽灵进程/非保留区间）
诊断链：schtasks 触发成功但 30s 无监听 → 前台直跑抓 stderr = `listen EACCES: permission denied 127.0.0.1:18443`（此前误猜"幽灵进程占端口"，实为 Node 在 Windows 用**独占绑定**，上一监听者（含其继承 18443 句柄的 ps-bridge 子 powershell）被 kill 后 socket 未彻底 drain，新实例重绑同端口返 EACCES 而非 EADDRINUSE）。
- netsh excludedportrange 实测仅 5357/5985/47001（排除保留区间假设）；
- 解药=**彻底清 socket 持有者（18443 全状态+vm-service node+ps-bridge powershell）+ 递增等待 socket drain（12/24/36/48s）+ 循环重试**——本窗口 attempt2（24s drain）即恢复（qa/p3-batch-sweep/m6-restart.ps1 已入库可复用）；
- **处方候选（登记不盲改）**：① install-vm 生成的 start-hidden.ps1 `Wait 500ms` 对独占重绑必不够→重启前应先确认端口无残留持有者；② 更根本=vm-service `listen` catch EACCES 后对同端口**有界退避自重试**（秒级释放）而非直接抛错退出——属可用性健壮性改动，需设计+测试+真机，交批5 长跑债或独立小批。**教训：Windows 端口重启类故障先 `netstat 全状态 + 前台直跑读 stderr 定性 EACCES/EADDRINUSE/EPERM，不凭"占用"直觉猜幽灵进程**。

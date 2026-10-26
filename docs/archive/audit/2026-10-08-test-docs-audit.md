# 测试验证与文档规范审计报告（2026-10-08）

> 审计人：严过关（QA 工程师）· 团队 software-winvm-audit 任务 #2
> 基线 HEAD：`f3f74c8`（2026-10-08 11:49 · docs: ddd 索引与概览同步（场景 F））
> 工作树：`.workbuddy/memory/*`（他人修改）、`docs/audit/`（本报告 + 实施侧审计）、`v3-kn2.*`（有意不提交）
> 方式：**只读审计**，未修改任何源码；逐文件抽测 12 个 `tests/unit/*.test.js` + 全部 8 个 `*.test.mjs` + `tests/e2e/smoke.test.js`

## 0. TL;DR

**总体判断：单元测试基线真实可复现（抽验 21 文件全绿，无虚报），但"1054/1054"这一口径本身已滞后且不完整。测试层有 4 处 P0：其中一处不是"缺测试"，而是"缺一条本该存在的测试，导致一个真实的审批闸绕过面在 1054 全绿下无人登记"。文档层六索引数字诚实、无造假，但同步回路在 2026-10-08 断了一次（S-4 修复未入 changed-log），且 HANDOVER/05-peripherals 仍有会误导新机器验收的旧数字。**

| 维度 | 结论 | 关键证据 |
|---|---|---|
| 基线真实性 | **属实（抽验 12/12 `*.test.js` 全绿）** | 逐文件实测：S-4 7/7、A5 22/22 + 4/4、K-N1-F 16/16、K3R 10/10 + 2/2 + 4/4、link-workspace 16/16、S5 39/39、r3-uninstall 39/39、deploy-winvm-plugin 4/4、_smoke 1/1（合计 164 例 0 fail） |
| 基线口径 | **滞后（P1）** | 实际 `tests/unit/*.test.js` = **60 个**（非 59，`git ls-files` 证实）；另有 **8 个 `*.test.mjs`（实测 70 例全绿）**、`delivery/__tests__` 8 例、`tests/e2e/` 17 例**全部未计入基线** |
| e2e 状态 | **当前机器上 e2e 非全绿（P0 可复现性）** | `node --test tests/e2e/smoke.test.js` → 16 pass / **1 fail**，根因 `spawn pwsh ENOENT` 的 uncaughtException 逃逸（after 钩子未 drain ps-bridge 自愈重试）；17 个用例本体全 ✔ |
| **安全盲区** | **新发现 P0（backlog 未登记）** | `policy/engine.ts:597-600` 的 `allow:dry-run-bypass` **不校验能力是否声明 dryRun** ⇒ 实测 8 个 L2/L3 能力中 **5 个**（含 `system.process.terminate`、`system.registry.write`、`appops.gui.produce` 等破坏性项）传 `dryRun:true` 即免审批放行；`grep -rn "dry-run-bypass" tests/` = **0 命中**。详见 §2-QA-11 |
| 覆盖盲区 | 4×P0 + 4×P1 + 3×P2 | 见 §2（QA-01…11） |
| backlog 核实 | 10 条中 **8 属实 / 2 措辞需修正 / 0 虚报** | 见 §3 |
| 未登记裸奔 | **11 条**（N1…N11） | 见 §4 |
| ddd 六索引 | **无数字造假**；changed-log **滞后**（S-4 未入册）+ project-dev-status **Skills(6) 自相矛盾** | 见 §5 |
| 旧数字残留 | README/06-OVERVIEW **无漏网**（1054 已同步）；但 HANDOVER `03:12`/`04:42`/`07:75` **仍写 214/214**（会被照做）；`docs/05-peripherals/` 三处 Skill 计数未同步 | 见 §6 |
| 可跑性 | 构建**新鲜**（12/12 包 dist 均不早于 src）；但 `npm run test:unit` = 文档明令禁止的整批 glob，`layout` 指向**不存在的 `scripts/`** | `package.json:14/16` vs `.dev/project-dev-status.md:42` |

**最高优先级 3 件事（按 ROI）**：
1. **QA-11 审批闸绕过面**：先补负向单测锁定（当前会红），再交 architect/owner 决策收紧 `dry-run-bypass` 条件 → §8-R6。
2. **零产品风险的两条 P0 回归**：`psmod-contract.test.js`（固化注册表↔ps1 的 54 条映射，~30 行）+ S-4/A5 装配点源码守卫（~40 行）→ §8-R1/R2。
3. **修 `package.json` 三个脚本 + e2e PowerShell 守卫**：消除"新人一跑就假全红""新机器一键复现必出红"，并把基线口径改为派生的全量清单 → §8-R3/R5。

---

## 1. 基线抽验结果（文件、命令、计数——逐文件实测证据表）

统一命令形态（严格逐文件，未使用任何整批 glob）：

```
/data/storage/el1/bundle/libs/arm64/node/bin/node --test tests/unit/<file>
```

### 1.1 单元测试抽验（12 个 `*.test.js`，优先怀疑对象：近期 S-4/K-N1/A5/K3R 改动）

| # | 文件 | tests | pass | fail | skipped | 对应缺陷 |
|---|---|---|---|---|---|---|
| 1 | `r19c-s4-policy-denied-audit.test.js` | 7 | 7 | 0 | 0 | S-4 |
| 2 | `r19c-a5-approval-coordinator.test.js` | 22 | 22 | 0 | 0 | A5 |
| 3 | `r19c-a5-fix4-risk.test.js` | 4 | 4 | 0 | 0 | A5 |
| 4 | `r19c-kn1-f-chain.test.js` | 16 | 16 | 0 | 0 | K-N1 |
| 5 | `r19c-k3r-approval-wait.test.js` | 10 | 10 | 0 | 0 | CL-K3R |
| 6 | `r19c-k3r-bridge-integ.test.js` | 2 | 2 | 0 | 0 | CL-K3R |
| 7 | `cl-k3r-runpersistent-approval-routing.test.js` | 4 | 4 | 0 | 0 | CL-K3R |
| 8 | `link-workspace.test.js`（已知坑源） | 16 | 16 | 0 | 0 | 分发 |
| 9 | `r19b-s5-write-allowlist-pairing.test.js` | 39 | 39 | 0 | 0 | S-5 |
| 10 | `r3-uninstall-verify.test.js` | 39 | 39 | 0 | 0 | K6/K-N2 |
| 11 | `deploy-winvm-plugin.test.js` | 4 | 4 | 0 | 0 | 分发 |
| 12 | `_smoke.test.js` | 1 | 1 | 0 | 0 | 冒烟 |

抽验合计 **164 tests / 164 pass / 0 fail / 0 skipped** —— **未发现任何虚报或回归**。文档记录的 `S-4 7/7`、`A5 26/26`（22+4）、`K-N1 专项（f-chain 16）`、`K3R（10+2+4）`、`link-workspace 16/16` 逐条对上。

### 1.2 未计入基线的 `*.test.mjs`（8 文件，全部实测 PASS）

| 文件 | tests | fail |
|---|---|---|
| `account-resolve.test.mjs` | 4 | 0 |
| `launcher-posix.test.mjs` | 5 | 0 |
| `oh-tunnel.test.mjs` | 19 | 0 |
| `path-util-posix.test.mjs` | 7 | 0 |
| `preflight.test.mjs` | 8 | 0 |
| `sandbox-allowwrite.test.mjs` | 9 | 0 |
| `ssh2-resolve.test.mjs` | 8 | 0 |
| `tunnel-daemon.test.mjs` | 10 | 0 |
| **小计** | **70** | **0** |

> ⚠️ 这 70 例（覆盖 `oh-tunnel`/`tunnel-daemon`/`preflight`/`account-resolve` 等交付脚本）**不在任何文档口径内**。`.dev/project-dev-status.md:38` 只写"59 个 `*.test.js` / 1054"。若宣称"全量基线"，诚实数字应为 `tests/unit` 68 文件 ≥ 1124 例。

### 1.3 e2e 实测（**发现问题**）

```
node --test tests/e2e/smoke.test.js
→ ℹ tests 17 | ℹ pass 16 | ℹ fail 1
```

失败详情（非用例断言失败，属**框架级错误**）：

```
ℹ Error: Test hook "before" at tests/e2e/smoke.test.js:25:1 generated asynchronous
  activity after the test ended. This activity created the error
  "Error: spawn pwsh ENOENT" ... instead triggered an uncaughtException event.
```

- 17 个 e2e 用例本体（含 `/health`、agent-card、A2A 版本协商、MCP `tools/list`、L2 审批闸、`message/send`→终态、artifact、SSE 流）**全部 ✔**。
- 根因链：本机 `which pwsh powershell` **均无** → `after()` 关闭 runtime 后，`ps-bridge` 空闲自愈仍排队发起 `spawn pwsh` → 拒绝连接后落入未捕获异常。
- 同时暴露测试名与断言漂移：`tests/e2e/smoke.test.js:69` 名为 **"能力注册表已装入全部四大能力域"**，而注册表实测为 **6 个域**（meta 3 / system 14 / app 8 / storage 13 / gui 11 / appops 5，合计 54）。测试通过是因为断言写的是 `≥ 4`（历史遗留，V1 前是 4 域）。属"绿灯但不再描述现实"的弱断言。

### 1.4 构建新鲜度（未跑 `npm run build`，按要求只做 mtime/git 核对）

对 12 个包逐一比对 `packages/<p>/src/**/*.ts` 与 `packages/<p>/dist/**/*.js` 的 mtime（`src -nt dist` 即视为陈旧）：

```
contracts / core / mcp-framework / a2a-framework / host-sdk / adapter-host-workbuddy /
host-a2a-bridge / vm-capabilities / adapter-agent-workbuddy / adapter-agent-workbuddy-llm /
adapter-agent-hermes / vm-service
→ 12/12：无任何 src 比对应 dist 新 ⇒ 构建新鲜，dist 与 src 一致（就时间维度）
```

旁证：`.dev/changed-log.md` 的 CL-K3R 段记录 G2 `tsc -b --force` 0 error（2026-10-06），其后 `d5cb71a`（2026-10-08 S-4）与 `f3f74c8` 均为文档/审计提交 —— S-4 的代码改动 `d5cb71a` 亦已反映在 mtime 上（未出现 src 更新）。**判断：构建新鲜度 ✅，但此结论仅基于 mtime，不能替代 `tsc -b` 的类型级验证（本审计按约束未执行）。**

---

## 2. 测试覆盖盲区清单（QA-01…｜P0/P1/P2｜路径｜证据｜风险｜建议补测）

### 分层判定方法
把 69 个测试文件按"测试触达方式"分三类（脚本化统计，非人工估计）：
- **A 类｜行为级**：`import from '@winvm/*'` 真实调用导出函数/类 → 改动行为会红。
- **B 类｜源码文本守卫**：`readFileSync('.../src/*.ts')` + 正则/`sliceRoute` 断言源码**字面形态** → 只防"代码被人改掉"，**不防"代码没接上"**。
- **C 类｜HTTP 端到端**：`fetch`/`listen` → 真正打通装配。全仓仅 `tests/e2e/smoke.test.js`、`r1-approval-card.test.js`、`oh-tunnel.test.mjs` 三个。

统计结果：**68 个 unit 文件中 C 类=0，e2e=1**。`vm-service` 这个"装配包"的核心价值（HTTP→MCP/A2A→策略→审批→审计→provider→ps-bridge 全链）在单测层**几乎全是 A/B 类拼接**，只有 e2e 一处真实装配，而该 e2e 在缺 PowerShell 的机器上**当前不绿**（§1.3）。

---

### QA-01｜P0｜**S-4 / A5 修复本身没有回归护栏——"注入点被删掉"不会有人发现**

| 项 | 内容 |
|---|---|
| 路径 | `packages/vm-service/src/server.ts:605`、`:837`（两处 `recordPolicyDeniedAudit` 早退前注入）；`server.ts:189-221`（A5 `endTask`/`raise` 单例护栏） |
| 证据 | `grep -rn "recordPolicyDeniedAudit" tests/` → **仅命中 `r19c-s4-policy-denied-audit.test.js` 自身**，且该文件 `import { LedgerRegistry, recordPolicyDeniedAudit } from '@winvm/vm-service'` 后**直接调用该函数**（文件头自述"纯函数测试（不起 HTTP 服务、不 spawn ps-bridge）"）。全仓 **无任何测试断言 server.ts 里存在这两处调用**（对比同类做法：`k5-replay.test.js:849/850/898` 就用源码正则守卫了 `executeCapability` 的命名与调用点数）。A5 侧 `r19c-a5-approval-coordinator.test.js` 测的是 `VmApprovalCoordinator` + `TaskStore` + `CliLlmBridge` 三者的独立行为，`server.ts` 的 `endTask` 护栏逻辑**不在其被测对象内**（该文件不 `readFileSync` server.ts 做守卫，仅 `@winvm/vm-service` 导入）。`r19c-kn1-e-shape.test.js:93` 只切取了 `/admin/llm-session/reset` 路由体，**未切取 `:605`/`:837` 附近**。 |
| 风险 | **回归即静默复发**：任何后续改动（重构、格式化、merge 解冲突、把 `void recordPolicyDeniedAudit` 误删或挪到 return 之后）都不会让 1054 基线变红，而 S-4 的取证盲区会**原样复活且无人知晓**。这正是 S-4 当初被判"仍存"时暴露的那类问题（`.dev/kn2-s4-a5-verify.md:38` 记载初版误判）——缺陷靠读码发现，但守护靠的是"没人动它"的运气。A5 同构风险。 |
| 建议补测 | ①最小成本：仿 `k5-replay.test.js` 加源码守卫 —— 断言 `server.ts` 中 `executeCapability` 的 `if (!verdict.allowed) {` 块内**在 return 之前**存在 `recordPolicyDeniedAudit(`，且全文件恰 2 处（`:605`/`:837` 语义锁定，用计数而非行号防漂移）。②根治：把 `executeCapability` 从 `createService` 闭包中提取为可注入依赖的导出函数（audit/logger/policy/provider 全参数化），做一次**行为级**"策略拒绝 → 链上真出现 blocked 记录"的装配测试。③A5 同理：守卫 `endTask` 内 P1-Fix 条件（`taskId !== this.activeTaskId` 时不清单例）存在于 `server.ts`。 |

### QA-02｜P0｜**源码文本守卫与 dist 行为测试双轨并存，缺"守卫↔实现"一致性校验**

| 项 | 内容 |
|---|---|
| 路径 | 34 个 `tests/unit/*.js` 使用 `readFileSync`（其中 12 个直接读 `src/*.ts` 或 `psmod/*.ps1` 做正则断言）：`r19c-kn1-e-shape`、`r19c-kn1-e-mutation`、`k4-p3`、`k5-replay`、`cl017-error-reason`、`cl018-a2a-timeout`、`cl018-constants`、`cl019-health-ageMs`、`cl019-routes-routeMetric`、`cl020-f2-a2a-netcfg-capture`、`r3-uninstall-verify`、`install-vm-task`、`install-vm-admin-endpoint` 等 |
| 证据 | 这些守卫的匹配串是**硬编码字面量**。示例：`r19c-kn1-e-shape.test.js:85` `sliceRoute(SERVER, "if (path === '/mcp' && req.method === 'POST')", "if (path === '/audit/receipt'")` —— 若有人把路由条件改写成 `path === '/mcp' && req.method === 'POST'` 的等价形式（如抽成常量、改为 `switch`、调换 method 顺序），守卫会以"**切片失败/切空串**"或"断言意外通过"两种方式失真；`.match()` 返回 `null` 时后续 `null[1]` 会崩，但 `indexOf(...) === -1` 写成 `> -1` 之类则会假绿。而 **dist 行为测试永远不会因守卫串过期而红**。二者之间**没有任何"守卫必须命中非空切片"的自检**（`e-shape` 内确有部分非空断言，但覆盖面按切片计不完整）。 |
| 风险 | 守卫类断言（B 类）在 1054 基线中**占据可观比例**，它们的"绿"不代表行为正确，只代表"源码还长这样"。当一次重构改变字面形态而**行为不变**时，会出现"全量红→被要求改测试串"的高成本；反之当行为被改而字面串仍兼容时，会出现"**假绿**"。这是 `.dev/` 里已多次出现的"grep 臆测 → 误判"问题的**测试版**。 |
| 建议补测 | ①给每条守卫加"切片非空 + 切片长度下限"前置断言（`assert.ok(route.length > 200)`），把"匹配失败"和"匹配成功但行为错"分开。②对**关键装配不变式**优先写行为级：至少让 QA-01、QA-03 涉及的 server 路由与 psmod 契约退出纯文本守卫。③文档化 B 类的定位与局限（见 §7-5）。 |

### QA-03｜P0｜**psmod（PowerShell 能力实现）触达率 34/90，且无注册表↔实现的跨语言一致性回归**

| 项 | 内容 |
|---|---|
| 路径 | `packages/vm-capabilities/psmod/*.ps1`（6 文件 2768 行 / **90 个 function**：app 27、system 17、storage 15、gui 14、appops 9、ps-bridge 8） |
| 证据 | 脚本化交叉核对（dist 注册表 + ps1 正则解析）：<br>①`caps total: 54`；`MISSING fn in owning ps1 module (0)`；`BAD module refs (0)` —— **当前注册表↔psmod 映射无断裂**（好）。<br>②但 `ps funcs total(unique): 90 / referenced by name in tests: 34` —— **56 个 PS 函数在全部 tests/ 里连名字都没出现过**，含 `Send-MouseInput`、`Get-UiaTree`、`Get-UiaNode`、`Invoke-UiaElement`、`Initialize-InputApi`、`Set-ClipboardTextValue`、`Wait-GuiCondition`（GUI 全套键鼠/UIA/剪贴板）、`Write-RegistryValue`、`Read-RegistryValue`、`Invoke-PowerControl`、`Stop-ProcessTree`、`Set-ServiceConfig`、`New-ZipArchiveItem`、`Expand-ZipArchiveItem`、`Move-FileSystemItem`、`Copy-FileSystemItem`、`Search-FileSystem`、`Measure-Tree`、`Install-WingetPackage`、`Update-WingetPackage`、`Start-AppProcess`、`Invoke-AppCli`、`Invoke-AppComAutomation`、`Invoke-AppGuiProduction`、`Invoke-BridgeRequest`（ps-bridge 总线本体）等。<br>③**"注册表 54 条 → 54 个 ps 函数存在"这一致命装配约束当前零回归**（本次靠我手写的临时脚本才验出；仓库内无等价测试）。<br>④`cl018-psmod-c456` / `cl017-psmod-sort` / `r3-uninstall-verify` 只对**特定几个函数**做源码文本检查（如 `Sort-Object -Property` 写法、`& winget @wingetArgs` 计数）。 |
| 风险 | 三个层面：<br>(a) **改名/漏改即 500**：若某次只改了 `definitions.ts` 的 `fn` 而 ps1 未同步，VM 侧能力调用在运行期才炸，本地 1054 基线**完全无感**（因为没有任何测试校验这个映射）。<br>(b) GUI/写类能力（`Send-MouseInput`/`Write-RegistryValue`/`Invoke-PowerControl`）风险最高却触达最低——这些是 L2/L3 破坏性能力。<br>(c) PS 5.1 兼容只能靠真机（`.dev/changed-log.md:16` 已沉淀 `Sort-Object` 静默失效教训）。 |
| 建议补测 | ①**P0 性价比最高**：新增 `tests/unit/psmod-contract.test.js`（纯 `readFileSync` + 解析，**零 PowerShell 依赖，沙箱可跑**），断言 `WINDOWS_CAPABILITIES` 每条 `implementation.{module,function}` 在对应 ps1 里存在（即把本次审计脚本固化成回归），并断言总数=54、域分布 {meta3,system14,app8,storage13,gui11,appops5}。<br>②再加一条"ps1 里 `function` 名不得与注册表 `fn` 大小写不一致 / 不得出现未被任何能力引用也未被 ps-bridge 内部调用的孤儿函数"警告级断言。<br>③PS 语法静态配平（大括号/引号、`??`/`?.` 禁用清单）——`r19b-*` 已部分做过，建议扩到全部 6 个 ps1（见 §4-裸奔-3）。 |

### QA-04｜P1｜**`vm-service` HTTP 路由层行为级零覆盖（作者已诚实登记，但缺口未闭合）**

| 项 | 内容 |
|---|---|
| 路径 | `packages/vm-service/src/server.ts:1058-1210`（`createServer` 回调：`/health`、`/.well-known/agent-card.json`、`/mcp`（+`?dtid=`）、`/audit/receipt`、`/a2a`（版本协商 / `message/stream` / `tasks/subscribe` / `handleRequest`）、`/admin/llm-session/reset`、405/404/500） |
| 证据 | `r19c-kn1-f-chain.test.js:10` 自述降级说明：**"本沙箱 `createService` 会 spawn ps-bridge 触发 V8 原生 fatal（起不了服务），故 F-3 的行为用真实 sink 数据 + `buildReceiptResponse` 纯函数覆盖，路由形态由 E 组源码守卫钉死，并在 E 组登记残余风险（路由体未做行为级验证）"**。实测本机 `which pwsh powershell` 均无，但 `tests/e2e/smoke.test.js` 的 `createService` **确实起来了**（16 例通过）——说明"起不了服务"这一前提在当前环境已不成立，该降级理由可解除（假设：当初 fatal 源于 junction/ps-bridge 组合，值得复核）。 |
| 未做行为验证的具体项 | ①`?dtid=` 解析→`ToolContext.delegationId`→审计 `channel:'a2a'` 的**通道 2 精确归因**（K-N1 的核心修复，目前只有 E 类文本守卫 + provider 层单测）；②`/audit/receipt` 的 400（缺 traceId）与"未命中→200 `{records:[]}`"契约；③A2A 版本协商 400 分支（`VERSION_NOT_SUPPORTED` 在 tests/ **零命中**）；④405 非 POST/GET；⑤404 未注册路径；⑥`tasks/subscribe`（SSE，tests/ **零命中**）；⑦`/admin/llm-session/reset` 的 404 门控**行为**（只有 `e-shape` 文本 + `install-vm-admin-endpoint` 的生成物检查）。 |
| 风险 | 装配层是本项目"缺陷密度最高"的地带（S-4/A5/K-N1 全在这里）。路由错一个 `return`、少一个 `await`，单测全绿而真机失败——历史上已发生多次（`install-host.mjs` 的 `cpSync is not defined` 就是同类"装配期崩溃未被任何单测发现"，见 `.dev/docs-index.md:43`）。 |
| 建议补测 | 新增 `tests/e2e/routes.test.js`（可沿用 `smoke.test.js` 的 `createService` 模式，它在本机可跑）：真实 fetch 打通 ①②③④⑤⑥⑦，每例断言 HTTP 状态 + 响应形状；若 ps-bridge 不可用则用 `WINVM_*` 配置降级 provider。 |

### QA-05｜P1｜**桩与真实形状的漂移（哨兵判别已是既有案例，同类风险仍有 2 处）**

| 项 | 内容 |
|---|---|
| 已知案例（属实） | `delegation-audit.ts:383` 账本跳过规则 `record.approval?.approvalId === 'policy-denied'`。该哨兵由 `approval-replay.ts:172` 自己写入。**双侧同源、无第三方产生该值** ⇒ 判别可靠。测试侧 `r19c-s4-policy-denied-audit.test.js:200` 用 `approval: { approvalId: 'policy-denied' }` 复刻，`:228` 还写了负向"真实规则名无哨兵不得被误伤"。**该条已闭环且质量较高**。 |
| 残余风险 A（假设级，P1） | 哨兵的**隐式契约**：任何其它代码路径只要把 `approval.approvalId` 置成字面 `'policy-denied'`（例如未来给"审批被拒终态"复用同一字符串），就会被账本静默跳过 → K-N1 计数少算。当前无任何断言锁定"全仓仅此一处写该字面量"。对比：`e-shape.test.js:320` 就给 `WINVM_ADMIN_ENDPOINT` 做过同类"全文件仅此一处读"的锁定——同样的手法可直接用于此哨兵。 |
| 残余风险 B（属实，P1） | `registerApprovalWaitFallback`（`delegation-truth.ts:175`）/ 模块加载时 `bridge.ts:59` 注册默认兜底 —— **该"模块级注册副作用"在 tests/ 里零命中**（`grep -rn "registerApprovalWaitFallback" tests/` 空）。若 `bridge.ts` 加载顺序变化或有人删掉第 59 行的注册调用，`reconcileApprovalTruth` 的兜底会在 deps 未显式传入时**静默变成 undefined 分支**（`delegation-truth.ts:235` `deps.reconcileApprovalWait ?? approvalWaitFallback`）。CL-K3R 去环改造（`95052d5`）正是为这个注册机制而生，却只测了显式注入路径（`r19c-k3r-approval-truth.test.js:145` 测的是"委托给 reconcileApprovalWait"，依赖显式 deps）。 |
| 残余风险 C（属实，P2） | `reconcileApprovalWait` 本体（`bridge.ts:649`）**未导出**（`grep "^function reconcileApprovalWait"` 无 `export`；`dist/bridge.d.ts` 仅注释提及）。只能经 `reconcileApprovalTruth`/`runPersistent` 间接触达。这正是 MEMORY backlog "建议补 reconcileApprovalWait 直接单测"未完成的**技术根因**（需先导出或经注册面测）。 |
| 建议补测 | ①哨兵唯一性守卫：断言 `approval-replay.ts` 中 `'policy-denied'` 字面量出现次数（写入点 1 处）与 `server.ts` 中该串 0 处。②`r19c-k3r-approval-truth.test.js` 增加一例"不传 `deps.reconcileApprovalWait`，仅 import bridge 触发注册 ⇒ 兜底仍生效"。③导出 `reconcileApprovalWait`（或 `__internal` 出口）并做关键词矩阵单测（`APPROVAL_WAIT_PATTERN` / `parseApprovalBlock` / `approvalId` 拼接）。 |

### QA-06｜P1｜**交付脚本（delivery/）测试存在但口径割裂，且有一处测试目录完全游离于文档之外**

| 项 | 内容 |
|---|---|
| 证据 | `tests/unit` 中 17 个文件测 `delivery/*.mjs`（install-host / install-vm / setup / link-workspace / path-util / preflight / account-resolve / oh-tunnel / tunnel-daemon / ssh2-resolve / deploy-shared-skills / deploy-winvm-plugin / winvm-plugin / sandbox-allowwrite）——**这部分质量不错**。<br>但 `delivery/__tests__/` 另有 **1 个测试（8 例，实测 8/8 PASS）+ 2 个探针脚本**（`oh-tunnel-error-handling.test.mjs`，故障注入型崩溃回归，2026-10-04 提交 `81c7f33`/`d68d430`）。`grep -rn "delivery/__tests__" .dev/ README.md docs/06-OVERVIEW.md` → **零命中**：该目录**未被六大索引任何一处收录**。 |
| 风险 | (a) 任何人按"跑全量测试"的文档口径（`tests/unit/*.test.js`）执行，**永远跑不到这 8 例崩溃回归**，隧道崩溃修复（T-CRASH）的护栏形同隐身。(b) 与 §7-1 的"一键复现"问题叠加：三个不同位置的测试（`tests/unit/*.js`、`tests/unit/*.mjs`、`delivery/__tests__/*.mjs`）没有任何一条命令能覆盖。 |
| 建议补测 | ①`.dev/project-dir-file-index.md` 的 delivery 节补登 `delivery/__tests__/`；②建立统一清单（见 §7-3）把三处纳入口径。 |

### QA-07｜P1｜**基线口径遗漏 8 个 `.mjs` + 1 个 delivery 测试 + e2e；文件数已实际漂移**

| 项 | 内容 |
|---|---|
| 证据 | 文档口径 `.dev/project-dev-status.md:38`："**59 个** `tests/unit/*.test.js` / 1054 / 1054 / 0 skipped"。实测 `ls tests/unit/*.test.js \| wc -l` = **60**（`_smoke` 1 例 + 59），`git ls-files tests/unit \| grep -c '\.test\.js$'` = **60**（已跟踪，非新增未提交）。另有 8 个 `.test.mjs`（70 例，实测全绿）、`delivery/__tests__` 8 例、`tests/e2e/smoke` 17 例（16 绿 1 框架错）。 |
| 判定 | "59 文件"是把 `_smoke.test.js`（占位冒烟）**有意或无意漏计**。无论哪种，`1054` 都**不是全量**：按文件补算，仅 `tests/unit` 就 ≥ **1124 例**；加 delivery 8 例与 e2e 17 例则 ≥ **1149**。 |
| 风险 | 以"1054/1054 全量"对外宣称会**系统性低估覆盖并高估可信度**；更重要的是：一旦有人补了新测试文件，"1054"这个数字就成了"是否漏跑"的判据歧源（本次抽验就撞上）。<br>**连带的实操后果**：`README.md:272` 与 `.workbuddy/handover/07-migration-checklist.md:74` 的循环都是 `for f in tests/unit/*.test.js` —— **glob 写死 `.js`**，照抄即天然少跑 8 个 `.mjs`（70 例）。 |
| 建议补测 | 口径改为「**逐文件跑完全量清单，X 文件 / Y 例 / 0 fail**」，并把清单纳入 `tests/MANIFEST.md` 或 `.dev/`（见 §7-3）；文件数用 `ls` 派生而非手抄。 |

### QA-08｜P2｜**e2e 断言与注册表现实漂移（弱断言 + 陈旧测试名）**

| 项 | 内容 |
|---|---|
| 证据 | `tests/e2e/smoke.test.js:69` 测试名 **"能力注册表已装入全部四大能力域"**，而注册表实测 6 域（meta/system/app/storage/gui/appops，54 能力）；`:91` 则正确断言 `skills.length === 5`。 |
| 风险 | 绿灯不代表守住现实；"四大"字样留在报告/文档里易被引用为架构口径（V1 是 4 域，已扩为 5 域 + meta）。 |
| 建议补测 | 改名并把断言写死为 6 域 / 54 能力（与 QA-03-① 的契约测试合并）。 |

### QA-09｜P2｜**真机依赖项清单（只有报告、无自动化）**

以下均**只有 `docs/test/reports/` 真机报告，无任何可离线重放的自动化**（自动化 = 有回归测试锁住语义）：

| 项 | 真机报告 | 离线锁 | 备注 |
|---|---|---|---|
| VM 侧 `--self-test`（ps-bridge 在真实网络/权限上下文） | `real-test-2026-09-30-r18/r19` | 无 | `changing-log.md:4` 仍列"待真机终验" |
| `hermes-agent` 真机 CLI 拉起 + MCP 自动加载 | 无（从未做） | 仅 `mcp-registrar`/`hermes-provider` 单测 | `changing-log.md:5` |
| SSH 隧道端到端（宿主→VM 实际调一次工具） | `real-test-2026-09-23-run*` 系列 | `oh-tunnel`/`tunnel-daemon` 单测 + `delivery/__tests__` 崩溃注入 | `changing-log.md:6` |
| 双连接器（`connector:winvm` + `connector:winvm-a2a`）宿主侧同时生效 | 无 | 无 | `changing-log.md:7`，**纯风险项** |
| `codebuddy` CLI 参数契约 | 无 | `llm-provider` 单测用模板 | `changing-log.md:8` |
| 共享 Skills junction 后真机读取执行 | 无 | `deploy-shared-skills` 单测 | `changing-log.md:9` |
| 真实 GUI 点击回归 | 无 | **无**（psmod gui 56 函数里仅 4 个被名字触达） | `changing-log.md:18`，与 QA-03 同源 |
| K-N1 真机复证（零 tools/call 场景端到端） | 报告 `real-test-2026-09-30-r19` E4 BLOCKED | `r19c-kn1-*` 242 例（离线，充分） | 单测已足够，真机为加分项 |
| A5 `rejected` 真机可达 | `a2a-coverage-2026-10-03` A5 **FAIL**（修复前） | `r19c-a5-*` 26 例 | **修复后尚未真机复跑** ⇒ 登记为未验证 |
| CL-K3R T05 | `k3r-t05-real-machine-2026-10-06` | `cl-k3r-*`/`r19c-k3r-*` 16 例 | 已真机过 |

> **A5 特别提示**：唯一在真机上被判 FAIL 后才修复的项（`a2a-coverage-2026-10-03`），修复（`d5cb71a` 之前的护栏提交）**没有对应的真机复验记录**。建议下轮真机把 A5 重跑一次（用户点"拒绝"→ 期望 `state==='rejected'` 而非 `failed`）。

### QA-10｜P2｜**`tests/fixtures` 单场景锁死 + 无变异测试（mutation）之外的"桩完备性"证据**

| 项 | 内容 |
|---|---|
| 证据 | `tests/fixtures/cl018-config` 8 个 `cfg-*`、`cl018-logs` 12 个 `log-*`（含 `degraded-6/not-a-dir`、`degraded2-7/blocker` 等降级夹具）——夹具设计良好且覆盖了异常。但 `r19c-kn1-e-mutation.test.js`（变异守卫，`tests/unit` 中唯一）针对 K-N1 路由形态做"摘掉守卫应致红"验证；**其余缺陷（S-4/A5/K3R/K-N2）无等价变异测试**。 |
| 风险 | 变异测试是唯一能证明"守卫真的会红"的手法。当前 S-4/A5 恰好缺守卫（QA-01），自然也无变异验证。 |
| 建议补测 | 把 `e-mutation` 的手法泛化为共享 helper `mutate(src, edits)`，对 QA-01 新增守卫做 3 例变异（删调用 / 移到 return 之后 / 改成空函数）。

---

### QA-11｜**P0（安全 / 审批闸绕过面）**｜`dryRun:true` 免审批规则**不校验能力是否真的支持 dry-run**，可跳过 5 个 L2 破坏性能力的审批

> 本项为本次审计中风险最高的一条。它不是"缺测试"，而是"**缺一条本该存在的测试，导致一个真实绕过面无人登记**"。

| 项 | 内容 |
|---|---|
| 路径 | `packages/core/src/policy/engine.ts:597-600` |
| 代码 | `if (riskAtLeast(req.risk,'L2') && !req.approved) { if (req.params['dryRun'] === true) { return { allowed: true, matchedRule: 'allow:dry-run-bypass', requiresApproval: false }; } ... }` —— 判定**只看 `params.dryRun === true`**，不看 `cap.input.properties.dryRun` 是否存在、也不看下游 PS 函数有没有 `[switch]$DryRun` |
| 实测证据 | 直接对 `CorePolicyEngine` + 真实注册表逐能力探测（`approved:false`，params 只塞 `{dryRun:true}`）：<br>```
system.service.configure L2 | declaresDryRun=N | plain->approval-required | dryRun:true->allow:dry-run-bypass | ALLOWED=true
system.process.terminate L2 | declaresDryRun=N | plain->approval-required | dryRun:true->allow:dry-run-bypass | ALLOWED=true
system.registry.write    L2 | declaresDryRun=N | plain->approval-required | dryRun:true->allow:dry-run-bypass | ALLOWED=true
storage.link.manage      L2 | declaresDryRun=N | plain->approval-required | dryRun:true->allow:dry-run-bypass | ALLOWED=true
appops.gui.produce       L2 | declaresDryRun=N | plain->approval-required | dryRun:true->allow:dry-run-bypass | ALLOWED=true
```<br>即 **8 个 L2/L3 能力中有 5 个"本不支持 dry-run"的，传一个 `dryRun:true` 就免审批放行**。这 5 个含 `system.process.terminate`（`destructive:true`）、`appops.gui.produce`（`destructive:true`）、`system.registry.write`（写注册表）、`storage.link.manage`、`system.service.configure`（可把服务设为 Disabled）。<br>对照 `.dev/changed-log.md:556` R19 真机记录：`seq157 allow:dry-run-bypass 放行但内层 success=false` —— **真机已经观察到这个放行行为**，当时结论是"K-N2（winget 参数不认识 --dry-run）"，把现象归到能力层，**没有回看策略层的放行条件本身**。 |
| 第二层防线为何不足 | `adapter-agent-workbuddy/src/index.ts:246` 先跑 `ctx.policy.evaluate` → `:265` 才跑 `validateParams`（D24 未知参数）。顺序是**先放行、后校验参数**：`dryRun` 对未声明它的能力会落入 D24 `unknown` 而返回 `INVALID_PARAMS`，因此**当前**这 5 个能力不会真被执行。<br>但这层防线的成立完全依赖"`validateParams` 恰好排在 policy 之后且必达"，而：<br>① 全仓 **无任何测试**断言"对**未声明 dryRun** 的能力传 `dryRun:true` ⇒ 最终不执行 / 或策略直接拒"（`grep -rn "dry-run-bypass" tests/ delivery/__tests__` = **0 命中**；`cl017.test.js:60-96` 只测了**已声明** dryRun 的 `system.power.control` / `storage.file.delete`，且 `engine()` 用的是桩 registry）。<br>② 任何新能力只要注册时 `input` 未声明 `dryRun`，就**默认继承**这个免审批通道（新增能力的 PS 函数若恰好也别名为 `-DryRun`/接受松散参数，就会**真的执行破坏性动作**）。<br>③ `definitions.ts:1430 hasDryRunParam()`（server.ts）已具备"判断能力是否声明 dryRun"的能力，但策略层**没有用它**（且该函数在 tests/ 零命中）。 |
| 风险定级理由 | 不是"当前可 RCE"，而是**审批闸（本项目最核心的安全承诺，SECURITY-GOVERNANCE.md 的 L2/L3 人工审批）存在一个未登记、未测试、语义过宽的全局放行条件**。属于"设计承诺与实现不一致" + "零回归保护"的叠加。按缺陷治理惯例定 **P0**。 |
| 建议修复（实施侧，非 QA 权限） | 把 `engine.ts:598` 收紧为"`req.params['dryRun'] === true` **且**该能力的 `input.properties` 声明了 `dryRun`"（`capabilityReq.capabilityPolicy`/registry 已可达；`server.ts:1425-1431` 已有同款判定函数可提取到 contracts 共用）。<br>或：策略层对"未声明 dryRun 却传了 dryRun"直接判 `INVALID_PARAMS`（把 D24 的校验前移到 policy 之前），使顺序不再成为安全依赖。 |
| 建议补测（QA 可先行） | 新增 `tests/unit/policy-dryrun-scope.test.js`：①正向——声明 dryRun 的 5 能力 `{dryRun:true}` → `allow:dry-run-bypass`；②**负向——未声明 dryRun 的 L2 能力 `{dryRun:true}` → 不得 `allowed`（当前会红，即为回归护栏）**；③端到端——`DeterministicAgentProvider.execute({capabilityId:'system.process.terminate', params:{processId:1,dryRun:true}, approved:false})` 必须返回失败且**不发起 bridge.call**（沿用 `cl017-param-guard.test.js:60-100` 的记录式桩）。 |

---

## 3. backlog 逐条核实（属实/不属实/已消失 + 证据）

核对源：`.workbuddy/memory/MEMORY.md:41-45`（backlog 段）+ `.dev/changing-log.md`（进行中/待定段）+ `.dev/kn2-s4-a5-verify.md`（残留声明）。

| # | backlog 声明 | 判定 | 证据 |
|---|---|---|---|
| B1 | **K3 遗留：兜底是启发式（依赖 LLM 措辞），根治=bridge 直读 MCP 结构化结果**（`MEMORY.md:42`；`changing-log.md:25` 同款记为 P2 `COMPLETION_CLAIM_PATTERN 词表有限`） | **属实** | `bridge.ts:649 reconcileApprovalWait` 以 `APPROVAL_WAIT_PATTERN.test(finalText)` 为唯一触发；结构化判据 `reconcileApprovalTruth`（`delegation-truth.ts`）的门 3"无 probe / approvalWait 缺席 → 透传"仍会回落到文本。根治需桥直读 MCP 结构化工具结果，确属更大改造。`changing-log.md:25` 已登记为 P2，未闭环。 |
| B2 | **建议补 `reconcileApprovalWait` 直接单测**（`MEMORY.md:42` 后半） | **属实，且有技术根因** | 该函数在 `bridge.ts:649` 为**模块内私有**（无 `export` 前缀；`dist/bridge.d.ts` 仅注释提及）。现只能经 `reconcileApprovalTruth`（`r19c-k3r-approval-truth.test.js:145` 断言"文本兜底确实委托给 reconcileApprovalWait"，**间接**触达）或 `runPersistent`（`cl-k3r-runpersistent-approval-routing.test.js` 4 例）覆盖。**直接单测不存在** ⇒ 需先导出。见 §2-QA-05-C。 |
| B3 | **预热会话 idle 回收（5min）后深度空闲首调仍付冷启动（K2 只覆盖重启后紧随委派）**（`MEMORY.md:43`） | **属实** | `persistent-session.ts:865` `if (this.childAlive() && this.lastUsedMs > 0 && nowMs - this.lastUsedMs > this.opts.idleTtlMs)` 触发回收；TTL 来自 `core/constants.ts:138` `LLM_SESSION_IDLE_MS_DEFAULT`（env `WINVM_LLM_SESSION_IDLE_MS` 可覆盖）。`warmup()`（`:625`）只在**启动期**被 `provider.warmup` fire-and-forget 调用一次，回收后无再预热路径（`warmupInFlight` 单次语义）。回归侧仅有 `cl018-persistent-session.test.js`（TTL 回收本身），**无"回收后首调延迟"断言**（该类断言本质需真机/计时，离线不可靠）⇒ 保持 backlog 合理。 |
| B4 | **`SessionHealth` 无法表达「未知」（interactive 等必填，超时被迫填假值）→ 先做文档级注明"仅 state==='healthy' 才有意义"**（`MEMORY.md:44`） | **属实（且文档级注明未落地）** | `contracts/src/bridge.ts:36` `type SessionState = 'healthy' \| 'degraded' \| 'unavailable' \| 'black-screen'` —— **确无 `unknown`**；`:38-47` `SessionHealth` 的 `sessionId/windowStation/desktop/interactive/locked/blackScreen/state` **全部必填**（无 `?`）。探针失败时（本次 e2e 实测即出现 `"会话状态变化"…detail:"会话探针失败：ps-bridge 未就绪且自愈失败"` 且 `state:"unavailable"`）只能挑一个确定态。`docs/` 全仓 grep 未见"仅 state==='healthy' 才有意义"这一注明 ⇒ **该项仍为裸 backlog**。 |
| B5 | **真实 GUI 自动化点击端到端回归受远端锁屏限制（P2）**（`MEMORY.md:45`；`changing-log.md:18`） | **属实** | `changing-log.md:18` "当前 GUI 模块提供截图+UIA 定位+键鼠 API，未跑真实点击回归"。叠加本次量化：`psmod/gui.ps1` 14 个函数中 `Send-MouseInput` / `Get-UiaTree` / `Get-UiaNode` / `Invoke-UiaElement` / `Initialize-InputApi` / `Set-ClipboardTextValue` / `Wait-GuiCondition` 在 tests/ **连名字都没出现**（§2-QA-03 证据 ②）。 |
| B6 | **A5 唯一残留 = 死字段 `cancelRequested`（无读取方）**（`changing-log.md:48`；`kn2-s4-a5-verify.md:53`/`:68`；`project-dev-status.md:72`） | **属实** | 全仓（src + dist）`grep cancelRequested` → **仅 6 处**：`a2a-framework/src/task-store.ts:51`（定义）/ `:116`（初始化 false）/ `:188`（`requestCancel` 写 true）+ 对应 `dist/task-store.js:60/122`、`dist/task-store.d.ts:42`。**无任何读取方** ⇒ 确为死字段。是否清理属设计裁量（建议方案 ②"消费它"优于"删除"，见 `kn2-s4-a5-verify.md:58`）。 |
| B7 | **S-4 已修复（`changing-log.md:47`、`project-dev-status.md:71`、`docs-index.md:66`/`:72`）** | **修复属实，但"回归闭环"说法需修正** | 源码侧属实：`recordPolicyDeniedAudit` 定义 `approval-replay.ts:150`、经 `index.ts:18` 导出、`server.ts:605` 与 `:837` 两处早退前注入（`git show --stat d5cb71a` 实证改 5 文件含 server.ts +38 行）。<br>但 `changing-log.md:47` 写的 "`r19c-s4-policy-denied-audit.test.js` 7/7 + 回归 82/82" 给人"已闭环"的错觉：该测试**直调函数本身**，对"server.ts 是否还调它"零保护（§2-QA-01）。建议措辞改为"函数语义已单测；**装配点尚未锁定**"。 |
| B8 | **K-N1 已修复 + 242/242 单测（`project-dev-status.md:69`）** | **属实** | `r19c-kn1-{a-pure,b-bridge,c-session,d-provider,e-mutation,e-shape,f-chain}` 7 文件（f-chain 实测 16/16）。设计文档行号漂移亦已随 `7cf8c9e` 校正。**唯 `?dtid` 归因的路由体行为级验证缺席**（§2-QA-04）。 |
| B9 | **K-N2 已修复 + 74/74（`project-dev-status.md:70`）** | **属实** | `r19b-s1-registry-forms`（35）+ `r3-uninstall-verify`（实测 **39/39**）= 74。`app.ps1:693 Get-UninstallDryRunPlan` 存在且为纯查询；`r3-uninstall-verify.test.js` 内 `& winget @wingetArgs` 计数守卫属实。 |
| B10 | **k3r harness 收紧后的稳定命中复核（`changing-log.md:49` 唯一仍 open 的 K3R 项）** | **属实（仍 open）** | `changing-log.md:49` 原文仍为 `- [ ]` 未勾，要求"再跑 ≥3 次坐实 100% 命中"。本审计无真机环境，不改判；登记为待真机。 |

**小结**：backlog 声明**基本诚实**（10 条里 0 条虚报"已修"）。需要修正的是 2 处**措辞**（B7"回归闭环"、B2 未说明"不可直接测"的技术根因）与 2 处**未登记的缺口**（B4 的文档级注明从未落地、§4）。

---

## 4. 未登记裸奔路径（backlog 之外的发现）

以下均**不在** `MEMORY.md` backlog、`changing-log.md`、`kn2-s4-a5-verify.md` 任何一处，属本次新发现。

| # | 裸奔路径 | 严重度 | 证据（命令级） | 后果 |
|---|---|---|---|---|
| N1 | **`dryRun:true` 免审批放行未限定"能力声明了 dryRun"** | **P0** | `grep -rn "dry-run-bypass" tests/ delivery/__tests__` → **0 命中**；策略探测 5/8 L2/L3 能力被放行（详见 §2-QA-11） | 审批闸承诺被削弱；新增能力默认继承绕过面 |
| N2 | **`server.ts` 路由体的行为级验证缺席**（作者已在 `r19c-kn1-f-chain.test.js:10` 登记"降级说明"，但**降级理由在本机已不成立**：`e2e/smoke` 的 `createService` 实测可跑） | P1 | `grep -rn "VERSION_NOT_SUPPORTED\|A2A_VERSION_HEADER\|tasks/subscribe" tests/` → **0 命中**；`buildPreview`/`hasDryRunParam`/`collectImpact`/`ledgerReg` 在 tests/ **0 命中** | D11 预览、版本协商、SSE 订阅、`?dtid` 归因等"改一行没人知道" |
| N3 | **注册表 ↔ psmod 跨语言映射无回归**（54 条 `implementation.{module,function}` 必须逐个存在于 6 个 ps1） | **P0（成本极低）** | 本次靠临时脚本才验出；`grep -rn "implementation" tests/unit` 无等价断言 | 改 `definitions.ts` 忘记改 ps1 → 真机运行期才炸 |
| N4 | **`psmod/*.ps1` 的 PS 5.1 兼容静态守卫只覆盖 2 个文件** | P1 | `cl017-psmod-sort`（仅 `Sort-Object`）、`cl018-psmod-c456`（仅 system 域特定项）；`grep -rn "psmod" tests/unit` 命中 `r3-uninstall-verify`（app.ps1）、`cl018-psmod-c456`、`cl017-psmod-sort`、`r19b-s1-registry-forms`（system.ps1）——**gui.ps1 / appops.ps1 / storage.ps1 / ps-bridge.ps1 无静态守卫**；而 `changed-log.md:16` 已沉淀 `??`/`?.` 剔除纪律 | 一条 PS7 语法混入 → 5.1 全模块加载失败，本地全绿 |
| N5 | **`delivery/__tests__/`（1 测试 8 例 + 2 探针）游离于六大索引与"全量口径"之外** | P1 | `grep -rn "delivery/__tests__" .dev/ README.md docs/06-OVERVIEW.md` → **0 命中**（`git ls-files` 确认 3 文件已跟踪，2026-10-04 提交） | 隧道崩溃回归（T-CRASH）无人知晓会跑 |
| N6 | **`tests/psbridge-smoke.mjs` 无归属** | P2 | `tests/psbridge-smoke.mjs` 存在但不在 `tests/unit`/`tests/e2e`，`grep -rn "psbridge-smoke" .dev/` → 仅 `changed-log.md` 首版"测试"行提过一次；无 npm script 引用 | 一次性脚本无人维护，易失效 |
| N7 | **`package.json` 的 `test:unit` / `test` / `layout` 三个脚本与实际纪律/仓库状态矛盾** | **P0（可复现性）** | ①`"test:unit": "node --test tests/unit/*.test.js"` = 文档明令**禁止**的整批 glob（`.dev/project-dev-status.md:42`、`docs-index.md:42`），一跑即触发 junction `0xC0000005` 假全红；②`"layout": "node scripts/dep-lint.mjs"` 指向**不存在的 `scripts/` 目录**（`ls scripts/` → No such file），且 `git ls-files scripts` 亦空；③`"test": "npm run build && node --test"` 的裸 `node --test` 会自动发现**全部**测试文件（含 `delivery/__tests__`、`.mjs`），同样撞坑 | 新机器/新人照 `package.json` 走 → 必得"假全红"，且无法解释"为何文档说逐文件" |
| N8 | **`.dev/changed-log.md` 未记录 S-4 修复本身**（只改了 `changing-log` 与 `dev-status`） | P1（DDD 违规） | `git show --stat d5cb71a` → `.dev/` 仅 `changing-log.md` + `project-dev-status.md` 各 1 行；`grep -c "2026-10-08" .dev/changed-log.md` = **0**；`changed-log.md:554` 仍写着 S-4 的**缺陷描述**（且带旧行号 `server.ts:676-684`）而无"已修复"条目 | 按 DDD"权威层级=仓库文档"，`changed-log`（已交付变更记录）缺一条已交付的代码修复；后来者读 `:554` 会以为 S-4 仍开放 |
| N9 | **`docs/prd/`（r17-prd.md）与 `docs/design/` 的 3 个 mermaid 图未入 docs-index** | P2 | `ls docs/prd/` → `r17-prd.md`；`docs/design/` 实有 **17 文件**，`docs-index.md:21-30` 逐缺陷节仅列 9 条（`kn1-class-diagram`、`kn1-sequence-diagram`、`r17-class-diagram`、`r17-sequence-diagram` 4 图 + `docs/` 根级 `class-diagram.mermaid`/`sequence-diagram.mermaid` 均缺）；`docs/prd/` 整目录在任何 `.dev/` 索引中 **0 命中** | 阅读顺序地图不完整；PRD 无处可寻 |
| N10 | **`docs/audit/` 新目录未回写索引** | P2（本轮起，属正常滞后，登记以免遗忘） | `git status` → `?? docs/audit/`（本审计 + 实施侧审计 2 份）；`.dev/project-dir-file-index.md:10` 的 docs 行仍只写"含 docs/changes/CL-* 与 docs/test/reports/" | 索引需随审计轮常态化更新 |
| N11 | **`tests/e2e` 在基线口径中"存在但不可用"** | P1 | 基线数字 1054 只含 unit `.test.js`；`e2e/smoke` 17 例（16 绿 + 1 框架错）**从未计入**；`.dev/README.md`、`docs-index.md` 均无"如何跑 e2e / e2e 需要什么环境"的说明 | 唯一真实装配验证既没被数进基线，也没被环境守卫 |

### 补充：桩（fakes）与真实形状的漂移清单（除 §2-QA-05 的哨兵案例）

| 桩 | 位置 | 漂移风险 |
|---|---|---|
| `policy: { evaluate: () => ({allowed:true, matchedRule:'test'}) }` | `cl017-param-guard.test.js:88` | **桩把策略无条件放行** ⇒ 该文件的"未知参数守卫"测试**看不到** dry-run 绕过与参数校验的真实先后顺序（N1 之所以能在测试全绿下存活，正是这类桩的直接后果） |
| `bridge.call` 记录式桩 | 同上 `:71-77` | 只记录不校验 PS 参数绑定 ⇒ `& $cmd @ht` 的松散绑定期望行为（`ps-bridge.ps1:181`）无从验证 |
| `audit.append: async () => ({hash:'h',...})` | 同上 `:84-87` | 无哈希链语义 ⇒ 链式一致性在 provider 层测试中不可见（靠 `r19c-kn1-f-chain` 真实 sink 补，但那份不跑 provider） |
| `captureAudit()`（S-4 测试） | `r19c-s4-policy-denied-audit.test.js:41-50` | 合理（函数级单测），但见 §2-QA-01：不能证明**装配** |

---

## 5. ddd 六索引一致性抽查（逐索引：一致/滞后 + 具体处）

抽查基准 = HEAD `f3f74c8` + `git log` + `ls`/`git ls-files` 地面真相。

### ① `.dev/README.md` —— **一致（内容）/ 一处结构性缺口**
- 六大索引导航表、方案选型（1+5 双通道、3 provider、7 Skill 语义）、关键约束 4 条 —— 与现状一致。
- ⚠️ 缺口：**未登记"逐文件跑测纪律"**（该纪律只存在于 `project-dev-status.md:42` / `docs-index.md:42` / `MEMORY.md:17`）。作为"治理说明入口"，测试运行红线缺席是治理文档的漏洞（新机器读者从 `.dev/README.md` 进来，会先撞上 `package.json` 的错误命令，见 §7-1）。

### ② `.dev/project-dir-file-index.md` —— **基本一致，4 处滞后**
| 项 | 判定 | 具体处 |
|---|---|---|
| 12 包分层表 | ✅ 一致 | 与 `packages/` 实数一致 |
| 7 Skill 列表 | ✅ 一致 | 与 `ls skills/` 7 目录一致 |
| `tests/unit/（59 个 *.test.js）`（`:13`） | ❌ **滞后** | 实为 60；且完全未提 8 个 `*.test.mjs`、`delivery/__tests__`、`tests/psbridge-smoke.mjs`（→ §2-QA-07、N5、N6） |
| docs 行（`:10`）"含 docs/changes/CL-* 与 docs/test/reports/" | ❌ **未收录 `docs/audit/`**（新目录）、`docs/prd/`、`docs/01-investigation/`、`docs/05-peripherals/`、docs 根级 9 个 `oh-*.md`/`INSTALL-*.md`/`gui-health-fix-*.md`/2 个 `.mermaid` | → N9/N10 |
| `delivery/` 节 | ✅ 准确详尽 | setup/install-host/install-vm/winvm-plugin/deploy-*/link-workspace/path-util/preflight/account-resolve/oh-tunnel/tunnel-daemon/ssh2-resolve 均有描述，且带轮次修复注记 |
| `qa/` 节 | ✅ 一致 | `ls qa/` = archive/evidence/harness/probes/r18/r19；⚠️ 未提 `qa/archive/early-tmp`（小） |
| 未登记顶层物 | ❌ | `overview.md`（17KB，根级，与 `docs/06-OVERVIEW.md` **同名不同体**）、`V1.0.0-release-notes.md`、`.env`/`.env.deploy-vm`、`vm-service-2026-10-06.log`、被 gitignore 的 `C:/` `%LOCALAPPDATA%/` 垃圾目录 |

### ③ `.dev/docs-index.md` —— **一致（2026-10-08 刚同步），3 处可挑剔**
- ✅ 阅读顺序 13 条指向的文件**全部存在**（逐个 `[ -f ]` 校验通过，无 MISSING）。
- ✅ 新增的"逐缺陷设计稿索引（docs/design/）"节：9 条均存在。
- ⚠️ 滞后 a：`docs/design/` 实有 **17 个文件**，缺列 4 个 mermaid（`kn1-class-diagram`/`kn1-sequence-diagram`/`r17-class-diagram`/`r17-sequence-diagram`）；`a5-approval-drop-*.md` 用"（3 篇）"概括（实为 3 篇，OK 但不可点）。
- ⚠️ 滞后 b：编号出现 **两个 "6."**（`:9` SPEC-AGENT-SERVICE-BRIDGE 与 `:10` 的 6.5 之间用了 `6.5/6.6/6.7` 打补丁）—— 属可读性问题，非事实错误。
- ⚠️ 滞后 c：`docs/prd/r17-prd.md` 未入任何索引（N9）；"最近变更"节里 `docs-index.md:66` 关于 S-4 的描述已更新为"2026-10-07 已修复"✅（一致）。

### ④ `.dev/project-dev-status.md` —— **最准确的一份，2 处滞后**
- ✅ "第十八轮起变更状态"表（K-N1/K-N2/S-4/A5/CL-K3R/CL-021/R19）与 `git log` 逐条对上；测试口径硬约束（`:42`、`:76`）完整准确。
- ❌ 滞后 1：`:38` "**59 个** `tests/unit/*.test.js` / 1054" → 实 60 个；且 `.mjs`/e2e/delivery 测试不在口径内（§2-QA-07）。
- ❌ 滞后 2：`:50-51` **"## Skills（6）- 6/6 已写 SKILL.md（1 总控 + 5 领域）"** —— 与同文件其它部分及 `.dev/README.md`/`project-dir-file-index.md`/README（均称 7 目录）**自相矛盾**，正是 2026-10-08 同步轮声称"Skill 计数统一为 7 目录"（`docs-index.md:73`）时的漏网条目。
- ⚠️ 冗余：`:43-48` "ps-bridge 真实拉起…/端到端委派冒烟…/空闲自愈…" 三行**重复粘贴两遍**（`:43-45` 与 `:46-48`）。

### ⑤ `.dev/changed-log.md` —— **滞后（DDD 违规，= N8）**
- ❌ `grep -c "2026-10-08" .dev/changed-log.md` = **0**；最后一条 `## 文档同步轮 · 2026-10-07`。
- ❌ **S-4 的代码修复（`d5cb71a`，2026-10-08 10:47，改 4 个源文件 + 新增 245 行测试）未入 changed-log**；`git show --stat d5cb71a -- .dev/` 仅动了 `changing-log.md` 与 `project-dev-status.md` 各 1 行。
- ❌ `changed-log.md:554` 仍以**缺陷口吻**描述 S-4，且带着已被 `kn2-s4-a5-verify.md:4` 明确作废的旧行号 `server.ts:676-684`（现 `:605`/`:837`）。→ 按"权威层级=仓库文档"，读者会得出 S-4 仍未修的**错误结论**。
- ✅ 其余（第一~第十七轮 + R19/A2A/K3R/同步轮）叙事与 `git log`、测试实测一致；`1054/1054`、`51 文件 736`、`187/187`、`195/195` 等历史数字均带轮次上下文，属正常分层。

### ⑥ `.dev/changing-log.md` —— **一致，2 处状态标记滞后**
- ✅ "进行中/待定/阻塞"分类符合 DDD；第十五~十八轮段与 `git log` 一致；迁移说明（`:54-55`）符合"已闭环迁 changed-log"纪律。
- ⚠️ 滞后 1：`:31` 的 `🆕 K6` 仍挂 `- [ ]` 未勾，但 `:36` 同段已写 `[x] K6 能力层修复（承前）`，且 `app.ps1:613 Invoke-NsisSilentFallback` + `definitions.ts:178 verified/fallbackUsed 契约` 实测存在 ⇒ **同文件内部自相矛盾**（应删/勾 `:31`）。
- ⚠️ 滞后 2：`:22` "QA 独立深审 K5（**重派中**）"仍为 `- [ ]`，而 `:29` 同段已 `[x] QA 独立深审 K5 → 报告…路由 NoOne` ⇒ 同类重复未清理。
- ✅ `:47`/`:48`（S-4 / A5 描述）与源码一致；`:49` k3r 复核仍 open，判定正确。
- ℹ️ 另有 1 个**非六大索引**的第七文件 `.dev/kn2-s4-a5-verify.md`（2026-10-08 新增核查证据）——内容准确、且是本次多项结论的一手来源；但它不在 `.dev/README.md` 的六索引导航表内 ⇒ 建议在导航表补一行，否则"六大索引"叙事与实际目录不符（`ls .dev/` = 7 个 .md）。

### 总评
| 索引 | 结论 |
|---|---|
| README.md | 一致 / 缺测试红线 |
| project-dir-file-index | 滞后（tests 计数、docs 子目录、顶层物） |
| docs-index | 一致（刚同步）/ 缺 mermaid+prd |
| project-dev-status | 基本一致 / **Skills(6) 矛盾** + 59 计数 + 三行重复 |
| changed-log | **滞后（S-4 未入册 + 旧行号残留）** |
| changing-log | 一致 / 2 处内部自相矛盾的复选框 |

六索引**没有出现"数字造假"**（1054 抽验为真）；主要问题是**同步覆盖面**（代码修复→changed-log 的强制回路在 10-08 断了）与**一处新旧口径并存**（Skills 6 vs 7）。

---

## 6. 文档旧数字/旧口径残留扫描（文件:行）

### 6.1 README.md / docs/06-OVERVIEW.md —— **无漏网**（10-08 同步有效）
```
README.md:275      1054/1054（59 个测试文件…）        ✅ 数字对，❌ 文件数应为 60
README.md:6/46/184/255  7 个 Skill（1 总控 + 5 领域 + 1 MCP 参考）   ✅ 一致
README.md:36       五大 Windows 能力域（54 个能力）    ✅ 与注册表 54 一致（域含 meta，口径为"五大 Windows 域"，见 6.4）
docs/06-OVERVIEW.md:4/:60  1054/1054                ✅ 数字对，同上文件数问题
docs/06-OVERVIEW.md  12 个包                          ✅
```
> 未发现 `194`、`636`、`214/214`、"六 Skill" 残留 → **上一轮同步的两大目标达成**。

### 6.1b 根级 `overview.md` —— **含被官方指向的过期数字（补漏）**
| 文件:行 | 内容 | 判定 |
|---|---|---|
| `overview.md:101` | "权威记录见 `docs/06-OVERVIEW.md`（**当前态：194/194 测试通过、12 包**）" | ❌ **最典型的漏网**：该文件自称"止于第三轮的早期总结"（自述 OK），但它**指路时把 194/194 当作"当前态"**。`docs/06-OVERVIEW.md` 实际已是 1054/1054 ⇒ 一个 2026-09 的早期总结文件在向后来者传达错误基线 |
| `overview.md:106` | "全量 **194/194**（178 单测 + 16 e2e）" | ✅ 作为历史快照表述可接受（同文件 `.dev/project-dev-status.md:40` 也保留了这条口径说明） |
| 目录层面 | 根 `overview.md`（早期总结，17KB）与 `docs/06-OVERVIEW.md`（交付概览，当前态）**同名词不同体**，且根级那份**未列入 `.dev/project-dir-file-index.md` 顶层树** | ⚠️ 见 §5② 与 §8-R11 |

### 6.2 HANDOVER 其余分册 —— **确认过时（03 已加同步说明，其余无）**
| 文件:行 | 残留内容 | 应更正为 |
|---|---|---|
| `.workbuddy/handover/02-development-history.md:15` | 第五轮 `194/194` | 历史快照，**但需在表头加"已过期，现 1054"警示**（同文件 `:30` 已有"194 为另一口径"说明，属半处理） |
| 同上 `:18/:19` | 第九/十轮 `187/187` | 同上 |
| 同上 `:20` | 第十一轮 `195/195` | 同上 |
| 同上 `:23/:26/:27` | 第十四轮等 `214/214` | 同上 |
| 同上 `:34` | "原 4 个 Skill…全量文档 1+4 → **1+5**" | 历史叙述，可保留 |
| **`03-current-status.md:12`** | `✅ **214/214**（逐文件跑，16 个 tests/unit/*.test.js）` | ⚠️ **表格正文仍是旧数字**，仅 `:5` 顶部加了同步说明 ⇒ 表格与顶部说明**并存矛盾**，读者按表取值即错。建议正文数字改写为 1054（60 文件）并把 214 移入"历史"列 |
| **`04-known-issues-and-roadmap.md:42`** | "先在新机跑通基线：`npm run build` + 逐文件单测 **214/214**" | 应为 1054；且"`npm run build`"在沙箱需 node 全路径，本行未提（→ §7-2） |
| **`07-migration-checklist.md:75`** | `# 期望：214/214` | 应为 1054（60 文件）；同行 `:74` 的循环命令缺 node 全路径 |
| `01-project-overview.md:71/:90` | 7 个 Skill | ✅ 已正确 |
| `04-known-issues-and-roadmap.md:10` | codebuddy CLI 契约真机未验证 | ✅ 与 `changing-log.md:8` 一致 |

**结论**：HANDOVER 除 03 顶部有"同步说明"外，**04 / 07 的操作型数字（214/214）未更新**，这两处会**直接误导新机器验收**（清单是给人照着执行的）；03 的表格正文亦未更新。**建议：04 §1、07 §5 的期望数字改为 1054/60 文件，并在 02/03 各加一行"本表数字为历史快照"。**

### 6.3 docs/ 与 .dev/ 中的 Skill 计数旧口径（1+5 语境下的"6"）
| 文件:行 | 内容 | 判定 |
|---|---|---|
| `.dev/project-dev-status.md:50` | `## Skills（6）- 6/6 已写 SKILL.md` | ❌ **残留**（应为 7 目录：1 总控 + 5 领域 + 1 MCP 参考） |
| `docs/05-peripherals/DEPLOYMENT.md:215` | "把 **6 个 Skill** 渲染为 …SKILL.md" | ❌ 残留（现 7） |
| `docs/05-peripherals/SCENARIOS.md:286` | "# 渲染 **6 个 Skill** + plugin.json…" | ❌ 残留 |
| `docs/05-peripherals/USER-MANUAL.md:9` | "它会通过 **5 个 Skill** 把指令送到虚拟机执行" | ⚠️ 可辩解（用户可见领域 5 个），但与"7 目录"口径并存易混淆 |
| `docs/05-peripherals/SCENARIOS.md:151` | "原始 4 个 Skill 漏掉的那一维" | ✅ 历史叙述 |
| `.dev/changed-log.md:13`（首版）| "**5 个 Skill**：orchestrator + system/app/storage/gui" | ✅ 第一轮历史，可保留 |

> 注：`.dev/docs-index.md:73` 声称本轮已"Skill 计数统一为 7 目录"，**但 `docs/05-peripherals/` 三处从未被扫描**（该同步轮只改了 README/06-OVERVIEW）。属"同步覆盖面漏了 peripherals 手册"的典型滞后。

### 6.4 "四大 / 五大 / 六个域"口径
- `tests/e2e/smoke.test.js:69` 测试名"四大能力域"（§2-QA-08）；注册表实际 **6 个域 / 54 能力**（meta+system+app+storage+gui+appops）。
- README/06-OVERVIEW 用"五大 Windows 能力域"（排除 meta 这一非 Windows 内建域）——**口径自洽但不唯一**；`07-migration-checklist.md:78` 又写"6 能力域 / 54 能力"。
- 建议：在 `docs/02-design/CAPABILITY-MODEL.md` 或 README §2.2 明确一句"5 个 Windows 能力域 + 1 个 meta 域，共 6 域 54 能力"，然后全仓统一引用。

### 6.5 测试报告目录纪律执行情况
| 纪律（`MEMORY.md:34`） | 执行 | 证据 |
|---|---|---|
| 每轮只留一份权威报告 | ⚠️ **部分** | `docs/test/reports/` 共 22 份。`2026-09-23` 同日 **5 份**（base + run2/3/4/6）；`run5` 从未存在（`git log --diff-filter=A -- '*run5*'` 空）⇒ 编号有洞但无删除痕迹。R18/R19/A2A/K3R 各 1 份权威 ✅ |
| 「未复现≠已修」须确定性注入回归 | ✅ 良好 | `r19c-kn1-e-mutation`（变异守卫）、`delivery/__tests__` 故障注入探针、K3R 的 `/admin/llm-session/reset?faultInjection=1`（专为"确定性进入 disabled"设计，`server.ts:1181-1210`） |
| FAIL 给四元组（现象/根因/证据/路由） | ✅ | R19/A2A/K3R 报告均含；`.dev/kn2-s4-a5-verify.md` 更是模板级 |
| 证据目录删除必留痕 | ✅ 未发生删除 | `qa/evidence/`、`qa/archive/` 被 gitignore（`.gitignore` 尾段），本地保留；`docs/test/reports/` 22 份全部在 HEAD 内，**零删除** |
| 旧口径残留清理 | ⚠️ | `docs/test/reports/k3r-t05-real-machine-2026-10-06.md:24` 记"本沙箱无 git"——现 `MEMORY.md:16` 已确认 git 全路径可用 ⇒ 早期报告里"无 git"的表述若被引用会误导（属历史报告，不建议改，但 `.dev/` 应显式声明"历史报告不回改"） |

### 6.6 工作树卫生（新发现，非文档但影响"仓库即真相"）
- **`%LOCALAPPDATA%/WinVMBridge/logs/winvm-service-2026-10-08.log` 最后写入时间 = 2026-10-08 15:19，内容为本轮 `node --test tests/e2e/smoke.test.js` 的 3 次启停记录**（端口 19399、`exposed:54`）。根因：`core/src/constants.ts:48 LOG_DIR_TEMPLATE='%LOCALAPPDATA%/WinVMBridge/logs'` 在非 Windows 下由 `config/index.ts:140 expandEnvPath` **原样返回字面量**（env 无 `LOCALAPPDATA`）→ `resolveServiceConfig` 的 `resolve()` 把它**按相对路径物化到 CWD**。⇒ **`tests/e2e/smoke.test.js` 每次运行都会在仓库工作树里写日志/审计垃圾**（`.gitignore:30-33` 已把 `%LOCALAPPDATA%/`、`C:/` 列为"同类缺陷产物"，但缺陷本体未修）。
- `C:/WinVMBridge/shared-skills/*`（2026-09-30 15:25）同属该家族（R18-A §3 已登记为缺陷、仅 gitignore 兜底）。
- `tests/fixtures/cl018-config/cfg-*`（8 个）与 `cl018-logs/log-*`（12 个）由 `cl018-config.test.js:23-24` `mkdtempSync(join(BASE,'cfg-'))` 在**仓库内**创建；`.gitignore` 尾段虽声明忽略，但 `git ls-files tests/fixtures` = **32 个文件已被跟踪**（`c93133f` 提交：cfg-* 2 个、log-* 30 个），其中 **22 个 `.tmp` 为运行时写探针产物**（如 `tests/fixtures/cl018-logs/log-JlMGbh/basic-1/.winvm-write-probe-4690.tmp`，全仓 `git ls-files | grep -cE '\.tmp$'` = 22）⇒ **忽略规则晚于提交、从未 `git rm --cached`**（本审计只读，不做该操作，仅登记）。

---

## 7. 测试工程卫生与可复现性

### 7-1｜P0｜`package.json` 脚本与自家文档红线**直接冲突**
| 脚本 | 现状 | 问题 | 建议 |
|---|---|---|---|
| `test:unit` | `node --test tests/unit/*.test.js` | **正是 `.dev/project-dev-status.md:42`、`docs-index.md:42`、`README.md:269-272`、`MEMORY.md:17` 四处明令禁止的整批 glob**。一旦有人 `npm run test:unit`（新人第一反应），`link-workspace.test.js` 的 `symlink(...,'junction')` 触发 `0xC0000005` → runner 崩 → **假全红**，且无汇总计数，极易被误读为"项目回归了" | 改为逐文件循环脚本（`node scripts/run-tests-one-by-one.mjs`），或在脚本里**显式排除** `link-workspace.test.js` 并在注释里写明原因 |
| `test` | `npm run build && node --test` | 裸 `node --test` 会自动发现**全部**测试（`tests/unit/*.js`+`*.mjs`、`tests/e2e`、`delivery/__tests__`）——比 `test:unit` 更容易崩；且 `npm run build` 会改 `dist/`（与"只读审计不跑 build"约束同源的风险：CI 里 build 与 src 不一致会静默改变被测对象） | 拆成 `test:unit:onefile` / `test:e2e` / `test:all:safe`，e2e 加环境守卫（7-2） |
| `layout` | `node scripts/dep-lint.mjs` | **`scripts/` 目录不存在**（`ls scripts/` → No such file；`git ls-files scripts` → 空）⇒ 该脚本永远失败，属死入口 | 补回脚本或从 `package.json` 删除（当前状态比"没有"更糟：会让人以为分层检查存在且通过） |
| 缺 | — | 无任何"逐文件全量跑 + 汇总"的官方入口，也没有 `.mjs` / delivery / e2e 的入口 ⇒ §2-QA-07 的口径割裂**根源就在这里** | 见 7-3 |

> 抽验旁证：`node --test tests/unit/_smoke.test.js tests/unit/path-util.test.js`（不含 link-workspace）实测 10/10 PASS ⇒ 崩溃确为 junction 特定，**不是** node runner 通病。故"排除单文件后其实可批量"，脚本有救。

### 7-2｜P0/P1｜新机器一键复现的真实前提，文档未集中列出
按 `.workbuddy/handover/07-migration-checklist.md:71-79` 的"基线验证（不需要真 VM）"照做，会依次踩：
1. **node 必须是全路径** `/data/storage/el1/bundle/libs/arm64/node/bin/node`（`MEMORY.md:16`）——07 清单里写的是裸 `node --test "$f"`（`:74`）。
2. **git 必须是全路径** `/storage/Users/currentUser/.harmonybrew/opt/git/bin/git`（07 清单未提）。
3. **e2e 需要 PowerShell**：本机 `which pwsh powershell` 均空 ⇒ `tests/e2e/smoke.test.js` 出现 §1.3 的 1 fail（`spawn pwsh ENOENT` uncaughtException）。**这不是代码回归，是环境缺依赖**，但测试没有环境守卫，导致"新机器一键复现"必然出红。建议 `before` 里探测 `pwsh/powershell`，缺席时 `test(..., { skip: 'no PowerShell' })` 或显式注册 `process.on('uncaughtException')` 收敛（并在文档写明"e2e 在无 PS 环境应有 N skipped"）。
4. **e2e 会在仓库工作树写垃圾**（§6.6）：`%LOCALAPPDATA%/`、`C:/`、`tests/fixtures/*-*/`。新机器跑一遍就多一堆未跟踪目录（靠 `.gitignore` 兜底），且 `.gitignore` 忽略的是**产物**不是**成因**。
5. **`npm install` 会重跑 workspace 链接**：`node_modules/@winvm/*` 现状由 `delivery/link-workspace.mjs` 建 junction（沙箱内崩点即在此）；文档未提示"复现环境优先用 link-workspace 而非 npm install"。

**综合判定**：单测层**可复现性良好**（本次 12+8 文件独立抽验全绿，无需 VM/PS/网络）；**e2e 层不可复现**（缺守卫）；**"一键"不存在**（脚本互相矛盾 + `layout` 死入口）。

### 7-3｜P1｜缺一份"全量测试清单 + 计数"的可执行口径
建议落地 `tests/MANIFEST.md`（或 `.dev/test-manifest.md`）：
```
分组 A  unit *.test.js   （60 文件）→ 逐文件跑，汇总 X 例
分组 B  unit *.test.mjs  （8 文件 / 70 例）→ 逐文件跑
分组 C  delivery/__tests__（1 测试 / 8 例 + 2 探针脚本，探针不入库跑）
分组 D  e2e（1 文件 / 17 例）→ 需 PowerShell；无 PS 时应报 skip 而非 fail
```
并由 7-1 的脚本从 `fs.readdirSync` **派生**文件数与用例数，杜绝"59 vs 60"这类手抄漂移（§2-QA-07 的直接解法）。

### 7-4｜P2｜测试计数解析纪律（`ℹ` 前缀）+ 两种命令形态并存
- 本轮实测确认计数行前缀是 `ℹ`（node v24.13.0）。`.dev/changed-log.md:279` 与 `MEMORY.md:17` 均**未记录**这一细节，旧脚本用 `grep '^# pass'` 会得 0 → 假"零用例通过"。建议写入 `.dev/project-dev-status.md` 的"运行方式硬约束"段（与 junction 坑并列）。
- **两种单文件形态并存且都可用**（实测）：`node --test tests/unit/x.test.js`（runner 子进程隔离，任务书口径）与 `node tests/unit/x.test.js`（README.md:272 / `07-migration-checklist.md:74` 的循环写法，**直跑**，靠 `node:test` 自身输出，同样得 `ℹ tests/pass/fail`）。二者语义不同（前者有 runner 汇总与并发、后者纯进程内），**但文档从未说明可以混用、也没说哪个是权威**。建议统一为 `node --test <单文件>`（有隔离、崩溃不外溢），并在 README 循环示例里补 `--test`。
- ⚠️ 附带发现：README.md:272 的循环 `for f in tests/unit/*.test.js; do node "$f"; done` **同样漏掉 8 个 `.mjs`**（glob 只匹配 `.js`），即"按 README 跑全量"天然少 70 例——与 §2-QA-07 同一根因（glob 写死扩展名）。

### 7-5｜P2｜测试分类学未文档化
34/68 单测文件含 `readFileSync`，12 个直接对 `src/*.ts`/`psmod/*.ps1` 做文本守卫（§2-QA-02），但没有任何一处文档说明"本项目存在文本守卫类测试，它们的通过≠行为正确"。这直接导致 `.dev/kn2-s4-a5-verify.md:38` 记载的"grep 臆测→误判"在测试层重演。建议在 `.dev/project-dev-status.md` 增加"测试三分类（行为级 / 源码守卫 / HTTP 端到端）+ 各自能证明什么"一节。

### 7-6｜已到位的卫生项（正面确认，避免只报问题）
- ✅ junction 崩溃坑在 4 处文档一致记载且口径相同（`changed-log.md:279`、`project-dev-status.md:42/76`、`docs-index.md:42`、`MEMORY.md:17`）。
- ✅ 测试**独立性**良好：抽验的 12 个文件全部用 `mkdtempSync` 临时目录（`link-workspace`、`deploy-winvm-plugin`、`r19c-*` 均注明"不触碰真实仓库"）。
- ✅ `cl018-file-logger`/`cl018-config` 有 `degraded-6/not-a-dir`、`degraded2-7/blocker` 这类**异常形态夹具**，非只测 happy path。
- ✅ 回归测试命名带缺陷 ID（`r19c-kn1-*`、`r19c-a5-*`、`cl-k3r-*`、`r19b-s1/s5`）——可追溯性优秀，本次审计能快速定位即得益于此。
- ✅ 沙箱约束（`/tmp` 只读、rm shim 坏、getcwd 异常）在 `MEMORY.md:16` 已沉淀并有替代方案。

---

## 8. 完善路径建议（按 ROI）

### 第 1 优先（P0，1 天内可完成，纯测试/文档，零产品风险）
| # | 动作 | 成本 | 收益 |
|---|---|---|---|
| R1 | **`tests/unit/psmod-contract.test.js`**：固化本次审计脚本——54 条 `implementation.{module,function}` 逐个存在于对应 ps1 + 域分布断言（§2-QA-03/N3） | ~30 行 | 关闭"改 definitions 忘改 ps1 只能真机发现"的最大静默面 |
| R2 | **S-4/A5 装配点源码守卫**：仿 `k5-replay.test.js:849` 断言 `server.ts` 的 `if (!verdict.allowed)` 块内 return 前存在 `recordPolicyDeniedAudit(`，全文件恰 2 处；A5 断言 `endTask` P1-Fix 条件在位（§2-QA-01） | ~40 行 | 让两个"已修复"结论**真正可回归**，防静默复发 |
| R3 | **修 `package.json` 三个脚本**：`test:unit`→逐文件安全版、`test`→分环境版、删除/补回死入口 `layout`（§7-1/N7） | 改 4 行 | 消除"新人一跑就假全红"这一最昂贵的信任损耗 |
| R4 | **`.dev/changed-log.md` 补 S-4 修复条目 + 修正 `:554` 旧行号**；勾掉 `changing-log.md:31`/`:22` 的矛盾复选框；修 `project-dev-status.md:50` "Skills（6）"→7（§5④⑤⑥/N8） | 纯文档 | 恢复 DDD"代码修复必入 changed-log"的强制回路 |
| R5 | **e2e 加 PowerShell 守卫**（缺席则 skip 而非 fail），并把 e2e/delivery/`.mjs` 计数纳入基线口径（§1.3/§7-2-3/§2-QA-07） | ~15 行 | "一键复现"从不可能变为可能 |

### 第 2 优先（P0 安全 / P1，需产品决策，建议先立项后实现）
| # | 动作 | 说明 |
|---|---|---|
| R6 | **收紧 `dryRun` 免审批规则**（`policy/engine.ts:597-600`）：仅当能力 `input.properties` 声明 `dryRun` 时才允许 bypass；或把 D24 参数校验前移到 policy 之前（§2-QA-11/N1） | **需 architect/owner 拍板**。先补负向单测（当前会红）锁定问题，再修复，走 K3R 同款"红档→修复→真机"流程 |
| R7 | **新增 `tests/e2e/routes.test.js`**：真实 `createService` 打通 `/mcp?dtid`、`/audit/receipt`（400/200/未命中）、A2A 版本协商 400、`tasks/subscribe`、405/404、`/admin/*` 门控（§2-QA-04/N2） | 作者已登记的"路由体未做行为级验证"缺口，现环境可解（e2e 实测能起服务） |
| R8 | **导出并直测 `reconcileApprovalWait`**（§2-QA-05-C / backlog B2）+ 补"模块加载注册兜底"用例（§2-QA-05-B）+ 哨兵唯一性守卫 | 完成 backlog B2 的"建议补直接单测" |
| R9 | **PS 静态守卫扩到 6 个 ps1**（`??`/`?.`/PS7 语法清单、大括号配平）（§4-N4） | 复用 `cl017-psmod-sort`/`cl018-psmod-c456` 现成手法 |

### 第 3 优先（P1/P2，治理与体验）
| # | 动作 | 说明 |
|---|---|---|
| R10 | `tests/MANIFEST.md` + 派生式计数脚本（§7-3）；`.dev/project-dev-status.md` 增"测试三分类"与"`ℹ` 前缀解析"（§7-4/7-5） | 口径自动化，根治手抄漂移 |
| R11 | `.dev/project-dir-file-index.md` 补 `docs/audit/`、`docs/prd/`、`delivery/__tests__/`、`tests/psbridge-smoke.mjs`、根级 `overview.md`/`V1.0.0-release-notes.md`/垃圾目录说明；`.dev/README.md` 补测试红线 + 登记第 7 个 `.dev` 文件（§5②/§4-N5/N6/N9/N10） | 索引完整性 |
| R12 | HANDOVER `04:42` / `07:75` / `03:12` 的 `214/214` → 1054（60 文件）+ node/git 全路径提示；`docs/05-peripherals/{DEPLOYMENT:215,SCENARIOS:286,USER-MANUAL:9}` Skill 计数统一（§6.2/6.3） | 交接可执行性 |
| R13 | 修 `LOG_DIR_TEMPLATE` 在非 Windows 的解析（`expandEnvPath` 未命中 env 时应回退 `tmpdir()` 而非物化到 CWD）；`git rm --cached` 22 个 `.tmp` 与 `tests/fixtures` 运行时目录（§6.6） | 仓库卫生；**需 owner 授权**（涉 git 写操作，本审计未执行） |
| R14 | `SessionHealth` backlog B4 的"文档级注明"落地：在 `docs/02-design/SECURITY-GOVERNANCE.md` / `INTERFACES.md` 写明"探针失败态字段无意义，仅 `state==='healthy'` 可采信" | 30 分钟纯文档，清一条老 backlog |
| R15 | 真机轮补齐：A5 修复后**尚未真机复验**（§2-QA-09）；k3r harness 稳定命中 ≥3 次（backlog B10）；双连接器宿主侧同时生效（`changing-log.md:7`） | 唯一"修了但真机没证实"的高风险项优先 |

### 建议的验收口径（下轮 QA 用）
```
分组 A/B/C/D 全绿（D 允许 skip）→ 报「X 文件 / Y 例 / 0 fail / Z skipped（环境）」
R1+R2+R6 的新增测试 → 各带 1 条变异验证（证明会红）
changed-log.md 存在 2026-10-08 S-4 条目 → DDD 回路恢复
```

---

## 附：本次审计的方法与限制

- **只读承诺**：未修改任何源码/文档（除本报告）。过程中一次误建 `.dev/_tmp_psfuncs.txt` 已即时删除并经 `git status` 复核（该目录未被 git 跟踪，无残留）。工作树仍为 `M .workbuddy/memory/*`（他人）+ `?? docs/audit/`（本审计）+ `?? v3-kn2.*`（既有）。
- **执行命令**：`node --test <单文件>` × 21（12 unit .js + 8 unit .mjs + 1 delivery 测试）+ `node --test tests/e2e/smoke.test.js` × 1；`tsc` 与 `npm run build` **未执行**（按任务书约束）。
- **限制**：①未跑全 60 文件（抽验 12，覆盖近期全部改动缺陷面）；②构建新鲜度仅 mtime 判断，**不能**证明类型级一致；③无真机/VM 环境，§2-QA-09 全部真机项**未复验**；④psmod 触达率为"名字出现"口径（上界），未做 PS 行级覆盖（本机无 PowerShell，不可能）；⑤dry-run bypass（QA-11）为**策略引擎单点实测**，端到端（经 `/mcp` 真实调用 + `validateParams` 拦截）未实跑，其"当前不可真执行"的判断标为**假设级**，需 R6 的负向单测坐实。
- **推测标记**：文中所有"假设"字样处即为未证实推断（QA-05 残余风险 A、QA-04 降级理由解除、§6.6 C:/ 成因、QA-11 第二层防线实际阻断效果）。 |

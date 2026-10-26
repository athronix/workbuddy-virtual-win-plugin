# Phase 0 止血 · QA 工作笔记（任务 #2）

执行人：严过关（software-qa-engineer）
日期：2026-10-08
来源依据：`docs/audit/2026-10-08-test-docs-audit.md`（QA-01 / QA-03 / N3 / N7 / §7-1，建议项 R1/R2/R3）

> 本文件为**增量落盘**工作记录：每完成一项立即追加一节（做了什么 / 实跑命令 / pass-fail 数 / 变异验证证据）。
> 范围纪律：只新建 `tests/unit/` 下测试文件 + 修改根 `package.json` 的 `scripts` 段 + 本笔记。
> 不做任何 git 写操作；不触碰 `packages/**`、`delivery/psmod`（此处指 `packages/vm-capabilities/psmod/**`）、`docs/audit/**`、`skills/**`。

---

## 0. 开工前核实的事实基线（读码结论，非报告转述）

| 项 | 实测 |
|---|---|
| 注册表条数 | `packages/vm-capabilities/src/registry/definitions.ts` 内 `cap({` 计 **54**；`import('@winvm/vm-capabilities').WINDOWS_CAPABILITIES.length` = **54** |
| 域分布 | `{meta:3, system:14, app:8, storage:13, gui:11, appops:5}`（与体检 §2-QA-03 一致） |
| ps1 函数总数 | 6 个 ps1 共 **90** 个 `function` 定义（app 27 / appops 9 / gui 14 / ps-bridge 8 / storage 15 / system 17），**零重名**（unique=90） |
| module→文件映射 | `ps-bridge.ps1:102` `Join-Path $PSScriptRoot "$Name.ps1"`，即 `implementation.module` ⇒ `<module>.ps1`；`__meta` 走 `Invoke-MetaCapability`（`:162`） |
| `__meta` 两条绑定 | `healthCheck` → Node 侧内置（`adapter-agent-workbuddy/src/index.ts:323` 拦截 `impl.module==='__meta' && impl.fn==='healthCheck'`，**不经 bridge.call**）；`listModules` → `ps-bridge.ps1:126` switch 分支 |
| S-4 装配点 | `server.ts:64` import；`:605`、`:837` 两处 `void recordPolicyDeniedAudit(`；分别位于 `:599`/`:762` 两个 `if (!verdict.allowed) {` 块内、`return` 之前 |
| A5 装配点（实名核实） | 协调器 `endTask` 归属守卫 `server.ts:190-201`（`if (!taskId) {` / `if (taskId !== this.activeTaskId) return;`）；`raise` 的 taskId 回落 `:206`（`req.taskId ?? this.activeTaskId`）；无挂接任务日志 `:215`（`reason: 'no-active-task'`）；服务侧接线 `:400` new / `:403` `setLogger(logger)` / `:1052` `bind(a2a.tasks, pendingApprovals)`；**调用方**在 `adapter-agent-workbuddy-llm/src/bridge.ts:813` `this.coordinator?.endTask(input.taskId ?? '')` |
| 测试脚本现状 | 根 `package.json`：`test:unit` = 整批 glob（四处文档明令禁止）；`test` = `npm run build && node --test`（裸发现）；`layout` 指向**不存在**的 `scripts/dep-lint.mjs`（`ls scripts/` → No such file，全仓 `find dep-lint` 空） |
| 本宿主 node | `/data/storage/el1/bundle/libs/arm64/node/bin/node` v24.13.0；`node -e` 内可用 `require`（实测） |

`supportsDryRun`（任务 #1 并行范围）当前在 `packages/contracts/src/*.ts` **不存在**（`grep -rn "supportsDryRun" packages/contracts/src` = 0 命中）⇒ R2 中该断言按主理人要求做成**软探针**，缺席即 `skip`，绝不卡死整个文件。

---


## R1 · psmod 契约回归测试（QA-P0-3 / 体检 §2-QA-03、§8-R1）✅

**新建**：`tests/unit/psmod-contract.test.js`（纯 `readFileSync` + 正则，零 PowerShell 依赖、零 spawn、不起服务）。

### 覆盖内容（4 组 / 7 例）
| 用例 | 断言 |
|---|---|
| psmod 目录形态 | 恰好 6 个 `.ps1`（app/appops/gui/ps-bridge/storage/system），每个都能解析出 function 定义 |
| 注册表条数与域分布 | 总数 **54**；域分布 `{meta:3, system:14, app:8, storage:13, gui:11, appops:5}`；能力 id 无重复 |
| src ↔ dist 一致性 | `src/registry/definitions.ts` 文本解析出的 54 条 `(id, module, fn)` 与 `dist/registry/definitions.js` 逐条相等（防「改了 src 没 build」） |
| **主断言：54 条映射全部可解析** | 每条 `implementation.{module,function}`：非 `__meta` ⇒ `<module>.ps1` 存在 + 其中存在 `function <fn>` + **大小写精确一致** + 定义文件与 module 相符；`__meta` ⇒ 要么 Node 内置（`healthCheck`），要么是 `ps-bridge.ps1` 的 `Invoke-MetaCapability` switch 分支（`listModules`）。**52 条 ps1 绑定 + 2 条 __meta，逐条纳入断言**（体检原口径"仅 34/90 被名字触达"就此闭合） |
| 大小写漂移 | ps1 侧不得存在与注册表 fn 仅大小写不同的同名函数（PS 不敏感 / JS 敏感） |
| 契约地基 | `ps-bridge.ps1` 仍按 `Join-Path $PSScriptRoot "$Name.ps1"` 解析模块，且保留 `UNKNOWN_FUNCTION` 显式错误（映射断裂不得被静默吞） |
| 孤儿函数快照 | 既不被能力引用、也不被 ps1 内部调用的函数，锁定为 4 条已登记快照（`app.ps1::New-ShortcutItem`、`gui.ps1::Set-ClipboardTextValue`、`storage.ps1::Expand-ZipArchiveItem`、`system.ps1::Set-EnvironmentVariableInfo`）；新增孤儿即红 |

> 解析口径：`/^[ \t]*function[ \t]+([A-Za-z0-9_:.\-]+)/gim`（大小写变体 `Function` 已覆盖；行首锚定天然排除形参/注释）。零新增依赖。
> 附带发现（已用 grep 核实）：上述 4 个孤儿在 `packages/*/src` 与 `tests/` 里**连名字都没出现过** —— 属体检 §2-QA-03 的"名实不符"家族，留给 P0-5 文档止血与后续能力接线（**非本轮缺陷**，本测试只做登记不擅自改动 psmod）。

### 实跑证据
```
$ node --test tests/unit/psmod-contract.test.js
ℹ tests 7  ℹ pass 7  ℹ fail 0  ℹ skipped 0   （3 suites）
```

### 变异验证（外部脚本，真实文件副本，绝不触碰真仓库）
把 `packages/vm-capabilities/{psmod,src,dist}` + 本测试复制到
`/data/storage/el2/base/cache/qa-r1-mutation/fake-repo`（与仓库同深度，故 `import.meta.dirname/../..` 定位成立），逐个施加变异后**独立跑**该测试（每条变异前从 pristine 副本还原）：

| # | 变异 | 结果 | 触发用例 |
|---|---|---|---|
| M1 | `gui.ps1` 里 `function Get-SessionHealth` 改名（注册表不动） | **RED** | 主断言 + 孤儿快照 |
| M2 | 注册表 `fn: 'Stop-ProcessTree'` → `Stop-ProcTree`（src+dist 同步改，排除"只被一致性用例捕获"） | **RED** | 主断言 |
| M3 | `storage.ps1` 的 `Expand-ZipArchiveItem` 改名（定义消失） | **RED** | 孤儿快照（该函数本就不在注册表引用集内，故由快照用例捕获；被注册表引用的函数改名由 M1/M2 路径捕获） |
| M4 | 注册表 `module: 'storage'` → `'filesys'`（指向不存在的 ps1） | **RED** | 主断言 |
| M5 | 新增一个无人调用的函数 | **RED** | 孤儿快照 |
| M6 | 注册表 `fn: 'Get-UiaTree'` → `'get-UiaTree'`（大小写漂移） | **RED** | 主断言 |
| M7 | 注册表追加一条能力（54 → 55） | **RED** | 条数与域分布 + 主断言 |
| **M8（假阳性探针）** | ps1 与注册表**同步**改名（合法重构） | **GREEN**（正确） | — |

⇒ 7/7 破坏性变异全部变红，1/1 合法重构不误报。

---

## R2 · S-4 / A5 装配点源码守卫（QA-P0-2 / 体检 §2-QA-01、§8-R2）✅

**新建**：`tests/unit/assembly-guard.test.js`（读 `server.ts`/`bridge.ts` 源码文本，用 `import.meta.dirname` 推仓库根，不依赖 cwd；行号一律不锁，只用**计数 + 花括号配平切片**）。

### 判据（标识符全部取自源码实名，非报告措辞）
**S-4**（`recordPolicyDeniedAudit`）
1. `server.ts` 内 `recordPolicyDeniedAudit` 出现 ≥ 2 次（import 1 + 注入 2，实到 3）；
2. `void recordPolicyDeniedAudit(` 调用点**恰 2 处**；
3. `if (!verdict.allowed) {` 拒绝分支**恰 2 处**，且**每块内**都有该调用、且调用位置在该块**最后一个 `return` 之前**（可达性）；
4. 调用保留 `void`（best-effort：审计写失败绝不影响拒绝语义）；
5. 两处调用都带 `channel:` 归因；
6. **（外部变异 X2 暴露的缺口，已补）** import 必须来自 `'./approval-replay.js'`，且 `server.ts` 内**不得**出现第二份同名函数定义 —— 否则"只断言被调用"会被"摘掉 import + 本地复制一份"绕过而假绿；
7. QA-02 纪律：每个切片都带 `长度下限`（拒绝分支 ≥200B、endTask ≥100B、raise ≥200B），把"锚点漂移/块被掏空"与"锚点在但行为错"分开。

**A5**（协调器归属护栏，实名取自 `server.ts:140-221`、`:400-403`、`:1052` 与 `bridge.ts:807-813`）
1. `endTask(taskId?: string)` 体内保留归属护栏 `if (taskId !== this.activeTaskId) return;`；
2. 同体内保留「`taskId` 缺席 ⇒ 无条件清空」的兼容早退；
3. `raise` 体内 `const taskId = req.taskId ?? this.activeTaskId;`（请求归属优先、缺席回退单例）；
4. `raise` 的无挂接任务早退仍走 `this.logger?.warn(... reason: 'no-active-task')`（根因 §6.4 点名的"零日志"）；
5. `createService` 内 `approvalCoordinator.setLogger(logger);` 与 `approvalCoordinator.bind(a2a.tasks, pendingApprovals);` 两处接线在位；
6. 调用方 `bridge.ts` 的 `beginTask(input.taskId ?? '')` / `endTask(input.taskId ?? '')` 按归属传参（退回零参 ⇒ 归属护栏被旁路）；
7. 契约侧 `contracts/bridge.ts` 仍为 `endTask(taskId?: string): void;` + `beginTask(taskId: string): void;`。

**dry-run 软探针**（任务 #1 并行，按主理人要求做成独立 test case）：以 `engine.ts` 的 `allow:dry-run-bypass` 是否仍为**无条件放行**为判据（不认行号、不认实现细节）。当前实测仍无条件放行 ⇒ 探针 `t.skip()` 并打印 `QA-P0-1（U-P0-3）尚未落地`，**不红、不卡死本文件**；任务 #1 合入后自动转为硬断言（契约层需有 dry-run 支持位载体）。
> TODO（留给主理人收口复核）：#1 落地后请把该软探针转为必跑硬断言（去掉 skip 分支）。

### 实跑证据
```
$ node --test tests/unit/assembly-guard.test.js
ℹ tests 24  ℹ pass 23  ℹ fail 0  ℹ skipped 1   （4 suites；skipped=1 即 dry-run 软探针）
```

### 变异验证（两条路都做了）
**① 文件内自证（内存副本，零写盘，末尾 SHA-256 自证磁盘字节未变）** — 14 条破坏性 + 2 条假阳性，全部通过：
`S4-m1/m1b` 删任一处调用、`S4-m2` 挪到 return 之后、`S4-m3` void→await、`S4-m4` 摘 import、`S4-m5` 本地复制同名函数、`A5-m1` 删归属条件、`A5-m2` 反转条件、`A5-m3` 丢 req.taskId 优先、`A5-m4` 断 logger 注入、`A5-m5` 断 bind、`A5-m6` 调用方退回零参、`A5-m7` 断 beginTask、`A5-m8` 去掉 warn ⇒ 逐条**守卫变红**；
`M9/M10`（格式化等价改写、注释增删）⇒ 守卫**仍绿**（不误报）。
> 关键教训（X7 变异暴露）：初版变异锚点用了**多行字面量**，仅把调用参数换行合并（语义完全不变）就会让变异用例误红 ⇒ 已改为**格式无关锚点**（按 `void recordPolicyDeniedAudit(` 序位 + 括号配平定位整条语句）。守卫与变异锚点同步加固。

**② 外部独立验证（复制源码树到 cache，真改文件后跑同一测试，绝不触碰真仓库）**

| # | 变异（写到副本文件） | 结果 |
|---|---|---|
| X1 | 摘除两处 `recordPolicyDeniedAudit` 调用 | **RED** |
| X2 | 从 import 里摘掉 `recordPolicyDeniedAudit` | **RED**（初版为 GREEN ⇒ 已补判据 6） |
| X3 | `endTask` 归属护栏整行删除 | **RED** |
| X4 | 删 `approvalCoordinator.setLogger(logger)` | **RED** |
| X5 | 删 `approvalCoordinator.bind(...)` | **RED** |
| X6 | `bridge.ts` 的 `endTask` 退回零参 | **RED** |
| X7 | 仅换行位置改写（语义不变） | **GREEN**（初版误红 ⇒ 锚点已改为格式无关） |
| X8 | `contracts/bridge.ts` 的 `endTask` 去掉 taskId 形参 | **RED** |

⇒ 外部 8 条变异：7 条破坏性全部变红（补齐 X2 判据后），1 条等价改写不误报。

---

## R2.1 · 回归检查（既有守卫与被触碰文件）
`packages/vm-service/src/server.ts`、`packages/adapter-agent-workbuddy-llm/src/bridge.ts`、`packages/contracts/src/**` 三个源文件在 R2 验证全程**只被读取**（测试内 SHA-256 自证 + 变异只在 cache 副本上落盘），未做任何修改。

---

## R3 · package.json 三脚本修复（QA-P0-4 / 体检 §7-1、N7、§8-R3）✅

**只改 `scripts` 段，零依赖改动**（按主理人硬约束 2）。

### 改了什么（三条，逐条对应体检 N7 的三个矛盾点）

| 脚本 | 改前 | 改后 | 理由 |
|---|---|---|---|
| `test:unit` | `node --test tests/unit/*.test.js`（**四处文档明令禁止的整批 glob**） | 内联 `node -e` **逐文件 spawn**：枚举 `tests/unit` 下 `.test.js` + `.test.mjs`，逐个 `spawnSync(process.execPath,['--test',file])`，每文件独立进程隔离，末尾打印 `[per-file] files=N failed=M` 汇总，`failed>0` 才 `exit 1` | ① 消除 junction → `0xC0000005` 打崩共享 runner 的"假全红"；② 顺带把体检 §2-QA-07 的「`.mjs` 从来不在口径内」闭合（两种后缀都收）；③ 有汇总计数 |
| `test` | `npm run build && node --test`（裸 `node --test` 自动发现**全部**测试，含 `tests/e2e`/`delivery`，更易崩） | `npm run build && npm run test:unit` | 复用同一条安全逐文件通道，不再自动发现 e2e（本机 e2e 因 pwsh ENOENT 非绿，属体检 §1.3/R5 的独立议题，不在本轮范围） |
| `layout` | `node scripts/dep-lint.mjs` → `scripts/` **目录不存在**（死入口，永远 `MODULE_NOT_FOUND`） | **删除该脚本键** | 体检建议"补回脚本或从 package.json 删除（当前状态比没有更糟）"。补回 `dep-lint.mjs` 属新增实现（他人范围/需架构决策），故按最小改动**删除死入口**；`docs/design/a5-approval-drop-fix-contract.md:836-844` 的 E-3 勘误也已把该失效登记为既存议题 |

### 跨平台与安全设计要点
- **不写 shell 循环**（`for f in ...` 在 Windows `.cmd` 与 POSIX `sh` 语义不同，仓库无 cross-platform runner 约定）⇒ 改用 `node -e` 内联脚本：`node` 由 npm 保证在 PATH，`process.execPath` 定位测试运行器，平台无关（openharmony / win32 / linux 同一条命令）。
- 引号纪律：内联 JS **只用单引号**，外层整体双引号，避免嵌套转义在 cmd/sh 两侧行为分叉；已实测 `npm run test:unit` 在本宿主正确启动并逐文件跑完 70 个文件。
- `spawnSync` 以 `status !== 0` 判定（含崩溃非零退出码），故某文件原生崩溃只**判死该文件**，其余继续跑完 ⇒ 不再出现"同进程连带判死、假全红且无汇总"。

### 连带必修（我的改动引发的一处既有测试红 → 已修）
全量首跑（run1，见 `test-unit-run1.log`）暴露 **1 处红**：

- `tests/unit/r19b-s5-write-allowlist-pairing.test.js:289-297` 的「S-5 · 断言6」把 `test:unit` 的**旧危险 glob 字面量** `/tests\/unit\/\*\.test\.js/` 当期望值 `assert.match`，并用 `assert.ok(!/\.mjs/.test(glob))` 明令禁止口径收录 `.mjs`。
- **路由判定（按 QA 决策规则）**：该断言的**字面期望**与本轮 P0 目标直接冲突——它锁死的正是体检判为 P0 的整批 glob 形态；新脚本行为正确（覆盖面为严格超集：同目录、同后缀、外加 `.mjs`，且逐文件安全），失败原因是**测试断言本身陈旧**，不是源码缺陷 ⇒ `Send To: QA(self)`，由我修测试。
- 修法（**语义判据替代字面 glob，且判据更严**）：改为断言 ① 口径指向 `tests/unit`；② 收录 `.test.js`（原意图"本文件必须被跑到"，保护对象逐字保留）；③ **禁止回退成整批 `node --test tests/unit/*.test.js`**；④ **禁止裸 `node --test`**。原「`!/.mjs/`」这一"禁止收录 .mjs"的期望被体检 §2-QA-07 判为口径割裂根源，已替换为"收录集合正确即可"，代码注释写明出处与理由，不静默放宽。

### 实跑证据
```
# 1) JSON / 脚本形态合法性
$ node -e "require('./package.json')"   → JSON OK（scripts: build,clean,test,test:unit,typecheck）
   test:unit 内不含任何 `*` 通配（fs.readdirSync + 后缀过滤 + 每文件 spawnSync）
   ⇒ shell 无 glob 可展开，"不触发整批 glob"由脚本形态本身保证

# 2) 批量崩溃面旁证（与体检 §7-1 抽验一致）
$ node --test _smoke + approval-audit + audit（3 文件批量，不含 link-workspace）→ 42/42 通过
   ⇒ 崩溃为 link-workspace 的 junction 特发、非 node runner 通病（本宿主 openharmony 不复现 0xC0000005）

# 3) 新脚本全量实跑（70 文件 = 62 .test.js + 8 .test.mjs）
$ npm run test:unit     # run1（修连带回归前）
  → [per-file] files=70 failed=1；NPM_EXIT=1
    唯一红：r19b-s5-write-allowlist-pairing.test.js（旧 glob 字面量断言，已按上节修）
    汇总：tests 1162 / pass 1158 / fail 1 / skipped 3
$ npm run test:unit     # run2（最终态）→ 见下节「全量回归结论」
```

### R3 变异验证（`/data/storage/el2/base/cache/qa-r3m` 副本，真仓库不动）
| # | 变异（写到副本 `package.json` 的 `test:unit`） | 期望 | 实测 |
|---|---|---|---|
| R3-m1 | 回退为 `node --test tests/unit/*.test.js` | RED | **RED**（断言③捕获） |
| R3-m2 | 回退为裸 `node --test` | RED | **RED**（断言④捕获） |
| R3-m3 | 口径漏掉 `.test.js`（只收 `.mjs`） | RED | **RED**（断言②捕获） |
| R3-m4 | 指向 `tests/e2e`（不再覆盖 tests/unit） | RED | **RED**（断言①捕获） |
| R3-pos | 真实 `test:unit` 原样 | GREEN | **GREEN** |

⇒ `matched expectations: 5 / 5`；副本基线 `39/39 pass`。

---

## 全量回归结论（最终态）


| 命令 | 结果 |
|---|---|
| `npm run test:unit`（run2 最终态） | `[per-file] files=70 failed=0`，**NPM_EXIT=0**；合计 **tests 1162 / pass 1159 / fail 0 / skipped 3**（62 `.test.js` = 1092/1091/0/1，8 `.test.mjs` = 70/68/0/2） |
| `npm test`（build + test:unit 全链） | **NPM_EXIT=0**；`tsc -b tsconfig.build.json` 实际执行且增量零改写（packages/ 下无任何文件被 build 触碰，mtime 核验） |
| skipped 明细 | `ssh2-resolve.test.mjs` 2（既有环境跳过）+ `assembly-guard` 1（dry-run 软探针，见收口项 C1） |
| 邻近既有守卫抽测（逐文件） | `r19c-s4(7/7)`、`r19c-a5-approval-coordinator(22/22)`、`r19c-a5-fix4-risk(4/4)`、`k5-replay(41/41)`、`r19c-kn1-e-shape(33/33)`、`r19c-kn1-e-mutation(49/49)`、`cl017-psmod-sort(6/6)`、`cl018-psmod-c456(13/13)`、`r19b-s1(35/35)`、`r3-uninstall-verify(39/39)` —— **零回归** |
| 我的新增文件单独跑 | `psmod-contract 7/7`；`assembly-guard 24 例：23 pass / 0 fail / 1 skipped（软探针）`；`r19b-s5（修断言后）39/39` |

> 旁注：`r19c-a5-approval-coordinator` 的 B 组（原红档/缺陷锁定期望必 FAIL）本轮实测 `22/22 全绿` ⇒ 工程师任务 #1 的 A5/P1 修复已落地（与 `server.ts:190-201` 源码实况一致）。我的 `assembly-guard` 对 `endTask` 归属护栏的断言与该修复形态一致，不是冲突。
> 会话内 `packages/**`、`delivery/psmod`、`docs/audit/**`、`skills/**` 均未被我写入（mtime 审计清单里的他方文件属并行任务 #1/#3，非我改动）。`tests/fixtures/cl018-config/*.json` 为 `cl018-config.test.js` 自身运行落盘（既有行为，体检 §6.6 R13 已登记该待清项，非我引入）。```````. 

---

## 收口清单（待主理人复核项）

| # | 事项 | 说明 |
|---|---|---|
| C1 | `assembly-guard` 的 dry-run **软探针** | 当前实测 `engine.ts:597-601` 的 `allow:dry-run-bypass` **仍为无条件放行**（任务 #1 的 A5 侧已落地、U-P0-3 dry-run 收紧未落地）⇒ 探针 `skip`。#1 该半场合入后应去掉 skip 转硬断言；探针判据只看"放行是否仍无条件"，不锁行号/实现细节 |
| C2 | `npm run layout` 已删除 | 死入口（`scripts/dep-lint.mjs` 不存在）。若要恢复分层守卫需**新建**该脚本（属实现范围，不在本轮）；`docs/design/a5-approval-drop-fix-contract.md:836-844` 与 `docs/audit/*` 里对 `npm run layout` 的引述需由文档任务（#3）同步 |
| C3 | `r19b-s5` 断言6 的语义替换点 | 原 `assert.ok(!/\.mjs/.test(glob))`（禁止口径含 `.mjs`）被替换为四条语义判据。若主理人认为须逐字保留请显式指示；我依体检 §2-QA-07（口径割裂属 P0 根因）判定应替换 |
| C4 | `test` 仍不跑 e2e / delivery | e2e 本机 `spawn pwsh ENOENT` 非绿（体检 §1.3；R5"PowerShell 缺席则 skip"守卫未做），属他人范围未越界；如需纳入 `npm run test` 请先落地 R5 |
| C5 | 4 个 psmod 孤儿函数 | 由 R1 快照登记（`New-ShortcutItem`/`Set-ClipboardTextValue`/`Expand-ZipArchiveItem`/`Set-EnvironmentVariableInfo`），属"名实不符"家族，供任务 #3 文档止血与后续接线参考；本轮**未改** psmod |
| C6 | 基线口径待更新 | `test:unit` 现覆盖 70 文件（62 `.js` + 8 `.mjs`）= 1162 例，非旧口径 60 文件/1054 例。`.dev/project-dev-status.md:42`、`README.md:274` 等处的数字与"逐文件跑"的表述应由文档任务（#3）同步 |

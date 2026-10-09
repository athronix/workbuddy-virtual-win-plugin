# Phase 1 · T2 core 执行内核 —— 实现笔记（增量落盘）

> 实现者：寇豆码（software-engineer）｜基线：T1 已提交 `4983a58`（契约与配置基座）
> 权威设计：`docs/changes/phase1-arch-design.md` §7.3 任务卡 T2（`:418`）、§7.4 验收 T2（`:430`）、§8 共享知识
> 纪律：纯附加可选；锚点 `engine.ts` dry-run 切片逐字节不可动；禁 git 写；禁碰 VM；逐文件跑测试；注释文本先 grep 静态断言

---

## 0. 开工计划（§7.3-T2 文件清单确认 + 执行顺序）

### 0.1 文件清单确认（与设计表逐条对齐，7 文件）

| # | 文件 | 设计表要求 | 动手前实测现状 |
|---|---|---|---|
| 1 | `packages/core/src/constants.ts` | 接收 `expandEnvPath` 下沉 | 314 行；`EnvView` 在 `:16`；模块纪律「所有 env 读取只在此处」⇒ 迁入合规 |
| 2 | `packages/core/src/config/index.ts` | 改为再导出，**仅** `:140-142` 迁出区块 | 实测函数体在 **`:180-182`**（设计写 `:140-142`，纯行号漂移）；T1 的 `SecurityConfig`/`validateServiceConfig` 已定形，**未再动** |
| 3 | `packages/core/src/policy/engine.ts` | −`cmdAllowRe:526/539`；四处展开 `:536`/`:537`/`:594-595`/`:638-639` | 实测行号**未漂移**（`:526` 声明、`:536`/`:537` 全局表、`:539` cmdAllowRe、`:594-596` capPathDeny、`:638-640` capPathAllow）；锚点实测 `:769-778` |
| 4 | `packages/core/src/policy/defaults.ts` | `pathAllowlist:54-60` 收紧；−`commandAllowlist:17-18/83-84/137` | 实测一致（`:55` 即 `'C:\\Users\\**'`） |
| 5 | `packages/core/src/audit/chain.ts` | `ChainVerification:87-95` +4；`verifyChain:310-364` 填 scope；+`verifyArchive()`；D-4 再导出 | 实测 `ChainVerification` 在 `:107`，`verifyChain` 在 `:311-364`；`listShards:213-234`（分片名 `audit-YYYYMMDD[-idx].jsonl`） |
| 6 | `packages/core/src/transport/index.ts` | 抽 `applyBearerHeader`；ssh-tunnel `:45-70` 消费 `tokenEnv` | 实测 ssh-tunnel `:46-70` **零 token 消费**；streamable-http `:73-80` 内联即抽取源 |
| 7 | `packages/core/src/index.ts` | 再导出核对 | 实测 `expandEnvPath` 从 `./config/index.js` 导出；audit 段无 `ArchiveVerification` |

### 0.2 执行顺序

`constants` → `config`（只动迁出区块）→ `engine`（helper + 四处 + 删 cmdAllowRe，锚点不碰）→ `defaults`（收紧 + 删键）→ `chain`（+4 字段 / 填 scope / verifyArchive / D-4 再导出）→ `transport`（applyBearerHeader 双分支）→ `index`（再导出核对）→ 每步 `tsc -b` 自查 → 全量逐文件测试 + 六判据取证。

### 0.3 开工基线取证（改动前，全绿）

逐文件 `node --test`（**禁 glob**，防 link-workspace junction `0xC0000005` 假全红）：

`p0-path-traversal 84/0`、`assembly-guard 24/0`、`policy 22/0`、`audit 25/0`、`cl017 12/0`、`cl017-param-value 34/0`、`cl018-config 7/0`、`mcp-registrar 13/0`、`protocols 23/0`、`r19b-s1-registry-forms 35/0`、`r19c-a5-approval-coordinator 22/0`；`tsc -b tsconfig.build.json` exit 0。

---

## 1. `packages/core/src/constants.ts`（+14/−0）

- 新增 `expandEnvPath(p, env: EnvView = process.env)`，函数体与 `config/index.ts` 原实现**逐字一致**（`p.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name) => env[name] ?? m)`），**未命中占位符原样保留**（不吞空串）—— 这是 §4 fail-closed 语义的前提。
- 位置放在「通用解析」区首（`EnvView` 之后），签名用本模块的 `EnvView` 而非 `NodeJS.ProcessEnv`（同一形状 `Record<string,string|undefined>`，去掉对 Node 类型的依赖，测试注入更轻）。
- 注释登记下沉理由：策略层模式侧也要展开 ⇒ 若走 `policy → config` 会形成包内边；本模块是 L1a 叶，两侧都从它引。

## 2. `packages/core/src/config/index.ts`（+7/−4）

- 删本地实现体，改为 `import { expandEnvPath } from '../constants.js'` + `export { expandEnvPath }`（**再导出**，导出名与调用点零改动）。
- `:187`（audit dir）、`:203`（logging dir）两处内部调用点**未改**，走再导出的同一实现 ⇒ 与策略侧**共用一份**展开语义（漂移面归零）。
- **未触碰** T1 已定形的 `SecurityConfig` / `validateServiceConfig`。

## 3. `packages/core/src/policy/engine.ts`（+32/−6）

1. `import { expandEnvPath } from '../constants.js'`（不 import `config/index.js`，避免 policy→config 包内边）。
2. 新增导出 **`expandPolicyPathPattern(p, env?) = normalizePath(expandEnvPath(p, env))`** —— 设计 §1.5 给的**先展开后归一**次序逐字保持；可选 `env` 注入位供离线纯函数直测（§7.4-T2 ② 口径）。外层编译点保留 `normalizePath(...)` 包裹（见下「守卫兼容」）。
3. **四处模式侧编译点**改为 `globToRegex(normalizePath(expandPolicyPathPattern(p)))`：
   - 全局 `pathDenylist` / `pathAllowlist`（原 `:536`/`:537`）
   - 能力级 `capPathDeny` / `capPathAllow`（原 `:594-595`/`:638-639`）
   - deny 侧同批加（否则运维把 `%USERPROFILE%` 写进黑名单会静默失效 —— 那是新的漏）。
   - ★ **守卫兼容**：外层再套一次 `normalizePath` 使 `p0-path-traversal` §2 静态判据（`this.pathDenyRe`/`pathAllowRe`/`capPathDeny`/`capPathAllow` 语句必须含 `normalizePath` **且** 含 `globToRegex`）继续逐字成立；`normalizePath` 幂等 ⇒ 双套不改变结论。实测该判据「白名单/黑名单**模式侧**同样先归一」仍 ✔。
4. **删 `cmdAllowRe`**：字段声明（原 `:526`）+ 编译（原 `:539`）。ARCH-18 已裁删除，T1 已删契约与 schema，本批删引擎侧唯一残留；全仓 grep 复证零读取（见 §8）。
5. ★ **锚点区逐字节未动**：`git show HEAD` 切片 `sed -n '769,778p'` 与工作区同段 `diff` 为空、`sha256` 相等（`28c99b334498abd0…`）。`git diff -U0` 的 hunk 头实测只落在 `:28 / :205 / :526 / :536-539 / :595 / :639`，**无一落在锚点区**（区体因上方插入整体下移 26 行，属行号位移而非内容改动）。

## 4. `packages/core/src/policy/defaults.ts`（+23/−9）

- `PolicyConfig` 删 `commandAllowlist` 字段；注释登记 ARCH-18 三条删除理由（① 引擎从未读取；② 唯一写入点已在 T1 删除；③ 命令面真实边界 = `commandDenylist` + 风险/审批闸），并写明**本表口径：命令策略面只有黑名单**。
- `DEFAULT_POLICY.commandAllowlist: []` 删除；`mergePolicy` 的 union 行删除。
- `pathAllowlist` 按 §1.5 收紧为设计给定的**六条逐字**：
  `'%USERPROFILE%\\**'`、`'C:\\Users\\Public\\**'`、`'C:\\Temp\\**'`、`'C:\\tmp\\**'`、`'D:\\Data\\**'`、`'C:\\WinVMWorkspace\\**'`
  —— 去掉全体账户的 `'C:\\Users\\**'`；不硬拼用户名（用户名是部署期事实，走既有 env 展开通路）。
- 注释登记 fail-closed 方向：env 缺席时占位符保持字面 ⇒ 该条永不匹配 ⇒ 绝对路径一律 `pathAllowlist:miss`（只会更严不会误放）；跨账户访问需运维**显式追加**（`mergePolicy` 数组并集只能加不能减 ⇒ 收紧永久生效）。

## 5. `packages/core/src/audit/chain.ts`（+163/−4）

- **D-4 兑现**：`import type { ArchiveVerification } from '@winvm/contracts'` + `export type { ArchiveVerification }`（core 只再导出，**全仓仅此一份定义**，注释写明「禁止复制同形结构」的理由：两份同形接口会漂移且 TS 结构化类型让漂移静默通过编译）。
- `ChainVerification` **+4 纯附加可选字段**：`scope?: 'session'|'full'`、`shardsVerified?`、`shardsTotal?`、`shardsArchived?`。
- `verifyChain()`：入口先 `const all = await this.listShards()` 取目录全片，`files` 选取规则**逐字保持**（`freshChain ? [...activeShards] : all`）；新增私有 `scopeInfo(all, files)` 计算范围，**两处 return 只做 `...scopeInfo` 附加**；`valid`/`brokenAt`/`reason` 判定链（`!chainOk || !hashOk || rec.seq !== lastSeq+1` 与 reason 四分支）**逐字未改**（实测 diff 中该行仅右侧多 `, ...scopeInfo`）。`scopeInfo` 内部 try/catch ⇒ 计数失败只「不知道就不报」，绝不改变判定。
- **+`ARCHIVE_VERIFY_MAX_SHARDS = 30`**（写死常量 + 注释说明「为什么不做成配置项」：会被启动 fire-and-forget 与 `/health` 级路径调用，无界扫描会让健康检查变成整目录读盘）。
- **+`verifyArchive(maxShards = ARCHIVE_VERIFY_MAX_SHARDS)`**：归档集 = `all` 去掉 `activeShards`；非正值/NaN 回退默认上限；**全程 try/catch 绝不抛**（失败返回 `[]`）。
- **+`verifyShardIntraChain(shard)`**（O-8 实现体）：**片内基线取自本片首条**（`expectedPrev = first.hash`、`lastSeq = first.seq`），跨片首条 `prevHash` **不比对**；首条的**自洽性**（存储 hash vs 内容重算）单独查一次 ⇒ 「只改首条内容」当场显形而不是拖到第二条。读不到分片 → 该片 `valid:false, reason:'UNREADABLE:<code>'`（事实而非抛）。

## 6. `packages/core/src/transport/index.ts`（+46/−9）

- **+`applyBearerHeader(headers, tokenEnv, env = process.env)`** 单一实现，返回**新对象**不改入参；三态与 `contracts/src/transport.ts:29-46` 的 `tokenEnv` 注释逐字对齐（未配置 ⇒ 不发头；有值 ⇒ `authorization: Bearer <token>`；**有名无值 ⇒ 抛 `TransportError`**，句子与原 `streamable-http` 内联实现逐字相同）。
- `ssh-tunnel` 分支：改为 `const headers = applyBearerHeader(opts.headers, decl.tokenEnv)` 并无条件传给 `HttpJsonRpcChannel`（原 `...(opts.headers ? {headers} : {})`）。★ 调用点**前置到 `establishSshTunnel` 之前**（理由见 §11 D-11）：有名无值要抛，若在建隧道之后才抛，异常路径上 `close()` 永不执行 ⇒ 泄漏一条 SSH 隧道。无 tokenEnv 时返回 `{...opts.headers}`，与旧写法的「空对象 vs 省略键」差异在 `HttpJsonRpcChannel` 内部 `{ ...(opts.headers ?? {}) }`（`http-channel.ts:58`）处收敛 ⇒ 实际发出的 header 集合逐字相同（隧道族 `oh-tunnel 19`/`tunnel-mode 15`/`tunnel-daemon 10`/`deploy-conn-side 3` + `host-a2a-bridge 35` 全绿为证）。
- `streamable-http` 分支：内联五行逻辑替换为同一函数调用（**行为逐字不变**），消除两份实现漂移。

## 7. `packages/core/src/index.ts`（+7/−1）

- 传输段 +`applyBearerHeader`；策略段 +`expandPolicyPathPattern`；审计段 +`ARCHIVE_VERIFY_MAX_SHARDS`，并 +`export type { ArchiveVerification } from '@winvm/contracts'`（带 D-4 说明注释）。
- `expandEnvPath` 导出名**保持不变**（现经 `./config/index.js` 的再导出取得）⇒ `mcp-registrar` 等既有 `from '@winvm/core'` 消费方零改动。

## 8. ARCH-18 删除面复证（T2 收尾）

`grep -rn "commandAllowlist|cmdAllowRe" packages/*/src`（非注释行）→ **零命中**。残余出现处全部是**注释/文档**（`contracts/capability.ts` 病灶说明、`defaults.ts` 删除理由、`definitions.ts:416-417` 历史注记、schema `description`、设计/笔记文档），属刻意保留的口径记录，非消费点。
`docs/02-design/CAPABILITY-MODEL.md:235` 仍写 `"commandAllowlist": []` —— **该文件是 T5 的 owned 文件**（§7.3 T5 行「命令面白名单口径移除」），本批不改，已列入 §10 移交。

## 9. 测试面适配（刻意的破坏性收紧，§1.5-3 预告项）

设计 §1.5-3 明示：「收紧后所有 `C:\Users\<其他用户>\**` 在策略层变 DENY；**tests 内凡以 `C:\Users\` 开头断言 ALLOW 的用例需复核**」。实测改动前全量基线（63 文件 / 1161 pass / 0 fail），落地收紧后首跑出现 **2 文件 / 16 处**红，逐条归因：红的是**夹具前提**（旧用例假设「Users 树内 ⇒ 白名单内」），不是策略行为错。适配口径（两份文件统一）：

1. **在文件顶部、任何 `new CorePolicyEngine(...)` 之前**钉 `process.env.USERPROFILE = 'C:\\Users\\vmuser'`。必须钉在构造前：模式表在**构造时**编译、展开读 `process.env`。不钉则 POSIX 开发机上占位符保持字面 ⇒ 该条恒不匹配 ⇒ Users 路径集体 miss ⇒ 噪音红。钉成确定值也使 POSIX 与 Windows 真机得到**同一结论**。
2. `tests/unit/p0-path-traversal.test.js`（+208/−60）：
   - 夹具串 `C:\Users\a` / `alice` → 基准账户 `vmuser`（`TRAVERSAL`、`TRAVERSALS`、等价写法用例、dry-run 用例的 path 等）；这些用例的**归一方向判据不变**（比的是「落点是否仍在允许集合内」）。
   - §2「非逃逸对照」样例改为「落点确实在允许目录内」的形态（`C:\Users\vmuser\Documents\Reports\..\..\notes.txt` ⇒ `C:\Users\vmuser\notes.txt` ⇒ ALLOW），并把「补 `..` 即真逃逸 ⇒ DENY」的对照层级同步调成四级；**判据本身（只看落点、不看字面有无 `..`）逐字保留**。
   - `expandPolicyPathPattern` 纯函数直测的一条期望串**由我修正**：原写 `'C:\\Windows'`，权威参照 `path.win32.normalize('C:\\Users\\bob\\..\\Windows')` = **`C:\\Users\\Windows`**（`bob` 只被一个 `..` 弹掉，`Users` 仍在 —— 正是本文件 §1 早已钉死的「弹栈不足时绝不越过实际存在的层」）。补了一条**反序通路**断言（先归一再展开 ⇒ `'Windows'` 相对串）钉住「先展开后归一」的顺序不可换。
   - 新增 3 条 ARCH-17 判据（见 §11 判据 ②③ 证据），测试数 84 → **87**。
3. `tests/unit/policy.test.js`（+74/−5）：样例改基准账户；「普通命令放行」内嵌路径改基准目录；新增「ARCH-17 跨账户 DENY」1 条 + 「能力级 `%USERPROFILE%`（**真实注册表** `appops.cli.invoke`）」2 条，测试数 22 → **25**。

> 纪律复述（D-5 教训）：上述注释文本落笔前均已 grep 静态守卫（`cancelRequested` 全仓仍恰 3 处 = `task-store.ts`，本批未新增引用；`assembly-guard`/`p0` §5 判据在**剥注释后**的文本上运行，本批注释不污染锚点切片）。

## 10. 验收证据（§7.4-T2 六判据 + 附加）

> **口径说明（避免与 §9 的历史计数混淆）**：`tests/unit` 实为 **71 个文件 = 63 个 `.test.js` + 8 个 `.test.mjs`**（§9 里「63 文件」是只数 `.js` 的分母）。本批**改动前**基线 = `files=71 / failedFiles=0 / totalPass=1245`；**改动后**终局 = `files=71 / failedFiles=0 / totalPass=1251`（净增 6 = p0 新 3 条 + policy 新 3 条）。
> 终局 `tsc -b tsconfig.build.json`（12 包）**exit 0**。以下 §10.1 为本回合（D-11/D-12 修正后）**复跑**的权威数字，早先一次性脚本（`t2-verify-policy.mjs`、`t2-verify-chain-transport.mjs`）的结果以它们为准。

### 10.1 最终复跑（`$HOME/wbtmp/t2-verify-policy-chain.mjs` 42 断言 / `t2-verify-transport.mjs` 16 断言，两脚本 RESULT 均 `fail=0`）

| 判据 | 结论 | 证据（终局） |
|---|---|---|
| **①** p0 方向不变 | ✔ | `node --test tests/unit/p0-path-traversal.test.js` → **tests 87 / pass 87 / fail 0**（基线 84 + 本批 3 条 ARCH-17 判据）；穿越形态全集 9 条逐条 `allowed=false` 且 `matchedRule` 命中 `pathDenylist`；变异自检 X1–X4 + `ENGINE_HASH` 只读自证全绿 |
| **②** 跨账户 DENY / `%USERPROFILE%` 实际值 ALLOW | ✔ | 脚本打印 `DEFAULT_POLICY.pathAllowlist = ["%USERPROFILE%\\**","C:\\Users\\Public\\**","C:\\Temp\\**","C:\\tmp\\**","D:\\Data\\**","C:\\WinVMWorkspace\\**"]`；`C:\Users\other\x.txt`、`C:\Users\Administrator\Desktop\a.docx`、`C:\Users`、`C:\Users\other` → **DENY `pathAllowlist:miss`**（并断言 `requiresApproval=false`，miss 是硬拒不是转审批）；`C:\Users\vmuser\*`（含中文名、目录本身）、`C:\Users\Public\shared.pdf` → **ALLOW**；正斜杠/`.\`/重复分隔符/`dir\..\` 四形态等价写法 ALLOW 不回归；纯函数直测 5 条（展开生效、`.` 消解、`..` 消解到 win32 权威落点、未知占位符原样保留=fail-closed、无占位符表项不变） |
| **③** `appops.cli.invoke` outputDir `%USERPROFILE%` 匹配（附带缺陷修复） | ✔ | 真实注册表 `policy.pathAllowlist = ["%USERPROFILE%\\WinVMWorkspace\\out","C:\\WinVMWorkspace\\out"]`；`outputDir=C:\Users\vmuser\WinVMWorkspace\out` → **ALLOW**；`C:\Users\other\WinVMWorkspace\out` → **DENY `pathAllowlist:miss`**；`appops.workflow.run` 同款条目非 miss。长期守卫落在 `p0-path-traversal`（能力级 1 条）+ `policy.test.js`（真实注册表 2 条）；`cl017-param-value` **34/34**、`cl017` **12/12** 零波及 |
| **④** `verifyChain()` 含 `scope` + `shards*`，且 `valid` 判定与旧版逐字一致 | ✔ | 复刻 HEAD `4983a58` 判定体为 `legacyVerify()`，五字段（valid/brokenAt/reason/entries/checked）投影后 `JSON.stringify` **逐字相等**，四场景各验一次：正常链 `valid:true` / 篡改 `false@2 HASH_MISMATCH` / seq 跳号 `false@4 SEQ_GAP` / seq 重复 `false@2 SEQ_DUP`；范围透出：非 freshChain → `scope:'full'`、`1/1/0`；freshChain + 1 个历史断链片 → `scope:'session'`、`shardsTotal=2 / shardsVerified=1 / shardsArchived=1` 且 `valid` **不被历史断链拖累**；`tests/unit/audit.test.js` **25/25** 未回归（旧消费方零改动即编译+通过） |
| **⑤** `verifyArchive()` 断裂历史片报 `brokenAt` 且不抛 | ✔ | 不抛（`threw===null`）；`seq 1→3` 跳号的历史片 → `{valid:false, brokenAt:3, reason:'SEQ_GAP', entries:2}`；本轮活跃片被排除；**O-8 关键对照**：被轮转切断的连续链（首条 `prevHash` 指上一片尾条、`seq` 从 10 续起）→ **该片 `valid:true`**（不出现设计点名的「全红」噪音，见 D-12）；片内中间条被改 → `false@6`；**首条被改** → `false@20 HASH_MISMATCH`（自洽性单查，不留篡改盲区）；有界 3 条（31 片默认只校验 30、显式 5 生效、非法 0 回退默认）；空分片 `entries:0 valid:true`；不存在目录 → `[]` 不抛 |
| **⑥** `applyBearerHeader` 三态 | ✔ | 态1 无 tokenEnv / 空串 tokenEnv ⇒ 原 header **逐字不变**且不含 `authorization`；态2 有值 ⇒ `authorization: 'Bearer <token>'`（保留其它头、env 值覆盖调用方同名头）；态3 有名无值三形态（缺席 / 空串 / `undefined`）⇒ 全部抛 `TransportError: 未找到 bearer token 环境变量：<name>（禁止明文配置，需由宿主注入）`；返回新对象不改 readonly 入参；缺省读 `process.env`；**ssh-tunnel 分支**有名无值 ⇒ 抛的是凭据错且错误串中**不含**任何隧道失败字样 ⇒ 证明校验前置、未 spawn ssh、无隧道泄漏（D-11） |
| **附** ARCH-18 删除面 | ✔ | `packages/*` **代码面**（剥 `//`、JSDoc、schema `description` 后）`commandAllowlist` / `cmdAllowRe` **零命中**；`DEFAULT_POLICY` 运行时形状无该键；`engine.ts` 无读取点 |
| **附** assembly-guard / 锚点 | ✔ | **24/24 fail 0**；内容级复证：`git show HEAD:...engine.ts \| sed -n '769,778p'` 与工作区 `sed -n '795,804p'` 做 `diff` → **空**，两段 `sha256` 同为 `28c99b334498abd0…`（区体因上方插入整体下移 26 行，属行号位移，内容一个字节未动） |
| **附** 其余逐文件 | ✔ | `policy 25`、`protocols 23`、`r19b-s1 35`、`r19b-s5 39`、`r19c-a5 22`、`k5-replay 41`、`cl019-health-ageMs 14`、`cl018-config 7`、`cl018-constants 11`、`cl017-param-guard 10`、`cl017-psmod-sort 6`、`cl017-winget-parse 6`、`oh-tunnel 19`、`tunnel-mode 15`、`tunnel-daemon 10`、`host-a2a-bridge 35`、`deploy-conn-side 3` —— **全部 fail 0** |

> （本节原有的「早期一次性脚本」证据表已由 §10.1 复跑取代并删除：D-11/D-12 修正了 `verifyShardIntraChain` 的片内基线与 ssh-tunnel 凭据校验时序，旧表里 `brokenAt:2 / CHAIN_BREAK`、`n=30` 等结论对应的实现已不是终局代码，保留会自相矛盾。旧脚本 `t2-verify-policy.mjs` / `t2-verify-chain-transport.mjs` 仍在 `$HOME/wbtmp/` 可复核，但**以 §10.1 为准**。）


## 11. 偏差清单（D-N，按源码事实继续，未停等）

- **D-7（行号漂移）**：`config/index.ts` 的 `expandEnvPath` 实测在 **`:180-182`**，设计表写 `:140-142`；`chain.ts` 的 `ChainVerification` 实测 `:107`（设计 `:87-95`）、`verifyArchive` 相关区实测 `:347` 起（设计 `:310-364`）。均为 T1 提交后的行号位移，语义锚点一致。同型：`engine.ts` 四处编译点本次实测未漂移，但改动后区体整体下移 26 行（锚点区亦随之位移，内容未变）。
- **D-8（测试归属与设计表不符）**：§7.4-T2 ③ 写「`cl017-param-value.test.js`/policy 用例需覆盖」，但 `cl017-param-value` 的既有主题是**入参值层面契约校验**（type/enum），无路径策略面夹具，硬塞会破坏该文件的单一职责。按「或」条款落到了 `policy.test.js`（真实注册表 2 条）+ `p0-path-traversal.test.js`（能力级 `%USERPROFILE%` 1 条），覆盖等效且更贴题。`cl017-param-value` 34/34 未回归作为「零波及」证据。
- **D-9（上一轮已落盘的 T2 改动被本回合复核并修正）**：接手时发现工作区已含 `chain.ts`(+150)、`transport/index.ts`(+52) 及两份测试文件的部分适配（上一回合会话中断但改动已落盘）。逐行复核后：`chain.ts` 的 O-8（片内基线取本片首条 + 首条自洽性单查）、有界与不抛语义**正确**，`transport` 三态**正确**，予以保留；`p0` 适配中发现**一处期望串错误**（`'C:\\Windows'` vs win32 权威 `'C:\\Users\\Windows'`）与**一处缺失 import**（`expandPolicyPathPattern` 未从 `@winvm/core` 导入即被使用），二者本回合修正。**遗留说明**：上一回合的 notes 文件缺失（只有本回合 §0 的开工计划），故 §1–§9 是事后按工作区实况 + `git diff` 逐文件重写，可能与原始执行顺序的记述粒度有差异。
- **D-10（刻意破坏性的测试面波及，已在 §9 处置）**：`defaults.ts` 收紧使 `tests` 内 16 处「Users 树内 ⇒ ALLOW」前提失效，属 §1.5-3 预告项而非回归。口径 = 钉 `USERPROFILE` 基准 + 样例改基准账户；未放宽任何默认值。
- **D-11（bearer 校验前置到建隧道之前，设计层未规定时机）**：设计 §7.3-T2 与 `transport.ts` 契约注释只要求「ssh-tunnel 分支消费 `tokenEnv`」，未规定校验时机。实现把 `applyBearerHeader` 调用**前置**到 `establishSshTunnel` 之前 —— 否则态 3（有名无值）抛错时隧道子进程已起而调用方拿不到句柄，`close()` 永不执行 ⇒ 泄漏 SSH 隧道。这是 fail-loud 的必要装配次序。★ 本条是**本回合实测发现并修正**的：前置写法落地前，证据脚本 `establishTransport({kind:'ssh-tunnel', tokenEnv:'WINVM_T2_NO_SUCH'})` 抛出来的是 `SSH 隧道进程提前退出（目标 nobody@127.0.0.1）… Connection refused` 而**不是**凭据错 —— 即「先建隧道、后验凭据」的顺序会既泄漏隧道、又把凭据故障伪装成网络故障。修正后同一断言通过（错误串中不含任何隧道字样）。
- **D-12（`verifyShardIntraChain` 片内基线修正 —— 若不修，归档校验必「全红」）**：设计 §1.3-1 只写了「跨片首条 prevHash 不比对」，未规定片内基线怎么取。落地时先按字面写成 `expectedPrev = GENESIS` / `lastSeq = 0` 起步，证据脚本立刻打红：**一条被轮转切断的连续链**（第 2 片首条 `prevHash` 指向第 1 片尾条、`seq` 从 4 或 10 续起 —— 这是真实归档分片的**常态形态**）被判 `valid:false`。这正是 O-8 点名的「否则全红」，只是从 prevHash 维度换到了 seq 维度。裁断：**片内基线取自本片首条**（`expectedPrev = first.hash`、`lastSeq = first.seq`），「接不上上一片」不算断裂；同时**补一条首条自洽性检查**（存储 hash vs 内容重算）⇒ 「只改首条内容」不留篡改盲区。修正后：轮转形态 `valid:true`；`seq 1→3` 跳号片 → `brokenAt:3 SEQ_GAP`；中间条被改 → `brokenAt:6`；首条被改 → `brokenAt:20 HASH_MISMATCH`。此裁定属实现层，**请主理人核验时特别过一眼**（它决定了 T4 启动归档校验条目将来会不会一片全红）。

- **D-13（★ 需主理人裁定归属：收紧的文案波及面在 §7.3 T5 文件表之外）**：全仓扫描（排除注释性说明）发现 **`skills/winvm-storage-manager/SKILL.md:35`** 仍把「默认路径白名单」写成 `C:\Users\**`、`C:\Temp\**`、`C:\tmp\**`、`C:\WinVMWorkspace\**`、`D:\Data\**` —— 与收紧后的 `defaults.ts` **不再相符**。这条不是纯文档洁癖：skills 会随部署复制到 VM 内（`config/index.ts:149 skillsRoot`），是**VM 内 Agent 的操作指引** ⇒ 它会继续按旧文案去碰别人的账户目录，然后撞上我们新造的策略层硬 DENY，得到一句「路径不在白名单内」而不自知原因。设计 §7.3-T5 的文件表只列了 `docs/02-design/*`、`docs/05-peripherals/DEPLOYMENT.md`、`README.md`、`overview.md`，**未含 `skills/`**；`winvm-app-operation/SKILL.md:198` 另有一处「输出目录受 `pathAllowlist`」的表述（那条只讲机制不讲取值，不受本次影响）。**本批未改**（不在 T2 的 7 文件清单内，且 skill 文案属「面与文」批次的 owned 区），请主理人裁定：① 归 T5 一并改（推荐，与 §3.2 文档对齐同一批、口径一次到位）；② 或现在就由我改一行。**残余的同字样式的出现处全部是注释/病灶说明**（`defaults.ts:58`、`engine.ts:157/182/213`，解释旧行为，属刻意保留），不构成第二份生效配置。

## 12. 移交下游（T3/T4/T5 必须知道的事实）

1. **T4（`vm-service`）**：`verifyChain()` 现返回 `scope/shardsVerified/shardsTotal/shardsArchived` ⇒ `buildHealth` 可直接透传进 `HealthStatus.audit`（同名单一定义源在 contracts）。启动 fire-and-forget 调 `audit.verifyArchive()` 落 `ext.kind:'chain-archive-verify'` 壳条目时，用**原始 audit**（不经 `wrapAuditSink`），与 `delegation.start/complete` 同纪律；`maxShards` 缺省即 30（常量 `ARCHIVE_VERIFY_MAX_SHARDS` 已从 `@winvm/core` 导出，别再造同义旋钮）。
2. **T4（`server.ts:1065-1218` bearer 守卫）**：客户端侧 `applyBearerHeader` 已就位，服务端 `createBearerGuard` 判据请复用 `validateServiceConfig` 的双条件口径（`enforceBearer === true` **且** `tokenEnv` 有值 ⇒ 才要求 bearer，O-9）；`AuthMode` 三态已在 contracts。
3. **T5（文档）**：`docs/02-design/CAPABILITY-MODEL.md:235` 仍残留 `"commandAllowlist": []` 示例（**本批未改，属 T5 owned**）；`SECURITY-GOVERNANCE §3.2` 默认白名单需与 `defaults.ts` 新的六条**逐字**对齐；§4.3 哈希链要加「校验范围限定语」（`freshChain` ⇒ `scope:'session'`）。
4. **运维面（刻意破坏性三条之二）**：默认路径白名单已收紧，跨账户访问必须由运维在 `policy.pathAllowlist` **显式追加**（`mergePolicy` 并集只能加不能减）；`%USERPROFILE%` 未注入时该条不匹配 ⇒ 绝对路径一律 DENY（fail-closed，不是 bug）。★ **交付层已实测无覆写**：`delivery/vm-service.config.json` 的 `policy` 块只有一个 `comment` 键（`Object.keys ⇒ ['comment']`），全仓 `delivery/` 与 `vm-service/src` 均无 `pathAllowlist` 出现 ⇒ 收紧在真实装配里**确实生效**（若那里写着 `C:\Users\**`，并集语义会让默认收紧当场被悄悄放宽 —— 这条已核，QA 不必再查）。VM 上 `%USERPROFILE%` = `C:\Users\winvmuser`，与 `config/index.ts:147` 的 `outputDir: '%USERPROFILE%\\WinVMWorkspace\\out'` 及 `delivery:28` 同源一致 ⇒ 生产工作流不破。
5. **附带缺陷修复事实**：模式侧 `%ENV%` 展开现已对**全局四表 + 能力级两表**全部生效，此前恒不匹配的 `appops.cli.invoke` / `appops.workflow.run` 类能力级白名单条目现已真正参与判定 ⇒ T5 交付说明必须写（收紧与展开是成对动作）。

---

## 13. 全局一致性审查（所有文件写完后，唯一一次）

- **依赖方向**：`policy/engine.ts` 只 import `../constants.js`（L1a 叶）与 `./defaults.js`，**未** import `config/index.js` ⇒ 无 policy→config 包内边；`constants.ts` 只 import `@winvm/contracts` 类型 ⇒ 无环。`chain.ts` 的类型来自 contracts（L0）⇒ 单向。
- **接口契约**：`AuditSink.verifyArchive?(maxShards?: number): Promise<readonly ArchiveVerification[]>`（契约）与 core 实现签名一致；`ChainVerification` 的 4 字段均 `?:`（纯附加），旧消费方（`audit.test.js`、`server.ts:1274`）零改动即编译通过。
- **单一事实来源**：`ArchiveVerification` 全仓仅 contracts 一份（core 再导出，`grep -c "export type { ArchiveVerification }" chain.ts` = 1，`index.ts` 从 `@winvm/contracts` 取）；`expandEnvPath` 全仓仅 constants 一份（config 再导出）；`authorization` 拼装仅 `applyBearerHeader` 一处。
- **`ext`/headers 写入纪律**：链上新增字段全部经 `...scopeInfo` 条件展开（`scopeInfo` 失败返回 `{}` ⇒ 绝不写出显式 `undefined`，规避 `canonicalJson` 的 undefined→null 假断链坑）；传输 headers 返回新对象、不改调用方 `readonly` 入参。
- **静态守卫复证**：`assembly-guard`（锚点切片）、`p0` §5 变异自检（X1/X2/X3/X4 + 只读自证 `ENGINE_HASH`）、`r19c-a5`（`cancelRequested` 计数）全部绿 ⇒ 本批注释/代码未污染任何扫描面。
- **重复实现检查**：`cmdAllowRe`/`commandAllowlist` 在非注释代码中零残留；`globToRegex(normalizePath(...))` 旧写法在四处编译点已全部替换（grep 复证仅 `pathCandidates`/入参侧 `normalizePath(candidate)` 保留，属**入参侧**通路，判据 3 要求它至少出现 2 次，实测满足）。

**IS_PASS: YES**

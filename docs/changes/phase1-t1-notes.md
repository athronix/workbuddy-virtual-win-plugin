# Phase 1 · T1 契约与配置基座 —— 工程师实施笔记（寇豆码）

> 任务板 #74。权威设计：`docs/changes/phase1-arch-design.md`（§7.3 T1 任务卡 / §7.4 T1 验收判据 / §8 共享知识）。
> 基线：`1e1d867`（Phase 0）+ `6f56c12`（设计落盘）。
> 纪律：纯附加可选字段一律 `?:`；链/JSON 写入用条件展开；不碰 `engine.ts:769-778` 锚点；不碰 `server.ts`（T4 独占）；无 git 写操作；无新增依赖；不改 `package.json`/lockfile/tsconfig。

## 0. 开工前基线证据（离线口径）

| 判据 | 命令 | 结果 |
|---|---|---|
| 全 workspace 编译 | `node node_modules/typescript/bin/tsc -b tsconfig.build.json` | **exit 0**（改动前基线绿） |
| `policy.test.js` | `node --test tests/unit/policy.test.js` | 22 pass / 0 fail |
| `cl018-config.test.js` | `node --test tests/unit/cl018-config.test.js` | 7 pass / 0 fail |
| `protocols.test.js` | `node --test tests/unit/protocols.test.js` | 23 pass / 0 fail |
| `r19b-s1-registry-forms.test.js` | `node --test tests/unit/r19b-s1-registry-forms.test.js` | 35 pass / 0 fail |

**测试装载纪律**：逐文件 `node --test <file>`，绝不整批 glob（Phase 0 教训：`link-workspace` junction 触发 `0xC0000005` 假全红）。收尾的全仓回归用「逐文件 spawnSync 串行」脚本（等价 `npm run test:unit` 的装载方式），同样不是 glob 批量装载。

## 1. 源码事实核对（动手前 re-read，含行号漂移）

| 设计锚点（基线读数） | 实测 | 结论 |
|---|---|---|
| `bridge.ts` `ProgressSink:315-320` | `:315-320` | 一致 |
| `bridge.ts` `AuditSink.verifyChain:366-370` | `:366-370` | 一致 |
| `bridge.ts` `HealthStatus.audit:131-138` | `:131-138` | 一致 |
| `audit.ts` `AuditExt.kind:73` | `:73` | 一致 |
| `capability.ts` `−commandAllowlist:26-27` | `:26-27`（注释+字段） | 一致 |
| `transport.ts` `SshTunnelTransport:11-29` | `:11-29` | 一致 |
| `capability.schema.json` `−commandAllowlist:50` | 实测 **`:54`**（`:50` 是 `policy` 对象键自身） | 纯行号漂移 |
| `config/index.ts` `SecurityConfig:65-70` | `:65-70` | 一致 |
| `config/index.ts` `validateServiceConfig:201-231` | `:201-231` | 一致 |
| `delivery/vm-service.config.json:58-61`（security 块） | `:58-61` | 一致 |

### `commandAllowlist` / `cmdAllowRe` 全仓消费点清点（grep 实测，`/dist/` 为编译产物不计）

| 位置 | 性质 | T1 动作 | 归属 |
|---|---|---|---|
| `contracts/src/capability.ts:27` | 契约字段声明 | **删** | T1 |
| `contracts/schemas/capability.schema.json:54` | JSON Schema 属性 | **删** | T1 |
| `vm-capabilities/src/registry/definitions.ts:415` | **全仓唯一写入点**（`appops.workflow.run` 能力声明） | **删该键**（见偏差 D-2） | T1 |
| `core/src/policy/defaults.ts:18/84/137` | `PolicyConfig` 声明 / 默认值 / merge 行 | 不动 | T2 |
| `core/src/policy/engine.ts:526/539` | `cmdAllowRe` 声明与编译（除赋值外零读取 ⇒ 死字段确证） | 不动 | T2 |

⇒ 引擎**从未读取** `capabilityPolicy.commandAllowlist`（`engine.ts` 只读 `pathDenylist:594` / `commandDenylist:616` / `pathAllowlist:638` / `registry*Allowlist:681` / `processDenylist:711`）。
⇒ T1 删除范围自洽：契约 + schema + 唯一写入点，零残留消费方，与 §5 第 7 条断言逐条对上。
⇒ 锚点核对：T1 未触碰 `engine.ts`（`git diff --stat` 证实 engine.ts 不在改动清单内）。

## 2. 逐文件实施记录

### 2.1 `packages/contracts/src/bridge.ts`（+145 / −2）

- **`ProgressSink`**：`+isCancelled?(): boolean`、`+cancellationSignal?: AbortSignal`（均纯附加可选）。文档写明协作式取消语义、缺席即旧行为、消费纪律（`sink.isCancelled?.() === true` + `makeError('TASK_CANCELED', …)` 收口，不得静默成功）。
- **`AuditSink`**：`verifyChain()` 返回形状附加 `scope/shardsVerified/shardsTotal/shardsArchived`（与 `HealthStatus.audit` 同名同义，T4 直接透传）；新增 **可选** 成员 `verifyArchive?(maxShards?)`（设计 §3 类图与 §1.3-2 文字不一致，取可选并记 D-1）。
- **新增 `ArchiveVerification`（契约层）**：`verifyArchive` 的返回元素类型。设计类图把它标在 `core/audit/chain.ts`（L1a），但 `AuditSink` 在 L0 ⇒ 引用 L1a 类型会形成 contracts→core 反向依赖，违反 §8 依赖方向铁律。故权威定义落在 contracts，core（T2）再导出。见偏差 D-4。
- **`HealthStatus.audit`**：附加四范围字段（全部 `?:`）。
- **`HealthStatus`**：新增 `security?: SecurityHealth`（ARCH-07 §1.4-3）、`tasks?: TasksHealth`（ENG-08 §1.6-2 / §5 第 5 条默认「透出」）。配套导出 `AuthMode` 三态联合与两个接口。
- 命名核对：`AuthMode` / `SecurityHealth` / `TasksHealth` / `ArchiveVerification` 全仓 **零同名冲突**（grep 证实）⇒ `contracts/src/index.ts` 的 `export * from './bridge.js'` 无歧义，索引文件无须改。
- 锚点纪律：注释刻意**不复述** `cancelRequested` 字面量 —— 静态守卫 `r19c-a5-approval-coordinator.test.js` C3 会全仓扫描 `packages/*/src` 的 `cancelRequested` 出现点并断言恰 3 处（见偏差 D-5，首轮即被该守卫打到、已改）。

### 2.2 `packages/contracts/src/audit.ts`（+43 / −1）

- `AuditExt.kind` 联合：`+ 'approval-decision'`、`+ 'chain-archive-verify'`。
- 新可选成员 `decision?: 'approved'|'rejected'|'timeout'|'canceled'`（ARCH-05 §1.2-2；文档写明判据顺序 canceled>timeout>rejected、`'approved'` 本批不落链仅预留）。
- 新可选成员 `archive?: { shardsTotal; shardsVerified; broken: readonly string[] }`（ARCH-06 §1.3-2）。
- 沿用既有「写入方必须条件展开 `...(x ? { ext: x } : {})`、禁止显式 `undefined`」纪律注释。

### 2.3 `packages/contracts/src/errors.ts`（+26 / −1）

- `BridgeErrorCode` 追加成员 `'TASK_CANCELED'`（设计 §1.1-1 把 `GoalResult.error.code` 的 `'TASK_CANCELED'` 表述为「无需改 `BridgeError` 形状」，但 `code` 是封闭字面量联合，不扩枚举则 T3/T4/T5 任何 `makeError('TASK_CANCELED', …)` 都编译不过。见偏差 D-1′）。
- `DEFAULT_RETRYABLE` 补 `TASK_CANCELED: false` —— `Record<BridgeErrorCode, boolean>` 是穷举映射，不补则 **tsc 直接报错**；取值理由写进注释（取消不可自动重试，重跑必须重新发起委派并重新过审批闸）。既有 10 码取值逐字不变。
- 注释明确 `'AUTH_REQUIRED'` **不**进本枚举（只作 HTTP 层 JSON 体，§8 错误码风格），避免下游误加。

### 2.4 `packages/contracts/src/capability.ts`（+21 / −3）

- 删除 `CapabilityPolicy.commandAllowlist`（ARCH-18 终裁＝删除，不留 `@deprecated`）。
- 类型头注释登记「为什么删而不实现」三条理由（识别启发式既漏又误 / 非空白名单随机 DENY 生产流程 / `input.app` enum + `validateParams` 是更强的既有机制），并给出兑现后口径：命令面只有黑名单，解释器准入由注册表枚举 + 登记期校验把守。

### 2.5 `packages/contracts/schemas/capability.schema.json`（+1 / −1）

- `policy.properties` 删 `commandAllowlist`；补 `description` 固化新口径。
- **R9 严格性核对**：`policy.additionalProperties` 确认为 `false` ⇒ 旧配置若再写 `commandAllowlist` 会被 schema **直接拒绝**（不是静默忽略）。这一点必须在 T5 文档里写黑（运维手册若还教人配白名单会立刻报错）。

### 2.6 `packages/core/src/config/index.ts`（+82 / −11）

- `SecurityConfig`：`+enforceBearer?: boolean`（默认 false，文档写清「false = 信任边界由回环+SSH 隧道承担」）；`requireLoopbackBind` 注释转为「不可关」语义说明（字段**保留**，采用 §1.4-1 推荐的 ①，不采 ②删除）。
- `validateServiceConfig`：
  - 非回环 ⇒ **恒定 error**（不再看 `requireLoopbackBind` 取值）；
  - `requireLoopbackBind:false` ⇒ warning（「该开关已失效」）；
  - `tokenEnv` 有名无值 ⇒ warning（ENG-05，防「以为开了」）；
  - `enforceBearer:true` 而无 `tokenEnv` ⇒ warning（§4 O-9 双条件缺件显形）。
- **签名附加**：`validateServiceConfig(cfg, env: EnvView = process.env)` —— 「有名无值」判定必须读 env；给默认值 ⇒ 既有单参调用点（`vm-service/src/server.ts:337`，T4 独占文件）**逐字无须改**。属附加可选参数，不违反 T1 边界。
- 文件头「安全红线」注释同步为新语义（旧文案「必须显式 requireLoopbackBind=false 且启动时告警」已失效）。

### 2.7 `delivery/vm-service.config.json`（+1 / −0）

- `:58-61` security 块加 `"comment"`（沿用同文件 `:48` policy 注释的既有形态），把三项事实核对落进配置：回环不可关、tokenEnv 有名无值会 warning、`enforceBearer` 未写=默认 false 及开启前置条件。
- **值逐字未改**（`requireLoopbackBind:true`、`tokenEnv:"WINVM_BEARER_TOKEN"`、未新增 `enforceBearer`）⇒ 现网部署零行为变化。JSON 解析已验证。
- 核对 `delivery/.generated/vm-service.runtime.json`：`git ls-files` 证实**未被版本控制**，且属部署生成物（`install-vm.mjs` 由本文件派生）⇒ 按「不改值」纪律不动。

### 2.8 `packages/vm-capabilities/src/registry/definitions.ts`（+6 / −1）— 超出 T1 文件表的最小必要改动

- 删 `appops.workflow.run` 的 `policy.commandAllowlist` 整行，保留其 `pathAllowlist`，并在原位留注释说明删除依据与替代机制。
- **为什么必须动**：`cap()` 的 `spec.policy` 形参类型是 `CapabilityPolicy`（`CapSpec:50`），传入对象字面量携带已删键 ⇒ TS  excess-property 检查直接**编译失败**，验收判据 ① 无法成立。设计 §1.7 表格本身就把这一行列进 ARCH-18 删除动作表，只是 §7.3 的 T1 文件表未列。见偏差 D-2。

## 3. 验收执行记录（全部离线）

### ① `tsc -b tsconfig.build.json` 全 workspace

```
$ node node_modules/typescript/bin/tsc -b tsconfig.build.json
（无输出）BUILD_EXIT=0        # 12 个包全部重编译，含引用链下游
```

### ② 逐文件跑四个指定测试

```
$ node --test tests/unit/policy.test.js                  → pass 22 fail 0
$ node --test tests/unit/cl018-config.test.js            → pass 7  fail 0
$ node --test tests/unit/protocols.test.js               → pass 23 fail 0
$ node --test tests/unit/r19b-s1-registry-forms.test.js  → pass 35 fail 0
```

（另加跑的相邻回归，全绿）：`assembly-guard 24`、`p0-path-traversal 84`、`audit 25`、`approval-audit 16`、`k4-approval 6`、`k5-replay 41`、`host-a2a-bridge 35`、`cl017-error-reason 10`、`r19c-a5-approval-coordinator 22`、`r19c-kn1-f-chain 16`、`r19c-s4-policy-denied-audit 7`、`setup-env 19`。

**全量相邻回归（同口径逐文件串行，非 glob 批量装载）**：

```
$ node -e "<逐文件 spawnSync(node --test) 脚本>"   # = npm run test:unit 的装载方式
files=71  failedFiles=0  totalPass=1245
```

⇒ T1 的改动（含一处破坏性删除 + 一处破坏性收紧）在**全部 71 个测试文件 / 1245 条断言**上零回归。

### ③ `validateServiceConfig` 手工验证（一次性脚本，用毕即删）

脚本 `$HOME/wbtmp/t1-verify-config.mjs`（`/tmp` 只读，故用 wbtmp；仓库外脚本经 dist 绝对路径 import）：

| 用例 | errors | warnings |
|---|---|---|
| A `{security.requireLoopbackBind:true}` + `server.host:'0.0.0.0'` | **1**「不是回环地址，违反『V1 服务端只允许回环绑定』这条代码不变量…」 | 0 |
| B `server.host:'127.0.0.1'` | **0** | 0 |
| C `'0.0.0.0'` + `requireLoopbackBind:false`（**旧行为=仅 warning** 场景） | **1**（不可关，已升级） | 1「requireLoopbackBind=false 已失效…」 |
| D `DEFAULT_SERVICE_CONFIG` 原样 | **0** | 0 |
| E `tokenEnv` 有名、env 无值 | 0 | 1「…环境变量 WINVM_BEARER_TOKEN 无值 ⇒ bearer 鉴权不会生效…」 |
| F `enforceBearer:true` 无 `tokenEnv` | 0 | 1「…未配置 security.tokenEnv ⇒ 守卫不会生效…」 |
| G `enforceBearer:true` + env 有值 | 0 | 0（不产假告警） |
| H `server.host:'::1'` | 0（视为回环） | 0 |

`ALL ASSERTIONS PASS`。**与旧行为的差异（判据③要求写明）**：C 用例旧实现走的是「非回环 + 开关=false ⇒ 仅 warning、可继续启动」分支，T1 后该分支不存在（恒 error），且 `false` 额外得到一条「开关已失效」warning。

### ④ `capability.schema.json` 删属性后既有注册表校验

- `node --test tests/unit/r19b-s1-registry-forms.test.js` → pass 35 / fail 0（设计指定的守卫）。
- 直证脚本 `$HOME/wbtmp/t1-verify-schema.mjs`：schema `policy` 允许键 = `commandDenylist,pathAllowlist,pathDenylist,processDenylist,registryWriteAllowlist`，`additionalProperties:false`；**54 条**注册表能力逐条核对 policy 键 ⇒ 违例 `(none)`；顶层 13 个 required 键 × 54 能力核对 ⇒ 全通过；`appops.workflow.run.policy` = `{pathAllowlist:[…]}`（白名单键已消失、pathAllowlist 逐字保留）。`ALL ASSERTIONS PASS`。
- 漂移取证脚本 `$HOME/wbtmp/t1-verify-schema-drift.mjs`：对 **HEAD 基线 schema** 与 **工作区 schema** 跑同一套 id/domain 比对 ⇒ `id.pattern` / `domain.enum` 未被 T1 改动，且「不符合 pattern 的能力集合」与基线**逐字相同**（`appops.*` 5 条）。⇒ 判据④「既有注册表校验通过」= **无回归**成立；schema 的 domain 漂移属基线既有问题，见偏差 D-3。

## 4. 偏差登记（设计文档 vs 源码事实；均按源码事实实现）

| ID | 偏差 | 处置 |
|---|---|---|
| **D-1** | 设计 §1.3-2 文字只给 `AuditSink.verifyChain()` 返回附加四字段、**未**提 `verifyArchive`；但同文档 §3 类图把 `+★verifyArchive?()` 画在 `AuditSink` 上。二者不一致。 | 采**类图 + 可选性**：`verifyArchive?(maxShards?)` 定义为**可选成员**。理由：必选会强制 `delegation-audit.ts` 的两个 `AuditSink` 装饰器（`wrapAuditSink:749`、`bypassTagSink:793`）与所有测试桩补齐实现，而那两个文件 T1 无权限、且违反「纯附加 ⇒ 缺席即旧行为」铁律。T4 若需经装饰器透传归档校验，属 T4 的小改动（在装饰器里条件转发）。**请 owner 确认。** |
| **D-1′** | 设计 §1.1-1 称 `'TASK_CANCELED'`「无需改 `BridgeError` 形状」，但 `BridgeErrorCode` 是封闭字面量联合。 | 扩枚举成员 + 补 `DEFAULT_RETRYABLE` 穷举项（后者不补则 tsc 报错）。**形状**（字段集）确实未变，与设计意图一致；旧 10 码取值零变化。`adapter-agent-workbuddy/src/index.ts:33` 的本地 `BRIDGE_ERROR_CODES` 白名单（注释自称「= 契约层 10 码」）T1 **未动**：它只用于 PS 领域码归一，取消码不经该路径；加不加都不影响任何判据，且该文件属 T5 独占。建议 T5 顺手同步注释与列表。 |
| **D-2** | `ARCH-18` 删除动作涉及**三个**代码点（契约 / schema / 唯一写入点 `definitions.ts:415`），但 §7.3 的 T1 文件表只列了前两个。 | 按 §1.7 表格（该表**列了** `definitions.ts`）与编译事实，T1 一并删 `definitions.ts:415` 那一行 —— 不删则 `spec.policy` 字面量触发 excess-property 错误，验收判据① 不可能成立。改动严格最小化（1 行 + 说明注释），未触碰该文件任何其它内容。T2 接手 `defaults.ts`/`engine.ts` 时不冲突（不同文件、不同符号）。 |
| **D-3** | 基线事实：`capability.schema.json` 的 `domain.enum`（缺 `appops`）与 `id.pattern`（缺 `appops`）**早已**与注册表 5 条 `appops.*` 能力不符；且全仓**无任何** JSON Schema 校验器消费该 schema（grep `capability.schema` 仅命中 `setup-env.test.js` 的「随行资产存在性」断言与文档）。 | T1 **不修**（不在任务卡范围、且属独立契约漂移），只在验收里以「与基线逐字相同的违规集合」证明删属性未引入回归。**建议**：登记为 Phase 2 死配置/漂移清扫项（与 §1.6 的 `approvalTimeoutMs` 死字段同批），或单开一条「schema 是否接入运行期校验」的裁断。当前状态的风险面 = schema 只是文档产物，`additionalProperties:false` 的拒止能力未在任何运行路径兑现。 |
| **D-4** | 类图把 `ArchiveVerification` 标在 `新增 core/audit/chain.ts`（L1a），但它是 L0 契约成员 `AuditSink.verifyArchive` 的返回类型。 | 权威定义落 `contracts/src/bridge.ts`（保依赖方向单向），`core`（T2）以 `export type { ArchiveVerification } from '@winvm/contracts'` **再导出**、不得复制同形结构。已写入契约注释，供 T2/T4 遵守。 |
| **D-5** | 静态守卫 `r19c-a5-approval-coordinator.test.js` C3 会全仓扫 `packages/*/src` 并断言 `cancelRequested` 恰 3 处；首轮我在 `ProgressSink` 病灶注释里**引用了该字面量** ⇒ 实测 4、守卫红。 | 改写注释、不复述字面量（语义不损失，改为「任务记录上的取消标志位」并指向该守卫文件名）。改后 C3 绿。教训登记：**注释文本也是静态守卫的输入面**，跨层写病灶说明前必须先 grep 同名静态断言。 |
| **D-6** | `delivery/vm-service.config.json` 加 `"comment"` 键后，配置对象多一个非 `SecurityConfig` 声明键。 | 经核对：`loadServiceConfig` 对 security 段做的是 `{...DEFAULT, ...parsed.security}` 展开 ⇒ `comment` 会透传进 `ServiceConfig.security`；`validateServiceConfig` 无未知键拒止；TS 侧 `Partial<ServiceConfig>` 的 JSON 来源不产生 excess-property 错误（运行时 JSON.parse）。同文件 `policy` 段**已有**同一先例（`:48`）⇒ 属既有范式，非新风险。已实测 `cl018-config` + 现网默认校验零 error。若 owner 偏好「配置零冗余键」，可改为把 `comment` 移到顶层 `comment` 兄弟位（一行回移动作）。 |

## 5. 全局一致性审查（跨文件）

- **增删统计**（`git diff --numstat`，仅代码/配置，笔记文件不计）：见 §6 表。
- **契约→实现流向核对**：`SecurityConfig.enforceBearer`（契约面）→ 消费点在 `validateServiceConfig`（本批已读）与 `vm-service/http-guard.ts`（**T4 新建**）；`SshTunnelTransport.tokenEnv` → 消费点在 `core/src/transport/index.ts` 的 ssh-tunnel 分支（**T2**）；`AuditSink.verifyArchive` / `ChainVerification.scope*` → 实现在 `core/src/audit/chain.ts`（**T2**）、透出在 `server.ts buildHealth`（**T4**）；`ProgressSink.isCancelled/cancellationSignal` → 实现在 `task-store.createProgressSink`（**T3**）、消费在两个 provider（**T5**）。⇒ T1 只落契约面，全部下游引用点均已就位且不编译破损（判据① 已证）。
- **无重复实现**：`ArchiveVerification` 全仓唯一定义（contracts）；`AuthMode` / `SecurityHealth` / `TasksHealth` 无第二处声明；`tokenEnv` 语义在 transport 与 config 两处均为「变量名」而非值，未引入第二份取值逻辑。
- **无新增依赖 / 未改 package.json / lockfile / tsconfig**：`git diff --stat` 未含这些文件。
- **锚点未动**：`core/src/policy/engine.ts`、`packages/vm-service/src/server.ts`、`server.ts:1400-1481` dry-run 三函数、`freshChainOnStart:true` 均**不在改动清单**内。`assembly-guard.test.js` 24/24 绿。
- **`exactOptionalPropertyTypes:false`**（`tsconfig.base.json`）⇒ 显式 `undefined` 仍会污染落盘形态（`canonicalJson` 把 undefined → null 的假断链坑），故契约注释里把「一律条件展开」写死在每个新增可选成员的文档上。

## 6. 交付清单

| # | 文件 | +行 | −行 | 性质 |
|---|---|---|---|---|
| 1 | `packages/contracts/src/bridge.ts` | 145 | 2 | 纯附加（ProgressSink×2 / AuditSink×2 / HealthStatus×6 / 新类型×3） |
| 2 | `packages/contracts/src/audit.ts` | 43 | 1 | 纯附加（kind×2 / decision / archive） |
| 3 | `packages/contracts/src/errors.ts` | 26 | 1 | 纯附加枚举（TASK_CANCELED + 穷举映射项） |
| 4 | `packages/contracts/src/capability.ts` | 21 | 3 | **破坏性删除**（commandAllowlist） |
| 5 | `packages/contracts/schemas/capability.schema.json` | 1 | 1 | **破坏性删除**（同键的 schema 面） |
| 6 | `packages/core/src/config/index.ts` | 82 | 11 | 附加 + **破坏性收紧**（非回环恒 error） |
| 7 | `delivery/vm-service.config.json` | 1 | 0 | 注释性核对（**值未改**） |
| 8 | `packages/vm-capabilities/src/registry/definitions.ts` | 6 | 1 | 破坏性删除的唯一写入点（超表最小必要，见 D-2） |
| — | 合计 | **344** | **20** | 设计预估 ~120/15；差额主要是契约字段文档注释（「为什么这样设计」按仓库既有风格逐字段写全）与 D-2/D-4 两项必要补充 |
| + | `docs/changes/phase1-t1-notes.md` | 203 | — | 过程纪律产物（未纳入 git，由主理人统一提交） |

（`git status --short` 核对：工作区仅上述 8 个受控文件为 `M` + 本 notes 为 `??`；无 `git add/commit` 动作，符合只读纪律。`git diff --numstat` 读数即上表。）

**临时脚本**（均在 `$HOME/wbtmp/`，用毕即删）：`t1-verify-config.mjs`、`t1-verify-schema.mjs`、`t1-verify-schema-drift.mjs`。

## 7. 移交下游的契约事实（T2/T3/T4/T5 必读）

1. **`ArchiveVerification` 的唯一权威在 `@winvm/contracts`**；T2 在 `core` 侧**再导出**，不要复制定义。
2. **T2 的 `defaults.ts` 删 `PolicyConfig.commandAllowlist` 后，`engine.ts:539` 的 `this.cmdAllowRe = base.commandAllowlist.map(...)` 会编译失败** ⇒ 同批删除 `:526` 声明与 `:539` 编译（正是 T2 任务卡的既定动作，顺序上无阻塞）。
3. **`HealthStatus.security` / `tasks` 与 `audit` 四字段是可选** ⇒ T4 的 `buildHealth` 用条件展开写入（`...(x ? { security: x } : {})`），**不得**显式 `undefined`。`/health` 不经哈希链，但同一纪律统一执行以防误用。
4. **`AuditSink.verifyArchive` 是可选成员** ⇒ 任何调用点必须 `sink.verifyArchive?.()`，`undefined` 要如实处理为「未校验」，**不得**当作「校验通过」。装饰器（`delegation-audit.ts`）若需透传，属 T4 改动。
5. **`validateServiceConfig(cfg, env?)` 的第二参数**已就位：T4 若要在运行期把 authMode 三态报准，可复用同一判据（`enforceBearer===true && env[tokenEnv]` 非空），不要另写一份。

**IS_PASS: YES**

# V-NEXT 执行计划（逐步 · 每步可验证 · 含收口检查）

> 配套 `13-OPTIMIZATION-PROPOSAL.md`（方案）。本文是**施工单**：
> 每一步都有「做什么 / 改哪些文件 / 怎么验收 / 失败了怎么办」。
>
> **纪律**：
> 1. 每步单独可验证 —— 不接受「改完了」这种说法
> 2. 每步单独 commit —— 回滚粒度 = 一步
> 3. **每步必跑 `gate --quick`** —— 并且比对**失败清单**（不只看 VERDICT）
> 4. 基线红（2 个）在阶段 3 之前**允许存在**，但**不允许新增第三个**

---

## 0. 施工前必须记住的执行模型（owner 2026-11-24 澄清）

> **任何一步动工前先读这一节。** 它决定「什么能删、什么绝不能删」。
> 完整版见 `13-OPTIMIZATION-PROPOSAL.md` §1.0。

### 0.1 两条路径并存

| 路径 | 触发条件 | 执行主体 | 与宿主交互 |
|---|---|---|---|
| **路径 1 · 直调** | 简单任务 | 宿主 WorkBuddy 按 skill 指引直接调 `/mcp` 的 54 个能力 | 每次调用都可见、可审批 |
| **路径 2 · A2A 委派** | 复杂任务 | **VM 端 WorkBuddy 内的 codebuddy-lite CLI（native agent）** | 仅收终态 + 阶段性产物，**VM 内闭环** |

### 0.2 三条不可违反的事实（源码实证，改动前必须核对）

| # | 事实 | 施工含义 |
|---|---|---|
| **M-1** | 路径 2 **不是直连 LLM API**，是 VM 本机 WorkBuddy 的 **native agent**（`codebuddy` CLI，`bridge.ts:945`） | ⚠ **绝不删 `bridge.ts`(1892) / `persistent-session.ts`(1144)** —— 那是路径 2 的全部实现 |
| **M-2** | VM 内 CLI **回连 vm-service 的 MCP** 来调工具（`buildMcpConfig()` 注入 `mcpServers.winvm.url`，`bridge.ts:260`） | 改通道/工具面时**必须同时保证 CLI 的回连路径不被切断** |
| **M-3** | VM 内 CLI **同样吃 plugin 的 skill 指引**（`skills/` → `C:/WinVMBridge/shared-skills`，`config/index.ts:189`；prompt 在 `bridge.ts:495-502`） | 删/改 `skills/` 会**同时**影响两条路径，不是只影响宿主 |

### 0.3 新增施工步：**3.6a / 3.6b · 两端能力面对齐**（**分期执行，顺序相反**）

所有者的硬要求：**「鸿蒙宿主 WorkBuddy 与 VM 内 codebuddy-lite，都要能看到并访问「对 Windows 操作的
全部 skill 指引」与「全部 mcp-service」——两端都能调用所有 MCP。」**
现状两端都不满足，且缺口相反：宿主工具面齐、技能面齐；VM 侧两者各缺一块。

| 子步 | 项 | 内容 |
|---|---|---|
| **3.6a** | **技能面**（VM 侧 7 个 skill → 9 个） | |
| | 问题 | `delivery/deploy-shared-skills.mjs:40` `HOST_ONLY_SKILLS = ['hos-win-skill','agent-browser-skill','agent-desktop-skill']` 在交付链两段式排除，注释写「VM 内 Agent 绝不应见到它们」 |
| | 证据 | 两个被排除的技能各带 `references/` **33 份**与 **75 份**逐工具参数表 —— 恰是 `browser.*`(33) 与 `desktop.*`(25) 的唯一操作指引 |
| | 改法 | `HOST_ONLY_SKILLS` 收窄为 `['hos-win-skill']`；正文加「端点自适」一行；`D-4` 同步改单测断言 7 → 9 |
| | **顺序** | ✅ **可在阶段 3 之前任意时点做**（纯文档，零执行能力，零风险）。**若只想先拿一件收益，先做这个** |
| **3.6b** | **工具面**（CLI 54 项 → 112 项） | |
| | 问题 | CLI 只拿到 `mcpServers.winvm` 一个条目指向 `/mcp`（54 项），**拿不到 `/mcp/browser`、`/mcp/desktop` 的 58 项** |
| | 证据 | `bridge.ts:260` 只生成一个条目；`config/index.ts:187` endpoint 写死 `/mcp`；`grep mcpPath\|/mcp/browser\|/mcp/desktop` 在 bridge.ts **命中 0** |
| | 改法 | `buildMcpConfig()` 扩成**三个** `mcpServers` 条目（`winvm` / `winvm-browser` / `winvm-desktop`），**三条共用同一 `dtid`**（统一走 `appendDtid()`） |
| | **顺序** | ★ **必须在阶段 3（闸门）完成之后才能做**。闸没补就放开这 58 项 = 给裸奔工具再开一道门，**净增风险** |
| | 详细做法与八条约束 | `13-OPTIMIZATION-PROPOSAL.md` §3.6（P-1 ~ P-7 + P-2b）；`hos-win-skill` 是否下发**已裁定**见 §3.7（owner 2026-11-24：**不下发**） |

> **不要把 3.6a 与 3.6b 捆在一起排期**：一个必须等闸、一个完全不必等。
> 捆一起 = 白白延后一个零风险收益。

### 0.4 每步动工前的三问（**防止把路径 2 改坏**）

1. 这一步动的文件，是**只有宿主用**，还是**CLI 也在用**？（`bridge.ts` / `persistent-session.ts` / `skills/` 都是两者共用）
2. 这一步会不会**切断 CLI 回连 `/mcp` 的路径**？（`endpoint` / `buildMcpConfig` / `isInnerDelegation` 的 `dtid`）
3. 这一步之后，**路径 2 的复杂任务还能不能跑通**？（不能 ⇒ 必须补回或回滚）

### 0.5 第四问（**owner 2026-11-24 新增要求后补**）

4. 这一步之后，**「两端都能看到并访问全部 skill 与全部 MCP」这条要求是更近还是更远了**？
   —— 每次动 `skills/`、`HOST_ONLY_SKILLS`、`buildMcpConfig`、`endpoint` 都要答一遍。
   答"更远"必须写明理由并报 owner，不得默认接受。

---

## 1. 收口检查的定义（贯穿全文）

「收口检查」= 每步结束时必须跑完的**四件套**。少一件不算完成。

```bash
# ① 门禁（必跑，1-2 分钟）
node scripts/gate.mjs --quick

# ② 失败清单比对（关键：不看 VERDICT，看清单）
node scripts/gate.mjs --quick 2>&1 | grep -E "^RED (tests|delivery)" || echo "无 RED 文件"
# ⚠ 必须用 `^RED (tests|delivery)` 这个锚点：汇总行 `RED  guards — …` 也以 RED 开头，
#   不带锚点会把汇总行当成「失败文件」，清单就永远是「2 个」而看不出真文件。
# ⚠ 2026-11-24 前 gate.mjs 的 runPerFile 会**吞掉**失败文件的判定行（详见 15 §4.5），
#   那时这条命令恒返回 0 行。现缺陷已修，输出可信。

# ③ 本步专项断言（每步不同，见各步）
#    —— 必须是可复制的命令，不能是「人工确认」

# ④ git 状态干净（本步的改动都已提交）
"$HOME/.harmonybrew/opt/git/bin/git" status --short
```

**判定规则**：

| 情况 | 判定 |
|---|---|
| VERDICT=GREEN 且失败清单为空 | ✅ 通过 |
| `--quick`（仅 guards 段）RED，清单 = 基线 **2 个**（`phase2-snapshot-truth` + `phase3-skill-claims-guard`） | ✅ 通过（基线红允许） |
| **全量** RED，清单 = 基线 **5 个**（上面 2 个 + `p8-probe-fresh` + `r19c-kn1-e-mutation` + `r19c-kn1-e-shape`） | ✅ 通过（基线红允许） |
| VERDICT=RED，失败清单**新增**了任何文件 | ❌ **立即回滚本步** |
| 专项断言失败 | ❌ 修到通过，或回滚 |

> **「2 个」与「5 个」不矛盾，是两个档位的口径**：`--quick` 只跑 `guards` 段（16 件），
> 全量还多跑 `sweep`（123 件）。别拿 `--quick` 的 2 去对全量的 5。
>
> ⚠ **别用「失败条数」当判据**：同代码连跑实测 `sweep fail=15 / 16 / 15 / 15`，有 ±1 的 flaky。
> 判据只用**文件名集合**。
>
> ### 已知负载敏感项：`phase1-t5-llm-cancel`（2026-11-24 实测登记）
>
> 全量 140 文件并发跑时，该文件的「单次 `-p`：取消信号 ⇒ 子进程真被 SIGTERM 终结」**稳定红**；
> 但单独跑 **3/3 全绿**、与本轮相关的 6 套件同跑 **188/188 全绿**。
> 该用例用 `#!/bin/sh` + `trap` 落盘验证 SIGTERM 透传，与 policy / 审批名单**零交集**，
> 失败点是高负载下 `killLog` 未及生成 —— 属**既有负载敏感用例，不是回归**。
>
> **判定某个红是不是回归，不能只看「全量里红」**，必须做两段对照：
> ① 单独跑该文件；② 与该轮改动相关的套件小范围同跑。
> 两段都绿 ⇒ 负载敏感；任一仍红 ⇒ 真回归，按上面的规矩回滚本步。

> 注：下方「1. 阶段 1」的编号沿用旧文（本节原为 §0），不影响阅读。

---

## 2. 阶段 1：删除（3d，纯减法，行为零变化）

### Step 1.1 · 删 `ssh-tunnel` 死代码（1d）

> **本节的施工前复核已完成（2026-11-23），推翻了三处原判断。** 复核记录见下方「施工前复核结论」，
> 必须先读它再动手 —— 按原表施工会**删掉活着的渲染路径**。

#### 施工前复核结论（三事实 + 一潜伏 bug）

| # | 事实 | 证据 | 对原计划的影响 |
|---|---|---|---|
| **F-1** | `ssh-tunnel` 在 `install-host.mjs` 中**是活跃声明**，渲染器真实执行 | `install-host.mjs:1258` `renderer.plan(plugin, ...)`、`:1269` 逐账户 plan、`:1289` `renderConnectorEntry(plugin.connector, transports[0])` | 「删死代码」的说法**不准确**；删的是 `kind` 这个**字面量分支**，不是「没人用的东西」 |
| **F-2** | 渲染只消费 `localPort`，`host`/`user`/`remotePort`/`identityFile`/`serverAlive*` **六字段零读取点** | `adapter-host-workbuddy/src/index.ts:139` 仅取 `transport.localPort`；`:1393` 写 vm-conn.json 用的是 `connHost/connUser`（来自 `args`，不是 transport） | 声明改成 `streamable-http` 时，**只有 `url` 需要等价替换**，其余六字段可直接丢弃 |
| **F-3** | `establishTransport` 的 `ssh-tunnel` 分支（真建 SSH 连接、真用凭据）**生产永不执行** | 唯一调用方 `host-a2a-bridge/client.ts:62`；其 transport 由 `cli.ts:100 buildTransport()` 构造，`:102` **恒返回** `kind:'streamable-http'` | 这才是真死代码 —— **凭据代码活着，但走不到**。删除零风险 |
| **F-4** | `transportBaseUrl()` / `isRemoteTransport()` **全仓零调用** | `grep -rn "transportBaseUrl\|isRemoteTransport"` 仅命中定义处（`contracts/src/transport.ts:73,84`） | 纯死代码，**整函数删除**，不必只删 `case` |
| **B-1** | 🔴 **潜伏 bug**：`adapter-host-workbuddy:135-142` 的旧 `streamable-http` 分支**无条件**输出 `headers: { Authorization: 'Bearer ${tokenEnv}' }`，`tokenEnv` 为 `undefined` 时渲染成字面量 `Bearer ${undefined}` | `:143` 无 `tokenEnv` 判空 | **直接把声明改成 `streamable-http` 会写出坏 header**，WorkBuddy 侧发 `Authorization: Bearer ${undefined}` ⇒ 若服务端开 `enforceBearer` 则 401。**必须同时给该分支加 `tokenEnv` 判空** |

#### 修正后的施工表

| 文件 | 动作 |
|---|---|
| `packages/core/src/transport/ssh-tunnel.ts` | **删除整个文件** |
| `packages/core/src/transport/ssh-tunnel-ssh2.ts` | **删除整个文件** |
| `packages/core/src/index.ts:14,15` | 删 `establishSshTunnel` / `renderSshCommand` 导出 |
| `packages/core/src/index.ts:25` | 删 `export type { TunnelHandle, EstablishTunnelOptions }` |
| `packages/core/src/transport/index.ts:9,16,82-113` | 删 import / re-export / `case 'ssh-tunnel'` 整块 |
| `packages/core/src/transport/index.ts:27,32` | 删 `existingTunnel?` / `tunnel?`（`ManagedTransport.tunnel` 随之无用） |
| `packages/core/src/transport/types.ts:4` | 注释「三种传输」→「两种传输」，去掉 `ssh-tunnel（默认）` |
| `packages/core/src/config/index.ts:84` | 注释去掉「与 `ssh-tunnel` 两条远程传输分支」→ 只留 `streamable-http` |
| `packages/contracts/src/transport.ts:11-47` | **删 `SshTunnelTransport` interface 整块** |
| `packages/contracts/src/transport.ts:68` | `TransportDecl = StreamableHttpTransport \| StdioTransport` |
| `packages/contracts/src/transport.ts:73-82` | **删 `transportBaseUrl()` 整函数**（F-4：零调用） |
| `packages/contracts/src/transport.ts:84-86` | **删 `isRemoteTransport()` 整函数**（F-4：零调用） |
| `packages/contracts/src/transport.ts:4` | 注释「三种传输」→「两种传输」 |
| `packages/host-sdk/src/index.ts:60-65,95-100,126-131` | 删三处 `if (t.kind === 'ssh-tunnel')` 校验块（顺带 `remotePort/localPort` 校验一并删） |
| `packages/adapter-host-workbuddy/src/index.ts:133-142` | **删 `case 'ssh-tunnel'`**，并把其 `url` 语义（`http://127.0.0.1:${localPort}${mcpPath}`）下沉到 `streamable-http` 调用方 |
| `packages/adapter-host-workbuddy/src/index.ts:143` | 🔴 **B-1 修复**：`headers` 改为 `transport.tokenEnv ? { Authorization: ... } : {}` |
| `packages/adapter-host-workbuddy/src/index.ts:343-352` | `if (transport.kind === 'ssh-tunnel')` 警告块 → 改为向 `streamable-http` 的等价告警，或删除 |
| `packages/adapter-host-workbuddy/src/index.ts:371-375` | postActions 里的条件分支同步删除 |
| `delivery/install-host.mjs:953-961` | **声明改** `kind:'ssh-tunnel'` + 六字段 → `kind:'streamable-http', url: \`http://127.0.0.1:${args.localPort}\``（F-1/F-2） |
| `delivery/install-host.mjs:1211-1219` | 同上（`upstreamTransport`） |
| `packages/host-a2a-bridge/src/cli.ts:100-109` | 保留 `buildTransport()`（已是 `streamable-http`），注释里「SSH 隧道映射到本机」保留即可 |
| `scripts/config-key-lint.mjs:181` | 注释里的 union 示例去掉 `SshTunnelTransport`（**注释不是白名单来源**，但白名单解析器会读 `TransportDecl` 的右值文本，改后仍能解析） |
| `tests/unit/`（**5 个文件**） | `host-adapter:61` / `phase1-t5-cancel-consume:512,518` / `phase1-t5-token-env:102-133` / `mcp-upstream-connectors:23` + 1 处（施工时逐个确认） |

> ✅ **不动的**：`delivery/oh-tunnel.mjs`（**唯一真实隧道实现**）、`delivery/tunnel-daemon.mjs`、
> `delivery/ssh2-*.mjs`（通道运行时）、`deploy/skills/.../ssh2-conn.mjs`（部署 skill 自带，
> 由 `p7-ssh2-conn` 守卫件保护，与 core 的 ssh-tunnel 是**两套不同东西**）。
> `delivery/pack-release.mjs:724,868` 里的 `--remove-ssh-tunnel` 是**部署 skill 的参数名**，
> 与 core 死代码无关，**不改**（改了会破坏 pack-release 的 V11 断言）。

> ⚠ **原计划最危险的一处**：原表写「删 `transports` 数组会让 `validate()` 报缺 transports」是对的，
> 但漏了 F-1 —— 该声明**正在被渲染并写进 WorkBuddy 的 `mcp.json`**。所以动作是**改字面量 + 保结构**，
> 而非「删一个没人用的分支」。改完必须用 `renderConnectorEntry` 的**输出 diff** 验证 `url` 未变。

**验收**

```bash
# ① 源码零残留（含 contracts 两个死函数）
grep -rn "ssh-tunnel\|SshTunnelTransport\|establishSshTunnel\|renderSshCommand\|transportBaseUrl\|isRemoteTransport" \
  packages/*/src/ tests/ 2>/dev/null | grep -v node_modules | grep -v "/dist/"
# 期望：0 行

# ② 类型仍能编译
node_modules/typescript/bin/tsc -b tsconfig.build.json
# 期望：退出码 0

# ③ ★ 渲染等价性（本步唯一的行为断言，比 tsc 重要）
node -e '
const {renderConnectorEntry}=require("./packages/adapter-host-workbuddy/dist/index.js");
const e=renderConnectorEntry(
  {id:"winvm",timeoutMs:120000,disabledTools:[],transports:[]},
  {kind:"streamable-http",url:"http://127.0.0.1:18443"});
console.log(JSON.stringify(e));
'
# 期望：url 恰为 http://127.0.0.1:18443/mcp 且 **无 headers 键**（验证 B-1 已修）

# ④ 四件套
node scripts/gate.mjs --quick
# 期望：RED 仍为 phase2-snapshot-truth + phase3-skill-claims-guard 两条，不新增
```

**失败预案**
- `tsc` 报「TunnelHandle 未定义」→ 还有引用点，`grep -rn "TunnelHandle" packages/`
- `validate()` 报「未知 kind」→ `install-host.mjs:953` 改漏
- 渲染结果里出现 `Bearer ${undefined}` → B-1 未修，回到 `adapter-host-workbuddy:143`
- `config-key-lint` 报「白名单不可得 → exit 2」→ `TransportDecl` 右值没改干净，解析器找不到 union 分支

---

### Step 1.2 · 删 `SkillDomain` + `domains`（1d）

**做什么**

**(Step 1.2 已执行 2026-11-23，两处修正见下)**

| 文件 | 动作 |
|---|---|
| `packages/contracts/src/host.ts:20` | 删 `export type SkillDomain = 'system' \| 'app' \| 'storage' \| 'gui'` |
| `packages/contracts/src/host.ts:34` | 删 `readonly domains?: readonly SkillDomain[]` |
| `packages/host-sdk/src/skill-loader.ts:11,18,29,125-130,202` | 删 `SkillDomain` import、`domains?` 字段、`VALID_DOMAINS` 常量、frontmatter 过滤块、bundle 透传 |
| `tests/unit/host-adapter.test.js:436,448` | **改**：`frontmatter.domains` 断言 → 行内数组覆盖转到 `triggers`/`relatedSkills`；**新增**一条「domains 被静默忽略」正向钉 |
| ~~`skills/*/SKILL.md`（8 个）~~ | ❌ **修正：不改**（见下） |

> **修正 1：`skills/*/SKILL.md` 里的 `domains:` 行一律不动。**
> 原计划要删 10 个（`grep -l "^domains:"` 只列出 8 个，另 2 个 skill 的 frontmatter 格式不同）。
> 但删它**没有任何收益**（不是事实源、没人读），
> 却要动 8 个带 frontmatter 的文档文件 —— 而 `phase3-skill-claims-guard` 正在对
> `skills/**` 做点分 token 对账，改动这些文件会引入**无关的红**，把真正的门禁信号搅浑。
> 保留后行为完全一致：未识别的前置键被解析器静默跳过（已用新增钉子钉死）。
> **"删字段"的目的是消除第二份事实源，不是清空文档**——字段已从类型与解析器消失，
> 文档里那行字就成了纯注释，后续任何人读 SKILL.md 也不会被误导（注释里已写明）。

> **修正 2：`contracts/host.ts` 里 `SkillDomain` 的删除要连带 `appops` / `meta` 的说明。**
> 枚举是 4 个（`system|app|storage|gui`），而实际能力前缀是 6 个 —— 漂移**早已存在**，
> 只是没人校验。这正是「手写第二份定义必然漂移」的活证据，写进注释备查。

**验收**

```bash
# ① 类型面清零
grep -rn "SkillDomain" packages/*/src/
# 期望：0 行（只剩注释里的历史说明）

# ② 加载器仍能加载全部 skill（关键：不能因为删字段而少加载）
node -e "
const {loadSkillBundles}=require('./packages/host-sdk/dist/skill-loader.js');
loadSkillBundles('skills').then(bs=>console.log('loaded', bs.length));
"
# 期望：loaded 10（施工前实测 10，删字段后不变）

# ④ 四件套
```

**关键点**：删之前 `loadSkillBundles` 返回 10 个但 4 个 `domains` 有问题；删之后应该**仍是 10 个，且全部无 domains 字段**。这是「删除比修改更安全」的证明。

---

### Step 1.3 · 删 `adapter-agent-hermes`（0.5d → 实测 1.5d）

> **施工前复核（2026-11-23）：本步范围原判为「删一个包」，实测被严重低估。**
> 该包只有 488 行（217+271），但它是一个**完整 provider 插件**，被 deployment 的
> provider 选择链引用 6 处，且 `adapter-agent-workbuddy*` 内还有 hermes 语义残留。
> 按原表「删目录 + 删 config 段」施工会得到**部署期 `Cannot find module`**
> （`vm-service.config.json` 里的 `package` 字段是**运行时动态 import 的模块名**，
> 不是打包期静态依赖 —— 所以 tsc 与 dep-lint 都不会报，只有真机起服务才炸）。

#### 引用面实测（原表漏了 4 处）

| 位置 | 性质 | 原计划 |
|---|---|---|
| `packages/adapter-agent-hermes/`（488 行/2 文件） | 包本体 | ✅ 已列 |
| `tsconfig.build.json:14` | references | ✅ 已列 |
| `package-lock.json:36,185-186` | npm workspace 链接 | ❌ 漏（需 `npm install` 重算） |
| `delivery/vm-service.config.json:32-37` | **运行时 provider 注册**（动态 import 目标） | ✅ 已列 |
| `delivery/.generated/vm-service.runtime.json:36` | 生成产物 | ✅ 已列 |
| `delivery/setup.mjs:142,722` | provider 选择 + CLI 路径解析 | ❌ 漏 |
| `delivery/preflight.mjs:114-131,173,218` | provider→CLI 映射 + 阻断判据 | ❌ 漏 |
| `delivery/install-vm.mjs:70-71,596-610` | provider 白名单 + CLI env 解析 | ❌ 漏 |
| `delivery/deploy-shared-skills.mjs:49-66` | **hermes 是 skill 部署目标之一**（`HERMES_HOME`） | ❌ 漏，**但不删**（见下） |

#### 关键区分：`hermes-agent` provider ≠ `hermes` skill 部署目标

两件事名字像、实质无关，**只删前者**：

- **要删**：`provider === 'hermes-agent'` 这条 LLM provider 分支（选项之一，owner 已裁定收敛为 workbuddy）；
- **不能删**：`deploy-shared-skills.mjs` 把 skills 同步到 `{HERMES_HOME}/skills` 的**部署目标**
  （那是用户跨工具复用 skills 的通道，跟 VM 侧 provider 无关）。同时 `delivery/uninstall.mjs:810`
  清理 `~/.hermes/skills` 是同一件事的卸载侧，同样保留。

> 误删后者的后果：`/mcp/browser` 与 `/mcp/desktop` 的 stdio 上游技能包不再同步到 hermes，
> 属于**静默功能缺失**（不报错），比误删 provider 更难发现。

#### 施工表（修正后）

| # | 文件 | 动作 |
|---|---|---|
| 1 | `packages/adapter-agent-hermes/` | 整目录删除 |
| 2 | `tsconfig.build.json:14` | 删 reference |
| 3 | `delivery/vm-service.config.json:32-37` | 删 `hermes-agent` provider 段 |
| 4 | `delivery/setup.mjs:142,722` | 删 `hermesCli` 与 `'hermes-agent'` 分支 |
| 5 | `delivery/preflight.mjs:114-131,173,218` | 删 `hermes-agent→hermes` 映射与 `isLlmProvider` 里的该分支 |
| 6 | `delivery/install-vm.mjs:70-71,596-610` | provider 白名单去掉 `hermes-agent`；`cliEnvVar/cliDefault` 三元收敛为 workbuddy 单值 |
| 7 | `delivery/.generated/vm-service.runtime.json` | 重新生成（不手改） |
| 8 | `package-lock.json` | `npm install` 重算 |
| 9 | `adapter-agent-workbuddy/src/index.ts:1129`、`contracts/src/bridge.ts:847`、`vm-service/src/server.ts:2544-2547`、`vm-service/src/capabilities-profile.ts:4` | **只改注释**（把 hermes 作为「已删除的历史 provider」提法保留为背景，或改为泛指）；不动逻辑 |
| 10 | `@winvm/adapter-agent-workbuddy` 的 `DeterministicAgentProvider` 导出 | **保留**（hermes 包曾 import 它，删包后仍被 vm-service 用） |

> **不动**：`deploy-shared-skills.mjs:49-66`、`uninstall.mjs:810`（hermes skill 部署目标，见上）。

**验收**

```bash
# ① 包引用清零（.generated 除外，它是产物）
grep -rn "adapter-agent-hermes" packages/ delivery/ --include=*.ts --include=*.json --include=*.mjs 2>/dev/null \
  | grep -v node_modules | grep -v "/dist/" | grep -v ".generated" | grep -v package-lock
# 期望：0 行

# ② provider 分支清零（注意别把 skill 部署目标的 hermes 一起数进来）
grep -rn "hermes-agent" delivery/*.mjs delivery/*.json | grep -v ".generated"
# 期望：0 行

# ③ ★ skill 部署目标必须**仍在**（防误删的正向钉）
grep -c "HERMES_HOME" delivery/deploy-shared-skills.mjs
# 期望：≥1（不是 0！）

# ④ 编译 + 运行时配置生成
node_modules/typescript/bin/tsc -b tsconfig.build.json    # rc=0
node delivery/setup.mjs --help >/dev/null && echo setup-ok
# 期望：不抛错（provider 白名单收敛后 --help 仍可枚举）

# ⑤ 四件套 + 失败清单比对
node scripts/gate.mjs --quick
```

---

### Step 1.4 · 灰度开关 `WINVM_DELEGATION_REQUIRED_POLICY`（0.5d）✅ **已按折中方案落地（owner 裁定 2026-11-23）**

> **owner 裁定：保留键名 + 收敛单分支 + 废弃 WARN。**（不删、也不原样留着）

**做法（三处改动，零行为变更）**

| 文件 | 动作 |
|---|---|
| `core/src/constants.ts` | 新增 `resolveDelegationRequiredPolicyWithWarning(): { enabled, deprecatedOff }`；旧 `resolveDelegationRequiredPolicy()` 标 `@deprecated` 但**保留**（不打断既有引用/单测） |
| `vm-service/src/server.ts:1146` | 装配点换用新入口；读到 `deprecatedOff` 时 `logger.warn(...)`，文案点名环境变量 + 「已废弃 → 下一主版本移除」 |
| 5 处文档 | `OPS-OVERVIEW:306,528` / `deploy-strategy:93` 改为「⚠ 已标记废弃，`off` 仍有效但会 WARN」；`INTERFACES:221`、`SECURITY-GOVERNANCE:126`、`K5:94` 本就把 `off` 描述为回滚态，语义未失真，**不改** |

**为什么这是对的解法（不是偷懒）**

- **回滚位仍然有效**：配 `off` 依旧退回旧死令牌行为 —— 那根绳还在。
- **认知税确实消掉了**：数据面只消费 `enabled` 一个布尔位（不散落第二份解析），
  `deprecatedOff` 只服务启动期告警，**不参与任何判定**。
- **承诺不撤**：5 处文档的承诺从「这是回滚位」升级为「这是**即将移除的**回滚位」，
  运维读到的信息更准确，而不是凭空消失。

**验收**

```bash
node --test tests/unit/delegation-required-policy-deprecation.test.js   # 16 项
node_modules/typescript/bin/tsc -b tsconfig.build.json                  # rc=0
```

**实测**：13 个取值 × 2 个断言全部通过；核心不变式 ——
`WithWarning().enabled === 旧 resolveDelegationRequiredPolicy()` 在
`未配置/''/on/true/1/yes/off/false/0/no/非法/OFF/' off '` **13 个取值上逐字相等**。
另含 3 条反向钉：① 装配点必须用新入口（不得退回裸旧函数）② `deprecatedOff` 后必须有
`logger.warn` 且文案含「已废弃」与环境变量名 ③ 解析入口全文件恰 1 处（防两处漂移）。

**施工前复核留档（2026-11-23）：为什么原判「删掉开关」是错的**

> 原判「灰度期已过，双分支是永久认知税」是从**代码行数**看问题。实测该开关是
> `(c) 收口`（直调 L2/L3 ⇒ `DELEGATION_REQUIRED`）的**回滚保险**，且**被 5 处运维/设计
> 文档作为承诺面引用** —— 删它等于**单方面撤掉一个已对外承诺的回滚位**。
> 折中方案因此选择「留键、留回滚、只砍分支、加废弃告警」，5 处的处置逐条如下：

| 文档 | 原承诺内容 | 折中方案处置 |
|---|---|---|
| `docs/04-ops/OPS-OVERVIEW.md:528` | 环境变量总表登记本键，注明「`off`=回旧死令牌行为（回滚保险）」 | ✅ 改为「⚠ 已标记废弃：`off` 仍有效但启动会 WARN」 |
| `docs/04-ops/OPS-OVERVIEW.md:306` | MCP 直调通道行为描述里点名该回滚位 | ✅ 同上口径 |
| `docs/deploy/deploy-strategy.md:91-93` | 部署策略表列出本键与缺省 `on` | ✅ 同上口径（顺带删掉该行里的 `hermes-agent` 三方表述） |
| `docs/02-design/INTERFACES.md:221` | 契约码 `DELEGATION_REQUIRED` 章节写明「灰度位」 | ⚪ 不改 —— 「灰度位」描述在收敛后**仍然准确**（键还在、还能置 `off`） |
| `docs/02-design/SECURITY-GOVERNANCE.md:126` + `K5-server-replay-approval.md:94` | 安全治理口径里作为「独立开关」声明 | ⚪ 不改 —— 同上，语义未失真 |

> **为什么保留这个回滚位是「必要」而非「保守」**：`(c)` 收口是 Phase 4 批1 的**安全修复**
> （替换掉 P0-1「批准即删令牌 ⇒ 恒返 APPROVAL_REQUIRED 死循环」）。改安全路径的代码，
> 保留一个能把行为退回**已知可用旧态**的开关，是运维的最后一根绳；但「双分支」这个
> 认知税本身可以消掉 —— 二者不矛盾，所以取折中。

---

### Step 1.5 · 阶段 1 收口（0.5d）✅ **已完成（2026-11-23）**

**实测结果**

| 检查 | 结果 |
|---|---|
| `tsc -b` | rc=0（11 包） |
| `gate --quick` | `FILES=16 FAILED_FILES=2 VERDICT: RED` —— **与基线逐字相同** |
| 失败清单 | 仍为 `phase2-snapshot-truth`（`mcp-upstream.ts` 快照命中）+ `phase3-skill-claims-guard`（skill 点分 token），**本次改动零新增红** |
| 全量单测 | **123 个文件通过 / 5 个失败**；失败清单与基线**逐字相同**：`p8-probe-fresh`、`phase2-snapshot-truth`、`phase3-skill-claims-guard`、`r19c-kn1-e-mutation`、`r19c-kn1-e-shape`（均为改动前既有的基线红） |
| dep-lint | `packages=12 → 11`，`语句边=48→45`，`包级边=24→21`，hard=0 warn=0 |
| skill 加载 | `loadSkillBundles('skills')` = **10 个**，`带 domains 的: 0` |
| 渲染等价性 | 三工具面 URL 逐字未变：`/mcp`、`/mcp/browser`、`/mcp/desktop` |

**实际删除量（与原估对比）**

| 项 | 原估 | 实测 |
|---|---|---|
| `core/transport/ssh-tunnel*` | 690 行 | ✅ 690 行（170+520） |
| `adapter-agent-hermes` | 488 行 | ✅ 488 行（217+271） |
| `contracts` 死函数 | 未计 | + `transportBaseUrl()` / `isRemoteTransport()` **两个整函数**（全仓零调用，F-4 新发现） |
| SKILL.md `domains:` 行 | 改 10 个文件 | ❌ **不改**（见 Step 1.2 修正 1：改了只有噪声没有收益） |
| 灰度开关 | 1 个 env | ✅ 双分支收敛（键名保留 + 废弃 WARN，见 Step 1.4） |
| **合计净删** | ~1178 行 | **~1180 行 + 1 个包 + 1 个 npm workspace** |

**额外净收益（原计划未预见）**

1. **修掉一个潜伏 bug（B-1）**：`renderConnectorEntry` 曾对 `tokenEnv` 缺位的声明**无条件**输出
   `Authorization: 'Bearer ${undefined}'`。现改为「有 tokenEnv 才写 headers」。
   这是「删声明形态」顺带暴露的真缺陷 —— 不删 `ssh-tunnel` 就永远走不到那个分支。
2. **`ManagedTransport` 从接口收敛为类型别名**：原带 `tunnel?: TunnelHandle` 字段，
   删隧道后 `baseUrl` 只有 http 分支有，写必填会与 stdio 冲突 ⇒ 直接 `= TransportHandle`。
3. **`@winvm/contracts` 的传输契约不再承载凭据字段**：`privateKey` / `password` 随
   `SshTunnelTransport` 一起消失，纯数据契约回归纯数据。

**删包连带修掉的 6 个测试（原计划完全没预估到）**

删掉一个包会让**引用它的测试**一并失效。全量单测从基线 5 红变成 11 红，逐个排查后：

| 文件 | 失败形态 | 处置 |
|---|---|---|
| `hermes-provider.test.js` | 整个文件测的就是被删的包 | **删除文件** |
| `mcp-registrar.test.js` | 同上（`HermesMcpRegistrar` 纯函数） | **删除文件** |
| `cl019-health-ageMs.test.js` | `readFileSync(.../adapter-agent-hermes/...)` → ENOENT | 删 `HERMES` 常量与对应断言，保留 `WORKBUDDY_LLM` 一路 |
| `cl020-f2-a2a-netcfg-capture.test.js` | 同上 | 同上 |
| `p5-r1-capability-list-pin.test.js` | 断言「三 provider 通配集」含 hermes | `SOURCES` 收敛为两 provider + **新增反向钉**「hermes 包不得复活」 |
| `phase2-dep-direction.test.js` | `assert.ok(stats.packages >= 12)` 硬编码包数 | **改为从 `tsconfig.build.json` 现算 references 数** |

> **这一条值得单独立规矩**：`>= 12` 这种硬编码计数把「合法地删一个包」变成假红。
> 凡断言「数量」的地方，都应断言**不变式**（A == B），而不是**字面量**（A >= 12）。
> 已顺手把该文件改成前者 —— 否则阶段 2 合并 `host-sdk` 时还会再红一次。

```bash
# 阶段级断言（可复制）
grep -rn "ssh-tunnel\|SkillDomain\|adapter-agent-hermes" packages/*/src/ 2>/dev/null
# 期望：0 行（注释除外）

node scripts/gate.mjs --quick 2>&1 | grep -E "^RED|^VERDICT|^FILES"
# 期望：RED 仍为那 2 个；FILES=16 FAILED_FILES=2
```

**阶段 1 交付物**：删除 690 + 488 ≈ 1178 行死代码 + 1 个包 + 2 个死函数 + 1 个 npm workspace。
**行为零变化**（已用渲染输出逐字比对证明）—— 除修掉 B-1 之外，无任何可观测行为变更。

---

## 3. 阶段 2：统一能力表（5.5d，含 3.6a 技能面 +0.5d）

### Step 2.1 · 建 `CapabilityEntry` 类型 + 空表（0.5d）✅ **已落地（2026-11-24）**

**原计划（留档供对比）**

```ts
// packages/contracts/src/unified.ts（新增）
export type Surface = 'vm' | 'browser' | 'desktop';

export interface CapabilityEntry {
  readonly id: string;
  readonly domain: string;      // 派生自 id，不进存储
  readonly surface: Surface;
  readonly risk: RiskLevel;
  readonly title: string;
  readonly tool?: string;
}
```

**⚠ 实施时修正了原计划的三处（都是原计划的内部矛盾，不是口味问题）**

| 原计划 | 问题 | 实际做法 |
|---|---|---|
| `readonly domain: string` + 注释「派生自 id，不进存储」 | **字段与注释自相矛盾** —— 既然是派生值就不该有字段，两处会漂移 | 删字段，改 `deriveDomain(id): string` 函数。需要域时就地算，物理上不可能漂移 |
| `readonly summary: string`（见 `10` §4.1 初稿） | 与 `title` 语义重叠；112 条维护两份短描述只会互相漂移 | 删字段。**实测确认**：`Object.keys(entry)` = `["id","surface","risk","title"]`，`'summary' in entry === false` |
| 只声明类型，没有构造/校验 | 类型只在编译期管用；**运行期**（JSON 配置、上游 `tools/list` 来的条目）没有任何保护 | 增 `defineCapabilityEntry()` / `validateUnifiedTable()`，把四条不变式（三段式 / surface 合法 / risk 合法 / title 非空）落到运行期 |
| 没有「预期数量」常量 | 112 这个数字只活在文档里 ⇒ 无法被断言，也无法被门禁盯住 | 增 `SURFACE_EXPECTED_COUNTS`（54/33/25）与 `UNIFIED_TOTAL`（112），让账可以被对 |

> ⚠ **`domain` 易与 `CapabilityDefinition.domain` 混淆**：后者（`contracts/src/capability.ts:75`）
> **确实有** `readonly domain: CapabilityDomain`，因为 vm 面注册表要按域索引
> （`registry.listByDomain()`）。**两个接口不是一回事**：`CapabilityDefinition` 是「能执行什么」（54 条），
> `CapabilityEntry` 是「对外承诺什么」（112 条）。前者存 domain 是有用的索引，后者存 domain
> 只是 id 首段的第二份拷贝。写验收脚本时若用 `c.domain` 判等，会拿 `undefined` 去比较，
> 得出「全不符」或「全通过」——**两种都是假结论**。

**新增的一条关键不变式（原计划完全没有）**

> **`surface ≠ 'vm'` 时，id 首段必须等于 `surface`。**

为什么这条比其余三条都重要：把 `browser.nav.open` 错标成 `surface: 'vm'` **不会让任何调用失败** ——
它只会让审批闸按**另一个面的规则**放行（vm 面 L2 要审批、browser 面同 L2 可能不审）。
这是典型的**静默错标**，只能靠断言抓。已用突变测试反证（见 Step 2.5 的突变表 C7）。

**验收（实测）**：`tsc -b` rc=0；`tests/unit/unified-capability-table.test.js` C 组 8 条全绿。

---

### Step 2.2 · 转换 54 个现有能力（1d）✅ **已落地（2026-11-24）**

从 `definitions.ts` 的 `WINDOWS_CAPABILITIES` **派生**，不重写：

```ts
// packages/vm-capabilities/src/registry/unified.ts（实际代码）
export const VM_CAPABILITIES: readonly CapabilityEntry[] = Object.freeze(
  WINDOWS_CAPABILITIES.map((c) =>
    defineCapabilityEntry({ id: c.id, surface: 'vm', risk: c.risk, title: c.name }),
  ),
);
export const UNIFIED_CAPABILITIES = Object.freeze([...VM_CAPABILITIES]);
```

**为什么用 `map` 派生而不是抄 54 行字面量**

抄一份的代价不是「多写 54 行」，而是**两处会漂移**：新增能力时只改 `definitions.ts`、
忘了改 `unified.ts` ⇒ 统一表少一条 ⇒ 审批闸对这条能力**静默无规则**（fail-open）。
`map` 派生则同一份数据只有一个写入点，漂移在物理上不可能发生。

**验收（实测取代原脚本）**

```bash
node --test tests/unit/unified-capability-table.test.js
# → 24 tests / 24 pass / 0 fail（A1-A6 派生不漂移 / B1-B3 三段式 / C1-C8 坏形状必炸 / D1-D4 常量自洽 / E1-E3 事实源交叉核对）
```

**实测数据（与 `definitions.ts` 逐项吻合）**

| 项 | 值 |
|---|---|
| `surface='vm'` 条数 | **54** |
| 域分布 | `meta 3 / system 14 / app 8 / storage 13 / gui 11 / appops 5` |
| risk 分布 | `L0 27 / L1 19 / L2 7 / L3 1` |
| 无 risk / 无 title | **0 / 0** |
| 带 `tool` 字段 | **0**（vm 面按 id 自身路由，不重复写一份） |

**⚠ 施工中发现一处分层阻碍（会导致 2.4 无法按原计划落地）**

原计划把整张统一表放在 `vm-capabilities/src/registry/unified.ts`。但：

- `desktop` 白名单 `DEFAULT_DESKTOP_TOOL_ALLOWLIST` 现在住在 **`vm-service`**；
- `vm-service` 的 `package.json` 依赖 **`@winvm/vm-capabilities`**（已实测确认）；
- ⇒ `vm-capabilities` 反向 import `vm-service` 会**成环**，dep-lint 必拦。

**所以在 2.3/2.4 动工前必须先二选一**（待 owner 定，已登记为决策点）：

| 方案 | 做法 | 代价 |
|---|---|---|
| **A（推荐）** | 把 `DEFAULT_DESKTOP_TOOL_ALLOWLIST` **下沉**到 `vm-capabilities`（或更下的 `contracts`） | 改一处 import + 一处 re-export；后续 3 个消费点不用动 |
| B | 整张统一表挪去 `vm-service` | 统一表从「契约层」降到「服务层」，未来的 broker/CLI 想读表就得依赖 vm-service |

本次**没有临时绕过**（比如在 vm-capabilities 里硬编码 25 项）—— 那等于把「可达面」抄成第二份事实源，
正是本步极力避免的漂移源。

---

### Step 2.2b · 【3.6a】技能面两端对齐（0.5d，**不受阶段 3 顺序约束**）

> 编号说明：这是 `13` §3.6a 的施工落地。放在阶段 2 内是因为它与 2.3/2.4 有**直接依赖**——
> 2.3/2.4 的验收要拿 `skills/agent-browser-skill/references/`（33 份）与
> `skills/agent-desktop-skill/references/`（75 份）当**真实工具清单**做交叉核对。
> 若这两个 skill 不下发 VM，就等于「VM 侧有一套工具，但两边都拿不到核对基准」。

**做什么（3 处改动）**

| # | 文件 | 改动 |
|---|---|---|
| 1 | `delivery/deploy-shared-skills.mjs:40` | `HOST_ONLY_SKILLS` 从 3 个元素收窄为 `['hos-win-skill']`，并**改写该常量的注释**（现注释写「VM 内 Agent 绝不应见到它们」，与新行为直接矛盾，不改会成为下一轮误判源头） |
| 2 | `skills/agent-browser-skill/SKILL.md` + `skills/agent-desktop-skill/SKILL.md` | 开头「服务形态」那句加**端点自适**表述：宿主经 `connector:winvm-browser`，VM 内 Agent 经 `mcpServers.winvm-browser`，**同一工具面** |
| 3 | 单测中断言「VM 侧 = 7」的地方 | 改断言为 **9**（10 − `hos-win-skill`） |

**改之前先确认这 3 件事（用命令，别靠回忆）**

```bash
# ① 名单现在是几个
# ⚠ 该文件是带 top-level await 的 ESM，**不能用 require()**（会报 ERR_REQUIRE_ASYNC_MODULE）
node --input-type=module -e "
const m=await import('./delivery/deploy-shared-skills.mjs');
console.log('HOST_ONLY=',m.HOST_ONLY_SKILLS,'len=',m.HOST_ONLY_SKILLS.length);
"
# 期望：3 个（hos-win-skill, agent-browser-skill, agent-desktop-skill）

# ② 被排除的两个确实带大量资料（不是空壳）
ls skills/agent-browser-skill/references | wc -l   # 33
ls skills/agent-desktop-skill/references | wc -l   # 75

# ③ 宿主侧本来就不过滤（这是"宿主已达标"的证据，别去给它加过滤）
grep -c "HOST_ONLY" packages/host-sdk/src/skill-loader.ts
# 期望输出：0（grep -c 输出数字 0，退出码 1 —— 属正常，别被 exit=1 吓到）
```

**验收（可复制）**

```bash
# ① 名单已收窄
node --input-type=module -e "
const m=await import('./delivery/deploy-shared-skills.mjs');
console.log('HOST_ONLY=',m.HOST_ONLY_SKILLS);
if(m.HOST_ONLY_SKILLS.length!==1||m.HOST_ONLY_SKILLS[0]!=='hos-win-skill') process.exit(1);
"
# 期望：HOST_ONLY=[ 'hos-win-skill' ]

# ② 注释不再含矛盾表述
# ⚠ 必须搜「绝不应见到它们」（带"它们"）。只搜「绝不应见到」会命中「历史修正」段里
#   **故意保留的旧理由引用**（那段是解释旧判断为何错，不是仍在生效的规则）⇒ 假红。
#   与「查子串不查语境」同类错误（13 §3.6.4 ② 有同样说明）。
grep -c "绝不应见到它们" delivery/deploy-shared-skills.mjs
# 期望输出：0（grep -c 输出数字 0，退出码 1 —— 属正常）
grep -c "是否只在" delivery/deploy-shared-skills.mjs
# 期望：>= 1（新判据句在位）

# ③ 规划结果：VM 侧发布 9 个（10 − 1）
node --input-type=module -e "
import fs from 'node:fs';
const m=await import('./delivery/deploy-shared-skills.mjs');
const repo=fs.readdirSync('skills',{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>e.name);
const toVm=repo.filter(s=>!m.HOST_ONLY_SKILLS.includes(s));
console.log('repoSkills=',repo.length,'-> VM',toVm.length);
console.log(toVm.join(','));
if(toVm.length!==9) process.exit(1);
if(!toVm.includes('agent-browser-skill')||!toVm.includes('agent-desktop-skill')) process.exit(1);
"
# 期望：repoSkills= 10 -> VM 9（含 agent-browser-skill 与 agent-desktop-skill）
# 实测基线（改前）：VM 7；改后应为 9

# ④ 宿主侧不受影响（仍 10 个）
node --input-type=module -e "
const m=await import('./packages/host-sdk/dist/skill-loader.js');
const r=await m.loadSkillBundles('skills');
console.log('host loaded=',r.length);
if(r.length!==10) process.exit(1);
"
# 期望：host loaded= 10

# ⑤ 单测不再有 "7" 的旧断言
grep -rn "=== *7\|length, *7\|, *7," tests/unit/*skill*deliver* tests/unit/*deploy-shared* 2>/dev/null
# 期望：0 行（有则已改为 9）
```

**收口**：走 §1 四件套。门禁期望 **RED 仍为那 2 个**（本步只改交付脚本 + 文档，不碰 `src/`）。

**为什么本步零风险**：改动只影响「往 VM 复制哪些文档目录」。不新增任何可执行能力、
不改任何工具路由、不动 `bridge.ts`。最坏情况是 VM 上多两个用不到的文档目录。

---

### Step 2.3 · 手工标注 browser 33 项（1.5d）✅ **已落地（2026-11-24）**

**做了什么（3 个文件 + 1 个测试）**

| # | 文件 | 改动 |
|---|---|---|
| 1 | `packages/vm-capabilities/src/registry/upstream-tools.ts` | 追加 `BROWSER_TOOLS`（33 条显式声明）+ **加载期三重校验**（条数 33 / id 无重复 / tool 无重复） |
| 2 | `packages/vm-capabilities/src/registry/unified.ts` | `UNIFIED_CAPABILITIES` 改为 `[...VM, ...BROWSER, ...DESKTOP]` —— browser 段**插在中间**，不是 append |
| 3 | `packages/vm-capabilities/src/index.ts` | 补导出 `BROWSER_TOOLS` |
| 4 | `tests/unit/unified-capability-table.test.js` | D3 **翻转**（钉缺席 → 钉在场且恒等 112）+ 新增 **D3b 顺序** + **F1~F5** 五条 browser 专项 |

**分类映射（33 项，与 `references/` 33 份实测一致）**

```
browser.nav      (8)  open close reload back forward tab_new tab_switch tab_close
browser.observe  (7)  read snapshot get_text get_title get_url tab_list screenshot
browser.act      (6)  click fill select check uncheck type
browser.wait     (4)  wait_for_load wait_for_selector wait_for_text wait_ms
browser.scroll   (2)  scroll press
browser.flow     (4)  flow_list flow_run flow_save flow_steps
browser.meta     (2)  eval tools_profiles
```

**⚠ 原计划的 risk 一笔写「`nav/act/wait/scroll/flow` 全 L1」是错的，实测拆成两处例外**

| 组 | 原计划 | 实际 | 理由 |
|---|---|---|---|
| `flow` | 全 L1 | `flow_list` / `flow_steps` = **L0**，`flow_run` / `flow_save` = L1 | 前两者只是**列出**已保存/已捕获的步骤，不碰浏览器状态 |
| `meta` | `eval`=L2（`tools_profiles` 未提） | `tools_profiles` = **L0** | 它只**列出** MCP 工具档位与启用方法，纯读取 |

实测分布：**L0 14 / L1 18 / L2 1**（合计 33）。
原计划隐含的是 L0 7（仅 observe）/ L1 25 / L2 1 —— 差 7 条。

> **来源辨析**：上游 ref 每份都带「标注：只读 / 会改变状态」字段，看着像现成的事实源，
> 但它**不是** `risk.ts` 语义。按它统计会得出 `screenshot`、`tools_profiles` = 「会改变状态」⇒ L1，
> 而这两者都是纯读取。该字段的打标口径更像「是否触达外部世界」，与 L0 的定义
> （**不改变系统状态**）不是同一个判据，**不能直接映射**。33 条逐条按 `risk.ts` 重判。

**browser 与 desktop 的三处结构性差异（照抄 desktop 会错）**

| | desktop | browser |
|---|---|---|
| 清单来源 | **派生**自 `DEFAULT_DESKTOP_TOOL_ALLOWLIST` | **显式声明**（无白名单可派生） |
| `tool` 字段 | `desktop_*`，id 是 `desktop.<g>.<a>` | `agent_browser_*`，与 id 完全不同 ⇒ **33 条全部必填** |
| 加载期校验 | 白名单 ↔ 标注表**双向**比对 | 条数 33 + id 不重 + tool 不重（无白名单可对照） |
| `L2` | **0**（白名单刻意排除） | **1**（`eval` 在全量面里） |
| 漂移方向 | 上游加工具**不会**自动进来 | 上游加工具**会**自动进来（无过滤） |

**验收（可复制，已实跑）**

**验收**

```bash
node -e "
import('./packages/vm-capabilities/dist/registry/upstream-tools.js').then(m=>{
  console.log('browser =', m.BROWSER_TOOLS.length);
  // 与真实工具清单比对
  const fs=require('fs');
  const real=fs.readdirSync('skills/agent-browser-skill/references').map(f=>f.replace('.md',''));
  const declared=new Set(m.BROWSER_TOOLS.map(t=>t.tool));
  const missing=real.filter(r=>!declared.has(r));
  const extra=[...declared].filter(d=>!real.includes(d));
  console.log('漏声明 =', missing);
  console.log('多声明 =', extra);
  if(missing.length||extra.length) process.exit(1);
});
"
# 实测：browser = 33 / real = 33 / 漏声明 = [] / 多声明 = []
```

> **这条断言很重要**：它把「静态清单」与「上游真实工具面」钉在一起。
> 上游加工具而清单没跟，就会红。已落为单测 **F1**（双向比对，`missing` 与 `extra` 各钉一次）。

```bash
# ② browser risk 分布（实测 14 / 18 / 1）+ L2 必须是 eval
node -e "
import('./packages/vm-capabilities/dist/registry/upstream-tools.js').then(u=>{
  const r=u.BROWSER_TOOLS.reduce((a,c)=>{a[c.risk]=(a[c.risk]||0)+1;return a},{});
  console.log('browser risk =',JSON.stringify(r));
  const l2=u.BROWSER_TOOLS.filter(c=>c.risk==='L2').map(c=>c.tool);
  console.log('L2 =',JSON.stringify(l2));
  if(r.L0!==14||r.L1!==18||r.L2!==1) process.exit(1);
  if(l2.length!==1||l2[0]!=='agent_browser_eval') process.exit(1);
});"
# 实测：{"L0":14,"L1":18,"L2":1} / ["agent_browser_eval"]

# ③ 统一表 = 112（三面齐全）
node -e "
Promise.all([import('./packages/vm-capabilities/dist/registry/unified.js'),import('./packages/contracts/dist/unified.js')]).then(([m,k])=>{
  const t=m.UNIFIED_CAPABILITIES; const by={};
  for(const c of t) by[c.surface]=(by[c.surface]||0)+1;
  console.log('total =',t.length,JSON.stringify(by),'dup =',t.length-new Set(t.map(c=>c.id)).size);
  console.log('problems =',k.validateUnifiedTable(t).length);
  if(t.length!==112) process.exit(1);
});"
# 实测：total = 112 {"vm":54,"browser":33,"desktop":25} dup = 0 / problems = 0

# ④ 单测（33 条：A/B/C/D/D3b/E/F1-F5）
node --test tests/unit/unified-capability-table.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)"
# 实测：tests 33 / pass 33 / fail 0（与 mcp-upstream-connectors 合计 46/46）
```

**突变反证（4 类，全部被抓，2026-11-24 实测）**

| 突变 | 结果 |
|---|---|
| `eval` 的 risk `L2`→`L1` | ✅ **F3 抓**：`pass 32 / fail 1`（分布 + L2 集合双断言） |
| 删掉一条（`wait_ms`） | ✅ **加载期抛错**：`BROWSER_TOOLS 条数 32 != 33` |
| 某条 `tool` 写成 `id`（模拟忘写 tool） | ✅ **F1 + F2 抓**：`pass 30 / fail 3`（漏声明 + tool==id + 前缀） |
| `browser` 段 append 到 `desktop` 之后 | ✅ **D3b 抓**：`pass 32 / fail 1`（面顺序错位） |

> 第 1 条是本面最关键的反证：`eval` 降级不会让任何调用失败，只会让审批闸
> **静默放行任意 JS 执行**。它能被抓，靠的是 F3 把「分布」和「L2 集合」两件事都钉死。

**连带面**

| 文件 | 原断言 | 改后 |
|---|---|---|
| `tests/unit/unified-capability-table.test.js` **D3** | `deepEqual([...surfaces], ['desktop','vm'])`（钉 browser **缺席**） | 翻转为 `['browser','desktop','vm']` 且 `length === UNIFIED_TOTAL`（**覆盖面 2 面 → 3 面且总表恒等**） |
| 同文件 **新增 D3b** | — | 面的**顺序** = vm→browser→desktop（防 append 到末尾致下标错位） |
| 同文件 **新增 F1~F5** | — | 与 `references/` 33 份双向比对 / tool 必填 / risk 分布 / L0 集合 / id+tool 无重复 |

**收口**：`tsc -b` rc=0；dep-lint `VERDICT: GREEN`；`UNIFIED_TOTAL` 未改（仍 112，本步只是**兑现**它）。

---

### Step 2.4 · 手工标注 desktop 25 项（1d）✅ **已落地（2026-11-24，方案 A）**

**owner 裁定**：采用**方案 A** —— 常量下沉到 `vm-capabilities/src/registry/`，与 `definitions.ts` 同层。

**实际做了什么（3 个文件）**

| # | 文件 | 改动 |
|---|---|---|
| 1 | `packages/vm-capabilities/src/registry/upstream-tools.ts`（**新增**） | 承接 `DEFAULT_DESKTOP_TOOL_ALLOWLIST`（25 项，逐字未变）+ 新增 `DESKTOP_TOOL_META` 手工标注表（逐条 `id`/`risk`/`title`）+ `DESKTOP_TOOLS`（派生结果，模块加载期三重校验） |
| 2 | `packages/vm-service/src/mcp-upstream.ts` | 常量字面量删除，改为 `import` + `export { ... } from '@winvm/vm-capabilities'`（**re-export 保持对外形状不变**，既有 `from dist/mcp-upstream.js` 的消费方零改动） |
| 3 | `packages/vm-capabilities/src/registry/unified.ts` | `UNIFIED_CAPABILITIES` 从 `[...VM_CAPABILITIES]` 改为 `[...VM_CAPABILITIES, ...DESKTOP_TOOLS]` |

**关键设计：为什么派生放在模块加载期而不是测试期**

`defineDesktopTools()` 在 `import` 那一刻就跑三重校验，任一不过直接抛错（服务起不来）：

| 校验 | 抓什么失效模式 |
|---|---|
| 白名单有、标注表无 | 该工具在统一表里**缺席** ⇒ 审批闸对它**无规则可查**（fail-open，会静默放行） |
| 标注表有、白名单无 | 表**说谎**（承诺一条实际调不到的能力） |
| 两侧条数不等 | 共模错误（两边同时漏掉同一个） |

这不能等到 CI 才发现 —— **fail-open 是不可观测的**：它不会报错，只会让某个破坏性动作少一道审批。

> ⚠ 早前记录的依赖方向依据（**留档，勿再引用**）：原计划写「`vm-capabilities`（L3）不能依赖
> `vm-service`（L4）」——layer 号**写错了**，两者 `package.json` 里都是 `L2`。真正的依据是
> `vm-service` 的 `dependencies` 里**已有** `"@winvm/vm-capabilities"`，反向 import 即成环。
> dep-lint 实测 `VERDICT: GREEN`（无环），`语句边 46→49`（+3：unified→upstream-tools、
> index→upstream-tools、mcp-upstream→vm-capabilities）。

**两个导出职责不同，别混**

| 导出 | 是什么 | 谁消费 |
|---|---|---|
| `DEFAULT_DESKTOP_TOOL_ALLOWLIST` | **上游工具名字面量**（`desktop_*`）——「放不放行」的开关 | `McpUpstream.exposedTools()` 过滤 `tools/list` |
| `DESKTOP_TOOLS` | **统一表条目**（`desktop.<组>.<动作>` + `risk` + `title`）——「放行后按什么风险审」的规则 | 策略闸 / 审批 / 清单展示 |

**risk 分级结果（实测，与 §3.4 建议值一致）**

| risk | 条数 | 成员 |
|---|---|---|
| `L0` 只读 | **8** | snapshot / find / screenshot / list_apps / list_windows / get / is / wait |
| `L1` 可回滚写 | **17** | 其余（窗口 4 + 指针 6 + 输入 7） |
| `L2` | **0** | 白名单已排除 close_app / drag / clipboard_set 等破坏性动作 |

> `desktop_launch` 判 `L1` 而非 `L2`：只启动应用、不装不卸，关掉即复原。
> 真正的装/卸在 vm 面 `app.winget.*`，另有分级，不要混。
> ⚠ `L2` 为空**不代表**本面安全 —— 只说明默认白名单里没有破坏性动作。
> 将来若加 `desktop_close_app` 或原始鼠标事件，**必须同步标 L2**，否则按 L1 静默放行。

**验收（可复制，已实跑）**

```bash
# ① 条数 25
node -e "
import('./packages/vm-capabilities/dist/registry/upstream-tools.js').then(m=>{
  console.log('desktop =', m.DESKTOP_TOOLS.length);
  console.log('allowlist =', m.DEFAULT_DESKTOP_TOOL_ALLOWLIST.length);
  if(m.DESKTOP_TOOLS.length!==25) process.exit(1);
  if(m.DEFAULT_DESKTOP_TOOL_ALLOWLIST.length!==25) process.exit(1);
});"
# 实测：desktop = 25 / allowlist = 25

# ② risk 分布 8 / 17 / 0
node -e "
import('./packages/vm-capabilities/dist/registry/upstream-tools.js').then(m=>{
  const r=m.DESKTOP_TOOLS.reduce((a,c)=>{a[c.risk]=(a[c.risk]||0)+1;return a},{});
  console.log('risk:',JSON.stringify(r));
  if(r.L0!==8||r.L1!==17||(r.L2||0)!==0) process.exit(1);
});"
# 实测：risk: {"L0":8,"L1":17}

# ③ 统一表 = 79（54 vm + 25 desktop；browser 33 待 2.3）
#   ⚠ 这是 **Step 2.4 当时的实测值**，作为历史证据保留。2.3 落地后此断言应改为 112
#     且 by 须含 browser:33 —— 见 Step 2.3 的验收段（现在跑这段会得到 total=112 而 exit 1）。
node -e "
import('./packages/vm-capabilities/dist/index.js').then(m=>{
  const t=m.UNIFIED_CAPABILITIES;
  const by={};for(const c of t){by[c.surface]=(by[c.surface]||0)+1}
  console.log('total =',t.length,JSON.stringify(by),'dup =',t.length-new Set(t.map(c=>c.id)).size);
  if(t.length!==79) process.exit(1);
});"
# 实测：total = 79 {"vm":54,"desktop":25} dup = 0

# ④ 反向 import 未成环（方案 A 的核心前提）
node scripts/dep-lint.mjs 2>&1 | tail -1
# 实测：VERDICT: GREEN

# ⑤ re-export 仍在原位置可 import（对外形状不因搬家而变）
node -e "
Promise.all([import('./packages/vm-service/dist/mcp-upstream.js'),import('./packages/vm-capabilities/dist/index.js')]).then(([a,b])=>{
  console.log('len =',a.DEFAULT_DESKTOP_TOOL_ALLOWLIST.length);
  console.log('同一引用 =',a.DEFAULT_DESKTOP_TOOL_ALLOWLIST===b.DEFAULT_DESKTOP_TOOL_ALLOWLIST);
  if(a.DEFAULT_DESKTOP_TOOL_ALLOWLIST!==b.DEFAULT_DESKTOP_TOOL_ALLOWLIST) process.exit(1);
});"
# 实测：len = 25 / 同一引用 = true

# ⑥ 单测（27 通过，其中 5 条是本步新增/改写的）
node --test tests/unit/unified-capability-table.test.js tests/unit/mcp-upstream-connectors.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)"
# 实测：tests 40 / pass 40 / fail 0
```

**连带面（已同步改掉，不改则单测必红）**

| 文件 | 原断言 | 改后 |
|---|---|---|
| `tests/unit/unified-capability-table.test.js` **D3** | `[...surfaces] === ['vm']`（钉「desktop 必须缺席」） | `['desktop','vm']`，并钉 `bySurface.desktop === 25`、总表 = 79 |
| 同文件 **E2** | 从 `vm-service/src/mcp-upstream.ts` 正则取白名单字面量 | 改从 `vm-capabilities/src/registry/upstream-tools.ts` 取（**跟着事实源搬家**，覆盖面不变：仍钉长度/去重/前缀） |

**新增 4 条断言（E2b / E2c / E2d 等）**：

- **E2b**：re-export 仍可 import，且与 `vm-capabilities` 侧是**同一引用**（不是两份副本）
- **E2c**：`DESKTOP_TOOLS` 与白名单**双向**一致（条数相等 + `tool` 逐条命中 + 反向无遗漏）
- **E2d**：risk 分布 8/17/0 + L0 集合逐条钉死

> **这不是「为了让门禁变绿而放宽断言」**（§0.3 红线）：D3 从「1 面」改成「2 面并钉各自条数」，
> 覆盖面**扩大**了；E2 只是事实源换了路径，判据（长度/去重/前缀）一条没减。

**突变反证（3 类，全部被抓，2026-11-24 实测）**

| 突变 | 结果 |
|---|---|
| 白名单加 `desktop_close_app`，标注表不加 | ✅ 加载期抛错：`白名单工具 "desktop_close_app" 缺少 DESKTOP_TOOL_META 标注` |
| 标注表加 `desktop_close_app`，白名单不加 | ✅ 加载期抛错：`统一表会承诺一条实际不可达的能力（表说谎）` |
| `desktop_launch` 的 risk `L1`→`L2` | ✅ E2d 抓：`pass 26 / fail 1` |

**收口**：门禁失败清单**与基线逐条相同**（仍 `phase2-snapshot-truth` 1 + `phase3-skill-claims-guard` 1），
`FILES=16 FAILED_FILES=2 TOTAL=322 PASS=320 FAIL=2`，**零新增**。

---

### Step 2.5 · 合并成 112 项 + `meta.capability.list` 返回它（1d）✅ **已落地（owner 裁定方案 B，2026-11-24）**

> **B 不是「换一行数据源」**，有四处非显然处理，改之前必读 `13` §3.5c：
> ① 求交基准必须**按面区分**（`declareCapabilities()` 只声明六个 vm 域，直接对表求交会把
>   `browser.*`/`desktop.*` 全部滤掉 ⇒ 仍是 54，实测）；② `name` 字段在 browser/desktop
>   **不存在**，须回落 `title`；③ 统一表有 **17 项 id 含下划线**，旧断言的三段小写正则会把它们
>   全判非法，判据须回到契约（只要求三个非空点段）；④ `WINVM_UPSTREAM_OFF` 开关 provider 看不到，
>   属**已知不精确并已在代码注释中登记**，不是 bug。

**验收**

```bash
# ① 表侧（与 Step 2.5 原脚本同一段，此处只列期望值）
node -e "
Promise.all([
  import('./packages/vm-capabilities/dist/registry/unified.js'),
  import('./packages/contracts/dist/unified.js'),
]).then(([m,k])=>{
  const all=m.UNIFIED_CAPABILITIES;
  const by={};for(const c of all){by[c.surface]=(by[c.surface]||0)+1}
  const dup=all.length-new Set(all.map(c=>c.id)).size;
  // ★ 用 deriveDomain(id)，不要写 c.domain —— 该字段不存在（见 Step 2.2 修正表第 1 行）
  const badDomain=all.filter(c=>c.id.split('.')[0]!==k.deriveDomain(c.id));
  const noRisk=all.filter(c=>!c.risk);
  // 官方校验器兜底：逐条合法性 + id 唯一
  const problems=k.validateUnifiedTable(all);
  console.log('total=',all.length,by,'dup=',dup,'domainMismatch=',badDomain.length,
              'noRisk=',noRisk.length,'problems=',problems.length);
  if(all.length!==112||dup||badDomain.length||noRisk.length||problems.length) process.exit(1);
});
"
# 期望：total=112 {vm:54,browser:33,desktop:25} dup=0 domainMismatch=0 noRisk=0 problems=0
# 实测：total= 112 {"vm":54,"browser":33,"desktop":25} dup= 0 domainMismatch= 0 noRisk= 0 problems= 0

# ② 接口侧（B 的实质）：capability.list 必须真的回 112，不是只有表变了
node --test tests/unit/p5-r1-capability-list-pin.test.js
# 期望：tests 20 / pass 20 / fail 0
#   - A2 count=112（不再是 54）
#   - A3 基准 = UNIFIED_CAPABILITIES 全集，且三面各 54/33/25
#   - ★「vm 面仍受 provider 声明约束」：收窄到 meta.* 后 vm 面必须真的缩，而另两面不变
#     （这条是 B 引入的风险点：既然另两面不过滤，整表不过滤也能让 112 全绿 —— 必须防住）
```

**验收判据（非空转证明：突变 3 抓 3）**

| 突变 | 结果 | 抓到它的断言 |
|---|---|---|
| 整表不过滤（vm 收窄语义丢失） | 1 条 FAIL | ★vm 面仍受声明约束（**只抓这一条**，说明该钉精确） |
| 退回 `WINDOWS_CAPABILITIES` | 5 条 FAIL | A2 count / A3 全集 / 三面计数 / vm 同源 / ★vm 收窄 |
| `name` 不回落 `title` | 2 条 FAIL | A2 类型校验 / 非 vm 面回落 title |

**连带改动**（B 的完整清单，见 `13` §3.5c 表）：`adapter index.ts`、
`p5-r1` 测试、**四份 `winvm-*/SKILL.md`**、`definitions.ts` 注释、`pack-release.mjs` 验证清单。
⚠ `pack-release.mjs:743` 的 **V4 断言 `CAP_COUNT=54` 不动** —— 它测的是
`WINDOWS_CAPABILITIES.length`（vm 面注册表条数），与本次无关。

> ⚠ 原脚本写的是 `c.id.split('.')[0]!==c.domain`。`CapabilityEntry` **没有** `domain` 字段
> （实测 `Object.keys` = `["id","surface","risk","title"]`），逐条都拿 `undefined` 比较 ⇒ `badDomain` 恒等于全表长度
> ⇒ 这条断言**永远为红**，且红的原因与「表有问题」毫无关系。改用 `deriveDomain(id)` 后语义才对。

---

### Step 2.6 · 阶段 2 收口

```bash
node scripts/gate.mjs --quick 2>&1 | grep -E "^RED|^VERDICT|^FAILED_FILES|^FAIL "
# 期望：**失败清单与阶段 2 开工前逐条相同**（无新增条目）
# ⚠ 不是"RED 2 就算对"——基线的 2 个红是守卫件白名单问题，阶段 2/3 都不会让它们变绿，
#   判据是"逐条比对失败清单"，见 13 §4.5 的作废说明。

# 阶段级断言：112 项齐全且自洽
node -e "..."   # 同 2.5
```

**阶段 2 交付物**：112 项统一能力表 + 58 项静态 risk 分级 + 逆向依赖修正 + **VM 侧 9 个 skill**（3.6a）。
**预期门禁状态**：失败清单不变（基线的 2 个红是守卫件白名单问题，与本阶段无因果）。

---

### 阶段 2 半程收口（Step 2.1 + 2.2 完成后 · 2026-11-24 实测）

| 检查 | 结果 |
|---|---|
| `tsc -b` | **rc=0**（12 包） |
| `gate --quick` | `FILES=16 FAILED_FILES=2 VERDICT: RED` —— **与基线逐字相同** |
| 全量单测 | **PASS=125 / FAIL=5**；失败清单与基线**逐字相同**（`p8-probe-fresh`、`phase2-snapshot-truth`、`phase3-skill-claims-guard`、`r19c-kn1-e-mutation`、`r19c-kn1-e-shape`）。PASS 比阶段 1 收口的 123 多 2 个 = 本轮新增的两个测试文件 |
| 新增测试 | `unified-capability-table.test.js` **24/24 绿** |
| dep-lint | `packages=11`（不变）；语句边 `45→46`、包级边 `21→22`、info `7→6` —— 增量来自 `vm-capabilities` 新增对 `@winvm/contracts` 的 import（**预期内**，hard=0 warn=0） |
| `git status --short` | 两个新文件在 `??` 下（`contracts/src/unified.ts`、`vm-capabilities/src/registry/unified.ts`）；无意外改动 |

**本步新增文件**

| 文件 | 行数 | 作用 |
|---|---|---|
| `packages/contracts/src/unified.ts` | ~200 | `Surface` / `CapabilityEntry` / 四条不变式校验 / `SURFACE_EXPECTED_COUNTS` |
| `packages/vm-capabilities/src/registry/unified.ts` | ~55 | vm 面 54 项的 `map` 派生（零字面量） |
| `tests/unit/unified-capability-table.test.js` | ~270 | A/B/C/D/E 五组 24 条断言 |

---

### 阶段 2 质量证据 · **突变反证**（2026-11-24 实测于 Step 2.1/2.2 完成后）

> 门禁绿不等于断言有效 —— 只证明「当前代码没触发它」。要证明断言**真的能拦**，
> 必须**故意改坏**再跑。四个突变逐个施加、跑测、复原、复核 `git status`：

| # | 突变内容 | 期望被谁抓 | **实测** |
|---|---|---|---|
| M1 | 注释掉 `defineCapabilityEntry` 的 surface 首段校验（`if (false && ...)`） | C7「错标面必炸」 | ✅ `pass 23 / fail 1` |
| M2 | `WINDOWS_CAPABILITIES.map` → `.slice(1).map`（vm 面漏一条） | A1/A2/A3/B2 等派生不漂移 | ✅ `pass 17 / fail 7` |
| M3 | `SURFACE_EXPECTED_COUNTS.browser: 33 → 30`（账对不上） | D2「合计 = 112」 | ✅ `pass 23 / fail 1` |
| M4 | 给 `browser` 的 upstream spec 硬塞 `toolAllowlist: ['x']` | E1「browser 无白名单」 | ✅ `pass 22 / fail 2` |

四个突变**全部被捕获**，且每次复原后用 `git status --short` 复核（`vm-capabilities/registry/unified.ts`
的突变因该文件尚未被 git 跟踪，`git checkout` 无效 —— 已手工改回并逐字确认）。

> **这轮突变暴露了测试自身的一个 bug**：E2 最初用 `body.split(',')` 数白名单项，
> 每组前面的 `// A 目标发现与窗口` 注释会把「注释行 + 组内首个元素」并成同一段，
> 导致**每组漏算第一个**（实测得 20 而非 25，漏的恰是 snapshot/launch/click/type/get）。
> 已改为**按行**提取。这正是「断言要对着真实结构写、不能对着直觉写」的实例。

---

## 4. 阶段 3：统一闸门（4d）★ 安全核心

### Step 3.1 · 抽 `gateway.ts`（1d）✅ **已落地（2026-11-24）**

**做什么**：把 `server.ts` 现有的「策略 → 审批 → 执行 → 审计」段落抽成 `gateAndExecute()`。

> **重要**：这一步是**纯搬运**，不改变任何语义。搬运前后行为必须逐字一致。

**实际做法**：`server.ts` handler 体 1494–1762 行（**269 行**）逐行搬到
`packages/vm-service/src/gateway.ts` 的 `gateAndExecute()`，只做整体缩进 −2 空格；
`server.ts` handler 收缩为 `return gateAndExecute(gateDeps, { cap, params, ctx });` + 依赖装配块。

依赖不进闭包而是显式传：原实现读 `createService()` 的 20+ 个局部变量，搬到模块级后改为
`GateDeps` 契约字段 + 函数入口**同名解构**复原 ⇒ 函数体才能逐字不动（改 `deps.xxx`
前缀式访问会产生 20+ 处文本差异，违背"逐字可比对"）。

**验收**

```bash
# ① 新文件存在
ls packages/vm-service/src/gateway.ts

# ② 行为与形态守卫（12 条）
node --test tests/unit/step31-gateway-extraction.test.js
# 期望：tests 12 / pass 12 / fail 0
```

> ### ⚠ 原「② 现有 322 个测试全绿 / RED 仍 2 个」口径已作废（同一实测更正沿用 3.2 的结论）
>
> 基线那 2 个红与阶段 3 无关（真判据见 §4 Step 3.2 的 ⚠ 作废块），故判据改为
> **「失败清单逐条比对」**，不是看总数。

**验收判据（突变反证 3 抓 3，证明不是文本巧合）**

| 突变 | 结果 | 说明 |
|---|---|---|
| ① 审批分支永不进入（`requiresApproval` 短路） | step31 **3 条 FAIL** | 审批/令牌注册/blocked 审计同时红 |
| ② 策略硬拒绝分支永不进入（`!verdict.allowed` 短路） | step31 **4 条 FAIL** | 硬拒绝/denied 审计/不注册令牌同时红 |
| ③ 删掉一行 `pendingApprovals.delete(approvalId)`（模拟"顺手优化"） | step31 **2 条 FAIL** | ★ 同时被**文本层**（逐行等价）与**行为层**（令牌一次性消费）抓到 |

### ⚠ 本步最容易被误判的一点：源码文本守卫必须扩观测面

搬运做完后**立刻红了 4 个既有套件 11 条**（`assembly-guard` 5 / `k5-replay` 3 /
`p3-b1-policy-gate` 4 / `phase3-b6-preview-hash-binding` 3 / `phase3-b3-receipt-ttl` 1，
去重后 11 条新增）。它们清一色把锚点钉在 `server.ts` 的 handler 体内：

| 套件 | 钉的是什么 | 搬运后为何红 |
|---|---|---|
| `assembly-guard` | 拒绝分支恰 2 处、注入恰 6 处、每处在 return 前 | 5 处注入搬走 ⇒ 实测 1 处 / 4 处 |
| `k5-replay` | `executeCapability(` 调用点 ≥2（handler 与 replay 共用） | handler 那次搬走 ⇒ 只剩 1 处 |
| `p3-b1-policy-gate` | N-9 窄窗计数、(c) 收口判据、scope 留存 | 整段在 gateway 里 |
| `phase3-b6-preview-hash-binding` | token 唯一创建点、ARCH-09 拒绑早于评估 | 同上 |
| `phase3-b3-receipt-ttl` | `expiresAtMs` 受 `isFinite(ttl)` 保护 | 同上 |

> **处置不是"改小断言"，而是"扩观测面"**：把这些套件的源码读取从
> `readFileSync(server.ts)` 改成 `server.ts + '\n' + gateway.ts` **合并文本**，
> 判据一字未改。
>
> 这个区别是本质的：
> - 改小断言（如把"恰 6 处"改成"恰 2 处"）⇒ 守卫变成摆设，**下次真删注入点也不会红**；
> - 扩观测面 ⇒ 守卫仍要求"恰 6 处 + 每处在 return 前"，只是不再假设代码住在哪个文件。
>
> 反过来看，这次"变红"恰好证明守卫**是有效的** —— 它准确识别出"这段代码的注入了变"，
> 只是无法自行区分"被删了"还是"搬走了"，这个判断必须由人做出并显式写进测试。

---

### Step 3.2 · 上游分支接入闸门（1.5d）✅ **已落地（2026-11-24）** ★ 本步是安全核心

> ### ⚠⚠ 本节原文的写法**实测不可实现**，且方向性错误（不是漏判，是全拒）
>
> 原文要求「复用 `gateAndExecute(entry, call.args, ctx)`」，把上游工具当成
> `UNIFIED_CAPABILITIES` 的一个条目丢进**同一个**闸。实测三处硬冲突：
>
> | # | 冲突 | 实测证据 |
> |---|---|---|
> | ① | `CapabilityEntry` 刻意不含执行体字段 | `contracts/src/unified.ts` 文件头明写「不服务于执行体实现」 |
> | ② | 上游 id 不在 `CAPABILITY_DOMAINS` | `registry.register()` 抛 `InvalidCapabilityIdError`（域名只有 `system`/`app`/`storage`/`gui`/`appops`/`meta`） |
> | ③ | **致命**：引擎第 1 步是 `registry.has(entry.id)`，而 registry 只装 vm 面 54 项 | `browser.nav.open` ⇒ `allowed=false, rule='registry:unknown-capability', code='UNKNOWN_CAPABILITY'` |
>
> ⇒ **照原文改会把「上游裸奔」变成「上游全量不可用」**，比不改更糟。
>
> #### 第二个更隐蔽的坑：vm 面参数策略会**误伤上游参数**
>
> | 调用 | vm 面裁决 | 错在哪 |
> |---|---|---|
> | `browser.nav.open {url:'https://example.com/a/b'}` | `pathAllowlist:miss` ❌ 拒 | url 被当文件路径 ⇒ **浏览器工具整体不可用** |
> | `desktop.input.type {text:'C:\Windows\System32\x'}` | `pathDenylist` ❌ 拒 | 这是要**输入的文字**，不是要写的文件 |
>
> ⇒ 「一条策略套所有面」在**语义上**就是错的，必须**按面隔离**，不能靠加白名单糊过去。

#### 实际落地方案（owner 裁定「能力统一管理」）

四层，职责互不重叠：

| 层 | 文件 | 只负责 |
|---|---|---|
| 声明 | `vm-service/src/surface-policy.ts`（新建 ~160 行） | 面 → 参数策略适用性的**唯一登记表**（无行为） |
| 执行 | `core/src/policy/engine.ts`（改） | 新增 `PolicyEngineOptions.surface`，非 `vm` 面**不编译**参数级正则 |
| 闸门 | `vm-service/src/upstream-gate.ts`（新建 ~400 行） | 上游面专用：判定 + 审计 + 执行 + 灰度 |
| 装配 | `vm-service/src/server.ts`（改 ~115 行） | `upstreamGates` 逐面建**独立引擎实例** + 路由三路分支 + fail-closed |

**隔离边界的纪律（关键，不要越界）**：

| 类别 | 成员 | 是否受面隔离影响 |
|---|---|---|
| **参数级**（答「这个参数值指向哪个系统资源」） | `pathDenylist` / `pathAllowlist` / `commandDenylist` / `registryRead,WriteAllowlist` / `processDenylist` | ✅ 只对 `vm` 面生效 |
| **能力级**（答「这个能力要不要人看一眼」） | `risk` 审批 / `capabilityApprovalDenylist` / `capabilityApprovalAllowlist` / dry-run 双条件 | ❌ **恒生效**，任何面都不裁 |

> 隔离只裁前者，**绝不裁后者** —— 否则就是「为了修误伤，把安全能力砍了」。
> 实测确认：`browser.meta.eval`（L2）在上游面仍 `requiresApproval=true`、`matchedRule='approval-required'`。

**上游面与 vm 面的语义差异（刻意保留，非遗漏）**：

- **不做服务端重放**：浏览器/桌面是有状态会话，`click {ref:'e12'}` 的 ref 属于产生它的那次快照，
  重放会打空或打错目标 ⇒ L2 一律收口 `DELEGATION_REQUIRED`，而非 `APPROVAL_REQUIRED`。
- **上游无 provider**：executed 审计必须由闸自己落（vm 面由 provider 落）。

**灰度开关**：`WINVM_UPSTREAM_POLICY=on|shadow|off`，**缺省 `on`**；**非法值回退 `on`**。
> 与 `resolvePolicyGateWiring` 缺省 `shadow` 方向相反，**有意为之**：上游面无「回退值当声明」的
> 断崖包袱，多留 shadow 一天就是多裸奔一天；而非法值绝不退回无防护。

#### 验收（owner 裁定：**行为级验证**，不用 `grep -c` 文本证据）

原文的 `grep -c "gateAndExecute"` 已作废 —— 它只能证明「字符串出现过」，
证明不了「判定对不对、审计落没落、面隔离生效没」。改为 `tests/unit/step32-upstream-gate.test.js`，**23 用例**四组：

| 组 | 条数 | 断言什么 |
|---|---|---|
| ① 判定层 | 5 | deny/execute/shadow 三态、未知工具、L2 收口 `DELEGATION_REQUIRED` |
| ② 执行层 | 7 | executed 审计真的落盘、`capabilityId` 用统一表 id、`mode='off'` **不写审计** |
| ③ 面隔离 | 9 | 浏览器 url 不被 `pathAllowlist` 误伤、桌面 `text` 不被 `pathDenylist` 误伤、能力级不缩水 |
| ④ 接线形态 | 2 | 装配点必须逐面 `new CorePolicyEngine({surface})` |

**突变反证 4 抓 4**（门禁绿不算证据）：

| 突变 | 结果 |
|---|---|
| ① 无条件放行 `if (entry.id)` | ✅ 抓 4 条 |
| ② 面隔离失效（引擎不读 surface） | ✅ 抓 2 条 |
| ③ executed 审计改名 | ✅ 抓 3 条 |
| ④ 装配点复用 vm 面引擎 `engine: policy` | ⚠️ **仅结构断言抓住**（1 条） |

> **突变 ④ 暴露的证据边界（必须诚实记录，不要夸大）**：
> 端到端行为断言**抓不住「装配点传错引擎实例」** —— 因为测试直接 `import upstream-gate.js`
> 并自己构造 deps（含 `new CorePolicyEngine({surface})`），走的是**测试自己的装配**，
> 不是 `server.ts` 的装配。装配正确性**只能靠源码结构断言**，故补了反向断言：
> ```js
> assert.doesNotMatch(segment, /engine:\s*policy\s*[,}]/,
>   '禁止把 vm 面的 `policy` 实例直接给上游闸 —— 会让上游参数被文件系统策略误伤');
> ```

> ### ⚠ 原「③ 基线两个红必须转绿」已作废（2026-11-24 实证更正）
>
> 原判：「这一步是本方案的自证点 —— 做完基线还红，说明 58 项没真正进统一表」。
> **实测推翻**，两条红的真因都不是「58 项没进表」：
>
> | 红 | 真判据 | 会转绿吗 |
> |---|---|---|
> | `phase2-snapshot-truth` | 数「全仓 src 出现 `snapshot` 字样的**文件集** = 白名单」。`mcp-upstream.ts` 命中 2 处：`:89` 的 `'desktop_snapshot'` **和 `:65` 的注释** | ❌ 把常量搬走后 `:65` 注释仍命中 |
> | `phase3-skill-claims-guard` | `registeredIds()` **从 `definitions.ts` 源码正则提取**，不读统一表；offender 是 `agent_browser_eval.md:37` 的 `response.data.unserializable`（**上游文档返回值字段路径**，非能力 ID） | ❌ 进表也无关 |
>
> ⇒ 本步验收**只保留 ①②**。两条红的处置改为**独立小修**（`15-OPTIMIZATION-DIGEST` §4.1），
> 与阶段 3 完全解耦 —— 这样阶段 3 的成败判据才干净：**看闸是否覆盖 + 审计是否落**，
> 而不是看一个与它无关的门禁数字。

---

### Step 3.3 · 能力级审批名单（1d）✅ **已落地（owner 裁定 2026-11-24）**

> ### ⚠ 本步的原始设计与 owner 实际要求**不是同一件事**（重要订正）
>
> 原文写「给 §4.4 的 4 条建议值填进 `CapabilityPolicy`」，验收是
> `grep -c "commandDenylist\|pathDenylist" definitions.ts >= 4`。那 4 条是
> **参数级**黑名单（`pathDenylist` / `commandDenylist`），语义是**命中即拒**
> （`POLICY_DENIED`，没有"批准后可执行"的空间），而且**逐能力**写在定义里。
>
> owner 2026-11-24 的要求是：
>
> | 要求 | 原设计 | 实际落地方案 |
> |---|---|---|
> | 黑名单的操作**需要审批** | ❌ 命中即**拒** | ✅ 新增 `capabilityApprovalDenylist` ⇒ `APPROVAL_REQUIRED` |
> | 白名单的操作**不需要审批** | ❌ 不存在此概念 | ✅ 新增 `capabilityApprovalAllowlist` |
> | 黑名单优先级**更高** | — | ✅ `denylist` 先于 `allowlist` 判定 |
> | 白名单先**留空** | — | ✅ `[]`（机制在，无条目） |
> | 名单是**能力级**、全局可配 | ❌ 参数级、逐能力 | ✅ 放在 `PolicyConfig`（走 `mergePolicy` 并集） |
>
> ⇒ 这是**新增语义**，不是填 4 个值。两者不可复用同一字段：把能力 ID 写进
> `pathDenylist` 会得到「直接拒绝」，运维会困惑「为什么没弹审批让我确认」。

**做什么**

1. `contracts/src/capability.ts` — `CapabilityPolicy` 加两个可选字段
   `capabilityApprovalDenylist` / `capabilityApprovalAllowlist`（含长注释说明
   与参数级 denylist 的语义差异、优先级理由、L3 不豁免理由）
2. `contracts/src/bridge.ts` — 两个新 `matchedRule` 哨兵常量
   - `POLICY_CAPABILITY_APPROVAL_DENY_MATCHED_RULE = 'approval-required:capability-denylist'`
   - `POLICY_CAPABILITY_APPROVAL_ALLOW_MATCHED_RULE = 'allow:capability-allowlist'`
   - **为什么要与默认 `approval-required` 分开**：否则审计里一堆同值，运维无法判断
     名单是否真的生效 —— 「配了却没生效」正是这类配置最典型的静默失效
3. `core/src/policy/defaults.ts` — `PolicyConfig` 加两个必填字段 + `DEFAULT_POLICY`
   填初始黑名单（**14 条**）+ 白名单 `[]`；`mergePolicy` 对两者走**并集**
4. `core/src/policy/engine.ts` — 判定顺序从 7 步扩为 **6a/6b/6c/6d 四档**（见下）

**判定顺序（改造后）**

```
6a. dry-run + 能力声明 supportsDryRun → 放行      ← 原 D11/U-P0-3，语义未变；**必须在 6b 之前**
6b. 命中能力级强制审批名单 → APPROVAL_REQUIRED    ← 与 risk 无关，能把 L0/L1 拉进审批
6c. 命中能力级免审批名单   → 放行（仅 L2，L3 不豁免）
6d. risk ≥ L2 且未审批     → APPROVAL_REQUIRED    ← 原有默认行为
```

> ### ⚠ 为什么 6a 必须排在 6b **之前**（我第一版排反了，已实测推翻）
>
> 第一版把能力级黑名单放在 dry-run **之前**，理由是「名单表达『这条能力本身要人看』，
> 与是否 dry-run 无关」。**这个判断是错的**，它打挂了三个既有套件
> （`cl017` 1 条、`p0-path-traversal` 5 条、`r19b-s5` 2 条）。
>
> 反例：`system.power.control` 声明 `supportsDryRun: true`，且 `description` 明确写
> 「关机/重启/休眠/睡眠。**必须先 dry-run**」。黑名单拦 dry-run 等于**把「先看计划
> 再确认」这条安全流程本身掐断** —— 运维只能盲批，安全效果反而更差。
>
> 这**不**重新引入 U-P0-3 漏洞：dry-run 免批仍受**双条件**约束
> （① 调用方传 `dryRun`；② 服务端在能力定义上声明 `supportsDryRun`）。
> 只满足 ① 而 ② 不成立时，免批不生效、继续走 6b —— 这正是 U-P0-3 的防线。
> 两条语义分别由 `vnext-33` A 组的两条互补用例钉住（未声明 ⇒ 被拦；已声明 ⇒ 先放行）。

**初始黑名单（14 条，从宽）**

| 类别 | 条目 |
|---|---|
| 存储删除/回收站 | `storage.file.delete` `storage.recycle.manage` `storage.archive.manage` |
| 应用卸载/改包 | `app.winget.uninstall` `app.appx.manage` |
| 关机/结束进程 | `system.power.control` `system.process.terminate` |
| 服务/计划任务 | `system.service.configure` `system.service.control` `system.task.scheduled` |
| 注册表/用户/环境变量 | `system.registry.write` `system.user.manage` `system.env.manage` |
| 网络配置 | `system.network.config` |

**入选标准（三条全满足才进）**：① 后果不可逆或难以回滚；② 影响面超出单次操作；
③ 误操作不会立刻被发现（用户看界面正常，几小时后才出问题）。

**为什么从宽**：名单的风险**不对称** —— 漏一条 = 危险动作免审批直接执行（不可逆）；
多列一条 = 多一次点击确认（成本可忽略）。要放宽请改用 `capabilityApprovalAllowlist`
（显式、留痕、可审计），**不要删黑名单的行**（删了没人知道它曾经为什么需要）。

**明确不列**：纯读（`*.list`/`*.get`/`*.query`/`*.read` 等只读动词）、可完全回滚的单次写
（`storage.file.copy`）、查询类（`app.inventory.list`/`app.winget.search`）。

> **措辞纪律（实测踩到的坑）**：这段注释**不能**出现某个「审计快照」的英文单词
> （连 `tests/unit/phase2-*truth.test.js` 这个文件名都不能写全）。
> 那个测试用大小写不敏感的正则扫**全仓 src** 找「消费侧」，粗筛会把**注释**也算命中，
> 于是 `defaults.ts` 被判「名单外文件新增消费」而红。正确处置是**改注释措辞**，
> **不是**把 `defaults.ts` 加进它的白名单（那会连真正的消费一起放行，守卫变摆设）。

**验收**

```bash
node --test tests/unit/vnext-33-approval-lists.test.js
# 期望：tests 18 / pass 18 / fail 0
```

**验收判据（突变反证 3 抓 3，证明非空转）**

| 突变 | 结果 | 说明 |
|---|---|---|
| ① 黑名单判定失效（`if (false && ...)`） | `vnext-33` **9 条 FAIL** | A/C/D/E 组同时红；`cl017`/`r19b-s5` 仍绿（**预期**：它俩测的是「要审批」，不测「名单是否生效」） |
| ② 黑名单命中直接 `return allowed:true`（真语义错） | 三套件全抓：`cl017` **2** / `r19b-s5` **4** / `vnext-33` **9** | 证明**放宽后的断言仍咬得住真错**（不是靠字面量巧合） |
| ③ dry-run 免批条件失效（`if (false && supportsDryRun)`） | `cl017` 1 / `p0-path-traversal` 5 / `vnext-33` **1** | ①轮曾**抓不到**（覆盖缺口），补了两条互补用例后闭合 |

> **突变 ③ 暴露的真实缺口**：原 `vnext-33` 那条「dry-run 不能绕过黑名单」是**因巧合通过** ——
> 夹具 `gui.window.maximize` 恰好没声明 `supportsDryRun`，dry-run 分支本就不生效，
> 于是它自然落进黑名单分支。文档写了「6a 在 6b 之前」，却**没有测试验这个顺序**。
> ⇒ 重写为两条互补用例（未声明 ⇒ 拦；已声明 ⇒ 先放行且去掉 dryRun 仍拦）。
> **教训：断言「通过」不等于「测到了」，必须用突变反证。**

**两条设计取舍（写进代码注释，防止后人"优化"掉）**

1. **dry-run 可以绕过能力级黑名单，但只对声明了 `supportsDryRun` 的能力**。
   这是本轮**订正过的判断**（第一版写的是「不能绕过」，已被实测推翻，见上文 ⚠ 块）。
   真正的防线是**双条件**：调用方意图 + 服务端声明。名单拦的是「真实执行」，
   不拦「零变更的计划预览」—— 后者正是让人看清楚再决定的手段。
2. **白名单只对 L2 生效，L3 不豁免**。L3 语义是「可能导致系统不可用或数据全损，
   需审批 + 二次确认」，用配置项豁免 L3 等于把风险模型最强档架空。
   确需放行某条 L3，正确做法是**下调它的 risk 并说明理由**（留痕、可审计），
   而不是往白名单加一行（无人知道它为什么被豁免）。

---

### Step 3.4 · 阶段 3 收口（0.5d）✅ **已收口（2026-11-24）**

**判据（按 owner 裁定改为实际比对，不用 `grep -c`）**

| 判据 | 结果 |
|---|---|
| ① 上游项 = 58 | ✅ `58`（browser 33 + desktop 25） |
| ② 缺 `tool` 字段 = 0 | ✅ `0` |
| ③ `surface::tool` 重名 = 0 | ✅ `0`（闸的索引键唯一） |
| ④ **统一表 ↔ 上游实际暴露面双向零差异** | ✅ 缺表 0 / 多余 0（**新增判据，见下**） |
| ⑤ 门禁 `--quick` 失败清单逐字不变 | ✅ 2 红（`phase2-snapshot-truth` 1 + `phase3-skill-claims-guard` 1），与改前同一批 |
| ⑥ 全量单测零新增失败 | ✅ 5 文件 / 17 条，逐文件计数与基线**完全相同** |

> #### ★ ④ 是本次新增的判据，原计划书没有（而且是原判据的漏洞）
>
> 原判据只问「58 项是否都在表里 + 是否都有 tool 字段」，但**答不出**最致命的那个问题：
> **表里的 `tool` 名与上游真正暴露的工具名是否逐字一致**？
> 不一致的后果是**双向的**，而且两个方向都是哑的：
> - 表多一个（上游没暴露）⇒ 死条目，闸永远命中不到，白留一条规则；
> - 表少一个（上游暴露了但表里没有）⇒ 该工具**每次调用都被判 `UNKNOWN_UPSTREAM_TOOL`**，
>   即「装了闸反而把工具锁死」—— 正是 Step 3.2 原文那个方向性错误的缩小版。
>
> 故补一条**以事实源为准**的双向断言（`DEFAULT_DESKTOP_TOOL_ALLOWLIST` / `BROWSER_TOOLS`
> 是 `McpUpstream.exposedTools()` 的过滤依据，即「可达面」的唯一事实源）：
> ```
> desktop: 暴露 25 / 表 25 / 缺表 0 / 多余 0
> browser: 暴露 33 / 表 33 / 缺表 0 / 多余 0
> ```
>
> 判据的可靠来源不在测试里，而在 `upstream-tools.ts` 的**模块加载期强校验**：
> `defineDesktopTools()` 逐条从白名单派生，长度必须相等、每个 `tool` 都必须能在白名单找到，
> 不符就**加载即抛** —— 因为「白名单多一个而统一表少一个」正是 fail-open 的入口，
> 不能等到跑测试才发现。

**阶段 3 交付物**：58 个裸奔工具全部进闸 + 审计全覆盖 ✅
**基线那 2 个红的处置**：与阶段 3 **解耦**（实测真因见 §1 的 ⚠ 作废块，`phase3` 的 offender 是
`agent_browser_eval.md:37` 的 `response.data.unserializable` —— **上游文档返回值字段路径，非能力 ID**，进表也无关）。

---

### Step 3.6b · 【3.6b】CLI 工具面补齐（1d，**必须紧跟阶段 3 之后**）✅ **已落地（2026-11-24）**

> **这是本计划唯一一个"顺序反了就净增风险"的步骤。**
> 开工前先确认闸真的装好了，否则等于给 58 个裸奔工具再开一道门。

**开工前置检查（四条全过才开工）— ✅ 全过**

| 检查 | 期望 | 实测 |
|---|---|---|
| ① 上游分支调了闸 | ≥ 1 | ✅ `gateUpstreamAndExecute` 3 处 |
| ② 上游执行写了审计 | ≥ 1 | ✅ `audit.append`/`recordUpstreamAudit` 6 处 |
| ③ 58 项可按 `surface+tool` 命中 | = 58 | ✅ 58 |
| ④ **改前护栏基线** | `tests 61 / pass 61 / fail 0` | ✅ 逐字一致 |

**改前必读：9 条护栏断言会被本步打破（不是 bug，是必经）**

| 文件 | 行 | 断言 |
|---|---|---|
| `phase2-inner-credential.test.js` | 106 / 107 / 123 / 124 / 125 | `buildMcpConfig(...) === LEGACY_OUT(URL)` |
| 同 | 128 | 整串 `{"mcpServers":{"winvm":…}}` 逐字相等 |
| `r19c-kn1-b-bridge.test.js` | 354 | `buildMcpConfig(URL) === LEGACY_OUT(URL)` |
| 同 | 363 | 整串逐字相等 |
| 同 | 365 | `Object.keys(parsed.mcpServers)` 恰为 `['winvm']` |

**处置 = 等价搬迁（已实测可等价，见 `13` §3.6.1「隐形阻塞」+ P-2b）**：
改后 `winvm` 条目与旧输出**逐字节相等**（`base + '/mcp' + search === endpoint`），
所以把这 9 处改写成「`winvm` 单条目逐字相等 + `mcpServers` 恰 3 键」即可，**覆盖面不减反增**。
把 `LEGACY_OUT` 改名 `LEGACY_WINVM`（只产出 `winvm` 单条目），供逐字比对继续用。
**9 处必须与实现同 commit。**

**做什么（1 个文件，1 个函数）**

`packages/adapter-agent-workbuddy-llm/src/bridge.ts` 的 `buildMcpConfig()` 从 1 个条目扩成 3 个。
完整代码与注释见 `13` §3.6.1。要点三条：

| 要点 | 说明 |
|---|---|
| **基址推导用 `deriveMcpBase()`，不用尾正则** | `endpoint` 可被配置覆盖成 `…/mcp/`（尾斜杠）或 `…/mcp?x=1`（带 query），`/\/mcp$/` 对这两种**静默失效** ⇒ 拼出 `…/mcp//mcp/browser` 404。正确实现见 `13` §3.6.1；形态不符时**退回单条目 + `logger.warn`**，不猜不抛 |
| **`dtid` 统一走 `appendDtid()`** | 不要自己拼 `?dtid=` —— 会把 query 拼接逻辑复制成第二份（`appendDtid` 已处理 `?` 与 `&` 分支和 `encodeURIComponent`） |
| `bearerEnvName` 三态语义 | `undefined`/`null` ⇒ 返回空 `mcpServers`（逐字旧行为）；**空串** ⇒ 有条目**无** `headers`；非空 ⇒ 每条都带同一个 `headers` 引用。实测基线：空串当前产出 `{"winvm":{...}}` 无 headers |

**验收（可复制）**

```bash
# ① 三个条目都在，且都带 dtid
node --input-type=module -e "
const m=await import('./packages/adapter-agent-workbuddy-llm/dist/index.js');
const cfg=JSON.parse(m.buildMcpConfig('http://127.0.0.1:18443/mcp','dtid-abc','WINVM_TOKEN'));
const names=Object.keys(cfg.mcpServers);
console.log('servers=',names);
for(const [k,v] of Object.entries(cfg.mcpServers)) console.log(' ',k,'->',v.url,'dtid?',String(v.url).includes('dtid=dtid-abc'));
if(names.length!==3) process.exit(1);
if(!names.every(n=>cfg.mcpServers[n].url.includes('dtid='))) process.exit(1);
"
# 期望：servers=[ 'winvm', 'winvm-browser', 'winvm-desktop' ]，三条 dtid? true

# ② 三态语义逐字不变（P-2）：undefined / null / 空串 / 有值
node --input-type=module -e "
const m=await import('./packages/adapter-agent-workbuddy-llm/dist/index.js');
const a=m.buildMcpConfig(undefined,'x','ENV');        // 无 endpoint
const b=m.buildMcpConfig('http://h/mcp','x',null);    // 显式关凭据
const c=m.buildMcpConfig('http://h/mcp','x','');      // 空串 ⇒ 有条目、无 headers
const d=m.buildMcpConfig('http://h/mcp','x','ENV');   // 有值 ⇒ 带 headers 引用
console.log('a=',a); console.log('b=',b);
console.log('c=',c); console.log('d=',d);
if(a!=='{\"mcpServers\":{}}') process.exit(1);
if(b!=='{\"mcpServers\":{}}') process.exit(1);
// c 在扩成三条后应有 3 个条目且都无 headers
if(Object.keys(JSON.parse(c).mcpServers).length!==3) process.exit(1);
if(JSON.stringify(c).includes('headers')) process.exit(1);
// d 三条都带同一个 headers 引用
if(Object.values(JSON.parse(d).mcpServers).some(v=>!v.headers)) process.exit(1);
"
# 期望：a、b 都是 {"mcpServers":{}}；c 三个条目无 headers；d 三条都有 headers
# 注：a/b 两条是**逐字比对**，c/d 的条目数断言是扩成三条后的新期望

# ③ 凭据防线仍在（P-3）
grep -c "containsBearerCredentialLiteral" packages/adapter-agent-workbuddy-llm/src/bridge.ts
# 期望：>= 2

# ④ ★ 三条目共用同一 dtid 且 path 正确（P-1 的正面断言）
node --input-type=module -e "
const m=await import('./packages/adapter-agent-workbuddy-llm/dist/index.js');
const cfg=JSON.parse(m.buildMcpConfig('http://127.0.0.1:18443/mcp','T1','E'));
const want={'winvm':'/mcp?','winvm-browser':'/mcp/browser?','winvm-desktop':'/mcp/desktop?'};
for(const [k,v] of Object.entries(want)){
  const url=cfg.mcpServers[k].url;
  if(!url.includes(v)){console.log('BAD',k,url);process.exit(1)}
  if(!url.includes('dtid=T1')){console.log('NO DTID',k,url);process.exit(1)}
}
console.log('all three paths + dtid OK');
"
# 期望：all three paths + dtid OK
# 关键：base 取自 endpoint（.../mcp → ...），三个 path 分别拼回 /mcp、/mcp/browser、/mcp/desktop

# ⑤ 反向断言：不要留下旧的一条目实现（防"改一半"）
grep -c "mcpServers: { winvm: entry }" packages/adapter-agent-workbuddy-llm/src/bridge.ts
# 期望：0

# ⑥ ★ 端点形态异常时安全降级（不猜、不抛）
node --input-type=module -e "
const m=await import('./packages/adapter-agent-workbuddy-llm/dist/index.js');
// 不是 /mcp 结尾 ⇒ deriveMcpBase 返回 null ⇒ 退回单条目
const r=JSON.parse(m.buildMcpConfig('http://127.0.0.1:18443/','T1','E'));
const names=Object.keys(r.mcpServers);
console.log('abnormal endpoint -> servers=',names);
if(names.length!==1||names[0]!=='winvm') process.exit(1);
// 尾斜杠 / 带 query 的 /mcp 仍应展开成 3 条
for(const ep of ['http://127.0.0.1:18443/mcp/','http://127.0.0.1:18443/mcp?foo=1']){
  const n=Object.keys(JSON.parse(m.buildMcpConfig(ep,'T1','E')).mcpServers);
  console.log(ep,'->',n.length,'servers');
  if(n.length!==3) process.exit(1);
}
"
# 期望：abnormal endpoint -> servers=[ 'winvm' ]；两种异常形态各 3 servers
# 已离线验证期望值成立：…/18443/ ⇒ base=null ⇒ 1 条；…/mcp/ 与 …/mcp?foo=1 ⇒ base 正确 ⇒ 3 条

# ⑦ ★ 9 条护栏断言已等价搬迁完成（P-2b）—— 必须与实现同 commit
node --test tests/unit/phase2-inner-credential.test.js tests/unit/r19c-kn1-b-bridge.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)"
# 期望：tests 61 / pass 61 / fail 0（与前置检查 ④ 的基线**条数相同**）
#   ⚠ 若条数变少 ⇒ 说明有人"删断言换绿"，不是等价搬迁。只许改断言写法，不许删用例

# ⑧ ★ 新护栏：winvm 条目仍与旧实现逐字节相等（这是"等价"的正面证明）
node --input-type=module -e "
const m=await import('./packages/adapter-agent-workbuddy-llm/dist/index.js');
const LEGACY_WINVM=(ep)=>JSON.stringify({winvm:{type:'streamableHttp',url:ep}});
const URL_='http://127.0.0.1:18443/mcp';
for(const [d,b] of [[undefined,undefined],['tr_1',undefined],[undefined,'WINVM_BEARER_TOKEN'],['tr_t6_1','WINVM_BEARER_TOKEN'],['',undefined],['   ',undefined]]){
  const cfg=JSON.parse(m.buildMcpConfig(URL_,d,b===undefined?undefined:(b&&b.trim()?b.trim():'')));
  const got=JSON.stringify({winvm:cfg.mcpServers.winvm});
  let want=LEGACY_WINVM(URL_+(d?('?dtid='+d):''));
  if(b&&b.trim()) want=JSON.stringify({winvm:{type:'streamableHttp',url:URL_+(d?('?dtid='+d):''),headers:{Authorization:'Bearer \${'+b.trim()+'}'}}});
  if(got!==want){console.log('DRIFT',JSON.stringify({d,b}),got);process.exit(1)}
  if(Object.keys(cfg.mcpServers).length!==3) process.exit(1);
}
console.log('winvm entry byte-identical across 6 combos, all 3 servers present');
"
# 期望：winvm entry byte-identical across 6 combos, all 3 servers present
```

**收口**：§1 四件套 + **额外**确保 `bridge.ts` 行数**只增不减**（`wc -l` 记下改前改后；
若减少 ⇒ 说明误删了 `persistent-session` 相关逻辑，必须回滚）。

> #### ✅ 实测收口结果（2026-11-24）
>
> | 项 | 结果 |
> |---|---|
> | `bridge.ts` 行数 | **1892 → 1993（+101，零删除）** ✅ |
> | 8 条验收 | ✅ 全过（含 `deriveMcpBase` 六形态、异常降级恰告警 1 次、6 组合逐字节等价） |
> | 9 处护栏断言 | ✅ 等价搬迁，**条数不变 61/61** —— 零删用例，不是「删断言换绿」 |
> | `tsc -b` | ✅ BUILD_RC=0 |
>
> #### ★ 实现上比原文**更强**的一处偏离（有意为之）
>
> 原文写 `winvm` 条目用 `base + '/mcp' + search` **拼回** endpoint，理由是
> 「该式恒等于 endpoint，是最好的回归不变量」。但实测该等式**不是恒成立的**：
> `new URL()` 会做规范化（协议/主机名小写、默认端口 `:80`/`:443` 剥离、路径百分号解码等），
> 一旦发生规范化，「拼回来」的串就与入参不同 ⇒ 逐字节护栏失效。
>
> 故改为**直接复用原始 `endpoint`**：`winvm: mk(endpoint)`。等式从「推导出来的巧合」
> 变成「恒等式」，且实测在 `…/mcp/`（尾斜杠）形态下保留了原始尾斜杠，
> 对 CLI 传入的任何 endpoint 形态都**零漂移**。
>
> #### ★ 降级告警的出口（新增，原文未提）
>
> `buildMcpConfig` 是**纯函数**（被 3 个测试文件逐字节比对），不能持有服务 logger。
> 新增 `setMcpConfigWarnSink(sink?)` 注入式出口，**默认写 stderr**；`index.ts` 已导出。
> 告警只传**消息文本**，不含配置内容（连 token 变量名的整串也不传）。
> 实测：形态不认识时**恰告警一次**（不是每次 3 条各告警一遍）。

---

## 5. 阶段 4：provider 降级为 planner（4d）

### Step 4.1 · 定义 `Planner` 接口（0.5d）✅ **已落地（2026-11-24）**

```ts
// packages/contracts/src/planner.ts（新增，已落地）
export type PlannerId = 'template' | 'cli-agent';

export interface Planner {
  /** 见 PlannerId 的取值说明。 */
  readonly id: PlannerId;
  plan(goal: GoalRequest, sink: ProgressSink): Promise<GoalResult>;
}
```

> **id 用 `'cli-agent'` 不用 `'llm'`**（owner 2026-11-24 澄清 3 的直接推论）：
> 路径 2 是**交给 VM 内 codebuddy-lite native agent 干活**，不是「直接调用配置里的 LLM 完成任务」。
> 叫 `'llm'` 会把下一个维护者引到「这是个 LLM API 适配器」的误读上，进而真想把它删掉。
> 名字本身就是防误读的文档。详见 `13` §5.1b / §5.2.1。

**验收 — ✅ 全过**

| 判据 | 结果 |
|---|---|
| `tsc -b` | ✅ BUILD_RC=0 |
| `PlannerId` 联合类型形态 | ✅ `'template' \| 'cli-agent'` |
| 代码面**不含** `'llm'` / `runGoal` / `init(` / `execute(` / `health(` / `shutdown(` | ✅ |
| `plan(goal: GoalRequest, sink: ProgressSink): Promise<GoalResult>` 签名 | ✅ 逐字符合 |

> #### ⚠ 验收脚本必须**剥注释后再判**（本次实测踩到）
>
> 初版直接用 `grep -c "'llm'"` 与 `grep -c "runGoal"` 判，**双双误报**：
> - `'llm'` 出现 2 次 —— 全在注释里（「为什么**不**叫 `'llm'`」的说明文字）；
> - `runGoal` 出现 —— 全在注释里（「`AgentServiceProvider` 原来扛了 runGoal 等五件事」）。
>
> 这与项目门禁已知的「三类假绿」同源，只是方向相反 —— 那边是**注释让守卫假绿**，
> 这边是**注释让守卫假红**。两者根因相同：**判据锚在字符串上，而字符串同时承载代码与文档**。
> 处置：`stripComments()` 剥掉块注释与行注释后再做代码面断言（并在输出里打印剥完的代码面供人眼复核）。
>
> 教训可复用：**任何「不许出现某个符号」的守卫，都必须先剥注释**；否则解释「为什么不用它」
> 这件事本身就会触发守卫 —— 而这恰恰是最该被鼓励写下来的话。

---

### Step 4.2 · `deterministic` 的 `runGoal` 抽成 `TemplatePlanner`（1d）✅ **已落地（2026-11-24）**

**做什么**：把 `adapter-agent-workbuddy/src/index.ts:577` 的 `runGoal` 逻辑
移到一个 `TemplatePlanner` 类，`DeterministicAgentProvider.runGoal` 变成 `this.planner.plan()`。

**实际落点**

| 文件 | 变化 |
|---|---|
| `adapter-agent-workbuddy/src/template-planner.ts` | **新建**（~500 行）：`TemplatePlanner` + 4 个模块级纯函数 |
| `adapter-agent-workbuddy/src/index.ts` | `runGoal` 272 行 → **2 行转发**；删 4 个私有方法；1405 → 1086 行 |

**窄依赖面（`TemplatePlannerDeps`，只有 5 项）**

| 成员 | 为什么必须在外面 |
|---|---|
| `execute` | 真正的执行体（含策略闸/并发/审计），只有 provider 有 |
| `capabilityRisk` | 风险级别来自注册表（`ctx.capabilities`），planner 不持有注册表 |
| `newTraceId` | traceId 须由 provider 统一生成，planner 自造会与服务端归因脱节 |
| `policyGateWiring` | 读进程级 env 决议，不是 planner 的配置 |
| `enableLlmPlanning` | 同上，只影响一句文案 |

> **为什么用窄接口而不是把 provider 传进来**：依赖整个 provider 会让 planner 与其
> 14 个私有成员死绑 —— 看起来抽出来了，实际还是连体的；下次谁想删 provider，
> 会发现 planner 跟着不能编译。窄接口的边界是**可数的**（5 项就是答案）。

**等价性证明（纯搬移的机器可读面）**

| 判据 | 结果 |
|---|---|
| 正则字面量集合（旧 runGoal 273 行 vs 新文件） | ✅ 新文件**零缺失**（旧 1 个全覆盖，新 5 个含新增的） |
| 中文字符串字面量（≥6 字） | ✅ **零缺失**（旧 18 条全在，新增 1 条来自搬来的 `goalCanceled` 文案） |
| `tsc -b` | ✅ BUILD_RC=0 |
| 全量单测 | ✅ 回到基线 5 文件 / 17 条 |

> #### ⚠⚠ 本步踩到的真坑：搬移会让**源码形态守卫集体假红**（2 个文件）
>
> `p3-b1-policy-gate`（1 条）与 `phase2-contract-code-fidelity`（2 条）都读
> `adapter-agent-workbuddy/src/index.ts` 做形态断言，代码搬走后它们读不到 ⇒ 报红。
>
> **这与 Step 3.1 抽 `gateway.ts` 时是同一个问题，处置也必须是同一个**：
>
> | 错误处置 | 正确处置 |
> |---|---|
> | 把断言删掉/改小（如把 `policyGateWiring === 'on'` 那几条去掉） | **扩大观测面**：读 `index.ts + template-planner.ts` 合并文本 |
> | 后果：守卫变摆设，下次真删注入点也不红 | 后果：判据一字未改，只是不再假设代码住在哪个文件 |
>
> 唯一允许的调整是**锚点正则适配新形态**：
> `this\.policyGateWiring` → `this\.(?:deps\.)?policyGateWiring`（搬运后多了 `deps` 层）。
> 这是「同一判据、不同写法」，不是放宽。
>
> **突变反证（证明守卫没变成空转）**：
> | 突变 | 结果 |
> |---|---|
> | `template-planner.ts`：`=== 'on'` → `!== 'off'` | ✅ 抓住（`scopeFeed 仅 on 态` 红） |
> | `template-planner.ts`：结构化透传 → `error: res.error.message` | ✅ 抓住（2 条红） |
> | 注：第一次突变写成 `(res.error as any).message`，**没抓住** —— 因为守卫正则找的是逐字 `error: res.error.message`。突变体必须与守卫判据**逐字对偶**，写成「语义等价但形态不同」的变体会产生假阴性 | ⚠ 已记录 |

**验收**

```bash
# 纯搬移：行为零变化，用现有 runGoal 单测证明
node --test tests/unit/*.test.js 2>&1 | grep -E "runGoal|goal" | head
grep -c "implements Planner\|TemplatePlanner" packages/adapter-agent-workbuddy/src/index.ts
# 期望：>= 1（且 runGoal 逻辑已移出，runGoal 变成 this.planner.plan()）
node scripts/gate.mjs --quick 2>&1 | grep -E "^VERDICT|^FAILED_FILES|^FAIL "
# 期望：失败清单与阶段 3 收口一致（本步是纯搬移，不应新增任何失败）
```

---

### Step 4.3 · `llm` 包的 `runGoal` 改成 `CliAgentPlanner`（1.5d）✅ **已落地（2026-11-24）**

**做什么**：`adapter-agent-workbuddy-llm` 不再实现 `AgentServiceProvider`，
改实现 `Planner`（`id='cli-agent'`）。**`bridge.ts` / `persistent-session.ts` 一行不动**，
只在外面套一层 `plan()`：`GoalRequest` → CLI 入参，CLI 输出 → `GoalResult`。

> **本步是全计划最高危的"改错方向"点**：路径 2 的执行主体是 **VM 内 codebuddy-lite native agent**
> （owner 2026-11-24 澄清 3），不是配置里的 LLM API。所以「去掉 provider 身份」= 换外壳，
> **不是**削减能力。任何导致 `bridge.ts` 变短的改法都是错的（见 Step 4.5 验收 ③）。

**实际落点**

| 文件 | 变化 |
|---|---|
| `adapter-agent-workbuddy-llm/src/cli-agent-planner.ts` | **新建**（292 行）：`CliAgentPlanner` + `CliAgentPlannerDeps`（10 项） |
| 同包 `src/index.ts` | `runGoal` 182 行 → **2 行转发**；708 → 568 行 |
| 同包 `src/bridge.ts` | **零改动**（1993 行不变）✅ |
| 同包 `src/persistent-session.ts` | **零改动**（1144 行不变）✅ |

**验收 — 逐条实测**

| # | 判据 | 结果 |
|---|---|---|
| ③ | `bridge.ts` / `persistent-session.ts` 行数不减 | ✅ **1993 / 1144**（与改前逐字相同，`git diff --numstat` 对 `persistent-session.ts` 为空） |
| ② | 仍导出 planner，`id` 是 `cli-agent` | ✅ `CliAgentPlanner` 已导出，`readonly id: PlannerId = 'cli-agent'` |
| ④ | 门禁失败清单与阶段 3 收口一致 | ✅ 5 文件 / 17 条，逐文件计数完全相同 |
| — | **行为等价（比原验收更强）** | ✅ 三个 provider 语义守卫全绿：`r19c-kn1-d-provider` 28、`llm-provider` 20、`phase1-t5-provider-cancel` 12 |
| — | 文案零漂移（机器可读面） | ✅ 旧 `runGoal` 182 行的 19 条中文串**全在新文件**，新增 3 条全是我写的注释文字 |

> #### ⚠ 验收 ① 无法在本步单独达成（**计划书的 4.3 与 4.4 是耦合的**）
>
> 原文验收 ①：`grep -c "AgentServiceProvider" packages/adapter-agent-workbuddy-llm/src/index.ts`
> **期望：0**。实测：**5**（注释 1 + 类型导入 1 + `executor` 字段 2 + `implements` 1）。
>
> 为什么减不到 0 —— 这不是偷懒，是结构事实：
> `AgentServiceProvider` 的引用面有 **8 个文件**（`adapter-agent-workbuddy`、`contracts/bridge.ts`、
> `contracts/planner.ts`、`core/bridge/loader.ts`、`vm-service/server.ts`、
> `vm-service/capabilities-profile.ts`、两个 adapter）。其中：
> - `executor` 字段的类型就是它（D-4.4 降级要调 `this.executor.runGoal`）；
> - `core/bridge/loader.ts` 的 `loadProvider()` 返回它；
> - `server.ts` 的 `provider` 变量声明为它，`runtime.intersectDeclared(provider.declareCapabilities())` 靠它。
>
> ⇒ **先在 4.3 删掉本包对它的引用，等于让 4.4 之前的所有装配点失去类型**（编译不过）。
> 正确顺序是 **4.3 + 4.4 合并**：4.4 删 `loader.ts`、把 `ServiceConfig.agent` 收成单值
> `{ planner }`，届时 `provider` 概念消失，`AgentServiceProvider` 才会自然归零。
>
> 因此本步只交付「**执行体已抽出 + 行为零变化 + CLI 链路零改动**」，
> ① 移交 4.4 收口。**已在 §4.5 收口表里登记这个顺序依赖**，不假装已完成。

**验收**

```bash
# ① 该包不再导出 provider
grep -c "AgentServiceProvider" packages/adapter-agent-workbuddy-llm/src/index.ts
# 期望：0 —— ⚠ 实测 5，须与 4.4 合并完成（见上方说明）

# ② 仍导出 planner，且 id 是 cli-agent
grep -c "CliAgentPlanner\|implements Planner" packages/adapter-agent-workbuddy-llm/src/index.ts
grep -c "'cli-agent'" packages/adapter-agent-workbuddy-llm/src/index.ts
# 期望：各 >= 1

# ③ ★ CLI 链路行数不得减少（防"降级"被做成"删除"）
wc -l packages/adapter-agent-workbuddy-llm/src/bridge.ts \
      packages/adapter-agent-workbuddy-llm/src/persistent-session.ts
# 期望：1993 / 1144（3.6b 后基线；只增不减）

# ④ 门禁：失败清单与阶段 3 收口一致（不是"绿了就行"）
node scripts/gate.mjs --quick 2>&1 | grep -E "^VERDICT|^FAILED_FILES|^FAIL "
```

---

### Step 4.4 · 删 `bridge/loader.ts` + 配置改单值（1d）✅ **已落地（2026-11-25，两段式）**

> #### ⚠⚠ 计划书原文的三处前提被实测推翻（owner 2026-11-25 裁定「两段式」）
>
> 原文要「删 loader + `providers` 三段删成 0」。实测发现 `providers` **不只是三段配置**，
> 它同时承担三个没人写在计划书里的职责：
>
> | # | 真实职责 | 证据 | 删掉的后果 |
> |---|---|---|---|
> | ① | **测试替身注入通道** | `registerProviderFactory(id, 桩)` + `providers[id]` 占位 entry，是 `p4-b10`(11 条) / `p5-c0`(9 条) 的**唯一**注入方式 | 19 条 e2e/单测断言失去注入面 ⇒ 只能靠真跑 codebuddy CLI 才测得了，等于不测 |
> | ② | **bearer fail-closed 判据源** | `http-guard.ts:294` 读 `providerOptions.bearerEnvName`；`phase2-inner-credential.test.js:582` 已钉死 `agent.providers.workbuddy.options` 键路径 | 「守卫已生效但凭据未接线」失去数据来源 ⇒ 该判据只能删或假绿 |
> | ③ | **CLI 探针 + 安装脚本的配置入口** | `cli.ts:106` `await import(entry.package)`；`install-vm.mjs:540,601,826` 读写 `agent.providers[provider].options` | `winvm doctor` 的「包可解析」自检与一键安装的 options 注入同时失效 |
>
> ⇒ **纯删除是错的**（会把「收敛概念」做成「砍断三条真实通路」）。裁定走**两段式**：
> **删掉动态 import 机制**（那才是真病灶），**保留注册表**（降级为注入通道 + options 载体），
> 另加 `agent.planner` 作为唯一生产装配键。核心判据不再是 `grep providers == 0`，
> 而是**「生产装配路径零 `await import(`」** —— 那是更强、且直指病灶的判据。

**实际落点**

| 文件 | 变化 |
|---|---|
| `packages/core/src/bridge/loader.ts` | **删除**（111 行） |
| `packages/core/src/bridge/registry.ts` | **新建**（~160 行）：同一张注册表，**删掉 `await import(package)` 回落**；未注册时文案改指向 planner |
| `packages/vm-service/src/agent-assembly.ts` | **新建**（~200 行）：`planner → 静态注册 → 查表`，静态 import 两个 adapter |
| `core/src/config/index.ts` | `AgentProviderConfig` 加 `planner?`（类型复用 `PlannerId`）；出厂值加 `planner:'template'`；解析只透传原值；校验改两路接受 |
| `vm-service/src/server.ts` | `loadProvider(cfg.agent,…)` → `loadAgentProvider(...)`；`/health.planner` 恒落 |
| `contracts/src/bridge.ts` | `HealthStatus.planner?`（纯附加） |
| `bridge.ts` / `persistent-session.ts` | **零改动**（1994 / 1145，`bridge.ts` 因 3.6b 遗留 +1 行本不属于本步） |

**★ 为什么「静态 import 只能落在 vm-service」**

`core` 的 `package.json` 依赖只有 `contracts`（+ `ssh2`）⇒ `core` **不能** import 两个 adapter，
否则构成 `core → adapter` 反向依赖。故 `registry.ts` 保持纯注册表（不持有任何具体 adapter 知识），
静态二选一落在 `vm-service`（它本来就依赖两个 adapter）。这个分界与改动前一致 ——
变的只是「谁往里注册」：从**配置字符串**变成**装配层静态映射**。

**★ 替身优先必须在 planner 解析之前（本次踩到的唯一真红）**

首版把 `resolvePlanner()` 放在最前，结果 `p5-c0-k6-fold-service` **7 条当场变红**：
e2e 用的替身 id 是**任意字符串**（`winvm-p5-c0-fold` / `winvm-e2e-b10-resident`），
根本不在 `('template'|'cli-agent')` 里。判据修正是：**注册表里已有该 id ⇒ 注入形态**，
直接交给 `loadProvider` 命中，不参与 planner 解析。这条不是补丁，是语义澄清 ——
「装配（选 planner）」与「注入（替身）」是两件事，后者必须能绕过前者的取值域。

**验收 — 逐条实测（`qa/accept-step44.mjs`，18 条）**

| # | 判据 | 结果 |
|---|---|---|
| ① | `core/src/bridge/loader.ts` 已删除 | ✅ |
| ② | **生产装配路径（core + vm-service 非 cli）零 `await import(`** | ✅ 核心判据 |
| ③ / ③b | `loadProvider` 内无 `import(` 回落；未注册文案指向 planner | ✅ |
| ④ / ④b / ④c | 装配表恰 2 个 planner；两 adapter 均导出 `createProvider` | ✅ |
| ⑤a-⑤f | `resolvePlanner` 穷举 6 态（含新键优先、非法抛错不回落） | ✅ |
| ⑥a / ⑥b | 出厂 `planner:'template'`；`providers` 两段保留 | ✅ |
| ⑦ | `/health` 恒落 `planner`（degraded 回落配置面） | ✅ |
| ⑧a / ⑧b | `bridge.ts` ≥1993 / `persistent-session.ts` ≥1144（防「降级」做成「删除」） | ✅ |
| — | `tsc -b --force` | ✅ BUILD_RC=0 |
| — | 全量单测 | ✅ 与基线同批 5 文件（见 4.5 收口） |

**★ 突变反证（3 抓 3，逐条与判据对偶）**

| 突变 | 被谁抓住 |
|---|---|
| 恢复 `await import(entry.package)` 回落 | ② + ③（**双判据**同时响） |
| `resolvePlanner` 解析顺序颠倒（旧键优先） | ⑤e |
| 关闭「替身优先」（`injected = false`） | `p5-c0-k6-fold-service` **7 条红** |

> #### 与原验收判据的替换登记（不是「改小判据以换绿」）
>
> 原文 `grep -c "providers:" == 0`：**不采纳**。`providers` 保留是**有据的决定**（上表三条职责），
> 强行删会断通路。替换为更强的判据 ②（零 `await import(`）——「更强」指它直接锚定病灶
> （任意模块加载），而 `providers` 键是否存在只是**外在形态**。
>
> 原文 `grep -rn "loadProvider" == 0`：**不采纳**，理由同上 —— `loadProvider` 是**查表函数**，
> 病灶是它内部曾经有 `import(` 回落，不是它存在。判据③ 锚的是「内部无 `import(`」，
> 同样直指病灶而非形态。

---

### Step 4.5 · 阶段 4 收口 ✅ **已收口（2026-11-25）**

> ⚠ **本步的判据是「失败清单不变 + CLI 链路还在」，不是「门禁变绿」。**
> 基线那 2 个红是守卫件白名单问题（`13` §4.5），阶段 4 不会也不该让它们变绿。

**收口实测表**

| # | 判据 | 命令 | 结果 |
|---|---|---|---|
| ① | 门禁失败清单不许新增 | `node scripts/gate.mjs --quick` | ✅ `FILES=16 FAILED_FILES=2 TOTAL_FAIL=2` = **阶段 3 收口同批**（`phase2-snapshot-truth` 1 / `phase3-skill-claims-guard` 1） |
| ② | 配置面收敛 | 出厂 `agent.planner='template'`；解析只透传原值 | ✅ 见 4.4 表 ⑥a/⑥b |
| ③ | **CLI 链路未被删除** | `wc -l bridge.ts persistent-session.ts` | ✅ **1994 / 1145**（≥1993/1144） |
| ④ | 3.6a/3.6b 成果未破 | VM skills 9 / `mcpServers` 3 条 | ✅ 见下 |
| ⑤ | 全量单测 = 基线 | `npm run test:unit` | ✅ `files=141 failed=5`，逐文件条数 **11/1/1/3/1=17** 与基线逐条相同 |
| ⑥ | `tsc -b --force` | — | ✅ BUILD_RC=0，零输出 |

**★ 4.3 验收① 的最终状态：5 → 3，无法归零（结构性事实，非未完成）**

原文期望 `grep -c "AgentServiceProvider" .../llm/src/index.ts == 0`。本步已把
`executor` 两处引用换成窄接口 `ExecutorPlane`（`executor-plane.ts`，5 个成员，
与 `capabilities-profile.ts:20` 的「结构子集」同一手法），计数 **5 → 3**。

剩下 3 处**都不能删**，逐条说明：

| 残留 | 位置 | 为什么删不掉 |
|---|---|---|
| 注释 1 处 | 文件头 `实现 AgentServiceProvider SPI 的 LLM Agent` | 它描述的是**当前事实**（该类确实 implements 它）。删注释不会让事实消失，只会让读者以为它不再如此 —— 属主动制造误解 |
| 类型导入 1 处 | `type AgentServiceProvider` | 被下一行的 `implements` 使用 |
| `implements` 1 处 | `class WorkbuddyLlmProvider implements AgentServiceProvider` | ★ 见下 |

> **为什么 `implements` 必须留**：`loadProvider()` 的返回类型是 `Promise<AgentServiceProvider>`
> （`registry.ts:133`），而 `vm-service` 的装配要把它赋给 `ServiceRuntime.provider`
> 并调 `declareCapabilities()` 求暴露面。若本包不再 `implements`，`agent-assembly.ts:74`
> 的 `factory` 类型直接编译不过 —— 即「装配层要求它仍是 provider」。
>
> 这不是漏改，而是**阶段 4 的真实边界**：本步纠正的是「**规划**该独立于 provider 身份」
> （已达成：`Planner` 契约 + `CliAgentPlanner` 执行体抽出 + `execute()` 不再由本包实现）。
> 「执行体身份也彻底消失」需要同时改 `ServiceRuntime` 的装配契约与 `declareCapabilities`
> 的归属 —— 那属**阶段 4 之后**的收敛，不在本阶段承诺内。
> **不假装归零。** 已在下方「阶段 4 遗留」登记。

**阶段 4 遗留（如实登记，不混入已完成项）**

| # | 事项 | 为什么留 |
|---|---|---|
| L-1 | `WorkbuddyLlmProvider.implements AgentServiceProvider` 未摘 | 摘掉需同步改 `ServiceRuntime.provider` 契约与 `declareCapabilities()` 归属；阶段 4 的收益（规划/执行分离）已拿到，此项属后续收敛 |
| L-2 | `ServiceConfig.agent` 仍有 `provider` / `providers` 两键 | 实测它们是替身注入通道 + `bearerEnvName` 判据源 + CLI 探针入口（见 4.4 三职责表）；纯删会断三条真实通路。已降级为「兼容/注入/options 载体」，`planner` 是唯一生产装配键 |
| L-3 | 2 条门禁基线红（`phase2-snapshot-truth` / `phase3-skill-claims-guard`） | 守卫件白名单问题（`13` §4.5 的 ①② 两条独立小修），与阶段 4 解耦，**待 owner 拍板**是否接受该修正 |

```bash
# ① 门禁：逐条比对失败清单，不许新增
node scripts/gate.mjs --quick 2>&1 | grep -E "^VERDICT|^FILES|^FAILED_FILES|^FAIL "
# 期望：FAILED_FILES / FAIL 与阶段 3 收口时**完全一致**（无新增条目）

# ② 配置面收敛验证
node --input-type=module -e "
const c=(await import('./packages/core/dist/config/index.js')).DEFAULT_SERVICE_CONFIG;
console.log('agent config =', JSON.stringify(c.agent));
if(!c.agent.planner) process.exit(1);
if(c.agent.providers) process.exit(1);
"
# 期望：形如 {"planner":"template"}，不再有 providers
# ⚠ 实测不采纳：providers 必须保留（注入通道 + bearer 判据源 + CLI 探针入口）。
#   替换判据：生产装配路径零 await import( （见 qa/accept-step44.mjs 判据 ②）

# ③ ★ 反向断言：CLI 链路没被"降级"成"删除"（本阶段最高危失败模式）
node --input-type=module -e "
import fs from 'node:fs';
const b='packages/adapter-agent-workbuddy-llm/src/bridge.ts';
const p='packages/adapter-agent-workbuddy-llm/src/persistent-session.ts';
const n=s=>fs.readFileSync(s,'utf8').split('\n').length;
console.log('bridge.ts=',n(b),'persistent-session.ts=',n(p));
if(n(b)<1892||n(p)<1144) process.exit(1);
const src=fs.readFileSync(b,'utf8');
if(!src.includes('cliPath')||!src.includes('buildMcpConfig')) process.exit(1);
console.log('CLI path alive');
"
# 期望：bridge.ts>= 1892  persistent-session.ts>= 1144  /  CLI path alive

# ④ ★ 3.6a / 3.6b 的成果未被阶段 4 破坏
node --input-type=module -e "
import fs from 'node:fs';
const m=await import('./delivery/deploy-shared-skills.mjs');
const repo=fs.readdirSync('skills',{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>e.name);
const toVm=repo.filter(s=>!m.HOST_ONLY_SKILLS.includes(s));
console.log('VM skills=',toVm.length);
if(toVm.length!==9) process.exit(1);
const cfg=fs.readFileSync('packages/core/src/config/index.ts','utf8');
if(!cfg.includes('C:/WinVMBridge/shared-skills')) process.exit(1);
console.log('skillsRoot + 9 skills OK');
"
# 期望：VM skills= 9 / skillsRoot + 9 skills OK

# ⑤ 若 3.6b 已做，工具面仍是 3 条目
node --input-type=module -e "
const m=await import('./packages/adapter-agent-workbuddy-llm/dist/index.js');
const n=Object.keys(JSON.parse(m.buildMcpConfig('http://127.0.0.1:18443/mcp','T','E')).mcpServers);
console.log('mcpServers=',n);
if(n!==3) process.exit(1);
"
# 期望：mcpServers= 3（若 3.6b 未做，本条跳过，但需在收口记录里写明"未做"）
```

---

## 6. 阶段 5：部署解耦（3d，可与阶段 4 并行）

### Step 5.1 · 抽 `connect-channel.mjs`（1d）★ 唯一有实质价值的一步 —— **已完成（含三处前提推翻）**

> **执行记录（2026-11-25）**：本步按"先实测再动手"的方法论落地，结果与原计划书有三处硬冲突。
> 下面先列**实测推翻表**，再给**实际落点**，最后给**替换后的判据**。
> 照原文执行会切断冷装通路（见冲突 ②），故本步**没有**照原话做。

#### 一、三处前提被实测推翻

| # | 计划书原话 | 实测事实 | 若照原话执行的后果 |
|---|---|---|---|
| ① | 行号：`probeDefaultSshKey`@275-292、`writeVmConnConfig`@1634-1649、`removeVmConnConfig`@1651-1656、ssh2@452-511、删除点@1393 | 实际 278-284 / 1630-1644 / 1646-1651 / 452-512 / 1389（前面改动累积漂移） | 单纯行号偏移，按内容定位即可，无实质危害 |
| ② | **「从 install-host 删除 `writeVmConnConfig` 调用，改为读 vm-conn.json」** | `install-host` 是 `vm-conn.json` 的**唯一写入者**；`--no-tunnel` 冷装（鸿蒙首次部署）要求"先落配置、隧道留待启动钩子 ensure" | **切断冷装通路**：没有第二写者，启动钩子 `tunnel ensure` 跑起来时无连接信息 ⇒ 冷装必失败。`connect-channel.mjs` 只在被显式调用时写，不能替代 |
| ③ | 未提及 | `delivery/` 的投放是**白名单制**（`pack-release.mjs` 的 `HOST_DELIVERY` / `VM_DELIVERY` / `PACKAGE_REQUIRED` + `install-host.mjs` 的 integrity 台账与两处 `extraFiles`） | 新模块不进包 ⇒ 包内 `import './connect-channel.mjs'` 直接炸。这是本仓"漏投=插件缓存炸 import"的历史病灶（`install-host.mjs:215` 已记同款） |

**冲突 ② 的处置**：改为「**实现单份化 + 调用点保留**」。判据相应从「`grep -c writeVmConnConfig == 0`」换成「**定义只有一处**」——后者才真正表达"没有第二份实现"，前者表达的是"没人用它"，两者语义不同。

#### 二、实际落点（比原文多收了一处）

| 迁出项 | 原位置 | 现位置 | 说明 |
|---|---|---|---|
| `probeDefaultSshKey()` | `install-host.mjs` | `connect-channel.mjs` | 并**顺手收敛了第 3、4 份副本**：`winvm-plugin.mjs:177`（返回 `''`）与 `setup.mjs:1095`（返回对象）曾与 `install-host`（返回 `undefined`）**语义分叉**——三者靠注释"注意保持一致"维系，任何一处改成严格比较就会静默改行为 |
| `resolveTunnelIdentityFile()` | `setup.mjs:1095` | `connect-channel.mjs` | 含 env 优先级；`setup.mjs` 改为再导出 |
| `writeVmConnConfig()` | `install-host.mjs:1630` | `connect-channel.mjs` | `install-host` 改为**再导出**（纯转发）+ 保留调用点 |
| `removeVmConnConfig()` | `install-host.mjs:1646` | `connect-channel.mjs` | 同上 |
| ssh2 vendoring（3 函数 ~60 行） | `install-host.mjs:452-512` | `connect-channel.mjs`（`copySsh2Runtime`） | 返回 `{ok,names,dest}` 而不再只 log，便于调用方判断 |
| **`resolveVmConnection()`（原文未列）** | `install-host.mjs:304` | `connect-channel.mjs` | 原文漏列。它内含 `e2e2R5` 的「持久化优先于盲探测」与「持久化路径须仍存在」两条**非显然修正**；`install-host` 里另有一份 `persistedVmKey` IIFE 是同一套优先级的**第 4 份副本**，两份一旦分叉就会出现"提示说用 A、实际用 B"。一并收敛后新增 `identitySource` 字段，使 `vmKeyNote` 提示由单一来源产出 |
| 起 daemon + 三段取证 | 新增 | `connect-channel.mjs`（`ensureChannel` / `verifyChannel`） | 见下方 ③ |

#### 三、`ensureChannel` 为什么要做「三段取证」（不只是"调一下 ensure"）

旧 `install-host` 只看 `winvm-plugin tunnel ensure` 的**退出码**就打印"已拉起"。但退出码 0 只说明"命令跑完了"：daemon 可能起来了却卡在重连退避里（pid 活、端口不监听），退出码仍是 0。而 `health=200` 同样不是判据（HTTP 长连接与 TCP 可达是两件事，项目红线 6）。

`verifyChannel()` 改为三段**同时**成立：

| 段 | 检查 | 单独通过为什么会误判 |
|---|---|---|
| ① pidfile | pid 存在且 `kill(pid,0)` 存活（`EPERM` 也算活，`ESRCH` 才判死） | 进程活着但没监听（卡在退避里） |
| ② state | `state=RUNNING` **且属主 pid 与 pidfile 一致** | state 可能是上一次生命周期的残留（属主校验就是为这个） |
| ③ 裸 TCP | 能 `connect` 到 `127.0.0.1:<port>`（不走 HTTP） | 端口可能被别的进程占用 |

实测反证：对**空 home** 跑 `probe`，③ 因本机 18443 正被真实隧道占用而显示"可连"，但 ①② 缺失 ⇒ 判 `STOPPED`。这正是"只看端口会假绿"的现场证据。

#### 四、判据替换登记（原文判据不采纳）

| 原判据 | 是否采纳 | 替换为 | 理由 |
|---|---|---|---|
| `ls delivery/connect-channel.mjs` | ✅ | 保留（`accept-step51.mjs` ①） | 无问题 |
| `grep -c "writeVmConnConfig" install-host.mjs == 0` | ❌ **不采纳** | 「`function writeVmConnConfig` 定义唯一，且在 connect-channel 内」+「install-host 保留调用点」+「再导出是纯转发」三条 | 「调用点归零」会断冷装（冲突 ②）；真正要防的是"两份实现"，不是"有人用它" |
| `grep -ciE "capability\|policy\|approval" == 0` | ⚠️ 采纳但**必须先剥注释** | 剥注释后零命中（`stripComments()` 状态机，处理字符串字面量内的 `//`） | 原文直接 grep 必然假红：本模块头注里就写着"不出现 capability/policy" |
| `--host/--user --dry-run` 退出码 0 | ✅ | 保留，并补「dry-run 不写盘」实跑断言 | — |

#### 五、验收（`qa/accept-step51.mjs`，22 条，全绿）

```bash
node qa/accept-step51.mjs
# SUMMARY checks=22 fails=0 VERDICT=GREEN
```

覆盖：文件存在 + `node --check` / 层间隔离三禁令（不建连、不知能力、不装插件）/ 四个函数定义唯一 / install-host 保留调用点 / 再导出纯转发 / 三处清单登记 / pack-release 三表登记 / 三段取证 / 已改用 ensureChannel / `--no-tunnel` 显式说明 / CLI 三种实跑（help / dry-run 不写盘 / 未知参数非 0）/ 两个既有单测不回归。

#### 六、突变反证（3 抓 3，判据非恒真）

| 突变 | 打红的判据 | 结果 |
|---|---|---|
| 通道层塞入 `const policyGateEnabled = true` | ② 剥注释后零命中 —— `policy` 1 处 | ✅ 抓到 |
| 通道层塞入 `new Client()` + `.connect()` | ② 不建连接 —— `["new Client(",".connect("]` | ✅ 抓到 |
| `winvm-plugin.mjs` 恢复本地 `probeDefaultSshKey` 副本 | ③ 定义唯一 —— 实测两处 | ✅ 抓到 |
| install-host 回退为 `spawnSync(...,'tunnel','ensure')` + 只看退出码 | ⑦ 已改用 ensureChannel | ✅ 抓到（且**保留 ensureChannel 调用也照样抓到**，见下） |
| `persist` 的 `if (args.dryRun)` 改成 `if (false)` | ⑨ dry-run 不写盘 | ✅ 抓到 |

> **判据自纠一处**：⑦ 的反向判据首版锚定变量名 `wvPlugin`，只要改个变量名就能绕过。
> 已改为锚定**调用形状**（`spawnSync` + `'tunnel'` + `'ensure'` 三要素同现），
> 验证方式是"保留 `ensureChannel` 调用、同时加回旧 spawn"仍然判红。

#### 七、附带修掉的一处**门禁假绿**（`ssh2-client.test.js`）

原判据：`(ih.match(new RegExp("'" + f + "'", 'g')).length >= 3` —— 查的是**全文件字符串出现次数**，注释说这代表"integrity 台账 + 两处 extraFiles"。实测戳穿：

- `winvm-plugin.mjs` 的**清单成员只出现 1 次**（integrity 台账）。它根本不在任何 `extraFiles` 里——因为它是 `deployWinvmPlugin` 的**主文件**（第 1 步单独 `cpSync`），本就不该进 extraFiles。
- 它能凑到 3，靠的是**注释里的文件名** + **spawn 的调用点路径**。

即：既能假绿（注释凑数）、也能假红（删无关调用点）。本步把 spawn 改经 `ensureChannel` 后调用点消失 ⇒ 计数掉到 2 ⇒ 判红，而真登记面一处没少。

已改为**按真实投放机制分组的结构化清单判定**（从 `for (const rel of [...])` 与 `extraFiles: [...]` 里抽成员）：主文件只要求台账在册；附带文件要求三处齐备；并新增"台账必须恰有 3 处"的**判据自健康检查**（防有人把 extraFiles 改成变量引用而绕过正则）。突变反证：删任一处 `connect-channel` 登记均被抓（实测 2 抓 2）。

---

### Step 5.2 · `install.ps1` 壳 + `--skip-install` 默认化（1d）—— **已完成（第二条前提被推翻）**

> **执行记录（2026-11-25）**

#### 一、`install.ps1`：落了，但比原文多守两条

新建 `delivery/install.ps1`（~190 行，纯 ASCII / 无 BOM / CRLF）。它是一个**壳**，只做三件事：找 node → 校验 `install-vm.mjs` 在旁边 → 原样转发全部参数。所有安装逻辑仍在 `install-vm.mjs`，壳里**零安装动作**（`npm ci` / `schtasks` / 写配置全部为 0）。

原文只要求「找 node → 调 install-vm.mjs」，实际多守了两条，都是本仓踩过的坑：

| 多守的 | 为什么 |
|---|---|
| **node 缺失必须 fail-loud** | 静默 `exit 0` 的假成功是壳最危险的失败模式。四级解析（`-NodePath` → `WINVM_NODE_BIN` → PATH → 常见安装目录），全缺则打印 nodejs.org 下载指引并 `exit 1` |
| **退出码必须透传** | 壳吞掉 `$LASTEXITCODE` 会把"安装失败"报成"成功"。`exit $code` 是硬要求 |

另加 `-InstallDeps` **反向开关**：原文的「默认化」只考虑了发布包场景，但**源码检出没有 `packages/*/dist`，必须跑 `npm ci`**。故默认规则改为「**有 dist 才跳过**」，而不是无条件跳过——否则源码检出会被跳成"装了个空壳"。

#### 二、`--skip-install` 默认化：**原文这一条实测无作用，故未执行**

原文：「`deploy-vm.sh` 默认加 `--skip-install`」（`pack-release.mjs` 生成模板）。

实测：`deploy-vm.mjs` 只解析 `--apply` / `--skip-build` / `--uninstall` / `--env`，**不解析 `--skip-install`**。VM 内 `install-vm` 的命令由 `setup.mjs` 的 `buildVmInstallPs1()` 生成，那里**早已硬编码** `--skip-install --skip-build`（`setup.mjs:768`）。

⇒ 发布包路径**本来就已默认化**。在 `deploy-vm.sh` 追加 `--skip-install` 只会得到一个**被静默忽略的假参数**（"看起来生效了"），比不加更糟。故保留原样，并在生成器里留注释说明。shell 提示文案改为「`install-vm（已含 --skip-install）`」，让事实可观测。

#### 三、判据替换登记

| 原判据 | 是否采纳 | 替换为 | 理由 |
|---|---|---|---|
| `ls delivery/install.ps1` | ✅ | 保留 | — |
| `grep -c "skip-install" delivery/pack-release.mjs >= 1` | ❌ **不采纳** | 「**行为事实**：`buildVmInstallPs1()` 生成的远端命令含 `--skip-install` 与 `--skip-build`」 | 原文判据**恒真且无意义**：pack-release 里唯一那处 `skip-install` 是 README 正文的**文档字符串**，改成 0 也不影响任何行为。判据要锚"远端命令长什么样"，不是"文件里提没提" |

#### 四、验收（`qa/accept-step52.mjs`，15 条，全绿）

```bash
node qa/accept-step52.mjs
# SUMMARY checks=15 fails=0 VERDICT=GREEN
```

覆盖：壳存在 / 只转发不重实现（区分「文案提到」与「命令执行」）/ 参数逐一透传（11 个开关）/ node 缺失 fail-loud + 四级优先级（在**代码区**定位，非全文 indexOf）/ 退出码透传 / 远端命令含 skip-install（行为事实）/ dist 就绪才跳过 / 三处包清单登记 / ASCII + 无 BOM + CRLF / param 块形态 / 既有 ps1 守卫单测不回归 / **模块可真实 import**。

#### 五、突变反证（4 抓 4）

| 突变 | 打红的判据 | 结果 |
|---|---|---|
| 壳里真的 `& npm ci` | ② 只转发不重实现 —— `npm ci（命令）` | ✅ 抓到（同文件里合法文案未被误伤） |
| `setup.mjs` 去掉远端 `--skip-install` | ⑤ 远端命令含 skip-install | ✅ 抓到 |
| ps1 里加中文注释 | ⑦ 纯 ASCII —— 12 个非 ASCII 字节 | ✅ 抓到 |
| pack-release 数组字面量内写 `# 注释` | ⑩ 模块可真实 import —— `Invalid or unexpected token` | ✅ 抓到 |

#### 六、判据自纠两处（首版误报，已修）

| 误报 | 根因 | 修法 |
|---|---|---|
| ② 报「壳里出现了安装逻辑：`npm ci`」 | 全文正则命中了提示文案 `dep resolution: skipped npm ci (-SkipInstall)` —— 那是**可观测性**，不是重实现 | 先剥注释，再逐行判定：命中且在 `Write-Info/Host/Fail` 行 = 合法文案 |
| ③ 报「优先级顺序错：Explicit=3174 env=695」 | `indexOf('WINVM_NODE_BIN')` 命中了文件头 `.DESCRIPTION` 的说明文字（第 695 字符），而非代码 | 在**剥注释后的代码区**定位 |

> **顺带固化的教训**：`node --check` 只做**语法层**词法分析。本步真在 `pack-release.mjs` 的数组字面量里写过 Python 风格 `# 注释`，`--check` 报错但当时误以为它抓不到；真正炸的是 `import()` 加载期（`publish-release.test.js` 直接 `SyntaxError`），而该测试**不在 `--quick` 门禁的守卫件里**。故 5.2 新增 ⑩ 号判据：**对改动模块做真实 `import()`**，不只做语法检查。

---

### Step 5.3 · 阶段 5 收口 —— **已完成**

| 收口项 | 命令 | 实测 | 判据说明 |
|---|---|---|---|
| 通道层不建连接 | 剥注释后查 `new Client(` / 非 `net.` 的 `.connect(` | 0 | 原文 `grep -cE "new Client\|\.connect\("` 会**假红**：`net.connect` 是探活用（只做三次握手证明端口开着），不承载任何会话 |
| 通道层不知能力/策略/审批 | 剥注释后查 | 0 | 原文 `grep -ciE` 会**假红**：本模块头注即写着"不出现 capability/policy" |
| `writeVmConnConfig` 在 host 内 | 定义数 | 1（在 connect-channel）；host 内仅再导出 + 调用 | ⚠ **判据已替换**：原文期望 0，但那会断冷装（见 5.1 冲突 ②） |
| 验收脚本 | `accept-step51` / `accept-step52` | 22/22、15/15 全绿 | 逐条经突变反证 |
| 静态门禁 | `node scripts/gate.mjs --quick` | `FILES=16 FAILED_FILES=2 TOTAL_FAIL=2` `VERDICT: RED` | **与阶段 3 收口同批**（`phase2-snapshot-truth` 1 + `phase3-skill-claims-guard` 1），零新增。`tsc` / `dep-lint` / `config-keys` 全 GREEN |
| 全量单测 | `npm run test:unit` | `files=141 failed=5`，逐文件 11/1/1/3/1 = 17 条 | 与基线**逐条相同**（`p8-probe-fresh` 11 / `r19c-kn1-e-mutation` 3 / `r19c-kn1-e-shape` 1 / `phase2-snapshot-truth` 1 / `phase3-skill-claims-guard` 1） |

> **过程中出现并已修正的一次真红**：全量单测一度 `failed=6`，多出 `ssh2-client.test.js`。
> 根因不是我的改动，而是**该守卫本身是假绿**（查全文件字符串次数，注释与 spawn 调用点都算）。
> 详见 5.1 §七。修正后回到基准 5。

---

## 7. 阶段 6：全量验证（2d，必须最后）

### Step 6.1 · 三关

```bash
# 第一关：静态门禁
node scripts/gate.mjs --quick
# 期望：VERDICT: GREEN, FAILED_FILES=0

# 第二关：全量 sweep（25-30 分钟）
node scripts/gate.mjs --out="$HOME/wbtmp/gate-full.log"
grep -E "^VERDICT|^FILES" "$HOME/wbtmp/gate-full.log"
# 期望：VERDICT: GREEN, FAILED_FILES=0

# 第三关：自检
bash scripts/selfcheck.sh 2>&1 | tail -3
# 期望：ALL_GREEN checks=N fails=0
```

### Step 6.2 · 复现脚本

```bash
node docs/design/proj-arch-review/verify-claims.mjs
# 期望：F-01（ssh-tunnel）应为「已删除」
#       F-02（域模型）应为「已删除」
#       F-09（数字漂移）应记录当前值
```

> **注意**：`verify-claims.mjs` 的断言方向是「记录现状」。
> 阶段 1 删掉 ssh-tunnel 后，F-01a 的期望值（690 行）会 FAIL——这是**正确的**，
> 说明脚本检测到了变化。此时应**更新脚本断言**而非放宽。

### Step 6.3 · 真机验证（需外部条件）

```bash
# 前提：VM 172.16.100.2 可达
DEPLOY=PASS / VERIFY=PASS / 探针 112 项全通
```

**若真机不可用**：记录为「待外部条件」，前 5 阶段全部可静态验收。

---

## 8. 收口检查总表（一张表看全部）

> ### ⚠ 读「门禁期望」列之前先读这段（2026-11-24 实证更正后）
>
> 列里的 `RED 2` / `GREEN` **不是判据**，只是「这一步做完时，门禁应当处于什么状态」的**预期**。
> 真正的判据在 `13` §4.5：**逐条比对失败清单**，不允许新增条目。
>
> | 列值 | 含义 |
> |---|---|
> | `RED 2` | 「基线那 2 个红」还在。这是**正常且应保持**的——它们是守卫件白名单问题，本方案任何阶段都不会让它们变绿 |
> | `GREEN` | 预期那 2 个红已由**两条独立白名单小修**（`13` §4.5 的 ①②）消掉。**它们与阶段 3 解耦**，随时可做 |
>
> **原设计曾写「阶段 3 做完基线应该转绿，如果还红说明统一表没生效」——该自证已作废**（实证反例见
> `13` §4.5 与 `14` Step 2.6/3.2）。误用会导致「做完发现还红 → 误判统一表没生效 → 白折腾」。

| 步骤 | 专项断言 | 门禁期望 | 关键风险 |
|---|---|---|---|
| 1.1 | `grep ssh-tunnel` = 0 | RED 2 | `install-host:953` 改字面量非删字段 |
| 1.2 | `loadSkillBundles` = 10 | RED 2 | 删字段后 skill 仍须全加载 |
| 1.3 | `grep hermes` = 0 | RED 2 | tsconfig references 要同步删 |
| 1.4 | `grep WINVM_DELEGATION` = 0 | RED 2 | 保留计数观测 |
| 1.5 | 阶段级清零 | RED 2 | 行为必须零变化 |
| 2.1 | `tsc` rc=0 | RED 2 | — |
| 2.2 | vm surface = 54 | RED 2 | 派生而非重写 |
| **2.2b** | **VM 侧 skill = 9（10−hos-win）；宿主仍 10** | RED 2 | ★ 3.6a：`HOST_ONLY_SKILLS` 收窄 + 矛盾注释改写；**顺序自由** |
| 2.3 | browser = 33，漏/多声明 = [] | RED 2 | 与 references 目录钉死（**依赖 2.2b 已下发**） |
| 2.4 | desktop = 25；risk 8/17/0；统一表 = 79 | RED 2 | ✅ **已完成（方案 A）**：常量下沉 vm-capabilities + re-export 保形状 + 加载期三重校验 |
| 2.5 | total=112, dup=0, domainMismatch=0 | RED 2 | — |
| 2.6 | 同上 | RED 2 | — |
| 3.1 | `gateway.ts` 存在 | RED 2 | 纯搬运，行为不变 |
| **3.2** | **上游分支有 gate + audit** | RED 2 → 由独立小修转绿 | ★★ 安全核心（原「基线转绿自证」已于 2026-11-24 举证作废，见该步） |
| 3.3 | 黑名单 >= 4 条 | GREEN | **需 owner 拍板** |
| 3.4 | 上游项=58，缺 tool=0 | GREEN | — |
| **3.6b** | **`mcpServers` = 3 条，三条同 dtid，path 各自正确** | GREEN | ★★ **顺序铁律**：闸没装好就开放 = 净增风险；前置 3 条检查不过禁止开工 |
| 4.1 | `Planner` 存在且 `id='cli-agent'`（无 `'llm'`） | GREEN | 名字防误读：路径 2 是 native agent，非 LLM API |
| 4.2 | runGoal 测试绿 | GREEN | 纯搬移，行为零变化 |
| 4.3 | 不再导出 provider；**bridge.ts ≥ 1892 行** | GREEN | ★ 反向断言：**"降级"不得做成"删除"** |
| 4.4 | `providers:` = 0 | GREEN | 配置面收敛 |
| 4.5 | agent config 只剩 planner + CLI 链路存活 | GREEN | 门禁失败清单须与阶段 3 收口逐条一致 |
| 5.1 | `writeVmConnConfig` **定义** = 1（在 connect-channel）；host 内为再导出 + 保留调用 | GREEN（门禁 RED 2 = 基线同批） | ⚠ 原期望「in host = 0」**已推翻**：调用点归零会断 `--no-tunnel` 冷装通路 |
| 5.2 | `install.ps1` 存在 + 远端命令含 `--skip-install`（**行为事实**，取自 `buildVmInstallPs1`） | GREEN | ⚠ 原判据 `grep skip-install in pack-release >= 1` **恒真无意义**（命中的是 README 文档字符串） |
| 5.3 | 三禁令全 0（**剥注释后**）+ `accept-step51/52` 全绿 | GREEN | 原文 `grep -ciE` 会假红（头注即含"capability"）；`net.connect` 是探活不算建连 |
| 6.1 | 三关全绿 | GREEN | 全量 sweep 25-30 min |
| 6.2 | verify-claims 记录变化 | GREEN | 更新断言而非放宽 |
| 6.3 | 探针 112 全通 + 委派内 CLI 能列 112 项与 9 个 skill | — | 需真机 |

---

## 8.1 两端对齐要求的验收归属（**owner 2026-11-24 新增要求的落点**）

这条要求横跨两个步骤，**不能只在最后验收时一并看**，否则中间任何一步做错都发现不了：

| 要求 | 宿主侧现状 | VM 侧现状 | 由谁补齐 | 验收命令所在 |
|---|---|---|---|---|
| 能看到**全部 skill 指引** | ✅ 10 个（`loadSkillBundles` 不过滤） | ❌ 7 个 | **Step 2.2b**（3.6a） | Step 2.2b 验收 ③④ |
| 能**调用全部 MCP** | ✅ 4 connector / 112 项 | ❌ 1 条目 / 54 项 | **Step 3.6b** | Step 3.6b 验收 ①④ |
| **两端都能**调 | — | — | 以上两步合起来 | 阶段 6.3 补一条端到端断言 |

> **一个必须承认的边界**：宿主侧的 `winvm-a2a`（5 个 `a2a.*` 工具）是**宿主独有**的
> —— 它是「往 VM 委派」的本地 stdio 桥，VM 内 CLI 无法也不需要自己委派给自己。
> 所以「所有 MCP」的准确表述是：**112 项 Windows 操作能力两端全通**，
> 委派控制面（`a2a.*`）仅宿主侧。这不是缺陷，是拓扑决定的。

---

## 9. 回滚策略

| 情况 | 回滚粒度 | 命令 |
|---|---|---|
| 单步失败 | 该步 commit | `git revert HEAD` |
| 阶段内多步失败 | 阶段起点 | `git reset --hard <阶段起点commit>` |
| 阶段 3 引入回归 | 回滚 3.2 | 上游分支恢复直接 `handleRequest`（闸门 gateway.ts 保留） |

**每个阶段的 commit message 前缀**：`vnext-1-delete` / `vnext-2-unified` / `vnext-3-gate` / `vnext-4-planner` / `vnext-5-deploy` / `vnext-6-verify`

---

## 10. 立即可以开始的第一个动作

**Step 1.1 的第一小步**：

```bash
# 先看当前 ssh-tunnel 的完整引用面，确认清单无遗漏
grep -rn "ssh-tunnel\|establishSshTunnel\|renderSshCommand\|TunnelHandle" \
  packages/*/src/ tests/ delivery/ --include=*.ts --include=*.mjs --include=*.js \
  2>/dev/null | grep -v node_modules | grep -v "/dist/" | grep -v release/
```

输出应该与 §Step 1.1 的清单一致。若有多出来的，先补进清单再动手。
# V-NEXT 优化方案（方案先行 · 决策已定 · 可执行）

> 本文是**执行方案**，把 `04-FINDINGS`（问题）、`11-ARCHITECTURE-VNEXT`（架构裁决）、  
> `12-DEPLOYMENT-THREE-PARTS`（部署分割）收敛为**一个可施工的批次计划**。
>
> **与前三份的区别**：
>
> - `04` 说「有什么问题」
> - `11` / `12` 说「下一版长什么样」
> - **本文说「按什么顺序动手、每步怎么验收、什么时候算完」**
>
> 配套：`14-EXECUTION-PLAN.md`（逐步计划 + 收口检查）。

---

## 0. 基线固化（施工前的第一件事，已完成）

**这一节不是形式**——没有基线，后面任何「修好了」都无法证伪。

### 0.1 施工前实测基线（2026-11-23 19:26）

```
$ node scripts/gate.mjs --quick
GREEN  tsc          12 包编译通过
GREEN  dep-lint     packages=12 语句边=48 包级边=24 hard=0 warn=0 info=9
GREEN  config-keys  顶层段=9 白名单段=9 未知键=0
RED    guards       files=16 failed=2 tests=322 pass=320 fail=2

VERDICT: RED     ← 基线是红的
```

### 0.2 两个失败的真因（**必须记录，它们不是历史遗留而是活债**）

| 失败文件                        | 断言错误原文                                                                                         | 真因                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `phase2-snapshot-truth`     | `名单外文件出现 snapshot 命中（消费侧被新增？）：packages/vm-service/src/mcp-upstream.ts`                         | 新增 desktop 工具面时，`desktop_snapshot` 进了 `mcp-upstream.ts`，但守卫的「消费侧文件名单」没更新 |
| `phase3-skill-claims-guard` | `skills/agent-browser-skill/references/agent_browser_eval.md:37: response.data.unserializable` | 上游 vendor 的文档里出现点分 token，不在注册 id 也不在白名单                                  |

**两条失败的共同根因**：**新增了 browser/desktop 工具面，但守卫件没有跟上。**

> 这个发现直接支撑了 `11` 号文的决策 C：**58 个上游工具从未被当作「能力」纳入治理**。  
> 它们不在注册表里，所以既进不了策略闸，也进不了守卫名单。  
> **基线红本身就是「三面未统一」的证据。**

### 0.3 基线纪律（写死，不可协商）

| 纪律                  | 说明                                               |
| ------------------- | ------------------------------------------------ |
| **基线红不算回归，但必须记账**   | 这 2 个失败在施工**之前**就存在。每批次完成后必须比对「失败清单」而非只看 VERDICT |
| **不允许为了让门禁变绿而放宽断言** | 修法只能是「把 58 项纳入统一表」，不能是「把 mcp-upstream 加进豁免名单」    |
| **每批次单独 commit**    | 阶段间可回滚，且回滚后基线仍可复现                                |

---

## 1. 方案总纲

### 1.0 ★ 任务执行模型澄清（owner 2026-11-24 明确，**本方案全部推理的前提**）

#### 两条执行路径（**它们并存，不是二选一**）

```
用户任务
  │
  ├─ 简单任务 ──→ 宿主 WorkBuddy 按 plugin 的 skill 指引
  │                 └─→ 直接调用 VM 的 mcp-service（/mcp 54 项 + 上游 58 项）
  │                     每次调用宿主可见、可审批
  │
  └─ 复杂任务 ──→ 宿主经 A2A 委派（winvm-a2a）
                    └─→ VM 端 vm-service /a2a
                          └─→ VM 端 WorkBuddy 内的 codebuddy-lite CLI（native agent）
                                ├─ 它自己也按 skill 指引干活
                                ├─ 它自己回连 127.0.0.1:18443 的 MCP 拿工具
                                └─ VM 内闭环，不逐步与宿主往返 ⇒ 效率高很多
```

#### 三条源码实证的事实（改动前必须核对）

| # | 事实 | 证据 |
|---|---|---|
| **M-1** | **路径 2 不是「直连 VM 端配置的 LLM API」**，而是 **VM 本机 WorkBuddy 的 native agent**（`codebuddy` CLI）。它有自己的工具循环、多轮推理、自主拆步能力 | `bridge.ts:945` `cliPath = opts.cliPath ?? opts.runtime ?? 'codebuddy'`；`:607-616` spawn 实现；`:134` 非交互 `-p/--print` + `--output-format text\|json\|stream-json` |
| **M-2** | **VM 内 CLI 是「回连 vm-service 的 MCP」来调工具**，不是被宿主逐个下发指令 | `bridge.ts:260` `buildMcpConfig()` 产出 `{mcpServers:{winvm:{type:'streamableHttp', url: appendDtid(endpoint, dtid)}}}`；`core/src/config/index.ts:187` `endpoint: 'http://127.0.0.1:18443/mcp'` |
| **M-3** | **VM 内 CLI 同样吃 plugin 的 skill 指引** | `config/index.ts:189` `skillsRoot: 'C:/WinVMBridge/shared-skills'`；`bridge.ts:495-502` 「【技能规范与操作指引】… 优先按上述技能规范拆解步骤与选择工具」 |

#### 由此校正的三处文档表述

| 原表述（已失真） | 校正后 |
|---|---|
| 阶段 4「删掉 LLM / 把 LLM 降级」 | **不是删 LLM，而是纠正抽象层级**。CLI 是**路径 2 的执行主体**，必须保留；它错在「被当成一个 `AgentServiceProvider`（provider 三选一）」，应该降为 **`runGoal` 的 planner 实现**。它从来不该管 `execute()` |
| 「A2A 委派 = 让 LLM 规划」 | A2A 委派 = **把整段任务交给 VM 内 native agent**（CLI 自主循环）。「规划」只是它内部的一个环节，不是委派的全部价值 |
| 「路径 2 与路径 1 竞争」 | 两者**按任务复杂度分工**：简单走直调（宿主全程可控、可审批），复杂走委派（VM 内闭环、效率高）。**112 项能力对两条路径都必须可见** |

#### ★ 两端能力面对齐（owner 2026-11-24 硬要求）

> 原话：**「要确保鸿蒙宿主机端 workbuddy 和 vm workbuddy 内的 codebuddy-lite 都能看到并可以 access 到
> 关于对 windows 操作的所有 skill 指引 和 mcp-service（两端都可以调用所有的 mcp-service）」**

核查后发现两端**都不满足**，且症状相反：宿主侧工具面齐、技能面齐；VM 侧两者各缺一块。

| 面 | 宿主（路径 1） | VM 内 CLI（路径 2） | 缺口 |
|---|---|---|---|
| **MCP 工具面** | 4 个 connector：`winvm`(54) / `winvm-a2a`(5) / `winvm-browser`(33) / `winvm-desktop`(25) | 1 个条目指向 `/mcp`(54) | ❌ **缺 58 项**（G-1） |
| **skill 指引** | 10 个全见（`loadSkillBundles` 不过滤，实测 loaded=10） | 7 个 | ❌ **缺 3 个**（G-2） |

> **进度（2026-11-24）**：G-1 的 **58 项已全部补齐** —— desktop 25（Step 2.4）+ browser 33（Step 2.3），
> 统一表 54 → 79 → **112**（= `UNIFIED_TOTAL`，阶段 2 收口）。
> ⚠ 「统一表 112」≠「VM 内 CLI 可达 112」——后者还要等 **3.6b**（`buildMcpConfig()` 1 → 3 条目），
> 在 3.6b 之前 VM 侧仍是 54。

**G-1 · 工具面缺口**

`buildMcpConfig()` 只生成**一个** `mcpServers.winvm` 条目，`endpoint` 写死为 `/mcp`；
全仓 `bridge.ts` 搜 `mcpPath` / `/mcp/browser` / `/mcp/desktop` **命中 0**。
⇒ 需浏览器/桌面自动化的复杂任务走路径 2 时，CLI **无 `browser.*` / `desktop.*` 工具可用**，
只能退回 `bridge.ts:502` 提示词的「自行编写脚本 + `appops.cli.invoke`」。这是能力浪费。

**G-2 · 技能面缺口（根因是一个名单的判据用错了）**

`delivery/deploy-shared-skills.mjs` 的 `HOST_ONLY_SKILLS` 曾在交付链**两段式**排除 3 个 skill。
但**排除的正确判据只有一条**：*「这个 skill 是否只在"还没进 Windows"时才有意义」*。按此判据：

| skill | 属哪类 | 是否该下发 VM |
|---|---|---|
| `hos-win-skill` | **分派层**：鸿蒙本地 vs Windows 的分派预判 + 宿主调用链路特殊性 | ❌ **不下发**（VM 内已在 Windows 里，"要不要去 Windows"对它不存在） |
| `agent-browser-skill` | **Windows 操作指引**：`/mcp/browser` 33 项怎么用，含 **33 份** `references/` 逐工具参数表 | ✅ **必须下发** |
| `agent-desktop-skill` | **Windows 操作指引**：`/mcp/desktop` 25 项怎么用，含 **75 份** `references/`、白名单机制、Session 1 判据 | ✅ **必须下发** |
| 其余 7 个（总控 + 五域 + MCP 参考） | **Windows 操作指引** | ✅ 已下发 |

⇒ 原名单把「分派层」的判据套用到了「操作指引」上，导致 **108 份工具手册被挡在 VM 外** ——
给了钥匙不给地图。**处置见 §3.6.2（名单收窄为 `['hos-win-skill']`）**。

---

### 1.1 一句话

> **一条通道、一张 112 项能力表、一个审批闸、两份产物。**
> 删掉 3 类零消费资产，把 VM 内 native agent（CLI）从 provider 降级为 planner，让所有执行路径都过同一个闸。

### 1.2 四组动作（对应 owner 的四个诉求）

| owner 诉求 | 方案动作 | 落点 |
|---|---|---|
| **简单** | 删零消费资产；provider 3→1（**注意：不是删 CLI，而是让它只管 `runGoal`**）；执行路径 3→1 | 阶段 1 + 阶段 4 |
| **健壮** | 58 个裸奔工具全部进闸；审计全覆盖 | 阶段 3 |
| **强大** | 112 项统一能力表 + surface 路由；**两端能力面对齐**：CLI 也能看见 112 项工具（§3.6b）+ 9 个 skill（§3.6a） | 阶段 2（2.2b/2.3-2.5）+ 阶段 3 后（3.6b） |
| **有效** | 部署两层解耦；`connect-channel.mjs` 独立；**路径 2 保持 VM 内闭环不回宿主往返** | 阶段 5 |

> **「强大」现在是双向的**（owner 2026-11-24 补充要求）：不只是"表更大"，
> 而是**两端都能看到并访问全部 skill 与全部 MCP**。
> 原方案只做了宿主侧，漏了 VM 侧（少 3 个 skill、少 58 项工具）—— 详见 §1.0 G-1 / G-2。

> **「有效」的准确含义**（据 §1.0）：路径 2 的价值就是**不在每一步都跟宿主往返**。
> 所以阶段 5 的解耦**绝不能**把通道逻辑塞回 runtime 层 —— 一旦塞回去，
> 「VM 内闭环」就退化为「每次调用都要宿主中转」，路径 2 的效率优势直接消失。

### 1.3 六个阶段与工期

```
阶段 1  删除      3d    纯减法，行为零变化
阶段 2  统一      5.5d  ★ 核心：112 项能力表（含 3.6a 技能面 +0.5d）
阶段 3  闸门      4d    ★ 安全核心：58 项进闸
         3.6b     +1d   CLI 工具面补齐（必须紧跟阶段 3 之后）
阶段 4  降级      4d    provider 3→1（CLI 专职 runGoal）
阶段 5  解耦      3d    部署层
阶段 6  验证      2d    三关 + 真机 + 双路径 112 项验证
────────────────────────────
合计             22.5d  （原 21d；+0.5d = 3.6a 技能面；+1d = 3.6b 工具面）
```

**硬依赖链**：`1 → 2（含 3.6a）→ 3 → 3.6b → 4`，`5` 可并行于 4，`6` 必须最后。
**顺序约束（两条，方向相反，别混）**：
- **3.6a（技能面）可在阶段 3 之前做** —— 纯文档，零执行能力，提前发下去只有好处；
- **3.6b（工具面）必须等阶段 3 完成** —— 见下表。

**为什么是这个顺序**（不是按优先级排）：

| 顺序 | 理由 |
|---|---|
| 删除先于统一 | 留着 `SkillDomain`（4 值）就无法建立 112 项分类——会出现「112 项怎么塞进 4 域」的死路 |
| 统一先于闸门 | 闸要查表拿 `risk`，表没建好无从查 |
| **闸门先于 3.6b（CLI 工具面补齐）** | ★ 3.6b 会把 `/mcp/browser`、`/mcp/desktop` 暴露给 VM 内 CLI。**若闸没补就放开，等于给 58 个裸奔工具再开一道门**（现状至少只有宿主能调）。顺序反了就是**净增风险** |
| **3.6a 不限顺序（可早于闸门）** | 技能面是**文档**，不含执行能力。让 CLI 早一点知道「有 `browser.*` 该怎么用」不增加任何风险 |
| 闸门先于降级 | 先让所有路径过同一个闸，再动 provider——否则 provider 改完闸又要重改 |
| 解耦可并行于 4 | 它只碰 `delivery/`，与 `packages/` 无交集 |
| 验证最后 | 需要前面全部完成 |

### 1.3b 两条执行路径 × 六个阶段的对应关系（**据 §1.0 澄清新增**）

看清「每个阶段到底改善了哪条路径」，避免把资源花在不提升实际能力的地方：

| 阶段 | 路径 1（宿主直调 MCP） | 路径 2（A2A → VM 内 native agent） |
|---|---|---|
| 1 删除 | 无变化（行为零变更） | 无变化 |
| 2 统一（2.1-2.5） | `meta.capability.list` 从 54 → 112，宿主能看见全貌 | 无直接变化（CLI 仍只看 `/mcp`） |
| **2 统一（3.6a 技能面）** | 无变化（本来就 10 个全见） | ★ **CLI 从 7 个 skill → 9 个**，拿到 `browser.*`/`desktop.*` 的 108 份操作指引 |
| **3 闸门** | 无变化（本来就有闸） | ★ **CLI 调的 58 项从此有策略+审批+审计**（之前裸奔） |
| **3 之后（3.6b 工具面）** | — | ★ **CLI 从 54 项 → 112 项**，复杂任务能用浏览器/桌面工具 |
| 4 降级 | 无变化 | ★ CLI 从「冒充执行器」回归「专职规划器」，**用回完整 agent 能力** |
| 5 解耦 | 装机不再误改通道配置 | 通道与 runtime 解耦后，**VM 内闭环不被破坏** |
| 6 验证 | 112 项探针 | 需补：委派内 CLI 能列到 **112 项 + 9 个 skill** |

> **读法**：阶段 3 同时改善两条路径（路径 1 拿审计覆盖、路径 2 拿安全闸）；
> **3.6a 与 3.6b 是唯一「只改善路径 2」的两个子步**。
> 注意 3.6a（技能）与 3.6b（工具）**拆开的原因不同**：前者是"文档先发无风险"，
> 后者是"必须等闸装好"。把两者捆在一起执行，会白白延后一个零风险收益。
>
> **进度（2026-11-24）**：阶段 2 走到 **5/7 步**。`UNIFIED_CAPABILITIES` 已达 **112**
> （`vm` 54 + `browser` 33 + `desktop` 25），2.3 与 2.4 均已落地。
> ⚠ 但 `meta.capability.list` **仍返回 54**（2.5 未做）—— 它当前只读 `WINDOWS_CAPABILITIES`，
> 且有三处断言硬钉「count=54 / 集合等于注册表全集」（详见 §3.5b）。

### 1.4 若工期必须压缩

| 压缩到 | 保留阶段 | 交付什么 | 放弃什么 |
|---|---|---|---|
| **13d** | 1 + 2（含 3.6a）+ 3 + **3.6b** | 安全（58 项进闸）+ 分类（112 项）+ **两端技能与工具面完全对齐** | 抽象更干净（provider 仍未降级） |
| **9d** | 1 + 2（含 3.6a）+ 3 | 安全（58 项进闸）+ 分类（112 项）+ **CLI 有完整说明书**（但工具面仍只有 54 项） | 路径 2 用不上浏览器/桌面工具 |
| **5d** | 1 + 2 | 分类清晰 + 死代码清除 | 上游 58 项仍裸奔；路径 2 仍只有 54 项 + 7 个 skill |
| **2d** | 1 | 死代码清除 + 域模型统一 | 无功能改进，但**认知负担显著下降** |

> **关键判断**：阶段 3（闸门）是唯一有**安全意义**的。如果工期只能保一件事，
> 保阶段 3 而不保阶段 2 —— 因为 112 项表没有闸也是裸奔，而有闸哪怕表不完整也安全。
>
> ⚠ **但 3.6b 不能单独提前**：它与阶段 3 是「开宽门 + 装闸」的配对，
> **只有阶段 3 没做时，绝不能先做 3.6b**（见 §1.3 顺序表）。
>
> ✅ **3.6a（技能面）可单独提前到任何位置**：它只往 VM 多发两个文档目录，
> 不新增任何可执行能力。**若只想要一件事、成本又最低，就是先做 3.6a** ——
> 半小时的改动，直接让 CLI 拿到 108 份工具手册。

---

## 2. 阶段 1：删除（3d）

### 2.1 删什么

| 目标                                                    | 规模                  | 删除依据                       |
| ----------------------------------------------------- | ------------------- | -------------------------- |
| `core/transport/ssh-tunnel.ts` + `ssh-tunnel-ssh2.ts` | 690 行               | 交付链零调用（三重独立证据见 `11` §决策 E） |
| `SkillDomain` 类型 + `domains` 字段                       | 4 值类型 + 10 SKILL.md | 全仓零读取方，且已漂移 4 vs 6         |
| `adapter-agent-hermes`                                | 488 行               | 仅出现在 config，零代码 import     |
| `WINVM_DELEGATION_REQUIRED_POLICY` 灰度开关               | 1 env + 双分支         | 灰度期已过，双分支是永久认知税            |

### 2.2 连带面清单（**不删会留「半条通道」的误导**）

```
packages/core/src/index.ts:25                    export type TunnelHandle
packages/core/src/transport/index.ts:9,16,82     import / re-export / case 分支
packages/core/src/transport/types.ts:4           「三种传输」注释
packages/contracts/src/transport.ts:12,75        kind:'ssh-tunnel' + transportBaseUrl case
packages/host-sdk/src/index.ts:60,95,126         三处 validate 分支
packages/adapter-host-workbuddy/src/index.ts:133,343,371
delivery/install-host.mjs:953,1211               transports 声明的 kind 字面量
tests/unit/（4 个文件）                           涉及 ssh-tunnel 字面量的用例
```

> ⚠ **最高危的一处**：`install-host.mjs:953` 声明 `kind:'ssh-tunnel'`，  
> 但 `renderConnectorEntry` 渲染成 `type:'streamableHttp'`。  
> **声明说隧道，产物是 HTTP** —— 删的时候必须**同时改声明和类型**，  
> 只改一处会让 `validate()` 报「未知 kind」。

### 2.3 阶段 1 验收

```bash
# ① 死代码清零
grep -rn "ssh-tunnel" packages/*/src/ tests/ | grep -v node_modules
# 期望：0 行

# ② 域模型清零
grep -rn "SkillDomain" packages/*/src/
# 期望：0 行

# ③ hermes 清零
grep -rn "adapter-agent-hermes" packages/ delivery/ | grep -v node_modules | grep -v "/dist/"
# 期望：0 行

# ④ 门禁不退化（关键：失败清单必须仍是那 2 个，不能新增）
node scripts/gate.mjs --quick 2>&1 | grep -E "^RED|^VERDICT"
```

**阶段 1 通过标准**：①②③ 全 0 行，且 ④ 的失败清单**仍为 `phase2-snapshot-truth` + `phase3-skill-claims-guard` 这 2 个**（不新增）。

---

## 3. 阶段 2：统一能力表（5.5d，含 3.6a 技能面 +0.5d）

### 3.1 核心交付物

```ts
// packages/contracts/src/unified.ts（已落地，非计划）
export interface CapabilityEntry {
  readonly id: string;        // 'system.service.control' | 'desktop.pointer.click'
  readonly tool?: string;     // 上游真实工具名；**仅当与 id 不相等时才出现**
  readonly surface: Surface;  // 'vm' | 'browser' | 'desktop'
  readonly risk: RiskLevel;
  readonly title: string;
}

export const UNIFIED_CAPABILITIES: readonly CapabilityEntry[];
// 长度 === 112（阶段 2 已收口；2.3 + 2.4 均已落）
```

> ⚠ **`domain` 不是字段，是 `deriveDomain(id)` 派生函数。** 早前本文件把 `domain` 写成必填属性，
> 与源码不符（实测 79/79 条 `entry.domain` 全是 `undefined`）。派生而不存储是**有意的**：
> 存一份 `domain` 就等于把「id 首段」这个事实写两遍，改一处漏一处就产生静默错标。
> `tool` 同理会尽量省略 —— `vm` 面 54 条的 `tool` 恒等于 `id`，强制写两遍纯属给静默错调送机会。

**收敛过程**（三个面是分两步接进来的，顺序会影响下标）：

| 时点 | `UNIFIED_CAPABILITIES` | 构成 |
|---|---|---|
| 2.4 之前 | 54 | `vm` 54 |
| 2.4 落地后 | 79 | `vm` 54 + `desktop` 25 |
| **现在（2.3 + 2.4 均已落）** | **112** | `vm` 54 + `browser` 33 + `desktop` 25 |

⇒ 表本身已收口（112 = `UNIFIED_TOTAL`）。**但对外承诺还没兑现**：
`meta.capability.list` 仍返回 54，因为它是另一条链路（2.5），见 §3.5b。

### 3.2 为什么 112 而不是更少

| 来源                  | 数量 | 是否算「能力」            |
| ------------------- | -- | ------------------ |
| 现有注册表               | 54 | ✅ 已有 risk 分级       |
| `agent-browser` 工具  | 33 | ✅ 必须算——它们能点网页、跑 JS |
| `agent-desktop` 白名单 | 25 | ✅ 必须算——它们能操作任意窗口   |

**25 而不是 75**：`DEFAULT_DESKTOP_TOOL_ALLOWLIST` 已经是筛选后的高频子集
（现居 `vm-capabilities/src/registry/upstream-tools.ts`，原在 `mcp-upstream.ts:62`，2.4 下沉），  
未暴露的 50 个（`close_app` / `drag` / `clipboard_set` / `sandbox_*` / 原始鼠标事件）**保持不暴露**，  
不是「漏了」，是「刻意不给」。  
⚠ 上游 **75** 是「全量面」，白名单 **25** 才是「可达面」——**表规模恒等于模型真能调到的数量**，
所以记 25 不记 75。

### 3.3 分类设计（这是 owner 最关心的）

**browser / desktop 与 gui 平级，不做子域。**

| domain    | vm     | browser | desktop | 合计      | 判定规则            |
| --------- | ------ | ------- | ------- | ------- | --------------- |
| `meta`    | 3      | —       | —       | 3       | 服务自身            |
| `system`  | 14     | —       | —       | 14      | 服务/进程/注册表/电源    |
| `app`     | 8      | —       | —       | 8       | 安装/卸载/快捷方式      |
| `storage` | 13     | —       | —       | 13      | 文件/目录/磁盘        |
| `gui`     | 11     | —       | —       | 11      | **操作系统级** UI    |
| `appops`  | 5      | —       | —       | 5       | 多步生产流程          |
| `browser` | —      | 33      | —       | 33      | **网页内**         |
| `desktop` | —      | —       | 25      | 25      | **Windows 应用内** |
| **合计**    | **54** | **33**  | **25**  | **112** |                 |

> 上表已**全部兑现**（`vm` 54 + `browser` 33 + `desktop` 25 = 112）。
> 「domain」由 `deriveDomain(id)` 现算，**不是表里的存储字段**（见 §3.1 注）。

**为什么不能把 browser/desktop 塞进 gui**：

「截图」会有 3 个实现——`gui.screen.capture` / `agent_browser_screenshot` / `desktop_screenshot`。  
LLM 面对三个语义相近的工具**无法判断该调哪个**，这正是 owner 说的「分类不清导致不知道调哪个」的病根。  
平级后判据清晰：**整屏选 gui，网页选 browser，应用窗口选 desktop**。

### 3.4 必须补的静态清单（这是硬要求）

事实源统一落在 `packages/vm-capabilities/src/registry/upstream-tools.ts`（**新增文件**）。
之所以住 `vm-capabilities` 而不住 `vm-service`：后者 `package.json` 里**已依赖**前者，
反向 import 会成环（`dep-lint` 必拦）——判据是**依赖方向**，不是 layer 号
（两包在 `package.json` 里**都是 `L2`**，早前文档写 L3/L4 是笔误）。

**desktop 面 25 项 ✅ 已落地（V-NEXT 2.4，方案 A）；browser 面 33 项 ✅ 已落地（V-NEXT 2.3）。
两面合计 58 项 ⇒ 统一表 54 + 58 = 112。**

> **两面落地方式不同，不是笔误**：desktop 在 `defaultUpstreamSpecs()` 里有
> `toolAllowlist: DEFAULT_DESKTOP_TOOL_ALLOWLIST` ⇒ 表可以**从白名单派生**（派生 = 单一事实源）；
> browser 条目**不传 `toolAllowlist`** ⇒ 33 项是**上游全量面**，没有可派生的常量，
> 只能**显式声明** `BROWSER_TOOLS`，再用加载期校验钉住「条数 == 33」。
> 校验位置差异的根因也在这：派生面靠「白名单加项表没加」不可能发生；
> 显式声明面靠「上游加工具忘了补表」**会**发生，所以必须 throw。

```ts
// packages/vm-capabilities/src/registry/upstream-tools.ts

/**
 * ① 白名单：上行工具名字面量（desktop_*），供 McpUpstream.exposedTools() 过滤 tools/list。
 *    = 「放不放行」的开关。25 项逐字从 vm-service 搬来，未增删（对外可达面零变化）。
 */
export const DEFAULT_DESKTOP_TOOL_ALLOWLIST: readonly string[] = Object.freeze([ /* 25 项 */ ]);

/** ② 手工标注表：id 中段是语义分组（observe/window/pointer/input/query），risk 逐条判断。
 *    不能从工具名机械推导 —— 从 desktop_snapshot 推不出归「目标发现」还是「窗口管理」；
 *    risk 是安全判据，标高了多一次审批，标低了是破坏性动作无审批直接执行。 */
const DESKTOP_TOOL_META = Object.freeze({ /* 25 条 {id, risk, title} */ });

/** ③ 派生 + 模块加载期三重校验（不是测试期）。 */
function defineDesktopTools(): readonly CapabilityEntry[] {
  // ① 白名单有、标注没有 → 抛错（否则该工具在统一表缺席 ⇒ 审批闸无规则 ⇒ fail-open）
  // ② 标注有、白名单没有 → 抛错（否则表承诺一条实际调不到的「说谎」条目）
  // ③ 条数不等 → 抛错（防两边同时漏掉同一个的共模错误）
  …
}
export const DESKTOP_TOOLS: readonly CapabilityEntry[] = defineDesktopTools();

/** ④ browser 面 33 项 —— 待 Step 2.3，形状同上。
 *   ⚠ browser **没有白名单**（defaultUpstreamSpecs 里没传 toolAllowlist ⇒ 全量暴露 33 项），
 *   所以这里没有「白名单 vs 标注表」的一致性问题，但**多了个反向义务**：
 *   上游若新增工具，统一表不会自动跟上 ⇒ 必须有一条「上游 tools/list ⊇ 表内 browser 条目」的核对。 */
// export const BROWSER_TOOLS = ...
```

**两面的安全姿态相反，别混**：

| | `desktop` | `browser` |
|---|---|---|
| `defaultUpstreamSpecs()` | 传 `toolAllowlist`（25） | **不传** ⇒ 全量暴露 |
| 可达面 | 上游 75 → 本系统 **25** | 上游 **33** → 本系统 **33** |
| 漂移方向 | 上游加了新工具也**不会**自动进来（安全） | 上游加了新工具**会**自动进来（危险） |
| 统一表怎么保持同步 | 加载期三重校验兜住 | **无兜底**，需 2.3 自行加核对 |

> ⚠ 33 份 ref 文档每份都写「默认暴露：✅ 是（服务端白名单内）」——这句对 desktop 成立，
> 对 browser **是错的**（它没有白名单）。判断依据看 `defaultUpstreamSpecs()` 代码，不要看 ref 自述。

`DESKTOP_TOOLS` **是派生的，不是手写的 25 行字面量数组**。这一点非细节：手写两份就等于
「同一个事实存两处」，而「白名单加了一项、统一表忘了加」这种不一致**不会报错**，
只会让那个工具在审批闸前**无规则可查**而静默放行（fail-open）。所以校验必须发生在
`import` 那一刻 —— 服务起不来，比带病运行安全。

**风险分级**（两面均已实测落地）：

| 级别 | browser（✅ 已落地实测，33 项） | desktop（✅ 已落地实测，25 项） |
|---|---|---|
| `L0` 只读 | **14 项**：observe 7（`read` `snapshot` `get_text` `get_title` `get_url` `tab_list` `screenshot`）+ wait 4（`wait` `wait_for` `wait_url` `wait_text`，只是时钟/条件等待）+ flow 2（`flow_list` `flow_steps`）+ meta 1（`tools_profiles`） | **8 项**：`snapshot` `find` `screenshot` `list_apps` `list_windows` `get` `is` `wait` |
| `L1` 可回滚写 | **18 项**：nav 8（`open` `close` `reload` `back` `forward` `tab_new` `tab_switch` `tab_close`）+ act 6（`click` `fill` `select` `check` `uncheck` `type`）+ scroll 2（`scroll` `press`）+ flow 2（`flow_run` `flow_save`） | **17 项**：窗口 4（`launch` `focus_window` `maximize` `resize_window`）+ 指针 6（`click` `double_click` `right_click` `hover` `scroll` `scroll_to`）+ 输入 7（`type` `set_value` `press` `check` `uncheck` `select` `toggle`） |
| `L2` 破坏性 | **1 项**：**`eval`**（能绕过其余 32 项的一切约束在页内执行任意 JS） | **0 项** |

desktop 列两条须记住的判据：

1. **`desktop_launch` 判 `L1` 而非 `L2`** —— 它只启动应用、不装不卸，关掉即复原。
   真正的「装/卸」在 vm 面 `app.winget.*`，那两条另有分级，不要混。
2. **`L2 = 0` 不等于本面安全** —— 只说明**默认白名单**里没有破坏性动作
   （`close_app` / `drag` / `clipboard_set` / 原始鼠标事件都被排除在 25 项外）。
   将来若加进白名单，必须同步标 `L2`，否则审批闸会按 `L1` 静默放行。

browser 列三条须记住的判据（2.3 实测沉淀）：

1. **不要照搬 desktop 的分布**。desktop `L2 = 0` 是因为它被白名单收窄到 25 项，
   而 browser **没有白名单**（33 项全放）⇒ `eval` 在册，`L2 = 1` 是必然结果，不是标注失误。
2. **`wait_*` 与 `flow_list`/`flow_steps` 是 `L0`**，尽管它们的名字带动作词。
   wait 只是等时间/等条件，不写状态；flow 的 list/steps 是读任务流定义。
   反例：`flow_run`/`flow_save` 会执行或落盘任务流 ⇒ `L1`，同名组不同级是正常的。
3. **不要用上游 ref 的「标注：只读 / 会改变状态」字段做判据**。实测该字段与 `risk.ts`
   不同源 —— 按它会算出 `screenshot`、`tools_profiles` = `L1`（因为"读到外部世界"），
   但 `risk.ts` 的 `L0` 定义是**不改系统状态**，两者都要读外部世界却都不改状态 ⇒ 应为 `L0`。
   **正确做法**：判据取 `risk.ts` 的语义，逐条问「这条动作会不会让系统状态发生不可自动回退的变化」。

### 3.5 阶段 2 验收

```bash
# ① 表长度精确（2.3 + 2.4 都已落地 ⇒ 现在应得 112，不再是 79）
node -e "
Promise.all([
  import('./packages/vm-capabilities/dist/registry/unified.js'),
  import('./packages/contracts/dist/unified.js'),
]).then(([m,k])=>{
  const t=m.UNIFIED_CAPABILITIES, n=t.length;
  const by={}; for(const c of t) by[c.surface]=(by[c.surface]||0)+1;
  console.log('count=',n,by);
  // ② ③ ④ 用官方校验器（逐条合法 + id 唯一），不要自己手搓
  const problems=k.validateUnifiedTable(t);
  if(problems.length){ console.error(problems); process.exit(1); }
  // ③ 补一条官方校验器不覆盖的：非 vm 面首段必须等于面名
  for(const c of t)
    if(c.surface!=='vm' && k.deriveDomain(c.id)!==c.surface)
      throw new Error('surface 首段不符: '+c.id);
  if(n!==112) process.exit(1);
});
"
# 实测：count=112 {vm:54,browser:33,desktop:25}
# ②③④ 已并入上面的脚本，全部通过
# ⑤ meta.capability.list 返回 112 —— ✅ 已兑现（方案 B，见 §3.5c）
```

**实测（2026-11-24，非推断）**：`count= 112 {"vm":54,"browser":33,"desktop":25}` /
`validateUnifiedTable problems = 0` / `surface 首段不符 = 0` / `n!==112 = false`（已收口）。

**该脚本非空转（五类突变反证，全部 `CAUGHT`）**：

| 突变 | 被谁抓 | 报错首行 |
|---|---|---|
| 重复 id | `validateUnifiedTable` | `duplicate id: meta.health.check` |
| 只两段 `desktop.click` | `defineCapabilityEntry` | `expected exactly 3 non-empty dot-segments` |
| `desktop.*` 条目错标 `surface:'browser'` | `defineCapabilityEntry` | `surface "browser" requires id to start with "browser."` |
| `risk:'L9'` | `defineCapabilityEntry` | `risk "L9" not in [L0, L1, L2, L3]` |
| `title:'  '` | `defineCapabilityEntry` | `title must be non-empty` |

> **不要用 `entry.domain` 判 ③**：该字段不存在（`domain` 是 `deriveDomain(id)` 函数）。
> 写成 `c.id.split('.')[0]!==c.domain` 会让每条都拿 `undefined` 去做比较，
> 表面「全部不符」或（若判据反过来写）「全部通过」——**两种都是假结论**。

### 3.5b ⚠ ⑤ 不通：`meta.capability.list` 有**三处硬钉 54**，与 2.5 直接冲突

§3.5 的 ①（表 = 112）已通过，但 **⑤ 不会因为表变了就自动生效**——
`meta.capability.list` 走的是**另一条链路**：`adapter-agent-workbuddy/src/index.ts` 的
`buildCapabilityList()`，它只读 `WINDOWS_CAPABILITIES`（vm 面 54 条），**完全没引用统一表**。

把它改成 112，会同时撞上三处**当前为绿**的约束：

| # | 位置 | 约束内容 | 性质 |
|---|---|---|---|
| 1 | `tests/unit/p5-r1-capability-list-pin.test.js:144` | `assert.equal(data.count, 54, 'deterministic 声明六域通配 ⇒ 暴露面=注册全集 54')` | **语义钉**，不是数字噪声 |
| 2 | 同文件 A3 | `deepEqual(got.sort(), WINDOWS_CAPABILITIES.map(c=>c.id).sort())` —— 返回 ID 集必须 **=== 注册表全集** | **同源钉** |
| 3 | `delivery/pack-release.mjs:884` | 发布后验证脚本写死 `'2. MCP 直调 meta.capability.list：count=54'` | 冒烟断言 |

外加 SKILL 面四处文档（`winvm-{app-manager,gui-automation,storage-manager,system-admin}/SKILL.md`）
都承诺「与 tools/list **同源一致**」。

**为什么这不能算「等价搬迁」**（区别于 2.4 的白名单下沉）

2.4 那次是**同一语义换存放位置**：白名单 25 项逐字未变，只是住址从 `vm-service` 挪到 `vm-capabilities`，
断言判据一条没减。而 2.5 是**语义本身要改**：

- 现状语义 = 「vm 面注册表**执行体**清单」（`WINDOWS_CAPABILITIES`，54 条，每条都有 `domain`/`input`/`output`）
- 2.5 期望 = 「跨三面**可达**能力清单」（`UNIFIED_CAPABILITIES`，112 条，只有 `id`/`surface`/`risk`/`title`）

两者**字段集都不同**。`p5-r1` 当初修的是「名实不符」缺陷（description 承诺"已注册并暴露的能力清单"，
旧实现却返回 ps1 文件名列表）。把 54 改成 112 并不违背那句 description，但会打破
「与 `tools/list` 同源一致」——因为 **`/mcp` 的 `tools/list` 只暴露 54 项**，
另 58 项在 `/mcp/browser` 与 `/mcp/desktop` 两个**独立端点**上。

⇒ 于是变成一个需要 owner 裁定的**契约问题**，三个选项互斥：

| 选项 | 做法 | 代价 |
|---|---|---|
| **A 保持 54（推荐）** | 2.5 只做「表已 112」的事实登记，`capability.list` **不动**；另加一个新能力（如 `meta.capability.listAll`）返回 112 | 多一个工具；但 `/mcp` 端口径不被污染，`p5-r1` 与 4 处 SKILL 零改动 |
| **B 改成 112** | `buildCapabilityList()` 改读 `UNIFIED_CAPABILITIES` | 须同步改 3 处断言 + 4 处 SKILL 文案；且「与 tools/list 同源」**从此不成立**（`/mcp` 只有 54） |
| **C 按 provider 声明分面** | `capability.list` 返回「本 provider 声明面 ∩ 统一表」 | 语义最干净，但要先定义「provider 如何声明 browser/desktop 面」，属阶段 3 的范围 |

**当前处置**：**B 已由 owner 裁定（2026-11-24）并落地完成**，详见 §3.5c。

**阶段 2 通过标准**：①②③④⑤ 全通过 + **3.6a 的验收 ①②③ 全通过**（见 §3.6.4），
且**门禁失败清单仍为那 2 个**。  
（注意：阶段 2 不会让那 2 个失败变绿——它们是阶段 3 的产物，且阶段 3 也不会让它们变绿，见 §4.5。）

---

### 3.5c ✅ ⑤ 已兑现：B 方案落地记录（owner 裁定 2026-11-24）

#### 落地的实质

`buildCapabilityList()` 的数据源从 `WINDOWS_CAPABILITIES`（vm 54）换成
`UNIFIED_CAPABILITIES`（三面 112），但**不是简单换一行**。以下是四处非显然的处理：

**① 求交基准必须按面区分（否则换了也还是 54）**

`declareCapabilities()` 只声明六个 **vm 域**（`meta/system/app/storage/gui/appops`）。
拿它对统一表求交，`browser.*` 与 `desktop.*` 会被**全部滤掉**。实测：

```
declareCapabilities 六域通配 ∩ 统一表 112  =>  54   {"vm":54}
加 browser.*/desktop.* 后                  => 112   {"vm":54,"browser":33,"desktop":25}
```

⇒ 正确语义是**分面取判据**，不是给 provider 加两个通配：

| 面 | 是否受 `declareCapabilities()` 约束 | 理由 |
|---|---|---|
| `vm` | **受** | provider 声明收窄 ⇒ 服务端 `exposedCapabilities` 同步收窄 ⇒ 清单必须跟着收窄 |
| `browser` / `desktop` | **不受** | 可达性由「服务端是否挂载该 stdio 上游」+「白名单」决定，与 VM 侧 provider 声明无关 |

给 provider 加 `browser.*` 是**错的**：那会让 provider 声明声称自己能"承载"浏览器工具，
而实际承载它们在另一个进程里。声明面失真比数字不对更危险。

**② `name` 字段在 browser/desktop 两面不存在（字段集不同，这是 B 的真实成本）**

`CapabilityEntry` 是 `{id, surface, risk, title}`；旧回执承诺 `{id, name, risk}`。
`name` 只在 `CapabilityDefinition`（vm 面）里有。处理：
- `vm` 面 → `WINDOWS_CAPABILITIES` 的真实 `name`
- 另两面 → **回落 `title`**（中文短标题），**不编造 name**，并在注释里写明这一面没有 name 语义

同时新增 `surface` 字段（向后兼容的加字段），让调用方能自行分辨面。

**③ 17 项 id 含下划线，旧断言的正则会把它们全判错**

`p5-r1` 原断言用 `/^[a-z][a-z0-9]*\.[a-z][a-z0-9]*\.[a-z][a-z0-9]*$/` 校验 id 形态。
统一表里有 **17 项** id 含下划线（`browser.nav.tab_new`、`desktop.pointer.double_click` …），
这些是上游工具名的合法转写，会被该正则**全部判为非法**。

判据必须回到**契约本身**：`defineCapabilityEntry` 只要求「三个非空点段」，不限字符集。
⇒ 断言改为 `id.split('.').length === 3`。

**④ 一处必须诚实登记的已知不精确**

`WINVM_UPSTREAM_OFF=browser,desktop` 是运维回滚位（`server.ts:2079`）。关掉后这两面实际不可达，
但 `buildCapabilityList()` **看不到该开关** —— `BridgeContext` 不含上游状态。

那种状态下本清单会多列 58 条。取舍：本函数在 **provider 侧**，上游挂载是**服务端侧**决策；
让 provider 反查 `process.env` 会形成隐式耦合。且 `capability.list` 的语义是
「已**注册**并暴露」（注册表口径），不是「此刻网络可达」。
⇒ 若将来需要「当前实可达」口径，正确做法是服务端把上游状态**注入 `BridgeContext`**，
而不是让本函数去读环境变量。**这一点在代码注释里逐字写明，防止后人当 bug 修掉。**

#### 改了哪些文件

| 文件 | 改动 |
|---|---|
| `packages/adapter-agent-workbuddy/src/index.ts` | `buildCapabilityList()` 重写（分面求交 + name 回落 + surface 字段）+ 导入 `UNIFIED_CAPABILITIES` + 大段设计注释（含 ④ 的取舍） |
| `tests/unit/p5-r1-capability-list-pin.test.js` | A2 `count` 54→112、id 正则→三段式、加 `surface` 校验；A3 基准换统一表 + **新增 4 条**（三面在场/逐面计数、vm 同源、非 vm 回落 title、**vm 面仍受声明约束**）；A6 措辞钉 `注册表直供`→`统一表直供` + 加 `112` 钉 |
| `skills/winvm-{app-manager,gui-automation,storage-manager,system-admin}/SKILL.md` | 四份口径句同步（`{id,name,risk}`→含 `surface`、count 54→112、说明"同源"指三面之和） |
| `packages/vm-capabilities/src/registry/definitions.ts` | `meta.capability.list` 的注释同步（数据源与字段形态） |
| `delivery/pack-release.mjs` | 发布验证清单第 2 条 `count=54`→`count=112`（**V4 断言的 54 不动**，它测的是 `WINDOWS_CAPABILITIES.length`，与本次无关） |

#### 「与 tools/list 同源一致」这句话现在**仍然成立**（此前我判断有误）

§3.5b 原写「B 会让这句承诺变成假话」，**这个判断是错的**，必须订正：

`/mcp` 的 `tools/list` 是 54，但**系统有三条 `tools/list` 路由**：
`/mcp`（54）、`/mcp/browser`（33）、`/mcp/desktop`（25）。三面合计**正好 112**，
与 `UNIFIED_CAPABILITIES` 的定义逐条对应。

⇒ 正确的表述是「与 tools/list **之三面之和**同源一致」，而不是「与 `/mcp` 单个路由同源」。
原承诺之所以读起来像要破裂，是因为它**默认把 `tools/list` 等同于 `/mcp` 一条**——
那个隐含前提本身就是不完整的。B 只是把这个前提写明。

四份 SKILL 的文案已按此改写，并**用测试钉住**（A6 现在同时要求含「统一表直供」与「112」）。

#### 验收（全部实跑）

```
meta.capability.list  →  count = 112  {vm:54, browser:33, desktop:25}
tsc -b tsconfig.build.json  →  rc=0
p5-r1-capability-list-pin  →  20/20 pass（原 16 条 + 新增 4 条）
```

**突变反证 3 抓 3**（证明新断言非空转）：

| 突变 | 结果 | 抓它的断言 |
|---|---|---|
| ① 整表不过滤（vm 面收窄语义丢失） | 1 条 FAIL | ★「vm 面仍受 provider 声明约束」——**只抓这一条，说明该钉精确** |
| ② 退回 `WINDOWS_CAPABILITIES` | 5 条 FAIL | A2 count / A3 全集 / 三面计数 / vm 同源 / ★vm 收窄 |
| ③ `name` 不回落 title | 2 条 FAIL | A2 类型校验 /「非 vm 面回落 title」 |

---

### 3.6 横向子步：两端能力面对齐（3.6a 技能面 / 3.6b 工具面）

§1.0 的 G-1 / G-2 是两个**独立**缺口，修法、风险、顺序要求**完全不同**，因此拆成两个子步。
合称「3.6」，但**绝不捆排期**：

| 子步 | 面 | 改动性质 | 顺序要求 |
|---|---|---|---|
| **3.6a** | 技能面（VM 侧 7 → 9 个 skill） | 纯文档下发，零执行能力 | ✅ **任意时点可做**，建议越早越好 |
| **3.6b** | 工具面（VM 内 CLI 54 → 112 项） | 开宽工具面 | ★ **必须等阶段 3 闸门完成** |

#### 3.6.1 工具面：`buildMcpConfig()` 从 1 个条目扩成 3 个（3.6b）

**现状**（`packages/adapter-agent-workbuddy-llm/src/bridge.ts:260` 附近）

```ts
// 改前：只有一个条目，指向 /mcp
const entry = { type: 'streamableHttp', url: appendDtid(endpoint, dtid) };
return JSON.stringify({ mcpServers: { winvm: entry } }, ...);
```

`endpoint` 出厂默认 `http://127.0.0.1:18443/mcp`（`core/src/config/index.ts:187`），
但**它可被配置覆盖**（这正是下面那个陷阱的来源）。

##### 陷阱：不能用 `endpoint.replace(/\/mcp$/i, '')` 推基址

我最初的设计稿就是这么写的，**实测静默算错**。因为 `endpoint` 的形态不止一种：

| `endpoint` 实际值 | `/\/mcp$/` 结果 | 拼出的 browser url | 后果 |
|---|---|---|---|
| `http://h:18443/mcp` | ✅ `http://h:18443` | `http://h:18443/mcp/browser` | 正常 |
| `http://h:18443/mcp/`（**尾斜杠**） | ❌ **不替换**（`$` 前是 `/`） | `http://h:18443/mcp//mcp/browser` | **404，且不报错** |
| `http://h:18443/mcp?x=1`（**带 query**） | ❌ **不替换** | `http://h:18443/mcp?x=1/mcp/browser` | **404，且不报错** |

后两种形态下 CLI 会「拿到了 3 个条目，但 2 个是坏的」，**症状是工具调不通而不是配置报错**，
排查成本极高（会误判成「隧道坏了」或「upstream 没起来」）。

##### 正确实现：`deriveMcpBase()`

```ts
/**
 * 从 endpoint 推导 MCP 基址（去掉尾部 /mcp）。
 * 假设不成立时返回 null —— 调用方必须退回「单条目」旧行为，不得猜。
 * 之所以不抛异常：本函数在「委派启动」关键路径上，抛异常会让整条路径 2 挂掉。
 */
function deriveMcpBase(endpoint: string): string | null {
  let u: URL;
  try { u = new URL(endpoint); } catch { return null; }
  const stripped = u.pathname.replace(/\/mcp\/?$/i, '');
  if (stripped === u.pathname) return null;   // 不以 /mcp 结尾 ⇒ 不是我们认识的形态
  const origin = `${u.protocol}//${u.host}`;
  const basePath = stripped.replace(/\/$/, ''); // 去掉可能残留的尾斜杠
  return `${origin}${basePath}`;
}
```

**保留 `u.search`**（不要丢）：这样 `winvm` 条目重建出来的 url **与改动前逐字相同**
（`base + '/mcp' + search === endpoint`），是最好的回归不变量。

##### 三个条目的拼装

```ts
const base = deriveMcpBase(endpoint);
if (base === null) {
  // 形态不认识 ⇒ 逐字退回旧行为（1 个条目），并留痕
  logger.warn(
    `[buildMcpConfig] endpoint 形态非预期（${endpoint}），仅注册 winvm 条目；` +
    `VM 内 CLI 将看不到 browser/desktop 的 58 项工具`
  );
  return JSON.stringify({ mcpServers: { winvm: entry } }, ...);
}

const search = new URL(endpoint).search;          // 通常是空串
const bearer = bearerEnvName === undefined || bearerEnvName === null;
const headers = bearer ? undefined
  : { Authorization: `Bearer \${${bearerEnvName}}` };   // 注意：变量引用，不是明文

const mk = (path: string) => ({
  type: 'streamableHttp',
  url: appendDtid(`${base}${path}${search}`, dtid),   // ★ 统一走 appendDtid
  ...(headers ? { headers } : {}),
});

return JSON.stringify({
  mcpServers: {
    winvm:         mk('/mcp'),
    'winvm-browser': mk('/mcp/browser'),
    'winvm-desktop': mk('/mcp/desktop'),
  },
}, ...);
```

##### `deriveMcpBase()` 六形态实测（设计验证，已跑）

| 输入 `endpoint` | 返回 | 说明 |
|---|---|---|
| `http://127.0.0.1:18443/mcp` | `http://127.0.0.1:18443` | 出厂默认 |
| `http://127.0.0.1:18443/mcp/` | `http://127.0.0.1:18443` | 尾斜杠（旧正则失效点 ①） |
| `http://127.0.0.1:18443/mcp?foo=bar` | `http://127.0.0.1:18443` | 带 query（旧正则失效点 ②） |
| `http://127.0.0.1:18443/api/mcp` | `http://127.0.0.1:18443/api` | 带前缀路径 |
| `http://127.0.0.1:18443/` | `null` | 不以 `/mcp` 结尾 ⇒ 降级 |
| `http://127.0.0.1:18443/mcp/x` | `null` | 不是 `/mcp` 结尾 ⇒ 降级 |
| `not-a-url` | `null` | `new URL()` 抛错 ⇒ 降级 |

##### ★ 隐形阻塞：现有 9 条护栏断言会把「1 个条目」钉死（**2026-11-24 实测发现**）

这是 3.6b 唯一的**非设计性**障碍，且**门禁不会告警**（它只在跑单测时才炸）。
`buildMcpConfig()` 目前被三个测试文件用**逐字节快照**守护，它们把「只有一个 `winvm` 条目」写成了硬断言：

| # | 文件:行 | 断言形态 | 3.6b 后的结果 |
|---|---|---|---|
| 1 | `phase2-inner-credential.test.js:106` | `buildMcpConfig(URL,undefined,'   ') === LEGACY_OUT(URL)` | ❌ 失败（现产出 3 条目） |
| 2 | 同文件 `:107` | `buildMcpConfig(URL,undefined,'') === LEGACY_OUT(URL)` | ❌ 失败 |
| 3 | 同文件 `:123` | `buildMcpConfig(URL) === LEGACY_OUT(URL)` | ❌ 失败 |
| 4 | 同文件 `:124` | `buildMcpConfig(URL,undefined) === LEGACY_OUT(URL)` | ❌ 失败 |
| 5 | 同文件 `:125` | `buildMcpConfig(URL,undefined,undefined) === LEGACY_OUT(URL)` | ❌ 失败 |
| 6 | 同文件 `:128` | 整串 `{"mcpServers":{"winvm":…}}` 逐字相等 | ❌ 失败 |
| 7 | `r19c-kn1-b-bridge.test.js:354` | `buildMcpConfig(URL) === LEGACY_OUT(URL)` | ❌ 失败 |
| 8 | 同文件 `:363` | 整串逐字相等 | ❌ 失败 |
| 9 | 同文件 `:365` | `Object.keys(parsed.mcpServers)` **恰为** `['winvm']` | ❌ 失败 |

`LEGACY_OUT = (ep) => JSON.stringify({ mcpServers: { winvm: { type:'streamableHttp', url: ep } } })`
—— 它同时钉住了**条目数与整串字节**。

##### 处置：等价搬迁，不是放宽断言（**已实测可等价**）

**关键事实**：改后 `winvm` 条目与旧输出**逐字相等**（因为 `base + '/mcp' + search === endpoint`）。
已用模拟实现跑过 6 种组合全部为真：

```
dtid=undefined bearer=undefined            servers=3  winvm逐字相等=true
dtid=tr_1      bearer=undefined            servers=3  winvm逐字相等=true
dtid=undefined bearer="WINVM_BEARER_TOKEN"  servers=3  winvm逐字相等=true
dtid=tr_t6_1   bearer="WINVM_BEARER_TOKEN"  servers=3  winvm逐字相等=true
dtid=undefined bearer=""                    servers=3  winvm逐字相等=true
dtid=undefined bearer="   "                 servers=3  winvm逐字相等=true
```

⇒ 断言**可以改写成两条更强的新断言**，覆盖面不减反增：

```js
// 旧（钉死"恰 1 条 + 整串相等"）
assert.equal(buildMcpConfig(URL), LEGACY_OUT(URL));

// 新（钉死"winvm 条目逐字不变" + "另外两条已补齐"）
const cfg = JSON.parse(buildMcpConfig(URL));
assert.equal(
  JSON.stringify({ winvm: cfg.mcpServers.winvm }),
  JSON.stringify(JSON.parse(LEGACY_OUT(URL)).mcpServers),
  'winvm 条目须与旧实现逐字节相等（回归护栏保留）',
);
assert.deepEqual(Object.keys(cfg.mcpServers).sort(), ['winvm', 'winvm-browser', 'winvm-desktop']);
```

**为什么这不算「为了让门禁变绿而放宽断言」**（§0.3 红线）：

| 判据 | 旧断言 | 新断言 |
|---|---|---|
| 仍在守「`winvm` 条目不漂移」 | ✅ | ✅ **逐字节更严**（只允许 `winvm` 键本身相等，不再混着比整体串） |
| 仍在守「`dtid` 拼接形态」 | ✅ | ✅ 保留（`appendDtid` 的子串断言全在） |
| 仍在守「`bearer` 三态」 | ✅ | ✅ **新增**：三态 × 三条目交叉枚举 |
| 覆盖面 | 1 条目 | **3 条目** |
| 是否关闭守卫 | — | ❌ 未关闭，反而扩了 |

**必改清单（3.6b 施工时必须同时提交）**：上面表格 9 处 + `LEGACY_OUT` 辅助函数改为
`LEGACY_WINVM(ep)`（只产出 `winvm` 单条目，供「逐字节相等」比对用）。
**这 9 处必须在同一个 commit 里改完** —— 只改实现不改测试，单测必红；
只改测试不改实现，测试失去意义。

> ⚠ **这也是「3.6b 必须等阶段 3」的又一条理由**：它会同时改动
> `bridge.ts` + 2 个测试文件的 9 处断言。放在阶段 3 之后做，
> 失败面才可归因（阶段 3 的回归 vs 3.6b 的回归）。

#### 3.6.2 技能面：`HOST_ONLY_SKILLS` 从 3 个收窄到 1 个（3.6a）

**改动点 1 处常量 + 3 处连带面（D-1 ~ D-4）**

| # | 位置 | 改什么 |
|---|---|---|
| **D-1** | `delivery/deploy-shared-skills.mjs:40` | `HOST_ONLY_SKILLS` = `['hos-win-skill','agent-browser-skill','agent-desktop-skill']` → `['hos-win-skill']` |
| **D-2** | 同文件，该常量的注释 | 现注释写「VM 内 Agent 绝不应见到它们」—— **与新行为直接矛盾**，会变成下一轮误判的源头。必须整段改写为「唯一判据」表述（见下） |
| **D-3** | `skills/agent-browser-skill/SKILL.md`、`skills/agent-desktop-skill/SKILL.md` | 开头「服务形态」一句改为**端点自适**：宿主经 `connector:winvm-browser/desktop`；VM 内 Agent 经 `mcpServers.winvm-browser/desktop`。**工具名、参数、工作流、失败判据两端完全一致** |
| **D-4** | `tests/unit/deploy-shared-skills.test.js` | 断言「VM 侧 = 7」处改 **9**，并加 3 条分界断言（见 3.6.4 ⑥） |

**D-2 要写成的判据（这是整件事的根，别只改数字）**

> **唯一判据**：*「这个 skill 是否只在『还没进 Windows』时才有意义？」*
> —— 是 ⇒ host-only（不下发 VM）；否 ⇒ Windows 操作指引（两端共用，必下发）。
>
> 按此判据：
> - `hos-win-skill` = **分派层**（鸿蒙本地任务 vs Windows 任务的分派预判 + 宿主调用链路特殊性）。
>   VM 内已经在 Windows 里，「要不要去 Windows」这个问题对它不存在；
>   且其正文含 `winvm-plugin tunnel *`、`~/.winvm/**` 等**宿主独有路径，VM 内不存在**，
>   CLI 读到会照错执行 ⇒ **保持 host-only**。
> - `agent-browser-skill` / `agent-desktop-skill` / 其余 7 个 = **Windows 操作指引**
>   （「到了 Windows 怎么用工具干活」）⇒ **必须下发**。

**为什么这条判据必须写进注释**：原名单的错误不是「选错了哪几个」，
而是**把分派层的判据套用到了操作指引上**。只改数组不改注释，
下一个维护者看到空荡荡的注释会重新把两个上游技能加回去。

#### 3.6.3 八条约束（P-1 ~ P-7 + P-2b，3.6b 施工时逐条对照）

| # | 约束 | 理由 / 违反后果 |
|---|---|---|
| **P-1** | **三条目共用同一 `dtid`**，且都经 `appendDtid()` 拼接 | 三条链路必须落在同一个委派上下文里，否则策略门看到的 `isInnerDelegation()` 结果不一致（`vm-service/src/server.ts:2192` 解析 `dtid`，`:2254` 上游分支不解析、传 `undefined`）。自己拼 `?dtid=` 会把 query 拼接逻辑复制成第二份，`?`/`&` 分支迟早写错 |
| **P-2** | **`bearerEnvName` 三态语义逐字不变** | `index.ts:161` 注释明写是三态：`undefined`/`null` ⇒ `{"mcpServers":{}}`；**空串** ⇒ 有条目**无** `headers`；非空 ⇒ 每条都带 `Authorization: Bearer ${name}` **变量引用**。扩成三条后，前两态的输出必须**逐字**不变（`{"mcpServers":{}}`），空串态才是「3 条目且都无 headers」 |
| **P-2b** | **9 条护栏断言同 commit 等价搬迁** | `phase2-inner-credential.test.js`（6 处）+ `r19c-kn1-b-bridge.test.js`（3 处）把「恰 1 条目」写成了硬断言。必须按 §3.6.1「隐形阻塞」表的等价写法同时改，**且只许加强不许放宽**。只改实现不改测试 ⇒ 单测必红；只改测试不改实现 ⇒ 测试失去意义 |
| **P-3** | **凭据防线不得削弱** | `containsBearerCredentialLiteral` 检查仍在（`grep -c` ≥ 2），**绝不能**把 token 明文写进 `mcpServers`。这是红线「token 不落盘」的落点 |
| **P-4** | **端点形态不符时降级、不猜、不抛** | 见 3.6.1 的 `deriveMcpBase()` 返回 `null` 分支。宁可少 58 项工具，不可让路径 2 启动失败 |
| **P-5** | **不得触碰 `bridge.ts` 其他逻辑 / `persistent-session.ts`** | 红线 M-1：这两个文件是路径 2 的全部实现（1892 + 1144 行）。3.6b 只改 `buildMcpConfig()` 一个函数体 |
| **P-6** | **三条目不得改动上游服务端** | 3.6b 是**客户端配置**改动。`/mcp/browser`、`/mcp/desktop` 两个 upstream 已在服务端注册（`server.ts:2245` 分支），本步不加任何服务端代码 |
| **P-7** | **顺序铁律：阶段 3 未完成禁止开工** | 3.6b 把 58 个**当前无闸**的工具暴露给 VM 内 CLI。闸没装 = 净增风险（详见 §1.3 顺序表）。前置检查不过即停 |

#### 3.6.4 验收（六条，可复制）

```bash
# ① 名单已收窄为 1 个（3.6a）
# ⚠ 该文件是带 top-level await 的 ESM，**不能用 require()**（会报 ERR_REQUIRE_ASYNC_MODULE）
node --input-type=module -e "
const m=await import('./delivery/deploy-shared-skills.mjs');
console.log('HOST_ONLY=',m.HOST_ONLY_SKILLS);
if(m.HOST_ONLY_SKILLS.length!==1||m.HOST_ONLY_SKILLS[0]!=='hos-win-skill') process.exit(1);
"
# 期望：HOST_ONLY=[ 'hos-win-skill' ]

# ② 矛盾注释已消失（D-2）
# ⚠ 锚点必须用「绝不应见到它们」（带"它们"）—— 旧注释原句是「VM 内 Agent 绝不应见到它们」。
#   若只搜「绝不应见到」，会命中「历史修正」段里**故意保留的旧理由引用**（那句是对旧判断的说明，
#   不是仍在生效的规则），造成误判。这是「门禁假绿/假红」的又一例：**查子串不查语境**。
grep -c "绝不应见到它们" delivery/deploy-shared-skills.mjs
# 期望输出：0（grep -c 输出数字 0，退出码 1 —— 属正常）
# 正面断言：新判据句必须在
grep -c "是否只在" delivery/deploy-shared-skills.mjs
# 期望：>= 1

# ③ 规划结果 VM=9 / 宿主仍 10（G-2 的正面断言）
node --input-type=module -e "
import fs from 'node:fs';
const m=await import('./delivery/deploy-shared-skills.mjs');
const repo=fs.readdirSync('skills',{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>e.name);
const toVm=repo.filter(s=>!m.HOST_ONLY_SKILLS.includes(s));
console.log('repo=',repo.length,'VM=',toVm.length);
if(toVm.length!==9) process.exit(1);
if(!toVm.includes('agent-browser-skill')||!toVm.includes('agent-desktop-skill')) process.exit(1);
const host=await import('./packages/host-sdk/dist/skill-loader.js');
const r=await host.loadSkillBundles('skills');
if(r.length!==10) process.exit(1);
"
# 期望：repo= 10 VM= 9（宿主侧本就不过滤，不该去给它加过滤）

# ④ 三条目 + 三条 dtid + 三条 path（3.6b，P-1 正面断言）
node --input-type=module -e "
const m=await import('./packages/adapter-agent-workbuddy-llm/dist/index.js');
const cfg=JSON.parse(m.buildMcpConfig('http://127.0.0.1:18443/mcp','T1','E'));
const want={'winvm':'/mcp?','winvm-browser':'/mcp/browser?','winvm-desktop':'/mcp/desktop?'};
for(const [k,v] of Object.entries(want)){
  const url=cfg.mcpServers[k].url;
  if(!url.includes(v)||!url.includes('dtid=T1')){console.log('BAD',k,url);process.exit(1)}
}
if(Object.keys(cfg.mcpServers).length!==3) process.exit(1);
console.log('all three paths + dtid OK');
"

# ⑤ 端点异常安全降级（P-4）
node --input-type=module -e "
const m=await import('./packages/adapter-agent-workbuddy-llm/dist/index.js');
const n1=Object.keys(JSON.parse(m.buildMcpConfig('http://127.0.0.1:18443/','T1','E')).mcpServers);
if(n1.length!==1||n1[0]!=='winvm') process.exit(1);
for(const ep of ['http://127.0.0.1:18443/mcp/','http://127.0.0.1:18443/mcp?foo=1']){
  const n=Object.keys(JSON.parse(m.buildMcpConfig(ep,'T1','E')).mcpServers);
  if(n.length!==3){console.log('FAIL',ep,n);process.exit(1)}
}
console.log('degrade + two abnormal shapes OK');
"

# ⑥ 三类回归者不得放行（D-4：分界断言 + 突变反证）
node --test tests/unit/deploy-shared-skills.test.js 2>&1 | tail -8
# 期望：pass 14 / fail 0
# 突变反证：把 HOST_ONLY_SKILLS 改回 3 个 → 应被抓（实测 pass 11 / fail 3）
```

**3.6a / 3.6b 的验收门槛不同**：③ 是 3.6a 的收口；④⑤ 是 3.6b 的收口；
⑥ 覆盖两者（名单类断言 + 条目类断言在同一测试文件）。

---

### 3.7 ✅ 已裁定：`hos-win-skill` **不下发 VM**（owner 2026-11-24）

> **本节原为「争议项 · 需 owner 拍板」，现已裁定，不再是待决项。**

| 项 | owner 裁定 |
|---|---|
| `hos-win-skill` 是否下发 VM | **不下发**。它的定位是「指引鸿蒙端 WorkBuddy 判断哪些任务要走 winvm plugin 执行」——**任务分派判断**，不是 Windows 操作指引 |
| 其余 9 个 skill | **下发**。它们是 Windows 任务操作指引，可指引 WorkBuddy 或 codebuddy-lite 如何用两个 MCP 工具面完成 Windows 任务 ⇒ **两端共用** |
| a2a 任务的执行主体 | **VM 端 WorkBuddy 内的 codebuddy-lite native agent**，不是直接调用 WorkBuddy/CodeBuddy 内配置的 LLM |

**裁定同时要求补一件事（已落地）**：既然留在宿主侧，就必须在 `hos-win-skill` 里
**提醒宿主 WorkBuddy「调 VM 端 MCP / A2A 有特殊性」**——经 tunnel-service 调 VM 端的
mcp 与 a2a service，**不是普通直连**。已在 `skills/hos-win-skill/SKILL.md` 新增 **§0.5**：

| 小节 | 内容 |
|---|---|
| §0.5.1 | 三条链路的真实形态：`/mcp` 直调、`/mcp/browser`+`/mcp/desktop`（**同一条隧道只差 path**）、A2A（宿主侧 **stdio** 桥内部再打 `/a2a`）。核心结论：**`127.0.0.1:18443` 不是「VM 的地址」，而是宿主机上的一个本地端口** |
| §0.5.2 | 四条宿主专属铁律 H-1~H-4：禁手工建 SSH 转发（会与守护进程抢端口）／禁直连 VM IP 的 18443（VM 侧只听自身回环）／禁裸 PowerShell 绕过能力层／端口通 ≠ 可用（TCP 通但 HTTP 无响应 = 隧道黑洞） |
| §0.5.3 | 三条健康命令用途不同、不可互替：`tunnel status`（只认本命令，`tunnel.state.json` 可能陈旧）／`tunnel ensure`／`health`（`ok:true` 即放行；`health=200` **不是**通道判据） |
| §0.5.4 | A2A 委派到底「谁在干活」：**不是**直连 LLM API 做一次性规划；**不是**宿主逐步下发；CLI 用的工具**不需宿主中转**（自己带 `dtid` 回连）。实用含义：给宿主下指令要给目标态+约束，不要给步骤清单 |

**为什么这个裁定是对的**（供未来回溯，不是要重新讨论）：

1. **判据自洽**：VM 内已经在 Windows 里，「要不要去 Windows」对它不存在 ⇒ 分派层知识对它无信息量。
2. **反例实证**：该 skill 正文含 `winvm-plugin tunnel *`、`~/.workbuddy/**` 等**宿主独有路径**，
   这些在 VM 内**不存在**；下发等于让 CLI 照着一份跑不通的路径清单执行。
3. **无信息损失**：VM 内 Agent 需要的是「到了 Windows 怎么用工具」，那 9 个 skill（含 108 份
   `references/` 逐工具参数表）已完整覆盖。
4. **不想让宿主变瞎**：留在 host-only 名单里，宿主侧照常加载（`loadSkillBundles` 本就不过滤，实测 10 个）。

---

## 4. 阶段 3：统一闸门（4d）★ 安全核心

### 4.1 要修的洞（回顾）

```
/mcp          → 54 能力 → evaluateScoped ✅ → provider.execute ✅ → audit ✅
/mcp/browser  → 33 工具 → ✗ 直接 handleRequest
/mcp/desktop  → 25 工具 → ✗ 直接 handleRequest
```

证据：`server.ts:2245` 分支内无 `evaluateScoped`；`mcp-upstream.ts` 搜 `policy|audit|approval|capability` **命中 0**。

### 4.2 交付物

```ts
// packages/vm-service/src/gateway.ts（新增）
export async function gateAndExecute(
  entry: CapabilityEntry,
  params: unknown,
  ctx: ExecCtx,
): Promise<ExecResult> {
  // ① 策略：黑名单 + 默认放行
  const verdict = evaluateScoped(entry, params, ...);
  if (!verdict.allowed) return denied(verdict);

  // ② 审批：L2/L3 直调 ⇒ DELEGATION_REQUIRED（与现有语义一致，不改）
  if (verdict.requiresApproval && !ctx.innerDelegation) return delegationRequired(entry);

  // ③ 执行：按 surface 分发，但已过同一道闸
  const res = entry.surface === 'vm'
    ? await provider.execute({ ... })
    : await upstreamCall(entry.surface, entry.tool!, params);

  // ④ 审计：两条路径都写链（上游当前零审计）
  await recordAudit(entry, params, res, ctx);
  return res;
}
```

### 4.3 关键纪律

| 纪律             | 理由                                                         |
| -------------- | ---------------------------------------------------------- |
| **审批语义一个字都不改** | owner 明确「先保证位置对」。位置已对（`server.ts:1537` 在 execute 之前），只扩覆盖面 |
| **上游工具也要写审计**  | 当前完全零审计。`desktop_click` 点了什么窗口必须留痕                         |
| **策略默认放行**     | 当前版本黑名单策略。但黑名单必须有初始内容（见 §4.4）                              |

### 4.4 黑名单最小初始值（**需 owner 拍板**）

当前 `CapabilityPolicy` 全字段可选，54 条定义里几乎都未填 ⇒ **「默认放开」实际等于「无防护」**。

| 建议黑名单                                              | 理由                                |
| -------------------------------------------------- | --------------------------------- |
| `browser.meta.eval` 默认拒绝                           | 页内 JS 能绕过所有其他工具的限制，能力面最大          |
| `desktop_launch` 拒绝直启 `cmd`/`powershell`/`regedit` | 否则绕过 `appops.cli.invoke` 的注册表准入枚举 |
| `system.power.control` 的 `shutdown`/`restart`      | 即使 L3 走审批，黑名单也要兜底                 |
| `pathDenylist` 初始值（系统目录）                           | 机制存在但**内容为空**                     |

### 4.5 阶段 3 验收

```bash
# ① 闸门唯一化：上游分支必须调 gateway
grep -c "evaluateScoped\|gateAndExecute" packages/vm-service/src/server.ts
# 期望：>= 2（/mcp 一处 + 上游一处）

# ② 上游执行必须写审计
sed -n '2240,2290p' packages/vm-service/src/server.ts | grep -c "audit"
# 期望：>= 1
```

**阶段 3 通过标准**：①② 全通过。

> ### ⚠ 原「③ 基线转绿」判据已作废（2026-11-24 实证更正）
>
> 本方案原写「阶段 3 做完，基线那 2 个红**应该变绿**…如果还是红，说明统一表没真正生效」。  
> **这个自证设计是错的**，实测推翻：
>
> | 基线红                         | 真实判据                                                                                                                                                              | 阶段 3 会转绿吗                      |
> | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
> | `phase2-snapshot-truth`     | 数的是「全仓 src 里出现 `snapshot` 字样的**文件集** = 白名单」。`mcp-upstream.ts` 有 2 处命中：`:89` 的 `'desktop_snapshot'` **和 `:65` 的注释**                                                | ❌ 不会。搬走白名单常量后，`:65` 注释仍命中 ⇒ 仍红 |
> | `phase3-skill-claims-guard` | `registeredIds()` **从 `definitions.ts` 源码正则提取**，不读统一表。offender 是 `agent_browser_eval.md:37` 的 `response.data.unserializable` —— **上游 vendor 文档里的返回值字段路径**，不是能力 ID | ❌ 不会。加进注册表或统一表都不影响它            |
>
> ⇒ 这两条红**不是**「三面未统一」的证据，而是两个守卫件自身的白名单没跟上。  
> 把它们当阶段 3 的自证点，会导致「做完发现还红 → 误判统一表没生效 → 白折腾」。
>
> **正确处置**（两条独立小修，与阶段 3 解耦，详见 `15-OPTIMIZATION-DIGEST` §4.1）：  
> ① `mcp-upstream.ts` 加进 `WHITELIST`，理由写「同词异物：`desktop_snapshot` 是上游工具名字面量，  
> 非 `audit.snapshot` 策略消费」（白名单已有 9 个同类先例，这是第 10 个）；  
> ② `response.data.unserializable` 加进 `TOKEN_WHITELIST` 的「真实字段路径」类。
>
> 这**不违反** §0.3「不允许为了让门禁变绿而放宽断言」：那条禁的是「把 mcp-upstream 加进豁免名单」  
> 这种**关闭守卫**的做法；而现有白名单机制**本就是为同词异物设计的**，加一条并写清理由属正常维护。  
> 判据：**加白名单 ≠ 关闭守卫** —— 守卫对新增文件仍然有效。


## 5. 阶段 4：provider 降级为 planner（4d）

> **本节是本方案里最容易被误读的一节。** 标题里的「降级」不是「删掉 LLM」，
> 而是**纠正一个抽象层级错配**。读之前先看 §1.0 的三条事实与 §5.1b。

### 5.1 事实依据（改动前必须核对，否则会把路径 2 改死）

| # | 事实 | 源码证据 | 直接推论 |
|---|---|---|---|
| **F-1** | 当前有 **3 个 provider 实现**，都实现 `AgentServiceProvider`（`contracts/src/bridge.ts:825` `execute()` + `:826` `runGoal()`） | `ProviderKind = 'deterministic' \| 'llm-agent' \| 'remote-proxy' \| 'custom'`（`bridge.ts:810`）；`core/src/config/index.ts:175-195` 的 `providers` 三段 | 3 个包共 **702 + 1892 行**，只为支持「可切换的规划能力」 |
| **F-2** | **三份 `execute()` 最终都委托给同一处**，差异**只在 `runGoal`** | `adapter-agent-workbuddy/src/index.ts:577` 的 `runGoal`；`adapter-agent-workbuddy-llm` 的 `runGoal` 走 CLI | `execute()` 被实现了 3 遍，但没有 3 种语义。**这是重复，不是抽象** |
| **F-3** | **V1.4.37 已实测 `remote-proxy` 与 `custom` 零消费** | 阶段 1 已删 `adapter-agent-hermes`（`-1.5d` 实测），`git grep` 两 kind 仅剩类型声明 | 3 → 1 是**回归到真实使用数**，不是激进裁剪 |
| **F-4** | **`llm` 包的 `runGoal` 是把任务交给 VM 内 CLI**，不是自己调 LLM API | `bridge.ts:945` `cliPath = opts.cliPath ?? opts.runtime ?? 'codebuddy'`；`:607-616` spawn；`:134` 非交互 `-p/--print` | 它本质是**「把目标翻译成一次 CLI 调用」的规划器**，不该持有 `execute()` |

### 5.1b 链路真意（**owner 2026-11-24 澄清 3 的落点**）

> 原话：**「a2a 的任务是通过 VM 端的 workbuddy 内的 codebuddy-lite native agent 完成的，
> 非直接调用 workbuddy/codebuddy 内配置的 LLM 完成任务」**

这句话直接决定了阶段 4 的**边界**：

| 常被误以为 | 实际 | 对阶段 4 的含义 |
|---|---|---|
| 路径 2 = 宿主/VM 配置里那个 LLM API 做一次性规划，然后宿主按计划下发 | ❌ 路径 2 = **整段任务交给 VM 内的 native agent（`codebuddy` CLI）**，它有自主多轮循环、自己拆步、自己调工具 | **必须保留 CLI**，`bridge.ts`(1892) / `persistent-session.ts`(1144) **一行不动** |
| 阶段 4 要「把 LLM 换掉」 | ❌ 阶段 4 只是**把 CLI 从「provider 三选一」挪到「planner 实现」** | 改的是**外壳的接口**，不是内核的执行方式 |
| 委派时宿主得一步步告诉 CLI 干什么 | ❌ CLI 自己回连 `127.0.0.1:18443` 的 MCP 拿工具（`bridge.ts:260` `buildMcpConfig()` 注入 `mcpServers.winvm`） | 阶段 4 **绝不能**把工具调用改回「宿主中转」——那会毁掉路径 2 的效率优势（见 §1.2「有效」） |
| 委派 = LLM 规划 | ❌ 「规划」只是 CLI 内部的一个环节。委派的价值是**VM 内闭环、不逐步往返** | `Planner` 接口只描述「怎么把 `GoalRequest` 变成 `GoalResult`」，**不描述**怎么执行 |

**一句话**：阶段 4 让 CLI **用回它本来就有的全部能力**（作为 agent），
而不是削掉它的能力去冒充一个执行器。

### 5.2 改法（三层，逐层可验证）

#### 5.2.1 新增 `Planner` 契约

```ts
// packages/contracts/src/planner.ts（新增）
import type { GoalRequest, GoalResult, ProgressSink } from './bridge.js';

/**
 * 「怎么把一个开放目标变成结果」的策略接口。
 *
 * 与 AgentServiceProvider 的分工：
 *   - execute()  属于「执行确定动作」——**安全语义**，全系统只应有一种实现（恒确定性）
 *   - plan()     属于「规划开放任务」——**策略问题**，允许多种实现（模板 / native agent）
 *
 * 之所以拆开：原设计把两者塞进同一个 provider 接口，导致
 * 「换规划策略」不得不连执行语义一起换，3 个包各写一遍相同的 execute()。
 */
export interface Planner {
  /** `template` = 确定性模板；`cli-agent` = VM 内 native agent（codebuddy CLI） */
  readonly id: 'template' | 'cli-agent';
  plan(goal: GoalRequest, sink: ProgressSink): Promise<GoalResult>;
}
```

> **`id` 的两值命名说明**：`'cli-agent'` 而非 `'llm'` —— 因为 `llm` 会被读成
> 「调 LLM API」，与 §5.1b 的事实相反。**名字本身就是防误读的文档**。
> （`14-EXECUTION-PLAN` 的 Step 4.1 写作 `'template' | 'llm'`，以本节为准修正为 `'cli-agent'`。）

#### 5.2.2 `deterministic` 的 `runGoal` 抽成 `TemplatePlanner`

`adapter-agent-workbuddy/src/index.ts:577` 的 `runGoal` 逻辑整体搬到新类，
`DeterministicAgentProvider.runGoal` 变成 `this.planner.plan(goal, sink)`。
**行为零变化**（这是纯搬移，用现有单测证明）。

#### 5.2.3 `llm` 包的 `runGoal` 改成 `CliAgentPlanner`

`adapter-agent-workbuddy-llm` **不再实现 `AgentServiceProvider`**，改实现 `Planner`：

```
桥接层（不动）              外壳层（改）                  契约层（新增）
─────────────────────────────────────────────────────────────────────
bridge.ts (1892)      ┐
persistent-session    ├─→  CliAgentPlanner.plan()
  .ts (1144)          ┘         │
buildMcpConfig()                └─ 实现 Planner（id='cli-agent'）
                                ✗ 不再实现 AgentServiceProvider
                                ✗ 不再有 execute()
```

**关键**：`bridge.ts` 与 `persistent-session.ts` 内部一行不改，
只在外面套一层 `plan()` 把 `GoalRequest` 转成 CLI 入参、把 CLI 输出转成 `GoalResult`。

#### 5.2.4 配置面收敛

| 前 | 后 |
|---|---|
| `agent: { provider: 'workbuddy-deterministic', providers: { 'workbuddy-deterministic': {...}, 'workbuddy': {...} } }` | `agent: { planner: 'template' \| 'cli-agent' }` |
| `core/src/bridge/loader.ts`（111 行动态加载器） | **删除**（改为静态二选一） |
| `server.ts:717,744` 的 `provider.id/kind` 分支 | 收敛为一次 `planner` 查表 |

### 5.3 保留理由（**为什么不是「删 LLM」**）

| 反对意见 | 回应 |
|---|---|
| 「既然 provider 3→1，那 `llm` 包也可以删」 | ❌ **不能删**。`llm` 包是**路径 2 的唯一入口**（§5.1b F-4）。删了 = A2A 委派失去执行主体，复杂任务能力归零 |
| 「`Planner` 只是给 3 个包换个名字，没简化」 | ❌ 简化在**语义层**：`execute()` 从 3 份变 1 份（安全语义唯一化）；`runGoal` 从「混在 provider 里」变成「可独立替换的策略」。**行数不会大幅减少**（见验收 ④），减的是**概念数** |
| 「阶段 4 能不能和阶段 3 并行」 | ⚠ **不能**。闸门要先覆盖所有执行路径（含上游 58 项），再动 provider 外壳；否则 provider 改完闸还得重改（§1.3 顺序表） |

**阶段 4 与 3.6a / 3.6b 的关系**

| 子步 | 与阶段 4 的关系 |
|---|---|
| **3.6a（技能面）** | **无依赖**，可早于阶段 4 任意时点。但它决定「CLI 有多少说明书」，间接决定 `CliAgentPlanner` 的效果 |
| **3.6b（工具面）** | **正是阶段 4 的前提之一**。`CliAgentPlanner` 的规划质量取决于 CLI 能看到多少工具：只有 54 项时，浏览器/桌面任务只能退回「写脚本 + `appops.cli.invoke`」；有 112 项后才谈得上「按工具规划」。**先 3.6b 再阶段 4，规划质量才可评** |

**保留的另一个理由（安全性）**：`CliAgentPlanner` **不持有 `execute()`** ⇒ 它
**在结构上无法绕过闸门**。这是「provider 降级」附带的最大收益 ——
把「可能绕过策略」的接口从 CLI 那侧直接摘掉，比在运行时加判断更可靠。

### 5.4 验收（五条，第 ③④⑤ 是本阶段独有的反向断言）

```bash
# ① 契约存在且 id 命名正确
grep -c "interface Planner" packages/contracts/src/planner.ts
grep -c "'cli-agent'" packages/contracts/src/planner.ts
# 期望：各 >= 1（id 用 'cli-agent' 而非 'llm'，见 §5.2.1）

# ② llm 包不再实现 provider（只保留 planner）
grep -c "AgentServiceProvider" packages/adapter-agent-workbuddy-llm/src/index.ts
# 期望：0
grep -c "implements Planner\|LlmPlanner\|CliAgentPlanner" packages/adapter-agent-workbuddy-llm/src/index.ts
# 期望：>= 1

# ③ ★ CLI 链路仍活着（防「降级」被做成「删除」）
wc -l packages/adapter-agent-workbuddy-llm/src/bridge.ts \
      packages/adapter-agent-workbuddy-llm/src/persistent-session.ts
# 期望：1892 / 1144（与阶段 4 之前**逐字相同**，行数不得减少）
grep -c "cliPath" packages/adapter-agent-workbuddy-llm/src/bridge.ts
# 期望：>= 1（spawn 入口仍在）
grep -c "buildMcpConfig" packages/adapter-agent-workbuddy-llm/src/bridge.ts
# 期望：>= 1（★ 若 3.6b 已做，这里必须是 3 条目的版本）

# ④ ★ 行数不减少 —— 显式反向断言（防「为了好看而删代码」）
node --input-type=module -e "
import fs from 'node:fs';
const f='packages/adapter-agent-workbuddy-llm/src/bridge.ts';
const n=fs.readFileSync(f,'utf8').split('\n').length;
console.log('bridge.ts lines =',n);
if(n<1892) process.exit(1);   // 只许增（3.6b 会增几行），不许减
"
# 期望：>= 1892

# ⑤ ★ 两条 skill 通道与工具面都还在（3.6a / 3.6b 的成果没被阶段 4 破坏）
node --input-type=module -e "
import fs from 'node:fs';
// skillsRoot 仍配置且指向 VM 内共享目录
const c=fs.readFileSync('packages/core/src/config/index.ts','utf8');
if(!c.includes('C:/WinVMBridge/shared-skills')) process.exit(1);
console.log('skillsRoot OK');
"
node --input-type=module -e "
const m=await import('./delivery/deploy-shared-skills.mjs');
const repo=(await import('node:fs')).readdirSync('skills',{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>e.name);
const toVm=repo.filter(s=>!m.HOST_ONLY_SKILLS.includes(s));
console.log('VM skills =',toVm.length);
if(toVm.length!==9) process.exit(1);
"
# 期望：skillsRoot OK / VM skills = 9

# ⑥ 门禁与配置面
node scripts/gate.mjs --quick 2>&1 | grep -E "^VERDICT|^FILES"
grep -c "providers:" packages/core/src/config/index.ts
# 期望：门禁**失败清单与阶段 3 收口时逐条相同**（不是"绿了就行"，见 §4.5）；
#      providers: == 0
```

> **为什么 ③④ 是「反向断言」**：本阶段名字叫「降级」，最危险的失败模式不是
> 「没降成」，而是**「降成了删除」**——把 CLI 链路当成"多余的 provider"顺手删掉。
> 而删掉之后 **所有单测都可能仍然绿**（因为没人测「A2A 委派真的能干活」）。
> 所以必须用**行数与关键符号存在性**把这条链路钉住。
>
> 这与 §0.3 的基线纪律同源：**门禁绿不等于能力在**。

---

## 6. 阶段 5：部署解耦（3d）

### 6.1 核心动作（只有一件有实质价值）

**抽 `connect-channel.mjs`**（约 150 行），把通道相关逻辑从 `install-host.mjs` 剥离：

| 迁出内容            | 现位置                                               |
| --------------- | ------------------------------------------------- |
| 私钥探测            | `install-host.mjs:275-292` `probeDefaultSshKey()` |
| 写 vm-conn.json  | `:1393` 调 `:1634 writeVmConnConfig()`             |
| ssh2 vendoring  | `:452-511`                                        |
| 起 daemon + 三段取证 | `tunnel-daemon.mjs` + `setup.mjs` TEST/HEALTH 段   |

**收益**：`install-host.mjs` 1655 → ~1350 行，且**不再写通道配置**。  
消灭当前最严重的错位：**装 host 不该改通道配置**。

### 6.2 阶段 5 验收

```bash
# ① 新脚本存在且 host 安装不再写 vm-conn
grep -c "writeVmConnConfig" delivery/install-host.mjs
# 期望：0（迁走了）

# ② host 安装不建 SSH 连接（保持现状）
grep -cE "new Client|\.connect\(" delivery/install-host.mjs
# 期望：0

# ③ 通道脚本不知道能力/策略
grep -ciE "capability|policy|approval" delivery/connect-channel.mjs
# 期望：0
```

---

## 7. 阶段 6：验证（2d）

### 7.1 三关（不可跳）

```
第一关  静态门禁    node scripts/gate.mjs --quick        期望 GREEN
第二关  全量 sweep  node scripts/gate.mjs                期望 GREEN（25-30 分钟）
第三关  自检        bash scripts/selfcheck.sh            期望 ALL_GREEN
```

### 7.2 真机验证（需 owner 提供 VM 访问）

```
DEPLOY=PASS   /  VERIFY=PASS  /  探针 112 项全通
```

### 7.3 复现脚本

```bash
node docs/design/proj-arch-review/verify-claims.mjs
```

---

## 8. 方案风险与对策

| 风险                                       | 概率 | 对策                                                    |
| ---------------------------------------- | -- | ----------------------------------------------------- |
| 阶段 3 改 gate 引发既有 322 个测试回归               | 中  | 审批语义一个字不改，只加旁路；每步跑 gate --quick                       |
| 阶段 2 的 58 项 risk 分级不准                    | 中（**已消解**）  | **两面 58 项均已落地实测**：desktop 25 项 = 8 L0 / 17 L1 / 0 L2；browser 33 项 = **14 L0 / 18 L1 / 1 L2**（`eval`），判据见 §3.4。风险已由加载期校验兜住（条数/id 唯一/tool 唯一），且有突变反证 4 抓 4。分级错了不会导致故障，只会导致多一次审批或少一次审批——**少的那次才是真风险**，故宁可标高 |
| 阶段 4 改造 702 行 index.ts 破坏 warmup/session | 中  | bridge.ts/persistent-session.ts **不动**，只改 provider 外壳 |
| 真机不可用导致阶段 6 无法完成                         | 中  | 前 5 阶段全部可静态验收；真机验证单列为「待外部条件」                          |
| 工期超预期                                    | 高  | 已定义压缩路径（§1.4），最坏只做阶段 1+3                              |

---

## 9. 本方案不解决的问题（诚实登记）

1. `adapter-agent-workbuddy-llm/src/bridge.ts`（1892 行）的逐分支复审 —— 本次只做结构级
2. `app.ps1`（1209 行）的逐函数核验
3. 对外契约（`/health` 9 区块、112 个工具）的版本化策略
4. 真机端到端自动化闭环（当前靠人工记录）
5. `publish-release.mjs` 双源发布流程

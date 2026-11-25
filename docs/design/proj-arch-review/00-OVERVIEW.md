# WinVM Bridge · 架构复审（以真实实现为准）

> 复审对象：`workbuddy-virtual-win-plugin` @ `e19e599`（V1.4.37 / 主仓 HEAD）
> 复审日期：2026-11-23
> 复审方法：**逐文件读源码 + 机检**，不以 `docs/02-design/` 的设计意图为据。
> 判据纪律：本目录每条结论都附 `文件:行号` 或可复现命令；凡与既有设计文档冲突处，**以源码为准并在文中显式标注冲突**。

---

## 0. 为什么需要这份复审

`docs/02-design/ARCHITECTURE.md`（30 KB，2026-10-26）描述的是**设计时的架构**。此后近一个月里，代码在 12 个包、约 2.8 万行 TS 上持续演进，设计文档只被局部补丁式追加（`MCP-UPSTREAM.md` 等到 11-17 才补）。

结果是一批**设计文档说得通、实现已经偏离**的地方。举三个本次实测确认的例子：

| 设计文档的说法 | 源码实际 | 差在哪 |
|---|---|---|
| `core` 的 `transport/ssh-tunnel` 是 SSH 隧道的实现 | 交付链上**零生产调用点**，真实隧道在 `delivery/oh-tunnel.mjs` | 一处是 TS 类库，一处是 .mjs 常驻 daemon，两套并存 |
| L2 适配器 `adapter-host-workbuddy` 产出"6 skills" | 实为 **10 个** skill 目录 | 文档数字停留在旧版本 |
| skills 的 `domains: [appops]` 表达领域归属 | `VALID_DOMAINS` 只含 4 值，`appops`/`meta` 被**静默丢弃**；且 `domains` 无任何消费点 | 字段写了、丢了、也没人用 |

这不是文档写得差，而是**文档与代码之间没有机检锚点**——`scripts/dep-lint.mjs` 只校验包级依赖方向，校验不了"某个导出是否真被调用"。

---

## 1. 复审范围与方法

### 1.1 覆盖的三层

```
┌────────────────────────────────────────────────────────────────┐
│  A. 宿主插件端（HarmonyOS WorkBuddy）                            │
│     adapter-host-workbuddy + host-sdk + 10 skills + delivery/*  │
├────────────────────────────────────────────────────────────────┤
│  B. 传输与桥接层                                                 │
│     SSH 隧道 / streamableHttp / stdio；host-a2a-bridge          │
├────────────────────────────────────────────────────────────────┤
│  C. VM 端服务（Win11 @ 172.16.100.2）                            │
│     vm-service（双通道内核）+ vm-capabilities + ps-bridge       │
│     + adapter-agent-*（provider SPI 三实现）                     │
└────────────────────────────────────────────────────────────────┘
```

### 1.2 方法与证据等级

本文所有结论分三级，文中以标记区分：

- **【实证】** 有可复现命令或 `文件:行号`，本次亲自核验过。
- **【机检】** 由仓库自带门禁产出（`dep-lint` / `gate` / `selfcheck`）。
- **【推断】** 从代码结构推出的结论，未做运行时验证，文中会写明推断依据。

已实际执行的机检命令：

```bash
node scripts/dep-lint.mjs        # → 违规 9 条（hard=0 warn=0 info=9），VERDICT: GREEN
```

9 条全部是 `DECLARED_UNUSED`（声明了 `@winvm/*` 依赖但 dist 产物里没有对应 import 语句），**全部为 info 级、无一为 hard**。这条结果本身是本次复审的第一个发现：**分层铁律是绿的，但"绿"只覆盖包级方向，覆盖不了导出级死代码**。

---

## 2. 规模底盘（先看数）

### 2.1 12 个包 / 约 2.8 万行 TS

```
包                            文件  行数     layer 字段             内在依赖（@winvm/*）
contracts                       10   2365    L0-contracts           (零依赖)
core                            20   5277    L1a-core               contracts
mcp-framework                    3    531    L1b-mcp-framework      contracts, core
a2a-framework                    5   1964    L1b-a2a-framework      contracts, core
host-sdk                         3    545    L1c-host-sdk           contracts
vm-capabilities                  3   1294    L2-vm-capabilities     contracts, core
vm-service                      15   7012    L2-vm-service          contracts, core, mcp-fw, a2a-fw,
                                                                     vm-capabilities, adapter-*-wb(+llm)
adapter-host-workbuddy           2   1376    L2-adapter-host        contracts, host-sdk
host-a2a-bridge                  6   1570    L3-host-bridge         contracts, core, mcp-fw, a2a-fw
adapter-agent-workbuddy          1   1371    L2-adapter-agent       contracts, core, vm-capabilities
adapter-agent-workbuddy-llm      5   4338    L2-adapter-agent-llm   contracts, core, vm-capabilities,
                                                                     adapter-agent-workbuddy
adapter-agent-hermes             2    488    L2-adapter-agent-llm   contracts, core, vm-capabilities,
                                                                     adapter-agent-workbuddy(+llm)
```

### 2.2 非 TS 的三块等量体量

这个项目的真实工作量有**一半不在 `packages/` 里**：

| 区块 | 规模 | 说明 |
|---|---|---|
| `packages/vm-capabilities/psmod/*.ps1` | 3522 行 / 6 文件 | Windows 能力真身。`app.ps1` 单文件 1209 行 |
| `delivery/*.mjs` | 16059 行 / 22 文件 | 安装/部署/隧道/发布。`setup.mjs` 1794 行、`install-host.mjs` 1655 行 |
| `skills/` | 10 目录 / 120 文件 | 全 `.md`。但 `agent-browser-skill` 34 件、`agent-desktop-skill` 76 件占 110 件 |
| `scripts/gate.mjs` + `selfcheck` | 五段流水线 | 140 个测试文件（含 `delivery/__tests__` 3 个） |

**关键观察**：`delivery/` 的 16059 行没有类型检查、没有分层约束、没有 dep-lint 覆盖；ST4 虽已纳入 `delivery/__tests__`，但该目录仅 3 个文件。它是**整个仓库最大的低门禁面**。见 `04-FINDINGS.md` F-07。

### 2.3 能力面

**【实证】** 54 个能力，6 个域：

```
meta     = 3     system = 14    app  = 8
storage  = 13    gui    = 11    appops = 5
```

风险分布：`L0=27  L1=19  L2=7  L3=1`

**注意一件事**：L2+L3 只有 8 个能力（约 15%），意味着**审批闸的真实覆盖面是 8 个能力**，其余 46 个走免审批直通。这决定了审批链的设计权重——它只需保证这 8 个不出错，而不是全链路。

---

## 3. 结论摘要（八条）

按影响面排序。详细论证与证据见 `04-FINDINGS.md`。

| # | 结论 | 影响 | 详见 |
|---|---|---|---|
| 1 | **`core/transport/ssh-tunnel*.ts`（690 行）在生产链上是死代码**。真实隧道承载者是 `delivery/oh-tunnel.mjs` + `tunnel-daemon.mjs`（1209 行 .mjs） | 两套隧道实现并存，改一处不生效；新读者必然误判 | F-01 |
| 2 | **`SkillDomain`(4 值) 与 `CapabilityDomain`(6 值) 双轨**：4 个 skill 的 `domains` 受影响（3 个被静默丢为 `undefined`、1 个静默少一项）；且 `domains` **全仓零消费点** | 域模型是纯装饰字段，写了等于没写 | F-02 |
| 3 | **`vm-service/src/server.ts` 单函数 `createService` 占 2185 行**（571→2755），内含装配、路由、审批、健康、上游代理五类职责 | 无法单测、无法局部替换、review 成本极高 | F-03 |
| 4 | **`WorkBuddyRenderer` 的四方法契约被两处绕过**：`~/.workbuddy/mcp.json` 与 `hooks/*` 不走 `plan()` | HostRenderer 不是唯一写盘口，"渲染即可复现"不成立 | F-04 |
| 5 | **`fillApprovalCard()` 生产零调用点**（仅单测）。审批卡填充是**提示词契约**，不是代码保证 | LLM 不照做就退化为纯文本，无代码兜底 | F-05 |
| 6 | **直调通道命中 L2/L3 不产生 approvalId**，收口 `DELEGATION_REQUIRED` ⇒ 审批只能走 A2A | 单通道用户遇高危能力被硬导向委派，MCP 续跑令牌成遗留支路 | F-06 |
| 7 | **`delivery/` 16059 行几乎无门禁**：无类型检查、无 dep-lint，ST4 虽有 `delivery/__tests__` 但仅 3 个文件；且与 `packages/` 存在同名职责双实现（安装、隧道、发布） | 无门禁面恰好是最容易漂移的面 | F-07 |
| 8 | **域内文件超长已成系统性**：`server.ts` 2839、`bridge.ts` 1892、`tools.ts` 1031、`setup.mjs` 1794、`app.ps1` 1209 | 单点理解成本超过一个工作日的阈值 | F-08 |

---

## 4. 文档导航

| 文件 | 内容 |
|---|---|
| `00-OVERVIEW.md` | 本文件：范围、方法、规模、结论摘要 |
| `01-HOST-PLUGIN.md` | 宿主插件端结构构成：产物 6 类、Renderer 四方法、两通道 mcp.json、10 个 skill、hooks 自启动 |
| `02-VM-SERVICE.md` | VM 端逻辑架构：`createService` 装配顺序、7 个 HTTP 端点、双通道共用内核、策略/审批/审计三链、ps-bridge 帧协议、stdio 上游代理 |
| `03-MODULES.md` | 12 个包逐个技术架构：职责、导出面、依赖方向、关键实现选择 |
| `04-FINDINGS.md` | 14 条问题清单（F-01~F-14），每条含证据、影响、优化建议、优先级 |
| `05-OPTIMIZATION-PLAN.md` | 优化路线：按"先止血 / 再收口 / 后重构"三批，含每批的验收判据 |
| `verify-claims.mjs` | **证据复现脚本（只读）**。把本文档的关键结论变成可复现输出，任何人跑一次即可验证 |

阅读顺序建议：只想看问题 → `04`；想理解现状 → `01`+`02`；要动手改 → `05`。

### 4.1 先跑一次复现脚本

```bash
node docs/design/proj-arch-review/verify-claims.mjs
```

**当前产出（2026-11-23）：`DRIFT_DETECTED 16/17`**

16 条 PASS = 文档所述与代码一致。唯一的 FAIL 是 **F-09（文档数字漂移 5 处）**——这是**刻意保留的基线值**：本次复审的职责是"报告漂移"，不是"顺手修掉"。修它属于 `05-OPTIMIZATION-PLAN.md` 第一批 A-4 的工作。

**这个脚本的价值**：文档会腐坏，但脚本不会。任何人（包括未来的 agent）跑一次就知道这份复审哪些还有效、哪些已过期。**不要修改它的断言去迁就代码**——FAIL 是信号，不是 bug。

---

## 5. 复审本身的局限（必读）

诚实登记，避免这份文档被当作"覆盖全部"的凭证：

1. **未做运行时验证**。本次全部结论来自源码静态阅读 + 现有门禁。`/health`、双通道、审批闭环的运行时行为沿用 `qa/real-test-2026-11-20-v1437.md` 的记录（探针 34/34、health=200），未在本轮重跑真机。
2. **`adapter-agent-workbuddy-llm/bridge.ts`（1892 行）只做了结构级阅读**，未逐分支核验。涉及 LLM 会话、审批注入、K6 折叠的部分引自代码注释与既有设计文档，未独立反证。
3. **PowerShell 侧 3522 行只读了 `ps-bridge.ps1` 的协议头**（帧格式、编码纪律、Session 要求）。5 个域模块（system/app/storage/gui/appops）的能力实现细节未逐函数核验。
4. **`delivery/` 只精读了 `install-host.mjs` 的主要装配段与 `tunnel-daemon.mjs` / `hooks`**。`setup.mjs`(1794) / `winvm-plugin.mjs`(1470) / `uninstall.mjs`(1274) / `bootstrap.mjs`(1112) 只读了头部职责声明。
5. **本目录不替代 `docs/02-design/`**。它是对设计文档的**增量校正**：凡冲突处文中显式标出，最终应把校正结论回灌进 `02-design`，而不是让两份文档长期并存。

---

## 6. 一句话总结

**架构的分层骨架是健康的**（L0 零依赖真做到了、dep-lint 机检 hard=0、双通道确实共用同一内核），**问题集中在"边界守住了但实现没收口"**：同一职责存在两套实现（隧道、安装、发布）、契约字段写了没人消费（`domains`）、关键接线靠提示词而非代码（审批卡填充）、以及一个 2185 行的装配函数把五类职责压在一处。

这些都不是设计错误，是**演进过程中缺少"收口"动作**的必然结果。`05-OPTIMIZATION-PLAN.md` 给出的路线正是围绕"收口"而非"重设计"。
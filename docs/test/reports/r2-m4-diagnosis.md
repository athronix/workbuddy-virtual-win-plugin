# R2 补完 · M4 工具面不注入根因诊断报告

> 模式：**只读诊断（零代码/配置改动）** · 仓库 HEAD `1ca91f2`
> 执行人：software-engineer（Alex）· 时间边界：纯诊断 ≤60 分钟
> 入口任务：R2 补完 M4 根因诊断（唯一实测轮 R19 记录「新会话工具面无 `winvm__*`/`a2a.*` 工具；自定义连接器页显示 winvm / winvm-a2a 已连接」）
> 红线遵守：未改 `~/.workbuddy/mcp.json`、未改 `delivery/*`、未碰 VM、未改任何源码；仅 `readFileSync` 探测 + 跑只读诊断工具。

---

## 0. 一句话结论（给主理人）

**M4 FAIL 的真实根因不是「R17 没承诺自动注入」，而是 R17 装好的「双处注册」里、会话工具面真正消费的「活跃账户级 mcp.json」漏写了 winvm 条目**——连接器页读的是全局 `~/.workbuddy/mcp.json`（有条目 → 显示「已连接」），而会话工具面读的是活跃账户 `connectors/<activeAccount>/mcp.json`（**无 `connector:winvm`/`connector:winvm-a2a` → 零工具）**。

- 这与项目自有诊断矩阵 `docs/design/r17-connector-injection-diagnosis.md` 的 **M5** 条目（仅部分账户就位 → 切到无条目账户 → ✗）**完全吻合**，属**仓库侧可修**缺陷，不是平台缺陷。
- 头号根因假设 **H1（账户级注册缺口 / M5）** 证据最强、可仓库修复；次因 **H_a（信任+启用门控）** 与 **H_b（工具名 `__`/`.` 特殊字符过滤）** 为平台侧可能性（证据弱）；**H_c（懒加载）** 可能性最低。
- **R17 口径核查**：R17 **确实承诺了**「新会话自动注入工具面」（PRD R2-2 验收标准明文），只是其实现机制（双处注册）从未在真机验证（M4 BLOCKED），且本次失败证明该机制**对活跃账户覆盖不全**——属实现/验证缺口，非范围缺口。

---

## ① 仓库 mcp.json 写入逻辑摘要（文件 + 函数 + 关键字段）

**写入方唯一性确认**：`grep mcp.json|mcpServers|renderConnectorEntry|enabled|exposeTools|tools` 对 `delivery/winvm-plugin.mjs` → **零命中**，证明**只有 `delivery/install-host.mjs` 写 mcp.json**（`winvm-plugin.mjs` 只管隧道/health/command，不管连接器注册）。

### 1a. 账户级 mcp.json（会话工具面实际消费层）

| 项 | 内容 |
|---|---|
| 文件 | `delivery/install-host.mjs` → 调用 `WorkBuddyRenderer`（包 `@winvm/adapter-host-workbuddy`） |
| 核心函数 | `renderer.plan(plugin, ctx)` 产出 `jsonPatches`；`renderer.install(plan, ctx)` 经 `setAtPointer` 增量合并写盘（`packages/adapter-host-workbuddy/src/index.ts`） |
| 写入指针 | `/mcpServers/connector:${plugin.connector.id}` 与 `/mcpServers/connector:${bridge.id}` |
| 落点 | `connectors/<accountId>/mcp.json`（`resolveWorkBuddyPaths`，accountId 来自 `resolveAccountIds`） |
| 条目构造 | `renderConnectorEntry(connector, transport)`（`adapter-host-workbuddy/src/index.ts:105`） |

`renderConnectorEntry` 产出结构（**关键：无 `enabled`、无 `exposeTools`/`tools` 开关**）：

```
base = { timeout: <ms>, disabled: false }            // 仅 disabled:false，无 enabled:true
+ disabledTools: [...]                                // 仅当高危工具非空
ssh-tunnel  → { type:'streamableHttp', url:'http://127.0.0.1:<localPort>/mcp' }
stdio       → { type:'stdio', command:<node>, args:[...], runtime:{type:'node',version:'>=18'} }
```

### 1b. 全局 mcp.json（连接器页可见层）

| 项 | 内容 |
|---|---|
| 文件/行 | `delivery/install-host.mjs` ～L1012–1046「Q-connector-page」块 |
| server 名 | `winvm` 与 `winvm-a2a`（**无 `connector:` 前缀**，与账户级 `connector:winvm` 不同名） |
| 内容 | 同样由 `renderConnectorEntry` 构造（同 1a 结构） |
| 合并 | 读全局 mcp.json → 增量合并 `mcpServers[winvm]/[winvm-a2a]` → 写前 `backupFile` 备份 |

> 该块注释（L1012–1016）原话：「仅写 `connectors/<account>/mcp.json` 时该页面看不到 winvm / winvm-a2a，**会话工具面也不会注入 a2a.\* 工具**……故同样增量合并全局」。
> **→ 这是 R17 的关键误判点**：注释假定「全局注册会驱动会话工具面注入」；但本次真机实测（全局已就位、页已连接、会话仍零工具）恰恰证伪了该假定——会话工具面消费的是**活跃账户级**文件，而非全局文件。

### 1c. 账户解析（决定写哪些账户目录）

`delivery/account-resolve.mjs`：
- `KNOWN_ACTIVE_ACCOUNT = '8dd0df6a-47ce-4a02-82fd-51cd84a8f0f8'`（**正是本机缺失条目的那个活跃账户**）
- `resolveAccountIds(hostRoot, override)` → `[KNOWN_ACTIVE_ACCOUNT, ...connectors/ 下所有子目录]`，去重。

> 含义：安装器**逻辑上应当**把 `connector:winvm`/`connector:winvm-a2a` 写进该 UUID 账户。当前该账户缺条目，说明**上次安装时未落到该活跃账户**（最可能：上次安装时该 UUID 账户尚未成为活跃账户 / 当时 `KNOWN_ACTIVE_ACCOUNT` 未定为此值 / 或仅做了全局注册就停手）。

---

## ② 本机实际配置（脱敏）

> 脱敏：`<HOME>`=`/storage/Users/currentUser`；`<NODE>`=bundled node 绝对路径；`<CACHE>`=`<HOME>/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0`。

### 2a. 全局 `~/.workbuddy/mcp.json`（连接器页读取 → 显示「已连接」）

```jsonc
{
  "mcpServers": {
    "winvm":      { "timeout":120000, "disabled":false,
                    "disabledTools":[ "system.service.configure", "system.process.terminate",
                                      "system.registry.write", "system.power.control",
                                      "app.winget.uninstall", "storage.file.delete",
                                      "storage.link.manage", "appops.gui.produce" ],
                    "type":"streamableHttp", "url":"http://127.0.0.1:18443/mcp" },
    "winvm-a2a": { "timeout":600000, "disabled":false,
                    "type":"stdio",
                    "command":"<NODE>",
                    "args":[ "<CACHE>/a2a-bridge/cli.js", "--endpoint","http://127.0.0.1:18443",
                             "--timeout","600000" ],
                    "runtime":{ "type":"node", "version":">=18" } }
  }
}
```
→ **结构完整、字段齐全**（含 `disabled:false`、正确 `type`/`url`/`command`），但**没有 `enabled` 字段、没有 `exposeTools`/`tools` 显式开关**。

### 2b. 活跃账户 `connectors/8dd0df6a-…/mcp.json`（会话工具面读取 → 零工具）

- 文件存在，含约 200 个其它连接器条目（tencent/qq/baidu 等），**全部 `disabled:true`**（即「已注册但未启用」是平台常态模型）。
- **关键：整个文件内检索不到任何 `connector:winvm`、`connector:winvm-a2a`、`winvm` 相关键——winvm 在该账户级 mcp.json 中完全未注册。**

### 2c. 对照：其它账户

- `connectors/default/mcp.json`：含 `connector:winvm` + `connector:winvm-a2a`（结构同 2a，前缀 `connector:`）。
- `connectors/skills/mcp.json`：同样含 `connector:winvm` + `connector:winvm-a2a`。
- 即：**全局 + default + skills 都有；唯独活跃 UUID 账户缺**。这与诊断矩阵 M5 的「uuid 账户缺失即此形态」记录一致。

### 2d. `connector-states.v3.json`

- 本机**不存在**（diagnose 报 `state: missing`）。即平台尚未为 winvm 创建 trust/enabled 状态文件。

---

## ③ diagnose 输出要点（`node delivery/tools/diagnose-connectors.mjs --json`）

- **退出码 0 / `ok:true`**（仅校验「注册面」就位；**不校验工具是否真注入会话面**——这是该工具的已知盲区，见 §④ H1 反对证据里的张力）。
- 全局：`winvm`(streamableHttp,url ok)、`winvm-a2a`(stdio,command 存在 mode=755 可执行,cli.js 存在) 均 present、均 `disabled:false`。
- 账户：`default` ✓ / `skills` ✓ 含 `connector:winvm`+`connector:winvm-a2a`；**`8dd0df6a-…` ✗ 无 winvm 条目（WARN，非 FAIL）**。
- states：`connector-states.v3.json` 缺失 → WARN「去连接器页信任+启用」。
- stdio：command 可执行 ✓、桥入口 cli.js 存在 ✓。
- **WARN 摘要**：① 活跃账户无 winvm 条目；② connector-states 缺失。

> 工具自述契约（文件头）：零写入 / 零 spawn / 零网络 / 零解密。实测跑前跑后全局 mcp.json md5 一致，遵守只读红线。

---

## ④ 三个方向根因假设排序（含 支持 / 反对证据 + 验证方法 + 归属）

### H1（头号，强烈推荐）· 活跃账户级 mcp.json 漏写 winvm 条目（= 诊断矩阵 M5）

- **支持证据**
  1. 直接读活跃账户 `connectors/8dd0df6a-…/mcp.json`：约 200 个连接器、**零 winvm 键**（§2b）。
  2. diagnose WARN 明文：「账户 `8dd0df6a-…` 无 winvm 条目」。
  3. 自有矩阵 M5：**「全局两条就位 + 仅部分账户就位 + 已启用 + 新会话（切到无条目账户）→ ✗（该账户增量注册缺失）」**，且注释「本机 9/30 实测：uuid 账户缺失即此形态」——与本次 100% 同构。
  4. `account-resolve.mjs` 的 `KNOWN_ACTIVE_ACCOUNT` 正好等于本机缺失条目那个 UUID → 安装器本应覆盖它，当前缺失即「覆盖缺口」。
  5. 连接器页读全局（有→显示已连接）、会话面读活跃账户（无→零工具），完美解释「连通 ≠ 注入」的表面矛盾。
- **反对证据 / 张力**
  - `install-host.mjs` L1012–1016 注释假定「全局注册会驱动会话面注入」；若此假定成立，全局就位即应注入，与 H1 冲突。
  - **化解**：该假定被本次实测证伪（全局在、页连、会话无），故应采信 M5 框架——会话面消费活跃账户级文件，全局只管页可见性。即 R17 全局注册修的是「页可见」，**没修对「会话注入」那一层**。
- **验证方法（待主理人批准后执行，本诊断未做）**：把 `connector:winvm`/`connector:winvm-a2a` 写进活跃账户 mcp.json（或直接重跑 `node delivery/install-host.mjs`，其 `resolveAccountIds` 已含该 UUID），随后**开一个全新会话** ToolSearch `winvm__*` / `a2a.*`。若命中 → H1 坐实。
- **归属**：**仓库（install / account-resolve 覆盖缺口）· 可修**。

### H_a（次因，平台侧可能性）· 工具注入受独立「信任+启用」门控，页「已连接」≠ 已注入

- **支持证据**
  1. `connector-states.v3.json` 本机缺失（diagnose WARN）——平台 trust/enabled 态文件未建立。
  2. `INSTALL-GUIDE §8.1` 第一步即「连接器页确认**信任+启用**」，且 §8.1 明确「旧会话不热注入属预期」——说明平台以 trust/enabled 过滤工具面。
  3. 本机所有其它账户连接器均为 `disabled:true`（注册≠启用是常态模型），winvm 全局虽 `disabled:false`，但这是在全局文件；活跃账户文件里 winvm 压根不存在，门控无从谈起。
  4. 主理人原话「连接器连通 ≠ 工具进会话工具面」正描述「连通态」与「注入门控」解耦。
- **反对证据**
  - 页显示「已连接」通常意味已启用+可达，而非仅注册；若仅注册未启用，页应显示禁用而非已连接 → 用户看到的「已连接」可能已含启用态，则门控非主因。
  - M4 矩阵预期「已注册+已启用+新会话 → ✓」，即启用后应当注入；若用户确已启用仍失败，门控非唯一因。
- **验证方法**：在连接器页对 winvm/winvm-a2a 显式「信任+启用」（若尚未），确认 `connector-states.v3.json` 生成，重开新会话 ToolSearch。命中 → H_a（部分）成立。
- **归属**：**平台（trust/enabled 态平台掌控）**；仓库只能以文档/指引缓解（R2-3）。

### H_b（三因，平台侧，证据弱）· tools/list 未被会话面消费：工具名 `__`/`.` 特殊字符被正则过滤 / 协议版本不兼容

- **支持证据**
  1. winvm 工具名形如 `winvm__system_info.get`（双下划线+点），a2a 形如 `a2a.delegate`（点）——若宿主工具面有名称白名单/正则，可能静默丢弃整组工具。
  2. 「零工具」也可解释为 server 一旦广告任一不合规范名即整组被拒。
- **反对证据（较强，故排第三）**
  1. **`type` 取值并非根因**：本机其它连接器大量使用 `streamableHttp`（与 winvm 同值），`streamable-http`/`sse`/`http`/`stdio` 均被平台接受 → 传输层兼容。
  2. 大量既有连接器工具名同样含 `.`/`_`，工作正常 → 无证据表明宿主过滤此类名。
  3. 仓库/文档无任何工具名过滤相关记录。
  4. H1（账户缺条目）对「零工具」更简约地解释全部现象。
- **验证方法**：对比某正常工作连接器的工具名格式；或在受控环境将某 winvm 工具改名去 `__`/`.` 后复测；或查宿主工具面源码是否有名称校验。需平台内部信息，难度高。
- **归属**：**平台（工具名校验策略）**；仓库缓解需改能力 ID 命名约定（耦合协议，代价大）。

### H_c（四因，可能性最低）· 懒加载：工具首次调用后才出现

- **支持**：部分 MCP client 惰性枚举工具。
- **反对**：① MCP 标准于会话初始化即 `tools/list`，「新会话完全看不到」非懒加载特征；② M4 矩阵将「新会话无注入」判为缺陷而非懒加载；③ 远不如 H1 简约。
- **验证方法**：新会话内直接按名调用 `a2a.health`（不经发现）看是否解析。
- **归属**：**平台**。

**排序结论**：**H1 (仓库·可修) ≫ H_a (平台·门控) > H_b (平台·弱证据) > H_c (平台·低可能)**。建议主理人优先按 H1 验证（重跑 install-host 写活跃账户），几乎可一举定论。

---

## ⑤ R17 口径核查结论：R2 是否「未承诺自动注入」？

**答：R17 明确承诺了「新会话自动注入工具面」，并未只承诺「连接器连接 + 信任启用」。但实现机制从未真机验证，且本次失败属「机制对活跃账户覆盖不全」而非「范围缺口」。**

- **承诺侧（有）**：`docs/prd/r17-prd.md` R2-2 验收标准明文——「连续新建 ≥3 个会话，每个会话 ToolSearch 均能命中 `winvm__` 与 `a2a.` 前缀工具并成功调用 `a2a.health`」。R2-1 亦要求「定位新会话不注入的原因」。**R17 把「新会话稳定注入」当交付目标。**
- **机制侧（有缺口）**：`docs/design/r17-design.md` §A1.2 R2 方案按裁定 Q3 仅做「诊断 + 一致性加固 + 文档 + 门禁兜底，**不做平台侧根治**」；其「一致性加固」即「全局 + 各 account 双处注册」，并**依赖平台在注册+启用后自动注入**。而 `docs/test/reports/r17-qa-2026-09-30.md` §7 明确 **M4 真机实测 BLOCKED**（「需 WB 平台会话注入行为，离线仅能证注册面就位」）——即自动注入这一环**从未被真机坐实**。
- **本次结论**：用户实测 = M4 的 BLOCKED 项被首次真机填充，结果 = ✗。根因落在 **H1（活跃账户注册缺口 / M5）**，是 R17 安装器「双处注册」对活跃账户**覆盖不全**的实现/验证缺口，**不是 R17 没承诺自动注入**。换言之：R2 承诺了，R17 装的机制方向对（双处注册）但落点不全（活跃账户漏写），且诊断工具把「部分账户缺条目」只判 WARN（不判 FAIL），让 `ok:true` 蒙混过 QA，埋下 M4 假 PASS。

> 对主理人裁决的提示：不要把 M4 FAIL 当成「R2 需求覆盖缺口需补做注入引导」——**R2 已覆盖，缺的是把活跃账户条目写进去这一执行动作**（仓库可修，见 §⑥）。

---

## ⑥ 最小修复建议（均不改码，供主理人裁决后执行）

> 以下为**方向性改动建议**，本诊断未执行任何写入。落地需走仓库 PR 流程（主理人批准）。

### 仓库侧可修（强烈推荐，直击 H1）

1. **`delivery/account-resolve.mjs` / `delivery/install-host.mjs`：确保活跃账户必含 winvm 条目**
   - 方向：安装循环已遍历 `resolveAccountIds`（含 `KNOWN_ACTIVE_ACCOUNT`），但当前活跃 UUID 账户仍缺条目 → 说明上次安装漏跑/早停。
   - 建议：① 在 `install-host.mjs` 安装末尾**新增断言**——读取活跃账户 `connectors/<activeAccount>/mcp.json`，确认含 `connector:winvm` 与 `connector:winvm-a2a`；缺失则**显式 FAIL 并提示重跑**（而非静默通过）。② 或在 `account-resolve.mjs` 运行时探测「当前真正活跃账户」（不只依赖硬编码 UUID），对其强制写条目。
   - 用户即时补救（临时）：直接 `node delivery/install-host.mjs`（其 `resolveAccountIds` 已含该 UUID）即可补齐——属一次性仓库动作。

2. **`delivery/tools/diagnose-connectors.mjs`：把「活跃/已知账户缺 winvm 条目」从 WARN 升为 FAIL**
   - 当前 `probeAccountMcp` 只要「任一账户有条目」就 `ok:true`（L249–259），导致活跃账户缺条目被放过（M4 假 PASS 根）。
   - 方向：当 `KNOWN_ACTIVE_ACCOUNT`（或探测到的当前活跃账户）的 mcp.json 缺 `connector:winvm`/`connector:winvm-a2a` 时判 FAIL，使 CI/安装自检无法蒙混。

3. **`docs/INSTALL-GUIDE.md` §8.1 + `skills/winvm-orchestrator/SKILL.md` 门禁：澄清「页已连接 ≠ 会话已注入」**
   - 方向：明确告知——连接器页读**全局** mcp.json（决定可见/已连接），会话工具面消费**活跃账户级** `connectors/<account>/mcp.json`（决定注入）；首选修复是**重跑 `install-host.mjs`** 补齐活跃账户条目，而非仅「信任+启用」。
   - 补充：若 diagnose 报「某活跃账户无 winvm 条目」，首选动作=重跑安装器（写活跃账户），而非仅去页上启用。

### 平台侧（若 H_a / H_b 经 §④ 验证成立，推动 WB 修复）

4. 推动 WB：注册后**自动信任+启用**连接器（或提供显式「注入到当前会话」动作），消除「连通≠注入」门控（H_a）。
5. 推动 WB：工具名白名单放行 `__`/`.`（或明确文档化命名约束），避免整组工具被静默丢弃（H_b）。

### 不建议

- 改 `renderConnectorEntry` 的 `type:'streamableHttp'`：本机大量连接器用同值且工作正常，**`type` 非根因**（§④ H_b 反对证据①），勿动。
- 任何绕过会话生命周期的注入 hack / 手写脚本直连：违反 SKILL.md 门禁与 NFR（§A1.2 Q3）。

---

## 附：关键证据索引

| 证据 | 位置 |
|---|---|
| 活跃账户 mcp.json 零 winvm 键 | 实测读取 `connectors/8dd0df6a-…/mcp.json`（§2b） |
| 全局 mcp.json 结构完整 | 实测读取 `~/.workbuddy/mcp.json`（§2a） |
| `renderConnectorEntry` 无 enabled/exposeTools | `packages/adapter-host-workbuddy/src/index.ts:105` |
| 全局注册注释假定驱动会话注入 | `delivery/install-host.mjs:1012-1016` |
| `KNOWN_ACTIVE_ACCOUNT` = 缺失条目的 UUID | `delivery/account-resolve.mjs:18` |
| M5 矩阵（部分账户缺→✗） | `docs/design/r17-connector-injection-diagnosis.md:41,48` |
| R2-2 承诺新会话注入 | `docs/prd/r17-prd.md:64,69` |
| M4 真机 BLOCKED | `docs/test/reports/r17-qa-2026-09-30.md:113` |
| diagnose 仅校验注册面 | `delivery/tools/diagnose-connectors.mjs` 全文 |

〔本诊断全程只读；未改动任何源码/配置/VM；仓库 HEAD `1ca91f2`。〕

---

## 修复记录（R2-M4 H1 修复 · software-engineer-2 · 2026-10-02）

> 主理人已独立核验诊断报告与 commit `d083f41`，H1 确诊 = 活跃账户级 `mcp.json` 漏写 winvm 条目。
> 仓库 HEAD 修复前：`d083f41`。以下分「阶段 A 即时补救（部署动作，不入仓）」与「阶段 B 三处加固（独立 commit）」。

### 阶段 A · 即时补救（部署动作，无仓库 commit）

- 动作：跑 `node delivery/install-host.mjs`（HOST 相位主跑；本次 VM 实际可达，隧道 `tunnel ensure` 成功非致命，未出现相位错误）。
- 验证：`grep -c winvm ~/.workbuddy/connectors/8dd0df6a-47ce-4a02-82fd-51cd84a8f0f8/mcp.json` 由 **0 → 3**（`connector:winvm` + `connector:winvm-a2a` 已写入，第 3 个匹配来自条目内 url 含 `winvm`）。
- 安装日志确认 `已增量合并 : .../connectors/8dd0df6a-47ce-4a02-82fd-51cd84a8f0f8/mcp.json`，且 `连接器自检 : 注册面就位 ✓（exit=0）`。
- **阶段 A 结论：活跃账户补齐成功**。该动作只经 install-host 管道写 `~/.workbuddy`，属 sanctioned 路径；部署副作用均在仓库外（被 .gitignore 覆盖），未入库、未 commit。

### 阶段 B · 三处加固（独立 commit `fix(R2-M4):`）

1. **`delivery/install-host.mjs`** —— 新增 `assertActiveAccountWinvmEntries(home, accountIds, dryRun)`，在 `runConnectorSelfCheck` 之后显式校验：所有目标账户（含 `KNOWN_ACTIVE_ACCOUNT`）的 `connectors/<account>/mcp.json` 必须含 `connector:winvm` 与 `connector:winvm-a2a`（同时兼容未前缀 `winvm`/`winvm-a2a` 形态）；base 名取自全局 `mcp.json` 实际结构（`winvm`/`winvm-a2a`）。缺失或不可解析 → `console.error(...)` + `process.exit(1)` 显式 FAIL；`--dry-run` 下仅报告、不退出。
   - 关键修正：本文件 `readJsonSafe` 失败时返回 `null`、成功时直接返回解析对象（非 `{ok,data}` 形态），断言已按该语义实现（初版误用 `.ok`/`.data` 会导致每次真机安装误判 FAIL，已用 `--dry-run` 捕获并修正）。
2. **`delivery/tools/diagnose-connectors.mjs`** —— `probeAccountMcp` 中「已知活跃账户（`KNOWN_ACTIVE_ACCOUNT`）缺 winvm 条目」的判定由 **WARN 升 FAIL**（其余非活跃账户缺失仍保持 WARN）；新增 `import { KNOWN_ACTIVE_ACCOUNT } from '../account-resolve.mjs'`。使 CI / 安装自检无法再以 `ok:true` 蒙混过 M4（修复「部分账户缺条目却被判 WARN」的假 PASS 根）。
3. **`docs/INSTALL-GUIDE.md` §8.1** —— 新增「关键澄清（R2-M4 H1 修复）」：明确**连接器页显示「已连接」≠ 会话工具面已注入 winvm 工具**（页读全局 mcp.json、会话面读活跃账户级 mcp.json，二者独立）；首选修复=**重跑 `install-host.mjs` 补齐活跃账户条目**而非仅在页上启用；并补校验步骤——重跑后在 WorkBuddy **新开会话**用 ToolSearch 命中 `winvm__*` / `a2a.*`。最小侵入，未重写整节。

### 验证

- `node --check delivery/install-host.mjs` 与 `node --check delivery/tools/diagnose-connectors.mjs`：语法 OK。
- 单元级逻辑校验（临时 fixture + `node --test` 思路）：
  - diagnose WARN→FAIL：A) 已知活跃账户缺失 → FAIL ✓；B) 仅非活跃账户缺失 → 仅 WARN、不破坏 ok ✓；C) 全就位 → 干净 ✓。
  - install-host 断言：`--dry-run` 下读取已补齐的真实账户文件，输出「活跃账户 … 已含 connector:winvm / connector:winvm-a2a ✓」，无错误 FAIL，dry exit=0。
- `node --test tests/unit/account-resolve.test.mjs`：4 pass / 0 fail（import 链未受影响）。
- `tsc -b tsconfig.build.json`：exit=0（仅改 .mjs/.md，无连带破坏）。
- `git status`：仅 `delivery/install-host.mjs` / `delivery/tools/diagnose-connectors.mjs` / `docs/INSTALL-GUIDE.md` / `docs/test/reports/r2-m4-diagnosis.md` 4 个文件改动（另 `.workbuddy/memory/*`、`qa/r19/` 系其它成员既有改动，未纳入本 commit）。

### commit

- hash：`256e9a3f8ce2113870ed579c4c896e83a23fb90c`（独立 commit，前缀 `fix(R2-M4):`；仅 `git add` 上述 3 个源文件 + 本诊断报告，未混入阶段 A 部署副作用）。

### 状态

- **待用户在 WorkBuddy 新开会话验收**：ToolSearch 应能命中 `winvm__*`（如 `winvm__system_info.get`）与 `a2a.*`（如 `a2a.delegate`）。
- 旧会话永不热注入属平台会话生命周期预期，必须用**新**会话核验；若仍缺失，先去连接器页确认 winvm / winvm-a2a 已「信任 + 启用」，再按 §8.1 三步路径与只读诊断处置。

# 宿主插件端结构构成（HarmonyOS WorkBuddy）

> 对应代码：`packages/adapter-host-workbuddy`（1376 行）、`packages/host-sdk`（545 行）、`skills/`（10 目录）、`delivery/install-host.mjs`、`delivery/hooks/`
> 证据等级：本文 §1~§5 全部【实证】，§6 为【推断】

---

## 1. 一句话模型

宿主侧只做一件事：**把一个「宿主中立」的插件描述（`NeutralPlugin`）渲染成 WorkBuddy 磁盘上的 6 类产物**。

```
NeutralPlugin (中立描述)                      磁盘产物 (WorkBuddy 认的格式)
  manifest       ─┐
  skills[]       ─┼─▶  HostRenderer.plan()  ─▶  PlannedFile[] + JsonPatch[]
  connector      ─┤         │                    │            │
  a2aBridge      ─┤         │                    │            └─▶ 增量补丁 mcp.json
  extraConnectors─┘         │                    └─▶ 直接写文件
                            ▼
                      validate() → install()
```

**这个抽象的价值**：换宿主（比如未来接 kmaster / Codex）只需新增一个 `HostRenderer` 实现，`NeutralPlugin` 和 10 个 skill 一个字不改。这是 `packages/contracts/src/host.ts` 里 `HostRenderer` 接口存在的唯一理由。

---

## 2. 六类产物（真实落点）

**【实证】** 落点由 `resolveWorkBuddyPaths()` 决定（`adapter-host-workbuddy/src/index.ts:76-107`）：

| # | 产物 | 落点 | 谁写 | 是否走 Renderer |
|---|---|---|---|---|
| 1 | `plugin.json` | `<hostRoot>/plugins/cache/winvm/<name>/<ver>/.codebuddy-plugin/plugin.json` | `plan()` | ✅ |
| 2 | `marketplace.json` | `<hostRoot>/plugins/marketplaces/winvm/.codebuddy-plugin/marketplace.json` | `plan()` | ✅ |
| 3 | 10 × `SKILL.md` + `references/` + `workflows/` | `<hostRoot>/connectors/skills/connector-winvm/<skill>/` | `plan()` | ✅ |
| 4 | 账户级 `mcp.json`（4 条目） | `<hostRoot>/connectors/<accountId>/mcp.json` | `plan()` → `JsonPatch` | ✅ 增量合并 |
| 5 | **全局** `~/.workbuddy/mcp.json` | `~/.workbuddy/mcp.json` | `install-host.mjs:1288` **手写** | ❌ **绕过** |
| 6 | `hooks/hooks.json` + `session-start.sh` | `<pluginRoot>/hooks/` | `deployWinvmPlugin()` **拷贝** | ❌ **绕过** |

> 第 5、6 类是 F-04 的核心证据。详见 `04-FINDINGS.md`。

### 2.1 为什么会有"全局 mcp.json"这一层

**【实证】** `install-host.mjs:1283-1288` 的注释写得很直白：

```
WorkBuddy「连接器 / 自定义 MCP」页面读取全局 ~/.workbuddy/mcp.json；
仅写 connectors/<account>/mcp.json 时该页面看不到 winvm / winvm-a2a
```

也就是说：**账户级 mcp.json 是运行时真正生效的**（会话工具面消费它），**全局 mcp.json 只影响 UI 展示**。两个文件必须同时写，否则会出现"连接器页显示已连接，但会话里调不到工具"——这正是 `install-host.mjs:1473` 那条 H1 加固断言的由来。

### 2.2 4 个连接器条目

**【实证】** `delivery/install-host.mjs:1180-1237` 组装，`renderConnectorEntry()` 渲染：

| 条目 key | 传输形态 | 指向 | 工具面 |
|---|---|---|---|
| `connector:winvm` | `streamableHttp` | `http://127.0.0.1:<localPort>/mcp` | 54 个能力（点分 ID） |
| `connector:winvm-a2a` | `stdio` | `node <pluginRoot>/a2a-bridge/cli.js --endpoint http://127.0.0.1:<localPort>` | 5 个 `a2a.*` 工具 |
| `connector:winvm-browser` | `streamableHttp` | `http://127.0.0.1:<localPort>/mcp/browser` | agent-browser（33 工具） |
| `connector:winvm-desktop` | `streamableHttp` | `http://127.0.0.1:<localPort>/mcp/desktop` | agent-desktop（白名单 25 工具） |

**关键设计点【实证】**（`renderConnectorEntry` 的 `ssh-tunnel` 分支）：

```ts
case 'ssh-tunnel':
  return {
    ...base,
    type: 'streamableHttp',
    url: `http://127.0.0.1:${transport.localPort}${connector.mcpPath ?? '/mcp'}`,
  };
```

声明是 `ssh-tunnel`，**渲染出来是 `streamableHttp`**。这是刻意为之，注释写明理由：

> SSH 隧道模式采用**本地端口转发**而非 stdio+ssh —— 同一条隧道可同时承载 MCP `/mcp` 与 A2A `/a2a`，纯 stdio 方案做不到。

因此三个 `streamableHttp` 条目**共用同一个 localPort**，只靠 path 区分工具面。一条 SSH 隧道承载 4 个连接器中的 3 个（第 4 个 `winvm-a2a` 是 stdio 桥，它内部再用 HTTP 打 `/a2a`，仍走同一 localPort）。

---

## 3. HostRenderer 四方法契约

**【实证】** `WorkBuddyRenderer`（`adapter-host-workbuddy/src/index.ts:165`）实现 `HostRenderer`：

```
plan(plugin, ctx)      → RenderPlan { files, jsonPatches, postActions, warnings }
validate(plan)         → ValidationReport { ok, issues[] }
install(plan, ctx)     → InstallResult { ok, installedFiles, patchedFiles, skippedFiles }
uninstall(pluginId, ctx) → void
```

### 3.1 `plan()` 的五段（顺序即产物顺序）

```
1. plugin.json   —— 含 hooks: './hooks/hooks.json'（平台权威自启动机制）
2. marketplace.json —— marketplace 'winvm' 下挂本插件
3. skills[]      —— entry skill 排最前；references/workflows 逐个落盘；
                    唯一 entry skill（winvm-orchestrator）额外注入审批卡 HTML 模板
4. jsonPatches[] —— connector + a2aBridge + extraConnectors，逐条 JsonPatch
5. warnings[]    —— 隧道/明文/禁用工具的风险提示
```

**第 3 段的保留名机制【实证】**（`index.ts:245-254`）：skill 源目录里若出现 `references/approval-card.md` 之外的**卡片模板同名文件**会被丢弃并产生 warning，模板由 **Renderer 代码态注入**（`APPROVAL_CARD_WIDGET_HTML` 常量）。这保证"单一时序源"，防止手工副本混进产物。

### 3.2 `validate()` 的三类硬错误

**【实证】**（`index.ts:381-427`）：

1. `.json` 产物必须能被 `JSON.parse`
2. JSON Pointer 必须以 `/` 开头
3. **审批卡模板红线**：`auditApprovalCardTemplate()` 逐条查模板；且渲染产出的卡片 HTML **不得出现 MCP 续跑标记**（`MCP_RESUME_MARKER`）

第 3 条是通道隔离的机检锚点：审批卡只能承载 A2A 的 `a2a.approval.reply` 语义，绝不能出现 MCP 续跑指令（那会把用户引向错误通道）。

### 3.3 `install()` 的两个语义细节

**【实证】**：

- `mode: 'skip-if-exists'` 的文件：先 `readFile` 试读，成功则跳过（保留用户改动）
- `jsonPatches` 走 **`deepMerge` 而非整体覆盖**（`index.ts:483-489`）：先取既有值，对象则深合并，再 `setAtPointer`

后者的意义：用户若手动给 `connector:winvm` 加过 `env` 或 `timeout`，重装不会抹掉。

### 3.4 `uninstall()` 的账户遍历

**【实证】**（`index.ts:504-546`）：不硬编码 `default` 账户，而是 `readdir(connectors)` 遍历所有子目录，排除 `NON_ACCOUNT_DIRS`（`skills` / `marketplace-meta`）后逐账户清理 `mcp.json`。

匹配口径（注释 2026-11-17 扩展）：

```ts
k === `connector:${pluginId}` || k.startsWith(`connector:${pluginId}-`)
```

用 `-` 而非纯前缀，避免误删第三方的 `connector:winvmXXX`。

---

## 4. 10 个 Skill 的真实构成

**【实证】** `skills/` 实为 **10 个目录**（不是设计文档说的 6 个）：

| # | 目录 | files | domains 声明 | entry | 角色 |
|---|---|---|---|---|---|
| 1 | `winvm-orchestrator` | 2 | `[system, app, storage, gui, appops]` | **true** | **唯一总控**，承载审批门禁 |
| 2 | `winvm-system-admin` | 1 | `[system]` | - | 系统管理 |
| 3 | `winvm-app-manager` | 1 | `[app]` | - | 应用管理 |
| 4 | `winvm-storage-manager` | 1 | `[storage]` | - | 存储管理 |
| 5 | `winvm-gui-automation` | 1 | `[gui]` | - | GUI 自动化 |
| 6 | `winvm-app-operation` | 1 | `[appops]` | false | 应用生产操作 |
| 7 | `winvm-mcp-reference` | 2 | `[meta]` | - | MCP 服务部署参考 |
| 8 | `hos-win-skill` | 1 | `[meta]` | - | 鸿蒙↔Windows 分派 |
| 9 | `agent-browser-skill` | 34 | （无） | - | 浏览器自动化（上游 vendor） |
| 10 | `agent-desktop-skill` | 76 | （无） | - | 桌面自动化（上游 vendor） |

### 4.1 数量分布极不均衡

**【实证】** 120 个文件里，**110 个属于第 9、10 号**（上游 vendor 的 skill 文档）。本项目**自己写的只有 10 个 `.md`**：

```
winvm-orchestrator     SKILL.md + references/approval-card.md
winvm-mcp-reference    SKILL.md + references/*.md
其余 6 个             各 1 个 SKILL.md
```

**这意味着**：本项目的 skill 层实质是「1 个总控 + 6 个领域提示词 + 1 份 MCP 参考」，全部是提示词，**零代码**。所有能力执行都在 VM 侧，skill 只负责"告诉宿主 LLM 该调哪个工具、什么情况下要审批"。

### 4.2 `domains` 字段是装饰品

**【实证·三处证据】**：

1. `contracts/src/host.ts:20` —— `SkillDomain = 'system' | 'app' | 'storage' | 'gui'`（**4 值**）
2. `contracts/src/capability.ts:11` —— `CapabilityDomain = 'system'|'app'|'storage'|'gui'|'appops'|'meta'`（**6 值**）
3. `host-sdk/src/skill-loader.ts:128` —— 过滤时丢弃非法值：

```ts
const filtered = d.filter((x): x is SkillDomain => (VALID_DOMAINS as readonly string[]).includes(x));
return filtered.length > 0 ? filtered : undefined;
```

后果：
- `winvm-app-operation` 的 `domains: [appops]` → 过滤后为空 → **`undefined`**
- `winvm-mcp-reference` / `hos-win-skill` 的 `domains: [meta]` → 同样 **`undefined`**
- `winvm-orchestrator` 的 `[system, app, storage, gui, appops]` → 过滤后剩 4 个，**`appops` 静默消失**（这个最隐蔽：`domains` 非空，看起来正常）

⇒ **4 个 skill 受影响**（3 个完全丢失、1 个静默残缺）。

而 `grep -rn "\.domains"` 全仓（排除 dist / test）**只命中 `skill-loader.ts:202` 一处**——那是把 `frontmatter.domains` 赋给 `SkillBundle.domains` 的赋值语句本身，**没有任何读取方**。

结论：`domains` 从声明到消费全程无效。这是 F-02。

### 4.3 审批门禁在 skill 层的落地形态

**【实证】** 唯一 `entry: true` 的 `winvm-orchestrator` 里：

- `SKILL.md` 描述何时直调 MCP、何时 `a2a.delegate`
- `references/approval-card.md` 是**文本降级模板**（`fillApprovalCard` 返回 null 时用它）
- 卡片 HTML 模板由 Renderer 注入为 `references/approval-card.md` 同目录的另一文件

**审批的"门禁"实际是提示词指令**——skill 告诉 LLM「遇到 L2/L3 必须走 A2A 并展示审批卡」。代码层不强制（见 F-05）。

---

## 5. 自启动：hooks 机制

**【实证】** `plugin.json` 顶层声明 `hooks: './hooks/hooks.json'`。

`delivery/hooks/hooks.json`：

```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "sh \"${CODEBUDDY_PLUGIN_ROOT}/hooks/session-start.sh\" </dev/null >/dev/null 2>&1 &",
        "timeout": 5
      }]
    }]
  }
}
```

### 5.1 为什么必须是平台 hooks 而不是自造字段

**【实证】** `plugin.json` 渲染处的注释记了一次真实教训：

> 历史教训：旧实现用自造的 `workbuddy.startup` 字段（command/args），平台**不识别**任何插件清单里的 `startup` 机制（官方清单 Schema 无此字段，平台内置插件亦无一处使用），故 WorkBuddy 重启后自启动不会被触发（实测 D16：14:21 重启后 tunnel.log 无新增）。该字段已删除，不得再放回会被平台解释成「机制」的位置。

### 5.2 `session-start.sh` 的五条硬约束

**【实证】** 脚本头部列出（`delivery/hooks/session-start.sh:8-14`）：

1. **POSIX sh 兼容**——宿主 shell 是 `/bin/sh`，**没有 `/bin/bash`**（已知坑：safe-bin 的 `rm` shim 因缺 bash 退出 126）
2. 绝不阻塞会话——`hooks.json` 用 `... &` 后台异步，脚本自身也尽快返回
3. 幂等——调 `winvm-plugin tunnel ensure`，已运行则秒回 0，不产生第二实例
4. 失败不影响会话——一切错误吞掉，恒 exit 0
5. 不硬编码路径——经 `${CODEBUDDY_PLUGIN_ROOT}` 解析

第 1 条是鸿蒙环境特有约束，值得记入长期记忆。

### 5.3 hooks 文件不走 Renderer

**【实证】** `hooks/*` 由 `deployWinvmPlugin({ extraFiles: [...] })` 复制（`install-host.mjs:1362`），`install-host.mjs:217` 有同名同源的白名单：

```js
for (const rel of ['winvm-plugin.mjs', 'oh-tunnel.mjs', 'ssh2-resolve.mjs',
                   'ssh2-client.mjs', 'ssh2-backend.mjs', 'tunnel-daemon.mjs',
                   'hooks/hooks.json', 'hooks/session-start.sh', 'account-resolve.mjs'])
```

这 9 个文件是**插件运行时依赖**，必须在 `pluginRoot` 下就位。它们不经过 `plan()` ⇒ F-04 的一部分。

---

## 6. 宿主端结构总图

```
~/.workbuddy/                                    （= ctx.hostRoot）
├── plugins/
│   ├── installed_plugins.json                   ← install-host 手写（正式注册，防孤儿）
│   ├── marketplaces/winvm/.codebuddy-plugin/
│   │   └── marketplace.json                     ← Renderer.plan() 产物 ②
│   └── cache/winvm/winvm-bridge/<ver>/
│       ├── .codebuddy-plugin/plugin.json        ← Renderer.plan() 产物 ①
│       ├── hooks/{hooks.json,session-start.sh}  ← deployWinvmPlugin 拷贝（绕过 Renderer）
│       ├── a2a-bridge/                          ← host-a2a-bridge/dist 整体复制
│       │   ├── cli.js
│       │   └── node_modules/（自包含 @winvm 依赖）
│       ├── winvm-plugin.mjs / oh-tunnel.mjs /
│       │   ssh2-*.mjs / tunnel-daemon.mjs       ← 管理命令与隧道（绕过 Renderer）
│       └── account-resolve.mjs
├── connectors/
│   ├── skills/connector-winvm/<10 skill>/        ← Renderer.plan() 产物 ③
│   └── <accountId>/mcp.json                     ← Renderer 增量补丁 ④
└── mcp.json                                     ← install-host 手写（全局 UI 面，绕过 Renderer）

进程态：
  tunnel-daemon（detached，由 hooks 或 install 尾拉起）
    └─ ssh2 本地转发 127.0.0.1:<localPort> → VM 127.0.0.1:<remotePort>
         ├─ /mcp            → vm-service 54 能力
         ├─ /mcp/browser    → stdio 上游 agent-browser
         ├─ /mcp/desktop    → stdio 上游 agent-desktop
         └─ /a2a            → vm-service A2A
```

---

## 7. 宿主端的三条设计优点（应当保留）

避免这份复审只讲问题。以下三点实现质量高于平均水准：

1. **`NeutralPlugin` 抽象是真抽象**：`adapter-host-workbuddy` 只有 1376 行，把宿主格式细节全收在 `renderConnectorEntry` + `plan()` 里，`host-sdk` 的 `validateNeutralPlugin` 不认任何宿主特有字段。加一个宿主是一天的量。

2. **`JsonPatch` 增量合并而非整体覆盖**：`deepMerge` + `setAtPointer`（`index.ts:483`）配合 `uninstall()` 的 `connector:<id>` / `connector:<id>-*` 精确匹配，做到了"只动自己的条目"。这在多插件共享一个 `mcp.json` 的宿主上是必须的，且实现正确。

3. **审批卡模板的单一事实源纪律**：skill 源里同名文件被丢弃 + 代码态注入 + `validate()` 反查残留占位符，三层闭环。这是"文档所有权"和"代码所有权"划清界限的好例子。
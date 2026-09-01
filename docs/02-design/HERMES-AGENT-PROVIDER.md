# Hermes Agent Provider 技术方案

| 项 | 值 |
|---|---|
| 文档ID | TECHNICAL-SOLUTION-HERMES-AGENT-PROVIDER |
| 场景 | **D — 功能新增（FEATURE-ADD）** |
| 版本 | v1.0 |
| 日期 | 2026-09-01 |
| 关联ADR | ADR-13（VM AI Agent 增加 hermes-agent 选型）、ADR-14（共享 Skills 与 symlink 引用） |

---

## 1. 背景与目标

### 1.1 需求
VM 内 AI Agent 目前只有两个选型：`workbuddy-deterministic` 与 `workbuddy`（`codebuddy` CLI）。
本次需新增 **`hermes-agent`**（Nous Research Hermes Agent）作为第三个选型，满足：

- 配置 `agent.provider = 'hermes-agent'`（部署侧经 `WINVM_VM_PROVIDER=hermes-agent`）即可切换；
- VM 端 hermes-agent 承接目标后，经既有 A2A 服务对外提供能力；
- **框架零改动**（延续 ADR-10 的设计承诺）。

### 1.2 附加需求（用户提出）
1. 54 个 Windows 操作能力包装为 **skills**，供 VM AI Agent 参考调用；
2. skills **独立于各候选 Agent 部署**（单一事实源），各候选 Agent 仅通过 **symlink** 引用；
3. skills 内需给出各 mcp-servers 部署管理的参考文档 **`mcps-reference.md`**。

---

## 2. Hermes Agent 技术架构调研结论（实测，非文档照抄）

调研对象（**全程只读，未修改任何文件**）：
- 源码 repo：`D:\Users\towyq\Documents\Projects\hermes-agent`
- 本机部署：`C:\Users\towyq\AppData\Local\hermes\`（`HERMES_HOME`）

### 2.1 运行时事实
```
Hermes Agent v0.18.2 (2026.7.7.2) · Python 3.11.11
可执行文件: %LOCALAPPDATA%\hermes\hermes-agent\venv\Scripts\hermes
HERMES_HOME        = C:\Users\towyq\AppData\Local\hermes
HERMES_CONFIG_PATH = %HERMES_HOME%\config.yaml
Skills 目录        = %HERMES_HOME%\skills          （源码佐证 agent/curator.py: get_hermes_home()/"skills"）
```

### 2.2 CLI 契约（实测 `hermes chat --help`）
```
hermes chat [-q QUERY] [-m MODEL] [-t TOOLSETS] [-s SKILLS] [--provider P]
            [-v] [-Q] [--resume ID] [--continue [NAME]] [--worktree]
            [--accept-hooks] [--checkpoints] [--max-turns N] [--yolo]
            [--pass-session-id] [--ignore-user-config] [--ignore-rules]
            [--safe-mode] [--source SOURCE] [--tui] [--cli] [--dev]
```
关键语义：
- `-q/--query`：单次查询（非交互）；
- `-Q/--quiet`：**程序化模式**，抑制 banner/spinner/工具预览，仅输出最终回复与会话信息 → **可解析**；
- `--yolo`：**跳过所有危险命令审批提示** → 非交互场景**必须**加，否则遇审批会永久挂起；
- `--source SOURCE`：会话来源标签，官方注明"用于不应出现在用户会话列表中的第三方集成" → 本集成专用；
- `--max-turns N`：限制工具调用迭代次数。

### 2.3 MCP 集成机制（★ 与 codebuddy 的核心差异）

`hermes chat` **没有 `--mcp <url>` 参数**。MCP 服务器需**预先注册进配置**，CLI 启动时自动发现连接。

**注册命令（实测 `hermes mcp add --help`）**：
```
hermes mcp add <name> [--url URL] [--command CMD] [--args ...]
               [--auth {oauth,header}] [--preset NAME] [--connect-timeout N] [--env K=V ...]
```

**配置落点**：`%HERMES_HOME%\config.yaml` 顶层 `mcp_servers`（官方 schema `cli-config.yaml.example:1071`）：
```yaml
mcp_servers:
  # stdio 型
  time:
    command: uvx
    args: ["mcp-server-time"]
  # url 型 ← 本项目适用
  notion:
    url: https://mcp.notion.com/mcp
```

**鉴权**（源码 `hermes_cli/mcp_config.py`）：
- url 型支持 Bearer：`server_config["headers"] = {"Authorization": "Bearer ${MCP_<NAME>_API_KEY}"}`；
- token 以环境变量持久化：`MCP_{SERVERNAME大写}_API_KEY`，写入 `%HERMES_HOME%/.env`；
- 源码行 519-533：若该环境变量已存在则直接复用（**不再交互式提示**）→ **可完全自动化**。

**自动加载**（源码 `hermes_cli/mcp_startup.py`）：
`_has_configured_mcp_servers()` 读取 `config.mcp_servers`，非空则启动后台发现线程连接 → 确认 `hermes chat` **自动加载已注册 MCP**。

### 2.4 差异矩阵（决定实现方式）

| 维度 | WorkBuddy `codebuddy` | Hermes `hermes` |
|---|---|---|
| 目标传入 | `--goal` | `-q`（无独立 system-prompt 参数） |
| 系统提示 | `--system-prompt` | 无 → **并入 `-q`** |
| MCP 接入 | `--mcp <endpoint>`（每次调用传） | **无此参数 → 预注册进 config** |
| 产物目录 | `--output <dir>` | 无 → 靠 prompt 约束 + 目录扫描 |
| 审批 | — | 必须 `--yolo`（否则挂起） |
| 输出解析 | stdout 逐行 | `-Q` 仅最终回复 |
| Skills | 无原生 skills 目录约定 | `%HERMES_HOME%/skills/<slug>/SKILL.md` |

### 2.5 结论
- CLI **生成进程**部分：`CliLlmBridge` 的 `cliArgTemplate` **已可表达 hermes 形态**，无需重写；
- 唯一增量：hermes 需要**一次性的 MCP 注册副作用** → 放入 provider `init()`（幂等）。

---

## 3. 设计方案

### 3.1 选型：新包 + 复用（`adapter-agent-hermes`）

新增包 `packages/adapter-agent-hermes`，复用既有资产、零重复：

| 复用 | 来源 | 用途 |
|---|---|---|
| `DeterministicAgentProvider` | `@winvm/adapter-agent-workbuddy` | `execute`/`health`/`shutdown`，复用 ps-bridge 与安全内核 |
| `CliLlmBridge` + `LlmBridge` | `@winvm/adapter-agent-workbuddy-llm` | CLI 生成/进度回传/产物扫描（**与运行时无关**） |
| `loadSkillDocs` | 同上 | 读取 `<root>/<slug>/SKILL.md` |

> 说明：`CliLlmBridge` 本身与运行时无关（仅默认模板/默认 cliPath 是 workbuddy 语义），故依赖它是安全且零重复的。若后续出现第三个 CLI 型 provider，再考虑将其抽到中立包 `packages/agent-cli-bridge`。

### 3.2 HermesMcpRegistrar（幂等注册）

职责：确保 hermes 配置中存在名为 `winvm` 的 url 型 MCP 服务器，且 token 就位。

- 配置路径：`process.env.HERMES_CONFIG_PATH` → 否则 `%HERMES_HOME%/config.yaml` → 否则 `~/.hermes/config.yaml`；
- 注入 `mcp_servers.winvm = { enabled: true, url: <endpoint>, headers: { Authorization: "Bearer ${MCP_WINVM_API_KEY}" } }`；
- token 写入 `%HERMES_HOME%/.env` 的 `MCP_WINVM_API_KEY`；
- **幂等**：已存在且 url 一致则跳过（不覆盖用户手工改动）；url 变更则更新；
- **安全**：写前备份 `config.yaml.bak.<timestamp>`；YAML 采用**最小侵入的行级文本合并**，避免重排/丢失注释（不引入 YAML 解析依赖）；
- **可禁用**：`options.registerMcp === false` 时跳过（用户自行 `hermes mcp add`）；
- 全部失败仅告警，不阻断 provider 启动（降级为"未注册 MCP"，任务仍可执行 hermes 原生能力）。

### 3.3 CLI 参数模板

hermes 无 system-prompt 参数，故把 `buildSystemPrompt()` 产出的整段提示作为 `-q` 传入：

```ts
export const HERMES_CLI_ARG_TEMPLATE: readonly string[] = [
  'chat', '-q', '{prompt}', '-Q', '--yolo', '--source', 'winvm-bridge',
];
```
> `{prompt}` 已含能力目录、技能规范、执行约束与用户目标（见 `buildSystemPrompt`）。
> `--source winvm-bridge` 使这些会话不污染用户会话列表。

### 3.4 共享 Skills 与 symlink 部署（ADR-14）

**单一事实源**（独立于任何 Agent，由 `delivery/deploy-shared-skills.mjs` 从仓库 `skills/` 发布，各 Agent 仅 symlink 引用）：
```
C:/WinVMBridge/shared-skills\     ← 共享根（默认；与仓库 skills/ 区分，避免自拷贝）
  winvm-app-manager/SKILL.md
  winvm-app-operation/SKILL.md
  winvm-gui-automation/SKILL.md
  winvm-orchestrator/SKILL.md
  winvm-storage-manager/SKILL.md
  winvm-system-admin/SKILL.md
  winvm-mcp-reference/SKILL.md    ← 新增：mcp-servers 部署管理参考
  mcps-reference.md               ← 新增：MCP 服务部署/管理参考正文
```

**各候选 Agent 以 symlink 引用**：
| Agent | 原生 skills 目录 | 引用方式 |
|---|---|---|
| WorkBuddy (`codebuddy`) | `%USERPROFILE%\.workbuddy\skills` | symlink 各 skill 目录；另由 `loadSkillDocs` 注入 prompt |
| Hermes Agent | `%HERMES_HOME%\skills` | symlink 各 skill 目录（原生加载） |

**实施要点**（Windows）：
- symlink 必须用**绝对路径**创建，且目录型需 `junction`（`fs.symlink(target, link, 'junction')`），避免管理员权限要求（普通 symlink 在 Windows 需特权）；
- 已存在同名目录且非 symlink → **跳过并告警**，绝不覆盖/删除用户自有技能；
- 已存在且指向本共享源 → 视为已就位（幂等）。

---

## 4. 配置契约

`vm-service.config.json`：
```jsonc
"agent": {
  "provider": "hermes-agent",
  "providers": {
    "hermes-agent": {
      "package": "@winvm/adapter-agent-hermes",
      "options": {
        "runtime": "hermes",
        "cliPath": "hermes",
        "endpoint": "http://127.0.0.1:18443/mcp",
        "mcpServerName": "winvm",
        "registerMcp": true,
        "outputDir": "%USERPROFILE%\\WinVMWorkspace\\out",
        "skillsRoot": "C:/WinVMBridge/shared-skills"
      }
    }
  }
}
```

部署侧：`WINVM_VM_PROVIDER=hermes-agent` → `install-vm.mjs --provider hermes-agent`。

---

## 5. 测试方案

| 层 | 用例 |
|---|---|
| 单元 | `HermesMcpRegistrar`：新注册 / 幂等重复 / url 变更更新 / `registerMcp=false` 跳过 / 写前备份 / 配置缺失时优雅降级 |
| 单元 | `HermesAgentProvider`：注入 mock `LlmBridge`，验证 `runGoal` 透传、`declareCapabilities`、`health` 身份上报、`init` 触发注册 |
| 单元 | CLI 模板渲染：`HERMES_CLI_ARG_TEMPLATE` 含 `chat/-q/-Q/--yolo/--source` |
| 单元 | 共享 skills symlink：幂等 / 非 symlink 冲突跳过 / junction 创建 |
| 回归 | 全量 `node --test`（既有测试不得回归；本变更新增 hermes provider / registrar / 共享 Skills 规划 3 个测试文件，合计 31 用例） |
| 真机 | hermes 已安装 → 可执行 smoke：`hermes --version`、`mcp_servers` 注册后 `hermes mcp list`（**只读验证**） |

---

## 6. 风险与未验证项

| 风险 | 等级 | 处置 |
|---|---|---|
| hermes `config.yaml` 行级合并可能受用户自定义格式影响 | 中 | 最小侵入 + 写前备份 + 失败降级告警 |
| `hermes chat -q` 遇到需审批操作仍可能挂起 | 中 | 默认加 `--yolo`；文档标注安全影响 |
| hermes 产物无 `--output`，依赖 prompt 约束写入 | 中 | prompt 已含输出目录约束 + 既有产物扫描机制 |
| Windows symlink 权限 | 低 | 用 `junction`（目录）无需特权 |
| token 明文写入 `.env` | 中 | 沿用 hermes 官方机制；文件权限沿用既有 |
| **真机未验证**：hermes 端到端 runGoal（需 VM 内 hermes + MCP 联通） | — | 记录为 V1 未验证项，与既有 codebuddy 同类项并列 |

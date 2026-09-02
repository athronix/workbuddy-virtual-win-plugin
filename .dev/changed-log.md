# 变更记录 · changed-log（本次交付）

## 新增（全部为本次实现）
- **调研文档**：`docs/01-investigation/CONTEXT-ANALYSIS.md`
- **设计文档 9 篇**：`docs/02-design/*`（架构/能力模型/3 份规范/接口/安全监管）
- **配套文档 2 篇**：`docs/05-peripherals/{DEPLOYMENT,USER-MANUAL}.md`
- **代码 9 包**：
  - `contracts`（L0 契约）+ `core`（策略/审计/传输/会话/桥接）
  - `mcp-framework` + `a2a-framework`（双协议框架）
  - `host-sdk` + `adapter-host-workbuddy`（宿主解耦 + WorkBuddy 适配）
  - `vm-capabilities`（ps-bridge + 4 PS 模块）+ `adapter-agent-workbuddy`（可替换执行器）
  - `vm-service`（双协议同端口服务端 + CLI）
- **5 个 Skill**：`winvm-orchestrator` + system/app/storage/gui
- **测试**：`tests/unit/*`（4 文件）+ `tests/e2e/smoke.test.js` + `tests/psbridge-smoke.mjs`
- **交付**：`delivery/install-host.mjs`、`delivery/vm-service.config.json`
- **DDD 索引**：`.dev/` 6 文件

## 关键实现决策（沉淀）
1. **maxRisk 语义**：仅当宿主在 A2A 委派请求中显式声明 `maxRisk` 时才做范围封顶；MCP 直调由审批闸管辖，避免 L2/L3 永远无法执行。
2. **路径策略检查边界**：仅对命令类参数（command/cmd/script/expression…）做 token 抽取，普通路径参数整体匹配；避免"命令串被误判为路径"。
3. **PowerShell 5.1 兼容**：剔除 `??`/`?.` 等 PS7 语法；能力模块在脚本作用域**预加载**（函数内 dot-source 返回即失效）。
4. **ESM 路径**：`ps-bridge.ts` 用 `import.meta.url` 派生 `__dirname` 等价路径，避免 `process.cwd()` 解析错误。
5. **宿主配置零覆盖**：`mcp.json` 以 JSON patch 增量写入，不整体覆盖用户已有连接器。

## 测试结果
- 112/112 通过；真实 PowerShell 链路打通。

---

## 第二轮新增（LLM provider 落地 + 双端一键）

### 新增
- **`packages/adapter-agent-workbuddy-llm`**：LLM provider 包（V1 选型 `workbuddy`，`kind:'llm-agent'`）。
  - `src/index.ts`：`WorkbuddyLlmProvider` 实现桥接 SPI；组合复用 `DeterministicAgentProvider` 的 `execute/health/init/shutdown`，仅 `runGoal` 为新（LLM 驱动）；`health()` 报告自身 `id='workbuddy'`。
  - `src/bridge.ts`：`LlmBridge` 接口 + `CliLlmBridge`（生产默认，spawn VM 内 `codebuddy` CLI，流式进度、收集产物、超时/失败不伪造）；可注入 mock 便于测试。
  - 加入 `tsconfig.build.json` 引用、core `DEFAULT_SERVICE_CONFIG.agent.providers['workbuddy']`、vm-service 依赖。
- **`delivery/setup.mjs`**：双端一键部署总入口。纯函数 `parseEnv/resolveConfig/buildPlan` 可单测；读 `.env` 生成 BUILD→HOST→VM→TUNNEL→TEST 五阶段；默认 dry-run、`--apply` 真执行；`WINVM_VM_PROVIDER` 经 `--provider` 透传 VM 侧。
- **`.env.example`**：双端部署全部配置集中于此（含 `WINVM_VM_PROVIDER` / `WINVM_WORKBUDDY_CLI`）。
- **`delivery/install-vm.mjs`**：新增 `--provider <id>` / `--cli <exe>`（支持 `WINVM_VM_PROVIDER` 环境变量回退），生成运行配置时写入 `agent.provider`。
- **`packages/vm-service/src/cli.ts`**：self-test 现打印并校验所选 provider 的 `id/kind/声明能力目录`（轻量探测，不触发 init）。
- **测试**：`tests/unit/llm-provider.test.js`（5 项）、`tests/unit/setup-env.test.js`（6 项）。
- **文档**：`docs/02-design/LLM-PROVIDER.md`；`SPEC-AGENT-SERVICE-BRIDGE.md §6.1`、`ARCHITECTURE.md`（双 provider + ADR-10）、`DEPLOYMENT.md`（§1 双端一键 + agent.provider 选型）、`SCENARIOS.md`（§D/§G 对齐 `workbuddy` 选型）、`06-OVERVIEW.md` 同步。

### 关键决策（沉淀）
1. **provider 组合而非复制**：LLM provider 复用确定性执行器的执行/健康/初始化路径，仅 `runGoal` 为 LLM 新实现——桥接层 / MCP / A2A / 6 个 Skill 零改动即可切换 VM 内 Agent。
2. **配置驱动选型**：`agent.provider` 作 VM 侧 AI Agent 总开关；`delivery/setup.mjs` → `install-vm.mjs --provider` → `vm-service` 动态 `import()` 对应包，全链路不改代码。
3. **安全默认**：`setup.mjs` 不加 `--apply` 即 dry-run（只规划不改动）；`parseEnv` 支持引号与行内 `#` 注释。

### 测试结果（第二轮）
- 124/124 通过；`tsc -b` 10/10 包编译通过。
- `vm-service --self-test`：`workbuddy-deterministic` 与 `workbuddy`（LLM）均通过 provider 目录校验。
- `vm-service`（provider=workbuddy）`/health`：`provider.id="workbuddy", state="ready"`，暴露 54 能力；AgentCard 暴露 5 个 A2A Skill。

---

## 第三轮新增（双通道完善：宿主 A2A 委派桥 + 空闲自愈）

### 修复的设计缺陷：宿主侧 A2A 断链
原实现 VM 侧 A2A 服务端完备，但宿主侧**没有发起 A2A 的接入点**——`adapter-host-workbuddy` 只渲染 MCP 条目（指向 `/mcp`），54 个 MCP 工具里没有任何能发起 `runGoal` 的委派工具。VM 侧 A2A 服务端一直在等一个永远不会从宿主发起的请求。

### 新增
- **`packages/host-a2a-bridge`（新包，L3）**：宿主侧 A2A 委派桥，以本地 stdio MCP server 形态落地。
  - `src/client.ts`：`A2aDelegateClient` 抽象（`A2AClient` 结构上满足，便于注入 mock）+ `createLazyClientProvider`（懒连接，隧道未建立时首次调用才连，失败丢弃缓存可重试）。
  - `src/tools.ts`：`a2a.delegate`（流式收集 status-update/artifact-update，图片回传 image content）、`a2a.task.get`、`a2a.approval.reply`、`a2a.task.cancel`、`a2a.health`；`extractApproval` 从 data part 提取审批请求。
  - `src/stdio.ts`：自行实现 NDJSON stdio 循环（mcp-framework 无 stdio server transport）；stdout 只承载协议消息，日志走 stderr。
  - `src/cli.ts`：`--endpoint/--a2a-path/--timeout/--max-risk/--token-env`。
- **contracts**：`NeutralPlugin` 增加可选 `a2aBridge?: ConnectorDecl`；`StreamableHttpTransport.tokenEnv` 放宽为可选（回环隧道无需 bearer token）。
- **host-sdk**：校验新增 `a2aBridge`（id 合法、不得与 connector 同 id、transports 非空、stdio 需 command）；`tokenEnv` 仅对**非回环** URL 强制。
- **adapter-host-workbuddy**：`a2aBridge` 存在时额外渲染 `connector:winvm-a2a` 条目；`uninstall` 一并移除两个条目。
- **install-host.mjs**：把桥 dist 复制到插件目录，装配 `a2aBridge`（stdio → `a2a-bridge/cli.js`），dry-run 输出 **2 个增量补丁**。
- **VM 内 Agent 技能下发**：`setup.mjs` 把 `skills/` 随产物打包传到 VM；provider 按 `skillsRoot` 加载 SKILL.md，`writeSkillPack()` 落盘 + `buildSystemPrompt()` 注入摘要与工作方式（可自行编写脚本用 `appops.cli.invoke` 执行）。
- **CLI 契约配置化**：`DEFAULT_CLI_ARG_TEMPLATE` + `renderCliArgs()`，支持 `{goal}{prompt}{endpoint}{output}{skillsDir}` 占位符，真机参数不同经 `cliArgTemplate` 覆盖。
- **产物逐步回传**：`CliLlmBridge` 任务过程中节流扫描 outputDir（默认 2s），新增文件经 `sink.onArtifact` 实时推送（此前只在结束时一次性收集）；单文件 >20MB 跳过。
- **VM 分发改打包传输**：`setup.mjs` 用 tar 打包（保留 `packages/<name>/dist` 层级，避免同名 dist 互相覆盖），先 `New-Item -Force` 建目录，VM 侧 `--skip-install --skip-build`（dist 已分发）。
- **`install-vm.mjs`**：新增 `--skip-install`（跳过 npm ci，产物已由宿主机构建分发）。
- **Skill**：`winvm-orchestrator` 明确两条通道各自的工具（`winvm` 点分能力 ID / `winvm-a2a` 的 `a2a.delegate` 等），补审批与超时处理示例。

### 修复的严重缺陷：ps-bridge 空闲后永久失效
- **现象**：VM 服务启动后可用，**空闲约 45s 后所有调用失败**（`ps-bridge 未就绪`）且永不恢复，必须重启服务。
- **根因**：① `ps-bridge.ps1` 主循环在等 stdin 时阻塞，空闲期发不出心跳；② TS 侧看门狗仅凭"心跳超时"直接 `kill()`，注释声称"将重启"但**代码没有重启逻辑**；③ 进程引用被清空后无人拉起。
- **修复**：看门狗超时后**先主动 ping 探测**（ping 通即视为健康、仅刷新时间戳，不再误杀；不通才重启）；抽出 `spawnAndReady()` 真正实现 `restart()`（`failAll → kill → spawn`），`restarting` 防重入、`stopped` 避免 stop 后被拉起；并修复"旧进程 exit 回调晚于新进程 spawn、把新进程引用误清为 undefined"的竞态（比对 `this.child === spawned` 才清理）。
- **验证**：启动后立即委派 → `completed`；空闲 55s 后再委派 → `completed`（修复前必失败）。

### 关键决策（沉淀）
1. **宿主桥用 stdio 而非 HTTP 端口**：零端口占用、随宿主连接器生命周期启停、不新增暴露面。
2. **同一条 SSH 隧道承载 `/mcp` 与 `/a2a`**：`establishTransport(path='/a2a')` 即可复用，与 MCP 通道并存。
3. **回环免 token**：宿主→VM 走本机回环隧道，VM 侧本身只监听 127.0.0.1，`tokenEnv` 仅对非回环直连强制（既安全又不阻碍部署）。

### 测试结果（第三轮）
- 143/143 通过；`tsc -b` 11/11 包编译通过。
- 端到端冒烟（真实进程）：宿主桥 stdio MCP → `initialize`/`tools/list`/`a2a.health` → `a2a.delegate` "查看系统信息" → `state: completed` 并回传产物。
- 宿主安装器 dry-run：8 文件 + **2 个增量补丁**（`connector:winvm`、`connector:winvm-a2a`）。

---

## 第四轮新增（`hermes-agent` 选项 + 共享 Skills 独立部署）

### 背景
VM 内 AI Agent 由「双选项」（workbuddy-deterministic / workbuddy）扩展为「三选项」，新增 **`hermes-agent`**（Nous Research 的 Hermes Agent）。同时按用户要求，把 54 个 Windows VM 操作能力包装的 Skills 改为**独立于各候选 VM Agent 部署**：单一真源在仓库 `skills/`，经 `delivery/deploy-shared-skills.mjs` publish 到共享根 `C:/WinVMBridge/shared-skills`，各候选 Agent 仅通过 junction 引用，避免多份副本漂移。

### 新增
- **`packages/adapter-agent-hermes`（新包，L3）**：`HermesAgentProvider` 实现桥接 SPI（`declareCapabilities`/`init`/`execute`/`health`/`shutdown`/`runGoal`）。复用 `DeterministicAgentProvider` 的执行/健康/初始化路径与 `CliLlmBridge`、`loadSkillDocs`，仅 `runGoal` 经 Hermes CLI（`hermes chat -q -Q --yolo --source`）驱动。
  - **关键架构约束**：Hermes CLI **无 `--mcp` 参数**，故 MCP 必须预注册进 `config.yaml` 的 `mcp_servers`（url 类型，Bearer auth 经 `.env` 的 `MCP_WINVM_API_KEY`）；`mcp-registrar.ts` 在 `init()` 幂等 upsert 该块并写 `.env` token，失败时降级（warn 不阻断）。CLI 模板**不含 `--mcp`**（对拍 workbuddy 路径）。
  - 写入 `tsconfig.build.json` 引用、`core` 的 provider 注册表、`vm-service` 依赖。
- **`delivery/deploy-shared-skills.mjs`**：共享 Skills 部署器。两阶段：① `publishSharedSkills` 把仓库 `skills/` 复制到共享根（同一目录时跳过重拷贝，避免 `cp EINVAL`）；② `planSharedSkillLinks` 让各候选 VM Agent 目录经 junction 引用共享根下的 Skill（已存在则跳过，冲突/被非 junction 占用则跳过并告警）。纯函数可单测，支持 `--dry-run`。
- **`delivery/vm-service.config.json`**：新增 `hermes-agent` provider 条目（package `@winvm/adapter-agent-hermes`，endpoint `http://127.0.0.1:18443/mcp`，`skillsRoot: C:/WinVMBridge/shared-skills`，`registerMcp: true`）；并把 `workbuddy` / `hermes-agent` 的 `skillsRoot` 统一改为 `C:/WinVMBridge/shared-skills`。
- **`delivery/install-vm.mjs`**：新增共享 Skills 部署步骤（解析优先级 `--skills-root > WINVM_SKILLS_ROOT > provider.options.skillsRoot > 默认值`），`--dry-run` 打印 6 步计划；导入 `deploySharedSkills`。
- **`delivery/setup.mjs`**：`resolveConfig` 新增 `hermesCli`（`WINVM_HERMES_CLI` 回退），`resolveVmCli(cfg)` 在 provider=hermes-agent 时返回 hermes CLI；两处硬编码 `--cli ${cfg.workbuddyCli}` 改为 `${resolveVmCli(cfg)}`。
- **`packages/core/src/config/index.ts`**：`skillsRoot` 默认值 `C:/WinVMBridge/skills` → `C:/WinVMBridge/shared-skills`。
- **测试**：`tests/unit/hermes-provider.test.js`（10 项）、`tests/unit/mcp-registrar.test.js`（13 项）、`tests/unit/deploy-shared-skills.test.js`（8 项），共 **31 项新增**。
- **文档**：`docs/02-design/HERMES-AGENT-PROVIDER.md`（ADR-13/14：选型 + MCP 预注册模型）、`SPEC-SKILLS.md` 同步共享 Skills 部署范式；`DEPLOYMENT.md` / `LLM-PROVIDER.md` / `06-OVERVIEW.md` 同步三选项与共享根路径；各 Skill 内置 `mcps-reference.md`（MCP server 部署/管理参考）。

### 关键决策（沉淀）
1. **MCP 预注册而非 CLI 透传**：Hermes 不支持 `--mcp`，只能把 `winvm` MCP server 写进 `config.yaml.mcp_servers` 并在 `.env` 放 `MCP_WINVM_API_KEY`，Hermes 启动时 `mcp_startup.py` 自动加载——这是 hermes 生态的标准做法（agentskills.io 规范）。
2. **Skills 单一真源 + junction 引用**：共享根 `C:/WinVMBridge/shared-skills` 与仓库 `skills/` 分离，避免「VM 部署目录 == 仓库目录」时 `cp` 自拷贝；各 Agent 仅 junction 引用，保证单一真源、零副本漂移。
3. **降级不阻断**：Hermes MCP 注册失败（如 config 不可写）仅 warn，VM 服务照常启动，能力暴露不依赖 MCP 预注册成功。

### 测试结果（第四轮）
- **158/158 通过**（143 + 31 新增）；`tsc -b` 12/12 包编译通过。
- `install-vm.mjs --dry-run --provider hermes-agent`：正确打印 6 步计划。
- `deploy-shared-skills.mjs --source skills --publish-from skills`：dry-run 正确识别 7 个 Skill + 读取 Agent 目录 + 跳过已有 link。
- `vm-service --self-test`（provider=hermes-agent）：通过 provider 目录校验（hermes 真机 CLI 调用待真实环境终验）。

---

## 第五轮修复（远程分发链路：缺 node_modules + 缺运行时资产）

### 背景
用户问「能否在宿主机一键把本插件同时装到宿主机和（远程）Windows VM」——`setup.mjs --apply` 设计上支持，但真机链路实测有两个根因缺陷，导致远程分发出去的产物**跑不起来**：

1. **缺 node_modules**：宿主 `setup.mjs` 把已构建好的 `dist` 打包 scp 到 VM，`install-vm.mjs` 以 `--skip-install --skip-build` 收尾。但 `dist` 产物里的 ESM import 仍写成裸包名 `from '@winvm/contracts'`（编译期不重写），VM 侧没有 `node_modules/@winvm/*`，`node cli.js` 直接 `ERR_MODULE_NOT_FOUND`。
2. **缺运行时资产**：分发清单当时只发 `dist` + `package.json`，漏发了 VM 运行必需的 **PowerShell 能力脚本** `packages/vm-capabilities/psmod/`（54 个 Windows 能力实现）与 **JSON Schema** `packages/contracts/schemas/`，self-test 报「找不到 ps-bridge 脚本」。

### 修复
- **`delivery/setup.mjs`**：VM 侧产物改为**排除法**清单 `packagePayloadPaths()`——发出每个 `packages/<name>/` 下除 `src`/`node_modules`/`tsconfig*` 之外的全部条目（含 `dist`、`psmod/`、`schemas/`、各 `package.json`），彻底含齐运行时资产，且**不含 node_modules**。
- **`delivery/link-workspace.mjs`（新增）**：为「仅含 dist 的分发产物」建 `node_modules/@winvm/<pkg>` → `packages/<pkg>` 的 **junction 软链**（Windows 免管理员/免联网/幂等）。`planWorkspaceLinks()` 纯函数产出 create/skip-ok/skip-conflict，`applyWorkspaceLinks()` 负责建链；导出 `ensureWorkspaceLinks()` 供安装器调用。裸包名 import 由此解析，无需 `npm ci`、无需联网。
- **`delivery/install-vm.mjs`**：依赖解析步骤改为「`npm ci`（默认）或 @winvm workspace 软链（`--skip-install` 时跳过 ci，软链仍建）」；新增 `--skip-links` 可跳过软链；导入 `ensureWorkspaceLinks` 并在步骤 1 调用，失败 fail-closed 退出。
- **测试**：
  - `tests/unit/link-workspace.test.js`（**16 项**）：覆盖 `norm` / `planWorkspaceLinks`（create/skip-ok/skip-conflict/空）/ `discoverPackages` / `probeLinkDir`（junction 探测）/ `applyWorkspaceLinks`（真实建链 + dry-run）/ `ensureWorkspaceLinks`（幂等 + dry-run + 空）。
  - `tests/unit/setup-env.test.js`（**新增 4 项防回归**）：manifest 与 dist 一致、产物含 `psmod/`、排除 `src/node_modules/tsconfig*`、含 `contracts/schemas/`。

### 关键决策（沉淀）
1. **junction 软链而非 npm ci**：12 个包**全部只有内部 `@winvm/*` 依赖、零外部 npm 依赖**，故 junction 即可解析裸包名 import，远程 VM 免联网、免装 registry。这与 `deploy-shared-skills.mjs` 用 junction 引用共享 Skills 的范式一致。
2. **排除法清单而非白名单**：VM 产物用「排除 src/node_modules/tsconfig*」自动包含一切运行时资产（含未来新增的 psmod/python 脚本），避免再漏发。

### 测试结果（第五轮）
- 本地模拟远程 payload 树（仅 dist + package.json → 加 symlink + 全量排除法产物）复现并修复两缺陷：修复前 `ERR_MODULE_NOT_FOUND` / 缺 ps-bridge 脚本；修复后 `--self-test` 退出码 0、6 能力域 / 54 能力 / ps-bridge 探测全 OK。
- 全量套件：**178 单测 + 16 e2e = 194/194 通过**（`tsc -b` 12/12 包编译通过）。
- `docs/06-OVERVIEW.md` 与 `.dev/*` 索引同步（194/194、12 包、link-workspace.mjs）。

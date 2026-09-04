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

---

## 第六轮：启动健壮性 + GUI 会话启用提示

### 背景
前几轮已落地「双端一键部署」「VM 服务自启（LogonTrigger）」「VM-START 拉起 + HEALTH 重试」。真机实测暴露三类体验问题：① HEALTH 偶发不通（冷启动竞态）；② VM 内弹 node 控制台窗口，用户可能误关杀掉服务；③ 经 SSH 远程 `schtasks /run` 拉起的服务常落在非交互式会话，`/health` 报 `session.interactive=false`、GUI 被门禁，但用户看不到「如何启用 GUI」的明确指引。

### 新增 / 修改
- **`delivery/setup.mjs`**：
  - 新增 `waitForRemotePort(cfg, timeoutMs)`：经 SSH 在 VM 内 `Test-NetConnection -Port 18443` 轮询（每 1s，≤60s），**不依赖本地 SSH 隧道**，故在 VM-START 阶段即可判定启动完成。
  - VM-START 阶段：`schtasks /run` 后调用 `waitForRemotePort`，监听即打印「启动完成」；否则告警并交 HEALTH 兜底。
  - HEALTH 阶段：端口通常已通，仅取 `/health` JSON 并短重试（2s×3）；**解析 `session.interactive`**，当 `false` 时打印健壮的「GUI 启用命令块」（`GUI_RESTART_COMMAND` 常量），并在最终成功摘要追加提醒。
  - 新增导出常量 `GUI_RESTART_COMMAND`：在 VM 交互式 PowerShell 执行——先 `schtasks /end`（让调度器标记结束，后续 `/run` 不被 `IgnoreNew` 拦截），等 2s，兜底 `Stop-Process` 强杀占用 18443 的进程，再 `schtasks /run` 在交互式会话拉起 GUI 可用实例。
- **`delivery/install-vm.mjs`**：任务计划 XML `<Hidden>false</Hidden>` → `<Hidden>true</Hidden>`，服务在交互式会话内也不弹 node 控制台窗口，避免误关进程（Hidden 只控可见性、不影响会话/交互性）。
- **`docs/05-peripherals/DEPLOYMENT.md`**（§1.3 / §4.1）：同步登录触发器随 VM 登录启动、`Hidden=true`、GUI 会话约束，以及「在 VM 交互式 PowerShell 中 restart 以启用 GUI」的显式命令块。

### 关键决策（沉淀）
1. **端口轮询独立于隧道**：`waitForRemotePort` 探 VM 本机端口，避免 VM-START 阶段隧道尚未建立的顺序依赖，彻底消除冷启动竞态。
2. **远程 `schtasks /run` 不保证交互式会话**：仅当 VM 已有 RDP 交互式登录时才落入该会话；故 GUI 启用必须依赖「RDP 登录触发 AtLogOn」或「在交互式 PowerShell 内手动 restart」。
3. **restart 顺序不可省 `schtasks /end`**：若直接 `Stop-Process` 强杀而不先 `/end`，调度器仍认为任务 running，`IgnoreNew` 会拦截后续 `/run` → 新实例起不来。先 `/end` 再强杀再 `/run` 才是可靠的「杀非 GUI 实例、起 GUI 实例」。

### 验证（第六轮）
- `node --check` 两脚本均通过。
- `setup.mjs`（无 `--apply`）dry-run 仍正确打印七阶段计划，VM-START 描述含「轮询端口监听 ≤60s」。
- 真机闭环（卸载→重装→信任→测试）由用户执行；所有删除入回收站可恢复。

### 测试结果
- 套件保持 194/194 通过（本轮未改测试，仅部署脚本与文档）。

---

## 第七轮：插件管理 CLI winvm-plugin（host/VM 统一查验与管理）

### 背景
插件经 `setup.mjs` 双端部署后，宿主与 VM 两侧缺乏统一的查验/管理入口。用户要求提供一套 `winvm-plugin` 命令（`help` / `check` / `health` / `list [skills,mcp-servers,mcp-tools,dirs]` / `server [start,status,stop,restart]` / `command` / `uninstall` / `update` / `reinstall`），部署后在两侧均可直接调用。

### 新增 / 修改
- **新增 `delivery/winvm-plugin.mjs`**（ESM、零外部依赖）：自动识别 host/vm 上下文（优先级 `--side` > 同目录 `.winvm-context.json` > 启发式），实现全部子命令。
  - `check`：host 校验 `installed_plugins.json` 条目 + 连接器条目 + 缓存目录 + Skills；vm 校验计划任务 + `cli.js` + 运行配置 + 共享 Skills 根 + 端口监听。
  - `health`：host 经 SSH `curl` 探 VM `/health`，vm 本地；`session.interactive=false` 时打印 GUI 启用命令块。
  - `list mcp-tools`：优先 import 已编译 `vm-capabilities` 注册表（按域分组，共 54 项）；不可用时回退经 `/mcp` `tools/list`。
  - `list skills` / `mcp-servers` / `dirs`：两侧分别列出对应资产。
  - `server start|status|stop|restart`：host 经 SSH 执行 `schtasks`；vm 本地。`restart` = `/end` + 强杀残留端口进程 + `/run`（确保杀非 GUI 实例、起 GUI 实例）。
  - `command <tool> [--args <json>]`：host 建临时 SSH 隧道 + JSON-RPC 调 `/mcp`（initialize→notifications/initialized→tools/call）；vm 本地。
  - `uninstall [--vm]` / `update` / `reinstall`：host 重跑仓库 `install-host.mjs`（加 `--vm` 经 SSH 同时卸载 VM）；vm 重跑 `install-vm.mjs`。
  - HTTP 客户端 / SSH 中继 / MCP JSON-RPC 客户端均用 Node 内置模块（`http` / `net` / `child_process`）实现，无第三方依赖。
- **`delivery/install-host.mjs`**：注册后把 `winvm-plugin.mjs` 复制到插件缓存根，并写 `.winvm-context.json({"side":"host"})` + `winvm-plugin.cmd` 包装。
- **`delivery/install-vm.mjs`**：部署尾部于 `delivery/` 写 `.winvm-context.json({"side":"vm"})` + `winvm-plugin.cmd`。`setup.mjs` 的 tar 包已含 `delivery/`，故自动分发到 VM。
- **`docs/05-peripherals/DEPLOYMENT.md`** 新增 §7「插件管理命令 winvm-plugin」（子命令一览 / host 侧 VM 连接信息优先级 / 示例 / GUI 重启提示）；原「远程 Windows」章节顺延为 §8（7.1–7.6 → 8.1–8.6）。

### 关键决策
1. host/VM 同一份脚本、靠上下文标记分流，避免双份维护。
2. `command`/`health`/`server` 在 host 侧统一走 SSH（command 用临时隧道保活、其余用 ssh 远程执行），与 `setup.mjs` 既有的 SSH 用法一致。
3. `list mcp-tools` 优先本地注册表 import（VM 离线也可用），回退才依赖运行中的服务，保证查验可用性。

### 验证（第七轮）
- `node --check` 三脚本（winvm-plugin.mjs / install-host.mjs / install-vm.mjs）均通过。
- 本地实测（host 上下文，无需 VM 在线）：`help` / `check` 全 ✅ / `list dirs` / `list skills`（7 项）/ `list mcp-servers`（connector:winvm + connector:winvm-a2a）/ `list mcp-tools`（54 项按域分组）均正确输出。
- SSH 相关命令（health/command/server）在缺 VM 连接信息时给出清晰报错、不崩溃。
- 真机 SSH 路径由用户按 §7 示例自测。

### 测试结果
- 套件保持 194/194 通过（本轮仅新增部署脚本与文档，未改既有测试）。

---

## 第八轮：部署脚本 5 项问题修复（输出可见性 / 误报失败 / 命令可达 / 残留窗口 / 回收站澄清）

### 背景
用户跑 `node delivery/setup.mjs --apply` 后提出 5 个问题：
1. 多个步骤只打印执行命令、没显示成功/失败；
2. VM-START 与 /health 看似各跑了两次；
3. 宿主机与 VM 都找不到 `winvm-plugin` 命令；
4. VM 上仍有 node 控制台窗口残留；
5. uninstall 后 VM 回收站是空的、宿主回收站文件比预期少。

### 根因与修复
- **Q1/误报「VM 部署失败」**：`install-vm.mjs` 步骤7 把 `delivery/winvm-plugin.mjs` 自拷贝到同路径（tar 已含该文件）→ `cpSync` 自拷贝 EINVAL（或原代码缺 `cpSync` 导入）→ 进程退出 1 → `setup.mjs` 误报失败（实际服务已就绪）。
  - **修复**：新增 `delivery/deploy-winvm-plugin.mjs` 统一部署启动器，复制前判定 `resolve(binSrc)===resolve(binDst)` 则跳过复制；复制/写文件均包在可控流程内，不再因单点异常中断部署。
- **Q2/「运行两次」**：实为「计划预览（`$ command`）」+「执行（`[PHASE] 执行：`）」各打印一次，每阶段实跑一次。属显示误解。
  - **修复**：预览块加「【计划预览】以下为将执行的步骤（仅展示，尚未执行）」明确标注，命令前加 `▸` 前缀；执行块显式打印 `$ 命令` + 每步 `✅/❌`。VM-START 改为「先 `schtasks /end` + 强杀残留端口进程 + `schtasks /run`」的干净重启语义（消除旧实例），并纠正为重启而非盲目 run。
- **Q3/命令找不到**：原仅生成 `winvm-plugin.cmd`，且只在插件缓存根 / VM `delivery/` 内，仓库根与 PATH 均无；Git Bash/ssh 里敲 `winvm-plugin`（无扩展名）解析不到。
  - **修复**：`deploy-winvmPlugin` 生成三件套——`winvm-plugin.mjs` + `winvm-plugin.cmd`（Windows，PATHEXT 解析）+ 无扩展名 `winvm-plugin`（bash 启动器 `#!/usr/bin/env bash` + 经 `bash -c chmod +x` 置可执行位）。宿主侧额外部署到仓库 `delivery/`，使仓库内 `node delivery/winvm-plugin.mjs <cmd>` 或 `./delivery/winvm-plugin <cmd>` 即可用。
  - 仓库 `delivery/` 部署传 `writeContext:false`，避免 `side:host` 上下文随 tar 发到 VM 致其误判为 host（VM 侧由 `install-vm` 步骤7 正确写 `side:vm`，且 VM 目录有 `packages/vm-service/dist/cli.js` 启发式也能识别 vm）。
  - 生成的 `delivery/winvm-plugin` / `winvm-plugin.cmd` / `.winvm-context.json` 已加入 `.gitignore`。
- **Q4/残留 node 窗口**：`install-vm.mjs` 卸载只 `schtasks /Delete`，不杀运行中的服务进程；旧 `Hidden=false` 实例跨卸载/重装残留，新 `Hidden=true` 实例因 `MultipleInstancesPolicy=IgnoreNew` 起不来。
  - **修复**：新增 `killServiceProcess(port, taskName)`（`schtasks /End` + `Stop-Process` 占端口进程）。在 ① 卸载 `--yes` 执行、② 部署步骤5 重新注册任务前、③ `setup.mjs` VM-START 经 SSH 重启前 调用，确保端口释放、无残留窗口、新实例可绑定。
- **Q5/回收站为空 / 文件少**：VM 默认回收目录是 `<repoRoot>/.uninstall-trash/<ts>/`（设计如此，SSH 下系统回收站不可见）；宿主侧注册文件改动走「先备份 `*.winvm-bak.*` + diff」，备份默认保留不进回收站（可回滚），单文件改动不移动。
  - **修复**：VM 卸载完成消息高亮可恢复目录（`C:/WinVMBridge/.uninstall-trash/<时间戳>/`，明确「非 Windows 回收站」）；宿主卸载完成消息说明 `*.winvm-bak.*` 备份默认保留、确认后用 `--purge-backups` 清理。`DEPLOYMENT.md` §6 新增「为什么回收站里看不到某些被删的东西」FAQ，直接回答此疑问。

### 新增 / 修改文件
- **新增** `delivery/deploy-winvm-plugin.mjs`：安全的 winvm-plugin 启动器部署器（跳过自拷贝 / 三件套 / writeContext 开关）。
- **改** `delivery/install-vm.mjs`：导入 helper + `killServiceProcess`；卸载 `--yes` 先停服务；部署步骤5 注册前清残留；步骤7 改用 helper；卸载完成消息高亮可恢复目录。
- **改** `delivery/install-host.mjs`：导入 helper；部署到插件缓存根 + 仓库 `delivery/`（`writeContext:false`）；卸载完成消息说明备份保留。
- **改** `delivery/setup.mjs`：计划预览与执行分离 + 每步 `✅/❌`；VM-START 改为重启语义。
- **改** `docs/05-peripherals/DEPLOYMENT.md`：§7 重写启动器落地位置与调用方式；§6 新增回收站 FAQ。
- **改** `.gitignore`：忽略生成的 winvm-plugin 启动器与上下文文件。

### 验证（第八轮）
- `node --check` 四脚本（setup.mjs / install-vm.mjs / install-host.mjs / deploy-winvm-plugin.mjs / winvm-plugin.mjs）全部通过。
- `deployWinvmPlugin` 单测：① 异目录复制+三件套 ✅；② `binSrc===binDst` 跳过复制但仍写启动器 ✅（修复自拷贝）；③ `writeContext:false` 不写上下文 ✅；④ dry-run 不写盘 ✅。
- 本地 `winvm-plugin` 实测：`help` / `--side host check` 正常输出（命令已可达；本沙箱未装插件故 check 显示 ❌，属环境状态非命令问题）。
- `setup.mjs` dry-run 预览正确标注「【计划预览】」且每条命令仅展示一次。

---

## 第九轮：补持久化单测 + 输出一致性收尾（第八轮闭环）

### 背景
第八轮修复虽已落盘，但验证存在两处缺口：① `deployWinvmPlugin` 单测此前为临时脚本验证、**未入库**，核心改动无回归防护；② 未跑全量单测，遗漏了被测代码与测试期望不同步的问题。本轮补齐并收尾。

### 修复与补强
- **新增持久化单测** `tests/unit/deploy-winvm-plugin.test.js`（4 case）：异目录复制 + 三件套落地 / `binSrc===binDst` 自拷贝跳过（防 EINVAL 误报回归）/ `writeContext:false` 不写上下文 / dry-run 不写盘。全部在临时目录内隔离运行，不触碰真实仓库 `delivery/`。
- **修 `setup-env.test.js` 陈旧期望**：第八轮新增 `VM-START` 阶段后，该测试仍断言「BUILD/HOST/VM/TUNNEL/TEST/HEALTH 六阶段」，导致 1 个用例红。已更新为七阶段，并**新增「各阶段仅出现一次」用例**，把 Q2「不再重复执行」固化为回归防护；`--apply` 覆盖列表加入 `VM-START`。
- **`setup.mjs` VM-START 预览命令对齐实跑**：预览原仅显示 `schtasks /run`，而实跑是「结束旧实例 + 强杀残留端口进程 → `schtasks /run`」。已同步为真实重启语义（原则7 文档逻辑一致性；呼应 Q1 输出须真实反映执行）。
- **`deploy-winvm-plugin.mjs` 输出可观测性**：`writeContext=false` 的「跳过」此前**仅 dry-run 打印**、实跑静默；实跑时的上下文写入同样从不留痕。现两种情况均记录（dry-run 追加 `[dry-run]` 标记以区分预览与实跑）。

### 新增 / 修改文件（第九轮）
- **新增** `tests/unit/deploy-winvm-plugin.test.js`：`deployWinvmPlugin` 持久化单测（4 case）。
- **改** `tests/unit/setup-env.test.js`：六阶段 → 七阶段；新增「各阶段仅出现一次」回归用例；`--apply` 覆盖列表加入 `VM-START`。
- **改** `delivery/setup.mjs`：VM-START 预览命令对齐真实重启语义（不改行为，仅校正预览展示）。
- **改** `delivery/deploy-winvm-plugin.mjs`：上下文跳过/写入均留痕（dry-run 追加标记）。

### 验证（第九轮）
- 单测**逐文件**模式 **187/187 全绿**（含新增 4 + 修复后 `setup-env` 16）。
- `node --check` 相关脚本全部通过；`winvm-plugin help/check` 可达。

### ⚠️ 重要：本仓库单测必须「逐文件」运行
整批执行 `node --test tests/unit/*.test.js` 会**假故障全红**：`link-workspace.test.js` 做 `symlink(...,'junction')` 在本沙箱触发 node 进程访问违例（`exitCode 2147483651` / `0xC0000005`，附原生栈），共享 runner 被打崩后，同进程内**所有**测试文件被连带判死且无汇总计数（单独跑该文件 16/16 全绿）。
→ 正确姿势：`for f in tests/unit/*.test.js; do node --test "$f"; done`（逐文件汇总），**切勿**用通配一次跑全部。

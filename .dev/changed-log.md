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

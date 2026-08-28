# LLM Provider 实现设计（FEATURE-ADD · V1 = `workbuddy`）

| 项 | 值 |
|---|---|
| 文档 ID | TECHNICAL-SOLUTION-LLM-PROVIDER-v1 |
| 版本 | v1.0 |
| 场景 | D（功能新增 / 优化） |
| 对应诉求 | 用户："通过配置 `agent.provider`，可以选择 VM 侧的不同 AI Agent 提供完整的 A2A Agent 智能服务。V1 版本：VM 侧的 Agent 先实现一个选型：`workbuddy`" |
| 日期 | 2026-08-28 |
| 协作规范 | DDD（文档先行 / 文档逻辑一致性）+ plan-first（任务树 / 深度左序 / 逐节点验证） |

---

## 1. 背景与目标

当前 VM 侧仅有 `workbuddy-deterministic` 一个 provider（确定性执行器，无 LLM）。它能处理预置工作流与模板化目标，但**开放/创意类自然语言任务**（如"用 Photoshop 把照片里的大山换成海洋"）会被返回 `UNSUPPORTED_GOAL`。

用户要求把"VM 内 Agent 选型"真正落地为**可配置、可扩展**的能力：

- **目标**：`agent.provider` 成为 VM 侧 AI Agent 的总开关；切到不同值即选用不同 VM Agent，提供完整的 A2A Agent 智能服务。
- **V1 范围**：先实现一个选型——`workbuddy`（VM 内 WorkBuddy `codebuddy` CLI 作为 LLM 推理运行时）。
- **架构约束**：复用既有 `AgentServiceProvider` SPI 与 loader（动态 `import(entry.package)`），**桥接层 / MCP / A2A / skills 零改动**；新增 provider 只需"新包 + 配置一条 entry"。

---

## 2. 需求

### 2.1 功能需求

| ID | 需求 | 优先级 |
|---|---|---|
| FR-LLM-1 | 新增可插拔 provider 包 `@winvm/adapter-agent-workbuddy-llm`，导出 `createProvider`，其 provider `id = 'workbuddy'`、`kind = 'llm-agent'` | P0 |
| FR-LLM-2 | `declareCapabilities()` 如实声明全能力域（`meta.*` / `system.*` / `app.*` / `storage.*` / `gui.*` / `appops.*`），经桥接层 ∩ 平台能力自动收敛 | P0 |
| FR-LLM-3 | `runGoal(goal, sink)` 经 LLM 运行时完成**开放任务**：构造能力目录上下文 → 调起 VM 内 WorkBuddy CLI → 流式回传进度/artifact → 返回 `GoalResult` | P0 |
| FR-LLM-4 | `execute` / `health` / `init` / `shutdown` 复用确定性执行器的 ps-bridge 执行链路（不重复实现，委托组合） | P0 |
| FR-LLM-5 | `vm-service` 默认配置 `agent.providers` 注册 `workbuddy` entry；切换仅改 `agent.provider` 一行 | P0 |
| FR-LLM-6 | 提供 `.env` + 双端一键脚本 `delivery/setup.mjs`：同时部署宿主机侧与 VM 侧（含 SSH 隧道与端到端自检），配置全部来源于 `.env` | P0 |
| FR-LLM-7 | `setup.mjs` 默认 `--dry-run`（只规划不改动）；`--apply` 才真执行 | P0 |

### 2.2 非功能需求

| ID | 需求 |
|---|---|
| NFR-LLM-1 | 监管不降级：LLM 规划出的每一步仍过策略引擎 / 审批闸 / 审计链 / before-after 快照（与 V1 共用安全内核） |
| NFR-LLM-2 | 宿主零感知：Agent Card `skills[]` 由 `declareCapabilities()` 自动收敛，协议层对宿主完全一致 |
| NFR-LLM-3 | 可测试：LLM 运行时在沙箱不存在，provider 的 `runGoal` 必须支持**注入 `LlmBridge`**（mock），单测不依赖真实 CLI |
| NFR-LLM-4 | 失败不失控：CLI 不可用 / 超时 → 明确错误，不静默伪造结果 |
| NFR-LLM-5 | 可回退：`agent.provider` 切回 `workbuddy-deterministic` 即回到确定性，无残留状态 |

---

## 3. 技术方案

### 3.1 总体架构（复用 loader，零改桥接层）

```
agent.provider = "workbuddy"
        │  (core/src/config → loader.loadProvider 动态 import)
        ▼
@winvm/adapter-agent-workbuddy-llm  ── createProvider(options)
        │
        ├─ WorkbuddyLlmProvider (id='workbuddy', kind='llm-agent')
        │     ├─ execute/health/init/shutdown  → 委托 DeterministicAgentProvider（ps-bridge 执行链路）
        │     └─ runGoal(goal, sink)           → 经 LlmBridge 调起 VM 内 codebuddy CLI
        │                                        （CLI 运行时连接本服务 /mcp，自主规划并调用 appops.* 等能力）
        ▼
   vm-capabilities（ps-bridge → PowerShell → UIA / COM）  ← 与 V1 共用同一安全内核
```

`loader.loadProvider` 已支持：读 `cfg.agent.provider` → 查 `cfg.agent.providers[id].package` → `import()` → `createProvider(options)` → `init(ctx)`。**无需任何改动。**

### 3.2 新包结构 `packages/adapter-agent-workbuddy-llm`

```
packages/adapter-agent-workbuddy-llm/
├── package.json          # name=@winvm/adapter-agent-workbuddy-llm, deps: contracts/core/vm-capabilities/adapter-agent-workbuddy
├── tsconfig.json         # 继承根 tsconfig（project references）
└── src/
    ├── index.ts          # WorkbuddyLlmProvider + createProvider
    └── bridge.ts         # LlmBridge 接口 + CliLlmBridge（spawn codebuddy）+ 类型
```

### 3.3 `WorkbuddyLlmProvider` 设计

```ts
export const PROVIDER_ID = 'workbuddy';

export interface WorkbuddyLlmProviderOptions {
  runtime?: string;          // CLI 名，默认 'codebuddy'
  cliPath?: string;          // 可覆盖为绝对路径
  endpoint?: string;         // 本服务 /mcp，供 LLM 运行时回连调用能力，默认 http://127.0.0.1:18443/mcp
  maxConcurrency?: number;
  outputDir?: string;        // 产物输出目录，默认 %USERPROFILE%\WinVMWorkspace\out
  /** 注入用：测试注入 mock；生产省略（自动构造 DeterministicAgentProvider） */
  executor?: AgentServiceProvider;
  bridge?: LlmBridge;
  psBridge?: PsBridgeOptions;
}

export class WorkbuddyLlmProvider implements AgentServiceProvider {
  readonly id = PROVIDER_ID;
  readonly displayName = 'WinVM WorkBuddy LLM Agent (V1)';
  readonly kind = 'llm-agent' as const;

  private ctx?: BridgeContext;
  private readonly executor: AgentServiceProvider;   // 复用确定性执行链路
  private readonly bridge: LlmBridge;                // 可注入（mock/真实）

  constructor(opts: WorkbuddyLlmProviderOptions = {}) {
    this.executor = opts.executor ?? new DeterministicAgentProvider({ psBridge: opts.psBridge });
    this.bridge = opts.bridge ?? new CliLlmBridge({ runtime: opts.runtime ?? 'codebuddy', cliPath: opts.cliPath, endpoint: opts.endpoint });
    // ...保存 outputDir / maxConcurrency
  }

  declareCapabilities() {
    return ['meta.*', 'system.*', 'app.*', 'storage.*', 'gui.*', 'appops.*'];
  }

  async init(ctx: BridgeContext) { this.ctx = ctx; await this.executor.init(ctx); }
  async execute(req: CapabilityRequest) { return this.executor.execute(req); }
  async health() { return this.executor.health(); }
  async shutdown() { return this.executor.shutdown(); }

  async runGoal(goal: GoalRequest, sink: ProgressSink): Promise<GoalResult> {
    const ctx = this.ctx!;
    const catalog = ctx.capabilities.list();          // 能力目录 → LLM 规划上下文
    sink.onStatus('working', `WinVM WorkBuddy LLM Agent 接管目标：${goal.goal}`);
    const res = await this.bridge.runGoal({
      goal: goal.goal,
      capabilities: catalog,
      outputDir: this.outputDir,
      cliPath: this.cliPath,
      endpoint: this.endpoint,
      traceId: goal.traceId,
      timeoutMs: goal.timeoutMs,
    }, sink);
    return {
      ok: res.ok,
      summary: res.summary,
      artifacts: res.artifacts,
      steps: res.steps,
      ...(res.ok ? {} : { error: res.error }),
    };
  }
}
```

### 3.4 `LlmBridge` 接口与实现

```ts
export interface LlmGoalInput {
  goal: string;
  capabilities: readonly string[];
  outputDir: string;
  cliPath: string;
  endpoint?: string;
  traceId: string;
  timeoutMs: number;
}
export interface LlmGoalResult {
  ok: boolean;
  summary: string;
  artifacts: Artifact[];
  steps: GoalStep[];
  error?: BridgeError;
}
export interface LlmBridge {
  runGoal(input: LlmGoalInput, sink: ProgressSink): Promise<LlmGoalResult>;
}
```

- **`CliLlmBridge`**（生产默认）：
  1. 构造 system prompt：列出 `capabilities` 目录 + 输出目录 + 安全约束（每步必须经本服务 `/mcp` 调用能力，不得直连宿主）。
  2. `spawn(cliPath, ['--goal', goal, '--system-prompt', prompt, '--mcp', endpoint, ...])`。
  3. 解析 stdout → `sink.onStatus`；进程退出后扫描 `outputDir` 收集 artifact 文件 → 返回 `LlmGoalResult`。
  4. 超时（timeoutMs）/ 进程失败 → `ok:false` + `error`（不伪造）。
- **`MockLlmBridge`**（测试注入）：按 `goal` 返回固定成功（附一个伪造 artifact）或固定失败，验证 `runGoal` 的接线与 `GoalResult` 收敛。

### 3.5 能力目录上下文构造

`ctx.capabilities.list()` 返回 `CapabilityId[]`（如 `appops.gui.produce`、`gui.screen.capture`…），直接作为 system prompt 的"可用工具清单"喂给 LLM。这样 LLM 只能调用已注册能力，天然受 `declareCapabilities()` ∩ 平台能力 的约束——**开放性与可监管性正交**。

### 3.6 `vm-service` 接入

- `packages/core/src/config/index.ts` → `DEFAULT_SERVICE_CONFIG.agent.providers` 增加：
  ```ts
  'workbuddy': {
    package: '@winvm/adapter-agent-workbuddy-llm',
    options: { runtime: 'codebuddy', cliPath: 'codebuddy', endpoint: 'http://127.0.0.1:18443/mcp', maxConcurrency: 2 },
  },
  ```
- `packages/vm-service/package.json` 增加依赖 `"@winvm/adapter-agent-workbuddy-llm": "0.1.0"`（workspace 解析，使 loader 的 `import()` 可命中）。
- `agent.provider` 默认仍为 `workbuddy-deterministic`；切换为 `workbuddy` 即启用 LLM Agent。

### 3.7 `.env` + 双端一键脚本 `delivery/setup.mjs`

`.env.example`（真实 `.env` 不入库，仅 example）：

```
# 通用
WINVM_SERVICE_PORT=18443

# 宿主机侧（install-host.mjs）
HOST_WORKBUDDY_HOME=
HOST_INSTALL_USER=vmadmin
HOST_DEPLOY=1

# VM 侧（install-vm.mjs）
VM_HOST=192.168.1.50
VM_SSH_PORT=22
VM_USER=vmadmin
VM_DEPLOY_DIR=C:/WinVMBridge
VM_DEPLOY=1
WINVM_VM_PROVIDER=workbuddy-deterministic   # 切 LLM：改为 workbuddy
WINVM_WORKBUDDY_CLI=codebuddy

# SSH 隧道（仅经 127.0.0.1）
WINVM_SETUP_TUNNEL=1
WINVM_TUNNEL_LOCAL_PORT=18443
WINVM_TUNNEL_REMOTE_PORT=18443

# 执行模式：1=只规划；--apply 才真执行
WINVM_DRY_RUN=1
```

`setup.mjs` 流程（DDD Phase 6 部署工具）：

```
1. 解析 .env（无外部依赖的极简解析器；缺失则回退 .env.example）
2. 模式：缺少 --apply 或 WINVM_DRY_RUN=1 → plan（只打印步骤，不改动）
3. PHASE BUILD  ：npm run build（确保 dist 最新）
4. PHASE HOST   ：HOST_DEPLOY=1 → spawn delivery/install-host.mjs（--dry-run / --apply）
5. PHASE VM     ：VM_DEPLOY=1 →
       - 若 VM_HOST 可达(ssh 探测)：scp dist+配置 → VM_DEPLOY_DIR；ssh 运行 install-vm.mjs --apply
       - 否则：打印"在 VM 内手动运行 install-vm.mjs"指引
6. PHASE TUNNEL ：WINVM_SETUP_TUNNEL=1 且 --apply → 后台 ssh -N -L local:127.0.0.1:remote user@host
7. PHASE TEST   ：host dry-run + vm self-test（本地或 ssh）+ 经隧道 curl /health
8. 汇总报告，全部绿则 exit 0
```

---

## 4. 接口定义（契约级）

```ts
// 新增包导出
export function createProvider(options?: WorkbuddyLlmProviderOptions): WorkbuddyLlmProvider;
export interface LlmBridge { runGoal(input: LlmGoalInput, sink: ProgressSink): Promise<LlmGoalResult>; }
```

`GoalResult` / `CapabilityResult` / `ProgressSink` 等沿用 `packages/contracts` 既有定义，**不新增协议字段**。

---

## 5. 测试方案

| 层级 | 用例 | 验证点 |
|---|---|---|
| 单测 | `tests/unit/test-llm-provider.test.js` | registerProviderFactory 注入 MockLlmBridge + 假 executor；`declareCapabilities` 含 6 域；`runGoal` 成功→`ok:true`+artifact+steps；`runGoal` 失败→`ok:false`+error；`execute` 委托到 executor |
| 单测 | `tests/unit/test-setup-env.test.js` | `.env` 解析（含注释/空行/默认值回退）；plan 模式下不触发真实 ssh/build |
| 集成 | `vm-service` 启动切换 | `agent.provider='workbuddy'` 经 loader 成功加载；`/health` 暴露 `provider.id='workbuddy'`、`kind='llm-agent'`；Agent Card `skills[]` 收敛包含 `app-operation` |
| 集成 | 配置校验 | `validateServiceConfig` 对 `workbuddy` entry 通过；未知 provider 仍报错 |
| E2E | `cli --self-test` | 新增 `workbuddy` provider 能力目录校验（catalog 注入 mock 后通过） |
| 部署 | `setup.mjs --dry-run` | 打印 host/vm/tunnel/test 四阶段计划，exit 0，无副作用 |

---

## 6. 风险与取舍

| 项 | 处理 |
|---|---|
| 真实 `codebuddy` CLI 在 VM 外不可用 | `CliLlmBridge` 失败明确报错；测试全用 `MockLlmBridge`，不依赖真实 CLI |
| 与确定性 provider 重复执行链路 | **组合委托** `DeterministicAgentProvider`，零重复、零回归风险 |
| LLM 越权调用未注册能力 | 能力目录由 `declareCapabilities()∩平台` 收敛，system prompt 仅列可用能力 |
| 一键脚本改坏宿主/VM | 默认 `--dry-run`；真实 ssh 改动需 `--apply` 显式确认 |

---

## 7. 文档一致性影响（实现前须先同步）

| 文档 | 同步动作 |
|---|---|
| `docs/02-design/SPEC-AGENT-SERVICE-BRIDGE.md` §6.1 | provider id 由 `workbuddy-llm` 改为 `workbuddy`（对齐用户措辞与实现），标注"V1 已实现" |
| `docs/02-design/ARCHITECTURE.md` | 增加"双 provider（deterministic / workbuddy LLM）"说明 + ADR-10 |
| `docs/05-peripherals/DEPLOYMENT.md` | 增加"双端一键 `setup.mjs` + `.env` + provider 切换" |
| `docs/05-peripherals/SCENARIOS.md` | 增加 `workbuddy` LLM provider 端到端示例（大山→海洋） |
| `docs/06-OVERVIEW.md` | 双 provider、双端一键、1+5 skills 同步 |
| `.dev/` 五大索引 | 本变更原子化登记 |

> 实现严格遵循上述文档；代码不引入文档未定义的 LLM provider 行为。

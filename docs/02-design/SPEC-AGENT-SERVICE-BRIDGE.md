# 标准 Agent 服务桥接转换层规范（SPEC-AGENT-SERVICE-BRIDGE）

| 项 | 值 |
|---|---|
| 文档 ID | SPEC-AGENT-SERVICE-BRIDGE-v1 |
| 版本 | v1.0 |
| 层 | L0 规范（契约）+ L1a 实现（`packages/core/bridge`） |
| 对应用户要求 | **RQ-4**：VM 内 Agent 选型可通过服务/模块/插件形式与全局框架解耦，便于后续转型适配 |
| 日期 | 2026-08-28 |

---

## 1. 目标

定义一套**与具体 Agent 实现无关**的桥接接口（SPI），使得：

- **V1**：VM 内 Agent = `adapter-agent-workbuddy`（确定性轻量执行器）
- **后续**：换成任意 Agent（WorkBuddy LLM Agent / Hermes / 自研 / 其他）只需**新增一个实现包 + 改一行配置**

> **关键澄清（用户最关心的点）**：V1 的"VM Agent = 确定性执行器"是**默认 provider 选型**，
> 不是能力天花板。它**没有 LLM 常识**，只认预置工作流（`appops.workflow.run`）与模板化目标，
> 因此"用 Photoshop 把照片里的大山背景换成海洋"这类**开放/创意类自然语言目标**会被它返回
> `UNSUPPORTED_GOAL`。要让 VM 真正具备"理解开放意图、自主操作任意 Windows 应用"的能力，
> 须把 `agent.provider` 切换为 **LLM Agent provider**（例如把 VM 内的 WorkBuddy `codebuddy`
> CLI 作为 provider 接入，SPI 已支持，框架零改动）。详见 §6.1。
- **不受影响**：`core` / `mcp-framework` / `a2a-framework` / `vm-service` / `skills` / 宿主插件 —— **全部零改动**

---

## 2. 架构位置

```
        MCP Server ─┐
                    ├─► 能力注册表 ─► 策略引擎 ─► 审批闸 ─► 审计链 ─┐
        A2A Server ─┘                                                │
                                                                     ▼
                                        ┌──────────────────────────────────────┐
                                        │  标准 Agent 服务桥接转换层（SPI）      │
                                        │  AgentServiceProvider 接口            │
                                        └───────────────┬──────────────────────┘
                                                        │ 实现（可插拔）
                        ┌───────────────────────────────┼───────────────────────────┐
                        ▼                               ▼                           ▼
        adapter-agent-workbuddy(V1)      adapter-agent-<other>(未来)     adapter-agent-<custom>
        确定性执行器 · 无 LLM 依赖        LLM 驱动自主规划                 任意实现
                        │
                        ▼
            vm-capabilities（ps-bridge → PowerShell）
```

> **关键**：桥接层之上**不知道**下面是 LLM Agent 还是确定性执行器；桥接层之下**不知道**上面是 MCP 还是 A2A。

---

## 3. 核心接口（SPI）

### 3.1 `AgentServiceProvider`

```ts
/** 标准 Agent 服务桥接转换层 —— 所有 VM 内 Agent 实现必须实现的接口 */
export interface AgentServiceProvider {
  /** 实现标识，如 "workbuddy-deterministic" / "workbuddy-llm" */
  readonly id: string;
  /** 人类可读名称 */
  readonly displayName: string;
  /** 提供者类型，用于可观测与路由 */
  readonly kind: 'deterministic' | 'llm-agent' | 'remote-proxy' | 'custom';

  /** 声明本实现能提供的能力（能力 ID 列表，支持通配 "system.*"） */
  declareCapabilities(): CapabilityId[];

  /** 初始化（注入上下文：配置、审计器、策略引擎、能力注册表、日志、traceId 工厂） */
  init(ctx: BridgeContext): Promise<void>;

  /** 执行单个能力调用（已过策略与审批闸） */
  execute(req: CapabilityRequest): Promise<CapabilityResult>;

  /**
   * 规划并执行一个复合目标（A2A 委派入口）。
   * 确定性实现：按内置流程编排能力调用；
   * LLM 实现：自主规划多步并调用能力。
   */
  runGoal(goal: GoalRequest, sink: ProgressSink): Promise<GoalResult>;

  /** 健康检查 */
  health(): Promise<HealthStatus>;

  /** 优雅关闭 */
  shutdown(): Promise<void>;
}
```

### 3.2 `BridgeContext`

```ts
export interface BridgeContext {
  readonly config: BridgeConfig;
  readonly audit: AuditSink;            // 审计写入口（哈希链）
  readonly policy: PolicyEngine;        // 策略判定（供实现自查）
  readonly capabilities: CapabilityRegistry; // 能力注册表（只读）
  readonly logger: Logger;
  newTraceId(): string;
}
```

### 3.3 `CapabilityRequest` / `CapabilityResult`

```ts
export interface CapabilityRequest {
  readonly traceId: string;
  readonly capabilityId: CapabilityId;
  readonly params: Record<string, unknown>; // 已通过 input schema 校验
  readonly risk: RiskLevel;                 // L0-L3，由注册表给出
  readonly approved: boolean;               // 是否已过审批闸
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface CapabilityResult {
  readonly traceId: string;
  readonly ok: boolean;
  readonly data?: unknown;             // 符合 output schema
  readonly error?: BridgeError;        // 结构化错误
  readonly artifacts?: Artifact[];     // 截图/文件/结构化产出（供 A2A artifact）
  readonly durationMs: number;
  readonly auditRef?: string;          // 审计记录 ID
}
```

### 3.4 `GoalRequest` / `GoalResult` / `ProgressSink`

```ts
export interface GoalRequest {
  readonly traceId: string;
  readonly goal: string;               // 自然语言目标
  readonly context?: Record<string, unknown>;
  readonly allowedCapabilities?: CapabilityId[]; // 宿主侧授信范围（最小权限）
  readonly maxRisk?: RiskLevel;        // 本次委派允许的最高风险（默认 L1）
  readonly timeoutMs: number;
}

export interface ProgressSink {
  onStatus(state: TaskState, message?: string): void;   // submitted/working/input-required/...
  onArtifact(artifact: Artifact): void;                 // 截图、日志、变更清单
  onApprovalRequired(req: ApprovalRequest): Promise<boolean>; // 阻塞式审批
}

export interface GoalResult {
  readonly ok: boolean;
  readonly summary: string;
  readonly artifacts: Artifact[];
  readonly steps: GoalStep[];          // 逐步执行记录（可观测，破除"黑盒"）
  readonly error?: BridgeError;
}
```

---

## 4. 能力发现与协商

1. 服务启动时，`vm-service` 加载配置的 provider（`agent.provider`）；
2. 调用 `declareCapabilities()` 得到实现声明的能力（支持 `domain.*` 通配）；
3. 与 `vm-capabilities` 的**平台可用能力**求交集 → 得到**实际暴露能力集**；
4. 用实际能力集生成：
   - MCP 工具列表（`tools/list`）
   - A2A Agent Card 的 `skills[]`
5. 任一能力调用前再过策略引擎（白名单 ∩ 风险分级 ∩ 审批闸）。

> 这样即使换了一个能力更少的 Agent，MCP/A2A 暴露面会自动收缩，**不会暴露未实现的能力**。

---

## 5. 提供者注册与解析（配置驱动）

```jsonc
// vm-service.config.json
{
  "agent": {
    "provider": "workbuddy-deterministic",     // ← 换 Agent 只需改这一行
    "providers": {
      "workbuddy-deterministic": {
        "package": "@winvm/adapter-agent-workbuddy",
        "options": {
          "maxConcurrency": 4,
          "enableLlmPlanning": false           // V1 关闭，后续可开
        }
      }
    }
  }
}
```

解析流程：`provider → package → 动态 import → new Provider() → init(ctx)`。

**失败处理**：provider 未找到 / init 失败 → 服务进入 `degraded`，MCP/A2A 仅暴露 `meta.*` 能力并明确报错，**绝不静默降级为无限制执行**。

---

## 6. V1 实现：`adapter-agent-workbuddy`

| 项 | 设计 |
|---|---|
| `id` | `workbuddy-deterministic` |
| `kind` | `deterministic` |
| 是否依赖 LLM | **否**（V1） |
| `execute` | 直接把能力调用路由到 `vm-capabilities` 的 PowerShell 实现 |
| `runGoal` | 按内置**目标模板**编排（如"安装应用" = search → install → verify → artifact 变更清单）；模板外目标返回 `unsupported-goal` 并建议宿主改走 MCP 逐步调用 |
| 为什么 V1 不用 LLM | 确定性、省资源、可预测、易审计，符合"最可靠/最可监管"；LLM 规划留作后续可选增强（配置 `enableLlmPlanning`） |
| 已声明能力域 | `meta.*` `system.*` `app.*` `storage.*` `gui.*` **`appops.*`**（应用生产操作，见 CAPABILITY-MODEL §3.5） |

> **这正是 RQ-4 的价值所在**：V1 用轻量确定性执行器先把链路打通并验证，后续要升级为真正的 LLM Agent，只需新增一个 provider 实现，框架一行不动。

### 6.1 开放任务与 LLM Provider（用户核心诉求落点）

**问题**：用户要的是"在 Windows 里用 Photoshop 帮我把这张照片里的大山背景 PS 成海洋"这类**开放/创意类自然语言任务**——任务没有预置脚本、需要理解语义、需要自主规划多步、需要在 GUI 里实时看屏幕决策。这类任务属于**应用生产操作（appops）**维度，正是原始 4 个 Skill 漏掉的那一维。

**V1 为什么直接做不了**：`workbuddy-deterministic` 是**确定性执行器**，没有 LLM 常识，只认预置工作流与模板化目标。对于"把大山换成海洋"这种没有现成 `.ps1` 工作流匹配的目标，它会返回 `UNSUPPORTED_GOAL`（见 `adapter-agent-workbuddy` 模板 5：工作流未登记时明确引导，不硬猜、不伪造）。这是**设计使然**，不是缺陷。

**如何补齐（框架零改动）**：把 `agent.provider` 从 `workbuddy-deterministic` 切换为 **`workbuddy`（LLM Agent provider）** 即可。SPI 已原生支持，不需要改 `core` / `mcp-framework` / `a2a-framework` / `vm-service` / `skills` 任何一行业务代码。**该选型在 V1 已实现**（见 `packages/adapter-agent-workbuddy-llm`，`id='workbuddy'`、`kind='llm-agent'`；完整设计见 `LLM-PROVIDER.md`）。

```jsonc
// vm-service.config.json（升级为 LLM VM Agent）
{
  "agent": {
    "provider": "workbuddy",               // 切换这一行（V1 选型值 = workbuddy）
    "providers": {
      "workbuddy": {
        "package": "@winvm/adapter-agent-workbuddy-llm",
        "options": {
          "maxConcurrency": 2,
          "runtime": "codebuddy",           // 复用 VM 内 WorkBuddy `codebuddy` CLI 作为推理运行时
          "endpoint": "http://127.0.0.1:18443/mcp"  // LLM 运行时回连本服务 /mcp 调用能力
        }
      }
    }
  }
}
```

**LLM VM Agent 接管开放任务后的执行闭环**（以"大山→海洋"为例）：

```
用户（宿主机）→ A2A message/send {"goal":"用 Photoshop 把这张照片的大山换成海洋"}
        │
        ▼
V1 LLM VM Agent（运行在 VM 交互式会话内，带 PS/Office/浏览器等应用 skill）
  1. 解析意图：目标=图像合成；应用=Photoshop；输入=宿主传来的图片 artifact
  2. 规划多步：打开 PS → 载入图片 → 选区/蒙版分离天空 → 生成海洋素材 →
     合成 → 调色 → 导出 → 回传
  3. 逐步执行：每步调用 appops.gui.produce / appops.com.automate / gui.* 能力
     （底层仍是 ps-bridge → PowerShell → UIA / COM，与 V1 共用同一安全内核）
  4. 进度流 + artifact：每步回传截图/中间产物（A2A artifact），宿主可中途审批/叫停
        │
        ▼
A2A tasks/get / stream → 返回：成功摘要 + 前后对比图 + 导出文件 artifact
```

**关键点**：

1. **appops 是"生产维度"的契约落点**。无论 V1 确定性还是后续 LLM provider，应用生产操作都收敛到 `appops.*` 五大能力（`appops.state.query` / `cli.invoke` / `workflow.run` / `com.automate` / `gui.produce`，见 CAPABILITY-MODEL §3.5）。LLM provider 比 V1 多做的，是**在 appops 之上叠加语义理解与自主规划**——能力内核不变，只是"谁来决定调哪个能力"从模板匹配变成了 LLM 规划。
2. **V1 与 LLM 不是二选一，而是渐进增强**。V1 把 `MCP 直调` + `A2A 委派` + 安全内核 + 监管闭环全部验证通；LLM provider 只是把 `runGoal` 的"模板编排"换成"LLM 规划"，确定性路径（MCP 精确调用）始终可用。
3. **监管不降级**：LLM 自主规划的所有步骤仍逐条过策略引擎/审批闸/审计链，before/after 快照仍强制回传。LLM 带来"开放性"，框架带来"可监管性"，二者正交。
4. **宿主侧零感知**：A2A Agent Card 的 `skills[]` 由 `declareCapabilities()` 自动收敛，宿主无需关心 VM 内是确定性还是 LLM——协议层完全一致。

> **结论（回应 Q2）**：用户要的"VM AI Agent 强大 Windows 系统与操作能力"，在本架构里 = **appops 域（生产维度）+ LLM provider（开放任务大脑）**。V1 默认确定性是为了最可靠、最可监管地先把链路跑通；要不要开放给 LLM 自主操作任意应用，是一行配置的事，且随时可回退到确定性。

---

## 7. 兼容性保证

| 保证 | 机制 |
|---|---|
| 接口稳定 | 接口定义在 `packages/contracts`，变更需走版本化（`v1` → `v2` 可并存） |
| 实现可插拔 | 动态 import + 配置驱动，无编译期硬绑定 |
| 能力面自动收敛 | `declareCapabilities()` ∩ 平台可用能力 |
| 失败不失控 | provider 异常 → `degraded` + 仅 `meta.*` + 明确报错 |
| 审计不绕过 | 审计与策略在**桥接层之上**，任何 provider 都无法绕过 |

---

## 8. 替换检查清单（后续换 Agent 时逐项确认）

- [ ] 新 provider 实现 `AgentServiceProvider` 全部方法
- [ ] `declareCapabilities()` 如实声明（**不得声明未实现的能力**）
- [ ] `runGoal` 通过 `ProgressSink` 回传进度与 artifact（破除黑盒，满足 NFR-509）
- [ ] `execute` 遵守 `timeoutMs` 与 `AbortSignal`
- [ ] 高危操作经 `ProgressSink.onApprovalRequired` 请求审批，**不得自行放行**
- [ ] 配置项 `agent.provider` 切换后，MCP 工具列表与 Agent Card 正确收敛
- [ ] 契约测试通过（provider 契约测试套件）

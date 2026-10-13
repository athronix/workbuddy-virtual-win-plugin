/**
 * M7（Phase 3 批4 · audit §3.2 M7）：provider 能力画像的**派生纯函数**。
 *
 * 病灶（PM §3）：hermes-agent 静默缺失三项安全/运维特性（无审批真值反查、无常驻会话预热、
 * 无 approvalTruth 层），而它与 workbuddy-llm **同为 `kind='llm-agent'`** ⇒ 若按 kind 硬分
 * 判能力，正是 M7 要消灭的「用户以为安全特性跟 provider kind 走」的静默降级。
 *
 * 处方：能力画像**派生自 provider SPI 可选成员的方法存在性**（同步自省，非 kind 猜、非
 * 触 health()）——实现即 true、未实现即 false。三键各绑定一个既有可选成员，零新增 SPI 面
 * （provider SPI 零改动红线不破）：
 *   - `persistentSession` ← `llmSessionHealth?()`（CL-018 C1 LLM 常驻会话健康快照）；
 *   - `warmup`           ← `warmup?()`（K2 冷启动预热）；
 *   - `approvalTruth`    ← 已算好的 `providerHealth.approvalTruth`（CL-K3R 三态指纹；
 *                          provider 不回报 ⇒ null，与 mode 缺省区分「没启用」vs「shadow 未命中」）。
 *
 * 抽成纯函数（而非内联 buildHealth）= 可离线注入 mock provider 直接断言三键派生，
 * 兑现「证明有效而非确认存在」。
 */

/** 结构子集：只依赖 SPI 的可选成员与方法，避免全量 AgentServiceProvider 依赖（易测 + 低耦合）。 */
export interface ProviderProfileSource {
  readonly kind: string;
  readonly llmSessionHealth?: (() => unknown) | undefined;
  readonly warmup?: (() => unknown) | undefined;
}

/** 已算好的 provider 健康顶层的 approvalTruth 三元组形状（取自 contracts HealthStatus.approvalTruth）。 */
export interface ApprovalTruthTriple {
  readonly mode: 'on' | 'shadow' | 'off';
  readonly enabled: boolean;
  readonly shadow: boolean;
}

export interface CapabilitiesProfile {
  readonly kind: string;
  readonly persistentSession: boolean;
  readonly warmup: boolean;
  readonly approvalTruth: ApprovalTruthTriple | null;
}

/**
 * 派生能力画像。`provider=null/undefined`（degraded）⇒ 调用方整块缺席本键（PM 判据
 * 「provider 未加载 ⇒ 该键缺席」），故本函数签名要求 provider 在场；调用点以
 * `...(provider ? { capabilitiesProfile: deriveCapabilitiesProfile(...) } : {})` 保证缺席语义。
 */
export function deriveCapabilitiesProfile(
  provider: ProviderProfileSource,
  providerApprovalTruth?: ApprovalTruthTriple | undefined,
): CapabilitiesProfile {
  return {
    kind: provider.kind,
    persistentSession: typeof provider.llmSessionHealth === 'function',
    warmup: typeof provider.warmup === 'function',
    approvalTruth: providerApprovalTruth ?? null,
  };
}

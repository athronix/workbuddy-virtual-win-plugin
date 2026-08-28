/**
 * 标准 Agent 服务桥接转换层 SPI（SPEC-AGENT-SERVICE-BRIDGE.md）
 *
 * 这是「VM 内 Agent 可替换」的核心契约：
 *   桥接层之上不知道下面是 LLM Agent 还是确定性执行器；
 *   桥接层之下不知道上面是 MCP 还是 A2A。
 */

import type { BridgeError } from './errors.js';
import type { CapabilityId, CapabilityPolicy } from './capability.js';
import type { RiskLevel } from './risk.js';
import type { AuditRecord } from './audit.js';

/** A2A v1.0 任务状态 */
export type TaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'rejected';

export const TERMINAL_TASK_STATES: readonly TaskState[] = [
  'completed',
  'failed',
  'canceled',
  'rejected',
] as const;

export function isTerminalTaskState(s: TaskState): boolean {
  return TERMINAL_TASK_STATES.includes(s);
}

/** 会话健康状态 */
export type SessionState = 'healthy' | 'degraded' | 'unavailable' | 'black-screen';

export interface SessionHealth {
  readonly sessionId: number;
  readonly windowStation: string;
  readonly desktop: string;
  readonly interactive: boolean;
  readonly locked: boolean;
  readonly blackScreen: boolean;
  readonly state: SessionState;
  readonly detail?: string;
}

export type ProviderState = 'ready' | 'degraded' | 'unavailable';

export interface HealthStatus {
  readonly ok: boolean;
  readonly provider: { readonly id: string; readonly state: ProviderState; readonly detail?: string };
  readonly session: SessionHealth;
  readonly psBridge?: { readonly state: ProviderState; readonly uptimeMs: number; readonly pending: number };
  readonly capabilities?: { readonly count: number; readonly available: number };
  readonly audit?: { readonly entries: number; readonly chainValid: boolean };
}

/** 产出物（A2A artifact / MCP artifacts） */
export interface Artifact {
  readonly kind: 'screenshot' | 'change-list' | 'console-log' | 'steps' | 'file';
  readonly name: string;
  readonly mime: string;
  /** base64（二进制）或原始文本/对象（结构化） */
  readonly data: string | Record<string, unknown>;
  readonly encoding?: 'base64' | 'utf8' | 'json';
}

export interface ApprovalRequest {
  readonly approvalId: string;
  readonly capabilityId: CapabilityId;
  readonly risk: RiskLevel;
  readonly summary: string;
  /** dry-run 预览：将影响什么 */
  readonly preview: Record<string, unknown>;
  readonly impact: readonly string[];
}

export interface CapabilityRequest {
  readonly traceId: string;
  readonly capabilityId: CapabilityId;
  /** 已通过 input schema 校验 */
  readonly params: Record<string, unknown>;
  readonly risk: RiskLevel;
  /** 是否已过审批闸 */
  readonly approved: boolean;
  readonly approvalId?: string;
  readonly timeoutMs: number;
}

export interface CapabilityResult {
  readonly traceId: string;
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: BridgeError;
  readonly artifacts?: readonly Artifact[];
  readonly durationMs: number;
  readonly auditRef?: string;
}

export interface GoalRequest {
  readonly traceId: string;
  /** 自然语言目标 */
  readonly goal: string;
  readonly context?: Record<string, unknown>;
  /** 本次委派允许的能力范围（最小权限） */
  readonly allowedCapabilities?: readonly CapabilityId[];
  /** 本次委派允许的最高风险（默认 L1） */
  readonly maxRisk?: RiskLevel;
  readonly timeoutMs: number;
}

export interface GoalStep {
  readonly index: number;
  readonly capabilityId: CapabilityId;
  readonly params: Record<string, unknown>;
  readonly ok: boolean;
  readonly risk: RiskLevel;
  readonly durationMs: number;
  readonly traceId: string;
  readonly summary?: string;
  readonly error?: BridgeError;
}

export interface GoalResult {
  readonly ok: boolean;
  readonly summary: string;
  readonly artifacts: readonly Artifact[];
  /** 逐步执行记录 —— 破除"委派黑盒"（NFR-509） */
  readonly steps: readonly GoalStep[];
  readonly error?: BridgeError;
}

export interface ProgressSink {
  onStatus(state: TaskState, message?: string): void;
  onArtifact(artifact: Artifact): void;
  /** 阻塞式审批；返回 false 表示拒绝，实现必须中止 */
  onApprovalRequired(req: ApprovalRequest): Promise<boolean>;
}

export interface AuditSink {
  append(record: Omit<AuditRecord, 'hash' | 'prevHash' | 'seq'>): Promise<AuditRecord>;
  verifyChain(): Promise<{ valid: boolean; brokenAt?: number; entries: number }>;
}

export interface PolicyVerdict {
  readonly allowed: boolean;
  readonly matchedRule: string;
  readonly requiresApproval: boolean;
  readonly error?: BridgeError;
}

export interface PolicyEvaluateInput {
  readonly capabilityId: CapabilityId;
  readonly params: Record<string, unknown>;
  readonly risk: RiskLevel;
  readonly approved: boolean;
  readonly approvalId?: string;
  readonly maxRisk?: RiskLevel;
  readonly allowedCapabilities?: readonly CapabilityId[];
  /** 能力自带策略覆盖 */
  readonly capabilityPolicy?: CapabilityPolicy;
}

export interface PolicyEngine {
  evaluate(req: PolicyEvaluateInput): PolicyVerdict;
}

export interface CapabilityRegistryView {
  get(id: CapabilityId): { readonly risk: RiskLevel; readonly requiresSession: boolean } | undefined;
  list(): readonly CapabilityId[];
  has(id: CapabilityId): boolean;
}

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface BridgeContext {
  readonly config: Record<string, unknown>;
  readonly audit: AuditSink;
  readonly policy: PolicyEngine;
  readonly capabilities: CapabilityRegistryView;
  readonly logger: Logger;
  newTraceId(): string;
}

/** 提供者类型 */
export type ProviderKind = 'deterministic' | 'llm-agent' | 'remote-proxy' | 'custom';

/**
 * 所有 VM 内 Agent 实现必须实现的接口。
 * V1: adapter-agent-workbuddy（确定性执行器）
 */
export interface AgentServiceProvider {
  readonly id: string;
  readonly displayName: string;
  readonly kind: ProviderKind;

  /** 声明本实现能提供的能力。支持 `domain.*` 通配。不得声明未实现的能力。 */
  declareCapabilities(): readonly CapabilityId[];

  init(ctx: BridgeContext): Promise<void>;
  execute(req: CapabilityRequest): Promise<CapabilityResult>;
  runGoal(goal: GoalRequest, sink: ProgressSink): Promise<GoalResult>;
  health(): Promise<HealthStatus>;
  shutdown(): Promise<void>;
}

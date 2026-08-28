/**
 * 统一能力模型（CAPABILITY-MODEL.md）
 *
 * 能力是全系统的最小语义单元：MCP 工具、A2A Skill、PowerShell 实现、
 * 策略规则 —— 全部围绕同一份能力定义展开。
 */

import type { RiskLevel } from './risk.js';
import { parseRiskLevel, requiresApprovalByDefault } from './risk.js';

export type CapabilityDomain = 'system' | 'app' | 'storage' | 'gui' | 'appops' | 'meta';

export const CAPABILITY_DOMAINS: readonly CapabilityDomain[] = [
  'system',
  'app',
  'storage',
  'gui',
  'appops',
  'meta',
] as const;

/** 能力 ID，形如 `system.service.control`。支持通配匹配 `system.*`。 */
export type CapabilityId = string;

export interface CapabilityPolicy {
  /** 命令白名单（正则字符串）。未命中即拒绝（拒绝优先）。 */
  readonly commandAllowlist?: readonly string[];
  /** 命令黑名单（正则字符串）。优先级最高，命中即拒。 */
  readonly commandDenylist?: readonly string[];
  /** 路径白名单（glob 前缀）。 */
  readonly pathAllowlist?: readonly string[];
  /** 路径黑名单（glob 前缀）。优先级最高，命中即拒。 */
  readonly pathDenylist?: readonly string[];
  /** 禁止操作的进程名（小写）。 */
  readonly processDenylist?: readonly string[];
  /** 允许写入的注册表根键前缀。 */
  readonly registryWriteAllowlist?: readonly string[];
}

export type SnapshotPolicy = 'none' | 'after' | 'before-after';

export interface CapabilityDefinition {
  readonly id: CapabilityId;
  readonly domain: CapabilityDomain;
  readonly name: string;
  readonly description: string;
  readonly risk: RiskLevel;
  readonly idempotent: boolean;
  /** 是否依赖 Windows 交互式会话（GUI 能力为 true）。会话不可用时直接报错，不静默失败。 */
  readonly requiresSession: boolean;
  /** 是否强制审批。未指定时由 risk 推导（L2/L3 → true）。 */
  readonly requiresApproval?: boolean;
  readonly destructive: boolean;
  readonly timeoutMs: number;
  readonly input: Record<string, unknown>; // JSON Schema
  readonly output: Record<string, unknown>; // JSON Schema
  readonly policy?: CapabilityPolicy;
  readonly audit: { readonly snapshot: SnapshotPolicy };
  readonly implementation: {
    readonly kind: 'powershell' | 'native' | 'external';
    readonly module: string;
    readonly function: string;
  };
}

export interface ParsedCapabilityId {
  readonly domain: CapabilityDomain;
  readonly group: string;
  readonly action: string;
}

export class InvalidCapabilityIdError extends Error {
  constructor(readonly input: string) {
    super(
      `Invalid capability id: "${input}". Expected "<domain>.<group>.<action>" ` +
        `where domain in [${CAPABILITY_DOMAINS.join(', ')}]`,
    );
    this.name = 'InvalidCapabilityIdError';
  }
}

export function parseCapabilityId(id: CapabilityId): ParsedCapabilityId {
  const parts = id.split('.');
  if (parts.length !== 3) throw new InvalidCapabilityIdError(id);
  const [domain, group, action] = parts as [string, string, string];
  if (!(CAPABILITY_DOMAINS as readonly string[]).includes(domain)) {
    throw new InvalidCapabilityIdError(id);
  }
  if (!group || !action) throw new InvalidCapabilityIdError(id);
  return { domain: domain as CapabilityDomain, group, action };
}

/**
 * 通配匹配：pattern 支持 `system.*`（域级）与精确 ID。
 * `*` 仅允许出现在末尾，避免歧义。
 */
export function matchesCapability(pattern: CapabilityId, id: CapabilityId): boolean {
  if (pattern === id) return true;
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -1); // 保留结尾的点，如 "system."
    return id.startsWith(prefix);
  }
  return false;
}

/** 该能力是否必须走审批闸 */
export function capabilityRequiresApproval(cap: CapabilityDefinition): boolean {
  return cap.requiresApproval ?? requiresApprovalByDefault(cap.risk);
}

/** 从 JSON 数据构造能力定义（做必要的规范化与校验） */
export function defineCapability(
  def: Omit<CapabilityDefinition, 'domain'> & { domain?: CapabilityDomain },
): CapabilityDefinition {
  const parsed = parseCapabilityId(def.id);
  const domain = def.domain ?? parsed.domain;
  if (domain !== parsed.domain) {
    throw new InvalidCapabilityIdError(
      `${def.id}: declared domain "${domain}" conflicts with id prefix "${parsed.domain}"`,
    );
  }
  return {
    ...def,
    domain,
    risk: typeof def.risk === 'string' ? parseRiskLevel(def.risk) : def.risk,
  };
}

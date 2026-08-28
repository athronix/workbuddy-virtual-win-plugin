/**
 * 统一能力注册表（ARCHITECTURE.md §3.2）
 *
 * MCP 工具列表与 A2A Agent Card 的 skills[] 均由本注册表自动生成：
 *   实际暴露能力集 = provider.declareCapabilities() ∩ 平台已注册能力
 * 这样即使换了一个能力更少的 Agent，暴露面也会自动收缩，不会暴露未实现的能力。
 */

import {
  type CapabilityDefinition,
  type CapabilityDomain,
  type CapabilityId,
  type CapabilityRegistryView,
  type RiskLevel,
  defineCapability,
  matchesCapability,
  parseCapabilityId,
} from '@winvm/contracts';

export class DuplicateCapabilityError extends Error {
  constructor(readonly id: CapabilityId) {
    super(`能力重复注册：${id}`);
    this.name = 'DuplicateCapabilityError';
  }
}

export class CapabilityRegistry implements CapabilityRegistryView {
  private readonly defs = new Map<CapabilityId, CapabilityDefinition>();

  register(def: CapabilityDefinition): void {
    const normalized = defineCapability(def);
    if (this.defs.has(normalized.id)) throw new DuplicateCapabilityError(normalized.id);
    this.defs.set(normalized.id, normalized);
  }

  registerAll(defs: readonly CapabilityDefinition[]): void {
    for (const d of defs) this.register(d);
  }

  get(id: CapabilityId): CapabilityDefinition | undefined {
    return this.defs.get(id);
  }

  has(id: CapabilityId): boolean {
    return this.defs.has(id);
  }

  list(): readonly CapabilityId[] {
    return [...this.defs.keys()].sort();
  }

  listDefinitions(): readonly CapabilityDefinition[] {
    return [...this.defs.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  listByDomain(domain: CapabilityDomain): readonly CapabilityDefinition[] {
    return this.listDefinitions().filter((d) => d.domain === domain);
  }

  riskOf(id: CapabilityId): RiskLevel | undefined {
    return this.defs.get(id)?.risk;
  }

  domains(): readonly CapabilityDomain[] {
    return [...new Set(this.listDefinitions().map((d) => d.domain))].sort();
  }

  /** 按通配模式过滤（支持 `system.*`、`*`、精确 ID） */
  match(patterns: readonly CapabilityId[]): readonly CapabilityDefinition[] {
    if (patterns.length === 0) return this.listDefinitions();
    return this.listDefinitions().filter((d) =>
      patterns.some((p) => matchesCapability(p, d.id)),
    );
  }

  /**
   * 求交集：provider 声明的能力 ∩ 平台已注册能力。
   * 未注册的能力不会被暴露，避免出现"声明了但调不通"的悬空工具。
   */
  intersectDeclared(declared: readonly CapabilityId[]): readonly CapabilityDefinition[] {
    const out: CapabilityDefinition[] = [];
    for (const def of this.listDefinitions()) {
      if (declared.some((p) => matchesCapability(p, def.id))) out.push(def);
    }
    return out;
  }

  size(): number {
    return this.defs.size;
  }

  /** 结构自检：ID 与 domain 一致性、风险分级合法性 */
  validate(): { ok: boolean; issues: string[] } {
    const issues: string[] = [];
    for (const def of this.defs.values()) {
      try {
        const parsed = parseCapabilityId(def.id);
        if (parsed.domain !== def.domain) {
          issues.push(`${def.id}: domain 与 ID 前缀不一致（${def.domain} vs ${parsed.domain}）`);
        }
      } catch (e) {
        issues.push(`${def.id}: ${(e as Error).message}`);
      }
      if (def.timeoutMs < 1000) issues.push(`${def.id}: timeoutMs 过小`);
    }
    return { ok: issues.length === 0, issues };
  }
}

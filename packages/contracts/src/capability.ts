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

/**
 * 能力级策略覆盖（与全局 `PolicyConfig` 同族字段，经 `mergePolicy` 并集后生效）。
 *
 * ARCH-18 裁断（owner 已终裁 = **删除**）：本类型**不再有** `commandAllowlist`。
 * 原字段（正则字符串数组，「未命中即拒绝」）自始至终是**死配置** ——
 * `core/src/policy/engine.ts` 把它编译成 `cmdAllowRe` 之后**零消费**（Phase 0 审计已证实，
 * 全仓 grep `cmdAllowRe` 除声明与赋值外无任何读取点），于是「命令面有白名单」成了一个
 * **沉默的虚假安全感**（体检 D-3 列为最危险的一类）。
 *
 * 为什么删而不实现：① 判据只能落在「命令式字符串」上，而引擎识别命令式参数是启发式
 * （`COMMAND_KEY_RE` + `looksLikeCommandValue`），同一张网既漏又误；② 白名单一旦非空即
 * 「未命中 → 硬 DENY」，而命中面覆盖 `arguments`/`script`/`goal` 等所有 commandish 串
 * ⇒ 巡检/卸载/生产三域现有流程面临随机 DENY，误杀只能在真机暴露；③ 解释器准入**已有更强
 * 机制**（`appops.cli.invoke` 的 `input.app` JSON Schema enum + provider `validateParams`
 * 早于执行），运行时正则反而是降级。
 *
 * 兑现后的口径：**命令面只有黑名单**（`commandDenylist`，优先级最高、命中即拒）；
 * 解释器/脚本准入由**注册表枚举 + 登记期静态校验**把守，不进运行时字符串正则
 * （文档口径同步：`docs/02-design/CAPABILITY-MODEL.md`、SECURITY §3.2，属 T5）。
 */
export interface CapabilityPolicy {
  /** 命令黑名单（正则字符串）。优先级最高，命中即拒。命令面**只有**黑名单（ARCH-18）。 */
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

/**
 * 审计快照策略 —— **信息性声明**（Q2 裁决 2026-10-10：Phase 2 · P2-T3 降级为信息性，
 * **不实现** before/after 快照）。
 *
 * 兑现口径（三侧，缺一不可，`tests/unit/phase2-snapshot-truth.test.js` 逐侧钉死）：
 * - 交付面：注册期形状约束在场 —— `capability.schema.json` 的 allOf 条件约束
 *   「risk ∈ {L2, L3} ⇒ `audit.snapshot` ≠ `'none'`」由 `schema-check.ts` 的
 *   `validateCapabilityShape` 在**测试/门禁面**消费（P2-T1，裁决 Q1=(b)：运行期不校验）；
 * - 运行面：**零消费** —— core / vm-service / adapter-* / delivery / psmod 无任何读取点，
 *   执行体不产出快照；
 * - 承载面：`contracts/src/audit.ts` 的 `AuditRecord` / `AuditExt` **没有**承载快照的字段
 *   （缺口比审计 ARCH-04 记的更深一层：不是"有声明位没人读"，而是连落快照的字段都不存在）。
 *
 * ⚠ 改本类型或增删声明位前须同步：SECURITY §3.2 表「L2/L3 是否强制快照」行与 phase2-snapshot-truth。
 */
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
  /**
   * U-P0-3（A1 **服务端能力声明制**）：本能力的 `dryRun` 是否由**服务端实现真实支持**
   * （只返回执行计划、绝不改动系统状态）。
   *
   * 为什么必须由服务端声明、而不是看调用方传了什么（体检 U-P0-3 / 测试文档审计 §2-QA-11）：
   * 策略引擎的 dry-run 免审批旁路旧实现只判 `params.dryRun === true`，而这个参数是**调用方
   * 自报**的 —— 任何 L2/L3 能力附带 `dryRun:true` 即可跳过人工审批真实执行，免批决策权落在
   * 不受信的调用方手里（等同绕过审批闸）。本字段把「哪些能力可以免批」的权威收回服务端：
   * 只有注册表里逐条标注 `supportsDryRun: true` 的能力才享受免批；未标注（`undefined`/`false`）
   * 的能力传 `dryRun` **不再免批**，回落 `approval-required`（fail-closed）。
   *
   * 标注纪律（与 `REG_CANON` 根键准入清单同构 —— 表里既是映射也是准入）：
   * 只允许给**实现体确凿返回计划而不改动状态**的能力标 true（psmod 侧必须有 `$DryRun` 分支，
   * 如 `app.ps1` 的 `Get-UninstallDryRunPlan`、`storage.ps1` 的 `Remove-FileSystemItem` 预估、
   * `system.ps1` 的 `Invoke-PowerControl`）。新增一条标注等于新增一条免审批通道，必须在
   * code review / grep 中显形。
   */
  readonly supportsDryRun?: boolean;
  readonly destructive: boolean;
  readonly timeoutMs: number;
  readonly input: Record<string, unknown>; // JSON Schema
  readonly output: Record<string, unknown>; // JSON Schema
  readonly policy?: CapabilityPolicy;
  /**
   * **信息性声明**（Q2 裁决 2026-10-10，详见 `SnapshotPolicy` 头注）：必填形状约束保留
   * 并被交付面 schema 校验消费（L2/L3 ⇒ 非 `'none'`），**运行期零消费、不产快照**。
   * definitions.ts 的 26 处能力级标注作为声明数据保留，不删。
   */
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

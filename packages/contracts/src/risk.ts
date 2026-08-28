/**
 * 风险分级模型（NFR-504）
 *
 * L0 只读       —— 不改变系统状态
 * L1 可回滚写   —— 状态改变但可撤销
 * L2 破坏性     —— 不可逆或影响面大，需人工审批
 * L3 关键/高危  —— 可能导致系统不可用或数据全损，需审批 + 二次确认 + dry-run 前置
 */

export type RiskLevel = 'L0' | 'L1' | 'L2' | 'L3';

export const RISK_LEVELS: readonly RiskLevel[] = ['L0', 'L1', 'L2', 'L3'] as const;

/** 风险序号，用于比较大小。数字越大风险越高。 */
const RISK_ORDER: Record<RiskLevel, number> = { L0: 0, L1: 1, L2: 2, L3: 3 };

export function riskOrder(risk: RiskLevel): number {
  return RISK_ORDER[risk];
}

/** a 的风险是否 >= b */
export function riskAtLeast(a: RiskLevel, b: RiskLevel): boolean {
  return RISK_ORDER[a] >= RISK_ORDER[b];
}

/** 取两者中风险更高者 */
export function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

/** 是否必须走人工审批闸（L2/L3 为 true） */
export function requiresApprovalByDefault(risk: RiskLevel): boolean {
  return riskAtLeast(risk, 'L2');
}

/** 是否在宿主侧建议静态禁用（disabledTools） */
export function shouldSuggestHostDisable(risk: RiskLevel): boolean {
  return riskAtLeast(risk, 'L2');
}

export class InvalidRiskLevelError extends Error {
  constructor(readonly input: string) {
    super(`Invalid risk level: ${input}. Expected one of ${RISK_LEVELS.join(', ')}`);
    this.name = 'InvalidRiskLevelError';
  }
}

export function parseRiskLevel(input: string): RiskLevel {
  const v = input.trim().toUpperCase() as RiskLevel;
  if (!RISK_LEVELS.includes(v)) throw new InvalidRiskLevelError(input);
  return v;
}

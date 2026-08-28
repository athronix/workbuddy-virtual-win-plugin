/**
 * 策略引擎（SECURITY-GOVERNANCE.md §3）
 *
 * 判定顺序（黑名单优先级最高，拒绝优先）：
 *   1. 能力未注册                 → POLICY_DENIED
 *   2. 命中路径黑名单             → POLICY_DENIED（立即）
 *   3. 命中命令黑名单             → POLICY_DENIED（立即）
 *   4. 未命中白名单               → POLICY_DENIED
 *   5. 超出本次 maxRisk           → POLICY_DENIED
 *   6. 风险 ≥ L2 且未审批         → APPROVAL_REQUIRED
 *   7. 通过
 */

import {
  type CapabilityId,
  type CapabilityPolicy,
  type PolicyVerdict,
  type PolicyEngine,
  type RiskLevel,
  type CapabilityRegistryView,
  makeError,
  matchesCapability,
  riskAtLeast,
} from '@winvm/contracts';

import { type PolicyConfig, DEFAULT_POLICY, mergePolicy } from './defaults.js';

/* ------------------------------ glob → regex ------------------------------ */

/** Windows 路径 glob：`**` 跨分隔符，`*` 不跨分隔符，大小写不敏感 */
export function globToRegex(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i++;
      } else {
        re += '[^\\\\/]*';
      }
    } else if (c === '?') {
      re += '[^\\\\/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`, 'i');
}

/* ------------------------------ 参数采集 ------------------------------ */

export interface StringValue {
  readonly key: string;
  readonly value: string;
}

/** 递归收集参数中的所有字符串值，附带其键名（用于判定是否为路径/命令类字段） */
export function collectStringValues(
  params: Record<string, unknown>,
  prefix = '',
  out: StringValue[] = [],
): StringValue[] {
  for (const [k, v] of Object.entries(params)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') {
      out.push({ key, value: v });
    } else if (Array.isArray(v)) {
      v.forEach((item, idx) => {
        if (typeof item === 'string') out.push({ key: `${key}[${idx}]`, value: item });
        else if (item && typeof item === 'object')
          collectStringValues(item as Record<string, unknown>, `${key}[${idx}]`, out);
      });
    } else if (v && typeof v === 'object') {
      collectStringValues(v as Record<string, unknown>, key, out);
    }
  }
  return out;
}

const DRIVE_RE = /^[a-z]:[\\/]/i;
const UNC_RE = /^\\\\/;
const SEP_RE = /[\\/]/;
const REG_RE = /^(HK[A-Z_]+|HKEY_[A-Z_]+)[:\\/]/i;

/** 字符串是否像一个文件系统路径 */
export function looksLikePath(s: string): boolean {
  return DRIVE_RE.test(s) || UNC_RE.test(s) || (SEP_RE.test(s) && s.length > 2);
}

/** 字符串是否像注册表路径 */
export function looksLikeRegistryPath(s: string): boolean {
  return REG_RE.test(s);
}

/** 参数键名是否为命令/脚本类字段 */
const COMMAND_KEY_RE = /\b(command|cmd|script|expression|powershell|shell|exec|args|arguments)\b/i;

/**
 * 从命令串中提取路径片段。
 *
 * 必要性：`Get-ChildItem C:\Windows` 整体不是路径，但内嵌的 `C:\Windows` 必须受路径策略约束。
 * 若不提取而直接跳过，命令就成了绕过路径白名单的后门；
 * 若把整条命令当路径比对，又会把 `Get-ChildItem C:\Users\a` 这类合法调用误杀。
 */
export function extractPathTokens(s: string): string[] {
  const out: string[] = [];
  const patterns = [
    /[A-Za-z]:\\[^\s"'`;,|)]+/g, // 盘符路径
    /\\\\\?\\[^\s"']+/g, // \\?\ 前缀
    /\\\\[A-Za-z0-9._$-]+\\[^\s"']+/g, // UNC
    /(?:HK[A-Z_]+|HKEY_[A-Z_]+):?\\[^\s"']+/gi, // 注册表路径
  ];
  for (const re of patterns) {
    const matches = s.match(re);
    if (matches) out.push(...matches);
  }
  return out;
}

/** 取某个参数值需要接受**文件系统**路径策略检查的候选路径列表 */
function pathCandidates(key: string, value: string): string[] {
  const isCommandish = COMMAND_KEY_RE.test(key) || looksLikeCommandValue(value);
  const raw = isCommandish ? extractPathTokens(value) : looksLikePath(value) ? [value] : [];
  // 注册表路径由注册表白/黑名单单独管辖（见 evaluate 4b），不参与文件系统路径匹配
  return raw.filter((p) => !looksLikeRegistryPath(p));
}

/**
 * 路径匹配：除原样比对外，补一次「带尾分隔符」比对。
 *
 * 必要性：`C:\Users\**` 按常规 glob 语义应覆盖 `C:\Users` 目录本身，
 * 但正则 `^C:\\Users\\.*$` 不匹配无尾分隔符的 `C:\Users`，
 * 会导致对目录自身的操作被误杀。
 */
function pathMatchesAny(p: string, regexes: readonly RegExp[]): boolean {
  return regexes.some((re) => re.test(p) || re.test(`${p}\\`) || re.test(`${p}/`));
}

/** 归一化路径：统一反斜杠，去掉末尾分隔符（保留根路径） */
export function normalizePath(p: string): string {
  let s = p.trim().replace(/\//g, '\\');
  // 折叠重复分隔符（UNC 前缀 \\ 需保留）
  if (!UNC_RE.test(s)) s = s.replace(/\\\\+/g, '\\');
  if (s.length > 3 && s.endsWith('\\')) s = s.slice(0, -1);
  return s;
}

/* ------------------------------ Engine ------------------------------ */

export interface EvaluateInput {
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

export interface PolicyEngineOptions {
  readonly config?: Partial<PolicyConfig>;
  readonly registry?: CapabilityRegistryView;
  /** 显式关闭路径白名单（仅限测试或受控环境） */
  readonly disablePathAllowlist?: boolean;
}

export class CorePolicyEngine implements PolicyEngine {
  private readonly cfg: PolicyConfig;
  private readonly registry?: CapabilityRegistryView;
  private readonly disablePathAllowlist: boolean;

  private readonly pathDenyRe: readonly RegExp[];
  private readonly pathAllowRe: readonly RegExp[];
  private readonly cmdDenyRe: readonly RegExp[];
  private readonly cmdAllowRe: readonly RegExp[];

  constructor(opts: PolicyEngineOptions = {}) {
    const base = mergePolicy(DEFAULT_POLICY, opts.config);
    this.cfg = base;
    this.registry = opts.registry;
    this.disablePathAllowlist = opts.disablePathAllowlist === true;
    this.pathDenyRe = base.pathDenylist.map(globToRegex);
    this.pathAllowRe = base.pathAllowlist.map(globToRegex);
    this.cmdDenyRe = base.commandDenylist.map((p) => new RegExp(p, 'i'));
    this.cmdAllowRe = base.commandAllowlist.map((p) => new RegExp(p, 'i'));
  }

  get config(): PolicyConfig {
    return this.cfg;
  }

  evaluate(req: EvaluateInput): PolicyVerdict {
    // 1. 能力未注册 → 拒绝
    if (this.registry && !this.registry.has(req.capabilityId)) {
      return {
        allowed: false,
        matchedRule: 'registry:unknown-capability',
        requiresApproval: false,
        error: makeError('UNKNOWN_CAPABILITY', `能力未注册：${req.capabilityId}`, {
          details: { capabilityId: req.capabilityId },
        }),
      };
    }

    // 最小权限：本次委派允许的能力范围
    if (req.allowedCapabilities && req.allowedCapabilities.length > 0) {
      const ok = req.allowedCapabilities.some((p) => matchesCapability(p, req.capabilityId));
      if (!ok) {
        return {
          allowed: false,
          matchedRule: 'scope:capability-not-in-allowed-set',
          requiresApproval: false,
          error: makeError('POLICY_DENIED', `能力不在本次委派允许的范围内：${req.capabilityId}`, {
            details: { capabilityId: req.capabilityId, allowed: req.allowedCapabilities },
          }),
        };
      }
    }

    const values = collectStringValues(req.params);

    // 2. 路径黑名单（最高优先级）
    const capPathDeny = (req.capabilityPolicy?.pathDenylist ?? []).map(globToRegex);
    for (const { key, value } of values) {
      for (const candidate of pathCandidates(key, value)) {
        const p = normalizePath(candidate);
        const denyRes = [...this.pathDenyRe, ...capPathDeny];
        if (pathMatchesAny(p, denyRes)) {
          const hitRe = denyRes.find((re) => re.test(p) || re.test(`${p}\\`) || re.test(`${p}/`));
          return {
            allowed: false,
            matchedRule: `pathDenylist:${hitRe?.source ?? ''}`,
            requiresApproval: false,
            error: makeError('POLICY_DENIED', `路径命中黑名单，已拒绝：${candidate}`, {
              details: { path: candidate, rule: hitRe?.source ?? '' },
            }),
          };
        }
      }
    }

    // 3. 命令黑名单（最高优先级）
    const capCmdDeny = (req.capabilityPolicy?.commandDenylist ?? []).map(
      (p) => new RegExp(p, 'i'),
    );
    for (const { key, value } of values) {
      const isCommandish = COMMAND_KEY_RE.test(key) || looksLikeCommandValue(value);
      if (!isCommandish) continue;
      for (const re of [...this.cmdDenyRe, ...capCmdDeny]) {
        if (re.test(value)) {
          return {
            allowed: false,
            matchedRule: `commandDenylist:${re.source}`,
            requiresApproval: false,
            error: makeError('POLICY_DENIED', `命令命中黑名单，已拒绝`, {
              details: { param: key, rule: re.source },
            }),
          };
        }
      }
    }

    // 4. 路径白名单（拒绝优先）
    if (!this.disablePathAllowlist) {
      const capPathAllow = (req.capabilityPolicy?.pathAllowlist ?? []).map(globToRegex);
      const allowRes = [...this.pathAllowRe, ...capPathAllow];
      if (allowRes.length > 0) {
        for (const { key, value } of values) {
          for (const candidate of pathCandidates(key, value)) {
            const p = normalizePath(candidate);
            const hit = pathMatchesAny(p, allowRes);
            if (!hit) {
              return {
                allowed: false,
                matchedRule: 'pathAllowlist:miss',
                requiresApproval: false,
                error: makeError('POLICY_DENIED', `路径不在白名单内，已拒绝：${candidate}`, {
                  details: { path: candidate },
                }),
              };
            }
          }
        }
      }
    }

    // 4b. 注册表读写范围
    const regValues = values.filter((v) => looksLikeRegistryPath(v.value));
    if (regValues.length > 0) {
      const isWrite = /\.(write|set|create|delete|remove)\./i.test(req.capabilityId);
      const allowList = isWrite
        ? (req.capabilityPolicy?.registryWriteAllowlist ?? this.cfg.registryWriteAllowlist)
        : this.cfg.registryReadAllowlist;
      const res = allowList.map(globToRegex);
      for (const { value } of regValues) {
        const hit = res.some((re) => re.test(normalizePath(value)));
        if (!hit) {
          return {
            allowed: false,
            matchedRule: `registry${isWrite ? 'Write' : 'Read'}Allowlist:miss`,
            requiresApproval: false,
            error: makeError('POLICY_DENIED', `注册表路径不在允许范围内：${value}`, {
              details: { path: value, mode: isWrite ? 'write' : 'read' },
            }),
          };
        }
      }
    }

    // 4c. 进程黑名单
    const procDeny = new Set([
      ...this.cfg.processDenylist,
      ...(req.capabilityPolicy?.processDenylist ?? []),
    ]);
    for (const { key, value } of values) {
      if (!/\b(process|name|processName|target)\b/i.test(key)) continue;
      const norm = value.trim().toLowerCase().replace(/\.exe$/, '');
      if (procDeny.has(norm)) {
        return {
          allowed: false,
          matchedRule: 'processDenylist',
          requiresApproval: false,
          error: makeError('POLICY_DENIED', `受保护进程，禁止操作：${value}`, {
            details: { process: value },
          }),
        };
      }
    }

    // 5. 超出本次委派允许的最高风险
    //
    // 语义：**仅当宿主显式声明 maxRisk 时才做范围封顶**（A2A 委派场景的最小权限）。
    // MCP 直调场景宿主未声明范围，此时由审批闸（步骤 6）管辖 ——
    // 若此处也套用 defaultMaxRisk，会导致 L2/L3 在直调通道上永远无法执行（即便已审批）。
    if (req.maxRisk !== undefined && riskAtLeast(req.risk, 'L2') && !riskAtLeast(req.maxRisk, req.risk)) {
      const maxRisk = req.maxRisk;
      return {
        allowed: false,
        matchedRule: `maxRisk:${maxRisk}`,
        requiresApproval: false,
        error: makeError(
          'POLICY_DENIED',
          `操作风险 ${req.risk} 超出本次委派允许上限 ${maxRisk}`,
          { details: { risk: req.risk, maxRisk } },
        ),
      };
    }

    // 6. 需要审批
    if (riskAtLeast(req.risk, 'L2') && !req.approved) {
      return {
        allowed: false,
        matchedRule: 'approval-required',
        requiresApproval: true,
        error: makeError('APPROVAL_REQUIRED', `风险等级 ${req.risk} 需人工审批后执行`),
      };
    }

    // 7. 通过
    return { allowed: true, matchedRule: 'allow:policy-passed', requiresApproval: false };
  }
}

/** 字符串是否疑似命令（含典型命令动词或参数开关） */
function looksLikeCommandValue(s: string): boolean {
  if (s.length < 3) return false;
  return (
    /^(\$|>)/.test(s.trim()) ||
    /\s-([a-z]{1,20})\b/.test(s) ||
    /\b(get|set|new|remove|start|stop|restart|invoke|add|install|uninstall|net|sc|reg|taskkill|winget)-?[a-z]*\b/i.test(
      s,
    )
  );
}

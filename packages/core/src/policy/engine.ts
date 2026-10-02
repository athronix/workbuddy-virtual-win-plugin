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
export function globToRegex(pattern: string, caseSensitive = false): RegExp {
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
  return new RegExp(`^${re}$`, caseSensitive ? '' : 'i');
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
/**
 * 注册表路径识别（D9）。
 *
 * 旧正则要求根键后必须紧跟 `:` 或分隔符且带冒号语义，导致 `HKLM\SOFTWARE\...`（**无冒号**）不被识别为
 * 注册表路径，反而被当成文件系统路径去做白名单匹配 → 恒 POLICY_DENIED。
 * 现同时接受 `HKLM:`、`HKLM:\`、`HKLM\` 三种形态（缺冒号由 canonicalRegistryPath 归一补齐）。
 * 本正则只做**归属判定**（这条串该交给注册表域还是文件系统域），不代表放行 ——
 * 根键准入清单见 REG_CANON（S-1 · 契约 B2-1：恰 4 条，HKU/HKCR/HKCC 不被铸造形态但仍落此域被拒）。
 */
const REG_RE = /^(HK[A-Z_]+|HKEY_[A-Z_]+)(?:[:\\/]|$)/i;

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
 *
 * S-1（R19 真机坐实）：盘符正则**必须**带 `(?<![A-Za-z0-9_])` 左断言。
 * 旧写法 `/[A-Za-z]:\\/` 会把注册表根键的**尾字母**当成盘符 ——
 * `HKLM:\SOFTWARE\Microsoft…` 被切出伪盘符路径 `M:\SOFTWARE\Microsoft…`，
 * 于是 PowerShell 驱动形态（带冒号反斜杠，恰是 `psmod/system.ps1` 回显的形态）
 * 命中「路径不在白名单内」→ `POLICY_DENIED`，而 `HKLM\…`（无冒号）却放行：
 * 同一能力两种写法一成一败（真机 `e2-msi-verify` / `e1-post-reg` vs `e2-reg-probe1`）。
 * 加断言后 `HKLM:` 整体只由注册表模式捕获，并被 `pathCandidates` 交回注册表策略域。
 */
export function extractPathTokens(s: string): string[] {
  const out: string[] = [];
  const patterns = [
    // 盘符路径：`X:` 前不得是字母/数字/下划线（否则会把 HKLM: / HKCU: 的尾字母当盘符）
    /(?<![A-Za-z0-9_])[A-Za-z]:\\[^\s"'`;,|)]+/g,
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

/**
 * 注册表根键别名表（S-1 · 契约 B2-1：**恰 4 条**、**大小写敏感查表**）。
 * 权威口径：`docs/design/r19b-s1-kn2-contract.md` §2.1。
 *
 * 必要性：白名单是 glob 前缀表，同一物理根键的多种写法必须在**比对之前**收敛成同一形态，
 * 否则 `HKEY_LOCAL_MACHINE\SOFTWARE\…`（Windows 习惯写法）会因不匹配 `HKLM:\SOFTWARE\**`
 * 而被拒 —— 与 S-1 的 `HKLM:\` 被误判为盘符 `M:` 是同一类「写法决定成败」缺陷。
 *
 * ⚠ 这张表同时是**根键准入清单** —— 这正是它只有 4 条的全部理由（安全裁决，非风格偏好）：
 *  1. 只有**读/写白名单可能覆盖到的两个 hive**（HKLM / HKCU）的长短写法在表内：
 *     长全称 2 条 + PowerShell 短驱动器名 2 条 = **恰 4 条**。表里既是映射也是准入，
 *     新增第 5 条必然在 code review / grep 里显形，不可能被静默收录。
 *  2. **`HKU` / `HKEY_USERS` 绝不收录**：它是**所有已加载用户配置单元**的根（含 `\.DEFAULT`
 *     = SYSTEM 配置单元）。给一条本不在白名单里的根键「归一出一个合法形态」，
 *     等于先替它铺好进入判定的路 —— 归一应当是**形态收敛**，不是**权限扩张**。
 *  3. **`HKCR`（`HKEY_CLASSES_ROOT`）/ `HKCC`（`HKEY_CURRENT_CONFIG`）绝不收录**：
 *     `HKCR` 是 `HKLM\SOFTWARE\Classes` 与 `HKCU\SOFTWARE\Classes` 的**合并视图**，
 *     一旦参与归一，`HKCR:\…\Shell\Open\Command` 之类就能以「另一个根键」的名义
 *     绕向 `Run` 键自启动面（`HKCU:\Software\…\Run` 已在 registryWriteAllowlist，`defaults.ts:100`）。
 *     这三类（HKU/HKCR/HKCC）形态**仍会被 `REG_RE` 识别为注册表路径**，
 *     因此不会退回文件系统域撞 `pathAllowlist:miss`（那正是 S-1 的错误归属：真机报的
 *     是「路径不在白名单内」而非「注册表不在允许范围」），而是在 4b 以
 *     `registry{Read,Write}Allowlist:miss` 被拒 —— **有意的不对称：归一 ≠ 放行**（契约 §5 A3）。
 *  4. **查表大小写敏感**（表键全大写 + 根键 token `toUpperCase()` 后等值比对）：命中集合可穷举、
 *     可 grep；若映射表本身带 `/i`，`hklm` / `HkLm` / `HKLM` 各走哪条分支无法静态审计。
 *     大小写**折叠**发生在 token 抽取处（`REG_ROOT_RE` 的 `i` 只用于**识别**同一根键的不同写法），
 *     映射与准入仍是「大写 → 定值」的封闭集合。
 */
const REG_CANON: readonly [string, string][] = [
  ['HKEY_LOCAL_MACHINE', 'HKLM:'],
  ['HKEY_CURRENT_USER', 'HKCU:'],
  ['HKLM', 'HKLM:'],
  ['HKCU', 'HKCU:'],
];

/**
 * 根键 token 抽取（长全称分支写在前面，避免 `HK[A-Za-z0-9]+` 先吞掉 `HKEY_` 前缀）。
 * `i` 仅用于**识别**（`hklm` 与 `HKLM` 是同一根键的不同写法 —— D9 的「写法不影响成败」）；
 * 抽取结果统一 `toUpperCase()` 后进入 §REG_CANON 的敏感等值比对，准入集合不因此变宽。
 */
const REG_ROOT_RE = /^(HKEY_[A-Za-z0-9_]+|HK[A-Za-z0-9]+)(.*)$/i;

/**
 * 注册表路径**权威归一形态**（S-1 · 契约 B2-2）：`HKLM:\software\…`
 * —— 根键大写短名 + 冒号 + 反斜杠 + **键名段小写** + 无尾分隔符。
 *
 * 该形态是策略层的**唯一归一权威**，同时用于：① 白名单两侧比对；② `POLICY_DENIED` 回显
 * （契约 B3：错误体、日志、成功回执三处同一形态，杜绝「成功写 `HKLM:\`、错误里是 `M:\`」）。
 * **`psmod/system.ps1` 不再实现第二份归一**（`ConvertTo-RegistryPath` 保持 HEAD 原状），
 * 归一职责双实现正是 S-1 的病灶类型；代价是 psmod 回执 `hive` 字段大小写不保证，契约 §7 OQ-2 已登记。
 *
 * 键名段小写的理由：注册表键名不区分大小写，折叠后归一成为**幂等的全函数**
 * （`canonical(canonical(x)) === canonical(x)`），`HKLM:\SOFTWARE\X` ≡ `hklm\software\x`
 * 收敛到同一串，白名单比对才能改成**大小写敏感**（见 `matchRegistryAllowlist`）而不放松判定。
 *
 * @returns 权威形态；非注册表路径 / 根键不在准入清单（HKU/HKCR/HKCC/未知前缀）的串
 *          **只做分隔符归一**后原样返回 —— 不替它们铸造「合法形态」，由 4b 以注册表域拒绝
 */
export function canonicalRegistryPath(p: string): string {
  const s = String(p ?? '').trim();
  if (!s) return s;
  // 分隔符统一 + 折叠重复反斜杠（UNC 例外：注册表串不可能以 `\\` 起头，此处安全）
  const t = s.replace(/\//g, '\\').replace(/\\{2,}/g, '\\');
  if (!looksLikeRegistryPath(t)) return t.replace(/\\+$/, '');
  const m = REG_ROOT_RE.exec(t);
  if (!m) return t;
  const rawRoot = (m[1] ?? '').toUpperCase();
  const alias = REG_CANON.find(([root]) => root === rawRoot);
  if (!alias) {
    // HKU/HKCR/HKCC/HKEY_USERS 与 `HKFOO\…` 之类未知前缀：不臆测、不铸造（见 §REG_CANON 第 2/3 点）。
    // 保留原串（仅分隔符归一）⇒ looksLikeRegistryPath 仍为真 ⇒ 判定落在注册表域并被拒，
    // 绝不再退回文件系统域（真机 S-1 报的是 `pathAllowlist:miss`，那是**错误归属**）。
    return t;
  }
  const root = alias[1];
  // 根键之后：吞掉**已有冒号**（PS 驱动器形态）与前导/尾随分隔符，再重建 `ROOT:\rest`。
  // 缺这一步 `HKLM:` 会被拼成 `HKLM::`（曾出现的实现缺陷，契约 §5 A4 有断言防复发）。
  const rest = m[2] ?? '';
  const body = rest.replace(/^:+/, '').replace(/^\\+/, '').replace(/\\+$/, '');
  if (!body) return root; // 裸根键：`hklm` / `HKLM\` / `HKLM:` / `HKLM:\` 一律 → `HKLM:`
  const keys = body
    .split('\\')
    .map((seg) => seg.toLowerCase())
    .join('\\');
  return `${root}\\${keys}`;
}

/**
 * 归一化注册表路径（D9 + S-1）：等价写法互认并统一为权威形态。
 * D9 的原始诉求（`HKLM\…` 与 `HKLM:\…` 成败必须一致）现由 `canonicalRegistryPath` 完整承担，
 * 本函数保留为**语义别名**（历史调用点与 CL-017 契约测试仍以该名引用）。
 */
export function normalizeRegistryPath(p: string): string {
  return canonicalRegistryPath(p);
}

/**
 * S-1 · 契约 B2-2：注册表白名单匹配 —— **两侧先归一，再大小写敏感比对**。
 *
 * 为什么必须敏感：键名段已折叠为小写 ⇒ 入参与模式都是权威形态，敏感比对即可覆盖全部等价写法；
 * 若仍带 `i`，「键名段小写」就只是回显层面的美化，白名单退化成「大小写随便写」的第二套宽松判定，
 * 与 D9 的初衷（**写法**不影响成败）冲突且不可审计。
 * 敏感化**只开在注册表域**：文件系统匹配（`pathAllowRe`/`pathDenyRe`/能力级同名表）保持不敏感，
 * 因为 NTFS 大小写不敏感但**保留**，且默认表里有 `C:\Program Files (x86)\**` 这类混合大小写条目。
 *
 * 白名单条目自身也归一（`HKEY_LOCAL_MACHINE\SOFTWARE\**` ≡ `HKLM:\SOFTWARE\**`），
 * 否则「表写长名、入参写短名」又会因形态不同而误拒 —— 同一类形态陷阱。
 *
 * 与文件系统同源的「含自身」语义（`pathMatchesAny` 已确立的惯例）：`HKLM:\SOFTWARE\**`
 * 覆盖 `HKLM:\SOFTWARE` **这个键本身** —— 常规 glob 下 `^HKLM:\\software\\.*$` 不匹配无尾分隔符的
 * `HKLM:\software`，于是「读子树可以、读子树根不行」，属白名单表意的实现落差而非安全边界；
 * 故比对同样补一次「带尾分隔符」重试（只放宽到**表意本身包含**的那个键，不放宽任何其它层级）。
 */
export function matchRegistryAllowlist(path: string, patterns: readonly string[]): boolean {
  const canon = canonicalRegistryPath(path);
  return patterns.some((p) => {
    const re = globToRegex(canonicalRegistryPath(p), true);
    return re.test(canon) || re.test(`${canon}\\`);
  });
}

/**
 * S-1 · 契约 B3：为注册表路径给出**可用形态提示**，写进错误体 `details.forms`。
 * 背景：`POLICY_DENIED` 只回一句「不在允许范围内」时，调用方极易误判为「键不存在」，
 * 于是换一种写法再试 → 一成一败更难定位（真机 `e2-reg-probe1` vs `e2-msi-verify`）。
 * 故错误里直接给出**等价可用写法 + 权威形态 + 读写范围**，让调用方一次自纠。
 *
 * ⚠ 措辞硬约束（契约 §3）：本提示**不得**建议「改回某一种写法才行」——
 * （旧实现曾建议改回无冒号形态，属错误信息：归一后各写法**完全等价**，
 *   任何「必须换写法」的措辞都会让用户误判成「键不存在 / 只有某形态能读」。）
 */
export function describeRegistryForms(path: string): string {
  const s = String(path ?? '').trim();
  const m = REG_ROOT_RE.exec(s);
  const rawRoot = m ? (m[1] ?? '').toUpperCase() : '';
  // 根键短名取自准入清单（REG_CANON 的映射值去冒号）；HKU/HKCR/HKCC 等不在清单内 ⇒ 提示退到 HKLM，
  // 但「范围」两句如实说明本例根键不在允许范围（提示不得暗示非准入根键可用）。
  const root = rawRoot && REG_CANON.some(([r]) => r === rawRoot) ? rawRoot.replace(/^HKEY_/, '') : '';
  const shown = root || 'HKLM';
  const body = m ? (m[2] ?? '').replace(/^:+/, '').replace(/^\\+/, '').replace(/\\+$/, '') : '';
  const suffix = body ? `\\${body}` : '\\SOFTWARE\\...';
  const outOfScope =
    root || !rawRoot
      ? ''
      : `注意：根键 \`${rawRoot}\` **不在归一准入清单**（仅 HKLM/HKCU，长全称与短形均可），` +
        `即便形态正确也会被拒绝；` +
        `若该键的实际归属是 HKLM 或 HKCU，请改用对应根键写法。`;
  return (
    `可用形态（**等价互认**，判定前统一归一为权威形态 \`${shown}:\\${body ? body.toLowerCase() : '…'}\`）：` +
    `\`${shown}:\\…\`（PowerShell 驱动器形态）、\`${shown}\\…\`（无冒号 Windows 形态）、` +
    `\`HKEY_LOCAL_MACHINE\\…\` / \`HKEY_CURRENT_USER\\…\`（长全称）；大小写与正斜杠均不影响判定。` +
    `读取范围：\`HKCU:\\**\` 与 \`HKLM:\\SOFTWARE\\**\`；写入范围：\`HKCU:\\**\`。` +
    outOfScope +
    `本例可写成 \`${shown}:${suffix}\``
  );
}

/** 取某个参数值需要接受**文件系统**路径策略检查的候选路径列表 */
function pathCandidates(key: string, value: string): string[] {
  const isCommandish = COMMAND_KEY_RE.test(key) || looksLikeCommandValue(value);
  const raw = isCommandish ? extractPathTokens(value) : looksLikePath(value) ? [value] : [];
  // 注册表路径由注册表白/黑名单单独管辖（见 evaluate 4b），不参与文件系统路径匹配。
  // S-1：`HKLM:\SOFTWARE\…` 能否被剔除，取决于 extractPathTokens 的盘符正则**不会**先把它
  // 切成伪盘符 `M:\SOFTWARE\…` —— 旧写法（无 `(?<![A-Za-z0-9_])` 断言）切出来的 `M:\…`
  // 不像注册表路径，于是径直去撞文件系统白名单 → `POLICY_DENIED`（真机 e2-msi-verify）。
  return raw.filter((p) => !looksLikeRegistryPath(p) && !looksLikeRegistryPath(canonicalRegistryPath(p)));
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
    this.pathDenyRe = base.pathDenylist.map((p) => globToRegex(p));
    this.pathAllowRe = base.pathAllowlist.map((p) => globToRegex(p));
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
    const capPathDeny = (req.capabilityPolicy?.pathDenylist ?? []).map((p) => globToRegex(p));
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
      const capPathAllow = (req.capabilityPolicy?.pathAllowlist ?? []).map((p) => globToRegex(p));
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
    //
    // S-1（契约 B2/B3 · docs/design/r19b-s1-kn2-contract.md）：判定一律在**权威归一形态**
    // （`HKLM:\software\…`）上进行，白名单条目自身同样先归一（`HKEY_LOCAL_MACHINE\SOFTWARE\**`
    // ≡ `HKLM:\SOFTWARE\**`），再由 `matchRegistryAllowlist` 做**大小写敏感**比对 ——
    // D9 的「写法不影响成败」由此真正落到同一结论。
    const regValues = values.filter((v) => looksLikeRegistryPath(v.value));
    if (regValues.length > 0) {
      const isWrite = /\.(write|set|create|delete|remove)\./i.test(req.capabilityId);
      const allowList = isWrite
        ? (req.capabilityPolicy?.registryWriteAllowlist ?? this.cfg.registryWriteAllowlist)
        : this.cfg.registryReadAllowlist;
      for (const { value } of regValues) {
        const canon = canonicalRegistryPath(value);
        if (!matchRegistryAllowlist(value, allowList)) {
          return {
            allowed: false,
            matchedRule: `registry${isWrite ? 'Write' : 'Read'}Allowlist:miss`,
            requiresApproval: false,
            error: makeError(
              'POLICY_DENIED',
              `注册表路径不在允许范围内：${canon}（原样入参：${value}）`,
              {
                details: {
                  path: canon,
                  inputPath: value,
                  mode: isWrite ? 'write' : 'read',
                  forms: describeRegistryForms(value),
                  allowed: [...allowList],
                },
              },
            ),
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
    //
    // D11：dry-run 免审批 —— `params.dryRun === true` 时不改变系统状态（仅返回计划），
    // 若也拦截审批，Skill 规定的「L3 先 dry-run 再确认」流程在审批闸前就断掉、无法取得计划。
    // 放在路径/命令/注册表等安全校验之后，故 dry-run 仍不能绕过黑名单与白名单。
    if (riskAtLeast(req.risk, 'L2') && !req.approved) {
      if (req.params['dryRun'] === true) {
        return { allowed: true, matchedRule: 'allow:dry-run-bypass', requiresApproval: false };
      }
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

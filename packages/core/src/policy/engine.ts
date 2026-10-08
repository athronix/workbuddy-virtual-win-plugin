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
  POLICY_APPROVAL_REQUIRED_MATCHED_RULE,
  POLICY_DRY_RUN_BYPASS_MATCHED_RULE,
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
 *
 * U-P0-1 连带修正（同一缺陷族：「写法决定成败」）：盘符正则此前**只认反斜杠**
 * （`[A-Za-z]:\\`），于是命令串里嵌的**正斜杠盘符路径**（`node C:/Users/a/../../Windows/x.js`）
 * 一个 token 都提不出来 ⇒ 整条命令**完全不进入**文件系统策略视野。
 * 这不是「归一得对不对」的问题，而是**根本没走到归一**：`normalizePath` 已把
 * `C:/…` 与 `C:\…` 视为同一形态（并统一折叠分隔符），采集层却只认一种写法，
 * 二者语义不一致会让黑名单在参数通路生效、在命令通路失效。
 * Windows API 对两种分隔符一律接受，`psmod` 侧原样透传，故正斜杠形态是**真实可利用**的绕过面。
 * 现改为 `[A-Za-z]:[\\/]`。`https://` / `ftp://` 这类 scheme 因冒号**前邻是字母**
 * 仍被左断言排除（伪盘符零出现，S-1 的既有断言不变）；
 * 极端形态（如单字母 scheme `a://host/p`）若被提取，归一后必然撞白名单 miss ⇒ fail-closed，
 * 方向是收紧而非放松。
 */
export function extractPathTokens(s: string): string[] {
  const out: string[] = [];
  const patterns = [
    // 盘符路径：`X:` 前不得是字母/数字/下划线（否则会把 HKLM: / HKCU: 的尾字母当盘符）
    /(?<![A-Za-z0-9_])[A-Za-z]:[\\/][^\s"'`;,|)]+/g,
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

/**
 * U-P0-3（A1）：dry-run 免批放行规则的**唯一哨兵常量**。
 *
 * 为什么在契约层定义而不是各处写字面量：这条规则同时被三方读取 ——
 * ① 引擎产出；② `vm-service` 审计装饰器据此在 `ext.bypass='dry-run'` 落取证位；
 * ③ 测试与运维 grep。任一处拼写漂移都会让「免批执行」静默失去链上证据
 * （正是体检 §2-QA-11 点名要防的「四层兜底全是隐式约定」）。
 */
export const DRY_RUN_BYPASS_MATCHED_RULE = POLICY_DRY_RUN_BYPASS_MATCHED_RULE;

/**
 * 路径归一（U-P0-1）：**win32 `path.resolve` 语义的段消解**，黑白名单两侧共用。
 *
 * 缺陷（体检 U-P0-1，P0）：旧实现只做「浅归一」（分隔符统一 + 折叠重复分隔符 + 去尾分隔符），
 * **不解析 `.` / `..` 段**。于是
 * `C:\Users\a\..\..\Windows\System32\evil.dll` 原样透传给 glob：
 *   - 黑名单 `C:\Windows\**` 不匹配（串以 `C:\Users\` 起头）；
 *   - 白名单 `C:\Users\**` 匹配 ⇒ ALLOW。
 * 主理人已用 dist 引擎对 `appops.cli.invoke` / `storage.file.manage` 双证实在穿越串上放行 ——
 * **一条 `..\` 同时绕过黑名单与白名单**，等价于把整个路径策略面变成可选。
 *
 * 现在的语义（与 `path.resolve` 在 Windows 上的一致）：
 *   - `.` 段与空段丢弃；`..` 弹栈；
 *   - **锚定形态**（盘符根 `C:\`、UNC `\\server\share`、根相对 `\a\b`）：栈空时多余的 `..` 直接丢弃
 *     （根之上没有父目录，绝不逃到根外）；
 *   - **相对形态**（无盘符无 UNC）：栈空时的 `..` **原样保留** —— 我们不知道调用方 CWD，
 *     任何「假定 CWD 后消解」都是在替引擎编造绝对路径；保留 `..` 使这类串必然无法命中
 *     前缀式白名单（表项一律绝对形态）⇒ 落在 `pathAllowlist:miss` **fail-closed**；
 *   - 折叠**必须 total**：任意输入（含空串、纯分隔符、畸形 UNC、非字符串）只返回一个形态，
 *     绝不抛异常 —— 归一抛错会被上游 catch 成「执行失败」而不是「拒绝」，等于又一个绕过面。
 *
 * 覆盖形态（单测逐项钉死）：正反斜杠与混合（`C:/Users/a/../..`）、大小写混杂、无盘符形态、
 * 重复分隔符；**UNC `\\server\share` 不误伤**（server/share 两段作为锚点保留，不被 `..` 弹出，
 * 与 win32 一致）；**设备命名空间 `\\?\` / `\\.\` 逐字节透传**（Windows 对该前缀**不做**路径归一，
 * 消解反而与真实语义不符；默认黑名单 `\\?\**` 已整体拒绝，透传是安全方向）。
 *
 * 幂等：`normalizePath(normalizePath(x)) === normalizePath(x)`（段消解一次后即无 `.`/`..` 可解）。
 */
export function normalizePath(p: string): string {
  return foldWin32Segments(p);
}

/**
 * 段消解内核（`normalizePath` 的唯一实现，独立成函数便于「变异验证」整体替换）。
 * 见 {@link normalizePath} 的语义说明。绝不抛。
 */
function foldWin32Segments(p: string): string {
  // total 兜底：非字符串入参（调用方 params 是 `Record<string, unknown>`，运行期可能是任意值）
  let s = '';
  try {
    s = (typeof p === 'string' ? p : String(p ?? '')).trim();
  } catch {
    return '';
  }
  if (s === '') return s;

  // 1) 分隔符统一（正斜杠 → 反斜杠；Windows API 两种都接受，归一后 glob 只需认一种）
  s = s.replace(/\//g, '\\');

  // 2) 设备命名空间：`\\?\…` / `\\.\…` 逐字节透传（不做归一是 Windows 的语义，见 §normalizePath）
  if (/^\\\\[?.]\\/.test(s)) return s;

  // 3) UNC：`\\server\share\rest`。server+share 作为**不可弹出**的锚点。
  if (UNC_RE.test(s)) {
    const parts = s.slice(2).split('\\');
    const server = parts[0] ?? '';
    const share = parts[1] ?? '';
    // 畸形（`\\`、`\\\a`、只有 server）：原样返回 —— 形态可疑的串绝不会被前缀白名单接纳，
    // 由 `pathAllowlist:miss` fail-closed，而不是由我们臆造一个「解析后」形态。
    if (server === '' || share === '') return s;
    const anchor = `\\\\${server}\\${share}`;
    const rest = parts.slice(2).join('\\');
    const stack = foldSegList(rest, true);
    return stack.length === 0 ? anchor : `${anchor}\\${stack.join('\\')}`;
  }

  // 4) 盘符绝对形态：`X:\rest`
  if (DRIVE_RE.test(s)) {
    const drive = s.slice(0, 1);
    const stack = foldSegList(s.slice(2), true);
    // 根路径保留：`C:\` 归一后仍是 `C:\`（旧实现同样保留长度 ≤3 的根形态）
    return stack.length === 0 ? `${drive}:\\` : `${drive}:\\${stack.join('\\')}`;
  }

  // 5) 根相对形态：`\rest`（当前盘符根之下；`..` 到根即止）
  if (s.startsWith('\\')) {
    const stack = foldSegList(s.slice(1), true);
    return stack.length === 0 ? '\\' : `\\${stack.join('\\')}`;
  }

  // 6) 盘符相对形态：`X:rest`（无分隔符）与 7) 纯相对形态：`rest`
  //    rooted=false ⇒ 栈空的 `..` 保留（不知 CWD，绝不编造绝对路径 ⇒ 必然撞白名单 miss ⇒ 拒）
  const driveRelative = /^[A-Za-z]:/.test(s);
  const prefix = driveRelative ? s.slice(0, 2) : '';
  const stack = foldSegList(s.slice(driveRelative ? 2 : 0), false);
  return `${prefix}${stack.join('\\')}`;
}

/**
 * 逐段消解（win32 `..` 语义）：`.`/空段丢弃；`..` 弹出一个**普通**段。
 *
 * `..` 遇栈空（或栈顶已是 `..`）时按 `rooted` 分叉：
 *   - rooted（盘符根 / UNC share 根 / 根相对）：丢弃 —— 根之上没有父目录，绝不逃到根外；
 *   - 非 rooted（相对形态）：**保留** `..` —— 引擎不知道调用方 CWD，把它伪造成绝对路径
 *     等于替策略判定编造事实；保留后该串必然无法命中前缀式白名单 ⇒ `pathAllowlist:miss` 拒绝
 *     （fail-closed，且拒绝理由如实反映「相对路径不在允许范围内」）。
 */
function foldSegList(body: string, rooted: boolean): string[] {
  const stack: string[] = [];
  for (const seg of body.split('\\')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      const last = stack[stack.length - 1];
      if (last !== undefined && last !== '..') {
        stack.pop();
        continue;
      }
      if (rooted) continue;
      stack.push('..');
      continue;
    }
    stack.push(seg);
  }
  return stack;
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
 *     绕向 `Run` 键自启动面（`HKCU:\Software\…\Run` 已在 `defaults.ts` 的
 *     `registryWriteAllowlist` 段 —— 引用用**段标签**而非行号，行号随并行改动漂移）。
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
    `读取范围：${scopeHint(DEFAULT_POLICY.registryReadAllowlist)}；` +
    `写入范围：${scopeHint(DEFAULT_POLICY.registryWriteAllowlist)}。` +
    outOfScope +
    `本例可写成 \`${shown}:${suffix}\``
  );
}

/**
 * S-5 · §③(a)：**写动词能力判定**（`evaluate()` 4b 选择读表/写表的唯一依据）。
 *
 * 缺陷（docs/design/s5-registry-write-allowlist-pairing.md §0）：HEAD 判据
 * `/\.(write|set|create|delete|remove)\./i` 要求动词**两侧都有点**，而真实能力 ID
 * `system.registry.write` 的动词位于**末段且无尾点** ⇒ 判定恒 false ⇒ 写请求一直按
 * **读**白名单判定（铁证：写 `HKLM:\SYSTEM\…` 报出 `registryReadAllowlist:miss`），
 * `registryWriteAllowlist` 实为不可达的死配置，读写边界静默失效。
 *
 * 定稿取「**任一分段等于写动词**」：契约 §③(a) 给的两个写法（末段锚定正则 /
 * `split('.').pop()` 比集合）在本仓与它**逐能力等价**（全仓 54 个能力 ID 均为三段式，
 * 且 grep 证实不存在中段动词 ID —— 该等价性由 `tests/unit/r19b-s5-*.test.js` 钉死）；
 * 对**未来**可能出现的 `x.y.write.z` 形态，本判据是两者的**保守超集**：
 * 偏差方向安全 —— 宁可多判为写（改走更严的写表），绝不漏判为读（漏判即边界再度失效，
 * 正是 S-5 的病灶）。登记为契约偏差待追认（见单测 `契约 §③(a) 判据等价性` 用例）。
 */
const WRITE_VERB_SEGMENTS: ReadonlySet<string> = new Set(['write', 'set', 'create', 'delete', 'remove']);

export function isWriteCapability(capabilityId: string): boolean {
  return String(capabilityId ?? '')
    .split('.')
    .some((seg) => WRITE_VERB_SEGMENTS.has(seg.toLowerCase()));
}

/**
 * S-5 · 契约 §④-4「文档-代码一致性断言」的配套：白名单范围的**显示投影**。
 *
 * 为什么需要：`describeRegistryForms` 过去把「写入范围：`HKCU:\**`」**写死成字面量**，
 * 与 `DEFAULT_POLICY.registryWriteAllowlist` 无编译/运行期关联 —— 表一旦改（本项 (b) 正是改表），
 * 提示立刻变成假信息（把用户往「HKLM 不可写」的错误结论上引）。现由表本身投影：
 * 两侧先归一到权威形态再去重（长短名折叠为同一条），使提示**不可能与配置漂移**。
 */
function scopeHint(patterns: readonly string[]): string {
  const uniq = Array.from(new Set(patterns.map((p) => canonicalRegistryPath(p))));
  return uniq.map((p) => `\`${p}\``).join(' 与 ');
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
    // U-P0-1「先归一后匹配」：模式侧与入参侧必须走**同一条**归一通路，否则
    // 「表写 `C:\Users\a\.\x`、入参写 `C:\Users\a\x`」这类形态落差会再次出现
    // （与注册表域 `matchRegistryAllowlist` 的「两侧先归一」同一纪律）。
    this.pathDenyRe = base.pathDenylist.map((p) => globToRegex(normalizePath(p)));
    this.pathAllowRe = base.pathAllowlist.map((p) => globToRegex(normalizePath(p)));
    this.cmdDenyRe = base.commandDenylist.map((p) => new RegExp(p, 'i'));
    this.cmdAllowRe = base.commandAllowlist.map((p) => new RegExp(p, 'i'));
  }

  get config(): PolicyConfig {
    return this.cfg;
  }

  /**
   * U-P0-3（A1）：该能力的 dry-run 是否由**服务端声明**支持（免审批旁路的第二条件）。
   *
   * 唯一判据 = 注册表投影里的 `supportsDryRun === true`。**严格等值 `true`**：
   * 缺席（`undefined`）、`false`、以及「引擎未注入注册表」（无从核实）一律视为不支持 ——
   * fail-closed，与 `riskAtLeast` / `capabilityRequiresApproval` 的保守方向一致。
   *
   * 为什么不在这里读 `req.params`、也不看 input schema 有没有 `dryRun` 属性：
   * 参数是调用方自报的；schema 里的 `dryRun` 只说明「实现接得住这个开关」，
   * **不等于**「开关为真时零系统变更」（`vm-service/src/server.ts` 的 `hasDryRunParam` 用于
   * 审批预览文案，语义是「可预览」，不是「可免批」—— 两者刻意分离，见 U4 结论）。
   */
  private capabilitySupportsDryRun(capabilityId: CapabilityId): boolean {
    if (!this.registry) return false;
    return this.registry.get(capabilityId)?.supportsDryRun === true;
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
    const capPathDeny = (req.capabilityPolicy?.pathDenylist ?? []).map(
      (p) => globToRegex(normalizePath(p)),
    );
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
      const capPathAllow = (req.capabilityPolicy?.pathAllowlist ?? []).map(
        (p) => globToRegex(normalizePath(p)),
      );
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
      // S-5（docs/design/s5-registry-write-allowlist-pairing.md §③(a)）：写动词判定必须覆盖
      // **末段**形态。真实能力 ID `system.registry.write` 的动词位于末段且**无尾点**，
      // 而 HEAD 正则 `/\.(write|set|create|delete|remove)\./i` 要求动词**两侧都有点** ⇒ 恒 false
      // ⇒ 写请求一直撞**读**白名单（铁证：写 `HKLM:\SYSTEM\…` 报出
      // `matchedRule=registryReadAllowlist:miss`），`registryWriteAllowlist` 实为死配置，
      // 读写边界失效 —— 运维「只放宽读」在配置层面静默等于授予写权限（本文 §② 末段实证）。
      // 判据取「任一分段等于写动词」：这是 §③(a) 两个等价写法（末段锚定 / `split('.').pop()`
      // 比集合）的**保守超集** —— 对现有 54 个三段式 ID 逐字等价（全仓 grep 无中段动词 ID），
      // 且偏差方向安全：宁可多判为写（改走写表，判定更严），绝不漏判为读（漏判即边界再度失效）。
      const isWrite = isWriteCapability(req.capabilityId);
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
    // D11：dry-run 免审批 —— 不改变系统状态（仅返回执行计划）时不拦审批，
    // 否则 Skill 规定的「L3 先 dry-run 再确认」流程在审批闸前就断掉、无法取得计划。
    // 放在路径/命令/注册表等安全校验之后，故 dry-run 仍不能绕过黑名单与白名单。
    //
    // U-P0-3（A1 **服务端能力声明制**，体检 §2 表格 U-P0-3 / 架构审计 ARCH-02 / 测试审计 §2-QA-11）：
    // 旧实现**只**判 `req.params['dryRun'] === true` 即放行 L2/L3 —— 该参数是**调用方自报**的，
    // 于是「谁可以免审批」的决定权落在不受信的调用方手里：任何 L2/L3 能力附带 `dryRun:true`
    // 即可跳过人工审批**真实执行**（psmod 侧是否真的按 dry-run 早返回、是否零变更，引擎一无所知）。
    // 现在改为**双条件**：
    //   ① 调用方传 `dryRun === true`（意图）；
    //   ② 注册表里该能力声明 `supportsDryRun === true`（**服务端事实**：实现体确凿只返回计划）。
    // 未声明的能力传 `dryRun` **不再免批**，回落 `approval-required`（fail-closed；
    // 由于 `requiresApproval:true`，宿主侧审批流程照旧，已声明能力的合法 dryRun 调用链不受影响）。
    //
    // ⚠ 锚点纪律：下一行的 `if` + dryRun 严格等值判定字面量是
    // `tests/unit/assembly-guard.test.js` 的**切片锚点**（QA 交付件，不得改），保留原样。
    // 本注释刻意**不复现**该锚点的完整字面量（含左括号与尾空格）——
    // QA 侧用 `indexOf` 取**首个**命中，注释里出现同样字面量会让它切到注释而非代码，
    // 守卫静默失效（体检 §2-QA-11 点名要防的「锚点找不到/找错都不显形」）。
    // 第二条件写在块**内**，两条都成立才放行。
    if (riskAtLeast(req.risk, 'L2') && !req.approved) {
      if (req.params['dryRun'] === true) {
        if (this.capabilitySupportsDryRun(req.capabilityId)) {
          return {
            allowed: true,
            matchedRule: POLICY_DRY_RUN_BYPASS_MATCHED_RULE,
            requiresApproval: false,
          };
        }
      }
      return {
        allowed: false,
        matchedRule: POLICY_APPROVAL_REQUIRED_MATCHED_RULE,
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

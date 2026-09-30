/**
 * R17-T01 · K6 契约与回执断言基线（`app.winget.uninstall` 卸载后核验 + NSIS 静默回退）
 *
 * 背景（R3 假成功）：旧实现只看 `winget` 退出码 —— NSIS 包（如企业微信）exit 0 但
 * 磁盘/注册表纹丝不动，回执 `success=true` 是**假的**。修复方向 = 卸载后磁盘 + 注册表
 * 事后核验 + 仅对 NSIS 型追加 `Uninstall.exe /S` 静默回退。
 *
 * 本仓库 `node --test` 运行环境**没有 PowerShell**，PS 侧真机行为留给 T02/T05（QA R3-6）。
 * 因此本文件落**两道基线**（设计 §A6 U6 的定稿口径）：
 *   ① 静态契约守卫：`definitions.ts` 的 output schema 必须声明 `verified`/`fallbackUsed`/
 *      `residualEvidence` 且类型正确，描述必须写明「success 以最终核验为准」与 600s 预算；
 *      `docs/02-design/CAPABILITY-MODEL.md` §3.2.1 必须同步回执语义。
 *   ② 规则基线：把判定规则用**测试内等价参考函数**固化（R-1…R-8，见下）。**T02 的
 *      `psmod/app.ps1` 实现必须与这些规则逐条一致**，否则本文件的规则断言与 PS 真机
 *      回归（R3-6）必然冲突 —— 本文件即是那条「不可漂移」的合同。
 *
 * 规则编号（PS 实现请按同号注释对齐）：
 *   R-1 installerType 判定（unknown / msi / nsis / other）
 *   R-2 InstallLocation 派生（注册表优先 → UninstallString 去引号/参数反推 → null）
 *   R-2b 反推排除 msiexec 路径（否则误得 system32）
 *   R-3 磁盘核验：派生不出安装根 → `dirGone=null`（只做注册表核验，如实标注）
 *   R-4 registryGone = 卸载键不再匹配
 *   R-5 核验通过 = registryGone && exeGone && dirGone !== false
 *   R-6 回退触发：仅 exitCode=0 且 R-5 未过且 installerType='nsis'（非 NSIS 永不回退；dryRun 不核验不回退）
 *   R-7 success：dryRun → exitCode=0；否则 exitCode=0 && 最终核验通过
 *   R-8 residualEvidence：非 dryRun 且 success=false 时给出残留清单；success=true 时省略
 *
 * 依据：docs/design/r17-design.md §A1.3 / §A3.2 / §A5；docs/prd/r17-prd.md R3-1…R3-5。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8');

const DEFINITIONS = read('packages', 'vm-capabilities', 'src', 'registry', 'definitions.ts');
const CAP_MODEL = read('docs', '02-design', 'CAPABILITY-MODEL.md');
const CAP_ID = 'app.winget.uninstall';

/* ============================================================================
 * 测试内等价参考函数（规则基线 —— T02 的 app.ps1 必须与之逐条一致）
 * ========================================================================== */

/** Windows 路径分段（正/反斜杠皆视为分隔符；本函数只做字符串处理，不触碰文件系统） */
function baseName(p) {
  return String(p).split(/[\\/]/).filter(Boolean).pop() ?? '';
}
function parentDir(p) {
  const parts = String(p).split(/[\\/]/);
  parts.pop();
  return parts.join('\\');
}
function trimTrailingSep(p) {
  return String(p).replace(/[\\/]+$/, '');
}

/**
 * 从注册表卸载命令里取出可执行文件路径（R-2 依赖）。
 * 兼容三种真实形态：
 *   `"C:\Dir\Uninstall.exe" /S`      → 引号内为路径
 *   `C:\Program Files\X\Uninstall.exe /S` → 未加引号且路径含空格 → 按首个 .exe/.msi 切分
 *   `MsiExec.exe /X{GUID}`           → 命令本身即 msiexec
 * @param {string|undefined|null} cmd
 * @returns {string|null}
 */
function parseUninstallCommand(cmd) {
  if (typeof cmd !== 'string') return null;
  const s = cmd.trim();
  if (!s) return null;
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1);
    const inner = end > 0 ? s.slice(1, end) : s.slice(1);
    return inner.trim() || null;
  }
  const m = /^(.*?\.(?:exe|msi))(?:\s|$)/i.exec(s);
  const exe = (m ? m[1] : s.split(/\s+/)[0]).trim();
  return exe || null;
}

/**
 * R-1 安装器类型判定。
 * - 取不到卸载键 → 'unknown'
 * - UninstallString / QuietUninstallString 任一含 msiexec → 'msi'（**永不回退**，R3-5）
 * - UninstallString 指向 uninstall.exe（不区分大小写）**且无 QuietUninstallString** → 'nsis'
 * - 其余 → 'other'
 * @param {{UninstallString?:string, QuietUninstallString?:string}|null|undefined} entry
 * @returns {'nsis'|'msi'|'other'|'unknown'}
 */
function classifyInstaller(entry) {
  if (!entry) return 'unknown';
  const both = `${entry.UninstallString ?? ''} ${entry.QuietUninstallString ?? ''}`;
  if (/msiexec/i.test(both)) return 'msi';
  const exe = parseUninstallCommand(entry.UninstallString);
  const hasQuiet = String(entry.QuietUninstallString ?? '').trim().length > 0;
  if (exe && baseName(exe).toLowerCase() === 'uninstall.exe' && !hasQuiet) return 'nsis';
  return 'other';
}

/**
 * R-2 / R-2b 核验目标（安装根）派生。
 * ① 注册表 `InstallLocation` 非空 → 用它（去尾分隔符）；
 * ② 否则按 `UninstallString`（退而 `QuietUninstallString`）解析出的 exe **取所在目录反推**；
 *    但 msi 型跳过反推 —— `MsiExec.exe` 位于 system32，反推会得到错误目录（R-2b）；
 * ③ 仍得不出 → null（调用方据此把 `dirGone` 置 null，只做注册表核验）。
 * @param {object|null} entry
 * @returns {string|null}
 */
function deriveInstallLocation(entry) {
  if (!entry) return null;
  const il = trimTrailingSep(String(entry.InstallLocation ?? '').trim());
  if (il) return il;
  if (classifyInstaller(entry) === 'msi') return null;
  for (const key of ['UninstallString', 'QuietUninstallString']) {
    const exe = parseUninstallCommand(entry[key]);
    if (!exe) continue;
    const dir = trimTrailingSep(parentDir(exe));
    if (dir && /[\\/]/.test(dir)) return dir;
  }
  return null;
}

/** 主程序 exe 名（DisplayIcon 提供时可精确核验；无则退化为「以目录存在性为准」） */
function primaryExeName(entry) {
  // DisplayIcon 常带图标索引后缀（`C:\...\WXWork.exe,0`），先剥离再取路径
  const raw = String(entry?.DisplayIcon ?? '').trim();
  if (!raw) return null;
  const noIdx = raw.replace(/,\s*\d+\s*$/, '');
  const icon = parseUninstallCommand(noIdx);
  if (!icon) return null;
  const name = baseName(icon);
  return /\.(exe)$/i.test(name) ? name : null;
}

/**
 * R-3 / R-4 核验一次（Test-UninstallState 的等价参考实现）。
 * @param {object|null} entry 卸载注册表键（null=已消失/取不到）
 * @param {{dirExists:boolean, exeExists:boolean}} disk 磁盘探针（仅当能派生安装根时才有意义）
 * @param {boolean} registryKeyExists HKLM/HKCU 卸载键是否仍存在
 * @returns {{exeGone:boolean, dirGone:boolean|null, registryGone:boolean, installLocation?:string, installerType:string}}
 */
function testUninstallState(entry, disk, registryKeyExists) {
  const installerType = classifyInstaller(entry);
  const installLocation = deriveInstallLocation(entry);
  /** @type {{exeGone:boolean, dirGone:boolean|null, registryGone:boolean, installerType:string, installLocation?:string}} */
  const v = { exeGone: true, dirGone: null, registryGone: !registryKeyExists, installerType };
  if (installLocation !== null) {
    v.installLocation = installLocation;
    v.dirGone = !disk.dirExists;
    const exeName = primaryExeName(entry);
    v.exeGone = exeName ? !disk.exeExists : !disk.dirExists;
  }
  // installLocation === null → 磁盘核验跳过：dirGone=null、exeGone 记为 true（无从判定，如实交由注册表核验把关）
  return v;
}

/** R-5 核验通过判定：注册表键消失 + exe 消失 + 目录未被判为残留（dirGone=null 表示"未核验"，不阻断） */
function verificationPassed(v) {
  return v.registryGone === true && v.exeGone === true && v.dirGone !== false;
}

/** R-6 回退资格：只有 NSIS 型才允许 `Uninstall.exe /S` */
function mayFallback(installerType) {
  return installerType === 'nsis';
}

/** R-8 残留证据（人类可读单串：残留 exe / 目录 / 注册表键） */
function buildResidualEvidence(v) {
  const items = [];
  if (!v.registryGone) items.push(`注册表卸载键仍在: ${v.installLocation ?? v.installerType}`);
  if (v.dirGone === false) items.push(`安装目录仍在: ${v.installLocation}`);
  if (v.exeGone === false) items.push(`主程序仍在: ${v.installLocation}`);
  return items.join(' | ');
}

/**
 * K6 状态机（Uninstall-WingetPackage 的等价参考实现：卸载→核验→(NSIS)回退→再核验→回执）。
 * 输入为「模拟探针」，不含任何真实 IO；输出即能力回执对象。
 *
 * @param {{
 *   id: string, dryRun?: boolean, wingetExitCode?: number, entry?: object|null,
 *   afterWinget?: { registryKeyExists: boolean, dirExists: boolean, exeExists: boolean },
 *   afterFallback?: { registryKeyExists: boolean, dirExists: boolean, exeExists: boolean },
 *   output?: string[],
 * }} o
 */
function runK6StateMachine(o) {
  const id = o.id;
  const dryRun = o.dryRun ?? false;
  const exitCode = o.wingetExitCode ?? 0;
  const entry = o.entry ?? null;
  const afterWinget = o.afterWinget ?? { registryKeyExists: false, dirExists: false, exeExists: false };
  const afterFallback = o.afterFallback ?? { registryKeyExists: false, dirExists: false, exeExists: false };
  const output = o.output ?? [];

  // dryRun：不核验、不回退，verified=null、fallbackUsed=false（免审批语义保持）
  if (dryRun) {
    return { id, dryRun: true, exitCode, success: exitCode === 0, verified: null, fallbackUsed: false, output };
  }

  // winget 非零退出：直接失败，绝不回退（回退只用于纠正「假成功」）
  if (exitCode !== 0) {
    const v = testUninstallState(entry, afterWinget, afterWinget.registryKeyExists);
    return { id, dryRun: false, exitCode, success: false, verified: v, fallbackUsed: false, output };
  }

  const first = testUninstallState(entry, afterWinget, afterWinget.registryKeyExists);
  if (verificationPassed(first)) {
    return { id, dryRun: false, exitCode: 0, success: true, verified: first, fallbackUsed: false, output };
  }

  if (!mayFallback(first.installerType)) {
    const rec = { id, dryRun: false, exitCode: 0, success: false, verified: first, fallbackUsed: false, output };
    const ev = buildResidualEvidence(first);
    if (ev) rec.residualEvidence = ev;
    return rec;
  }

  const second = testUninstallState(entry, afterFallback, afterFallback.registryKeyExists);
  if (verificationPassed(second)) {
    return { id, dryRun: false, exitCode: 0, success: true, verified: second, fallbackUsed: true, output };
  }
  return {
    id,
    dryRun: false,
    exitCode: 0,
    success: false,
    verified: second,
    fallbackUsed: true,
    residualEvidence: buildResidualEvidence(second),
    output,
  };
}

/* ============================================================================
 * 契约解析辅助：从 definitions.ts 源码文本里取出能力块与字段定义
 * ========================================================================== */

/** 取出 `cap({ id: 'app.winget.uninstall', ... })` 整块源码文本 */
function capBlockOf(src, capId) {
  const marker = `id: '${capId}'`;
  const at = src.indexOf(marker);
  assert.notEqual(at, -1, `definitions.ts 应声明能力 ${capId}`);
  const start = src.lastIndexOf('cap({', at);
  assert.notEqual(start, -1, `${capId} 应由 cap({...}) 构造`);
  const rest = src.slice(start);
  // 本文件的书写规范：能力块以 2 空格缩进的 "  })," 收尾
  const endRel = rest.search(/\n {2}\}\),/);
  assert.ok(endRel > 0, `${capId} 能力块应能以 "  })," 定界（保持既有书写风格）`);
  return rest.slice(0, endRel);
}

/** 取出块内某个 schema 属性的对象字面量文本（含大括号），取不到返回 null */
function propLiteral(block, name) {
  const re = new RegExp(`(^|[\\s,{])${name}:\\s*\\{`, 'm');
  const m = re.exec(block);
  if (!m) return null;
  const from = block.indexOf('{', m.index + m[0].length - 1);
  let depth = 0;
  for (let i = from; i < block.length; i++) {
    if (block[i] === '{') depth++;
    else if (block[i] === '}') {
      depth--;
      if (depth === 0) return block.slice(from, i + 1);
    }
  }
  return null;
}

/** 收集块内所有 `required: [...]` 数组的字符串项 */
function requiredArrays(block) {
  return [...block.matchAll(/required:\s*\[([^\]]*)\]/g)].map((m) => strItems(m[1]));
}

/** 从文本里提取单引号字符串项 */
function strItems(text) {
  return [...String(text).matchAll(/'([^']+)'/g)].map((q) => q[1]).filter(Boolean);
}

/**
 * 解析 `key: obj(` 调用的**顶层实参**（definitions.ts 的 obj(props, required) 风格：
 * required 是第二个位置实参而非 `required:` 键）。返回实参文本数组。
 */
function objCallArgs(block, keyRegex) {
  const m = keyRegex.exec(block);
  assert.ok(m, `应存在匹配 ${keyRegex} 的 obj(...) 调用`);
  let i = block.indexOf('(', m.index + m[0].length - 1);
  assert.ok(i > 0, `${m[0]} 后应紧跟左括号`);
  const args = [];
  let cur = '';
  let depth = 0;
  let inStr = null;
  for (; i < block.length; i++) {
    const c = block[i];
    if (inStr) {
      cur += c;
      if (c === '\\') {
        cur += block[++i];
        continue;
      }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      inStr = c;
      cur += c;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') {
      if (depth > 0) cur += c;
      depth++;
      continue;
    }
    if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) {
        args.push(cur.trim());
        return args;
      }
      cur += c;
      continue;
    }
    if (c === ',' && depth === 1) {
      args.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  return assert.fail(`无法解析 ${m[0]} 的实参（左括号未闭合）`);
}

/** output 顶层 required（obj 第二实参） */
function topLevelRequired(block) {
  const args = objCallArgs(block, /output:\s*obj\(/);
  assert.ok(args.length >= 2, 'output schema 必须显式声明 required（第二实参）');
  return strItems(args[1]);
}

/** output 顶层 properties 文本（用于逐字段存在性/类型断言） */
function topLevelProps(block) {
  return objCallArgs(block, /output:\s*obj\(/)[0];
}

const UN = capBlockOf(DEFINITIONS, CAP_ID);
const VERIFIED_PROP = propLiteral(UN, 'verified');

/* ============================================================================
 * ① 静态契约守卫 —— definitions.ts
 * ========================================================================== */

describe('R17-T01 · definitions.ts：app.winget.uninstall 回执契约（K6）', () => {
  test('output 声明 verified：object|null，且子字段类型正确', () => {
    assert.ok(VERIFIED_PROP, '应新增 verified 字段（对象）');
    assert.ok(
      /type:\s*\[\s*'object',\s*'null'\s*\]/.test(VERIFIED_PROP),
      'verified 必须可空（type: [object, null]）—— dryRun 时为 null',
    );
    assert.ok(/exeGone:\s*\{[^}]*type:\s*'boolean'/.test(VERIFIED_PROP), 'exeGone: boolean');
    assert.ok(/registryGone:\s*\{[^}]*type:\s*'boolean'/.test(VERIFIED_PROP), 'registryGone: boolean');
    assert.ok(
      /dirGone:\s*\{[\s\S]*?type:\s*\[\s*'boolean',\s*'null'\s*\]/.test(VERIFIED_PROP),
      "dirGone 必须为 boolean|null（派生不出安装根时只做注册表核验并如实标注 null）",
    );
    assert.ok(
      /installLocation:\s*\{[^}]*type:\s*'string'/.test(VERIFIED_PROP),
      'installLocation: string（可选）',
    );
    assert.ok(
      /installerType:\s*\{[\s\S]*?enum:\s*\[([^\]]*)\]/.test(VERIFIED_PROP),
      'installerType 必须是枚举',
    );
    const enumVals = [...VERIFIED_PROP.matchAll(/installerType:\s*\{[\s\S]*?enum:\s*\[([^\]]*)\]/g)][0][1]
      .split(',')
      .map((s) => s.trim().replace(/^'|'$/g, ''))
      .filter(Boolean);
    assert.deepEqual(
      [...enumVals].sort(),
      ['msi', 'nsis', 'other', 'unknown'],
      "installerType 枚举必须恰为 'nsis'|'msi'|'other'|'unknown'",
    );
  });

  test('output 声明 fallbackUsed: boolean 与可选 residualEvidence: string', () => {
    const props = topLevelProps(UN);
    assert.ok(/(^|[\s,{])fallbackUsed:\s*\{[\s\S]*?type:\s*'boolean'/.test(props), '应新增 fallbackUsed: boolean（是否触发 NSIS 静默回退）');
    assert.ok(/(^|[\s,{])residualEvidence:\s*\{[^}]*type:\s*'string'/.test(props), '应新增 residualEvidence?: string（核验失败时的残留证据）');
    // residualEvidence 为可选：不得进入顶层 required
    const top = topLevelRequired(UN);
    for (const f of ['id', 'dryRun', 'exitCode', 'success', 'verified', 'fallbackUsed']) {
      assert.ok(top.includes(f), `顶层 required 应含 ${f}`);
    }
    assert.ok(!top.includes('residualEvidence'), 'residualEvidence 是可选字段，不得列入顶层 required');
    assert.ok(!top.includes('output'), 'output 不强制，不得列入顶层 required');
    // verified 内部：installLocation 可选，其余四项必填
    const inner = requiredArrays(UN).find((r) => r.includes('exeGone'));
    assert.ok(inner, 'verified 应声明其 required 子字段');
    assert.deepEqual(
      [...inner].sort(),
      ['dirGone', 'exeGone', 'installerType', 'registryGone'],
      'verified 必填子字段应为 exeGone/dirGone/registryGone/installerType（installLocation 可选）',
    );
    assert.ok(!inner.includes('installLocation'), 'installLocation 必须为可选（派生不出时省略）');
    // 每个顶层必填字段都必须在 properties 中真实声明（防止只写 required 不写字段）
    for (const f of top) {
      assert.ok(
        new RegExp(`(^|[\\s,{])${f}:\\s*\\{`).test(props),
        `required 中的 ${f} 必须在 output.properties 里有声明`,
      );
    }
  });

  test('success 语义改为「以最终核验为准」；描述含 600s 预算与回退纪律', () => {
    assert.ok(
      /success[^]{0,400}?以最终核验为准/.test(UN),
      'success 的 schema/description 必须写明「以最终核验为准」',
    );
    assert.ok(UN.includes('600s'), '描述必须注明 600s 总预算');
    assert.ok(UN.includes('≤300s'), '描述必须注明 winget 阶段 ≤300s');
    assert.ok(UN.includes('≤240s'), '描述必须注明 NSIS 回退阶段 ≤240s');
    assert.ok(UN.includes('≤30s'), '描述必须注明核验阶段 ≤30s');
    assert.ok(/永不回退/.test(UN), '描述必须写明 MSI/其它类型永不回退（R3-5）');
    assert.ok(/不得改写为成功/.test(UN), '描述必须写明残留证据须如实转呈');
    assert.ok(/verified=null|verified`=\s*null/.test(UN), '描述必须写明 dryRun 时 verified=null');
    assert.ok(/fallbackUsed=false/.test(UN), '描述必须写明 dryRun 时 fallbackUsed=false');
    // 回归守卫：能力级总预算与风险面不得漂移
    assert.ok(UN.includes('timeoutMs: 600_000'), '能力级 timeout 维持 600_000ms（不新增分段参数）');
    assert.ok(UN.includes("risk: 'L2'"), '风险等级维持 L2');
    assert.ok(UN.includes('destructive: true'), '破坏性标记维持 true');
    assert.ok(UN.includes("snapshot: 'before-after'"), '快照策略维持 before-after');
    assert.ok(UN.includes("fn: 'Uninstall-WingetPackage'"), '实现绑定维持 psmod/app.ps1:Uninstall-WingetPackage');
  });
});

/* ============================================================================
 * ①b 静态契约守卫 —— docs/02-design/CAPABILITY-MODEL.md
 * ========================================================================== */

describe('R17-T01 · CAPABILITY-MODEL.md：回执语义同步', () => {
  test('app 域表引用 §3.2.1，且该节存在并覆盖四要素', () => {
    assert.ok(/`app\.winget\.uninstall`[^\n]*§3\.2\.1/.test(CAP_MODEL), '能力表应指向 §3.2.1 回执语义');
    assert.ok(CAP_MODEL.includes('#### 3.2.1'), '应存在 §3.2.1 回执语义小节');
    const sec = CAP_MODEL.slice(CAP_MODEL.indexOf('#### 3.2.1'));
    const body = sec.slice(0, sec.indexOf('### 3.3') > 0 ? sec.indexOf('### 3.3') : sec.length);
    for (const kw of ['success', 'verified', 'fallbackUsed', 'residualEvidence', 'exitCode']) {
      assert.ok(body.includes(`\`${kw}\``), `§3.2.1 应说明字段 ${kw}`);
    }
    assert.ok(body.includes('以最终核验为准'), '§3.2.1 应写明 success 语义');
    assert.ok(body.includes('exeGone') && body.includes('dirGone') && body.includes('registryGone'), 'verified 三态字段应齐备');
    assert.ok(body.includes('boolean|null') || body.includes('boolean\\|null'), 'dirGone 可空语义应写明');
  });

  test('§3.2.1 写明 dryRun 语义、核验失败转呈纪律、非 NSIS 永不回退', () => {
    const sec = CAP_MODEL.slice(CAP_MODEL.indexOf('#### 3.2.1'));
    const body = sec.slice(0, sec.indexOf('### 3.3') > 0 ? sec.indexOf('### 3.3') : sec.length);
    assert.ok(/verified=null/.test(body), 'dryRun → verified=null');
    assert.ok(/fallbackUsed=false/.test(body), 'dryRun → fallbackUsed=false（且非 NSIS 时亦 false）');
    assert.ok(/不得改写为成功/.test(body), 'success=false 时必须如实转呈残留证据');
    assert.ok(/永不回退/.test(body), 'MSI 及其它类型永不回退');
    assert.ok(/不在 PS 内全盘扫描|不做全盘扫描/.test(body), '应写明派生不出安装根时不做全盘扫描');
    assert.ok(/600s/.test(body) && /≤300s/.test(body) && /≤240s/.test(body) && /≤30s/.test(body), '预算分配应写入文档');
  });
});

/* ============================================================================
 * ② 规则基线 —— 测试内等价参考函数（T02 的 PS 实现必须一致）
 * ========================================================================== */

/** 企业微信（NSIS）真机形态夹具：InstallLocation 缺失，UninstallString 带引号带参数 */
const NSIS_ENTRY_NO_INSTALLLOC = {
  DisplayName: '企业微信',
  DisplayIcon: 'C:\\Program Files (x86)\\Tencent\\WXWork\\WXWork.exe,0',
  InstallLocation: '',
  UninstallString: '"C:\\Program Files (x86)\\Tencent\\WXWork\\Uninstall.exe" /S',
  QuietUninstallString: '',
};

describe('R-1 · installerType 判定', () => {
  test('取不到卸载键 → unknown', () => {
    assert.equal(classifyInstaller(null), 'unknown');
    assert.equal(classifyInstaller(undefined), 'unknown');
  });

  test('UninstallString 指向 Uninstall.exe 且无 QuietUninstallString → nsis', () => {
    assert.equal(classifyInstaller(NSIS_ENTRY_NO_INSTALLLOC), 'nsis');
    assert.equal(
      classifyInstaller({ UninstallString: 'C:\\Program Files\\Foo\\uninstall.EXE' }),
      'nsis',
      '判定须不区分大小写',
    );
  });

  test('存在 QuietUninstallString → 不判 nsis（不回退，避免误伤可静默的包）', () => {
    assert.equal(
      classifyInstaller({
        UninstallString: '"C:\\Program Files\\Foo\\Uninstall.exe"',
        QuietUninstallString: '"C:\\Program Files\\Foo\\Uninstall.exe" /S',
      }),
      'other',
    );
  });

  test('含 msiexec → msi（无论 Uninstall 还是 Quiet 形态）', () => {
    assert.equal(
      classifyInstaller({
        UninstallString: 'MsiExec.exe /X{1AC13903-21A0-48C2-82C7-8371849C407B}',
        InstallLocation: 'C:\\Program Files\\7-Zip\\',
      }),
      'msi',
    );
    assert.equal(
      classifyInstaller({
        QuietUninstallString: 'msiexec.exe /x {GUID} /qn',
        UninstallString: 'MsiExec.exe /I{GUID}',
      }),
      'msi',
    );
  });

  test('其它卸载器（如自身带 quiet 的 Inno/burn）→ other', () => {
    assert.equal(classifyInstaller({ UninstallString: '"C:\\Program Files\\Foo\\unins000.exe"' }), 'other');
    assert.equal(
      classifyInstaller({ UninstallString: '"C:\\Program Files\\Foo\\Uninstall.exe" --unattend' , QuietUninstallString: 'x' }),
      'other',
    );
  });
});

describe('R-2 / R-2b · InstallLocation 派生', () => {
  test('注册表 InstallLocation 非空优先，并去尾分隔符', () => {
    assert.equal(
      deriveInstallLocation({ InstallLocation: 'C:\\Program Files\\7-Zip\\', UninstallString: 'MsiExec.exe /X{G}' }),
      'C:\\Program Files\\7-Zip',
    );
  });

  test('缺失时按 UninstallString 去引号/去参数取所在目录反推', () => {
    assert.equal(
      deriveInstallLocation(NSIS_ENTRY_NO_INSTALLLOC),
      'C:\\Program Files (x86)\\Tencent\\WXWork',
      '应反推为 Uninstall.exe 所在目录（不是 system32、不含参数）',
    );
    // 未加引号且路径含空格的真实形态
    assert.equal(
      deriveInstallLocation({ UninstallString: 'C:\\Program Files\\Bar App\\Uninstall.exe /S' }),
      'C:\\Program Files\\Bar App',
    );
  });

  test('msi 型不得用 msiexec 路径反推（否则会误得 system32）', () => {
    const v = deriveInstallLocation({ UninstallString: 'C:\\Windows\\System32\\MsiExec.exe /X{GUID}' });
    assert.equal(v, null, 'msi 型 InstallLocation 缺失 → null（只做注册表核验）');
    assert.ok(!String(v).toLowerCase().includes('system32'), '绝不反推到 system32');
  });

  test('仍派生不出 → null（dirGone=null，只做注册表核验）', () => {
    assert.equal(deriveInstallLocation({ DisplayName: 'No hints here' }), null);
    assert.equal(deriveInstallLocation(null), null);
    const v = testUninstallState({ UninstallString: 'weird-no-path' }, { dirExists: true, exeExists: true }, true);
    assert.equal(v.dirGone, null, '派生不出安装根 → dirGone 必须为 null（不得伪造 false）');
    assert.ok(!('installLocation' in v) || v.installLocation === undefined, 'installLocation 应省略');
    assert.equal(v.registryGone, false, '注册表核验仍要执行');
  });
});

describe('R-3/R-4/R-5 · 核验与判定', () => {
  test('磁盘全消失 + 键消失 → 核验通过', () => {
    const v = testUninstallState(NSIS_ENTRY_NO_INSTALLLOC, { dirExists: false, exeExists: false }, false);
    assert.deepEqual(
      { exeGone: v.exeGone, dirGone: v.dirGone, registryGone: v.registryGone, installerType: v.installerType },
      { exeGone: true, dirGone: true, registryGone: true, installerType: 'nsis' },
    );
    assert.equal(v.installLocation, 'C:\\Program Files (x86)\\Tencent\\WXWork');
    assert.equal(verificationPassed(v), true);
  });

  test('DisplayIcon 提供时 exeGone 独立于 dirGone（主程序已删但目录残壳 → 仍判失败）', () => {
    // DisplayIcon 带图标索引后缀 `,0` —— 解析必须剥离它，否则主程序名取不出来
    assert.equal(primaryExeName(NSIS_ENTRY_NO_INSTALLLOC), 'WXWork.exe', '应从 DisplayIcon 反出主程序 exe 名');
    const v = testUninstallState(NSIS_ENTRY_NO_INSTALLLOC, { dirExists: true, exeExists: false }, true);
    assert.equal(v.exeGone, true, '主程序已消失 → exeGone=true（独立于目录）');
    assert.equal(v.dirGone, false, '目录残壳仍在 → dirGone=false（不得因 exe 已删就放行）');
    assert.equal(v.registryGone, false, '卸载键仍在');
    assert.equal(verificationPassed(v), false, '任一残留项未清 → 核验未过（这才触发回退或如实失败）');

    // 主程序仍在（真机假成功的典型形态）
    const still = testUninstallState(NSIS_ENTRY_NO_INSTALLLOC, { dirExists: true, exeExists: true }, true);
    assert.equal(still.exeGone, false);
    assert.equal(still.dirGone, false);
    assert.equal(verificationPassed(still), false);

    // 无 DisplayIcon 时退化为「以目录存在性为准」（不伪造独立 exe 判定）
    const noIcon = testUninstallState({ UninstallString: '"C:\\P\\Q\\Uninstall.exe"' }, { dirExists: true, exeExists: false }, true);
    assert.equal(noIcon.exeGone, false, '无主程序名线索时 exeGone 由目录存在性推定');
    assert.equal(primaryExeName({ UninstallString: 'x' }), null, '无 DisplayIcon → 主程序名未知');
  });

  test('仅注册表核验（dirGone=null）时，registryGone 为唯一闸门', () => {
    const onlyReg = testUninstallState({ UninstallString: 'weird-no-path' }, { dirExists: true, exeExists: true }, false);
    assert.equal(onlyReg.dirGone, null);
    assert.equal(verificationPassed(onlyReg), true, '磁盘无从核验时不得凭空判失败（如实由注册表定论）');
    const regStays = testUninstallState({ UninstallString: 'weird-no-path' }, { dirExists: true, exeExists: true }, true);
    assert.equal(verificationPassed(regStays), false);
  });

  test('verified 载荷与契约 required 对齐（installLocation 可选）', () => {
    const inner = requiredArrays(UN).find((r) => r.includes('exeGone'));
    for (const v of [
      testUninstallState(NSIS_ENTRY_NO_INSTALLLOC, { dirExists: false, exeExists: false }, false),
      testUninstallState({ UninstallString: 'weird' }, { dirExists: true, exeExists: true }, true),
      testUninstallState(null, { dirExists: true, exeExists: true }, true),
    ]) {
      for (const f of inner) assert.ok(f in v, `verified 载荷必须含必填字段 ${f}：${JSON.stringify(v)}`);
      assert.ok(['nsis', 'msi', 'other', 'unknown'].includes(v.installerType), 'installerType 必须落在契约枚举内');
    }
  });
});

describe('R-6/R-7/R-8 · 状态机三态回执', () => {
  test('态①：winget 真成功（核验全过）→ success=true，不触发回退', () => {
    const r = runK6StateMachine({
      id: 'Tencent.WeChatWork',
      entry: NSIS_ENTRY_NO_INSTALLLOC,
      afterWinget: { registryKeyExists: false, dirExists: false, exeExists: false },
    });
    assert.equal(r.success, true);
    assert.equal(r.fallbackUsed, false);
    assert.equal(r.verified.dirGone, true);
    assert.equal(r.verified.registryGone, true);
    assert.equal(r.verified.exeGone, true);
    assert.ok(!('residualEvidence' in r), '成功回执不得携带残留证据');
  });

  test('态②：假成功（exit 0 但磁盘/键未变）→ NSIS 回退后核验通过 → success=true + fallbackUsed=true', () => {
    const r = runK6StateMachine({
      id: 'Tencent.WeChatWork',
      entry: NSIS_ENTRY_NO_INSTALLLOC,
      afterWinget: { registryKeyExists: true, dirExists: true, exeExists: true }, // 典型假成功
      afterFallback: { registryKeyExists: false, dirExists: false, exeExists: false }, // /S 实测有效
    });
    assert.equal(r.exitCode, 0, 'winget 本身确实返回 0');
    assert.equal(r.success, true, 'success 以最终核验为准');
    assert.equal(r.fallbackUsed, true);
    assert.equal(r.verified.registryGone, true);
    assert.equal(r.verified.dirGone, true);
    assert.ok(!('residualEvidence' in r), '回退后成功不应带残留证据');
  });

  test('态③：回退后仍残留 → success=false + fallbackUsed=true + residualEvidence 指出残留项', () => {
    const r = runK6StateMachine({
      id: 'Tencent.WeChatWork',
      entry: NSIS_ENTRY_NO_INSTALLLOC,
      afterWinget: { registryKeyExists: true, dirExists: true, exeExists: true },
      afterFallback: { registryKeyExists: true, dirExists: true, exeExists: true },
    });
    assert.equal(r.success, false);
    assert.equal(r.fallbackUsed, true);
    assert.equal(typeof r.residualEvidence, 'string');
    assert.ok(r.residualEvidence.length > 0, 'success=false 必须给出可转呈的残留证据');
    assert.ok(r.residualEvidence.includes('注册表') && r.residualEvidence.includes('安装目录'), `残留证据应逐项列出：${r.residualEvidence}`);
    assert.ok(r.residualEvidence.includes('WXWork'), '证据应指向实际安装根（反推得来）');
    assert.equal(r.verified.dirGone, false, 'verified 必须是再核验的真实结果');
  });

  test('非 NSIS（MSI）核验失败 → 永不回退（fallbackUsed=false），success=false', () => {
    const msi = {
      DisplayName: '7-Zip',
      InstallLocation: 'C:\\Program Files\\7-Zip',
      UninstallString: 'C:\\Windows\\System32\\MsiExec.exe /X{23170F69-40C1-40F1-81E0-6E7D095D9451}',
    };
    const r = runK6StateMachine({
      id: '7zip.7zip',
      entry: msi,
      afterWinget: { registryKeyExists: true, dirExists: true, exeExists: true },
      // afterFallback 故意给出「回退能成功」的探针，用于证明 MSI 分支根本没走回退
      afterFallback: { registryKeyExists: false, dirExists: false, exeExists: false },
    });
    assert.equal(r.verified.installerType, 'msi');
    assert.equal(r.success, false);
    assert.equal(r.fallbackUsed, false, 'R3-5：MSI 永不回退');
    assert.equal(r.verified.dirGone, false, '回执必须停留在 winget 后的核验结果，不得伪装成回退后');
    assert.ok(!('residualEvidence' in r) || r.residualEvidence.length > 0, '若携带证据则必须非空');
    // 同理 other 型也不回退
    const other = runK6StateMachine({
      id: 'Foo.Bar',
      entry: { UninstallString: '"C:\\Program Files\\Foo\\unins000.exe"' },
      afterWinget: { registryKeyExists: true, dirExists: true, exeExists: true },
      afterFallback: { registryKeyExists: false, dirExists: false, exeExists: false },
    });
    assert.equal(other.verified.installerType, 'other');
    assert.equal(other.fallbackUsed, false);
    assert.equal(other.success, false);
  });

  test('winget 非零退出 → success=false 且绝不回退（回退只纠正假成功）', () => {
    const r = runK6StateMachine({
      id: 'Tencent.WeChatWork',
      wingetExitCode: -1978335189,
      entry: NSIS_ENTRY_NO_INSTALLLOC,
      afterWinget: { registryKeyExists: true, dirExists: true, exeExists: true },
      afterFallback: { registryKeyExists: false, dirExists: false, exeExists: false },
    });
    assert.equal(r.exitCode, -1978335189);
    assert.equal(r.success, false);
    assert.equal(r.fallbackUsed, false, '非零退出不得触发 /S 回退');
    assert.equal(r.verified.installerType, 'nsis');
    assert.equal(r.verified.registryGone, false, 'verified 为核验前证据（如实）');
  });

  test('取不到卸载键（unknown）：不回退，只做注册表侧判定', () => {
    const r = runK6StateMachine({
      id: 'Ghost.Package',
      entry: null,
      afterWinget: { registryKeyExists: false, dirExists: false, exeExists: false },
    });
    assert.equal(r.verified.installerType, 'unknown');
    assert.equal(r.verified.dirGone, null);
    assert.equal(r.verified.exeGone, true);
    assert.equal(r.verified.registryGone, true);
    assert.equal(r.fallbackUsed, false);
    assert.equal(r.success, true, '无键可反推 → 磁盘无从核验，按注册表消失判定成功（并如实 dirGone=null）');
  });

  test('dryRun 语义不变：不核验不回退，verified=null & fallbackUsed=false', () => {
    for (const exit of [0, 1, -1978335189]) {
      const r = runK6StateMachine({
        id: 'Tencent.WeChatWork',
        dryRun: true,
        wingetExitCode: exit,
        entry: NSIS_ENTRY_NO_INSTALLLOC,
        afterWinget: { registryKeyExists: true, dirExists: true, exeExists: true },
      });
      assert.equal(r.dryRun, true);
      assert.equal(r.verified, null, `dryRun 时 verified 必须为 null（exit=${exit}）`);
      assert.equal(r.fallbackUsed, false, 'dryRun 绝不回退');
      assert.equal(r.success, exit === 0, 'dryRun 的 success 退化为 exitCode===0（免审批预览语义保持）');
      assert.ok(!('residualEvidence' in r) || r.residualEvidence === undefined, 'dryRun 不产残留证据');
    }
  });

  test('全局不变式：非 dryRun 时 success=true ⇒ 最终核验必过；success=false ⇒ 必带可转呈证据或明确核验失败字段', () => {
    const fixtures = [
      { id: 'a', entry: NSIS_ENTRY_NO_INSTALLLOC, afterWinget: { registryKeyExists: false, dirExists: false, exeExists: false } },
      { id: 'b', entry: NSIS_ENTRY_NO_INSTALLLOC, afterWinget: { registryKeyExists: true, dirExists: true, exeExists: true }, afterFallback: { registryKeyExists: false, dirExists: false, exeExists: false } },
      { id: 'c', entry: NSIS_ENTRY_NO_INSTALLLOC, afterWinget: { registryKeyExists: true, dirExists: true, exeExists: true }, afterFallback: { registryKeyExists: true, dirExists: true, exeExists: true } },
      { id: 'd', entry: { UninstallString: 'MsiExec.exe /X{G}', InstallLocation: 'C:\\P' }, afterWinget: { registryKeyExists: true, dirExists: true, exeExists: true } },
      { id: 'e', entry: { UninstallString: 'weird-no-path' }, afterWinget: { registryKeyExists: false, dirExists: true, exeExists: true } },
      { id: 'f', entry: NSIS_ENTRY_NO_INSTALLLOC, wingetExitCode: 5, afterWinget: { registryKeyExists: true, dirExists: true, exeExists: true } },
    ];
    for (const f of fixtures) {
      const r = runK6StateMachine(f);
      assert.ok(typeof r.success === 'boolean' && typeof r.fallbackUsed === 'boolean', `${f.id}: 回执布尔字段齐备`);
      if (r.dryRun) continue;
      if (r.success) {
        assert.equal(verificationPassed(r.verified), true, `${f.id}: success=true 必须最终核验通过（消灭假成功）`);
        assert.equal(r.exitCode, 0, `${f.id}: success=true 蕴含 winget exit 0`);
        assert.ok(!('residualEvidence' in r), `${f.id}: 成功不带残留证据`);
      } else {
        assert.ok(
          r.exitCode !== 0 || verificationPassed(r.verified) === false,
          `${f.id}: success=false 必须有非零退出或核验未过作为依据`,
        );
        if (r.exitCode === 0) {
          assert.ok(
            typeof r.residualEvidence === 'string' && r.residualEvidence.length > 0,
            `${f.id}: exitCode=0 却 success=false 时必须附残留证据`,
          );
        }
      }
      // 非 NSIS 永不回退（对所有分支成立的硬约束）
      if (r.verified && r.verified.installerType !== 'nsis') {
        assert.equal(r.fallbackUsed, false, `${f.id}: 非 NSIS 包 fallbackUsed 恒为 false`);
      }
    }
  });
});

/* ============================================================================
 * ③ PS 侧静态守卫 —— app.ps1 与 R-1…R-8 的一致性（沙箱无 PowerShell，按 CL-017/018/019
 *    既有惯例做源码级锁定；真机行为由 QA T05 / R3-6 对照回归兜底）
 * ========================================================================== */

const APP_PS1 = read('packages', 'vm-capabilities', 'psmod', 'app.ps1');

/** 把全文切成 { text, start, end } 行数组（供按行定位用） */
const PS_LINES = (() => {
  const out = [];
  let off = 0;
  for (const text of APP_PS1.split('\n')) {
    out.push({ text, start: off, end: off + text.length });
    off += text.length + 1;
  }
  return out;
})();

/** 按大括号配平取出 PS 函数体（含函数头与其紧邻的**上方注释块**），取不到返回 null */
function psFn(name) {
  const re = new RegExp(`function\\s+${name}\\s*\\{`, 'm');
  const m = re.exec(APP_PS1);
  if (!m) return null;
  const from = APP_PS1.indexOf('{', m.index + m[0].length - 1);
  let depth = 0;
  let inSQ = false;
  let inDQ = false;
  for (let i = from; i < APP_PS1.length; i++) {
    const c = APP_PS1[i];
    if (inSQ) { if (c === "'") inSQ = false; continue; }
    if (inDQ) { if (c === '`') { i++; continue; } if (c === '"') inDQ = false; continue; }
    if (c === "'") { inSQ = true; continue; }
    if (c === '"') { inDQ = true; continue; }
    if (c === '#') { const nl = APP_PS1.indexOf('\n', i); i = nl === -1 ? APP_PS1.length : nl; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        // R 编号标注写在函数**上方注释**里，须一并纳入守卫范围
        const defLine = PS_LINES.findIndex((l) => l.start <= m.index && m.index < l.end);
        let start = defLine >= 0 ? PS_LINES[defLine].start : m.index;
        for (let k = defLine - 1; k >= 0; k--) {
          if (/^\s*#/.test(PS_LINES[k].text)) { start = PS_LINES[k].start; continue; }
          break;
        }
        return APP_PS1.slice(start, i + 1);
      }
    }
  }
  return null;
}

/** 逐行剥离 PS 注释（`#` 在单/双引号内不生效），用于「代码形态」断言 */
function stripPsComments(text) {
  return text
    .split('\n')
    .map((line) => {
      let inSQ = false;
      let inDQ = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (inSQ) { if (c === "'") inSQ = false; continue; }
        if (inDQ) { if (c === '`') { i++; continue; } if (c === '"') inDQ = false; continue; }
        if (c === "'") { inSQ = true; continue; }
        if (c === '"') { inDQ = true; continue; }
        if (c === '#') return line.slice(0, i);
      }
      return line;
    })
    .join('\n');
}

/** 取 PS 函数的**纯代码**（去注释） */
function psFnCode(name) {
  const f = psFn(name);
  return f ? stripPsComments(f) : null;
}

describe('R17-T02 · app.ps1 K6 状态机（静态守卫）', () => {
  test('规则合同要求的函数族齐备，且函数头标注 R 编号（可追溯性）', () => {
    for (const fn of [
      'Get-PackageUninstallEntry',        // 设计 §A5
      'Test-UninstallState',              // 设计 §A5
      'Invoke-NsisSilentFallback',        // 设计 §A5
      'Get-UninstallInstallerType',       // R-1
      'Get-PackageInstallRoot',           // R-2 / R-2b
      'Test-UninstallVerificationPassed', // R-5
      'Get-UninstallResidualEvidence',    // R-8
    ]) {
      assert.ok(psFn(fn), `app.ps1 应定义函数 ${fn}`);
    }
    assert.ok(/R-1/.test(psFn('Get-UninstallInstallerType')), 'Get-UninstallInstallerType 注释应标 R-1');
    assert.ok(/R-2/.test(psFn('Get-PackageInstallRoot')), 'Get-PackageInstallRoot 注释应标 R-2');
    assert.ok(/R-3/.test(psFn('Test-UninstallState')), 'Test-UninstallState 注释应标 R-3');
    assert.ok(/R-5/.test(psFn('Test-UninstallVerificationPassed')), '通过判定注释应标 R-5');
    assert.ok(/R-6/.test(psFn('Invoke-NsisSilentFallback')), '回退函数注释应标 R-6');
    assert.ok(/R-8/.test(psFn('Get-UninstallResidualEvidence')), '证据函数注释应标 R-8');
  });

  test('R-1：msiexec 先判 msi；有 QuietUninstallString 不得判 nsis；叶名不区分大小写', () => {
    const f = psFnCode('Get-UninstallInstallerType');
    assert.ok(/-match '\(\?i\)msiexec'/.test(f), '须先以不区分大小写的 msiexec 判 msi');
    assert.ok(/return 'msi'/.test(f), '须有 msi 分支');
    assert.ok(/return 'unknown'/.test(f), '无键须返回 unknown');
    const idxQu = f.indexOf("if ($qu) { return 'other' }");
    const idxNsis = f.indexOf("'uninstall.exe'");
    assert.ok(idxQu > 0, '须有「QuietUninstallString 非空 → other」分支');
    assert.ok(idxNsis > 0 && idxQu < idxNsis, 'QuietUninstallString 门槛必须先于 nsis 判定');
    assert.ok(/-ieq 'uninstall\.exe'/.test(f), '叶名比较须 -ieq（不区分大小写）');
    assert.ok(f.includes('[System.IO.Path]::GetFileName'), '叶名须用 [IO.Path]::GetFileName（纯字符串）');
    assert.ok(!f.includes('Split-Path'), 'R-1 判定代码内不得用 Split-Path（provider 解析不稳）');
  });

  test('R-2 / R-2b：InstallLocation 优先 → UninstallString 反推 → msi 禁止反推 → 仍无则空串', () => {
    const f = psFnCode('Get-PackageInstallRoot');
    assert.ok(f.includes("['InstallLocation']"), '① 须优先读 InstallLocation');
    assert.ok(f.includes("TrimEnd('\\', '/')"), '须去尾分隔符');
    assert.ok(
      /Get-UninstallInstallerType -Entry \$Entry\) -eq 'msi'/.test(f),
      'R-2b：msi 型须直接返回空（禁止用 MsiExec.exe 反推出 System32）',
    );
    assert.ok(f.includes("'UninstallString', 'QuietUninstallString'"), '② 反推须按 Uninstall→Quiet 顺序');
    assert.ok(f.includes('[System.IO.Path]::GetDirectoryName'), '反推须取所在目录（纯字符串运算）');
    assert.ok(f.includes("-match '[\\\\/]'"), '反推结果须仍含分隔符才算真目录，否则视为派生失败');
  });

  test('R-3：DisplayIcon 剥离 `,0`；不递归扫描；dirGone 三态；探针异常 fail-closed', () => {
    const f = psFnCode('Get-PackagePrimaryExeName');
    assert.ok(/Replace\(\$raw, ',\\s\*\\d\+\\s\*\$'/.test(f), '须剥离 DisplayIcon 的 `,0` 图标索引后缀');
    const s = psFnCode('Test-UninstallState');
    assert.ok(!/-Recurse/.test(s), '核验代码不得含递归扫描（R-3：不做全盘扫描）');
    assert.ok(/dirGone\s+=\s+\$null/.test(s), 'dirGone 须初始为 $null（派生不出即保持 null）');
    assert.ok(s.indexOf("$v['dirGone'] = ") > s.indexOf('if ($root)'), 'dirGone 赋值须在 $root 非空分支内');
    assert.ok(/\$v\['exeGone'\] = \(-not \$exeExists\)/.test(s), '有主程序名线索时 exeGone 独立于目录判定');
    assert.ok(/\$v\['exeGone'\] = \(-not \$dirExists\)/.test(s), '无主程序名线索时退化由目录存在性推定');
    assert.ok(/catch \{ \$dirExists = \$true \}/.test(s), '目录探针异常须按仍存在处理（fail-closed，不得误判已删）');
    assert.ok(/catch \{ \$exeExists = \$true \}/.test(s), 'exe 探针异常须按仍存在处理（fail-closed）');
    assert.ok(/catch \{ \$stillLookupFailed = \$true \}/.test(s), '注册表查找异常须置标志（区别于「键不存在」）');
    assert.ok(/\(-not \$stillLookupFailed\)/.test(s), 'registryGone 须与查找异常联合判定（异常⇒false）');
  });

  test('R-4：预捕获必须先于 winget 卸载（否则真卸载后取不到核验目标）', () => {
    const u = psFnCode('Uninstall-WingetPackage');
    const idxPrecap = u.indexOf('Get-PackageUninstallEntry -Id $Id -DisplayName $installedName');
    // 真卸载是**最后一次** `& winget @wingetArgs`（第一次位于 dryRun 块内，带 --dry-run）
    const idxRun = u.lastIndexOf('& winget @wingetArgs 2>&1');
    assert.ok(idxPrecap > 0, '应预捕获卸载键');
    assert.ok(idxPrecap < idxRun, 'R-0：预捕获须先于 `winget uninstall`（真卸载成功后键即消失）');
    const e = psFn('Get-PackageUninstallEntry');
    assert.ok(/-ieq \$Id/.test(e), '匹配须含键名精确层级');
    assert.ok(/Get-NormalizedPackageName/.test(e), '匹配须走归一化比较（不手写中文字面量）');
  });

  test('R-5：dirGone=$null 不阻断通过；三态先判 $null 再判布尔', () => {
    const f = psFnCode('Test-UninstallVerificationPassed');
    assert.ok(f.includes("[bool]$V['registryGone']"), '应判 registryGone');
    assert.ok(f.includes("[bool]$V['exeGone']"), '应判 exeGone');
    assert.ok(/\$null -ne \$V\['dirGone'\]/.test(f), 'dirGone 须先判 $null（三态）');
    assert.ok(!/if\s*\(\s*-not\s+\$V\['dirGone'\]\s*\)/.test(f), '不得写 `-not $V[dirGone]`（会把 $null 误判为残留）');
  });

  test('R-6/R-7：分支次序、dryRun 短路、非 NSIS 永不回退、success 以核验为准', () => {
    const u = psFnCode('Uninstall-WingetPackage');
    const idxArgs = u.indexOf("$wingetArgs += '--dry-run'");
    const idxDry = u.indexOf('if ($DryRun) {', idxArgs);
    const idxPrecap = u.indexOf('Get-PackageUninstallEntry -Id $Id -DisplayName $installedName');
    const idxRun = u.indexOf('& winget @wingetArgs 2>&1', idxPrecap);
    assert.ok(idxDry > 0 && idxDry < idxPrecap && idxPrecap < idxRun, '顺序：dryRun 短路 → 预捕获 → 卸载');
    const dryBlock = u.slice(idxDry, idxPrecap);
    assert.ok(/verified\s+=\s+\$null/.test(dryBlock), 'dryRun 回执 verified=$null');
    assert.ok(/fallbackUsed = \$false/.test(dryBlock), 'dryRun 回执 fallbackUsed=$false');
    assert.ok(/success      = \(\[int\]\$exit -eq 0\)/.test(dryBlock), 'dryRun success 退化为 exitCode===0');
    assert.ok(!dryBlock.includes('Invoke-NsisSilentFallback'), 'dryRun 绝不回退');

    const idxExit = u.indexOf('if ($exit -ne 0) {', idxRun);
    const idxNonNsis = u.indexOf("if ($fbType -ne 'nsis') {", idxRun);
    const idxFbCall = u.indexOf('Invoke-NsisSilentFallback -UninstallExe', idxRun);
    assert.ok(idxExit > 0 && idxExit < idxNonNsis && idxNonNsis < idxFbCall, '分支次序：exit≠0 → 非 NSIS 拒回退 → 才回退');
    assert.ok(u.slice(idxExit, idxNonNsis).includes('fallbackUsed = $false'), 'exit≠0 分支不触发回退');
    assert.ok(u.indexOf('fallbackUsed = $false', idxNonNsis) < idxFbCall, '非 NSIS 分支必须 fallbackUsed=$false（R3-5）');

    const tail = u.slice(idxFbCall);
    assert.ok(tail.includes('Test-UninstallState -Id $Id'), '回退后必须再核验（R-6）');
    assert.ok(/\$success = \[bool\]\$passed2/.test(tail), '回退后 success 以再核验为准');
    assert.ok(/\$fallbackUsed = \$true/.test(tail), '回退分支置 fallbackUsed=$true');

    for (const [lit, label] of [
      ['$totalBudgetMs = 600000', '600s 总预算'],
      ['$wingetBudgetMs = 300000', 'winget ≤300s'],
      ['$fallbackBudgetMs = 240000', '回退 ≤240s'],
      ['$verifyBudgetMs = 30000', '核验 ≤30s'],
    ]) {
      assert.ok(u.includes(lit), `应声明${label}（${lit}）`);
    }
    assert.ok(
      /\[Math\]::Min\(\$fallbackBudgetMs, \(\$totalBudgetMs - \$elapsedMs - \$reserveAfterFallbackMs\)\)/.test(u),
      '回退预算须按「总预算 − 已用时 − 核验预留」裁剪（严禁突破 600s）',
    );
    const fbWait = psFnCode('Invoke-NsisSilentFallback');
    assert.ok(/WaitForExit\(\$TimeoutMs\)/.test(fbWait), '回退须受限等待（不得无限阻塞）');
    assert.ok(/-9996/.test(fbWait), '超时必须返回可诊断错误码（不得静默当成功）');
  });

  test('R-8 + 契约对齐：每条回执恒含 verified/fallbackUsed 与四必填子字段；成功不携残留证据', () => {
    const u = psFnCode('Uninstall-WingetPackage');
    const fbCount = (u.match(/fallbackUsed\s?=\s+\$(?:true|false|fallbackUsed)/g) || []).length;
    assert.ok(fbCount >= 6, `六条返回路径都应有 fallbackUsed，实际=${fbCount}`);
    const vCount = (u.match(/verified\s+=\s+\$(?:null|verified)/g) || []).length;
    assert.ok(vCount >= 6, `六条返回路径都应有 verified，实际=${vCount}`);

    const s = psFnCode('Test-UninstallState');
    for (const key of ['exeGone', 'dirGone', 'registryGone', 'installerType']) {
      assert.ok(
        new RegExp(`\\$v\\s*=\\s*\\[ordered\\]@\\{[\\s\\S]*?${key}\\s+=`).test(s),
        `verified 载荷须恒含必填字段 ${key}（含 unknown 场景）`,
      );
    }
    // 成功路径不携带残留证据
    const idxPassed1 = u.indexOf('if ($passed1) {');
    assert.ok(idxPassed1 > 0, '应存在「首次核验通过」分支');
    assert.ok(!u.slice(idxPassed1, u.indexOf("if ($fbType -ne 'nsis')")).includes('residualEvidence'), '核验通过分支不得携带残留证据');
    // 失败路径必附证据（含「无从判定」兜底文案，杜绝空串逃逸）
    assert.ok(/if \(\$evidence\) \{ \$receipt\['residualEvidence'\]/.test(u), '失败分支应附残留证据');
    assert.ok(/else \{ \$receipt\['residualEvidence'\]/.test(u), '证据为空时须有兜底文案（不得缺失字段）');
    assert.ok(!APP_PS1.includes("DisplayName' -eq '企业"), '不得手写中文字面量做包名比较');
  });
});

#!/usr/bin/env node
/**
 * 阶段 5 / Step 5.2 验收 —— install.ps1 壳 + skip-install 默认化
 *
 * 判据设计要点（沿用 5.1 的教训）：
 *   - **别照计划书原话写判据**。原文第二条是 `grep -c "skip-install" delivery/pack-release.mjs >= 1`。
 *     实测该判据**恒真且无意义**：pack-release 里唯一那处 "skip-install" 是一行**文档字符串**
 *     （README 正文"VM 侧经 install-vm --skip-install"），改成 0 也不影响任何行为。
 *     所以本条改为直指病灶：**发布包路径的 VM 安装是否真的带 --skip-install**，
 *     证据取自 `setup.mjs` 的 `buildVmInstallPs1()` —— 那才是真正生成远端命令的地方。
 *   - **ps1 编码约束必须机械化**：本仓 PS 5.1 解析器读不了带非 ASCII 的 BOM-less UTF-8，
 *     `winvm-prepare.ps1` 已有同类守卫；install.ps1 同样必须有。
 *
 * 跑法：node qa/accept-step52.mjs
 * 退出码：0 = 全过；1 = 有判据红。
 */

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const read = (rel) => readFileSync(new URL(`../${rel.replace(/^\.\//, '')}`, import.meta.url), 'utf8');
const bytes = (rel) => readFileSync(new URL(`../${rel.replace(/^\.\//, '')}`, import.meta.url));
const ROOT = new URL('..', import.meta.url).pathname;

const results = [];
function check(name, fn) {
  try {
    const r = fn();
    results.push({ name, ok: r === true || r === undefined, detail: typeof r === 'string' ? r : '' });
  } catch (e) {
    results.push({ name, ok: false, detail: e.message });
  }
}

const PS1 = 'delivery/install.ps1';
const PR = 'delivery/pack-release.mjs';
const SU = 'delivery/setup.mjs';

/* ---------- ① 壳存在且是「壳」而非重实现 ---------- */
check('① install.ps1 存在', () => {
  if (!existsSync(`${ROOT}/${PS1}`)) throw new Error('文件不存在');
});

check('② ps1 只转发到 install-vm.mjs（不重写安装逻辑）', () => {
  const src = read(PS1);
  if (!/install-vm\.mjs/.test(src)) throw new Error('未引用 install-vm.mjs');
  /* ⚠ 判据必须区分「执行」与「提到」。
   *
   * 壳里合法地会**提到** `npm ci` —— 例如提示文案
   * `dep resolution: skipped npm ci (-SkipInstall)`，这是可观测性，不是重实现。
   * 首版判据直接全文匹配 /npm ci/i 于是误报。正确形态是：这些动作只能作为
   * **字符串字面量**出现在 Write-Info / 注释里，不能作为**命令调用**出现。
   * 故：先剥注释，再要求每种动作只出现在引号内（即 log 文案），不得独立成命令。
   */
  const codeOnly = src
    .replace(/<#[\s\S]*?#>/g, '')     // 块注释
    .replace(/^\s*#.*$/gm, '');       // 行注释
  const forbidden = [
    ['npm ci（命令）', /(^|[^'"\w])npm\s+ci\s*(?!['")])/i],
    ['npm run build（命令）', /(^|[^'"\w])npm\s+run\s+build/i],
    ['schtasks', /schtasks/i],
    ['New-ScheduledTask', /New-ScheduledTask/i],
    ['Set-Content 写配置', /Set-Content[\s\S]{0,120}vm-service\.config/i],
  ];
  const bad = [];
  for (const [label, re] of forbidden) {
    // 逐行检查：命中且该行不是纯文案行（不含 Write-Info / Write-Host）才判越界
    for (const line of codeOnly.split(/\r?\n/)) {
      if (re.test(line) && !/Write-(Info|Host|Fail)/.test(line)) bad.push(label);
    }
  }
  if (bad.length) throw new Error(`壳里出现了安装逻辑（应全部委托 install-vm.mjs）：${[...new Set(bad)].join(', ')}`);
});

check('② 参数逐一透传（不是选择性丢弃）', () => {
  const src = read(PS1);
  // 每个受支持的开关都必须落到 $argv 里
  const must = ['--dry-run', '--uninstall', '--skip-build', '--skip-links', '--skip-skills', '--provider', '--cli', '--port', '--config', '--task-name', '--skills-root'];
  const missing = must.filter((f) => !src.includes(`'${f}'`));
  if (missing.length) throw new Error(`未透传：${missing.join(', ')}`);
  // 剩余参数兜底（ValueFromRemainingArguments → $Rest 全量 append）
  if (!/\$Rest/.test(src)) throw new Error('缺少剩余参数兜底（-Rest 未接）');
});

/* ---------- ③ 找 node 必须 fail-loud（绝不静默 exit 0） ---------- */
check('③ node 缺失时显式报错并返回非 0（不静默成功）', () => {
  const src = read(PS1);
  if (!/node not found/i.test(src)) throw new Error('缺少 node 缺失时的明确报错文案');
  if (!/exit 1/.test(src)) throw new Error('缺少非零退出');
  if (!/nodejs\.org/.test(src)) throw new Error('缺少下载指引（运维要能自助）');
});

check('③ node 解析有四级优先级且显式优于 env 优于 PATH', () => {
  const src = read(PS1);
  /* ⚠ 判据必须在**代码区**定位，不能对全文 indexOf。
   *
   * 首版用 `src.indexOf('WINVM_NODE_BIN')` 直接命中文件头 .DESCRIPTION 里的说明文字
   *（"2. $env:WINVM_NODE_BIN (environment override)"），于是拿到 695 < 3174，
   * 判"优先级顺序错"——纯属误报。注释里提到一个概念，不代表它在那个位置被实现。
   */
  const code = src.replace(/<#[\s\S]*?#>/g, '').replace(/^\s*#.*$/gm, '');
  const iExplicit = code.indexOf('if ($Explicit)');
  const iEnv = code.indexOf('$env:WINVM_NODE_BIN');
  const iPath = code.indexOf('Get-Command node');
  if (iExplicit < 0) throw new Error('缺少 -NodePath 显式分支');
  if (iEnv < 0) throw new Error('缺少 WINVM_NODE_BIN 环境变量分支');
  if (iPath < 0) throw new Error('缺少 Get-Command node（PATH 分支）');
  if (!(iExplicit < iEnv && iEnv < iPath)) {
    throw new Error(`优先级顺序错（代码区位置）：Explicit=${iExplicit} env=${iEnv} PATH=${iPath}`);
  }
  // 常见安装位置兜底必须存在（VM 上 node 常常不在 PATH，这是实际踩过的坑）
  if (!/ProgramFiles/.test(code)) throw new Error('缺少常见安装目录兜底');
});

/* ---------- ④ 退出码必须透传（壳不能吞掉失败） ---------- */
check('④ 透传 install-vm.mjs 的真实退出码', () => {
  const src = read(PS1);
  if (!/\$LASTEXITCODE/.test(src)) throw new Error('未读取 $LASTEXITCODE');
  if (!/exit\s+\$code/.test(src)) throw new Error('未按真实退出码退出（会吞失败）');
});

/* ---------- ⑤ skip-install：行为事实判据（不是 grep 文档字符串） ---------- */
check('⑤ 发布包 VM 安装命令确实带 --skip-install（证据取自 buildVmInstallPs1）', () => {
  const src = read(SU);
  const m = src.match(/export function buildVmInstallPs1[\s\S]*?\n}/);
  if (!m) throw new Error('未找到 buildVmInstallPs1（判据锚点失效，先修判据）');
  const body = m[0];
  if (!/--skip-install/.test(body)) {
    throw new Error('buildVmInstallPs1 生成的远端命令未含 --skip-install —— 发布包会在 VM 内跑 npm ci');
  }
  // 同时必须带 --skip-build：包内 dist 已构建，远端重编译既慢又可能与 MANIFEST 指纹脱钩
  if (!/--skip-build/.test(body)) throw new Error('缺少 --skip-build（包内 dist 已构建）');
});

check('⑤ ps1 壳也会在 dist 就绪时默认 --skip-install（源码检出则保留 npm ci）', () => {
  const src = read(PS1);
  if (!/--skip-install/.test(src)) throw new Error('install.ps1 未支持 --skip-install');
  if (!/hasDist/.test(src)) throw new Error('缺少「dist 是否在场」的判定（否则源码检出会被跳过依赖安装）');
  // -InstallDeps 反向开关必须存在，否则源码检出场景无法强制 npm ci
  if (!/InstallDeps/.test(src)) throw new Error('缺少 -InstallDeps 反向开关');
});

/* ---------- ⑥ 包内存在性登记 ---------- */
check('⑥ pack-release 三处清单登记 install.ps1（VM / PACKAGE_REQUIRED.vm / overall）', () => {
  const src = read(PR);
  const vm = src.slice(src.indexOf('const VM_DELIVERY'), src.indexOf('const OVERALL_EXTRA_DELIVERY'));
  const req = src.slice(src.indexOf('const PACKAGE_REQUIRED'));
  const hits = [
    ['VM_DELIVERY', vm.includes("'delivery/install.ps1'")],
    ['PACKAGE_REQUIRED.vm', /vm:\s*\[[\s\S]*?'delivery\/install\.ps1'/.test(req)],
    ['PACKAGE_REQUIRED.overall', /overall:\s*\[[\s\S]*?'delivery\/install\.ps1'/.test(req)],
  ];
  const bad = hits.filter(([, ok]) => !ok).map(([k]) => k);
  if (bad.length) throw new Error(`缺登记：${bad.join(', ')}`);
});

/* ---------- ⑦ ps1 编码硬约束（PS 5.1 解析器坑） ---------- */
check('⑦ install.ps1 纯 ASCII（>127 零命中）', () => {
  const b = bytes(PS1);
  const bad = [...b].filter((x) => x > 127).length;
  if (bad) throw new Error(`发现 ${bad} 个非 ASCII 字节（PS 5.1 读 BOM-less UTF-8 中文会乱码/解析失败）`);
});

check('⑦ install.ps1 无 BOM', () => {
  const b = bytes(PS1);
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) throw new Error('存在 UTF-8 BOM');
});

check('⑦ install.ps1 CRLF 行尾（孤立 LF = 0）', () => {
  const b = bytes(PS1);
  const crlf = (b.toString('latin1').match(/\r\n/g) || []).length;
  const lf = (b.toString('latin1').match(/\n/g) || []).length;
  if (lf - crlf !== 0) throw new Error(`存在 ${lf - crlf} 个孤立 LF`);
});

/* ---------- ⑧ 语法可解析（借用 pwsh/不依赖 Windows） ---------- */
check('⑧ install.ps1 param 块可通过基本形态检查', () => {
  const src = read(PS1);
  if (!/\[CmdletBinding\(\)\]/.test(src)) throw new Error('缺少 [CmdletBinding()]');
  if (!/param\s*\(/.test(src)) throw new Error('缺少 param 块');
  // 括号平衡（粗检：排除字符串内的情况过于复杂，这里只做整体计数，异常时人工核查）
  const opens = (src.match(/[({[]/g) || []).length;
  const closes = (src.match(/[)}\]]/g) || []).length;
  if (opens !== closes) throw new Error(`括号不配对：open=${opens} close=${closes}（可能字符串内含括号，需人工核）`);
});

/* ---------- ⑨ 既有单测不回归 ---------- */
check('⑨ ps1 守卫既有单测仍通过（winvm-prepare 的同类约束未被破坏）', () => {
  execFileSync(process.execPath, ['--test', `${ROOT}/tests/unit/winvm-prepare-ps1.test.js`], { stdio: 'pipe' });
});

/* ---------- ⑩ 模块可加载（node --check 抓不到的坑） ----------
 * 本步真实踩过：在 pack-release.mjs 的**数组字面量内部**写了 Python 风格的 `# 注释`。
 * `node --check` 只做**语法层**词法分析，没报错（`#` 在 JS 里要到解析期才成为非法 token）；
 * 真正炸的是 `import()` 加载期 —— `publish-release.test.js` 直接 SyntaxError，
 * 而它不在 `--quick` 门禁的守卫件里，于是"改了 pack-release"看似无恙。
 * ⇒ 判据必须做**真实加载**，不能只做语法检查。
 */
check('⑩ 被改动的 delivery 模块均可真实 import（非仅 node --check）', () => {
  const mods = ['delivery/connect-channel.mjs', 'delivery/pack-release.mjs', 'delivery/install-host.mjs'];
  for (const m of mods) {
    try {
      execFileSync(process.execPath, ['-e', `import('./${m}').catch(e=>{console.error(e.message);process.exit(1)})`],
        { stdio: 'pipe', cwd: ROOT });
    } catch (e) {
      throw new Error(`${m} 加载失败：${(e.stderr ?? '').toString().split('\n')[0]}`);
    }
  }
});

/* ---------- 汇总 ---------- */
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? `  —— ${r.detail}` : ''}`);
console.log(`\nSUMMARY checks=${results.length} fails=${failed.length} VERDICT=${failed.length ? 'RED' : 'GREEN'}`);
process.exit(failed.length ? 1 : 0);
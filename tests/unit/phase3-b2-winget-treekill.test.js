/**
 * Phase 3 批2 · Q5 winget 超时树杀（单测，静态源码守卫）
 *
 * 病灶（audit-qa ⑦ / 2026-10-08 实现运维审计 :788，在册未修）：app.ps1 的 winget 长调用为
 * `& winget ...` in-proc 调用，调用方拿不到子进程对象 → 超时到来杀不到进程树 → 卸载/安装类
 * 操作留孤儿 winget/安装器子进程（安全面）。
 *
 * 断言不变量（无 PowerShell 环境 ⇒ 静态守卫手法，与 cl017-psmod-sort / r3 同款）：
 *  - Invoke-WingetBounded：有界等待 + taskkill /PID /T /F（PS 5.1 兼容：Kill 自身 + 兜底）
 *    + 双流异步读（防管道死锁）+ 超时 exit=-1（绝不谎报成功）+ spawn 失败诊断码；
 *  - Install / Uninstall / Update 三处长调用均走 Invoke-WingetBounded；
 *  - Invoke-NsisSilentFallback 超时分支含树杀（audit-qa ⑦ 点名缺口）；
 *  - 孤儿显形 WARN 不静默。
 *
 * 运行（只跑本文件，绝不整批）：node --test tests/unit/phase3-b2-winget-treekill.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const APP_PS1 = readFileSync(join(ROOT, 'packages', 'vm-capabilities', 'psmod', 'app.ps1'), 'utf8');

/** 与 r3-uninstall-verify 同款函数体抽取（brace 深度配对，跳过字符串/注释） */
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
      if (depth === 0) return APP_PS1.slice(from, i + 1);
    }
  }
  return null;
}

test('Invoke-WingetBounded：有界等待 + PS5.1 兼容树杀 + 双流异步读 + 超时记 -1', () => {
  const f = psFn('Invoke-WingetBounded');
  assert.ok(f, 'app.ps1 须定义 Invoke-WingetBounded（Q5 树杀执行体）');
  assert.match(f, /WaitForExit\(\$TimeoutMs\)/, '须受限等待（不得无限阻塞）');
  assert.match(f, /taskkill\.exe \/PID \$procId \/T \/F/, '超时须 taskkill /T 树杀（含孙进程）');
  assert.match(f, /\$proc\.Kill\(\)/, 'Kill 自身先行（与 appops.cli.invoke 同款双保险）');
  assert.match(f, /ReadToEndAsync\(\)/, '双流异步读（防管道缓冲死锁）');
  assert.match(f, /RedirectStandardOutput = \$true/, '须重定向 stdout（拿输出行）');
  // 超时路径 exit 记 -1（可诊断，绝不拿旧 ExitCode 谎报 0）
  assert.match(f, /\$exit = -9994\s*\n\s*if \(-not \$timedOut\)[\s\S]*?else \{ \$exit = -1 \}/,
    '超时 ⇒ exit=-1、非超时取真实码、取不到兜 -9994');
  assert.match(f, /WINGET_SPAWN_FAILED/, 'spawn 失败有专属诊断（-9994 族）');
  assert.match(f, /Get-Command winget/, '显式解析 winget 全路径（App Execution Alias 兼容）');
});

test('三处 winget 长调用（install/uninstall/upgrade）全部走 Invoke-WingetBounded', () => {
  for (const fn of ['Install-WingetPackage', 'Uninstall-WingetPackage', 'Update-WingetPackage']) {
    const f = psFn(fn);
    assert.ok(f, `${fn} 应存在`);
    assert.match(f, /Invoke-WingetBounded/, `${fn} 长调用须走有界执行体（Q5）`);
  }
  // install/upgrade 不再残留 in-proc 长调用裸面（`$raw = & winget @args 2>&1`）
  assert.ok(!/^\s*\$raw\s*=\s*&\s*winget\b/m.test(psFn('Install-WingetPackage')), 'install 不得残留 `& winget` 裸调用');
  assert.ok(!/^\s*\$raw\s*=\s*&\s*winget\b/m.test(psFn('Update-WingetPackage')), 'upgrade 不得残留 `& winget` 裸调用');
});

test('Uninstall-WingetPackage：超时=失败（exit≠0 短路 R-6）且孤儿显形 WARN 不静默', () => {
  const f = psFn('Uninstall-WingetPackage');
  assert.match(f, /if \(\$wingetRun\['timedOut'\]\)/, '超时须在回执留 TIMED-OUT 痕');
  assert.match(f, /\[q5\] WARN/, '本调用派生仍存活的 winget 进程要点名（孤儿显形，绝不静默）');
  assert.match(f, /if \(\$exit -ne 0\) \{/, '超时 exit=-1 走非零短路 ⇒ success=false 结构成立（不谎报）');
});

test('Invoke-NsisSilentFallback：超时分支升级树杀（audit-qa ⑦ 点名缺口）', () => {
  const f = psFn('Invoke-NsisSilentFallback');
  assert.match(f, /taskkill\.exe \/PID \$nsisPid \/T \/F/, 'NSIS 卸载器派生树超时须 /T 清（旧仅 $proc.Kill() 单点）');
  assert.match(f, /return -9996/, '超时诊断码 -9996 保留（r3 R-6 合同不变）');
  assert.match(f, /WaitForExit\(\$TimeoutMs\)/, '受限等待保留（r3 守卫）');
});

test('app.ps1：长调用面已收敛，仅 search/list 只读短调用保留裸 & winget', () => {
  const longCallFaces = APP_PS1
    .split('\n')
    .filter((l) => /^\s*\$\w+\s*=\s*&\s*winget\b/.test(l));
  // 允许：search（L0 只读 60s）、list（Get-WingetInstalledName 只读）；禁止 install/upgrade/uninstall 面
  for (const l of longCallFaces) {
    assert.ok(/winget search|winget list/.test(l), `不该再有长调用裸面：${l.trim()}`);
  }
});

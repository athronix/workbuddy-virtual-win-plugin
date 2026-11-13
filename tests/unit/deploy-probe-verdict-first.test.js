/**
 * 部署探针 vm-env-check.ps1 · 判定行顺序守卫（verdict-before-slow-probes）
 *
 * ## 为什么存在（11-13 真机实证，V1.4.27 deploy 卡 C3.0）
 * C3.0 是 deploy 的**硬门禁**：判据 = 日志里同时出现 `ENV_PRECHECK=PASS` 与
 * `BLOCKERS=none`。旧版探针把 verdict 排在几条 PowerShell 垫片调用（`npm ls -g`、
 * `npm config get prefix`、codebuddy 配置扫描）**之后**；本机实测这些调用单条 21-35s，
 * 累计贴着 ps-run 的 300s exec 窗 ⇒ 探针被截断，日志有 NODE_OK/CLI_OK 但**没有**
 * ENV_PRECHECK 行 ⇒ 门禁判 FAIL ⇒ R3 FAIL ⇒ verify 被 SKIP。整链假红，根因纯属
 * 「判据行排在慢探测后面」。
 *
 * verdict 只依赖 nodeOk / npmCmd / cliOk 三个变量，前置是**语义等价**改动；前置后即使
 * 尾部信息面（GLOBAL_PKG / NPM_PREFIX / AUTH_*）被截断，门禁判定也不受影响。
 *
 * ## 判据（脱 VM、零 spawn、纯磁盘读）
 *   ① `Out 'ENV_PRECHECK'` 的首次出现必须**早于** `npm ls -g`
 *   ② 必须早于 `npm config get prefix`
 *   ③ 必须早于 auth 扫描目录（`.codebuddy` 拼接）
 *   ④ 字节全 ASCII（远端 PS5.1 铁律；中文注释回潮即红）
 *   ⑤ PASS/FAIL 两分支都在（防「只留 PASS 分支」式假绿）
 *
 * 运行（只跑本文件）：node --test tests/unit/deploy-probe-verdict-first.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PS1 = join(import.meta.dirname, '..', '..', 'qa', 'deploy-probes', 'vm-env-check.ps1');
const BUF = readFileSync(PS1);
const SRC = BUF.toString('latin1'); // latin1 保字节面，ASCII 判据按字节说话
// 只在**代码面**比顺序：注释里会引用这些命令名（本文件注释就提到过 npm config get prefix，
// 首版断言正是被自己的注释带偏）。注释不算执行顺序，但注释也必须是输入面的一部分——
// 所以先剔注释行再比，而不是放宽成「包含即可」。
const CODE = SRC.split('\n')
  .filter((l) => !l.trimStart().startsWith('#'))
  .join('\n');

const idx = (needle) => {
  const i = CODE.indexOf(needle);
  assert.ok(i >= 0, `锚点不存在：${needle}`);
  return i;
};

test('vm-env-check.ps1：verdict 早于 npm ls（C3.0 硬门禁不被慢探测截断）', () => {
  const verdict = idx("Out 'ENV_PRECHECK'");
  const slow = idx('npm ls -g');
  assert.ok(
    verdict < slow,
    `ENV_PRECHECK 必须早于 npm ls -g（实测该调用 21-35s，排在前面会截断判据行）；实际 verdict@${verdict} slow@${slow}`,
  );
});

test('vm-env-check.ps1：verdict 早于 npm config get prefix', () => {
  const verdict = idx("Out 'ENV_PRECHECK'");
  const slow = idx('npm config get prefix');
  assert.ok(verdict < slow, `verdict@${verdict} 必须早于 npm config get prefix@${slow}`);
});

test('vm-env-check.ps1：verdict 早于 .codebuddy 认证面扫描', () => {
  const verdict = idx("Out 'ENV_PRECHECK'");
  const slow = idx(".codebuddy");
  assert.ok(verdict < slow, `verdict@${verdict} 必须早于 .codebuddy 扫描@${slow}`);
});

test('vm-env-check.ps1：PASS/FAIL 两分支俱全（防只剩 PASS 的假绿）', () => {
  assert.ok(SRC.includes("Out 'ENV_PRECHECK' 'PASS'"), '缺 PASS 分支');
  assert.ok(SRC.includes("Out 'ENV_PRECHECK' 'FAIL'"), '缺 FAIL 分支');
  assert.ok(SRC.includes("Out 'BLOCKERS' 'none'"), '缺 BLOCKERS=none 分支');
  assert.ok(SRC.includes("Out 'BLOCKERS' ($blockers -join ',')"), '缺 BLOCKERS 聚合分支');
});

test('vm-env-check.ps1：remedies 段仍在（-Fix 路径不得因搬动 verdict 而丢失）', () => {
  assert.ok(SRC.includes('NEEDS_RUNTIME'), '缺 NEEDS_RUNTIME 补救提示');
  assert.ok(SRC.includes('AFTER_FIX_CLI_OK'), '缺 -Fix 后的复检输出');
});

test('vm-env-check.ps1：字节全 ASCII（PS 5.1 ANSI 码页铁律）', () => {
  const offenders = [];
  for (let i = 0; i < BUF.length; i += 1) {
    if (BUF[i] > 0x7f) offenders.push(i);
    if (offenders.length > 4) break;
  }
  assert.deepEqual(offenders, [], `远端 PS5.1 按 ANSI 码页解码，非 ASCII 必乱码：offsets=${offenders.join(',')}`);
});

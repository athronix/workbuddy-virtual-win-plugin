/**
 * v1.4.32 部署提速与口令引导（单测，纯函数/源级断言，零真机）
 *
 * 覆盖三件事，每件都有「退回去就红」的钉子：
 *  1. `buildPrepareProbePs`（4a 合并探测）：ASCII-only、单行、端口/CLI 注入、
 *     七个事实键齐、以 ConvertTo-Json 收尾 —— 原实现是 7 次 ssh 往返（实测 76s）。
 *  2. `scripts/deploy-1p-autokey.sh`（口令自动建通道）：必须走 ssh2 纯口令面、
 *     先验管理员、用 EncodedCommand 下发、口令不落盘、成功后切回 key 并回验。
 *  3. `scripts/vm-conn.sh`：askpass 的调用形态必须是 `_askpass_env _ssh_t ssh`——
 *     反过来写（`_ssh_t _askpass_env ssh`）会因 timeout 不能 exec shell 函数而永久失败。
 *
 * 运行（只跑本文件）：node --test tests/unit/v1432-probe-autokey.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPrepareProbePs } from '../../delivery/bootstrap.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKILL = join(ROOT, 'skills', 'winvm-plugin-deploy', 'scripts');
const CFG = { servicePort: 18443, sshPort: 22, workbuddyCli: 'codebuddy' };

/* ═══════════════ 1. 4a 合并探测 ═══════════════ */

test('合并探测 PS：ASCII-only 且单行（EncodedCommand 载荷铁律）', () => {
  const ps = buildPrepareProbePs(CFG);
  assert.equal(/[^\x00-\x7F]/.test(ps), false, 'PS 载荷含非 ASCII 字符');
  assert.equal(ps.includes('\n'), false, 'PS 载荷含换行（应为单行 join）');
  assert.equal(ps.length > 300, true, '载荷过短，疑似被截断');
});

test('合并探测 PS：七个事实键齐 + 端口/CLI 注入 + JSON 收尾', () => {
  const ps = buildPrepareProbePs(CFG);
  for (const key of ['$o.admin', '$o.sshdInstalled', '$o.sshdState', '$o.sshdStart', '$o.fwSsh', '$o.fwSvc', '$o.nodeVer', '$o.cli', '$o.cfg']) {
    assert.ok(ps.includes(key), `缺判据键 ${key}`);
  }
  // 端口必须来自入参（硬编码会把换端口部署的机器判成「防火墙缺失」）
  assert.ok(ps.includes("'WinVM-SSH-22'"), 'SSH 端口未注入');
  assert.ok(ps.includes("'WinVM-Service-18443'"), '服务端口未注入');
  assert.ok(ps.includes("Get-Command 'codebuddy'"), 'CLI 名未注入');
  // 单行 JSON：调用方按「最后一行 JSON」解析
  assert.ok(/ConvertTo-Json -Compress\s*$/.test(ps), '未以 ConvertTo-Json -Compress 收尾');
});

test('合并探测 PS：管理员判据走 WindowsPrincipal（等价 net session，但不额外起 cmd.exe）', () => {
  const ps = buildPrepareProbePs(CFG);
  assert.ok(ps.includes('WindowsPrincipal'), '缺管理员判据');
  assert.ok(ps.includes('WindowsBuiltInRole]::Administrator'), '未按内置管理员角色判定');
});

test('bootstrap.mjs：合并探测带硬超时兜底（promise 挂起不得静默 rc=0）', () => {
  const src = readFileSync(join(ROOT, 'delivery', 'bootstrap.mjs'), 'utf8');
  assert.ok(src.includes('combined-probe-timeout'), '缺合并探测超时标记');
  assert.ok(src.includes('Promise.race'), '缺 race 兜底（ssh2 挂起会静默退出）');
  assert.ok(src.includes("if (!usedCombined)"), '缺逐条兜底分支');
  // 兜底分支必须真的重新走逐条（否则「合并失败」= 无数据却继续断言）
  assert.ok(/if \(!usedCombined\) \{[\s\S]{0,400}?probe\('net session'/.test(src), '兜底分支未真正重跑逐条探测');
});

/* ═══════════════ 2/3. 技能侧断言在别的门禁里 ═══════════════
 *
 * `deploy-1p-autokey.sh`（口令自动建通道）、`vm-conn.sh` 的 askpass 调用形态、
 * `ssh2-conn.mjs` 的纯口令分支 —— 这三者都在**部署技能仓**里，本仓的 skills/ 目录
 * 不挂它（避免内容双份漂移），因此不在这里做源级断言。
 * 权威门禁 = 技能仓 `bash scripts/selfcheck.sh --mutate` 的
 *   c_password_bootstrap（正断言）+ M26（把 1p 删成注释 → 必被抓）。
 */

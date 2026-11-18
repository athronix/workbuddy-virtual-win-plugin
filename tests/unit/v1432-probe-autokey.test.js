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
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { buildPrepareProbePs, buildFallbackFactsPs } from '../../delivery/bootstrap.mjs';
import { resolveVmKeyPath } from '../../delivery/ssh2-backend.mjs';

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

test('两条探测 PS：必须吃真实 cfg 形状（vmSshPort），绝不许生成 WinVM-SSH-undefined', () => {
  // 真机事故：resolveConfig 出来的字段叫 vmSshPort，构造器解构 sshPort ⇒ 'WinVM-SSH-undefined'
  // ⇒ 规则名永不匹配 ⇒ 防火墙判据恒定假红（功能正常却每轮多跑一遍幂等 DO）。
  const realCfg = { servicePort: 18443, vmSshPort: 22, workbuddyCli: 'codebuddy' };
  for (const [name, fn] of [['合并', buildPrepareProbePs], ['降级', buildFallbackFactsPs]]) {
    const ps = fn(realCfg);
    assert.equal(/undefined/.test(ps), false, `${name}探测载荷出现 undefined（端口字段错位）`);
    assert.ok(ps.includes("'WinVM-SSH-22'"), `${name}探测：vmSshPort 未被识别`);
    assert.ok(ps.includes("'WinVM-Service-18443'"), `${name}探测：servicePort 未注入`);
  }
  // 端口非法必须早抛，不许静默生成永不匹配的规则名
  assert.throws(() => buildPrepareProbePs({ servicePort: 18443 }), /sshPort/);
  assert.throws(() => buildFallbackFactsPs({ vmSshPort: 22 }), /servicePort/);
});

test('bootstrap.mjs：合并探测带硬超时兜底（promise 挂起不得静默 rc=0）', () => {
  const src = readFileSync(join(ROOT, 'delivery', 'bootstrap.mjs'), 'utf8');
  assert.ok(src.includes('combined-probe-timeout'), '缺合并探测超时标记');
  assert.ok(src.includes('Promise.race'), '缺 race 兜底（ssh2 挂起会静默退出）');
  assert.ok(src.includes("if (!usedCombined)"), '缺逐条兜底分支');
  // 兜底分支必须真的重新走逐条（否则「合并失败」= 无数据却继续断言）
  assert.ok(/if \(!usedCombined\) \{[\s\S]{0,400}?probe\('net session'/.test(src), '兜底分支未真正重跑逐条探测');
});

/* ═══════════════ 1b. 降级路径判据（v1.4.32 修：netsh name= 恒假红） ═══════════════ */

test('降级探测 PS：注册表直读 + CIM 兜底，绝不许回退 netsh name=', () => {
  const ps = buildFallbackFactsPs(CFG);
  // 规则 Name 是 GUID（真机取证 {e76c0ed1-…}），netsh 的 name= 匹配 Name ⇒ 恒 "No rules match"
  assert.equal(/netsh/i.test(ps), false, '降级探测又用回 netsh（判据恒定假红）');
  // 主路径=注册表（243ms），兜底=DisplayName CIM（10.6s）
  assert.ok(ps.includes('FirewallRules'), '缺注册表直读路径');
  assert.ok(ps.includes('Get-ItemProperty'), '未走 Get-ItemProperty 直读');
  assert.ok(ps.includes('Get-NetFirewallRule -DisplayName'), '缺 CIM 兜底');
  for (const key of ['$o.fwSsh', '$o.fwSvc', '$o.cfg']) assert.ok(ps.includes(key), `缺判据键 ${key}`);
  assert.equal(/[^\x00-\x7F]/.test(ps), false, 'PS 载荷含非 ASCII 字符');
  assert.equal(ps.includes('\n'), false, 'PS 载荷含换行');
  assert.ok(/ConvertTo-Json -Compress\s*$/.test(ps), '未以 ConvertTo-Json -Compress 收尾');
});

test('合并探测 PS：防火墙走注册表直读（Active/Dir/Action 三判据）而非裸存在性', () => {
  const ps = buildPrepareProbePs(CFG);
  assert.ok(ps.includes('FirewallRules'), '未走注册表直读（Get-NetFirewallRule 单发 3s+）');
  assert.equal(/Import-Module NetSecurity/.test(ps), false, '仍显式加载 NetSecurity（+5.8s，注册表路径不需要）');
  // 存在但被禁用/方向反/阻断，都不算 OK（比 Get-NetFirewallRule 的裸存在性更强）
  for (const k of ["$f['Active']", "$f['Dir']", "$f['Action']"]) assert.ok(ps.includes(k), `缺生效判据 ${k}`);
  assert.ok(ps.includes('$fwm.ContainsKey'), '存在性未按显示名键判定');
  // sshd 自启判据必须用 Get-Service 的 StartType（CIM 要 2.1s），且消费侧能吃 'Automatic'
  assert.ok(ps.includes('.StartType'), '自启判据未改用 StartType（CIM 2.1s）');
  assert.equal(/Get-CimInstance/.test(ps), false, '仍走 Get-CimInstance（+2.1s）');
  const src = readFileSync(join(ROOT, 'delivery', 'bootstrap.mjs'), 'utf8');
  assert.ok(/\/\^auto\/i\.test\(String\(J\.sshdStart/.test(src), "StartType='Automatic' 会被 /^auto$/i 判成非自启");
});

test('降级路径：firewall/登录态已合并为一发，且解析失败时判 MISSING（宁可多跑幂等 DO，不许假绿）', () => {
  const src = readFileSync(join(ROOT, 'delivery', 'bootstrap.mjs'), 'utf8');
  // 只断言**代码行**：注释里出现 netsh 是在解释「为什么换掉它」，属正常文档面。
  const code = src.split('\n').filter((l) => {
    const t = l.trim();
    return t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  }).join('\n');
  assert.ok(/runSshPs\(sshBase, buildFallbackFactsPs\(cfg\)/.test(code), '降级路径未改为单发 buildFallbackFactsPs');
  assert.equal(/netsh advfirewall firewall show rule/.test(code), false, '仍残留 netsh 判据');
  assert.ok(/J2 \? !!J2\.fwSsh : false/.test(code), '解析失败时未按 MISSING 处理（假绿风险）');
});

/* ═══════════════ 1c. 直调路径的私钥候选（v1.4.32 修） ═══════════════ */

test('resolveVmKeyPath：id_ed25519_winvm 必须排在通用 id_ed25519 之前', () => {
  const home = mkdtempSync(join(tmpdir(), 'vmkey-'));
  try {
    mkdirSync(join(home, '.ssh'), { recursive: true });
    // 只有通用钥：应返回通用钥（兼容老环境）
    writeFileSync(join(home, '.ssh', 'id_ed25519'), 'x');
    assert.equal(resolveVmKeyPath({}, home), join(home, '.ssh', 'id_ed25519'));
    // 两把都在：VM 专用钥优先（否则用 GitHub 钥去连 VM ⇒ All configured authentication methods failed）
    writeFileSync(join(home, '.ssh', 'id_ed25519_winvm'), 'x');
    assert.equal(resolveVmKeyPath({}, home), join(home, '.ssh', 'id_ed25519_winvm'));
    // env 显式指定永远最高优先级
    assert.equal(resolveVmKeyPath({ WINVM_VM_KEY: '/tmp/custom_key' }, home), '/tmp/custom_key');
    // 全缺 → ''
    rmSync(join(home, '.ssh', 'id_ed25519'));
    rmSync(join(home, '.ssh', 'id_ed25519_winvm'));
    assert.equal(resolveVmKeyPath({}, home), '');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/* ═══════════════ 1d. ssh2 连接级 error 监听顺序（v1.4.32 修：裸崩进程） ═══════════════ */

test('ssh2-client：持久 error 监听必须先于 connect 挂上（否则认证失败后 ECONNRESET 打崩进程）', () => {
  const src = readFileSync(join(ROOT, 'delivery', 'ssh2-client.mjs'), 'utf8');
  const iOn = src.indexOf("conn.on('error'");
  const iConnect = src.indexOf('conn.connect(opts)');
  assert.ok(iOn > 0, '缺持久 error 监听');
  assert.ok(iConnect > 0, '缺 conn.connect');
  assert.ok(iOn < iConnect, 'error 监听挂在 connect 之后（连接失败时 await 抛异常 ⇒ 该行永不执行 ⇒ 后续 socket 错误无监听 ⇒ 裸崩）');
});

/* ═══════════════ 2/3. 技能侧断言在别的门禁里 ═══════════════
 *
 * `deploy-1p-autokey.sh`（口令自动建通道）、`vm-conn.sh` 的 askpass 调用形态、
 * `ssh2-conn.mjs` 的纯口令分支 —— 这三者都在**部署技能仓**里，本仓的 skills/ 目录
 * 不挂它（避免内容双份漂移），因此不在这里做源级断言。
 * 权威门禁 = 技能仓 `bash scripts/selfcheck.sh --mutate` 的
 *   c_password_bootstrap（正断言）+ M26（把 1p 删成注释 → 必被抓）。
 */

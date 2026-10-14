/**
 * Phase 3 · 批6 A2-9：config-key-lint 的 enforceBearer 硬前置（守卫层，非运行期）。
 *
 * 病灶（audit §3.2 A2-9 / B-1' / R4 B3 实测）：`enforceBearer` 是双条件开关
 * （`=== true` ∧ `env[tokenEnv]` 非空）。运行期 validateServiceConfig 只报 warning，
 * 且「配置文件里开了 enforceBearer 却根本没配 tokenEnv」这种**结构上第二条件永假**的
 * 自相矛盾，只有静态门禁层能在部署前钉住 ⇒ 本判据进 config-key-lint（HARD 计入 findings）。
 *
 * 纪律：
 *  - 对 scripts/ 走 import()（非被测包，零 @winvm 依赖，同 phase2-dep-direction 口径）；
 *  - 判别性双向：注入矛盾必红（非恒绿）+ 现网两配置资产必绿（不误伤）；
 *  - 严禁出现 "snapshot" 字样（循 phase2 纪律）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { realpathSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..'));
const LINT = pathToFileURL(join(ROOT, 'scripts', 'config-key-lint.mjs')).href;

const mod = await import(LINT);

describe('A2-9 · checkBearerPrecondition 纯函数判别面', () => {
  test('① enforceBearer:true ∧ 无 tokenEnv ⇒ HARD MISSING_TOKEN_ENV（双条件缺第二条=假开关）', () => {
    const f = mod.checkBearerPrecondition({ security: { enforceBearer: true } });
    assert.equal(f.length, 1);
    assert.equal(f[0].rule, 'ENFORCE_BEARER_MISSING_TOKEN_ENV');
    assert.equal(f[0].section, 'security');
    assert.equal(f[0].key, 'enforceBearer');
    assert.ok(typeof f[0].message === 'string' && f[0].message.length > 0, 'HARD 必须带人读诊断');
  });

  test('② tokenEnv 空白字符串同判（trim 后为空 = 有名无体）', () => {
    const f = mod.checkBearerPrecondition({ security: { enforceBearer: true, tokenEnv: '   ' } });
    assert.equal(f.length, 1);
    assert.equal(f[0].rule, 'ENFORCE_BEARER_MISSING_TOKEN_ENV');
  });

  test('③ enforceBearer:"true"（字符串）⇒ HARD NOT_BOOLEAN 且不叠加缺 tokenEnv 噪音', () => {
    const f = mod.checkBearerPrecondition({ security: { enforceBearer: 'true' } });
    assert.equal(f.length, 1, `类型已坏应只报一条，实际 ${JSON.stringify(f)}`);
    assert.equal(f[0].rule, 'ENFORCE_BEARER_NOT_BOOLEAN');
  });

  test('④ 双条件齐（true + 非空 tokenEnv）⇒ 放行（值是否真在 env 属运行期面，非本判据）', () => {
    assert.equal(mod.checkBearerPrecondition({ security: { enforceBearer: true, tokenEnv: 'WINVM_BEARER_TOKEN' } }).length, 0);
  });

  test('⑤ 关闭态/缺省态/无 security 段/非对象 ⇒ 全放行（现网默认零误伤）', () => {
    assert.equal(mod.checkBearerPrecondition({ security: { enforceBearer: false } }).length, 0);
    assert.equal(mod.checkBearerPrecondition({ security: {} }).length, 0);
    assert.equal(mod.checkBearerPrecondition({}).length, 0);
    assert.equal(mod.checkBearerPrecondition(null).length, 0);
    assert.equal(mod.checkBearerPrecondition({ security: null }).length, 0);
  });
});

describe('A2-9 · lintConfigKeys 集成面（HARD 进 findings ⇒ code=1；现网零误伤）', () => {
  test('现网两配置资产 ⇒ 仍 code=0（enforceBearer:false，本判据不触发；判别性见下条）', () => {
    const res = mod.lintConfigKeys(ROOT, ['delivery/vm-service.config.json', 'delivery/.generated/vm-service.runtime.json']);
    assert.equal(res.code, 0, `现网应零命中，实际 ${JSON.stringify(res.findings)}`);
  });

  test('注入矛盾配置 ⇒ lintConfigKeys code=1 且 findings 带 rule（非恒绿钉）', () => {
    // 临时文件必须落在项目根下：lintConfigKeys 内部 buildWhitelist(root) 需真实 TS 源，
    // 若拿 tmpdir 当 root 会因「源码缺 interface」短路返回 code=2（bearer 判据根本不跑）。
    const rel = '.a29-bearer-tmp.json';
    const abs = join(ROOT, rel);
    try {
      writeFileSync(abs, JSON.stringify({ security: { enforceBearer: true }, server: { host: '127.0.0.1' } }), 'utf8');
      const res = mod.lintConfigKeys(ROOT, [rel]);
      assert.equal(res.code, 1);
      const hit = res.findings.find((/** @type {any} */ f) => f.rule === 'ENFORCE_BEARER_MISSING_TOKEN_ENV');
      assert.ok(hit, `注入必命中，实际 ${JSON.stringify(res.findings)}`);
      assert.equal(hit.file, rel);
      // 人读输出也带规则名（运维可 grep）
      const text = mod.formatConfigKeyReport(res, ROOT);
      assert.match(text, /ENFORCE_BEARER_MISSING_TOKEN_ENV/);
      assert.match(text, /VERDICT: RED/);
    } finally {
      rmSync(abs, { force: true });
    }
  });

  test('gate 消费面兼容：findings 项无 rule 字段时仍按 UNKNOWN_CONFIG_KEY 文案（老形状不破坏）', () => {
    const wl = mod.buildWhitelist(ROOT);
    const found = mod.findUnknownKeys({ policy: { bogusKey: 1 } }, wl);
    assert.ok(found.length >= 1);
    for (const f of found) assert.equal(f.rule, undefined, 'UNKNOWN_CONFIG_KEY 族不得带 rule 字段');
  });
});

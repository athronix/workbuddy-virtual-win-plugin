/**
 * Phase 2 · P2-T1 单元测试：capability schema 交付面校验 + 漂移守卫
 *
 * 背景（phase2-arch-design §1，Q1 裁决 = (b)）：
 *   `contracts/schemas/capability.schema.json` 曾零消费者且与 TS 事实源漂移
 *   （`appops` 缺 `domain.enum` / `id.pattern`）。本文件把 schema 变成**被消费的资产**：
 *   注册表 54 条能力定义逐条过 `validateCapabilityShape`，并守卫 schema↔`CAPABILITY_DOMAINS`
 *   集合一致 —— 未来新增域若漏改 schema，此处必红。
 *   ⚠ 消费点=测试面（裁决 Q1=(b)）：运行期（vm-service 启动/能力注册）**不**接本校验。
 *
 * 运行：node --test tests/unit/phase2-contract-schema.test.js
 * ⚠ 依赖已重建 dist（`tsc -b tsconfig.build.json`）：旧 dist 不含 schema-check ⇒ import 即失败。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  validateCapabilityShape,
  checkSchemaDomainDrift,
  domainPrefixesFromPattern,
  CAPABILITY_DOMAINS,
} from '@winvm/contracts';
import { WINDOWS_CAPABILITIES } from '@winvm/vm-capabilities';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const SCHEMA_PATH = resolve(ROOT, 'packages/contracts/schemas/capability.schema.json');

/** schema JSON 是判据唯一来源 —— 每次现读文件，不用任何缓存/内嵌副本 */
const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));

/* ============================================================================
 * 1. 全量注册表 0 violations（离线取全部 54 条形状数据 = 代码内常量 WINDOWS_CAPABILITIES）
 * ========================================================================== */

describe('P2-T1 · 注册表全量形状校验（交付面消费）', () => {
  test('注册表恰 54 条（防"少校验"：条数变了须显形）', () => {
    assert.equal(WINDOWS_CAPABILITIES.length, 54, `期望 54 条，实得 ${WINDOWS_CAPABILITIES.length}`);
  });

  test('54 条逐条 validateCapabilityShape ⇒ 0 violations', () => {
    const result = validateCapabilityShape(WINDOWS_CAPABILITIES, schema);
    assert.deepEqual(
      result.violations,
      [],
      `存在违规：\n${result.violations.map((v) => `  ${v.id} @ ${v.path}: ${v.message}`).join('\n')}`,
    );
    assert.equal(result.ok, true);
  });

  test('逐条单跑亦 0 violations（独立定位：某条红时报出该条 id）', () => {
    const bad = [];
    for (const def of WINDOWS_CAPABILITIES) {
      const r = validateCapabilityShape(def, schema);
      if (!r.ok) bad.push(`${def.id}: ${r.violations.map((v) => `${v.path}(${v.message})`).join('; ')}`);
    }
    assert.deepEqual(bad, []);
  });
});

/* ============================================================================
 * 2. 漂移守卫：schema.domain.enum / id.pattern 首段 ⇔ CAPABILITY_DOMAINS（TS 事实源）
 * ========================================================================== */

describe('P2-T1 · schema ↔ TS 联合类型漂移守卫', () => {
  test('checkSchemaDomainDrift ⇒ 无漂移（domain.enum 与 id.pattern 首段集合 = CAPABILITY_DOMAINS）', () => {
    const problems = checkSchemaDomainDrift(schema);
    assert.deepEqual(
      problems,
      [],
      `schema 与 TS 事实源漂移（新增域须同批改 schema）：\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    );
  });

  test('TS 事实源含 appops（本任务修复的漂移起点，钉死不放回）', () => {
    assert.ok(CAPABILITY_DOMAINS.includes('appops'), 'CAPABILITY_DOMAINS 应含 appops');
    assert.deepEqual([...CAPABILITY_DOMAINS].sort(), ['app', 'appops', 'gui', 'meta', 'storage', 'system']);
  });

  test('注册表实际 domain 取值集合 ⊆ CAPABILITY_DOMAINS，且 appops 域真实在场', () => {
    const actual = [...new Set(WINDOWS_CAPABILITIES.map((c) => c.domain))].sort();
    for (const d of actual) {
      assert.ok(CAPABILITY_DOMAINS.includes(d), `注册表 domain "${d}" 不在 CAPABILITY_DOMAINS`);
    }
    assert.ok(actual.includes('appops'), 'appops 域应有能力在册（5 条 appops.*）');
  });

  test('漂移反例注入：enum 缺 appops ⇒ 守卫红（证明本守卫真的会拦）', () => {
    const mutated = structuredClone(schema);
    mutated.properties.domain.enum = mutated.properties.domain.enum.filter((x) => x !== 'appops');
    const problems = checkSchemaDomainDrift(mutated);
    assert.ok(problems.some((p) => p.includes('domain.enum')), `注入漂移未被发现：${problems.join(';')}`);
  });

  test('漂移反例注入：id.pattern 首段缺 appops ⇒ 守卫红', () => {
    const mutated = structuredClone(schema);
    mutated.properties.id.pattern = '^(system|app|storage|gui|meta)\\.[a-z0-9]+\\.[a-z0-9]+$';
    const problems = checkSchemaDomainDrift(mutated);
    assert.ok(problems.some((p) => p.includes('id.pattern')), `注入漂移未被发现：${problems.join(';')}`);
    // 且 appops 能力此时会被形状校验拒绝（修复前现状复现）
    const appopsCap = WINDOWS_CAPABILITIES.find((c) => c.domain === 'appops');
    const r = validateCapabilityShape(appopsCap, mutated);
    assert.ok(r.violations.some((v) => v.path === '$.id'), '旧 pattern 下 appops 能力应报 $.id 违规');
  });

  test('domainPrefixesFromPattern 单元行为', () => {
    assert.deepEqual(
      domainPrefixesFromPattern('^(system|app|storage|gui|appops|meta)\\.[a-z0-9]+\\.[a-z0-9]+$'),
      ['system', 'app', 'storage', 'gui', 'appops', 'meta'],
    );
    assert.equal(domainPrefixesFromPattern(undefined), undefined);
    assert.equal(domainPrefixesFromPattern('^[a-z]+$'), undefined);
  });
});

/* ============================================================================
 * 3. 校验器自身的判据覆盖（必填/枚举/pattern/范围/键集/条件约束/输入卫生）
 * ========================================================================== */

describe('P2-T1 · validateCapabilityShape 判据自证', () => {
  const MINIMAL = {
    id: 'system.demo.thing',
    domain: 'system',
    name: '演示',
    description: '演示能力',
    risk: 'L0',
    idempotent: true,
    requiresSession: false,
    destructive: false,
    timeoutMs: 30000,
    input: {},
    output: {},
    audit: { snapshot: 'none' },
    implementation: { kind: 'powershell', module: 'system', function: 'Get-Demo' },
  };
  const pathsOf = (r) => r.violations.map((v) => v.path);

  test('合法最小样本 ⇒ ok', () => {
    const r = validateCapabilityShape(MINIMAL, schema);
    assert.deepEqual(r.violations, []);
    assert.equal(r.ok, true);
  });

  test('缺必填键 ⇒ 定位到该键', () => {
    const { name: _drop, audit: _drop2, ...rest } = MINIMAL;
    const r = validateCapabilityShape(rest, schema);
    assert.ok(r.violations.some((v) => v.path === '$.name'), pathsOf(r).join(','));
    assert.ok(r.violations.some((v) => v.path === '$.audit'), pathsOf(r).join(','));
  });

  test('additionalProperties=false：未声明键被拒', () => {
    const r = validateCapabilityShape({ ...MINIMAL, commandAllowlist: ['x'] }, schema);
    assert.ok(r.violations.some((v) => v.path === '$.commandAllowlist'), pathsOf(r).join(','));
  });

  test('policy.additionalProperties=false：旧 commandAllowlist 直接拒绝（SECURITY §3.2 第 3 条承诺的可执行兑现）', () => {
    const r = validateCapabilityShape({ ...MINIMAL, policy: { commandAllowlist: ['^.*$'] } }, schema);
    assert.ok(r.violations.some((v) => v.path === '$.policy.commandAllowlist'), pathsOf(r).join(','));
  });

  test('risk 枚举 / domain 枚举 / implementation.kind 枚举', () => {
    const r = validateCapabilityShape(
      { ...MINIMAL, risk: 'L9', domain: 'nope', implementation: { ...MINIMAL.implementation, kind: 'magic' } },
      schema,
    );
    assert.ok(r.violations.some((v) => v.path === '$.risk'), pathsOf(r).join(','));
    assert.ok(r.violations.some((v) => v.path === '$.domain'), pathsOf(r).join(','));
    assert.ok(r.violations.some((v) => v.path === '$.implementation.kind'), pathsOf(r).join(','));
  });

  test('id pattern：非三段式/未知首段被拒', () => {
    for (const id of ['system.demo', 'demo.thing.x', 'System.demo.thing', 'system.demo.thing.extra']) {
      const r = validateCapabilityShape({ ...MINIMAL, id }, schema);
      assert.ok(r.violations.some((v) => v.path === '$.id'), `应拒 ${id}`);
    }
    const ok = validateCapabilityShape({ ...MINIMAL, id: 'appops.demo.thing' }, schema);
    assert.equal(ok.ok, true, 'appops 首段修复后应放行');
  });

  test('timeoutMs 范围 [1000,600000] 与 integer 性', () => {
    assert.ok(validateCapabilityShape({ ...MINIMAL, timeoutMs: 999 }, schema).violations.some((v) => v.path === '$.timeoutMs'));
    assert.ok(validateCapabilityShape({ ...MINIMAL, timeoutMs: 600001 }, schema).violations.some((v) => v.path === '$.timeoutMs'));
    assert.ok(validateCapabilityShape({ ...MINIMAL, timeoutMs: 1.5 }, schema).violations.some((v) => v.path === '$.timeoutMs'));
  });

  test('minLength：name/description 空串被拒', () => {
    const r = validateCapabilityShape({ ...MINIMAL, name: '', description: '' }, schema);
    assert.ok(r.violations.some((v) => v.path === '$.name'), pathsOf(r).join(','));
    assert.ok(r.violations.some((v) => v.path === '$.description'), pathsOf(r).join(','));
  });

  test('L2/L3 ⇒ snapshot≠none 条件约束（schema allOf 语义）', () => {
    const r = validateCapabilityShape({ ...MINIMAL, risk: 'L2', audit: { snapshot: 'none' } }, schema);
    assert.ok(r.violations.some((v) => v.path === '$.audit.snapshot'), pathsOf(r).join(','));
    const r3 = validateCapabilityShape({ ...MINIMAL, risk: 'L3', audit: { snapshot: 'before-after' } }, schema);
    assert.equal(r3.ok, true);
  });

  test('allOf 条件约束若从 schema 被静默删除 ⇒ 校验器显式报违规（约束在场性守卫）', () => {
    const mutated = structuredClone(schema);
    delete mutated.allOf;
    const r = validateCapabilityShape(MINIMAL, mutated);
    assert.ok(r.violations.some((v) => v.path === '$.allOf'), '删除 allOf 应被戳穿而非静默放行');
  });

  test('输入卫生：非对象/数组含非对象项/schema 非法 ⇒ 报违规不抛异常', () => {
    assert.equal(validateCapabilityShape('nope', schema).ok, false);
    assert.equal(validateCapabilityShape([{ ...MINIMAL }, null], schema).ok, false);
    assert.equal(validateCapabilityShape(MINIMAL, {}).ok, false);
    assert.equal(validateCapabilityShape(MINIMAL, undefined).ok, false);
  });

  test('实现绑定枚举专项：implementation.required=[kind,module,function]', () => {
    const r = validateCapabilityShape(
      { ...MINIMAL, implementation: { module: 'system' } },
      schema,
    );
    assert.ok(r.violations.some((v) => v.path === '$.implementation.kind'), 'kind 必填缺失应报');
    assert.ok(r.violations.some((v) => v.path === '$.implementation.function'), 'function 必填缺失应报');
  });

  test('audit 对象键集：snapshot 之外不得有键（additionalProperties=false 嵌套生效）', () => {
    const r = validateCapabilityShape({ ...MINIMAL, audit: { snapshot: 'none', beforeAfter: {} } }, schema);
    assert.ok(r.violations.some((v) => v.path === '$.audit.beforeAfter'), '未声明 audit 键应被拒');
  });
});

/* ============================================================================
 * 4. 消费点纪律（Q1=(b)）：运行期零接入的静态守卫
 * ========================================================================== */

describe('P2-T1 · 运行期零接入纪律（裁决 Q1=(b)）', () => {
  test('vm-capabilities / vm-service 源码不 import schema-check（校验只活在测试/门禁面）', () => {
    const files = [
      'packages/vm-capabilities/src/index.ts',
      'packages/vm-capabilities/src/registry/definitions.ts',
      'packages/vm-service/src/server.ts',
      'packages/vm-service/src/index.ts',
    ];
    for (const rel of files) {
      const text = readFileSync(resolve(ROOT, rel), 'utf8');
      assert.ok(
        !text.includes('schema-check') && !text.includes('validateCapabilityShape'),
        `${rel} 不应引用 schema-check（运行期不接 ⇒ 违例即裁决口径被破坏）`,
      );
    }
  });
});

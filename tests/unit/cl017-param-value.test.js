/**
 * CL-017 D26 · 入参契约校验须覆盖**值层面**（type / enum）
 *
 * 背景：D24 只校验「键合法 / 必填在位」，**不校验值**。类型不符（`top:"abc"`）与枚举越界
 * （`action:"bogus"`）被原样下发到 PowerShell，由其参数绑定抛**英文异常**（无 `UPPER_SNAKE:` 前缀）
 * → 被压成 `EXECUTION_FAILED`，调用方无法据此路由。
 *
 * 现语义（D26，裁决 B —— 对齐 **PS 绑定语义**，而非严格 JSON Schema）：
 *   - `enum`：字符串成员**忽略大小写**匹配（PS `ValidateSet` 默认忽略大小写），真正的越界值
 *     （如 `'bogus'`）**仍被拒绝**；
 *   - `type`：按 **PS 可强转性** 判定 —— `integer`/`number` 收 JS 数字或整体数字形态字符串；
 *     `boolean` 收布尔或 `'true'/'false'`；`string` 收字符串/数字/布尔；
 *     `array` 收数组**或 string/number/boolean 标量**（PS 形参如 `[string[]]` 会做标量提升）；
 *     `object` 收非 null 非数组对象；无 `type` 声明 → 跳过；值为 `null` → 跳过。
 *
 * 依据（团队裁决，2026-09-17）：本校验目的为「**预判 PS 绑定会不会失败**」，不是严格 JSON Schema
 * 校验；**我们自己引入的新失败模式（误拒）比漏放更糟**。故与 PS 同宽。
 *
 * 命中即 `INVALID_PARAMS` + `reason='INVALID_ARGUMENT'` + `details.invalid:[{key,expected,got}]`，
 * **不产生任何桥往返**（严格判据必须由主修复命中，而非走到 PS 兜底分支）。
 *
 * 本测试经**公开路径** `execute()` 验证，且以**表驱动**覆盖 严格判据 / 宽松对照 两侧。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { DeterministicAgentProvider } from '@winvm/adapter-agent-workbuddy';

/** 构造 JSON Schema 对象体（对齐注册表 `obj()` 造型） */
function obj(props, required = []) {
  return { type: 'object', properties: props, ...(required.length ? { required } : {}) };
}

function capDef(id, input, module, fn) {
  return { id, input, implementation: { module, function: fn }, output: {} };
}

/** 与真实注册表一致的切片（覆盖 integer/number/boolean/string/array/object + enum + 无 type） */
function defsMap() {
  const m = new Map();
  m.set(
    'system.process.list',
    capDef('system.process.list', obj({ name: { type: 'string' }, top: { type: 'integer' } }), 'system', 'Get-ProcessList'),
  );
  m.set(
    'system.service.control',
    capDef(
      'system.service.control',
      obj({ name: { type: 'string' }, action: { type: 'string', enum: ['start', 'stop', 'restart'] } }, ['name', 'action']),
      'system',
      'Invoke-ServiceControl',
    ),
  );
  m.set(
    'system.env.manage',
    capDef('system.env.manage', obj({ name: { type: 'string' }, target: { type: 'string', enum: ['User', 'Machine'] } }), 'system', 'Get-EnvironmentVariableInfo'),
  );
  m.set(
    'storage.file.write',
    capDef('storage.file.write', obj({ path: { type: 'string' }, content: {}, append: { type: 'boolean' } }, ['path', 'content']), 'storage', 'Write-TextFileContent'),
  );
  m.set('gui.screen.analyze', capDef('gui.screen.analyze', obj({ threshold: { type: 'number' } }), 'gui', 'Test-ScreenBlack'));
  m.set(
    'gui.input.keyboard',
    capDef('gui.input.keyboard', obj({ text: { type: 'string' }, keys: { type: 'array', items: { type: 'string' } } }), 'gui', 'Send-KeyboardInput'),
  );
  // 合成：仅用于覆盖 `object` 类型关键字（真实注册表暂无 object 型入参）
  m.set('__test.object', capDef('__test.object', obj({ payload: { type: 'object' } }), '__meta', 'noop'));
  return m;
}

/**
 * 构造注入式 provider：记录 bridge.call 调用；用于断言「值校验失败时不发起桥调用」。
 */
async function makeProvider(opts = {}) {
  const calls = [];
  const bridge = {
    running: true,
    uptimeMs: 1,
    async start() {},
    async stop() {},
    async call(module, fn, params) {
      calls.push({ module, fn, params });
      return { fromBridge: true, module, fn };
    },
    health() {
      return { state: 'ready', uptimeMs: 1, pending: 0, lastHeartbeatAgoMs: 0 };
    },
  };
  const defs = opts.defs ?? defsMap();
  const ctx = {
    config: {},
    audit: {
      append: async () => ({ hash: 'h', prevHash: '', seq: 0, auditId: 'aud_x' }),
      verifyChain: async () => ({ valid: true, entries: 0 }),
    },
    policy: { evaluate: () => ({ allowed: true, matchedRule: 'test' }) },
    capabilities: {
      get: () => ({ risk: 'L0', requiresSession: false }),
      list: () => [...defs.keys()],
      has: () => true,
    },
    capabilityDefs: defs,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    bridge,
    newTraceId: () => 'tr_test',
  };
  const p = new DeterministicAgentProvider({});
  await p.init(ctx);
  return { p, calls };
}

async function run(p, capabilityId, params) {
  return p.execute({ traceId: 'tr_test', capabilityId, params, risk: 'L0', approved: false, timeoutMs: 1000 });
}

describe('CL-017 D26 · 值层面契约校验（type / enum → INVALID_PARAMS + reason=INVALID_ARGUMENT + details.invalid）', () => {
  // ---- 严格判据（表驱动）：值非法 → 被主修复拦截 ----
  const strictCases = [
    ['integer 收到非数字形态字符串', 'system.process.list', { top: 'abc' }, 'top', 'integer', 'string'],
    ['integer 收到半数字字符串', 'system.process.list', { top: '20x' }, 'top', 'integer', 'string'],
    ['integer 收到布尔', 'system.process.list', { top: true }, 'top', 'integer', 'boolean'],
    ['number 收到非数字字符串', 'gui.screen.analyze', { threshold: 'high' }, 'threshold', 'number', 'string'],
    ['enum 越界', 'system.service.control', { name: '__nope__', action: 'bogus' }, 'action', 'enum("start"|"stop"|"restart")', 'string'],
    ['enum 折叠大小写后仍越界（root 不在 User|Machine 内）', 'system.env.manage', { target: 'root' }, 'target', 'enum("User"|"Machine")', 'string'],
    ['boolean 收到非法字符串', 'storage.file.write', { path: 'C:\\x', content: 'x', append: 'yes' }, 'append', 'boolean', 'string'],
    ['array 收到对象（不可提升）', 'gui.input.keyboard', { keys: { k: 1 } }, 'keys', 'array', 'object'],
    ['object 收到数组', '__test.object', { payload: [1, 2] }, 'payload', 'object', 'array'],
  ];

  for (const [name, capId, params, key, expected, got] of strictCases) {
    test(`严格判据 · ${name}`, async () => {
      const { p, calls } = await makeProvider();
      const res = await run(p, capId, params);
      assert.equal(res.ok, false, '值非法不应放行');
      assert.equal(res.error.code, 'INVALID_PARAMS');
      assert.equal(res.error.reason, 'INVALID_ARGUMENT');
      // 关键：严格判据必须命中**主修复**（details.invalid 非空），而非走到 PS 兜底
      assert.ok(Array.isArray(res.error.details.invalid), 'details.invalid 必须是数组');
      assert.deepEqual(res.error.details.invalid, [{ key, expected, got }]);
      assert.equal(calls.length, 0, '值校验失败不得发起桥调用（证明命中主修复而非兜底）');
    });
  }

  // ---- 宽松对照（表驱动）：PS 可强转 / 无 type 声明 / 裁决 B → 必须放行 ----
  const lenientCases = [
    ['integer 收数字形态字符串', 'system.process.list', { top: '20' }],
    ['integer 收 JS 数字', 'system.process.list', { top: 20 }],
    ['integer 收带符号/空白的数字串', 'system.process.list', { top: ' -3 ' }],
    ['integer 收浮点数字串', 'system.process.list', { top: '2.5' }],
    ['number 收数字', 'gui.screen.analyze', { threshold: 0.75 }],
    ['boolean 收 "true"', 'storage.file.write', { path: 'C:\\x', content: 'x', append: 'true' }],
    ['boolean 收布尔', 'storage.file.write', { path: 'C:\\x', content: 'x', append: true }],
    ['string 收数字（PS 可 [string] 强转）', 'system.service.control', { name: 123, action: 'start' }],
    ['array 收数组', 'gui.input.keyboard', { keys: ['a', 'b'] }],
    ['array 收标量字符串（PS 标量→数组提升）', 'gui.input.keyboard', { keys: 'enter' }],
    ['array 收数字标量（PS 标量→数组提升）', 'gui.input.keyboard', { keys: 1 }],
    ['object 收普通对象', '__test.object', { payload: { a: 1 } }],
    ['无 type 声明的字段收数字', 'storage.file.write', { path: 'C:\\x', content: 123 }],
    ['无 type 声明的字段收对象', 'storage.file.write', { path: 'C:\\x', content: { a: 1 } }],
    ['值为 null 的键跳过值校验（非必填）', 'system.process.list', { top: null }],
    ['enum 命中合法值', 'system.service.control', { name: 'Spooler', action: 'start' }],
    // 裁决 B：PS ValidateSet 默认忽略大小写 → 大小写变体是 PS 本可接受的形态，必须放行
    ['enum 大小写变体（START，PS 忽略大小写）', 'system.service.control', { name: '__nope__', action: 'START' }],
    ['enum 大小写变体（macHINE，PS 忽略大小写）', 'system.env.manage', { target: 'macHINE' }],
  ];

  for (const [name, capId, params] of lenientCases) {
    test(`宽松对照 · ${name}`, async () => {
      const { p, calls } = await makeProvider();
      const res = await run(p, capId, params);
      assert.equal(res.ok, true, `合法参数不应被误拒：${name}`);
      assert.equal(calls.length, 1, '合法参数应正常打到桥');
    });
  }

  test('details 恒含四字段（unknown / missing / allowed / invalid）', async () => {
    const { p } = await makeProvider();
    const res = await run(p, 'system.process.list', { top: 'abc' });
    assert.deepEqual(Object.keys(res.error.details).sort(), ['allowed', 'invalid', 'missing', 'unknown']);
    assert.deepEqual(res.error.details.unknown, []);
    assert.deepEqual(res.error.details.missing, []);
    assert.deepEqual(res.error.details.allowed, ['name', 'top']);
  });

  test('主修复与 D24 叠加：未知参数 + 值非法同时命中', async () => {
    const { p, calls } = await makeProvider();
    const res = await run(p, 'system.process.list', { bogus: 1, top: 'abc' });
    assert.equal(res.error.code, 'INVALID_PARAMS');
    assert.deepEqual(res.error.details.unknown, ['bogus']);
    assert.deepEqual(res.error.details.invalid, [{ key: 'top', expected: 'integer', got: 'string' }]);
    assert.equal(calls.length, 0);
  });

  test('消息文案含「参数取值非法」与期望/实为', async () => {
    const { p } = await makeProvider();
    const res = await run(p, 'system.process.list', { top: 'abc' });
    assert.match(res.error.message, /参数取值非法 top\(期望 integer，实为 string\)/);
  });

  test('未声明的键不在值校验范围内（只报 unknown，不误报 invalid）', async () => {
    const { p } = await makeProvider();
    const res = await run(p, 'system.process.list', { action: 'bogus' });
    assert.deepEqual(res.error.details.unknown, ['action']);
    assert.deepEqual(res.error.details.invalid, []);
  });

  // ---- 裁决 B 的显式回归（对齐 A18 真机探针，避免「B 的实现 + A 的断言」拼接） ----
  test('裁决 B · enum 大小写变体必须放行至业务层（对齐 A18 探针 action:"START"）', async () => {
    const { p, calls } = await makeProvider();
    const res = await run(p, 'system.service.control', { name: '__nope__', action: 'START' });
    assert.notEqual(res.error?.code, 'INVALID_PARAMS', 'PS ValidateSet 忽略大小写，"START" 不得被判 INVALID_PARAMS');
    assert.equal(res.ok, true, '校验须放行，请求须抵达业务层');
    assert.equal(calls.length, 1, '必须发起桥调用（证明是放行而非兜底）');
  });

  test('裁决 B · array 标量提升必须放行（对齐 [string[]]$Keys 标量输入）', async () => {
    const { p, calls } = await makeProvider();
    const res = await run(p, 'gui.input.keyboard', { keys: 'enter' });
    assert.notEqual(res.error?.code, 'INVALID_PARAMS', 'PS 会把标量提升为 [string[]]，不得误拒');
    assert.equal(res.ok, true);
    assert.equal(calls.length, 1);
  });

  test('裁决 B 反向保险 · 折叠大小写后仍越界的 enum 必须拒绝（"bogus" 不得被宽松放过）', async () => {
    const { p, calls } = await makeProvider();
    const res = await run(p, 'system.service.control', { name: '__nope__', action: 'bogus' });
    assert.equal(res.error.code, 'INVALID_PARAMS');
    assert.equal(res.error.reason, 'INVALID_ARGUMENT');
    assert.deepEqual(res.error.details.invalid, [{ key: 'action', expected: 'enum("start"|"stop"|"restart")', got: 'string' }]);
    assert.equal(calls.length, 0, '不得放行真正的越界值');
  });
});

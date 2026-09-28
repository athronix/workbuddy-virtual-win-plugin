/**
 * CL-017 D24 · 入参契约错误必须可路由（Node 侧前置校验）
 *
 * 背景：最常见的 Agent 失误不是「路径不存在」而是「参数名/必填项写错」。
 * 旧实现把错误参数原样丢给 PowerShell → 由其参数绑定抛**英文异常**且无领域码
 * → 被压成 `EXECUTION_FAILED`，Agent 无法区分「该改参数」还是「该重试」。
 *
 * 现语义：`execute()` 在**发起桥调用之前**，用注册表 `inputSchema` 做契约校验，
 * 命中即直接返回 `INVALID_PARAMS` + `reason='INVALID_ARGUMENT'`
 * （`details` 带 `unknown` / `missing` / `allowed`），**不产生任何桥往返**。
 *
 * 本测试经**公开路径** `execute()` 验证，不依赖私有方法名。
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

/** 与真实注册表一致的切片（含 required / 空 schema / 无 properties 三种形态） */
function defsMap() {
  const m = new Map();
  m.set(
    'storage.file.read',
    capDef(
      'storage.file.read',
      obj({ path: { type: 'string' }, maxBytes: { type: 'integer' }, asBase64: { type: 'boolean' } }, ['path']),
      'storage',
      'Read-TextFileContent',
    ),
  );
  m.set(
    'storage.dir.manage',
    capDef('storage.dir.manage', obj({ path: { type: 'string' } }, ['path']), 'storage', 'New-DirectoryItem'),
  );
  m.set(
    'gui.window.control',
    capDef(
      'gui.window.control',
      obj({ title: { type: 'string' }, state: { type: 'string' } }, ['title']),
      'gui',
      'Set-WindowState',
    ),
  );
  m.set('meta.health.check', capDef('meta.health.check', obj({}), '__meta', 'healthCheck'));
  // 无 `properties` 的 schema → 应跳过校验（保持既有行为）
  m.set('system.info.get', capDef('system.info.get', {}, 'system', 'Get-SystemInfo'));
  return m;
}

/**
 * 构造注入式 provider：记录 bridge.call 调用；用于断言「失败时不发起桥调用」。
 * @param {object} [opts]
 * @param {unknown}  [opts.throwOnCall] 若非空则 bridge.call 抛此错误（验证兜底分支）
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
      if (opts.throwOnCall !== undefined) throw opts.throwOnCall;
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
  const p = new DeterministicAgentProvider(opts.providerOptions ?? {});
  await p.init(ctx);
  return { p, calls };
}

async function run(p, capabilityId, params) {
  return p.execute({
    traceId: 'tr_test',
    capabilityId,
    params,
    risk: 'L0',
    approved: false,
    timeoutMs: 1000,
  });
}

describe('CL-017 D24 · 入参契约前置校验（INVALID_PARAMS + reason=INVALID_ARGUMENT）', () => {
  test('缺少必填参数 → INVALID_PARAMS + reason + details.missing（且不发起桥调用）', async () => {
    const { p, calls } = await makeProvider();
    const res = await run(p, 'storage.file.read', {});
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'INVALID_PARAMS');
    assert.equal(res.error.reason, 'INVALID_ARGUMENT');
    assert.deepEqual(res.error.details.missing, ['path']);
    assert.deepEqual(res.error.details.unknown, []);
    assert.deepEqual(res.error.details.allowed, ['path', 'maxBytes', 'asBase64']);
    assert.equal(calls.length, 0, '校验失败不得发起桥调用');
  });

  test('未知参数（参数名写错）→ INVALID_PARAMS + details.unknown', async () => {
    const { p, calls } = await makeProvider();
    const res = await run(p, 'storage.dir.manage', { path: 'C:\\Users\\User', action: 'list' });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'INVALID_PARAMS');
    assert.equal(res.error.reason, 'INVALID_ARGUMENT');
    assert.deepEqual(res.error.details.unknown, ['action']);
    assert.deepEqual(res.error.details.missing, []);
    assert.deepEqual(res.error.details.allowed, ['path']);
    assert.equal(calls.length, 0);
  });

  test('未知参数 + 缺少必填（同时命中）→ details 两数组均非空', async () => {
    const { p, calls } = await makeProvider();
    const res = await run(p, 'gui.window.control', { windowTitle: '__zz__', action: 'activate' });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'INVALID_PARAMS');
    assert.equal(res.error.reason, 'INVALID_ARGUMENT');
    assert.deepEqual(res.error.details.unknown, ['windowTitle', 'action']);
    assert.deepEqual(res.error.details.missing, ['title']);
    assert.deepEqual(res.error.details.allowed, ['title', 'state']);
    assert.equal(calls.length, 0);
  });

  test('消息文案含「不支持的参数 / 缺少必填参数 / 该能力可用参数」', async () => {
    const { p } = await makeProvider();
    const res = await run(p, 'gui.window.control', { windowTitle: '__zz__', action: 'activate' });
    assert.match(res.error.message, /不支持的参数 windowTitle, action/);
    assert.match(res.error.message, /缺少必填参数 title/);
    assert.match(res.error.message, /该能力可用参数：title, state/);
  });

  test('必填项为 null / undefined → 视为缺失', async () => {
    const { p, calls } = await makeProvider();
    for (const v of [null, undefined]) {
      const res = await run(p, 'storage.file.read', { path: v });
      assert.equal(res.error.code, 'INVALID_PARAMS', `path=${String(v)}`);
      assert.deepEqual(res.error.details.missing, ['path']);
    }
    assert.equal(calls.length, 0);
  });

  test('合法参数不被阻断（正常打到桥）', async () => {
    const { p, calls } = await makeProvider();
    const res = await run(p, 'storage.file.read', { path: 'C:\\WinVMWorkspace\\x.txt', maxBytes: 16 });
    assert.equal(res.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].module, 'storage');
    assert.equal(calls[0].fn, 'Read-TextFileContent');
  });

  test('__approvalId 属允许集，不误报为未知参数（审批续跑不被阻断）', async () => {
    // 模拟「宿主未剥离审批字段」的直连调用方（A2A / 单测 / 未来通道）
    const { p, calls } = await makeProvider();
    const res = await run(p, 'storage.file.read', { path: 'C:\\WinVMWorkspace\\x.txt', __approvalId: 'apr_1' });
    assert.equal(res.ok, true, '__approvalId 不应导致 INVALID_PARAMS');
    assert.equal(calls.length, 1);
  });

  test('无 properties 的 schema → 跳过校验（不误报、不阻断）', async () => {
    const { p, calls } = await makeProvider();
    const res = await run(p, 'system.info.get', { bogus: 1, another: 2 });
    assert.equal(res.ok, true, '未声明 properties 的能力应跳过校验');
    assert.equal(calls.length, 1);
  });

  test('空 properties 的能力传空参数通过（如 meta.health.check）', async () => {
    const { p } = await makeProvider();
    const res = await run(p, 'meta.health.check', {});
    assert.equal(res.ok, true);
  });

  test('兜底分支③：无码异常透传 details（D24 step 5）', async () => {
    const { p } = await makeProvider({
      throwOnCall: { message: 'boom', details: { exceptionType: 'ParameterBindingException' } },
    });
    const res = await run(p, 'storage.file.read', { path: 'C:\\x' });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'EXECUTION_FAILED');
    assert.equal(res.error.reason, undefined);
    assert.deepEqual(res.error.details, { exceptionType: 'ParameterBindingException' });
  });
});

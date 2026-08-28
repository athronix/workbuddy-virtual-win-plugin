/**
 * LLM provider（adapter-agent-workbuddy-llm）单元测试
 *
 * 验证点（NFR-LLM-3 可测试性）：不依赖真实 codebuddy CLI，
 * 通过注入 MockLlmBridge + 假 executor 完成 runGoal 接线与委托验证。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { registerProviderFactory, unregisterProviderFactory } from '@winvm/core';
import { createProvider, PROVIDER_ID } from '@winvm/adapter-agent-workbuddy-llm';

function fakeCtx() {
  return {
    config: {},
    audit: {
      append: async () => ({ hash: 'h', prevHash: '', seq: 0, auditId: 'a' }),
      verifyChain: async () => ({ valid: true, entries: 0 }),
    },
    policy: { evaluate: () => ({ allowed: true, matchedRule: 'test' }) },
    capabilities: {
      get: () => ({ risk: 'L1', requiresSession: false }),
      list: () => ['system.info.get', 'appops.gui.produce', 'gui.screen.capture'],
      has: () => true,
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    newTraceId: () => 'trace_' + Math.random().toString(36).slice(2),
  };
}

function fakeExecutor() {
  const calls = [];
  return {
    calls,
    id: 'fake-exec',
    kind: 'deterministic',
    displayName: 'fake',
    declareCapabilities: () => [],
    async init() {},
    async execute(req) {
      calls.push(req);
      return { traceId: req.traceId, ok: true, data: { echoed: req.capabilityId }, durationMs: 1 };
    },
    async health() {
      return { ok: true, provider: { id: 'fake', state: 'ready' }, session: {}, psBridge: { state: 'ready', uptimeMs: 1, pending: 0 } };
    },
    async shutdown() {},
  };
}

function mockBridge(ok) {
  return {
    async runGoal(input, sink) {
      sink.onStatus('working', 'mock step');
      if (!ok) {
        return { ok: false, summary: 'mock fail', artifacts: [], steps: [], error: { code: 'EXECUTION_FAILED', message: 'MOCK_FAIL' } };
      }
      return {
        ok: true,
        summary: 'mock ok',
        artifacts: [{ kind: 'file', name: 'out.png', mime: 'image/png', data: 'YWJj', encoding: 'base64' }],
        steps: [
          { index: 0, capabilityId: 'appops.workflow.run', params: { goal: input.goal }, ok: true, risk: 'L1', durationMs: 1, traceId: input.traceId, summary: 'mock' },
        ],
      };
    },
  };
}

function captureSink() {
  const statuses = [];
  const artifacts = [];
  return {
    statuses,
    artifacts,
    onStatus(_s, m) {
      statuses.push(m);
    },
    onArtifact(a) {
      artifacts.push(a);
    },
    async onApprovalRequired() {
      return true;
    },
  };
}

describe('WorkbuddyLlmProvider', () => {
  test('createProvider 暴露 id=workbuddy / kind=llm-agent / 全能力域', () => {
    const p = createProvider({ bridge: mockBridge(true), executor: fakeExecutor() });
    assert.equal(p.id, 'workbuddy');
    assert.equal(p.kind, 'llm-agent');
    assert.equal(PROVIDER_ID, 'workbuddy');
    const caps = p.declareCapabilities();
    for (const d of ['meta', 'system', 'app', 'storage', 'gui', 'appops']) {
      assert.ok(caps.includes(`${d}.*`), `应声明 ${d}.*`);
    }
  });

  test('runGoal 成功：注入 mock bridge → ok + artifact + step + 进度回传', async () => {
    const p = createProvider({ bridge: mockBridge(true), executor: fakeExecutor() });
    await p.init(fakeCtx());
    const sink = captureSink();
    const res = await p.runGoal({ traceId: 't1', goal: '用 PS 把大山换成海洋', timeoutMs: 1000 }, sink);
    assert.equal(res.ok, true);
    assert.equal(res.artifacts.length, 1);
    assert.equal(res.artifacts[0].name, 'out.png');
    assert.equal(res.steps.length, 1);
    assert.ok(sink.statuses.length >= 1, '应回传进度');
  });

  test('runGoal 失败：注入失败 bridge → ok:false + error，不伪造', async () => {
    const p = createProvider({ bridge: mockBridge(false), executor: fakeExecutor() });
    await p.init(fakeCtx());
    const res = await p.runGoal({ traceId: 't2', goal: '未知目标', timeoutMs: 1000 }, captureSink());
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'EXECUTION_FAILED');
  });

  test('execute 委托给注入的 executor（复用确定性执行链路）', async () => {
    const exec = fakeExecutor();
    const p = createProvider({ bridge: mockBridge(true), executor: exec });
    await p.init(fakeCtx());
    const req = { traceId: 't3', capabilityId: 'gui.screen.capture', params: {}, risk: 'L1', approved: false, timeoutMs: 1000 };
    const r = await p.execute(req);
    assert.equal(r.ok, true);
    assert.equal(exec.calls.length, 1);
    assert.equal(exec.calls[0].capabilityId, 'gui.screen.capture');
  });

  test('经 loader 注册工厂可加载（agent.provider 切换机制）', async () => {
    registerProviderFactory('workbuddy', (opts) => createProvider({ ...opts, bridge: mockBridge(true), executor: fakeExecutor() }));
    const { loadProvider } = await import('@winvm/core');
    const prov = await loadProvider(
      { provider: 'workbuddy', providers: { workbuddy: { package: '@winvm/adapter-agent-workbuddy-llm', options: {} } } },
      fakeCtx(),
    );
    assert.equal(prov.id, 'workbuddy');
    assert.equal(prov.kind, 'llm-agent');
    unregisterProviderFactory('workbuddy');
  });
});

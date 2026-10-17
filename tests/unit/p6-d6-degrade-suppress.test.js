/**
 * Phase 6 批18 · D-6 专项回归：委派呈报失真修复
 *
 * 背景（真机实证 2026-10-17，`qa/p5-batch/b16/VERDICT.md`）：
 *   委派经审批放行后，服务端确定性重放**真实执行**了能力并写入诚实折叠回执
 *   （链 seq=20：ok=false / EXECUTION_FAILED / K6 核验未过），但 LLM 侧收口为
 *   ok=false 且零产物 ⇒ 命中 D4.4 降级分支 ⇒ 确定性兜底失败文案成为终态 summary
 *   ⇒ 宿主读到「未匹配到模板」而真实卸载早已发生；链上 delegation.complete 的
 *   错误码亦被替换成兜底的 UNKNOWN_CAPABILITY，真实病因永久丢失。
 *
 * 本文件钉三件事：
 *   ① 服务端账本显示本委派**有活动** ⇒ 抑制降级，终态如实带服务端事实与 traceId，
 *      错误码保持 LLM 侧真实码（不被兜底码替换）；
 *   ② 服务端**零活动**（真·LLM 运行时不可用）⇒ 照常降级（D4.4 语义逐字保留），
 *      且终态 summary 必须带 LLM 侧真实收口码 + error.details.degradedFrom* 透出；
 *   ③ probe 缺席 / 抛错 ⇒ fail-open 照常降级（取证失败绝不改变执行行为）。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createProvider } from '@winvm/adapter-agent-workbuddy-llm';

/** 与 llm-provider.test.js 同构的最小 ctx（无 delegationProbe ⇒ this.probe 缺席）。 */
function baseCtx() {
  return {
    config: {},
    audit: {
      append: async () => ({ hash: 'h', prevHash: '', seq: 0, auditId: 'a' }),
      verifyChain: async () => ({ valid: true, entries: 0 }),
    },
    policy: { evaluate: () => ({ allowed: true, matchedRule: 'test' }) },
    capabilities: {
      get: () => ({ risk: 'L1', requiresSession: false }),
      list: () => ['system.info.get'],
      has: () => true,
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    newTraceId: () => 'trace_' + Math.random().toString(36).slice(2),
  };
}

/** 带 delegationProbe 的 ctx（活动计数可配；throws=true 时探针抛错）。 */
function ctxWithProbe(activity, throws = false) {
  const ctx = baseCtx();
  ctx.delegationProbe = {
    delegationActivity: async () => {
      if (throws) throw new Error('probe boom');
      return activity;
    },
  };
  return ctx;
}

/** 确定性执行器替身：runGoal 恒失败（无匹配模板），并记录是否被调用过。 */
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
      return { traceId: req.traceId, ok: true, data: {}, durationMs: 1 };
    },
    async health() {
      return { ok: true, provider: { id: 'fake', state: 'ready' }, session: {}, psBridge: { state: 'ready', uptimeMs: 1, pending: 0 } };
    },
    async runGoal() {
      calls.push({ capabilityId: '__runGoal__' });
      return {
        ok: false,
        summary: '确定性执行器未匹配到模板',
        artifacts: [],
        steps: [],
        error: { code: 'UNSUPPORTED_GOAL', message: 'UNSUPPORTED_GOAL' },
      };
    },
    async shutdown() {},
  };
}

/** LLM 侧收口为 ok=false 且零产物（D-6 实证场景的输入形状）。 */
function failingBridge(code = 'EXECUTION_FAILED', reason) {
  return {
    async runGoal(_input, sink) {
      sink.onStatus('working', 'mock step');
      return {
        ok: false,
        summary: 'LLM 侧收口失败（mock）',
        artifacts: [],
        steps: [
          { index: 0, capabilityId: 'appops.workflow.run', params: {}, ok: true, risk: 'L1', durationMs: 1, traceId: 't', summary: 'mock' },
        ],
        error: { code, message: 'MOCK_FAIL', ...(reason ? { reason } : {}) },
      };
    },
  };
}

function captureSink() {
  const statuses = [];
  return {
    statuses,
    onStatus(_s, m) {
      statuses.push(m);
    },
    onArtifact() {},
    async onApprovalRequired() {
      return true;
    },
  };
}

const GOAL = { traceId: 'tr_d6_probe_1', goal: '卸载某个包', timeoutMs: 1000 };

describe('D-6 降级抑制：服务端已有委派活动证据', () => {
  test('有活动（executed/blocked/wild 任一非零）⇒ 抑制降级，不调用确定性执行器', async () => {
    const exec = fakeExecutor();
    const p = createProvider({ bridge: failingBridge(), executor: exec });
    await p.init(ctxWithProbe({ total: 2, executed: 1, blocked: 1, wild: 0 }));
    const res = await p.runGoal({ ...GOAL }, captureSink());
    assert.equal(res.ok, false);
    assert.equal(exec.calls.length, 0, '服务端已活动 ⇒ 不得降级重跑确定性执行器');
    assert.ok(res.summary.includes('未降级为确定性执行器'), '终态须如实标注未降级');
    assert.ok(res.summary.includes('executed=1/blocked=1/wild=0'), '终态须带服务端活动事实');
    assert.ok(res.summary.includes('traceId=tr_d6_probe_1'), '终态须指向审计链 traceId');
  });

  test('错误码保持 LLM 侧真实码（不被兜底 UNSUPPORTED_GOAL 替换）', async () => {
    const p = createProvider({ bridge: failingBridge('EXECUTION_FAILED', 'LLM_PERSISTENT_TURN_FAILED'), executor: fakeExecutor() });
    await p.init(ctxWithProbe({ total: 1, executed: 1, blocked: 0, wild: 0 }));
    const res = await p.runGoal({ ...GOAL }, captureSink());
    assert.equal(res.error.code, 'EXECUTION_FAILED', '真实码必须原样保留');
    assert.equal(res.error.reason, 'LLM_PERSISTENT_TURN_FAILED', '真实 reason 必须原样保留');
  });

  test('步骤不得保留 ok:true 的完成声称（与 K5/K-N1 真值判据同构）', async () => {
    const p = createProvider({ bridge: failingBridge(), executor: fakeExecutor() });
    await p.init(ctxWithProbe({ total: 3, executed: 0, blocked: 2, wild: 1 }));
    const res = await p.runGoal({ ...GOAL }, captureSink());
    assert.ok(res.steps.length > 0);
    for (const s of res.steps) {
      assert.equal(s.ok, false, '失败终态下步骤不得声称成功');
      assert.ok(s.summary.includes('未降级'), '步骤文案须与终态同源');
    }
  });

  test('抑制时向 sink 回传 D-6 状态（宿主可见）', async () => {
    const p = createProvider({ bridge: failingBridge(), executor: fakeExecutor() });
    await p.init(ctxWithProbe({ total: 1, executed: 1, blocked: 0, wild: 0 }));
    const sink = captureSink();
    await p.runGoal({ ...GOAL }, sink);
    assert.ok(
      sink.statuses.some((m) => m.includes('D-6') && m.includes('不降级为确定性执行器')),
      '应有 D-6 抑制状态回传',
    );
  });
});

describe('D-6 降级保留：真·运行时不可用（服务端零活动）', () => {
  test('零活动 ⇒ 照常降级，且 summary 带 LLM 侧真实收口码', async () => {
    const exec = fakeExecutor();
    const p = createProvider({ bridge: failingBridge('PROVIDER_UNAVAILABLE'), executor: exec });
    await p.init(ctxWithProbe({ total: 0, executed: 0, blocked: 0, wild: 0 }));
    const res = await p.runGoal({ ...GOAL }, captureSink());
    assert.equal(res.ok, false);
    assert.equal(exec.calls.length, 1, '零活动 ⇒ D4.4 降级语义逐字保留');
    assert.ok(res.summary.includes('已降级为确定性执行'), 'summary 应标明已降级');
    assert.ok(
      res.summary.includes('（LLM 侧收口：PROVIDER_UNAVAILABLE）'),
      'D-6(c)：summary 必须带 LLM 侧真实码',
    );
  });

  test('零活动 + 有 reason ⇒ truthTag 同时带 code 与 reason', async () => {
    const p = createProvider({ bridge: failingBridge('EXECUTION_FAILED', 'LLM_PERSISTENT_TURN_FAILED'), executor: fakeExecutor() });
    await p.init(ctxWithProbe({ total: 0, executed: 0, blocked: 0, wild: 0 }));
    const res = await p.runGoal({ ...GOAL }, captureSink());
    assert.ok(res.summary.includes('（LLM 侧收口：EXECUTION_FAILED/LLM_PERSISTENT_TURN_FAILED）'));
  });

  test('真实码经 error.details.degradedFrom* 双通道透出（兜底码仍为 error.code）', async () => {
    const p = createProvider({ bridge: failingBridge('EXECUTION_FAILED'), executor: fakeExecutor() });
    await p.init(ctxWithProbe({ total: 0, executed: 0, blocked: 0, wild: 0 }));
    const res = await p.runGoal({ ...GOAL }, captureSink());
    assert.equal(res.error.code, 'UNSUPPORTED_GOAL', '兜底错误本体保持既有语义（守卫逐字不变）');
    assert.equal(res.error.details.degradedFromCode, 'EXECUTION_FAILED', '真实码必须入 details');
  });
});

describe('D-6 fail-open：取证失败绝不改变执行行为', () => {
  test('probe 缺席（旧服务端 / 单测 / degraded）⇒ 照常降级', async () => {
    const exec = fakeExecutor();
    const p = createProvider({ bridge: failingBridge(), executor: exec });
    await p.init(baseCtx()); // 无 delegationProbe
    const res = await p.runGoal({ ...GOAL }, captureSink());
    assert.equal(res.ok, false);
    assert.equal(exec.calls.length, 1, 'probe 缺席 ⇒ 旧 D4.4 行为逐字保留');
    assert.ok(res.summary.includes('（LLM 侧收口：EXECUTION_FAILED）'));
  });

  test('probe 抛错 ⇒ 照常降级（不因取证失败挂死或改判）', async () => {
    const exec = fakeExecutor();
    const p = createProvider({ bridge: failingBridge(), executor: exec });
    await p.init(ctxWithProbe(null, true));
    const res = await p.runGoal({ ...GOAL }, captureSink());
    assert.equal(res.ok, false);
    assert.equal(exec.calls.length, 1, 'probe 异常 ⇒ fail-open 照常降级');
  });

  test('不可降级码（TIMEOUT）仍不降级（既有红线不因 D-6 松动）', async () => {
    const exec = fakeExecutor();
    const p = createProvider({ bridge: failingBridge('TIMEOUT'), executor: exec });
    await p.init(ctxWithProbe({ total: 0, executed: 0, blocked: 0, wild: 0 }));
    const res = await p.runGoal({ ...GOAL }, captureSink());
    assert.equal(res.error.code, 'TIMEOUT');
    assert.equal(exec.calls.length, 0, '超时不应触发降级（避免重复劳动）');
  });
});

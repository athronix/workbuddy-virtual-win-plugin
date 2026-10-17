/**
 * Phase 6 批18 · D-7 专项回归：失败路径不得把错误码写进 `policyDecision.matchedRule`
 *
 * 背景（真机实证 2026-10-17，审计链 seq=16）：
 *   能力执行失败（ps-bridge 未心跳重启）时，链上条目为
 *   `policyDecision = { allowed:false, matchedRule:'EXECUTION_FAILED' }` ——
 *   `matchedRule` 的契约语义是**规则名/事实名**（见 `task-evict-audit` 同族约定与
 *   server.ts 既有 `runtime:provider-unavailable` 命名），错误码应由
 *   `result.errorCode` **独立**承载。二者互相顶替会让按规则名前缀归因的消费方
 *   （如 `isScopeGateRejection`）读到噪声，也让「策略拒绝」与「运行时失败」在链上同形。
 *
 * 本文件钉：失败站点入链的 `matchedRule` 恒为 `runtime:execution-failed`，
 * 且 `result.errorCode` 保留真实错误码（二者不互相顶替）。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { CapabilityRegistry } from '@winvm/core';
import { CorePolicyEngine } from '@winvm/core';
import { DeterministicAgentProvider } from '@winvm/adapter-agent-workbuddy';

/** 采集审计条目（失败站点走 `ctx.audit.append`）。 */
function mkCtx(registry) {
  const appended = [];
  const bridge = {
    running: true,
    uptimeMs: 1,
    async start() {},
    async stop() {},
    async call() {
      return { ok: true };
    },
    health: () => ({ state: 'ready', uptimeMs: 1, pending: 0, lastHeartbeatAgoMs: 0 }),
  };
  return {
    appended,
    ctx: {
      config: {},
      audit: {
        append: async (entry) => {
          appended.push(entry);
          return { hash: 'h', prevHash: '', seq: appended.length, auditId: entry.auditId };
        },
        verifyChain: async () => ({ valid: true, entries: 0 }),
      },
      policy: new CorePolicyEngine({ registry }),
      capabilities: {
        get: (id) => registry.get(id),
        list: () => [...registry.list?.() ?? []],
        has: (id) => Boolean(registry.get(id)),
      },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      bridge,
      newTraceId: () => 'tr_d7_' + Math.random().toString(36).slice(2, 8),
    },
  };
}

describe('D-7 失败站点 matchedRule 订正', () => {
  test('能力未注册（UNKNOWN_CAPABILITY）⇒ matchedRule 是规则名，错误码入 errorCode', async () => {
    const registry = new CapabilityRegistry();
    const { appended, ctx } = mkCtx(registry);
    const p = new DeterministicAgentProvider();
    await p.init(ctx);

    const res = await p.execute({
      traceId: 'tr_d7_unknown',
      capabilityId: 'no.such.cap',
      params: {},
      channel: 'mcp',
    });

    assert.equal(res.ok, false, '未注册能力必须失败');
    assert.equal(appended.length, 1, '失败站点必须入链（S-4 同族纪律）');
    const entry = appended[0];
    assert.equal(
      entry.policyDecision.matchedRule,
      'runtime:execution-failed',
      'matchedRule 必须是规则名/事实名，不得写入错误码',
    );
    assert.equal(entry.result.errorCode, 'UNKNOWN_CAPABILITY', '真实错误码由 errorCode 独立承载');
    assert.equal(entry.result.ok, false);
  });

  test('matchedRule 不随错误码变化而漂移（同一失败站点恒定）', async () => {
    const registry = new CapabilityRegistry();
    const { appended, ctx } = mkCtx(registry);
    const p = new DeterministicAgentProvider();
    await p.init(ctx);

    // 两个不同失败原因（均未经策略闸拦截，直接走失败站点）
    await p.execute({ traceId: 'tr_d7_a', capabilityId: 'no.such.a', params: {}, channel: 'mcp' });
    await p.execute({ traceId: 'tr_d7_b', capabilityId: 'no.such.b', params: {}, channel: 'mcp' });

    assert.equal(appended.length, 2);
    assert.equal(appended[0].policyDecision.matchedRule, 'runtime:execution-failed');
    assert.equal(appended[1].policyDecision.matchedRule, 'runtime:execution-failed');
    // 错误码各自独立承载（此处同为 UNKNOWN_CAPABILITY，但字段不互相顶替）
    assert.equal(appended[0].result.errorCode, 'UNKNOWN_CAPABILITY');
    assert.equal(appended[1].result.errorCode, 'UNKNOWN_CAPABILITY');
  });
});

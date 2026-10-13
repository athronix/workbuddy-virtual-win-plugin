/**
 * Phase 3 批5 · R-5 取消风暴门禁（用户 2026-10-13 终裁 B=主动排期）。
 * 三层：CancelRateLimiter 纯函数 + resolveCancelRateLimit env 解析 + A2AServer tasks/cancel 端到端。
 * 纯 stdlib；逐文件跑（绝不整批）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = join(import.meta.dirname, '..', '..');
const URL = (p) => pathToFileURL(join(ROOT, 'packages', p, 'dist', 'index.js')).href;

describe('R-5 · CancelRateLimiter 纯函数', async () => {
  const { CancelRateLimiter } = await import(URL('a2a-framework'));

  test('禁用（windowMs≤0 或 max≤0）⇒ 恒放行、retryAfter 0', () => {
    for (const bad of [{ windowMs: 0, maxPerWindow: 5 }, { windowMs: 1000, maxPerWindow: 0 }, { windowMs: -1, maxPerWindow: -1 }]) {
      const rl = new CancelRateLimiter(bad);
      assert.equal(rl.enabled, false, `坏窗口参数应判禁用：${JSON.stringify(bad)}`);
      for (let i = 0; i < 100; i++) assert.equal(rl.tryConsume(1000 + i).allowed, true);
    }
  });

  test('窗口内到达 max 即拒，拒后不消费预算', () => {
    const rl = new CancelRateLimiter({ windowMs: 1000, maxPerWindow: 3 });
    assert.equal(rl.tryConsume(0).allowed, true);
    assert.equal(rl.tryConsume(10).allowed, true);
    assert.equal(rl.tryConsume(20).allowed, true);
    const denied = rl.tryConsume(30);
    assert.equal(denied.allowed, false);
    assert.ok(denied.retryAfterMs >= 1 && denied.retryAfterMs <= 1000, `retryAfter 应落 [1,1000]，实得 ${denied.retryAfterMs}`);
    assert.equal(rl.currentWindowCount, 3, '被拒不入窗口（不消耗预算）');
  });

  test('窗口滑动：旧命中滑出后重新可放行', () => {
    const rl = new CancelRateLimiter({ windowMs: 100, maxPerWindow: 2 });
    assert.equal(rl.tryConsume(0).allowed, true);
    assert.equal(rl.tryConsume(10).allowed, true);
    assert.equal(rl.tryConsume(50).allowed, false, '窗口内已满应拒');
    // t=200 时，t=0/10 的命中都滑出（200-100=100 界，0/10 都 ≤100）
    assert.equal(rl.tryConsume(200).allowed, true, '滑窗后应重新放行');
    assert.equal(rl.currentWindowCount, 1);
  });

  test('reset 清窗口', () => {
    const rl = new CancelRateLimiter({ windowMs: 1000, maxPerWindow: 1 });
    assert.equal(rl.tryConsume(0).allowed, true);
    assert.equal(rl.tryConsume(5).allowed, false);
    rl.reset();
    assert.equal(rl.currentWindowCount, 0);
    assert.equal(rl.tryConsume(5).allowed, true);
  });

  test('风暴模拟：200 次瞬时 cancel 齐射仅前 max 放行，其余全拒（这正是 198×8 打挂现场的挡法）', () => {
    const rl = new CancelRateLimiter({ windowMs: 1000, maxPerWindow: 10 });
    let allowed = 0;
    let denied = 0;
    for (let i = 0; i < 200; i++) {
      if (rl.tryConsume(0).allowed) allowed++;
      else denied++;
    }
    assert.equal(allowed, 10, '齐射同刻只有 max 个能过');
    assert.equal(denied, 190, '其余全被挡在 requestCancel 之前');
  });
});

describe('R-5 · resolveCancelRateLimit env 解析', async () => {
  const { resolveCancelRateLimit } = await import(URL('core'));

  test('全缺省 ⇒ 10/1000ms', () => {
    const r = resolveCancelRateLimit({});
    assert.deepEqual(r, { maxPerWindow: 10, windowMs: 1000 });
  });

  test('显式 0 ⇒ 禁用门禁（保留旧行为）', () => {
    const r = resolveCancelRateLimit({ WINVM_CANCEL_RATE_MAX: '0' });
    assert.equal(r.maxPerWindow, 0);
  });

  test('非法 max（负/NaN/空）⇒ 回退默认 10', () => {
    for (const bad of ['-5', 'abc', '', '  ']) {
      assert.equal(resolveCancelRateLimit({ WINVM_CANCEL_RATE_MAX: bad }).maxPerWindow, 10, `坏值 ${JSON.stringify(bad)} 应回退 10`);
    }
  });

  test('非法 window ⇒ 回退默认 1000；合法覆盖', () => {
    assert.equal(resolveCancelRateLimit({ WINVM_CANCEL_RATE_WINDOW_MS: '0' }).windowMs, 1000);
    assert.equal(resolveCancelRateLimit({ WINVM_CANCEL_RATE_WINDOW_MS: '-1' }).windowMs, 1000);
    assert.equal(resolveCancelRateLimit({ WINVM_CANCEL_RATE_WINDOW_MS: '250' }).windowMs, 250);
  });
});

describe('R-5 · A2AServer tasks/cancel 端到端门禁', async () => {
  const mod = await import(URL('a2a-framework'));
  const { A2AServer } = mod;

  function handler() {
    return {
      async runGoal(goal, sink) {
        // 长延时让 task 稳定在 working 态（terminal 不可 cancel）
        await new Promise((r) => setTimeout(r, 5000));
        return { ok: true, summary: 'done', artifacts: [], steps: [] };
      },
    };
  }
  const card = {
    name: 'T', description: 'd', version: '1.0.0', url: 'http://127.0.0.1:18443/a2a',
    skills: [{ id: 'system-admin', name: 's', description: 'd', tags: ['system'] }],
  };
  async function newWorkingTask(server, n) {
    const res = await server.handleRequest({
      jsonrpc: '2.0', id: '1', method: 'message/send',
      params: { message: { kind: 'message', role: 'user', messageId: `m${n}`, parts: [{ kind: 'text', text: 'go' }] }, metadata: { traceId: `tr_${n}` } },
    });
    return res.result.id;
  }

  test('配限流：前 max 个 cancel 正常放行（进 requestCancel），超出被拒且不触碰 task', async () => {
    const server = new A2AServer({ agentCard: card, handler: handler(), cancelRateLimit: { windowMs: 100000, maxPerWindow: 3 } });
    // 造 5 个在途 task
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(await newWorkingTask(server, i));
    let allowed = 0;
    let rateLimited = 0;
    for (const id of ids) {
      const r = await server.handleRequest({ jsonrpc: '2.0', id: 'c', method: 'tasks/cancel', params: { name: `tasks/${id}` } });
      if (r.error && r.error.data && r.error.data.rateLimited) rateLimited++;
      else if (r.result) allowed++;
    }
    assert.equal(allowed, 3, '限 3 ⇒ 恰 3 个真进 requestCancel');
    assert.equal(rateLimited, 2, '其余 2 个被挡在 requestCancel 之前');
  });

  test('拒绝发生在 task 查找**之前**：对不存在 id 的超量 cancel 返回 rateLimited 而非 TaskNotFound', async () => {
    const server = new A2AServer({ agentCard: card, handler: handler(), cancelRateLimit: { windowMs: 100000, maxPerWindow: 1 } });
    const ok1 = await server.handleRequest({ jsonrpc: '2.0', id: 'a', method: 'tasks/cancel', params: { name: 'tasks/ghost-1' } });
    // 首个消费预算 ⇒ 到 requestCancel ⇒ ghost 触发 TaskNotFound（非 rateLimited）
    const isRate = (r) => !!(r.error && r.error.data && r.error.data.rateLimited);
    assert.equal(isRate(ok1), false, '首个不应被限流（应到 requestCancel 报 TaskNotFound/NotCancelable）');
    const ok2 = await server.handleRequest({ jsonrpc: '2.0', id: 'b', method: 'tasks/cancel', params: { name: 'tasks/ghost-2' } });
    assert.equal(isRate(ok2), true, '第二个超限 ⇒ 必须 rateLimited（证明挡在 requestCancel 之前）');
    assert.ok(ok2.error.data.retryAfterMs >= 1, '拒回应带退避提示');
  });

  test('未配 cancelRateLimit ⇒ 逐字旧行为（连发 200 cancel 不因限流报错）', async () => {
    const server = new A2AServer({ agentCard: card, handler: handler() });
    let rateLimited = 0;
    for (let i = 0; i < 200; i++) {
      const r = await server.handleRequest({ jsonrpc: '2.0', id: String(i), method: 'tasks/cancel', params: { name: `tasks/x${i}` } });
      if (r.error && r.error.data && r.error.data.rateLimited) rateLimited++;
    }
    assert.equal(rateLimited, 0, '未配限流 ⇒ 恒零 rateLimited（旧行为，全是 TaskNotFound）');
  });
});

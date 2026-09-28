/**
 * /health 会话子探针独立短超时（QA 遗留 P2）单元测试
 *
 * 锁住三个回归点：
 *   1. ps-bridge 未就绪时 /health 不再被 lazy 自愈阻塞 ~27s —— 子探针须在
 *      WINVM_HEALTH_PROBE_TIMEOUT_MS（默认 5000ms）内返回降级快照；
 *   2. 超时时 psBridge.state 给出可辨识降级值 'timeout'；桥未运行仍为 'unavailable'（语义不变）；
 *   3. GUI 门禁语义不放宽：超时回退 session.state='unavailable' ≠ 'healthy'。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  providerHealthTimeoutSnapshot,
  raceHealthSubProbes,
  raceSessionProbe,
  raceWithTimeout,
  resolveHealthProbeTimeoutMs,
  resolvePsBridgeHealthState,
  timeoutSessionSnapshot,
} from '@winvm/vm-service';

describe('resolveHealthProbeTimeoutMs（env-gate 写法对齐 WINVM_PSBRIDGE_READY_TIMEOUT_MS）', () => {
  test('默认 5000ms', () => {
    assert.equal(resolveHealthProbeTimeoutMs({}), 5_000);
    assert.equal(resolveHealthProbeTimeoutMs({ WINVM_HEALTH_PROBE_TIMEOUT_MS: '' }), 5_000);
    assert.equal(resolveHealthProbeTimeoutMs(), 5_000);
  });

  test('env 可覆盖', () => {
    assert.equal(resolveHealthProbeTimeoutMs({ WINVM_HEALTH_PROBE_TIMEOUT_MS: '8000' }), 8_000);
    assert.equal(resolveHealthProbeTimeoutMs({ WINVM_HEALTH_PROBE_TIMEOUT_MS: '1234' }), 1_234);
  });

  test('非法值（NaN / 0 / 负数）回退默认，不产生「立即超时」歧义', () => {
    assert.equal(resolveHealthProbeTimeoutMs({ WINVM_HEALTH_PROBE_TIMEOUT_MS: 'abc' }), 5_000);
    assert.equal(resolveHealthProbeTimeoutMs({ WINVM_HEALTH_PROBE_TIMEOUT_MS: '0' }), 5_000);
    assert.equal(resolveHealthProbeTimeoutMs({ WINVM_HEALTH_PROBE_TIMEOUT_MS: '-5' }), 5_000);
  });
});

describe('resolvePsBridgeHealthState（可辨识降级值）', () => {
  test('桥 ready + 子探针按时应答 → ready（既有语义不变）', () => {
    assert.equal(resolvePsBridgeHealthState('ready', false), 'ready');
  });

  test('桥 ready + 子探针超时 → degraded（契约 ProviderState 内的可辨识降级值；', () => {
    // 不扩 'timeout' 字面量进 ProviderState：会改动跨包契约并在 ServiceRuntime.health
    // 的 Promise<HealthStatus> 赋值处类型破裂。降级原因由 server.ts 的扩展字段
    // psBridge.probe='timeout' 承载（D2 扩展模式）。
    assert.equal(resolvePsBridgeHealthState('ready', true), 'degraded');
  });

  test('桥未运行 → unavailable（既有语义不变，无论探针是否超时）', () => {
    assert.equal(resolvePsBridgeHealthState('down', false), 'unavailable');
    assert.equal(resolvePsBridgeHealthState('down', true), 'unavailable');
  });
});

describe('raceSessionProbe（消 27s 阻塞）', () => {
  test('探针按时返回 → 原样透传，timedOut=false', async () => {
    const real = {
      sessionId: 2, windowStation: 'WinSta0', desktop: 'Default',
      interactive: true, locked: false, blackScreen: false, state: 'healthy',
    };
    const t0 = Date.now();
    const out = await raceSessionProbe(async () => real, 1_000);
    assert.equal(out.timedOut, false);
    assert.equal(out.session, real, '未超时时应透传探针原结果（含 interactive 等真实字段）');
    assert.ok(Date.now() - t0 < 1_000, '不应等到超时才返回');
  });

  test('探针在时限内未返回 → 快速返回降级快照（≤ 超时值 + 余量），不再等 27s 自愈', async () => {
    const t0 = Date.now();
    // 模拟 ps-bridge 未就绪：探针挂起 27s（远超 60ms 测试超时）
    const out = await raceSessionProbe(
      () => new Promise((resolve) => setTimeout(() => resolve({}), 27_000)),
      60,
    );
    const elapsed = Date.now() - t0;
    assert.equal(out.timedOut, true, '应标记 timedOut=true');
    assert.ok(elapsed < 5_000, `应在超时值附近返回（实测 ${elapsed}ms），绝不阻塞 27s`);
    assert.equal(out.session.state, 'unavailable', 'GUI 门禁语义不放宽：unavailable ≠ healthy');
    assert.equal(out.session.interactive, false, 'interactive 不得猜测为 true');
    assert.match(out.session.detail ?? '', /未返回/, 'detail 应记录超时事实');
  });

  test('探针自身 reject → 回退 unavailable 快照但不标 timedOut（桥此时应为 down）', async () => {
    const out = await raceSessionProbe(() => Promise.reject(new Error('ps-bridge 未运行')), 1_000);
    assert.equal(out.timedOut, false);
    assert.equal(out.session.state, 'unavailable');
  });

  test('超时后探针 Promise 继续在后台执行且其 reject 不产生 unhandled rejection', async () => {
    // 探针 50ms 后才 reject，但超时 10ms 先赢 —— race 已在创建时挂上拒绝处理器，
    // 不会触发 process 级 unhandledRejection（node --test 会把其视为错误）。
    const out = await raceSessionProbe(
      () => new Promise((_, reject) => setTimeout(() => reject(new Error('late failure')), 50)),
      10,
    );
    assert.equal(out.timedOut, true);
    await new Promise((r) => setTimeout(r, 80)); // 给后台 reject 留时间；有 unhandled rejection 时本测试会失败
  });
});

describe('timeoutSessionSnapshot（降级快照形状）', () => {
  test('interactive=false / locked=false / blackScreen=false / state=unavailable（绝不猜测为健康）', () => {
    const s = timeoutSessionSnapshot(5_000);
    assert.equal(s.sessionId, 0);
    assert.equal(s.interactive, false);
    assert.equal(s.locked, false);
    assert.equal(s.blackScreen, false);
    assert.equal(s.state, 'unavailable');
    assert.ok(s.detail?.includes('5000'));
  });
});

/* ============================================================================
 * P2 第二段：provider.health() 纳入短超时护栏
 *
 * 背景：server.ts buildHealth 曾对 provider.health() 裸 await —— workbuddy adapter
 * 的 health() 内部又同步跑了一次 20s 级会话探针（bridge.call 20_000ms），
 * 5s race 只护住了第一个探针，kill ps-bridge 后 /health 总时延仍 10.4–12.5s。
 * ========================================================================== */

describe('raceWithTimeout（通用短超时 race helper，/health 子探针共用一套）', () => {
  test('任务按时返回 → 原样透传，timedOut=false', async () => {
    const real = { ok: true, provider: { id: 'workbuddy', state: 'ready' } };
    const t0 = Date.now();
    const out = await raceWithTimeout(Promise.resolve(real), 1_000, { ok: false });
    assert.equal(out.timedOut, false);
    assert.equal(out.value, real, '未超时应透传任务原结果');
    assert.ok(Date.now() - t0 < 1_000, '不应等到超时才返回');
  });

  test('任务在时限内未返回 → 快速返回降级 fallback（timedOut=true），不抛错', async () => {
    const fallback = { ok: false, provider: { id: 'workbuddy', state: 'degraded' } };
    const t0 = Date.now();
    const out = await raceWithTimeout(
      new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 27_000)),
      60,
      fallback,
    );
    const elapsed = Date.now() - t0;
    assert.equal(out.timedOut, true);
    assert.equal(out.value, fallback);
    assert.ok(elapsed < 5_000, `应在超时值附近返回（实测 ${elapsed}ms），绝不阻塞 27s`);
  });

  test('任务自身 reject → 回退 fallback（timedOut=false）且无 unhandled rejection', async () => {
    const out = await raceWithTimeout(
      Promise.reject(new Error('boom')),
      1_000,
      { ok: false },
    );
    assert.equal(out.timedOut, false);
    assert.deepEqual(out.value, { ok: false });
  });

  test('超时后任务 Promise 继续在后台执行且其 reject 不产生 unhandled rejection', async () => {
    const out = await raceWithTimeout(
      new Promise((_, reject) => setTimeout(() => reject(new Error('late failure')), 50)),
      10,
      'fallback',
    );
    assert.equal(out.timedOut, true);
    await new Promise((r) => setTimeout(r, 80)); // 有 unhandled rejection 时本测试会失败
  });
});

describe('providerHealthTimeoutSnapshot（provider.health() 降级快照形状）', () => {
  test('provider.state=degraded（既有降级语义）+ detail 记录超时事实，可辨识', () => {
    const s = providerHealthTimeoutSnapshot('workbuddy', 5_000);
    assert.equal(s.ok, false, '快照自身 ok=false（顶层 ok 由 buildHealth 按桥状态独立计算）');
    assert.equal(s.provider.id, 'workbuddy');
    assert.equal(s.provider.state, 'degraded');
    assert.match(s.provider.detail ?? '', /未返回/);
    assert.match(s.provider.detail ?? '', /5000/);
    assert.equal(s.session.state, 'unavailable', '结论未知，绝不猜测为健康');
  });
});

describe('raceHealthSubProbes（provider.health() 慢时 /health 整体在超时预算内返回降级快照）', () => {
  test('provider.health() 挂起 20s 级 → 与会话子探针并发 race，总耗时收敛到单路超时（不 5s+5s 叠加）', async () => {
    const slowSession = () => new Promise((resolve) => setTimeout(() => resolve({}), 27_000));
    const slowProviderHealth = () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 27_000));
    const t0 = Date.now();
    const out = await raceHealthSubProbes({
      sessionProbe: slowSession,
      providerHealth: slowProviderHealth,
      providerId: 'workbuddy',
      timeoutMs: 150,
    });
    const elapsed = Date.now() - t0;
    // 并发：≈150ms；若实现退化为顺序 await 则 ≥300ms —— 此断言锁死并发性
    assert.ok(elapsed < 300, `两路必须并发 race（实测 ${elapsed}ms，顺序叠加会 ≥300ms）`);
    assert.equal(out.sessionTimedOut, true);
    assert.equal(out.providerTimedOut, true);
    assert.equal(out.session.state, 'unavailable');
    assert.equal(out.providerHealth.provider.id, 'workbuddy');
    assert.equal(out.providerHealth.provider.state, 'degraded');
    assert.match(out.providerHealth.provider.detail ?? '', /未返回/);
  });

  test('全绿路径：两路均按时返回 → 原样透传，无降级', async () => {
    const realSession = {
      sessionId: 2, windowStation: 'WinSta0', desktop: 'Default',
      interactive: true, locked: false, blackScreen: false, state: 'healthy',
    };
    const realProvider = { ok: true, provider: { id: 'workbuddy', state: 'ready' } };
    const out = await raceHealthSubProbes({
      sessionProbe: async () => realSession,
      providerHealth: async () => realProvider,
      providerId: 'workbuddy',
      timeoutMs: 1_000,
    });
    assert.equal(out.session, realSession);
    assert.equal(out.providerHealth, realProvider);
    assert.equal(out.sessionTimedOut, false);
    assert.equal(out.providerTimedOut, false);
  });

  test('provider 为 undefined（非 workbuddy）→ providerHealth=undefined，仅会话子探针参与', async () => {
    const realSession = {
      sessionId: 2, windowStation: 'WinSta0', desktop: 'Default',
      interactive: true, locked: false, blackScreen: false, state: 'healthy',
    };
    const out = await raceHealthSubProbes({
      sessionProbe: async () => realSession,
      providerHealth: undefined,
      providerId: 'meta',
      timeoutMs: 1_000,
    });
    assert.equal(out.providerHealth, undefined, '保持既有「provider 未加载」行为');
    assert.equal(out.session, realSession);
    assert.equal(out.sessionTimedOut, false);
  });

  test('provider.health() 自身 reject → 回退降级快照（timedOut=false），/health 不 5xx', async () => {
    const out = await raceHealthSubProbes({
      sessionProbe: async () => ({
        sessionId: 2, windowStation: 'WinSta0', desktop: 'Default',
        interactive: true, locked: false, blackScreen: false, state: 'healthy',
      }),
      providerHealth: () => Promise.reject(new Error('provider boom')),
      providerId: 'workbuddy',
      timeoutMs: 1_000,
    });
    assert.equal(out.providerTimedOut, false);
    assert.equal(out.providerHealth.provider.state, 'degraded');
    assert.match(out.providerHealth.provider.detail ?? '', /未返回/);
  });
});

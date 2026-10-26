/**
 * Phase 1 · T4 判据⑥ —— MCP 续跑令牌表的有界化（`packages/vm-service/src/pending-approvals.ts`）
 *
 * 覆盖设计 `docs/archive/changes/phase1-arch-design.md` §7.4-T4 判据⑥分项：
 *  - `registry.sweepExpired` **不扫** `hostApproved:true` 的在途条目（**O-10**）；
 *  - `close()` 后**无定时器残留**（句柄被 clear、且不再复活）；
 * 附带覆盖：
 *  - 窄 `Map` 替身面与既有调用点同签名（区 3「替换而非改造」的先决条件）；
 *  - TTL 非法值归一为"未启用过期语义"（逐字旧行为，不静默改语义）；
 *  - 边界时刻不双写（严格 `<`，与 `TaskStore.waitApproval` 的 setTimeout 时序对齐）；
 *  - `unref()` 恒调用（未决审批不得拖住进程退出）；
 *  - 清扫回调异常被吞（定时器内逃逸 = uncaughtException = 打挂服务）。
 *
 * 纪律：不起 HTTP 服务、不 spawn ps-bridge、全部用注入假定时器驱动。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { PendingApprovalRegistry } from '@winvm/vm-service';

/** 最小条目形状（`SweeperEntry` 的结构性替身，与 `PendingApproval` 同字段子集）。 */
function entry(approvalId, createdAtMs, hostApproved) {
  return { approvalId, createdAtMs, ...(hostApproved === undefined ? {} : { hostApproved }) };
}

/** 假定时器驱动面（可手动 fire，无需真计时）。 */
function fakeTimers() {
  const scheduled = [];
  const cleared = [];
  let seq = 0;
  return {
    scheduled,
    cleared,
    setTimer(fn, delayMs) {
      const handle = { id: `t${seq++}`, delayMs, unrefCalls: 0, unref() { this.unrefCalls += 1; } };
      scheduled.push({ handle, fn });
      return handle;
    },
    clearTimer(handle) {
      cleared.push(handle);
    },
    /** 触发最早挂的一枚定时器（模拟到点）。 */
    fire(index = 0) {
      const t = this.scheduled[index];
      assert.ok(t, `假定时器无第 ${index} 枚`);
      t.fn();
      return t.handle;
    },
  };
}

/* ===================================================================== */
describe('T4 判据⑥-1 O-10 在途保护：sweepExpired 不扫 hostApproved:true', () => {
  test('过期未批准条目被逐出并返回；在途（hostApproved=true）条目保留', () => {
    const reg = new PendingApprovalRegistry({ ttlMs: 1000, now: () => 5000 });
    reg.set('stale', entry('stale', 1000));            // 1000+1000 < 5000 ⇒ 过期
    reg.set('inflight', entry('inflight', 1000, true)); // 同样过期但宿主已批准 ⇒ 不得逐
    reg.set('fresh', entry('fresh', 4900));             // 未过期

    const swept = reg.sweepExpired();
    assert.deepEqual(swept.map((e) => e.approvalId), ['stale']);
    assert.equal(reg.has('inflight'), true, 'O-10：在途重放令牌被误删会打断真实执行');
    assert.equal(reg.has('fresh'), true);
    assert.equal(reg.has('stale'), false, '已过期条目必须真删除（不是只返回）');
    assert.equal(reg.size, 2);
  });

  test('sweepExpiredEntries 回传 [key, entry]（装配层需要键，不依赖隐含不变式）', () => {
    const reg = new PendingApprovalRegistry({ ttlMs: 1000, now: () => 5000 });
    reg.set('k1', entry('different-id', 1000));
    const pairs = reg.sweepExpiredEntries();
    assert.deepEqual(pairs, [['k1', entry('different-id', 1000)]]);
    assert.equal(pairs[0][0], 'k1', '键须原样回传，不得从条目字段反推');
  });

  test('hostApproved=false 的过期条目照逐（严格等值判据，非 truthy 宽容）', () => {
    const reg = new PendingApprovalRegistry({ ttlMs: 1000, now: () => 5000 });
    reg.set('a', entry('a', 1000, false));
    assert.equal(reg.sweepExpired().length, 1);
  });

  test('连续两轮清扫幂等（第二轮空转，不重复取证）', () => {
    const reg = new PendingApprovalRegistry({ ttlMs: 1000, now: () => 5000 });
    reg.set('a', entry('a', 1000));
    assert.equal(reg.sweepExpired().length, 1);
    assert.equal(reg.sweepExpired().length, 0);
  });

  test('边界时刻不逐（严格 < ⇒ 与 TaskStore setTimeout 同刻不双写）', () => {
    const reg = new PendingApprovalRegistry({ ttlMs: 1000, now: () => 2000 });
    reg.set('edge', entry('edge', 1000)); // 1000+1000 === 2000 ⇒ 恰好到点
    assert.equal(reg.sweepExpired().length, 0, '边界同刻必须留给 waitApproval 的主落点');
    assert.equal(reg.sweepExpired(2001).length, 1, '下一拍才逐');
  });
});

/* ===================================================================== */
describe('T4 判据⑥-2 TTL 归一：坏配置不得打挂服务、也不得悄悄改语义', () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    test(`ttlMs=${String(bad)} ⇒ ttl=Infinity（永不过期 = 逐字旧行为，不静默驱逐）`, () => {
      const reg = new PendingApprovalRegistry({ ttlMs: bad, now: () => 1e12 });
      reg.set('a', entry('a', 0));
      assert.equal(reg.ttl, Number.POSITIVE_INFINITY);
      assert.deepEqual(reg.sweepExpired(), [], '未启用过期语义时不得逐出任何条目');
      assert.equal(reg.has('a'), true);
    });
  }

  test('正常值向下取整（小数毫秒不留浮点误差面）', () => {
    assert.equal(new PendingApprovalRegistry({ ttlMs: 1500.9 }).ttl, 1500);
  });
});

/* ===================================================================== */
describe('T4 判据⑥-3 定时器生命周期（unref / 幂等 / close 无残留）', () => {
  test('startTimer 挂一枚表且句柄已 unref（未决审批不拖住进程退出）', () => {
    const t = fakeTimers();
    const reg = new PendingApprovalRegistry({ ttlMs: 60_000, setTimer: t.setTimer, clearTimer: t.clearTimer });
    const handle = reg.startTimer();
    assert.ok(handle, '应返回句柄');
    assert.equal(t.scheduled.length, 1);
    assert.equal(handle.unrefCalls, 1, 'unref() 必须恰一次');
    assert.equal(reg.timerHandle, handle);
  });

  test('幂等：重复 startTimer 不叠表', () => {
    const t = fakeTimers();
    const reg = new PendingApprovalRegistry({ ttlMs: 60_000, setTimer: t.setTimer, clearTimer: t.clearTimer });
    const first = reg.startTimer();
    const second = reg.startTimer();
    assert.equal(first, second);
    assert.equal(t.scheduled.length, 1, '不得重复挂表（清扫重叠是慢盘上的真实故障面）');
  });

  test('缺省间隔 = max(60s, ttl/4)（下限防滑表、上限保最坏滞留 1.25×TTL）', () => {
    const t = fakeTimers();
    const shortTtl = new PendingApprovalRegistry({ ttlMs: 4_000, setTimer: t.setTimer, clearTimer: t.clearTimer });
    shortTtl.startTimer();
    assert.equal(t.scheduled[0].handle.delayMs, 60_000, 'ttl/4=1s ⇒ 取下限 60s');

    const t2 = fakeTimers();
    const longTtl = new PendingApprovalRegistry({ ttlMs: 30 * 60_000, setTimer: t2.setTimer, clearTimer: t2.clearTimer });
    longTtl.startTimer();
    assert.equal(t2.scheduled[0].handle.delayMs, Math.floor((30 * 60_000) / 4), 'ttl/4=450s ⇒ 取 ttl/4');
  });

  test('显式间隔优先；非法间隔（0/负/NaN）回落到缺省公式', () => {
    const t = fakeTimers();
    const reg = new PendingApprovalRegistry({ ttlMs: 60_000, setTimer: t.setTimer, clearTimer: t.clearTimer });
    reg.startTimer(1234);
    assert.equal(t.scheduled[0].handle.delayMs, 1234);

    const t2 = fakeTimers();
    const reg2 = new PendingApprovalRegistry({ ttlMs: 8_000, setTimer: t2.setTimer, clearTimer: t2.clearTimer });
    reg2.startTimer(0);
    assert.equal(t2.scheduled[0].handle.delayMs, 60_000);
  });

  test('ttl=Infinity ⇒ 不挂表（未启用过期语义时空转无意义）', () => {
    const t = fakeTimers();
    const reg = new PendingApprovalRegistry({ ttlMs: 0, setTimer: t.setTimer, clearTimer: t.clearTimer });
    assert.equal(reg.startTimer(), undefined);
    assert.equal(t.scheduled.length, 0);
  });

  test('close()：clear 恰一次、句柄清空、isClosed=true', () => {
    const t = fakeTimers();
    const reg = new PendingApprovalRegistry({ ttlMs: 60_000, setTimer: t.setTimer, clearTimer: t.clearTimer });
    const handle = reg.startTimer();
    reg.close();
    assert.deepEqual(t.cleared, [handle]);
    assert.equal(reg.timerHandle, undefined, 'close 后不得残留定时器句柄（判据⑥）');
    assert.equal(reg.isClosed, true);
  });

  test('close() 幂等：二次 close 不重复 clear', () => {
    const t = fakeTimers();
    const reg = new PendingApprovalRegistry({ ttlMs: 60_000, setTimer: t.setTimer, clearTimer: t.clearTimer });
    reg.startTimer();
    reg.close();
    reg.close();
    assert.equal(t.cleared.length, 1);
  });

  test('close() 后 startTimer 不复活（判据⑥核心反例）', () => {
    const t = fakeTimers();
    const reg = new PendingApprovalRegistry({ ttlMs: 60_000, setTimer: t.setTimer, clearTimer: t.clearTimer });
    reg.startTimer();
    reg.close();
    assert.equal(reg.startTimer(), undefined);
    assert.equal(t.scheduled.length, 1, '关闭后再挂表 = 服务已停止仍在写链（收尾竞态取证污染）');
    assert.equal(reg.timerHandle, undefined);
  });

  test('close() 后已触发的自续链断链（无新表挂出）', () => {
    const t = fakeTimers();
    const reg = new PendingApprovalRegistry({ ttlMs: 1_000, setTimer: t.setTimer, clearTimer: t.clearTimer, now: () => 5_000 });
    reg.set('a', entry('a', 0));
    reg.startTimer(10);
    t.fire(0); // 第一轮触发 ⇒ 逐出 a，并自续挂第二轮
    assert.equal(t.scheduled.length, 2);
    reg.close();
    t.fire(1); // 第二轮（若未被 close 拦住则不应存在；close 已 clear，但假定时器不自动停止 ⇒ 手动验证 close 后 arm 首道闸）
    assert.equal(t.scheduled.length, 2, 'close 后回调内自续必须被 closed 闸拦住，不再挂第三轮');
  });

  test('未 close 时自续：一轮触发后恰挂一轮（不叠加）', () => {
    const t = fakeTimers();
    const reg = new PendingApprovalRegistry({ ttlMs: 1_000, setTimer: t.setTimer, clearTimer: t.clearTimer, now: () => 5_000 });
    reg.startTimer(10);
    t.fire(0);
    t.fire(1);
    assert.equal(t.scheduled.length, 3, '自续链每轮恰一枚，不得堆积');
    assert.equal(reg.timerHandle, t.scheduled[2].handle);
  });
});

/* ===================================================================== */
describe('T4 判据⑥-4 清扫回调（装配层取证落点）与异常隔离', () => {
  test('有逐出条目才回调；回调收到 [key, entry]', () => {
    const t = fakeTimers();
    const seen = [];
    const reg = new PendingApprovalRegistry({ ttlMs: 1_000, setTimer: t.setTimer, clearTimer: t.clearTimer, now: () => 5_000 });
    reg.set('a', entry('a', 0));
    reg.set('b', entry('b', 4_990));
    reg.startTimer(10, (swept) => seen.push(swept));
    t.fire(0);
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].map(([k]) => k), ['a']);
  });

  test('无逐出 ⇒ 不回调（不制造空决策审计）', () => {
    const t = fakeTimers();
    let calls = 0;
    const reg = new PendingApprovalRegistry({ ttlMs: 1_000, setTimer: t.setTimer, clearTimer: t.clearTimer, now: () => 0 });
    reg.set('a', entry('a', 0));
    reg.startTimer(10, () => { calls += 1; });
    t.fire(0);
    assert.equal(calls, 0);
  });

  test('回调抛错 ⇒ 被吞并 warn，定时器链不断', () => {
    const t = fakeTimers();
    const warns = [];
    const reg = new PendingApprovalRegistry({
      ttlMs: 1_000,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
      now: () => 5_000,
      logger: { warn: (msg, meta) => warns.push({ msg, meta }) },
    });
    reg.set('a', entry('a', 0));
    reg.startTimer(10, () => { throw new Error('装配层取证炸了'); });
    assert.doesNotThrow(() => t.fire(0), '定时器回调内异常逃逸 = uncaughtException = 打挂服务');
    assert.ok(warns.some((w) => /清扫异常/.test(w.msg)));
    assert.equal(t.scheduled.length, 2, '异常不得打断自续链');
    // 条目仍已逐出（清扫在回调之前完成）
    assert.equal(reg.has('a'), false);
  });

  test('logger 缺席 ⇒ 全程 no-op 不抛', () => {
    const t = fakeTimers();
    const reg = new PendingApprovalRegistry({ ttlMs: 1_000, setTimer: t.setTimer, clearTimer: t.clearTimer, now: () => 5_000 });
    reg.set('a', entry('a', 0));
    reg.startTimer(10);
    assert.doesNotThrow(() => t.fire(0));
  });
});

/* ===================================================================== */
describe('T4 判据⑥-5 窄 Map 替身面（区 3「替换而非改造」的先决条件）', () => {
  test('get/set/delete/has/size/values/entries/keys/forEach/迭代器 全面可用', () => {
    const reg = new PendingApprovalRegistry({ ttlMs: 1_000 });
    reg.set('k1', entry('k1', 1));
    reg.set('k2', entry('k2', 2));
    assert.equal(reg.size, 2);
    assert.equal(reg.get('k1').createdAtMs, 1);
    assert.equal(reg.get('nope'), undefined);
    assert.equal(reg.has('k2'), true);
    assert.deepEqual([...reg.keys()], ['k1', 'k2']);
    assert.deepEqual([...reg.values()].map((e) => e.approvalId), ['k1', 'k2']);
    assert.deepEqual([...reg.entries()].map(([k]) => k), ['k1', 'k2']);
    assert.deepEqual([...reg].map(([k]) => k), ['k1', 'k2'], '[Symbol.iterator] 必须在场（Map 语义兼容）');
    const seen = [];
    reg.forEach((v, k, map) => {
      seen.push([k, v.approvalId]);
      assert.equal(typeof map.get, 'function', 'forEach 第三参须是只读 Map 视图');
    });
    assert.deepEqual(seen, [['k1', 'k1'], ['k2', 'k2']]);
    assert.equal(reg.delete('k1'), true);
    assert.equal(reg.delete('k1'), false);
    assert.equal(reg.size, 1);
  });

  test('可直接作 `ReadonlyMap<string, T>` 形参实参（collectApprovalFacts 的兼容性）', () => {
    // 用一段仅依赖 ReadonlyMap 面的消费函数验证结构兼容 —— 真实签名由 tsc 与
    // phase1-t4-assembly 的端到端探针共同守（此处只钉"窄面足够，不需扩面"）。
    const reg = new PendingApprovalRegistry({ ttlMs: 1_000, now: () => 5_000 });
    reg.set('a', entry('a', 0, false));
    const asReadonly = reg;
    const out = [];
    for (const [k, v] of asReadonly) {
      if (v.hostApproved !== true && v.createdAtMs + 1_000 < asReadonly.get(k).createdAtMs + 10_000) out.push(k);
    }
    assert.deepEqual(out, ['a']);
  });

  test('close() 后 set/get 仍可用（收尾竞态不得吞数据）', () => {
    const reg = new PendingApprovalRegistry({ ttlMs: 1_000 });
    reg.close();
    reg.set('late', entry('late', 1));
    assert.equal(reg.get('late').createdAtMs, 1);
  });

  test('ttl getter 不回吐配置来源（不泄露 env 变量名）', () => {
    const reg = new PendingApprovalRegistry({ ttlMs: 1234 });
    assert.equal(reg.ttl, 1234);
    assert.doesNotMatch(JSON.stringify(Object.getOwnPropertyNames(Object.getPrototypeOf(reg))), /WINVM_/);
  });
});

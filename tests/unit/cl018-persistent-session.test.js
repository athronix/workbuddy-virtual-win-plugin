/**
 * CL-018 T02 · C1 codebuddy 常驻会话（PersistentCliSession）
 *
 * 覆盖关键分支（AC1.2/1.4/1.5/1.6）：
 *   - 就绪（首个 system/init）→ 单轮成功；
 *   - 串行链：多轮并发投喂按序执行、消息不交错；
 *   - **不可用 → 上报 `unavailable`**（调用方据此回退单次 `-p`，降级不破功能）；
 *   - 崩溃重建：一轮内**至多重建 1 次**并重试，`restarts` 计数正确；
 *   - 超重建上限 → `disabled`（此后恒回退），且不再 spawn；
 *   - 空闲 TTL 到期 → 软释放（state='stopped'）；
 *   - shutdown → 硬关闭（此后 `runTurn` 恒 unavailable）。
 *   - C1 修复回归锁（QA 探针 A/B 实锤）：init 是懒事件 —— ①首条消息先于 init 等待写出；
 *     ②init 在消息后异步到达 → 正常 ready；③消息已写出但 init 超预算 → 有界降级、spawn 不翻倍。
 *   - QA Round 2 状态机一致性：树杀（cmd 包装 pid 连树终结）+ stale 事件门卫（孤儿事件不驱动状态机）。
 *
 * 不依赖真实 codebuddy CLI：注入 FakeChild（事件驱动）+ 可控时钟。
 */

import { EventEmitter } from 'node:events';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  PersistentCliSession,
  buildUserMessageFrame,
  extractAssistantText,
  isInitEvent,
  renderPersistentArgs,
} from '@winvm/adapter-agent-workbuddy-llm';

/** 假子进程：实现 PersistentCliSession 用到的 CliChild 最小形状 */
class FakeChild {
  constructor(pid, behavior) {
    this.pid = pid;
    this.exitCode = null;
    this.killed = false;
    this.out = new EventEmitter();
    this.err = new EventEmitter();
    this.proc = new EventEmitter();
    this.frameIndex = 0;
    this.behavior = behavior;
    const self = this;
    this.stdout = { on: (e, l) => self.out.on(e, l) };
    this.stderr = { on: (e, l) => self.err.on(e, l) };
    this.stdin = {
      write: (chunk) => {
        self._onWrite(chunk);
        return true;
      },
      end: () => self._finish(0),
    };
  }

  on(e, l) {
    this.proc.on(e, l);
    return this;
  }

  kill() {
    this.killed = true;
    this._finish(0);
  }

  emitEv(ev) {
    this.out.emit('data', JSON.stringify(ev) + '\n');
  }

  _finish(code) {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.proc.emit('exit', code);
  }

  _onWrite(chunk) {
    const index = this.frameIndex++;
    this.behavior({
      index,
      childNo: this.pid - 1000,
      chunk,
      emit: (ev) => this.emitEv(ev),
      exit: (code = 0) => this._finish(code),
    });
  }
}

/** 从 NDJSON 用户帧里取出提示词文本 */
function promptOf(chunk) {
  const ev = JSON.parse(String(chunk));
  return ev.message.content[0].text;
}

function makeSession(behavior, opts = {}) {
  const spawnCalls = [];
  const children = [];
  let clock = 1_000_000;
  const session = new PersistentCliSession({
    cliPath: 'codebuddy',
    outputDir: 'C:\\out',
    mcpConfigPath: 'C:\\out\\mcp.json',
    sessionId: 'test-session',
    idleTtlMs: opts.idleTtlMs ?? 10_000,
    readyTimeoutMs: opts.readyTimeoutMs ?? 500,
    warmupReadyMs: opts.warmupReadyMs ?? 500,
    maxRestarts: opts.maxRestarts ?? 5,
    maxWsBytes: 1_000_000_000,
    spawnFn: (args) => {
      spawnCalls.push(args);
      const child = new FakeChild(1000 + spawnCalls.length, behavior);
      children.push(child);
      // 就绪：默认在 spawn 完成后的下一个微任务发 system/init（handler 已挂接、execTurn 尚未
      // 开始 —— 模拟「已就绪」时序：真机 init 先于本轮 result，见 QA 探针 B：init +8.7s、
      // result +13.5s）；opts.initDelayMs 可延迟；opts.noInit 模拟「init 永不到来」（懒事件）。
      if (!opts.noInit) {
        const fire = () => {
          if (child.exitCode === null) child.emitEv({ type: 'system/init' });
        };
        const delay = opts.initDelayMs ?? 0;
        if (delay > 0) setTimeout(fire, delay);
        else queueMicrotask(fire);
      }
      return child;
    },
    ...(opts.treeKillFn ? { treeKillFn: opts.treeKillFn } : {}),
    now: () => clock,
    log: () => {},
  });
  return { session, spawnCalls, children, setClock: (v) => (clock = v) };
}

const SINK = { onStatus: () => {} };

describe('CL-018 C1 · PersistentCliSession', () => {
  test('就绪后单轮成功：返回 result 文本，state=ready', async () => {
    const { session } = makeSession(({ emit }) => {
      emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'thinking' }] } });
      emit({ type: 'result', subtype: 'success', result: 'done-A' });
    });
    try {
      const r = await session.runTurn('goal-A', SINK, 5000);
      assert.equal(r.ok, true);
      assert.equal(r.text, 'done-A');
      assert.equal(r.unavailable, undefined);
      assert.equal(session.sessionState, 'ready');
    } finally {
      await session.shutdown();
    }
  });

  test('串行链：并发两轮按序执行、消息不交错', async () => {
    const order = [];
    const { session } = makeSession(({ chunk, emit }) => {
      const p = promptOf(chunk);
      order.push(p);
      // 异步应答，制造交叠窗口（若无串行链会交错）
      setTimeout(() => emit({ type: 'result', subtype: 'success', result: `ok:${p}` }), 10);
    });
    try {
      const [r1, r2] = await Promise.all([
        session.runTurn('goal-0', SINK, 5000),
        session.runTurn('goal-1', SINK, 5000),
      ]);
      assert.deepEqual(order, ['goal-0', 'goal-1']);
      assert.equal(r1.text, 'ok:goal-0');
      assert.equal(r2.text, 'ok:goal-1');
    } finally {
      await session.shutdown();
    }
  });

  test('不可用上报：进程中途退出 → unavailable=true（供回退单次 -p）', async () => {
    const { session, spawnCalls } = makeSession(({ exit }) => exit(1));
    try {
      const r = await session.runTurn('goal-x', SINK, 5000);
      assert.equal(r.unavailable, true);
      assert.equal(r.ok, false);
      // 初次 spawn + 重建 1 次 = 2（重建上限内），且均失败
      assert.equal(spawnCalls.length, 2);
      assert.equal(session.restarts, 1);
    } finally {
      await session.shutdown();
    }
  });

  test('崩溃重建：首个子进程退出后重建并重试本轮成功（restarts=1）', async () => {
    const { session, spawnCalls } = makeSession(({ childNo, emit, exit }) => {
      if (childNo === 1) {
        exit(1);
        return;
      }
      emit({ type: 'result', subtype: 'success', result: 'rebuilt-ok' });
    });
    try {
      const r = await session.runTurn('goal-rebuild', SINK, 5000);
      assert.equal(r.ok, true);
      assert.equal(r.text, 'rebuilt-ok');
      assert.equal(spawnCalls.length, 2);
      assert.equal(session.restarts, 1);
      assert.equal(session.sessionState, 'ready');
    } finally {
      await session.shutdown();
    }
  });

  test('超重建上限：maxRestarts=0 → disabled，且不 spawn', async () => {
    const { session, spawnCalls } = makeSession(() => {}, { maxRestarts: 0 });
    try {
      const r = await session.runTurn('goal-disabled', SINK, 5000);
      assert.equal(r.unavailable, true);
      assert.equal(session.sessionState, 'disabled');
      assert.equal(spawnCalls.length, 0);
    } finally {
      await session.shutdown();
    }
  });

  test('空闲 TTL 到期 → 软释放（state=stopped，可再次重建）', async () => {
    const { session, setClock } = makeSession(({ emit }) => {
      emit({ type: 'result', subtype: 'success', result: 'ok' });
    });
    try {
      await session.runTurn('goal-idle', SINK, 5000);
      assert.equal(session.sessionState, 'ready');
      setClock(1_000_000 + 10_001); // 超过 idleTtl
      session.tick();
      assert.equal(session.sessionState, 'stopped');
    } finally {
      await session.shutdown();
    }
  });

  test('shutdown → 硬关闭：此后 runTurn 恒 unavailable 且 state=disabled', async () => {
    const { session } = makeSession(({ emit }) => {
      emit({ type: 'result', subtype: 'success', result: 'ok' });
    });
    await session.shutdown();
    const r = await session.runTurn('goal-after-shutdown', SINK, 5000);
    assert.equal(r.unavailable, true);
    assert.equal(session.sessionState, 'disabled');
  });

  test('R2 · 就绪纳入本轮预算：timeoutMs=5s 短于就绪上限(60s) + 就绪永不完成 → 有界返回且降级', async () => {
    // 上界 = min(readyTimeoutMs=60s, timeoutMs=5s) = 5s；就绪（init）永不完成 → 应在 5s 量级按
    // 「不可用」返回，由上层走**既有降级路径**（单次 -p），而非静默失败。
    // C1 修复后语义：该 5s 花在「首条消息**已写出**之后的 init 有界等待」上（execTurn 内），
    // 不再是旧实现「没写消息就干等 init」的死锁路径（对齐 QA 探针 A/B 证据）。
    const { session, spawnCalls } = makeSession(() => {}, {
      readyTimeoutMs: 60_000,
      noInit: true,
    });
    try {
      const t0 = Date.now();
      const r = await session.runTurn('goal-budget', SINK, 5_000);
      const elapsed = Date.now() - t0;
      assert.equal(r.unavailable, true, '超预算须上报 unavailable（供上层回退单次 -p）');
      assert.equal(r.ok, false);
      assert.ok(elapsed >= 4_000 && elapsed < 15_000, `应受本轮预算约束有界返回（实测 ${elapsed}ms）`);
      assert.ok(elapsed < 60_000, '返回必须早于就绪上限 60s（证明由预算而非 readyTimeout 兜底）');
      assert.equal(spawnCalls.length, 1, '首次就绪即失败 → 不进入重建');
      assert.equal(session.restarts, 0);
    } finally {
      await session.shutdown();
    }
  });

  test('R2 · 就绪纳入本轮预算：timeoutMs=120s 充足 + 就绪正常完成 → 不降级、正常执行', async () => {
    // 预算(120s) ≥ 就绪上限(60s) → 上界仍为 60s，等价原行为；就绪正常完成 → 不得降级。
    // （就绪耗时按比例缩小以加速单测，语义关系「预算 ≫ 就绪耗时」不变。）
    // C1 修复后时序对齐：真机 init 先于本轮 result（QA 探针 B：init +8.7s、result +13.5s），
    // 故 result 延迟到 init(100ms) 之后(150ms)发出 —— 旧版「result 同步于写消息」会先于异步
    // init 完成，与新时序语义冲突，按 QA S1 证据修订。
    const { session } = makeSession(
      ({ emit }) => setTimeout(() => emit({ type: 'result', subtype: 'success', result: 'budget-ok' }), 150),
      { readyTimeoutMs: 60_000, initDelayMs: 100 },
    );
    try {
      const r = await session.runTurn('goal-budget-ok', SINK, 120_000);
      assert.equal(r.ok, true);
      assert.equal(r.text, 'budget-ok');
      assert.equal(r.unavailable, undefined, '预算充足时不得降级');
      assert.equal(session.sessionState, 'ready');
    } finally {
      await session.shutdown();
    }
  });

  /* ---------------------- C1 修复回归锁（QA 探针 A/B 实锤） ---------------------- */

  test('C1 修复①死锁回归锁：init 是懒事件（由首条消息触发）→ 先写消息再等 init，不降级', async () => {
    // 懒事件模型（QA 探针 A/B）：spawn 后不写 stdin 则 init 永不到来；init 只在首条用户消息
    // 之后发出。旧实现「spawn → 先等 init → 再写消息」在此模型下死锁 60s + killChild + 降级；
    // 修复后必须先写出消息、init 才可能被触发。
    const writes = [];
    let initEmitted = false;
    const { session, spawnCalls } = makeSession(
      ({ chunk, emit }) => {
        writes.push(promptOf(chunk));
        if (!initEmitted) {
          initEmitted = true;
          emit({ type: 'system/init' }); // 懒事件：init 在收到首条消息后才发
        }
        emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'progress' }] } });
        emit({ type: 'result', subtype: 'success', result: 'lazy-ok' });
      },
      { noInit: true }, // spawn 时不主动发 init —— 完全模拟懒事件（旧实现在此死锁）
    );
    try {
      const r = await session.runTurn('goal-lazy', SINK, 5000);
      assert.equal(r.ok, true);
      assert.equal(r.text, 'lazy-ok');
      assert.equal(r.unavailable, undefined, '懒 init 不得触发降级（旧实现此处必降级）');
      assert.equal(initEmitted, true, 'init 由首条消息触发（懒事件）');
      assert.ok(writes.length >= 1 && writes[0] === 'goal-lazy', 'init 到来前必须已写出首条用户消息');
      assert.equal(spawnCalls.length, 1, '不得因就绪问题重复 spawn');
      assert.equal(session.restarts, 0);
      assert.equal(session.sessionState, 'ready');
    } finally {
      await session.shutdown();
    }
  });

  test('C1 修复②懒 init 异步到达：init 在首条消息写出后才到 → 正常 ready 并返回本轮结果', async () => {
    // QA 探针 B 实测时序（等比缩小）：消息后 ~7ms init、~14ms result（真机 +6.7s / +13.5s）。
    // init 在消息之后异步到达，会话应转入 ready 并正常拿到本轮 result（无 60s 空等、无降级）。
    const { session, spawnCalls } = makeSession(
      ({ chunk, emit }) => {
        const p = promptOf(chunk);
        setTimeout(() => emit({ type: 'system/init' }), 7);
        setTimeout(() => emit({ type: 'result', subtype: 'success', result: `ok:${p}` }), 14);
      },
      { noInit: true, readyTimeoutMs: 2000 },
    );
    try {
      const r = await session.runTurn('goal-after-msg', SINK, 5000);
      assert.equal(r.ok, true);
      assert.equal(r.text, 'ok:goal-after-msg');
      assert.equal(r.unavailable, undefined);
      assert.equal(session.sessionState, 'ready');
      assert.equal(spawnCalls.length, 1);
      assert.equal(session.restarts, 0);
    } finally {
      await session.shutdown();
    }
  });

  test('C1 修复③有界降级：首条消息已写出但 init 超预算 → unavailable + 杀子进程 + spawn 不翻倍', async () => {
    // 与 R2 预算①同一预算语义，但额外断言「新路径」特征：消息已写出、子进程被杀（既有降级
    // 语义不变）、spawn 计数不翻倍 —— 区别于旧实现「没写消息就等 init」的死锁路径。
    const writes = [];
    const { session, spawnCalls, children } = makeSession(
      ({ chunk }) => {
        writes.push(promptOf(chunk)); // 收到消息但不回 init（init 永不到来，模拟探针 A）
      },
      { noInit: true, readyTimeoutMs: 60_000 },
    );
    try {
      const t0 = Date.now();
      const r = await session.runTurn('goal-budget-c1', SINK, 5_000);
      const elapsed = Date.now() - t0;
      assert.equal(r.unavailable, true, 'init 超预算须上报 unavailable（供上层回退单次 -p）');
      assert.equal(r.ok, false);
      assert.ok(String(r.error ?? '').includes('system/init'), `错误须指明 init 未到（实测：${r.error}）`);
      assert.equal(writes.length, 1, '首条用户消息必须已写出（新时序的铁证）');
      assert.ok(elapsed >= 4_000 && elapsed < 15_000, `有界返回（实测 ${elapsed}ms）`);
      assert.equal(children.length, 1);
      assert.equal(children[0].killed, true, 'init 超预算须走既有降级语义：杀常驻子进程');
      // init 超时置 degraded 并杀子进程；子进程被终结后按 D11「观测缺陷修复」把仍驻留的
      // degraded 归一为 stopped（/health.llmSession.state 只反映当前、不留幻象降级，历史原因存
      // lastError）；runTurn 对 init 超时**不进入同轮重建**（对齐 R2 语义「就绪失败即上报、不重建」）
      // → 终态 stopped、spawn 计数不翻倍。（陈旧单测修正：原断言 degraded。）
      assert.equal(session.sessionState, 'stopped');
      assert.equal(spawnCalls.length, 1, 'spawn 计数不得翻倍');
      assert.equal(session.restarts, 0);
    } finally {
      await session.shutdown();
    }
  });

  /* ------------------ QA Round 2 · 状态机一致性（树杀 + stale 事件门卫） ------------------ */

  test('QA2·树杀：killChild 以注入的 treeKillFn 终结整棵进程树并清理 child 引用', async () => {
    // 常驻 CLI 经 cmd.exe 包装启动，仅 child.kill() 只杀包装进程、node 孙进程孤儿化；
    // killChild 须以 cmd 包装进程 pid 调树杀（生产默认 taskkill /PID <pid> /T /F）。
    const treeKillCalls = [];
    const { session, children } = makeSession(
      ({ emit }) => emit({ type: 'result', subtype: 'success', result: 'ok' }),
      { treeKillFn: (pid) => treeKillCalls.push(pid) },
    );
    try {
      await session.runTurn('goal-treekill', SINK, 5000);
      assert.equal(session.sessionState, 'ready');
      const pid = children[0].pid;
      await session.dispose(); // 软释放 → killChild
      assert.deepEqual(treeKillCalls, [pid], '树杀须以 cmd 包装进程 pid 恰好调用一次');
      assert.equal(session.snapshot().pid, undefined, 'child/pid 引用须已清理');
      assert.equal(children[0].killed, true, '既有 kill() 兜底不变');
    } finally {
      await session.shutdown();
    }
  });

  test('QA2·stale 事件门卫：旧 child（孤儿）发 init/result 不得驱动状态机回 ready', async () => {
    // QA 实测复现：killChild 后孤儿 node 孙进程迟到的 system/init 曾把状态机置回
    // 「无子进程却 ready」的不一致态。回归锁：child 引用替换/清空后，旧 child 的任何事件被忽略。
    const { session, children } = makeSession(
      ({ emit }) => emit({ type: 'result', subtype: 'success', result: 'ok' }),
    );
    try {
      await session.runTurn('goal-stale', SINK, 5000);
      assert.equal(session.sessionState, 'ready');
      await session.dispose(); // 软释放：child 引用清空（state='stopped'）
      assert.equal(session.sessionState, 'stopped');
      const stale = children[0];
      stale.emitEv({ type: 'system/init' }); // 孤儿迟到的 init（不一致态来源）
      stale.emitEv({ type: 'result', subtype: 'success', result: 'stale-result' });
      assert.notEqual(session.sessionState, 'ready', 'stale init 不得把状态机置回 ready');
      assert.equal(session.sessionState, 'stopped');
      assert.equal(session.snapshot().pid, undefined, '不得出现「无子进程却 ready」');
      assert.equal(session.restarts, 0);
      // 门卫不得误伤正常路径：释放后可正常重建
      const r = await session.runTurn('goal-after-stale', SINK, 5000);
      assert.equal(r.ok, true);
      assert.equal(session.sessionState, 'ready');
    } finally {
      await session.shutdown();
    }
  });

  test('K2 warmup：写出首条消息 + 等 init + 消费 result → 返回 true、state=ready、仅 spawn 一次', async () => {
    let written;
    const { session, spawnCalls, children } = makeSession(({ chunk, emit }) => {
      written = chunk;
      emit({ type: 'system/init' });
      emit({ type: 'result', result: 'OK', is_error: false });
    }, { noInit: true, warmupReadyMs: 1000 });
    const ok = await session.warmup('Please reply OK');
    assert.equal(ok, true, '预热达成应返回 true');
    assert.equal(session.sessionState, 'ready', '预热后 state 应为 ready');
    assert.equal(spawnCalls.length, 1, '应仅 spawn 一次');
    assert.equal(promptOf(written), 'Please reply OK', '首条写出消息应为预热目标');
  });

  test('K2 warmup：init 超时**不杀会话**（state 保持 starting、child 存活、不写 lastError）', async () => {
    const { session, children } = makeSession(() => {}, { noInit: true, warmupReadyMs: 200 });
    const ok = await session.warmup('Please reply OK');
    assert.equal(ok, false, 'init 超时预热应返回 false');
    assert.equal(children[0].killed, false, '预热超时**不得**杀会话');
    assert.equal(session.sessionState, 'starting', '会话应保持 starting（未被降级/停止）');
    assert.equal(session.snapshot().lastError, undefined, '预热超时不得写 lastError（避免 /health 伪失败）');
  });

  test('K2 warmup：已 ready 时直接返回 true 且不重复 spawn（幂等）', async () => {
    const { session, spawnCalls } = makeSession(({ emit }) => {
      emit({ type: 'system/init' });
      emit({ type: 'result', result: 'OK', is_error: false });
    }, { warmupReadyMs: 1000 });
    assert.equal(await session.warmup('x'), true);
    assert.equal(await session.warmup('x'), true, '已 ready 应直接 true');
    assert.equal(spawnCalls.length, 1, '不应重复 spawn');
  });

  test('K2 warmup：disabled 时返回 false 且不 spawn', async () => {
    const { session, spawnCalls } = makeSession(({ emit }) => {
      emit({ type: 'system/init' });
      emit({ type: 'result', result: 'OK', is_error: false });
    }, { warmupReadyMs: 1000 });
    await session.shutdown();
    assert.equal(await session.warmup('x'), false);
    assert.equal(spawnCalls.length, 0);
  });

  test('纯函数：参数渲染 / 用户帧 / init 判定 / assistant 文本抽取', () => {
    const args = renderPersistentArgs({ sessionId: 'sid', output: 'C:\\o', mcpConfig: 'C:\\o\\mcp.json' });
    assert.ok(args.includes('--input-format'));
    assert.ok(args.includes('stream-json'));
    assert.ok(args.includes('--strict-mcp-config'));
    assert.ok(args.includes('sid'));

    const frame = buildUserMessageFrame('hello');
    assert.ok(frame.endsWith('\n'));
    assert.equal(JSON.parse(frame).message.content[0].text, 'hello');

    assert.equal(isInitEvent({ type: 'system/init' }), true);
    assert.equal(isInitEvent({ type: 'system', subtype: 'init' }), true);
    assert.equal(isInitEvent({ type: 'result' }), false);

    assert.equal(
      extractAssistantText({ message: { content: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }] } }),
      'A\nB',
    );
  });
});

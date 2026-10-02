/**
 * R19c T05 · K-N1 委派层审计真实性 —— **C 组：PersistentCliSession L1 复位与故障注入**（设计 §9-C，T04）
 *
 * 钉死的行为契约：
 *   C-1 `restartFresh()`：disabled → stopped；`spawnAttempts` 归零 ⇒ `snapshot().restarts === 0`；
 *       **`lastError` / `lastErrorAt` 保留**（D11 两信号分离纪律）；子进程恰一次 kill；空闲定时器复挂。
 *   C-2 `spawnFault` 注入：连续 ensureReady 失败计数递增 → 达 `maxRestarts` 后走**既有** disabled
 *       路径（确定性，不依赖真机抖动）；**不带注入 → 行为与 HEAD 逐字一致**（构造参数可选回归）。
 *   C-3 `restartFresh()` 后一次 `ensureReady` 成功 spawn（计数重新 0→1）。
 *
 * ⚠ 既有坑（团队长交代，已在本文件规避）：`tests/unit/cl018-persistent-session.test.js` 的
 *   `makeSession` 在 spawn 后 `queueMicrotask` 发 init，会**抢先于**被测方法 —— 测「spawn → 写消息
 *   → 等 init」全链路必须自驱 init。本文件的夹具默认 `initMode:'none'`（测试自己发 init），
 *   只有需要「已就绪」时序的断言才用 `initMode:'auto'`。
 *
 * 不依赖真实 codebuddy CLI / HTTP 服务：注入 FakeChild（事件驱动 + kill 计数）+ 可控时钟。
 */

import { EventEmitter } from 'node:events';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { PersistentCliSession } from '@winvm/adapter-agent-workbuddy-llm';

/* ============================ 夹具 ============================ */

const SINK = { onStatus: () => {} };

/**
 * 假子进程：kill / stdin.end 计数外泄，供「恰一次」断言。
 * @param {(ctx:{emit:(ev:unknown)=>void, exit:(code:number)=>void, chunk:string, index:number})=>void} behavior
 */
class FakeChild {
  constructor(pid, behavior) {
    this.pid = pid;
    this.exitCode = null;
    this.killCount = 0;
    this.endCount = 0;
    this.out = new EventEmitter();
    this.err = new EventEmitter();
    this.proc = new EventEmitter();
    this.frameIndex = 0;
    this.behavior = behavior ?? (() => {});
    const self = this;
    this.stdout = { on: (e, l) => self.out.on(e, l) };
    this.stderr = { on: (e, l) => self.err.on(e, l) };
    this.stdin = {
      write: (chunk) => {
        self._onWrite(chunk);
        return true;
      },
      end: () => {
        self.endCount += 1;
        self._finish(0);
      },
    };
  }

  on(e, l) {
    this.proc.on(e, l);
    return this;
  }

  kill() {
    this.killCount += 1;
    this._finish(0);
    return true;
  }

  emitEv(ev) {
    this.out.emit('data', `${JSON.stringify(ev)}\n`);
  }

  _finish(code) {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.proc.emit('exit', code);
  }

  _onWrite(chunk) {
    const index = this.frameIndex++;
    this.behavior({ index, chunk, emit: (ev) => this.emitEv(ev), exit: (c = 0) => this._finish(c) });
  }
}

/**
 * @param {{initMode?:'none'|'auto', spawnFault?:boolean, maxRestarts?:number,
 *          readyTimeoutMs?:number, idleTtlMs?:number, behavior?:Function,
 *          spawnThrows?:boolean, treeKillSpy?:(pid:number)=>void, warmupReadyMs?:number}} opts
 */
function makeSession(opts = {}) {
  const spawnCalls = [];
  const children = [];
  const logs = [];
  let clock = 1_000_000;

  const session = new PersistentCliSession({
    cliPath: 'codebuddy',
    outputDir: 'C:\\out',
    mcpConfigPath: 'C:\\out\\mcp.json',
    sessionId: 'kn1-session',
    idleTtlMs: opts.idleTtlMs ?? 10_000,
    readyTimeoutMs: opts.readyTimeoutMs ?? 300,
    warmupReadyMs: opts.warmupReadyMs ?? 300,
    maxRestarts: opts.maxRestarts ?? 2,
    maxWsBytes: 1_000_000_000,
    spawnFn: (args) => {
      spawnCalls.push(args);
      if (opts.spawnThrows) throw new Error('spawn boom');
      const child = new FakeChild(2000 + spawnCalls.length, opts.behavior);
      children.push(child);
      // initMode='auto' 复刻 cl018 旧夹具时序（微任务发 init）；默认 'none' 由测试自驱
      if (opts.initMode === 'auto') {
        queueMicrotask(() => {
          if (child.exitCode === null) child.emitEv({ type: 'system/init' });
        });
      }
      return child;
    },
    ...(opts.treeKillSpy ? { treeKillFn: opts.treeKillSpy } : {}),
    ...(opts.spawnFault !== undefined ? { spawnFault: opts.spawnFault } : {}),
    now: () => clock,
    log: (m, meta) => logs.push([m, meta ?? {}]),
  });

  return {
    session,
    spawnCalls,
    children,
    logs,
    setClock: (v) => (clock = v),
    advance: (d) => (clock += d),
  };
}

/** 走完「spawn → 写消息 → 等 init → result」全链路的一轮（测试驱动 init，规避夹具抢跑） */
function turnBehavior(resultText = 'done') {
  return ({ emit, index }) => {
    if (index === 0) {
      emit({ type: 'system/init' });
      emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } });
      emit({ type: 'result', subtype: 'success', result: resultText });
    }
  };
}

/** 反复 ensureReady 直到 disabled（或达上限调用数），返回调用次数 */
async function driveToDisabled(f, limit = 30) {
  let n = 0;
  while (n < limit) {
    n += 1;
    await f.session.ensureReady();
    if (f.session.snapshot().state === 'disabled') return n;
  }
  return -1;
}

/* ============================ C-2 故障注入：确定性 disabled ============================ */

describe('K-N1 C-2 spawnFault 注入（确定性 disabled，走既有计数路径）', () => {
  test('注入位可读：构造 opts.spawnFault=true → spawnFaultInjected=true；缺省 → false（零影响）', () => {
    const on = makeSession({ spawnFault: true });
    assert.equal(on.session.spawnFaultInjected, true);
    const off = makeSession();
    assert.equal(off.session.spawnFaultInjected, false, '构造缺席即默认关闭（生产零影响）');
    assert.equal(off.session.setSpawnFault(true), true);
    assert.equal(off.session.spawnFaultInjected, true);
    assert.equal(off.session.setSpawnFault(false), false);
    assert.equal(off.session.setSpawnFault('truthy-not-true'), false, '只认真值 true（防误置位）');
  });

  test('注入后每次 spawn 立即错误退出：ensureReady 恒 false、子进程不留活口（kill+treeKill 各一次）', async () => {
    const treeKills = [];
    const f = makeSession({ spawnFault: true, treeKillSpy: (pid) => treeKills.push(pid) });
    const ok = await f.session.ensureReady();
    assert.equal(ok, false, '注入生效即视为启动失败（沿既有路径）');
    assert.equal(f.spawnCalls.length, 1);
    assert.equal(f.children[0].killCount, 1, '注入路径也必须终结真实子进程（不留孤儿）');
    assert.equal(f.children[0].endCount, 1);
    assert.equal(treeKills.length, 1, '树杀同样执行（cmd 包装进程一并终结）');
    const snap = f.session.snapshot();
    assert.equal(snap.state, 'degraded', 'faultExit 置 degraded（既有语义，不新增状态）');
    assert.match(snap.lastError, /spawnFault 注入/);
    assert.ok(snap.lastErrorAt, 'lastError/lastErrorAt 成对写入（D11）');
  });

  test('计数递增并达 maxRestarts → disabled：lastError 换成「已超重建上限」文案（既有 disabled 路径被确定性触发）', async () => {
    const f = makeSession({ spawnFault: true, maxRestarts: 2 });
    const calls = await driveToDisabled(f);
    assert.ok(calls > 0, '必须在有限次调用内进入 disabled（不依赖真机抖动）');
    assert.equal(calls, 4, 'spawn 3 次（首次 + 重建 2 次）后第 4 次判定超限 —— 计数路径可预期');
    const snap = f.session.snapshot();
    assert.equal(snap.state, 'disabled');
    assert.match(snap.lastError, /已超重建上限（2），此后回退单次 -p/, '文案与既有实现逐字一致');
    assert.equal(f.logs.some(([m]) => m === 'LLM 常驻会话已停用'), true, '停用必须留日志（禁止静默）');

    // disabled 后不再 spawn（恒定回退），且 ensureReady 直接 false
    const before = f.spawnCalls.length;
    assert.equal(await f.session.ensureReady(), false);
    assert.equal(f.spawnCalls.length, before, 'disabled 后绝不重复 spawn');
  });

  test('disabled 态 runTurn → unavailable（上层据此走单次 -p），错误原因取 lastError', async () => {
    const f = makeSession({ spawnFault: true, maxRestarts: 1 });
    await driveToDisabled(f);
    const r = await f.session.runTurn('goal', SINK, 5_000);
    assert.equal(r.unavailable, true);
    assert.equal(r.ok, false);
    assert.match(String(r.error), /已超重建上限|spawnFault 注入/);
  });

  test('无注入 → 行为与 HEAD 逐字一致：spawn 成功即 starting、init 到达即 ready、轮次成功', async () => {
    const f = makeSession({ behavior: turnBehavior('ok-A') });
    const ok = await f.session.ensureReady();
    assert.equal(ok, true);
    assert.equal(f.session.snapshot().state, 'starting', 'spawn 即返回，init 是懒事件（C1 时序铁律不被注入改动）');
    assert.equal(f.children[0].killCount, 0, '无注入绝不提前杀进程');
    const r = await f.session.runTurn('goal-A', SINK, 5_000);
    assert.equal(r.ok, true);
    assert.equal(r.text, 'ok-A');
    assert.equal(r.unavailable, undefined);
    assert.equal(f.session.snapshot().state, 'ready');
    assert.equal(f.session.snapshot().lastError, undefined, '无故障不得留伪失败');
  });

  test('构造参数可选性回归：不传 spawnFault 时 spawnFaultInjected=false 且状态机与既有 CL-018 断言一致（崩溃重建 ≤1 次）', async () => {
    // 首个 spawn 成功后由 behavior 主动退出 → 走既有「同轮重建一次」路径（与 cl018 既有断言同形）
    const f = makeSession({
      maxRestarts: 5,
      behavior: ({ emit, exit, index, child }) => {
        if (index === 0) {
          emit({ type: 'system/init' });
          exit(3); // 首轮进行中崩溃
        }
      },
    });
    const r = await f.session.runTurn('goal-crash', SINK, 5_000);
    assert.equal(r.unavailable, true, '崩溃后重建轮仍无 result → 按不可用上报（既有语义）');
    assert.ok(f.spawnCalls.length <= 3, `至多重建 1 次（实际 spawn ${f.spawnCalls.length} 次）`);
    assert.equal(f.session.spawnFaultInjected, false);
  });
});

/* ============================ C-1 restartFresh ============================ */

describe('K-N1 C-1 restartFresh（L1 运维复位）', () => {
  test('disabled → stopped；restarts 归零；**lastError/lastErrorAt 保留**（D11 两信号分离）', async () => {
    const f = makeSession({ spawnFault: true, maxRestarts: 1 });
    await driveToDisabled(f);
    const before = f.session.snapshot();
    assert.equal(before.state, 'disabled');
    assert.ok(before.lastError && before.lastErrorAt);

    const after = f.session.restartFresh();
    assert.equal(after.state, 'stopped', '复位解除「当前不可用」');
    assert.equal(after.restarts, 0, 'spawnAttempts 归零 ⇒ restarts getter 自动回 0（累计制解开）');
    assert.equal(after.lastError, before.lastError, '「历史上失败过」抹不掉（运维据此判断复位前状态）');
    assert.equal(after.lastErrorAt, before.lastErrorAt);
    assert.equal(after.pid, undefined, '无子进程不得残留 pid');
    assert.equal(after.state !== 'disabled', true);
  });

  test('复位清除故障注入位（否则复位后依旧必败，运维动作失去意义）', async () => {
    const f = makeSession({ spawnFault: true, maxRestarts: 2 });
    await driveToDisabled(f);
    assert.equal(f.session.spawnFaultInjected, true);
    f.session.restartFresh();
    assert.equal(f.session.spawnFaultInjected, false, 'reset 不带 faultInjection → 清除注入（§6.2）');
    assert.equal(f.logs.some(([m]) => /已复位/.test(m)), true, '复位动作留痕（运维面日志，不入哈希链）');
  });

  test('确有子进程时复位 → 恰一次 kill + 一次 stdin.end + 一次树杀；无子进程时零 kill', async () => {
    const treeKills = [];
    const f = makeSession({ treeKillSpy: (pid) => treeKills.push(pid) });
    // 无子进程：幂等复位，绝不误杀
    const snap0 = f.session.restartFresh();
    assert.equal(snap0.state, 'stopped');
    assert.equal(treeKills.length, 0);
    assert.equal(f.spawnCalls.length, 0);

    // 有子进程：一次到位
    assert.equal(await f.session.ensureReady(), true);
    const child = f.children[0];
    assert.equal(child.killCount, 0, '复位前进程健在');
    const after = f.session.restartFresh();
    assert.equal(after.restarts, 0);
    assert.equal(after.state, 'stopped');
    assert.equal(child.killCount, 1, 'dispose 子进程恰一次 kill（不得重复终结）');
    assert.equal(child.endCount, 1);
    assert.equal(treeKills.length, 1);
    assert.equal(f.children.length, 1, '复位不新建进程');
    // 再次复位（此刻已无子进程）→ 不重复 kill
    f.session.restartFresh();
    assert.equal(child.killCount, 1, '第二次复位不重复终结');
  });

  test('非 disabled 态调用同样复位计数、不报错（端点 §6.1 幂等语义）', async () => {
    const f = makeSession({ behavior: turnBehavior('x') });
    await f.session.ensureReady();
    const a = f.session.restartFresh();
    const b = f.session.restartFresh();
    assert.deepEqual(a.state, 'stopped');
    assert.deepEqual(b.state, 'stopped');
    assert.equal(b.restarts, 0);
    assert.equal(f.spawnCalls.length, 1, '幂等复位不重复 spawn');
  });

  test('硬关闭（shutdown → disabled + disposed）后复位可再次工作，并复挂空闲回收', async () => {
    const f = makeSession({ behavior: turnBehavior('y'), idleTtlMs: 1000 });
    await f.session.ensureReady();
    await f.session.shutdown();
    assert.equal(f.session.snapshot().state, 'disabled');
    assert.equal((await f.session.runTurn('g', SINK, 200)).unavailable, true, 'shutdown 后恒不可用');

    const after = f.session.restartFresh();
    assert.equal(after.state, 'stopped');
    assert.equal(after.restarts, 0);
    assert.equal(await f.session.ensureReady(), true, 'shutdown 清除 disposed 位后重建可用');

    // 复位后空闲回收必须仍在（shutdown 清过定时器）：预热置 lastUsedMs → 推进时钟 → tick 软释放
    assert.equal(await f.session.warmup('OK?', 2_000), true);
    const child = f.children[f.children.length - 1];
    f.advance(60_000);
    f.session.tick();
    assert.equal(f.session.snapshot().state, 'stopped', '空闲 TTL 到期软释放（定时器复挂生效）');
    assert.equal(child.killCount >= 1, true);
  });

  test('复位后状态机从头开始：disabled 前需再次走满 maxRestarts 次重建（不残留旧计数）', async () => {
    const f = makeSession({ spawnFault: false, maxRestarts: 2 });
    // 用「init 永不到来 + 有界超时」复刻既有 degraded 累积路径
    f.session.setSpawnFault(true);
    const n1 = await driveToDisabled(f);
    assert.ok(n1 > 0);
    f.session.restartFresh();
    assert.equal(f.session.snapshot().state, 'stopped');
    f.session.setSpawnFault(true);
    const n2 = await driveToDisabled(f);
    assert.equal(n2, n1, '复位后进入 disabled 所需调用数与首次一致（计数未残留）');
  });
});

/* ============================ C-3 复位后重建 ============================ */

describe('K-N1 C-3 restartFresh 后一次 ensureReady 成功 spawn（计数 0→1）', () => {
  test('disabled → restartFresh → ensureReady=true，spawnAttempts 由 0→1（restarts 仍为 0）', async () => {
    const f = makeSession({ spawnFault: true, maxRestarts: 1, behavior: turnBehavior('fresh-ok') });
    await driveToDisabled(f);
    const spawnsBefore = f.spawnCalls.length;
    f.session.restartFresh();
    assert.equal(f.session.snapshot().restarts, 0);

    const ok = await f.session.ensureReady();
    assert.equal(ok, true, '复位后必须能重新拉起（否则端点形同虚设）');
    assert.equal(f.spawnCalls.length, spawnsBefore + 1);
    assert.equal(f.session.snapshot().restarts, 0, '首次 spawn 不计入 restarts（restarts=spawnAttempts-1）');
    assert.equal(f.session.snapshot().state, 'starting');

    const r = await f.session.runTurn('goal-fresh', SINK, 5_000);
    assert.equal(r.ok, true);
    assert.equal(r.text, 'fresh-ok', '复位后的会话功能完好');
    assert.equal(f.session.snapshot().state, 'ready');
    assert.equal(f.session.snapshot().lastError, undefined, '一次成功 init 清空历史失败（D11 自愈）');
  });

  test('复位后带 faultInjection 再次注入（同一端点 ?faultInjection=1）→ 又确定性 disabled', async () => {
    const f = makeSession({ maxRestarts: 1 });
    f.session.setSpawnFault(true);
    await driveToDisabled(f);
    f.session.restartFresh();
    f.session.setSpawnFault(true);
    const n = await driveToDisabled(f);
    assert.ok(n > 0);
    assert.equal(f.session.snapshot().state, 'disabled');
  });

  test('disabled 期间 provider 侧观测口径：snapshot 恒 disabled（供 D 组入口拒绝判定消费）', async () => {
    const f = makeSession({ spawnFault: true, maxRestarts: 1 });
    await driveToDisabled(f);
    const s1 = f.session.snapshot();
    const s2 = f.session.snapshot();
    assert.equal(s1.state, 'disabled');
    assert.equal(s2.state, 'disabled', '观测不得把 disabled 洗白成 stopped');
    assert.equal(s1.lastErrorAt, s2.lastErrorAt, '快照字段稳定（无副作用写入）');
  });
});

/* ============================ 附带：warmup 与注入互不干扰 ============================ */

describe('K-N1 C 附：既有预热/串行语义在注入位存在时零回归', () => {
  test('无注入 warmup 成功（init + result 消费）→ ready；注入态 warmup 直接 false（不隐藏故障）', async () => {
    const f = makeSession({ behavior: turnBehavior('OK') });
    assert.equal(await f.session.warmup('OK?', 2_000), true);
    assert.equal(f.session.snapshot().state, 'ready');

    const g = makeSession({ spawnFault: true });
    assert.equal(await g.session.warmup('OK?', 2_000), false);
    assert.equal(g.session.snapshot().state, 'degraded');
  });

  test('restartFresh 不吞在串行链上：复位后新一轮仍按序执行（消息不交错）', async () => {
    const texts = [];
    const f = makeSession({
      behavior: ({ emit, chunk }) => {
        const prompt = JSON.parse(String(chunk)).message.content[0].text;
        texts.push(prompt);
        emit({ type: 'system/init' });
        emit({ type: 'result', subtype: 'success', result: `echo:${prompt}` });
      },
    });
    const p1 = f.session.runTurn('A', SINK, 5_000);
    f.session.restartFresh();
    const p2 = f.session.runTurn('B', SINK, 5_000);
    const r1 = await p1;
    const r2 = await p2;
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    assert.deepEqual(texts, ['A', 'B'], '投喂顺序保持（复位不得打乱串行链）');
  });
});

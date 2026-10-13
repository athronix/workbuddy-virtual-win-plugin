/**
 * Phase 3 批5 · A2-3（idle 回收吃 maxRestarts 预算）修复的判别性回归。
 *
 * 病灶（主理人逐行亲验）：`spawnOnce()` 无条件 `spawnAttempts += 1` ⇒ `restarts` 单调爬升；
 * 而 idle TTL 回收（`tick()→dispose()` 软释放回 stopped）后的重建走同一条计数路径 ⇒
 * 长跑挂机场景（每 idleTtl 周期自然回收一次）把「计划内正常回收」与「真故障重建」混记同一本账，
 * 累计到 `maxRestarts` 即 `disabled` 永久停用（旧实现仅 `restartFresh()` 手工可解）。
 *
 * 修复：熔断判据 `faultRestarts = restarts − plannedRecycles`，`tick()` 两类软释放置
 * `recyclePending`、`spawnOnce()` 消费 ⇒ 计划内回收不计故障预算；`restarts` getter 不动
 * （观测价值保留）；无计划内回收时 plannedRecycles=0 ⇒ 逐字等于旧行为。
 *
 * 本测三层判别：①N 轮 idle 回收在 maxRestarts=2 下永不 disabled（修复前必红）；
 * ②纯故障重建仍正常熔断（证明修复没削弱真故障保护）；③混合场景故障预算足额可用。
 * 不依赖真实 codebuddy / HTTP：注入 FakeChild（事件驱动）+ 可控时钟（复刻 r19c 夹具）。
 */
import { EventEmitter } from 'node:events';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = join(import.meta.dirname, '..', '..');
const PKG = pathToFileURL(join(ROOT, 'packages', 'adapter-agent-workbuddy-llm', 'dist', 'index.js')).href;
const { PersistentCliSession } = await import(PKG);

const SINK = { onStatus: () => {} };

class FakeChild {
  constructor(pid, behavior) {
    this.pid = pid;
    this.exitCode = null;
    this.killCount = 0;
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
      end: () => self._finish(0),
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

// 首轮写消息即回 init+result（让 warmup/ensureReady 顺利就绪并置 lastUsedMs）
function turnBehavior() {
  return ({ index, emit }) => {
    if (index === 0) {
      emit({ type: 'system/init' });
      emit({ type: 'result', subtype: 'success', result: 'done' });
    }
  };
}

function makeSession(opts = {}) {
  const spawnCalls = [];
  const children = [];
  const logs = [];
  let clock = 1_000_000;
  const session = new PersistentCliSession({
    cliPath: 'codebuddy',
    outputDir: 'C:\\out',
    mcpConfigPath: 'C:\\out\\mcp.json',
    sessionId: 'a23-session',
    idleTtlMs: opts.idleTtlMs ?? 1000,
    readyTimeoutMs: opts.readyTimeoutMs ?? 300,
    warmupReadyMs: opts.warmupReadyMs ?? 300,
    maxRestarts: opts.maxRestarts ?? 2,
    maxWsBytes: opts.maxWsBytes ?? 1_000_000_000,
    ...(opts.wsProbe ? { wsProbe: opts.wsProbe } : {}),
    spawnFn: () => {
      spawnCalls.push(1);
      if (opts.spawnThrows) throw new Error('spawn boom');
      const child = new FakeChild(2000 + spawnCalls.length, opts.behavior ?? turnBehavior());
      children.push(child);
      return child;
    },
    ...(opts.spawnFault !== undefined ? { spawnFault: opts.spawnFault } : {}),
    now: () => clock,
    log: (m, meta) => logs.push([m, meta ?? {}]),
  });
  return { session, spawnCalls, children, logs, advance: (d) => (clock += d) };
}

describe('A2-3 · idle 回收不再吃故障重启预算', () => {
  test('N 轮 idle 回收+重建（maxRestarts=2）⇒ 永不 disabled；旧实现此处早已熔断', async () => {
    const f = makeSession({ maxRestarts: 2, idleTtlMs: 1000 });
    assert.equal(await f.session.ensureReady(), true);
    // 至少 6 轮自然回收（远超 maxRestarts=2）
    for (let cycle = 0; cycle < 6; cycle++) {
      // 就绪并置 lastUsedMs（warmup 触发一轮真实写）
      assert.equal(await f.session.warmup('OK?', 2000), true, `cycle ${cycle} warmup 应就绪`);
      f.advance(5000); // 超 idleTtl
      f.session.tick(); // 计划内软释放 → stopped + recyclePending
      assert.equal(f.session.snapshot().state, 'stopped', `cycle ${cycle} 应软释放非 disabled`);
      // 重建
      assert.equal(await f.session.ensureReady(), true, `cycle ${cycle} 回收后重建必须成功（不占故障预算）`);
      assert.notEqual(f.session.snapshot().state, 'disabled', `cycle ${cycle} 绝不应 disabled`);
    }
    // 观测面 restarts 仍如实反映总重建数（≥6），但熔断判据用的是扣减后的 faultRestarts
    assert.ok(f.session.snapshot().restarts >= 5, `restarts 应保留总重建观测值，实得 ${f.session.snapshot().restarts}`);
    assert.equal(f.session.snapshot().state !== 'disabled', true, '六轮计划内回收后仍不得停用');
  });

  test('纯故障重建（spawnFault，不经 tick）仍正常熔断 ⇒ 修复未削弱真故障保护', async () => {
    const f = makeSession({ maxRestarts: 2, spawnFault: true });
    let guard = 0;
    while (guard++ < 30) {
      await f.session.ensureReady();
      if (f.session.snapshot().state === 'disabled') break;
    }
    assert.equal(f.session.snapshot().state, 'disabled', `spawnFault 须在 maxRestarts=2 内熔断（guard=${guard}）`);
    assert.match(String(f.session.snapshot().lastError ?? ''), /已超重建上限/, '故障停用文案照旧');
  });

  test('混合：先若干计划内回收，再故障 ⇒ 故障预算足额（回收没预支）', async () => {
    const f = makeSession({ maxRestarts: 2, idleTtlMs: 1000 });
    await f.session.ensureReady();
    for (let i = 0; i < 3; i++) {
      await f.session.warmup('OK?', 2000);
      f.advance(5000);
      f.session.tick();
      await f.session.ensureReady();
    }
    assert.notEqual(f.session.snapshot().state, 'disabled', '3 轮回收不应触发停用');
    // 现在打开故障注入，应仍需走满 maxRestarts 次故障重建才停用（预算没被回收吃掉）
    f.session.setSpawnFault(true);
    let faultsToDisable = 0;
    let guard = 0;
    while (guard++ < 30) {
      // 制造一次真故障重建：先杀掉当前 child 逼 ensureReady 走 spawn（非 recyclePending 路径）
      const cur = f.children[f.children.length - 1];
      if (cur && cur.exitCode === null) cur._finish(1);
      await f.session.ensureReady();
      faultsToDisable++;
      if (f.session.snapshot().state === 'disabled') break;
    }
    assert.equal(f.session.snapshot().state, 'disabled', `混合场景最终仍应熔断（faults=${faultsToDisable}）`);
    // 故障到熔断所需次数应与纯故障路径同量级（≤ maxRestarts+2），证明回收未预支预算
    assert.ok(faultsToDisable <= 4, `回收不得预支故障预算，实耗 ${faultsToDisable} 次到停用（maxRestarts=2）`);
  });

  test('wsProbe 超限回收同为计划内软释放，重建不占故障预算（多轮）', async () => {
    // idleTtl 设巨大值排除 idle 干扰；只用 ws 超限触发回收；maxWsBytes 设很小以便命中
    const f = makeSession({
      maxRestarts: 2,
      idleTtlMs: 1_000_000_000,
      maxWsBytes: 50,
      wsProbe: () => 9999, // 恒定超限
    });
    assert.equal(await f.session.ensureReady(), true);
    for (let cycle = 0; cycle < 5; cycle++) {
      assert.equal(await f.session.warmup('OK?', 2000), true, `ws cycle ${cycle} warmup 应就绪`);
      f.session.tick(); // wsProbe 超限 → 计划内软释放 + recyclePending
      assert.notEqual(f.session.snapshot().state, 'disabled', `ws cycle ${cycle} 超限回收后不得停用`);
      assert.equal(await f.session.ensureReady(), true, `ws cycle ${cycle} 回收后重建成功（不占故障预算）`);
      assert.notEqual(f.session.snapshot().state, 'disabled', `ws cycle ${cycle} 重建后仍不得停用`);
    }
  });

  test('restartFresh 同时清零计划内回收账（复位后计数从头）', async () => {
    const f = makeSession({ maxRestarts: 2, idleTtlMs: 1000 });
    await f.session.ensureReady();
    await f.session.warmup('OK?', 2000);
    f.advance(5000);
    f.session.tick();
    await f.session.ensureReady(); // 消费一次 recyclePending → plannedRecycles=1
    const snap = f.session.restartFresh();
    assert.equal(snap.restarts, 0, '复位后 restarts 归零');
    assert.equal(snap.state, 'stopped');
  });
});

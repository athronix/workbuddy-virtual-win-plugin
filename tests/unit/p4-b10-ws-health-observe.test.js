/**
 * 批10 G7（V14）：llmSession 工作集采样观测面回归（纯附加，零行为改动）
 *
 * 病灶（台账 V14 / 批8 裁待观测面）：`working-set-probe.ts` 与 `persistent-session.ts`
 * 的工作集探针只有**内存判据**（超限⇒释放重建），`/health.llmSession` 无任何读数 ⇒
 * 运维观察窗拿不到「现在多大 / 峰值多少 / 回收过几次」，V14 长跑采样无从对账。
 *
 * 本测钉三件事（对齐 CL-018 C1 / P2-T9 firstCallLatencyMs 的观测纪律）：
 *  ① 字段在册：探针采到数字样本 ⇒ `wsLatestMb` / `wsPeakMb` / `wsEvictions` 进 snapshot；
 *  ② 缺探针/未采样 ⇒ 三键**整体不进**（K-13 禁显式 undefined；缺席=「未观测」）；
 *  ③ 值语义：latest=最近一次样本、peak=生命周期最大值（不降）、evictions=超限软释放次数；
 *     MB 换算口径 = 字节 / 1024² 保留一位小数（真机百 MB 量级，一位小数保精度）。
 *
 * 真机长跑采样（探针真实 spawn tasklist）留主理人观察窗，本件只交付离线面：
 * 注入可控 wsProbe（返回字节数）驱动 tick，确定性时钟排除 idle 干扰。
 *
 * 运行（只跑本文件，绝不整批）：
 *   node --test tests/unit/p4-b10-ws-health-observe.test.js
 */
import { EventEmitter } from 'node:events';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = join(import.meta.dirname, '..', '..');
const PKG = pathToFileURL(join(ROOT, 'packages', 'adapter-agent-workbuddy-llm', 'dist', 'index.js')).href;
const { PersistentCliSession } = await import(PKG);

const MB = 1_048_576;
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

function turnBehavior() {
  return ({ index, emit }) => {
    if (index === 0) {
      emit({ type: 'system/init' });
      emit({ type: 'result', subtype: 'success', result: 'done' });
    }
  };
}

/**
 * 会话夹具：`idleTtlMs` 设巨大值排除 idle 干扰（tick 的 ws 分支只在非 idle 回收时命中），
 * `wsProbe` 由 opts 注入（undefined ⇒ 不注入=生产默认不采样形态的对照）。
 */
function makeSession(opts = {}) {
  const spawnCalls = [];
  const children = [];
  let clock = 1_000_000;
  const session = new PersistentCliSession({
    cliPath: 'codebuddy',
    outputDir: 'C:\\out',
    mcpConfigPath: 'C:\\out\\mcp.json',
    sessionId: 'b10-ws',
    idleTtlMs: opts.idleTtlMs ?? 1_000_000_000,
    readyTimeoutMs: 300,
    warmupReadyMs: 300,
    maxRestarts: 5,
    maxWsBytes: opts.maxWsBytes ?? 1_000_000_000,
    ...(opts.wsProbe ? { wsProbe: opts.wsProbe } : {}),
    spawnFn: () => {
      spawnCalls.push(1);
      const child = new FakeChild(3000 + spawnCalls.length, opts.behavior ?? turnBehavior());
      children.push(child);
      return child;
    },
    now: () => clock,
    log: () => {},
  });
  return { session, spawnCalls, children, advance: (d) => (clock += d) };
}

describe('G7/V14 · 缺探针 ⇒ ws 三键整体不进（K-13 禁显式 undefined）', () => {
  test('无 wsProbe：snapshot 不含任何 ws* 键（缺席=未观测，不是 0）', async () => {
    const { session } = makeSession(); // 不注探针
    assert.equal(await session.ensureReady(), true);
    const snap = session.snapshot();
    for (const k of ['wsLatestMb', 'wsPeakMb', 'wsEvictions']) {
      assert.ok(!Object.keys(snap).includes(k), `未注入探针 ⇒ ${k} 绝不进 snapshot（实得键集 ${Object.keys(snap).join(',')}）`);
    }
  });

  test('注入探针但会话未启动（child 不 alive）⇒ tick 不触达采样 ⇒ 键仍不进', () => {
    let probeCalls = 0;
    const { session } = makeSession({ wsProbe: () => { probeCalls++; return 5 * MB; } });
    // 未 ensureReady ⇒ state=stopped、childAlive=false ⇒ tick 的两个分支都跳过
    session.tick();
    assert.equal(probeCalls, 0, 'child 不存活 ⇒ 探针根本不该被调用（既有 tick 门卫语义不变）');
    const snap = session.snapshot();
    assert.ok(!Object.keys(snap).includes('wsLatestMb'), '探针未采样 ⇒ ws 键缺席');
  });

  test('探针返回 undefined（采样失败/pid 未知）⇒ 不进观测键（未知≠确超上限，fail-safe 不谎报）', async () => {
    const { session } = makeSession({ wsProbe: () => undefined, maxWsBytes: 10 });
    assert.equal(await session.ensureReady(), true);
    assert.equal(await session.warmup('OK?', 2000), true, '写一轮驱动 init→ready（ensureReady 仅 spawn=starting）');
    session.tick();
    const snap = session.snapshot();
    assert.ok(!Object.keys(snap).includes('wsLatestMb'), '数字样本缺席 ⇒ ws 键不进（与既有「未知不回收」同口径）');
    assert.equal(snap.state, 'ready', '探针 undefined 绝不触发误杀回收（红线1 行为不变）');
  });
});

describe('G7/V14 · 正常采样路径 ⇒ ws 三键在册且值语义正确', () => {
  test('单样本 ⇒ 三键进、latest=peak=样本换算 MB、evictions=0（未超限不回收）', async () => {
    let sample = 100 * MB;
    const { session } = makeSession({ wsProbe: () => sample, maxWsBytes: 512 * MB });
    assert.equal(await session.ensureReady(), true);
    assert.equal(await session.warmup('OK?', 2000), true, '写一轮驱动 init→ready');
    session.tick();
    const snap = session.snapshot();
    assert.equal(snap.wsLatestMb, 100, '100MB 样本 ⇒ wsLatestMb=100（一位小数）');
    assert.equal(snap.wsPeakMb, 100, '首个样本同时是最早峰值');
    assert.equal(snap.wsEvictions, 0, '未超限 ⇒ 零回收计数');
    assert.equal(snap.state, 'ready', '未超限绝不回收（行为不变）');
  });

  test('判别性：样本先升后降 ⇒ latest 跟最新、peak 锁最大不降', async () => {
    let sample = 200 * MB;
    const { session } = makeSession({ wsProbe: () => sample, maxWsBytes: 512 * MB });
    assert.equal(await session.ensureReady(), true);
    session.tick(); // 200
    sample = 300 * MB;
    session.tick(); // 300（峰）
    sample = 150 * MB;
    session.tick(); // 150（最新回落）
    const snap = session.snapshot();
    assert.equal(snap.wsLatestMb, 150, 'latest 反映最近一次样本');
    assert.equal(snap.wsPeakMb, 300, 'peak 锁生命周期最大值，**不随后回落降**');
  });

  test('超限触发回收 ⇒ wsEvictions 计数递增（观测面与回收同判据点）', async () => {
    const { session, children } = makeSession({ wsProbe: () => 999 * MB, maxWsBytes: 500 * MB });
    assert.equal(await session.ensureReady(), true);
    session.tick(); // 999 > 500 ⇒ 超限软释放 + evictions=1
    let snap = session.snapshot();
    assert.equal(snap.wsEvictions, 1, '首次超限 ⇒ 计数 1');
    assert.equal(snap.wsLatestMb, 999);
    // 回收后重建再触发一次
    assert.equal(await session.ensureReady(), true);
    session.tick();
    snap = session.snapshot();
    assert.equal(snap.wsEvictions, 2, '二次超限 ⇒ 计数 2（累计）');
    assert.equal(snap.wsPeakMb, 999, '峰值恒定 999');
    assert.ok(children.length >= 2, '回收→重建确有子进程更替');
  });
});

describe('G7/V14 · MB 换算口径（一位小数，真机量级精度）', () => {
  test('非整 MB 样本 ⇒ 换算保留一位小数（10.5MB 如实显形，不四舍五入成整数）', async () => {
    const bytes = Math.round(10.5 * MB); // 11,010,048
    const { session } = makeSession({ wsProbe: () => bytes, maxWsBytes: 512 * MB });
    assert.equal(await session.ensureReady(), true);
    session.tick();
    const snap = session.snapshot();
    assert.equal(snap.wsLatestMb, 10.5, `10.5MB ⇒ 一位小数如实（实得 ${snap.wsLatestMb}）`);
  });

  test('判据本身仍按字节比较（maxWsBytes 用字节，透出用 MB——换算不改行为）', async () => {
    // 样本恰在阈值下：字节判据放行（不回收），但 MB 读数如实可见
    const { session } = makeSession({ wsProbe: () => 400 * MB, maxWsBytes: 500 * MB });
    assert.equal(await session.ensureReady(), true);
    assert.equal(await session.warmup('OK?', 2000), true, '写一轮驱动 init→ready');
    session.tick();
    const snap = session.snapshot();
    assert.equal(snap.wsLatestMb, 400, 'MB 读数如实透出');
    assert.equal(snap.wsEvictions, 0, '400MB < 500MB 字节判据 ⇒ 不回收');
    assert.equal(snap.state, 'ready');
  });
});

describe('G7/V14 · restartFresh 不清观测账（保守口径，与 firstCallLatencyMs 同族）', () => {
  test('采样+回收后复位 ⇒ ws 读数保留（复位解除"当前不可用"≠抹掉"历史上采样过"）', async () => {
    const { session } = makeSession({ wsProbe: () => 999 * MB, maxWsBytes: 500 * MB });
    assert.equal(await session.ensureReady(), true);
    session.tick(); // 超限回收 + 计数
    const before = session.snapshot();
    assert.equal(before.wsEvictions, 1);
    const after = session.restartFresh();
    assert.equal(after.wsEvictions, 1, '复位**不得**清零 wsEvictions（运维复位≠服务重启，峰值/历史回收痕迹保留）');
    assert.equal(after.wsPeakMb, 999, '复位后峰值仍在册');
    assert.equal(after.restarts, 0, '故障重启计数复位（既有语义）——与 ws 观测账分离');
  });
});

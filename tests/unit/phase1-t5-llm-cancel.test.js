/**
 * Phase 1 · T5 行为守卫（判据②③）—— LLM 执行体的取消消费
 *
 * 覆盖 §7.4-T5：
 *   ② 「取消时常驻会话 `abortActiveTurn` 被调」
 *   ③ 「单次 `-p` 子进程被 kill」（signal 透传）
 *
 * 三层断言，逐层递进：
 *   L1 `PersistentCliSession.abortActiveTurn`（单元 + FakeChild）：
 *      在飞轮次被打断 ⇒ 该轮 promise 落终态 + **子进程被终结** + 恰一次 kill；
 *      无在飞轮次 ⇒ 返回 false 且**绝不动子进程**（空闲期误杀会打断预热、白付冷启动）。
 *   L2 `runTurn` 的重建闸（安全红线）：取消打断 ⇒ **不进入既有「崩溃重建并重投本轮」**
 *      （否则等于把用户已叫停的目标重新喂给新 CLI 进程再跑一遍 ⇒ spawn 次数必须 =1）。
 *   L3 `CliLlmBridge`（真 spawn 一个会说 stream-json 的假 CLI，离线、不碰 VM/HTTP 服务）：
 *      turn 边界轮询命中 ⇒ 终态 `TASK_CANCELED`（**不是** `unavailable` ⇒ 不会降级重跑）；
 *      委派入口取消闸 ⇒ 零 spawn；
 *      单次 `-p` 的 `cancellationSignal` ⇒ 子进程真被 SIGTERM 终结（trap 落盘为证）。
 *   L3-b `launchCliProcess` signal 透传的形态钉 + 变异自证（win32 cmd 包装分支无法在
 *      POSIX 实跑 ⇒ 用源码点位计数钉死「两条 spawn 都透传」，并证明该计数断言非恒真）。
 *
 * 运行前置：`tsc -b tsconfig.build.json --force` 已重建 dist（T4 移交 D-28）。
 * 运行（逐文件，绝不整批 glob）：
 *   node --test tests/unit/phase1-t5-llm-cancel.test.js
 */

import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CliLlmBridge,
  PersistentCliSession,
  resolveCliPath,
} from '@winvm/adapter-agent-workbuddy-llm';
// `launchCliProcess` 是 bridge.ts 的内部导出（未再从包 index 透出）⇒ 与 cl020-f2-* 同范式，
// 直连构建产物路径取，**不为测试扩包导出面**（扩导出面属契约动作，须单独评审）。
import { launchCliProcess } from '../../packages/adapter-agent-workbuddy-llm/dist/bridge.js';

const ROOT = join(import.meta.dirname, '..', '..');
const BRIDGE_SRC = readFileSync(join(ROOT, 'packages', 'adapter-agent-workbuddy-llm', 'src', 'bridge.ts'), 'utf8');

/** 让出若干轮事件循环（微任务 + 一个宏任务），确保 runTurn 已挂上 activeAbort */
const ticks = (n = 3) =>
  Array.from({ length: n }, () => new Promise((r) => setImmediate(r))).reduce((p, c) => p.then(() => c), Promise.resolve());

/* ============================ L1/L2 夹具：FakeChild ============================ */

const SINK = { onStatus: () => {} };

class FakeChild {
  constructor(pid) {
    this.pid = pid;
    this.exitCode = null;
    this.killCount = 0;
    this.endCount = 0;
    this.out = new EventEmitter();
    this.err = new EventEmitter();
    this.proc = new EventEmitter();
    this.stdout = { on: (e, l) => this.out.on(e, l) };
    this.stderr = { on: (e, l) => this.err.on(e, l) };
    this.stdin = {
      write: () => true,
      end: () => {
        this.endCount += 1;
      },
    };
  }

  on(e, l) {
    this.proc.on(e, l);
    return this;
  }

  /** 只计数、**不发 exit**：真实 spawn 的 exit 由 OS 投递，此处模拟「kill 后事件迟到/不来」 */
  kill() {
    this.killCount += 1;
    return true;
  }

  emitEv(ev) {
    this.out.emit('data', `${JSON.stringify(ev)}\n`);
  }

  exit(code = 1) {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.proc.emit('exit', code);
  }
}

function makeSession(opts = {}) {
  const children = [];
  const logs = [];
  let clock = 1_000_000;
  const session = new PersistentCliSession({
    cliPath: 'codebuddy',
    outputDir: 'C:\\out',
    mcpConfigPath: 'C:\\out\\mcp.json',
    sessionId: 't5-cancel-session',
    idleTtlMs: 10_000,
    readyTimeoutMs: opts.readyTimeoutMs ?? 300,
    warmupReadyMs: opts.warmupReadyMs ?? 300,
    maxRestarts: opts.maxRestarts ?? 2,
    maxWsBytes: 1_000_000_000,
    spawnFn: () => {
      const child = new FakeChild(3000 + children.length);
      children.push(child);
      return child;
    },
    ...(opts.treeKillSpy ? { treeKillFn: opts.treeKillSpy } : {}),
    now: () => clock,
    log: (m, meta) => logs.push([m, meta ?? {}]),
  });
  return { session, children, logs, advance: (d) => (clock += d) };
}

/** 走到 ready 态：spawn 后 init 是懒事件（C1 时序铁律），需写出首条消息才到达 ⇒ 手动喂 */
async function toReady(f) {
  assert.equal(await f.session.ensureReady(), true);
  f.children[0].emitEv({ type: 'system/init', session_id: 't5' });
  await new Promise((r) => setImmediate(r));
  assert.equal(f.session.snapshot().state, 'ready', '夹具前提：init 已到 ⇒ state=ready');
}

/* ============================ L1 abortActiveTurn ============================ */

describe('T5 判据② PersistentCliSession.abortActiveTurn（接既有 activeAbort 钩子）', () => {
  test('空闲（无在飞轮次）⇒ false 且绝不动子进程', async () => {
    const f = makeSession();
    await toReady(f);
    assert.equal(f.children.length, 1);

    assert.equal(f.session.abortActiveTurn('不该生效：本轮未在飞'), false, 'activeAbort 已清理 ⇒ 空操作，调用方无需分支');
    assert.equal(f.children[0].killCount, 0, '★ 空闲期绝不杀进程：误杀会打断预热并白付一次冷启动');
    assert.equal(f.session.snapshot().state, 'ready', '空操作不得改状态');
  });

  test('在飞轮次 ⇒ true + 该轮 promise 落终态 + 子进程被终结（取消必须真止血）', async () => {
    const treeKills = [];
    const f = makeSession({ treeKillSpy: (pid) => treeKills.push(pid) });
    await toReady(f);

    const p = f.session.runTurn('删除临时目录并回收', SINK, 30_000);
    await ticks();

    const before = f.children[0].killCount;
    assert.equal(f.session.abortActiveTurn('宿主已取消'), true, '在飞 ⇒ activeAbort 已挂接');

    const r = await p;
    assert.equal(r.unavailable, true, '既有形状：该轮以 unavailable 落终态（由上层改判为取消终局）');
    assert.equal(r.ok, false);
    assert.equal(f.children[0].killCount, before + 1, '★ 只 resolve promise 而不杀 CLI ⇒ VM 内 agent 会继续自行发起工具调用（假取消）');
    assert.equal(treeKills.length, 1, 'win32 cmd 包装下的孙进程由既有 treeKill 兜底');
    const snap = f.session.snapshot();
    assert.equal(snap.state, 'stopped', '杀进程后当前态归 stopped（不得呈现「ready 但无 pid」的自相矛盾）');
    assert.equal(snap.pid, undefined);
    assert.equal(snap.lastError, undefined, '★ 取消不是故障 ⇒ 不得写 lastError（/health 历史信号面不得把用户意志呈现为故障）');
    assert.equal(snap.restarts, 0, '取消不得计入重建次数');
    assert.ok(f.logs.some(([m]) => m.includes('被取消打断')), '取消打断须留日志（禁止静默）');
  });

  test('预热在飞时同样可打断（warmup 亦挂 activeAbort ⇒ 零新状态语义）', async () => {
    const f = makeSession();
    const warm = f.session.warmup('OK');
    await ticks();
    assert.equal(f.session.abortActiveTurn('预热期取消'), true, '预热轮也占用 activeAbort ⇒ 必须可打断');
    assert.equal(f.children[0].killCount, 1);
    assert.equal(await warm, false, '被打断的预热按既有语义回 false（不得当成已就绪）');
  });
});

/* ============================ L2 取消不得触发同轮重建重投 ============================ */

describe('T5 判据② 安全红线：取消打断后绝不重建并重投本轮', () => {
  test('取消 ⇒ spawn 恰 1 次（崩溃路径才会重建重试）', async () => {
    const f = makeSession({ maxRestarts: 2 });
    await toReady(f);

    const p = f.session.runTurn('目标', SINK, 30_000);
    await ticks();
    f.session.abortActiveTurn('宿主已取消');
    const r = await p;

    assert.equal(r.unavailable, true);
    assert.equal(f.children.length, 1, '★ runTurn 的既有「不可用 ⇒ 重建一次并重投本轮」是崩溃恢复路径；取消必须在此之前分流');
    assert.equal(f.session.restarts, 0);
  });

  test('对照实验：崩溃退出仍会重建重投（证明上一条不是空断言）', async () => {
    const f = makeSession({ maxRestarts: 2 });
    const ok = await f.session.ensureReady();
    assert.equal(ok, true);

    const p = f.session.runTurn('目标', SINK, 30_000);
    await ticks();
    f.children[0].emitEv({ type: 'system/init' });
    await new Promise((r) => setTimeout(r, 20));
    f.children[0].exit(1); // 崩溃 → 既有 unavailable → 重建 → 第二次 execTurn
    // 重建出的第二个子进程同样立刻退出，避免等满 turn 超时（保持用例毫秒级）
    const watchdog = setInterval(() => {
      const last = f.children[f.children.length - 1];
      if (f.children.length > 1 && last.exitCode === null) {
        last.exit(1);
        clearInterval(watchdog);
      }
    }, 10);
    const r = await p;
    clearInterval(watchdog);

    assert.equal(r.unavailable, true);
    assert.ok(f.children.length >= 2, `崩溃须重建并重投本轮（既有 AC1.5 语义保持不变），实得 spawn ${f.children.length} 次`);
  });
});

/* ============================ L3-a 桥：真 spawn 的取消消费 ============================ */

/**
 * 会说 stream-json 的假 CLI（常驻路径）：写出 init + 两条 assistant 进度后挂起，
 * 模拟「CLI 思考期不回 result」。每次启动往 calls.log 追加一行，供 spawn 次数断言。
 *
 * ⚠ 用前台 `sleep 1` 循环而不是 `sleep 30 &` + `wait`：后者会让 sleep 在 sh 被杀后
 *    成为孤儿并**继续持有继承来的 stdio 管道**，把测试进程拖到 30s 才退出（假阳性挂死）。
 */
function makeFakeStreamCli(dir) {
  const callsFile = join(dir, 'calls.log');
  const script = [
    '#!/bin/sh',
    `D="${dir}"`,
    'echo run >> "$D/calls.log"',
    'echo \'{"type":"system/init","session_id":"t5"}\'',
    'echo \'{"type":"assistant","message":{"content":[{"type":"text","text":"正在分析目录占用"}]}}\'',
    'echo \'{"type":"assistant","message":{"content":[{"type":"text","text":"准备执行删除"}]}}\'',
    'while :; do sleep 1; done',
    '',
  ].join('\n');
  const p = join(dir, 'fake-stream-cli');
  writeFileSync(p, script, 'utf8');
  chmodSync(p, 0o755);
  return { cliPath: p, runs: () => (existsSync(callsFile) ? (readFileSync(callsFile, 'utf8').match(/run/g) ?? []).length : 0) };
}

/**
 * 计数式取消闸：第 `armAfterPolls` 次 `isCancelled()` 起返回真值，并同步 abort 同源信号
 * （复刻框架 `createProgressSink` 的「两者同一个 AbortController」语义，T3 移交第 6 条）。
 */
function makePollGate(armAfterPolls) {
  let polls = 0;
  const ctrl = new AbortController();
  return {
    polls: () => polls,
    sink: {
      onStatus: () => {},
      onArtifact: () => {},
      isCancelled: () => {
        polls += 1;
        const armed = polls >= armAfterPolls;
        if (armed && !ctrl.signal.aborted) ctrl.abort('canceled');
        return armed;
      },
      cancellationSignal: ctrl.signal,
    },
  };
}

async function runBridgeGoal(cliPath, outDir, sink, opts = {}) {
  const bridge = new CliLlmBridge({
    cliPath,
    outputDir: outDir,
    endpoint: 'http://127.0.0.1:18443/mcp',
    persistent: opts.persistent ?? true,
    artifactScanIntervalMs: 50,
    sessionConfig: { idleTtlMs: 60_000, readyTimeoutMs: 3_000, warmupReadyMs: 3_000, maxRestarts: 2 },
  });
  const result = await bridge.runGoal(
    {
      goal: opts.goal ?? '清理临时文件并给出报表',
      capabilities: ['storage.*', 'appops.*'],
      outputDir: outDir,
      cliPath,
      endpoint: 'http://127.0.0.1:18443/mcp',
      traceId: 'tr_t5_llm',
      timeoutMs: opts.timeoutMs ?? 12_000,
      taskId: 'task_t5_llm',
    },
    sink,
  );
  // 先取快照再释放：`dispose()` 会清空 `this.persistent`，届时 sessionHealth() 恒 undefined，
  // 断言「取消后 state=stopped」就会失去被测对象（假阳性风险）。
  const sessionSnapshot = bridge.sessionHealth();
  await bridge.dispose().catch(() => undefined);
  return { bridge, result, sessionSnapshot };
}

describe('T5 判据②③ CliLlmBridge 取消消费（真 spawn，离线）', () => {
  const base = mkdtempSync(join(tmpdir(), 't5-llm-cancel-'));

  test('常驻会话：turn 边界轮询命中 ⇒ abortActiveTurn 生效、终态 TASK_CANCELED、不走降级', async () => {
    const dir = join(base, 'persistent');
    mkdirSync(join(dir, 'out'), { recursive: true });
    const cli = makeFakeStreamCli(dir);
    // 轮询序：#1 = 委派入口闸；#2 = 常驻会话首条 assistant 进度 ⇒ 第 2 次起命中
    const gate = makePollGate(2);
    const { result, sessionSnapshot: snap } = await runBridgeGoal(cli.cliPath, join(dir, 'out'), gate.sink);

    assert.equal(result.ok, false);
    assert.equal(
      result.error.code,
      'TASK_CANCELED',
      '★ 不得是 EXECUTION_FAILED / PROVIDER_UNAVAILABLE —— 那两个码会让 provider 回落确定性执行器重跑',
    );
    assert.equal(result.error.retryable, false);
    assert.match(result.summary, /取消/);
    assert.ok(!result.summary.includes('未执行任何变更'), '不实陈述不得回归');
    assert.equal(result.degraded, undefined, '取消绝不得走「常驻不可用 → 单次 -p」降级通道');

    assert.ok(snap, '本例应已建立常驻会话');
    assert.equal(snap.state, 'stopped', '当前轮被打断 ⇒ 子进程已终结（真止血，不是外观性取消）');
    assert.equal(snap.restarts, 0, '取消不得计为重建');
    assert.equal(cli.runs(), 1, '★ 全链路恰一次 CLI 启动：既不重建重投，也不降级二次启动');
    assert.ok(gate.polls() >= 2, '轮询确实发生过（证明断言非空转）');
  }, 30_000);

  test('常驻会话：委派入口取消闸 ⇒ 零 spawn（连会话都不建立）', async () => {
    const dir = join(base, 'entry-gate');
    mkdirSync(join(dir, 'out'), { recursive: true });
    const cli = makeFakeStreamCli(dir);
    const sink = { onStatus: () => {}, onArtifact: () => {}, isCancelled: () => true };
    const { bridge, result } = await runBridgeGoal(cli.cliPath, join(dir, 'out'), sink);

    assert.equal(result.error.code, 'TASK_CANCELED');
    assert.equal(cli.runs(), 0, '取消先于执行 ⇒ 一个 CLI 进程都不许起');
    assert.equal(bridge.sessionHealth(), undefined, '未建立常驻会话（ensureSession 在入口闸之后）');
  }, 30_000);

  test('单次 -p：取消信号 ⇒ 子进程真被 SIGTERM 终结（trap 落盘为证）+ 终态 TASK_CANCELED', async () => {
    const dir = join(base, 'oneshot');
    mkdirSync(join(dir, 'out'), { recursive: true });
    const killLog = join(dir, 'kills.log');
    const callsFile = join(dir, 'one-calls.log');
    const script = [
      '#!/bin/sh',
      `D="${dir}"`,
      'echo run >> "$D/one-calls.log"',
      `trap 'echo killed >> "${killLog}"; exit 143' TERM`,
      'while :; do sleep 1; done',
      '',
    ].join('\n');
    const cliPath = join(dir, 'fake-oneshot-cli');
    writeFileSync(cliPath, script, 'utf8');
    chmodSync(cliPath, 0o755);

    const ctrl = new AbortController();
    const sink = {
      onStatus: () => {},
      onArtifact: () => {},
      isCancelled: () => ctrl.signal.aborted,
      cancellationSignal: ctrl.signal,
    };
    const runP = runBridgeGoal(cliPath, join(dir, 'out'), sink, { persistent: false });

    // 等子进程真起来（轮询已过入口闸、spawn 已发生）再发取消，避免测成「入口闸早退」的假阳性
    const spawnedAt = Date.now();
    while (!existsSync(callsFile) && Date.now() - spawnedAt < 3_000) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(existsSync(callsFile), '前提：单次 -p 子进程已启动（否则本例退化为入口闸用例）');
    ctrl.abort('canceled');
    const { result } = await runP;

    assert.equal(result.ok, false);
    assert.equal(
      result.error.code,
      'TASK_CANCELED',
      '★ 被 abort 杀掉的子进程退出码不得被归成 PROVIDER_UNAVAILABLE（那会触发降级重跑）',
    );
    assert.match(result.summary, /取消/);
    assert.ok(existsSync(killLog), '★ 判据③：子进程收到 SIGTERM（signal 真的透传到了 spawn，而非只让 promise 早退）');
    assert.match(readFileSync(killLog, 'utf8'), /killed/);
    assert.equal((readFileSync(callsFile, 'utf8').match(/run/g) ?? []).length, 1, '取消后不得二次启动单次 -p 进程');
  }, 30_000);

  after(() => {
    rmSync(base, { recursive: true, force: true });
  });
});

/* ============================ L3-b signal 透传形态钉 + 变异自证 ============================ */

describe('T5 判据③ launchCliProcess signal 透传（win32 cmd 包装分支无法实跑 ⇒ 形态钉 + 变异自证）', () => {
  const PIN = /\.\.\.\(signal \? \{ signal \} : \{\}\)/g;

  test('两条 spawn 分支各一处条件展开（恰 2）', () => {
    const hits = BRIDGE_SRC.match(PIN) ?? [];
    assert.equal(
      hits.length,
      2,
      `launchCliProcess 有 cmd 包装与直启两条 spawn：只透传一条 ⇒ win32 .cmd/.bat 场景取消静默失效，实得 ${hits.length}`,
    );
  });

  test('形参为纯附加可选（缺席即旧行为，第三方调用点零改动）', () => {
    assert.match(
      BRIDGE_SRC,
      /export function launchCliProcess\([\s\S]{0,200}?signal\?: AbortSignal,\s*\): CliChild/,
      '第 4 参必须可选',
    );
  });

  test('变异自证：摘掉一处透传 ⇒ 上一条计数断言必须变红（证明判据非恒真）', () => {
    const mutated = BRIDGE_SRC.replace(/\.\.\.\(signal \? \{ signal \} : \{\}\)/, '');
    assert.equal((mutated.match(PIN) ?? []).length, 1, '摘一处后应只剩一处 ⇒ 计数断言真的在测透传点位数');
    const bothGone = mutated.replace(/\.\.\.\(signal \? \{ signal \} : \{\}\)/, '');
    assert.equal((bothGone.match(PIN) ?? []).length, 0);
  });

  test('POSIX 实跑：signal 已 abort 时 spawn 不产出可用子进程（入口取消闸不可省略的依据）', async () => {
    const cli = resolveCliPath(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh');
    assert.equal(cli.resolved, true, '夹具前提：可解析到宿主自带 shell');
    const ctrl = new AbortController();
    ctrl.abort('canceled');
    // Node 语义：`spawn({signal})` 遇已 aborted 的 signal 会**异步** emit `error`（AbortError），
    // 而不是返回一个能正常工作的子进程。若 runOneShot 没有入口取消闸，委派就会以
    // 「难以归因的 spawn 错误」收口（并被 `child.on('error')` 误判成 PROVIDER_UNAVAILABLE ⇒ 降级重跑）。
    const child = launchCliProcess(cli, ['-c', 'exit 0'], process.env, ctrl.signal);
    const err = await new Promise((resolve) => {
      child.on?.('error', (e) => resolve(e));
      setTimeout(() => resolve(undefined), 500);
    });
    assert.ok(err, '已 abort 的 signal 必须让子进程报错（不得静默可用）');
    assert.match(`${err.name ?? ''} ${err.message ?? ''}`, /abort/i);
  });
});

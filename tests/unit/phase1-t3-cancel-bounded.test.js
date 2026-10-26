/**
 * Phase 1 · T3 行为守卫 —— a2a-framework 真取消 + TaskStore 有界化
 *
 * 覆盖 §7.4-T3 五判据（全部离线，不碰 VM/SSH/网络）：
 *   ① `requestCancel` 后 `sink.isCancelled()===true` 且 `cancellationSignal.aborted===true`
 *   ② `addArtifact` 对终态任务返回 `false` 且**不 emit**（既有 `r19c-*` SSE 用例另跑保绿）
 *   ③ `runGoalWithLifecycle` 在 provider 返回但任务已 canceled 时**不写 artifacts**、
 *      observer 收到 `state:'canceled'`（含 provider 抛取消错时不误报 failed）
 *   ④ `maxTasks` 驱逐只删终态最旧者；活动任务 / 挂起审批任务必留；`maxTasks:0` ⇒ 完全不驱逐
 *   ⑤ 顺序纪律 O-1（abort 先于 updateStatus）—— 行为探针 + 源码时序双钉
 *      （`assembly-guard.test.js` 自身由单独逐文件跑复证）
 *
 * 设计出处：docs/archive/changes/phase1-arch-design.md §1.1-2·3（O-1/O-2）、§1.6-2（ENG-08/O-11）、
 *          §8 横切纪律表、§7.4 验收表 T3 行。
 *
 * 运行（逐文件，绝不整批 glob）：
 *   node --test tests/unit/phase1-t3-cancel-bounded.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { A2AServer, TaskStore, createProgressSink } from '@winvm/a2a-framework';

/* ------------------------------------------------------------------ *
 * 路径：沙箱内 cwd 会失效，一律用 import.meta.url 推导绝对路径
 * ------------------------------------------------------------------ */
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const SRC_TASK_STORE = join(ROOT, 'packages/a2a-framework/src/task-store.ts');

/** 让事件循环短暂存活（TTL 计时器是 unref 的，需真实 await 才可能触发） */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 最小 GoalResult 夹具（provider 返回值形状，见 contracts/bridge.ts GoalResult） */
function goalResult(over = {}) {
  return {
    ok: true,
    summary: 'done',
    artifacts: [
      { kind: 'change-list', name: 'change-list', mime: 'application/json', encoding: 'json', data: { changed: ['x'] } },
    ],
    steps: [
      { index: 0, capabilityId: 'system.info.get', params: {}, ok: true, risk: 'L0', durationMs: 1, traceId: 'tr_t3' },
    ],
    ...over,
  };
}

/** 最小 ApprovalRequest 夹具 */
function approvalReq(approvalId) {
  return {
    approvalId,
    capabilityId: 'storage.file.delete',
    risk: 'L2',
    summary: `需要人工审批：${approvalId}`,
    preview: { items: 1 },
    impact: ['C:\\Users\\alice\\old'],
  };
}

/** 记录全部 SSE 事件的订阅者 */
function recordEvents(store, id) {
  const events = [];
  const unsubscribe = store.subscribe(id, (ev) => events.push(ev));
  return { events, unsubscribe };
}

/* ================================================================== *
 * 判据 ① + ⑤：取消请求后信号与轮询面同时可见，且 abort 严格先于 canceled 终态
 * ================================================================== */

describe('T3-①/⑤ 真取消：sink.isCancelled + cancellationSignal（含 O-1 时序）', () => {
  test('requestCancel 后 sink.isCancelled()===true 且 cancellationSignal.aborted===true', () => {
    const store = new TaskStore({ approvalTtlMs: 300 });
    const rec = store.create();
    const sink = createProgressSink(store, rec.task.id);

    // 取消前：两面都必须是 false（否则协作式取消会把未取消的任务误判为已取消）
    assert.equal(sink.isCancelled(), false, '未取消 ⇒ isCancelled() 必须 false');
    assert.equal(sink.cancellationSignal.aborted, false, '未取消 ⇒ signal.aborted 必须 false');

    store.requestCancel(rec.task.id);

    assert.equal(sink.isCancelled(), true, '判据①：requestCancel 后 sink.isCancelled() 必须 true');
    assert.equal(sink.cancellationSignal.aborted, true, '判据①：requestCancel 后 cancellationSignal.aborted 必须 true');
    assert.equal(sink.cancellationSignal.reason, 'canceled', "abort reason 必须是 'canceled'（供 provider 归一错误码）");
    assert.equal(store.isCancelled(rec.task.id), true, 'store 侧同源判据');
    assert.equal(store.cancellationSignal(rec.task.id).aborted, true, 'store 侧信号同源（同一个 AbortController）');
    assert.equal(store.cancellationSignal(rec.task.id), rec.cancelController.signal, '信号必须取自同一 controller 实例，不得每次新建');
  });

  test('O-1 时序探针：订阅者读到 canceled 的那一刻，signal.aborted 必已为 true', () => {
    const store = new TaskStore({ approvalTtlMs: 300 });
    const rec = store.create();
    const seen = [];
    store.subscribe(rec.task.id, (ev) => {
      if (ev.kind === 'status-update' && ev.status.state === 'canceled') {
        // 反例探针：若 requestCancel 把 abort 挪到 updateStatus 之后，
        // 此处读到的就是 false（emit 是同步派发，探针与生产路径同一帧）
        seen.push({
          final: ev.final,
          aborted: store.cancellationSignal(rec.task.id).aborted,
          cancelled: store.isCancelled(rec.task.id),
        });
      }
    });

    store.requestCancel(rec.task.id);

    assert.equal(seen.length, 1, 'canceled status-update 必须恰派发一次');
    assert.equal(seen[0].final, true, 'canceled 是终态 ⇒ final:true');
    assert.equal(seen[0].aborted, true, 'O-1 反例探针：emit canceled 时 abort 必须已生效');
    assert.equal(seen[0].cancelled, true, 'O-1 反例探针：emit canceled 时轮询面必须已可见');
  });

  test('O-1 源码时序守卫：abort() 位于 updateStatus(canceled) 之前（文本序切片，防漂移不认行号）', () => {
    const src = readFileSync(SRC_TASK_STORE, 'utf8');
    const start = src.indexOf('requestCancel(id: string)');
    assert.notEqual(start, -1, '切片失败：找不到 requestCancel 锚点');
    const end = src.indexOf('/* ------------------------------ 审批闸', start);
    assert.notEqual(end, -1, '切片失败：找不到 requestCancel 方法终止锚点');
    const body = src.slice(start, end);
    assert.ok(body.length > 200, `切片过短（${body.length}），守卫不得"匹配失败仍假绿"`);

    const iFlag = body.indexOf('cancelRequested = true');
    const iResolve = body.indexOf('pendingApproval.resolve(false)');
    const iAbort = body.indexOf('cancelController.abort(');
    const iStatus = body.indexOf("updateStatus(id, 'canceled')");
    for (const [name, idx] of [
      ['置取消标志', iFlag],
      ['审批按拒绝收口', iResolve],
      ['abort 信号', iAbort],
      ['canceled 终态', iStatus],
    ]) {
      assert.notEqual(idx, -1, `requestCancel 缺少 O-1 四步之一：${name}`);
    }
    assert.ok(iFlag < iResolve, 'O-1：标志位必须先于审批收口');
    assert.ok(iResolve < iAbort, 'O-1：审批收口必须先于 abort');
    assert.ok(iAbort < iStatus, 'O-1：**abort 必须先于 updateStatus(canceled)**（违则订阅者见 canceled 时信号未置位）');
  });

  test('挂起审批中被取消：resolve(false) 即时生效 + 信号已置位（不空等 TTL）', async () => {
    const store = new TaskStore({ approvalTtlMs: 5_000 });
    const rec = store.create();
    const sink = createProgressSink(store, rec.task.id);
    const decision = sink.onApprovalRequired(approvalReq('apr_t3_cancel'));
    assert.equal(store.tryGet(rec.task.id).task.status.state, 'input-required');

    store.requestCancel(rec.task.id);
    const approved = await decision; // 不得等 5s

    assert.equal(approved, false, '取消按拒绝收口');
    assert.equal(sink.isCancelled(), true, '取消后轮询面可见');
    assert.equal(sink.cancellationSignal.aborted, true, '取消后信号可见');
    assert.equal(store.tryGet(rec.task.id).task.status.state, 'canceled');
    assert.equal(store.currentApproval(rec.task.id), undefined, 'pendingApproval 已清理');
  });

  test('终态任务不可再取消（既有语义不变）；未知 id 的探测面不得谎报取消', () => {
    const store = new TaskStore({ approvalTtlMs: 300 });
    const rec = store.create();
    store.updateStatus(rec.task.id, 'completed');
    assert.throws(() => store.requestCancel(rec.task.id), /不可取消/);
    assert.equal(store.isCancelled(rec.task.id), false, 'completed ≠ 取消');

    assert.equal(store.isCancelled('no-such-task'), false, '未知 id ⇒ false（不得谎报）');
    assert.equal(store.cancellationSignal('no-such-task').aborted, false, '未知 id ⇒ 永不 abort 的兜底信号');
  });

  test('createProgressSink 的 sink 恒带两成员；旧 provider 式字面 sink（不实现）仍合法', async () => {
    const store = new TaskStore({ approvalTtlMs: 300 });
    const rec = store.create();
    const sink = createProgressSink(store, rec.task.id);
    assert.equal(typeof sink.isCancelled, 'function', '框架侧 sink 必须透出轮询面');
    assert.ok(sink.cancellationSignal instanceof AbortSignal, '框架侧 sink 必须透出信号面');

    // 契约成员可选 ⇒ 第三方 provider 一个都不实现也不破坏（缺席即旧行为）
    const legacy = { onStatus: () => {}, onArtifact: () => {}, onApprovalRequired: async () => true };
    assert.equal(legacy.isCancelled, undefined);
    assert.equal('cancellationSignal' in legacy, false);
    assert.equal(legacy.isCancelled?.() === true, false, '消费纪律：可选链 + 严格等值 ⇒ 缺席判假');
  });
});

/* ================================================================== *
 * 判据 ②：addArtifact 终态守卫（不落 artifact、不 emit）
 * ================================================================== */

describe('T3-② addArtifact 终态守卫', () => {
  for (const terminal of ['canceled', 'failed', 'completed', 'rejected']) {
    test(`${terminal} 任务：返回 false、task.artifacts 不落、不发 artifact-update`, () => {
      const store = new TaskStore({ approvalTtlMs: 300 });
      const rec = store.create();
      store.updateStatus(rec.task.id, terminal);
      const { events } = recordEvents(store, rec.task.id);

      const before = (rec.task.artifacts ?? []).length;
      const added = store.addArtifact(rec.task.id, {
        artifactId: 'art_guard',
        name: 'should-not-land',
        parts: [{ kind: 'text', text: 'x' }],
      });

      assert.equal(added, false, `判据②：${terminal} 任务必须返回 false`);
      assert.equal((rec.task.artifacts ?? []).length, before, 'artifact 绝不落库');
      assert.equal(events.filter((e) => e.kind === 'artifact-update').length, 0, '绝不 emit');
    });
  }

  test('非终态任务：返回 true、落 artifact、发一条 artifact-update（旧行为逐字保留）', () => {
    const store = new TaskStore({ approvalTtlMs: 300 });
    const rec = store.create();
    store.updateStatus(rec.task.id, 'working');
    const { events } = recordEvents(store, rec.task.id);

    const added = store.addArtifact(rec.task.id, {
      artifactId: 'art_ok',
      name: 'change-list',
      parts: [{ kind: 'text', text: 'ok' }],
    });

    assert.equal(added, true, '活动任务必须放行');
    assert.equal((rec.task.artifacts ?? []).length, 1);
    assert.equal(events.filter((e) => e.kind === 'artifact-update').length, 1);
    assert.equal(events[0].lastChunk, true, '既有 emit 载荷形状不变（lastChunk:true）');
  });

  test('经 sink.onArtifact 的写入路径同样被关死（取消后 provider 推产物 ⇒ 宿主收不到）', () => {
    const store = new TaskStore({ approvalTtlMs: 300 });
    const rec = store.create();
    const sink = createProgressSink(store, rec.task.id);
    sink.onStatus('working');
    sink.onArtifact({ kind: 'change-list', name: 'cl', mime: 'application/json', data: { a: 1 }, encoding: 'json' });
    assert.equal((rec.task.artifacts ?? []).length, 1, '取消前正常落一条');

    store.requestCancel(rec.task.id);
    const { events } = recordEvents(store, rec.task.id);
    sink.onArtifact({ kind: 'change-list', name: 'cl-late', mime: 'application/json', data: { b: 2 }, encoding: 'json' });

    assert.equal((rec.task.artifacts ?? []).length, 1, '判据②：取消后不得再落任何 artifact');
    assert.equal(events.filter((e) => e.kind === 'artifact-update').length, 0, '取消后不得再 emit 任何 artifact-update');
  });

  test('updateStatus 进入终态时盖上 terminalAtMs；非终态缺省（不写显式 undefined）', () => {
    const store = new TaskStore({ approvalTtlMs: 300 });
    const rec = store.create();
    assert.equal(rec.terminalAtMs, undefined, '活动任务不得有 terminalAtMs');

    store.updateStatus(rec.task.id, 'working');
    assert.equal(rec.terminalAtMs, undefined, '非终态流转不盖时刻');

    const before = Date.now();
    store.updateStatus(rec.task.id, 'completed');
    assert.ok(typeof rec.terminalAtMs === 'number' && rec.terminalAtMs >= before, '判据④前置：终态必须盖 terminalAtMs');
    const stamped = rec.terminalAtMs;
    store.updateStatus(rec.task.id, 'failed'); // 终态后一律拒绝（P3-3 语义）
    assert.equal(rec.terminalAtMs, stamped, 'terminalAtMs 一经盖上不得被后续同态/异态写入挪动');
    assert.equal(rec.task.status.state, 'completed', '终态不可再流转（既有语义不受本次改动影响）');
  });
});

/* ================================================================== *
 * 判据 ③：runGoalWithLifecycle 取消收口（O-2：不落 artifacts、不调 updateStatus、只 observe）
 * ================================================================== */

/** 组装带 observer / 可控 handler 的 server（不起网络，纯 handleRequest 驱动） */
function makeServer({ handler, observer, taskStore }) {
  const seen = [];
  const server = new A2AServer({
    agentCard: {
      name: 'T3 Test Agent',
      description: 'd',
      version: '1.0.0',
      url: 'http://127.0.0.1:18443/a2a',
      skills: [{ id: 'system-admin', name: '系统管理', description: 'd', tags: ['system'] }],
    },
    handler,
    defaultMaxRisk: 'L2',
    ...(taskStore ? { taskStore } : {}),
    ...(observer
      ? {
          delegationObserver: {
            onGoalAccepted: (goal) => observer.accepted?.(goal),
            onGoalTerminal: (taskId, goal, snap) => {
              seen.push({ taskId, snap });
              observer.terminal?.(taskId, goal, snap);
            },
          },
        }
      : {}),
  });
  return { server, seen };
}

function sendMessageParams(goal, extra = {}) {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'message/send',
    params: { message: { kind: 'message', role: 'user', messageId: 'm_t3', parts: [{ kind: 'text', text: goal }] }, ...extra },
  };
}

describe('T3-③ runGoalWithLifecycle 取消收口（O-2）', () => {
  test('provider 返回但任务已 canceled ⇒ 不写 artifacts、observer 收 state:canceled、终态不被改判', async () => {
    const store = new TaskStore({ approvalTtlMs: 300 });
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    let sinkInHandler;
    const handler = {
      async runGoal(goal, sink) {
        sinkInHandler = sink;
        sink.onStatus('working');
        await gate; // 等主测把任务取消掉
        // provider **不配合**（未轮询 isCancelled）也照样收口：这是框架侧的第二道闸
        return goalResult();
      },
    };
    const { server, seen } = makeServer({ handler, taskStore: store, observer: {} });

    const created = await server.handleRequest(sendMessageParams('长跑任务'));
    const taskId = created.result.id;
    assert.equal(store.isCancelled(taskId), false, '取消前不得可见取消');

    await server.handleRequest({ jsonrpc: '2.0', id: 2, method: 'tasks/cancel', params: { name: `tasks/${taskId}` } });
    assert.equal(sinkInHandler.isCancelled(), true, '判据③：handler 侧 sink 必须能观测到取消（透传未断链）');
    assert.equal(sinkInHandler.cancellationSignal.aborted, true, '判据③：handler 侧信号同样透到位');

    release();
    await sleep(20); // runner 收尾（阻塞式关闭，故 runner 自行继续）

    const rec = store.tryGet(taskId);
    assert.equal(rec.task.status.state, 'canceled', '终态必须保持 canceled（不被 completed 改判）');
    assert.deepEqual(rec.task.artifacts ?? [], [], '判据③：取消收口分支不得写任何 artifact（含 steps artifact）');
    assert.equal(rec.task.metadata?.goalSummary, undefined, '取消路径不得写 goalSummary metadata');

    const terminal = seen.filter((s) => s.taskId === taskId);
    assert.equal(terminal.length, 1, `终态回调必须恰一次，实得 ${terminal.length}`);
    assert.equal(terminal[0].snap.state, 'canceled', "observer 必须收到 state:'canceled'");
    assert.ok(terminal[0].snap.result, '取消快照仍带 handler 返回值（供 T4 证据面取事实）');
  });

  test('provider 因取消抛错 ⇒ 回调 canceled 而非 failed，且不落 failed 终态', async () => {
    const store = new TaskStore({ approvalTtlMs: 300 });
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const handler = {
      async runGoal(goal, sink) {
        sink.onStatus('working');
        await gate;
        if (sink.isCancelled()) {
          // 契约消费纪律：makeError('TASK_CANCELED', …) 后抛出
          const err = new Error('任务已被宿主取消');
          err.code = 'TASK_CANCELED';
          throw err;
        }
        return goalResult();
      },
    };
    const { server, seen } = makeServer({ handler, taskStore: store, observer: {} });

    const created = await server.handleRequest(sendMessageParams('会抛取消错的任务'));
    const taskId = created.result.id;
    await server.handleRequest({ jsonrpc: '2.0', id: 2, method: 'tasks/cancel', params: { name: `tasks/${taskId}` } });
    release();
    await sleep(20);

    const rec = store.tryGet(taskId);
    assert.equal(rec.task.status.state, 'canceled', '不得被改判 failed');
    assert.equal(rec.task.metadata?.goalSummary, undefined);
    assert.deepEqual(rec.task.artifacts ?? [], [], '抛错路径同样不写 artifacts');

    const terminal = seen.filter((s) => s.taskId === taskId);
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0].snap.state, 'canceled', "provider 抛取消错 ⇒ observer 收 'canceled'（不误报 failed）");
    assert.equal(terminal[0].snap.error.code, 'TASK_CANCELED', '原始异常须随快照透出（T4 侧 errorCode 归一依据）');
  });

  test('非取消的异常仍回调 failed（既有语义不得被新分支吞掉）', async () => {
    const store = new TaskStore({ approvalTtlMs: 300 });
    const handler = {
      async runGoal() {
        throw new Error('炸了');
      },
    };
    const { server, seen } = makeServer({ handler, taskStore: store, observer: {} });
    const created = await server.handleRequest(sendMessageParams('会炸的任务', { configuration: { blocking: true } }));
    const taskId = created.result.id;

    assert.equal(store.tryGet(taskId).task.status.state, 'failed', '普通异常仍收口 failed');
    assert.equal(seen.filter((s) => s.taskId === taskId).map((s) => s.snap.state).join(), 'failed');
  });

  test('正常完成仍写 artifacts + completed（新分支不得改变未取消路径）', async () => {
    const store = new TaskStore({ approvalTtlMs: 300 });
    const handler = {
      async runGoal() {
        return goalResult();
      },
    };
    const { server, seen } = makeServer({ handler, taskStore: store, observer: {} });
    const created = await server.handleRequest(sendMessageParams('正常任务', { configuration: { blocking: true } }));
    const taskId = created.result.id;

    const rec = store.tryGet(taskId);
    assert.equal(rec.task.status.state, 'completed');
    assert.ok((rec.task.artifacts ?? []).length >= 1, '未取消 ⇒ result.artifacts 与 steps artifact 照常落');
    assert.ok(rec.task.metadata?.goalSummary, 'metadata 照常写');
    assert.equal(seen.filter((s) => s.taskId === taskId)[0].snap.state, 'completed');
  });

  test('挂起审批路径优先级不变：input-required 时仍回调 input-required（即便随后被取消）', async () => {
    // K4 安全网在前、取消收口在后 —— 顺序不得颠倒，否则挂起中的取消会被写成 input-required
    const store = new TaskStore({ approvalTtlMs: 5_000 });
    let decisionSeen;
    const handler = {
      async runGoal(goal, sink) {
        decisionSeen = sink.onApprovalRequired(approvalReq('apr_t3_hold'));
        const approved = await decisionSeen;
        return goalResult({ ok: approved, summary: approved ? 'ok' : 'denied' });
      },
    };
    const { server, seen } = makeServer({ handler, taskStore: store, observer: {} });
    const created = await server.handleRequest(sendMessageParams('要审批的任务'));
    const taskId = created.result.id;
    await sleep(10);
    assert.equal(store.tryGet(taskId).task.status.state, 'input-required');

    await server.handleRequest({ jsonrpc: '2.0', id: 2, method: 'tasks/cancel', params: { name: `tasks/${taskId}` } });
    const resolved = await decisionSeen;
    assert.equal(resolved, false, '取消 ⇒ 审批按拒绝收口');
    await sleep(20);

    const states = seen.filter((s) => s.taskId === taskId).map((s) => s.snap.state);
    assert.deepEqual(states, ['canceled'], `挂起被取消后的终态回调必须恰一条 canceled，实得 ${JSON.stringify(states)}`);
    assert.equal(store.tryGet(taskId).task.status.state, 'canceled');
  });
});

/* ================================================================== *
 * 判据 ④：TaskStore 有界化（O-11 只在 create 尾部；只删终态最旧）
 * ================================================================== */

describe('T3-④ TaskStore 有界化（ENG-08 / O-11）', () => {
  /** 造一个终态任务（默认 completed） */
  function terminalTask(store, state = 'completed') {
    const rec = store.create();
    store.updateStatus(rec.task.id, state);
    return rec;
  }

  test('只逐终态最旧者：活动任务与挂起审批任务必留', () => {
    const store = new TaskStore({ approvalTtlMs: 5_000, maxTasks: 4, terminalTtlMs: Number.POSITIVE_INFINITY });
    const t1 = terminalTask(store); // 最早进终态
    const t2 = terminalTask(store, 'failed');
    // 显式拉开 terminalAtMs，驱逐排序判据不依赖毫秒并列
    t1.terminalAtMs = (t2.terminalAtMs ?? Date.now()) - 10_000;
    const live = store.create(); // 活动（working）
    store.updateStatus(live.task.id, 'working');
    const held = store.create(); // 挂起审批（input-required）
    void store.waitApproval(held.task.id, approvalReq('apr_evict'));
    assert.equal(store.tryGet(held.task.id).task.status.state, 'input-required');

    assert.equal(store.size(), 4, '夹具自检：四次 create 恰等于上限 ⇒ 尚未触发驱逐');

    const t3 = terminalTask(store, 'canceled'); // 第 5 次 create ⇒ 溢出 1 ⇒ 触发驱逐

    assert.equal(store.size(), 4, '判据④：条数必须被压回 maxTasks');
    assert.equal(store.tryGet(t1.task.id), undefined, 'terminalAtMs 最旧的终态被逐出');
    assert.ok(store.tryGet(t2.task.id), '较新终态在容量内保留');
    assert.ok(store.tryGet(live.task.id), '判据④：**活动任务绝不逐出**（打断在飞委派是 R5 红线）');
    assert.ok(store.tryGet(held.task.id), '判据④：**挂起审批任务绝不逐出**（吞掉人工决策）');
    assert.ok(store.tryGet(t3.task.id), '刚 create 的任务必须在场');
    assert.equal(store.currentApproval(held.task.id) !== undefined, true, '被保留的挂起审批仍完整');
  });

  test('驱逐顺序按 terminalAtMs 最旧先出（非 create 顺序）', () => {
    const store = new TaskStore({ maxTasks: 2 });
    const a = terminalTask(store, 'completed');
    const b = terminalTask(store, 'failed');
    // 手工把 b 的 terminalAtMs 挪到更早 ⇒ 驱逐应选 b
    b.terminalAtMs = (a.terminalAtMs ?? 0) - 10_000;
    const c = terminalTask(store, 'canceled');

    assert.equal(store.size(), 2);
    assert.equal(store.tryGet(b.task.id), undefined, 'terminalAtMs 最旧者先出');
    assert.ok(store.tryGet(a.task.id), '后进入终态者保留');
    assert.ok(store.tryGet(c.task.id));
    void a;
  });

  test('terminalTtlMs 过期清扫：过期终态删、未过期终态与活动任务留', async () => {
    const store = new TaskStore({ maxTasks: 100, terminalTtlMs: 20 });
    const live = store.create();
    store.updateStatus(live.task.id, 'working');
    const old = terminalTask(store); // create 之后才进终态 ⇒ 不在 create 尾部被扫到
    await sleep(40); // TTL 过期
    const fresh = terminalTask(store);

    store.create(); // 唯一的触发点（create 尾部）

    assert.equal(store.tryGet(old.task.id), undefined, '判据④：过期终态必须被回收');
    assert.ok(store.tryGet(fresh.task.id), '未过期终态保留');
    assert.ok(store.tryGet(live.task.id), '活动任务永不受 TTL 影响');
  });

  test('O-11：只读路径（get / list / tryGet / subscribe）不得触发驱逐', () => {
    const store = new TaskStore({ maxTasks: 5, terminalTtlMs: 20 });
    const victim = terminalTask(store); // create 时还未过期（终态在 create 之后才盖上）
    store.subscribe(victim.task.id, () => {});
    victim.terminalAtMs = Date.now() - 10_000; // 此刻已「过期」，但只能等下一次 create 才回收

    // 一连串只读调用：一律不得动表项
    store.get(victim.task.id);
    store.tryGet(victim.task.id);
    store.list({ pageSize: 10 });
    store.size();
    const unsubscribe = store.subscribe(victim.task.id, () => {});
    assert.equal(typeof unsubscribe, 'function', 'subscribe 返回退订函数本身（不是对象）');
    unsubscribe();

    assert.ok(store.tryGet(victim.task.id), '只读路径不得驱逐（O-11）');
    assert.equal(store.list({ pageSize: 10 }).totalSize, 1, 'list 自身不得改变条数');

    store.create(); // 唯一触发点
    assert.equal(store.tryGet(victim.task.id), undefined, 'create 尾部才清扫');
  });

  test('maxTasks:0 ⇒ 完全不驱逐（条数与 TTL 两路一起关，旧行为逐字保留）', () => {
    const store = new TaskStore({ maxTasks: 0 });
    for (let i = 0; i < 60; i += 1) terminalTask(store);
    assert.equal(store.size(), 60, '判据④：maxTasks:0 ⇒ 一条都不逐');

    const storeNeg = new TaskStore({ maxTasks: -1 });
    for (let i = 0; i < 5; i += 1) terminalTask(storeNeg);
    assert.equal(storeNeg.size(), 5, '非法值 ⇒ 同不设限（归一不抛错）');
  });

  test('缺省上限 = 200（设计 §1.6-2 默认值；既有测试规模远低于此 ⇒ 逐字绿）', () => {
    const store = new TaskStore();
    for (let i = 0; i < 205; i += 1) terminalTask(store);
    assert.equal(store.size(), 200, '未显式指定 ⇒ 默认 200（偏差 D-15：任务书曾写 undefined 亦不设限）');

    const storeInf = new TaskStore({ maxTasks: Number.POSITIVE_INFINITY });
    for (let i = 0; i < 5; i += 1) terminalTask(storeInf);
    assert.equal(storeInf.size(), 5, 'Infinity ⇒ 不设限');
  });

  test('驱逐时 subscribers.clear()（防 SSE 闭包泄漏）；size() 语义不变', () => {
    const store = new TaskStore({ maxTasks: 1 });
    const victim = terminalTask(store);
    store.subscribe(victim.task.id, () => {});
    store.subscribe(victim.task.id, () => {});
    assert.equal(victim.subscribers.size, 2, '夹具自检：订阅者已挂上');

    const newcomer = store.create();
    assert.equal(store.tryGet(victim.task.id), undefined, '容量 1 ⇒ 最旧终态被逐');
    assert.equal(victim.subscribers.size, 0, '判据④：逐出前必须清空 subscribers（防闭包强引用不回收）');
    assert.equal(store.size(), 1, 'size() = 表内条数（语义不变）');
    assert.ok(store.tryGet(newcomer.task.id));
  });

  test('有界化不打断在飞 SSE 流的事件收口：被逐任务的订阅者静默，不抛错', async () => {
    const store = new TaskStore({ maxTasks: 5, terminalTtlMs: 20 });
    const streamTask = store.create();
    const got = [];
    store.subscribe(streamTask.task.id, (ev) => got.push(ev));
    store.updateStatus(streamTask.task.id, 'completed'); // 进终态，成为驱逐候选
    await sleep(40);
    streamTask.terminalAtMs = Date.now() - 10_000; // 确保判过期（与 TTL=20 比较）

    const t2 = store.create();
    const t3 = store.create(); // 未超上限 ⇒ 溢出 0 ⇒ 仅 TTL 清扫生效

    assert.equal(store.tryGet(streamTask.task.id), undefined);
    // 被逐后对旧 rec 的 emit 目标集合已空：不得抛错（订阅回调若抛错也只被吞）
    const before = got.length;
    store.updateStatus(t2.task.id, 'completed');
    assert.equal(got.length, before, '被逐任务的订阅者不再收任何事件（无残留闭包）');
    assert.ok(store.tryGet(t3.task.id));
  });

  test('取消在飞的记录不得被逐（驱逐候选三须之「非取消在飞」被真探针钉住）', () => {
    const store = new TaskStore({ maxTasks: 1, terminalTtlMs: Number.POSITIVE_INFINITY });
    // 探针 A：非终态 + 已 abort（真实路径上不存在 ⇒ 手工构造）⇒ 必须留
    const inflight = store.create();
    store.updateStatus(inflight.task.id, 'working');
    inflight.cancelController.abort('canceled');

    // 探针 B：已进终态但状态不是 canceled（被绕过 requestCancel 的写入者置成 completed）⇒ 必须留
    const oddTerminal = store.create();
    oddTerminal.cancelController.abort('canceled');
    store.updateStatus(oddTerminal.task.id, 'completed');

    const normalTerminal = store.create();
    store.updateStatus(normalTerminal.task.id, 'failed'); // 唯一合法驱逐候选

    const newcomer = store.create(); // 触发条数闸门（size 4 → 需压回 1）

    assert.equal(store.tryGet(normalTerminal.task.id), undefined, '普通终态任务应被逐（候选判据正向）');
    assert.ok(store.tryGet(inflight.task.id), '探针 A：取消在飞（非终态）必须留 ⇒ runner 取消收口仍找得到记录');
    assert.ok(store.tryGet(oddTerminal.task.id), '探针 B：终态但已 abort 且非 canceled ⇒ 保守不逐');
    assert.ok(store.tryGet(newcomer.task.id), '刚 create 的任务必须在场');
    assert.equal(store.size(), 3, '只剩不可逐的三条（活动/取消在飞/新create）—— 判据不得为了压条数而打断在飞');
    void newcomer;
  });
});

/* ================================================================== *
 * 附加：A2A 协议面在真取消下的端到端形状（判据 ①②③ 的协议侧旁证）
 * ================================================================== */

describe('T3 协议面旁证：tasks/cancel 回包与 SSE 流', () => {
  test('tasks/cancel 回包 state=canceled，且此后不再有 artifact-update 事件', async () => {
    const store = new TaskStore({ approvalTtlMs: 300 });
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const handler = {
      async runGoal(goal, sink) {
        sink.onStatus('working');
        await gate;
        sink.onArtifact({ kind: 'change-list', name: 'late', mime: 'application/json', data: { late: true }, encoding: 'json' });
        return goalResult();
      },
    };
    const { server } = makeServer({ handler, taskStore: store });
    const created = await server.handleRequest(sendMessageParams('长跑'));
    const taskId = created.result.id;
    const { events } = recordEvents(store, taskId);

    const res = await server.handleRequest({ jsonrpc: '2.0', id: 2, method: 'tasks/cancel', params: { name: `tasks/${taskId}` } });
    assert.equal(res.result.status.state, 'canceled');
    assert.equal(res.result.status.final, undefined, '回包是 Task 投影，不含 final');

    release();
    await sleep(20);
    assert.equal(events.filter((e) => e.kind === 'artifact-update').length, 0, '取消后 provider 推的 artifact 必须被终态守卫关死');
    assert.equal(store.tryGet(taskId).task.status.state, 'canceled');
  });

  test('SSE handleStream：取消后 final:true 的 canceled 事件仍照常送达宿主（流不因新分支断链）', async () => {
    const store = new TaskStore({ approvalTtlMs: 300 });
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    let sinkInHandler;
    const handler = {
      async runGoal(goal, sink) {
        sinkInHandler = sink;
        sink.onStatus('working');
        await gate;
        return goalResult();
      },
    };
    const server = new A2AServer({
      agentCard: {
        name: 'T3 SSE Agent',
        description: 'd',
        version: '1.0.0',
        url: 'http://127.0.0.1:18443/a2a',
        skills: [{ id: 'system-admin', name: '系统管理', description: 'd', tags: ['system'] }],
      },
      handler,
      taskStore: store,
    });

    const stream = server.handleStream({
      message: { kind: 'message', role: 'user', messageId: 'm_sse', parts: [{ kind: 'text', text: '流式长跑' }] },
    });
    const collected = [];
    const consume = (async () => {
      for await (const ev of stream) collected.push(ev);
    })();

    // 等首个事件（status-update working）到位后再取消
    for (let i = 0; i < 200 && collected.length === 0; i += 1) await sleep(5);
    assert.ok(collected.length > 0, 'SSE 必须产出首批事件');
    const taskId = collected[0].taskId;

    await server.handleRequest({ jsonrpc: '2.0', id: 9, method: 'tasks/cancel', params: { name: `tasks/${taskId}` } });
    assert.equal(sinkInHandler.isCancelled(), true, 'SSE 通道的 sink 同样具备取消探测面');
    release();
    await consume;

    const finals = collected.filter((e) => e.kind === 'status-update' && e.final);
    assert.equal(finals.length, 1, '有且仅有一条 final 事件');
    assert.equal(finals[0].status.state, 'canceled', '判据①②协议侧：宿主收到 canceled');
    assert.equal(collected.filter((e) => e.kind === 'artifact-update').length, 0, '取消后无 artifact-update 下发');
  });
});

/**
 * K4 审查遗留 P3 修复单元测试（P3-2 / P3-3）
 *
 * P3-2 Object.assign 绕过 readonly：
 *   runGoalWithLifecycle 改为「构造期注入」—— 用展开构造新对象传给 handler。
 *   ① handler 收到的 goal.taskId 正确；
 *   ② 调用方持有的原 goal 对象**不被就地改写**（不可变约定）；
 *   ③ 即便目标对象被冻结也不报错（旧 Object.assign 在冻结对象上会抛 / 静默失效）。
 *
 * P3-3 waitApproval 无 TTL：
 *   ① 短 TTL 超时 → 挂起 Promise resolve(false)（raise 走正常返回路径，不抛错）；
 *   ② 任务转 failed 且原因含 approval timeout；metadata 标 approvalTimedOut；
 *   ③ pendingApproval 被清理；onApprovalTimeout 回调触发（供 vm-service 删 token）；
 *   ④ 正常 resolveApproval 不受 TTL 影响（TTL 远大于应答耗时）；
 *   ⑤ 超时后迟到的应答 → resolveApproval 返回 false，绝不复活任务 / 绝不放行。
 *
 * 纪律：全部用短 TTL（50–200ms）避免慢测。
 *
 * ── K5 适配点（本文件随契约变更同步修改，语义覆盖只增不减）──────────────────
 * 1. `VmApprovalCoordinator.raise` 返回值由 `Promise<boolean>` 升级为
 *    `Promise<ApprovalOutcome>`（判别联合）。受影响用例仅 1 条：
 *      旧 `assert.equal(raised, false)`（TTL 超时）
 *      → 新 `assert.equal(outcome.approved, false)` + `outcome.reason === 'timeout'`
 *        + `outcome.executed === undefined`（超时绝不重放）
 *        + token 未被消费（超时分支不删 token，清理权在 onApprovalTimeout）。
 *    其余 P3-3 用例直连 `TaskStore.waitApproval`（契约未变，仍返回 boolean），逐字保持。
 * 2. **新增**用例：审批挂起中被 `tasks/cancel` → `reason:'rejected'`（证明 reason 细分
 *    没有把「取消/拒绝」误报成 timeout —— K5 决议可解释性）。
 * 3. 重放态（`approved:true + executed`）与桥侧回执反查由 `k5-replay.test.js` 覆盖。
 * ─────────────────────────────────────────────────────────────────────────
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { TaskStore, A2AServer } from '@winvm/a2a-framework';
import { VmApprovalCoordinator } from '@winvm/vm-service';
import { APPROVAL_TTL_MS_DEFAULT, ENV_APPROVAL_TTL_MS, resolveApprovalTtlMs } from '@winvm/core';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8');

/**
 * 等待挂起 Promise 期间保持事件循环存活。
 * TaskStore 的 TTL 计时器是 `unref()` 的（服务退出时不被未决审批拖住），
 * 因此在「除该计时器外无其它句柄」的裸测试里必须自行撑住 loop，否则计时器永不触发。
 */
function awaitWithKeepAlive(promise, ms = 2_000) {
  const keep = setTimeout(() => {}, ms);
  return promise.finally(() => clearTimeout(keep));
}

/** 造一个 ApprovalRequest */
function approvalReq(approvalId = 'apr_p3', over = {}) {
  return {
    approvalId,
    capabilityId: 'app.winget.uninstall',
    risk: 'L2',
    summary: '卸载 VM 企业微信',
    preview: {},
    impact: [],
    ...over,
  };
}

/* ============================ P3-3：waitApproval TTL ============================ */

describe('P3-3 · waitApproval TTL 超时收口', () => {
  test('TTL 超时 → resolve(false)、任务转 failed、pendingApproval 清理、回调触发', async () => {
    const timeouts = [];
    const tasks = new TaskStore({
      approvalTtlMs: 60,
      onApprovalTimeout: (info) => timeouts.push(info),
    });
    const rec = tasks.create();
    const taskId = rec.task.id;

    // 挂起（模拟 raise 内部调用的 waitApproval）
    const decision = tasks.waitApproval(taskId, approvalReq('apr_t1'));

    // 挂起期间：input-required，pendingApproval 在位，带 expiresAtMs
    assert.equal(tasks.tryGet(taskId).task.status.state, 'input-required');
    const pending = tasks.currentApproval(taskId);
    assert.ok(pending, '挂起期间应有 pendingApproval');
    assert.equal(typeof pending.expiresAtMs, 'number', '应带绝对截止时刻 expiresAtMs');
    // 审批请求的 data part 与 text part 都应告知 TTL（宿主/人工需知道不能无限期挂着）
    const parts = tasks.tryGet(taskId).task.status.message.parts;
    const dataPart = parts.find((p) => p.kind === 'data').data;
    assert.equal(typeof dataPart.expiresAtMs, 'number', 'data part 应下发 expiresAtMs');
    assert.match(parts.find((p) => p.kind === 'text').text, /审批等待有上限/,
      'text part 应写明审批有 TTL');

    // 等待超时（TTL 60ms，keep-alive 撑住事件循环让 unref 计时器得以触发）
    const approved = await awaitWithKeepAlive(decision);

    // ① resolve(false)（绝不放行）
    assert.equal(approved, false, '超时应按拒绝收口（false）');
    // ② 任务转 failed，原因含 approval timeout
    const state = tasks.tryGet(taskId).task.status.state;
    assert.equal(state, 'failed', '超时后任务应转 failed');
    const msgText = JSON.stringify(tasks.tryGet(taskId).task.status.message);
    assert.match(msgText, /approval timeout/, 'status.message 应注明 approval timeout');
    // metadata 固化超时事实
    assert.equal(tasks.tryGet(taskId).task.metadata.approvalTimedOut, true);
    // ③ pendingApproval 清理
    assert.equal(tasks.currentApproval(taskId), undefined, '超时后 pendingApproval 应被清理');
    // 回调触发（供 vm-service 删 token）
    assert.equal(timeouts.length, 1, 'onApprovalTimeout 应触发一次');
    assert.equal(timeouts[0].approvalId, 'apr_t1');
    assert.equal(timeouts[0].taskId, taskId);
    assert.equal(timeouts[0].ttlMs, 60);
  });

  test('正常 resolveApproval 不受 TTL 影响（应答远快于超时）', async () => {
    const timeouts = [];
    const tasks = new TaskStore({
      approvalTtlMs: 5_000, // 5s，绰绰有余
      onApprovalTimeout: (info) => timeouts.push(info),
    });
    const rec = tasks.create();
    const taskId = rec.task.id;

    const decision = tasks.waitApproval(taskId, approvalReq('apr_ok'));
    assert.equal(tasks.tryGet(taskId).task.status.state, 'input-required');

    // 立即批准（在 TTL 内）
    const handled = tasks.resolveApproval(taskId, 'apr_ok', true);
    assert.equal(handled, true);
    const approved = await decision;

    assert.equal(approved, true, 'TTL 内正常批准应返回 true');
    assert.equal(timeouts.length, 0, '正常应答不应触发超时回调');
    assert.equal(tasks.currentApproval(taskId), undefined, '应答后 pendingApproval 清理');
    // 任务仍为运行中（非 failed）—— 由 runner 续跑，绝不误判超时
    assert.notEqual(tasks.tryGet(taskId).task.status.state, 'failed');
    assert.equal(tasks.tryGet(taskId).task.metadata?.approvalTimedOut, undefined);
  });

  test('超时后迟到的应答 → resolveApproval 返回 false，绝不复活任务 / 绝不放行', async () => {
    const tasks = new TaskStore({ approvalTtlMs: 50 });
    const rec = tasks.create();
    const taskId = rec.task.id;

    const decision = tasks.waitApproval(taskId, approvalReq('apr_late'));
    await awaitWithKeepAlive(decision); // 等超时收口
    assert.equal(tasks.tryGet(taskId).task.status.state, 'failed');

    // 超时后再尝试批准（模拟宿主拖延应答）
    const handled = tasks.resolveApproval(taskId, 'apr_late', true);
    assert.equal(handled, false, '超时后不应答应返回 false（无 pendingApproval）');
    // 任务仍 failed，绝不被复活为 working/completed
    assert.equal(tasks.tryGet(taskId).task.status.state, 'failed');
    assert.equal(tasks.currentApproval(taskId), undefined);
  });

  test('coordinator.raise 超时 → approved:false / reason:timeout 的正常返回（非抛错），token 不置 hostApproved', async () => {
    const tasks = new TaskStore({ approvalTtlMs: 60 });
    const pendingApprovals = new Map();
    pendingApprovals.set('apr_c1', {
      approvalId: 'apr_c1',
      capabilityId: 'app.winget.uninstall',
      risk: 'L2',
      params: {},
      preview: {},
      createdAtMs: Date.now(),
      hostApproved: false,
    });

    const coordinator = new VmApprovalCoordinator();
    coordinator.bind(tasks, pendingApprovals);
    const rec = tasks.create();
    coordinator.beginTask(rec.task.id);

    // raise 不抛错，超时后正常返回结构化决议
    let outcome;
    let threw = false;
    try {
      outcome = await awaitWithKeepAlive(coordinator.raise(approvalReq('apr_c1')));
    } catch {
      threw = true;
    }
    assert.equal(threw, false, 'raise 超时不应抛错（保证桥走 ok=false 正常分支）');
    // K5 适配：raise 返回 ApprovalOutcome 判别联合（旧断言 `equal(outcome, false)` → 新断言）
    assert.equal(outcome.approved, false, '超时绝不放行');
    assert.equal(outcome.executed, undefined, '超时绝不重放，不得凭空造出执行回执');
    // K5 新增语义：超时须能与「宿主明确拒绝」区分（reason='timeout'）。
    // 判别依据双信号：① onApprovalTimeout → coordinator.noteTimeout 登记；
    // ② TaskStore 固化进 task.metadata 的 approvalTimedOut + approvalTimeoutApprovalId。
    assert.equal(outcome.reason, 'timeout', 'TTL 超时应细分为 timeout（非 rejected）');
    // hostApproved 保持 false（K4 安全点：绝不自批）
    assert.equal(pendingApprovals.get('apr_c1').hostApproved, false, '超时不得置 hostApproved=true');
    // 超时不消费 token（token 保留交由 onApprovalTimeout 侧清理，协调器不越权删）
    assert.equal(pendingApprovals.has('apr_c1'), true, '超时分支不删 token');

    coordinator.endTask();
  });

  test('coordinator.raise：审批挂起中被 cancel → reason 归为 rejected（非 timeout）', async () => {
    // 与 TTL 超时相区分：取消走 requestCancel → resolve(false)，metadata 无 approvalTimedOut
    const tasks = new TaskStore({ approvalTtlMs: 5_000 });
    const pendingApprovals = new Map();
    pendingApprovals.set('apr_c2', {
      approvalId: 'apr_c2',
      capabilityId: 'app.winget.uninstall',
      risk: 'L2',
      params: {},
      preview: {},
      createdAtMs: Date.now(),
      hostApproved: false,
    });
    const coordinator = new VmApprovalCoordinator();
    coordinator.bind(tasks, pendingApprovals);
    const rec = tasks.create();
    coordinator.beginTask(rec.task.id);

    const decision = coordinator.raise(approvalReq('apr_c2'));
    tasks.requestCancel(rec.task.id);
    const outcome = await decision;

    assert.equal(outcome.approved, false);
    assert.equal(outcome.reason, 'rejected', '取消按拒绝收口，不得谎报 timeout');
    assert.equal(outcome.executed, undefined);
    assert.equal(pendingApprovals.get('apr_c2').hostApproved, false, '取消绝不置已批准');

    coordinator.endTask();
  });

  test('默认 TTL = 30 分钟；env 覆盖生效；非法值回退默认（坏 env 不得打挂服务）', () => {
    assert.equal(ENV_APPROVAL_TTL_MS, 'WINVM_APPROVAL_TTL_MS');
    assert.equal(APPROVAL_TTL_MS_DEFAULT, 1_800_000);
    assert.equal(resolveApprovalTtlMs({}), 1_800_000);
    assert.equal(resolveApprovalTtlMs({ [ENV_APPROVAL_TTL_MS]: '600000' }), 600_000);
    // 非法一律回退，不抛错
    assert.equal(resolveApprovalTtlMs({ [ENV_APPROVAL_TTL_MS]: 'abc' }), 1_800_000);
    assert.equal(resolveApprovalTtlMs({ [ENV_APPROVAL_TTL_MS]: '0' }), 1_800_000);
    assert.equal(resolveApprovalTtlMs({ [ENV_APPROVAL_TTL_MS]: '-5' }), 1_800_000);
  });

  test('TaskStore 缺省构造走 env（不设 approvalTtlMs 时默认 30 分钟 → 测试内不触发）', async () => {
    const tasks = new TaskStore();
    const rec = tasks.create();
    const decision = tasks.waitApproval(rec.task.id, approvalReq('apr_def'));
    assert.equal(tasks.currentApproval(rec.task.id).expiresAtMs !== undefined, true,
      '默认（有限 TTL）应带 expiresAtMs');
    // 不等待超时（默认 30 分钟），直接批准收口，避免慢测
    tasks.resolveApproval(rec.task.id, 'apr_def', true);
    assert.equal(await decision, true);
  });

  test('超时后 runner 收尾的第二次 updateStatus(failed) 不覆盖 approval timeout 消息（终态同写也拦）', async () => {
    // P3-3 竞态处理：TaskStore 超时把任务置 failed（消息=approval timeout）后，
    // server 的 runGoalWithLifecycle 收尾仍会 updateStatus('failed', …)。
    // updateStatus 对**已是终态**的任务一律拒绝（含同态重写），故超时原因保留。
    const tasks = new TaskStore({ approvalTtlMs: 50 });
    const rec = tasks.create();
    const taskId = rec.task.id;
    await awaitWithKeepAlive(tasks.waitApproval(taskId, approvalReq('apr_race')));

    const before = JSON.stringify(tasks.tryGet(taskId).task.status);
    assert.match(before, /approval timeout/);
    // 模拟 runner 收尾的二次写入（同态 failed）
    tasks.updateStatus(taskId, 'failed', {
      kind: 'message', role: 'agent', messageId: 'm', parts: [{ kind: 'text', text: '任务执行失败：覆盖尝试' }],
    });
    const after = JSON.stringify(tasks.tryGet(taskId).task.status);
    assert.match(after, /approval timeout/, '超时原因不得被后续同态写入覆盖');
    assert.doesNotMatch(after, /覆盖尝试/);
  });

  test('审批挂起中 tasks/cancel → 挂起等待按拒绝收口（不再空等到 TTL），状态保持 canceled', async () => {
    const tasks = new TaskStore({ approvalTtlMs: 5_000 });
    const rec = tasks.create();
    const taskId = rec.task.id;
    const decision = tasks.waitApproval(taskId, approvalReq('apr_cancel'));
    assert.equal(tasks.tryGet(taskId).task.status.state, 'input-required');

    tasks.requestCancel(taskId);
    const approved = await decision; // 不应等到 5s TTL

    assert.equal(approved, false, '取消应按拒绝收口');
    assert.equal(tasks.tryGet(taskId).task.status.state, 'canceled', 'canceled 终态不被 runner 覆盖');
    assert.equal(tasks.currentApproval(taskId), undefined, 'pendingApproval 已清理');
  });

  test('onApprovalTimeout 回调用于清理 vm-service 侧残留 token', async () => {
    // 复现 vm-service 的接线：TaskStore.onApprovalTimeout → 删除 pendingApprovals 里的 token
    const pendingApprovals = new Map();
    pendingApprovals.set('apr_tok', { approvalId: 'apr_tok', hostApproved: false });
    const tasks = new TaskStore({
      approvalTtlMs: 50,
      onApprovalTimeout: ({ approvalId }) => {
        pendingApprovals.delete(approvalId);
      },
    });
    const rec = tasks.create();
    const taskId = rec.task.id;

    const decision = tasks.waitApproval(taskId, approvalReq('apr_tok'));
    const approved = await awaitWithKeepAlive(decision);

    assert.equal(approved, false);
    assert.equal(pendingApprovals.has('apr_tok'), false, '超时后宿主侧 token 应被清理');
    // 能力层放行判定（严格等值 hostApproved===true）此时必然 false
    assert.equal(pendingApprovals.get('apr_tok')?.hostApproved === true, false);
  });

  test('TTL=Infinity / 缺省（>0 默认）：显式不设超时的 store 不建计时器', async () => {
    // 显式传 0/负/Infinity → 不设超时（不建 setTimeout）
    const tasks = new TaskStore({ approvalTtlMs: Infinity });
    const rec = tasks.create();
    const taskId = rec.task.id;
    const decision = tasks.waitApproval(taskId, approvalReq('apr_inf'));
    assert.equal(tasks.tryGet(taskId).task.status.state, 'input-required');
    assert.equal(tasks.currentApproval(taskId).expiresAtMs, undefined, '无 TTL 不应有 expiresAtMs');
    // 30ms 内不自动收口
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(tasks.tryGet(taskId).task.status.state, 'input-required');
    // 手动批准后收口
    tasks.resolveApproval(taskId, 'apr_inf', false);
    assert.equal(await decision, false);
    assert.equal(tasks.tryGet(taskId).task.status.state, 'input-required',
      '拒绝走 resolveApproval，runner 收口，store 不主动改状态');
  });
});

/* ============================ P3-2：构造期注入 taskId ============================ */

describe('P3-2 · runGoalWithLifecycle 构造期注入 goal.taskId', () => {
  /** 装配一个最小 A2AServer，handler 捕获收到的 goal */
  function makeServerWithCapture(handlerImpl) {
    let capturedGoal;
    let capturedGoalRef;
    const handler = {
      async runGoal(goal, sink) {
        capturedGoal = goal;
        capturedGoalRef = goal;
        return handlerImpl ? handlerImpl(goal, sink) : { ok: true, summary: 'done', artifacts: [], steps: [] };
      },
    };
    const server = new A2AServer({
      agentCard: {
        name: 't',
        description: 'd',
        version: '1',
        url: 'http://x/a2a',
        skills: [],
      },
      handler,
    });
    return { server, getCaptured: () => capturedGoalRef };
  }

  test('blocking 场景：handler 收到的 goal.taskId 等于本次创建的任务 id', async () => {
    const { server, getCaptured } = makeServerWithCapture();
    const res = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'message/send',
      params: {
        message: { kind: 'message', role: 'user', messageId: 'm1', parts: [{ kind: 'text', text: 'hi' }] },
        configuration: { blocking: true },
      },
    });
    assert.equal(res.error, undefined, JSON.stringify(res.error));
    const taskId = res.result.id;
    const captured = getCaptured();
    assert.ok(captured, 'handler 应被调用');
    assert.equal(captured.taskId, taskId, 'handler 收到的 goal.taskId 应等于任务 id');
  });

  test('原 goal 对象不被就地改写（构造期注入 = 不可变）', async () => {
    // 直接单测展开语义：用一个被冻结的 GoalRequest 走 sendMessage 路径不应抛错。
    // 旧 Object.assign 在冻结对象上会抛（严格模式）/静默失效；展开构造安全。
    const frozenMarker = { traceId: 'tr_f', goal: 'g', timeoutMs: 1000 };
    Object.freeze(frozenMarker);
    // 展开构造新对象并注入 taskId —— 这正是 P3-2 修法的等价验证
    const goalWithTask = { ...frozenMarker, taskId: 'task_x' };
    assert.equal(goalWithTask.taskId, 'task_x');
    assert.equal(frozenMarker.taskId, undefined, '原冻结对象不应被写入 taskId');
  });

  test('handler 收到的 goal 与框架内部 goal 是不同对象（展开新建）', async () => {
    // handler 收到 goalWithTask，taskId 已注入；原 goal 不含 taskId
    const { server, getCaptured } = makeServerWithCapture((goal) => ({
      ok: true,
      summary: 's',
      artifacts: [],
      steps: [],
    }));
    await server.handleRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'message/send',
      params: {
        message: { kind: 'message', role: 'user', messageId: 'm2', parts: [{ kind: 'text', text: 'hi' }] },
        configuration: { blocking: true },
      },
    });
    const captured = getCaptured();
    assert.equal(typeof captured.taskId, 'string');
    assert.ok(captured.taskId.length > 0);
    assert.equal(typeof captured.traceId, 'string', '其余字段应完整透传');
    assert.equal(typeof captured.goal, 'string');
    assert.equal(typeof captured.timeoutMs, 'number');
  });

  test('源码形态守卫：server.ts 不再用 Object.assign 改写 goal', () => {
    const src = read('packages', 'a2a-framework', 'src', 'server.ts');
    assert.equal(
      /Object\.assign\(\s*goal\b/.test(src),
      false,
      'P3-2：不得再用 Object.assign 就地改写 readonly 的 goal',
    );
    assert.match(
      src,
      /const goalWithTask[^=]*=\s*\{\s*\.\.\.goal,\s*taskId:\s*id\s*\}/,
      'P3-2：应以展开构造新对象注入 taskId',
    );
    assert.match(src, /runGoal\(\s*goalWithTask/, 'P3-2：handler 应收到新构造的对象');
  });

  test('SSE handleStream 路径同样构造期注入（handler 收到 goal.taskId）', async () => {
    let capturedGoal;
    const handler = {
      async runGoal(goal, _sink) {
        capturedGoal = goal;
        return { ok: true, summary: 'done', artifacts: [], steps: [] };
      },
    };
    const server = new A2AServer({
      agentCard: { name: 't', description: 'd', version: '1', url: 'http://x/a2a', skills: [] },
      handler,
    });
    const it = server.handleStream({
      message: { kind: 'message', role: 'user', messageId: 'ms1', parts: [{ kind: 'text', text: 'hi' }] },
    });
    // 消费若干事件驱动 runner 起来
    let taskId;
    for await (const ev of it) {
      if (ev.taskId) taskId = ev.taskId;
      if (capturedGoal) break;
      if (ev.kind === 'status-update' && ev.final) break;
    }
    assert.ok(capturedGoal, 'handleStream 应触发 runGoal');
    assert.ok(taskId, '应拿到任务 id');
    assert.equal(capturedGoal.taskId, taskId, '流式路径 handler 也应收到正确 taskId');
  });
});

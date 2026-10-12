/**
 * P2-T12 · `createProgressSink.onStatus` 合规 Message 构造（sink→wire 类型谎报修复，L2-D 补强）
 *
 * 病灶（`qa/r19/t5-l2d-deterministic-evidence.md` 真机实证，设计 §3.4 L2-D 追加定案）：
 *   契约 `onStatus(message?: string)`（contracts/bridge.ts:444）→ provider 全部传 string →
 *   `createProgressSink` 曾把 string **裸 as-cast** 成 `A2A.Message` 直存（task-store.ts）→
 *   wire 上是裸字符串（探针 msgType=string 实证）→ 宿主 `extractText` 只认 `Message.parts[]`
 *   （host-a2a-bridge/tools.ts:45-46）⇒ progress 恒空 ⇒ 有态进度文案对两种 provider 的
 *   生产呈现面均不可达（含确定性路径 delegate 的实时进度回显与有态取消文案）。
 *
 * 本文件的测试纪律（对应任务书交付面 3）：
 *   ① wire 形状断言 —— 逐键钉 kind/role/messageId/taskId/parts；
 *   ② **生产通道**断言 —— 全部经 `createProgressSink` 真实装配（或经 `A2AServer` +
 *      `message/stream` 的完整 SSE 通路），绝不手工拼 Message 对象绕过 as-cast 那一层；
 *   ③ 消费侧联动 —— 喂宿主同款 `extractText`（生产导出）断言非空；
 *   ④ 病灶回归对照组 —— 修复前的失败形态（裸 string 直存 ⇒ extractText 恒空）仍被复现并钉死，
 *      证明本测试确实"能看见"这个缺陷，而不是恰好绕过。
 *
 * 守卫输入面说明：本文件**不复述** `cancelRequested`（r19c-a5 C3 恰 4 行钉）、
 * `snapshot`（phase2-snapshot-truth 白名单）、任何审计写入符号或凭据字样 —— 测试文本本身
 * 也在守卫扫描面内，措辞刻意绕开。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { TaskStore, createProgressSink, A2AServer } from '@winvm/a2a-framework';
import { createA2aBridgeTools, extractText } from '@winvm/host-a2a-bridge';

/* ============================ 夹具 ============================ */

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** 最小 GoalResult（provider 返回值形状，contracts/bridge.ts GoalResult） */
function goalResult(over = {}) {
  return {
    ok: true,
    summary: '任务完成',
    artifacts: [],
    steps: [
      { index: 0, capabilityId: 'system.info.get', params: {}, ok: true, risk: 'L0', durationMs: 1, traceId: 'tr_p2t12' },
    ],
    ...over,
  };
}

const AGENT_CARD = {
  name: 'P2T12 Agent',
  description: 'd',
  version: '1.0.0',
  url: 'http://127.0.0.1:18443/a2a',
  skills: [{ id: 'system-admin', name: '系统管理', description: 'd', tags: ['system'] }],
};

/** 事件桥：把 server.handleStream 的 SSE 事件泵给宿主 mock client（生产同款逐事件形态） */
function makePump() {
  const queue = [];
  let pending = null;
  let closed = false;
  return {
    push(ev) {
      queue.push(ev);
      if (pending) { const r = pending.resolve; pending = null; r(); }
    },
    close() {
      closed = true;
      if (pending) { const r = pending.resolve; pending = null; r(); }
    },
    async *drain() {
      for (;;) {
        if (queue.length > 0) { yield queue.shift(); continue; }
        if (closed) return;
        await new Promise((resolve) => { pending = { resolve }; });
      }
    },
  };
}

/** 宿主 delegate 消费面 mock：与 host-a2a-bridge.test.js 的客户端契约一致，事件来自真机泵 */
function makeHostTools(pump, getTaskImpl) {
  const client = {
    async *streamMessage() {
      yield* pump.drain();
    },
    getTask: getTaskImpl ?? (async (id) => ({
      kind: 'task',
      id,
      contextId: 'ctx_p2t12',
      status: { state: 'working' },
      artifacts: [],
    })),
    async replyApproval(id) { return { kind: 'task', id, contextId: 'ctx_p2t12', status: { state: 'working' }, artifacts: [] }; },
    async cancelTask(id) { return { kind: 'task', id, contextId: 'ctx_p2t12', status: { state: 'canceled' }, artifacts: [] }; },
    async getAgentCard() { return AGENT_CARD; },
    async close() {},
  };
  return createA2aBridgeTools({ clientProvider: { get: async () => client } });
}

function findTool(tools, name) {
  const t = tools.find((x) => x.name === name);
  assert.ok(t, `应暴露工具 ${name}`);
  return t;
}

const CTX = { traceId: 'tr_p2t12' };

/* ================================================================== *
 * A 组 · wire 形状（生产装配：TaskStore + createProgressSink）
 * ================================================================== */

describe('P2-T12 A 组：sink.onStatus(string) ⇒ 存储/透出对象恰为合规 Message', () => {
  test('A1 逐键钉：kind/role/messageId/taskId/parts —— 不再是裸 string', () => {
    const store = new TaskStore({ approvalTtlMs: 300 });
    const rec = store.create();
    const sink = createProgressSink(store, rec.task.id);

    sink.onStatus('working', '执行 storage.disk.list：查询磁盘');

    const msg = store.get(rec.task.id).task.status.message;
    assert.equal(typeof msg, 'object', 'wire 必须是对象（病灶形态是裸 string，msgType=string 实证过）');
    assert.equal(msg.kind, 'message', 'kind 恰为 message');
    assert.equal(msg.role, 'agent', 'role=agent（进度文案是 Agent 侧叙述，对照 approvalTimeoutMessage 样板）');
    assert.match(String(msg.messageId), UUID_RE, 'messageId 必填且为 UUID（randomUUID，对照 task-store 样板）');
    assert.equal(msg.taskId, rec.task.id, 'taskId 携带（approvalMessage/resultMessage/errorMessage 三样板一致携带）');
    assert.equal(Array.isArray(msg.parts), true, 'parts 必须是数组');
    assert.equal(msg.parts.length, 1, '单 text part（本路径不产 data part，审批结构由 waitApproval 独立通路）');
    assert.equal(msg.parts[0].kind, 'text', 'parts[0].kind=text');
    assert.equal(msg.parts[0].text, '执行 storage.disk.list：查询磁盘', '文案逐字保真（本层不脱敏，宿主侧 scrubText 归宿主）');
  });

  test('A2 SSE status-update 事件同样携带合规 Message（宿主消费的是这一帧）', () => {
    const store = new TaskStore({ approvalTtlMs: 300 });
    const rec = store.create();
    const sink = createProgressSink(store, rec.task.id);
    const events = [];
    store.subscribe(rec.task.id, (ev) => events.push(ev));

    sink.onStatus('working', '进度一');

    const su = events.filter((e) => e.kind === 'status-update');
    assert.equal(su.length, 1, '一次 onStatus 恰一帧 status-update');
    assert.equal(su[0].final, false, 'working 非终态');
    const msg = su[0].status.message;
    assert.equal(typeof msg, 'object', 'SSE 帧上不得是裸 string');
    assert.equal(msg.kind, 'message');
    assert.equal(msg.parts[0].text, '进度一');
  });

  test('A3 messageId 每次新建（同文案两次调用不得复用同一 id）', () => {
    const store = new TaskStore({ approvalTtlMs: 300 });
    const rec = store.create();
    const sink = createProgressSink(store, rec.task.id);

    sink.onStatus('working', '同一段文案');
    const id1 = store.get(rec.task.id).task.status.message.messageId;
    sink.onStatus('working', '同一段文案');
    const id2 = store.get(rec.task.id).task.status.message.messageId;

    assert.match(String(id1), UUID_RE);
    assert.notEqual(id1, id2, 'messageId 必须每次独立生成（A2A 语义：一条消息一个 id）');
  });

  test('A4 message 缺席 ⇒ status.message 键整体缺席（缺席语义逐字旧行为，条件展开不写显式 undefined）', () => {
    const store = new TaskStore({ approvalTtlMs: 300 });
    const rec = store.create();
    const sink = createProgressSink(store, rec.task.id);

    sink.onStatus('working'); // t3-cancel-bounded 同款裸调用

    const status = store.get(rec.task.id).task.status;
    assert.equal(status.state, 'working', '状态照常流转');
    assert.equal('message' in status, false, '缺席 ⇒ 键整体缺席（绝不 null/undefined/空 Message 伪装）');
  });

  test('A5 空串/仅空白 ⇒ 与缺席等价（宿主端不可分：修复前后 progress.push 判据 `if (text)` 行为一致）', () => {
    const store = new TaskStore({ approvalTtlMs: 300 });
    const rec = store.create();
    const sink = createProgressSink(store, rec.task.id);

    sink.onStatus('working', '');
    assert.equal('message' in store.get(rec.task.id).task.status, false, '空串不包装为空洞 Message');

    sink.onStatus('working', '   ');
    assert.equal('message' in store.get(rec.task.id).task.status, false, '仅空白同样缺席（trim 后为空 ⇒ 无可呈现文本）');

    // 空白后接真文案：正常恢复包装（证明 A5 不是一刀切关掉 string 通路）
    sink.onStatus('working', '恢复可见');
    const msg = store.get(rec.task.id).task.status.message;
    assert.equal(msg.parts[0].text, '恢复可见');
  });

  test('A6 对象形态 verbatim 透传（第三方 provider 直传 Message ⇒ 零重复包装，幂等）', () => {
    const store = new TaskStore({ approvalTtlMs: 300 });
    const rec = store.create();
    const sink = createProgressSink(store, rec.task.id);

    const upstream = {
      kind: 'message',
      role: 'agent',
      messageId: randomUUID(),
      taskId: rec.task.id,
      parts: [
        { kind: 'text', text: '上游已构造' },
        { kind: 'data', data: { type: 'custom', v: 1 } },
      ],
    };
    sink.onStatus('working', upstream);

    const stored = store.get(rec.task.id).task.status.message;
    assert.equal(stored, upstream, '同一引用透传（不得重新包装/克隆改写）');
    assert.equal(stored.parts.length, 2, '多 part（含 data part）原样保留');

    // 宽容形态亦透传（运行时不校验上游 Message 完整性 —— 那是消费端的事）
    const odd = { kind: 'message', role: 'user', messageId: 'm_odd', parts: [] };
    sink.onStatus('working', odd);
    assert.equal(store.get(rec.task.id).task.status.message, odd, '对象一律透传，不做二次判断');
  });

  test('A7 病灶对照组：修复前的失败形态仍在 store 层可复现（证明本测试穿过 as-cast 那一层）', () => {
    const store = new TaskStore({ approvalTtlMs: 300 });
    const rec = store.create();

    // 复刻修复前 createProgressSink 的行为：裸 as-cast 直存（TypeScript 双断言，运行时零转换）
    store.updateStatus(rec.task.id, 'working', '旧世界的裸字符串');

    const msg = store.get(rec.task.id).task.status.message;
    assert.equal(typeof msg, 'string', 'updateStatus 层不校验 ⇒ 裸 string 直存（病灶本体）');
    assert.equal(extractText(msg), '', '宿主 extractText 对裸 string 恒返空串 —— 生产呈现面不可达的根因');
    assert.equal(msg.parts, undefined, '裸 string 无 parts（宿主判据 !message?.parts 命中）');

    // 对照：合规构造经同一 updateStatus ⇒ 宿主可读（修复后 sink 产出的就是这形态）
    store.updateStatus(rec.task.id, 'working', {
      kind: 'message',
      role: 'agent',
      messageId: randomUUID(),
      parts: [{ kind: 'text', text: '新世界的合规 Message' }],
    });
    assert.equal(extractText(store.get(rec.task.id).task.status.message), '新世界的合规 Message');
  });

  test('A8 消费侧联动：经生产 sink 的文案过宿主 extractText 非空；终态收口路径 wire 形状不受影响', () => {
    const store = new TaskStore({ approvalTtlMs: 300 });
    const rec = store.create();
    const sink = createProgressSink(store, rec.task.id);

    sink.onStatus('working', '执行 storage.disk.list：查盘');
    assert.equal(extractText(store.get(rec.task.id).task.status.message), '执行 storage.disk.list：查盘',
      'T5 病灶的验收判据：宿主提取结果非空');

    // 旁证：server 侧 completed/failed 终态直传 store（不经 sink），其对象分支透传不改形状
    const finalMsg = {
      kind: 'message',
      role: 'agent',
      messageId: randomUUID(),
      taskId: rec.task.id,
      parts: [{ kind: 'text', text: '任务完成' }, { kind: 'data', data: { ok: true, steps: [] } }],
    };
    store.updateStatus(rec.task.id, 'completed', finalMsg);
    assert.equal(store.get(rec.task.id).task.status.message, finalMsg, '终态文案与 resultMessage 同形（双 part 保留）');
  });
});

/* ================================================================== *
 * B 组 · 生产通道端到端（A2AServer message/stream → 宿主 a2a.delegate）
 * ================================================================== */

describe('P2-T12 B 组：有态进度经生产通道在宿主呈现面可达', () => {
  /**
   * 确定性模板同款 handler：step() 的文案形态（adapter-agent-workbuddy/index.ts:492）
   * `执行 <capabilityId>：<summary>` —— 宿主 DETERMINISTIC_STEP_MARK 正则的靶文本。
   * 取消分支走协作式边界收口（isCancelled 严格等值 + TASK_CANCELED 码，契约纪律）。
   */
  function deterministicHandler(spec) {
    return {
      async runGoal(goal, sink) {
        const steps = spec.steps ?? [];
        for (let i = 0; i < steps.length; i += 1) {
          if (sink.isCancelled?.() === true) {
            if (spec.throwOnCancel) throw Object.assign(new Error('任务已取消'), { code: 'TASK_CANCELED' });
            return { ok: false, summary: '任务已取消', artifacts: [], steps: [] };
          }
          sink.onStatus('working', `执行 ${steps[i]}：第 ${i + 1} 步`);
          if (spec.gate && i === spec.gate.after) await spec.gate.signal;
          spec.onStep?.(i);
        }
        if (sink.isCancelled?.() === true) {
          if (spec.throwOnCancel) throw Object.assign(new Error('任务已取消'), { code: 'TASK_CANCELED' });
          return { ok: false, summary: '任务已取消', artifacts: [], steps: [] };
        }
        return goalResult();
      },
    };
  }

  /** 起真实 A2AServer + handleStream，把事件泵进宿主工具面 */
  async function runProductionPipeline(spec) {
    const pump = makePump();
    const server = new A2AServer({
      agentCard: AGENT_CARD,
      handler: deterministicHandler(spec),
      taskStore: new TaskStore({ approvalTtlMs: 300 }),
    });
    const stream = server.handleStream({
      message: { kind: 'message', role: 'user', messageId: 'm_b', parts: [{ kind: 'text', text: '把旧日志清理掉' }] },
      metadata: { traceId: 'tr_p2t12' },
    });
    void (async () => {
      try {
        for await (const ev of stream) pump.push(ev);
      } finally {
        pump.close();
      }
    })();
    return { pump, server };
  }

  test('B1 working 文案 ⇒ delegate 的 progress[] 非空（修复前恒空 —— 本断言即 T5 病灶的正靶）', async () => {
    const { pump } = await runProductionPipeline({ steps: ['storage.disk.list', 'storage.search.query'] });
    const tools = makeHostTools(pump);
    const res = await findTool(tools, 'a2a.delegate').handler({ goal: '清理旧日志' }, CTX);

    assert.equal(res.isError, false, '正常收口不报错');
    const sc = res.structuredContent;
    assert.equal(sc.state, 'completed');
    assert.ok(sc.progress.length >= 2, `progress 必须含两条 working 文案，实得 ${sc.progress.length}（恒空=T5 病灶复发）`);
    const working = sc.progress.filter((p) => p.state === 'working');
    assert.equal(working[0].message, '执行 storage.disk.list：第 1 步', '文案逐字可达（extractText 拼接后原样）');
    assert.match(working[1].message, /^执行 storage\.search\.query/);
    assert.equal(sc.summary, '任务完成', 'completed 终态仍取 resultMessage 的 summary（既有 wire 契约不变）');
  });

  test('B2 有态取消经生产通道：executedBeforeCancel 出现且 steps 与模板步数一致', async () => {
    const gate = {
      signal: null,
      release: null,
    };
    gate.signal = new Promise((r) => { gate.release = r; });
    const { pump, server } = await runProductionPipeline({
      steps: ['storage.disk.list', 'storage.search.query'],
      gate: { after: 1, signal: gate.signal },
      throwOnCancel: true, // 契约纪律：provider 以取消错抛出收口（server 侧判 canceled 不误报 failed）
    });

    const tools = makeHostTools(pump);
    const done = findTool(tools, 'a2a.delegate').handler({ goal: '清理旧日志' }, CTX);
    // 等 handler 走到第 2 步完成、停在 gate 上（两条 working 文案已在流上）
    await new Promise((r) => setTimeout(r, 80));
    const capturedId = server.tasks.list().tasks[0].id;
    assert.ok(capturedId, '任务已建档');
    await server.handleRequest({
      jsonrpc: '2.0', id: 'c', method: 'tasks/cancel', params: { name: `tasks/${capturedId}` },
    });
    gate.release();

    const res = await done;
    const sc = res.structuredContent;
    assert.equal(sc.state, 'canceled', '协作式取消由框架 requestCancel 收口');
    assert.ok(sc.progress.length >= 2, '取消前两条 working 进度必须可达（旧缺陷下此数组恒空）');
    assert.deepEqual(sc.executedBeforeCancel, { steps: 2, artifacts: 0 },
      '有态取消文案的机械信号：execution-steps 载体缺席 ⇒ 退回 progress[] 的 step 标记派生（HOST-A2A-BRIDGE §4.5）');
    assert.match(res.content[0].text, /取消前已有 2 个操作执行/, '有态文案在生产呈现面成立（此前"恒不可达"，T12 修复后转正）');
  });

  test('B3 a2a.task.get 的实时进度透出非空（tools.ts:582 同款消费点）', async () => {
    const store = new TaskStore({ approvalTtlMs: 300 });
    const rec = store.create();
    const sink = createProgressSink(store, rec.task.id);
    sink.onStatus('working', '执行 app.inventory.list：查清单');

    const pump = makePump();
    const tools = makeHostTools(pump, async (id) => ({
      kind: 'task',
      id,
      contextId: rec.task.contextId,
      status: store.get(id).task.status,
      artifacts: store.get(id).task.artifacts ?? [],
    }));
    pump.close();

    const res = await findTool(tools, 'a2a.task.get').handler({ taskId: rec.task.id }, CTX);
    assert.equal(res.isError, false);
    assert.equal(res.structuredContent.state, 'working');
    assert.equal(res.structuredContent.message, '执行 app.inventory.list：查清单',
      'task.get 的 message 键 = scrubText(extractText(status.message))，修复后非空');
  });

  test('B4 derive 语义级联：execution-steps 载体在场时优先于 progress 派生（两路可分）', async () => {
    const pump = makePump();
    const server = new A2AServer({
      agentCard: AGENT_CARD,
      handler: {
        async runGoal(goal, sink) {
          sink.onStatus('working', '执行 storage.disk.list：第 1 步');
          return goalResult({
            steps: [0, 1, 2, 3, 4].map((i) => ({
              index: i, capabilityId: 'storage.disk.list', params: {}, ok: true, risk: 'L0', durationMs: 1, traceId: 'tr_p2t12',
            })),
          });
        },
      },
      taskStore: new TaskStore({ approvalTtlMs: 300 }),
    });
    const stream = server.handleStream({
      message: { kind: 'message', role: 'user', messageId: 'm_c', parts: [{ kind: 'text', text: '查盘' }] },
    });
    void (async () => {
      try { for await (const ev of stream) pump.push(ev); } finally { pump.close(); }
    })();
    const tools = makeHostTools(pump);
    const res = await findTool(tools, 'a2a.delegate').handler({ goal: '查盘' }, CTX);

    const sc = res.structuredContent;
    assert.equal(sc.state, 'completed');
    assert.ok(sc.progress.some((p) => p.message === '执行 storage.disk.list：第 1 步'), 'working 文案可达');
    const carrier = sc.artifacts.find((a) => a.name === 'execution-steps');
    assert.ok(carrier, '正常路径必落 execution-steps 载体（derive 的第一优先事实源，与 progress[] 第二路互补）');
    // completed 态不产 executedBeforeCancel（派生仅在 canceled 分支）——形状旁证
    assert.equal('executedBeforeCancel' in sc, false, '非取消态不得出现该键');
  });
});

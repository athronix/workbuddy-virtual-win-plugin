/**
 * Phase 2 · P2-T7 行为守卫 —— TaskStore 驱逐可观测化（F3 / L1 / QA §4-B4 闭环）
 *
 * 覆盖设计 §3.1 三件事中的**①②两件**（③长会话真实观测是真机项，落 `qa/r19/t7-*`，不在本文件）：
 *   ① 驱逐显形（机制侧）
 *      a. `evictedCount()` 单调不减，且**只在真实删除路径**上自增（不逐 ⇒ 不计数）
 *      b. `evictionLog()` 有界环形（容量常量钉死 + 覆盖序「最旧→最新」+ 返回拷贝）
 *      c. 双闸门各自给出正确的 `gate` 值（`'ttl'` / `'overflow'`，由调用点显式传入不反推）
 *      d. 候选三条件不满足时（挂起审批 / 取消在飞 / 活动任务）**既不删也不计数**
 *      e. `onEviction` 结构化回调（与 `onApprovalTimeout` 同构；观察者异常**绝不影响**驱逐）
 *   ② 可区分语义（呈现侧）
 *      f. `wasEvicted()` 归因窗口：窗口内 true、窗口外**诚实 false**（不谎称曾存在）
 *      g. 协议面 `tasks/get`：被逐 id ⇒ `data.evicted:true`；从未存在的 id ⇒ 键**整体缺席**
 *         （旧响应体逐字节钉，K-13「缺席即旧行为」铁律）
 *   契约与装配面（静态钉）
 *      h. `Contracts.TasksHealth.evictedCount?` 纯附加可选；`/health.tasks` 追加键在既有三键之后
 *      i. `AuditExt.kind` 含 `'task-evicted'`（链上取证键在位）；框架层零审计符号
 *   vm-service 落链件（纯函数 + 投递器，全部脱服务直测）
 *      j. `buildTaskEvictedAuditEntry` 聚合形态（闸门分布 / 样本上界 / internal 主体 / meta 能力域）
 *      k. `createTaskEvictedChainRecorder` 突发合并为**一条**；收口位生效；append 失败只 warn
 *
 * 既有钉保全：`tests/unit/phase1-t3-cancel-bounded.test.js`（29 例）钉死既有驱逐行为；
 * `r19c-a5-approval-coordinator` C3 钉死 task-store.ts 内 `cancelRequested` 出现点恰 4 行
 * —— 本任务改动一律不得新增该标识符（本文件把它作为**显式断言**再钉一次）。
 *
 * 运行（逐文件，绝不整批 glob）：
 *   node --test tests/unit/phase2-task-store-evict-observe.test.js
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { A2AServer, TaskStore, TaskNotFoundError } from '@winvm/a2a-framework';
import {
  buildTaskEvictedAuditEntry,
  createTaskEvictedChainRecorder,
  TASK_EVICT_SAMPLE_LIMIT,
} from '@winvm/vm-service';

/* ------------------------------------------------------------------ *
 * 路径：沙箱内 cwd 会失效，一律用 import.meta.url 推导绝对路径
 * ------------------------------------------------------------------ */
const SRC_TASK_STORE = new URL('../../packages/a2a-framework/src/task-store.ts', import.meta.url);
const SRC_A2A_SERVER = new URL('../../packages/a2a-framework/src/server.ts', import.meta.url);
const SRC_VM_SERVER = new URL('../../packages/vm-service/src/server.ts', import.meta.url);
const SRC_BRIDGE = new URL('../../packages/contracts/src/bridge.ts', import.meta.url);
const SRC_AUDIT = new URL('../../packages/contracts/src/audit.ts', import.meta.url);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 环形容量（与源码常量同值，本文件**独立写死**）。
 * 判据是「有界性」而非实现细节 ⇒ 有人把容量悄悄调大也应当红（改本常量必须同时改源码，
 * 并在回报中说明理由）。
 */
const RING_CAP = 64;

/** 最小 GoalResult 夹具（与 phase1-t3 同形，provider 返回值形状） */
function goalResult(over = {}) {
  return {
    ok: true,
    summary: 'done',
    artifacts: [],
    steps: [
      {
        index: 0,
        capabilityId: 'system.info.get',
        params: {},
        ok: true,
        risk: 'L0',
        durationMs: 1,
        traceId: 'tr_t7',
      },
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

/** 造一个终态任务（默认 completed） */
function terminalTask(store, state = 'completed') {
  const rec = store.create();
  store.updateStatus(rec.task.id, state);
  return rec;
}

/**
 * 造一个「可被逐」的终态任务，且**驱逐只发生在下一次 create**（maxTasks:1 时的节奏：
 * 第 1 次 create 不逐，第 k(≥2) 次逐掉第 k−1 个）。返回 id 序列便于精确对账。
 */
function directA2ARequest(store, params) {
  const server = new A2AServer({
    agentCard: {
      name: 'T7 Test Agent',
      description: 'd',
      version: '1.0.0',
      url: 'http://127.0.0.1:18443/a2a',
      skills: [{ id: 'system-admin', name: '系统管理', description: 'd', tags: ['system'] }],
    },
    handler: { async runGoal() { return goalResult(); } },
    defaultMaxRisk: 'L2',
    taskStore: store,
  });
  return server.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tasks/get', params });
}

/* ================================================================== *
 * ①-a 计数单调
 * ================================================================== */

describe('P2-T7 ①a 驱逐计数单调', () => {
  test('起点 0；每条真实驱逐恰 +1；条数与计数两个口径不混', () => {
    const store = new TaskStore({ maxTasks: 2, terminalTtlMs: Number.POSITIVE_INFINITY });
    assert.equal(store.evictedCount(), 0, '新建 store ⇒ 计数从 0 起（不得继承进程内旧值）');
    const a = terminalTask(store);
    const b = terminalTask(store);
    assert.equal(store.evictedCount(), 0, '未超上限 ⇒ 一条都不逐，也不得计数');
    for (let i = 0; i < 5; i += 1) terminalTask(store);
    assert.equal(store.evictedCount(), 5, '5 次溢出 ⇒ 恰计 5 次');
    assert.equal(store.size(), 2, 'size() 仍是「表内驻留量」，语义逐字不变');
    void a;
    void b;
  });

  test('计数单调不减（同一 store 反复读，只可能持平或上升）', () => {
    const store = new TaskStore({ maxTasks: 1, terminalTtlMs: Number.POSITIVE_INFINITY });
    let prev = 0;
    for (let i = 0; i < 12; i += 1) {
      terminalTask(store);
      const now = store.evictedCount();
      assert.ok(now >= prev, `计数不得回退：${prev} → ${now}`);
      prev = now;
    }
    assert.equal(prev, 11, 'maxTasks:1 节奏下第 k 次 create 逐第 k−1 条 ⇒ 恰 11');
  });

  test('只读路径不计数（O-11 的观测面对称面：get/list/tryGet/subscribe 一律不动）', () => {
    const store = new TaskStore({ maxTasks: 5, terminalTtlMs: 20 });
    const victim = terminalTask(store);
    victim.terminalAtMs = Date.now() - 10_000; // 已过期，但只能等 create() 才回收
    store.get(victim.task.id);
    store.tryGet(victim.task.id);
    store.list({ pageSize: 10 });
    store.size();
    store.evictedCount();
    store.evictionLog();
    store.wasEvicted(victim.task.id);
    const unsub = store.subscribe(victim.task.id, () => {});
    unsub();
    assert.equal(store.evictedCount(), 0, '判据：没有被删除就不许出现计数');
    assert.equal(store.evictionLog().length, 0, '只读路径不得写环形日志');
    store.create(); // 唯一触发点
    assert.equal(store.evictedCount(), 1, 'create 尾部才计第一次');
  });

  test('maxTasks 关闭（0 / 负数 / Infinity）⇒ 计数恒 0、环恒空（旧行为逐字保留）', () => {
    for (const maxTasks of [0, -1, Number.POSITIVE_INFINITY]) {
      const store = new TaskStore({ maxTasks });
      for (let i = 0; i < 60; i += 1) terminalTask(store);
      assert.equal(store.size(), 60, `maxTasks=${maxTasks} ⇒ 一条都不逐`);
      assert.equal(store.evictedCount(), 0, `maxTasks=${maxTasks} ⇒ 驱逐这件事不存在，计数必须恒 0`);
      assert.deepEqual(store.evictionLog(), [], `maxTasks=${maxTasks} ⇒ 环形日志必须为空`);
      assert.equal(store.wasEvicted('anything'), false, '关闭态下不得给出任何归因结论');
    }
  });
});

/* ================================================================== *
 * ①-b 有界环形日志
 * ================================================================== */

describe('P2-T7 ①b 有界环形日志', () => {
  test(`容量恰 ${RING_CAP}：写满后覆盖最旧，长度不再增长，序为「最旧 → 最新」`, () => {
    const store = new TaskStore({ maxTasks: 1, terminalTtlMs: Number.POSITIVE_INFINITY });
    const ids = [];
    for (let i = 0; i < RING_CAP + 20; i += 1) ids.push(terminalTask(store).task.id);
    const log = store.evictionLog();
    assert.equal(log.length, RING_CAP, `环形日志必须恰 ${RING_CAP} 条（有界性是硬约束）`);
    assert.equal(store.evictedCount(), RING_CAP + 19, '计数不受环形上界约束（单调累计）');
    // maxTasks:1 的节奏：第 k(≥2) 次 create 逐掉第 k−1 条 ⇒ 驱逐序列 = ids[0 .. len-2]
    // （最后一次 create 产出的那条仍在场，未被逐）⇒ 环形应留其中最后 RING_CAP 条。
    const evictedOrder = ids.slice(0, -1);
    assert.equal(store.evictedCount(), evictedOrder.length, '夹具自检：驱逐序列长度与计数一致');
    assert.deepEqual(
      log.map((r) => r.id),
      evictedOrder.slice(-RING_CAP),
      '日志必须是「最近 RING_CAP 次驱逐」且按最旧→最新排列（重排错位即红）',
    );
    assert.equal(store.wasEvicted(ids.at(-1)), false, '最后 create 的任务仍在场 ⇒ 不得被归因成已逐');
  });

  test('未满时从 0 起读（环形重排起点判据，防「cursor 语义写反」）', () => {
    const store = new TaskStore({ maxTasks: 1, terminalTtlMs: Number.POSITIVE_INFINITY });
    const a = terminalTask(store);
    const b = terminalTask(store); // 逐 a
    const c = terminalTask(store); // 逐 b
    assert.deepEqual(store.evictionLog().map((r) => r.id), [a.task.id, b.task.id], '未满时按写入序');
    void c;
  });

  test('返回拷贝：外部改写不得污染内部环', () => {
    const store = new TaskStore({ maxTasks: 1, terminalTtlMs: Number.POSITIVE_INFINITY });
    const a = terminalTask(store);
    terminalTask(store); // 逐 a
    const first = store.evictionLog();
    assert.equal(first.length, 1);
    const before = first[0].id;
    first.pop(); // 外部拿到的是普通数组拷贝
    assert.equal(store.evictionLog().length, 1, '外部 pop 不得缩短内部环');
    assert.equal(store.evictionLog()[0].id, before, '内部条目不受外部改写影响');
  });

  test('只存元数据：键集恰 {id,terminalState,evictedAtMs,gate}（W-2：不得夹带任务内容）', () => {
    const store = new TaskStore({ maxTasks: 1, terminalTtlMs: Number.POSITIVE_INFINITY });
    const rec = store.create({ metadata: { secret: 'task-content-must-not-leak' } });
    store.addArtifact(rec.task.id, {
      artifactId: 'art1',
      name: 'a',
      parts: [{ kind: 'text', text: 'artifact-body' }],
    });
    store.updateStatus(rec.task.id, 'completed');
    terminalTask(store); // 驱逐 rec
    const entry = store.evictionLog()[0];
    assert.deepEqual(
      Object.keys(entry).sort(),
      ['evictedAtMs', 'gate', 'id', 'terminalState'],
      '驱逐日志只允许这四个元数据键（多一个键就可能把任务内容/保留期事实带上链）',
    );
    const text = JSON.stringify(entry);
    assert.ok(!text.includes('task-content-must-not-leak'), 'metadata 内容绝不得出现在驱逐条目里');
    assert.ok(!text.includes('artifact-body'), 'artifact 内容绝不得出现在驱逐条目里');
  });
});

/* ================================================================== *
 * ①-c 双闸门 gate 值
 * ================================================================== */

describe('P2-T7 ①c 双闸门归因（gate 由调用点显式传入，不反推）', () => {
  test('TTL 闸门 ⇒ gate=ttl；溢出闸门 ⇒ gate=overflow', async () => {
    const ttlStore = new TaskStore({ maxTasks: 100, terminalTtlMs: 20 });
    const a = terminalTask(ttlStore);
    const b = terminalTask(ttlStore);
    await sleep(40);
    terminalTask(ttlStore); // create 尾部 ⇒ TTL 清扫两条
    const log = ttlStore.evictionLog();
    assert.equal(log.length, 2, '两条过期终态都被回收');
    assert.deepEqual(log.map((r) => r.gate), ['ttl', 'ttl'], '过期终态回收必须标 ttl');
    assert.deepEqual(log.map((r) => r.id), [a.task.id, b.task.id]);

    const ovfStore = new TaskStore({ maxTasks: 2, terminalTtlMs: Number.POSITIVE_INFINITY });
    const x = terminalTask(ovfStore);
    terminalTask(ovfStore);
    terminalTask(ovfStore); // 溢出 1 ⇒ 条数闸门
    assert.equal(ovfStore.evictionLog().length, 1);
    assert.equal(ovfStore.evictionLog()[0].gate, 'overflow', '超上限回收必须标 overflow');
    assert.equal(ovfStore.evictionLog()[0].id, x.task.id, '溢出轮逐的是最旧终态');
  });

  test('同一突发内两路闸门各归各路（TTL 先扫，条数闸门不冒名顶替）', async () => {
    const store = new TaskStore({ maxTasks: 1, terminalTtlMs: 20 });
    const t1 = terminalTask(store);
    await sleep(40);
    t1.terminalAtMs = Date.now() - 10_000; // 明确过期
    const t2 = store.create(); // TTL 回收 t1 ⇒ 无需条数闸门
    const last = store.evictionLog().at(-1);
    assert.equal(last.gate, 'ttl', '闸门归因必须取真实发生的那一路，不得统一写 overflow');
    assert.equal(last.id, t1.task.id);
    void t2;
  });

  test('gate 值域封闭（只可能 ttl|overflow ⇒ 新闸门未登记即红）', () => {
    const store = new TaskStore({ maxTasks: 1, terminalTtlMs: Number.POSITIVE_INFINITY });
    for (let i = 0; i < 6; i += 1) terminalTask(store);
    for (const r of store.evictionLog()) {
      assert.ok(r.gate === 'ttl' || r.gate === 'overflow', `未知 gate 值：${String(r.gate)}`);
    }
  });

  test('terminalState 如实取被逐时刻的状态；evictedAtMs 是毫秒时间戳', () => {
    const store = new TaskStore({ maxTasks: 1, terminalTtlMs: Number.POSITIVE_INFINITY });
    const c = terminalTask(store, 'completed');
    const f = terminalTask(store, 'failed');
    terminalTask(store, 'canceled');
    const log = store.evictionLog();
    assert.equal(log[0].id, c.task.id);
    assert.equal(log[0].terminalState, 'completed');
    assert.equal(log[1].id, f.task.id);
    assert.equal(log[1].terminalState, 'failed');
    assert.equal(typeof log[0].evictedAtMs, 'number');
    assert.ok(log[0].evictedAtMs <= Date.now(), 'evictedAtMs 必须是毫秒时间戳而非 ISO 串');
  });

  test('TTL 关闭（terminalTtlMs 非法）⇒ 只可能产生 overflow 归因，不得冒出 ttl', () => {
    const store = new TaskStore({ maxTasks: 2, terminalTtlMs: 0 });
    for (let i = 0; i < 8; i += 1) terminalTask(store);
    assert.ok(store.evictionLog().length > 0, '夹具自检：应确有驱逐');
    assert.ok(
      store.evictionLog().every((r) => r.gate === 'overflow'),
      'terminalTtlMs=0 ⇒ TTL 闸门禁用 ⇒ 归因不得出现 ttl',
    );
  });
});

/* ================================================================== *
 * ①-d 候选三条件：不逐 ⇒ 不计数
 * ================================================================== */

describe('P2-T7 ①d 候选三条件与计数一致性', () => {
  test('活动任务 / 挂起审批 / 取消在飞：不删也不计数（三个可见面同步诚实）', () => {
    const store = new TaskStore({
      approvalTtlMs: 5_000,
      maxTasks: 1,
      terminalTtlMs: Number.POSITIVE_INFINITY,
    });
    const live = store.create();
    store.updateStatus(live.task.id, 'working');
    const held = store.create();
    void store.waitApproval(held.task.id, approvalReq('apr_t7'));
    const inflight = store.create();
    inflight.cancelController.abort('canceled'); // 探针：取消在飞（非终态）

    store.create(); // 触发条数闸门：合法候选 = 0 ⇒ 一条都不能逐

    assert.equal(store.evictedCount(), 0, '判据：没删除就不许计数（观测面与真实删除一一对应）');
    assert.equal(store.evictionLog().length, 0, '没删除就不许写环形日志');
    assert.equal(store.wasEvicted(live.task.id), false, '未驱逐的 id 不得被误归因');
    assert.ok(store.tryGet(held.task.id), '挂起审批任务必留（吞掉人工决策是红线）');
    assert.ok(store.tryGet(inflight.task.id), '取消在飞必留（runner 收口仍要找得到记录）');
    assert.ok(store.tryGet(live.task.id), '活动任务必留');
    assert.equal(store.currentApproval(held.task.id) !== undefined, true, '保留的挂起审批仍完整');
  });

  test('混合场景：唯一合法候选被逐 ⇒ 计数恰 +1，其余仍留', () => {
    const store = new TaskStore({
      approvalTtlMs: 5_000,
      maxTasks: 1,
      terminalTtlMs: Number.POSITIVE_INFINITY,
    });
    const normal = store.create();
    store.updateStatus(normal.task.id, 'failed'); // 唯一候选
    const live = store.create();
    store.updateStatus(live.task.id, 'working');
    const held = store.create();
    void store.waitApproval(held.task.id, approvalReq('apr_t7_mix'));
    store.create();

    assert.equal(store.evictedCount(), 1);
    assert.equal(store.tryGet(normal.task.id), undefined, '合法候选必须被逐');
    assert.ok(store.tryGet(live.task.id) && store.tryGet(held.task.id), '非候选必留');
    assert.equal(store.evictionLog()[0].id, normal.task.id);
    assert.equal(store.evictionLog()[0].terminalState, 'failed');
    assert.equal(store.wasEvicted(normal.task.id), true, '被逐者立即可归因');
    assert.equal(store.wasEvicted(live.task.id), false, '未被逐者不得被归因');
  });

  test('「终态 + 已 abort 且非 canceled」的怪状态：保守不逐 ⇒ 也不计数', () => {
    const store = new TaskStore({ maxTasks: 1, terminalTtlMs: Number.POSITIVE_INFINITY });
    const odd = store.create();
    odd.cancelController.abort('canceled');
    store.updateStatus(odd.task.id, 'completed'); // 绕过 requestCancel 的写入者形态
    store.create();
    assert.equal(store.evictedCount(), 0, '保守不逐就不得计数（判据与删除必须同一处）');
    assert.ok(store.tryGet(odd.task.id));
  });
});

/* ================================================================== *
 * ①-e onEviction 回调
 * ================================================================== */

describe('P2-T7 ①e onEviction 结构化回调', () => {
  test('每条驱逐回调恰一次，序列与环形日志同源同序', () => {
    const seen = [];
    const store = new TaskStore({
      maxTasks: 2,
      terminalTtlMs: Number.POSITIVE_INFINITY,
      onEviction: (info) => seen.push(info),
    });
    const a = terminalTask(store, 'completed');
    terminalTask(store, 'failed'); // 未溢出 ⇒ 不得有回调
    assert.deepEqual(seen, [], '未驱逐 ⇒ 不得有任何回调');
    const c = terminalTask(store, 'canceled'); // 溢出 1 ⇒ 逐 a
    assert.equal(seen.length, 1);
    assert.equal(seen[0].id, a.task.id);
    assert.equal(seen[0].gate, 'overflow');
    assert.equal(seen[0].terminalState, 'completed');
    terminalTask(store, 'rejected'); // 逐 b
    assert.equal(seen.length, 2);
    const ring = store.evictionLog();
    assert.deepEqual(
      seen.map((s) => s.id),
      ring.map((r) => r.id),
      '回调序列与环形日志必须同源同序（两处口径打架即说谎）',
    );
    void c;
  });

  test('观察者异常被吞：绝不影响驱逐本身（取证面不得升级为可用性事故）', () => {
    let called = 0;
    const store = new TaskStore({
      maxTasks: 1,
      terminalTtlMs: Number.POSITIVE_INFINITY,
      onEviction: () => {
        called += 1;
        throw new Error('observer exploded');
      },
    });
    const a = terminalTask(store);
    const b = terminalTask(store, 'failed');
    assert.equal(called, 1, '回调确实被调用过（异常发生在回调内而非未调用）');
    assert.equal(store.tryGet(a.task.id), undefined, '回调抛错不得阻止回收（有界化是 R5 安全阀）');
    assert.equal(store.evictedCount(), 1, '计数与环形仍必须落账（观测面写入先于回调，互不牵连）');
    assert.ok(store.tryGet(b.task.id), '后续任务照常');
  });

  test('缺席即旧行为：不传 onEviction ⇒ 机制面（计数/环形/归因）仍完整', () => {
    const store = new TaskStore({ maxTasks: 1, terminalTtlMs: Number.POSITIVE_INFINITY });
    terminalTask(store);
    terminalTask(store);
    assert.equal(store.evictedCount(), 1);
    assert.equal(store.evictionLog().length, 1);
  });
});

/* ================================================================== *
 * ②-f/g 归因可分
 * ================================================================== */

describe('P2-T7 ②f wasEvicted 归因窗口的三条诚实边界', () => {
  test('窗口内 true；从未存在 false；窗口外（被环形覆盖）诚实 false', () => {
    const store = new TaskStore({ maxTasks: 1, terminalTtlMs: Number.POSITIVE_INFINITY });
    const first = terminalTask(store);
    terminalTask(store); // 逐 first
    assert.equal(store.wasEvicted(first.task.id), true, '窗口内必须给出肯定归因');
    assert.equal(store.wasEvicted('never-existed-id'), false, '从未存在的 id 不得被归因成曾被驱逐');

    for (let i = 0; i < RING_CAP + 2; i += 1) terminalTask(store); // 把 first 挤出窗口
    assert.equal(store.wasEvicted(first.task.id), false, '窗口外必须诚实 false，绝不谎称「曾存在」');
    assert.equal(store.evictionLog().length, RING_CAP, '归因窗口 = 环形容量（两者必须是同一个界）');
  });

  test('TaskNotFoundError.evicted：第二参可选且默认 false ⇒ 旧构造点逐字旧行为', () => {
    const plain = new TaskNotFoundError('t1');
    assert.equal(plain.evicted, false, '既有 `new TaskNotFoundError(id)` 必须合法且语义不变');
    assert.equal(plain.name, 'TaskNotFoundError');
    assert.equal(plain.message, '任务不存在或不可访问：t1', '错误文本必须逐字不变（归因只走结构化键）');
    const flagged = new TaskNotFoundError('t2', true);
    assert.equal(flagged.evicted, true);
    assert.equal(flagged.message, '任务不存在或不可访问：t2', '带归因也不改文本');
    assert.equal(flagged.taskId, 't2', '既有 taskId 成员不动');
  });

  test('get() 抛错自动带归因（判读点唯一 ⇒ 全部消费方同源）', () => {
    const store = new TaskStore({ maxTasks: 1, terminalTtlMs: Number.POSITIVE_INFINITY });
    const victim = terminalTask(store);
    terminalTask(store); // 驱逐 victim
    assert.throws(
      () => store.get(victim.task.id),
      (e) => e instanceof TaskNotFoundError && e.evicted === true,
      '被逐 id 的 get() 必须带 evicted:true',
    );
    assert.throws(
      () => store.get('no-such-task'),
      (e) => e instanceof TaskNotFoundError && e.evicted === false,
      '从未存在的 id 必须 evicted:false',
    );
    // 同源旁证：updateStatus 等 get() 消费方经同一判读点（零额外接线）
    assert.throws(
      () => store.updateStatus(victim.task.id, 'failed'),
      (e) => e.evicted === true,
      '所有 get() 消费方自动获得同一归因',
    );
  });
});

describe('P2-T7 ②g 协议面归因可分（tasks/get）', () => {
  test('被逐 id ⇒ data.evicted:true；从未存在的 id ⇒ 键整体缺席（旧形状逐字节）', async () => {
    const store = new TaskStore({ maxTasks: 1, terminalTtlMs: Number.POSITIVE_INFINITY });
    const victim = terminalTask(store, 'completed');
    terminalTask(store); // 驱逐 victim

    const evictedRes = await directA2ARequest(store, { id: victim.task.id });
    assert.equal(evictedRes.result, undefined, '两种 id 都是「找不到」⇒ result 必须缺席');
    assert.equal(evictedRes.error.code, -32602, '错误码不动（仍由 INVALID_PARAMS 承载 TASK_NOT_FOUND）');
    assert.deepEqual(
      evictedRes.error.data,
      { code: 'TaskNotFoundError', evicted: true },
      '被逐 id ⇒ data 必须恰为 {code, evicted:true}',
    );

    const unknownRes = await directA2ARequest(store, { id: 'this-id-never-existed' });
    assert.deepEqual(
      unknownRes.error.data,
      { code: 'TaskNotFoundError' },
      '从未存在的 id ⇒ data 必须**逐字节等于旧形状**（键整体缺席，不是 evicted:false）',
    );
    assert.equal('evicted' in unknownRes.error.data, false, '显式 false 会让旧客户端深比对全红 ⇒ 必须缺席');
    // 错误文本一律不变（两种 id 只差 id 本身 ⇒ 前缀必须逐字相同，归因绝不进文案）
    const PREFIX = '任务不存在或不可访问：';
    assert.ok(evictedRes.error.message.startsWith(PREFIX), '被逐 id 的文案前缀逐字不变');
    assert.ok(unknownRes.error.message.startsWith(PREFIX), '从未存在 id 的文案前缀逐字不变');
    assert.equal(
      evictedRes.error.message,
      `${PREFIX}${victim.task.id}`,
      '文案 = 旧模板 + id，绝不追加任何「已被回收」字样（归因只在结构化键上）',
    );
  });

  test('存活 id 的 tasks/get 完全不受影响（正向路径零回归）', async () => {
    const store = new TaskStore({ maxTasks: 50 });
    const rec = store.create();
    store.updateStatus(rec.task.id, 'working');
    const res = await directA2ARequest(store, { id: rec.task.id });
    assert.equal(res.result.id, rec.task.id);
    assert.equal(res.result.status.state, 'working');
    assert.equal(res.error, undefined);
  });

  test('环形窗口外的被逐 id ⇒ 退回旧形状（诚实：不知即不声称）', async () => {
    const store = new TaskStore({ maxTasks: 1, terminalTtlMs: Number.POSITIVE_INFINITY });
    const oldest = terminalTask(store);
    for (let i = 0; i < RING_CAP + 5; i += 1) terminalTask(store); // 挤出窗口
    const res = await directA2ARequest(store, { id: oldest.task.id });
    assert.deepEqual(res.error.data, { code: 'TaskNotFoundError' }, '窗口外不得给出 evicted 结论');
  });
});

/* ================================================================== *
 * 契约与装配面（静态钉）
 * ================================================================== */

describe('P2-T7 契约面纯附加（静态钉）', () => {
  test('Contracts.TasksHealth 追加 evictedCount?: number（可选 ⇒ 缺席即旧行为）', () => {
    const src = readFileSync(SRC_BRIDGE, 'utf8');
    const block = src.slice(
      src.indexOf('export interface TasksHealth'),
      src.indexOf('export interface HealthStatus'),
    );
    assert.ok(block.length > 100, '切片不得过短（防「匹配失败仍假绿」）');
    assert.match(block, /readonly evictedCount\?: number;/, 'evictedCount 必须是可选键');
    assert.match(block, /readonly live: number;/);
    assert.match(block, /readonly maxTasks\?: number;/);
    assert.match(block, /readonly terminalTtlMs\?: number;/);
    assert.ok(
      block.indexOf('readonly terminalTtlMs?: number;') < block.indexOf('readonly evictedCount?: number;'),
      '新键必须追加在既有三键之后（纯附加，不打乱既有形状）',
    );
    // T5 的 SecurityHealth 两键不得被动（contracts 串行序 T1→T5→T7→T9 的交接纪律）
    assert.match(src, /readonly bearerSelfCheck\?:/);
    assert.match(src, /readonly innerReconnect\?:/);
  });

  test('/health.tasks 追加 evictedCount（既有三键之后；读数源 = taskStore.evictedCount()，且唯一）', () => {
    const src = readFileSync(SRC_VM_SERVER, 'utf8');
    const at = src.indexOf('tasks: {');
    assert.notEqual(at, -1, '锚点缺失');
    const block = src.slice(at, at + 900);
    // 既有 assembly-guard 的三行逐字保全
    assert.match(src, /\n {6}tasks: \{\n {8}live: taskStore\.size\(\),/);
    assert.match(block, /maxTasks: TASK_STORE_MAX_TASKS,/);
    assert.match(block, /terminalTtlMs: TASK_STORE_TERMINAL_TTL_MS,/);
    assert.match(block, /evictedCount: taskStore\.evictedCount\(\),/, 'health 新键必须取 store 同源读数');
    assert.ok(
      block.indexOf('terminalTtlMs: TASK_STORE_TERMINAL_TTL_MS,') <
        block.indexOf('evictedCount: taskStore.evictedCount(),'),
      '新键追加在既有三键之后',
    );
    assert.equal(
      (src.match(/evictedCount: taskStore\.evictedCount\(\),/g) ?? []).length,
      1,
      '透出点必须唯一（两处读取即两处可漂移）',
    );
    // 既有三键顺序不得被重排（体检面逐字节兼容）
    assert.ok(
      /live: taskStore\.size\(\),\s*\n\s*maxTasks: TASK_STORE_MAX_TASKS,\s*\n\s*terminalTtlMs: TASK_STORE_TERMINAL_TTL_MS,/.test(
        src,
      ),
      '既有三键顺序与文本必须逐字不变',
    );
  });

  test('AuditExt.kind 含 task-evicted + ext.evict 聚合字段在位（链上取证键）', () => {
    const src = readFileSync(SRC_AUDIT, 'utf8');
    assert.match(src, /\| 'task-evicted';/, '枚举成员以分号收尾（末位追加 ⇒ 纯附加）');
    assert.match(src, /\| 'bearer-selfcheck'/, 'T5 既有成员不得被动');
    assert.match(src, /\| 'chain-archive-verify'/, 'T4 既有成员不得被动');
    assert.match(src, /readonly evict\?:/);
    assert.match(src, /readonly sampleTaskIds: readonly string\[\];/);
    assert.match(src, /readonly evictedTotal: number;/);
    assert.match(src, /readonly terminalStates:/);
  });

  test('框架层零审计依赖（依赖方向铁律：驱逐事件只给回调，不落链语义）', () => {
    const src = readFileSync(SRC_TASK_STORE, 'utf8');
    assert.ok(!/AuditSink|HashChainAudit|AuditRecord|appendAudit|@winvm\/core\/audit/.test(src), '框架层不得出现任何审计符号');
    assert.match(src, /readonly onEviction\?: \(info: EvictionRecord\) => void;/, '回调形态与 onApprovalTimeout 同构');
    assert.match(src, /catch \{\n\s*\/\* 观察者异常不影响驱逐收口 \*\//, '回调异常必须被吞（取证面不拖累执行面）');
    // 既有守卫输入面：cancelRequested 出现点必须仍恰 4 行（r19c-a5-approval-coordinator C3）
    const lines = src.split('\n').filter((l) => l.includes('cancelRequested'));
    assert.equal(lines.length, 4, `task-store.ts 内 cancelRequested 出现点应恰 4，实得 ${lines.length}`);
    // snapshot-truth 白名单：task-store.ts 不在白名单 ⇒ 新代码不得引入 "snapshot" 字样
    assert.doesNotMatch(src, /snapshot/i, '引入 snapshot 字样会让 phase2-snapshot-truth 白名单守卫红');
  });

  test('a2a-framework/src/server.ts 归因是条件展开（缺席即旧形状，绝不写显式 false）', () => {
    const src = readFileSync(SRC_A2A_SERVER, 'utf8');
    assert.match(src, /\.\.\.\(e\.evicted \? \{ evicted: true \} : \{\}\)/);
    assert.doesNotMatch(src, /evicted: false/, '显式 false 会破坏旧客户端深比对');
    // 既有钉保全：错误映射的 code 键与顺序不动
    assert.match(src, /code: A2A\.A2A_ERROR_CODES\.TASK_NOT_FOUND,/);
  });
});

/* ================================================================== *
 * vm-service 落链件（纯函数 + 投递器）
 * ================================================================== */

describe('P2-T7 落链件 buildTaskEvictedAuditEntry（纯函数）', () => {
  const ev = (n, gate = 'overflow', terminalState = 'completed') => ({
    id: `task-${n}`,
    terminalState,
    evictedAtMs: 1_700_000_000_000 + n,
    gate,
  });

  test('单条溢出：形态逐字段对齐自发条目范式（internal 主体 / meta 能力域 / allowed 恒 true）', () => {
    const e = buildTaskEvictedAuditEntry(
      { traceId: 'tr_t7', batch: [ev(1)], evictedTotal: 7, startedAtMs: 1_700_000_000_000 },
      () => 'aud_t7',
    );
    assert.equal(e.auditId, 'aud_t7');
    assert.equal(e.principal.channel, 'internal', '服务端自发条目必须是 internal（不是任何外部主体）');
    assert.equal(e.principal.host, 'vm-service');
    assert.equal(e.capabilityId, 'meta.audit.chain', '审计自证属 meta 能力域，不占业务面');
    assert.equal(e.risk, 'L0');
    assert.deepEqual(e.policyDecision, { allowed: true, matchedRule: 'internal:task-evicted' });
    assert.equal(e.result.ok, true, '驱逐是事实陈述而非许可判定');
    assert.equal(e.ext.kind, 'task-evicted');
    assert.equal(e.ext.evict.count, 1);
    assert.equal(e.ext.evict.overflowCount, 1);
    assert.equal(e.ext.evict.ttlCount, 0);
    assert.equal(e.ext.evict.evictedTotal, 7, '累计读数必须随条目带上（与 /health.tasks 同口径对账）');
    assert.deepEqual(e.ext.evict.sampleTaskIds, ['task-1']);
    assert.deepEqual(e.ext.evict.terminalStates, { completed: 1 });
    assert.equal(e.params.count, 1);
    assert.equal(e.params.evictedTotal, 7);
    assert.ok(typeof e.ts === 'string' && e.ts.endsWith('Z'));
    assert.equal(e.traceId, 'tr_t7');
  });

  test('突发聚合：闸门分布 + 终态分布 + 样本上界恰 10', () => {
    const batch = [];
    for (let i = 1; i <= 25; i += 1) {
      batch.push(ev(i, i % 3 === 0 ? 'ttl' : 'overflow', i % 2 === 0 ? 'failed' : 'completed'));
    }
    const e = buildTaskEvictedAuditEntry(
      { traceId: 'tr_t7b', batch, evictedTotal: 25, startedAtMs: batch[0].evictedAtMs },
      () => 'aud_t7b',
    );
    assert.equal(e.ext.evict.count, 25);
    assert.equal(e.ext.evict.ttlCount, 8, '25 条里 3/6/…/24 共 8 条 ttl');
    assert.equal(e.ext.evict.overflowCount, 17);
    assert.equal(e.ext.evict.sampleTaskIds.length, TASK_EVICT_SAMPLE_LIMIT, '样本上界必须生效');
    assert.equal(e.ext.evict.sampleTaskIds[0], 'task-1', '样本取本突发**最先**逐出者');
    assert.deepEqual(e.ext.evict.terminalStates, { completed: 13, failed: 12 });
    assert.ok(e.result.summary.includes('25 条'), '摘要必须给出条数');
    assert.ok(e.result.summary.includes('ttl=8') && e.result.summary.includes('overflow=17'), '摘要给出闸门分布');
  });

  test('纯 ttl 突发：摘要只给 ttl=…（不得虚报 overflow=0 之外的形态）', () => {
    const batch = [ev(1, 'ttl'), ev(2, 'ttl')];
    const e = buildTaskEvictedAuditEntry(
      { traceId: 'tr_t7t', batch, evictedTotal: 2, startedAtMs: batch[0].evictedAtMs },
      () => 'aud_t7t',
    );
    assert.ok(e.result.summary.includes('ttl=2'));
    assert.ok(!e.result.summary.includes('overflow='), '单一闸门场景不得并列写出另一闸门');
    assert.equal(e.ext.evict.overflowCount, 0);
  });

  test('durationMs 取真实突发跨度（不是恒 0 的假零）', () => {
    const batch = [ev(1, 'ttl'), ev(5, 'ttl')];
    const e = buildTaskEvictedAuditEntry(
      { traceId: 'tr_t7c', batch, evictedTotal: 2, startedAtMs: batch[0].evictedAtMs },
      () => 'aud_t7c',
    );
    assert.equal(e.durationMs, 4, '末条时刻 − 首条时刻');
  });
});

describe('P2-T7 落链件 createTaskEvictedChainRecorder（突发合并）', () => {
  test('一次突发 ⇒ 恰一条链上条目；累计计数同源', async () => {
    const appended = [];
    const rec = createTaskEvictedChainRecorder({
      append: async (entry) => {
        appended.push(entry);
      },
      newTraceId: () => 'tr_auto',
      newAuditId: () => `aud_${appended.length + 1}`,
      evictedCount: () => 12,
      isClosed: () => false,
      warn: () => {},
    });
    // 模拟 evictIfNeeded() 的同步突发：一次 create 里连续 4 条回调（同一微任务边界）
    for (let i = 1; i <= 4; i += 1) {
      rec.onEviction({ id: `t${i}`, terminalState: 'completed', evictedAtMs: Date.now(), gate: 'overflow' });
    }
    assert.equal(rec.pendingCount(), 4, '未 flush 前批次应攒住（突发合并的前提）');
    await sleep(0); // 微任务边界
    assert.equal(appended.length, 1, '判据：一次突发只落一条聚合条目（观测不得把链变成无界增长点）');
    assert.equal(appended[0].ext.evict.count, 4);
    assert.equal(appended[0].ext.evict.evictedTotal, 12);
    assert.equal(rec.pendingCount(), 0, 'flush 后批次必须清空');
  });

  test('跨突发 ⇒ 多条条目（不无限攒批）', async () => {
    const appended = [];
    const rec = createTaskEvictedChainRecorder({
      append: async (entry) => appended.push(entry),
      newTraceId: () => 'tr_auto',
      newAuditId: () => 'aud',
      evictedCount: () => appended.length,
      isClosed: () => false,
      warn: () => {},
    });
    rec.onEviction({ id: 'a', terminalState: 'failed', evictedAtMs: Date.now(), gate: 'ttl' });
    await sleep(0);
    rec.onEviction({ id: 'b', terminalState: 'failed', evictedAtMs: Date.now(), gate: 'ttl' });
    await sleep(0);
    assert.equal(appended.length, 2, '两次独立突发落两条（每条 count=1）');
    assert.deepEqual(appended.map((x) => x.ext.evict.sampleTaskIds), [['a'], ['b']]);
  });

  test('收口位：isClosed ⇒ 不落链也不 warn（退出路径不留半条）', async () => {
    const appended = [];
    const warns = [];
    let closed = false;
    const rec = createTaskEvictedChainRecorder({
      append: async (entry) => appended.push(entry),
      newTraceId: () => 'tr',
      newAuditId: () => 'aud',
      evictedCount: () => 1,
      isClosed: () => closed,
      warn: (msg) => warns.push(msg),
    });
    closed = true;
    rec.onEviction({ id: 'x', terminalState: 'completed', evictedAtMs: Date.now(), gate: 'overflow' });
    await sleep(0);
    assert.equal(appended.length, 0, '已收口 ⇒ 一条都不落');
    assert.equal(warns.length, 0, '收口后的静默丢弃不得打 warn（与 recordBearerSelfCheck 同纪律）');
  });

  test('已排队微任务在收口之后才执行 ⇒ flush 前二次判存（竞态面）', async () => {
    const appended = [];
    let closed = false;
    const rec = createTaskEvictedChainRecorder({
      append: async (entry) => appended.push(entry),
      newTraceId: () => 'tr',
      newAuditId: () => 'aud',
      evictedCount: () => 1,
      isClosed: () => closed,
      warn: () => {},
    });
    rec.onEviction({ id: 'y', terminalState: 'completed', evictedAtMs: Date.now(), gate: 'overflow' });
    closed = true; // 回调已入队、微任务尚未跑
    await sleep(0);
    assert.equal(appended.length, 0, '入队后收口 ⇒ 仍不得落链');
  });

  test('append 失败 ⇒ 只 warn，绝不抛出打断驱逐', async () => {
    const warns = [];
    const rec = createTaskEvictedChainRecorder({
      append: () => Promise.reject(new Error('sink busy')),
      newTraceId: () => 'tr',
      newAuditId: () => 'aud',
      evictedCount: () => 1,
      isClosed: () => false,
      warn: (msg, fields) => warns.push({ msg, fields }),
    });
    rec.onEviction({ id: 'z', terminalState: 'completed', evictedAtMs: Date.now(), gate: 'ttl' });
    await sleep(0);
    await sleep(0);
    assert.equal(warns.length, 1, '落链失败必须显形（不得静默退化）');
    assert.ok(warns[0].msg.includes('task-evicted'));
  });

  test('装配点：TaskStore.onEviction 已接到投递器、且写**原始 sink**（server.ts 静态钉）', () => {
    const src = readFileSync(SRC_VM_SERVER, 'utf8');
    assert.match(src, /import \{ createTaskEvictedChainRecorder \} from '\.\/task-evict-audit\.js';/);
    assert.match(src, /onEviction: taskEvictChain\.onEviction,/);
    assert.match(src, /append: \(entry\) => audit\.append\(entry\)/, '必须写原始 sink（O-7 审计自证）');
    assert.match(src, /evictedCount: \(\) => taskStore\.evictedCount\(\)/, '链上累计读数与 /health 同源');
    assert.match(src, /isClosed: \(\) => serviceClosed/);
    // 反例守卫：驱逐条目经 auditSink 就会被账本登记成「本回合有活动」
    const onEvicSlice = src.slice(src.indexOf('const taskEvictChain'), src.indexOf('const taskStore = new TaskStore'));
    assert.ok(onEvicSlice.length > 100, '切片不得过短');
    assert.doesNotMatch(onEvicSlice, /auditSink/, 'task-evicted 经 auditSink 即红（审计自证违规）');
  });

  test('真实 store 端到端：onEviction 接到 recorder ⇒ 突发合并落一条链上条目', async () => {
    const appended = [];
    const rec = createTaskEvictedChainRecorder({
      append: async (entry) => appended.push(entry),
      newTraceId: () => 'tr_e2e',
      newAuditId: () => 'aud_e2e',
      evictedCount: () => store.evictedCount(),
      isClosed: () => false,
      warn: () => {},
    });
    const store = new TaskStore({
      maxTasks: 3,
      terminalTtlMs: 20,
      onEviction: rec.onEviction,
    });
    for (let i = 0; i < 8; i += 1) terminalTask(store, i % 2 === 0 ? 'completed' : 'failed');
    await sleep(40);
    terminalTask(store); // TTL 清扫 8 条过期终态 ⇒ 一次突发
    await sleep(0);
    assert.equal(appended.length, 2, '两次突发（溢出轮 1 条 + TTL 轮 1 条）⇒ 两条链上条目');
    const ttlEntry = appended.at(-1);
    assert.equal(ttlEntry.ext.kind, 'task-evicted');
    assert.ok(ttlEntry.ext.evict.ttlCount >= 1, 'TTL 突发必须聚合进一条');
    assert.equal(ttlEntry.ext.evict.evictedTotal, store.evictedCount(), '链上累计 = store 累计（同源对账）');
    assert.ok(
      appended.every((x) => x.ext.evict.sampleTaskIds.length <= TASK_EVICT_SAMPLE_LIMIT),
      '样本上界在真实链路上同样生效',
    );
  });
});

/* ================================================================== *
 * 离线端到端：满容量场景三个可见面自洽
 * ================================================================== */

describe('P2-T7 离线端到端链', () => {
  test('满容量：evictedCount 单调 + 环形有界 + 归因可分三者同步自洽', async () => {
    const store = new TaskStore({ maxTasks: 2, terminalTtlMs: Number.POSITIVE_INFINITY });
    const ids = [];
    for (let i = 0; i < RING_CAP + 10; i += 1) ids.push(terminalTask(store).task.id);

    assert.equal(store.evictedCount(), RING_CAP + 8, '每轮恰逐一条（上限 2、每轮新增 1 条终态）');
    assert.equal(store.evictionLog().length, RING_CAP, '环形有界');
    assert.equal(store.size(), 2, '表内压回上限');

    // 最早被逐者已出窗口 ⇒ 与「从未存在」同形（诚实缺席）
    const outRes = await directA2ARequest(store, { id: ids[0] });
    assert.equal('evicted' in outRes.error.data, false, '窗口外不得给结论');
    // 窗口内被逐者 ⇒ 归因在场
    const inRes = await directA2ARequest(store, { id: ids[ids.length - 3] });
    assert.equal(inRes.error.data.evicted, true, '窗口内的被逐 id 必须给出 evicted:true');
    // 环形与 store 判据逐条一致（三个可见面不得漂移）
    for (const r of store.evictionLog()) {
      assert.equal(store.wasEvicted(r.id), true, '环形在场者必须可归因');
    }
  });

  test('零驱逐 store ⇒ evictedCount() 恒 0（体检面给出「零驱逐」这一事实，不是缺席）', () => {
    const store = new TaskStore();
    store.create();
    store.create();
    assert.equal(store.evictedCount(), 0, '默认 200 上限下既有测试规模不触发驱逐 ⇒ 必须如实报 0');
    assert.equal(store.evictionLog().length, 0);
  });

  test('既有缺省规模旁证：200 上限下 1695 例既有测试所依赖的「不驱逐」不变', () => {
    const store = new TaskStore();
    for (let i = 0; i < 199; i += 1) store.create();
    assert.equal(store.evictedCount(), 0, '未达上限 ⇒ 一条不逐（既有 fixture 深比对不受影响）');
  });
});

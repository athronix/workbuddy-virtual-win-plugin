/**
 * r19c / A5 —— 「服务级单例 `activeTaskId` 被上一次委派收尾清掉」缺陷的确定性单元测试
 *
 * 背景：真机实测同一条高危委派路径出现两种结果（E1r2 挂起 input-required 成功；A5 从未挂起、
 * 17.08s 直接 failed）。当前 VM 整机不可达，真机实验 BLOCKED，故本文件把怀疑对象在**离线环境**
 * 锁死：不依赖 HTTP 服务、不连 VM、不起 LLM 会话、不访问网络。
 *
 * 被测对象是**真实实现，不是替身**：
 *   `VmApprovalCoordinator` 由 `@winvm/vm-service`（→ `packages/vm-service/dist/server.js`）导出，
 *   `TaskStore` 由 `@winvm/a2a-framework`（→ `packages/a2a-framework/dist/task-store.js`）导出。
 *   两者均为纯逻辑类，import 不启动服务 / 不监听端口 / 不 spawn ps-bridge（已实测验证）。
 *   唯一的「替身」是注入进 `bind()` 的 **TaskStore 测试替身（spy）**，用于断言
 *   `waitApproval` 是否被调用 —— 这是被测对象的**依赖**，不是被测对象本身。
 *
 * 三类断言：
 *   A 组（表征 / characterization）：钉死「当前代码实际干什么」，不管它是否正确 → 期望 PASS。
 *   B 组（红档 / defect）：按「修复后应有行为」写，**当前必须 FAIL**。失败即缺陷锁定的证据。
 *     若 B 组跑出 PASS，说明 P1 假设被推翻，须立即上报。
 *   C 组（边界与回归锚点）：钉死修复时**不许破坏**的既有语义 + 静态判据 → 期望 PASS。
 *
 * 运行（只跑本文件，绝不整批）：
 *   node --test tests/unit/r19c-a5-approval-coordinator.test.js
 * 退出码语义：B 组当前失败 ⇒ 进程退出码非 0（这是**预期**的，证明缺陷存在）；
 *   修复落地后 B 组转绿 ⇒ 退出码 0。末条用例 `Z-汇总` 会打印所有用例的 PASS/FAIL 明细表。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { VmApprovalCoordinator } from '@winvm/vm-service';
import { TaskStore } from '@winvm/a2a-framework';

/* ------------------------------------------------------------------ *
 * 路径：沙箱内 cwd 会失效，一律用 import.meta.url 推导绝对路径
 * ------------------------------------------------------------------ */
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const SRC_SERVER = join(ROOT, 'packages/vm-service/src/server.ts');
const DIST_SERVER = join(ROOT, 'packages/vm-service/dist/server.js');
const SRC_TASK_STORE = join(ROOT, 'packages/a2a-framework/src/task-store.ts');

/* ------------------------------------------------------------------ *
 * 结果登记：让 PASS/FAIL 分布肉眼可辨（末条用例打印明细表）
 * ------------------------------------------------------------------ */
const OUTCOMES = [];

/**
 * 包裹一个用例主体：先登记结果，再原样抛出（失败仍会让 node --test 计为 FAIL，
 * 退出码非 0；将来修复后自然转绿）。
 */
async function runCase(name, kind, fn) {
  try {
    await fn();
    OUTCOMES.push({ name, kind, ok: true, err: '' });
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e);
    // 断言失败信息多行，只取首行做汇总展示（原文在各自的 FAIL 块里完整可见）
    OUTCOMES.push({ name, kind, ok: false, err: msg.split('\n')[0].slice(0, 160) });
    throw e;
  }
}

/* ------------------------------------------------------------------ *
 * 测试夹具
 * ------------------------------------------------------------------ */

/** 构造合法 ApprovalRequest（preview/impact 必填，raise 内部会取 .length） */
function makeReq(approvalId, extra = {}) {
  return {
    approvalId,
    capabilityId: 'app.winget.uninstall',
    risk: 'L2',
    summary: `需要人工审批：${approvalId}`,
    preview: { target: 'SomeApp' },
    impact: ['将卸载 SomeApp'],
    ...extra,
  };
}

/** 构造 MCP 续跑令牌表条目（K4/K5 pendingApprovals 的 token 形态） */
function makeToken(approvalId) {
  return {
    approvalId,
    capabilityId: 'app.winget.uninstall',
    risk: 'L2',
    params: { id: 'SomeApp' },
    preview: { target: 'SomeApp' },
    createdAtMs: Date.now(),
    hostApproved: false,
  };
}

/** 新协调器（字段全新，避免用例间互相污染） */
function newCoordinator() {
  return new VmApprovalCoordinator();
}

/** 准备一个已 bind 真实 TaskStore 的协调器 */
function wired(store, pendingApprovals = new Map()) {
  const c = newCoordinator();
  c.bind(store, pendingApprovals);
  return c;
}

/**
 * TaskStore 测试替身（spy）：记录 waitApproval / updateStatus 调用，
 * `waitApproval` 直接 resolve(false)（模拟宿主拒绝），使 raise 不悬挂、用例确定性收敛。
 * 注意：这是**注入给被测对象的依赖替身**，被测对象本身是真实实现。
 */
function spyStore() {
  const calls = { waitApproval: [], updateStatus: [] };
  return {
    calls,
    waitApproval(id, req) {
      calls.waitApproval.push({ id, approvalId: req?.approvalId });
      return Promise.resolve(false); // 宿主拒绝
    },
    updateStatus(id, state) {
      calls.updateStatus.push({ id, state });
      return undefined;
    },
    tryGet() {
      return undefined; // 无 metadata ⇒ reason 细分走 'rejected'，不掺入 timeout 噪声
    },
  };
}

/** 递归列出目录下全部 .ts 文件（用于全仓静态判据） */
function walkTs(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkTs(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/* ================================================================== *
 * A 组：表征测试 —— 钉死「当前代码实际干什么」
 * ================================================================== */

describe('A5 / A 表征：VmApprovalCoordinator.activeTaskId 单例语义', () => {
  test('A0 被测对象可信度守卫：dist 由当前 src 编译而来（含守卫与 endTask 置空）', () =>
    runCase('A0 dist/src 一致性守卫', 'A-表征', () => {
      assert.ok(existsSync(DIST_SERVER), `dist 缺失：${DIST_SERVER}`);
      const dist = readFileSync(DIST_SERVER, 'utf8');
      // 守卫形态必须与 src 同位（src:177 → `if (!this.activeTaskId || !this.tasks)`）
      assert.ok(
        dist.includes('if (!this.activeTaskId || !this.tasks)'),
        'dist 内找不到 activeTaskId 守卫 —— 行为断言将失去意义，请先 npm run build',
      );
      assert.ok(
        dist.includes('this.tasks.waitApproval(this.activeTaskId, enriched)'),
        'dist 内 waitApproval 不再使用单例 activeTaskId —— 机制链已变更，本文件断言需同步复核',
      );
      const srcMtime = statSync(SRC_SERVER).mtimeMs;
      const distMtime = statSync(DIST_SERVER).mtimeMs;
      assert.ok(
        distMtime >= srcMtime,
        `dist(${new Date(distMtime).toISOString()}) 早于 src(${new Date(srcMtime).toISOString()}) —— ` +
          'dist 陈旧，A/B/C 组行为断言不可信，请先 npm run build',
      );
    }));

  test('A1 beginTask/endTask 对单例字段的实际读写值', () =>
    runCase('A1 单例字段读写', 'A-表征', () => {
      const c = newCoordinator();
      assert.equal(c.activeTaskId, undefined, '初始应为 undefined');
      c.beginTask('A');
      assert.equal(c.activeTaskId, 'A', 'beginTask(A) 后应等于 A');
      c.endTask();
      // 如实记录实际值（当前实现赋 undefined）
      assert.equal(c.activeTaskId, undefined, `endTask() 后实际值=${String(c.activeTaskId)}`);
    }));

  test('A2 交叠场景（A 收尾清空后，B 的 raise 返回什么）—— 本轮核心用例', () =>
    runCase('A2 交叠场景 raise 实际返回', 'A-表征', async () => {
      const store = new TaskStore({ approvalTtlMs: 300 });
      const recA = store.create();
      const recB = store.create();
      const c = wired(store, new Map([['apr_B', makeToken('apr_B')]]));

      c.beginTask(recA.task.id); // A 委派进入
      c.beginTask(recB.task.id); // B 委派进入（真实交叠：此时 A 的 runGoal 仍在飞）
      c.endTask(); // A 的 runGoal 收尾（bridge.ts:741 finally）⇒ 单例被清

      const out = await c.raise(makeReq('apr_B'));

      // 如实钉死当前真实行为：
      assert.equal(out.approved, false, '当前实现 approved=false');
      assert.equal(out.reason, 'no-active-task', '当前实现 reason=no-active-task（不是 rejected/timeout）');
      assert.equal(
        store.get(recB.task.id).task.status.state,
        'submitted',
        'B 任务从未进入 input-required（与 A5 真机症状一致：终态文本里有 approvalId，但从未挂起）',
      );
    }));

  test('A3a 有 activeTaskId 时：raise 确实调用 taskStore.waitApproval（单例值即挂起目标）', () =>
    runCase('A3a waitApproval 被调用', 'A-表征', async () => {
      const spy = spyStore();
      const c = newCoordinator();
      c.bind(spy, new Map([['apr_B', makeToken('apr_B')]]));
      c.beginTask('B');

      const out = await c.raise(makeReq('apr_B'));

      assert.equal(spy.calls.waitApproval.length, 1, 'waitApproval 应被调用一次');
      assert.equal(spy.calls.waitApproval[0].id, 'B', '挂起目标取自服务级单例 activeTaskId');
      assert.equal(spy.calls.waitApproval[0].approvalId, 'apr_B');
      assert.equal(out.approved, false);
      assert.equal(out.reason, 'rejected', '替身 resolve(false) ⇒ 应为 rejected（对照 no-active-task）');
    }));

  test('A3b endTask 清空后：raise 从不调用 waitApproval，且立即返回（不挂起、不等待）', () =>
    runCase('A3b waitApproval 未被调用', 'A-表征', async () => {
      const spy = spyStore();
      const c = newCoordinator();
      c.bind(spy, new Map([['apr_B', makeToken('apr_B')]]));
      c.beginTask('A');
      c.beginTask('B');
      c.endTask(); // 模拟 A 收尾

      const startedAtMs = Date.now();
      const out = await c.raise(makeReq('apr_B'));
      const elapsedMs = Date.now() - startedAtMs;

      assert.equal(spy.calls.waitApproval.length, 0, 'waitApproval 一次都没被调用 ⇒ 审批闸被绕过');
      assert.equal(spy.calls.updateStatus.length, 0, 'updateStatus(input-required) 也没有被调用');
      assert.equal(out.reason, 'no-active-task');
      assert.ok(elapsedMs < 100, `早退应立即返回（实测 ${elapsedMs}ms），不会挂起等待宿主`);
    }));
});

/* ================================================================== *
 * B 组：红档 —— 按「修复后应有行为」写，当前必须 FAIL
 * ================================================================== */

describe('A5 / B 红档：交叠场景下 B 的审批仍应可挂起（当前必然 FAIL）', () => {
  test('B1 交叠场景：B 的审批请求仍应被挂起（不应因 A 的收尾降级为 no-active-task）', () =>
    runCase('B1 交叠不应降级 no-active-task', 'B-红档', async () => {
      const spy = spyStore();
      const c = newCoordinator();
      c.bind(spy, new Map([['apr_B', makeToken('apr_B')]]));
      c.beginTask('A');
      c.beginTask('B');
      c.endTask(); // A 收尾 —— 修复后不应影响仍在飞的 B

      const out = await c.raise(makeReq('apr_B'));

      // 修复后应有行为：
      assert.notEqual(
        out.reason,
        'no-active-task',
        '修复后：B 仍在飞，A 的收尾不得让 B 的审批闸早退为 no-active-task',
      );
      assert.equal(spy.calls.waitApproval.length, 1, '修复后：仍须调用 waitApproval 挂起 B 的审批');
      assert.equal(spy.calls.waitApproval[0]?.id, 'B', '修复后：挂起目标应为 B（按 taskId 归属）');
    }));

  test('B2 交叠场景：B 任务应到达 input-required 且 approvalId 出现在结构化 data part', () =>
    runCase('B2 应挂起且结构化 approval-request', 'B-红档', async () => {
      const store = new TaskStore({ approvalTtlMs: 300 });
      const recA = store.create();
      const recB = store.create();
      const c = wired(store, new Map([['apr_B', makeToken('apr_B')]]));

      c.beginTask(recA.task.id);
      c.beginTask(recB.task.id);
      c.endTask();

      const p = c.raise(makeReq('apr_B'));
      // waitApproval 的 Promise 构造体同步执行 ⇒ 让出一个 tick 即可读到挂起结果
      await new Promise((r) => setImmediate(r));
      const rec = store.get(recB.task.id);
      const stateAfterRaise = rec.task.status.state;
      const dataParts = (rec.task.status.message?.parts ?? [])
        .filter((x) => x.kind === 'data')
        .map((x) => x.data);
      const approvalPart = dataParts.find((d) => d && d.type === 'approval-request');

      // 收口，避免用例悬挂（早退时 p 已 resolved，await 立即返回）
      if (rec.pendingApproval) rec.pendingApproval.resolve(false);
      await p;

      // 修复后应有行为（对应 A5 症状：approvalId 只在文本里、不在结构化 data part 里）：
      assert.equal(stateAfterRaise, 'input-required', '修复后：B 应挂起为 input-required');
      assert.ok(approvalPart, '修复后：status.message 应含结构化 approval-request data part');
      assert.equal(approvalPart?.approvalId, 'apr_B', '修复后：结构化 data part 应携带 approvalId');
    }));

  test('B3 交叠场景：宿主回复 approved:false 后应得 reason=rejected（D-5 rejected 终态可达）', () =>
    runCase('B3 宿主拒绝可达 rejected', 'B-红档', async () => {
      const store = new TaskStore({ approvalTtlMs: 300 });
      const recA = store.create();
      const recB = store.create();
      const c = wired(store, new Map([['apr_B', makeToken('apr_B')]]));

      c.beginTask(recA.task.id);
      c.beginTask(recB.task.id);
      c.endTask();

      const p = c.raise(makeReq('apr_B'));
      await new Promise((r) => setImmediate(r));
      const rec = store.get(recB.task.id);
      // 宿主按协议回复 approved:false（契约 D-5 的唯一 rejected 置位前置：
      // a2a-framework/src/server.ts:306 只在「任务上有待处理审批」时才置 rejected）
      if (rec.pendingApproval) rec.pendingApproval.resolve(false);
      const out = await p;

      assert.equal(out.approved, false);
      assert.equal(
        out.reason,
        'rejected',
        '修复后：宿主拒绝应回 rejected（当前回 no-active-task ⇒ 宿主无从回复 ⇒ rejected 终态不可达）',
      );
    }));
});

/* ================================================================== *
 * C 组：边界与回归锚点
 * ================================================================== */

describe('A5 / C 边界与回归锚点', () => {
  test('C1 endTask() 幂等性：重复调用不抛错、无额外副作用', () =>
    runCase('C1 endTask 幂等', 'C-边界', () => {
      const store = new TaskStore({ approvalTtlMs: 300 });
      const pending = new Map([['apr_1', makeToken('apr_1')]]);
      const c = wired(store, pending);
      c.beginTask('A');

      c.endTask();
      c.endTask();
      c.endTask(); // 重复调用

      assert.equal(c.activeTaskId, undefined);
      assert.ok(c.tasks, 'endTask 不得解绑 tasks（副作用检查）');
      assert.equal(c.pendingApprovals, pending, 'endTask 不得清空续跑令牌表（副作用检查）');
      assert.equal(pending.size, 1, 'endTask 不得消费 token');
    }));

  test('C2 beginTask(\'\') / undefined（bridge.ts:737 `input.taskId ?? \'\'` 风险点）', () =>
    runCase('C2 空 taskId 早退', 'C-边界', async () => {
      const spy = spyStore();
      const c = newCoordinator();
      c.bind(spy, new Map());

      c.beginTask('');
      assert.equal(c.activeTaskId, '', '空字符串被原样写入（非空即视为已挂接）');
      const outEmpty = await c.raise(makeReq('apr_x'));
      assert.equal(outEmpty.approved, false);
      assert.equal(outEmpty.reason, 'no-active-task', '空字符串 falsy ⇒ 早退 no-active-task，审批闸静默失效');
      assert.equal(spy.calls.waitApproval.length, 0);

      c.beginTask(undefined);
      const outUndef = await c.raise(makeReq('apr_x'));
      assert.equal(outUndef.reason, 'no-active-task');
      assert.equal(spy.calls.waitApproval.length, 0, '两种空值均一次都没挂起');
    }));

  test('C3 task-store.cancelRequested 全仓只写不读（静态判据 + 行为旁证）', () =>
    runCase('C3 cancelRequested 无人消费', 'C-边界', () => {
      // 静态判据：扫 packages/*/src 下全部 .ts（排除 dist 编译产物）
      const hits = [];
      for (const f of walkTs(join(ROOT, 'packages'))) {
        if (f.includes(`${'dist'}/`)) continue;
        readFileSync(f, 'utf8')
          .split('\n')
          .forEach((line, i) => {
            if (line.includes('cancelRequested')) {
              hits.push({ file: f.slice(ROOT.length + 1), line: i + 1, text: line.trim() });
            }
          });
      }
      assert.equal(
        hits.length,
        3,
        `全仓 src 出现点应为 3（声明/初始化/赋值），实测 ${hits.length}：${JSON.stringify(hits)}`,
      );
      const forms = hits.map((h) => h.text.replace(/\s+/g, ' ')).sort();
      assert.deepEqual(
        forms,
        ['cancelRequested: boolean;', 'cancelRequested: false,', 'rec.cancelRequested = true;'].sort(),
        `出现点形态不符（若新增了读取点，此处会失败 —— 即修复已落地）：${JSON.stringify(hits)}`,
      );

      // 行为旁证：cancel 后标志确实被置 true，但它不是「打断在飞任务」的驱动者
      const store = new TaskStore({ approvalTtlMs: 300 });
      const rec = store.create();
      store.requestCancel(rec.task.id);
      assert.equal(rec.cancelRequested, true, 'requestCancel 写标志为 true');
      assert.equal(
        store.get(rec.task.id).task.status.state,
        'canceled',
        'cancel 的收口靠 updateStatus(canceled) + pendingApproval.resolve(false)，不是靠读标志',
      );
    }));

  test('C4 回归锚点：串行（无交叠）场景必须照常挂起并批准 —— 修复 P1 时不得破坏', () =>
    runCase('C4 串行场景回归锚点', 'C-边界', async () => {
      const store = new TaskStore({ approvalTtlMs: 300 });
      const rec = store.create();
      const token = makeToken('apr_serial');
      const c = wired(store, new Map([['apr_serial', token]]));

      c.beginTask(rec.task.id); // 只有这一个委派在飞
      const p = c.raise(makeReq('apr_serial'));
      await new Promise((r) => setImmediate(r));

      assert.equal(store.get(rec.task.id).task.status.state, 'input-required', '串行场景应挂起');
      const dataParts = (store.get(rec.task.id).task.status.message?.parts ?? [])
        .filter((x) => x.kind === 'data')
        .map((x) => x.data);
      assert.ok(
        dataParts.some((d) => d?.type === 'approval-request' && d.approvalId === 'apr_serial'),
        '串行场景 status.message 应含结构化 approval-request（E1r2 成功样本形态）',
      );

      store.get(rec.task.id).pendingApproval.resolve(true); // 宿主批准
      const out = await p;

      assert.equal(out.approved, true, '批准后 approved=true');
      assert.equal(token.hostApproved, true, 'K4 安全点：token 被置 hostApproved=true');
    }));

  test('C5 @todo-P1-fix 预留：按 taskId 归属形态的断言（修复后启用）', () =>
    runCase('C5 归属形态预留', 'C-边界', () => {
      // 修复方向（若采纳「activeTaskId → Map<taskId, ...> 归属」）：
      //   beginTask('A') → beginTask('B') → endTask('A') 后，B 的绑定仍在。
      // 当前实现是单例（endTask() 无参、无法指定收尾哪个任务），故只做**形态断言**：
      assert.equal(
        newCoordinator().endTask.length,
        0,
        '当前 endTask() 无参数 ⇒ 无法表达「哪个任务收尾」⇒ 归属改造后此断言应失效并改为归属断言',
      );
      // TODO(@todo-P1-fix)：归属改造落地后，替换为本组上方的 B1/B2/B3 转绿验证。
    }));
});

/* ================================================================== *
 * Z：汇总（放最后一条，顺序执行 ⇒ 能打印到全部用例的结果）
 * ================================================================== */

test('Z-汇总：A5 离线锁定用例结果明细', () => {
  const pass = OUTCOMES.filter((o) => o.ok).length;
  const fail = OUTCOMES.filter((o) => !o.ok).length;
  const lines = [
    '',
    '===== A5 离线锁定汇总（tests/unit/r19c-a5-approval-coordinator.test.js）=====',
    `总计 ${OUTCOMES.length} 条：PASS ${pass} / FAIL ${fail}`,
    ...OUTCOMES.map(
      (o) =>
        `  [${o.ok ? 'PASS' : 'FAIL'}] ${o.kind} ${o.name}` + (o.ok ? '' : `\n         └─ ${o.err}`),
    ),
    '=========================================================================',
    '',
  ];
  console.log(lines.join('\n'));
  // 汇总本身恒绿：真正的成败由上面各条用例的 FAIL/PASS 与进程退出码表达
  assert.equal(OUTCOMES.length > 0, true, '至少应有用例被登记');
});

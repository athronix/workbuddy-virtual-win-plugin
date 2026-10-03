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
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { VmApprovalCoordinator } from '@winvm/vm-service';
import { TaskStore } from '@winvm/a2a-framework';
import { CliLlmBridge } from '@winvm/adapter-agent-workbuddy-llm';

/* ------------------------------------------------------------------ *
 * 路径：沙箱内 cwd 会失效，一律用 import.meta.url 推导绝对路径
 * ------------------------------------------------------------------ */
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const SRC_SERVER = join(ROOT, 'packages/vm-service/src/server.ts');
const DIST_SERVER = join(ROOT, 'packages/vm-service/dist/server.js');
const SRC_TASK_STORE = join(ROOT, 'packages/a2a-framework/src/task-store.ts');
/** Fix-2 / D-1 红线所在文件（C6 静态判据用） */
const SRC_BRIDGE = join(ROOT, 'packages/adapter-agent-workbuddy-llm/src/bridge.ts');

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
function spyStore(resolveWith = false) {
  const calls = { waitApproval: [], updateStatus: [] };
  return {
    calls,
    waitApproval(id, req) {
      calls.waitApproval.push({ id, approvalId: req?.approvalId });
      return Promise.resolve(resolveWith); // false=宿主拒绝；true=宿主批准
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
      /* 【机制已变更 · P1-Fix 同步更新】
       * 守卫的**取值来源**由服务级单例 `this.activeTaskId` 改为局部 `taskId`
       * （`const taskId = req.taskId ?? this.activeTaskId;`），守卫的**目的与语义不变**
       * （无归属 ⇒ 不放行、不改 reason）。故本守卫的形态断言同步为当前形态，
       * 「dist 必须比 src 新」这一守卫目的本身一字未改。
       */
      assert.ok(
        dist.includes('if (!taskId || !this.tasks)'),
        'dist 内找不到 no-active-task 守卫 —— 行为断言将失去意义，请先 npm run build',
      );
      assert.ok(
        dist.includes('const taskId = req.taskId ?? this.activeTaskId;'),
        'dist 内 raise 不再「优先取 req.taskId、缺席回退单例」 —— 机制链已变更，本文件断言需同步复核',
      );
      assert.ok(
        dist.includes('this.tasks.waitApproval(taskId, enriched)'),
        'dist 内 waitApproval 不再按归属 taskId 挂起 —— 机制链已变更，本文件断言需同步复核',
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

  test('A2 交叠场景（A 收尾后，B 的 raise 返回什么）—— 本轮核心用例', () =>
    runCase('A2 交叠场景 raise 实际返回（修复后）', 'A-表征', async () => {
      /* 【翻转原因】
       * 原用例的 setup 用的是**修复前**的调用约定：`endTask()` 零参 + `req` 无 taskId。
       * 修复后该组合走 SK-2 的「兼容分支」（零参 ⇒ 无条件清空），仍会复现缺陷 ——
       * 它被**完整保留**为下方新增的 `A2b`（残余风险，不得丢失）。
       * 本用例改为**修复后桥的真实调用约定**（bridge.ts:736 传 `input.taskId ?? ''`、
       * bridge.ts:965 给 req 注入 `taskId`）⇒ 如实地钉死修复后的真实行为。
       */
      const store = new TaskStore({ approvalTtlMs: 300 });
      const recA = store.create();
      const recB = store.create();
      const c = wired(store, new Map([['apr_B', makeToken('apr_B')]]));

      c.beginTask(recA.task.id); // A 委派进入
      c.beginTask(recB.task.id); // B 委派进入（真实交叠：此时 A 的 runGoal 仍在飞）
      c.endTask(recA.task.id); // A 的 runGoal 收尾（带归属 ⇒ 'A' !== 'B' ⇒ 不清 B）

      const p = c.raise(makeReq('apr_B', { taskId: recB.task.id })); // 桥注入归属
      await new Promise((r) => setImmediate(r));

      // 如实钉死修复后的真实行为：B **真的挂起了**（不再早退 no-active-task）
      const rec = store.get(recB.task.id);
      assert.equal(
        rec.task.status.state,
        'input-required',
        '修复后：交叠下 B 应挂起 input-required（修复前恒 submitted，与 A5 真机症状一致）',
      );
      assert.equal(c.activeTaskId, recB.task.id, 'A 的归属收尾不得清掉 B');

      rec.pendingApproval.resolve(true); // 宿主批准
      const out = await p;
      assert.notEqual(
        out.reason,
        'no-active-task',
        '修复后：交叠下 B 的 raise 不再早退为 no-active-task',
      );
      assert.equal(out.approved, true, '修复后：交叠下宿主批准应被采纳');
    }));

  test('A2b 残余风险（保留原 A2 语义）：遗留零参调用方 + req 无 taskId ⇒ 缺陷仍复现', () =>
    runCase('A2b 遗留零参调用方仍复现缺陷', 'A-表征', async () => {
      /* 【为什么保留这条】
       * SK-2 明确规定：`endTask()` 零参 ⇒ **无条件清空**（兼容既有零参调用方，行为逐字不变）。
       * 因此「调用方不传归属 + raise 的 req 也不带 taskId」这一组合，修复**刻意不改** ——
       * 缺陷在该组合下**仍然复现**。这不是回归，而是兼容代价，必须显式钉住以免被误读为
       * 「已根治」。根治路径是 Fix-1B 的 `req.taskId`（见 B4：零参收尾 + req 带 taskId ⇒ 仍挂起）。
       * 本用例的 setup 与断言**逐字沿用修复前的 A2**，仅改名与加注。
       */
      const store = new TaskStore({ approvalTtlMs: 300 });
      const recA = store.create();
      const recB = store.create();
      const c = wired(store, new Map([['apr_B', makeToken('apr_B')]]));

      c.beginTask(recA.task.id); // A 委派进入
      c.beginTask(recB.task.id); // B 委派进入
      c.endTask(); // 遗留零参收尾 ⇒ 无条件清空（SK-2 兼容分支）

      const out = await c.raise(makeReq('apr_B')); // req 也不带 taskId

      assert.equal(out.approved, false);
      assert.equal(out.reason, 'no-active-task', '遗留组合仍早退 no-active-task（SK-2 兼容代价，非回归）');
      assert.equal(
        store.get(recB.task.id).task.status.state,
        'submitted',
        '遗留组合下 B 仍不会挂起 input-required —— 残余风险，须靠调用方传 taskId 消除',
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

  test('A3b 归属收尾后：raise 仍调用 waitApproval 挂起 B（不再绕过审批闸）', () =>
    runCase('A3b waitApproval 被调用（修复后）', 'A-表征', async () => {
      /* 【翻转原因】
       * 原用例钉的是「endTask() 零参清空后 raise 从不调用 waitApproval」——那是**缺陷本身**
       * （审批闸被绕过）。修复后，桥按真实约定调用（endTask 带归属 + req 带 taskId），
       * 该形态不复存在 ⇒ 原断言（`length === 0`）按修复后行为**如实翻转**为 `=== 1`。
       * 零参遗留组合的等价形态由 `A2b` 承接（仍为 0 次，属已知残余风险）。
       */
      const spy = spyStore();
      const c = newCoordinator();
      c.bind(spy, new Map([['apr_B', makeToken('apr_B')]]));
      c.beginTask('A');
      c.beginTask('B');
      c.endTask('A'); // A 带归属收尾 ⇒ 不清 B

      const out = await c.raise(makeReq('apr_B', { taskId: 'B' })); // 桥注入归属

      assert.equal(spy.calls.waitApproval.length, 1, '修复后：waitApproval 应被调用一次（审批闸不再被绕过）');
      assert.equal(spy.calls.waitApproval[0].id, 'B', '修复后：挂起目标是 B');
      assert.equal(out.reason, 'rejected', '替身 resolve(false) ⇒ rejected（对照早退的 no-active-task）');
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
      // 【setup 同步为修复后桥的真实调用约定】原为 `endTask()` 零参 + req 无 taskId，
      // 该组合在 SK-2 下走「无条件清空」兼容分支，修复**刻意不改**（已由 A2b 显式钉住）。
      // 桥的实际调用是：:736 `endTask(input.taskId ?? '')` + :965 req 注入 taskId。
      c.endTask('A'); // A 收尾（带归属）—— 修复后不应影响仍在飞的 B

      const out = await c.raise(makeReq('apr_B', { taskId: 'B' })); // 桥注入归属

      // 修复后应有行为（断言一字未削弱，仅 setup 对齐真实调用约定）：
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
      c.endTask(recA.task.id); // setup 同步为桥真实调用约定（:736 传 input.taskId ?? ''）

      const p = c.raise(makeReq('apr_B', { taskId: recB.task.id })); // :965 注入归属
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
      c.endTask(recA.task.id); // setup 同步为桥真实调用约定（:736 传 input.taskId ?? ''）

      const p = c.raise(makeReq('apr_B', { taskId: recB.task.id })); // :965 注入归属
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

  test('B4 边界：A 用**零参**收尾（旧调用方）但 req 带 taskId ⇒ B 仍挂起（Fix-1B 独立生效）', () =>
    runCase('B4 零参收尾 + req.taskId 仍挂起', 'B-红档', async () => {
      /* spec §2.2 验收判据 2：证明 `req.taskId` 的优先级**高于**被清空的单例 ——
       * 即便调用方是「不传归属」的旧代码（endTask() 零参 ⇒ 单例被无条件清空），
       * 只要 raise 的 req 自带 taskId，审批仍应挂起。这是 Fix-1B 独立于 Fix-1A 的价值。
       */
      const spy = spyStore();
      const c = newCoordinator();
      c.bind(spy, new Map([['apr_x', makeToken('apr_x')]]));
      c.beginTask('A');
      c.beginTask('B');
      c.endTask(); // 旧调用方零参收尾 ⇒ 单例被清空
      assert.equal(c.activeTaskId, undefined, '前置：零参收尾确实清空了单例');

      const out = await c.raise(makeReq('apr_x', { taskId: 'A' })); // req 自带归属 'A'

      assert.notEqual(out.reason, 'no-active-task', 'Fix-1B：req.taskId 优先于被清空的单例');
      assert.equal(spy.calls.waitApproval.length, 1, 'Fix-1B：仍应挂起一次');
      assert.equal(spy.calls.waitApproval[0]?.id, 'A', 'Fix-1B：挂起目标取 req.taskId（=A），而非被清空的单例');
    }));

  test('B5 边界：beginTask(\'\') + req 无 taskId ⇒ 仍 no-active-task，且产出**一条**结构化 warn', () =>
    runCase('B5 空归属早退 + warn 可观测', 'B-红档', async () => {
      /* spec §2.2 验收判据 3 + SK-3：根因文档 §6.4 点名「零日志」是本次只能靠反证定位的原因，
       * 故 C-6 的 logger 出口必须有断言覆盖。字段口径（SK-3 硬约束）：
       *   reason 恒 'no-active-task'；缺席字段一律 ''（绝不输出 undefined 字面量）；
       *   hasTasks 必须带上（把守卫的两个子条件 !taskId / !this.tasks 在日志里区分开）。
       */
      const spy = spyStore();
      const warns = [];
      const c = newCoordinator();
      c.bind(spy, new Map());
      c.setLogger({ warn: (msg, meta) => warns.push({ msg, meta }) });

      c.beginTask(''); // 空串 = 无归属（SK-1）
      const out = await c.raise(makeReq('apr_x')); // req 也不带 taskId

      assert.equal(out.approved, false, '空归属 ⇒ 绝不自批（SK-7 兜底语义未变）');
      assert.equal(out.reason, 'no-active-task', '空归属仍早退 no-active-task（reason 一字未变）');
      assert.equal(spy.calls.waitApproval.length, 0, '空归属不应挂起');

      assert.equal(warns.length, 1, `应产出恰一条 warn（实测 ${warns.length} 条）`);
      const { msg, meta } = warns[0];
      assert.ok(
        String(msg).includes('审批协调器'),
        `warn 文案应可检索（实测：${String(msg).slice(0, 80)}）`,
      );
      assert.equal(meta.reason, 'no-active-task', 'meta.reason 恒为 no-active-task（便于日志检索）');
      assert.equal(meta.approvalId, 'apr_x');
      assert.equal(meta.reqTaskId, '', "缺席字段一律 ''（绝不输出 undefined 字面量，SK-3 硬约束）");
      assert.equal(meta.activeTaskId, '', "缺席字段一律 ''（SK-3 硬约束）");
      assert.equal(meta.hasTasks, true, 'hasTasks 用于区分守卫的两个子条件（根因 §1.2 排空表 #4）');
      for (const [k, v] of Object.entries(meta)) {
        assert.notEqual(v, undefined, `meta.${k} 不得为 undefined（SK-3 硬约束）`);
      }
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

  test('C5 归属形态：endTask 已支持可选归属参数，且 A 的收尾不得清掉 B 的归属', () =>
    runCase('C5 归属形态（修复后）', 'C-边界', async () => {
      /* 【翻转原因 · 必读】
       * 原断言：`assert.equal(newCoordinator().endTask.length, 0)`，是 **修复前** 的表征
       *   （`endTask()` 无参 ⇒ 协调器无从知道「哪个任务在收尾」⇒ 只能无条件清空单例，
       *    这正是 A5 缺陷的根因，见 a5-approval-drop-rootcause.md §3.1）。
       * C-1 落地后（`contracts/src/bridge.ts` `endTask(taskId?: string)` +
       *   `vm-service/src/server.ts` 归属实现）⇒ `Function.prototype.length` 由 0 变 1，
       *   该表征断言**设计上预期失效**（用例自述「归属改造后此断言应失效并改为归属断言」）。
       * 故按修复后行为**如实改写**为 1，并补一条行为断言证明归属语义真的生效，语义不删。
       * 判读口径：`endTask.length` 由**实现类**决定（接口在编译期擦除），且单测解析到
       *   dist ⇒ 翻红时刻 = 「实现落码 + dist 重建」，不是契约落地的那一刻。
       */
      assert.equal(newCoordinator().endTask.length, 1, 'endTask 已支持可选归属参数');

      // 归属行为断言：A 的收尾（归属不匹配当前活动任务）不得清掉 B 的归属
      const spy = spyStore();
      const c = wired(spy);
      c.beginTask('A');
      c.beginTask('B'); // B 是后进入者 ⇒ 当前活动任务为 B
      c.endTask('A'); // A 收尾：'A' !== 'B' ⇒ 保持不动，绝不误清他人
      assert.equal(c.activeTaskId, 'B', 'A 的收尾不得清掉 B 的归属（交叠保护）');

      await c.raise(makeReq('apr_x'));
      assert.ok(
        spy.calls.waitApproval.some((x) => x.id === 'B'),
        `A 的收尾后，B 的审批仍须挂到 B（实测 waitApproval 调用=${JSON.stringify(spy.calls.waitApproval)}）`,
      );
    }));

  test('C6 护栏：Fix-2 三态已搬离实例 + D-1 两道门只换取值来源（静态判据 + 行为旁证）', () =>
    runCase('C6 Fix-2/D-1 红线护栏', 'C-边界', () => {
      /* 【为什么补这条】
       * T03（Fix-2）把 taskReceipts / raisedApprovals / k5ReplayActive 从 bridge 实例字段
       * 搬进 per-runGoal 的 RunContext，并触及 D-1 红线两道门。spec T03 验收判据 3 要求
       * 「两道门仍是两个相邻独立的 `if (…) return base;`，语义/顺序/短路条件一字未改，
       * 仅取值来源由 `this.` 变 `ctx.`」。该判据当前**无任何断言覆盖**（k5-replay 41 例只
       * 覆盖行为，不覆盖形态），故补一条静态判据把这条红线钉死。
       */
      const src = readFileSync(SRC_BRIDGE, 'utf8');
      const lines = src.split('\n');
      const idxGate1 = lines.findIndex((l) => l.includes('if (!this.replayEnabled || !ctx.replayActive) return base;'));
      const idxGate2 = lines.findIndex((l) => l.includes('if (ctx.raised.size === 0) return base;'));

      assert.ok(idxGate1 >= 0, 'D-1 门① 缺失或形态已变（应为 `!this.replayEnabled || !ctx.replayActive`）');
      assert.ok(idxGate2 >= 0, 'D-1 门② 缺失或形态已变（应为 `ctx.raised.size === 0`）');
      assert.equal(
        idxGate2,
        idxGate1 + 1,
        `两道门必须相邻且顺序不变（实测 门① 行 ${idxGate1 + 1} / 门② 行 ${idxGate2 + 1}）`,
      );

      // 三态必须**不再**挂在实例上（否则并发委派仍会互相 clear）
      for (const f of ['this.taskReceipts', 'this.raisedApprovals', 'this.k5ReplayActive']) {
        assert.ok(
          !src.includes(f),
          `src 仍残留实例三态字段 ${f} —— Fix-2 已被回退或部分回退（并发互清缺陷会复发）`,
        );
      }
      // RunContext 必须真的承载三态
      assert.ok(src.includes('receipts: new Map()'), 'RunContext 未携带 receipts 初值');
      assert.ok(src.includes('raised: new Set()'), 'RunContext 未携带 raised 初值');
      assert.ok(src.includes('replayActive: false'), 'RunContext 未携带 replayActive 初值');

      // 行为旁证：连续两次 runGoal 各自独立（跨任务清零由「每次新建 ctx」自动满足）
      const c = newCoordinator();
      const spy = spyStore();
      c.bind(spy, new Map());
      c.beginTask('t1');
      c.endTask('t1');
      c.beginTask('t2');
      c.endTask('t2');
      assert.equal(c.activeTaskId, undefined, '归属收尾语义在本用例场景下仍照常释放');
    }));
});

/* ================================================================== *
 * D 组：桥级交叠（Engineer R2）—— 完整复现 A5 时序
 *   bridge(oneshot) → coordinator.raise → 终态产物；零真机、零真 LLM、零网络。
 *   时序用**闸门文件**编排（不是 sleep）⇒ 确定性，无 flake。
 *   两条委派用**两个独立 bridge 实例 + 同一个 coordinator** ⇒ 只测 P1，隔离桥内其它状态。
 * ================================================================== */

/** A5 真机样本里的 approvalId（终态文本带它，但从未挂起） */
const A5_APPROVAL_ID = 'apr_a9aabfcffb5f4246b918';
const BLOCK_TEXT_A5 =
  `工具返回 APPROVAL_REQUIRED: {"approvalId":"${A5_APPROVAL_ID}",` +
  `"capabilityId":"app.winget.uninstall","risk":"L2"} 等待宿主审批\n`;
const PLAIN_TEXT = '已向用户转告：企业微信卸载完成\n';
/** R2b 形态：有 apr_ token 但**不含** APPROVAL_REQUIRED / 等待审批 ⇒ 拦截启发式不命中 */
const TOKEN_ONLY_TEXT = `工具返回: {"approvalId":"apr_deadbeefcafe1234"} 处理完毕\n`;

/** 沙箱 /tmp 只读 ⇒ 临时产物落到 $HOME/wbtmp */
const TMP_BASE = (() => {
  const base = process.env.HOME ? join(process.env.HOME, 'wbtmp') : tmpdir();
  try {
    mkdirSync(base, { recursive: true });
  } catch {
    /* 已存在 */
  }
  return base;
})();

const tick = () => new Promise((r) => setImmediate(r));

/** 假 codebuddy：等闸门文件出现后回显 out（用完 open() 放行） */
function makeGatedCli(dir, out) {
  mkdirSync(dir, { recursive: true });
  const gate = join(dir, 'gate');
  const outFile = join(dir, 'out.txt');
  writeFileSync(outFile, out, 'utf8');
  const script = [
    '#!/bin/sh',
    `while [ ! -f "${gate}" ]; do sleep 0.05; done`,
    `cat "${outFile}"`,
    'exit 0',
    '',
  ].join('\n');
  const p = join(dir, 'fake-codebuddy');
  writeFileSync(p, script, 'utf8');
  chmodSync(p, 0o755);
  return { cliPath: p, open: () => writeFileSync(gate, '1', 'utf8') };
}

function makeSink() {
  const statuses = [];
  return { statuses, onStatus: (s, m) => statuses.push([s, m ?? '']), onArtifact: () => {} };
}

function mkInput(taskId, cliPath, outputDir) {
  return {
    goal: '卸载 VM 企业微信',
    capabilities: ['app.winget.uninstall'],
    outputDir,
    cliPath,
    endpoint: 'http://127.0.0.1:1/mcp', // 不可达端口：本例全程不联网（无 probe ⇒ 账本反查短路）
    traceId: `tr_${taskId}`,
    timeoutMs: 20_000,
    taskId,
  };
}

/**
 * 交叠时序：A（上一轮委派）与 B（A5）同时发起，A 先收尾。
 * 顺序由闸门保证：两轮 beginTask 都完成后 → 放行 A → A 收尾 endTask() → 放行 B → B 走到 raise。
 */
async function runOverlap({ bText = BLOCK_TEXT_A5, approve = false } = {}) {
  const root = mkdtempSync(join(TMP_BASE, 'a5-overlap-'));
  const cliA = makeGatedCli(join(root, 'A'), PLAIN_TEXT);
  const cliB = makeGatedCli(join(root, 'B'), bText);
  const outA = join(root, 'outA');
  const outB = join(root, 'outB');

  const spy = spyStore(approve);
  const coord = new VmApprovalCoordinator();
  coord.bind(spy, new Map([[A5_APPROVAL_ID, makeToken(A5_APPROVAL_ID)]]));

  const bridgeA = new CliLlmBridge({
    cliPath: cliA.cliPath,
    outputDir: outA,
    persistent: false,
    endpoint: 'http://127.0.0.1:1/mcp',
  });
  const bridgeB = new CliLlmBridge({
    cliPath: cliB.cliPath,
    outputDir: outB,
    persistent: false,
    endpoint: 'http://127.0.0.1:1/mcp',
  });
  bridgeA.setApprovalCoordinator(coord);
  bridgeB.setApprovalCoordinator(coord);

  const sinkA = makeSink();
  const sinkB = makeSink();
  const pA = bridgeA.runGoal(mkInput('tA', cliA.cliPath, outA), sinkA);
  await tick();
  const pB = bridgeB.runGoal(mkInput('tB', cliB.cliPath, outB), sinkB);
  await tick();
  const activeAfterBothBegin = coord.activeTaskId;

  cliA.open();
  const resA = await pA; // A 收尾 ⇒ finally → endTask() ⇒ 清掉的是 B 的 id
  const activeAfterA = coord.activeTaskId;

  cliB.open();
  const resB = await pB; // B 走到 raise ⇒ 此刻单例已空

  return { resA, resB, spy, coord, activeAfterBothBegin, activeAfterA, statuses: sinkB.statuses };
}

describe('A5 / D 桥级交叠：完整复现 A5 时序（bridge → coordinator → 终态）', () => {
  test('D1 表征（修复后）：A 带归属收尾不再清掉 B ⇒ B 终态按宿主裁决收口（非恒 failed）', () =>
    runCase('D1 桥级交叠终态表征（修复后）', 'D-桥级', async () => {
      /* 【翻转原因】
       * 原用例钉的是**修复前**的终态指纹：A 收尾把 B 的 id 一起清掉 ⇒ tB 从未被挂起
       * ⇒ B 恒 `ok=false / APPROVAL_REQUIRED / summary 含「等待审批」`。
       * 修复后该指纹不复存在（A 带归属收尾，B 的 id 保留），原断言 `activeAfterA === undefined`
       * 与 `tB 挂起次数 === 0` 已与事实相反 ⇒ 按修复后行为**如实重写**：
       *   - `activeAfterA` 应为 'tB'（A 的收尾不再误清）
       *   - tB 应被挂起 1 次（缺陷核心症状消失）
       *   - B 的终态由宿主裁决决定（本例替身 resolve(false) ⇒ 未批准 ⇒ 仍是 APPROVAL_REQUIRED，
       *     但**成因不同**：现在是「宿主拒绝后收口」，不再是「审批闸被绕过」）
       * 修复前的完整指纹已归档进 docs/test/reports/a2a-coverage-2026-10-03.md（A5 逐字对照）。
       */
      const { resB, spy, activeAfterBothBegin, activeAfterA } = await runOverlap();

      assert.equal(activeAfterBothBegin, 'tB', '两条委派都 begin 后，单例被后发起的 B 覆盖');
      assert.equal(
        activeAfterA,
        'tB',
        '修复后：A 的带归属收尾（endTask(input.taskId)）不再把 B 的 id 一起清掉',
      );

      console.log(
        `    [D1 实测终态（修复后）] ok=${resB.ok} code=${resB.error?.code}\n` +
          `                  summary=${JSON.stringify(resB.summary)}\n` +
          `                  steps[0].summary=${JSON.stringify(resB.steps?.[0]?.summary)}\n` +
          `                  waitApproval 调用=${JSON.stringify(spy.calls.waitApproval)}`,
      );

      // 修复后：tB **被真的挂起了**（这是本缺陷的核心症状）
      assert.equal(
        spy.calls.waitApproval.filter((c) => c.id === 'tB').length,
        1,
        `修复后：tB 应被 waitApproval 挂起一次（实测 ${JSON.stringify(spy.calls.waitApproval)}）`,
      );
      // 本例替身 resolve(false)（宿主未批准）⇒ 终态仍按「等待审批未执行」收口，但成因已变
      assert.equal(resB.ok, false, '宿主未批准 ⇒ B 终态 ok=false');
      assert.equal(resB.error?.code, 'APPROVAL_REQUIRED', 'B 终态 error.code=APPROVAL_REQUIRED');
      assert.ok(
        String(resB.summary).includes('等待审批'),
        `B 终态 summary 含「等待审批」（实测：${String(resB.summary).slice(0, 80)}）`,
      );
    }));

  test('D2 红档：修复后 tB 的审批应真的被挂起（waitApproval 调用 1 次）', () =>
    runCase('D2 修复后应挂起 tB', 'D-桥级', async () => {
      const { spy } = await runOverlap();
      const forB = spy.calls.waitApproval.filter((c) => c.id === 'tB');
      assert.equal(forB.length, 1, '修复后：B 的审批应被挂起一次（当前 0 次 ⇒ 审批闸被绕过）');
      assert.equal(forB[0]?.approvalId, A5_APPROVAL_ID, '修复后：挂起的应是 B 的 approvalId');
    }));

  test('D3 红档：修复后宿主批准应被采纳（当前批准根本送不进 B）', () =>
    runCase('D3 宿主批准应被采纳', 'D-桥级', async () => {
      // waitApproval resolve(true) + pendingApprovals 里有 token ⇒ 修复后 raise 应回 approved:true
      const { resB, statuses, spy } = await runOverlap({ approve: true });
      const approved = statuses.filter(([, m]) => m.includes('宿主已批准'));

      assert.equal(
        spy.calls.waitApproval.filter((c) => c.id === 'tB').length,
        1,
        '修复后：宿主批准须先有挂起（当前 0 次）',
      );
      assert.ok(
        approved.length >= 1,
        `修复后：桥应进入「宿主已批准」续跑路径（实测 statuses=${JSON.stringify(statuses)}；` +
          `当前因早退直接 return base ⇒ ok=${resB.ok}，宿主批准无处送达）`,
      );
    }));

  test('D4 表征（R2b 形态）：文本无 APPROVAL_REQUIRED 时，审批闸不触发（calls=0）', () =>
    runCase('D4 无拦截标记不触发审批闸', 'D-桥级', async () => {
      const { spy } = await runOverlap({ bText: TOKEN_ONLY_TEXT });
      assert.equal(
        spy.calls.waitApproval.length,
        0,
        '命中不了拦截启发式 ⇒ 不进 maybeResume ⇒ 一次都不挂起（该形态下 approvalId 只在文本里）',
      );
      // 注：本例不断言 resB.ok —— 它取决于 completion-claim 判定，非 P1 关注点，留待专项补测。
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

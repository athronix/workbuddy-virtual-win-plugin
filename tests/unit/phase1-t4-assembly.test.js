/**
 * Phase 1 · T4 装配层证据面守卫（判据①②③④⑦ + 顺序纪律 O-4/O-5/O-6/O-7）
 *
 * 装配层入口 `createService` 在本沙箱会 spawn ps-bridge 并触发 V8 fatal ⇒ 不是可用测试面。
 * 因此本文件走三条腿：
 *   (a) **真实协作对象**（`TaskStore` / `HashChainAuditSink` / `VmApprovalCoordinator` /
 *       `PendingApprovalRegistry`）跑行为路径 ⇒ 判据①②⑥⑦ 的行为面；
 *   (b) **纯函数**（`recordApprovalDecisionAudit` / `buildChainArchiveVerifyAuditEntry` /
 *       `buildDelegationAuditEntry` / `collectApprovalFacts`）断言条目形态 ⇒ §1.2-1 / §1.3-3
 *       权威字段表；
 *   (c) **源码文本钉**（含"移动守卫"这类内存变异反例，防断言恒真）⇒ 装配纪律 O-7 写原始
 *       sink、区 8 挂载位置、区 9/10 透出与停表。
 *
 * 对应设计 `docs/archive/changes/phase1-arch-design.md` §7.4-T4 判据：
 *  ①三态各一条 + 超时去重只一条；②sink 抛错决策不变仅 warn；③`/health.audit.scope`
 *  可读且 `chainValid` 语义不变；④启动落 `chain-archive-verify`（原始 sink）；
 *  ⑥清扫不扫在途 + close 后无定时器（装配线部分）；⑦链上 `terminalState:'canceled'`
 *  + `errorCode:'TASK_CANCELED'`。判据⑤的守卫本体由 `phase1-t4-http-guard.test.js` 覆盖，
 *  本文件只钉"挂载位置与同源事实"这一装配面。
 *
 * 纪律：不起 HTTP 服务、不 spawn ps-bridge、不写 packages/ 源码（变异仅在内存副本）。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildChainArchiveVerifyAuditEntry,
  buildDelegationAuditEntry,
  collectApprovalFacts,
  LedgerRegistry,
  PendingApprovalRegistry,
  recordApprovalDecisionAudit,
  VmApprovalCoordinator,
  wrapAuditSink,
} from '@winvm/vm-service';
import { HashChainAuditSink } from '@winvm/core';
import { TaskStore } from '@winvm/a2a-framework';

/* ------------------------------------------------------------------ *
 * 路径（沙箱内 cwd 会失效，一律由 import.meta.url 推导绝对路径）
 * ------------------------------------------------------------------ */
const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const SRC_SERVER = join(ROOT, 'packages/vm-service/src/server.ts');
const SRC_HTTP_GUARD = join(ROOT, 'packages/vm-service/src/http-guard.ts');
const SRC_REPLAY = join(ROOT, 'packages/vm-service/src/approval-replay.ts');
const SRC_REGISTRY = join(ROOT, 'packages/vm-service/src/pending-approvals.ts');
const SERVER_SRC = readFileSync(SRC_SERVER, 'utf8');

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */

/** 合法审批请求（`preview`/`impact` 必填，`raise` 内部会取 `.length`）。 */
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

/** MCP 续跑令牌条目（`PendingApproval` 的字段子集，`createdAtMs` 用固定值便于断言）。 */
function makeToken(approvalId, over = {}) {
  return {
    approvalId,
    capabilityId: 'app.winget.uninstall',
    risk: 'L2',
    params: { id: 'SomeApp' },
    preview: { target: 'SomeApp' },
    traceId: `tr_${approvalId}`,
    createdAtMs: Date.now() - 1000,
    hostApproved: false,
    ...over,
  };
}

/** 决策取证假 sink：记录入参序列；`throwOn(n)` 命中时抛错（判据②）。 */
function decisionCapture(throwOn) {
  const calls = [];
  const sink = (input) => {
    calls.push(input);
    if (throwOn && throwOn(calls.length, input)) throw new Error('sink-boom');
  };
  return { calls, sink };
}

/** 假 logger（warn 明细可断言）。 */
function fakeLogger() {
  const warns = [];
  return {
    warns,
    warn(msg, meta) {
      warns.push(meta ? { msg, meta } : { msg });
    },
    info() {},
    error() {},
    debug() {},
    close() {},
  };
}

/** 记录 append 入参的假 AuditAppender（`throwAt` 指定第 N 次抛错）。 */
function fakeAudit(over = {}) {
  const appended = [];
  const audit = {
    async append(input) {
      if (over.throwAt !== undefined && appended.length === over.throwAt) throw new Error('append-boom');
      appended.push(input);
      return { seq: appended.length + 100, hash: 'h' + appended.length, ...input };
    },
    ...(over.verifyChain ? { verifyChain: over.verifyChain } : {}),
  };
  return { audit, appended };
}

/** 已 bind 的协调器（可选注入决策 sink 与 logger）。 */
function wired(store, tokens, sink, logger) {
  const c = new VmApprovalCoordinator();
  c.bind(store, tokens);
  if (logger) c.setLogger(logger);
  if (sink) c.setDecisionSink(sink);
  return c;
}

/** 最小可入链条目（真实 sink 判据③④用）。 */
function chainEntry(auditId, over = {}) {
  return {
    ts: new Date().toISOString(),
    traceId: `tr_${auditId}`,
    auditId,
    principal: { host: 'vm-service', user: 'tester', channel: 'internal' },
    capabilityId: 'meta.audit.chain',
    risk: 'L0',
    params: {},
    policyDecision: { allowed: true, matchedRule: 'internal:test' },
    result: { ok: true, summary: 'fixture' },
    durationMs: 1,
    ...over,
  };
}

/** 与既有守卫同口径的相邻锚切片（起点/终点不成立 ⇒ 空串）。 */
function slice(src, startMark, endMark) {
  const i = src.indexOf(startMark);
  if (i < 0) return '';
  const j = src.indexOf(endMark, i + startMark.length);
  if (j < 0) return '';
  return src.slice(i, j);
}

function newDir(label) {
  return mkdtempSync(join(tmpdir(), `t4-${label}-`));
}

/* ================================================================== *
 * 判据① · 三态各落一条 + 超时去重只一条（O-6）
 * ================================================================== */

describe('T4 判据① 审批否定决策入链：三态各一条', () => {
  test('宿主显式拒绝 ⇒ decision=rejected / actor=host，恰一条，字段取服务端留存值', async () => {
    const store = new TaskStore({ approvalTtlMs: 0 });
    const rec = store.create();
    const tokens = new Map([['apr_r', makeToken('apr_r')]]);
    const { calls, sink } = decisionCapture();
    const c = wired(store, tokens, sink);
    c.beginTask(rec.task.id);

    const p = c.raise(makeReq('apr_r', { taskId: rec.task.id }));
    store.resolveApproval(rec.task.id, 'apr_r', false);
    const outcome = await p;

    assert.equal(outcome.approved, false, '拒绝绝不放行');
    assert.equal(outcome.reason, 'rejected');
    assert.equal(calls.length, 1, `一次拒绝恰一条，实测 ${calls.length}`);
    assert.equal(calls[0].decision, 'rejected');
    assert.equal(calls[0].actor, 'host');
    assert.equal(calls[0].approvalId, 'apr_r');
    assert.equal(calls[0].taskId, rec.task.id);
    assert.equal(calls[0].capabilityId, 'app.winget.uninstall');
    assert.equal(calls[0].risk, 'L2');
    assert.equal(calls[0].traceId, 'tr_apr_r', 'traceId 取服务端留存 token（因果线同源）');
    assert.deepEqual(calls[0].params, { id: 'SomeApp' }, '参数快照随决策留证');
    c.endTask(rec.task.id);
  });

  test('挂起中被取消 ⇒ decision=canceled / actor=cancel-request（不是 rejected）', async () => {
    const store = new TaskStore({ approvalTtlMs: 0 });
    const rec = store.create();
    const tokens = new Map([['apr_c', makeToken('apr_c')]]);
    const { calls, sink } = decisionCapture();
    const c = wired(store, tokens, sink);
    c.beginTask(rec.task.id);

    const p = c.raise(makeReq('apr_c', { taskId: rec.task.id }));
    // 协作式取消：requestCancel 以 resolve(false) 收口挂起审批 —— 同一条 resolve(false)
    // 既可能被读成「宿主拒绝」也可能被读成「取消」。记成 rejected = 把我们自己的取消
    // 伪装成人工否决（设计 §1.2-3 / O-4 点名的方向性错误）。
    store.requestCancel(rec.task.id);
    const outcome = await p;

    assert.equal(outcome.approved, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].decision, 'canceled', '取消必须读成 canceled');
    assert.equal(calls[0].actor, 'cancel-request');
    c.endTask(rec.task.id);
  });

  test('TTL 超时 ⇒ 主落点(onApprovalTimeout)+兜底(raise) 两条路径**只落一条**（O-6 去重）', async () => {
    let timeoutCalls = 0;
    const c = new VmApprovalCoordinator();
    const store = new TaskStore({
      approvalTtlMs: 15,
      onApprovalTimeout: (info) => {
        // 复刻装配层区 4 回调：noteTimeout（细分 reason）+ recordDecision（取证主落点）
        c.noteTimeout(info.approvalId);
        timeoutCalls += 1;
        c.recordDecision({
          traceId: 'tr_apr_t',
          approvalId: info.approvalId,
          capabilityId: 'app.winget.uninstall',
          risk: 'L2',
          decision: 'timeout',
          actor: 'approval-ttl',
          ttlMs: info.ttlMs,
          startedAtMs: Date.now() - info.timedOutAfterMs,
        });
      },
    });
    const rec = store.create();
    const tokens = new Map([['apr_t', makeToken('apr_t')]]);
    const { calls, sink } = decisionCapture();
    c.bind(store, tokens);
    c.setDecisionSink(sink);
    c.beginTask(rec.task.id);

    const outcome = await c.raise(makeReq('apr_t', { taskId: rec.task.id }));
    assert.equal(outcome.approved, false);
    assert.equal(outcome.reason, 'timeout', '对外 reason 仍是 timeout（既有 K5 语义不变）');
    assert.equal(timeoutCalls, 1, 'TaskStore 回调确实触发（主落点在场）');
    assert.equal(calls.length, 1, `超时只许一条，实测 ${calls.length} 条 ⇒ O-6 去重失效`);
    assert.equal(calls[0].decision, 'timeout');
    assert.equal(calls[0].actor, 'approval-ttl');
    c.endTask(rec.task.id);
  });

  test('recordDecision 同一 approvalId 幂等：后到的第二种判决不落链（O-6 判存即返回）', () => {
    const { calls, sink } = decisionCapture();
    const c = wired(new TaskStore({ approvalTtlMs: 0 }), new Map(), sink);
    const base = {
      traceId: 'tr_x',
      approvalId: 'apr_x',
      capabilityId: 'app.winget.uninstall',
      risk: 'L2',
      startedAtMs: 1,
    };
    c.recordDecision({ ...base, decision: 'timeout', actor: 'approval-ttl' });
    c.recordDecision({ ...base, decision: 'canceled', actor: 'cancel-request' });
    c.recordDecision({ ...base, decision: 'rejected', actor: 'host' });
    assert.equal(calls.length, 1, '同一 approvalId 只落第一条决策');
    assert.equal(calls[0].decision, 'timeout');
    assert.equal(c.decidedSize, 1);
  });

  test('approved 决策**登记但不落链**（§5 第 2 条），且挡住随后的假 timeout', async () => {
    const store = new TaskStore({ approvalTtlMs: 0 });
    const rec = store.create();
    const { calls, sink } = decisionCapture();
    const c = wired(store, new Map([['apr_a', makeToken('apr_a')]]), sink);
    c.beginTask(rec.task.id);

    const p = c.raise(makeReq('apr_a', { taskId: rec.task.id }));
    store.resolveApproval(rec.task.id, 'apr_a', true);
    const outcome = await p;

    assert.equal(outcome.approved, true);
    assert.equal(calls.length, 0, '批准不落链（重放段天然已有一条 executed）');
    assert.equal(c.decidedSize, 1, '但必须登记，以免 TTL 清扫二次触达冒出假 timeout');
    c.recordDecision({
      traceId: 'tr_apr_a',
      approvalId: 'apr_a',
      capabilityId: 'app.winget.uninstall',
      risk: 'L2',
      decision: 'timeout',
      actor: 'approval-ttl',
      startedAtMs: 1,
    });
    assert.equal(calls.length, 0, '批准后的二次触达必须被去重吃掉');
    c.endTask(rec.task.id);
  });

  test('pruneDecided 回收不在令牌表的登记项（decidedApprovals 不得成为新增长点）', () => {
    const { sink } = decisionCapture();
    const c = wired(new TaskStore({ approvalTtlMs: 0 }), new Map(), sink);
    const mk = (id) => ({
      traceId: `tr_${id}`,
      approvalId: id,
      capabilityId: 'app.winget.uninstall',
      risk: 'L2',
      decision: 'timeout',
      actor: 'approval-ttl',
      startedAtMs: 1,
    });
    c.recordDecision(mk('a1'));
    c.recordDecision(mk('a2'));
    c.recordDecision(mk('a3'));
    assert.equal(c.decidedSize, 3);
    assert.equal(c.pruneDecided(['a2']), 2, '应摘掉 a1/a3');
    assert.equal(c.decidedSize, 1);
    assert.equal(c.pruneDecided(['a2']), 0, '幂等：已回收的不重复计数');
  });
});

/* ================================================================== *
 * O-4 · 决策优先级反例探针（canceled > timeout > rejected）
 * ================================================================== */

describe('T4 O-4 决策优先级：canceled 必须先于 timeout/rejected', () => {
  test('超时标记与取消同时在场 ⇒ 记 canceled（用户显式意图权重最高）', async () => {
    const store = new TaskStore({ approvalTtlMs: 0 });
    const rec = store.create();
    const { calls, sink } = decisionCapture();
    const c = wired(store, new Map([['apr_b', makeToken('apr_b')]]), sink);
    c.beginTask(rec.task.id);

    const p = c.raise(makeReq('apr_b', { taskId: rec.task.id }));
    c.noteTimeout('apr_b'); // 超时信号先在场
    store.requestCancel(rec.task.id); // 再由取消收口 —— 两条信号同时在场
    const outcome = await p;

    assert.equal(outcome.approved, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].decision, 'canceled', '必须记 canceled，不得被 timeout 抢先');
    assert.equal(calls[0].actor, 'cancel-request');
    c.endTask(rec.task.id);
  });

  test('超时标记 + 无取消 ⇒ 仍记 timeout（canceled 不得凭空出现）', async () => {
    const store = new TaskStore({ approvalTtlMs: 0 });
    const rec = store.create();
    const { calls, sink } = decisionCapture();
    const c = wired(store, new Map([['apr_d', makeToken('apr_d')]]), sink);
    c.beginTask(rec.task.id);

    const p = c.raise(makeReq('apr_d', { taskId: rec.task.id }));
    c.noteTimeout('apr_d');
    store.resolveApproval(rec.task.id, 'apr_d', false);
    await p;

    assert.equal(calls.length, 1);
    assert.equal(calls[0].decision, 'timeout');
    assert.equal(calls[0].actor, 'approval-ttl');
    c.endTask(rec.task.id);
  });

  test('取消判据**只走** TaskStore.isCancelled()（不另读状态字段 ⇒ 无第二份真相）', async () => {
    const asked = [];
    const spy = {
      waitApproval() {
        return Promise.resolve(false);
      },
      // 存储态故意给 canceled，但 isCancelled 回答 false ⇒ 决策必须是 rejected
      tryGet() {
        return { task: { metadata: {}, status: { state: 'canceled' } } };
      },
      isCancelled(id) {
        asked.push(id);
        return false;
      },
    };
    const { calls, sink } = decisionCapture();
    const c = wired(spy, new Map([['apr_s', makeToken('apr_s')]]), sink);
    c.beginTask('t_s');
    await c.raise(makeReq('apr_s', { taskId: 't_s' }));
    assert.equal(asked.length, 1, 'isCancelled 恰被问一次（单点判据）');
    assert.equal(calls[0].decision, 'rejected', '状态字段不参与判定，只有 isCancelled 算数');
    c.endTask('t_s');
  });

  test('既有替身无 isCancelled ⇒ 可选调用退回旧路径（r19c-a5 零红的兼容前提）', async () => {
    const spy = {
      waitApproval() {
        return Promise.resolve(false);
      },
      tryGet() {
        return undefined;
      },
    };
    const { calls, sink } = decisionCapture();
    const c = wired(spy, new Map([['apr_n', makeToken('apr_n')]]), sink);
    c.beginTask('t_n');
    const outcome = await c.raise(makeReq('apr_n', { taskId: 't_n' }));
    assert.equal(outcome.approved, false);
    assert.equal(calls[0].decision, 'rejected', '缺 isCancelled 时逐字退回 rejected');
    c.endTask('t_n');
  });
});

/* ================================================================== *
 * 判据② · 取证失败不得影响决策（O-5）
 * ================================================================== */

describe('T4 判据② 决策取证异常隔离', () => {
  test('协调器注入的 sink 抛错 ⇒ raise 结论不变，仅 warn 一次', async () => {
    const store = new TaskStore({ approvalTtlMs: 0 });
    const rec = store.create();
    const logger = fakeLogger();
    const { calls, sink } = decisionCapture(() => true);
    const c = wired(store, new Map([['apr_e', makeToken('apr_e')]]), sink, logger);
    c.beginTask(rec.task.id);

    const p = c.raise(makeReq('apr_e', { taskId: rec.task.id }));
    store.resolveApproval(rec.task.id, 'apr_e', false);
    const outcome = await p;

    assert.equal(outcome.approved, false, '取证失败绝不改判为放行');
    assert.equal(outcome.reason, 'rejected', '结论也不得被取证异常污染');
    assert.equal(calls.length, 1, 'sink 确实被调用（异常来自 sink 而非未接线）');
    assert.equal(logger.warns.length, 1);
    assert.match(logger.warns[0].msg, /审批决策取证失败/);
    assert.equal(logger.warns[0].meta.approvalId, 'apr_e');
    c.endTask(rec.task.id);
  });

  test('未注入 sink（单测脱离服务直接实例化协调器）⇒ 零副作用不抛（缺席即 no-op）', async () => {
    const store = new TaskStore({ approvalTtlMs: 0 });
    const rec = store.create();
    const c = new VmApprovalCoordinator();
    c.bind(store, new Map([['apr_0', makeToken('apr_0')]]));
    c.beginTask(rec.task.id);

    const p = c.raise(makeReq('apr_0', { taskId: rec.task.id }));
    store.resolveApproval(rec.task.id, 'apr_0', false);
    const outcome = await p;
    assert.equal(outcome.approved, false);
    assert.equal(c.decidedSize, 1, '仍登记（去重语义与取证出口无关）');
    c.endTask(rec.task.id);
  });

  test('recordApprovalDecisionAudit：链写抛错 ⇒ {ok:false} + warn，**绝不上抛**（O-5）', async () => {
    const { audit, appended } = fakeAudit({ throwAt: 0 });
    const logger = fakeLogger();
    const r = await recordApprovalDecisionAudit(
      audit,
      logger,
      {
        traceId: 'tr_1',
        approvalId: 'apr_1',
        capabilityId: 'app.winget.uninstall',
        risk: 'L2',
        decision: 'timeout',
        actor: 'approval-ttl',
        startedAtMs: Date.now() - 5,
      },
      () => 'aud_1',
    );
    assert.equal(r.ok, false);
    assert.match(String(r.error), /append-boom/);
    assert.equal(appended.length, 0, '抛错前未落任何条目');
    assert.equal(logger.warns.length, 1);
    assert.match(logger.warns[0].msg, /approval-decision 审计写入失败/);
  });

  test('账本登记（onRecorded）抛错 ⇒ 仍算落链成功，只 warn（两道闸各自隔离）', async () => {
    const { audit } = fakeAudit();
    const logger = fakeLogger();
    const r = await recordApprovalDecisionAudit(
      audit,
      logger,
      {
        traceId: 'tr_2',
        approvalId: 'apr_2',
        capabilityId: 'app.winget.uninstall',
        risk: 'L2',
        decision: 'canceled',
        actor: 'cancel-request',
        startedAtMs: Date.now(),
      },
      () => 'aud_2',
      {
        channel: 'a2a',
        onRecorded: () => {
          throw new Error('ledger-boom');
        },
      },
    );
    assert.equal(r.ok, true, '账本登记失败不得把取证判成失败');
    assert.equal(logger.warns.length, 1);
    assert.match(logger.warns[0].msg, /账本登记失败/);
  });
});

/* ================================================================== *
 * §1.2-1 权威字段表（判据①②的产物形态）
 * ================================================================== */

describe('T4 决策条目形态：逐字段对齐设计 §1.2-1', () => {
  test('三态各落一条：matchedRule / errorCode / approvedBy / ext.kind 可证', async () => {
    const { audit, appended } = fakeAudit();
    const logger = fakeLogger();
    const mk = (decision, actor) =>
      recordApprovalDecisionAudit(
        audit,
        logger,
        {
          traceId: `tr_${decision}`,
          approvalId: `apr_${decision}`,
          capabilityId: 'app.winget.uninstall',
          risk: 'L2',
          decision,
          actor,
          taskId: 'task_1',
          delegationId: 'dlg_1',
          startedAtMs: Date.now() - 10,
          ...(decision === 'timeout' ? { ttlMs: 1_800_000 } : {}),
        },
        () => `aud_${decision}`,
        { channel: decision === 'canceled' ? 'a2a' : 'mcp' },
      );
    await Promise.all([mk('rejected', 'host'), mk('timeout', 'approval-ttl'), mk('canceled', 'cancel-request')]);

    assert.equal(appended.length, 3);
    const byDecision = {};
    for (const rec of appended) {
      assert.equal(rec.policyDecision.allowed, false, '否定决策一律 allowed:false');
      assert.equal(rec.policyDecision.matchedRule, `approval-decision:${rec.ext.decision}`);
      assert.equal(rec.result.ok, false);
      assert.equal(rec.result.summary, `approval-decision:${rec.ext.decision}（未执行）`);
      assert.equal(rec.ext.kind, 'approval-decision');
      assert.ok(typeof rec.approval.approvedBy === 'string' && rec.approval.approvedBy.length > 0, 'actor 必须落到 approval.approvedBy');
      assert.equal(rec.approval.previewHash, '', '决策条目无预览哈希（占位空串，与 §1.2-1 一致）');
      assert.equal(rec.ext.channel, rec.principal.channel, 'ext.channel 与 principal.channel 同源');
      assert.ok(!JSON.stringify(rec).includes('null'), '不得出现显式 undefined 落成的 null');
      byDecision[rec.ext.decision] = rec;
    }
    assert.equal(byDecision.rejected.approval.approvedBy, 'host');
    assert.equal(byDecision.timeout.approval.approvedBy, 'approval-ttl');
    assert.equal(byDecision.canceled.approval.approvedBy, 'cancel-request');
    assert.equal(byDecision.rejected.result.errorCode, 'APPROVAL_REJECTED');
    assert.equal(byDecision.timeout.result.errorCode, 'APPROVAL_TIMEOUT');
    assert.equal(byDecision.canceled.result.errorCode, 'APPROVAL_CANCELED');
    assert.equal(byDecision.canceled.principal.channel, 'a2a', '通道归因由装配层传入，不硬编码');
    assert.equal(byDecision.rejected.principal.channel, 'mcp', '缺省通道 = mcp（与既有两函数同口径）');
  });

  test('纯附加纪律：缺席成员整键不落（禁显式 undefined ⇒ canonicalJson 假断链）', async () => {
    const { audit, appended } = fakeAudit();
    await recordApprovalDecisionAudit(
      audit,
      fakeLogger(),
      {
        traceId: '',
        approvalId: 'apr_min',
        capabilityId: 'app.winget.uninstall',
        risk: 'L2',
        decision: 'rejected',
        actor: 'host',
        startedAtMs: Date.now(),
      },
      () => 'aud_min',
    );
    const ext = appended[0].ext;
    assert.equal('taskId' in ext, false, '无 taskId ⇒ 键必须缺席');
    assert.equal('delegationId' in ext, false);
    assert.deepEqual(Object.keys(ext).sort(), ['channel', 'decision', 'kind']);
    assert.deepEqual(appended[0].params, {}, 'params 缺席回落空对象（与 blocked 条目同口径）');
  });
});

/* ================================================================== *
 * O-7 · 壳/内部条目必须写原始 sink
 * ================================================================== */

describe('T4 判据④/⑤ O-7 防审计自证', () => {
  test('行为反例探针：壳条目经 wrapAuditSink ⇒ 账本 +1（自证）；写原始 sink ⇒ 账本不动', async () => {
    // 反例（错误装配）：经包装 sink ⇒ 内部条目把自己登记成「本回合有活动」
    const regBad = new LedgerRegistry();
    const ledgerBad = regBad.begin('dlg_bad', 'task_bad', []); // 空能力面 = 不限制（wild 可归入）
    const baseBad = fakeAudit();
    const wrapped = wrapAuditSink(baseBad.audit, (rec) => regBad.onAuditRecord(rec), fakeLogger());
    const entry = buildChainArchiveVerifyAuditEntry(
      { traceId: 'tr_arch', startedAtMs: Date.now(), results: [], shardsTotal: 0 },
      () => 'aud_arch',
    );
    await wrapped.append(entry);
    assert.equal(ledgerBad.activityCount().total, 1, '反例前提成立：经包装 sink ⇒ 活动面被污染');

    // 正确装配：写原始 sink ⇒ 账本零增长
    const regOk = new LedgerRegistry();
    const ledgerOk = regOk.begin('dlg_ok', 'task_ok', []);
    const baseOk = fakeAudit();
    await baseOk.audit.append(
      buildChainArchiveVerifyAuditEntry(
        { traceId: 'tr_arch2', startedAtMs: Date.now(), results: [], shardsTotal: 0 },
        () => 'aud_arch2',
      ),
    );
    assert.equal(ledgerOk.activityCount().total, 0, '写原始 sink ⇒ 取证面不变成活动面');
  });

  test('源码钉：决策取证与启动归档校验都写**原始 audit**（不是 auditSink）', () => {
    const m = SERVER_SRC.match(/approvalCoordinator\.setDecisionSink\(\(input\) => \{([\s\S]{0,1200}?)\n  \}\);/);
    assert.ok(m, '未找到 setDecisionSink 装配块');
    const blk = m[1];
    assert.match(blk, /recordApprovalDecisionAudit\(\s*\n\s*audit,/, '决策条目必须写原始 audit');
    assert.equal(/auditSink/.test(blk), false, '决策取证经 auditSink = 违反 O-7');
    assert.match(blk, /if \(input\.decision === 'approved'\) return;/, '装配层第二道闸拦住 approved');

    const i = SERVER_SRC.indexOf('const results = await audit.verifyArchive();');
    assert.ok(i > 0, '未找到启动归档校验块');
    const arch = SERVER_SRC.slice(i, i + 1500);
    assert.match(arch, /await audit\.append\(/, '归档条目写原始 audit');
    assert.equal(/auditSink\.append\(/.test(arch), false, '归档条目经包装 sink = 违反 O-7');
  });

  test('源码钉：决策取证件写原始 sink 的纪律在 approval-replay 有可 grep 声明', () => {
    const replay = readFileSync(SRC_REPLAY, 'utf8');
    assert.match(replay, /落链目标必须是\*\*原始 sink\*\*（O-7）/);
    assert.match(replay, /export async function recordApprovalDecisionAudit\(\n {2}audit: AuditAppender,/);
  });
});

/* ================================================================== *
 * 判据③ · /health.audit.scope（chainValid 语义不变）
 * ================================================================== */

describe('T4 判据③ /health.audit 校验范围透出', () => {
  test('真实 sink（freshChainOnStart:true）⇒ scope=session，三计数自洽，chainValid 语义不变', async () => {
    const dir = newDir('scope');
    try {
      const fresh = new HashChainAuditSink({ dir, freshChainOnStart: true });
      await fresh.append(chainEntry('aud_f1'));
      const v = await fresh.verifyChain();
      assert.equal(v.valid, true, 'chainValid 仍由链自洽决定（新字段只是说实话）');
      assert.equal(v.entries, 1);
      assert.equal(v.scope, 'session', 'freshChain ⇒ 结论只覆盖本轮');
      assert.equal(typeof v.shardsVerified, 'number');
      assert.equal(typeof v.shardsTotal, 'number');
      assert.equal(v.shardsArchived, Math.max(v.shardsTotal - v.shardsVerified, 0), 'shardsArchived 自洽');
      assert.ok(v.shardsVerified >= 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('未开 freshChain ⇒ scope=full（对照：范围语义不是恒 session 的装饰）', async () => {
    const dir = newDir('full');
    try {
      const sink = new HashChainAuditSink({ dir });
      await sink.append(chainEntry('aud_g1'));
      const v = await sink.verifyChain();
      assert.equal(v.valid, true);
      assert.equal(v.scope, 'full');
      assert.equal(v.shardsArchived, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('装配透出为条件展开：旧 sink 不回吐 scopeInfo ⇒ 四字段整体缺席（纯附加）', async () => {
    const dir = newDir('cond');
    try {
      const sink = new HashChainAuditSink({ dir, freshChainOnStart: true });
      await sink.append(chainEntry('aud_h1'));
      const healthAudit = buildAuditBlock(await sink.verifyChain());
      assert.equal(healthAudit.scope, 'session');
      assert.equal(healthAudit.chainValid, true);
      assert.equal(healthAudit.entries, 1);

      const legacy = buildAuditBlock({ entries: 7, valid: true });
      assert.deepEqual(Object.keys(legacy), ['entries', 'chainValid'], '旧形态：既有字段逐字保留，新字段全缺席');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('源码钉：health 的 audit 块保留 entries/chainValid 原取值路径，四字段按条件追加', () => {
    const i = SERVER_SRC.indexOf('      audit: {\n        entries: chain.entries,');
    assert.ok(i > 0, 'audit 块前两行形态被改动（chainValid 可能被换源）');
    const blk = SERVER_SRC.slice(i, i + 1200);
    assert.match(blk, /chainValid: chain\.valid,/);
    for (const k of ['scope', 'shardsVerified', 'shardsTotal', 'shardsArchived']) {
      assert.ok(
        blk.includes(`chain.${k} !== undefined ? { ${k}: chain.${k} } : {}`),
        `${k} 未按条件展开（非纯附加，旧 sink 下会写出 undefined）`,
      );
    }
  });
});

/* ================================================================== *
 * 判据④ · 启动归档校验条目（§1.3-3 权威字段）
 * ================================================================== */

describe('T4 判据④ chain-archive-verify 条目形态', () => {
  test('无断裂 ⇒ ok:true + 范围诚实（越界片只计数并写进 summary）', () => {
    const results = [
      { shard: 'shard-0001.jsonl', valid: true, entries: 10, checked: 10 },
      { shard: 'shard-0002.jsonl', valid: true, entries: 10, checked: 10 },
    ];
    const entry = buildChainArchiveVerifyAuditEntry(
      { traceId: 'tr_boot', startedAtMs: Date.now() - 3, results, shardsTotal: 45 },
      () => 'aud_boot',
    );
    assert.equal(entry.capabilityId, 'meta.audit.chain', '§1.3-3 权威值（不占业务能力面）');
    assert.equal(entry.risk, 'L0');
    assert.equal(entry.principal.channel, 'internal', '服务端自发条目，不是外部主体');
    assert.deepEqual(entry.policyDecision, { allowed: true, matchedRule: 'internal:chain-archive-verify' });
    assert.equal(entry.result.ok, true);
    assert.equal('errorCode' in entry.result, false, '无断裂不得造错误码');
    assert.match(entry.result.summary, /已校验 2\/45 片无断裂/);
    assert.match(entry.result.summary, /43 片超出上界未校验/, '越界必须写进 summary（防误读为全量完好）');
    assert.equal(entry.ext.kind, 'chain-archive-verify');
    assert.deepEqual(entry.ext.archive, { shardsTotal: 45, shardsVerified: 2, broken: [] });
    assert.deepEqual(entry.params, { shardsTotal: 45, shardsVerified: 2, notVerified: 43 });
    assert.ok(Number.isFinite(entry.durationMs) && entry.durationMs >= 0);
  });

  test('有断裂 ⇒ ok:false + ARCHIVE_CHAIN_BROKEN + broken 只记片名（防体积随分片线性膨胀）', () => {
    const results = [
      { shard: 'shard-0007.jsonl', valid: false, entries: 5, checked: 3, brokenAt: 3, reason: 'HASH_MISMATCH' },
      { shard: 'shard-0008.jsonl', valid: true, entries: 5, checked: 5 },
    ];
    const entry = buildChainArchiveVerifyAuditEntry(
      { traceId: 'tr_broken', startedAtMs: Date.now() - 1, results, shardsTotal: 2 },
      () => 'aud_broken',
    );
    assert.equal(entry.result.ok, false);
    assert.equal(entry.result.errorCode, 'ARCHIVE_CHAIN_BROKEN');
    assert.deepEqual(entry.ext.archive.broken, ['shard-0007.jsonl']);
    assert.equal(entry.ext.archive.shardsVerified, 2);
    assert.match(entry.result.summary, /1 片断裂/);
  });

  test('零归档片也落条目（"没有历史"是可证事实）；total<verified 误传不产出负数', () => {
    const empty = buildChainArchiveVerifyAuditEntry(
      { traceId: 'tr_empty', startedAtMs: Date.now(), results: [], shardsTotal: 0 },
      () => 'aud_empty',
    );
    assert.equal(empty.result.ok, true);
    assert.equal(empty.ext.archive.shardsVerified, 0);
    assert.equal(empty.params.notVerified, 0);

    const bad = buildChainArchiveVerifyAuditEntry(
      { traceId: 'tr_bad', startedAtMs: Date.now(), results: [{ shard: 's', valid: true }], shardsTotal: 0 },
      () => 'aud_bad',
    );
    assert.equal(bad.params.notVerified, 0, '越界数夹到 0，不产出负数事实');
  });

  test('条目真实入链后链仍自洽（哈希重算无假断链）', async () => {
    const dir = newDir('arch');
    try {
      const sink = new HashChainAuditSink({ dir, freshChainOnStart: true });
      await sink.append(
        buildChainArchiveVerifyAuditEntry(
          {
            traceId: 'tr_real',
            startedAtMs: Date.now() - 2,
            results: [{ shard: 'x.jsonl', valid: true, entries: 1, checked: 1 }],
            shardsTotal: 1,
          },
          () => 'aud_real',
        ),
      );
      const v = await sink.verifyChain();
      assert.equal(v.valid, true, '归档校验条目入链后链自洽（条件展开纪律生效）');
      assert.equal(v.entries, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('启动块装配事实：fire-and-forget + 总数与有界结果集分源', () => {
    const head = SERVER_SRC.indexOf('/* ---- ARCH-06 A2：启动期**历史归档分片**校验');
    assert.ok(head > 0, '未找到 ARCH-06 启动校验注释块（该装配点缺席）');
    const i = SERVER_SRC.indexOf('  void (async () => {', head);
    assert.ok(i > 0, '启动块不是 fire-and-forget（void 异步）⇒ 可能阻塞启动');
    const blk = SERVER_SRC.slice(i, i + 1600);
    assert.match(blk, /const results = await audit\.verifyArchive\(\);/);
    assert.match(blk, /const chain = await audit\.verifyChain\(\);/, '总数须另取 verifyChain（分源）');
    assert.match(blk, /shardsTotal: chain\.shardsTotal \?\? results\.length/);
    assert.match(blk, /buildChainArchiveVerifyAuditEntry\(/);
    assert.match(blk, /logger\.warn\('启动归档校验失败/);
  });
});

/* ================================================================== *
 * 判据⑦ · 委派取消在链上的终态口径
 * ================================================================== */

describe('T4 判据⑦ observer 三分支：canceled 终态 + TASK_CANCELED', () => {
  test('terminalState=canceled ⇒ ext.terminalState / summary / errorCode 一致', () => {
    const entry = buildDelegationAuditEntry('complete', {
      delegationTraceId: 'dlg_1',
      taskId: 'task_1',
      goal: '卸载 SomeApp',
      startedAtMs: Date.now() - 20,
      newAuditId: () => 'aud_d1',
      terminalState: 'canceled',
      ok: false,
      errorCode: 'TASK_CANCELED',
    });
    assert.equal(entry.ext.terminalState, 'canceled');
    assert.match(entry.result.summary, /^delegation\.complete:canceled/);
    assert.equal(entry.result.errorCode, 'TASK_CANCELED', '取消码不得被通用 EXECUTION_FAILED 顶替');
    assert.equal(entry.result.ok, false);
  });

  test('源码钉：三分支形态 + canceled 前置 errorCode（O-3 / 判据⑦实现体）', () => {
    assert.match(
      SERVER_SRC,
      /const canceledTerminal = snap\.state === 'canceled' \|\| storedState === 'canceled';/,
      '取消判据源缺席（快照或存储任一 canceled 都算）',
    );
    assert.match(
      SERVER_SRC,
      /const terminalState = canceledTerminal\n {8}\? 'canceled'\n {8}: snap\.state === 'failed' && storedState === 'rejected' \? 'rejected' : snap\.state;/,
      '三分支形态被改动（O-3：canceled 必须先判）',
    );
    assert.match(
      SERVER_SRC,
      /const errorCode =\n {8}ok \|\| snap\.state === 'input-required'\n {10}\? undefined\n {10}: canceledTerminal\n {12}\? 'TASK_CANCELED'/,
      'errorCode 缺 canceled 前置分支 ⇒ 会被 result.error.reason 通用码顶替',
    );
    // 既有钉字面逐字保住（不得因三分支改动而漂）
    assert.match(SERVER_SRC, /const storedState = taskStore\.tryGet\(taskId\)\?\.task\.status\.state;/);
    assert.match(SERVER_SRC, /result\?\.error\?\.reason \?\?/);
    assert.match(SERVER_SRC, /\n            terminalState,\n/);
    assert.equal(/terminalState:\s*'failed',/.test(SERVER_SRC), false);
  });

  test('变异自证：摘掉 canceled 分支后上述源码钉必须变红（防恒真）', () => {
    const mutated = SERVER_SRC.replace(
      "const terminalState = canceledTerminal\n        ? 'canceled'\n        : snap.state === 'failed' && storedState === 'rejected' ? 'rejected' : snap.state;",
      "const terminalState =\n        snap.state === 'failed' && storedState === 'rejected' ? 'rejected' : snap.state;",
    );
    assert.notEqual(mutated, SERVER_SRC, '变异打空（源码形态与预期不符）');
    assert.equal(
      /const terminalState = canceledTerminal\n {8}\? 'canceled'/ .test(mutated),
      false,
      '摘掉 canceled 分支后源码钉仍绿 ⇒ 断言恒真',
    );
    const mutatedCode = SERVER_SRC.replace(/\n {10}: canceledTerminal\n {12}\? 'TASK_CANCELED'/, '');
    assert.notEqual(mutatedCode, SERVER_SRC, 'errorCode 变异打空');
    assert.equal(
      /canceledTerminal\n {12}\? 'TASK_CANCELED'/.test(mutatedCode),
      false,
      '摘掉 TASK_CANCELED 前置分支后源码钉仍绿 ⇒ 断言恒真',
    );
  });

  test('completed / input-required 不得凭空造错误码（取消不是执行失败的兜底）', () => {
    const ok = buildDelegationAuditEntry('complete', {
      delegationTraceId: 'dlg_ok',
      taskId: 't',
      goal: 'g',
      startedAtMs: Date.now(),
      newAuditId: () => 'a1',
      terminalState: 'completed',
      ok: true,
    });
    assert.equal('errorCode' in ok.result, false);
    const wait = buildDelegationAuditEntry('complete', {
      delegationTraceId: 'dlg_wait',
      taskId: 't',
      goal: 'g',
      startedAtMs: Date.now(),
      newAuditId: () => 'a2',
      terminalState: 'input-required',
      ok: false,
    });
    assert.equal('errorCode' in wait.result, false, '等待人工不是执行错误');
  });
});

/* ================================================================== *
 * 判据⑥ · 装配线（令牌表替身 + 清扫取证落点 + 停表）
 * ================================================================== */

describe('T4 判据⑥ 装配线：Registry 接入与清扫取证落点', () => {
  test('Registry 可直接作 collectApprovalFacts 实参（ReadonlyMap 形参兼容 ⇒ 区 6 文本零改）', () => {
    const reg = new PendingApprovalRegistry({ ttlMs: 60_000 });
    reg.set('apr_1', makeToken('apr_1', { createdAtMs: Date.now() - 50 }));
    reg.set('apr_2', makeToken('apr_2', { createdAtMs: Date.now() - 40 }));
    reg.set('apr_3', makeToken('apr_3', { createdAtMs: Date.now() - 30, hostApproved: true }));
    const facts = collectApprovalFacts(reg, { delegationTraceId: 'dlg_probe', startedAtMs: 0 }, Date.now());
    assert.deepEqual(
      facts.map((f) => f.approvalId),
      ['apr_1', 'apr_2', 'apr_3']
        .filter((id) => id !== 'apr_3')
        .sort(),
      '只返未决项（hostApproved:true 的在途条目不纳入事实）',
    );
    assert.equal(facts[0].risk, 'L2');
    assert.equal(facts[0].attribution, 'window', '无 delegationId ⇒ 时间窗兜底归因（R3）');
  });

  test('清扫 ⇒ recordDecision(timeout / mcp-ttl-sweep) 恰一条，并回收去重集', () => {
    const fired = [];
    const reg = new PendingApprovalRegistry({
      ttlMs: 1_000,
      now: () => Date.now(),
      setTimer: (fn) => {
        fired.push(fn);
        return { unref() {} };
      },
      clearTimer: () => {},
    });
    const { calls, sink } = decisionCapture();
    const c = new VmApprovalCoordinator();
    c.setDecisionSink(sink);

    // 一条已过期未批准 + 一条已过期但在途（hostApproved=true，O-10 不得逐）
    reg.set('stale', makeToken('stale', { createdAtMs: Date.now() - 5_000 }));
    reg.set('inflight', makeToken('inflight', { createdAtMs: Date.now() - 5_000, hostApproved: true }));

    let pruned = 0;
    reg.startTimer(undefined, (swept) => {
      for (const [approvalId, token] of swept) {
        c.recordDecision({
          traceId: token.traceId ?? '',
          approvalId,
          capabilityId: token.capabilityId,
          risk: token.risk,
          decision: 'timeout',
          actor: 'mcp-ttl-sweep',
          startedAtMs: token.createdAtMs,
        });
      }
      pruned += c.pruneDecided(reg.keys());
    });
    assert.equal(fired.length, 1);
    fired[0]();

    assert.equal(calls.length, 1, '只逐出未决项 ⇒ 恰一条决策取证');
    assert.equal(calls[0].actor, 'mcp-ttl-sweep', '§1.2-3 表末行的可 grep 归因');
    assert.equal(calls[0].decision, 'timeout');
    assert.equal(reg.has('inflight'), true, 'O-10：在途条目必须保留');
    assert.equal(reg.has('stale'), false);
    assert.equal(pruned, 1, '去重集随清扫回收（ENG-01 有界性递归成立）');

    fired[0]();
    assert.equal(calls.length, 1, '第二轮无逐出 ⇒ 不冒第二条假决策');
  });

  test('源码钉：装配三接线齐备 + TTL 复用既有旋钮 + 不新造 env 名', () => {
    assert.match(SERVER_SRC, /const pendingApprovals = new PendingApprovalRegistry<PendingApproval>\(\{/);
    assert.match(SERVER_SRC, /ttlMs: resolveApprovalTtlMs\(\)/, 'TTL 复用 WINVM_APPROVAL_TTL_MS（同一旋钮、同一语义）');
    assert.match(SERVER_SRC, /approvalCoordinator\.setDecisionSink\(/);
    assert.match(SERVER_SRC, /pendingApprovals\.startTimer\(undefined, \(swept\) => \{/);
    assert.match(SERVER_SRC, /approvalCoordinator\.pruneDecided\(pendingApprovals\.keys\(\)\);/);
    assert.match(SERVER_SRC, /approvalCoordinator\.bind\(a2a\.tasks, pendingApprovals\);/, 'bind 行逐字不变');
    assert.match(SERVER_SRC, /actor: 'mcp-ttl-sweep'/);
    // 不新造同义 env 旋钮（§8 硬纪律）
    const joined = SERVER_SRC + readFileSync(SRC_HTTP_GUARD, 'utf8') + readFileSync(SRC_REGISTRY, 'utf8');
    assert.equal(/WINVM_[A-Z_]*(PENDING|SWEEP|TOKEN_TTL|BEARER_TOKEN_TTL)[A-Z_]*/.test(joined), false);
  });

  test('源码钉：close() 内先停清扫表再关 HTTP（无残留定时器）', () => {
    const i = SERVER_SRC.indexOf('    async close() {');
    assert.ok(i > 0);
    const blk = SERVER_SRC.slice(i, i + 800);
    assert.match(blk, /pendingApprovals\.close\(\);/);
    assert.ok(
      blk.indexOf('pendingApprovals.close()') < blk.indexOf('server.close('),
      '清扫器须先于 HTTP 关闭停表（防边关边扫写链）',
    );
  });

  test('TaskStore 构造显式声明有界值（与 /health.tasks 透出同源，行为与框架缺省逐字相同）', () => {
    assert.match(SERVER_SRC, /const TASK_STORE_MAX_TASKS = 200;/);
    assert.match(SERVER_SRC, /const TASK_STORE_TERMINAL_TTL_MS = 3_600_000;/);
    const i = SERVER_SRC.indexOf('const taskStore = new TaskStore({');
    assert.ok(i > 0);
    const blk = SERVER_SRC.slice(i, i + 400);
    assert.match(blk, /maxTasks: TASK_STORE_MAX_TASKS,/);
    assert.match(blk, /terminalTtlMs: TASK_STORE_TERMINAL_TTL_MS,/);
    assert.match(blk, /approvalCoordinator\.noteTimeout\(approvalId\);/, 'k5-replay 接线钉：noteTimeout 行逐字保位');
  });
});

/* ================================================================== *
 * 判据⑤ · 装配面（守卫挂载位置 + health 三态同源）
 * ================================================================== */

describe('T4 判据⑤ 装配面：守卫挂载与 security 透出', () => {
  const GUARD_AT = SERVER_SRC.indexOf('if (guardActive) {');

  test('guardActive 双条件源与 resolveBearerToken 同判据（不另写条件）', () => {
    assert.match(SERVER_SRC, /const bearerToken = resolveBearerToken\(cfg\.security\.enforceBearer, cfg\.security\.tokenEnv\);/);
    assert.match(SERVER_SRC, /const guardActive = bearerToken !== undefined;/);
    assert.ok(GUARD_AT > 0, '守卫挂载块缺席');
    const blk = SERVER_SRC.slice(GUARD_AT, GUARD_AT + 420);
    assert.match(blk, /const verdict = bearerGuard\(req as GuardableRequest\);/);
    assert.match(blk, /if \(verdict\.verdict === 'deny'\) \{/);
    assert.match(blk, /sendJson\(res, 401, BEARER_UNAUTHORIZED_BODY\);/);
    assert.equal(/if \(cfg\.security\.enforceBearer\) \{/.test(blk), false, '装配层不得另写单条件（O-9 半开风险）');
  });

  test('挂载点先于 405 与所有路由分发（含 admin，防绕过）', () => {
    for (const mark of MUST_FOLLOW_GUARD) {
      assert.ok(SERVER_SRC.indexOf(mark) > 0, `锚文本缺席：${mark}`);
    }
    assert.equal(guardPrecedesAll(SERVER_SRC), true, '守卫未先于全部分发点');
  });

  test('路由切片锚仍相邻成立（守卫挂载未侵入 sliceRoute 区间）', () => {
    const mcp = slice(SERVER_SRC, "if (path === '/mcp' && req.method === 'POST')", "if (path === '/audit/receipt'");
    assert.ok(mcp.length > 0, 'MCP_ROUTE 被切空 ⇒ 锚区间被侵入');
    assert.ok(mcp.includes("const dtid = url.searchParams.get('dtid') ?? undefined;"));
    const rcp = slice(SERVER_SRC, "if (path === '/audit/receipt' && req.method === 'GET')", "if (path === '/a2a' && req.method === 'POST')");
    assert.ok(rcp.length > 0, 'RECEIPT_ROUTE 被切空');
    assert.equal((SERVER_SRC.match(/process\.env\[['"]WINVM_ADMIN_ENDPOINT['"]\]/g) ?? []).length, 1, 'admin env 仍单点读取');
  });

  test('变异自证：守卫被挪到 /health 分发之后 ⇒ 位置判据必须变红（防恒真）', () => {
    const start = GUARD_AT;
    const endMark = '\n      // 仅允许 POST/GET';
    const end = SERVER_SRC.indexOf(endMark, start);
    assert.ok(end > start, '守卫块边界提取失败');
    const blk = SERVER_SRC.slice(start, end);
    assert.ok(blk.length > 50, '守卫块内容为空（变异会打空）');

    const healthLine = '          sendJson(res, 200, await buildHealth());';
    const mutated = SERVER_SRC.slice(0, start) + SERVER_SRC.slice(end);
    const mutated2 = mutated.replace(healthLine, `${healthLine}\n${blk}`);
    assert.notEqual(mutated2, mutated, '插入锚缺席 ⇒ 变异打空');
    assert.notEqual(mutated2, SERVER_SRC, '变异未改动源码');

    assert.equal(guardPrecedesAll(SERVER_SRC), true, '基线须满足位置判据');
    assert.equal(
      guardPrecedesAll(mutated2),
      false,
      '守卫被挪到路由之后却仍判合格 ⇒ 位置断言恒真，需收紧',
    );
  });

  test('health 透出 security 三态与 tasks 有界事实（与守卫同源）', () => {
    assert.match(SERVER_SRC, /security: buildSecurityHealth\(\),/);
    assert.match(SERVER_SRC, /function buildSecurityHealth\(\): SecurityHealth \{/);
    assert.match(SERVER_SRC, /buildSecurityHealthSnapshot\(\{/);
    assert.match(SERVER_SRC, /boundHost,/);
    assert.match(SERVER_SRC, /\n {6}tasks: \{\n {8}live: taskStore\.size\(\),/);
    assert.match(SERVER_SRC, /maxTasks: TASK_STORE_MAX_TASKS,/);
    assert.match(SERVER_SRC, /terminalTtlMs: TASK_STORE_TERMINAL_TTL_MS,/);
    // 纯函数落 http-guard（可脱服务直测），server.ts 只喂实测地址
    const guard = readFileSync(SRC_HTTP_GUARD, 'utf8');
    assert.match(guard, /export function buildSecurityHealth\(/);
    assert.match(guard, /authMode: resolveAuthMode\(opts\.enforceBearer, opts\.tokenEnv,/);
    assert.match(guard, /export function resolveAuthMode\(/);
  });

  test('禁碰区：freshChainOnStart 值仍恰一处 true（装配层未偷改链基线语义）', () => {
    assert.equal((SERVER_SRC.match(/freshChainOnStart: true,/g) ?? []).length, 1);
  });
});

/* ------------------------------------------------------------------ *
 * 装配透出复用函数（与 server.ts 区 9 同口径，供反例对照）
 * ------------------------------------------------------------------ */

/** 装配位置判据（唯一口径，供位置断言与变异自证**共用** ⇒ 变异红的是同一判据）。 */
const MUST_FOLLOW_GUARD = [
  "if (req.method !== 'POST' && req.method !== 'GET')",
  "if (path === '/health' && req.method === 'GET')",
  "if (path === '/.well-known/agent-card.json' && req.method === 'GET')",
  "if (path === '/mcp' && req.method === 'POST')",
  "if (path === '/audit/receipt'",
  "if (path === '/a2a' && req.method === 'POST')",
  "process.env['WINVM_ADMIN_ENDPOINT']",
];
function guardPrecedesAll(src) {
  const g = src.indexOf('if (guardActive) {');
  if (g < 0) return false;
  if (!(src.indexOf('const path = url.pathname;') < g)) return false;
  return MUST_FOLLOW_GUARD.every((mark) => {
    const at = src.indexOf(mark);
    return at > 0 && g < at;
  });
}

/** 与 `buildHealth` 的 audit 块逐字同构的映射（旧 sink 缺席即字段缺席）。 */
function buildAuditBlock(chain) {
  return {
    entries: chain.entries,
    chainValid: chain.valid,
    ...(chain.brokenAt !== undefined ? { brokenAt: chain.brokenAt } : {}),
    ...(chain.reason ? { reason: chain.reason } : {}),
    ...(chain.scope !== undefined ? { scope: chain.scope } : {}),
    ...(chain.shardsVerified !== undefined ? { shardsVerified: chain.shardsVerified } : {}),
    ...(chain.shardsTotal !== undefined ? { shardsTotal: chain.shardsTotal } : {}),
    ...(chain.shardsArchived !== undefined ? { shardsArchived: chain.shardsArchived } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * 源码零写自证（与 kn1-e-mutation 同纪律）
 * ------------------------------------------------------------------ */

const GUARDED = [SRC_SERVER, SRC_HTTP_GUARD, SRC_REPLAY, SRC_REGISTRY].map((p) => ({
  p,
  hash: createHash('sha256').update(readFileSync(p)).digest('hex'),
}));

describe('T4 装配层守卫：本文件不得写磁盘', () => {
  test('被断言源码文件字节未被本测试改动（变异仅存在于内存副本）', () => {
    const dirty = GUARDED.filter(
      ({ p, hash }) => createHash('sha256').update(readFileSync(p)).digest('hex') !== hash,
    ).map(({ p }) => p);
    assert.deepEqual(dirty, [], `以下文件被改动（本文件应零磁盘写）：${JSON.stringify(dirty)}`);
  });

  test('本文件不含写盘 API（异常安全：无需 try/finally 还原）', () => {
    const self = readFileSync(join(HERE, 'phase1-t4-assembly.test.js'), 'utf8');
    for (const api of ['writeFileSync', 'appendFileSync', 'copyFileSync', 'renameSync', 'unlinkSync']) {
      assert.equal(self.includes(`${api}(`), false, `不应出现写盘 API ${api}`);
    }
    assert.ok(self.includes('readFileSync('), '读接口允许');
  });
});

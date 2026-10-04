/**
 * T04 · CL-K3R「静默假成功」根治 —— 红档 A 组：`reconcileApprovalTruth` 判定表 7 门断言
 *
 * 被测对象：`reconcileApprovalTruth`（设计 §5.3 / §7.3，落地于
 *   `packages/adapter-agent-workbuddy-llm/src/delegation-truth.ts`，与 `reconcileDelegationTruth` 同文件同风格）。
 *
 * 接口契约（按设计 §7.3 + §8.2 SK-K1 精确命名与形状，工程师 T03 落地）：
 *   `reconcileApprovalTruth(base: LlmGoalResult, finalText: string, deps): Promise<LlmGoalResult>`
 *   其中 `deps` 由桥以 `{ input, ctx, enabled }` 形态注入（§7.3），并在 `ctx.delegationProbe` 携带
 *   服务端探针（SK-K1：`const probe = (ctx as any).delegationProbe`）。本文件为兼容工程师可能采用的
 *   两种取法（顶层 `deps.probe` 或 `deps.ctx.delegationProbe`，后者与兄弟函数 `reconcileDelegationTruth`
 *   的 `DelegationTruthDeps.probe` 同形）**同时**在 `deps.probe` 与 `deps.ctx.delegationProbe` 提供探针，
 *   并在 `deps.warn` 提供告警出口（门 4 记一条）。若工程师落地后的 `deps` 形状与本假设不符导致本红档
 *   无法转绿，回报主理人（team lead）协调，绝不自行改 packages/ 源码。
 *
 * 红档纪律（R19F 同）：本文件随 T04 先落，此时 T01–T03 尚未合入 dist，故 `reconcileApprovalTruth`
 *   尚未从 `@winvm/adapter-agent-workbuddy-llm` 导出 → 本文件运行即「模块不提供该导出」而红。
 * 这是**预期**的红：工程师 T03 落地 + `tsc -b` 重建 dist 后，本文件应整体转绿（§7.3 验收判据 1）。
 *
 * 运行（只跑本文件，绝不整批）：
 *   TMPDIR="$HOME/wbtmp" node --test tests/unit/r19c-k3r-approval-truth.test.js
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { reconcileApprovalTruth } from '@winvm/adapter-agent-workbuddy-llm';

/* ============================ 夹具 ============================ */

const CAP = 'app.winget.uninstall';
const TRACE = 'tr_k3r_my_77';
const TASK = 'task_k3r_1';
const STARTED = 1_000_000;

/** `LlmGoalResult` 最小形状（桥的产物，供判据函数消费；与 kn1-a-pure 同形） */
function baseResult(over = {}) {
  return {
    ok: true,
    summary: 'LLM 运行时完成目标：卸载 VM 企业微信',
    artifacts: [],
    steps: [
      {
        index: 0,
        capabilityId: CAP,
        params: { goal: '卸载 VM 企业微信' },
        ok: true,
        risk: 'L1',
        durationMs: 1200,
        summary: '执行中',
      },
    ],
    ...over,
  };
}

/** 一条未决审批的结构化事实（服务端权威；与 `PendingApprovalFact` 同形） */
function fact(over = {}) {
  return {
    approvalId: 'apr_k3r_1',
    capabilityId: CAP,
    risk: 'L2',
    createdAtMs: STARTED + 1000,
    attribution: 'window',
    hostApproved: false,
    ...over,
  };
}

/**
 * 可编程审批探针：同时提供 `delegationActivity`（K-N1 通道，恒零活动以隔离 K3R 判据）与
 * `approvalWait`（K3R 主通道）。`approvalWait` 的行为由 `facts / throws` 控制。
 */
function makeApprovalProbe({ facts = [], throws = false } = {}) {
  return {
    delegationActivity: async () => ({ total: 0, executed: 0, blocked: 0, wild: 0 }),
    approvalWait: async () => {
      if (throws) throw new Error('probe boom');
      return facts;
    },
  };
}

/**
 * 构造 `deps`（接口契约，见文件头注释）。同时提供 `deps.probe` 与 `deps.ctx.delegationProbe` 双路，
 * 并把 `startedAtMs` 同时放在 `ctx.started` / `ctx.startedAtMs` / `input.startedAtMs`，
 * 把归属键同时放在 `input.taskId` / `input.traceId` / `ctx.delegationId`，最大化与工程师落地形状的兼容。
 */
function deps(over = {}) {
  const probe = over.probe ?? makeApprovalProbe({ facts: over.facts ?? [] });
  const enabled = over.enabled ?? true;
  const raised = over.raised ?? new Set();
  const ctx = {
    started: STARTED,
    startedAtMs: STARTED,
    raised,
    delegationId: TRACE,
    delegationProbe: probe,
    ...(over.ctx ?? {}),
  };
  const input = {
    taskId: TASK,
    traceId: TRACE,
    startedAtMs: STARTED,
    capabilities: [CAP],
    ...(over.input ?? {}),
  };
  return {
    input,
    ctx,
    enabled,
    probe,
    ...(over.warn ? { warn: over.warn } : {}),
  };
}

/** 不含关键词文本（K3 场景：LLM 不说「APPROVAL_REQUIRED / 等待审批」） */
const NO_KEYWORD_TEXT = '操作已被安全策略拦截，需宿主确认后继续推进。\n';

/* ============================ 判定表 7 门 ============================ */

describe('CL-K3R `reconcileApprovalTruth` 判定表 7 门（设计 §5.3）', () => {
  test('门0: !base.ok 直接透传（不重复改判，与 D-1 结论互斥）', async () => {
    const base = baseResult({ ok: false, error: { code: 'EXECUTION_FAILED', message: 'x', retryable: false } });
    const r = await reconcileApprovalTruth(base, NO_KEYWORD_TEXT, deps({ facts: [fact()] }));
    assert.equal(r.ok, false, '已是失败态，保持');
    assert.equal(r.error?.code, 'EXECUTION_FAILED', 'error 原样透传，不二次改判');
  });

  test('门1: 无 taskId（非委派 / 纯 MCP 直调） → 透传文本启发式（旧行为零改动）', async () => {
    const base = baseResult();
    const d = deps({ input: { capabilities: [CAP] } }); // 无 taskId / traceId
    delete d.input.taskId;
    delete d.input.traceId;
    const r = await reconcileApprovalTruth(base, NO_KEYWORD_TEXT, d);
    assert.equal(r.ok, true, '无归属不介入：即便有 facts 也不改判');
  });

  test('门1(反例): 无 taskId + 文本命中关键词 → 仍走文本兜底产出 APPROVAL_REQUIRED', async () => {
    const base = baseResult();
    const d = deps({ input: { capabilities: [CAP] } });
    delete d.input.taskId;
    delete d.input.traceId;
    const r = await reconcileApprovalTruth(base, '工具返回 APPROVAL_REQUIRED，等待宿主审批\n', d);
    assert.equal(r.ok, false, '文本兜底确实委托给 reconcileApprovalWait');
    assert.equal(r.error?.code, 'APPROVAL_REQUIRED', 'A5 同款指纹（降级为兜底，函数体未改）');
  });

  test('门2: 灰度开关 off → 透传（一键回滚面，逐字 = R19F 后现状）', async () => {
    const base = baseResult();
    const r = await reconcileApprovalTruth(base, NO_KEYWORD_TEXT, deps({ enabled: false, facts: [fact()] }));
    assert.equal(r.ok, true, 'off 时即便有 facts 也完全回退');
  });

  test('门3: 无 probe / approvalWait 缺席 → 透传（兼容旧服务端 / 单测）', async () => {
    const base = baseResult();
    // 完全不传 probe
    const r1 = await reconcileApprovalTruth(base, NO_KEYWORD_TEXT, {
      input: { taskId: TASK, traceId: TRACE, capabilities: [CAP] },
      ctx: { started: STARTED, raised: new Set(), delegationId: TRACE },
      enabled: true,
    });
    assert.equal(r1.ok, true, '无 probe 整体缺席 → 透传');

    // probe 存在但 approvalWait 缺席
    const probeNoWait = { delegationActivity: async () => ({ total: 0, executed: 0, blocked: 0, wild: 0 }) };
    const r2 = await reconcileApprovalTruth(base, NO_KEYWORD_TEXT, {
      input: { taskId: TASK, traceId: TRACE, capabilities: [CAP] },
      ctx: { started: STARTED, raised: new Set(), delegationId: TRACE, delegationProbe: probeNoWait },
      enabled: true,
      probe: probeNoWait,
    });
    assert.equal(r2.ok, true, 'probe 无 approvalWait 成员 → 透传（SK-K1 可选成员纪律）');
  });

  test('门4: 探针抛错 → 透传 + warn 恰一条（fail-open，绝不挂死委派）', async () => {
    const base = baseResult();
    const warns = [];
    const r = await reconcileApprovalTruth(
      base,
      NO_KEYWORD_TEXT,
      deps({ probe: makeApprovalProbe({ throws: true }), warn: (m, meta) => warns.push([m, meta ?? {}]) }),
    );
    assert.equal(r.ok, true, '探针故障绝不改变 base.ok');
    assert.equal(warns.length, 1, '恰记一条 warn（不刷屏）');
  });

  test('门5: 探针返回 facts 空 → 透传（结构化说无未决审批则不强改判）', async () => {
    const base = baseResult();
    const r = await reconcileApprovalTruth(base, NO_KEYWORD_TEXT, deps({ facts: [] }));
    assert.equal(r.ok, true, 'facts 空 ⇒ 判据只做减法不做加法');
  });

  test('门6: 全部 fact 已在 raised → 透传（交 K4 旧 token 去重，不二次挂起）', async () => {
    const base = baseResult();
    const f = fact();
    const r = await reconcileApprovalTruth(
      base,
      NO_KEYWORD_TEXT,
      deps({ facts: [f], raised: new Set([f.approvalId]) }),
    );
    assert.equal(r.ok, true, '都已挂起过 ⇒ 不重复改判');
  });

  test('命中: 存在未 raise 未决 fact → 改判 ok:false + APPROVAL_REQUIRED + 服务端权威字段', async () => {
    const base = baseResult();
    const f = fact();
    const r = await reconcileApprovalTruth(base, NO_KEYWORD_TEXT, deps({ facts: [f] }));
    assert.equal(r.ok, false, 'K3 根治：结构化事实优先，与 LLM 措辞无关');
    assert.equal(r.error?.code, 'APPROVAL_REQUIRED', '复用 A5 同款 error code（指纹可比对，SK-K6）');
    assert.equal(r.error?.details?.approvalId, f.approvalId, '服务端权威 approvalId（非 LLM 文本抠）');
    assert.equal(r.error?.details?.capabilityId, f.capabilityId);
    assert.equal(r.error?.details?.risk, f.risk, '服务端策略引擎权威 risk（根治文本正则抠 risk）');
    assert.equal(r.error?.details?.attribution, f.attribution, '归因方式入证据（exact|window）');
    assert.ok(
      typeof r.error?.details?.source === 'string' && r.error.details.source.length > 0,
      'details.source 标记结构化来源（server-ledger / structured）',
    );
    assert.ok(r.summary.includes(f.approvalId), 'summary 携带服务端权威 approvalId 便于取证');
    assert.equal(r.steps.length, 1, 'steps 保留原长度');
    assert.equal(r.steps[0].ok, false, 'steps 全量翻 ok:false（未执行完成）');
  });

  test('命中-多 fact: 取最早未 raise（FIFO）优先，其余进 details.others', async () => {
    const base = baseResult();
    const facts = [
      fact({ approvalId: 'apr_old', createdAtMs: STARTED + 100 }),
      fact({ approvalId: 'apr_new', createdAtMs: STARTED + 200, risk: 'L1' }),
    ];
    const r = await reconcileApprovalTruth(base, NO_KEYWORD_TEXT, deps({ facts }));
    assert.equal(r.ok, false);
    assert.equal(r.error?.details?.approvalId, 'apr_old', 'FIFO：最老的未决项优先改判');
    assert.deepEqual(r.error?.details?.others, ['apr_new'], '其余未决项进 others 提示宿主逐条处理');
  });

  test('命中-单向性: 只做 ok:true → ok:false，绝不做 ok:false → ok:true（SK-K6 fail-closed）', async () => {
    // 即便 base 已是失败态（门0 已透传），结构化命中也不会把失败翻回成功
    const base = baseResult({ ok: false, error: { code: 'EXECUTION_FAILED', message: 'x', retryable: false } });
    const r = await reconcileApprovalTruth(base, NO_KEYWORD_TEXT, deps({ facts: [fact()] }));
    assert.equal(r.ok, false, '失败态不被结构化判据翻回成功（绝不制造新假成功）');
  });
});

/**
 * K5 修复单元测试：审批放行后**服务端确定性重放**（根治 A2A 假成功）
 *
 * 核心不变式（设计文档 §4）：能力是否真实执行，**只以服务端结构化回执（ExecutedResult）为准**；
 * LLM 文本永远不是完成证据。本文件按四层逐条钉死：
 *
 * A. `VmApprovalCoordinator.raise`（执行权收归服务端）
 *    ① 批准 → 用**留存原参数**调 replay → 返回 `{approved:true, executed}`；
 *    ② token **一次性消费**（成功/失败均删）；
 *    ③ 拒绝 / TTL 超时 / 无挂接任务 / token 消失 → `{approved:false, reason}` 且**绝不重放**；
 *    ④ 灰度 off（`setReplayEnabled(false)`）→ 只回 `{approved:true}`（executed 缺席）、
 *      token 保留（K4 `/mcp` 人工续跑路径仍可用）；
 *    ⑤ raise 用服务端留存的 preview/impact/underlying **补全**审批请求（宿主卡片信息量）。
 *
 * B. K5 纯逻辑件（`packages/vm-service/src/approval-replay.ts`，可脱离 HTTP 服务与 ps-bridge 断言）
 *    ① `toExecutedResult`：ok 口径 = `isError!==true && structuredContent.ok===true`；
 *    ② `recordBlockedApprovalAudit`：拦截路径入链（matchedRule='approval-required'、result.ok=false）
 *      + 写失败只 warn 不抛（拦截语义优先）+ 凭据脱敏；
 *    ③ `deriveUnderlying`：真实意图推断 + `redact` 脱敏 + 截断。
 *
 * C. `CliLlmBridge` 消费 `ApprovalOutcome`（续跑 prompt + 回执反查）
 *    ① `approved+executed` → 续跑轮注入**真实回执**（【系统已执行】），不再要求 LLM 重发；
 *    ② 回执反查两例：声称完成 + 无 ok 回执 → 改判 failed（NO_EXECUTION_RECEIPT）；
 *      声称完成 + 有 ok 回执 → 采信 completed；
 *    ③ 同 approvalId 二次进入 → **不二次挂起**（raise 只调一次），据已登记回执判定；
 *    ④ `approvalReplay=false`（灰度 off）→ 退回 K4 提示词行为（"请带 __approvalId 重发"）且**不做反查**；
 *    ⑤ 无 coordinator / 无审批任务（K3 路径）零改动：完成声称不被反查误杀；
 *    ⑥ 跨任务隔离：第二次 runGoal 的回执登记与反查标志清零（不被上一任务的成功回执洗白）。
 *
 * D. 宿主侧透传（`a2a-framework` + `host-a2a-bridge`）
 *    ① TaskStore approval-request data part 带 underlying / 缺席不写键；
 *    ② `extractApproval` 透传 underlying（非法整块省略 + 凭据脱敏）；
 *    ③ `buildA2aResumeHint` 带真实目标行；不带时**逐字不变**（保 CL-016 既有断言）。
 *
 * E. `vm-service/server.ts` 接线形态守卫 —— 本沙箱内 `createService` 会 spawn ps-bridge 并
 *    触发 V8 原生 fatal（起不了服务做行为级集成测试），故以源码形态断言钉死：
 *    执行段抽成命名函数且 handler/重放共用、K5 纯逻辑件零重复实现、拦截路径留存 traceId/impact/
 *    underlying 并写 blocked 审计、协调器注入 replay 与灰度开关（env 解析只在 core）、
 *    K4 安全点逐字保持、拒绝分支先于重放、绝不硬编码成功回执。
 *
 * 纪律：短 TTL（50–80ms）避免慢测；不起 HTTP 服务、不 spawn 真实 CLI（假 sh 脚本回显）。
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
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  VmApprovalCoordinator,
  deriveUnderlying,
  recordBlockedApprovalAudit,
  toExecutedResult,
} from '@winvm/vm-service';
import { TaskStore } from '@winvm/a2a-framework';
import { CliLlmBridge } from '@winvm/adapter-agent-workbuddy-llm';
import {
  APPROVAL_REPLAY_DEFAULT,
  ENV_APPROVAL_REPLAY,
  HashChainAuditSink,
  resolveApprovalReplay,
} from '@winvm/core';
import { buildA2aResumeHint, extractApproval } from '@winvm/host-a2a-bridge';

/* ============================ 通用夹具 ============================ */

const CAP = 'app.winget.uninstall';

/**
 * 等待挂起 Promise 期间保持事件循环存活（TaskStore 的 TTL 计时器是 unref 的，
 * 裸测试里必须自行撑住 loop，否则计时器永不触发）。
 */
function awaitWithKeepAlive(promise, ms = 2_000) {
  const keep = setTimeout(() => {}, ms);
  return promise.finally(() => clearTimeout(keep));
}

function approvalReq(approvalId = 'apr_1', over = {}) {
  return {
    approvalId,
    capabilityId: CAP,
    risk: 'L2',
    summary: '卸载 VM 企业微信',
    preview: {},
    impact: [],
    ...over,
  };
}

function token(approvalId = 'apr_1', over = {}) {
  return {
    approvalId,
    capabilityId: CAP,
    risk: 'L2',
    params: { packageId: 'WXWork' },
    preview: { packageId: 'WXWork' },
    createdAtMs: Date.now(),
    hostApproved: false,
    traceId: 'tr_k5',
    impact: ['packageId=WXWork'],
    underlying: { capabilityId: CAP, goalText: '卸载企业微信' },
    ...over,
  };
}

/**
 * 组装「协调器 + 真实 TaskStore + 令牌表 + 计数 replay」沙箱（不起服务、不碰 ps-bridge）。
 * @param {{ttlMs?:number, replayEnabled?:boolean, replayResult?:object, replayThrows?:boolean, token?:object|null}} opts
 */
function makeSandbox(opts = {}) {
  const calls = [];
  const pendingApprovals = new Map();
  const tok = opts.token === null ? null : (opts.token ?? token());
  if (tok) pendingApprovals.set(tok.approvalId, tok);

  const timeouts = [];
  const tasks = new TaskStore(
    opts.ttlMs === undefined
      ? {}
      : { approvalTtlMs: opts.ttlMs, onApprovalTimeout: (info) => timeouts.push(info) },
  );
  const rec = tasks.create();

  const coordinator = new VmApprovalCoordinator();
  coordinator.bind(tasks, pendingApprovals);
  coordinator.beginTask(rec.task.id);
  coordinator.setReplay(async (p) => {
    calls.push(p);
    if (opts.replayThrows) throw new Error('replay boom');
    return opts.replayResult ?? { ok: true, capabilityId: p.capabilityId, summary: 'winget 已卸载 WXWork' };
  });
  if (opts.replayEnabled === false) coordinator.setReplayEnabled(false);

  return { coordinator, tasks, taskId: rec.task.id, pendingApprovals, calls, timeouts };
}

/* ============================ A. 协调器：执行权收归服务端 ============================ */

describe('K5-A 审批协调器服务端重放', () => {
  test('宿主批准 → 用留存原参数重放，返回 executed 结构化回执，token 一次性消费删除', async () => {
    const sb = makeSandbox();
    const decision = sb.coordinator.raise(approvalReq('apr_1'));
    assert.equal(sb.tasks.tryGet(sb.taskId).task.status.state, 'input-required');
    assert.equal(sb.calls.length, 0, '宿主批准前绝不重放（安全纪律 1）');
    assert.equal(sb.pendingApprovals.get('apr_1').hostApproved, false, '挂起期间仍未批准');

    assert.equal(sb.tasks.resolveApproval(sb.taskId, 'apr_1', true), true);
    const outcome = await decision;

    assert.equal(outcome.approved, true);
    assert.equal(outcome.reason, undefined, '批准态不得带 reason');
    assert.equal(outcome.executed.ok, true, '重放成功应带回 ok:true 回执');
    assert.equal(outcome.executed.capabilityId, CAP);
    assert.match(outcome.executed.summary, /已卸载/);

    // 重放参数 = 服务端留存的原参数（不是 LLM 回显的任何东西）
    assert.equal(sb.calls.length, 1, '批准后恰好重放一次');
    assert.deepEqual(sb.calls[0].params, { packageId: 'WXWork' }, '必须用拦截时留存的原始参数');
    assert.equal(sb.calls[0].approvalId, 'apr_1');

    // token 一次性消费（设计 §4.2）：成功也要删，杜绝同一 approvalId 二次重放
    assert.equal(sb.pendingApprovals.has('apr_1'), false, '重放后 token 必须被删除');
    sb.coordinator.endTask();
  });

  test('重放结果为失败回执 → 照样如实带回 ok:false，且 token 仍一次性删除（不重试、不伪装）', async () => {
    const sb = makeSandbox({
      replayResult: { ok: false, capabilityId: CAP, summary: 'winget 未找到包', error: 'APP_NOT_FOUND' },
    });
    const decision = sb.coordinator.raise(approvalReq('apr_1'));
    sb.tasks.resolveApproval(sb.taskId, 'apr_1', true);
    const outcome = await decision;

    assert.equal(outcome.approved, true, '宿主确已批准（批准事实与执行结果分离）');
    assert.equal(outcome.executed.ok, false, '服务端回执失败绝不改成成功');
    assert.equal(outcome.executed.error, 'APP_NOT_FOUND');
    assert.equal(sb.pendingApprovals.has('apr_1'), false, '失败也要消费 token（避免二次重放）');
    sb.coordinator.endTask();
  });

  test('重放抛异常 → executed.ok:false（原因带上异常），绝不伪装成功、token 仍删除', async () => {
    const sb = makeSandbox({ replayThrows: true });
    const decision = sb.coordinator.raise(approvalReq('apr_1'));
    sb.tasks.resolveApproval(sb.taskId, 'apr_1', true);
    const outcome = await decision;

    assert.equal(outcome.approved, true);
    assert.equal(outcome.executed.ok, false);
    assert.match(outcome.executed.summary, /重放异常/);
    assert.match(outcome.executed.error, /replay boom/);
    assert.equal(sb.pendingApprovals.has('apr_1'), false);
    sb.coordinator.endTask();
  });

  test('宿主拒绝 → approved:false / reason:rejected，绝不重放、token 保留且不置已批准', async () => {
    const sb = makeSandbox();
    const decision = sb.coordinator.raise(approvalReq('apr_1'));
    sb.tasks.resolveApproval(sb.taskId, 'apr_1', false);
    const outcome = await decision;

    assert.equal(outcome.approved, false);
    assert.equal(outcome.reason, 'rejected');
    assert.equal(outcome.executed, undefined, '被拒绝不可能带回执');
    assert.equal(sb.calls.length, 0, '拒绝路径零重放（K3 纪律）');
    assert.equal(sb.pendingApprovals.get('apr_1').hostApproved, false, '拒绝绝不置 hostApproved');
    assert.equal(sb.pendingApprovals.has('apr_1'), true, '拒绝不消费 token（清理权不在此）');
    sb.coordinator.endTask();
  });

  test('TTL 超时 → approved:false / reason:timeout，绝不重放', async () => {
    const sb = makeSandbox({ ttlMs: 60 });
    const outcome = await awaitWithKeepAlive(sb.coordinator.raise(approvalReq('apr_1')));

    assert.equal(outcome.approved, false);
    assert.equal(outcome.reason, 'timeout', '超时必须与"宿主拒绝"可区分');
    assert.equal(outcome.executed, undefined);
    assert.equal(sb.calls.length, 0, '超时绝不重放');
    assert.equal(sb.pendingApprovals.get('apr_1').hostApproved, false);
    sb.coordinator.endTask();
  });

  test('无挂接任务（非 A2A / 任务已结束）→ approved:false / reason:no-active-task，不挂起不重放', async () => {
    const sb = makeSandbox();
    sb.coordinator.endTask(); // 模拟任务已结束
    const outcome = await sb.coordinator.raise(approvalReq('apr_1'));

    assert.equal(outcome.approved, false);
    assert.equal(outcome.reason, 'no-active-task');
    assert.equal(sb.calls.length, 0);
    assert.equal(sb.pendingApprovals.has('apr_1'), true, '未进入审批流程，token 不动');
    assert.equal(sb.tasks.tryGet(sb.taskId).task.status.state, 'submitted', '不应把任务挂起');
  });

  test('批准时 token 已消失（被超时清理/异常）→ 不放行（rejected），绝不凭空重放', async () => {
    const sb = makeSandbox({ token: null });
    const decision = sb.coordinator.raise(approvalReq('apr_1'));
    sb.tasks.resolveApproval(sb.taskId, 'apr_1', true);
    const outcome = await decision;

    assert.equal(outcome.approved, false, '无留存原参数就没有可信的执行对象');
    assert.equal(outcome.reason, 'rejected');
    assert.equal(outcome.executed, undefined);
    assert.equal(sb.calls.length, 0);
    sb.coordinator.endTask();
  });

  test('灰度 off（setReplayEnabled(false)）→ 只回 approved:true（无 executed），token 保留供 /mcp 续跑', async () => {
    const sb = makeSandbox({ replayEnabled: false });
    const decision = sb.coordinator.raise(approvalReq('apr_1'));
    sb.tasks.resolveApproval(sb.taskId, 'apr_1', true);
    const outcome = await decision;

    assert.equal(outcome.approved, true);
    assert.equal(outcome.executed, undefined, 'off 时不重放 → 不得凭空造回执');
    assert.equal(sb.calls.length, 0, 'off 时绝不重放');
    // K4 语义保留：token 仍在且已批准 → /mcp 人工续跑闸（hostApproved===true）可放行
    assert.equal(sb.pendingApprovals.has('apr_1'), true, 'off 时不得消费 token');
    assert.equal(sb.pendingApprovals.get('apr_1').hostApproved, true);
    sb.coordinator.endTask();
  });

  test('未注入 replay（等价服务未接线）→ 退回 approved:true 无回执，token 保留', async () => {
    const tasks = new TaskStore();
    const rec = tasks.create();
    const pendingApprovals = new Map([['apr_ni', token('apr_ni')]]);
    const coordinator = new VmApprovalCoordinator();
    coordinator.bind(tasks, pendingApprovals);
    coordinator.beginTask(rec.task.id);

    const decision = coordinator.raise(approvalReq('apr_ni'));
    tasks.resolveApproval(rec.task.id, 'apr_ni', true);
    const outcome = await decision;

    assert.equal(outcome.approved, true);
    assert.equal(outcome.executed, undefined);
    assert.equal(pendingApprovals.has('apr_ni'), true);
    coordinator.endTask();
  });

  test('raise 用服务端留存的 preview/impact/underlying 补全审批请求（宿主卡片信息量）', async () => {
    const sb = makeSandbox({
      token: token('apr_1', {
        preview: { packageId: 'WXWork', dryRun: false },
        impact: ['packageId=WXWork'],
        underlying: { capabilityId: CAP, goalText: '卸载企业微信', paramsSummary: 'packageId=WXWork' },
      }),
    });
    // 桥侧只能给出 LLM 回显的粗信息（空 preview / 空 impact）→ 服务端留存值补全
    const decision = sb.coordinator.raise(approvalReq('apr_1'));
    const msg = sb.tasks.tryGet(sb.taskId).task.status.message;
    const dataPart = msg.parts.find((p) => p.kind === 'data').data;

    assert.deepEqual(dataPart.preview, { packageId: 'WXWork', dryRun: false }, '空 preview 应用留存值补全');
    assert.deepEqual(dataPart.impact, ['packageId=WXWork']);
    assert.equal(dataPart.underlying.goalText, '卸载企业微信');
    assert.match(
      msg.parts.find((p) => p.kind === 'text').text,
      /真实目标：卸载企业微信/,
      'text part 应写成人话「真实目标」行',
    );

    sb.tasks.resolveApproval(sb.taskId, 'apr_1', true);
    await decision;
    sb.coordinator.endTask();
  });

  test('桥侧已给出 preview/impact 时不被留存值覆盖（显式信息优先）', async () => {
    const sb = makeSandbox();
    const decision = sb.coordinator.raise(
      approvalReq('apr_1', { preview: { from: 'bridge' }, impact: ['bridge-item'] }),
    );
    const dataPart = sb.tasks.tryGet(sb.taskId).task.status.message.parts.find((p) => p.kind === 'data').data;
    assert.deepEqual(dataPart.preview, { from: 'bridge' });
    assert.deepEqual(dataPart.impact, ['bridge-item']);

    sb.tasks.resolveApproval(sb.taskId, 'apr_1', true);
    await decision;
    sb.coordinator.endTask();
  });
});

/* ============================ B. K5 纯逻辑件 ============================ */

describe('K5-B 纯逻辑件（回执映射 / blocked 审计 / 真实意图）', () => {
  test('toExecutedResult：ok 口径 = isError!==true && structuredContent.ok===true', () => {
    const ok = toExecutedResult(CAP, {
      isError: false,
      structuredContent: { ok: true, summary: 'winget uninstall 完成：WXWork' },
    });
    assert.deepEqual(ok, { ok: true, capabilityId: CAP, summary: 'winget uninstall 完成：WXWork' });

    const isErr = toExecutedResult(CAP, { isError: true, structuredContent: { ok: true } });
    assert.equal(isErr.ok, false, 'isError 优先 —— 结构化 ok:true 也救不回来');

    const notOk = toExecutedResult(CAP, {
      isError: false,
      structuredContent: { ok: false, error: { message: '包未找到' } },
    });
    assert.equal(notOk.ok, false);
    assert.equal(notOk.error, '包未找到');

    const noSc = toExecutedResult(CAP, {});
    assert.equal(noSc.ok, false, '无 structuredContent → 绝不默认成功');
    assert.match(noSc.summary, /执行未成功/);
  });

  test('toExecutedResult：无 summary 时从 data 取可读摘要并截断', () => {
    const fromData = toExecutedResult(CAP, {
      structuredContent: { ok: true, data: { message: '已卸载 WXWork' } },
    });
    assert.equal(fromData.summary, `${CAP} 执行成功：已卸载 WXWork`);

    const long = 'X'.repeat(500);
    const truncated = toExecutedResult(CAP, { structuredContent: { ok: true, data: { text: long } } });
    assert.ok(truncated.summary.length < 260, '摘要必须截断，绝不把整块输出灌进回执与提示词');
    assert.match(truncated.summary, /…$/);
  });

  test('recordBlockedApprovalAudit：拦截事实入哈希链（result.ok=false + matchedRule=approval-required）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'k5-audit-'));
    const audit = new HashChainAuditSink({ dir });
    const logs = [];
    const logger = {
      debug: () => {},
      info: () => {},
      warn: (m, f) => logs.push(['warn', m, f]),
      error: () => {},
    };

    const res = await recordBlockedApprovalAudit(
      audit,
      logger,
      {
        traceId: 'tr_block_1',
        approvalId: 'apr_b1',
        capabilityId: CAP,
        risk: 'L2',
        params: { packageId: 'WXWork', password: 'Sup3rSecret' },
        startedAtMs: Date.now() - 5,
      },
      () => 'aud_b1',
    );
    assert.deepEqual(res, { ok: true });

    const file = join(dir, readdirSync(dir).find((f) => f.endsWith('.jsonl')));
    const rec = JSON.parse(readFileSync(file, 'utf8').trim().split('\n')[0]);
    assert.equal(rec.traceId, 'tr_block_1');
    assert.equal(rec.auditId, 'aud_b1');
    assert.equal(rec.capabilityId, CAP);
    assert.equal(rec.policyDecision.allowed, false);
    assert.equal(rec.policyDecision.matchedRule, 'approval-required');
    assert.equal(rec.result.ok, false, '被拦调用绝不能记成成功');
    assert.equal(rec.result.errorCode, 'APPROVAL_REQUIRED');
    assert.match(rec.result.summary, /blocked:approval-required/);
    assert.equal(rec.approval.approvalId, 'apr_b1');
    // 审计侧凭据脱敏（sink 内置 redact）
    assert.equal(rec.params.password, '***REDACTED***', '凭据值不得入链');
    assert.equal(rec.params.packageId, 'WXWork', '非敏感项保留（可回溯真实意图）');

    const v = await audit.verifyChain();
    assert.equal(v.valid, true, 'blocked 条目必须是合法链上条目');
    assert.equal(v.entries, 1);
    assert.equal(logs.length, 0, '成功路径不应有 warn');
  });

  test('recordBlockedApprovalAudit：审计写失败只 warn、不抛（拦截语义优先）', async () => {
    const logs = [];
    const logger = {
      debug: () => {},
      info: () => {},
      warn: (m, f) => logs.push([m, f]),
      error: () => {},
    };
    const audit = { append: () => Promise.reject(new Error('disk gone')) };
    const res = await recordBlockedApprovalAudit(
      audit,
      logger,
      { traceId: 'tr_x', approvalId: 'apr_x', capabilityId: CAP, risk: 'L2', params: {}, startedAtMs: Date.now() },
      () => 'aud_x',
    );
    assert.equal(res.ok, false);
    assert.match(res.error, /disk gone/);
    assert.equal(logs.length, 1, '失败必须留一条 warn 日志');
    assert.match(logs[0][0], /blocked 审计写入失败/);
  });

  test('deriveUnderlying：goal / 内层能力 / 参数摘要（凭据脱敏）/ 截断 / 推不出则 undefined', () => {
    const shell = deriveUnderlying('appops.workflow.run', {
      goal: '卸载企业微信并把日志清理掉',
      capability: CAP,
      packageId: 'WXWork',
      token: 'abc123',
    });
    assert.equal(shell.capabilityId, CAP, '内层真实能力优先于外壳名');
    assert.equal(shell.goalText, '卸载企业微信并把日志清理掉');
    assert.match(shell.paramsSummary, /packageId=WXWork/);
    assert.match(shell.paramsSummary, /token=\*\*\*REDACTED\*\*\*/, '凭据键值必须打码后才进卡片');
    assert.doesNotMatch(shell.paramsSummary, /abc123/, '凭据明文绝不外泄');

    const longGoal = deriveUnderlying('appops.workflow.run', { goal: 'Y'.repeat(900) });
    assert.ok(longGoal.goalText.length <= 301, 'goalText 必须截断（卡片不塞长文）');

    const empty = deriveUnderlying('appops.workflow.run', { nested: { deep: 1 } });
    assert.equal(empty, undefined, '无标量信息 → 不硬造（卡片退回旧信息量）');

    const onlyShell = deriveUnderlying(CAP, { packageId: 'WXWork' });
    assert.equal(onlyShell.capabilityId, CAP, '推不出内层时退回外壳能力');
  });

  test('灰度开关 env 解析：默认 on；off 生效；非法值回退（坏 env 不得打挂服务）', () => {
    assert.equal(ENV_APPROVAL_REPLAY, 'WINVM_APPROVAL_REPLAY');
    assert.equal(APPROVAL_REPLAY_DEFAULT, true);
    assert.equal(resolveApprovalReplay({}), true);
    assert.equal(resolveApprovalReplay({ [ENV_APPROVAL_REPLAY]: 'off' }), false);
    assert.equal(resolveApprovalReplay({ [ENV_APPROVAL_REPLAY]: 'false' }), false);
    assert.equal(resolveApprovalReplay({ [ENV_APPROVAL_REPLAY]: '0' }), false);
    assert.equal(resolveApprovalReplay({ [ENV_APPROVAL_REPLAY]: 'on' }), true);
    assert.equal(resolveApprovalReplay({ [ENV_APPROVAL_REPLAY]: 'kappa' }), true, '非法值回退默认 on');
  });
});

/* ============================ C. 桥接层消费 ApprovalOutcome ============================ */

/** 审批拦截回显（LLM 把 MCP 工具的 APPROVAL_REQUIRED 原样打印到 stdout） */
const BLOCK_TEXT =
  '工具返回 APPROVAL_REQUIRED: {"approvalId":"apr_k5","capabilityId":"app.winget.uninstall","risk":"L2"} 等待宿主审批\n';

/**
 * 造一个假 codebuddy：按调用次序回显 `outputs[i]`（超出则回显最后一份），
 * 并把每次调用的全部 argv 追加到 calls.log（供断言续跑 prompt 内容）。
 */
function makeFakeCli(dir, outputs) {
  outputs.forEach((text, i) => writeFileSync(join(dir, `out${i + 1}.txt`), text, 'utf8'));
  writeFileSync(join(dir, 'out_last.txt'), outputs[outputs.length - 1], 'utf8');
  const callsFile = join(dir, 'calls.log');
  const script = [
    '#!/bin/sh',
    `D="${dir}"`,
    'N=0',
    'if [ -f "$D/count" ]; then N=$(cat "$D/count"); fi',
    'N=$((N+1))',
    'echo "$N" > "$D/count"',
    'for a in "$@"; do printf \'%s\\n\' "$a" >> "$D/calls.log"; done',
    'printf \'%s\\n\' "===CALL_END===" >> "$D/calls.log"',
    'if [ -f "$D/out$N.txt" ]; then cat "$D/out$N.txt"; else cat "$D/out_last.txt"; fi',
    'exit 0',
    '',
  ].join('\n');
  const p = join(dir, 'fake-codebuddy');
  writeFileSync(p, script, 'utf8');
  chmodSync(p, 0o755);
  return {
    cliPath: p,
    readCalls: () => (existsSync(callsFile) ? readFileSync(callsFile, 'utf8') : ''),
    /** 每次调用一段（已过滤空段） */
    callTurns: () => {
      const raw = existsSync(callsFile) ? readFileSync(callsFile, 'utf8') : '';
      return raw.split('===CALL_END===').filter((s) => s.trim() !== '');
    },
  };
}

function makeFakeCoordinator(outcomes) {
  const calls = [];
  let i = 0;
  return {
    calls,
    beginTask() {},
    endTask() {},
    raise(req) {
      calls.push(req);
      const o = outcomes[Math.min(i, outcomes.length - 1)];
      i += 1;
      return Promise.resolve(o);
    },
  };
}

async function runK5({ outcomes, outputs, approvalReplay = true, withCoordinator = true }) {
  const dir = mkdtempSync(join(tmpdir(), 'k5-bridge-'));
  const cli = makeFakeCli(dir, outputs);
  const outDir = join(dir, 'out');
  mkdirSync(outDir, { recursive: true });
  const bridge = new CliLlmBridge({
    cliPath: cli.cliPath,
    outputDir: outDir,
    persistent: false,
    endpoint: 'http://127.0.0.1:18443/mcp',
    approvalReplay,
  });
  const coord = makeFakeCoordinator(outcomes);
  if (withCoordinator) bridge.setApprovalCoordinator(coord);

  const statuses = [];
  const result = await bridge.runGoal(
    {
      goal: '卸载 VM 企业微信',
      capabilities: [CAP],
      outputDir: outDir,
      cliPath: cli.cliPath,
      endpoint: 'http://127.0.0.1:18443/mcp',
      traceId: 'tr_k5',
      timeoutMs: 30_000,
      taskId: 'task_k5',
    },
    { onStatus: (s, m) => statuses.push([s, m ?? '']), onArtifact: () => {} },
  );
  return { result, coord, cli, statuses };
}

const EXECUTED_OK = { ok: true, capabilityId: CAP, summary: '已卸载 WXWork（服务端回执）' };
const EXECUTED_FAIL = { ok: false, capabilityId: CAP, summary: 'winget 未找到包', error: 'APP_NOT_FOUND' };

describe('K5-C 桥接层：真实回执注入续跑 + 回执反查', () => {
  test('approved+executed(ok) → 续跑轮注入真实回执（【系统已执行】），不再要求 LLM 重发', async () => {
    const { result, coord, cli, statuses } = await runK5({
      outcomes: [{ approved: true, executed: EXECUTED_OK }],
      outputs: [BLOCK_TEXT, '已向用户转告：企业微信卸载完成\n'],
    });

    assert.equal(coord.calls.length, 1);
    assert.equal(coord.calls[0].approvalId, 'apr_k5');
    assert.equal(coord.calls[0].capabilityId, CAP);

    const turns = cli.callTurns();
    assert.equal(turns.length, 2, '首轮 + 一次续跑轮');
    const resumeCall = turns[1];
    assert.match(resumeCall, /【系统已执行】/, '续跑轮必须带"系统已执行"语义');
    assert.match(resumeCall, /已卸载 WXWork（服务端回执）/, '必须注入服务端**真实回执文本**');
    assert.match(resumeCall, /严禁再次调用该能力/);
    assert.match(resumeCall, /严禁把上述回执当作需要你重新发起的待办/);
    assert.doesNotMatch(resumeCall, /请立即以参数 __approvalId/, 'K5 默认路径绝不退回"请 LLM 重发"指令');

    assert.equal(result.ok, true, '有 ok:true 回执 + 如实转告 → completed 采信');
    assert.ok(
      statuses.some(([, m]) => String(m).includes('服务端已执行')),
      '进度应如实播报服务端执行事实',
    );
  });

  test('approved+executed(ok:false) → 文本声称完成但无成功回执 → 反查改判 failed（NO_EXECUTION_RECEIPT）', async () => {
    const { result } = await runK5({
      outcomes: [{ approved: true, executed: EXECUTED_FAIL }],
      outputs: [BLOCK_TEXT, '企业微信已卸载，任务完成\n'],
    });

    assert.equal(result.ok, false, '假成功必须被改判（核心不变式）');
    assert.equal(result.error?.code, 'EXECUTION_FAILED');
    assert.equal(result.error?.reason, 'NO_EXECUTION_RECEIPT');
    assert.match(result.summary, /执行回执缺失/);
    assert.match(result.summary, /winget 未找到包/, '改判文案应带上真实失败回执，便于人工定位');
    assert.ok(result.steps.every((s) => s.ok === false), 'steps 不得残留"成功"');
  });

  test('approved+executed(ok:true) → 文本声称完成 → 采信 completed（不误杀真实执行）', async () => {
    const { result } = await runK5({
      outcomes: [{ approved: true, executed: EXECUTED_OK }],
      outputs: [BLOCK_TEXT, '企业微信已卸载，任务完成\n'],
    });
    assert.equal(result.ok, true, '有成功回执时完成声称应被采信');
    assert.equal(result.error, undefined);
  });

  test('同 approvalId 二次进入 → 不二次挂起（raise 只调一次），据已登记回执判定', async () => {
    const { result, coord, cli } = await runK5({
      outcomes: [{ approved: true, executed: EXECUTED_OK }],
      // 续跑轮 LLM 又回显了同一个旧 apr_ token（真机实证的二次挂起）
      outputs: [BLOCK_TEXT, `又看到 ${BLOCK_TEXT}`],
    });
    assert.equal(coord.calls.length, 1, '同一 approvalId 绝不二次 raise');
    assert.equal(cli.callTurns().length, 2, '只应有首轮 + 一次续跑（去重后不再挂第三轮）');
    assert.equal(result.ok, true, '旧 token 回显不得把已完成的任务打回"等待审批"');
    assert.match(result.summary, /服务端执行回执/, '判定依据是服务端回执，不是 LLM 文本');
  });

  test('同 approvalId 二次进入 + 失败回执 → 据回执如实报失败（不因去重而放行）', async () => {
    const { result, coord } = await runK5({
      outcomes: [{ approved: true, executed: EXECUTED_FAIL }],
      outputs: [BLOCK_TEXT, `重试仍失败 ${BLOCK_TEXT}`],
    });
    assert.equal(coord.calls.length, 1);
    assert.equal(result.ok, false);
    assert.match(result.summary, /服务端执行回执/);
    assert.equal(result.error?.reason, 'REPLAY_FAILED');
  });

  test('宿主拒绝 → 桥保持 K3「等待审批」语义（ok:false / APPROVAL_REQUIRED），不注入回执、不反查', async () => {
    const { result, cli } = await runK5({
      outcomes: [{ approved: false, reason: 'rejected' }],
      outputs: [BLOCK_TEXT, '仍在等待宿主审批\n'],
    });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'APPROVAL_REQUIRED');
    assert.equal(result.error?.details?.approvalId, 'apr_k5');
    assert.equal(cli.callTurns().length, 1, '拒绝不得触发续跑轮');
    assert.doesNotMatch(cli.readCalls(), /【系统已执行】/);
  });

  test('无挂接任务（no-active-task）→ 同拒绝处理（保持等待审批，绝不自批）', async () => {
    const { result } = await runK5({
      outcomes: [{ approved: false, reason: 'no-active-task' }],
      outputs: [BLOCK_TEXT, '等待审批中\n'],
    });
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'APPROVAL_REQUIRED');
  });

  test('灰度 REPLAY=off → 退回 K4 提示词行为（请带 __approvalId 重发），且**不做**回执反查', async () => {
    const { result, cli } = await runK5({
      outcomes: [{ approved: true }], // 无 executed（服务端 off 时的回包形状）
      outputs: [BLOCK_TEXT, '已按批准重发，企业微信卸载完成\n'],
      approvalReplay: false,
    });
    const turns = cli.callTurns();
    assert.equal(turns.length, 2, 'off 时仍应有一次 K4 续跑轮');
    assert.match(turns[1], /请立即以参数 __approvalId: apr_k5 重发/, 'off 时逐字退回 K4 续跑指令');
    assert.doesNotMatch(turns[1], /【系统已执行】/);
    // 反查退场：off 时没有"回执"这一客观参照物，硬反查会把 K4 合法续跑误杀成假失败
    assert.equal(result.ok, true, 'REPLAY=off 不得把 K4 路径改判为失败');
  });

  test('服务端回包无 executed（K4 兼容态）→ 桥不置反查标志，完成声称照旧放行', async () => {
    const { result } = await runK5({
      outcomes: [{ approved: true }],
      outputs: [BLOCK_TEXT, '企业微信已卸载，任务完成\n'],
    });
    assert.equal(result.ok, true);
    assert.equal(result.error, undefined);
  });

  test('无 coordinator（纯 MCP 直调场景）→ K3 行为逐字不变（不反查完成声称）', async () => {
    const { result, coord } = await runK5({
      outcomes: [{ approved: true, executed: EXECUTED_OK }],
      outputs: ['企业微信已卸载，任务完成\n'],
      withCoordinator: false,
    });
    assert.equal(coord.calls.length, 0);
    assert.equal(result.ok, true, '未发生审批的任务绝不进入反查（零改动纪律）');
  });

  test('连续两次 runGoal → 回执登记与反查标志按任务清零（不被上一任务"洗白"）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'k5-two-'));
    const cli = makeFakeCli(dir, [
      BLOCK_TEXT,
      '第一次：企业微信已卸载\n',
      `第二次：${BLOCK_TEXT}`,
    ]);
    const outDir = join(dir, 'out');
    mkdirSync(outDir, { recursive: true });
    const bridge = new CliLlmBridge({
      cliPath: cli.cliPath,
      outputDir: outDir,
      persistent: false,
      endpoint: 'http://127.0.0.1:18443/mcp',
      approvalReplay: true,
    });
    const outcomes = [
      { approved: true, executed: EXECUTED_OK },
      { approved: false, reason: 'rejected' },
    ];
    let raiseCount = 0;
    bridge.setApprovalCoordinator({
      beginTask() {},
      endTask() {},
      raise() {
        const o = outcomes[Math.min(raiseCount, outcomes.length - 1)];
        raiseCount += 1;
        return Promise.resolve(o);
      },
    });
    const sink = { onStatus: () => {}, onArtifact: () => {} };
    const goalBase = {
      goal: '卸载 VM 企业微信',
      capabilities: [CAP],
      outputDir: outDir,
      cliPath: cli.cliPath,
      endpoint: 'http://127.0.0.1:18443/mcp',
      timeoutMs: 30_000,
      taskId: 'task_seq',
    };
    const first = await bridge.runGoal({ ...goalBase, traceId: 'tr_1' }, sink);
    assert.equal(first.ok, true, '首轮有成功回执 → 采信');

    const second = await bridge.runGoal({ ...goalBase, traceId: 'tr_2' }, sink);
    assert.equal(raiseCount, 2, '次轮须重新 raise（去重集合不得跨任务残留）');
    assert.equal(second.ok, false, '次轮宿主拒绝 → 等待审批，绝不被首轮的成功回执"洗白"');
    assert.equal(second.error?.code, 'APPROVAL_REQUIRED');
  });
});

/* ============================ D. 宿主侧透传 ============================ */

describe('K5-D 审批请求到宿主卡片的透传', () => {
  /** 用真实 TaskStore 生成一份 input-required 消息（走服务端 approvalMessage 生成路径） */
  function approvalMessage(over = {}) {
    const tasks = new TaskStore();
    const rec = tasks.create();
    tasks.waitApproval(rec.task.id, approvalReq('apr_h1', over));
    return tasks.tryGet(rec.task.id).task.status.message;
  }

  test('TaskStore：有 underlying → data part 带该键、text part 有「真实目标」行', () => {
    const msg = approvalMessage({
      underlying: { capabilityId: CAP, goalText: '卸载企业微信', paramsSummary: 'packageId=WXWork' },
    });
    const data = msg.parts.find((p) => p.kind === 'data').data;
    assert.equal(data.underlying.capabilityId, CAP);
    assert.equal(data.underlying.goalText, '卸载企业微信');
    assert.match(
      msg.parts.find((p) => p.kind === 'text').text,
      /真实目标：卸载企业微信 · 能力 app\.winget\.uninstall/,
    );
  });

  test('TaskStore：无 underlying → 旧文案逐字不变、data part 不写该键（绝不出现 undefined）', () => {
    const msg = approvalMessage();
    const data = msg.parts.find((p) => p.kind === 'data').data;
    assert.equal('underlying' in data, false, '缺席即不写键（保住既有 fixture 深比对与无 undefined 断言）');
    assert.doesNotMatch(msg.parts.find((p) => p.kind === 'text').text, /真实目标/);
    assert.equal(Object.values(data).some((v) => v === undefined), false);
  });

  test('extractApproval 透传 underlying（子字段类型非法则整块省略）', () => {
    const good = extractApproval(
      approvalMessage({ underlying: { capabilityId: CAP, goalText: '卸载企业微信' } }),
    );
    assert.equal(good.underlying.capabilityId, CAP);
    assert.equal(good.underlying.goalText, '卸载企业微信');

    const junk = extractApproval({
      kind: 'message',
      role: 'agent',
      messageId: 'm',
      parts: [
        {
          kind: 'data',
          data: { type: 'approval-request', approvalId: 'apr_j', underlying: { goalText: 42 } },
        },
      ],
    });
    assert.equal(junk.underlying, undefined, '子字段全非法 → 整块省略');
    assert.equal('underlying' in junk, false);
  });

  test('extractApproval：underlying 文本中的凭据被脱敏后才进宿主卡片', () => {
    const a = extractApproval({
      kind: 'message',
      role: 'agent',
      messageId: 'm',
      parts: [
        {
          kind: 'data',
          data: {
            type: 'approval-request',
            approvalId: 'apr_c',
            underlying: { capabilityId: CAP, paramsSummary: 'password=hunter2 packageId=WXWork' },
          },
        },
      ],
    });
    assert.doesNotMatch(a.underlying.paramsSummary, /hunter2/, '凭据明文绝不到宿主');
    assert.match(a.underlying.paramsSummary, /packageId=WXWork/, '非敏感项保留可读性');
  });

  test('buildA2aResumeHint：带 underlying → 追加真实目标行 + "无需 LLM 重发"；不带 → 逐字不变', () => {
    const plain = buildA2aResumeHint('apr_1', 'task_1');
    assert.equal(
      plain,
      '（A2A 续跑）放行：a2a.approval.reply { taskId: "task_1", approvalId: "apr_1", approved: true }',
      'CL-016 逐字断言必须保持',
    );

    const withGoal = buildA2aResumeHint('apr_1', 'task_1', { capabilityId: CAP, goalText: '卸载企业微信' });
    assert.ok(withGoal.startsWith(`${plain}\n`), '前缀逐字保持，只做纯附加');
    assert.match(withGoal, /真实目标：卸载企业微信 · 能力 app\.winget\.uninstall/);
    assert.match(withGoal, /批准后由服务端按原始参数直接执行，无需 LLM 重发/);
    assert.ok(!withGoal.includes('__approvalId'), 'A2A 通道提示绝不混用 MCP 续跑标记');

    const empty = buildA2aResumeHint('apr_2', undefined, { paramsSummary: '' });
    assert.equal(empty, buildA2aResumeHint('apr_2'), '无有效信息不得拼空句（退回旧文案）');
  });
});

/* ============================ E. vm-service 接线形态守卫 ============================ */

/**
 * 为什么用源码形态断言：本沙箱里 `createService` 会 spawn ps-bridge 并触发 V8 原生 fatal
 * （`Check failed: 12 == (*__errno_location())`），起不了服务做行为级集成测试。
 * 故把「接线是否正确」的风险用形态守卫钉死 —— 一旦有人把执行段拆成两份、忘了注入 replay、
 * 或在 server.ts 里复制出第二个 toExecutedResult/deriveUnderlying，这里立刻红。
 * K5 的**行为**语义由 A/B/C/D 四组（协调器 + 纯逻辑件 + 桥 + 宿主）逐条覆盖。
 */
describe('K5-E vm-service 接线形态守卫', () => {
  const src = readFileSync(
    join(import.meta.dirname, '..', '..', 'packages', 'vm-service', 'src', 'server.ts'),
    'utf8',
  );

  test('执行段抽成命名函数，且 handler 与重放共用（杜绝两条路径行为漂移）', () => {
    assert.match(src, /async function executeCapability\(/, '执行段必须是命名函数');
    const shared = src.match(/await executeCapability\(|return executeCapability\(/g) ?? [];
    assert.ok(shared.length >= 2, `执行段应被 handler 与 replay 共用（发现 ${shared.length} 处调用）`);
    assert.match(src, /interface ExecutionSegment/, '执行段上下文应显式建模');
    assert.match(src, /replayed: true/, '重放须带 replayed 标记（审计可区分拦截/重放）');
  });

  test('K5 纯逻辑件全部复用 approval-replay 模块，server.ts 零重复实现', () => {
    assert.match(src, /from '\.\/approval-replay\.js'/, '须从独立模块导入');
    for (const fn of ['toExecutedResult', 'deriveUnderlying', 'recordBlockedApprovalAudit']) {
      assert.equal(
        new RegExp(`function ${fn}\\(`).test(src),
        false,
        `server.ts 不得复制出第二份 ${fn}（单一事实来源）`,
      );
    }
  });

  test('拦截路径：token 留存 traceId/impact/underlying，并 best-effort 写 blocked 审计', () => {
    assert.match(src, /pendingApprovals\.set\(id, \{[\s\S]{0,800}?traceId: ctx\.traceId/, '须留存 traceId');
    assert.match(src, /underlying: deriveUnderlying\(cap\.id, rest\)/, '须留存真实意图');
    assert.match(src, /impact,/, '须留存 impact');
    assert.match(src, /void recordBlockedApprovalAudit\(/, '拦截须入审计且失败不影响拦截结果');
  });

  test('协调器接线：注入 replay + 灰度开关；超时登记用于 reason 细分', () => {
    assert.match(src, /approvalCoordinator\.setReplay\(replay\)/, '必须注入服务端重放实现');
    assert.match(
      src,
      /approvalCoordinator\.setReplayEnabled\(resolveApprovalReplay\(\)\)/,
      '灰度开关必须从 core/constants 统一解析',
    );
    assert.match(src, /approvalCoordinator\.noteTimeout\(approvalId\)/, '超时须登记（区分 timeout/rejected）');
    assert.doesNotMatch(
      src,
      /process\.env\W{0,4}WINVM_APPROVAL_REPLAY/,
      'env 解析须集中在 core/constants，服务侧不得自行读 env',
    );
  });

  test('K4 安全点逐字保持：注册未批准、放行严格等值、批准后才置 true、重放后一次性删除', () => {
    assert.match(src, /hostApproved: false/, 'token 注册时恒为未批准');
    assert.match(src, /hostApproved === true/, '/mcp 续跑闸严格等值（不记名令牌漏洞已堵）');
    assert.match(src, /if \(token\) token\.hostApproved = true;/, '仅宿主批准后置 true');
    assert.match(src, /this\.pendingApprovals\?\.delete\(req\.approvalId\)/, '重放后一次性消费');
  });

  test('重放实现纪律：暴露面复核 + 参数只取留存值 + traceId 派生 -replay', () => {
    assert.match(src, /if \(!exposedIds\.has\(p\.capabilityId\)\)/, '重放须复核暴露面');
    assert.match(src, /executeCapability\(cap, p\.params/, '重放参数只能来自服务端留存值');
    assert.match(src, /\$\{p\.traceId \?\? newTraceId\(\)\}-replay/, '重放 traceId 须可回溯到拦截点');
    // 执行段绝不自作审批：provider 的审批位必须透传上下文值（重放路径由调用方显式传 true）
    assert.match(src, /approved: seg\.approved,/, 'provider 审批位须透传，不得硬编码');
    assert.equal(
      /const res = await provider\.execute\(\{[\s\S]{0,400}?approved: true/.test(src),
      false,
      '执行段不得把 provider 的 approved 写死为 true（绕过审批闸的口子）',
    );
  });

  test('判别联合护栏：未批准一律不放行（拒绝分支先于重放），绝无硬编码成功回执', () => {
    const rejectIdx = src.indexOf("reason: timedOut ? 'timeout' : 'rejected'");
    const replayIdx = src.indexOf('await this.replay(token)');
    assert.ok(rejectIdx > 0 && replayIdx > rejectIdx, '未批准不得重放：拒绝分支必须先于重放返回');
    assert.equal(
      /executed:\s*\{\s*ok:\s*true/.test(src),
      false,
      '绝不允许凭空构造 ok:true 回执（执行事实只能来自执行段结果）',
    );
  });

  test('env 常量：非法值回退默认（坏 env 不打挂服务）——由 core 统一实现', () => {
    assert.equal(resolveApprovalReplay({ [ENV_APPROVAL_REPLAY]: 'no' }), false);
    assert.equal(resolveApprovalReplay({ [ENV_APPROVAL_REPLAY]: 'yes' }), true);
    assert.equal(resolveApprovalReplay({ [ENV_APPROVAL_REPLAY]: '1' }), true);
    assert.equal(resolveApprovalReplay({ [ENV_APPROVAL_REPLAY]: '2' }), true, '非法值回退默认 on');
  });
});

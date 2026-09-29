/**
 * K4 审批协调器 + 桥接层续跑 单元测试
 *
 * ① coordinator 安全闸：raise 后 token hostApproved=false → 能力层不放行；
 *    宿主经 A2A approval.reply 批准（resolveApproval(true)）→ hostApproved=true → 放行。
 * ② bridge 命中审批拦截且 coordinator 存在时调用 raise 并 await：
 *    approved=true 走续跑（最终 ok=true）；approved=false 返回 base（ok=false，绝不自批）。
 *
 * ── K5 适配点（本文件随契约变更同步修改，语义覆盖只增不减）──────────────────
 * 1. `ApprovalCoordinator.raise` 返回类型由 `Promise<boolean>` 升级为
 *    `Promise<ApprovalOutcome>`（判别联合：`{approved:false, reason}` | `{approved:true, executed?}`）。
 *    → 断言从 `assert.equal(x, true/false)` 改为 `assert.equal(x.approved, true/false)`，
 *      并**新增** reason 断言（拒绝 → 'rejected'；无挂接任务 → 'no-active-task'）。
 * 2. 本文件构造的 fake coordinator 返回 `{ approved: true }`（**不带 executed**）——
 *    即「灰度 `WINVM_APPROVAL_REPLAY=off` / 服务端未注入重放」的 K4 兼容态：
 *    桥必须退回 K4 提示词续跑行为（`resumeSuffix`），且**不得**触发 K5 回执反查。
 *    → 原「approved → 续跑成功」用例语义逐字保留（这是 K4 回滚路径的回归保险）。
 * 3. 重放态（`approved + executed`）与回执反查的新语义由 `k5-replay.test.js` 覆盖。
 * ─────────────────────────────────────────────────────────────────────────
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { VmApprovalCoordinator } from '@winvm/vm-service';
import { TaskStore } from '@winvm/a2a-framework';
import { CliLlmBridge } from '@winvm/adapter-agent-workbuddy-llm';

/* ============================ ① coordinator 安全闸 ============================ */

describe('K4 审批协调器安全闸', () => {
  test('raise 后 token 未批准 → 能力层不放行；宿主批准后 → 放行', async () => {
    const tasks = new TaskStore();
    const rec = tasks.create();
    const taskId = rec.task.id;
    const pendingApprovals = new Map();
    pendingApprovals.set('apr_1', {
      approvalId: 'apr_1',
      capabilityId: 'app.winget.uninstall',
      risk: 'L2',
      params: {},
      preview: {},
      createdAtMs: Date.now(),
      hostApproved: false,
    });

    const coordinator = new VmApprovalCoordinator();
    coordinator.bind(tasks, pendingApprovals);
    coordinator.beginTask(taskId);

    // 与 vm-service /mcp 能力层 L287 严格一致的放行判定
    const gate = (id) => pendingApprovals.get(id)?.hostApproved === true;

    // 注册后、挂起前：未批准 → 不放行
    assert.equal(gate('apr_1'), false);

    const decision = coordinator.raise({
      approvalId: 'apr_1',
      capabilityId: 'app.winget.uninstall',
      risk: 'L2',
      summary: '卸载 VM 企业微信',
      preview: {},
      impact: [],
    });

    // raise 已把任务挂起为 input-required
    assert.equal(tasks.tryGet(taskId).task.status.state, 'input-required');
    // 挂起期间 token 仍未批准 → 不放行
    assert.equal(pendingApprovals.get('apr_1').hostApproved, false);
    assert.equal(gate('apr_1'), false);

    // 宿主经 A2A approval.reply 批准
    const handled = tasks.resolveApproval(taskId, 'apr_1', true);
    assert.equal(handled, true);
    const outcome = await decision;
    // K5 适配：raise 返回结构化 ApprovalOutcome（不再是 boolean）
    assert.equal(outcome.approved, true);
    // 未注入 replay（等价灰度 off）→ executed 缺席（K4 兼容态），token 保留供 /mcp 人工续跑
    assert.equal(outcome.executed, undefined, '未注入重放时不得凭空造出执行回执');
    assert.equal(pendingApprovals.has('apr_1'), true, 'K4 兼容态不得消费 token（/mcp 续跑仍需用它）');

    // 批准后 token 置为已批准 → 能力层放行（杜绝不记名令牌漏洞）
    assert.equal(pendingApprovals.get('apr_1').hostApproved, true);
    assert.equal(gate('apr_1'), true);

    coordinator.endTask();
  });

  test('宿主拒绝 → raise 返回 approved:false / reason:rejected，token 仍 hostApproved=false（保持不放行）', async () => {
    const tasks = new TaskStore();
    const rec = tasks.create();
    const taskId = rec.task.id;
    const pendingApprovals = new Map();
    pendingApprovals.set('apr_2', {
      approvalId: 'apr_2',
      capabilityId: 'app.winget.uninstall',
      risk: 'L2',
      params: {},
      preview: {},
      createdAtMs: Date.now(),
      hostApproved: false,
    });
    const coordinator = new VmApprovalCoordinator();
    coordinator.bind(tasks, pendingApprovals);
    coordinator.beginTask(taskId);

    const decision = coordinator.raise({
      approvalId: 'apr_2',
      capabilityId: 'app.winget.uninstall',
      risk: 'L2',
      summary: 'x',
      preview: {},
      impact: [],
    });
    assert.equal(tasks.tryGet(taskId).task.status.state, 'input-required');

    tasks.resolveApproval(taskId, 'apr_2', false);
    const outcome = await decision;
    // K5 适配：拒绝 → approved:false，且 reason 明确为 'rejected'（非 timeout / 非 no-active-task）
    assert.equal(outcome.approved, false);
    assert.equal(outcome.reason, 'rejected');
    assert.equal(outcome.executed, undefined, '被拒绝不可能带回执（绝不重放）');
    assert.equal(pendingApprovals.get('apr_2').hostApproved, false);
    assert.equal(pendingApprovals.has('apr_2'), true, '拒绝不消费 token（宿主可人工经 /mcp 处理）');

    coordinator.endTask();
  });

  test('无 activeTaskId → raise 直接返回 approved:false / reason:no-active-task（不挂起、不误放行）', async () => {
    const tasks = new TaskStore();
    const pendingApprovals = new Map();
    const coordinator = new VmApprovalCoordinator();
    coordinator.bind(tasks, pendingApprovals);
    // 未 beginTask

    const decision = coordinator.raise({
      approvalId: 'apr_x',
      capabilityId: 'app.winget.uninstall',
      risk: 'L2',
      summary: 'x',
      preview: {},
      impact: [],
    });
    const outcome = await decision;
    // K5 适配：无挂接 A2A 任务 → approved:false + reason:'no-active-task'（不放行、不重放）
    assert.equal(outcome.approved, false);
    assert.equal(outcome.reason, 'no-active-task');
    assert.equal(pendingApprovals.size, 0);
  });
});

/* ============================ ② bridge 续跑 ============================ */

/** 造一个「假 codebuddy」：首调输出 APPROVAL_REQUIRED（含 apr_test），续跑（参数含 __approvalId: apr_）输出成功 */
function makeFakeCli(dir) {
  const p = join(dir, 'fake-codebuddy');
  const script = [
    '#!/bin/sh',
    'for a in "$@"; do',
    '  case "$a" in',
    '    *__approvalId:*) echo \'{"ok":true,"text":"已卸载企业微信 WXWork.exe 已移除"}\'; exit 0;;',
    '  esac',
    'done',
    'echo \'工具返回 APPROVAL_REQUIRED: {"approvalId":"apr_test","capabilityId":"app.winget.uninstall","risk":"L2"} 等待宿主审批\'',
    'exit 0',
    '',
  ].join('\n');
  writeFileSync(p, script, 'utf8');
  chmodSync(p, 0o755);
  return p;
}

/**
 * K5 适配：fake coordinator 现在必须返回 `ApprovalOutcome`（判别联合）而非 boolean。
 * - `approved=true` → `{ approved: true }`（**故意不带 executed**）：等价服务端
 *   `WINVM_APPROVAL_REPLAY=off` / 未注入重放的 **K4 兼容态**，用于回归「回滚后行为逐字保持」；
 * - `approved=false` → `{ approved: false, reason: 'rejected' }`。
 */
function makeCoordinator(approved) {
  const calls = [];
  return {
    calls,
    beginTask() {},
    endTask() {},
    raise(req) {
      calls.push(req);
      return Promise.resolve(approved ? { approved: true } : { approved: false, reason: 'rejected' });
    },
  };
}

async function runBridge(approved, withCoordinator = true) {
  const dir = mkdtempSync(join(tmpdir(), 'k4-'));
  const cli = makeFakeCli(dir);
  const outDir = join(dir, 'out');
  const bridge = new CliLlmBridge({
    cliPath: cli,
    outputDir: outDir,
    persistent: false,
    endpoint: 'http://127.0.0.1:18443/mcp',
  });
  const coord = makeCoordinator(approved);
  if (withCoordinator) bridge.setApprovalCoordinator(coord);

  const sink = { onStatus() {}, onArtifact() {} };
  const result = await bridge.runGoal(
    {
      goal: '卸载 VM 企业微信',
      capabilities: ['app.winget.uninstall'],
      outputDir: outDir,
      cliPath: cli,
      endpoint: 'http://127.0.0.1:18443/mcp',
      traceId: 'tr_1',
      timeoutMs: 30_000,
      taskId: 'task_k4',
    },
    sink,
  );
  return { result, coord, dir };
}

describe('K4 桥接层审批续跑', () => {
  test('命中审批拦截且 coordinator 批准 → 调用 raise 并续跑，最终 ok=true', async () => {
    const { result, coord } = await runBridge(true);
    assert.equal(coord.calls.length, 1, '应调用一次 raise');
    assert.equal(coord.calls[0].approvalId, 'apr_test');
    assert.equal(coord.calls[0].capabilityId, 'app.winget.uninstall');
    assert.equal(result.ok, true, '续跑应成功执行');
  });

  test('命中审批拦截且 coordinator 拒绝 → 返回 base（ok=false），绝不自批', async () => {
    const { result, coord } = await runBridge(false);
    assert.equal(coord.calls.length, 1, '应调用一次 raise');
    assert.equal(result.ok, false, '宿主拒绝应保持等待审批');
    assert.equal(result.error?.code, 'APPROVAL_REQUIRED');
  });

  test('无 coordinator → 保持 K3 旧行为（返回等待审批，不续跑）', async () => {
    const { result, coord } = await runBridge(true, false);
    assert.equal(coord.calls.length, 0, '无 coordinator 不应调用 raise');
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'APPROVAL_REQUIRED');
  });
});

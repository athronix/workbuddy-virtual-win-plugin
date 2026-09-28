/**
 * K4 审批协调器 + 桥接层续跑 单元测试
 *
 * ① coordinator 安全闸：raise 后 token hostApproved=false → 能力层不放行；
 *    宿主经 A2A approval.reply 批准（resolveApproval(true)）→ hostApproved=true → 放行。
 * ② bridge 命中审批拦截且 coordinator 存在时调用 raise 并 await：
 *    approved=true 走续跑（最终 ok=true）；approved=false 返回 base（ok=false，绝不自批）。
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
    const approved = await decision;
    assert.equal(approved, true);

    // 批准后 token 置为已批准 → 能力层放行（杜绝不记名令牌漏洞）
    assert.equal(pendingApprovals.get('apr_1').hostApproved, true);
    assert.equal(gate('apr_1'), true);

    coordinator.endTask();
  });

  test('宿主拒绝 → raise 返回 false，token 仍 hostApproved=false（保持不放行）', async () => {
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
    const approved = await decision;
    assert.equal(approved, false);
    assert.equal(pendingApprovals.get('apr_2').hostApproved, false);

    coordinator.endTask();
  });

  test('无 activeTaskId → raise 直接返回 false（不挂起、不误放行）', async () => {
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
    assert.equal(await decision, false);
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

function makeCoordinator(approved) {
  const calls = [];
  return {
    calls,
    beginTask() {},
    endTask() {},
    raise(req) {
      calls.push(req);
      return Promise.resolve(approved);
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

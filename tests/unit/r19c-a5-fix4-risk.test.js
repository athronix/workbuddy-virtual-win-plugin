/**
 * r19c / A5 · Fix-4 —— 「审批风险展示真实化」的新增断言（spec §2.4 / §6.4）
 *
 * 为什么单独立文件：spec §6.2 已逐文件核实 —— 既有断言**无一条**覆盖「桥产物的 step risk」
 * 或「经 raise → waitApproval 的审批卡 risk」。故本文件是**净新增、零冲突**的覆盖补洞，
 * 不改写任何既有用例。
 *
 * 三组断言（均按**修复后**行为写）：
 *   F4a-1  端到端：服务端 token risk='L3' + 桥侧 req risk='L1'（LLM 文本抠出来的低估值）
 *          ⇒ 审批卡（经**真实** TaskStore.waitApproval → approvalMessage）data.risk === 'L3'
 *          且人话文案含「风险 L3」。
 *          落点：vm-service/src/server.ts:182 `enriched.risk = token.risk ?? req.risk`
 *   F4a-2  回归锚点：token 缺席 ⇒ `enriched = req` ⇒ risk 沿用桥侧值（降级语义不变）。
 *   F4b-1  LlmGoalInput.maxRisk='L3' ⇒ 桥产物 steps[0].risk === 'L1'（批10 N-7 订正后口径：
 *          注册表权威值，**不随封顶漂移**——旧 F4b-1 的 ==='L3' 断言随 A5 Fix-4b 形态退役）
 *   F4b-2  maxRisk 缺省 ⇒ steps[0].risk === 'L1'（同上；owner Q4"缺省取 L2"口径已被
 *          arch3 F-5/N-7 判词推翻：封顶≠步骤实际风险，展示面归一取 cap.risk 权威值）
 *
 * 口径来源（批10 N-7 收口改判；受契约保护变更登记见 docs/archive/changes/phase4-b10-notes.md）：
 *   - Q4（A5 原裁定）：缺省 risk 取 'L2'，maxRisk 会透传 ⇒ 缺省⇒'L2'；maxRisk='L3'⇒'L3'。
 *     **批10 订正**：该形态即 F-5 病灶本身（"委派上限"冒充"步骤实际风险"），合成步骤
 *     capabilityId=appops.workflow.run ⇒ risk 恒取注册表权威值 'L1'（WORKFLOW_RUN_RISK）；
 *     被拦内层的真实风险展示面另有审批卡 token.risk 通道（F4a 钉服务端判定值，不受影响）。
 *   - Q8：K3 静默假成功属独立项目 CL-K3R，本轮**不**写断言。
 *   - Q5/Q6：Fix-4c / Fix-4d 本迭代不做 ⇒ 不写断言，也不动 r19c-kn1-a-pure.test.js:134。
 *
 * 运行（只跑本文件，绝不整批）：
 *   node --test tests/unit/r19c-a5-fix4-risk.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { VmApprovalCoordinator } from '@winvm/vm-service';
import { TaskStore } from '@winvm/a2a-framework';
import { CliLlmBridge } from '@winvm/adapter-agent-workbuddy-llm';

const tick = () => new Promise((r) => setImmediate(r));

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */

/** 沙箱 /tmp 只读 ⇒ 临时产物落到 $HOME/wbtmp */
const TMP_BASE = (() => {
  const base = process.env.HOME ? join(process.env.HOME, 'wbtmp') : join(process.cwd(), 'wbtmp');
  try {
    mkdirSync(base, { recursive: true });
  } catch {
    /* 已存在 */
  }
  return base;
})();

/** 桥侧（LLM 文本正则抠出来的）审批请求。risk 故意给低估值 'L1'，用于验证服务端权威值覆盖它。 */
function makeReq(approvalId, extra = {}) {
  return {
    approvalId,
    capabilityId: 'app.winget.uninstall',
    risk: 'L1',
    summary: `需要人工审批：${approvalId}`,
    preview: { target: 'SomeApp' },
    impact: ['将卸载 SomeApp'],
    ...extra,
  };
}

/** 服务端策略引擎判定的待审批条目（PendingApproval.risk 是权威值，vm-service/src/server.ts:70） */
function makeToken(approvalId, risk) {
  return {
    approvalId,
    capabilityId: 'app.winget.uninstall',
    risk,
    params: { id: 'SomeApp' },
    preview: { target: 'SomeApp' },
    createdAtMs: Date.now(),
    hostApproved: false,
  };
}

/**
 * 从 TaskStore 记录（`store.get(id)` 的返回值是 `{ task, pendingApproval }` 形态）
 * 里取出结构化的 approval-request data part 与文本 part。
 */
function approvalPartsOf(rec) {
  const parts = rec?.task?.status?.message?.parts ?? [];
  return {
    data: parts.find((p) => p.kind === 'data' && p.data?.type === 'approval-request')?.data ?? null,
    text: parts.find((p) => p.kind === 'text')?.text ?? '',
  };
}

/* ================================================================== *
 * Fix-4a：审批卡 risk 取服务端权威值
 * ================================================================== */

describe('A5 / Fix-4a 审批卡 risk 以服务端判定为准（vm-service enriched.risk）', () => {
  test('F4a-1 端到端：token risk=L3 + 桥侧 req risk=L1 ⇒ 审批卡 data.risk=L3（经真实 TaskStore）', async () => {
    const store = new TaskStore({ approvalTtlMs: 5_000 });
    const rec = store.create();
    const c = new VmApprovalCoordinator();
    c.bind(store, new Map([['apr_f4a', makeToken('apr_f4a', 'L3')]]));
    c.beginTask(rec.task.id);

    const p = c.raise(makeReq('apr_f4a')); // 桥侧 risk='L1'
    await tick();

    const after = store.get(rec.task.id);
    const { data, text } = approvalPartsOf(after);

    // 收口，避免用例悬挂
    if (after.pendingApproval) after.pendingApproval.resolve(false);
    await p;

    assert.ok(data, '审批卡应有结构化 approval-request data part（否则前置条件不成立，不是 Fix-4a 的判据）');
    assert.equal(
      data.risk,
      'L3',
      `Fix-4a：审批卡 risk 应取服务端判定值 L3，而非桥侧从 LLM 文本抠出的 L1（实测 ${String(data.risk)}）`,
    );
    assert.ok(
      text.includes('风险 L3'),
      `Fix-4a：人话文案应写「风险 L3」（实测片段：${text.slice(0, 120)}）`,
    );
  });

  test('F4a-2 回归锚点：token 缺席 ⇒ enriched=req ⇒ risk 沿用桥侧值（降级语义不得被改坏）', async () => {
    const store = new TaskStore({ approvalTtlMs: 5_000 });
    const rec = store.create();
    const c = new VmApprovalCoordinator();
    c.bind(store, new Map()); // 无 token
    c.beginTask(rec.task.id);

    const p = c.raise(makeReq('apr_f4a_nod', { risk: 'L1' }));
    await tick();

    const after = store.get(rec.task.id);
    const { data } = approvalPartsOf(after);
    if (after.pendingApproval) after.pendingApproval.resolve(false);
    await p;

    assert.ok(data, '无 token 时审批卡同样应挂起（走 req 原样）');
    assert.equal(
      data.risk,
      'L1',
      `Fix-4a 降级：token 缺席时 risk 应沿用桥侧值 L1（实测 ${String(data.risk)}）`,
    );
  });
});

/* ================================================================== *
 * Fix-4b：execution-steps 步骤 risk 如实化
 * ================================================================== */

/** 假 codebuddy：立即回显一段普通文本（不触发任何审批/拦截启发式） */
function makePlainCli(dir) {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'fake-codebuddy');
  writeFileSync(p, ['#!/bin/sh', "echo '已向用户转告：任务完成'", 'exit 0', ''].join('\n'), 'utf8');
  chmodSync(p, 0o755);
  return p;
}

function makeSink() {
  return { statuses: [], onStatus: () => {}, onArtifact: () => {} };
}

/**
 * 跑一次单次路径（persistent:false）的 runGoal —— 对应 bridge.ts:1365 那处步骤 risk。
 * @param {string|undefined} maxRisk 透传给 LlmGoalInput.maxRisk（C-5）；undefined = 缺省
 */
async function runOneshot(maxRisk) {
  const root = mkdtempSync(join(TMP_BASE, 'a5-fix4-'));
  const cliPath = makePlainCli(join(root, 'cli'));
  const outputDir = join(root, 'out');
  const bridge = new CliLlmBridge({
    cliPath,
    outputDir,
    persistent: false,
    endpoint: 'http://127.0.0.1:1/mcp', // 不可达端口：本例全程不联网
  });
  const input = {
    goal: '读取 VM 上 C:\\Windows\\Temp 目录的文件名（最多 10 个），只读取不改任何东西',
    capabilities: ['appops.workflow.run'],
    outputDir,
    cliPath,
    endpoint: 'http://127.0.0.1:1/mcp',
    traceId: 'tr_fix4',
    timeoutMs: 20_000,
    taskId: 't_fix4',
    ...(maxRisk ? { maxRisk } : {}),
  };
  return bridge.runGoal(input, makeSink());
}

describe('A5 / Fix-4b execution-steps 步骤 risk 如实化（批10 N-7 订正：注册表权威值，不随封顶漂移）', () => {
  test('F4b-1 maxRisk=L3 ⇒ 桥产物 steps[0].risk === "L1"（注册表权威值；封顶不再冒充步骤风险）', async () => {
    const res = await runOneshot('L3');
    assert.ok(
      Array.isArray(res.steps) && res.steps.length > 0,
      `前置条件：单次路径应产出 steps（实测 ${JSON.stringify(res.steps ?? null).slice(0, 200)}）`,
    );
    assert.equal(
      res.steps[0].risk,
      'L1',
      `N-7 订正：步骤 risk 恒取 appops.workflow.run 注册表权威值 L1，**不得**被委派封顶 L3 顶替（实测 ${String(res.steps[0].risk)}）`,
    );
  });

  test('F4b-2 maxRisk 缺省 ⇒ steps[0].risk === "L1"（同 F4b-1：两态同值=封顶通路已退役的判别性）', async () => {
    const res = await runOneshot(undefined);
    assert.ok(
      Array.isArray(res.steps) && res.steps.length > 0,
      `前置条件：单次路径应产出 steps（实测 ${JSON.stringify(res.steps ?? null).slice(0, 200)}）`,
    );
    assert.equal(
      res.steps[0].risk,
      'L1',
      `N-7 订正：缺省形态同样 L1（旧 Q4 "缺省 L2" 口径即 F-5 病灶，已废止；实测 ${String(res.steps[0].risk)}）`,
    );
  });
});

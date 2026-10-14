/**
 * 批1（审批闭环 P0-1 专项）CL1：GoalRequest 装配单源化 + maxRisk 来源标记 回归
 *
 * 覆盖审计病灶（2026-10-12-full-audit.md A2-19 / F-1 / F-3）：
 *  ① F-1：流式路径（message/stream，宿主 a2a.delegate 缺省主用通道）装配 GoalRequest
 *     此前缺 allowedCapabilities 与 context 两键 ⇒ 宿主声明在主用通道被静默丢弃。
 *     现两路共用 buildGoal ⇒ 同形性由构造保证，本用例把「流式也带这两键」钉死。
 *  ② F-3：maxRisk 来源标记。metadata.maxRiskSource==='host-default'（宿主工具回退填充）
 *     ⇒ goal.maxRiskDeclared 不写（缺席）；'agent' 或旧客户端缺席 ⇒ 视为声明 maxRiskDeclared:true。
 *     maxRisk **展示值**恒填（回退服务端 defaultMaxRisk）——声明性与展示解耦。
 *  ③ 装配防再漂移守卫：源码断言两处装配只剩 buildGoal 单源（内联 maxRisk 装配字面量清零）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { A2AServer } from '@winvm/a2a-framework';

const SRC = readFileSync(
  fileURLToPath(new URL('../../packages/a2a-framework/src/server.ts', import.meta.url)),
  'utf8',
);

function makeServer(defaultMaxRisk) {
  let capturedGoal;
  const server = new A2AServer({
    agentCard: { name: 't', description: 'd', version: '1', url: 'http://x/a2a', skills: [] },
    handler: {
      async runGoal(goal) {
        capturedGoal = goal;
        return { ok: true, summary: 'done', artifacts: [], steps: [] };
      },
    },
    ...(defaultMaxRisk ? { defaultMaxRisk } : {}),
  });
  return { server, getGoal: () => capturedGoal };
}

function userMessage(text, extra = {}) {
  return {
    kind: 'message',
    role: 'user',
    messageId: 'ms_' + Math.random().toString(36).slice(2, 8),
    parts: [{ kind: 'text', text }],
    ...extra,
  };
}

/* ------------------------------ ① F-1：流式装配同形 ------------------------------ */

test('F-1 流式路径（message/stream）装配 GoalRequest 必须带 allowedCapabilities 与 context', async () => {
  const { server, getGoal } = makeServer();
  const it = server.handleStream({
    message: userMessage('装个 ffmpeg', { metadata: { bizTag: 'ctx-keep-me' } }),
    metadata: {
      traceId: 'tr_f1_stream',
      allowedCapabilities: ['app.winget.*', 'gui.*'],
      maxRisk: 'L2',
    },
  });
  const deadline = Date.now() + 3000;
  for await (const ev of it) {
    if (getGoal()) break;
    if (ev.kind === 'status-update' && ev.final) break;
    if (Date.now() > deadline) break;
  }
  const goal = getGoal();
  assert.ok(goal, 'handleStream 应触发 runGoal');
  // 病灶钉死：这两键在旧流式装配里整块缺失（主用通道静默丢弃宿主声明）
  assert.deepEqual(goal.allowedCapabilities, ['app.winget.*', 'gui.*']);
  assert.ok(goal.context, 'context 应透传（与 send 同形）');
  assert.equal(goal.context.bizTag, 'ctx-keep-me');
  assert.equal(goal.maxRisk, 'L2');
});

test('F-1 message/send 与 message/stream 同构输入 ⇒ goal 字段集一致（buildGoal 单源保证）', async () => {
  const meta = {
    traceId: 'tr_same',
    allowedCapabilities: ['system.*'],
    maxRisk: 'L3',
    timeoutMs: 12345,
  };
  const a = makeServer();
  await a.server.handleRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'message/send',
    params: {
      message: userMessage('same input', { metadata: { k: 'v' } }),
      metadata: meta,
      configuration: { blocking: true },
    },
  });
  assert.ok(a.getGoal(), 'send 路径应触发 runGoal');

  const b = makeServer();
  const it = b.server.handleStream({
    message: userMessage('same input', { metadata: { k: 'v' } }),
    metadata: meta,
  });
  const deadline = Date.now() + 3000;
  for await (const ev of it) {
    if (b.getGoal()) break;
    if (ev.kind === 'status-update' && ev.final) break;
    if (Date.now() > deadline) break;
  }
  assert.ok(b.getGoal(), 'stream 路径应触发 runGoal');

  // 逐字段同形（除 taskId —— 每次 create 各自的新任务 id）
  const { taskId: _ta, ...ga } = a.getGoal();
  const { taskId: _tb, ...gb } = b.getGoal();
  assert.deepEqual(gb, ga, '两路装配必须逐字段一致（buildGoal 单源）');
});

/* ------------------------------ ② F-3：来源标记 ------------------------------ */

async function goalFromStream(metadata, defaultMaxRisk) {
  const { server, getGoal } = makeServer(defaultMaxRisk);
  const it = server.handleStream({ message: userMessage('x'), metadata });
  const deadline = Date.now() + 3000;
  for await (const ev of it) {
    if (getGoal()) break;
    if (ev.kind === 'status-update' && ev.final) break;
    if (Date.now() > deadline) break;
  }
  const goal = getGoal();
  assert.ok(goal, '应触发 runGoal');
  return goal;
}

test('F-3 宿主回退填充（maxRiskSource=host-default）⇒ maxRiskDeclared 缺席，展示值仍填', async () => {
  const goal = await goalFromStream({ traceId: 't1', maxRisk: 'L1', maxRiskSource: 'host-default' });
  assert.equal(goal.maxRisk, 'L1', '展示值恒填');
  assert.equal(goal.maxRiskDeclared, undefined, '回退填充不得标为声明');
});

test('F-3 Agent 显式声明（maxRiskSource=agent）⇒ maxRiskDeclared=true', async () => {
  const goal = await goalFromStream({ traceId: 't2', maxRisk: 'L2', maxRiskSource: 'agent' });
  assert.equal(goal.maxRisk, 'L2');
  assert.equal(goal.maxRiskDeclared, true);
});

test('F-3 旧客户端/旧版宿主桥（无 source 键，恒发回退值）⇒ 非声明（断崖防线）', async () => {
  // 旧版宿主桥对 Agent 未声明的调用也恒发 defaultMaxRisk='L1'。若"缺席视为声明"，
  // 接线瞬间全部旧桥委派封顶 L1=当场拒绝一切 L2/L3（以修复名义引入新 P0）。
  // 新口径：maxRisk 在场但无 maxRiskSource='agent' ⇒ 一律非声明。
  const goal = await goalFromStream({ traceId: 't3', maxRisk: 'L2' });
  assert.equal(goal.maxRisk, 'L2', '展示值不变');
  assert.equal(goal.maxRiskDeclared, undefined);
});

test('F-3 metadata 完全不带 maxRisk ⇒ 展示值=服务端 defaultMaxRisk 且 maxRiskDeclared 缺席', async () => {
  const goal = await goalFromStream({ traceId: 't4' }, 'L1');
  assert.equal(goal.maxRisk, 'L1', '回退服务端默认');
  assert.equal(goal.maxRiskDeclared, undefined, '服务端默认绝不是宿主声明');
});

/* ------------------------------ ③ 防再漂移源码守卫 ------------------------------ */

test('装配单源守卫：两路各只剩一处 buildGoal 调用，内联 maxRisk 装配字面量清零', () => {
  const callSites = SRC.match(/=\s*buildGoal\(/g) ?? [];
  assert.equal(callSites.length, 2, 'sendMessage 与 handleStream 各一处 buildGoal 调用');
  // 内联旧装配的字面量特征（`maxRisk: (typeof metadata[...]`）全文件**至多一处**
  // （即 buildGoal 自身内部那份）；两处=调用点上还有内联装配 ⇒ 漂移未除净。
  const inlineAsm = SRC.match(/maxRisk:\s*\(typeof metadata/g) ?? [];
  assert.equal(inlineAsm.length, 1, 'maxRisk 装配字面量只允许存在于 buildGoal 一处（防再漂移）');
  assert.match(SRC, /host-default/, '来源判据须引用 host-default 语义');
});

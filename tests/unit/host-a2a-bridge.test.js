/**
 * 宿主侧 A2A 委派桥（@winvm/host-a2a-bridge）单元测试
 *
 * 不碰网络/隧道：注入 mock A2A client，验证
 * 工具面、委派流程、进度与产物收集、审批提取、错误路径。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createA2aBridgeTools, extractApproval, extractText } from '@winvm/host-a2a-bridge';

function statusUpdate(state, text, extra = {}) {
  return {
    kind: 'status-update',
    taskId: 'task_1',
    contextId: 'ctx_1',
    status: {
      state,
      ...(text !== undefined
        ? { message: { kind: 'message', role: 'agent', messageId: 'm1', parts: [{ kind: 'text', text }] } }
        : {}),
    },
    final: false,
    ...extra,
  };
}

function artifactUpdate(name = 'shot.png') {
  return {
    kind: 'artifact-update',
    taskId: 'task_1',
    contextId: 'ctx_1',
    artifact: {
      artifactId: 'a1',
      name,
      parts: [{ kind: 'file', file: { name, mimeType: 'image/png', bytes: 'YWJj' } }],
    },
  };
}

function approvalUpdate() {
  return {
    kind: 'status-update',
    taskId: 'task_1',
    contextId: 'ctx_1',
    status: {
      state: 'input-required',
      message: {
        kind: 'message',
        role: 'agent',
        messageId: 'm2',
        parts: [
          {
            kind: 'data',
            data: {
              approvalId: 'apr_8f3c',
              risk: 'L2',
              capabilityId: 'appops.gui.produce',
              message: '导出图片为 L2 操作，需确认',
            },
          },
        ],
      },
    },
    final: true,
  };
}

/** mock A2A client：events 为流式事件序列 */
function mockClient(events = [], overrides = {}) {
  return {
    async *streamMessage() {
      for (const e of events) yield e;
    },
    async getTask(id) {
      return {
        kind: 'task',
        id,
        contextId: 'ctx_1',
        status: { state: 'completed', message: { kind: 'message', role: 'agent', messageId: 'm', parts: [{ kind: 'text', text: 'done' }] } },
        artifacts: [{ artifactId: 'a9', name: 'out.png', parts: [] }],
      };
    },
    async replyApproval(id, _aid, approved) {
      return { kind: 'task', id, contextId: 'ctx_1', status: { state: approved ? 'working' : 'rejected' }, artifacts: [] };
    },
    async cancelTask(id) {
      return { kind: 'task', id, contextId: 'ctx_1', status: { state: 'canceled' } };
    },
    async getAgentCard() {
      return {
        name: 'WinVM Bridge Agent',
        version: '0.1.0',
        url: 'http://127.0.0.1:18443/a2a',
        protocolVersion: '1.0',
        skills: [{ id: 'app-operation', name: '应用生产操作', description: 'd' }],
      };
    },
    async close() {},
    ...overrides,
  };
}

function toolsFor(client) {
  return createA2aBridgeTools({ clientProvider: { get: async () => client } });
}

function findTool(tools, name) {
  const t = tools.find((x) => x.name === name);
  assert.ok(t, `应暴露工具 ${name}`);
  return t;
}

const CTX = { traceId: 'tr_test' };

describe('host-a2a-bridge 工具面', () => {
  test('暴露 5 个委派工具', () => {
    const tools = toolsFor(mockClient());
    const names = tools.map((t) => t.name);
    for (const n of ['a2a.delegate', 'a2a.task.get', 'a2a.approval.reply', 'a2a.task.cancel', 'a2a.health']) {
      assert.ok(names.includes(n), `缺少工具 ${n}`);
    }
  });

  test('extractText 从消息提取文本', () => {
    const msg = { kind: 'message', role: 'agent', messageId: 'm', parts: [{ kind: 'text', text: '步骤一' }, { kind: 'text', text: '步骤二' }] };
    assert.equal(extractText(msg), '步骤一\n步骤二');
    assert.equal(extractText(undefined), '');
  });

  test('extractApproval 从 data part 提取审批请求', () => {
    const a = extractApproval(approvalUpdate().status.message);
    assert.ok(a);
    assert.equal(a.approvalId, 'apr_8f3c');
    assert.equal(a.risk, 'L2');
    assert.equal(a.capabilityId, 'appops.gui.produce');
  });
});

describe('a2a.delegate', () => {
  test('成功：收集进度与产物，返回 taskId', async () => {
    const client = mockClient([
      statusUpdate('working', '打开 Photoshop'),
      artifactUpdate('step1.png'),
      statusUpdate('working', '换背景'),
      statusUpdate('completed', '已完成导出', { final: true }),
    ]);
    const res = await findTool(toolsFor(client), 'a2a.delegate').handler(
      { goal: '用 PS 把大山换成海洋' },
      CTX,
    );
    assert.equal(res.isError, false);
    const sc = res.structuredContent;
    assert.equal(sc.ok, true);
    assert.equal(sc.taskId, 'task_1');
    assert.equal(sc.state, 'completed');
    assert.equal(sc.progress.length, 3, '应收集 3 条进度');
    assert.equal(sc.artifacts.length, 1);
    assert.equal(sc.artifacts[0].name, 'step1.png');
    assert.equal(sc.traceId, 'tr_test');
  });

  test('图片产物作为 image content 回传宿主', async () => {
    const client = mockClient([artifactUpdate('shot.png'), statusUpdate('completed', 'ok', { final: true })]);
    const res = await findTool(toolsFor(client), 'a2a.delegate').handler({ goal: '截图' }, CTX);
    const img = res.content.find((c) => c.type === 'image');
    assert.ok(img, '应回传图片内容');
    assert.equal(img.mimeType, 'image/png');
  });

  test('挂起审批：返回 input-required 与 approvalId', async () => {
    const client = mockClient([statusUpdate('working', '准备导出'), approvalUpdate()]);
    const res = await findTool(toolsFor(client), 'a2a.delegate').handler({ goal: '导出图片' }, CTX);
    const sc = res.structuredContent;
    assert.equal(sc.state, 'input-required');
    assert.ok(sc.approval, '应返回审批请求');
    assert.equal(sc.approval.approvalId, 'apr_8f3c');
    assert.equal(res.isError, false, '挂起审批不是错误');
  });

  test('缺 goal → INVALID_PARAMS', async () => {
    const res = await findTool(toolsFor(mockClient()), 'a2a.delegate').handler({}, CTX);
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent.error.code, 'INVALID_PARAMS');
  });

  test('隧道不可达 → TUNNEL_UNAVAILABLE', async () => {
    const tools = createA2aBridgeTools({
      clientProvider: {
        get: async () => {
          throw new Error('ssh: connect to host 192.0.2.1 port 22: Connection refused');
        },
      },
    });
    const res = await findTool(tools, 'a2a.delegate').handler({ goal: 'x' }, CTX);
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent.error.code, 'TUNNEL_UNAVAILABLE');
  });

  test('最小权限参数透传（allowedCapabilities / maxRisk）', async () => {
    let captured;
    const client = mockClient([statusUpdate('completed', 'ok', { final: true })], {
      async *streamMessage(_text, opts) {
        captured = opts;
        yield statusUpdate('completed', 'ok', { final: true });
      },
    });
    await findTool(toolsFor(client), 'a2a.delegate').handler(
      { goal: 'x', allowedCapabilities: ['appops.*'], maxRisk: 'L2' },
      CTX,
    );
    assert.deepEqual(captured.allowedCapabilities, ['appops.*']);
    assert.equal(captured.maxRisk, 'L2');
    assert.equal(captured.traceId, 'tr_test');
  });
});

describe('其它委派工具', () => {
  test('a2a.task.get 返回状态与产物', async () => {
    const res = await findTool(toolsFor(mockClient()), 'a2a.task.get').handler({ taskId: 'task_1' }, CTX);
    assert.equal(res.isError, false);
    assert.equal(res.structuredContent.state, 'completed');
    assert.equal(res.structuredContent.artifacts.length, 1);
  });

  test('a2a.task.get 缺 taskId → INVALID_PARAMS', async () => {
    const res = await findTool(toolsFor(mockClient()), 'a2a.task.get').handler({}, CTX);
    assert.equal(res.structuredContent.error.code, 'INVALID_PARAMS');
  });

  test('a2a.approval.reply 批准 → working；拒绝 → rejected', async () => {
    const tools = toolsFor(mockClient());
    const ok = await findTool(tools, 'a2a.approval.reply').handler(
      { taskId: 'task_1', approvalId: 'apr_1', approved: true },
      CTX,
    );
    assert.equal(ok.structuredContent.state, 'working');
    const no = await findTool(tools, 'a2a.approval.reply').handler(
      { taskId: 'task_1', approvalId: 'apr_1', approved: false },
      CTX,
    );
    assert.equal(no.structuredContent.state, 'rejected');
  });

  test('a2a.task.cancel 返回 canceled', async () => {
    const res = await findTool(toolsFor(mockClient()), 'a2a.task.cancel').handler({ taskId: 'task_1' }, CTX);
    assert.equal(res.structuredContent.state, 'canceled');
  });

  test('a2a.health 返回 Agent Card 技能清单', async () => {
    const res = await findTool(toolsFor(mockClient()), 'a2a.health').handler({}, CTX);
    assert.equal(res.isError, false);
    assert.equal(res.structuredContent.name, 'WinVM Bridge Agent');
    assert.equal(res.structuredContent.skills[0].id, 'app-operation');
  });
});

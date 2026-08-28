/**
 * 协议层单元测试：A2A v1.0 与 MCP
 *
 * A2A 重点验证：
 *   - v1.0 方法名正确，旧名（tasks/send）必须 MethodNotFound（不静默兼容）
 *   - Task 生命周期 submitted → working → input-required → completed
 *   - 审批闸映射到 input-required，宿主续跑后任务恢复
 *   - 终态不可再流转
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { A2A, makeError } from '@winvm/contracts';
import { A2AServer, TaskStore } from '@winvm/a2a-framework';
import { McpServer, MCP_PROTOCOL_VERSION } from '@winvm/mcp-framework';

/* ================================ A2A ================================ */

function makeHandler(opts = {}) {
  return {
    async runGoal(goal, sink) {
      sink.onStatus('working', '开始执行');
      if (opts.requireApproval) {
        const approved = await sink.onApprovalRequired({
          approvalId: opts.approvalId ?? 'apr_test_1',
          capabilityId: 'storage.file.delete',
          risk: 'L2',
          summary: `将删除 ${goal.goal}`,
          preview: { items: 12 },
          impact: ['C:\\Users\\alice\\old'],
        });
        if (!approved) {
          return { ok: false, summary: '审批被拒绝', artifacts: [], steps: [] };
        }
      }
      // 可选延时：让「取消任务」等竞态用例具备确定性
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));

      sink.onArtifact({
        kind: 'change-list',
        name: 'change-list',
        mime: 'application/json',
        encoding: 'json',
        data: { changed: ['a', 'b'] },
      });
      return {
        ok: true,
        summary: '任务完成',
        artifacts: [],
        steps: [
          {
            index: 0,
            capabilityId: 'system.info.get',
            params: {},
            ok: true,
            risk: 'L0',
            durationMs: 5,
            traceId: goal.traceId,
            summary: '读取系统信息',
          },
        ],
      };
    },
  };
}

function makeServer(opts = {}) {
  return new A2AServer({
    agentCard: {
      name: 'Test Agent',
      description: 'd',
      version: '1.0.0',
      url: 'http://127.0.0.1:18443/a2a',
      skills: [{ id: 'system-admin', name: '系统管理', description: 'd', tags: ['system'] }],
    },
    handler: makeHandler(opts),
    defaultMaxRisk: 'L2',
  });
}

function sendMessage(text, extra = {}) {
  return {
    jsonrpc: '2.0',
    id: '1',
    method: 'message/send',
    params: {
      message: { kind: 'message', role: 'user', messageId: 'm1', parts: [{ kind: 'text', text }] },
      metadata: { traceId: 'tr_test' },
      ...extra,
    },
  };
}

async function waitForState(server, taskId, target, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await server.handleRequest({
      jsonrpc: '2.0', id: 'g', method: 'tasks/get', params: { name: `tasks/${taskId}` },
    });
    const task = res.result;
    if (task.status.state === target) return task;
    if (Date.now() > deadline) throw new Error(`等待 ${target} 超时，当前 ${task.status.state}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('A2A · 方法名与版本严格性', () => {
  test('未知方法返回 MethodNotFound', async () => {
    const server = makeServer();
    const res = await server.handleRequest({ jsonrpc: '2.0', id: 1, method: 'bogus/method', params: {} });
    assert.equal(res.error.code, A2A.JSON_RPC_ERRORS.METHOD_NOT_FOUND);
  });

  test('废弃旧名 tasks/send 必须 MethodNotFound（不静默兼容）', async () => {
    const server = makeServer();
    const res = await server.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tasks/send', params: {} });
    assert.equal(res.error.code, A2A.JSON_RPC_ERRORS.METHOD_NOT_FOUND);
    assert.match(res.error.message, /message\/send/);
  });

  test('message/send 是 v1.0 合法方法', async () => {
    const server = makeServer();
    const res = await server.handleRequest(sendMessage('查询系统信息'));
    assert.ok(res.result, JSON.stringify(res));
    assert.equal(res.result.kind, 'task');
  });

  test('Agent Card 符合 v1.0 结构（supportedInterfaces）', async () => {
    const server = makeServer();
    const card = server.getAgentCard();
    assert.equal(card.protocolVersion, '1.0');
    assert.ok(Array.isArray(card.supportedInterfaces));
    assert.equal(card.supportedInterfaces[0].protocolBinding, 'JSONRPC');
    assert.equal(card.skills.length, 1);
  });
});

describe('A2A · 任务生命周期', () => {
  test('message/send → 任务创建并推进到 completed', async () => {
    const server = makeServer();
    const res = await server.handleRequest(sendMessage('查询系统信息', { configuration: { blocking: true } }));
    const task = res.result;
    assert.equal(task.status.state, 'completed');
    assert.ok(task.artifacts.length >= 1, '必须产出 artifact（破除黑盒）');
    assert.match(JSON.stringify(task.artifacts), /execution-steps|change-list/);
  });

  test('非阻塞模式立即返回 Task，后台异步推进', async () => {
    const server = makeServer();
    const res = await server.handleRequest(sendMessage('查询系统信息'));
    const taskId = res.result.id;
    assert.equal(res.result.kind, 'task');
    const done = await waitForState(server, taskId, 'completed');
    assert.equal(done.status.state, 'completed');
  });

  test('tasks/get 可按 historyLength 裁剪历史', async () => {
    const server = makeServer();
    const created = await server.handleRequest(sendMessage('x', { configuration: { blocking: true } }));
    const res = await server.handleRequest({
      jsonrpc: '2.0', id: 1, method: 'tasks/get',
      params: { name: `tasks/${created.result.id}`, historyLength: 1 },
    });
    assert.ok((res.result.history ?? []).length <= 1);
  });

  test('任务不存在 → TaskNotFoundError', async () => {
    const server = makeServer();
    const res = await server.handleRequest({
      jsonrpc: '2.0', id: 1, method: 'tasks/get', params: { name: 'tasks/does-not-exist' },
    });
    assert.equal(res.error.code, A2A.JSON_RPC_ERRORS.INVALID_PARAMS);
    assert.equal(res.error.data.code, A2A.A2A_ERROR_CODES.TASK_NOT_FOUND);
  });

  test('取消进行中的任务 → canceled', async () => {
    // 用耗时 handler 保证任务在取消时仍处于 working（否则会先跑到 completed）
    const server = makeServer({ delayMs: 300 });
    const created = await server.handleRequest(sendMessage('长任务'));
    const res = await server.handleRequest({
      jsonrpc: '2.0', id: 1, method: 'tasks/cancel', params: { name: `tasks/${created.result.id}` },
    });
    assert.ok(res.result, JSON.stringify(res));
    assert.equal(res.result.status.state, 'canceled');
  });

  test('终态任务不可再取消 → TaskNotCancelableError', async () => {
    const server = makeServer();
    const created = await server.handleRequest(sendMessage('x', { configuration: { blocking: true } }));
    assert.equal(created.result.status.state, 'completed');
    const res = await server.handleRequest({
      jsonrpc: '2.0', id: 1, method: 'tasks/cancel', params: { name: `tasks/${created.result.id}` },
    });
    assert.equal(res.error.data.code, A2A.A2A_ERROR_CODES.TASK_NOT_CANCELABLE);
  });

  test('tasks/list 支持分页游标', async () => {
    const server = makeServer();
    for (let i = 0; i < 3; i++) {
      await server.handleRequest(sendMessage(`任务${i}`, { configuration: { blocking: true } }));
    }
    const res = await server.handleRequest({
      jsonrpc: '2.0', id: 1, method: 'tasks/list', params: { pageSize: 2 },
    });
    assert.equal(res.result.tasks.length, 2);
    assert.equal(res.result.totalSize, 3);
    assert.equal(res.result.nextPageToken, '2');
  });
});

describe('A2A · 审批闸（input-required）', () => {
  test('需审批时任务置 input-required 并挂起', async () => {
    const server = makeServer({ requireApproval: true, approvalId: 'apr_1' });
    const created = await server.handleRequest(sendMessage('删除旧目录'));
    const taskId = created.result.id;

    const pending = await waitForState(server, taskId, 'input-required');
    assert.equal(pending.status.state, 'input-required');
    // 状态消息必须携带结构化的审批请求（供宿主渲染确认卡片）
    const dataPart = pending.status.message.parts.find((p) => p.kind === 'data');
    assert.equal(dataPart.data.type, 'approval-request');
    assert.equal(dataPart.data.approvalId, 'apr_1');
  });

  test('宿主批准后任务恢复并最终 completed', async () => {
    const server = makeServer({ requireApproval: true, approvalId: 'apr_2' });
    const created = await server.handleRequest(sendMessage('删除旧目录'));
    const taskId = created.result.id;
    await waitForState(server, taskId, 'input-required');

    const reply = await server.handleRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'message/send',
      params: {
        message: {
          kind: 'message',
          role: 'user',
          messageId: 'm2',
          taskId,
          parts: [{ kind: 'data', data: { approvalId: 'apr_2', approved: true } }],
        },
      },
    });
    assert.ok(!reply.error, JSON.stringify(reply));

    const done = await waitForState(server, taskId, 'completed');
    assert.equal(done.status.state, 'completed');
  });

  test('宿主拒绝后任务置 rejected', async () => {
    const server = makeServer({ requireApproval: true, approvalId: 'apr_3' });
    const created = await server.handleRequest(sendMessage('删除旧目录'));
    const taskId = created.result.id;
    await waitForState(server, taskId, 'input-required');

    await server.handleRequest({
      jsonrpc: '2.0', id: 2, method: 'message/send',
      params: {
        message: {
          kind: 'message', role: 'user', messageId: 'm3', taskId,
          parts: [{ kind: 'data', data: { approvalId: 'apr_3', approved: false } }],
        },
      },
    });
    const rejected = await waitForState(server, taskId, 'rejected');
    assert.equal(rejected.status.state, 'rejected');
  });

  test('审批 ID 不匹配 → InvalidParams（不可冒用）', async () => {
    const server = makeServer({ requireApproval: true, approvalId: 'apr_4' });
    const created = await server.handleRequest(sendMessage('删除旧目录'));
    const taskId = created.result.id;
    await waitForState(server, taskId, 'input-required');

    const res = await server.handleRequest({
      jsonrpc: '2.0', id: 2, method: 'message/send',
      params: {
        message: {
          kind: 'message', role: 'user', messageId: 'm4', taskId,
          parts: [{ kind: 'data', data: { approvalId: 'WRONG_ID', approved: true } }],
        },
      },
    });
    assert.equal(res.error.code, A2A.JSON_RPC_ERRORS.INVALID_PARAMS);
  });
});

describe('A2A · 流式（SSE）', () => {
  test('message/stream 产出事件流且以终态结束', async () => {
    const server = makeServer();
    const events = [];
    for await (const ev of server.handleStream({
      message: { kind: 'message', role: 'user', messageId: 'm', parts: [{ kind: 'text', text: 'x' }] },
      metadata: { traceId: 'tr_stream' },
    })) {
      events.push(ev);
    }
    assert.ok(events.length >= 2, `事件数=${events.length}`);
    const last = events[events.length - 1];
    assert.equal(last.kind, 'status-update');
    assert.equal(last.final, true);
    assert.equal(last.status.state, 'completed');
  });
});

/* ================================ MCP ================================ */

describe('MCP · 协议层', () => {
  function makeMcp() {
    return new McpServer({
      name: 'test',
      version: '0.1.0',
      tools: [
        {
          name: 'system.info.get',
          description: '获取系统信息',
          inputSchema: { type: 'object', properties: {} },
          annotations: { readOnlyHint: true, destructiveHint: false },
          handler: async () => ({ structuredContent: { os: 'Windows 11', ok: true } }),
        },
        {
          name: 'storage.file.delete',
          description: '删除',
          inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
          annotations: { readOnlyHint: false, destructiveHint: true },
          handler: async (params) => {
            if (params.path === 'bad') {
              return { isError: true, structuredContent: { ok: false, error: { code: 'POLICY_DENIED' } } };
            }
            return { structuredContent: { ok: true, deleted: params.path } };
          },
        },
      ],
    });
  }

  test('initialize 返回协议版本与 serverInfo', async () => {
    const res = await makeMcp().handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    assert.equal(res.result.protocolVersion, MCP_PROTOCOL_VERSION);
    assert.equal(res.result.serverInfo.name, 'test');
  });

  test('tools/list 返回工具与 annotations', async () => {
    const res = await makeMcp().handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    assert.equal(res.result.tools.length, 2);
    const t = res.result.tools.find((x) => x.name === 'storage.file.delete');
    assert.equal(t.annotations.destructiveHint, true);
  });

  test('tools/call 返回结构化结果', async () => {
    const res = await makeMcp().handleRequest({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'system.info.get', arguments: {} },
    });
    assert.equal(res.result.isError, false);
    assert.equal(res.result.structuredContent.os, 'Windows 11');
  });

  test('tools/call 传参并回传结果', async () => {
    const res = await makeMcp().handleRequest({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'storage.file.delete', arguments: { path: 'C:\\Users\\a' } },
    });
    assert.equal(res.result.structuredContent.deleted, 'C:\\Users\\a');
  });

  test('工具内部返回 isError 时正确透出', async () => {
    const res = await makeMcp().handleRequest({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'storage.file.delete', arguments: { path: 'bad' } },
    });
    assert.equal(res.result.isError, true);
  });

  test('未知工具 → InvalidParams', async () => {
    const res = await makeMcp().handleRequest({
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nope.nope.nope', arguments: {} },
    });
    assert.equal(res.error.code, -32602);
  });

  test('通知类消息返回 null（无响应）', async () => {
    const res = await makeMcp().handleRequest({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(res, null);
  });
});

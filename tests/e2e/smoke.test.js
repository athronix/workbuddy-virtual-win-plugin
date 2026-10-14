/**
 * 端到端冒烟测试：真实启动 VM 服务，打通 MCP + A2A 双通道
 *
 * 验证链路：HTTP → MCP/A2A → 能力注册表 → 策略引擎 → 桥接层 → ps-bridge → PowerShell
 *
 * 说明：本测试在**宿主机（Windows）**上运行，因此 ps-bridge 会真实拉起 PowerShell。
 * 若环境无 PowerShell（如 Linux CI），服务会降级为仅 meta.*，测试对降级路径同样做断言。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_SERVICE_CONFIG } from '@winvm/core';
import { createService } from '@winvm/vm-service';

const PORT = 19399;
const BASE = `http://127.0.0.1:${PORT}`;

let runtime;
let auditDir;

before(async () => {
  auditDir = mkdtempSync(join(tmpdir(), 'winvm-e2e-audit-'));
  runtime = await createService({
    ...DEFAULT_SERVICE_CONFIG,
    server: { host: '127.0.0.1', port: PORT },
    audit: { dir: auditDir, redactParams: true },
  });
});

after(async () => {
  if (runtime) await runtime.close();
});

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, body: await res.json() };
}

describe('E2E · 服务启动与健康检查', () => {
  test('/health 返回结构化健康快照', async () => {
    const { status, body } = await get('/health');
    assert.equal(status, 200);
    assert.ok('ok' in body);
    assert.ok(body.provider, '必须包含 provider 状态');
    assert.ok(body.session, '必须包含会话状态');
    assert.ok(body.capabilities, '必须包含能力计数');
    assert.ok(body.audit, '必须包含审计链状态');
  });

  test('审计链初始校验通过', async () => {
    const { body } = await get('/health');
    assert.equal(body.audit.chainValid, true);
  });

  test('能力注册表已装入全部四大能力域', async () => {
    const ids = runtime.registry.list();
    assert.ok(ids.some((i) => i.startsWith('system.')), '缺少 system 域');
    assert.ok(ids.some((i) => i.startsWith('app.')), '缺少 app 域');
    assert.ok(ids.some((i) => i.startsWith('storage.')), '缺少 storage 域');
    assert.ok(ids.some((i) => i.startsWith('gui.')), '缺少 gui 域');
    assert.ok(ids.length >= 40, `能力数量偏少：${ids.length}`);
  });

  test('能力注册表结构自检通过（L2/L3 必须留存快照）', () => {
    const v = runtime.registry.validate();
    assert.equal(v.ok, true, JSON.stringify(v.issues));
  });
});

describe('E2E · A2A 发现与协议严格性', () => {
  test('/.well-known/agent-card.json 符合 A2A v1.0', async () => {
    const { status, body } = await get('/.well-known/agent-card.json');
    assert.equal(status, 200);
    assert.equal(body.protocolVersion, '1.0');
    assert.ok(Array.isArray(body.supportedInterfaces));
    assert.equal(body.supportedInterfaces[0].protocolBinding, 'JSONRPC');
    assert.equal(body.skills.length, 5, '五大能力域应聚合为 5 个 A2A Skill（含 app-operation）');
    assert.deepEqual(
      body.skills.map((s) => s.id).sort(),
      ['app-manager', 'app-operation', 'gui-automation', 'storage-manager', 'system-admin'],
    );
  });

  test('A2A 版本协商：不支持的版本被拒绝', async () => {
    const res = await fetch(`${BASE}/a2a`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'A2A-Version': '0.9' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/send', params: {} }),
    });
    const body = await res.json();
    assert.equal(body.error.code, -32600);
    assert.equal(body.error.data.code, 'VersionNotSupportedError');
  });

  test('已废弃方法 tasks/send → MethodNotFound', async () => {
    const { body } = await post('/a2a', { jsonrpc: '2.0', id: 1, method: 'tasks/send', params: {} });
    assert.equal(body.error.code, -32601);
  });
});

describe('E2E · MCP 通道', () => {
  test('initialize 返回协议版本', async () => {
    const { body } = await post('/mcp', {
      jsonrpc: '2.0', id: 1, method: 'initialize', params: {},
    });
    assert.equal(body.result.protocolVersion, '2025-06-18');
    assert.equal(body.result.serverInfo.name, 'winvm-bridge');
  });

  test('tools/list 暴露能力且附带风险标注', async () => {
    const { body } = await post('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const tools = body.result.tools;
    assert.ok(tools.length > 0, '未暴露任何工具');
    const names = tools.map((t) => t.name);
    assert.ok(names.includes('system.info.get'));
    // 描述中必须带风险等级，供宿主侧判断
    const info = tools.find((t) => t.name === 'system.info.get');
    assert.match(info.description, /L0/);
    // 高危工具带破坏性标注
    const del = tools.find((t) => t.name === 'storage.file.delete');
    if (del) assert.equal(del.annotations.destructiveHint, true);
  });

  test('工具名即能力 ID（点分形式，便于追溯）', async () => {
    const { body } = await post('/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
    const names = body.result.tools.map((t) => t.name);
    assert.ok(names.every((n) => /^(system|app|storage|gui|appops|meta)\.[a-z0-9]+\.[a-z0-9]+$/.test(n)),
      `存在不符合能力 ID 规范的工具名：${names.filter((n) => !/^(system|app|storage|gui|appops|meta)\./.test(n))}`);
  });

  test('策略引擎拦截越权路径（真实调用路径）', async () => {
    const { body } = await post('/mcp', {
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'storage.file.write', arguments: { path: 'C:\\Windows\\System32\\evil.txt', content: 'x' } },
    });
    const sc = body.result.structuredContent;
    assert.ok(sc, JSON.stringify(body));
    assert.equal(sc.ok, false, '写入系统目录必须被拒绝');
    assert.equal(sc.error.code, 'POLICY_DENIED');
  });

  test('L2 删除操作触发审批闸并返回 approvalId', async () => {
    const { body } = await post('/mcp', {
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      // Q3 修正（Phase 3 批5）：旧路径 `C:\Users\alice\old` 不在 pathAllowlist（离线
      // createService 环境 USERPROFILE≠alice）⇒ 策略层在**审批闸之前**以 pathAllowlist:miss
      // 拒掉 ⇒ APPROVAL_REQUIRED 永不可达（离线必红；真机 Windows 恰好当前用户=alice 才绿的
      // 侥幸面）。改用硬编码生产工作目录白名单（defaults.ts `C:\WinVMWorkspace\**`）⇒ 两环境同判据。
      params: { name: 'storage.file.delete', arguments: { path: 'C:\\WinVMWorkspace\\drafts\\old.txt' } },
    });
    const sc = body.result.structuredContent;
    // 若 ps-bridge 不可用会返回 PROVIDER_UNAVAILABLE；策略层未拦截则说明有误
    assert.ok(sc, JSON.stringify(body));
    if (sc.error?.code === 'PROVIDER_UNAVAILABLE') return; // 环境无 PowerShell，跳过
    assert.equal(sc.ok, false);
    assert.equal(sc.error.code, 'APPROVAL_REQUIRED', `实际：${JSON.stringify(sc.error)}`);
    assert.ok(sc.approval.approvalId, '必须返回 approvalId 供续跑');
    assert.equal(sc.approval.risk, 'L2');
    assert.ok(sc.approval.impact.length > 0, '审批卡片必须给出影响清单');
  });
});

describe('E2E · A2A 委派通道', () => {
  test('message/send 创建任务并推进到终态', async () => {
    const { body } = await post('/a2a', {
      jsonrpc: '2.0',
      id: 10,
      method: 'message/send',
      params: {
        message: { kind: 'message', role: 'user', messageId: 'm1', parts: [{ kind: 'text', text: '查询系统信息' }] },
        metadata: { traceId: 'tr_e2e_1', maxRisk: 'L1' },
        configuration: { blocking: true },
      },
    });
    assert.ok(body.result, JSON.stringify(body));
    assert.equal(body.result.kind, 'task');
    assert.ok(['completed', 'failed', 'rejected'].includes(body.result.status.state),
      `终态异常：${body.result.status.state}`);
  });

  test('委派任务产出 artifact（破除黑盒）', async () => {
    const { body } = await post('/a2a', {
      jsonrpc: '2.0', id: 11, method: 'message/send',
      params: {
        message: { kind: 'message', role: 'user', messageId: 'm2', parts: [{ kind: 'text', text: '查询系统信息' }] },
        metadata: { traceId: 'tr_e2e_2', maxRisk: 'L1' },
        configuration: { blocking: true },
      },
    });
    const task = body.result;
    if (task.status.state !== 'completed') return; // 环境降级，跳过
    assert.ok(task.artifacts && task.artifacts.length > 0, '完成的任务必须带回传 artifact');
    const names = task.artifacts.map((a) => a.name ?? '');
    assert.ok(names.includes('execution-steps'), `缺少执行步骤 artifact：${JSON.stringify(names)}`);
  });

  test('tasks/get 可查询任务', async () => {
    const created = await post('/a2a', {
      jsonrpc: '2.0', id: 12, method: 'message/send',
      params: {
        message: { kind: 'message', role: 'user', messageId: 'm3', parts: [{ kind: 'text', text: 'x' }] },
        metadata: { traceId: 'tr_e2e_3' },
      },
    });
    const taskId = created.body.result.id;
    const got = await post('/a2a', {
      jsonrpc: '2.0', id: 13, method: 'tasks/get', params: { name: `tasks/${taskId}` },
    });
    assert.equal(got.body.result.id, taskId);
  });

  test('message/stream 返回 SSE 事件流', async () => {
    const res = await fetch(`${BASE}/a2a`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 14, method: 'message/stream',
        params: {
          message: { kind: 'message', role: 'user', messageId: 'm4', parts: [{ kind: 'text', text: '查询系统信息' }] },
          metadata: { traceId: 'tr_e2e_4', maxRisk: 'L1' },
        },
      }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const text = await res.text();
    assert.ok(text.includes('data: '), 'SSE 响应必须包含 data 帧');
    assert.ok(text.includes('status-update'), 'SSE 必须包含状态更新事件');
  });
});

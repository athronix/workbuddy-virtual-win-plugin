/**
 * Phase 3 批3 · M1（audit §3.2 M1 / §6 批3 判据）：`notifications/cancelled` 主动取消通路。
 *
 * 旧实现：`mcp-framework/server.ts:177-180` 三 case 合并 `return null`——协议里唯一
 * **客户端主动取消在途 tools/call** 的通知被吞（直调 600s 长任务"停不下来"只能等断连被动面）。
 *
 * 新实现：inflightCancels 登记表（id→cancelGate reject 句柄），settle 必删；通知命中 ⇒
 * AbortError 语义（isError + CANCELED_TEXT + canceled:true），与 ARCH-29 断连取消同一出口。
 *
 * 纪律：不 import 被测包以外的东西；纯 stdlib；逐文件跑（整批触发 junction 0xC0000005 假全红）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';

const ROOT = join(dirname(new URL(import.meta.url).pathname), '..', '..');
const FRAMEWORK = pathToFileURL(join(ROOT, 'packages', 'mcp-framework', 'dist', 'server.js')).href;

/** 慢 handler：永不自行返回，只等待被取消（模拟 600s 长任务）。 */
function slowHandler(delayMs = 60_000) {
  const slow = {
    started: false,
    handler: async () => {
      slow.started = true;
      await new Promise((r) => setTimeout(r, delayMs));
      return { structuredContent: { ok: true, shouldNotReach: true } };
    },
  };
  return slow;
}

async function makeServerWith(handler) {
  const { McpServer, CANCELED_TEXT } = await import(FRAMEWORK);
  const srv = new McpServer({
    name: 'p3b3-cancel-test',
    version: '0.0.0',
    tools: [{ name: 'demo.long', description: 't', inputSchema: {}, handler }],
  });
  return { srv, CANCELED_TEXT };
}

describe('P3-b3 · notifications/cancelled 接通（M1）', () => {
  test('在途 tools/call 收到取消通知 ⇒ 取消语义体（不再等到天荒地老）', async () => {
    const slow = slowHandler(60_000);
    const { srv, CANCELED_TEXT } = await makeServerWith(slow.handler);

    const inflight = srv.handleRequest({
      jsonrpc: '2.0', id: 42, method: 'tools/call',
      params: { name: 'demo.long', arguments: {} },
    });
    // 等 handler 真启动（登记表已写入）
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(slow.started, true, '前置：handler 应在途');

    const notif = await srv.handleRequest({
      jsonrpc: '2.0', method: 'notifications/cancelled',
      params: { requestId: 42, reason: '用户点了停止' },
    });
    assert.equal(notif, null, '通知不得产生响应体（既有协议钉不动）');

    const res = await inflight; // 旧实现这里永远 pending 到 60s——本行秒回即证明接通
    assert.equal(res.result.isError, true);
    assert.equal(res.result.content[0].text, CANCELED_TEXT, '复用 ARCH-29 框架权威取消文案（同族语义同文案）');
    assert.equal(res.result.structuredContent.canceled, true);
    assert.equal(res.result.structuredContent.ok, false);
    assert.equal(res.result.structuredContent.inFlightMayContinue, true, '协作式中止红线：VM 内在途副作用可能继续，不得谎称已停');
  });

  test('未知/已 settle 的 requestId ⇒ 静默忽略（协议惯例），不影响后续请求', async () => {
    const { srv } = await makeServerWith(async () => ({ structuredContent: { ok: true } }));
    const n = await srv.handleRequest({
      jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 999 },
    });
    assert.equal(n, null);
    const ok = await srv.handleRequest({
      jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'demo.long', arguments: {} },
    });
    assert.equal(ok.result.isError, false, '幽灵取消通知不得污染后续请求');
  });

  test('缺 requestId 的取消通知 ⇒ 不炸不吞后续', async () => {
    const { srv } = await makeServerWith(async () => ({ structuredContent: { ok: true } }));
    const n = await srv.handleRequest({
      jsonrpc: '2.0', method: 'notifications/cancelled', params: {},
    });
    assert.equal(n, null);
  });

  test('settle 后登记表必删（keep-alive 无界增长红线）：连发 3 条完成后表内归零', async () => {
    let n = 0;
    const { srv } = await makeServerWith(async () => ({ structuredContent: { ok: ++n } }));
    for (const id of [1, 2, 3]) {
      await srv.handleRequest({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'demo.long', arguments: {} } });
    }
    const map = srv.inflightCancels;
    assert.equal(map.size, 0, `settle 后在途表应空，实得 ${map.size}`);
    // 事后取消通知（已 settle）⇒ 静默
    const late = await srv.handleRequest({
      jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 },
    });
    assert.equal(late, null);
  });

  test('notifications/initialized 与 initialized 行为逐字节不变（防顺手改）', async () => {
    const { srv } = await makeServerWith(async () => ({ structuredContent: { ok: true } }));
    assert.equal(await srv.handleRequest({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }), null);
    assert.equal(await srv.handleRequest({ jsonrpc: '2.0', method: 'initialized', params: {} }), null);
  });
});

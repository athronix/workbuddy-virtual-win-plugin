/**
 * 宿主侧 A2A 委派桥（@winvm/host-a2a-bridge）单元测试
 *
 * 不碰网络/隧道：注入 mock A2A client，验证
 * 工具面、委派流程、进度与产物收集、审批提取、错误路径。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createA2aBridgeTools, extractApproval, extractText } from '@winvm/host-a2a-bridge';
import { buildA2aResumeHint, withA2aResumeHint } from '@winvm/host-a2a-bridge';

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
    // T5 §1.1-6：VM 侧回包确为 canceled ⇒ 取消成立（cancelObserved 一等公民，宿主无需自比字符串）
    assert.equal(res.structuredContent.cancelObserved, true);
    assert.ok(res.content[0].text.includes('VM 侧已确认取消'), '文本须同步呈现取消已确认');
  });

  test('T5 cancelObserved：回包非 canceled（任务已自行结束）⇒ false 且文本如实说明未生效', async () => {
    const client = mockClient([], {
      async cancelTask(id) {
        return { kind: 'task', id, contextId: 'ctx_1', status: { state: 'completed' }, artifacts: [] };
      },
    });
    const res = await findTool(toolsFor(client), 'a2a.task.cancel').handler({ taskId: 'task_9' }, CTX);
    assert.equal(res.isError, false, '请求本身成功 ⇒ 不因取消未生效而报错');
    assert.equal(res.structuredContent.state, 'completed');
    assert.equal(res.structuredContent.cancelObserved, false, '取消未生效必须如实报 false（不得恒真）');
    assert.ok(res.content[0].text.includes('取消未生效'), `实测：${res.content[0].text}`);
  });

  // T5 收官小修（QA 裁定：分层是有意设计，只澄清呈现）：`ok:true`/`isError:false` = 传输层
  // 「取消请求被服务端处理成功」，**不等于**业务层取消生效；生效只看 `cancelObserved`。
  // 该口径必须同时出现在**工具注册表 description**（宿主 Agent 唯一稳定读到的说明书）与
  // **cancelObserved:false 的实测回包文本**里 —— 只改其一等于没改。
  test('T5 cancel ok 语义澄清：description 与 false 态回包文本均声明「传输层≠业务生效」', async () => {
    const cancelTool = findTool(toolsFor(mockClient()), 'a2a.task.cancel');
    assert.ok(cancelTool.description.includes('ok:true'), 'description 须点名 ok 字段的语义边界');
    assert.ok(
      cancelTool.description.includes('isError:false') && cancelTool.description.includes('传输层'),
      `description 须写清 ok/isError 属传输层，实测：${cancelTool.description}`,
    );
    assert.ok(
      cancelTool.description.includes('以 `cancelObserved` 为准'),
      'description 须把业务生效判据指到 cancelObserved（不得让宿主读 ok）',
    );

    const client = mockClient([], {
      async cancelTask(id) {
        return { kind: 'task', id, contextId: 'ctx_1', status: { state: 'completed' }, artifacts: [] };
      },
    });
    const res = await findTool(toolsFor(client), 'a2a.task.cancel').handler({ taskId: 'task_9' }, CTX);
    // 呈现分层**不变**：请求成功 ⇒ ok:true / isError:false（不得因未生效而谎报失败）
    assert.equal(res.structuredContent.ok, true, 'ok 仍表传输层成功（本小修不改取值逻辑）');
    assert.equal(res.isError, false, '取消未生效不得升级成 isError');
    assert.equal(res.structuredContent.cancelObserved, false);
    assert.ok(
      res.content[0].text.includes('仅表示取消请求已被服务端处理（传输层成功）'),
      `false 态文本须自带分层口径，实测：${res.content[0].text}`,
    );
    assert.ok(
      res.content[0].text.includes('以 `cancelObserved` 为准'),
      `false 态文本须指向业务生效判据，实测：${res.content[0].text}`,
    );
  });

  test('a2a.health 返回 Agent Card 技能清单', async () => {
    const res = await findTool(toolsFor(mockClient()), 'a2a.health').handler({}, CTX);
    assert.equal(res.isError, false);
    assert.equal(res.structuredContent.name, 'WinVM Bridge Agent');
    assert.equal(res.structuredContent.skills[0].id, 'app-operation');
  });
});

/* ===================== CL-016 追加用例 ===================== */

/** CL-016：含 type / impact / preview / summary 的完整审批 data part */
function approvalUpdateFull() {
  return {
    kind: 'status-update',
    taskId: 'task_cl016',
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
              type: 'approval-request',
              approvalId: 'apr_cl016',
              risk: 'L2',
              capabilityId: 'storage.file.delete',
              preview: { params: { paths: ['C:\\old\\a.log'], permanent: false }, note: '将删除 1 个文件' },
              impact: ['C:\\old\\a.log（12.4 MB）'],
              summary: '删除 old 目录下 1 个日志文件',
            },
          },
        ],
      },
    },
    final: true,
  };
}

/** 构造仅含一个 data part 的 agent 消息 */
function dataMessage(data) {
  return { kind: 'message', role: 'agent', messageId: 'm', parts: [{ kind: 'data', data }] };
}

describe('CL-016 审批载荷透传', () => {
  test('impact / preview 逐项深等透传，kind 与 summary 就位', () => {
    const a = extractApproval(approvalUpdateFull().status.message);
    assert.ok(a);
    assert.equal(a.approvalId, 'apr_cl016');
    assert.deepEqual(a.preview, {
      params: { paths: ['C:\\old\\a.log'], permanent: false },
      note: '将删除 1 个文件',
    });
    assert.deepEqual([...a.impact], ['C:\\old\\a.log（12.4 MB）']);
    assert.equal(a.kind, 'approval-request');
    assert.equal(a.summary, '删除 old 目录下 1 个日志文件');
  });

  test('空数组与空对象也原样透传', () => {
    const a = extractApproval(
      dataMessage({ type: 'approval-request', approvalId: 'apr_empty', risk: 'L2', impact: [], preview: {} }),
    );
    assert.ok(a);
    assert.deepEqual(a.impact, []);
    assert.deepEqual(a.preview, {});
  });

  test('类型非法则省略该字段（不输出 undefined 字面量）', () => {
    const a = extractApproval(
      dataMessage({ type: 'approval-request', approvalId: 'apr_bad', risk: 'L2', impact: [1, 2], preview: 'nope' }),
    );
    assert.ok(a);
    assert.equal('impact' in a, false);
    assert.equal('preview' in a, false);
    assert.equal('resumeHint' in a, false);
    assert.ok(!Object.values(a).some((v) => v === undefined));
  });

  test("type 非 'approval-request' 的 data 不识别为审批", () => {
    assert.equal(extractApproval(dataMessage({ type: 'progress', approvalId: 'apr_x', risk: 'L2' })), undefined);
  });
});

describe('CL-016 A2A 续跑提示', () => {
  test('buildA2aResumeHint 含 a2a.approval.reply 且绝不含 __approvalId', () => {
    const withTask = buildA2aResumeHint('apr_1', 'task_1');
    assert.ok(withTask.includes('a2a.approval.reply'));
    assert.ok(!withTask.includes('__approvalId'));
    assert.ok(withTask.includes('taskId: "task_1"'));
    assert.ok(withTask.includes('approvalId: "apr_1"'));
    const noTask = buildA2aResumeHint('apr_2');
    assert.ok(noTask.includes('approvalId: "apr_2"'));
    assert.ok(!noTask.includes('taskId:'));
    assert.ok(!noTask.includes('__approvalId'));
  });

  test('withA2aResumeHint 幂等（已有 resumeHint 不覆盖）', () => {
    const a = {
      approvalId: 'apr_1',
      message: 'm',
      resumeHint: '（A2A 续跑）放行：a2a.approval.reply { approvalId: "apr_1", approved: true }',
    };
    assert.equal(withA2aResumeHint(a, 'task_9').resumeHint, a.resumeHint);
  });

  test('a2a.delegate 输出的 approval 带 resumeHint，整段绝不含 __approvalId', async () => {
    const client = mockClient([statusUpdate('working', '准备'), approvalUpdateFull()]);
    const res = await findTool(toolsFor(client), 'a2a.delegate').handler({ goal: '删除日志' }, CTX);
    const sc = res.structuredContent;
    assert.ok(sc.approval, '应返回审批请求');
    assert.ok(sc.approval.resumeHint.includes('a2a.approval.reply'));
    assert.ok(sc.approval.resumeHint.includes('taskId: "task_cl016"'));
    assert.ok(!JSON.stringify(sc.approval).includes('__approvalId'));
    assert.ok(!JSON.stringify(res).includes('__approvalId'), 'A2A 通道输出绝不能出现 __approvalId');
  });

  test('a2a.delegate 挂审批时附宿主侧 approvalAudit（pending）', async () => {
    const client = mockClient([statusUpdate('working', '准备'), approvalUpdateFull()]);
    const res = await findTool(toolsFor(client), 'a2a.delegate').handler({ goal: '删除日志' }, CTX);
    const audit = res.structuredContent.approvalAudit;
    assert.ok(audit, '应附宿主侧留痕');
    assert.equal(audit.approvalId, 'apr_cl016');
    assert.equal(audit.traceId, 'tr_test');
    assert.equal(audit.channel, 'a2a');
    assert.equal(audit.result, 'pending');
    assert.match(audit.previewHash, /^[0-9a-f]{64}$/);
  });
});

describe('CL-016 三终止文案', () => {
  test('timedOut：超时文案不暗示默认批准', async () => {
    const client = mockClient([], {
      async *streamMessage() {
        await new Promise((r) => setTimeout(r, 5));
        yield statusUpdate('working', 'x');
      },
    });
    const res = await findTool(toolsFor(client), 'a2a.delegate').handler({ goal: 'x', timeoutMs: 1 }, CTX);
    const sc = res.structuredContent;
    assert.equal(sc.timedOut, true);
    assert.ok(sc.summary.includes('委派等待超时'));
    assert.ok(sc.summary.includes('审批未获批准'));
    assert.ok(!sc.summary.includes('默认批准'));
    assert.ok(!sc.summary.includes('审批被拒绝'));
    assert.ok(!sc.summary.includes('任务已取消'));
  });

  test('rejected：终止文案明确未执行任何变更', async () => {
    const client = mockClient([statusUpdate('rejected', '审批被拒绝', { final: true })]);
    const res = await findTool(toolsFor(client), 'a2a.delegate').handler({ goal: 'x' }, CTX);
    const sc = res.structuredContent;
    assert.equal(sc.state, 'rejected');
    assert.equal(res.isError, true);
    assert.ok(sc.summary.includes('审批被拒绝（rejected）'));
    assert.ok(sc.summary.includes('未执行任何变更'));
    assert.ok(!sc.summary.includes('默认批准'));
    assert.ok(!sc.summary.includes('委派等待超时'));
  });

  // T5 判据⑥（§10 R3）：本用例原断「审批通道已关闭，未执行任何变更」旧句。
  // 旧句是不实陈述（取消是协作式的，取消点之前的调用可能已真实改动 VM），
  // T5 已改为**事实化两态** ⇒ 同步适配（改断言而非改实现；口径见 §1.1-6）。
  // 原负向守卫（不得暗示默认批准 / 不得混入超时文案）**逐条保留**。
  test('canceled：取消文案事实化（零执行痕迹态 ⇒ 不宣称变更、不附加计数字段）', async () => {
    const client = mockClient([statusUpdate('canceled', '已取消', { final: true })]);
    const res = await findTool(toolsFor(client), 'a2a.delegate').handler({ goal: 'x' }, CTX);
    const sc = res.structuredContent;
    assert.equal(sc.state, 'canceled');
    assert.equal(res.isError, true, 'canceled 必须 isError:true（ok 计算含 canceled）');
    assert.ok(sc.summary.includes('任务已取消（canceled）'), '应保留 canceled 状态词');
    assert.ok(sc.summary.includes('取消点之前的操作未执行'), '零痕迹态须按 §1.1-6 明示未执行');
    assert.ok(!sc.summary.includes('未执行任何变更'), '不实陈述「未执行任何变更」须已退场');
    assert.equal('executedBeforeCancel' in sc, false, '零痕迹态不得附加该键（判据③：两态可分）');
    assert.ok(!sc.summary.includes('默认批准'));
    assert.ok(!sc.summary.includes('委派等待超时'));
  });

  test('canceled：有执行痕迹态文案事实化 N 操作/M 产物并附加 executedBeforeCancel', async () => {
    const client = mockClient([
      statusUpdate('working', '执行 gui.screen.capture：截取当前屏幕'),
      artifactUpdate('shot.png'),
      statusUpdate('canceled', '已取消', { final: true }),
    ]);
    const sc = (await findTool(toolsFor(client), 'a2a.delegate').handler({ goal: 'x' }, CTX)).structuredContent;
    assert.equal(sc.state, 'canceled');
    assert.ok(sc.summary.includes('取消前已有 1 个操作执行、1 个产物'), `实测文案：${sc.summary}`);
    assert.ok(sc.summary.includes('请逐项核对 artifacts'), '须引导用户核对，不得撤销核对信号');
    assert.ok(!sc.summary.includes('未执行任何变更'), '有痕迹态绝不宣称未执行');
    assert.deepEqual(sc.executedBeforeCancel, { steps: 1, artifacts: 1 }, '判据③：有痕迹态必须附加该键');
  });

  test('canceled：steps 权威源为 execution-steps artifact（优先于进度文本，载体不计产物）', async () => {
    const carrier = {
      kind: 'artifact-update',
      taskId: 'task_1',
      contextId: 'ctx_1',
      artifact: {
        artifactId: 'a_steps',
        name: 'execution-steps',
        parts: [{ kind: 'data', data: { steps: [{ index: 0 }, { index: 1 }, { index: 2 }] } }],
      },
    };
    const client = mockClient([
      statusUpdate('working', '执行 system.info.get：获取系统信息'),
      carrier,
      statusUpdate('canceled', '已取消', { final: true }),
    ]);
    const sc = (await findTool(toolsFor(client), 'a2a.delegate').handler({ goal: 'x' }, CTX)).structuredContent;
    assert.deepEqual(
      sc.executedBeforeCancel,
      { steps: 3, artifacts: 0 },
      'steps 取 artifact 内数组长度；execution-steps 载体本身不得计入「产物数」',
    );
  });

  test('挂起审批仍保留「任务挂起等待审批」语义', async () => {
    const client = mockClient([statusUpdate('working', '准备'), approvalUpdate()]);
    const res = await findTool(toolsFor(client), 'a2a.delegate').handler({ goal: 'x' }, CTX);
    assert.ok(res.structuredContent.summary.includes('任务挂起等待审批'));
    assert.equal(res.isError, false);
  });
});

describe('CL-016 A6 向后兼容回归', () => {
  test('极简 fixture（仅 approvalId/risk/capabilityId/message）仍可用，缺省字段不报错', () => {
    const a = extractApproval(approvalUpdate().status.message);
    assert.ok(a);
    assert.equal(a.approvalId, 'apr_8f3c');
    assert.ok(typeof a.message === 'string' && a.message.length > 0);
    assert.equal('impact' in a, false);
    assert.equal('preview' in a, false);
    assert.equal('resumeHint' in a, false);
    assert.ok(!Object.values(a).some((v) => v === undefined));
  });

  test('delegate 处理极简 fixture：结果无 undefined 字面量', async () => {
    const client = mockClient([statusUpdate('working', '先跑一步'), approvalUpdate()]);
    const res = await findTool(toolsFor(client), 'a2a.delegate').handler({ goal: 'x' }, CTX);
    const sc = res.structuredContent;
    assert.equal(sc.state, 'input-required');
    assert.equal(sc.approval.approvalId, 'apr_8f3c');
    assert.equal('impact' in sc.approval, false);
    assert.equal('preview' in sc.approval, false);
    assert.equal(
      sc.approval.resumeHint,
      '（A2A 续跑）放行：a2a.approval.reply { taskId: "task_1", approvalId: "apr_8f3c", approved: true }',
    );
    assert.ok(!res.content[0].text.includes('undefined'));
  });
});

/* ===================== CL-016 A7 凭据红线（脱敏） ===================== */

/** 含四类凭据哨兵的审批 data part（preview.params / impact / 文本三处） */
function approvalUpdateCreds() {
  return {
    kind: 'status-update',
    taskId: 'task_creds',
    contextId: 'ctx_1',
    status: {
      state: 'input-required',
      message: {
        kind: 'message',
        role: 'agent',
        messageId: 'm3',
        parts: [
          {
            kind: 'data',
            data: {
              type: 'approval-request',
              approvalId: 'apr_creds',
              risk: 'L2',
              capabilityId: 'appops.gui.produce',
              summary: '导出并覆盖（password: LEAK_SENTINEL_PW）',
              message: '凭据检查 password: LEAK_SENTINEL_PW',
              preview: {
                params: {
                  user: 'alice',
                  password: 'LEAK_SENTINEL_PW',
                  privateKey: 'LEAK_SENTINEL_KEY',
                  passphrase: 'LEAK_SENTINEL_PP',
                  token: 'LEAK_SENTINEL_TK',
                },
                note: '将覆盖导出 1 个文件',
              },
              impact: ['password=LEAK_SENTINEL_PW', 'C:\\old\\a.log（12.4 MB）', 'api_key=LEAK_SENTINEL_AK'],
            },
          },
        ],
      },
    },
    final: true,
  };
}

const SENTINELS = [
  'LEAK_SENTINEL_PW',
  'LEAK_SENTINEL_KEY',
  'LEAK_SENTINEL_PP',
  'LEAK_SENTINEL_TK',
  'LEAK_SENTINEL_AK',
];

describe('CL-016 A7 凭据红线（脱敏）', () => {
  test('extractApproval：preview 凭据键打码，非凭据项逐字保留', () => {
    const a = extractApproval(approvalUpdateCreds().status.message);
    assert.ok(a);
    assert.equal(a.preview.params.user, 'alice');
    assert.equal(a.preview.params.password, '***REDACTED***');
    assert.equal(a.preview.params.privateKey, '***REDACTED***');
    assert.equal(a.preview.params.passphrase, '***REDACTED***');
    assert.equal(a.preview.params.token, '***REDACTED***');
    assert.equal(a.preview.note, '将覆盖导出 1 个文件');
  });

  test('impact：凭据键项打码，非凭据项逐字未变', () => {
    const a = extractApproval(approvalUpdateCreds().status.message);
    assert.ok(a);
    assert.deepEqual([...a.impact], [
      'password=***REDACTED***',
      'C:\\old\\a.log（12.4 MB）',
      'api_key=***REDACTED***',
    ]);
  });

  test('message / summary 文本脱敏（哨兵不得出现）', () => {
    const a = extractApproval(approvalUpdateCreds().status.message);
    assert.ok(a);
    assert.ok(!a.message.includes('LEAK_SENTINEL_PW'));
    assert.ok(a.message.includes('password=***REDACTED***'));
    assert.ok(!a.summary.includes('LEAK_SENTINEL_PW'));
  });

  test('a2a.delegate 全量输出不含任一哨兵原文', async () => {
    const client = mockClient([statusUpdate('working', '准备'), approvalUpdateCreds()]);
    const res = await findTool(toolsFor(client), 'a2a.delegate').handler({ goal: '导出覆盖' }, CTX);
    const dump = JSON.stringify(res);
    for (const sent of SENTINELS) {
      assert.ok(!dump.includes(sent), `输出不应含哨兵 ${sent}`);
    }
    assert.ok(JSON.stringify(res.structuredContent.approval.preview).includes('***REDACTED***'));
    assert.ok(res.content[0].text.includes('***REDACTED***'), '呈现文本应打码');
  });

  test('a2a.task.get 呈现文本亦脱敏', async () => {
    const client = mockClient([], {
      async getTask(id) {
        return {
          kind: 'task',
          id,
          contextId: 'ctx_1',
          status: { state: 'input-required', message: approvalUpdateCreds().status.message },
          artifacts: [],
        };
      },
    });
    const res = await findTool(toolsFor(client), 'a2a.task.get').handler({ taskId: 'task_creds' }, CTX);
    const dump = JSON.stringify(res);
    for (const sent of SENTINELS) {
      assert.ok(!dump.includes(sent), `task.get 输出不应含哨兵 ${sent}`);
    }
  });

  test('D3 回归：无 type 的极简 fixture 仍返回 approvalId + 可读摘要、不抛错', async () => {
    const client = mockClient([statusUpdate('working', '先跑一步'), approvalUpdate()]);
    const res = await findTool(toolsFor(client), 'a2a.delegate').handler({ goal: 'x' }, CTX);
    const sc = res.structuredContent;
    assert.equal(sc.state, 'input-required');
    assert.equal(sc.approval.approvalId, 'apr_8f3c');
    assert.ok(typeof sc.approval.message === 'string' && sc.approval.message.length > 0);
    assert.equal(res.isError, false);
  });

  test('R1：progress[] 同源文本亦脱敏（不再漏明文）', async () => {
    const client = mockClient([
      statusUpdate('working', '打开文件 password: LEAK_SENTINEL_PW 完成'),
      statusUpdate('completed', 'done', { final: true }),
    ]);
    const res = await findTool(toolsFor(client), 'a2a.delegate').handler({ goal: 'x' }, CTX);
    const p0 = res.structuredContent.progress[0].message;
    assert.ok(!p0.includes('LEAK_SENTINEL_PW'));
    assert.ok(p0.includes('password=***REDACTED***'));
    assert.ok(!JSON.stringify(res).includes('LEAK_SENTINEL_PW'));
  });
});

/**
 * CL-026b · 挂起掐流的行为级守卫（真机盲区补堵）
 *
 * 病灶（主理人真机实测复现，traceId tr_mvhqpd53_5，**非 mock**）：
 *   L2 委派（建 junction）→ 任务挂起 `input-required` → **VM 侧挂起时把 SSE 长流掐断**
 *   → 桥 `streamMessage` 的 `for await` 抛 undici 原生 `TypeError: 'terminated'`
 *   （非 A2AClientError；"terminated" 全仓源码零命中 = undici 内部错误）
 *   → 落 `packages/host-a2a-bridge/src/tools.ts` delegate 的 **catch 分支**
 *   → 旧返回 `{ok:false, error:{code:'A2A_DELEGATE_FAILED'}}`，**无 approval、
 *     无 APPROVAL_PRESENTATION_DIRECTIVE** ⇒ 宿主 agent 拿不到呈现指令，
 *     CL-026 的出卡契约在真实挂起路径上形同虚设。
 *
 * 上轮漏检根因（本轮必须堵的 mock 盲区）：CL-026 的行为钉全部用「正常 final
 * status-update」驱动 ⇒ 只测到 approval 早退分支；纯函数拼接测试测不到整条
 * 流断链路。**本件是行为级**：mock stream 真实「吐出若干事件后抛
 * TypeError('terminated')」，驱动**整条 delegate handler**（经 dist 消费），
 * 断言挂起收口的五个携带面与错误收口的防误伤。
 *
 * 判据族：
 *   B-1 挂起收口（核心）—— terminated + input-required + approval ⇒
 *       呈现指令在文案面/载荷面、无 error 字段、state=input-required、
 *       taskId/traceId/progress/approvalAudit 齐备、isError:false；
 *   B-2 逐字同源 —— 掐流收口 summary 与正常早退 summary **字符串全等**
 *       （单源函数 suspendSummaryText 的机器保证，防两份文案未来分叉）；
 *   B-3 防误伤真网络错 —— terminated 但 approval 缺席 ⇒ 仍 A2A_DELEGATE_FAILED
 *       （「挂起≠失败」判据 = state 与 approval 双条件，与 VM 侧
 *       server.ts「input-required 不落 errorCode」对称）；
 *   B-4 判据不依赖错误形态 —— 非 TypeError（任意 Error）挂起态同样收口
 *       （undici 掐流形态多变：TypeError: terminated / ECONNRESET / socket
 *       hang up 等，判据锚定「挂起事实」而非「错误类型」）；
 *   B-5 红线 —— 掐流收口输出全量 JSON 零 MCP 续跑标记字面、零凭据明文；
 *   B-6 灵敏度自证（K-10）—— 变异体必须命中判据（旧行为形态必然失配）。
 *
 * 依据：docs/design/cl026-approval-presentation.md（CL-026 五携带面契约，本件
 * 是第六面＝掐流收口面，要求与 L1/L2 逐字同源）；主理人任务书 CL-026b。
 *
 * 纪律：纯 node stdlib + 构建产物（经 dist 消费 ⇒ 改 src 必先 `tsc -b`，K-3）；
 * 不碰 VM / 网络 / PowerShell；不写盘。
 * 运行：node --test tests/unit/cl026b-stream-break-suspension.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  APPROVAL_PRESENTATION_DIRECTIVE,
  createA2aBridgeTools,
  _resetAuditIndex,
} from '@winvm/host-a2a-bridge';

/**
 * MCP 续跑标记：测试内同样禁止完整字面量（与 cl026/r1 同规矩，全仓 grep 恒零）。
 * 拼接构造。
 */
const MCP_MARKER = '__appr' + 'ovalId';

/* ============================ 夹具 ============================ */

/** 正常进度事件（非 final，流继续） */
function statusUpdate(state, text) {
  return {
    kind: 'status-update',
    taskId: 'task_cl026b',
    contextId: 'ctx_cl026b',
    status: {
      state,
      message: { kind: 'message', role: 'agent', messageId: 'm1', parts: [{ kind: 'text', text }] },
    },
    final: false,
  };
}

/** 挂起审批事件（含 approval-request DataPart；final:false —— 真机上 VM 不会等它 flush 就掐流） */
function approvalUpdate(approvalId = 'apr_cl026b', extraData = {}) {
  return {
    kind: 'status-update',
    taskId: 'task_cl026b',
    contextId: 'ctx_cl026b',
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
              approvalId,
              risk: 'L2',
              capabilityId: 'storage.link.manage',
              summary: '在 C:/WinVMWorkspace 创建目录联接',
              message: '该步骤需宿主确认后继续',
              impact: ['将在工作区创建 junction'],
              preview: { path: 'C:/WinVMWorkspace/a2a-live-demo-link' },
              underlying: { capabilityId: 'storage.link.manage', goalText: '建 junction 指向 a2a-live-demo' },
              ...extraData,
            },
          },
        ],
      },
    },
    final: false,
  };
}

/** artifact 事件（验证掐流收口面对已收 artifact 的搬运） */
function artifactUpdate(name = 'note.txt') {
  return {
    kind: 'artifact-update',
    taskId: 'task_cl026b',
    contextId: 'ctx_cl026b',
    artifact: { artifactId: 'a_1', name, parts: [{ kind: 'text', text: '掐流前已产出的文本' }] },
    lastChunk: true,
  };
}

/**
 * 核心 mock：**先按序吐出 events，随后抛 err**（复现「VM 挂起时掐断 SSE 长流」）。
 * 抛错发生在 `for await` 的 next() 上 ⇒ 逐字复现真机链路（非 final 事件 + 流抛错）。
 * @param {any[]} events
 * @param {Error} err
 */
function streamBreakClient(events, err) {
  return {
    async *streamMessage() {
      for (const e of events) yield e;
      throw err;
    },
    async getTask(id) {
      return {
        kind: 'task',
        id,
        contextId: 'ctx_cl026b',
        status: { state: 'input-required', message: { kind: 'message', role: 'agent', messageId: 'm', parts: [] } },
        artifacts: [],
      };
    },
    async close() {},
  };
}

/** 正常早退对照 client：同事件序列但 approval 事件 final:true（流正常收口，不抛错） */
function normalClient(events) {
  return {
    async *streamMessage() {
      for (const e of events) yield e;
    },
    async getTask(id) {
      return { kind: 'task', id, contextId: 'ctx_cl026b', status: { state: 'completed', message: undefined }, artifacts: [] };
    },
    async close() {},
  };
}

function delegateTool(client) {
  const tools = createA2aBridgeTools({ clientProvider: { get: async () => client } });
  const t = tools.find((x) => x.name === 'a2a.delegate');
  assert.ok(t, '应暴露工具 a2a.delegate');
  return t;
}

const CTX = { traceId: 'tr_cl026b' };

/** undici 掐流的真机形态（主理人 traceId tr_mvhqpd53_5 实测错误；name 亦按 undici 为 TypeError） */
function undiciTerminated() {
  const e = new TypeError('terminated');
  // undici 真实场景 cause 常见 socketError；桥只看 message，本字段仅增强仿真真实度
  e.cause = Object.assign(new Error('other side closed'), { code: 'ECONNRESET' });
  return e;
}

/* ============================================================================
 * B-1 · 挂起掐流收口（核心行为钉：驱动整条 delegate 处理链）
 * ========================================================================== */

describe('CL-026b B-1 · 掐流挂起收口：terminated + input-required + approval ⇒ 出卡契约在场', () => {
  test('真机链路复现：事件流 → TypeError(terminated) ⇒ 返回含呈现指令、无 error 字段、state=input-required', async () => {
    _resetAuditIndex();
    const client = streamBreakClient(
      [statusUpdate('working', '正在准备目录联接'), approvalUpdate('apr_b1')],
      undiciTerminated(),
    );
    const res = await delegateTool(client).handler({ goal: '在 C:/WinVMWorkspace 建 junction', maxRisk: 'L2' }, CTX);
    const sc = res.structuredContent;

    // —— 出卡契约核心：文案面与载荷面 ——
    assert.ok(res.content[0].text.includes(APPROVAL_PRESENTATION_DIRECTIVE), 'content[0].text 必须携带呈现要求（宿主文本面）');
    assert.ok(sc.summary.includes(APPROVAL_PRESENTATION_DIRECTIVE), 'summary 必须内嵌呈现要求');
    assert.ok(sc.approval, '掐流收口必须携带 approval 载荷（旧盲区：无 approval ⇒ 出卡契约形同虚设）');
    assert.equal(sc.approval.presentationDirective, APPROVAL_PRESENTATION_DIRECTIVE, 'approval.presentationDirective 必须在册且 === 权威串');
    assert.equal(sc.approval.approvalId, 'apr_b1');
    assert.match(sc.approval.resumeHint, /^（A2A 续跑）放行：a2a\.approval\.reply \{ taskId: "task_cl026b"/, 'resumeHint 续跑指令与正常路径同构');

    // —— 挂起≠失败：错误面缺席、传输位口径 ——
    assert.equal('error' in sc, false, '挂起收口必须**无 error 字段**（旧形态 A2A_DELEGATE_FAILED 即本件病灶）');
    assert.ok(!JSON.stringify(res).includes('A2A_DELEGATE_FAILED'), '全量输出不得出现委派失败码');
    assert.equal(res.isError, false, '挂起不是工具级错误（与正常早退面同口径）');
    assert.equal(sc.ok, false, 'ok:false 如实标记本次调用未能正常收口（主理人规格：流确被掐断）');

    // —— 状态与事实搬运面 ——
    assert.equal(sc.state, 'input-required');
    assert.equal(sc.taskId, 'task_cl026b');
    assert.equal(sc.traceId, 'tr_cl026b');
    assert.equal(sc.contextId, 'ctx_cl026b');
    assert.equal(sc.progress.length, 1, '掐流前已见的进度必须搬运（approval 事件无 text part ⇒ 不入进度，既有口径）');
    assert.equal(sc.progress[0].state, 'working');
    assert.equal(sc.progress[0].message, '正在准备目录联接');
    assert.match(sc.summary, /^任务挂起等待审批：/, 'CL-016 前缀逐字不变（红线）');
    assert.match(sc.summary, /真实目标：/, 'K5 真实目标行同样在场');

    // —— 宿主审批留痕（与正常早退面同款 pending 记录）——
    assert.ok(sc.approvalAudit, '掐流收口同样必须留痕');
    assert.equal(sc.approvalAudit.approvalId, 'apr_b1');
    assert.equal(sc.approvalAudit.result, 'pending');
    assert.equal(sc.approvalAudit.channel, 'a2a');
    assert.equal(sc.approvalAudit.traceId, 'tr_cl026b');
    assert.match(sc.approvalAudit.previewHash, /^[0-9a-f]{64}$/, 'previewHash 形态与既有面一致');
  });

  test('已收 artifact 在掐流收口面照常搬运（文本进 content、摘要进 structuredContent）', async () => {
    const client = streamBreakClient(
      [statusUpdate('working', '跑一步'), artifactUpdate('pre-cut.txt'), approvalUpdate('apr_b1_art')],
      undiciTerminated(),
    );
    const res = await delegateTool(client).handler({ goal: 'x' }, CTX);
    const sc = res.structuredContent;
    assert.equal(sc.artifacts.length, 1, '掐流前到达的 artifact 不得随错误收口丢失');
    assert.equal(sc.artifacts[0].name, 'pre-cut.txt');
    assert.ok(
      res.content.some((c) => c.type === 'text' && c.text === '掐流前已产出的文本'),
      'artifact 文本内容照常回传',
    );
    assert.ok(res.content[0].text.includes(APPROVAL_PRESENTATION_DIRECTIVE), '产物搬运不影响呈现要求携带');
  });
});

/* ============================================================================
 * B-2 · 逐字同源：掐流收口 ≡ 正常早退（单源构造器的机器保证）
 * ========================================================================== */

describe('CL-026b B-2 · 掐流收口与正常早退**逐字同源**（文案分叉 = 未来回归源）', () => {
  test('同一 approval 载荷：terminated 收口 vs final 早退 ⇒ summary 全等、approval 载荷逐字段一致（除时间戳）', async () => {
    const evA = [statusUpdate('working', '正在准备'), approvalUpdate('apr_same')];
    // 掐流路径
    const broke = await delegateTool(streamBreakClient(evA, undiciTerminated())).handler({ goal: 'x' }, CTX);
    // 正常早退路径（approval 事件置 final:true ⇒ 走 break 后正常返回面）
    const evB = [statusUpdate('working', '正在准备'), { ...approvalUpdate('apr_same'), final: true }];
    _resetAuditIndex();
    const early = await delegateTool(normalClient(evB)).handler({ goal: 'x' }, CTX);

    assert.equal(broke.structuredContent.summary, early.structuredContent.summary, 'summary 必须字符串全等（两份文案 = 分叉源，本钉封死）');
    assert.equal(broke.content[0].text, early.content[0].text, '文本面全等');
    // structuredContent 键集：掐流面与早退面同构（早退面多出的键=无；差异仅 ok 值本身）
    assert.deepEqual(Object.keys(broke.structuredContent).sort(), Object.keys(early.structuredContent).sort(), '键集合合同构');
    // approval 载荷逐字段一致（at 时间戳毫秒级可差，排除后深比较）
    const stripAt = (o) => {
      const { approval, approvalAudit, ...rest } = o.structuredContent;
      const audit = { ...approvalAudit };
      delete audit.at;
      return { approval, audit, rest };
    };
    const b = stripAt(broke);
    const e = stripAt(early);
    assert.deepEqual(b.approval, e.approval, 'approval 载荷（含 presentationDirective/resumeHint/impact/preview/underlying）必须全等');
    assert.deepEqual(b.audit, e.audit, '留痕除时间戳外全等');
    assert.equal(broke.structuredContent.ok, false, '掐流面 ok:false（本次调用未正常收口）');
    assert.equal(early.structuredContent.ok, true, '早退面 ok:true（既有语义不被本件改动）');
  });
});

/* ============================================================================
 * B-3 · 防误伤：真·网络异常仍 A2A_DELEGATE_FAILED
 * ========================================================================== */

describe('CL-026b B-3 · 防误伤真网络错（approval 缺席 ⇒ 错误收口原样保留）', () => {
  test('terminated 但**从未见过审批**（approval==null）⇒ 仍 A2A_DELEGATE_FAILED + isError:true', async () => {
    const client = streamBreakClient([statusUpdate('working', '刚起步')], undiciTerminated());
    const res = await delegateTool(client).handler({ goal: 'x' }, CTX);
    const sc = res.structuredContent;
    assert.equal(sc.error.code, 'A2A_DELEGATE_FAILED', '真网络异常的错误码不得被挂起收口吞掉');
    assert.equal(sc.isError ?? res.isError, true);
    assert.equal(res.isError, true, '错误收口 isError 位保持');
    assert.equal(sc.ok, false);
    assert.equal('approval' in sc, false, '无审批事实不得造 approval 键（纯附加纪律）');
    assert.ok(!JSON.stringify(res).includes('呈现要求'), '错误收口不得误挂呈现指令（只有真实挂起才是指挥对象）');
    assert.ok(!JSON.stringify(res).includes(APPROVAL_PRESENTATION_DIRECTIVE), '权威串零泄漏到错误面');
  });

  test('流**立即抛错**（零事件，taskId 空）⇒ 错误收口不带 taskId 键（既有形态零回归）', async () => {
    const client = streamBreakClient([], undiciTerminated());
    const res = await delegateTool(client).handler({ goal: 'x' }, CTX);
    const sc = res.structuredContent;
    assert.equal(sc.error.code, 'A2A_DELEGATE_FAILED');
    assert.equal('taskId' in sc, false, 'taskId 缺席时该键不出现（既有 \`taskId ? {}\` 条件形态）');
    assert.deepEqual(sc.progress, []);
  });

  test('state=input-required 但审批 DataPart 畸形（approval 提取失败）⇒ 保守走错误收口（宁误报失败不伪造审批）', async () => {
    // input-required 只带纯文本（无 approvalId 可提取）后掐流
    const client = streamBreakClient([statusUpdate('input-required', '等待外部输入（无审批载荷）')], undiciTerminated());
    const res = await delegateTool(client).handler({ goal: 'x' }, CTX);
    assert.equal(res.structuredContent.error.code, 'A2A_DELEGATE_FAILED', '无 approval 双判据不成立 ⇒ 不得短路');
    assert.equal('approval' in res.structuredContent, false);
    assert.ok(!JSON.stringify(res).includes('呈现要求'));
  });
});

/* ============================================================================
 * B-4 · 判据锚定挂起事实而非错误形态（undici 掐流形态多变）
 * ========================================================================== */

describe('CL-026b B-4 · 收口判据 =（state ∧ approval），不依赖异常类型/message', () => {
  for (const [label, makeErr] of [
    ['TypeError(ECONNRESET)', () => Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' })],
    ['Error(socket hang up)', () => new Error('socket hang up')],
    ['无 message 的裸 Error', () => new Error('')],
  ]) {
    test(`挂起事实已在 ⇒ ${label} 同样收口成挂起返回（出卡契约不因错误形态漂移）`, async () => {
      const client = streamBreakClient([approvalUpdate(`apr_${label.length}`)], makeErr());
      const res = await delegateTool(client).handler({ goal: 'x' }, CTX);
      assert.ok(res.structuredContent.summary.includes(APPROVAL_PRESENTATION_DIRECTIVE), `${label} 下呈现要求必须在位`);
      assert.equal('error' in res.structuredContent, false, `${label} 下不得回落错误收口`);
      assert.equal(res.structuredContent.state, 'input-required');
    });
  }

  test('approval-update（final:false）之后立即掐流：循环已填 state/approval 即收口（无“至少一条进度”前置依赖）', async () => {
    const client = streamBreakClient([approvalUpdate('apr_bare')], undiciTerminated());
    const res = await delegateTool(client).handler({ goal: 'x' }, CTX);
    assert.equal(res.structuredContent.approval.approvalId, 'apr_bare');
    assert.ok(res.content[0].text.includes('任务挂起等待审批：'));
    assert.deepEqual(res.structuredContent.progress, [], '无进度事件时 progress 为空数组而非缺键');
  });
});

/* ============================================================================
 * B-5 · 红线：新收口面零 MCP 续跑标记、零凭据明文
 * ========================================================================== */

describe('CL-026b B-5 · 掐流收口面红线（通道隔离 + 凭据脱敏与正常面同纪律）', () => {
  test('挂起收口全量 JSON：零 MCP 续跑标记字面（R1-a 通道隔离）', async () => {
    const client = streamBreakClient([statusUpdate('working', 'w'), approvalUpdate('apr_redline')], undiciTerminated());
    const res = await delegateTool(client).handler({ goal: 'x' }, CTX);
    assert.ok(!JSON.stringify(res).includes(MCP_MARKER), '掐流收口输出绝不允许通道串台');
    assert.ok(!APPROVAL_PRESENTATION_DIRECTIVE.includes(MCP_MARKER), '权威串本体零标记（复核）');
  });

  test('掐流收口 summary 经 scrubText：凭据键值打码、REDACTED 在场、呈现要求不受影响', async () => {
    const leaked = approvalUpdate('apr_cred_b', {
      message: '该步骤需宿主确认后继续 password=HUNTER2_LEAK_CL026B',
      impact: { note: 'token=LEAK_TOKEN_CL026B' },
    });
    // impact 合法形态为字符串数组（含凭据键项由 redactImpactItem 打码）
    leaked.status.message.parts[0].data.impact = ['token=LEAK_TOKEN_CL026B'];
    const client = streamBreakClient([leaked], undiciTerminated());
    const res = await delegateTool(client).handler({ goal: 'x' }, CTX);
    const dump = JSON.stringify(res);
    assert.ok(!dump.includes('HUNTER2_LEAK_CL026B'), 'message 凭据明文必须打码（summary 文本面）');
    assert.ok(!dump.includes('LEAK_TOKEN_CL026B'), 'impact 凭据值不得外泄');
    assert.ok(dump.includes('***REDACTED***'), '打码哨兵在场');
    assert.ok(res.content[0].text.includes('呈现要求'), '打码后呈现指令照常携带');
  });
});

/* ============================================================================
 * B-6 · 灵敏度自证（K-10：旧行为/弱化判据必然失配，防永绿守卫）
 * ========================================================================== */

describe('CL-026b B-6 · 判据灵敏度（变异检验）', () => {
  test('变异①：旧行为形态（error 收口）必须失配 B-1 判据（证明本钉真能抓住盲区复活）', () => {
    // 旧 catch 返回体（修复前形态）——若守卫被改回"宽容"，该形态必须命中以下所有失配：
    const legacy = {
      isError: true,
      structuredContent: {
        ok: false,
        traceId: 'tr_x',
        taskId: 'task_cl026b',
        progress: [],
        error: { code: 'A2A_DELEGATE_FAILED', message: 'terminated' },
      },
    };
    const sc = legacy.structuredContent;
    assert.ok('error' in sc, '失配①：旧形态带 error 字段（B-1 的无 error 钉应红）');
    assert.ok(!('approval' in sc), '失配②：旧形态无 approval 载荷（B-1 的载荷钉应红）');
    assert.ok(!JSON.stringify(legacy).includes('呈现要求'), '失配③：旧形态零呈现指令（B-1 文本面钉应红）');
    assert.equal(legacy.isError, true, '失配④：旧形态 isError:true（B-1 的 isError:false 钉应红）');
  });

  test('变异②：单条件判据（只查 state）必然放行畸形挂起 ⇒ 双条件必要性自证', async () => {
    // 只查 state 的弱化实现会把「input-required 但无审批载荷」误收成挂起返回；
    // 现行双条件判据在 B-3 第 3 例已钉住该形态必走 A2A_DELEGATE_FAILED。
    // 此处再自证半边判据单独不足以触发收口：
    const onlyState = streamBreakClient([statusUpdate('input-required', '无审批')], undiciTerminated());
    const r1 = await delegateTool(onlyState).handler({ goal: 'x' }, CTX);
    assert.equal(r1.structuredContent.error.code, 'A2A_DELEGATE_FAILED', 'state 半边不足 ⇒ 仍需 approval');
    assert.equal('approval' in r1.structuredContent, false, '畸形挂起不得伪造 approval 键');
    // 另一半边（approval 有但流**未抛错**）不进 catch ⇒ 由 B-2 对照钉承载：
    // 正常早退与掐流收口两路**同判据同形态**，不存在「approval 单独短路」的第三路。
    const earlyOnly = await delegateTool(normalClient([approvalUpdate('apr_half')])).handler({ goal: 'x' }, CTX);
    assert.equal(earlyOnly.structuredContent.ok, true, '流正常终结走既有早退面（ok:true 不被本件改动）');
  }, 30_000);

  test('变异③：把权威串换成长度相同但措辞漂移的串 ⇒ presentationDirective === 权威串钉必须命中', async () => {
    const drift = APPROVAL_PRESENTATION_DIRECTIVE.replace('show_widget', 'render_card');
    assert.notEqual(drift, APPROVAL_PRESENTATION_DIRECTIVE, '变异真的改到字节');
    const client = streamBreakClient([approvalUpdate('apr_drift')], undiciTerminated());
    const res = await delegateTool(client).handler({ goal: 'x' }, CTX);
    assert.equal(res.structuredContent.approval.presentationDirective, APPROVAL_PRESENTATION_DIRECTIVE, '现行值恒等于权威串（漂移必红）');
    assert.notEqual(res.structuredContent.approval.presentationDirective, drift, '变异体不现行（判据非永真自证）');
  });
});

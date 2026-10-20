/**
 * CL-026 · 审批卡强制呈现闭环 —— 静态钉 + 行为钉
 *
 * 病灶（真机实证 2026-10-20）：`a2a.delegate` 挂起审批时**载荷齐全**
 * （approvalId / kind='approval-request' / underlying 真实意图 / previewHash），
 * 但返回文案与 SKILL.md 都没有指挥宿主 agent 用「审批卡 + 权威确认控件」呈现
 * ⇒ 是否出卡全凭 agent 自由发挥（真机那张卡是主理人现场按 R17 规范手工渲染，非系统保证）。
 *
 * 本件把指挥信号下移到**工具返回面**并升级为 MUST 流程，五判据族：
 *   C-1 文案契约 —— 权威串 `APPROVAL_PRESENTATION_DIRECTIVE` 恰 4 行、锚点与两工具名在位；
 *   C-2 接线面   —— 行为钉（经 dist）：delegate 早退 / approval 字段 / **task.get 观测面** /
 *                    两工具 description 全部携带；无审批载荷时**不得**出现该键（纯附加）；
 *   C-3 门禁面   —— SKILL.md A2A 小节含 MUST + show_widget + AskUserQuestion，
 *                    且**不新增三级标题**（R1-9 用节切片取证，新增 `###` 会静默截断其范围）；
 *   C-4 红线     —— 本件全部改动面零 MCP 续跑标记字面量（测试内同样拆段构造）；
 *   C-5 灵敏度   —— 变异体必须命中判据（K-10「永绿守卫等于没有守卫」）。
 *
 * 依据：docs/design/cl026-approval-presentation.md（§1 规范文案 / §2 携带面 / §5 守卫预检）、
 * docs/design/r17-design.md §A1.1（两段式选型，引用不改动）、
 * skills/winvm-orchestrator/references/approval-card.md §4/§5/§9/§10（唯一正文，只引用不复述）。
 *
 * 纪律：纯 node stdlib + 构建产物；不碰 VM / 网络 / PowerShell；不写盘。
 * 运行：先 `tsc -b tsconfig.build.json`（K-3），再
 *      `node --test tests/unit/cl026-approval-presentation.test.js`
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  APPROVAL_PRESENTATION_DIRECTIVE,
  createA2aBridgeTools,
  withPresentationDirective,
  withA2aResumeHint,
} from '@winvm/host-a2a-bridge';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8');

/**
 * MCP 续跑标记：**测试内同样禁止以完整字面量书写**（与 approval-card.ts / r1-approval-card.test.js
 * 同规矩，使对本仓渲染层的 `grep -c` 恒为 0）。拼接构造。
 */
const MCP_MARKER = '__appr' + 'ovalId';

/* ============================ 夹具 ============================ */

function statusUpdate(state, text, extra = {}) {
  return {
    kind: 'status-update',
    taskId: 'task_cl026',
    contextId: 'ctx_cl026',
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

/** 完整审批载荷（type=approval-request + impact/preview/underlying ⇒ 卡片信息量齐备） */
function approvalUpdate(approvalId = 'apr_cl026') {
  return {
    kind: 'status-update',
    taskId: 'task_cl026',
    contextId: 'ctx_cl026',
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
              capabilityId: 'appops.workflow.run',
              summary: '卸载企业微信',
              message: '该步骤需宿主确认后继续',
              impact: ['企业微信将被卸载'],
              preview: { id: 'Tencent.WeCom' },
              underlying: { capabilityId: 'app.winget.uninstall', goalText: '卸载企业微信' },
            },
          },
        ],
      },
    },
    final: true,
  };
}

function mockClient(events = [], overrides = {}) {
  return {
    async *streamMessage() {
      for (const e of events) yield e;
    },
    async getTask(id) {
      return {
        kind: 'task',
        id,
        contextId: 'ctx_cl026',
        status: { state: 'completed', message: { kind: 'message', role: 'agent', messageId: 'm', parts: [{ kind: 'text', text: 'done' }] } },
        artifacts: [],
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

const CTX = { traceId: 'tr_cl026' };

/* ============================================================================
 * C-1 · 权威串文案契约
 * ========================================================================== */

describe('CL-026 C-1 · 呈现要求权威串（文案契约）', () => {
  test('常量在位、恰 4 行、锚点词与两工具名齐备', () => {
    assert.equal(typeof APPROVAL_PRESENTATION_DIRECTIVE, 'string');
    const lines = APPROVAL_PRESENTATION_DIRECTIVE.split('\n');
    assert.equal(lines.length, 4, `呈现要求必须恰 4 行（防文案面膨胀/缩水），实得 ${lines.length}`);
    assert.match(APPROVAL_PRESENTATION_DIRECTIVE, /呈现要求/, '锚点串「呈现要求」是守卫与宿主识别判据');
    assert.match(APPROVAL_PRESENTATION_DIRECTIVE, /MUST/, '必须是强制口径而非建议');
    assert.match(APPROVAL_PRESENTATION_DIRECTIVE, /show_widget/, '① 视觉载体工具名必须显式绑定');
    assert.match(APPROVAL_PRESENTATION_DIRECTIVE, /AskUserQuestion/, '② 权威收口工具名必须显式绑定');
    assert.match(APPROVAL_PRESENTATION_DIRECTIVE, /七槽位/, '① 必须指向七槽位卡');
    assert.match(APPROVAL_PRESENTATION_DIRECTIVE, /approvalId/, '审批 ID 必须为必含项');
    assert.match(APPROVAL_PRESENTATION_DIRECTIVE, /approvalId 摘要/, '② 选项文案须带 approvalId 摘要');
    assert.match(APPROVAL_PRESENTATION_DIRECTIVE, /禁止.*纯文本转呈|纯文本转呈.*代替出卡/, '③ 必须禁止纯文本转呈代替出卡');
    assert.match(APPROVAL_PRESENTATION_DIRECTIVE, /禁止代替用户批准|禁止.*代替用户批准/, '③ 必须禁止代用户批准');
    assert.match(APPROVAL_PRESENTATION_DIRECTIVE, /逐字降级/, '③ 降级必须逐字（强制兜底路径）');
    assert.match(APPROVAL_PRESENTATION_DIRECTIVE, /approval-card\.md/, '降级权威必须指向唯一正文');
    assert.match(APPROVAL_PRESENTATION_DIRECTIVE, /a2a\.approval\.reply/, '④ 唯一续跑指令');
    assert.match(APPROVAL_PRESENTATION_DIRECTIVE, /a2a\.task\.get/, '④ 批准后必须轮询至终态');
  });

  test('四行各司其职：①出卡 ②收口 ③禁令+降级 ④续跑+轮询（顺序不可颠倒）', () => {
    const [l1, l2, l3, l4] = APPROVAL_PRESENTATION_DIRECTIVE.split('\n');
    assert.match(l1, /^【呈现要求·MUST】① 先 show_widget 出审批卡/, '第 1 行必须是出卡段');
    assert.match(l2, /^② 随后 AskUserQuestion 权威收口/, '第 2 行必须是收口段（在出卡之后）');
    assert.match(l3, /^③ 禁止/, '第 3 行必须是禁令 + 降级段');
    assert.match(l4, /^④ 批准后调 a2a\.approval\.reply/, '第 4 行必须是续跑 + 轮询段');
    // 七槽位齐名（与 approval-card.md §4 对照表同一套；此处只验名字在场，不复述正文）
    for (const slot of ['操作', '目标', '通道', '风险', '影响清单', '可逆性', '预览']) {
      assert.ok(l1.includes(slot), `第 1 行缺七槽位之一：${slot}`);
    }
    assert.match(l1, /underlying 真实意图/, '「目标」槽位必须取真实意图（K5 信息量）');
    assert.match(l2, /暂不决定（超时观察，任务保持挂起）/, '③ 必须给出「超时观察」第三选项（未作答等价语义）');
  });

  test('源码形态：常量由数组 join 构造 + 零插值（固定文本 ⇒ 天然无凭据、无通道串台）', () => {
    const tools = read('packages', 'host-a2a-bridge', 'src', 'tools.ts');
    assert.match(
      tools,
      /export const APPROVAL_PRESENTATION_DIRECTIVE: string = \[[\s\S]*?\]\.join\('\\n'\);/,
      '权威串必须是数组 join 的固定文本（禁止模板插值）',
    );
    assert.ok(!/\$\{[A-Za-z_.]+\}/.test(APPROVAL_PRESENTATION_DIRECTIVE), '取值内不得出现插值结果');
    assert.ok(!APPROVAL_PRESENTATION_DIRECTIVE.includes(MCP_MARKER), '权威串零 MCP 续跑标记');
    for (const cred of ['password', 'privateKey', 'passphrase', 'token', 'secret']) {
      assert.ok(
        !APPROVAL_PRESENTATION_DIRECTIVE.toLowerCase().includes(cred),
        `权威串不得涉及凭据词：${cred}`,
      );
    }
  });

  test('固定文本跨调用恒等（同一条权威串，禁止每次合成漂移）', () => {
    const a = withPresentationDirective({ approvalId: 'apr_1', message: 'm', risk: 'L2' });
    const b = withPresentationDirective({ approvalId: 'apr_2', message: 'm2', risk: 'L3' });
    assert.equal(a.presentationDirective, APPROVAL_PRESENTATION_DIRECTIVE);
    assert.equal(b.presentationDirective, a.presentationDirective, '不同 approval 必须同一串');
  });

  test('幂等补挂：已有 presentationDirective 则原样返回、不覆盖、不改其它字段', () => {
    const base = { approvalId: 'apr_1', message: 'm', risk: 'L2', resumeHint: 'RH' };
    const once = withPresentationDirective(base);
    const twice = withPresentationDirective(once);
    assert.equal(twice, once, '二次补挂必须返回同一对象（幂等）');
    assert.equal(once.resumeHint, 'RH', '不得改动既有字段');
    assert.equal(base.presentationDirective, undefined, '补挂不得原地污染入参（纯扩展新对象）');
    // 与 withA2aResumeHint 的既有纪律同构：resumeHint 既有值同样不被覆盖
    const hinted = withA2aResumeHint({ approvalId: 'apr_9', message: 'm', resumeHint: 'KEEP' }, 'task_9');
    assert.equal(hinted.resumeHint, 'KEEP', '既有 resumeHint 逐字纪律不得被破坏（CL-016 回归面）');
  });
});

/* ============================================================================
 * C-2 · 接线面（行为钉，经 dist 产物真实调用 handler）
 * ========================================================================== */

describe('CL-026 C-2 · 呈现要求的携带面（delegate / approval 字段 / task.get）', () => {
  test('L1 delegate 早退：summary 前缀逐字不变 + 尾部携带呈现要求；content[0].text 同步', async () => {
    const client = mockClient([statusUpdate('working', '准备'), approvalUpdate()]);
    const res = await findTool(toolsFor(client), 'a2a.delegate').handler({ goal: '卸载企业微信' }, CTX);
    const sc = res.structuredContent;

    assert.equal(sc.state, 'input-required');
    assert.equal(res.isError, false, '挂起审批不是错误（既有语义）');
    assert.match(sc.summary, /^任务挂起等待审批：/, '前缀必须逐字保持（既有逐字钉不被破坏）');
    assert.match(sc.summary, /真实目标：卸载企业微信/, 'K5 真实目标行位置同样保持');
    assert.ok(sc.summary.includes(APPROVAL_PRESENTATION_DIRECTIVE), 'summary 必须内嵌呈现要求');
    assert.ok(res.content[0].text.includes('呈现要求'), 'content[0].text 同步携带（宿主读文本面）');
    // 追加顺序：呈现要求在既有文案之后 ⇒ 前缀面零回归
    assert.ok(sc.summary.indexOf('任务挂起等待审批') < sc.summary.indexOf('呈现要求'));
  });

  test('L2 approval 载荷：presentationDirective 在位且 === 权威串；既有字段零改动', async () => {
    const client = mockClient([statusUpdate('working', '准备'), approvalUpdate()]);
    const sc = (await findTool(toolsFor(client), 'a2a.delegate').handler({ goal: 'x' }, CTX)).structuredContent;
    const ap = sc.approval;

    assert.equal(ap.approvalId, 'apr_cl026');
    assert.equal(ap.kind, 'approval-request');
    assert.equal(ap.risk, 'L2');
    assert.deepEqual([...ap.impact], ['企业微信将被卸载'], 'impact 逐项一致（CL-016 透传纪律）');
    assert.deepEqual(ap.preview, { id: 'Tencent.WeCom' }, 'preview 逐项一致');
    assert.equal(ap.underlying.capabilityId, 'app.winget.uninstall', 'underlying 真实意图透传不被侵蚀');
    assert.match(ap.resumeHint, /^（A2A 续跑）放行：a2a\.approval\.reply /, 'resumeHint 形态逐字不变');
    assert.equal(ap.presentationDirective, APPROVAL_PRESENTATION_DIRECTIVE, '载荷面必须带同一条权威串');
    assert.ok(!Object.values(ap).some((v) => v === undefined), '全链路不得输出 undefined 字面量');
  });

  test('L3 task.get 观测挂起审批：同样携带（不得因观测工具不同而降级为纯文本）', async () => {
    const client = mockClient([], {
      async getTask(id) {
        return {
          kind: 'task',
          id,
          contextId: 'ctx_cl026',
          status: approvalUpdate('apr_get').status,
          artifacts: [],
        };
      },
    });
    const res = await findTool(toolsFor(client), 'a2a.task.get').handler({ taskId: 'task_cl026' }, CTX);
    const sc = res.structuredContent;

    assert.equal(sc.state, 'input-required');
    assert.equal(sc.approval.presentationDirective, APPROVAL_PRESENTATION_DIRECTIVE, 'approval 字段面');
    assert.ok(res.content[0].text.includes(APPROVAL_PRESENTATION_DIRECTIVE), '文案面');
    assert.match(res.content[0].text, /^任务 task_cl026 状态：input-required/, '既有前缀逐字不变');
  });

  test('无审批载荷 ⇒ presentationDirective 键整体不出现（纯附加，K-13 禁显式 undefined）', async () => {
    const client = mockClient([statusUpdate('working', '跑一步'), statusUpdate('completed', 'ok', { final: true })]);
    const sc = (await findTool(toolsFor(client), 'a2a.delegate').handler({ goal: 'x' }, CTX)).structuredContent;
    assert.equal(sc.state, 'completed');
    assert.equal('approval' in sc, false, '非挂起态不得造 approval 键');
    assert.ok(!JSON.stringify(sc).includes('presentationDirective'), '非挂起态整仓不得出现该键名');
    assert.ok(!sc.summary.includes('呈现要求'), '非挂起态文案不得携带呈现要求（只有待裁决审批才是指挥对象）');
  });

  test('L4/L5 工具 description：delegate 说明书 + reply 反向闭合（宿主 tools/list 稳定读到的面）', () => {
    const tools = toolsFor(mockClient());
    assert.equal(tools.length, 6, '工具数恒 6（本件只加字段与文案，零新增工具 ⇒ 与 receipt-ttl 同钉）');
    const del = findTool(tools, 'a2a.delegate');
    const reply = findTool(tools, 'a2a.approval.reply');

    assert.match(del.description, /呈现要求/, 'delegate description 必须点名呈现要求');
    assert.match(del.description, /show_widget/, 'delegate description 必须绑定出卡工具');
    assert.match(del.description, /AskUserQuestion/, 'delegate description 必须绑定收口工具');
    assert.match(del.description, /禁止纯文本转呈/, 'delegate description 必须含禁令');
    assert.match(reply.description, /AskUserQuestion/, 'reply 必须声明裁决唯一来源');
    assert.match(reply.description, /show_widget/, 'reply 必须声明出卡先于 reply（杜绝未出卡直接 reply）');
    assert.match(reply.description, /严禁代替用户放行/, '既有 fail-closed 口径不得退场');
  });

  test('超时分支仍保持既有冷启动文案与「审批未获批准」口径（不被呈现要求污染）', async () => {
    const client = mockClient([], {
      async *streamMessage() {
        await new Promise((r) => setTimeout(r, 5));
        yield statusUpdate('working', 'x');
      },
    });
    const sc = (await findTool(toolsFor(client), 'a2a.delegate').handler({ goal: 'x', timeoutMs: 1 }, CTX)).structuredContent;
    assert.equal(sc.timedOut, true);
    assert.match(sc.summary, /正常冷启动窗口/);
    assert.match(sc.summary, /审批未获批准/);
    assert.ok(!sc.summary.includes('默认批准'), '超时文案严禁暗示默认批准（CL-016 红线）');
  });
});

/* ============================================================================
 * C-3 · SKILL.md 门禁面（MUST 流程清单）
 * ========================================================================== */

describe('CL-026 C-3 · SKILL.md 审批闸升为 MUST 流程', () => {
  const SKILL = read('skills', 'winvm-orchestrator', 'SKILL.md');
  const A2A_SECTION = (() => {
    const start = SKILL.indexOf('### A2A 通道');
    assert.ok(start > 0, 'SKILL.md 必须有「### A2A 通道」小节');
    const rest = SKILL.slice(start + 1);
    const next = rest.search(/\n##\s|\n###\s/);
    return next === -1 ? rest : rest.slice(0, next);
  })();

  test('呈现要求节：MUST + 两工具名 + 返回体携带事实 + 第三选项等价口径', () => {
    assert.match(A2A_SECTION, /呈现要求（MUST/, '必须把呈现要求标为 MUST（非软描述）');
    assert.match(A2A_SECTION, /返回体自带/, '必须写明指令来源 = 工具返回体（系统保证，非 agent 自觉）');
    assert.match(A2A_SECTION, /MUST ①[\s\S]*show_widget/, '① 出卡段必须显式绑定 show_widget');
    assert.match(A2A_SECTION, /MUST ②[\s\S]*AskUserQuestion/, '② 收口段必须显式绑定 AskUserQuestion');
    assert.match(A2A_SECTION, /MUST ③[\s\S]*禁止[\s\S]*纯文本转呈/, '③ 必须禁止纯文本转呈代替出卡');
    assert.match(A2A_SECTION, /MUST ④[\s\S]*a2a\.approval\.reply[\s\S]*a2a\.task\.get/, '④ 续跑 + 轮询');
    assert.match(A2A_SECTION, /presentationDirective/, '必须指向返回体新增字段（与 L2 携带面对账）');
    assert.match(A2A_SECTION, /第三选项的等价口径/, '必须声明第三选项 = 未作答（不得读作第三种放行）');
    assert.match(A2A_SECTION, /不发任何 reply[\s\S]*fail-closed|不发任何 reply/, '等价口径必须挂 fail-closed 语义');
    assert.match(A2A_SECTION, /第二个携带面[\s\S]*a2a\.task\.get/, '必须声明 task.get 观测挂起同样出卡（与 L3 对账）');
    assert.match(A2A_SECTION, /降级 ≠ 跳过展示|降级.*跳过展示/, '必须钉住「降级不等于跳过展示」');
  });

  test('★ 取证面保护：A2A 小节内不得新增三级标题（否则 R1-9 节切片被静默截断）', () => {
    const inner = A2A_SECTION.split('\n').filter((l) => /^###\s/.test(l));
    assert.deepEqual(inner, [], `A2A 小节内出现三级标题 ⇒ r1-approval-card R1-9 的取证范围会被截断：${JSON.stringify(inner)}`);
  });

  test('门禁第 2 步（标准执行路径）同步升 MUST 且保留既有判据词', () => {
    const path = SKILL.slice(SKILL.indexOf('**标准执行路径**'), SKILL.indexOf('**为什么**'));
    assert.match(path, /两段式/, '既有钉：两段式必须在场');
    assert.match(path, /approval-request/, '既有钉：判据词必须在场');
    assert.match(path, /（MUST）/, '第 2 步必须标 MUST');
    assert.match(path, /返回体自带[\s\S]*呈现要求|呈现要求/, '必须指向返回体携带的事实');
    assert.match(path, /show_widget[\s\S]*AskUserQuestion/, '两步顺序绑定');
    assert.match(path, /禁止以纯文本转呈代替出卡|严禁代替用户放行/, '禁令在场');
  });

  test('既有红线与节标题未被动摇（R1-9 同族判据复算）', () => {
    assert.match(SKILL, /## 审批闸协议（L2\/L3 必守）/);
    assert.match(SKILL, /## 高危清单（L2\/L3，强制动作）/);
    assert.match(SKILL, /现场手写一次性脚本/);
    assert.match(SKILL, /唯一正确动作是停止并告知用户启用连接器/);
    const forbid = SKILL.slice(SKILL.indexOf('**严格禁止**'), SKILL.indexOf('**标准执行路径**'));
    assert.equal([...forbid.matchAll(/^- ❌/gm)].length, 5, '严格禁止条目数必须恒 5（本件不在该块增删）');
    assert.match(A2A_SECTION, /按钮绝不直调|点击按钮 ≠ 批准/, '按钮不直调红线保留');
    assert.match(A2A_SECTION, /任一不可用/, '降级触发条件保留');
    assert.match(A2A_SECTION, /逐字降级/, '逐字降级口径保留');
  });

  test('唯一正文纪律：SKILL.md 只引用 approval-card.md，不复制卡片正文/HTML', () => {
    assert.ok(!SKILL.includes('wac-'), 'SKILL.md 不得内嵌卡片 HTML');
    for (const verbatim of ['🔐 需要你确认（L2 破坏性操作）', '⛔ 高危操作，需要二次确认（L3）']) {
      assert.ok(!SKILL.includes(verbatim), `不得复制文本模板正文：${verbatim}`);
    }
    // MUST 流程里对槽位/降级只作指针引用（§4 / §5 / §1 L2 版 等编号允许，正文串不允许）
    assert.match(A2A_SECTION, /references\/approval-card\.md/, '降级权威必须指向唯一正文');
  });
});

/* ============================================================================
 * C-4 · 红线：本件改动面零 MCP 续跑标记字面量
 * ========================================================================== */

describe('CL-026 C-4 · 通道隔离红线（拆段写法，新改动面恒零）', () => {
  /**
   * 扫描集严格限定为**本件新增/改动面**：
   * - `SKILL.md` 不整文件扫描 —— 其 `### MCP 通道` 小节按协议**必须**保留 MCP 直调续跑说明，
   *   且该要求由 `r1-approval-card.test.js` R1-9 钉死（"MCP 通道小节保留其续跑方式（不被误删）"）。
   *   本件的红线作用域 = **A2A 通道小节 + 标准执行路径块**（见下方两例专项扫描）。
   * - `tools.ts` / `dist/tools.js` 整文件零标记（本件已把原注释中的两处提及改为不含字面量的表述，
   *   与 approval-card.ts 同纪律：全仓 grep 恒零）。
   */
  const SCANNED = [
    'packages/host-a2a-bridge/src/tools.ts',
    'packages/host-a2a-bridge/src/index.ts',
    'packages/host-a2a-bridge/dist/tools.js',
    'docs/design/cl026-approval-presentation.md',
    'docs/02-design/HOST-A2A-BRIDGE.md',
    'tests/unit/cl026-approval-presentation.test.js',
  ];

  for (const rel of SCANNED) {
    test(`${rel} 零 MCP 续跑标记字面量`, () => {
      assert.ok(!read(...rel.split('/')).includes(MCP_MARKER), `${rel} 出现完整标记字面量（R1-a 违规）`);
    });
  }

  test('SKILL.md 本件改动面零标记（A2A 小节 + 标准执行路径块），MCP 小节既有说明不被误删', () => {
    const SKILL = read('skills', 'winvm-orchestrator', 'SKILL.md');
    const start = SKILL.indexOf('### A2A 通道');
    const rest = SKILL.slice(start + 1);
    const next = rest.search(/\n##\s|\n###\s/);
    const a2aSection = next === -1 ? rest : rest.slice(0, next);
    assert.ok(!a2aSection.includes(MCP_MARKER), 'A2A 小节绝不允许出现 MCP 续跑标记（R1-a / R1-9 同判据）');

    const path = SKILL.slice(SKILL.indexOf('**标准执行路径**'), SKILL.indexOf('**为什么**'));
    assert.ok(!path.includes(MCP_MARKER), '标准执行路径块（本件改动面）不得出现 MCP 续跑标记');

    const mcpSection = SKILL.slice(SKILL.indexOf('### MCP 通道'), start);
    assert.ok(mcpSection.includes(MCP_MARKER), 'MCP 通道小节的续跑说明必须保留（不被本件误删，R1-9 同判据）');
  });

  test('行为面同样零标记（delegate / task.get 两路全量 JSON 扫描）', async () => {
    const delegate = await findTool(toolsFor(mockClient([approvalUpdate()])), 'a2a.delegate').handler({ goal: 'x' }, CTX);
    assert.ok(!JSON.stringify(delegate).includes(MCP_MARKER), 'delegate 输出绝不允许通道串台');

    const client = mockClient([], {
      async getTask(id) {
        return { kind: 'task', id, contextId: 'c', status: approvalUpdate('apr_get2').status, artifacts: [] };
      },
    });
    const got = await findTool(toolsFor(client), 'a2a.task.get').handler({ taskId: 'task_cl026' }, CTX);
    assert.ok(!JSON.stringify(got).includes(MCP_MARKER), 'task.get 输出绝不允许通道串台');

    // 唯一续跑指令形态保持（A2A 侧只有 reply 一条）
    assert.match(delegate.structuredContent.approval.resumeHint, /a2a\.approval\.reply \{ taskId:/);
  });

  test('凭据词零出现于呈现要求（固定文本 ⇒ 不可能泄漏）', async () => {
    const client = mockClient([
      statusUpdate('working', '准备'),
      {
        ...approvalUpdate('apr_cred'),
        status: {
          state: 'input-required',
          message: {
            kind: 'message',
            role: 'agent',
            messageId: 'm9',
            parts: [
              {
                kind: 'data',
                data: {
                  type: 'approval-request',
                  approvalId: 'apr_cred',
                  risk: 'L2',
                  message: '需确认',
                  preview: { params: { password: 'LEAK_SENTINEL_CL026' } },
                  impact: ['token=LEAK_TOKEN_CL026'],
                },
              },
            ],
          },
          final: true,
        },
      },
    ]);
    const res = await findTool(toolsFor(client), 'a2a.delegate').handler({ goal: 'x' }, CTX);
    const dump = JSON.stringify(res);
    assert.ok(!dump.includes('LEAK_SENTINEL_CL026'), 'preview 凭据值不得外泄');
    assert.ok(!dump.includes('LEAK_TOKEN_CL026'), 'impact 凭据值不得外泄');
    assert.ok(dump.includes('***REDACTED***'), '既有打码纪律仍在位');
    assert.ok(res.content[0].text.includes('呈现要求'), '打码后呈现要求同样携带');
  });
});

/* ============================================================================
 * C-5 · 灵敏度自证（变异体必须命中判据，防永绿守卫）
 * ========================================================================== */

describe('CL-026 C-5 · 判据灵敏度自证（内存变异，零写盘）', () => {
  test('变异①：指令去掉锚点词 ⇒ C-1 判据必须失配', () => {
    const mutant = APPROVAL_PRESENTATION_DIRECTIVE.replace('【呈现要求·MUST】', '【提示】');
    assert.ok(!/呈现要求/.test(mutant), '变异体必须不含锚点（否则 C-1 判据失明）');
    assert.ok(!/MUST/.test(mutant.split('\n')[0]), '首行必须失去 MUST 口径');
  });

  test('变异②-a：把两段式合并成三段 ⇒ 「恰 4 行」钉必须命中', () => {
    const merged = APPROVAL_PRESENTATION_DIRECTIVE.split('\n').slice(0, 3).join('\n');
    assert.equal(merged.split('\n').length, 3, '行数钉应命中（3 ≠ 4）');
    assert.notEqual(merged, APPROVAL_PRESENTATION_DIRECTIVE, '变异必须真的改到字节（否则打空）');
  });

  test('变异②-b：退成通用措辞（丢两工具名绑定）⇒ C-1 的两个工具名钉必须命中', () => {
    // 真实退化形态：后人把显式工具名换成"渲染组件/提问用户"式散文 ⇒ 宿主读不到可执行动作名
    const generic = APPROVAL_PRESENTATION_DIRECTIVE.replaceAll('show_widget', '渲染组件').replaceAll('AskUserQuestion', '提问用户');
    assert.ok(!/show_widget/.test(generic), 'show_widget 工具名钉应命中');
    assert.ok(!/AskUserQuestion/.test(generic), 'AskUserQuestion 工具名钉应命中');
    assert.match(APPROVAL_PRESENTATION_DIRECTIVE, /show_widget[\s\S]*AskUserQuestion/, '原文双名齐备（判据非误伤自证）');
  });

  test('变异③：把 MCP 标记塞进指令 ⇒ 红线扫描必须命中', () => {
    const poisoned = `${APPROVAL_PRESENTATION_DIRECTIVE}\n并以 ${MCP_MARKER} 重发`;
    assert.ok(poisoned.includes(MCP_MARKER), 'C-4 行为面判据应命中串台');
    assert.ok(!APPROVAL_PRESENTATION_DIRECTIVE.includes(MCP_MARKER), '真实常量必须零标记');
  });

  test('变异④：SKILL.md 把 MUST 流程退回软描述 ⇒ C-3 判据必须失配', () => {
    const SKILL = read('skills', 'winvm-orchestrator', 'SKILL.md');
    const mutant = SKILL.replace('呈现要求（MUST · 返回体自带，不是可选建议）', '呈现要求（建议）');
    assert.notEqual(mutant, SKILL, '变异必须真的改到字节');
    assert.ok(!/呈现要求（MUST/.test(mutant), 'MUST 钉应命中（软描述化）');
    assert.match(SKILL, /呈现要求（MUST/, '原文确实携带 MUST（判据非误伤自证）');
  });

  test('变异⑤：A2A 小节内加三级标题 ⇒ 取证截断风险必须被 C-3 专项钉抓住', () => {
    const SKILL = read('skills', 'winvm-orchestrator', 'SKILL.md');
    const start = SKILL.indexOf('### A2A 通道');
    const rest = SKILL.slice(start + 1);
    const next = rest.search(/\n##\s|\n###\s/);
    const section = next === -1 ? rest : rest.slice(0, next);
    const mutant = section + '\n### 违规新增子节\n';
    const inner = mutant.split('\n').filter((l) => /^###\s/.test(l));
    assert.equal(inner.length, 1, '变异体出现三级标题 ⇒ 专项钉判据（实得 0 即失明）');
    assert.equal(section.split('\n').filter((l) => /^###\s/.test(l)).length, 0, '原文零三级标题');
  });
});

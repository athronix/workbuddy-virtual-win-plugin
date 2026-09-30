/**
 * R17-T03 · R1 审批卡原生渲染断言基线
 *
 * 依据：docs/design/r17-design.md §A1.1（选型定稿：show_widget 视觉 + AskUserQuestion 收口）、
 * §A3.1（类图 ApprovalCardRenderer：APPROVAL_CARD_WIDGET_HTML / fillApprovalCard / needsTextFallback）、
 * §A3.3（七槽位映射与红线）、§A4（两段式时序 + 强制兜底）、§A6 U2/U5；
 * docs/prd/r17-prd.md R1；skills/winvm-orchestrator/references/approval-card.md §4/§5/§6/§7/§8/§9。
 *
 * 三道基线（本文件；SKILL.md / approval-card.md 的门禁静态守卫见文末 R1-8）：
 *   ① 行为基线（调用编译产物 @winvm/adapter-host-workbuddy 的纯函数）：
 *      七槽位映射（含 underlying 优先）、§5 降级固定串逐字、§6 可逆性判定、
 *      缺失字段降级判定（无 risk / 无 approvalId / 无续跑途径 → 不出卡）、
 *      通道隔离（产物与指令文本零 MCP 续跑标记）、L3 二次确认。
 *   ② 模板结构基线：占位符全部接线、零可执行回调面、暗色主题变量化、审批 ID 与续跑指令必含。
 *   ③ L2 Renderer 产物守卫：plan() 注入 references 唯一一份、validate() 对 R1-a 定级 error。
 *
 * 运行：先 `tsc -b tsconfig.build.json`（或本包 tsconfig），再
 *      `node --test tests/unit/r1-approval-card.test.js`
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  APPROVAL_CARD_CHANNEL_PREFIX,
  APPROVAL_CARD_FALLBACK_TEXTS,
  APPROVAL_CARD_REFERENCE_PATH,
  APPROVAL_CARD_REPLY_TOOL,
  APPROVAL_CARD_REVERSIBILITY_TEXTS,
  APPROVAL_CARD_SKILL_ID,
  APPROVAL_CARD_SLOT_LABELS,
  APPROVAL_CARD_WIDGET_HTML,
  MCP_RESUME_MARKER,
  WorkBuddyRenderer,
  auditApprovalCardHtml,
  auditApprovalCardTemplate,
  buildResumeInstruction,
  fillApprovalCard,
  isTextFallbackReason,
  needsTextFallback,
  tryNormalizeApprovalCard,
} from '@winvm/adapter-host-workbuddy';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8');

/**
 * MCP 续跑标记：测试内同样**禁止**以完整字面量书写（与 approval-card.ts 同规矩，
 * 使 `grep -c` 对本仓「卡片渲染层 + 本测试」恒为 0）。拼接构造。
 */
const MCP_MARKER = '__appr' + 'ovalId';
assert.equal(MCP_MARKER, MCP_RESUME_MARKER, '测试内构造的标记必须与模块常量一致');

/* ============================ 夹具与取槽位助手 ============================ */

/** 最小可出卡输入（L2 卸载，字段齐全，形态 = a2a.delegate 的 structuredContent） */
function fullApproval(overrides = {}) {
  return {
    taskId: 'task_01J8QX',
    approval: {
      approvalId: 'apr_8f3c',
      risk: 'L2',
      capabilityId: 'app.winget.uninstall',
      summary: '卸载企业微信',
      impact: ['企业微信 (Tencent.WeCom) 将被卸载', '安装目录 C:/Program Files (x86)/WXWork 将被删除'],
      preview: { id: 'Tencent.WeCom', dryRun: false },
      underlying: {
        capabilityId: 'app.winget.uninstall',
        paramsSummary: 'id=Tencent.WeCom',
        goalText: '卸载企业微信',
      },
      resumeHint:
        '（A2A 续跑）放行：a2a.approval.reply { taskId: "task_01J8QX", approvalId: "apr_8f3c", approved: true }',
    },
    ...overrides,
  };
}

function withApproval(mutations) {
  const base = fullApproval();
  return { ...base, approval: { ...base.approval, ...mutations } };
}

/** 取「槽位行」内层原文（含 `<li>` 等子结构，用于结构断言） */
function slotValue(html, label) {
  const re = new RegExp(
    `<div class="wac-row[^"]*"><span class="wac-k">${label}</span><span class="wac-v">([\\s\\S]*?)</span></div>`,
  );
  const m = re.exec(html);
  assert.ok(m, `卡片必须含「${label}」槽位行`);
  return m[1];
}

/** 取「槽位行」纯文本（去标签 + 反转义，用于值断言） */
function slotText(html, label) {
  return slotValue(html, label)
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

/* ==========================================================================
 * ① 行为基线 —— 七槽位映射（§A3.3）
 * ======================================================================== */

describe('R1-1 · 七槽位映射与填充', () => {
  test('七槽位标签定义与 approval-card.md §4 行序一致；除「风险」外均渲染为 wac-k 行', () => {
    assert.deepEqual(
      [...APPROVAL_CARD_SLOT_LABELS],
      ['操作', '目标', '通道', '风险', '影响清单', '可逆性', '预览'],
      '七槽位定义漂移（须与模板 §4 表行序一致）',
    );
    const html = fillApprovalCard(fullApproval());
    assert.ok(html, '完整数据必须出卡');
    const rowLabels = [...html.matchAll(/<span class="wac-k">([^<]+)<\/span>/g)].map((m) => m[1]);
    for (const label of APPROVAL_CARD_SLOT_LABELS) {
      if (label === '风险') continue; // 风险以徽标呈现
      assert.ok(rowLabels.includes(label), `缺少七槽位之一：${label}`);
    }
    assert.match(html, /L2 破坏性/, '风险槽位必须以徽标呈现等级');
  });

  test('操作槽位：underlying.capabilityId 优先于 approval.capabilityId（真实意图）', () => {
    const html = fillApprovalCard(
      withApproval({ capabilityId: 'a2a.delegate', underlying: { capabilityId: 'app.winget.uninstall' } }),
    );
    assert.equal(slotText(html, '操作'), 'app.winget.uninstall');

    const fallback = fillApprovalCard(withApproval({ underlying: undefined }));
    assert.equal(slotText(fallback, '操作'), 'app.winget.uninstall', '无 underlying 时退回 capabilityId');
  });

  test('操作缺失 → §5 固定串「操作：<未提供>（请勿确认）」，不得猜测', () => {
    const html = fillApprovalCard(withApproval({ capabilityId: undefined, underlying: undefined }));
    assert.equal(slotText(html, '操作'), APPROVAL_CARD_FALLBACK_TEXTS.operation);
    assert.ok(html.includes('请勿确认'), '缺失操作的卡片必须劝退确认');
  });

  test('目标槽位四级派生：paramsSummary → goalText → preview(.params) → §5 固定串', () => {
    assert.equal(slotText(fillApprovalCard(fullApproval()), '目标'), 'id=Tencent.WeCom');
    assert.equal(
      slotText(fillApprovalCard(withApproval({ underlying: { goalText: '把企业微信卸掉' } })), '目标'),
      '把企业微信卸掉',
    );
    assert.equal(
      slotText(
        fillApprovalCard(withApproval({ underlying: undefined, preview: { params: { path: 'D:\\tmp\\old' } } })),
        '目标',
      ),
      'D:\\tmp\\old',
      'preview.params 内的路径字段优先',
    );
    assert.equal(
      slotText(fillApprovalCard(withApproval({ underlying: undefined, preview: { unrelated: 1 } })), '目标'),
      APPROVAL_CARD_FALLBACK_TEXTS.target,
    );
  });

  test('通道槽位固定「A2A 委派 · <taskId>」（MCP 直调不进本卡）', () => {
    const html = fillApprovalCard(fullApproval());
    assert.equal(slotText(html, '通道'), `${APPROVAL_CARD_CHANNEL_PREFIX} · task_01J8QX`);
  });

  test('影响清单：VM 下发则逐项 <li> 透传；空/缺失按 §5 标注「按参数推断」，绝不留空', () => {
    const html = fillApprovalCard(fullApproval());
    const impact = slotValue(html, '影响清单');
    assert.match(impact, /<ol class="wac-impact">/, '影响清单必须是有序列表');
    assert.equal([...impact.matchAll(/<li>/g)].length, 2, '两项影响必须逐项呈现');

    const empty = fillApprovalCard(withApproval({ impact: [] }));
    assert.ok(
      slotText(empty, '影响清单').includes('按参数推断'),
      `空清单必须走 §5 推断串并保留标注：${slotText(empty, '影响清单')}`,
    );

    const noInference = fillApprovalCard({
      taskId: 'task_01J8QX',
      approval: { approvalId: 'apr_8f3c', risk: 'L2', impact: [], underlying: undefined, summary: undefined, resumeHint: 'a2a.approval.reply' },
    });
    assert.equal(slotText(noInference, '影响清单'), APPROVAL_CARD_FALLBACK_TEXTS.impact, '无推断材料时用 §5 原串');
  });

  test('预览槽位：preview 摘要；缺失走 §5「预览：未提供」，绝不编造', () => {
    assert.match(slotText(fillApprovalCard(fullApproval()), '预览'), /id=Tencent\.WeCom/);
    const missing = fillApprovalCard(
      withApproval({ preview: undefined, summary: undefined, message: undefined }),
    );
    assert.equal(slotText(missing, '预览'), APPROVAL_CARD_FALLBACK_TEXTS.preview);
  });

  test('审批 ID 与续跑指令为必含展示项（§A3.3 / U5）', () => {
    const html = fillApprovalCard(fullApproval());
    assert.equal(slotText(html, '审批ID'), 'apr_8f3c');
    const instruction = slotText(html, '续跑指令');
    assert.ok(instruction.includes(APPROVAL_CARD_REPLY_TOOL), '续跑指令必须是 a2a.approval.reply');
    assert.ok(instruction.includes('apr_8f3c'), '指令必须带真实 approvalId');
    assert.ok(instruction.includes('task_01J8QX'), '指令必须带 taskId');
  });

  test('真实目标行：有 underlying 才出现，缺省整行省略（§A3.3 末行）', () => {
    assert.match(fillApprovalCard(fullApproval()), /<span class="wac-k">真实目标<\/span>/);
    const without = fillApprovalCard(withApproval({ underlying: undefined }));
    assert.ok(!without.includes('真实目标'), '无 underlying 时整行必须省略');
  });

  test('动态值一律 HTML 转义（防结构注入）', () => {
    const html = fillApprovalCard(
      withApproval({
        impact: ['<script>alert(1)</script>'],
        preview: { note: '<img src=x onerror=alert(1)>' },
      }),
    );
    assert.ok(!html.includes('<script>alert(1)</script>'), '影响清单必须转义');
    assert.ok(!html.includes('<img src=x'), 'preview 必须转义');
    assert.deepEqual([...auditApprovalCardHtml(html)], []);
  });

  test('R1-c：凭据类字段永不进卡片任何槽位', () => {
    const html = fillApprovalCard(
      withApproval({
        preview: {
          username: 'vmuser',
          password: 'Sup3rSecret!',
          params: { passphrase: 'p@ss', privateKey: '-----BEGIN', port: 22 },
        },
      }),
    );
    assert.ok(!html.includes('Sup3rSecret!'), 'password 值不得出现');
    assert.ok(!html.includes('p@ss'), 'passphrase 值不得出现');
    assert.ok(!html.includes('-----BEGIN'), 'privateKey 值不得出现');
    assert.match(html, /password=\[已脱敏\]/, '凭据键必须以「已脱敏」占位，不得静默丢失语义');
  });
});

/* ==========================================================================
 * ① 行为基线 —— §6 可逆性判定（呈现层职责）
 * ======================================================================== */

describe('R1-2 · 可逆性判定（approval-card.md §6）', () => {
  const reversibilityOf = (input) => slotText(fillApprovalCard(input), '可逆性');

  test('L3 一律「不可逆 —— 无法自动回滚」（优先级最高，压过删除族默认）', () => {
    assert.equal(
      reversibilityOf(withApproval({ risk: 'L3', capabilityId: 'storage.file.delete' })),
      APPROVAL_CARD_REVERSIBILITY_TEXTS.irreversibleL3,
    );
  });

  test('permanent === true → 「不可逆」；判定必须与参数一致（§8 红线 4）', () => {
    assert.equal(
      reversibilityOf(withApproval({ capabilityId: 'storage.file.delete', preview: { params: { permanent: true } } })),
      APPROVAL_CARD_REVERSIBILITY_TEXTS.irreversiblePermanent,
    );
    assert.equal(
      reversibilityOf(withApproval({ capabilityId: 'storage.file.delete', preview: { permanent: true } })),
      APPROVAL_CARD_REVERSIBILITY_TEXTS.irreversiblePermanent,
      '顶层 permanent 同样生效',
    );
  });

  test('删除族默认「可逆 —— 默认进回收站，可从回收站还原」', () => {
    // 注意：操作槽位由 underlying.capabilityId 优先决定，此处必须一并给出删除族 ID，
    // 否则「未知」判定来自真实意图本身，测不到删除族默认分支。
    assert.equal(
      reversibilityOf(
        withApproval({
          capabilityId: 'storage.file.delete',
          underlying: { capabilityId: 'storage.file.delete', paramsSummary: 'path=D:\\tmp\\a.log' },
        }),
      ),
      APPROVAL_CARD_REVERSIBILITY_TEXTS.reversibleByDefault,
    );
    assert.equal(
      reversibilityOf(withApproval({ capabilityId: 'storage.dir.remove', underlying: undefined })),
      APPROVAL_CARD_REVERSIBILITY_TEXTS.reversibleByDefault,
      'remove 动词族同样默认走回收站',
    );
  });

  test('均不匹配 → 「未知 —— 按不可逆处理」', () => {
    assert.equal(
      reversibilityOf(fullApproval()),
      APPROVAL_CARD_REVERSIBILITY_TEXTS.unknown,
    );
  });

  test('判定输入用 underlying.capabilityId（真实意图决定族）', () => {
    assert.equal(
      reversibilityOf(withApproval({ capabilityId: 'a2a.delegate', underlying: { capabilityId: 'storage.file.delete' } })),
      APPROVAL_CARD_REVERSIBILITY_TEXTS.reversibleByDefault,
      '真实意图是删除族 → 默认回收站可逆',
    );
  });
});

/* ==========================================================================
 * ① 行为基线 —— 降级判定（不出卡的各分支）
 * ======================================================================== */

describe('R1-3 · 降级判定：任一硬前提缺失 → 不出卡（null / true）', () => {
  /** 取不出卡的原因码（可出卡则 null） */
  function reasonOf(input) {
    const r = tryNormalizeApprovalCard(input);
    return r.ok ? null : r.reason;
  }

  test('缺 approvalId → MISSING_APPROVAL_ID，不出卡（§4 末行 / §7「无从应答」）', () => {
    const input = { taskId: 't', approval: { risk: 'L2', capabilityId: 'app.winget.uninstall' } };
    assert.equal(reasonOf(input), 'MISSING_APPROVAL_ID');
    assert.equal(fillApprovalCard(input), null);
    assert.equal(needsTextFallback(input), true);
  });

  test('缺 risk → MISSING_RISK，不出卡（§4「无 => 不出卡片，明确报错」，绝不猜测）', () => {
    const input = { taskId: 't', approval: { approvalId: 'a', capabilityId: 'x' } };
    assert.equal(reasonOf(input), 'MISSING_RISK');
    assert.equal(needsTextFallback(input), true);
  });

  test('risk 下发为空串 / 未下发 → MISSING_RISK（「缺失」与「非法」是两回事，§4）', () => {
    assert.equal(reasonOf(withApproval({ risk: '' })), 'MISSING_RISK', '下发空串 = 缺失');
    assert.equal(reasonOf(withApproval({ risk: '   ' })), 'MISSING_RISK', '纯空白 = 缺失');
    assert.equal(
      reasonOf({ taskId: 't', approval: { approvalId: 'a', impact: [] } }),
      'MISSING_RISK',
      '未下发 risk 字段 = 缺失',
    );
  });

  test('risk 为畸形值（非封闭字面值 / 非字符串）→ INVALID_RISK，明确报错不得当缺省', () => {
    assert.equal(reasonOf(withApproval({ risk: 'L9' })), 'INVALID_RISK');
    assert.equal(reasonOf(withApproval({ risk: 2 })), 'INVALID_RISK');
    assert.equal(reasonOf(withApproval({ risk: 'high' })), 'INVALID_RISK');
  });

  test('既无 resumeHint 又无 taskId → NO_RESUME_PATH；任一存在即可出卡', () => {
    assert.equal(
      reasonOf({ approval: { approvalId: 'a', risk: 'L2', capabilityId: 'x' } }),
      'NO_RESUME_PATH',
    );
    assert.equal(
      needsTextFallback({ approval: { ...fullApproval().approval, resumeHint: undefined } }),
      true,
      'resumeHint 与 taskId 两样都缺 → 降级',
    );
    assert.equal(needsTextFallback(withApproval({ resumeHint: 'x' })), false, '无 taskId 但有 resumeHint → 出卡');
    assert.equal(needsTextFallback(withApproval({ resumeHint: undefined })), false, '无 resumeHint 但有 taskId → 出卡');
  });

  test('L0 / L1 → 不弹卡，且语义是「直接执行」而非「降级文本确认」（§7）', () => {
    for (const risk of ['L0', 'L1']) {
      const reason = reasonOf(withApproval({ risk }));
      assert.equal(reason, 'L0_L1_NO_CARD', `${risk} 不弹卡`);
      assert.equal(isTextFallbackReason(reason), false, `${risk} 不得被当成文本兜底`);
      assert.equal(fillApprovalCard(withApproval({ risk })), null);
    }
    for (const reason of ['MISSING_RISK', 'MISSING_APPROVAL_ID', 'NO_RESUME_PATH', 'INVALID_RISK', 'NO_INPUT']) {
      assert.equal(isTextFallbackReason(reason), true, `${reason} 必须走文本兜底`);
    }
  });

  test('空输入 / 非对象输入 → NO_INPUT，不抛异常', () => {
    for (const bad of [null, undefined, 'x', 42]) {
      assert.equal(fillApprovalCard(bad), null);
      assert.equal(needsTextFallback(bad), true);
    }
    assert.equal(reasonOf(null), 'NO_INPUT');
    assert.equal(reasonOf(undefined), 'NO_INPUT');
  });

  test('needsTextFallback 与 tryNormalize().ok 严格互斥（两口径不得漂移）', () => {
    const cases = [
      fullApproval(),
      withApproval({ resumeHint: undefined }),
      { approval: fullApproval().approval },
      withApproval({ risk: 'L1' }),
      { approval: { risk: 'L2', approvalId: '' } },
      null,
      undefined,
    ];
    for (const c of cases) {
      assert.equal(needsTextFallback(c), !tryNormalizeApprovalCard(c).ok, '降级判定两口径必须一致');
    }
  });

  test('平铺形态（ExtractedApproval 本体 + taskId）与嵌套形态产出同一张卡', () => {
    const nested = fillApprovalCard(fullApproval());
    const flat = fillApprovalCard({ taskId: 'task_01J8QX', ...fullApproval().approval });
    assert.equal(flat, nested);
  });

  test('degradedSlots 精确标记走了 §5 固定串的槽位（供宿主 agent 口头补说）', () => {
    const r = tryNormalizeApprovalCard({
      taskId: undefined,
      approval: {
        approvalId: 'apr_z',
        risk: 'L2',
        resumeHint: '放行：a2a.approval.reply { approvalId: "apr_z", approved: true }',
        preview: undefined,
        summary: undefined,
        message: undefined,
        impact: [],
      },
    });
    assert.equal(r.ok, true, '缺 taskId 但有 resumeHint 仍可出卡');
    assert.deepEqual(r.card.degradedSlots, ['操作', '目标', '影响清单', '可逆性', '预览']);
    assert.equal(r.card.risk, 'L2');
    assert.equal(r.card.requiresDoubleConfirm, false);
  });

  test('数据齐全（七槽位均有实数据）时 degradedSlots 为空（不无病呻吟）', () => {
    const r = tryNormalizeApprovalCard(
      withApproval({
        capabilityId: 'storage.file.delete',
        underlying: undefined,
        preview: { params: { path: 'D:\\old', count: 3 } },
        summary: '删除 3 个日志文件',
      }),
    );
    assert.equal(r.ok, true);
    assert.deepEqual([...r.card.degradedSlots], [], '满配不应有降级槽位');
  });

  test('可逆性只能判为「未知」时如实进 degradedSlots（§5 不允许假装可逆）', () => {
    const r = tryNormalizeApprovalCard(fullApproval());
    assert.equal(r.ok, true);
    assert.deepEqual([...r.card.degradedSlots], ['可逆性']);
  });
});

/* ==========================================================================
 * ① 行为基线 —— R1-a 通道隔离（红线）
 * ======================================================================== */

describe('R1-4 · R1-a 通道隔离：渲染产物与指令文本零 MCP 续跑标记', () => {
  test('多种输入组合的产物均零 MCP 标记，且自检通过', () => {
    const inputs = [
      fullApproval(),
      withApproval({ resumeHint: `以同一参数并附 ${MCP_MARKER}="apr_8f3c" 重新调用本工具` }),
      withApproval({ resumeHint: `混用：${MCP_MARKER} 与 ${APPROVAL_CARD_REPLY_TOOL}` }),
      withApproval({ resumeHint: undefined }),
      { approvalId: 'apr_9d21', risk: 'L3', taskId: 'task_7', summary: '关机' },
    ];
    for (const input of inputs) {
      const html = fillApprovalCard(input);
      assert.ok(html, '上述输入均应出卡');
      assert.ok(!html.includes(MCP_MARKER), `产物出现 MCP 续跑标记：${html.slice(0, 160)}`);
      assert.deepEqual([...auditApprovalCardHtml(html)], []);
    }
  });

  test('resumeHint 含 MCP 标记 → 弃用该 hint，换本地标准指令并标记 resumeHintSanitized', () => {
    const poisoned = `以同一参数并附 ${MCP_MARKER}="apr_8f3c" 重新调用本工具`;
    const r = tryNormalizeApprovalCard(withApproval({ resumeHint: poisoned }));
    assert.equal(r.ok, true);
    assert.equal(r.card.resumeHintSanitized, true, '脏 hint 必须被标记为已净化');
    assert.ok(!r.card.data.resumeInstruction.includes(MCP_MARKER), '指令文本必须零 MCP 标记');
    assert.match(r.card.data.resumeInstruction, new RegExp(`^${APPROVAL_CARD_REPLY_TOOL.replace(/\./g, '\\.')}`));
  });

  test('resumeHint 合法（纯 A2A）时原样采用，不做无谓改写', () => {
    const hint = fullApproval().approval.resumeHint;
    const r = tryNormalizeApprovalCard(fullApproval());
    assert.equal(r.ok && r.card.data.resumeInstruction, hint);
    assert.equal(r.ok && r.card.resumeHintSanitized, false, '合法 hint 不应被标记为已净化');
  });

  test('hint 不含 a2a.approval.reply（非 A2A 指令）→ 同样弃用', () => {
    const r = tryNormalizeApprovalCard(withApproval({ resumeHint: '请回复批准' }));
    assert.equal(r.ok, true);
    assert.match(r.card.data.resumeInstruction, new RegExp(APPROVAL_CARD_REPLY_TOOL.replace(/\./g, '\\.')));
    assert.equal(r.card.resumeHintSanitized, true);
  });

  test('唯一续跑指令形态：a2a.approval.reply { taskId, approvalId, approved }', () => {
    assert.equal(
      buildResumeInstruction('apr_8f3c', 'task_01J8QX'),
      'a2a.approval.reply { taskId: "task_01J8QX", approvalId: "apr_8f3c", approved: true }',
    );
    assert.equal(
      buildResumeInstruction('apr_8f3c', ''),
      'a2a.approval.reply { approvalId: "apr_8f3c", approved: true }',
      '无 taskId 时省略该字段（与宿主桥 buildA2aResumeHint 两形态一致）',
    );
    assert.ok(!buildResumeInstruction('apr_8f3c', 't1').includes(MCP_MARKER));
  });

  test('approvalId / taskId 含 HTML 特殊字符时，指令文本仍安全且零 MCP 标记', () => {
    const html = fillApprovalCard({
      approvalId: 'apr"><script>x</script',
      risk: 'L2',
      taskId: 'task/&"q',
    });
    assert.ok(html);
    assert.ok(!html.includes('<script>x</script'), 'id 必须转义');
    assert.ok(!html.includes(MCP_MARKER));
  });
});

/* ==========================================================================
 * ① 行为基线 —— L3 二次确认 + 只展示不放行（R1-b）
 * ======================================================================== */

describe('R1-5 · L3 二次确认与「只展示不放行」', () => {
  test('L3 卡片必须出现二次确认要求与「好的/可以/继续不被接受」（模板 §2）', () => {
    const html = fillApprovalCard(
      withApproval({ risk: 'L3', capabilityId: 'system.power.control', underlying: undefined }),
    );
    assert.match(html, /二次确认/, 'L3 必须有二次确认行');
    assert.match(html, /好的\s*\/\s*可以\s*\/\s*继续/, '必须写明非确认短句不被接受');
    assert.match(html, /L3 关键高危/, '徽标必须体现 L3');
    assert.match(html, /高危操作，需要二次确认/, '标题必须换成 L3 版');
    assert.match(html, /不可逆/, '§6：L3 一律不可逆');
    const r = tryNormalizeApprovalCard(withApproval({ risk: 'L3' }));
    assert.equal(r.ok && r.card.requiresDoubleConfirm, true);
  });

  test('L2 卡片不出现二次确认行（不误升级门禁强度）', () => {
    const html = fillApprovalCard(fullApproval());
    assert.ok(!html.includes('二次确认'), 'L2 不得出现二次确认文案');
    assert.match(html, /需要你确认（破坏性操作）/, 'L2 用 §1 版标题');
  });

  test('卡片只展示不放行：零可执行回调面 + 明示「点击不会执行任何操作」', () => {
    const html = fillApprovalCard(fullApproval());
    for (const banned of ['sendPrompt(', 'fetch(', 'XMLHttpRequest', 'postMessage(', 'window.external', 'eval(', 'import(']) {
      assert.ok(!html.includes(banned), `卡片出现可执行回调面：${banned}`);
    }
    assert.match(html, /只展示，不放行|不会执行任何操作/, '必须有「不放行」声明');
    assert.match(html, /唯一的放行依据/, '必须声明权威收口在 AskUserQuestion');
    assert.deepEqual([...auditApprovalCardHtml(html)], []);
  });

  test('按钮只做视觉反馈：无 onclick 内联直调、无 form/action', () => {
    const html = fillApprovalCard(fullApproval());
    assert.ok(!/onclick\s*=/.test(html), '按钮不得内联直调');
    assert.ok(!/<form/.test(html), '不得有表单提交面');
    assert.equal([...html.matchAll(/data-wac-choice="(\w+)"/g)].length, 2, '批准/拒绝两个按钮');
  });
});

/* ==========================================================================
 * ② 模板结构基线
 * ======================================================================== */

describe('R1-6 · 模板结构不变量', () => {
  test('模板自检通过（占位符全接线、零 MCP 标记、零回调面、含续跑指令槽位）', () => {
    assert.deepEqual([...auditApprovalCardTemplate()], []);
  });

  test('模板为自包含片段：无 DOCTYPE/html/head/body、无外部资源', () => {
    for (const forbidden of ['<!DOCTYPE', '<html', '<head>', '<body>', 'http://', 'https://', '<link', 'src=']) {
      assert.ok(!APPROVAL_CARD_WIDGET_HTML.includes(forbidden), `模板含不允许的片段：${forbidden}`);
    }
  });

  test('暗色主题友好：配色全部走宿主 CSS 变量，零硬编码色值', () => {
    const style = /<style>([\s\S]*?)<\/style>/.exec(APPROVAL_CARD_WIDGET_HTML)[1];
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(style), '出现硬编码色值，暗色主题下会失控');
    assert.ok(!/rgba?\(/.test(style), '出现 rgb 硬编码色');
    assert.match(style, /var\(--color-background-primary\)/);
    assert.match(style, /var\(--color-text-primary\)/);
    assert.match(style, /var\(--border-radius-lg\)/);
    assert.match(style, /var\(--color-border-tertiary\)/);
  });

  test('模板占位符集合与替换表严格一致（双向锁死，防产物残留 {{X}}）', () => {
    const found = [...new Set(APPROVAL_CARD_WIDGET_HTML.match(/\{\{[A-Z_]+\}\}/g) ?? [])].sort();
    for (const token of [
      '{{ROOT_ID}}', '{{HEAD_TITLE}}', '{{RISK_BADGE}}', '{{RISK_TONE}}', '{{SLOT_OPERATION}}',
      '{{SLOT_TARGET}}', '{{SLOT_CHANNEL}}', '{{SLOT_IMPACT}}', '{{SLOT_REVERSIBILITY}}', '{{SLOT_PREVIEW}}',
      '{{APPROVAL_ID}}', '{{RESUME_INSTRUCTION}}', '{{ROW_UNDERLYING_GOAL}}', '{{ROW_DOUBLE_CONFIRM}}',
    ]) {
      assert.ok(found.includes(token), `模板缺少占位符 ${token}`);
    }
    assert.ok(!/\{\{[A-Z_]+\}\}/.test(fillApprovalCard(fullApproval())), '产物零残留占位符');
  });

  test('七槽位标签常量与模板 wac-k 行一致（模板增删槽位必须同步常量）', () => {
    const templateLabels = [...APPROVAL_CARD_WIDGET_HTML.matchAll(/<span class="wac-k">([^<]+)<\/span>/g)]
      .map((m) => m[1]);
    for (const label of APPROVAL_CARD_SLOT_LABELS) {
      if (label === '风险') continue;
      assert.ok(templateLabels.includes(label), `模板缺少槽位行：${label}`);
    }
  });

  test('MCP_RESUME_MARKER 由拼接构造：approval-card.ts 源码零该字面量', () => {
    const src = read('packages', 'adapter-host-workbuddy', 'src', 'approval-card.ts');
    assert.ok(!src.includes(MCP_MARKER), 'approval-card.ts 源码中不得出现完整 MCP 续跑标记字面量');
    assert.ok(
      src.includes("'__' + 'approval' + 'Id'"),
      '标记必须以拼接构造（避免本仓产物出现完整字面量）',
    );
    assert.equal(MCP_RESUME_MARKER, MCP_MARKER);
  });

  test('auditApprovalCardHtml 能抓出人为破坏（正向自检有效性）', () => {
    assert.ok(auditApprovalCardHtml('').length > 0, '空串必须报错');
    const broken = fillApprovalCard(fullApproval()).replace('a2a.approval.reply', 'whatever');
    assert.ok(auditApprovalCardHtml(broken).some((p) => p.includes('A2A 续跑指令')));
    const leaked = fillApprovalCard(fullApproval()) + ` ${MCP_MARKER}`;
    assert.ok(auditApprovalCardHtml(leaked).some((p) => p.includes('R1-a')));
    const residue = APPROVAL_CARD_WIDGET_HTML;
    assert.ok(auditApprovalCardHtml(residue).some((p) => p.includes('占位符未填充')));
  });
});

/* ==========================================================================
 * ③ L2 Renderer 产物守卫（plan / validate）
 * ======================================================================== */

describe('R1-7 · plan() 注入与 validate() 红线', () => {
  const ADAPTER_SRC = read('packages', 'adapter-host-workbuddy', 'src', 'index.ts');

  test('index.ts 导出 approval-card 模块（宿主侧可直接取模板与填充函数）', () => {
    assert.match(ADAPTER_SRC, /export \* from '\.\/approval-card\.js';/);
  });

  test('plan() 只把卡片模板注入总控 skill 的 references', () => {
    assert.match(ADAPTER_SRC, /if \(skill\.id === APPROVAL_CARD_SKILL_ID\) \{/);
    assert.match(ADAPTER_SRC, /'references', APPROVAL_CARD_REFERENCE_PATH/);
    assert.match(ADAPTER_SRC, /content: APPROVAL_CARD_WIDGET_HTML,/);
    assert.equal(APPROVAL_CARD_SKILL_ID, 'winvm-orchestrator');
    assert.equal(APPROVAL_CARD_REFERENCE_PATH, 'approval-card-widget.html');
  });

  test('validate() 含模板自检与产物 R1-a 红线，且定级 error（阻断安装）', () => {
    assert.match(ADAPTER_SRC, /auditApprovalCardTemplate\(\)/);
    assert.match(ADAPTER_SRC, /includes\(MCP_RESUME_MARKER\)/);
    const idx = ADAPTER_SRC.indexOf('审批卡产物违反 R1-a');
    assert.ok(idx > 0, 'validate 必须含 R1-a 违规文案');
    assert.ok(ADAPTER_SRC.slice(idx - 260, idx).includes("level: 'error'"), '违规必须定级 error');
  });

  test('实测 plan()：注入唯一一份卡片 reference；保留名源副本被忽略；validate 通过', () => {
    const renderer = new WorkBuddyRenderer();
    const ctx = { homeDir: '/tmp/home', hostRoot: '/tmp/home/.workbuddy', dryRun: true };
    const plan = renderer.plan(makePlugin(), ctx);

    const cardFiles = plan.files.filter((f) => f.path.endsWith(APPROVAL_CARD_REFERENCE_PATH));
    assert.equal(cardFiles.length, 1, '必须且只能注入一份卡片模板（保留名去重生效）');
    assert.match(cardFiles[0].path, /winvm-orchestrator\/references\/approval-card-widget\.html$/);
    assert.equal(cardFiles[0].content, APPROVAL_CARD_WIDGET_HTML, '注入内容必须是代码态模板，不是源副本');
    assert.ok(!cardFiles[0].content.includes(MCP_MARKER), '注入产物零 MCP 标记');

    // 文本模板 reference 与 widget 模板并存，互不覆盖
    const textTpl = plan.files.find((f) => f.path.endsWith('references/approval-card.md'));
    assert.ok(textTpl, '文本模板 reference 必须保留');
    assert.equal(textTpl.content, '# 文本模板 v1.1');

    // 被忽略的源副本必须留 warning（不可静默丢弃）
    assert.ok(
      plan.warnings.some((w) => w.includes(APPROVAL_CARD_REFERENCE_PATH) && w.includes('已忽略')),
      `保留名冲突必须告警：${JSON.stringify(plan.warnings)}`,
    );

    // 非总控 skill 不得被注入卡片
    assert.ok(
      !plan.files.some((f) => f.path.includes('winvm-system-admin') && f.path.endsWith(APPROVAL_CARD_REFERENCE_PATH)),
      '其它 skill 不得复制卡片模板（唯一性红线）',
    );

    const report = renderer.validate(plan);
    assert.equal(report.ok, true, `validate 必须通过：${JSON.stringify(report.issues)}`);
  });

  test('实测 validate()：卡片产物被塞入 MCP 标记时报 error（红线可执行，非纸面）', () => {
    const renderer = new WorkBuddyRenderer();
    const poisonedPlan = {
      hostId: 'workbuddy',
      files: [
        {
          path: '/tmp/home/.workbuddy/connectors/skills/connector-winvm/winvm-orchestrator/SKILL.md',
          content: '---\nid: x\n---\n正文',
          mode: 'overwrite',
        },
        {
          path: `/x/winvm-orchestrator/references/${APPROVAL_CARD_REFERENCE_PATH}`,
          content: `点击后请附 ${MCP_MARKER} 重试`,
          mode: 'overwrite',
        },
      ],
      jsonPatches: [],
      postActions: [],
      warnings: [],
    };
    const report = renderer.validate(poisonedPlan);
    assert.equal(report.ok, false, '含 MCP 标记的卡片产物必须阻断安装');
    assert.ok(
      report.issues.some((i) => i.level === 'error' && i.message.includes('R1-a')),
      JSON.stringify(report.issues),
    );
  });

  test('实测 validate()：模板与文本模板并存不误报（文本模板含 MCP 标记是合法的）', () => {
    const renderer = new WorkBuddyRenderer();
    const plan = renderer.plan(makePlugin(), { homeDir: '/tmp/home', hostRoot: '/tmp/home/.workbuddy', dryRun: true });
    const mdFile = plan.files.find((f) => f.path.endsWith('references/approval-card.md'));
    // 文本模板里出现 MCP 标记属于 §9 合法内容，validate 不得因此报错（红线只针对卡片产物）
    const withMarker = {
      ...plan,
      files: plan.files.map((f) =>
        f === mdFile ? { ...f, content: `附 ${MCP_MARKER} 重试` } : f,
      ),
    };
    const report = renderer.validate(withMarker);
    assert.equal(report.ok, true, `文本模板含 MCP 标记不应报错：${JSON.stringify(report.issues)}`);
  });
});

/** R1-7 夹具：中性插件（含总控 skill + 一个普通 skill；references 故意同时给保留名副本） */
function makePlugin() {
  return {
    manifest: { name: 'winvm-bridge', version: '0.1.0', description: 'd', author: { name: 'a' }, keywords: [] },
    skills: [
      {
        id: 'winvm-orchestrator',
        name: 'n',
        description: 'd',
        body: '---\nid: x\nname: n\ndescription: d\n---\n\n正文',
        entry: true,
        references: {
          'approval-card.md': '# 文本模板 v1.1',
          // 保留名：skill 源里不该有，若有也必须被代码态模板覆盖并告警
          [APPROVAL_CARD_REFERENCE_PATH]: `手工漂移副本 ${MCP_MARKER}`,
        },
      },
      {
        id: 'winvm-system-admin',
        name: 'n',
        description: 'd',
        body: '---\nid: y\nname: n\ndescription: d\n---\n\n正文',
        references: { [APPROVAL_CARD_REFERENCE_PATH]: '不该出现在非总控 skill' },
      },
    ],
    connector: {
      id: 'winvm',
      displayName: 'W',
      transports: [{ kind: 'stdio', command: 'node', args: ['server.js'] }],
      disabledTools: [],
      timeoutMs: 30000,
    },
  };
}

/* ==========================================================================
 * ③ 静态守卫 —— 全仓「A2A 卡片渲染层」零 MCP 标记
 * ======================================================================== */

describe('R1-8 · 通道隔离的全仓静态守卫', () => {
  test('adapter-host-workbuddy 全部源码零 MCP 续跑标记字面量', () => {
    for (const rel of [
      ['packages', 'adapter-host-workbuddy', 'src', 'approval-card.ts'],
      ['packages', 'adapter-host-workbuddy', 'src', 'index.ts'],
    ]) {
      const src = read(...rel);
      assert.ok(!src.includes(MCP_MARKER), `${rel.join('/')} 出现完整标记字面量`);
    }
  });

  test('编译产物 dist 中的模板与填充逻辑同样零标记（真实产物校验）', () => {
    const dist = read('packages', 'adapter-host-workbuddy', 'dist', 'approval-card.js');
    assert.ok(!dist.includes(MCP_MARKER), 'dist 产物不得出现完整标记（注入 skill 的就是它）');
    assert.ok(dist.includes(APPROVAL_CARD_REPLY_TOOL), 'dist 必须含 A2A 续跑指令工具名');
  });

  test('文本模板 approval-card.md 仍保留 MCP 通道续跑说明（§9 未被误删）', () => {
    const md = read('skills', 'winvm-orchestrator', 'references', 'approval-card.md');
    assert.ok(md.includes(MCP_MARKER), '文本模板必须含 MCP 直调续跑说明（那是 §9 的合法内容）');
    assert.ok(md.includes(APPROVAL_CARD_REPLY_TOOL), '文本模板必须含 A2A 续跑指令');
  });
});

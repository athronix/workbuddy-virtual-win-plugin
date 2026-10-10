/**
 * Phase 2 · P2-T10 · K3-C4：文本兜底 `reconcileApprovalWait` 的**直接**单测
 *
 * ## 补的是哪个洞
 *
 * 设计 §4.3：全仓五个文件（`r19c-kn1-a-pure` / `r19c-kn1-b-bridge` /
 * `r19c-k3r-approval-truth` / `r19c-k3r-bridge-integ` /
 * `cl-k3r-runpersistent-approval-routing`）都引用 `reconcileApprovalWait`，但它
 * 是 `bridge.ts` 的**包内私有函数**（`src/index.ts` 零命中）⇒ 所有引用都是
 * **间接触达**（经桥路径或 `deps` 注入）。于是「**兜底本身在哪些措辞下改判、
 * 哪些措辞下漏判**」从来没有直接单测 —— 一旦措辞集合被改（关键词增删），
 * 没有任何一条用例能指出「哪些文本的判定变了」。
 *
 * ## 四条验收判据（设计 §4.3 原文编号）
 *
 *   a. 命中关键词集合**逐条**改判；
 *   b. 同义改写**不命中**的反例集（诚实承认这是关键词启发式，不是语义理解）；
 *   c. `base.ok === false` 时的形状（本函数自身**没有** ok 门 —— 门 0 在
 *      `reconcileApprovalTruth` 侧；故本函数对失败态 base 仍会改判，
 *      但生产门序保证它拿不到失败态 base，见 d）；
 *   d. 与 `reconcileApprovalTruth` 的**门序交互**：结构化命中时兜底不得再跑。
 *
 * ## 纪律
 *
 * 经 `tests/helpers/bridge-internals.mjs` 直连 `dist/bridge.js` 取包内导出
 * （O-3 范式：**不为测试扩公共导出面**）。跑前先
 * `./node_modules/.bin/tsc -b tsconfig.build.json`。
 *
 * 运行（逐文件，绝不整批 glob）：
 *   node --test tests/unit/phase2-approval-wait-fallback.test.js
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { loadBridgeInternals, repoPath } from '../helpers/bridge-internals.mjs';

/* ============================ 夹具 ============================ */

/** 最小 `LlmGoalResult`（成功态 = 桥收口时交给兜底的形状） */
function okBase(over = {}) {
  return {
    ok: true,
    summary: '已完成目标',
    artifacts: [],
    steps: [{ index: 0, capabilityId: 'app.winget.install', params: {}, ok: true, risk: 'L2', durationMs: 1, traceId: 'tr', summary: '安装' }],
    ...over,
  };
}

const { reconcileApprovalWait } = await loadBridgeInternals();

/* ============================ a 命中集合逐条 ============================ */

describe('K3-C4 判据 a：命中关键词集合逐条改判', () => {
  const samples = [
    { name: 'APPROVAL_REQUIRED 原样回显', text: 'MCP 工具返回 APPROVAL_REQUIRED，我已停止操作' },
    { name: '等待审批（中文直说）', text: '该操作需要人工审批，正在等待审批' },
    { name: 'APPROVAL_REQUIRED + approvalId', text: '被拦截：APPROVAL_REQUIRED approvalId=apr_abc123 capabilityId="app.winget.install" risk=L2' },
    { name: '等待审批出现在句尾', text: '我先停下来了，等待审批' },
    { name: 'APPROVAL_REQUIRED 在代码块内', text: '```json\n{"error":"APPROVAL_REQUIRED"}\n```' },
  ];

  for (const s of samples) {
    test(`改判：${s.name}`, () => {
      const r = reconcileApprovalWait(okBase(), s.text);
      assert.equal(r.ok, false, '★ 命中即不得断言成功（结构性假成功）');
      assert.equal(r.error.code, 'APPROVAL_REQUIRED');
      assert.match(r.summary, /^等待审批：/);
      assert.ok(r.summary.includes('APPROVAL_REQUIRED'), 'summary 须带契约码，宿主可据此路由');
      assert.ok(!r.summary.includes('目标已完成'), '不得保留成功声称');
      // steps 全量如实化（ok=false + 统一文案），保留可证事实（不删步骤）
      assert.equal(r.steps.length, 1);
      assert.ok(r.steps.every((x) => x.ok === false));
      assert.equal(r.error.retryable, true, 'APPROVAL_REQUIRED 默认可重试（批了就能续跑）');
    });
  }

  test('产物保留（截图等中间产物对宿主人工审批有参考价值）', () => {
    const art = [{ kind: 'screenshot', name: 's.png', mime: 'image/png', data: 'AAAA', encoding: 'base64' }];
    const r = reconcileApprovalWait(okBase({ artifacts: art }), 'APPROVAL_REQUIRED');
    assert.deepEqual(r.artifacts, art);
  });

  test('approvalId / capabilityId / risk 结构化提取进 details', () => {
    const r = reconcileApprovalWait(
      okBase(),
      '拦截 APPROVAL_REQUIRED approvalId=apr_x1 capabilityId=storage.file.delete risk=L3',
    );
    assert.equal(r.error.details.approvalId, 'apr_x1');
    assert.equal(r.error.details.capabilityId, 'storage.file.delete');
    assert.equal(r.error.details.risk, 'L3');
    assert.match(r.summary, /approvalId=apr_x1/);
  });

  test('无 approvalId 时 details 缺席、risk 给安全默认 L2（不硬猜 ID）', () => {
    const r = reconcileApprovalWait(okBase(), '等待审批');
    assert.equal(r.error.details, undefined, '不得凭空造 details');
    assert.ok(!r.summary.includes('approvalId='));
  });

  test('关键词集合常量化后与历史字面量等价（行为零变化的机器证明）', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(repoPath('packages', 'adapter-agent-workbuddy-llm', 'src', 'bridge.ts'), 'utf8');
    const kw = /const APPROVAL_WAIT_KEYWORDS: readonly string\[\] = \[([\s\S]*?)\];/.exec(src);
    assert.ok(kw, '关键词集合须常量化（K3-C4）');
    const list = kw[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    assert.deepEqual(list, ['APPROVAL_REQUIRED', '等待审批'], '集合内容 = 旧正则字面量的两个分支，顺序一致');
    // 逐条：命中/不命中都按集合推导，证明 join('|') 构造与原字面量同判定
    for (const k of list) {
      assert.equal(reconcileApprovalWait(okBase(), `前缀 ${k} 后缀`).ok, false, `${k} 应命中`);
    }
    assert.ok(!/const APPROVAL_WAIT_PATTERN\s*=\s*\/APPROVAL_REQUIRED\|等待审批\/;/.test(src), '旧字面量应已被常量构造替代');
  });
});

/* ============================ b 同义改写不命中（诚实边界） ============================ */

describe('K3-C4 判据 b：同义改写不命中 —— 关键词启发式的边界（漏判由结构化反查承担）', () => {
  const misses = [
    '已提交审批申请，请人工确认后再继续',
    '需要用户授权，我停下来等回复',
    '权限不足，需管理员同意',
    '待批准：删除目录操作',
    'The tool call requires human authorization, so I stopped.',
    '审批单已创建，等待人工处理', // 有「审批」但无「等待审批」整词
  ];

  for (const text of misses) {
    test(`不改判：${text.slice(0, 24)}`, () => {
      const r = reconcileApprovalWait(okBase(), text);
      assert.equal(r.ok, true, '★ 本兜底是关键词集合，不命中即透传 —— 这是**已知边界**，不是缺陷');
      assert.equal(r.error, undefined);
    });
  }

  test('边界归因：漏判风险由 CL-K3R 服务端结构化反查（reconcileApprovalTruth）承担', async () => {
    // 结构性证明：兜底被注册为**第二道闸**（fallback），而非唯一判据。
    const fs = await import('node:fs');
    const dt = fs.readFileSync(repoPath('packages', 'adapter-agent-workbuddy-llm', 'src', 'delegation-truth.ts'), 'utf8');
    assert.match(dt, /deps\.reconcileApprovalWait \?\? approvalWaitFallback/, '兜底经注入取用（结构化判据在前）');
    assert.match(dt, /门 0.*不重复改判|已是失败态（含 D-1 两道门的结论）→ 绝不重复改判/, '门 0 注释在场（兜底不会二次改判失败态）');
  });
});

/* ============================ c 失败态 base 的形状 ============================ */

describe('K3-C4 判据 c：base.ok===false 时的形状（本函数无 ok 门，门序在 reconcileApprovalTruth 侧）', () => {
  test('文本未命中 + base 已失败 ⇒ 原样透传（不重复改判、不改 error）', () => {
    const base = okBase({ ok: false, summary: '执行失败', error: { code: 'EXECUTION_FAILED', message: 'x', retryable: false } });
    const r = reconcileApprovalWait(base, '真执行失败，无审批信号');
    assert.equal(r, base, '未命中 ⇒ 恒等透传（同一对象引用，零改写）');
    assert.equal(r.error.code, 'EXECUTION_FAILED');
  });

  test('文本命中 + base 已失败 ⇒ 本函数**确实**会改判（如实登记：ok 门不在此处）', () => {
    const base = okBase({ ok: false, summary: '执行失败', error: { code: 'EXECUTION_FAILED', message: 'x', retryable: false } });
    const r = reconcileApprovalWait(base, 'APPROVAL_REQUIRED');
    assert.equal(r.error.code, 'APPROVAL_REQUIRED', '若单独调用本函数，失败态会被覆写为审批态');
    // 生产之所以安全，靠的是调用点门序（门 0 先透传 + 收口点只在 ok=true 后走兜底）——
    // 见 d 组。本例钉的是「函数自身无 ok 门」这一事实，防止后来者误以为可单独复用。
  });

  test('SK-9 落点：判定逻辑与文案未随常量化漂移（关键文案逐字钉）', () => {
    const r = reconcileApprovalWait(okBase(), 'APPROVAL_REQUIRED approvalId=apr_1');
    assert.equal(r.error.message, 'LLM 上报等待宿主人工审批，操作未执行');
    assert.match(r.summary, /须经宿主人工审批后经 MCP 直调通道续跑/);
    assert.match(r.steps[0].summary, /^等待审批（未执行完成）$/);
  });
});

/* ============================ d 与结构化判据的门序交互 ============================ */

describe('K3-C4 判据 d：与 reconcileApprovalTruth 的门序交互（结构化命中时兜底不得再跑）', () => {
  /** 取包内 delegation-truth（同 helper 范式；用于验门序而非重复 r19c-k3r-* 的真值表） */
  async function loadTruth() {
    const { pathToFileURL } = await import('node:url');
    const p = repoPath('packages', 'adapter-agent-workbuddy-llm', 'dist', 'delegation-truth.js');
    return import(pathToFileURL(p).href);
  }

  test('D1 门 0：base.ok=false ⇒ 透传，兜底零调用', async () => {
    const { reconcileApprovalTruth } = await loadTruth();
    let fallbackCalls = 0;
    const base = okBase({ ok: false, error: { code: 'EXECUTION_FAILED', message: 'x', retryable: false } });
    const out = await reconcileApprovalTruth(base, 'APPROVAL_REQUIRED', {
      reconcileApprovalWait: (b) => {
        fallbackCalls += 1;
        return b;
      },
      input: { taskId: 'task_d1', traceId: 'tr_d1', startedAtMs: Date.now() },
    });
    assert.equal(out, base);
    assert.equal(fallbackCalls, 0, '★ 已是失败态绝不再跑兜底（否则判据 c-2 的覆写风险会成真）');
  });

  /**
   * 最小 `deps`（探针/归属键形状与 `r19c-k3r-approval-truth.test.js` 对齐：
   * `probe.approvalWait()` **直接返回 facts 数组**，不是 `{facts}` 包对象）。
   */
  function truthDeps(over = {}) {
    const facts = over.facts ?? [
      { approvalId: 'apr_server_1', capabilityId: 'storage.file.delete', risk: 'L3', createdAtMs: Date.now(), attribution: 'window', hostApproved: false },
    ];
    const probe = over.probe ?? { approvalWait: async () => facts };
    const noProbe = over.noProbe === true;
    return {
      input: { taskId: 'task_k3c4', traceId: 'tr_k3c4', startedAtMs: Date.now() - 5000, capabilities: ['storage.file.delete'] },
      ctx: { started: Date.now() - 5000, startedAtMs: Date.now() - 5000, raised: new Set(), delegationId: 'tr_k3c4', ...(noProbe ? {} : { delegationProbe: probe }) },
      enabled: true,
      ...(noProbe ? {} : { probe }),
      ...(over.warn ? { warn: over.warn } : {}),
      ...(over.shadow !== undefined ? { shadow: over.shadow } : {}),
      ...(over.fallback ? { reconcileApprovalWait: over.fallback } : {}),
    };
  }

  /** 记账 + 委托生产实现的兜底（验接线，不重写逻辑） */
  function countingFallback(counter = { calls: 0 }) {
    return {
      counter,
      fn: (b, t) => {
        counter.calls += 1;
        return reconcileApprovalWait(b, t);
      },
    };
  }

  test('D2 结构化命中 ⇒ 走服务端权威改判，兜底零调用（两判据不叠加）', async () => {
    const { reconcileApprovalTruth } = await loadTruth();
    const { counter, fn } = countingFallback();
    const out = await reconcileApprovalTruth(okBase(), 'APPROVAL_REQUIRED approvalId=apr_text_should_lose', truthDeps({ fallback: fn }));
    assert.equal(counter.calls, 0, '★ 结构化证据在场时文本兜底不得再跑（单一权威来源，防双重改判与归因混淆）');
    assert.equal(out.ok, false);
    assert.equal(out.error.code, 'APPROVAL_REQUIRED');
    assert.equal(out.error.details.approvalId, 'apr_server_1', 'approvalId 取服务端权威值，而非文本提取值（即便文本也带了一个）');
    assert.equal(out.error.details.source, 'server-ledger');
    assert.match(out.steps[0].summary, /服务端结构化判定/, 'steps 文案与文本兜底路径**可区分**（取证归因靠它）');
  });

  test('D3a 结构化退场（门 5：facts 空）⇒ 兜底接管，改判形状 = 本文件 a 组', async () => {
    const { reconcileApprovalTruth } = await loadTruth();
    const { counter, fn } = countingFallback();
    const out = await reconcileApprovalTruth(okBase(), 'APPROVAL_REQUIRED approvalId=apr_text', truthDeps({ facts: [], probe: { approvalWait: async () => [] }, fallback: fn }));
    assert.equal(counter.calls, 1, '结构化退场即回退兜底（CL-K3R：兜底为第二道闸）');
    assert.equal(out.ok, false);
    assert.equal(out.error.code, 'APPROVAL_REQUIRED');
    assert.equal(out.error.details.approvalId, 'apr_text', '兜底路径的 approvalId 来自文本提取');
    assert.equal(out.error.details.source, undefined, '兜底路径不得带 server-ledger 标记（归因可区分）');
    assert.equal(out.steps[0].summary, '等待审批（未执行完成）', '兜底文案（无「服务端结构化判定」后缀）');
  });

  test('D3b 结构化退场（门 3：探针缺席 = 旧服务端）⇒ 兜底接管且**不 warn**', async () => {
    const { reconcileApprovalTruth } = await loadTruth();
    const { counter, fn } = countingFallback();
    const warns = [];
    const out = await reconcileApprovalTruth(okBase(), '等待审批', truthDeps({ noProbe: true, warn: (m) => warns.push(m), fallback: fn }));
    assert.equal(counter.calls, 1, '门 3 = 兼容旧服务端，必须回退兜底（否则 R19 前的假成功防护直接失效）');
    assert.equal(out.ok, false);
    assert.equal(warns.length, 0, '门 3 的纪律是「绝不 warn」（探针缺席是常态而非异常）');
  });

  test('D4 shadow 态：结构化命中只 warn 不改判（兜底结论仅进对拍字段）', async () => {
    const { reconcileApprovalTruth } = await loadTruth();
    const warns = [];
    const { counter, fn } = countingFallback();
    const out = await reconcileApprovalTruth(okBase(), 'APPROVAL_REQUIRED', truthDeps({ shadow: true, warn: (m, meta) => warns.push({ msg: m, ...(meta ?? {}) }), fallback: fn }));
    assert.equal(out.ok, true, 'shadow 埋点对拍态绝不改判（SK-K2）');
    assert.equal(out.error, undefined, 'shadow 返回 base 本体（兜底结果不外溢）');
    assert.equal(warns.length, 1, 'shadow 命中须留恰一条 warn');
    assert.equal(counter.calls, 1, '对拍**需要**跑兜底取文本结论（只用于 warn 的对照字段）');
    assert.match(warns[0].msg, /未决审批结构化命中/);
    assert.equal(warns[0].structuredVerdict, 'waiting-approval');
    assert.equal(warns[0].textHeuristicVerdict, 'waiting-approval', '两判据在同一样本上结论一致 = 对拍的目的');
  });
});

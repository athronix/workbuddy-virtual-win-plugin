/**
 * Step 3.1 · 统一闸门抽取（`gateway.ts`）的行为与形态守卫
 *
 * ## 本文件要证明什么
 *
 * Step 3.1 的纪律是**纯搬运、语义一字不改**。难点在于：「搬运正确」这件事
 * **无法用"其他测试还绿"来证明** —— 如果搬运时把某条分支丢了，而恰好没有测试覆盖
 * 那条分支，所有测试照样绿。所以本文件用三种互补手段：
 *
 * | 手段 | 抓什么 | 为什么必须 |
 * |---|---|---|
 * | ① 逐行等价 | 搬运过程改写/漏抄了某一行 | 直接对比「原 handler 体」与「新函数体」 |
 * | ② 运行时行为 | 函数被调起来后**真的**走对分支 | 形态断言只能证明"文本在"，证明不了"逻辑对" |
 * | ③ 突变反证 | 断言本身是不是空转 | 把分支拆掉，守卫必须变红 |
 *
 * ## 为什么 ① 要用"基准副本"而不是只看现状
 *
 * 「搬运前后一致」是个**历史命题**：只有在搬运发生的那一刻才有"前"与"后"两个可比的
 * 对象。搬运提交之后，仓库里只剩"后"。故本文件把搬运前的那 269 行存成
 * `fixtures/step31-handler-baseline.txt`（**内容快照，不是可执行代码**），
 * 逐行比对。这样任何人后续"顺手优化"gateway 函数体都会立刻被发现。
 *
 * ⚠ 这不是重复断言：其他测试测的是**语义**（审批要拦、审计要落），本文件测的是
 * **「这次搬运没有偷偷改语义」**。两者失败时指向完全不同的根因。
 *
 * 运行：node --test tests/unit/step31-gateway-extraction.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..', '..');
const P = {
  GATEWAY: join(REPO, 'packages', 'vm-service', 'src', 'gateway.ts'),
  SERVER: join(REPO, 'packages', 'vm-service', 'src', 'server.ts'),
  INDEX: join(REPO, 'packages', 'vm-service', 'src', 'index.ts'),
  BASELINE: join(REPO, 'tests', 'unit', 'fixtures', 'step31-handler-baseline.txt'),
};

const SRC = {
  GATEWAY: readFileSync(P.GATEWAY, 'utf8'),
  SERVER: readFileSync(P.SERVER, 'utf8'),
  INDEX: readFileSync(P.INDEX, 'utf8'),
};

/* ==================== ① 逐行等价（搬运不许改语义） ==================== */

describe('Step 3.1 · 逐行等价：函数体与原 handler 体一致', () => {
  /**
   * 从 `gateway.ts` 切出 `gateAndExecute` 的**业务函数体**。
   *
   * 切法用固定锚点而非行号（行号会漂移）。锚点取函数体内第一条真实语句，
   * 终点取文件末尾最后一个 `}`（`gateAndExecute` 是本文件最后一个函数）。
   */
  function extractGatewayBody() {
    const lines = SRC.GATEWAY.split('\n');
    const anchor = lines.findIndex((l) => l.includes('以下为原 server.ts handler 体的逐行副本'));
    assert.notEqual(anchor, -1, '找不到"逐行副本"锚点 —— 函数体定位失效，本组断言全部失去意义');
    let end = lines.length - 1;
    while (end > anchor && lines[end].trim() === '') end -= 1;
    assert.equal(lines[end].trim(), '}', 'gateway.ts 末尾不是函数收尾大括号，锚点已漂移');
    let body = lines.slice(anchor + 1, end);
    while (body.length && body[0].trim() === '') body.shift();
    while (body.length && body[body.length - 1].trim() === '') body.pop();
    return body;
  }

  test('基准快照存在且非空（防"文件没生成也算过"）', () => {
    assert.ok(existsSync(P.BASELINE), '缺少搬运基准快照 fixtures/step31-handler-baseline.txt');
    const base = readFileSync(P.BASELINE, 'utf8');
    assert.ok(base.split('\n').length > 200, `基准快照过短（${base.split('\n').length} 行），内容可疑`);
  });

  test('★ 逐行内容完全一致（只允许整体缩进差 2 空格）', () => {
    const body = extractGatewayBody();
    const base = readFileSync(P.BASELINE, 'utf8').split('\n');
    // 去掉基准尾部空行，保持可比
    while (base.length && base[base.length - 1].trim() === '') base.pop();

    assert.equal(
      body.length,
      base.length,
      `行数不一致：基准 ${base.length} 行、现状 ${body.length} 行 ⇒ 搬运后被增删过内容`,
    );

    const diffs = [];
    for (let i = 0; i < base.length; i += 1) {
      // 判据：strip 后逐字相同。缩进差是结构性必然（闭包 6 空格 → 模块级 2 空格），
      // 但**内容**一个字符都不许变 —— 连注释都不许，因为注释里写着"为什么这样做"，
      // 改注释等于悄悄改设计依据。
      if (base[i].trim() !== body[i].trim()) {
        diffs.push(`第 ${i + 1} 行\n  基准: ${JSON.stringify(base[i].trim())}\n  现状: ${JSON.stringify(body[i].trim())}`);
      }
    }
    assert.deepEqual(diffs, [], `搬运后函数体与基准不一致（${diffs.length} 行）—— 本步要求纯搬运，不得顺手优化`);
  });

  test('缩进差恒为 2（证明只做了整体提级，没有局部重排）', () => {
    const body = extractGatewayBody();
    const base = readFileSync(P.BASELINE, 'utf8').split('\n');
    while (base.length && base[base.length - 1].trim() === '') base.pop();

    const anomalies = [];
    for (let i = 0; i < base.length; i += 1) {
      if (!base[i].trim()) continue;
      const ib = base[i].length - base[i].replace(/^ +/, '').length;
      const ic = body[i].length - body[i].replace(/^ +/, '').length;
      if (ib - ic !== 2) anomalies.push(`第 ${i + 1} 行缩进差 ${ib - ic}（应为 2）`);
    }
    assert.deepEqual(anomalies, [], '缩进差不为 2 ⇒ 存在局部重排，逐行可比性被破坏');
  });
});

/* ==================== ② 运行时行为（闸真的会拦/会放） ==================== */

describe('Step 3.1 · 运行时行为：gateAndExecute 真的按裁决分支办事', () => {
  /** 动态导入 dist 产物（与生产同一份编译输出，不另写实现）。 */
  async function loadGate() {
    const mod = await import('../../packages/vm-service/dist/gateway.js');
    assert.equal(typeof mod.gateAndExecute, 'function', 'gateAndExecute 未导出（闸不可调用）');
    return mod.gateAndExecute;
  }

  /** 极简能力定义（只填闸真正读到的字段）。 */
  const cap = {
    id: 'storage.file.delete',
    name: '删除文件',
    risk: 'L2',
    destructive: true,
    idempotent: false,
    requiresSession: false,
    input: { type: 'object', properties: {} },
  };

  /**
   * 构造 deps。默认全部"无害桩"，每个用例只覆盖它关心的那一两个。
   *
   * ⚠ 桩必须**记录调用**（`calls`），否则"没被调用"与"被调用了但没副作用"分不开 ——
   * 这正是本组要区分的两种失败。
   */
  function makeDeps(overrides = {}) {
    const calls = { denied: [], blocked: [], executed: [], audit: [] };
    const deps = {
      audit: { append: async () => ({}) },
      pendingApprovals: {
        get: () => undefined,
        set: () => undefined,
        delete: () => undefined,
        ttl: Number.POSITIVE_INFINITY,
      },
      evaluateScoped: () => ({ allowed: true, requiresApproval: false }),
      executeCapability: async () => {
        calls.executed.push(true);
        return { isError: false, structuredContent: { ok: true, traceId: 't', risk: 'L2', data: {} } };
      },
      ledgerReg: { recordBlocked: () => undefined },
      scopeRegistry: { lookup: () => undefined },
      scopeLookupKeys: () => ({}),
      isInnerDelegation: () => false,
      isDirectWithActiveTurn: () => false,
      shouldReturnDelegationRequired: () => false,
      approvalCoordinator: { getActiveTaskId: () => undefined },
      policyGateWiring: 'off',
      policyGateCounters: { directWithActiveTurn: 0 },
      delegationRequiredPolicy: true,
      buildPreview: (c, p) => ({ capabilityId: c.id, params: p }),
      collectImpact: () => ['x=y'],
      deriveUnderlying: () => undefined,
      hashApprovalPreview: () => 'a'.repeat(64),
      recordPolicyDeniedAudit: (...args) => {
        calls.denied.push(args);
        return Promise.resolve();
      },
      recordBlockedApprovalAudit: (...args) => {
        calls.blocked.push(args);
        return Promise.resolve();
      },
      newId: (p) => `${p}_fixed`,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      ...overrides,
    };
    return { deps, calls };
  }

  test('★ 放行分支：裁决 allowed 且无审批 ⇒ 走 executeCapability（且只走一次）', async () => {
    const gate = await loadGate();
    const { deps, calls } = makeDeps();
    const res = await gate(deps, { cap, params: { path: 'C:\\a.txt' }, ctx: { traceId: 'tr1' } });
    assert.equal(calls.executed.length, 1, '放行时必须且只能调一次执行段');
    assert.equal(res.isError, false, '放行分支不应标记 isError');
  });

  test('★ 审批分支：裁决 requiresApproval ⇒ 注册令牌 + 返回 APPROVAL_REQUIRED，且**不执行**', async () => {
    const gate = await loadGate();
    const registered = [];
    const { deps, calls } = makeDeps({
      evaluateScoped: () => ({
        allowed: false,
        requiresApproval: true,
        matchedRule: 'approval-required',
        error: { code: 'APPROVAL_REQUIRED', message: '需审批' },
      }),
      pendingApprovals: {
        get: () => undefined,
        set: (id, tok) => registered.push({ id, tok }),
        delete: () => undefined,
        ttl: Number.POSITIVE_INFINITY,
      },
    });
    const res = await gate(deps, { cap, params: {}, ctx: { traceId: 'tr2' } });

    assert.equal(calls.executed.length, 0, '审批分支绝不允许执行（这是安全底线）');
    assert.equal(registered.length, 1, '必须注册恰好一个审批令牌');
    assert.equal(registered[0].tok.hostApproved, false, '注册时恒为未批准（不得预批）');
    assert.equal(res.structuredContent.ok, false, '审批分支应回 ok:false');
    assert.equal(res.structuredContent.error.code, 'APPROVAL_REQUIRED');
    assert.ok(calls.blocked.length >= 1, '被拦调用必须落 blocked 审计（取证盲区闭合）');
  });

  test('★ 策略硬拒绝分支：allowed=false 且非审批 ⇒ 落 denied 审计、不执行、不回审批令牌', async () => {
    const gate = await loadGate();
    const registered = [];
    const { deps, calls } = makeDeps({
      evaluateScoped: () => ({
        allowed: false,
        requiresApproval: false,
        matchedRule: 'deny:path',
        error: { code: 'POLICY_DENIED', message: '被策略拒绝' },
      }),
      pendingApprovals: {
        get: () => undefined,
        set: (id) => registered.push(id),
        delete: () => undefined,
        ttl: Number.POSITIVE_INFINITY,
      },
    });
    const res = await gate(deps, { cap, params: {}, ctx: { traceId: 'tr3' } });

    assert.equal(calls.executed.length, 0, '硬拒绝绝不允许执行');
    assert.equal(registered.length, 0, '硬拒绝不是"待审批"，不得注册令牌');
    assert.ok(calls.denied.length >= 1, '硬拒绝必须落 denied 审计');
    assert.equal(res.isError, true, '硬拒绝应标记 isError');
    assert.equal(res.structuredContent.error.code, 'POLICY_DENIED');
  });

  test('★ 已批准续跑：hostApproved=true 的令牌 ⇒ 放行执行且事后删除令牌（一次性消费）', async () => {
    const gate = await loadGate();
    const deleted = [];
    const { deps, calls } = makeDeps({
      pendingApprovals: {
        get: () => ({
          approvalId: 'apr_1',
          capabilityId: cap.id,
          risk: 'L2',
          params: {},
          preview: {},
          createdAtMs: 1,
          hostApproved: true,
          // 与 buildPreview/hashApprovalPreview 桩产物一致（'a'*64），否则会被 ARCH-09 拒绑
          previewHash: 'a'.repeat(64),
        }),
        set: () => undefined,
        delete: (id) => deleted.push(id),
        ttl: Number.POSITIVE_INFINITY,
      },
    });
    const res = await gate(deps, {
      cap,
      params: { __approvalId: 'apr_1' },
      ctx: { traceId: 'tr4' },
    });

    assert.equal(calls.executed.length, 1, '已批准续跑必须真正执行');
    assert.deepEqual(deleted, ['apr_1'], '令牌必须一次性消费（重放后删除）');
    assert.equal(res.isError, false, '已批准续跑应成功');
  });

  test('窗口计数：窄窗命中时 policyGateCounters 递增（观测面不静默）', async () => {
    const gate = await loadGate();
    const counters = { directWithActiveTurn: 0 };
    const { deps } = makeDeps({
      isDirectWithActiveTurn: () => true,
      policyGateCounters: counters,
      evaluateScoped: () => ({
        allowed: false,
        requiresApproval: true,
        matchedRule: 'approval-required',
        error: { code: 'APPROVAL_REQUIRED', message: '需审批' },
      }),
    });
    await gate(deps, { cap, params: {}, ctx: { traceId: 'tr5' } });
    assert.equal(counters.directWithActiveTurn, 1, '窄窗命中必须计数（N-9 观测面）');
  });
});

/* ==================== ③ 形态：接线与公开面 ==================== */

describe('Step 3.1 · 接线形态', () => {
  test('server.ts 的 handler 改为转调闸（不再内联整段实现）', () => {
    assert.match(
      SRC.SERVER,
      /return gateAndExecute\(gateDeps, \{ cap, params, ctx \}\)/,
      'handler 必须转调 gateAndExecute —— 若仍内联，说明搬了却没接上',
    );
    // 反证：原内联实现的关键语句不应再出现在 server.ts 的 handler 段
    const handlerSeg = SRC.SERVER.slice(SRC.SERVER.indexOf('const mcpTools: McpTool[]'));
    assert.ok(
      !handlerSeg.includes('const { __approvalId, ...rest } = params;'),
      'server.ts handler 段仍残留原实现（__approvalId 解构）⇒ 存在两份实现，必然漂移',
    );
  });

  test('依赖装配齐备（少一项即 TS 编译失败，此处再钉一层防结构绕过）', () => {
    const m = SRC.SERVER.match(/const gateDeps: GateDeps = \{[\s\S]*?\n {2}\};/);
    assert.ok(m, '找不到 gateDeps 装配块');
    const block = m[0];
    // 只钉"关键安全设施"三项：漏任何一项都会静默降级（审计不落 / 令牌表读不到 / 裁决不生效）
    for (const k of ['audit', 'pendingApprovals', 'evaluateScoped', 'executeCapability']) {
      assert.match(block, new RegExp(`\\b${k},`), `gateDeps 装配缺 ${k}`);
    }
  });

  test('gateway 从包入口可达（Step 3.2 要复用它做上游分支闸）', () => {
    assert.match(SRC.INDEX, /export \{ gateAndExecute \} from '\.\/gateway\.js';/, 'index.ts 未导出 gateAndExecute');
    assert.match(SRC.INDEX, /export type \{[^}]*GateDeps[^}]*\} from '\.\/gateway\.js';/, 'index.ts 未导出 GateDeps 类型');
  });

  test('ExecutionSegment 单一来源（server.ts 只做别名，不再各留一份）', () => {
    assert.match(SRC.GATEWAY, /export interface ExecutionSegment/, 'gateway.ts 应持有唯一定义');
    assert.ok(
      !/interface ExecutionSegment \{/.test(SRC.SERVER),
      'server.ts 又定义了一份 ExecutionSegment ⇒ 两处结构类型会静默漂移',
    );
    assert.match(SRC.SERVER, /type ExecutionSegment = GatewayExecutionSegment/, 'server.ts 应以别名复用');
  });
});
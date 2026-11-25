/**
 * Step 3.2 · 上游工具面闸门（`/mcp/browser`、`/mcp/desktop`）的行为守卫
 *
 * ## 本文件要证明什么
 *
 * 病灶：改动前上游两路直接 `upstreamServer.handleRequest()` —— **不过策略、不过审批、
 * 不落审计**，58 个工具裸奔（含 `browser.meta.eval`，页内执行任意 JS / L2）。
 *
 * 计划书原本的验收是 `grep -c "gateAndExecute"` 与 `grep -c "audit"`。那两条**是文本证据，
 * 不是行为证据** —— 本仓已被「门禁假绿」坑过三次（查子串 / 查次数 / 查注释）。
 * 字面量在文件里出现过，不等于闸真的会拦。故本文件全部用**运行时行为**判定。
 *
 * ## 三种互补手段
 *
 * | 手段 | 抓什么 |
 * |---|---|
 * | ① 判定层（`evaluateUpstreamCall`） | 该拒的拒了、该放的放了、拒绝类型分对了 |
 * | ② 执行层（`gateUpstreamAndExecute`） | 拒绝时**真的没执行**、审计**真的落了** |
 * | ③ 面隔离（引擎 `surface` 选项） | 上游参数不被 vm 面策略误伤、能力级判定不缩水 |
 *
 * ③ 单独成组的原因：它是本步**最容易做错且最隐蔽**的一处 —— 即使闸接线全对，
 * 若把 vm 面的引擎实例直接给上游用，`browser.nav.open` 的任何 http url 都会被
 * `pathAllowlist:miss` 拒掉（实测），浏览器工具**整体不可用**。那种失败不会让
 * 任何「闸是否生效」的断言变红，只会让功能静默消失。
 *
 * 运行：node --test tests/unit/step32-upstream-gate.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..', '..');

const { evaluateUpstreamCall, gateUpstreamAndExecute } = await import(
  '../../packages/vm-service/dist/upstream-gate.js'
);
const { SURFACE_SCOPE, scopeOf, hasNoParameterPolicies } = await import(
  '../../packages/vm-service/dist/surface-policy.js'
);
const { CorePolicyEngine } = await import('../../packages/core/dist/policy/engine.js');
const { UNIFIED_CAPABILITIES } = await import('../../packages/vm-capabilities/dist/index.js');

/* ==================== 夹具 ==================== */

/** 真实统一表里取一条，避免手写夹具与生产表漂移。 */
function entryOf(id) {
  const e = UNIFIED_CAPABILITIES.find((c) => c.id === id);
  assert.ok(e, `统一表里找不到 ${id}（夹具依赖真实表，说明表被改动了）`);
  return e;
}

/** 按面建「工具名 → 条目」索引（与 `server.ts` 装配逻辑同构）。 */
function makeIndex(surface) {
  const m = new Map();
  for (const e of UNIFIED_CAPABILITIES) {
    if (e.surface !== surface) continue;
    m.set(e.tool ?? e.id, e);
  }
  return m;
}

/**
 * 造判定依赖。`engine` 默认是本**面**的真引擎（不是替身）——
 * 用替身会让「面隔离」这组断言变成自证（替身当然返回我让它返回的东西）。
 */
function makeEvalDeps(surface, overrides = {}) {
  const index = makeIndex(surface);
  return {
    engine: new CorePolicyEngine({ surface }),
    lookupEntry: (s, toolName) => (s === surface ? index.get(toolName) : undefined),
    mode: 'on',
    ...overrides,
  };
}

/** 造执行依赖：`execute` 记录调用（区分「没被调用」与「调用了但没副作用」）。 */
function makeExecDeps(surface, overrides = {}) {
  const calls = { executed: [], audits: [] };
  const deps = {
    ...makeEvalDeps(surface),
    audit: {
      append: async (rec) => {
        calls.audits.push(rec);
        return {};
      },
    },
    execute: async (toolName, args) => {
      calls.executed.push({ toolName, args });
      return {
        isError: false,
        content: [{ type: 'text', text: 'ok' }],
        structuredContent: { ok: true, data: { echo: toolName } },
      };
    },
    newId: (p) => `${p}_fixed`,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    ...overrides,
  };
  return { deps, calls };
}

/** 等一轮微任务，让 `void recordUpstreamAudit(...)` 的 best-effort 写入落地。 */
const flush = () => new Promise((r) => setImmediate(r));

/* ==================== ① 判定层 ==================== */

describe('Step 3.2 · 判定层：该拒的拒、该放的放、拒绝类型分对', () => {
  test('★ 控制组：L0 只读工具被放行（证明闸不是"一律拒"）', () => {
    const deps = makeEvalDeps('desktop');
    const entry = entryOf('desktop.observe.snapshot');
    const v = evaluateUpstreamCall(deps, {
      surface: 'desktop',
      toolName: entry.tool,
      args: {},
      ctx: { traceId: 't1' },
    });
    assert.equal(v.kind, 'execute', 'L0 只读工具必须放行 —— 否则闸把功能改挂了');
    assert.equal(v.entry.id, entry.id);
  });

  test('★ L2 能力被拦且类型是 DELEGATION_REQUIRED（不是 POLICY_DENIED）', () => {
    const deps = makeEvalDeps('browser');
    const entry = entryOf('browser.meta.eval');
    assert.equal(entry.risk, 'L2', '夹具前提：eval 必须是 L2（若被降级，本断言失去意义）');
    const v = evaluateUpstreamCall(deps, {
      surface: 'browser',
      toolName: entry.tool,
      args: { expression: 'document.cookie' },
      ctx: { traceId: 't2' },
    });
    assert.equal(v.kind, 'deny', 'eval（页内执行任意 JS）绝不能放过');
    assert.equal(
      v.code,
      'DELEGATION_REQUIRED',
      '上游面不重放 ⇒ 审批类拒绝必须收口为 DELEGATION_REQUIRED，不能回 POLICY_DENIED（那会把"请走委派"伪装成"永远不行"）',
    );
  });

  test('★ 能力级黑名单跨面生效：storage.file.delete 在 browser 面仍被拦', () => {
    const deps = makeEvalDeps('browser');
    const v = evaluateUpstreamCall(deps, {
      surface: 'browser',
      toolName: 'storage_file_delete',
      args: { path: 'D:\\Data\\x.txt' },
      ctx: { traceId: 't3' },
    });
    // 该工具不在 browser 表 ⇒ 应被 fail-closed 拦（UNKNOWN_UPSTREAM_TOOL），
    // 这条同时证明「跨面的陌生工具名不会因为"名字像 vm 能力"而被放行」。
    assert.equal(v.kind, 'deny');
    assert.equal(v.code, 'UNKNOWN_UPSTREAM_TOOL');
  });

  test('★ 不在统一表内的工具 ⇒ fail-closed 拒绝（不是默认放行）', () => {
    const deps = makeEvalDeps('browser');
    const v = evaluateUpstreamCall(deps, {
      surface: 'browser',
      toolName: 'agent_browser_totally_new_tool',
      args: {},
      ctx: { traceId: 't4' },
    });
    assert.equal(v.kind, 'deny', '未知工具必须拒绝 —— 放行就是 fail-open');
    assert.equal(v.code, 'UNKNOWN_UPSTREAM_TOOL');
    assert.match(v.entry.id, /unregistered/, '合成条目的 id 必须含 unregistered 段，便于运维筛出');
  });

  test('★ shadow 态：本应拦的仍然"判定为拦"，但以 shadow-allow 表达（不吞掉事实）', () => {
    const deps = makeEvalDeps('browser', { mode: 'shadow' });
    const entry = entryOf('browser.meta.eval');
    const v = evaluateUpstreamCall(deps, {
      surface: 'browser',
      toolName: entry.tool,
      args: {},
      ctx: { traceId: 't5' },
    });
    assert.equal(v.kind, 'shadow-allow', 'shadow 必须单列一类，不能混成 execute（否则审计里看不出"灰度放行"）');
    assert.equal(v.wouldBe, 'DELEGATION_REQUIRED', 'wouldBe 必须记录"本应是什么"，否则灰度失去观测价值');
  });
});

/* ==================== ② 执行层 ==================== */

describe('Step 3.2 · 执行层：拒绝时不执行、审计真的落', () => {
  test('★ 被拦的调用**绝不执行**（安全底线），且落一条 denied 审计', async () => {
    const { deps, calls } = makeExecDeps('browser');
    const entry = entryOf('browser.meta.eval');
    const res = await gateUpstreamAndExecute(deps, {
      surface: 'browser',
      toolName: entry.tool,
      args: { expression: 'fetch("http://evil")' },
      ctx: { traceId: 'tr-deny' },
    });
    await flush();

    assert.equal(calls.executed.length, 0, '被拦调用绝不允许执行 —— 这是本步的全部意义');
    assert.equal(res.isError, true, '被拦调用必须以 isError 回给宿主');
    assert.equal(res.structuredContent.error.code, 'DELEGATION_REQUIRED');

    const denied = calls.audits.filter((a) => a.ext?.upstreamDecision === 'denied');
    assert.equal(denied.length, 1, '被拦调用必须落且只落一条 denied 审计（取证盲区闭合）');
    assert.equal(denied[0].capabilityId, entry.id, '审计的 capabilityId 必须是统一表 id，便于跨面聚合');
    assert.equal(denied[0].risk, 'L2');
    assert.equal(denied[0].policyDecision.allowed, false);
    assert.equal(denied[0].ext.surface, 'browser', '上游面归因：必须能回答"走的是哪个端点"');
    assert.equal(denied[0].ext.upstreamTool, entry.tool, '上游工具名必须留存（链路排查要用）');
  });

  test('★ 放行的调用**真的执行**且落一条 executed 审计（否则"执行过"依然无痕）', async () => {
    const { deps, calls } = makeExecDeps('desktop');
    const entry = entryOf('desktop.observe.snapshot');
    const res = await gateUpstreamAndExecute(deps, {
      surface: 'desktop',
      toolName: entry.tool,
      args: {},
      ctx: { traceId: 'tr-ok' },
    });
    await flush();

    assert.equal(calls.executed.length, 1, '放行必须执行一次');
    assert.equal(calls.executed[0].toolName, entry.tool);
    assert.equal(res.isError, false);

    const executed = calls.audits.filter((a) => a.ext?.upstreamDecision === 'executed');
    assert.equal(executed.length, 1, '上游面没有 provider ⇒ executed 审计必须由闸自己落，否则等于没修');
    assert.equal(executed[0].capabilityId, entry.id);
    assert.equal(executed[0].result.ok, true);
    // 成功条目**不带** errorCode（与 vm 面 succeeded 条目同口径，避免按 code 聚合时混入成功）
    assert.equal(executed[0].result.errorCode, undefined);
  });

  test('★ 执行返回 isError ⇒ 审计如实记 ok:false + EXECUTION_FAILED（不伪装成功）', async () => {
    const { deps, calls } = makeExecDeps('desktop', {
      execute: async () => ({ isError: true, structuredContent: { ok: false, error: { code: 'X' } } }),
    });
    const entry = entryOf('desktop.observe.snapshot');
    await gateUpstreamAndExecute(deps, {
      surface: 'desktop',
      toolName: entry.tool,
      args: {},
      ctx: { traceId: 'tr-fail' },
    });
    await flush();
    const executed = calls.audits.filter((a) => a.ext?.upstreamDecision === 'executed');
    assert.equal(executed.length, 1);
    assert.equal(executed[0].result.ok, false);
    assert.equal(executed[0].result.errorCode, 'EXECUTION_FAILED');
  });

  test('★ 执行抛错：审计记失败、错误向上抛（502 由路由处理，不吞成"策略拒绝"）', async () => {
    const { deps, calls } = makeExecDeps('desktop', {
      execute: async () => {
        throw new Error('stdio upstream died');
      },
    });
    const entry = entryOf('desktop.observe.snapshot');
    await assert.rejects(
      () =>
        gateUpstreamAndExecute(deps, {
          surface: 'desktop',
          toolName: entry.tool,
          args: {},
          ctx: { traceId: 'tr-throw' },
        }),
      /stdio upstream died/,
      '上游不可用必须向上抛（路由有 502 分支），不能伪装成策略拒绝',
    );
    await flush();
    const executed = calls.audits.filter((a) => a.ext?.upstreamDecision === 'executed');
    assert.equal(executed.length, 1);
    assert.equal(executed[0].result.ok, false);
  });

  test('★ mode=off：完全跳过判定与审计（逐字回滚语义）', async () => {
    const { deps, calls } = makeExecDeps('browser', { mode: 'off' });
    const entry = entryOf('browser.meta.eval');
    const res = await gateUpstreamAndExecute(deps, {
      surface: 'browser',
      toolName: entry.tool,
      args: {},
      ctx: { traceId: 'tr-off' },
    });
    await flush();
    assert.equal(calls.executed.length, 1, 'off 态必须直接执行（回滚到改动前）');
    assert.equal(calls.audits.length, 0, 'off 态不写审计 —— 否则就不等于"改动前的行为"了');
    assert.equal(res.isError, false);
  });

  test('★ shadow 态：落"本应拒"审计但**放行执行**', async () => {
    const { deps, calls } = makeExecDeps('browser', { mode: 'shadow' });
    const entry = entryOf('browser.meta.eval');
    await gateUpstreamAndExecute(deps, {
      surface: 'browser',
      toolName: entry.tool,
      args: {},
      ctx: { traceId: 'tr-shadow' },
    });
    await flush();
    assert.equal(calls.executed.length, 1, 'shadow 态放行执行');
    const shadow = calls.audits.filter((a) => a.ext?.upstreamDecision === 'shadow-allowed');
    assert.equal(shadow.length, 1, 'shadow 必须留下"本应拦"的记录，否则灰度毫无意义');
    assert.equal(shadow[0].policyDecision.allowed, true, '放行了，故 allowed=true');
  });

  test('★ 审计写失败不影响调用结果（best-effort，拒绝语义优先）', async () => {
    const brokenAudit = { append: async () => { throw new Error('disk full'); } };
    const { deps, calls } = makeExecDeps('desktop', { audit: brokenAudit });
    const entry = entryOf('desktop.observe.snapshot');
    const res = await gateUpstreamAndExecute(deps, {
      surface: 'desktop',
      toolName: entry.tool,
      args: {},
      ctx: { traceId: 'tr-broken' },
    });
    await flush();
    assert.equal(calls.executed.length, 1, '审计写失败不得阻止执行（与 recordPolicyDeniedAudit 同纪律）');
    assert.equal(res.isError, false);
  });
});

/* ==================== ③ 面隔离（最隐蔽的一处） ==================== */

describe('Step 3.2 · 面隔离：上游参数不被 vm 面策略误伤', () => {
  test('★ 回归锚点：vm 面（缺省）对 Windows 路径**仍然拒绝**（隔离不能顺手放松 vm 面）', () => {
    const vm = new CorePolicyEngine();
    const r = vm.evaluate({
      capabilityId: 'desktop.input.type',
      params: { text: 'C:\\Windows\\System32\\x' },
      risk: 'L1',
      approved: false,
    });
    assert.equal(r.allowed, false, 'vm 面（不传 surface）行为必须逐字不变 —— 这是隔离的边界');
    assert.match(r.matchedRule, /pathDenylist/);
    assert.equal(vm.surfaceScope, 'vm', '缺省面必须是 vm');
  });

  test('★ 上游面：同一个 Windows 路径参数**不再**被 pathDenylist 误拒', () => {
    // 语义：`desktop.input.type {text:'C:\Windows\...'}` 是**往输入框里打这段文字**，
    // 不是要写那个文件。套 pathDenylist 会让桌面自动化的常见合法用途被封死（实测）。
    const br = new CorePolicyEngine({ surface: 'browser' });
    const r = br.evaluate({
      capabilityId: 'desktop.input.type',
      params: { text: 'C:\\Windows\\System32\\x' },
      risk: 'L1',
      approved: false,
    });
    assert.equal(r.allowed, true, '上游面的 text 参数不是文件路径，不得套 pathDenylist');
    assert.equal(br.surfaceScope, 'browser');
  });

  test('★ 上游面：http url **不再**被 pathAllowlist 误拒（否则浏览器工具整体不可用）', () => {
    const br = new CorePolicyEngine({ surface: 'browser' });
    const r = br.evaluate({
      capabilityId: 'browser.nav.open',
      params: { url: 'https://example.com/a/b' },
      risk: 'L1',
      approved: false,
    });
    assert.equal(r.allowed, true, 'url 不是文件路径；被 pathAllowlist 拒会导致任何网页都打不开');
  });

  test('★★ 隔离**不越过能力级**：L2 在上游面依然要求审批（不是顺手放行）', () => {
    const br = new CorePolicyEngine({ surface: 'browser' });
    const r = br.evaluate({
      capabilityId: 'browser.meta.eval',
      params: { expression: '1+1' },
      risk: 'L2',
      approved: false,
    });
    assert.equal(r.allowed, false, '面隔离只裁参数级策略；若把审批也裁掉，那才是真漏洞');
    assert.equal(r.requiresApproval, true);
    assert.equal(r.matchedRule, 'approval-required');
  });

  test('★★ 隔离**不越过能力级名单**：黑名单条目在上游面依然被拦', () => {
    const br = new CorePolicyEngine({ surface: 'browser' });
    // 用一条真实在默认黑名单里的能力 id（名单按能力 ID 匹配，与面无关）
    const r = br.evaluate({
      capabilityId: 'storage.file.delete',
      params: { path: 'D:\\Data\\x.txt' },
      risk: 'L2',
      approved: false,
    });
    assert.equal(r.allowed, false);
    assert.match(
      r.matchedRule,
      /capability-denylist/,
      '能力级黑名单必须跨面生效 —— 它是"这个能力要不要人看"，与参数指向什么资源无关',
    );
  });

  test('★ 面策略登记表：上游两面都不受参数级策略管辖', () => {
    assert.equal(hasNoParameterPolicies('browser'), true);
    assert.equal(hasNoParameterPolicies('desktop'), true);
    assert.equal(hasNoParameterPolicies('vm'), false, 'vm 面必须受管辖，否则参数级防护整体失效');
    assert.deepEqual(
      { ...scopeOf('vm') },
      { filesystem: true, command: true, registry: true, process: true },
      'vm 面的声明必须与改动前逐字一致',
    );
  });

  /**
   * ★★ 本条专为抓「突变 4」而写。
   *
   * 最易犯的真实错误不是"忘了隔离"，而是**装配时把 vm 面那个 `policy` 实例直接传给上游闸**
   * （写起来最省事：`engine: policy` 一行）。那种错误下：
   * - `evaluateUpstreamCall` 的**判定逻辑**完全正确（它只调 `engine.evaluate`）；
   * - 「闸是否生效」的断言也全绿（该拦的确实拦了）；
   * - 但 `browser.nav.open` 的任何 http url 会被 vm 面的 `pathAllowlist` 拒掉 ——
   *   **浏览器工具整体不可用**，而没有任何"闸是否生效"的断言会因此变红。
   *
   * ## ⚠ 这两条的**证据边界**（实测记录，别高估它们）
   *
   * 第一版我以为加端到端行为断言就能抓住突变 4，**实测抓不住**（22/23 全绿）。
   * 原因：本文件直接 import `upstream-gate.js` 并**自己**构造 `makeEvalDeps`
   * （里面传的是 `new CorePolicyEngine({ surface })`）——它走的是**测试自己的装配**，
   * 不是 `server.ts` 的装配。突变改的是 `server.ts`，测试根本走不到那行代码。
   *
   * ⇒ 结论：**装配正确性只能靠源码结构断言**（下面第 2 条），端到端行为断言在这里
   * 证明的是「闸 + 按面引擎这一**组合**是对的」，不能替代对装配点的检查。
   * 两个层次各有边界，不要互相冒充 —— 这正是本仓「门禁假绿」教训的同一形态。
   */
  test('★ 端到端（组合正确性）：带 url 的 browser.nav.open 经闸后**被放行执行**', async () => {
    const { deps, calls } = makeExecDeps('browser');
    const entry = entryOf('browser.nav.open');
    const res = await gateUpstreamAndExecute(deps, {
      surface: 'browser',
      toolName: entry.tool,
      args: { url: 'https://example.com/docs?a=1' },
      ctx: { traceId: 'tr-e2e-url' },
    });
    await flush();

    assert.equal(
      calls.executed.length,
      1,
      '带 http url 的导航调用必须能执行 —— 若被 pathAllowlist 拒，浏览器工具整体不可用',
    );
    assert.equal(res.isError, false);
    const executed = calls.audits.filter((a) => a.ext?.upstreamDecision === 'executed');
    assert.equal(executed.length, 1);
  });

  test('★ 端到端（组合正确性）：desktop.input.type 输入含 C:\\Windows 的文字**被放行执行**', async () => {
    // 语义校准：这是「往输入框里打这段文字」，不是「写这个文件」。
    // 若被 pathDenylist 拒，桌面自动化的一个常见合法用途就被封死了。
    const { deps, calls } = makeExecDeps('desktop');
    const entry = entryOf('desktop.input.type');
    const res = await gateUpstreamAndExecute(deps, {
      surface: 'desktop',
      toolName: entry.tool,
      args: { ref: 'e5', text: 'C:\\Windows\\System32\\drivers\\etc' },
      ctx: { traceId: 'tr-e2e-type' },
    });
    await flush();
    assert.equal(calls.executed.length, 1, '输入含系统路径的**文字**必须允许（那不是文件写入）');
    assert.equal(res.isError, false);
  });

  test('★ 登记表覆盖全部面（漏登记会让新面静默无策略）', () => {
    const { SURFACES } = { SURFACES: ['vm', 'browser', 'desktop'] };
    for (const s of SURFACES) {
      assert.ok(s in SURFACE_SCOPE, `面 ${s} 未在 SURFACE_SCOPE 登记`);
    }
  });
});

/* ==================== ④ 接线形态（只保底，不作主证据） ==================== */

describe('Step 3.2 · 接线形态：上游分支确实走了闸', () => {
  const SERVER = readFileSync(join(REPO, 'packages', 'vm-service', 'src', 'server.ts'), 'utf8');

  test('上游路由分支内出现 gateUpstreamAndExecute 与 upstreamGates', () => {
    // ⚠ 形态断言只是**保底**：行为判定在上面三组。这条只在"有人把接线整段删了"时第一时间报警。
    const start = SERVER.indexOf("const upstreamId = path.startsWith('/mcp/')");
    assert.ok(start > 0, '找不到上游分支起点 —— 若路由被重构，本断言需同步更新');
    const end = SERVER.indexOf("if (path === '/a2a'", start);
    assert.ok(end > start, '找不到上游分支终点');
    const segment = SERVER.slice(start, end);
    assert.match(segment, /gateUpstreamAndExecute\(/, '上游分支必须调闸');
    assert.match(segment, /upstreamGates\[/, '上游分支必须按面取闸');
    assert.match(segment, /fail-closed|403/, '未装配闸的上游必须 fail-closed，不能静默放行');
  });

  test('装配点按面各建一个引擎、且**必须**传 surface（否则隔离不生效）', () => {
    const start = SERVER.indexOf('上游工具面闸门接线');
    assert.ok(start > 0, '找不到装配段锚点');
    const segment = SERVER.slice(start, start + 6000);

    // ① 必须是 `new CorePolicyEngine({... surface ...})`，不是复用既有实例。
    assert.match(
      segment,
      /engine:\s*new CorePolicyEngine\(\{[^}]*\bsurface\b[^}]*\}\)/s,
      '装配必须为每个面新建引擎并传 surface',
    );

    // ② ★ 反向断言（这是能抓住"复用 vm 面实例"的那一条）：
    // 装配里**不许**出现 `engine: policy` 这种"复用 vm 面实例"的写法。
    // 为什么必须显式钉：`policy` 是 `createService()` 里的 vm 面引擎，
    // 它构造时没传 surface（缺省 vm）⇒ 参数级策略全开 ⇒ 上游 url 会被 pathAllowlist 拒。
    // 那种写法**类型上完全合法**（都是 PolicyEngine），编译器不会拦，
    // 「闸是否生效」的行为断言也不会红（该拦的照拦），只有这条能抓。
    assert.doesNotMatch(
      segment,
      /engine:\s*policy\s*[,}]/,
      '禁止把 vm 面的 `policy` 实例直接给上游闸 —— 会让上游参数被文件系统策略误伤（类型合法但语义错）',
    );

    // ③ 每面一个实例（不能共用一个跨面实例）：`for` 循环内 new 才满足。
    const newEngineCount = (segment.match(/new CorePolicyEngine\(/g) ?? []).length;
    assert.equal(newEngineCount, 1, '应当只在循环体内 new 一次（每面各得一个实例），实际出现多处需人工确认');
  });
});
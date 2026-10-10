/**
 * Phase 2 · P2-T5 单元测试 —— bearer 生效自检（拒绝静默退化）
 *
 * 覆盖设计 `docs/changes/phase2-arch-design.md` §2.2（F2 Step 1 判据）与 §13 Q3/Q4 裁决：
 *  A. `runBearerMountSelfCheck` 全 5 结论码分支（含**真实 createBearerGuard 产物**求值，
 *     证明「自检与被检守卫同源」，不是自说自话的夹具）；
 *  B. `resolveInnerReconnect` 全 6 条判据（三态必须能表达 unverified —— PR3）；
 *  C. `shouldFailClosedStart` 决策表**全 18 格**穷举（3 authMode × 3 status × 2 failClosed）：
 *     仅「bearer-enforced ∧ broken ∧ true」拒启；「bearer-enforced ∧ broken ∧ false」放行+回滚告警；
 *     其余 16 格恒不拒（默认态逐字零回归）；
 *  D. `buildBearerSelfCheckAuditEntry` 链上裸条目形态（matchedRule 四分支、O-7 口径、
 *     **绝不泄漏凭据值**）；
 *  E. `buildSecurityHealth` 的 K-13 纯附加（两快照键缺席 ⇒ 旧形状逐字不变；在场 ⇒ 防御性拷贝）；
 *  F. `resolveEnforceBearerFailClosed` + `validateServiceConfig` 的两条新告警
 *    （非布尔卫生告警 / 回滚位显形），出厂默认零误报；
 *  G. server.ts 装配面静态守卫（证据先落链再抛、拒启先于 createServer、close() 首行收口位、
 *     /health 喂两快照、回滚位告警分支在位）—— 沙箱内起服务会 spawn ps-bridge 触发原生
 *     fatal（既有纪律），故装配正确性用源码文本钉，运行面由 qa/r19/ 真机探针另证。
 *
 * 纪律：不起 HTTP 服务、不 spawn ps-bridge、不碰 process.env（一律注入 env 视图）。
 * 运行：node --test tests/unit/phase2-bearer-selfcheck.test.js
 * ⚠ 依赖已重建 dist（`tsc -b tsconfig.build.json`）。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  buildBearerSelfCheckAuditEntry,
  buildSecurityHealth,
  createBearerGuard,
  resolveAuthMode,
  resolveInnerReconnect,
  runBearerMountSelfCheck,
  shouldFailClosedStart,
} from '@winvm/vm-service';

import {
  DEFAULT_SERVICE_CONFIG,
  resolveEnforceBearerFailClosed,
  validateServiceConfig,
} from '@winvm/core';

const SERVER_SRC = readFileSync(
  new URL('../../packages/vm-service/src/server.ts', import.meta.url),
  'utf8',
);
const BRIDGE_SRC = readFileSync(
  new URL('../../packages/contracts/src/bridge.ts', import.meta.url),
  'utf8',
);
const AUDIT_SRC = readFileSync(
  new URL('../../packages/contracts/src/audit.ts', import.meta.url),
  'utf8',
);
const DELIVERY_CFG = JSON.parse(
  readFileSync(new URL('../../delivery/vm-service.config.json', import.meta.url), 'utf8'),
);

const TOKEN = 'P2t5-SelfCheck-Tok3n';

/* ============================================================================
 * A. runBearerMountSelfCheck —— 5 结论码全分支
 * ========================================================================== */

describe('P2-T5 · 挂载自检 runBearerMountSelfCheck', () => {
  test('bearerToken 缺席 ⇒ not-mounted 且 ok:true（默认态不得被读成异常）', () => {
    const r = runBearerMountSelfCheck({});
    assert.equal(r.code, 'not-mounted');
    assert.equal(r.ok, true);
    assert.match(r.reason, /未挂载/);
  });

  test('bearerToken 空串 ⇒ 同 not-mounted（resolveBearerToken 的空值口径一致）', () => {
    const r = runBearerMountSelfCheck({ bearerToken: '' });
    assert.equal(r.code, 'not-mounted');
    assert.equal(r.ok, true);
  });

  test('已挂载但求值器缺席 ⇒ mounted-evaluator-absent（不伪装 not-mounted、不谎称 pass、不冒用实测码）', () => {
    const r = runBearerMountSelfCheck({ bearerToken: TOKEN });
    assert.equal(r.code, 'mounted-evaluator-absent');
    assert.equal(r.ok, false);
    assert.match(r.reason, /不可证|装配缺陷/);
  });

  test('已挂载但守卫永 allow（enforceBearer=false 产物喂非空 token ⇒ 漂移形态）⇒ always-allow 红', () => {
    // 被检对象是**真实 createBearerGuard 产物**（双条件缺件 ⇒ 恒 pass），非手写夹具。
    const guard = createBearerGuard({ enforceBearer: false, env: { WINVM_T: TOKEN } });
    const r = runBearerMountSelfCheck({ bearerToken: TOKEN, evaluate: (req) => guard(req) });
    assert.equal(r.code, 'mounted-fail-guard-always-allow');
    assert.equal(r.ok, false);
    assert.match(r.reason, /静默退化/);
  });

  test('已挂载但守卫拒正确凭据（守卫期望另一 token ⇒ 装配漂移）⇒ rejects-correct-token 红', () => {
    const guard = createBearerGuard({ enforceBearer: true, tokenEnv: 'WINVM_T', env: { WINVM_T: 'other-token' } });
    const r = runBearerMountSelfCheck({ bearerToken: TOKEN, evaluate: (req) => guard(req) });
    assert.equal(r.code, 'mounted-fail-guard-rejects-correct-token');
    assert.equal(r.ok, false);
  });

  test('已挂载且守卫同源正确 ⇒ mounted-pass（无凭据 deny、正确凭据 pass 双实证）', () => {
    const guard = createBearerGuard({ enforceBearer: true, tokenEnv: 'WINVM_T', env: { WINVM_T: TOKEN } });
    const r = runBearerMountSelfCheck({ bearerToken: TOKEN, evaluate: (req) => guard(req) });
    assert.equal(r.code, 'mounted-pass');
    assert.equal(r.ok, true);
  });

  test('泄漏纪律：任何结论码的 reason 绝不含凭据值（人读诊断面可整段落日志）', () => {
    const cases = [
      {},
      { bearerToken: TOKEN },
      { bearerToken: TOKEN, evaluate: () => ({ verdict: 'pass' }) },
      { bearerToken: TOKEN, evaluate: () => ({ verdict: 'deny', reason: 'token-mismatch' }) },
    ];
    for (const input of cases) {
      const r = runBearerMountSelfCheck(input);
      assert.ok(!r.reason.includes(TOKEN), `reason 泄漏凭据：${r.reason}`);
    }
  });
});

/* ============================================================================
 * B. resolveInnerReconnect —— 判据 1..6 全覆盖（三态含 unverified）
 * ========================================================================== */

describe('P2-T5 · 回连通路判定 resolveInnerReconnect', () => {
  const envWith = (name, value) => ({ [name]: value });

  test('判据1：loopback-only ⇒ unverified（守卫没挂，回连无判定意义，默认态恒不拒启）', () => {
    const r = resolveInnerReconnect({ authMode: 'loopback-only' }, {});
    assert.equal(r.status, 'unverified');
    assert.match(r.reason, /无判定意义/);
  });

  test('判据1：bearer-configured-missing ⇒ unverified（半开态同样无权改判回连事实）', () => {
    const r = resolveInnerReconnect({ authMode: 'bearer-configured-missing' }, {});
    assert.equal(r.status, 'unverified');
  });

  test('判据2：probeError 在场 ⇒ unverified（PR3：探针自身故障绝不冒充 broken）', () => {
    const r = resolveInnerReconnect(
      { authMode: 'bearer-enforced', probeError: 'ETIMEDOUT', providerOptions: {} },
      {},
    );
    assert.equal(r.status, 'unverified');
    assert.match(r.reason, /绝不据此拒启/);
  });

  test('判据3：probeStatus 在场 ⇒ 原样采用（端到端实证优先于配置推理）', () => {
    for (const s of ['ok', 'broken', 'unverified']) {
      const r = resolveInnerReconnect({ authMode: 'bearer-enforced', probeStatus: s }, {});
      assert.equal(r.status, s);
    }
  });

  test('判据4：enforced + provider options 无 bearerEnvName ⇒ broken（未实现期诚实语义：回连必 401）', () => {
    const r = resolveInnerReconnect({ authMode: 'bearer-enforced', providerOptions: { model: 'x' } }, {});
    assert.equal(r.status, 'broken');
    assert.match(r.reason, /P2-T6/);
    const r2 = resolveInnerReconnect({ authMode: 'bearer-enforced' }, {});
    assert.equal(r2.status, 'broken', 'providerOptions 整段缺席同样按「未配置凭据变量名」判 broken');
  });

  test('判据4：bearerEnvName 空白串 ⇒ 视同缺席 ⇒ broken', () => {
    const r = resolveInnerReconnect(
      { authMode: 'bearer-enforced', providerOptions: { bearerEnvName: '   ' } },
      {},
    );
    assert.equal(r.status, 'broken');
  });

  test('判据5：有名无值 ⇒ broken（双条件缺件，与 O-9 同族）', () => {
    const r = resolveInnerReconnect(
      { authMode: 'bearer-enforced', providerOptions: { bearerEnvName: 'WINVM_T' } },
      envWith('WINVM_T', '  '),
    );
    assert.equal(r.status, 'broken');
    assert.match(r.reason, /有名无值|无值/);
  });

  test('判据6：配了且 env 有值 ⇒ unverified（配置在位只是必要条件，不谎称已证）', () => {
    const r = resolveInnerReconnect(
      { authMode: 'bearer-enforced', providerOptions: { bearerEnvName: 'WINVM_T' } },
      envWith('WINVM_T', TOKEN),
    );
    assert.equal(r.status, 'unverified');
    assert.match(r.reason, /实证/);
  });

  test('泄漏纪律：任何分支 reason 绝不含 env 中的凭据值', () => {
    const env = envWith('WINVM_T', TOKEN);
    for (const view of [
      { authMode: 'bearer-enforced' },
      { authMode: 'bearer-enforced', providerOptions: { bearerEnvName: 'WINVM_T' } },
      { authMode: 'loopback-only', providerOptions: { bearerEnvName: 'WINVM_T' } },
    ]) {
      const r = resolveInnerReconnect(view, env);
      assert.ok(!r.reason.includes(TOKEN), `reason 泄漏凭据：${r.reason}`);
    }
  });
});

/* ============================================================================
 * C. shouldFailClosedStart —— 决策表全 18 格穷举
 * ========================================================================== */

describe('P2-T5 · fail-closed 决策表（§13 Q4）', () => {
  const AUTH_MODES = ['loopback-only', 'bearer-configured-missing', 'bearer-enforced'];
  const STATUSES = ['ok', 'broken', 'unverified'];

  test('全 18 格穷举：仅 enforced∧broken 有权拒启/回滚告警，其余 16 格恒 {false,false}', () => {
    for (const authMode of AUTH_MODES) {
      for (const innerReconnect of STATUSES) {
        for (const failClosed of [true, false]) {
          const d = shouldFailClosedStart({ authMode, innerReconnect, failClosed });
          const expectRefuse = authMode === 'bearer-enforced' && innerReconnect === 'broken' && failClosed;
          const expectRollback = authMode === 'bearer-enforced' && innerReconnect === 'broken' && !failClosed;
          assert.equal(
            d.refuse,
            expectRefuse,
            `格 [${authMode}, ${innerReconnect}, failClosed=${failClosed}] refuse 漂移：${JSON.stringify(d)}`,
          );
          assert.equal(d.rollbackWarn, expectRollback, `格 [${authMode}, ${innerReconnect}, ${failClosed}] rollbackWarn 漂移`);
        }
      }
    }
  });

  test('关键格①：enforced ∧ broken ∧ failClosed=true ⇒ **拒启**（唯一拒启形态）', () => {
    const d = shouldFailClosedStart({ authMode: 'bearer-enforced', innerReconnect: 'broken', failClosed: true });
    assert.deepEqual(d, { refuse: true, rollbackWarn: false });
  });

  test('关键格②：enforced ∧ broken ∧ failClosed=false ⇒ 放行 + 回滚位告警（绝不静默）', () => {
    const d = shouldFailClosedStart({ authMode: 'bearer-enforced', innerReconnect: 'broken', failClosed: false });
    assert.deepEqual(d, { refuse: false, rollbackWarn: true });
  });

  test('关键格③：unverified ∧ failClosed=true ⇒ 不拒（探针故障不得升级成可用性事故 —— PR3）', () => {
    for (const authMode of AUTH_MODES) {
      const d = shouldFailClosedStart({ authMode, innerReconnect: 'unverified', failClosed: true });
      assert.equal(d.refuse, false, `authMode=${authMode} 的 unverified 格必须放行`);
    }
  });

  test('默认态全绿：loopback-only（现网出厂形态）任何 status/failClosed 组合都不拒启', () => {
    for (const innerReconnect of STATUSES) {
      for (const failClosed of [true, false]) {
        assert.equal(
          shouldFailClosedStart({ authMode: 'loopback-only', innerReconnect, failClosed }).refuse,
          false,
        );
      }
    }
  });
});

/* ============================================================================
 * D. buildBearerSelfCheckAuditEntry —— 链上裸条目形态（O-7 口径）
 * ========================================================================== */

describe('P2-T5 · 自检链上条目 buildBearerSelfCheckAuditEntry', () => {
  const mkInput = (over) => ({
    traceId: 'tr-selfcheck-1',
    authMode: 'loopback-only',
    selfCheck: { code: 'not-mounted', ok: true, reason: '未挂载' },
    innerReconnect: { status: 'unverified', reason: '默认态只观测' },
    failClosed: true,
    refuse: false,
    startedAtMs: Date.now(),
    ...over,
  });
  const AUDIT_ID = 'aud-fixed-1';

  test('默认态（未挂载）：ok:true、matchedRule=bearer-selfcheck:not-mounted、形状字段逐一对齐自发条目范式', () => {
    const e = buildBearerSelfCheckAuditEntry(mkInput({}), () => AUDIT_ID);
    assert.equal(e.auditId, AUDIT_ID);
    assert.equal(e.traceId, 'tr-selfcheck-1');
    assert.match(e.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    assert.equal(e.principal.host, 'vm-service');
    assert.equal(e.principal.channel, 'internal');
    assert.equal(typeof e.principal.user, 'string');
    assert.equal(e.capabilityId, 'meta.audit.chain');
    assert.equal(e.risk, 'L0');
    assert.equal(e.policyDecision.allowed, true);
    assert.equal(e.policyDecision.matchedRule, 'bearer-selfcheck:not-mounted');
    assert.equal(e.result.ok, true);
    assert.equal(e.ext.kind, 'bearer-selfcheck');
    assert.equal(e.ext.refused, false);
    assert.equal(e.ext.failClosed, true);
    assert.ok(Number.isInteger(e.durationMs) && e.durationMs >= 0);
    assert.deepEqual(e.params, {
      authMode: 'loopback-only',
      selfCheckCode: 'not-mounted',
      innerReconnect: 'unverified',
      failClosed: true,
      refused: false,
    });
  });

  test('最恶形态单独成码：mounted ∧ innerBroken ⇒ matchedRule=bearer-selfcheck:inner-reconnect-broken 且 ok:false', () => {
    const e = buildBearerSelfCheckAuditEntry(
      mkInput({
        authMode: 'bearer-enforced',
        selfCheck: { code: 'mounted-pass', ok: true, reason: '挂载求值通过' },
        innerReconnect: { status: 'broken', reason: '回连必 401' },
      }),
      () => AUDIT_ID,
    );
    // innerBroken 优先于 selfCheck.ok ⇒ 挂载合格也压不住「回连必断」的单独成码（可 grep 一条码得全部误开轮）
    assert.equal(e.policyDecision.matchedRule, 'bearer-selfcheck:inner-reconnect-broken');
    assert.equal(e.result.ok, false);
    assert.match(e.result.summary, /零副作用虚假完成/);
    assert.match(e.result.summary, /SECURITY-GOVERNANCE §2\.1/);
  });

  test('挂载漂移形态（非 broken）⇒ matchedRule=bearer-selfcheck:<code>（码直进规则串）', () => {
    const e = buildBearerSelfCheckAuditEntry(
      mkInput({
        authMode: 'bearer-enforced',
        selfCheck: { code: 'mounted-fail-guard-always-allow', ok: false, reason: '永 allow 漂移' },
        innerReconnect: { status: 'ok', reason: '探针实证可用' },
      }),
      () => AUDIT_ID,
    );
    assert.equal(e.policyDecision.matchedRule, 'bearer-selfcheck:mounted-fail-guard-always-allow');
    assert.equal(e.result.ok, false);
    assert.match(e.result.summary, /放行（enforceBearerFailClosed=true）/, '非拒启轮的 summary 必须透出开关事实');
  });

  test('挂载合格 ∧ 回连 ok ⇒ bearer-selfcheck:mounted-pass 且 ok:true（拒启权力不外溢到合格轮）', () => {
    const e = buildBearerSelfCheckAuditEntry(
      mkInput({
        authMode: 'bearer-enforced',
        selfCheck: { code: 'mounted-pass', ok: true, reason: '通过' },
        innerReconnect: { status: 'ok', reason: '探针实证' },
      }),
      () => AUDIT_ID,
    );
    assert.equal(e.policyDecision.matchedRule, 'bearer-selfcheck:mounted-pass');
    assert.equal(e.result.ok, true);
  });

  test('拒启轮：refuse=true ⇒ ext.refused=true 且 summary 记「拒绝进入服务态」（证据先落链再抛的文本面）', () => {
    const e = buildBearerSelfCheckAuditEntry(
      mkInput({
        authMode: 'bearer-enforced',
        selfCheck: { code: 'mounted-pass', ok: true, reason: '通过' },
        innerReconnect: { status: 'broken', reason: '回连必 401' },
        refuse: true,
      }),
      () => AUDIT_ID,
    );
    assert.equal(e.ext.refused, true);
    assert.match(e.result.summary, /fail-closed 拒绝进入服务态/);
  });

  test('authMode≠enforced 时 selfCheck/inner 皆不拉低 ok（未挂载不是故障，判序与 resolveAuthMode 同源）', () => {
    const e = buildBearerSelfCheckAuditEntry(
      mkInput({
        authMode: 'bearer-configured-missing',
        selfCheck: { code: 'not-mounted', ok: true, reason: '未挂载' },
        innerReconnect: { status: 'broken', reason: 'x' },
      }),
      () => AUDIT_ID,
    );
    // 半开态下 broken 推理本就无意义（守卫没挂 ⇒ 回连必通），但**事实陈述照抄**输入面：
    // innerBroken 的单独成码仍生效（grep 口径宁滥勿缺），ok 却因 mounted=false 恒 true。
    assert.equal(e.result.ok, true);
    assert.equal(e.policyDecision.matchedRule, 'bearer-selfcheck:inner-reconnect-broken');
  });

  test('泄漏纪律：条目全文（params/summary/reason 拷贝面）绝不含凭据值', () => {
    const e = buildBearerSelfCheckAuditEntry(
      mkInput({ innerReconnect: { status: 'broken', reason: `env 名 WINVM_T 无值（token=${TOKEN} 在场也不注入）` } }),
      () => AUDIT_ID,
    );
    // 调用方喂进来的 reason 是**输入面**（服务端从不拼凭据）；本测试锁定 builder 自身
    // 不新增任何凭据派生值：把条目序列化后剔除输入 reason 再扫。
    const serialized = JSON.stringify({ ...e, ext: { ...e.ext, innerReconnect: {} }, result: {} });
    assert.ok(!serialized.includes(TOKEN), 'builder 输出面泄漏凭据');
  });
});

/* ============================================================================
 * E. buildSecurityHealth —— K-13 纯附加（缺席即旧形状，在场即防御拷贝）
 * ========================================================================== */

describe('P2-T5 · /health.security 形状（纯附加）', () => {
  test('两快照键都缺席 ⇒ 键集恰 {loopbackOnly,boundLoopback,authMode}（旧读者逐字旧形状）', () => {
    const h = buildSecurityHealth({ boundHost: '127.0.0.1', env: {} });
    assert.deepEqual(Object.keys(h).sort(), ['authMode', 'boundLoopback', 'loopbackOnly']);
    assert.equal('bearerSelfCheck' in h, false, '不得写显式 undefined 键');
    assert.equal('innerReconnect' in h, false);
  });

  test('两快照键在场 ⇒ 逐值透出且为防御性拷贝（外部改动不影响快照输出）', () => {
    const selfCheck = { code: 'mounted-pass', ok: true, reason: '通过' };
    const inner = { status: 'broken', reason: 'r' };
    const h = buildSecurityHealth({ boundHost: '127.0.0.1', env: {}, selfCheck, innerReconnect: inner });
    assert.deepEqual(h.bearerSelfCheck, selfCheck);
    assert.deepEqual(h.innerReconnect, inner);
    assert.notEqual(h.bearerSelfCheck, selfCheck, '必须浅拷贝（快照对象与入参解引用）');
    selfCheck.ok = false;
    assert.equal(h.bearerSelfCheck.ok, true, '入参事后漂移不得污染已透出形状');
  });

  test('authMode 与守卫同源：注入 env 双条件齐 ⇒ bearer-enforced；有名无值 ⇒ bearer-configured-missing', () => {
    const enforced = buildSecurityHealth({
      enforceBearer: true,
      tokenEnv: 'WINVM_T',
      boundHost: '127.0.0.1',
      env: { WINVM_T: TOKEN },
    });
    assert.equal(enforced.authMode, 'bearer-enforced');
    const halfOpen = buildSecurityHealth({ enforceBearer: true, tokenEnv: 'WINVM_T', boundHost: '127.0.0.1', env: {} });
    assert.equal(halfOpen.authMode, 'bearer-configured-missing');
    // 与 resolveAuthMode 逐字同判据（事实面=执行面同源的机器证明）
    assert.equal(halfOpen.authMode, resolveAuthMode(true, 'WINVM_T', {}));
  });

  test('endpointAllowlist 负空间：任何输入组合都不得产出该键（豁免面不可配）', () => {
    const h = buildSecurityHealth({ boundHost: '127.0.0.1', env: {}, selfCheck: { code: 'not-mounted', ok: true, reason: 'r' } });
    assert.equal('endpointAllowlist' in h, false);
    assert.equal(JSON.stringify(h).includes('endpointAllowlist'), false);
  });
});

/* ============================================================================
 * F. resolveEnforceBearerFailClosed + validateServiceConfig 新告警
 * ========================================================================== */

describe('P2-T5 · 配置面（enforceBearerFailClosed）', () => {
  test('解析判据「显式 false 才关」：undefined/{}/true/非布尔 皆 true；仅 false ⇒ false', () => {
    assert.equal(resolveEnforceBearerFailClosed(undefined), true);
    assert.equal(resolveEnforceBearerFailClosed({}), true);
    assert.equal(resolveEnforceBearerFailClosed({ enforceBearerFailClosed: true }), true);
    assert.equal(resolveEnforceBearerFailClosed({ enforceBearerFailClosed: 'false' }), true);
    assert.equal(resolveEnforceBearerFailClosed({ enforceBearerFailClosed: 0 }), true);
    assert.equal(resolveEnforceBearerFailClosed({ enforceBearerFailClosed: false }), false);
  });

  test('出厂默认显式写死 true（工厂形态自证，不靠 ?? 兜底漂移）', () => {
    assert.equal(DEFAULT_SERVICE_CONFIG.security.enforceBearerFailClosed, true);
    assert.equal(resolveEnforceBearerFailClosed(DEFAULT_SERVICE_CONFIG.security), true);
  });

  test('无误报：DEFAULT_SERVICE_CONFIG ⇒ errors 零、failClosed 相关 warnings 零', () => {
    const v = validateServiceConfig(DEFAULT_SERVICE_CONFIG);
    assert.deepEqual(v.errors, []);
    assert.equal(v.warnings.filter((w) => w.includes('enforceBearerFailClosed')).length, 0);
  });

  test('类型卫生告警：非布尔值（"false"/0）⇒ 恰一条「不是布尔值」warning、errors 零（文本问题不拒启）', () => {
    for (const bad of ['false', 0, null]) {
      const cfg = { ...DEFAULT_SERVICE_CONFIG, security: { enforceBearerFailClosed: bad } };
      const v = validateServiceConfig(cfg);
      const hits = v.warnings.filter((w) => w.includes('不是布尔值'));
      assert.equal(hits.length, 1, `值=${JSON.stringify(bad)} 应恰一条卫生告警，实得 ${hits.length}`);
      assert.match(hits[0], /按默认值 true 处理/);
      assert.match(hits[0], /要回滚请写布尔 false/);
      assert.deepEqual(v.errors, [], '配置卫生只出 warning，拒启权力只在 server.ts 那条判据上');
    }
  });

  test('回滚位显形：false ⇒ 恰一条「回滚位已生效」warning 且文案含 B3 危害形态 + 复原指引', () => {
    const cfg = { ...DEFAULT_SERVICE_CONFIG, security: { enforceBearerFailClosed: false } };
    const v = validateServiceConfig(cfg);
    const hits = v.warnings.filter((w) => w.includes('回滚位已生效'));
    assert.equal(hits.length, 1);
    assert.match(hits[0], /零副作用虚假完成/, '回滚文案必须点名真实危害形态（两段式退化），不是含糊的"可能失败"');
    assert.match(hits[0], /恢复默认 true|删掉本键/, '文案须给出可行动的复原路径');
    assert.deepEqual(v.errors, []);
  });
});

/* ============================================================================
 * G. server.ts 装配面静态守卫（沙箱不能起服务 ⇒ 钉源码；真机面由 qa/r19 另证）
 * ========================================================================== */

describe('P2-T5 · server.ts 装配面（静态守卫）', () => {
  test('自检四件套 + 回滚解析在位（装配唯一事实源，防薄封装漂移）', () => {
    assert.match(SERVER_SRC, /runBearerMountSelfCheck\(\{/, '挂载自检装配点在位');
    assert.match(SERVER_SRC, /resolveInnerReconnect\(\{/, '回连判定装配点在位');
    assert.match(SERVER_SRC, /shouldFailClosedStart\(\{/, 'fail-closed 决策装配点在位');
    assert.match(SERVER_SRC, /resolveEnforceBearerFailClosed\(/, '回滚位读取走 core 统一判据');
    assert.match(SERVER_SRC, /buildBearerSelfCheckAuditEntry\(/, '链上条目走纯构造器');
  });

  test('拒启路径：证据先落链（recordBearerSelfCheck(true)）→ 置收口位 → stop 已启动件 → 才抛（零泄漏顺序钉）', () => {
    const rcAt = SERVER_SRC.indexOf('await recordBearerSelfCheck(true);');
    assert.ok(rcAt > 0, '拒启轮落链调用缺席');
    const closedAt = SERVER_SRC.indexOf('serviceClosed = true;', rcAt);
    const bridgeAt = SERVER_SRC.indexOf("runtime.bridge.stop()", rcAt);
    const throwAt = SERVER_SRC.indexOf('throw new Error(', rcAt);
    assert.ok(closedAt > rcAt && bridgeAt > rcAt && throwAt > bridgeAt, '顺序漂移：必须 落链<收口位<bring.stop<throw');
    assert.ok(throwAt - rcAt < 2000, '拒启块内不得插入无关长段（顺序守卫的可读性预算）');
    const csAt = SERVER_SRC.indexOf('const server = createServer(');
    assert.ok(rcAt < csAt, '拒启判据必须在 createServer 之前（HTTP 端口/监听器零泄漏）');
  });

  test('close() 收口位：serviceClosed=true 是 close() 首行动作（先于 sessionMonitor.stop/pendingApprovals.close）', () => {
    const closeAt = SERVER_SRC.indexOf('async close()');
    assert.ok(closeAt > 0);
    const flagAt = SERVER_SRC.indexOf('serviceClosed = true;', closeAt);
    const monitorAt = SERVER_SRC.indexOf('sessionMonitor.stop();', closeAt);
    assert.ok(flagAt > 0 && flagAt < monitorAt, '收口位必须置顶，否则在途 fire-and-forget 段与关闭竞态');
  });

  test('fire-and-forget 三段告警齐：回滚位 warn / 挂载漂移 error / broken warn / unverified info（降级绝不静默）', () => {
    assert.match(SERVER_SRC, /if \(failClosedDecision\.rollbackWarn\) \{\s*\n\s*logger\.warn\(/, '回滚位放行必须显式告警');
    assert.match(SERVER_SRC, /if \(!bearerSelfCheck\.ok\) \{[\s\S]{0,200}?logger\.error\(/, '挂载漂移是最重事实，error 级');
    assert.match(SERVER_SRC, /innerReconnect\.status === 'broken'[\s\S]{0,120}logger\.warn\(/, 'broken 放行轮（回滚位）warn');
  });

  test('/health 喂两快照：buildSecurityHealthSnapshot 调用带 selfCheck+innerReconnect（透出面在位）', () => {
    const at = SERVER_SRC.indexOf('return buildSecurityHealthSnapshot({');
    assert.ok(at > 0);
    const block = SERVER_SRC.slice(at, at + 500);
    assert.match(block, /selfCheck: bearerSelfCheck,/);
    assert.match(block, /innerReconnect,/);
  });
});

/* ============================================================================
 * H. contracts 纯附加 + delivery 默认态自洽
 * ========================================================================== */

describe('P2-T5 · 契约与交付默认态', () => {
  test('bridge.ts SecurityHealth：两新键均可选（K-13 纯附加，旧构造零改动）', () => {
    assert.match(BRIDGE_SRC, /readonly bearerSelfCheck\?:/, 'bearerSelfCheck 必须可选');
    assert.match(BRIDGE_SRC, /readonly innerReconnect\?:/, 'innerReconnect 必须可选');
    const m = BRIDGE_SRC.match(/readonly (bearerSelfCheck|innerReconnect)\??:/g) ?? [];
    assert.equal(m.length, 2, '两处都必须是可选声明（必填化即破坏纯附加）');
  });

  test('audit.ts ext.kind 联合含 bearer-selfcheck（链上取证键的契约在位）', () => {
    assert.match(AUDIT_SRC, /'bearer-selfcheck'/);
  });

  test('delivery/vm-service.config.json 默认态自洽：enforceBearer=false + 无 tokenEnv ⇒ loopback-only 恒不拒启', () => {
    const sec = DELIVERY_CFG.security;
    assert.equal(sec.enforceBearer, false, '默认态裁决 Q3：enforceBearer 保持 OFF');
    assert.equal('tokenEnv' in sec, false, '默认态删掉了 tokenEnv 键（有名无值的半开形态不得出厂即带）');
    assert.equal(sec.enforceBearerFailClosed, true, 'fail-closed 默认开（生效自检无条件进默认，Q3）');
    const authMode = resolveAuthMode(sec.enforceBearer, sec.tokenEnv, {});
    assert.equal(authMode, 'loopback-only');
    const d = shouldFailClosedStart({ authMode, innerReconnect: 'broken', failClosed: resolveEnforceBearerFailClosed(sec) });
    assert.equal(d.refuse, false, '默认态即便回连判 broken 也绝不拒启（只观测不改判）');
  });
});

/**
 * Phase 1 · T4 判据⑤ —— HTTP Bearer 守卫（`packages/vm-service/src/http-guard.ts`）
 *
 * 覆盖设计 `docs/archive/changes/phase1-arch-design.md` §7.4-T4 判据⑤全部分项：
 *  - `enforceBearer=false` ⇒ **路由逐字旧行为**（关键回归：现网
 *    `delivery/vm-service.config.json` 未写该键）；
 *  - `enforceBearer=true` + env 有值 ⇒ 非豁免端点 401、`/health` + agent-card 200、
 *    `/admin/llm-session/reset` 401（后者**不豁免**，它有能力效果）；
 *  - 错误 token 与正确 token 走 `timingSafeEqual`（长度不等先拒，等长常时比较）；
 *  - **O-9 双条件**半开反例（开了开关没发 token / 配了变量名环境无值 ⇒ 守卫不生效，
 *    但 `resolveAuthMode` 必须把它显形成 `bearer-configured-missing`，绝不静默当 enforced）；
 *  - 豁免表**硬编码**（`DEFAULT_EXEMPT_PATHS` 冻结、只读 GET 才豁免）；
 *  - 401 体 `code:'AUTH_REQUIRED'` 是 HTTP 层约定串，**不进** `BridgeErrorCode` 枚举；
 *  - 拒绝**不入审计链**（只 warn）⇒ 未授权探测不占写链配额。
 *
 * 纪律：不起 HTTP 服务、不 spawn ps-bridge、不碰 packages/ 源码（只 import 编译产物）。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  BEARER_UNAUTHORIZED_BODY,
  createBearerGuard,
  DEFAULT_EXEMPT_PATHS,
  isLoopbackHost,
  resolveAuthMode,
  resolveBearerToken,
} from '@winvm/vm-service';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** 源码文本（装配挂载位置判据用；与静态守卫同一读取范式） */
const SERVER_SRC = readFileSync(
  new URL('../../packages/vm-service/src/server.ts', import.meta.url),
  'utf8',
);

const TOKEN = 'a]7Xf3-qd9Lm';
const ENV_NAME = 'WINVM_BEARER_TOKEN_TEST_T4';

/** 构造请求最小面（`GuardableRequest` 的结构性替身）。 */
function req({ method = 'POST', url = '/mcp', authorization } = {}) {
  const headers = {};
  if (authorization !== undefined) headers['authorization'] = authorization;
  return { method, url, headers };
}

/* ===================================================================== */
describe('T4 判据⑤-1 O-9 双条件：resolveBearerToken 的三态归一', () => {
  test('enforceBearer 缺席（现网默认）⇒ undefined（守卫停用）', () => {
    assert.equal(resolveBearerToken(undefined, ENV_NAME, { [ENV_NAME]: TOKEN }), undefined);
    assert.equal(resolveBearerToken(false, ENV_NAME, { [ENV_NAME]: TOKEN }), undefined);
  });

  test('enforceBearer=true 但 env 无值 ⇒ undefined（第二条件不成立）', () => {
    assert.equal(resolveBearerToken(true, ENV_NAME, {}), undefined);
    assert.equal(resolveBearerToken(true, ENV_NAME, { [ENV_NAME]: '' }), undefined);
    // 纯空白同样视为"无值"（配置手滑写空格不得被当成有效凭据）
    assert.equal(resolveBearerToken(true, ENV_NAME, { [ENV_NAME]: '   ' }), undefined);
  });

  test('tokenEnv 名缺席/空白 ⇒ undefined（无可比对目标）', () => {
    assert.equal(resolveBearerToken(true, undefined, { [ENV_NAME]: TOKEN }), undefined);
    assert.equal(resolveBearerToken(true, '   ', { [ENV_NAME]: TOKEN }), undefined);
  });

  test('双条件齐备 ⇒ 返回 trim 后的值', () => {
    assert.equal(resolveBearerToken(true, ENV_NAME, { [ENV_NAME]: `  ${TOKEN}  ` }), TOKEN);
  });

  test('默认 env 源 = process.env（生产装配不传 env ⇒ 读真实环境）', () => {
    process.env[ENV_NAME] = TOKEN;
    try {
      assert.equal(resolveBearerToken(true, ENV_NAME), TOKEN);
    } finally {
      delete process.env[ENV_NAME];
    }
  });
});

/* ===================================================================== */
describe('T4 判据⑤-2 关键回归：enforceBearer=false ⇒ 守卫恒 pass（逐字旧行为）', () => {
  const guard = createBearerGuard({
    enforceBearer: false,
    tokenEnv: ENV_NAME,
    env: { [ENV_NAME]: TOKEN },
  });

  test('即使 env 里有 token，未开开关也一律放行（无 Authorization 头照过）', () => {
    for (const url of ['/mcp', '/a2a', '/audit/receipt', '/admin/llm-session/reset', '/anything']) {
      assert.deepEqual(guard(req({ method: 'POST', url })), { verdict: 'pass' }, url);
    }
  });

  test('开关完全缺席（现网配置形态）⇒ 同样恒 pass', () => {
    const g = createBearerGuard({ env: { [ENV_NAME]: TOKEN } });
    assert.deepEqual(g(req({ method: 'POST', url: '/mcp' })), { verdict: 'pass' });
  });

  test('开了开关但 env 缺值（半开）⇒ 恒 pass（不静默拒绝，降级事实由 authMode 显形）', () => {
    const g = createBearerGuard({ enforceBearer: true, tokenEnv: ENV_NAME, env: {} });
    assert.deepEqual(g(req({ method: 'POST', url: '/mcp' })), { verdict: 'pass' });
  });

  test('装配层第二道闸：guardActive=false 时连 bearerGuard 都不调用（源码文本钉）', () => {
    // 判据⑤要求"逐字旧行为"⇒ 挂载点必须是整体可短路的 if，而不是"调用了但放行"
    // （调用即有 warn 副作用面 / 未来有人改 pass 分支就绕过回归承诺）。
    const guardAt = SERVER_SRC.indexOf('if (guardActive) {');
    const callAt = SERVER_SRC.indexOf("bearerGuard(req as GuardableRequest)");
    assert.notEqual(guardAt, -1, 'server.ts 缺少 `if (guardActive) {` 短路块');
    assert.notEqual(callAt, -1, 'server.ts 未调用 bearerGuard(req)');
    assert.ok(guardAt < callAt, 'guardActive 判据必须先于 bearerGuard 调用');
    assert.ok(
      callAt - guardAt < 200,
      'guardActive 与 bearerGuard 调用必须紧邻（防中途插入其它判据改变短路语义）',
    );
  });
});

/* ===================================================================== */
describe('T4 判据⑤-3 生效态：豁免表 + 401 + 拒绝原因', () => {
  const guard = createBearerGuard({
    enforceBearer: true,
    tokenEnv: ENV_NAME,
    env: { [ENV_NAME]: TOKEN },
  });

  test('GET /health 与 agent-card 豁免（无凭据亦 200 路径）', () => {
    assert.deepEqual(guard(req({ method: 'GET', url: '/health' })), { verdict: 'pass' });
    assert.deepEqual(guard(req({ method: 'GET', url: '/.well-known/agent-card.json' })), {
      verdict: 'pass',
    });
    // 带 query 同样豁免（pathname 判据，不是全串相等）
    assert.deepEqual(guard(req({ method: 'GET', url: '/health?ts=1' })), { verdict: 'pass' });
  });

  test('豁免只对 GET 生效（POST /health 不豁免 —— 防方法混淆绕过）', () => {
    const v = guard(req({ method: 'POST', url: '/health' }));
    assert.equal(v.verdict, 'deny');
    assert.equal(v.reason, 'missing-authorization-header');
  });

  test('/admin/llm-session/reset 不豁免（它有能力效果：杀常驻会话子进程）', () => {
    const v = guard(req({ method: 'POST', url: '/admin/llm-session/reset' }));
    assert.equal(v.verdict, 'deny');
    assert.equal(v.reason, 'missing-authorization-header');
  });

  test('DEFAULT_EXEMPT_PATHS 恰两项且被冻结（硬编码不可配）', () => {
    assert.deepEqual([...DEFAULT_EXEMPT_PATHS], ['/health', '/.well-known/agent-card.json']);
    assert.ok(Object.isFrozen(DEFAULT_EXEMPT_PATHS));
    assert.throws(() => DEFAULT_EXEMPT_PATHS.push('/x'), TypeError, '冻结数组不得被追加豁免项');
  });

  test('缺 Authorization 头 ⇒ missing-authorization-header', () => {
    assert.deepEqual(guard(req({ method: 'POST', url: '/mcp' })), {
      verdict: 'deny',
      reason: 'missing-authorization-header',
    });
  });

  test('非 Bearer scheme / 空凭据 ⇒ malformed-authorization-header', () => {
    assert.equal(guard(req({ url: '/mcp', authorization: 'Basic abc' })).reason, 'malformed-authorization-header');
    assert.equal(guard(req({ url: '/mcp', authorization: 'bearer a]7Xf3-qd9Lm' })).reason, 'malformed-authorization-header');
    assert.equal(guard(req({ url: '/mcp', authorization: 'Bearer ' })).reason, 'malformed-authorization-header');
    assert.equal(guard(req({ url: '/mcp', authorization: 'Bearer' })).reason, 'malformed-authorization-header');
    assert.equal(guard(req({ url: '/mcp', authorization: 42 })).reason, 'malformed-authorization-header');
  });

  test('token 不等 ⇒ token-mismatch（等长与不等长两条路径都落同一原因码）', () => {
    const sameLen = 'zzzzzzzzzzzz';
    assert.equal(sameLen.length, TOKEN.length);
    assert.equal(guard(req({ url: '/mcp', authorization: `Bearer ${sameLen}` })).reason, 'token-mismatch');
    assert.equal(guard(req({ url: '/mcp', authorization: `Bearer wrong` })).reason, 'token-mismatch');
  });

  test('正确 token ⇒ pass', () => {
    assert.deepEqual(guard(req({ url: '/mcp', authorization: `Bearer ${TOKEN}` })), { verdict: 'pass' });
  });

  test('数组型 header 取首元素（Node 允许但罕见）', () => {
    assert.deepEqual(guard(req({ url: '/mcp', authorization: [`Bearer ${TOKEN}`] })), { verdict: 'pass' });
    assert.equal(guard(req({ url: '/mcp', authorization: ['Bearer nope'] })).reason, 'token-mismatch');
  });

  test('非法 url 串保守取全串 ⇒ 不命中豁免（fail-closed）', () => {
    const v = guard(req({ method: 'GET', url: '::not-a-url::' }));
    assert.equal(v.verdict, 'deny');
  });
});

/* ===================================================================== */
describe('T4 判据⑤-4 常时比较（timingSafeEqual，长度不等先拒）', () => {
  const guard = createBearerGuard({
    enforceBearer: true,
    tokenEnv: ENV_NAME,
    env: { [ENV_NAME]: TOKEN },
  });

  test('长度不等的凭据不抛（timingSafeEqual 对不等长会 throw ⇒ 长度判据必须前置）', () => {
    for (const guess of ['', 'a', 'ab', 'abcdefghij', 'x'.repeat(200)]) {
      const v = guard(req({ url: '/mcp', authorization: `Bearer ${guess || 'y'}` }));
      assert.equal(v.verdict, 'deny');
      assert.equal(v.reason, 'token-mismatch', `长度 ${guess.length} 应走常时比较早退而非抛错`);
    }
  });

  test('等长逐字节错一位 ⇒ token-mismatch（比较确实覆盖全部字节）', () => {
    const mutated = TOKEN.slice(0, -1) + (TOKEN.endsWith('m') ? 'n' : 'm');
    assert.equal(mutated.length, TOKEN.length);
    assert.notEqual(mutated, TOKEN);
    assert.equal(guard(req({ url: '/mcp', authorization: `Bearer ${mutated}` })).reason, 'token-mismatch');
  });

  test('源码钉：tokenEquals 内长度判据先于 timingSafeEqual（顺序即判据）', () => {
    const guardSrc = readFileSync(new URL('../../packages/vm-service/src/http-guard.ts', import.meta.url), 'utf8');
    const lenAt = guardSrc.indexOf('presented.length !== expected.length');
    const tseAt = guardSrc.indexOf('timingSafeEqual(');
    assert.notEqual(lenAt, -1, '长度早退判据缺席');
    assert.notEqual(tseAt, -1, '未使用 timingSafeEqual');
    assert.ok(lenAt < tseAt, '长度判据必须先于常时比较');
  });

  test('拒绝只 warn、不入审计链（取证面纪律）', () => {
    const warns = [];
    const g = createBearerGuard({
      enforceBearer: true,
      tokenEnv: ENV_NAME,
      env: { [ENV_NAME]: TOKEN },
      logger: { warn: (msg, meta) => warns.push({ msg, meta }) },
    });
    g(req({ method: 'POST', url: '/mcp', authorization: 'Bearer nope' }));
    assert.equal(warns.length, 1);
    assert.match(warns[0].msg, /bearer 守卫拒绝请求/);
    assert.equal(warns[0].meta.reason, 'token-mismatch');
    assert.ok('presentedDigest' in warns[0].meta, '日志须给不可还原指纹以分辨"发错"与"没发"');
    assert.notEqual(warns[0].meta.presentedDigest, 'Bearer nope');
    assert.doesNotMatch(JSON.stringify(warns), /nope/, '凭据原文绝不得落日志');
  });

  test('logger 缺席 ⇒ 纯判决零副作用（可脱服务直测）', () => {
    const g = createBearerGuard({ enforceBearer: true, tokenEnv: ENV_NAME, env: { [ENV_NAME]: TOKEN } });
    assert.equal(g(req({ url: '/mcp' })).verdict, 'deny');
  });
});

/* ===================================================================== */
describe('T4 判据⑤-5 401 响应体契约', () => {
  test('体 = { error:"unauthorized", code:"AUTH_REQUIRED" } 且冻结', () => {
    assert.deepEqual({ ...BEARER_UNAUTHORIZED_BODY }, { error: 'unauthorized', code: 'AUTH_REQUIRED' });
    assert.ok(Object.isFrozen(BEARER_UNAUTHORIZED_BODY));
  });

  test('装配层用它回 401（不是 403/400）', () => {
    assert.match(SERVER_SRC, /sendJson\(res, 401, BEARER_UNAUTHORIZED_BODY\)/);
  });

  test('AUTH_REQUIRED 不进 BridgeErrorCode 枚举（HTTP 层专属，契约边界）', () => {
    // 只切**联合类型体**（`export type BridgeErrorCode =` 到下一个 `;`）——
    // 文件头注释里合法出现 'AUTH_REQUIRED'（申明的正是"不加它"），整文件 doesNotMatch 会误红。
    const errorsSrc = readFileSync(new URL('../../packages/contracts/src/errors.ts', import.meta.url), 'utf8');
    const start = errorsSrc.indexOf('export type BridgeErrorCode =');
    assert.notEqual(start, -1);
    const union = errorsSrc.slice(start, errorsSrc.indexOf('export interface', start));
    assert.doesNotMatch(union, /^\s*\|\s*'AUTH_REQUIRED'/mu, "HTTP 层串不得混入 BridgeErrorCode 枚举成员");
    // DEFAULT_RETRYABLE 在 union 切片之外 ⇒ 对它单独用全文键位判据
    //（注释里出现的是 `code:'AUTH_REQUIRED'`，冒号在引号**前**，不会命中 `AUTH_REQUIRED:`）
    assert.doesNotMatch(errorsSrc, /AUTH_REQUIRED\s*:/, '不得作为 DEFAULT_RETRYABLE 的键（只有枚举成员才配 retryable）');
    // 反向自证：确实在枚举里有 TASK_CANCELED（本批新增成员）⇒ 切片范围正确、断言非空转
    assert.match(union, /'TASK_CANCELED'/);
  });
});

/* ===================================================================== */
describe('T4 判据⑤-6 authMode 三态与守卫同源（不得自相矛盾）', () => {
  test('未开开关 ⇒ loopback-only', () => {
    assert.equal(resolveAuthMode(undefined, ENV_NAME, { [ENV_NAME]: TOKEN }), 'loopback-only');
    assert.equal(resolveAuthMode(false, ENV_NAME, { [ENV_NAME]: TOKEN }), 'loopback-only');
  });

  test('双条件齐备 ⇒ bearer-enforced（与 resolveBearerToken 有值严格等价）', () => {
    assert.equal(resolveAuthMode(true, ENV_NAME, { [ENV_NAME]: TOKEN }), 'bearer-enforced');
  });

  test('开开关无 env 值 ⇒ bearer-configured-missing（必须显形的降级态）', () => {
    assert.equal(resolveAuthMode(true, ENV_NAME, {}), 'bearer-configured-missing');
  });

  test('只配 tokenEnv 名但环境无值 ⇒ bearer-configured-missing（意图在场、事实缺席）', () => {
    assert.equal(resolveAuthMode(undefined, ENV_NAME, {}), 'bearer-configured-missing');
    assert.equal(resolveAuthMode(undefined, ENV_NAME, { [ENV_NAME]: '  ' }), 'bearer-configured-missing');
  });

  test('名与值都缺 ⇒ loopback-only（根本没配过，不算降级）', () => {
    assert.equal(resolveAuthMode(undefined, undefined, {}), 'loopback-only');
  });

  test('同源不变式：authMode==="bearer-enforced" ⇔ resolveBearerToken!==undefined（穷举 8 组合）', () => {
    const combos = [];
    for (const enforce of [undefined, false, true]) {
      for (const name of [undefined, '  ', ENV_NAME]) {
        for (const value of [undefined, '', TOKEN]) combos.push({ enforce, name, value });
      }
    }
    for (const { enforce, name, value } of combos) {
      const env = name === undefined || name === '  ' ? {} : { [ENV_NAME]: value };
      const hasToken = resolveBearerToken(enforce, name, env) !== undefined;
      const mode = resolveAuthMode(enforce, name, env);
      assert.equal(mode === 'bearer-enforced', hasToken, JSON.stringify({ enforce, name, value }));
      // 守卫判决必须与之一致：hasToken=false ⇒ 任何非豁免请求都 pass
      const g = createBearerGuard({ enforceBearer: enforce, tokenEnv: name, env });
      assert.equal(g(req({ url: '/mcp' })).verdict === 'pass', !hasToken);
    }
  });
});

/* ===================================================================== */
describe('T4 判据⑤-7 isLoopbackHost 与 core 判据同枚举', () => {
  test('四个回环形态为真；其余为假', () => {
    for (const h of ['127.0.0.1', 'localhost', '::1', '[::1]', ' 127.0.0.1 ']) {
      assert.equal(isLoopbackHost(h), true, h);
    }
    // 刻意不宽容 127.x 前缀：与 core/config/index.ts 的私有 isLoopback 逐字同枚举
    for (const h of ['0.0.0.0', '127.0.0.2', '10.0.0.1', '::', '', undefined]) {
      assert.equal(isLoopbackHost(h), false, String(h));
    }
  });

  test('与 core 侧实现的枚举集合一致（防两处判据漂移）', () => {
    const coreSrc = readFileSync(new URL('../../packages/core/src/config/index.ts', import.meta.url), 'utf8');
    const body = coreSrc.slice(coreSrc.indexOf('function isLoopback('));
    for (const lit of ['127.0.0.1', 'localhost', '::1', '[::1]']) {
      assert.ok(body.includes(`'${lit}'`), `core 侧缺 '${lit}'，两侧判据已漂移`);
    }
    assert.doesNotMatch(body, /startsWith\(/, 'core 侧若引入前缀宽容，本模块必须同步（当前未同步 ⇒ 红）');
  });
});

/* ===================================================================== */
describe('T4 判据⑤-8 挂载位置：守卫先于所有路由分发', () => {
  test('guard 块位于每个路由 if 之前（含 admin / mcp / a2a / receipt / 405）', () => {
    const guardAt = SERVER_SRC.indexOf('if (guardActive) {');
    assert.notEqual(guardAt, -1);
    const marks = [
      "if (req.method !== 'POST' && req.method !== 'GET')",
      "if (path === '/health' && req.method === 'GET')",
      "if (path === '/mcp' && req.method === 'POST')",
      "if (path === '/audit/receipt'",
      "if (path === '/a2a'",
      "'/admin/llm-session/reset'",
    ];
    for (const m of marks) {
      const at = SERVER_SRC.indexOf(m);
      assert.notEqual(at, -1, `路由锚缺席：${m}`);
      assert.ok(guardAt < at, `守卫必须早于路由分发：${m}`);
    }
  });

  test('挂载点在 path 解析之后（豁免判据需要 pathname）', () => {
    const pathAt = SERVER_SRC.indexOf('const path = url.pathname;');
    const guardAt = SERVER_SRC.indexOf('if (guardActive) {');
    assert.ok(pathAt !== -1 && pathAt < guardAt);
  });

  test('sliceRoute 三对相邻锚未被守卫侵入（区间起点终点仍成立）', () => {
    // kn1-e-shape 用 indexOf(起点) → indexOf(终点, 起点+长度) 切路由片段；
    // 守卫块在全部路由 if **之前** ⇒ 不得把任何起点/终点推进别的切片区间内。
    const pairs = [
      ["if (path === '/mcp' && req.method === 'POST')", "if (path === '/audit/receipt'"],
      ["if (path === '/audit/receipt' && req.method === 'GET')", "if (path === '/a2a' && req.method === 'POST')"],
    ];
    for (const [start, end] of pairs) {
      const i = SERVER_SRC.indexOf(start);
      const j = SERVER_SRC.indexOf(end, i + start.length);
      assert.notEqual(i, -1, `起点锚缺席：${start}`);
      assert.notEqual(j, -1, `终点锚缺席：${end}`);
    }
  });

  test('WINVM_ADMIN_ENDPOINT 读取仍恰 1 处（守卫未复制门控判据）', () => {
    const n = (SERVER_SRC.match(/process\.env\['WINVM_ADMIN_ENDPOINT'\]/g) ?? []).length;
    assert.equal(n, 1);
  });

  test('守卫不新增审计调用（audit.append 调用点计数不因区 8 增加）', () => {
    // 拒绝只 warn；若将来有人把 401 也落链，本断言会红 ⇒ 强制走评审
    assert.doesNotMatch(SERVER_SRC, /append\(BEARER_UNAUTHORIZED_BODY/);
  });
});

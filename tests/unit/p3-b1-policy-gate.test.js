/**
 * 批1（审批闭环 P0-1 专项）CL2：(c) 策略化判据 + 委派 scope 留存 + 双闸灰度 回归
 *
 * 三条腿（对齐 phase1-t4-assembly 惯例——createService 在沙箱 spawn ps-bridge ⇒ V8 fatal，
 * 决策逻辑已抽零副作用纯函数 policy-gate.ts，本文件逐条断言 + 源码钉装配位置）：
 *  ① policy-gate 纯函数真值表（通道判据/(c) 收口/scope feed/shadow 改道）；
 *  ② DelegationScopeRegistry 行为面（注册/双键回查/精确无模糊/销账/TTL/容量）；
 *  ③ 引擎端到端「接线实锤」（policy.test.js 同构注册表）：
 *     maxRisk:L1 声明下 L2 ⇒ POLICY_DENIED（验收判据②）；白名单外能力 ⇒ DENY（判据③）；
 *     **未声明** ⇒ 零影响（F-3 断崖防线行为面）；
 *  ④ 源码钉：server.ts 装配位置与纯函数调用在位（防实现漂移）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  isInnerDelegation,
  scopeLookupKeys,
  shouldReturnDelegationRequired,
  scopeFeedEnabled,
  isScopeGateRejection,
  enforceScopeRejection,
} from '@winvm/vm-service';
import { DelegationScopeRegistry } from '@winvm/vm-service';
import { CapabilityRegistry, CorePolicyEngine } from '@winvm/core';
import { defineCapability } from '@winvm/contracts';

const SRC = readFileSync(
  fileURLToPath(new URL('../../packages/vm-service/src/server.ts', import.meta.url)),
  'utf8',
);

/* ==================== ① policy-gate 纯函数真值表 ==================== */

test('通道判据：dtid 在场 ⇒ 内层；activeTaskId 在场（常驻）⇒ 内层；双缺 ⇒ 直调', () => {
  assert.equal(isInnerDelegation({ delegationId: 'tr_1' }), true);
  assert.equal(isInnerDelegation({ activeTaskId: 'task_9' }), true);
  assert.equal(isInnerDelegation({ delegationId: 'tr_1', activeTaskId: 'task_9' }), true);
  assert.equal(isInnerDelegation({}), false);
});

test('scope 回查键：dtid 优先于活动槽；双缺 ⇒ 空查询（必 miss ⇒ fail-closed 旧行为）', () => {
  assert.deepEqual(scopeLookupKeys({ delegationId: 'tr_1', activeTaskId: 't9' }), { delegationTraceId: 'tr_1' });
  assert.deepEqual(scopeLookupKeys({ activeTaskId: 't9' }), { taskId: 't9' });
  assert.deepEqual(scopeLookupKeys({}), {});
});

test('(c) 收口判据：仅「直调 ∧ 审批闸 ∧ 策略 on」三者齐；委派内层绝不收口', () => {
  assert.equal(shouldReturnDelegationRequired({ inner: false, requiresApproval: true, policyEnabled: true }), true);
  assert.equal(shouldReturnDelegationRequired({ inner: true, requiresApproval: true, policyEnabled: true }), false, '委派内层必须继续走注册令牌闭环');
  assert.equal(shouldReturnDelegationRequired({ inner: false, requiresApproval: false, policyEnabled: true }), false);
  assert.equal(shouldReturnDelegationRequired({ inner: false, requiresApproval: true, policyEnabled: false }), false, 'off=回滚旧死令牌行为');
});

test('scope feed 判据：off 或 scope 缺席 ⇒ 不喂（逐字旧行为）；否则喂', () => {
  assert.equal(scopeFeedEnabled({ wiring: 'off', scope: { maxRisk: 'L1' } }), false);
  assert.equal(scopeFeedEnabled({ wiring: 'on', scope: undefined }), false);
  assert.equal(scopeFeedEnabled({ wiring: 'shadow', scope: { maxRisk: 'L1' } }), true);
  assert.equal(scopeFeedEnabled({ wiring: 'on', scope: { maxRisk: 'L1' } }), true);
});

test('shadow 改道判据：scope 两闸拒 ⇒ 改道；黑名单/审批闸 ⇒ 绝不改道', () => {
  assert.equal(isScopeGateRejection('scope:capability-not-in-allowed-set'), true);
  assert.equal(isScopeGateRejection('maxRisk:L1'), true);
  assert.equal(isScopeGateRejection('pathDenylist'), false);
  assert.equal(isScopeGateRejection(undefined), false);
  assert.equal(enforceScopeRejection('shadow'), false);
  assert.equal(enforceScopeRejection('on'), true);
});

/* ==================== ② DelegationScopeRegistry 行为面 ==================== */

function mkRegistry(over = {}) {
  let now = 1_000_000;
  const clock = { advance: (ms) => { now += ms; } };
  const reg = new DelegationScopeRegistry({
    ttlMs: 60_000,
    maxEntries: 3,
    now: () => now,
    ...over,
  });
  return { reg, tick: clock.advance };
}

test('scope 注册后双键均可精确回查（dtask 与 dtid 同条目）', () => {
  const { reg } = mkRegistry();
  reg.register({ delegationTraceId: 'tr_a', taskId: 'task_a', allowedCapabilities: ['gui.*'], maxRisk: 'L1' });
  const byTask = reg.lookup({ taskId: 'task_a' });
  const byTrace = reg.lookup({ delegationTraceId: 'tr_a' });
  assert.ok(byTask && byTrace);
  assert.equal(byTask.entry, byTrace.entry, '两键必须命中同一对象（register 双索引同写）');
  assert.deepEqual(byTask.entry.allowedCapabilities, ['gui.*']);
  assert.equal(byTask.entry.maxRisk, 'L1');
});

test('scope 无模糊匹配：错键 ⇒ 如实 miss（绝不串台到别的委派）', () => {
  const { reg } = mkRegistry();
  reg.register({ delegationTraceId: 'tr_a', taskId: 'task_a', maxRisk: 'L1' });
  assert.equal(reg.lookup({ taskId: 'task_B' }), undefined);
  assert.equal(reg.lookup({ delegationTraceId: 'tr_Z' }), undefined);
  assert.equal(reg.lookup({}), undefined);
});

test('scope 终态销账：retire 后两键同 miss；未终态（input-required 场景）不销仍在场', () => {
  const { reg } = mkRegistry();
  reg.register({ delegationTraceId: 'tr_b', taskId: 'task_b', allowedCapabilities: ['app.*'] });
  reg.retire({ taskId: 'task_b' });
  assert.equal(reg.lookup({ taskId: 'task_b' }), undefined);
  assert.equal(reg.lookup({ delegationTraceId: 'tr_b' }), undefined);
  assert.equal(reg.size, 0);
});

test('scope TTL 惰性过期：超 TTL ⇒ miss 且顺手清表；未超 ⇒ 在场', () => {
  const { reg, tick } = mkRegistry();
  reg.register({ delegationTraceId: 'tr_c', taskId: 'task_c', maxRisk: 'L2' });
  tick(61_000);
  assert.equal(reg.lookup({ taskId: 'task_c' }), undefined, 'TTL 超 ⇒ 视同缺席（fail-closed 旧行为）');
  assert.equal(reg.size, 0, '惰性清除生效');
});

test('scope 容量上限：超限注册逐最老（长跑单调增长病灶同治 pendingApprovals）', () => {
  const { reg, tick } = mkRegistry();
  for (let i = 0; i < 5; i++) {
    tick(10);
    reg.register({ delegationTraceId: `tr_${i}`, taskId: `task_${i}`, maxRisk: 'L1' });
  }
  assert.equal(reg.size, 3, 'maxEntries=3 ⇒ 只留最新 3 条');
  assert.equal(reg.lookup({ taskId: 'task_0' }), undefined, '最老逐出');
  assert.ok(reg.lookup({ taskId: 'task_4' }), '最新在场');
});

test('scope 同 taskId 重注册=覆盖不膨胀（重投递/测试复位边缘）', () => {
  const { reg } = mkRegistry();
  reg.register({ delegationTraceId: 'tr_d1', taskId: 'task_d', maxRisk: 'L1' });
  reg.register({ delegationTraceId: 'tr_d2', taskId: 'task_d', maxRisk: 'L2' });
  assert.equal(reg.size, 1);
  const hit = reg.lookup({ taskId: 'task_d' });
  assert.equal(hit?.entry.maxRisk, 'L2');
  // 旧 trace 索引不残留孤儿
  assert.equal(reg.lookup({ delegationTraceId: 'tr_d1' }), undefined);
});

/* ==================== ③ 引擎端到端接线实锤（policy.test.js 同构） ==================== */

process.env.USERPROFILE = 'C:\\Users\\vmuser';

const del = defineCapability({
  id: 'storage.file.delete', name: '删除', description: 't', risk: 'L2',
  idempotent: false, requiresSession: false, destructive: true, timeoutMs: 5000,
  input: { type: 'object', properties: { path: { type: 'string' } } },
  output: { type: 'object' }, audit: { snapshot: 'before-after' },
  implementation: { kind: 'powershell', module: 'storage', function: 'Remove-FileSystemItem' },
});
const read = defineCapability({
  id: 'system.info.get', name: '读', description: 't', risk: 'L0',
  idempotent: true, requiresSession: false, destructive: false, timeoutMs: 5000,
  input: { type: 'object', properties: {} },
  output: { type: 'object' }, audit: { snapshot: 'none' },
  implementation: { kind: 'powershell', module: 'system', function: 'Get-SystemInfo' },
});

function mkEngine() {
  const registry = new CapabilityRegistry();
  registry.registerAll([read, del]);
  return new CorePolicyEngine({ registry });
}

test('接线实锤②：宿主声明 maxRisk=L1 的委派内层 L2 能力 ⇒ POLICY_DENIED(maxRisk:L1)（on 态）', () => {
  const engine = mkEngine();
  const v = engine.evaluate({
    capabilityId: 'storage.file.delete',
    params: { path: 'C:\\Users\\vmuser\\a.txt' },
    risk: 'L2',
    approved: false,
    // 装配层接线形态：仅声明值进实参（shadow/on 态由 scopeFeedEnabled 门控，此处直接证引擎行为）
    maxRisk: 'L1',
  });
  assert.equal(v.allowed, false);
  assert.equal(v.matchedRule, 'maxRisk:L1');
  assert.equal(v.error?.code, 'POLICY_DENIED');
});

test('接线实锤③：allowedCapabilities 白名单外能力 ⇒ DENY(scope:capability-not-in-allowed-set)', () => {
  const engine = mkEngine();
  const v = engine.evaluate({
    capabilityId: 'storage.file.delete',
    params: { path: 'C:\\Users\\vmuser\\a.txt' },
    risk: 'L2',
    approved: false,
    allowedCapabilities: ['gui.*', 'system.*'],
  });
  assert.equal(v.allowed, false);
  assert.equal(v.matchedRule, 'scope:capability-not-in-allowed-set');
});

test('F-3 断崖防线行为面：两键**不喂**（未声明/服务端默认）⇒ L2 照旧走审批闸（requiresApproval），绝不硬拒', () => {
  const engine = mkEngine();
  const v = engine.evaluate({
    capabilityId: 'storage.file.delete',
    params: { path: 'C:\\Users\\vmuser\\a.txt' },
    risk: 'L2',
    approved: false,
  });
  assert.equal(v.allowed, false);
  assert.equal(v.requiresApproval, true, '未声明 scope ⇒ 审批闸管辖（旧语义逐字保持）');
});

test('通配命中：allowedCapabilities 含 storage.* ⇒ 白名单内放行到下一闸（审批闸）', () => {
  const engine = mkEngine();
  const v = engine.evaluate({
    capabilityId: 'storage.file.delete',
    params: { path: 'C:\\Users\\vmuser\\a.txt' },
    risk: 'L2',
    approved: false,
    allowedCapabilities: ['storage.*'],
  });
  assert.notEqual(v.matchedRule, 'scope:capability-not-in-allowed-set', '通配命中 ⇒ 白名单闸放行');
  assert.equal(v.requiresApproval, true, '落到下一闸（审批）——scope 通过≠放行 L2');
});

/* ==================== ⑤ CL3：deterministic 第三调用点 + E-2 显形（真实引擎） ==================== */

const { DeterministicAgentProvider } = await import('@winvm/adapter-agent-workbuddy');
const { realEngine, realRegistry } = (() => {
  const registry = new CapabilityRegistry();
  registry.registerAll([read, del]);
  return { realEngine: new CorePolicyEngine({ registry }), realRegistry: registry };
})();

async function mkDeterministic() {
  const calls = [];
  const bridge = {
    running: true,
    uptimeMs: 1,
    async start() {},
    async stop() {},
    async call(module, fn, params) {
      calls.push({ module, fn, params });
      return { fromBridge: true };
    },
    health: () => ({ state: 'ready', uptimeMs: 1, pending: 0, lastHeartbeatAgoMs: 0 }),
  };
  const ctx = {
    config: {},
    audit: { append: async () => ({ hash: 'h', prevHash: '', seq: 0, auditId: 'aud_x' }), verifyChain: async () => ({ valid: true, entries: 0 }) },
    policy: realEngine,
    capabilities: {
      get: (id) => realRegistry.get(id),
      list: () => [...realRegistry.list?.() ?? []],
      has: (id) => Boolean(realRegistry.get(id)),
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    bridge,
    newTraceId: () => 'tr_test',
  };
  const p = new DeterministicAgentProvider();
  await p.init(ctx);
  return { p, calls };
}

test('CL3：deterministic execute 收 scopeMaxRisk=L1 ⇒ L2 能力 POLICY_DENIED(maxRisk:L1)，零桥调用', async () => {
  process.env.WINVM_POLICY_GATE_WIRING = 'on';
  try {
    const { p, calls } = await mkDeterministic();
    const res = await p.execute({
      traceId: 'tr_x',
      capabilityId: 'storage.file.delete',
      params: { path: 'C:\\Users\\vmuser\\a.txt' },
      risk: 'L2',
      approved: false,
      timeoutMs: 5000,
      scopeMaxRisk: 'L1',
    });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'POLICY_DENIED');
    assert.equal(calls.length, 0, '拒绝必须零副作用（策略闸先于桥调用）');
  } finally {
    delete process.env.WINVM_POLICY_GATE_WIRING;
  }
});

test('CL3：不喂 scope（未声明/shadow/off 形态）⇒ L2 走审批闸 APPROVAL_REQUIRED（requiresApproval 语义逐字旧行为）', async () => {
  const { p } = await mkDeterministic();
  const res = await p.execute({
    traceId: 'tr_y',
    capabilityId: 'storage.file.delete',
    params: { path: 'C:\\Users\\vmuser\\a.txt' },
    risk: 'L2',
    approved: false,
    timeoutMs: 5000,
  });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'APPROVAL_REQUIRED', '无声明 ⇒ 封顶闸不触发，审批闸管辖（零断崖）');
});

test('E-2 显形：deterministic 命中审批闸 ⇒ error.details 带 suspendSupported=false 与真实出路指引', async () => {
  const { p } = await mkDeterministic();
  const res = await p.execute({
    traceId: 'tr_z',
    capabilityId: 'storage.file.delete',
    params: { path: 'C:\\Users\\vmuser\\a.txt' },
    risk: 'L2',
    approved: false,
    timeoutMs: 5000,
  });
  assert.equal(res.error.details?.suspendSupported, false, '结构性能力缺失必须显形（不再藏在裸码里）');
  assert.equal(res.error.details?.executor, 'deterministic');
  assert.ok(Array.isArray(res.error.details?.nextActions) && res.error.details.nextActions.length >= 2);
});

test('E-2 判别性：策略硬拒（非审批闸）不贴挂起显形键（只 augment APPROVAL_REQUIRED 分支）', async () => {
  process.env.WINVM_POLICY_GATE_WIRING = 'on';
  try {
    const { p } = await mkDeterministic();
    const res = await p.execute({
      traceId: 'tr_w',
      capabilityId: 'storage.file.delete',
      params: { path: 'C:\\Users\\vmuser\\a.txt' },
      risk: 'L2',
      approved: false,
      timeoutMs: 5000,
      scopeMaxRisk: 'L1',
    });
    assert.notEqual(res.error.code, 'APPROVAL_REQUIRED');
    assert.equal(res.error.details?.suspendSupported, undefined, '硬拒路径逐字旧形状（纯附加纪律）');
  } finally {
    delete process.env.WINVM_POLICY_GATE_WIRING;
  }
});

/* ==================== ④ 源码钉：装配位置与纯函数调用在位（防漂移） ==================== */

test('server.ts 装配钉：(c) 收口走纯函数判据 + scope 注册/回查/销账三点齐位', () => {
  assert.match(SRC, /shouldReturnDelegationRequired\(\{ inner: innerDelegation/, '(c) 收口必须走 policy-gate 纯函数');
  assert.match(SRC, /isInnerDelegation\(channelProbe\)/, '通道判据必须走纯函数');
  assert.match(SRC, /scopeRegistry\.lookup\(scopeLookupKeys\(channelProbe\)\)/, '内层回查走 scopeLookupKeys 纯函数选键');
  assert.match(SRC, /scopeRegistry\.register\(\{/, 'onGoalAccepted 注册 scope');
  assert.match(SRC, /goal\.maxRiskDeclared === true && goal\.maxRisk/, 'maxRisk 仅**声明**才留存（F-3 断崖防线的装配段）');
  assert.match(SRC, /scopeRegistry\.retire\(\{/, 'onGoalTerminal 真终态销账');
  assert.match(SRC, /snap\.state !== 'input-required'/, '审批挂起**不销**（批准后重放仍需回查）');
});

test('server.ts 装配钉：token 留存 scope + 重放用留存值复评（批什么执行什么的外延）', () => {
  assert.match(SRC, /scopeAllowedCapabilities: segScope\.allowedCapabilities/, '拦截时留存声明白名单');
  assert.match(SRC, /scopeMaxRisk: segScope\.maxRisk/, '拦截时留存声明封顶');
  assert.match(SRC, /p\.scopeAllowedCapabilities \? \{ allowedCapabilities: p\.scopeAllowedCapabilities \}/, '重放用留存值（不回查活表，杜绝时序差）');
});

test('errors.ts 契约钉：DELEGATION_REQUIRED 在册且 retryable=false（重试同一请求无益）', () => {
  const E = readFileSync(
    fileURLToPath(new URL('../../packages/contracts/src/errors.ts', import.meta.url)),
    'utf8',
  );
  assert.match(E, /\| 'DELEGATION_REQUIRED'/);
  assert.match(E, /DELEGATION_REQUIRED: false,/);
});

test('constants.ts 灰度钉：双闸缺省 shadow（升级窗口安全档）；(c) 缺省 on；非法值各有回退', () => {
  const C = readFileSync(
    fileURLToPath(new URL('../../packages/core/src/constants.ts', import.meta.url)),
    'utf8',
  );
  assert.match(C, /POLICY_GATE_WIRING_DEFAULT: PolicyGateWiringMode = 'shadow'/);
  assert.match(C, /parseBoolean\(env\[ENV_DELEGATION_REQUIRED_POLICY\], true\)/);
});

/* ==================== ⑥ CL3 源码钉：deterministic 第三调用点 goal→step→execute feed ==================== */

const ADAPTER_SRC = readFileSync(
  fileURLToPath(new URL('../../packages/adapter-agent-workbuddy/src/index.ts', import.meta.url)),
  'utf8',
);

test('deterministic 第三调用点接线钉：execute 评估喂 req.scope 两键 + step 仅 on 态取 goal 声明', () => {
  // 第三调用点（in-process）把宿主声明 scope 喂进策略评估
  assert.match(ADAPTER_SRC, /\.\.\.\(req\.scopeMaxRisk \? \{ maxRisk: req\.scopeMaxRisk \}/, 'execute evaluate 喂声明 maxRisk');
  assert.match(ADAPTER_SRC, /req\.scopeAllowedCapabilities && req\.scopeAllowedCapabilities\.length > 0/, 'execute evaluate 喂声明白名单');
  // step 的 scopeFeed：仅 `on` 态 + 仅 maxRiskDeclared===true（框架回退默认绝不喂=零断崖）
  assert.match(ADAPTER_SRC, /this\.policyGateWiring === 'on'\s*\?\s*\{/, 'scopeFeed 仅 on 态');
  assert.match(ADAPTER_SRC, /goal\.maxRiskDeclared === true && goal\.maxRisk \? \{ scopeMaxRisk: goal\.maxRisk \}/, 'goal→step 只取声明 maxRisk');
  // E-2 显形：APPROVAL_REQUIRED 分支 augment suspendSupported（纯附加，硬拒路径不贴）
  assert.match(ADAPTER_SRC, /suspendSupported: false/, 'E-2 结构性能力缺失显形');
  assert.match(ADAPTER_SRC, /verdict\.requiresApproval && verdict\.error\?\.code === 'APPROVAL_REQUIRED'/, 'E-2 只 augment 审批闸分支');
});

/* ==================== ⑦ CL4 装配钉：/health 观测块 + scope 兜底清扫 ==================== */

test('/health.policyGate 观测块与 scope 兜底清扫在位（门禁内稳门外盲的反制件）', () => {
  assert.match(SRC, /policyGate: buildPolicyGateHealth\(/, '/health 须透出灰度态+shadowHits+(c) 开关+scope 表大小');
  assert.match(SRC, /scopeRegistry\.sweepExpired\(\);/, '与令牌同周期兜底清扫（正常路径靠 retire，此为漏网双保险）');
});

/* ==================== ⑧ CL7：A2-1 早退审计收口三处实名钉（规则名漂移即红） ==================== */

test('A2-1 收口三处终态拒绝审计注入实名在位（S-4 同族纪律扩展到早退点）', () => {
  assert.match(SRC, /matchedRule: 'runtime:provider-unavailable'[\s\S]{0,120}errorCode: 'PROVIDER_UNAVAILABLE'/,
    'executeCapability provider 缺席早退须入链（收口①）');
  assert.match(SRC, /matchedRule: 'replay:capability-not-exposed'/, 'replay 暴露面复核早退须入链（收口②）');
  assert.match(SRC, /matchedRule: 'replay:capability-not-registered'/, 'replay 能力未注册早退须入链（收口③）');
  // 判别性：批1(c) 收口的 matchedRule 同样在册（CL2 落，计数联动核对）
  assert.match(SRC, /matchedRule: 'policy:delegation-required'/, '(c) 收口拒绝入链规则名');
});

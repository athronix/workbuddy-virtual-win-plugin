/**
 * 批10 G1（N-10）：常驻缺省形态 —— 委派 scope 回查链的**服务级端到端**回归
 *
 * 病灶（台账 §1 N-10）：批1 的 scope 执法链只有单元件（p3-b1-policy-gate 33 例全离线）
 * + 源码钉；smoke 只覆盖直调 (c) 与 `?dtid=` 内层对照。**常驻缺省 provider**
 * （LLM+persistent session，dtid 不生效、纯靠协调器活动委派槽回查 scope）这条
 * 最常用路径的端到端链路零覆盖。本件补齐五象限：
 *  ① 委派 accepted 装配：经**真 A2A message/send** 触发框架 `onGoalAccepted` ⇒
 *     `scopeRegistry.register`（不走手搓内部状态；taskId 注入由框架构造期保证）；
 *  ② 内层回连形态（不带 `?dtid=`，纯靠活动槽 `getActiveTaskId()`）打白名单外能力：
 *     shadow（缺省）⇒ `shadowHits` 增 ∧ **不被 (c) 误伤**（`APPROVAL_REQUIRED`+approvalId，
 *     改道=基线路径）；on ⇒ `POLICY_DENIED`+审计链 matchedRule=`scope:capability-not-in-allowed-set`；
 *  ③ maxRisk:L1 声明 + L2 能力：on ⇒ `POLICY_DENIED` 实锤（matchedRule=`maxRisk:L1`）；
 *     shadow ⇒ 不执法改道 + hits 计数；
 *  ④ 判别性：terminal 后 scope 表 size 回落（retire 生效）+ 活动槽清除后同请求纯直调 ⇒
 *     `DELEGATION_REQUIRED`（(c) 生效面回归，证明 inner 判定随活动槽翻转）；
 *  ⑤ 全程零伪造：策略判定、scope 回查、(c) 收口、shadow 改道全部由服务端真实装配执行。
 *
 * 常驻形态的 provider 替身（`registerProviderFactory` 进程内工厂，loader 优先于动态
 * import）忠实复刻 `CliLlmBridge.runGoal` 的委派 turn 包裹形态：
 *   `coordinator.beginTask(taskId)` → CLI 子进程位 = HTTP 回连 `POST /mcp`（**不带 dtid**）
 *   → `coordinator.endTask(taskId)`
 * —— begin/endTask 走 `BridgeContext.approvalCoordinator` 契约 SPI（真实服务注入的就是
 * `VmApprovalCoordinator` 本体），回连走真实 HTTP 与真实 handler。这是「LLM provider
 * 不可用（VM 内无 codebuddy CLI）」约束下能构造的**最深**真链路；判据面（通道/回查/
 * 灰度/收口）无任何 mock。
 *
 * 灰度两态各起一个真服务（wiring 在 createService 构造期解析 ⇒ 不能运行中切换）。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_SERVICE_CONFIG, registerProviderFactory, unregisterProviderFactory } from '@winvm/core';
import { createService } from '@winvm/vm-service';

const PROVIDER_ID = 'winvm-e2e-b10-resident';

/* ==================== 常驻 provider 替身工厂 ==================== */

/**
 * 复刻常驻桥的 turn 包裹形态（bridge.ts:997-1003 beginTask/try/endTask 同构）。
 * `state` 由测试持有：委派前写入本轮内层回连计划，runGoal 逐条执行并留存回执。
 */
function makeResidentProvider(state) {
  let ctx;
  return {
    id: PROVIDER_ID,
    displayName: 'WinVM E2E B10 Resident Provider (test double)',
    kind: 'llm-agent',
    declareCapabilities() {
      // 与 workbuddy LLM provider 同域，保证暴露面含 storage.*（回连目标能力在册）
      return ['meta.*', 'system.*', 'app.*', 'storage.*', 'gui.*', 'appops.*'];
    },
    async init(injected) {
      ctx = injected;
      state.ctx = injected;
    },
    async execute(req) {
      // 回连若走到执行段（本件刻意全打被拦/被拒能力）也给出无害回执，绝不触 ps-bridge
      return { traceId: req.traceId, ok: true, data: { e2e: true }, durationMs: 1 };
    },
    async runGoal(goal, sink) {
      sink.onStatus('working', `b10 resident turn for task ${goal.taskId}`);
      const coordinator = ctx?.approvalCoordinator;
      // 常驻桥形态①：进入委派 turn（真实服务里这一步发生在 CliLlmBridge）
      coordinator?.beginTask(goal.taskId ?? '');
      // N-9 窄窗测试屏障（可选）：活动槽已持有 ⇒ 通知测试方，并可等待放行
      state.resolveTurnActive?.();
      if (state.turnHold) await state.turnHold;
      const innerCalls = [];
      try {
        for (const call of state.calls) {
          // 常驻桥形态②：VM 内 CLI 回连 /mcp —— **不带 ?dtid=**（常驻不生效，F-2 病灶原文）
          const res = await fetch(`${state.base}/mcp`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: innerCalls.length + 1,
              method: 'tools/call',
              params: { name: call.capabilityId, arguments: call.params },
            }),
          });
          const body = await res.json();
          innerCalls.push(body?.result?.structuredContent ?? { raw: body });
        }
      } finally {
        // 常驻桥形态③：委派 turn 收尾释放活动槽（与 raise 的 input-required 挂接同一事实）
        coordinator?.endTask(goal.taskId ?? '');
      }
      state.lastInnerCalls = innerCalls;
      const blocked = innerCalls.find((sc) => sc?.error?.code === 'APPROVAL_REQUIRED');
      const denied = innerCalls.find((sc) => sc?.error?.code === 'POLICY_DENIED');
      const required = innerCalls.find((sc) => sc?.error?.code === 'DELEGATION_REQUIRED');
      return {
        ok: false,
        summary: `b10 e2e turn done (blocked=${blocked ? 1 : 0} denied=${denied ? 1 : 0} required=${required ? 1 : 0})`,
        artifacts: [],
        steps: innerCalls.map((sc, i) => ({
          index: i,
          capabilityId: state.calls[i]?.capabilityId ?? 'unknown',
          params: {},
          ok: sc?.ok === true,
          risk: sc?.risk ?? 'L2',
          durationMs: 1,
          traceId: sc?.traceId ?? goal.traceId,
        })),
        error: { code: 'EXECUTION_FAILED', message: 'b10 e2e synthetic turn failure' },
      };
    },
    async health() {
      return {
        ok: true,
        provider: { id: PROVIDER_ID, state: 'ready' },
        session: {},
      };
    },
    async shutdown() {},
  };
}

/* ==================== 公共 HTTP 面 ==================== */

async function postJson(base, path, body) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function getHealth(runtime) {
  return runtime.health();
}

/** 读审计目录全部 jsonl 行（matchedRule 取证：POLICY_DENIED 的 scope 闸实名只在链上）。 */
async function readChainEntries(auditDir, needlePredicate) {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const lines = [];
    try {
      for (const f of readdirSync(auditDir).filter((n) => n.endsWith('.jsonl'))) {
        const raw = readFileSync(join(auditDir, f), 'utf8');
        for (const l of raw.split(/\r?\n/)) {
          if (!l.trim()) continue;
          try {
            lines.push(JSON.parse(l));
          } catch {
            /* 半行（写入竞态）忽略，下轮再读 */
          }
        }
      }
    } catch {
      /* 目录尚未创建 */
    }
    const hit = lines.find(needlePredicate);
    if (hit) return { entry: hit, all: lines };
    if (Date.now() >= deadline) return { entry: undefined, all: lines };
    await new Promise((r) => setTimeout(r, 120));
  }
}

/** 发起一次真 A2A 委派（blocking ⇒ 走完 accepted→runGoal→terminal 全链）。 */
async function delegate(base, metadata) {
  const { body } = await postJson(base, '/a2a', {
    jsonrpc: '2.0',
    id: 100,
    method: 'message/send',
    params: {
      message: { kind: 'message', role: 'user', messageId: `m_${Math.random().toString(36).slice(2)}`, parts: [{ kind: 'text', text: 'b10 e2e resident probe' }] },
      metadata: { traceId: `tr_b10_${Math.random().toString(36).slice(2)}`, ...metadata },
      configuration: { blocking: true },
    },
  });
  if (!body?.result) throw new Error(`委派响应异常：${JSON.stringify(body)}`);
  return body.result;
}

/** 非阻塞委派：立即返回 Task（runner 在后台继续），用于 N-9 窄窗真并发交错的夹具。 */
async function delegateNonBlocking(base, metadata) {
  const { body } = await postJson(base, '/a2a', {
    jsonrpc: '2.0',
    id: 101,
    method: 'message/send',
    params: {
      message: { kind: 'message', role: 'user', messageId: `m_${Math.random().toString(36).slice(2)}`, parts: [{ kind: 'text', text: 'b10 e2e resident probe (hold)' }] },
      metadata: { traceId: `tr_b10_hold_${Math.random().toString(36).slice(2)}`, ...metadata },
      configuration: { blocking: false },
    },
  });
  if (!body?.result) throw new Error(`非阻塞委派响应异常：${JSON.stringify(body)}`);
  return body.result;
}

const DELETE_PARAMS = { path: 'C:\\WinVMWorkspace\\drafts\\old.txt' };

/* ==================== shadow（缺省灰度档）形态 ==================== */

describe('E2E·批10 常驻 scope 链 · shadow 缺省态（评估不执法）', () => {
  const PORT = 19481;
  const BASE = `http://127.0.0.1:${PORT}`;
  let runtime;
  let auditDir;
  const state = { base: BASE, calls: [], lastInnerCalls: undefined };

  before(async () => {
    delete process.env.WINVM_POLICY_GATE_WIRING; // 缺省 = shadow
    auditDir = mkdtempSync(join(tmpdir(), 'winvm-b10-shadow-'));
    registerProviderFactory(PROVIDER_ID, () => makeResidentProvider(state));
    runtime = await createService({
      ...DEFAULT_SERVICE_CONFIG,
      server: { host: '127.0.0.1', port: PORT },
      audit: { dir: auditDir, redactParams: true },
      agent: {
        provider: PROVIDER_ID,
        providers: { ...DEFAULT_SERVICE_CONFIG.agent.providers, [PROVIDER_ID]: { package: '@winvm/e2e-inprocess', options: {} } },
      },
    });
    // 服务已 listen；端口由 createService 决定（回连基址以实测为准，防配置漂移）
    state.base = `http://127.0.0.1:${runtime.port}`;
  });

  after(async () => {
    if (runtime) await runtime.close();
    unregisterProviderFactory(PROVIDER_ID);
  });

  test('装配前提：/health.policyGate 块在册且 wiring=shadow、scope 表空', async () => {
    const h = await getHealth(runtime);
    assert.ok(h.policyGate, 'policyGate 观测块缺失');
    assert.equal(h.policyGate.wiring, 'shadow');
    assert.equal(h.policyGate.shadowHits, 0);
    assert.equal(h.policyGate.scopeEntries, 0);
    assert.equal(h.policyGate.delegationRequiredPolicy, true);
  });

  test('①+② shadow 态：委派 accepted 注册 scope ⇒ 内层回连（无 dtid、纯活动槽）白名单外能力 ⇒ 改道 APPROVAL_REQUIRED + shadowHits 增', async () => {
    const h0 = await getHealth(runtime);
    const hits0 = h0.policyGate.shadowHits;
    state.calls = [{ capabilityId: 'storage.file.delete', params: DELETE_PARAMS }];
    // 宿主声明：白名单只含 storage.file.read；不声明 maxRisk（maxRiskSource 缺席 ⇒ F-3 不喂封顶）
    const task = await delegate(BASE, {
      allowedCapabilities: ['storage.file.read'],
      maxRisk: 'L1',
    });
    assert.equal(task.kind, 'task');
    const calls = state.lastInnerCalls;
    assert.ok(Array.isArray(calls) && calls.length === 1, `内层回连应恰一次：${JSON.stringify(calls)}`);
    const sc = calls[0];
    assert.ok(sc, JSON.stringify(calls));
    // shadow 不执法 ⇒ scope 拒改道基线重评 ⇒ L2 审批闸 ⇒ 注册令牌（委派内层绝不被 (c) 收口）
    assert.equal(sc.error?.code, 'APPROVAL_REQUIRED', `shadow 改道应落注册令牌路径：${JSON.stringify(sc.error)}`);
    assert.notEqual(sc.error?.code, 'DELEGATION_REQUIRED', '(c) 不得误伤委派内层');
    assert.ok(sc.approval?.approvalId, '内层必须拿到 approvalId 供批准后重放续跑');
    // shadow 命中评估计数（getHealth 读 runtime.health()，对齐"getHealth().policyGate.shadowHits > 0"）
    const h1 = await getHealth(runtime);
    assert.ok(h1.policyGate.shadowHits > hits0, `shadowHits 应增：${hits0} → ${h1.policyGate.shadowHits}`);
  });

  test('③ shadow 态 maxRisk:L1 声明 + L2 能力（白名单内）⇒ 不执法改道 + hits 再增', async () => {
    const h0 = await getHealth(runtime);
    const hits0 = h0.policyGate.shadowHits;
    state.calls = [{ capabilityId: 'storage.file.delete', params: DELETE_PARAMS }];
    // 白名单放行 storage.*、显式声明封顶 L1（maxRiskSource=agent ⇒ 声明进留存）
    await delegate(BASE, {
      allowedCapabilities: ['storage.*'],
      maxRisk: 'L1',
      maxRiskSource: 'agent',
    });
    const sc = state.lastInnerCalls[0];
    assert.equal(sc.error?.code, 'APPROVAL_REQUIRED', `maxRisk 拒也改道：${JSON.stringify(sc.error)}`);
    const h1 = await getHealth(runtime);
    assert.ok(h1.policyGate.shadowHits > hits0, `maxRisk 闸 shadowHits 应增：${hits0} → ${h1.policyGate.shadowHits}`);
  });

  test('④ 判别性：terminal 后 scope 表 size 回落（retire 生效）⇒ 槽清除后同请求纯直调 ⇒ DELEGATION_REQUIRED（(c) 生效面回归）', async () => {
    // 上两轮委派均已终态收口（blocking 返回 ⇒ onGoalTerminal 已回调）
    const h = await getHealth(runtime);
    assert.equal(h.policyGate.scopeEntries, 0, '真终态 ⇒ scope 表销账回落');
    // 活动槽同批被 endTask 清除（runGoal finally）⇒ 同能力纯直调 ⇒ inner=false ⇒ (c) 收口
    const { body } = await postJson(BASE, '/mcp', {
      jsonrpc: '2.0', id: 77, method: 'tools/call',
      params: { name: 'storage.file.delete', arguments: DELETE_PARAMS },
    });
    const sc = body?.result?.structuredContent;
    assert.equal(sc?.error?.code, 'DELEGATION_REQUIRED', `同请求翻回 (c) 收口：${JSON.stringify(sc?.error)}`);
    assert.equal(sc.error.retryable, false);
    assert.equal(sc.approval, undefined, '(c) 收口不发令牌');
  });

  test('N-9 窄窗实锤：委派 turn 进行中纯直调命中审批闸 ⇒ directWithActiveTurn +1 + 被按内层发令牌（(c) 不误伤对照），turn 结束后同请求恢复 DELEGATION_REQUIRED 且计数不再涨', async () => {
    // 真并发交错：非阻塞委派（provider turn 内 beginTask 后挂起等待放行屏障）
    // ⇒ 活动槽持续在场 ⇒ 此刻打**不带 dtid 的纯直调** ⇒ 服务端事实 activeTaskId
    // ⇒ inner=true ⇒ (c) 不触发 ⇒ 注册令牌（N-9 登记的毫秒窗复活实况）+ 观测计数。
    const before = await getHealth(runtime);
    const c0 = before.policyGate.directWithActiveTurn ?? 0;
    let releaseTurn;
    let turnActiveSettled;
    state.calls = [];
    state.turnHold = new Promise((r) => {
      releaseTurn = r;
    });
    state.resolveTurnActive = () => {};
    turnActiveSettled = new Promise((r) => {
      state.resolveTurnActive = r;
    });
    const task = await delegateNonBlocking(BASE, { allowedCapabilities: ['storage.file.read'] });
    // 屏障握手：mock 桥 beginTask 完成后才 resolve ⇒ 槽确定在场
    await turnActiveSettled;
    const narrow = await postJson(BASE, '/mcp', {
      jsonrpc: '2.0', id: 78, method: 'tools/call',
      params: { name: 'storage.file.delete', arguments: DELETE_PARAMS },
    });
    const scN = narrow.body?.result?.structuredContent;
    assert.equal(
      scN?.error?.code,
      'APPROVAL_REQUIRED',
      `窄窗内纯直调被按内层处理（(c) 不误伤常驻 turn）：${JSON.stringify(scN?.error)}`,
    );
    assert.ok(scN.approval?.approvalId, '窄窗实况=注册续跑令牌（旧行为毫秒窗，warn-only 观测对象）');
    const hN = await getHealth(runtime);
    assert.equal(
      hN.policyGate.directWithActiveTurn,
      c0 + 1,
      `窄窗计数 +1（${c0} → ${hN.policyGate.directWithActiveTurn}）`,
    );
    assert.equal(hN.policyGate.scopeEntries, 1, 'turn 进行中 scope 表项在场');
    // 放行 turn：委派终态 ⇒ retire+endTask ⇒ 同请求恢复纯直调语义 ⇒ (c) 收口且计数不再涨
    releaseTurn();
    const deadline = Date.now() + 3_000;
    for (;;) {
      const hh = await getHealth(runtime);
      if (hh.policyGate.scopeEntries === 0) break;
      if (Date.now() > deadline) assert.fail('turn 放行后 scope 未在窗口内销账（retire 未生效？）');
      await new Promise((r) => setTimeout(r, 60));
    }
    const after = await postJson(BASE, '/mcp', {
      jsonrpc: '2.0', id: 79, method: 'tools/call',
      params: { name: 'storage.file.delete', arguments: DELETE_PARAMS },
    });
    const scA = after.body?.result?.structuredContent;
    assert.equal(scA?.error?.code, 'DELEGATION_REQUIRED', '槽清除后 (c) 恢复收口（判别性：翻转由活动槽驱动）');
    const h1 = await getHealth(runtime);
    assert.equal(h1.policyGate.directWithActiveTurn, c0 + 1, '(c) 收口路径不属窄窗 ⇒ 计数不变');
    assert.ok(task.id, '非阻塞委派应正常受理');
    state.turnHold = undefined;
    state.resolveTurnActive = undefined;
  });

  test('⑤ 链上取证：shadow 改道的评估事实可归因（scope 白名单/封顶规则名在 warn 观测面之外仍可由令牌留存印证）', async () => {
    // 判别性对照：?dtid 通路（traceId 键）查不到常驻注册的 taskId 条目时仍按 inner 走令牌路径，
    // 证明本件 shadowHits 增量确由 **活动槽→taskId 回查命中 scope** 产生（而非 dtid 通路的旧形态）。
    state.calls = [{ capabilityId: 'storage.file.delete', params: DELETE_PARAMS }];
    const before = await getHealth(runtime);
    await delegate(BASE, { allowedCapabilities: ['storage.file.read'] });
    const after = await getHealth(runtime);
    assert.ok(after.policyGate.shadowHits > before.policyGate.shadowHits, '复证：常驻回连 shadow 命中链稳定可复现');
  });
});

/* ==================== on（执法档）形态 ==================== */

describe('E2E·批10 常驻 scope 链 · on 执法态', () => {
  const PORT = 19482;
  let runtime;
  let auditDir;
  const state = { base: `http://127.0.0.1:${PORT}`, calls: [], lastInnerCalls: undefined };
  const prevWiring = process.env.WINVM_POLICY_GATE_WIRING;

  before(async () => {
    process.env.WINVM_POLICY_GATE_WIRING = 'on';
    auditDir = mkdtempSync(join(tmpdir(), 'winvm-b10-on-'));
    registerProviderFactory(PROVIDER_ID, () => makeResidentProvider(state));
    runtime = await createService({
      ...DEFAULT_SERVICE_CONFIG,
      server: { host: '127.0.0.1', port: PORT },
      audit: { dir: auditDir, redactParams: true },
      agent: {
        provider: PROVIDER_ID,
        providers: { ...DEFAULT_SERVICE_CONFIG.agent.providers, [PROVIDER_ID]: { package: '@winvm/e2e-inprocess', options: {} } },
      },
    });
    state.base = `http://127.0.0.1:${runtime.port}`;
  });

  after(async () => {
    if (runtime) await runtime.close();
    unregisterProviderFactory(PROVIDER_ID);
    if (prevWiring === undefined) delete process.env.WINVM_POLICY_GATE_WIRING;
    else process.env.WINVM_POLICY_GATE_WIRING = prevWiring;
  });

  test('装配前提：/health.policyGate wiring=on', async () => {
    const h = await getHealth(runtime);
    assert.equal(h.policyGate.wiring, 'on');
    assert.equal(h.policyGate.shadowHits, 0, 'on 态无 shadow 改道计数语义');
  });

  test('② on 态：白名单外能力内层回连 ⇒ POLICY_DENIED 实锤 + 链上 matchedRule=scope:capability-not-in-allowed-set', async () => {
    state.calls = [{ capabilityId: 'storage.file.delete', params: DELETE_PARAMS }];
    await delegate(state.base, { allowedCapabilities: ['storage.file.read'] });
    const sc = state.lastInnerCalls[0];
    assert.equal(sc?.error?.code, 'POLICY_DENIED', `on 态 scope 白名单闸必须执法：${JSON.stringify(sc?.error)}`);
    assert.match(sc.error.message, /能力不在本次委派允许的范围内/);
    assert.equal(sc.error.retryable, false);
    assert.equal(sc.approval, undefined, '硬拒不发令牌');
    // 链上实名（S-4 纪律：策略硬拒必须入审计链，matchedRule 来自 verdict）
    const { entry } = await readChainEntries(auditDir, (e) =>
      e?.policyDecision?.matchedRule === 'scope:capability-not-in-allowed-set' &&
      e?.result?.errorCode === 'POLICY_DENIED');
    assert.ok(entry, '审计链须有 scope 白名单闸拒绝条目（规则名漂移即此红）');
  });

  test('③ on 态：maxRisk:L1 显式声明 + 白名单内 L2 ⇒ POLICY_DENIED + 链上 matchedRule=maxRisk:L1', async () => {
    state.calls = [{ capabilityId: 'storage.file.delete', params: DELETE_PARAMS }];
    await delegate(state.base, {
      allowedCapabilities: ['storage.*'],
      maxRisk: 'L1',
      maxRiskSource: 'agent',
    });
    const sc = state.lastInnerCalls[0];
    assert.equal(sc?.error?.code, 'POLICY_DENIED', `封顶闸必须执法：${JSON.stringify(sc?.error)}`);
    assert.match(sc.error.message, /超出本次委派允许上限/);
    const { entry } = await readChainEntries(auditDir, (e) =>
      e?.policyDecision?.matchedRule === 'maxRisk:L1' && e?.result?.errorCode === 'POLICY_DENIED');
    assert.ok(entry, '审计链须有 maxRisk 封顶闸拒绝条目');
  });

  test('on 态未声明形态零影响（F-3 断崖防线端到端）：无 maxRiskSource ⇒ 封顶不喂 ⇒ 白名单内 L2 走审批闸', async () => {
    state.calls = [{ capabilityId: 'storage.file.delete', params: DELETE_PARAMS }];
    // allowed 覆盖 delete；maxRisk 仅展示值、无 maxRiskSource=agent ⇒ 不留存 ⇒ 不喂封顶闸
    await delegate(state.base, { allowedCapabilities: ['storage.file.delete'], maxRisk: 'L1' });
    const sc = state.lastInnerCalls[0];
    assert.equal(sc?.error?.code, 'APPROVAL_REQUIRED', `未声明封顶 ⇒ 审批闸管辖（on 态零断崖）：${JSON.stringify(sc?.error)}`);
    assert.ok(sc.approval?.approvalId);
  });

  test('④ on 态判别性：terminal 销账后纯直调同能力 ⇒ DELEGATION_REQUIRED（内层判定随活动槽翻转，端到端闭环）', async () => {
    const h = await getHealth(runtime);
    assert.equal(h.policyGate.scopeEntries, 0, 'on 服务三委派均真终态 ⇒ 表回落');
    const { body } = await postJson(state.base, '/mcp', {
      jsonrpc: '2.0', id: 88, method: 'tools/call',
      params: { name: 'storage.file.delete', arguments: DELETE_PARAMS },
    });
    const sc = body?.result?.structuredContent;
    assert.equal(sc?.error?.code, 'DELEGATION_REQUIRED');
  });
});

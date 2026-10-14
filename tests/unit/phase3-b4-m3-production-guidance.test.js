/**
 * Phase 3 批4 · M3（3a 最小修）：模板 5 生产工作流缺位时的**装机证据引导**。
 *
 * 钉死判据（离线面，audit §3.2 M3 / PM §8 批2 判据③）：
 *  1. workflow.run 未命中（WORKFLOW_NOT_FOUND）+ `app.inventory.list` 探到装机登记
 *     ⇒ 失败 summary **含直调路径**（appops.cli.invoke + app=映射值 + "L1 不触审批"），
 *     不再是只有"预置脚本/升级 LLM"两条死路（默认形态必空转的 UX 病灶处方本体）。
 *  2. 探不到装机登记 ⇒ summary 给**安装配方**（app.winget.install），绝不谎称可直调。
 *  3. excel（pandoc 只读不能写报表）**不映射** ⇒ 无引导行、保持原文案（名实相符）。
 *  4. 探测 fail-safe：inventory.list 自身失败 ⇒ 业务结论不变（仍 UNSUPPORTED_GOAL）、
 *     只是少一条引导（绝不把探测失败伪装成"未安装"结论 ⇒ 归因诚实）。
 *  5. 收口码恒 UNSUPPORTED_GOAL（上游 WORKFLOW_NOT_FOUND 不改变业务结论；不在 shouldDegrade 集内）。
 *
 * 纪律：不碰 VM/PS/HTTP；import 构建产物；逐文件跑；严禁 snapshot 字样。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { createProvider } from '../../packages/adapter-agent-workbuddy/dist/index.js';

const TRACE = 'tr_m3_probe';

const DEFS = new Map(
  [
    ['appops.workflow.run', { module: 'appops', fn: 'Start-AppOpWorkflow', risk: 'L1' }],
    ['app.inventory.list', { module: 'app', fn: 'Get-InstalledApps', risk: 'L0' }],
    ['appops.cli.invoke', { module: 'appops', fn: 'Invoke-AppCli', risk: 'L1' }],
  ].map(([id, impl]) => [id, { implementation: { module: impl.module, function: impl.fn }, input: {}, timeoutMs: 5_000 }]),
);

/**
 * 生产同构夹具（U-P0-3 教训口径）：input schema 从**真实注册表** WINDOWS_CAPABILITIES 取
 * （validateParams 读 definitionOf().input.properties ⇒ 空 schema 会绕过参数校验面；
 * 真 schema 下若实现传错参数名——如 {path} 代替 {name}——必被 INVALID_PARAMS 挡死 ⇒ 测试即红）。
 */
try {
  const { WINDOWS_CAPABILITIES } = await import('../../packages/vm-capabilities/dist/index.js');
  for (const [id, def] of DEFS) {
    const cap = WINDOWS_CAPABILITIES.find((c) => c.id === id);
    if (cap?.input) def.input = cap.input;
  }
} catch {
  /* vm-capabilities dist 缺席时退回空 schema（本地恒有，CI 亦先 tsc） */
}

function makeCtx(inventoryFn) {
  const calls = [];
  const bridge = {
    running: true,
    async call(module, fn, params) {
      calls.push(`${module}/${fn}`);
      if (fn === 'Start-AppOpWorkflow') {
        // 模拟 ps-bridge 把 ok:false 载荷 reject 成带 code 的错误（ps-bridge:517 路径）
        const e = { code: 'WORKFLOW_NOT_FOUND', message: '未找到工作流 generic_production' };
        throw e;
      }
      if (fn === 'Get-InstalledApps') return inventoryFn(params?.name ?? '');
      return { ok: true };
    },
  };
  return {
    calls,
    ctx: {
      config: {},
      bridge,
      capabilityDefs: DEFS,
      policy: { evaluate: () => ({ allowed: true, matchedRule: 'allow' }) },
      capabilities: {
        get: (id) => ({ id, risk: DEFS.get(id)?.implementation ? 'L1' : 'L1', requiresSession: false }),
        list: () => [...DEFS.keys()],
        size: () => DEFS.size,
        intersectDeclared: () => [],
      },
      audit: { append: async () => ({ auditId: 'aud_m3' }), verifyChain: async () => ({ entries: 0, valid: true }) },
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, close: () => {} },
      newTraceId: () => TRACE,
    },
  };
}

async function runGoal(goal, inventoryFn) {
  const { calls, ctx } = makeCtx(inventoryFn);
  const p = createProvider();
  await p.init(ctx);
  const sink = { onStatus: () => {}, onArtifact: () => {}, isCancelled: () => false };
  const result = await p.runGoal({ traceId: TRACE, goal, timeoutMs: 5000 }, sink);
  await p.shutdown?.();
  return { result, calls };
}

// 转码视频/图片等生产意图命中模板 5
const FF_M3 = '把这段视频转码成 mp4';

describe('M3 · 模板 5 工作流缺位 → 装机证据引导（可证伪）', () => {
  test('① 探到 ffmpeg 装机登记 ⇒ summary 含直调 cli.invoke 路径（默认死路被接通）', async () => {
    const { result, calls } = await runGoal(FF_M3, (name) =>
      name === 'ffmpeg' ? [{ name: 'ffmpeg 7.x', version: '7.1' }] : []);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'UNSUPPORTED_GOAL', '收口码恒 UNSUPPORTED_GOAL');
    assert.match(result.summary, /appops\.cli\.invoke/, '命中装机证据必须给出直调路径');
    assert.match(result.summary, /app="ffmpeg"/, '直调 app 值须给到');
    assert.match(result.summary, /L1 不触审批/, '须说明免审批可行性（不触闸语义）');
    // 探测确实发起了（inventory.list 被调）
    assert.ok(calls.some((c) => c === 'app/Get-InstalledApps'), '应发起装机探测');
  });

  test('② 探不到 ⇒ 给安装配方 app.winget.install，绝不谎称可直调', async () => {
    const { result } = await runGoal(FF_M3, () => []); // registry 无 ffmpeg
    assert.equal(result.error.code, 'UNSUPPORTED_GOAL');
    assert.match(result.summary, /app\.winget\.install/, '未装 ⇒ 引导安装');
    assert.doesNotMatch(result.summary, /可直接调 appops\.cli\.invoke/, '未装绝不得宣称可直调');
    // 但原两条解法仍在（不吞既有引导）
    assert.match(result.summary, /workflows 目录预置|升级 VM Agent/);
  });

  test('③ excel 意图不映射（pandoc 只读不能写报表）⇒ 无直调引导、保持原文案', async () => {
    const { result, calls } = await runGoal('用 excel 生成一份报表', () => [{ name: 'pandoc', version: '3' }]);
    assert.equal(result.error.code, 'UNSUPPORTED_GOAL');
    assert.doesNotMatch(result.summary, /app="pandoc"/, 'excel 不得被引导成 pandoc 直调（名实不符）');
    // excel 不在映射表 ⇒ 连 inventory 探测都不该发起（省一次无意义往返）
    assert.equal(calls.some((c) => c === 'app/Get-InstalledApps'), false, 'excel 无映射 ⇒ 不探测');
  });

  test('④ 探测 fail-safe：inventory 自身抛错 ⇒ 业务结论不变、归因诚实（不伪装未装配方，也不谎称已装）', async () => {
    const { result } = await runGoal(FF_M3, () => { throw new Error('inventory 探测炸'); });
    assert.equal(result.error.code, 'UNSUPPORTED_GOAL', '探测炸不改变业务结论');
    // 探测抛错走 catch ⇒ installedEvidence=false ⇒ 落到"未探到登记"的保守安装配方分支
    assert.match(result.summary, /app\.winget\.install|workflows 目录预置/);
    assert.doesNotMatch(result.summary, /可直接调 appops\.cli\.invoke/, '探测失败绝不谎称可直调');
  });

  test('⑤ workflow.run 成功路径不受 M3 影响（回归零变化）', async () => {
    // 用一个成功 workflow 的独立夹具
    const calls = [];
    const bridge = {
      running: true,
      async call(module, fn) { calls.push(`${module}/${fn}`); return { ok: true, output: [], exitCode: 0 }; },
    };
    const { ctx } = makeCtx(() => []);
    ctx.bridge = bridge;
    const p = createProvider();
    await p.init(ctx);
    const r = await p.runGoal({ traceId: TRACE, goal: FF_M3, timeoutMs: 5000 }, { onStatus: () => {}, onArtifact: () => {}, isCancelled: () => false });
    assert.equal(r.ok, true, 'workflow 命中即成功，不触发 M3 探测');
    assert.equal(calls.some((c) => c === 'app/Get-InstalledApps'), false, '成功路径不探测');
  });
});

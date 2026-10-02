/**
 * R19c T05 · K-N1 委派层审计真实性 —— **B 组：`CliLlmBridge` 收口链行为**（设计 §9-B）
 *
 * 覆盖 §9-B 的 6 条（外加 2 条接线门控/降级护栏）：
 *   B-1 常驻禁用（persistent=false）+ probe total=0 + 文本含完成声称
 *       → 桥终态 `ok:false` + `EXECUTION_FAILED/NO_EXECUTION_RECEIPT`
 *       （A2A 框架据 `result.ok===false` 收口 **failed**，故「不发 completed」在桥层的等价断言即此）；
 *   B-2 probe total>0（executed/blocked/wild 任一）→ completed 保持（E1/E5 真执行委派零回归）；
 *   B-3 probe 抛错 → **fail-open**：透传 base + warn **恰一条**（绝不因取证件故障挂死委派）；
 *   B-4 顺序钉死：`reconcileExecutionTruth`（K5 审批回执反查）对已被 NO_EXECUTION_RECEIPT 改判的
 *       结果**不再二次改判** —— 文案/明细只能是委派判据的那一份（两判据互斥，无矛盾终态）；
 *   B-5 `appendDtid` / `buildMcpConfig(url, dtid)` 拼接形态 + dtid 缺席时**逐字节等于旧输出**（回归护栏）；
 *   B-6 账本键跨任务隔离：第二次 runGoal 用**本任务** traceId 反查，不复用第一次的活动计数；
 *   B-7 接线门控：无 taskId（纯 MCP 直调）时即便 probe 注入也**不改判**（桥只在委派上下文收口）；
 *   B-8 降级事实结构化：常驻不可用 → 回退单次 -p 且 `result.degraded.reason` 落结构化字段
 *       （§4.4，observer 落 `ext.downgraded` 的唯一来源）。
 *
 * 纪律：不起 HTTP、不 spawn 真实 CLI（沿用 k5-replay 的假 sh 脚本回显）、短超时；
 *       **不修改 packages/ 源码**，发现偏差只登记不迁就。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appendDtid,
  buildMcpConfig,
  CliLlmBridge,
} from '@winvm/adapter-agent-workbuddy-llm';

/* ============================ 夹具 ============================ */

const CAP = 'app.winget.uninstall';
const DTID = 'tr_kn1_b_77';
const TASK = 'task_kn1_b';

/** 首轮：LLM 回显审批拦截（供 B-4 让 K5 反查真正「活起来」） */
const BLOCK_TEXT =
  '工具返回 APPROVAL_REQUIRED: {"approvalId":"apr_b4","capabilityId":"app.winget.uninstall","risk":"L2"} 等待宿主审批\n';
/** 完成声称文本（COMPLETION_CLAIM_PATTERN 命中） */
const CLAIM_TEXT = '企业微信已卸载，任务完成\n';
/** 无完成声称文本（门 3 / D-3 场景） */
const PLAIN_TEXT = '我先分析一下这台机器的情况，暂不做任何变更。\n';

const EXECUTED_FAIL = { ok: false, capabilityId: CAP, summary: 'winget 未找到包', error: 'APP_NOT_FOUND' };

/**
 * 假 codebuddy：按调用次序回显 `outputs[i]`（超出回显最后一份），argv 追加到 calls.log。
 * （与 k5-replay 同构；本文件只需要「文本可控」这一条能力。）
 */
function makeFakeCli(dir, outputs) {
  outputs.forEach((text, i) => writeFileSync(join(dir, `out${i + 1}.txt`), text, 'utf8'));
  writeFileSync(join(dir, 'out_last.txt'), outputs[outputs.length - 1], 'utf8');
  const callsFile = join(dir, 'calls.log');
  const script = [
    '#!/bin/sh',
    `D="${dir}"`,
    'N=0',
    'if [ -f "$D/count" ]; then N=$(cat "$D/count"); fi',
    'N=$((N+1))',
    'echo "$N" > "$D/count"',
    'for a in "$@"; do printf \'%s\\n\' "$a" >> "$D/calls.log"; done',
    'printf \'%s\\n\' "===CALL_END===" >> "$D/calls.log"',
    'if [ -f "$D/out$N.txt" ]; then cat "$D/out$N.txt"; else cat "$D/out_last.txt"; fi',
    'exit 0',
    '',
  ].join('\n');
  const p = join(dir, 'fake-codebuddy');
  writeFileSync(p, script, 'utf8');
  chmodSync(p, 0o755);
  return {
    cliPath: p,
    readCalls: () => (existsSync(callsFile) ? readFileSync(callsFile, 'utf8') : ''),
    /** 复位调用计数（跨任务复用同一夹具时让每次委派都从 out1 开始） */
    resetCount: () => {
      try {
        rmSync(join(dir, 'count'));
      } catch {
        /* 尚未产生 count，无需复位 */
      }
    },
  };
}

function makeFakeCoordinator(outcomes) {
  const calls = [];
  let i = 0;
  return {
    calls,
    beginTask() {},
    endTask() {},
    raise(req) {
      calls.push(req);
      const o = outcomes[Math.min(i, outcomes.length - 1)];
      i += 1;
      return Promise.resolve(o);
    },
  };
}

/** 可编程 probe：按 traceId 回证据（Error → 抛错），并记录被调用的键序 */
function makeProbe(byId, fallback = { total: 0, executed: 0, blocked: 0, wild: 0 }) {
  const called = [];
  return {
    called,
    probe: {
      async delegationActivity(id) {
        called.push(id);
        const v = byId?.[id] ?? fallback;
        if (v instanceof Error) throw v;
        return v;
      },
    },
  };
}

const act = (executed = 0, blocked = 0, wild = 0) => ({
  total: executed + blocked + wild,
  executed,
  blocked,
  wild,
});

/**
 * 跑一次桥委派。默认 **persistent=false**（§9-B-1 的「常驻禁用」口径），
 * 默认注入 probe 与 warn 出口，默认带 taskId/traceId（委派上下文）。
 */
async function runB(opts) {
  const dir = mkdtempSync(join(tmpdir(), 'kn1-b-'));
  const cli = makeFakeCli(dir, opts.outputs);
  const outDir = join(dir, 'out');
  mkdirSync(outDir, { recursive: true });

  const warns = [];
  const bridgeOpts = {
    cliPath: cli.cliPath,
    outputDir: outDir,
    persistent: opts.persistent ?? false,
    endpoint: opts.endpoint ?? 'http://127.0.0.1:18443/mcp',
  };
  if (opts.approvalReplay !== undefined) bridgeOpts.approvalReplay = opts.approvalReplay;
  if (opts.onSessionLog) bridgeOpts.onSessionLog = opts.onSessionLog;
  if (opts.sessionConfig) bridgeOpts.sessionConfig = opts.sessionConfig;
  const bridge = new CliLlmBridge(bridgeOpts);
  const coord = opts.outcomes ? makeFakeCoordinator(opts.outcomes) : undefined;
  if (coord) bridge.setApprovalCoordinator(coord);

  const p = opts.probe ?? makeProbe(opts.byId ?? {}, opts.fallbackActivity ?? act());
  const statuses = [];
  const sink = { onStatus: (s, m) => statuses.push([s, m ?? '']), onArtifact: () => {} };

  const input = {
    goal: opts.goal ?? '卸载 VM 企业微信',
    capabilities: [CAP],
    outputDir: outDir,
    cliPath: cli.cliPath,
    endpoint: bridgeOpts.endpoint,
    // `null` = 显式不带 traceId（门 2 用例）；未给出 → 默认委派 traceId
    traceId: 'traceId' in opts ? opts.traceId : DTID,
    timeoutMs: opts.timeoutMs ?? 30_000,
    ...(opts.taskId !== null ? { taskId: opts.taskId ?? TASK } : {}),
    probe: p.probe,
    ...(opts.noWarn ? {} : { warn: (msg, meta) => warns.push([msg, meta ?? {}]) }),
  };
  const result = await bridge.runGoal(input, sink);
  return { result, cli, coord, warns, probe: p, statuses, bridge, dir };
}

/* ============================ B-1 零活动 + 完成声称 → failed ============================ */

describe('K-N1 B-1 委派账本零活动 + 完成声称 → 桥终态 failed（不发 completed）', () => {
  test('probe total=0 → ok:false / EXECUTION_FAILED / reason=NO_EXECUTION_RECEIPT', async () => {
    const { result, probe, bridge } = await runB({ outputs: [CLAIM_TEXT], fallbackActivity: act() });

    assert.equal(bridge.isPersistentEnabled(), false, '本例口径：常驻禁用（单次 -p 即设计）');
    assert.equal(result.ok, false, 'K-N1 根因：零调用静默 completed 必须被改判');
    assert.equal(result.error.code, 'EXECUTION_FAILED');
    assert.equal(result.error.reason, 'NO_EXECUTION_RECEIPT');
    assert.deepEqual(probe.called, [DTID], '反查键 = 本委派 traceId，恰调一次');
    assert.deepEqual(result.error.details, {
      delegationTraceId: DTID,
      taskId: TASK,
      ledger: { executed: 0, blocked: 0, wild: 0 },
    }, '三计数如实入 details（取证可直接引用，无需再解析文案）');
    assert.match(result.summary, /^执行回执缺失：委派回合服务端零活动记录/);
    assert.equal(result.steps.length, 1, 'steps 保留原长度（只翻状态，不吞结构）');
    assert.equal(result.steps[0].ok, false);
    assert.equal(result.steps[0].summary, '委派回合零服务端活动记录，完成声称不予采信');
  });

  test('warn 不被误用：改判路径不产 warn（改判是确定结论，非故障）', async () => {
    const { warns } = await runB({ outputs: [CLAIM_TEXT], fallbackActivity: act() });
    assert.deepEqual(warns, [], '零活动改判不得发告警（避免与 fail-open 告警混淆）');
  });

  test('改判只引用桥自身的 summary 快照（LLM 原文绝不内联 → 零新增泄漏面）', async () => {
    const { result } = await runB({
      outputs: [`已卸载 password=PlainTextSecret${'补'.repeat(260)}\n`],
      fallbackActivity: act(),
    });
    assert.equal(result.ok, false);
    assert.match(result.summary, /不予采信/);
    assert.doesNotMatch(JSON.stringify(result), /PlainTextSecret/, 'LLM stdout 原文不进终态（改判文案取 base.summary）');
    assert.doesNotMatch(JSON.stringify(result), /补{100,}/, 'LLM 长文本不被吞进结果（链体积/敏感面双控）');
  });
});

/* ============================ B-2 有活动 → completed 零回归 ============================ */

describe('K-N1 B-2 账本有活动 → completed 保持（真执行委派零回归）', () => {
  const cases = [
    ['executed>0', act(1, 0, 0)],
    ['blocked>0（到过且被拦，合法）', act(0, 1, 0)],
    ['wild>0（时间窗兜底命中）', act(0, 0, 1)],
  ];
  for (const [label, activity] of cases) {
    test(`${label} → 不改判`, async () => {
      const { result, probe } = await runB({ outputs: [CLAIM_TEXT], fallbackActivity: activity });
      assert.equal(result.ok, true, '判「有活动」取宽松口径：任一通道非零即采信');
      assert.deepEqual(probe.called, [DTID]);
      assert.equal(result.error, undefined);
    });
  }
});

/* ============================ B-3 probe 抛错 → fail-open ============================ */

describe('K-N1 B-3 探针故障 → fail-open（透传 + warn 恰一条）', () => {
  test('probe 抛错 → 透传 base（ok:true）且 warn 恰一条', async () => {
    const boom = new Error('ledger probe boom');
    const { result, warns, probe } = await runB({ outputs: [CLAIM_TEXT], fallbackActivity: boom });

    assert.equal(result.ok, true, '取证件故障绝不挂死/改判委派（fail-open 纪律）');
    assert.equal(result.error, undefined, '不得伪造错误码');
    assert.deepEqual(probe.called, [DTID]);
    assert.equal(warns.length, 1, 'warn **恰一条**（可观测但不影响结果）');
    assert.match(warns[0][0], /委派账本反查探针异常/);
    assert.equal(warns[0][1].delegationTraceId, DTID);
    assert.match(String(warns[0][1].error), /ledger probe boom/);
  });

  test('input.warn 缺席 → 回退桥内会话日志出口（仍恰一条）', async () => {
    const logs = [];
    const { result } = await runB({
      outputs: [CLAIM_TEXT],
      fallbackActivity: new Error('nope'),
      noWarn: true,
      onSessionLog: (msg, meta) => logs.push([msg, meta ?? {}]),
    });
    assert.equal(result.ok, true, '回退出口不影响 fail-open 结论');
    assert.equal(logs.length, 1, '告警出口回退：桥的 onSessionLog 收到恰一条');
    assert.match(logs[0][0], /委派账本反查探针异常/);
  });
});

/* ============================ B-4 两判据互斥（顺序钉死） ============================ */

describe('K-N1 B-4 委派账本反查先行 → K5 审批回执反查不二次改判（D-1：两道既有门未动）', () => {
  test('审批重放回执失败 + 账本零活动 → 终态只由委派判据给出（无 K5 文案/明细残留）', async () => {
    const { result, coord } = await runB({
      outputs: [BLOCK_TEXT, CLAIM_TEXT],
      outcomes: [{ approved: true, executed: EXECUTED_FAIL }],
      fallbackActivity: act(),
      approvalReplay: true,
    });

    assert.equal(coord.calls.length, 1, 'K5 审批链路照常工作（首门未被绕过）');
    assert.equal(result.ok, false);
    assert.equal(result.error.reason, 'NO_EXECUTION_RECEIPT');

    // 委派判据（应存在）
    assert.match(result.summary, /委派回合服务端零活动记录/);
    assert.deepEqual(Object.keys(result.error.details).sort(), ['delegationTraceId', 'ledger', 'taskId']);
    assert.equal(result.steps[0].summary, '委派回合零服务端活动记录，完成声称不予采信');

    // K5 判据（不得二次改判 —— 若二次生效，这两处文案/明细会被覆盖）
    assert.doesNotMatch(result.summary, /审批后服务端未产生成功执行记录/, 'K5 文案不得覆盖委派判据文案');
    assert.doesNotMatch(result.summary, /已登记的失败回执/, 'K5 明细不得混入');
    assert.equal(result.steps[0].summary.includes('无服务端成功回执'), false, 'steps 文案不被二次改写');
    assert.equal('approvalIds' in result.error.details, false, 'details 仍是委派判据形状（非 K5 形状）');
  });

  test('对照：账本有活动 + 审批回执失败 + 完成声称 → K5 判据仍独立生效（互斥不等于互相封死）', async () => {
    const { result } = await runB({
      outputs: [BLOCK_TEXT, CLAIM_TEXT],
      outcomes: [{ approved: true, executed: EXECUTED_FAIL }],
      fallbackActivity: act(1),
      approvalReplay: true,
    });
    assert.equal(result.ok, false, 'K5 既有语义零回归：审批后无成功回执仍改判');
    assert.match(result.summary, /审批后服务端未产生成功执行记录/);
    assert.equal(result.error.reason, 'NO_EXECUTION_RECEIPT', '两条判据复用同一 reason（§9-A-2-⑧）');
    assert.deepEqual(Object.keys(result.error.details).sort(), ['approvalIds', 'receipts']);
  });

  test('两判据门控独立：approvalReplay=false（K5 灰度 off）时委派反查**照样**生效', async () => {
    const { result, coord } = await runB({
      outputs: [BLOCK_TEXT, CLAIM_TEXT],
      outcomes: [{ approved: true }], // 灰度 off：回包无 executed
      fallbackActivity: act(),
      approvalReplay: false,
    });
    assert.equal(coord.calls.length, 1, '审批挂起仍发生（K4 提示词路径）');
    assert.equal(result.ok, false, '委派账本反查**不受**审批灰度门控（§3.3）');
    assert.match(result.summary, /委派回合服务端零活动记录/);
  });

  test('门 3 联动（D-3）：无完成声称 + 零活动 → 不改判不告警', async () => {
    const { result, warns } = await runB({
      outputs: [BLOCK_TEXT, PLAIN_TEXT],
      outcomes: [{ approved: true, executed: EXECUTED_FAIL }],
      fallbackActivity: act(),
      approvalReplay: true,
    });
    assert.equal(result.ok, true, '文本无承诺时改判是过度推断（§10-1 登记局限）');
    assert.deepEqual(warns, [], '零调用+无完成声称 → 不告警（D-3 拍板），只保证 ext.zeroInnerCalls 恒落');
  });
});

/* ============================ B-5 dtid 拼接形态 ============================ */

describe('K-N1 B-5 appendDtid / buildMcpConfig：拼接正确 + 缺席逐字节回归', () => {
  const URL = 'http://127.0.0.1:18443/mcp';
  const URL_Q = 'http://127.0.0.1:18443/mcp?x=1';
  /** T01 之前（git 608d4e0~1）的旧实现输出快照 —— 逐字节回归护栏 */
  const LEGACY_OUT = (ep) => JSON.stringify({ mcpServers: { winvm: { type: 'streamableHttp', url: ep } } });

  test('无 query → ?dtid=；已有 query → &dtid=', () => {
    assert.equal(appendDtid(URL, 'tr_1'), 'http://127.0.0.1:18443/mcp?dtid=tr_1');
    assert.equal(appendDtid(URL_Q, 'tr_1'), 'http://127.0.0.1:18443/mcp?x=1&dtid=tr_1');
    assert.equal(appendDtid(URL, 'tr_a-b_C'), 'http://127.0.0.1:18443/mcp?dtid=tr_a-b_C', 'traceId 字符集无需编码');
    assert.equal(appendDtid(URL, 'a b&c=d'), 'http://127.0.0.1:18443/mcp?dtid=a%20b%26c%3Dd', 'encodeURIComponent 保险');
  });

  test('dtid / endpoint 缺席 → 逐字节返回原值（旧行为）', () => {
    assert.equal(appendDtid(URL, undefined), URL);
    assert.equal(appendDtid(URL, ''), URL, '空 dtid 等同缺席（falsy 门）');
    assert.equal(appendDtid(undefined, 'tr_1'), undefined);
    assert.equal(appendDtid('', 'tr_1'), '', '空 endpoint 不拼 query');
  });

  test('buildMcpConfig：dtid 缺席逐字节等于旧实现（回归护栏）', () => {
    assert.equal(buildMcpConfig(URL), LEGACY_OUT(URL));
    assert.equal(buildMcpConfig(URL, undefined), LEGACY_OUT(URL));
    assert.equal(buildMcpConfig(URL, ''), LEGACY_OUT(URL), '空字符串 dtid 等同缺席');
    assert.equal(buildMcpConfig(''), JSON.stringify({ mcpServers: {} }));
    assert.equal(buildMcpConfig(undefined), JSON.stringify({ mcpServers: {} }));
  });

  test('buildMcpConfig：dtid 存在 → 仅 url 追加，结构其余逐字不变', () => {
    const out = buildMcpConfig(URL, DTID);
    assert.equal(out, `{"mcpServers":{"winvm":{"type":"streamableHttp","url":"http://127.0.0.1:18443/mcp?dtid=${DTID}"}}}`);
    const parsed = JSON.parse(out);
    assert.deepEqual(Object.keys(parsed.mcpServers), ['winvm'], '服务名不变（CLI 侧配置键零漂移）');
    assert.deepEqual(Object.keys(parsed.mcpServers.winvm).sort(), ['type', 'url']);
  });
});

/* ============================ B-6 跨任务隔离 ============================ */

describe('K-N1 B-6 账本反查键跨任务隔离（第二次委派不被第一次证据洗白）', () => {
  test('两次 runGoal → probe 各用本任务 traceId，第二次零活动照样改判', async () => {
    const p = makeProbe({ tr_task_1: act(3, 1, 0) }, act());
    const dir = mkdtempSync(join(tmpdir(), 'kn1-b6-'));
    const cli = makeFakeCli(dir, [CLAIM_TEXT]);
    const outDir = join(dir, 'out');
    mkdirSync(outDir, { recursive: true });

    const bridge = new CliLlmBridge({
      cliPath: cli.cliPath,
      outputDir: outDir,
      persistent: false,
      endpoint: 'http://127.0.0.1:18443/mcp',
    });
    const sink = { onStatus: () => {}, onArtifact: () => {} };
    const base = {
      goal: '卸载 VM 企业微信',
      capabilities: [CAP],
      outputDir: outDir,
      cliPath: cli.cliPath,
      endpoint: 'http://127.0.0.1:18443/mcp',
      timeoutMs: 30_000,
      probe: p.probe,
    };

    const r1 = await bridge.runGoal({ ...base, traceId: 'tr_task_1', taskId: 'task_1' }, sink);
    const r2 = await bridge.runGoal({ ...base, traceId: 'tr_task_2', taskId: 'task_2' }, sink);

    assert.equal(r1.ok, true, '第一次：三通道有活动 → 采信');
    assert.equal(r2.ok, false, '第二次：本任务零活动 → 改判（不继承第一次计数）');
    assert.deepEqual(p.called, ['tr_task_1', 'tr_task_2'], '反查键严格随任务切换');
    assert.equal(r2.error.details.taskId, 'task_2');
    assert.deepEqual(r2.error.details.ledger, { executed: 0, blocked: 0, wild: 0 });
  });

  test('同 traceId 连续两次委派 → raisedApprovals 不复用（K5 门也跨任务清零）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kn1-b6b-'));
    const cli = makeFakeCli(dir, [BLOCK_TEXT, CLAIM_TEXT]);
    const outDir = join(dir, 'out');
    mkdirSync(outDir, { recursive: true });
    const bridge = new CliLlmBridge({
      cliPath: cli.cliPath,
      outputDir: outDir,
      persistent: false,
      endpoint: 'http://127.0.0.1:18443/mcp',
    });
    const coord = makeFakeCoordinator([{ approved: true, executed: EXECUTED_FAIL }]);
    bridge.setApprovalCoordinator(coord);
    const p = makeProbe({}, act(1)); // 账本有活动 → 委派判据放行，单独观察 K5 侧
    const sink = { onStatus: () => {}, onArtifact: () => {} };
    const input = {
      goal: '卸载 VM 企业微信',
      capabilities: [CAP],
      outputDir: outDir,
      cliPath: cli.cliPath,
      endpoint: 'http://127.0.0.1:18443/mcp',
      timeoutMs: 30_000,
      traceId: DTID,
      taskId: TASK,
      probe: p.probe,
    };
    await bridge.runGoal(input, sink);
    // 夹具复位：假 CLI 按调用次序消费 out1/out2（out1=BLOCK_TEXT 触发审批、out2=CLAIM_TEXT 不触发）。
    // 本例要观察的是「同 traceId 两次委派**各自**都发起审批」，故让第二次委派重新从 out1 起算——
    // 否则第二次消费 CLAIM_TEXT，`coord.raise` 天然不会被调用，断言的是夹具行为而非源码的
    // `raisedApprovals.clear()`（`bridge.ts` runGoal 入口，每次委派独立清零）。
    cli.resetCount();
    await bridge.runGoal(input, sink);
    assert.equal(coord.calls.length, 2, '第二任务是新的审批（不被第一任务的 raised 去重吞掉）');
    assert.deepEqual(p.called, [DTID, DTID], '同 traceId 两次委派两次反查');
  });
});

/* ============================ B-7 接线门控：非委派上下文 ============================ */

describe('K-N1 B-7 桥接线门控：无 taskId（纯 MCP 直调 / 宿主内部）零改动', () => {
  test('probe 注入 + total=0，但无 taskId → 不改判（门 2 由桥的字段展开保证）', async () => {
    const { result, probe } = await runB({ outputs: [CLAIM_TEXT], taskId: null, fallbackActivity: act() });
    assert.equal(result.ok, true, '非委派上下文语义逐字节不变（§3.2 门 2）');
    assert.equal(probe.called.length, 0, 'taskId 缺席时桥根本不把 taskId 传下去 → 判据在门 2 前退场');
    assert.equal(result.error, undefined);
  });

  test('probe 未注入（旧宿主 / 单测）→ 透传，且绝不抛', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kn1-b7-'));
    const cli = makeFakeCli(dir, [CLAIM_TEXT]);
    const outDir = join(dir, 'out');
    mkdirSync(outDir, { recursive: true });
    const bridge = new CliLlmBridge({
      cliPath: cli.cliPath,
      outputDir: outDir,
      persistent: false,
      endpoint: 'http://127.0.0.1:18443/mcp',
    });
    const result = await bridge.runGoal(
      {
        goal: '卸载 VM 企业微信',
        capabilities: [CAP],
        outputDir: outDir,
        cliPath: cli.cliPath,
        endpoint: 'http://127.0.0.1:18443/mcp',
        traceId: DTID,
        taskId: TASK,
        timeoutMs: 30_000,
      },
      { onStatus: () => {}, onArtifact: () => {} },
    );
    assert.equal(result.ok, true, '门 4（未注入 probe = 旧行为）零回归');
  });

  test('无 traceId 但有 taskId → 同样退场（门 2 双条件）', async () => {
    const { result, probe } = await runB({
      outputs: [CLAIM_TEXT],
      traceId: undefined,
      fallbackActivity: act(),
    });
    assert.equal(result.ok, true);
    assert.equal(probe.called.length, 0, 'delegationTraceId 缺席 → 不查账本');
  });
});

/* ============================ B-8 降级事实结构化（§4.4） ============================ */

describe('K-N1 B-8 常驻不可用 → 回退单次 -p 且 degraded 结构化落字段', () => {
  test('persistent=true 但会话不可用 → result.degraded.reason 存在（observer 落 ext.downgraded 的来源）', async () => {
    const { result, statuses } = await runB({
      outputs: [CLAIM_TEXT],
      persistent: true,
      fallbackActivity: act(2),
      sessionConfig: { readyTimeoutMs: 400, warmupReadyMs: 400, idleTtlMs: 5_000, maxRestarts: 0 },
    });

    assert.equal(result.ok, true, '委派仍完成（降级不破功能，AC1.5）');
    assert.equal(typeof result.degraded?.reason, 'string', '降级事实必须结构化可见，不能只在 summary 文案里');
    assert.match(result.summary, /已降级为单次 -p 路径/);
    assert.ok(
      statuses.some(([, m]) => String(m).includes('回退单次')),
      '进度如实播报降级',
    );
  });

  test('persistent=false → 不产 degraded（无「降级」可言，单次 -p 即设计）', async () => {
    const { result } = await runB({ outputs: [CLAIM_TEXT], persistent: false, fallbackActivity: act(1) });
    assert.equal(result.ok, true);
    assert.equal('degraded' in result, false, '非降级路径不得出现该键（避免 observer 误记 ext.downgraded）');
  });
});

/**
 * T04 · CL-K3R「静默假成功」根治 —— 红档 C 组：端到端桥收口（stub 探针返回未决事实 + stub CLI 文本不含关键词
 * ⇒ 终态应 `input-required`，**不再 completed**）
 *
 * 被测对象：`CliLlmBridge.runGoal`（设计 §5.2 / §7.4，落地于 `packages/adapter-agent-workbuddy-llm`）。
 * 对照 R19c 双桥共享 coordinator 骨架与 gate 文件因果序（根因 §6.2 / §8.2）：本文件复用 `r19c-kn1-b-bridge`
 * 的「假 codebuddy + 注入 stub 探针」骨架，把断言从「零活动 → failed」换成「有未决审批事实 + 文本无关键词
 * → input-required（即桥产物 ok:false + APPROVAL_REQUIRED + 触发 raise）」。
 *
 * 红档纪律：T03 未合入 dist 前，`reconcileApprovalTruth` 尚未接入 `runPersistent`/`runOneShot` 的收口点，
 * 旧桥只走文本启发式 `reconcileApprovalWait` → 文本不含关键词 ⇒ 透传 `ok:true` ⇒ 终态 `completed`（假成功）。
 * 故本文件断言 `result.ok === false && error.code === 'APPROVAL_REQUIRED'` 在旧桥下**必然 FAIL** —— 这是
 * 预期红（证明 K3 假成功在 T03 前仍存在）。T03 落地 + `tsc -b` 重建 dist 后，新桥结构化优先判据命中 ⇒ 转绿
 * （§7.3 验收判据 2）。
 *
 * 纪律：不起 HTTP、不连 VM、不 spawn 真实 CLI（假 sh 回显）；不修改 packages/ 源码。
 *
 * 运行（只跑本文件，绝不整批）：
 *   TMPDIR="$HOME/wbtmp" node --test tests/unit/r19c-k3r-bridge-integ.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { CliLlmBridge } from '@winvm/adapter-agent-workbuddy-llm';

/* ============================ 夹具 ============================ */

const CAP = 'app.winget.uninstall';
const TRACE = 'tr_k3r_int_77';
const TASK = 'task_k3r_int';
const STARTED = 1_000_000;

/** 临时目录：沙箱 /tmp 只读，一律用 $HOME/wbtmp（与 QA 纪律一致），不依赖 TMPDIR 环境变量 */
function makeWorkDir(prefix) {
  const base = join(homedir(), 'wbtmp');
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, prefix));
}

/**
 * 假 codebuddy：按调用次序回显 `outputs[i]`（超出回显最后一份），argv 追加到 calls.log。
 * （与 r19c-kn1-b-bridge / k5-replay 同构；本文件只需要「文本可控」这一条能力。）
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
  };
}

/** 假 coordinator：记录 raise 调用（断言「触发挂起 ⇒ 框架收口 input-required」的等价证据） */
function makeFakeCoordinator() {
  const calls = [];
  return {
    calls,
    beginTask() {},
    endTask() {},
    raise(req) {
      calls.push(req);
      return Promise.resolve({ approved: true, executed: { ok: false, capabilityId: CAP, summary: 'x', error: 'X' } });
    },
  };
}

/**
 * 可编程审批探针（K3R 主通道）：`delegationActivity` 恒零活动（隔离 K-N1，专测 K3R）；
 * `approvalWait` 返回 `facts`（模拟服务端确有未决拦截）。`delegateActivity` 缺省为零，
 * 确保旧桥（K-N1 通道）不因 completion-claim 误改判，从而把「终态是否变」完全归因为 K3R 接线。
 */
function makeK3rProbe(facts) {
  return {
    delegationActivity: async () => ({ total: 0, executed: 0, blocked: 0, wild: 0 }),
    approvalWait: async () => facts,
  };
}

/** K3 场景文本：LLM 回显**不含** APPROVAL_REQUIRED / 等待审批（触发 K3 假成功的措辞漂移） */
const NO_KEYWORD_TEXT = '操作已被安全策略拦截，需宿主确认后继续推进。\n';

/* ============================ 端到端 ============================ */

describe('CL-K3R 桥收口：stub 探针有未决事实 + CLI 文本无关键词 ⇒ input-required（不再 completed）', () => {
  test('K3 根治：服务端确有拦截且 LLM 不说关键词 → 桥产物 ok:false + APPROVAL_REQUIRED + 触发 raise', async () => {
    const dir = makeWorkDir('k3r-integ-');
    const cli = makeFakeCli(dir, [NO_KEYWORD_TEXT]);
    const outDir = join(dir, 'out');
    mkdirSync(outDir, { recursive: true });

    const bridge = new CliLlmBridge({
      cliPath: cli.cliPath,
      outputDir: outDir,
      persistent: false,
      endpoint: 'http://127.0.0.1:18443/mcp',
    });
    const coord = makeFakeCoordinator();
    bridge.setApprovalCoordinator(coord);

    const facts = [
      {
        approvalId: 'apr_k3r_int',
        capabilityId: CAP,
        risk: 'L2',
        createdAtMs: STARTED + 1000,
        attribution: 'window',
        hostApproved: false,
      },
    ];
    const warns = [];
    const sink = { onStatus: () => {}, onArtifact: () => {} };
    const input = {
      goal: '卸载 VM 企业微信',
      capabilities: [CAP],
      outputDir: outDir,
      cliPath: cli.cliPath,
      endpoint: 'http://127.0.0.1:18443/mcp',
      traceId: TRACE,
      taskId: TASK,
      timeoutMs: 30_000,
      // 经 `input.probe`（桥内部透传给 reconciliation 上下文）注入 K3R 探针
      probe: makeK3rProbe(facts),
      warn: (msg, meta) => warns.push([msg, meta ?? {}]),
    };

    const result = await bridge.runGoal(input, sink);

    // —— 核心断言：K3 假成功被结构性消除 ——
    // 桥层证据：`reconcileApprovalTruth` 把「服务端未决拦截」翻译成 error ⇒ `maybeResume` 触发 `raise`
    // （A2A 框架据 raise 把任务收口为 `input-required`）。故「raise 被调用且携带服务端权威 approvalId」
    // 即 K3 根治的等价桥层断言；`result.ok === false` 证明确实没有 `completed`（旧桥下此处为 ok:true）。
    // 注：raise 之后的 `result.error.code` 会被 coordinator 回执（批准后续跑）改写，不宜作为判据；
    // 判定 K3 是否生效以「raise 是否发生 + approvalId 是否来自服务端」为准。
    assert.equal(result.ok, false, 'K3 根治：LLM 不说关键词但服务端确有拦截 ⇒ 不再 completed');
    assert.equal(coord.calls.length, 1, '触发 raise ⇒ A2A 框架收口 input-required（等价断言）');
    assert.equal(
      coord.calls[0]?.approvalId,
      'apr_k3r_int',
      'raise 携带服务端权威 approvalId（非 LLM 文本抠，根治 K3-a evade）',
    );
  });

  test('对照·关守：CLI 文本含关键词（A5 同款）时旧文本路径仍生效（不破坏 A5 指纹）', async () => {
    const dir = makeWorkDir('k3r-integ-a5-');
    const cli = makeFakeCli(dir, ['工具返回 APPROVAL_REQUIRED：{"approvalId":"apr_a5_int","capabilityId":"app.winget.uninstall","risk":"L2"} 等待宿主审批\n']);
    const outDir = join(dir, 'out');
    mkdirSync(outDir, { recursive: true });

    const bridge = new CliLlmBridge({
      cliPath: cli.cliPath,
      outputDir: outDir,
      persistent: false,
      endpoint: 'http://127.0.0.1:18443/mcp',
    });
    const coord = makeFakeCoordinator();
    bridge.setApprovalCoordinator(coord);
    const sink = { onStatus: () => {}, onArtifact: () => {} };
    const input = {
      goal: '卸载 VM 企业微信',
      capabilities: [CAP],
      outputDir: outDir,
      cliPath: cli.cliPath,
      endpoint: 'http://127.0.0.1:18443/mcp',
      traceId: TRACE,
      taskId: TASK,
      timeoutMs: 30_000,
      // 即便注入了 K3R 探针，文本命中时仍应走文本路径（冗余、幂等），不破坏 A5 指纹
      probe: makeK3rProbe([]),
      warn: () => {},
    };

    const result = await bridge.runGoal(input, sink);
    assert.equal(result.ok, false, 'A5 同款：文本命中 ⇒ 不 completed');
    assert.equal(coord.calls.length, 1, 'A5 文本路径仍触发 raise（旧行为零改动，指纹不破坏）');
  });
});

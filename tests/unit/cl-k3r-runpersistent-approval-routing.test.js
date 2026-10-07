/**
 * CL-K3R Phase-D 修复回归测试 —— `CliLlmBridge.runPersistent` 的「审批暂停态」路由。
 *
 * 背景（根因 `docs/test/reports/k3r-t05-phase-d-blocker-2026-10-05.md`）：
 *   常驻（stream-json）会话里，codebuddy 安全策略会在调用 winvm 工具**之前**拦截高危操作，
 *   并以 `is_error=true` 的 result 事件上报（文本含 `APPROVAL_REQUIRED` + `apr_…` token），
 *   从而 `turn.ok=false`。修复前 `runPersistent` 在 `!turn.ok` 时**直接返回 EXECUTION_FAILED**，
 *   先于 K3R 的 `reconcileApprovalTruth` —— 而后者又有「门 0：!base.ok 透传」纪律，
 *   于是审批暂停态被误判成真执行失败，Phase D 永远 INCONCLUSIVE。
 *
 * 修复后：`!turn.ok` 分支先跑文本启发式 `reconcileApprovalWait`（既有 K3 机制，不受 shadow 门控）。
 *   - 文本命中审批等待模式 → 改判 ok:false + APPROVAL_REQUIRED，并路由 maybeResume（input-required）；
 *   - 文本未命中 → 保持 EXECUTION_FAILED（真执行失败）。
 *
 * 本测试不依赖 VM / codebuddy / 隧道（纯内存驱动 runPersistent，桩掉会话与 MCP 落盘）。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CliLlmBridge } from '@winvm/adapter-agent-workbuddy-llm';

/** 桩：把 prepareMcpConfig / ensureSession 替换成无副作用版本，并注入「轮结果」。 */
class StubBridge extends CliLlmBridge {
  /** @param {object} opts @param {object} turn 要让 runTurn 返回的 TurnResult */
  constructor(opts, turn) {
    super(opts);
    this._turn = turn;
  }
  // 返回任意非空串即可（runPersistent 仅判 undefined → unavailable）
  async prepareMcpConfig() {
    return '/tmp/k3r-stub-mcp.json';
  }
  // 返回极简会话：只暴露 sessionState 与 runTurn
  ensureSession() {
    return {
      sessionState: 'ready',
      runTurn: async () => this._turn,
    };
  }
}

/** 组装最小 RunContext（private 接口，运行期纯对象即可）。 */
function makeCtx(outputDir) {
  return {
    prompt: 'system-prompt-stub',
    outputDir,
    skillsDir: path.join(outputDir, '.winvm', 'skills'),
    started: Date.now(),
    cli: { resolved: true, path: 'codebuddy', probed: [] },
    lastFinalText: '',
    receipts: new Map(),
    raised: new Set(),
    replayActive: false,
  };
}

/** 组装最小 LlmGoalInput（只给 runPersistent 实际读取的字段）。 */
function makeInput(goal, traceId) {
  return {
    goal,
    capabilities: ['appops.workflow.run'],
    outputDir: '%USERPROFILE%\\WinVMWorkspace\\out',
    cliPath: 'codebuddy',
    traceId,
    timeoutMs: 60_000,
  };
}

const sink = { onStatus() {}, onArtifact() {} };

describe('CL-K3R runPersistent 审批暂停态路由', () => {
  test('!turn.ok + 文本命中 APPROVAL_REQUIRED → 改判 APPROVAL_REQUIRED（input-required 前置）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k3r-a-'));
    const turn = {
      ok: false,
      text:
        '操作被安全策略拦截。APPROVAL_REQUIRED：高危能力需宿主审批。' +
        'approvalId="apr_8379ba256c2c4379921f"，capabilityId="appops.workflow.run"，risk="L3"。' +
        '在发起前被策略拦截，目标未执行。',
      durationMs: 1234,
    };
    const bridge = new StubBridge({ persistent: true }, turn);
    const out = await bridge.runPersistent(makeInput('卸载高危包', 'trace-A'), sink, makeCtx(dir));
    assert.ok('result' in out, '应返回 { result } 而非 { unavailable }');
    const r = out.result;
    assert.equal(r.ok, false, '审批暂停态应为 ok:false');
    assert.equal(r.error?.code, 'APPROVAL_REQUIRED', '应改判为 APPROVAL_REQUIRED');
    assert.equal(r.error?.details?.approvalId, 'apr_8379ba256c2c4379921f', '应透传解析出的 approvalId');
  });

  test('!turn.ok + 文本为真实错误（无 APPROVAL_REQUIRED）→ 保持 EXECUTION_FAILED', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k3r-b-'));
    const turn = {
      ok: false,
      text: 'codebuddy 运行时报错：无法连接 MCP 端点（ECONNREFUSED），目标未执行。',
      durationMs: 2000,
      error: 'LLM 返回错误结果：ECONNREFUSED',
    };
    const bridge = new StubBridge({ persistent: true }, turn);
    const out = await bridge.runPersistent(makeInput('正常目标', 'trace-B'), sink, makeCtx(dir));
    assert.ok('result' in out);
    const r = out.result;
    assert.equal(r.ok, false);
    assert.equal(r.error?.code, 'EXECUTION_FAILED', '真实失败应保持 EXECUTION_FAILED，不被误判为审批');
  });

  test('turn.ok=true + 无审批文本 → 保持 ok:true（回归守卫：成功路径不被改判）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k3r-c-'));
    const turn = {
      ok: true,
      text: '已完成目标：已列出已安装的应用包。',
      durationMs: 5600,
    };
    const bridge = new StubBridge({ persistent: true }, turn);
    const out = await bridge.runPersistent(makeInput('列出应用', 'trace-C'), sink, makeCtx(dir));
    assert.ok('result' in out);
    const r = out.result;
    assert.equal(r.ok, true, '正常完成应 ok:true');
  });

  test('shadow 模式 + 审批文本 → 仅 warn 不改判（保持 EXECUTION_FAILED，供对拍观察）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k3r-d-'));
    const warns = [];
    const turn = {
      ok: false,
      text:
        '操作被安全策略拦截。APPROVAL_REQUIRED：高危能力需宿主审批。' +
        'approvalId="apr_8379ba256c2c4379921f"，capabilityId="appops.workflow.run"，risk="L3"。',
      durationMs: 1234,
    };
    const bridge = new StubBridge(
      { persistent: true, approvalTruth: 'shadow', onSessionLog: (m, meta) => warns.push({ m, meta }) },
      turn,
    );
    const out = await bridge.runPersistent(makeInput('卸载高危包', 'trace-D'), sink, makeCtx(dir));
    assert.ok('result' in out);
    const r = out.result;
    assert.equal(r.ok, false);
    assert.equal(r.error?.code, 'EXECUTION_FAILED', 'shadow 态不得改判，应保持 EXECUTION_FAILED');
    assert.ok(
      warns.some((w) => typeof w.m === 'string' && w.m.includes('[shadow]')),
      'shadow 态应发出 [shadow] warn 埋点',
    );
  });
});

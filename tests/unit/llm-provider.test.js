/**
 * LLM provider（adapter-agent-workbuddy-llm）单元测试
 *
 * 验证点（NFR-LLM-3 可测试性）：不依赖真实 codebuddy CLI，
 * 通过注入 MockLlmBridge + 假 executor 完成 runGoal 接线与委托验证。
 */

import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { registerProviderFactory, unregisterProviderFactory } from '@winvm/core';
import {
  buildSystemPrompt,
  createProvider,
  DEFAULT_CLI_ARG_TEMPLATE,
  escapeWinArg,
  flattenPromptForCli,
  isFatalRuntimeStderr,
  LLM_SESSION_WARMUP_GOAL,
  loadSkillDocs,
  PROVIDER_ID,
  renderCliArgs,
  writeSkillPack,
} from '@winvm/adapter-agent-workbuddy-llm';

function fakeCtx() {
  return {
    config: {},
    audit: {
      append: async () => ({ hash: 'h', prevHash: '', seq: 0, auditId: 'a' }),
      verifyChain: async () => ({ valid: true, entries: 0 }),
    },
    policy: { evaluate: () => ({ allowed: true, matchedRule: 'test' }) },
    capabilities: {
      get: () => ({ risk: 'L1', requiresSession: false }),
      list: () => ['system.info.get', 'appops.gui.produce', 'gui.screen.capture'],
      has: () => true,
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    newTraceId: () => 'trace_' + Math.random().toString(36).slice(2),
  };
}

function fakeExecutor() {
  const calls = [];
  return {
    calls,
    id: 'fake-exec',
    kind: 'deterministic',
    displayName: 'fake',
    declareCapabilities: () => [],
    async init() {},
    async execute(req) {
      calls.push(req);
      return { traceId: req.traceId, ok: true, data: { echoed: req.capabilityId }, durationMs: 1 };
    },
    async health() {
      return { ok: true, provider: { id: 'fake', state: 'ready' }, session: {}, psBridge: { state: 'ready', uptimeMs: 1, pending: 0 } };
    },
    async runGoal() {
      calls.push({ capabilityId: '__runGoal__' });
      // 确定性执行器在无匹配模板时明确失败（UNSUPPORTED_GOAL），供 D4.4 降级路径验证
      return {
        ok: false,
        summary: '确定性执行器未匹配到模板',
        artifacts: [],
        steps: [],
        error: { code: 'UNSUPPORTED_GOAL', message: 'UNSUPPORTED_GOAL' },
      };
    },
    async shutdown() {},
  };
}

function mockBridge(ok, errorCode = 'EXECUTION_FAILED') {
  return {
    async runGoal(input, sink) {
      sink.onStatus('working', 'mock step');
      if (!ok) {
        return { ok: false, summary: 'mock fail', artifacts: [], steps: [], error: { code: errorCode, message: 'MOCK_FAIL' } };
      }
      return {
        ok: true,
        summary: 'mock ok',
        artifacts: [{ kind: 'file', name: 'out.png', mime: 'image/png', data: 'YWJj', encoding: 'base64' }],
        steps: [
          { index: 0, capabilityId: 'appops.workflow.run', params: { goal: input.goal }, ok: true, risk: 'L1', durationMs: 1, traceId: input.traceId, summary: 'mock' },
        ],
      };
    },
  };
}

function captureSink() {
  const statuses = [];
  const artifacts = [];
  return {
    statuses,
    artifacts,
    onStatus(_s, m) {
      statuses.push(m);
    },
    onArtifact(a) {
      artifacts.push(a);
    },
    async onApprovalRequired() {
      return true;
    },
  };
}

describe('WorkbuddyLlmProvider', () => {
  test('createProvider 暴露 id=workbuddy / kind=llm-agent / 全能力域', () => {
    const p = createProvider({ bridge: mockBridge(true), executor: fakeExecutor() });
    assert.equal(p.id, 'workbuddy');
    assert.equal(p.kind, 'llm-agent');
    assert.equal(PROVIDER_ID, 'workbuddy');
    const caps = p.declareCapabilities();
    for (const d of ['meta', 'system', 'app', 'storage', 'gui', 'appops']) {
      assert.ok(caps.includes(`${d}.*`), `应声明 ${d}.*`);
    }
  });

  test('runGoal 成功：注入 mock bridge → ok + artifact + step + 进度回传', async () => {
    const p = createProvider({ bridge: mockBridge(true), executor: fakeExecutor() });
    await p.init(fakeCtx());
    const sink = captureSink();
    const res = await p.runGoal({ traceId: 't1', goal: '用 PS 把大山换成海洋', timeoutMs: 1000 }, sink);
    assert.equal(res.ok, true);
    assert.equal(res.artifacts.length, 1);
    assert.equal(res.artifacts[0].name, 'out.png');
    assert.equal(res.steps.length, 1);
    assert.ok(sink.statuses.length >= 1, '应回传进度');
  });

  test('runGoal 失败：LLM 运行时不可用 → 降级为确定性执行并如实标注，不伪造', async () => {
    const p = createProvider({ bridge: mockBridge(false, 'PROVIDER_UNAVAILABLE'), executor: fakeExecutor() });
    await p.init(fakeCtx());
    const res = await p.runGoal({ traceId: 't2', goal: '未知目标', timeoutMs: 1000 }, captureSink());
    assert.equal(res.ok, false);
    assert.ok(res.summary.includes('降级'), 'summary 应标明已降级为确定性执行');
    assert.equal(res.error.code, 'UNSUPPORTED_GOAL', '确定性执行器也无模板时才真正失败');
  });

  test('runGoal 失败：不可降级错误（TIMEOUT）原样返回，不降级', async () => {
    const exec = fakeExecutor();
    const p = createProvider({ bridge: mockBridge(false, 'TIMEOUT'), executor: exec });
    await p.init(fakeCtx());
    const res = await p.runGoal({ traceId: 't2b', goal: '未知目标', timeoutMs: 1000 }, captureSink());
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'TIMEOUT');
    assert.equal(exec.calls.length, 0, '超时不应触发确定性执行器降级（避免重复劳动）');
  });

  test('execute 委托给注入的 executor（复用确定性执行链路）', async () => {
    const exec = fakeExecutor();
    const p = createProvider({ bridge: mockBridge(true), executor: exec });
    await p.init(fakeCtx());
    const req = { traceId: 't3', capabilityId: 'gui.screen.capture', params: {}, risk: 'L1', approved: false, timeoutMs: 1000 };
    const r = await p.execute(req);
    assert.equal(r.ok, true);
    assert.equal(exec.calls.length, 1);
    assert.equal(exec.calls[0].capabilityId, 'gui.screen.capture');
  });

  test('warmup：fire-and-forget 预热委托 bridge.warmup（无害目标）；未 init 时安全 no-op', async () => {
    const calls = [];
    const spyBridge = {
      async warmup(prompt) {
        calls.push(prompt);
        return true;
      },
    };
    const p = createProvider({ bridge: spyBridge, executor: fakeExecutor() });
    // 未 init → warmup 应安全返回，不触达 bridge
    await p.warmup();
    assert.equal(calls.length, 0, '未 init 时 warmup 应为 no-op');

    await p.init(fakeCtx());
    await p.warmup();
    assert.equal(calls.length, 1, 'init 后应触发一次预热委派');
    assert.equal(calls[0], LLM_SESSION_WARMUP_GOAL, '预热目标应是无害的最短指令');
    assert.ok(calls[0].toUpperCase().includes('OK'), '预热目标应要求极简回复');
  });

  test('经 loader 注册工厂可加载（agent.provider 切换机制）', async () => {
    registerProviderFactory('workbuddy', (opts) => createProvider({ ...opts, bridge: mockBridge(true), executor: fakeExecutor() }));
    const { loadProvider } = await import('@winvm/core');
    const prov = await loadProvider(
      { provider: 'workbuddy', providers: { workbuddy: { package: '@winvm/adapter-agent-workbuddy-llm', options: {} } } },
      fakeCtx(),
    );
    assert.equal(prov.id, 'workbuddy');
    assert.equal(prov.kind, 'llm-agent');
    unregisterProviderFactory('workbuddy');
  });
});

describe('VM 内 Agent 的技能下发与 CLI 契约', () => {
  test('renderCliArgs 渲染占位符（CLI 契约可配置）', () => {
    const args = renderCliArgs(['--goal', '{goal}', '--mcp', '{endpoint}', '--output', '{output}'], {
      goal: 'g',
      endpoint: 'http://127.0.0.1:18443/mcp',
      output: 'C:/out',
    });
    assert.deepEqual(args, ['--goal', 'g', '--mcp', 'http://127.0.0.1:18443/mcp', '--output', 'C:/out']);
  });

  test('默认 CLI 模板符合真机 codebuddy 契约（-p 位置提示词 + --mcp-config + --add-dir）', () => {
    const tpl = DEFAULT_CLI_ARG_TEMPLATE;
    assert.ok(tpl.includes('-p'), '非交互应使用 -p/--print');
    assert.ok(tpl.includes('{prompt}'), '提示词应为位置参数 {prompt}');
    assert.ok(tpl.includes('--output-format'), '应声明输出格式');
    assert.ok(tpl.includes('--permission-mode'), '应免交互（bypassPermissions）');
    assert.ok(tpl.includes('--add-dir'), '产物目录应经 --add-dir 授权');
    assert.ok(tpl.includes('--mcp-config'), 'MCP 应经 --mcp-config 传入');
    assert.ok(tpl.includes('{mcpConfig}'), 'MCP 配置串占位符');
    assert.ok(tpl.includes('{output}'), '产物目录占位符');
    // 真机不存在的旧选项必须消失（CL-017 D4）
    for (const bad of ['--goal', '--system-prompt', '--mcp', '--output']) {
      assert.ok(!tpl.includes(bad), `不应再含真机不支持的选项 ${bad}`);
    }
  });

  test('buildSystemPrompt 注入技能规范与能力目录', () => {
    const skills = [{ id: 'winvm-app-operation', name: '应用生产操作', description: '用桌面软件把活干出来', body: '# body' }];
    const prompt = buildSystemPrompt({
      goal: '把大山换成海洋',
      capabilities: ['appops.gui.produce', 'gui.screen.capture'],
      outputDir: 'C:/out',
      cliPath: 'codebuddy',
      traceId: 't',
      timeoutMs: 1000,
      skills,
    });
    assert.ok(prompt.includes('appops.gui.produce'), '应含能力目录');
    assert.ok(prompt.includes('winvm-app-operation'), '应含技能 id');
    assert.ok(prompt.includes('应用生产操作'), '应含技能名称');
    assert.ok(prompt.includes('.winvm'), '应给出技能包落盘目录');
    assert.ok(prompt.includes('把大山换成海洋'), '应含用户目标');
  });

  // ---- K3 修复（审批纪律）：LLM 须能识别 APPROVAL_REQUIRED、严禁自我审批、上报「等待审批」 ----
  // 背景：真机实证 LLM 把能力返回的 APPROVAL_REQUIRED 误读为「已执行成功」，谎报卸载完成。
  function k3Prompt() {
    return buildSystemPrompt({
      goal: '卸载企业微信',
      capabilities: ['app.winget.uninstall'],
      outputDir: 'C:/out',
      cliPath: 'codebuddy',
      traceId: 'k3',
      timeoutMs: 1000,
    });
  }

  test('K3-1 buildSystemPrompt 含错误码字面量 APPROVAL_REQUIRED（LLM 须能识别）', () => {
    assert.ok(k3Prompt().toLowerCase().includes('approval_required'), '系统提示应含 APPROVAL_REQUIRED 字面量');
  });

  test('K3-2 buildSystemPrompt 明确禁止自行携带 __approvalId 重发（防自我审批）', () => {
    const p = k3Prompt().toLowerCase();
    assert.ok(p.includes('__approvalid'), '系统提示应含 __approvalId 字面量');
    assert.ok(p.includes('严禁'), '禁止须用强禁止词「严禁」表述');
  });

  test('K3-3 buildSystemPrompt 规定被拦截后状态为「等待审批」而非「完成」', () => {
    const p = k3Prompt();
    assert.ok(p.includes('等待审批'), '应含「等待审批」上报状态语义');
    assert.ok(p.includes('不是「完成」'), '应明确等待审批 ≠ 完成');
  });

  test('K3-4 buildSystemPrompt 含强禁止词「严禁」且要求如实上报 approvalId 与能力名', () => {
    const p = k3Prompt();
    assert.ok(p.includes('严禁'), '应含强禁止词「严禁」');
    assert.ok(p.includes('approvalId'), '应要求上报 approvalId');
    assert.ok(p.includes('能力名'), '应要求上报被拦截的能力名');
    // 原有语义保留：每步完成后回传截图/中间产物
    assert.ok(p.includes('回传截图'), '应保留每步回传截图/中间产物的语义');
  });

  test('writeSkillPack 把技能规范落盘', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'winvm-skills-'));
    const files = await writeSkillPack(
      [
        { id: 'winvm-app-operation', name: 'a', body: '# A' },
        { id: 'winvm-gui-automation', name: 'b', body: '# B' },
      ],
      dir,
    );
    assert.equal(files.length, 2);
    assert.equal(await readFile(join(dir, 'winvm-app-operation.md'), 'utf8'), '# A\n');
  });

  test('loadSkillDocs 从仓库 skills 目录加载 6 个 Skill 规范', async () => {
    const repoSkills = resolve(import.meta.dirname, '..', '..', 'skills');
    const docs = await loadSkillDocs(repoSkills);
    assert.ok(docs.length >= 6, `应加载到 6 个以上 Skill，实际 ${docs.length}`);
    const ids = docs.map((d) => d.id);
    assert.ok(ids.includes('winvm-orchestrator'), '应含总控 Skill');
    assert.ok(ids.includes('winvm-app-operation'), '应含应用生产操作 Skill');
    const orch = docs.find((d) => d.id === 'winvm-orchestrator');
    assert.ok(orch.body.includes('通道选择'), '应保留 Skill 正文供 VM 内 Agent 查阅');
  });

  // CL-017 D4：cmd.exe 命令行转义 / 换行适配（真机实测：Node 默认加引号会把 \" 传坏、换行会截断）
  test('escapeWinArg：普通参数不加引号，含空白/元字符整体加引号', () => {
    assert.equal(escapeWinArg('plain'), 'plain');
    assert.equal(escapeWinArg('C:\\WinVMWorkspace\\out'), 'C:\\WinVMWorkspace\\out');
    assert.equal(escapeWinArg('a b'), '"a b"');
    assert.equal(escapeWinArg('a&b'), '"a&b"');
  });

  test('escapeWinArg：内嵌引号按 msvcrt 规则转义（\\"），结尾反斜杠翻倍', () => {
    assert.equal(escapeWinArg('a"b'), '"a\\"b"');
    // 结尾反斜杠必须翻倍，否则闭合引号会被该反斜杠转义 → 引号失配
    assert.equal(escapeWinArg('C:\\my out\\'), '"C:\\my out\\\\"');
  });

  test('flattenPromptForCli：CRLF/CR/LF 统一替换为 U+2028（cmd 不会截断）', () => {
    const out = flattenPromptForCli('a\nb\r\nc\rd');
    assert.equal(out, 'a\u2028b\u2028c\u2028d');
    assert.ok(!/[\r\n]/.test(out), '不应残留 CR/LF');
  });

  // 真机 codebuddy 未登录时退出码为 0 但 stderr 报 Authentication required → 必须判为不可用（触发降级）
  test('isFatalRuntimeStderr：识别未登录/未授权等「退出码 0 的假成功」', () => {
    assert.equal(isFatalRuntimeStderr('Authentication required. Please use /login command to sign in to your account'), true);
    assert.equal(isFatalRuntimeStderr('error: Unauthorized'), true);
    assert.equal(isFatalRuntimeStderr('C:\\Users\\User\\WinVMWorkspace\\out not found'), false);
    assert.equal(isFatalRuntimeStderr(''), false);
  });
});

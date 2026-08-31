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
    async shutdown() {},
  };
}

function mockBridge(ok) {
  return {
    async runGoal(input, sink) {
      sink.onStatus('working', 'mock step');
      if (!ok) {
        return { ok: false, summary: 'mock fail', artifacts: [], steps: [], error: { code: 'EXECUTION_FAILED', message: 'MOCK_FAIL' } };
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

  test('runGoal 失败：注入失败 bridge → ok:false + error，不伪造', async () => {
    const p = createProvider({ bridge: mockBridge(false), executor: fakeExecutor() });
    await p.init(fakeCtx());
    const res = await p.runGoal({ traceId: 't2', goal: '未知目标', timeoutMs: 1000 }, captureSink());
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'EXECUTION_FAILED');
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

  test('默认 CLI 模板含 goal / prompt / endpoint / output 四类占位符', () => {
    const tpl = DEFAULT_CLI_ARG_TEMPLATE.join(' ');
    for (const k of ['{goal}', '{prompt}', '{endpoint}', '{output}']) {
      assert.ok(tpl.includes(k), `默认模板应含 ${k}`);
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
});

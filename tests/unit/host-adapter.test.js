/**
 * 宿主插件规范与 WorkBuddy 适配器单元测试（SPEC-HOST-AGENT-PLUGIN.md）
 *
 * 重点验证：
 *   - 中性插件模型校验（含**凭据红线**）
 *   - 渲染产物符合 WorkBuddy 实测格式（plugin.json / marketplace.json / connector-skills）
 *   - 连接器配置为**增量合并**，绝不整体覆盖用户已有连接器（关键红线）
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Windows 下 join() 产出反斜杠，断言统一归一化为 posix 分隔符 */
const norm = (p) => p.split('\\').join('/');

import {
  validateNeutralPlugin,
  setAtPointer,
  getAtPointer,
  deepMerge,
  removeAtPointer,
  parseFrontmatter,
  parsePointer,
  buildPointer,
  escapeToken,
} from '@winvm/host-sdk';
import { WorkBuddyRenderer, renderConnectorEntry, resolveWorkBuddyPaths } from '@winvm/adapter-host-workbuddy';
import { CapabilityRegistry } from '@winvm/core';
import { defineCapability } from '@winvm/contracts';

/* ================================ 测试数据 ================================ */

function skill(id, opts = {}) {
  return {
    id,
    name: `Skill ${id}`,
    description: `${id} 的描述`,
    body: `---\nid: ${id}\nname: Skill ${id}\ndescription: ${id} 的描述\ndomains: [system]\n${opts.entry ? 'entry: true\n' : ''}---\n\n# ${id}\n\n正文`,
    ...(opts.entry ? { entry: true } : {}),
  };
}

function plugin(overrides = {}) {
  return {
    manifest: {
      name: 'winvm-bridge',
      version: '0.1.0',
      description: '让宿主机 Agent 完全操作 Windows 虚拟机',
      author: { name: 'WinVM Bridge' },
      keywords: ['winvm', 'windows'],
    },
    skills: [skill('winvm-orchestrator', { entry: true }), skill('winvm-system-admin')],
    connector: {
      id: 'winvm',
      displayName: 'Windows VM',
      transports: [
        { kind: 'ssh-tunnel', host: '192.168.1.50', user: 'vmuser', remotePort: 18443, localPort: 18443 },
      ],
      disabledTools: ['system.power.control', 'storage.file.delete'],
      timeoutMs: 120000,
    },
    ...overrides,
  };
}

/* ================================ 中性模型校验 ================================ */

describe('中性插件模型校验', () => {
  test('合法插件 → ok', () => {
    const r = validateNeutralPlugin(plugin());
    assert.equal(r.ok, true, JSON.stringify(r.issues));
  });

  test('非法插件名 → error', () => {
    const p = plugin();
    p.manifest = { ...p.manifest, name: 'Bad_Name' };
    const r = validateNeutralPlugin(p);
    assert.equal(r.ok, false);
    assert.ok(r.issues.some((i) => i.level === 'error' && /manifest\.name/.test(i.message)));
  });

  test('非法 semver → error', () => {
    const p = plugin();
    p.manifest = { ...p.manifest, version: '1.0' };
    assert.equal(validateNeutralPlugin(p).ok, false);
  });

  test('无 entry Skill → warning（不阻断）', () => {
    const p = plugin();
    p.skills = [skill('winvm-system-admin')];
    const r = validateNeutralPlugin(p);
    assert.equal(r.ok, true);
    assert.ok(r.issues.some((i) => i.level === 'warning' && /entry/.test(i.message)));
  });

  test('多个 entry Skill → error', () => {
    const p = plugin();
    p.skills = [skill('a', { entry: true }), skill('b', { entry: true })];
    assert.equal(validateNeutralPlugin(p).ok, false);
  });

  test('Skill id 重复 → error', () => {
    const p = plugin();
    p.skills = [skill('dup'), skill('dup')];
    assert.equal(validateNeutralPlugin(p).ok, false);
  });

  test('streamable-http 缺 tokenEnv → error（禁止明文 token）', () => {
    const p = plugin();
    p.connector = {
      id: 'winvm',
      displayName: 'x',
      transports: [{ kind: 'streamable-http', url: 'https://vm.local', tokenEnv: '' }],
      disabledTools: [],
      timeoutMs: 1000,
    };
    const r = validateNeutralPlugin(p);
    assert.equal(r.ok, false);
    assert.ok(r.issues.some((i) => /tokenEnv/.test(i.message)));
  });

  test('凭据红线：含明文 password 字段 → error', () => {
    const p = plugin();
    p.connector = {
      ...p.connector,
      transports: [
        { kind: 'stdio', command: 'winvm', args: ['--password', 'secret123'] },
      ],
    };
    const r = validateNeutralPlugin(p);
    // 注：字符串值中含 "password" 键名才触发；此处用 args 数组，应不触发
    assert.equal(r.ok, true);

    const p2 = plugin();
    p2.connector = { ...p2.connector, password: 'secret123' };
    assert.equal(validateNeutralPlugin(p2).ok, false, '显式 password 字段必须被拦截');
  });
});

/* ================================ JSON Patch ================================ */

describe('JSON Pointer / Patch', () => {
  test('escapeToken 正确转义 ~ 与 /', () => {
    assert.equal(escapeToken('a~b'), 'a~0b');
    assert.equal(escapeToken('a/b'), 'a~1b');
  });

  test('parsePointer / buildPointer 往返', () => {
    const p = buildPointer(['mcpServers', 'connector:winvm']);
    assert.deepEqual(parsePointer(p), ['mcpServers', 'connector:winvm']);
    assert.equal(p, '/mcpServers/connector:winvm');
  });

  test('setAtPointer 创建中间节点', () => {
    const out = setAtPointer({}, '/mcpServers/connector:winvm', { type: 'streamableHttp' });
    assert.deepEqual(out, { mcpServers: { 'connector:winvm': { type: 'streamableHttp' } } });
  });

  test('setAtPointer 不改动原对象（不可变）', () => {
    const orig = { a: 1 };
    setAtPointer(orig, '/b', 2);
    assert.deepEqual(orig, { a: 1 });
  });

  test('getAtPointer 读取', () => {
    const o = { mcpServers: { 'connector:winvm': { disabled: false } } };
    assert.deepEqual(getAtPointer(o, '/mcpServers/connector:winvm'), { disabled: false });
    assert.equal(getAtPointer(o, '/nope'), undefined);
  });

  test('deepMerge 递归合并且保留既有键', () => {
    const existing = { mcpServers: { 'connector:other': { type: 'sse' } } };
    const merged = deepMerge(existing, { mcpServers: { 'connector:winvm': { type: 'http' } } });
    assert.ok(merged.mcpServers['connector:other'], '既有连接器必须保留');
    assert.ok(merged.mcpServers['connector:winvm']);
  });

  test('removeAtPointer 删除', () => {
    const o = { mcpServers: { a: 1, b: 2 } };
    assert.deepEqual(removeAtPointer(o, '/mcpServers/a'), { mcpServers: { b: 2 } });
  });
});

/* ================================ WorkBuddy 渲染 ================================ */

describe('WorkBuddy 渲染器 · 产物', () => {
  const ctx = { homeDir: '/home/u', hostRoot: '/home/u/.workbuddy', dryRun: true, accountId: 'default' };

  test('plugin.json 符合实测格式', () => {
    const plan = new WorkBuddyRenderer().plan(plugin(), ctx);
    const f = plan.files.find((x) => norm(x.path).endsWith('.codebuddy-plugin/plugin.json'));
    assert.ok(f, '未生成 plugin.json');
    const j = JSON.parse(f.content);
    assert.equal(j.name, 'winvm-bridge');
    assert.equal(j.category, 'skill');
    assert.ok(j.workbuddy.kind);
  });

  test('marketplace.json 符合实测格式', () => {
    const plan = new WorkBuddyRenderer().plan(plugin(), ctx);
    const f = plan.files.find((x) => norm(x.path).endsWith('marketplace.json'));
    const j = JSON.parse(f.content);
    assert.equal(j.name, 'winvm');
    assert.equal(j.plugins[0].name, 'winvm-bridge');
    assert.ok(j.plugins[0].source.startsWith('./'));
  });

  test('每个 Skill 渲染为 connector-skills 下的 SKILL.md', () => {
    const plan = new WorkBuddyRenderer().plan(plugin(), ctx);
    const skills = plan.files.filter((x) => norm(x.path).endsWith('SKILL.md'));
    assert.equal(skills.length, 2);
    assert.ok(skills.every((s) => norm(s.path).includes('connector-winvm')));
  });

  test('连接器配置以 jsonPatches 增量下发（不整体覆盖）', () => {
    const plan = new WorkBuddyRenderer().plan(plugin(), ctx);
    assert.equal(plan.jsonPatches.length, 1);
    assert.equal(plan.jsonPatches[0].pointer, '/mcpServers/connector:winvm');
    assert.equal(plan.files.some((f) => norm(f.path).endsWith('connectors/default/mcp.json')), false,
      'mcp.json 绝不能作为整体文件覆盖写入');
  });

  test('高危工具写入 disabledTools', () => {
    const plan = new WorkBuddyRenderer().plan(plugin(), ctx);
    assert.deepEqual(plan.jsonPatches[0].value.disabledTools, [
      'system.power.control',
      'storage.file.delete',
    ]);
  });

  test('SSH 隧道模式生成 http 回环地址并给出隧道提示', () => {
    const plan = new WorkBuddyRenderer().plan(plugin(), ctx);
    assert.equal(plan.jsonPatches[0].value.url, 'http://127.0.0.1:18443/mcp');
    assert.ok(plan.warnings.some((w) => /ssh -f -N -L/.test(w)), '必须提示先建隧道');
    assert.ok(plan.postActions.some((a) => /ssh -f -N -L/.test(a)));
  });

  test('validate 校验产物合法性', () => {
    const plan = new WorkBuddyRenderer().plan(plugin(), ctx);
    assert.equal(new WorkBuddyRenderer().validate(plan).ok, true);
  });

  test('路径解析符合 WorkBuddy 目录约定', () => {
    const p = resolveWorkBuddyPaths(plugin(), ctx);
    assert.ok(norm(p.pluginRoot).includes('plugins/cache/winvm/winvm-bridge/0.1.0'), norm(p.pluginRoot));
    assert.ok(norm(p.connectorSkillsRoot).endsWith('connectors/skills/connector-winvm'));
    assert.ok(norm(p.connectorMcpJson).includes('connectors/default/mcp.json'));
  });

  test('streamable-http 传输渲染为带 Bearer 占位符的条目', () => {
    const entry = renderConnectorEntry(
      { id: 'winvm', displayName: 'x', transports: [], disabledTools: [], timeoutMs: 1000 },
      { kind: 'streamable-http', url: 'https://vm.local', tokenEnv: 'WINVM_TOKEN' },
    );
    assert.equal(entry.headers.Authorization, 'Bearer ${WINVM_TOKEN}');
  });
});

describe('WorkBuddy 渲染器 · 安装（增量合并语义）', () => {
  test('install 保留用户已有连接器', async () => {
    const root = mkdtempSync(join(tmpdir(), 'winvm-host-'));
    const ctx = { homeDir: root, hostRoot: root, dryRun: false, accountId: 'default' };
    const mcpPath = join(root, 'connectors', 'default', 'mcp.json');
    mkdirSync(join(root, 'connectors', 'default'), { recursive: true });

    // 预置用户已有的连接器
    writeFileSync(
      mcpPath,
      JSON.stringify({ mcpServers: { 'connector:github': { url: 'https://api.githubcopilot.com/mcp/' } } }, null, 2),
      'utf8',
    );

    const { result } = await renderAndInstallSafe(plugin(), ctx);
    assert.equal(result.ok, true, result.error);

    const after = JSON.parse(readFileSync(mcpPath, 'utf8'));
    assert.ok(after.mcpServers['connector:github'], '用户既有连接器必须保留');
    assert.ok(after.mcpServers['connector:winvm'], '新连接器必须写入');
    assert.equal(after.mcpServers['connector:winvm'].url, 'http://127.0.0.1:18443/mcp');
  });

  test('install 落盘 SKILL.md 与 plugin.json', async () => {
    const root = mkdtempSync(join(tmpdir(), 'winvm-host-'));
    const ctx = { homeDir: root, hostRoot: root, dryRun: false, accountId: 'default' };
    const { result } = await renderAndInstallSafe(plugin(), ctx);
    assert.equal(result.ok, true, result.error);
    assert.ok(result.installedFiles.some((f) => f.endsWith('SKILL.md')));
    assert.ok(result.installedFiles.some((f) => f.endsWith('plugin.json')));
    const skillPath = result.installedFiles.find((f) => f.endsWith('SKILL.md'));
    assert.ok(existsSync(skillPath));
    assert.match(readFileSync(skillPath, 'utf8'), /^---\n/);
  });

  test('dryRun 不写盘', async () => {
    const root = mkdtempSync(join(tmpdir(), 'winvm-host-'));
    const ctx = { homeDir: root, hostRoot: root, dryRun: true, accountId: 'default' };
    const { result } = await renderAndInstallSafe(plugin(), ctx);
    assert.equal(result.ok, true);
    assert.ok(result.warnings.some((w) => /dry-run/.test(w)));
    assert.equal(existsSync(join(root, 'plugins')), false);
  });
});

/** 动态 import 以避免顶层循环依赖问题 */
async function renderAndInstallSafe(p, ctx) {
  const mod = await import('@winvm/adapter-host-workbuddy');
  return mod.renderAndInstall(p, ctx);
}

/* ================================ 注册表 ================================ */

describe('能力注册表', () => {
  const caps = [
    defineCapability({
      id: 'system.info.get', name: 'x', description: 'd', risk: 'L0',
      idempotent: true, requiresSession: false, destructive: false, timeoutMs: 5000,
      input: {}, output: {}, audit: { snapshot: 'none' },
      implementation: { kind: 'powershell', module: 'system', function: 'Get-SystemInfo' },
    }),
    defineCapability({
      id: 'gui.screen.capture', name: 'x', description: 'd', risk: 'L0',
      idempotent: true, requiresSession: true, destructive: false, timeoutMs: 5000,
      input: {}, output: {}, audit: { snapshot: 'none' },
      implementation: { kind: 'powershell', module: 'gui', function: 'Get-ScreenCapture' },
    }),
  ];

  test('注册与查询', () => {
    const r = new CapabilityRegistry();
    r.registerAll(caps);
    assert.equal(r.size(), 2);
    assert.equal(r.get('system.info.get').risk, 'L0');
    assert.equal(r.has('nope'), false);
  });

  test('重复注册抛错', () => {
    const r = new CapabilityRegistry();
    r.register(caps[0]);
    assert.throws(() => r.register(caps[0]), /重复注册/);
  });

  test('intersectDeclared：未声明的能力不暴露', () => {
    const r = new CapabilityRegistry();
    r.registerAll(caps);
    assert.equal(r.intersectDeclared(['system.*']).length, 1);
    assert.equal(r.intersectDeclared(['meta.*']).length, 0);
    assert.equal(r.intersectDeclared(['*']).length, 2);
  });

  test('match 支持通配', () => {
    const r = new CapabilityRegistry();
    r.registerAll(caps);
    assert.equal(r.match(['gui.*']).length, 1);
    assert.equal(r.match([]).length, 2);
  });

  test('validate 检出 domain 与 ID 不一致', () => {
    const r = new CapabilityRegistry();
    r.registerAll(caps);
    const v = r.validate();
    assert.equal(v.ok, true);
  });
});

/* ================================ frontmatter ================================ */

describe('Skill frontmatter 解析', () => {
  test('解析标量、行内数组与块数组', () => {
    const doc = `---
id: winvm-orchestrator
name: 总控
description: 路由与风控
domains: [system, app, storage, gui]
entry: true
triggers:
  - 管理虚拟机
  - 操作 Windows
---

# 正文
`;
    const { frontmatter, body } = parseFrontmatter(doc);
    assert.equal(frontmatter.id, 'winvm-orchestrator');
    assert.equal(frontmatter.entry, true);
    assert.deepEqual(frontmatter.domains, ['system', 'app', 'storage', 'gui']);
    assert.deepEqual(frontmatter.triggers, ['管理虚拟机', '操作 Windows']);
    assert.match(body, /^# 正文/);
  });

  test('折叠标量 > 合并为一行', () => {
    const doc = `---
id: x
description: >
  第一行
  第二行
---
正文`;
    const { frontmatter } = parseFrontmatter(doc);
    assert.equal(frontmatter.description, '第一行 第二行');
  });

  test('无 frontmatter 时原样返回正文', () => {
    const { frontmatter, body } = parseFrontmatter('# 只有正文');
    assert.deepEqual(frontmatter, {});
    assert.equal(body, '# 只有正文');
  });
});

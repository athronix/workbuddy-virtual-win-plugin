/**
 * MCP 上游工具面接入（2026-11-17）单测
 *
 * 覆盖三块**纯逻辑**面（不 spawn 子进程，真机链路由 POC 与端到端验证覆盖）：
 *   1. `mcpPath` 渲染 —— 多个 connector 复用同一条隧道，只靠路径区分工具面；
 *   2. `extraConnectors` 模型校验 —— id 唯一 / 禁 stdio / mcpPath 格式；
 *   3. `buildChannelOptions` 的 Windows 批处理包裹 —— 教训 A8 的回归护栏。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { validateNeutralPlugin } from '@winvm/host-sdk';
import { renderConnectorEntry } from '@winvm/adapter-host-workbuddy';
import {
  buildChannelOptions,
  defaultUpstreamSpecs,
  UpstreamRegistry,
  DEFAULT_DESKTOP_TOOL_ALLOWLIST,
} from '../../packages/vm-service/dist/mcp-upstream.js';

const SSH_TUNNEL = Object.freeze({
  kind: 'ssh-tunnel',
  host: '192.168.1.50',
  user: 'vmuser',
  remotePort: 18443,
  localPort: 18443,
});

function connector(overrides = {}) {
  return {
    id: 'winvm-desktop',
    displayName: 'Windows VM · desktop',
    transports: [SSH_TUNNEL],
    disabledTools: [],
    timeoutMs: 120_000,
    ...overrides,
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
    skills: [
      {
        id: 'winvm-orchestrator',
        name: 'Skill winvm-orchestrator',
        description: '总控',
        body: '---\nid: winvm-orchestrator\nname: Skill\ndescription: 总控\nentry: true\n---\n\n正文',
        entry: true,
      },
    ],
    connector: connector({ id: 'winvm', disabledTools: ['system.power.control'] }),
    ...overrides,
  };
}

describe('mcpPath：多工具面复用同一条隧道', () => {
  test('缺省仍是 /mcp（旧行为零回归）', () => {
    const e = renderConnectorEntry(connector({ id: 'winvm' }), SSH_TUNNEL);
    assert.equal(e['url'], 'http://127.0.0.1:18443/mcp');
  });

  test('显式 mcpPath 拼在同一个 localPort 上', () => {
    const desk = renderConnectorEntry(connector({ mcpPath: '/mcp/desktop' }), SSH_TUNNEL);
    const brow = renderConnectorEntry(connector({ id: 'winvm-browser', mcpPath: '/mcp/browser' }), SSH_TUNNEL);
    assert.equal(desk['url'], 'http://127.0.0.1:18443/mcp/desktop');
    assert.equal(brow['url'], 'http://127.0.0.1:18443/mcp/browser');
    // 关键：两条 connector 共用同一 localPort ⇒ 只需一条 SSH 隧道
    assert.equal(desk['type'], 'streamableHttp');
  });

  test('streamable-http 分支同样消费 mcpPath', () => {
    const e = renderConnectorEntry(
      connector({ mcpPath: '/mcp/desktop' }),
      { kind: 'streamable-http', url: 'http://127.0.0.1:9000/' },
    );
    assert.equal(e['url'], 'http://127.0.0.1:9000/mcp/desktop');
  });
});

describe('extraConnectors 模型校验', () => {
  test('合法额外连接器 → ok', () => {
    const r = validateNeutralPlugin(
      plugin({ extraConnectors: [connector({ mcpPath: '/mcp/desktop' })] }),
    );
    assert.equal(r.ok, true, JSON.stringify(r.issues));
  });

  test('id 与主 connector 重复 → error', () => {
    const r = validateNeutralPlugin(plugin({ extraConnectors: [connector({ id: 'winvm' })] }));
    assert.equal(r.ok, false);
    assert.ok(r.issues.some((i) => i.level === 'error' && /重复/.test(i.message)));
  });

  test('id 与 a2aBridge 重复 → error', () => {
    const r = validateNeutralPlugin(
      plugin({
        a2aBridge: connector({ id: 'winvm-a2a', transports: [{ kind: 'stdio', command: 'node', args: [] }] }),
        extraConnectors: [connector({ id: 'winvm-a2a' })],
      }),
    );
    assert.equal(r.ok, false);
    assert.ok(r.issues.some((i) => i.level === 'error' && /重复/.test(i.message)));
  });

  test('stdio 传输被拒（额外工具面必在 VM 侧）', () => {
    const r = validateNeutralPlugin(
      plugin({ extraConnectors: [connector({ transports: [{ kind: 'stdio', command: 'node', args: [] }] })] }),
    );
    assert.equal(r.ok, false);
    assert.ok(r.issues.some((i) => i.level === 'error' && /stdio/.test(i.message)));
  });

  test('mcpPath 不以 / 开头 → error', () => {
    const r = validateNeutralPlugin(
      plugin({ extraConnectors: [connector({ mcpPath: 'mcp/desktop' })] }),
    );
    assert.equal(r.ok, false);
    assert.ok(r.issues.some((i) => i.level === 'error' && /mcpPath/.test(i.message)));
  });

  test('id 非法字符 → error', () => {
    const r = validateNeutralPlugin(
      plugin({ extraConnectors: [connector({ id: 'WinVM_Desktop' })] }),
    );
    assert.equal(r.ok, false);
    assert.ok(r.issues.some((i) => i.level === 'error' && /id 非法/.test(i.message)));
  });
});

describe('上游声明与通道构造', () => {
  test('默认上游＝browser + desktop，desktop 带精简白名单', () => {
    const specs = defaultUpstreamSpecs();
    const byId = new Map(specs.map((s) => [s.id, s]));
    assert.deepEqual([...byId.keys()].sort(), ['browser', 'desktop']);
    // 浏览器工具面全量（33 个，无白名单）；桌面默认只放高频子集
    assert.equal(byId.get('browser').toolAllowlist, undefined);
    assert.ok(Array.isArray(byId.get('desktop').toolAllowlist));
    assert.equal(byId.get('desktop').toolAllowlist.length, 10);
  });

  test('桌面白名单只含观察/交互闭环工具，不含破坏性动作', () => {
    for (const name of ['desktop_snapshot', 'desktop_click', 'desktop_type', 'desktop_wait']) {
      assert.ok(DEFAULT_DESKTOP_TOOL_ALLOWLIST.includes(name), `缺少 ${name}`);
    }
    for (const name of ['desktop_close_app', 'desktop_clipboard_set', 'desktop_sandbox']) {
      assert.ok(!DEFAULT_DESKTOP_TOOL_ALLOWLIST.includes(name), `不应默认暴露 ${name}`);
    }
  });

  test('win32 下用 cmd.exe /c 包裹批处理（教训 A8 回归护栏）', () => {
    const spec = defaultUpstreamSpecs().find((s) => s.id === 'desktop');
    const win = buildChannelOptions(spec, 'win32');
    assert.equal(win.command, 'cmd.exe');
    assert.deepEqual(win.args, ['/c', 'agent-desktop.cmd', 'mcp']);

    const posix = buildChannelOptions(spec, 'linux');
    assert.equal(posix.command, 'agent-desktop.cmd');
    assert.deepEqual(posix.args, ['mcp']);
  });

  test('注册表初始态全为 idle（懒启动，未首启不算故障）', () => {
    const reg = new UpstreamRegistry(defaultUpstreamSpecs(), () => undefined);
    const st = reg.statuses();
    assert.equal(st.length, 2);
    for (const s of st) {
      assert.equal(s.state, 'idle');
      assert.equal(s.tools, undefined);
    }
    assert.equal(reg.get('nope'), undefined);
  });
});

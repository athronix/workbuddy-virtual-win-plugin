/**
 * HermesMcpRegistrar 纯函数单元测试（不触碰真实 hermes 安装）
 *
 * 覆盖 ADR-13 的「最小侵入行级 YAML 合并」与 .env 幂等写入逻辑。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  upsertMcpServerBlock,
  upsertEnvVar,
  tokenEnvVarForServer,
  expandEnvPath,
} from '@winvm/adapter-agent-hermes';

describe('tokenEnvVarForServer', () => {
  test('winvm → MCP_WINVM_API_KEY', () => {
    assert.equal(tokenEnvVarForServer('winvm'), 'MCP_WINVM_API_KEY');
  });
  test('含连字符 → 转下划线', () => {
    assert.equal(tokenEnvVarForServer('my-server'), 'MCP_MY_SERVER_API_KEY');
  });
  test('含下划线数字 → 保留', () => {
    assert.equal(tokenEnvVarForServer('winvm_2'), 'MCP_WINVM_2_API_KEY');
  });
});

describe('expandEnvPath', () => {
  test('展开 %USERPROFILE%', () => {
    assert.equal(
      expandEnvPath('%USERPROFILE%/x/y', { USERPROFILE: 'C:/Users/me' }),
      'C:/Users/me/x/y',
    );
  });
  test('无占位符原样返回', () => {
    assert.equal(expandEnvPath('C:/WinVMBridge/skills', {}), 'C:/WinVMBridge/skills');
  });
});

describe('upsertMcpServerBlock', () => {
  const opts = { name: 'winvm', url: 'http://127.0.0.1:18443/mcp', tokenEnvVar: 'MCP_WINVM_API_KEY' };

  test('配置无 mcp_servers 段 → 追加整段（created）', () => {
    const text = 'hermes:\n  home: x\n';
    const r = upsertMcpServerBlock(text, opts);
    assert.equal(r.changed, true);
    assert.equal(r.action, 'created');
    assert.match(r.text, /^mcp_servers:/m);
    assert.match(r.text, /^\s{2}winvm:/m);
    assert.match(r.text, /url: http:\/\/127\.0\.0\.1:18443\/mcp/m);
    assert.match(r.text, /Authorization: Bearer \$\{MCP_WINVM_API_KEY\}/m);
  });

  test('已有段但无 winvm 条目 → 段内追加（created）', () => {
    const text = 'mcp_servers:\n  other:\n    url: http://x\n';
    const r = upsertMcpServerBlock(text, opts);
    assert.equal(r.action, 'created');
    assert.match(r.text, /other:/);
    assert.match(r.text, /winvm:/);
    assert.match(r.text, /url: http:\/\/127\.0\.0\.1:18443\/mcp/);
  });

  test('已有相同 url 的 winvm 条目 → 原样返回（noop，不覆盖用户字段）', () => {
    const text =
      'mcp_servers:\n  winvm:\n    enabled: true\n    url: http://127.0.0.1:18443/mcp\n    headers:\n      Authorization: Bearer ${MCP_WINVM_API_KEY}\n    extra_user_field: keepme\n';
    const r = upsertMcpServerBlock(text, opts);
    assert.equal(r.action, 'noop');
    assert.equal(r.changed, false);
    assert.match(r.text, /extra_user_field: keepme/);
  });

  test('已有 winvm 条目但 url 不同 → 替换（updated）', () => {
    const text =
      'mcp_servers:\n  winvm:\n    enabled: true\n    url: http://old:9999/mcp\n    headers:\n      Authorization: Bearer ${MCP_WINVM_API_KEY}\n';
    const r = upsertMcpServerBlock(text, opts);
    assert.equal(r.action, 'updated');
    assert.match(r.text, /url: http:\/\/127\.0\.0\.1:18443\/mcp/);
    assert.ok(!/http:\/\/old:9999\/mcp/.test(r.text));
  });

  test('保留 CRLF 行尾', () => {
    const text = 'mcp_servers:\r\n  other:\r\n    url: http://x\r\n';
    const r = upsertMcpServerBlock(text, opts);
    assert.ok(r.text.includes('\r\n'), '应输出 CRLF');
  });
});

describe('upsertEnvVar', () => {
  test('空文本 → 追加（created）', () => {
    const r = upsertEnvVar('', 'MCP_WINVM_API_KEY', 'tok');
    assert.equal(r.action, 'created');
    assert.equal(r.changed, true);
    assert.equal(r.text, 'MCP_WINVM_API_KEY=tok\n');
  });

  test('已存在不同值 → 替换（updated）', () => {
    const r = upsertEnvVar('MCP_WINVM_API_KEY=old\nFOO=1\n', 'MCP_WINVM_API_KEY', 'new');
    assert.equal(r.action, 'updated');
    assert.equal(r.changed, true);
    assert.match(r.text, /MCP_WINVM_API_KEY=new/);
    assert.match(r.text, /FOO=1/);
  });

  test('已存在相同值 → noop', () => {
    const text = 'MCP_WINVM_API_KEY=tok\n';
    const r = upsertEnvVar(text, 'MCP_WINVM_API_KEY', 'tok');
    assert.equal(r.action, 'noop');
    assert.equal(r.changed, false);
  });
});

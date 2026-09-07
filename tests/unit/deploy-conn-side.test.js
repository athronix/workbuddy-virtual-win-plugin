#!/usr/bin/env node
/**
 * 部署期持久化标记的单元验证：
 *  - install-host.mjs: writeVmConnConfig / removeVmConnConfig  → ~/.workbuddy/winvm/vm-conn.json
 *  - install-vm.mjs:    writeVmSideMarker / removeVmSideMarker → ~/.workbuddy/winvm/side.json
 * 这两个标记是「部署时设好连接信息、用时不必再指定」的根基，故用临时 home 验证真实写盘/删除。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeVmConnConfig, removeVmConnConfig } from '../../delivery/install-host.mjs';
import { writeVmSideMarker, removeVmSideMarker } from '../../delivery/install-vm.mjs';

let home;
function freshHome() {
  if (home) rmSync(home, { recursive: true, force: true });
  home = mkdtempSync(join(tmpdir(), 'winvm-conn-side-'));
  return home;
}

test('writeVmConnConfig 写入正确 JSON，removeVmConnConfig 删除', () => {
  const h = freshHome();
  const p = writeVmConnConfig({ host: '100.108.20.13', user: 'User', sshPort: 22, servicePort: 18443 }, h);
  assert.equal(p, join(h, '.workbuddy', 'winvm', 'vm-conn.json'));
  assert.ok(existsSync(p), 'vm-conn.json 应已写入');
  const obj = JSON.parse(readFileSync(p, 'utf8'));
  assert.deepEqual(obj, { host: '100.108.20.13', user: 'User', sshPort: 22, servicePort: 18443 });

  assert.equal(removeVmConnConfig(h), true, '删除应返回 true');
  assert.equal(existsSync(p), false, 'vm-conn.json 应已删除');
  assert.equal(removeVmConnConfig(h), false, '再次删除应返回 false（已不存在）');
});

test('writeVmConnConfig 缺省端口：sshPort=22 servicePort=18443', () => {
  const h = freshHome();
  const p = writeVmConnConfig({ host: 'h', user: 'u' }, h);
  const obj = JSON.parse(readFileSync(p, 'utf8'));
  assert.equal(obj.sshPort, 22);
  assert.equal(obj.servicePort, 18443);
});

test('writeVmSideMarker 写入 {"side":"vm"}，removeVmSideMarker 删除', () => {
  const h = freshHome();
  const p = writeVmSideMarker(h);
  assert.equal(p, join(h, '.workbuddy', 'winvm', 'side.json'));
  assert.ok(existsSync(p), 'side.json 应已写入');
  assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')), { side: 'vm' });

  assert.equal(removeVmSideMarker(h), true, '删除应返回 true');
  assert.equal(existsSync(p), false, 'side.json 应已删除');
  assert.equal(removeVmSideMarker(h), false, '再次删除应返回 false（已不存在）');
});

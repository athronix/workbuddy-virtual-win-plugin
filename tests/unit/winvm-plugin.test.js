#!/usr/bin/env node
/**
 * winvm-plugin.mjs 单元驗证：VM 连接信息解析优先级（resolveVmConn）
 *
 * 优先级（高→低）：argv(--vm-*) > 环境变量 WINVM_VM_* > .env(VM_*) > 持久化 vm-conn.json > 默认值。
 * 该逻辑是「宿主侧 health/server/command 无需每次传 --vm-host/--vm-user」的根基：
 * 部署期 install-host.mjs 写入 ~/.workbuddy/winvm/vm-conn.json，resolveVmConn 当作兜底来源读取。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveVmConn } from '../../delivery/winvm-plugin.mjs';

const base = { argv: {}, env: {}, dotEnv: {}, persisted: {} };

test('默认值：全部缺省时回落到 host="" user="" sshPort=22 servicePort=18443', () => {
  const r = resolveVmConn(base);
  assert.equal(r.host, '');
  assert.equal(r.user, '');
  assert.equal(r.sshPort, 22);
  assert.equal(r.servicePort, 18443);
  assert.equal(r.provider, '');
  assert.equal(r.cli, '');
});

test('argv 最高优先：覆盖 env / dotEnv / persisted', () => {
  const r = resolveVmConn({
    argv: { vmHost: 'argv-host', vmUser: 'argv-user', vmSshPort: 2222, vmPort: 9999, vmProvider: 'p', vmCli: 'c' },
    env: { WINVM_VM_HOST: 'env-host', WINVM_VM_USER: 'env-user', WINVM_VM_SSH_PORT: '1111', WINVM_VM_PORT: '8888' },
    dotEnv: { VM_HOST: 'dot-host', VM_USER: 'dot-user', VM_SSH_PORT: '3333', WINVM_SERVICE_PORT: '7777' },
    persisted: { host: 'file-host', user: 'file-user', sshPort: 4444, servicePort: 5555 },
  });
  assert.equal(r.host, 'argv-host');
  assert.equal(r.user, 'argv-user');
  assert.equal(r.sshPort, 2222);
  assert.equal(r.servicePort, 9999);
  assert.equal(r.provider, 'p');
  assert.equal(r.cli, 'c');
});

test('env WINVM_VM_* 次之：覆盖 dotEnv / persisted，低于 argv', () => {
  const r = resolveVmConn({
    argv: {},
    env: { WINVM_VM_HOST: 'env-host', WINVM_VM_USER: 'env-user', WINVM_VM_SSH_PORT: '1111', WINVM_VM_PORT: '8888' },
    dotEnv: { VM_HOST: 'dot-host', VM_USER: 'dot-user', VM_SSH_PORT: '3333', WINVM_SERVICE_PORT: '7777' },
    persisted: { host: 'file-host', user: 'file-user', sshPort: 4444, servicePort: 5555 },
  });
  assert.equal(r.host, 'env-host');
  assert.equal(r.user, 'env-user');
  assert.equal(r.sshPort, 1111);
  assert.equal(r.servicePort, 8888);
});

test('dotEnv VM_* 再次之：覆盖 persisted，低于 env', () => {
  const r = resolveVmConn({
    argv: {},
    env: {},
    dotEnv: { VM_HOST: 'dot-host', VM_USER: 'dot-user', VM_SSH_PORT: '3333', WINVM_SERVICE_PORT: '7777' },
    persisted: { host: 'file-host', user: 'file-user', sshPort: 4444, servicePort: 5555 },
  });
  assert.equal(r.host, 'dot-host');
  assert.equal(r.user, 'dot-user');
  assert.equal(r.sshPort, 3333);
  assert.equal(r.servicePort, 7777);
});

test('persisted（vm-conn.json）兜底：仅在 argv/env/dotEnv 全缺时生效', () => {
  const r = resolveVmConn({
    argv: {},
    env: {},
    dotEnv: {},
    persisted: { host: 'file-host', user: 'file-user', sshPort: 4444, servicePort: 5555, provider: 'pp', cli: 'cc' },
  });
  assert.equal(r.host, 'file-host');
  assert.equal(r.user, 'file-user');
  assert.equal(r.sshPort, 4444);
  assert.equal(r.servicePort, 5555);
  assert.equal(r.provider, 'pp');
  assert.equal(r.cli, 'cc');
});

test('端口为字符串时按数字解析', () => {
  const r = resolveVmConn({ argv: {}, env: {}, dotEnv: {}, persisted: { sshPort: '22022', servicePort: '18443' } });
  assert.equal(r.sshPort, 22022);
  assert.equal(r.servicePort, 18443);
  assert.equal(typeof r.sshPort, 'number');
});

test('部分字段缺省仍回落默认值', () => {
  const r = resolveVmConn({ argv: {}, env: {}, dotEnv: {}, persisted: { host: 'only-host' } });
  assert.equal(r.host, 'only-host');
  assert.equal(r.user, '');
  assert.equal(r.sshPort, 22);
  assert.equal(r.servicePort, 18443);
});

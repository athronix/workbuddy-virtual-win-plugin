/**
 * 双端一键脚本（delivery/setup.mjs）单元测试
 * 聚焦纯函数：.env 解析、配置解析、计划生成（不触发真实 ssh/build）。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnv, resolveConfig, buildPlan } from '../../delivery/setup.mjs';

const SAMPLE = `
# 注释行应被忽略
WINVM_SERVICE_PORT=18443

HOST_DEPLOY=1
HOST_INSTALL_USER="vmadmin"   # 行内注释不影响值
VM_HOST=192.168.1.50
VM_DEPLOY=1
WINVM_VM_PROVIDER=workbuddy
WINVM_SETUP_TUNNEL=1
WINVM_DRY_RUN=1
`;

describe('parseEnv', () => {
  test('忽略空行/注释，解析键值与引号', () => {
    const e = parseEnv(SAMPLE);
    assert.equal(e.WINVM_SERVICE_PORT, '18443');
    assert.equal(e.HOST_DEPLOY, '1');
    assert.equal(e.HOST_INSTALL_USER, 'vmadmin'); // 引号被剥离，行内注释被忽略
    assert.equal(e.VM_HOST, '192.168.1.50');
    assert.equal(e.WINVM_VM_PROVIDER, 'workbuddy');
  });
});

describe('resolveConfig', () => {
  test('dry-run 默认开；VM provider 取自 env', () => {
    const cfg = resolveConfig(parseEnv(SAMPLE), {});
    assert.equal(cfg.dryRun, true);
    assert.equal(cfg.vmProvider, 'workbuddy');
    assert.equal(cfg.vmHost, '192.168.1.50');
    assert.equal(cfg.setupTunnel, true);
  });

  test('--apply 覆盖为真实执行', () => {
    const cfg = resolveConfig(parseEnv(SAMPLE), { apply: true });
    assert.equal(cfg.dryRun, false);
  });

  test('缺省回落到确定性 provider 与默认端口', () => {
    const cfg = resolveConfig({}, {});
    assert.equal(cfg.vmProvider, 'workbuddy-deterministic');
    assert.equal(cfg.servicePort, 18443);
    assert.equal(cfg.vmDeploy, false);
  });
});

describe('buildPlan', () => {
  test('完整 env 生成 BUILD/HOST/VM/TUNNEL/TEST 五阶段', () => {
    const cfg = resolveConfig(parseEnv(SAMPLE), {});
    const plan = buildPlan(cfg);
    const phases = plan.map((p) => p.phase);
    assert.deepEqual(phases, ['BUILD', 'HOST', 'VM', 'TUNNEL', 'TEST']);
  });

  test('VM_HOST 为空时 VM 阶段转为手动部署指引（apply=false）', () => {
    const cfg = resolveConfig({ VM_DEPLOY: '1', WINVM_DRY_RUN: '1' }, {});
    const plan = buildPlan(cfg);
    const vm = plan.find((p) => p.phase === 'VM');
    assert.ok(vm);
    assert.equal(vm.apply, false);
  });

  test('dry-run 下所有步骤 apply=false；--apply 下 HOST/VM/TUNNEL apply=true', () => {
    const dry = buildPlan(resolveConfig(parseEnv(SAMPLE), {}));
    assert.ok(dry.every((p) => p.apply === false));
    const apply = buildPlan(resolveConfig(parseEnv(SAMPLE), { apply: true }));
    const host = apply.find((p) => p.phase === 'HOST');
    const tunnel = apply.find((p) => p.phase === 'TUNNEL');
    assert.equal(host.apply, true);
    assert.equal(tunnel.apply, true);
  });
});

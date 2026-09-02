/**
 * 双端一键脚本（delivery/setup.mjs）单元测试
 * 聚焦纯函数：.env 解析、配置解析、计划生成（不触发真实 ssh/build）。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseEnv,
  resolveConfig,
  buildPlan,
  distPaths,
  manifestPaths,
  packagePayloadPaths,
} from '../../delivery/setup.mjs';

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

describe('VM 分发产物清单（防回归）', () => {
  test('凡有 dist 的包，清单必同时含其 package.json', async () => {
    const dists = await distPaths();
    const manifests = await manifestPaths();
    assert.ok(dists.length > 0, '仓库应已构建（存在 packages/*/dist）');
    for (const d of dists) {
      const name = d.split('/')[1];
      assert.ok(
        manifests.includes(`packages/${name}/package.json`),
        `包 ${name} 有 dist 但分发清单缺少其 package.json —— `
          + '远端建好 @winvm 软链后仍会因缺 main 字段而解析不到入口',
      );
    }
  });

  test('含 vm-capabilities/psmod（54 个能力的 PowerShell 实现）', async () => {
    const payload = await packagePayloadPaths();
    assert.ok(
      payload.includes('packages/vm-capabilities/psmod'),
      '缺少 packages/vm-capabilities/psmod —— 远端服务能启动、自检能过半，'
        + '但 54 个能力一个都执行不了（找不到 ps-bridge.ps1）',
    );
  });

  test('排除源码与构建中间产物（src / node_modules / tsconfig / tsbuildinfo）', async () => {
    const payload = await packagePayloadPaths();
    const junk = payload.filter(
      (p) => /(^|\/)(src|node_modules|\.generated)$/.test(p)
        || p.endsWith('tsconfig.json')
        || p.endsWith('tsconfig.tsbuildinfo'),
    );
    assert.deepEqual(junk, [], `产物中混入了源码/构建中间产物：${junk.join(', ')}`);
  });

  test('contracts/schemas 随行（运行期契约校验需要）', async () => {
    const payload = await packagePayloadPaths();
    assert.ok(payload.includes('packages/contracts/schemas'), '缺少 packages/contracts/schemas');
  });
});

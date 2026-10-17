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
  evaluateTunnelReuse,
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

/** 关掉 dry-run 兜底（WINVM_DRY_RUN=0），用于验证 --apply 的真实执行路径 */
const APPLY_ENV = { ...parseEnv(SAMPLE), WINVM_DRY_RUN: '0' };

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

  test('不传 --apply 永远 dry-run（WINVM_DRY_RUN=0 也不例外）—— footgun 防回归', () => {
    // 旧实现：WINVM_DRY_RUN=0 时不传 --apply 也会真执行，
    // 与「不加 --apply 即 dry-run」的文档承诺矛盾，直接跑脚本就会误伤真机。
    assert.equal(resolveConfig(parseEnv(SAMPLE), {}).dryRun, true);
    assert.equal(resolveConfig(APPLY_ENV, {}).dryRun, true);
  });

  test('--apply 且未强制 dry-run 时真实执行', () => {
    assert.equal(resolveConfig(APPLY_ENV, { apply: true }).dryRun, false);
  });

  test('WINVM_DRY_RUN=1 兜底：即便 --apply 也强制 dry-run', () => {
    assert.equal(resolveConfig(parseEnv(SAMPLE), { apply: true }).dryRun, true);
  });

  test('缺省回落到确定性 provider 与默认端口', () => {
    const cfg = resolveConfig({}, {});
    assert.equal(cfg.vmProvider, 'workbuddy-deterministic');
    assert.equal(cfg.servicePort, 18443);
    assert.equal(cfg.vmDeploy, false);
  });
});

describe('buildPlan', () => {
  test('完整 env 生成 BUILD/HOST/VM/VM-START/TUNNEL/TEST/QA-PROBE/HEALTH 八阶段', () => {
    const cfg = resolveConfig(parseEnv(SAMPLE), {});
    const plan = buildPlan(cfg);
    const phases = plan.map((p) => p.phase);
    // QA-PROBE 顺序契约：TEST→QA-PROBE→HEALTH。仅 scp 推夹具、不依赖隧道，置于 HEALTH
    // 之前使 HEALTH 保持部署最终闸门；探针缺失仅 WARN（QA 夹具非运行时依赖）。
    assert.deepEqual(phases, ['BUILD', 'HOST', 'VM', 'VM-START', 'TUNNEL', 'TEST', 'QA-PROBE', 'HEALTH']);
  });

  test('QA-PROBE 紧随 TEST、先于 HEALTH（部署最终闸门不被夹具问题遮蔽）', () => {
    const phases = buildPlan(resolveConfig(parseEnv(SAMPLE), {})).map((p) => p.phase);
    assert.ok(phases.indexOf('QA-PROBE') === phases.indexOf('TEST') + 1, 'QA-PROBE 应紧随 TEST');
    assert.ok(phases.indexOf('QA-PROBE') < phases.indexOf('HEALTH'), 'QA-PROBE 应先于 HEALTH');
  });

  test('各阶段仅出现一次（回归防护：VM-START / HEALTH 曾各被执行两次）', () => {
    const cfg = resolveConfig(parseEnv(SAMPLE), {});
    const phases = buildPlan(cfg).map((p) => p.phase);
    for (const phase of ['BUILD', 'HOST', 'VM', 'VM-START', 'TUNNEL', 'TEST', 'QA-PROBE', 'HEALTH']) {
      assert.equal(phases.filter((p) => p === phase).length, 1, `${phase} 应只出现一次（防重复执行回归）`);
    }
  });

  // REL-V1.4.0：发布包 dist 已指纹在册且包内无 src/tsconfig/tsc ⇒ --skip-build 省略 BUILD 相位
  test('skipBuild 时省略 BUILD，其余七相位顺序不变（发布包场景）', () => {
    const cfg = resolveConfig(parseEnv(SAMPLE), { skipBuild: true });
    const phases = buildPlan(cfg).map((p) => p.phase);
    assert.deepEqual(phases, ['HOST', 'VM', 'VM-START', 'TUNNEL', 'TEST', 'QA-PROBE', 'HEALTH']);
    assert.ok(!phases.includes('BUILD'), 'skipBuild 时不应出现 BUILD 相位');
  });

  test('WINVM_SKIP_BUILD=1 经 env 等效 skipBuild（声明式持久口径）', () => {
    const cfg = resolveConfig(parseEnv(`${SAMPLE}\nWINVM_SKIP_BUILD=1`), {});
    assert.equal(cfg.skipBuild, true);
    assert.ok(!buildPlan(cfg).some((p) => p.phase === 'BUILD'));
  });

  test('防呆：缺省与显式 false 均保留 BUILD（仓库态行为零变化）', () => {
    assert.equal(resolveConfig(parseEnv(SAMPLE), {}).skipBuild, false);
    assert.equal(resolveConfig(parseEnv(SAMPLE), { skipBuild: false }).skipBuild, false);
    assert.ok(buildPlan(resolveConfig(parseEnv(SAMPLE), {})).some((p) => p.phase === 'BUILD'));
  });

  test('VM_HOST 为空时 VM 阶段转为手动部署指引（apply=false）', () => {
    const cfg = resolveConfig({ VM_DEPLOY: '1', WINVM_DRY_RUN: '1' }, {});
    const plan = buildPlan(cfg);
    const vm = plan.find((p) => p.phase === 'VM');
    assert.ok(vm);
    assert.equal(vm.apply, false);
  });

  test('dry-run 下所有步骤 apply=false；--apply 下 HOST/VM/TUNNEL/HEALTH apply=true', () => {
    const dry = buildPlan(resolveConfig(parseEnv(SAMPLE), {}));
    assert.ok(dry.every((p) => p.apply === false));
    const apply = buildPlan(resolveConfig(APPLY_ENV, { apply: true }));
    for (const phase of ['HOST', 'VM', 'VM-START', 'TUNNEL', 'HEALTH']) {
      const step = apply.find((p) => p.phase === phase);
      assert.ok(step, `缺少 ${phase} 阶段`);
      assert.equal(step.apply, true, `${phase} 在 --apply 下应为真执行`);
    }
  });

  test('未开隧道时不生成 TUNNEL/HEALTH（无隧道则 /health 不可达），但 QA-PROBE 仍存在（仅 scp、不依赖隧道）', () => {
    const cfg = resolveConfig({ ...APPLY_ENV, WINVM_SETUP_TUNNEL: '0' }, { apply: true });
    const phases = buildPlan(cfg).map((p) => p.phase);
    assert.ok(!phases.includes('TUNNEL'));
    assert.ok(!phases.includes('HEALTH'));
    assert.ok(phases.includes('QA-PROBE'), 'QA-PROBE 只依赖 VM 可达（VM_HOST），不依赖隧道');
  });

  test('VM_HOST 为空时不生成 QA-PROBE（无目标机无从推送）', () => {
    const cfg = resolveConfig({ ...APPLY_ENV, VM_HOST: '' }, { apply: true });
    const phases = buildPlan(cfg).map((p) => p.phase);
    assert.ok(!phases.includes('QA-PROBE'));
  });

  // OBS-1（REL-V1.4.0 迭代2）：TUNNEL 相位复用判据——daemon 自报态仅作信息，
  // 后端 /health 打通为唯一硬判据（run1 观察项：daemon healthy 但 VM 服务死 = 隧道黑洞）。
  test('evaluateTunnelReuse：后端打通即可复用（不论 daemon 自报态）', () => {
    assert.equal(evaluateTunnelReuse(true, true).reusable, true);
    assert.equal(evaluateTunnelReuse(false, true).reusable, true);
    assert.equal(evaluateTunnelReuse(true, true).blackhole, false);
  });

  test('evaluateTunnelReuse：daemon 自报 healthy 但后端未通 = 黑洞，不得复用（run1 回归）', () => {
    const v = evaluateTunnelReuse(true, false);
    assert.equal(v.reusable, false);
    assert.equal(v.blackhole, true);
    assert.match(v.note, /隧道黑洞/);
  });

  test('evaluateTunnelReuse：daemon 未报健康且后端未通 → 不可复用但非黑洞', () => {
    const v = evaluateTunnelReuse(false, false);
    assert.equal(v.reusable, false);
    assert.equal(v.blackhole, false);
  });

  test('QA-PROBE 夹具清单为 qa-probe.ps1 + lead-md5-3.ps1（qa-verify.mjs vmps() 引用全集）', async () => {
    const { QA_PROBE_FILES } = await import('../../delivery/setup.mjs');
    assert.ok(QA_PROBE_FILES.includes('qa-probe.ps1'), 'A1/A3 依赖 qa-probe.ps1');
    assert.ok(QA_PROBE_FILES.includes('lead-md5-3.ps1'), 'A11 依赖 lead-md5-3.ps1');
    assert.equal(QA_PROBE_FILES.length, 2, '新增 VM 侧引用时须同步 QA_PROBE_FILES 与本断言');
  });

  test('TEST 命令不含分号、HEALTH 独立成阶段（防回归：分号曾让 curl 永不执行）', () => {
    const plan = buildPlan(resolveConfig(APPLY_ENV, { apply: true }));
    const testStep = plan.find((p) => p.phase === 'TEST');
    const health = plan.find((p) => p.phase === 'HEALTH');
    // 执行器用 split(' ') 还原参数：命令里一旦出现 `;`，它会被当成 node 的参数而非分隔符
    assert.ok(testStep, '缺少 TEST 阶段');
    assert.ok(!testStep.command.includes(';'), `TEST 命令含分号，curl 会被吞掉：${testStep.command}`);
    assert.ok(health, '缺少 HEALTH 阶段');
    assert.ok(health.command.startsWith('curl'), 'HEALTH 应为独立的 curl 命令');
    assert.ok(
      health.command.includes('--noproxy'),
      'HEALTH 需绕开本机代理，否则回环流量会被 TUN 模式代理拦截',
    );
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

#!/usr/bin/env node
/**
 * WinVM Bridge —— VM 侧一键部署子脚本（于**鸿蒙宿主端**运行，经 SSH 推送部署到 Windows VM）
 *
 * 这是双端一键部署的「VM 侧子脚本」：仅负责 VM 侧（scp 产物 → ssh install-vm.mjs →
 * 重启服务 → 轮询端口 → 分发 QA 探针）。宿主侧子脚本为 `install-host.mjs`；
 * 总一键脚本 `setup.mjs` 会分别为两侧调用子脚本并最终联合验证。
 *
 * 用法（与 setup.mjs 同源，安全默认一致：无 --apply 即 dry-run）：
 *   node delivery/deploy-vm.mjs                # dry-run：仅打印 VM 侧部署计划
 *   node delivery/deploy-vm.mjs --apply        # 真执行 VM 侧部署（需 .env 配置 VM_HOST/VM_USER 等）
 *   node delivery/deploy-vm.mjs --apply --env=.env.prod
 *   node delivery/deploy-vm.mjs --uninstall [--apply]   # 卸载 VM 侧（预览/执行）
 *
 * 依赖：复用 setup.mjs 的 VM 分发与启动逻辑（deployVm / runRemotePs1 / buildVmStartPs1 /
 *   deployQaProbes / waitForRemotePort），保证与总脚本行为完全一致。
 */

import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

import {
  loadEnvFile,
  resolveConfig,
  deployVm,
  deployVmUninstall,
  runRemotePs1,
  buildVmStartPs1,
  deployQaProbes,
  waitForRemotePort,
} from './setup.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

function log(msg) {
  process.stdout.write(msg + '\n');
}

/** 本地命令执行（BUILD 等）；windows 上 npm 为 .cmd，交给 shell 解析。 */
function run(cmd, args, opts = {}) {
  return new Promise((resolveResult) => {
    const timeoutMs = opts.timeoutMs ?? 180_000;
    const isCmdShim = process.platform === 'win32' && /^(npm|npx|yarn|pnpm)$/.test(cmd);
    const t = setTimeout(() => {
      try { child?.kill('SIGTERM'); } catch { /* noop */ }
      resolveResult({ ok: false, code: -1, out: 'TIMEOUT' });
    }, timeoutMs);
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd ?? ROOT,
        windowsHide: true,
        env: process.env,
        ...(isCmdShim ? { shell: true } : {}),
      });
    } catch (e) {
      clearTimeout(t);
      resolveResult({ ok: false, code: -1, out: String(e) });
      return;
    }
    let out = '';
    child.stdout?.on('data', (d) => (out += d.toString('utf8')));
    child.stderr?.on('data', (d) => (out += d.toString('utf8')));
    child.on('error', (e) => { clearTimeout(t); resolveResult({ ok: false, code: -1, out: e.message }); });
    child.on('close', (code) => { clearTimeout(t); resolveResult({ ok: code === 0, code: code ?? -1, out }); });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const isUninstall = args.includes('--uninstall');
  const envPath = args.find((a) => a.startsWith('--env='))?.slice('--env='.length) ?? '';
  const target = envPath || resolve(ROOT, '.env');

  let env;
  if (existsSync(target)) {
    env = loadEnvFile(target);
    log(`读取配置：${target}`);
  } else {
    const fallback = resolve(ROOT, '.env.example');
    if (!existsSync(fallback)) {
      log('错误：未找到 .env 或 .env.example');
      process.exitCode = 1;
      return;
    }
    env = loadEnvFile(fallback);
    log(`未找到 .env，使用模板 ${fallback}（请复制为 .env 后填写）`);
  }

  const cfg = resolveConfig(env, { apply });

  log('');
  log('══════════════════════════════════════════════════════════════');
  log(` WinVM Bridge · VM 侧一键部署（于鸿蒙宿主端运行，SSH 推送至 VM）  [${cfg.dryRun ? 'DRY-RUN 只规划' : 'APPLY 真执行'}]`);
  log(` VM provider 选型：${cfg.vmProvider}`);
  log('══════════════════════════════════════════════════════════════');
  log(' 将执行：BUILD → VM（scp→ssh install-vm.mjs）→ VM-START（重启服务）→ QA-PROBE（探针）→ 端口轮询验证');
  log('');

  if (cfg.dryRun) {
    log('DRY-RUN 完成：未对 VM 做任何改动。确认配置无误后加 --apply 真执行。');
    return;
  }

  if (isUninstall) {
    const r = await deployVmUninstall(cfg);
    if (!r.ok) {
      log(`❌ VM 卸载失败（${r.out.slice(0, 400)}）：可在 VM 内手动 node delivery/install-vm.mjs --uninstall --yes`);
      process.exitCode = 1;
    } else {
      log('✅ VM 卸载完成（任务移除 + 软链/共享 Skills/生成目录移入回收站，源码与 dist 保留）');
    }
    return;
  }

  // 1) BUILD（产出 dist 与运行时资产，VM 分发依赖）
  log('[BUILD] 构建全部包...');
  const b = await run('npm', ['run', 'build'], { timeoutMs: 300_000 });
  if (!b.ok) { log(`❌ 构建失败（exit ${b.code}）：${b.out.slice(0, 400)}`); process.exitCode = 1; return; }
  log('[BUILD] ✅ 完成');

  // 2) VM 分发 + 安装
  log('[VM] 推送产物并安装到 VM...');
  const r = await deployVm(cfg);
  if (!r.ok) { log(`❌ VM 部署失败（输出尾部）：\n${r.out.slice(-2000)}`); process.exitCode = 1; return; }
  log('[VM] ✅ 完成（产物 + skills 已分发，已注册自启并自检）');

  // 3) VM-START：重启服务并轮询端口
  log('[VM-START] 重启 VM 服务并轮询端口监听...');
  let ps = await runRemotePs1(cfg, buildVmStartPs1(cfg), { timeoutMs: 120_000, log });
  if (!ps.ok || !ps.out.includes('VM_START_TRIGGERED')) {
    log('  ⚠️ VM-START 首次未确认，5s 后重试 1 次...');
    await new Promise((r) => setTimeout(r, 5000));
    ps = await runRemotePs1(cfg, buildVmStartPs1(cfg), { timeoutMs: 120_000, log });
  }
  if (!ps.ok || !ps.out.includes('VM_START_TRIGGERED')) {
    log(`❌ VM 服务启动触发失败（${ps.out.slice(0, 300)}）：可在 VM 内手动 schtasks /run /tn ${'WinVMBridge.Service'}`);
    process.exitCode = 1;
    return;
  }
  const up = await waitForRemotePort(cfg, 420_000);
  if (up) log(`[VM-START] ✅ VM 服务已监听 127.0.0.1:${cfg.servicePort}`);
  else { log(`❌ 420s 内未监听到端口。可手动在 VM 内 schtasks /run /tn ${'WinVMBridge.Service'} 后重跑本脚本。`); process.exitCode = 1; return; }

  // 4) QA-PROBE：分发探针夹具（缺失/失败不阻断）
  log('[QA-PROBE] 分发 QA 探针夹具...');
  const qa = await deployQaProbes(cfg, log);
  if (qa.pushed.length === 0 && qa.missing.length > 0) {
    log(`  ⚠️ 未找到任何 QA 探针夹具（${qa.missing.join(', ')} 不在 qa/probes/），跳过（不阻断）。`);
  } else if (!qa.ok) {
    log(`  ⚠️ QA 探针推送部分失败（不阻断）：\n${qa.out}`);
  } else {
    log(`[QA-PROBE] ✅ 已推送 ${qa.pushed.length} 个探针 → ${cfg.vmDeployDir}`);
  }

  log('');
  log('VM 侧一键部署完成 ✅（服务已监听、开机+登录自启已注册）。');
  log('下一步：在鸿蒙宿主端运行 install-host.mjs（或 setup.mjs --only-host）完成宿主侧，或用 setup.mjs 联合验证。');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => {
    process.stderr.write(`deploy-vm.mjs 异常：${e?.stack ?? e}\n`);
    process.exitCode = 1;
  });
}

export { main };

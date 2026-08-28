/**
 * WinVM Bridge —— 双端一键部署脚本（宿主机侧 + VM 侧）
 *
 * 读取项目根 .env（不存在则回退 .env.example），按配置完成：
 *   BUILD → HOST（install-host.mjs）→ VM（scp + install-vm.mjs）→ TUNNEL（ssh -L）→ TEST（自检）
 *
 * 安全默认：不加 --apply 即 --dry-run，只打印计划、不改动任何系统。
 * 所有副作用（构建/安装/ssh）均在 --apply 下发生，且单步失败不影响其它步骤（仅汇总报错）。
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

/* ----------------------------- 配置解析 ----------------------------- */

/**
 * 极简 .env 解析：
 *  - 忽略空行与整行 # 注释
 *  - 支持引号包裹的值（配对引号内的内容即值，引号后的行内注释被忽略）
 *  - 未引号的值会去掉「空白 + #」起始的行内注释（如 `KEY=val  # 注释`）
 */
export function parseEnv(content) {
  const out = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (val.length >= 2 && (val[0] === '"' || val[0] === "'")) {
      const q = val[0];
      const close = val.lastIndexOf(q);
      // 取配对引号内的内容；引号后的行内注释一并忽略
      val = close > 0 ? val.slice(1, close) : val.slice(1);
    } else {
      // 未引号：去掉从「空白 + #」起的行内注释
      val = val.replace(/\s+#.*$/, '');
    }
    out[key] = val;
  }
  return out;
}

export function loadEnvFile(path) {
  if (!existsSync(path)) throw new Error(`配置文件不存在：${path}`);
  return parseEnv(readFileSync(path, 'utf8'));
}

/** 将 .env 映射为强类型配置；opts.apply 表示本次是否真执行 */
export function resolveConfig(env, opts = {}) {
  const num = (k, d) => {
    const v = env[k];
    if (v === undefined || v === '') return d;
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  const bool = (k) => env[k] === '1' || String(env[k]).toLowerCase() === 'true';
  const dryRun = opts.apply ? false : env['WINVM_DRY_RUN'] ? env['WINVM_DRY_RUN'] !== '0' : true;
  return {
    dryRun,
    servicePort: num('WINVM_SERVICE_PORT', 18443),
    hostDeploy: bool('HOST_DEPLOY'),
    hostHome: env['HOST_WORKBUDDY_HOME'] || '',
    hostUser: env['HOST_INSTALL_USER'] || '',
    vmDeploy: bool('VM_DEPLOY'),
    vmHost: env['VM_HOST'] || '',
    vmSshPort: num('VM_SSH_PORT', 22),
    vmUser: env['VM_USER'] || '',
    vmDeployDir: env['VM_DEPLOY_DIR'] || 'C:/WinVMBridge',
    vmProvider: env['WINVM_VM_PROVIDER'] || 'workbuddy-deterministic',
    workbuddyCli: env['WINVM_WORKBUDDY_CLI'] || 'codebuddy',
    setupTunnel: bool('WINVM_SETUP_TUNNEL'),
    tunnelLocalPort: num('WINVM_TUNNEL_LOCAL_PORT', 18443),
    tunnelRemotePort: num('WINVM_TUNNEL_REMOTE_PORT', 18443),
  };
}

/** 生成四阶段执行计划（纯函数，便于单测） */
export function buildPlan(cfg) {
  const steps = [];
  const mode = cfg.dryRun ? 'dry-run（只规划）' : 'apply（真执行）';
  steps.push({
    phase: 'BUILD',
    description: `构建全部包（npm run build）[${mode}]`,
    command: 'npm run build',
    apply: !cfg.dryRun,
  });
  if (cfg.hostDeploy) {
    const args = ['node', 'delivery/install-host.mjs'];
    if (cfg.dryRun) args.push('--dry-run');
    if (cfg.hostHome) args.push('--home', cfg.hostHome);
    if (cfg.hostUser) args.push('--user', cfg.hostUser);
    steps.push({ phase: 'HOST', description: '部署宿主机侧 WorkBuddy 插件', command: args.join(' '), apply: !cfg.dryRun });
  }
  if (cfg.vmDeploy) {
    if (cfg.vmHost) {
      steps.push({
        phase: 'VM',
        description: `部署 VM 侧（scp 产物 → ssh ${cfg.vmUser}@${cfg.vmHost} 运行 install-vm.mjs，provider=${cfg.vmProvider}）[${mode}]`,
        command: `scp -P ${cfg.vmSshPort} -r delivery packages/*/dist package.json ${cfg.vmUser}@${cfg.vmHost}:${cfg.vmDeployDir} && ssh ${cfg.vmUser}@${cfg.vmHost} "cd ${cfg.vmDeployDir} && npm ci --omit=dev && node delivery/install-vm.mjs --provider ${cfg.vmProvider} --cli ${cfg.workbuddyCli}"`,
        apply: !cfg.dryRun,
      });
    } else {
      steps.push({
        phase: 'VM',
        description: 'VM_HOST 未配置 → 打印本地手动部署指引（不自动 ssh）',
        command: `node delivery/install-vm.mjs --dry-run --provider ${cfg.vmProvider} --cli ${cfg.workbuddyCli}`,
        apply: false,
      });
    }
  }
  if (cfg.setupTunnel && cfg.vmHost) {
    steps.push({
      phase: 'TUNNEL',
      description: `建立 SSH 本地转发 ${cfg.tunnelLocalPort}:127.0.0.1:${cfg.tunnelRemotePort} [${mode}]`,
      command: `ssh -N -L ${cfg.tunnelLocalPort}:127.0.0.1:${cfg.tunnelRemotePort} -p ${cfg.vmSshPort} ${cfg.vmUser}@${cfg.vmHost}`,
      apply: !cfg.dryRun,
    });
  }
  steps.push({
    phase: 'TEST',
    description: '端到端自检（host dry-run + vm self-test + 经隧道 /health）',
    command: `node packages/vm-service/dist/cli.js --self-test ; curl -s http://127.0.0.1:${cfg.tunnelLocalPort}/health`,
    apply: !cfg.dryRun,
  });
  return steps;
}

/* ----------------------------- 执行辅助 ----------------------------- */

function run(cmd, args, opts = {}) {
  return new Promise((resolveResult) => {
    const timeoutMs = opts.timeoutMs ?? 120_000;
    let child;
    const t = setTimeout(() => {
      try {
        child?.kill('SIGTERM');
      } catch {
        /* noop */
      }
      resolveResult({ ok: false, code: -1, out: 'TIMEOUT' });
    }, timeoutMs);
    try {
      child = spawn(cmd, args, { cwd: opts.cwd ?? ROOT, windowsHide: true, env: process.env });
    } catch (e) {
      clearTimeout(t);
      resolveResult({ ok: false, code: -1, out: String(e) });
      return;
    }
    let out = '';
    child.stdout?.on('data', (d) => (out += d.toString('utf8')));
    child.stderr?.on('data', (d) => (out += d.toString('utf8')));
    child.on('error', (e) => {
      clearTimeout(t);
      resolveResult({ ok: false, code: -1, out: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(t);
      resolveResult({ ok: code === 0, code: code ?? -1, out });
    });
  });
}

async function reachable(cfg) {
  if (!cfg.vmHost) return false;
  const r = await run('ssh', [
    '-p', String(cfg.vmSshPort),
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=8`,
    `${cfg.vmUser}@${cfg.vmHost}`,
    'echo ok',
  ], { timeoutMs: 15_000 });
  return r.ok;
}

function log(msg) {
  process.stdout.write(msg + '\n');
}

/* ----------------------------- 主流程 ----------------------------- */

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
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
  const plan = buildPlan(cfg);

  log('');
  log('══════════════════════════════════════════════════════════════');
  log(` WinVM Bridge 双端一键部署  [${cfg.dryRun ? 'DRY-RUN 只规划' : 'APPLY 真执行'}]`);
  log(` VM provider 选型：${cfg.vmProvider}`);
  log('══════════════════════════════════════════════════════════════');
  for (const s of plan) {
    log(`\n[${s.phase}] ${s.description}`);
    log(`   $ ${s.command}`);
  }
  log('');

  if (cfg.dryRun) {
    log('DRY-RUN 完成：未对任何系统做改动。需要真正执行时加 --apply。');
    return;
  }

  // APPLY：逐步执行
  let failed = 0;
  for (const s of plan) {
    if (!s.apply) {
      log(`\n[${s.phase}] 跳过（无需执行）：${s.description}`);
      continue;
    }
    log(`\n[${s.phase}] 执行：${s.description}`);
    if (s.phase === 'TUNNEL') {
      // 隧道后台常驻，不阻塞
      try {
        const child = spawn('ssh', [
          '-N', '-L', `${cfg.tunnelLocalPort}:127.0.0.1:${cfg.tunnelRemotePort}`,
          '-p', String(cfg.vmSshPort), `${cfg.vmUser}@${cfg.vmHost}`,
        ], { detached: true, stdio: 'ignore', windowsHide: true });
        child.unref();
        log(`   隧道已在后台启动（PID ${child.pid}）`);
      } catch (e) {
        log(`   隧道启动失败：${e.message}`);
        failed++;
      }
      continue;
    }
    if (s.phase === 'VM') {
      const reachableNow = await reachable(cfg);
      if (!reachableNow) {
        log(`   VM ${cfg.vmUser}@${cfg.vmHost} 不可达（SSH 探测失败）→ 跳过自动部署，请手动在 VM 内运行 install-vm.mjs`);
        failed++;
        continue;
      }
      const r = await run('ssh', [
        '-p', String(cfg.vmSshPort), `${cfg.vmUser}@${cfg.vmHost}`,
        `cd ${cfg.vmDeployDir} && npm ci --omit=dev && node delivery/install-vm.mjs --provider ${cfg.vmProvider} --cli ${cfg.workbuddyCli}`,
      ], { timeoutMs: 180_000 });
      if (!r.ok) {
        log(`   VM 部署失败：${r.out.slice(0, 400)}`);
        failed++;
      } else {
        log('   VM 部署完成');
      }
      continue;
    }
    // BUILD / HOST / TEST：本地直接运行
    const parts = s.command.split(' ');
    const r = await run(parts[0], parts.slice(1), { timeoutMs: 180_000 });
    if (!r.ok) {
      log(`   失败（exit ${r.code}）：${r.out.slice(0, 400)}`);
      failed++;
    } else {
      log('   完成');
    }
  }

  log('');
  if (failed > 0) {
    log(`部署完成但有 ${failed} 个步骤失败，请查看上方日志。`);
    process.exitCode = 1;
  } else {
    log('部署全部完成 ✅');
  }
}

// 仅当作为入口运行时执行 main（被测试 import 时不触发）
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => {
    process.stderr.write(`setup.mjs 异常：${e?.stack ?? e}\n`);
    process.exitCode = 1;
  });
}

export { main };

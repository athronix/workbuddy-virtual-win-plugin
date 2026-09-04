/**
 * WinVM Bridge —— 双端一键部署脚本（宿主机侧 + VM 侧）
 *
 * 读取项目根 .env（不存在则回退 .env.example），按配置完成：
 *   BUILD → HOST（install-host.mjs）→ VM（scp + install-vm.mjs）→ VM-START（schtasks /run 拉起服务，
 *         并轮询 VM 本机 18443 端口监听 ≤60s 才认为启动完成）
 *         → TUNNEL（ssh -L）→ TEST（宿主机自检）→ HEALTH（经隧道探测 /health，短重试 3 次，需 WINVM_SETUP_TUNNEL=1）
 *
 * 安全默认：
 *  - 不加 --apply 即 --dry-run，只打印计划、不改动任何系统；
 *  - WINVM_DRY_RUN=1 是兜底保险：即便传了 --apply 也强制保持 dry-run。
 *    （真执行的**唯一**入口是显式 --apply，配置里写 WINVM_DRY_RUN=0 不会自动触发执行。）
 * 所有副作用（构建/安装/ssh）均在 --apply 下发生，且单步失败不影响其它步骤（仅汇总报错）。
 *
 * 卸载（双端一键，安全：注册条目移除 + 目录/软链移入回收站）：
 *   node delivery/setup.mjs --uninstall            # 预览：打印宿主+VM 待移除项，不删除
 *   node delivery/setup.mjs --uninstall --apply    # 执行：宿主 install-host.mjs --uninstall --yes
 *                                                  #       + VM ssh install-vm.mjs --uninstall --yes
 * 仅移除本项目安装的部分，不动其它插件/连接器/技能；删除均入回收站（可恢复）。
 * 与安装共享同一套安全默认（无 --apply 即预览；WINVM_DRY_RUN=1 兜底）。
 */

import { readFileSync, existsSync, rmSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
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
  /**
   * dry-run 判定（安全红线）：
   *  - **真执行必须显式 --apply**：不传 --apply 时永远 dry-run，不改动任何系统。
   *  - WINVM_DRY_RUN=1 是兜底保险：即便传了 --apply 也强制保持 dry-run。
   *
   * 旧实现 `opts.apply ? false : (WINVM_DRY_RUN !== '0')` 有个 footgun：
   * WINVM_DRY_RUN=0 时**不传 --apply 也会真执行**，与「不加 --apply 即 dry-run」
   * 的文档承诺矛盾 —— 用户直接跑 `node delivery/setup.mjs` 就会误伤真机。
   */
  const dryRun = !opts.apply || bool('WINVM_DRY_RUN');
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
    hermesCli: env['WINVM_HERMES_CLI'] || 'hermes',
    setupTunnel: bool('WINVM_SETUP_TUNNEL'),
    tunnelLocalPort: num('WINVM_TUNNEL_LOCAL_PORT', 18443),
    tunnelRemotePort: num('WINVM_TUNNEL_REMOTE_PORT', 18443),
  };
}

/** 生成部署执行计划（纯函数，便于单测）*/
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
        command: `tar -czf ${VM_ARCHIVE} delivery skills packages/*/dist package.json && scp -P ${cfg.vmSshPort} ${VM_ARCHIVE} ${cfg.vmUser}@${cfg.vmHost}:${cfg.vmDeployDir} && ssh ${cfg.vmUser}@${cfg.vmHost} "${vmInstallCommand(cfg)}"`,
        apply: !cfg.dryRun,
      });
    } else {
      steps.push({
        phase: 'VM',
        description: 'VM_HOST 未配置 → 打印本地手动部署指引（不自动 ssh）',
        command: `node delivery/install-vm.mjs --dry-run --provider ${cfg.vmProvider} --cli ${resolveVmCli(cfg)}`,
        apply: false,
      });
    }
  }
  // VM-START：部署后默认拉起服务（计划任务"登录即启"，但刚部署完远端多半未重新登录，
  // 故显式 schtasks /run 触发，使后续 /health 能探通）
  if (cfg.vmDeploy && cfg.vmHost) {
    // 与执行阶段一致：先结束旧实例 + 强杀残留端口进程，再 schtasks /run
    // （避免 MultipleInstancesPolicy=IgnoreNew 拦截、端口被旧实例占用 EADDRINUSE）。
    // 预览命令同步反映该「干净重启」语义，确保所见的命令与真实执行一致（原则7 一致性）。
    const restartCmd =
      `schtasks /end /tn ${SERVICE_TASK_NAME}; Start-Sleep -Seconds 1; ` +
      `$p=(Get-NetTCPConnection -LocalPort ${cfg.servicePort} -ErrorAction SilentlyContinue).OwningProcess|Select-Object -Unique; ` +
      `if($p){Stop-Process -Id $p -Force -ErrorAction SilentlyContinue}; Start-Sleep -Seconds 1; ` +
      `schtasks /run /tn ${SERVICE_TASK_NAME}`;
    steps.push({
      phase: 'VM-START',
      description: `部署后拉起 VM 服务（先结束旧实例并强杀残留端口进程 → schtasks /run /tn ${SERVICE_TASK_NAME}，并轮询端口监听 ≤60s）[${mode}]`,
      command: `ssh -p ${cfg.vmSshPort} ${cfg.vmUser}@${cfg.vmHost} "powershell -NoProfile -Command \\"${restartCmd}\\""`,
      apply: !cfg.dryRun,
    });
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
    description: '宿主机侧自检（能力注册表 / ps-bridge / provider 能力目录）',
    command: 'node packages/vm-service/dist/cli.js --self-test',
    apply: !cfg.dryRun,
  });
  // HEALTH 独立于 TEST：早期把 self-test 与 curl 用 `;` 拼成一条命令，而执行器
  // 用 split(' ') 还原参数，`;` 会被当成 node 的命令行参数 —— curl 永远不执行，
  // /health 检查形同虚设。拆成独立阶段后，各自都是一条干净的单命令。
  if (cfg.setupTunnel && cfg.vmHost) {
    steps.push({
      phase: 'HEALTH',
      description: `经隧道探测 VM 服务 http://127.0.0.1:${cfg.tunnelLocalPort}/health`,
      // --noproxy：本机代理（如 TUN 模式）会拦截回环流量，必须显式绕开；
      // --max-time：服务未拉起时不要长时间挂住整个部署流程。
      command:
        `curl -s --noproxy 127.0.0.1 --max-time 15 ` +
        `http://127.0.0.1:${cfg.tunnelLocalPort}/health`,
      apply: !cfg.dryRun,
    });
  }
  return steps;
}

/* ----------------------------- VM 分发 ----------------------------- */

/** 传到 VM 的产物包名（打包保留 packages/<name>/dist 层级，避免同名 dist 互相覆盖） */
export const VM_ARCHIVE = 'winvm-dist.tgz';

/** VM 侧服务计划任务名（与 install-vm.mjs 默认一致；若自定义 --task-name 需同步修改） */
export const SERVICE_TASK_NAME = 'WinVMBridge.Service';

/**
 * 在 VM 的【交互式 PowerShell（RDP 桌面内）】执行的 GUI 启用命令。
 * 要点（确保「杀掉非交互式实例 → 在交互式会话拉起 GUI 可用实例」）：
 *  1) `schtasks /end` 让调度器把任务标记为已结束，后续 `schtasks /run` 才不会被
 *     任务 XML 的 `MultipleInstancesPolicy=IgnoreNew` 拦截（否则旧实例占着端口、新 run 被忽略）；
 *  2) 兜底 `Stop-Process` 强杀仍占用 18443 的进程，确保端口释放；
 *  3) 最后 `schtasks /run` 在「当前交互式会话」拉起新实例 → GUI 能力可用。
 * 该数组被 HEALTH 阶段（检测 session.interactive=false 时）与最终摘要复用。
 */
export const GUI_RESTART_COMMAND = [
  'schtasks /end /tn WinVMBridge.Service',
  'Start-Sleep -Seconds 2',
  '$p = (Get-NetTCPConnection -LocalPort 18443 -ErrorAction SilentlyContinue).OwningProcess | Select-Object -Unique',
  'if ($p) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }',
  'Start-Sleep -Seconds 1',
  'schtasks /run /tn WinVMBridge.Service',
];

/** packages/ 下的包目录名列表（目录不存在时返回空数组） */
async function packageNames() {
  const pkgRoot = join(ROOT, 'packages');
  try {
    return await readdir(pkgRoot);
  } catch {
    return [];
  }
}

/** 已构建包的 dist 相对路径列表 */
export async function distPaths() {
  const out = [];
  for (const n of await packageNames()) {
    if (existsSync(join(ROOT, 'packages', n, 'dist'))) out.push(`packages/${n}/dist`);
  }
  return out;
}

/**
 * 各包 package.json 相对路径列表 —— **必须随产物分发**。
 * dist 中 import 的是裸包名（from '@winvm/core'），远端靠
 * node_modules/@winvm/<pkg> 软链指向 packages/<pkg> 后，
 * ESM 仍需该目录 package.json 的 main 字段才能定位 dist/index.js；
 * 少了它，即便软链建好也解析不到入口。
 */
export async function manifestPaths() {
  const out = [];
  for (const n of await packageNames()) {
    if (existsSync(join(ROOT, 'packages', n, 'package.json'))) out.push(`packages/${n}/package.json`);
  }
  return out;
}

/**
 * 包内不随产物分发的条目（源码与构建中间产物，远端运行不需要）。
 * 注意这是**排除法**而非白名单枚举，见 packagePayloadPaths 说明。
 */
const PKG_EXCLUDE_ENTRIES = new Set([
  'src',
  'node_modules',
  'tsconfig.json',
  'tsconfig.tsbuildinfo',
  '.generated',
  '.DS_Store',
]);

/**
 * 待分发的 packages 条目相对路径清单（**排除法**：除上表外全量随行）。
 *
 * 光有 dist + package.json 是不够的，还有非 TypeScript 的运行时资产：
 *  - `packages/vm-capabilities/psmod/` —— 54 个能力的 PowerShell 实现
 *    （ps-bridge.ps1 与各能力域脚本）。缺了它，服务能起来、自检也能过半，
 *    但**一个能力都执行不了**；
 *  - `packages/contracts/schemas/`    —— 运行期契约校验用的 JSON Schema。
 *
 * 因此不做白名单枚举，而是排除源码与构建中间产物后全量随行，
 * 以免以后新增运行时资产时再次漏发。
 */
export async function packagePayloadPaths() {
  const out = [];
  for (const n of await packageNames()) {
    let entries = [];
    try {
      entries = await readdir(join(ROOT, 'packages', n), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (PKG_EXCLUDE_ENTRIES.has(e.name)) continue;
      out.push(`packages/${n}/${e.name}`);
    }
  }
  return out;
}

/** VM 侧 AI Agent CLI 运行时：随 provider 解析（与 install-vm.mjs 一致） */
export function resolveVmCli(cfg) {
  if (cfg.vmProvider === 'hermes-agent') return cfg.hermesCli;
  return cfg.workbuddyCli;
}

/** VM 侧安装命令（dist 已随包分发，故跳过依赖安装与构建） */
export function vmInstallCommand(cfg) {
  return (
    `cd ${cfg.vmDeployDir} && tar -xzf ${VM_ARCHIVE} && del /Q ${VM_ARCHIVE} && ` +
    `node delivery/install-vm.mjs --skip-install --skip-build ` +
    `--provider ${cfg.vmProvider} --cli ${resolveVmCli(cfg)}`
  );
}

/** VM 侧卸载命令（与安装对称；--yes 即真正移入回收站） */
export function vmUninstallCommand(cfg, { dryRun = false } = {}) {
  return (
    `cd ${cfg.vmDeployDir} && node delivery/install-vm.mjs --uninstall ` +
    `${dryRun ? '--dry-run' : '--yes'} --provider ${cfg.vmProvider} --cli ${resolveVmCli(cfg)}`
  );
}

/** 生成卸载执行计划（纯函数，便于单测） */
export function buildUninstallPlan(cfg) {
  const steps = [];
  const mode = cfg.dryRun ? 'dry-run（只规划）' : 'apply（真执行）';
  if (cfg.hostDeploy) {
    const args = ['node', 'delivery/install-host.mjs', '--uninstall'];
    if (cfg.dryRun) args.push('--dry-run');
    else args.push('--yes');
    if (cfg.hostHome) args.push('--home', cfg.hostHome);
    steps.push({
      phase: 'HOST-UNINSTALL',
      description: '卸载宿主机侧 WorkBuddy 插件（移除注册条目 + 项目目录移入回收站）',
      command: args.join(' '),
      apply: !cfg.dryRun,
    });
  }
  if (cfg.vmDeploy) {
    if (cfg.vmHost) {
      steps.push({
        phase: 'VM-UNINSTALL',
        description: `卸载 VM 侧服务（ssh ${cfg.vmUser}@${cfg.vmHost} 运行 install-vm.mjs --uninstall）[${mode}]`,
        command: `ssh -p ${cfg.vmSshPort} ${cfg.vmUser}@${cfg.vmHost} "${vmUninstallCommand(cfg, { dryRun: cfg.dryRun })}"`,
        apply: !cfg.dryRun,
      });
    } else {
      steps.push({
        phase: 'VM-UNINSTALL',
        description: 'VM_HOST 未配置 → 打印本地手动卸载指引（不自动 ssh）',
        command: `node delivery/install-vm.mjs --uninstall --dry-run --provider ${cfg.vmProvider} --cli ${resolveVmCli(cfg)}`,
        apply: false,
      });
    }
  }
  return steps;
}

/**
 * VM 侧分发：确保目录 → 打包（delivery + skills + 各包运行时资产）→ 传输 → 解压 → 安装
 * skills 一并下发，作为 VM 内 AI Agent 的技能规范与操作指引。
 *
 * 产物**不含 node_modules**（体积与平台相关性），远端安装走 --skip-install；
 * dist 中的裸包名 import（@winvm/*）改由 install-vm.mjs 建立 workspace junction 软链解析
 * （见 delivery/link-workspace.mjs）。
 * 各包运行时资产（dist / package.json / psmod / schemas…）由 packagePayloadPaths 排除法给出。
 */
export async function deployVm(cfg) {
  const sources = ['delivery', 'skills', ...(await packagePayloadPaths()), 'package.json'].filter(
    (p) => existsSync(join(ROOT, p)),
  );
  if (sources.length === 0) return { ok: false, code: -1, out: '没有任何可分发产物，请先执行 npm run build' };

  const mkdir = await run(
    'ssh',
    [
      '-p', String(cfg.vmSshPort), `${cfg.vmUser}@${cfg.vmHost}`,
      `powershell -NoProfile -Command "New-Item -ItemType Directory -Force -Path '${cfg.vmDeployDir}' | Out-Null"`,
    ],
    { timeoutMs: 60_000 },
  );
  if (!mkdir.ok) return { ok: false, code: mkdir.code, out: `创建 VM 部署目录失败：${mkdir.out.slice(0, 300)}` };

  const pack = await run('tar', ['-czf', VM_ARCHIVE, ...sources], { timeoutMs: 120_000 });
  if (!pack.ok) return { ok: false, code: pack.code, out: `打包产物失败：${pack.out.slice(0, 300)}` };

  const cp = await run(
    'scp',
    ['-P', String(cfg.vmSshPort), VM_ARCHIVE, `${cfg.vmUser}@${cfg.vmHost}:${cfg.vmDeployDir}`],
    { timeoutMs: 300_000 },
  );
  if (!cp.ok) return { ok: false, code: cp.code, out: `传输产物失败：${cp.out.slice(0, 300)}` };

  const r = await run(
    'ssh',
    ['-p', String(cfg.vmSshPort), `${cfg.vmUser}@${cfg.vmHost}`, vmInstallCommand(cfg)],
    { timeoutMs: 300_000 },
  );
  try {
    rmSync(join(ROOT, VM_ARCHIVE), { force: true });
  } catch {
    /* 清理失败不影响部署结果 */
  }
  return r;
}

/**
 * VM 侧卸载分发：仅经 ssh 在 VM 内运行 install-vm.mjs --uninstall（VM_HOST 已可达）。
 * 与 deployVm 对称，但卸载不需要打包/传输产物。
 */
export async function deployVmUninstall(cfg) {
  if (!cfg.vmHost) return { ok: false, code: -1, out: 'VM_HOST 未配置' };
  return run(
    'ssh',
    ['-p', String(cfg.vmSshPort), `${cfg.vmUser}@${cfg.vmHost}`, vmUninstallCommand(cfg, { dryRun: cfg.dryRun })],
    { timeoutMs: 300_000 },
  );
}

/* ----------------------------- 执行辅助 ----------------------------- */

function run(cmd, args, opts = {}) {
  return new Promise((resolveResult) => {
    const timeoutMs = opts.timeoutMs ?? 120_000;
    // Windows 上 npm/npx/yarn/pnpm 是 .cmd 批处理文件，spawn 不带 shell 时找不到
    // 可执行体（ENOENT）。交给 cmd.exe 解析（shell:true）即可。其余命令（node/ssh/
    // scp/tar/curl 等真实 .exe）保持无 shell，避免引号/特殊字符被本地 cmd 二次解析。
    const isCmdShim = process.platform === 'win32' && /^(npm|npx|yarn|pnpm)$/.test(cmd);
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
  // 注意：不得加 BatchMode=yes —— 该选项在部分环境（ssh-agent / 密钥）下会让探测偶发失败，
  // 而真正执行部署/隧道的 ssh 并不带它且稳定可用，导致「实测可达却被判不可达」而跳过 VM 步骤。
  // 改用 ConnectTimeout 快速失败 + 一次重试吸收瞬时抖动，与真实连接行为保持一致。
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await run('ssh', [
      '-p', String(cfg.vmSshPort),
      '-o', `ConnectTimeout=8`,
      `${cfg.vmUser}@${cfg.vmHost}`,
      'echo ok',
    ], { timeoutMs: 15_000 });
    if (r.ok) return true;
    if (attempt < 2) await sleep(1000);
  }
  return false;
}

/**
 * 轮询 VM 本机 127.0.0.1:<port> 是否已进入监听态（经 SSH 在 VM 内探测，
 * 不依赖本地 SSH 隧道，故可在 VM-START 阶段直接使用）。
 * 最长等待 timeoutMs；返回 true 表示端口已监听。
 * 注意：schtasks /run 受任务 XML 的 MultipleInstancesPolicy=IgnoreNew 约束，
 * 若已有实例在监听，schtasks /run 会立即变空操作，本函数随即返回 true。
 */
async function waitForRemotePort(cfg, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await run('ssh', [
      '-p', String(cfg.vmSshPort),
      '-o', `ConnectTimeout=8`,
      `${cfg.vmUser}@${cfg.vmHost}`,
      `powershell -NoProfile -Command "(Test-NetConnection -ComputerName 127.0.0.1 -Port ${cfg.servicePort} -InformationLevel Quiet)"`,
    ], { timeoutMs: 15_000 });
    if (r.ok && /true/i.test(r.out)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(1000);
  }
  return false;
}

function log(msg) {
  process.stdout.write(msg + '\n');
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

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
  const isUninstall = args.includes('--uninstall');
  const plan = isUninstall ? buildUninstallPlan(cfg) : buildPlan(cfg);

  log('');
  log('══════════════════════════════════════════════════════════════');
  log(` WinVM Bridge 双端一键${isUninstall ? '卸载' : '部署'}  [${cfg.dryRun ? 'DRY-RUN 只规划' : 'APPLY 真执行'}]`);
  log(` VM provider 选型：${cfg.vmProvider}`);
  log('══════════════════════════════════════════════════════════════');
  log(`【计划预览】以下为将执行的步骤（仅展示，尚未执行）：`);
  for (const s of plan) {
    log(`  ▸ [${s.phase}] ${s.description}`);
    log(`       $ ${s.command}`);
  }
  log('');

  if (cfg.dryRun) {
    log(`DRY-RUN 完成：未对任何系统做改动。${isUninstall ? '确认待移除项无误后，加 --apply 执行卸载（目录/软链入回收站，可恢复）。' : '需要真正执行时加 --apply。'}`);
    return;
  }

  // APPLY：逐步执行
  let failed = 0;
  let guiDegraded = false;
  for (const s of plan) {
    if (!s.apply) {
      log(`\n[${s.phase}] 跳过（无需执行）：${s.description}`);
      continue;
    }
    log(`\n[${s.phase}] 执行：${s.description}`);
    log(`   $ ${s.command}`);
    if (s.phase === 'TUNNEL') {
      // 隧道后台常驻，不阻塞
      try {
        const child = spawn('ssh', [
          '-N', '-L', `${cfg.tunnelLocalPort}:127.0.0.1:${cfg.tunnelRemotePort}`,
          '-p', String(cfg.vmSshPort), `${cfg.vmUser}@${cfg.vmHost}`,
        ], { detached: true, stdio: 'ignore', windowsHide: true });
        child.unref();
        log(`   ✅ 隧道已在后台启动（PID ${child.pid}）`);
      } catch (e) {
        log(`   ❌ 隧道启动失败：${e.message}`);
        failed++;
      }
      continue;
    }
    if (s.phase === 'VM-UNINSTALL') {
      const reachableNow = await reachable(cfg);
      if (!reachableNow) {
        log(`   VM ${cfg.vmUser}@${cfg.vmHost} 不可达（SSH 探测失败）→ 跳过自动卸载，请手动在 VM 内运行 install-vm.mjs --uninstall --yes`);
        failed++;
        continue;
      }
      const r = await deployVmUninstall(cfg);
      if (!r.ok) {
        log(`   ❌ VM 卸载失败：${r.out.slice(0, 400)}`);
        failed++;
      } else {
        log('   ✅ VM 卸载完成（任务移除 + 软链/共享 Skills/生成目录移入 VM 内可恢复目录 .uninstall-trash/<时间戳>/，非 Windows 回收站；源码与 dist 保留）');
      }
      continue;
    }
    if (s.phase === 'VM') {
      const reachableNow = await reachable(cfg);
      if (!reachableNow) {
        log(`   ⚠️ VM ${cfg.vmUser}@${cfg.vmHost} 不可达（SSH 探测失败）→ 跳过自动部署，请手动在 VM 内运行 install-vm.mjs`);
        failed++;
        continue;
      }
      const r = await deployVm(cfg);
      if (!r.ok) {
        log(`   ❌ VM 部署失败：${r.out.slice(0, 400)}`);
        failed++;
      } else {
        log('   ✅ VM 部署完成（产物 + skills 技能规范已分发，已注册自启并自检）');
      }
      continue;
    }
    if (s.phase === 'VM-START') {
      const reachableNow = await reachable(cfg);
      if (!reachableNow) {
        log(`   ⚠️ VM ${cfg.vmUser}@${cfg.vmHost} 不可达（SSH 探测失败）→ 跳过启动，请手动在 VM 内 schtasks /run /tn ${SERVICE_TASK_NAME}`);
        continue;
      }
      // 先结束旧实例并强杀残留端口进程（确保 Hidden=true 新实例能绑定、不弹旧窗口），再拉起
      const restartRemote =
        `schtasks /end /tn ${SERVICE_TASK_NAME}; Start-Sleep -Seconds 1; ` +
        `$p=(Get-NetTCPConnection -LocalPort ${cfg.servicePort} -ErrorAction SilentlyContinue).OwningProcess|Select-Object -Unique; ` +
        `if($p){Stop-Process -Id $p -Force -ErrorAction SilentlyContinue}; Start-Sleep -Seconds 1; ` +
        `schtasks /run /tn ${SERVICE_TASK_NAME}`;
      const r = await run('ssh', ['-p', String(cfg.vmSshPort), `${cfg.vmUser}@${cfg.vmHost}`, `powershell -NoProfile -Command "${restartRemote}"`], { timeoutMs: 60_000 });
      if (!r.ok) {
        log(`   ❌ VM 服务启动触发失败（${r.out.slice(0, 200)}）：可在 VM 内手动 schtasks /run /tn ${SERVICE_TASK_NAME}。部署继续，/health 将再次验证。`);
        continue;
      }
      log(`   VM 服务已触发重启（kill 残留 → schtasks /run /tn ${SERVICE_TASK_NAME}），等待端口监听（最长 60s）...`);
      const up = await waitForRemotePort(cfg, 60_000);
      if (up) {
        log(`   ✅ VM 服务已监听 127.0.0.1:${cfg.servicePort}（启动完成）`);
      } else {
        log(`   ⚠️ 60s 内未监听到端口。/health 阶段会再次验证；可手动在 VM 内 schtasks /run /tn ${SERVICE_TASK_NAME} 后重跑本步。`);
      }
      continue;
    }

    if (s.phase === 'HEALTH') {
      // VM-START 阶段已轮询端口监听，此处端口通常已通；再取一次 /health JSON 即可。
      // 仍保留短重试（2s × 3）以吸收「端口刚监听、HTTP 服务尚未完全就绪」的微小间隙。
      let ok = false;
      let lastOut = '';
      for (let attempt = 1; attempt <= 3; attempt++) {
        const hr = await run('curl', ['-s', '--noproxy', '127.0.0.1', '--max-time', '10', `http://127.0.0.1:${cfg.tunnelLocalPort}/health`], { timeoutMs: 15_000 });
        lastOut = hr.out;
        if (hr.ok) { ok = true; break; }
        if (attempt < 3) { log(`   /health 第 ${attempt} 次未通，2 秒后重试...`); await sleep(2000); }
      }
      if (ok) {
        log('   ✅ /health 通过');
        if (lastOut.trim()) log(`   ${lastOut.trim().slice(0, 600)}`);
        // 解析 session.interactive：非交互式会话 → GUI 能力不可用（仅门禁，不影响 MCP/A2A 与 54 能力）
        try {
          const h = JSON.parse(lastOut.trim());
          if (h?.session && h.session.interactive === false) {
            guiDegraded = true;
            log('');
            log('   ⚠️ 服务运行在【非交互式会话】（session.interactive=false）→ GUI 能力（截图/键鼠/UIA/窗口/剪贴板）不可用。');
            log('      MCP/A2A 双通道与全部 54 项能力正常（exposed=54）；仅 gui.* 被门禁。');
            log('      根因：经 SSH 远程 schtasks /run 不保证落在交互式（RDP）会话——它仅在「当前已有 RDP 交互式登录」时才落入该会话；');
            log('            否则服务会落到非交互会话（windowStation 非 WinSta0），GUI 被门禁。');
            log('      💡 启用 GUI：在 VM 的【交互式 PowerShell（RDP 桌面内）】执行以下命令');
            log('         （先结束非交互式实例、释放端口，再在交互式会话拉起 GUI 可用实例）：');
            for (const line of GUI_RESTART_COMMAND) log(`         ${line}`);
            log('         执行后重跑本步（或刷新 /health）应见 session.interactive=true、GUI 可用。');
          }
        } catch {
          /* 解析失败不影响主流程 */
        }
      } else {
        log(`   ❌ 端口已监听但 /health 未返回（已重试 3 次）：${lastOut.slice(0, 400)}`);
        log('   提示：/health 需要 VM 侧 HTTP 服务已运行。若 schtasks /run 未生效，可在 VM 内手动执行');
        log(`         schtasks /run /tn ${SERVICE_TASK_NAME} 后重跑本步，或确认 SSH 隧道已建立。`);
        failed++;
      }
      continue;
    }

    // BUILD / HOST / TEST：本地直接运行
    const parts = s.command.split(' ');
    const r = await run(parts[0], parts.slice(1), { timeoutMs: 180_000 });
    if (!r.ok) {
      log(`   ❌ 失败（exit ${r.code}）：${r.out.slice(0, 400)}`);
      failed++;
    } else {
      log('   ✅ 完成');
    }
  }

  log('');
  if (failed > 0) {
    log(`${isUninstall ? '卸载' : '部署'}完成但有 ${failed} 个步骤失败，请查看上方日志。`);
    process.exitCode = 1;
  } else {
    log(`${isUninstall ? '卸载全部完成 ✅（项目部分已移除，删除物均在回收站可恢复）' : '部署全部完成 ✅'}`);
    if (!isUninstall && guiDegraded) {
      log('');
      log('   ⚠️ 注意：VM 服务当前运行在非交互式会话，GUI 能力不可用（MCP/A2A 与 54 能力正常）。');
      log('      若需 GUI，请在 VM 交互式 PowerShell 中执行上方「💡 启用 GUI」命令块后，重跑本脚本或刷新 /health。');
    }
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

/**
 * WinVM Bridge —— 双端一键部署脚本（宿主机侧 + VM 侧）
 *
 * 读取项目根 .env（不存在则回退 .env.example），按配置完成：
 *   BUILD → HOST（install-host.mjs）→ VM（scp + install-vm.mjs）→ VM-START（schtasks /run 拉起服务，
 *         并轮询 VM 本机 18443 端口监听 ≤60s 才认为启动完成）
 *         → TUNNEL（daemon-aware 幂等：优先复用常驻 tunnel-daemon、不建新隧道；未在线则经
 *           `winvm-plugin tunnel ensure` 由 daemon 拉起；仅 ensure 失败才回落自建 ssh 并告警）
 *         → TEST（宿主机自检）→ HEALTH（经隧道探测 /health：传输级短重试 3 次 + D15 载荷级
 *           退避复探 10s×≤6/预算≤90s「直到会话门禁结论明确」；需 WINVM_SETUP_TUNNEL=1）
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

import { readFileSync, existsSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import net from 'node:net';

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
    // Phase 5 批14：策略闸执法灰度跨部署持久化（'' / shadow ⇒ 不注入=缺省 shadow）。
    policyGateWiring: (env['WINVM_POLICY_GATE_WIRING'] || '').trim().toLowerCase(),
    workbuddyCli: env['WINVM_WORKBUDDY_CLI'] || 'codebuddy',
    hermesCli: env['WINVM_HERMES_CLI'] || 'hermes',
    setupTunnel: bool('WINVM_SETUP_TUNNEL'),
    tunnelLocalPort: num('WINVM_TUNNEL_LOCAL_PORT', 18443),
    tunnelRemotePort: num('WINVM_TUNNEL_REMOTE_PORT', 18443),
    // REL-V1.4.0：发布包场景——包内 dist 已构建且 MANIFEST 指纹在册，且包不含 src/tsconfig/tsc，
    // 无条件重跑 BUILD 必失败。--skip-build / WINVM_SKIP_BUILD=1 显式跳过（仓库态默认不跳）。
    skipBuild: opts.skipBuild === true || bool('WINVM_SKIP_BUILD'),
  };
}

/** 生成部署执行计划（纯函数，便于单测）*/
export function buildPlan(cfg) {
  const steps = [];
  const mode = cfg.dryRun ? 'dry-run（只规划）' : 'apply（真执行）';
  // REL-V1.4.0：skipBuild 时省略 BUILD 相位（发布包 dist 已指纹在册；见 resolveConfig 注释）
  if (!cfg.skipBuild) {
    steps.push({
      phase: 'BUILD',
      description: `构建全部包（npm run build）[${mode}]`,
      command: 'npm run build',
      apply: !cfg.dryRun,
    });
  }
  if (cfg.hostDeploy) {
    const args = ['node', 'delivery/install-host.mjs'];
    if (cfg.dryRun) args.push('--dry-run');
    if (cfg.hostHome) args.push('--home', cfg.hostHome);
    if (cfg.hostUser) args.push('--user', cfg.hostUser);
    // 把 VM 连接信息透传给宿主安装器，由其持久化到 vm-conn.json，
    // 使宿主侧 winvm-plugin health/server/command 无需每次手动指定 --vm-host/--vm-user。
    if (cfg.vmHost) {
      args.push(
        '--vm-host', cfg.vmHost,
        '--vm-user', cfg.vmUser,
        '--vm-ssh-port', String(cfg.vmSshPort),
        '--vm-port', String(cfg.tunnelRemotePort),
      );
    }
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
    steps.push({
      phase: 'VM-START',
      description: `部署后拉起 VM 服务（.ps1 推送执行：结束旧实例并强杀残留端口进程 → schtasks /run /tn ${SERVICE_TASK_NAME}，并轮询端口监听 ≤420s）[${mode}]`,
      // 实际执行走 runRemotePs1（scp .ps1 → powershell -File），此处仅展示语义（铁律：勿内联 PowerShell）。
      command: `[.ps1 push] schtasks /end → kill port ${cfg.servicePort} owner → schtasks /run /tn ${SERVICE_TASK_NAME}`,
      apply: !cfg.dryRun,
    });
  }
  if (cfg.setupTunnel && cfg.vmHost) {
    steps.push({
      phase: 'TUNNEL',
      description: `确保 SSH 本地转发 ${cfg.tunnelLocalPort}:127.0.0.1:${cfg.tunnelRemotePort}（复用常驻 tunnel-daemon；未在线则由 daemon 拉起）[${mode}]`,
      // D14：与常驻 tunnel-daemon 统一机制 —— 先复用、再 `winvm-plugin tunnel ensure` 拉起，
      // 不再无条件自建进程内隧道（会与 daemon 抢端口 → EADDRINUSE）。此处仅展示语义。
      command:
        `winvm-plugin tunnel ensure ` +
        `（已在线则复用常驻 daemon、不建新隧道；未在线则由 daemon 拉起；` +
        `--local-port ${cfg.tunnelLocalPort}）`,
      apply: !cfg.dryRun,
    });
  }
  steps.push({
    phase: 'TEST',
    description: '宿主机侧自检（能力注册表 / ps-bridge / provider 能力目录）',
    command: 'node packages/vm-service/dist/cli.js --self-test',
    apply: !cfg.dryRun,
  });
  // QA-PROBE：把 QA 验收夹具（探针脚本）随装分发到 VM。相位顺序取 TEST→QA-PROBE→HEALTH：
  //  - QA-PROBE 仅 scp 推文件、不依赖隧道/服务，属轻量 I/O；紧随 TEST 执行可让「全新安装后
  //    直接跑 node qa/probes/qa-verify.mjs」成立（QA 上轮全新安装后 A1/A3/A11 因探针不在 VM 上
  //    而误报 VM_UNREACHABLE，被迫手工 scp 补救 —— 本相位即根治）。
  //  - 放在 HEALTH 之前使 HEALTH 保持部署流程的最终闸门：即使探针推送失败（仅 WARN 不阻断，
  //    QA 夹具属开发/验收工具、非运行时依赖），也不会掩盖真正的部署健康问题。
  // 全集以 qa/probes/qa-verify.mjs 对 VM 侧 C:/WinVMBridge/ 的实际引用为准（vmps() 仅引用
  // qa-probe.ps1 与 lead-md5-3.ps1 两个，已 grep 核验；probe-inv.ps1 等为宿主侧/历史夹具）。
  if (cfg.vmHost) {
    steps.push({
      phase: 'QA-PROBE',
      description: `分发 QA 探针夹具（qa/probes/${QA_PROBE_FILES.join('、qa/probes/')} → ${cfg.vmDeployDir}；缺失仅 WARN 不阻断）[${mode}]`,
      command: `scp -P ${cfg.vmSshPort} qa/probes/{${QA_PROBE_FILES.join(',')}} ${cfg.vmUser}@${cfg.vmHost}:${cfg.vmDeployDir}/`,
      apply: !cfg.dryRun,
    });
  }
  // HEALTH 独立于 TEST：早期把 self-test 与 curl 用 `;` 拼成一条命令，而执行器
  // 用 split(' ') 还原参数，`;` 会被当成 node 的命令行参数 —— curl 永远不执行，
  // /health 检查形同虚设。拆成独立阶段后，各自都是一条干净的单命令。
  if (cfg.setupTunnel && cfg.vmHost) {
    steps.push({
      phase: 'HEALTH',
      description: `经隧道探测 VM 服务 http://127.0.0.1:${cfg.tunnelLocalPort}/health`,
      // --noproxy：本机代理（如 TUN 模式）会拦截回环流量，必须显式绕开；
      // --max-time：与服务未拉起时不要长时间挂住整个流程（与 HEALTH 相位实际执行值一致 = 30s）。
      command:
        `curl -s --noproxy 127.0.0.1 --max-time 30 ` +
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

/** VM 侧开发/测试过程文件收口目录（目录治理 2026-09-23：过程文件不再散落部署根）。
 * 探针夹具 → dev-and-qa/probes/，部署日志 → dev-and-qa/logs/<日期>/，
 * 每次部署收尾写 MANIFEST-deploy-<日期>.txt（与宿主 qa/ 同规防膨胀）。 */
export const VM_DEVQA_DIR = 'dev-and-qa';

/** 生成部署 MANIFEST 内容（纯函数，便于单测）：记录本次部署落盘的过程文件与时间戳。
 * @param {{deployedAt:string, probes:string[], archive:string, logFile:string}} info
 */
export function buildDeployManifest(info) {
  const lines = [
    '# WinVM Bridge deploy manifest (dev-and-qa)',
    `deployedAt: ${info.deployedAt}`,
    `archive: ${info.archive}`,
    `installLog: ${info.logFile}`,
    'probes:',
    ...info.probes.map((p) => `  - ${p}`),
    'note: scratch/probe files live under dev-and-qa/, not deploy root.',
    '',
  ];
  return lines.join('\n');
}

/**
 * QA 验收夹具（VM 侧探针脚本）全集 —— QA-PROBE 相位随装分发的文件清单。
 * 口径：qa/probes/qa-verify.mjs 中 vmps('<file>') 对 C:/WinVMBridge/ 的全部引用
 * （A1/A3 用 qa-probe.ps1，A11 用 lead-md5-3.ps1；新增 VM 侧引用时须同步此表）。
 */
export const QA_PROBE_FILES = ['qa-probe.ps1', 'lead-md5-3.ps1'];

/**
 * QA-PROBE 相位执行体：把仓库 qa/probes/ 下的探针脚本逐个 scp 到 VM 部署目录下的
 * dev-and-qa/probes/（目录治理 2026-09-23：探针夹具不再散落部署根）。
 * 文件缺失（如新机器未携带 qa/probes 验收夹具区）→ 记入 missing 并 WARN，**不阻断**部署；
 * 单文件 scp 失败（网络抖动等）→ 记入 out，整体 ok=false，但仍不阻断部署流程。
 * @returns {{ok:boolean, pushed:string[], missing:string[], out:string}}
 */
async function deployQaProbes(cfg, log) {
  if (!cfg.vmHost) return { ok: false, pushed: [], missing: [...QA_PROBE_FILES], out: 'VM_HOST 未配置' };
  const pushed = [];
  const missing = [];
  let ok = true;
  let out = '';
  // 先确保远端收口目录存在（探针落 dev-and-qa/probes/，不散落部署根）
  const mk = await run(
    'ssh',
    [
      '-p', String(cfg.vmSshPort), `${cfg.vmUser}@${cfg.vmHost}`,
      `powershell -NoProfile -Command "New-Item -ItemType Directory -Force -Path '${cfg.vmDeployDir}/${VM_DEVQA_DIR}/probes' | Out-Null"`,
    ],
    { timeoutMs: 60_000 },
  );
  if (!mk.ok) {
    return { ok: false, pushed: [], missing: [...QA_PROBE_FILES], out: `创建远端 dev-and-qa/probes 失败：${mk.out.slice(0, 200)}` };
  }
  for (const f of QA_PROBE_FILES) {
    const local = join(ROOT, 'qa', 'probes', f);
    if (!existsSync(local)) {
      missing.push(f);
      continue;
    }
    const r = await run(
      'scp',
      ['-P', String(cfg.vmSshPort), local, `${cfg.vmUser}@${cfg.vmHost}:${cfg.vmDeployDir}/${VM_DEVQA_DIR}/probes/${f}`],
      { timeoutMs: 60_000 },
    );
    if (r.ok) {
      pushed.push(f);
      log(`   (qa/probes/${f} → ${cfg.vmUser}@${cfg.vmHost}:${cfg.vmDeployDir}/${VM_DEVQA_DIR}/probes)`);
    } else {
      ok = false;
      out += `scp ${f} 失败：${r.out.slice(0, 200)}\n`;
    }
  }
  return { ok, pushed, missing, out };
}

/**
 * 部署收尾：在 VM 的 dev-and-qa/ 写 MANIFEST-deploy-<日期>.txt（留痕）。
 * 「按日期子目录 + MANIFEST」防膨胀规则的一部分；失败仅告警不阻断部署主干。
 * ⚠ 同 vmInstallCommand：日期由宿主端求值拼入（MSYS `$(...)` 陷阱，见上注释）。
 * @returns {{ok:boolean, manifestPath:string, out:string}}
 */
async function writeDeployManifest(cfg, log) {
  if (!cfg.vmHost) return { ok: false, manifestPath: '', out: 'VM_HOST 未配置' };
  const dateStr = new Date().toISOString().slice(0, 10);
  const manifestBody = buildDeployManifest({
    deployedAt: new Date().toISOString(),
    archive: VM_ARCHIVE,
    logFile: `${VM_DEVQA_DIR}/logs/${dateStr}/install-vm-run.log`,
    probes: QA_PROBE_FILES.map((f) => `${VM_DEVQA_DIR}/probes/${f}`),
  });
  const manifestPath = `${cfg.vmDeployDir}/${VM_DEVQA_DIR}/MANIFEST-deploy-${dateStr}.txt`;
  const cmd = `cat > ${manifestPath} && echo MANIFEST_WRITTEN`;
  const r = await run(
    'ssh',
    ['-p', String(cfg.vmSshPort), `${cfg.vmUser}@${cfg.vmHost}`, cmd],
    { timeoutMs: 60_000 },
  );
  // stdin 需写入远端文件：spawn 无 input 通道时经 bash heredoc 不可靠，改用 tar 免引号：
  // 直接把内容经 ssh stdin 传入远端 cat（run() 支持? 不支持 → 改用 scp 临时文件，最稳）
  if (!r.ok || !r.out.includes('MANIFEST_WRITTEN')) {
    // 回退通道：写本地临时文件 → scp → ssh mv（MSYS 路径需 C:/ 形式）
    const tmpLocal = join(ROOT, VM_ARCHIVE.replace('.tgz', '.manifest.tmp'));
    try {
      writeFileSync(tmpLocal, manifestBody, 'utf8');
      const scpR = await run(
        'scp',
        ['-P', String(cfg.vmSshPort), tmpLocal, `${cfg.vmUser}@${cfg.vmHost}:${manifestPath}`],
        { timeoutMs: 60_000 },
      );
      if (scpR.ok) {
        log(`   ✅ 部署 MANIFEST 已写入（scp 通道）${manifestPath}`);
        return { ok: true, manifestPath, out: scpR.out };
      }
      log(`   ⚠️ 部署 MANIFEST 写入失败（不阻断）：scp ${scpR.out.slice(0, 160)}`);
      return { ok: false, manifestPath, out: scpR.out };
    } finally {
      try { rmSync(tmpLocal, { force: true }); } catch { /* noop */ }
    }
  }
  return { ok: true, manifestPath, out: r.out };
}

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

/**
 * 解释 `/health` 载荷中的**会话门禁**（gui.* 可用性）—— 纯函数，返回三态判别式。
 *
 * D15 修复：探针超时（冷启动期常见）时服务会把 `session.interactive` 默认成 `false`
 * 且 `state` 呈 `unavailable`；若直接据 `interactive===false` 判「非交互」即为**误报
 * （false negative）**，还会连带打印误导性的人工补救命令，削弱「一键部署」体验。
 * 故本函数把「确证非交互」收紧为「`state==='healthy'` **且** `interactive===false`」。
 *
 * 三态：
 *  - `gui-ok`       ：`state==='healthy'` 且 `interactive===true` → GUI 可用。
 *  - `gui-degraded` ：`state==='healthy'` 且 `interactive===false`（且 `sessionId` 为正、
 *                     无探针超时信号）→ **确证**非交互，保留补救命令块。
 *  - `unknown`      ：其余一切（`state==='unavailable'` / 探针超时 / `psBridge.probe==='timeout'` /
 *                     缺 `session` 字段 / `sessionId` 非正 / `interactive` 缺失或非布尔）→
 *                     **结论未知**，禁止断言非交互、禁止打印「💡 启用 GUI」命令块。
 *
 * 无 I/O、无副作用：供 HEALTH 相位与单测确定性复用。
 *
 * @param {unknown} h 已解析的 /health JSON（或任意值；解析失败请传 `undefined`）
 * @returns {{
 *   vet: 'gui-ok'|'gui-degraded'|'unknown',
 *   sessionId: number|null,
 *   windowStation: string|null,
 *   interactive: boolean|null,
 *   locked: boolean|null,
 *   probeTimeout: boolean,
 *   reason: string,
 * }}
 */
export function interpretHealth(h) {
  const isObj = (v) => v !== null && typeof v === 'object';
  const session = isObj(h) && isObj(h.session) ? h.session : undefined;
  const psBridge = isObj(h) && isObj(h.psBridge) ? h.psBridge : undefined;

  const sessionId = session && typeof session.sessionId === 'number' ? session.sessionId : null;
  const windowStation =
    session && typeof session.windowStation === 'string' && session.windowStation.length > 0
      ? session.windowStation
      : null;
  const interactive = session && typeof session.interactive === 'boolean' ? session.interactive : null;
  const locked = session && typeof session.locked === 'boolean' ? session.locked : null;
  const state = session && typeof session.state === 'string' ? session.state : null;
  // 探针超时信号：会话子探针超时（state=unavailable）或 psBridge 子探针超时（probe=timeout）。
  const probeTimeout = state === 'unavailable' || (isObj(psBridge) && psBridge.probe === 'timeout');

  const base = { sessionId, windowStation, interactive, locked, probeTimeout };

  if (!session) {
    return { ...base, vet: 'unknown', reason: '载荷缺少 session 字段（会话结论未知）' };
  }
  if (state !== 'healthy') {
    return {
      ...base,
      vet: 'unknown',
      reason: `session.state=${state ?? '缺省'}（非 healthy → 结论未知，不判非交互）`,
    };
  }
  // 以下 state === 'healthy'：此时 interactive 才是可信的确证信号。
  if (interactive === true) {
    return { ...base, vet: 'gui-ok', reason: '会话健康且交互式（GUI 能力可用）' };
  }
  if (interactive === false) {
    // 防御：即便自报 healthy，若 sessionId 非正或仍有探针超时信号 → 仍判未知（不误断非交互）。
    if (sessionId === null || sessionId <= 0) {
      return { ...base, vet: 'unknown', reason: `state=healthy 但 sessionId=${sessionId ?? '缺省'}（非正 → 结论未知）` };
    }
    if (probeTimeout) {
      return { ...base, vet: 'unknown', reason: 'state=healthy 但仍见探针超时信号（结论未知）' };
    }
    return { ...base, vet: 'gui-degraded', reason: '确证非交互式会话（GUI 能力不可用）' };
  }
  return { ...base, vet: 'unknown', reason: 'interactive 字段缺失或非布尔（结论未知）' };
}

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

/** VM 侧安装命令（dist 已随包分发，故跳过依赖安装与构建）
 *
 * 引号修复（首跑 VM 相位超时共因之一）：原实现把 node -e 嵌在外层双引号里
 * （`... node -e "require('fs').rmSync(...)" ...`），内层双引号会把外层引用截断，
 * rmSync 段脱离引号后极易被远端 shell 二次解析。改为**单引号包 JS、JS 内用双引号**：
 * 远端 Git-Bash 对单引号内内容不做任何展开，node 收到的即字面 JS。
 * 同时把 install-vm 输出经 `| tee install-vm-run.log` 持久化到 VM（set -o pipefail
 * 保证 node 退出码穿透管道），即使 ssh 会话被超时杀掉，逐步计时打点仍可在 VM 上回查。
 * 目录治理（2026-09-23）：日志从部署根收口进 dev-and-qa/logs/<日期>/。
 * ⚠ MSYS 陷阱（实测复现）：ssh 命令串里的 `\$(date +%F)` 到达远端 Git-Bash 后报
 *   「syntax error near unexpected token '('」——反斜杠经 MSYS argv 处理被吞、`$(` 裸奔。
 *   故日期目录**不在 shell 串里求值**：由 deployVm 把宿主端算好的日期串拼进路径
 *   （宿主/VM 同为 GMT+8 且部署窗口为秒级，跨日漂移风险可忽略；单测锁定路径形状）。 */
export function vmInstallCommand(cfg, dateStr) {
  const d = dateStr ?? new Date().toISOString().slice(0, 10);
  // 批14：策略闸执法灰度跨部署持久化透传（值已过 resolveConfig 白名单化，仅 off/shadow/on；
  // 空或 shadow ⇒ 不传=产物逐字节旧形态；MSYS 陷阱锁兼容：无 $()）。
  const wiringArg =
    cfg.policyGateWiring === 'on' || cfg.policyGateWiring === 'off'
      ? `--policy-gate-wiring ${cfg.policyGateWiring} `
      : '';
  return (
    `set -o pipefail; cd ${cfg.vmDeployDir} && mkdir -p ${VM_DEVQA_DIR}/logs/${d} && ` +
    `tar -xzf ${VM_ARCHIVE} && ` +
    `node -e 'require("fs").rmSync("${VM_ARCHIVE}",{force:true})' && ` +
    `node delivery/install-vm.mjs --skip-install --skip-build ` +
    `${wiringArg}` +
    `--provider ${cfg.vmProvider} --cli ${resolveVmCli(cfg)} 2>&1 | tee ${VM_DEVQA_DIR}/logs/${d}/install-vm-run.log`
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
    // run4/run5 取证（逐步计时）：VM 相位冷机实测 317~377s，自检最多 3×~75s 后最坏 ~500s+，
    // 且 powershell.exe 进程创建延迟逐次波动。按实测证据放宽到 600s。
    { timeoutMs: 600_000 },
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

/* ----------------------------- 远端 PowerShell 铁律辅助（.ps1 推送） -----------------------------
 * 项目铁律：勿 ssh 内联 PowerShell（VM 远端默认 shell = Git-Bash/MSYS，会做路径转换与
 * 变量吞改：/End → C:/.../End、$_ → /usr/bin/bash）。凡远端 PowerShell 逻辑一律写 .ps1
 * → scp → `powershell -File`。VM-START 相位与 uninstall.mjs 均用此通道。 */

/**
 * 把 .ps1 内容推送到 VM 并以 `powershell -NoProfile -ExecutionPolicy Bypass -File` 执行。
 * @returns {{ok:boolean, code:number, out:string}}
 */
export async function runRemotePs1(cfg, ps1Body, { timeoutMs = 120_000, log = (m) => {} } = {}) {
  if (!cfg.vmHost) return { ok: false, code: -1, out: 'VM_HOST 未配置' };
  const remoteName = `winvm-setup-${Date.now()}.ps1`;
  const localPath = join(tmpdir(), remoteName);
  try {
    writeFileSync(localPath, ps1Body.replace(/\n/g, '\r\n'), 'utf8');
  } catch {
    // 部分沙箱 /tmp 只读：退回项目内临时目录
    const fallbackDir = join(ROOT, '.setup-tmp');
    mkdirSync(fallbackDir, { recursive: true });
    writeFileSync(join(fallbackDir, remoteName), ps1Body.replace(/\n/g, '\r\n'), 'utf8');
  }
  const localWritten = existsSync(localPath) ? localPath : join(ROOT, '.setup-tmp', remoteName);
  const sshTarget = `${cfg.vmUser}@${cfg.vmHost}`;
  try {
    const scp = await run('scp', ['-P', String(cfg.vmSshPort), localWritten, `${sshTarget}:${remoteName}`], { timeoutMs: 60_000 });
    if (!scp.ok) return { ok: false, code: scp.code, out: `scp .ps1 失败：${scp.out.slice(0, 300)}` };
    log(`   (.ps1 已推送 ${remoteName} → VM)`);
    const r = await run(
      'ssh',
      [
        '-p', String(cfg.vmSshPort),
        sshTarget,
        `powershell -NoProfile -ExecutionPolicy Bypass -File ${remoteName}`,
      ],
      { timeoutMs },
    );
    // 清理远端与本地临时脚本（best-effort）
    await run('ssh', ['-p', String(cfg.vmSshPort), sshTarget, `rm -f ${remoteName}`], { timeoutMs: 30_000 });
    return r;
  } finally {
    try { rmSync(localWritten, { force: true }); } catch { /* noop */ }
  }
}

/**
 * VM-START 相位的 .ps1：结束旧实例 → 强杀残留端口进程 → schtasks /run。
 * 与原内联 restartRemote 命令语义一致，改为 .ps1 推送执行（铁律）。
 */
export function buildVmStartPs1(cfg) {
  const lines = [
    "$ErrorActionPreference = 'Continue'",
    "$TaskName = 'WinVMBridge.Service'",
    '$Port = ' + cfg.servicePort,
    '$null = schtasks /End /TN $TaskName 2> $null',
    'Start-Sleep -Seconds 1',
    '$p = (Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue).OwningProcess | Select-Object -Unique',
    'if ($p) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }',
    'Start-Sleep -Seconds 1',
    '$null = schtasks /Run /TN $TaskName 2> $null',
    'if ($LASTEXITCODE -eq 0) { Write-Output "VM_START_TRIGGERED" }',
    'else { Write-Output ("VM_START_FAILED exit=" + $LASTEXITCODE); exit 1 }',
    '',
  ];
  return lines.join('\r\n');
}

/**
 * 隧道私钥解析（TUNNEL 相位 ssh2 后端用）：
 * ssh2 无法复用系统 ssh agent，必须有真实私钥文件。
 * 优先级：env WINVM_VM_KEY > ~/.ssh/id_ed25519 > id_ecdsa > id_rsa（默认键探测链）。
 * @returns {{identityFile?: string, source: 'env'|'default'|'none'}} */
export function resolveTunnelIdentityFile() {
  const envKey = process.env['WINVM_VM_KEY'];
  if (envKey) return { identityFile: envKey, source: 'env' };
  const home = homedir();
  for (const name of ['id_ed25519', 'id_ecdsa', 'id_rsa']) {
    const p = join(home, '.ssh', name);
    if (existsSync(p)) return { identityFile: p, source: 'default' };
  }
  return { identityFile: undefined, source: 'none' };
}

/** 本地 TCP 端口是否可连（HEALTH 失败时区分「未监听」vs「监听但无 HTTP」）。 */
function checkTcpOpen(port, timeoutMs = 3000) {
  return new Promise((res) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (v) => {
      try { sock.destroy(); } catch { /* noop */ }
      res(v);
    };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => done(true));
    sock.on('timeout', () => done(false));
    sock.on('error', () => done(false));
  });
}

/* --------------------- 隧道相位辅助（D14：daemon-aware 幂等） --------------------- */

/**
 * 宿主插件 CLI 绝对路径。
 *
 * D14：隧道改由常驻 `tunnel-daemon`（pidfile + `tunnel.pid`）承载并已注册为 WorkBuddy 启动服务
 * （Item 1）；TUNNEL 相位必须复用/拉起该 daemon，而不是每条部署再自建一条随部署进程生灭的隧道
 * —— 后者会与常驻 daemon 争抢 `127.0.0.1:<port>`（实测 EADDRINUSE）。
 */
const PLUGIN_CLI = join(__dirname, 'winvm-plugin.mjs');

/**
 * 本宿主是否支持常驻隧道 daemon。
 *
 * win32/macOS 的隧道由系统 ssh 提供，插件 `tunnel` 子命令会主动拒绝拉起常驻进程
 * （见 winvm-plugin.mjs `cmdTunnel`），故这些平台不能走 daemon 路径，只能回落系统 ssh。
 */
function tunnelDaemonSupported() {
  return process.platform !== 'win32' && process.platform !== 'darwin';
}

/** 传给插件 CLI 的 VM 连接 / 端口参数，使插件无需依赖 .env / vm-conn.json 也能定位目标。 */
function pluginVmArgs(cfg) {
  const args = [];
  if (cfg.vmHost) args.push('--vm-host', cfg.vmHost);
  if (cfg.vmUser) args.push('--vm-user', cfg.vmUser);
  args.push('--vm-ssh-port', String(cfg.vmSshPort));
  args.push('--vm-port', String(cfg.tunnelRemotePort));
  args.push('--local-port', String(cfg.tunnelLocalPort));
  args.push('--remote-port', String(cfg.tunnelRemotePort));
  return args;
}

/**
 * 取隧道**权威**态（D6：健康判定只以 `tunnel status` 输出为准，state.json 仅作诊断）。
 * @returns {Promise<{state?: string, healthy: boolean, pid: number|null, raw: string}>}
 */
async function pluginTunnelStatus(cfg) {
  const r = await run(process.execPath, [PLUGIN_CLI, 'tunnel', 'status', '--json', ...pluginVmArgs(cfg)], { timeoutMs: 20_000 });
  const out = r.out ?? '';
  const start = out.indexOf('{');
  if (start === -1) return { state: undefined, healthy: false, pid: null, raw: out };
  try {
    const j = JSON.parse(out.slice(start));
    return { state: j.state, healthy: j.state === 'RUNNING' && j.healthy === true, pid: j.pid ?? null, raw: out };
  } catch {
    return { state: undefined, healthy: false, pid: null, raw: out };
  }
}

/** 经本地回环端口探测 VM `/health`（验证「已有隧道确实打通」，而非仅端口被占用）。 */
async function probeTunnelHttp(port, timeoutMs = 8_000) {
  const r = await run('curl', ['-s', '--noproxy', '127.0.0.1', '--max-time', '5', `http://127.0.0.1:${port}/health`], { timeoutMs });
  if (!r.ok || !r.out) return false;
  try {
    const j = JSON.parse(r.out);
    return j !== null && typeof j === 'object' && (j.provider !== undefined || j.psBridge !== undefined || j.ok !== undefined);
  } catch {
    return false;
  }
}

/**
 * OBS-1（REL-V1.4.0 迭代2）：TUNNEL 相位「复用/就绪」判据（纯函数，供单测钉死）。
 *
 * 病灶（迭代1 run1 观察项）：daemon 自报 healthy（本地端口在听、pidfile 在位）但 VM 服务
 * 已死时，旧判据「daemon healthy ⇒ 直接复用」会放行**隧道黑洞**——本地活 ≠ 后端活，
 * 部署日志一片 ✅，后续 HEALTH 相位才炸，误导定位方向。
 * 修复口径：**daemon 自报态仅作信息；后端 /health 经本地端口打通为唯一硬判据**。
 *
 * @param {boolean} daemonHealthy daemon 权威态自报 healthy（`tunnel status` 输出）
 * @param {boolean} httpOk 本地回环端口已打通 VM `/health`
 * @returns {{reusable: boolean, blackhole: boolean, note: string}}
 *   reusable=true ⇒ 可判相位成功（复用）；blackhole=true ⇒ daemon 自报健康但后端未通（隧道黑洞嫌疑）。
 */
export function evaluateTunnelReuse(daemonHealthy, httpOk) {
  if (httpOk) {
    return { reusable: true, blackhole: false, note: '后端 /health 已打通' };
  }
  if (daemonHealthy) {
    return {
      reusable: false,
      blackhole: true,
      note: 'daemon 自报 healthy 但后端未通——疑似隧道黑洞',
    };
  }
  return { reusable: false, blackhole: false, note: 'daemon 未报健康且后端未通' };
}

/**
 * D14：TUNNEL 相位 —— daemon-aware 幂等（修复「与常驻 daemon 抢端口 → EADDRINUSE → 整体 EXIT 1」）。
 * OBS-1（迭代2）修订判据口径：**daemon 自报态仅作信息，后端 /health 打通为唯一硬判据**。
 *
 * 决策顺序：
 *  1) **复用**：`127.0.0.1:<port>` 已监听且**后端 /health 确实打通** → 直接复用，**不建新隧道**，
 *     相位判成功（不产生第二实例）。daemon 权威态仅写入日志佐证，不作放行依据——
 *     run1 观察项：daemon 自报 healthy 但 VM 服务死 = 隧道黑洞（本地活 ≠ 后端活）。
 *  2) **拉起**：未打通 → 优先 `winvm-plugin tunnel ensure`（与常驻 daemon 同一机制、持久、幂等）；
 *     就绪判据同为 /health 打通（ensure 刚返回时给一次短重试，容忍后端启动瞬态）；成功即相位成功。
 *  3) **回落**：`ensure` 不可用/失败 → 保持既有「进程内 ssh2 / 系统 ssh」自建路径，并**显式告警**
 *     可能与 daemon 端口冲突（安全网，非主路径）。
 * @returns {Promise<{ok: boolean, reused: boolean, pid: number|null, elapsedMs: number, handle?: unknown}>}
 */
async function runTunnelPhase(cfg) {
  const port = cfg.tunnelLocalPort;
  const daemonOk = tunnelDaemonSupported();

  // —— 1) 复用探测（OBS-1：先探后端，daemon 态仅作信息）——
  if (await checkTcpOpen(port)) {
    const t0 = Date.now();
    const httpOk = await probeTunnelHttp(port);
    const probeMs = Date.now() - t0;
    const st = daemonOk ? await pluginTunnelStatus(cfg) : null;
    const verdict = evaluateTunnelReuse(st?.healthy === true, httpOk);
    if (verdict.reusable) {
      const who = daemonOk
        ? `常驻 tunnel-daemon（pid ${st.pid ?? '?'}，态=${st.state ?? '未知'}）`
        : '系统 ssh 隧道';
      log(`   ♻️ 复用${who} —— 本地 127.0.0.1:${port} 可打通 /health（探测 ${probeMs}ms），跳过自建`);
      return { ok: true, reused: true, pid: st?.pid ?? null, elapsedMs: probeMs };
    }
    if (verdict.blackhole) {
      log(`   ⚠️ 隧道黑洞嫌疑：daemon 自报 healthy（pid ${st.pid ?? '?'}）但本地 127.0.0.1:${port} 未打通 /health → 尝试由 daemon 恢复/拉起`);
    } else if (daemonOk) {
      log(`   ⚠️ 127.0.0.1:${port} 已监听但未打通 /health（daemon 态=${st.state ?? '未知'}）→ 尝试由 daemon 恢复/拉起`);
    } else {
      log(`   ⚠️ 127.0.0.1:${port} 已监听但未打通 → 尝试重建`);
    }
  } else {
    log(`   本地 127.0.0.1:${port} 未监听 → 需建立隧道`);
  }

  // —— 2) 优先由常驻 daemon 幂等拉起 ——
  if (daemonOk) {
    log(`   ⏳ 由常驻 daemon 拉起/确保隧道：winvm-plugin tunnel ensure …`);
    const t0 = Date.now();
    const r = await run(process.execPath, [PLUGIN_CLI, 'tunnel', 'ensure', ...pluginVmArgs(cfg)], { timeoutMs: 90_000 });
    const elapsedMs = Date.now() - t0;
    const st = await pluginTunnelStatus(cfg);
    // OBS-1：daemon 自报 healthy 仅作信息，就绪判据=后端 /health 打通。
    // ensure 刚返回时后端可能仍在起（VM-START 紧随其后），r.ok 时给一次短重试窗口。
    let httpOk = await probeTunnelHttp(port);
    if (!httpOk && r.ok) {
      await sleep(2_000);
      httpOk = await probeTunnelHttp(port);
    }
    if (httpOk) {
      log(`   ✅ 常驻隧道已就绪且后端已打通（tunnel ensure 用时 ${(elapsedMs / 1000).toFixed(1)}s，pid ${st.pid ?? '?'}，daemon 态=${st.state ?? '未知'}）—— 本地 127.0.0.1:${port} 可连`);
      return { ok: true, reused: false, pid: st.pid ?? null, elapsedMs };
    }
    log(`   ❌ tunnel ensure 后后端仍未打通（用时 ${(elapsedMs / 1000).toFixed(1)}s，state=${st.state ?? '未知'}）→ 回落自建隧道`);
  }

  // —— 3) 回落：既有「进程内 ssh2 / 系统 ssh」自建路径（保留原语义） ——
  log('   ⚠️ 回落自建隧道：若常驻 daemon 仍在，可能因端口占用失败 —— 请改用 winvm-plugin tunnel ensure 排查');
  // ohos/openharmony 双兼容：实机 HMOS（Node v24.13.0）process.platform 实报
  // 'openharmony'，仅判 'ohos' 会让真机隧道错误回落系统 ssh（QA E-4 实证）。
  const useSsh2 = process.platform === 'ohos' || process.platform === 'openharmony' || process.env['WINVM_TUNNEL_BACKEND'] === 'ssh2';
  if (useSsh2) {
    // OH 宿主 / 显式 ssh2 后端：进程内纯 JS 隧道（无系统 ssh 时）。
    // 隧道随部署进程生命周期存在（HEALTH 验证后即关闭释放端口），退出时由模块自带清理兜底。
    try {
      const { establishSsh2Tunnel } = await import('./oh-tunnel.mjs');
      // ssh2 无法复用系统 ssh agent，必须有真实私钥文件：
      // env WINVM_VM_KEY 未设时按默认键探测链 ~/.ssh/id_ed25519 → id_ecdsa → id_rsa。
      const id = resolveTunnelIdentityFile();
      if (id.identityFile) {
        log(`   使用私钥：${id.identityFile}（来源：${id.source === 'env' ? 'WINVM_VM_KEY' : '默认 ~/.ssh 探测'}）`);
      } else {
        log('   ⚠️ 未找到可用私钥（WINVM_VM_KEY 未设且 ~/.ssh 无 id_ed25519/id_ecdsa/id_rsa）');
      }
      const handle = await establishSsh2Tunnel({
        vmHost: cfg.vmHost,
        vmSshPort: cfg.vmSshPort,
        username: cfg.vmUser,
        localBindHost: '127.0.0.1',
        localBindPort: cfg.tunnelLocalPort,
        remoteHost: '127.0.0.1',
        remotePort: cfg.tunnelRemotePort,
        identityFile: id.identityFile,
        password: process.env['WINVM_VM_PASSWORD'] || undefined,
        keepaliveInterval: 30_000,
        readyTimeoutMs: 20_000,
      });
      log(`   ⏳ 进程内 ssh2 隧道已建立：本地 127.0.0.1:${cfg.tunnelLocalPort} → VM:${cfg.tunnelRemotePort}（随部署进程生命周期，退出时自动清理）`);
      // 自验（D14c）：经回落隧道探测 VM /health —— 证明 ③ 不只是「进程起来了」，而是**真的打通**。
      const fwdOk = await probeTunnelHttp(cfg.tunnelLocalPort);
      log(`   ${fwdOk ? '✅' : '⚠️'} 回落隧道${fwdOk ? '已打通 /health（VM 服务可达，回落有效）' : '已建立但暂未探通 /health（HEALTH 相位将继续验证）'}`);
      return { ok: true, reused: false, pid: null, elapsedMs: 0, handle };
    } catch (e) {
      log(`   ❌ ssh2 隧道启动失败：${e.message}`);
      return { ok: false, reused: false, pid: null, elapsedMs: 0 };
    }
  }
  // —— 默认：系统 ssh 子进程（Windows / macOS 不变）——
  // 隧道后台常驻，不阻塞。注意：detached 子进程 spawn 成功 ≠ SSH 已连上，
  // 故此处只报告「进程已启动」，连通性交由下方 [HEALTH] 阶段用 curl 实际验证。
  try {
    const child = spawn('ssh', [
      '-N', '-L', `${cfg.tunnelLocalPort}:127.0.0.1:${cfg.tunnelRemotePort}`,
      '-p', String(cfg.vmSshPort), `${cfg.vmUser}@${cfg.vmHost}`,
    ], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    log(`   ⏳ 隧道进程已在后台启动（PID ${child.pid}）；本地 127.0.0.1:${cfg.tunnelLocalPort} → VM:${cfg.tunnelRemotePort} 的连通性由 [HEALTH] 阶段验证`);
    return { ok: true, reused: false, pid: child.pid ?? null, elapsedMs: 0 };
  } catch (e) {
    log(`   ❌ 隧道启动失败：${e.message}`);
    return { ok: false, reused: false, pid: null, elapsedMs: 0 };
  }
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

/**
 * 轮询 VM 本机 127.0.0.1:<port> 是否已进入监听态（经 SSH 在 VM 内探测，
 * 不依赖本地 SSH 隧道，故可在 VM-START 阶段直接使用）。
 * 最长等待 timeoutMs；返回 true 表示端口已监听。
 * 注意：schtasks /run 受任务 XML 的 MultipleInstancesPolicy=StopExisting 约束，
 * 若已有实例在监听，schtasks /run 会立即变空操作，本函数随即返回 true。
 * 探测实现（run2 取证后更换）：原用 Test-NetConnection —— 本机 CIM 慢时单次 15s+
 * 且出现过「服务明明在听却返回 False」的假阴性；改用 `netstat -ano | findstr`（原生
 * exe、毫秒级、无 CIM 依赖），远端 bash 管道转发结果，无内联 PowerShell（铁律）。
 */
async function waitForRemotePort(cfg, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await run('ssh', [
      '-p', String(cfg.vmSshPort),
      '-o', `ConnectTimeout=8`,
      `${cfg.vmUser}@${cfg.vmHost}`,
      `netstat -ano | findstr ":${cfg.servicePort}" | findstr "LISTENING"`,
    ], { timeoutMs: 15_000 });
    if (r.ok && r.out.includes('LISTENING')) return true;
    if (Date.now() >= deadline) return false;
    await sleep(2000);
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
  const skipBuild = args.includes('--skip-build');
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

  const cfg = resolveConfig(env, { apply, skipBuild });
  const isUninstall = args.includes('--uninstall');
  const plan = isUninstall ? buildUninstallPlan(cfg) : buildPlan(cfg);

  /* ---- 单边部署开关（CL-020 迭代④）----
   * --only-host / --only-vm 让「双端各自的部署」可在鸿蒙宿主侧一键独立完成：
   *   · --only-host → 仅 BUILD + HOST（install-host.mjs）+ TEST；
   *   · --only-vm   → 仅 BUILD + VM（scp→ssh install-vm.mjs）+ VM-START + QA-PROBE。
   * 与 --phase 互斥（--phase 优先）；卸载不区分单边（整项目移除）。 */
  // 单相位执行（--phase QA-PROBE / --phase=QA-PROBE）：从计划中只保留指定相位。
  // 用途：已部署机器上单独补跑/重跑某一相位（如仅重推 QA 探针），避免整条 --apply 重跑
  // 触发 VM-START 服务重启等重副作用。大小写不敏感；名字不匹配时立即报错退出，防呆。
  // ⚠ 必须先于 --only-host/--only-vm 解析：后者需据 phaseFilter 判互斥（--phase 优先），
  //   若把 phaseFilter 声明放在其后，会因 TDZ（let 先使用后声明）抛 ReferenceError。
  const phaseFlagIdx = args.findIndex((a) => a === '--phase' || a.startsWith('--phase='));
  let phaseFilter = '';
  if (phaseFlagIdx >= 0) {
    const flag = args[phaseFlagIdx];
    const inlineVal = flag.startsWith('--phase=') ? flag.slice('--phase='.length) : '';
    phaseFilter = (inlineVal || args[phaseFlagIdx + 1] || '').trim().toUpperCase();
  }

  const onlyHost = args.includes('--only-host');
  const onlyVm = args.includes('--only-vm');
  // 单边保留集（与 --phase 互斥，--phase 优先）：仅保留 BUILD + 对应侧相位，
  // 使「计划预览」与「实际执行」都只含该侧步骤（而非仅把其它相位标记为不执行）。
  const onlyKeep = (onlyHost || onlyVm) && !isUninstall && !phaseFilter
    ? (onlyHost
        ? new Set(cfg.skipBuild ? ['HOST', 'TEST'] : ['BUILD', 'HOST', 'TEST'])
        : new Set(cfg.skipBuild ? ['VM', 'VM-START', 'QA-PROBE'] : ['BUILD', 'VM', 'VM-START', 'QA-PROBE']))
    : null;
  const modeTag = onlyHost ? '仅宿主侧' : onlyVm ? '仅 VM 侧' : '双端';

  const filteredPlan = phaseFilter
    ? plan.filter((s) => s.phase === phaseFilter)
    : onlyKeep
      ? plan.filter((s) => onlyKeep.has(s.phase))
      : plan;
  if (phaseFilter && filteredPlan.length === 0) {
    log(`错误：--phase=${phaseFilter} 不在${isUninstall ? '卸载' : '部署'}计划中。可用相位：${plan.map((s) => s.phase).join(', ')}`);
    process.exitCode = 1;
    return;
  }
  const execPlan = filteredPlan;

  log('');
  log('══════════════════════════════════════════════════════════════');
  log(` WinVM Bridge ${isUninstall ? '卸载' : '部署'}（${modeTag}）  [${cfg.dryRun ? 'DRY-RUN 只规划' : 'APPLY 真执行'}]`);
  log(` VM provider 选型：${cfg.vmProvider}`);
  log('══════════════════════════════════════════════════════════════');
  log(`【计划预览】以下为将执行的步骤（仅展示，尚未执行）：${phaseFilter ? `（--phase=${phaseFilter}：仅此相位）` : (onlyHost || onlyVm ? `（单边：${modeTag}）` : '（双端全程）')}`);
  for (const s of execPlan) {
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
  let activeTunnel = null;
  // 逐相位计时（run2 报告用）：在下一相位开始时结算上一相位的耗时
  let prevPhase = null;
  let prevPhaseStart = 0;
  const flushPhaseTime = () => {
    if (prevPhase) log(`[计时] [${prevPhase}] 耗时 ${((Date.now() - prevPhaseStart) / 1000).toFixed(1)}s`);
    prevPhase = null;
  };
  for (const s of execPlan) {
    if (!s.apply) {
      log(`\n[${s.phase}] 跳过（无需执行）：${s.description}`);
      continue;
    }
    flushPhaseTime();
    prevPhase = s.phase;
    prevPhaseStart = Date.now();
    log(`\n[${s.phase}] 执行：${s.description}`);
    log(`   $ ${s.command}`);
    if (s.phase === 'TUNNEL') {
      // D14：daemon-aware 幂等 —— 先复用已在线隧道，否则经 `winvm-plugin tunnel ensure`
      // 由常驻 daemon 拉起；仅当 ensure 不可用/失败才回落自建（详见 runTunnelPhase）。
      const res = await runTunnelPhase(cfg);
      if (res.handle) activeTunnel = res.handle;
      if (!res.ok) failed++;
      continue;
    }
    if (s.phase === 'VM-UNINSTALL') {
      // 不再预检可达性（reachable 探测曾出现「实测可达却被判不可达」的假阴性，导致整体跳过）。
      // 直接尝试真实卸载；SSH 不通时 deployVmUninstall 会返回真实错误，便于定位。
      const r = await deployVmUninstall(cfg);
      if (!r.ok) {
        log(`   ❌ VM 卸载失败（${r.out.slice(0, 400)}）：可在 VM 内手动运行 install-vm.mjs --uninstall --yes`);
        failed++;
      } else {
        log('   ✅ VM 卸载完成（任务移除 + 软链/共享 Skills/生成目录移入 VM 内可恢复目录 .uninstall-trash/<时间戳>/，非 Windows 回收站；源码与 dist 保留）');
      }
      continue;
    }
    if (s.phase === 'VM') {
      // 不再预检可达性：直接尝试真实部署，SSH 不通时返回真实错误而非静默跳过。
      const r = await deployVm(cfg);
      if (!r.ok) {
        // 失败时打印输出**尾部**（install-vm 的 [t+Xs] 逐步计时打点在末尾，尾部才是定位信息）
        log(`   ❌ VM 部署失败（输出尾部 2000 字）：\n${r.out.slice(-2000)}`);
        log('   可在 VM 上回查 C:/WinVMBridge/install-vm-run.log（tee 持久化，超时截断也可查）');
        failed++;
      } else {
        log('   ✅ VM 部署完成（产物 + skills 技能规范已分发，已注册自启并自检）');
      }
      continue;
    }
    if (s.phase === 'VM-START') {
      // 不再预检可达性：直接尝试重启。远端 PowerShell 逻辑一律 .ps1 推送（铁律：勿内联，
      // MSYS 会破坏 $p/$_ 与 /End 等参数）。预算 120s；失败重试 1 次（首跑曾与残留的
      // install-vm 远程会话碰撞导致超时，重试可吸收此类瞬态）。
      let r = await runRemotePs1(cfg, buildVmStartPs1(cfg), { timeoutMs: 120_000, log });
      if (!r.ok || !r.out.includes('VM_START_TRIGGERED')) {
        log('   ⚠️ VM-START 首次尝试未确认成功，5 秒后重试 1 次...');
        await sleep(5000);
        r = await runRemotePs1(cfg, buildVmStartPs1(cfg), { timeoutMs: 120_000, log });
      }
      if (!r.ok || !r.out.includes('VM_START_TRIGGERED')) {
        log(`   ❌ VM 服务启动触发失败（${r.out.slice(0, 300)}）：可在 VM 内手动 schtasks /run /tn ${SERVICE_TASK_NAME}。部署继续，/health 将再次验证。`);
        failed++;
        continue;
      }
      log(`   VM 服务已触发重启（kill 残留 → schtasks /run /tn ${SERVICE_TASK_NAME}），等待端口监听（最长 420s）...`);
      const up = await waitForRemotePort(cfg, 420_000);
      if (up) {
        log(`   ✅ VM 服务已监听 127.0.0.1:${cfg.servicePort}（启动完成）`);
      } else {
        log(`   ⚠️ 420s 内未监听到端口。/health 阶段会再次验证；可手动在 VM 内 schtasks /run /tn ${SERVICE_TASK_NAME} 后重跑本步。`);
      }
      continue;
    }

    if (s.phase === 'QA-PROBE') {
      // QA 验收夹具随装分发（铁律不涉及：纯 scp 文件传输，无远端 PowerShell 逻辑）。
      // 缺失/失败一律 WARN 不阻断 —— QA 夹具属开发/验收工具，非运行时依赖；
      // 失败时的补救命令已打印，可事后手工补推。
      const r = await deployQaProbes(cfg, log);
      if (r.pushed.length === 0 && r.missing.length === QA_PROBE_FILES.length) {
        log(`   ⚠️ 未找到任何 QA 探针夹具（${QA_PROBE_FILES.join(', ')} 均不在 qa/probes/）——跳过（不阻断）。`);
        log('      影响：新机器上 node qa/probes/qa-verify.mjs 的 A1/A3/A11 会因探针不在 VM 而失败；补推后即可。');
      } else if (!r.ok) {
        log(`   ⚠️ QA 探针推送部分失败（不阻断）：\n${r.out}`);
      } else {
        log(`   ✅ 已推送 ${r.pushed.length}/${QA_PROBE_FILES.length} 个探针 → ${cfg.vmDeployDir}/${VM_DEVQA_DIR}/probes${r.missing.length ? `（缺失仅 WARN：${r.missing.join(', ')}）` : ''}`);
      }
      // 部署收尾 MANIFEST（防膨胀规则：留痕本次落盘的过程文件；失败不阻断）
      if (!r.missing.length && !cfg.dryRun) {
        const mf = await writeDeployManifest(cfg, log);
        if (mf.ok) log(`   ✅ 部署 MANIFEST 已写入 ${mf.manifestPath}`);
      }
      continue;
    }

    if (s.phase === 'HEALTH') {
      // 两段式：
      //  (a) 传输级重试（2s × 3）——吸收「端口刚监听、HTTP 尚未完全就绪」的微小间隙（curl 本身失败）；
      //  (b) D15 载荷级退避重探 —— curl 成功但载荷判为 `unknown`（冷启期探针超时/target 未就绪）时
      //      **不得当终态立即跳出**，退避复探直到 verdict 明确或预算耗尽。
      const parseHealth = (s) => { try { return JSON.parse(String(s).trim()); } catch { return undefined; } };
      const HEALTH_BACKOFF_MS = 10_000;
      const HEALTH_BACKOFF_TRIES = 6; // 10s × ≤6
      const HEALTH_BUDGET_MS = 90_000; // 载荷级重探总预算

      // (a) 传输级重试
      let got = false;
      let lastOut = '';
      for (let attempt = 1; attempt <= 4; attempt++) {
        const hr = await run('curl', ['-s', '--noproxy', '127.0.0.1', '--max-time', '30', `http://127.0.0.1:${cfg.tunnelLocalPort}/health`], { timeoutMs: 40_000 });
        lastOut = hr.out ?? '';
        if (hr.ok && lastOut.trim()) { got = true; break; }
        if (attempt < 4) { log(`   /health 第 ${attempt} 次未通，3 秒后重试...`); await sleep(3000); }
      }

      if (!got) {
        log(`   ❌ /health 未返回（已重试 3 次）：${lastOut.slice(0, 400)}`);
        // 失败归因：区分「本地隧道端口根本没监听」与「端口通但 HTTP 无响应」
        const portOpen = await checkTcpOpen(cfg.tunnelLocalPort);
        if (!portOpen) {
          log(`   诊断：本地 127.0.0.1:${cfg.tunnelLocalPort} 未监听 → TUNNEL 相位未建立成功或已退出（先解决 TUNNEL）。`);
        } else {
          log('   诊断：端口已监听但 HTTP 无响应 → VM 侧服务未运行（schtasks /run 未生效）或「隧道黑洞」（TCP 通但转发断，VM 掉线时假活）。');
          log('   处置：VM 内手动 schtasks /run /tn ' + SERVICE_TASK_NAME + '；隧道黑洞则杀宿主侧 ssh/隧道进程后重建（tools/README 坑 4）。');
        }
        failed++;
        continue;
      }

      // (b) D15 载荷级退避重探：verdict 未明确（unknown）则复探，避免把冷启瞬态当终态误报。
      const probeT0 = Date.now();
      let verdict = interpretHealth(parseHealth(lastOut));
      let reprobes = 0;
      while (
        verdict.vet === 'unknown' &&
        reprobes < HEALTH_BACKOFF_TRIES &&
        Date.now() - probeT0 < HEALTH_BUDGET_MS
      ) {
        log(`   ⏳ /health 结论未知（${verdict.reason}）→ ${HEALTH_BACKOFF_MS / 1000}s 后复探（${reprobes + 1}/${HEALTH_BACKOFF_TRIES}）...`);
        await sleep(HEALTH_BACKOFF_MS);
        const hr = await run('curl', ['-s', '--noproxy', '127.0.0.1', '--max-time', '30', `http://127.0.0.1:${cfg.tunnelLocalPort}/health`], { timeoutMs: 40_000 });
        lastOut = hr.out ?? '';
        verdict = interpretHealth(parseHealth(lastOut));
        reprobes++;
      }
      const budgetExhausted = verdict.vet === 'unknown' && Date.now() - probeT0 >= HEALTH_BUDGET_MS;

      log('   ✅ /health 通过');
      if (lastOut.trim()) log(`   ${lastOut.trim().slice(0, 600)}`);

      if (verdict.vet === 'gui-ok') {
        log('   ✅ 会话健康且为交互式（session.state=healthy / interactive=true）→ GUI 能力可用。');
      } else if (verdict.vet === 'gui-degraded') {
        // 仅**确证**非交互时保留补救块。
        guiDegraded = true;
        log('');
        log('   ⚠️ 服务运行在【非交互式/降级会话】→ GUI 能力（截图/键鼠/UIA/窗口/剪贴板）不可用。');
        log('      MCP/A2A 双通道与全部 54 项能力正常（exposed=54）；仅 gui.* 被门禁。');
        log('      根因：服务任务用 <LogonType>InteractiveToken</LogonType>，其落点永远是「当前交互式会话」');
        log('            （与你在哪个 PowerShell 敲命令无关），而 Get-SessionHealth 检测的是服务进程自身所在会话的状态：');
        log(`            sessionId=${verdict.sessionId ?? '未知'} windowStation=${verdict.windowStation ?? '未知'} interactive=${verdict.interactive ?? '未知'} locked=${verdict.locked ?? '未知'}`);
        log('            只要该交互式会话处于【锁屏（LogonUI 在跑）/ Explorer 未运行 / 非 WinSta0】，即为 degraded。');
        log('      💡 启用 GUI（务必按顺序）：');
        log('         1) 先从 RDP 解锁/登录 VM 桌面，确认无锁屏、Explorer 在跑；');
        log('         2) 在 VM 桌面内的【普通用户（非管理员）PowerShell】执行以下命令（管理员 PowerShell 会令任务落到不同登录会话→仍 degraded）：');
        for (const line of GUI_RESTART_COMMAND) log(`            ${line}`);
        log('         3) 执行后刷新 /health，应见 session.interactive=true、GUI 可用。');
      } else {
        // unknown：**不许**断言非交互、**不许**打印「💡 启用 GUI」命令块、**不置** guiDegraded。
        log('');
        log(`   ⚠️ 会话状态【结论未知】（${verdict.reason}）。`);
        log(`      ${budgetExhausted ? `已退避复探 ${reprobes} 次、预算 ${HEALTH_BUDGET_MS / 1000}s 耗尽仍未知。` : `已复探 ${reprobes} 次。`}`);
        log('      探针在本次超时窗口内未返回，**不代表** GUI 不可用 —— 冷启动/繁忙期常见，属瞬态。');
        log('      故未断言非交互、亦未给出人工补救命令（避免误报与误导）。建议稍后复探：');
        log(`        node delivery/winvm-plugin.mjs health   # 或刷新 http://127.0.0.1:${cfg.tunnelLocalPort}/health`);
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
  flushPhaseTime();

  // 相位耗时汇总（一眼看全七相位）
  log('');
  if (activeTunnel) {
    try {
      await activeTunnel.stop();
      log('隧道已随部署结束关闭（端口释放）');
    } catch {
      /* 退出时模块自带清理兜底 */
    }
  }
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

// 仅导出未使用 inline `export` 声明的名字；其余已在声明处 inline export。
export { main, deployQaProbes, waitForRemotePort, writeDeployManifest };

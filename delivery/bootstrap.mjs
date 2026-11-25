#!/usr/bin/env node
/**
 * WinVM Bridge bootstrap.mjs -- Phase-0 one-shot entry (runs BEFORE setup.mjs).
 *
 * Subcommands:
 *   check  Extended dependency self-check (host + VM reachability + VM node/CLI probe).
 *          Never modifies the system: safe to run at any time.
 *   trust  Guide SSH public-key passwordless login:
 *          - create ~/.ssh/id_ed25519 (ssh-keygen -N "") if missing;
 *          - append the .pub key into the VM's authorized_keys via ONE password login;
 *          - ALSO append into C:/ProgramData/ssh/administrators_authorized_keys and fix
 *            its ACL with icacls, because Windows OpenSSH IGNORES per-user authorized_keys
 *            for users in the Administrators group (well-known pitfall) and requires
 *            that file to be owned/readable only by SYSTEM + Administrators.
 *   env    Interactive (or parameter-driven) generation of the project-root .env from
 *          delivery/env.example. An existing .env is backed up first (.env.winvm-bak.<ts>).
 *   all    check -> trust -> env -> spawn `node delivery/setup.mjs` (default dry-run).
 *          SECURITY RED LINE: bootstrap NEVER passes --apply; the user must run
 *          `node delivery/setup.mjs --apply` explicitly after reviewing the dry-run plan.
 *
 * Hard constraints honored here:
 *   - ASCII-only source, no BOM, node: builtins first, pure ESM (.mjs).
 *   - process.platform === 'ohos' -> nvm detection is SKIPPED (HarmonyOS WorkBuddy
 *     desktop ships its own node; nvm does not apply on the HMOS host).
 *   - setup.mjs / preflight.mjs behavior is untouched (imported and reused only).
 *   - python is reported as "not required (Node-only pipeline)" - informational only.
 *
 * Exit codes: 0 = all blocking checks passed; 1 = at least one blocking check failed.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import readline from 'node:readline/promises';

// Reuse existing delivery modules (no behavior change to them).
import { parseEnv, loadEnvFile, resolveConfig, runRemotePs1 } from './setup.mjs';
import { checkHostDeps, printChecks, evaluateAgentLogin } from './preflight.mjs';
// 迭代21 / D-2：VM SSH 后端三级开关（零依赖纯逻辑，静态导入；ssh2-client 动态按需导入）
import { resolveSshBackend, resolveVmKeyPath } from './ssh2-backend.mjs';
// Phase 3 批2 · P0-2：prepare-vm 纯逻辑（探测/应用 .ps1 生成 + 计划解析），SSH 通道复用本文件既有模式。
import {
  buildPrepareVmProbePs1,
  buildPrepareVmApplyPs1,
  parsePrepareVmProbe,
  planPrepareVm,
} from './prepare-vm.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const ENV_TEMPLATE = join(__dirname, 'env.example');
const ROOT_ENV = join(ROOT, '.env');
const SETUP_ENTRY = join(__dirname, 'setup.mjs');

const HOST_TOOLS = ['ssh', 'scp', 'tar', 'curl'];
// HarmonyOS reports either 'ohos' (spec) or 'openharmony' (observed on real HMOS host,
// Node v24.13.0). Both mean "HarmonyOS host": skip nvm probes there.
const IS_OHOS = process.platform === 'ohos' || process.platform === 'openharmony';

/* ----------------------------- small helpers ----------------------------- */

function log(msg) {
  process.stdout.write(String(msg) + '\n');
}

function hr(title) {
  log('');
  log('============================================================');
  log(' ' + title);
  log('============================================================');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Locate a command on PATH.
 * Strategy: `which <cmd>` first (POSIX/HMOS sandbox), then a direct
 * `<cmd> --version` fallback so Windows-ish environments still resolve.
 * @param {string} cmd
 * @returns {{ok: boolean, detail: string}}
 */
function whichSync(cmd) {
  try {
    const w = spawnSync('which', [cmd], { encoding: 'utf8' });
    if (w.status === 0 && String(w.stdout || '').trim()) {
      return { ok: true, detail: String(w.stdout).trim().split(/\r?\n/)[0] };
    }
  } catch {
    /* fall through to direct probe */
  }
  try {
    const v = spawnSync(cmd, ['--version'], { encoding: 'utf8', timeout: 10_000 });
    if (v.status === 0) return { ok: true, detail: 'found on PATH (--version ok)' };
  } catch {
    /* not found */
  }
  return { ok: false, detail: 'not found on PATH' };
}

/**
 * TCP reachability probe (no side effects, pure connect + close).
 * @param {string} host
 * @param {number} port
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
function tcpProbe(host, port, timeoutMs = 4000) {
  return new Promise((res) => {
    const sock = net.connect({ host, port });
    const done = (ok) => {
      try { sock.destroy(); } catch { /* noop */ }
      res(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    sock.once('connect', () => { clearTimeout(timer); done(true); });
    sock.once('error', () => { clearTimeout(timer); done(false); });
  });
}

/**
 * Load deployment env: project-root .env when present, else the template
 * (delivery/env.example). Returns which file was used.
 * @returns {{ env: Record<string,string>, source: string, isFallback: boolean }}
 */
function loadEnvOrTemplate() {
  if (existsSync(ROOT_ENV)) {
    return { env: loadEnvFile(ROOT_ENV), source: ROOT_ENV, isFallback: false };
  }
  if (existsSync(ENV_TEMPLATE)) {
    return { env: loadEnvFile(ENV_TEMPLATE), source: ENV_TEMPLATE, isFallback: true };
  }
  return { env: {}, source: '(none)', isFallback: true };
}

/**
 * Run one SSH command remotely. BatchMode=yes so a missing key fails fast
 * instead of hanging on a password prompt; stderr is captured but MSYS/Git-Bash
 * noise on the remote side is tolerated (verdict is based on exit code +
 * output regex, never on stderr alone).
 *
 * 迭代21 / D-2 ssh2 化：capture 形态走「ssh2 优先（auto）/ 二进制兜底」双后端
 * （ssh2-client.runVmOp 装配；连接级失败才落二进制，远端非零码=业务真值不回落）。
 * interactive 形态（trust 首次密码登录）需要人类 tty 输入，**无法 ssh2 化**：
 * auto/key 下保持二进制（裁定）；显式 WINVM_SSH_BACKEND=ssh2 时该路径报错并引导
 * 临时 `WINVM_SSH_BACKEND=key` 使用。返回形态与旧实现一致（消费方零改动），
 * 由 sync 变 async（全部调用点已 await）。
 * @param {string[]} sshArgs extra args after the base options
 * @param {{timeoutMs?: number, interactive?: boolean, backend?: string}} [opts]
 * @returns {Promise<{ok: boolean, code: number, out: string, err: string}>}
 */
/**
 * Cross-shell PowerShell one-liner over ssh (R8 fix): the script is base64-encoded as
 * UTF-16LE and passed as a SINGLE `-EncodedCommand` token, so it survives cmd.exe /
 * Git-Bash / pwsh default shells alike (no quoting/expansion ever reaches the remote shell).
 * @returns {Promise<{ok:boolean, code:number, out:string, err:string}>}
 */
async function runSshPs(targetArgs, script, opts = {}) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return runSsh([...targetArgs, `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`], opts);
}

/** ssh2-client 动态装载（失败=null：auto 落二进制；显式 ssh2 后端则报错引导）。 */
let bootstrapSsh2Mod; // undefined=未探测 | null=不可用 | module
async function getSsh2Mod() {
  if (bootstrapSsh2Mod === undefined) {
    try {
      bootstrapSsh2Mod = await import('./ssh2-client.mjs');
    } catch {
      bootstrapSsh2Mod = null;
    }
  }
  return bootstrapSsh2Mod;
}

/** 解析本文件 ssh 参数形态 ['-p',port,'user@host',remoteCmd...] → 连接要素；不符形态返回 null（走二进制）。 */
function parseSshTargetArgs(sshArgs) {
  const iP = sshArgs.indexOf('-p');
  if (iP < 0) return null;
  const port = Number(sshArgs[iP + 1]);
  const target = String(sshArgs[iP + 2] || '');
  const cmdParts = sshArgs.slice(iP + 3);
  const at = target.lastIndexOf('@');
  if (!Number.isInteger(port) || port <= 0 || at <= 0 || cmdParts.length === 0) return null;
  return { port, user: target.slice(0, at), host: target.slice(at + 1), cmd: cmdParts.join(' ') };
}

/** 二进制原路径（保留原样：BatchMode + ConnectTimeout=8 + 有界 timeout）。 */
function runSshBinary(args, opts) {
  const r = spawnSync('ssh', args, { encoding: 'utf8', timeout: opts.timeoutMs ?? 30_000 });
  return {
    ok: r.status === 0,
    code: r.status ?? -1,
    out: String(r.stdout || ''),
    err: String(r.stderr || ''),
  };
}

async function runSsh(sshArgs, opts = {}) {
  const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', ...sshArgs];
  const backend = opts.backend || resolveSshBackend(process.env);
  if (opts.interactive) {
    // One password login: inherit stdio so the user can type the password.
    // 交互 tty 无法 ssh2 化（D-2 裁定）：auto/key 保持二进制；显式 ssh2 后端=报错引导。
    if (backend === 'ssh2') {
      log(' [ABORT] backend=ssh2 无法执行交互式密码登录（tty 不支持）。');
      log('         临时改用二进制后端：WINVM_SSH_BACKEND=key node delivery/bootstrap.mjs trust');
      return { ok: false, code: -1, out: '', err: 'interactive trust path requires key backend' };
    }
    const r = spawnSync('ssh', args, { stdio: 'inherit' });
    return { ok: r.status === 0, code: r.status ?? -1, out: '', err: '' };
  }
  const parsed = parseSshTargetArgs(sshArgs);
  if (backend !== 'key' && parsed) {
    const mod = await getSsh2Mod();
    if (!mod) {
      if (backend === 'ssh2') {
        log(' [ABORT] 要求 ssh2 后端但 ssh2-client 不可达 → 临时 WINVM_SSH_BACKEND=key 使用');
        return { ok: false, code: -1, out: '', err: 'ssh2 backend unavailable' };
      }
      return runSshBinary(args, opts);
    }
    try {
      const res = await mod.runVmOp({
        backend,
        host: parsed.host,
        port: parsed.port,
        user: parsed.user,
        privateKeyPath: resolveVmKeyPath(),
        password: process.env['WINVM_VM_PASSWORD'] || process.env['WINVM_SSH_PASSWORD'] || '',
        timeoutMs: opts.timeoutMs ?? 30_000,
        op: (runner) => runner.exec(parsed.cmd, { timeoutMs: opts.timeoutMs ?? 30_000 }),
        binary: () => Promise.resolve(runSshBinary(args, opts)),
        onFallback: (e) => log(' [ssh2→binary] auto 回落二进制一发：' + mod.briefError(e)),
      });
      // 双后端结果契约对齐旧 {ok,code,out,err}：
      //  - ssh2 路径：stdout/stderr 由 mapRunnerResult 分流 → out=concat、err=stderr；
      //  - 二进制路径：runSshBinary 原形态（out/stderr 字段在场时优先取）。
      return {
        ok: res.ok,
        code: res.code,
        out: res.stdout != null ? res.stdout : String(res.out ?? ''),
        err: res.stderr != null ? res.stderr : String(res.err ?? ''),
      };
    } catch (e) {
      // 显式 ssh2 后端的连接级失败=单条探测如实降级（旧二进制语义：BatchMode 失败 fast-fail，
      // 不炸整条 check 流水线）；auto 的理论不可达分支不会到这里。
      if (backend === 'ssh2') {
        return { ok: false, code: -1, out: '', err: mod.briefError(e) };
      }
      throw e;
    }
  }
  return runSshBinary(args, opts);
}

/** First semver-ish token found in a blob, or ''. */
function firstVersion(blob) {
  const m = String(blob).match(/v?(\d+\.\d+(?:\.\d+)?)/);
  return m ? m[1] : '';
}

/* ----------------------------- cmd: check ----------------------------- */

/**
 * `check`: extended dependency self-check. Purely observational.
 * @returns {Promise<boolean>} true when no blocking failure
 */
async function cmdCheck() {
  hr('WinVM Bridge bootstrap check (phase-0, read-only)');
  let blocking = 0;

  // 1) Host baseline: reuse preflight.checkHostDeps (workbuddy home + node >= 18).
  const host = checkHostDeps();
  log('[1/5] Host baseline (delivery/preflight.mjs checkHostDeps)');
  log(printChecks(host, { headline: '' }));
  if (!host.ok) blocking += host.checks.filter((c) => c.blocking && !c.ok).length;

  // 2) nvm note: skipped on HarmonyOS by design.
  log('');
  log('[2/5] Node version manager (nvm)');
  if (IS_OHOS) {
    log('  [SKIP] platform=ohos: nvm probe skipped by design. HarmonyOS WorkBuddy desktop');
    log('         ships its own node (v24.x bundled); installing nvm on the HMOS host is');
    log('         NOT applicable and NOT required.');
  } else {
    log('  [INFO] platform=' + process.platform + ': nvm not required by this project.');
    log('         Any node >= 18 works (WorkBuddy desktop bundles one).');
  }

  // 3) Host CLI tools used by setup.mjs VM phases (scp/ssh/tar/curl spawn).
  log('');
  log('[3/5] Host CLI tools (spawned by setup.mjs VM / VM-START / HEALTH phases)');
  for (const t of HOST_TOOLS) {
    const r = whichSync(t);
    log('  [' + (r.ok ? 'OK' : 'MISSING') + '] ' + t + ' -> ' + r.detail);
    if (!r.ok) {
      log('         Next step: install/expose "' + t + '" on PATH. HMOS sandbox ships');
      log('         /usr/bin/ssh, /usr/bin/scp, /bin/tar, /usr/bin/curl (verified in');
      log('         docs/01-investigation/oh-host-install-run-test.md section 0); if missing here the');
      log('         sandbox policy changed - re-check the WorkBuddy build.');
      blocking++;
    }
  }

  // 4) python: explicitly NOT required.
  log('');
  log('[4/5] python');
  const py = whichSync('python3') .ok || whichSync('python').ok;
  log('  [' + (py ? 'FOUND' : 'ABSENT') + '] python is NOT required by this project');
  log('         (the whole pipeline is Node-only: setup/install/tunnel are all .mjs).');
  log('         No action needed either way.');

  // 5) VM reachability + VM-side node / agent CLI probes over SSH.
  log('');
  log('[5/5] VM reachability and VM-side runtime');
  const { env, source, isFallback } = loadEnvOrTemplate();
  log('  env source: ' + source + (isFallback ? '  (fallback; run `env` subcommand to write a real .env)' : ''));
  const cfg = resolveConfig(env, { apply: false });

  if (!cfg.vmHost || !cfg.vmUser) {
    log('  [SKIP] VM_HOST / VM_USER not configured -> VM probes skipped.');
    log('         Next step: run `node delivery/bootstrap.mjs env` to generate .env,');
    log('         then re-run this check.');
  } else {
    const alive = await tcpProbe(cfg.vmHost, cfg.vmSshPort, 4000);
    log('  [' + (alive ? 'OK' : 'FAIL') + '] TCP ' + cfg.vmHost + ':' + cfg.vmSshPort +
        (alive ? ' reachable' : ' unreachable'));
    if (!alive) {
      log('         Next step: start the Windows VM, and inside it enable OpenSSH Server');
      log('         (Settings -> Optional Features -> OpenSSH Server) + allow TCP 22 in');
      log('         the firewall. See docs/INSTALL-GUIDE.md section 1.');
      blocking++;
    } else {
      // VM node probe: `where node` (task-mandated) + `node -v` for the version.
      const whereNode = await runSsh(['-p', String(cfg.vmSshPort), cfg.vmUser + '@' + cfg.vmHost, 'where node'], { timeoutMs: 25_000, backend: cfg.vmSshBackend });
      const nodeVer = await runSsh(['-p', String(cfg.vmSshPort), cfg.vmUser + '@' + cfg.vmHost, 'node -v'], { timeoutMs: 25_000, backend: cfg.vmSshBackend });
      const nodeOk = whereNode.ok || nodeVer.ok;
      const vStr = firstVersion(nodeVer.out);
      log('  [' + (nodeOk ? 'OK' : 'FAIL') + '] VM node' +
          (nodeOk ? ' found' + (vStr ? ' (v' + vStr + ')' : '') : ' NOT found') +
          '   [probe: where node / node -v via ssh, MSYS noise tolerated]');
      if (!nodeOk) {
        log('         Next step: install Node.js >= 18 (with npm) inside the Windows VM and');
        log('         ensure it is on the SYSTEM PATH (not only the interactive user PATH).');
        log('         See docs/INSTALL-GUIDE.md section 1.');
        blocking++;
      }

      // VM agent CLI probe: non-blocking for workbuddy-deterministic.
      const isDeterministic = cfg.vmProvider === 'workbuddy-deterministic';
      const cb = await runSsh(['-p', String(cfg.vmSshPort), cfg.vmUser + '@' + cfg.vmHost, cfg.workbuddyCli + ' --version'], { timeoutMs: 25_000, backend: cfg.vmSshBackend });
      const cbVer = firstVersion(cb.out);
      if (cb.ok) {
        log('  [OK] VM agent CLI "' + cfg.workbuddyCli + '"' + (cbVer ? ' (v' + cbVer + ')' : '') +
            '  provider=' + cfg.vmProvider);
      } else {
        const tag = isDeterministic ? 'WARN' : 'FAIL';
        log('  [' + tag + '] VM agent CLI "' + cfg.workbuddyCli + '" not reachable via ssh ' +
            '(provider=' + cfg.vmProvider + ')');
        if (isDeterministic) {
          log('         INFO: workbuddy-deterministic never spawns the CLI at runtime, so this');
          log('         is a warning only (same policy as delivery/preflight.mjs).');
          log('         To use provider=workbuddy later: install CodeBuddy Code inside the VM');
          log('         (npm install -g @tencent-ai/codebuddy-code, Node >= 18.20; see');
          log('         codebuddy.cn/docs/cli/installation) and run `codebuddy` once to log in.');
        } else {
          log('         Next step: install CodeBuddy Code inside the VM and log in');
          log('         (`npm install -g @tencent-ai/codebuddy-code` then run `codebuddy`), or');
          log('         set WINVM_VM_PROVIDER=workbuddy-deterministic in .env.');
          blocking++;
        }
      }

      // DB-4（批2/D-1 勘误口径）：安装性已过（上方），这里补**登录态降级探测**。
      // 实测 codebuddy 无非交互身份命令 ⇒ 只判"配置根标记文件是否存在"，结论如实标注局限；
      // provider=workbuddy ∧ 登录态未证实 ⇒ 红字播报「当前确定性可用；切 LLM 需 VM 内交互登录」。
      {
        // R8 fix: was bash `test -f … || test -f …` (cmd.exe 不认)。改跨壳 PS（EncodedCommand）。
        const mk = await runSshPs(
          ['-p', String(cfg.vmSshPort), cfg.vmUser + '@' + cfg.vmHost],
          "$d=Join-Path $env:USERPROFILE '.codebuddy'; $ok=((Test-Path (Join-Path $d 'settings.json')) -or (Test-Path (Join-Path $d 'user-state.json'))); Write-Output $ok; if(-not $ok){exit 1}",
          { timeoutMs: 15_000, backend: cfg.vmSshBackend },
        );
        const verdict = evaluateAgentLogin({
          provider: cfg.vmProvider,
          cliExists: cb.ok,
          configDirExists: mk.ok,
          markerFiles: [mk.ok],
        });
        if (verdict.verdict !== 'not-applicable') {
          log('  [LOGIN ' + verdict.verdict.toUpperCase().replace(/-/g, '_') + '] ' + verdict.detail);
          if (verdict.remedy && !isDeterministic) {
            log('         ↳ ' + verdict.remedy);
          }
        }
      }
    }
  }

  // Summary + next actions.
  hr('check summary');
  if (blocking === 0) {
    log(' ALL blocking checks passed. Suggested next actions:');
    log('   1) node delivery/bootstrap.mjs trust   (SSH passwordless setup; asks for the VM password once)');
    log('   2) node delivery/bootstrap.mjs env     (generate .env if not done yet)');
    log('   3) node delivery/bootstrap.mjs all     (check + trust + env + setup.mjs dry-run)');
    log('   4) node delivery/setup.mjs --apply     (REAL deployment; explicit opt-in only)');
    return true;
  }
  log(' ' + blocking + ' blocking check(s) failed. Fix the items marked FAIL above (each');
  log(' failure printed its own "Next step" line), then re-run this check.');
  return false;
}

/* ----------------------------- cmd: trust ----------------------------- */

/**
 * `trust`: SSH public-key passwordless bootstrap (ONE password login).
 * @returns {Promise<boolean>}
 */
async function cmdTrust() {
  hr('WinVM Bridge bootstrap trust (SSH passwordless setup)');
  const { env } = loadEnvOrTemplate();
  const cfg = resolveConfig(env, { apply: false });
  if (!cfg.vmHost || !cfg.vmUser) {
    log(' [ABORT] VM_HOST / VM_USER not configured. Next step: run `node delivery/bootstrap.mjs env` first.');
    return false;
  }
  const target = cfg.vmUser + '@' + cfg.vmHost;

  // 1) Ensure the key pair exists (create with empty passphrase when missing).
  const sshDir = join(homedir(), '.ssh');
  const keyPath = join(sshDir, 'id_ed25519');
  const pubPath = keyPath + '.pub';
  if (!existsSync(pubPath)) {
    log(' [1/3] No ' + pubPath + ' found -> generating a new ed25519 key (empty passphrase)...');
    const r = spawnSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', keyPath], { stdio: 'inherit' });
    if (r.status !== 0) {
      log(' [ABORT] ssh-keygen failed (exit ' + r.status + '). Next step: run');
      log('         ssh-keygen -t ed25519 -N "" -f ' + keyPath + ' manually, then retry.');
      return false;
    }
  } else {
    log(' [1/3] Key pair found: ' + keyPath);
  }
  const pubKey = readFileSync(pubPath, 'utf8').trim();
  if (!pubKey || /['\r\n]/.test(pubKey)) {
    log(' [ABORT] ' + pubPath + ' looks malformed (empty or contains quote/newline).');
    return false;
  }

  // 2) One password login: append the key into BOTH authorized_keys locations.
  //    - ~/.ssh/authorized_keys                      (standard users)
  //    - C:/ProgramData/ssh/administrators_authorized_keys (Administrators-group users;
  //      Windows OpenSSH ignores the per-user file for them - well-known pitfall -
  //      and requires this file's ACL to allow only SYSTEM + Administrators).
  //    R8 root-cause fix (2026-10-30): the OLD form was Git-Bash-only POSIX syntax
  //    (umask / mkdir -p / ~ / 2>/dev/null), which fails outright when the VM's sshd
  //    default shell is cmd.exe (the Windows OpenSSH factory default). Now the payload
  //    is PowerShell, delivered via `powershell -EncodedCommand` (base64 UTF-16LE):
  //    a SINGLE native-exe token + one arg = portable across cmd / bash / pwsh default
  //    shells, and base64 sidesteps every quoting/expansion trap (no $, no embedded
  //    quotes reaching the remote shell). Append is idempotent (dedupe before add).
  const psLines = [
    "$ErrorActionPreference='SilentlyContinue'",
    `$pub = '${pubKey.replace(/'/g, "''")}'`,
    '$dir = Join-Path $env:USERPROFILE \'.ssh\'',
    'New-Item -ItemType Directory -Force -Path $dir | Out-Null',
    '$ak = Join-Path $dir \'authorized_keys\'',
    'if (-not ((Test-Path $ak) -and ((Get-Content $ak -Raw) -match [regex]::Escape($pub))) ) { Add-Content -Path $ak -Value $pub }',
    '$pdir = \'C:\\ProgramData\\ssh\'',
    'New-Item -ItemType Directory -Force -Path $pdir | Out-Null',
    '$agak = Join-Path $pdir \'administrators_authorized_keys\'',
    'if (-not ((Test-Path $agak) -and ((Get-Content $agak -Raw) -match [regex]::Escape($pub))) ) { Add-Content -Path $agak -Value $pub }',
    'icacls $agak /inheritance:r /grant \'*S-1-5-18:F\' /grant \'*S-1-5-32-544:F\' | Out-Null',
    'Write-Output \'TRUST_DONE\'',
  ];
  const encoded = Buffer.from(psLines.join('\r\n'), 'utf16le').toString('base64');
  const remoteCmd = `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
  log(' [2/3] Appending the public key on ' + target + ' (you will be asked for the VM');
  log('       password ONCE; the key goes to ~/.ssh/authorized_keys AND to');
  log("       C:/ProgramData/ssh/administrators_authorized_keys with icacls ACL fix, so");
  log('       it works for standard users AND Administrators-group users):');
  const put = await runSsh(['-p', String(cfg.vmSshPort), target, remoteCmd], { interactive: true, backend: cfg.vmSshBackend });
  log('');
  if (!put.ok) {
    log(' [WARN] The remote command exited non-zero (' + put.code + '). If the password was');
    log('        wrong, re-run. If icacls failed only, standard-user key auth still works.');
  } else {
    log(' [2/3] Key appended.');
  }

  // 3) Verify passwordless login (BatchMode=yes: fails instead of prompting).
  log(' [3/3] Verifying passwordless login (ssh -o BatchMode=yes ' + target + ' whoami)...');
  await sleep(500);
  const verify = await runSsh(['-p', String(cfg.vmSshPort), target, 'whoami'], { timeoutMs: 25_000, backend: cfg.vmSshBackend });
  const who = verify.out.trim().split(/\r?\n/).filter(Boolean).pop() || '';
  if (verify.ok && who) {
    log(' [PASS] Passwordless SSH works. Remote identity: ' + who);
    log('        Success criterion: this command returns the VM account name with NO');
    log('        password prompt. You are ready for `node delivery/bootstrap.mjs env`.');
    return true;
  }
  log(' [FAIL] Passwordless login still prompts or fails (' + String(verify.err).trim().slice(0, 160) + ')');
  log('        Next steps (see docs/INSTALL-GUIDE.md section 3):');
  log('          - confirm OpenSSH Server is running on the VM (Get-Service sshd);');
  log('          - confirm PubkeyAuthentication yes in C:/ProgramData/ssh/sshd_config;');
    log('          - on the VM, check C:/ProgramData/ssh/logs for Authentication refused');
    log('            bad ownership (administrators_authorized_keys ACL problem);');
  log('          - re-run this trust command (it is idempotent: appending the same key');
  log('            twice is harmless).');
  return false;
}

/* ----------------------------- cmd: env ----------------------------- */

/** Parse `--key=value` CLI overrides for the env subcommand. */
function parseEnvArgs(argv) {
  const out = {};
  const map = {
    'vm-host': 'VM_HOST',
    'vm-user': 'VM_USER',
    'vm-ssh-port': 'VM_SSH_PORT',
    'vm-deploy-dir': 'VM_DEPLOY_DIR',
    'provider': 'WINVM_VM_PROVIDER',
    'workbuddy-cli': 'WINVM_WORKBUDDY_CLI',
    'service-port': 'WINVM_SERVICE_PORT',
    'tunnel-local-port': 'WINVM_TUNNEL_LOCAL_PORT',
    'tunnel-remote-port': 'WINVM_TUNNEL_REMOTE_PORT',
  };
  for (const a of argv) {
    const m = a.match(/^--([a-z-]+)=(.*)$/i);
    if (m && map[m[1]]) out[map[m[1]]] = m[2];
  }
  return out;
}

/**
 * `env`: generate/update the project-root .env from delivery/env.example.
 * @param {string[]} argv
 * @returns {Promise<boolean>}
 */
async function cmdEnv(argv) {
  hr('WinVM Bridge bootstrap env (generate .env from delivery/env.example)');
  if (!existsSync(ENV_TEMPLATE)) {
    log(' [ABORT] Template missing: ' + ENV_TEMPLATE);
    return false;
  }
  const template = readFileSync(ENV_TEMPLATE, 'utf8');
  const overrides = parseEnvArgs(argv);
  const existing = existsSync(ROOT_ENV) ? parseEnv(readFileSync(ROOT_ENV, 'utf8')) : {};

  /** Prompt helper; keeps the current/default value on empty Enter. */
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (label, cur) => {
    const a = (await rl.question('  ' + label + ' [' + (cur || 'REQUIRED') + ']: ')).trim();
    return a || cur;
  };

  const values = { ...existing, ...overrides };
  if (Object.keys(overrides).length === 0) {
    log(' Interactive mode (Enter keeps the [default]). Parameter mode example:');
    log('   node delivery/bootstrap.mjs env --vm-host=192.168.1.50 --vm-user=Administrator');
    log('');
    values.VM_HOST = await ask('VM_HOST (Windows VM IP, e.g. 172.16.100.2 - REPLACE with your own)', values.VM_HOST || '');
    values.VM_SSH_PORT = await ask('VM_SSH_PORT (OpenSSH Server port)', values.VM_SSH_PORT || '22');
    values.VM_USER = await ask('VM_USER (Windows account name)', values.VM_USER || 'User');
    values.VM_DEPLOY_DIR = await ask('VM_DEPLOY_DIR', values.VM_DEPLOY_DIR || 'C:/WinVMBridge');
    values.WINVM_VM_PROVIDER = await ask(
      'WINVM_VM_PROVIDER (workbuddy-deterministic | workbuddy)',
      values.WINVM_VM_PROVIDER || 'workbuddy-deterministic',
    );
    values.WINVM_SERVICE_PORT = await ask('WINVM_SERVICE_PORT', values.WINVM_SERVICE_PORT || '18443');
  }
  rl.close();

  if (!values.VM_HOST || !values.VM_USER) {
    log(' [ABORT] VM_HOST and VM_USER are required. Nothing written.');
    return false;
  }

  // Splice values into the template line-by-line (keeps all comments intact).
  const lines = template.split(/\r?\n/).map((line) => {
    const m = line.match(/^([A-Z0-9_]+)=/);
    if (!m) return line;
    const key = m[1];
    if (!(key in values)) return line;
    const v = String(values[key] ?? '');
    if (v === '') return line; // keep the template's empty default
    return key + '=' + v;
  });

  if (existsSync(ROOT_ENV)) {
    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const bak = ROOT_ENV + '.winvm-bak.' + ts;
    writeFileSync(bak, readFileSync(ROOT_ENV, 'utf8'));
    log(' Existing .env backed up -> ' + bak);
  }
  writeFileSync(ROOT_ENV, lines.join('\n') + '\n');
  log(' Written: ' + ROOT_ENV);
  log(' Collected values:');
  for (const k of ['VM_HOST', 'VM_SSH_PORT', 'VM_USER', 'VM_DEPLOY_DIR', 'WINVM_VM_PROVIDER', 'WINVM_SERVICE_PORT']) {
    log('   ' + k + '=' + (values[k] ?? ''));
  }
  log('');
  log(' Next step: node delivery/bootstrap.mjs all   (check + trust + env + setup dry-run)');
  return true;
}

/**
 * 端口字段归一（v1.4.32 修）：`resolveConfig` 出来的 cfg 里 SSH 端口叫 **`vmSshPort`**，
 * 而本模块的探测构造器收的是 `sshPort`。二者错位会让 `'WinVM-SSH-' + undefined` 变成
 * **`WinVM-SSH-undefined`**——一条永远不存在的规则名 ⇒ 防火墙判据**恒定假红**
 * （真机实测：直调脚本传对键得 true，prepare-vm 传 cfg 得 MISSING）。
 * 这里同时接受两种形状；两个端口都非法时**直接抛**，宁可早崩也不许静默假红。
 * @param {{sshPort?:number,vmSshPort?:number,servicePort?:number}} cfg
 * @returns {{sshPort:number,servicePort:number}}
 */
function normalizePorts(cfg = {}) {
  const rawSsh = cfg.sshPort ?? cfg.vmSshPort;
  const rawSvc = cfg.servicePort;
  const ok = (v) => Number.isInteger(Number(v)) && Number(v) > 0 && Number(v) <= 65535;
  if (!ok(rawSsh)) throw new Error('探测脚本构造：sshPort 缺失/非法（收到 ' + String(rawSsh) + '）');
  if (!ok(rawSvc)) throw new Error('探测脚本构造：servicePort 缺失/非法（收到 ' + String(rawSvc) + '）');
  return { sshPort: Number(rawSsh), servicePort: Number(rawSvc) };
}

/**
 * 防火墙规则的**注册表直读**片段（v1.4.32 性能改造，真机实测 243ms vs 10.6s）。
 *
 * 为什么不用 `Get-NetFirewallRule`：它是 CIM 查询，**单发 3~3.6s**，两条就是 6.8s，
 * 再叠加 `Import-Module NetSecurity` 的 5.8s ⇒ 光「只看防火墙在不在」就吃掉 12.5s。
 * 而规则本体就躺在 `HKLM\...\FirewallPolicy\FirewallRules` 下，每条 value 的 pipe 串形如
 *   `v2.33|Action=Allow|Active=TRUE|Dir=In|Protocol=6|LPort=22|Name=WinVM-SSH-22|`
 * 其中 **`Name=` 是 DisplayName**（不是注册表 value 名，value 名是 GUID）。整键读只要 243ms，
 * 顺带还拿到 Active/Dir/Action/Port —— 判据比「存在」更强（禁用的规则不再被误判 OK）。
 *
 * 兜底：注册表读不出来（键缺失/权限）→ 回落 `Get-NetFirewallRule -DisplayName`（慢但正确）。
 * 返回 PS 语句数组，调用方自己决定塞进哪个脚本；约定产出 `$fwm`（DisplayName → 是否生效）。
 * @param {number} sshPort
 * @param {number} servicePort
 * @returns {string[]}
 */
function fwProbePsLines(sshPort, servicePort) {
  const q = (v) => "'" + String(v).replace(/'/g, "''") + "'";
  const nameSsh = q('WinVM-SSH-' + sshPort);
  const nameSvc = q('WinVM-Service-' + servicePort);
  return [
    // FirewallRules 键下 value 名=规则 GUID，value 数据=pipe 串（含 Name=DisplayName）
    "$fwr=Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\SharedAccess\\Parameters\\FirewallPolicy\\FirewallRules' -ErrorAction SilentlyContinue",
    '$fwm=@{}',
    'if($null -ne $fwr){',
    'foreach($pp in $fwr.PSObject.Properties){',
    "if($pp.Name -like 'PS*'){continue}",
    '$v=[string]$pp.Value',
    "if($v -notlike '*Name=WinVM-*'){continue}",
    '$f=@{}',
    "foreach($seg in $v.Split('|')){$kv=$seg.Split('=',2); if($kv.Count -eq 2){$f[$kv[0]]=$kv[1]}}",
    "if(-not $f.ContainsKey('Name')){continue}",
    // 生效判据：Active 非 FALSE（缺省视为 TRUE）且方向入站且动作放行
    "$act=($f['Active'] -ne 'FALSE')",
    "$din=($f['Dir'] -eq 'In')",
    "$acl=($f['Action'] -eq 'Allow')",
    '$fwm[[string]$f["Name"]]=($act -and $din -and $acl)',
    '}',
    '}',
    // 判据来源标记：reg=注册表直读；cim=回落 CIM
    "$o.fwSrc='reg'",
    'if($null -eq $fwr){',
    "$o.fwSrc='cim'",
    ('$fwm[' + nameSsh + ']=[bool](Get-NetFirewallRule -DisplayName ' + nameSsh + ' -ErrorAction SilentlyContinue)'),
    ('$fwm[' + nameSvc + ']=[bool](Get-NetFirewallRule -DisplayName ' + nameSvc + ' -ErrorAction SilentlyContinue)'),
    '}',
    ('$o.fwSsh=[bool]$fwm[' + nameSsh + ']'),
    ('$o.fwSvc=[bool]$fwm[' + nameSvc + ']'),
    // 存在但未生效（禁用/出站/阻断）= 需要动作，日志要能区分「缺失」与「废的」
    ('$o.fwSshPresent=[bool]$fwm.ContainsKey(' + nameSsh + ')'),
    ('$o.fwSvcPresent=[bool]$fwm.ContainsKey(' + nameSvc + ')'),
  ];
}

/**
 * prepare-vm 的**单往返**只读探测脚本（v1.4.32）。
 *
 * 原实现是 7 条独立 ssh：`net session` / `sc query sshd` / `sc qc sshd` /
 * `netsh ... ×2` / `node -v` / `<cli> --version` / 1 条 EncodedCommand。
 * 每条都要**新建一次连接 + 一次 PowerShell 冷启**（本 VM 上 Defender 逐进程扫描使
 * 冷启 6.6~7.7s）⇒ 实测该段 76s，与「只读探测」的语义完全不匹配。
 *
 * 这里一次采集全部事实、输出单行 JSON；调用方解析失败时自动退回逐条实现
 * （降级安全：老 PS / 策略限制 / JSON 被日志污染都不会让部署变红）。
 *
 * 真机分步耗时（合计 27.5s wall，v1.4.31 口径）与本次改造：
 *   PS 冷启 7.7s（不可省，唯一一次进程启动）
 *   Import-Module NetSecurity 5.8s → **删掉**（注册表直读不需要 NetSecurity）
 *   Get-NetFirewallRule ×2     6.8s → **243ms**（注册表直读）
 *   Get-CimInstance Win32_Service 2.2s → **93ms**（改用 Get-Service 的 StartType）
 *   & node -v 0.42s / Get-Command 0.11s / Test-Path 0.08s（保留）
 *
 * @param {{servicePort:number,sshPort?:number,vmSshPort?:number,workbuddyCli:string}} cfg
 * @returns {string} 单行 PowerShell 脚本
 */
export function buildPrepareProbePs(cfg) {
  const { sshPort, servicePort } = normalizePorts(cfg);
  const workbuddyCli = cfg.workbuddyCli;
  const q = (v) => "'" + String(v).replace(/'/g, "''") + "'";
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    // SSH 会话的 PATH 只有 Machine 段（node/npm/codebuddy 常在 User 段或 C:\nodejs），
    // 不显式拼 Machine;User 会让 Get-Command 恒空 ⇒ 每轮都误判"未安装"并重装。
    // 这是 v2.3.0 卸上游 CLI 时踩过的同款坑（vm-remove-local 段 8），此处前移。
    '$env:Path=[Environment]::GetEnvironmentVariable("Path","Machine")+";"+[Environment]::GetEnvironmentVariable("Path","User")',
    '$o=[ordered]@{}',
    // admin：与 net session 同义，但不需要起 cmd.exe 子进程
    '$pr=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())',
    '$o.admin=$pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
    // sshd 服务：Get-Service 已带 StartType（PS 5.1+），不必再走 CIM（省 2.1s）
    '$s=Get-Service -Name sshd -ErrorAction SilentlyContinue',
    '$o.sshdInstalled=($null -ne $s)',
    '$o.sshdState=[string]$s.Status',
    '$o.sshdStart=[string]$s.StartType',
    // 防火墙两条规则（注册表直读，见 fwProbePsLines 注释）
    ...fwProbePsLines(sshPort, servicePort),
    // node 与 workbuddy CLI（Get-Command 比执行 --version 快且无副作用）
    '$o.nodeVer=[string](& node -v 2>$null)',
    '$o.npm=[bool](Get-Command npm -ErrorAction SilentlyContinue)',
    ('$o.cli=[bool](Get-Command ' + q(workbuddyCli) + ' -ErrorAction SilentlyContinue)'),
    // DB-7 两个上游 CLI（v2.4.0 起由 4a 负责检查/安装，不再等 4b 的 npm 段）
    '$o.browserCli=[bool](Get-Command agent-browser -ErrorAction SilentlyContinue)',
    '$o.desktopCli=[bool](Get-Command agent-desktop -ErrorAction SilentlyContinue)',
    // codebuddy 登录态标记
    "$d=Join-Path $env:USERPROFILE '.codebuddy'",
    "$o.cfg=((Test-Path (Join-Path $d 'settings.json')) -or (Test-Path (Join-Path $d 'user-state.json')))",
    '$o|ConvertTo-Json -Compress',
  ].join('; ');
}

/**
 * prepare-vm **降级路径**用的第二发 PS（v1.4.32）：防火墙两条规则 + codebuddy 登录态标记。
 *
 * 为什么必须换掉 `netsh advfirewall firewall show rule name=...`：
 * 该规则的 **Name 是 GUID**（`{e76c0ed1-…}`），`WinVM-SSH-22` 只是 **DisplayName**；
 * `netsh ... name=` 匹配的是 Name ⇒ 恒 "No rules match" ⇒ 判据**恒定假红**（真机取证：
 * `[{D:"WinVM-SSH-22", N:"{e76c0ed1-…}"}, …]`）。假红的代价是每轮都多跑一遍幂等 DO 动作。
 * `Get-NetFirewallRule -DisplayName` 才对；顺带把原本单独一发 EncodedCommand 的登录态
 * 标记也并进来（降级路径 7 发 → 6 发）。
 *
 * @param {{servicePort:number,sshPort?:number,vmSshPort?:number}} cfg
 * @returns {string} 单行 PowerShell 脚本
 */
export function buildFallbackFactsPs(cfg) {
  const { sshPort, servicePort } = normalizePorts(cfg);
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    '$o=[ordered]@{}',
    // 与合并探测**同一套判据**（注册表直读 + CIM 兜底），避免两条路径口径漂移。
    ...fwProbePsLines(sshPort, servicePort),
    "$d=Join-Path $env:USERPROFILE '.codebuddy'",
    "$o.cfg=((Test-Path (Join-Path $d 'settings.json')) -or (Test-Path (Join-Path $d 'user-state.json')))",
    '$o|ConvertTo-Json -Compress',
  ].join('; ');
}

/* ----------------------------- cmd: prepare-vm (Phase 3 批2 · P0-2) ----------------------------- */

/**
 * `prepare-vm`：VM 前置环境一键准备（把 DB-1/2/5/6(+可选3) 从纯手工压进一条命令）。
 *
 * 双相：
 *   1) 只读轻探测（**零临时文件、零 PS 内联**——sc/netsh/powercfg/POSIX 命令族，
 *      严守"本批零真机写"；打印各项现状 + 计划表 + DB-4 登录态降级判定）；
 *   2) `--apply` 时经 setup.mjs runRemotePs1 通道推 prepare-vm.mjs 生成的 .ps1 执行
 *      （幂等：每项先探测再动作，第二次全 [SKIP]；管理员面 DB-1/2/6 未提权则打印精确手工配方）。
 *
 * 鸡生蛋说明（诚实边界）：VM **从未装过 OpenSSH Server** 时 SSH 通道本身不存在，
 * 本命令不可达 ⇒ DB-1 的"安装"步骤只在"能连上但服务未自动/未运行"场景自动化；
 * 全新 VM 的首装仍需一次 VM 内/RDP 手工（INSTALL-GUIDE §1.1 一行命令），此后全部自动化。
 *
 * @param {string[]} argv
 * @returns {Promise<boolean>}
 */
async function cmdPrepareVm(argv) {
  const apply = argv.includes('--apply');
  // --ensure-deps 隐含 --ensure-node：node 是 npm 的前提，不先有 node 就装不了全局 CLI。
  const ensureDeps = argv.includes('--ensure-deps');
  const ensureNode = ensureDeps || argv.includes('--ensure-node');
  // 上游两个工具面由别处负责（或本轮明确不要）时，DB-7 只装 codebuddy。
  const skipUpstreamDeps = argv.includes('--skip-upstream-deps');
  hr('WinVM Bridge bootstrap prepare-vm (P0-2: DB-1/2/5/6 + DB-3/DB-7 one-shot VM provisioning)' +
     (apply ? ' [APPLY]' : ' [READ-ONLY PROBE]'));
  const { env, source, isFallback } = loadEnvOrTemplate();
  log('  env source: ' + source + (isFallback ? '  (fallback; run `env` to write a real .env)' : ''));
  const cfg = resolveConfig(env, { apply });
  if (!cfg.vmHost || !cfg.vmUser) {
    log(' [ABORT] VM_HOST / VM_USER not configured. Next step: node delivery/bootstrap.mjs env');
    return false;
  }
  const alive = await tcpProbe(cfg.vmHost, cfg.vmSshPort, 4000);
  if (!alive) {
    log(' [FAIL] VM unreachable at ' + cfg.vmHost + ':' + cfg.vmSshPort + '.');
    log('        Chicken-and-egg boundary: if OpenSSH Server was NEVER installed in this VM,');
    log('        the SSH channel itself does not exist. Do this ONCE inside the VM (RDP/控制台):');
    log('          Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0');
    log('          Start-Service sshd; Set-Service sshd -StartupType Automatic');
    log('        (or Settings -> Optional Features -> OpenSSH Server). Everything else');
    log('        (DB-2/5/6 + optional DB-3, sshd auto-start hardening) is then automated by THIS command.');
    return false;
  }
  const target = cfg.vmUser + '@' + cfg.vmHost;
  const sshBase = ['-p', String(cfg.vmSshPort), target];
  const probe = async (cmd, timeoutMs = 20_000) => runSsh([...sshBase, cmd], { timeoutMs, backend: cfg.vmSshBackend });

  // —— 只读轻探测：**单往返优先**，逐条兜底（v1.4.32）——
  // 7 条独立 ssh 在 VM 上每条都要新建连接 + 一次 PowerShell 冷启（Defender 逐进程扫描
  // 使冷启 5~8s），实测该段 40s+。改成一个 EncodedCommand 采集全部事实、输出单行 JSON；
  // 解析失败/旧环境自动退回逐条（降级安全，判据不变）。
  // 硬超时兜底：ssh2 在「exec 通道打开失败」后可能留下**永不 resolve** 的 promise；
  // 而没有 pending handle 时 node 会直接退出（实测表现 = rc=0 + 零输出，最危险的假绿）。
  // 这里 race 一个真 timer（不 unref：它必须保持事件循环），超时即判「合并探测不可用」→ 逐条兜底。
  let _probeTimer = null;
  const _probeTimeout = new Promise((res) => {
    _probeTimer = setTimeout(() => res({ ok: false, code: 124, out: '', err: 'combined-probe-timeout' }), 75_000);
  });
  const _tProbe0 = Date.now();
  const rProbe = await Promise.race([
    runSshPs(sshBase, buildPrepareProbePs(cfg), { timeoutMs: 90_000, backend: cfg.vmSshBackend }),
    _probeTimeout,
  ]);
  if (_probeTimer) clearTimeout(_probeTimer);
  let J = null;
  if (rProbe.ok) {
    const line = String(rProbe.out).split(/\r?\n/).map((x) => x.trim()).filter(Boolean).pop() || '';
    try { J = JSON.parse(line); } catch { J = null; }
  }
  const usedCombined = !!(J && typeof J === 'object' && 'admin' in J);
  let rAdmin, rSshdQ, rSshdC, rNode, rCli, rFacts, J2 = null;
  if (!usedCombined) {
    log('   [probe] 合并探测不可用 → 退回逐条（6 次往返，较慢）');
    rAdmin = await probe('net session', 15_000); // 非管理员必 access denied(错误5)
    rSshdQ = await probe('sc query sshd');
    rSshdC = await probe('sc qc sshd');
    // DB-5 轻探测**不可行**（实测）：powercfg 的 /query 斜杠参数被远端 Git-Bash/MSYS 路径转换吞改
    //（"invalid parameter" 乱码），而项目铁律禁 ssh 内联 PowerShell。⇒ 现状判定让位给
    // apply .ps1 通道（powershell -File 无 MSYS 干扰；powercfg /change 本身幂等无害）。
    rNode = await probe('node -v');
    rCli = await probe(cfg.workbuddyCli + ' --version');
    // 防火墙两条 + 登录态标记**一发拿全**（v1.4.32：原两条 netsh `name=` 匹配的是规则 Name
    //（GUID）而非 DisplayName ⇒ 恒假红，已改 Get-NetFirewallRule -DisplayName）。
    rFacts = await runSshPs(sshBase, buildFallbackFactsPs(cfg), { timeoutMs: 30_000, backend: cfg.vmSshBackend });
    if (rFacts.ok) {
      const line = String(rFacts.out).split(/\r?\n/).map((x) => x.trim()).filter(Boolean).pop() || '';
      try { J2 = JSON.parse(line); } catch { J2 = null; }
    }
  }

  const sshdInstalled = usedCombined
    ? !!J.sshdInstalled
    : !/1060|does not exist/i.test(rSshdQ.out + rSshdQ.err);
  const sshdRunning = usedCombined
    ? /RUNNING/i.test(String(J.sshdState || ''))
    : /RUNNING/i.test(rSshdQ.out);
  const mStart = usedCombined ? null : rSshdC.out.match(/START_TYPE\s*:\s*(\d)/);
  // 合并路径的来源是 Get-Service 的 StartType（**Automatic**），降级路径是 sc qc 的数字。
  // 这里必须 /^auto/i（前缀匹配）：早先写成 /^auto$/i ⇒ 'Automatic' 被判成非自启 ⇒ 每轮多跑一次幂等 DO。
  const sshdAuto = usedCombined
    ? /^auto/i.test(String(J.sshdStart || ''))
    : (mStart ? mStart[1] === '2' : false);

  const nodeVerStr = usedCombined ? firstVersion(String(J.nodeVer || '')) : firstVersion(rNode.out);
  const state = {
    admin: usedCombined ? !!J.admin : rAdmin.ok,
    sshd: { installed: sshdInstalled, state: sshdRunning ? 'Running' : 'Stopped', startMode: sshdAuto ? 'Auto' : 'Manual/Unknown' },
    firewall: usedCombined
      ? { ssh: !!J.fwSsh, service: !!J.fwSvc, sshPresent: !!J.fwSshPresent, servicePresent: !!J.fwSvcPresent }
      // 降级路径若连第二发 PS 也解析失败，判据=未知；此时**宁可报 MISSING**（会多跑一次幂等
      // DO，代价可接受）也不报 OK（假绿会让防火墙真缺时无人补）。
      : { ssh: J2 ? !!J2.fwSsh : false, service: J2 ? !!J2.fwSvc : false, sshPresent: J2 ? !!J2.fwSshPresent : false, servicePresent: J2 ? !!J2.fwSvcPresent : false },
    node: { present: usedCombined ? !!nodeVerStr : rNode.ok, version: nodeVerStr },
    agentCli: usedCombined ? !!J.cli : rCli.ok,
    /* P15（2026-11-19 真机）：探测脚本一直采集 `$o.browserCli` / `$o.desktopCli`（见
     * buildCombinedFactsPs 的 DB-7 段），但 state 组装**漏了这两个键的映射**——
     * 于是 906-907 行的日志、以及 planPrepareVm 的 DB-7 判据读到的恒是 undefined：
     *   · 日志恒打印 `desktop:MISSING browser:MISSING`（CLI 装好了也照样红 = 假红）；
     *   · 计划表恒给出 `DO npm i -g agent-desktop + agent-browser`，永远到不了
     *     `[SKIP] all present`，误导使用者以为每轮都要重装。
     * 真机证据（12:04 轮，三 CLI 早已装好）：日志 `codebuddy:OK desktop:MISSING
     * browser:MISSING`，而同一时刻 4c 读到 `browser=33 desktop=25`。
     * 注：**实际安装行为是对的**——DB-7 的 .ps1 内部自己 Get-Command 重探（幂等），
     * 不受这里污染；受害面是日志与计划表（判据面），不是执行面。
     * 降级路径（J2）没有这两项 ⇒ 保持「宁可报缺失」的既有取向（false）。 */
    cliDesktop: usedCombined ? !!J.desktopCli : (J2 ? !!J2.desktopCli : false),
    cliBrowser: usedCombined ? !!J.browserCli : (J2 ? !!J2.browserCli : false),
    agentConfigDir: usedCombined ? !!J.cfg : (J2 ? !!J2.cfg : false),
    standbyLine: 'deferred-to-apply (MSYS 吞 powercfg 斜杠参数，现状判定走 .ps1 通道)',
    defenderRead: true, // 轻探测面不含 Get-MpPreference（需 PS）；apply .ps1 内做幂等 delta
  };

  log('');
  // 诊断口径：合并/逐条 + 耗时。既是性能观测点，也是「降级有没有发生」的唯一证据
  // （降级路径的判据来源不同，v1.4.32 起两边已统一到 Get-NetFirewallRule -DisplayName）。
  log(` [probe] ${usedCombined ? '合并单往返' : '逐条兜底'} ${((Date.now() - _tProbe0) / 1000).toFixed(1)}s`);
  log(' [1/3] 探测现状（只读，零写入）：');
  log('   ADMIN(elevated)  = ' + state.admin + (state.admin ? '' : '   (DB-1 服务面/DB-2 防火墙/DB-6 Defender 需管理员；apply 会打印手工配方)'));
  log('   DB-1 sshd        = ' + (sshdInstalled ? `installed, ${state.sshd.state}, ${state.sshd.startMode}` : 'NOT installed (见上鸡生蛋配方，需 VM 内首装一次)'));
  // 三态：OK（存在且生效）/ INACTIVE（存在但被禁用/方向反/阻断）/ MISSING（根本没建）
  const fwWord = (ok, present) => (ok ? 'OK' : (present ? 'INACTIVE' : 'MISSING'));
  log('   DB-2 firewall    = ssh:' + fwWord(state.firewall.ssh, state.firewall.sshPresent) +
      ' service:' + fwWord(state.firewall.service, state.firewall.servicePresent));
  log('   DB-5 powercfg    = ' + state.standbyLine + '  (apply 无条件幂等置 0，改后 --apply 复跑即收敛)');
  log('   DB-3 node        = ' + (state.node.present ? 'v' + state.node.version : 'MISSING') + (ensureNode ? '  (--ensure-node 已开)' : ''));
  log('   DB-7 global CLI   = codebuddy:' + (state.agentCli ? 'OK' : 'MISSING') +
      ' desktop:' + (state.cliDesktop ? 'OK' : 'MISSING') +
      ' browser:' + (state.cliBrowser ? 'OK' : 'MISSING') +
      (ensureDeps ? '  (--ensure-deps 已开)' : '  (--ensure-deps 未开：只查不装)'));
  log('   DB-6 defender    = (轻探测跳过 Get-MpPreference，apply .ps1 内幂等处理)');

  const plan = planPrepareVm({ servicePort: cfg.servicePort, sshPort: cfg.vmSshPort, ensureNode, ensureDeps }, state);
  log('');
  log(' [2/3] 计划（幂等判据：全部就绪 ⇒ 第二遍全 [SKIP]）：');
  for (const p of plan) {
    // action 串自带 [SKIP]/[MANUAL] 前缀时不再叠加标签（防 "[SKIP] [SKIP] ..." 双打）
    const auto = /^\[/.test(String(p.action));
    const tag = auto ? '' : (p.manual ? 'MANUAL' : 'DO') + ' ';
    log('   ' + p.db + ' ' + p.item + ' => ' + tag + p.action);
  }

  // DB-4 登录态（D-1 勘误口径：安装性已覆盖，此处只补"登录态无法确证"的显形）
  const login = evaluateAgentLogin({
    provider: cfg.vmProvider,
    cliExists: state.agentCli,
    configDirExists: state.agentConfigDir,
    markerFiles: [state.agentConfigDir],
  });
  log('');
  log(' [2.5/3] DB-4 codebuddy 登录态：verdict=' + login.verdict + ' —— ' + login.detail);
  if (login.remedy) log('           ↳ ' + login.remedy);

  if (!apply) {
    log('');
    log(' [3/3] READ-ONLY 完成（本模式绝不改 VM）。执行改动：');
    log('   node delivery/bootstrap.mjs prepare-vm --apply' + (ensureDeps ? ' --ensure-deps' : '') + (skipUpstreamDeps ? ' --skip-upstream-deps' : ''));
    log('   （apply 经 runRemotePs1 推 .ps1：DB-1 Automatic+Start / DB-2 防火墙 / DB-5 powercfg 三件套 /');
    log('     DB-6 Defender delta / 可选 DB-3 node / 可选 DB-7 全局 CLI（codebuddy+两上游）；每项先探测再动作=幂等）');
    return true;
  }

  log('');
  log(' [3/3] APPLY：推 prepare-vm .ps1 执行（远端逻辑走 .ps1+scp，勿内联 PS 铁律）...');
  const ps1 = buildPrepareVmApplyPs1({
    servicePort: cfg.servicePort,
    sshPort: cfg.vmSshPort,
    vmDeployDir: cfg.vmDeployDir,
    ensureNode,
    ensureDeps,
    skipUpstreamDeps,
  });
  // DB-7 首次全装（尤其 codebuddy ~2 分钟）会显著拉长本次载荷，300s 不够 ⇒ 600s。
  // 已装环境整段只有 3 次 Get-Command，实测 +0.3s，不会拖慢常态轮次。
  const r = await runRemotePs1(cfg, ps1, { timeoutMs: ensureDeps ? 900_000 : 300_000, log: (m) => log('   ' + m) });
  log(String(r.out || '').trimEnd());
  if (!r.ok) {
    log(' [FAIL] apply .ps1 非零退出（code=' + r.code + '）。逐行看上方 [DB-x] 标记定位；权限面不足时按 [MANUAL] 配方手工补齐。');
    return false;
  }
  log(' [DONE] prepare-vm apply 完成。复核：再跑一次 `node delivery/bootstrap.mjs prepare-vm`（只读）看收敛，');
  log('        或再 apply 一次应全 [SKIP]/DONE。DB-4 登录仍需 VM 内交互一次（结构性手工，唯一残留人工项）。');
  return true;
}

/* ----------------------------- cmd: all ----------------------------- */

/**
 * `all`: check -> trust -> env -> spawn setup.mjs (dry-run by default).
 * SECURITY RED LINE: never passes --apply; the user reviews the dry-run plan and
 * runs `node delivery/setup.mjs --apply` explicitly.
 * @returns {Promise<boolean>}
 */
async function cmdAll() {
  hr('WinVM Bridge bootstrap all (check -> trust -> env -> setup dry-run)');

  log('>>> [1/4] check');
  const okCheck = await cmdCheck();
  if (!okCheck) {
    log('');
    log(' [STOP] check reported blocking failures. Fix them, then re-run `all`.');
    log('        (trust/env/setup were NOT executed.)');
    return false;
  }

  log('');
  log('>>> [2/4] trust (needs the VM password ONCE)');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const goTrust = ((await rl.question('  Run trust now? [y/N]: ')).trim().toLowerCase() === 'y');
  rl.close();
  if (!goTrust) {
    log('  Skipped. Run `node delivery/bootstrap.mjs trust` later.');
  } else {
    const okTrust = await cmdTrust();
    if (!okTrust) {
      log('');
      log(' [STOP] trust did not reach passwordless login. Fix SSH auth first, then re-run `all`.');
      log('        (env/setup were NOT executed. You can still run env/setup manually.)');
      return false;
    }
  }

  log('');
  log('>>> [3/4] env');
  if (existsSync(ROOT_ENV)) {
    log('  ' + ROOT_ENV + ' already exists -> kept as-is (nothing overwritten).');
  } else {
    const okEnv = await cmdEnv([]);
    if (!okEnv) {
      log(' [STOP] env generation failed.');
      return false;
    }
  }

  log('');
  log('>>> [4/4] setup.mjs (DRY-RUN preview; no system changes)');
  log('  spawning: node delivery/setup.mjs');
  log('  NOTE: bootstrap NEVER auto-applies. Review the printed plan, then run');
  log('        `node delivery/setup.mjs --apply` yourself to perform the real deployment.');
  const r = spawn('node', [SETUP_ENTRY], { cwd: ROOT, stdio: 'inherit' });
  await new Promise((res) => r.on('close', res));
  log('');
  log(' all: done. Real deployment = node delivery/setup.mjs --apply (after WINVM_DRY_RUN stays 1)');
  log(' or flip WINVM_DRY_RUN=0 in .env if you accept the footgun-free default flow.');
  return true;
}

/* ----------------------------- usage / main ----------------------------- */

function usage() {
  log('WinVM Bridge bootstrap (phase-0 entry, runs before delivery/setup.mjs)');
  log('');
  log('Usage: node delivery/bootstrap.mjs <command>');
  log('');
  log('Commands:');
  log('  check  Extended dependency self-check (read-only, safe to run anytime):');
  log('         host node/workbuddy + ssh/scp/tar/curl presence, VM TCP reachability,');
  log('         VM-side node + agent CLI probe over ssh (deterministic provider =');
  log('         warning only), python reported as NOT required (Node-only pipeline).');
  log('         On platform=ohos the nvm probe is skipped by design (WorkBuddy desktop');
  log('         bundles its own node).');
  log('  trust  SSH passwordless bootstrap: create ~/.ssh/id_ed25519 if missing, append');
  log('         the .pub key on the VM via ONE password login (both ~/.ssh/authorized_keys');
  log('         and C:/ProgramData/ssh/administrators_authorized_keys + icacls ACL fix for');
  log('         Administrators-group users), then verify with `ssh ... whoami`.');
  log('  env    Generate the project-root .env from delivery/env.example (interactive, or');
  log('         parameter mode: --vm-host=... --vm-user=... --vm-ssh-port=... --provider=...).');
  log('         Existing .env is backed up to .env.winvm-bak.<timestamp>.');
  log('  prepare-vm [--apply] [--ensure-node]');
  log('         P0-2 one-shot VM provisioning (Phase 3 批2): read-only probe by default');
  log('         (sshd/firewall/powercfg/defender/node/login markers, ZERO VM writes);');
  log('         --apply pushes an idempotent .ps1 via setup.mjs runRemotePs1 that automates');
  log('         DB-1 (Automatic+start; install only if channel exists), DB-2 firewall rules,');
  log('         DB-5 powercfg never-sleep trio, DB-6 Defender exclusion delta, optional DB-3');
  log('         winget node. The ONLY structural manual residual is DB-4 codebuddy login');
  log('         (interactive auth cannot be scripted) + first-time OpenSSH install on a VM');
  log('         that never had the SSH channel (chicken-and-egg, one command printed).');
  log('  all    check -> trust -> env -> `node delivery/setup.mjs` (DRY-RUN).');
  log('         SECURITY: bootstrap never passes --apply; run setup.mjs --apply explicitly');
  log('         after reviewing the dry-run plan.');
  log('  help   Show this usage.');
  log('');
  log('Examples:');
  log('  node delivery/bootstrap.mjs check');
  log('  node delivery/bootstrap.mjs trust');
  log('  node delivery/bootstrap.mjs env --vm-host=172.16.100.2 --vm-user=User');
  log('  node delivery/bootstrap.mjs all');
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = (argv[0] || '').toLowerCase();
  switch (cmd) {
    case 'check': return cmdCheck();
    case 'trust': return cmdTrust();
    case 'env': return cmdEnv(argv.slice(1));
    case 'prepare-vm': return cmdPrepareVm(argv.slice(1));
    case 'all': return cmdAll();
    case 'help':
    case '--help':
    case '-h':
    case '':
      usage();
      return true;
    default:
      log('Unknown command: ' + cmd);
      usage();
      return false;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main()
    .then((ok) => { if (!ok) process.exitCode = 1; })
    .catch((e) => {
      process.stderr.write('bootstrap.mjs error: ' + (e?.stack ?? e) + '\n');
      process.exitCode = 1;
    });
}

export { main };

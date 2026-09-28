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
import { parseEnv, loadEnvFile, resolveConfig } from './setup.mjs';
import { checkHostDeps, printChecks } from './preflight.mjs';

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
 * @param {string[]} sshArgs extra args after the base options
 * @param {{timeoutMs?: number, interactive?: boolean}} [opts]
 * @returns {{ok: boolean, code: number, out: string, err: string}}
 */
function runSsh(sshArgs, opts = {}) {
  const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', ...sshArgs];
  if (opts.interactive) {
    // One password login: inherit stdio so the user can type the password.
    const r = spawnSync('ssh', args, { stdio: 'inherit' });
    return { ok: r.status === 0, code: r.status ?? -1, out: '', err: '' };
  }
  const r = spawnSync('ssh', args, { encoding: 'utf8', timeout: opts.timeoutMs ?? 30_000 });
  return {
    ok: r.status === 0,
    code: r.status ?? -1,
    out: String(r.stdout || ''),
    err: String(r.stderr || ''),
  };
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
      log('         docs/oh-host-install-run-test.md section 0); if missing here the');
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
      const whereNode = runSsh(['-p', String(cfg.vmSshPort), cfg.vmUser + '@' + cfg.vmHost, 'where node'], { timeoutMs: 25_000 });
      const nodeVer = runSsh(['-p', String(cfg.vmSshPort), cfg.vmUser + '@' + cfg.vmHost, 'node -v'], { timeoutMs: 25_000 });
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
      const cb = runSsh(['-p', String(cfg.vmSshPort), cfg.vmUser + '@' + cfg.vmHost, cfg.workbuddyCli + ' --version'], { timeoutMs: 25_000 });
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
  //    Remote default shell is Git-Bash/MSYS on this topology, so POSIX syntax + icacls.
  const remoteCmd =
    "umask 077; mkdir -p ~/.ssh; echo '" + pubKey + "' >> ~/.ssh/authorized_keys; " +
    "mkdir -p /c/ProgramData/ssh 2>/dev/null; " +
    "echo '" + pubKey + "' >> /c/ProgramData/ssh/administrators_authorized_keys 2>/dev/null; " +
    "icacls 'C:\\ProgramData\\ssh\\administrators_authorized_keys' /inheritance:r " +
    "/grant 'SYSTEM:F' /grant 'BUILTIN\\Administrators:F' 2>/dev/null; " +
    'echo TRUST_DONE';
  log(' [2/3] Appending the public key on ' + target + ' (you will be asked for the VM');
  log('       password ONCE; the key goes to ~/.ssh/authorized_keys AND to');
  log("       C:/ProgramData/ssh/administrators_authorized_keys with icacls ACL fix, so");
  log('       it works for standard users AND Administrators-group users):');
  const put = runSsh(['-p', String(cfg.vmSshPort), target, remoteCmd], { interactive: true });
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
  const verify = runSsh(['-p', String(cfg.vmSshPort), target, 'whoami'], { timeoutMs: 25_000 });
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
      'WINVM_VM_PROVIDER (workbuddy-deterministic | workbuddy | hermes-agent)',
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

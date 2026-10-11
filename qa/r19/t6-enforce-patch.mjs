#!/usr/bin/env node
/**
 * P2-T6 real-machine patch — VM 内回连凭据分发通路（enforce-on + 接线）三态补丁。
 *
 * Order iron law: deploy -> **patch (this script)** -> kill-restart.
 * Usage (run ON THE VM via ssh, ASCII-only output, idempotent per mode):
 *   node t6-enforce-patch.mjs on       # security.enforceBearer=true + tokenEnv + provider options.bearerEnvName
 *                                      # + start-hidden.ps1 explicit $env:WINVM_BEARER_TOKEN='<value>'
 *   node t6-enforce-patch.mjs off      # same wiring but enforceBearerFailClosed=false (rollback-position probe)
 *   node t6-enforce-patch.mjs unwired  # enforce=true BUT provider options.bearerEnvName REMOVED
 *                                      # => judgement-order (4) must say broken => fail-closed refuses start
 *                                      #   (proves T6 did not weaken T5's honest-broken semantics)
 *   node t6-enforce-patch.mjs restore  # byte-restore runtime.json + start-hidden.ps1 from *.bak-p2t6
 *
 * Backup discipline: first non-restore run copies current files to *.bak-p2t6 (never overwrites an
 * existing bak-p2t6, so the ORIGINAL pre-window bytes stay recoverable even across reruns).
 * T5's *.bak-p2t5 files are left untouched.
 *
 * Credential discipline (NFR-511 / K-17): only the env NAME goes into runtime.json (provider
 * options.bearerEnvName); the VALUE goes only into the generated start-hidden.ps1 on the VM
 * (deployment dir is gitignored) and into the service process environment.
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';

const GEN = 'C:/WinVMBridge/delivery/.generated';
const RUNTIME = `${GEN}/vm-service.runtime.json`;
const START = `${GEN}/start-hidden.ps1`;
const ENV_NAME = 'WINVM_BEARER_TOKEN';
const TOKEN_VALUE = 'p2t6-wired-token-4c7e';
const ASSIGN_LINE = `$env:${ENV_NAME} = '${TOKEN_VALUE}'`;
const READY_ANCHOR = "$env:WINVM_PSBRIDGE_READY_TIMEOUT_MS = '60000'";
const BAK = '.bak-p2t6';

const mode = process.argv[2];
if (!mode) die('usage: on|off|unwired|restore');

function die(msg) {
  console.error('FATAL: ' + msg);
  process.exit(1);
}

function ensureBackups() {
  for (const f of [RUNTIME, START]) {
    if (!existsSync(f)) die('missing target file ' + f);
    if (!existsSync(f + BAK)) {
      copyFileSync(f, f + BAK);
      console.log('BACKUP_CREATED ' + f + BAK);
    } else {
      console.log('BACKUP_EXISTS ' + f + BAK);
    }
  }
}

if (mode === 'restore') {
  for (const srcF of [RUNTIME, START]) {
    const b = srcF + BAK;
    if (!existsSync(b)) die('missing backup ' + b);
    copyFileSync(b, srcF);
    console.log('RESTORED ' + srcF + ' <- ' + b);
  }
  process.exit(0);
}

ensureBackups();

if (mode !== 'on' && mode !== 'off' && mode !== 'unwired') die('usage: on|off|unwired|restore');

/* ---- 1. runtime.json ---- */
const cfg = JSON.parse(readFileSync(RUNTIME, 'utf8'));
cfg.security = cfg.security ?? {};
cfg.security.enforceBearer = true;
cfg.security.tokenEnv = ENV_NAME;
cfg.security.enforceBearerFailClosed = mode === 'off' ? false : true;

const providerId = cfg.agent && cfg.agent.provider;
if (!providerId || !cfg.agent.providers || !cfg.agent.providers[providerId]) {
  die('agent.provider / providers[' + providerId + '] not present in runtime.json');
}
const opts = cfg.agent.providers[providerId].options ?? {};
if (mode === 'unwired') {
  delete opts.bearerEnvName;
} else {
  opts.bearerEnvName = ENV_NAME;
}
cfg.agent.providers[providerId].options = opts;

writeFileSync(RUNTIME, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
console.log(
  'PATCHED runtime.json provider=' + providerId +
  ' enforceBearer=true failClosed=' + cfg.security.enforceBearerFailClosed +
  ' bearerEnvName=' + (mode === 'unwired' ? '(absent)' : ENV_NAME),
);

/* ---- 2. start-hidden.ps1 (the ONLY env source for the task-authorized service process) ---- */
let ps1 = readFileSync(START, 'utf8');
const lines = ps1.split(/\r?\n/);
const eol = ps1.includes('\r\n') ? '\r\n' : '\n';
const existingAt = lines.findIndex((l) => new RegExp('^\\$env:' + ENV_NAME + '\\s*=').test(l));
if (existingAt >= 0) {
  if (lines[existingAt] !== ASSIGN_LINE) {
    lines[existingAt] = ASSIGN_LINE;
    writeFileSync(START, lines.join(eol), 'utf8');
    console.log('PATCHED start-hidden.ps1: env assignment line updated in place');
  } else {
    console.log('start-hidden.ps1 env assignment already in place (idempotent)');
  }
} else {
  const anchorAt = lines.findIndex((l) => l.startsWith('$env:WINVM_PSBRIDGE_READY_TIMEOUT_MS'));
  if (anchorAt < 0) die('anchor line not found in start-hidden.ps1');
  lines.splice(anchorAt + 1, 0, ASSIGN_LINE);
  writeFileSync(START, lines.join(eol), 'utf8');
  console.log('PATCHED start-hidden.ps1: env assignment injected after READY_TIMEOUT line');
}
console.log('PATCH_DONE mode=' + mode);

#!/usr/bin/env node
/**
 * P2-T5 real-machine probe — enforce-on PATCH for VM runtime config.
 *
 * Order iron law: deploy → **patch** → kill-restart. This is the patch step.
 * Usage (run ON THE VM via ssh):
 *   node t5-enforce-patch.mjs on      # security.enforceBearer=true, keep FailClosed=true; inject env line into start-hidden.ps1
 *   node t5-enforce-patch.mjs off     # same but enforceBearerFailClosed=false (rollback-position probe)
 *   node t5-enforce-patch.mjs restore # byte-restore both files from *.bak-p2t5
 * ASCII-only output. Idempotent per mode.
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';

const GEN = 'C:/WinVMBridge/delivery/.generated';
const RUNTIME = `${GEN}/vm-service.runtime.json`;
const START = `${GEN}/start-hidden.ps1`;
const ENV_LINE = "$env:WINVM_BEARER_TOKEN = 'p2t5-probe-token-9f3a'";
const mode = process.argv[2];

function die(msg) {
  console.error('FATAL: ' + msg);
  process.exit(1);
}

if (mode === 'restore') {
  for (const [src, dst] of [
    [`${RUNTIME}.bak-p2t5`, RUNTIME],
    [`${START}.bak-p2t5`, START],
  ]) {
    if (!existsSync(src)) die('missing backup ' + src);
    copyFileSync(src, dst);
    console.log('RESTORED ' + dst + ' <- ' + src);
  }
  process.exit(0);
}

if (mode !== 'on' && mode !== 'off') die('usage: on|off|restore');

// runtime.json: flip enforceBearer (and FailClosed for 'off')
const cfg = JSON.parse(readFileSync(RUNTIME, 'utf8'));
cfg.security = cfg.security ?? {};
cfg.security.enforceBearer = true;
cfg.security.tokenEnv = 'WINVM_BEARER_TOKEN';
cfg.security.enforceBearerFailClosed = mode === 'on' ? true : false;
writeFileSync(RUNTIME, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
console.log('PATCHED runtime.json: enforceBearer=true failClosed=' + cfg.security.enforceBearerFailClosed);

// start-hidden.ps1: inject bearer env line right after the timeout line (before node spawn)
let ps1 = readFileSync(START, 'utf8');
if (!ps1.includes('WINVM_BEARER_TOKEN')) {
  const anchor = "$env:WINVM_PSBRIDGE_READY_TIMEOUT_MS = '60000'";
  if (!ps1.includes(anchor)) die('anchor line not found in start-hidden.ps1');
  ps1 = ps1.replace(anchor, anchor + '\n' + ENV_LINE);
  writeFileSync(START, ps1, 'utf8');
  console.log('PATCHED start-hidden.ps1: bearer env line injected');
} else {
  console.log('start-hidden.ps1 already carries WINVM_BEARER_TOKEN (idempotent)');
}
console.log('PATCH_DONE mode=' + mode);

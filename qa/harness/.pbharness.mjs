import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';

const LOG = 'C:/WinVMBridge/.pbharness.out';
writeFileSync(LOG, '');
const log = (s) => { appendFileSync(LOG, s + '\n'); console.log(s); };

const ps = spawn('powershell.exe', [
  '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
  '-File', 'C:/WinVMBridge/packages/vm-capabilities/psmod/ps-bridge.ps1',
], { cwd: 'C:/WinVMBridge' });

let buf = '';
ps.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) log('PSOUT:' + line);
  }
});
ps.stderr.on('data', (d) => log('PSERR:' + d.toString('utf8').replace(/\r?\n/g, ' ')));

function send(id, module, fn) {
  ps.stdin.write(JSON.stringify({ id, module, function: fn, params: {}, timeoutMs: 20000 }) + '\n');
}

setTimeout(() => { log('SEND_PING'); send('r1', '__meta', 'ping'); }, 3000);
setTimeout(() => { log('SEND_GUI'); send('r2', 'gui', 'Get-SessionHealth'); }, 6000);
setTimeout(() => { try { ps.kill(); } catch {} log('HARNESS_DONE'); process.exit(0); }, 12000);

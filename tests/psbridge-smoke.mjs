/**
 * ps-bridge 冒烟脚本：验证 Node ↔ 常驻 PowerShell 进程的真实链路
 * 运行：node tests/psbridge-smoke.mjs
 */
import { PsBridge, defaultScriptPath } from '@winvm/vm-capabilities';

console.log('scriptPath =', defaultScriptPath());

const b = new PsBridge();
try {
  await b.start();
  console.log('READY uptimeMs=', b.uptimeMs);

  const ping = await b.call('__meta', 'ping', {}, 8000);
  console.log('ping =>', JSON.stringify(ping).slice(0, 220));

  const info = await b.call('system', 'Get-SystemInfo', {}, 25000);
  console.log('Get-SystemInfo =>', JSON.stringify(info).slice(0, 420));

  const t0 = Date.now();
  await b.call('system', 'Get-SystemInfo', {}, 25000);
  console.log('hot-call latency ms =', Date.now() - t0);

  await b.stop();
  console.log('SMOKE OK');
} catch (e) {
  console.log('ERROR:', e.code ?? '', e.message);
  process.exitCode = 1;
}

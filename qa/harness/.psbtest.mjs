import { PsBridge } from 'file:///C:/WinVMBridge/packages/vm-capabilities/dist/index.js';
const b = new PsBridge();
try {
  await b.start();
  const r = await b.call('gui', 'Get-SessionHealth', {}, 20000);
  console.log('RESULT=' + JSON.stringify(r));
} catch (e) {
  console.log('THREW=' + (e.code || '?') + '|' + e.message);
} finally {
  await b.stop();
}

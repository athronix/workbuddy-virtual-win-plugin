/* B2 真机探针（v2）：win32 cmd 包装路径 signal 透传 —— 只用 bridge.js 导出（resolveCliPath/launchCliProcess） */
const bridge = await import('file:///C:/WinVMBridge/packages/adapter-agent-workbuddy-llm/dist/bridge.js');
console.log('exports:', Object.keys(bridge).filter(k => /launch|resolve/i.test(k)).join(','));
const cli = bridge.resolveCliPath('codebuddy.cmd');
console.log('resolved:', JSON.stringify(cli));
if (!cli || !cli.isScript) { console.log('B2=NOT_SCRIPT — 未走包装分支'); process.exit(0); }
const ctrl = new AbortController();
const child = bridge.launchCliProcess(cli, ['--version'], process.env, ctrl.signal);
const events = [];
child.on('error', (e) => events.push(`error:${e.name}`));
child.on('close', (code, sig) => events.push(`close:code=${code}:sig=${sig}`));
child.on('exit', (code, sig) => events.push(`exit:code=${code}:sig=${sig}`));
setTimeout(() => { try { ctrl.abort(); events.push('abort()'); } catch (e) { events.push(`abort_fail:${e.name}`); } }, 50);
setTimeout(() => {
  console.log('platform:', process.platform, 'isScript:', cli.isScript);
  console.log('events:', JSON.stringify(events));
  const killed = events.some((x) => x.startsWith('close') && x !== 'close:code=0:sig=null');
  console.log(killed ? 'B2=PASS(cmd 包装进程被 signal 终止)' : 'B2=CHECK(观察 events)');
  process.exit(0);
}, 4000);

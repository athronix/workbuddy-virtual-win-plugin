/**
 * Step 4.4 验收（可复跑）。判据全部锚在**代码面**，且先剥注释再判。
 *
 * 为什么必须剥注释：本仓已知三类假绿/假红都源于「判据锚在字符串上，而字符串同时承载
 * 代码与文档」。本步涉及的每个术语（`providers` / `loadProvider` / `await import`）
 * 在解释性注释里必然出现 —— 不剥注释，验收会红在「解释为什么不用它」这句话上。
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { fileURLToPath } from 'node:url';
/** 仓库根绝对路径（脚本在 qa/ 下 ⇒ 上一级）。判据里一律用绝对路径，避免 cwd 依赖。 */
const ROOT = fileURLToPath(new URL('../', import.meta.url));
/** 以**仓库根**为基准读文件：入参形如 'packages/...'。 */
const read = (rel) => readFileSync(new URL(`../${rel.replace(/^\.\//, '')}`, import.meta.url), 'utf8');

/** 剥块注释 + 行注释（字符串字面量内的 // 会误剥，故做轻量状态机而非正则）。 */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let state = 'code';
  let quote = '';
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (state === 'code') {
      if (c === '/' && d === '/') { state = 'line'; i += 2; continue; }
      if (c === '/' && d === '*') { state = 'block'; i += 2; continue; }
      if (c === '"' || c === "'" || c === '`') { state = 'str'; quote = c; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (state === 'line') { if (c === '\n') { state = 'code'; out += c; } i++; continue; }
    if (state === 'block') { if (c === '*' && d === '/') { state = 'code'; i += 2; } else i++; continue; }
    if (state === 'str') {
      if (c === '\\') { out += c + (d ?? ''); i += 2; continue; }
      if (c === quote) { state = 'code'; }
      out += c; i++; continue;
    }
  }
  return out;
}

let fail = 0;
const ok = (cond, label, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!cond) fail++;
};

console.log('=== Step 4.4 验收 ===\n');

/* ① loader.ts 已删 */
let loaderGone = false;
try { read('./packages/core/src/bridge/loader.ts'); } catch { loaderGone = true; }
ok(loaderGone, '① packages/core/src/bridge/loader.ts 已删除');

/* ② ★ 核心判据：生产装配路径不含动态 import */
const coreFiles = execFileSync(
  process.execPath,
  ['-e', `
const fs=require('fs'),path=require('path');
const out=[];
(function walk(d){for(const f of fs.readdirSync(d)){const p=path.join(d,f);
  const st=fs.statSync(p);
  if(st.isDirectory())walk(p); else if(f.endsWith('.ts'))out.push(p);}})('${ROOT}packages/core/src');
(function walk(d){for(const f of fs.readdirSync(d)){const p=path.join(d,f);
  const st=fs.statSync(p);
  if(st.isDirectory())walk(p); else if(f.endsWith('.ts')&&!f.startsWith('cli'))out.push(p);}})('${ROOT}packages/vm-service/src');
console.log(JSON.stringify(out));`],
  { encoding: 'utf8' },
).trim();
const files = JSON.parse(coreFiles);
const dynImports = [];
for (const f of files) {
  const code = stripComments(readFileSync(f, 'utf8'));
  // 只抓「await import(」与非字面量 import()：静态 import 语句不在判据内
  if (/\bawait\s+import\s*\(/.test(code)) dynImports.push(`${f.replace(ROOT, '')}: await import(`);
}
ok(
  dynImports.length === 0,
  '② 生产装配路径（core + vm-service 非 cli）零 `await import(`',
  dynImports.length ? `\n      ${dynImports.join('\n      ')}` : '',
);

/* ③ registry.ts 不再回落动态 import：确认 loadProvider 内无 import( */
const regCode = stripComments(read('./packages/core/src/bridge/registry.ts'));
ok(!/\bimport\s*\(/.test(regCode), '③ loadProvider 内无任何 import( 回落');
ok(/尚未注册该 id 的装配工厂/.test(regCode), '③b 未注册时的报错文案已指向 planner（不是「包没导出」）');

/* ④ 装配表与真实 adapter 导出对得上（防「注册了不存在的包名」） */
const asmMod = await import(new URL('../packages/vm-service/dist/agent-assembly.js', import.meta.url).href);
const view = asmMod.PLANNER_ASSEMBLY_VIEW;
ok(Object.keys(view).sort().join(',') === 'cli-agent,template', '④ 装配表恰两个 planner', JSON.stringify(Object.keys(view)));
const det = await import(new URL('../packages/adapter-agent-workbuddy/dist/index.js', import.meta.url).href);
const llm = await import(new URL('../packages/adapter-agent-workbuddy-llm/dist/index.js', import.meta.url).href);
ok(typeof det.createProvider === 'function', '④b adapter-agent-workbuddy 导出 createProvider');
ok(typeof llm.createProvider === 'function', '④c adapter-agent-workbuddy-llm 导出 createProvider');

/* ⑤ resolvePlanner 判据穷举 */
const { resolvePlanner } = asmMod;
ok(resolvePlanner({ planner: 'template' }) === 'template', '⑤a planner=template ⇒ template');
ok(resolvePlanner({ planner: 'cli-agent' }) === 'cli-agent', '⑤b planner=cli-agent ⇒ cli-agent');
ok(resolvePlanner({ provider: 'workbuddy-deterministic' }) === 'template', '⑤c 旧键 workbuddy-deterministic ⇒ template');
ok(resolvePlanner({ provider: 'workbuddy' }) === 'cli-agent', '⑤d 旧键 workbuddy ⇒ cli-agent');
ok(resolvePlanner({ planner: 'cli-agent', provider: 'workbuddy-deterministic' }) === 'cli-agent', '⑤e 新键优先于旧键');
let threw = false;
try { resolvePlanner({ provider: 'nope' }); } catch { threw = true; }
ok(threw, '⑤f 非法配置 ⇒ 抛错（不静默回落 template）');

/* ⑥ 配置面：出厂 planner 存在，且 agent 段仍保留 providers（注入通道） */
const cfgMod = await import(new URL('../packages/core/dist/config/index.js', import.meta.url).href);
const c = cfgMod.DEFAULT_SERVICE_CONFIG;
ok(c.agent.planner === 'template', '⑥a 出厂 agent.planner=template');
ok(typeof c.agent.providers === 'object' && Object.keys(c.agent.providers).length === 2, '⑥b providers 两段保留（注入通道 + options 载体）');

/* ⑦ /health.planner 字段真的会出来 */
const srvCode = stripComments(read('./packages/vm-service/src/server.ts'));
ok(/planner:\s*activePlanner\s*\?\?\s*cfg\.agent\.planner\s*\?\?\s*DEFAULT_PLANNER/.test(srvCode),
  '⑦ /health 恒落 planner（degraded 时回落配置面）');

/* ⑧ ★ 反向断言：CLI 链路没被「降级」成「删除」 */
const lines = (rel) => read(rel).split('\n').length;
const b = lines('./packages/adapter-agent-workbuddy-llm/src/bridge.ts');
const ps = lines('./packages/adapter-agent-workbuddy-llm/src/persistent-session.ts');
ok(b >= 1993, `⑧a bridge.ts 行数不减（${b} >= 1993）`);
ok(ps >= 1144, `⑧b persistent-session.ts 行数不减（${ps} >= 1144）`);

console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAILED`}`);
process.exit(fail === 0 ? 0 : 1);
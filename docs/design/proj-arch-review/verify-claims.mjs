#!/usr/bin/env node
/**
 * 架构复审证据复现脚本（只读，零副作用）
 *
 * 用途：把 docs/design/proj-arch-review/ 里的关键结论变成可复现的输出。
 * 任何人在任何时间跑一次，就能验证文档说的对不对。
 *
 * 用法：
 *   node docs/design/proj-arch-review/verify-claims.mjs
 *   node docs/design/proj-arch-review/verify-claims.mjs --json
 *
 * 纪律：
 *   - **只读**：不写任何文件，不 spawn 服务，不碰 VM。
 *   - 每条 claim 独立 try/catch：一条炸不影响其它。
 *   - 输出 PASS/FAIL：FAIL 说明代码已变、文档需更新——这是脚本的价值，不是 bug。
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const JSON_OUT = process.argv.includes('--json');

const reads = (p) => readFileSync(join(ROOT, p), 'utf8');
const has = (p) => existsSync(join(ROOT, p));

/** 递归收集指定扩展名的文件（跳过 node_modules / dist）。 */
function walk(dir, ext, out = []) {
  let entries;
  try {
    entries = readdirSync(join(ROOT, dir), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const rel = join(dir, e.name);
    if (e.isDirectory()) walk(rel, ext, out);
    else if (e.name.endsWith(ext)) out.push(rel);
  }
  return out;
}

/**
 * 统计一组文件的物理行数。
 *
 * 口径与 `wc -l` **逐字一致**：只数换行符个数。
 * 不用 `split('\n').length` —— 那会把末尾换行算成一行，每个文件多 +1，
 * 28 个文件就是 +28（本脚本初版踩过，导致 delivery 报 16087 而 wc 报 16059）。
 */
const lineCount = (s) => (s.match(/\n/g) || []).length;
const lines = (files) => files.reduce((n, f) => n + lineCount(reads(f)), 0);

const claims = [];
const claim = (id, title, fn) => claims.push({ id, title, fn });

/* ══════════════════════════════════════════════════════════════════
 * F-01 · core/transport/ssh-tunnel* 在交付链上是死代码
 * ══════════════════════════════════════════════════════════════════ */

/**
 * F-01a · 复审时记录「ssh-tunnel 实现 690 行死代码」。
 *
 * **断言方向已于 2026-11-25 翻转**（阶段 1 执行后）：
 * 复审时的期望「= 690 行」在阶段 1 删掉这两个文件后**永远不可能成立**——
 * 那不是漂移，而是**方案生效**。6.2 要求「更新断言而非放宽」，故改为：
 *   文件已不存在 ⇒ PASS（删除达成）且打印复审记录值，供读者对照。
 * 若文件又被加回来 ⇒ FAIL（死代码回潮）。
 */
claim('F-01a', 'ssh-tunnel 死代码已删除（复审时 690 行，阶段 1.1 交付）', () => {
  const fs = [
    'packages/core/src/transport/ssh-tunnel.ts',
    'packages/core/src/transport/ssh-tunnel-ssh2.ts',
  ];
  const present = fs.filter((f) => has(f));
  return {
    ok: present.length === 0,
    detail:
      present.length === 0
        ? '已删除（复审记录 690 行死代码；阶段 1.1 交付）'
        : `回潮：${present.join(', ')} 仍在（应已删除）`,
  };
});

claim('F-01b', 'establishTransport 的生产调用点唯一且传 streamable-http', () => {
  // 只认**实际调用**（`establishTransport(` 出现在非注释行），不认文件里提到这个名字
  const callers = [];
  for (const f of walk('packages', '.ts')) {
    if (f.includes('.test.')) continue;
    reads(f).split('\n').forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, ''); // 去行注释与块注释正文
      if (/establishTransport\s*\(/.test(code) && !/function establishTransport/.test(code)) {
        callers.push(`${f}:${i + 1}`);
      }
    });
  }
  const cli = reads('packages/host-a2a-bridge/src/cli.ts');
  const onlyStreamable = /kind:\s*'streamable-http'/.test(cli) && !/kind:\s*'ssh-tunnel'/.test(cli);
  return {
    ok: callers.length === 1 && onlyStreamable,
    detail: `实际调用点 ${callers.length} 处（期望 1）：${callers.join(', ') || '(无)'}；cli 恒 streamable-http=${onlyStreamable}`,
  };
});

claim('F-01c', '真实隧道承载者 = delivery/oh-tunnel.mjs + tunnel-daemon.mjs', () => {
  const daemon = reads('delivery/tunnel-daemon.mjs');
  const usesOh = daemon.includes("from './oh-tunnel.mjs'") && daemon.includes('OhSshTunnel');
  const coreNotUsed = !daemon.includes('@winvm/core') && !daemon.includes('packages/core');
  return {
    ok: usesOh && coreNotUsed,
    detail: `tunnel-daemon 用 OhSshTunnel=${usesOh}；不引用 @winvm/core=${coreNotUsed}`,
  };
});

/* ══════════════════════════════════════════════════════════════════
 * F-02 · SkillDomain(4) vs CapabilityDomain(6)；domains 零消费
 * ══════════════════════════════════════════════════════════════════ */

/**
 * F-02a / F-02c · 复审时记录「SkillDomain(4) vs CapabilityDomain(6) 值集不一致」
 * 与「domains 字段全仓零消费」。
 *
 * **断言方向已于 2026-11-25 翻转**（阶段 1.2 删 `SkillDomain` + `domains` 之后）：
 * 复审期望「SkillDomain=4 值」在字段被删后不可能成立——删除正是交付物。
 * 改为：`SkillDomain` 类型已不存在 ⇒ PASS；回潮 ⇒ FAIL。
 * `CapabilityDomain`（6 值）**保留**，它是能力域的唯一事实源，不受本次删除影响。
 */
claim('F-02a', 'SkillDomain 已删除、CapabilityDomain 保留 6 值（阶段 1.2 交付）', () => {
  const host = reads('packages/contracts/src/host.ts');
  const cap = reads('packages/contracts/src/capability.ts');
  const skillGone = !/export type SkillDomain\s*=/.test(host);
  const mCap = cap.match(/export type CapabilityDomain\s*=\s*([^;]+);/);
  const nc = mCap ? (mCap[1].match(/'/g) || []).length / 2 : 0;
  return {
    ok: skillGone && nc === 6,
    detail: `SkillDomain 已删=${skillGone}；CapabilityDomain=${nc} 值（应仍为 6）`,
  };
});

claim('F-02b', 'domains 非法值被静默丢弃的 skill 数（应为 4）', () => {
  const VALID = ['system', 'app', 'storage', 'gui'];
  const bad = [];
  for (const d of readdirSync(join(ROOT, 'skills'))) {
    const p = join('skills', d, 'SKILL.md');
    if (!has(p)) continue;
    const m = reads(p).match(/^domains:\s*\[(.*?)\]/m);
    if (!m) continue;
    const unknown = m[1].split(',').map((s) => s.trim()).filter((v) => v && !VALID.includes(v));
    if (unknown.length > 0) bad.push(`${d}(${unknown.join(',')})`);
  }
  return { ok: bad.length === 4, detail: `${bad.length} 个受影响：${bad.join(' / ') || '(无)'}` };
});

/**
 * F-02c · 复审时记录「`domains` 在全仓无任何读取方」。
 *
 * **判据已于 2026-11-25 修正（剥注释）**：原实现按行匹配 `.domains`，把
 * `host.ts:32-34` 与 `skill-loader.ts:28-32` 的**删除说明注释**也算成消费点 ⇒ 假红。
 * 那两处注释正是在解释「为什么删掉 `domains` 字段」，把它们当消费是逻辑倒错。
 *
 * 修正为：**剥掉注释后**再找 `.domains` 读取形态。这样：
 *   - 真发生代码消费 ⇒ 仍然红（守卫有效）
 *   - 注释里的历史说明 ⇒ 不再误报
 * 这正是门禁假绿三类的镜像：**注释既能凑数（假绿），也能凑红（假红）**，两侧都要剥。
 */
const stripComments = (s) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释
    .replace(/^\s*\/\/.*$/gm, '') // 整行行注释
    .replace(/\s\/\/[^\n'"]*$/gm, ''); // 行尾行注释（不碰字符串内的 //）

claim('F-02c', 'domains 在全仓无任何读取方（剥注释后判定）', () => {
  const consumers = [];
  for (const f of [...walk('packages', '.ts'), ...walk('delivery', '.mjs')]) {
    if (f.includes('.test.') || f.includes('__tests__')) continue;
    const code = stripComments(reads(f));
    for (const line of code.split('\n')) {
      if (/\.domains\b/.test(line) && !/frontmatter\.domains\s*\?/.test(line)) {
        consumers.push(`${f}: ${line.trim()}`);
      }
    }
  }
  return {
    ok: consumers.length === 0,
    detail: consumers.length === 0 ? '零消费点（注释中的历史说明已剥除）' : consumers.join(' | '),
  };
});

/* ══════════════════════════════════════════════════════════════════
 * F-03 / F-08 · 超大文件
 * ══════════════════════════════════════════════════════════════════ */

claim('F-03', 'createService 单函数行数（应 > 2000）', () => {
  const t = reads('packages/vm-service/src/server.ts');
  const start = t.indexOf('export async function createService');
  // 文件内下一个顶层 function/export 即函数结尾
  const rest = t.slice(start);
  const m = rest.match(/\n(?=(?:export )?(?:async )?function |\n\/\* =====)/);
  const end = m ? start + m.index : t.length;
  const n = lineCount(t.slice(start, end));
  const fileN = lineCount(t);
  return { ok: n > 2000, detail: `createService ≈ ${n} 行 / 文件共 ${fileN} 行` };
});

claim('F-08', '超过 1000 行的源文件清单（应 >= 10）', () => {
  const big = [];
  for (const f of [
    ...walk('packages', '.ts'),
    ...walk('delivery', '.mjs'),
    ...walk('skills', '.md'),
  ]) {
    const n = lineCount(reads(f));
    if (n > 1000) big.push(`${f}:${n}`);
  }
  // PS 单独算
  for (const f of walk('packages/vm-capabilities/psmod', '.ps1')) {
    const n = lineCount(reads(f));
    if (n > 1000) big.push(`${f}:${n}`);
  }
  big.sort((a, b) => Number(b.split(':')[1]) - Number(a.split(':')[1]));
  return { ok: big.length >= 10, detail: `${big.length} 个：${big.slice(0, 6).join(', ')}…` };
});

/* ══════════════════════════════════════════════════════════════════
 * F-04 · HostRenderer 被绕过
 * ══════════════════════════════════════════════════════════════════ */

claim('F-04', 'install-host 手写全局 mcp.json + 拷贝 hooks（绕过 plan()）', () => {
  const t = reads('delivery/install-host.mjs');
  const globalMcp = t.includes("'mcp.json'") && /globalMcpPath/.test(t);
  const hooksCopy = /extraFiles:.*hooks\/hooks\.json/s.test(t);
  return { ok: globalMcp && hooksCopy, detail: `全局 mcp.json 手写=${globalMcp}；hooks 经 extraFiles 拷贝=${hooksCopy}` };
});

/* ══════════════════════════════════════════════════════════════════
 * F-05 · fillApprovalCard 生产零调用
 * ══════════════════════════════════════════════════════════════════ */

claim('F-05', 'fillApprovalCard 生产调用点为零', () => {
  const callers = [];
  for (const f of [...walk('packages', '.ts'), ...walk('delivery', '.mjs')]) {
    if (f.includes('.test.') || f.includes('__tests__')) continue;
    if (f.endsWith('approval-card.ts')) continue; // 定义处
    const t = reads(f);
    if (/fillApprovalCard\s*\(/.test(t)) callers.push(f);
  }
  return { ok: callers.length === 0, detail: callers.length === 0 ? '零调用点（仅单测）' : callers.join(', ') };
});

/* ══════════════════════════════════════════════════════════════════
 * F-07 · delivery 门禁面
 * ══════════════════════════════════════════════════════════════════ */

/**
 * F-07a · 复审时记录「delivery 16059 行 / 28 个 .mjs」。
 *
 * **判据已于 2026-11-25 放宽为区间**：阶段 5 新增 `connect-channel.mjs` + `install.ps1`
 * 后数量必然变化——钉死精确值会让「正常新增文件」误报成漂移。
 * 保留的真正判据是**递归口径**（只读顶层会少 1900 行，那是 F-07a 当初的发现点），
 * 以及规模量级（> 15000 行，证明它确实是块大存量）。
 */
claim('F-07a', 'delivery 全量规模（复审 16059 行 / 28 个 .mjs；现为区间判据）', () => {
  // 必须递归：delivery/tools/ 与 delivery/__tests__/ 也有 .mjs，只读顶层会少 1900 行
  const files = walk('delivery', '.mjs');
  const n = lines(files);
  const top = readdirSync(join(ROOT, 'delivery')).filter((f) => f.endsWith('.mjs')).length;
  return {
    ok: n > 15000 && files.length >= 28,
    detail: `递归 ${n} 行 / ${files.length} 个（顶层 ${top} 个 → 子目录 ${files.length - top} 个）；复审基线 16059/28`,
  };
});

claim('F-07b', 'delivery/__tests__ 已纳入 gate sweep（但只有 3 个文件）', () => {
  const gate = reads('scripts/gate.mjs');
  const inSweep = gate.includes("delivery/__tests__");
  const files = readdirSync(join(ROOT, 'delivery', '__tests__'));
  const tests = files.filter((f) => f.endsWith('.test.mjs') || f.endsWith('.test.js'));
  return { ok: inSweep && tests.length <= 3, detail: `纳入 sweep=${inSweep}；目录 ${files.length} 个文件、其中 ${tests.length} 个测试` };
});

/* ══════════════════════════════════════════════════════════════════
 * F-09 · 文档数字漂移
 * ══════════════════════════════════════════════════════════════════ */

/**
 * F-09 · 文档数字漂移
 *
 * 注意断言方向：**复审阶段这条应当 FAIL**（漂移尚未修）。
 * 本脚本的角色是"记录现状"，不是"证明已修好"。
 * 若本脚本 PASS 而 `04-FINDINGS.md` F-09 仍列为问题 ⇒ 说明有人修了漂移但忘了更新文档。
 */
claim('F-09', '文档/注释中的过时数字（复审时 5 处，修完应为 0）', () => {
  const bad = [];
  const scan = [
    ['docs/02-design/ARCHITECTURE.md', /6\s*skills/],
    ['docs/05-peripherals/DEPLOYMENT.md', /6\s*skills/],
    ['delivery/uninstall.mjs', /8\s*connector\s*skills/i],
    ['delivery/pack-release.mjs', /8\s*个连接器\s*Skills/],
    ['delivery/install-host.mjs', /白名单\s*10\s*工具/],
  ];
  for (const [f, re] of scan) {
    if (!has(f)) continue;
    if (re.test(reads(f))) bad.push(f);
  }
  return {
    ok: bad.length === 0,
    detail:
      bad.length === 0
        ? '零漂移 —— 若 F-09 仍列为问题，请更新 04-FINDINGS 标记为已修'
        : `${bad.length}/5 处未修（复审基线值=5，属预期）：${bad.join(', ')}`,
  };
});

/* ══════════════════════════════════════════════════════════════════
 * F-11 · hermes 同层依赖
 * ══════════════════════════════════════════════════════════════════ */

/**
 * F-11 · 复审时记录「`adapter-agent-hermes` 静态依赖 workbuddy(+llm) 两包」
 * —— 这是「同层 adapter 互相依赖」的分层违规采样。
 *
 * **断言方向已于 2026-11-25 翻转**（阶段 1.3 删整包后）：
 * 包已不存在，`reads()` 必然 ENOENT。改为：包目录不存在 ⇒ PASS（违规载体已移除）；
 * 包回来 ⇒ FAIL（须复查分层违规是否随之回潮）。
 */
claim('F-11', 'adapter-agent-hermes 整包已删除（阶段 1.3 交付，原为分层违规载体）', () => {
  const p = 'packages/adapter-agent-hermes';
  const present = has(p);
  return {
    ok: !present,
    detail: present
      ? `回潮：${p} 仍在（应已删除；须复查 hermes→workbuddy 同层依赖）`
      : '已删除（复审记录：同层依赖 workbuddy + workbuddy-llm 两包）',
  };
});

/* ══════════════════════════════════════════════════════════════════
 * 底盘数字（用于校验文档 §2）
 * ══════════════════════════════════════════════════════════════════ */

/**
 * BASE-1 · 复审时记录「12 个包 / 约 2.8 万行 TS」。
 *
 * **判据已于 2026-11-25 更新基线**：阶段 1.3 删 `adapter-agent-hermes` ⇒ 12 → **11 包**；
 * 而 V-NEXT 又新增 `planner.ts` / `unified.ts` / `gateway.ts` / `upstream-gate.ts` 等源文件
 * ⇒ 行数升到 **~29900**，不再是 2.8 万。
 * 这不是漂移，是方案交付后的**真实底盘**。判据改为「包数与行数均落在当前区间」，
 * 并打印复审值对照，防读者以为脚本被放宽。
 */
claim('BASE-1', '11 个包 / 约 3.0 万行 TS（复审 12 包 / 2.8 万 → 阶段 1.3 删包后的真实底盘）', () => {
  const pkgs = readdirSync(join(ROOT, 'packages')).filter((p) => has(join('packages', p, 'src')));
  const n = lines(walk('packages', '.ts'));
  return {
    ok: pkgs.length === 11 && n > 28000 && n < 32000,
    detail: `${pkgs.length} 包 / ${n} 行（复审基线 12 包 / ~28000 行；阶段 1.3 删 hermes 包）`,
  };
});

claim('BASE-2', 'skills 10 目录 / 120 文件（其中 110 为上游 vendor）', () => {
  const dirs = readdirSync(join(ROOT, 'skills')).filter((d) => has(join('skills', d, 'SKILL.md')));
  const all = walk('skills', '.md');
  const browser = walk('skills/agent-browser-skill', '.md').length;
  const desktop = walk('skills/agent-desktop-skill', '.md').length;
  return {
    ok: dirs.length === 10 && all.length === 120 && browser + desktop === 110,
    detail: `${dirs.length} 目录 / ${all.length} 文件；vendor=${browser}+${desktop}=${browser + desktop}`,
  };
});

claim('BASE-3', '54 个能力 / 风险分布 L0=27 L1=19 L2=7 L3=1', () => {
  const t = reads('packages/vm-capabilities/src/registry/definitions.ts');
  const risks = (t.match(/risk:\s*'(L\d)'/g) || []).map((s) => s.match(/'(L\d)'/)[1]);
  const c = {};
  for (const r of risks) c[r] = (c[r] || 0) + 1;
  const ok = risks.length === 54 && c.L0 === 27 && c.L1 === 19 && c.L2 === 7 && c.L3 === 1;
  return { ok, detail: `总计 ${risks.length}；${JSON.stringify(c)}` };
});

/* ══════════════════════════════════════════════════════════════════
 * 执行
 * ══════════════════════════════════════════════════════════════════ */

const results = [];
for (const { id, title, fn } of claims) {
  try {
    const r = fn();
    results.push({ id, title, ok: !!r.ok, detail: r.detail ?? '' });
  } catch (e) {
    results.push({ id, title, ok: false, detail: `EXCEPTION: ${e.message}` });
  }
}

if (JSON_OUT) {
  process.stdout.write(JSON.stringify({ root: ROOT, results }, null, 2) + '\n');
} else {
  const pad = Math.max(...results.map((r) => r.id.length));
  console.log(`架构复审证据复现 · root=${ROOT}\n`);
  for (const r of results) {
    const mark = r.ok ? 'PASS' : 'FAIL';
    console.log(`[${mark}] ${r.id.padEnd(pad)}  ${r.title}`);
    console.log(`         ${r.detail}`);
  }
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n${pass === results.length ? 'ALL_MATCH' : 'DRIFT_DETECTED'} ${pass}/${results.length}`);
  if (pass !== results.length) {
    console.log(
      '\nFAIL 说明代码已演进、文档需更新 —— 这是脚本的价值，不是脚本的 bug。\n' +
        '逐条核对 docs/design/proj-arch-review/04-FINDINGS.md 对应条目，改代码或改文档（二选一）。',
    );
  }
  process.exitCode = pass === results.length ? 0 : 1;
}
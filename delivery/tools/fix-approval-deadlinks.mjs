#!/usr/bin/env node
/**
 * fix-approval-deadlinks.mjs —— Q4 审批卡死链运行态修复（Phase 3 批2）
 *
 * 病灶（audit-qa ⑩-b）：11 条审批卡片模板死链污染**运行态**（宿主 connector skills 面 +
 * VM shared-skills 面），agent 读到的 SKILL.md 里审批模板引用指向不存在的路径，
 * "按模板输出审批卡"读不到文件 ⇒ 退化为自由发挥（CL-016"唯一模板 6/6 引用"承诺破功）。
 *
 * 死链形态（相对链接 target → 真身）：
 *   `../winvm-orchestrator/approval-card.md`        → 真身 `../winvm-orchestrator/references/approval-card.md`
 *   `./approval-card.md`（在 winvm-orchestrator/SKILL.md） → 真身 `./references/approval-card.md`
 *   `references/approval-card.md`                    → 已正确（不动）
 *   `./references/approval-card-widget.html`（orchestrator SKILL:280/323）
 *       → 真身**仅 connector 分发面有**（install-host 注入），shared-skills/仓库不带
 *         ⇒ 本脚本对 widget 引用**只探测不改写**（缺件属部署面差异，交 R-4/install-host 收敛；见 notes）
 *
 * 边界（重要）：
 *   - **源文件 skills/*.md 不在本脚本面内**（那是批0 的文档所有权，改源后重部署即根治）；
 *   - 本脚本修的是**已部署运行态副本**（宿主 connector skills 目录 / VM shared-skills 只读列清单），
 *     让"当前正跑着的 agent"立刻读到可达链接，不必等源修 + 重部署窗口。
 *   - 改写前**校验目标真身存在**（link-reachability 感知）：目标不存在 ⇒ SKIP 该条（绝不把死链改成另一死链）。
 *   - 幂等：已是正确路径不重复改；连跑两次第二次全 [SKIP]。
 *   - dry-run 默认（只报将改什么）；--apply 才写盘，写前备份 .winvm-bak.<ts>。
 *
 * VM 侧（真机面，本脚本不执行）：`--vm-recipe` 打印经 setup.mjs runRemotePs1 通道的配方。
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, copyFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

/**
 * 纯函数：把一条 SKILL.md 文本里的已知死链改写为正确相对路径。
 * 返回 { text, edits:[{from,to}], skips:[{from,reason}] }。
 * @param {string} text
 * @param {(targetRelPath:string)=>boolean} targetExists 校验改写后目标是否真实存在（相对本文件所在 skill 目录解析）
 * @param {string} skillDir 本 SKILL.md 所在目录（解析相对链接用）
 */
export function rewriteApprovalLinks(text, targetExists, skillDir) {
  const edits = [];
  const skips = [];
  let out = text;

  // 规则 1：`../winvm-orchestrator/approval-card.md` → `../winvm-orchestrator/references/approval-card.md`
  //         （5 领域 SKILL + 被引用文件自指都吃这条）
  {
    const from = '../winvm-orchestrator/approval-card.md';
    const to = '../winvm-orchestrator/references/approval-card.md';
    if (out.includes(from)) {
      // 改写后目标相对本 skill 目录（skillDir/../winvm-orchestrator/references/...）是否存在
      if (targetExists(join(skillDir, to))) {
        out = out.split(from).join(to);
        edits.push({ from, to });
      } else {
        skips.push({ from, reason: '改写后目标仍不存在（references/approval-card.md 缺失）' });
      }
    }
  }

  // 规则 2：`](./approval-card.md)` → `](./references/approval-card.md)`（orchestrator SKILL 内）
  //         仅匹配 markdown 链接/内联 code 里"文件名恰为 approval-card.md 且无前导 references/"
  {
    const re = /(\]\()?\.\/approval-card\.md\)?/g;
    const matches = [...out.matchAll(re)];
    if (matches.length) {
      const to = './references/approval-card.md';
      if (targetExists(join(skillDir, to))) {
        out = out.replace(/\.\/approval-card\.md/g, to);
        edits.push({ from: './approval-card.md', to, count: matches.length });
      } else {
        skips.push({ from: './approval-card.md', reason: '改写后目标 references/approval-card.md 不存在' });
      }
    }
  }

  return { text: out, edits, skips };
}

/**
 * 扫描一个 skills 根目录（含 <root>/<skill>/SKILL.md），返回每个 SKILL 的死链修复预览。
 * @param {string} root skills 根（connector skills 面或 shared-skills 面）
 */
export function planFixForRoot(root) {
  const plans = [];
  if (!existsSync(root)) return plans;
  for (const skill of readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
    const skillDir = join(root, skill);
    const mdPath = join(skillDir, 'SKILL.md');
    if (!existsSync(mdPath)) continue;
    const text = readFileSync(mdPath, 'utf8');
    const { text: fixed, edits, skips } = rewriteApprovalLinks(text, (p) => existsSync(p), skillDir);
    if (edits.length || skips.length) {
      plans.push({ skill, mdPath, changed: edits.length > 0, edits, skips, fixedText: fixed });
    }
  }
  return plans;
}

/**
 * 探测 widget 引用面（只报不改）：SKILL 引用 references/approval-card-widget.html，
 * 该件仅 connector 分发面（install-host 注入）有。缺件 ⇒ 记 WARN（交 R-4/deploy 收敛，非本脚本改写对象）。
 * @param {string} root
 */
export function probeWidgetReferences(root) {
  const report = [];
  if (!existsSync(root)) return report;
  for (const skill of readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
    const mdPath = join(root, skill, 'SKILL.md');
    if (!existsSync(mdPath)) continue;
    const text = readFileSync(mdPath, 'utf8');
    if (!text.includes('references/approval-card-widget.html')) continue;
    const widgetPath = join(root, skill, 'references', 'approval-card-widget.html');
    report.push({ skill, widgetExists: existsSync(widgetPath), widgetPath });
  }
  return report;
}

function parseArgs(argv) {
  const o = { apply: false, roots: [], vmRecipe: false, home: homedir() };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--apply': o.apply = true; break;
      case '--root': o.roots.push(argv[++i]); break;
      case '--home': o.home = argv[++i]; break;
      case '--vm-recipe': o.vmRecipe = true; break;
      default: break;
    }
  }
  // 默认对账宿主 connector skills 面（install-host 落地位置）
  if (o.roots.length === 0) {
    o.roots.push(join(o.home, '.workbuddy', 'connectors', 'skills', 'connector-winvm'));
  }
  return o;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log('=== Q4 审批卡死链运行态修复（' + (args.apply ? 'APPLY 写盘' : 'DRY-RUN 只报') + '）===');

  if (args.vmRecipe) {
    console.log('');
    console.log('--- VM shared-skills 面（真机，本脚本不执行）修复配方 ---');
    console.log('VM 侧 shared-skills（C:/WinVMBridge/shared-skills）同样含死链；修复=改源后重部署，或临时运行态修：');
    console.log('  1) 首选（根治）：修 skills/*.md 源 + node delivery/install-vm.mjs 重跑 deploySharedSkills（批0 改源 + deploy 后自然收敛）');
    console.log('  2) 临时运行态修（经 setup.mjs runRemotePs1 通道推 .ps1，勿 ssh 内联 PS）：');
    console.log('     对每个 <skill>/SKILL.md 用本 rewriteApprovalLinks 同规则做 (Get-Content -Raw) -replace 后写回；');
    console.log('     ⚠ 该面为 junction → 真身共享根，改写即生效于所有 Agent 引用；建议先跑批0 源修，避免与部署覆盖打架。');
    console.log('  判定命令（只读）：ssh <user>@<host> "grep -rn \'winvm-orchestrator/approval-card.md\' C:/WinVMBridge/shared-skills/*/SKILL.md"');
  }

  let totalChanged = 0;
  for (const root of args.roots) {
    console.log('');
    console.log(`面：${root}`);
    const plans = planFixForRoot(root);
    if (plans.length === 0) {
      console.log('  （无死链命中，或面不存在 —— 幂等：已修好/未部署都是空）');
    }
    for (const p of plans) {
      if (p.changed) {
        totalChanged += 1;
        console.log(`  [${args.apply ? 'FIX' : 'FIX(将改)'}] ${p.skill}/SKILL.md：${p.edits.map((e) => `${e.from} → ${e.to}`).join('; ')}`);
        if (args.apply) {
          const ts = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
          const bak = `${p.mdPath}.winvm-bak.${ts}`;
          copyFileSync(p.mdPath, bak);
          writeFileSync(p.mdPath, p.fixedText, 'utf8');
          console.log(`         已备份 ${bak} 并写回`);
        }
      }
      for (const s of p.skips) {
        console.log(`  [SKIP] ${p.skill}/SKILL.md：${s.from} —— ${s.reason}`);
      }
    }
    // widget 引用只探测
    for (const w of probeWidgetReferences(root)) {
      if (!w.widgetExists) {
        console.log(`  [WARN-WIDGET] ${w.skill}/SKILL.md 引用 references/approval-card-widget.html 但此面缺件（${w.widgetPath}）——` +
          '该件仅 connector 分发面由 install-host 注入，shared-skills/仓库不带；缺件交 install-host 分发面收敛，本脚本不改写。');
      }
    }
  }

  console.log('');
  if (!args.apply && totalChanged > 0) {
    console.log(`DRY-RUN：${totalChanged} 个 SKILL.md 将改。确认无误后加 --apply 写盘（自动备份）。`);
  } else if (args.apply) {
    console.log(`APPLY 完成：${totalChanged} 个 SKILL.md 已修（幂等：再跑一次将全 [SKIP]/空）。`);
  } else {
    console.log('无需修改（该面无死链）。');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

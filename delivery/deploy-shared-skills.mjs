#!/usr/bin/env node
/**
 * 共享 Skills 独立部署 + 各候选 VM AI Agent symlink 引用
 *
 * 设计要点（ADR-14）：
 *  - 单一事实源：skills 部署在独立于任何 Agent 的目录（默认 C:\WinVMBridge\skills）；
 *  - 两段式：① 发布 仓库 skills/ → 共享根（复制，使共享根脱离仓库路径独立存在）；
 *            ② 链接 共享根/<slug> → 各候选 Agent 的 skills 目录（symlink/junction）；
 *  - 各候选 Agent 仅以 symlink（Windows 目录用 junction，无需管理员特权）引用，
 *    不复制、不覆盖用户自有技能；
 *  - 幂等：已指向本共享源视为就位；已存在且非 symlink 则跳过并告警（绝不删除/覆盖）；
 *    共享根中仓库未提供的技能一律保留（用户扩展技能不受影响）。
 *
 * 纯函数 plan* 与副作用 apply / publish 分离 → 单元测试只调 plan，不触碰真实 Agent 目录。
 *
 * 用法：
 *   node delivery/deploy-shared-skills.mjs [--source <sharedRoot>] [--publish-from <repoSkillsDir>] [--apply]
 */

import { existsSync } from 'node:fs';
import { cp, lstat, mkdir, readdir, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** 共享 skills 默认部署根（注意：与仓库 skills/ 目录区分，避免自拷贝） */
export const DEFAULT_SHARED_SKILLS_ROOT = 'C:/WinVMBridge/shared-skills';

/**
 * 解析各候选 Agent 的原生 skills 目录（支持 %ENV% 展开）。
 * 未知/未安装 Agent 返回 dir=null，调用方跳过。
 */
export function resolveAgentSkillDirs(env = process.env) {
  // A2-10 边界注记：本文件是**自包含交付脚本**（运行环境未必能解析 @winvm/core dist，
  // 这正是历史多份同语义拷贝的成因），故有意保留内联实现而**不引权威源**；
  // 权威唯一化收敛范围=包内 src（core/constants.ts 单源，adapter/hermes/llm 已改引）。
  // 语义与 core 逐字一致：`%NAME%`→env 值，未命中原样保留（绝不吞成空串）。
  const expand = (p) =>
    p.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, n) => env[n] ?? m);

  const hermesHome = env.HERMES_HOME || (env.USERPROFILE ? `${env.USERPROFILE}\\.hermes` : '');
  const userProfile = env.USERPROFILE || '';

  return [
    {
      id: 'workbuddy',
      label: 'WorkBuddy',
      dir: userProfile ? expand(`${userProfile}\\.workbuddy\\skills`) : null,
    },
    {
      id: 'hermes-agent',
      label: 'Hermes Agent',
      dir: hermesHome ? expand(`${hermesHome}\\skills`) : null,
    },
  ];
}

/** 读取共享源中的技能目录名（仅含 SKILL.md 的目录才算合法技能） */
export async function listSharedSkills(sourceDir) {
  if (!sourceDir || !existsSync(sourceDir)) return [];
  const entries = await readdir(sourceDir, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (!existsSync(join(sourceDir, e.name, 'SKILL.md'))) continue;
    out.push(e.name);
  }
  return out.sort();
}

/**
 * 探测目标目录当前状况（供 plan 使用，无副作用）。
 * 返回 [{name, isSymlink, linkTarget}]
 */
export async function probeTargetDir(dir) {
  if (!dir || !existsSync(dir)) return { exists: false, entries: [] };
  const entries = await readdir(dir, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    let isSymlink = false;
    let linkTarget = null;
    try {
      const st = await lstat(full);
      isSymlink = st.isSymbolicLink();
      if (isSymlink) linkTarget = resolve(dir, await readlinkCompat(full));
    } catch {
      /* 读取失败按普通目录处理 */
    }
    out.push({ name: e.name, isSymlink, linkTarget });
  }
  return { exists: true, entries: out };
}

async function readlinkCompat(p) {
  const { readlink } = await import('node:fs/promises');
  return readlink(p);
}

/**
 * 纯函数：根据「共享源技能」与「各 Agent 目录现状」计算动作。
 *
 * @param {object} args
 * @param {string} args.sourceDir  共享 skills 根目录（绝对路径）
 * @param {string[]} args.skills   技能目录名列表
 * @param {Array} args.targets     [{id,label,dir,exists,entries}]
 * @returns {{actions: Array, summary: object}}
 */
export function planSharedSkillLinks({ sourceDir, skills, targets }) {
  const actions = [];
  for (const t of targets) {
    if (!t.dir) {
      actions.push({ agent: t.id, skill: null, action: 'skip-agent', reason: '未检测到该 Agent 的 skills 目录（可能未安装）' });
      continue;
    }
    const byName = new Map((t.entries || []).map((e) => [e.name, e]));
    for (const skill of skills) {
      const link = join(t.dir, skill);
      const source = join(sourceDir, skill);
      const cur = byName.get(skill);

      if (!cur) {
        actions.push({ agent: t.id, skill, source, link, action: 'create', reason: '新建 junction 指向共享源' });
        continue;
      }
      if (cur.isSymlink && cur.linkTarget && norm(cur.linkTarget) === norm(source)) {
        actions.push({ agent: t.id, skill, source, link, action: 'skip-ok', reason: '已就位（指向共享源）' });
        continue;
      }
      if (cur.isSymlink) {
        actions.push({ agent: t.id, skill, source, link, action: 'skip-conflict', reason: `已是指向其他位置的链接：${cur.linkTarget}` });
        continue;
      }
      actions.push({ agent: t.id, skill, source, link, action: 'skip-conflict', reason: '已存在同名真实目录（用户自有技能），跳过以免覆盖' });
    }
  }

  const summary = {
    create: actions.filter((a) => a.action === 'create').length,
    skipOk: actions.filter((a) => a.action === 'skip-ok').length,
    conflict: actions.filter((a) => a.action === 'skip-conflict').length,
    skipAgent: actions.filter((a) => a.action === 'skip-agent').length,
  };
  return { actions, summary };
}

/** Windows 路径归一化比较（反斜杠/大小写/尾部斜杠） */
export function norm(p) {
  return String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * 执行 plan：仅为 create 动作创建 junction。
 * 目录型 symlink 在 Windows 上用 'junction'，无需管理员特权。
 */
export async function applySharedSkillLinks(plan, { dryRun = false } = {}) {
  const results = [];
  for (const a of plan.actions) {
    if (a.action !== 'create') {
      results.push({ ...a, applied: false });
      continue;
    }
    if (dryRun) {
      results.push({ ...a, applied: false, dryRun: true });
      continue;
    }
    try {
      await mkdir(a.agent ? dirOf(a.link) : a.link, { recursive: true }).catch(() => {});
      await symlink(a.source, a.link, 'junction');
      results.push({ ...a, applied: true });
    } catch (e) {
      results.push({ ...a, applied: false, error: (e && e.message) || String(e), reason: `创建失败：${(e && e.message) || e}` });
    }
  }
  return results;
}

function dirOf(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i <= 0 ? p : p.slice(0, i);
}

/* ---------------- 发布：仓库 skills/ → 共享根（单一事实源） ---------------- */

/**
 * 纯函数：计算「仓库技能」发布到共享根需要的动作。
 * 共享根是各 Agent symlink 的唯一目标，因此这里用「复制覆盖」而非链接，
 * 使共享根脱离仓库路径独立存在（仓库/产物可搬迁，VM 侧配置 skillsRoot 不变）。
 *
 * @param {{repoSkills: string[], sharedSkills: string[]}} args
 * @returns {{actions: Array, summary: object}}
 */
export function planSkillPublish({ repoSkills = [], sharedSkills = [] } = {}) {
  const present = new Set(sharedSkills);
  const actions = repoSkills.map((skill) => ({
    skill,
    action: present.has(skill) ? 'refresh' : 'add',
    reason: present.has(skill) ? '共享根已有同名技能，覆盖刷新内容' : '共享根缺失，新增发布',
  }));
  // 共享根中存在但仓库没有的技能：保留（可能是用户自行放入的扩展技能），仅提示
  for (const skill of sharedSkills) {
    if (!repoSkills.includes(skill)) {
      actions.push({ skill, action: 'keep-extra', reason: '共享根独有技能（非本仓库提供），保留不动' });
    }
  }
  return {
    actions,
    summary: {
      add: actions.filter((a) => a.action === 'add').length,
      refresh: actions.filter((a) => a.action === 'refresh').length,
      keepExtra: actions.filter((a) => a.action === 'keep-extra').length,
    },
  };
}

/**
 * 把仓库 skills/ 发布到共享根（幂等；只覆盖同名技能内容，不删除共享根中的其他技能）。
 */
export async function publishSharedSkills({
  repoSkillsDir,
  sharedRoot = DEFAULT_SHARED_SKILLS_ROOT,
  dryRun = false,
  log = () => {},
} = {}) {
  const repoSkills = await listSharedSkills(repoSkillsDir);
  if (!repoSkills.length) {
    log(`仓库 skills 源为空或不存在：${repoSkillsDir}`);
    return { repoSkills: [], plan: null, results: [] };
  }
  // 守卫：发布源与共享根指向同一目录时跳过发布（避免 cp 自拷贝报 EINVAL）
  if (norm(repoSkillsDir) === norm(sharedRoot)) {
    log(`发布源与共享根相同（${sharedRoot}），跳过发布步骤`);
    const plan = planSkillPublish({ repoSkills, sharedSkills: repoSkills });
    return { repoSkills, plan, results: plan.actions.map((a) => ({ ...a, applied: false, skipped: true })) };
  }
  const sharedSkills = await listSharedSkills(sharedRoot);
  const plan = planSkillPublish({ repoSkills, sharedSkills });

  const results = [];
  for (const a of plan.actions) {
    if (a.action === 'keep-extra' || dryRun) {
      results.push({ ...a, applied: false, dryRun: dryRun && a.action !== 'keep-extra' });
      continue;
    }
    try {
      await mkdir(sharedRoot, { recursive: true });
      await cp(join(repoSkillsDir, a.skill), join(sharedRoot, a.skill), {
        recursive: true,
        force: true,
      });
      results.push({ ...a, applied: true });
    } catch (e) {
      results.push({ ...a, applied: false, error: (e && e.message) || String(e), reason: `发布失败：${(e && e.message) || e}` });
    }
  }
  return { repoSkills, plan, results };
}

/** 端到端：探测 → plan → apply */
export async function deploySharedSkills({
  sourceDir = DEFAULT_SHARED_SKILLS_ROOT,
  publishFrom,
  agents,
  env = process.env,
  dryRun = false,
  log = () => {},
} = {}) {
  let publish = null;
  if (publishFrom) {
    publish = await publishSharedSkills({ repoSkillsDir: publishFrom, sharedRoot: sourceDir, dryRun, log });
  }
  const skills = await listSharedSkills(sourceDir);
  if (!skills.length) {
    log(`共享 skills 源为空或不存在：${sourceDir}`);
    return { publish, skills: [], plan: null, results: [] };
  }
  const targets = [];
  for (const a of agents || resolveAgentSkillDirs(env)) {
    if (!a.dir) {
      targets.push({ ...a, exists: false, entries: [] });
      continue;
    }
    const probe = await probeTargetDir(a.dir);
    targets.push({ ...a, exists: probe.exists, entries: probe.entries });
  }
  const plan = planSharedSkillLinks({ sourceDir, skills, targets });
  const results = await applySharedSkillLinks(plan, { dryRun });
  return { publish, skills, plan, results };
}

/* ---------------- CLI ---------------- */
const isMain = process.argv[1] && /deploy-shared-skills\.mjs$/.test(process.argv[1]);
if (isMain) {
  const argOf = (flag) => {
    const i = process.argv.indexOf(flag);
    return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
  };
  const dryRun = !process.argv.includes('--apply');
  const src = argOf('--source') ?? DEFAULT_SHARED_SKILLS_ROOT;
  const publishFrom = argOf('--publish-from');

  const { publish, skills, plan, results } = await deploySharedSkills({
    sourceDir: src,
    publishFrom,
    dryRun,
    log: (m) => console.log(m),
  });

  console.log(`共享 skills 源：${src}`);
  if (publish?.plan) {
    console.log(`\n[发布] 仓库源：${publishFrom}`);
    for (const r of publish.results) {
      const tag = r.action === 'keep-extra' ? '保留' : r.applied ? '已发布' : dryRun ? '将发布' : `失败(${r.error || '?'})`;
      console.log(`  [${tag}] ${r.skill} — ${r.reason || ''}`);
    }
    console.log(`  汇总：新增 ${publish.plan.summary.add} / 刷新 ${publish.plan.summary.refresh} / 共享根独有保留 ${publish.plan.summary.keepExtra}`);
  }
  console.log(`\n[链接] 技能（${skills.length}）：${skills.join(', ')}`);
  for (const r of results) {
    const tag = r.action === 'create' ? (r.applied ? '已创建' : dryRun ? '将创建' : `失败(${r.error || '?'})`) : r.action;
    console.log(`  [${tag}] ${r.agent}${r.skill ? `/${r.skill}` : ''} — ${r.reason || ''}`);
  }
  if (plan) console.log(`\n汇总：新建 ${plan.summary.create} / 已就位 ${plan.summary.skipOk} / 冲突跳过 ${plan.summary.conflict} / Agent 缺失 ${plan.summary.skipAgent}`);
  if (dryRun) console.log('\n（dry-run：加 --apply 真正发布并创建 junction）');
}

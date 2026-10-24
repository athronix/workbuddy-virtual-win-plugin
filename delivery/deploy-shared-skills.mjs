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
 *    共享根中仓库未提供的技能一律保留（用户扩展技能不受影响）；
 *  - **host-only 排除**（HOST_ONLY_SKILLS）：宿主侧技能在交付链两段式均被排除——
 *    仓库侧不发布（skip-host-only）、共享根历史误分发残留清理（remove）、
 *    各 Agent 目录历史 junction 摘除（remove-link），VM 内 Agent 绝不应见到它们。
 *
 * 纯函数 plan* 与副作用 apply / publish 分离 → 单元测试只调 plan，不触碰真实 Agent 目录。
 *
 * 用法：
 *   node delivery/deploy-shared-skills.mjs [--source <sharedRoot>] [--publish-from <repoSkillsDir>] [--apply]
 */

import { existsSync } from 'node:fs';
import { cp, lstat, mkdir, readdir, rm, rmdir, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** 共享 skills 默认部署根（注意：与仓库 skills/ 目录区分，避免自拷贝） */
export const DEFAULT_SHARED_SKILLS_ROOT = 'C:/WinVMBridge/shared-skills';

/**
 * Host-only 技能名单：宿主侧技能，**绝不**分发到 VM 共享根与各 VM Agent 技能目录。
 *
 * 背景：`hos-win-skill` 的受众是宿主（鸿蒙）Agent 的「要不要走 winvm 通道」任务分派预判；
 * VM 内 Agent 的一切操作以 `winvm-orchestrator` 为唯一入口。SKILL.md 内的作用域声明
 * 只是缓解（VM 内 Agent 仍能读到全文），本名单在**交付链**做根治性排除：
 *  - 发布段：仓库侧不发布（skip-host-only）、共享根历史误分发残留清理（remove）；
 *  - 链接段：各 Agent 目录中指向共享源的历史 junction/symlink 摘除（remove-link）。
 * 新增宿主侧技能时加入本名单（两侧交付脚本与测试同源引用，勿在别处硬编码名单）。
 */
export const HOST_ONLY_SKILLS = ['hos-win-skill'];

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
 * host-only 防御（HOST_ONLY_SKILLS）：技能循环前对入参 skills 过滤 host-only
 * （调用方传未过滤列表也绝不建 junction）；循环结束后再对每个 target 检查
 * host-only 历史残留——指向共享源的 symlink/junction 摘除（remove-link），
 * 真实目录或指向其他位置的链接不碰。
 *
 * @param {object} args
 * @param {string} args.sourceDir  共享 skills 根目录（绝对路径）
 * @param {string[]} args.skills   技能目录名列表
 * @param {Array} args.targets     [{id,label,dir,exists,entries}]
 * @returns {{actions: Array, summary: object}}
 */
export function planSharedSkillLinks({ sourceDir, skills, targets }) {
  const actions = [];
  // 防御性过滤：host-only 技能绝不建 junction（即便调用方传入未过滤列表）
  const linkSkills = (skills || []).filter((s) => !HOST_ONLY_SKILLS.includes(s));
  for (const t of targets) {
    if (!t.dir) {
      actions.push({ agent: t.id, skill: null, action: 'skip-agent', reason: '未检测到该 Agent 的 skills 目录（可能未安装）' });
      continue;
    }
    const byName = new Map((t.entries || []).map((e) => [e.name, e]));
    for (const skill of linkSkills) {
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
    // host-only 历史残留清理：仅摘「指向共享源」的 symlink/junction（历史误分发产物）；
    // 真实目录（用户自行放入的内容）或指向其他位置的链接一律不碰。
    for (const skill of HOST_ONLY_SKILLS) {
      const cur = byName.get(skill);
      if (!cur || !cur.isSymlink || !cur.linkTarget) continue;
      const source = join(sourceDir, skill);
      if (norm(cur.linkTarget) !== norm(source)) continue;
      actions.push({
        agent: t.id,
        skill,
        source,
        link: join(t.dir, skill),
        action: 'remove-link',
        reason: 'host-only 历史 junction 清理（指向共享源的残留链接，摘除链接本身不碰目标）',
      });
    }
  }

  const summary = {
    create: actions.filter((a) => a.action === 'create').length,
    skipOk: actions.filter((a) => a.action === 'skip-ok').length,
    conflict: actions.filter((a) => a.action === 'skip-conflict').length,
    skipAgent: actions.filter((a) => a.action === 'skip-agent').length,
    removeLink: actions.filter((a) => a.action === 'remove-link').length,
  };
  return { actions, summary };
}

/** Windows 路径归一化比较（反斜杠/大小写/尾部斜杠） */
export function norm(p) {
  return String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * 执行 plan：create 动作创建 junction；remove-link 动作摘除 host-only 残留链接。
 * 目录型 symlink 在 Windows 上用 'junction'，无需管理员特权。
 *
 * remove-link 安全语义：先 lstat 确认类型——symlink 用 `rm(force)` 摘除链接本身；
 * Windows junction 在 lstat 下表现为目录，用 `rmdir` 摘除链接本身（reparse point）。
 * **两者都绝不递归进目标目录**；其余非 create 动作保持不 apply。
 */
export async function applySharedSkillLinks(plan, { dryRun = false } = {}) {
  const results = [];
  for (const a of plan.actions) {
    if (a.action === 'remove-link') {
      if (dryRun) {
        results.push({ ...a, applied: false, dryRun: true });
        continue;
      }
      try {
        const st = await lstat(a.link);
        if (st.isSymbolicLink() || !st.isDirectory()) {
          // symlink（或异常的文件型条目）：rm 只摘链接本身，不碰目标
          await rm(a.link, { force: true });
        } else {
          // Windows junction：lstat 表现为目录 → rmdir 摘除链接本身（非递归）
          await rmdir(a.link);
        }
        results.push({ ...a, applied: true });
      } catch (e) {
        results.push({ ...a, applied: false, error: (e && e.message) || String(e), reason: `摘除失败：${(e && e.message) || e}` });
      }
      continue;
    }
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
 * host-only 语义（HOST_ONLY_SKILLS）：
 *  - repoSkills 中的 host-only → `skip-host-only`（宿主侧技能，不发布到 VM 共享根）；
 *  - sharedSkills 中的 host-only → `remove`（清理历史误分发残留，根治语义倒挂）。
 *
 * @param {{repoSkills: string[], sharedSkills: string[]}} args
 * @returns {{actions: Array, summary: object}}
 */
export function planSkillPublish({ repoSkills = [], sharedSkills = [] } = {}) {
  const present = new Set(sharedSkills);
  const actions = repoSkills.map((skill) => {
    if (HOST_ONLY_SKILLS.includes(skill)) {
      return { skill, action: 'skip-host-only', reason: '宿主侧技能（host-only），不发布到 VM 共享根' };
    }
    return {
      skill,
      action: present.has(skill) ? 'refresh' : 'add',
      reason: present.has(skill) ? '共享根已有同名技能，覆盖刷新内容' : '共享根缺失，新增发布',
    };
  });
  // 共享根中存在但仓库没有的技能：保留（可能是用户自行放入的扩展技能），仅提示；
  // host-only 残留（历史误分发）→ remove 清理。
  for (const skill of sharedSkills) {
    if (HOST_ONLY_SKILLS.includes(skill)) {
      actions.push({ skill, action: 'remove', reason: 'host-only 技能历史误分发残留，从共享根清理' });
      continue;
    }
    if (!repoSkills.includes(skill)) {
      actions.push({ skill, action: 'keep-extra', reason: '共享根独有技能（非本仓库提供），保留不动' });
    }
  }
  return {
    actions,
    summary: {
      add: actions.filter((a) => a.action === 'add').length,
      refresh: actions.filter((a) => a.action === 'refresh').length,
      remove: actions.filter((a) => a.action === 'remove').length,
      keepExtra: actions.filter((a) => a.action === 'keep-extra').length,
      skipHostOnly: actions.filter((a) => a.action === 'skip-host-only').length,
    },
  };
}

/**
 * 把仓库 skills/ 发布到共享根（幂等；只覆盖同名技能内容，不删除共享根中的其他技能）。
 * host-only 技能不发布（skip-host-only）；共享根中的 host-only 残留被清理（remove）。
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
    // keep-extra / skip-host-only / dry-run 一律不写盘（host-only 不发布，见 HOST_ONLY_SKILLS）
    if (a.action === 'keep-extra' || a.action === 'skip-host-only' || dryRun) {
      results.push({ ...a, applied: false, dryRun: dryRun && a.action !== 'keep-extra' && a.action !== 'skip-host-only' });
      continue;
    }
    try {
      if (a.action === 'remove') {
        await rm(join(sharedRoot, a.skill), { recursive: true, force: true });
        results.push({ ...a, applied: true });
        continue;
      }
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
  // 返回/打印口径过滤 host-only（listSharedSkills 本身保持纯净：它只回答"共享根里有什么"，
  // 过滤由交付链消费方负责，避免把展示口径污染成事实口径）
  const visibleSkills = skills.filter((s) => !HOST_ONLY_SKILLS.includes(s));
  return { publish, skills: visibleSkills, plan, results };
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
      const tag =
        r.action === 'keep-extra'
          ? '保留'
          : r.action === 'skip-host-only'
            ? '跳过(host-only)'
            : r.action === 'remove'
              ? r.applied
                ? '已清理'
                : dryRun
                  ? '将清理'
                  : `失败(${r.error || '?'})`
              : r.applied
                ? '已发布'
                : dryRun
                  ? '将发布'
                  : `失败(${r.error || '?'})`;
      console.log(`  [${tag}] ${r.skill} — ${r.reason || ''}`);
    }
    const ps = publish.plan.summary;
    console.log(
      `  汇总：新增 ${ps.add} / 刷新 ${ps.refresh} / 清理 ${ps.remove} / 共享根独有保留 ${ps.keepExtra} / host-only 跳过 ${ps.skipHostOnly}`,
    );
  }
  console.log(`\n[链接] 技能（${skills.length}）：${skills.join(', ')}`);
  for (const r of results) {
    const tag =
      r.action === 'create'
        ? r.applied
          ? '已创建'
          : dryRun
            ? '将创建'
            : `失败(${r.error || '?'})`
        : r.action === 'remove-link'
          ? r.applied
            ? '已摘除'
            : dryRun
              ? '将摘除'
              : `失败(${r.error || '?'})`
          : r.action;
    console.log(`  [${tag}] ${r.agent}${r.skill ? `/${r.skill}` : ''} — ${r.reason || ''}`);
  }
  if (plan) {
    console.log(
      `\n汇总：新建 ${plan.summary.create} / 已就位 ${plan.summary.skipOk} / 冲突跳过 ${plan.summary.conflict} / ` +
        `Agent 缺失 ${plan.summary.skipAgent} / host-only 摘除 ${plan.summary.removeLink}`,
    );
  }
  if (dryRun) console.log('\n（dry-run：加 --apply 真正发布并创建 junction）');
}

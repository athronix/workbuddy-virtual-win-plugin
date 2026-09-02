#!/usr/bin/env node
/**
 * 为「仅含 dist 的分发产物」建立 @winvm/* workspace 解析软链
 *
 * ── 为什么需要这一步 ────────────────────────────────────────────────
 * 宿主 setup.mjs 分发给远端 Windows 的产物 = delivery + skills +
 * packages/<pkg>/dist + packages/<pkg>/package.json，**不含 node_modules**，
 * 且远端以 --skip-install 跳过 npm ci。
 *
 * 而 dist 中 import 的是裸包名（from '@winvm/core'）：ESM 不重写说明符，
 * 必须经 node_modules 才能解析。若不建软链，远端自检与常驻服务都会直接
 * `ERR_MODULE_NOT_FOUND: Cannot find package '@winvm/core'`。
 *
 * 又不能靠「去掉 --skip-install」来补救：
 *  - npm ci 需要 package-lock.json 与各包源码（产物里两者都没有）；
 *  - npm install 会去 registry 拉取 @winvm/*，而它们是**未发布的内部包**，必然失败。
 *
 * 幸而全部包的 dependencies 均为内部 @winvm/*、**零外部 npm 依赖**，
 * 因此只要把 node_modules/@winvm/<pkg> 指向 packages/<pkg> 即可运行，
 * 无需 npm ci、无需联网。
 *
 * ── 做法 ────────────────────────────────────────────────────────────
 *   node_modules/@winvm/<pkg> → ../../packages/<pkg>
 * 目录型 symlink 在 Windows 上用 'junction'，无需管理员特权
 * （与 deploy-shared-skills.mjs 的 shared-skills 引用范式一致）。
 *
 * 幂等：已指向 packages/<pkg> 视为就位；指向别处、或已存在同名真实目录
 * 则跳过并告警，绝不删除/覆盖。
 *
 * 纯函数 planWorkspaceLinks 与副作用 applyWorkspaceLinks 分离 → 单测只测 plan。
 *
 * 用法：
 *   node delivery/link-workspace.mjs [--root <deployRoot>] [--apply]
 *   缺省 --root 为当前目录；不加 --apply 即 dry-run。
 */

import { existsSync } from 'node:fs';
import { mkdir, readdir, readlink, symlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/** Windows 路径归一化比较（反斜杠 / 大小写 / 尾部斜杠） */
export function norm(p) {
  return String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * 扫描 packages/ 下所有带 package.json 的包，产出待链接项。
 * @param {string} repoRoot 部署根（packages/ 的父目录）
 * @returns {Promise<Array<{name:string,target:string,link:string}>>}
 */
export async function discoverPackages(repoRoot) {
  const pkgRoot = join(repoRoot, 'packages');
  if (!existsSync(pkgRoot)) return [];
  const entries = await readdir(pkgRoot, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const pkgDir = join(pkgRoot, e.name);
    if (!existsSync(join(pkgDir, 'package.json'))) continue;
    out.push({
      name: e.name,
      target: pkgDir,
      link: join(repoRoot, 'node_modules', '@winvm', e.name),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 探测 node_modules/@winvm 目录现状（无副作用），供 plan 使用。
 *
 * 用 readlink 判定是否为链接而非 lstat().isSymbolicLink()：
 * junction 与 symlink 都能被 readlink 读出目标，避免依赖平台差异。
 */
export async function probeLinkDir(dir) {
  if (!dir || !existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    let isLink = false;
    let linkTarget = null;
    try {
      linkTarget = resolve(dir, await readlink(full));
      isLink = true;
    } catch {
      /* 不是链接（普通目录/文件），按冲突处理 */
    }
    out.push({ name: e.name, isLink, linkTarget });
  }
  return out;
}

/**
 * 纯函数：根据「待链接包」与「现有 @winvm 目录」计算动作。
 *
 * @param {object} args
 * @param {Array<{name:string,target:string,link:string}>} args.packages
 * @param {Array<{name:string,isLink:boolean,linkTarget:string|null}>} args.existing
 * @returns {{actions: Array, summary: {create:number, skipOk:number, conflict:number}}}
 */
export function planWorkspaceLinks({ packages = [], existing = [] } = {}) {
  const byName = new Map(existing.map((e) => [e.name, e]));
  const actions = [];
  for (const pkg of packages) {
    const cur = byName.get(pkg.name);
    if (!cur) {
      actions.push({
        name: pkg.name,
        link: pkg.link,
        target: pkg.target,
        action: 'create',
        reason: '缺失软链 → 新建 junction 指向 packages/<pkg>',
      });
      continue;
    }
    if (cur.isLink && cur.linkTarget && norm(cur.linkTarget) === norm(pkg.target)) {
      actions.push({
        name: pkg.name,
        link: pkg.link,
        target: pkg.target,
        action: 'skip-ok',
        reason: '已就位（指向 packages/<pkg>）',
      });
      continue;
    }
    if (cur.isLink) {
      actions.push({
        name: pkg.name,
        link: pkg.link,
        target: pkg.target,
        action: 'skip-conflict',
        reason: `已是指向其他位置的链接：${cur.linkTarget}`,
      });
      continue;
    }
    actions.push({
      name: pkg.name,
      link: pkg.link,
      target: pkg.target,
      action: 'skip-conflict',
      reason: '已存在同名真实目录/文件，跳过以免覆盖',
    });
  }
  const count = (a) => actions.filter((x) => x.action === a).length;
  return {
    actions,
    summary: { create: count('create'), skipOk: count('skip-ok'), conflict: count('skip-conflict') },
  };
}

/**
 * 执行 plan：仅为 create 动作建立 junction。
 * 目录型 symlink 在 Windows 上用 'junction'，无需管理员特权。
 */
export async function applyWorkspaceLinks(plan, { dryRun = false } = {}) {
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
      await mkdir(dirname(a.link), { recursive: true });
      await symlink(a.target, a.link, 'junction');
      results.push({ ...a, applied: true });
    } catch (e) {
      const msg = (e && e.message) || String(e);
      results.push({ ...a, applied: false, error: msg, reason: `创建 junction 失败：${msg}` });
    }
  }
  return results;
}

/** 端到端：扫描 → 探测 → plan → apply */
export async function ensureWorkspaceLinks({ repoRoot, dryRun = false, log = () => {} } = {}) {
  const packages = await discoverPackages(repoRoot);
  if (!packages.length) {
    log(`未发现 packages/*/package.json，跳过软链（${join(repoRoot, 'packages')} 不存在或为空）`);
    return { packages: [], plan: null, results: [] };
  }
  const existing = await probeLinkDir(join(repoRoot, 'node_modules', '@winvm'));
  const plan = planWorkspaceLinks({ packages, existing });
  const results = await applyWorkspaceLinks(plan, { dryRun });
  return { packages, plan, results };
}

/* ---------------- CLI ---------------- */
const isMain = process.argv[1] && /link-workspace\.mjs$/.test(process.argv[1]);
if (isMain) {
  const argOf = (flag) => {
    const i = process.argv.indexOf(flag);
    return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
  };
  const dryRun = !process.argv.includes('--apply');
  const repoRoot = resolve(argOf('--root') ?? process.cwd());

  console.log(`部署根：${repoRoot}`);
  const { packages, plan, results } = await ensureWorkspaceLinks({
    repoRoot,
    dryRun,
    log: (m) => console.log(m),
  });

  if (!plan) {
    console.log('无可链接的包。');
  } else {
    console.log(`\n[workspace 软链] 包（${packages.length}）：${packages.map((p) => p.name).join(', ')}`);
    for (const r of results) {
      const tag =
        r.action === 'create'
          ? r.applied
            ? '已创建'
            : dryRun
              ? '将创建'
              : `失败(${r.error || '?'})`
          : r.action;
      console.log(`  [${tag}] @winvm/${r.name} — ${r.reason || ''}`);
    }
    console.log(
      `\n汇总：新建 ${plan.summary.create} / 已就位 ${plan.summary.skipOk} / 冲突跳过 ${plan.summary.conflict}`,
    );
  }
  if (dryRun) console.log('\n（dry-run：加 --apply 真正创建 junction）');
}

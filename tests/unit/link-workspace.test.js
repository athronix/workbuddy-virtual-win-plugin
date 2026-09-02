/**
 * @winvm workspace 软链（delivery/link-workspace.mjs）单元测试
 *
 * 背景：宿主分发的产物只有 dist + package.json（不含 node_modules），
 * 而 dist 中 import 的是裸包名（from '@winvm/core'），ESM 必须经 node_modules 解析。
 * 本模块负责补上 node_modules/@winvm/<pkg> → packages/<pkg> 的 junction。
 *
 * 单测聚焦纯函数 planWorkspaceLinks，并用临时目录验证 junction 的创建与幂等。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, symlink, readlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  norm,
  planWorkspaceLinks,
  applyWorkspaceLinks,
  discoverPackages,
  probeLinkDir,
  ensureWorkspaceLinks,
} from '../../delivery/link-workspace.mjs';

/** 建一个临时「部署根」，内含若干带 package.json + dist 的包 */
async function makeRoot(pkgNames) {
  const root = await mkdtemp(join(tmpdir(), 'winvm-links-'));
  for (const n of pkgNames) {
    await mkdir(join(root, 'packages', n, 'dist'), { recursive: true });
    await writeFile(
      join(root, 'packages', n, 'package.json'),
      JSON.stringify({ name: `@winvm/${n}`, main: 'dist/index.js' }),
      'utf8',
    );
  }
  return root;
}

describe('norm', () => {
  test('忽略反斜杠 / 大小写 / 尾部斜杠差异', () => {
    assert.equal(norm('D:\\dep\\packages\\core'), norm('D:/dep/packages/core'));
    assert.equal(norm('D:/dep/packages/core/'), norm('D:/dep/packages/core'));
    assert.equal(norm('D:/DEP/Packages/Core'), norm('d:/dep/packages/core'));
  });
});

describe('planWorkspaceLinks（纯函数）', () => {
  const pkgs = [
    { name: 'core', target: 'D:/dep/packages/core', link: 'D:/dep/node_modules/@winvm/core' },
    {
      name: 'vm-service',
      target: 'D:/dep/packages/vm-service',
      link: 'D:/dep/node_modules/@winvm/vm-service',
    },
  ];

  test('缺失软链 → create', () => {
    const { actions, summary } = planWorkspaceLinks({ packages: pkgs, existing: [] });
    assert.equal(actions.length, 2);
    assert.ok(actions.every((a) => a.action === 'create'));
    assert.equal(summary.create, 2);
  });

  test('已指向 packages/<pkg> → skip-ok（幂等，含路径风格差异）', () => {
    const existing = [{ name: 'core', isLink: true, linkTarget: 'D:\\dep\\packages\\core' }];
    const { actions, summary } = planWorkspaceLinks({ packages: pkgs, existing });
    assert.equal(actions.find((a) => a.name === 'core').action, 'skip-ok');
    assert.equal(summary.skipOk, 1);
    assert.equal(summary.create, 1); // vm-service 仍待建
  });

  test('指向其他位置 → skip-conflict（不覆盖）', () => {
    const existing = [{ name: 'core', isLink: true, linkTarget: 'D:/somewhere/else/core' }];
    const { actions, summary } = planWorkspaceLinks({ packages: pkgs, existing });
    const core = actions.find((a) => a.name === 'core');
    assert.equal(core.action, 'skip-conflict');
    assert.match(core.reason, /其他位置/);
    assert.equal(summary.conflict, 1);
  });

  test('已存在同名真实目录 → skip-conflict（绝不删除/覆盖用户内容）', () => {
    const existing = [{ name: 'core', isLink: false, linkTarget: null }];
    const { actions } = planWorkspaceLinks({ packages: pkgs, existing });
    const core = actions.find((a) => a.name === 'core');
    assert.equal(core.action, 'skip-conflict');
    assert.match(core.reason, /真实目录/);
  });

  test('空包列表 → 无动作', () => {
    const { actions, summary } = planWorkspaceLinks({ packages: [], existing: [] });
    assert.equal(actions.length, 0);
    assert.deepEqual(summary, { create: 0, skipOk: 0, conflict: 0 });
  });

  test('缺省参数不抛错', () => {
    const { actions } = planWorkspaceLinks();
    assert.deepEqual(actions, []);
  });
});

describe('discoverPackages', () => {
  test('只收录带 package.json 的目录，并给出 link 路径', async () => {
    const root = await makeRoot(['core', 'vm-service']);
    try {
      // 无 package.json 的目录应被忽略
      await mkdir(join(root, 'packages', 'no-manifest', 'dist'), { recursive: true });
      const pkgs = await discoverPackages(root);
      assert.deepEqual(
        pkgs.map((p) => p.name),
        ['core', 'vm-service'],
      );
      assert.equal(pkgs[0].target, join(root, 'packages', 'core'));
      assert.equal(pkgs[0].link, join(root, 'node_modules', '@winvm', 'core'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('packages 目录不存在 → 空数组', async () => {
    assert.deepEqual(await discoverPackages(resolve(tmpdir(), 'winvm-nope-xyz')), []);
  });
});

describe('probeLinkDir', () => {
  test('junction 识别为链接并读出目标；普通目录不是链接', async () => {
    const root = await makeRoot(['core']);
    try {
      const nm = join(root, 'node_modules', '@winvm');
      await mkdir(nm, { recursive: true });
      await symlink(join(root, 'packages', 'core'), join(nm, 'core'), 'junction');
      await mkdir(join(nm, 'plain-real-dir'), { recursive: true });

      const probe = await probeLinkDir(nm);
      const core = probe.find((e) => e.name === 'core');
      const plain = probe.find((e) => e.name === 'plain-real-dir');
      assert.equal(core.isLink, true, 'junction 应被识别为链接');
      assert.equal(norm(core.linkTarget), norm(join(root, 'packages', 'core')));
      assert.equal(plain.isLink, false, '真实目录不应被当作链接');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('目录不存在 → 空数组', async () => {
    assert.deepEqual(await probeLinkDir(resolve(tmpdir(), 'winvm-nope-xyz', 'nm', '@winvm')), []);
  });
});

describe('applyWorkspaceLinks', () => {
  test('create 动作真正建立 junction；dry-run 不落盘', async () => {
    const root = await makeRoot(['core']);
    const link = join(root, 'node_modules', '@winvm', 'core');
    try {
      const plan = planWorkspaceLinks({
        packages: [{ name: 'core', target: join(root, 'packages', 'core'), link }],
        existing: [],
      });

      const dry = await applyWorkspaceLinks(plan, { dryRun: true });
      assert.equal(dry[0].applied, false);
      assert.equal(dry[0].dryRun, true);
      assert.equal(existsSync(link), false, 'dry-run 不应创建软链');

      const applied = await applyWorkspaceLinks(plan, {});
      assert.equal(applied[0].applied, true);
      assert.equal(norm(await readlink(link)), norm(join(root, 'packages', 'core')));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('非 create 动作不落盘', async () => {
    const results = await applyWorkspaceLinks({ actions: [{ name: 'x', action: 'skip-ok' }] }, {});
    assert.equal(results[0].applied, false);
  });
});

describe('ensureWorkspaceLinks（端到端 · 幂等）', () => {
  test('首次全新建，再次全部已就位', async () => {
    const root = await makeRoot(['core', 'vm-service', 'contracts']);
    try {
      const first = await ensureWorkspaceLinks({ repoRoot: root });
      assert.equal(first.plan.summary.create, 3);
      assert.equal(first.plan.summary.skipOk, 0);

      const probe = await probeLinkDir(join(root, 'node_modules', '@winvm'));
      assert.equal(probe.filter((e) => e.isLink).length, 3);

      const second = await ensureWorkspaceLinks({ repoRoot: root });
      assert.equal(second.plan.summary.create, 0, '再次执行不应重复创建');
      assert.equal(second.plan.summary.skipOk, 3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('dry-run 不创建任何软链', async () => {
    const root = await makeRoot(['core']);
    try {
      const res = await ensureWorkspaceLinks({ repoRoot: root, dryRun: true });
      assert.equal(res.plan.summary.create, 1);
      assert.equal(existsSync(join(root, 'node_modules', '@winvm', 'core')), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('无 packages 目录时安全返回（不抛错）', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'winvm-empty-'));
    try {
      const res = await ensureWorkspaceLinks({ repoRoot: empty });
      assert.deepEqual(res.packages, []);
      assert.equal(res.plan, null);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});

/**
 * deploy-winvm-plugin.mjs（deployWinvmPlugin）单元测试
 *
 * 该 helper 是第八轮「部署脚本 5 项问题」修复的核心件，统一、安全地部署
 * winvm-plugin 启动器三件套（.mjs 源 + .cmd + 无扩展名 bash 启动器），
 * 同时根治：
 *   - 自拷贝 EINVAL 误报失败（Q1）：tar 已含 winvm-plugin.mjs 时 binSrc===binDst，
 *     若仍 cpSync 则 Windows 抛 EINVAL → 进程退 1 → setup 误报 VM 部署失败；
 *   - 管理命令找不到（Q3）：三件套齐备后两侧均可达；
 *   - host 上下文误发到 VM（单元隐患）：writeContext=false 时不写 .winvm-context.json。
 *
 * 测试在临时目录内隔离运行，绝不触碰真实仓库 delivery/。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deployWinvmPlugin } from '../../delivery/deploy-winvm-plugin.mjs';

const SRC_BODY = '#!/usr/bin/env node\nconsole.log("fake winvm-plugin source");\n';

/** 建一个临时「仓库根」，内含 delivery/winvm-plugin.mjs 源脚本 */
async function makeFakeRepo() {
  const root = await mkdtemp(join(tmpdir(), 'winvm-deploy-src-'));
  // mkdtemp 只建根临时目录，子目录必须显式创建（否则 writeFile 报 ENOENT）
  const delivery = join(root, 'delivery');
  await mkdir(delivery, { recursive: true });
  await writeFile(join(delivery, 'winvm-plugin.mjs'), SRC_BODY, 'utf8');
  return root;
}

/** 收集 log 输出到数组，便于断言「跳过复制 / 跳过上下文」等行为 */
function recorder() {
  const logs = [];
  return { logs, log: (m) => logs.push(m) };
}

describe('deployWinvmPlugin', () => {
  test('异目录复制：源脚本 + 启动器三件套落地，并写入 side 上下文', async () => {
    const repoRoot = await makeFakeRepo();
    const targetDir = await mkdtemp(join(tmpdir(), 'winvm-deploy-dst-'));
    const { logs, log } = recorder();
    try {
      deployWinvmPlugin({ targetDir, side: 'host', dryRun: false, log, repoRoot });

      // 1) 源脚本已复制
      assert.equal(existsSync(join(targetDir, 'winvm-plugin.mjs')), true, 'winvm-plugin.mjs 应被复制');
      assert.equal(readFileSync(join(targetDir, 'winvm-plugin.mjs'), 'utf8'), SRC_BODY, '复制内容应一致');
      // 2) 上下文标记
      assert.equal(existsSync(join(targetDir, '.winvm-context.json')), true, '应写 .winvm-context.json');
      assert.deepEqual(JSON.parse(readFileSync(join(targetDir, '.winvm-context.json'), 'utf8')), { side: 'host' });
      // 3) Windows 启动器
      assert.equal(existsSync(join(targetDir, 'winvm-plugin.cmd')), true, '应写 winvm-plugin.cmd');
      // 4) POSIX 无扩展名启动器（非空即视为已生成）
      assert.equal(existsSync(join(targetDir, 'winvm-plugin')), true, '应写无扩展名 bash 启动器');
      assert.ok(readFileSync(join(targetDir, 'winvm-plugin'), 'utf8').length > 0);
      assert.ok(logs.some((m) => m.includes('已复制')), 'log 应含「已复制」');
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
      await rm(targetDir, { recursive: true, force: true });
    }
  });

  test('自拷贝跳过（binSrc===binDst）：不报错、不覆盖源、log 标「已就位，跳过复制」', async () => {
    const repoRoot = await makeFakeRepo();
    const targetDir = join(repoRoot, 'delivery'); // 与 binSrc 同目录 → binDst === binSrc
    const { logs, log } = recorder();
    try {
      // 不应抛 EINVAL（旧实现在此退 1）
      assert.doesNotThrow(() =>
        deployWinvmPlugin({ targetDir, side: 'vm', dryRun: false, log, repoRoot }),
      );
      // 源脚本内容保持不变（未被自拷贝破坏）
      assert.equal(readFileSync(join(targetDir, 'winvm-plugin.mjs'), 'utf8'), SRC_BODY);
      // 仍会写上下文与启动器（跳过仅针对「复制」一步）
      assert.equal(existsSync(join(targetDir, '.winvm-context.json')), true);
      assert.ok(logs.some((m) => m.includes('跳过复制')), 'log 应标「跳过复制」');
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test('writeContext=false：不写 .winvm-context.json（避免 host 上下文随 tar 发到 VM）', async () => {
    const repoRoot = await makeFakeRepo();
    const targetDir = await mkdtemp(join(tmpdir(), 'winvm-deploy-nocontext-'));
    const { logs, log } = recorder();
    try {
      deployWinvmPlugin({ targetDir, side: 'host', dryRun: false, writeContext: false, log, repoRoot });
      // 源与启动器照常落地
      assert.equal(existsSync(join(targetDir, 'winvm-plugin.mjs')), true);
      assert.equal(existsSync(join(targetDir, 'winvm-plugin.cmd')), true);
      // 但上下文文件不应出现
      assert.equal(existsSync(join(targetDir, '.winvm-context.json')), false, 'writeContext=false 不应写上下文');
      assert.ok(logs.some((m) => m.includes('跳过 .winvm-context.json')), 'log 应标跳过上下文');
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
      await rm(targetDir, { recursive: true, force: true });
    }
  });

  test('dry-run：不写任何文件，仅记录预览', async () => {
    const repoRoot = await makeFakeRepo();
    const targetDir = await mkdtemp(join(tmpdir(), 'winvm-deploy-dry-'));
    const { logs, log } = recorder();
    try {
      deployWinvmPlugin({ targetDir, side: 'vm', dryRun: true, log, repoRoot });
      assert.equal(existsSync(join(targetDir, 'winvm-plugin.mjs')), false, 'dry-run 不应复制源');
      assert.equal(existsSync(join(targetDir, '.winvm-context.json')), false, 'dry-run 不应写上下文');
      assert.equal(existsSync(join(targetDir, 'winvm-plugin.cmd')), false, 'dry-run 不应写 .cmd');
      assert.equal(existsSync(join(targetDir, 'winvm-plugin')), false, 'dry-run 不应写启动器');
      assert.ok(logs.length > 0, 'dry-run 仍应输出预览日志');
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
      await rm(targetDir, { recursive: true, force: true });
    }
  });
});

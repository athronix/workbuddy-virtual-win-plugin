#!/usr/bin/env node
/**
 * 部署插件管理 CLI（winvm-plugin）到目标目录，并生成全套启动器：
 *   - winvm-plugin.mjs      源脚本（来自仓库 delivery/winvm-plugin.mjs）
 *   - .winvm-context.json   {"side":"host"|"vm"} 供 detectSide 自动识别
 *   - winvm-plugin.cmd      Windows 启动器（cmd/PowerShell 经 PATHEXT 解析 `winvm-plugin` → 此文件）
 *   - winvm-plugin          POSIX 启动器（#! + 经 bash 设 +x，Git Bash / ssh 直跑 `winvm-plugin` 可用）
 *
 * 设计要点（修复「部署误报失败」与「命令找不到」两类问题）：
 *   1) 自动跳过**自身拷贝**：经 setup.mjs 的 tar 分发时，delivery/ 已含 winvm-plugin.mjs，
 *      binSrc 与 binDst 为同一文件。若仍 cpSync 则 Windows 抛 EINVAL → 进程退出 1 →
 *      上层 setup.mjs 误报「VM 部署失败」（实际服务已就绪）。故 resolved 相同即跳过复制。
 *   2) 三件套齐备：仅 .cmd 时 Git Bash/ssh 里敲 `winvm-plugin` 解析不到；
 *      补 bash 启动器 +x 后，仓库/Git Bash/ssh 任意位置 `winvm-plugin <cmd>` 均可达。
 */

import {
  existsSync,
  mkdirSync,
  cpSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * @param {object} opts
 * @param {string} opts.targetDir   启动器落地目录（host: 插件缓存根 / 仓库 delivery；vm: 部署 delivery）
 * @param {'host'|'vm'} opts.side   写入 .winvm-context.json 的 side
 * @param {boolean} opts.dryRun     仅预览
 * @param {boolean} [opts.writeContext=true] 是否写 .winvm-context.json。
 *        仓库 delivery 目录部署时传 false：避免把 `side:host` 上下文随 tar 发到 VM、
 *        导致 VM 误判为 host（VM 侧由 install-vm 步骤7 正确写入 side:vm，且 VM 目录有
 *        packages/vm-service/dist/cli.js，启发式也能正确识别为 vm）。
 * @param {(m:string)=>void} [opts.log]
 * @param {string} [opts.repoRoot]  仓库根（默认推断为本文件上级目录）
 */
export function deployWinvmPlugin({ targetDir, side, dryRun, writeContext = true, log = () => {}, repoRoot }) {
  const root = repoRoot ?? resolve(__dirname, '..');
  const binSrc = join(root, 'delivery', 'winvm-plugin.mjs');
  if (!existsSync(binSrc)) {
    log(`管理 CLI  : 源 ${binSrc} 不存在，跳过`);
    return;
  }
  mkdirSync(targetDir, { recursive: true });
  const binDst = join(targetDir, 'winvm-plugin.mjs');

  // 1) 复制源脚本（跳过自身拷贝，避免 tar 已含此文件时 cpSync 自拷贝 EINVAL）
  if (resolve(binSrc) === resolve(binDst)) {
    log(`管理 CLI  : ${binDst}（已就位，跳过复制）`);
  } else if (dryRun) {
    log(`管理 CLI  : ${binSrc} → ${binDst}  [dry-run]`);
  } else {
    cpSync(binSrc, binDst, { recursive: false });
    log(`管理 CLI  : 已复制 ${binDst}`);
  }

  // 2) 上下文标记（detectSide 第二优先级）；仓库 delivery 部署可跳过（避免 host 上下文随 tar 发到 VM）
  if (!writeContext) {
    // 无论 dry-run 与否都记录：真执行时同样需要「跳过」这一事实可见（呼应 Q1：输出须可观测，
    // 而非仅在预览里可见）。dry-run 追加标记以区分预览与实跑。
    log(
      `管理 CLI  : 跳过 .winvm-context.json（writeContext=false，VM 侧由 install-vm 写 side:vm）` +
        `${dryRun ? '  [dry-run]' : ''}`,
    );
  } else if (dryRun) {
    log(`管理 CLI  : 写 .winvm-context.json (side=${side})  [dry-run]`);
  } else {
    writeFileSync(join(targetDir, '.winvm-context.json'), JSON.stringify({ side }) + '\n');
    // 与其余步骤一致，实跑也留痕（此前仅写入不记录，操作者看不到上下文已落地）
    log(`管理 CLI  : 已写 .winvm-context.json (side=${side})`);
  }

  // 3) Windows 启动器（cmd/PowerShell 经 PATHEXT：在目标目录内敲 `winvm-plugin` 即解析到它）
  if (dryRun) {
    log('管理 CLI  : 写 winvm-plugin.cmd  [dry-run]');
  } else {
    writeFileSync(join(targetDir, 'winvm-plugin.cmd'), '@echo off\r\nnode "%~dp0winvm-plugin.mjs" %*\r\n');
  }

  // 4) POSIX 启动器（无扩展名 + shebang + +x）：Git Bash / ssh 交互会话里 `winvm-plugin <cmd>` 直接用
  const shLauncher = [
    '#!/usr/bin/env bash',
    'exec node "$(dirname "$0")/winvm-plugin.mjs" "$@"',
    '',
  ].join('\n');
  if (dryRun) {
    log('管理 CLI  : 写 winvm-plugin (POSIX 启动器, +x)  [dry-run]');
    return;
  }
  const lp = join(targetDir, 'winvm-plugin');
  writeFileSync(lp, shLauncher, { mode: 0o755 });
  // Windows 上 fs.chmodSync 仅能改只读位、无法置可执行位；经 bash 设 +x（Git Bash / 多数 VM 装了 Git for Windows）
  try { chmodSync(lp, 0o755); } catch { /* noop */ }
  try {
    const r = spawnSync('bash', ['-c', `chmod +x "${lp}"`], { stdio: 'ignore' });
    void r;
  } catch { /* noop */ }
  log(`管理 CLI  : 已部署启动器 ${lp}（winvm-plugin 命令可用；或 node winvm-plugin.mjs <cmd>）`);
}

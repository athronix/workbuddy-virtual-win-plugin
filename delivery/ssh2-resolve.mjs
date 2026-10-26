#!/usr/bin/env node
/**
 * ssh2 运行时依赖解析（CL-015 T11 / P0-01）。
 *
 * 背景：鸿蒙(HMOS)宿主无系统 ssh，进程内 ssh2 隧道（oh-tunnel.mjs）是连通 VM 的唯一通路。
 * 但 `packages/core` 依赖 `ssh2`，而旧安装器 `collectWinvmDeps` 仅分发 `@winvm/*` 依赖，
 * ssh2 从未被落地到插件缓存 → 宿主上 `import('ssh2')` 必失败。
 *
 * 本模块提供**确定性解析链**与**「三要素」引导错误**（包名 + 期望落点 + 可复制修复动作），
 * 供 oh-tunnel.mjs 与 tunnel-daemon.mjs 复用。绝不引入任何产品能力，纯逻辑、可离线单测。
 *
 * 解析顺序（逐步失败才降级）：
 *   ① 注入的 opts.ssh2Client（测试/上层复用，最高优先）
 *   ② 裸 import('ssh2')（真机 node_modules 存在时由 ESM 向上查找命中）
 *   ③ 显式绝对路径兜底（createRequire 指向 moduleDir / moduleDir.. / vendor / WINVM_SSH2_DIR）
 *   ④ 全部失败 → 抛 ssh2MissingError（三要素，绝不打印凭据）
 */

import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const SSH2_NAME = 'ssh2';

/**
 * 构造「三要素」错误（不含任何凭据）。模板见 docs/archive/changes/CL-015/TECHNICAL-SOLUTION.md §3.4。
 * @param {{expectedPaths?:string[], fixAction?:string}} details
 * @returns {Error}
 */
export function ssh2MissingError(details = {}) {
  const { expectedPaths = [], fixAction = '' } = details;
  const lines = [
    '[winvm] 缺少必需运行时依赖：ssh2（鸿蒙 ssh2 隧道的唯一通路依赖）',
    '  ① 包名    ：ssh2',
  ];
  if (expectedPaths.length) lines.push(`  ② 期望落点：${expectedPaths.join(', ')}`);
  if (fixAction) lines.push(`  ③ 修复动作：${fixAction}`);
  return new Error(lines.join('\n'));
}

/** 从已加载的模块对象里取出 ssh2 的 Client 构造器（兼容 {Client}、{default:{Client}}、{default}）。 */
function pickClient(mod) {
  if (!mod || typeof mod !== 'object') return null;
  const Ctor = mod.Client ?? mod.default?.Client ?? mod.default;
  return typeof Ctor === 'function' ? Ctor : null;
}

/** ① 注入。 */
function fromInjected(opts) {
  return opts && opts.ssh2Client ? opts.ssh2Client : null;
}

/** ② 裸 import('ssh2')（字符串 specifier，避免静态解析时强依赖）。 */
async function fromBareImport() {
  try {
    const mod = await import(SSH2_NAME);
    return pickClient(mod);
  } catch {
    return null;
  }
}

/** ③a 包目录直导（如 <repoRoot>/vendor/ssh2 内含 package.json）。 */
async function fromPackageDir(pkgDir) {
  try {
    if (!pkgDir || !existsSync(pkgDir)) return null;
    const pj = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    const entry =
      (pj.exports && typeof pj.exports === 'string' && pj.exports) ||
      (pj.main && typeof pj.main === 'string' && join(pkgDir, pj.main)) ||
      join(pkgDir, 'index.js');
    const mod = await import(pathToFileURL(entry).href);
    return pickClient(mod);
  } catch {
    return null;
  }
}

/** ③b 经 createRequire 从某 node_modules 基目录解析（覆盖 ESM 无法用 NODE_PATH 的场景）。 */
async function fromRequireResolve(baseNmDir, moduleUrl) {
  try {
    const require = createRequire(moduleUrl ?? import.meta.url);
    const entry = require.resolve(SSH2_NAME);
    const mod = await import(pathToFileURL(entry).href);
    return pickClient(mod);
  } catch {
    return null;
  }
}

/**
 * 解析 ssh2 Client 构造器（不是实例）。
 * @param {object} [opts]
 * @param {any}    [opts.ssh2Client]       注入优先（测试/上层复用）
 * @param {string} [opts.moduleUrl]         调用方 import.meta.url，用于推导兜底绝对路径
 * @param {string[]} [opts.extraCandidates] 追加的绝对目录候选（如 vendor/ssh2）
 * @returns {Promise<Function>} ssh2 Client 构造器
 */
export async function loadSsh2Client(opts = {}) {
  let Ctor = fromInjected(opts);
  if (Ctor) return Ctor;

  Ctor = await fromBareImport();
  if (Ctor) return Ctor;

  const moduleDir = opts.moduleUrl ? dirname(opts.moduleUrl) : dirname(import.meta.url);
  const bases = [
    moduleDir, // delivery/ 或 pluginRoot/（含 node_modules/ssh2）
    dirname(moduleDir), // 父目录（pluginRoot 本身 / 仓库根）
    ...(opts.extraCandidates || []),
    process.env['WINVM_SSH2_DIR'],
  ].filter(Boolean);

  for (const base of bases) {
    const asPackage = await fromPackageDir(base);
    if (asPackage) return asPackage;
    const viaNm = await fromRequireResolve(join(base, 'node_modules'), opts.moduleUrl);
    if (viaNm) return viaNm;
  }

  // ④ 全部失败
  const expectedPaths = [
    join(moduleDir, 'node_modules', SSH2_NAME),
    join(dirname(moduleDir), 'node_modules', SSH2_NAME),
    ...(opts.extraCandidates || []),
    process.env['WINVM_SSH2_DIR'],
  ].filter(Boolean);
  throw ssh2MissingError({
    expectedPaths,
    fixAction:
      `cp -R "<安装机>/node_modules/ssh2" "<插件缓存>/node_modules/" ` +
      `&& cp -R "<安装机>/node_modules/asn1" "<插件缓存>/node_modules/" ` +
      `&& cp -R "<安装机>/node_modules/bcrypt-pbkdf" "<插件缓存>/node_modules/" ` +
      `&& cp -R "<安装机>/node_modules/tweetnacl" "<插件缓存>/node_modules/" ` +
      `(或：在安装机执行  node delivery/install-host.mjs --apply  重新分发依赖；` +
      `亦可放置离线预置目录 <repoRoot>/vendor/ssh2 后重装)`,
  });
}

#!/usr/bin/env node
/**
 * pack-release.mjs — WinVM Bridge 发布打包器（REL-V1.4.0）
 *
 * 依据 `docs/release/DESIGN-V1.4.0.md` §3/§5/§6 实现：
 *   release/<version>/{host,vm,overall} 三包 + 一键脚本 + README + MANIFEST。
 *   REL-11 增：V1-V4 验证通过后产出 overall zip（GitHub Release 分发单元，
 *   winvm-overall-<version>.zip，包内根=overall/），sha256+bytes 入包证据；
 *   上架由 delivery/publish-release.mjs --apply 承接（见 DEPLOYMENT.md §9.1a）。
 *
 * 闭包推导（非拍脑袋，详见设计文档 §3）：
 *   host    = install-host.mjs 的 import/spawn 闭包 + skills + packages 运行时资产
 *             + node_modules(@winvm 实体副本 + ssh2 纯 JS 链) + package.json
 *   vm      = deploy-vm.mjs→setup.mjs→install-vm.mjs 闭包 + skills + packages 运行时资产
 *             + qa/probes 两件 + package.json（宿主驱动仅 node 内置，无需 node_modules）
 *   overall = host ∪ vm ∪ {bootstrap,prepare-vm,uninstall} ∪ 文档包
 *
 * 用法：
 *   node delivery/pack-release.mjs --version V1.4.0
 *   node delivery/pack-release.mjs                      # 从 HEAD 的 tag 自动推导（fail-loud）
 *   node delivery/pack-release.mjs --allow-dirty        # 仅调试用
 *
 * 安全红线：本脚本只读仓库、只写 release/ 与 qa/release/；绝不触碰 VM/隧道/运行态。
 */
import {
  existsSync, mkdirSync, cpSync, readFileSync, writeFileSync, readdirSync,
  statSync, chmodSync, rmSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const GIT = '/storage/Users/currentUser/.harmonybrew/opt/git/bin/git';

/* ------------------------------ 参数 ------------------------------ */
function parseArgs(argv) {
  const out = { version: null, out: 'release', evidenceDir: 'qa/release', allowDirty: false, skipVerify: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--version': out.version = argv[++i]; break;
      case '--out': out.out = argv[++i]; break;
      case '--evidence-dir': out.evidenceDir = argv[++i]; break;
      case '--allow-dirty': out.allowDirty = true; break;
      case '--skip-verify': out.skipVerify = true; break;
      case '--help': case '-h': printUsage(); process.exit(0); break;
      default: console.error(`未知参数：${argv[i]}`); printUsage(); process.exit(2);
    }
  }
  return out;
}
function printUsage() {
  console.log('用法：node delivery/pack-release.mjs [--version Vx.y.z] [--out release] [--allow-dirty] [--skip-verify]');
}

/* ------------------------------ 前置断言 ------------------------------ */
function git(args) {
  const r = spawnSync(GIT, ['-C', ROOT, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() };
}
function assertPreflight(args, version) {
  const dirty = git(['status', '--porcelain']);
  if (dirty.status !== 0) fail(`git status 失败：${dirty.stderr}`);
  // 豁免本次运行自己生成/覆写的证据文件（qa/release/<version>-pack.txt）——
  // 否则"打包→证据变 dirty→下次打包拒打包"鸡生锈；其余任何未提交变更一律拒绝。
  const ownEvidence = relative(ROOT, resolve(ROOT, args.evidenceDir, `${version}-pack.txt`));
  const lines = dirty.stdout.split('\n').filter((l) => l.trim() && !l.trim().endsWith(` ${ownEvidence}`));
  if (lines.length && !args.allowDirty) {
    fail(`工作区不干净，拒绝打包（发布必须可复现）：\n${lines.join('\n')}\n（确认无秘书写 --allow-dirty）`);
  }
  const distMissing = [];
  for (const n of packageNames()) {
    if (!existsSync(join(ROOT, 'packages', n, 'dist'))) distMissing.push(n);
  }
  if (distMissing.length) fail(`以下包缺少 dist（请先 npm run build）：${distMissing.join(', ')}`);
  if (!existsSync(join(ROOT, 'node_modules', 'ssh2'))) fail('缺少 node_modules/ssh2（宿主隧道离线分发源）');
  if (!existsSync(join(ROOT, '.env.example'))) fail('缺少根 .env.example');
}
function resolveVersion(args) {
  if (args.version) {
    if (!/^V\d+\.\d+\.\d+$/.test(args.version)) fail(`版本号非法（须 Vx.y.z）：${args.version}`);
    return args.version;
  }
  const pointed = git(['tag', '--points-at', 'HEAD']);
  const tag = pointed.stdout.split('\n').find((t) => /^V\d+\.\d+\.\d+$/.test(t));
  if (!tag) fail('未指定 --version 且 HEAD 无 Vx.y.z tag（拒绝静默默认）');
  return tag;
}
function fail(msg) {
  console.error(`\n✗ pack-release 中止：${msg}\n`);
  process.exit(1);
}

/* ------------------------------ 文件闭包 ------------------------------ */
const PKG_EXCLUDE = new Set(['src', 'node_modules', 'tsconfig.json', 'tsconfig.tsbuildinfo', '.generated', '.DS_Store']);

function packageNames() {
  return readdirSync(join(ROOT, 'packages'))
    .filter((n) => existsSync(join(ROOT, 'packages', n, 'package.json')))
    .sort();
}
/** 各包运行期资产（排除法，与 setup.mjs packagePayloadPaths 同规则——防新增资产漏发） */
function pkgRuntimeEntries() {
  const out = [];
  for (const n of packageNames()) {
    for (const e of readdirSync(join(ROOT, 'packages', n), { withFileTypes: true })) {
      if (PKG_EXCLUDE.has(e.name)) continue;
      out.push({ rel: `packages/${n}/${e.name}`, src: join(ROOT, 'packages', n, e.name) });
    }
  }
  return out;
}
/** ssh2 纯 JS 传递链（仅 dependencies，optional 原生依赖按 install-host 规则跳过） */
function ssh2Closure() {
  const names = new Set();
  const walk = (name) => {
    if (names.has(name)) return;
    const pj = join(ROOT, 'node_modules', name, 'package.json');
    if (!existsSync(pj)) return;
    names.add(name);
    let pkg = {};
    try { pkg = JSON.parse(readFileSync(pj, 'utf8')); } catch { return; }
    for (const d of Object.keys(pkg.dependencies ?? {})) walk(d);
  };
  walk('ssh2');
  return [...names].sort();
}

const HOST_DELIVERY = [
  'delivery/install-host.mjs', 'delivery/deploy-winvm-plugin.mjs', 'delivery/path-util.mjs',
  'delivery/account-resolve.mjs', 'delivery/preflight.mjs', 'delivery/ssh2-resolve.mjs',
  'delivery/oh-tunnel.mjs', 'delivery/tunnel-daemon.mjs', 'delivery/winvm-plugin.mjs',
  'delivery/hooks', 'delivery/env.example',
];
const VM_DELIVERY = [
  'delivery/deploy-vm.mjs', 'delivery/setup.mjs', 'delivery/install-vm.mjs',
  'delivery/deploy-shared-skills.mjs', 'delivery/link-workspace.mjs',
  'delivery/deploy-winvm-plugin.mjs', 'delivery/path-util.mjs', 'delivery/preflight.mjs',
  'delivery/env.example',
  // install-vm.mjs 的**非 import 硬依赖**（读文件生成 runtime.json；迭代1 教训：dry-run 抓不到这类缺失）
  'delivery/vm-service.config.json',
];
const OVERALL_EXTRA_DELIVERY = ['delivery/bootstrap.mjs', 'delivery/prepare-vm.mjs', 'delivery/uninstall.mjs',
  // V1.4.3 收编（G-1/G-2）：install-host 连接器自检的硬依赖（:1434 spawn 路径，缺=自检静默跳过）+ 包校验器本体
  'delivery/tools/diagnose-connectors.mjs', 'delivery/verify-release.mjs'];
// REL-11/Q-3（规格书 F-03·D-4）：winvm-prepare.ps1 随 overall 包分发——
// 铠大师「VM 环境准备」推送的脚本 = 包内这一份（单一真相源入包），App 不自持副本。
const OVERALL_TOOLS = ['tools/winvm-prepare.ps1'];
const VM_PROBES = ['qa/probes/qa-probe.ps1', 'qa/probes/lead-md5-3.ps1'];
// V1.4.3 收编（G-3）：部署策略 v2 六步验收探针随 overall 分发——纯 Release 安装链
// （Step 2 包校验 / Step 3.0 运行时前置 / Step 3/5 判据）不再依赖仓库工作区。
const DEPLOY_PROBES = ['qa/deploy-probes/verify-manifest.py', 'qa/deploy-probes/vm-env-check.ps1',
  'qa/deploy-probes/vmcheck.ps1', 'qa/deploy-probes/mcp-probe.py', 'qa/deploy-probes/a2a-probe.py',
  'qa/deploy-probes/example-probe.py'];
/**
 * 包内必存文件（V1 结构断言）——防"闭包清单漏文件"（迭代1 即漏 vm-service.config.json，
 * install-vm 读文件而非 import，dry-run 抓不到）。新增入口/数据文件时同步维护本表。
 */
const PACKAGE_REQUIRED = {
  host: [
    'delivery/install-host.mjs', 'delivery/tunnel-daemon.mjs', 'delivery/winvm-plugin.mjs',
    'delivery/hooks/hooks.json', 'delivery/env.example', 'package.json', '.env.example',
    'node_modules/@winvm/host-sdk/package.json', 'node_modules/ssh2/package.json',
  ],
  vm: [
    'delivery/deploy-vm.mjs', 'delivery/setup.mjs', 'delivery/install-vm.mjs',
    'delivery/vm-service.config.json', 'delivery/env.example', 'package.json', '.env.example',
    'qa/probes/qa-probe.ps1', 'qa/probes/lead-md5-3.ps1',
  ],
  overall: [
    'delivery/install-host.mjs', 'delivery/deploy-vm.mjs', 'delivery/setup.mjs',
    'delivery/install-vm.mjs', 'delivery/vm-service.config.json', 'delivery/bootstrap.mjs',
    'delivery/uninstall.mjs', 'delivery/env.example', 'package.json', '.env.example',
    'docs/DEPLOYMENT.md', 'docs/RELEASE-V1.4.0.md', 'docs/issues.md',
    // V1.4.5 收编项（Prompt 总集三篇）的包内存在性（漏收=打包 fail-loud）
    'docs/deploy/deploy-strategy.md', 'docs/deploy/deploy-prompts.md', 'docs/deploy/undeploy-prompts.md',
    // V1.4.6 收编项（10-29 裁定：纯 Prompt 一键粘贴脚本两篇）
    'docs/deploy/deploy.prompt', 'docs/deploy/undeploy.prompt',
    'tools/winvm-prepare.ps1',
    // V1.4.3 收编项的包内存在性（漏收=打包 fail-loud）
    'delivery/tools/diagnose-connectors.mjs', 'delivery/verify-release.mjs',
    'qa/deploy-probes/vm-env-check.ps1', 'qa/deploy-probes/mcp-probe.py',
  ],
};
const OVERALL_DOCS = [
  ['docs/05-peripherals/DEPLOYMENT.md', 'DEPLOYMENT.md'],
  ['docs/INSTALL-GUIDE.md', 'INSTALL-GUIDE.md'],
  ['docs/05-peripherals/USER-MANUAL.md', 'USER-MANUAL.md'],
  ['docs/05-peripherals/SCENARIOS.md', 'SCENARIOS.md'],
  ['docs/RELEASE-NOTES.md', 'RELEASE-NOTES.md'],
  ['docs/release/DESIGN-V1.4.0.md', 'DESIGN-V1.4.0.md'],
  ['docs/release/RELEASE-V1.4.0.md', 'RELEASE-V1.4.0.md'],
  ['docs/release/ISSUES.md', 'issues.md'],
  // V1.4.5 收编（10-27 裁定）：Prompt 总集三篇入包（保持 docs/deploy/ 子目录），
  // 纯 Release 装机者自此零仓库依赖拿到 部署策略/部署 Prompt/卸载 Prompt。
  ['docs/deploy/deploy-strategy.md', 'deploy/deploy-strategy.md'],
  ['docs/deploy/deploy-prompts.md', 'deploy/deploy-prompts.md'],
  ['docs/deploy/undeploy-prompts.md', 'deploy/undeploy-prompts.md'],
  // V1.4.6 收编（10-29 裁定）：纯 Prompt 一键粘贴脚本两篇入包——装机者解包后
  // 直接把 docs/deploy/deploy.prompt / undeploy.prompt 整段粘给 WorkBuddy 即可部署/拆除。
  ['docs/deploy/deploy.prompt', 'deploy/deploy.prompt'],
  ['docs/deploy/undeploy.prompt', 'deploy/undeploy.prompt'],
];

/* ------------------------------ 组装 ------------------------------ */
function ensureDir(p) { mkdirSync(p, { recursive: true }); }
function copyEntry(src, dest) {
  if (!existsSync(src)) fail(`闭包源缺失：${src}`);
  ensureDir(dirname(dest));
  cpSync(src, dest, { recursive: true });
}
function copyList(rels, destRoot) {
  for (const rel of rels) copyEntry(join(ROOT, rel), join(destRoot, rel));
}

/** 三包公共：packages 运行时资产 + skills + package.json + .env.example */
function assembleCommon(dest) {
  for (const { rel, src } of pkgRuntimeEntries()) copyEntry(src, join(dest, rel));
  copyEntry(join(ROOT, 'skills'), join(dest, 'skills'));
  copyEntry(join(ROOT, 'package.json'), join(dest, 'package.json'));
  copyEntry(join(ROOT, '.env.example'), join(dest, '.env.example'));
}
/** host 专属：node_modules（@winvm 实体副本 + ssh2 链） */
function assembleHostNodeModules(dest) {
  const entries = pkgRuntimeEntries();
  for (const n of packageNames()) {
    const pkgDest = join(dest, 'node_modules', '@winvm', n);
    for (const { rel, src } of entries.filter((x) => x.rel.startsWith(`packages/${n}/`))) {
      copyEntry(src, join(pkgDest, rel.slice(`packages/${n}/`.length)));
    }
  }
  for (const n of ssh2Closure()) copyEntry(join(ROOT, 'node_modules', n), join(dest, 'node_modules', n));
}

/* ------------------------------ 一键脚本 ------------------------------ */
const NODE_RESOLVE = [
  'NODE_BIN="${WINVM_NODE_BIN:-}"',
  'if [ -z "$NODE_BIN" ]; then',
  '  if command -v node >/dev/null 2>&1; then NODE_BIN="node";',
  '  elif [ -x /data/storage/el1/bundle/libs/arm64/node/bin/node ]; then NODE_BIN=/data/storage/el1/bundle/libs/arm64/node/bin/node;',
  '  else echo "错误：未找到 node（可 export WINVM_NODE_BIN 指定）" >&2; exit 1; fi',
  'fi',
];
const ENSURE_ENV = [
  'cd "$HERE"',
  'if [ ! -f .env ]; then',
  '  if [ -f .env.example ]; then cp .env.example .env; echo "已由 .env.example 生成 .env——请编辑填写 VM_HOST/VM_USER/WINVM_VM_PROVIDER 等后重跑" >&2; exit 2; fi',
  '  echo "错误：缺少 .env 与 .env.example" >&2; exit 2;',
  'fi',
];
function writeScript(path, lines) {
  writeFileSync(path, ['#!/usr/bin/env bash', '# WinVM Bridge 发布包一键脚本（由 delivery/pack-release.mjs 生成，勿手改）', 'set -euo pipefail', ...lines].join('\n') + '\n');
  chmodSync(path, 0o755);
}
function genHostScript(dest, version) {
  writeScript(join(dest, 'deploy-host.sh'), [
    `echo "== WinVM Bridge ${version} · 宿主机一键部署 =="`,
    'HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    ...NODE_RESOLVE,
    ...ENSURE_ENV,
    'echo "node=$NODE_BIN  目标：安装 WorkBuddy 插件 + 连接器 + Skills + 隧道"',
    'exec "$NODE_BIN" delivery/install-host.mjs "$@"',
  ]);
}
function genVmScript(dest, version) {
  writeScript(join(dest, 'deploy-vm.sh'), [
    `echo "== WinVM Bridge ${version} · VM 一键部署（宿主驱动） =="`,
    'HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    ...NODE_RESOLVE,
    ...ENSURE_ENV,
    'if [ $# -eq 0 ]; then',
    '  read -r -p "无参数：将执行 deploy-vm.mjs --apply --skip-build（真部署到 VM，使用包内已构建 dist）。确认？[y/N] " ans',
    '  case "$ans" in y|Y) set -- --apply --skip-build ;; *) echo "已取消（可传 --dry-run 预览）"; exit 0 ;; esac',
    'fi',
    'echo "node=$NODE_BIN  目标：打包推送 VM 载荷 → install-vm → 起服务 → QA 探针"',
    'exec "$NODE_BIN" delivery/deploy-vm.mjs "$@"',
  ]);
}
function genOverallScript(dest, version) {
  writeScript(join(dest, 'deploy-all.sh'), [
    `echo "== WinVM Bridge ${version} · 整体一键部署（宿主机 + VM） =="`,
    'HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    ...NODE_RESOLVE,
    ...ENSURE_ENV,
    '# 读 .env 的关键值做前置提示（缺失即中止，不做默认猜测）',
    'set -a; . ./.env; set +a',
    'for k in VM_HOST VM_USER WINVM_VM_PROVIDER; do',
    '  v="$(printenv "$k" || true)"',
    '  if [ -z "$v" ]; then echo "错误：.env 缺少 $k" >&2; exit 2; fi',
    'done',
    'echo "VM=${VM_USER}@${VM_HOST}:${VM_SSH_PORT:-22}  provider=${WINVM_VM_PROVIDER}"',
    'WIPE=0; PASSTHRU=()',
    'for a in "$@"; do',
    '  case "$a" in',
    '    --wipe) WIPE=1 ;;',
    '    *) PASSTHRU+=("$a") ;;',
    '  esac',
    'done',
    'if [ "$WIPE" = "1" ]; then',
    '  echo "—— --wipe：先双端清空历史部署（移入回收站，可恢复）——"',
    '  "$NODE_BIN" delivery/uninstall.mjs --apply --vm-host "$VM_HOST" --vm-user "$VM_USER" --vm-ssh-port "${VM_SSH_PORT:-22}"',
    'fi',
    'echo "—— 执行 setup.mjs --apply --skip-build（HOST→VM→VM-START→TUNNEL→TEST→QA-PROBE→HEALTH；BUILD 已跳过：包内 dist 已构建且 MANIFEST 指纹在册）——"',
    '"$NODE_BIN" delivery/setup.mjs --apply --skip-build ${PASSTHRU[@]+"${PASSTHRU[@]}"}',
    'echo "—— 后置验证：隧道 /health ——"',
    'curl -s --noproxy "*" -m 10 "http://127.0.0.1:${WINVM_TUNNEL_LOCAL_PORT:-18443}/health" | head -c 500 || echo "（health 探测失败，请查隧道）"',
    'echo',
    `echo "== ${version} 部署完成。完整功能验证清单见 README.md §验证 =="`,
  ]);
}

/* ------------------------------ README / MANIFEST ------------------------------ */
function writeReadme(dest, kind, version, extra) {
  const lines = [`# WinVM Bridge ${version} · ${extra.title}`, '', `> 由 delivery/pack-release.mjs 生成于 commit ${COMMIT}；随包文档见 overall/docs/（整体包）。`, ''];
  lines.push(...extra.body);
  writeFileSync(join(dest, 'README.md'), lines.join('\n') + '\n');
}
function sha256File(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}
function walkFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}
function writeManifest(dest, version, kind) {
  const files = walkFiles(dest);
  const rows = files.map((p) => {
    const rel = relative(dest, p);
    return `${rel}  ${sha256File(p)}`;
  });
  const total = createHash('sha256').update(rows.join('\n')).digest('hex');
  const bytes = files.reduce((s, p) => s + statSync(p).size, 0);
  const header = [
    '# WinVM Bridge Release Manifest',
    `version: ${version}`,
    `commit: ${COMMIT}`,
    `date: ${new Date().toISOString()}`,
    `package: ${kind}`,
    `files: ${files.length}`,
    `bytes: ${bytes}`,
    `total-sha256: ${total}`,
    '# ---- per-file (relpath  sha256) ----',
  ];
  writeFileSync(join(dest, 'MANIFEST.txt'), [...header, ...rows].join('\n') + '\n');
  return { files: files.length, bytes, total };
}

/* ------------------------------ zip 发布资产（REL-11 A：GitHub Release 分发单元） ------------------------------ */
/** zip 文件名（与 GitHub Release 匿名下载 URL 的 {zipname} 一字不差，勿随意改名） */
export function zipNameFor(version) { return `winvm-overall-${version}.zip`; }
/** 旁挂校验文件资产名（Q-2：随 zip 一起上架，解包前整包校验用） */
export function sha256SidecarNameFor(zipName) { return `${zipName}.sha256`; }
/**
 * sha256sum -c 兼容内容（一行 `<hex>  <name>`，两空格=二进制模式；纯函数供单测）。
 * zip 名用相对名（旁挂文件与 zip 同目录 ⇒ `sha256sum -c` 在解包目录即可校验）。
 */
export function sha256SidecarContent(zipName, hex) { return `${hex}  ${zipName}\n`; }
/**
 * zip 命令计划（纯函数，供单测断言）：从 release/<version> 目录执行
 * `zip -qr <zipName> overall` ⇒ 包内根恒为 overall/（新机解包即得 overall 目录）。
 * @param {string} destVersionDir release/<version> 绝对路径
 * @param {string} version
 * @returns {{cmd:string, args:string[], cwd:string, outPath:string, zipName:string}}
 */
export function buildZipSpawn(destVersionDir, version) {
  const zipName = zipNameFor(version);
  return { cmd: 'zip', args: ['-qr', zipName, 'overall'], cwd: destVersionDir, outPath: join(destVersionDir, zipName), zipName };
}
/**
 * 缺陷#1（QA it6，发布闸口级安全）：zip 条目集 ⊆ MANIFEST 行集 ∪ {MANIFEST.txt} 的差集判据。
 * 真机部署会在包目录混入非设计成员（.env 含 VM 内网拓扑、winvm-plugin 运行 shim）——
 * 旁挂 sha256sum -c 与 MANIFEST 逐行校验都只检"在册文件字节对不对"，**检不出多出来的文件**
 * （结构性盲区）。仓库 public 后匿名 curl 即得 ⇒ 必须在打包时机械拦截。
 * @param {string[]} zipEntries `unzip -Z1` 输出的条目路径（含目录条目 `overall/xxx/` 尾斜杠）
 * @param {string[]} manifestRows MANIFEST.txt 数据行原文（`<relpath>  <sha256>`，两空格分隔）
 * @returns {string[]} 差集=额外条目（zip 里有、设计成员集里没有）；空数组=干净。
 *   豁免规则：①目录条目（尾斜杠）不计（MANIFEST 只登记文件）；②`overall/MANIFEST.txt`
 *   自身豁免（它由 writeManifest 先落盘再入 zip，但不在自己的行集里，属设计）。
 */
export function diffZipEntriesVsManifest(zipEntries, manifestRows) {
  const manifestPaths = new Set();
  for (const l of manifestRows) {
    // 行格式=`<relpath>  <sha256>`（writeManifest 两空格口径）；relpath 可含点前缀（.env.example）
    const i = l.lastIndexOf('  ');
    if (i <= 0) continue;
    if (/^[0-9a-f]{64}$/.test(l.slice(i + 2))) manifestPaths.add(l.slice(0, i));
  }
  const extras = [];
  for (const entry of zipEntries) {
    if (!entry || entry.endsWith('/')) continue; // 目录条目豁免
    if (!entry.startsWith('overall/')) { extras.push(entry); continue; } // 非包内根=异常，显形
    const rel = entry.slice('overall/'.length);
    if (rel === 'MANIFEST.txt') continue; // MANIFEST 自身豁免
    if (!manifestPaths.has(rel)) extras.push(entry);
  }
  return extras;
}
/**
 * 生成 overall zip 并返回证据三元组（sha256/bytes 取**zip 实体**，非目录聚合值——
 * 新机 curl 校验的就是这个字节流）。任何失败 fail-loud（调用点在证据写出之前 ⇒ 不落残缺证据）。
 * Q-2 旁挂：zip 生成后立即写 `winvm-overall-<version>.zip.sha256`（sha256sum -c 兼容一行），
 * 与 zip 同目录、随 publish-release 一并上架 ⇒ 铠大师/WB 解包前即可整包校验。
 * 缺陷#1 断言：zip 条目集 ⊆ MANIFEST ∪ {MANIFEST.txt}，杂文件混入 ⇒ 删半成品 + fail-loud。
 */
export function makeOverallZip(destVersionDir, version) {
  destVersionDir = resolve(destVersionDir); // 绝对化：spawn cwd 与条目列举的相对基准必须同源（缺陷#1 首跑即踩）
  const plan = buildZipSpawn(destVersionDir, version);
  if (!existsSync(join(plan.cwd, 'overall'))) fail(`zip 源目录缺失：${join(plan.cwd, 'overall')}`);
  if (existsSync(plan.outPath)) fail(`zip 目标已存在：${relative(ROOT, plan.outPath)}（请移走旧 zip，避免新旧混发）`);
  const manifestPath = join(plan.cwd, 'overall', 'MANIFEST.txt');
  if (!existsSync(manifestPath)) fail(`zip 断言缺源：${relative(ROOT, manifestPath)} 不存在（先 writeManifest 再生成 zip）`);
  const r = spawnSync(plan.cmd, plan.args, { cwd: plan.cwd, encoding: 'utf8' });
  if (r.status !== 0 || !existsSync(plan.outPath)) {
    fail(`zip 生成失败（exit ${r.status}）：${(r.error ? r.error.message : (r.stderr || r.stdout || '')).toString().trim().slice(0, 400)}——若为 command not found，请安装 zip（本仓发布链依赖 zip/unzip 往返保留 0755）`);
  }
  // —— 缺陷#1 条目集断言（读 zip 中央目录，不读盘上目录：判的就是上架字节流本身）——
  const list = spawnSync('unzip', ['-Z1', plan.outPath], { cwd: plan.cwd, encoding: 'utf8' });
  if (list.status !== 0) {
    try { fs.rmSync(plan.outPath, { force: true }); } catch { /* ignore */ }
    fail(`zip 条目列举失败（unzip -Z1 exit ${list.status}）：${(list.stderr || list.stdout || '').toString().trim().slice(0, 300)}——断言无法执行 ⇒ 按不可信处理，半成品已删除`);
  }
  const zipEntries = list.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const manifestRows = readFileSync(manifestPath, 'utf8').split('\n');
  const extras = diffZipEntriesVsManifest(zipEntries, manifestRows);
  if (extras.length) {
    try { fs.rmSync(plan.outPath, { force: true }); } catch { /* ignore */ }
    fail(`zip 混入非 MANIFEST 成员（发布闸口拦截，仓库 public 后这些文件将匿名可取）：\n  ${extras.join('\n  ')}\n——从包目录移除上述杂文件（勿删 MANIFEST 在册成员/.env.example）后重试`);
  }
  const zip = { path: plan.outPath, zipName: plan.zipName, sha256: sha256File(plan.outPath), bytes: statSync(plan.outPath).size };
  // 旁挂 .sha256（同目录；写完即回读自证——发布链字节级承诺不容半截文件）
  zip.sidecarName = sha256SidecarNameFor(plan.zipName);
  zip.sidecarPath = join(destVersionDir, zip.sidecarName);
  writeFileSync(zip.sidecarPath, sha256SidecarContent(plan.zipName, zip.sha256));
  if (!existsSync(zip.sidecarPath) || readFileSync(zip.sidecarPath, 'utf8') !== sha256SidecarContent(plan.zipName, zip.sha256)) {
    fail(`旁挂校验文件写出回读不一致：${relative(ROOT, zip.sidecarPath)}`);
  }
  return zip;
}
/** 证据行（单一格式口径，供 evLines 与单测共用） */
export function overallZipEvidenceLine(relPathFromRoot, zip) {
  return `overall-zip: ${relPathFromRoot} sha256=${zip.sha256} bytes=${zip.bytes}`;
}
/** 旁挂资产证据行（Q-2；前缀口径=team-lead 定稿 `overall-zip-sha256-file:`） */
export function overallZipSha256EvidenceLine(relPathFromRoot) {
  return `overall-zip-sha256-file: ${relPathFromRoot}`;
}

/* ------------------------------ 包内验证 V1-V4 ------------------------------ */
function verifyPackages(dest, version) {
  const results = [];
  const run = (label, cmd, args, cwd) => {
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
    const ok = r.status === 0;
    results.push({ label, ok, status: r.status, tail: (r.stdout ?? '') + (r.stderr ?? '') });
    console.log(`  ${ok ? '✓' : '✗'} ${label}（exit ${r.status}）`);
    return ok;
  };
  const NODE = process.execPath;
  // V1 结构断言：各包必存文件逐一 existsSync（闭包漏文件的机械化防线）
  for (const kind of ['host', 'vm', 'overall']) {
    const missing = (PACKAGE_REQUIRED[kind] ?? []).filter((rel) => !existsSync(join(dest, kind, rel)));
    const ok = missing.length === 0;
    results.push({ label: `V1 ${kind} 必存文件`, ok, status: ok ? 0 : 1, tail: missing.join(', ') });
    console.log(`  ${ok ? '✓' : '✗'} V1 ${kind} 必存文件${ok ? '' : `（缺失：${missing.join(', ')}）`}`);
  }
  // V2 host 闭包：静态 import 全部解析 + dry-run 计划可出
  run('V2 host 闭包 dry-run', NODE, [
    'delivery/install-host.mjs', '--dry-run', '--no-preflight', '--no-tunnel',
    '--vm-host', '127.0.0.1', '--vm-user', 'release-pack-check',
  ], join(dest, 'host'));
  // V3 vm 闭包：deploy-vm dry-run（无 --apply 即预览）
  run('V3 vm 闭包 dry-run', NODE, ['delivery/deploy-vm.mjs'], join(dest, 'vm'));
  // V5（V1.4.3 起，G-1 防回归硬断言）：包内 install-host.mjs 必须携带 NON_ACCOUNT_DIRS
  //（P2-3/856a0f4 修复；V1.4.2 事故=包早于修复致 Release 安装回归非账户污染）。
  for (const kind of ['host', 'overall']) {
    const ihp = join(dest, kind, 'delivery', 'install-host.mjs');
    const hit = existsSync(ihp) && (readFileSync(ihp, 'utf8').match(/NON_ACCOUNT_DIRS/g) || []).length >= 3;
    results.push({ label: `V5 ${kind} install-host 含 NON_ACCOUNT_DIRS`, ok: hit, status: hit ? 0 : 1, tail: '' });
    console.log(`  ${hit ? '✓' : '✗'} V5 ${kind} install-host 含 NON_ACCOUNT_DIRS`);
  }
  // V6（V1.4.4 起，I-6.1 防回归）：包内 gui.ps1 必须含 cbSize 实例重载修复——
  // V1.4.3 事故=修复晚于打包，Release 包内键鼠仍带 PS5.1 SizeOf([Type]) 真 bug。
  for (const kind of ['vm', 'overall']) {
    const gfp = join(dest, kind, 'packages', 'vm-capabilities', 'psmod', 'gui.ps1');
    const hit2 = existsSync(gfp) && readFileSync(gfp, 'utf8').includes('$cbSize');
    results.push({ label: `V6 ${kind} gui.ps1 含键鼠修复(cbSize)`, ok: hit2, status: hit2 ? 0 : 1, tail: '' });
    console.log(`  ${hit2 ? '\u2713' : '\u2717'} V6 ${kind} gui.ps1 含键鼠修复(cbSize)`);
  }
  // V7（V1.4.5 起，I-6.3 防回归）：包内 uninstall.mjs 必须含全局 mcp.json 对称清理
  //（cleanGlobalMcpJson）——V1.4.4 事故同款=修复晚于打包，包内卸载器不清全局
  // ~/.workbuddy/mcp.json 的 winvm/winvm-a2a 键、markers 缺 tunnel-autostart.json。
  {
    const ufp = join(dest, 'overall', 'delivery', 'uninstall.mjs');
    const hit3 = existsSync(ufp) && readFileSync(ufp, 'utf8').includes('cleanGlobalMcpJson');
    results.push({ label: 'V7 overall uninstall 含全局 mcp 对称清理(cleanGlobalMcpJson)', ok: hit3, status: hit3 ? 0 : 1, tail: '' });
    console.log(`  ${hit3 ? '\u2713' : '\u2717'} V7 overall uninstall 含全局 mcp 对称清理(cleanGlobalMcpJson)`);
  }
  // V8（V1.4.7 起，文档自指根除防回归）：包内两篇部署文档必须含权威校验源口径
  //（MANIFEST-sidecar-authoritative）——zip sha/三元组不在文档硬编码逐版本值，
  // 现取现验于包内 MANIFEST.txt + 旁挂 sidecar。缺口径=文档退回逐版本硬编码陈旧面，fail-loud。
  for (const dname of ['deploy/deploy-strategy.md', 'deploy/deploy-prompts.md']) {
    const dfp = join(dest, 'overall', 'docs', dname);
    const hit4 = existsSync(dfp) && readFileSync(dfp, 'utf8').includes('MANIFEST-sidecar-authoritative');
    results.push({ label: `V8 ${dname} 含权威校验源口径`, ok: hit4, status: hit4 ? 0 : 1, tail: '' });
    console.log(`  ${hit4 ? '\u2713' : '\u2717'} V8 ${dname} 含权威校验源口径`);
  }
  // V9（V1.4.8 起，I-6.4 防回归）：包内三探针必须带 10-29 run2 修复特征——
  // verify-manifest.py/verify-release.mjs 的运行期产物白名单（已装态包根假 FAIL 修复）
  // 与 vmcheck.ps1 的 RawContentStream UTF-8 解码（GBK 双坑修复）。缺失=fail-loud 拒产包。
  {
    const probes = [
      ['qa/deploy-probes/verify-manifest.py', 'runtime_ok', 'V9 verify-manifest 含运行期白名单'],
      ['delivery/verify-release.mjs', 'RUNTIME_OK', 'V9 verify-release 含运行期白名单'],
      ['qa/deploy-probes/vmcheck.ps1', 'RawContentStream', 'V9 vmcheck 含 UTF-8 解码修复'],
    ];
    for (const [rel, feat, label] of probes) {
      const fp = join(dest, 'overall', rel);
      const hit5 = existsSync(fp) && readFileSync(fp, 'utf8').includes(feat);
      results.push({ label, ok: hit5, status: hit5 ? 0 : 1, tail: '' });
      console.log(`  ${hit5 ? '\u2713' : '\u2717'} ${label}`);
    }
  }
  // V4 能力面：overall 的 @winvm/vm-capabilities 实体副本可 import 且计数=54
  const capPkg = join(dest, 'overall', 'packages', 'vm-capabilities', 'package.json');
  if (existsSync(capPkg)) {
    const main = JSON.parse(readFileSync(capPkg, 'utf8')).main ?? 'dist/index.js';
    const entry = pathToFileURL(join(dest, 'overall', 'packages', 'vm-capabilities', main)).href;
    const r = spawnSync(NODE, ['-e', `import(${JSON.stringify(entry)}).then(m=>{const c=m.WINDOWS_CAPABILITIES;const n=Array.isArray(c)?c.length:Object.keys(c).length;console.log('CAP_COUNT='+n);process.exit(n===54?0:1)}).catch(e=>{console.error(e.message);process.exit(1)})`], { cwd: join(dest, 'overall'), encoding: 'utf8' });
    const ok = r.status === 0 && (r.stdout ?? '').includes('CAP_COUNT=54');
    results.push({ label: 'V4 能力计数=54', ok, status: r.status, tail: (r.stdout ?? '') + (r.stderr ?? '') });
    console.log(`  ${ok ? '✓' : '✗'} V4 能力计数=54（exit ${r.status}）${ok ? '' : `\n${r.stdout}${r.stderr}`}`);
  } else {
    results.push({ label: 'V4 能力计数=54', ok: false, status: -1, tail: 'vm-capabilities/package.json 缺失' });
    console.log('  ✗ V4 能力计数=54（vm-capabilities/package.json 缺失）');
  }
  return results;
}

/* ------------------------------ 主流程 ------------------------------ */
let COMMIT = 'unknown';
function main() {
  const args = parseArgs(process.argv.slice(2));
  const version = resolveVersion(args);
  const head = git(['rev-parse', '--short', 'HEAD']);
  COMMIT = head.status === 0 ? head.stdout : 'unknown';
  console.log(`\n== pack-release ${version} @ ${COMMIT} ==`);
  assertPreflight(args, version);

  const dest = resolve(ROOT, args.out, version);
  if (existsSync(dest)) fail(`目标已存在：${relative(ROOT, dest)}（请先移走，避免半新半旧包）`);
  for (const kind of ['host', 'vm', 'overall']) ensureDir(join(dest, kind));

  // —— host ——
  console.log('· 组装 host/（install-host 闭包）');
  assembleCommon(join(dest, 'host'));
  copyList(HOST_DELIVERY, join(dest, 'host'));
  assembleHostNodeModules(join(dest, 'host'));
  genHostScript(join(dest, 'host'), version);
  writeReadme(join(dest, 'host'), 'host', version, {
    title: '宿主机一键部署发布包',
    body: [
      '## 内容',
      '- `delivery/`：install-host.mjs 及其 import/spawn 闭包（含隧道三件套、hooks、env.example）',
      '- `skills/`：8 个连接器 Skills（渲染进 ~/.workbuddy/connectors/skills/connector-winvm/）',
      '- `packages/`：各包运行期资产（dist/psmod/schemas，排除 src 与构建中间物）',
      '- `node_modules/@winvm/*`：实体副本（ESM 裸包名解析；不依赖 symlink）',
      '- `node_modules/ssh2` 链：进程内 ssh2 隧道离线分发（纯 JS 传递依赖）',
      '',
      '## 一键部署',
      '```bash',
      './deploy-host.sh                # 安装 WorkBuddy 插件+连接器+Skills+隧道（首次会先生成 .env 需编辑）',
      './deploy-host.sh --dry-run      # 预览',
      './deploy-host.sh --no-tunnel    # 跳过隧道（调试）',
      '```',
      '',
      '## 前置',
      '- 宿主机已部署 WorkBuddy；node ≥18（脚本自动解析：$WINVM_NODE_BIN → PATH → OH 内置路径）',
      '- `.env` 已填写 VM_HOST / VM_USER / WINVM_VM_PROVIDER（缺 .env 时脚本自动由 .env.example 生成并退出）',
      '',
      '## 验证',
      '- 安装尾自动做「仓库/包 ↔ 缓存」SHA256 新鲜度对账（失败即 exit 1）',
      '- `winvm-plugin health` 或 `curl http://127.0.0.1:18443/health`',
    ],
  });
  const hostMan = writeManifest(join(dest, 'host'), version, 'host');

  // —— vm ——
  console.log('· 组装 vm/（deploy-vm 闭包）');
  assembleCommon(join(dest, 'vm'));
  copyList(VM_DELIVERY, join(dest, 'vm'));
  copyList(VM_PROBES, join(dest, 'vm'));
  genVmScript(join(dest, 'vm'), version);
  writeReadme(join(dest, 'vm'), 'vm', version, {
    title: 'VM 一键部署发布包（宿主驱动）',
    body: [
      '## 内容',
      '- `delivery/`：deploy-vm.mjs → setup.mjs → install-vm.mjs 闭包（VM 内执行体随 tgz 落 C:/WinVMBridge）',
      '- `skills/`：VM 内 AI Agent 技能规范（shared-skills）',
      '- `packages/`：VM 运行期资产（dist + psmod 54 能力 PowerShell 实现 + schemas）',
      '- `qa/probes/`：QA-PROBE 相位推送物',
      '- 不含 node_modules：VM 侧经 install-vm `--skip-install` + junction 软链解析',
      '',
      '## 一键部署',
      '```bash',
      './deploy-vm.sh                  # 交互确认后执行 --apply --skip-build（真部署，使用包内已构建 dist）',
      './deploy-vm.sh --dry-run        # 预览计划',
      './deploy-vm.sh --apply --skip-build --provider workbuddy --cli <CLI路径>',
      '```',
      '',
      '> 发布包不含 src/tsconfig/tsc，故一键脚本默认 `--skip-build`（dist 已构建且 MANIFEST 指纹在册）。',
      '> 在**仓库根**运行时省略该 flag 即走完整 BUILD。',
      '',
      '## 前置',
      '- 宿主可 ssh 免密登录 VM（~/.ssh/id_ed25519，vm-conn.json 或 .env 指向 VM_HOST/VM_USER）',
      '- VM 内 node/npm/Agent CLI 就位（deterministic provider 缺 CLI 仅 WARN）',
      '- 注册计划任务 WinVMBridge.Service 需 VM 账户有管理员权限',
      '',
      '## 验证',
      '- deploy-vm 的 HEALTH 相位：经隧道 curl /health（provider/session/psBridge 三态）',
      '- VM 内 `C:/WinVMBridge/dev-and-qa/logs/<日期>/install-vm-run.log` 逐步留痕',
    ],
  });
  const vmMan = writeManifest(join(dest, 'vm'), version, 'vm');

  // —— overall ——
  console.log('· 组装 overall/（整体包 = host ∪ vm ∪ 编排与文档）');
  assembleCommon(join(dest, 'overall'));
  copyList([...new Set([...HOST_DELIVERY, ...VM_DELIVERY, ...OVERALL_EXTRA_DELIVERY])], join(dest, 'overall'));
  copyList(OVERALL_TOOLS, join(dest, 'overall'));
  copyList(VM_PROBES, join(dest, 'overall'));
  copyList(DEPLOY_PROBES, join(dest, 'overall'));
  assembleHostNodeModules(join(dest, 'overall'));
  genOverallScript(join(dest, 'overall'), version);
  ensureDir(join(dest, 'overall', 'docs'));
  for (const [src, name] of OVERALL_DOCS) {
    if (!existsSync(join(ROOT, src))) fail(`overall 文档源缺失：${src}（请先撰写）`);
    const dst = join(dest, 'overall', 'docs', name);
    ensureDir(dirname(dst)); // name 可含子目录（deploy/xxx.md）
    cpSync(join(ROOT, src), dst);
  }
  writeReadme(join(dest, 'overall'), 'overall', version, {
    title: '整体一键部署发布包（宿主机 + VM + 文档）',
    body: [
      '## 内容',
      '- host 包与 vm 包的全部条目（并集，共享同一闭包）',
      '- `delivery/bootstrap.mjs` / `prepare-vm.mjs`：环境自检 + SSH 信任 + env 生成（备环境）',
      '- `delivery/uninstall.mjs`：双端清场（回收站可恢复）',
      '- `docs/`：DEPLOYMENT / INSTALL-GUIDE / USER-MANUAL / SCENARIOS / RELEASE-NOTES / 发布设计 / 发布说明 / issues 台账 / **deploy/ 五件**（部署策略 deploy-strategy + 部署 Prompt 总集 deploy-prompts + 卸载 Prompt 总集 undeploy-prompts + **一键粘贴脚本 deploy.prompt / undeploy.prompt**——整段复制给 WorkBuddy 即可安装/卸载，用法见下方「快速部署/卸载」）',
      '## 快速部署/卸载（零仓库）',
      '1. 解压本包 → 解出目录即包根（含 `MANIFEST.txt` 与 `delivery/`）。',
      '2. 打开 `docs/deploy/deploy.prompt`，先把【运行期注入】段里的 `VM_HOST` / `VM_USER` / `PKG_ROOT`（=包根绝对路径）等按实际环境改好。',
      '3. 整段复制粘贴给 WorkBuddy（鸿蒙宿主）新会话，即按 Step 1→6 自动部署，每步带判据自检。',
      '4. 卸载同理：整段粘贴 `docs/deploy/undeploy.prompt`（U0→U5，DRY-RUN 先行，默认保留工作区与 SSH 密钥）。',
      '',
      '## 一键部署',
      '```bash',
      'bash deploy-all.sh --wipe         # 双端清空历史部署后整体重装（推荐用于首发/灾难恢复；bash 显式解释防 hmdfs 丢执行位）',
      'bash deploy-all.sh                # 不清场，直接 setup.mjs --apply --skip-build',
      'bash deploy-all.sh --wipe --yes   # 预留：其余参数透传 setup.mjs',
      '```',
      '',
      '> 一键脚本默认 `--skip-build`：发布包内 dist 已构建且逐文件 sha256 指纹在 MANIFEST.txt，',
      '> 包不含 src/tsconfig/tsc（无法也不应重建）。在仓库根部署时可省略该 flag 走完整 BUILD。',
      '',
      '## 完整功能验证清单（部署后逐项过）',
      '1. `curl http://127.0.0.1:18443/health`：provider=ready、session.state=healthy',
      '2. MCP 直调 `meta.capability.list`：count=54',
      '3. MCP 直调 `system.info.get`：实调返回',
      '4. A2A `a2a.delegate`（system.info.get）：streaming 终态 ok',
      '5. `gui.session.status`：healthy / locked=false',
      '6. 审计链：委派 traceId 在链、delegation.complete 诚实回执',
      '',
      '## 回滚',
      '- 宿主机：`node delivery/uninstall.mjs --apply`（插件缓存/连接器移入回收站）',
      '- VM：install-vm.mjs --uninstall 或 uninstall.mjs 双端（删 C:/WinVMBridge、注销计划任务）',
    ],
  });
  const overallMan = writeManifest(join(dest, 'overall'), version, 'overall');

  // —— 包内验证 ——
  let verifyOk = true;
  if (args.skipVerify) {
    console.log('· 跳过包内验证（--skip-verify）');
  } else {
    console.log('· 包内验证（V2 host 闭包 / V3 vm 闭包 / V4 能力计数）');
    const rs = verifyPackages(dest, version);
    verifyOk = rs.every((r) => r.ok);
    if (!verifyOk) {
      console.error('\n✗ 包内验证未全过——发布包不可信，终止（不写证据）。失败项：');
      for (const r of rs.filter((x) => !x.ok)) console.error(`  - ${r.label}\n${r.tail.slice(-2000)}`);
      process.exit(1);
    }
  }

  // —— zip 发布资产（V1-V4 全过后才做；失败 fail-loud ⇒ 不落残缺证据）——
  // overall 是唯一面向新机分发的单元：GitHub Release 匿名 curl 下载的就是这个 zip；
  // Q-2 旁挂 <zip>.sha256（sha256sum -c 兼容）随 zip 一同上架，解包前即可整包校验。
  console.log('· 生成 overall zip + sha256 旁挂（GitHub Release 分发单元）');
  const overallZip = makeOverallZip(dest, version);

  // —— 证据（版本化入库；release/ 本体不入库） ——
  const evDir = resolve(ROOT, args.evidenceDir);
  ensureDir(evDir);
  const evLines = [
    `# pack-release 证据 · ${version}`,
    `commit: ${COMMIT}`,
    `date: ${new Date().toISOString()}`,
    `node: ${process.version}`,
    `verify: ${args.skipVerify ? 'SKIPPED' : 'PASS (V2/V3/V4)'}`,
    '',
    `host    : files=${hostMan.files} bytes=${hostMan.bytes} total-sha256=${hostMan.total}`,
    `vm      : files=${vmMan.files} bytes=${vmMan.bytes} total-sha256=${vmMan.total}`,
    `overall : files=${overallMan.files} bytes=${overallMan.bytes} total-sha256=${overallMan.total}`,
    overallZipEvidenceLine(relative(ROOT, overallZip.path), overallZip),
    overallZipSha256EvidenceLine(relative(ROOT, overallZip.sidecarPath)),
    '',
    '# 目录树（release/' + version + '）',
    ...treeOf(join(dest)),
  ];
  const evPath = join(evDir, `${version}-pack.txt`);
  writeFileSync(evPath, evLines.join('\n') + '\n');

  console.log(`\n✓ 发布包已生成：${relative(ROOT, dest)}`);
  console.log(`  host    ${hostMan.files} 文件 / ${(hostMan.bytes / 1024).toFixed(0)}K / sha256 ${hostMan.total.slice(0, 16)}…`);
  console.log(`  vm      ${vmMan.files} 文件 / ${(vmMan.bytes / 1024).toFixed(0)}K / sha256 ${vmMan.total.slice(0, 16)}…`);
  console.log(`  overall ${overallMan.files} 文件 / ${(overallMan.bytes / 1024).toFixed(0)}K / sha256 ${overallMan.total.slice(0, 16)}…`);
  console.log(`  overall-zip ${relative(ROOT, overallZip.path)} / ${(overallZip.bytes / 1024).toFixed(0)}K / sha256 ${overallZip.sha256.slice(0, 16)}…  旁挂 ${relative(ROOT, overallZip.sidecarPath)}  →上架：node delivery/publish-release.mjs --tag ${version} --zip ${relative(ROOT, overallZip.path)} [--apply]`);
  console.log(`  证据：${relative(ROOT, evPath)}`);
  console.log(`\n下一步：cd ${relative(ROOT, dest)}/overall && bash deploy-all.sh --wipe   （清空历史部署后整体重装；bash 显式解释防 hmdfs 丢执行位）\n`);
}
function treeOf(dir, prefix = '') {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name === 'node_modules') { out.push(`${prefix}${e.name}/  （@winvm 实体副本 + ssh2 链，逐文件见 MANIFEST）`); continue; }
    out.push(`${prefix}${e.name}${e.isDirectory() ? '/' : ''}`);
    if (e.isDirectory() && e.name !== 'node_modules') out.push(...treeOf(join(dir, e.name), prefix + '  '));
  }
  return out;
}
/* 直接执行守卫：`node delivery/pack-release.mjs` 才跑主流程；
 * 单测 import 纯函数（zipNameFor / buildZipSpawn / overallZipEvidenceLine / publish*）不触发副作用。 */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

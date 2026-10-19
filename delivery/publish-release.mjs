#!/usr/bin/env node
/**
 * publish-release.mjs — 一键上架 GitHub Release（REL-11 C）
 *
 * 把 pack-release.mjs 产出的 overall zip 发布为 GitHub Release 资产，
 * 供新鸿蒙机 WorkBuddy **匿名 curl 下载**（仓库 public 后即为分发链路起点）。
 *
 * 用法：
 *   node delivery/publish-release.mjs --tag V1.4.0 --zip release/V1.4.0/winvm-overall-V1.4.0.zip
 *       # 默认 dry-run：只打印计划，绝不发写请求（GET 只读探测允许失败）
 *   node delivery/publish-release.mjs --tag V1.4.0 --zip ... --apply
 *       # 真上架：建/复用 release → 清同名旧 asset → 上传 zip → 打印下载 URL
 *
 * 安全红线：
 *   - **默认 dry-run**（与 setup.mjs 防呆同族思路）：不带 --apply 零写操作；
 *   - token 绝不打印（只打印来源）；解析顺序 GH_TOKEN env → --token → ~/.config/gh/hosts.yml；
 *   - 只碰 GitHub REST，不碰 VM/隧道/运行态；仓库本体零写入。
 *
 * 纯函数（zipNameFor/planUpload/resolveTokenSource/... 均导出）⇒ 单测零网络覆盖。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const GIT = '/storage/Users/currentUser/.harmonybrew/opt/git/bin/git';
/** 兜底仓库坐标（remote 探测失败时用；当前唯一真相=GitHub public 仓库） */
export const DEFAULT_REPO = 'athronix/workbuddy-virtual-win-plugin';
export const API = 'https://api.github.com';

/* ------------------------------ 参数 ------------------------------ */
function parseArgs(argv) {
  const out = { tag: null, zip: null, repo: null, notes: null, apply: false, token: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--tag': out.tag = argv[++i]; break;
      case '--zip': out.zip = argv[++i]; break;
      case '--repo': out.repo = argv[++i]; break;
      case '--notes': out.notes = argv[++i]; break;
      case '--apply': out.apply = true; break;
      case '--token': out.token = argv[++i]; break;
      case '--help': case '-h': out.help = true; break;
      default: console.error(`未知参数：${argv[i]}`); printUsage(); process.exit(2);
    }
  }
  return out;
}
function printUsage() {
  console.log([
    '用法：node delivery/publish-release.mjs --tag Vx.y.z --zip <overall.zip> [--repo owner/name] [--notes <text>] [--apply] [--token <tok>]',
    '  默认 dry-run（零写操作）；--apply 才真正创建/上传 GitHub Release 资产。',
    '  token 解析顺序：GH_TOKEN env → --token → ~/.config/gh/hosts.yml（oauth_token，绝不打印）。',
  ].join('\n'));
}

/* ------------------------------ 纯函数（单测覆盖面对象） ------------------------------ */

/**
 * repo 解析优先级：--repo 参数 → git remote origin（SSH 与 HTTPS 两种 URL 形态都吃）→ 硬编码兜底。
 * @param {{repo?: string|null}} opts
 * @param {(cmd:string,args:string[])=>{status:number,stdout:string}} [gitRun] 可注入（单测零 spawn）
 * @returns {{repo:string, source:'arg'|'git-remote'|'fallback'}}
 */
export function resolveRepo(opts = {}, gitRun = defaultGitRun) {
  if (opts.repo) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(opts.repo)) throw new Error(`--repo 形态非法：${opts.repo}`);
    return { repo: opts.repo, source: 'arg' };
  }
  const r = gitRun(GIT, ['-C', ROOT, 'remote', 'get-url', 'origin']);
  const m = r.status === 0 && (r.stdout || '').trim().match(/github\.com[:\/]([^/]+\/[^/]+?)(?:\.git)?\/?\s*$/);
  if (m) return { repo: m[1], source: 'git-remote' };
  return { repo: DEFAULT_REPO, source: 'fallback' };
}
function defaultGitRun(cmd, args) {
  const x = spawnSync(cmd, args, { encoding: 'utf8' });
  return { status: x.status ?? 127, stdout: x.stdout ?? '' };
}

/**
 * token 解析优先级（返回**来源标签**与值；值绝不打印）。
 * @param {{env?: Record<string,string|undefined>, tokenArg?: string|null, hostsContent?: string|null}} opts
 *   hostsContent 语义：undefined=生产默认（读 ~/.config/gh/hosts.yml，不存在视作空）；
 *   string=直接喂内容（单测零 IO）；null=显式"文件不存在"（单测隔离真机 hosts.yml）。
 * @returns {{token: string|null, source: 'GH_TOKEN'|'--token'|'gh-hosts.yml'|'none'}}
 */
export function resolveToken(opts = {}) {
  const env = opts.env ?? process.env;
  if (env.GH_TOKEN && env.GH_TOKEN.trim()) return { token: env.GH_TOKEN.trim(), source: 'GH_TOKEN' };
  if (opts.tokenArg && String(opts.tokenArg).trim()) return { token: String(opts.tokenArg).trim(), source: '--token' };
  let yml = opts.hostsContent;
  if (yml === undefined) {
    const p = join(homedir(), '.config', 'gh', 'hosts.yml');
    yml = existsSync(p) ? readFileSync(p, 'utf8') : null;
  }
  if (yml) {
    // hosts.yml 结构里 oauth_token 是唯一认证键（gh CLI 自身格式）；只取首个命中。
    const m = yml.match(/^\s*oauth_token:\s*(\S+)\s*$/m);
    if (m && m[1]) return { token: m[1], source: 'gh-hosts.yml' };
  }
  return { token: null, source: 'none' };
}

/**
 * 待上传资产清单（Q-2 纯函数）：zip 本体 + 旁挂 `<zip>.sha256`（pack-release 产、
 * 同目录、sha256sum -c 兼容）。旁挂缺失 ⇒ **warn 继续、只上架 zip**（兼容旧包；
 * 新机侧回退 MANIFEST/pack 证据校验，team-lead 裁决口径）。
 * @param {string} zipPath zip 绝对/相对路径
 * @param {boolean} sidecarExists 旁挂文件是否存在
 * @returns {{assets: {path:string, name:string, contentType:string}[], warn:string|null}}
 */
export function buildAssetList(zipPath, sidecarExists) {
  const zipName = zipPath.split(/[\\/]/).pop();
  const assets = [{ path: zipPath, name: zipName, contentType: 'application/zip' }];
  let warn = null;
  if (sidecarExists) {
    assets.push({ path: `${zipPath}.sha256`, name: `${zipName}.sha256`, contentType: 'text/plain' });
  } else {
    warn = `旁挂校验文件 ${zipName}.sha256 缺失——仅上架 zip（兼容旧包；新机侧回退 MANIFEST/pack 证据校验）`;
  }
  return { assets, warn };
}

/**
 * 上传计划（纯函数）：根据「release 是否已存在」与「同名 asset 是否已存在」决定动作序列。
 * @param {{repo:string, tag:string, zipName:string, assetNames?: string[], hasRelease:boolean, assetId:(number|null), assetIds?: (number|null)[], hasToken:boolean}} s
 *   assetNames/assetIds：多资产（zip + 旁挂 sha256）；旧字段 zipName/assetId 兼容保留（缺省时由数组回填）。
 * @returns {{steps:string[], uploadUrl:string, needCreateRelease:boolean, needDeleteAsset:boolean, deletes:{name:string, id:number}[]}}
 */
export function planUpload(s) {
  const repo = s.repo, tag = s.tag;
  const names = (s.assetNames && s.assetNames.length) ? s.assetNames : [s.zipName];
  const ids = (s.assetIds != null) ? s.assetIds : [s.assetId == null ? null : s.assetId];
  const zipName = s.zipName ?? names[0];
  const steps = [];
  let needCreateRelease = false;
  let needDeleteAsset = false;
  const deletes = [];
  if (s.hasRelease) {
    steps.push(`GET  releases/tags/${tag} → 命中(200)，复用其 upload_url`);
  } else {
    needCreateRelease = true;
    steps.push(`POST /repos/${repo}/releases {tag_name:"${tag}", name:"${tag}", draft:false} → 取 upload_url`);
  }
  names.forEach((name, i) => {
    const id = ids[i];
    if (id != null) {
      needDeleteAsset = true;
      deletes.push({ name, id });
      steps.push(`DELETE /repos/${repo}/releases/assets/${id} → 先清同名旧资产 ${name}`);
    } else {
      steps.push(`（无同名资产 ${name}，跳过 DELETE）`);
    }
  });
  for (const name of names) steps.push(`POST <upload_url>?name=${name} → 上传`);
  const uploadUrl = s.hasRelease
    ? '(既有 release 的 upload_url)'
    : `${API}/repos/${repo}/releases (响应 upload_url 字段)`;
  if (!s.hasToken) steps.push('⚠ 无 token：只能 dry-run（GitHub 资产上传必须鉴权）');
  return { steps, uploadUrl, needCreateRelease, needDeleteAsset, deletes };
}

/**
 * 匿名下载 URL（新鸿蒙机 curl 的目标地址，public 仓库无需 token）。
 * @param {{repo:string, tag:string, zipName:string}} s
 */
export function downloadUrl(s) {
  return `https://github.com/${s.repo}/releases/download/${s.tag}/${s.zipName}`;
}

/** dry-run 判定：显式 --apply 才执行写操作（安全默认）。 */
export function isDryRun({ apply }) {
  return apply !== true;
}

/** tag 形态校验（与 pack-release 同口径 Vx.y.z）。 */
export function assertTag(tag) {
  if (!/^V\d+\.\d+\.\d+$/.test(String(tag ?? ''))) throw new Error(`tag 非法（须 Vx.y.z）：${tag}`);
  return String(tag);
}

/* ------------------------------ GitHub REST（fetch） ------------------------------ */

/** GET 探测（只读；dry-run 网络不可达时由调用方容错）。返回 {status, body}。 */
async function ghFetch(url, token, init) {
  const headers = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
  };
  const res = await fetch(url, { ...init, headers });
  let body = null;
  try { body = await res.json(); } catch { /* 非 JSON（如代理门户）按 null 处理 */ }
  return { status: res.status, body };
}

/**
 * 主流程。
 * @param {string[]} argv
 */
export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) { printUsage(); return 0; }
  if (!args.tag || !args.zip) { console.error('缺少 --tag 或 --zip'); printUsage(); return 2; }
  let tag;
  try { tag = assertTag(args.tag); } catch (e) { console.error(e.message); return 2; }

  const zipPath = resolve(ROOT, args.zip);
  if (!existsSync(zipPath)) { console.error(`✗ zip 不存在：${zipPath}`); return 2; }
  const st = statSync(zipPath);
  if (!st.isFile()) { console.error(`✗ 不是文件：${zipPath}`); return 2; }
  const zipName = zipPath.split(/[\\/]/).pop();
  if (!zipName.endsWith('.zip')) { console.error(`✗ 后缀须 .zip：${zipName}`); return 2; }
  // Q-2 旁挂资产：pack 侧产 <zip>.sha256 ⇒ 双资产上架；缺失=warn 继续只上架 zip（兼容旧包）。
  const sidecarPath = `${zipPath}.sha256`;
  const sidecarExists = existsSync(sidecarPath);
  const { assets, warn: assetWarn } = buildAssetList(zipPath, sidecarExists);
  if (assetWarn) console.log(`  ⚠ WARN : ${assetWarn}`);

  let repoInfo;
  try { repoInfo = resolveRepo({ repo: args.repo }); } catch (e) { console.error(`✗ ${e.message}`); return 2; }
  const tok = resolveToken({ tokenArg: args.token });
  const dry = isDryRun({ apply: args.apply });

  console.log(`\n== publish-release（${dry ? 'DRY-RUN：零写操作' : 'APPLY：将真实上架'}）==`);
  console.log(`  repo   : ${repoInfo.repo}（来源=${repoInfo.source}）`);
  console.log(`  tag    : ${tag}`);
  console.log(`  zip    : ${zipName}（${(st.size / 1024 / 1024).toFixed(2)} MB, ${st.size} bytes）`);
  console.log(`  notes  : ${args.notes ? 'provided' : '(default: tag name body)'}`);
  console.log(`  token  : ${tok.source === 'none' ? 'NONE（仅只读探测/仅 dry-run）' : `present（来源=${tok.source}，值不打印）`}`);

  // 只读探测（GET）：dry-run 下也做，但网络失败不致命（离线时打印 UNKNOWN 继续出计划）。
  let hasRelease = false; let release = null;
  const assetIds = assets.map(() => null);
  const probe = await probeRelease(`${API}/repos/${repoInfo.repo}/releases/tags/${tag}`, tok.token);
  if (probe === 'NETWORK-UNKNOWN') {
    console.log('  probe  : 网络不可达（dry-run 容错继续；--apply 需网络）');
  } else if (probe) {
    hasRelease = true; release = probe;
    assets.forEach((a, i) => {
      const hit = (probe.assets ?? []).find((x) => x && x.name === a.name);
      if (hit) assetIds[i] = hit.id;
    });
    const onBook = assetIds.filter((x) => x != null).length;
    console.log(`  probe  : release ${tag} 已存在（id=${probe.id}）${onBook ? `，同名 asset ${onBook} 个在册 ⇒ 将先 DELETE 再传` : '，无同名 asset'}`);
  } else {
    console.log(`  probe  : release ${tag} 不存在（404）⇒ 将 POST 创建`);
  }

  const plan = planUpload({
    repo: repoInfo.repo, tag, zipName,
    assetNames: assets.map((a) => a.name), assetIds,
    hasRelease, hasToken: !!tok.token,
  });
  console.log('  资产   :');
  for (const a of assets) console.log(`    - ${a.name}${a.path === zipPath ? `（${(st.size / 1024 / 1024).toFixed(2)} MB）` : ''}`);
  console.log('  计划   :');
  for (const s of plan.steps) console.log(`    - ${s}`);
  console.log(`  下载URL: ${downloadUrl({ repo: repoInfo.repo, tag, zipName })}`);

  if (dry) {
    console.log('\n✓ DRY-RUN 完成（未发送任何写请求）。加 --apply 执行真实上架。');
    return 0;
  }
  if (!tok.token) { console.error('\n✗ --apply 必须有 token（GH_TOKEN / --token / gh hosts.yml 三者之一）'); return 2; }

  // —— APPLY：建/复用 release ——
  let uploadUrl = release && release.upload_url;
  if (!hasRelease) {
    const created = await ghFetch(`${API}/repos/${repoInfo.repo}/releases`, tok.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tag_name: tag,
        name: tag,
        body: args.notes ?? `WinVM Bridge ${tag} overall release package (winvm-overall-${tag}.zip).`,
        draft: false,
      }),
    });
    if (created.status !== 201 || !created.body || !created.body.upload_url) {
      console.error(`\n✗ 创建 release 失败（HTTP ${created.status}）：${JSON.stringify(created.body).slice(0, 400)}`);
      console.error('  提示：tag 必须已在 GitHub 存在（git push origin <tag>）；本脚本不建 tag。');
      return 1;
    }
    release = created.body; uploadUrl = created.body.upload_url;
    console.log(`  ✓ release 已创建：${created.body.html_url}`);
  }
  // —— 清同名旧 asset（zip + 旁挂逐个）——
  for (const d of plan.deletes) {
    const del = await ghFetch(`${API}/repos/${repoInfo.repo}/releases/assets/${d.id}`, tok.token, { method: 'DELETE' });
    if (del.status !== 204) {
      console.error(`\n✗ 删除旧 asset ${d.name} 失败（HTTP ${del.status}）：${JSON.stringify(del.body).slice(0, 300)}`);
      return 1;
    }
    console.log(`  ✓ 旧同名 asset 已删除：${d.name}（id=${d.id}）`);
  }
  // —— 逐资产上传（zip 先、旁挂 .sha256 后；任一失败 fail-loud）——
  let zipAsset = null;
  for (const a of assets) {
    const buf = readFileSync(a.path);
    // 注：不显式设 Content-Length——Buffer body 由 undici 自动计算（显式设置反成 forbidden-header 风险面）
    const upl = await ghFetch(`${uploadUrl}?name=${encodeURIComponent(a.name)}`, tok.token, {
      method: 'POST',
      headers: { 'Content-Type': a.contentType },
      body: buf,
    });
    if (upl.status !== 201 || !upl.body || !upl.body.browser_download_url) {
      console.error(`\n✗ 上传失败 ${a.name}（HTTP ${upl.status}）：${JSON.stringify(upl.body).slice(0, 400)}`);
      return 1;
    }
    console.log(`  ✓ 上传成功：${upl.body.name}（${upl.body.size} bytes, asset id=${upl.body.id}）`);
    if (a.name === zipName) zipAsset = upl.body;
  }
  console.log(`\n== 上架完成 ==`);
  console.log(`  Release 页面 : ${release.html_url ?? `${API}/repos/${repoInfo.repo}/releases/tags/${tag}`}`);
  console.log(`  匿名下载 URL : ${zipAsset.browser_download_url}`);
  if (sidecarExists) console.log(`  校验旁挂 URL : https://github.com/${repoInfo.repo}/releases/download/${tag}/${zipName}.sha256`);
  console.log(`  （新鸿蒙机 WorkBuddy 用此 URL curl；sha256 校验对照旁挂文件 sha256sum -c 或 qa/release/${tag}-pack.txt 的 overall-zip 行）`);
  return 0;
}

/**
 * GET release 探测。返回：对象=命中(200)；null=404 确认不存在；'NETWORK-UNKNOWN'=网络/鉴权异常。
 * 与主流程分离 ⇒ 单测可整体绕开网络（测纯函数即可覆盖判定语义）。
 */
async function probeRelease(url, token) {
  try {
    const { status, body } = await ghFetch(url, token, { method: 'GET' });
    if (status === 200 && body && typeof body === 'object') return body;
    if (status === 404) return null;
    return 'NETWORK-UNKNOWN';
  } catch {
    return 'NETWORK-UNKNOWN';
  }
}

/* ------------------------------ 直接执行守卫 ------------------------------ */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((e) => {
    console.error(`\n✗ publish-release 未捕获异常：${e && e.stack ? e.stack.slice(0, 800) : e}`);
    process.exitCode = 1;
  });
}

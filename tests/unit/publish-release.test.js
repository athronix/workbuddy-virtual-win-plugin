/**
 * REL-11 C · delivery/publish-release.mjs 纯函数单测（零网络、零写盘）
 *
 * 覆盖面上任务书点名的五族：
 *   ① token 解析优先级（GH_TOKEN env → --token → gh hosts.yml → none；hosts.yml 正则提取）
 *   ② upload_url 选择（release 已存在=复用 vs 不存在=POST 创建）
 *   ③ 同名 asset 判定（存在⇒DELETE 计划 + 动作序列；不存在⇒跳过）
 *   ④ 下载 URL 拼装（新鸿蒙机 curl 的目标地址形态）
 *   ⑤ dry-run 判定（安全默认：apply!==true 即 dry-run）+ tag 校验 + zipNameFor/证据行格式
 *
 * 运行（只跑本文件）：node --test tests/unit/publish-release.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveToken,
  resolveRepo,
  planUpload,
  downloadUrl,
  buildUploadUrl,
  buildHeaders,
  isDryRun,
  assertTag,
  buildAssetList,
  DEFAULT_REPO,
} from '../../delivery/publish-release.mjs';
import {
  zipNameFor,
  buildZipSpawn,
  overallZipEvidenceLine,
  overallZipSha256EvidenceLine,
  sha256SidecarNameFor,
  sha256SidecarContent,
  diffZipEntriesVsManifest,
} from '../../delivery/pack-release.mjs';

/* ==================== ① token 解析优先级 ==================== */

test('token：GH_TOKEN env 优先于 --token 与 hosts.yml', () => {
  const r = resolveToken({
    env: { GH_TOKEN: 'env-tok' },
    tokenArg: 'arg-tok',
    hostsContent: 'github.com:\n  oauth_token: yml-tok\n  user: athronix\n',
  });
  assert.equal(r.token, 'env-tok');
  assert.equal(r.source, 'GH_TOKEN');
});

test('token：无 env 时 --token 次之', () => {
  const r = resolveToken({ env: {}, tokenArg: 'arg-tok', hostsContent: 'github.com:\n  oauth_token: yml-tok\n' });
  assert.equal(r.token, 'arg-tok');
  assert.equal(r.source, '--token');
});

test('token：env/--token 皆空（含纯空白=空）时落到 hosts.yml，正则提取 oauth_token', () => {
  const r = resolveToken({
    env: { GH_TOKEN: '   ' },
    tokenArg: null,
    hostsContent: 'github.com:\n  oauth_token: gho_ABC123def456\n  user: athronix\n',
  });
  assert.equal(r.token, 'gho_ABC123def456');
  assert.equal(r.source, 'gh-hosts.yml');
});

test('token：三源全空 → source=none、token=null（dry-run 可用、apply 必拒的主判据）', () => {
  const r = resolveToken({ env: {}, tokenArg: '', hostsContent: 'github.com:\n  user: nobody\n' });
  assert.equal(r.token, null);
  assert.equal(r.source, 'none');
});

test('token：hosts.yml 空内容/缺失（null）不崩，落 none', () => {
  assert.deepEqual(resolveToken({ env: {}, tokenArg: null, hostsContent: null }), { token: null, source: 'none' });
  assert.deepEqual(resolveToken({ env: {}, tokenArg: null, hostsContent: '' }), { token: null, source: 'none' });
});

/* ==================== ② upload_url 选择 ==================== */

test('plan：release 不存在 ⇒ POST /repos/{repo}/releases 创建并取其 upload_url', () => {
  const p = planUpload({ repo: 'athronix/demo', tag: 'V1.4.0', zipName: 'winvm-overall-V1.4.0.zip', hasRelease: false, assetId: null, hasToken: true });
  assert.equal(p.needCreateRelease, true);
  assert.ok(p.steps.some((s) => s.includes('POST /repos/athronix/demo/releases') && s.includes('upload_url')), JSON.stringify(p.steps));
  assert.ok(p.uploadUrl.includes('upload_url'), 'upload_url 语义：从创建响应字段来');
});

test('plan：release 已存在 ⇒ 复用其 upload_url，不再 POST 创建', () => {
  const p = planUpload({ repo: 'athronix/demo', tag: 'V1.4.0', zipName: 'winvm-overall-V1.4.0.zip', hasRelease: true, assetId: null, hasToken: true });
  assert.equal(p.needCreateRelease, false);
  assert.ok(p.steps.some((s) => s.includes('复用其 upload_url')));
  assert.ok(!p.steps.some((s) => s.startsWith('POST /repos')), '已存在 release 不得计划创建');
});

/* ==================== ③ 同名 asset 判定 ==================== */

test('plan：同名 asset 在册 ⇒ 先 DELETE 该 asset 再上传（动作顺序钉）', () => {
  const p = planUpload({ repo: 'athronix/demo', tag: 'V1.4.0', zipName: 'winvm-overall-V1.4.0.zip', hasRelease: true, assetId: 991, hasToken: true });
  assert.equal(p.needDeleteAsset, true);
  const joined = p.steps.join('\n');
  const iDel = joined.indexOf('DELETE /repos/athronix/demo/releases/assets/991');
  const iUp = joined.indexOf('?name=winvm-overall-V1.4.0.zip');
  assert.ok(iDel >= 0, '缺 DELETE 计划行');
  assert.ok(iUp >= 0, '缺上传计划行');
  assert.ok(iDel < iUp, 'DELETE 必须排在上传之前（同 id 撞名 GitHub 拒 42）');
});

test('plan：无同名 asset ⇒ 跳过 DELETE（幂等重跑形态）', () => {
  const p = planUpload({ repo: 'athronix/demo', tag: 'V1.4.0', zipName: 'a.zip', hasRelease: true, assetId: null, hasToken: true });
  assert.equal(p.needDeleteAsset, false);
  assert.ok(!p.steps.some((s) => s.startsWith('DELETE')), '无 asset 却计划 DELETE = 判据漂');
});

test('plan：无 token ⇒ 计划里显形警告（上传必须鉴权）', () => {
  const p = planUpload({ repo: 'athronix/demo', tag: 'V1.4.0', zipName: 'a.zip', hasRelease: false, assetId: null, hasToken: false });
  assert.ok(p.steps.some((s) => s.includes('无 token')));
});

/* ==================== ④ 下载 URL 拼装 ==================== */

test('downloadUrl：匿名下载 URL 形态 = github.com/{repo}/releases/download/{tag}/{zipname}', () => {
  assert.equal(
    downloadUrl({ repo: 'athronix/workbuddy-virtual-win-plugin', tag: 'V1.4.0', zipName: 'winvm-overall-V1.4.0.zip' }),
    'https://github.com/athronix/workbuddy-virtual-win-plugin/releases/download/V1.4.0/winvm-overall-V1.4.0.zip',
  );
});

/* ==================== ⑤ dry-run 判定 + tag 校验 + repo 解析 ==================== */

test('isDryRun：缺省/False 一律 dry-run；仅显式 apply=true 才执行（安全默认）', () => {
  assert.equal(isDryRun({}), true);
  assert.equal(isDryRun({ apply: undefined }), true);
  assert.equal(isDryRun({ apply: false }), true);
  assert.equal(isDryRun({ apply: true }), false);
});

test('assertTag：Vx.y.z 放行；v1.4.0/1.4.0/空 拒绝（与 pack-release 同口径）', () => {
  assert.equal(assertTag('V1.4.0'), 'V1.4.0');
  for (const bad of ['v1.4.0', '1.4.0', 'V1.4', '', null, undefined]) {
    assert.throws(() => assertTag(bad), /tag 非法/, `应拒绝：${String(bad)}`);
  }
});

test('resolveRepo：--repo 参数最优先；git remote SSH/HTTPS 双形态解析；探测失败回退硬编码', () => {
  const a = resolveRepo({ repo: 'foo/bar' }, () => ({ status: 0, stdout: 'irrelevant\n' }));
  assert.deepEqual(a, { repo: 'foo/bar', source: 'arg' });

  const ssh = resolveRepo({}, () => ({ status: 0, stdout: 'git@github.com:athronix/workbuddy-virtual-win-plugin.git\n' }));
  assert.deepEqual(ssh, { repo: 'athronix/workbuddy-virtual-win-plugin', source: 'git-remote' });

  const https = resolveRepo({}, () => ({ status: 0, stdout: 'https://github.com/athronix/some-repo.git\n' }));
  assert.deepEqual(https, { repo: 'athronix/some-repo', source: 'git-remote' });

  const gone = resolveRepo({}, () => ({ status: 128, stdout: '' }));
  assert.deepEqual(gone, { repo: DEFAULT_REPO, source: 'fallback' });

  assert.throws(() => resolveRepo({ repo: 'not-a-repo' }, () => ({ status: 0, stdout: '' })), /非法/);
});

/* ==================== zip 资产口径（A 与 C 的接缝） ==================== */

test('zipNameFor / buildZipSpawn：包内根恒为 overall/，zip 落 release/<version>/ 旁', () => {
  assert.equal(zipNameFor('V1.4.0'), 'winvm-overall-V1.4.0.zip');
  const plan = buildZipSpawn('/tmp/rel/V1.4.0', 'V1.4.0');
  assert.equal(plan.cmd, 'zip');
  assert.deepEqual(plan.args, ['-qr', 'winvm-overall-V1.4.0.zip', 'overall']);
  assert.equal(plan.cwd, '/tmp/rel/V1.4.0', '从 release/<version> 执行 ⇒ 包内根=overall/');
  assert.equal(plan.outPath, '/tmp/rel/V1.4.0/winvm-overall-V1.4.0.zip');
});

test('overallZipEvidenceLine：证据行格式 = `overall-zip: <path> sha256=<hex> bytes=<n>`', () => {
  const line = overallZipEvidenceLine('release/V1.4.0/winvm-overall-V1.4.0.zip', { sha256: 'ab12', bytes: 1234 });
  assert.equal(line, 'overall-zip: release/V1.4.0/winvm-overall-V1.4.0.zip sha256=ab12 bytes=1234');
});

/* ==================== Q-2 旁挂 sha256 资产（zip + .zip.sha256 双资产上架） ==================== */

test('Q-2 sha256SidecarNameFor/Content：旁挂名=<zip>.sha256，内容 sha256sum -c 兼容（两空格二进制模式）', () => {
  assert.equal(sha256SidecarNameFor('winvm-overall-V1.4.0.zip'), 'winvm-overall-V1.4.0.zip.sha256');
  const c = sha256SidecarContent('winvm-overall-V1.4.0.zip', 'ab12cd34');
  // 格式硬钉：hex + 恰好两空格 + 相对 zip 名 + 单行（sha256sum -c 可解析）
  assert.match(c, /^[0-9a-f]{6,}?\S+  winvm-overall-V1\.4\.0\.zip\n$/);
  assert.equal(c, 'ab12cd34  winvm-overall-V1.4.0.zip\n');
});

test('Q-2 buildAssetList：zip 先、旁挂后；旁挂缺失⇒1 asset + warn 继续（兼容旧包，warn 必显形）', () => {
  const both = buildAssetList('/r/V1.4.0/winvm-overall-V1.4.0.zip', true);
  assert.deepEqual(both.assets.map((a) => a.name), ['winvm-overall-V1.4.0.zip', 'winvm-overall-V1.4.0.zip.sha256']);
  assert.deepEqual(both.assets.map((a) => a.contentType), ['application/zip', 'text/plain']);
  assert.equal(both.assets[1].path, '/r/V1.4.0/winvm-overall-V1.4.0.zip.sha256');
  assert.equal(both.warn, null);
  const only = buildAssetList('/r/a.zip', false);
  assert.deepEqual(only.assets.map((a) => a.name), ['a.zip']);
  // warn 语义（team-lead 裁决：缺旁挂不阻断，但绝不静默）
  assert.ok(only.warn && only.warn.includes('a.zip.sha256') && only.warn.includes('仅上架 zip'), `旁挂缺失 warn 不合格：${JSON.stringify(only.warn)}`);
});

test('Q-2 planUpload 多资产：zip+旁挂各自先删后传、两 DELETE 都在上传之前（幂等重上架）', () => {
  const p = planUpload({
    repo: 'athronix/demo', tag: 'V1.4.0', zipName: 'winvm-overall-V1.4.0.zip',
    assetNames: ['winvm-overall-V1.4.0.zip', 'winvm-overall-V1.4.0.zip.sha256'],
    assetIds: [11, 22], hasRelease: true, hasToken: true,
  });
  assert.equal(p.needDeleteAsset, true);
  assert.deepEqual(p.deletes, [{ name: 'winvm-overall-V1.4.0.zip', id: 11 }, { name: 'winvm-overall-V1.4.0.zip.sha256', id: 22 }]);
  const joined = p.steps.join('\n');
  for (const name of ['winvm-overall-V1.4.0.zip', 'winvm-overall-V1.4.0.zip.sha256']) {
    const iDel = joined.indexOf(`先清同名旧资产 ${name}`);
    const iUp = joined.lastIndexOf(`?name=${name} → 上传`);
    assert.ok(iDel >= 0 && iUp >= 0 && iDel < iUp, `${name} 先删后传顺序断链`);
  }
});

test('Q-2 planUpload 多资产：仅旁挂在册（zip 被手工删过）⇒ deletes 只含旁挂', () => {
  const p = planUpload({
    repo: 'athronix/demo', tag: 'V1.4.0', zipName: 'a.zip',
    assetNames: ['a.zip', 'a.zip.sha256'], assetIds: [null, 77], hasRelease: true, hasToken: true,
  });
  assert.deepEqual(p.deletes, [{ name: 'a.zip.sha256', id: 77 }]);
});

test('Q-2 向后兼容：旧单资产入参（zipName+assetId）仍出等价计划（防历史调用方断）', () => {
  const p = planUpload({ repo: 'athronix/demo', tag: 'V1.4.0', zipName: 'a.zip', hasRelease: false, assetId: 5, hasToken: true });
  assert.deepEqual(p.deletes, [{ name: 'a.zip', id: 5 }]);
  assert.ok(p.steps.some((s) => s.includes('DELETE /repos/athronix/demo/releases/assets/5')));
});

test('Q-2 证据旁挂行格式 = `overall-zip-sha256-file: <path>`（team-lead 定稿前缀）', () => {
  assert.equal(
    overallZipSha256EvidenceLine('release/V1.4.0/winvm-overall-V1.4.0.zip.sha256'),
    'overall-zip-sha256-file: release/V1.4.0/winvm-overall-V1.4.0.zip.sha256',
  );
});

/* ==================== 缺陷#1 zip 条目集断言（QA it6，发布闸口级安全） ==================== */

const MANIFEST_ROWS = [
  '# WinVM Bridge Release Manifest',
  'version: V1.4.0',
  'deploy-all.sh  ' + 'a'.repeat(64),
  'delivery/install-host.mjs  ' + 'b'.repeat(64),
  '.env.example  ' + 'c'.repeat(64),
];

test('缺陷#1① 杂文件混入（.env / winvm-plugin shim）⇒ 差集非空且点名到路径（驱动 fail-loud）', () => {
  const entries = [
    'overall/',
    'overall/deploy-all.sh',
    'overall/delivery/install-host.mjs',
    'overall/delivery/winvm-plugin',
    'overall/.env',
    'overall/.env.example',
    'overall/MANIFEST.txt',
  ];
  const extras = diffZipEntriesVsManifest(entries, MANIFEST_ROWS);
  assert.deepEqual(extras.sort(), ['overall/.env', 'overall/delivery/winvm-plugin'], '差集必须恰好点名两个真机混入杂文件');
});

test('缺陷#1② MANIFEST.txt 自身豁免（在册设计成员，不在自己的行集里）⇒ 差集不含它', () => {
  const entries = ['overall/deploy-all.sh', 'overall/MANIFEST.txt'];
  const extras = diffZipEntriesVsManifest(entries, MANIFEST_ROWS);
  assert.ok(!extras.includes('overall/MANIFEST.txt'), 'MANIFEST.txt 属设计成员，误报=断言自身成噪声源');
  assert.deepEqual(extras, []);
});

test('缺陷#1③ 正常包（条目 ⊆ MANIFEST ∪ {MANIFEST.txt}，含 .env.example 在册成员）⇒ 差集空', () => {
  const entries = [
    'overall/',
    'overall/delivery/',
    'overall/deploy-all.sh',
    'overall/delivery/install-host.mjs',
    'overall/.env.example',
    'overall/MANIFEST.txt',
  ];
  assert.deepEqual(diffZipEntriesVsManifest(entries, MANIFEST_ROWS), [], '干净包必须放行（目录条目豁免+在册成员放行）');
});

test('缺陷#1 边界：非 overall/ 根的异常条目也显形（防打包 cwd 错拼出别的根）', () => {
  const extras = diffZipEntriesVsManifest(['host/deploy-host.sh', 'overall/deploy-all.sh'], MANIFEST_ROWS);
  assert.deepEqual(extras, ['host/deploy-host.sh']);
});

test('publish zipName 与 pack zipNameFor 一字不差（下载 URL 契约不断链）', () => {
  const name = zipNameFor('V1.4.0');
  assert.equal(
    downloadUrl({ repo: 'athronix/workbuddy-virtual-win-plugin', tag: 'V1.4.0', zipName: name }),
    'https://github.com/athronix/workbuddy-virtual-win-plugin/releases/download/V1.4.0/winvm-overall-V1.4.0.zip',
  );
});

test('buildUploadUrl：剥离 RFC6570 模板后缀 {?name,label} 后以 ?name= 追加（真机 400 根因防回归）', () => {
  const u = buildUploadUrl('https://uploads.github.com/repos/a/b/releases/1/assets{?name,label}', 'winvm-overall-V1.4.0.zip');
  assert.equal(u, 'https://uploads.github.com/repos/a/b/releases/1/assets?name=winvm-overall-V1.4.0.zip');
  assert.ok(!u.includes('{'), '结果绝不含模板花括号');
  assert.ok(!/\}\?/.test(u), '绝不再出现模板段紧跟查询的畸形形态（400 根因）');
});

test('buildUploadUrl：资产名含特殊字符仍正确编码', () => {
  const u = buildUploadUrl('https://uploads.github.com/x/assets{?name,label}', 'win vm+overall.zip');
  assert.ok(u.endsWith('name=win%20vm%2Boverall.zip'), u);
});

test('buildUploadUrl：无模板段原样使用；已含查询则 & 追加（防御性）', () => {
  assert.equal(buildUploadUrl('https://u.example/assets', 'a.zip'), 'https://u.example/assets?name=a.zip');
  assert.equal(buildUploadUrl('https://u.example/assets?foo=1', 'a.zip'), 'https://u.example/assets?foo=1&name=a.zip');
});

test('buildHeaders：调用方 Content-Type 胜出（真机 400 Invalid Content-Type 根因防回归）', () => {
  const h = buildHeaders('tk', { 'Content-Type': 'application/zip' });
  assert.equal(h['Content-Type'], 'application/zip');
  assert.equal(h.Authorization, 'Bearer tk');
  assert.equal(h.Accept, 'application/vnd.github+json');
});

test('buildHeaders：不传 init.headers 时仅默认头+token；无 token 无 Authorization', () => {
  assert.deepEqual(Object.keys(buildHeaders(null)).sort(), ['Accept', 'X-GitHub-Api-Version']);
  const h = buildHeaders('tk');
  assert.equal(h.Authorization, 'Bearer tk');
  assert.ok(!('Content-Type' in h));
});

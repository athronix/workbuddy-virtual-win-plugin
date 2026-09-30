#!/usr/bin/env node
/**
 * T07 · 沙箱白名单注入/移除 单测（injectSandboxAllowWrite / removeSandboxAllowWrite）
 *
 * 覆盖：
 *  1. win32 且 settings.json 无 sandbox 字段 → 返回 []，且**不新建/不改写** settings.json、**不产生** *.winvm-bak.*；
 *     （win32 分支与源码守卫双重断言：行为上伪造 process.platform='win32' 真跑，另加源码守卫存在性断言。）
 *  2. 非 win32（本机）：settings.json 无 sandbox → 新建 sandbox.extraAllowWrite 并追加；再次调用幂等；已有文件时产生备份。
 *  3. 去重/规范化：已有条目含尾随斜杠时不重复追加。
 *  4. remove 对称：移除已加条目（保留其它条目）、回落到与原始结构一致；未命中时返回 [] 且不写盘。
 *
 * 运行方式隔离说明：
 *   直接 `import ... from '../../delivery/install-host.mjs'` 在**离线沙箱无法执行**——该模块顶层静态
 *   import '@winvm/host-sdk' / '@winvm/vm-capabilities'，而仓库无 node_modules 且禁止 npm install/build，
 *   会 ERR_MODULE_NOT_FOUND。故本测试在**临时沙箱**内 1:1 复制真实 `delivery/`，注入最小 @winvm 桩，
 *   再 import 该副本的 install-host.mjs —— 执行的是**逐字节相同的真实模块代码**，目标函数未经任何改写。
 *
 * 约定：`node --test tests/unit/sandbox-allowwrite.test.mjs` 单独跑。
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  cpSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const ORIG_PLATFORM = process.platform;

// —— 构造「可导入真实模块」的临时沙箱：复制 delivery/ + 注入最小 @winvm 桩 ——
const SANDBOX = mkdtempSync(join(tmpdir(), 'winvm-sandbox-import-'));
cpSync(join(REPO, 'delivery'), join(SANDBOX, 'delivery'), { recursive: true });

function stubPkg(pkg, body) {
  const d = join(SANDBOX, 'node_modules', '@winvm', pkg);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: `@winvm/${pkg}`, type: 'module', main: 'index.js' }));
  writeFileSync(join(d, 'index.js'), body, 'utf8');
}
stubPkg('host-sdk', 'export function loadSkillBundles(){return [];}\nexport function validateNeutralPlugin(){return {ok:true,issues:[]};}\n');
stubPkg('vm-capabilities', 'export const WINDOWS_CAPABILITIES=[];\n');
stubPkg('adapter-host-workbuddy', 'export class WorkBuddyRenderer {}\nexport function resolveWorkBuddyPaths(){return {};}\nexport function renderConnectorEntry(){return {};}\n');

// 导入**副本中的真实 install-host.mjs**（含本次新增的两个导出）
const { injectSandboxAllowWrite, removeSandboxAllowWrite } = await import(
  join(SANDBOX, 'delivery', 'install-host.mjs')
);

// —— 工具 ——
const setPlatform = (v) => Object.defineProperty(process, 'platform', { value: v, configurable: true });
const homes = [];
function mkHome() {
  const h = mkdtempSync(join(tmpdir(), 'winvm-sandbox-home-'));
  homes.push(h);
  return h;
}
const settingsPath = (home) => join(home, '.workbuddy', 'settings.json');
const PATHS = (h) => [
  join(h, '.workbuddy', 'winvm'),
  join(h, '.workbuddy', 'connectors'),
  join(h, '.workbuddy', 'plugins', 'cache', 'winvm'),
];
function listBak(home) {
  const dir = join(home, '.workbuddy');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.includes('.winvm-bak.'));
}

after(() => {
  setPlatform(ORIG_PLATFORM);
  for (const h of homes) rmSync(h, { recursive: true, force: true });
  rmSync(SANDBOX, { recursive: true, force: true });
});

/* ------------------------------ 1) win32 守卫 ------------------------------ */

test('win32：settings.json 无 sandbox → 返回 []，不改写、不备份', () => {
  const home = mkHome();
  mkdirSync(join(home, '.workbuddy'), { recursive: true });
  writeFileSync(settingsPath(home), JSON.stringify({ theme: 'dark' }, null, 2) + '\n', 'utf8');
  const before = readFileSync(settingsPath(home), 'utf8');
  const bakBefore = listBak(home).length;
  try {
    setPlatform('win32');
    const added = injectSandboxAllowWrite(home, PATHS(home), false);
    assert.deepEqual(added, [], 'win32 无 sandbox 字段应跳过（返回 []）');
  } finally {
    setPlatform(ORIG_PLATFORM);
  }
  assert.equal(readFileSync(settingsPath(home), 'utf8'), before, 'settings.json 字节不应被改写');
  assert.equal(listBak(home).length, bakBefore, '不应产生 *.winvm-bak.*');
  assert.equal(JSON.parse(before).sandbox, undefined, '不应凭空补出 sandbox 字段');
});

test('win32：settings.json 不存在 → 返回 []，且不新建文件/目录（关键回归点）', () => {
  const home = mkHome();
  try {
    setPlatform('win32');
    const added = injectSandboxAllowWrite(home, PATHS(home), false);
    assert.deepEqual(added, []);
  } finally {
    setPlatform(ORIG_PLATFORM);
  }
  assert.equal(existsSync(settingsPath(home)), false, 'win32 不应新建 settings.json');
  assert.equal(existsSync(join(home, '.workbuddy')), false, 'win32 不应新建 .workbuddy 目录');
});

test('win32 守卫的源码存在性（行为测试的环境无关佐证）', () => {
  const src = readFileSync(join(REPO, 'delivery', 'install-host.mjs'), 'utf8');
  assert.match(
    src,
    /process\.platform === 'win32'[\s\S]{0,200}return \[\];/,
    'install-host.mjs 应含 win32 无 sandbox 即 return [] 的守卫',
  );
});

/* ------------------------------ 2) 非 win32：新建 + 追加 + 幂等 + 备份 ------------------------------ */

test('非 win32：无 sandbox 字段 → 新建 sandbox.extraAllowWrite 并追加；再次调用幂等', () => {
  const home = mkHome();
  const added = injectSandboxAllowWrite(home, PATHS(home), false);
  assert.equal(existsSync(settingsPath(home)), true, '非 win32 应新建 settings.json');
  assert.deepEqual(added, PATHS(home), '应追加全部目标路径');
  const json = JSON.parse(readFileSync(settingsPath(home), 'utf8'));
  assert.deepEqual(json.sandbox.extraAllowWrite, PATHS(home));

  // 幂等：二次调用不重复追加
  const again = injectSandboxAllowWrite(home, PATHS(home), false);
  assert.deepEqual(again, [], '二次调用应无新增');
  assert.deepEqual(JSON.parse(readFileSync(settingsPath(home), 'utf8')).sandbox.extraAllowWrite, PATHS(home));
});

test('非 win32：已有 settings.json 无 sandbox → 追加并保留既有字段，且产生备份', () => {
  const home = mkHome();
  mkdirSync(join(home, '.workbuddy'), { recursive: true });
  writeFileSync(settingsPath(home), JSON.stringify({ theme: 'dark' }, null, 2) + '\n', 'utf8');
  const added = injectSandboxAllowWrite(home, PATHS(home), false);
  assert.deepEqual(added, PATHS(home));
  const json = JSON.parse(readFileSync(settingsPath(home), 'utf8'));
  assert.equal(json.theme, 'dark', '既有字段应保留');
  assert.deepEqual(json.sandbox.extraAllowWrite, PATHS(home));
  assert.ok(listBak(home).length >= 1, '改写前应生成 *.winvm-bak.* 备份');
});

/* ------------------------------ 3) 去重 / 规范化 ------------------------------ */

test('去重：已有条目（含尾随斜杠）不重复追加', () => {
  const home = mkHome();
  mkdirSync(join(home, '.workbuddy'), { recursive: true });
  const first = PATHS(home)[0];
  writeFileSync(
    settingsPath(home),
    JSON.stringify({ sandbox: { extraAllowWrite: [first + '/'] } }, null, 2) + '\n',
    'utf8',
  );
  const added = injectSandboxAllowWrite(home, PATHS(home), false);
  assert.deepEqual(added, [PATHS(home)[1], PATHS(home)[2]], '仅应追加未存在的项');
  const list = JSON.parse(readFileSync(settingsPath(home), 'utf8')).sandbox.extraAllowWrite;
  assert.equal(list.length, 3, '含尾随斜杠的既有项去重后不应重复');
  assert.equal(list[0], first + '/', '既有条目不改写');
});

/* ------------------------------ 4) remove 对称 ------------------------------ */

test('remove：移除已加条目、保留其它条目，移除后回落为原始结构', () => {
  const home = mkHome();
  mkdirSync(join(home, '.workbuddy'), { recursive: true });
  const original = { theme: 'dark', sandbox: { extraAllowWrite: ['/keep-me'] } };
  writeFileSync(settingsPath(home), JSON.stringify(original, null, 2) + '\n', 'utf8');

  injectSandboxAllowWrite(home, PATHS(home), false);
  const removed = removeSandboxAllowWrite(home, PATHS(home), false);
  assert.deepEqual(removed, PATHS(home), '应移除本次追加的全部条目');

  const back = JSON.parse(readFileSync(settingsPath(home), 'utf8'));
  assert.deepEqual(back, original, '移除后应与原始内容一致（其它条目与字段保留）');
});

test('remove：未命中 → 返回 [] 且不写盘', () => {
  const home = mkHome();
  mkdirSync(join(home, '.workbuddy'), { recursive: true });
  writeFileSync(
    settingsPath(home),
    JSON.stringify({ sandbox: { extraAllowWrite: ['/something-else'] } }, null, 2) + '\n',
    'utf8',
  );
  const before = readFileSync(settingsPath(home), 'utf8');
  const bakBefore = listBak(home).length;
  const removed = removeSandboxAllowWrite(home, PATHS(home), false);
  assert.deepEqual(removed, [], '未命中应返回 []');
  assert.equal(readFileSync(settingsPath(home), 'utf8'), before, '未命中不应写盘');
  assert.equal(listBak(home).length, bakBefore, '未命中不应产生备份');
});

test('remove：无 sandbox 字段 / 文件不存在 → 返回 []（安全 no-op）', () => {
  const home = mkHome();
  // 文件不存在
  assert.deepEqual(removeSandboxAllowWrite(home, PATHS(home), false), []);
  // 文件存在但无 sandbox
  mkdirSync(join(home, '.workbuddy'), { recursive: true });
  writeFileSync(settingsPath(home), JSON.stringify({ theme: 'dark' }) + '\n', 'utf8');
  const before = readFileSync(settingsPath(home), 'utf8');
  assert.deepEqual(removeSandboxAllowWrite(home, PATHS(home), false), []);
  assert.equal(readFileSync(settingsPath(home), 'utf8'), before, '不应写盘');
});

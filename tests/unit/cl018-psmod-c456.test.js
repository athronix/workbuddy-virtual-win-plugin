/**
 * CL-018 T04 · C4/C5/C6 VM 能力层（静态源码守卫）
 *
 * 本仓库的 `node --test` 运行环境**没有 PowerShell**，无法真跑 psmod；故此处锁死不变量，
 * 运行时行为（冷启动 ≤3s / 热态不回退 / refresh 生效 / (name,version) 合并 / 无真实应用被误杀）
 * 已在 VM 真机验收（见 `qa/evidence/cl018-eng-*`）。
 *
 * 断言分三类：
 *   ① psmod 关键实现存在且符合裁决（C4 不整体排除 ApplicationFrameHost；C5 缓存+refresh；
 *      C6 (name,version) 合并 + registryKeyCount/architectures）；
 *   ② 能力定义 schema（definitions.ts）与 psmod 对齐；
 *   ③ vm-service 接线（/health.llmSession、/health.logging、C5 启动预热）存在；
 *   ④ env 名跨语言一致（constants.ts ↔ psmod）。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = join(import.meta.dirname, '..', '..');
const PSMOD = join(ROOT, 'packages', 'vm-capabilities', 'psmod');
const readPs = (f) => readFileSync(join(PSMOD, f), 'utf8');
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8');

/**
 * 从 psmod 源码里抽出 `$<varName> = @( ... )` 默认名单中的字符串字面量。
 * ——使断言**绑定真实源码**（而非测试自带副本），避免与 psmod 漂移。
 */
function extractStringArray(src, varName) {
  const re = new RegExp('\\$' + varName + '\\s*=\\s*@\\(([\\s\\S]*?)\\n\\s*\\)');
  const m = src.match(re);
  if (!m) return null;
  const out = [];
  const rx = /'([^']*)'/g;
  let x;
  while ((x = rx.exec(m[1])) !== null) out.push(x[1]);
  return out;
}

/** PowerShell `-match` 默认忽略大小写、且用行内 `(?i)` 前缀；JS RegExp 不支持行内标志 → 转译。 */
function psMatch(pattern, text) {
  const body = pattern.replace(/^\(\?i\)/, '');
  return new RegExp(body, 'i').test(text);
}

/**
 * `Test-AppOpsWindowProductive` 的 JS 镜像：名单数据从**真实源码**抽取，仅控制流镜像。
 * （真机最终判定由 VM 上 `c4-predicate.ps1` dot-source 真实 appops.ps1 复验。）
 */
function TestProductiveMirror(src, name, title) {
  const hard = extractStringArray(src, 'hardExclude') ?? [];
  const titleDeny = extractStringArray(src, 'titleDeny') ?? [];
  const procDeny = extractStringArray(src, 'procDeny') ?? [];
  const frames = extractStringArray(src, 'frameHosts') ?? [];
  if (hard.includes(name)) return { productive: false, reason: 'NON_PRODUCTIVE_PROC' };
  for (const p of procDeny) {
    if (psMatch(p, name)) return { productive: false, reason: 'DENY_PROC_PATTERN' };
  }
  for (const p of titleDeny) {
    if (psMatch(p, title)) return { productive: false, reason: 'DENY_TITLE_PATTERN' };
  }
  if (frames.includes(name) && (!title || title.trim() === '')) {
    return { productive: false, reason: 'EMPTY_TITLE_FRAME_HOST' };
  }
  return { productive: true, reason: 'OK' };
}

describe('CL-018 C4 · appops.state.query 非生产型窗口过滤', () => {
  const src = readPs('appops.ps1');

  test('实现生产型判定：框架宿主灰名单 + 空标题判据（不整体排除 ApplicationFrameHost）', () => {
    assert.ok(src.includes('function Test-AppOpsWindowProductive'), '应有 Test-AppOpsWindowProductive');
    assert.ok(src.includes('Get-AppOpsWindowPolicy'), '应有数据驱动的名单函数');
    assert.ok(src.includes('ApplicationFrameHost'), '框架宿主须在灰名单中被逐个判定');
    assert.ok(src.includes('ShellExperienceHost'), '灰名单应含 ShellExperienceHost');
    assert.ok(src.includes('RuntimeBroker'), '灰名单应含 RuntimeBroker');
    assert.ok(src.includes('TextInputHost'), '灰名单应含 TextInputHost');
    assert.ok(src.includes('SearchHost'), '灰名单应含 SearchHost');
    // 关键：空标题框架窗才排除 —— 必须存在 IsNullOrWhiteSpace 判据
    assert.ok(src.includes('IsNullOrWhiteSpace'), '应按「有无真实标题」判定（空标题框架窗排除）');
  });

  test('排除安装器临时窗口与明确非生产型进程', () => {
    assert.ok(src.includes('tmp\\s*setup'), '应含安装器临时标题模式 *tmp Setup*');
    assert.ok(src.includes('NotifyHelper'), '应排除明确非生产型进程 NotifyHelper');
  });

  test('R2 · 进程名模式 procDeny：Doubao_installer 被过滤，含 installer 的正常应用不被误杀', () => {
    const procDeny = extractStringArray(src, 'procDeny');
    assert.ok(Array.isArray(procDeny) && procDeny.length >= 2, `应有 procDeny 默认名单（≥2 条），实际=${JSON.stringify(procDeny)}`);
    assert.ok(procDeny.includes('(?i)_installer$'), '默认名单应含锚定后缀 _installer$');
    assert.ok(procDeny.includes('(?i)^setup'), '默认名单应含锚定前缀 ^setup');
    // 源码应消费该名单并新增审计 reason
    assert.ok(src.includes('$Policy.procDeny'), 'Test-AppOpsWindowProductive 应消费 $Policy.procDeny');
    assert.ok(src.includes('DENY_PROC_PATTERN'), '应新增 reason DENY_PROC_PATTERN');
    // env 可扩展（与既有 WINVM_APPOPS_EXCLUDE_PROCS/TITLE_PATTERNS 风格一致）
    assert.ok(src.includes('WINVM_APPOPS_EXCLUDE_PROC_PATTERNS'), 'procDeny 应可由 env 扩展');

    // AC4.2 总原则：模式必须**锚定**（前缀 ^ / 后缀 $），禁止宽松 (?i)installer
    for (const p of procDeny) {
      assert.ok(/\(\?i\)\^/.test(p) || /\$$/.test(p), `procDeny 模式必须锚定，否则会误杀：${p}`);
      assert.notEqual(p, '(?i)installer', '不得使用宽松 (?i)installer（会误杀一切名字带 installer 的程序）');
    }

    // ① 进程名 Doubao_installer + 标题「豆包」→ 进程名命中 → 被过滤，reason=DENY_PROC_PATTERN
    const v1 = TestProductiveMirror(src, 'Doubao_installer', '豆包');
    assert.equal(v1.productive, false, 'Doubao_installer（标题「豆包」）必须被过滤');
    assert.equal(v1.reason, 'DENY_PROC_PATTERN', '过滤原因应为 DENY_PROC_PATTERN');

    // ② 进程名**含 installer 字样**的真实应用（合成样本）→ 不得被误杀（AC4.2 优先于 AC4.1）
    for (const realname of ['AppInstaller', 'RustDeskInstaller', 'SteamInstallerHelper']) {
      const v = TestProductiveMirror(src, realname, '正常应用窗口');
      assert.equal(v.productive, true, `含 installer 字样的正常程序应保留：${realname}`);
      assert.equal(v.reason, 'OK');
    }
  });

  test('被过滤项可审计：输出 filteredCount / filtered', () => {
    assert.ok(src.includes('filteredCount'), '应输出 filteredCount');
    assert.ok(src.includes('filtered'), '应输出 filtered 明细');
    assert.ok(src.includes('EMPTY_TITLE_FRAME_HOST'), '应记录空标题框架宿主过滤原因');
  });

  test('不按进程名整体排除 ApplicationFrameHost（AC4.2 优先）', () => {
    // 反面守卫：不得出现把 ApplicationFrameHost 放进 hardExclude 的写法
    assert.ok(
      !/hardExclude\s*=\s*@\([^)]*ApplicationFrameHost/.test(src),
      '不得把 ApplicationFrameHost 放入 hardExclude（会误杀承载真实 UWP 应用的框架窗）',
    );
  });
});

describe('CL-018 C5 · system.network.config 进程内缓存', () => {
  const src = readPs('system.ps1');

  test('进程内 TTL 缓存 + 可控 TTL（45s 默认，env 可覆盖）', () => {
    assert.ok(src.includes('$script:NetCfgCache'), '应有脚本作用域进程内缓存');
    assert.ok(src.includes('Get-NetCfgTtlMs'), '应有 TTL 解析函数（非法值回退默认）');
    assert.ok(src.includes('WINVM_NETCFG_TTL_MS'), '应支持 env WINVM_NETCFG_TTL_MS');
    assert.ok(src.includes('45000'), '默认 TTL 应为 45000ms');
  });

  test('入参 refresh 绕过缓存；出参带 cached / cacheAgeMs / collectedAt', () => {
    assert.ok(src.includes('[switch]$Refresh'), '应有 -Refresh 开关绕过缓存');
    assert.ok(src.includes("$hit['cached']      = $true"), '命中缓存应标记 cached=true');
    assert.ok(src.includes("$result['cached']      = $false"), '冷采集应标记 cached=false');
    assert.ok(src.includes('cacheAgeMs'), '应输出 cacheAgeMs');
    assert.ok(src.includes('collectedAt'), '应输出 collectedAt');
  });
});

describe('CL-018 C6 · app.inventory.list (name,version) 合并', () => {
  const src = readPs('app.ps1');

  test('合并键 = (name, version)，输出 registryKeyCount', () => {
    assert.ok(src.includes('registryKeyCount'), '应输出 registryKeyCount');
    assert.ok(/name, version/.test(src) || src.includes('(name,version)') || src.includes('(name, version)'), '注释应写明合并键 (name,version)');
    // 分组用 NUL 分隔的复合键
    assert.ok(src.includes('[char]0'), '应以复合键分组（含 NUL 分隔，避免名称含分隔符误合并）');
  });

  test('architectures 仅由 hive 推断，不硬造 ["x64","x86"]', () => {
    assert.ok(src.includes('WOW6432Node'), '应含 WOW6432Node（32 位视图）用于推断 x86');
    assert.ok(src.includes("'x64'"), '应含 x64 推断');
    assert.ok(src.includes("'x86'"), '应含 x86 推断');
    assert.ok(src.includes('architectures'), '应输出 architectures');
    assert.ok(
      !/architectures\s*=\s*@\('x64',\s*'x86'\)/.test(src),
      '不得硬造 architectures=["x64","x86"]',
    );
  });

  test('同名不同版本保留：不得再按 name 去重', () => {
    // 剥离注释后检查**代码**，避免把说明性注释误判为代码
    const code = src.replace(/^[ \t]*#.*$/gm, '');
    assert.ok(!code.includes('Sort-Object -Property { $_.name } -Unique'), '不得按 name 去重（会误删同名异版本）');
  });
});

describe('CL-018 责任接线 · definitions / server / env 一致性', () => {
  test('definitions.ts：C5 refresh 入参 + C6 出参 + C4 出参', () => {
    const def = read('packages', 'vm-capabilities', 'src', 'registry', 'definitions.ts');
    assert.ok(def.includes("refresh: { type: 'boolean'"), 'system.network.config 应声明 refresh 入参');
    assert.ok(def.includes('cacheAgeMs'), 'network.config 出参应含 cacheAgeMs');
    assert.ok(def.includes('registryKeyCount'), 'app.inventory.list 出参应含 registryKeyCount');
    assert.ok(def.includes('architectures'), 'app.inventory.list 出参应含 architectures');
    assert.ok(def.includes('filteredCount'), 'appops.state.query 出参应含 filteredCount');
  });

  test('server.ts：/health.llmSession + /health.logging + C5 启动预热', () => {
    const srv = read('packages', 'vm-service', 'src', 'server.ts');
    assert.ok(srv.includes('llmSessionHealth'), 'server 应经 SPI 同步取 llmSession 健康态');
    assert.ok(srv.includes('llmSession'), 'health 应含 llmSession 字段');
    assert.ok(srv.includes('createFileLogger'), 'server 应改用 FileLogger（console+file 双写）');
    assert.ok(srv.includes('logging'), 'health 应含 logging 字段');
    assert.ok(/Get-NetworkConfig/.test(srv), 'server 启动应异步预热 Get-NetworkConfig');
    assert.ok(srv.includes('netCfg'), 'health 应含 cache.netCfg');
  });

  test('env 名跨语言一致（constants.ts ↔ psmod）', () => {
    const constants = read('packages', 'core', 'src', 'constants.ts');
    for (const name of [
      'WINVM_NETCFG_TTL_MS',
      'WINVM_APPOPS_EXCLUDE_PROCS',
      'WINVM_APPOPS_EXCLUDE_TITLE_PATTERNS',
      'WINVM_APPOPS_EXCLUDE_PROC_PATTERNS',
    ]) {
      assert.ok(constants.includes(name), `constants.ts 应登记 ${name}`);
    }
    assert.ok(readPs('system.ps1').includes('WINVM_NETCFG_TTL_MS'), 'system.ps1 应使用同名 env');
    assert.ok(readPs('appops.ps1').includes('WINVM_APPOPS_EXCLUDE_PROCS'), 'appops.ps1 应使用同名 env');
    assert.ok(
      readPs('appops.ps1').includes('WINVM_APPOPS_EXCLUDE_TITLE_PATTERNS'),
      'appops.ps1 应使用同名 env',
    );
    assert.ok(
      readPs('appops.ps1').includes('WINVM_APPOPS_EXCLUDE_PROC_PATTERNS'),
      'appops.ps1 应使用同名 env（CL-018 R2 进程名模式）',
    );
  });
});

/**
 * CL-017 D25 · app.winget.search 解析回归守卫（静默空结果修复）
 *
 * 背景（主理人二分证明）：
 *   winget 的列分隔线是**一整条连续横线**（真机实测 98 个 '-'），**不是按列分段**。
 *   旧实现（D16）误以为可按分隔线定列：`[regex]::Matches($sep, '-+')` 只得 1 个匹配
 *   → `$cols.Count = 1` → 每行 `$vals.Count = 1` → 全部命中 `$vals.Count -lt 3` 被 continue
 *   → `out = @()` → **`ok=true + data=[]` 的「静默空」**（调用方误判「winget 没有这个包」，
 *   比原缺陷的「列错位」更危险）。
 *
 * 本测试两道关：
 *   ① 静态：`app.ps1` 必须由**表头行**定列边界、必须含 fail-loud（`WINGET_PARSE_FAILED`）、
 *      且**不得**再对分隔线跑 `-+` 分段；
 *   ② 行为：把 PS 算法等价移植到 JS，喂入**真机原始输出**夹具，断言行数与关键条目
 *      （含 CJK 全角行的显示宽度对齐——这是「字符索引直接切列」会错位的地方）。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_PS1 = join(__dirname, '..', '..', 'packages', 'vm-capabilities', 'psmod', 'app.ps1');

/** 真机 `winget search 7zip` 原始输出（13 行：表头 + 分隔线 + 11 条数据，含 1 条 CJK/msstore 行） */
const RAW = [
  'Name                               Id                        Version         Match         Source',
  '--------------------------------------------------------------------------------------------------',
  '7-Zip                              7zip.7zip                 26.03           Moniker: 7zip winget',
  'Advanced Archive Password Recovery Elcomsoft.ArchivePassword 4.66.266.6965   Tag: 7zip     winget',
  'NanaZip                            M2Team.NanaZip            7.0.1832.0      Tag: 7zip     winget',
  'NanaZip Preview                    M2Team.NanaZip.Preview    7.0.1800.0      Tag: 7zip     winget',
  'Cram                               Nexalit.Cram              1.3.1           Tag: 7zip     winget',
  '7-Zip ZS                           mcmilk.7zip-zstd          26.02-v1.5.7-R2 Tag: 7zip     winget',
  '7-Zip ZS Non Darkmode              mcmilk.7zip-zstd-ndm      26.02-v1.5.7-R2 Tag: 7zip     winget',
  'Dark7zip                           ozone10.7zip.Dark         26.02-0.70.0    Tag: 7zip     winget',
  '7zip解压缩软件                     XP8C87R6J42SKH            Unknown                       msstore',
  '7zr                                7zip.7zr                  26.03                         winget',
  'QNapi                              QNapi.QNapi               0.2.3           Tag: p7zip    winget',
];

/* ---------------------- 行为：PS 算法的 JS 等价移植 ---------------------- */

/** 东亚宽/全角码点 → 显示宽度 2，其余 1（与 PS `Get-DisplayCharWidth` 一致） */
function charWidth(cp) {
  return cp >= 0x1100 &&
    (cp <= 0x115f ||
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x3fffd))
    ? 2
    : 1;
}

/** 显示列 → 字符索引映射（与 PS `Get-DisplayColumnMap` 一致） */
function displayMap(line) {
  const map = [];
  let i = 0;
  while (i < line.length) {
    const cp = line.codePointAt(i);
    const w = charWidth(cp);
    for (let d = 0; d < w; d++) map.push(i);
    i += cp > 0xffff ? 2 : 1;
  }
  map.push(line.length);
  return map;
}

function idxAt(map, dc) {
  if (dc <= 0) return 0;
  if (dc >= map.length) return map[map.length - 1];
  return map[dc];
}

/** Search-WingetPackage 的解析核心（D25） */
function parseWinget(lines) {
  const sepIdx = lines.findIndex((l) => /^\s*-{3,}/.test(l));
  const out = [];
  if (sepIdx < 1) return out; // 无表头 → 宽松兜底（本用例不覆盖）

  const header = lines[sepIdx - 1];
  const LABELS = ['Name', 'Id', 'Version', 'Match', 'Source'];
  const marks = [];
  for (const lab of LABELS) {
    const m = new RegExp(`(?<![A-Za-z])${lab}(?![A-Za-z])`).exec(header);
    if (m) marks.push({ label: lab, start: m.index });
  }
  marks.sort((a, b) => a.start - b.start);

  let firstData = null;
  for (let i = sepIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    if (/^\s*-{3,}/.test(line)) continue;
    if (/^\s*\d+\s+\S+\s+(匹配|matching|packages)/.test(line)) continue;
    if (firstData === null) firstData = line;

    const map = displayMap(line);
    const vals = marks.map((mk, k) => {
      const s = idxAt(map, mk.start);
      const e = k + 1 < marks.length ? idxAt(map, marks[k + 1].start) : line.length;
      return line.slice(s, Math.max(e, s)).trim();
    });
    if (vals.length < 2 || !vals[1]) continue;
    out.push({ name: vals[0], id: vals[1], version: vals.length >= 3 ? vals[2] : '' });
  }

  // fail-loud：确有数据行却 0 条 → 抛错，绝不静默给空
  if (firstData !== null && out.length === 0) throw new Error('WINGET_PARSE_FAILED: ' + firstData);
  return out;
}

describe('CL-017 D25 · app.winget.search 解析（表头定列 + 显示宽度对齐 + fail-loud）', () => {
  const src = readFileSync(APP_PS1, 'utf8');

  test('静态：由表头行定列边界（不再对分隔线跑 -+ 分段）', () => {
    assert.ok(src.includes("$labels = @('Name', 'Id', 'Version', 'Match', 'Source')"), '应含表头标签集');
    assert.ok(src.includes('$lines[$sepIdx - 1]'), '列边界应取自分隔线的上一行（表头）');
    assert.ok(
      !src.includes("[regex]::Matches($lines[$sepIdx], '-+')"),
      '不得再对分隔线做 -+ 分段（winget 分隔线是连续一条长横线，只得 1 列）',
    );
    // 表头标签必须是「独立词」匹配（避免命中别的词）
    assert.ok(src.includes('(?<![A-Za-z])'), '表头标签应使用独立词边界匹配');
  });

  test('静态：含 display-width 换算与 fail-loud', () => {
    assert.ok(src.includes('function Get-DisplayCharWidth'), '应含显示宽度判定');
    assert.ok(src.includes('function Get-DisplayColumnMap'), '应含显示列→字符索引映射');
    assert.ok(src.includes('WINGET_PARSE_FAILED'), '应含 fail-loud 分支');
    assert.ok(src.includes('$firstDataLine'), 'fail-loud 应针对「确有数据行」的情形');
  });

  test('行为：真机夹具解析出 11 条，含 7zip.7zip 与 7-Zip', () => {
    const rows = parseWinget(RAW);
    assert.equal(rows.length, 11, '应解析出 11 条（旧实现为 0 条静默空）');
    assert.ok(rows.some((r) => r.id === '7zip.7zip'), '应含 7zip.7zip');
    assert.ok(rows.some((r) => String(r.name).includes('7-Zip')), '应含 7-Zip');
  });

  test('行为：含空格的 name 正确解出（列边界来自表头，而非固定长度）', () => {
    const rows = parseWinget(RAW);
    const aapr = rows.find((r) => r.id === 'Elcomsoft.ArchivePassword');
    assert.ok(aapr, '应解出 Elcomsoft.ArchivePassword');
    assert.equal(aapr.name, 'Advanced Archive Password Recovery');
    assert.equal(aapr.version, '4.66.266.6965');
  });

  test('行为：CJK 全角行按显示宽度对齐（字符索引直接切列会错位）', () => {
    const rows = parseWinget(RAW);
    const cjk = rows.find((r) => r.id === 'XP8C87R6J42SKH');
    assert.ok(cjk, '中文包名行应正确解出 id=XP8C87R6J42SKH（而非错位成 7R6J42SKH…）');
    assert.equal(cjk.name, '7zip解压缩软件');
    assert.equal(cjk.version, 'Unknown');

    // 反证：若按「字符索引」直接切列（不加显示宽度补偿），该行必然错位
    const naive = RAW[10].slice(35, 61).trim();
    assert.notEqual(naive, 'XP8C87R6J42SKH', '字符索引切列确实错位 —— 说明补偿是必要的');
  });

  test('行为：分隔线之后有数据行却解析为 0 条 → fail-loud（不静默给空）', () => {
    // 构造一份「表头无法定列」的输出：分隔线后确有数据行
    const broken = ['Nonsense Header Without Labels', '----------', 'some data row here'];
    assert.throws(() => parseWinget(broken), /WINGET_PARSE_FAILED/, '应抛 WINGET_PARSE_FAILED');
  });
});

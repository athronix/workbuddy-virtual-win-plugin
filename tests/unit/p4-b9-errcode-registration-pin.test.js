/**
 * Phase 4 · 批9 · P4-N-2/N-6 · 错误码「登记对账」漂移钉守卫
 *
 * ## 为什么存在（终版审计台账 2026-10-14 N-2/N-6 原话）
 *
 * N-2：`docs/02-design/INTERFACES.md` §2.6 错误码表列 9 码，而
 * `packages/contracts/src/errors.ts` 的 `BridgeErrorCode` 封闭集实数 12——
 * `UNSUPPORTED_GOAL`/`TASK_CANCELED` 欠得更早，批1 添 `DELEGATION_REQUIRED`
 * 时又欠（**同病再发**）。登记面漂移没有任何机检：每加一个契约码都要靠人
 * 记得同步文档，而历史证明人会忘。
 *
 * N-6：「封闭 10 码」这类**数字复写**散布在 errors.ts 注释与 INSTALL-GUIDE，
 * 码集一变（10→12）全部陈旧。处方 = 表述改「封闭码集（单源 errors.ts）」，
 * 且用本守卫**钉死数字复写不得回潮**。
 *
 * ## 判据（双向对账 + 数字钉，全部纯函数）
 *
 *  R1 码集每码必须有 §2.6 表行（缺即红，报错列缺码）——防「加码欠登记」；
 *  R2 表行每码必须 ∈ 码集（防表私加幽灵码）——防「登记面自造权威」；
 *  R3 表「可重试」列首字（是/否）与 `DEFAULT_RETRYABLE` 实值一致——防 retryable 漂移；
 *  R4 errors.ts / INSTALL-GUIDE.md 文本不含 /封闭\s*\d+\s*码/——钉住 N-6，
 *     防「封闭 10 码」字样被复制粘贴复活。
 *
 * 提取纪律（对齐 assembly-guard 的 QA-02 教训）：每个切片都带**非空 + 数量下限**
 * 前置断言，把「匹配失败」与「匹配成功但对账不过」分开，杜绝 indexOf===-1 型假绿。
 *
 * ## 变异自检（内存施加，零写盘）
 *
 * 对 §2.6 表文本副本施加两例变异：
 *  M1 删一行表 ⇒ R1 必须红（缺码显形）；
 *  M2 加一行幽灵码 ⇒ R2 必须红（幽灵显形）。
 * 并要求**未变异的真实文本**判据为空、磁盘源文件 SHA-256 前后一致（自证没改盘）。
 *
 * 运行（只跑本文件，绝不整批）：
 *   node --test tests/unit/p4-b9-errcode-registration-pin.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/* ============================ 只读源文本（相对仓库根定位，不依赖 cwd） ============================ */

const REPO = join(import.meta.dirname, '..', '..');
const F = {
  ERRORS: join(REPO, 'packages', 'contracts', 'src', 'errors.ts'),
  INTERFACES: join(REPO, 'docs', '02-design', 'INTERFACES.md'),
  INSTALL: join(REPO, 'docs', 'INSTALL-GUIDE.md'),
};
const SRC = Object.fromEntries(Object.entries(F).map(([k, p]) => [k, readFileSync(p, 'utf8')]));
/** 基线摘要：变异自检末尾据此自证磁盘源文件字节未被改动 */
const HASH = Object.fromEntries(
  Object.entries(F).map(([k, p]) => [k, createHash('sha256').update(readFileSync(p)).digest('hex')]),
);

/* ============================ 提取器（锚点切片，不用行号，防漂移） ============================ */

/**
 * 从 errors.ts 文本提取 `BridgeErrorCode` 封闭码集（联合成员行 `| 'CODE'`）。
 * 切片域 = `export type BridgeErrorCode` 到 `export interface BridgeError`，
 * 排除类型前的文档注释（那里有 `'AUTH_REQUIRED'` 等**明确不入集**的对照串）。
 */
export function extractCodeSet(errorsTs) {
  const start = errorsTs.indexOf('export type BridgeErrorCode');
  assert.notEqual(start, -1, '切片失败：errors.ts 找不到 export type BridgeErrorCode 锚点');
  const end = errorsTs.indexOf('export interface BridgeError', start);
  assert.notEqual(end, -1, '切片失败：errors.ts 找不到 export interface BridgeError 收尾锚点');
  const seg = errorsTs.slice(start, end);
  const codes = [];
  for (const m of seg.matchAll(/^[ \t]*\|[ \t]*'([A-Z][A-Z0-9_]*)'[ \t]*;?[ \t]*$/gm)) {
    codes.push(m[1]);
  }
  // QA-02 下限：联合成员少于 12 即提取正则失效（当前实测 12 码），守卫失效必须显形
  assert.ok(codes.length >= 12, `码集提取异常（实得 ${codes.length}，应 ≥12——解析正则失效即守卫失效）`);
  assert.equal(new Set(codes).size, codes.length, `码集出现重复成员：${codes.join(',')}`);
  return codes;
}

/**
 * 从 errors.ts 文本提取 `DEFAULT_RETRYABLE` 的 code→boolean 实况表。
 * 切片域 = `const DEFAULT_RETRYABLE` 到其收尾 `};`。
 */
export function extractRetryable(errorsTs) {
  const start = errorsTs.indexOf('const DEFAULT_RETRYABLE');
  assert.notEqual(start, -1, '切片失败：errors.ts 找不到 DEFAULT_RETRYABLE 锚点');
  const end = errorsTs.indexOf('};', start);
  assert.notEqual(end, -1, '切片失败：DEFAULT_RETRYABLE 块找不到收尾');
  const seg = errorsTs.slice(start, end);
  const map = new Map();
  for (const m of seg.matchAll(/^[ \t]*([A-Z][A-Z0-9_]*):[ \t]*(true|false),?[ \t]*$/gm)) {
    map.set(m[1], m[2] === 'true');
  }
  assert.ok(map.size >= 12, `DEFAULT_RETRYABLE 提取异常（实得 ${map.size}，应 ≥12）`);
  return map;
}

/**
 * 从 INTERFACES.md 文本提取 §2.6 表的 { code, retryableCell } 行集合。
 * 切片域 = `### 2.6 错误码` 到下一个 `## 3.` 标题（表行形态：| `CODE` | 语义 | 可重试 |）。
 */
export function extractTableRows(interfacesMd) {
  const start = interfacesMd.indexOf('### 2.6 错误码');
  assert.notEqual(start, -1, '切片失败：INTERFACES.md 找不到「### 2.6 错误码」锚点');
  const end = interfacesMd.indexOf('## 3.', start);
  assert.notEqual(end, -1, '切片失败：§2.6 之后找不到 ## 3. 收尾锚点');
  const seg = interfacesMd.slice(start, end);
  const rows = [];
  for (const m of seg.matchAll(/^\|[ \t]*`([A-Z][A-Z0-9_]*)`[ \t]*\|[ \t]*([^|]*)\|[ \t]*([^|]*?)[ \t]*\|/gm)) {
    rows.push({ code: m[1], semantic: m[2].trim(), retryableCell: m[3].trim() });
  }
  // 下限 10（实况 12）：留变异自检 M1 删一行的余量，同时仍能捕获「解析失效=0~2 行」的空转
  assert.ok(rows.length >= 10, `§2.6 表行提取异常（实得 ${rows.length}，应 ≥10——表形态漂移即守卫失效）`);
  const dup = rows.map((r) => r.code).filter((c, i, a) => a.indexOf(c) !== i);
  assert.equal(dup.length, 0, `§2.6 表出现重复码行：${dup.join(',')}`);
  return rows;
}

/* ============================ 判据函数（纯函数，返回差异集合，不 assert） ============================ */

/**
 * 双向对账：
 *  missing   = 码集有而表无（加码欠登记）；
 *  ghosts    = 表有而码集无（登记面私加幽灵码）；
 *  mismatch  = retryable 列首字与 DEFAULT_RETRYABLE 实值不符（是↔true / 否↔false）。
 * @param {string} errorsTs  @param {string} interfacesMd
 */
export function checkRegistration(errorsTs, interfacesMd) {
  const codes = extractCodeSet(errorsTs);
  const retryMap = extractRetryable(errorsTs);
  const rows = extractTableRows(interfacesMd);
  const codeSet = new Set(codes);
  const rowSet = new Set(rows.map((r) => r.code));
  const missing = codes.filter((c) => !rowSet.has(c));
  const ghosts = rows.map((r) => r.code).filter((c) => !codeSet.has(c));
  const mismatch = [];
  for (const r of rows) {
    if (!retryMap.has(r.code)) continue; // 幽灵码已由 ghosts 记账，此处不重复
    const expect = retryMap.get(r.code);
    const cellYes = /^是/.test(r.retryableCell);
    const cellNo = /^否/.test(r.retryableCell);
    if (!cellYes && !cellNo) {
      mismatch.push(`${r.code}：可重试列首字既非「是」也非「否」（实为「${r.retryableCell}」）`);
    } else if (cellYes !== expect) {
      mismatch.push(`${r.code}：表写「${r.retryableCell}」但 DEFAULT_RETRYABLE=${expect}`);
    }
  }
  return { missing, ghosts, mismatch };
}

/** N-6 数字钉：真封闭集声明附近不得出现「封闭 <数字> 码」复写 */
const DIGIT_REWRITE = /封闭\s*\d+\s*码/;

/* ============================ 真源对账（R1–R4） ============================ */

describe('P4-B9 漂移钉 · 真源双向对账（N-2）', () => {
  test('R1+R2+R3：errors.ts 封闭码集 ↔ INTERFACES §2.6 表双向 ⊆ 且 retryable 列对账', () => {
    const { missing, ghosts, mismatch } = checkRegistration(SRC.ERRORS, SRC.INTERFACES);
    assert.deepEqual(missing, [], `契约码欠登记（§2.6 缺行，N-2 同病再发）：\n${missing.join('\n')}`);
    assert.deepEqual(ghosts, [], `§2.6 表私加封闭码集之外的幽灵码（登记面自造权威）：\n${ghosts.join('\n')}`);
    assert.deepEqual(mismatch, [], `§2.6「可重试」列与 DEFAULT_RETRYABLE 实值不符：\n${mismatch.join('\n')}`);
  });

  test('R4：errors.ts / INSTALL-GUIDE.md 无「封闭 N 码」数字复写（N-6 防回潮）', () => {
    for (const label of ['ERRORS', 'INSTALL']) {
      assert.ok(
        !DIGIT_REWRITE.test(SRC[label]),
        `${F[label]} 出现「封闭 \\d 码」数字复写——码集单源表述必须去数字（N-6）`,
      );
    }
  });

  test('提取活性自证：码集恰为当前实况 12 码，且逐码 ∈ DEFAULT_RETRYABLE（穷举映射）', () => {
    const codes = extractCodeSet(SRC.ERRORS);
    const retryMap = extractRetryable(SRC.ERRORS);
    assert.equal(codes.length, 12, `当前实况 12 码（实得 ${codes.length}）`);
    for (const c of codes) assert.ok(retryMap.has(c), `${c} 缺 DEFAULT_RETRYABLE 项（Record 穷举编译即错，此处理论不可达，达了即正则骗人）`);
  });
});

/* ============================ 变异自检（内存施加，零写盘） ============================ */

describe('P4-B9 漂移钉 · 变异灵敏度自证', () => {
  test('M1 删一行表 ⇒ R1 缺码必须显形（判据不空转）', () => {
    const lines = SRC.INTERFACES.split('\n');
    const rowIdx = lines.findIndex((l) => /^\|[ \t]*`TASK_CANCELED`[ \t]*\|/.test(l));
    assert.notEqual(rowIdx, -1, '变异前提：§2.6 表内应有 TASK_CANCELED 行');
    const mutated = [...lines.slice(0, rowIdx), ...lines.slice(rowIdx + 1)].join('\n');
    const { missing } = checkRegistration(SRC.ERRORS, mutated);
    assert.deepEqual(missing, ['TASK_CANCELED'], '删行变异必须且只把被删码判为欠登记');
  });

  test('M2 加一行幽灵码 ⇒ R2 幽灵必须显形（表私加码即红）', () => {
    const ghostRow = '| `GHOST_NOT_A_CONTRACT_CODE` | 变异注入：封闭集外幽灵码 | 否 |';
    const idx = SRC.INTERFACES.indexOf('\n## 3.', SRC.INTERFACES.indexOf('### 2.6 错误码'));
    assert.notEqual(idx, -1, '变异前提：§2.6 后应存在 ## 3. 锚点');
    const mutated = SRC.INTERFACES.slice(0, idx) + '\n' + ghostRow + SRC.INTERFACES.slice(idx);
    const { ghosts } = checkRegistration(SRC.ERRORS, mutated);
    assert.deepEqual(ghosts, ['GHOST_NOT_A_CONTRACT_CODE'], '幽灵行必须被判据点名');
  });

  test('M3 retryable 反写（APPROVAL_REQUIRED 改成「否」）⇒ R3 显形', () => {
    const mutated = SRC.INTERFACES.replace(
      /^\|[ \t]*`APPROVAL_REQUIRED`[ \t]*\|[^\n]*$/m,
      '| `APPROVAL_REQUIRED` | 需审批（附 approval 结构） | 否 |',
    );
    assert.notEqual(mutated, SRC.INTERFACES, '变异前提：APPROVAL_REQUIRED 行必须命中替换');
    const { mismatch } = checkRegistration(SRC.ERRORS, mutated);
    assert.equal(mismatch.length, 1, `仅该码 retryable 不符（实得 ${JSON.stringify(mismatch)}）`);
    assert.match(mismatch[0], /APPROVAL_REQUIRED/);
  });

  test('M4 数字复写注入（errors.ts 副本回写「封闭 10 码」）⇒ R4 显形', () => {
    const mutated = SRC.ERRORS.replace('契约层封闭码集（单源=本文件', '契约层封闭 10 码（单源=本文件');
    assert.notEqual(mutated, SRC.ERRORS, '变异前提：D 项句式必须在场');
    assert.ok(DIGIT_REWRITE.test(mutated), '数字复写变异必须被 /封闭\\d+码/ 命中');
    assert.ok(!DIGIT_REWRITE.test(SRC.ERRORS), '真源当前不得命中（否则 M4 与真源自相矛盾）');
  });

  test('磁盘自证：本文件全程只读，三方源文件 SHA-256 与基线一致', () => {
    for (const [k, p] of Object.entries(F)) {
      assert.equal(
        createHash('sha256').update(readFileSync(p)).digest('hex'),
        HASH[k],
        `${k} 磁盘字节被改动——守卫纪律=内存变异零写盘`,
      );
    }
  });
});

/**
 * Phase 2 · P2-T3 单元测试：audit.snapshot「事实三元组」防再漂移守卫
 *
 * 背景（phase2-arch-design §1.2 F1 / §6 P2-T3 / §13 Q2 裁决 2026-10-10）：
 *   用户裁决 **降级为信息性** —— 不实现 before/after 快照。ARCH-04 曾记「30+ 声明零消费」，
 *   主理人终审口径为 28 = 26 条能力级字面标注（20×'after' + 6×'before-after'）+ 2 处
 *   声明/接线（definitions.ts:47/:79）；且缺口比审计记的更深一层：**连承载快照的字段都不存在**
 *   （AuditRecord/AuditExt 无位）。三方（声明/消费/承载）各自口径必须钉死，任何一侧被"悄悄
 *   改回去"（重新宣称实现、新增伪消费、或往 audit.ts 塞半个字段）都在这里红。
 *
 * 三元组：
 *   ① 声明侧在位 —— capability.ts 必填声明 + 信息性 JSDoc；definitions.ts 26 处标注计数
 *      钉死（数据保留、不改）；注册表运行数据自证 L2/L3 ⇒ snapshot ≠ 'none'（与交付面
 *      schema allOf 约束同一事实的两面）。
 *   ② 消费侧恒零 —— 全仓 src 大小写不敏感 snapshot 命中文件集 = 白名单（12 文件）；
 *      名单外文件不得出现 audit.snapshot 读取形态；核心运行包零引用 SnapshotPolicy。
 *   ③ 承载侧无字段 —— contracts/src/audit.ts 全文（AuditRecord + AuditExt + 其余）零命中，
 *      AuditRecord 接口体内既无 snapshot 亦无 beforeAfter 键。
 *   ④ 文档互证 —— SECURITY §3.2 表行已改信息性口径（旧"是（before/after）"承诺不得回潮）；
 *      审计 ARCH-04 勘误指针在场且原文结论未被改写。
 *
 * 运行：node --test tests/unit/phase2-snapshot-truth.test.js
 * ⚠ 依赖已重建 dist（`tsc -b tsconfig.build.json`）：①的运行数据侧经 @winvm/vm-capabilities dist 消费。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { WINDOWS_CAPABILITIES } from '@winvm/vm-capabilities';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
/** 读源码文本（静态守卫；不经 dist —— 同 r19b-s5 / phase2-dead-config 纪律） */
const src = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');

const CAP_TS = 'packages/contracts/src/capability.ts';
const CHECK_TS = 'packages/contracts/src/schema-check.ts';
const DEFS_TS = 'packages/vm-capabilities/src/registry/definitions.ts';
const AUDIT_TS = 'packages/contracts/src/audit.ts';
const SECURITY_MD = 'docs/02-design/SECURITY-GOVERNANCE.md';
const AUDIT_MD = 'docs/audit/2026-10-08-architecture-audit.md';

/** 收集各包 src 目录下全部 .ts（相对仓库根路径） */
function allSrcTs() {
  const out = [];
  for (const pkg of readdirSync(join(ROOT, 'packages'))) {
    const dir = join(ROOT, 'packages', pkg, 'src');
    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) continue;
    const walk = (d) => {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (e.endsWith('.ts')) out.push(p.slice(ROOT.length + 1));
      }
    };
    walk(dir);
  }
  return out;
}

/* ============================================================================
 * ① 声明侧在位
 * ========================================================================== */

describe('P2-T3 · 声明侧（信息性标注 + 计数钉死）', () => {
  test('capability.ts：SnapshotPolicy 联合类型逐字在位且带「信息性声明」头注', () => {
    const c = src(CAP_TS);
    assert.match(
      c,
      /export type SnapshotPolicy = 'none' \| 'after' \| 'before-after';/,
      'SnapshotPolicy 三值联合是声明侧的事实源，不得被改动或删除',
    );
    const declAt = c.indexOf('export type SnapshotPolicy');
    const jsdoc = c.slice(Math.max(0, declAt - 1200), declAt);
    assert.match(jsdoc, /信息性声明/, 'Q2 裁决（2026-10-10 降级信息性）必须写在类型头注上');
    assert.match(jsdoc, /Q2/, '头注须可溯源到裁决编号');
  });

  test('capability.ts：audit.snapshot 为必填声明（形状约束保留，未被顺手可选化）', () => {
    const c = src(CAP_TS);
    assert.match(
      c,
      /readonly audit: \{ readonly snapshot: SnapshotPolicy \};/,
      'audit.snapshot 必填 ⇒ 交付面 schema allOf 与测试消费的前提；可选化即声明侧漂移',
    );
    const fieldAt = c.indexOf('readonly audit: { readonly snapshot: SnapshotPolicy }');
    const jsdoc = c.slice(Math.max(0, fieldAt - 800), fieldAt);
    assert.match(jsdoc, /信息性声明/, '字段 JSDoc 须同样标注信息性口径');
  });

  test('definitions.ts：能力级字面标注恰 26 处（20 after + 6 before-after），接线 2 处在位 —— 计数钉死防"顺手删数据"', () => {
    const d = src(DEFS_TS);
    const after = (d.match(/snapshot: 'after'/g) ?? []).length;
    const ba = (d.match(/snapshot: 'before-after'/g) ?? []).length;
    assert.equal(after, 20, `snapshot: 'after' 标注数漂移（Q2 裁决：数据保留不删），实得 ${after}`);
    assert.equal(ba, 6, `snapshot: 'before-after' 标注数漂移，实得 ${ba}`);
    assert.equal(after + ba, 26, '终审口径：26 条能力级标注（+2 接线 = 28 处，phase2-arch-design §12-3）');
    assert.match(d, /readonly snapshot\?: SnapshotPolicy;/, 'spec.snapshot 声明位（:47 域）在位');
    assert.match(d, /audit: \{ snapshot: spec\.snapshot \?\? 'none' \},/, '接线行（:79 域）在位：缺省落 none');
  });

  test('运行数据自证：注册表全部 L2/L3 能力的 audit.snapshot ≠ none（声明数据与交付面 allOf 约束同事实两面）', () => {
    const bad = WINDOWS_CAPABILITIES.filter(
      (c) => (c.risk === 'L2' || c.risk === 'L3') && c.audit?.snapshot === 'none',
    ).map((c) => c.id);
    assert.deepEqual(bad, [], `L2/L3 且 snapshot=none 的能力（违反 schema allOf 声明侧事实）：${bad.join(', ')}`);
    const declared = WINDOWS_CAPABILITIES.filter((c) => c.audit?.snapshot !== 'none');
    assert.equal(declared.length, 26, '非 none 标注的能力数须与 src 计数 26 一致（src↔dist 不漂移）');
  });
});

/* ============================================================================
 * ② 消费侧恒零（白名单式）
 * ========================================================================== */

/**
 * 全仓 src snapshot 命中（大小写不敏感）的**合法文件白名单**：
 * - 声明/校验位（3）：capability.ts（契约声明+信息性头注）、schema-check.ts（交付面 allOf
 *   专项映射 —— Q1=(b) 测试/门禁面消费，非运行期）、definitions.ts（26 条标注数据+接线）；
 * - 同词异物（9，逐一登记在案）：
 *   a2a-framework/server.ts、a2a-framework/index.ts（DelegationTerminalSnapshot 委派终态快照）；
 *   adapter-agent-workbuddy-llm/persistent-session.ts、bridge.ts（LlmSessionHealth 的 snapshot() 方法及其调用）；
 *   adapter-agent-workbuddy/index.ts（healthSnapshot 会话健康快照）；
 *   vm-service/server.ts / health-probe.ts / http-guard.ts / index.ts（health/session 快照族符号）。
 * 名单外出现任何 snapshot 命中即红；名单内出现 audit.snapshot **读取形态**（名单外亦然）即红。
 */
const WHITELIST = new Set([
  // 声明/校验位（3）
  CAP_TS,
  CHECK_TS,
  DEFS_TS,
  // 同词异物（9）
  'packages/a2a-framework/src/server.ts',
  'packages/a2a-framework/src/index.ts',
  'packages/adapter-agent-workbuddy-llm/src/persistent-session.ts',
  'packages/adapter-agent-workbuddy-llm/src/bridge.ts',
  'packages/adapter-agent-workbuddy/src/index.ts',
  'packages/vm-service/src/server.ts',
  'packages/vm-service/src/health-probe.ts',
  'packages/vm-service/src/http-guard.ts',
  'packages/vm-service/src/index.ts',
]);

const SHAPE_DECL = new Set([CAP_TS, CHECK_TS, DEFS_TS]);

/** audit.snapshot 的"被消费"形态（读取/比较/类型引用），与声明数据形态互斥 */
const CONSUME_RE = /audit\s*\??\s*\.\s*snapshot|\.snapshot\s*[!=]==?|beforeAfter|SnapshotPolicy|spec\.snapshot/;

describe('P2-T3 · 消费侧恒零（白名单守卫）', () => {
  test('全仓 src snapshot 命中文件集 = 白名单 12 文件（名单外新增即红 = "悄悄接上消费"显形）', () => {
    const hits = [];
    for (const rel of allSrcTs()) {
      if (/snapshot/i.test(src(rel))) hits.push(rel);
    }
    const outside = hits.filter((h) => !WHITELIST.has(h));
    assert.deepEqual(outside, [], `名单外文件出现 snapshot 命中（消费侧被新增？）：${outside.join(', ')}`);
    const gone = [...WHITELIST].filter((w) => !hits.includes(w));
    assert.deepEqual(gone, [], `白名单文件不再命中 snapshot（重构或消费消失）——须同步更新本白名单：${gone.join(', ')}`);
    assert.equal(hits.length, 12, `命中文件集应恰 12（3 声明/校验 + 9 同词异物），实得 ${hits.length}`);
  });

  test('同词异物 9 文件逐行零"消费形态"（DelegationTerminalSnapshot/snapshot()/healthSnapshot 均非 audit.snapshot 读取）', () => {
    for (const rel of WHITELIST) {
      if (SHAPE_DECL.has(rel)) continue;
      const lines = src(rel).split('\n');
      const bad = lines
        .map((l, i) => ({ l, n: i + 1 }))
        .filter(({ l }) => CONSUME_RE.test(l))
        .map(({ n, l }) => `${rel}:${n}: ${l.trim().slice(0, 90)}`);
      assert.deepEqual(bad, [], `${rel} 出现 audit.snapshot 消费形态（伪消费回归？）`);
    }
  });

  test('核心运行包零类型引用：core / vm-service / adapter-* / host-* / mcp-framework / a2a-framework 不 import SnapshotPolicy', () => {
    const offenders = [];
    for (const rel of allSrcTs()) {
      if (rel.startsWith('packages/contracts/') || rel.startsWith('packages/vm-capabilities/')) continue;
      if (/SnapshotPolicy|audit\.snapshot/.test(src(rel))) offenders.push(rel);
    }
    assert.deepEqual(offenders, [], `运行/框架包引用快照策略类型（消费侧被接通）：${offenders.join(', ')}`);
  });

  test('变异自检（内存副本，零写盘）：向 core 副本注入一行伪消费 ⇒ 形态守卫必须红（证明守卫非空转）', () => {
    const mutant = 'import type { CapabilityDefinition } from "@winvm/contracts";\nconst s = cap.audit.snapshot;\n';
    assert.ok(CONSUME_RE.test(mutant.split('\n')[1]), '变异体应命中 CONSUME_RE（判据灵敏度自证）');
    // 反向自证：真实同词异物行不得误伤（判据精度）
    for (const harmless of [
      'onGoalTerminal(taskId: string, goal: GoalRequest, snapshot: DelegationTerminalSnapshot): void;',
      'snapshot(): LlmSessionHealth {',
      'return this.persistent?.snapshot();',
      'healthSnapshot: (): Promise<Record<string, unknown>> =>',
    ]) {
      assert.ok(!CONSUME_RE.test(harmless), `同词异物行被误判为消费形态：${harmless}`);
    }
  });
});

/* ============================================================================
 * ③ 承载侧无字段
 * ========================================================================== */

describe('P2-T3 · 承载侧（AuditRecord 无快照字段）', () => {
  test('contracts/src/audit.ts 全文大小写不敏感零 snapshot 命中（连半个承载位都没有 —— 比"零消费"更深一层的缺口实证）', () => {
    const a = src(AUDIT_TS);
    assert.ok(!/snapshot/i.test(a), 'audit.ts 出现 snapshot 字样 ⇒ 承载侧开始被"悄悄实现"，须回到设计重裁');
  });

  test('AuditRecord 接口体内无 snapshot / beforeAfter 键（ext 亦无 —— Q2 裁决未实现快照的字段面证据）', () => {
    const a = src(AUDIT_TS);
    const body = a.slice(a.indexOf('export interface AuditRecord'));
    const end = body.indexOf('\n}');
    assert.ok(end > 0, 'AuditRecord 接口体可截取');
    const iface = body.slice(0, end);
    assert.ok(!/\bsnapshot\b/i.test(iface), 'AuditRecord 字段面不得含快照位');
    assert.ok(!/beforeAfter/.test(iface), 'AuditRecord 字段面不得含 beforeAfter');
  });

  test('AuditExt 类型面同样零命中（K-N1 增量未夹带快照字段）', () => {
    const a = src(AUDIT_TS);
    const at = a.indexOf('AuditExt');
    assert.ok(at > 0);
    const seg = a.slice(at, a.indexOf('export interface AuditRecord'));
    assert.ok(!/snapshot|beforeAfter/i.test(seg), 'AuditExt 域不得出现快照字段');
  });
});

/* ============================================================================
 * ④ 文档互证（SECURITY 改述 + 审计勘误指针）
 * ========================================================================== */

describe('P2-T3 · 文档口径一致性', () => {
  test('SECURITY §3.2 快照行 = 信息性口径（旧"是（before/after）"承诺不得回潮）', () => {
    const sec = src(SECURITY_MD);
    const row = sec.split('\n').find((l) => l.startsWith('| L2/L3 是否强制快照'));
    assert.ok(row, '§3.2 表快照行必须在场（行被删=口径失踪，同样红）');
    assert.match(row, /信息性声明/, '该行须为 Q2 裁决的信息性口径');
    assert.match(row, /不实现/, '须明写"不实现 before/after"而非含糊');
    assert.match(row, /交付面|形状校验/, '须写明声明参与交付面校验');
    assert.match(row, /运行期不产快照|零消费/, '须写明运行期不产快照');
    assert.match(row, /phase2-snapshot-truth/, '判据自指：行内登记本测试为钉死点');
    assert.ok(!/\| 是（before\/after） \|/.test(sec), '全文件不得再有"是（before/after）"的表体承诺回潮');
  });

  test('SECURITY §3.2 表头"与代码逐字一致"的自约束不被本批改述破坏（表行仍是 DEFAULT_POLICY 之外唯一非策略行说明 —— 快照行改述不涉策略表体）', () => {
    const sec = src(SECURITY_MD);
    // 策略表体（黑名单/白名单等 6 行）逐字口径未动 —— 抽查两行锚点
    assert.ok(sec.includes('| 默认 `maxRisk`（委派） | `L1` |'), '策略表 maxRisk 行逐字不变');
    assert.match(sec, /\*\*五条必须知道的口径\*\*/, 'P2-T2 起的口径计数（五条）不被本批破坏');
  });

  test('审计文档 ARCH-04 勘误指针在场，且原文结论逐字保留（K-20：前向指针不改写历史）', () => {
    const au = src(AUDIT_MD);
    const row = au.split('\n').find((l) => l.startsWith('| **ARCH-04**'));
    assert.ok(row, 'ARCH-04 行必须仍在');
    // 勘误指针（P2-T3 表下注记）
    const noteIdx = au.indexOf('勘误指针 · ARCH-04');
    assert.ok(noteIdx > 0, 'ARCH-04 勘误指针注记在场（§6 P1 表下）');
    const note = au.slice(noteIdx, noteIdx + 1200);
    assert.match(note, /Q2/, '指针须引用用户裁决编号');
    assert.match(note, /信息性/, '指针须写明处置 = 降级信息性');
    assert.match(note, /phase2-snapshot-truth/, '指针须指向事实三元组守卫');
    // 原文未改写：ARCH-04 行保留原始判定字样
    assert.match(row, /纯元数据，零消费者/, '审计原文结论不得被改写');
    assert.match(row, /最小实现/, '审计原文建议列不得被抹除');
  });
});

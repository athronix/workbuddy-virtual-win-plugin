/**
 * Phase 3 批2 · Q4 审批卡死链运行态修复脚本（单测，纯函数 + tmp 夹具）
 *
 * 运行（只跑本文件）：node --test tests/unit/phase3-b2-deadlink-fix.test.js
 *
 * 覆盖 delivery/tools/fix-approval-deadlinks.mjs 的三条规则与守卫：
 *  - `../winvm-orchestrator/approval-card.md` → `../winvm-orchestrator/references/approval-card.md`（5 领域 SKILL 型）
 *  - `./approval-card.md` → `./references/approval-card.md`（orchestrator 自引型）
 *  - 已是正确路径不动（幂等）；目标真身不存在 ⇒ SKIP（绝不把死链改成另一死链）；
 *  - widget 引用只探测不改写（缺件属分发面差异）；
 *  - planFixForRoot 在 tmp 夹具上的端到端（dry 判定 + fixedText 落地文本）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  rewriteApprovalLinks,
  planFixForRoot,
  probeWidgetReferences,
} from '../../delivery/tools/fix-approval-deadlinks.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'b2-deadlink-'));
  const mk = (p, body) => {
    const full = join(root, p);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
    return full;
  };
  // 真身齐备面
  mk('winvm-orchestrator/references/approval-card.md', '# approval card template');
  mk('winvm-app-manager/SKILL.md', '统一模板见 [`../winvm-orchestrator/approval-card.md`](../winvm-orchestrator/approval-card.md)（唯一正文）\n另见 `references/approval-card.md` 不动。\n');
  mk('winvm-orchestrator/SKILL.md', '模板见 [`./approval-card.md`](./approval-card.md) 与 [`./references/approval-card-widget.html`](./references/approval-card-widget.html)。\n');
  return root;
}

test('规则1：领域 SKILL 型死链 → 正确改写（目标存在才动手）', () => {
  const dir = join(fixture(), 'winvm-app-manager');
  const text = readFileSync(join(dir, 'SKILL.md'), 'utf8');
  const r = rewriteApprovalLinks(text, (p) => existsSync(p), dir);
  assert.equal(r.edits.length, 1);
  assert.equal(r.edits[0].to, '../winvm-orchestrator/references/approval-card.md');
  assert.ok(!r.text.includes('](../winvm-orchestrator/approval-card.md)'), '死链须清零');
  assert.ok(r.text.includes('../winvm-orchestrator/references/approval-card.md'));
  // 幂等：对已修文本再跑 ⇒ 零 edit
  const r2 = rewriteApprovalLinks(r.text, (p) => existsSync(p), dir);
  assert.equal(r2.edits.length, 0, '已正确路径不得重复改（幂等第二遍全 SKIP 判据）');
});

test('规则2：orchestrator 自引 ./approval-card.md → ./references/approval-card.md', () => {
  const dir = join(fixture(), 'winvm-orchestrator');
  const text = readFileSync(join(dir, 'SKILL.md'), 'utf8');
  const r = rewriteApprovalLinks(text, (p) => existsSync(p), dir);
  const e = r.edits.find((x) => x.to === './references/approval-card.md');
  assert.ok(e, '自引死链须被改写');
  assert.ok(!r.text.includes('./approval-card.md)'), '改写后不得残留 `](./approval-card.md)` 死链');
  assert.ok(r.text.includes('[`./references/approval-card.md`](./references/approval-card.md)'));
});

test('守卫：改写目标不存在 ⇒ SKIP（绝不把死链改成另一死链）', () => {
  const root = mkdtempSync(join(tmpdir(), 'b2-deadlink-bare-'));
  try {
    const dir = join(root, 'winvm-app-manager');
    mkdirSync(dir, { recursive: true });
    const text = '见 [`../winvm-orchestrator/approval-card.md`](../winvm-orchestrator/approval-card.md)。';
    const r = rewriteApprovalLinks(text, () => false, dir);
    assert.equal(r.edits.length, 0, '目标缺失不得改写');
    assert.equal(r.skips.length, 1);
    assert.match(r.skips[0].reason, /不存在/);
    assert.equal(r.text, text, 'SKIP 时文本原样');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('planFixForRoot：端到端夹具（两个 skill 各命中一条，fixedText 可直接写盘）', () => {
  const root = fixture();
  try {
    const plans = planFixForRoot(root);
    const names = plans.map((p) => p.skill).sort();
    assert.deepEqual(names, ['winvm-app-manager', 'winvm-orchestrator']);
    const orch = plans.find((p) => p.skill === 'winvm-orchestrator');
    assert.ok(orch.changed);
    assert.ok(orch.fixedText.includes('./references/approval-card.md'));
    assert.ok(orch.fixedText.includes('approval-card-widget.html'), 'widget 引用保持原样（只探测面）');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('probeWidgetReferences：只探测不改写（缺件 WARN 面）', () => {
  const root = fixture();
  try {
    const rep = probeWidgetReferences(root);
    const orch = rep.find((r) => r.skill === 'winvm-orchestrator');
    assert.ok(orch, 'widget 引用面须被探测到');
    assert.equal(orch.widgetExists, false, '夹具未放 widget 文件 ⇒ exists=false');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('面不存在 ⇒ 空计划（幂等安全，未部署/已收敛都是空）', () => {
  assert.deepEqual(planFixForRoot(join(tmpdir(), 'definitely-not-here-9f3a')), []);
  assert.deepEqual(probeWidgetReferences(join(tmpdir(), 'definitely-not-here-9f3a')), []);
});

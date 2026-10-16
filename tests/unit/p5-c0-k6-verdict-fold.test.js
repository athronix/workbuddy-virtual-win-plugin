/**
 * C0（Phase 5）· K6 折叠离线钉 —— 第①组：纯函数真值表
 *
 * 背景（立案见 `qa/p5-batch/v19-VERDICT.md`）：呈报全链只消费信封 `ok`，
 * `data.success===false` 的 K6 失败回执被压平成「执行成功」。折叠件
 * `packages/vm-service/src/k6-verdict.ts` 的判据面在此逐例钉死：
 *  ① 触发面：plain object ∧ `success === false`（严格布尔）⇒ ok=false /
 *    isError=true / k6Failed=true / errorMessage 含 K6 文案；
 *  ② 不触发面（严格判据，向后兼容零误伤）：`success:true` / 无键 `{}` /
 *    字符串 `"false"` / 数字 `0` / null data / 数组 data / envelopeOk=false
 *    （假⇒假，不翻案）；
 *  ③ 残留证据摘要：存在且非空 ⇒ 截断 200 字符进文案；空形态 ⇒ 缺席。
 *
 * 行为面（起服务/接线断言）、record 前时序、toExecutedResult 复用钉、变异自证
 * 在接线落地后由本文件后续组补齐（C0-3 ②③④⑤）。
 *
 * 运行（只跑本文件，绝不整批）：
 *   node --test tests/unit/p5-c0-k6-verdict-fold.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  foldK6Verdict,
  residualEvidenceSummary,
  K6_FAIL_MESSAGE,
} from '@winvm/vm-service';

/* ==================== ① 触发面（严格 false） ==================== */

describe('C0-① K6 折叠触发面', () => {
  test('data={success:false} + envelopeOk=true ⇒ 折叠（ok=false/isError=true/k6Failed=true）', () => {
    const f = foldK6Verdict(true, { success: false });
    assert.equal(f.k6Failed, true, '严格布尔 false 必须命中折叠');
    assert.equal(f.ok, false, '信封 ok 必须改判 false');
    assert.equal(f.isError, true, 'isError 必须同步置 true');
    assert.equal(typeof f.errorMessage, 'string', '折叠命中必须带失败文案');
    assert.ok(f.errorMessage.includes(K6_FAIL_MESSAGE), `文案须含基干「${K6_FAIL_MESSAGE}」`);
  });

  test('真实卸载失败回执形态（exitCode=0+success=false+residualEvidence）⇒ 折叠且证据进文案', () => {
    const f = foldK6Verdict(true, {
      id: 'WXWork',
      dryRun: false,
      exitCode: 0,
      success: false,
      verified: { exeGone: false, dirGone: null, registryGone: false },
      fallbackUsed: true,
      residualEvidence: '残留 exe: C:\\Program Files\\WXWork\\WXWork.exe',
    });
    assert.equal(f.k6Failed, true);
    assert.equal(f.ok, false);
    assert.ok(f.errorMessage.includes('残留证据'), `文案须携残留证据段，实得：${f.errorMessage}`);
    assert.ok(f.errorMessage.includes('WXWork.exe'), '证据内容须原样（截断后）进文案');
  });
});

/* ==================== ② 不触发面（严格判据） ==================== */

describe('C0-② K6 折叠不触发面（零误伤）', () => {
  test('success:true ⇒ 不折（ok 随信封）', () => {
    const f = foldK6Verdict(true, { success: true });
    assert.equal(f.k6Failed, false);
    assert.equal(f.ok, true);
    assert.equal(f.isError, false);
  });

  test('空对象 {}（无 success 键）⇒ 不折（undefined 不触发）', () => {
    const f = foldK6Verdict(true, {});
    assert.equal(f.k6Failed, false, 'undefined 不得触发折叠');
    assert.equal(f.ok, true);
    assert.equal(f.isError, false);
  });

  test('success:"false"（字符串）⇒ 不折（严格 === false，防判据漂移为宽松）', () => {
    const f = foldK6Verdict(true, { success: 'false' });
    assert.equal(f.k6Failed, false, '字符串 "false" 不是布尔 false');
    assert.equal(f.ok, true);
  });

  test('success:0 / success:null / success:"" ⇒ 不折（falsy 但非严格 false）', () => {
    for (const v of [0, null, '', undefined, NaN]) {
      const f = foldK6Verdict(true, { success: v });
      assert.equal(f.k6Failed, false, `success=${String(v)} 不得触发（严格判据面）`);
      assert.equal(f.ok, true);
    }
  });

  test('data=null / undefined / 数组 / primitive ⇒ 不折（非 plain object）', () => {
    for (const d of [null, undefined, [], [{ success: false }], 'false', false, 0]) {
      const f = foldK6Verdict(true, d);
      assert.equal(f.k6Failed, false, `data=${JSON.stringify(d)} 不得触发（非 plain object）`);
      assert.equal(f.ok, true);
    }
  });

  test('envelopeOk=false ⇒ 原样呈报失败（k6Failed=false，不叠加 K6 语义）', () => {
    const noData = foldK6Verdict(false, undefined);
    assert.equal(noData.ok, false, '信封假 ⇒ 保持假（折叠只收紧不翻案）');
    assert.equal(noData.isError, true);
    assert.equal(noData.k6Failed, false);
    const withFalse = foldK6Verdict(false, { success: false });
    assert.equal(withFalse.k6Failed, true, '信封已假时 data.success=false 仍标记 K6（文案可用）');
    assert.equal(withFalse.ok, false);
  });

  test('dryRun 预览回执（success=true 或无键）⇒ 不折（免审批预览语义不受触）', () => {
    assert.equal(foldK6Verdict(true, { dryRun: true, success: true, plan: { installed: true } }).k6Failed, false);
    assert.equal(foldK6Verdict(true, { dryRun: true, exitCode: 0 }).k6Failed, false);
  });
});

/* ==================== ③ 残留证据摘要 ==================== */

describe('C0-③ 残留证据摘要（截断 200 防回执膨胀）', () => {
  test('超长数组证据 ⇒ 截断到 ≤203（200+省略号）且非空', () => {
    const s = residualEvidenceSummary({ residualEvidence: ['a'.repeat(300)] });
    assert.equal(typeof s, 'string');
    assert.ok(s.length <= 203, `截断纪律：长度应 ≤203，实得 ${s.length}`);
    assert.ok(s.length >= 200, `应确实截断（近上限），实得 ${s.length}`);
    assert.ok(s.endsWith('…'), '截断标记须在尾部显形');
  });

  test('字符串证据原样保留（≤200 不截）', () => {
    const s = residualEvidenceSummary({ residualEvidence: '键残留: HKLM\\...\\Uninstall\\WXWork' });
    assert.equal(s, '键残留: HKLM\\...\\Uninstall\\WXWork');
  });

  test('空形态（缺键/null/空串/空数组/空对象）⇒ undefined（不写空证据段）', () => {
    for (const d of [
      undefined,
      null,
      {},
      { residualEvidence: null },
      { residualEvidence: '' },
      { residualEvidence: '   ' },
      { residualEvidence: [] },
      { residualEvidence: {} },
    ]) {
      assert.equal(residualEvidenceSummary(d), undefined, `空形态应判 undefined：${JSON.stringify(d)}`);
    }
  });

  test('非 plain object data ⇒ undefined（数组/null/primitive 无证据面）', () => {
    assert.equal(residualEvidenceSummary([]), undefined);
    assert.equal(residualEvidenceSummary('residual'), undefined);
    assert.equal(residualEvidenceSummary(null), undefined);
  });

  test('折叠文案组合：无证据 ⇒ 只含基干；有证据 ⇒ 基干+「；残留证据: 」段', () => {
    const bare = foldK6Verdict(true, { success: false });
    assert.equal(bare.errorMessage, K6_FAIL_MESSAGE, '无 residualEvidence ⇒ 不得出现空证据段');
    const withEv = foldK6Verdict(true, { success: false, residualEvidence: 'exe 残留' });
    assert.ok(withEv.errorMessage.startsWith(`${K6_FAIL_MESSAGE}；残留证据: `));
    assert.ok(withEv.errorMessage.includes('exe 残留'));
  });
});

/* ==================== ⑤ 变异自证（内存副本，零写盘） ==================== */

describe('C0-⑤ 判据变异自证（防严格判据漂移）', () => {
  /**
   * 把折叠判据在**内存副本**里从 `=== false` 改成 `!== true`（宽松化）：
   * `{}`（无键）案例必须转红（宽松化后 undefined !== true ⇒ 误触发），
   * 证明本件②组的严格判据断言不是空转。
   */
  test('变异：判据 `!== true` 化 ⇒ 严格面案例（{} / "false" / 0）误触发显形', () => {
    const mutantFold = (envelopeOk, data) => {
      const isObj = data && typeof data === 'object' && !Array.isArray(data);
      // 变异行：把 `data.success === false` 换成 `data.success !== true`
      const fail = isObj && data.success !== true;
      return { ok: !fail && envelopeOk, isError: fail || !envelopeOk, k6Failed: fail };
    };
    // 判据灵敏度自证：变异体对 {} 误触发（真实现必须不触发 ⇒ ②组断言有效）
    assert.equal(mutantFold(true, {}).k6Failed, true, '变异体必须让 {} 转红（否则②组钉是空断言）');
    assert.equal(mutantFold(true, { success: 'false' }).k6Failed, true, '变异体必须让 "false" 转红');
    assert.equal(mutantFold(true, { success: 0 }).k6Failed, true, '变异体必须让 0 转红');
    // 反向对照：真实现对同样输入全部不触发（变异确实改变判据结果）
    assert.equal(foldK6Verdict(true, {}).k6Failed, false);
    assert.equal(foldK6Verdict(true, { success: 'false' }).k6Failed, false);
    assert.equal(foldK6Verdict(true, { success: 0 }).k6Failed, false);
  });

  test('变异：判据 `== false`（宽松等值）化 ⇒ 数字 0 / 空串 误触发显形', () => {
    const mutantFold = (envelopeOk, data) => {
      const isObj = data && typeof data === 'object' && !Array.isArray(data);
      const fail = isObj && data.success == false; // 变异：== 代替 ===
      return { ok: !fail && envelopeOk, k6Failed: fail };
    };
    // JS 强制转换事实：0==false 与 ''==false 为真 ⇒ 宽松等值误伤这两例；
    //（'false'==false、null==false 为假 ⇒ 字符串/缺键面由上一条 `!== true` 变异捕获，
    //  两变异互补覆盖宽松化判据）
    assert.equal(mutantFold(true, { success: 0 }).k6Failed, true, '变异体必须让 0 转红');
    assert.equal(mutantFold(true, { success: '' }).k6Failed, true, '变异体必须让 空串 转红');
    // 反向对照：真实现对同样输入全部不触发（变异确实改变判据结果）
    assert.equal(foldK6Verdict(true, { success: 0 }).k6Failed, false, '真实现不触发 0（对照）');
    assert.equal(foldK6Verdict(true, { success: '' }).k6Failed, false, '真实现不触发 空串（对照）');
  });
});

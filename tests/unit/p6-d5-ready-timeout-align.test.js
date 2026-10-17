/**
 * Phase 6 批18 · D-5 专项回归：常驻会话就绪超时与预热预算对齐
 *
 * 背景（真机实证 2026-10-17，`qa/p5-batch/b16/v20-warm2.txt` + VM 日志）：
 *   深度空闲 4.86h 后首调冷启动实测 49.3s（`firstCallLatencyMs=49278`），逼近原
 *   60s 的 `system/init` 判死阈值 ⇒ 「常驻会话在 60000ms 内未收到 system/init」
 *   概率性误判 ⇒ 该次委派静默落到单次 `-p` 降级路径（自证文本：「已降级为单次 -p 路径」）。
 *   而 K2 注释自述 codebuddy 进程级冷启动（auth probe + agent 端点）≈75–107s，
 *   **本身已超过 60s** ⇒ 60s 默认值与文档化的冷启动成本自相矛盾。
 *
 * 修法（裁决 D-5 = A+B 的 B 部分）：与 `LLM_SESSION_WARMUP_MS_DEFAULT`（180s）对齐 ——
 * 预热预算与真实轮次预算描述的是**同一个**冷启动过程，不一致等于让预热白做。
 *
 * 本文件钉：
 *   ① 默认值等于预热预算（对齐不变式）；
 *   ② 大于 K2 实测冷启动上界（107s）——阈值必须显著高于被测过程成本才有判别力；
 *   ③ env 覆盖仍生效（运维可调，不写死）。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ENV_LLM_SESSION_READY_MS,
  ENV_LLM_SESSION_WARMUP_MS,
  LLM_SESSION_READY_MS_DEFAULT,
  LLM_SESSION_WARMUP_MS_DEFAULT,
  resolveLlmSessionConfig,
} from '@winvm/core';

/** K2 实测的 codebuddy 进程级冷启动上界（auth probe + agent 端点 ≈75–107s）。 */
const MEASURED_COLD_START_UPPER_MS = 107_000;

describe('D-5 就绪超时与预热预算对齐', () => {
  test('默认值 = 预热预算（同一冷启动过程，两个预算不得分叉）', () => {
    assert.equal(
      LLM_SESSION_READY_MS_DEFAULT,
      LLM_SESSION_WARMUP_MS_DEFAULT,
      'readyTimeoutMs 与 warmupReadyMs 描述同一个冷启动过程，必须同源',
    );
  });

  test('默认值显著高于实测冷启动上界（107s）——阈值高于过程成本才有判别力', () => {
    assert.ok(
      LLM_SESSION_READY_MS_DEFAULT > MEASURED_COLD_START_UPPER_MS,
      `就绪上限 ${LLM_SESSION_READY_MS_DEFAULT} 必须大于实测冷启动上界 ${MEASURED_COLD_START_UPPER_MS}`,
    );
  });

  test('仍远小于宿主委派预算 600s（不放宽到失控）', () => {
    assert.ok(LLM_SESSION_READY_MS_DEFAULT < 600_000, '就绪上限不得逼近宿主委派预算');
  });

  test('resolveLlmSessionConfig 出厂默认即对齐值', () => {
    const cfg = resolveLlmSessionConfig({});
    assert.equal(cfg.readyTimeoutMs, 180_000);
    assert.equal(cfg.warmupReadyMs, 180_000);
  });

  test('env 覆盖仍生效（运维可调，不写死）', () => {
    const cfg = resolveLlmSessionConfig({
      [ENV_LLM_SESSION_READY_MS]: '90000',
      [ENV_LLM_SESSION_WARMUP_MS]: '120000',
    });
    assert.equal(cfg.readyTimeoutMs, 90_000, 'WINVM_LLM_SESSION_READY_MS 覆盖必须生效');
    assert.equal(cfg.warmupReadyMs, 120_000, 'WINVM_LLM_SESSION_WARMUP_MS 覆盖必须生效');
  });
});

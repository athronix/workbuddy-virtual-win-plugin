/**
 * R-5 取消风暴门禁化（Phase 3 批5 · 用户 2026-10-13 终裁 B=主动排期）。
 *
 * 真机实证病灶：198 任务 × 并发 8 的 `tasks/cancel` 打挂 vm-service（+~90 孤儿 node）。
 * 根因链：每次 `requestCancel` → `cancelController.abort` + `updateStatus('canceled')`，
 * 对 provider=workbuddy 的 LLM **常驻会话**而言，abort 打断当前轮 ⇒ 触发会话重建；
 * 批量并发 cancel ⇒ 重建风暴 ⇒ 崩溃（MEMORY 红线：单条 cancel 端到端 ~3.4s 已属重操作）。
 *
 * 处方：服务端对 `tasks/cancel` **到达频率**设滑动窗口闸。超限的 cancel 直接以 JSON-RPC
 * 错误拒回（不排队、不吞、不半处理）——拒多余 cancel 远优于让服务被打挂。
 * 这是**保护面**不是**功能面**：低频正常取消（人工/单个 Agent）绝不触发；仅风暴形态显形。
 *
 * 纪律：纯函数式计数（可注入 `now` 供离线单测零等待），无定时器、无状态泄漏（旧桶随窗口滑出丢弃）。
 */

export interface CancelRateLimit {
  /** 窗口宽度（毫秒）。≤0/非有限 ⇒ 视为禁用。 */
  readonly windowMs: number;
  /** 窗口内允许的**最大 cancel 次数**。≤0/非有限 ⇒ 视为禁用。 */
  readonly maxPerWindow: number;
}

/**
 * 极简滑动窗口限流器：保存最近一批**通过**的 cancel 时间戳，判定时丢弃窗口外旧值、
 * 数窗口内值是否已达上限。不记被拒的时间戳（被拒没消耗"预算"，也不该污染窗口）。
 */
export class CancelRateLimiter {
  private hits: number[] = [];
  constructor(private readonly limit: CancelRateLimit) {}

  get enabled(): boolean {
    return (
      Number.isFinite(this.limit.windowMs) &&
      this.limit.windowMs > 0 &&
      Number.isFinite(this.limit.maxPerWindow) &&
      this.limit.maxPerWindow > 0
    );
  }

  /**
   * 记一次 cancel 尝试并裁决。**判定即消费**（放行则登记时间戳）——非幂等，调用一次算一次。
   * @returns `{ allowed, retryAfterMs }`：allowed=false 时 retryAfterMs = 最早一笔滑出窗口的剩余毫秒
   *          （给调用方退避提示，至少 1ms，≤ windowMs）。禁用态恒 `{ allowed: true, retryAfterMs: 0 }`。
   */
  tryConsume(nowMs: number = Date.now()): { allowed: boolean; retryAfterMs: number } {
    if (!this.enabled) return { allowed: true, retryAfterMs: 0 };
    const { windowMs, maxPerWindow } = this.limit;
    const cutoff = nowMs - windowMs;
    // 丢弃窗口外的旧命中（原地截断：hits 天然按到达序递增）
    let start = 0;
    while (start < this.hits.length && this.hits[start]! <= cutoff) start++;
    if (start > 0) this.hits.splice(0, start);

    if (this.hits.length >= maxPerWindow) {
      // 拒绝且不登记：预算已满，多余 cancel 不消耗也不计入窗口
      const oldest = this.hits[0]!;
      const retry = Math.min(windowMs, Math.max(1, windowMs - (nowMs - oldest)));
      return { allowed: false, retryAfterMs: retry };
    }
    this.hits.push(nowMs);
    return { allowed: true, retryAfterMs: 0 };
  }

  /** 测试/运维观测：当前窗口内已登记的命中数。 */
  get currentWindowCount(): number {
    return this.hits.length;
  }

  reset(): void {
    this.hits = [];
  }
}

/**
 * CL-019 T4 · 项① `/health.cache.netCfg.ageMs` 真实缓存新鲜度（静态源码守卫 + 逻辑镜像断言）
 *
 * 本仓库 `node --test` 运行环境**无 VM / 无 PowerShell**，无法真跑服务；故此处：
 *   ① 静态守卫 `server.ts`：`ageMs` 由 `collectedAt` 计算（非 `warmedAtMs`/uptime）；
 *      预热与正常调用均捕获 `collectedAt`；本地态声明 `collectedAt?`；
 *   ② 逻辑镜像：以与实现同形的公式断言
 *      - `ageMs` 反映**真实缓存龄**（而非进程 uptime）；
 *      - refresh（`collectedAt` 更新）后 `ageMs` **回落**；
 *      - 无成功采集 → -1；有采集但缺 `collectedAt` → 0。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = join(import.meta.dirname, '..', '..');
const SERVER = readFileSync(
  join(ROOT, 'packages', 'vm-service', 'src', 'server.ts'),
  'utf8',
);
const ADAPTER = readFileSync(
  join(ROOT, 'packages', 'adapter-agent-workbuddy', 'src', 'index.ts'),
  'utf8',
);
const HERMES = readFileSync(
  join(ROOT, 'packages', 'adapter-agent-hermes', 'src', 'index.ts'),
  'utf8',
);
const WORKBUDDY_LLM = readFileSync(
  join(ROOT, 'packages', 'adapter-agent-workbuddy-llm', 'src', 'index.ts'),
  'utf8',
);

/**
 * `ageMs` 计算逻辑镜像（与 `server.ts` 的 `/health` 聚合实现同形，含 F1 有限性兜底）。
 */
function computeAgeMs(cache, nowMs) {
  const parsedAt = cache.collectedAt ? Date.parse(cache.collectedAt) : Number.NaN;
  return Number.isFinite(parsedAt)
    ? Math.max(0, nowMs - parsedAt)
    : cache.ok
      ? 0
      : -1;
}

describe('CL-019 项① · server.ts 静态守卫', () => {
  test('ageMs 由 collectedAt 计算（真实新鲜度），不再使用 warmedAtMs', () => {
    assert.ok(
      SERVER.includes('Date.parse(netCfgCache.collectedAt)'),
      'ageMs 应由 Date.parse(netCfgCache.collectedAt) 计算',
    );
    assert.ok(
      !SERVER.includes('Date.now() - netCfgCache.warmedAtMs'),
      'ageMs 不得再使用 `Date.now() - netCfgCache.warmedAtMs`（≈ 进程 uptime）',
    );
  });

  test('F1 硬化：ageMs 计算含有限性兜底（Number.isFinite），杜绝 NaN→null', () => {
    assert.ok(
      SERVER.includes('Number.isFinite(parsedAt)'),
      'ageMs 应由 Number.isFinite(parsedAt) 兜底，保证恒为有限 number',
    );
    assert.ok(
      /const parsedAt = netCfgCache\.collectedAt \? Date\.parse\(netCfgCache\.collectedAt\) : Number\.NaN/.test(
        SERVER,
      ),
      '应先解析 parsedAt（collectedAt 缺失 → Number.NaN）再判有限性',
    );
  });

  test('本地态 netCfgCache 声明 collectedAt?', () => {
    assert.ok(
      /netCfgCache:\s*\{[^}]*collectedAt\?:\s*string/.test(SERVER),
      'netCfgCache 本地态类型应含 collectedAt?: string',
    );
  });

  test('预热路径捕获 collectedAt（捕获返回值）', () => {
    assert.ok(
      SERVER.includes('const prewarmRes = await runtime.bridge.call'),
      '预热应捕获 bridge.call 返回值（prewarmRes）',
    );
    assert.ok(
      SERVER.includes('prewarmCollectedAt'),
      '预热应从返回值提取 collectedAt',
    );
  });

  test('CL-020 F2：正常调用路径的 handler 层重复捕获已移除（单一数据源，禁双写）', () => {
    // 捕获已移至 provider.execute 内的 reportNetCfg 注入回调；server.ts MCP handler
    // 不得再出现 `res.ok && cap.id === 'system.network.config'` 双写分支。
    assert.ok(
      !/res\.ok && cap\.id === 'system\.network\.config'/.test(SERVER),
      'server.ts 不得再含 `res.ok && cap.id === system.network.config` 重复捕获分支（单一数据源）',
    );
  });

  test('CL-020 F2：reportNetCfg 注入回调存在且为单一数据源写入点', () => {
    assert.ok(
      SERVER.includes('reportNetCfg'),
      'server.ts 的 bridgeCtx 应注入 reportNetCfg 回调',
    );
    assert.ok(
      /reportNetCfg:\s*\(collectedAt:\s*string\)/.test(SERVER),
      'reportNetCfg 签名应为 (collectedAt: string) => void',
    );
    // 单一数据源写入点：reportNetCfg 回调体内写 netCfgCache.collectedAt（MCP/A2A 共用 execute 经此上抛）。
    assert.ok(
      /reportNetCfg:\s*\(collectedAt:\s*string\)[\s\S]*?netCfgCache\.collectedAt = collectedAt/.test(SERVER),
      'reportNetCfg 回调体内应将 collectedAt 写入 netCfgCache（单一数据源）',
    );
  });

  test('CL-020 F2：adapter-agent-workbuddy 在 execute 内调用 reportNetCfg（MCP + A2A 全覆）', () => {
    assert.ok(
      /capabilityId === 'system\.network\.config'/.test(ADAPTER),
      'adapter 应在 execute 内判定 req.capabilityId === system.network.config',
    );
    assert.ok(
      ADAPTER.includes('reportNetCfg'),
      'adapter 应调用注入的 reportNetCfg',
    );
    assert.ok(
      /this\.ctx as unknown as \{ reportNetCfg\?/.test(ADAPTER),
      'adapter 应以 cast 模式（as unknown as { reportNetCfg?... }）读取注入回调，不扩契约接口',
    );
  });

  test('CL-020 F2：hermes / workbuddy-llm 的 execute 为 this.executor.execute(req) 委托（单 hook 全覆）', () => {
    assert.ok(
      /return this\.executor\.execute\(req\)/.test(HERMES),
      'hermes execute 应委托 this.executor.execute(req)（由 workbuddy 的 hook 受益）',
    );
    assert.ok(
      /return this\.executor\.execute\(req\)/.test(WORKBUDDY_LLM),
      'workbuddy-llm execute 应委托 this.executor.execute(req)（由 workbuddy 的 hook 受益）',
    );
  });
});

describe('CL-019 项① · ageMs 逻辑镜像（反映真实缓存龄，非 uptime）', () => {
  const T0 = Date.parse('2026-09-21T10:00:00.000Z');

  test('有 collectedAt → ageMs = now - Date.parse(collectedAt)（非 uptime）', () => {
    // 场景：进程已运行 1 小时（warmedAtMs 很早），但最近采集仅在 2 秒前。
    const cache = {
      warmedAtMs: T0 - 3_600_000, // 1h 前的预热（模拟 uptime）
      ok: true,
      collectedAt: new Date(T0 - 2_000).toISOString(), // 2s 前采集
    };
    const ageMs = computeAgeMs(cache, T0);
    assert.equal(ageMs, 2_000, 'ageMs 应为真实缓存龄 2000ms');
    assert.notEqual(ageMs, 3_600_000, 'ageMs 不得等于进程 uptime（3600000ms）');
  });

  test('refresh（collectedAt 更新）后 ageMs 回落', () => {
    // 刷新前：collectedAt 在 30s 前
    const before = { warmedAtMs: 0, ok: true, collectedAt: new Date(T0 - 30_000).toISOString() };
    const ageBefore = computeAgeMs(before, T0);
    assert.equal(ageBefore, 30_000, '刷新前 ageMs 应为 30000ms');

    // 模拟 refresh:true 调用成功 → collectedAt 更新为“现在”
    const after = { warmedAtMs: 0, ok: true, collectedAt: new Date(T0).toISOString() };
    const ageAfter = computeAgeMs(after, T0);
    assert.equal(ageAfter, 0, 'refresh 后 ageMs 应回落至 0');
    assert.ok(ageAfter < ageBefore, 'refresh 后 ageMs 必须小于刷新前（回落语义）');
  });

  test('无成功采集（ok=false）→ ageMs = -1（契约约定）', () => {
    const cache = { warmedAtMs: 0, ok: false };
    assert.equal(computeAgeMs(cache, T0), -1, '无采集时 ageMs 应为 -1');
  });

  test('有成功采集但 collectedAt 暂缺（理论不应发生）→ ageMs = 0', () => {
    const cache = { warmedAtMs: T0, ok: true };
    assert.equal(computeAgeMs(cache, T0), 0, 'ok 但缺 collectedAt 时 ageMs 应为 0');
  });

  test('ageMs 恒非负（时钟回拨防护）', () => {
    const cache = { warmedAtMs: 0, ok: true, collectedAt: new Date(T0 + 5_000).toISOString() };
    assert.equal(computeAgeMs(cache, T0), 0, 'collectedAt 在未来时应钳制为 0（Math.max）');
  });

  test('F1 硬化：collectedAt 非法（非空但 Date.parse→NaN）→ ageMs 恒为有限 number（非 NaN/null）', () => {
    // ok=true：非法 collectedAt → 回落到 0
    const badOk = { warmedAtMs: 0, ok: true, collectedAt: 'not-a-date' };
    const ageOk = computeAgeMs(badOk, T0);
    assert.ok(Number.isFinite(ageOk), `非法 collectedAt 时 ageMs 必须为有限 number，实际=${ageOk}`);
    assert.equal(ageOk, 0, 'ok=true 且 collectedAt 非法 → ageMs 回落 0');
    // JSON 序列化不得变 null（NaN→null 的契约违反）
    assert.equal(
      JSON.parse(JSON.stringify({ ageMs: ageOk })).ageMs,
      0,
      'ageMs 不得因 NaN 而序列化为 null',
    );

    // ok=false：非法 collectedAt → 回落到 -1
    const badFail = { warmedAtMs: 0, ok: false, collectedAt: 'garbage' };
    const ageFail = computeAgeMs(badFail, T0);
    assert.ok(Number.isFinite(ageFail), '非法 collectedAt + ok=false 时 ageMs 必须为有限 number');
    assert.equal(ageFail, -1, 'ok=false 且 collectedAt 非法 → ageMs 回落 -1');

    // 多种非法形态（空串以外的各类坏串）
    for (const bad of ['', ' ', 'NaN', 'Infinity', '2026-13-99', 'null']) {
      const cache = { warmedAtMs: 0, ok: true, collectedAt: bad };
      // 空串/空格走「缺失」分支 → ok?0:-1；其余走解析失败分支 → 同样回落
      const v = computeAgeMs(cache, T0);
      assert.ok(Number.isFinite(v), `collectedAt='${bad}' 时 ageMs 必须为有限 number，实际=${v}`);
    }
  });
});

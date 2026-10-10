/**
 * Phase 2 · P2-T2 单元测试：死字段删除族 + 旧键告警显形
 *
 * 背景（phase2-arch-design §1.2 F1 / §6 P2-T2 / §13 PR2）：
 *   - `policy.approvalTimeoutMs`（三处定义：`PolicyConfig` 类型 / `DEFAULT_POLICY` 默认值 /
 *     `mergePolicy` 合并行）全仓**零运行期消费** —— 审批等待的真实 TTL 走 env 旋钮
 *     `WINVM_APPROVAL_TTL_MS`（默认 30 分钟）。120s 默认值语义上还"会在真人反应之前批量误逐"。
 *   - `AgentCard.signature?`（JWS 签名卡）仅剩类型声明、全仓零实现，同批删除。
 *   - 删除属**破坏性契约变更**：旧配置文件仍可解析（`loadServiceConfig` 对 `parsed.policy`
 *     原样透传），但旧键**不得静默失效**（"配了却不生效"假安全感与 ARCH-18 的
 *     `commandAllowlist` 同款病灶）。判据（PR2）：**配置含旧键 ⇒ warnings 恰一条、errors 零条**。
 *
 * 本文件三类断言：
 *   A. 运行面：DEFAULT_POLICY / mergePolicy 输出不再携带被删键；
 *   B. 静态守卫：src 源文本逐字无 `approvalTimeoutMs` / `signature?:`（防回归性重加，
 *      范式对齐 r19b-s5 的「defaults.ts 写表注释一致性」—— 读 src 不经 dist）；
 *   C. 告警显形：`validateServiceConfig` 对旧键恰一条 warning（直构 + `loadServiceConfig`
 *      真实装载路径双入口），默认配置零误报；`endpointAllowlist` 仅核对不误伤（P2-T2 不扩面）。
 *
 * 运行：node --test tests/unit/phase2-dead-config.test.js
 * ⚠ 依赖已重建 dist（`tsc -b tsconfig.build.json`）：旧 dist 仍含三处定义 ⇒ B 类 src 守卫会绿但
 *    A 类「mergePolicy 输出无旧键」经 dist 消费仍可能通过（删除对输出形态无差），故以 B 为准绳、
 *    A 为行为面双保险。
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import {
  DEFAULT_POLICY,
  DEFAULT_SERVICE_CONFIG,
  mergePolicy,
  validateServiceConfig,
  loadServiceConfig,
} from '@winvm/core';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
/** 读源码文本（静态守卫用；不经 dist，避免「测的是编译产物」的间接性 —— 同 r19b-s5 纪律） */
const src = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');

const FIXTURES = join(ROOT, 'tests', 'fixtures', 'phase2-dead-config');
mkdirSync(FIXTURES, { recursive: true });
const tmp = mkdtempSync(join(FIXTURES, 'cfg-'));
after(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结论 */
  }
});

/* ============================================================================
 * A. 运行面：被删键不得再出现在策略表与合并输出
 * ========================================================================== */

describe('P2-T2 · 运行面：策略表无旧键', () => {
  test('DEFAULT_POLICY 不再携带 approvalTimeoutMs（in 与 keys 双查）', () => {
    assert.equal(
      'approvalTimeoutMs' in DEFAULT_POLICY,
      false,
      'DEFAULT_POLICY 仍含 approvalTimeoutMs ⇒ 三处删除未完成',
    );
    assert.equal(
      Object.keys(DEFAULT_POLICY).includes('approvalTimeoutMs'),
      false,
      'Object.keys(DEFAULT_POLICY) 不应含被删键',
    );
  });

  test('mergePolicy 输出无该键 —— 即便 override 硬塞旧键（cast 模拟旧配置透传）', () => {
    const merged = mergePolicy(DEFAULT_POLICY, { approvalTimeoutMs: 60_000 });
    assert.equal(
      'approvalTimeoutMs' in merged,
      false,
      'mergePolicy 不得把旧键透传进合并结果（键集收窄是删除的行为面兑现）',
    );
  });

  test('mergePolicy 其余字段语义不变：defaultMaxRisk 用户优先、数组并集', () => {
    const merged = mergePolicy(DEFAULT_POLICY, {
      defaultMaxRisk: 'L2',
      pathAllowlist: ['Z:\\scratch\\**'],
    });
    assert.equal(merged.defaultMaxRisk, 'L2');
    assert.ok(merged.pathAllowlist.includes('Z:\\scratch\\**'));
    assert.ok(merged.pathAllowlist.includes('%USERPROFILE%\\**'), '默认条目须仍在（并集不减）');
  });

  test('endpointAllowlist 仅核对不扩面：缺席时合并不注入该键', () => {
    const merged = mergePolicy(DEFAULT_POLICY, { defaultMaxRisk: 'L1' });
    assert.equal('endpointAllowlist' in merged, false, '两侧均无 endpointAllowlist ⇒ 合并结果不得凭空注入');
  });
});

/* ============================================================================
 * B. 静态守卫：src 源文本逐字无被删标识符（防回归性重加）
 * ========================================================================== */

describe('P2-T2 · 静态守卫：源文本无残留', () => {
  test('defaults.ts 全文零命中 approvalTimeoutMs（含注释面 —— 注释也是守卫输入）', () => {
    const d = src('packages/core/src/policy/defaults.ts');
    assert.ok(!d.includes('approvalTimeoutMs'), 'defaults.ts 不得再以任何形态（代码/注释）引用该字段名');
  });

  test('a2a.ts 的 AgentCard 不再声明 signature（readonly signature? 逐字消失）', () => {
    const a = src('packages/contracts/src/a2a.ts');
    assert.ok(!/readonly\s+signature\?:/.test(a), 'AgentCard.signature 已删，声明不得回归');
    assert.ok(!a.includes('Ed25519'), 'JWS 签名卡注释随字段一并删除');
  });

  test('除唯一告警点外零命中：packages/*/src 中 approvalTimeoutMs 只允许出现在 config/index.ts', () => {
    // 注释面已归一（server.ts ×2、pending-approvals.ts ×1）⇒ 运行包 src（含注释）应零命中。
    // 唯一合法提及 = validateServiceConfig 的**旧键告警检测器**本身（config/index.ts），
    // 这是兼容面而非消费面：它读的是「键是否在场」，绝不解释键值。
    // docs/changes（Phase1 存档）与 .dev 不在本断言范围（历史叙事不改）。
    const LEGAL = 'packages/core/src/config/index.ts';
    const offenders = [];
    let legalHits = 0;
    for (const pkg of ['core', 'contracts', 'vm-service', 'vm-capabilities', 'host-a2a-bridge']) {
      for (const rel of grepDir(resolve(ROOT, 'packages', pkg, 'src'), 'approvalTimeoutMs')) {
        if (rel === LEGAL) legalHits += 1;
        else offenders.push(rel);
      }
    }
    assert.deepEqual(offenders, [], `死字段引用回归（除告警点外不得有任何命中）：${offenders.join(', ')}`);
    assert.equal(legalHits, 1, `${LEGAL} 应恰一个命中文件（旧键告警检测器）—— 若为 0 说明告警面被删，须同步删本守卫`);
    // 命中必须落在 validateServiceConfig 的旧键检测块内，防止被搬去别处重新变成"消费"
    const cfgSrc = src(LEGAL);
    const idx = cfgSrc.indexOf('approvalTimeoutMs');
    const fnStart = cfgSrc.indexOf('export function validateServiceConfig');
    assert.ok(idx > fnStart && fnStart > 0, 'approvalTimeoutMs 的在场必须限于 validateServiceConfig 内（兼容告警，非读取消费）');
  });

  test('既有运行代码不受影响：WINVM_APPROVAL_TTL_MS 真实旋钮仍在位（删的是死字段，不是 TTL 本体）', () => {
    const server = src('packages/vm-service/src/server.ts');
    assert.match(server, /ttlMs: resolveApprovalTtlMs\(\)/, 'MCP 令牌表 TTL 仍复用既有 env 旋钮');
    assert.match(server, /WINVM_APPROVAL_TTL_MS|resolveApprovalTtlMs/, '真实 TTL 通路不得随死字段一起被删');
  });
});

/** 递归收集 dir 下命中 needle 的 .ts 文件相对路径（静态守卫辅助） */
function grepDir(dir, needle) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e.endsWith('.ts') && readFileSync(p, 'utf8').includes(needle)) {
        out.push(p.slice(ROOT.length + 1));
      }
    }
  };
  walk(dir);
  return out;
}

/* ============================================================================
 * C. 旧键告警显形：validateServiceConfig（PR2 判据「含旧键 ⇒ warn 恰一条」）
 * ========================================================================== */

describe('P2-T2 · 旧键告警显形', () => {
  test('直构：policy.approvalTimeoutMs 在场 ⇒ warnings 恰一条、errors 零条（不拒绝启动）', () => {
    const cfg = {
      ...DEFAULT_SERVICE_CONFIG,
      policy: { approvalTimeoutMs: 120_000 },
    };
    const v = validateServiceConfig(cfg);
    assert.deepEqual(v.errors, [], '旧键只告警，绝不阻断启动（裁决：兼容解析）');
    const hits = v.warnings.filter((w) => w.includes('approvalTimeoutMs'));
    assert.equal(hits.length, 1, `含旧键 ⇒ approvalTimeoutMs 告警须恰一条，实得 ${hits.length} 条：${JSON.stringify(v.warnings)}`);
    assert.match(hits[0], /已随 Phase 2 · P2-T2 删除|已删除/, '文案须明确告知"已删除"而非含糊提示');
    assert.match(hits[0], /WINVM_APPROVAL_TTL_MS/, '文案须指向真实生效旋钮，运维可据此行动');
    assert.match(hits[0], /忽略|不会生效/, '文案须明确该键当前已被忽略（假安全感必须打破）');
  });

  test('值形态不限：approvalTimeoutMs=0 / 字符串 / null 一律显形（键在场即告警，不做值判断）', () => {
    for (const val of [0, '120000', null]) {
      const cfg = { ...DEFAULT_SERVICE_CONFIG, policy: { approvalTimeoutMs: val } };
      const v = validateServiceConfig(cfg);
      assert.equal(
        v.warnings.filter((w) => w.includes('approvalTimeoutMs')).length,
        1,
        `值=${JSON.stringify(val)} 时仍须恰一条告警（"在场即警"，与 mergePolicy 的 ?? 语义彻底脱钩）`,
      );
    }
  });

  test('真实装载路径：loadServiceConfig 读含旧键 JSON ⇒ 旧键透传 ⇒ validate 显形（端到端）', async () => {
    const p = join(tmp, 'legacy.json');
    writeFileSync(
      p,
      JSON.stringify({
        server: { host: '127.0.0.1', port: 18443 },
        policy: { approvalTimeoutMs: 90_000, pathDenylist: ['E:\\secret\\**'] },
      }),
      'utf8',
    );
    const cfg = await loadServiceConfig(p);
    assert.equal('approvalTimeoutMs' in cfg.policy, true, 'loadServiceConfig 对 parsed.policy 原样透传 ⇒ 键必须在场');
    const v = validateServiceConfig(cfg);
    assert.deepEqual(v.errors, []);
    assert.equal(v.warnings.filter((w) => w.includes('approvalTimeoutMs')).length, 1, '端到端旧键告警恰一条');
  });

  test('无误报：DEFAULT_SERVICE_CONFIG（policy 为空段）⇒ 零条 approvalTimeoutMs 告警', () => {
    const v = validateServiceConfig(DEFAULT_SERVICE_CONFIG);
    assert.deepEqual(v.errors, [], '出厂默认必须可启动');
    assert.equal(v.warnings.filter((w) => w.includes('approvalTimeoutMs')).length, 0);
  });

  test('无误伤：policy 仅含其它合法键（含 endpointAllowlist）⇒ 零条旧键告警', () => {
    const cfg = {
      ...DEFAULT_SERVICE_CONFIG,
      policy: { defaultMaxRisk: 'L2', endpointAllowlist: ['http://172.16.100.2:18443'] },
    };
    const v = validateServiceConfig(cfg);
    assert.equal(v.warnings.filter((w) => w.includes('approvalTimeoutMs')).length, 0);
  });

  test('告警通道唯一性：本批新增的旧键告警不落入 errors（errors 语义 = 阻断，旧键 = 兼容告警）', () => {
    const cfg = { ...DEFAULT_SERVICE_CONFIG, policy: { approvalTimeoutMs: 1 } };
    const v = validateServiceConfig(cfg);
    assert.equal(v.errors.length, 0, 'errors 必须零条');
    assert.ok(Array.isArray(v.warnings) && v.warnings.length >= 1);
  });
});

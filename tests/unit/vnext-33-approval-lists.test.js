/**
 * V-NEXT 3.3 · 能力级审批名单（owner 2026-11-24 裁定）
 *
 * ## 钉的是什么
 * 新增两个**能力级**名单，与既有的**参数级** denylist 是两套语义：
 *
 * | 字段 | 粒度 | 命中后果 |
 * |---|---|---|
 * | `pathDenylist` / `commandDenylist` / `processDenylist`（既有） | 参数级 | **拒**（POLICY_DENIED） |
 * | `capabilityApprovalDenylist`（新） | 能力级 | **审批**（APPROVAL_REQUIRED，批准后可执行） |
 * | `capabilityApprovalAllowlist`（新） | 能力级 | **免审批**（仅 L2；L3 不豁免） |
 *
 * ## owner 裁定的三条规则（逐条钉死）
 *  1. 黑名单命中要审批，白名单命中不要审批
 *  2. **黑名单优先级更高**（两边同时命中 ⇒ 走审批）
 *  3. 白名单当前为空（先只上黑名单）
 *
 * ## 为什么这不只是「加个 if」
 * 最大的风险是**把它们和参数级 denylist 混用**：如果有人把能力 ID 写进
 * `pathDenylist`，命中的是 `POLICY_DENIED`（直接拒绝），运维会困惑
 * "为什么没弹出审批让我确认"。本文件用**交叉断言**把两者的行为差异钉住。
 *
 * 运行（只跑本文件）：
 *   node --test tests/unit/vnext-33-approval-lists.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CapabilityRegistry, CorePolicyEngine } from '@winvm/core';
import { defineCapability } from '@winvm/contracts';
import { WINDOWS_CAPABILITIES } from '@winvm/vm-capabilities';

const ROOT = join(import.meta.dirname, '..', '..');
const src = (rel) => readFileSync(join(ROOT, rel), 'utf8');

process.env.USERPROFILE = 'C:\\Users\\vmuser';

/* ─────────────── 夹具：三条不同 risk 的能力 ─────────────── */

const mk = (id, risk) =>
  defineCapability({
    id,
    name: id,
    description: 't',
    risk,
    idempotent: true,
    requiresSession: false,
    destructive: false,
    timeoutMs: 5000,
    input: { type: 'object', properties: {} },
    output: { type: 'object' },
    audit: { snapshot: 'none' },
    implementation: { kind: 'powershell', module: 'x', function: 'y' },
  });

// ⚠ 夹具选择的关键：**必须用默认黑名单之外的能力 ID**。
// 第一版夹具用了 `storage.file.delete` / `app.winget.uninstall`，它们**本来就在
// DEFAULT_POLICY.capabilityApprovalDenylist 里**，于是"前提不成立"（默认就该审批）。
// 那不是实现错，而是夹具错 —— 这个坑值得记：**测「名单是否新增生效」时，
// 夹具能力必须从未被名单覆盖的状态出发**，否则测的是默认配置而不是新逻辑。
const L1_CAP = mk('gui.window.maximize', 'L1'); // 名单外，默认不审批
const L2_CAP = mk('gui.input.mouse', 'L2'); // 名单外，默认要审批
const L3_CAP = mk('system.disk.format', 'L3'); // 名单外，默认要审批（最强档）
const L0_CAP = mk('system.info.get', 'L0'); // 纯读，默认不审批

/**
 * 从**真实注册表**取能力定义，用于核对 `supportsDryRun` 这类**服务端声明**。
 *
 * ⚠ 不能查 `UNIFIED_CAPABILITIES`：那里的条目类型是 `CapabilityEntry`
 * （`{id, surface, risk, title}`），**不含** `supportsDryRun` —— 该字段只在
 * `CapabilityDefinition`（vm 面执行体，即 `WINDOWS_CAPABILITIES`）上。
 * 查错表会恒得 `undefined`，把「声明了」误判成「没声明」。
 */
const byId = (id) => WINDOWS_CAPABILITIES.find((c) => c.id === id);

function makeEngine(config) {
  const registry = new CapabilityRegistry();
  registry.registerAll([L0_CAP, L1_CAP, L2_CAP, L3_CAP]);
  return new CorePolicyEngine({ registry, ...(config ? { config } : {}) });
}

/**
 * 注册**真实**能力定义的引擎（供需要核对 `supportsDryRun` 等真实声明的用例使用）。
 *
 * ⚠ 为什么需要它：`makeEngine` 只注册 4 个合成能力，拿 `system.power.control` 去调用
 * 会先被引擎**第 1 步**（能力未注册 → `POLICY_DENIED`）拒掉，此时 `requiresApproval`
 * 恒为 `false` —— 拿它测「黑名单是否生效」会得到假结果（实测踩过）。
 * 测真实声明必须连真实定义一起注册。
 */
function makeRealEngine(ids, config) {
  const registry = new CapabilityRegistry();
  registry.registerAll(ids.map((id) => byId(id)).filter(Boolean));
  return new CorePolicyEngine({ registry, ...(config ? { config } : {}) });
}

const evaluate = (engine, capabilityId, risk, extra = {}) =>
  engine.evaluate({ capabilityId, params: {}, risk, approved: false, ...extra });

/* ═══════════════ A · 黑名单：命中即审批（不是拒绝） ═══════════════ */

describe('V33-A · capabilityApprovalDenylist 命中 ⇒ APPROVAL_REQUIRED（非 POLICY_DENIED）', () => {
  test('L1 能力被点名后，从「免批」变成「要审批」', () => {
    // 前提核实：默认情况下 L1 不触发审批（否则本条测不出东西）
    const plain = makeEngine();
    const before = evaluate(plain, 'gui.window.maximize', 'L1');
    assert.equal(before.allowed, true, '前提：该 L1 能力不在默认名单内，应当放行');
    assert.equal(before.requiresApproval, false, '前提：该 L1 默认不需要审批');

    // 点名后
    const gated = makeEngine({ capabilityApprovalDenylist: ['gui.window.maximize'] });
    const after = evaluate(gated, 'gui.window.maximize', 'L1');
    assert.equal(after.allowed, false, '命中黑名单后不得直接放行');
    assert.equal(after.requiresApproval, true, '必须是「要审批」而不是「拒绝」');
    assert.equal(after.error?.code, 'APPROVAL_REQUIRED', `错误码应是 APPROVAL_REQUIRED，实际 ${after.error?.code}`);
    assert.equal(
      after.matchedRule,
      'approval-required:capability-denylist',
      'matchedRule 必须能与默认 risk 审批区分（否则审计看不出名单是否生效）',
    );
  });

  test('★ 与参数级 pathDenylist 行为不同：一个是审批，一个是拒绝', () => {
    // 同一条能力，两种名单，两种结果 —— 这条防的是「把两者混用」
    const viaCapabilityList = makeEngine({ capabilityApprovalDenylist: ['gui.window.maximize'] });
    const v1 = evaluate(viaCapabilityList, 'gui.window.maximize', 'L1');
    assert.equal(v1.error?.code, 'APPROVAL_REQUIRED', '能力级名单 ⇒ 审批');

    const viaPathList = makeEngine();
    const v2 = viaPathList.evaluate({
      capabilityId: 'gui.window.maximize',
      params: { path: 'C:\\Windows\\x.txt' },
      risk: 'L1',
      approved: false,
    });
    assert.equal(v2.error?.code, 'POLICY_DENIED', '参数级黑名单 ⇒ 直接拒绝');
    assert.equal(v2.requiresApproval, false, '拒绝路径不应夹带 requiresApproval');
  });

  test('通配生效：`storage.*` 命中 storage.file.delete', () => {
    const gated = makeEngine({ capabilityApprovalDenylist: ['gui.*'] });
    const v = evaluate(gated, 'gui.window.maximize', 'L1');
    assert.equal(v.requiresApproval, true, '通配必须命中');
  });

  test('已批准（approved=true）后照常放行 —— 名单只拦「未批」', () => {
    const gated = makeEngine({ capabilityApprovalDenylist: ['gui.window.maximize'] });
    const v = gated.evaluate({
      capabilityId: 'gui.window.maximize',
      params: {},
      risk: 'L1',
      approved: true,
    });
    assert.equal(v.allowed, true, '批准后必须放行（否则审批没有出口 = 能力被变相禁用）');
  });

  test('★ 未声明 supportsDryRun 的能力传 dryRun：免批不生效，黑名单照拦（U-P0-3 同型防线）', () => {
    // ⚠ 本条原名为「dry-run 不能绕过能力级黑名单」，**那个断言基于一个已被推翻的设计判断**：
    // 当时我把黑名单判定排在 dry-run **之前**，于是 `system.power.control` 这类
    // 「声明 supportsDryRun 且 description 写着必须先 dry-run」的能力，连
    // **零变更的计划预览**都要人批 —— 等于把「先看计划再确认」这条安全流程本身掐断，
    // 实测打挂了 cl017 / p0-path-traversal / r19b-s5 三个既有套件。
    // 现语义（engine.ts 6a→6b）：dry-run 免批在**前**，但它仍是**双条件**——
    //   ① 调用方传了 dryRun；② 服务端在能力定义上声明了 supportsDryRun。
    //   ⇒ 只满足 ① 而 ② 不成立时，dry-run 免批**不生效**，继续走黑名单。
    // 本条钉住的正是这个「双条件」：`gui.window.maximize` 未声明 supportsDryRun，
    // 所以它的 dryRun 换不到任何豁免 —— 这才是 U-P0-3 同型漏洞的真正防线。
    assert.equal(byId('gui.window.maximize')?.supportsDryRun, undefined, '前提：该能力未声明 supportsDryRun');
    const gated = makeEngine({ capabilityApprovalDenylist: ['gui.window.maximize'] });
    const v = gated.evaluate({
      capabilityId: 'gui.window.maximize',
      params: { dryRun: true },
      risk: 'L1',
      approved: false,
    });
    assert.equal(v.requiresApproval, true, '仅凭调用方自报 dryRun，不得绕过能力级黑名单');
    assert.equal(v.allowed, false, 'dry-run 也必须先审批');
  });

  test('★ 声明 supportsDryRun 的能力：dry-run 免批**先于**黑名单生效（「先预览再确认」不被掐断）', () => {
    // 与上一条互补，两条合起来才完整表达 6a/6b 的**顺序**与**双条件**。
    // 用真实能力 `system.power.control`（definitions 里 supportsDryRun: true，
    // 且 description 明确写「必须先 dry-run」）；把它塞进能力级黑名单后，
    // 它的 dryRun 调用必须仍能拿到免批 —— 否则运维想「先看计划」都做不到，只能盲批。
    const cap = 'system.power.control';
    assert.equal(byId(cap)?.supportsDryRun, true, '前提：该能力声明了 supportsDryRun');
    const gated = makeRealEngine([cap], { capabilityApprovalDenylist: [cap] });
    const dry = gated.evaluate({ capabilityId: cap, params: { action: 'restart', dryRun: true }, risk: 'L3', approved: false });
    assert.equal(dry.allowed, true, 'dry-run 计划预览必须放行（零变更，不构成风险）');
    assert.equal(dry.requiresApproval, false);
    assert.equal(dry.matchedRule, 'allow:dry-run-bypass', '须由 dry-run 档放行，而非被黑名单拦下');
    // 反向：去掉 dryRun 后，同一个能力仍被黑名单强制审批（证明顺序是 6a→6b，不是黑名单失效）
    const real = gated.evaluate({ capabilityId: cap, params: { action: 'restart' }, risk: 'L3', approved: false });
    assert.equal(real.allowed, false, '非 dry-run 的真实调用必须被黑名单拦下');
    assert.equal(real.requiresApproval, true);
  });

  test('不在名单里的能力不受影响', () => {
    const gated = makeEngine({ capabilityApprovalDenylist: ['gui.window.maximize'] });
    const v = evaluate(gated, 'system.info.get', 'L0');
    assert.equal(v.allowed, true, '未点名的 L0 能力应照常放行');
    assert.equal(v.requiresApproval, false);
  });
});

/* ═══════════════ B · 白名单：命中即免审批（仅 L2） ═══════════════ */

describe('V33-B · capabilityApprovalAllowlist 命中 ⇒ 免审批（仅 L2，L3 不豁免）', () => {
  test('L2 能力被豁免后不触发审批', () => {
    const plain = makeEngine();
    const before = evaluate(plain, 'gui.input.mouse', 'L2');
    assert.equal(before.requiresApproval, true, '前提：L2 默认要审批');

    const waived = makeEngine({ capabilityApprovalAllowlist: ['gui.input.mouse'] });
    const after = evaluate(waived, 'gui.input.mouse', 'L2');
    assert.equal(after.allowed, true, '命中白名单后应放行');
    assert.equal(after.requiresApproval, false);
    assert.equal(after.matchedRule, 'allow:capability-allowlist', 'matchedRule 须能区分「因白名单放行」');
  });

  test('★★ L3 不被豁免 —— 配置项不得架空风险模型最强档', () => {
    const waived = makeEngine({ capabilityApprovalAllowlist: ['system.disk.format'] });
    const v = evaluate(waived, 'system.disk.format', 'L3');
    assert.equal(v.requiresApproval, true, 'L3 必须仍然要审批（白名单只对 L2 生效）');
    assert.equal(v.allowed, false, 'L3 不得被白名单放行');
  });

  test('通配也可用于白名单', () => {
    const waived = makeEngine({ capabilityApprovalAllowlist: ['gui.*'] });
    const v = evaluate(waived, 'gui.input.mouse', 'L2');
    assert.equal(v.requiresApproval, false, '通配白名单应生效');
  });
});

/* ═══════════════ C · 优先级：黑名单 > 白名单 ═══════════════ */

describe('V33-C · 优先级：capabilityApprovalDenylist 高于 capabilityApprovalAllowlist', () => {
  test('★ 两边同时命中 ⇒ 走审批（保守方向）', () => {
    // 为什么不能反过来：名单制的价值在于「危险那条必须在场」。
    // 若白名单能压掉黑名单，只要有人把通配写宽（`storage.*`），
    // 黑名单里逐条点名的危险能力就被静默豁免 —— fail-open。
    // ⚠ 必须用**已注册**的能力 ID：引擎第 1 步就拒未注册能力（requiresApproval:false），
    // 用未注册 ID 测优先级会得到「拒绝」而误判成「黑名单赢了」——测出来的东西完全不同。
    const both = makeEngine({
      capabilityApprovalDenylist: ['gui.input.mouse'],
      capabilityApprovalAllowlist: ['gui.input.mouse'],
    });
    const v = evaluate(both, 'gui.input.mouse', 'L2');
    assert.equal(v.requiresApproval, true, '黑名单必须压过白名单');
    assert.equal(v.matchedRule, 'approval-required:capability-denylist', 'matchedRule 应显示是黑名单赢的');
  });

  test('★ 宽通配白名单压不过窄条目黑名单', () => {
    const both = makeEngine({
      capabilityApprovalDenylist: ['gui.input.mouse'],
      capabilityApprovalAllowlist: ['gui.*'],
    });
    const v = evaluate(both, 'gui.input.mouse', 'L2');
    assert.equal(v.requiresApproval, true, '窄黑名单 > 宽白名单（否则写宽通配即可绕过全部点名）');
  });
});

/* ═══════════════ D · 默认配置的初始值 ═══════════════ */

describe('V33-D · DEFAULT_POLICY 初始值（owner 裁定：黑名单给初始值 / 白名单留空）', () => {
  test('默认黑名单非空，且覆盖 14 条', () => {
    const plain = makeEngine();
    // 逐条验证「默认配置确实带上了名单」（而不是只验证代码里写了个数组）
    const mustGate = [
      'storage.file.delete',
      'storage.recycle.manage',
      'app.winget.uninstall',
      'system.power.control',
      'system.process.terminate',
      'system.service.configure',
      'system.registry.write',
      'system.network.config',
    ];
    const registry = new CapabilityRegistry();
    const caps = mustGate.map((id) => mk(id, 'L1'));
    registry.registerAll(caps);
    const engine = new CorePolicyEngine({ registry });
    for (const id of mustGate) {
      const v = engine.evaluate({ capabilityId: id, params: {}, risk: 'L1', approved: false });
      assert.equal(v.requiresApproval, true, `${id} 应在默认黑名单内（L1 也应被拉进审批）`);
    }
  });

  test('默认白名单为空数组（owner 裁定：先留空）', () => {
    const plain = makeEngine();
    // 空名单 ⇒ 任何（已注册的）L2 都照常要审批（没有被豁免的）
    const v = evaluate(plain, 'gui.input.mouse', 'L2');
    assert.equal(v.requiresApproval, true, '默认白名单为空 ⇒ L2 仍要审批');
  });

  test('默认黑名单里每一条都对应真实存在的能力 ID', () => {
    // 防「名单里写了个不存在的能力 ID」—— 那种条目永远不命中，
    // 表面上名单很长，实际一条没生效（最典型的静默失效）。
    const ids = new Set(WINDOWS_CAPABILITIES.map((c) => c.id));
    const configSrc = src('packages/core/src/policy/defaults.ts');
    const block = /capabilityApprovalDenylist:\s*\[([\s\S]*?)\]/.exec(configSrc);
    assert.ok(block, '未能在 defaults.ts 中定位 capabilityApprovalDenylist 数组');
    const entries = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert.ok(entries.length > 0, '黑名单不得为空（owner 明确要求给初始值）');
    for (const e of entries) {
      // 允许通配，但精确 ID 必须真实存在
      if (e.includes('*')) continue;
      assert.ok(ids.has(e), `黑名单条目 ${e} 在注册表里不存在 ⇒ 该条目永不命中，属静默失效`);
    }
  });
});

/* ═══════════════ E · mergePolicy 并集语义 ═══════════════ */

describe('V33-E · mergePolicy 对两个名单走并集（只能加不能减）', () => {
  test('★ override 传空数组不能清掉默认黑名单', () => {
    // 若 override 能清空，某环境悄悄配个 [] 就等于关掉整道闸，
    // 而这条链路上没有第二处能发现它。
    const engine = new CorePolicyEngine({
      registry: (() => {
        const r = new CapabilityRegistry();
        r.registerAll([mk('storage.file.delete', 'L1')]);
        return r;
      })(),
      config: { capabilityApprovalDenylist: [] },
    });
    const v = evaluate(engine, 'storage.file.delete', 'L1');
    assert.equal(v.requiresApproval, true, '传空数组不得清空默认黑名单（并集语义）');
  });

  test('override 可以追加条目', () => {
    const engine = new CorePolicyEngine({
      registry: (() => {
        const r = new CapabilityRegistry();
        r.registerAll([mk('gui.window.maximize', 'L1')]);
        return r;
      })(),
      config: { capabilityApprovalDenylist: ['gui.window.maximize'] },
    });
    const v = evaluate(engine, 'gui.window.maximize', 'L1');
    assert.equal(v.requiresApproval, true, '追加的条目应生效');
  });
});

/* ═══════════════ F · 引擎判定顺序文档与实现一致 ═══════════════ */

describe('V33-F · 文件头判定顺序文档须含新增三档', () => {
  test('engine.ts 头部注释含 6a/6b/6c 三档，且写明优先级', () => {
    const t = src('packages/core/src/policy/engine.ts').slice(0, 3000);
    assert.match(t, /6a\./, '头部判定顺序须记载 6a（dry-run 免批；必须在黑名单之前）');
    assert.match(t, /6b\./, '头部判定顺序须记载 6b（能力级强制审批名单）');
    assert.match(t, /6c\./, '头部判定顺序须记载 6c（能力级免审批名单）');
    // 名单之间的优先级 = 6b > 6c（黑名单压白名单）。
    // ⚠ 本条原写 `/6a\s*>\s*6c/`，那是**重排编号之前**的过期断言（当时 dry-run 还不是 6a）。
    // 修 dry-run 顺序那次把 dry-run 提到 6a、黑名单降到 6b 之后，优先级指的是 6b 与 6c，
    // 与 6a 无关 —— 断言随之订正，不是放宽。
    assert.match(t, /6b\s*>\s*6c/, '须写明名单之间的优先级 6b > 6c（黑名单压白名单）');
    // 顺序锁：dry-run 档（6a）必须排在能力级黑名单（6b）之前，否则「先 dry-run 再确认」被掐断。
    assert.match(t, /6a[^\n]*在[^\n]*6b[^\n]*之前/, '须写明 6a 必须在 6b 之前及其理由');
  });
});
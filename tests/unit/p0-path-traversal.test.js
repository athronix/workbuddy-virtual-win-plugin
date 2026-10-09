/**
 * U-P0-1（P0）路径穿越 + U-P0-3（P1高 · A1）dry-run 免批收紧 —— 回归守卫
 *
 * ## 为什么存在（体检原话）
 * - **U-P0-1**：`packages/core/src/policy/engine.ts` 的 `normalizePath()` 只做**浅归一**
 *   （分隔符统一 / 折叠重复分隔符 / 去尾分隔符），**不解析 `.` / `..` 段**。于是
 *   `C:\Users\a\..\..\Windows\System32\evil.dll` 原样透传给 glob：黑名单 `C:\Windows\**`
 *   不匹配（串以 `C:\Users\` 起头），白名单 `C:\Users\**` 匹配 ⇒ **ALLOW**。
 *   主理人已用 dist 引擎实机证实该串在 `appops.cli.invoke` 与 `storage.*` 上双双放行 ——
 *   **一条 `..\` 同时绕过黑名单与白名单**，等价于把整个路径策略面变成可选。
 * - **U-P0-3**：`engine.ts` 审批闸里 `if (req.params['dryRun'] === true) return {allowed:true…}`
 *   —— 该参数是**调用方自报**的，任何 L2/L3 附带 `dryRun:true` 即可跳过人工审批真实执行。
 *   A1 方案把「谁能免批」的权威收回**服务端声明**（`CapabilityDefinition.supportsDryRun`）。
 *
 * ## 本文件的主线
 * ① 归一化正确性（段消解语义、total 性、幂等、UNC 不误伤、设备命名空间透传）；
 * ② 判定后果（穿越串 DENY / 合法白名单路径 ALLOW 不回归 / 命令内嵌穿越 / 无归一旁路）；
 * ③ dry-run A1 双条件守卫（未声明能力传 dryRun → requiresApproval=true）；
 * ④ 免批执行的链上取证位 `ext.bypass='dry-run'`（服务端装饰器）；
 * ⑤ 变异自检（旧浅归一 / 旧单条件在**内存副本**上必须让判据变红）+ 只读自证。
 *
 * 风格参照 `tests/unit/r19c-*.test.js` 与 `tests/unit/assembly-guard.test.js`
 * （`node:test` + `assert/strict`；纯逻辑，不起 HTTP 服务、不 spawn ps-bridge、不落盘）。
 *
 * 运行（**只跑本文件，绝不整批**）：
 *   node --test tests/unit/p0-path-traversal.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CapabilityRegistry,
  CorePolicyEngine,
  DEFAULT_POLICY,
  DRY_RUN_BYPASS_MATCHED_RULE,
  expandPolicyPathPattern,
  extractPathTokens,
  normalizePath,
} from '@winvm/core';
import { POLICY_DRY_RUN_BYPASS_MATCHED_RULE, defineCapability } from '@winvm/contracts';
import { WINDOWS_CAPABILITIES } from '@winvm/vm-capabilities';
import { bypassTagSink } from '@winvm/vm-service';

/* ============================ 夹具 ============================ */

/**
 * ARCH-17（Phase 1 刻意的破坏性收紧）：默认路径白名单从「全体账户」收紧为「当前 VM 用户
 * 目录」，写法是 `%USERPROFILE%\**`，由 `CorePolicyEngine` 在**模式侧**编译时展开。
 * 展开读 `process.env`，而模式表在**构造时**编译 ⇒ 必须在任何 `new CorePolicyEngine(...)`
 * 之前把 `USERPROFILE` 钉成确定值，本文件的结论才在 POSIX 开发机与 Windows 真机上**一致**
 * （不钉则 POSIX 上占位符保持字面 ⇒ 该条永不匹配 ⇒ 所有 Users 路径一律
 * `pathAllowlist:miss`，红的是「夹具前提」而不是「策略行为」——那是噪音，不是证据）。
 *
 * 钉死值 `C:\Users\vmuser` = 本文件的「当前用户」基准，与 §7.4-T2 ② 的判据口径一致：
 *   - `C:\Users\vmuser\**` ⇒ ALLOW（当前用户目录，收紧后仍然放行）
 *   - `C:\Users\other\**` ⇒ DENY(`pathAllowlist:miss`)（跨账户，收紧的靶心）
 * ⚠ 基准一旦钉成**具体用户目录**，本文件所有「Users 树内 ⇒ ALLOW」的既有用例就必须
 *   用该基准账户书写（旧夹具里的 `C:\Users\a` / `alice` 现在都是**跨账户** ⇒ DENY）。
 *   归一方向的判据（「归一是收敛而非收紧」）不受影响 —— 它比对的是**落点是否仍在允许
 *   集合内**，样例换成基准账户后钉的仍是同一件事。
 */
process.env.USERPROFILE = 'C:\\Users\\vmuser';

const REPO = join(import.meta.dirname, '..', '..');
const ENGINE_TS = join(REPO, 'packages', 'core', 'src', 'policy', 'engine.ts');
/** 只读自证基线（§5 变异全部在内存副本上进行） */
const ENGINE_HASH = createHash('sha256').update(readFileSync(ENGINE_TS)).digest('hex');

/** 与 `vm-service/src/server.ts` 同构的生产装配：引擎必须带注册表（A1 第二条件的唯一来源） */
function productionEngine() {
  const registry = new CapabilityRegistry();
  registry.registerAll(WINDOWS_CAPABILITIES);
  return new CorePolicyEngine({ registry });
}

/** 最小能力定义（「显式声明 / 未声明」两态对照用，不依赖真实能力的其它属性） */
function capOf(id, risk, extra = {}) {
  return defineCapability({
    id,
    name: id,
    description: 'fixture',
    risk,
    idempotent: false,
    requiresSession: false,
    destructive: risk !== 'L0',
    timeoutMs: 30_000,
    input: {
      type: 'object',
      properties: { path: { type: 'string' }, command: { type: 'string' }, dryRun: { type: 'boolean' } },
    },
    output: { type: 'object' },
    audit: { snapshot: risk === 'L0' ? 'none' : 'before-after' },
    implementation: { kind: 'powershell', module: 'storage', function: 'Test-Fixture' },
    ...extra,
  });
}

/** 带指定能力集的引擎（声明位两态对照用） */
function engineWith(defs, opts = {}) {
  const registry = new CapabilityRegistry();
  registry.registerAll(defs);
  return new CorePolicyEngine({ registry, ...opts });
}

/** 只取三个可观测判定字段（与 r19b-s5 同款投影，防 deepEqual 因 error 字段抖动） */
const view = (v) => ({ allowed: v.allowed, matchedRule: v.matchedRule, requiresApproval: v.requiresApproval });

/** 主理人实机复现用的那条串（必测） */
const TRAVERSAL = 'C:\\Users\\vmuser\\..\\..\\Windows\\System32\\evil.dll';
const TRAVERSAL_RESOLVED = 'C:\\Windows\\System32\\evil.dll';

/**
 * 本文件使用的全部**逃逸**穿越串（黑名单可见性判据 §2 与变异自检 §5 共用同一集合）。
 *
 * ⚠ 入集合前先算段数（team-lead 裁定第 3 条，本文件曾因此误判一条为红）：
 * `..` 的数量必须**大于**起点目录的深度，才真的越出白名单前缀。
 * 反例 `C:\Users\Public\Documents\..\..\Windows\System32\evil.dll` 只弹两级 ⇒
 * `C:\Users\Windows\System32\evil.dll`，未进入 `C:\Windows\**` 黑名单区 ⇒ 落点是
 * `C:\Users\**` 之下的**字面路径**（真实执行只可能作用于它，不构成跨目录逃逸）。
 * 弹三级（`..\..\..\`）才抵达 `C:\Windows\…` ⇒ 那才是逃逸。
 *
 * ⚠ ARCH-17 收紧后的口径注记（Phase 1）：本集合里那条 `C:\Users\Public\...` 三级弹的
 * 逃逸串结论仍是 DENY，但**命中原因**是黑名单（`pathDenylist`）—— 集合里所有样例的
 * 断言都只依赖黑名单可见性，所以收紧前后方向一致。而「弹两级 ⇒ ALLOW」的对照样例
 * 不能再用 `C:\Users\Windows\…` 形态（收紧后那一串不在白名单内、会变 miss 而非 ALLOW，
 * 那测的是**授权面范围**不是本条要钉的**落点判据**），故 §2 的非逃逸对照改用
 * 「弹两级后确实落在 `%USERPROFILE%`（`C:\Users\vmuser`）之内」的同族形态。
 */
const TRAVERSALS = [
  TRAVERSAL,
  'C:/Users/vmuser/../../Windows/System32/evil.dll',
  'C:\\Users\\vmuser/../../Windows\\System32/evil.dll',
  'C:\\Users\\vmuser\\.\\..\\..\\Windows\\System32\\evil.dll',
  'c:\\USERS\\a\\..\\..\\windows\\SYSTEM32\\evil.dll',
  'C:\\Users\\vmuser\\..\\..\\..\\Windows\\System32\\kernel32.dll',
  'C:\\Users\\Public\\Documents\\..\\..\\..\\Windows\\System32\\evil.dll',
  'C:\\Temp\\x\\..\\..\\Windows\\System32\\evil.dll',
  'C:\\WinVMWorkspace\\out\\..\\..\\Windows\\System32\\evil.dll',
];

/* ==================== 1. normalizePath · win32 resolve 语义段消解 ==================== */

describe('U-P0-1 · normalizePath 段消解语义', () => {
  test('★ 必测串：穿越到 System32 必须收敛为真实目标（使黑名单可见）', () => {
    assert.equal(normalizePath(TRAVERSAL), TRAVERSAL_RESOLVED);
  });

  test('`.` 段与重复分隔符丢弃，`..` 弹栈', () => {
    assert.equal(normalizePath('C:\\Users\\vmuser\\notes.txt'), 'C:\\Users\\vmuser\\notes.txt', '无穿越串不变（不回归）');
    assert.equal(normalizePath('C:\\Users\\vmuser\\.\\notes.txt'), 'C:\\Users\\vmuser\\notes.txt', '`.` 丢弃');
    assert.equal(normalizePath('C:\\Users\\vmuser\\dir\\..\\notes.txt'), 'C:\\Users\\vmuser\\notes.txt', '`..` 弹一层');
    assert.equal(normalizePath('C:\\Users\\vmuser\\..\\..\\Windows\\System32'), 'C:\\Windows\\System32');
    assert.equal(normalizePath('C:\\Users\\vmuser\\..\\..\\..\\Windows'), 'C:\\Windows', '多余 `..` 到根即止，绝不逃到根外');
    assert.equal(normalizePath('C:\\\\Users\\\\a\\\\..\\\\..\\\\Windows'), 'C:\\Windows', '重复分隔符与穿越混用同样消解');
  });

  test('正斜杠 / 混合分隔符 / 尾分隔符形态等价（写法不影响成败）', () => {
    for (const form of [
      'C:/Users/vmuser/../../Windows/System32/evil.dll',
      'C:\\Users/vmuser/../../Windows\\System32/evil.dll',
      'C:/Users\\vmuser\\..\\..\\Windows/System32\\evil.dll',
      'C:\\Users\\vmuser\\..\\..\\Windows\\System32\\evil.dll\\',
    ]) {
      assert.equal(normalizePath(form), TRAVERSAL_RESOLVED, `形态 ${JSON.stringify(form)} 必须收敛到同一串`);
    }
    // 重复分隔符与穿越混用：同样消解（尾段与必测串不同 ⇒ 期望串单独钉，别塞进上面的等值循环）
    assert.equal(normalizePath('C:\\\\Users\\\\a\\\\..\\\\..\\\\Windows'), 'C:\\Windows',
      '重复分隔符不影响消解结论');
    // ⚠ 反例（team-lead 裁定第 1 条）：`dir` 多占一层，两连 `..` 只弹到 `C:\Users`，
    // **不**等价于上面的形态。权威参照 `path.win32.normalize('C:/Users/vmuser/dir/../../Windows/System32/evil.dll')`
    // = `C:\Users\Windows\System32\evil.dll` —— 实现与标准库一致，是**期望串曾写错**。
    // 保留此例的价值：钉死「弹栈不足时绝不越过实际存在的层」（与「多余 `..` 到根即止」是一对镜像语义）。
    assert.equal(
      normalizePath('C:/Users/vmuser/dir/../../Windows/System32/evil.dll'),
      'C:\\Users\\Windows\\System32\\evil.dll',
      '两级 `..` 只弹两级 ⇒ 停在 C:\\Users 下（非逃逸形态，见 §2 非逃逸对照）',
    );
    assert.equal(
      normalizePath('C:/Users/vmuser/dir/../../../Windows/System32/evil.dll'),
      TRAVERSAL_RESOLVED,
      '同一起点补到三级 `..` 才真正逃逸 ⇒ 与必测串收敛一致',
    );
  });

  test('大小写：归一不折叠大小写（NTFS 保留大小写、匹配侧仍不敏感），但穿越照样消解', () => {
    assert.equal(
      normalizePath('c:\\users\\a\\..\\..\\windows\\system32\\evil.dll'),
      'c:\\windows\\system32\\evil.dll',
    );
    const e = productionEngine();
    for (const p of [TRAVERSAL, TRAVERSAL.toLowerCase(), TRAVERSAL.toUpperCase()]) {
      const v = e.evaluate({ capabilityId: 'storage.file.write', params: { path: p }, risk: 'L1', approved: false });
      assert.equal(v.allowed, false, `大小写形态 ${JSON.stringify(p)} 不得改变结论`);
      assert.match(v.matchedRule, /pathDenylist/, '三形态都必须落黑名单（而非白名单）');
    }
  });

  /**
   * 相对形态（team-lead 裁定第 4 条）：本文件的**全部**期望串一律与权威参照
   * `path.win32.normalize()` 对过（见下方每条注释里的算法），因为
   * 「保留 `..`」只发生在**弹无可弹**时，而不是「相对形态一律保留全部 `..`」。
   * 曾有两处把样例与期望配错：
   *   - `Users\a\..\..\Windows`：两连 `..` 先弹掉 `a` 再弹掉 `Users` ⇒ `Windows`（弹尽，不保留）；
   *   - `..\..\Windows\…`：栈从头就空 ⇒ 两个 `..` **都**保留（不是四个）。
   * 判据的正确表达是「**保留的 `..` 个数 = max(0, `..` 总数 − 可弹段数)**」，
   * 下面按这条公式逐条钉死，而不是靠印象写串。
   */
  test('无盘符形态：弹无可弹的 `..` 原样保留（绝不伪造成绝对路径 ⇒ 必然白名单 miss ⇒ 拒）', () => {
    // 弹尽 ⇒ 无 `..` 残留
    assert.equal(normalizePath('Users\\vmuser\\..\\..\\Windows'), 'Windows', '两级 `..` 恰好弹掉 vmuser 与 Users');
    assert.equal(normalizePath('Users\\vmuser\\..\\b'), 'Users\\b', '可弹出的正常弹出（只弹 vmuser，留 Users）');
    assert.equal(normalizePath('a/b/../c'), 'a\\c', '`.` 段与正斜杠同样先统一再消解');
    // 弹无可弹 ⇒ 逐个保留（个数 = `..` 数 − 可弹段数）
    assert.equal(normalizePath('..\\..\\Windows'), '..\\..\\Windows', '栈从头为空 ⇒ 两个 `..` 全保留');
    assert.equal(normalizePath('a\\..\\..\\Windows'), '..\\Windows', '一个 `..` 弹掉 a，另一个保留');
    assert.equal(normalizePath('a.txt'), 'a.txt', '纯文件名不变');
    assert.equal(normalizePath('C:..\\Windows\\System32'), 'C:..\\Windows\\System32', '盘符相对形态保留 `..`');
    assert.equal(
      normalizePath('../../Windows/System32/kernel32.dll'),
      '..\\..\\Windows\\System32\\kernel32.dll',
      'posix 风格相对穿越保留（引擎不知 CWD，绝不编造绝对路径）',
    );
    // 锚定形态与之对照：根之上没有父目录 ⇒ 多余 `..` 丢弃（rooted=true）
    assert.equal(normalizePath('\\Users\\vmuser\\..\\..\\Windows'), '\\Windows', '根相对形态到根即止');
  });

  test('UNC 不误伤：server/share 作为锚点保留，`..` 不得弹出 share 层', () => {
    assert.equal(normalizePath('\\\\server\\share\\x.txt'), '\\\\server\\share\\x.txt', '常规 UNC 不变');
    assert.equal(normalizePath('\\\\server\\share\\a\\..\\b'), '\\\\server\\share\\b');
    assert.equal(normalizePath('\\\\server\\share\\..'), '\\\\server\\share', '锚点之上无父目录，share 不被弹出');
    assert.equal(normalizePath('\\\\server\\share\\a\\..\\..\\..\\b'), '\\\\server\\share\\b', '多余 `..` 到 share 根即止');
    assert.equal(normalizePath('//server/share/../x'), '\\\\server\\share\\x', '正斜杠 UNC 同样识别');
    // 畸形 UNC 不臆造形态（原样返回 ⇒ 由白名单 miss 拒绝，而不是替它编一个「解析后」串）
    assert.equal(normalizePath('\\\\'), '\\\\');
    assert.equal(normalizePath('\\\\onlyserver'), '\\\\onlyserver');
  });

  test('设备命名空间 `\\?\\` / `\\.` 逐字节透传（Windows 对该前缀不做归一）', () => {
    for (const s of ['\\\\?\\C:\\Windows\\a', '\\\\.\\PhysicalDrive0', '\\\\?\\UNC\\server\\share\\x']) {
      assert.equal(normalizePath(s), s, `${s} 必须透传`);
    }
    const e = productionEngine();
    const v = e.evaluate({
      capabilityId: 'storage.file.write',
      params: { path: '\\\\?\\C:\\Users\\vmuser\\x.txt' },
      risk: 'L1',
      approved: false,
    });
    assert.equal(v.allowed, false, '设备命名空间仍被黑名单（`\\\\?\\**`）拒绝');
  });

  test('根路径与空串保留（旧实现「长度 > 3 才去尾分隔符」的根保留语义不回退）', () => {
    assert.equal(normalizePath('C:\\'), 'C:\\', '盘符根保持带分隔符形态');
    assert.equal(normalizePath('C:'), 'C:');
    assert.equal(normalizePath(''), '');
    assert.equal(normalizePath('   '), '', '纯空白 trim 后为空');
    assert.equal(normalizePath('C:\\Users\\'), 'C:\\Users', '非根尾分隔符去掉');
  });

  test('★ total 性：任意输入绝不抛（归一抛错会被上游当「执行失败」而非「拒绝」= 又一个绕过面）', () => {
    const hostile = [
      '',
      ' ',
      '\\',
      '\\\\',
      '\\\\\\\\\\\\\\\\',
      'C:\\',
      'C:\\..',
      ':\\x',
      'C::\\..\\Windows',
      '..\\.',
      '.',
      '\\\\server\\share\\..\\..\\..',
      '\\\\?\\',
      '\\\\.\\',
      'C:\\Users\\vmuser\\' + Array(40).fill('..').join('\\') + '\\Windows',
      '\u0000\u0001\\..\\x',
      'C:\\Users\\vmuser\\..\\',
      '....\\....\\Windows',
    ];
    for (const s of hostile) {
      let once;
      assert.doesNotThrow(() => {
        once = normalizePath(s);
      }, `归一抛异常（输入 ${JSON.stringify(s)}）= 新的绕过面`);
      assert.equal(typeof once, 'string', `返回值必须是字符串（${JSON.stringify(s)}）`);
      // 幂等：归一一次后无可再解（二次归一绝不再改变形态 ⇒ 两侧比对不可能形态漂移）
      assert.equal(normalizePath(once), once, `归一必须幂等：${JSON.stringify(s)} → ${JSON.stringify(once)}`);
    }
  });

  test('穿越串归一后一律不再以白名单前缀起头（黑名单可见性的充分条件）', () => {
    // ⚠ 大小写旗标（team-lead 裁定第 2 条）：本文件的语义是「归一**不**折叠大小写
    // （NTFS 保留大小写，不敏感比对发生在匹配侧 globToRegex，见上一条用例）」，
    // 因此 `c:\USERS\a\..\..\windows\SYSTEM32\…` 归一后是 `c:\windows\SYSTEM32\…`。
    // 这里断言的是**逃逸事实**（收敛到系统目录、脱离 Users 前缀），与字母大小写无关 ⇒
    // 判据必须大小写不敏感，否则等于把「归一保留大小写」误读成「判定也区分大小写」。
    for (const p of TRAVERSALS) {
      const n = normalizePath(p);
      assert.ok(!/^C:\\Users\\/i.test(n), `归一结果 ${n} 仍以白名单前缀 C:\\Users\\ 起头`);
      assert.match(n, /^C:\\Windows\\/i, `穿越串 ${JSON.stringify(p)} 应收敛到 C:\\Windows\\…`);
    }
  });
});

/* ==================== 2. 判定后果：穿越串 DENY、合法路径 ALLOW 不回归 ==================== */

describe('U-P0-1 · 策略判定：穿越串必须 DENY（黑白名单先归一后匹配）', () => {
  const engine = productionEngine();

  /**
   * 实机复现的能力集：主理人用 dist 引擎证实穿越串在 `appops.cli.invoke`（L1）
   * 与 `storage.file.delete` / `storage.file.write` 上双双 ALLOW。
   * 这里逐能力断言 DENY —— 修复必须对**所有**带路径参数的能力一致生效，
   * 不允许「某条能力另有旁路」的不对称（体检原话：等价于把路径策略面变成可选）。
   */
  const CAPS = [
    'appops.cli.invoke',
    'appops.workflow.run',
    'appops.com.automate',
    'storage.file.write',
    'storage.file.delete',
    'storage.file.move',
    'storage.file.copy',
    'storage.dir.manage',
    'storage.link.manage',
    'app.shortcut.manage',
  ];

  for (const capabilityId of CAPS) {
    for (const [paramKey, value] of [
      ['path', TRAVERSAL],
      ['destination', TRAVERSAL],
      ['outputPath', TRAVERSAL],
      ['target', TRAVERSAL],
    ]) {
      test(`${capabilityId} 的 ${paramKey} 为穿越串 → DENY（${JSON.stringify(value).slice(0, 42)}…）`, () => {
        const v = engine.evaluate({
          capabilityId,
          params: { [paramKey]: value, content: 'x', destination: TRAVERSAL },
          risk: 'L1',
          approved: false,
        });
        assert.equal(v.allowed, false, `${capabilityId} 在 ${paramKey} 穿越串上不得放行`);
        assert.equal(v.requiresApproval, false, '穿越是**硬拒绝**，不是「等审批」');
        assert.match(v.matchedRule, /pathDenylist/, `应命中黑名单，实得 ${v.matchedRule}`);
        assert.equal(v.error?.code, 'POLICY_DENIED');
      });
    }
  }

  test('穿越形态全集（正/反斜杠、混合、`.`、大小写、多层）一律 DENY', () => {
    for (const p of TRAVERSALS) {
      const v = engine.evaluate({
        capabilityId: 'storage.file.write',
        params: { path: p, content: 'x' },
        risk: 'L1',
        approved: false,
      });
      assert.equal(v.allowed, false, `穿越串 ${JSON.stringify(p)} 必须 DENY，实得 ${v.matchedRule}`);
      assert.match(v.matchedRule, /pathDenylist/, `${JSON.stringify(p)} 应命中黑名单，实得 ${v.matchedRule}`);
    }
  });

  /**
   * ★ 非逃逸对照（team-lead 裁定第 3 条）：**归一 ≠ 放行**，同样也 **≠ 收紧到越界**。
   *
   * `C:\Users\vmuser\Documents\Reports\..\..\notes.txt` 两连 `..` 只弹到
   * `C:\Users\vmuser\notes.txt` ⇒ **仍在白名单之内**（收紧后的当前用户目录）、
   * 没进 `C:\Windows\**` 黑名单区。**ALLOW 才是正确结论**：
   * 归一后真实落点确实在允许目录之下，执行它不构成跨目录逃逸；
   * 若为了「看着像穿越」就一律拒，等于把归一变成保守性收紧，会误杀
   * 大量合法等价写法（`.\` 段、冗余分隔符，见下一条用例）。
   *
   * 这条对照的价值：把「收紧穿越」与「误杀合法」的分界**写成可执行判据** ——
   * 分界只取决于**归一后的实际落点**，不取决于字面里有没有 `..`。
   *
   * ⚠ 样例基准自 ARCH-17 起改用 `%USERPROFILE%` 的实际值（`C:\Users\vmuser`，见文件头夹具）：
   *   旧样例落在 `C:\Users\Windows\…`，在「全体账户」白名单下是 ALLOW；收紧后那一串
   *   **既不在本用户目录也不在 Public** ⇒ 会被判 miss。结论的变化来自**白名单范围**
   *   而不是归一语义，所以样例换成「落点确实在允许目录内」的形态，本条对照才能继续
   *   钉它原本要钉的东西（落点判据），而不是顺带钉住一个已改口的授权面。
   */
  test('非逃逸的 `..` 写法（归一后仍在白名单内）→ ALLOW：判据只看落点，不看字面有无 `..`', () => {
    for (const p of [
      'C:\\Users\\vmuser\\Documents\\Reports\\..\\..\\notes.txt',
      'C:/Users/vmuser/Documents/Reports/../../notes.txt',
    ]) {
      assert.equal(normalizePath(p), 'C:\\Users\\vmuser\\notes.txt', '样例前提：落点在本用户目录之下');
      const v = engine.evaluate({
        capabilityId: 'storage.file.write',
        params: { path: p, content: 'x' },
        risk: 'L1',
        approved: false,
      });
      assert.equal(v.allowed, true, `非逃逸等价写法被误杀：${v.matchedRule} / ${v.error?.message ?? ''}`);
      assert.equal(v.matchedRule, 'allow:policy-passed');
    }
    // 同一字面补到四级 `..`（弹穿 vmuser 与 Users）即真正逃逸进系统目录 ⇒ 必须 DENY。
    // 二者只差一层，说明判定确实跟着**落点**走，而不是跟着某条串的「长相」走。
    const v = engine.evaluate({
      capabilityId: 'storage.file.write',
      params: { path: 'C:\\Users\\vmuser\\Documents\\Reports\\..\\..\\..\\..\\Windows\\System32\\evil.dll', content: 'x' },
      risk: 'L1',
      approved: false,
    });
    assert.equal(v.allowed, false, '补到四级 `..` 后必须 DENY（否则落点判据是假的）');
    assert.match(v.matchedRule, /pathDenylist/);
  });

  /**
   * ★ ARCH-17 新判据（Phase 1 刻意的破坏性收紧，设计 §7.4-T2 ②）：
   * **跨账户**读写在策略层恒 DENY，本用户目录与显式共享目录照旧 ALLOW。
   *
   * 为什么这条必须钉成可执行判据：收紧前 `C:\Users\**` 覆盖全体账户，而
   * `storage.file.read` 是 **L0 免审批** —— 别人的桌面/下载在策略层是**直接可读**的，
   * 且没有任何一处代码会说「这里越界了」。收紧后越界变成硬 DENY（`pathAllowlist:miss`
   * 发生在审批闸**之前** ⇒ 不是「转人工审批」，是拒绝），本条把这一改变钉住：
   * 若有人把默认值改回 `C:\Users\**` 或删掉 `%USERPROFILE%` 条目，这里立刻变红。
   */
  test('★ ARCH-17：跨账户目录 DENY(pathAllowlist:miss)，本用户目录与 Public 共享区 ALLOW', () => {
    const crossAccount = [
      'C:\\Users\\other\\x.txt',
      'C:\\Users\\other\\Desktop\\合同.pdf',
      'C:\\Users\\Administrator\\ntds.dit',
      // Users 根本身不再整体开放（旧 `C:\Users\**` 会命中它）
      'C:\\Users',
    ];
    for (const p of crossAccount) {
      const v = engine.evaluate({
        capabilityId: 'storage.file.read',
        params: { path: p },
        risk: 'L0',
        approved: false,
      });
      assert.equal(v.allowed, false, `跨账户 ${p} 必须 DENY（收紧未生效？）`);
      assert.equal(v.matchedRule, 'pathAllowlist:miss', `${p} 应落白名单 miss，实得 ${v.matchedRule}`);
      assert.equal(v.requiresApproval, false, 'miss 是硬拒绝，不得转「等审批」（那等于保留执行机会）');
    }
    for (const p of ['C:\\Users\\vmuser\\x.txt', 'C:\\Users\\Public\\drop.pdf']) {
      const v = engine.evaluate({
        capabilityId: 'storage.file.read',
        params: { path: p },
        risk: 'L0',
        approved: false,
      });
      assert.equal(v.allowed, true, `允许目录 ${p} 被误杀：${v.matchedRule}`);
    }
  });

  /**
   * ★ ARCH-17：模式侧展开是**纯函数**，可脱离真实 env 直测（设计 §7.4-T2 ② 的离线口径）。
   *
   * 三条各自钉一个必要语义：
   *  - 展开**生效**（否则 `%USERPROFILE%\**` 当字面进 glob ⇒ 恒不匹配 ⇒ 一刀封死）；
   *  - **先展开后归一**（`%USERPROFILE%\.\x` 里的 `.` 段是被消解掉的，而不是留在字面上）；
   *  - 占位符**未命中时原样保留**（`expandEnvPath` 不吞空串）⇒ 未知 env 写进策略表不会
   *    误扩权限，而是退化成一条匹配不上任何真实路径的字面模式（fail-closed）。
   */
  test('★ ARCH-17：expandPolicyPathPattern 先展开后归一；未知占位符原样保留（fail-closed）', () => {
    assert.equal(
      expandPolicyPathPattern('%USERPROFILE%\\**', { USERPROFILE: 'C:\\Users\\bob' }),
      'C:\\Users\\bob\\**',
    );
    assert.equal(
      expandPolicyPathPattern('%USERPROFILE%\\.\\x', { USERPROFILE: 'C:\\Users\\bob' }),
      'C:\\Users\\bob\\x',
      '展开出来的值必须继续过同一条归一通路',
    );
    assert.equal(
      expandPolicyPathPattern('%USERPROFILE%\\..\\Windows', { USERPROFILE: 'C:\\Users\\bob' }),
      'C:\\Users\\Windows',
      '展开后必须再过段消解才谈得上「落点」。期望串按权威参照 `path.win32.normalize(' +
        "'C:\\\\Users\\\\bob\\\\..\\\\Windows\")` = `C:\\\\Users\\\\Windows`：" +
        '`bob` 只被一个 `..` 弹掉，`Users` 仍在（本文件 §1 早已钉死「弹栈不足时绝不越过实际存在的层」，' +
        '写这条期望时别顺手多弹一层）。反过来若先归一再展开，`%USERPROFILE%` 当字面段被弹出 ⇒ ' +
        '得到 `\\Windows` 的错落点，顺序判据才成立。',
    );
    // 顺序判据：**先归一再展开**会得到完全不同的（错）落点 —— 占位符被当成一个可弹的段。
    // 正向通路见上；反向通路的产物 `Windows` 是一条相对串，落白名单必 miss ⇒ 默认表项失效。
    const wrongOrder = normalizePath('%USERPROFILE%\\..\\Windows');
    assert.equal(
      wrongOrder,
      'Windows',
      '前提校验：先归一时 `%USERPROFILE%` 被 `..` 弹出（这正是「先展开后归一」必须成立的原因）',
    );
    const unknown = expandPolicyPathPattern('%WINVM_NO_SUCH_VAR%\\x', {});
    assert.ok(unknown.includes('%WINVM_NO_SUCH_VAR%'), `未知占位符必须保持字面（绝不吞成空串、也不展开成别人的目录），实得 ${unknown}`);
    assert.equal(expandPolicyPathPattern('C:\\Temp\\**', {}), 'C:\\Temp\\**', '无占位符表项不受影响');
  });

  /**
   * ★ ARCH-17 附带缺陷修复（必须写进交付说明的证据点，设计 §1.5-2）：
   * `appops.cli.invoke` 的**能力级**白名单里写着 `%USERPROFILE%\WinVMWorkspace\out`，
   * 旧实现模式侧不展开 ⇒ 该条**恒不匹配**。此前它被默认表的 `C:\Users\**` 兜住所以没显形；
   * 收紧默认表之后，若模式侧展开不同时到位，合法生产目录会**被误拒** ——
   * 即「收紧默认值」与「模式侧展开」是同一批的成对动作，缺一半就是事故。
   */
  test('★ ARCH-17：能力级 pathAllowlist 里的 %USERPROFILE% 能匹配（appops.cli.invoke outputDir）', () => {
    const cap = capOf('appops.cli.invoke', 'L1', {
      policy: { pathAllowlist: ['%USERPROFILE%\\WinVMWorkspace\\out', 'C:\\WinVMWorkspace\\out'] },
    });
    const e = engineWith([cap]);
    const v = e.evaluate({
      capabilityId: 'appops.cli.invoke',
      params: { app: 'node', command: 'node build.js', outputDir: 'C:\\Users\\vmuser\\WinVMWorkspace\\out' },
      risk: 'L1',
      approved: false,
      capabilityPolicy: cap.policy,
    });
    assert.equal(v.allowed, true, `能力级 %USERPROFILE% 未展开会误杀：${v.matchedRule} / ${v.error?.message ?? ''}`);
    const deny = e.evaluate({
      capabilityId: 'appops.cli.invoke',
      params: { app: 'node', command: 'node build.js', outputDir: 'C:\\Users\\other\\WinVMWorkspace\\out' },
      risk: 'L1',
      approved: false,
      capabilityPolicy: cap.policy,
    });
    assert.equal(deny.allowed, false, '跨账户 outputDir 必须 DENY');
    assert.equal(deny.matchedRule, 'pathAllowlist:miss');
  });


  test('命令参数内嵌穿越同样 DENY（extractPathTokens 之后仍走同一条归一通路）', () => {
    for (const v of [
      engine.evaluate({
        capabilityId: 'appops.cli.invoke',
        params: { app: 'custom', command: `Remove-Item ${TRAVERSAL} -Force` },
        risk: 'L1',
        approved: false,
      }),
      engine.evaluate({
        capabilityId: 'appops.cli.invoke',
        params: { app: 'node', command: 'node C:/Users/vmuser/../../Windows/System32/evil.js' },
        risk: 'L1',
        approved: false,
      }),
    ]) {
      assert.equal(v.allowed, false, `命令内嵌穿越必须 DENY，实得 ${v.matchedRule}`);
      assert.match(v.matchedRule, /pathDenylist/);
    }
  });

  /**
   * ★★ 采集层（team-lead 裁定第 5 条 → **实现遗漏**，非断言错误）
   *
   * 查明根因：`extractPathTokens` 的盘符正则原本是 `/(?<![A-Za-z0-9_])[A-Za-z]:\\…/` ——
   * 冒号后**硬编码反斜杠**。于是命令串里的 `C:/Users/vmuser/../../Windows/System32/evil.js`
   * 一个 token 都提不出来（实测 `extractPathTokens('node C:/Users/vmuser/…') === []`），
   * **根本不会进入**文件系统策略通路 ⇒ 与 `normalizePath` 是否修好无关，是纯粹的第二处绕过面。
   * 这条与 U-P0-1 属同一缺陷族：**写法决定成败**（S-1 当年修的伪盘符也是这一族）。
   * 参数通路已经正确（`params.path` 传正斜杠串会被拒），命令通路却失效 ——
   * 正是「不允许某条通路另有旁路」的不对称。已改实现为 `[A-Za-z]:[\\/]`（见 engine.ts）。
   *
   * 本用例从**采集层**钉死，而不只看最终 verdict：
   * 若有人把正则改回只认反斜杠，verdict 断言仍会因为另一条样例（反斜杠形态）而部分通过，
   * 但这里的 token 断言会**立刻**指出「正斜杠盘符根本没被采集」。
   */
  test('★ 采集层：命令串内嵌的正斜杠盘符路径必须被提取（否则整条命令不进策略视野）', () => {
    const fwd = 'node C:/Users/vmuser/../../Windows/System32/evil.js';
    assert.deepEqual(extractPathTokens(fwd), ['C:/Users/vmuser/../../Windows/System32/evil.js'], '正斜杠盘符漏采 = 命令通路绕过面');
    // 反斜杠形态（原实现即可采到）——两形态都必须进同一通路
    assert.deepEqual(
      extractPathTokens(`Remove-Item ${TRAVERSAL} -Force`),
      [TRAVERSAL],
      '反斜杠盘符采集不回归',
    );
    // S-1 既有纪律不回归：scheme / 前邻字母 / 注册表根键都不得被误采成盘符
    for (const [cmd, expect] of [
      ['curl https://example.com/a/b', []],
      ['AbC:\\Temp\\x', []],
      ['HKLM:/SOFTWARE/X', []],
    ]) {
      assert.deepEqual(extractPathTokens(cmd), expect, `${JSON.stringify(cmd)} 不得产出伪盘符 token`);
    }
    // 端到端：正斜杠内嵌穿越 DENY（反斜杠那条已在上一条用例覆盖）
    const v = engine.evaluate({
      capabilityId: 'appops.cli.invoke',
      params: { app: 'node', command: fwd },
      risk: 'L1',
      approved: false,
    });
    assert.equal(v.allowed, false, `正斜杠内嵌穿越必须 DENY，实得 ${v.matchedRule}`);
    assert.match(v.matchedRule, /pathDenylist/);
  });

  test('相对形态的 posix 穿越：白名单必然 miss（不被伪造成绝对路径后放行）', () => {
    const v = engine.evaluate({
      capabilityId: 'storage.file.write',
      params: { path: '../../../../Windows/System32/evil.dll', content: 'x' },
      risk: 'L1',
      approved: false,
    });
    assert.equal(v.allowed, false);
    assert.match(v.matchedRule, /pathAllowlist:miss|pathDenylist/, '相对穿越走 miss 或黑名单，绝不放行');
  });

  test('★ 不回归：合法白名单路径仍 ALLOW（收紧穿越不得顺手误杀正常调用）', () => {
    // ARCH-17 收紧后的合法集 = 「当前用户目录（`%USERPROFILE%` 实际值）+ 其余显式条目」，
    // 不再是「`C:\Users\**` 全体账户」。故本用例的样例按新口径书写：`alice` 已不再是
    // 「默认就 ALLOW」的账户（它现在是跨账户 ⇒ DENY，见 §2 的跨账户新判据）。
    const legal = [
      'C:\\Users\\vmuser\\notes.txt',
      'C:\\Users\\vmuser\\Documents\\x.docx',
      'C:\\Users\\Public\\shared\\x.txt',
      'C:\\Temp\\build\\out.log',
      'C:\\WinVMWorkspace\\out\\report.pdf',
      'D:\\Data\\proj\\src\\main.ts',
      'C:\\Users\\vmuser',
      'C:\\WinVMWorkspace',
    ];
    for (const p of legal) {
      const v = engine.evaluate({
        capabilityId: 'storage.file.write',
        params: { path: p, content: 'x' },
        risk: 'L1',
        approved: false,
      });
      assert.equal(v.allowed, true, `合法路径 ${p} 被误杀：${v.matchedRule} / ${v.error?.message ?? ''}`);
      assert.equal(v.matchedRule, 'allow:policy-passed');
    }
  });

  test('合法路径的 `.` / 冗余分隔符等价写法同样 ALLOW（归一是收敛而非收紧）', () => {
    for (const p of [
      'C:\\Users\\vmuser\\notes.txt',
      'C:\\Users\\vmuser\\.\\notes.txt',
      'C:\\Users\\vmuser\\dir\\..\\notes.txt',
      'C:/Users/vmuser/notes.txt',
      'C:\\\\Users\\\\vmuser\\\\notes.txt',
    ]) {
      const v = engine.evaluate({
        capabilityId: 'storage.file.write',
        params: { path: p, content: 'x' },
        risk: 'L1',
        approved: false,
      });
      assert.equal(v.allowed, true, `等价写法 ${JSON.stringify(p)} 必须与规范形态同结论：${v.matchedRule}`);
    }
  });

  test('黑名单原生命中形态不回归（Program Files / ProgramData / Recovery）', () => {
    for (const p of [
      'C:\\Program Files\\App\\x.dll',
      'C:\\Program Files (x86)\\App\\x.dll',
      'C:\\ProgramData\\x',
      'C:\\Recovery\\x',
      'C:\\Windows\\System32\\drivers\\etc\\hosts',
    ]) {
      const v = engine.evaluate({ capabilityId: 'storage.file.write', params: { path: p }, risk: 'L1', approved: false });
      assert.equal(v.allowed, false, `${p} 必须仍被黑名单拒绝`);
      assert.match(v.matchedRule, /pathDenylist/);
    }
  });

  test('★ 无归一旁路：engine 内全部文件系统比对都经 normalizePath（静态守卫）', () => {
    // 判据：evaluate 里凡「文件系统」路径比对都取 `normalizePath(candidate)`；
    // 若出现「未归一直接 globToRegex(pattern) 并 test(原始串)」的旁路，本断言变红。
    const src = readFileSync(ENGINE_TS, 'utf8');
    const problems = auditNormalizationBypass(src);
    assert.deepEqual(problems, [], '路径归一存在被绕过的比对点');
  });

  test('白名单/黑名单**模式侧**同样先归一（两侧同一通路，防表内混入 `.`/`..` 形态）', () => {
    // 表项含 `.\` 与重复分隔符时仍须与规范表项等价（旧实现只归一入参侧）
    const e = new CorePolicyEngine({
      config: { pathAllowlist: ['C:\\Users\\vmuser\\.\\**'], pathDenylist: ['C:\\Windows\\**'] },
      disablePathAllowlist: false,
    });
    const v = e.evaluate({
      capabilityId: 'storage.file.write',
      params: { path: 'C:\\Users\\vmuser\\x.txt' },
      risk: 'L1',
      approved: false,
    });
    assert.equal(v.allowed, true, `模式侧未归一会误杀：${v.matchedRule} / ${v.error?.message ?? ''}`);
  });

  /**
   * 注册表域：**行为与基线一致**（team-lead 裁定第 6 条 · 范围声明）
   *
   * 本用例的语义是「U-P0-1 的改动**不得**波及注册表通路」，不是「注册表也做了段消解」。
   * 两条通路本来就不同源：文件系统走 `normalizePath`（本任务新增段消解），
   * 注册表走 `canonicalRegistryPath`（只做根键别名收敛 + 冒号形态补齐，**从来不做** `.`/`..` 消解）。
   *
   * ⚠ 由此暴露的**相邻风险（已实测、本任务范围外、上报待裁）**：
   * `HKLM:\SOFTWARE\..\SAM` 这类串在注册表域按**字面前缀**匹配
   * `registryReadAllowlist` 的 `HKLM:\SOFTWARE\**` ⇒ 判 **ALLOW**（HEAD 基线同样 ALLOW，
   * 非本次改动引入）。若注册表也套用段消解，落点会越出 SOFTWARE 前缀 ⇒ 必然 miss 而拒。
   * 这是与 U-P0-1 同族但**属另一策略面**的问题：扩大范围需改 `canonicalRegistryPath`
   * 语义并连带核验 S-1 契约（`r19b-s1-registry-forms.test.js` 钉死的根键别名/伪盘符纪律），
   * 故本任务**不动实现**，只把事实钉成可执行记录，交由主理人决定是否立 U-P0-1b。
   */
  test('注册表域与基线一致：不经 normalizePath（本任务改动零波及）', () => {
    const e = productionEngine();
    // 1) 结构性判据：注册表通路的归一函数里没有段消解（若被并入 normalizePath 语义，本条变红）
    const regSrc = readFileSync(ENGINE_TS, 'utf8');
    const kernel = /export function canonicalRegistryPath\([\s\S]*?\n\}/.exec(regSrc);
    assert.ok(kernel, 'canonicalRegistryPath 缺席（守卫锚点漂移）');
    assert.ok(!/foldSegList|foldWin32Segments|normalizePath/.test(kernel[0]), '注册表归一被并入文件系统段消解 = 本任务范围扩大，须重新裁定');

    // 2) 判定基线：应拒的仍拒（HKU 不在 4 条别名表内 ⇒ 绝不因归一被铸造合法形态）
    for (const p of ['HKU:\\S-1-5-21', 'HKCR:\\Applications\\x', 'HKLM:\\SAM\\SAM']) {
      const v = e.evaluate({ capabilityId: 'system.registry.read', params: { path: p }, risk: 'L0', approved: false });
      assert.equal(v.allowed, false, `${p} 必须被拒`);
      assert.match(v.matchedRule, /registryReadAllowlist:miss/, `应落注册表域，实得 ${v.matchedRule}`);
    }

    // 3) 判定基线：`..\` 在注册表串里**不改变**结论（与 HEAD 一致 —— 该域从未做消解）。
    //    两条串的结论必须相同：若哪天注册表也做消解而白名单未同步，本条会显形。
    const withDotDot = e.evaluate({
      capabilityId: 'system.registry.read',
      params: { path: 'HKLM:\\SOFTWARE\\..\\SOFTWARE\\CurrentControlSet' },
      risk: 'L0',
      approved: false,
    });
    const plain = e.evaluate({
      capabilityId: 'system.registry.read',
      params: { path: 'HKLM:\\SOFTWARE\\CurrentControlSet' },
      risk: 'L0',
      approved: false,
    });
    assert.equal(withDotDot.allowed, plain.allowed, '注册表域结论不得因 `..` 写法而分叉（当前域不做消解 ⇒ 两态一致）');
    assert.equal(withDotDot.allowed, true, '前提校验：SOFTWARE 前缀白名单命中（与 HEAD 基线一致）');

    // 4) 命令串里的注册表 token 仍被交回注册表域，绝不误撞文件系统白名单（S-1 纪律不回归）
    const v = e.evaluate({
      capabilityId: 'appops.cli.invoke',
      params: { app: 'custom', command: 'Get-ItemProperty HKLM:\\SOFTWARE\\Microsoft' },
      risk: 'L1',
      approved: false,
    });
    assert.equal(v.allowed, true, `S-1 回归：${v.matchedRule} / ${v.error?.message ?? ''}`);
    assert.ok(!/pathAllowlist|pathDenylist/.test(v.matchedRule), '注册表 token 绝不落到文件系统域');
  });

  test('DEFAULT_POLICY 表项归一后不变（归一不得改变默认基线的表意）', () => {
    for (const p of [...DEFAULT_POLICY.pathAllowlist, ...DEFAULT_POLICY.pathDenylist]) {
      assert.equal(normalizePath(p), p, `默认表项 ${JSON.stringify(p)} 归一后漂移 ⇒ 匹配语义被改写`);
    }
  });
});

/* ==================== 3. U-P0-3 · dry-run 免批 A1（服务端能力声明制） ==================== */

describe('U-P0-3 · dry-run 免批必须是双条件（服务端声明 + 调用方 dryRun）', () => {
  const DECLARED = capOf('storage.file.write', 'L2', { supportsDryRun: true });
  const UNDECLARED = capOf('storage.link.manage', 'L2');

  test('★ 未声明 supportsDryRun 的 L2 能力传 dryRun → requiresApproval=true（回落审批闸）', () => {
    const e = engineWith([UNDECLARED]);
    const v = e.evaluate({
      capabilityId: 'storage.link.manage',
      params: { path: 'C:\\Users\\vmuser\\x', target: 'C:\\Users\\vmuser\\y', dryRun: true },
      risk: 'L2',
      approved: false,
    });
    assert.deepEqual(view(v), {
      allowed: false,
      matchedRule: 'approval-required',
      requiresApproval: true,
    }, '仅凭调用方自报 dryRun 绝不再免批');
    assert.equal(v.error?.code, 'APPROVAL_REQUIRED');
    assert.equal(v.error?.retryable, true, '审批闸语义保持可重试（合法 dryRun 链路不受影响）');
  });

  test('已声明 supportsDryRun 的能力传 dryRun → 免批放行（合法链路不回归）', () => {
    const e = engineWith([DECLARED]);
    const v = e.evaluate({
      capabilityId: 'storage.file.write',
      params: { path: 'C:\\Users\\vmuser\\x.txt', content: 'y', dryRun: true },
      risk: 'L2',
      approved: false,
    });
    assert.deepEqual(view(v), { allowed: true, matchedRule: 'allow:dry-run-bypass', requiresApproval: false });
  });

  test('已声明但**未传** dryRun → 仍走审批闸（声明位本身不授予放行）', () => {
    const e = engineWith([DECLARED]);
    const v = e.evaluate({
      capabilityId: 'storage.file.write',
      params: { path: 'C:\\Users\\vmuser\\x.txt', content: 'y' },
      risk: 'L2',
      approved: false,
    });
    assert.deepEqual(view(v), { allowed: false, matchedRule: 'approval-required', requiresApproval: true });
  });

  test('dryRun=false / 非布尔（字符串 "true"）→ 不免批（严格等值判定不放松）', () => {
    const e = engineWith([DECLARED]);
    for (const dryRun of [false, 'true', 1, undefined, null]) {
      const v = e.evaluate({
        capabilityId: 'storage.file.write',
        params: { path: 'C:\\Users\\vmuser\\x.txt', content: 'y', dryRun },
        risk: 'L2',
        approved: false,
      });
      assert.equal(v.allowed, false, `dryRun=${JSON.stringify(dryRun)} 不得免批`);
      assert.equal(v.requiresApproval, true);
    }
  });

  test('supportsDryRun=false 显式声明 → 不免批（只有 === true 才有效）', () => {
    const e = engineWith([capOf('storage.link.manage', 'L2', { supportsDryRun: false })]);
    const v = e.evaluate({
      capabilityId: 'storage.link.manage',
      params: { path: 'C:\\Users\\vmuser\\x', dryRun: true },
      risk: 'L2',
      approved: false,
    });
    assert.equal(v.allowed, false);
    assert.equal(v.requiresApproval, true);
  });

  test('★ fail-closed：引擎未注入注册表（无从核实声明）→ 一律不免批', () => {
    const e = new CorePolicyEngine();
    const v = e.evaluate({
      capabilityId: 'storage.file.write',
      params: { path: 'C:\\Users\\vmuser\\x.txt', content: 'y', dryRun: true },
      risk: 'L2',
      approved: false,
    });
    assert.equal(v.allowed, false, '无法核实服务端声明时必须回落审批闸，绝不默认放行');
    assert.equal(v.requiresApproval, true);
  });

  test('dry-run 仍不得绕过黑名单/白名单（旁路位置在全部路径校验之后）', () => {
    const e = productionEngine();
    const cases = [
      { params: { path: 'C:\\Windows\\System32\\x.dll', permanent: true, dryRun: true }, why: '黑名单' },
      { params: { path: TRAVERSAL, permanent: true, dryRun: true }, why: '穿越串（归一后落黑名单）' },
      { params: { path: 'E:\\Random\\x', dryRun: true }, why: '白名单 miss' },
    ];
    for (const { params, why } of cases) {
      const v = e.evaluate({ capabilityId: 'storage.file.delete', params, risk: 'L2', approved: false });
      assert.equal(v.allowed, false, `dry-run 不得绕过${why}`);
      assert.equal(v.requiresApproval, false, `${why} 命中是硬拒绝，不转「等审批」`);
    }
  });

  test('已声明能力经真实注册表装配后确凿免批（与生产同构，防夹具漂移）', () => {
    const e = productionEngine();
    for (const [capabilityId, risk, params] of [
      ['system.power.control', 'L3', { action: 'restart', dryRun: true }],
      ['app.winget.uninstall', 'L2', { id: 'Tencent.WeChatWork', dryRun: true }],
      ['storage.file.delete', 'L2', { path: 'C:\\Users\\vmuser\\old', dryRun: true }],
    ]) {
      const v = e.evaluate({ capabilityId, params, risk, approved: false });
      assert.deepEqual(
        view(v),
        { allowed: true, matchedRule: 'allow:dry-run-bypass', requiresApproval: false },
        `${capabilityId} 的合法 dry-run 预览链路被破坏（Skill「先 dry-run 再确认」依赖它）`,
      );
    }
  });

  test('★ 声明位集合钉死（新增一条标注 = 新增一条免审批通道，必须显形）', () => {
    const declared = WINDOWS_CAPABILITIES.filter((c) => c.supportsDryRun === true).map((c) => c.id).sort();
    assert.deepEqual(declared, [
      'app.winget.install',
      'app.winget.uninstall',
      'app.winget.upgrade',
      'storage.file.delete',
      'system.power.control',
    ], 'supportsDryRun 集合漂移（须同步核对 psmod 实现体是否真的零变更，并更新 SECURITY-GOVERNANCE §3.4）');
  });

  test('哨兵常量单值源：契约常量 = core 别名 = 引擎实际产出串', () => {
    assert.equal(DRY_RUN_BYPASS_MATCHED_RULE, POLICY_DRY_RUN_BYPASS_MATCHED_RULE);
    assert.equal(DRY_RUN_BYPASS_MATCHED_RULE, 'allow:dry-run-bypass');
    const e = engineWith([DECLARED]);
    const v = e.evaluate({
      capabilityId: 'storage.file.write',
      params: { path: 'C:\\Users\\vmuser\\x.txt', content: 'y', dryRun: true },
      risk: 'L2',
      approved: false,
    });
    assert.equal(v.matchedRule, DRY_RUN_BYPASS_MATCHED_RULE, '引擎产出的 matchedRule 必须与装饰器/grep 用的常量同源');
  });
});

/* ==================== 4. U-P0-3 · 免批取证的链上证据位 ext.bypass ==================== */

describe('U-P0-3 · 免批执行必须留链上证据（ext.bypass=dry-run）', () => {
  /** 捕获 append 入参的 mock sink（不落盘、不依赖 fs） */
  function captureSink() {
    const written = [];
    return {
      written,
      sink: {
        async append(input) {
          written.push(input);
          return { ...input, seq: written.length, prevHash: 'GENESIS', hash: `h${written.length}` };
        },
        async verifyChain() {
          return { valid: true, entries: written.length, checked: written.length };
        },
      },
    };
  }

  const baseEntry = (matchedRule) => ({
    ts: new Date().toISOString(),
    traceId: 'tr_dryrun_1',
    auditId: 'aud_dryrun_1',
    principal: { host: 'vm-service', user: 'tester', channel: 'mcp' },
    capabilityId: 'app.winget.uninstall',
    risk: 'L2',
    params: { id: 'Tencent.WeChatWork', dryRun: true },
    policyDecision: { allowed: true, matchedRule },
    result: { ok: true, summary: 'dry-run 预览成功' },
    durationMs: 12,
  });

  test('命中 dry-run 旁路的记录被补写 ext.bypass="dry-run"', async () => {
    const f = captureSink();
    const wrapped = bypassTagSink(f.sink);
    await wrapped.append(baseEntry(POLICY_DRY_RUN_BYPASS_MATCHED_RULE));
    assert.equal(f.written.length, 1);
    assert.equal(f.written[0].ext?.bypass, 'dry-run', '免批事实必须进链（grep ext.bypass 即得全部免批执行）');
  });

  test('与 K-N1 归因 ext **合并**而非覆盖（delegationId / channel 不得丢失）', async () => {
    const f = captureSink();
    const wrapped = bypassTagSink(f.sink);
    await wrapped.append({
      ...baseEntry(POLICY_DRY_RUN_BYPASS_MATCHED_RULE),
      ext: { kind: 'inner-call', delegationId: 'tr_dtid_1', channel: 'a2a' },
    });
    assert.deepEqual(f.written[0].ext, { kind: 'inner-call', delegationId: 'tr_dtid_1', channel: 'a2a', bypass: 'dry-run' });
  });

  test('★ 非旁路记录**连 ext 键都不新增**（纯附加，既有链上形态逐字节不变）', async () => {
    const f = captureSink();
    const wrapped = bypassTagSink(f.sink);
    const input = baseEntry('allow:policy-passed');
    const keysBefore = Object.keys(input).length;
    await wrapped.append(input);
    assert.equal(f.written.length, 1);
    assert.equal('ext' in f.written[0], false, '普通放行不得凭空多出 ext 键（会改变哈希形态）');
    assert.equal(Object.keys(f.written[0]).length, keysBefore, '装饰器不得给非旁路记录增删任何键');
  });

  test('判据只看服务端裁决（matchedRule），绝不回看调用方 dryRun 参数', async () => {
    const f = captureSink();
    const wrapped = bypassTagSink(f.sink);
    // 调用方自称 dryRun:true 但策略裁决并非旁路（例如已审批通过的真实执行）
    await wrapped.append({ ...baseEntry('allow:policy-passed'), params: { dryRun: true } });
    assert.equal('ext' in f.written[0], false, '若此处出现 bypass 位，说明免批判定权回到了调用方手里');
  });

  test('verifyChain 透传（装饰器不得吞掉校验能力）', async () => {
    const f = captureSink();
    const wrapped = bypassTagSink(f.sink);
    const v = await wrapped.verifyChain();
    assert.equal(v.valid, true);
  });
});

/* ==================== 5. 变异自检（内存副本，零写盘） ==================== */

describe('U-P0-1/U-P0-3 · 变异自检：证明新判据不是装饰品', () => {
  const SRC = readFileSync(ENGINE_TS, 'utf8');

  /* ---------------- 判据 A：段消解真实存在 ---------------- */

  /**
   * 归一内核判据。
   *
   * 判据 7 的第二条教训：**别把语义断在错误的函数上**。旧判据只在
   * `foldWin32Segments` 一个函数体里找 `=== '..'`，而 `.`/`..` 的实际识别位于
   * **被调用的 `foldSegList`** 内 ⇒ 真源码被误报「内核不识别 `..` 段」。
   * 现在的口径：把「归一通路的两个函数体」并成 **scope** 一起断言，
   * 语义要求不变（必须真的识别 `..`/`.`、必须真的逐段消解、rooted 两态必须都在），
   * 但不依赖「具体写在哪个函数里」这种实现细节 —— 将来把 foldSegList 内联回去，
   * 守卫仍然有效（防脆）。
   */
  const auditSegmentFolding = (src) => {
    const problems = [];
    let scope = '';
    let code = '';
    try {
      const k = fnBody(src, 'function foldWin32Segments(');
      code = k.code;
      scope = k.body;
      const f = fnBody(src, 'function foldSegList(');
      scope += f.body;
    } catch (e) {
      // 锚点漂移/缺席本身就是「段消解不复存在」——记账为问题而不是让测试因抛错而红
      return [`${e.message}（normalizePath 通路结构异常）`];
    }
    if (!code.includes('return foldWin32Segments(p);')) problems.push('normalizePath 未委托段消解内核');
    if (!scope.includes("=== '..'")) problems.push('归一通路不识别 `..` 段（穿越串将原样透传）');
    if (!scope.includes("=== '.'")) problems.push('归一通路不丢弃 `.` 段');
    if (!scope.includes('foldSegList(')) problems.push('内核未调用逐段消解');
    // rooted 两态都必须存在。
    //   ❌ 第一版用 `[^)]*` 正则：实参 `s.slice(driveRelative ? 2 : 0)` 自带右括号 ⇒ 在第一个
    //      `)` 处截断 ⇒ 真源码误判为「无 rooted=false」。
    //   ❌ 第二版按行取调用、看行尾实参：prettier 把长调用折成多行
    //      （`foldSegList(\n  s.slice(2),\n  true,\n);`）后**整行没有 `,\s*true)`** ⇒ 漏计一处，
    //      于是变异 X4「等价改写」判据假红（体检 §2-QA-11 点名的「守卫绑在排版形态上」）。
    //   ✅ 现在做**括号配平**取每个调用的完整实参串，再按**顶层逗号**分段（深度 0 才切），
    //      末段即 rooted 实参。对换行/缩进/嵌套括号（`s.slice(2)`、三元）全部免疫。
    const rootedFlags = callLastArgs(scope, 'foldSegList(');
    if (!rootedFlags.includes('true')) problems.push('锚定形态（盘符/UNC/根相对）必须以 rooted=true 消解');
    if (!rootedFlags.includes('false')) problems.push('相对形态必须以 rooted=false 保留 `..`');
    // 结构性下限：rooted=true 的调用至少 3 处（盘符绝对 / UNC / 根相对），少一处即有一形态失守
    const rootedTrue = rootedFlags.filter((x) => x === 'true').length;
    if (rootedTrue < 3) problems.push(`rooted=true 调用仅 ${rootedTrue} 处（盘符/UNC/根相对三形态需各一处）`);
    return problems;
  };

  /**
   * 提取 `name(` 的每一次调用中**最后一个顶层实参**的文本（去空白）。
   *
   * 实现纪律：括号配平扫描（不是正则）；只在深度 0 处按逗号分段，故
   * `foldSegList(s.slice(driveRelative ? 2 : 0), false)` 与
   * `foldSegList(\n  s.slice(driveRelative ? 2 : 0),\n  false,\n)` 得到同一结果 `'false'`。
   * 引号内的括号/逗号忽略（实参里的字符串字面量不得干扰分段）。
   */
  function callLastArgs(code, name) {
    const out = [];
    let cursor = 0;
    for (;;) {
      const idx = code.indexOf(name, cursor);
      if (idx === -1) return out;
      const open = idx + name.length - 1; // 指向 name 末尾的 `(`
      let depth = 0;
      let close = -1;
      let quote = '';
      const splits = [];
      let segStart = open + 1;
      for (let i = open; i < code.length; i += 1) {
        const ch = code[i];
        if (quote) {
          if (ch === '\\') i += 1;
          else if (ch === quote) quote = '';
          continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') {
          quote = ch;
          continue;
        }
        if (ch === '(' || ch === '[' || ch === '{') depth += 1;
        else if (ch === ')' || ch === ']' || ch === '}') {
          depth -= 1;
          if (depth === 0) {
            close = i;
            splits.push(code.slice(segStart, i));
            break;
          }
        } else if (ch === ',' && depth === 1) {
          splits.push(code.slice(segStart, i));
          segStart = i + 1;
        }
      }
      if (close === -1) return out; // 配平失败：就此收束，绝不静默给出「看起来对」的实参
      // prettier 风格**尾逗号**（`f(a, true,)`）会让最后一个分段为空 ⇒ 取最后一个非空分段
      const last = splits
        .map((seg) => seg.replace(/\s+/g, ''))
        .filter((seg) => seg !== '')
        .pop();
      out.push(last ?? '');
      cursor = close + 1;
    }
  }

  /* ---------------- 判据 B：dry-run 放行必须是双条件 ---------------- */

  /**
   * 旁路判据：`dryRun === true` 块内必须再叠**服务端声明位**条件。
   * 切片在**剥注释后**的文本上做（见 stripComments），锚点与 assembly-guard 保持一致。
   */
  const auditBypassIsConditional = (src) => {
    const mark = "if (req.params['dryRun'] === true) {";
    const problems = [];
    let block;
    try {
      block = blockOf(stripComments(src), mark, 'dry-run 旁路');
    } catch (e) {
      return [`${e.message}（守卫切片失效）`];
    }
    if (!/capabilitySupportsDryRun/.test(block)) {
      problems.push('旁路只凭调用方 dryRun（服务端声明位缺失 = U-P0-3 复发）');
    }
    // 免批 return 必须**只在**声明位判定之内（把 `if (…SupportsDryRun…)` 摘掉后仍应放行 = 无条件放行）
    const withoutGuard = block.replace(/if \(\s*this\.capabilitySupportsDryRun\([^)]*\)\s*\) \{/g, '');
    if (/return \{[^}]*allowed: true/s.test(withoutGuard) === false) {
      problems.push('旁路块内已无 allowed:true 放行分支（免批逻辑被删，D11 合法链路将回归失败）');
    }
    return problems;
  };

  /* ---------------- 用例 ---------------- */

  test('真实源码：两条判据均为空', () => {
    assert.deepEqual(auditSegmentFolding(SRC), []);
    assert.deepEqual(auditBypassIsConditional(SRC), []);
  });

  test('判据自身有效性：注释里贴满旧实现特征串，判据仍必须为空（防第 7 条复发）', () => {
    // 这正是 engine.ts 现状：注释区含 `if (req.params['dryRun'] === true) {` 与
    // 「旧实现只做浅归一」的字面描述。用显式构造再钉一次，防止有人把 stripComments 删掉。
    const noisy = [
      '// 旧实现 `if (req.params[\'dryRun\'] === true) { return { allowed: true } }` 已废弃',
      '/* 曾只做浅归一：不解析 \'..\' 段 */',
      SRC,
    ].join('\n');
    assert.deepEqual(auditSegmentFolding(noisy), [], '注释文本干扰了段消解判据');
    assert.deepEqual(auditBypassIsConditional(noisy), [], '注释文本干扰了旁路判据');
  });

  test('变异 X1 还原旧浅归一（HEAD 三行实现）⇒ 段消解判据必须变红', () => {
    const shallow = [
      'function foldWin32Segments(p: string): string {',
      "  let s = p.trim().replace(/\\//g, '\\\\');",
      "  if (!UNC_RE.test(s)) s = s.replace(/\\\\+/g, '\\\\');",
      "  if (s.length > 3 && s.endsWith('\\\\')) s = s.slice(0, -1);",
      '  return s;',
      '}',
    ].join('\n');
    const mutated = stripComments(SRC).replace(/function foldWin32Segments\([\s\S]*?\n\}/, shallow);
    assert.notEqual(mutated, stripComments(SRC), '变异未生效（锚点漂移）');
    const problems = auditSegmentFolding(mutated);
    assert.ok(problems.length > 0, '浅归一还原后段消解判据仍绿 ⇒ 判据是装饰品');
  });

  test('变异 X2 去掉 rooted=false 分支（相对形态 `..` 被伪造成绝对路径）⇒ 判据必须变红', () => {
    const code = stripComments(SRC);
    const mutated = code.replace('foldSegList(s.slice(driveRelative ? 2 : 0), false)', 'foldSegList(s.slice(driveRelative ? 2 : 0), true)');
    assert.notEqual(mutated, code, '变异未生效（锚点漂移）');
    const problems = auditSegmentFolding(mutated);
    assert.ok(problems.length > 0, 'rooted=false 消失后判据仍绿 ⇒ 判据是装饰品');
    assert.ok(
      problems.some((p) => /rooted=false/.test(p)),
      `应精确报出 rooted=false 缺失，实得 ${JSON.stringify(problems)}`,
    );
  });

  test('变异 X3 还原旧单条件旁路 ⇒ dry-run 判据必须变红', () => {
    const code = stripComments(SRC);
    const mutated = code.replace(
      /if \(req\.params\['dryRun'\] === true\) \{\n\s*if \(this\.capabilitySupportsDryRun\(req\.capabilityId\)\) \{[\s\S]*?\n\s*\}\n\s*\}/,
      "if (req.params['dryRun'] === true) {\n        return { allowed: true, matchedRule: 'allow:dry-run-bypass', requiresApproval: false };\n      }",
    );
    assert.notEqual(mutated, code, '变异未生效（旁路块形态与预期不符，须同步修本变异的锚点）');
    const problems = auditBypassIsConditional(mutated);
    assert.ok(problems.length > 0, '单条件旁路还原后 dry-run 判据仍绿 ⇒ 判据是装饰品');
    assert.ok(
      problems.some((p) => /服务端声明位缺失/.test(p)),
      `应精确报出声明位缺失，实得 ${JSON.stringify(problems)}`,
    );
  });

  test('变异 X4 等价改写（格式化，语义不变）⇒ 判据必须仍绿（防脆守卫）', () => {
    // 三种「语义不变但字节变了」的改写：加尾随空格、把参数换行、把常量换成等值字面量
    const variants = {
      trailingSpace: SRC.replace("if (req.params['dryRun'] === true) {", "if (req.params['dryRun'] === true) {   "),
      wrappedArg: SRC.replace(
        'if (this.capabilitySupportsDryRun(req.capabilityId)) {',
        'if (\n          this.capabilitySupportsDryRun(req.capabilityId),\n        ) {',
      ),
      literalRule: SRC.replace('matchedRule: POLICY_DRY_RUN_BYPASS_MATCHED_RULE,', "matchedRule: 'allow:dry-run-bypass',"),
    };
    for (const [name, mutated] of Object.entries(variants)) {
      assert.notEqual(mutated, SRC, `${name}：变异未生效（锚点漂移）`);
      assert.deepEqual(auditBypassIsConditional(mutated), [], `${name}：纯形态变化不该触发旁路判据`);
    }
    // 归一侧的防脆：给内核加空行/换缩进不该让段消解判据变红
    const spaced = SRC.replace('  const stack = foldSegList(s.slice(2), true);', '  const stack = foldSegList(\n    s.slice(2),\n    true,\n  );');
    assert.notEqual(spaced, SRC, '归一侧变异未生效');
    assert.deepEqual(auditSegmentFolding(spaced), [], '纯换行/缩进不该触发段消解判据');
  });

  test('只读自证：本文件执行期间 engine.ts 磁盘字节未变（变异全在内存）', () => {
    assert.equal(
      createHash('sha256').update(readFileSync(ENGINE_TS)).digest('hex'),
      ENGINE_HASH,
      'engine.ts 磁盘字节发生变化（违反只读纪律）',
    );
  });
});

/* ---------------- 切片工具（判据 7 的教训全在这三个函数里） ---------------- */

/**
 * 逐行剥离注释（`//` 行、JSDoc 的 `*` / `/*` 行）。
 *
 * 为什么必须剥（team-lead 裁定第 7 条 · 根因）：本任务的 engine.ts 里**大量注释引用了
 * 被修复代码的字面量** —— 例如「⚠ 锚点纪律：`if (req.params['dryRun'] === true) {` 这一行的
 * 字面量是 assembly-guard 的切片锚点」。判据若直接在**原始源码文本**上 `indexOf` 特征串，
 * 命中的第一处是**注释**而不是代码：
 *   - `auditBypassIsConditional` 因此把「注释行」当锚点、从注释处开始配平花括号，
 *     切片范围整体错位（实测原始文本里该 mark 出现 2 次：751 注释 + 755 代码）；
 *   - `auditSegmentFolding` 的 `[^)]*` 正则也无法穿越注释里的半个括号。
 * 结论：**判据一律在剥离注释后的文本上运行**，注释怎么写都不影响守卫，
 * 这才是「特征串避开注释区」的正解（比「挑一个注释里没有的独特串」稳，
 * 因为后者只要有人往注释里贴一段旧代码就再次自匹配）。
 */
function stripComments(src) {
  return src
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
}

/**
 * 花括号配平切片（与 `tests/unit/assembly-guard.test.js` 的 `blockOf` 同一纪律）。
 * 锚点找不到时**显式抛错**（QA-02 教训：绝不静默返回空串 —— 空串会让所有
 * 「必须包含 X」的判据全票通过，守卫当场失效却一片绿）。
 */
function blockOf(src, mark, label) {
  const start = src.indexOf(mark);
  if (start === -1) throw new Error(`切片失败：${label} 里找不到锚点 [${mark}]`);
  const open = src.indexOf('{', start);
  if (open === -1) throw new Error(`切片失败：${label} 锚点后无左括号`);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`切片失败：${label} 花括号未配平（源码形态异常）`);
}

/** 取某个函数的**函数体**（剥注释后按名配平），返回 `{ body, calls }` */
function fnBody(src, fnDecl) {
  const code = stripComments(src);
  return { code, body: blockOf(code, fnDecl, fnDecl) };
}

/* ============================ 判据实现（§2 静态守卫） ============================ */

/**
 * 「检查 engine.ts 全部路径比对调用点无绕过归一的旁路」（任务书 U1 要求）。
 *
 * 判据（对源码文本，**不用行号**防漂移；QA-02 的教训：锚点找不到要显式记账，绝不静默返回空）：
 *  1. 全局模式表 `pathDenyRe` / `pathAllowRe` 的构造必须经 `normalizePath`（模式侧归一）；
 *  2. 能力级覆盖表 `capPathDeny` / `capPathAllow` 同样必须经 `normalizePath`；
 *  3. 两个比对点（步骤 2 黑名单、步骤 4 白名单）都必须对 `normalizePath(candidate)` 的结果比对，
 *     即 `normalizePath(candidate)` 至少出现 2 次；
 *  4. **负面**：不得出现把**原始** `candidate` 直接交给 `pathMatchesAny` 的旁路写法。
 */
function auditNormalizationBypass(src) {
  const problems = [];
  const grab = (re, label) => {
    const m = re.exec(src);
    if (!m) {
      problems.push(`${label} 构造点未找到（守卫锚点漂移，或该逻辑已被删）`);
      return '';
    }
    return m[0];
  };
  // 1) 全局两张表
  for (const field of ['pathDenyRe', 'pathAllowRe']) {
    const stmt = grab(new RegExp(`this\\.${field} = [^;]*`, 's'), `this.${field}`);
    if (!stmt) continue;
    if (!stmt.includes('normalizePath')) problems.push(`${field} 的模式未经 normalizePath（表侧未归一）`);
    if (!stmt.includes('globToRegex')) problems.push(`${field} 未走 globToRegex`);
  }
  // 2) 能力级覆盖两张表
  for (const name of ['capPathDeny', 'capPathAllow']) {
    const stmt = grab(new RegExp(`const ${name} = [^;]*`, 's'), name);
    if (!stmt) continue;
    if (!stmt.includes('normalizePath')) problems.push(`${name} 的模式未经 normalizePath`);
  }
  // 3) 比对点入参必须来自归一结果（黑名单 + 白名单各一处）
  const sites = (src.match(/normalizePath\(candidate\)/g) ?? []).length;
  if (sites < 2) {
    problems.push(`归一比对点不足（normalizePath(candidate) 出现 ${sites} 次，黑名单/白名单各需 1 处）`);
  }
  // 4) 负面判据：未归一的原始串直连比对
  if (/pathMatchesAny\(\s*candidate/.test(src)) problems.push('存在把未归一的 candidate 直接比对的旁路');
  return problems;
}

#!/usr/bin/env node
/**
 * gate —— WinVM Bridge 零平台成本聚合门禁（Phase 2 · P2-T11 / 设计 §267 A-4、§365 PR9、§13 Q7/Q8 裁决）
 *
 * ## 为什么存在（PM-08 + Q8 裁决）
 * 设计 §267 原话：「F1/F4 落的每条静态守卫，今天都**只能靠人跑**」——主理人每批亲跑 sweep。
 * PM-08 裁决 = 优先做**零平台成本门禁**（本地即拦，CI 后置）；Q8 用户裁决 = 纳入 Phase 2
 * （「否则 F1/F4 的所有守卫仍是文档承诺」）。Phase 1 吃过这个亏：根 `package.json` 的 `layout`
 * 指向不存在的 dep-lint，**写了没人能跑**，最终被删。⇒ 本批要么接通、要么不写。
 *
 * ## 五段流水线（顺序不可换）
 *   ST1 `tsc -b tsconfig.build.json` —— **门禁自身先跑 build**（PR9 明令：dep-lint 读 dist 产物，
 *       不先 build 就会「源码改了、产物没改 ⇒ 门禁判的是上一版」）。同时它是 K-3 的第一步。
 *   ST2 dep-lint —— 分层方向 / 幽灵依赖 / 框架审计边三条判据（见 scripts/dep-lint.mjs）。
 *   ST2b config-key-lint —— 配置全键集白名单（设计 §13.2-② 遗留项，明令「列入 P2-T11 gate
 *       候选判据」；白名单派生自 TS 类型，见 scripts/config-key-lint.mjs）。
 *   ST3 守卫件 —— 「进门禁表」里的静态守卫逐文件跑（表见本文件 GATE_GUARD_FILES + scripts/GATE-POLICY.md）。
 *   ST4 逐文件 `node --test` 全仓 sweep —— **仅全量档**。
 *
 * ## 两档
 *   `--quick`  = ST1 + ST2 + ST2b + ST3（约 1–2 分钟）⇒ 提交前/改完即跑的廉价档
 *   （默认全量）= ST1 + ST2 + ST2b + ST3 + ST4（92+ 文件 sweep，约 25–30 分钟）⇒ 批次收官档
 *   `--lock-probe` = 只跑真机会话前置探针（委托 scripts/lock-probe.mjs；设计 §3.4 E-3）
 *
 * ## ⚠ 两条内建硬约束（不是运行手册里的口头纪律，是代码里的）
 *   ① **绝不 glob 整批跑测试**：本仓 `node --test tests/unit/`（目录/glob 式）会因
 *      `link-workspace` 的 symlink(junction) 触发 `0xC0000005` 进程访问违例，**连带判死全部文件**
 *      = 假全红（MEMORY 关键坑段、K-2、设计 §262 第 5 点）。⇒ ST4 恒**逐文件 spawn**，
 *      每个文件一个独立子进程，绝不做「一把梭」优化。
 *   ② **不 import 被测包**：门禁与 dep-lint 只用 node stdlib + 子进程（PR9「不 import 被测包
 *      （避开 junction 假红）」）。否则门禁自身会变成最容易炸的那个东西。
 *
 * ## 「跳过门禁即视为未验收」（PR9 的文档对冲，GATE-POLICY.md 明写）
 * 无 CI ⇒ 门禁的唯一强制力来自「人记得跑」。设计 §365 把这列为 PR9 的结构性残留。
 * 对冲手段 = 逐条列出门禁包含/不含哪些判据及其理由（GATE-POLICY.md），并把这句话写进
 * README §8 / 本文件：**跳过门禁即视为未验收**。
 *
 * ## 用法
 *   node scripts/gate.mjs --quick
 *   node scripts/gate.mjs                 # 全量（含 sweep）
 *   node scripts/gate.mjs --lock-probe    # 真机窗口开工前置（只读）
 *   node scripts/gate.mjs --stage=dep-lint,tsc
 *   node scripts/gate.mjs --out /path/to/gate-result.txt
 *   node scripts/gate.mjs --skip-build    # 仅排障用（结果不构成本批验收证据）
 *
 * ## 退出码
 *   0 = 全绿  1 = 任一段失败  2 = 前置不满足（build 失败/dist 缺失 ⇒ 结果不具判定意义）
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ============================== 门禁表（数据即判据，与 GATE-POLICY.md 双写） ============================== */

/**
 * **进门禁**的静态守卫件（ST3）。每条附理由——设计 §365 PR9 要求的「哪些判据进门禁」表。
 * 判据入选标准（三条全满足才进）：
 *   (a) 纯离线（零 VM / 零真机 / 零网络 / 零隧道）；
 *   (b) 判据属**安全承诺 / 契约保真 / 分层纪律**族（失效后果 = 文档与运行态分叉，正是 Phase 2 命题）；
 *   (c) 单文件耗时可接受（< 30s）。
 * @type {{file:string, id:string, why:string}[]}
 */
export const GATE_GUARD_FILES = [
  {
    file: 'phase2-snapshot-truth.test.js',
    id: 'snapshot-truth',
    why: 'ARCH-04 事实三元组（声明/消费/承载）防再漂移——用户 Q2 裁决「降级为信息性」的唯一强制面；被悄悄改回「宣称实现」就在这里红',
  },
  {
    file: 'phase2-dead-config.test.js',
    id: 'dead-config',
    why: '死字段删除族 + 旧键显式告警（PR2：配了不生效 = 假安全感）；安全承诺型配置不能静默失效',
  },
  {
    file: 'phase3-skill-claims-guard.test.js',
    id: 'skill-claims',
    why: '批0 文档止血的反向守卫：SKILL 点分 token ∈ 注册 id ∪ 白名单 + 承诺口径回潮钉（QA 回归 D-3 补登记——"写了没人跑"恰是批0 自反病灶，入选三标准满足）',
  },
  {
    file: 'phase2-contract-schema.test.js',
    id: 'contract-schema',
    why: 'schema 交付面校验 + schema↔TS 事实源漂移守卫（Q1=(b) 裁决把校验点定在交付面 ⇒ 交付面必须有强制力）',
  },
  {
    file: 'phase2-contract-code-fidelity.test.js',
    id: 'contract-code-fidelity',
    why: 'O-1 契约码保真 = **安全性质**（策略拒绝被压平成 EXECUTION_FAILED 后可被 shouldDegrade 绕过）',
  },
  // ↓ §13.2-②「policy 全键集白名单」裁决项**已由 ST2b 工具段承载**（scripts/config-key-lint.mjs，
  //   判据=「仓内配置资产的全部键名 ⊆ 派生白名单」，非「喂一个假配置看函数反不反应」）。
  //   刻意**不**再造一个同名 .test.js：那样只会测「工具会不会报错」，测不到裁决要的东西，
  //   且属 Phase 2 命题反对的「写了看着有、其实不判」的第四种状态。
  {
    file: 'phase2-session-unknown.test.js',
    id: 'session-unknown',
    why: 'P2-T9 未知态（probeError）+ PR8 红线「isGuiAllowed 行为零放宽」——GUI 门禁判据被无意放宽是安全回归面',
  },
  {
    file: 'assembly-guard.test.js',
    id: 'assembly-guard',
    why: 'S-4/A5 装配点源码守卫：重构删掉注入点时 1000+ 例纯函数测试**照样全绿**（Phase 1 体检原话），只有这里能拦住取证盲区复活',
  },
  {
    file: 'psmod-contract.test.js',
    id: 'psmod-contract',
    why: '注册表 ↔ PowerShell 跨语言隐式契约（54 条映射）：编译器与 tsc 都看不见它，体检实测当时零回归覆盖',
  },
  {
    file: 'p4-b9-errcode-registration-pin.test.js',
    id: 'errcode-registration-pin',
    why: 'P4-N-2 契约码登记漂移钉：errors.ts 封闭码集 ↔ INTERFACES §2.6 表双向对账（加码欠登记/表私加幽灵码/retryable 漂移皆红）——同病再发两次的码表只有机检能终结（Phase 4 批9 处方）',
  },
  {
    file: 'winvm-prepare-ps1.test.js',
    id: 'winvm-prepare-ps1',
    why: 'REL-11 发布链：tools/winvm-prepare.ps1 = 铠大师执行的**磁盘静态资产**（无生成器兜底），PS 5.1 无 BOM UTF-8 码页乱码是本仓反复踩的坑；ASCII/CRLF/无BOM + KV 输出契约八键 + G1 双文件注入锚点被文档 §4.2 承诺解析——静默改名=双端分叉，只有机检能拦',
  },
  {
    file: 'publish-release.test.js',
    id: 'publish-release',
    why: 'REL-11 GitHub Release 上架契约纯函数钉：token 优先级/上传计划（建 vs 复用 release、zip+旁挂 sha256 双资产同名先删后传顺序 Q-2、无 token 显形警告）/匿名下载 URL 形态/dry-run 安全默认/tag 校验/zip 名与旁挂内容 pack↔publish 一字不差——下载 URL 是新机分发链唯一入口，拼错=文档全链静默失效',
  },
  {
    file: 'cl026-approval-presentation.test.js',
    id: 'cl026-approval-presentation',
    why: 'CL-026 审批卡**强制呈现**安全承诺钉：审批挂起时返回面（delegate 早退文案/approval 字段/task.get 观测面/两工具 description）必须内嵌「呈现要求」指令——缺它则出卡全凭宿主 agent 自由发挥（真机实证：卡片靠主理人手工渲染，非系统保证）。含四行契约与两工具名绑定、纯附加字段幂等、通道隔离红线（新改动面零 MCP 续跑标记 + MCP 小节不被误删的反向钉）、SKILL.md 不新增三级标题（否则 r1-approval-card R1-9 节切片静默截断）与变异自证。纯离线 0.9s，入选标准 (a)(b)(c) 全满足',
  },
  {
    file: 'cl026b-stream-break-suspension.test.js',
    id: 'cl026b-stream-break-suspension',
    why: 'CL-026b 挂起掐流**行为级**守卫（真机盲区 tr_mvhqpd53_5 补堵）：VM 侧挂起时掐断 SSE 长流 ⇒ 桥 for await 抛 undici TypeError(terminated) 落 delegate catch——旧 catch 恒 A2A_DELEGATE_FAILED（无 approval 无呈现指令）⇒ CL-026 出卡契约在真实挂起路径形同虚设。mock stream「吐事件后抛 terminated」驱动整条 delegate 链（经 dist），断言挂起收口携带呈现指令/无 error 字段/state=input-required/留痕齐备、掐流收口与正常早退**逐字同源**、防误伤真网络错（approval 缺席仍 A2A_DELEGATE_FAILED）、判据不依赖错误形态、红线零串台零凭据泄漏、旧形态变异必失配（K-10）。上轮纯函数拼接测试测不到该链路即本件入选理由；纯离线 <1s，(a)(b)(c) 全满足',
  },
];

/**
 * **不进门禁**的守卫件与理由（同样必须写下来——「不进门禁的守卫会慢慢失效」，设计 §267；
 * 显式列出 + 理由 = 把「为什么不跑」变成可审计的事实，而不是遗忘）。
 * @type {{scope:string, reason:string}[]}
 */
export const GATE_EXCLUDED = [
  {
    scope: '真机/VM 依赖件（qa/r19/ 全部 .mjs/.ps1 探针、deploy-vm / install-vm 实跑路径）',
    reason: '需 VM 隧道 + 真实会话，违反入选标准 (a)。本地强跑 = 隧道黑洞时门禁恒红 = 门禁失效（PR3 同族病灶）',
  },
  {
    scope: 'SSH 隧道与传输件（ssh2-resolve / tunnel-daemon / oh-tunnel / tunnel-mode / preflight / deploy-conn-side）',
    reason: '平台/环境相关，恒含 OFFLINE_SKIP（ssh2-resolve 的 2 skip 是既有权威口径，不得当回归，K-1）。归 ST4 全量档覆盖，不进 ST3',
  },
  {
    scope: '宿主沙箱平台件（sandbox-allowwrite / launcher-posix / path-util-posix / account-resolve）',
    reason: '判据本体是鸿蒙/POSIX 宿主行为，与仓库分层/契约纪律无关；属部署面。归 ST4 覆盖',
  },
  {
    scope: 'link-workspace.test.js（单独跑，禁入任何 glob）',
    reason: '本仓 junction `0xC0000005` 假全红的**已知触发源**（K-2）。它自己逐文件跑是绿的 ⇒ 归 ST4 逐文件档，绝不与其他文件同批 spawn',
  },
  {
    scope: '运行期接线（schema 校验入注册期 / bearer 自检常开 / policy 未知键拒启）',
    reason: 'Q1=(b) 裁决明确「不入运行期」；本门禁是**交付面**强制力，不是运行期防线。混为一谈会造出「文档说运行期校验、实际只在门禁校验」的第四种状态',
  },
];

/* ============================== 内部工具 ============================== */

const HERE = dirname(fileURLToPath(import.meta.url));
/** 仓库根（scripts/ 的上一级）。 */
const ROOT = resolve(HERE, '..');
const NODE = process.execPath;
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const TEST_DIR = join(ROOT, 'tests', 'unit');

/** 段名常量（`--stage=` 参数值与报告行共用同一串）。 */
const STAGE = /** @type {const} */ ({
  TSC: 'tsc',
  DEP_LINT: 'dep-lint',
  CONFIG_KEYS: 'config-keys',
  GUARDS: 'guards',
  SWEEP: 'sweep',
  LOCK_PROBE: 'lock-probe',
});

/**
 * 单段结果。
 * @typedef {{stage:string, verdict:string, detail:string, lines:string[]}} StageResult
 */

/**
 * 逐行累写结果文件（20 分钟无磁盘写入 = 熔断线；每段落行即自救心跳）。
 * @param {string|null} outPath
 * @param {string} text
 */
function emit(outPath, text) {
  process.stdout.write(text + '\n');
  if (outPath) {
    try {
      appendFileSync(outPath, text + '\n');
    } catch {
      /* 结果文件写失败不改变门禁判定（stdout 才是权威面） */
    }
  }
}

/**
 * 跑一个子进程，收集 stdout/stderr（不 inherit：需要解析计数）。
 * @param {string} cmd
 * @param {string[]} args
 * @param {{cwd?:string, timeoutMs?:number}} [opts]
 * @returns {{status:number, stdout:string, stderr:string, spawnError:string|null}}
 */
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd || ROOT,
    encoding: 'utf8',
    timeout: typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 900000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: typeof r.status === 'number' ? r.status : r.error ? 127 : 0,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    spawnError: r.error ? String(r.error.message) : null,
  };
}

/**
 * 从 TAP 输出解析计数（对齐 wbtmp/p2t7-runner.sh 的已验证口径）。
 * ⚠ reporter 决定前缀：`--test-reporter=tap` ⇒ `# tests`；node 24 默认 spec reporter ⇒ `ℹ tests`。
 *   本门禁恒显式 tap ⇒ 两种前缀都认，防「解析不到计数当 0 例假绿」。
 * @param {string} raw
 * @returns {{tests:number, pass:number, fail:number, skip:number, todo:number, parsed:boolean}}
 */
export function parseTapCounts(raw) {
  /** @type {(key:string)=>number} */
  const pick = (key) => {
    const re = new RegExp(`^(?:#|\\s*ℹ)\\s+${key}\\s+(\\d+)`, 'm');
    const m = raw.match(re);
    return m ? Number(m[1]) : -1;
  };
  const tests = pick('tests');
  const pass = pick('pass');
  const fail = pick('fail');
  const skip = pick('skipped');
  const todo = pick('todo');
  const parsed = tests >= 0 || fail >= 0;
  return {
    tests: Math.max(tests, 0),
    pass: Math.max(pass, 0),
    fail: Math.max(fail, 0),
    skip: Math.max(skip, 0),
    todo: Math.max(todo, 0),
    parsed,
  };
}

/**
 * 逐文件跑测试（K-2 硬约束的实现点：**每文件一个独立子进程**）。
 * @param {string[]} files 两种形态混收：裸文件名（相对 tests/unit，ST3 门禁表现状）
 *        或 ROOT 相对路径含 `/`（ST4 的 tests/unit/** 与 Q3 新增的 delivery/__tests__/**）
 * @param {string|null} outPath 结果文件（边跑边追行 = 20 分钟心跳自救）
 * @returns {{files:number, failedFiles:number, totalTests:number, totalPass:number, totalFail:number, totalSkip:number, rows:string[]}}
 */
export function runPerFile(files, outPath) {
  /** @type {string[]} */
  const rows = [];
  let failedFiles = 0;
  let totalTests = 0;
  let totalPass = 0;
  let totalFail = 0;
  let totalSkip = 0;
  for (const f of files) {
    const isDirScoped = f.includes('/');
    const abs = isDirScoped ? join(ROOT, f) : join(TEST_DIR, f);
    const shown = isDirScoped ? f : `tests/unit/${f}`;
    const r = run(NODE, ['--test', '--test-reporter=tap', abs], { timeoutMs: 600000 });
    const c = parseTapCounts(r.stdout + r.stderr);
    // 「解析不到计数」必须单独判红：静默 0 例 = 永绿守卫（K-10）。
    const noSummary = !c.parsed;
    let verdict = 'GREEN';
    if (r.status !== 0 || c.fail > 0 || noSummary) {
      verdict = 'RED';
      failedFiles += 1;
    }
    rows.push(
      `${verdict} ${shown} rc=${r.status} tests=${c.tests} pass=${c.pass} fail=${c.fail} skip=${c.skip}` +
        (noSummary ? ' NOSUMMARY(⇒判红：解析不到 TAP 计数不得当 0 例通过)' : ''),
    );
    if (verdict === 'RED' && !noSummary) {
      const detail = (r.stdout + r.stderr)
        .split('\n')
        .filter((l) => /^not ok|^\s+Error|^\s+# Subtest/.test(l))
        .slice(0, 12);
      for (const d of detail) rows.push('    ' + d);
    }
    totalTests += c.tests;
    totalPass += c.pass;
    totalFail += c.fail;
    totalSkip += c.skip;
    emit(outPath, rows[rows.length - 1]);
  }
  return { files: files.length, failedFiles, totalTests, totalPass, totalFail, totalSkip, rows };
}

/** 枚举 tests/unit 下全部测试文件（`.test.js` + `.test.mjs`，基线口径恒含 .mjs）。裸文件名形态（ST3 门禁表消费）。 */
export function listUnitTestFiles() {
  if (!existsSync(TEST_DIR)) return [];
  return readdirSync(TEST_DIR)
    .filter((f) => f.endsWith('.test.js') || f.endsWith('.test.mjs'))
    .sort();
}

/**
 * Q3（Phase 3 批5）：全 sweep 枚举 = tests/unit（ROOT 相对路径形态）+ delivery/__tests__。
 * 病灶：`delivery/__tests__/oh-tunnel-error-handling.test.mjs`（8 例）自 CL-016 起即孤儿
 * ——sweep 只枚举 tests/unit ⇒「写了没人跑」的测试面复现（恰是本 Phase 治理的病灶族）。
 * 只收 `.test.*` 后缀；同目录 probe-*.mjs（探针夹具，由 error-handling 件 spawn）不独立入列。
 * K-2 红线不变：本函数只产清单，逐文件 spawn 由 runPerFile 执行。
 */
export function listSweepFiles() {
  const out = listUnitTestFiles().map((f) => `tests/unit/${f}`);
  const dir = join(ROOT, 'delivery', '__tests__');
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).sort()) {
      if (f.endsWith('.test.js') || f.endsWith('.test.mjs')) out.push(`delivery/__tests__/${f}`);
    }
  }
  return out;
}

/* ============================== 各段实现 ============================== */

/** ST1：`tsc -b`（PR9：门禁自身先跑 build）。 */
function stageTsc(outPath) {
  emit(outPath, `[ST1 ${STAGE.TSC}] node_modules/typescript/bin/tsc -b tsconfig.build.json …`);
  if (!existsSync(TSC)) {
    return { stage: STAGE.TSC, verdict: 'RED', detail: `找不到 ${TSC}（先 npm install）`, lines: [] };
  }
  const r = run(NODE, [TSC, '-b', 'tsconfig.build.json'], { timeoutMs: 1800000 });
  const out = (r.stdout + r.stderr).trim();
  if (out) for (const l of out.split('\n').slice(0, 40)) emit(outPath, '    ' + l);
  return {
    stage: STAGE.TSC,
    verdict: r.status === 0 ? 'GREEN' : 'RED',
    detail: r.status === 0 ? '12 包编译通过（K-3 第一步；dep-lint 读 dist 的前置，PR9）' : `exit=${r.status}`,
    lines: out ? out.split('\n') : [],
  };
}

/** ST2：dep-lint（子进程 = 不 import 被测包的同族纪律）。 */
function stageDepLint(outPath, strictWarn) {
  emit(outPath, `[ST2 ${STAGE.DEP_LINT}] node scripts/dep-lint.mjs${strictWarn ? ' --strict-warn' : ''} …`);
  const args = [join(ROOT, 'scripts', 'dep-lint.mjs'), '--json'];
  if (strictWarn) args.push('--strict-warn');
  const r = run(NODE, args, { timeoutMs: 300000 });
  /** @type {any} */
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    return { stage: STAGE.DEP_LINT, verdict: 'RED', detail: `dep-lint 输出非 JSON（exit=${r.status}）：${(r.stdout || r.stderr).slice(0, 200)}`, lines: [] };
  }
  const s = json.stats || {};
  for (const v of json.violations || []) {
    if (v.severity === 'hard' || v.severity === 'warn') {
      emit(outPath, `    [${v.severity.toUpperCase()}] ${v.id} — ${v.message}`);
    }
  }
  const code = typeof json.code === 'number' ? json.code : 1;
  return {
    stage: STAGE.DEP_LINT,
    verdict: code === 0 ? 'GREEN' : code === 2 ? 'UNJUDGED' : 'RED',
    detail: `packages=${s.packages} 语句边=${s.importStatements} 包级边=${s.distinctEdges} 审计符号=${s.auditSymbols} hard=${s.hard} warn=${s.warn} info=${s.info}`,
    lines: [],
  };
}

/**
 * ST2b：配置全键集白名单（`scripts/config-key-lint.mjs`）。
 * 设计 §13.2-② 独立验证者遗留项 ⇒ 明令「列入 P2-T11 gate 候选判据」。本批落地并直接进默认档。
 * 判 hard 的依据：白名单派生自 TS 类型（不是手写第二清单）⇒ 未知键**必然**是拼错或历史遗留，
 * 而「配了却不生效还不吭声」正是本族要根绝的假安全感；现网配置资产实测 0 命中（非空判据）。
 */
function stageConfigKeys(outPath) {
  emit(outPath, `[ST2b ${STAGE.CONFIG_KEYS}] node scripts/config-key-lint.mjs --json …`);
  const r = run(NODE, [join(ROOT, 'scripts', 'config-key-lint.mjs'), '--json'], { timeoutMs: 120000 });
  /** @type {any} */
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    return { stage: STAGE.CONFIG_KEYS, verdict: 'RED', detail: `config-key-lint 输出非 JSON（exit=${r.status}）：${(r.stdout || r.stderr).slice(0, 200)}`, lines: [] };
  }
  for (const f of json.findings || []) {
    if (f.rule) emit(outPath, `    [HARD] ${f.rule} — ${f.file} 段 ${f.section} 键 "${f.key}"：${f.message ?? ''}`);
    else emit(outPath, `    [HARD] UNKNOWN_CONFIG_KEY — ${f.file} 段 ${f.section} 键 "${f.key}"${f.hint ? `（是否想写 "${f.hint}"？）` : ''}`);
  }
  const code = typeof json.code === 'number' ? json.code : 1;
  const sections = Object.keys(json.whitelist || {}).length;
  return {
    stage: STAGE.CONFIG_KEYS,
    verdict: code === 0 ? 'GREEN' : code === 2 ? 'UNJUDGED' : 'RED',
    detail: `顶层段=${(json.service || []).length} 白名单段=${sections} 未知键=${(json.findings || []).length}${(json.missing || []).length ? ` 缺 interface=${json.missing.join(',')}` : ''}`,
    lines: [],
  };
}

/** ST3：进门禁的守卫件。 */
function stageGuards(outPath) {
  emit(outPath, `[ST3 ${STAGE.GUARDS}] 进门禁守卫件 ${GATE_GUARD_FILES.length} 件（逐文件）…`);
  /** @type {string[]} */
  const names = GATE_GUARD_FILES.map((g) => g.file);
  const missing = names.filter((n) => !existsSync(join(TEST_DIR, n)));
  if (missing.length > 0) {
    // 门禁表与磁盘漂移 = 门禁自己成了「写在文档里但运行期不存在」的东西 ⇒ 必须判红。
    return {
      stage: STAGE.GUARDS,
      verdict: 'RED',
      detail: `门禁表引用的守卫文件不存在：${missing.join(', ')}`,
      lines: [],
      counters: { files: names.length, failedFiles: 1, totalTests: 0, totalPass: 0, totalFail: 0, totalSkip: 0 },
    };
  }
  const res = runPerFile(names, outPath);
  return {
    stage: STAGE.GUARDS,
    verdict: res.failedFiles === 0 ? 'GREEN' : 'RED',
    detail: `files=${res.files} failed=${res.failedFiles} tests=${res.totalTests} pass=${res.totalPass} fail=${res.totalFail} skip=${res.totalSkip}`,
    lines: res.rows,
    counters: {
      files: res.files,
      failedFiles: res.failedFiles,
      totalTests: res.totalTests,
      totalPass: res.totalPass,
      totalFail: res.totalFail,
      totalSkip: res.totalSkip,
    },
  };
}

/**
 * ST4：全仓逐文件 sweep。
 * @param {string|null} outPath
 * @param {Set<string>} alreadyRun ST3 已逐文件跑过的裸文件名（不重复 ⇒ 省 ~2 分钟）；
 *        Q3 后 sweep 清单为 ROOT 相对路径 ⇒ 按 basename 比对剔除。
 */
function stageSweep(outPath, alreadyRun) {
  const all = listSweepFiles();
  const files = all.filter((f) => !alreadyRun.has(f.split('/').pop()));
  emit(
    outPath,
    `[ST4 ${STAGE.SWEEP}] 全仓逐文件 sweep ${files.length} 件（ST3 已跑 ${alreadyRun.size} 件不重复 ⇒ 合计 ${all.length} 件）—— 恒逐文件 spawn，绝不 glob 整批（K-2 junction 0xC0000005）…`,
  );
  const res = runPerFile(files, outPath);
  return {
    stage: STAGE.SWEEP,
    verdict: res.failedFiles === 0 ? 'GREEN' : 'RED',
    detail: `sweepFiles=${res.files} failed=${res.failedFiles} tests=${res.totalTests} pass=${res.totalPass} fail=${res.totalFail} skip=${res.totalSkip}（另有 ST3 ${alreadyRun.size} 件已在上一段计入，不重复累）`,
    lines: res.rows,
    // 只累**本次实际跑的**文件数：ST3 的件数/例数由它自己的 counters 贡献，
    // 这里再加 alreadyRun.size 会产假文件数（实测曾报 FILES=99 而磁盘只有 92）。
    counters: {
      files: res.files,
      failedFiles: res.failedFiles,
      totalTests: res.totalTests,
      totalPass: res.totalPass,
      totalFail: res.totalFail,
      totalSkip: res.totalSkip,
    },
  };
}

/**
 * 磁盘上的测试文件总数（汇总行旁证用：与 FILES 不等 ⇒ 有文件被静默跳过 = L8 护栏统计口径）。
 * @param {Set<string>} _ignored
 */
function diskTestFileCount(_ignored) {
  return listSweepFiles().length;
}

/* ============================== 编排 ============================== */

/**
 * 主流程。
 * @param {string[]} argv
 * @returns {Promise<number>} 进程退出码
 */
export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help || args.h) {
    process.stdout.write(
      'WinVM Bridge 门禁（零平台成本 · 设计 §267 A-4 / §365 PR9 / §13 Q7+Q8）\n' +
        '  node scripts/gate.mjs --quick          ST1 tsc + ST2 dep-lint + ST2b config-keys + ST3 守卫件（约 1–2 分钟）\n' +
        '  node scripts/gate.mjs                  全量 = 上述 + ST4 逐文件 sweep（tests/unit 全量，约 2–3 分钟）\n' +
        '  node scripts/gate.mjs --lock-probe     真机窗口开工前置（只读 GET /health；设计 §3.4 E-3）\n' +
        '  node scripts/gate.mjs --stage=a,b      只跑指定段（tsc,dep-lint,config-keys,guards,sweep）—— 排障用，不构成验收证据\n' +
        '  node scripts/gate.mjs --out <file>     结果逐行落盘（长档期心跳面）\n' +
        '  node scripts/gate.mjs --strict-warn    dep-lint 的框架审计边由 warn 升 hard（Q7「首月只 warn」到期切换位）\n' +
        '  node scripts/gate.mjs --skip-build     跳过 ST1（仅排障；未重建 dist ⇒ 判的是上一版，PR9）\n' +
        '  判据清单与不进门禁理由：scripts/GATE-POLICY.md（跳过门禁即视为未验收）\n' +
        '  内建硬约束：ST4 恒逐文件 spawn，绝不 glob 整批（K-2 junction 0xC0000005 假全红）\n',
    );
    return 0;
  }
  const quick = args.quick === true;
  const outPath = args.out ? resolve(String(args.out)) : null;
  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `# gate ${quick ? 'QUICK' : 'FULL'} · ${new Date().toISOString()}\n# node=${NODE} cwd=${ROOT}\n`);
  }

  if (args['lock-probe']) return runLockProbe(outPath);

  /** @type {StageResult[]} */
  const results = [];
  /** 跨段累计（ST3+ST4 的逐文件计数合并成一条汇总行，对齐 sweep-result 口径）。 */
  const totals = { files: 0, failedFiles: 0, totalTests: 0, totalPass: 0, totalFail: 0, totalSkip: 0 };
  /** @param {{counters?:any}} res */
  const push = (res) => {
    results.push(res);
    if (res.counters) {
      totals.files += res.counters.files;
      totals.failedFiles += res.counters.failedFiles;
      totals.totalTests += res.counters.totalTests;
      totals.totalPass += res.counters.totalPass;
      totals.totalFail += res.counters.totalFail;
      totals.totalSkip += res.counters.totalSkip;
    }
    return res;
  };
  const onlyStage = args.stage ? String(args.stage).split(',').map((s) => s.trim()).filter(Boolean) : null;
  const want = (/** @type {string} */ s) => !onlyStage || onlyStage.includes(s);

  emit(outPath, `=== WinVM Bridge 门禁（${quick ? 'QUICK' : 'FULL'}）· ${new Date().toISOString()} ===`);

  if (args['skip-build']) {
    emit(outPath, `⚠ --skip-build：未重建 dist ⇒ 本结果**不构成本批验收证据**（仅排障用，PR9）`);
  } else if (want(STAGE.TSC) || want(STAGE.DEP_LINT) || !onlyStage) {
    const t = stageTsc(outPath);
    results.push(t);
    if (t.verdict !== 'GREEN') {
      emit(outPath, `VERDICT: RED —— ST1 tsc 失败 ⇒ 后续段落判定不具意义（dist 可能是上一版，PR9）`);
      return 2;
    }
  }

  if (want(STAGE.DEP_LINT)) push(stageDepLint(outPath, args['strict-warn'] === true));
  if (want(STAGE.CONFIG_KEYS)) push(stageConfigKeys(outPath));

  /** @type {Set<string>} */
  let guardsAlreadyRun = new Set();
  if (want(STAGE.GUARDS)) {
    push(stageGuards(outPath));
    guardsAlreadyRun = new Set(GATE_GUARD_FILES.map((g) => g.file));
  }
  if (!quick && want(STAGE.SWEEP)) push(stageSweep(outPath, guardsAlreadyRun));

  const bad = results.filter((r) => r.verdict !== 'GREEN');

  emit(outPath, '');
  for (const r of results) emit(outPath, `${String(r.verdict).padEnd(9)} ${r.stage} — ${r.detail}`);
  emit(outPath, '');
  emit(
    outPath,
    `FILES=${totals.files} FAILED_FILES=${totals.failedFiles} TOTAL_TESTS=${totals.totalTests} TOTAL_PASS=${totals.totalPass} TOTAL_FAIL=${totals.totalFail} TOTAL_SKIP=${totals.totalSkip}`,
  );
  // 汇总行旁证：跑过的文件数必须等于磁盘上的测试文件数，否则「有测试被静默跳过」
  // = L8 护栏统计口径的同类病灶（一个永不被跑的绿色守卫等于没有守卫）。
  if (!quick && !onlyStage) {
    // Q3：onDisk 与 sweep 枚举源同函数（listSweepFiles 含 tests/unit + delivery/__tests__），
    // 否则「磁盘计数」落后「实跑清单」会假 MISMATCH 或漏判 delivery 面孤儿。
    const onDisk = listSweepFiles().length;
    emit(outPath, `DISK_TEST_FILES=${onDisk} RUN=${totals.files} ${onDisk === totals.files ? 'MATCH' : 'MISMATCH(⇒判红：有测试文件未进门禁 sweep)'}`);
    if (onDisk !== totals.files) bad.push({ stage: 'coverage', verdict: 'RED', detail: `磁盘 ${onDisk} 个测试文件 vs 实跑 ${totals.files} 个`, lines: [] });
  }
  emit(outPath, `VERDICT: ${bad.length === 0 ? 'GREEN' : 'RED'}`);
  if (bad.length === 0) {
    emit(outPath, '（GATE-POLICY.md：跳过门禁即视为未验收；本文件即该批次的门禁证据）');
    return 0;
  }
  return 1;
}

/** 极简 flag 解析（零依赖：不用 node:util parseArgs，避免版本面差异）。 */
function parseArgs(argv) {
  /** @type {Record<string,string|boolean>} */
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const body = a.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      out[body.slice(0, eq)] = body.slice(eq + 1);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--') && ['out', 'stage'].includes(body)) {
      out[body] = argv[i + 1];
      i += 1;
    } else {
      out[body] = true;
    }
  }
  return out;
}

/** `--lock-probe`：委托 lock-probe.mjs（子进程 ⇒ 门禁零网络依赖面）。 */
async function runLockProbe(/** @type {string|null} */ outPath) {
  emit(outPath, `[${STAGE.LOCK_PROBE}] node scripts/lock-probe.mjs（真机窗口前置探针，只读）…`);
  const r = run(NODE, [join(ROOT, 'scripts', 'lock-probe.mjs')], { timeoutMs: 60000 });
  const out = (r.stdout + r.stderr).trim();
  for (const l of out.split('\n')) emit(outPath, '    ' + l);
  emit(outPath, `VERDICT: ${r.status === 0 ? 'GO' : r.status === 1 ? 'BLOCKED' : r.status === 3 ? 'UNKNOWN' : 'UNREACHABLE'}`);
  return r.status;
}

/**
 * 是否作为脚本被**直接执行**（被单测 import 时不跑 CLI）。
 * ⚠ 两侧都过 realpath 再比：本仓 node_modules/@winvm/* 是 junction，且 spawn 方传入的
 *   argv[1] 与 import.meta.url 可能带不同挂载别名（/storage/... vs 真路径）⇒ 裸字符串相等会假不成立。
 *   realpath 抛错（鸿蒙 getcwd 偶发异常）⇒ 退化为原路径比较。
 * @returns {boolean}
 */
function isDirectRun() {
  const argvPath = process.argv[1];
  if (!argvPath) return false;
  const safe = (/** @type {string} */ p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  return safe(fileURLToPath(import.meta.url)) === safe(resolve(argvPath));
}

if (isDirectRun()) {
  process.exitCode = await main();
}

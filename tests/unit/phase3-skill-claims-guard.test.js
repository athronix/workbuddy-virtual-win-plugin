/**
 * Phase 3 · 批0 文档止血 —— SKILL/设计文档"宣称-实现一致性"静态守卫
 * （失实承诺回潮防线：承诺词必须与在建/未实现口径同段）
 *
 * 背景（2026-10-12 全维度体检 P0-3 / M5 / J 系）：失实承诺家族（宣称有→代码零实现）
 * 的根因是"没有宣称-实现一致性守卫"。本文件补齐批0 的机检面，三判据：
 *   a) skills/**\/*.md 内的点分 token（≥3 段）必须 ∈ `definitions.ts` 注册 id 全集
 *      ∪ 白名单（配置键路径 / 卡片判定谓词 / 文件路径 / 真实 /health 字段 /
 *      宿主桥 connector 工具名 / 显式标注"未注册"的规划项名）。
 *      —— pm2 §10 穷举的 4 串非能力域 token 照抄入白名单：
 *        agent.providers.workbuddy.options.endpoint（mcps-reference:59 = 配置键路径）
 *        preview.params.permanent / approval.preview.params（approval-card:111/:85 = 卡片谓词）
 *        tunnel.state.json（orchestrator:134 = 文件路径，同句已声明判定权威=CLI 输出）
 *        health.logging.degraded（orchestrator:430 = 真实 health 字段，file-logger.ts/server.ts 在册）
 *   b) `__approvalId` / `hostApproved` 在治理面文档（docs/02-design、skills、README、
 *      overview、GATE-POLICY）的出现行必须携带"批1 在建 / 不可达 / 不可依赖 / 否定式 /
 *      历史留痕"口径词 —— 防现在时承诺回潮（P0-1 四处承诺文案的守卫化）。
 *   c) `session-guard` / `Origin 校验` 宣称词同理：出现行必须携带"未实现 / 规划 /
 *      零命中 / 订正 / 历史留痕"口径词（P0-3 族①②的守卫化）。
 *
 * 纪律：纯 node stdlib；只读仓库文本，不 import 任何被测包；不写盘。
 * ⚠ 命名与内容红线：本文件通体不得出现被禁扫描词（见任务书红线①），
 *   判据实现全部走"点分 token + 中文口径词"路线，与该禁词族零交集。
 * 运行：node --test tests/unit/phase3-skill-claims-guard.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');

/** 读仓库内相对路径文本（静态守卫纪律：不经 dist，直接读源文件） */
const src = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');

/** 递归收集目录下全部 .md 文件（相对仓库根路径） */
function collectMd(dirRel) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e.endsWith('.md')) out.push(p.slice(ROOT.length + 1).split('\\').join('/'));
    }
  };
  const abs = resolve(ROOT, dirRel);
  if (statSync(abs, { throwIfNoEntry: false })?.isDirectory()) walk(abs);
  return out.sort();
}

/* ============================================================================
 * 事实源
 * ========================================================================== */

const DEFS_TS = 'packages/vm-capabilities/src/registry/definitions.ts';

/** 从注册表源文件提取全部能力 id（`id: 'x.y.z'` 字面量） */
function registeredIds() {
  const defs = src(DEFS_TS);
  const ids = new Set();
  for (const m of defs.matchAll(/id:\s*'([a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+)'/g)) {
    ids.add(m[1]);
  }
  assert.ok(ids.size >= 50, `注册表 id 提取异常（实得 ${ids.size}，应 ≥50——解析正则失效即守卫失效）`);
  return ids;
}

/* ============================================================================
 * 判据 a：SKILL/references 点分 token ∈ 注册 id ∪ 白名单
 * ========================================================================== */

/**
 * 白名单（逐类登记，出处=2026-10-12 体检 pm2 §10 穷举 + 批0 施工补充）：
 * ①配置键路径 / ②卡片判定谓词 / ③文件路径 / ④真实 health 字段（pm2 四串，照抄）
 * ⑤宿主桥 connector 工具名（host-a2a-bridge tools.ts 真实注册，非 VM 能力域）
 * ⑥显式标注"未注册/不可调用/规划项"的设想能力名（文档诚实引用，非幻觉教学）
 */
const TOKEN_WHITELIST = new Set([
  // ① 配置键路径
  'agent.providers.workbuddy.options.endpoint',
  // ② 卡片判定谓词
  'preview.params.permanent',
  'approval.preview.params',
  // ③ 文件路径
  'tunnel.state.json',
  'config.yaml.bak',
  // ④ 真实 /health 字段
  'health.logging.degraded',
  // ⑤ 宿主桥 connector 工具名（a2a.* 五件）
  'a2a.delegate',
  'a2a.task.get',
  'a2a.task.cancel',
  'a2a.approval.reply',
  'a2a.health',
  // ⑥ 诚实标注的未注册设想能力（出现处必须同行带"未注册/不可调用/规划"限定词，由判据 a2 强制）
  'app.default.manage',
  'app.process.activate',
  'gui.browser.control',
  'storage.volume.destructive',
]);

/** ⑥ 类 token 的诚实限定词（同行出现即可；否则视为幻觉教学回潮） */
const UNREGISTERED_QUALIFIER = /未注册|不可调用|当前不可用|规划|V2|不产生卡片|本系统不提供/;

const DOTTED_TOKEN_RE = /\b[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*){2,}\b/g;

describe('批0-a · SKILL 点分 token 必须 ∈ 注册 id ∪ 白名单', () => {
  test('skills/** 全部 ≥3 段点分 token 对账通过（注册表派生 ∪ 白名单逐类）', () => {
    const ids = registeredIds();
    const files = collectMd('skills');
    assert.ok(files.length >= 7, `skills/*.md 收集异常（实得 ${files.length}）`);
    const offenders = [];
    const honestOnly = [];
    for (const rel of files) {
      const lines = src(rel).split('\n');
      lines.forEach((line, i) => {
        for (const m of line.matchAll(DOTTED_TOKEN_RE)) {
          const tok = m[0];
          if (ids.has(tok)) continue;
          if (TOKEN_WHITELIST.has(tok)) {
            // ⑥ 类需同行携带"未注册"限定词
            if (/^(app\.|gui\.|storage\.)/.test(tok) && !UNREGISTERED_QUALIFIER.test(line)) {
              honestOnly.push(`${rel}:${i + 1}: ${tok}（白名单⑥但未同行标注未注册/规划）`);
            }
            continue;
          }
          offenders.push(`${rel}:${i + 1}: ${tok}`);
        }
      });
    }
    assert.deepEqual(offenders, [], `发现 SKILL 引用了注册表与白名单之外的点分 token（幻觉能力回潮？）：\n${offenders.join('\n')}`);
    assert.deepEqual(honestOnly, [], `⑥类设想能力出现处未携带"未注册/规划"限定词（诚实标注漂移）：\n${honestOnly.join('\n')}`);
  });
});

/* ============================================================================
 * 判据 b：`__approvalId` / `hostApproved` 口径词同段强制
 * ========================================================================== */

/** 治理面文本集合（文档+技能+入口文档；audit/changes 历史归档不在治理面——K-20 不回写史） */
function governanceDocs() {
  const fixed = ['README.md', 'overview.md', 'docs/06-OVERVIEW.md', 'scripts/GATE-POLICY.md'];
  return [...fixed.filter((f) => statSync(resolve(ROOT, f), { throwIfNoEntry: false })?.isFile()),
    ...collectMd('docs/02-design'), ...collectMd('skills')];
}

/**
 * "非现在时承诺"口径词表：命中任一即视为该出现处已诚实化。
 * 类别：在建指向（批1/在建）；不可用直陈（不可达/不可依赖/实际不可达）；
 * 否定/禁令（不得/不应/禁止/严禁/绝不/不要/勿）；机理直陈（一次性/删除/批准即删/吞并）；
 * 人工回退（人工/回滚/灰度）；历史留痕（根因/旧/曾/已废/划线 ~~）。
 */
// QA 回归 D-2 收紧（p3b02-regression）：旧词表含"勿/曾/人工/删除/吞并/根因"等超宽泛单字，
// 实测对抗样本"…勿需人工干预"靠撒一个"勿"字即放行=单字撒盐绕过。本轮仅剔除弱词，
// 保留"不得/不应"（合法否定式主力）；"勿"整体剔除（批0 已入库行实测零依赖单"勿"口径）。
const APPROVAL_CALIBER = /批\s*1|在建|不可达|不可依赖|勿依赖|不得|不应|禁止|严禁|绝不|一次性|批准即删|回滚|回退|灰度|已废|订正|根因|~~/;

describe('批0-b · 续跑承诺词（__approvalId / hostApproved）禁现在时回潮', () => {
  test('治理面每一处出现行必须携带"批1 在建/不可达/否定式/历史留痕"口径词', () => {
    // QA 回归加固（p3b02-regression，判据活性下限）：governanceDocs() 收集面若因目录
    // 改名/迁移而变空，b/c 两判据的 for 循环 0 次迭代 = 静默绿（恒真风险，正是本守卫
    // 反对的"写了看着有、其实不判"第四态）。现量=25 件（README/overview/06/GATE-POLICY
    // 4 件 + docs/02-design 12 件 + skills 9 件），下限钉 ≥20 防收集空转。
    const gov = governanceDocs();
    assert.ok(gov.length >= 20, `治理面收集异常（实得 ${gov.length} 件，应 ≥20——路径失效则 b/c 判据空转失明）`);
    const bad = [];
    for (const rel of gov) {
      const lines = src(rel).split('\n');
      lines.forEach((line, i) => {
        if (!/__approvalId|hostApproved/.test(line)) return;
        if (APPROVAL_CALIBER.test(line)) return;
        bad.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
      });
    }
    assert.deepEqual(bad, [], `出现未改述的续跑承诺（P0-1 四处承诺文案族回潮）：\n${bad.join('\n')}`);
  });

  test('K5 文档状态行 = 已落地口径（J-5 停更 13 天缺陷的钉死点）', () => {
    const k5 = src('docs/02-design/K5-server-replay-approval.md');
    const status = k5.split('\n').slice(0, 8).join('\n');
    assert.match(status, /已实现并真机验收|已落地/, 'K5 状态行须为落地口径');
    assert.ok(!/状态：设计定稿，待实现/.test(status), '旧"待实现"状态行不得回潮');
  });
});

/* ============================================================================
 * 判据 c：session-guard / Origin 校验 宣称词同理
 * ========================================================================== */

/** "未实现/规划/订正留痕"口径词表 */
const CLAIM_CALIBER = /未实现|规划|零命中|零实现|订正|诚实化|批\d|在建|~~|旧账|人工|不可自动|无自动/;

describe('批0-c · 失实宣称词（session-guard / Origin 校验）禁裸承诺回潮', () => {
  test('治理面每一处 session-guard 出现行必须携带"未实现/规划/人工"口径词', () => {
    const bad = [];
    for (const rel of governanceDocs()) {
      const lines = src(rel).split('\n');
      lines.forEach((line, i) => {
        if (!/session-guard/.test(line)) return;
        if (CLAIM_CALIBER.test(line)) return;
        bad.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
      });
    }
    assert.deepEqual(bad, [], `session-guard 以现时态能力面出现（P0-3 族①回潮）：\n${bad.join('\n')}`);
  });

  test('治理面每一处「Origin 校验」出现行必须携带未实现口径词（SECURITY:38 族②回潮防线）', () => {
    const bad = [];
    for (const rel of governanceDocs()) {
      const lines = src(rel).split('\n');
      lines.forEach((line, i) => {
        if (!/Origin\s*校验/.test(line)) return;
        if (CLAIM_CALIBER.test(line)) return;
        bad.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
      });
    }
    assert.deepEqual(bad, [], `Origin 校验以已实现承诺出现：\n${bad.join('\n')}`);
  });

  test('ARCH-09 previewHash 措辞钉死：出现处必须携带"批6 在建/为空"口径（用户终裁=补建）', () => {
    const bad = [];
    for (const rel of collectMd('docs/02-design')) {
      const lines = src(rel).split('\n');
      lines.forEach((line, i) => {
        if (!/previewHash|预览哈希|预览内容哈希/.test(line)) return;
        if (/批\s*6|在建|为空|恒\s*''|打通|未实现/.test(line)) return;
        bad.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
      });
    }
    assert.deepEqual(bad, [], `previewHash 绑定比对写成现在时已生效（A2-17 回潮）：\n${bad.join('\n')}`);
  });

  test('E-1 定性钉死：allowedCapabilities/maxRisk 宣称处须与"接线在建/尚未接线"或权威 §2.3 同域', () => {
    // 治理面上把两键写成"限定/封顶"现在时能力的行，必须同行携带在建/尚未接线/§2.3 指针
    const bad = [];
    for (const rel of collectMd('docs/02-design')) {
      const lines = src(rel).split('\n');
      lines.forEach((line, i) => {
        if (!/allowedCapabilities|maxRisk/.test(line)) return;
        // 只盯"承诺形态"：限定/封顶/授权话术
        if (!/限定|封顶|授权|强制/.test(line)) return;
        if (/尚未接线|在建|批\s*1|§2\.3|声明记录|声明性|不传两键|不得读作|不是已生效|按.*声明/.test(line)) return;
        bad.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
      });
    }
    assert.deepEqual(bad, [], `最小权限两键写成已生效安全闸（E-1 回潮）：\n${bad.join('\n')}`);
  });
});

/* ============================================================================
 * 判据自证（变异活性）：内存注入，零写盘
 * ========================================================================== */

describe('批0-d · 判据灵敏度自证（变异体必须命中正则，防守卫空转）', () => {
  test('b 判据变异：现在时承诺行必须被 APPROVAL_CALIBER 判为"不含口径词"（即会被拦）', () => {
    const mutant = '取得确认后，用同一参数并附 `__approvalId` 重新调用。';
    assert.ok(!APPROVAL_CALIBER.test(mutant), '变异体应不含任何口径词（否则判据 b 失明）');
    assert.ok(/__approvalId/.test(mutant));
  });

  test('c 判据变异：裸 session-guard 能力行必须被 CLAIM_CALIBER 漏外（即会被拦）', () => {
    const mutant = '`core/session` + `vm-capabilities/session-guard` 提供：';
    assert.ok(!CLAIM_CALIBER.test(mutant), '变异体应不含任何口径词（否则判据 c 失明）');
  });

  test('a 判据变异：伪造 token 不在注册表也不在白名单（即会被拦）', () => {
    const ids = registeredIds();
    const mutant = 'gui.quantum.drive';
    assert.ok(!ids.has(mutant) && !TOKEN_WHITELIST.has(mutant), '变异体应双落空（否则判据 a 失明）');
  });

  test('白名单 ⑥ 类出现处（现存四串）确实同行带限定词（判据非误伤的正面自证）', () => {
    const files = collectMd('skills');
    const checked = new Set();
    for (const rel of files) {
      for (const line of src(rel).split('\n')) {
        for (const tok of ['app.default.manage', 'app.process.activate', 'gui.browser.control']) {
          if (line.includes(tok)) {
            assert.ok(UNREGISTERED_QUALIFIER.test(line), `${rel} 中 ${tok} 行缺限定词`);
            checked.add(tok);
          }
        }
      }
    }
    assert.ok(checked.size >= 2, '至少两个⑥类 token 应在 skills 面在场被复核到（守卫覆盖活性）');
  });
});

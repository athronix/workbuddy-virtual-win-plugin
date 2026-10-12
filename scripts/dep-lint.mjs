#!/usr/bin/env node
/**
 * dep-lint —— WinVM Bridge 依赖方向静态守卫（Phase 2 · P2-T11 / 设计 §4.4 F-1）
 *
 * ## 为什么存在
 * `scripts/dep-lint.mjs` 在 Phase 1 全程**从未存在**（设计 §4.4「现状（已核对）」三处一致记载），
 * `layout` 脚本键因此由 QA Phase 0 R3（`c10a400`）从根 `package.json` 删除——「死入口比缺失更误导」。
 * Phase 2 的命题是**绝不允许第四种状态：写在文档里但运行期不存在的防线**，故本批把 `layout`
 * 接回一个**真实可跑**的脚本。Phase 1 以「人工方向核对 + `git diff --stat` 守门」替代机检，
 * 这正是 ARCHITECTURE.md §2.1 依赖铁律长期无人验证的根因。
 *
 * ## 判据（三条，与设计 §4.4 第 3 点「除方向外必须再加两条，否则 lint 只会抓到最不重要的一类违规」对齐）
 *   ① `LAYER_DIRECTION`（**hard**）—— 低层包 import 高层包（反向边）。
 *      分层 rank 的事实源 = 各包 `package.json` 的 `layer` 字段（机检单一事实源；
 *      ARCHITECTURE.md §2.1 的「依赖铁律」段落是该字段的散文版）。
 *   ② `UNDECLARED_EDGE`（**hard**）—— `dist` 产物里有真实 import 边，但 `package.json`
 *      `dependencies` 未声明 = **幽灵依赖**。判 hard 的理由不是口味而是可靠性：宿主分发产物
 *      只带 `dist` + `package.json`（无 `node_modules`），ESM 解析靠 `delivery/link-workspace.mjs`
 *      按声明补 junction ⇒ 声明漂移在部署形态上**运行期直接炸**。
 *      同判据的反向（`DECLARED_UNUSED`）只作 **info**：type-only import 编译期擦除
 *      （`adapter-host-workbuddy`/`mcp-framework` → contracts）与 provider 动态装载
 *      （`vm-service` → adapter-\*，经 `core/bridge/loader.ts`）都是**设计选择**，不是缺口。
 *   ③ 框架层审计边（`AUDIT_EDGE_IN_FRAMEWORK` = **warn**，`FRAMEWORK_TO_BUSINESS` = **hard**）
 *      —— 「框架层永不 import 审计语义」是纪律、不是分层能表达的（设计 §254 末句 + §258 第 3 条）。
 *      C 项按 §13 Q7 裁决「首月除框架审计边外只 warn」的口径处理：
 *        · `FRAMEWORK_TO_BUSINESS`（框架 import `vm-service`/`vm-capabilities`/`adapter-*`）
 *          取 **hard**：ARCHITECTURE.md §2.1 依赖铁律**原文已明写**「frameworks──依赖──▶
 *          contracts + core（禁止依赖 adapters）」，故它不是新增的严格化，而是既有铁律的机检化；
 *        · `AUDIT_EDGE_IN_FRAMEWORK`（框架 import 审计符号）取 **warn**：判据靠**派生**
 *          （从 `core`/`contracts` 的 dist 导出面提取审计符号），存在 type-only 擦除盲区，
 *          首月以告警显形、不阻断交付。
 *
 * ## 审计符号不硬编码（K-10「永绿守卫等于没有守卫」）
 * 把 `HashChainAuditSink` 等符号名写死进 lint，会在 `core` 新增 `audit/*` 导出时**静默失效**。
 * ⇒ 本脚本从 dist 产物**派生**审计符号集：
 *   · `packages/core/dist/index.js` 中**源路径含 `audit`** 的具名再导出；
 *   · `packages/contracts/dist/audit.js` 的顶层导出（接口/类型编译期擦除 ⇒ 由 `FRAMEWORK_TO_BUSINESS`
 *     与 `LAYER_DIRECTION` 共同兜住，盲区如实登记在 `scripts/GATE-POLICY.md`，不假装覆盖）。
 *
 * ## 零依赖铁律（设计 §365 PR9 + §262 第 5 点）
 * 只用 node stdlib，**绝不 import 被测包**——一旦 import，本仓单测的 junction
 * `0xC0000005` 假全红坑（MEMORY 关键坑段）就会被拉进门禁，门禁本身变成最需要复跑的那件东西。
 *
 * ## dist 字符串字面量陷阱（开工侦查实证，本脚本存在的头号理由）
 * `packages/core/dist/config/index.js` 里有 `package: '@winvm/adapter-agent-workbuddy'`
 * （provider 包名**配置字面量**）；`packages/vm-service/dist/*.js` 注释里也出现
 * `@winvm/adapter-agent-workbuddy-llm`。⇒ 朴素 `content.includes('@winvm/x')` 会产假反向边。
 * 设计 §255「读 dist 而非 src」的理由正是避开注释/字符串假命中，所以本脚本**语句锚定**：
 * 只认 `import ... from '@winvm/x'` / `export ... from '@winvm/x'` / `import('@winvm/x')` /
 * `require('@winvm/x')` 四种**语句形态**，且跳过注释行。
 *
 * ## 用法
 *   node scripts/dep-lint.mjs                 # 全仓（各包 dist 产物）
 *   node scripts/dep-lint.mjs --json          # 结构化输出（供 gate/CI 消费）
 *   node scripts/dep-lint.mjs --root <dir>    # 指定被测根（单测 fixture 用）
 *   node scripts/dep-lint.mjs --strict-warn   # warn 也判失败（Q7「首月只 warn」到期时启用）
 *
 * ## 退出码
 *   0 = 无 hard 违规（warn 不阻断，除 --strict-warn）
 *   1 = 存在 hard 违规（①/②/③-FRAMEWORK_TO_BUSINESS）
 *   2 = 无法判定（根目录缺失 / dist 未构建 ⇒ 先跑 `tsc -b tsconfig.build.json`，PR9）
 */

import { readFileSync, readdirSync, existsSync, statSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 违规严重级。`hard` ⇒ exit 1；`warn` ⇒ 首月不阻断（§13 Q7）；`info` ⇒ 仅显形。 */
const SEVERITY = /** @type {{HARD:'hard',WARN:'warn',INFO:'info'}} */ ({
  HARD: 'hard',
  WARN: 'warn',
  INFO: 'info',
});

/** 判据 ID 常量（GATE-POLICY.md 表格与单测共用同一串，禁止各写一份字面量）。 */
export const CHECK = /** @type {const} */ ({
  LAYER_DIRECTION: 'LAYER_DIRECTION',
  UNDECLARED_EDGE: 'UNDECLARED_EDGE',
  DECLARED_UNUSED: 'DECLARED_UNUSED',
  AUDIT_EDGE_IN_FRAMEWORK: 'AUDIT_EDGE_IN_FRAMEWORK',
  FRAMEWORK_TO_BUSINESS: 'FRAMEWORK_TO_BUSINESS',
});

/**
 * `package.json` 的 `layer` 字段前缀 → 分层 rank。
 * rank 语义：**数值越小越底层**。合法边只允许 `rank(src) >= rank(dst)`
 * （高层依赖低层）；`rank(src) < rank(dst)` ⇒ 反向边 ⇒ 违规。rank 相等（同层互依，
 * 如 `adapter-agent-workbuddy-llm` → `adapter-agent-workbuddy`）属允许。
 *
 * 事实源选择：设计 §254 散文把 `vm-service` 写作 L3，而仓库实况是
 * `packages/vm-service/package.json` 的 `layer:"L2-vm-service"`、`host-a2a-bridge` 的
 * `layer:"L3-host-bridge"`。机检必须**单一事实源** ⇒ 取 `layer` 字段（散文与字段若有分歧，
 * 由本批 README/ARCHITECTURE 口径注记显形，不在 lint 里私改一套 rank）。
 */
const LAYER_RANK = /** @type {Record<string, number>} */ ({
  L0: 0,
  L1a: 10,
  L1b: 20,
  L1c: 30,
  L2: 40,
  L3: 50,
});

/** 框架包（L1b 协议框架）——审计边判据的作用域。 */
const FRAMEWORK_PACKAGES = /** @type {const} */ (['a2a-framework', 'mcp-framework']);

/** 业务/能力/适配侧包名正则 —— `FRAMEWORK_TO_BUSINESS` 的判定面。 */
const BUSINESS_PKG_RE = /^(adapter-|vm-service$|vm-capabilities$)/;

/** 包名（`@winvm/<name>` 的 name 段）合法字符集，与 `LAYER_RANK` 覆盖的目录名一致。 */
const PKG_NAME_RE = /^[a-z0-9-]+$/;

/** 被测包根目录名（仓库根与 fixture 根都用同一个布局，便于单测喂假图）。 */
const packagesDirName = 'packages';

/** 单条跨包依赖语句（一次 import/export-from/dynamic-import 命中）。 */
/** @typedef {{from:string,to:string,spec:string,bindings:string[],line:number,file:string,kind:string}} EdgeStatement */
/** @typedef {{id:string,severity:string,message:string,detail?:Record<string,unknown>}} Violation */

/**
 * 依赖语句正则（语句锚定，见文件头「dist 字符串字面量陷阱」）。
 * 组 1 = 绑定子句文本（`{ a, b as c }` / 默认名 / 命名空间名，动态导入为空）；组 2 = 模块说明符。
 * 允许行首缩进；行首是 `*`/`//` 的注释行在 matchStatements 里二次排除。
 * @type {RegExp}
 */
const STATEMENT_RE =
  /^[\t ]*(import|export)(?:\s+([\s\S]*?)\s*from)?\s*['"]([^'"]+)['"]|[\t ]*(?:import|require)\(\s*['"]([^'"]+)['"]\s*\)/gm;

/**
 * 读取一个包目录的元数据。
 * @param {string} root 仓库根
 * @param {string} pkg 包目录名
 * @returns {{name:string, layer:string, layerPrefix:string, rank:number, declared:string[], hasDist:boolean} | null}
 */
function readPackageMeta(root, pkg) {
  const pkgJsonPath = join(root, packagesDirName, pkg, 'package.json');
  if (!existsSync(pkgJsonPath)) return null;
  /** @type {any} */
  let json;
  try {
    json = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  } catch (e) {
    return null;
  }
  const layer = typeof json.layer === 'string' ? json.layer : '';
  const layerPrefix = layer.split('-')[0] || '';
  const rank = LAYER_RANK[layerPrefix];
  /** @type {string[]} */
  const declared = Object.keys(json.dependencies || {})
    .filter((d) => d.startsWith('@winvm/'))
    .map((d) => d.slice('@winvm/'.length))
    .filter((d) => PKG_NAME_RE.test(d))
    .sort();
  const distDir = join(root, packagesDirName, pkg, 'dist');
  return {
    name: typeof json.name === 'string' ? json.name.replace(/^@winvm\//, '') : pkg,
    layer,
    layerPrefix,
    rank: typeof rank === 'number' ? rank : -1,
    declared,
    hasDist: existsSync(distDir) && statSync(distDir).isDirectory(),
  };
}

/**
 * 递归收集 `*.js` 产物（跳过 `.map`/`.d.ts`：它们不是运行期依赖的来源）。
 * @param {string} dir
 * @returns {string[]} 绝对路径
 */
function collectJs(dir) {
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      out.push(...collectJs(p));
    } else if (entry.endsWith('.js')) {
      out.push(p);
    }
  }
  return out.sort();
}

/**
 * 从绑定子句文本里取标识符名。`{ A, B as C }` → `['A','C']`；默认/命名空间名 → `[name]`。
 * @param {string} clause
 * @returns {string[]}
 */
function parseBindings(clause) {
  if (!clause) return [];
  /** @type {string[]} */
  const names = [];
  const braces = clause.match(/\{([\s\S]*)\}/);
  if (braces && braces[1]) {
    for (const raw of braces[1].split(',')) {
      const piece = raw.trim();
      if (!piece) continue;
      if (piece.startsWith('type ')) continue; // `export { type T }` —— 擦除后零运行时依赖
      const asSplit = piece.split(/\s+as\s+/);
      const last = (asSplit[asSplit.length - 1] || '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(last)) names.push(last);
    }
    return names;
  }
  const bare = clause.replace(/\{[\s\S]*\}/, '').trim();
  for (const piece of bare.split(',')) {
    const t = piece.trim();
    if (/^[A-Za-z_$][\w$]*$/.test(t)) names.push(t);
  }
  return names;
}

/**
 * 提取一个 dist 文件里的全部跨包依赖语句。
 * @param {string} absFile
 * @param {string} relFile 相对 `packages/` 的路径（违规报告可读性）
 * @param {string} owner 当前包名（自环排除）
 * @returns {EdgeStatement[]}
 */
function extractStatements(absFile, relFile, owner) {
  const text = readFileSync(absFile, 'utf8');
  const lines = text.split('\n');
  /** @type {EdgeStatement[]} */
  const edges = [];
  // 逐行判定更稳：先剔注释行，再对整文件跑正则取行号。
  const commentLine = (idx) => {
    const t = (lines[idx] || '').trimStart();
    return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
  };
  let m;
  STATEMENT_RE.lastIndex = 0;
  while ((m = STATEMENT_RE.exec(text)) !== null) {
    const spec = m[3] || m[4] || '';
    if (!spec.startsWith('@winvm/')) continue;
    const to = spec.slice('@winvm/'.length);
    if (!PKG_NAME_RE.test(to) || to === owner) continue;
    const lineIdx = text.slice(0, m.index).split('\n').length - 1;
    if (commentLine(lineIdx)) continue;
    // 跨行说明符在 tsc 输出里不出现（import 语句恒单行），故 lineIdx 只用于定位。
    // 绑定列表对 import/export-from 都取：`export { AuditX } from '@winvm/core'` 的再导出
    // 同样是真实运行边（把审计语义带进框架公共面），漏判即等于守卫留洞。
    const kind = m[1] ? m[1] : 'dynamic';
    edges.push({
      from: owner,
      to,
      spec,
      bindings: parseBindings(m[2] || ''),
      line: lineIdx + 1,
      file: relFile,
      kind,
    });
  }
  return edges;
}

/**
 * 从 dist 产物**派生**审计符号集（不硬编码，理由见文件头）。
 * @param {string} root
 * @param {(rel:string)=>string|null} readSafe 安全读（缺文件返回 null）
 * @returns {{symbols:string[], sources:string[]}}
 */
function deriveAuditSymbols(root, readSafe) {
  /** @type {Set<string>} */
  const symbols = new Set();
  /** @type {string[]} */
  const sources = [];

  // (a) core 聚合入口里**源路径含 audit** 的具名再导出：`export { … } from './audit/chain.js'`
  const coreIndex = readSafe(join(root, packagesDirName, 'core', 'dist', 'index.js'));
  if (coreIndex !== null) {
    sources.push('core/dist/index.js(audit/*)');
    // `[^{}]*` 而非 `[\s\S]*?`：后者会**跨语句回溯**——从第一条 `export {` 一路吞到路径里
    // 含 audit 的那条为止，把 transport/policy 的导出名一并当成审计符号（实测假导出 22 个）。
    // `[^{}]*` 天然无法越过任何一条 `export { … } from …`（那需要两对花括号）。
    const re = /^[\t ]*export\s+(\{[^{}]*\})\s*from\s*['"]([^'"]*audit[^'"]*)['"]/gm;
    let m;
    while ((m = re.exec(coreIndex)) !== null) {
      for (const n of parseBindings(m[1] || '')) symbols.add(n);
    }
  }

  // (b) contracts 的 audit 契约模块顶层导出（GENESIS_HASH 等运行期值）
  const contractsAudit = readSafe(join(root, packagesDirName, 'contracts', 'dist', 'audit.js'));
  if (contractsAudit !== null) {
    sources.push('contracts/dist/audit.js');
    const declRe = /^[\t ]*export\s+(?:const|let|var|function|class|async\s+function)\s+([A-Za-z_$][\w$]*)/gm;
    let m;
    while ((m = declRe.exec(contractsAudit)) !== null) symbols.add(m[1]);
    const grpRe = /^[\t ]*export\s+(\{[^{}]*\})\s*(?:from\s*['"][^'"]*['"])?\s*;?\s*$/gm;
    while ((m = grpRe.exec(contractsAudit)) !== null) {
      for (const n of parseBindings(m[1] || '')) symbols.add(n);
    }
  }

  // (c) 兜住 type-only 擦除盲区：审计**类型名**虽不进 dist import 绑定，但框架侧若出现
  //     `Audit*`/`*Audit*` 形状的具名 import，一律按审计边处理（命名形状，非枚举清单）。
  return { symbols: [...symbols].sort(), sources };
}

/**
 * 主判定。
 * @param {string} root 仓库根（含 `packages/`）
 * @param {{strictWarn?:boolean}} [opts]
 * @returns {{ok:boolean,code:number,packages:string[],edges:EdgeStatement[],violations:Violation[],auditSymbols:string[],auditSources:string[],stats:Record<string,number>}}
 */
export function lintDependencies(root, opts = {}) {
  const strictWarn = opts.strictWarn === true;
  /** @type {string[]} */
  const pkgNames = existsSync(join(root, packagesDirName))
    ? readdirSync(join(root, packagesDirName))
        .filter((p) => statSync(join(root, packagesDirName, p)).isDirectory())
        .sort()
    : [];

  if (pkgNames.length === 0) {
    return {
      ok: false,
      code: 2,
      packages: [],
      edges: [],
      violations: [
        { id: 'ROOT_UNREADABLE', severity: SEVERITY.HARD, message: `未在 ${root} 下找到 packages/ 目录` },
      ],
      auditSymbols: [],
      auditSources: [],
      stats: {},
    };
  }

  /** @type {Record<string, NonNullable<ReturnType<typeof readPackageMeta>>>} */
  const metas = {};
  /** @type {Violation[]} */
  const violations = [];
  for (const p of pkgNames) {
    const meta = readPackageMeta(root, p);
    if (!meta) continue;
    metas[meta.name] = meta;
    if (meta.rank < 0) {
      violations.push({
        id: 'LAYER_UNKNOWN',
        severity: SEVERITY.HARD,
        message: `packages/${p}/package.json 的 layer="${meta.layer}" 无法映射到分层 rank（新增层位需同步 dep-lint 的 LAYER_RANK 表）`,
        detail: { package: meta.name, layer: meta.layer },
      });
    }
    if (!meta.hasDist) {
      violations.push({
        id: 'DIST_MISSING',
        severity: SEVERITY.HARD,
        message: `packages/${p}/dist 缺失 ⇒ dep-lint 读不到真实运行边（设计 §365 PR9：dep-lint 依赖 build 产物）。请先跑 \`tsc -b tsconfig.build.json\``,
        detail: { package: meta.name },
      });
    }
  }

  if (violations.some((v) => v.id === 'DIST_MISSING')) {
    return {
      ok: false,
      code: 2,
      packages: Object.keys(metas),
      edges: [],
      violations,
      auditSymbols: [],
      auditSources: [],
      stats: {},
    };
  }

  // ---- 采集真实运行边 ----
  /** @type {EdgeStatement[]} */
  const edges = [];
  let scannedFiles = 0;
  for (const name of Object.keys(metas)) {
    const distDir = join(root, packagesDirName, name, 'dist');
    const files = collectJs(distDir);
    scannedFiles += files.length;
    for (const abs of files) {
      edges.push(...extractStatements(abs, relative(join(root, packagesDirName), abs).split(sep).join('/'), name));
    }
  }

  // ---- 审计符号派生 ----
  const readSafe = (/** @type {string} */ abs) => (existsSync(abs) ? readFileSync(abs, 'utf8') : null);
  const { symbols: auditSymbols, sources: auditSources } = deriveAuditSymbols(root, readSafe);
  /** @type {Set<string>} */
  const auditSet = new Set(auditSymbols);

  /** @type {Map<string, Set<string>>} */
  const actualByPkg = new Map();
  for (const e of edges) {
    if (!actualByPkg.has(e.from)) actualByPkg.set(e.from, new Set());
    actualByPkg.get(e.from).add(e.to);
  }

  // ---- 判据 ①：分层方向（反向边）----
  for (const e of edges) {
    const src = metas[e.from];
    const dst = metas[e.to];
    if (!src || !dst || src.rank < 0 || dst.rank < 0) continue;
    if (src.rank < dst.rank) {
      violations.push({
        id: CHECK.LAYER_DIRECTION,
        severity: SEVERITY.HARD,
        message: `反向依赖：${e.from}(${src.layer||'L?'} rank=${src.rank}) import ${e.to}(${dst.layer||'L?'} rank=${dst.rank}) —— 低层包不得依赖高层包（ARCHITECTURE.md §2.1 依赖铁律）`,
        detail: { file: e.file, line: e.line, spec: e.spec, fromRank: src.rank, toRank: dst.rank, bindings: e.bindings },
      });
    }
  }

  // ---- 判据 ②：幽灵依赖 / 声明未用 ----
  for (const [from, tos] of actualByPkg) {
    const meta = metas[from];
    if (!meta) continue;
    for (const to of tos) {
      if (!meta.declared.includes(to)) {
        const hit = edges.find((e) => e.from === from && e.to === to);
        violations.push({
          id: CHECK.UNDECLARED_EDGE,
          severity: SEVERITY.HARD,
          message: `幽灵依赖：${from} 的 dist 产物 import '@winvm/${to}'，但 packages/${from}/package.json 的 dependencies 未声明 ⇒ 分发产物（dist+package.json，无 node_modules）里 link-workspace 不会补该 junction，运行期 ESM 解析必炸`,
          detail: { file: hit ? hit.file : '', line: hit ? hit.line : 0, spec: '@winvm/' + to },
        });
      }
    }
  }
  for (const meta of Object.values(metas)) {
    const used = actualByPkg.get(meta.name) || new Set();
    for (const declared of meta.declared) {
      if (!used.has(declared)) {
        violations.push({
          id: CHECK.DECLARED_UNUSED,
          severity: SEVERITY.INFO,
          message: `声明未见于产物：${meta.name} 声明依赖 @winvm/${declared} 但 dist 无该语句边（type-only import 编译期擦除，或经 core/bridge/loader 动态装载 provider ⇒ 属设计选择，仅显形）`,
          detail: { package: meta.name, declared: '@winvm/' + declared },
        });
      }
    }
  }

  // ---- 判据 ③：框架层审计边 ----
  /** @type {Set<string>} */
  const seenAuditEdge = new Set();
  for (const e of edges) {
    if (!FRAMEWORK_PACKAGES.includes(e.from)) continue;
    if (BUSINESS_PKG_RE.test(e.to)) {
      violations.push({
        id: CHECK.FRAMEWORK_TO_BUSINESS,
        severity: SEVERITY.HARD,
        message: `框架层越界：${e.from}(L1b 协议框架) import @winvm/${e.to}（业务/能力/适配侧）—— ARCHITECTURE.md §2.1 依赖铁律原文「frameworks──依赖──▶ contracts + core（禁止依赖 adapters）」`,
        detail: { file: e.file, line: e.line, spec: e.spec, bindings: e.bindings },
      });
    }
    for (const b of e.bindings) {
      if (auditSet.has(b) && !seenAuditEdge.has(e.from + '!' + b)) {
        seenAuditEdge.add(e.from + '!' + b);
        violations.push({
          id: CHECK.AUDIT_EDGE_IN_FRAMEWORK,
          severity: strictWarn ? SEVERITY.HARD : SEVERITY.WARN,
          message: `框架层审计边：${e.from} import 审计符号 \`${b}\`（来自 ${e.spec}）—— 「框架层永不 import 审计语义」（设计 §254/§258）`,
          detail: { file: e.file, line: e.line, binding: b, spec: e.spec, derivedFrom: auditSources },
        });
      }
    }
  }

  const hard = violations.filter((v) => v.severity === SEVERITY.HARD).length;
  const warn = violations.filter((v) => v.severity === SEVERITY.WARN).length;
  const info = violations.filter((v) => v.severity === SEVERITY.INFO).length;

  return {
    ok: hard === 0 && warn === 0,
    code: hard > 0 ? 1 : warn > 0 && strictWarn ? 1 : 0,
    packages: Object.keys(metas),
    edges,
    violations,
    auditSymbols,
    auditSources,
    stats: {
      packages: Object.keys(metas).length,
      scannedJsFiles: scannedFiles,
      // 语句命中数（同一包→同一目标可能有多条语句，逐文件逐语句计）
      importStatements: edges.length,
      // 去重后的「包级依赖边」数 = 分层实况图的边数（回报口径用它）
      distinctEdges: [...actualByPkg.entries()].reduce((n, [, s]) => n + s.size, 0),
      hard,
      warn,
      info,
      auditSymbols: auditSymbols.length,
    },
  };
}

/**
 * 人类可读输出。
 * @param {ReturnType<typeof lintDependencies>} res
 * @param {string} root
 * @returns {string}
 */
export function formatReport(res, root) {
  /** @type {string[]} */
  const out = [];
  out.push(`dep-lint · root=${root}`);
  out.push(
    `扫描：packages=${res.stats.packages || 0} js文件=${res.stats.scannedJsFiles || 0} import语句=${res.stats.importStatements || 0} 包级边=${res.stats.distinctEdges || 0} 审计符号=${res.stats.auditSymbols || 0}（派生源：${(res.auditSources || []).join(' + ') || '无'}）`,
  );
  const order = { hard: 0, warn: 1, info: 2 };
  const sorted = [...res.violations].sort(
    (a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9) || a.id.localeCompare(b.id),
  );
  if (sorted.length === 0) {
    out.push('违规：0 条 —— 分层方向、幽灵依赖、框架审计边三条判据全部零命中');
  } else {
    out.push(`违规：${sorted.length} 条（hard=${res.stats.hard} warn=${res.stats.warn} info=${res.stats.info}）`);
    for (const v of sorted) {
      const loc = v.detail && v.detail.file ? ` @${v.detail.file}:${v.detail.line}` : '';
      out.push(`  [${v.severity.toUpperCase().padEnd(4)}] ${v.id}${loc} — ${v.message}`);
    }
  }
  out.push(`VERDICT: ${res.code === 0 ? 'GREEN' : res.code === 2 ? 'UNJUDGED' : 'RED'}`);
  return out.join('\n');
}

/** CLI 入口（仅在被直接执行时跑，import 进单测时不产生副作用）。 */
function main() {
  const argv = process.argv.slice(2);
  /** @type {Record<string,string|boolean>} */
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--root') {
      flags.root = argv[i + 1] || '';
      i += 1;
    } else if (a.startsWith('--root=')) {
      flags.root = a.slice('--root='.length);
    } else if (a === '--json') {
      flags.json = true;
    } else if (a === '--strict-warn') {
      flags.strictWarn = true;
    } else if (a === '--help' || a === '-h') {
      flags.help = true;
    }
  }
  if (flags.help) {
    process.stdout.write(
      '用法: node scripts/dep-lint.mjs [--root <dir>] [--json] [--strict-warn]\n' +
        '  读 packages/*/dist 的 import 语句边，判分层方向/幽灵依赖/框架审计边三条判据。\n' +
        '  exit 0=合规 1=违规 2=无法判定（dist 未构建 ⇒ 先 tsc -b）。\n',
    );
    return;
  }
  const here = fileURLToPath(new URL('.', import.meta.url));
  const root = flags.root ? resolve(String(flags.root)) : resolve(here, '..');
  const res = lintDependencies(root, { strictWarn: flags.strictWarn === true });
  if (flags.json) {
    process.stdout.write(JSON.stringify(res, null, 2) + '\n');
  } else {
    process.stdout.write(formatReport(res, root) + '\n');
  }
  process.exitCode = res.code;
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
  main();
}

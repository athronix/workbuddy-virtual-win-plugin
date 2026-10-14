#!/usr/bin/env node
/**
 * config-key-lint —— 服务配置**全键集白名单**静态检查（Phase 2 · P2-T11 / 设计 §13.2-②）
 *
 * ## 为什么存在（不是我又发明一条规矩）
 * 设计 §13.2「P2-T2 复核追加」第 ② 条，独立验证者遗留、主理人明令转入本批：
 *   「**policy 全键集白名单守卫**（现仅逐键告警已知死键，任意未知键仍静默透传）⇒
 *     列入 **P2-T11 gate 候选判据**（gate.mjs『哪些判据进门禁』表里补一行）」
 *
 * 本文件的实测（K-10 精神：先证伪，别写永绿守卫）确认「静默透传」成立：
 *   `validateServiceConfig({...DEFAULT_SERVICE_CONFIG, policy:{totallyUnknownKey:1}})`
 *   ⇒ `errors=0 / warnings=0`；顶层多一个 `notASection` 同样零告警。
 * `validateServiceConfig` 只逐键认识 `policy.approvalTimeoutMs` 这一个**已知**死键（P2-T2，
 * 判据钉在 `phase2-dead-config.test.js`），其它任意拼错/历史遗留的键名一律**无声穿过**。
 * 病灶与 ARCH-18 的命令白名单、P2-T2 的 approvalTimeoutMs 同族：**配了却不生效还不吭声 = 假安全感**。
 *
 * ## 为什么是**静态交付面**守卫，而不是往 `validateServiceConfig` 加运行期告警
 * 两条既有纪律同时禁止运行期版本：
 *   ① **Q1=(b) 裁决**：交付面单测 + 门禁，不入运行期；
 *   ② **运行期零新依赖纪律**（`phase2-contract-schema.test.js` 头注原文：运行期（vm-service
 *      启动/能力注册）**不**接本校验）。
 * ⇒ 本工具在**部署前**把仓内配置资产的全部键名过一遍白名单，红就是红（exit 1），
 *   而不是等运行期一条永远不会出现的告警。运行期行为**零改动**（本批 src 零触碰）。
 *
 * ## 白名单从 TS 类型**派生**，不抄第二份清单
 * 清单手写 = 第二事实源 = 漂移风险（`PolicyConfig` 加了键而清单没跟上 ⇒ 合法键被判未知，
 * 或者反过来悄悄漏判）。⇒ 每次运行时从既有源码现读：
 *   `PolicyConfig` ← `packages/core/src/policy/defaults.ts`（该 interface 的 `readonly x?:` 成员名）
 *   其它段        ← `packages/core/src/config/index.ts` 各 `export interface XxxConfig`
 * 顶层段名 ← `export interface ServiceConfig`。
 * 若 interface 缺失（被改名/删除），本工具**拒绝判定**（exit 2）而不是当白名单为空——
 * 「判不了」和「判违规」是两件事，混淆会让工具自身的失效表现成一条真违规。
 *
 * ## 允许键（刻意放行，不是漏判）
 *   `$schema` / `comment` / `_comment` —— 注释性键：本仓配置资产（`delivery/vm-service.config.json`
 *     的 `policy.comment`）已在用，禁掉会让工具开箱即红，属误伤。
 *   `providers` 的**键名是 provider id**（任意合法标识符，由 `agent.provider` 选单），
 *     不按白名单判；`transport.preferred[]` 是数组项，同样不按对象键判。
 *
 * ## 零依赖（PR9 同族纪律：不 import 被测包 ⇒ 避开本仓 junction 假红坑）
 *
 * ## 用法
 *   node scripts/config-key-lint.mjs                      # 扫默认目标（delivery 配置资产）
 *   node scripts/config-key-lint.mjs --path a.json --path b.json
 *   node scripts/config-key-lint.mjs --json               # 机读（gate 消费）
 *   node scripts/config-key-lint.mjs --root <dir>         # fixture 根（单测喂假源码/假配置）
 *
 * ## 退出码
 *   0 = 全部键在白名单内  1 = 有未知键（附 文件/段路径/键名/近似合法键提示）
 *   2 = 无法判定（源码缺 interface ⇒ 白名单不可得，不猜）
 */

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 注释性/元数据键：刻意放行（见文件头「允许键」）。 */
export const METADATA_KEYS = /** @type {const} */ (['$schema', 'comment', '_comment', 'note', 'notes']);

/**
 * 判定深度 = **两层**（顶层段名 + 段内键名）。更深层刻意不判，理由写死在这里而不是靠运气：
 *   `agent.providers.<id>` 的 `<id>` 是 provider 名（`workbuddy` / `hermes-agent` / 自定义，
 *   由 `agent.provider` 选单）、`transport.preferred[]` 是数组项、`providers.<id>.options`
 *   是各家 provider 的自由参数集 —— 都是**天然开放集合**，按白名单判必误伤，
 *   误伤的工具会让人学会忽略它（比没有工具更糟）。
 */
export const JUDGED_DEPTH = 2;

/**
 * interface 的**搜索根**（相对仓库根）。
 * 不写「段名 → 具体文件」的映射：interface 被挪文件是常事（实况即如此 ——
 * `PolicyConfig` 在 `policy/defaults.ts`、`AgentProviderConfig` 在 `bridge/loader.ts`、
 * `LoggingConfig`/`LlmSessionConfig` 在 `constants.ts`、`TransportDecl` 在 transport 面）。
 * 硬编码文件路径 = 第二事实源 + 一改即失效 ⇒ 改为在 core/contracts 的 src 全域**现搜**，
 * 搜不到才判「无法判定」。
 */
const INTERFACE_SEARCH_ROOTS = /** @type {readonly string[]} */ ([
  'packages/core/src',
  'packages/contracts/src',
]);

/**
 * 从 TS 源码里抠出一个 interface 的**成员键名**列表。
 * 手法：定位 `export interface Name {` → 花括号配平取块 → 逐行取 `readonly name` / `name`。
 * ⚠ 不用行号（Phase 1 纪律：锚点切片计数，行号必漂移）。
 * @param {string} ts 源码文本
 * @param {string} name interface 名
 * @returns {string[]|null} null = 未找到该 interface（调用方须判「无法判定」）
 */
export function extractInterfaceKeys(ts, name) {
  const re = new RegExp(`export\\s+interface\\s+${name}\\s*(?:extends\\s+[\\w,\\s<]*?)?\\{`, 'g');
  const m = re.exec(ts);
  if (!m) return null;
  const start = ts.indexOf('{', m.index + m[0].length - 1);
  if (start < 0) return null;
  let depth = 0;
  let end = -1;
  for (let i = start; i < ts.length; i += 1) {
    const ch = ts[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return null;
  const body = ts.slice(start + 1, end);
  /** @type {Set<string>} */
  const keys = new Set();
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('*') || line.startsWith('//') || line.startsWith('/*')) continue;
    // 成员形态：`readonly foo: T` / `readonly foo?: T` / `foo: T` / `foo?: T`
    const km = line.match(/^(?:readonly\s+)?['"]?([A-Za-z_$][\w$]*)['"]?\??\s*:/);
    if (km) keys.add(km[1]);
  }
  return [...keys].sort();
}

/**
 * 在搜索根下收集全部 `.ts` 源码文本（跳过 `.d.ts`/dist/node_modules）。
 * @param {string} root
 * @returns {{rel:string, text:string}[]}
 */
function collectTsSources(root) {
  /** @type {{rel:string, text:string}[]} */
  const out = [];
  for (const base of INTERFACE_SEARCH_ROOTS) {
    const abs = join(root, base);
    if (!existsSync(abs)) continue;
    const walk = (/** @type {string} */ d) => {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        const st = statSync(p);
        if (st.isDirectory()) walk(p);
        else if (e.endsWith('.ts') && !e.endsWith('.d.ts')) {
          out.push({ rel: p.slice(root.length + 1).split(sep).join('/'), text: readFileSync(p, 'utf8') });
        }
      }
    };
    walk(abs);
  }
  return out;
}

/** 花括号配平：返回 `openIdx` 处 `{` 对应的 `}` 下标，或 -1。 */
function matchBrace(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 从一个 TS 成员块（`{}` 内部文本）取键名。 */
function memberKeys(body) {
  /** @type {Set<string>} */
  const keys = new Set();
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('*') || line.startsWith('//') || line.startsWith('/*')) continue;
    const km = line.match(/^(?:readonly\s+)?['"]?([A-Za-z_$][\w$]*)['"]?\??\s*:/);
    if (km) keys.add(km[1]);
  }
  return [...keys];
}

/**
 * 构建全键白名单 —— 从 `ServiceConfig` 的**成员类型表达式**逐段解析（不抄第二份清单）。
 *
 * 支持的形态（全部是本仓实况）：
 *   `readonly policy: Partial<PolicyConfig>` → 解 `PolicyConfig` interface
 *   `readonly transport: { preferred: readonly TransportDecl[] }` → 内联对象字面量
 *   `TransportDecl = SshTunnelTransport | StreamableHttpTransport | StdioTransport`（union type）
 *     → 各分支 interface 键名取**并集**（`kind` 判别位对所有分支都算合法）
 *   `readonly providers: Record<string, ProviderOptions>` → 开放键 ⇒ 不判该成员
 * @param {string} root
 * @returns {{sections:Record<string,string[]>, service:string[], missing:string[], unresolved:string[]}}
 *   `missing` 非空 ⇒ 白名单不可得 ⇒ 调用方须拒绝判定（exit 2）。
 */
export function buildWhitelist(root) {
  const srcs = collectTsSources(root);
  if (srcs.length === 0) return { sections: {}, service: [], missing: ['<无 TS 源码>'], unresolved: [] };

  /** interface 名 → 成员键名 */
  const interfaces = /** @type {Map<string,string[]>} */ (new Map());
  /** interface 名 → 成员名→类型表达式 */
  const interfaceMembers = /** @type {Map<string,Record<string,string>>} */ (new Map());
  /** type 别名名 → 右值文本 */
  const typeAliases = /** @type {Map<string,string>} */ (new Map());
  for (const { text } of srcs) {
    const ire = /export\s+interface\s+([A-Za-z_$][\w$]*)[\s\S]*?\{/g;
    let m;
    while ((m = ire.exec(text)) !== null) {
      const open = text.indexOf('{', m.index + m[0].length - 1);
      const close = matchBrace(text, open);
      if (close < 0) continue;
      const body = text.slice(open + 1, close);
      interfaces.set(m[1], memberKeys(body));
      /** @type {Record<string,string>} */
      const members = {};
      for (const rawLine of body.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('*') || line.startsWith('//') || line.startsWith('/*')) continue;
        const mm = line.match(/^(?:readonly\s+)?['"]?([A-Za-z_$][\w$]*)['"]?\??\s*:\s*(.+?);?$/);
        if (mm) members[mm[1]] = mm[2];
      }
      interfaceMembers.set(m[1], members);
      ire.lastIndex = close;
    }
    const tre = /export\s+type\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g;
    while ((m = tre.exec(text)) !== null) typeAliases.set(m[1], m[2].trim());
  }

  /**
   * 把一个类型表达式解析成合法键名集合。
   * @param {string} expr
   * @param {Set<string>} seen 循环引用保护
   * @returns {{keys:string[]|null, open:boolean, names:string[]}}  names = 实际解出的类型名（报错用）
   */
  const resolveExpr = (expr, seen = new Set()) => {
    const e = expr.trim().replace(/^readonly\s+/, '');
    // 开放键：Record<string, …> / { [k:string]: … } / 索引签名 ⇒ 该成员不判
    if (/^Record\s*<\s*string/.test(e) || /\[\s*\w+\s*:\s*string\s*\]/.test(e)) {
      return { keys: null, open: true, names: [] };
    }
    // Partial<X> / Pick<X,…> ⇒ 取内层
    const wrap = e.match(/^(?:Partial|Required|Omit|Pick)<\s*([A-Za-z_$][\w$]*)/);
    if (wrap) return resolveExpr(wrap[1], seen);
    // 内联对象字面量：`{ preferred: readonly TransportDecl[] }`
    if (e.startsWith('{')) {
      const close = matchBrace(e, 0);
      const body = e.slice(1, close > 0 ? close : e.length);
      const keys = [...new Set(memberKeys(body))].sort();
      return { keys: keys.length > 0 ? keys : null, open: keys.length === 0, names: [] };
    }
    // 数组 / union：`A[]`、`A | B`
    const parts = e.split('|').map((p) => p.replace(/\[\]/g, '').replace(/<.*>$/, '').trim()).filter(Boolean);
    /** @type {string[]} */
    const keys = [];
    /** @type {string[]} */
    const names = [];
    let open = false;
    for (const p of parts) {
      if (!/^[A-Za-z_$][\w$]*$/.test(p) || seen.has(p)) continue;
      if (interfaces.has(p)) {
        names.push(p);
        keys.push(...(interfaces.get(p) || []));
        continue;
      }
      if (typeAliases.has(p) && !seen.has(p)) {
        seen.add(p);
        const r = resolveExpr(typeAliases.get(p) || '', seen);
        if (r.open) open = true;
        if (r.keys) keys.push(...r.keys);
        names.push(...r.names);
        continue;
      }
      // 原生类型（string/number/boolean/Date…）⇒ 无键可判
      if (/^(string|number|boolean|unknown|any|never|void|null|undefined|object|Function)$/.test(p)) open = true;
    }
    const uniq = [...new Set(keys)].sort();
    return { keys: uniq.length > 0 ? uniq : null, open: open && uniq.length === 0, names };
  };

  /** @type {Record<string,string[]>} */
  const sections = {};
  /** @type {string[]} */
  const missing = [];
  /** @type {string[]} */
  const unresolved = [];

  const serviceMembers = interfaceMembers.get('ServiceConfig');
  const serviceKeys = interfaces.get('ServiceConfig');
  if (!serviceKeys || serviceKeys.length === 0 || !serviceMembers) {
    return { sections: {}, service: [], missing: ['ServiceConfig'], unresolved: [] };
  }
  // `policy` 段既在 ServiceConfig 里，也单独按 PolicyConfig 解析（下循环统一处理）
  for (const [section, expr] of Object.entries(serviceMembers)) {
    const r = resolveExpr(expr);
    if (r.open || !r.keys) {
      unresolved.push(`${section}(${expr})`);
      continue;
    }
    sections[section] = r.keys;
    if (r.names.length === 0) unresolved.push(`${section}:无类型名`);
  }

  return { sections, service: [...serviceKeys].sort(), missing: [...new Set(missing)], unresolved: [...new Set(unresolved)] };
}

/**
 * 找出一个配置对象里所有**不在白名单**的键。
 * @param {any} cfg 解析后的配置
 * @param {{sections:Record<string,string[]>, service:string[]}} wl
 * @returns {{file?:string, section:string, key:string, hint:string|null}[]}
 */
export function findUnknownKeys(cfg, wl) {
  /** @type {{section:string, key:string, hint:string|null}[]} */
  const found = [];
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return found;
  const knownMeta = new Set(METADATA_KEYS);
  /** 拼错提示用：全部已知键的并集。 */
  const allKnown = [...new Set([...wl.service, ...Object.values(wl.sections).flat(), ...knownMeta])];

  /** @param {string[]} pool @param {string} key */
  const hintFor = (pool, key) => {
    const low = key.toLowerCase();
    const near = pool.find((k) => k.toLowerCase() === low) || pool.find((k) => Math.abs(k.length - low.length) <= 2 && commonPrefixRatio(k.toLowerCase(), low) > 0.6);
    return near || null;
  };

  for (const key of Object.keys(cfg)) {
    if (knownMeta.has(key)) continue;
    if (!wl.service.includes(key)) {
      found.push({ section: '<root>', key, hint: hintFor(wl.service, key) });
      continue;
    }
    const section = key;
    const val = cfg[section];
    if (!val || typeof val !== 'object' || Array.isArray(val)) continue;
    const pool = wl.sections[section];
    if (!pool) continue; // 无白名单可对照的段（不在 SECTION 表里）⇒ 不判，交人看
    for (const k2 of Object.keys(val)) {
      if (knownMeta.has(k2)) continue;
      if (pool.includes(k2)) continue;
      // provider id 是任意合法标识符（`agent.providers` 的键 = provider 名，由 agent.provider 选单）
      if (section === 'agent' && k2 === 'providers') continue;
      found.push({ section, key: k2, hint: hintFor(pool, k2) });
    }
  }
  return found;
}

/** 前缀重合度（拼错提示用）。 */
function commonPrefixRatio(a, b) {
  let n = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    if (a[i] === b[i]) n += 1;
    else break;
  }
  return n / Math.max(a.length, b.length);
}

/**
 * A2-9（Phase 3 批6）· enforceBearer 的**配置层硬前置**（纯静态、读不到 env 正是本判据的价值）。
 *
 * 病灶（audit §3.2 A2-9 / B-1' / R4 B3 实测）：`enforceBearer` 生效是**双条件**
 * （`enforceBearer===true` ∧ `process.env[tokenEnv]` 非空，见 core config §4 O-9）。
 * 运行期 `validateServiceConfig` 只能对「已配 tokenEnv 名但环境变量无值」报 warning
 * （它读得到注入的 env）；但**「开了 enforceBearer 却压根没配 tokenEnv」这一配置文件内部
 * 的自相矛盾**——第二条件在结构上永不可能是真——运行期也只是 warning、且依赖有人去跑服务。
 * 门禁层必须把它钉成 **HARD**：配置文件里写了个不可能生效的安全开关 = 假安全感，
 * 与本工具 UNKNOWN_CONFIG_KEY 同源（「配了却不生效还不吭声」）。
 *
 * 判据（全部可从 JSON 文本静态判定，零 env 依赖）：
 *   ① `security.enforceBearer === true` 且 `tokenEnv` 缺席/空白 ⇒ HARD ENFORCE_BEARER_MISSING_TOKEN_ENV
 *   ② `security.enforceBearer` 存在但非布尔（"true"/1 等）⇒ HARD ENFORCE_BEARER_NOT_BOOLEAN
 *      （双条件判据是 `=== true`，字符串 "true" 关不上也开不了 = 「以为开了其实没开」同族）
 * 现网两份配置资产（delivery/vm-service.config.json、.generated/vm-service.runtime.json）
 * 均 `enforceBearer:false` ⇒ 本判据不触发，真机配置仍 code=0（U-6 非恒绿断言不受影响）。
 *
 * @param {any} cfg 解析后的配置对象
 * @returns {{section:string,key:string,hint:string|null,rule:string,message:string}[]}
 */
export function checkBearerPrecondition(cfg) {
  /** @type {{section:string,key:string,hint:string|null,rule:string,message:string}[]} */
  const found = [];
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return found;
  const sec = cfg.security;
  if (!sec || typeof sec !== 'object' || Array.isArray(sec)) return found;
  const eb = sec.enforceBearer;
  // ① 类型卫生：写了但不是布尔 ⇒ `=== true` 恒假，守卫不会挂（假开关）
  if (eb !== undefined && typeof eb !== 'boolean') {
    found.push({
      section: 'security',
      key: 'enforceBearer',
      hint: null,
      rule: 'ENFORCE_BEARER_NOT_BOOLEAN',
      message: `enforceBearer=${JSON.stringify(eb)} 不是布尔 ⇒ 双条件判据「=== true」恒假，bearer 守卫不会挂载。要开请写布尔 true，要关写 false 或删键`,
    });
    return found; // 类型已坏，不再叠加「缺 tokenEnv」噪音
  }
  // ② 开关为真却没有变量名 ⇒ 第二条件结构上不可满足
  if (eb === true) {
    const te = typeof sec.tokenEnv === 'string' ? sec.tokenEnv.trim() : '';
    if (!te) {
      found.push({
        section: 'security',
        key: 'enforceBearer',
        hint: 'tokenEnv',
        rule: 'ENFORCE_BEARER_MISSING_TOKEN_ENV',
        message: 'enforceBearer=true 但未配 security.tokenEnv（ bearer token 的环境变量名）⇒ 双条件缺第二条件，守卫永不生效（/health.security.authMode 报 loopback-only 而非 bearer-enforced）。请补 tokenEnv，或关掉 enforceBearer',
      });
    }
  }
  return found;
}

/**
 * 主流程：白名单 + 逐文件检查。
 * @param {string} root
 * @param {string[]} files 相对 root 的配置 JSON 路径
 * @returns {{code:number, ok:boolean, whitelist:Record<string,string[]>, service:string[], missing:string[], findings:{file:string,section:string,key:string,hint:string|null}[], skipped:string[]}}
 */
export function lintConfigKeys(root, files) {
  const wl = buildWhitelist(root);
  if (wl.missing.length > 0) {
    return { code: 2, ok: false, whitelist: wl.sections, service: wl.service, missing: wl.missing, findings: [], skipped: [] };
  }
  /** @type {{file:string,section:string,key:string,hint:string|null}[]} */
  const findings = [];
  /** @type {string[]} */
  const skipped = [];
  for (const rel of files) {
    const abs = join(root, rel);
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      skipped.push(`${rel}（文件不存在）`);
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(abs, 'utf8'));
    } catch (e) {
      skipped.push(`${rel}（JSON 解析失败：${String(e && e.message).slice(0, 80)}）`);
      continue;
    }
    for (const f of findUnknownKeys(parsed, wl)) findings.push({ file: rel, ...f });
    // A2-9：enforceBearer 配置层硬前置（与未知键并列进同一 findings[]，靠 rule 字段区分文案）
    for (const bf of checkBearerPrecondition(parsed)) findings.push({ file: rel, ...bf });
  }
  return {
    code: findings.length > 0 ? 1 : 0,
    ok: findings.length === 0,
    whitelist: wl.sections,
    service: wl.service,
    missing: [],
    findings,
    skipped,
  };
}

/** 人类可读输出。 */
export function formatConfigKeyReport(res, root) {
  /** @type {string[]} */
  const out = [];
  out.push(`config-key-lint · root=${root}`);
  const secCount = Object.keys(res.whitelist).length;
  out.push(`白名单（派生自 TS 类型）：顶层段=${res.service.length} 段内键=${secCount} 段（policy=${(res.whitelist.policy || []).length} 键）`);
  if (res.missing.length > 0) {
    out.push(`无法判定：源码缺 interface ⇒ ${res.missing.join(', ')}（白名单不可得，**不猜**；exit 2）`);
    out.push('VERDICT: UNJUDGED');
    return out.join('\n');
  }
  for (const s of res.skipped) out.push(`  SKIP ${s}`);
  if (res.findings.length === 0) {
    out.push('未知键：0 条');
    out.push('VERDICT: GREEN');
  } else {
    out.push(`未知键/安全前置：${res.findings.length} 条（配了却不生效且不吭声 = 假安全感，设计 §13.2-②）`);
    for (const f of res.findings) {
      if (f.rule) {
        out.push(`  [HARD] ${f.rule} — ${f.file} 段 ${f.section} 键 "${f.key}"：${f.message}`);
      } else {
        out.push(`  [HARD] UNKNOWN_CONFIG_KEY — ${f.file} 段 ${f.section} 键 "${f.key}" 不在派生白名单内${f.hint ? `（是否想写 "${f.hint}"？）` : ''}`);
      }
    }
    out.push('VERDICT: RED');
  }
  return out.join('\n');
}

/** 默认扫描目标（仓内配置资产）。 */
const DEFAULT_TARGETS = ['delivery/vm-service.config.json', 'delivery/.generated/vm-service.runtime.json'];

function main() {
  const argv = process.argv.slice(2);
  /** @type {string[]} */
  const paths = [];
  let root = null;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--path' || a === '--file') {
      paths.push(argv[i + 1] || '');
      i += 1;
    } else if (a.startsWith('--path=')) paths.push(a.slice(7));
    else if (a === '--root') {
      root = resolve(argv[i + 1] || '.');
      i += 1;
    } else if (a.startsWith('--root=')) root = resolve(a.slice(7));
    else if (a === '--json') json = true;
    else if (a === '--help' || a === '-h') {
      process.stdout.write(
        '用法: node scripts/config-key-lint.mjs [--path <rel.json>]... [--root <dir>] [--json]\n' +
          '  白名单派生自 core 的 TS interface（第二份手写清单 = 漂移风险）。\n' +
          '  exit 0=全知 1=有未知键 2=无法判定（源码缺 interface）。\n',
      );
      return;
    }
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const base = root || resolve(here, '..');
  const targets = paths.length > 0 ? paths : DEFAULT_TARGETS;
  const res = lintConfigKeys(base, targets);
  process.stdout.write((json ? JSON.stringify(res, null, 2) : formatConfigKeyReport(res, base)) + '\n');
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

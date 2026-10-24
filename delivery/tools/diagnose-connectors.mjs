#!/usr/bin/env node
/**
 * WinVM Bridge —— 连接器注入只读诊断工具（R17-T04 / R2-1）
 *
 * ## 只读契约（MUST，违反即视为设计缺陷）
 * - 只做 `existsSync` / `statSync` / `readFileSync` / `readdirSync` 四类文件系统**读取**；
 * - **绝不写入或删除**任何文件（包括本项目自身产物）；
 * - **绝不 spawn 子进程**（stdio command 仅做 stat + mode 位判定，不拉起）；
 * - **绝不发网络请求**（url 字段仅做字符串比对，不探测连通性）；
 * - **绝不解密** `connector-states.v3.json`：解析失败即如实标注 `encrypted-or-unparsable`，
 *   不做任何解密尝试、不猜测密钥、不读取任何可能的密钥材料。
 *
 * ## 探测四项（对应 r17-design.md §A1.2 第 1 条）
 * 1. 全局 `~/.workbuddy/mcp.json`：`winvm`（streamableHttp → 127.0.0.1:18443/mcp）与
 *    `winvm-a2a`（stdio）两条 server 的存在性与 transports 摘要；
 * 2. `~/.workbuddy/connectors/<account>/mcp.json`：枚举账户目录，报各账户的 winvm 条目就位情况；
 * 3. `~/.workbuddy/connectors/<account>/connector-states.v3.json`：枚举账户目录（排除 `skills` /
 *    `marketplace-meta` 等非账户目录），逐账户报存在性 / 大小 / 修改时间；可解析则报 enabled/trust 摘要；
 *    旧根路径 `~/.workbuddy/connector-states.v3.json` 仅作 legacy 兼容（存在则并入 pseudo-account
 *    `(legacy-root)`，不存在则静默不报——平台早已迁移到账户目录口径）；
 * 4. `winvm-a2a` 的 stdio `command` 可执行性：从全局 mcp.json 读路径 → stat + mode 位。
 *
 * ## 退出码语义
 * - `0` = 全部**必需项**就位（全局两条 server + stdio command 可执行 + 至少一个账户含 winvm 条目）；
 * - `1` = 存在必需项缺失/异常（详情见 `failures[]`）。
 *   注意：账户级缺失（多账户场景仅部分账户有）、url 端口与默认值不符、states 文件加密态
 *   均为 **WARN**，不影响退出码——它们不是本插件可根治的项（平台侧 trust/会话注入行为，见 R2 裁定 Q3）。
 *
 * ## 用法
 *   node delivery/tools/diagnose-connectors.mjs            # 人读段 + JSON 段（双段输出）
 *   node delivery/tools/diagnose-connectors.mjs --json     # 仅 JSON（供程序消费 / install-host 调用）
 *   node delivery/tools/diagnose-connectors.mjs --home <dir>  # 指定用户主目录（默认 os.homedir()）
 *
 * 本工具由 `delivery/install-host.mjs` 在安装末尾自动调用一次，也可由 QA / 用户随时手工复跑
 * （真机验收清单见 docs/design/r17-connector-injection-diagnosis.md）。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { KNOWN_ACTIVE_ACCOUNT } from '../account-resolve.mjs';

/** 全局 mcp.json 中本项目注册的两条 server 名（与 install-host 全局注册块同源）。 */
const SERVER_DIRECT = 'winvm';
const SERVER_A2A = 'winvm-a2a';
/** 期望的 MCP 直调地址片段（端口因 --local-port 可变，不符仅 WARN）。 */
const EXPECTED_URL_PATTERN = '127.0.0.1:18443/mcp';
/** 账户级 mcp.json 中本项目的条目名（renderConnectorEntry 产出带 `connector:` 前缀）。 */
const ACCOUNT_KEY_PREFIXES = ['connector:winvm', 'winvm'];
/**
 * `~/.workbuddy/connectors/` 下的**非账户目录**（技能缓存 / 平台元数据），枚举账户时必须排除，
 * 否则会把平台内部目录误当账户上报（states / mcp 双探测同此口径）。
 */
const NON_ACCOUNT_DIRS = new Set(['skills', 'marketplace-meta']);

/* ------------------------------ CLI ------------------------------ */

/**
 * 解析命令行参数。
 * @param {string[]} argv 不含 node 与脚本路径的参数数组
 * @returns {{ jsonOnly: boolean, home: string }}
 */
export function parseArgs(argv) {
  /** @type {{ jsonOnly: boolean, home: string }} */
  const out = { jsonOnly: false, home: homedir() };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--json':
        out.jsonOnly = true;
        break;
      case '--home':
        if (argv[i + 1]) out.home = argv[++i];
        break;
      default:
        break;
    }
  }
  return out;
}

/* ------------------------------ 通用只读助手 ------------------------------ */

/**
 * 只读安全读取 JSON：不存在返回 { ok:false, reason:'missing' }；解析失败返回
 * { ok:false, reason:'unparsable' }。**不抛异常**（诊断工具要求单项失败不影响整体探测）。
 * @param {string} filePath
 * @returns {{ ok: boolean, reason?: string, data?: any }}
 */
function readJsonSafe(filePath) {
  if (!existsSync(filePath)) return { ok: false, reason: 'missing' };
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (e) {
    return { ok: false, reason: 'unreadable', data: undefined, error: String(e && e.code ? e.code : e.message) };
  }
  try {
    return { ok: true, data: JSON.parse(raw) };
  } catch {
    // 如实标注：WorkBuddy 的 connector-states.v3.json 可能为加密态——绝不尝试解密。
    return { ok: false, reason: 'encrypted-or-unparsable' };
  }
}

/**
 * 只读文件元信息（存在性 / 大小 / mtime）。
 * @param {string} filePath
 * @returns {{ exists: boolean, size?: number, mtime?: string }}
 */
function fileMeta(filePath) {
  if (!existsSync(filePath)) return { exists: false };
  try {
    const st = statSync(filePath);
    return { exists: true, size: st.size, mtime: st.mtime.toISOString() };
  } catch (e) {
    return { exists: true, error: String(e && e.code ? e.code : e.message) };
  }
}

/**
 * 提取一条 server 的 transports 摘要（只 report，不改动）。
 * @param {any} entry mcpServers 下的条目对象
 * @returns {{ type: string|null, url: string|null, command: string|null, argsCount: number, disabled: boolean|null, timeout: number|string|null }}
 */
function summarizeTransport(entry) {
  const e = entry && typeof entry === 'object' ? entry : {};
  return {
    type: typeof e.type === 'string' ? e.type : (typeof e.transport === 'string' ? e.transport : null),
    url: typeof e.url === 'string' ? e.url : null,
    command: typeof e.command === 'string' ? e.command : null,
    argsCount: Array.isArray(e.args) ? e.args.length : 0,
    disabled: typeof e.disabled === 'boolean' ? e.disabled : null,
    timeout: typeof e.timeout === 'number' || typeof e.timeout === 'string' ? e.timeout : null,
  };
}

/* ------------------------------ 探测 1：全局 mcp.json ------------------------------ */

/**
 * 探测全局 `~/.workbuddy/mcp.json` 的两条 server 注册。
 * @param {string} home 用户主目录
 * @returns {{ path: string, file: object, exists: boolean, servers: object, failures: string[], warnings: string[] }}
 */
export function probeGlobalMcp(home) {
  const path = join(home, '.workbuddy', 'mcp.json');
  const meta = fileMeta(path);
  /** @type {{ path: string, file: object, exists: boolean, servers: object, failures: string[], warnings: string[] }} */
  const result = {
    path,
    file: meta,
    exists: meta.exists,
    /** @type {Record<string, any>} */
    servers: {
      [SERVER_DIRECT]: { present: false, transport: null },
      [SERVER_A2A]: { present: false, transport: null },
    },
    failures: [],
    warnings: [],
  };
  if (!meta.exists) {
    result.failures.push(`全局 mcp.json 不存在：${path}（winvm / winvm-a2a 均未注册，连接器页将看不到本插件）`);
    return result;
  }
  const parsed = readJsonSafe(path);
  if (!parsed.ok) {
    result.failures.push(`全局 mcp.json 无法解析（${parsed.reason}）：${path}`);
    return result;
  }
  const servers = (parsed.data && parsed.data.mcpServers) || {};
  for (const name of [SERVER_DIRECT, SERVER_A2A]) {
    const entry = servers[name];
    const slot = result.servers[name];
    if (!entry || typeof entry !== 'object') {
      result.failures.push(`全局 mcp.json 缺少 server「${name}」（未注册或已被移除）`);
      continue;
    }
    slot.present = true;
    slot.transport = summarizeTransport(entry);
    if (slot.transport.disabled === true) {
      result.warnings.push(`server「${name}」在 mcp.json 中被标记 disabled=true（需在连接器页启用）`);
    }
  }
  // 传输类型期望比对（不符仅 WARN：历史版本字段名/取值可能演进）
  const direct = result.servers[SERVER_DIRECT];
  if (direct.present && direct.transport) {
    if (direct.transport.type && !/streamable/i.test(direct.transport.type)) {
      result.warnings.push(`「${SERVER_DIRECT}」transport=${direct.transport.type}（预期 streamableHttp）`);
    }
    if (direct.transport.url && !direct.transport.url.includes(EXPECTED_URL_PATTERN)) {
      result.warnings.push(
        `「${SERVER_DIRECT}」url=${direct.transport.url}（默认期望 ${EXPECTED_URL_PATTERN}；若安装时改过 --local-port 属正常，否则请核对隧道端口）`,
      );
    }
    if (!direct.transport.url) result.failures.push(`「${SERVER_DIRECT}」缺少 url 字段，无法作为 MCP 直调通道`);
  }
  const a2a = result.servers[SERVER_A2A];
  if (a2a.present && a2a.transport) {
    if (a2a.transport.type && a2a.transport.type !== 'stdio') {
      result.warnings.push(`「${SERVER_A2A}」transport=${a2a.transport.type}（预期 stdio）`);
    }
    if (!a2a.transport.command) result.failures.push(`「${SERVER_A2A}」缺少 command 字段，stdio 桥无法拉起`);
  }
  return result;
}

/* ------------------------------ 探测 2：账户级 mcp.json ------------------------------ */

/**
 * 枚举 `~/.workbuddy/connectors/<account>/mcp.json`，报各账户 winvm 条目就位情况。
 * 仅目录/文件读取；`skills`、`connector-winvm` 等非账户目录自动跳过（不含 mcp.json 即跳过）。
 * @param {string} home
 * @returns {{ dir: string, accounts: object[], failures: string[], warnings: string[] }}
 */
export function probeAccountMcp(home) {
  const dir = join(home, '.workbuddy', 'connectors');
  /** @type {{ dir: string, accounts: object[], failures: string[], warnings: string[] }} */
  const result = { dir, accounts: [], failures: [], warnings: [] };
  if (!existsSync(dir)) {
    result.warnings.push(`账户连接器目录不存在：${dir}（宿主尚未登录/未生成账户配置，仅依赖全局注册）`);
    return result;
  }
  /** @type {string[]} */
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (e) {
    result.warnings.push(`无法枚举 ${dir}：${String(e && e.code ? e.code : e.message)}`);
    return result;
  }
  let anyAccountHasWinvm = false;
  for (const acct of entries) {
    const path = join(dir, acct, 'mcp.json');
    const meta = fileMeta(path);
    /** @type {{ accountId: string, path: string, exists: boolean, winvmKeys: string[], transports: object, note?: string }} */
    const slot = { accountId: acct, path, exists: meta.exists, winvmKeys: [], transports: {} };
    if (meta.exists) {
      const parsed = readJsonSafe(path);
      if (!parsed.ok) {
        slot.note = parsed.reason;
      } else {
        const servers = (parsed.data && parsed.data.mcpServers) || {};
        for (const key of Object.keys(servers)) {
          if (!ACCOUNT_KEY_PREFIXES.some((p) => key === p || key.startsWith(`${p}-`) || key.startsWith(`${p}:`))) continue;
          slot.winvmKeys.push(key);
          slot.transports[key] = summarizeTransport(servers[key]);
        }
        if (slot.winvmKeys.length > 0) anyAccountHasWinvm = true;
      }
    } else {
      slot.note = 'no-mcp-json';
    }
    result.accounts.push(slot);
  }
  const withWinvm = result.accounts.filter((a) => a.winvmKeys.length > 0).map((a) => a.accountId);
  const without = result.accounts.filter((a) => a.winvmKeys.length === 0).map((a) => a.accountId);
  if (!anyAccountHasWinvm) {
    result.failures.push(
      `所有账户 mcp.json 均无 winvm 条目（账户目录：${result.accounts.length ? entries.join(', ') : '(无)'}）` +
        `——请用 node delivery/install-host.mjs 补注册`,
    );
  } else if (without.length > 0) {
    // R2-M4 H1 加固（severity WARN → FAIL）：若"已知活跃账户 KNOWN_ACTIVE_ACCOUNT"本身缺 winvm 条目，
    // 则升级为 FAIL（会话工具面零工具的根因，CI/安装自检不得蒙混）；其余非活跃账户缺失仍保持 WARN。
    const knownMissing = without.includes(KNOWN_ACTIVE_ACCOUNT);
    const baseMsg =
      `账户「${without.join(', ')}」无 winvm 条目（活跃账户为 ${withWinvm.join(', ')} 时不影响注入；` +
      `若切换账户后工具缺失，重跑 install-host 会遍历全部账户补写`;
    if (knownMissing) {
      result.failures.push(
        `已知活跃账户「${KNOWN_ACTIVE_ACCOUNT}」mcp.json 缺 winvm 条目（H1 根因：${baseMsg}）` +
          `——请重跑 node delivery/install-host.mjs 补齐活跃账户注册`,
      );
    } else {
      result.warnings.push(baseMsg);
    }
  }
  result.summary = { accounts: result.accounts.length, withWinvm };
  return result;
}

/* ------------------------------ 探测 3：connector-states.v3.json（账户目录口径） ------------------------------ */

/**
 * 探测各账户的 `~/.workbuddy/connectors/<account>/connector-states.v3.json`。
 *
 * 平台事实口径（2026-10 实测）：states 文件位于**账户目录**下
 * （`~/.workbuddy/connectors/<account>/connector-states.v3.json`），旧根路径
 * `~/.workbuddy/connector-states.v3.json` 属历史形态（本机已不存在）。故本函数：
 *  - 枚举 `~/.workbuddy/connectors/` 下账户目录（排除 `skills` / `marketplace-meta` 非账户目录）；
 *  - 逐账户探测存在性 / 大小 / mtime / 可解析性（可解析则摘 enabled/trust 摘要）；
 *  - 旧根路径若仍存在则并入 pseudo-account `(legacy-root)`，不存在则静默（不报 failure）；
 *  - **绝不解密**：解析失败（多为平台加密态）如实标注 `encrypted-or-unparsable`。
 *
 * states 相关一律 **WARN** 级（多账户部分缺失 / 加密态均为平台侧 trust/会话行为），不进 failures。
 *
 * @param {string} home
 * @returns {{ path: string, dir: string, accounts: Array<{accountId: string, path: string, file: object, state: string, winvm: object}>, state: string, winvm: object, failures: string[], warnings: string[] }}
 */
export function probeConnectorStates(home) {
  const dir = join(home, '.workbuddy', 'connectors');
  const legacyPath = join(home, '.workbuddy', 'connector-states.v3.json');
  /** @type {{ path: string, dir: string, accounts: Array<{accountId: string, path: string, file: object, state: string, winvm: object}>, state: string, winvm: object, failures: string[], warnings: string[] }} */
  const result = {
    path: dir,
    dir,
    accounts: [],
    state: 'missing',
    winvm: {},
    failures: [],
    warnings: [],
  };

  /** 从任意结构里尽力摘取含 winvm 的键，只读摘要，不做深度耦合假设（沿用原有递归逻辑）。 */
  const collect = (obj, prefix, sink) => {
    if (!obj || typeof obj !== 'object') return;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (/winvm/i.test(k) && v && typeof v === 'object') {
        sink[prefix + k] = {
          enabled: typeof v.enabled === 'boolean' ? v.enabled : null,
          trusted: typeof v.trusted === 'boolean' ? v.trusted : (typeof v.trust === 'boolean' ? v.trust : null),
          disabled: typeof v.disabled === 'boolean' ? v.disabled : null,
        };
      }
    }
  };

  /** 探测单个 states 文件（账户目录内或 legacy 根），返回账户槽位。 */
  const probeOne = (accountId, filePath) => {
    const meta = fileMeta(filePath);
    /** @type {{ accountId: string, path: string, file: object, state: string, winvm: object }} */
    const slot = { accountId, path: filePath, file: meta, state: meta.exists ? 'unknown' : 'missing', winvm: {} };
    if (!meta.exists) return slot;
    const parsed = readJsonSafe(filePath);
    if (!parsed.ok) {
      // 只标注，不解密。
      slot.state = parsed.reason === 'unreadable' ? 'unreadable' : 'encrypted-or-unparsable';
      return slot;
    }
    slot.state = 'parsed';
    const data = parsed.data;
    collect(data, '', slot.winvm);
    if (data && typeof data === 'object') {
      for (const k of Object.keys(data)) {
        const v = data[k];
        if (v && typeof v === 'object' && !Array.isArray(v)) collect(v, `${k}.`, slot.winvm);
      }
    }
    return slot;
  };

  // 1) 枚举账户目录（排除 skills / marketplace-meta 等非账户目录；无 states 文件的目录标注 missing）
  /** @type {string[]} */
  let accountDirs = [];
  if (existsSync(dir)) {
    try {
      accountDirs = readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !NON_ACCOUNT_DIRS.has(d.name))
        .map((d) => d.name)
        .sort();
    } catch (e) {
      result.warnings.push(`无法枚举账户连接器目录 ${dir}：${String(e && e.code ? e.code : e.message)}`);
    }
  } else {
    result.warnings.push(
      `账户连接器目录不存在：${dir}（宿主尚未登录/未生成账户配置，states 由平台在连接器页首次操作时创建）`,
    );
  }

  // 2) 逐账户探测
  for (const acct of accountDirs) {
    result.accounts.push(probeOne(acct, join(dir, acct, 'connector-states.v3.json')));
  }

  // 3) legacy 根路径兼容：存在则并入 pseudo-account，不存在则静默（平台已迁移账户目录口径）
  if (existsSync(legacyPath)) {
    result.accounts.push(probeOne('(legacy-root)', legacyPath));
  }

  // 4) 聚合 state：任一 parsed → parsed；全 missing → missing；否则取最严重态
  /** 严重度排序（越严重越靠后）：parsed < missing < encrypted-or-unparsable < unreadable。 */
  const STATE_SEVERITY = { parsed: 0, missing: 1, 'encrypted-or-unparsable': 2, unreadable: 3 };
  if (result.accounts.length === 0) {
    result.state = 'missing';
    if (existsSync(dir)) {
      result.warnings.push(
        '未发现任何 connector-states.v3.json（账户目录与 legacy 根路径均无）——trust/enabled 由平台在连接器页首次操作时创建；' +
          '若新会话工具缺失，请先去连接器页确认已「信任 + 启用」winvm / winvm-a2a',
      );
    }
    // 目录本身不存在的告警已在枚举段给出，此处不重复报噪音
  } else {
    const states = result.accounts.map((a) => a.state);
    if (states.includes('parsed')) {
      result.state = 'parsed';
    } else if (states.every((s) => s === 'missing')) {
      result.state = 'missing';
      result.warnings.push(
        '所有账户目录均无 connector-states.v3.json——trust/enabled 由平台在连接器页首次操作时创建；' +
          '若新会话工具缺失，请先去连接器页确认已「信任 + 启用」winvm / winvm-a2a',
      );
    } else {
      result.state = states.reduce(
        (worst, s) => ((STATE_SEVERITY[s] ?? 2) > (STATE_SEVERITY[worst] ?? 2) ? s : worst),
        'missing',
      );
    }
  }

  // 5) 跨账户合并 winvm 摘要（键名加账户前缀隔离，防不同账户同键互相覆盖）
  for (const a of result.accounts) {
    for (const k of Object.keys(a.winvm)) {
      result.winvm[`${a.accountId}.${k}`] = a.winvm[k];
    }
  }

  // 6) 账户级 WARN（多账户部分缺失 / 加密态属平台侧行为，不影响退出码）
  const unparsable = result.accounts.filter((a) => a.state === 'encrypted-or-unparsable' || a.state === 'unreadable');
  const missingAccts = result.accounts.filter((a) => a.state === 'missing').map((a) => a.accountId);
  const parsedAccts = result.accounts.filter((a) => a.state === 'parsed');
  for (const a of unparsable) {
    result.warnings.push(
      `账户「${a.accountId}」的 connector-states.v3.json 为「${a.state}」（平台侧加密/非明文属预期），本工具不解密、` +
        'trust 与 enabled 态请以连接器页为准人工确认',
    );
  }
  if (parsedAccts.length > 0 && missingAccts.length > 0) {
    result.warnings.push(
      `账户「${missingAccts.join(', ')}」无 connector-states.v3.json（多账户场景部分账户缺 states 属平台侧行为；` +
        `已就绪账户：${parsedAccts.map((a) => a.accountId).join(', ')}）`,
    );
  }
  for (const a of parsedAccts) {
    if (Object.keys(a.winvm).length === 0) {
      result.warnings.push(
        `账户「${a.accountId}」的 connector-states.v3.json 可解析但未发现 winvm 相关条目（可能尚未在连接器页信任启用）`,
      );
    }
  }
  return result;
}

/* ------------------------------ 探测 4：stdio command 可执行性 ------------------------------ */

/**
 * 只读判定 `winvm-a2a` 的 stdio command 是否可执行：statSync + mode 位。
 * **绝不 spawn 子进程**（拉起子进程属平台/会话行为，本工具不承担验证）。
 * @param {string} home
 * @returns {{ command: string|null, path: string|null, exists: boolean, executable: boolean, mode: string|null, note?: string, failures: string[] }}
 */
export function probeStdioCommand(home) {
  /** @type {{ command: string|null, path: string|null, exists: boolean, executable: boolean, mode: string|null, note?: string, failures: string[] }} */
  const result = { command: null, path: null, exists: false, executable: false, mode: null, failures: [] };
  const globalPath = join(home, '.workbuddy', 'mcp.json');
  const parsed = readJsonSafe(globalPath);
  if (!parsed.ok) {
    result.failures.push(`无法从全局 mcp.json 取得 stdio command（${parsed.reason}）`);
    return result;
  }
  const entry = ((parsed.data || {}).mcpServers || {})[SERVER_A2A];
  if (!entry || typeof entry.command !== 'string') {
    result.failures.push(`全局 mcp.json 的「${SERVER_A2A}」无 command 字段，跳过可执行性判定`);
    return result;
  }
  result.command = entry.command;
  result.path = entry.command;
  if (!existsSync(entry.command)) {
    result.failures.push(`stdio command 不存在：${entry.command}（node 运行时缺失 → 重跑 install-host 或修 runtime 路径）`);
    return result;
  }
  try {
    const st = statSync(entry.command);
    result.exists = st.isFile();
    result.mode = (st.mode & 0o777).toString(8);
    // 任一 execute 位（u/g/o）即视为可执行；OHOS/Linux 语义，Windows 上恒真属可接受近似。
    result.executable = result.exists && (st.mode & 0o111) !== 0;
  } catch (e) {
    result.note = String(e && e.code ? e.code : e.message);
    result.failures.push(`stdio command stat 失败：${entry.command}（${result.note}）`);
    return result;
  }
  if (!result.executable) {
    result.failures.push(`stdio command 不可执行：${entry.command}（mode=${result.mode}，缺 execute 位）`);
  }
  // 附带只读判定 args[0]（桥入口 cli.js）存在性——不执行。
  if (Array.isArray(entry.args) && typeof entry.args[0] === 'string') {
    const scriptMeta = fileMeta(entry.args[0]);
    result.script = { path: entry.args[0], exists: scriptMeta.exists, size: scriptMeta.size };
    if (!scriptMeta.exists) {
      result.failures.push(`stdio 桥入口脚本不存在：${entry.args[0]}（插件缓存缺失 → 重跑 install-host）`);
    }
  }
  return result;
}

/* ------------------------------ 汇总与输出 ------------------------------ */

/**
 * 执行全部四项只读探测并汇总。
 * @param {string} [home] 用户主目录（默认 os.homedir()）
 * @returns {{ ok: boolean, home: string, generatedAt: string, global: object, accounts: object, states: object, stdio: object, failures: string[], warnings: string[] }}
 */
export function diagnose(home = homedir()) {
  const global = probeGlobalMcp(home);
  const accounts = probeAccountMcp(home);
  const states = probeConnectorStates(home);
  const stdio = probeStdioCommand(home);
  const failures = [...global.failures, ...accounts.failures, ...states.failures, ...stdio.failures];
  const warnings = [...global.warnings, ...accounts.warnings, ...states.warnings];
  if (stdio.note && !stdio.executable) warnings.push(`stdio command 判定备注：${stdio.note}`);
  return {
    ok: failures.length === 0,
    home,
    generatedAt: new Date().toISOString(),
    global,
    accounts,
    states,
    stdio,
    failures,
    warnings,
  };
}

/**
 * 生成人类可读报告段。
 * @param {ReturnType<typeof diagnose>} r
 * @returns {string[]}
 */
export function renderHuman(r) {
  /** @type {string[]} */
  const lines = [];
  const mark = (b) => (b ? '✓' : '✗');

  lines.push('连接器注入只读诊断（本工具零写入 / 零 spawn / 零网络 / 零解密）');
  lines.push(`宿主目录 : ${r.home}`);
  lines.push('');

  lines.push(`[1] 全局 mcp.json  ${r.global.path}`);
  lines.push(`    文件     : ${r.global.file.exists ? `存在（${r.global.file.size ?? '?'} B，${r.global.file.mtime ?? '?'}）` : '不存在'}`);
  for (const name of [SERVER_DIRECT, SERVER_A2A]) {
    const s = r.global.servers[name];
    const t = s.transport || {};
    lines.push(
      `    ${name} : ${mark(s.present)} ${s.present ? `${t.type ?? '?'}${t.url ? ` ${t.url}` : ''}${t.command ? ` cmd=${t.command}` : ''}${(t.argsCount ?? 0) ? ` args=${t.argsCount}` : ''}` : '未注册'}`,
    );
  }

  lines.push('');
  lines.push(`[2] 账户级 mcp.json  ${r.accounts.dir}`);
  if (r.accounts.accounts.length === 0) {
    lines.push('    （无账户目录）');
  }
  for (const a of r.accounts.accounts) {
    const has = a.winvmKeys.length > 0;
    lines.push(
      `    ${a.accountId} : ${has ? '✓' : '-'} ${has ? a.winvmKeys.join(', ') : (a.note || '无 winvm 条目')}`,
    );
  }

  lines.push('');
  lines.push(`[3] connector-states.v3.json（账户目录口径）  ${r.states.dir}`);
  if (r.states.accounts.length === 0) {
    lines.push('    （未发现账户 states 文件）');
  }
  for (const a of r.states.accounts) {
    lines.push(
      `    ${a.accountId} : ${a.file.exists ? `存在（${a.file.size ?? '?'} B，${a.file.mtime ?? '?'}）` : '不存在'} → state=${a.state}`,
    );
    for (const k of Object.keys(a.winvm)) lines.push(`      ${k} : ${JSON.stringify(a.winvm[k])}`);
  }
  lines.push(`    聚合 state=${r.states.state}`);
  const winvmStateKeys = Object.keys(r.states.winvm);
  if (winvmStateKeys.length > 0) {
    lines.push('    跨账户 winvm 摘要：');
    for (const k of winvmStateKeys) lines.push(`      ${k} : ${JSON.stringify(r.states.winvm[k])}`);
  }

  lines.push('');
  lines.push('[4] winvm-a2a stdio command 可执行性（只 stat，不拉起）');
  lines.push(`    command  : ${r.stdio.command ?? '(未取得)'}`);
  lines.push(
    `    判定     : ${r.stdio.exists ? '文件存在' : '文件不存在'} / mode=${r.stdio.mode ?? '?'} / ${r.stdio.executable ? '可执行 ✓' : '不可执行 ✗'}`,
  );
  if (r.stdio.script) lines.push(`    桥入口   : ${r.stdio.script.exists ? '存在 ✓' : '不存在 ✗'} ${r.stdio.script.path}`);

  if (r.warnings.length > 0) {
    lines.push('');
    lines.push('提示（WARN，不影响退出码；多为平台侧 trust/会话生命周期行为）：');
    for (const w of r.warnings) lines.push(`  ⚠ ${w}`);
  }
  if (r.failures.length > 0) {
    lines.push('');
    lines.push('缺失（FAIL）：');
    for (const f of r.failures) lines.push(`  ✗ ${f}`);
  }

  lines.push('');
  lines.push(
    r.ok
      ? `结论：注册面就位（${SERVER_DIRECT} + ${SERVER_A2A}）；新会话若仍未注入工具 → 走连接器页信任启用 → 重开新会话 → 见 docs/INSTALL-GUIDE.md troubleshooting`
      : `结论：存在 ${r.failures.length} 项必需缺失，请按上方 FAIL 处置（多数可用 node delivery/install-host.mjs 重跑修复）`,
  );
  return lines;
}

/* ------------------------------ main ------------------------------ */

function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = diagnose(args.home);
  if (args.jsonOnly) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderHuman(report).join('\n'));
    console.log('');
    console.log('--- JSON ---');
    console.log(JSON.stringify(report, null, 2));
  }
  process.exitCode = report.ok ? 0 : 1;
}

const isDirectRun =
  process.argv[1] && (process.argv[1].endsWith('diagnose-connectors.mjs') || process.argv[1].endsWith('diagnose-connectors.js'));
if (isDirectRun) main();

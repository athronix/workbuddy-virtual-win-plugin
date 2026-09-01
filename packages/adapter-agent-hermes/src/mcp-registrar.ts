/**
 * HermesMcpRegistrar —— 把 WinVM 的 MCP 服务幂等注册进 Hermes Agent 配置。
 *
 * 背景（ADR-13）：`hermes chat` **没有** `--mcp <endpoint>` 参数，MCP 服务器必须先
 * 写入 `%HERMES_HOME%\config.yaml` 的 `mcp_servers`，CLI 启动时才会自动发现并连接
 * （源码佐证：hermes_cli/mcp_startup.py）。
 *
 * 注册形态：
 *   mcp_servers:
 *     winvm:
 *       enabled: true
 *       url: http://127.0.0.1:18443/mcp
 *       headers:
 *         Authorization: Bearer ${MCP_WINVM_API_KEY}
 * 凭据落位：`%HERMES_HOME%\.env` 中写入 `MCP_WINVM_API_KEY=<token>`
 * （hermes 官方约定 key 命名：MCP_{SERVER名大写}_API_KEY）
 *
 * 设计：
 *  - YAML 合并与 .env 写入均为**纯函数**（upsertMcpServerBlock / upsertEnvVar），
 *    便于单元测试且测试不会触碰真实 hermes 安装；
 *  - 采用**最小侵入的行级文本合并**，不引入 YAML 依赖、不重排或丢失用户注释；
 *  - 写前备份 config.yaml.bak.<timestamp>；任何失败仅返回结果，不抛异常（降级告警）。
 */

import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** 展开 %ENV% 占位符 */
export function expandEnvPath(p: string, env: NodeJS.ProcessEnv = process.env): string {
  return p.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, n: string) => env[n] ?? m);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function detectEol(text: string): string {
  return /\r\n/.test(text) ? '\r\n' : '\n';
}

export interface UpsertResult {
  readonly text: string;
  readonly changed: boolean;
  readonly action: 'created' | 'updated' | 'noop';
}

/**
 * 纯函数：把 `<name>` MCP 服务器条目幂等写入 YAML 文本的 `mcp_servers` 段。
 * - 段不存在 → 追加新段（created）
 * - 条目不存在 → 在段尾追加（created）
 * - 条目存在但 url 不同 → 替换该条目（updated）
 * - 条目存在且 url 相同 → 原样返回（noop，不覆盖用户手工补充的字段）
 */
export function upsertMcpServerBlock(
  text: string,
  opts: { name: string; url: string; tokenEnvVar: string },
): UpsertResult {
  const eol = detectEol(text);
  const lines = text.split(/\r?\n/);
  const { name, url, tokenEnvVar } = opts;

  const entry: string[] = [
    `  ${name}:`,
    `    enabled: true`,
    `    url: ${url}`,
    `    headers:`,
    `      Authorization: Bearer \${${tokenEnvVar}}`,
  ];

  let blockStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^mcp_servers\s*:/.test(lines[i] ?? '')) {
      blockStart = i;
      break;
    }
  }

  // 段不存在：尾部追加整段
  if (blockStart === -1) {
    const trimmed = [...lines];
    while (trimmed.length && (trimmed[trimmed.length - 1] ?? '').trim() === '') trimmed.pop();
    const out = [...trimmed, '', 'mcp_servers:', ...entry, ''];
    return { text: out.join(eol), changed: true, action: 'created' };
  }

  // 段结束位置：遇到第一个非缩进、非空、非注释行
  let blockEnd = lines.length;
  for (let i = blockStart + 1; i < lines.length; i++) {
    const l = lines[i] ?? '';
    if (l.trim() === '' || /^\s*#/.test(l) || /^\s/.test(l)) continue;
    blockEnd = i;
    break;
  }

  // 定位同名条目（2 空格缩进）
  const nameRe = new RegExp(`^  ${escapeRe(name)}\\s*:`);
  let entryStart = -1;
  for (let i = blockStart + 1; i < blockEnd; i++) {
    if (nameRe.test(lines[i] ?? '')) {
      entryStart = i;
      break;
    }
  }

  if (entryStart !== -1) {
    let entryEnd = blockEnd;
    for (let i = entryStart + 1; i < blockEnd; i++) {
      const l = lines[i] ?? '';
      if (l.trim() === '') continue;
      if (/^  \S/.test(l)) {
        entryEnd = i; // 下一个同级 server
        break;
      }
    }
    const existing = lines.slice(entryStart, entryEnd).join('\n');
    if (existing.includes(url)) {
      return { text, changed: false, action: 'noop' };
    }
    const out = [...lines.slice(0, entryStart), ...entry, ...lines.slice(entryEnd)];
    return { text: out.join(eol), changed: true, action: 'updated' };
  }

  // 段内追加条目
  let insertAt = blockEnd;
  while (insertAt > blockStart + 1 && (lines[insertAt - 1] ?? '').trim() === '') insertAt--;
  const out = [...lines.slice(0, insertAt), ...entry, ...lines.slice(insertAt)];
  return { text: out.join(eol), changed: true, action: 'created' };
}

/** 纯函数：在 .env 文本中幂等写入 KEY=value（已存在则替换该行） */
export function upsertEnvVar(text: string, key: string, value: string): UpsertResult {
  const eol = detectEol(text);
  const lines = text.split(/\r?\n/);
  const re = new RegExp(`^\\s*${escapeRe(key)}\\s*=`);
  const line = `${key}=${value}`;
  let found = false;
  const out = lines.map((l) => {
    if (re.test(l)) {
      found = true;
      return line;
    }
    return l;
  });
  if (!found) {
    let end = out.length;
    while (end > 0 && (out[end - 1] ?? '').trim() === '') end--;
    out.splice(end, 0, line);
  }
  const changed = !found || (found && lines.some((l, i) => re.test(l) && l !== line));
  return { text: out.join(eol), changed, action: found ? (changed ? 'updated' : 'noop') : 'created' };
}

/** hermes 官方 token 环境变量命名规则：MCP_{SERVER名大写}_API_KEY */
export function tokenEnvVarForServer(name: string): string {
  const suffix = name.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase().replace(/^_+|_+$/g, '');
  return `MCP_${suffix}_API_KEY`;
}

export interface HermesMcpRegistrarOptions {
  /** MCP 端点，如 http://127.0.0.1:18443/mcp */
  readonly url: string;
  /** 注册到 hermes 的服务器名，默认 winvm */
  readonly serverName?: string;
  /** Bearer token；取自 tokenEnv 指定的环境变量 */
  readonly token?: string;
  /** hermes config.yaml 路径；缺省按 HERMES_CONFIG_PATH → %HERMES_HOME%/config.yaml → ~/.hermes/config.yaml */
  readonly configPath?: string;
  /** .env 路径；缺省与 config.yaml 同目录 */
  readonly envFilePath?: string;
  /** 写前是否备份，默认 true */
  readonly backup?: boolean;
  readonly env?: NodeJS.ProcessEnv;
}

export interface RegisterOutcome {
  readonly ok: boolean;
  readonly action: 'created' | 'updated' | 'noop' | 'skipped' | 'failed';
  readonly configPath: string;
  readonly envFilePath: string;
  readonly tokenEnvVar: string;
  readonly reason?: string;
}

export class HermesMcpRegistrar {
  private readonly url: string;
  private readonly serverName: string;
  private readonly token: string;
  private readonly configPath: string;
  private readonly envFilePath: string;
  private readonly backup: boolean;

  constructor(opts: HermesMcpRegistrarOptions) {
    const env = opts.env ?? process.env;
    this.url = opts.url;
    this.serverName = opts.serverName ?? 'winvm';
    this.token = opts.token ?? env['WINVM_BEARER_TOKEN'] ?? '';
    const cfg =
      opts.configPath ??
      env['HERMES_CONFIG_PATH'] ??
      (env['HERMES_HOME'] ? join(expandEnvPath(env['HERMES_HOME']!, env), 'config.yaml') : '') ??
      (env['USERPROFILE'] ? join(expandEnvPath(env['USERPROFILE']!, env), '.hermes', 'config.yaml') : '');
    this.configPath = expandEnvPath(cfg, env);
    this.envFilePath = expandEnvPath(opts.envFilePath ?? '', env) || join(dirname(this.configPath), '.env');
    this.backup = opts.backup ?? true;
  }

  /** 幂等注册；任何异常都转为 ok:false 的结果，由调用方降级告警（不阻断 provider 启动） */
  async ensureRegistered(): Promise<RegisterOutcome> {
    const tokenEnvVar = tokenEnvVarForServer(this.serverName);
    const base = {
      configPath: this.configPath,
      envFilePath: this.envFilePath,
      tokenEnvVar,
    };

    if (!this.configPath) {
      return { ...base, ok: false, action: 'failed', reason: '未能定位 hermes config.yaml（未设置 HERMES_HOME/HERMES_CONFIG_PATH）' };
    }

    let raw = '';
    try {
      raw = await readFile(this.configPath, 'utf8');
    } catch (e) {
      return { ...base, ok: false, action: 'failed', reason: `读取 hermes 配置失败：${(e as Error).message}` };
    }

    const res = upsertMcpServerBlock(raw, { name: this.serverName, url: this.url, tokenEnvVar });

    if (res.changed) {
      try {
        if (this.backup) {
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          await copyFile(this.configPath, `${this.configPath}.bak.${stamp}`);
        }
        await writeFile(this.configPath, res.text, 'utf8');
      } catch (e) {
        return { ...base, ok: false, action: 'failed', reason: `写入 hermes 配置失败：${(e as Error).message}` };
      }
    }

    // 凭据：token 为空则跳过写入（保持既有配置可继续工作）
    let envAction: 'created' | 'updated' | 'noop' | 'skipped' = 'skipped';
    if (this.token) {
      try {
        let envRaw = '';
        try {
          envRaw = await readFile(this.envFilePath, 'utf8');
        } catch {
          envRaw = '';
        }
        const r = upsertEnvVar(envRaw, tokenEnvVar, this.token);
        if (r.changed) await writeFile(this.envFilePath, r.text, 'utf8');
        envAction = r.action;
      } catch (e) {
        return {
          ...base,
          ok: false,
          action: 'failed',
          reason: `写入 token 到 ${this.envFilePath} 失败：${(e as Error).message}`,
        };
      }
    }

    const action = res.action === 'noop' && envAction === 'noop' ? 'noop' : res.action;
    return { ...base, ok: true, action };
  }
}

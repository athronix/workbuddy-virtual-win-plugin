/**
 * @winvm/host-sdk —— 宿主机 Agent 插件规范 SDK（L1c）
 *
 * 提供中性插件模型的校验、Skill 加载、JSON 增量补丁能力。
 * 具体宿主的渲染由 adapter-host-* 实现（V1 = WorkBuddy）。
 *
 * 依赖铁律：仅依赖 @winvm/contracts，禁止依赖 core / frameworks / adapter。
 */

import type { NeutralPlugin, ValidationIssue, ValidationReport } from '@winvm/contracts';

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** 校验中性插件模型的完整性（宿主无关） */
export function validateNeutralPlugin(plugin: NeutralPlugin): ValidationReport {
  const issues: ValidationIssue[] = [];
  const push = (level: ValidationIssue['level'], message: string, path?: string) =>
    issues.push({ level, message, ...(path ? { path } : {}) });

  /* ---- manifest ---- */
  const m = plugin.manifest;
  if (!m.name || !/^[a-z0-9][a-z0-9-]*$/.test(m.name)) {
    push('error', `manifest.name 非法（需小写字母数字与连字符）：${m.name ?? '(空)'}`, 'manifest.name');
  }
  if (!m.version || !SEMVER_RE.test(m.version)) {
    push('error', `manifest.version 不是合法 semver：${m.version ?? '(空)'}`, 'manifest.version');
  }
  if (!m.description || m.description.length < 10) {
    push('warning', 'manifest.description 过短，宿主侧推荐/检索效果会变差', 'manifest.description');
  }
  if (!m.author?.name) push('error', 'manifest.author.name 缺失', 'manifest.author');

  /* ---- skills ---- */
  const seen = new Set<string>();
  if (plugin.skills.length === 0) push('error', '没有任何 Skill', 'skills');
  for (const s of plugin.skills) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(s.id)) {
      push('error', `Skill id 非法（需小写字母数字与连字符）：${s.id}`, `skills.${s.id}`);
    }
    if (seen.has(s.id)) push('error', `Skill id 重复：${s.id}`, `skills.${s.id}`);
    seen.add(s.id);
    if (!s.body.includes('---')) {
      push('warning', `Skill ${s.id} 的正文缺少 frontmatter，宿主侧可能无法正确识别`, `skills.${s.id}`);
    }
    if (!s.description) push('warning', `Skill ${s.id} 缺少 description`, `skills.${s.id}`);
  }
  const entryCount = plugin.skills.filter((s) => s.entry === true).length;
  if (entryCount === 0) push('warning', '没有标记为 entry 的总控 Skill，宿主侧路由可能退化');
  if (entryCount > 1) push('error', `entry Skill 只能有一个，当前 ${entryCount} 个`);

  /* ---- connector ---- */
  const c = plugin.connector;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(c.id)) {
    push('error', `connector.id 非法：${c.id}`, 'connector.id');
  }
  if (c.transports.length === 0) push('error', 'connector.transports 为空', 'connector.transports');

  for (const [i, t] of c.transports.entries()) {
    const path = `connector.transports[${i}]`;
    if (t.kind === 'ssh-tunnel') {
      if (!t.host) push('error', 'ssh-tunnel 缺少 host', path);
      if (!t.user) push('error', 'ssh-tunnel 缺少 user', path);
      if (t.localPort < 1 || t.localPort > 65535) push('error', `localPort 非法：${t.localPort}`, path);
      if (t.remotePort < 1 || t.remotePort > 65535) push('error', `remotePort 非法：${t.remotePort}`, path);
    } else if (t.kind === 'streamable-http') {
      if (!/^https?:\/\//.test(t.url)) push('error', `url 非法：${t.url}`, path);
      else if (!t.url.startsWith('https://')) {
        push('warning', `url 使用 http（${t.url}）：明文传输，仅限受信任内网或本机回环`, path);
      }
      if (!t.tokenEnv) push('error', 'streamable-http 必须指定 tokenEnv（禁止明文 token）', path);
    }
  }

  if (c.timeoutMs < 1000) push('warning', `connector.timeoutMs=${c.timeoutMs} 过小`, 'connector.timeoutMs');

  // 凭据红线：任何传输都不得内联明文凭据
  const serialized = JSON.stringify(plugin);
  for (const marker of ['"password"', '"token":', '"secret"', '"apiKey"']) {
    if (serialized.includes(marker)) {
      push('error', `插件模型内疑似包含明文凭据字段（${marker.replace(/"/g, '')}），违反凭据红线`);
    }
  }

  return { ok: issues.every((i) => i.level !== 'error'), issues };
}

/** 断言校验通过，否则抛错（供安装流程使用） */
export function assertValidPlugin(plugin: NeutralPlugin): void {
  const report = validateNeutralPlugin(plugin);
  if (!report.ok) {
    const errors = report.issues.filter((i) => i.level === 'error').map((i) => `  - ${i.message}`);
    throw new Error(`中性插件模型校验失败：\n${errors.join('\n')}`);
  }
}

export * from './patch.js';
export {
  parseFrontmatter,
  loadSkillBundle,
  loadSkillBundles,
  normalizeRelPath,
} from './skill-loader.js';
export type { SkillFrontmatter, ParsedSkillDoc } from './skill-loader.js';

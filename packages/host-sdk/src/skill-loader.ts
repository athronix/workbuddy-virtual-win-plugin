/**
 * 中性 Skill 加载器
 *
 * Skills 以**与宿主无关**的中性格式存放（SKILL.md + references/ + workflows/），
 * 由各宿主 Renderer 在 install 阶段转译为宿主格式（FR-404）。
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';

import type { SkillBundle, SkillDomain } from '@winvm/contracts';

export interface SkillFrontmatter {
  readonly id?: string;
  readonly name?: string;
  readonly description?: string;
  readonly version?: string;
  readonly domains?: readonly SkillDomain[];
  readonly triggers?: readonly string[];
  readonly entry?: boolean;
  readonly relatedSkills?: readonly string[];
}

export interface ParsedSkillDoc {
  readonly frontmatter: SkillFrontmatter;
  readonly body: string;
}

const VALID_DOMAINS: readonly SkillDomain[] = ['system', 'app', 'storage', 'gui'];

/* ------------------------------ frontmatter 解析 ------------------------------ */

/**
 * 解析 YAML frontmatter 的**必要子集**：
 * 标量、行内数组 `[a, b]`、块数组 `- item`、折叠标量 `>` 与 `|`。
 * 不追求完整 YAML 兼容 —— Skills 只需这套受限语法即可表达全部契约字段。
 */
export function parseFrontmatter(raw: string): ParsedSkillDoc {
  const text = raw.replace(/^﻿/, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { frontmatter: {}, body: text.trim() };

  const [, fmRaw = '', bodyRaw = ''] = match;
  const fm: Record<string, unknown> = {};

  let currentKey: string | null = null;
  let currentBlock: string[] | null = null;
  /** 'fold' = 折叠标量(>) | 'literal' = 字面标量(|) | 'list' = 块数组(- item) */
  let blockKind: 'fold' | 'literal' | 'list' = 'list';

  const flushBlock = () => {
    if (currentKey !== null && currentBlock !== null) {
      if (blockKind === 'list') {
        // 块数组：有项则保留数组；空块退化为字符串
        fm[currentKey] = currentBlock.length > 0 ? currentBlock : '';
      } else {
        fm[currentKey] = blockKind === 'fold'
          ? currentBlock.join(' ').trim()
          : currentBlock.join('\n');
      }
    }
    currentKey = null;
    currentBlock = null;
    blockKind = 'list';
  };

  for (const line of fmRaw.split(/\r?\n/)) {
    // 块数组项
    const itemMatch = /^\s*-\s+(.*)$/.exec(line);
    if (itemMatch && currentKey !== null && Array.isArray(fm[currentKey])) {
      (fm[currentKey] as string[]).push(stripQuotes(itemMatch[1]!.trim()));
      continue;
    }

    const kv = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
    if (kv) {
      flushBlock();
      const key = kv[1]!;
      const rawVal = kv[2]!.trim();
      currentKey = key;

      if (rawVal === '>' || rawVal === '>-') {
        blockKind = 'fold';
        currentBlock = [];
        fm[key] = currentBlock;
        continue;
      }
      if (rawVal === '|' || rawVal === '|-') {
        blockKind = 'literal';
        currentBlock = [];
        fm[key] = currentBlock;
        continue;
      }
      if (rawVal === '') {
        // 空值：先按块数组处理，flush 时若为空则退化为字符串
        blockKind = 'list';
        currentBlock = [];
        fm[key] = currentBlock;
        continue;
      }
      if (rawVal.startsWith('[') && rawVal.endsWith(']')) {
        fm[key] = rawVal
          .slice(1, -1)
          .split(',')
          .map((s) => stripQuotes(s.trim()))
          .filter((s) => s.length > 0);
        currentKey = null;
        continue;
      }
      fm[key] = coerce(stripQuotes(rawVal));
      currentKey = null;
      continue;
    }

    // 缩进的块内容
    if (/^\s+\S/.test(line) && currentBlock !== null) {
      currentBlock.push(line.trim());
    }
  }
  flushBlock();

  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const arr = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.map(String) : undefined);

  const domains = (() => {
    const d = arr(fm['domains']);
    if (!d) return undefined;
    const filtered = d.filter((x): x is SkillDomain => (VALID_DOMAINS as readonly string[]).includes(x));
    return filtered.length > 0 ? filtered : undefined;
  })();

  return {
    frontmatter: {
      ...(str(fm['id']) ? { id: str(fm['id']) } : {}),
      ...(str(fm['name']) ? { name: str(fm['name']) } : {}),
      ...(str(fm['description']) ? { description: str(fm['description']) } : {}),
      ...(str(fm['version']) ? { version: str(fm['version']) } : {}),
      ...(domains ? { domains } : {}),
      ...(arr(fm['triggers']) ? { triggers: arr(fm['triggers']) } : {}),
      ...(arr(fm['relatedSkills']) ? { relatedSkills: arr(fm['relatedSkills']) } : {}),
      ...(fm['entry'] === true ? { entry: true } : {}),
    },
    body: bodyRaw.trim(),
  };
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

function coerce(s: string): string | boolean | number {
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  return s;
}

/* ------------------------------ 目录加载 ------------------------------ */

async function collectFiles(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    const s = await stat(p);
    if (s.isDirectory()) {
      const nested = await collectFiles(p);
      for (const [k, v] of Object.entries(nested)) out[join(e, k)] = v;
    } else if (/\.(md|markdown)$/i.test(e)) {
      out[e] = await readFile(p, 'utf8');
    }
  }
  return out;
}

/** 从磁盘加载单个 Skill 目录 */
export async function loadSkillBundle(dir: string): Promise<SkillBundle> {
  const skillPath = join(dir, 'SKILL.md');
  const raw = await readFile(skillPath, 'utf8');
  const { frontmatter, body } = parseFrontmatter(raw);
  const id = frontmatter.id ?? basename(dir);

  const references = await collectFiles(join(dir, 'references'));
  const workflows = await collectFiles(join(dir, 'workflows'));

  return {
    id,
    name: frontmatter.name ?? id,
    description: frontmatter.description ?? '',
    body: raw,
    ...(frontmatter.triggers ? { triggers: frontmatter.triggers } : {}),
    ...(Object.keys(references).length > 0 ? { references } : {}),
    ...(Object.keys(workflows).length > 0 ? { workflows } : {}),
    ...(frontmatter.domains ? { domains: frontmatter.domains } : {}),
    ...(frontmatter.entry === true ? { entry: true } : {}),
    ...(frontmatter.version ? { version: frontmatter.version } : {}),
  };
}

/** 加载 skills 根目录下的所有 Skill（目录名含 SKILL.md 即视作一个 Skill） */
export async function loadSkillBundles(skillsRoot: string): Promise<SkillBundle[]> {
  let entries: string[];
  try {
    entries = await readdir(skillsRoot);
  } catch {
    return [];
  }
  const out: SkillBundle[] = [];
  for (const e of entries) {
    const dir = join(skillsRoot, e);
    const s = await stat(dir).catch(() => null);
    if (!s?.isDirectory()) continue;
    try {
      await stat(join(dir, 'SKILL.md'));
    } catch {
      continue;
    }
    out.push(await loadSkillBundle(dir));
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** 归一化引用文件路径（统一为 posix 分隔符，便于渲染到不同宿主） */
export function normalizeRelPath(p: string): string {
  return p.split('\\').join('/').replace(/^\.\//, '');
}

export { relative as relativePath };

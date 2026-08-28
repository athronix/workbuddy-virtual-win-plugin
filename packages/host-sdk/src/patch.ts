/**
 * JSON Pointer / JSON Patch 工具（RFC 6901）
 *
 * 为什么必须有：宿主连接器配置（如 WorkBuddy 的 mcp.json）是**共享文件**，
 * 直接整体覆盖会破坏用户已有的其它连接器。规范要求一律增量合并。
 */

/** 转义 JSON Pointer token（~ → ~0，/ → ~1） */
export function escapeToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

export function unescapeToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

export function parsePointer(pointer: string): string[] {
  if (pointer === '' || pointer === '/') return [];
  if (!pointer.startsWith('/')) throw new Error(`非法 JSON Pointer（必须以 / 开头）：${pointer}`);
  return pointer
    .slice(1)
    .split('/')
    .map(unescapeToken);
}

export function buildPointer(tokens: readonly (string | number)[]): string {
  if (tokens.length === 0) return '';
  return '/' + tokens.map((t) => escapeToken(String(t))).join('/');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isArray(v: unknown): v is unknown[] {
  return Array.isArray(v);
}

export function getAtPointer(root: unknown, pointer: string): unknown {
  let cur: unknown = root;
  for (const token of parsePointer(pointer)) {
    if (isArray(cur)) {
      const idx = Number(token);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return undefined;
      cur = cur[idx];
    } else if (isRecord(cur)) {
      if (!(token in cur)) return undefined;
      cur = cur[token];
    } else {
      return undefined;
    }
  }
  return cur;
}

/** 深拷贝 */
export function deepClone<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => deepClone(x)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = deepClone(val);
  return out as T;
}

/** 深合并：source 覆盖 target 的同名标量；对象递归；数组整体替换 */
export function deepMerge<T extends Record<string, unknown>>(target: T, source: Record<string, unknown>): T {
  const out = deepClone(target);
  for (const [k, sv] of Object.entries(source)) {
    const tv = (out as Record<string, unknown>)[k];
    if (isRecord(tv) && isRecord(sv)) {
      (out as Record<string, unknown>)[k] = deepMerge(tv, sv);
    } else {
      (out as Record<string, unknown>)[k] = deepClone(sv);
    }
  }
  return out;
}

/**
 * 在指定 pointer 处设置值（不可变：返回新对象）。
 * 中间节点不存在时自动创建为对象。
 */
export function setAtPointer<T>(root: T, pointer: string, value: unknown): T {
  const tokens = parsePointer(pointer);
  if (tokens.length === 0) return deepClone(value) as T;

  const rootRecord: Record<string, unknown> =
    isRecord(root) ? deepClone(root as Record<string, unknown>)
    : Array.isArray(root) ? deepClone(root as unknown[]) as unknown as Record<string, unknown>
    : ({} as Record<string, unknown>);

  let cur: Record<string, unknown> | unknown[] = rootRecord;
  for (let i = 0; i < tokens.length - 1; i++) {
    const token = tokens[i]!;
    const nextToken = tokens[i + 1]!;
    const isNextIndex = /^\d+$/.test(nextToken);

    if (Array.isArray(cur)) {
      const idx = Number(token);
      while (cur.length <= idx) cur.push({});
      if (!isRecord(cur[idx]) && !isArray(cur[idx])) cur[idx] = isNextIndex ? [] : {};
      cur = cur[idx] as Record<string, unknown> | unknown[];
    } else {
      const existing = cur[token];
      if (!isRecord(existing) && !isArray(existing)) {
        cur[token] = isNextIndex ? [] : {};
      }
      cur = cur[token] as Record<string, unknown> | unknown[];
    }
  }

  const last = tokens[tokens.length - 1]!;
  if (Array.isArray(cur)) {
    const idx = Number(last);
    while (cur.length < idx) cur.push(null);
    cur[idx] = deepClone(value);
  } else {
    cur[last] = deepClone(value);
  }

  return rootRecord as unknown as T;
}

/** 删除指定 pointer 处的值（不可变） */
export function removeAtPointer<T>(root: T, pointer: string): T {
  const tokens = parsePointer(pointer);
  if (tokens.length === 0 || !isRecord(root)) return root;
  const out = deepClone(root as Record<string, unknown>);

  let cur: Record<string, unknown> = out;
  for (let i = 0; i < tokens.length - 1; i++) {
    const token = tokens[i]!;
    const next = cur[token];
    if (!isRecord(next)) return out as unknown as T; // 路径不存在，原样返回
    cur = next;
  }
  const last = tokens[tokens.length - 1]!;
  if (Array.isArray(cur)) {
    const idx = Number(last);
    if (Number.isInteger(idx) && idx >= 0 && idx < cur.length) cur.splice(idx, 1);
  } else {
    delete cur[last];
  }
  return out as T;
}

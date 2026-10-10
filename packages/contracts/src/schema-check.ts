/**
 * 契约 schema 的交付面形状校验（Phase 2 · P2-T1 · F1 契约诚实化族）。
 *
 * 病灶（phase2-arch-design §1.1 / phase1-t1-notes D-3）：
 *   `contracts/schemas/capability.schema.json` 曾是一份**零消费者**的 JSON Schema ——
 *   SECURITY §3.2 里「会被 schema 直接拒绝」的承诺从未在任何路径兑现，schema 与
 *   TS 事实源（`CAPABILITY_DOMAINS`）还发生了漂移（`appops` 缺席 enum/pattern）。
 *
 * 本模块把 schema 变成**被消费的资产**：`validateCapabilityShape` 以 schema JSON 为
 * **输入**（不是硬编码判据）做必填 / 枚举 / pattern / 类型 / 键集（additionalProperties=false）
 * / L2-L3 快照条件约束的形状校验，返回违规列表。
 *
 * 消费点纪律（§13 用户裁决 Q1 = (b)）：**仅测试面 + 交付门禁**，运行期零接入 ——
 * vm-service 的能力定义来自代码内常量，运行期校验只在校验自己编译出来的东西
 * （安全增益≈0，还给启动加新风险面）。**禁止**在 `packages/vm-capabilities`
 * 或 `vm-service` 的启动路径调用本函数。
 *
 * 零第三方依赖（Phase 1「零供应链引入」口径）：只用 `node:` 内置模块与语言原语。
 * 不实现完整 JSON Schema draft 2020-12 —— 只覆盖本 schema 实际使用的关键字子集
 * （type / required / additionalProperties / enum / pattern / minLength / minimum /
 * maximum / properties / items / if-then 的 L2-L3 快照约束），子集之外一律**不假装**
 * 支持：遇到未识别关键字不报错也不放行——校验语义以本文件声明的子集为准（诚实口径）。
 */

import { CAPABILITY_DOMAINS } from './capability.js';

/* ------------------------------- 结果形状 ------------------------------- */

/** 单条违规：定位到能力 id 与违规路径（点分 JSON Path 风格），message 面向人读 */
export interface ShapeViolation {
  readonly id: string;
  readonly path: string;
  readonly message: string;
}

export interface ShapeValidationResult {
  readonly ok: boolean;
  readonly violations: readonly ShapeViolation[];
}

/* ------------------------------- 内部工具 ------------------------------- */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** JSON Schema type 关键字 → 实际值判定（本 schema 用到的子集） */
function typeMatches(value: unknown, type: string): boolean {
  switch (type) {
    case 'object':
      return isRecord(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return true; // 未识别类型声明：不假装拦截（诚实子集口径），由键集/枚举等其余判据兜住
  }
}

/**
 * 编译 `id.pattern`：JSON Schema pattern 为 ECMA-262 正则源文。
 * 校验前先验证 pattern 自身可编译且能抽出**域前缀 alternation**（漂移守卫要用）。
 */
function compilePattern(pattern: unknown): RegExp | undefined {
  if (typeof pattern !== 'string') return undefined;
  try {
    return new RegExp(pattern);
  } catch {
    return undefined;
  }
}

/**
 * 从 `id.pattern` 源文抽取首段 alternation 的枚举集合，
 * 形如 `^(system|app|storage|gui|appops|meta)\.…` ⇒ `['system','app','storage','gui','appops','meta']`。
 * 解析失败返回 `undefined`（调用方以违规处理——漂移守卫依赖它）。
 */
export function domainPrefixesFromPattern(pattern: unknown): readonly string[] | undefined {
  if (typeof pattern !== 'string') return undefined;
  // 取第一个捕获组的内容（现行 id.pattern 的首段 alternation）；不追求解析任意正则文法
  const m = /^\^?\(([^)]*)\)/.exec(pattern);
  if (!m || typeof m[1] !== 'string') return undefined;
  const parts = m[1].split('|').map((s) => s.trim()).filter((s) => s.length > 0);
  return parts.length > 0 ? parts : undefined;
}

/* ------------------------------- 对象级校验 ------------------------------- */

/**
 * 按 schema 节点校验一个对象值，把违规追加到 sink。
 * 覆盖关键字子集：required / properties / additionalProperties / type。
 */
function checkObject(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
  id: string,
  sink: ShapeViolation[],
): void {
  if (!isRecord(value)) {
    sink.push({ id, path, message: `应为 object，实得 ${typeName(value)}` });
    return;
  }
  const required = Array.isArray(schema['required']) ? (schema['required'] as readonly string[]) : [];
  for (const key of required) {
    if (!(key in value)) {
      sink.push({ id, path: `${path}.${key}`, message: `必填键 ${key} 缺失` });
    }
  }
  const props = isRecord(schema['properties']) ? (schema['properties'] as Record<string, Record<string, unknown>>) : {};
  for (const [key, sub] of Object.entries(props)) {
    if (key in value) checkValue(value[key], sub, `${path}.${key}`, id, sink);
  }
  if (schema['additionalProperties'] === false) {
    for (const key of Object.keys(value)) {
      if (!(key in props)) {
        sink.push({ id, path: `${path}.${key}`, message: `schema additionalProperties=false ⇒ 未声明键 ${key} 被拒` });
      }
    }
  }
}

/** 按 schema 节点校验任意值（分派到类型专项） */
function checkValue(
  value: unknown,
  node: unknown,
  path: string,
  id: string,
  sink: ShapeViolation[],
): void {
  if (!isRecord(node)) return; // 无约束声明（如 true schema）⇒ 不判
  if (typeof node['type'] === 'string' && !typeMatches(value, node['type'])) {
    sink.push({ id, path, message: `应为 ${node['type']}，实得 ${typeName(value)}` });
    return; // 类型已错，深入无意义
  }
  if (Array.isArray(node['enum'])) {
    const allowed = node['enum'] as readonly unknown[];
    if (!allowed.includes(value)) {
      sink.push({ id, path, message: `值 ${JSON.stringify(value)} 不在枚举 [${allowed.map((x) => JSON.stringify(x)).join(', ')}]` });
    }
  }
  if (typeof value === 'string') {
    if (typeof node['pattern'] === 'string') {
      const re = compilePattern(node['pattern']);
      if (!re) {
        sink.push({ id, path, message: `schema pattern 无法编译：${JSON.stringify(node['pattern'])}` });
      } else if (!re.test(value)) {
        sink.push({ id, path, message: `值 ${JSON.stringify(value)} 不匹配 pattern ${JSON.stringify(node['pattern'])}` });
      }
    }
    if (typeof node['minLength'] === 'number' && value.length < node['minLength']) {
      sink.push({ id, path, message: `长度 ${value.length} < minLength ${node['minLength']}` });
    }
  }
  if (typeof value === 'number') {
    if (typeof node['minimum'] === 'number' && value < node['minimum']) {
      sink.push({ id, path, message: `${value} < minimum ${node['minimum']}` });
    }
    if (typeof node['maximum'] === 'number' && value > node['maximum']) {
      sink.push({ id, path, message: `${value} > maximum ${node['maximum']}` });
    }
  }
  if (Array.isArray(value) && isRecord(node['items'])) {
    value.forEach((item, i) => checkValue(item, node['items'], `${path}[${i}]`, id, sink));
  }
  if (isRecord(value) && (Array.isArray(node['required']) || isRecord(node['properties']) || node['additionalProperties'] === false)) {
    checkObject(value, node, path, id, sink);
  }
}

/* ------------------------------- 条件约束（L2/L3 ⇒ snapshot ≠ none） ------------------------------- */

/**
 * schema `allOf[0]` 的 if/then 语义在本实现里**专项硬映射**为设计文档 §1.2 口径
 * 「只校验 id/domain/risk/键集/必填项 + L2-L3 快照条件约束」的那一条：
 * risk ∈ {L2, L3} ⇒ audit.snapshot ≠ 'none'。
 * 不做通用 if/then 求值（子集外能力不假装支持），但**从 schema 文本确认该约束在场**：
 * 若 schema 删掉了这条 allOf，本断言随测试红（防止约束被静默移除）。
 */
function checkConditionalSnapshot(
  def: Record<string, unknown>,
  schema: Record<string, unknown>,
  id: string,
  sink: ShapeViolation[],
): void {
  const allOf = Array.isArray(schema['allOf']) ? (schema['allOf'] as readonly unknown[]) : [];
  const hasSnapshotRule = allOf.some((clause) => {
    if (!isRecord(clause)) return false;
    const ifPart = isRecord(clause['if']) ? (clause['if'] as Record<string, unknown>) : undefined;
    const thenPart = isRecord(clause['then']) ? (clause['then'] as Record<string, unknown>) : undefined;
    const ifRisk = ifPart && isRecord(ifPart['properties']) ? (ifPart['properties'] as Record<string, unknown>)['risk'] : undefined;
    return Boolean(ifRisk && Array.isArray((ifRisk as Record<string, unknown>)['enum']) && thenPart !== undefined);
  });
  if (!hasSnapshotRule) {
    sink.push({ id, path: '$.allOf', message: 'schema 应含「risk∈{L2,L3} ⇒ audit.snapshot≠none」条件约束，现缺席（约束被移除须显形）' });
    return;
  }
  const risk = def['risk'];
  if (risk === 'L2' || risk === 'L3') {
    const audit = def['audit'];
    const snapshot = isRecord(audit) ? audit['snapshot'] : undefined;
    if (snapshot === 'none') {
      sink.push({ id, path: '$.audit.snapshot', message: `risk=${String(risk)}（L2/L3）时 snapshot 不得为 none（schema allOf 条件约束）` });
    }
  }
}

/* ------------------------------- 公共入口 ------------------------------- */

/**
 * 用给定的 capability JSON Schema 校验一条（组）能力定义的**形状**。
 *
 * @param def   能力定义（`unknown` ⇒ 允许测试投喂畸形样本；也接受定义数组）
 * @param schema capability.schema.json 解析后的对象（**判据的唯一来源**——
 *               运行时不 import 文件路径，消费方负责读入 JSON，保持纯函数可注入/可测）
 * @returns 违规列表（空数组即通过）。顶层非对象/非数组 ⇒ 记一条 `$` 违规。
 */
export function validateCapabilityShape(
  def: unknown,
  schema: Record<string, unknown>,
): ShapeValidationResult {
  const violations: ShapeViolation[] = [];

  if (!isRecord(schema) || !isRecord(schema['properties'])) {
    return {
      ok: false,
      violations: [{ id: '(input)', path: '$', message: 'schema 参数必须是含 properties 的对象' }],
    };
  }

  const list: unknown[] = Array.isArray(def) ? def : [def];
  list.forEach((item, idx) => {
    const id =
      isRecord(item) && typeof item['id'] === 'string' ? item['id'] : `(item#${idx})`;
    if (!isRecord(item)) {
      violations.push({ id, path: `$[${idx}]`, message: `能力定义应为 object，实得 ${typeName(item)}` });
      return;
    }
    checkObject(item, schema, '$', id, violations);
    checkConditionalSnapshot(item, schema, id, violations);
  });

  return { ok: violations.length === 0, violations };
}

/**
 * 漂移守卫：schema 的 `domain.enum` 与 `id.pattern` 首段枚举，必须与 TS 事实源
 * `CAPABILITY_DOMAINS`（packages/contracts/src/capability.ts，含 appops）集合相等。
 * 返回违规描述数组（空即一致）。放在这里而不是测试文件：交付门禁（P2-T11 gate.mjs）
 * 与单测可共用同一判据，避免两处各写一套导致守卫本身漂移。
 */
export function checkSchemaDomainDrift(schema: Record<string, unknown>): readonly string[] {
  const problems: string[] = [];
  const props = isRecord(schema) && isRecord(schema['properties']) ? (schema['properties'] as Record<string, unknown>) : undefined;
  if (!props) return ['schema 缺 properties'];
  const truth = [...CAPABILITY_DOMAINS].sort();

  const domainNode = props['domain'];
  const enumVals = isRecord(domainNode) && Array.isArray(domainNode['enum']) ? (domainNode['enum'] as readonly unknown[]) : undefined;
  if (!enumVals) {
    problems.push('properties.domain.enum 缺席或非数组');
  } else {
    const got = enumVals.filter((x): x is string => typeof x === 'string').sort();
    if (got.join(',') !== truth.join(',')) {
      problems.push(`properties.domain.enum [${got.join('|')}] ≠ CAPABILITY_DOMAINS [${truth.join('|')}]`);
    }
  }

  const idNode = props['id'];
  const pattern = isRecord(idNode) ? idNode['pattern'] : undefined;
  const prefixes = domainPrefixesFromPattern(pattern);
  if (!prefixes) {
    problems.push(`properties.id.pattern 缺席或首段 alternation 解析失败：${JSON.stringify(pattern)}`);
  } else {
    const got = [...prefixes].sort();
    if (got.join(',') !== truth.join(',')) {
      problems.push(`id.pattern 首段枚举 [${got.join('|')}] ≠ CAPABILITY_DOMAINS [${truth.join('|')}]`);
    }
  }
  return problems;
}

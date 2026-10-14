/**
 * 审批预览哈希（Phase 3 批6 · A2-17 ARCH-09 补建 · **单源权威**）。
 *
 * 为什么在 core：宿主（host-a2a-bridge）记录 `previewHash` 与 VM（vm-service）绑定校验
 * 必须对**同一输入产出逐字节一致**的哈希，任何一份"第二实现"都是漂移风险（A2-10 教训：
 * expandEnvPath 6 份拷贝=同一病灶）。本模块是双端共同的权威实现。
 *
 * 溯源：算法自 `host-a2a-bridge/approval-audit.ts`（CL-016 F2）整体上提；host 侧保留
 * 同名 re-export（公共 API 面零破坏）。凭据正则的「并集口径」设计理由随迁（见下）。
 *
 * 约束：仅 Node 内置 `node:crypto`，零第三方依赖（Phase 1 「零供应链引入」口径）。
 */

import { createHash } from 'node:crypto';

import { REDACTED } from './logger.js';

/**
 * 凭据键名**统一正则（唯一一份 · 并集口径）**，大小写不敏感。
 * 覆盖：password / passwd / passphrase / secret / token / apikey / api_key / credential / privatekey / private_key
 * —— 脱敏 / 清洗 / 哈希**都引用本常量**，避免多处口径漂移。
 * （`REDACTED` 占位串**不在此重复定义**——core 桶的权威值来自 `logger.ts`，两处值逐字相同；
 * 本模块直接复用该常量，保证 `redactCredentials` 的打码输出与 logger 口径同源。）
 */
export const CREDENTIAL_KEY_RE =
  /(password|passwd|passphrase|secret|token|apikey|api_key|credential|privatekey|private_key)/i;

/**
 * 递归凭据脱敏（与 `redact()` 的差异见原注释：并集正则 + 不做超长截断——
 * 截断会破坏 preview 与 VM 下发值的逐项深等）。
 */
export function redactCredentials(value: unknown, key?: string): unknown {
  if (typeof value === 'string') {
    return key !== undefined && CREDENTIAL_KEY_RE.test(key) ? REDACTED : value;
  }
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactCredentials(v, key));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === undefined) continue;
    out[k] = redactCredentials(v, k);
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 递归规范化任意值为键序稳定的纯数据（对象键按字典序排序，
 * 命中凭据键名的键**直接剔除**；数组逐元素处理）。
 */
function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map((x) => canonicalize(x));
  if (isRecord(v)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v).sort()) {
      if (CREDENTIAL_KEY_RE.test(key)) continue; // 凭据红线：直接剔除该键
      const value = v[key];
      if (value === undefined) continue; // 不输出 undefined 字面量
      out[key] = canonicalize(value);
    }
    return out;
  }
  return v;
}

/**
 * 规范化 JSON 字符串。
 * - 键排序：同内容不同键序 → 同字符串
 * - 剔除凭据键：见 `CREDENTIAL_KEY_RE`（并集口径，大小写不敏感）
 */
export function canonicalApprovalJson(v: unknown): string {
  const out = JSON.stringify(canonicalize(v));
  return out === undefined ? 'null' : out;
}

/**
 * 计算审批 dry-run 预览的内容哈希：`sha256(canonicalJson(...))` → hex。
 * 只纳入确实存在的字段；凭据键在 canonicalize 阶段被剔除。
 *
 * A2-17 语义注记（「预览≠执行」绑定的判据边界，随算法一并权威化）：
 * 凭据键剔除意味着**改凭据值不影响哈希**——这不是漏洞而是语义自洽：
 * 审批卡上从未展示过凭据明文（F5 红线），宿主批准的从来不是"那个密码值"，
 * 而是"对该能力+该非凭据参数形态+该预览"的授权。非凭据参数（路径/包名/服务名/
 * dryRun 开关…）任何一项变化都会翻转哈希 ⇒ 续跑放行闸拒绑重审。
 */
export function hashApprovalPreview(input: {
  capabilityId?: string;
  risk?: string;
  preview?: Record<string, unknown>;
  impact?: readonly string[];
}): string {
  const payload: Record<string, unknown> = {};
  if (typeof input.capabilityId === 'string') payload['capabilityId'] = input.capabilityId;
  if (input.risk) payload['risk'] = input.risk;
  if (isRecord(input.preview)) payload['preview'] = input.preview;
  if (Array.isArray(input.impact)) payload['impact'] = input.impact;
  return createHash('sha256').update(canonicalApprovalJson(payload), 'utf8').digest('hex');
}

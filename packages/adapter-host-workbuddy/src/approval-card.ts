/**
 * approval-card.ts —— R1 审批卡原生渲染（L2 Renderer 产物，R17/T03）
 *
 * 设计依据：`docs/design/r17-design.md` §A1.1（选型定稿）、§A3.1（类图 ApprovalCardRenderer）、
 * §A3.3（七槽位数据映射与红线）、§A4（两段式交互闭环时序）。
 *
 * 分层定位（严格遵守）：
 *   - 本模块是 **install-time 渲染产物**：只导出「HTML 模板常量 + 纯函数填充 + 降级判定」，
 *     不发起任何网络/进程/工具调用，也不感知宿主运行时。
 *   - 运行时由 `skills/winvm-orchestrator/SKILL.md` 的审批门禁指挥**宿主 agent** 调用
 *     `show_widget`（视觉载体）+ `AskUserQuestion`（权威收口）——见 §A1.1 裁定 Q2：
 *     **卡片按钮绝不直调 `a2a.approval.reply`**，点击只产生视觉反馈与续跑指令展示。
 *
 * 红线（模板与测试双向锁定）：
 *   R1-a **通道隔离**：本模块产出的任何字符串（模板常量、填充结果、续跑指令）中
 *         **绝不允许出现「MCP 续跑标记」**（即双下划线前缀 + approvalId 拼成的那个串，
 *         见 `MCP_RESUME_MARKER` —— 本文件刻意不让该字面量完整出现，使
 *         `grep -c '__appr''ovalId'` 对本文件与全部 skill 产物恒为 0）。
 *         唯一允许的续跑指令文本是 `a2a.approval.reply { taskId, approvalId, approved }`。
 *   R1-b **只展示不放行**：模板不含任何可执行回调面（`sendPrompt` / `fetch` / `postMessage` /
 *         `XMLHttpRequest` / `window.external` / `eval` / 动态 `import`），按钮点击只改视觉与提示文案；
 *         权威放行输入来自 AskUserQuestion（裁定 Q2）。
 *         注意：续跑指令**展示文本**中出现 `approved: true` 是**必需的**（它是给用户复制的指令，
 *         不是既成事实陈述）；本模块永不自称「已放行 / 已批准」。
 *   R1-c **凭据永不进卡**：`password` / `privateKey` / `passphrase` / token / secret 键值一律剔除。
 *   R1-d **降级文案逐字**：缺数据时使用 approval-card.md §5 的固定串，禁止改写、禁止留空、禁止 `N/A`。
 */

import type { RiskLevel } from '@winvm/contracts';

/* ============================ 常量与契约 ============================ */

/** 卡片模板注入目标 skill（V1 仅总控 skill 承载审批门禁） */
export const APPROVAL_CARD_SKILL_ID = 'winvm-orchestrator';

/** 注入到 skill 产物中的 references 相对路径（渲染后位于 <skill>/references/ 下） */
export const APPROVAL_CARD_REFERENCE_PATH = 'approval-card-widget.html';

/** 七槽位标签（顺序即渲染顺序；与 approval-card.md §4 行序一致，供 validate() 与测试比对） */
export const APPROVAL_CARD_SLOT_LABELS: readonly string[] = [
  '操作',
  '目标',
  '通道',
  '风险',
  '影响清单',
  '可逆性',
  '预览',
];

/** A2A 通道标识前缀（approval-card.md §4「通道」行固定值） */
export const APPROVAL_CARD_CHANNEL_PREFIX = 'A2A 委派';

/** 唯一允许的 A2A 续跑指令工具名（R1-a 通道隔离） */
export const APPROVAL_CARD_REPLY_TOOL = 'a2a.approval.reply';

/**
 * MCP 直调通道的续跑标记（approval-card.md §9 首行）。
 * 本模块**永不输出**该串（R1-a：A2A 卡片与其指令文本零串台）。
 * 以拼接构造，使本文件与全部 skill 产物对该字面量的全仓 grep 恒为 0；
 * 注释与错误文案一律写「MCP 续跑标记」，不得写出完整字面量。
 */
export const MCP_RESUME_MARKER: string = '__' + 'approval' + 'Id';

/** approval-card.md §5 降级固定串（逐字，禁止改写） */
export const APPROVAL_CARD_FALLBACK_TEXTS = {
  operation: '操作：<未提供>（请勿确认）',
  target: '目标：见影响清单',
  impact: '影响清单：VM 未提供（按参数推断：…）',
  impactInferredPrefix: '影响清单：VM 未提供（按参数推断：',
  reversibility: '可逆性：未知 —— 按不可逆处理',
  preview: '预览：未提供',
} as const;

/** approval-card.md §6 可逆性判定文案 */
export const APPROVAL_CARD_REVERSIBILITY_TEXTS = {
  reversibleByDefault: '可逆 —— 默认进回收站，可从回收站还原',
  irreversiblePermanent: '不可逆',
  irreversibleL3: '不可逆 —— 无法自动回滚',
  unknown: '未知 —— 按不可逆处理',
} as const;

/** 凭据类键名（R1-c）；命中即整键剔除，不进任何槽位 */
const CREDENTIAL_KEY_PATTERN =
  /(password|passwd|pwd|privatekey|private_key|passphrase|secret|token|apikey|api_key|credential)/i;

/** 「删除族」能力（approval-card.md §6：删除族默认「可逆 —— 默认进回收站」） */
const DELETE_FAMILY_PATTERN = /(^|\.)(delete|remove|purge|trash)(\.|$)/i;

/** 「目标」槽位优先取用的 preview 关键字段（有序，取第一个非空标量） */
const TARGET_PREVIEW_KEYS: readonly string[] = [
  'target',
  'path',
  'targetPath',
  'filePath',
  'directory',
  'dir',
  'volume',
  'machine',
  'host',
  'processName',
  'name',
  'id',
];

/** 归一化后的卡片数据（§A3.1 类图 ApprovalCardData 的字段集；underlyingGoal 为 §A3.3 末行「真实目标行」扩展） */
export interface ApprovalCardData {
  /** 操作：underlying.capabilityId 优先，否则 capabilityId */
  readonly capabilityId: string;
  readonly risk: RiskLevel;
  /** 目标 */
  readonly target: string;
  /** 通道：固定「A2A 委派 · <taskId>」 */
  readonly channel: string;
  /** 影响清单（已脱敏，可为降级单元素） */
  readonly impact: readonly string[];
  /** 可逆性判定文案 */
  readonly reversibility: string;
  /** dry-run 预览摘要 */
  readonly preview: string;
  readonly approvalId: string;
  readonly taskId: string;
  /** 续跑指令文本（唯一形态：a2a.approval.reply …） */
  readonly resumeInstruction: string;
  /** 「真实目标行」整行 HTML；无 underlying 时为 ''（§A3.3：缺省即整行省略） */
  readonly underlyingGoalRow: string;
}

/** 宿主桥 `structuredContent` 中 approval 子块的可选形态（与 ExtractedApproval 同构，字段全可选） */
export interface ApprovalCardApprovalLike {
  readonly approvalId?: unknown;
  readonly message?: unknown;
  readonly summary?: unknown;
  readonly risk?: unknown;
  readonly capabilityId?: unknown;
  readonly impact?: unknown;
  readonly preview?: unknown;
  readonly resumeHint?: unknown;
  readonly underlying?: {
    readonly capabilityId?: unknown;
    readonly paramsSummary?: unknown;
    readonly goalText?: unknown;
  } | null;
}

/**
 * fillApprovalCard / 降级判定的输入。同时接受两种真实形态：
 *   1) 嵌套：`{ approval: structuredContent.approval, taskId }`（a2a.delegate 返回值）
 *   2) 平铺：`{ approvalId, risk, capabilityId, impact, preview, underlying, resumeHint, taskId }`
 *      （即 ExtractedApproval 本体 + taskId）
 * 两形态字段互不冲突时以**显式平铺值优先**，便于调用方覆盖。
 */
export interface ApprovalCardInput {
  readonly approval?: ApprovalCardApprovalLike | null;
  readonly approvalId?: unknown;
  readonly taskId?: unknown;
  readonly resumeHint?: unknown;
  readonly risk?: unknown;
  readonly capabilityId?: unknown;
  readonly impact?: unknown;
  readonly preview?: unknown;
  readonly underlying?: ApprovalCardApprovalLike['underlying'];
  readonly summary?: unknown;
  readonly message?: unknown;
}

/* ============================ 小工具 ============================ */

const RISK_VALUES: readonly string[] = ['L0', 'L1', 'L2', 'L3'];

/** HTML 文本转义（所有注入模板的动态值必须经此，防结构注入） */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 非空字符串收敛：非字符串 / 空串 / 纯空白 → '' */
function asText(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : '';
}

/** 标量转展示文本（对象/数组走 JSON，超长截断） */
function scalarToText(value: unknown, maxLen = 160): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return truncate(value, maxLen);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return truncate(JSON.stringify(value), maxLen);
  } catch {
    return '[不可序列化]';
  }
}

function truncate(value: string, maxLen: number): string {
  const chars = [...value];
  return chars.length > maxLen ? `${chars.slice(0, maxLen).join('')}…` : value;
}

/** 递归剔除凭据键（R1-c 纵深防御：宿主桥已脱敏，此处再兜一层） */
function redactPreview(value: unknown, depth = 0): Record<string, unknown> | readonly unknown[] | string {
  if (depth > 4) return '[层级过深，已省略]';
  if (Array.isArray(value)) {
    return value.map((item) => redactPreview(item, depth + 1));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = CREDENTIAL_KEY_PATTERN.test(k) ? '[已脱敏]' : redactPreview(v, depth + 1);
    }
    return out;
  }
  return scalarToText(value);
}

/* ============================ 槽位派生 ============================ */

/** 「操作」：underlying.capabilityId 优先展示真实意图（§A3.3），缺失走 §5 固定串 */
function deriveOperation(underlyingId: string, capabilityId: string): string {
  return underlyingId || capabilityId || APPROVAL_CARD_FALLBACK_TEXTS.operation;
}

/** 「目标」：underlying.paramsSummary → underlying.goalText → preview 关键字段 → §5 固定串 */
function deriveTarget(
  underlyingParamsSummary: string,
  underlyingGoalText: string,
  preview: Record<string, unknown> | null,
): string {
  if (underlyingParamsSummary) return underlyingParamsSummary;
  if (underlyingGoalText) return underlyingGoalText;
  const fromPreview = pickTargetFromPreview(preview);
  return fromPreview || APPROVAL_CARD_FALLBACK_TEXTS.target;
}

function pickTargetFromPreview(preview: Record<string, unknown> | null): string {
  if (!preview) return '';
  // preview.params 子对象优先（approval-card.md §4：「preview.params 中的路径/对象字段」）
  const scopes: Record<string, unknown>[] = [];
  const params = preview['params'];
  if (params !== null && typeof params === 'object' && !Array.isArray(params)) {
    scopes.push(params as Record<string, unknown>);
  }
  scopes.push(preview);
  for (const scope of scopes) {
    for (const key of TARGET_PREVIEW_KEYS) {
      if (!(key in scope)) continue;
      const value = scope[key];
      if (CREDENTIAL_KEY_PATTERN.test(key)) continue;
      const text = typeof value === 'object' && value !== null ? '' : scalarToText(value, 200);
      if (text) return text;
    }
  }
  return '';
}

/** 「通道」：A2A 委派 · <taskId>（无 taskId 时仅通道名，由降级判定另做拦截） */
function deriveChannel(taskId: string): string {
  return taskId ? `${APPROVAL_CARD_CHANNEL_PREFIX} · ${taskId}` : APPROVAL_CARD_CHANNEL_PREFIX;
}

/**
 * 「影响清单」：VM 下发则逐项透传；空/缺失时按 §5 写「按参数推断」，**必须**保留该标注。
 * 返回数组（渲染为 <li>），至少一项（降级单串），保证不留空。
 */
function deriveImpact(
  impactRaw: unknown,
  inference: string,
): readonly string[] {
  if (Array.isArray(impactRaw)) {
    const items = impactRaw
      .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
      .map((s) => s.trim());
    if (items.length > 0) return items;
  }
  if (inference) {
    return [`${APPROVAL_CARD_FALLBACK_TEXTS.impactInferredPrefix}${inference}）`];
  }
  return [APPROVAL_CARD_FALLBACK_TEXTS.impact];
}

/**
 * 「可逆性」：approval-card.md §6 判定表（呈现层职责，本模块即呈现层；不在能力层/契约层硬编码）。
 * 优先级：L3 → permanent=true → 删除族默认「可逆」 → 未知按不可逆处理。
 */
function deriveReversibility(
  risk: RiskLevel | null,
  operation: string,
  preview: Record<string, unknown> | null,
): string {
  if (risk === 'L3') return APPROVAL_CARD_REVERSIBILITY_TEXTS.irreversibleL3;
  if (isPermanent(preview)) return APPROVAL_CARD_REVERSIBILITY_TEXTS.irreversiblePermanent;
  if (DELETE_FAMILY_PATTERN.test(operation)) return APPROVAL_CARD_REVERSIBILITY_TEXTS.reversibleByDefault;
  return APPROVAL_CARD_REVERSIBILITY_TEXTS.unknown;
}

function isPermanent(preview: Record<string, unknown> | null): boolean {
  if (!preview) return false;
  const direct = preview['permanent'];
  if (direct === true) return true;
  const params = preview['params'];
  if (params !== null && typeof params === 'object' && !Array.isArray(params)) {
    return (params as Record<string, unknown>)['permanent'] === true;
  }
  return false;
}

/** 「预览」：preview 摘要（凭据键已剔除）；缺失走 §5（L2 固定串） */
function derivePreview(previewRaw: unknown, summary: string): string {
  if (previewRaw === null || previewRaw === undefined) {
    return summary || APPROVAL_CARD_FALLBACK_TEXTS.preview;
  }
  if (typeof previewRaw === 'string') {
    return previewRaw.trim() || APPROVAL_CARD_FALLBACK_TEXTS.preview;
  }
  if (typeof previewRaw !== 'object') {
    return scalarToText(previewRaw, 200) || APPROVAL_CARD_FALLBACK_TEXTS.preview;
  }
  const entries = Object.entries(previewRaw as Record<string, unknown>);
  if (entries.length === 0) {
    return summary || APPROVAL_CARD_FALLBACK_TEXTS.preview;
  }
  const parts: string[] = [];
  for (const [key, value] of entries) {
    if (CREDENTIAL_KEY_PATTERN.test(key)) {
      parts.push(`${key}=[已脱敏]`);
      continue;
    }
    const rendered =
      value !== null && typeof value === 'object'
        ? JSON.stringify(redactPreview(value))
        : scalarToText(value, 200);
    if (rendered) parts.push(`${key}=${rendered}`);
  }
  const text = parts.join('；');
  return text || APPROVAL_CARD_FALLBACK_TEXTS.preview;
}

/* ============================ 续跑指令（R1-a 通道隔离） ============================ */

/**
 * 合成唯一允许的 A2A 续跑指令文本（不含 MCP 续跑标记）。
 * 无 taskId 时省略 taskId 字段，与宿主桥 `buildA2aResumeHint` 的两形态保持一致。
 */
export function buildResumeInstruction(approvalId: string, taskId: string): string {
  const head = taskId ? `taskId: "${taskId}", ` : '';
  return `${APPROVAL_CARD_REPLY_TOOL} { ${head}approvalId: "${approvalId}", approved: true }`;
}

/**
 * 续跑指令取值：宿主桥 `resumeHint` 为权威（含 K5 underlying 语义），但必须通过 R1-a 校验；
 * 含 MCP 续跑标记（通道串台）或不含 `a2a.approval.reply`（非 A2A 续跑指令）则**弃用**，
 * 退回本地合成的标准指令文本——绝不把 MCP 通道标记带进卡片。
 */
function deriveResumeInstruction(resumeHint: string, approvalId: string, taskId: string): string {
  const canonical = buildResumeInstruction(approvalId, taskId);
  if (!resumeHint) return canonical;
  const containsMcpMarker = resumeHint.includes(MCP_RESUME_MARKER);
  const isA2aReply = resumeHint.includes(APPROVAL_CARD_REPLY_TOOL);
  return !containsMcpMarker && isA2aReply ? resumeHint : canonical;
}

/* ============================ 降级判定（§A4：任一不可用 → 逐字走文本模板） ============================ */

/**
 * 把两种输入形态收敛为「原始字段包」。不做缺失拦截，只做取值与优先级。
 */
function readRawFields(input: ApprovalCardInput | ApprovalCardApprovalLike | null | undefined): {
  approvalId: string;
  taskId: string;
  resumeHint: string;
  riskRaw: string;
  /**
   * risk 字段是否**被下发过**（含被下发成非字符串 / 非法字面值的情况）。
   * 必须与 `riskRaw` 分开判定：VM 下发 `risk: 2` / `risk: {}` 这类**畸形值**时，
   * 归一化后会变成空串，若只看归一化结果就会被误判成「风险缺失」——
   * 而「缺失」和「非法」是两回事（§4 要求非法必须明确报错，不得当成缺省）。
   */
  riskGiven: boolean;
  capabilityId: string;
  summary: string;
  message: string;
  underlyingId: string;
  underlyingParams: string;
  underlyingGoal: string;
  impactRaw: unknown;
  previewRaw: unknown;
} {
  if (input === null || input === undefined || typeof input !== 'object') {
    return {
      approvalId: '', taskId: '', resumeHint: '', riskRaw: '', riskGiven: false, capabilityId: '', summary: '', message: '',
      underlyingId: '', underlyingParams: '', underlyingGoal: '', impactRaw: undefined, previewRaw: undefined,
    };
  }
  const nested = (input as ApprovalCardInput).approval ?? null;
  const flat = input as ApprovalCardApprovalLike;
  const first = (a: string, b: string): string => (a ? a : b);
  const firstUnknown = (a: unknown, b: unknown): unknown => (a !== undefined && a !== null ? a : b);
  const underlying = nested?.underlying ?? flat.underlying ?? null;
  const riskValue = firstUnknown(flat.risk, nested?.risk);
  return {
    approvalId: first(asText(flat.approvalId), asText(nested?.approvalId ?? '')),
    taskId: asText((input as ApprovalCardInput).taskId),
    resumeHint: first(asText(flat.resumeHint), asText(nested?.resumeHint ?? '')),
    riskRaw: first(asText(flat.risk), asText(nested?.risk ?? '')),
    // 判定口径：未下发 / 下发为空串 → 视为「缺失」；下发了畸形值（非字符串、或字符串但非 L0–L3）→ 「非法」
    riskGiven:
      riskValue !== undefined &&
      riskValue !== null &&
      !(typeof riskValue === 'string' && riskValue.trim() === ''),
    capabilityId: first(asText(flat.capabilityId), asText(nested?.capabilityId ?? '')),
    summary: first(asText(flat.summary), asText(nested?.summary ?? '')),
    message: first(asText(flat.message), asText(nested?.message ?? '')),
    underlyingId: asText(underlying?.capabilityId ?? ''),
    underlyingParams: asText(underlying?.paramsSummary ?? ''),
    underlyingGoal: asText(underlying?.goalText ?? ''),
    impactRaw: firstUnknown(flat.impact, nested?.impact),
    previewRaw: firstUnknown(flat.preview, nested?.preview),
  };
}

/** 归一化后的填充材料（含降级判定所需的全部原始信息） */
export interface NormalizedApprovalCard {
  readonly data: ApprovalCardData;
  /** 触发的降级槽位（§5 固定串被使用的项），供宿主 agent 判断是否需要额外口头说明 */
  readonly degradedSlots: readonly string[];
  /** 续跑指令是否被替换为本地标准文本（resumeHint 含通道串台标记时为 true） */
  readonly resumeHintSanitized: boolean;
  /** 归一化后的风险等级（恒为 L2/L3 —— L0/L1 不出卡） */
  readonly risk: RiskLevel;
  /** L3 时为 true：需二次确认（模板 §2），卡片必须显式呈现该要求 */
  readonly requiresDoubleConfirm: boolean;
}

/**
 * **不出卡**的原因码。必须区分两类语义——把「本就不该有审批」误当成「降级到文本确认」
 * 会给宿主 agent 留下多余的确认口实（approval-card.md §7 是**直接执行**，不是**换一种确认方式**）。
 *
 *   - `NO_INPUT`            ：输入缺失或非对象；
 *   - `L0_L1_NO_CARD`       ：§7 不弹卡清单——L0/L1 直接执行，**既不弹卡也不产生二次确认**；
 *   - `MISSING_APPROVAL_ID` ：§4 末行 + §7「缺少 approvalId：无从应答，**不得出卡片**」；
 *   - `MISSING_RISK`        ：§4「风险缺失 → 不出卡片，明确报错」（**绝不猜测**风险等级）；
 *   - `INVALID_RISK`        ：risk 非封闭字面值（L0–L3 之外），同上不得猜测；
 *   - `NO_RESUME_PATH`      ：既无 resumeHint 又无 taskId —— 用户确认后无从应答。
 */
export type ApprovalCardSkipReason =
  | 'NO_INPUT'
  | 'L0_L1_NO_CARD'
  | 'MISSING_APPROVAL_ID'
  | 'MISSING_RISK'
  | 'INVALID_RISK'
  | 'NO_RESUME_PATH';

/** 归一化失败结果（携带原因码） */
export type ApprovalCardNormalizeResult =
  | { readonly ok: true; readonly card: NormalizedApprovalCard }
  | { readonly ok: false; readonly reason: ApprovalCardSkipReason };

/** 出卡所需的全部硬前提检查；通过则返回 null（可出卡） */
function skipReasonFor(input: ApprovalCardInput | ApprovalCardApprovalLike | null | undefined): ApprovalCardSkipReason | null {
  if (input === null || input === undefined || typeof input !== 'object') return 'NO_INPUT';
  const raw = readRawFields(input);
  if (!raw.approvalId) return 'MISSING_APPROVAL_ID';
  // 「没下发」与「下发了但畸形」必须分别报错（§4：风险缺失 → 不出卡并明确报错）
  if (!raw.riskGiven) return 'MISSING_RISK';
  if (!RISK_VALUES.includes(raw.riskRaw)) return 'INVALID_RISK';
  // §7：L0/L1 直接执行，不产生审批卡片与二次确认
  if (raw.riskRaw === 'L0' || raw.riskRaw === 'L1') return 'L0_L1_NO_CARD';
  // 续跑途径：至少其一，否则确认后无从应答
  if (!raw.resumeHint && !raw.taskId) return 'NO_RESUME_PATH';
  return null;
}

/**
 * 归一化 + 降级判定。**优先用此函数**（能拿到不出卡的原因码）。
 */
export function tryNormalizeApprovalCard(
  input: ApprovalCardInput | ApprovalCardApprovalLike | null | undefined,
): ApprovalCardNormalizeResult {
  const reason = skipReasonFor(input);
  if (reason) return { ok: false, reason };

  const raw = readRawFields(input);
  const risk = raw.riskRaw as RiskLevel;

  const previewObj: Record<string, unknown> | null =
    raw.previewRaw !== null && typeof raw.previewRaw === 'object' && !Array.isArray(raw.previewRaw)
      ? (raw.previewRaw as Record<string, unknown>)
      : null;

  const operation = deriveOperation(raw.underlyingId, raw.capabilityId);
  const inference = raw.underlyingParams || raw.underlyingGoal || raw.summary;
  const target = deriveTarget(raw.underlyingParams, raw.underlyingGoal, previewObj);
  const impact = deriveImpact(raw.impactRaw, inference);
  const reversibility = deriveReversibility(risk, operation, previewObj);
  const preview = derivePreview(raw.previewRaw, raw.summary || raw.message);
  const resumeHint = raw.resumeHint;
  const resumeInstruction = deriveResumeInstruction(resumeHint, raw.approvalId, raw.taskId);
  // true = 宿主桥下发的 resumeHint 被弃用（含 MCP 续跑标记或非 A2A 指令），已换成本地标准文本
  const resumeHintSanitized = resumeHint !== '' && resumeInstruction !== resumeHint;

  // 「真实目标行」（§A3.3 末行）：仅在 underlying 下发时出现，缺省整行省略
  const goalBits: string[] = [];
  if (raw.underlyingGoal) goalBits.push(`目标意图：${raw.underlyingGoal}`);
  if (raw.underlyingParams) goalBits.push(`参数摘要：${raw.underlyingParams}`);
  const underlyingGoalRow =
    goalBits.length === 0
      ? ''
      : `<div class="wac-row"><span class="wac-k">真实目标</span><span class="wac-v">${escapeHtml(goalBits.join(' · '))}</span></div>`;

  const degradedSlots: string[] = [];
  if (operation === APPROVAL_CARD_FALLBACK_TEXTS.operation) degradedSlots.push('操作');
  if (target === APPROVAL_CARD_FALLBACK_TEXTS.target) degradedSlots.push('目标');
  if (impact.length === 1 && impact[0] !== undefined && impact[0].startsWith(APPROVAL_CARD_FALLBACK_TEXTS.impactInferredPrefix)) {
    degradedSlots.push('影响清单');
  }
  if (reversibility === APPROVAL_CARD_REVERSIBILITY_TEXTS.unknown) degradedSlots.push('可逆性');
  if (preview === APPROVAL_CARD_FALLBACK_TEXTS.preview) degradedSlots.push('预览');

  return {
    ok: true,
    card: {
      data: {
        capabilityId: operation,
        risk,
        target,
        channel: deriveChannel(raw.taskId),
        impact,
        reversibility,
        preview,
        approvalId: raw.approvalId,
        taskId: raw.taskId,
        resumeInstruction,
        underlyingGoalRow,
      },
      degradedSlots,
      resumeHintSanitized,
      risk,
      requiresDoubleConfirm: risk === 'L3',
    },
  };
}

/**
 * 降级判定（布尔形式，任务书 R1 要求的「降级判定函数」）。
 * true ⇒ **不出卡**：缺 `risk` / 审批 ID / 续跑途径之一，或输入非法。
 * 调用方必须**逐字**改用 references/approval-card.md 文本模板。
 *
 * 注意：`risk = L0/L1` 也返回 true（§7 不弹卡），但那是「无需确认、直接执行」，
 * 不是「换成文本确认」——需要区分语义时请用 `tryNormalizeApprovalCard()` 取 reason 码。
 */
export function needsTextFallback(input: ApprovalCardInput | ApprovalCardApprovalLike | null | undefined): boolean {
  return !tryNormalizeApprovalCard(input).ok;
}

/** 需要走文本模板兜底的原因码（`L0_L1_NO_CARD` 不在其中：那是直接执行，不是换种确认方式） */
export function isTextFallbackReason(reason: ApprovalCardSkipReason): boolean {
  return reason !== 'L0_L1_NO_CARD';
}

/**
 * 模板常量自身体检（install-time 用，与 `auditApprovalCardHtml` 互补）：
 * 模板天然含占位符，不能直接套 `auditApprovalCardHtml`，此处只断言三条不变量：
 *   1. 零 MCP 续跑标记（R1-a）；
 *   2. 占位符集合 ⊆ fillApprovalCard 的替换表（防加了槽位忘接线，产物残留 `{{X}}`）；
 *   3. 不含任何可执行回调面（R1-b），且必须展示 A2A 续跑指令工具名。
 */
export function auditApprovalCardTemplate(): readonly string[] {
  const problems: string[] = [];
  const template = APPROVAL_CARD_WIDGET_HTML;
  if (template.includes(MCP_RESUME_MARKER)) {
    problems.push('R1-a 违规：模板常量中出现 MCP 续跑标记');
  }
  // 模板侧只能要求「有续跑指令槽位」——工具名本身由 {{RESUME_INSTRUCTION}} 填充带入，
  // 对填充产物的工具名校验在 auditApprovalCardHtml() 里做。
  if (!template.includes('{{RESUME_INSTRUCTION}}')) {
    problems.push('R1-a 违规：模板缺少续跑指令槽位');
  }
  const found = [...new Set((template.match(/\{\{[A-Z_]+\}\}/g) ?? []).sort())];
  const unsupported = found.filter((token) => !(token in CARD_PLACEHOLDERS));
  if (unsupported.length > 0) {
    problems.push(`模板含未接线的占位符：${unsupported.join(', ')}`);
  }
  const unused = Object.keys(CARD_PLACEHOLDERS).filter((token) => !found.includes(token));
  if (unused.length > 0) {
    problems.push(`替换表含模板已不存在的占位符：${unused.join(', ')}`);
  }
  for (const banned of BANNED_CALLBACK_TOKENS) {
    if (template.includes(banned)) problems.push(`R1-b 违规：模板出现可执行回调面 ${banned}`);
  }
  return problems;
}


/** 模板禁止出现的可执行回调面（R1-b：卡片绝不直调工具） */
const BANNED_CALLBACK_TOKENS: readonly string[] = [
  'sendPrompt(',
  'fetch(',
  'XMLHttpRequest',
  'postMessage(',
  'window.external',
  'eval(',
  'import(',
];

/** 模板占位符 → 填充来源说明（fillApprovalCard 的替换表键集，供自检比对） */
const CARD_PLACEHOLDERS: Readonly<Record<string, string>> = {
  '{{ROOT_ID}}': 'approvalId 派生的 DOM id',
  '{{HEAD_TITLE}}': 'L2/L3 标题',
  '{{RISK_BADGE}}': '风险徽标文本',
  '{{RISK_TONE}}': '风险徽标色调类名',
  '{{SLOT_OPERATION}}': '槽位·操作',
  '{{SLOT_TARGET}}': '槽位·目标',
  '{{SLOT_CHANNEL}}': '槽位·通道',
  '{{SLOT_IMPACT}}': '槽位·影响清单',
  '{{SLOT_REVERSIBILITY}}': '槽位·可逆性',
  '{{SLOT_PREVIEW}}': '槽位·预览',
  '{{ROW_UNDERLYING_GOAL}}': '真实目标行（可空）',
  '{{APPROVAL_ID}}': '审批 ID',
  '{{RESUME_INSTRUCTION}}': 'A2A 续跑指令文本',
  '{{ROW_DOUBLE_CONFIRM}}': 'L3 二次确认行（可空）',
};

/* ============================ HTML 模板 ============================ */

/**
 * 自包含 HTML 审批卡模板（show_widget 直接可用；无 `<html>/<head>/<body>`，无外部资源）。
 *
 * 占位符（必须由 fillApprovalCard 全部替换，validate() 与测试双向断言「渲染产物零残留占位符」）：
 *   {{ROOT_ID}}            唯一根节点 id（按 approvalId 收敛）
 *   {{HEAD_TITLE}}         标题（L2「需要你确认」/ L3「高危操作，需要二次确认」）
 *   {{RISK_BADGE}}         风险徽标文本（L2/L3 + 定性词）
 *   {{RISK_TONE}}          徽标色调类名（白名单：L3 → wac-l3；L2 → 空）
 *   {{SLOT_OPERATION}} {{SLOT_TARGET}} {{SLOT_CHANNEL}} {{SLOT_REVERSIBILITY}} {{SLOT_PREVIEW}}
 *   {{SLOT_IMPACT}}        已转义的 <li>…</li> 序列
 *   {{APPROVAL_ID}}        审批 ID（等宽展示）
 *   {{ROW_UNDERLYING_GOAL}} 真实目标行整行 HTML（可为空串）
 *   {{ROW_DOUBLE_CONFIRM}} L3 二次确认行整行 HTML（L2 为空串）——approval-card.md §2 硬要求
 *   {{RESUME_INSTRUCTION}} A2A 续跑指令文本（白名单合成，绝不含 MCP 续跑标记）
 *
 * 交互纪律（裁定 Q2）：按钮 `data-wac-choice` 只做**视觉选中态 + 提示文案 + 指令高亮**，
 * 绝不触发任何工具/网络/会话回调；权威收口来自 AskUserQuestion。
 */
export const APPROVAL_CARD_WIDGET_HTML: string = `<style>
.wac{font-family:var(--font-sans);font-size:13px;line-height:1.6;color:var(--color-text-primary);background:var(--color-background-primary);border:0.5px solid var(--color-border-danger);border-radius:var(--border-radius-lg);padding:1rem 1.25rem;max-width:680px}
.wac-head{display:flex;align-items:center;gap:8px;margin-bottom:12px}
.wac-title{font-weight:500;font-size:15px}
.wac-badge{font-size:12px;padding:2px 8px;border-radius:var(--border-radius-md);background:var(--color-background-warning);color:var(--color-text-warning)}
.wac-l3{background:var(--color-background-danger);color:var(--color-text-danger)}
.wac-row{display:flex;gap:10px;padding:5px 0;border-top:0.5px solid var(--color-border-tertiary)}
.wac-k{flex:0 0 74px;color:var(--color-text-secondary)}
.wac-v{flex:1;min-width:0;word-break:break-word}
.wac-impact{margin:0;padding-left:18px}
.wac-code{font-family:var(--font-mono);font-size:12px;background:var(--color-background-secondary);padding:6px 8px;border-radius:var(--border-radius-md);word-break:break-all}
.wac-btns{display:flex;gap:8px;margin-top:12px}
.wac-confirm{border-left:2px solid var(--color-border-danger)}
.wac-picked{border:2px solid var(--color-border-info)}
.wac-note{margin-top:8px;font-size:12px;color:var(--color-text-secondary)}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
</style>
<div class="wac" id="{{ROOT_ID}}" role="group" aria-label="审批卡">
  <h2 class="sr-only">待审批：{{SLOT_OPERATION}}，风险等级 {{RISK_BADGE}}，审批 ID {{APPROVAL_ID}}</h2>
  <div class="wac-head">
    <span class="wac-title">{{HEAD_TITLE}}</span>
    <span class="wac-badge {{RISK_TONE}}">{{RISK_BADGE}}</span>
  </div>
  <div class="wac-row"><span class="wac-k">操作</span><span class="wac-v">{{SLOT_OPERATION}}</span></div>
  <div class="wac-row"><span class="wac-k">目标</span><span class="wac-v">{{SLOT_TARGET}}</span></div>
  <div class="wac-row"><span class="wac-k">通道</span><span class="wac-v">{{SLOT_CHANNEL}}</span></div>
  <div class="wac-row"><span class="wac-k">影响清单</span><span class="wac-v"><ol class="wac-impact">{{SLOT_IMPACT}}</ol></span></div>
  <div class="wac-row"><span class="wac-k">可逆性</span><span class="wac-v">{{SLOT_REVERSIBILITY}}</span></div>
  <div class="wac-row"><span class="wac-k">预览</span><span class="wac-v">{{SLOT_PREVIEW}}</span></div>
  {{ROW_UNDERLYING_GOAL}}
  <div class="wac-row"><span class="wac-k">审批ID</span><span class="wac-v"><span class="wac-code">{{APPROVAL_ID}}</span></span></div>
  <div class="wac-row"><span class="wac-k">续跑指令</span><span class="wac-v"><span class="wac-code" data-wac-instruction>{{RESUME_INSTRUCTION}}</span></span></div>
  {{ROW_DOUBLE_CONFIRM}}
  <div class="wac-btns">
    <button type="button" data-wac-choice="approve">批准（仅展示续跑指令）</button>
    <button type="button" data-wac-choice="reject">拒绝（任务终止）</button>
  </div>
  <p class="wac-note" data-wac-note>本卡片只展示，不放行：点击按钮不会执行任何操作。请在随后的问题中选择「批准 / 拒绝」，那是唯一的放行依据。</p>
</div>
<script>
(function () {
  var root = document.getElementById('{{ROOT_ID}}');
  if (!root) return;
  var btns = root.querySelectorAll('[data-wac-choice]');
  var note = root.querySelector('[data-wac-note]');
  var i;
  for (i = 0; i < btns.length; i++) {
    btns[i].addEventListener('click', function (ev) {
      var btn = ev.currentTarget;
      var choice = btn.getAttribute('data-wac-choice');
      var j;
      for (j = 0; j < btns.length; j++) btns[j].classList.remove('wac-picked');
      btn.classList.add('wac-picked');
      if (note) {
        note.textContent = choice === 'approve'
          ? '已记录视觉选择。放行仍未发生：请在随后的问题中选择「批准」。本卡片不会调用任何工具。'
          : '已记录视觉选择。请在随后的问题中选择「拒绝」以终止任务。本卡片不会调用任何工具。';
      }
    });
  }
})();
</script>
`;

/* ============================ 填充 ============================ */

/** 把 approvalId 收敛为合法 DOM id 片段（仅字母数字与连字符） */
function toDomIdFragment(approvalId: string): string {
  const cleaned = approvalId.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : 'unknown';
}

/** 风险徽标文本：字面等级 + 定性词（不引入未下发的 judgement） */
function riskBadge(risk: RiskLevel): string {
  return risk === 'L3' ? 'L3 关键高危' : 'L2 破坏性';
}

/** 卡片标题（对应文本模板 §1「需要你确认」/ §2「高危操作，需要二次确认」） */
function headTitle(risk: RiskLevel): string {
  return risk === 'L3' ? '高危操作，需要二次确认' : '需要你确认（破坏性操作）';
}

/**
 * L3 二次确认行（approval-card.md §2 硬要求：必须给出完整短句要求，
 * 且明确「仅回复好的/可以/继续不被接受」）。L2 返回空串（整行省略）。
 */
function doubleConfirmRow(risk: RiskLevel): string {
  if (risk !== 'L3') return '';
  const text =
    '二次确认（必填）：请在随后的问题中选择「确认执行」并核对审批 ID；' +
    '仅回复「好的 / 可以 / 继续」不会被接受。';
  return `<div class="wac-row wac-confirm"><span class="wac-k">二次确认</span><span class="wac-v">${escapeHtml(text)}</span></div>`;
}

/**
 * 渲染卡片 HTML。
 *
 * @returns 自包含 HTML 片段；**null 表示不出卡**（缺 risk / 审批 ID / 续跑途径，
 *          调用方必须逐字改用 references/approval-card.md 文本模板 —— §A4 强制兜底路径）。
 */
export function fillApprovalCard(input: ApprovalCardInput | ApprovalCardApprovalLike | null | undefined): string | null {
  const result = tryNormalizeApprovalCard(input);
  if (!result.ok) return null;
  const card = result.card;
  const d = card.data;

  const impactHtml = d.impact
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join('');
  // 影响清单至少一项已由 deriveImpact 保证（降级固定串）

  const replacements: Record<string, string> = {
    '{{ROOT_ID}}': `wac-${toDomIdFragment(d.approvalId)}`,
    '{{HEAD_TITLE}}': escapeHtml(headTitle(card.risk)),
    '{{RISK_BADGE}}': escapeHtml(riskBadge(card.risk)),
    '{{RISK_TONE}}': card.risk === 'L3' ? 'wac-l3' : '',
    '{{SLOT_OPERATION}}': escapeHtml(d.capabilityId),
    '{{SLOT_TARGET}}': escapeHtml(d.target),
    '{{SLOT_CHANNEL}}': escapeHtml(d.channel),
    '{{SLOT_IMPACT}}': impactHtml,
    '{{SLOT_REVERSIBILITY}}': escapeHtml(d.reversibility),
    '{{SLOT_PREVIEW}}': escapeHtml(d.preview),
    '{{ROW_UNDERLYING_GOAL}}': d.underlyingGoalRow,
    '{{APPROVAL_ID}}': escapeHtml(d.approvalId),
    '{{RESUME_INSTRUCTION}}': escapeHtml(d.resumeInstruction),
    '{{ROW_DOUBLE_CONFIRM}}': doubleConfirmRow(card.risk),
  };

  let html = APPROVAL_CARD_WIDGET_HTML;
  for (const [placeholder, value] of Object.entries(replacements)) {
    html = html.split(placeholder).join(value);
  }
  return html;
}

/**
 * 产物红线自检（供 validate() 与宿主 agent 复用）：
 * 返回违规项列表，空数组即通过。
 *
 * 作用对象是 **fillApprovalCard() 的填充产物**，不是模板常量本身
 * （模板常量必然含占位符，对它自检会报「占位符未填充」——这是预期行为，
 * 模板常量的结构约束由 `r1-approval-card.test.js` 直接断言）。
 */
export function auditApprovalCardHtml(html: string): readonly string[] {
  const problems: string[] = [];
  if (!html) {
    problems.push('卡片 HTML 为空');
    return problems;
  }
  if (html.includes(MCP_RESUME_MARKER)) {
    problems.push('R1-a 通道隔离违规：产物中出现 MCP 续跑标记');
  }
  if (!html.includes(APPROVAL_CARD_REPLY_TOOL)) {
    problems.push('R1-a 违规：产物中缺少唯一允许的 A2A 续跑指令');
  }
  const residue = html.match(/\{\{[A-Z_]+\}\}/g);
  if (residue) {
    problems.push(`占位符未填充：${[...new Set(residue)].join(', ')}`);
  }
  for (const label of APPROVAL_CARD_SLOT_LABELS) {
    if (label === '风险') continue; // 风险以徽标形式呈现，非 wac-k 行
    if (!html.includes(`>${label}<`)) problems.push(`七槽位缺失：${label}`);
  }
  // 「风险」槽位（徽标）必须可判定为 L2/L3 之一 —— §7：L0/L1 不弹卡
  if (!/L[23] (破坏性|关键高危)/.test(html)) {
    problems.push('风险槽位缺失或非 L2/L3（§7：L0/L1 不弹卡）');
  }
  // 审批 ID + 续跑指令展示为必含项（§A3.3 / U5）
  if (!html.includes('>审批ID<')) problems.push('缺少审批 ID 展示行');
  if (!html.includes('>续跑指令<')) problems.push('缺少续跑指令展示行');
  for (const banned of BANNED_CALLBACK_TOKENS) {
    if (html.includes(banned)) problems.push(`R1-b 违规：出现可执行回调面 ${banned}`);
  }
  return problems;
}

/**
 * A2A 委派桥暴露给宿主 Agent 的 MCP 工具集
 *
 * 宿主经 MCP 调这些工具；本桥内部用 A2A client 调 VM 侧 /a2a，
 * 并把 A2A 的 status-update / artifact-update / input-required 事件翻译回 MCP 结果。
 */

import type { McpContent, McpTool } from '@winvm/mcp-framework';
import { applyBearerHeader } from '@winvm/core';
import { A2A, type RiskLevel } from '@winvm/contracts';

import type { A2aDelegateClient, DelegateStreamOptions } from './client.js';
import {
  CREDENTIAL_KEY_RE,
  REDACTED,
  hashApprovalPreview,
  recordHostApprovalAudit,
  redactCredentials,
  type HostApprovalAudit,
} from './approval-audit.js';

const RISK_LEVELS: readonly RiskLevel[] = ['L0', 'L1', 'L2', 'L3'];
const MAX_IMAGE_CONTENTS = 8;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 呈现文本脱敏：把 `凭据键[:=]值` 的值替换为 `凭据键=***REDACTED***`（键名来自统一并集正则） */
const CRED_TEXT_RE = new RegExp(`(${CREDENTIAL_KEY_RE.source})\\s*[:=]\\s*\\S+`, 'gi');

function scrubText(s: string): string {
  if (!s) return s;
  return s.replace(CRED_TEXT_RE, (_m, key: string) => `${key}=${REDACTED}`);
}

/** `impact` 逐项脱敏：`key=value` 形式且 key 命中凭据正则 → `key=***REDACTED***`；其余原样 */
function redactImpactItem(item: string): string {
  const eq = item.indexOf('=');
  if (eq <= 0) return item;
  const key = item.slice(0, eq).trim();
  if (!key || !CREDENTIAL_KEY_RE.test(key)) return item;
  return `${key}=${REDACTED}`;
}

/** 从 A2A Message 提取纯文本（用于进度与审批说明） */
export function extractText(message?: A2A.Message): string {
  if (!message?.parts) return '';
  const texts: string[] = [];
  for (const p of message.parts) {
    if (p.kind === 'text' && typeof (p as { text?: unknown }).text === 'string') {
      texts.push((p as { text: string }).text);
    }
  }
  return texts.join('\n').trim();
}

/**
 * K5（纯附加）：被拦截调用的**真实意图**（VM 侧 approval-request 的 data.underlying 透传）。
 *
 * 用途：外层被拦能力常是「壳」（如 appops.workflow.run），人工真正要批准的是内层目标；
 * 卡片只有壳名时信息量不足（真机取证：preview:{} / impact:[] → 卡片不可读）。
 */
export interface ExtractedUnderlying {
  readonly capabilityId?: string;
  readonly paramsSummary?: string;
  readonly goalText?: string;
}

export interface ExtractedApproval {
  readonly approvalId: string;
  readonly message: string;
  readonly risk?: RiskLevel;
  readonly capabilityId?: string;
  // ---- CL-016 追加（全部可选，保住既有断言与调用方）----
  /** 显式审批请求标记：仅当 data.type === 'approval-request' 时出现 */
  readonly kind?: 'approval-request';
  /** 人类可读摘要（优先 data.summary，其次「说明：」行，再次 text 首行） */
  readonly summary?: string;
  /** 影响清单（VM 已下发时原样透传，含空数组） */
  readonly impact?: readonly string[];
  /** dry-run 预览（VM 已下发时原样透传，含空对象） */
  readonly preview?: Record<string, unknown>;
  /** 宿主侧合成的续跑提示（A2A 通道，绝不含 MCP 续跑标记） */
  readonly resumeHint?: string;
  /** K5：真实意图（VM 下发时透传，各子字段缺失即省略；整块缺失则字段不出现） */
  readonly underlying?: ExtractedUnderlying;
  /**
   * CL-026：呈现要求指令（宿主 agent 的强制动作契约）。
   * 纯附加可选字段，取值恒等于 `APPROVAL_PRESENTATION_DIRECTIVE`（权威串单源）。
   */
  readonly presentationDirective?: string;
}

/**
 * CL-026 —— 审批卡强制呈现指令（**恰好 4 行**，行数被 `tests/unit/cl026-approval-presentation.test.js` C-1 钉死）。
 *
 * 病灶（真机实证 2026-10-20）：审批挂起时返回载荷数据齐全，但**没有任何一面指挥宿主 agent 出卡**，
 * 是否渲染审批卡全凭 agent 自由发挥（当时那张卡是主理人现场按 R17 规范手工渲染，非系统保证）。
 * 本常量把指挥信号下移到工具返回面 ⇒ 每次挂起必然「先 `show_widget` 出卡、再 `AskUserQuestion` 收口」。
 *
 * 纪律：
 * - **固定文本、零插值** ⇒ 天然不含凭据、不含 MCP 续跑标记（R1-a 通道隔离红线）；
 * - 渲染契约沿用 R17（`docs/design/r17-design.md` §A1.1）：视觉载体只展示不放行，
 *   权威放行只来自 `AskUserQuestion` 的结构化答案；
 * - 第三选项「暂不决定（超时观察）」= 「未作答」同义（不发续跑指令、任务恒挂起、fail-closed），
 *   **不是**第三种放行口实；
 * - 降级权威与槽位/续跑口径以 `references/approval-card.md`（唯一正文）为准，本串只引用不复述。
 * 规范文案入档：`docs/design/cl026-approval-presentation.md` §1。
 */
export const APPROVAL_PRESENTATION_DIRECTIVE: string = [
  '【呈现要求·MUST】① 先 show_widget 出审批卡：七槽位取本 approval 载荷（操作/目标=underlying 真实意图/通道/风险/影响清单/可逆性/预览），并展示 approvalId 与续跑指令。',
  '② 随后 AskUserQuestion 权威收口：批准 / 拒绝 / 暂不决定（超时观察，任务保持挂起），选项文案带 approvalId 摘要。',
  '③ 禁止用纯文本转呈代替出卡、禁止代替用户批准；show_widget 或 AskUserQuestion 任一不可用 → 逐字降级 references/approval-card.md 文本模板。',
  '④ 批准后调 a2a.approval.reply，再用 a2a.task.get 轮询至终态并汇报证据。',
].join('\n');

/**
 * 派生审批摘要（不得为空串或占位符）。
 * 优先级：`data.summary`（字符串且非空）→ 同消息 text part 中 `说明：` 起始行 → text 首行。
 */
function deriveSummary(summaryRaw: unknown, message?: A2A.Message): string | undefined {
  if (typeof summaryRaw === 'string' && summaryRaw.trim()) return summaryRaw.trim();
  const text = extractText(message);
  if (!text) return undefined;
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const marker = lines.find((l) => l.startsWith('说明：') || l.startsWith('说明:'));
  if (marker) {
    const value = marker.replace(/^说明[：:]\s*/, '').trim();
    if (value) return value;
  }
  return lines.length ? lines[0] : undefined;
}

/**
 * 从 A2A Message 提取审批闸请求（L2/L3 挂起时由 VM 侧下发）。
 *
 * 识别条件：`data.type === 'approval-request'` 且 `typeof approvalId === 'string'`。
 * 向后兼容：若 `data.type` 缺失但 `approvalId` 是字符串，仍按审批请求处理
 * （既有 fixture 仅含 approvalId/risk/capabilityId/message）。
 *
 * 透传规则（唯一规则）：`impact`/`preview` **存在且类型合法 → 原样透传；否则省略该字段**。
 * 全链路不输出 `undefined` 字面量。
 */
export function extractApproval(message?: A2A.Message): ExtractedApproval | undefined {
  const parts = message?.parts ?? [];
  for (const p of parts) {
    if (p.kind !== 'data') continue;
    const data = (p as { data?: unknown }).data;
    if (!isRecord(data)) continue;
    const approvalId = data['approvalId'];
    if (typeof approvalId !== 'string' || !approvalId) continue;

    // type 存在但非 'approval-request' → 不是审批请求；type 缺失则向后兼容放行
    const typeRaw = data['type'];
    const isExplicit = typeRaw === 'approval-request';
    if (typeRaw !== undefined && !isExplicit) continue;

    const riskRaw = data['risk'];
    const risk = typeof riskRaw === 'string' && (RISK_LEVELS as readonly string[]).includes(riskRaw)
      ? (riskRaw as RiskLevel)
      : undefined;
    const capabilityId = typeof data['capabilityId'] === 'string' ? data['capabilityId'] : undefined;

    // impact：字符串数组合法（含空数组）→ 逐项透传（凭据键项打码）；否则省略
    const impactRaw = data['impact'];
    const impact =
      Array.isArray(impactRaw) && impactRaw.every((s) => typeof s === 'string')
        ? (impactRaw as string[]).map(redactImpactItem)
        : undefined;

    // preview：record 合法（含空对象）→ 透传并对凭据键打码；否则省略
    const previewRaw = data['preview'];
    const preview = isRecord(previewRaw)
      ? (redactCredentials(previewRaw) as Record<string, unknown>)
      : undefined;

    const msg = scrubText(
      (typeof data['message'] === 'string' && data['message']) ||
        extractText(message) ||
        '该步骤需宿主确认后继续',
    );

    const summaryRaw = deriveSummary(data['summary'], message);
    const summary = summaryRaw ? scrubText(summaryRaw) : undefined;

    // K5 underlying：真实意图透传（record 合法才取；子字段逐个类型收敛，绝不输出 undefined 字面量）
    const underlying = extractUnderlying(data['underlying']);

    return {
      approvalId,
      message: msg,
      ...(risk ? { risk } : {}),
      ...(capabilityId ? { capabilityId } : {}),
      ...(isExplicit ? { kind: 'approval-request' as const } : {}),
      ...(summary ? { summary } : {}),
      ...(impact !== undefined ? { impact } : {}),
      ...(preview !== undefined ? { preview } : {}),
      ...(underlying ? { underlying } : {}),
    };
  }
  return undefined;
}

/**
 * K5：提取 approval-request data part 的 `underlying`（真实意图）。
 *
 * 纪律（与 impact/preview 同规则）：类型合法才透传、非法即整块省略、子字段缺失不写 undefined；
 * 文本做凭据脱敏（与 message/summary 同一 scrubText 口径）。
 */
function extractUnderlying(raw: unknown): ExtractedUnderlying | undefined {
  if (!isRecord(raw)) return undefined;
  const capabilityId = typeof raw['capabilityId'] === 'string' && raw['capabilityId'] ? raw['capabilityId'] : undefined;
  const paramsSummary =
    typeof raw['paramsSummary'] === 'string' && raw['paramsSummary'] ? scrubText(raw['paramsSummary']) : undefined;
  const goalText =
    typeof raw['goalText'] === 'string' && raw['goalText'] ? scrubText(raw['goalText']) : undefined;
  if (!capabilityId && !paramsSummary && !goalText) return undefined;
  return {
    ...(capabilityId ? { capabilityId } : {}),
    ...(paramsSummary ? { paramsSummary } : {}),
    ...(goalText ? { goalText } : {}),
  };
}

/**
 * 合成 A2A 通道续跑提示（逐字模板）。
 * **绝不包含 MCP 直调通道的续跑标记**（双下划线 + approvalId 的那个串，两通道不得混用）。
 *
 * K5：带 `underlying`（真实意图）时在其后追加一行「真实目标：…」，提升审批卡片信息量；
 * 不带时输出**逐字不变**（保住 CL-016 既有逐字断言）。
 */
export function buildA2aResumeHint(
  approvalId: string,
  taskId?: string,
  underlying?: ExtractedUnderlying,
): string {
  const base = taskId
    ? `（A2A 续跑）放行：a2a.approval.reply { taskId: "${taskId}", approvalId: "${approvalId}", approved: true }`
    : `（A2A 续跑）放行：a2a.approval.reply { approvalId: "${approvalId}", approved: true }`;
  const goal = describeUnderlying(underlying);
  return goal ? `${base}\n真实目标：${goal}（批准后由服务端按原始参数直接执行，无需 LLM 重发）` : base;
}

/** K5：把 underlying 收敛成一行可读的「真实目标」描述；无有效信息时返回 '' （不拼空句）。 */
function describeUnderlying(u?: ExtractedUnderlying): string {
  if (!u) return '';
  const parts: string[] = [];
  if (u.goalText) parts.push(u.goalText);
  if (u.capabilityId) parts.push(`能力 ${u.capabilityId}`);
  if (u.paramsSummary) parts.push(`参数 ${u.paramsSummary}`);
  return parts.join(' · ');
}

/** 幂等补挂 resumeHint（不改动其它字段；已有 resumeHint 则原样返回） */
export function withA2aResumeHint(a: ExtractedApproval, taskId?: string): ExtractedApproval {
  if (a.resumeHint) return a;
  return { ...a, resumeHint: buildA2aResumeHint(a.approvalId, taskId, a.underlying) };
}

/**
 * CL-026：幂等补挂呈现要求指令（与 `withA2aResumeHint` 同纪律——已有则原样返回，
 * 不改动其它字段）。取值恒为权威串 `APPROVAL_PRESENTATION_DIRECTIVE`（零插值）。
 */
export function withPresentationDirective(a: ExtractedApproval): ExtractedApproval {
  if (a.presentationDirective) return a;
  return { ...a, presentationDirective: APPROVAL_PRESENTATION_DIRECTIVE };
}

/**
 * CL-026b：审批挂起 summary 的**唯一拼接源**（L1 正常早退面与流断 catch 收口面共用）。
 *
 * 病灶（真机 tr_mvhqpd53_5）：VM 侧进入挂起（input-required）时把 SSE 长流掐断 ⇒
 * 桥 `for await` 抛 undici `TypeError: 'terminated'`（非 A2AClientError）落进 catch，
 * 旧 catch 恒返回 `A2A_DELEGATE_FAILED`（无 approval、无呈现指令）⇒ CL-026 出卡契约
 * 在**真实挂起路径**上形同虚设。catch 收口必须给出与正常路径**逐字同源**的挂起文案，
 * 故把 L1 的拼接抽成本函数（复制两份文案 = 未来的分叉源）。
 *
 * 红线保持：CL-016 前缀「任务挂起等待审批：」逐字不变；呈现要求仍是指向
 * `APPROVAL_PRESENTATION_DIRECTIVE` 权威串（零插值单源，本函数不新造任何固定文案）。
 */
function suspendSummaryText(approval: ExtractedApproval): string {
  return (
    `任务挂起等待审批：${approval.message}` +
    // K5：卡片信息量 —— 有真实意图（underlying）时把「真实目标」并入呈现文本（既有语义原样搬入）
    (describeUnderlying(approval.underlying)
      ? `\n真实目标：${describeUnderlying(approval.underlying)}`
      : '') +
    // CL-026 L1：呈现要求**尾部换行追加**（前缀逐字不变 ⇒ 既有逐字断言零回归）
    `\n${APPROVAL_PRESENTATION_DIRECTIVE}`
  );
}

/**
 * CL-026b：审批**携带面**（approval 载荷 + 宿主留痕）的单源构造器。
 *
 * 三个消费点共用同一函数 ⇒ 返回形态逐字同源，杜绝复制分叉：
 *   1. delegate 正常早退面（既有 L590-606 逻辑收拢于此，形态零变化）；
 *   2. delegate 流断 catch 收口面（CL-026b 新增——真机挂起即掐流，见 catch 注释）；
 *   3. task.get 观测面（既有 L666-682 逻辑收拢，形态零变化）。
 *
 * 构造 = `withPresentationDirective(withA2aResumeHint(...))`（两幂等函数均为既有权威，
 * 本器不新造任何文案）+ `recordHostApprovalAudit({result:'pending'})`（留痕口径不变）。
 */
function buildApprovalCarriers(
  approval: ExtractedApproval,
  taskId: string,
  traceId: string,
): { readonly approvalOut: ExtractedApproval; readonly approvalAuditOut: HostApprovalAudit } {
  const approvalOut = withPresentationDirective(withA2aResumeHint(approval, taskId));
  const approvalAuditOut = recordHostApprovalAudit({
    approvalId: approvalOut.approvalId,
    traceId,
    channel: 'a2a',
    ...(approvalOut.capabilityId ? { capabilityId: approvalOut.capabilityId } : {}),
    ...(approvalOut.risk ? { risk: approvalOut.risk } : {}),
    previewHash: hashApprovalPreview({
      ...(approvalOut.capabilityId ? { capabilityId: approvalOut.capabilityId } : {}),
      ...(approvalOut.risk ? { risk: approvalOut.risk } : {}),
      ...(approvalOut.preview !== undefined ? { preview: approvalOut.preview } : {}),
      ...(approvalOut.impact !== undefined ? { impact: approvalOut.impact } : {}),
    }),
    result: 'pending',
  });
  return { approvalOut, approvalAuditOut };
}

/** artifact 摘要（不含大块 base64，避免 MCP 结果膨胀） */
function summarizeArtifact(a: A2A.Artifact) {
  return {
    artifactId: a.artifactId,
    ...(a.name ? { name: a.name } : {}),
    ...(a.description ? { description: a.description } : {}),
    parts: a.parts.map((p) => {
      if (p.kind === 'text') return { kind: 'text' as const, preview: (p as { text: string }).text.slice(0, 500) };
      if (p.kind === 'file') {
        const f = (p as { file?: { name?: string; mimeType?: string; bytes?: string; uri?: string } }).file;
        return {
          kind: 'file' as const,
          ...(f?.name ? { name: f.name } : {}),
          ...(f?.mimeType ? { mimeType: f.mimeType } : {}),
          ...(f?.bytes !== undefined ? { bytes: f.bytes.length } : {}),
          ...(f?.uri ? { uri: f.uri } : {}),
        };
      }
      return { kind: p.kind };
    }),
  };
}

/** artifact → MCP content：图片回传图像，其余回传文本说明 */
function artifactToContents(a: A2A.Artifact): McpContent[] {
  const out: McpContent[] = [];
  for (const p of a.parts) {
    if (p.kind === 'text') {
      out.push({ type: 'text', text: (p as { text: string }).text });
    } else if (p.kind === 'file') {
      const f = (p as { file?: { name?: string; mimeType?: string; bytes?: string; uri?: string } }).file;
      if (f?.bytes && f.mimeType?.startsWith('image/') && out.length < MAX_IMAGE_CONTENTS) {
        out.push({ type: 'image', data: f.bytes, mimeType: f.mimeType });
      } else {
        out.push({
          type: 'text',
          text: `[产物] ${f?.name ?? a.name ?? a.artifactId}${f?.uri ? ` · ${f.uri}` : ''}${f?.mimeType ? ` · ${f.mimeType}` : ''}`,
        });
      }
    } else {
      const data = (p as { data?: unknown }).data;
      out.push({ type: 'text', text: `[数据] ${JSON.stringify(data ?? p).slice(0, 2000)}` });
    }
  }
  return out;
}

export interface A2aBridgeToolOptions {
  /** 客户端提供者（懒连接，隧道未建立时首次调用才连） */
  readonly clientProvider: { get(): Promise<A2aDelegateClient> };
  /** 默认最高风险（未显式声明时） */
  readonly defaultMaxRisk?: RiskLevel;
  readonly defaultTimeoutMs?: number;
  /** Agent Card 基址（HTTP 传输时用于探活） */
  readonly baseUrl?: string;
  /**
   * P3-b3 M4（audit §3.2 M4 / README"可审计"头条卖点）：`GET /audit/receipt` 桥接。
   * VM 侧端点已建成（S-3，receiptCache+链上记录+委派展开）但宿主 Agent 零可达路径
   * ——本工具把它包装成 `audit.receipt` MCP 工具，取证键=委派/调用 traceId。
   * bearer 走与 `EstablishOptions.headers` 同一权威函数 `applyBearerHeader`（三态：
   * 未给 tokenEnv ⇒ 无凭据可通；给了未设值 ⇒ fail-loud 转 AUTH_REQUIRED，绝不静默降级——
   * 与 cli `--token-env` 帮助文本"给出后未设值直接报错"逐字同纪律）。
   */
  readonly bearerTokenEnv?: string;
}

function readStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === 'string');
  return out.length ? out : undefined;
}

/**
 * ARCH-22 T5（设计 §1.1-6）：**取消前执行痕迹**的事实源派生。
 *
 * 病灶：旧 canceled 文案恒称「审批通道已关闭，未执行任何变更」—— 这是**不实陈述**。
 * 取消是协作式的（只到能力调用边界，见 §10 R10），取消点之前的能力调用**可能已经
 * 真实改动了虚拟机**；宿主把「未执行任何变更」呈现给用户，等于撤销了用户唯一
 * 可用的核对信号（用户会以为不用检查了）。
 *
 * 口径（只陈述可证事实）：
 *   - `steps`：优先取 `execution-steps` artifact（`kind:'steps'` / parts 内
 *     `data.steps` 数组）的条目数 —— 这是 provider 逐步执行记录的权威源；
 *     取不到时退回进度文本里的**确定性 step 标记**（`执行 <capabilityId>：<摘要>`，
 *     见 adapter-agent-workbuddy `step()` 的 onStatus 文案）。
 *   - `artifacts`：已收到的 artifact 总数，**扣除** steps 载体本身（它是执行记录，
 *     不是产物；计入会让「M 个产物」虚高）。
 *   - 两者皆 0 ⇒ 返回 `null`（走「取消点之前未执行」文案，且**不**附加字段）；
 *     任一非 0 ⇒ 返回计数并附加 `executedBeforeCancel`（判据③：两态可分即以此字段
 *     的有/无为判据）。
 *
 * ⚠ O-2 的必然结果（T3 移交第 7 条）：框架侧取消收口**不落 artifacts、不 updateStatus**，
 * 故 `execution-steps` 在取消路径上通常缺席 ⇒ steps 多半来自进度文本，纯 LLM 委派
 * 甚至两源皆空而只剩中间产物（M>0, N=0）。此时仍走事实化分支（M 是硬事实），
 * 文案里两个数字按实际值呈现，不做任何「至少执行了 N 步」的推断。登记偏差 D-32。
 */
const STEPS_CARRIER_NAME = 'execution-steps';
const DETERMINISTIC_STEP_MARK = /^执行\s+[A-Za-z0-9_.\-]+\s*[：:]/;

function deriveExecutedBeforeCancel(
  artifacts: readonly A2A.Artifact[],
  progress: readonly { state: string; message: string }[],
): { steps: number; artifacts: number } | null {
  let carrier: A2A.Artifact | undefined;
  for (const a of artifacts) {
    if (a.name === STEPS_CARRIER_NAME) {
      carrier = a;
      break;
    }
  }
  const stepsFromCarrier = ((): number => {
    if (!carrier) return -1;
    for (const p of carrier.parts) {
      const data = (p as { data?: unknown }).data;
      if (data && typeof data === 'object' && Array.isArray((data as { steps?: unknown }).steps)) {
        return ((data as { steps: readonly unknown[] }).steps).length;
      }
    }
    return -1;
  })();
  const steps = stepsFromCarrier >= 0 ? stepsFromCarrier : progress.filter((m) => DETERMINISTIC_STEP_MARK.test(m.message)).length;
  const artifactCount = artifacts.length - (carrier ? 1 : 0);
  if (steps === 0 && artifactCount === 0) return null;
  return { steps, artifacts: artifactCount };
}

/** 取消文案两态（§1.1-6 原文口径；`executed` 为 null 即「无执行痕迹」态）。 */
function canceledSummaryText(executed: { steps: number; artifacts: number } | null): string {
  return executed
    ? `任务已取消（canceled）；**取消前已有 ${executed.steps} 个操作执行、${executed.artifacts} 个产物**，请逐项核对 artifacts。` +
      '（如需继续，请重新发起并重新确认审批）'
    : '任务已取消（canceled），取消点之前的操作未执行。如需继续，请重新发起并重新确认审批。';
}

export function createA2aBridgeTools(opts: A2aBridgeToolOptions): McpTool[] {
  const defaultMaxRisk = opts.defaultMaxRisk ?? 'L1';
  const defaultTimeoutMs = opts.defaultTimeoutMs ?? 600_000;

  const goalSchema = {
    type: 'object',
    required: ['goal'],
    properties: {
      goal: { type: 'string', description: '交给 VM 内 AI Agent 的自然语言任务目标' },
      allowedCapabilities: {
        type: 'array',
        items: { type: 'string' },
        description: '最小权限：本次委派允许的能力范围，如 ["appops.*","gui.*"]；留空表示不限',
      },
      maxRisk: { type: 'string', enum: [...RISK_LEVELS], description: '本次委派允许的最高风险，默认 L1' },
      contextId: { type: 'string', description: '多轮续接同一上下文（可选）' },
      timeoutMs: {
        type: 'number',
        description:
          '等待上限毫秒，默认 600000。注意：VM 内 LLM 运行时**首次委派**需全额进程级冷启动' +
          '（真机实测 75–107s），此区间内的等待属正常冷启动窗口，不是故障；如需更长可显式调大。',
      },
    },
  };

  const delegate: McpTool = {
    name: 'a2a.delegate',
    title: 'A2A 委派给 VM 内 AI Agent',
    description:
      '把复杂/开放性任务目标经 A2A v1.0 委派给 Windows 虚拟机内的 AI Agent，流式接收执行进度与产物。' +
      '返回 taskId；若任务挂起在审批闸（input-required），返回 approvalId，宿主确认后用 a2a.approval.reply 放行。' +
      // CL-026 L4：说明书面上同步呈现要求（宿主 tools/list 稳定读到的唯一说明面）
      '挂起审批时返回体携带「呈现要求」：必须先 show_widget 出审批卡、再 AskUserQuestion 权威收口（禁止纯文本转呈、禁止代用户批准）。',
    inputSchema: goalSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    handler: async (params, ctx) => {
      const goal = typeof params['goal'] === 'string' ? params['goal'].trim() : '';
      if (!goal) {
        return {
          isError: true,
          structuredContent: { ok: false, error: { code: 'INVALID_PARAMS', message: 'goal 必填' } },
        };
      }
      const allowedCapabilities = readStringArray(params['allowedCapabilities']);
      const maxRiskRaw = params['maxRisk'];
      // 批1 F-3（来源标记）：区分「Agent 显式声明 maxRisk」与「宿主工具回退填充」。
      // 此前恒发 defaultMaxRisk（缺省 L1 最严档），VM 侧无从分辨 ⇒ 若把回退值当声明
      // 喂策略封顶闸，等于缺省拒绝全部 L2/L3 委派（可用性断崖，审计 F-3 预警）。
      // 线上诉语经 metadata.maxRiskSource 传给 VM 侧 buildGoal 判源。
      const maxRiskDeclaredByAgent =
        typeof maxRiskRaw === 'string' && (RISK_LEVELS as readonly string[]).includes(maxRiskRaw);
      const maxRisk = maxRiskDeclaredByAgent ? (maxRiskRaw as RiskLevel) : defaultMaxRisk;
      const timeoutMs = typeof params['timeoutMs'] === 'number' ? params['timeoutMs'] : defaultTimeoutMs;
      const contextIdIn = typeof params['contextId'] === 'string' ? params['contextId'] : undefined;

      let client: A2aDelegateClient;
      try {
        client = await opts.clientProvider.get();
      } catch (e) {
        return {
          isError: true,
          structuredContent: {
            ok: false,
            traceId: ctx.traceId,
            error: {
              code: 'TUNNEL_UNAVAILABLE',
              message: `无法连接 VM 侧 A2A 服务（请确认 SSH 隧道已建立）：${(e as Error).message}`,
            },
          },
        };
      }

      const streamOpts: DelegateStreamOptions = {
        traceId: ctx.traceId,
        maxRisk,
        // 批1 F-3：如实携带来源（'agent'=本次调用显式声明合法值；'host-default'=宿主回退填充）。
        // VM 侧 buildGoal 据此判定 maxRiskDeclared ⇒ 封顶闸只喂声明值。
        maxRiskSource: maxRiskDeclaredByAgent ? 'agent' : 'host-default',
        timeoutMs,
        ...(allowedCapabilities ? { allowedCapabilities } : {}),
        ...(contextIdIn ? { contextId: contextIdIn } : {}),
      };

      const progress: Array<{ state: string; message: string }> = [];
      const artifacts: A2A.Artifact[] = [];
      let taskId = '';
      let contextId = contextIdIn ?? '';
      let state: A2A.TaskState = 'submitted';
      let approval: ExtractedApproval | undefined;
      let timedOut = false;

      const deadline = Date.now() + timeoutMs;
      try {
        for await (const ev of client.streamMessage(goal, streamOpts)) {
          if (ev.kind === 'status-update') {
            taskId = ev.taskId;
            contextId = ev.contextId;
            state = ev.status.state;
            const text = extractText(ev.status.message);
            if (text) progress.push({ state, message: scrubText(text.slice(0, 2000)) });
            if (state === 'input-required') {
              approval = extractApproval(ev.status.message);
            }
            if (ev.final) break;
          } else if (ev.kind === 'artifact-update') {
            taskId = ev.taskId;
            artifacts.push(ev.artifact);
          }
          if (Date.now() > deadline) {
            timedOut = true;
            break;
          }
        }
      } catch (e) {
        /* ---- CL-026b：挂起 ≠ 失败（catch 内识别挂起态，正常收口） ----
         *
         * 病灶（主理人真机实测复现，traceId tr_mvhqpd53_5，非 mock）：L2 委派进入
         * 审批挂起（`input-required`）时，VM 侧把 SSE 长流掐断 ⇒ 本 `for await`
         * 抛 undici 原生 `TypeError: 'terminated'`（非 A2AClientError）落进 catch ⇒
         * 旧实现恒返回 `A2A_DELEGATE_FAILED`（无 approval、无 APPROVAL_PRESENTATION_DIRECTIVE）
         * ⇒ CL-026 的出卡契约在**真实挂起路径**上形同虚设（正常路径的 approval 分支
         * 根本走不到）。挂起事实已在流断裂前被循环体捕获（`state`/`approval` 局部变量），
         * catch 只是「观测通道断了」，不是「委派失败了」。
         *
         * 判据（与 VM 侧 server.ts `input-required` 不落 errorCode 的口径对称——
         * 「审批挂起不是执行错误」）：`state === 'input-required' && approval` 双条件
         * 同时成立才短路成挂起收口；**真·网络异常**（approval 缺席，循环尚未见过
         * 审批 DataPart）仍走原 A2A_DELEGATE_FAILED 错误收口——防误伤真网络错。
         */
        if (state === 'input-required' && approval) {
          const suspendedSummary = scrubText(suspendSummaryText(approval));
          const { approvalOut, approvalAuditOut } = buildApprovalCarriers(approval, taskId, ctx.traceId);
          const suspendedContents: McpContent[] = [{ type: 'text', text: suspendedSummary }];
          for (const a of artifacts) suspendedContents.push(...artifactToContents(a));
          return {
            // `isError:false` 且无 error 字段 ⇒ 业务事实是「挂起待审批」而非失败
            //（「挂起≠失败」判据与 VM 侧 server.ts 对 input-required 不落 errorCode 对称）；
            // `ok:false` 只陈述**本次调用**因流被掐断而未能正常收口（后续 artifact-update
            // 可能随掐流丢失，不得谎称调用完整成功）——两口径并存不矛盾，宿主续跑语义
            // 恒以 state==='input-required' + approval 载荷为准。
            isError: false,
            structuredContent: {
              ok: false,
              traceId: ctx.traceId,
              ...(taskId ? { taskId } : {}),
              ...(contextId ? { contextId } : {}),
              state,
              summary: suspendedSummary,
              progress,
              artifacts: artifacts.map(summarizeArtifact),
              approval: approvalOut,
              approvalAudit: approvalAuditOut,
              // **无 error 字段**：挂起不是失败（宿主消费方不得见 A2A_DELEGATE_FAILED）
            },
            content: suspendedContents,
          };
        }
        return {
          isError: true,
          structuredContent: {
            ok: false,
            traceId: ctx.traceId,
            ...(taskId ? { taskId } : {}),
            progress,
            error: { code: 'A2A_DELEGATE_FAILED', message: (e as Error).message },
          },
        };
      }

      const ok = state !== 'failed' && state !== 'rejected' && state !== 'canceled' && !timedOut;
      const lastMsg = progress.length ? progress[progress.length - 1]!.message : '';
      const timeoutSec = Math.round(timeoutMs / 1000);
      // ARCH-22 T5：取消态的事实化计数（其余分支不用，判空即 null ⇒ 走「未执行」文案）
      const executedBeforeCancel = state === 'canceled' ? deriveExecutedBeforeCancel(artifacts, progress) : null;
      // CL-016：分级终止文案，优先级 timedOut → rejected → canceled → approval(挂起) → lastMsg → 状态
      // 红线：三处终止文案均不得出现「超时默认批准/继续/放行」类暗示；
      //      亦**严禁**「已修复 / 已解决」类承诺措辞（CL-018 C2 AC2.2）。
      // CL-018 C2（AC2.2）：超时文案须如实说明 75–107s 属**正常冷启动窗口**，
      //   避免宿主/用户把正常冷启动误判为故障或「已知问题已修复」。
      // 呈现文本脱敏：summary 会作为 content[0].text 回传宿主，须剔除任何凭据明文
      const summary = scrubText(
        timedOut
          ? `委派等待超时（>${timeoutSec}s）：可能仍处于**正常冷启动窗口（75–107s）**` +
            `（VM 内 LLM 运行时首次/空闲回收后的首次委派需全额进程级冷启动），` +
            `也可能仍在 VM 侧挂起等待审批 —— 审批未获批准，L2/L3 操作不会被执行。` +
            `可用 a2a.task.get 查询后续结果，或以更大的 timeoutMs 重试。`
          : state === 'rejected'
            ? '任务已终止：审批被拒绝（rejected），未执行任何变更。如需继续，请重新发起该操作并再次确认。'
            : state === 'canceled'
              ? canceledSummaryText(executedBeforeCancel)
              : approval
                // CL-026b：文案拼接抽至 suspendSummaryText（与 catch 挂起收口**逐字同源**，
                // 前缀/K5/呈现要求追加三段语义与 CL-016/CL-026 L1 完全一致）
                ? suspendSummaryText(approval)
                : lastMsg || `任务状态：${state}`,
      );

      const contents: McpContent[] = [{ type: 'text', text: summary }];
      for (const a of artifacts) contents.push(...artifactToContents(a));

      // CL-016：A2A 通道续跑提示 + 宿主侧审批留痕（仅当挂起审批时）
      // CL-026 L2：再幂等补挂呈现要求指令（纯附加字段，既有字段零改动）
      // CL-026b：构造逻辑收拢至 buildApprovalCarriers（与 catch 挂起收口面、
      // task.get 观测面**三携带面单源**）——输出形态逐字不变（既有字段零改动）。
      const carriers = approval ? buildApprovalCarriers(approval, taskId, ctx.traceId) : undefined;
      const approvalOut = carriers?.approvalOut;
      const approvalAuditOut = carriers?.approvalAuditOut;

      return {
        isError: !ok,
        structuredContent: {
          ok,
          traceId: ctx.traceId,
          ...(taskId ? { taskId } : {}),
          ...(contextId ? { contextId } : {}),
          state,
          summary,
          ...(timedOut ? { timedOut: true } : {}),
          // ARCH-22 T5 §1.1-6（**纯附加**）：取消态且有可证执行痕迹时才出现本字段 ⇒
          // 判据③「宿主文案两态可分（有/无 executedBeforeCancel）」即以此键的有无为判据。
          ...(executedBeforeCancel ? { executedBeforeCancel } : {}),
          progress,
          artifacts: artifacts.map(summarizeArtifact),
          ...(approvalOut ? { approval: approvalOut } : {}),
          ...(approvalAuditOut ? { approvalAudit: approvalAuditOut } : {}),
        },
        content: contents,
      };
    },
  };

  const taskGet: McpTool = {
    name: 'a2a.task.get',
    title: '查询 A2A 任务状态与产物',
    description: '按 taskId 查询 VM 侧 A2A 任务的当前状态、进度消息与已产出 artifact（用于超时后取结果或轮询长任务）。',
    inputSchema: {
      type: 'object',
      required: ['taskId'],
      properties: {
        taskId: { type: 'string', description: 'a2a.delegate 返回的 taskId' },
        historyLength: { type: 'number', description: '回传的历史消息条数上限' },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async (params, ctx) => {
      const taskId = typeof params['taskId'] === 'string' ? params['taskId'] : '';
      if (!taskId) {
        return { isError: true, structuredContent: { ok: false, error: { code: 'INVALID_PARAMS', message: 'taskId 必填' } } };
      }
      let client: A2aDelegateClient;
      try {
        client = await opts.clientProvider.get();
      } catch (e) {
        return {
          isError: true,
          structuredContent: { ok: false, error: { code: 'TUNNEL_UNAVAILABLE', message: (e as Error).message } },
        };
      }
      try {
        const task = await client.getTask(taskId, typeof params['historyLength'] === 'number' ? params['historyLength'] : undefined);
        const message = scrubText(extractText(task.status.message));
        const approval = extractApproval(task.status.message);
        // CL-016：A2A 通道续跑提示 + 宿主侧审批留痕（仅当挂起审批时）
        // CL-026 L3：挂起审批经 task.get 观测到时**同样**携带呈现要求
        //（超时后取结果 / 重连后复查都是"宿主手里正握着一次待裁决审批"的时刻，
        //  不得因观测工具不同而降级为纯文本转呈）。
        // CL-026b：与 delegate 两收口面共用 buildApprovalCarriers（三携带面单源，形态逐字不变）。
        const carriers = approval ? buildApprovalCarriers(approval, task.id, ctx.traceId) : undefined;
        const approvalOut = carriers?.approvalOut;
        const approvalAuditOut = carriers?.approvalAuditOut;
        return {
          isError: false,
          structuredContent: {
            ok: true,
            traceId: ctx.traceId,
            taskId: task.id,
            contextId: task.contextId,
            state: task.status.state,
            ...(message ? { message } : {}),
            artifacts: (task.artifacts ?? []).map(summarizeArtifact),
            ...(approvalOut ? { approval: approvalOut } : {}),
            ...(approvalAuditOut ? { approvalAudit: approvalAuditOut } : {}),
          },
          content: [
            {
              type: 'text',
              // CL-026 L3（文案面）：挂起审批时同款追加呈现要求（与 delegate 的 L1 同一权威串）
              text:
                `任务 ${task.id} 状态：${task.status.state}${message ? `\n${message}` : ''}` +
                (approvalOut ? `\n${APPROVAL_PRESENTATION_DIRECTIVE}` : ''),
            },
            ...(task.artifacts ?? []).flatMap(artifactToContents),
          ],
        };
      } catch (e) {
        return {
          isError: true,
          structuredContent: { ok: false, traceId: ctx.traceId, taskId, error: { code: 'A2A_TASK_GET_FAILED', message: (e as Error).message } },
        };
      }
    },
  };

  const approvalReply: McpTool = {
    name: 'a2a.approval.reply',
    title: '应答 A2A 审批闸',
    description:
      '对挂起在审批闸（input-required）的 A2A 任务回复批准或拒绝。' +
      '必须先向用户展示影响清单并取得确认，严禁代替用户放行（fail-closed）。' +
      // CL-026 L5：从 reply 侧反向闭合，杜绝「未出卡直接 reply」
      '批准/拒绝只能来自 AskUserQuestion 的权威收口，且必须先完成 show_widget 审批卡呈现（呈现要求见 a2a.delegate 返回体）。',
    inputSchema: {
      type: 'object',
      required: ['taskId', 'approvalId', 'approved'],
      properties: {
        taskId: { type: 'string' },
        approvalId: { type: 'string', description: 'a2a.delegate 返回的 approval.approvalId' },
        approved: { type: 'boolean', description: 'true=批准放行；false=拒绝' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    handler: async (params, ctx) => {
      const taskId = typeof params['taskId'] === 'string' ? params['taskId'] : '';
      const approvalId = typeof params['approvalId'] === 'string' ? params['approvalId'] : '';
      const approved = params['approved'] === true;
      if (!taskId || !approvalId) {
        return {
          isError: true,
          structuredContent: { ok: false, error: { code: 'INVALID_PARAMS', message: 'taskId 与 approvalId 必填' } },
        };
      }
      let client: A2aDelegateClient;
      try {
        client = await opts.clientProvider.get();
      } catch (e) {
        return { isError: true, structuredContent: { ok: false, error: { code: 'TUNNEL_UNAVAILABLE', message: (e as Error).message } } };
      }
      try {
        const task = await client.replyApproval(taskId, approvalId, approved, { traceId: ctx.traceId });
        return {
          isError: false,
          structuredContent: {
            ok: true,
            traceId: ctx.traceId,
            taskId: task.id,
            state: task.status.state,
            approved,
            message: approved ? '已批准，VM 侧继续；用 a2a.task.get 跟踪结果' : '已拒绝，任务终止',
            artifacts: (task.artifacts ?? []).map(summarizeArtifact),
          },
          content: [{ type: 'text', text: `审批已${approved ? '批准' : '拒绝'}，任务 ${task.id} 当前状态：${task.status.state}` }],
        };
      } catch (e) {
        return {
          isError: true,
          structuredContent: { ok: false, traceId: ctx.traceId, taskId, error: { code: 'A2A_APPROVAL_FAILED', message: (e as Error).message } },
        };
      }
    },
  };

  const cancel: McpTool = {
    name: 'a2a.task.cancel',
    title: '取消 A2A 任务',
    description:
      '取消 VM 侧正在执行的 A2A 任务（用户要求中止时使用）。' +
      '注意：取消是**协作式**的（只到能力调用边界），已发起的操作可能已经真实改动虚拟机 —— ' +
      '宿主须用 a2a.task.get 核对 artifacts 并逐项向用户确认，**不得**据此宣称"未执行任何变更"。' +
      '返回体 `cancelObserved` 表示 VM 侧回包状态是否确为 canceled。' +
      '⚠ 分层口径：`ok:true` / `isError:false` 仅表示**取消请求被服务端处理成功（传输层）**，' +
      '不代表取消在业务上生效 —— 是否生效一律以 `cancelObserved` 为准；' +
      '该位为 `false` 时任务可能已自行结束（对已终态任务发 cancel 会回原终态）。',
    inputSchema: {
      type: 'object',
      required: ['taskId'],
      properties: { taskId: { type: 'string' } },
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    handler: async (params, ctx) => {
      const taskId = typeof params['taskId'] === 'string' ? params['taskId'] : '';
      if (!taskId) {
        return { isError: true, structuredContent: { ok: false, error: { code: 'INVALID_PARAMS', message: 'taskId 必填' } } };
      }
      let client: A2aDelegateClient;
      try {
        client = await opts.clientProvider.get();
      } catch (e) {
        return { isError: true, structuredContent: { ok: false, error: { code: 'TUNNEL_UNAVAILABLE', message: (e as Error).message } } };
      }
      try {
        const task = await client.cancelTask(taskId);
        // ARCH-22 T5（§1.1-6）：`cancelObserved` = VM 侧回包的 task.status.state 是否 canceled。
        // 与「请求已送达」区分开：服务端对已终态任务的 cancel 会回原终态（如 completed/failed），
        // 此时取消实际**没有生效**（没有任何东西被停）。旧返回体只有 state 一个字段，
        // 宿主 Agent 需要自己比较字符串；显式布尔位把「取消是否成立」变成一等公民，
        // SKILL 侧可据此决定是否提示用户核对产物。纯附加字段，既有字段语义不变。
        const cancelObserved = task.status.state === 'canceled';
        return {
          isError: false,
          structuredContent: {
            ok: true,
            traceId: ctx.traceId,
            taskId: task.id,
            state: task.status.state,
            cancelObserved,
          },
          content: [
            {
              type: 'text',
              text:
                `任务 ${task.id} 已请求取消，状态：${task.status.state}` +
                (cancelObserved
                  ? '（VM 侧已确认取消；取消点之前的操作可能已改动虚拟机，请核对 artifacts）'
                  : '（VM 侧回包状态并非 canceled ⇒ 取消未生效，任务可能已自行结束）') +
                // 分层口径（T5 收官小修）：`ok`/`isError` 是**传输层**事实（取消请求被服务端处理成功），
                // 业务层是否真的停下来了只看 `cancelObserved`。只澄清呈现，不改任何字段取值逻辑。
                '。口径：本次 `ok:true` 仅表示取消请求已被服务端处理（传输层成功），' +
                '取消是否在业务上生效以 `cancelObserved` 为准。',
            },
          ],
        };
      } catch (e) {
        return {
          isError: true,
          structuredContent: { ok: false, traceId: ctx.traceId, taskId, error: { code: 'A2A_CANCEL_FAILED', message: (e as Error).message } },
        };
      }
    },
  };

  const health: McpTool = {
    name: 'a2a.health',
    title: 'A2A 服务探活',
    description: '拉取 VM 侧 Agent Card，确认隧道与 A2A 服务可达，并列出 VM Agent 声明的技能。',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async (_params, ctx) => {
      let client: A2aDelegateClient;
      try {
        client = await opts.clientProvider.get();
      } catch (e) {
        return { isError: true, structuredContent: { ok: false, error: { code: 'TUNNEL_UNAVAILABLE', message: (e as Error).message } } };
      }
      try {
        const card = await client.getAgentCard(opts.baseUrl);
        if (!card) {
          return {
            isError: false,
            structuredContent: { ok: true, traceId: ctx.traceId, note: '当前传输不支持拉取 Agent Card（stdio 传输）' },
            content: [{ type: 'text', text: '当前传输不支持拉取 Agent Card' }],
          };
        }
        return {
          isError: false,
          structuredContent: {
            ok: true,
            traceId: ctx.traceId,
            name: card.name,
            version: card.version,
            url: card.url,
            protocolVersion: card.protocolVersion,
            skills: card.skills.map((s) => ({ id: s.id, name: s.name, description: s.description })),
          },
          content: [
            {
              type: 'text',
              text: `VM Agent「${card.name}」v${card.version} 可达（${card.url}），声明技能：${card.skills.map((s) => s.id).join(', ')}`,
            },
          ],
        };
      } catch (e) {
        return {
          isError: true,
          structuredContent: { ok: false, traceId: ctx.traceId, error: { code: 'A2A_HEALTH_FAILED', message: (e as Error).message } },
        };
      }
    },
  };

  const receipt: McpTool = {
    name: 'audit.receipt',
    title: 'VM 侧审计取证回查',
    description:
      '按 traceId（a2a.delegate 返回的 delegationTraceId，或直调回执里的 traceId）回查 VM 侧审计链记录与字段级回执。' +
      '只读；未命中返回空 records（HTTP 200 语义，不是错误）；委派级 traceId 命中壳条目时自动展开内层调用。',
    inputSchema: {
      type: 'object',
      required: ['traceId'],
      properties: {
        traceId: { type: 'string', description: '委派 traceId（tr_…）或单次调用 traceId' },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async (params, ctx) => {
      const traceId = typeof params['traceId'] === 'string' ? params['traceId'].trim() : '';
      if (!traceId) {
        return { isError: true, structuredContent: { ok: false, error: { code: 'INVALID_PARAMS', message: 'traceId 必填' } } };
      }
      if (!opts.baseUrl) {
        return {
          isError: true,
          structuredContent: { ok: false, traceId, error: { code: 'TRANSPORT_UNSUPPORTED', message: '当前 stdio 传输无 HTTP 基址，/audit/receipt 不可达' } },
        };
      }
      const tokenEnvName = opts.bearerTokenEnv;
      let authHeaders: Record<string, string>;
      try {
        // 与 establishTransport 同一权威 bearer 拼装函数（三态语义逐字一致：未配=无凭据、
        // 给了未设值=TransportError fail-loud ⇒ 转 AUTH_REQUIRED，绝不静默降级）。
        authHeaders = applyBearerHeader({ accept: 'application/json' }, tokenEnvName);
      } catch (e) {
        return {
          isError: true,
          structuredContent: { ok: false, traceId, error: { code: 'AUTH_REQUIRED', message: (e as Error).message } },
        };
      }
      const url = `${opts.baseUrl.replace(/\/+$/, '')}/audit/receipt?traceId=${encodeURIComponent(traceId)}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      try {
        const res = await fetch(url, {
          headers: authHeaders,
          signal: controller.signal,
        });
        if (res.status === 401) {
          return {
            isError: true,
            structuredContent: { ok: false, traceId, error: { code: 'AUTH_REQUIRED', message: 'VM 侧 enforceBearer 开启且本桥未配 token-env（cli --token-env）' } },
          };
        }
        if (!res.ok) {
          return {
            isError: true,
            structuredContent: { ok: false, traceId, error: { code: 'RECEIPT_FETCH_FAILED', message: `HTTP ${res.status} from ${url}` } },
          };
        }
        // 呈现面统一脱敏（凭据键族），与审批卡同款纪律
        const body = scrubText(await res.text());
        let json: unknown;
        try {
          json = JSON.parse(body);
        } catch {
          return { isError: true, structuredContent: { ok: false, traceId, error: { code: 'RECEIPT_PARSE_FAILED', message: '回执体非 JSON（VM 版本过旧？）' } } };
        }
          const records = isRecord(json) && Array.isArray(json['records']) ? json['records'] : [];
          const receipts = isRecord(json) && Array.isArray(json['receipts']) ? json['receipts'] : [];
          // 呈现面兜底脱敏：端点级脱敏在 VM 侧，但旧版 VM 无此保证 ⇒ 宿主侧同族正则再扫一遍（双保险）。
          const scrubbed = JSON.parse(scrubText(body)) as Record<string, unknown>;
          return {
            isError: false,
            structuredContent: { ok: true, traceId, ...scrubbed, recordCount: records.length, receiptCount: receipts.length },
          content: [{ type: 'text', text: `取证：链上记录 ${records.length} 条、字段级回执 ${receipts.length} 条${records.length === 0 ? '（未命中=该 traceId 从未到过 VM 或已过进程缓存窗口；链上为空才是硬未发生）' : ''}` }],
        };
      } catch (e) {
        const msg = e instanceof Error && e.name === 'AbortError' ? '回查超时（20000ms）' : (e as Error).message;
        return {
          isError: true,
          structuredContent: { ok: false, traceId, error: { code: 'TUNNEL_UNAVAILABLE', message: msg } },
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };

  return [delegate, taskGet, approvalReply, cancel, health, receipt];
}

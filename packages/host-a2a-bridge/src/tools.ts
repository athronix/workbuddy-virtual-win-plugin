/**
 * A2A 委派桥暴露给宿主 Agent 的 MCP 工具集
 *
 * 宿主经 MCP 调这些工具；本桥内部用 A2A client 调 VM 侧 /a2a，
 * 并把 A2A 的 status-update / artifact-update / input-required 事件翻译回 MCP 结果。
 */

import type { McpContent, McpTool } from '@winvm/mcp-framework';
import { A2A, type RiskLevel } from '@winvm/contracts';

import type { A2aDelegateClient, DelegateStreamOptions } from './client.js';

const RISK_LEVELS: readonly RiskLevel[] = ['L0', 'L1', 'L2', 'L3'];
const MAX_IMAGE_CONTENTS = 8;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
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

export interface ExtractedApproval {
  readonly approvalId: string;
  readonly message: string;
  readonly risk?: RiskLevel;
  readonly capabilityId?: string;
}

/** 从 A2A Message 提取审批闸请求（L2/L3 挂起时由 VM 侧下发） */
export function extractApproval(message?: A2A.Message): ExtractedApproval | undefined {
  const parts = message?.parts ?? [];
  for (const p of parts) {
    if (p.kind !== 'data') continue;
    const data = (p as { data?: unknown }).data;
    if (!isRecord(data)) continue;
    const approvalId = data['approvalId'];
    if (typeof approvalId !== 'string' || !approvalId) continue;
    const riskRaw = data['risk'];
    const risk = typeof riskRaw === 'string' && (RISK_LEVELS as readonly string[]).includes(riskRaw)
      ? (riskRaw as RiskLevel)
      : undefined;
    const capabilityId = typeof data['capabilityId'] === 'string' ? data['capabilityId'] : undefined;
    const msg =
      (typeof data['message'] === 'string' && data['message']) ||
      extractText(message) ||
      '该步骤需宿主确认后继续';
    return { approvalId, message: msg, ...(risk ? { risk } : {}), ...(capabilityId ? { capabilityId } : {}) };
  }
  return undefined;
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
}

function readStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === 'string');
  return out.length ? out : undefined;
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
      timeoutMs: { type: 'number', description: '等待上限毫秒，默认 600000' },
    },
  };

  const delegate: McpTool = {
    name: 'a2a.delegate',
    title: 'A2A 委派给 VM 内 AI Agent',
    description:
      '把复杂/开放性任务目标经 A2A v1.0 委派给 Windows 虚拟机内的 AI Agent，流式接收执行进度与产物。' +
      '返回 taskId；若任务挂起在审批闸（input-required），返回 approvalId，宿主确认后用 a2a.approval.reply 放行。',
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
      const maxRisk =
        typeof maxRiskRaw === 'string' && (RISK_LEVELS as readonly string[]).includes(maxRiskRaw)
          ? (maxRiskRaw as RiskLevel)
          : defaultMaxRisk;
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
            if (text) progress.push({ state, message: text.slice(0, 2000) });
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
      const summary = timedOut
        ? `委派超时（>${Math.round(timeoutMs / 1000)}s），任务仍在 VM 侧运行，可用 a2a.task.get 查询结果`
        : approval
          ? `任务挂起等待审批：${approval.message}`
          : lastMsg || `任务状态：${state}`;

      const contents: McpContent[] = [{ type: 'text', text: summary }];
      for (const a of artifacts) contents.push(...artifactToContents(a));

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
          progress,
          artifacts: artifacts.map(summarizeArtifact),
          ...(approval ? { approval } : {}),
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
        const message = extractText(task.status.message);
        const approval = extractApproval(task.status.message);
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
            ...(approval ? { approval } : {}),
          },
          content: [
            { type: 'text', text: `任务 ${task.id} 状态：${task.status.state}${message ? `\n${message}` : ''}` },
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
      '必须先向用户展示影响清单并取得确认，严禁代替用户放行（fail-closed）。',
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
    description: '取消 VM 侧正在执行的 A2A 任务（用户要求中止时使用）。',
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
        return {
          isError: false,
          structuredContent: { ok: true, traceId: ctx.traceId, taskId: task.id, state: task.status.state },
          content: [{ type: 'text', text: `任务 ${task.id} 已请求取消，状态：${task.status.state}` }],
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

  return [delegate, taskGet, approvalReply, cancel, health];
}

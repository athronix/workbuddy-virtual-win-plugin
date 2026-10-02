/**
 * R19c T05 · K-N1 —— **E 组形态守卫的变异检验（meta-test）**
 *
 * ## 为什么需要这个文件
 * `r19c-kn1-e-shape.test.js` 是**源码文本形态守卫**（沙箱起不了真服务，见该文件头）。
 * 这类护栏有 inherent 风险：**断言可能恒真** —— 删掉接线、改成硬编码、让observer 变必填，
 * 守卫却依然绿，那它就是装饰品而非护栏。本文件用**变异检验（mutation testing）**自证：
 * 对被守卫源码施加一组语义等价的破坏性变异，要求**每个守卫都必须因此变红**。
 *
 * ## 异常安全设计（关键）
 * 变异**全部在内存中的源码副本上施加**，本文件**不写任何磁盘文件**：
 *   - 因此不存在「写到一半崩溃留下脏工作树」的窗口，无需 try/finally 还原；
 *   -文件末尾以 SHA-256 前后比对自证「被守卫的源码文件字节未变」。
 * （早期版本曾考虑写临时文件再还原；改为纯内存后该风险类别从根上消失。）
 *
 * ## 与 E 组的关系（防漂移）
 * 本文件**独立复写**一遍守卫判据，**刻意不抽公共模块**。这不是重复，而是**自 policing**：
 * 若E 组的判据被改严/改宽而此处未同步，某个变异就会从「被捕获」变成「漏网」，
 * 本文件随即红。E 组与本文件的判据漂移会自己暴露，而不是静默失效。
 *
 * 覆盖的 E 组断言：E-1 dtid 解析与条件注入 / E-2 channel 双写点计数与禁硬编码 /
 * E-3 observer 可选性与依赖方向 / E-4 admin env 门控与只读性 / E-5 receipt 只读投影与脱敏。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/* ============================ 被守卫源码（只读） ============================ */

const PKG = join(import.meta.dirname, '..', '..', 'packages');
const A2A_DIR = join(PKG, 'a2a-framework', 'src');
const read = (p) => readFileSync(p, 'utf8');

const FILE_PATHS = {
  SERVER: join(PKG, 'vm-service', 'src', 'server.ts'),
  DET: join(PKG, 'adapter-agent-workbuddy', 'src', 'index.ts'),
  A2A: join(PKG, 'a2a-framework', 'src', 'server.ts'),
  MCP: join(PKG, 'mcp-framework', 'src', 'server.ts'),
  AUDIT_PURE: join(PKG, 'vm-service', 'src', 'delegation-audit.ts'),
  A2A_PKG: join(PKG, 'a2a-framework', 'package.json'),
};

/** 基线摘要：用于末尾自证「源码字节未变」 */
const BASELINE_HASH = Object.fromEntries(
  Object.entries(FILE_PATHS).map(([k, p]) => [k, createHash('sha256').update(readFileSync(p)).digest('hex')]),
);

/** 载入一份**可安全改写**的源码快照（深拷贝语义：新对象/新数组，字符串为原始串） */
function loadSources() {
  return {
    SERVER: read(FILE_PATHS.SERVER),
    DET: read(FILE_PATHS.DET),
    A2A: read(FILE_PATHS.A2A),
    MCP: read(FILE_PATHS.MCP),
    AUDIT_PURE: read(FILE_PATHS.AUDIT_PURE),
    A2A_PKG: JSON.parse(read(FILE_PATHS.A2A_PKG)),
    A2A_ALL: readdirSync(A2A_DIR)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => ({ f, src: read(join(A2A_DIR, f)) })),
  };
}

/**
 * 改写 `server.ts` 的**全部**镜像。
 *
 * 必须走这个辅助函数：`e3_no_audit_symbols` / `e3_no_adapter` 读的是 `A2A_ALL` 数组，
 * 只改 `s.A2A` 不会影响数组内容 → 变异「打空」，守卫自然仍绿（假通过）。
 * 教训：同一份源码在本文件里有**两个镜像**，任何单侧改写都是自欺。
 */
function setA2AServer(s, newSrc) {
  s.A2A = newSrc;
  const hit = s.A2A_ALL.find((e) => e.f === 'server.ts');
  if (!hit) throw new Error('A2A_ALL 缺少 server.ts 镜像');
  hit.src = newSrc;
}

/* ============================ 守卫判据（与 E 组同口径的独立复写） ============================ */

function slice(src, startMark, endMark) {
  const i = src.indexOf(startMark);
  if (i < 0) return '';
  const j = src.indexOf(endMark, i + startMark.length);
  if (j < 0) return '';
  return src.slice(i, j);
}

const MCP_ROUTE = (s) =>
  slice(s.SERVER, "if (path === '/mcp' && req.method === 'POST')", "if (path === '/audit/receipt'");
const RCP = (s) =>
  slice(
    s.SERVER,
    "if (path === '/audit/receipt' && req.method === 'GET')",
    "if (path === '/a2a' && req.method === 'POST')",
  );
// 终点用**兜底** 404（8 空格缩进），而非路由内 env 门控的 404（12 空格）——后者会立刻命中并切空业务段
const ADMIN = (s) =>
  slice(
    s.SERVER,
    "if (path === '/admin/llm-session/reset' && req.method === 'POST')",
    "\n        sendJson(res, 404, { error: 'not found', path });",
  );

/** 全部守卫：返回 true = 该守卫在给定源码上「通过」 */
const GUARDS = {
  /** E-1：/mcp 解析 dtid + 条件注入 reqCtx */
  e1_dtid: (s) => /url\.searchParams\.get\('dtid'\)/.test(MCP_ROUTE(s)),
  e1_conditional: (s) => /dtid \? \{ delegationId: dtid \} : undefined/.test(MCP_ROUTE(s)),
  /** E-1：ToolContext/McpRequestContext 各自可选（两处声明分别钉死） */
  e1_optional_ctx: (s) => {
    const decls = s.MCP.match(/readonly delegationId\??: string;/g) ?? [];
    return (
      decls.length === 2 &&
      decls.every((d) => /\?: string;$/.test(d)) &&
      /async handleRequest\(body: unknown, reqCtx\?: McpRequestContext\)/.test(s.MCP)
    );
  },
  /** E-1：callTool 仅在非空时补 delegationId 键 */
  e1_calltool_conditional: (s) =>
    /reqCtx\?\.delegationId\s*\?\s*\{\s*traceId,\s*delegationId:\s*reqCtx\.delegationId\s*\}\s*:\s*\{\s*traceId\s*\}/.test(
      s.MCP,
    ),
  /** E-2：成功/失败两处 channel 真值化，且双写点数恰为 2 */
  e2_two_write_points: (s) => (s.DET.match(/channel:\s*req\.channel\s*\?\?\s*'mcp'/g) ?? []).length === 2,
  /** E-2：全文件无硬编码 channel: 'mcp' */
  e2_no_hardcode: (s) => (s.DET.match(/channel:\s*'mcp'/g) ?? []).length === 0,
  /** E-2：inner-call ext 三元组恰 2 处 */
  e2_inner_ext: (s) =>
    (s.DET.match(/ext:\s*\{\s*kind:\s*'inner-call' as const,\s*delegationId:\s*req\.delegationId,/g) ?? []).length === 2,
  /** E-3：observer 两处声明「各自」可选（任一处变必填即红） */
  e3_optional: (s) => {
    const decls = s.A2A.match(/^.*delegationObserver\??: DelegationObserver;.*$/gm) ?? [];
    return decls.length === 2 && decls.every((d) => /\?:\s*DelegationObserver;/.test(d));
  },
  /** E-3：回调全走可选链（`?.`） */
  e3_optional_chain: (s) =>
    !/this\.delegationObserver\.onGoal/.test(s.A2A) &&
    (s.A2A.match(/this\.delegationObserver\?\.onGoalAccepted\(/g) ?? []).length === 1 &&
    (s.A2A.match(/this\.delegationObserver\?\.onGoalTerminal\(/g) ?? []).length >= 3,
  /** E-3：observer 回调异常只 warn（observe 护栏） */
  e3_observe_guard: (s) =>
    /private observe\(fn: \(\) => void\): void \{/.test(s.A2A) &&
    /this\.observe\(\(\) => this\.delegationObserver\?\.onGoalAccepted/.test(s.A2A),
  /** E-3 (a)：框架零审计写入侧符号（D-4 口径：只拦写入侧，含 buildDelegationAuditEntry/appendAudit） */
  e3_no_audit_symbols: (s) =>
    s.A2A_ALL.every(
      ({ src }) => !/\baudit\.append\(|buildDelegationAuditEntry\(|appendAudit\(|HashChainAuditSink/.test(src),
    ),
  /** E-3 (b)：框架禁依赖 adapter（含依赖表） */
  e3_no_adapter: (s) =>
    s.A2A_ALL.every(({ src }) => (src.match(/from\s+'@winvm\/adapter[^']*'/g) ?? []).length === 0) &&
    s.A2A_PKG.dependencies['@winvm/adapter-agent-workbuddy-llm'] === undefined &&
    s.A2A_PKG.dependencies['@winvm/adapter-agent-workbuddy'] === undefined,
  /** E-3 (c)：语义归server.ts 的 observer */
  e3_semantics_in_server: (s) =>
    /const delegationObserver: DelegationObserver = \{/.test(s.SERVER) &&
    /onGoalAccepted\(goal: GoalRequest\): void \{/.test(s.SERVER) &&
    /onGoalTerminal\(taskId: string, goal: GoalRequest, snap: DelegationTerminalSnapshot\): void \{/.test(s.SERVER),
  /** E-6 (D-5)：框架层 finalState 只有 completed/failed 二分 */
  d5_final_state_binary: (s) =>
    /const finalState: A2A\.TaskState = result\.ok \? 'completed' : 'failed';/.test(s.A2A) &&
    /onGoalTerminal\(id, goalWithTask, \{\s*state: result\.ok \? 'completed' : 'failed',/.test(s.A2A) &&
    !/result\.ok \? 'completed' : 'rejected'/.test(s.A2A),
  /** E-6 (D-5)：快照类型结构上无法表达 rejected（三值钉死） */
  d5_snapshot_type: (s) => /readonly state: 'completed' \| 'failed' \| 'input-required';/.test(s.A2A),
  /** E-6 (D-5)：rejected 仅由宿主审批拒绝路径置位（单点） */
  d5_rejected_single_site: (s) =>
    (s.A2A.match(/updateStatus\(\s*taskId,\s*'rejected'\s*\)/g) ?? []).length === 1,
  /** E-6 (D-5)：observer 据 TaskStore 把 failed 回改为 rejected */
  d5_observer_rewrite: (s) =>
    /snap\.state === 'failed' && storedState === 'rejected' \? 'rejected' : snap\.state/.test(s.SERVER) &&
    /const storedState = taskStore\.tryGet\(taskId\)\?\.task\.status\.state;/.test(s.SERVER),
  /** E-6 (D-5)：terminalState 以变量实参透传（不得写死） */
  d5_terminal_state_passthrough: (s) =>
    /\n\s*terminalState,\n/.test(s.SERVER) && !/terminalState:\s*'failed',/.test(s.SERVER),
  /** E-4：env 门控默认关 → 404 */
  e4_env_gate: (s) => /process\.env\['WINVM_ADMIN_ENDPOINT'\] !== '1'/.test(ADMIN(s)),
  /** E-4：门控早于任何 provider 调用（关态零副作用） */
  e4_gate_first: (s) => {
    const a = ADMIN(s);
    const g = a.indexOf("process.env['WINVM_ADMIN_ENDPOINT']");
    const r = a.indexOf('provider.llmSessionReset');
    return g !== -1 && r !== -1 && g < r;
  },
  /** E-4：faultInjection 显式 opt-in，且不带参数即清除注入 */
  e4_fault_optin: (s) =>
    /const faultInjection = url\.searchParams\.get\('faultInjection'\) === '1';/.test(ADMIN(s)) &&
    /faultInjection\s*\?\s*provider\.llmSessionInjectFault\?\.\(true\)\s*\?\?\s*false\s*:\s*provider\.llmSessionInjectFault\?\.\(false\)\s*\?\?\s*false/.test(
      ADMIN(s),
    ),
  /** E-4：SPI 缺席 → 503 如实报不可用 */
  e4_spi_503: (s) =>
    /if \(!provider \|\| provider\.llmSessionReset === undefined\) \{[\s\S]{0,200}?sendJson\(res, 503,/.test(ADMIN(s)),
  /** E-4：响应含 before/after 双快照 */
  e4_snapshots: (s) => {
    const a = ADMIN(s);
    return (
      /const before = provider\.llmSessionHealth\?\.\(\);/.test(a) &&
      /const after = provider\.llmSessionReset\(\);/.test(a) &&
      /before: before \?\? null,/.test(a) &&
      /after: after \?\? null,/.test(a)
    );
  },
  /** E-4：运维面不入哈希链（裸 `audit.append` 也须拦住） */
  e4_no_audit_write: (s) => !/\baudit\.append\(/.test(ADMIN(s)),
  /** E-4：env 读取全文件单点（门控不散落） */
  e4_env_single_read: (s) => (s.SERVER.match(/process\.env\[['"]WINVM_ADMIN_ENDPOINT['"]\]/g) ?? []).length === 1,
  /** E-5：唯一查询键走 sink.query，且只读端点不写链 */
  e5_query_only: (s) => /await audit\.query\(\{ traceId \}\)/.test(RCP(s)) && !/\baudit\.append\(/.test(RCP(s)),
  /** E-5：缺参 400 / 命中 200 /禁 404（§9-F-3 非 4xx） */
  e5_status_codes: (s) => {
    const r = RCP(s);
    return /sendJson\(res, 400, \{ error: 'missing traceId' \}\)/.test(r) &&
      /sendJson\(res, 200, buildReceiptResponse\(/.test(r) &&
      !/sendJson\(res, 404/.test(r);
  },
  /** E-5：组装交纯逻辑件，server.ts 零重复实现 */
  e5_single_source: (s) =>
    /buildReceiptResponse\(\{/.test(RCP(s)) &&
    !/function buildReceiptResponse\(/.test(s.SERVER) &&
    !/function buildDelegationAuditEntry\(/.test(s.SERVER) &&
    !/function clipReceipt\(/.test(s.SERVER),
  /** E-5：出参脱敏口径由 core.redact 提供 */
  e5_redact: (s) =>
    /import \{ redact, type AppendAuditInput \} from '@winvm\/core';/.test(s.AUDIT_PURE) &&
    /export function clipReceipt\(data: unknown\): string \{[\s\S]{0,200}?redact\(data\)/.test(s.AUDIT_PURE),
  /** E-5：环形回执有界（≤200，末尾锚避免 20000 前缀命中） */
  e5_bounded_cache: (s) => /export const MAX_RECEIPT_ENTRIES = 200;/.test(s.AUDIT_PURE),
  /** E-5：全量展开限量（杜绝无上限扫描） */
  e5_expand_limit: (s) => /audit\.query\(\{ limit: 5000 \}\)/.test(RCP(s)),
};

/* ============================ 变异集 ============================ */

const MUTATIONS = [
  {
    name: 'E-1 /mcp 路由删除 dtid 解析',
    guard: 'e1_dtid',
    mutate: (s) => {
      s.SERVER = s.SERVER.replace(
        "const dtid = url.searchParams.get('dtid') ?? undefined;",
        'const dtid = undefined;',
      );
    },
  },
  {
    name: 'E-1 dtid 改为无条件注入 delegationId（旧调用方被污染）',
    guard: 'e1_conditional',
    mutate: (s) => {
      s.SERVER = s.SERVER.replace('dtid ? { delegationId: dtid } : undefined', '{ delegationId: dtid }');
    },
  },
  {
    name: 'E-1 ToolContext.delegationId 变必填（破坏纯附加）',
    guard: 'e1_optional_ctx',
    mutate: (s) => {
      s.MCP = s.MCP.replace('readonly delegationId?: string;', 'readonly delegationId: string;');
    },
  },
  {
    name: 'E-1 callTool 无条件写 delegationId（含 undefined）',
    guard: 'e1_calltool_conditional',
    mutate: (s) => {
      s.MCP = s.MCP.replace(
        "reqCtx?.delegationId ? { traceId, delegationId: reqCtx.delegationId } : { traceId }",
        '{ traceId, delegationId: reqCtx?.delegationId }',
      );
    },
  },
  {
    name: 'E-2 删掉一处 channel 真值化（双写点降为 1）',
    guard: 'e2_two_write_points',
    mutate: (s) => {
      s.DET = s.DET.replace(/^\s*channel: req\.channel \?\? 'mcp',\n/m, '');
    },
  },
  {
    name: 'E-2 出现第三处硬编码 channel: "mcp"',
    guard: 'e2_two_write_points',
    mutate: (s) => {
      s.DET += "\n          channel: req.channel ?? 'mcp',\n";
    },
  },
  {
    name: 'E-2 channel 回退为硬编码字面量 "mcp"',
    guard: 'e2_no_hardcode',
    mutate: (s) => {
      s.DET = s.DET.replace("channel: req.channel ?? 'mcp'", "channel: 'mcp'");
    },
  },
  {
    name: 'E-2 inner-call ext 少一处（三元组不与双写点对齐）',
    guard: 'e2_inner_ext',
    mutate: (s) => {
      s.DET = s.DET.replace(
        "? { ext: { kind: 'inner-call' as const, delegationId: req.delegationId, channel: req.channel ?? 'a2a' } }",
        '',
      );
    },
  },
  {
    name: 'E-3 observer 构造项改为必填（非可选）',
    guard: 'e3_optional',
    mutate: (s) => {
      setA2AServer(s, s.A2A.replace(
        'readonly delegationObserver?: DelegationObserver;',
        'readonly delegationObserver: DelegationObserver;',
      ));
    },
  },
  {
    name: 'E-3 observer 类成员改为必填（被另一处可选掩盖）',
    guard: 'e3_optional',
    mutate: (s) => {
      setA2AServer(s, s.A2A.replace(
        'private readonly delegationObserver?: DelegationObserver;',
        'private readonly delegationObserver: DelegationObserver;',
      ));
    },
  },
  {
    name: 'E-3 回调去掉可选链（observer 缺席即崩委派）',
    guard: 'e3_optional_chain',
    mutate: (s) => {
      setA2AServer(s, s.A2A.replace(/this\.delegationObserver\?\./g, 'this.delegationObserver.'));
    },
  },
  {
    name: 'E-3 observe 护栏被摘除（回调异常将影响委派）',
    guard: 'e3_observe_guard',
    mutate: (s) => {
      setA2AServer(
        s,
        s.A2A.replace(
          'this.observe(() => this.delegationObserver?.onGoalAccepted',
          'this.delegationObserver?.onGoalAccepted',
        ),
      );
    },
  },
  {
    name: 'E-3 框架直接调 ctx.audit.append（审计越层）',
    guard: 'e3_no_audit_symbols',
    mutate: (s) => {
      setA2AServer(s, s.A2A.replace(
        'const goalWithTask: GoalRequest = { ...goal, taskId: id };',
        'const goalWithTask: GoalRequest = { ...goal, taskId: id };\n    void ctx.audit.append({});',
      ));
    },
  },
  {
    name: 'E-3 框架以裸变量名调audit.append（考验 \\b 边界）',
    guard: 'e3_no_audit_symbols',
    mutate: (s) => {
      setA2AServer(s, s.A2A.replace(
        'const goalWithTask: GoalRequest = { ...goal, taskId: id };',
        'const goalWithTask: GoalRequest = { ...goal, taskId: id };\n    void audit.append({});',
      ));
    },
  },
  {
    name: 'E-3 框架 import adapter（L1b 反向依赖 L2）',
    guard: 'e3_no_adapter',
    mutate: (s) => {
      setA2AServer(s, s.A2A.replace(
        "from '@winvm/contracts';",
        "from '@winvm/contracts';\nimport { x } from '@winvm/adapter-agent-workbuddy-llm';",
      ));
    },
  },
  {
    name: 'E-3 依赖表新增 adapter（源码未 import 但清单已破）',
    guard: 'e3_no_adapter',
    mutate: (s) => {
      s.A2A_PKG.dependencies['@winvm/adapter-agent-workbuddy-llm'] = '0.1.0';
    },
  },
  {
    name: 'E-3 框架直接调 buildDelegationAuditEntry（审计写入越层 · D-4 符号集）',
    guard: 'e3_no_audit_symbols',
    mutate: (s) => {
      setA2AServer(
        s,
        s.A2A.replace(
          'const goalWithTask: GoalRequest = { ...goal, taskId: id };',
          "const goalWithTask: GoalRequest = { ...goal, taskId: id };\n    void buildDelegationAuditEntry('complete', {});",
        ),
      );
    },
  },
  {
    name: 'E-3 框架 import HashChainAuditSink（审计写入件入框架）',
    guard: 'e3_no_audit_symbols',
    mutate: (s) => {
      setA2AServer(
        s,
        s.A2A.replace(
          "import { NullLogger } from '@winvm/core';",
          "import { NullLogger, HashChainAuditSink } from '@winvm/core';",
        ),
      );
    },
  },
  {
    name: 'E-6 框架把 ok:false 收口成 rejected（跨路径泛化终态 · D-5）',
    guard: 'd5_final_state_binary',
    mutate: (s) => {
      setA2AServer(
        s,
        s.A2A.replace(
          "const finalState: A2A.TaskState = result.ok ? 'completed' : 'failed';",
          "const finalState: A2A.TaskState = result.ok ? 'completed' : 'rejected';",
        ),
      );
    },
  },
  {
    name: 'E-6 快照类型被放宽为含 rejected（结构上可表达第三终态）',
    guard: 'd5_snapshot_type',
    mutate: (s) => {
      setA2AServer(
        s,
        s.A2A.replace(
          "readonly state: 'completed' | 'failed' | 'input-required';",
          "readonly state: 'completed' | 'failed' | 'input-required' | 'rejected';",
        ),
      );
    },
  },
  {
    name: 'E-6 rejected 置位点增至第二处（终态语义不再唯一归属宿主拒绝）',
    guard: 'd5_rejected_single_site',
    mutate: (s) => {
      setA2AServer(
        s,
        s.A2A.replace(
          "        // 审批通过：任务由挂起的 runner 自行继续（state 回到 working）\n        this.tasks.updateStatus(taskId, 'working');",
          "        if (finalState === 'failed') this.tasks.updateStatus(taskId, 'rejected');\n        // 审批通过：任务由挂起的 runner 自行继续（state 回到 working）\n        this.tasks.updateStatus(taskId, 'working');",
        ),
      );
    },
  },
  {
    name: 'E-6 observer 的 failed→rejected 回改被摘（宿主拒绝语义无处透出）',
    guard: 'd5_observer_rewrite',
    mutate: (s) => {
      s.SERVER = s.SERVER.replace(
        "const terminalState =\n        snap.state === 'failed' && storedState === 'rejected' ? 'rejected' : snap.state;",
        'const terminalState = snap.state;',
      );
    },
  },
  {
    name: 'E-6 terminalState 被写死为 failed（终态不可按路径区分）',
    guard: 'd5_terminal_state_passthrough',
    mutate: (s) => {
      s.SERVER = s.SERVER.replace('            terminalState,', "            terminalState: 'failed',");
    },
  },
  {
    name: 'E-3 壳双态语义被挪出 server.ts（observer 实现丢失）',
    guard: 'e3_semantics_in_server',
    mutate: (s) => {
      s.SERVER = s.SERVER.replace(
        'const delegationObserver: DelegationObserver = {',
        'const notAnObserver: DelegationObserver = {',
      );
    },
  },
  {
    name: 'E-4 摘掉 WINVM_ADMIN_ENDPOINT 门控（默认开）',
    guard: 'e4_env_gate',
    mutate: (s) => {
      s.SERVER = s.SERVER.replace("if (process.env['WINVM_ADMIN_ENDPOINT'] !== '1') {", 'if (false) {');
    },
  },
  {
    name: 'E-4 门控被挪到 provider 调用之后（关态已有副作用）',
    guard: 'e4_gate_first',
    mutate: (s) => {
      const guardBlk = "          if (process.env['WINVM_ADMIN_ENDPOINT'] !== '1') {\n            sendJson(res, 404, { error: 'not found', path });\n            return;\n          }\n";
      s.SERVER = s.SERVER.replace(guardBlk, '');
      s.SERVER = s.SERVER.replace(
        'const before = provider.llmSessionHealth?.();',
        "const before = provider.llmSessionHealth?.();\n" + guardBlk,
      );
    },
  },
  {
    name: 'E-4 faultInjection 改为默认真（无 opt-in 即注入）',
    guard: 'e4_fault_optin',
    mutate: (s) => {
      s.SERVER = s.SERVER.replace(
        "const faultInjection = url.searchParams.get('faultInjection') === '1';",
        'const faultInjection = true;',
      );
    },
  },
  {
    name: 'E-4 SPI 缺席改回 200 假成功',
    guard: 'e4_spi_503',
    mutate: (s) => {
      s.SERVER = s.SERVER.replace('sendJson(res, 503, { ok: false', 'sendJson(res, 200, { ok: true');
    },
  },
  {
    name: 'E-4 响应丢掉 after 快照（运维无法核对状态迁移）',
    guard: 'e4_snapshots',
    mutate: (s) => {
      s.SERVER = s.SERVER.replace('after: after ?? null,', '');
    },
  },
  {
    name: 'E-4 管理端点把运维动作写入审计链（裸 audit.append）',
    guard: 'e4_no_audit_write',
    mutate: (s) => {
      s.SERVER = s.SERVER.replace(
        "logger.warn('管理端点：LLM 常驻会话复位'",
        "await audit.append({ capabilityId: 'admin.reset' })",
      );
    },
  },
  {
    name: 'E-4 env 门控散落成第二处读取（多分支易不一致）',
    guard: 'e4_env_single_read',
    mutate: (s) => {
      s.SERVER = s.SERVER.replace(
        "const faultInjection = url.searchParams.get('faultInjection') === '1';",
        "const faultInjection = process.env['WINVM_ADMIN_ENDPOINT'] === '1';",
      );
    },
  },
  {
    name: 'E-5 回执端点绕过 sink.query 直接读文件',
    guard: 'e5_query_only',
    mutate: (s) => {
      s.SERVER = s.SERVER.replace(
        'const records = await audit.query({ traceId });',
        "const records = JSON.parse(readFileSync(chainPath, 'utf8'));",
      );
    },
  },
  {
    name: 'E-5 回执端点反向写链（只读性被破坏）',
    guard: 'e5_query_only',
    mutate: (s) => {
      s.SERVER = s.SERVER.replace(
        'const records = await audit.query({ traceId });',
        "await audit.append({ capabilityId: 'receipt.probe' });\n          const records = await audit.query({ traceId });",
      );
    },
  },
  {
    name: 'E-5 未命中改 404（违反 §9-F-3 非 4xx）',
    guard: 'e5_status_codes',
    mutate: (s) => {
      s.SERVER = s.SERVER.replace('sendJson(res, 200, buildReceiptResponse({', 'sendJson(res, 404, buildReceiptResponse({');
    },
  },
  {
    name: 'E-5 缺 traceId 的 400 被吞（静默返回空集）',
    guard: 'e5_status_codes',
    mutate: (s) => {
      s.SERVER = s.SERVER.replace("sendJson(res, 400, { error: 'missing traceId' });", 'return;');
    },
  },
  {
    name: 'E-5 server.ts 内联复制第二份 buildReceiptResponse（单一来源被破）',
    guard: 'e5_single_source',
    mutate: (s) => {
      s.SERVER += '\nfunction buildReceiptResponse(args) { return { records: [] }; }\n';
    },
  },
  {
    name: 'E-5 clipReceipt 脱敏被摘（回执出参不再 redact）',
    guard: 'e5_redact',
    mutate: (s) => {
      s.AUDIT_PURE = s.AUDIT_PURE.replace(
        'const json = JSON.stringify(redact(data) ?? null);',
        'const json = JSON.stringify(data ?? null);',
      );
    },
  },
  {
    name: 'E-5 环形回执容量上限被放大（无界常驻）',
    guard: 'e5_bounded_cache',
    mutate: (s) => {
      s.AUDIT_PURE = s.AUDIT_PURE.replace('export const MAX_RECEIPT_ENTRIES = 200;', 'export const MAX_RECEIPT_ENTRIES = 20000;');
    },
  },
  {
    name: 'E-5 全量展开去掉 5000 上限（无界扫描）',
    guard: 'e5_expand_limit',
    mutate: (s) => {
      s.SERVER = s.SERVER.replace('await audit.query({ limit: 5000 })', 'await audit.query({})');
    },
  },
];

/* ============================ 检验 ============================ */

describe('K-N1 E-META 变异检验：形态守卫不得恒真', () => {
  test('基线源码上全部守卫均为绿（否则是源码/守卫口径问题，不是变异问题）', () => {
    const s = loadSources();
    const reds = Object.entries(GUARDS)
      .filter(([, g]) => !g(s))
      .map(([k]) => k);
    assert.deepEqual(reds, [], `以下守卫在未变异的基线上就不通过：${JSON.stringify(reds)}`);
  });

  for (const m of MUTATIONS) {
    test(`${m.guard} 能捕获：${m.name}`, () => {
      const guard = GUARDS[m.guard];
      assert.equal(typeof guard, 'function', `未知守卫：${m.guard}`);
      const s = loadSources();
      assert.equal(guard(s), true, `前置条件失败：守卫 ${m.guard} 在基线上就应通过`);
      m.mutate(s);
      assert.equal(
        guard(s),
        false,
        `漏网：守卫 ${m.guard} 未能捕获变异「${m.name}」—— 该断言已恒真或过宽，需收紧`,
      );
    });
  }

  test(`变异集规模符合预期（当前 ${MUTATIONS.length} 个，至少 15 个）`, () => {
    assert.ok(MUTATIONS.length >= 15, '变异集过小，守卫自证力度不足');
    const guards = new Set(MUTATIONS.map((m) => m.guard));
    const uncovered = Object.keys(GUARDS).filter((g) => !guards.has(g));
    assert.deepEqual(uncovered, [], `以下守卫没有任何变异覆盖，等于未自证：${JSON.stringify(uncovered)}`);
  });

  test('每个变异都真实改动了快照（防止「变异打空 → 假通过」）', () => {
    const silent = [];
    for (const m of MUTATIONS) {
      const before = JSON.stringify(loadSources());
      const s = loadSources();
      m.mutate(s);
      if (JSON.stringify(s) === before) silent.push(m.name);
    }
    assert.deepEqual(silent, [], `以下变异实际未改动任何内容（变异脚本失效）：${JSON.stringify(silent)}`);
  });
});

describe('K-N1 E-META 异常安全自检：本文件不得写磁盘', () => {
  test('被守卫的 6 个源码文件字节未被本测试改动（变异仅存在于内存副本）', () => {
    const after = Object.fromEntries(
      Object.entries(FILE_PATHS).map(([k, p]) => [
        k,
        createHash('sha256').update(readFileSync(p)).digest('hex'),
      ]),
    );
    const dirty = Object.keys(FILE_PATHS).filter((k) => BASELINE_HASH[k] !== after[k]);
    assert.deepEqual(dirty, [], `以下文件被改动（本文件应零磁盘写）：${JSON.stringify(dirty)}`);
  });

  test('源码文本中不含写盘 API（fs 写接口未在本文件出现）', async () => {
    const self = read(join(import.meta.dirname, 'r19c-kn1-e-mutation.test.js'));
    for (const api of ['writeFileSync', 'appendFileSync', 'copyFileSync', 'renameSync', 'unlinkSync', 'rmSync']) {
      assert.equal(
        self.includes(`${api}(`) || self.includes(`${api} (`),
        false,
        `本文件不应出现写盘 API ${api}（异常安全要求：零磁盘写，无需 try/finally 还原）`,
      );
    }
    // 读接口允许（基线摘要 + 自检读取必需）
    assert.ok(self.includes('readFileSync('), '读接口是允许的');
  });
});

/* ============================ 护栏资产自身的可发现性 ============================ */

/**
 * 防「**静默跳过**」类假通过（与上面的「变异打空」同源一类）。
 *
 * 教训来源（本轮两次独立撞上，其中一次不是我犯的）：
 *  1. 本文件初版有个变异因锚点文本不符而**打空** —— 源码未变 → 守卫仍绿 → 假通过；
 *  2. 架构侧复核时误用文件名 `r19b-s1.test.js`（真实为 `r19b-s1-registry-forms.test.js`），
 *     `node --test` **静默**只跑 8 个文件得 278 test（真实 313），**不报错、exit=0**。
 *
 * 本仓库 `test:unit` 的 glob 是 `tests/unit/*.test.js`，故任何被改名成 `.test.mjs` 的护栏
 * 文件都会**从 CI 里静默消失**（本目录现存 8 个 `.test.mjs` 即长期不被 test:unit 收录）。
 * 故把「交付集必须全部匹配该 glob」钉成断言：一旦改名/漏交立刻红，而非悄无声息。
 */
describe('K-N1 E-META 护栏资产可发现性（防 test:unit 静默跳过）', () => {
  const EXPECTED = [
    'r19c-kn1-a-pure.test.js',
    'r19c-kn1-b-bridge.test.js',
    'r19c-kn1-c-session.test.js',
    'r19c-kn1-d-provider.test.js',
    'r19c-kn1-e-shape.test.js',
    'r19c-kn1-e-mutation.test.js',
    'r19c-kn1-f-chain.test.js',
  ];
  const UNIT_DIR = import.meta.dirname;

  test('§9 A–F 六组 + 变异检验共 7 个文件全部存在于 tests/unit', () => {
    for (const f of EXPECTED) {
      assert.equal(existsSync(join(UNIT_DIR, f)), true, `交付集缺文件：${f}`);
    }
  });

  test('全部以 .test.js 结尾（.test.mjs 会被 test:unit glob 静默跳过）', () => {
    const wrongExt = EXPECTED.filter((f) => !f.endsWith('.test.js'));
    assert.deepEqual(wrongExt, [], `以下文件不匹配 *.test.js glob，会被静默跳过：${wrongExt.join(', ')}`);
  });

  test('与 glob 实际收录集合一致（现场复刻 glob 语义，非仅靠后缀推断）', () => {
    // 复刻 package.json `test:unit` 的 glob：只有 *.test.js 会被 node --test 收录。
    const globbed = readdirSync(UNIT_DIR).filter((f) => f.endsWith('.test.js'));
    const missing = EXPECTED.filter((f) => !globbed.includes(f));
    assert.deepEqual(missing, [], `下列文件不会被 CI 跑到：${missing.join(', ')}`);
  });

  test('本文件不得存在 .test.mjs 副本（否则本组断言永不执行 → 假绿）', () => {
    assert.equal(
      existsSync(join(UNIT_DIR, 'r19c-kn1-e-mutation.test.mjs')),
      false,
      '变异检验文件若有 .mjs 副本，会被 glob 跳过导致本组全部断言永不执行',
    );
  });

  test('未被 test:unit 收录的 .test.mjs 现状登记（既有形态，不判失败）', () => {
    // 本仓库既有 8 个 .test.mjs 长期不被 test:unit 收录 —— 登记事实供后续决策，
    // **不判失败**（属仓库既有形态、非 K-N1 引入；改 glob 超出本轮范围）。
    const skipped = readdirSync(UNIT_DIR).filter((f) => f.endsWith('.test.mjs'));
    assert.ok(Array.isArray(skipped), '应能枚举被跳过的 .mjs 清单');
  });
});
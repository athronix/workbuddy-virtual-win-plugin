/**
 * R19c T05 · K-N1 委派层审计真实性 —— **E 组：`vm-service` / 框架接线形态守卫**
 * （设计 `docs/design/kn1-delegation-audit-contract.md` §9-E）
 *
 * ## 为什么整组用源码文本断言
 * 本沙箱内`createService` 会 spawn ps-bridge 并触发 V8 原生 fatal
 * （`Check failed: 12 == (*__errno_location())`），**起不了真服务**做行为级集成测试。
 * 故沿用 `tests/unit/k5-replay.test.js` E 组的既定惯例：把「接线是否正确」的风险用形态
 * 守卫钉死 —— 一旦有人把 `/mcp` 的 dtid 解析删掉、把 provider 的 channel 双写点拆成三处、
 * 或让 `a2a-framework` 直接写审计，这里立刻红。K-N1 的**行为**语义由 A/B/C/D/F 五组
 * （纯函数 + 桥 + 常驻会话 + provider + 链兼容）逐条覆盖。
 *
 * ## 覆盖 §9-E 的 5 条
 *   E-1 `/mcp` 路由解析 `dtid` 并注入 `ToolContext`（→ `McpRequestContext` → `ToolContext.delegationId`）；
 *   E-2 provider append 两处均 `channel: req.channel ?? 'mcp'`，**双写点数恰为 2**（禁第三处硬编码）；
 *   E-3 `delegationObserver` 在 `a2a-framework` 为**可选** + 依赖方向守卫（框架零审计依赖、禁依赖 adapter）；
 *   E-4 管理端点路由体含 `WINVM_ADMIN_ENDPOINT` 检查文本（默认关 → 404）；
 *   E-5 `/audit/receipt` 响应体过滤走 `sink.query` 且带 `redact`。
 *
 * ## 依赖方向守卫口径（**设计 §11 D-4**；§9-E-3 原字面已废止）
 * §9-E-3 曾字面要求「框架不得出现 `@winvm/core` import」。**该字面已由 D-4 废止**：
 * `a2a-framework` 的 `@winvm/core` import（`server.ts:20 NullLogger`，`:96` 处消费；
 * 另 `client.ts:11 JsonRpcChannel`、`task-store.ts:13 resolveApprovalTtlMs`）是
 * **K-N1 之前既有基线**（已用 `git show 608d4e0:packages/a2a-framework/src/server.ts:20`
 * 独立核实），且 T02（`a90e54b`）对该包是 `server.ts +57/-0` **纯增量、零 import 增删**；
 * 该包 `index.ts:8` 铁律原文为「仅依赖 `@winvm/contracts` 与 `@winvm/core`，
 * **禁止依赖 adapter**」——本包**本就合法依赖 core**。按字面执行会对**未改动的正确代码**误报。
 * 故按 D-4 改为**两层机器可判定不变量**：
 *   (a) **框架零审计写入侧符号**（`audit.append` / `buildDelegationAuditEntry` /
 *       `appendAudit` / `HashChainAuditSink`）—— 这才是 §2.4「审计写入只在 vm-service 层」
 *       的可判定形式。**只读侧符号（如`AuditSink` 类型引用）与解释性注释不在此列**；
 *   (b) **框架禁依赖 adapter** —— grep 范围含 `src/**` **与 `package.json` 依赖表**。
 * 「observer 可选」半句保留，并按 D-4 加严为**恰 2 处声明 + 每处各自带 `?`**。
 *
 * 已知待整改（**非本组断言范围**，登记自 D-4）：`a2a-framework/src/server.ts:58` 的 T02 注释
 * 沿用了被废止字面（「框架层不得 import `@winvm/core`」），与 `index.ts:8` 铁律自相矛盾。
 * 本组 (a) 守卫按「只读侧/注释不在此列」处理，故**不会**误报该注释。
 *
 * ## 委派终态口径（**设计 §11 D-5**）
 * `ok:false → failed` 的收口在**框架层** `runGoalWithLifecycle`（`finalState` 二分），
 * 且 `DelegationTerminalSnapshot.state` 类型钉死为 `'completed'|'failed'|'input-required'`
 * ——**结构上无法表达 `rejected`**。故 **disabled 拒绝终态是 `failed`**，不是 `rejected`
 * （设计 §4.1/§7 的「rejected」为设计期笔误，已就地加注）。
 * 但 `rejected` **非死语义**：宿主显式拒绝审批时框架 `updateStatus(taskId,'rejected')`
 * 置位，vm-service observer 据此把 `failed` 回改为 `rejected`。
 * ⇒ **断言须按路径区分终态，不得跨路径泛化**（见本文件 D-5 组断言）。
 *
 * 纪律：**只读源码文本**，不修改 packages 下的任何 src，不 spawn 进程、不起 HTTP。
 *
 * ## 配套变异检验
 * 本文件是形态守卫，天然有「恒真断言」风险。姊妹文件
 * **`tests/unit/r19c-kn1-e-mutation.test.js`** 对同一批源码施加破坏性变异，
 * 要求本文件的每个守卫都因此变红（自证不是装饰品）。**改动本文件任何断言后，
 * 请一并复跑该变异检验** —— 若守卫被改严/改宽而变异集未同步，姊妹文件会立即变红。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/* ============================ 被守卫源码 ============================ */

const PKG = join(import.meta.dirname, '..', '..', 'packages');
const read = (p) => readFileSync(p, 'utf8');

const SERVER = read(join(PKG, 'vm-service', 'src', 'server.ts'));
const A2A = read(join(PKG, 'a2a-framework', 'src', 'server.ts'));
const A2A_ALL = readdirSync(join(PKG, 'a2a-framework', 'src'))
  .filter((f) => f.endsWith('.ts'))
  .map((f) => ({ f, src: read(join(PKG, 'a2a-framework', 'src', f)) }));
const DETERMINISTIC = read(join(PKG, 'adapter-agent-workbuddy', 'src', 'index.ts'));
const MCP = read(join(PKG, 'mcp-framework', 'src', 'server.ts'));
const AUDIT_PURE = read(join(PKG, 'vm-service', 'src', 'delegation-audit.ts'));

/** server.ts 路由处理体的切片（把断言锚定在 HTTP 路由内，避免注释/其它段落误命中） */
function sliceRoute(src, startMark, endMark) {
  const i = src.indexOf(startMark);
  assert.notEqual(i, -1, `server.ts 找不到路由起点：${startMark}`);
  const j = src.indexOf(endMark, i + startMark.length);
  assert.notEqual(j, -1, `server.ts 找不到路由终点：${endMark}`);
  return src.slice(i, j);
}

const MCP_ROUTE = sliceRoute(SERVER, "if (path === '/mcp' && req.method === 'POST')", "if (path === '/audit/receipt'");
const RECEIPT_ROUTE = sliceRoute(
  SERVER,
  "if (path === '/audit/receipt' && req.method === 'GET')",
  "if (path === '/a2a' && req.method === 'POST')",
);
const ADMIN_ROUTE = sliceRoute(
  SERVER,
  "if (path === '/admin/llm-session/reset' && req.method === 'POST')",
  // 终点用兜底 404（8 空格缩进的那条），而非路由内env 门控的 404（12 空格）——
  // 后者会在切片起点后立刻命中，把整段业务逻辑切掉。
  "\n        sendJson(res, 404, { error: 'not found', path });",
);

/* ============================ E-1 /mcp 路由解析 dtid ============================ */

describe('K-N1 E-1 /mcp 路由：dtid 解析并注入委派归因（通道 2）', () => {
  test('/mcp 路由从 query 解析 dtid 并作为第二个入参传给 handleRequest', () => {
    assert.match(
      MCP_ROUTE,
      /url\.searchParams\.get\('dtid'\)/,
      '必须从 /mcp 的 query 解析 dtid（buildMcpConfig 拼入的委派 traceId）',
    );
    assert.match(
      MCP_ROUTE,
      /mcp\.handleRequest\(parsed,\s*dtid\s*\?\s*\{\s*delegationId:\s*dtid\s*\}\s*:\s*undefined\)/,
      'reqCtx 必须条件展开：无 dtid 传 undefined（旧调用方逐字节不变）',
    );
  });

  test('dtid 缺席 → 不注入 delegationId 键（ToolContext 旧形态，零回归）', () => {
    assert.match(MCP_ROUTE, /dtid \? \{ delegationId: dtid \} : undefined/, '必须三态条件展开，不得塞空串');
    assert.doesNotMatch(MCP_ROUTE, /delegationId: dtid \?\?/, '不得用 ?? 把 undefined 折叠成空值');
  });

  test('ToolContext.delegationId / McpRequestContext 为可选（纯附加，旧调用零改动）', () => {
    assert.match(MCP, /export interface ToolContext \{/, 'ToolContext 必须仍是独立接口');
    // `readonly delegationId?: string;` 在 mcp-framework 中**出现两次**（ToolContext 与
    // McpRequestContext 各一）。只断言「存在一处可选」会被另一处仍可选掩盖 —— 故两处**分别**钉死，
    // 否则任一处被改成必填都抓不到（变异检验实测该漏网，见 r19c-kn1-e-mutation.test.js）。
    const decls = MCP.match(/readonly delegationId\??: string;/g) ?? [];
    assert.equal(decls.length, 2, `delegationId 应恰有 2 处声明（ToolContext + McpRequestContext），实得 ${decls.length}`);
    for (const d of decls) {
      assert.match(d, /\?: string;$/, `两处声明都必须可选（纯附加，旧调用零改动）：${d}`);
    }
    assert.match(MCP, /async handleRequest\(body: unknown, reqCtx\?: McpRequestContext\)/, 'handleRequest 第二参必须可选');
  });

  test('callTool 仅在 reqCtx 带非空 delegationId 时补键（不得无条件写 undefined）', () => {
    assert.match(
      MCP,
      /reqCtx\?\.delegationId\s*\?\s*\{\s*traceId,\s*delegationId:\s*reqCtx\.delegationId\s*\}\s*:\s*\{\s*traceId\s*\}/,
      'ToolContext 组装须条件展开 —— 无条件写 delegationId:undefined 会污染下游 channel 判定',
    );
  });
});

/* ============================ E-2 provider 双写点数恰为 2 ============================ */

describe('K-N1 E-2 provider审计双写点：channel 真值化且恰为两处', () => {
  const CHANNEL_STAMP = /channel:\s*req\.channel\s*\?\?\s*'mcp'/g;
  const INNER_EXT = /ext:\s*\{\s*kind:\s*'inner-call' as const,\s*delegationId:\s*req\.delegationId,\s*channel:\s*req\.channel\s*\?\?\s*'a2a'\s*\}/g;

  test('成功路径 append 落 channel: req.channel ?? "mcp"', () => {
    assert.match(
      DETERMINISTIC,
      /const audit = await ctx\.audit\.append\(\{[\s\S]{0,600}?channel: req\.channel \?\? 'mcp'/,
      '成功路径审计条目必须取真实 channel（委派回连记 a2a，纯宿主直调记 mcp）',
    );
  });

  test('失败路径 append（fail()）同样真值化 channel', () => {
    assert.match(
      DETERMINISTIC,
      /await ctx\.audit\.append\(\{[\s\S]{0,600}?channel: req\.channel \?\? 'mcp'/,
      '失败路径同样必须真值化（否则失败委派恒记 mcp，观测缺陷照旧）',
    );
  });

  test('双写点数**恰为 2**（禁止第三处硬编码 channel）', () => {
    const hits = DETERMINISTIC.match(CHANNEL_STAMP) ?? [];
    assert.equal(
      hits.length,
      2,
      `channel: req.channel ?? 'mcp' 应恰好出现在成功/失败两处，实得 ${hits.length} 处（多一处=行为漂移，少一处=漏真值化）`,
    );
  });

  test('全文件无 channel: "mcp" 形式的硬编码字面量（零回归语义不得回退）', () => {
    const hardcoded = DETERMINISTIC.match(/channel:\s*'mcp'/g) ?? [];
    assert.equal(hardcoded.length, 0, `不得出现硬编码 channel: 'mcp'（实得 ${hardcoded.length} 处）—— 内层委派回连会被误记为宿主直调`);
  });

  test('两处 inner-call ext 均带 kind + delegationId + channel 三元组', () => {
    const hits = DETERMINISTIC.match(INNER_EXT) ?? [];
    assert.equal(hits.length, 2, `ext inner-call 展开应恰为 2 处（与双写点一一对应），实得 ${hits.length}`);
    assert.match(DETERMINISTIC, /req\.delegationId\s*\?\s*\{ ext:/, 'ext 必须条件展开（无 delegationId 时不产 ext 键）');
  });
});

/* ============================ E-3 observer 可选 + 依赖方向 ============================ */

describe('K-N1 E-3 a2a-framework：observer 纯可选 + 依赖方向铁律不破', () => {
  test('delegationObserver 在构造项与成员上均为可选（缺席零行为变化）', () => {
    // 两处声明**分别**钉死：`A2AServerOptions.delegationObserver`（:86）与类成员（:120）。
    // 只断言「存在某处可选」会被另一处仍可选掩盖 —— 两处都必须各自带 `?`。
    const decls = A2A.match(/^.*delegationObserver\??: DelegationObserver;.*$/gm) ?? [];
    assert.equal(
      decls.length,
      2,
      `delegationObserver 应恰有 2 处声明（构造项+ 类成员），实得 ${decls.length}：${JSON.stringify(decls)}`,
    );
    for (const d of decls) {
      assert.match(
        d,
        /\?:\s*DelegationObserver;/,
        `observer 声明必须可选（缺席零行为变化）：${d.trim()}`,
      );
    }
    assert.match(A2A, /this\.delegationObserver = opts\.delegationObserver;/, '构造期直取（不做默认实现）');
  });

  test('两处回调点均以可选链调用（`?.` —— 框架不得因 observer 缺席崩委派）', () => {
    const accepted = A2A.match(/this\.delegationObserver\?\.onGoalAccepted\(/g) ?? [];
    const terminal = A2A.match(/this\.delegationObserver\?\.onGoalTerminal\(/g) ?? [];
    assert.equal(accepted.length, 1, '受理观测点应恰 1 处');
    assert.ok(
      terminal.length >= 3,
      `终态观测点应覆盖 completed/failed/input-required 三条路径（实得 ${terminal.length}）`,
    );
    assert.doesNotMatch(A2A, /this\.delegationObserver\.onGoal/, '回调必须走 ?. 可选链');
  });

  test('observer 回调异常只 warn，绝不影响委派生命周期（取证面与执行面分离）', () => {
    assert.match(A2A, /private observe\(fn: \(\) => void\): void \{/, '必须经统一 observe 护栏调用');
    assert.match(A2A, /catch \(e\) \{\s*this\.logger\.warn\('delegationObserver 回调异常（不影响委派）'/, '回调异常必须被吞并记 warn');
    assert.match(A2A, /this\.observe\(\(\) => this\.delegationObserver\?\.onGoalAccepted/, '受理点必须经护栏');
    assert.match(A2A, /this\.observe\(\(\) =>\s*\n?\s*this\.delegationObserver\?\.onGoalTerminal/, '终态点必须经护栏');
  });

  test('依赖方向 (a)：框架零审计写入侧符号（§2.4 审计写入只在 vm-service 层 · D-4）', () => {
    for (const { f, src } of A2A_ALL) {
      // D-4 口径：只拦**写入侧**符号。只读侧（`AuditSink` 类型引用等）与解释性注释不在此列——
      // 故 `a2a-framework/src/server.ts:58` 那段沿用废止字面的注释不会误报（已登记待整改）。
      assert.doesNotMatch(
        src,
        /\baudit\.append\(|buildDelegationAuditEntry\(|appendAudit\(|HashChainAuditSink/,
        `a2a-framework/${f} 不得出现审计写入侧符号 —— 壳双态条目由 vm-service 实现（D-4）`,
      );
      // 从 core 也不得 import 审计写入类型
      const imports = src.match(/^import[\s\S]{0,400}?from\s+'@winvm\/core';/gm) ?? [];
      assert.equal(
        imports.filter((s) => /HashChainAuditSink|buildDelegationAuditEntry|appendAudit/.test(s)).length,
        0,
        `a2a-framework/${f} 不得从 core import 审计写入件`,
      );
    }
  });

  test('依赖方向 (b)：框架禁依赖 adapter（包内铁律「仅 contracts 与 core」）', () => {
    for (const { f, src } of A2A_ALL) {
      const adapterImports = src.match(/from\s+'@winvm\/adapter[^']*'/g) ?? [];
      assert.equal(
        adapterImports.length,
        0,
        `a2a-framework/${f} 不得 import adapter：实得 ${JSON.stringify(adapterImports)}（L1b 框架不得反向依赖 L2 适配器）`,
      );
    }
    const pkg = JSON.parse(read(join(PKG, 'a2a-framework', 'package.json')));
    assert.equal(pkg.dependencies['@winvm/adapter-agent-workbuddy-llm'], undefined, '依赖表不得新增 adapter');
    assert.equal(pkg.dependencies['@winvm/adapter-agent-workbuddy'], undefined, '依赖表不得新增 adapter');
  });

  test('语义归属：壳双态条目由 server.ts 的 observer 实现（框架零审计语义）', () => {
    assert.match(SERVER, /const delegationObserver: DelegationObserver = \{/, 'server.ts 必须实现 observer');
    assert.match(SERVER, /onGoalAccepted\(goal: GoalRequest\): void \{/, 'server 侧实现受理观测');
    assert.match(SERVER, /onGoalTerminal\(taskId: string, goal: GoalRequest, snap: DelegationTerminalSnapshot\): void \{/, 'server 侧实现终态观测');
    assert.match(SERVER, /\n\s*delegationObserver,\n/, 'observer 注入 A2AServer 构造项');
    // 壳条目绝不自证活动：observer 落审计走**原始 sink**而非 wrapAuditSink 后的喂账本 sink
    assert.match(SERVER, /from '\.\/delegation-audit\.js';/, 'server 复用纯逻辑件（单一事实来源）');
  });
});

/* ============================ E-4 管理端点 env 门控（默认关） ============================ */

describe('K-N1 E-4 POST /admin/llm-session/reset：env 门控默认关', () => {
  test('路由体首行即 env 检查，未开门控 → 404（与未注册等价）', () => {
    assert.match(
      ADMIN_ROUTE,
      /if \(process\.env\['WINVM_ADMIN_ENDPOINT'\] !== '1'\) \{\s*sendJson\(res, 404, \{ error: 'not found', path \}\);/,
      'WINVM_ADMIN_ENDPOINT 未置1 时必须 404（默认关；不新增鉴权体系，服务仅 loopback）',
    );
  });

  test('门控在业务逻辑之前（关态下不触达 provider/副作用）', () => {
    const guardAt = ADMIN_ROUTE.indexOf("process.env['WINVM_ADMIN_ENDPOINT']");
    const resetAt = ADMIN_ROUTE.indexOf('provider.llmSessionReset');
    assert.ok(guardAt !== -1 && resetAt !== -1, '路由体须同时含门控与复位调用');
    assert.ok(guardAt < resetAt, 'env 门控必须早于任何 provider 调用（关态零副作用）');
  });

  test('faultInjection=1 才注入；不带参数即复位并清除注入（§6.2）', () => {
    assert.match(
      ADMIN_ROUTE,
      /const faultInjection = url\.searchParams\.get\('faultInjection'\) === '1';/,
      '故障注入必须显式 opt-in（?faultInjection=1）',
    );
    assert.match(
      ADMIN_ROUTE,
      /faultInjection\s*\?\s*provider\.llmSessionInjectFault\?\.\(true\)\s*\?\?\s*false\s*:\s*provider\.llmSessionInjectFault\?\.\(false\)\s*\?\?\s*false/,
      '不带参数须走清除注入分支（复位同时撤销注入）',
    );
  });

  test('provider 未实现 L1 SPI → 503 如实报不可用，绝不假成功', () => {
    assert.match(
      ADMIN_ROUTE,
      /if \(!provider \|\| provider\.llmSessionReset === undefined\) \{[\s\S]{0,200}?sendJson\(res, 503,/,
      'SPI 缺席须 503（如实报告），不得回 200 假装复位成功',
    );
  });

  test('响应含 before/after 双快照（运维可核对状态迁移）', () => {
    assert.match(ADMIN_ROUTE, /const before = provider\.llmSessionHealth\?\.\(\);/, '须先取复位前快照');
    assert.match(ADMIN_ROUTE, /const after = provider\.llmSessionReset\(\);/, '须取复位动作与复位后快照');
    assert.match(ADMIN_ROUTE, /before: before \?\? null,/, '响应须回 before');
    assert.match(ADMIN_ROUTE, /after: after \?\? null,/, '响应须回 after');
  });

  test('运维面不入哈希链：管理端点只走 logger.warn', () => {
    assert.match(ADMIN_ROUTE, /logger\.warn\('管理端点：LLM 常驻会话复位'/, '运维动作只记日志');
    // 审计 sink 在 server.ts 里是**裸局部变量** `audit`，故匹配不得强依赖 `ctx.` 前缀
    assert.doesNotMatch(ADMIN_ROUTE, /\baudit\.append\(/, '管理端点不得写审计链（运维面与证据面分离）');
  });

  test('全文件仅此一处读 WINVM_ADMIN_ENDPOINT（门控单点，不散落）', () => {
    const hits = SERVER.match(/WINVM_ADMIN_ENDPOINT/g) ?? [];
    assert.ok(hits.length >= 1, '须有 env 门控');
    const reads = SERVER.match(/process\.env\[['"]WINVM_ADMIN_ENDPOINT['"]\]/g) ?? [];
    assert.equal(reads.length, 1, `env 读取应单点（实得 ${reads.length} 处）—— 多处易出现门控不一致`);
  });
});

/* ============================ E-5 /audit/receipt 过滤与脱敏 ============================ */

describe('K-N1 E-5 GET /audit/receipt：只读投影走 sink.query 且出参脱敏', () => {
  test('路由以 traceId 为唯一查询键走 audit.query（只读投影，零链体积增长）', () => {
    assert.match(RECEIPT_ROUTE, /url\.searchParams\.get\('traceId'\) \?\? ''/, '须按 traceId 查询');
    assert.match(RECEIPT_ROUTE, /await audit\.query\(\{ traceId \}\)/, '过滤必须经 sink.query（不得自行遍历链或落盘）');
    assert.doesNotMatch(RECEIPT_ROUTE, /\baudit\.append\(/, '只读端点绝不写链（D-2：链体积零增长是硬约束）');
  });

  test('缺 traceId → 400（显式参数错误），命中与否一律 200（非 4xx）', () => {
    assert.match(RECEIPT_ROUTE, /if \(!traceId\) \{\s*sendJson\(res, 400, \{ error: 'missing traceId' \}\);/, '缺参400');
    assert.match(RECEIPT_ROUTE, /sendJson\(res, 200, buildReceiptResponse\(/, '命中路径 200');
    assert.doesNotMatch(
      RECEIPT_ROUTE,
      /sendJson\(res, 404/,
      '未命中不得 404（§9-F-3：未命中 → { records: [] } 200 非 4xx）',
    );
  });

  test('响应组装交纯逻辑件 buildReceiptResponse（server.ts 零重复实现）', () => {
    assert.match(SERVER, /\n\s*buildReceiptResponse,\n/, '须从 delegation-audit 导入');
    assert.match(RECEIPT_ROUTE, /buildReceiptResponse\(\{/, '路由体须调用纯逻辑件');
    assert.equal(
      new RegExp('function buildReceiptResponse\\(').test(SERVER),
      false,
      'server.ts 不得复制出第二份 buildReceiptResponse（单一事实来源）',
    );
    for (const fn of ['buildDelegationAuditEntry', 'wrapAuditSink', 'clipReceipt']) {
      assert.equal(
        new RegExp(`function ${fn}\\(`).test(SERVER),
        false,
        `server.ts 不得复制出第二份 ${fn}（纯逻辑单一来源）`,
      );
    }
  });

  test('出参脱敏：脱敏口径由纯逻辑件的 redact 提供（不在路由里另写一套）', () => {
    assert.match(AUDIT_PURE, /import \{ redact, type AppendAuditInput \} from '@winvm\/core';/, '纯逻辑件须复用 core.redact');
    assert.match(AUDIT_PURE, /export function clipReceipt\(data: unknown\): string \{[\s\S]{0,200}?redact\(data\)/, '回执出参必须经 redact');
    assert.doesNotMatch(RECEIPT_ROUTE, /JSON\.stringify\(/, '路由体不得自行序列化内层数据（绕过脱敏与截断口径）');
  });

  test('环形回执只存脱敏副本且容量有界（D-2：≤200 条、重启即失）', () => {
    assert.match(AUDIT_PURE, /export class ReceiptCache/, '回执缓存为有界环形');
    // 末尾锚 `;`：否则 `= 20000` 会**前缀命中** `= 200` 而让容量放大悄悄溜过
    // （变异检验实测该漏网，见 r19c-kn1-e-mutation.test.js）
    assert.match(AUDIT_PURE, /export const MAX_RECEIPT_ENTRIES = 200;/, '容量上限 200（设计 §5.2-B硬约束）');
    assert.match(SERVER, /const receiptCache = new ReceiptCache\(/, 'server 须实例化有界缓存');
  });

  test('全量展开有界（杜绝无上限扫描：链体量随运行增长）', () => {
    assert.match(RECEIPT_ROUTE, /audit\.query\(\{ limit: 5000 \}\)/, '展开读取必须限量');
    assert.match(
      RECEIPT_ROUTE,
      /records\.some\(\(r\) => r\.ext\?\.kind === 'delegation-complete'\)/,
      '仅命中壳 complete 条目时才付出全量代价',
    );
  });
});
/* ============================ E-6 委派终态口径（D-5） ============================ */

describe('K-N1 E-6 委派终态按路径区分（D-5：disabled 拒绝= failed，宿主拒绝= rejected）', () => {
  test('框架层finalState 只有 completed/failed 二分（无第三分支）', () => {
    assert.match(
      A2A,
      /const finalState: A2A\.TaskState = result\.ok \? 'completed' : 'failed';/,
      'ok:false 必须在框架层收口为 failed',
    );
    assert.match(
      A2A,
      /onGoalTerminal\(id, goalWithTask, \{\s*state: result\.ok \? 'completed' : 'failed',/,
      '终态回调同式二分 —— disabled 拒绝走此路径，故其终态是 failed 而非 rejected',
    );
  });

  test('DelegationTerminalSnapshot.state 类型结构上无法表达 rejected', () => {
    assert.match(
      A2A,
      /readonly state: 'completed' \| 'failed' \| 'input-required';/,
      '快照类型钉死三值，rejected 只能由 observer 回改产生',
    );
  });

  test('rejected 仅由宿主审批拒绝路径置位（框架 updateStatus 单点）', () => {
    const hits = A2A.match(/updateStatus\(\s*taskId,\s*'rejected'\s*\)/g) ?? [];
    assert.equal(hits.length, 1, `rejected 应仅在宿主审批拒绝应答处置位一次，实得 ${hits.length}`);
    assert.doesNotMatch(A2A, /result\.ok \? 'completed' : 'rejected'/, 'runGoal 收口不得产出 rejected');
  });

  test('observer 把宿主拒绝的 failed 回改为 rejected（D-5 保留 rejected 的落点）', () => {
    assert.match(
      SERVER,
      /snap\.state === 'failed' && storedState === 'rejected' \? 'rejected' : snap\.state/,
      'observer 须据 TaskStore 已置的 rejected 回改终态（否则该语义无处透出）',
    );
    assert.match(
      SERVER,
      /const storedState = taskStore\.tryGet\(taskId\)\?\.task\.status\.state;/,
      '回改依据须取自 TaskStore 实际状态，不得凭空判定',
    );
  });

  test('壳 complete 条目透出 observer 计算出的 terminalState（rejected 得以落链取证）', () => {
    // terminalState 必须以**变量**形式实参透传，不能就地写死终态 ——
    // 否则 D-5 保留的 rejected 语义将无处落进 ext.terminalState，取证侧看不到宿主拒绝。
    assert.match(SERVER, /\n\s*terminalState,\n/, '须以实参透传 terminalState');
    assert.doesNotMatch(
      SERVER,
      /terminalState:\s*'failed',/,
      '不得把终态写死为常量（须由 snap/storedState 推导）',
    );
    // errorCode 优先取领域 reason —— disabled 拒绝落 LLM_SESSION_DISABLED
    assert.match(
      SERVER,
      /result\?\.error\?\.reason\s*\?\?/,
      'errorCode 须优先取领域 reason（LLM_SESSION_DISABLED / NO_EXECUTION_RECEIPT）',
    );
  });
});

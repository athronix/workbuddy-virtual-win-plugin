/**
 * Phase 2 · P2-T6 单元测试 —— VM 内回连凭据分发通路（配置生成面 + 判序联动 + 探针 + 注入面）
 *
 * 覆盖设计 `docs/changes/phase2-arch-design.md` §2.2（F2 Step 2 判据）与 §13 Q3 裁决
 * （通路实现 + 开关默认关）：
 *  A. `buildMcpConfig` 三参三态：
 *     - `undefined` ⇒ **逐字节旧输出**（缺席即旧行为，与本仓 r19c-kn1-b LEGACY_OUT 同一护栏口径）；
 *     - `null` ⇒ 恒 `{mcpServers:{}}`（显式关凭据 ⇒ 绝不产出「配了守卫却带不上凭据」的静默 401 形态）；
 *     - 非空串 ⇒ `headers.Authorization = 'Bearer ${<envName>}'` **变量引用字面在场**、
 *       键序 `headers,type,url`（条件展开 ⇒ 缺席时无 headers 键）。
 *  B. `containsBearerCredentialLiteral` 明文反证（NFR-511 / K-17）：任何 `Bearer` 后面
 *     不是 `${` 引用 ⇒ true；引用形态 ⇒ false；`buildMcpConfig` 所有产出恒 false（自证）。
 *  C. provider options ⇒ 桥/配置生成的**透传链**（`WorkbuddyLlmProvider` 构造期归一 +
 *     注入默认桥；`bridge` 注入路径不受影响；opts.bridge 在场时不透传 bearerEnvName 给桥）。
 *  D. `resolveInnerReconnect` 判序联动（通路就位后的语义变化）：
 *     ④ 缺席 ⇒ broken 且 reason 指向「通路已具备但未接线」新文案（含可操作指引）；
 *     ⑤ 有名无值 ⇒ broken；⑥ 有名有值 ⇒ **unverified（非 broken）** —— 本批核心判据：
 *     接线后 fail-closed 不再拒启（配合 `shouldFailClosedStart` 决策表复核）。
 *  E. `probeInnerReconnect` 单元面（注入 fetch，全判决分支离线可证）：
 *     200⇒ok / 401·403⇒broken / 其它⇒unverified / 抛错·超时⇒unverified（PR3）/
 *     端点或变量名缺席、env 无值、无 fetch ⇒ unverified；请求面自证：真值进
 *     authorization 头、`?dtid=t6reconnect-*` 可 grep、body 为带 id initialize。
 *  F. `injectBearerEnvAssignment`（delivery 注入面）：默认不触发（GOLDEN 字节冻结复核）、
 *     注入位置（紧跟 READY_TIMEOUT）、幂等（已存在同名行只替换值、绝不重复插行）、
 *     非法变量名拒绝（ps1 注入面防御）、返回值绝不含凭据值本身。
 *
 * 纪律：不起 HTTP 服务、不 spawn 真实 CLI（A/C 用假 sh 回显脚本）、不碰 process.env
 *      （判序/探针一律注入 env 视图）；真机端到端由 `qa/r19/t6-*` 另证。
 * 运行：node --test tests/unit/phase2-inner-credential.test.js
 * ⚠ 依赖已重建 dist（`tsc -b tsconfig.build.json`）。
 */

import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildMcpConfig,
  appendDtid,
  containsBearerCredentialLiteral,
  createProvider,
  CliLlmBridge,
  DEFAULT_BEARER_ENV_NAME,
} from '@winvm/adapter-agent-workbuddy-llm';

import {
  resolveInnerReconnect,
  shouldFailClosedStart,
  probeInnerReconnect,
  probeInitializeBody,
} from '@winvm/vm-service';

import { buildTaskXml, injectBearerEnvAssignment } from '../../delivery/install-vm.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const src = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');

const URL = 'http://127.0.0.1:18443/mcp';
const LEGACY_OUT = (ep) => JSON.stringify({ mcpServers: { winvm: { type: 'streamableHttp', url: ep } } });
const EMPTY = JSON.stringify({ mcpServers: {} });

/* ============================================================================
 * A. buildMcpConfig 三态（凭据承载形态）
 * ========================================================================== */

describe('P2-T6 · A buildMcpConfig headers 变量引用形态', () => {
  test('非空变量名 ⇒ headers.Authorization 为 `Bearer ${<envName>}` 字面（值绝不入串）', () => {
    const out = buildMcpConfig(URL, undefined, 'WINVM_BEARER_TOKEN');
    const parsed = JSON.parse(out);
    assert.equal(
      parsed.mcpServers.winvm.headers.Authorization,
      'Bearer ${WINVM_BEARER_TOKEN}',
      '引用形态字面在场（真机 E1 实证 codebuddy 会按子进程 env 展开该引用）',
    );
    assert.equal(out.includes('${WINVM_BEARER_TOKEN}'), true);
    assert.equal(containsBearerCredentialLiteral(out), false, 'A 组产出必须通过明文反证');
  });

  test('默认变量名常量与 security.tokenEnv 约定同源（WINVM_BEARER_TOKEN）', () => {
    assert.equal(DEFAULT_BEARER_ENV_NAME, 'WINVM_BEARER_TOKEN');
    assert.equal(buildMcpConfig(URL, undefined, DEFAULT_BEARER_ENV_NAME), buildMcpConfig(URL, undefined, 'WINVM_BEARER_TOKEN'));
  });

  test('dtid 与 headers 可并存：url 拼 ?dtid=、headers 注入（委派归因不因凭据丢失）', () => {
    const out = buildMcpConfig(URL, 'tr_t6_1', 'WINVM_BEARER_TOKEN');
    const parsed = JSON.parse(out);
    assert.equal(parsed.mcpServers.winvm.url, `${URL}?dtid=tr_t6_1`);
    assert.equal(parsed.mcpServers.winvm.headers.Authorization, 'Bearer ${WINVM_BEARER_TOKEN}');
  });

  test('自定义变量名（trim 后入引用）；纯空白视同缺席 ⇒ 旧形态（无 headers 键）', () => {
    const out = buildMcpConfig(URL, undefined, '  MY_TOKEN  ');
    assert.equal(JSON.parse(out).mcpServers.winvm.headers.Authorization, 'Bearer ${MY_TOKEN}');
    assert.equal(buildMcpConfig(URL, undefined, '   '), LEGACY_OUT(URL), '空白串 ⇒ 无 headers ⇒ 逐字节旧形态');
    assert.equal(buildMcpConfig(URL, undefined, ''), LEGACY_OUT(URL), '空串等同缺席');
  });

  test('注入后键序为 headers,type,url；缺席时 Object.keys 恰为 [type,url]（条件展开）', () => {
    const withHdr = JSON.parse(buildMcpConfig(URL, undefined, 'WINVM_BEARER_TOKEN'));
    assert.deepEqual(Object.keys(withHdr.mcpServers.winvm).sort(), ['headers', 'type', 'url']);
    const legacy = JSON.parse(buildMcpConfig(URL));
    assert.deepEqual(Object.keys(legacy.mcpServers.winvm).sort(), ['type', 'url']);
  });

  test('null ⇒ 恒空 mcpServers（显式关凭据：endpoint 在场也不产出 winvm 条目）', () => {
    assert.equal(buildMcpConfig(URL, 'tr_1', null), EMPTY);
    assert.equal(buildMcpConfig(URL, undefined, null), EMPTY);
  });

  test('undefined ⇒ 逐字节旧输出（缺席即旧行为；含 dtid 分支亦逐字节等于旧实现）', () => {
    assert.equal(buildMcpConfig(URL), LEGACY_OUT(URL));
    assert.equal(buildMcpConfig(URL, undefined), LEGACY_OUT(URL));
    assert.equal(buildMcpConfig(URL, undefined, undefined), LEGACY_OUT(URL));
    assert.equal(
      buildMcpConfig(URL, 'tr_kn1_b_77', undefined),
      `{"mcpServers":{"winvm":{"type":"streamableHttp","url":"${URL}?dtid=tr_kn1_b_77"}}}`,
    );
    assert.equal(buildMcpConfig('', 'tr_1', 'WINVM_BEARER_TOKEN'), EMPTY, 'endpoint 缺席优先于凭据注入');
    assert.equal(buildMcpConfig(undefined, 'tr_1', 'WINVM_BEARER_TOKEN'), EMPTY);
  });
});

/* ============================================================================
 * B. 明文反证 containsBearerCredentialLiteral
 * ========================================================================== */

describe('P2-T6 · B 凭据明文反证（NFR-511/K-17）', () => {
  test('引用形态 false；裸 token / 真值 / 空值 false 面与 true 面分界清晰', () => {
    assert.equal(containsBearerCredentialLiteral('Bearer ${WINVM_BEARER_TOKEN}'), false);
    assert.equal(containsBearerCredentialLiteral('Bearer  ${X}'), false, '允许 Bearer 与 ${ 间空白');
    assert.equal(containsBearerCredentialLiteral('bearer ${X}'), false, '大小写不敏感');
    assert.equal(containsBearerCredentialLiteral('Bearer secret-token-value'), true);
    assert.equal(containsBearerCredentialLiteral('Authorization: Bearer abc.def'), true);
    assert.equal(containsBearerCredentialLiteral('Bearer '), true, 'Bearer 后空值也是明文形态');
    // 残缺引用（无闭合）⇒ 按明文处理：CLI 展不开它，等价于裸值进配置（宁误拒不漏判）
    assert.equal(containsBearerCredentialLiteral('Bearer ${'), true);
    assert.equal(containsBearerCredentialLiteral('no auth here'), false);
    // 变量名本身含 BEARER 字样不得被误判（本函数的历史缺陷，A/B 组交叉护栏）
    assert.equal(containsBearerCredentialLiteral('"WINVM_BEARER_TOKEN"'), false, '独立标识符里的 BEARER 子串不是凭据面');
    assert.equal(containsBearerCredentialLiteral('bearerEnvName'), false, '驼峰拼接不算单词边界');
    assert.equal(containsBearerCredentialLiteral('a bearer token'), true, '独立单词 bearer ⇒ 明文面');
  });

  test('buildMcpConfig 全产出恒通过反证（三态 × dtid 组合枚举，产出点防线零误伤）', () => {
    for (const bearer of [undefined, null, 'WINVM_BEARER_TOKEN', 'X_Y']) {
      for (const dtid of [undefined, 'tr_1']) {
        for (const ep of [URL, '', undefined]) {
          const out = buildMcpConfig(ep, dtid, bearer);
          assert.equal(containsBearerCredentialLiteral(out), false, `产出泄漏明文形态：ep=${ep} dtid=${dtid} bearer=${bearer}`);
        }
      }
    }
  });

  test('真 token 值绝不进配置串（值≠引用名的可证伪断言）', () => {
    const SECRET = 'p2t6-real-token-9f3a';
    const out = buildMcpConfig(URL, 'tr_1', 'WINVM_BEARER_TOKEN');
    assert.equal(out.includes(SECRET), false);
    // 同名变量值写进 env 也不影响产出（配置面与值面在数据结构上就分家）
    const prev = process.env['WINVM_BEARER_TOKEN'];
    process.env['WINVM_BEARER_TOKEN'] = SECRET;
    try {
      assert.equal(buildMcpConfig(URL, 'tr_1', 'WINVM_BEARER_TOKEN'), out, '产出与 env 值无关（只承载引用名）');
      assert.equal(buildMcpConfig(URL, 'tr_1', 'WINVM_BEARER_TOKEN').includes(SECRET), false);
    } finally {
      if (prev === undefined) delete process.env['WINVM_BEARER_TOKEN'];
      else process.env['WINVM_BEARER_TOKEN'] = prev;
    }
  });
});

/* ============================================================================
 * C. provider options ⇒ 桥透传链
 * ========================================================================== */

describe('P2-T6 · C provider bearerEnvName 透传与构造期归一', () => {
  const tmpDirs = [];
  const mkOutDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'p2t6-c-'));
    tmpDirs.push(dir);
    return dir;
  };
  after(() => {
    for (const d of tmpDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* 尽力清理 */
      }
    }
  });

  test('默认桥路径：options.bearerEnvName 透传进 CliLlmBridge（同名字段可观测）', () => {
    const provider = createProvider({ bearerEnvName: 'WINVM_BEARER_TOKEN' });
    const bridge = provider.bridge;
    assert.ok(bridge instanceof CliLlmBridge, '默认桥应为 CliLlmBridge');
    assert.equal(bridge.bearerEnvName, 'WINVM_BEARER_TOKEN');
  });

  test('三态归一：null 原样 / 纯空白 ⇒ undefined / 带空白串 ⇒ trim（与 http-guard 判序同规则）', () => {
    assert.equal(createProvider({ bearerEnvName: null }).bridge.bearerEnvName, null);
    assert.equal(createProvider({ bearerEnvName: '  ' }).bridge.bearerEnvName, undefined);
    assert.equal(createProvider({}).bridge.bearerEnvName, undefined, '缺席 ⇒ undefined（旧行为）');
    assert.equal(createProvider({ bearerEnvName: '  A_B  ' }).bridge.bearerEnvName, 'A_B');
    assert.equal(createProvider().bridge.bearerEnvName, undefined);
  });

  test('显式 bridge 注入路径不受影响（opts.bridge 在场 ⇒ 不构造默认桥、零侵入）', () => {
    const stub = { id: 'stub', runGoal: async () => ({}) };
    const provider = createProvider({ bridge: stub, bearerEnvName: 'WINVM_BEARER_TOKEN' });
    assert.equal(provider.bridge, stub, '注入桥优先（单测/替身面零改动）');
  });

  test('桥落盘面：单次 -p 路径生成的 mcp.json 含引用、不含值（端到端产物自证）', async () => {
    const dir = mkOutDir();
    const outDir = join(dir, 'out');
    mkdirSync(outDir, { recursive: true });
    // 假 CLI：只回显文本，不真执行（沿用 kn1-b 夹具纪律）
    writeFileSync(join(dir, 'out1.txt'), 'done\n', 'utf8');
    const cliPath = join(dir, 'fake-codebuddy');
    writeFileSync(
      cliPath,
      ['#!/bin/sh', `cat "${dir}/out1.txt"`, 'exit 0', ''].join('\n'),
      'utf8',
    );
    chmodSync(cliPath, 0o755);

    const SECRET = 'p2t6-cfg-leak-check-77';
    const bridge = new CliLlmBridge({
      cliPath,
      outputDir: outDir,
      persistent: false,
      endpoint: URL,
      bearerEnvName: 'WINVM_P2T6_TEST_ENV',
    });
    const prev = process.env['WINVM_P2T6_TEST_ENV'];
    process.env['WINVM_P2T6_TEST_ENV'] = SECRET;
    try {
      const sink = { onStatus: () => {}, onArtifact: () => {} };
      await bridge.runGoal(
        {
          goal: 'P2-T6 落盘形态自证',
          capabilities: ['meta.echo'],
          outputDir: outDir,
          cliPath,
          endpoint: URL,
          traceId: 'tr_p2t6_c',
          taskId: 'task_p2t6_c',
          timeoutMs: 30_000,
        },
        sink,
      );
      const mcpFile = join(dir, '.winvm', 'mcp.json');
      assert.ok(existsSync(mcpFile), 'mcp.json 应落盘于 outputDir 同级 .winvm');
      const disk = readFileSync(mcpFile, 'utf8');
      assert.equal(disk.includes('Bearer ${WINVM_P2T6_TEST_ENV}'), true, '磁盘配置承载变量引用');
      assert.equal(disk.includes(SECRET), false, '磁盘配置绝不承载真值（NFR-511）');
      assert.equal(containsBearerCredentialLiteral(disk), false);
    } finally {
      if (prev === undefined) delete process.env['WINVM_P2T6_TEST_ENV'];
      else process.env['WINVM_P2T6_TEST_ENV'] = prev;
    }
  });
});

/* ============================================================================
 * D. resolveInnerReconnect 判序联动（通路就位后的语义）
 * ========================================================================== */

describe('P2-T6 · D 判序联动（接线后不再恒 broken）', () => {
  const ENFORCED = 'bearer-enforced';

  test('⑥ 有名有值 ⇒ unverified（非 broken）⇒ fail-closed 不拒启：T6 接线轮的放行实形', () => {
    const r = resolveInnerReconnect(
      { authMode: ENFORCED, providerOptions: { bearerEnvName: 'WINVM_BEARER_TOKEN' } },
      { WINVM_BEARER_TOKEN: 'secret-value' },
    );
    assert.equal(r.status, 'unverified', '通路接好（配置面必要条件满足）不得再判 broken');
    assert.match(r.reason, /配置在位/);
    assert.match(r.reason, /探针实证|不谎称已证/);
    const d = shouldFailClosedStart({ authMode: ENFORCED, innerReconnect: r.status, failClosed: true });
    assert.equal(d.refuse, false, '有名有值 + failClosed=true ⇒ 放行（拒启仅属确证 broken）');
  });

  test('④ 缺席 ⇒ 仍 broken（通路可用但没接线 ⇒ 拒启是正确结论），且 reason 给可操作接线指引', () => {
    const r = resolveInnerReconnect({ authMode: ENFORCED, providerOptions: { endpoint: URL } }, {});
    assert.equal(r.status, 'broken');
    assert.match(r.reason, /P2-T6/);
    assert.match(r.reason, /通路已具备（P2-T6），但\*\*尚未接线\*\*/, '语义订正：不是通路不存在，是没接线');
    assert.match(r.reason, /agent\.providers\.<id>\.options\.bearerEnvName/, '指引写配置键全路径');
    assert.match(r.reason, /WINVM_BEARER_TOKEN/, '指引含默认约定名');
    assert.match(r.reason, /start-hidden\.ps1/, '指引含注入面（唯一 env 来源）');
    // 旧钉 token 零回归（phase2-bearer-selfcheck :160/:190 系同族前缀）
    assert.match(r.reason, /buildMcpConfig 条目零凭据/);
    assert.match(r.reason, /回连必 401/);
  });

  test('⑤ 有名无值 ⇒ broken（双条件缺件）——与 T5 逐字不变（判序⑤职权归配置面）', () => {
    const r = resolveInnerReconnect(
      { authMode: ENFORCED, providerOptions: { bearerEnvName: 'WINVM_BEARER_TOKEN' } },
      { WINVM_BEARER_TOKEN: '   ' },
    );
    assert.equal(r.status, 'broken');
    assert.match(r.reason, /有名无值，双条件缺件/);
  });

  test('③ probeStatus 实证优先：探针 ok ⇒ 采用 ok（观测面升级的判据通道）', () => {
    const ok = resolveInnerReconnect(
      { authMode: ENFORCED, providerOptions: { bearerEnvName: 'WINVM_BEARER_TOKEN' }, probeStatus: 'ok' },
      { WINVM_BEARER_TOKEN: 'v' },
    );
    assert.equal(ok.status, 'ok', 'T5 预留的 probeStatus 通道本批接上 ⇒ ok 实形可达');
    assert.match(ok.reason, /实证优先/);
    const broken = resolveInnerReconnect({ authMode: ENFORCED, probeStatus: 'broken' }, {});
    assert.equal(broken.status, 'broken');
  });

  test('② probeError ⇒ unverified（PR3：探针故障绝不冒充 broken —— 探针上线后此护栏更关键）', () => {
    const r = resolveInnerReconnect(
      { authMode: ENFORCED, providerOptions: { bearerEnvName: 'X' }, probeError: 'timeout 5000ms' },
      { X: 'v' },
    );
    assert.equal(r.status, 'unverified');
    assert.match(r.reason, /绝不据此拒启/);
  });

  test('① 守卫未挂载 ⇒ unverified（默认态恒不拒启；T6 改动零波及）', () => {
    for (const authMode of ['loopback-only', 'bearer-configured-missing']) {
      const r = resolveInnerReconnect({ authMode, providerOptions: { bearerEnvName: 'X' } }, { X: 'v' });
      assert.equal(r.status, 'unverified');
      assert.equal(shouldFailClosedStart({ authMode, innerReconnect: r.status, failClosed: true }).refuse, false);
    }
  });

  test('装配面静态守卫：探针 fire-and-forget 于 listen 之后；拒启判据仍只喂配置面 const', () => {
    const serverSrc = src('packages/vm-service/src/server.ts');
    const listenAt = serverSrc.indexOf('await new Promise<void>((resolve, reject) => {');
    const probeAt = serverSrc.indexOf('probeInnerReconnect({');
    assert.ok(listenAt > 0 && probeAt > listenAt, '自环探针必须晚于 listen（前置=启动依赖死锁）');
    assert.ok(/void \(async \(\): Promise<void> => \{[\s\S]{0,200}?probeInnerReconnect\(/.test(serverSrc.slice(probeAt - 220, probeAt + 60)), '探针必须 fire-and-forget（void，绝不 await 于启动链路）');
    const failAt = serverSrc.indexOf('const failClosedDecision = shouldFailClosedStart({');
    assert.ok(failAt < listenAt, '拒启判据必须先于 listen（且先于探针）');
    assert.match(serverSrc, /let innerReconnectObserved: InnerReconnectHealth = innerReconnect;/, '观测面变量在位');
    assert.match(serverSrc, /innerReconnectObserved = probed;/, '实证结论只升级观测面');
    assert.ok(!/innerReconnect = probed;/.test(serverSrc), '配置面 const 绝不被探针回写');
    assert.match(serverSrc, /const innerReconnect: InnerReconnectHealth = innerReconnectObserved;\s*\n\s*return buildSecurityHealthSnapshot\(\{[\s\S]{0,200}?innerReconnect,/, '/health 喂观测面且保持字面 shorthand（:524 钉兼容）');
    assert.ok(!serverSrc.includes('innerReconnectAtStartup'), '冗余启动快照变量必须已删除');
  });
});

/* ============================================================================
 * E. probeInnerReconnect 单元面（注入 fetch 全分支）
 * ========================================================================== */

describe('P2-T6 · E 回连运行期探针判决映射', () => {
  const ENV = { WINVM_BEARER_TOKEN: 'probe-secret-v' };
  const base = { endpoint: `${URL}`, bearerEnvName: 'WINVM_BEARER_TOKEN', env: ENV };

  const fakeFetch = (status, capture) => async (url, init) => {
    if (capture) {
      capture.url = url;
      capture.init = init;
    }
    return { status };
  };

  test('200 ⇒ ok（端到端实证结论），且请求面自证：真值入 authorization、dtid 探针标识、initialize 样本', async () => {
    const cap = {};
    const r = await probeInnerReconnect({ ...base, fetchImpl: fakeFetch(200, cap), probeId: 'unit' });
    assert.equal(r.status, 'ok');
    assert.match(r.reason, /HTTP 200/);
    assert.match(r.reason, /端到端可用/);
    // 请求面（这是探针与「CLI 侧 headers 展开后」等价性的机器可读证明）
    assert.equal(cap.init.headers.authorization, 'Bearer probe-secret-v', '探针用真值发带凭据回连');
    assert.match(cap.url, /[?&]dtid=t6reconnect-unit$/, '自发流量可 grep 标识');
    assert.equal(cap.init.method, 'POST');
    const body = JSON.parse(cap.init.body);
    assert.equal(body.method, 'initialize');
    assert.equal(body.id, 0, '带 id 样本（非通知 ⇒ 202 无区分度）');
    assert.match(body.params.clientInfo.name, /t6reconnect-unit/);
    // 探针请求头本身就是明文 Bearer 真值（运行期内存态，不落盘）⇒ 反证函数在此命中是
    // 预期方向：该函数管的是**配置产出点**，探针是一次性出站请求，不是配置。
    assert.equal(containsBearerCredentialLiteral(cap.init.headers.authorization), true);
  });

  test('401 / 403 ⇒ broken（确证凭据未到位），reason 端点脱敏（dtid 值不外泄）', async () => {
    for (const status of [401, 403]) {
      const r = await probeInnerReconnect({ ...base, fetchImpl: fakeFetch(status), probeId: 'unit' });
      assert.equal(r.status, 'broken', `HTTP ${status} ⇒ 确证断链`);
      assert.match(r.reason, new RegExp(`HTTP ${status}`));
      assert.equal(r.reason.includes('t6reconnect-unit'), false, 'reason 脱敏探针 dtid 值');
      assert.equal(r.reason.includes('probe-secret-v'), false, 'reason 绝不携带凭据值');
    }
  });

  test('其它状态码 ⇒ unverified（语义未明不猜，PR3）', async () => {
    for (const status of [202, 400, 500]) {
      const r = await probeInnerReconnect({ ...base, fetchImpl: fakeFetch(status) });
      assert.equal(r.status, 'unverified', `HTTP ${status} 不得冒充 ok/broken`);
      assert.match(r.reason, /绝不据此拒启/);
    }
  });

  test('fetch 抛错 ⇒ unverified；超时（abort）⇒ unverified 且文案区分', async () => {
    const boom = async () => {
      throw new Error('ECONNREFUSED');
    };
    const r1 = await probeInnerReconnect({ ...base, fetchImpl: boom });
    assert.equal(r1.status, 'unverified');
    assert.match(r1.reason, /ECONNREFUSED/);

    const hang = (url, init) =>
      new Promise((_res, rej) => {
        init.signal.addEventListener('abort', () => rej(new Error('aborted')));
      });
    const r2 = await probeInnerReconnect({ ...base, fetchImpl: hang, timeoutMs: 20 });
    assert.equal(r2.status, 'unverified');
    assert.match(r2.reason, /超时 >20ms/);
  });

  test('入参缺件的三种 unverified：endpoint 缺席 / 变量名缺席 / 有名无值（判序⑤职权不越界）', async () => {
    const r1 = await probeInnerReconnect({ bearerEnvName: 'X', env: { X: 'v' } });
    assert.equal(r1.status, 'unverified');
    assert.match(r1.reason, /endpoint 缺席/);

    const r2 = await probeInnerReconnect({ endpoint: URL, env: ENV });
    assert.equal(r2.status, 'unverified');
    assert.match(r2.reason, /bearerEnvName 缺席/);

    const r3 = await probeInnerReconnect({ endpoint: URL, bearerEnvName: 'WINVM_BEARER_TOKEN', env: {} });
    assert.equal(r3.status, 'unverified', '「有名无值」探针**不**判 broken（那是配置面判序⑤的职权）');
    assert.match(r3.reason, /判序⑤/);

    const r4 = await probeInnerReconnect({ endpoint: '   ', bearerEnvName: '  ', env: ENV });
    assert.equal(r4.status, 'unverified');
  });

  test('无 fetch 运行时 ⇒ unverified（观测面不可用 ≠ 回连断了）；probeInitializeBody 形态钉', () => {
    const body = probeInitializeBody('dt_x');
    assert.deepEqual(body, {
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'winvm-inner-reconnect-probe/dt_x', version: '1.0.0' },
      },
    });
    // fetchImpl 显式传 undefined + 环境无 global fetch 面时按契约不崩（Node 18+ 恒有 fetch，
    // 这里只断「注入缺席不抛同步异常」：走全局 fetch 打不可达端口 ⇒ 异步 unverified）。
    return probeInnerReconnect({ endpoint: 'http://127.0.0.1:1/mcp', bearerEnvName: 'X', env: { X: 'v' }, timeoutMs: 50 }).then((r) => {
      assert.equal(r.status, 'unverified', '不可达 ⇒ unverified（PR3），绝不 broken');
    });
  });
});

/* ============================================================================
 * F. delivery 注入面（injectBearerEnvAssignment + 默认零触发）
 * ========================================================================== */

describe('P2-T6 · F start-hidden 凭据赋值注入面', () => {
  const TASK_NAME = 'WinVM Bridge VM Service';
  const NODE_EXE = 'C:\\nvm4w\\nodejs\\node.exe';
  const CLI = 'C:\\WinVMBridge\\repo\\packages\\vm-service\\dist\\cli.js';
  const CFG = 'C:\\WinVMBridge\\repo\\delivery\\.generated\\vm-service.runtime.json';
  const PORT = 18443;
  const tmpDirs = [];
  const mkDir = () => {
    const d = mkdtempSync(join(tmpdir(), 'p2t6-f-'));
    tmpDirs.push(d);
    return d;
  };
  after(() => {
    for (const d of tmpDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* 尽力清理 */
      }
    }
  });

  test('默认（不传开关）⇒ 部署产物不含任何 bearer 赋值行（GOLDEN 面零波及）', () => {
    const dir = mkDir();
    buildTaskXml(TASK_NAME, NODE_EXE, CLI, PORT, CFG, dir);
    const ps1 = readFileSync(join(dir, 'start-hidden.ps1'), 'utf8');
    assert.equal(ps1.includes('WINVM_BEARER_TOKEN'), false, '默认产物零凭据行（缺席即旧行为）');
    assert.match(ps1, /\$env:WINVM_PSBRIDGE_READY_TIMEOUT_MS = '60000'\r\n\$nodeExe = /, '超时行与 $nodeExe 行紧邻（未注入时形状逐字不变）');
  });

  test('注入 ⇒ 紧跟 READY_TIMEOUT 之后、$nodeExe 之前；默认占位空值；返回值不含值', () => {
    const dir = mkDir();
    buildTaskXml(TASK_NAME, NODE_EXE, CLI, PORT, CFG, dir);
    const ps1Path = join(dir, 'start-hidden.ps1');
    const res = injectBearerEnvAssignment(ps1Path, 'WINVM_BEARER_TOKEN');
    assert.equal(res.changed, true);
    assert.equal(res.inserted, true);
    assert.equal(res.envName, 'WINVM_BEARER_TOKEN');
    assert.equal(res.hasValue, false, '默认占位空值 ⇒ hasValue=false 显形');
    assert.deepEqual(Object.keys(res).sort(), ['changed', 'envName', 'hasValue', 'inserted'], '返回值只含事实，绝不含凭据值');
    const lines = readFileSync(ps1Path, 'utf8').split('\r\n');
    const readyAt = lines.indexOf("$env:WINVM_PSBRIDGE_READY_TIMEOUT_MS = '60000'");
    assert.ok(readyAt >= 0);
    assert.equal(lines[readyAt + 1], "$env:WINVM_BEARER_TOKEN = ''", '占位空串注入（真值由运维替换）');
    assert.match(lines[readyAt + 2], /^\$nodeExe = /, 'env 段内聚：注入位与 admin-endpoint 同段');
  });

  test('幂等：重复注入同名同值 ⇒ changed=false 且行数不增；改名/改值 ⇒ 就地替换绝不重复插行', () => {    const dir = mkDir();
    buildTaskXml(TASK_NAME, NODE_EXE, CLI, PORT, CFG, dir);
    const ps1Path = join(dir, 'start-hidden.ps1');
    injectBearerEnvAssignment(ps1Path, 'WINVM_BEARER_TOKEN', 'v1');
    const again = injectBearerEnvAssignment(ps1Path, 'WINVM_BEARER_TOKEN', 'v1');
    assert.equal(again.changed, false);
    assert.equal(again.inserted, false);
    const updated = injectBearerEnvAssignment(ps1Path, 'WINVM_BEARER_TOKEN', 'v2');
    assert.equal(updated.changed, true);
    assert.equal(updated.inserted, false);
    assert.equal(updated.hasValue, true);
    const content = readFileSync(ps1Path, 'utf8');
    assert.equal(content.split('$env:WINVM_BEARER_TOKEN').length - 1, 1, '赋值行恒一条（重复赋值最后一次生效虽无害，取证必须可读）');
    assert.match(content, /\$env:WINVM_BEARER_TOKEN = 'v2'/);
  });

  test('非法变量名 ⇒ 抛（ps1 注入面防御：只收 [A-Za-z_][A-Za-z0-9_]*）', () => {
    const dir = mkDir();
    buildTaskXml(TASK_NAME, NODE_EXE, CLI, PORT, CFG, dir);
    const ps1Path = join(dir, 'start-hidden.ps1');
    const before = readFileSync(ps1Path, 'utf8');
    for (const bad of ['', '   ', '1TOKEN', 'A B', "A'B", 'A-B', '$X', 'A;B', undefined, null, 42]) {
      assert.throws(() => injectBearerEnvAssignment(ps1Path, bad), /非法环境变量名/, `非法名必须被拒：${JSON.stringify(bad)}`);
    }
    assert.equal(readFileSync(ps1Path, 'utf8'), before, '被拒路径零写盘');
  });

  test('启动器不存在 ⇒ 抛（先部署后注入的顺序铁律的机器可读面）', () => {
    const dir = mkDir();
    assert.throws(
      () => injectBearerEnvAssignment(join(dir, 'nope.ps1'), 'WINVM_BEARER_TOKEN'),
      /启动器文件不存在/,
    );
  });

  test('值含单引号 ⇒ PS 单引号串内双写转义（合法名、脏值面）', () => {
    const dir = mkDir();
    buildTaskXml(TASK_NAME, NODE_EXE, CLI, PORT, CFG, dir);
    const ps1Path = join(dir, 'start-hidden.ps1');
    injectBearerEnvAssignment(ps1Path, 'WINVM_BEARER_TOKEN', "a'b");
    assert.match(readFileSync(ps1Path, 'utf8'), /\$env:WINVM_BEARER_TOKEN = 'a''b'/);
  });

  test('delivery 默认配置出厂态：workbuddy options 不写 bearerEnvName（开关默认关，Q3）', () => {
    const cfg = JSON.parse(src('delivery/vm-service.config.json'));
    const opts = cfg.agent.providers.workbuddy.options;
    assert.equal('bearerEnvName' in opts, false, '出厂默认零接线（enforce 默认关 ⇒ 判序④ broken 属正确语义）');
    assert.equal(cfg.security.enforceBearer, false);
    // install-vm 运行配置生成：仅当 --bearer-env-name 才注入该键 ⇒ 默认逐字节旧形态
    const installer = src('delivery/install-vm.mjs');
    assert.match(installer, /\.\.\.\(args\.bearerEnvName \? \{ bearerEnvName: args\.bearerEnvName \} : \{\}\)/, 'options 条件注入');
    assert.match(installer, /if \(args\.bearerEnvName\) \{[\s\S]{0,400}?injectBearerEnvAssignment\(join\(genDir, 'start-hidden\.ps1'\)/, 'ps1 注入仅开关在场时触发');
  });
});

/* ============================================================================
 * G. 源码文本面守卫（防注释漂移 —— 本仓「注释也是输入面」纪律）
 * ========================================================================== */

describe('P2-T6 · G 关键注释/文档口径在位', () => {
  test('bridge.ts：三态语义 + 真机实测出处 + NFR-511 拒绝 url 明文分支', () => {
    const bridgeSrc = src('packages/adapter-agent-workbuddy-llm/src/bridge.ts');
    assert.match(bridgeSrc, /t6-probe-e1/, '实测证据编号必须可溯源');
    assert.match(bridgeSrc, /NFR-511/);
    assert.match(bridgeSrc, /K-17/);
    assert.match(bridgeSrc, /Bearer \$\{<envName>\}/, '承载形态文档句在位');
    // 被 phase2-bearer-selfcheck :317 钉住的原警告正文仍在（T6 只加兑现现状，不改判据措辞）
    assert.match(bridgeSrc, /没有任何凭据字段/);
    assert.match(bridgeSrc, /零副作用虚假完成/);
    assert.match(bridgeSrc, /SECURITY-GOVERNANCE\.md` §7/);
  });

  test('http-guard.ts：判序注释反映 T6 语义演变（T5 立判序 ⇒ T6 通路面就位）', () => {
    const guardSrc = src('packages/vm-service/src/http-guard.ts');
    // :317 钉的 §2.1 引用面在链上条目 summary（http-guard），不在 adapter bridge —— 口径别搞错
    assert.match(guardSrc, /SECURITY-GOVERNANCE §2\.1/);
    assert.match(guardSrc, /T5 立判序 ⇒ P2-T6 通路面就位|T5 立判序.*P2-T6/s);
    assert.match(guardSrc, /可用但未接线/);
    // 判序⑤⑥ reason 逐字未动（既有测试钉）
    assert.match(guardSrc, /有名无值，双条件缺件/);
    assert.match(guardSrc, /本判定不谎称已证/);
  });

  test('probe 模块文件头三条护栏在位 + server 装配 import 就位', () => {
    assert.match(src('packages/vm-service/src/inner-reconnect-probe.ts'), /绝不冒充 broken/);
    assert.match(src('packages/vm-service/src/inner-reconnect-probe.ts'), /自环死锁/);
    const serverSrc = src('packages/vm-service/src/server.ts');
    assert.match(serverSrc, /import \{[^}]*probeInnerReconnect[^}]*\} from '\.\/inner-reconnect-probe\.js'/s);
    assert.match(serverSrc, /if \(serviceClosed\) return;/, '探针回写前的收口竞态守卫');
  });

  test('appendDtid 既有行为零波及（凭据分支未动 dtid 拼接）', () => {
    assert.equal(appendDtid(URL, 'tr_1'), `${URL}?dtid=tr_1`);
    assert.equal(appendDtid(URL, undefined), URL);
  });
});

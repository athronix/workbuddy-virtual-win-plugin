/**
 * vnext-build-artifacts — 五阶段交付物在**构建产物**中的存在性守卫
 *
 * ## 为什么需要这个测试（2026-11-26 真机验证逼出来的）
 *
 * 6.3 真机验证时发现：探针 34/34 + 38/38 全通，但 VM 上跑的是 2026-11-20 的**旧构建**
 * —— `gateway.js` 不存在、`shared-skills` 只有 7 个、adapter 里没有 `winvm-browser`。
 *
 * 结论：**源码改了 ≠ dist 里有 ≠ VM 上跑的是它**，这是三个独立的环。
 * 本测试守中间那个环（dist），因为它是唯一能在本地静态断言、且发版包直接取材的环。
 *
 * ## 守什么
 *
 * 12 条「阶段 → 真实落点文件 + 独有符号」的锚定断言。**落点全部经 grep 实证**，
 * 不是按「逻辑上应该在哪」猜的（猜路径产生假红，排查时白花一轮）。
 *
 * ## 三条刻意设计的抗假绿措施
 *
 * 1. **不用目录 mtime 判断新旧**：`tsc -b` 依据 tsbuildinfo 的内容 hash 增量，
 *    内容未变时**不重写 dist** ⇒ dist 的 mtime 可能早于 src 而完全正常。
 *    本测试只断言「符号存在」，不断言时间先后。
 * 2. **不查子串了事**：每条都锚定到**该阶段独有**的符号（如 `gateAndExecute` 而非 `gate`），
 *    并断言所在文件正确 —— 防止符号出现在别的文件里也算过。
 * 3. **每条都有反向可证性**：删掉对应源码再构建，本条必红（见文件末尾突变清单）。
 *
 * 注意：本测试**依赖 dist 已构建**。若 dist 缺失，报错要明确指向「先构建」，
 * 而不是含糊地报 ENOENT。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * 12 条锚定断言。
 * stage=阶段号 / file=**真实落点**（相对仓库根）/ token=该阶段独有符号 / why=为什么是这个落点
 */
const ARTIFACTS = [
  {
    stage: '2.1',
    file: 'packages/contracts/dist/unified.js',
    token: 'SURFACE_EXPECTED_COUNTS',
    why: '统一契约面常量（54/33/25 与 UNIFIED_TOTAL）住在 contracts',
  },
  {
    stage: '2.2',
    file: 'packages/vm-capabilities/dist/registry/unified.js',
    token: 'UNIFIED_CAPABILITIES',
    why: '统一能力表由 vm 面 .map 派生，零字面量',
  },
  {
    stage: '2.4',
    file: 'packages/vm-capabilities/dist/registry/unified.js',
    token: 'DEFAULT_DESKTOP_TOOL_ALLOWLIST',
    why: 'desktop 白名单已下沉到 vm-capabilities（否则 vm-service 反向 import 成环）',
  },
  {
    stage: '2.4',
    file: 'packages/contracts/dist/unified.js',
    token: 'DEFAULT_DESKTOP_TOOL_ALLOWLIST',
    why: '契约层同时导出，供两端引用同一份定义',
  },
  {
    stage: '3.1',
    file: 'packages/vm-service/dist/gateway.js',
    token: 'gateAndExecute',
    why: '闸门从 server.ts 抽成独立文件；文件本身就是 3.1 的交付物',
  },
  {
    stage: '3.2',
    file: 'packages/vm-service/dist/server.js',
    token: 'gateAndExecute',
    why: 'server 必须**调用**闸门（不是只有 gateway.js 存在却没人用）',
  },
  {
    stage: '3.2',
    file: 'packages/vm-service/dist/server.js',
    token: 'mcp/browser',
    why: '上游代理路由：POST /mcp/browser 与 /mcp/desktop 在 server 里注册',
  },
  {
    stage: '3.6b',
    file: 'packages/adapter-agent-workbuddy-llm/dist/bridge.js',
    token: 'winvm-browser',
    why: '三条目 mcpServers 在 **llm** 包的 bridge.ts:362（不是 adapter-agent-workbuddy）',
  },
  {
    stage: '3.6b',
    file: 'packages/adapter-agent-workbuddy-llm/dist/bridge.js',
    token: 'deriveMcpBase',
    why: '基址用 deriveMcpBase 推导（尾正则对尾斜杠与 query 形态静默失效）',
  },
  {
    stage: '4.3',
    file: 'packages/adapter-agent-workbuddy-llm/dist/cli-agent-planner.js',
    token: "'cli-agent'",
    why: 'Planner 抽成独立文件；id 必须是 cli-agent 而非 llm（bridge.js 里只有注释提及）',
  },
  {
    stage: '5.1',
    file: 'delivery/connect-channel.mjs',
    token: 'writeVmConnConfig',
    why: '通道连接逻辑从 install-host 抽到独立模块（delivery 是 .mjs，不经 tsc）',
  },
  {
    stage: '5.1',
    file: 'delivery/install-host.mjs',
    token: 'writeVmConnConfig',
    why: 'host 侧保留再导出 + 调用点（撤销会让 --no-tunnel 冷装通路断掉）',
  },
];

function readOrFail(relPath) {
  const abs = join(ROOT, relPath);
  if (!existsSync(abs)) {
    throw new Error(
      `构建产物缺失：${relPath}\n` +
        '  ⇒ 先跑 `npx tsc -b tsconfig.build.json`（本测试只验收产物，不负责构建）。\n' +
        '  若该文件本就应存在而被删，那是真的回归，见 14-EXECUTION-PLAN 对应阶段。',
    );
  }
  return readFileSync(abs, 'utf8');
}

describe('vnext-build-artifacts · 五阶段交付物必须在 dist 中', () => {
  test('① 12 条五阶段符号全部存在于**正确的**构建产物中', () => {
    const missing = [];
    for (const a of ARTIFACTS) {
      let src;
      try {
        src = readOrFail(a.file);
      } catch {
        missing.push(`[${a.stage}] ${a.file} — 文件缺失`);
        continue;
      }
      if (!src.includes(a.token)) {
        missing.push(`[${a.stage}] ${a.file} — 缺符号 ${JSON.stringify(a.token)}（${a.why}）`);
      }
    }
    assert.deepStrictEqual(
      missing,
      [],
      `以下交付物未出现在构建产物中（说明 dist 落后于 src，或阶段被回退了）：\n  ${missing.join('\n  ')}`,
    );
  });

  test('② 每条断言的落点文件真实存在（防止 why 里写的落点与实际不符）', () => {
    const files = [...new Set(ARTIFACTS.map((a) => a.file))];
    const absent = files.filter((f) => !existsSync(join(ROOT, f)));
    assert.deepStrictEqual(absent, [], `落点文件不存在：\n  ${absent.join('\n  ')}`);
  });

  test('③ 3.6b 的三条目在同一次调用里同时出现（不是三个孤立字符串）', () => {
    const src = readOrFail('packages/adapter-agent-workbuddy-llm/dist/bridge.js');
    // 三条目必须出现在彼此的合理距离内，否则可能是别处的独立片段
    const m = src.match(/winvm-browser[\s\S]{0,6000}winvm-desktop/);
    assert.ok(
      m,
      '未找到「winvm-browser … winvm-desktop」的邻近共现 ⇒ 三条目 mcpServers 可能被拆散或删除',
    );
  });

  test('④ 3.2 的 server 真的**调用**闸门，而不只是 import 或被注释凑数', () => {
    const src = readOrFail('packages/vm-service/dist/server.js');

    // ★ 这个断言第一版写的是 `gateAndExecute 出现次数 >= 2`，被突变打穿了（假绿）：
    //   把**所有调用点**都替换掉之后计数从 6 降到 2，但仍 >= 2 ⇒ 照样通过。
    //   残留的那 2 处是：① `import { gateAndExecute } from './gateway.js'`
    //                  ② 一行注释「为什么不是给上游也造 CapabilityDefinition 走 gateAndExecute」
    //   ⇒ 正是红线 8 的「查次数」型假绿：import 与注释都能凑数。
    //
    //   修法：先剥注释，再只认**带括号的调用点**（`gateAndExecute(` 且前面不是 import 语句）。
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');

    // 排除 import/export 语句里的裸引用，只统计真正被调用的位置
    const calls = stripped
      .split('\n')
      .filter((l) => /gateAndExecute\s*\(/.test(l) && !/^\s*(import|export)\b/.test(l));

    assert.ok(
      calls.length >= 1,
      `剥注释后 server.js 中没有任何 gateAndExecute( 的调用行 ⇒ 闸门被旁路（只有 import 或注释残留）`,
    );
  });
});

/**
 * ## 反向可证性（怎么确认这不是空转）
 *
 * 三条突变，每条都必须让本测试变红：
 *   1. 删 `packages/vm-service/src/gateway.ts` 里 `gateAndExecute` 的导出 → 重建 → ① 与 ④ 红
 *   2. 把 `deriveMcpBase` 改回尾正则 `endpoint.replace(/\/mcp$/, '')` → 重建 → ① 红（符号消失）
 *   3. 把 `cli-agent-planner.ts` 的 `id` 从 `'cli-agent'` 改成 `'llm'` → 重建 → ① 红
 *
 * ## 已知边界
 *
 * - 本测试**不判断 src 与 dist 的时间先后**。理由：`tsc -b` 按内容 hash 增量，
 *   内容未变时不重写 dist，因此 dist mtime 早于 src 完全正常（2026-11-26 实证）。
 *   判断「dist 是否最新」应跑 `tsc -b` 看它有没有报错，而不是比 mtime。
 * - 本测试**不覆盖 VM 侧**。VM 是否装了新包，只能靠发版后比对 dist 构建时间 +
 *   关键符号（见 14-EXECUTION-PLAN Step 6.3 的取证表）。
 */
#!/usr/bin/env node
/**
 * p8 · 探针新鲜复用判定单测（v1.3.0 时间预算战役，run22 账本驱动）
 *
 * ## 2026-11-25 重写说明（这一段必须先读）
 *
 * 原版守的是 `deploy/skills/winvm-plugin-deploy/scripts/probe-fresh.sh`。该脚本在
 * 「_common.sh 重写」那一轮被**内联进 `deploy-5-verify.sh`**，自身移入 `scripts/legacy/`
 * 且**零调用方**。于是原版单测有两个问题：
 *   1. 路径 `scripts/probe-fresh.sh` 已不存在 ⇒ `bash: No such file` ⇒ **exit 127**，
 *      12 条断言全红，且报错文案是「probe-fresh 恒 exit 0」这种误导性描述；
 *   2. 即便把路径改指 `legacy/`，测的也是**死代码** —— 其语义已与生产分叉
 *      （legacy 用 `-ge` 且 reason 写「超新鲜窗」；生产用 `-gt` 且 reason 写 `stale(…)`）。
 *      测死代码 = 假绿，比红更危险。
 *
 * 因此重写为：**从生产脚本里抽出真实判定块，在受控变量下执行**。
 * 测的是线上跑的那段代码本身，不是它的历史副本。
 *
 * ## 生产判定的四个条件（与 deploy-5-verify.sh 逐条对应）
 *   ① 非强制冷跑（`VERIFY_FORCE_PROBE != 1`）且有 stamp 文件
 *   ② 全绿门 `deploy_ok == 1`（半绿部署绝不复用）
 *   ③ 同包根 `pkg == $PKG`
 *   ④ 日志目录存在（否则复用后探针读空 ⇒ 假 FAIL）
 *   ⑤ 时效窗 `age <= PROBE_FRESH_BUDGET_S`（生产判据 `-gt`，临界含等号侧复用）
 *
 * 运行（只跑本文件）：node --test tests/unit/p8-probe-fresh.test.js
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPTS = join(ROOT, 'deploy/skills/winvm-plugin-deploy/scripts');
const VERIFY = join(SCRIPTS, 'deploy-5-verify.sh');
const BASH = process.env.WINVM_BASH || '/data/storage/el1/bundle/libs/arm64/bash/bin/bash';

/**
 * 生产判定块的起止锚点。
 *
 * 起点不是 `REUSE=0;`，而是它上面的**变量定义行**（`STAMP=` / `FRESH=`）——
 * 判定块消费 `$STAMP` 与 `$FRESH`，只抽 `REUSE=` 之后会得到 unbound variable。
 * 起点取 `STAMP="` 那一行，把三行变量定义连同判定块一起纳入，才是**可独立执行的最小切片**。
 */
const BLOCK_START = 'STAMP="${VMDEPLOY_PROBE_STAMP:-';
const BLOCK_END = '── 5a/5b/5c 三探针 ──';

/**
 * 从生产脚本抽出「变量定义 + 判定块」。
 * 抽不到就**直接失败**，绝不 skip —— 静默跳过正是假绿的源头。
 */
function extractBlock() {
  assert.ok(
    existsSync(VERIFY),
    `生产脚本不存在，本测试无法验证真实逻辑：${VERIFY}\n` +
      '该路径由 deploy/skills/winvm-plugin-deploy 提供（技能仓挂载）。缺失时应修复挂载，而不是跳过测试。',
  );
  const src = readFileSync(VERIFY, 'utf8');
  const start = src.indexOf(BLOCK_START);
  assert.notEqual(start, -1, `生产脚本里找不到判定块起点：${BLOCK_START}`);
  const end = src.indexOf(BLOCK_END, start);
  assert.notEqual(end, -1, `生产脚本里找不到判定块终点：${BLOCK_END}`);
  const block = src.slice(start, end);
  assert.ok(block.length > 200, `抽出的判定块过短（${block.length} 字节），锚点可能已漂移`);
  // 切片必须自带这两项，否则说明锚点漂移（判定块会在 set -u 下炸 unbound variable）
  assert.match(block, /^STAMP=/, '切片应以 STAMP= 变量定义开头');
  assert.match(block, /\nFRESH=/, '切片必须包含 FRESH= 变量定义');
  assert.match(block, /REUSE=0; RREASON="no-stamp"/, '切片必须包含判定块主体');
  return block;
}

/** 把判定块 + 受控变量拼成可执行的 bash 片段 */
function buildHarness(block) {
  return [
    'set -u',
    'PKG="${__PKG}"', // PKG 由 deploy 链在外层设定，此处按调用方身份注入
    block,
    'printf "REUSE=%s\\nREASON=%s\\n" "$REUSE" "$RREASON"',
  ].join('\n');
}

/** 跑一次判定；env 注入变量组，返回 { reuse, reason } */
function run(env, block) {
  const script = buildHarness(block);
  const r = spawnSync(BASH, ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, HOME: '/nonexistent-home', ...env },
  });
  assert.equal(
    r.status,
    0,
    `判定块必须恒 exit 0（它是判定而非错误源）；实际 status=${r.status}\nstderr=${r.stderr}`,
  );
  const m = r.stdout.match(/REUSE=([01])/);
  assert.ok(m, 'stdout 必含 REUSE= 行：' + r.stdout);
  const rm = r.stdout.match(/REASON=(.*)/);
  return { reuse: m[1] === '1', reason: rm ? rm[1].trim() : '' };
}

const BLOCK = extractBlock();

/** 造一个 stamp 文件 + 配套 logd 目录（生产判定要求 logd 目录存在） */
function stamp(epochDelta, pkg = '/pkg/A', { deployOk = 1, logd = true, raw = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'p8-pf-'));
  const logdir = join(dir, 'logs');
  if (logd) mkdirSync(logdir, { recursive: true });
  const p = join(dir, 'stamp.txt');
  const now = Math.floor(Date.now() / 1000);
  writeFileSync(
    p,
    raw ?? `epoch=${now + epochDelta}\ndeploy_ok=${deployOk}\npkg=${pkg}\nlogd=${logdir}\n`,
  );
  return { dir, p, logdir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('p8 · 探针新鲜复用判定（守生产内联实现）', () => {
  test('① 五条件全满足 ⇒ REUSE=1，理由点名新鲜度', () => {
    const s = stamp(-100, '/pkg/A');
    const r = run({ VMDEPLOY_PROBE_STAMP: s.p, __PKG: '/pkg/A' }, BLOCK);
    assert.equal(r.reuse, true, r.reason);
    assert.match(r.reason, /fresh\(/, '复用理由须点名新鲜度');
    s.cleanup();
  });

  test('② 超窗 ⇒ REUSE=0，reason 点名 stale(…)', () => {
    const s = stamp(-1100, '/pkg/A');
    const r = run({ VMDEPLOY_PROBE_STAMP: s.p, __PKG: '/pkg/A' }, BLOCK);
    assert.equal(r.reuse, false, '超出默认 600s 窗必须冷跑');
    assert.match(r.reason, /^stale\(/, `reason 须点名 stale，实得：${r.reason}`);
    s.cleanup();
  });

  test('② 窗可配：PROBE_FRESH_BUDGET_S=60 时 100s 龄不复用；默认 600 时复用', () => {
    const s = stamp(-100, '/pkg/A');
    const narrow = run(
      { VMDEPLOY_PROBE_STAMP: s.p, __PKG: '/pkg/A', PROBE_FRESH_BUDGET_S: '60' },
      BLOCK,
    );
    assert.equal(narrow.reuse, false, '收窄到 60s 后 100s 龄必须不复用');
    const wide = run({ VMDEPLOY_PROBE_STAMP: s.p, __PKG: '/pkg/A' }, BLOCK);
    assert.equal(wide.reuse, true, '默认 600s 窗内应复用');
    s.cleanup();
  });

  test('② 边界：age == budget ⇒ 复用（生产判据 `-gt`，等号侧复用）—— 如实钉死生产语义', () => {
    // ★ 这条**不是**「应该保守」的期望值，而是生产代码 `[ … -gt "$FRESH" ]` 的真实行为：
    // age==budget 不进 stale 分支 ⇒ 复用。legacy 版曾用 `-ge`（临界判死），语义不同。
    // 若将来要改成保守（-ge），此条会红，逼人显式决策而不是悄悄漂移。
    const s = stamp(-600, '/pkg/A');
    const r = run({ VMDEPLOY_PROBE_STAMP: s.p, __PKG: '/pkg/A' }, BLOCK);
    assert.equal(
      r.reuse,
      true,
      `age==budget 时生产判 -gt ⇒ 复用；若已改为 -ge，请同步更新本断言。实得 reuse=${r.reuse} reason=${r.reason}`,
    );
    s.cleanup();
  });

  test('③ 包根不匹配（换版本重取包）⇒ REUSE=0，reason 点名 pkg-changed', () => {
    const s = stamp(-10, '/pkg/A');
    const r = run({ VMDEPLOY_PROBE_STAMP: s.p, __PKG: '/pkg/B' }, BLOCK);
    assert.equal(r.reuse, false);
    assert.match(r.reason, /pkg-changed/, `reason 须点名 pkg-changed，实得：${r.reason}`);
    s.cleanup();
  });

  test('④ 全绿门：deploy_ok≠1（半绿部署）⇒ REUSE=0', () => {
    // 原版单测**没覆盖**这条，但它是四条件里最危险的一道：
    // 探针过了而交付/矩阵/health 段 FAIL 时若复用，等于把半绿部署洗成通过。
    const s = stamp(-10, '/pkg/A', { deployOk: 0 });
    const r = run({ VMDEPLOY_PROBE_STAMP: s.p, __PKG: '/pkg/A' }, BLOCK);
    assert.equal(r.reuse, false, '半绿部署绝不复用');
    assert.match(r.reason, /deploy-not-green/, `reason 须点名 deploy-not-green，实得：${r.reason}`);
    s.cleanup();
  });

  test('⑤ 日志目录不存在 ⇒ REUSE=0（防"复用后三探针全 meter-missing"）', () => {
    const s = stamp(-10, '/pkg/A', { logd: false });
    const r = run({ VMDEPLOY_PROBE_STAMP: s.p, __PKG: '/pkg/A' }, BLOCK);
    assert.equal(r.reuse, false, '无日志目录时复用会让探针读空 ⇒ 假 FAIL');
    assert.match(r.reason, /no-logdir/, `reason 须点名 no-logdir，实得：${r.reason}`);
    s.cleanup();
  });

  test('① 强制冷跑：VERIFY_FORCE_PROBE=1 ⇒ 即便全条件满足也不复用', () => {
    const s = stamp(-10, '/pkg/A');
    const r = run(
      { VMDEPLOY_PROBE_STAMP: s.p, __PKG: '/pkg/A', VERIFY_FORCE_PROBE: '1' },
      BLOCK,
    );
    assert.equal(r.reuse, false, '强制冷跑必须压过一切复用条件');
    assert.match(
      r.reason,
      /no-stamp/,
      `被 force 拦下时走初始 no-stamp 分支（生产实现如此，非笔误），实得：${r.reason}`,
    );
    s.cleanup();
  });

  test('保守面：stamp 缺失 ⇒ REUSE=0（首跑/undeploy 后未重装态绝不假复用）', () => {
    const r = run({ VMDEPLOY_PROBE_STAMP: '/nonexistent/stamp.txt', __PKG: '/pkg/A' }, BLOCK);
    assert.equal(r.reuse, false);
    assert.match(r.reason, /no-stamp/);
  });

  test('保守面：epoch 缺失/为空 ⇒ 不复用（走 stale 分支）', () => {
    for (const raw of ['pkg=/pkg/A\n', 'epoch=\npkg=/pkg/A\n']) {
      const s = stamp(0, '/pkg/A', { raw: raw.replace('/pkg/A\n', '/pkg/A\nlogd=' + join(tmpdir(), 'nowhere') + '\n') });
      const r = run({ VMDEPLOY_PROBE_STAMP: s.p, __PKG: '/pkg/A' }, BLOCK);
      assert.equal(r.reuse, false, `case=${JSON.stringify(raw)} 应不复用，实得 reason=${r.reason}`);
      s.cleanup();
    }
  });

  test('⑥ 未来时钟（age<0，NTP 跳变）⇒ 生产复用 —— 如实钉死，不粉饰为保守', () => {
    // 生产用数值比较 `$((NOW - S_EPOCH)) -gt FRESH`；age 为负必然小于 FRESH ⇒ 复用。
    // 这是已知的**非保守**面：时钟回跳会让陈旧 stamp 被当成新鲜。
    // 本测试把它钉成「当前事实」，防有人误以为它是保守的；若修成保守，此条转红即提醒改测试。
    const s = stamp(500, '/pkg/A');
    const r = run({ VMDEPLOY_PROBE_STAMP: s.p, __PKG: '/pkg/A' }, BLOCK);
    assert.equal(
      r.reuse,
      true,
      `生产 -gt 语义下未来时钟会复用（已知非保守面）；若已修为保守，请更新本断言。实得 reason=${r.reason}`,
    );
    assert.match(r.reason, /fresh\(-[0-9]+s/, 'reason 显示负 age，是这个已知面的可观测指纹');
    s.cleanup();
  });

  test('健壮面：CRLF stamp（Windows 写回污染）⇒ 行解析仍正确，REUSE=1', () => {
    const s = stamp(-100, '/pkg/A');
    const now = Math.floor(Date.now() / 1000);
    const p = join(s.dir, 'stamp-crlf.txt');
    writeFileSync(p, `epoch=${now - 100}\r\ndeploy_ok=1\r\npkg=/pkg/A\r\nlogd=${s.logdir}\r\n`);
    const r = run({ VMDEPLOY_PROBE_STAMP: p, __PKG: '/pkg/A' }, BLOCK);
    assert.equal(
      r.reuse,
      true,
      `CRLF 不得破坏判定（pkg 比对残留 \\r 会假不匹配 ⇒ 退化为恒冷跑）；实得 reason=${r.reason}`,
    );
    s.cleanup();
  });

  test('防回潮：判定逻辑已内联，非 legacy 目录的脚本不得再调用 probe-fresh.sh', () => {
    // ★ 判据必须**剥注释后**只认实际调用。
    // 初版用 `grep -l "probe-fresh"`，结果命中了 deploy-5-verify.sh 里
    // 「单测 tests/unit/p8-probe-fresh.test.js 钉死该面」这句说明注释 ⇒ 假红。
    // 这是本项目反复出现的同一类坑（查子串 / 查次数 / 查注释），此处按纪律剥注释。
    const r = spawnSync(
      BASH,
      [
        '-c',
        `
        for f in $(find '${SCRIPTS}' -maxdepth 1 -name '*.sh' -type f); do
          # 剥掉整行注释与行尾注释，再看是否真的调用
          if sed -e 's/#.*$//' "$f" | grep -qE '(^|[|;&[:space:]/])probe-fresh(\\.sh)?([[:space:]]|$|\\))'; then
            echo "$f"
          fi
        done
        `,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(
      (r.stdout || '').trim(),
      '',
      `判定逻辑已内联进 deploy-5-verify.sh，不应再有脚本**调用** legacy/probe-fresh.sh：\n${r.stdout}`,
    );
  });
});
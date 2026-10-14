/**
 * QA-P0-2（体检 §2-QA-01 / §8-R2）· S-4 / A5 **装配点**源码守卫
 *
 * ## 为什么存在（体检原话）
 * `r19c-s4-policy-denied-audit.test.js` 是**纯函数测试**：它 `import { recordPolicyDeniedAudit }`
 * 后**直接调用**该函数，但**不断言 `server.ts` 仍然调用它**。A5 侧
 * `r19c-a5-approval-coordinator.test.js` 测的是 `VmApprovalCoordinator` 三者独立行为，
 * `server.ts` 里的 `endTask` 归属护栏同样不在被测对象内。
 * ⇒ 后果：重构删掉注入点（把 `void recordPolicyDeniedAudit(` 误删、挪到 `return` 之后、
 * 或 merge 解冲突丢块），1054 基线**照样全绿**，而 S-4 取证盲区**原样复活且无人知晓**。
 * 本文件把"已修复"这个结论本身变成可回归对象。手法沿用 `k5-replay.test.js:849`
 * 与 `r19c-kn1-e-shape.test.js` 的源码文本守卫（计数 + 切片，**不用行号**，防漂移）。
 *
 * ## QA-02 的教训：守卫不得"切片失败仍假绿"
 * 每条守卫切出的块都带**非空 + 长度下限**前置断言（`assert.ok(block.length > 200)`），
 * 把"匹配失败"与"匹配成功但行为错"分开，杜绝 `indexOf === -1` 型假绿。
 *
 * ## 变异自检（本文件自带，内存施加，零写盘）
 * 见文末 `describe('装配守卫 · 变异自检')`：对 server.ts / bridge.ts 的**文本副本**
 * 施加"删注入点 / 挪到 return 之后 / 反转归属条件 / 断线"四类变异，要求逐条变红；
 * 并要求**未变异的真实源码**判据为空。全程以 SHA-256 自证被读源码字节未变。
 *
 * 运行（只跑本文件，绝不整批）：
 *   node --test tests/unit/assembly-guard.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/* ============================ 只读源码（相对仓库根定位，不依赖 cwd） ============================ */

const REPO = join(import.meta.dirname, '..', '..');
const F = {
  SERVER: join(REPO, 'packages', 'vm-service', 'src', 'server.ts'),
  BRIDGE: join(REPO, 'packages', 'adapter-agent-workbuddy-llm', 'src', 'bridge.ts'),
  CONTRACTS_BRIDGE: join(REPO, 'packages', 'contracts', 'src', 'bridge.ts'),
  ENGINE: join(REPO, 'packages', 'core', 'src', 'policy', 'engine.ts'),
  CONTRACTS_CAP: join(REPO, 'packages', 'contracts', 'src', 'capability.ts'),
};
const SRC = Object.fromEntries(Object.entries(F).map(([k, p]) => [k, readFileSync(p, 'utf8')]));
/** 基线摘要：变异自检末尾据此自证磁盘源码字节未被改动 */
const HASH = Object.fromEntries(
  Object.entries(F).map(([k, p]) => [k, createHash('sha256').update(readFileSync(p)).digest('hex')]),
);

/** 从 `mark` 起按花括号配平切出完整块（含首尾大括号）；找不到即抛，绝不静默返回空串 */
function blockOf(src, mark, label) {
  const start = src.indexOf(mark);
  if (start === -1) throw new Error(`切片失败：${label} 里找不到锚点 [${mark}]`);
  const open = src.indexOf('{', start);
  assert.notEqual(open, -1, `切片失败：${label} 锚点后无左括号`);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`切片失败：${label} 花括号未配平（源码形态异常）`);
}

/** 全部出现位置的分块（用于"两处早退前注入"这类计数 + 逐块校验） */
function allBlocks(src, mark, label) {
  const out = [];
  let cursor = 0;
  for (;;) {
    const idx = src.indexOf(mark, cursor);
    if (idx === -1) return out;
    const blk = blockOf(src.slice(idx), mark, `${label} @${idx}`);
    out.push(blk);
    cursor = idx + blk.length;
  }
}

/* ============================ S-4 装配判据（纯函数，输入源码文本） ============================ */

/**
 * S-4 不变式：`server.ts` 中**每个** `if (!verdict.allowed)` 终态拒绝分支，
 * 都必须在**本分支最后一个 `return` 之前**调 `recordPolicyDeniedAudit(`，
 * 且全文件调用点**恰 6 处**——两个 `if (!verdict.allowed)` 块（executeCapability /
 * /mcp handler）各含审计注入，加批1 扩展的四处终态拒绝：handler (c) DELEGATION_REQUIRED 收口、
 * executeCapability provider 缺席早退（A2-1 收口①）、replay 暴露面复核（收口②）、
 * replay 能力未注册（收口③）。用计数与花括号切片表达，不锁行号。
 * @returns {string[]} 违规清单（空即合规）
 */
function auditS4(serverSrc) {
  const problems = [];
  const deniedBlocks = allBlocks(serverSrc, 'if (!verdict.allowed) {', 'S-4 拒绝分支');
  if (deniedBlocks.length !== 2) {
    problems.push(
      `策略拒绝分支应有 2 处（executeCapability 与 /mcp handler），实测 ${deniedBlocks.length} 处` +
        (deniedBlocks.length > 2 ? '（新增终态拒绝点 ⇒ 必须同步补注入并更新本守卫）' : '（有拒绝分支被吞掉）'),
    );
  }
  // 批1(c)+CL7(A2-1)：终态拒绝必入审计的 S-4 纪律扩展到四处新增拒绝点 ⇒ 计数 2→6
  // （两 allowed 块各 1 + handler (c) 1 + provider 缺席 1 + replay 两处 2）。
  // 本行守卫变更属受契约保护，登记 phase3-b1-notes §4。
  const callCount = (serverSrc.match(/void recordPolicyDeniedAudit\(/g) ?? []).length;
  if (callCount !== 6) {
    problems.push(
      `recordPolicyDeniedAudit 调用点应恰为 6 处（两 allowed 块 + 批1(c) 收口 + A2-1 三处早退），实测 ${callCount} 处` +
        (callCount > 6 ? '（新增注入点 ⇒ 请同步本守卫计数）' : '（注入点被删/被改成非 void 形式）'),
    );
  }
  if ((serverSrc.match(/recordPolicyDeniedAudit/g) ?? []).length < 2) {
    problems.push('recordPolicyDeniedAudit 在 server.ts 出现次数 < 2（import 与注入点至少各 1 次）');
  }
  // 装配的另一半：**来源必须是单一事实件**。只断言"被调用"不够——
  // 若 import 行被摘掉而在 server.ts 内复制一份同名函数（或改从别处导入），
  // 调用计数仍为 2，守卫会假绿（外部变异 X2 实测命中此缺口，故补齐）。
  const imported = /import\s*\{[^}]*\brecordPolicyDeniedAudit\b[^}]*\}\s*from\s*'\.\/approval-replay\.js'/s.test(
    serverSrc,
  );
  if (!imported) {
    problems.push("server.ts 不再从 './approval-replay.js' 导入 recordPolicyDeniedAudit（S-4 装配来源断开）");
  }
  if (/function recordPolicyDeniedAudit\s*\(/.test(serverSrc)) {
    problems.push('server.ts 内复制出第二份 recordPolicyDeniedAudit（违反单一事实来源，dist 与 src 会漂移）');
  }
  deniedBlocks.forEach((blk, i) => {
    // QA-02：切片非空 + 长度下限，防"锚点在但块被掏空"假绿
    if (blk.length < 200) problems.push(`S-4 拒绝分支 #${i + 1} 切片过短（${blk.length} 字节），锚点已漂移`);
    const callAt = blk.indexOf('recordPolicyDeniedAudit(');
    if (callAt === -1) {
      problems.push(`S-4 拒绝分支 #${i + 1} 内没有 recordPolicyDeniedAudit 调用（取证盲区将复活）`);
      return;
    }
    const lastReturn = blk.lastIndexOf('return');
    if (lastReturn !== -1 && callAt > lastReturn) {
      problems.push(`S-4 拒绝分支 #${i + 1} 的审计调用位于 return 之后（不可达，等于没写）`);
    }
  });
  // 两处调用的 channel 口径（S-4 修复的取证归因语义）
  const chanCount = (serverSrc.match(/void recordPolicyDeniedAudit\([\s\S]{0,700}?\bchannel:/g) ?? []).length;
  if (chanCount < 2) problems.push(`两处 recordPolicyDeniedAudit 调用都应带 channel 归因，实测 ${chanCount} 处`);
  return problems;
}

/* ============================ A5 装配判据（纯函数，输入源码文本） ============================ */

/**
 * A5（服务级单例 `activeTaskId` 被上一次委派收尾清掉）修复的四个装配点，
 * 标识符**全部取自源码实名**（`:190-201` / `:206` / `:214` / `:403` / `:1052` / bridge `:807-813`）：
 *   ① `endTask` 归属护栏：`taskId !== this.activeTaskId` 时**保持不动**（不误清他人活动任务）；
 *   ② `raise` 归属优先取请求 taskId，缺席回退单例：`req.taskId ?? this.activeTaskId`；
 *   ③ 无挂接任务时**必须留痕**（根因 §6.4 点名"零日志"）：`reason: 'no-active-task'` 的 warn；
 *   ④ 服务侧接线齐备：`setLogger(logger)` 注入 + `bind(a2a.tasks, pendingApprovals)`；
 *   ⑤ 调用方（桥）必须**按归属**收尾：`endTask(input.taskId ?? '')`，且 begin/end 成对。
 * @returns {string[]} 违规清单（空即合规）
 */
function auditA5(serverSrc, bridgeSrc) {
  const problems = [];
  const endTaskBody = blockOf(serverSrc, 'endTask(taskId?: string): void {', 'A5 endTask');
  if (endTaskBody.length < 100) problems.push(`A5 endTask 切片过短（${endTaskBody.length} 字节），锚点已漂移`);
  if (!/if \(taskId !== this\.activeTaskId\) return;/.test(endTaskBody)) {
    problems.push('A5 P1-Fix 归属护栏丢失：endTask 内缺 `if (taskId !== this.activeTaskId) return;`');
  }
  if (!/if \(!taskId\) \{[\s\S]{0,120}?this\.activeTaskId = undefined;[\s\S]{0,60}?return;/.test(endTaskBody)) {
    problems.push('A5 兼容语义丢失：endTask 的「taskId 缺席 ⇒ 无条件清空」早退被改写');
  }
  const raiseBody = blockOf(serverSrc, 'async raise(req: ApprovalRequest): Promise<ApprovalOutcome> {', 'A5 raise');
  if (raiseBody.length < 200) problems.push(`A5 raise 切片过短（${raiseBody.length} 字节），锚点已漂移`);
  if (!/const taskId = req\.taskId \?\? this\.activeTaskId;/.test(raiseBody)) {
    problems.push('A5 归属优先级丢失：raise 未先取 req.taskId 再回退单例 activeTaskId');
  }
  if (!/reason: 'no-active-task'/.test(raiseBody)) {
    problems.push('A5 可观测性丢失：raise 的 no-active-task 早退不再有 reason 字段（零日志复发）');
  }
  if (!/this\.logger\?\.warn\([\s\S]{0,400}?reason: 'no-active-task'/.test(raiseBody)) {
    problems.push('A5 可观测性丢失：no-active-task 早退未走 logger.warn（只是返回值，仍无痕）');
  }
  if (!/approvalCoordinator\.setLogger\(logger\);/.test(serverSrc)) {
    problems.push('A5 装配点丢失：createService 未给协调器注入 logger（warn 恒为可选空操作）');
  }
  if (!/approvalCoordinator\.bind\(a2a\.tasks, pendingApprovals\);/.test(serverSrc)) {
    problems.push('A5 装配点丢失：协调器未 bind 任务存储与令牌表（raise 必走 no-active-task）');
  }
  // 调用方按归属收尾（Fix-1A）：零参 endTask() 会让归属护栏形同虚设
  if (!/this\.coordinator\?\.endTask\(input\.taskId \?\? ''\)/.test(bridgeSrc)) {
    problems.push('A5 调用方装配丢失：bridge.runGoal 的 endTask 不再传 taskId（归属护栏被旁路）');
  }
  if (!/this\.coordinator\?\.beginTask\(input\.taskId \?\? ''\)/.test(bridgeSrc)) {
    problems.push('A5 调用方装配丢失：bridge.runGoal 缺 beginTask（协调器无从挂接活动委派）');
  }
  return problems;
}

/* ============================ 正向守卫 ============================ */

describe('S-4 装配点守卫 · 策略硬拒绝审计注入点仍在位', () => {
  test('server.ts 引用并调用 recordPolicyDeniedAudit ≥2 次（注入点未被删）', () => {
    assert.ok(
      (SRC.SERVER.match(/recordPolicyDeniedAudit/g) ?? []).length >= 2,
      'server.ts 里 recordPolicyDeniedAudit 出现次数 < 2 —— S-4 修复已从装配层消失',
    );
  });

  test('两处 `if (!verdict.allowed)` 拒绝分支均在 return 前写审计（S-4 语义锁定）', () => {
    assert.deepEqual(auditS4(SRC.SERVER), [], 'S-4 装配点守卫');
  });

  test('拒绝分支仍保留 S-4 的 best-effort 纪律（void 调用，审计写失败不改拒绝语义）', () => {
    assert.match(
      SRC.SERVER,
      /void recordPolicyDeniedAudit\(/,
      'S-4 注入必须是 `void`（审计失败绝不影响拒绝结果）—— 现被改成 await/取返回值，语义已变',
    );
  });
});

describe('A5 装配点守卫 · 协调器归属护栏与接线仍在位', () => {
  test('endTask 归属护栏 + raise 归属优先 + no-active-task 留痕 + 服务侧接线 + 调用方传 taskId', () => {
    assert.deepEqual(auditA5(SRC.SERVER, SRC.BRIDGE), [], 'A5 装配点守卫');
  });

  test('契约侧 endTask 仍为可选 taskId 形参（调用方传归属值的类型前提）', () => {
    assert.match(
      SRC.CONTRACTS_BRIDGE,
      /endTask\(taskId\?: string\): void;/,
      'contracts/bridge.ts 的 endTask 签名漂移 ⇒ server 端归属护栏失去契约支撑',
    );
    assert.match(
      SRC.CONTRACTS_BRIDGE,
      /beginTask\(taskId: string\): void;/,
      'contracts/bridge.ts 的 beginTask 签名漂移',
    );
  });
});

/* ============================ dry-run 契约软探针（任务 #1 并行，缺席即 skip） ============================ */

describe('dry-run 免审批收紧 · 公开契约软探针', () => {
  /**
   * **软探针**：任务 #1（engine.ts 批，U-P0-1/U-P0-3）由工程师并行落地。
   * 本探针只认"稳定的公开契约"，不认任何行号或实现细节（会漂移）：
   *   判据 = `engine.ts` 的 `allow:dry-run-bypass` 是否已不再是无条件放行。
   *   未落地 ⇒ `t.skip()`（**不红**），把复核点留给主理人收口；已落地 ⇒ 硬断言契约字段存在。
   * TODO(主理人收口复核)：任务 #1 合入后，本探针应转为**必跑硬断言**（去掉 skip 分支）。
   */
  test('若 dry-run bypass 已收紧，则能力契约必须声明 dry-run 支持位', (t) => {
    const bypassBlock = blockOf(SRC.ENGINE, "if (req.params['dryRun'] === true) {", 'dry-run bypass');
    const unconditional = /return \{ allowed: true, matchedRule: 'allow:dry-run-bypass'/.test(bypassBlock);
    const tightened =
      !unconditional ||
      /supportsDryRun|hasDryRunParam|dryRunSupported|capabilityDeclaresDryRun/.test(bypassBlock);
    if (!tightened) {
      // 体检 §2-QA-11 现状：放行条件仍无能力侧限定 ⇒ 任务 #1 尚未落地，按软探针跳过
      t.skip('QA-P0-1（U-P0-3）尚未落地：allow:dry-run-bypass 仍无条件放行，契约字段无从断言');
      return;
    }
    // 已落地：断言"能力声明 dry-run"这一事实有稳定契约载体（三处任一即可，避免锁实现细节）
    const declared =
      /supportsDryRun/.test(SRC.CONTRACTS_CAP) ||
      /dryRun/.test(SRC.CONTRACTS_CAP) ||
      /hasDryRunParam/.test(SRC.ENGINE);
    assert.ok(
      declared,
      'dry-run 放行已收紧但契约层无 dry-run 支持位载体（新能力将默认继承/默认失去 bypass 而无人察觉）',
    );
  });
});

/* ============================ 变异自检：证明"装配点被删时会红" ============================ */

describe('装配守卫 · 变异自检（内存副本，零写盘）', () => {
  /**
   * 变异锚点一律**格式无关**：按 `void recordPolicyDeniedAudit(` 出现序位 +
   * 括号配平定位整条调用语句，而不是匹配多行字面量。
   * （外部变异 X7 曾证明：只把参数换行合并、语义完全不变，字面量锚点即失效，
   *   变异用例会因"变异未生效"而误红 —— 锚点脆 = 守卫也会跟着脆。）
   */
  const callStatement = (src, needle, occurrence) => {
    let idx = -1;
    for (let n = 0; n <= occurrence; n += 1) {
      idx = src.indexOf(needle, idx + 1);
      assert.notEqual(idx, -1, `变异锚点不足（需第 ${occurrence + 1} 处 ${needle}）`);
    }
    const openParen = src.indexOf('(', idx);
    let depth = 0;
    let i = openParen;
    for (; i < src.length; i += 1) {
      if (src[i] === '(') depth += 1;
      else if (src[i] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const semi = src.indexOf(';', i);
    assert.notEqual(semi, -1, '变异锚点：调用语句无结束分号');
    // 连同本行行首缩进一起吃掉，保持文本合法
    const lineStart = src.lastIndexOf('\n', idx) + 1;
    return { start: lineStart, end: semi + 1, text: src.slice(lineStart, semi + 1) };
  };

  const dropCall = (occurrence) => (s) => {
    const { start, end, text } = callStatement(s, 'void recordPolicyDeniedAudit(', occurrence);
    return s.slice(0, start) + s.slice(end);
  };

  const relocateCallAfterReturn = (occurrence) => (s) => {
    const { start, end, text } = callStatement(s, 'void recordPolicyDeniedAudit(', occurrence);
    const without = s.slice(0, start) + s.slice(end);
    // 插入到紧随其后的那条 return 语句之后（模拟"注入点被挪到 return 之后"）
    const retIdx = without.indexOf('return', start);
    assert.notEqual(retIdx, -1, '变异锚点：找不到 return');
    const semi = without.indexOf(';', retIdx);
    return without.slice(0, semi + 1) + '\n' + text + without.slice(semi + 1);
  };

  const MUTATIONS = [
    {
      label: 'S4-m1 删掉 executeCapability 内的审计调用（体检点名的"重构误删"）',
      target: 'SERVER',
      apply: dropCall(0),
      expect: 's4',
    },
    {
      label: 'S4-m1b 删掉 /mcp handler 的 (c) DELEGATION_REQUIRED 收口审计调用 ⇒ 守卫变红',
      target: 'SERVER',
      // 全文调用序位 4 = handler (c) 收口注入（两 allowed 块序位 0/5 之外的批1 新增拒绝点）
      apply: dropCall(4),
      expect: 's4',
    },
    {
      label: 'S4-m2 把第一处审计挪到 return 之后（可达性丢失，行为等于没写）',
      target: 'SERVER',
      apply: relocateCallAfterReturn(0),
      expect: 's4',
    },
    {
      label: 'S4-m3 审计调用去掉 void 改 await（拒绝语义被审计失败牵连，纪律被改写）',
      target: 'SERVER',
      apply: (s) => s.replace(/void recordPolicyDeniedAudit\(/g, 'await recordPolicyDeniedAudit('),
      expect: 's4',
    },
    {
      label: 'S4-m4 从 import 摘掉 recordPolicyDeniedAudit（装配来源断开）',
      target: 'SERVER',
      apply: (s) => s.replace('  recordPolicyDeniedAudit,\n', ''),
      expect: 's4',
    },
    {
      label: 'S4-m5 在 server.ts 内复制一份同名函数（违反单一事实来源）',
      target: 'SERVER',
      apply: (s) => s.replace(
        'export class VmApprovalCoordinator implements ApprovalCoordinator {',
        'function recordPolicyDeniedAudit() {\n  return undefined;\n}\n\nexport class VmApprovalCoordinator implements ApprovalCoordinator {',
      ),
      expect: 's4',
    },
    {
      label: 'A5-m1 endTask 归属条件被删（回到"无条件清空"，A5 缺陷原样复活）',
      target: 'SERVER',
      apply: (s) => s.replace('    if (taskId !== this.activeTaskId) return;\n', ''),
      expect: 'a5',
    },
    {
      label: 'A5-m2 endTask 归属条件被反转（`===` 才 return ⇒ 正常收尾反而不清）',
      target: 'SERVER',
      apply: (s) =>
        s.replace('if (taskId !== this.activeTaskId) return;', 'if (taskId === this.activeTaskId) return;'),
      expect: 'a5',
    },
    {
      label: 'A5-m3 raise 丢掉 req.taskId 优先（退回服务级单例，交叠场景再次误判）',
      target: 'SERVER',
      apply: (s) => s.replace('const taskId = req.taskId ?? this.activeTaskId;', 'const taskId = this.activeTaskId;'),
      expect: 'a5',
    },
    {
      label: 'A5-m4 协调器 logger 注入断线（warn 恒空操作，可观测性归零）',
      target: 'SERVER',
      apply: (s) => s.replace('  approvalCoordinator.setLogger(logger);\n', ''),
      expect: 'a5',
    },
    {
      label: 'A5-m5 bind 断线（tasks 永缺席 ⇒ 所有审批走 no-active-task 丢弃）',
      target: 'SERVER',
      apply: (s) => s.replace('  approvalCoordinator.bind(a2a.tasks, pendingApprovals);\n', ''),
      expect: 'a5',
    },
    {
      label: 'A5-m6 调用方 endTask 退回零参（归属护栏被旁路）',
      target: 'BRIDGE',
      apply: (s) => s.replace("this.coordinator?.endTask(input.taskId ?? '')", 'this.coordinator?.endTask()'),
      expect: 'a5',
    },
    {
      label: 'A5-m7 调用方 beginTask 断线（协调器无从挂接活动委派）',
      target: 'BRIDGE',
      apply: (s) => s.replace("this.coordinator?.beginTask(input.taskId ?? '');\n", ''),
      expect: 'a5',
    },
    {
      label: 'A5-m8 raise 的 no-active-task 早退去掉 logger.warn（零日志复发）',
      target: 'SERVER',
      apply: (s) =>
        s.replace('      this.logger?.warn(\'审批协调器：无挂接任务，审批请求被丢弃（任务不会挂起 input-required）\', {', '      void {'),
      expect: 'a5',
    },
    {
      label: 'M9 假阳性探针（纯格式化等价改写，语义不变）',
      target: 'SERVER',
      // 格式无关：在调用左括号后补一个空格。字节变化必然生效，但任何判据都不该因此变红。
      apply: (s) => {
        const { start, end, text } = callStatement(s, 'void recordPolicyDeniedAudit(', 0);
        return s.slice(0, start) + text.replace('recordPolicyDeniedAudit(', 'recordPolicyDeniedAudit( ') + s.slice(end);
      },
      expect: 'none',
    },
    {
      label: 'M10 假阳性探针（注释增删，语义不变）',
      target: 'SERVER',
      apply: (s) => s.replace(
        '  endTask(taskId?: string): void {',
        '  endTask(taskId?: string): void {\n    // 仅追加注释，行为完全不变',
      ),
      expect: 'none',
    },
  ];

  const run = (target, mutatedSrc) => {
    const server = target === 'SERVER' ? mutatedSrc : SRC.SERVER;
    const bridge = target === 'BRIDGE' ? mutatedSrc : SRC.BRIDGE;
    return { s4: safe(() => auditS4(server)), a5: safe(() => auditA5(server, bridge)) };
  };

  for (const m of MUTATIONS) {
    test(`${m.label} ⇒ ${m.expect === 'none' ? '守卫必须仍绿' : '守卫必须变红'}`, () => {
      const mutated = m.apply(SRC[m.target]);
      assert.notEqual(mutated, SRC[m.target], `${m.label}：变异未生效（锚点已漂移，本变异用例失效）`);
      const { s4, a5 } = run(m.target, mutated);
      const s4Red = s4.threw || s4.err.length > 0;
      const a5Red = a5.threw || a5.err.length > 0;
      if (m.expect === 's4') {
        assert.ok(s4Red, 'S-4 守卫对变异无感（守卫是装饰品）');
      } else if (m.expect === 'a5') {
        assert.ok(a5Red, 'A5 守卫对变异无感（守卫是装饰品）');
      } else {
        assert.equal(s4Red, false, `等价改写不应触发 S-4 判据：${s4.err.join(' / ') || s4.message}`);
        assert.equal(a5Red, false, `等价改写不应触发 A5 判据：${a5.err.join(' / ') || a5.message}`);
      }
    });
  }

  test('正向自证：真实源码上两条判据均为空（且上述变异确实只因源码被改而红）', () => {
    assert.deepEqual(auditS4(SRC.SERVER), []);
    assert.deepEqual(auditA5(SRC.SERVER, SRC.BRIDGE), []);
  });

  test('只读自证：被守卫源码磁盘字节与进入本文件时一致（变异全在内存）', () => {
    for (const [k, p] of Object.entries(F)) {
      assert.equal(
        createHash('sha256').update(readFileSync(p)).digest('hex'),
        HASH[k],
        `${k}: 磁盘源码字节在本测试执行期间发生变化（违反只读纪律）`,
      );
    }
  });
});

/** 判据函数允许抛（切片失败即红），统一收敛成 {err|threw} 便于变异断言 */
function safe(fn) {
  try {
    return { err: fn(), threw: false };
  } catch (e) {
    return { err: [], threw: true, message: e.message };
  }
}

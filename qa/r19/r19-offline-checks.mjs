// R19-B 权威报告的离线复核脚本（QA 验证-only；不触碰 VM，仅读已入库的审计快照与委派证据）
// 用途：复现报告 §5 K-N1 更正、S-4 登记、OBS-B 计数、E4 审计反查 的全部数字口径。
// 运行：cd <repo>/qa/r19 && node r19-offline-checks.mjs
import { readFileSync } from 'node:fs';

const AUDIT = new URL('./e4g-audit-full.jsonl', import.meta.url).pathname;
const rows = readFileSync(AUDIT, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const line = (s) => console.log(s);

line(`审计快照条目总数: ${rows.length} (应为 181)`);

// 1) principal.channel 分布 —— 报告称"恒为 mcp，181/181，无 a2a"
const ch = {};
for (const j of rows) ch[j.principal.channel] = (ch[j.principal.channel] || 0) + 1;
line(`1) channel 分布: ${JSON.stringify(ch)}`);

// 2) appops.workflow.run 作为 capabilityId 出现次数 —— 报告称 0
line(`2) appops.workflow.run 条目数: ${rows.filter((j) => j.capabilityId === 'appops.workflow.run').length}`);

// 3) matchedRule 与 errorCode 分布 —— S-4 的核心数字
const rule = {}, code = {};
for (const j of rows) {
  const k = j.policyDecision.matchedRule;
  rule[k] = (rule[k] || 0) + 1;
  if (j.result.errorCode) code[j.result.errorCode] = (code[j.result.errorCode] || 0) + 1;
}
line(`3) matchedRule 分布: ${JSON.stringify(rule)}`);
line(`   errorCode 分布:   ${JSON.stringify(code)}  ← POLICY_DENIED 计 0（S-4）`);

// 4) 被拒请求 traceId 反查（报告逐个列过）
const traces = new Set(rows.map((j) => j.traceId));
for (const [name, t] of Object.entries({
  'e2-msi-verify': 'tr_muq4cdrb_166',
  'e1-post-dir': 'tr_munyknsf_31',
  'e1-post-reg': 'tr_munyl4yf_33',
  'e1-post-dirtest': 'tr_munyl652_34',
  'e4b-audit-dir(INVALID_PARAMS,对照组)': 'tr_muqc8ts9_167',
})) line(`4) ${name} ${t} 在链上命中: ${traces.has(t) ? 'YES' : 'NO'}`);

// 5) 99997 字符串匹配（报告：3 条，其中 uninstall 仅 2 条且均 MCP 直调）
const hit = rows.filter((j) => JSON.stringify(j).includes('99997'));
line(`5) 99997 匹配: ${hit.length} 条 → ${hit.map((j) => `seq${j.seq}(${j.capabilityId})`).join(', ')}`);

// 6) EXECUTION_FAILED 计数（报告 OBS-B：共 4 条 = 3 心跳型 + 1 超时型）
const ef = rows.filter((j) => j.result.errorCode === 'EXECUTION_FAILED');
line(`6) EXECUTION_FAILED: ${ef.length} 条`);
for (const j of ef) {
  const kind = (j.result.summary || '').includes('45000ms') ? '心跳型' : '超时型';
  line(`   seq${j.seq} ${j.ts} ${j.capabilityId} dur=${j.durationMs} [${kind}] ${(j.result.summary || '').slice(0, 60)}`);
}

// 7) K-N1 正对照：委派内层调用确实在链上（token 与两份委派 task 文件串链）
const tok = (t) => rows.filter((j) => (j.approval || {}).approvalId === t);
line(`7) 正对照 seq20/21 (token apr_1550b79f6ad34014900e, 见于 e5-a2a-final-task.json): ${tok('apr_1550b79f6ad34014900e').map((j) => `seq${j.seq}/${j.capabilityId}`).join(',')}`);
line(`   正对照 seq149  (token apr_ff3b4e10a67949b3a1c3, 见于 e1r2-final-task.json):      ${tok('apr_ff3b4e10a67949b3a1c3').map((j) => `seq${j.seq}/${j.capabilityId}`).join(',')}`);

// 8) 委派窗口审计空档（报告：e4b-fail 02:17Z 落入 seq165→seq166 空档）
const s165 = rows.find((j) => j.seq === 165), s166 = rows.find((j) => j.seq === 166);
line(`8) seq165 ${s165.ts} → seq166 ${s166.ts} 空档 = ${Math.round((Date.parse(s166.ts) - Date.parse(s165.ts)) / 60000)} 分钟 (e4b-fail t0=2026-10-02T02:17:39Z 落于其中)`);

// 9) E1/E5 关键 seq 锚点
line(`9) 关键锚点: ` + [23, 149, 156, 157, 165].map((s) => {
  const j = rows.find((x) => x.seq === s);
  return j ? `seq${s}=${j.traceId}/dur${j.durationMs}` : `seq${s}=MISSING`;
}).join(' '));

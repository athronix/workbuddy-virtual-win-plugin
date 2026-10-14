/**
 * Phase 3 · 批6 A2-17（ARCH-09 补建，用户终裁 A）：预览↔执行哈希绑定。
 *
 * 三个判别面：
 *  1. **双端同源钉**：宿主记录侧（host-a2a-bridge/approval-audit re-export）与 VM 绑定侧
 *     （vm-service/server.ts import @winvm/core）用的是**同一个函数引用**——两份实现=漂移
 *     风险（A2-10 教训同款），re-export 形态必须被钉住。
 *  2. **哈希敏感性**（绑定判据的语义本体）：非凭据参数任何一项变化 ⇒ hash 翻转（路径/包名/
 *     dryRun/impact）；键序无关；**凭据值变化不改 hash**（设计边界：审批卡从未展示凭据明文，
 *     宿主批准的是"该能力+该非凭据参数形态+该预览"）——双向都钉。
 *  3. **接线形态守卫**（k5-replay E 组同范式，不起服务不 spawn ps-bridge）：/mcp 放行闸
 *     在 policy.evaluate **之前**比对、不等即 approved=false（fail-closed）、token 创建点
 *     必带 previewHash（从 preview+impact 派生）。
 *
 * 真机端到端（批准→换参续跑被拒→重审通过）列入 V15（notes 真机清单），本件覆盖离线可证面。
 * 纪律：严禁被守卫白名单钉的字段名字样；纯 stdlib+dist import。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = (p) => 'file:///' + join(ROOT, p).replace(/\\/g, '/').replace(/^\//, '');

const core = await import(dist('packages/core/dist/index.js'));
const host = await import(dist('packages/host-a2a-bridge/dist/index.js'));
const auditChain = await import(dist('packages/core/dist/audit/chain.js'));

const { hashApprovalPreview, canonicalApprovalJson } = core;

describe('A2-17 · 双端同源钉（单源权威=re-export，非第二份实现）', () => {
  test('host hashApprovalPreview 与 core 是同一函数引用', () => {
    assert.equal(host.hashApprovalPreview, core.hashApprovalPreview,
      '宿主记录侧必须用 core 权威实现（两份拷贝=预览≠执行绑定的第一号漂移风险）');
  });

  test('host canonicalJson（对外 API 名）与 core canonicalApprovalJson 同一实现', () => {
    assert.equal(host.canonicalJson, core.canonicalApprovalJson);
  });

  test('审批哈希用**凭据剔除**版 canonical，与审计链 canonicalJson（无剔除）语义分立', () => {
    // 审计链版保留凭据键（链要如实记账）；审批版剔除（F5 红线 + 批准语义不含凭据值）。
    const withCred = { a: 1, token: 'SECRET' };
    assert.match(auditChain.canonicalJson(withCred), /SECRET/, '审计链版不得剔除（记账如实）');
    assert.doesNotMatch(canonicalApprovalJson(withCred), /SECRET/, '审批版必须剔除（凭据永不进哈希）');
    // 两版同为键序稳定
    assert.equal(canonicalApprovalJson({ b: 2, a: 1 }), canonicalApprovalJson({ a: 1, b: 2 }));
  });
});

describe('A2-17 · 哈希敏感性（绑定判据语义双向钉）', () => {
  const base = {
    capabilityId: 'app.winget.uninstall',
    risk: 'L2',
    preview: { capabilityId: 'app.winget.uninstall', params: { packageId: 'WXWork', dryRun: false } },
    impact: ['packageId=WXWork'],
  };

  test('同输入恒等（确定性基座）', () => {
    assert.equal(hashApprovalPreview(base), hashApprovalPreview(structuredClone(base)));
  });

  test('键序无关', () => {
    const reordered = {
      risk: 'L2',
      impact: ['packageId=WXWork'],
      preview: { params: { dryRun: false, packageId: 'WXWork' }, capabilityId: 'app.winget.uninstall' },
      capabilityId: 'app.winget.uninstall',
    };
    assert.equal(hashApprovalPreview(reordered), hashApprovalPreview(base));
  });

  test('非凭据参数变化 ⇒ hash 翻转（换包名 / 翻 dryRun / 换 impact）', () => {
    const h0 = hashApprovalPreview(base);
    const swapPkg = structuredClone(base);
    swapPkg.preview.params.packageId = 'Weixin';
    assert.notEqual(hashApprovalPreview(swapPkg), h0, '换卸载目标必须被视为**另一件事**（重审）');

    const flipDry = structuredClone(base);
    flipDry.preview.params.dryRun = true;
    assert.notEqual(hashApprovalPreview(flipDry), h0, 'dryRun 翻转改变执行语义 ⇒ 重审');

    const dropImpact = { ...base, impact: [] };
    assert.notEqual(hashApprovalPreview(dropImpact), h0, 'impact 清单变化 ⇒ 重审');
  });

  test('凭据值变化不改 hash（设计边界的显式钉：批准对象不含凭据明文）', () => {
    const withCred = structuredClone(base);
    withCred.preview.params.password = 'PW-1';
    const other = structuredClone(withCred);
    other.preview.params.password = 'PW-2';
    assert.equal(hashApprovalPreview(withCred), hashApprovalPreview(other),
      '凭据键在 canonicalize 阶段剔除 ⇒ 批准语义=对非凭据形态的授权（notes 设计判断在册）');
    // 但**新增/删除**凭据键本身不改结构哈希（键都没了）——同分支自洽
    const noCred = structuredClone(base);
    assert.equal(hashApprovalPreview(withCred), hashApprovalPreview(noCred),
      '带凭据键与不带（键被剔除后同形）⇒ 同 hash，与上一断言同语义');
  });
});

describe('A2-17 · 接线形态守卫（server.ts 源码面，k5-replay E 组同范式）', () => {
  const src = readFileSync(join(ROOT, 'packages/vm-service/src/server.ts'), 'utf8');

  test('token 唯一创建点带 previewHash（派生自 preview+impact 同源输入）', () => {
    const i = src.indexOf('pendingApprovals.set(id, {');
    assert.ok(i >= 0, 'token 创建点在场');
    const block = src.slice(i, i + 1600);
    assert.match(block, /previewHash: hashApprovalPreview\(/, '创建点必须算并留存 hash');
    assert.match(block, /preview,/s, 'hash 输入含 preview（与留存 preview 同变量⇒构造一致）');
    assert.match(block, /impact,/s, 'hash 输入含 impact');
  });

  test('放行闸在 policy.evaluate **之前**比对；不等即 approved=false（fail-closed）', () => {
    // 顺序钉：拒绑赋值（approved=false）必须出现在**紧随其后的** policy.evaluate 之前
    // —— approved 进 evaluate 前已被降级 ⇒ 换参续跑落 requiresApproval 拦截分支。
    const rejectIdx = src.indexOf('approved = false; // 预览已非批准时那份');
    // 批1 同步（受契约保护变更）：evaluate 调用收拢为 evaluateScoped（单点灰度三态），
    // 顺序钉语义不变——拒绑赋值仍必须早于紧随其后的策略评估。
    const evalIdx = src.indexOf('const verdict = evaluateScoped(', rejectIdx);
    assert.ok(rejectIdx > 0 && evalIdx > rejectIdx,
      `顺序钉：拒绑(${rejectIdx})必须早于其 evaluate(${evalIdx})`);
    assert.ok(src.indexOf('ARCH-09 预览绑定校验失败') > 0, '绑定校验告警在场（可 grep 归因）');
    assert.match(src, /let approved = approvalId !== undefined && pendingApprovals\.get\(approvalId\)\?\.hostApproved === true;/,
      'K4 原判据保留（hostApproved 仍是放行前提），绑定是在其**之上**的附加闸');
  });

  test('缺合法 hash 亦拒（fail-closed 三态：不等/缺失都拒，无静默放行分支）', () => {
    assert.match(src, /tok\.previewHash\.length === 64\s*\n?\s*\?\s*tok\.previewHash\s*\n?\s*:\s*''/,
      'storedHash 三态：合法 64-hex 才采用，否则空串（与任何重算 hash 不等⇒拒）');
  });

  test('PendingApproval 契约含 previewHash 必填（纯附加字段，构造点=唯一创建点已钉）', () => {
    assert.match(src, /readonly previewHash: string;/);
  });
});

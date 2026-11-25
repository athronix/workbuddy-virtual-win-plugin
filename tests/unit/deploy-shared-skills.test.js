/**
 * 共享 Skills 部署「规划层」单元测试（纯函数，不创建真实 junction）
 *
 * 覆盖 ADR-14 的两段式规划：发布（repo→共享根）与链接（共享根→各 Agent 目录）。
 * apply* / publish* 的副作用由 install-vm 的 dry-run 路径在部署期校验，此处仅验证决策正确性。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { planSharedSkillLinks, planSkillPublish, norm, HOST_ONLY_SKILLS } from '../../delivery/deploy-shared-skills.mjs';

const SRC = 'C:/WinVMBridge/shared-skills';

describe('planSharedSkillLinks', () => {
  const skills = ['winvm-orchestrator', 'winvm-app-operation'];

  test('Agent 目录存在且技能缺失 → create', () => {
    const { actions, summary } = planSharedSkillLinks({
      sourceDir: SRC,
      skills,
      targets: [{ id: 'workbuddy', dir: 'C:/Users/me/.workbuddy/skills', entries: [] }],
    });
    assert.equal(summary.create, 2);
    for (const a of actions) assert.equal(a.action, 'create');
  });

  test('已是指向共享源的 symlink → skip-ok', () => {
    const { actions, summary } = planSharedSkillLinks({
      sourceDir: SRC,
      skills,
      targets: [
        {
          id: 'workbuddy',
          dir: 'C:/Users/me/.workbuddy/skills',
          entries: [
            { name: 'winvm-orchestrator', isSymlink: true, linkTarget: `${SRC}/winvm-orchestrator` },
            { name: 'winvm-app-operation', isSymlink: true, linkTarget: `${SRC}/winvm-app-operation` },
          ],
        },
      ],
    });
    assert.equal(summary.skipOk, 2);
  });

  test('已存在同名真实目录 → skip-conflict（绝不覆盖用户技能）', () => {
    const { actions, summary } = planSharedSkillLinks({
      sourceDir: SRC,
      skills,
      targets: [
        { id: 'workbuddy', dir: 'C:/Users/me/.workbuddy/skills', entries: [{ name: 'winvm-orchestrator', isSymlink: false, linkTarget: null }] },
      ],
    });
    assert.equal(summary.conflict, 1);
    assert.equal(actions[0].action, 'skip-conflict');
  });

  test('已是指向其他位置的 symlink → skip-conflict', () => {
    const { summary } = planSharedSkillLinks({
      sourceDir: SRC,
      skills,
      targets: [
        { id: 'hermes-agent', dir: 'C:/hermes/skills', entries: [{ name: 'winvm-orchestrator', isSymlink: true, linkTarget: 'D:/elsewhere/winvm-orchestrator' }] },
      ],
    });
    assert.equal(summary.conflict, 1);
  });

  test('Agent 目录不存在（未安装）→ skip-agent', () => {
    const { actions, summary } = planSharedSkillLinks({
      sourceDir: SRC,
      skills,
      targets: [{ id: 'hermes-agent', dir: null, entries: [] }],
    });
    assert.equal(summary.skipAgent, 1);
    assert.equal(actions[0].action, 'skip-agent');
  });
});

describe('planSkillPublish', () => {
  test('共享根缺失的技能 → add；共享根独有技能 → keep-extra', () => {
    const { actions, summary } = planSkillPublish({ repoSkills: ['a', 'b'], sharedSkills: ['c'] });
    assert.equal(summary.add, 2);
    assert.equal(summary.refresh, 0);
    assert.equal(summary.keepExtra, 1);
    const keep = actions.find((a) => a.action === 'keep-extra');
    assert.equal(keep.skill, 'c');
  });

  test('共享根已存在的同名技能 → refresh', () => {
    const { actions, summary } = planSkillPublish({ repoSkills: ['a'], sharedSkills: ['a', 'c'] });
    assert.equal(summary.add, 0);
    assert.equal(summary.refresh, 1);
    assert.equal(summary.keepExtra, 1);
    const refresh = actions.find((a) => a.action === 'refresh');
    assert.equal(refresh.skill, 'a');
  });
});

describe('norm（路径归一化）', () => {
  test('反斜杠/大小写/尾部斜杠统一', () => {
    assert.equal(norm('C:\\WinVMBridge\\shared-skills\\x\\'), norm('c:/winvmbRidge/shared-skills/X'));
  });
});

describe('host-only 排除（HOST_ONLY_SKILLS：根治 hos-win 语义倒挂）', () => {
  test('planSkillPublish 双向：repoSkills 含 host-only → skip-host-only（不 add/refresh）；sharedSkills 含 host-only → remove', () => {
    const { actions, summary } = planSkillPublish({
      repoSkills: ['hos-win-skill', 'winvm-orchestrator'],
      sharedSkills: ['hos-win-skill', 'winvm-orchestrator'],
    });
    // 仓库侧：host-only 只许 skip-host-only，绝不 add/refresh
    assert.equal(summary.skipHostOnly, 1);
    assert.ok(actions.some((a) => a.skill === 'hos-win-skill' && a.action === 'skip-host-only'));
    assert.ok(!actions.some((a) => a.skill === 'hos-win-skill' && (a.action === 'add' || a.action === 'refresh')));
    // 共享根侧：host-only 历史残留 → remove
    assert.equal(summary.remove, 1);
    assert.ok(actions.some((a) => a.skill === 'hos-win-skill' && a.action === 'remove'));
    // 其余语义不变：orchestrator 两侧都有 → refresh，无 add
    assert.equal(summary.refresh, 1);
    assert.equal(summary.add, 0);
  });

  test('planSharedSkillLinks：混合 skills + 目标含 host-only 历史 junction → create 仅 1、removeLink=1', () => {
    const { actions, summary } = planSharedSkillLinks({
      sourceDir: SRC,
      skills: ['hos-win-skill', 'winvm-orchestrator'],
      targets: [
        {
          id: 'workbuddy',
          dir: 'C:/Users/me/.workbuddy/skills',
          entries: [{ name: 'hos-win-skill', isSymlink: true, linkTarget: `${SRC}/hos-win-skill` }],
        },
      ],
    });
    // host-only 绝不建 junction；仅 orchestrator 新建
    assert.equal(summary.create, 1);
    const orch = actions.find((a) => a.skill === 'winvm-orchestrator');
    assert.equal(orch.action, 'create');
    // 指向共享源的历史 junction → remove-link
    assert.equal(summary.removeLink, 1);
    const host = actions.find((a) => a.skill === 'hos-win-skill');
    assert.equal(host.action, 'remove-link');
  });

  test('planSharedSkillLinks：全新空 target + 同一混合 skills → create=1、removeLink=0', () => {
    const { actions, summary } = planSharedSkillLinks({
      sourceDir: SRC,
      skills: ['hos-win-skill', 'winvm-orchestrator'],
      targets: [{ id: 'workbuddy', dir: 'C:/Users/me/.workbuddy/skills', entries: [] }],
    });
    assert.equal(summary.create, 1);
    assert.equal(summary.removeLink, 0);
    // host-only 无残留时不产生任何动作
    assert.ok(!actions.some((a) => a.skill === 'hos-win-skill'));
  });
});

/* ---- owner 2026-11-24 裁定：两类 skill 的分界 ----
 * 「还没进 Windows 时才有意义」= 分派层（仅 hos-win-skill）⇒ 不下发 VM；
 * 「到了 Windows 怎么用工具干活」= 操作指引（含 agent-browser/agent-desktop）⇒ 两端共用、必下发。
 * 下面三条钉住这个分界，防止后人再把两个上游工具面加回名单（那会让 VM 内 CLI 有工具无手册）。 */
describe('两类 skill 分界（owner 2026-11-24 裁定）', () => {
  test('HOST_ONLY_SKILLS 恰为 [hos-win-skill]（分派层唯一成员）', () => {
    assert.deepEqual([...HOST_ONLY_SKILLS], ['hos-win-skill']);
  });

  test('两个上游工具面**不在** host-only 名单里（它们是 VM 内 CLI 的唯一操作手册）', () => {
    assert.ok(!HOST_ONLY_SKILLS.includes('agent-browser-skill'));
    assert.ok(!HOST_ONLY_SKILLS.includes('agent-desktop-skill'));
  });

  test('planSkillPublish：两个上游工具面 + 五域 → 全部 add（仅 hos-win-skill 被 skip）', () => {
    const repoSkills = [
      'hos-win-skill',
      'agent-browser-skill',
      'agent-desktop-skill',
      'winvm-orchestrator',
      'winvm-system-admin',
      'winvm-app-manager',
      'winvm-storage-manager',
      'winvm-gui-automation',
      'winvm-app-operation',
      'winvm-mcp-reference',
    ];
    const { actions, summary } = planSkillPublish({ repoSkills, sharedSkills: [] });
    assert.equal(summary.skipHostOnly, 1, '只有 hos-win-skill 被排除');
    assert.equal(summary.add, 9, '其余 9 个全部发布到共享根');
    assert.ok(actions.some((a) => a.skill === 'agent-browser-skill' && a.action === 'add'));
    assert.ok(actions.some((a) => a.skill === 'agent-desktop-skill' && a.action === 'add'));
    assert.ok(actions.some((a) => a.skill === 'hos-win-skill' && a.action === 'skip-host-only'));
  });
});

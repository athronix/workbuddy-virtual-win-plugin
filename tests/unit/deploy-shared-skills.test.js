/**
 * 共享 Skills 部署「规划层」单元测试（纯函数，不创建真实 junction）
 *
 * 覆盖 ADR-14 的两段式规划：发布（repo→共享根）与链接（共享根→各 Agent 目录）。
 * apply* / publish* 的副作用由 install-vm 的 dry-run 路径在部署期校验，此处仅验证决策正确性。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { planSharedSkillLinks, planSkillPublish, norm } from '../../delivery/deploy-shared-skills.mjs';

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

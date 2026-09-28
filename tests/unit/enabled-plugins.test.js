#!/usr/bin/env node
/**
 * CL-020 / D16 —— enabledPlugins 启用/停用「纯函数」单测（applyEnabledPlugin）。
 *
 * 背景：平台以 ~/.workbuddy/settings.json 的 `enabledPlugins` 为**启用真相源**；
 * 插件只写 installed_plugins.json（"已注册"）不会启用它，缺失该键时插件 hooks
 * （SessionStart 隧道自启动）不被加载（实测 D16 根因之一）。故部署期 merge 写入该键。
 *
 * 覆盖（全部为纯函数语义，无 I/O）：
 *  1. settings 无 enabledPlugins → 新建并置 true，changed=true。
 *  2. 已为 true → 幂等，changed=false 且**返回同一对象**（不产生多余写盘）。
 *  3. 幂等二次调用（对返回的 next 再调用）→ changed=false。
 *  4. 保留其它全部键（sandbox / claw / 其它插件条目）不被破坏。
 *  5. disable：移除本键、保留其它插件条目，changed=true。
 *  6. disable 幂等：本键不存在 → changed=false、内容不变。
 *  7. 非法入参容错：settings 为 null / 数组 / 字符串 → 视作空对象，不抛异常。
 *  8. **不修改入参**（纯函数契约）：调用前后入参深比较相等。
 *
 * 运行：node --test tests/unit/enabled-plugins.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyEnabledPlugin } from '../../delivery/install-host.mjs';

const KEY = 'winvm-bridge@winvm';

test('无 enabledPlugins → 新建并置 true', () => {
  const settings = { sandbox: { extraAllowWrite: ['~/.workbuddy/winvm'] } };
  const { next, changed } = applyEnabledPlugin(settings, KEY, true);
  assert.equal(changed, true);
  assert.equal(next.enabledPlugins[KEY], true);
  assert.deepEqual(next.sandbox, settings.sandbox);
});

test('已为 true → 幂等，changed=false 且返回同一对象', () => {
  const settings = { enabledPlugins: { [KEY]: true, 'sheetagent@workbuddy-builtin': true } };
  const { next, changed } = applyEnabledPlugin(settings, KEY, true);
  assert.equal(changed, false);
  assert.equal(next, settings);
});

test('对返回值再次调用 → 幂等（changed=false）', () => {
  const first = applyEnabledPlugin({}, KEY, true);
  const second = applyEnabledPlugin(first.next, KEY, true);
  assert.equal(second.changed, false);
  assert.equal(second.next.enabledPlugins[KEY], true);
});

test('merge 时保留其它键与其它插件条目', () => {
  const settings = {
    sandbox: { extraAllowWrite: ['a'] },
    enabledPlugins: { 'tencent-docx@workbuddy-builtin': true },
    claw: { channels: { wechatmp: { enabled: true } } },
  };
  const { next, changed } = applyEnabledPlugin(settings, KEY, true);
  assert.equal(changed, true);
  assert.equal(next.enabledPlugins[KEY], true);
  assert.equal(next.enabledPlugins['tencent-docx@workbuddy-builtin'], true);
  assert.deepEqual(next.claw, settings.claw);
  assert.deepEqual(next.sandbox, settings.sandbox);
});

test('disable：移除本键、保留其它插件条目', () => {
  const settings = {
    enabledPlugins: { [KEY]: true, 'sheetagent@workbuddy-builtin': true },
  };
  const { next, changed } = applyEnabledPlugin(settings, KEY, false);
  assert.equal(changed, true);
  assert.equal(KEY in next.enabledPlugins, false);
  assert.equal(next.enabledPlugins['sheetagent@workbuddy-builtin'], true);
});

test('disable 幂等：本键不存在 → changed=false、内容不变', () => {
  const settings = { enabledPlugins: { 'sheetagent@workbuddy-builtin': true } };
  const { next, changed } = applyEnabledPlugin(settings, KEY, false);
  assert.equal(changed, false);
  assert.equal(next, settings);
});

test('enable 覆盖误配的 false 值', () => {
  const settings = { enabledPlugins: { [KEY]: false } };
  const { next, changed } = applyEnabledPlugin(settings, KEY, true);
  assert.equal(changed, true);
  assert.equal(next.enabledPlugins[KEY], true);
});

test('非法入参容错：null / 数组 / 字符串 / enabledPlugins 非对象', () => {
  for (const bad of [null, undefined, [], 'nope', 42]) {
    const { next, changed } = applyEnabledPlugin(bad, KEY, true);
    assert.equal(changed, true);
    assert.equal(next.enabledPlugins[KEY], true);
  }
  // enabledPlugins 被写坏成数组 → 视为缺失，重建为普通对象
  const { next, changed } = applyEnabledPlugin({ enabledPlugins: ['x'] }, KEY, true);
  assert.equal(changed, true);
  assert.equal(Array.isArray(next.enabledPlugins), false);
  assert.equal(next.enabledPlugins[KEY], true);
});

test('纯函数契约：不修改入参', () => {
  const settings = { enabledPlugins: {}, sandbox: { extraAllowWrite: ['a'] } };
  const snapshot = JSON.parse(JSON.stringify(settings));
  applyEnabledPlugin(settings, KEY, true);
  applyEnabledPlugin(settings, KEY, false);
  assert.deepEqual(settings, snapshot);
});

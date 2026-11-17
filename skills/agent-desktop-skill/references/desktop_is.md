# `desktop_is`

> 归属 **agent-desktop** · 宿主 connector `connector:winvm-desktop` → `POST /mcp/desktop`
> 默认暴露：⛔ 否（在白名单外，需解禁后才能调，见 SKILL.md §5）

## 用途

判断元素布尔状态（visible/enabled/checked/focused/expanded/selected）。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `property` | string |  | `"visible"` | State: visible, enabled, checked, focused, expanded, selected |
| `ref_id` | string | ★ |  | Qualified ref from snapshot (@<snapshot_id>:eN) |

## 调用示例

```json
{
  "ref_id": "e12",
  "property": "enabled"
}
```

## 要点

- 先 `desktop_list_apps` 确认目标应用在跑，再 `desktop_snapshot`（用 `app` 或 `window_id` 限定范围，否则大应用的树会很大）。
- `@ref` 只在**本次快照**内有效；任何界面变化后重新快照，不要复用旧 ref。

## 上游原始描述

agent-desktop is: Check element state (visible, enabled, checked, focused, expanded, selected)

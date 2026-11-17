# `desktop_find`

> 归属 **agent-desktop** · 宿主 connector `connector:winvm-desktop` → `POST /mcp/desktop`
> 默认暴露：✅ 是（服务端白名单内）

## 用途

在无障碍树中按角色/名称/值/文本检索元素，直接返回可用的 ref——已知目标特征时不必整树 dump。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `app` | string |  |  | Filter to application by name |
| `count` | boolean |  |  | Return match count only |
| `description` | string |  |  | Match by accessible description |
| `exact` | boolean |  |  | Require exact (case-insensitive) name/description/value matches |
| `first` | boolean |  |  | Return first match only |
| `last` | boolean |  |  | Return last match only |
| `limit` | integer |  |  | Return at most N matches; defaults to 50 when omitted, use 0 for all |
| `name` | string |  |  | Match by accessible name or label |
| `native_id` | string |  |  | Match by native automation id (AXIdentifier) |
| `nth` | integer |  |  | Return Nth match (0-indexed) |
| `role` | string |  |  | Match by accessibility role (button, textfield, checkbox ...) |
| `root` | string |  |  | Search only inside this ref's subtree, not the whole window |
| `states` | array |  |  | Filter by state token (repeatable); append =true or =false |
| `surface` | string |  | `"window"` | Surface to search (menubar, menu, sheet ...) instead of the window（取值：`"window"`、`"focused"`、`"menu"`、`"menubar"`、`"sheet"`、`"popover"`、`"alert"`、`"desktop"`、`"taskbar"`、`"system-tray"` 等 19 项） |
| `text` | string |  |  | Match by text in name, value, title, or description |
| `timeout_ms` | integer |  |  | Traversal deadline in milliseconds (default 5000; raise for a large tree such as a shell file dialog) |
| `value` | string |  |  | Match by current value |
| `window_id` | string |  |  | Scope to a single window ID (from list-windows) |

## 调用示例

```json
{
  "app": "chrome",
  "role": "button",
  "name": "Save"
}
```

## 要点

- 先 `desktop_list_apps` 确认目标应用在跑，再 `desktop_snapshot`（用 `app` 或 `window_id` 限定范围，否则大应用的树会很大）。
- `@ref` 只在**本次快照**内有效；任何界面变化后重新快照，不要复用旧 ref。

## 上游原始描述

agent-desktop find: Search elements by role, name, value, or text content

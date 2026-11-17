# `desktop_snapshot`

> 归属 **agent-desktop** · 宿主 connector `connector:winvm-desktop` → `POST /mcp/desktop`
> 默认暴露：✅ 是（服务端白名单内）

## 用途

抓取应用的无障碍（accessible）树，返回带 `@ref` 编号的结构化 JSON——**所有 ref 操作的唯一来源**。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `app` | string |  |  | Filter to application by name |
| `compact` | boolean |  |  | Collapse single-child unnamed nodes to reduce tree depth |
| `force_electron_a11y` | boolean |  |  | Assume Chromium renderer accessibility is forced (skips activation guidance) |
| `include_bounds` | boolean |  |  | Include element bounds (x, y, width, height) |
| `interactive_only` | boolean |  |  | Include interactive elements only |
| `max_depth` | integer |  | `10` | Maximum tree depth (default 10) |
| `root` | string |  |  | Start traversal from this ref instead of window root |
| `skeleton` | boolean |  |  | Shallow overview with children_count on truncated containers |
| `surface` | string |  | `"window"` | Surface to snapshot（取值：`"window"`、`"focused"`、`"menu"`、`"menubar"`、`"sheet"`、`"popover"`、`"alert"`、`"desktop"`、`"taskbar"`、`"system-tray"` 等 19 项） |
| `timeout_ms` | integer |  |  | Observation deadline in milliseconds (default 3000; raise for slow Chromium settles) |
| `window_id` | string |  |  | Scope to a single window ID (from list-windows) |

## 调用示例

```json
{
  "app": "chrome",
  "interactive_only": true
}
```

## 要点

- 先 `desktop_list_apps` 确认目标应用在跑，再 `desktop_snapshot`（用 `app` 或 `window_id` 限定范围，否则大应用的树会很大）。
- `@ref` 只在**本次快照**内有效；任何界面变化后重新快照，不要复用旧 ref。

## 上游原始描述

agent-desktop snapshot: Capture accessibility tree as structured JSON with @ref IDs

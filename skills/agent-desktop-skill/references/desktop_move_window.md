# `desktop_move_window`

> 归属 **agent-desktop** · 宿主 connector `connector:winvm-desktop` → `POST /mcp/desktop`
> 默认暴露：⛔ 否（在白名单外，需解禁后才能调，见 SKILL.md §5）

## 用途

移动应用窗口到新位置。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `app` | string |  |  | Filter to application by name |
| `window_id` | string |  |  | Scope to a single window ID (from list-windows) |
| `x` | number | ★ |  | New window X position; write a negative value with = (--x=-100) |
| `y` | number | ★ |  | New window Y position; write a negative value with = (--y=-100) |

## 调用示例

```json
{
  "app": "chrome",
  "x": 0,
  "y": 0
}
```

## 要点

- 窗口类动作优先给 `window_id`；只给 `app` 且该应用有多个窗口时结果不确定。

## 上游原始描述

agent-desktop move-window: Move application window to new position

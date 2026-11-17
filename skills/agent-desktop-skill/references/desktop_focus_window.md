# `desktop_focus_window`

> 归属 **agent-desktop** · 宿主 connector `connector:winvm-desktop` → `POST /mcp/desktop`
> 默认暴露：⛔ 否（在白名单外，需解禁后才能调，见 SKILL.md §5）

## 用途

把窗口置前并确认操作系统焦点已到位。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `app` | string |  |  | Application name |
| `title` | string |  |  | Window title (partial match accepted) |
| `window_id` | string |  |  | Window ID from list-windows |

## 调用示例

```json
{
  "app": "chrome"
}
```

## 要点

- 窗口类动作优先给 `window_id`；只给 `app` 且该应用有多个窗口时结果不确定。

## 上游原始描述

agent-desktop focus-window: Bring a window to front and confirm OS focus

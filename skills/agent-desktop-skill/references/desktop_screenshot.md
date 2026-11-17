# `desktop_screenshot`

> 归属 **agent-desktop** · 宿主 connector `connector:winvm-desktop` → `POST /mcp/desktop`
> 默认暴露：✅ 是（服务端白名单内）

## 用途

对应用窗口截 PNG（落盘并回传路径），用于视觉核对，不产生 ref。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `app` | string |  |  | Filter to application by name |
| `output_path` | string |  |  | Save to file instead of returning base64 |
| `screen` | integer |  |  | Capture display by index (from list-displays; 0 = primary) |
| `window_id` | string |  |  | Scope to a single window ID (from list-windows) |

## 调用示例

```json
{
  "app": "chrome"
}
```

## 要点

- 先 `desktop_list_apps` 确认目标应用在跑，再 `desktop_snapshot`（用 `app` 或 `window_id` 限定范围，否则大应用的树会很大）。
- `@ref` 只在**本次快照**内有效；任何界面变化后重新快照，不要复用旧 ref。

## 上游原始描述

agent-desktop screenshot: Take a PNG screenshot of an application window

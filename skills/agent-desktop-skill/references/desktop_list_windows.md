# `desktop_list_windows`

> 归属 **agent-desktop** · 宿主 connector `connector:winvm-desktop` → `POST /mcp/desktop`
> 默认暴露：✅ 是（服务端白名单内）

## 用途

列出所有可见窗口（可按应用过滤）。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `app` | string |  |  | Filter to application by exact case-insensitive name |
| `timeout_ms` | integer |  |  | Inventory deadline in milliseconds (default 5000) |

## 调用示例

```json
{
  "app": "chrome"
}
```

## 要点

- 窗口类动作优先给 `window_id`；只给 `app` 且该应用有多个窗口时结果不确定。

## 上游原始描述

agent-desktop list-windows: List all visible windows (--app to filter by application)

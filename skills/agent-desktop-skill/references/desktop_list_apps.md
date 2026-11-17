# `desktop_list_apps`

> 归属 **agent-desktop** · 宿主 connector `connector:winvm-desktop` → `POST /mcp/desktop`
> 默认暴露：✅ 是（服务端白名单内）

## 用途

列出当前所有有 GUI 的应用——**判断「桌面到底有什么」的第一条命令**。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `app` | string |  |  | Filter to application by name |
| `timeout_ms` | integer |  |  | Inventory deadline in milliseconds (default 5000) |

## 调用示例

```json
{
  "app": "chrome"
}
```

## 上游原始描述

agent-desktop list-apps: List all running GUI applications (--app to filter)

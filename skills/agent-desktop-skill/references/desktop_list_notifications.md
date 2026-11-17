# `desktop_list_notifications`

> 归属 **agent-desktop** · 宿主 connector `connector:winvm-desktop` → `POST /mcp/desktop`
> 默认暴露：⛔ 否（在白名单外，需解禁后才能调，见 SKILL.md §5）

## 用途

列出通知中心的通知。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `app` | string |  |  | Filter to notifications from this app |
| `limit` | integer |  |  | Maximum number of notifications to return |
| `text` | string |  |  | Filter to notifications containing this text |

## 调用示例

```json
{
  "app": "chrome"
}
```

## 上游原始描述

agent-desktop list-notifications: List notifications from Notification Center

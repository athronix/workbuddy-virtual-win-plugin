# `desktop_notification_action`

> 归属 **agent-desktop** · 宿主 connector `connector:winvm-desktop` → `POST /mcp/desktop`
> 默认暴露：⛔ 否（在白名单外，需解禁后才能调，见 SKILL.md §5）

## 用途

点击某条通知上的动作按钮。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `action` | string | ★ |  | Name of the action button to click (e.g., Reply, Open) |
| `expected_app` | string |  |  | Expected app name at INDEX; one expected identity field is required |
| `expected_title` | string |  |  | Expected title at INDEX; one expected identity field is required |
| `index` | integer | ★ |  | 1-based notification index from list-notifications |

## 调用示例

```json
{
  "index": 0,
  "action": "<action>"
}
```

## 上游原始描述

agent-desktop notification-action: Click an action button on a notification

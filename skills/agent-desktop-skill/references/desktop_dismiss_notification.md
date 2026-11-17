# `desktop_dismiss_notification`

> 归属 **agent-desktop** · 宿主 connector `connector:winvm-desktop` → `POST /mcp/desktop`
> 默认暴露：⛔ 否（在白名单外，需解禁后才能调，见 SKILL.md §5）

## 用途

按序号关闭一条通知。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `app` | string |  |  | Require the notification at INDEX to be from this app; INDEX is its position in the unfiltered list |
| `expected_app` | string |  |  | Expected app name at INDEX; one expected identity field is required |
| `expected_title` | string |  |  | Expected title at INDEX; one expected identity field is required |
| `index` | integer | ★ |  | 1-based notification index from list-notifications |

## 调用示例

```json
{
  "index": 0
}
```

## 上游原始描述

agent-desktop dismiss-notification: Dismiss a notification by index

# `desktop_dismiss_all_notifications`

> 归属 **agent-desktop** · 宿主 connector `connector:winvm-desktop` → `POST /mcp/desktop`
> 默认暴露：⛔ 否（在白名单外，需解禁后才能调，见 SKILL.md §5）

## 用途

关闭全部通知（可按应用过滤）。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `app` | string |  |  | Only dismiss notifications from this app |

## 调用示例

```json
{
  "app": "chrome"
}
```

## 上游原始描述

agent-desktop dismiss-all-notifications: Dismiss all notifications (--app to filter)

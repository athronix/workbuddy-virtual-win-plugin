# `desktop_list_surfaces`

> 归属 **agent-desktop** · 宿主 connector `connector:winvm-desktop` → `POST /mcp/desktop`
> 默认暴露：⛔ 否（在白名单外，需解禁后才能调，见 SKILL.md §5）

## 用途

列出应用的无障碍「面」（window / menu / sheet 等）。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `app` | string |  |  | Filter to application by name |

## 调用示例

```json
{
  "app": "chrome"
}
```

## 上游原始描述

agent-desktop list-surfaces: List accessibility surfaces for an app (window, menu, sheet ...)

# `desktop_permissions`

> 归属 **agent-desktop** · 宿主 connector `connector:winvm-desktop` → `POST /mcp/desktop`
> 默认暴露：⛔ 否（在白名单外，需解禁后才能调，见 SKILL.md §5）

## 用途

检查细分权限（accessibility / screen_recording / automation），可申请或给引导。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `guide` | boolean |  |  | Open System Settings with an on-screen guide for granting the missing permissions (macOS) |
| `request` | boolean |  |  | Request missing permissions in the bounded isolated helper |

## 调用示例

```json
{
  "guide": true
}
```

## 要点

- 排障第一步：`desktop_status` + `desktop_permissions`，确认适配器健康与权限未缺。

## 上游原始描述

agent-desktop permissions: Check nested permission states:
accessibility/screen_recording/automation each return {state,...}

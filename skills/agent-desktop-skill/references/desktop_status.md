# `desktop_status`

> 归属 **agent-desktop** · 宿主 connector `connector:winvm-desktop` → `POST /mcp/desktop`
> 默认暴露：⛔ 否（在白名单外，需解禁后才能调，见 SKILL.md §5）

## 用途

报告适配器健康、平台信息与权限状态。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| — | — | — | — | 本工具无参数 |

## 调用示例

```json
{}
```

## 要点

- 排障第一步：`desktop_status` + `desktop_permissions`，确认适配器健康与权限未缺。

## 上游原始描述

agent-desktop status: Show adapter health, platform info, and permission state

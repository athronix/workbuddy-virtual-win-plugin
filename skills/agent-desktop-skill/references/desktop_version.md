# `desktop_version`

> 归属 **agent-desktop** · 宿主 connector `connector:winvm-desktop` → `POST /mcp/desktop`
> 默认暴露：⛔ 否（在白名单外，需解禁后才能调，见 SKILL.md §5）

## 用途

打印版本、目标架构与操作系统。

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

agent-desktop version: Show version, target architecture, and OS

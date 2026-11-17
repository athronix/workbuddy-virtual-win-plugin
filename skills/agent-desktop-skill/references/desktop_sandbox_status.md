# `desktop_sandbox_status`

> 归属 **agent-desktop** · 宿主 connector `connector:winvm-desktop` → `POST /mcp/desktop`
> 默认暴露：⛔ 否（在白名单外，需解禁后才能调，见 SKILL.md §5）

## 用途

报告单个沙箱状态与下一步命令。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `name` | string | ★ |  | Sandbox name: lowercase letters, digits and hyphens |

## 调用示例

```json
{
  "name": "<name>"
}
```

## 要点

- 沙箱是 agent-desktop 自带的多环境隔离能力，与本项目「VM 内一套服务」的模型正交，本项目默认不启用。

## 上游原始描述

agent-desktop sandbox status: Report one sandbox's state and its next command

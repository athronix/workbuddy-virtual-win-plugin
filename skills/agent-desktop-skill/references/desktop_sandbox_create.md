# `desktop_sandbox_create`

> 归属 **agent-desktop** · 宿主 connector `connector:winvm-desktop` → `POST /mcp/desktop`
> 默认暴露：⛔ 否（在白名单外，需解禁后才能调，见 SKILL.md §5）

## 用途

创建沙箱（复用已装的提供方）。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `name` | string | ★ |  | Sandbox name: lowercase letters, digits and hyphens |
| `provider` | string | ★ |  | Provider that owns the sandbox; `sandbox install` lists the providers in this build |
| `set` | array |  |  | Provider option; repeat for more than one |

## 调用示例

```json
{
  "name": "s1",
  "provider": "docker"
}
```

## 要点

- 沙箱是 agent-desktop 自带的多环境隔离能力，与本项目「VM 内一套服务」的模型正交，本项目默认不启用。

## 上游原始描述

agent-desktop sandbox create: Create a sandbox, reusing whatever the provider already installed

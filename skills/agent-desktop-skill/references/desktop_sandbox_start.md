# `desktop_sandbox_start`

> 归属 **agent-desktop** · 宿主 connector `connector:winvm-desktop` → `POST /mcp/desktop`
> 默认暴露：⛔ 否（在白名单外，需解禁后才能调，见 SKILL.md §5）

## 用途

启动已停止的沙箱。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `name` | string | ★ |  | Sandbox name: lowercase letters, digits and hyphens |
| `set` | array |  |  | Provider option for this start, such as title=<text>; repeat for more than one |
| `window` | boolean |  |  | Show the sandbox's desktop in a window on this host instead of running it headless |

## 调用示例

```json
{
  "name": "<name>"
}
```

## 要点

- 沙箱是 agent-desktop 自带的多环境隔离能力，与本项目「VM 内一套服务」的模型正交，本项目默认不启用。

## 上游原始描述

agent-desktop sandbox start: Start a stopped sandbox

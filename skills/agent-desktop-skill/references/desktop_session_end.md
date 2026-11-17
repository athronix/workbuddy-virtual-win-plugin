# `desktop_session_end`

> 归属 **agent-desktop** · 宿主 connector `connector:winvm-desktop` → `POST /mcp/desktop`
> 默认暴露：⛔ 否（在白名单外，需解禁后才能调，见 SKILL.md §5）

## 用途

封存会话清单。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `id` | string |  |  | Session id to end; defaults to global --session or AGENT_DESKTOP_SESSION |

## 调用示例

```json
{
  "id": "<id>"
}
```

## 要点

- 会话/轨迹/光标覆盖属**调试与取证**能力，日常操作不需要开启。

## 上游原始描述

agent-desktop session end: Seal a session manifest

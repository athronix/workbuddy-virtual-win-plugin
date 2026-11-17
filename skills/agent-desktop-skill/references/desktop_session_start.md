# `desktop_session_start`

> 归属 **agent-desktop** · 宿主 connector `connector:winvm-desktop` → `POST /mcp/desktop`
> 默认暴露：⛔ 否（在白名单外，需解禁后才能调，见 SKILL.md §5）

## 用途

创建会话目录与清单（可选截图/轨迹/光标覆盖）。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `cursor` | boolean |  |  | Show the visual cursor overlay with its default style |
| `multi_agent` | boolean |  |  | Give each harness subagent its own cursor; requires --agent-id on desktop actions |
| `name` | string |  |  | Optional human-readable session label |
| `no_trace` | boolean |  |  | Create the session without automatic tracing |
| `screenshots` | boolean |  |  | Capture pre/post-action screenshots and refmap copies (requires tracing; sensitive) |

## 调用示例

```json
{
  "cursor": true
}
```

## 要点

- 会话/轨迹/光标覆盖属**调试与取证**能力，日常操作不需要开启。

## 上游原始描述

agent-desktop session start: Create a session directory and manifest

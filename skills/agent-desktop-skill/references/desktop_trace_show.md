# `desktop_trace_show`

> 归属 **agent-desktop** · 宿主 connector `connector:winvm-desktop` → `POST /mcp/desktop`
> 默认暴露：⛔ 否（在白名单外，需解禁后才能调，见 SKILL.md §5）

## 用途

把会话轨迹合并成有限的 JSON 时间线。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `event` | string |  |  | Filter events by name prefix before applying --limit |
| `limit` | integer |  | `500` | Return the last N merged events (0 for all; default 500) |

## 调用示例

```json
{
  "event": "<event>"
}
```

## 要点

- 会话/轨迹/光标覆盖属**调试与取证**能力，日常操作不需要开启。

## 上游原始描述

agent-desktop trace show: Merge session trace segments into a bounded JSON timeline

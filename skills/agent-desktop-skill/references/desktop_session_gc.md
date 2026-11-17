# `desktop_session_gc`

> 归属 **agent-desktop** · 宿主 connector `connector:winvm-desktop` → `POST /mcp/desktop`
> 默认暴露：⛔ 否（在白名单外，需解禁后才能调，见 SKILL.md §5）

## 用途

清理已结束或可判定过期的会话。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `ended` | boolean |  |  | Only consider sessions that already have ended_at set, and remove them even when their trace was written in the last few minutes |
| `older_than` | integer |  |  | Only remove sessions whose ended_at/created_at age exceeds this many seconds |

## 调用示例

```json
{
  "ended": true
}
```

## 要点

- 会话/轨迹/光标覆盖属**调试与取证**能力，日常操作不需要开启。

## 上游原始描述

agent-desktop session gc: Remove ended or provably-stale sessions

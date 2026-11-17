# `desktop_trace_export`

> 归属 **agent-desktop** · 宿主 connector `connector:winvm-desktop` → `POST /mcp/desktop`
> 默认暴露：⛔ 否（在白名单外，需解禁后才能调，见 SKILL.md §5）

## 用途

导出可离线打开的自包含 HTML 轨迹查看器。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `limit` | integer |  | `5000` | Embed the last N merged events (0 for all; default 5000) |
| `out` | string |  |  | Output HTML path (default trace-<session>.html) |

## 调用示例

```json
{
  "limit": 10
}
```

## 要点

- 会话/轨迹/光标覆盖属**调试与取证**能力，日常操作不需要开启。

## 上游原始描述

agent-desktop trace export: Export a self-contained HTML trace viewer

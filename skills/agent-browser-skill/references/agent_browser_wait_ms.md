# `agent_browser_wait_ms`

*Wait milliseconds*

> 归属 **agent-browser** · 宿主 connector `connector:winvm-browser` → `POST /mcp/browser`
> 默认暴露：✅ 是（服务端白名单内）
> 标注：只读 · 涉及外部世界

## 用途

固定等待若干毫秒（无更好判据时才用）。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `ms` | integer | ★ |  |  |
| `session` | string |  |  | Isolated browser session name: Unicode letters, numbers, hyphens, and underscores. |
| `timeoutMs` | integer |  | `120000` | Maximum time to wait for this tool call. |

## 调用示例

```json
{
  "ms": 500
}
```

## 上游原始描述

Wait for a fixed time.

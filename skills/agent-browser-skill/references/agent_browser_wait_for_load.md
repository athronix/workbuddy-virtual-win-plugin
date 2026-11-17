# `agent_browser_wait_for_load`

*Wait for load state*

> 归属 **agent-browser** · 宿主 connector `connector:winvm-browser` → `POST /mcp/browser`
> 默认暴露：✅ 是（服务端白名单内）
> 标注：只读 · 涉及外部世界

## 用途

等待页面加载状态（超时即报错，不静默返回）。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `session` | string |  |  | Isolated browser session name: Unicode letters, numbers, hyphens, and underscores. |
| `state` | string | ★ |  | （取值：`"load"`、`"domcontentloaded"`、`"networkidle"`） |
| `timeoutMs` | integer |  | `120000` | Maximum time to wait for this tool call. |
| `waitTimeoutMs` | integer |  |  | Maximum time for the browser wait condition. |

## 调用示例

```json
{
  "state": "networkidle"
}
```

## 上游原始描述

Wait for a page load state. Uses the full wait timeout and returns an error when it expires.

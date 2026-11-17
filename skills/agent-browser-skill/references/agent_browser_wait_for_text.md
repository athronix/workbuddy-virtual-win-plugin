# `agent_browser_wait_for_text`

*Wait for text*

> 归属 **agent-browser** · 宿主 connector `connector:winvm-browser` → `POST /mcp/browser`
> 默认暴露：✅ 是（服务端白名单内）
> 标注：只读 · 涉及外部世界

## 用途

等待文本出现。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `session` | string |  |  | Isolated browser session name: Unicode letters, numbers, hyphens, and underscores. |
| `text` | string | ★ |  |  |
| `timeoutMs` | integer |  | `120000` | Maximum time to wait for this tool call. |
| `waitTimeoutMs` | integer |  |  | Maximum time for the browser wait condition. |

## 调用示例

```json
{
  "text": "Done"
}
```

## 上游原始描述

Wait for text to appear.

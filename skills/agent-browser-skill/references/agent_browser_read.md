# `agent_browser_read`

*Read URL*

> 归属 **agent-browser** · 宿主 connector `connector:winvm-browser` → `POST /mcp/browser`
> 默认暴露：✅ 是（服务端白名单内）
> 标注：只读 · 涉及外部世界

## 用途

把 URL（或当前标签页）读成 agent 友好的文本，优先 text/markdown——**读内容首选，不必开浏览器**。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `allowedDomains` | array |  |  | Restrict browser and read traffic to these domain patterns. |
| `extraArgs` | array |  |  | Extra CLI arguments for this command, such as --engine. Flags that change network, file, policy, or host access are rejected. |
| `filter` | string |  |  | Filter page sections, --llms links/sections, or --outline headings. |
| `llms` | string |  |  | Return nearest-ancestor llms data: index for compact llms.txt links, full for llms-full.txt.（取值：`"index"`、`"full"`） |
| `outline` | boolean |  |  | Return a heading outline for the selected page instead of the full page text. |
| `raw` | boolean |  |  | Return the response body without HTML extraction. |
| `readTimeoutMs` | integer |  |  | Request timeout in milliseconds. |
| `requireMd` | boolean |  |  | Fail unless the response is Content-Type: text/markdown. |
| `session` | string |  |  | Isolated browser session name: Unicode letters, numbers, hyphens, and underscores. |
| `timeoutMs` | integer |  | `120000` | Maximum time to wait for this tool call. |
| `url` | string |  |  | URL to read. Bare hosts are normalized to https. Omit to read the active tab. |

## 调用示例

```json
{
  "url": "https://example.com"
}
```

## 要点

- 只读网页内容时优先 `agent_browser_read`——它不开浏览器，快且省资源；需要交互才 `open`。

## 上游原始描述

Fetch a URL as agent-readable text, preferring text/markdown. Omit url to read the active tab.

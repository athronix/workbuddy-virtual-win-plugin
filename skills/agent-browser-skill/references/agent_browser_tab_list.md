# `agent_browser_tab_list`

*Tab list*

> 归属 **agent-browser** · 宿主 connector `connector:winvm-browser` → `POST /mcp/browser`
> 默认暴露：✅ 是（服务端白名单内）
> 标注：只读 · 涉及外部世界

## 用途

列出标签页。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `session` | string |  |  | Isolated browser session name: Unicode letters, numbers, hyphens, and underscores. |

## 调用示例

```json
{
  "session": "<session>"
}
```

## 要点

- `session` 参数用于隔离浏览器实例（多任务并行时不互相踩标签页）；单任务可省略。

## 上游原始描述

List tabs.

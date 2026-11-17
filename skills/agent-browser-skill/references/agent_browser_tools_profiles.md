# `agent_browser_tools_profiles`

*MCP tool profiles*

> 归属 **agent-browser** · 宿主 connector `connector:winvm-browser` → `POST /mcp/browser`
> 默认暴露：✅ 是（服务端白名单内）
> 标注：会改变状态 · 涉及外部世界

## 用途

列出 MCP 启动时的工具档位以及如何启用更多工具。

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

## 上游原始描述

List MCP startup tool profiles and how to enable them.

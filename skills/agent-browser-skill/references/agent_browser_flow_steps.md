# `agent_browser_flow_steps`

*List captured steps*

> 归属 **agent-browser** · 宿主 connector `connector:winvm-browser` → `POST /mcp/browser`
> 默认暴露：✅ 是（服务端白名单内）
> 标注：只读 · 涉及外部世界

## 用途

实验性：列出当前会话录到的步骤编号与成败。

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

- 实验性能力：行为可能随版本变化，不要把生产流程押在 flow 上。

## 上游原始描述

Experimental. List the steps a session opened with capture flow has recorded: number, command,
URL, tagged request count, and whether it succeeded. Use the numbers with flow save from and to.

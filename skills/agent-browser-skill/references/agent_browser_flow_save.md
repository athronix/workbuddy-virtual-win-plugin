# `agent_browser_flow_save`

*Save flow*

> 归属 **agent-browser** · 宿主 connector `connector:winvm-browser` → `POST /mcp/browser`
> 默认暴露：✅ 是（服务端白名单内）
> 标注：会改变状态 · 涉及外部世界

## 用途

实验性：把录到的步骤保存为可重放任务流。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `description` | string |  |  | One line saying what the flow does. |
| `from` | integer |  |  | First step number; defaults to the last navigation after the previous save. |
| `name` | string | ★ |  |  |
| `output` | string |  |  | Request id whose response the flow returns. |
| `params` | object |  |  |  |
| `session` | string |  |  | Isolated browser session name: Unicode letters, numbers, hyphens, and underscores. |
| `timeout` | integer |  |  | Milliseconds to wait for requests the last step started that have no response yet. |
| `to` | integer |  |  | Last step; defaults to the latest. |

## 调用示例

```json
{
  "name": "<name>"
}
```

## 要点

- 实验性能力：行为可能随版本变化，不要把生产流程押在 flow 上。

## 上游原始描述

Experimental. Save recorded steps as a flow so later runs can skip the browser. The session must
be opened with capture flow. By default the flow starts at the last navigation after the
previous save. params maps a param name to the value you typed, so later runs can change it.

# `agent_browser_flow_run`

*Run saved flow*

> 归属 **agent-browser** · 宿主 connector `connector:winvm-browser` → `POST /mcp/browser`
> 默认暴露：✅ 是（服务端白名单内）
> 标注：会改变状态 · 涉及外部世界

## 用途

实验性：直接重放已保存任务流（优先于快照+点击）。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `allowWrite` | string |  |  | Writes the run may send without asking: `all`, or comma-separated write ids from flow save. Any other write needs confirmation. |
| `fields` | string |  |  | Comma-separated fields to return per item, dotted paths allowed. |
| `limit` | integer |  |  |  |
| `name` | string | ★ |  |  |
| `origin` | string |  |  |  |
| `params` | object |  |  |  |
| `session` | string |  |  | Isolated browser session name: Unicode letters, numbers, hyphens, and underscores. |
| `timeout` | integer |  |  | Milliseconds the whole run may take, across every tier. |
| `where` | object |  |  | Keep list items whose field contains the value, case-insensitive. |

## 调用示例

```json
{
  "name": "login"
}
```

## 要点

- 实验性能力：行为可能随版本变化，不要把生产流程押在 flow 上。

## 上游原始描述

Experimental. Run a saved task by sending its requests directly, falling back to the page, then
to a replay of the recorded commands. Prefer this over snapshot and click when a saved flow
covers the task. Fails and marks the flow unverified when the site changed; continue with the UI
then.

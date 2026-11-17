# `agent_browser_flow_list`

*List saved flows*

> 归属 **agent-browser** · 宿主 connector `connector:winvm-browser` → `POST /mcp/browser`
> 默认暴露：✅ 是（服务端白名单内）
> 标注：只读 · 涉及外部世界

## 用途

实验性：列出已保存的任务流及其参数与上次运行是否验证通过。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `origin` | string |  |  | Only flows for this host's site. |
| `session` | string |  |  | Isolated browser session name: Unicode letters, numbers, hyphens, and underscores. |

## 调用示例

```json
{
  "origin": "<origin>"
}
```

## 要点

- 实验性能力：行为可能随版本变化，不要把生产流程押在 flow 上。

## 上游原始描述

Experimental. List tasks saved with flow save, with their params and whether their last run
verified.

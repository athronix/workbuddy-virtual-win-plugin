# `agent_browser_wait_for_selector`

*Wait for selector*

> 归属 **agent-browser** · 宿主 connector `connector:winvm-browser` → `POST /mcp/browser`
> 默认暴露：✅ 是（服务端白名单内）
> 标注：只读 · 涉及外部世界

## 用途

等待元素到达指定状态（裸数字选择器会被拒绝）。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `selector` | string | ★ |  | Element @ref from snapshot, or a CSS selector. |
| `session` | string |  |  | Isolated browser session name: Unicode letters, numbers, hyphens, and underscores. |
| `state` | string |  |  | Element state to wait for.（取值：`"visible"`、`"hidden"`、`"attached"`、`"detached"`） |
| `timeoutMs` | integer |  | `120000` | Maximum time to wait for this tool call. |
| `waitTimeoutMs` | integer |  |  | Maximum time for the browser wait condition. |

## 调用示例

```json
{
  "selector": "#result",
  "state": "visible"
}
```

## 要点

- `@ref` 只在**当前快照**内有效；动作报 stale ref 时重新 `agent_browser_snapshot` 取新 ref，不要重试旧 ref。
- `selector` 可填 `@ref` 或 CSS 选择器；纯数字选择器会被拒绝（用 CSS 语法或改走 `wait_ms`）。

## 上游原始描述

Wait for an element with a CSS selector or @ref to reach a state. Bare integer selectors are
rejected; use CSS selector syntax for numeric IDs or agent_browser_wait_ms for a delay.

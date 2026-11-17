# `agent_browser_click`

*Click element*

> 归属 **agent-browser** · 宿主 connector `connector:winvm-browser` → `POST /mcp/browser`
> 默认暴露：✅ 是（服务端白名单内）
> 标注：会改变状态 · 涉及外部世界

## 用途

按 `@ref` 或 CSS 选择器点击元素。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `human` | boolean |  | `false` | Approach the target with seeded, curved mouse movement. |
| `newTab` | boolean |  | `false` | Open link targets in a new tab after applying session setup. |
| `selector` | string | ★ |  | Element @ref from snapshot, or a CSS selector. |
| `session` | string |  |  | Isolated browser session name: Unicode letters, numbers, hyphens, and underscores. |

## 调用示例

```json
{
  "selector": "@e12"
}
```

## 要点

- `@ref` 只在**当前快照**内有效；动作报 stale ref 时重新 `agent_browser_snapshot` 取新 ref，不要重试旧 ref。
- `selector` 可填 `@ref` 或 CSS 选择器；纯数字选择器会被拒绝（用 CSS 语法或改走 `wait_ms`）。

## 上游原始描述

Click an element by @ref or CSS selector.

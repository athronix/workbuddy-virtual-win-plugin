# `agent_browser_eval`

*Evaluate JavaScript*

> 归属 **agent-browser** · 宿主 connector `connector:winvm-browser` → `POST /mcp/browser`
> 默认暴露：✅ 是（服务端白名单内）
> 标注：会改变状态 · 涉及外部世界

## 用途

在页面里执行 JavaScript（脚本走 stdin，无 shell 转义问题）。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `script` | string | ★ |  | JavaScript expression or script to evaluate. |
| `session` | string |  |  | Isolated browser session name: Unicode letters, numbers, hyphens, and underscores. |
| `timeoutMs` | integer |  | `120000` | Maximum time to wait for this tool call. |

## 调用示例

```json
{
  "script": "document.title"
}
```

## 要点

- `@ref` 只在**当前快照**内有效；动作报 stale ref 时重新 `agent_browser_snapshot` 取新 ref，不要重试旧 ref。
- `selector` 可填 `@ref` 或 CSS 选择器；纯数字选择器会被拒绝（用 CSS 语法或改走 `wait_ms`）。

## 上游原始描述

Run JavaScript in the page using stdin to avoid shell escaping. When the top-level result is a
value JSON cannot represent, the structured response includes `response.data.unserializable` and
the text content prints the JavaScript token.

# `agent_browser_press`

*Press key*

> 归属 **agent-browser** · 宿主 connector `connector:winvm-browser` → `POST /mcp/browser`
> 默认暴露：✅ 是（服务端白名单内）
> 标注：会改变状态 · 涉及外部世界

## 用途

在当前焦点按键（`Enter`/`Tab`/`Escape` 等）。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `key` | string | ★ |  | Key name such as Enter, Tab, or Control+a. |
| `session` | string |  |  | Isolated browser session name: Unicode letters, numbers, hyphens, and underscores. |

## 调用示例

```json
{
  "key": "Enter"
}
```

## 上游原始描述

Press a key at the current focus.

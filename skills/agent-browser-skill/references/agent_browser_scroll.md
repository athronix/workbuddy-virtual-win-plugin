# `agent_browser_scroll`

*Scroll page*

> 归属 **agent-browser** · 宿主 connector `connector:winvm-browser` → `POST /mcp/browser`
> 默认暴露：✅ 是（服务端白名单内）
> 标注：会改变状态 · 涉及外部世界

## 用途

滚动页面或指定元素。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `amount` | integer |  | `300` | Pixels to scroll. |
| `direction` | string |  | `"down"` | （取值：`"up"`、`"down"`、`"left"`、`"right"`） |
| `selector` | string |  |  | Optional element selector to scroll. |
| `session` | string |  |  | Isolated browser session name: Unicode letters, numbers, hyphens, and underscores. |

## 调用示例

```json
{
  "amount": 3
}
```

## 上游原始描述

Scroll the page or an element.

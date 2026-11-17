# `agent_browser_screenshot`

*Take screenshot*

> 归属 **agent-browser** · 宿主 connector `connector:winvm-browser` → `POST /mcp/browser`
> 默认暴露：✅ 是（服务端白名单内）
> 标注：会改变状态 · 涉及外部世界

## 用途

截图并返回落盘路径；小幅 PNG/JPEG 同时以图片内容回传。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `annotate` | boolean |  | `false` | Number visible elements in the screenshot. |
| `format` | string |  |  | Screenshot format.（取值：`"png"`、`"jpeg"`） |
| `fullPage` | boolean |  | `false` |  |
| `ifChanged` | boolean |  | `false` | Recommended for repeated captures to save tokens: return image content only when pixels changed. |
| `path` | string |  |  | Optional output path. |
| `quality` | integer |  |  | JPEG quality. |
| `screenshotDir` | string |  |  | Default output directory when path is omitted. |
| `selector` | string |  |  | Optional @ref or CSS selector to capture. |
| `session` | string |  |  | Isolated browser session name: Unicode letters, numbers, hyphens, and underscores. |
| `threshold` | number |  |  | Maximum changed-pixel ratio to treat as unchanged. Implies ifChanged. |

## 调用示例

```json
{
  "fullPage": true
}
```

## 要点

- `@ref` 只在**当前快照**内有效；动作报 stale ref 时重新 `agent_browser_snapshot` 取新 ref，不要重试旧 ref。
- `selector` 可填 `@ref` 或 CSS 选择器；纯数字选择器会被拒绝（用 CSS 语法或改走 `wait_ms`）。

## 上游原始描述

Capture a screenshot and return the saved path. Small PNG/JPEG screenshots are also returned as
image content.

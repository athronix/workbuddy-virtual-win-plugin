# `agent_browser_snapshot`

*Snapshot page*

> 归属 **agent-browser** · 宿主 connector `connector:winvm-browser` → `POST /mcp/browser`
> 默认暴露：✅ 是（服务端白名单内）
> 标注：只读 · 涉及外部世界

## 用途

返回带可复用 `@ref` 的无障碍树快照——浏览器侧 ref 的唯一来源。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `compact` | boolean |  | `false` | Remove empty structural elements, retaining only matching content and its direct ancestors. With interactive:false, retain visible text. |
| `delta` | boolean |  | `false` | Return full state once, then unchanged or bounded structural deltas. Apply changes to refs and treeChange (zero-based startLine, deleteCount, lines) to the previous tree. |
| `depth` | integer |  |  | Limit tree depth. |
| `full` | boolean |  | `false` | Force full state while updating the delta baseline. |
| `includeUrls` | boolean |  | `false` | Include href URLs on links. |
| `interactive` | boolean |  | `true` | Only include interactive elements. |
| `selector` | string |  |  | Scope the snapshot to a CSS selector. |
| `session` | string |  |  | Isolated browser session name: Unicode letters, numbers, hyphens, and underscores. |

## 调用示例

```json
{
  "interactive": true
}
```

## 要点

- `@ref` 只在**当前快照**内有效；动作报 stale ref 时重新 `agent_browser_snapshot` 取新 ref，不要重试旧 ref。
- `selector` 可填 `@ref` 或 CSS 选择器；纯数字选择器会被拒绝（用 CSS 语法或改走 `wait_ms`）。

## 上游原始描述

Return an accessibility-tree snapshot with reusable element refs. Presentational iframes use the
Iframe role for snapshots and stale-ref recovery. If an action reports that a stale ref cannot
be recovered, take a new snapshot and use a fresh ref. Controls with an empty or duplicated
accessible name carry a hint="..." read from the DOM after the ref.

# `agent_browser_tab_switch`

*Tab switch*

> 归属 **agent-browser** · 宿主 connector `connector:winvm-browser` → `POST /mcp/browser`
> 默认暴露：✅ 是（服务端白名单内）
> 标注：会改变状态 · 涉及外部世界

## 用途

按 id / label / CDP target 切换标签页（切换后会话绑定该页）。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `session` | string |  |  | Isolated browser session name: Unicode letters, numbers, hyphens, and underscores. |
| `tab` | string | ★ |  | Tab id (t1), label, or CDP target id. |

## 调用示例

```json
{
  "tab": "t2"
}
```

## 要点

- `session` 参数用于隔离浏览器实例（多任务并行时不互相踩标签页）；单任务可省略。

## 上游原始描述

Switch to a tab by id (t1), label, or CDP target id. Switching also binds the session to that
tab.

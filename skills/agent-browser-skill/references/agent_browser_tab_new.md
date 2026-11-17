# `agent_browser_tab_new`

*Tab new*

> 归属 **agent-browser** · 宿主 connector `connector:winvm-browser` → `POST /mcp/browser`
> 默认暴露：✅ 是（服务端白名单内）
> 标注：会改变状态 · 涉及外部世界

## 用途

新开标签页（先应用会话设置再做首次导航）。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `allowedDomains` | array |  |  | Restrict browser and read traffic to these domain patterns. |
| `capture` | array |  |  | Record the session so flow steps and flow save can turn it into a reusable flow. On a running session without capture it relaunches the browser with capture on. |
| `extraArgs` | array |  |  | Extra CLI arguments for this command, such as --engine. Flags that change network, file, policy, or host access are rejected. |
| `label` | string |  |  | Starts with an ASCII letter, then ASCII letters, digits, `-`, or `_`; `t<N>` and `T<N>` forms are reserved for tab IDs. |
| `relaunch` | boolean |  |  | Relaunch the session's browser even when no setting changed (--relaunch). |
| `restore` | any |  |  | Restore and auto-save browser state. true keys it by session; a string is an explicit key. |
| `session` | string |  |  | Isolated browser session name: Unicode letters, numbers, hyphens, and underscores. |
| `timeoutMs` | integer |  | `120000` | Maximum time to wait for this tool call. |
| `url` | string |  |  |  |

## 调用示例

```json
{
  "allowedDomains": []
}
```

## 要点

- `session` 参数用于隔离浏览器实例（多任务并行时不互相踩标签页）；单任务可省略。

## 上游原始描述

Open a new tab after applying session setup before its first navigation. Rejected labels
preserve the current tab's refs and selected frame.

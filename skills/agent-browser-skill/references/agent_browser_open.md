# `agent_browser_open`

*Open page*

> 归属 **agent-browser** · 宿主 connector `connector:winvm-browser` → `POST /mcp/browser`
> 默认暴露：✅ 是（服务端白名单内）
> 标注：会改变状态 · 涉及外部世界

## 用途

启动浏览器并（可选）导航到 URL；`headed` 开可视窗口，`session` 隔离会话。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `allowedDomains` | array |  |  | Restrict browser and read traffic to these domain patterns. |
| `capture` | array |  |  | Record the session so flow steps and flow save can turn it into a reusable flow. On a running session without capture it relaunches the browser with capture on. |
| `extraArgs` | array |  |  | Extra CLI arguments for this command, such as --engine. Flags that change network, file, policy, or host access are rejected. |
| `headed` | boolean |  |  | Show the browser window. Explicit true/false overrides AGENT_BROWSER_HEADED and config; omit to use those defaults. |
| `relaunch` | boolean |  |  | Relaunch the session's browser even when no setting changed (--relaunch). |
| `restore` | any |  |  | Restore and auto-save browser state. true keys it by session; a string is an explicit key. |
| `session` | string |  |  | Isolated browser session name: Unicode letters, numbers, hyphens, and underscores. |
| `timeoutMs` | integer |  | `120000` | Maximum time to wait for this tool call. |
| `url` | string |  |  | URL to open. Omit to launch about:blank. |
| `webgpu` | boolean |  |  | Enable WebGPU (SwiftShader software Vulkan on Linux; no GPU required). Explicit true/false overrides AGENT_BROWSER_WEBGPU and config; omit to use those defaults. |
| `webmcp` | boolean |  |  | Enable experimental WebMCP support. Defaults to true for locally launched Chrome; set false to pass --no-webmcp. |

## 调用示例

```json
{
  "url": "https://example.com",
  "headed": false
}
```

## 要点

- `session` 参数用于隔离浏览器实例（多任务并行时不互相踩标签页）；单任务可省略。

## 上游原始描述

Launch the browser and optionally navigate to a URL. On macOS, installed browsers are searched
in /Applications, then ~/Applications. Set the proxy in the server environment or config;
percent-encoded proxy URL credentials are decoded before authentication. On Windows, owned
headless Chrome uses a private desktop and its process tree closes with the daemon, including
forced termination. Headed browsers use the interactive desktop. Successful navigation responses
include WebMCP availability metadata when the page exposes allowed tools. Browser-provider and
launch-mutation errors omit response error text and unsupported protocol values.

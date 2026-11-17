# `desktop_launch`

> 归属 **agent-desktop** · 宿主 connector `connector:winvm-desktop` → `POST /mcp/desktop`
> 默认暴露：⛔ 否（在白名单外，需解禁后才能调，见 SKILL.md §5）

## 用途

启动应用并在进程就绪后返回；`activate` 等窗口出现，`cdp` 校验 DevTools 端点。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `activate` | boolean |  |  | Bring the app forward so it presents a window, and wait for one |
| `app` | string | ★ |  | Application name or bundle ID |
| `args` | array |  |  | Command-line argument passed to the launched app; repeatable, order preserved. For values starting with '-', use --arg=<value> |
| `cdp` | integer |  |  | Expose the app's DevTools protocol endpoint on this port (0 or omitted picks a free port) |
| `cwd` | string |  |  | Working directory for the launched process |
| `env` | array |  |  | Environment variable for the launched process |
| `no_attach` | boolean |  |  | Start a fresh instance instead of attaching to a running one (Windows fails if the app is already running) |
| `timeout` | integer |  | `30000` | Upper bound in ms for the whole launch |

## 调用示例

```json
{
  "app": "notepad"
}
```

## 要点

- 窗口类动作优先给 `window_id`；只给 `app` 且该应用有多个窗口时结果不确定。

## 上游原始描述

agent-desktop launch: Launch application and return once its process is running; --activate
waits for a window, --cdp verifies a DevTools endpoint

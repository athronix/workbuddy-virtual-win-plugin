# `desktop_press`

> 归属 **agent-desktop** · 宿主 connector `connector:winvm-desktop` → `POST /mcp/desktop`
> 默认暴露：✅ 是（服务端白名单内）

## 用途

发送键组合（`return`、`escape`、`ctrl+c`、`shift+tab` 等），打到当前焦点或指定应用/窗口。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `app` | string |  |  | Target application name; keys go to its process without focusing it (--headed focuses its window first) |
| `combo` | string | ★ |  | Key combo: return, escape, cmd+c, shift+tab ... |
| `force` | boolean |  |  | Send the combo even if the adapter flags it as a dangerous shortcut |
| `window_id` | string |  |  | Target the application instance that owns this window (from list-windows); use it when several instances share one name |

## 调用示例

```json
{
  "combo": "ctrl+s"
}
```

## 要点

- `ref_id` 只能来自同一次 `desktop_snapshot` / `desktop_find` 的返回值。
- 动作后接 `desktop_wait`（等元素/文本/窗口）再做下一次观察，别用固定 sleep 猜。

## 上游原始描述

agent-desktop press: Send a key combo: return, escape, cmd+c, shift+tab ...

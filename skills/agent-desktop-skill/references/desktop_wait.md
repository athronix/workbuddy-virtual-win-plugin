# `desktop_wait`

> 归属 **agent-desktop** · 宿主 connector `connector:winvm-desktop` → `POST /mcp/desktop`
> 默认暴露：✅ 是（服务端白名单内）

## 用途

等待时间/元素出现/文本出现/窗口出现/通知出现——**每一步操作后的显式同步点**。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `action` | string |  |  | Action for --predicate actionable: click (default), type, set-value, or clear |
| `app` | string |  |  | Scope element, window, or text wait to this application |
| `count` | integer |  |  | Expected match count for --text waits |
| `element` | string |  |  | Block until this element ref appears in the tree |
| `event` | string |  |  | Block until a desktop lifecycle signal, detected by baseline diff without needing to know the id/title up front: window-opened, window-closed, app-launched, app-terminated, focus-changed, surface-appeared, surface-dismissed |
| `menu` | boolean |  |  | Block until a menu surface is open |
| `menu_closed` | boolean |  |  | Block until the menu surface is dismissed |
| `ms` | integer |  |  | Milliseconds to pause |
| `notification` | boolean |  |  | Block until a new notification arrives |
| `predicate` | string |  |  | Element wait predicate: exists, enabled, visible, actionable, or value |
| `text` | string |  |  | Block until text appears in the app's accessibility tree; with --notification, filter notification text |
| `timeout` | integer |  | `30000` | Timeout in milliseconds for element/window/text waits |
| `value` | string |  |  | Expected value for --predicate value |
| `window` | string |  |  | Block until a window with this title appears; with --event, narrows the event wait to that window title instead of selecting a mode |
| `window_id` | string |  |  | Optional: narrow --event window-opened/window-closed/focus-changed to one window ID |

## 调用示例

```json
{
  "ms": 800
}
```

## 要点

- `ref_id` 只能来自同一次 `desktop_snapshot` / `desktop_find` 的返回值。
- 动作后接 `desktop_wait`（等元素/文本/窗口）再做下一次观察，别用固定 sleep 猜。

## 上游原始描述

agent-desktop wait: Wait for time (ms), element presence, text, or window appearance

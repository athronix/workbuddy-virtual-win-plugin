# `desktop_open_system_surface`

> 归属 **agent-desktop** · 宿主 connector `connector:winvm-desktop` → `POST /mcp/desktop`
> 默认暴露：⛔ 否（在白名单外，需解禁后才能调，见 SKILL.md §5）

## 用途

打开系统级面（开始菜单/任务栏/程序坞/菜单栏扩展等）并返回其窗口。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `surface` | string | ★ |  | Shell surface to open: start-menu, taskbar, system-tray, system-tray-overflow, action-center, dock, menu-bar-extras（取值：`"window"`、`"focused"`、`"menu"`、`"menubar"`、`"sheet"`、`"popover"`、`"alert"`、`"desktop"`、`"taskbar"`、`"system-tray"` 等 19 项） |

## 调用示例

```json
{
  "surface": "start-menu"
}
```

## 上游原始描述

agent-desktop open-system-surface: Open a shell surface (start-menu, taskbar, dock, menu-bar-
extras ...) and return the window it presents, if any

# `desktop_close_app`

> 归属 **agent-desktop** · 宿主 connector `connector:winvm-desktop` → `POST /mcp/desktop`
> 默认暴露：⛔ 否（在白名单外，需解禁后才能调，见 SKILL.md §5）

## 用途

优雅退出应用（`force=true` 强杀）。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `app` | string | ★ |  | Application name |
| `force` | boolean |  |  | Terminate matching app processes instead of quitting gracefully |

## 调用示例

```json
{
  "app": "notepad",
  "force": false
}
```

## 上游原始描述

agent-desktop close-app: Quit an application gracefully (--force to terminate)

# `desktop_cursor_overlay_disable`

> 归属 **agent-desktop** · 宿主 connector `connector:winvm-desktop` → `POST /mcp/desktop`
> 默认暴露：⛔ 否（在白名单外，需解禁后才能调，见 SKILL.md §5）

## 用途

关闭光标覆盖层。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| — | — | — | — | 本工具无参数 |

## 调用示例

```json
{}
```

## 要点

- 会话/轨迹/光标覆盖属**调试与取证**能力，日常操作不需要开启。

## 上游原始描述

agent-desktop cursor-overlay disable: Disable the cursor overlay for the selected session

# `desktop_skills_get`

> 归属 **agent-desktop** · 宿主 connector `connector:winvm-desktop` → `POST /mcp/desktop`
> 默认暴露：⛔ 否（在白名单外，需解禁后才能调，见 SKILL.md §5）

## 用途

打印某个内置技能的 markdown 全文。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `full` | boolean |  |  | Append every reference file to the output |
| `name` | string | ★ |  | Skill name or alias: desktop, platform, macos, windows, linux, ffi, jev |
| `reference` | string |  |  | Reference filename (e.g. workflows or references/workflows.md). Omit for the main guide. |

## 调用示例

```json
{
  "name": "snapshot"
}
```

## 上游原始描述

agent-desktop skills get: Print a skill (markdown in data.content)

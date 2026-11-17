# `desktop_batch`

> 归属 **agent-desktop** · 宿主 connector `connector:winvm-desktop` → `POST /mcp/desktop`
> 默认暴露：⛔ 否（在白名单外，需解禁后才能调，见 SKILL.md §5）

## 用途

按顺序执行一批有限命令（非原子，默认遇错停）。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `commands_json` | string | ★ |  | JSON array of {command, args} objects |
| `stop_on_error` | boolean |  |  | Halt the batch on the first failed command |
| `timeout_ms` | integer |  | `60000` | Absolute wall-clock budget for the whole non-atomic batch |

## 调用示例

```json
{
  "commands_json": "[{\"tool\":\"desktop_click\",\"args\":{\"ref_id\":\"e12\"}}]"
}
```

## 上游原始描述

agent-desktop batch: Execute a bounded, sequential, non-atomic JSON command batch

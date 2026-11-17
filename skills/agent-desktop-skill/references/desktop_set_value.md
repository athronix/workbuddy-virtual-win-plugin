# `desktop_set_value`

> 归属 **agent-desktop** · 宿主 connector `connector:winvm-desktop` → `POST /mcp/desktop`
> 默认暴露：✅ 是（服务端白名单内）

## 用途

直接设置元素的值（走无障碍属性写入），比逐字输入快且不受输入法影响。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `ref_id` | string | ★ |  | Qualified ref from snapshot (@<snapshot_id>:eN) |
| `timeout_ms` | integer |  | `5000` | Maximum ref-resolution and transient-actionability wait in milliseconds; terminal failures return immediately |
| `value` | string |  |  | Value to set |

## 调用示例

```json
{
  "ref_id": "e7",
  "value": "hello"
}
```

## 要点

- `ref_id` 只能来自同一次 `desktop_snapshot` / `desktop_find` 的返回值。
- 动作后接 `desktop_wait`（等元素/文本/窗口）再做下一次观察，别用固定 sleep 猜。

## 上游原始描述

agent-desktop set-value: Set element value directly via accessibility attribute

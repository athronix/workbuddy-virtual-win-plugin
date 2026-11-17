# `desktop_type`

> 归属 **agent-desktop** · 宿主 connector `connector:winvm-desktop` → `POST /mcp/desktop`
> 默认暴露：✅ 是（服务端白名单内）

## 用途

向元素输入文本（等价键盘逐字输入）。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `interval_ms` | integer |  |  | Type one keystroke every N ms (1-2000) instead of inserting TEXT at once; --timeout-ms then applies to each keystroke, and 0 makes each keystroke try once |
| `ref_id` | string | ★ |  | Qualified ref from snapshot (@<snapshot_id>:eN) |
| `text` | string |  |  | Text to type |
| `timeout_ms` | integer |  |  | Maximum wait in milliseconds, covering ref resolution, actionability and delivery of the text; default 5000 plus 30 per character of TEXT; 0 disables the wait |

## 调用示例

```json
{
  "ref_id": "e7",
  "text": "hello"
}
```

## 要点

- `ref_id` 只能来自同一次 `desktop_snapshot` / `desktop_find` 的返回值。
- 动作后接 `desktop_wait`（等元素/文本/窗口）再做下一次观察，别用固定 sleep 猜。

## 上游原始描述

agent-desktop type: Insert text into a text target

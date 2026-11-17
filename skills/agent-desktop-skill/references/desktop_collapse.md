# `desktop_collapse`

> 归属 **agent-desktop** · 宿主 connector `connector:winvm-desktop` → `POST /mcp/desktop`
> 默认暴露：⛔ 否（在白名单外，需解禁后才能调，见 SKILL.md §5）

## 用途

收起折叠三角或树节点。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `ref_id` | string | ★ |  | Qualified ref from snapshot (@<snapshot_id>:eN) |
| `timeout_ms` | integer |  | `5000` | Maximum ref-resolution and transient-actionability wait in milliseconds; terminal failures return immediately |

## 调用示例

```json
{
  "ref_id": "e12"
}
```

## 上游原始描述

agent-desktop collapse: Collapse a disclosure triangle or tree item

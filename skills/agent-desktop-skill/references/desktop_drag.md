# `desktop_drag`

> 归属 **agent-desktop** · 宿主 connector `connector:winvm-desktop` → `POST /mcp/desktop`
> 默认暴露：⛔ 否（在白名单外，需解禁后才能调，见 SKILL.md §5）

## 用途

从一个元素/坐标拖拽到另一个元素/坐标（需 `--headed`）。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `drop_delay` | integer |  |  | Hold over the destination this many ms before releasing, so the drop target activates; default 500 (150 on Linux) |
| `duration` | integer |  |  | Drag duration in milliseconds |
| `from` | string |  |  | Source element ref; requires --headed |
| `from_xy` | string |  |  | Source coordinates as x,y; requires --headed; write a negative value with = (--from-xy=-100,50) |
| `timeout_ms` | integer |  | `5000` | Drag action budget in milliseconds, including resolution, actionability, pickup, duration and drop delay; allow headroom for completion |
| `to` | string |  |  | Destination element ref; requires --headed |
| `to_xy` | string |  |  | Destination coordinates as x,y; requires --headed; write a negative value with = (--to-xy=-100,50) |
| `wait_for_scope` | string |  |  | Window a drag's --wait-for/--wait-for-gone verification polls: 'to' (drop target, default) or 'from' (pickup). Needed when the confirmation appears only in the destination window of a cross-window drag（取值：`"from"`、`"to"`） |

## 调用示例

```json
{
  "drop_delay": 1
}
```

## 要点

- 物理输入（双击/三击/拖拽/坐标鼠标/hover）要求服务端以 `--headed` 启动；本项目默认无头，调用会返回 `POLICY_DENIED`。
- 能用语义动作（`desktop_click` / `desktop_set_value`）就别用坐标动作——语义动作不受窗口位置与 DPI 影响。

## 上游原始描述

agent-desktop drag: Drag from one element or point to another (requires --headed)

# `desktop_mouse_wheel`

> 归属 **agent-desktop** · 宿主 connector `connector:winvm-desktop` → `POST /mcp/desktop`
> 默认暴露：⛔ 否（在白名单外，需解禁后才能调，见 SKILL.md §5）

## 用途

在绝对坐标滚动滚轮（需 `--headed`）。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `dx` | number |  | `0` | Horizontal wheel lines; positive scrolls right, negative scrolls left |
| `dy` | number |  |  | Vertical wheel lines; positive scrolls up, negative scrolls down (default -3 when --dx is absent, else 0) |
| `modifiers` | array |  |  | Held modifiers: shift, meta, ctrl, alt (repeatable; cmd is accepted) |
| `x` | number | ★ |  | Absolute X coordinate for wheel event; write a negative value with = (--x=-100) |
| `y` | number | ★ |  | Absolute Y coordinate for wheel event; write a negative value with = (--y=-100) |

## 调用示例

```json
{
  "x": 640,
  "y": 360,
  "dy": -3
}
```

## 要点

- 物理输入（双击/三击/拖拽/坐标鼠标/hover）要求服务端以 `--headed` 启动；本项目默认无头，调用会返回 `POLICY_DENIED`。
- 能用语义动作（`desktop_click` / `desktop_set_value`）就别用坐标动作——语义动作不受窗口位置与 DPI 影响。

## 上游原始描述

agent-desktop mouse-wheel: Scroll the mouse wheel at absolute coordinates (requires --headed)

# `desktop_mouse_click`

> 归属 **agent-desktop** · 宿主 connector `connector:winvm-desktop` → `POST /mcp/desktop`
> 默认暴露：⛔ 否（在白名单外，需解禁后才能调，见 SKILL.md §5）

## 用途

在绝对屏幕坐标点击（可指定键位/次数/修饰键，需 `--headed`）。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `button` | string |  | `"left"` | Mouse button: left, right, middle |
| `count` | integer |  | `1` | Number of clicks |
| `modifiers` | array |  |  | Held modifiers: shift, meta, ctrl, alt (repeatable; cmd is accepted) |
| `xy` | string | ★ |  | Absolute coordinates as x,y; requires --headed; write a negative value with = (--xy=-100,50) |

## 调用示例

```json
{
  "xy": "640,360"
}
```

## 要点

- 物理输入（双击/三击/拖拽/坐标鼠标/hover）要求服务端以 `--headed` 启动；本项目默认无头，调用会返回 `POLICY_DENIED`。
- 能用语义动作（`desktop_click` / `desktop_set_value`）就别用坐标动作——语义动作不受窗口位置与 DPI 影响。

## 上游原始描述

agent-desktop mouse-click: Click at absolute screen coordinates (requires --headed)

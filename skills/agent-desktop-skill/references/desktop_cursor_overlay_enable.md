# `desktop_cursor_overlay_enable`

> 归属 **agent-desktop** · 宿主 connector `connector:winvm-desktop` → `POST /mcp/desktop`
> 默认暴露：⛔ 否（在白名单外，需解禁后才能调，见 SKILL.md §5）

## 用途

为当前会话开启光标覆盖层（调试/录像用）。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `accent` | string |  |  | Cursor, ripple and element highlight colour as a hex value (default #4299FF) |
| `bow` | number |  |  | Path curvature multiplier from 0 (straight) to 3 (default 1) |
| `dwell_ms` | integer |  |  | Pause on the target before the action runs, 0 to 300 (default 0) |
| `fill` | string |  |  | Cursor body colour as a hex value (default: the accent colour) |
| `hotspot` | string |  |  | Point in the image, in image points from its top-left, that marks the click position (default 0,0) |
| `image` | string |  |  | Draw the cursor from a PNG file instead of the built-in arrow; scaled by --size |
| `label` | string |  |  | Show caller-authored intent text beside the cursor overlay |
| `max_words` | integer |  |  | Limit the cursor overlay label to 1-12 words (default 6) |
| `motion_seed` | integer |  |  | Vary each move deterministically from this seed |
| `multi_agent` | boolean |  |  | Require agent IDs for desktop UI actions; use without --agent-id to configure the session |
| `no_highlight` | boolean |  |  | Do not outline the element when the agent clicks |
| `no_ripple` | boolean |  |  | Do not play the ripple when the agent clicks |
| `overshoot` | number |  |  | Overshoot past the target as a fraction, 0 to 0.15 (default 0.035) |
| `pointer_hotspot` | string |  |  | Click point in the pointer image, in image points from its top-left (default 0,0) |
| `pointer_image` | string |  |  | PNG shown instead while the cursor rests on a button, link or other pressable control |
| `rim` | string |  |  | Cursor outline colour as a hex value (default #111318) |
| `size` | number |  |  | Cursor size multiplier from 0.5 to 4.0 (default 1.0) |
| `travel_ms` | string |  |  | Cursor travel time range in ms, short to long moves (default 90,320) |
| `tremor` | number |  |  | Hand tremor amplitude in points, 0 to 4 (default 1.1) |

## 调用示例

```json
{
  "accent": "<accent>"
}
```

## 要点

- 会话/轨迹/光标覆盖属**调试与取证**能力，日常操作不需要开启。

## 上游原始描述

agent-desktop cursor-overlay enable: Enable and configure the cursor overlay for the selected
session

# `desktop_key_up`

> 归属 **agent-desktop** · 宿主 connector `connector:winvm-desktop` → `POST /mcp/desktop`
> 默认暴露：⛔ 否（在白名单外，需解禁后才能调，见 SKILL.md §5）

## 用途

释放被按住的键（无状态模式下 fail-closed）。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `combo` | string | ★ |  | Key or modifier to hold/release: shift, meta, ctrl ... (cmd is accepted); the command is rejected in stateless mode, use press instead |
| `force` | boolean |  |  | Send the combo even if the adapter flags it as a dangerous shortcut |

## 调用示例

```json
{
  "combo": "ctrl+s"
}
```

## 要点

- 物理输入（双击/三击/拖拽/坐标鼠标/hover）要求服务端以 `--headed` 启动；本项目默认无头，调用会返回 `POLICY_DENIED`。
- 能用语义动作（`desktop_click` / `desktop_set_value`）就别用坐标动作——语义动作不受窗口位置与 DPI 影响。

## 上游原始描述

agent-desktop key-up: Release a held key or modifier (fails closed in stateless mode; use press)

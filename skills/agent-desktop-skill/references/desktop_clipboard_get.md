# `desktop_clipboard_get`

> 归属 **agent-desktop** · 宿主 connector `connector:winvm-desktop` → `POST /mcp/desktop`
> 默认暴露：⛔ 否（在白名单外，需解禁后才能调，见 SKILL.md §5）

## 用途

读取剪贴板（纯文本或指定格式，可落文件）。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `format` | string |  |  | Clipboard format to read: text (default), auto, image, file-urls |
| `out` | string |  |  | Where to write image content; defaults to a private temp file under the session dir |

## 调用示例

```json
{
  "format": "text"
}
```

## 上游原始描述

agent-desktop clipboard-get: Read plain-text or typed clipboard contents

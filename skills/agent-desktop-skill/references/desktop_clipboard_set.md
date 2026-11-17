# `desktop_clipboard_set`

> 归属 **agent-desktop** · 宿主 connector `connector:winvm-desktop` → `POST /mcp/desktop`
> 默认暴露：⛔ 否（在白名单外，需解禁后才能调，见 SKILL.md §5）

## 用途

向剪贴板写入文本/图片/文件 URL。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `file_url` | array |  |  | File path to write to the clipboard as a file reference; repeatable |
| `image` | string |  |  | Path to a PNG file to write to the clipboard |
| `text` | string |  |  | Text to write to the clipboard (ignored if --image or --file-url is given) |

## 调用示例

```json
{
  "text": "pong"
}
```

## 上游原始描述

agent-desktop clipboard-set: Write text to the clipboard

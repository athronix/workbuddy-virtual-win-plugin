# `desktop_sandbox_install`

> 归属 **agent-desktop** · 宿主 connector `connector:winvm-desktop` → `POST /mcp/desktop`
> 默认暴露：⛔ 否（在白名单外，需解禁后才能调，见 SKILL.md §5）

## 用途

报告或安装某沙箱提供方所需组件。

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `provider` | string |  |  | Provider to install; omit it to report every provider's state |

## 调用示例

```json
{
  "provider": "<provider>"
}
```

## 要点

- 沙箱是 agent-desktop 自带的多环境隔离能力，与本项目「VM 内一套服务」的模型正交，本项目默认不启用。

## 上游原始描述

agent-desktop sandbox install: Report or install what a sandbox provider needs on this host

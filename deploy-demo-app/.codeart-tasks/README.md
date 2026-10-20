# WB ↔ CodeArts Agent 文件交接管线

## 为什么需要

WorkBuddy（WB）沙箱与 CodeArts Agent 分属两个鸿蒙 App，进程 / IPC / 端口互不可见（已实测：
WB 沙箱 `ps` 仅见本沙箱 16 进程，codeart/deveco 零匹配；`::1` 本地无可用端点）。但二者都能读写
共享存储（hmdfs）——于是用**文件**作总线，人作 bridge。

## 流转模型

```
WB 写指令 → .codeart-tasks/TASK-XXX.md
   ↓ 人(bridge) 在 CodeArts Agent 打开工程并说「执行 TASK-XXX」
CodeArts Agent 跑 hvigorw assembleHap / codelinter
   ↓ 输出写回
.codeart-out/  (logs + 产物路径)
   ↓ 人(bridge) 把结论告诉 WB，或直接让 WB 读 .codeart-out/
WB 分析错误 → 修代码 → 写 TASK-XXX+1
```

## 目录约定

| 路径 | 作用 | 是否入库 |
|---|---|---|
| `.codeart-tasks/` | 任务指令，命名 `TASK-NNN.md`，`NNN` 递增 | ✅ 提交 |
| `.codeart-out/` | Agent 输出，命名 `<stage>-<时间戳>.log` | ❌ 见 `.gitignore` |
| `tools/build.sh` | 一键 lint/build 封装，Agent 执行成本最低化 | ✅ 提交 |

## 角色

- **WB = 大脑**：读错误、改代码、写任务。
- **人 = bridge**：一次粘贴触发 + 回传结论。
- **CodeArts Agent = 手**：按 TASK 跑工具链，产出规范日志。

## 边界与铁律

- 一切产物都不离开 `deploy-demo-app/` 目录（父项目红线：零改动）。
- `.codeart-out/` 下的 log / hap 绝不进 git（机器相关、体积大）。
- Agent 默认不修改源码；若必须修硬错误，需在回复里显式标注改了什么。

## 当前进度

- **TASK-001**：静态规则检查 + HAP 构建（待 bridge 在 CodeArts Agent 执行）
- 后续 TASK-002+：依据 TASK-001 输出，由 WB 修码后生成。

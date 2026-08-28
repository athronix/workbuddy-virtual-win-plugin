---
id: winvm-storage-manager
name: Windows 存储管理
description: >
  在 Windows 虚拟机内管理存储：磁盘与分区查询、目录体积分析、文件读写与搜索、
  压缩解压、符号链接、回收站查看、清理建议。用于"磁盘满了怎么办""找某个文件"
  "整理目录"等。
version: 0.1.0
domains: [storage]
triggers:
  - 磁盘空间不足
  - 查看哪个目录最大
  - 查找/移动/复制/删除文件
  - 压缩或解压
  - 清理建议
relatedSkills:
  - winvm-orchestrator
---

# Windows 存储管理

## 适用与不适用

**适用**：磁盘/卷查询、空间分析、用户数据区的文件目录操作、搜索、归档。

**不适用（红线，一律拒绝）**：
- **分区、格式化、删除卷** → L3，本系统**不提供该能力**，需人工在 VM 内执行
- `C:\Windows`、`C:\Program Files`、`C:\ProgramData`、`System Volume Information` 等
  系统目录 → 路径黑名单，任何能力都不得触碰
- 未列入白名单的盘符/路径 → 拒绝优先

**默认路径白名单**：`C:\Users\**`、`C:\Temp\**`、`C:\tmp\**`、`D:\Data\**`

## 前置检查

按 `winvm-orchestrator` §前置检查 执行（隧道 / 健康）。
批量操作前先做**空间分析**，避免误判。

## 通道选择

- **明确路径的单步操作** → **MCP 直调**
- **"磁盘满了帮我清理"** → **A2A 委派**（多步分析 + 逐项确认）

## 能力清单

| 能力 ID | 风险 | 说明 |
|---|---|---|
| `storage.disk.list` | L0 | 磁盘/分区/卷使用情况 |
| `storage.space.analyze` | L0 | 递归统计子目录体积 Top-N |
| `storage.file.read` | L0 | 读文件（UTF-8 或 base64） |
| `storage.file.write` | L1 | 写入或追加文件 |
| `storage.file.delete` | **L2** | 删除（**默认进回收站**，永久删除需审批） |
| `storage.file.move` | L1 | 移动/重命名 |
| `storage.file.copy` | L1 | 复制 |
| `storage.dir.manage` | L1 | 创建目录（幂等） |
| `storage.search.query` | L0 | 按文件名或内容搜索 |
| `storage.archive.manage` | L1 | 创建/展开 zip |
| `storage.link.manage` | L2 | 符号链接/硬链接/junction（**需审批**） |
| `storage.recycle.manage` | L0 | 查看回收站 |
| `storage.cleanup.analyze` | L0 | **只分析不执行** |

## 标准流程

### 磁盘空间排查

```
1. storage.disk.list          { includeVolumes: true }   # 看各卷余量
2. storage.space.analyze      { path: "C:\\Users", depth: 3, top: 30 }
3. storage.cleanup.analyze    { topLargeFiles: 30 }      # 只给建议，不删除
4. 向用户报告 Top 占用，由用户决定删哪些
```

### 删除文件（务必谨慎）

```
1. storage.search.query / space.analyze   # 明确对象
2. 展示清单（路径、大小、数量）→ 取得审批（L2）
3. storage.file.delete { path: "...", permanent: false }   # 默认进回收站
4. storage.disk.list                      # 验证空间释放
```

## 高危清单（L2 强制动作）

| 操作 | 风险 | 强制动作 |
|---|---|---|
| `storage.file.delete` | L2 | 展示路径+大小+条目数 → 审批；**默认进回收站** |
| `permanent: true` | L2（不可逆） | 必须用户**明确要求**"永久删除"且已审批，才可使用 |
| `storage.link.manage` | L2 | 展示链接与目标 → 审批 |
| 批量删除 | L2/L3 | **禁止根据模式批量推断**；逐项列出、逐项确认 |

**安全默认**：删除一律先走回收站。这是刻意设计 —— 给用户留出后悔的余地。

## 已知陷阱

- **路径分隔符**：用反斜杠 `C:\Users\alice`；正斜杠会被归一化，但建议统一用反斜杠
- **UNC 路径被拒**：`\\server\share` 默认在路径黑名单中
- **`space.analyze` 深度**：`depth` 越大越慢；建议 ≤3，根目录扫描设更大超时
- **大文件读取上限**：默认 1MB（`maxBytes`），超限会报 `FILE_TOO_LARGE`
- **回收站清空不可逆**：`cleanup.analyze` **只分析不执行**，不要把它当清理工具；
  真正清空回收站需用户明确要求并单独审批
- **压缩大目录耗时长**：`storage.archive.manage` 超时上限 300s

## 参考

- 能力定义：`docs/02-design/CAPABILITY-MODEL.md` §3.3
- 策略基线（路径黑白名单）：`docs/02-design/SECURITY-GOVERNANCE.md` §3.2
- 接口契约：`docs/02-design/INTERFACES.md` §2

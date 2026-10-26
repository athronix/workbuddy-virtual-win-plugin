# tunnel-mode 三模式配置 · QA 独立回归验证报告（严过关）

- 日期：2026-09-28
- 团队：software-winvm-tunnel-mode（快速模式）
- 被验对象：tunnel-mode 通道模式配置（mcp 默认 / a2a / intelligent 智能判断）
- 结论：**验证有效 · 智能路由 NoOne**

## 功能语义（主理人裁定）
宿主侧通道选择策略（指引性配置，不在桥层拦截）：
- `mcp`（默认）：一律 MCP 直调，复杂任务也由宿主多轮编排；
- `a2a`：一律委派 A2A，简单任务也委派；
- `intelligent`：按任务特征走主控 skill 决策树（单步结构化→MCP；多步/GUI/开放意图→A2A）。
- 优先级：`--tunnel-mode` flag > env `WINVM_TUNNEL_MODE` > vm-conn.json `tunnelMode` > 默认 mcp。

## A 项：构建与单测（QA 真实复跑）
| 命令 | 结果 |
|---|---|
| `npx tsc -b tsconfig.build.json` | 退出码 0，0 error |
| `node --test tests/unit/tunnel-mode.test.js` | 15/15 pass（4 suites） |
| `node --test tests/unit/winvm-plugin.test.js` | 7/7 pass（resolveVmConn 改动未破坏既有断言） |
| `node --test tests/unit/cl018-config.test.js` | 7/7 pass（constants.ts 改动未破坏配置基线） |

## B 项：CLI 冒烟（5/5 通过）
1. `tunnel-mode`（无参）→ mcp + default 来源 ✅
2. `WINVM_TUNNEL_MODE=intelligent` 子进程注入 → intelligent + env 来源 ✅
3. `tunnel-mode bogus` → 报错回落提示，exit 1 ✅
4. `tunnel status` → 「通道模式  : mcp（来源：default）」✅
5. **真实写盘回环验证**（`HOME=临时目录` 注入，`os.homedir()` POSIX 读 $HOME）：
   - 复制真实 vm-conn.json（5 字段）→ `tunnel-mode a2a` 写盘 → **仅追加 tunnelMode 键**、原 5 字段逐字保留、2 空格缩进 + 尾换行（与 install-host.mjs 格式一致）；
   - 回读 → a2a + vm-conn.json 来源（持久化链路通）→ `tunnel-mode mcp` 回写无残留；
   - 写盘态下非法值不产生写盘；临时目录已删除。

## C 项：代码/文档审查
1. `resolveTunnelMode` 边界 9 组用例（null/空串/大小写/空格/非法值）语义与 core 实现逐行同构 ✅
2. CLI 内联常量与 core/src/constants.ts 字面量逐字一致，静态对齐单测锁定防漂移 ✅（CLI 内联而非 import @winvm/core 的原因：部署缓存无 node_modules，import 会崩）
3. SKILL.md 三模式语义与裁定一致；决策树仅归 intelligent；查询命令用部署缓存路径形态 ✅
4. `resolveVmConn` 新增字段纯追加，既有返回形状未动 ✅
5. `tunnel status --json` 输出稳定（无 tunnelMode 字段，仅 human 分支新增行）✅

## 智能路由判定
**NoOne** —— 0 构建错误、30 项单测全过、冒烟 5/5、真实写盘回环通过、文档语义一致。

## 遗留风险（低，不阻塞）
1. `saveTunnelMode` 容错边界：vm-conn.json 若已是损坏 JSON，写盘会整体替换（建议后续解析失败时拒绝写入并告警）。
2. 写盘注入验证依赖 POSIX `os.homedir()` 读 $HOME 行为（本环境已实测可行）。
3. 部署缓存副本一致性依赖部署流程——建议下次部署后用缓存路径实跑一次 `tunnel-mode` 冒烟。

## 红线确认
真实运行态 `~/.workbuddy/winvm/vm-conn.json` 全程未写：验证前后 md5 均为 `193676c991bf8eca888436e7daf53da9`。未动 dist/、未做 git 操作。

## 改动文件清单（仓库侧）
1. `packages/core/src/constants.ts`（L165-224）：TunnelMode 类型 + TUNNEL_MODES + resolveTunnelMode()
2. `delivery/winvm-plugin.mjs`：tunnel-mode 块（L190-278）、resolveVmConn 扩展（L148-153）、tunnel status 通道模式行、parseArgs/USAGE
3. `skills/winvm-orchestrator/SKILL.md`（L98-118）：通道模式配置小节（决策树前）
4. `tests/unit/tunnel-mode.test.js`（新建，15 断言 4 suites）

## 部署提醒
运行态生效须：实跑 `delivery/install-host.mjs`（同步 CLI 与 skill 到宿主缓存）+ 部署后用缓存路径冒烟 `tunnel-mode`。当前运行态 CLI 无此功能。

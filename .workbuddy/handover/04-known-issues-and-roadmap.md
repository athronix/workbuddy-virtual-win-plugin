# 04 · 已知问题、环境限制与完善方向

> 来源：`.dev/changing-log.md`（进行中/待定）+ `.workbuddy/memory/MEMORY.md` 真机未验证项 + 各轮日志的环境结论。

## A. 待真机终验（最高优先）

| # | 项 | 说明 | 阻塞程度 |
|---|---|---|---|
| A1 | **VM 侧真机 `--self-test`** | 本地同进程 e2e 已过；需在真实 Windows VM 上确认 ps-bridge 常驻进程在 VM 网络/权限上下文下稳定 | 中 |
| A2 | **`codebuddy` CLI 参数契约** | `CliLlmBridge` 默认假设 `codebuddy --goal "…" --system-prompt "…" --mcp <endpoint> --output <dir>`，**真机未验证**。若实际不同，经 provider options `cliArgTemplate` 覆盖即可（无需改代码） | 中（仅影响 LLM 路径） |
| A3 | **`hermes` 真机 CLI + MCP 自动加载** | `adapter-agent-hermes` 仅完成单元验证。需验证 `hermes` 真实拉起、`config.yaml.mcp_servers` 预注册生效、`HERMES_HOME`/`HERMES_CONFIG_PATH` 解析、junction 引用共享 Skills | 中（仅影响该 provider） |
| A4 | **SSH 隧道端到端** | 需真机建 `ssh -f -N -L 18443:127.0.0.1:18443` 后，从宿主 WorkBuddy 实际调一次工具闭环 | 高（决定可用性） |
| A5 | **双连接器在宿主侧同时生效** | 宿主安装会在 `mcp.json` 写 `connector:winvm`（MCP 直调）与 `connector:winvm-a2a`（A2A 桥）。需实测 WorkBuddy 是否同时拉起并启用；若只认一个，需改为单连接器合并工具面 | 高 |
| A6 | **真机 A2A 委派 + 共享 Skills 下发** | 验证共享根 `C:/WinVMBridge/shared-skills` 经 junction 被 VM 内 Agent 引用后能按 `skillsRoot` 读到 SKILL.md 并执行 | 中 |

> 另需用户侧操作：WorkBuddy「连接器管理页」对两个连接器点 **Trust** 才会真正激活。

## B. 环境限制（不是 bug，别当缺陷修）

| 现象 | 真实原因 | 正确应对 |
|---|---|---|
| `health` 返回 `state:"degraded"`、`interactive:false` | GUI 判定要求 `SessionId>=1 && WinSta0 && explorerAlive` 且**未锁屏**。经 SSH 触发或 VM 锁屏时窗口站为 `W`（非 WinSta0） | RDP 解锁桌面 + 确认 Explorer 在跑 → 在 **VM 内普通用户 PowerShell**（非管理员，否则落不同登录会话）跑 `schtasks /end` → `schtasks /run`。**判定刻意保留，勿放宽** |
| `check` 报端口未监听但服务在跑 | 旧版 `stdio:'ignore'` 吞 stdout 的**假阴性**已修（`9874092`）。若仍出现，先 `winvm-plugin health` 交叉验证 | 重部署（VM 上是旧副本） |
| RDP 里 `winvm-plugin` 找不到命令，SSH 里却能跑 | RDP 陈旧会话 env 未刷新（登录时一次性载入） | 注销重连；新版本写 PATH 后会广播 `WM_SETTINGCHANGE`，**新开**终端免注销（旧窗口仍需重开） |
| VM 卸载后回收站看不到删除物 | SSH 非交互会话的系统回收站写入**不会**反映到 RDP 桌面回收站 | 删除物默认落 `<repoRoot>/.uninstall-trash/<时间戳>/`，RDP 进 VM 可找回；或加 `--recycle-bin`（仅 RDP 内）/`--trash-dir` |
| 本地 curl 经隧道不通 | NekoBox TUN 模式拦截回环流量 | 加 `curl --noproxy 127.0.0.1` |

## C. 可增强（非阻塞）

- **能力广度**：5 大模块是代表性能力集（每域 5–8 工具）。注册表驱动，**新增只需改 `definitions.ts` + 对应 `.ps1`**，成本低。
- **审批闸 UX**：L2/L3 目前以 `input-required` / `requiresApproval` 在协议层表达；宿主侧确认 UX 取决于 WorkBuddy 原生支持，必要时在 Skill 层补「先拟指令、后请确认」模板。
- **更多宿主适配**：`host-sdk` 已中性化，可加 `adapter-host-claude` / `adapter-host-cursor` 等（实现 `RenderPlan` 渲染为对应原生格式）。
- **更多 VM Agent 适配**：可加 `adapter-agent-langgraph` 等，实现同一桥接 SPI 即可，Skills 与协议零改动。

## D. V1 明确不做

- 真实 GUI 自动化在 VM 内的 UI 点击回归（需显示器/会话；当前 GUI 模块提供截图 + UIA 定位 + 键鼠 API）
- 多 VM 联邦编排（当前单 VM）

## E. 建议的接手顺序

1. **先在新机跑通基线**：`npm run build` + 逐文件单测 214/214 + `vm-service --self-test`（不需要真 VM）
2. **重建 `.env`**（未入库），确认 VM 可达
3. **跑 A1 / A4**：真机 `--self-test` + SSH 隧道端到端调一次工具 —— 这两个决定「能不能用」
4. **跑 A5**：双连接器是否同时生效（决定宿主侧架构要不要改）
5. 再按需要处理 A2 / A3 / A6 与 C 类增强

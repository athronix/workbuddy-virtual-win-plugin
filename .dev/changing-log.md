# 进行中 / 待定 · changing-log

## 🟡 待在真实环境终验
- [ ] **VM 侧真机 `--self-test`**：当前 e2e 已在本地用 `vm-service` 同进程完成双通道验证；需在真实 Windows VM 上跑 `node packages/vm-service/dist/cli.js --self-test` 确认 ps-bridge 常驻进程在 VM 网络/权限上下文下稳定。
- [ ] **SSH 隧道端到端**：dry-run 已验证安装器产物；需真机建立 `ssh -f -N -L 18443:127.0.0.1:18443` 后，从宿主机 WorkBuddy 实际调用一次工具，闭环验证。

## 🟡 可增强（非阻塞）
- [ ] **能力广度**：5 大模块目前为代表性能力集（每域 5–8 个工具），可按需扩充；注册表驱动，新增只需改 `definitions.ts` + 对应 `.ps1`。
- [ ] **审批闸 UI**：当前 L2/L3 以 `input-required` / `requiresApproval` 协议层表达；宿主侧 WorkBuddy 的确认 UX 取决于其原生支持，必要时在 Skill 层补充"先拟指令、后请确认"的提示模板。
- [ ] **更多宿主适配**：`host-sdk` 已中性化，除 WorkBuddy 外可加 `adapter-host-claude`/`adapter-host-cursor` 等（实现 `RenderPlan` 渲染为对应原生格式）。
- [ ] **更多 VM Agent 适配**：V1 LLM provider `adapter-agent-workbuddy-llm`（`workbuddy` 选型）已实现，基于 VM 内 `codebuddy` CLI；后续可加 `adapter-agent-langgraph` 等，实现同一桥接 SPI。

## ⬜ 未做（按用户范围，V1 不实现）
- 真实 GUI 自动化在 VM 内的 UI 测试（需显示器/会话）；当前 GUI 模块提供截图+UIA 定位+键鼠 API，未跑真实点击回归。
- 多 VM 联邦编排（当前单 VM）。

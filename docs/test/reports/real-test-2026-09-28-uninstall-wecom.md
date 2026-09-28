# 真机复验报告 · 卸载 VM 企业微信（K3 修复核验）

- **日期**：2026-09-28
- **目的**：真实部署并验证一次「卸载 VM 中的企业微信」，核验 K3（A2A 变更类委派假成功）修复在真机 A2A 路径下是否如实返回「等待审批」而非假成功 `completed`，并确认审批闸（L2）正确拦截、目标未被实际卸载。
- **结论**：✅ **K3 修复生效 + 审批闸生效 + 零副作用**。企业微信经 A2A 委派后被 L2 审批闸 `APPROVAL_REQUIRED` 拦截，桥如实报告「等待审批 / 未执行完成」（`finalState=failed`，非 `completed`），VM 中 `WXWork.exe` 完好无损。

---

## 1. 复验前环境准备（部署动作）

隧道进程在 9/24 后已死亡（状态文件陈旧地标记 RUNNING），本地 `127.0.0.1:18443` 关闭。先真实恢复隧道：

```bash
PLUGIN=~/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0/winvm-plugin
$PLUGIN tunnel ensure   # 拉起真实隧道 (ssh2 进程内 daemon)
$PLUGIN tunnel status   # daemon pid 54953, TCP 18443 OPEN
```

- 隧道 daemon 拉起：**pid 54953**，`TCP 127.0.0.1:18443 OPEN`
- `GET /health` 经 daemon → **HTTP 200**（证明隧道真实转发正常，非仅监听）
- 宿主 `health` 探测真实通过：`psBridge.ready`、`54/54` 能力可用、`desktop.interactive=true`

## 2. A2A 委派驱动（真实路径）

驱动脚本（`$HOME/wbtmp/drive-a2a.mjs`）动态导入已部署 `a2a-bridge/client.js`，经 daemon 连 `127.0.0.1:18443`，委派目标：

> **目标**：卸载 VM 中的企业微信（WeCom / WXWork）
> **通道**：A2A 委派（触发 VM 侧 LLM 适配器 `bridge.ts` 的 `reconcileApprovalWait` —— K3 修复落点）
> **风险档**：`maxRisk=L2`（卸载 = 变更类强制审批闸）
> **超时**：`timeoutMs=200000`（覆盖 LLM 冷启动）

## 3. 关键结果

| 项 | 结果 |
|----|------|
| `finalState` | **`failed`**（非 `completed`）✅ |
| 终态消息 | 「**等待审批：高危操作被宿主审批闸拦截（APPROVAL_REQUIRED）…未执行完成**」 |
| 审批令牌 | 已下发（`approvalId=apr_96b52efa35e64484876a`），按设计须宿主人工审批后经 MCP 直调通道续跑 |
| 是否假成功 | **否** —— K3 修复前会谎报 `completed`，现已如实判 `failed` |

**判定**：桥未将「被审批拦截」谎报为「已完成」。K3 修复的「结果如实性改判」（`reconcileApprovalWait`）在真机 A2A 路径上生效。

## 4. 安全双查（只读核验，确认未被卸载）

经 SSH 只读核验 VM 安装态（`.ps1` + scp + `-File` 方式，规避 MSYS `$_` 吞参坑）：

```
EXE | C:\Program Files (x86)\WXWork\WXWork.exe | 270306.8KB | 09/10/2026 04:10:12
```

- 企业微信主程序 `WXWork.exe` **仍在**默认安装位，LastWriteTime `09/10/2026`（早于本次测试日 09/28），无任何写入/删除痕迹。
- 结论：**卸载动作从未执行**，A2A 委派在审批闸前即被拦截。

## 5. 证据链闭环（三端对齐）

1. 仓库 `bridge.ts`（`reconcileApprovalWait` ×3 + `APPROVAL_REQUIRED` ×7/8）
2. 宿主缓存 CLI（md5 与仓库一致，f2490079 区间）
3. VM dist `bridge.js`（`reconcileApprovalWait` ×3 + `APPROVAL_REQUIRED` ×7）
4. 真机 A2A 委派行为：`finalState=failed` + 「等待审批」措辞 + `WXWork.exe` 完好

## 6. 遗留与建议

- **未复验项**：审批通过后「经 MCP 直调通道续跑完成卸载」的完整闭环（需宿主人工审批 `/mcp` 续跑 `app.winget.uninstall`）。本次仅验证到审批闸拦截点，符合 K3 复验范围。
- **可选 P2**：`reconcileApprovalWait` 直接单测 2-3 条（启发式兜底依赖 LLM 措辞，根治 = bridge 直读 MCP 结构化工具结果）。
- 隧道 daemon 状态显示「重连中」为其内部探针偏保守，数据通路（HTTP 200 / A2A 流）实际正常，不影响本次验证。

---
*复验执行：主理人直接驱动（Agent 模式），无需重启团队。脚本留存 `$HOME/wbtmp/{drive-a2a.mjs,find-wecom.ps1,wecom-verdict.ps1,check-wecom*.ps1}`。*

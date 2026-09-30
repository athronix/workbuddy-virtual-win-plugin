# R17-T04 · 连接器工具注入根因诊断报告（骨架，真机填充）

> 状态：**骨架 + 本机已实测点已填 · 新会话实测 BLOCKED 待 QA / 用户真机复跑**
> 关联：`docs/design/r17-design.md` §A1.2（R2 方案）、裁定 Q3（诊断 + 规避 + 文档 + 门禁兜底，不做平台根治）、任务 T04
> 诊断工具：`delivery/tools/diagnose-connectors.mjs`（纯只读：零写入 / 零 spawn / 零网络 / 零解密）

## 1. 问题陈述

winvm / winvm-a2a 连接器已由安装器注册进全局 `~/.workbuddy/mcp.json`（commit `d183a76` 引入全局注册块），
但**新会话的工具面经常不注入** `winvm__*` / `a2a.*` 工具，导致宿主 agent 无工具可用。

已知两类表现需分开归因：

- **旧会话不注入**：WB 会话生命周期行为（会话建立时快照工具面，之后不热注入）——**属预期，非缺陷**；
- **新会话不注入**：注册面就位的前提下仍不注入，**疑属 WB 平台缺陷**（本报告第 4 节给上报材料）。

## 2. 归因边界（设计裁定 Q3）

工具注入完全发生在 WB 平台侧：加载时机、trust/enabled 状态文件（`connector-states.v3.json`，可能为加密态）、
stdio 子进程拉起策略，均不在本插件控制范围内。本插件**可交付面**因此界定为四件套：

| 交付面 | 落点 | 状态 |
|---|---|---|
| ① 只读诊断 | `delivery/tools/diagnose-connectors.mjs` | ✅ 已交付（本机实跑 exit 0） |
| ② 安装期一致性自检 | `delivery/install-host.mjs` 末尾 `runConnectorSelfCheck()` | ✅ 已交付（dry-run 零副作用核验通过） |
| ③ 自助路径文档化 | `docs/INSTALL-GUIDE.md` §8.1 | ✅ 已交付 |
| ④ 门禁兜底 | `skills/winvm-orchestrator/SKILL.md` §强制门禁「工具缺失指引」 | ✅ 已交付（既有 5 条禁令零改动） |

**不做**：平台侧根治、trust 文件解密逆向、任何绕过会话生命周期的注入 hack、手写脚本直连通道。

## 3. 诊断矩阵（mcp.json 就位 × trust 态 × 会话新旧 → 预期注入结果）

图例：✓=注入 winvm/winvm-a2a 工具；✗=不注入；❓=未实测（BLOCKED）。

| # | 全局 mcp.json | 账户 mcp.json | trust/enabled（连接器页） | 会话 | 预期注入结果 | 证据 / 状态 |
|---|---|---|---|---|---|---|
| M1 | 空（无 winvm 条目） | — | — | 新 | ✗ 连接器页与会话面均不可见 | **实测 9/29**：卸载后全局 mcp.json 为空 → 连接器页不显示 winvm，会话无工具。触发 `d183a76` 加全局注册块 |
| M2 | 两条就位 | 活跃账户就位 | 未信任 / 未启用 | 新 | ✗（平台按 trust 态过滤工具面） | 推断项；由诊断 WARN（`disabled=true` / states 缺失）引导用户去连接器页启用（§8.1 步骤①） |
| M3 | 两条就位 | 活跃账户就位 | 已注册 + 已启用 | **旧**（注册前已建立） | ✗ **属预期**——WB 会话生命周期不热注入 | **实测 9/30**：注册并启用后，旧会话仍不注入；重开新会话为唯一正解（§8.1 步骤②） |
| M4 | 两条就位 | 活跃账户就位 | 已注册 + 已启用 | **新** | ✓（预期；若仍 ✗ → 升级 WB 缺陷上报） | **BLOCKED 待填**：需 QA 连续 ≥3 个全新会话 ToolSearch 实测（见第 5 节） |
| M5 | 两条就位 | 仅部分账户就位 | 已启用 | 新（切到无条目账户） | ✗（该账户增量注册缺失） | 诊断 WARN「账户 X 无 winvm 条目」；重跑 install-host 遍历全部账户补写（本机 9/30 实测：uuid 账户缺失即此形态，default/skills 就位） |
| M6 | command 指向的 node 缺失 / 不可执行 | — | — | 新 | winvm（MCP 直调）可注入；winvm-a2a（stdio）拉起失败或工具缺失 | 本机实测 node `/data/storage/el1/bundle/libs/arm64/node/bin/node` mode=755 可执行 ✓；异常形态为推断项（诊断 FAIL 第④项覆盖） |

### 3.1 本机（鸿蒙宿主）2026-09-30 诊断快照

```
[1] 全局 mcp.json：winvm ✓ streamableHttp http://127.0.0.1:18443/mcp；winvm-a2a ✓ stdio cmd=.../node args=5
[2] 账户级：default ✓ / skills ✓（connector:winvm + connector:winvm-a2a）；8dd0df6a-…f0f8 ✗ 无条目（WARN）
[3] connector-states.v3.json：不存在 → 提示去连接器页首次「信任+启用」（WARN，不判 FAIL）
[4] stdio command：node 存在 / mode=755 / 可执行 ✓；桥入口 cli.js 存在（5481 B）✓
结论：ok=true，exit 0（注册面就位）
```

## 4. WB 平台缺陷上报（占位 · 待 M4 实测坐实后填充）

> 仅当 **M4 = ✗**（注册全就位 + 已信任启用 + 全新会话仍不注入）时成立并上报；M3 属预期行为，**不要**作为缺陷上报。

**① 现象**（待填实测细节）：
- 版本：WorkBuddy `____`（宿主 OHOS/HarmonyOS NEXT PC，`____` build）
- 时间：`____`；账户：`____`（uuid / default）
- 全局 `~/.workbuddy/mcp.json` 含 `winvm`（streamableHttp）与 `winvm-a2a`（stdio）两条目且 `disabled:false`；
  诊断工具输出 `ok=true`（附 JSON）；连接器页显示两条目已信任已启用；
- 全新会话内 ToolSearch 查询 `winvm` / `a2a.delegate` 无命中；会话工具清单快照：`____`

**② 复现步骤**：
1. `node delivery/install-host.mjs`（确认输出「全局 mcp.json : 已增量合并 winvm / winvm-a2a」+ 自检「注册面就位 ✓」）；
2. WorkBuddy 重启 → 连接器页确认 winvm / winvm-a2a 已「信任 + 启用」；
3. 新建会话（非既有会话）→ ToolSearch 搜索 `winvm__*` 与 `a2a.*`；
4. 期望：命中；实际：`____`（连续 N=`____` 次结果：`____`）；
5. 对照实验：同宿主其它 MCP 连接器（如 `____`）在同一新会话中 `____` 注入 → 可排除环境级因素。

**③ 环境信息**：
- 宿主 OS / 架构：`____`；WB 安装形态：`____`
- node（stdio command）：`/data/storage/el1/bundle/libs/arm64/node/bin/node`（mode 755，实测可执行）
- 诊断 JSON 全文：粘贴 `node delivery/tools/diagnose-connectors.mjs --json` 输出
- 相关日志路径（WB 侧）：`____`（如有）

## 5. 待办与验收口径（BLOCKED 项）

- [ ] **M4 真机实测**（QA T05 口径）：连续 ≥3 个全新会话 ToolSearch 命中 `winvm__*` / `a2a.*`，且 `a2a.health` 可达 → M4=✓ 结案；任一不命中 → 填第 4 节上报材料并复测确认非偶发。
- [ ] M2 反例实测：连接器页「取消启用」后新会话是否确实不注入（坐实 trust 过滤路径）。
- [ ] connector-states.v3.json 在连接器页首次信任后是否生成 / 是否加密态（本机当前不存在，诊断如实 WARN）。
- [ ] 若上报成立：跟踪 WB 修复版本，回写本报告结论并同步撤销/收敛 §8.1 临时路径文案。

## 6. 结论

注入根因最终归属取决于 M4 真机实测；在此之前，本项目可交付面即：**诊断（工具 + 安装期自检）+ 规避（重开新会话 / 连接器页启用）+ 文档化（§8.1）+ 门禁兜底（SKILL.md 工具缺失指引：工具不可用 → 停止并请求启用连接器，严禁手写脚本绕行）**。该交付面不依赖平台修复即可闭环，不阻塞 R1 / R3。

〔出处：delivery/tools/diagnose-connectors.mjs 本机实跑（2026-09-30）+ r17-design.md §A1.2/Q3 + 9/29、9/30 实测记录〕

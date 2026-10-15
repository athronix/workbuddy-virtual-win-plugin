# 应用场景 · WinVM 跨机 Agent 插件（1+5 双通道方案）

> 本文用**故事 + 流程 + 机制 + demo** 四类信息，把"宿主机 WorkBuddy 完全操作 Windows 虚拟机"
> 的能力讲透。覆盖：确定性生产（MCP 直调）、办公生产（COM）、网页生产、开放创意生产
> （A2A + LLM VM Agent）、多应用协作、监管闭环，以及一键部署配套。

---

## 0. 场景总览

| 场景 | 任务性质 | 通道 | 关键能力域 | 是否需 LLM VM Agent |
|---|---|---|---|---|
| A. 音视频转码 | 确定步骤（CLI） | MCP 直调 | `appops.cli.invoke` | 否 |
| B. Office 文档生产 | 确定步骤（COM/宏） | MCP 直调 | `appops.com.automate` / `workflow.run` | 否 |
| C. 网页端生产 | 半确定（需看屏决策） | A2A 委派 | `gui.*` 原语（截图/UIA/键鼠）+ `appops.gui.produce` | 否（确定性可枚举）|
| D. Photoshop 创意合成 | **开放意图**（大山→海洋） | A2A 委派 | LLM 规划 + `appops.*` / `gui.*` | **是（推荐）** |
| E. 多应用协作流水线 | 混合 | A2A 委派编排 | 跨域组合 | 可选 |
| F. 监管闭环 | 全程 | 双通道 | 策略/审批/审计 | 否 |

> **核心判据**：任务能否预先分解为确定步骤（调什么 CLI / 点哪里）？
> - 能 → **MCP 直调**（透明、省 token、可复现）
> - 不能（需语义理解、需看屏反复判断）→ **A2A 委派**；若还要"自主规划任意应用"，升级到 **LLM VM Agent**

---

## A. 音视频转码（确定性 · MCP 直调）

**故事**：你有一段 4K 录屏 `demo.mov`，要发给同事一个 720p 的 MP4 和一个动图 GIF。
你不想在宿主机装 ffmpeg，也不想让录屏离开本机网络——直接让 VM 里的 ffmpeg 干。

**流程**：
```
宿主 WorkBuddy
  │ 意图："把 demo.mov 转成 720p mp4 + gif，放 VM 的 WinVMWorkspace/out"
  ▼
winvm-orchestrator（总控）
  ├─ 隧道就绪检查（ssh -L 18443）✅
  ├─ meta.health.check ✅
  └─ 路由：生产任务 → winvm-app-operation
  ▼
winvm-app-operation
  ├─ 通道选择：步骤确定 → MCP 直调
  └─ 调用 appops.cli.invoke(app=ffmpeg, command="...")
  ▼
vm-service → adapter(deterministic) → vm-capabilities → ps-bridge → ffmpeg.exe
  ▼
产物落 C:\WinVMWorkspace\out\{demo_720p.mp4, demo.gif}
```

**机制**：`appops.cli.invoke` 把应用 CLI（ffmpeg/magick/soffice/pandoc/node/python）封装为
一条 MCP 工具；输出目录受 `pathAllowlist` 约束（`C:\WinVMWorkspace`、`%USERPROFILE%\WinVMWorkspace`），
越界被策略拒绝。`snapshot: 'after'` 保证执行后自动回传产物清单。

**Demo（MCP 工具调用）**：
```jsonc
// 工具名即能力 ID（宿主侧前缀 winvm__）
winvm__appops_cli.invoke({
  "app": "ffmpeg",
  "command": "ffmpeg -i in/demo.mov -vf scale=1280:720 -c:v libx264 -crf 23 out/demo_720p.mp4",
  "outputDirectory": "C:\\WinVMWorkspace\\out"
})
winvm__appops_cli.invoke({
  "app": "ffmpeg",
  "command": "ffmpeg -i in/demo.mov -vf \"fps=10,scale=480:-1\" out/demo.gif",
  "outputDirectory": "C:\\WinVMWorkspace\\out"
})
```
返回：`{ ok:true, artifacts:[{kind:'file', path:'C:\\WinVMWorkspace\\out\\demo_720p.mp4'}, ...] }`

---

## B. Office 文档生产（COM 自动化 · MCP 直调）

**故事**：销售部每天要把 50 份 Word 模板填好客户名，导出成 PDF 归档。VM 里装了 Office，
用 COM 自动化一口气批量出 PDF，全程无需打开窗口点鼠标。

**流程**：
```
winvm-orchestrator → winvm-app-operation
  └─ 通道选择：步骤确定（COM 脚本） → MCP 直调
       ├─ appops.com.automate(progId="Word.Application",
       │     script="打开 $doc → 替换书签 → ExportAsFixedFormat PDF",
       │     documentPath="C:\\WinVMWorkspace\\in\\tpl.docx",
       │     outputPath="C:\\WinVMWorkspace\\out\\tpl.pdf")
       └─ 或 appops.workflow.run(workflow="word_batch_pdf",
       │     params={inDir, outDir, bookmarkMap})
```

**机制**：`appops.com.automate` 通过 `New-Object -ComObject` 驱动支持 COM 的桌面应用。
PowerShell 端在 `finally` 中强制 `Quit()` + `ReleaseComObject` + `[GC]::Collect()`，
杜绝 COM 对象泄漏导致 Office 进程常驻（已知陷阱见 Skill 文档）。`requiresSession` 标记
表示需要交互式会话（Office 自动化在无桌面会话会失败）。

**Demo（MCP 工具调用）**：
```jsonc
winvm__appops_com.automate({
  "progId": "Excel.Application",
  "script": "打开 数据.xlsx → 选中区域 → 插入透视表(按 部门) → 导出 PDF",
  "documentPath": "C:\\WinVMWorkspace\\in\\数据.xlsx",
  "outputPath": "C:\\WinVMWorkspace\\out\\部门透视表.pdf"
})
```
> 风险：写盘/导出 → L2，需审批闸 + before/after 快照（见场景 F）。

---

## C. 网页端生产（半确定 · A2A 委派）

**故事**：运营要在某后台把 1~50 页的月度报表逐页截图存档。步骤可枚举（登录→翻页→截图），
但每页要"看屏幕确认加载完成再截"，适合 A2A 委派让 VM Agent 自己循环跑并回传截图。

**流程**：
```
宿主 WorkBuddy
  │ A2A message/send { goal:"登录后台，把 1~50 页报表逐页截图存 out/" }
  ▼
vm-service → adapter(deterministic).runGoal(模板: 网页生产)
  ├─ app.process.launch(target=https://backoffice…): 打开浏览器并导航
  ├─ 登录：gui.uia.tree/gui.uia.invoke（页面 DOM 经 UIA 暴露）+ gui.input.keyboard
  ├─ loop 1..50:
  │    gui.wait.condition(screenStable) → gui.screen.capture → 存 out/page_N.png（artifact 回传）
  │    翻页：gui.uia.invoke / gui.input.mouse
  └─ 进度流（working）+ 每页截图 artifact
```

> 注：CDP 直驱（原设想的 `gui.browser.control`）**当前未注册**（V2 规划），本场景以已注册
> `gui.*` 原语组合实现；`gui.browser.control` 落地后可无缝升级导航/填表/DOM 提取精度
> （见 `CAPABILITY-MODEL.md` §3.4 注记）。

**机制**：强 GUI + 多步 + 需"看屏决策" → A2A 委派。`ProgressSink` 把每页截图作为
`artifact` 实时流回宿主，宿主可中途 `input-required` 挂起审批或叫停。**确定性 V1 也能做
C 类任务**（因为步骤可枚举）——只有 D 类这种真正的开放意图才必须 LLM VM Agent。

**Demo（A2A message/send）**：
```jsonc
POST /a2a  (Agent Card: /.well-known/agent-card.json)
{
  "method": "message/send",
  "params": {
    "message": {
      "role": "user",
      "parts": [{ "kind": "text", "text": "登录 https://backoffice.example.com，把 1~50 页报表逐页截图存 out/" }]
    },
    // 两键的契约真实载体是 params.metadata（服务端装配判序见 a2a-framework/server.ts:244-271，
    // 示例口径对齐 INTERFACES §3.4；2026-10-13 批0 按实况订正旧 key 名 context→metadata）
    "metadata": {
      "allowedCapabilities": ["gui.*", "appops.gui.produce", "storage.*"],
      "maxRisk": "L1"
    }
  }
}
```
> **两键兑现现状（批1 接线已落地 · 2026-10-14 订正，详见 `docs/02-design/SECURITY-GOVERNANCE.md` §2.3）**：`allowedCapabilities`/`maxRisk` 三处生产调用点**已接线**进入策略评估实参，但**缺省灰度=`shadow`（评估+观测、不执法）**；本示例展示可声明的字段形状，缺省形态下**不得**读作已生效的限权/封顶（执法需运维显式 `WINVM_POLICY_GATE_WIRING=on`，口径见 §2.3）。真正拦阻 L2/L3 的缺省生效闸仍是审批闸 + 直调 `DELEGATION_REQUIRED` 收口。

流回：`tasks/subscribe` 收到 N 条 `working` + N 张截图 artifact，最终 `completed` 带汇总。

---

## D. Photoshop 创意合成「大山 → 海洋」（开放意图 · A2A + LLM VM Agent）

**故事（用户原话）**：*"在 Windows 里用 Photoshop 帮我把这张照片里的大山背景 PS 成海洋。"*

这是**原始 4 个 Skill 漏掉的那一维**——开放/创意类自然语言目标：没有现成脚本、需要理解
语义（识别山体、生成海洋、做内容识别填充）、需要看屏幕反复微调。

**为什么 V1 确定性执行器直接做不了**：`adapter-agent-workbuddy`（`kind: deterministic`）
只认预置工作流与模板化目标。把"大山换成海洋"交给它，会命中 `runGoal` 模板 5 的兜底分支，
返回 `UNSUPPORTED_GOAL`（工作流未登记，不硬猜、不伪造）。**这是设计使然，不是缺陷。**

**如何补齐（框架零改动）**：把 `agent.provider` 从 `workbuddy-deterministic` 切到
**LLM provider** `workbuddy`（VM 内 WorkBuddy `codebuddy` CLI），改一行配置即可
（现已实现，见 `LLM-PROVIDER.md` 与 `SPEC-AGENT-SERVICE-BRIDGE.md §6.1`）。之后 VM Agent
在 VM 交互式会话内带全套应用 Skill，自主规划并操作 Photoshop。

**端到端流程（LLM VM Agent 接管后）**：
```
宿主 WorkBuddy
  │ A2A message/send { goal:"用 Photoshop 把这张照片里的大山背景换成海洋",
  │                    context:{ imageRef: "<宿主传来的图片 artifact>" } }
  ▼
vm-service → adapter(workbuddy) [kind: llm-agent].runGoal
  │  LLM 解析：目标=图像合成；应用=Photoshop；输入=图片 artifact；输出=换背景图
  │  LLM 规划多步：
  │    1. 打开 PS，载入图片（appops.gui.produce / gui.uia.invoke）
  │    2. 用"对象选择/快速选择"分离天空与山体（看屏判断选区质量 → gui.screen.capture 回传）
  │    3. 内容识别填充 / 生成式扩展，填入海洋素材（或本地扩散模型）
  │    4. 调色、去生硬边缘（看屏微调，再回传截图给宿主确认）
  │    5. 导出 PNG 到 out/（appops.com.automate 或 gui 导出菜单）
  ▼
每步过 策略引擎 + 审批闸（L2 导出/覆盖需确认）+ 审计链
每步 artifact 回传（截图 / 中间产物 / 最终图）
  ▼
A2A tasks/get → 成功摘要 + 前后对比图 + 导出文件 artifact
```

**机制要点**：
1. **能力内核不变**：LLM provider 比确定性 V1 多做的，是"在 `appops.*` / `gui.*` 之上叠加语义
   理解与自主规划"。底层仍是 ps-bridge → PowerShell → UIA / COM，与 V1 共用同一安全内核。
2. **监管不降级**：LLM 的每一步仍逐条过策略/审批/审计，before/after 快照强制回传。LLM 带来
   "开放性"，框架带来"可监管性"，二者正交。
3. **宿主侧零感知**：A2A Agent Card 的 `skills[]` 由 `declareCapabilities()` 自动收敛，宿主
   协议层完全一致——无需关心 VM 内是确定性还是 LLM。

**Demo（A2A message/send，开放目标）**：
```jsonc
POST /a2a
{
  "method": "message/send",
  "params": {
    "message": {
      "role": "user",
      "parts": [{ "kind": "text", "text": "用 Photoshop 帮我把这张照片里的大山背景换成海洋，调色自然一点" }]
    },
    // 2026-10-13 批0 按实况订正：两键与 imageRef 的契约载体是 params.metadata
    //（服务端 context 由 message.metadata 派生，见 a2a-framework/server.ts:264；旧示例误写独立 key "context"）
    "metadata": {
      "imageRef": "artifact://host/upload/mountain.jpg",
      "allowedCapabilities": ["appops.*", "gui.*"],
      "maxRisk": "L2"
    }
  }
}
```
> 若 VM 仍是 V1 确定性，本目标会返回 `UNSUPPORTED_GOAL`，并附带明确引导：
> ① 预置 `generic_production` 工作流；② 升级 `agent.provider` 为 LLM（框架零改动）。
> **两键兑现现状（批1 接线已落地 · 2026-10-14 订正，同 §C 注与 `SECURITY-GOVERNANCE.md` §2.3）**：`allowedCapabilities`/`maxRisk` 服务端执行面**已接线**，但缺省灰度=`shadow`（评估+观测、不执法），不得读作已生效限权/封顶（执法需显式 `WINVM_POLICY_GATE_WIRING=on`，详见 §2.3）。

---

## E. 多应用协作流水线（混合 · A2A 编排）

**故事**：每周自动产出一份《竞品动态周报》：抓竞品官网 → 关键页截图 → 剪辑成短视频 →
汇总成带图的 Word 报告。单一应用在 MCP 做，跨应用的"编排"交给 A2A 委派。

**流程**：
```
A2A message/send { goal:"生成本周竞品动态周报（图文+短视频）" }
  │
  ├─ ① 网页抓取：app.process.launch + gui.* 原语（UIA/键鼠/等待）抓 3 个竞品首页 → 截图存档
  ├─ ② 视频剪辑：appops.cli.invoke(ffmpeg) 把截图拼成 30s 快闪视频
  ├─ ③ 文档汇总：appops.com.automate(Word) 把截图+视频嵌入周报模板 → 导出 PDF
  └─ ④ 回传：周报 PDF + 视频 MP4 作为 artifact
```
每个子步骤可独立走 MCP 精确调用或 A2A 子任务；编排逻辑由宿主（或 LLM VM Agent）按
`winvm-orchestrator` 的路由规则组合。产物一律落 `out/`，源文件不覆盖。

---

## F. 监管闭环（贯穿所有场景）

无论 MCP 还是 A2A，任何操作都过同一套三道闸（详见 `SECURITY-GOVERNANCE.md`）：

```
能力调用 / 目标委派
   │
   ├─ ① 策略引擎（core/policy）
   │     L0–L3 风险分级 · 路径黑名单（系统区全禁）+ 白名单（仅 WinVMWorkspace）
   │     命令黑名单（format/diskpart/编码混淆）· 进程黑名单
   │
   ├─ ② 审批闸
   │     L2/L3：MCP 通道 requiresApproval；A2A 通道置 input-required 挂起
   │     宿主经 `a2a.approval.reply` 批准后服务端重放续跑；超时 fail-closed 拒绝
   │
   └─ ③ 防篡改哈希链审计（core/audit）
         每条含 traceId/能力/参数（敏感键打码）/风险/判定/结果/前后哈希
         完整性经 GET /health 的 chainValid 校验；内容回看读 VM 侧 audit/*.jsonl
         （`--audit` CLI 与 `meta.audit.query` 均为 V2 规划·当前不可用）
```

**Demo（L2 审批闸在 A2A 的表现）**：
```jsonc
// VM 返回：任务挂起待审批
{ "state": "input-required",
  "message": "步骤[导出 PDF]为 L2 操作，需确认是否允许写入 C:\\WinVMWorkspace\\out\\tpl.pdf",
  "approvalId": "apr_8f3c" }
// 宿主批准后（真实通路：宿主工具 a2a.approval.reply，参数如下）：
a2a.approval.reply { "taskId": "task_...", "approvalId": "apr_8f3c", "approved": true }
// 等价底层 JSON-RPC（服务端 dispatch 只认 message/send / tasks/get·list·cancel·subscribe / agent card，
// 续跑 = 带审批结果的 message/send，不存在其它续跑方法）：
POST /a2a  { "method": "message/send", "params": { "message": {
  "role": "user", "taskId": "task_...",
  "parts": [{ "kind": "data", "data": { "approvalId": "apr_8f3c", "approved": true } }] } } }
// 服务端 continueTask → resolveApproval 放行 → 任务重放续跑
```

**before/after 快照**：`appops.gui.produce`（L2, destructive）强制 `snapshot: 'before-after'`，
自动在导出前/后各截一图，作为 A2A artifact 回传，宿主可对比确认无意外覆盖。

---

## G. 一键部署配套（两端各一个脚本 + 双端总入口）

**双端总入口（推荐）** —— `delivery/setup.mjs`：读 `.env`，一条命令完成「构建 → 宿主侧 →
VM 侧 → 隧道 → 自检 → /health 探测」六阶段；默认 `--dry-run` 只规划，加 `--apply` 才真执行
（真执行的**唯一**入口就是 `--apply`，`.env` 写 `WINVM_DRY_RUN=0` 也不会自动执行）。
VM 侧 AI Agent 选型经 `.env` 的 `WINVM_VM_PROVIDER`（透传 `--provider`）落地，详见
`DEPLOYMENT.md §1`。
```bash
cp .env.example .env      # 填写 HOST_DEPLOY / VM_DEPLOY / VM_HOST / WINVM_VM_PROVIDER …
node delivery/setup.mjs            # dry-run 预览
node delivery/setup.mjs --apply    # 真正部署双端 + 建立隧道 + 自检
```

**宿主机（控制端）** —— `delivery/install-host.mjs`：
```bash
node delivery/install-host.mjs --dry-run --host 192.168.1.77 --user vmadmin
node delivery/install-host.mjs            --host 192.168.1.77 --user vmadmin
# 渲染 6 个 Skill + plugin.json + marketplace.json + 增量合并 mcp.json + 静态禁用高危工具
node delivery/install-host.mjs --uninstall
```

**虚拟机（被控端）** —— `delivery/install-vm.mjs`：
```powershell
node delivery/install-vm.mjs --dry-run                              # 预览步骤，不写盘
node delivery/install-vm.mjs                                        # npm ci + build + 生成配置 + 注册自启任务 + 自检
node delivery/install-vm.mjs --provider workbuddy --cli codebuddy   # 选用 LLM VM Agent（默认仍 deterministic）
node delivery/install-vm.mjs --self-test                            # 仅自检（五大模块/配置/provider 能力目录/回环）
node delivery/install-vm.mjs --uninstall                            # 停任务 + 移除自启 + 清理生成物
```
> VM 服务**仅监听 127.0.0.1**；自启任务注册为"登录即启 / 崩溃重启 ×3 / 仅交互式会话运行"，
> **不注册为 Windows 服务**（避免 Session 0 黑屏）。

两端脚本配对，回答了用户 Q4："插件含两部分——宿主机插件 + VM 内服务（vm-service +
基于 VM PowerShell+.NET 的 MCP 能力 + 基于 VM Agent 的 A2A 服务），且两边都配套了一键部署脚本。"

---

## H. 能力域 × 场景 对照速查

| 能力 ID | 风险 | 典型场景 | 通道 |
|---|---|---|---|
| `appops.state.query` | L0 | 查 VM 内正运行的生产型应用/打开的文档 | MCP |
| `appops.cli.invoke` | L1 | ffmpeg 转码、pandoc 转 DOCX、magick 批处理 | MCP |
| `appops.workflow.run` | L1 | 预置的生产流水线（Excel 报表/视频批处理） | MCP / A2A |
| `appops.com.automate` | L1 | Word/Excel COM 自动化导出 | MCP |
| `appops.gui.produce` | **L2** | 多步 GUI 生产（开放意图下由 LLM 规划步骤） | A2A |
| `gui.uia.tree` / `gui.uia.invoke` / `gui.input.*` | L0/L1 | 网页端生产（浏览器经 UIA+键鼠驱动；CDP 直驱 `gui.browser.control` 为 V2 规划·当前不可用） | MCP / A2A |
| `gui.screen.capture` | L0 | 看屏核对、artifact 回传 | 任意 |

> 更多通道/能力细节见 `CAPABILITY-MODEL.md`、`SPEC-SKILLS.md`、`SPEC-AGENT-SERVICE-BRIDGE.md`。

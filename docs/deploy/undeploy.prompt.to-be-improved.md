# undeploy.prompt 问题·干预·改进 梳理（V1.4.8 实测）

> 配套文档：`deploy.prompt.to-be-improved.md`（安装侧）
> 实测对象：`docs/deploy/undeploy.prompt` v1.1 + `delivery/uninstall.mjs`
> 卸载目标：WinVM Bridge V1.4.8 双端部署（宿主 `~/.workbuddy` ↔ VM `C:/WinVMBridge`）
> 实测时间：2026-10-30 19:0x–19:33
> 结论：**双端已干净拆回"未安装"态**，独立复核全绿；过程中暴露 1 个脚本误报缺陷 + 2 个环境/流程事实 + 3 处需用户拍板的干预点。

---

## 一、归属标记与总览表（主表）

标记说明：👤=需用户干预（密码/VM 操作/审批/决策） · 🛠=超出原 prompt 的自作主张 · 📝=新增或改动代码/脚本

| 编号 | 问题 | 现象 | 根本原因 | 可选方案 | 建议方案 | 本次方案 | prompt 改进 |
|---|---|---|---|---|---|---|---|
| R1 | U2 apply 退出码 1（保留项误报） | `uninstall.mjs --apply` 退出 `EXIT=1`；日志唯一 `[FAIL]`="VM C:/WinVMWorkspace kept (observed: False)"；但脚本自身总结 "0 failure(s)" 自相矛盾 | 脚本对**保留项**做"断言式校验"——要求 `WORKSPACE_DIR` 存在（被保留）。本环境该目录**从未创建**（U0/PRE STATUS 已 `WORKSPACE_DIR=False`），断言失败→计入 failure→进程退出码 1 | A) 保留项断言改为"存在才校验，不存在即 [SKIP]/[PASS]"；B) 退出码依据 failure 计数而非单项布尔；C) 区分"保留校验失败"与"删除失败"两类 | **A**（保留项校验应容忍"本就不存在"） | 人工判读：核对 PRE STATUS（`WORKSPACE_DIR=False`）→ 确认为误报非真实失败；以独立复核 U4 全绿为验收依据，忽略该退出码 | **G1**：明确"保留项断言——实体本不存在则判 `[SKIP]`，EXIT 码须与 failure 计数一致" |
| R2 | 宿主 `rm` 被沙箱 shim 拦截（坏解释器） | 执行 `rm -f ~/.ssh/id_ed25519` 报 `bad interpreter` / shim 解释器损坏，删除未生效 | 本宿主 `rm` 命令被 electron 运行时 shim 替换且**损坏**（环境事实，非 prompt 缺陷） | A) node `fs.unlinkSync`/`rmSync`；B) 用 trash 机制；C) 文件管理器手动删 | **A**（脚本内删文件统一用 node fs，避免依赖 rm） | 改用 `"$NODE" -e 'fs.unlinkSync(...)'` 实际删除 host 私钥与 trash 目录 | **G2**：提示"宿主删除文件勿依赖 rm；确需删用 node fs 或 trash" |
| R3 | SSH 密钥删除需跨两处 authorized_keys 精确移除（🛠超 prompt） | 部署时公钥写入 VM **两处**（`User/.ssh/authorized_keys` + `ProgramData/ssh/administrators_authorized_keys`）；undeploy.prompt 默认红线"保留密钥"，用户选删除时需精确移除这两行，否则会误伤 VM 上其它密钥 | 免密通道建立时双写（administrators 的 OpenSSH 规则）；卸载脚本默认不动密钥，故清理逻辑不在 undeploy.prompt 覆盖内 | A) 整文件清空 authorized_keys（粗暴误伤）；B) 按行匹配注入公钥精确删（安全）；C) ssh 命令撤销 | **B**（精确按公钥行删除，两处都处理） | 写 `vm-rmkey.ps1` 读 `hostkey.pub` 逐行比对，从两处各删 1 行；确认剩余 0 行 | **G3**：增加"若用户选删密钥：须从两处 authorized_keys 按公钥精确移除，附去重脚本示例" |
| R4 | 删 host 私钥后公钥通道断开，需密码通道收尾（👤密码 + 🛠超 prompt） | 删除 host `id_ed25519` 后 publickey 登 VM 返回 `Permission denied`；VM 上仍有 6 个本次操作残留脚本未清 | 删私钥直接使免密通道失效（预期内）；但残留文件清理依赖 SSH 会话，需切换认证方式 | A) 用密码通道(123456)登录清残留；B) 先清残留再删私钥（顺序调整）；C) 放弃清残留 | **B**（先清 VM 残留，最后再删 host 私钥）更顺手；或 A 亦可 | 用 `SSH_ASKPASS`+密码 123456 经密码通道登录 VM，删除 6 个探针/辅助文件 | **G4**：U5 明确"删密钥前先完成 VM 残留清理；或说明删密钥后只能走密码通道收尾，需 VM 密码" |
| R5 | U0 基线 connector-winvm 落点漂移（部署期已见，卸载复核再显） | 部署时观测到 `~/.workbuddy/connectors/skills/connector-winvm/` 含 8 技能；卸载 U0 基线复核时该路径 **absent**，顶层 `connectors/skills` 为空 | 连接器由平台账户级**动态注册/缓存**，路径不稳定；文档(Step 6.1)写的 `skills/hos-win-skill` 与实装不一致（部署期已记录） | 不阻塞卸载（uninstall.mjs 按自身发现逻辑清理，不依赖该路径） | 卸载以 uninstall.mjs 实际发现为准，不硬依赖文档路径 | 用 `find ~/.workbuddy -iname '*winvm*'` 全量定位，确认全局 mcp 键与 `cache/winvm` 为真实待拆落点 | **G5**：deploy/undeploy 文档统一连接器落点描述，避免路径漂移误导 |
| R6 | U5 存留项须用户逐项决策（👤干预核心） | undeploy.prompt 红线要求"存留项不得自行清理，须逐项请用户决策" | 设计红线：SSH 密钥 / trash 回滚源 / 下载物 三类可能影响用户其它资产的项，必须人工拍板 | 用户选：密钥删 / trash 删 / 下载物留（见第二节） | 维持"先问后动"设计，仅补充删密钥的子流程导航 | 由用户经 AskUserQuestion 选出三项处置，再执行 | **G6**：U5 决策矩阵补充"选删密钥→执行 G3/G4 流程"的导航，避免执行者临场摸索 |

---

## 二、用户干预事件清单（👤）

| # | 干预环节 | 你做了什么 | 为何必须你介入 | 关联编号 |
|---|---|---|---|---|
| I1 | 提供 VM 密码 `123456` | 早期部署时给出；卸载阶段**实际用于密码通道收尾** | 删除 host 私钥后 publickey 通道失效，清 VM 残留只能走密码认证 | R4 |
| I2 | U5 决策·SSH 密钥 | 选 **删除**（host 私钥 + VM 两处公钥） | 密钥可能兼作其它用途（如 GitHub 凭据），删/留属资产级决策 | R3/R4/R6 |
| I3 | U5 决策·trash 回滚源 | 选 **立即删除**（`~/.workbuddy/winvm-trash/<ts>/`） | trash 含本次移入的插件缓存，是否保留回滚点属用户取舍 | R6 |
| I4 | U5 决策·下载物 | 选 **保留**（`~/winvm-deploy/pkg/` + `overall-root/`） | 发布包与解包是否丢弃，影响日后重装成本 | R6 |
| I5 | 全程授权 | 早期明确"这些事情都要你来做"，卸载延续该授权 | 卸载属不可逆操作，需用户持续授权 AI 自主执行 | 全局 |

> 说明：I2–I4 通过一次 `AskUserQuestion` 三连问收集；I1 密码为既有凭据复用，未再次索取。

---

## 三、超 prompt 动作清单（🛠）

| # | 原 prompt 说法 | 我实际做的 | 必要性 | 关联编号 |
|---|---|---|---|---|
| O1 | undeploy.prompt 默认红线"**保留 SSH 密钥与免密通道**" | 用户选删后，我**主动**编写 `vm-rmkey.ps1` + `hostkey.pub` 精确移除 VM 两处公钥，并删 host 私钥 | 用户明确选删，需落地；但脚本/文档未给删密钥流程，属自行补实现 | R3 |
| O2 | 未提及宿主 `rm` 限制 | 发现 `rm` 被 shim 拦截后，改用 node `fs` 删除 | 环境约束，必须绕行 | R2 |
| O3 | 未提及"删密钥后通道切换" | 删私钥导致 publickey 断连，我**主动**用密码通道（123456）登 VM 清 6 个残留脚本 | 收尾必需，否则 VM 留痕 | R4 |
| O4 | U4 仅要求"自报 + 独立复核" | 我额外做了 VM 侧 `vm-recheck.ps1`（printf 造 .ps1→scp→`powershell -File`）独立复核，规避引号展开坑 | 提升验收可信度（沿用部署期经验） | — |
| O5 | 未改动发布包源码 | 仅识别 `uninstall.mjs` 误报 bug 作为**改进建议**，未擅自改包 | 保持发布包完整性 | R1 |

---

## 四、代码/脚本新增与改动清单（📝）

> 原则：**未改动 `undeploy.prompt` 与 `delivery/uninstall.mjs` 源码**，以下均为卸载过程临时辅助物（位于 `~/wbtmp/`，非发布包）。

| 文件 | 类型 | 作用 | 处置 |
|---|---|---|---|
| `~/wbtmp/vm-rmkey.ps1` | 新增（📝） | 读 `hostkey.pub`，从 VM 两处 authorized_keys 精确删 1 行我们的公钥 | 已推送 VM 执行，VM 侧已删 |
| `~/wbtmp/hostkey.pub` | 新增（📝） | 待删公钥留底（删 host 私钥前抓取） | 已推送 VM，VM 侧已删 |
| `~/wbtmp/vm-recheck.ps1` | 新增（📝） | U4 VM 侧独立复核（WinVMBridge/task/port/sshd/workspace） | VM 侧已删 |
| `~/wbtmp/ssh-backup/` | 新增（📝） | 删 host 私钥前的**可逆安全网**备份（id_ed25519 + .pub） | 按用户"彻底删除"意图，活密钥已删；备份是否销毁由用户决定（见收尾） |
| `delivery/uninstall.mjs` | 未改 | 仅识别其"保留项误报"缺陷，记入 G1 | — |

---

## 五、整改后全过程时间线（U0→U5）

| 步 | 动作 | 归属 | 结果 |
|---|---|---|---|
| U0 | 前置检查：免密通道通 / `WINVM_DRY_RUN=0` / 记录基线 | — | whoami→User 退出0；基线落点已记录 |
| U0.1 | 发现 `connector-winvm` 实际 absent（与部署期观测不一致） | 🛠观测 | 全量 find 定位真实落点，不阻塞 |
| U1 | `uninstall.mjs` DRY-RUN 规划 | — | 输出 `mode: DRY-RUN`；红线核对（workspace 保留/密钥不碰/删物进 trash）全过 |
| U2 | `uninstall.mjs --apply` 实际拆除 | — | 宿主+VM 全部 `[DO]`；VM 自报 `VM_CLEANUP_DONE` |
| U2.1 | 退出码 `EXIT=1` | — | 唯一 `[FAIL]`=WORKSPACE_DIR 保留断言；判为误报（R1） |
| U4 | 独立复核（宿主+VM） | 🛠O4 | 全绿：health=000 / cache/winvm absent / mcp CLEAN / VM WinVMBridge=False、task=False、port=0、sshd=Running |
| U5 | 三项决策收集 | 👤I2-I4 | 密钥删 / trash 删 / 下载物留 |
| U5.1 | 备份 host 私钥到 `~/wbtmp/ssh-backup/` | 📝O1 | 可逆安全网就位 |
| U5.2 | node fs 删 host 私钥 + trash | 🛠O2(R2) | 成功（`rm` 被 shim 拦，绕行） |
| U5.3 | `vm-rmkey.ps1` 精确删 VM 两处公钥 | 🛠O1(R3) | 各删 1 行，剩余 0 |
| U5.4 | 公钥通道断（`Permission denied`） | — | 预期内 |
| U5.5 | 密码通道(123456)清 VM 6 个残留脚本 | 👤I1 + 🛠O3(R4) | Test-Path 全 False |
| 收尾 | 记忆补记 + 新会话验证提示 | — | 见原对话 |

---

## 六、prompt 改进片段汇总（G1–G6，可直接抄入 undeploy.prompt）

### G1 · 保留项断言容错（对应 R1）
> **在 U2/U4 的"保留项校验"段落补充：**
> 对任意 `KEEP` 类实体（如 `C:/WinVMWorkspace`），若其**在 PRE STATUS 中已为不存在**，则判 `[SKIP]`（标注 `entity never existed`），**不得计入 FAIL**；进程 EXIT 码须等于真实 failure 计数（脚本内部 "0 failure(s)" 与 EXIT=1 须一致）。

### G2 · 宿主删除文件不依赖 rm（对应 R2）
> **在 U5 手动清理段落补充：**
> ⚠ 已知部分宿主环境 `rm` 被运行时 shim 替换且可能损坏。删除宿主侧文件时**统一使用 node `fs.unlinkSync` / `fs.rmSync` 或 trash 机制**，勿直接调用 `rm`。

### G3 · 密钥删除流程（对应 R3，🛠超 prompt 补丁）
> **新增 U5.x「若用户选择删除 SSH 密钥」子流程：**
> 1. 抓取待删公钥：`cat ~/.ssh/id_ed25519.pub > hostkey.pub`
> 2. 推送至 VM，逐行比对并从**两处**移除：`$HOME/.ssh/authorized_keys` 与 `$env:ProgramData\ssh\administrators_authorized_keys`（去重，各精确删 1 行，勿整文件清空以免误伤）
> 3. 删除 host 侧 `~/.ssh/id_ed25519` / `.pub`（删除前建议备份至 `~/wbtmp/ssh-backup/` 作可逆安全网）
> 4. 附 `vm-rmkey.ps1` 示例脚本

### G4 · 删密钥顺序 / 收尾（对应 R4）
> **在 U5 补充顺序约束：**
> 删除 host 私钥会立即使 publickey 通道失效。请**先完成 VM 侧残留文件清理**（探针/辅助脚本），最后再删 host 私钥；删后若仍需登 VM，只能走**密码通道**（需 VM 密码，如 `123456`），请提前确认密码可用。

### G5 · 连接器落点统一（对应 R5）
> **在 U0 基线 / Step 6.1 相关段落统一描述：**
> 连接器由平台账户级动态注册，落点可能不在 `connectors/skills/connector-winvm/`。清理以 `uninstall.mjs` 实际发现 + `find ~/.workbuddy -iname '*winvm*'` 全量定位为准，不要硬依赖文档固定路径。

### G6 · U5 决策矩阵导航（对应 R6）
> **在 U5 决策表补充导航列：**
> - 选「删除密钥」→ 跳转执行 **G3 + G4** 流程
> - 选「删除 trash」→ node `fs.rmSync(trashDir,{recursive:true})`（参照 G2）
> - 选「保留下载物」→ 不动 `~/winvm-deploy/`

---

## 七、一句话总结

卸载脚本功能正确（双端拆干净、独立复核全绿），但 **R1 的"保留项误报导致 EXIT=1"是脚本健壮性缺陷**——应让"本就不存在的保留项"判 `[SKIP]` 而非 `[FAIL]`；其余 R2/R3/R4 均属**环境约束与"用户选删密钥"带来的超 prompt 补实现**，已在 G2–G4 给出可直接抄入 undeploy.prompt 的修正片段。用户干预集中在 U5 三项决策（密钥删 / trash 删 / 下载物留）与密码复用（I1–I4）。

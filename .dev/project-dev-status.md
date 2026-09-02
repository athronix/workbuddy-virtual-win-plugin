# 开发状态 · project-dev-status

状态表（截至本次交付）：✅ 已实现并通过编译/测试 · 🟡 部分/占位 · ⬜ 未开始

## 设计文档
| 文档 | 状态 |
|------|------|
| CONTEXT-ANALYSIS | ✅ |
| REQUIREMENTS | ✅ |
| ARCHITECTURE | ✅ |
| CAPABILITY-MODEL | ✅ |
| SPEC-HOST-AGENT-PLUGIN | ✅ |
| SPEC-AGENT-SERVICE-BRIDGE | ✅ |
| SPEC-SKILLS | ✅ |
| INTERFACES | ✅ |
| SECURITY-GOVERNANCE | ✅ |
| DEPLOYMENT / USER-MANUAL | ✅ |
| LLM-PROVIDER | ✅ |
| SCENARIOS / 06-OVERVIEW | ✅ |

## 代码包（12 个）
| 包 | 编译 | 测试 | 备注 |
|----|------|------|------|
| contracts | ✅ | — | 契约唯一源 |
| core | ✅ | ✅ policy/audit/session | 监管核心 |
| mcp-framework | ✅ | ✅ | Streamable HTTP + stdio |
| a2a-framework | ✅ | ✅ | A2A v1.0 全方法 |
| host-sdk | ✅ | ✅ | 中性渲染 SDK |
| adapter-host-workbuddy | ✅ | ✅ | WorkBuddy 原生渲染（双连接器） |
| host-a2a-bridge | ✅ | ✅ 11 项单测 | **宿主 A2A 委派桥**（stdio MCP server，补齐宿主→VM 的 A2A 一跳） |
| vm-capabilities | ✅ | ✅ e2e 真实 PS | ps-bridge 常驻（五大模块）＋ 空闲自愈（ping 探测 + 自动重启） |
| adapter-agent-workbuddy | ✅ | ✅ | 确定性执行器（agent.provider=workbuddy-deterministic，可替换） |
| adapter-agent-workbuddy-llm | ✅ | ✅ 10 项单测 | **LLM Agent（agent.provider=workbuddy，V1 已实现）**＋技能下发 |
| adapter-agent-hermes | ✅ | ✅ 10 项单测 | **Hermes Agent（agent.provider=hermes-agent）**：复用确定性执行器/CLI 桥/SKILL 加载；MCP 经 `config.yaml` 预注册（`mcp-registrar.ts` 幂等 upsert + 写 `.env` token）；init 失败降级不阻断 |
| vm-service | ✅ | ✅ e2e 双通道 | 装配 + CLI（agent.provider 总开关，3 选项：workbuddy-deterministic / workbuddy / hermes-agent） |

## 测试
- 单元测试 96 + 端到端 16 + LLM provider/技能 10 + 委派桥 11 + 双端脚本 6 + hermes provider/registrar/shared-skills 31 + workspace 软链 16 + 分发清单 4 = **178 单测 + 16 e2e = 194/194 通过**
- ps-bridge 真实拉起 PowerShell 5.1，五大模块加载并返回真实系统数据
- 端到端委派冒烟通过：宿主桥 → A2A → VM provider → ps-bridge → PowerShell，`completed` 并回传产物
- 空闲自愈验证通过：常驻 55s 空闲后委派仍成功（修复前必失败）

## Skills（6）
- 6/6 已写 SKILL.md（1 总控 + 5 领域，含应用生产操作 appops）

## 交付物
- 安装器 `delivery/install-host.mjs`：dry-run/正式/uninstall 验证通过
- VM 侧 `delivery/install-vm.mjs`：支持 `--provider <id>`/`--cli <exe>`/`--skills-root <dir>`，dry-run/self-test/uninstall 验证通过
- **共享 Skills 部署器 `delivery/deploy-shared-skills.mjs`**：publish 仓库 `skills/` → 共享根 `C:/WinVMBridge/shared-skills`，再经 junction 让各候选 VM Agent 引用（单一真源，幂等/dry-run 验证通过）
- **双端一键 `delivery/setup.mjs`**（读 `.env`）+ `.env.example`：dry-run 生成五阶段计划验证通过
  - VM 产物已改为**排除法**分发（含 `psmod/`、`contracts/schemas/`），修复「远端服务起得来、自检过半，但 54 个能力一个都跑不了」
- **workspace 软链器 `delivery/link-workspace.mjs`**：远端无 `node_modules` 时建 `@winvm/*` junction（幂等/dry-run 验证通过）。本地模拟产物树实测：修复前 `ERR_MODULE_NOT_FOUND: Cannot find package '@winvm/contracts'`，修复后 `--self-test` 完整通过（54 项能力 + ps-bridge 探针全 OK）
- VM 服务配置 `delivery/vm-service.config.json`：含三 provider 定义（workbuddy-deterministic / workbuddy / hermes-agent），待在真实 VM 上跑一次 `--self-test` 做终验

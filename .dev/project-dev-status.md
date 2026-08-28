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

## 代码包（10 个）
| 包 | 编译 | 测试 | 备注 |
|----|------|------|------|
| contracts | ✅ | — | 契约唯一源 |
| core | ✅ | ✅ policy/audit/session | 监管核心 |
| mcp-framework | ✅ | ✅ | Streamable HTTP + stdio |
| a2a-framework | ✅ | ✅ | A2A v1.0 全方法 |
| host-sdk | ✅ | ✅ | 中性渲染 SDK |
| adapter-host-workbuddy | ✅ | ✅ | WorkBuddy 原生渲染 |
| vm-capabilities | ✅ | ✅ e2e 真实 PS | ps-bridge 常驻（五大模块） |
| adapter-agent-workbuddy | ✅ | ✅ | 确定性执行器（agent.provider=workbuddy-deterministic，可替换） |
| adapter-agent-workbuddy-llm | ✅ | ✅ 5 项单测 | **LLM Agent（agent.provider=workbuddy，V1 已实现）** |
| vm-service | ✅ | ✅ e2e 双通道 | 装配 + CLI（agent.provider 总开关） |

## 测试
- 单元测试 96 + 端到端 16 + LLM provider 5 + 双端脚本 6 = **124/124 通过**
- ps-bridge 真实拉起 PowerShell 5.1，五大模块加载并返回真实系统数据

## Skills（6）
- 6/6 已写 SKILL.md（1 总控 + 5 领域，含应用生产操作 appops）

## 交付物
- 安装器 `delivery/install-host.mjs`：dry-run/正式/uninstall 验证通过
- VM 侧 `delivery/install-vm.mjs`：支持 `--provider <id>`/`--cli <exe>`，dry-run/self-test/uninstall 验证通过
- **双端一键 `delivery/setup.mjs`**（读 `.env`）+ `.env.example`：dry-run 生成五阶段计划验证通过
- VM 服务配置 `delivery/vm-service.config.json`：含双 provider 定义，待在真实 VM 上跑一次 `--self-test` 做终验

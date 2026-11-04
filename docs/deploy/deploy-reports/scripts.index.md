# 脚本 / 工具 / 代码片段 索引（scripts.index.md）

> 本文档索引本次 WinVM Bridge 一键部署过程中**实际产生并验证有效**的脚本、工具与代码片段。
> 所有文件存放于本目录 `./scripts/`（相对 `deploy-reports/`）。
> 配套总结与反馈见 `./deploy.report-suggest.md`。

## 一、环境适配类（运行时注入）
| 序号 | 文件 | 用途 | 关键机制 | 适用环境 |
|------|------|------|----------|----------|
| 1 | `00-env.sh` | 运行期环境注入落盘：定义 VM/NODE/PY/密码/路径等变量；提供 `vmssh`/`vmscp` 函数；把密码包装器目录前置到 `PATH` | 集中管理凭据与真二进制路径（`/bin/bash` 损坏 → 用 arm64 真 bash；uid 漂移 → 绕开 `~/.ssh`） | OpenHarmony 宿主（本机） |
| 2 | `01-askpass.sh` | `SSH_ASKPASS` 辅助脚本，向 ssh 进程回送密码 | `printf "$WINVM_SSH_PASSWORD"`，shebang 用全路径真 bash | OpenHarmony 宿主 |
| 3 | `02-ssh-wrapper.sh` | 密码认证 `ssh` 包装器（含重试） | 用 `SSH_ASKPASS` + `SSH_ASKPASS_REQUIRE=force` 注入密码；`-F /dev/null` 绕开 `~/.ssh`；5 次重试抗桥接抖动 | OpenHarmony 宿主（PATH 前置后，包内脚本内部 spawn 的 ssh 自动走它） |
| 4 | `03-scp-wrapper.sh` | 密码认证 `scp` 包装器（含重试） | 同 02，但走 `/usr/bin/scp`；保证 `setup.mjs` 内 `run('scp',...)` 调得通 | OpenHarmony 宿主 |

## 二、部署流程类（分阶段脚本）
| 序号 | 文件 | 用途 | 关键机制 | 关联步骤 |
|------|------|------|----------|----------|
| 5 | `10-step2-download-verify.sh` | Step 2：下载发布包（gitee 主源、github 兜底）+ sha256 校验 + 解压 | `curl --retry` 双源；`sha256sum -c` 比对；`unzip` 落地 | 取包 / 完整性校验 |
| 6 | `11-step3a-prepare-cli.sh` | Step 3：`prepare-vm --apply --ensure-node` + 全局装 codebuddy CLI + 重跑环境探针 | source env.sh 后调 `bootstrap.mjs prepare-vm`；`npm i -g @tencent-ai/codebuddy-code` | VM 运行时补齐 / CLI 安装 |

## 三、项目代码改动（代码片段）
| 序号 | 文件 | 用途 | 关键机制 | 影响 |
|------|------|------|----------|------|
| 7 | `20-prepare-vm.mjs.fix.diff` | 修复 `delivery/prepare-vm.mjs` 中 `buildPrepareVmApplyPs1` 的 DB-3 嵌套数组 bug | 对三元返回的数组加 `...` 展开，消除 `lines.join('\r\n')` 时的逗号串接 | 修复 PowerShell 生成脚本 `line 119 非法 ,` 报错；APPLY 阶段可正常生成脚本 |
| 8 | `30-dotenv.sample` | 本次部署实际落地的 `.env` 样本（含全部字段与默认值） | 供开发团队核对 `setup.mjs` 所需配置 | 文档/参考（非直接执行） |

## 四、使用说明
1. 这些脚本**高度依赖本宿主的绝对路径**（`/storage/Users/currentUser/...`、`/data/storage/el1/bundle/libs/arm64/...`），
   在其它机器复用时需先改 `00-env.sh` 里的 `HP`/`NODE`/`PY`/`ASKPASS` 等路径。
2. `00-env.sh` 建议在运行任何部署脚本**前**先 `source`，它会把密码包装器目录前置到 `PATH`，
   使后续 `node delivery/*.mjs` 内部 spawn 的 `ssh`/`scp` 自动走密码通道（绕开 `~/.ssh` 属主/uid 问题）。
3. `30-dotenv.sample` 中 `WINVM_VM_PASSWORD=123456` 为测试 VM 明文密码，正式交付应改为密钥免密或部署后清除。
4. 其余部署主流程（`setup.mjs --apply`）为项目自带，无需额外脚本；本目录脚本仅用于**绕过本宿主环境特例**与**修复/验证**。

## 五、反馈给开发团队的重点（详见 deploy.report-suggest.md）
- **setup.mjs TUNNEL 相位只读 `process.env.WINVM_VM_PASSWORD`，不从 `.env` 回填** → 建议显式把 `.env` 中的密码注入到 ssh2 隧道参数。
- **`node_modules/typescript` 未随包分发** → `npm run build` 在纯净宿主必失败（exit 127）；建议要么随包发预编译 dist（已验证可行），要么让 BUILD 相位在缺 tsc 时降级为「校验 dist 存在」而非硬失败。
- **prepare-vm.mjs 嵌套数组 bug**（见 20）已修，建议补 CI 单测固防。

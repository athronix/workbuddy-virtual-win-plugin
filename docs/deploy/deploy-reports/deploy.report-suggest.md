# WinVM Bridge 一键部署 · 总结与反馈报告

- **项目**：WinVM Bridge（VM 插件，一键部署到 Windows VM）
- **部署 Prompt 版本**：deploy.prompt v3.1.0
- **宿主环境**：OpenHarmony（HMOS，`process.platform=openharmony`）
- **目标 VM**：Windows 11（`10.0.26200`），OpenSSH 监听 22，`172.16.100.2`，账户 `User`，密码 `123456`
- **结果**：✅ VM 服务已上线并监听 `127.0.0.1:18443`，SSH 隧道持久，`/health` 通过；provider=`workbuddy-deterministic`（无需 codebuddy 交互登录）。
- **配套文档**：脚本/工具/代码片段索引见 `./scripts.index.md`；全部产物见 `./scripts/`。

---

## 一、执行阶段与结果

| 阶段 | 内容 | 执行物 | 结果 |
|------|------|--------|------|
| 0 前置/密码通道 | 落盘运行时注入 `env.sh`；密码 askpass 包装器 | `scripts/00-env.sh`、`01-askpass.sh`、`02-ssh-wrapper.sh`、`03-scp-wrapper.sh` | ✅ |
| 1 取包与完整性 | gitee 主源下载，github 兜底；sha256 校验；解压 | `scripts/10-step2-download-verify.sh` | ✅ zip 2.9MB，sha256 OK，`verify-manifest.py` → RESULT: PASS（881 文件） |
| 2 VM 运行时补齐 + CLI | `prepare-vm --apply --ensure-node`；全局装 `codebuddy` CLI；重跑探针 | `scripts/11-step3a-prepare-cli.sh` | ✅ sshd 自动/运行、防火墙 22/18443、电源永不休眠、Defender 排除项、Node v26.13.0、codebuddy CLI 2.179.3；环境探针 `ENV_PRECHECK=PASS` |
| 3 主部署 | `node delivery/setup.mjs --apply`（BUILD→HOST→VM→VM-START→TUNNEL→TEST→QA→HEALTH） | 项目自带 `setup.mjs` + 落地 `.env`（`scripts/30-dotenv.sample`） | ⚠️ 见下（仅 BUILD 失败，其余全绿 + `/health` 通过） |
| 4 代码修复 | 修复 `prepare-vm.mjs` 嵌套数组 bug | `scripts/20-prepare-vm.mjs.fix.diff` | ✅ |

### setup.mjs --apply 各相位明细
| 相位 | 结果 | 说明 |
|------|------|------|
| BUILD（`npm run build` → `tsc -b`） | ❌ exit 127 | 本宿主**未安装 typescript**，`tsc` 找不到；dist 为随包预构建产物，VM 实际用的就是它，**非致命** |
| HOST（install-host.mjs） | ✅ | 宿主侧 WorkBuddy 插件部署完成 |
| VM（scp + install-vm.mjs） | ✅ | 产物 + skills 已分发，已注册自启并自检 |
| VM-START（schtasks 拉起服务） | ✅ | VM 服务已监听 `127.0.0.1:18443` |
| TUNNEL（ssh2 隧道 / 常驻 daemon） | ✅（修复后） | 初跑因密码未注入失败；export `WINVM_VM_PASSWORD` 后常驻 daemon `RUNNING`，`127.0.0.1:18443` 打通 |
| TEST（宿主自检） | ✅ | 能力注册表 / ps-bridge / provider 能力目录自检通过 |
| QA-PROBE | ✅ | 2/2 探针已推 `C:/WinVMBridge/dev-and-qa/probes` |
| HEALTH（`/health`） | ✅ | `{"ok":true,"provider":{"state":"ready"},"session":{"state":"healthy","interactive":true},"psBridge":{"state":"ready"}}` |

> 最终 `EXIT=1` 仅由 BUILD 失败导致；功能部署（VM 服务 + 隧道 + 健康）全部达成。

---

## 二、遇到的问题 · 根因 · 解决方案

| # | 问题 | 根因 | 解决方案 | 代价/影响 |
|---|------|------|----------|-----------|
| X-1 | `/bin/bash` 损坏（bad interpreter） | 宿主 shell 环境特例 | 改用全路径真 bash `/data/storage/el1/bundle/libs/arm64/bash/bin/bash`；所有脚本 shebang 改用它 | 全部脚本 shebang 改写 |
| X-2 | `/bin/rm` 为坏 shim，删除文件失败 | 同属宿主环境特例 | 改用 `python3` 真二进制做删除 | — |
| X-3 | uid 跨调用漂移（20001006↔20020191），`~/.ssh` 属主/权限冲突 | 沙箱 uid 不固定 | **彻底绕开 `~/.ssh`**：ssh 统一 `-F /dev/null -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null` + 密码 askpass 认证 | 放弃密钥免密，改用密码通道（包装器见 `02/03`） |
| X-4 | TCP 22 偶发超时（`Host is unreachable`） | 桥接抖动 / VM 被暂停或断电 | 包装器 5 次重试；VM 恢复后重跑即自愈 | 需用户在 VM 管理端确认开机/不断电（P-4 暂停点） |
| X-5 | 生成的 prepare-vm PS1 报 `line 119 非法 ,` | `buildPrepareVmApplyPs1` 中 DB-3 段把三元数组**直接作为 `lines` 元素**（嵌套数组），`join('\r\n')` 时被 `toString()` 成逗号连接 | 对三元结果加 `...` 展开扁平化（见 `20-prepare-vm.mjs.fix.diff`） | 已修，建议补 CI 单测 |
| X-6 | TUNNEL 相位 ssh2 隧道起不来，连带 HEALTH 失败 | `setup.mjs` 的 TUNNEL 相位只读 `process.env.WINVM_VM_PASSWORD`，而 `.env` 经 `loadEnvFile` 解析后**未回写 `process.env`**，密码没传进去 | 运行前 `source env.sh`（已 export `WINVM_VM_PASSWORD`）；重跑 `--apply` 后 daemon `RUNNING`、隧道打通 | 提示：`.env` 的密码字段对 TUNNEL 无效，需另行 export |
| X-7 | BUILD 相位 `tsc: inaccessible or not found` | 发布包**未分发 `node_modules/typescript`**，纯净宿主无法 `npm run build` | 接受：发布包自带预编译 `dist`（已验证 VM 部署即用它）；未强求重建 | BUILD 相位非致命失败，但 `EXIT≠0` 易误导 |
| X-8 | heredoc 在 `/bin/sh` 下误解析 | 坏 shell 环境 | 改用 `python3 -c` 单行或 Write 文件后执行 | — |

### 过程中的人工卡点（按协议暂停/确认）
- **P-4（VM 不可达）**：两次因 VM 被暂停/断电触发 `Host is unreachable`，按协议停下汇报，待用户「vm恢复了」后重跑通过。
- **DB-4（codebuddy 交互登录）**：本部署采用默认 `workbuddy-deterministic` provider，**不依赖** Agent CLI 登录态（探针 verdict=not-applicable / installed-unverified / BLOCKERS=none），故无需用户在 VM 内手动 `codebuddy` 登录。若改用 `provider=workbuddy`（LLM 执行器），则需该人工步骤。

---

## 三、对项目的代码调整

1. **`delivery/prepare-vm.mjs`**（已就地修复，diff 见 `scripts/20-prepare-vm.mjs.fix.diff`）
   - 函数 `buildPrepareVmApplyPs1` 的 DB-3 段：三元返回的数组原本裸置于 `lines` 内形成嵌套数组，导致 `join` 时逗号串接、PS1 语法错误。
   - 修复：加 `...` 展开。已 `node --check` 通过，生成脚本 93 行无非法 `,`，`prepare-vm --apply` 实测成功。

2. **项目根 `.env`**（本次落地配置样本见 `scripts/30-dotenv.sample`）
   - 由 `env.example` 派生，填好 `VM_HOST/VM_USER/WINVM_VM_PROVIDER/WINVM_TUNNEL_BACKEND/WINVM_DRY_RUN=0/WINVM_VM_PASSWORD` 等。
   - 提示：含明文密码，交付/归档时应脱敏或改密钥。

> 其余文件（setup.mjs、install-host/vm.mjs、deploy-vm.mjs、oh-tunnel.mjs 等）**未改动**，本次部署沿用项目自带逻辑。

---

## 四、为本次部署创建的脚本与工具（索引见 scripts.index.md）

| 文件 | 作用 |
|------|------|
| `scripts/00-env.sh` | 运行时环境注入 + `vmssh/vmscp` + PATH 前置密码包装器 |
| `scripts/01-askpass.sh` | SSH_ASKPASS 密码回送 |
| `scripts/02-ssh-wrapper.sh` | 密码认证 ssh 包装器（含重试） |
| `scripts/03-scp-wrapper.sh` | 密码认证 scp 包装器（含重试） |
| `scripts/10-step2-download-verify.sh` | 取包 + sha256 校验 + 解压 |
| `scripts/11-step3a-prepare-cli.sh` | prepare-vm + 装 codebuddy CLI + 重跑探针 |
| `scripts/20-prepare-vm.mjs.fix.diff` | 项目代码修复 diff（prepare-vm.mjs） |
| `scripts/30-dotenv.sample` | 落地 `.env` 样本 |

> 这些脚本**强依赖本宿主绝对路径**，用于绕过 OpenHarmony 环境特例；常规 Linux/macOS/Win32 宿主无需它们。

---

## 五、反馈给开发团队的建议

### A. 部署 Prompt（v3.1.0）完善
1. **VM 可达性前置校验**：在 Step 0 明确「VM 空闲可能被暂停/断电导致 `Host is unreachable`」并给出一键确认清单（开机 + 电源策略 + 固定 IP + 桥接通），减少反复重试。
2. **密码/密钥策略显式化**：Prompt 应明确本宿主若 `~/.ssh` 不可用时的兜底（密码 askpass 通道），避免用户误以为必须密钥免密。
3. **DB-4 登录与 provider 绑定说明**：当前仅在 DB-4 行小字提及「deterministic 不依赖登录」。建议在 Prompt 开头加一句：选 `workbuddy-deterministic` 时可完全跳过 codebuddy 交互登录（结构性人工项仅对 `provider=workbuddy` 生效）。

### B. setup.mjs / 部署脚本完善
1. **TUNNEL 密码回填（关键）**：`resolveConfig()` 读 `.env` 后，应把 `WINVM_VM_PASSWORD` 显式写入 `process.env`（或把 `cfg.vmPassword` 直接传给 `establishSsh2Tunnel` 的 `password` 参数），否则 `.env` 里填了密码 TUNNEL 仍拿不到。当前只能在外部 `export`，极不直观。
2. **BUILD 相位容错**：`npm run build` 失败时，部署直接 `EXIT≠0` 并报告「N 个步骤失败」，但功能已达成。建议：
   - 检测 `node_modules/typescript` 是否存在；不存在且 `dist/` 已存在时降级为「校验 dist 完整性」并标 `[SKIP/WARN]`，而非硬失败；
   - 或随发布包**附带 typescript**（作为 devDep 一并分发），使 `npm run build` 在任何宿主可跑。
3. **`.env` 与 `process.env` 一致性**：`loadEnvFile` 解析结果建议统一注入 `process.env`（至少把凭据类字段），消除「文件里配了但运行时读不到」的陷阱。

### C. prepare-vm.mjs 完善
1. 应用 `20-prepare-vm.mjs.fix.diff` 的修复；并在 CI 增加针对 `buildPrepareVmApplyPs1`/`buildVmInstallPs1`/`buildVmStartPs1` 等所有 `lines.join(...)` 构建器的单测：
   - 断言生成文本无行内多余 `,`；
   - 对 `ensureNode` 的 true/false 两条路径都做语法校验（`node --check` 等价或 PowerShell 语法树解析）。
2. 建议抽象 `pushLine(arr, ...fragments)` 辅助强制展开，从根上杜绝裸嵌套数组再次混入。

### D. 发布包（release artifact）完善
1. **dist 预编译 + 校验**：当前 dist 随包发布且可用，建议 release 流程增加对 `dist/` 的完整性签名/校验，避免「缺 typescript 又缺 dist」的尴尬。
2. **OpenHarmony 宿主说明**：在 `docs/oh-host-install-run-test.md` 补充本环境已知坑（`/bin/bash` 损坏、uid 漂移、`~/.ssh` 不可用、typescript 未随包），并给出或引用本 `scripts/` 中的适配脚本。

---

## 六、验证与复测（部署完成后独立确认）

```
$ curl -s --noproxy 127.0.0.1 http://127.0.0.1:18443/health
{"ok":true,"provider":{"id":"workbuddy-deterministic","state":"ready"},
 "session":{"state":"healthy","interactive":true},"psBridge":{"state":"ready"}, ...}

$ 端口探测：127.0.0.1:18443 LISTENING  ✅（常驻 tunnel-daemon 持有）
```

结论：VM 服务运行正常，GUI/交互会话健康，隧道持久可达。部署目标达成。

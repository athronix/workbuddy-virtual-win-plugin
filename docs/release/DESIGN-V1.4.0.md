# REL-V1.4.0 · 发布包设计与打包方案（DDD Phase 2）

> 版本：V1.4.0（git tag，用户 2026-10-18 裁定）｜设计日期：2026-10-18｜状态：已基线化
> 上游事实源：`.workbuddy/memory/MEMORY.md`、`docs/archive/audit/2026-10-16-panorama-phase6.md`、`docs/05-peripherals/DEPLOYMENT.md`、`docs/RELEASE-NOTES.md`
> 本设计是 `delivery/pack-release.mjs` 的实现依据（DDD 原则 7：代码未动，文档先行）。

## 一、目标与范围

把当前研发态（HEAD 干净、gate GREEN 124 文件/2179 例）打成**可复现的发布版本**：三部分发布包 + 一键脚本 + 随包文档；随后**清空历史部署 → 用发布包真机重装 → 完整功能验证**；过程问题按「版本→迭代」记入 `docs/release/ISSUES.md` 并驱动仓库侧优化，迭代至成功发布。

非目标：不改运行行为（本批零 src 改动为默认预期；若迭代暴露缺陷则按 ISSUES.md 流程修）；不动 `~/.workbuddy/teams` 非 winvm 域（永久纪律）。

## 二、发布目录结构（用户裁定）

```
release/
└── V1.4.0/
    ├── host/      # 宿主机一键部署发布包（WorkBuddy 插件侧）
    ├── vm/        # VM 一键部署发布包（vm-service 侧，宿主驱动）
    └── overall/   # 整体一键部署发布脚本 + 相关文档包（host ∪ vm ∪ 文档）
```

版本号 = git tag 名 = 目录名。后续迭代在其上递增（V1.4.1 / V1.5.0…），`ISSUES.md` 同构记录。

## 三、三包收录清单（闭包推导，非拍脑袋）

推导方法：以各入口脚本的 **import/spawn 闭包 + 运行期读取面**为准，逐环确认到「仅 node 内置模块」为止。

### 3.1 host/（install-host.mjs 闭包）

| 收录 | 依据 |
|---|---|
| `delivery/install-host.mjs` | 宿主安装入口（main：预检→buildPlugin→Renderer 安装→mcp.json 合并→vm-conn→安装尾对账→隧道） |
| `delivery/deploy-winvm-plugin.mjs` | install-host.mjs:38 import |
| `delivery/path-util.mjs` | :45 import（PATH 增删） |
| `delivery/account-resolve.mjs` | :46 import（账户解析） |
| `delivery/preflight.mjs` | :47 import（checkHostDeps） |
| `delivery/ssh2-resolve.mjs`、`oh-tunnel.mjs`、`tunnel-daemon.mjs`、`winvm-plugin.mjs` | install-host.mjs:212 缓存部署清单（隧道三件套 + 启动器） |
| `delivery/hooks/hooks.json`、`hooks/session-start.sh` | 同上:212（SessionStart 钩子保命隧道） |
| `delivery/winvm-plugin`（shim） | deployWinvmPlugin 部署对象（exec node winvm-plugin.mjs） |
| `delivery/env.example` | .env 模板（setup/install-host 回退源） |
| `skills/`（7 个） | host-sdk `loadSkillBundles` 渲染中性插件模型 → connectors/skills/connector-winvm/ |
| `packages/*`（排除 src/node_modules/tsconfig/tsconfig.tsbuildinfo/.generated/.DS_Store） | install-host import `@winvm/host-sdk`、`@winvm/vm-capabilities`；a2a-bridge dist + collectWinvmDeps 收 @winvm 全链 |
| `node_modules/@winvm/*`（**实体副本**，非 symlink） | ESM 裸包名解析；hmdfs 建 symlink 有 EACCES 前科，一律 dereference 复制 |
| `node_modules/{ssh2,asn1,bcrypt-pbkdf,tweetnacl}` | install-host.mjs:447-506 ssh2 离线分发（纯 JS 传递链；cpu-features/nan 等 optional 原生依赖跳过） |
| `package.json` | 版本单一事实源（resolvePluginVersion，fail-loud） |
| `deploy-host.sh`、`README.md`、`MANIFEST.txt` | 一键脚本 + 包内说明 + 完整性清单 |

### 3.2 vm/（deploy-vm.mjs → setup.mjs → install-vm.mjs 闭包）

| 收录 | 依据 |
|---|---|
| `delivery/deploy-vm.mjs` | 宿主侧 VM 驱动（BUILD→VM→VM-START→QA-PROBE） |
| `delivery/setup.mjs` | deploy-vm.mjs:33 import（deployVm/runRemotePs1/buildVmStartPs1/deployQaProbes/waitForRemotePort）；仅 node 内置 |
| `delivery/install-vm.mjs` | VM 内执行体（随 tgz 落到 C:/WinVMBridge） |
| `delivery/deploy-shared-skills.mjs`、`link-workspace.mjs` | install-vm.mjs:95-96 import（shared-skills 发布 + junction 软链） |
| `delivery/deploy-winvm-plugin.mjs`、`path-util.mjs`、`preflight.mjs` | install-vm.mjs:97-99 import |
| `delivery/env.example` | .env 模板 |
| `delivery/vm-service.config.json` | install-vm.mjs 的**非 import 硬依赖**（读文件生成 `.generated/vm-service.runtime.json`；迭代1 教训：此类缺失 dry-run 抓不到，须靠 PACKAGE_REQUIRED 结构断言） |
| `skills/` | tgz 组成（setup.mjs:612 sources = delivery + skills + 包运行时资产 + package.json） |
| `packages/*`（同 host 排除规则） | VM 运行期资产（dist/package.json/psmod/schemas，排除法防漏发） |
| `package.json` | tgz 组成 |
| `qa/probes/qa-probe.ps1`、`qa/probes/lead-md5-3.ps1` | QA-PROBE 相位推送物（setup.mjs:196-203） |
| `deploy-vm.sh`、`README.md`、`MANIFEST.txt` | 一键脚本 + 说明 + 清单 |
| **不含 node_modules** | VM 侧 dist 经 install-vm `--skip-install` + junction 软链解析（setup.mjs:606-608）；宿主驱动 setup/deploy-vm 仅 node 内置 |

### 3.3 overall/（整体包 = host ∪ vm ∪ 编排与文档）

| 收录 | 依据 |
|---|---|
| host/ 与 vm/ 的全部条目（并集） | 整体一键自包含 |
| `delivery/bootstrap.mjs`、`prepare-vm.mjs` | bootstrap.mjs:44-52 import（环境自检/信任/env 生成） |
| `delivery/uninstall.mjs` | 双端清场（清空历史部署的发布态工具；VM 侧 .ps1 内联生成，无外部闭包） |
| `docs/05-peripherals/DEPLOYMENT.md` | 部署 runbook（权威） |
| `docs/INSTALL-GUIDE.md` | 安装向导 |
| `docs/05-peripherals/USER-MANUAL.md`、`SCENARIOS.md` | 操作使用说明 |
| `docs/RELEASE-NOTES.md` | 发布说明（演进链 + 已知限制） |
| `docs/release/RELEASE-V1.4.0.md` | 本版发布说明（新建，随包） |
| `docs/release/ISSUES.md` | 发布问题台账快照（按版本+迭代） |
| `deploy-all.sh`、`README.md`、`MANIFEST.txt` | 整体一键 + 索引 + 清单 |

**并集不重复落盘**：overall 与 host/vm 共享同一份闭包文件（pack 脚本按目标分别组装，不互相拷贝）。

## 四、一键脚本规格（bash，宿主机=鸿蒙 OH）

统一 node 解析序：`$WINVM_NODE_BIN` → PATH `node` → OH 已知路径 `/data/storage/el1/bundle/libs/arm64/node/bin/node`；缺失即报错退出。

| 脚本 | 行为 | 参数透传 |
|---|---|---|
| `host/deploy-host.sh` | 校验 node/`.env`（缺则从 env.example 复制并警告需编辑）→ `exec node delivery/install-host.mjs "$@"` | 全部（--dry-run/--no-tunnel/--vm-host…） |
| `vm/deploy-vm.sh` | 同上校验 → 无参时交互确认后追加 `--apply --skip-build`；`exec node delivery/deploy-vm.mjs "$@"` | 全部 |
| `overall/deploy-all.sh` | 前置检查（node/.env/关键键值）→ `--wipe` 时先跑双端 uninstall → `node delivery/setup.mjs --apply --skip-build` → 后置验证（隧道 /health）→ 打印摘要 | `--wipe`/`--yes`/其余透传 |

**`--skip-build`（REL-V1.4.0 新增，setup.mjs/deploy-vm.mjs）**：发布包内 dist 已构建且 MANIFEST 逐文件指纹在册，且包**不含 src/tsconfig/tsc**（无条件重跑 BUILD 必失败）⇒ 包内一键脚本默认传 `--skip-build` 省略 BUILD 相位；仓库态默认不跳（行为零变化）。实现：`resolveConfig` 增 `skipBuild`（`opts.skipBuild===true ‖ WINVM_SKIP_BUILD=1`）；`buildPlan` 条件省略 BUILD；`--only-host/--only-vm` 保留集同步去 BUILD。

## 五、打包脚本 `delivery/pack-release.mjs` 设计

- **入参**：`--version V1.4.0`（缺省从 git describe 或 package.json 推导，fail-loud 不静默默认）、`--out release`、`--from-git`（可选：从 tag 检出干净树打包；默认用工作区，但要求 `git status` 干净）。
- **流程**：① 前置断言（工作区干净 / dist 已构建——缺失即提示 `npm run build` 后退出，绝不静默打包陈旧 dist）；② 按 §3 清单组装三个目录（cpSync，`@winvm` dereference）；③ 生成三份一键脚本（chmod +x）与三份 README；④ 计算每个文件的 sha256 写 `MANIFEST.txt`（含版本/git commit/文件数/总体 sha256）；⑤ **包内三查**（见 §6）；⑥ 打印汇总表。
- **输出**：`release/V1.4.0/{host,vm,overall}/**` + 汇总行（每包文件数/字节数/三查结果）。
- **可复现**：同一 commit + 同一 dist ⇒ MANIFEST 总体 sha256 确定（脚本内容不含时间戳；MANIFEST 头部日期除外，单独字段）。

## 六、验证策略（打包后、真机前）

| 查 | 命令（在各包目录内） | 通过判据 |
|---|---|---|
| V1 结构 | 脚本内置：`PACKAGE_REQUIRED` 逐包 existsSync 断言（入口脚本+数据文件+探针+文档） | 零缺失 |
| V2 host 闭包 | `node delivery/install-host.mjs --dry-run --no-tunnel` | exit 0 且计划含 BUILD/HOST 相位（静态 import 全部解析成功） |
| V3 vm 闭包 | `node delivery/deploy-vm.mjs`（无 --apply 即 dry-run） | exit 0 且计划含 VM/VM-START/QA-PROBE 相位 |
| V4 能力面 | 读 `packages/vm-capabilities/dist` 注册表计数 | = 54 |

> **迭代1 实证的盲区**：V2/V3 只验证 import 闭包，**抓不到"读文件"型依赖**（install-vm 读 `vm-service.config.json` 生成 runtime.json）。V1 结构断言即为此增设的机械化防线——新增任何入口/数据文件必须同步 `PACKAGE_REQUIRED`。

真机验证（步骤 3）剧本：快照现网 → 双端 uninstall 清场（回收站可恢复）→ `overall/deploy-all.sh --wipe`（先清后装由脚本内 sequencing 保证）→ 验证矩阵：

1. `/health`：provider=ready、session.state=healthy、capabilitiesProfile.llm-agent
2. MCP 直调：`meta.capability.list` count=54；`system.info.get` 实调
3. A2A 委派：`a2a.delegate`（system.info.get）→ streaming → 终态 ok
4. GUI：`gui.session.status`（healthy/locked=false）
5. 审计链：委派 traceId 在链、`delegation.complete` 有诚实回执
6. 缓存指纹：宿主缓存版本路径 + 安装尾 SHA256 对账（install-host 内置）

## 七、ISSUES.md 组织规范（docs/release/ISSUES.md）

```
# 发布问题台账
## V1.4.0
### 迭代 N（日期）
| ID | 阶段(打包/部署/验证) | 现象 | 根因 | 处置(仓库侧修复) | 复验 | 状态 |
```

每条必须四元组齐全（现象/根因/证据/路由——项目既有 FAIL 纪律）；关闭条件=复验通过。

## 八、文档一致性清单（DDD 原则 7，随迭代同步）

- [x] 本设计文档（先行）
- [ ] `docs/05-peripherals/DEPLOYMENT.md`：新增「§9 发布包与一键部署」章节（release/ 结构 + 三脚本 + 清场重装 runbook）
- [ ] `docs/RELEASE-NOTES.md`：§二 增 V1.4.0 行；§四 增 Phase 6 批15~20 行
- [ ] `docs/release/RELEASE-V1.4.0.md`：发布说明（随包分发）
- [ ] `docs/release/ISSUES.md`：台账初始化
- [ ] `README.md`：发布包入口索引（若 §10 索引存在则补行）
- [ ] `.workbuddy/memory/MEMORY.md`：里程碑补「REL-V1.4.0 发布」

## 九、风险与回滚

| 风险 | 缓释 |
|---|---|
| 打包闭包遗漏（发布包装起来缺文件） | V2/V3 dry-run 静态解析 + V1 结构查 + 真机部署即终验 |
| 清场误伤（uninstall 触及非 winvm 域） | uninstall.mjs 既有红线（绝不动 teams/仓库/ssh）；清场前快照相待 |
| tag 后迭代出代码变更 | 迭代修复另起 commit + V1.4.1 tag，ISSUES.md 记录跨版本 |
| push origin 失败（沙箱网络） | tag 本地生效即满足「打 tag 并提交」；push 单独尝试并如实报告 |
| 真机重装后 MCP 连接器需重新信任 | DEPLOYMENT.md 已载人工收尾步；列入验证矩阵观察项 |

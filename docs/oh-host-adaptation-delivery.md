# WinVM Bridge · 鸿蒙（HMOS）宿主侧适配落地交付（T06–T10）

> **文档代号**：`delivery:oh-host-adaptation`
> **日期**：2026-09-14 ｜ **团队**：`software-winvm-oh-host-v2`（PM/架构/工程/QA 四角色 SOP，本轮为「增量开发」部分工作流）
> **场景**：**宿主 = 本机鸿蒙（HMOS）WorkBuddy，VM = 本机 Windows 虚拟机（`ssh User@172.16.100.2`）**。
> **范围**：仅补 **HOST 侧鸿蒙适配**（T06–T10 中的 T06–T09 + 配置默认值）。VM 侧与 ssh2 隧道（T01–T05）在上一轮已就绪，**本轮零改动**。

---

## 一、TL;DR

一键双端安装脚本 `delivery/setup.mjs` 的**顶层编排本就平台无关**（且 `TUNNEL` 阶段已有 `process.platform === 'ohos'` 守卫 → 自动走进程内 ssh2 隧道）；本轮把唯一缺口——**HOST 侧（`install-host.mjs` / `adapter-host-workbuddy` / `path-util.mjs` / `deploy-winvm-plugin.mjs`）的 Windows 专属假设**——全部改为鸿蒙可用，且**保证 Windows/macOS 宿主与 VM 侧零行为变化**。

---

## 二、交付概览

| 项 | 结果 |
|---|---|
| 交付状态 | ✅ 代码全部就位，QA 两轮验证通过，路由判定 **NoOne**（无源码 Bug 残留） |
| 验证方式 | 离线逐文件 `node --test`（**严禁整批跑**，规避 `link-workspace` junction 崩溃） |
| 测试结果 | **97 pass / 10 fail**；10 项失败**全部为环境性**（离线沙箱无 `node_modules` 与 `packages/*/dist` → `ERR_MODULE_NOT_FOUND @winvm/*`；另 1 项断言“仓库应已构建”）——**非 T06–T09 回归** |
| 新增/修改测试 | `tests/unit/account-resolve.test.mjs`（4/4）、`tests/unit/path-util-posix.test.mjs`（7/7）、`tests/unit/sandbox-allowwrite.test.mjs`（9/9，覆盖 win32 守卫不写盘的 5 类场景）；QA 修正 2 个写死 Windows 假设的陈旧测试（path-util 5 项 + deploy-winvm-plugin 2 项），改为随平台自适应 |
| 已知局限 | 沙箱**无外网、禁 `npm install/build`` → TS 未编译，声称的「214/214 基线」**离线不可复现**；TS 改动仅静态审查。**须在真机 `npm i && npm run build` 后复跑全部测试复核** |

---

## 三、改动清单（文件 + 要点 + 守卫）

| 文件 | 任务 | 改动要点 | 平台守卫 |
|---|---|---|---|
| `delivery/account-resolve.mjs`（新增） | T06 | `KNOWN_ACTIVE_ACCOUNT='8dd0df6a-47ce-4a02-82fd-51cd84a8f0f8'` + `resolveAccountIds(hostRoot, override)`：override 优先；否则活跃 uuid 在首位 + 遍历 `connectors/` 全部子目录去重 | 数据落点问题，无平台分支 |
| `delivery/install-host.mjs` | T06 | 引入 `resolveAccountIds`；安装分支**按账户循环** `renderer.plan/install`，各自**增量合并**该账户 `mcp.json`；汇总去重后统一打印；`registerInstalledPlugin`/`deployWinvmPlugin`/`addToUserPath`/`writeVmConnConfig` 仍在循环外**只跑一次** | 账户解析无平台分支 |
| `delivery/install-host.mjs` | T07 | 新增并 **export** `injectSandboxAllowWrite`/`removeSandboxAllowWrite`：写 `~/.workbuddy/settings.json` 的 `sandbox.extraAllowWrite`，幂等 + 写前备份 `*.winvm-bak.<ts>` | **win32 且无有效 `sandbox` 对象 → `return []`（不新建/不改写）** |
| `delivery/install-host.mjs` | T08 | `trashItem` 在非 win32 且未指定 `--trash-dir` 时，默认回收目录 `~/.workbuddy/winvm-trash` | `!opts.trashDir && process.platform !== 'win32'` |
| `packages/adapter-host-workbuddy/src/index.ts` | T06 | `uninstall` 遍历 `connectors/` 下**所有账户**逐个清理；`resolveWorkBuddyPaths` 账户兜底加 `process.env.WINVM_ACCOUNT`；补 `readdir` 导入 | 无平台分支 |
| `packages/adapter-host-workbuddy/src/index.ts` | T09 | `renderConnectorEntry` 的 `case 'stdio'` 加 `runtime:{type:'node',version:'>=18'}`（与 HMOS/VM 现有 stdio 连接器同构） | 无 |
| `delivery/deploy-winvm-plugin.mjs` | T08 | `winvm-plugin.cmd` **仅 win32 写**；非 Windows 打印跳过（POSIX 启动器承担） | `if (process.platform === 'win32')` |
| `delivery/path-util.mjs` | T08 | `applyPathOp` 分隔符随平台（win32 `;` / POSIX `:`）；新增 `getProfilePathRaw`/`setProfilePathRaw`（`~/.workbuddy/winvm/shell-init.sh` + `~/.bashrc`/`~/.profile` 标记块，幂等增删） | `addToUserPath`/`removeFromUserPath` 非 win32 走 profile，win32 保持原 PowerShell |
| `.env.example` | 配置 | `VM_HOST=172.16.100.2`、`VM_USER=User`（默认即本机 Windows VM 目标） | — |

---

## 四、T07 源码缺陷闭环（本轮 QA 拦下的关键项）

- **缺陷**：`injectSandboxAllowWrite` 初版在「win32 且 `settings.json` 无 `sandbox` 字段」时会**新建并写盘**（含备份），违反设计 `oh-adaptation-plan.md` T07「Windows 无 sandbox 字段则跳过」及 §3.2.1「Windows/macOS 宿主零行为变化」。
- **发现**：主理人初核可疑 → **QA 带证据独立坐实为源码缺陷** → 路由 Engineer。
- **修复**：`install-host.mjs:256-261` 插入守卫 —— `process.platform === 'win32' && (无有效 sandbox 对象)` 时 `return []`（不新建/不改写/不产生 `.winvm-bak.*`）；并订正与行为相悖的 doc 注释。
- **验证**：QA 第 2 轮专项 **5/5 PASS**（win32 无字段→不写盘；win32 有 sandbox→正常追加；非 win32→正常新建+追加）。
- 附带消除写放大：`adapter.uninstall` 改为**仅命中本插件 key 才写回** `mcp.json`。

---

## 五、用户下一步（真机落地）

1. **配置**：复制 `.env.example` 为 `.env`（默认值已是 `172.16.100.2` / `User`，通常无需改）；先 `node delivery/setup.mjs`（dry-run 预览）→ `node delivery/setup.mjs --apply` 真装。
2. **VM 侧前置（P0-R0 硬门禁）**：在 `172.16.100.2` 上先跑 `install-vm.mjs` 落 ps-bridge + 54 能力 + 起 `/mcp` `/a2a`；并补装 **node**（P1-R10，VM 不在 PATH）与 **codebuddy CLI**（P1-R8，或把 provider 改走其它后端）。
3. **构建复核**：在可联网环境 `npm i && npm run build` 后再**逐文件**跑全部单测，复核「214/214 + 新增用例」并确认 TS 编译无误。
4. **沙箱门禁**：在 HMOS 真机跑 `docs/oh-host-selfcheck.md` §5 三条命令（本地监听 / 长驻子进程 / 出站 TCP）——这是**唯一仍未决**项；若 FAIL 属 OS 层权限（INTERNET/socket），非改插件可绕。
5. **端到端串验**：VM 起服务 → HMOS `winvm-plugin status` 验证两连接器在 `8dd0df6a-…` 账户目录检出（A5）→ ssh2 隧道调一次 `connector:winvm` 工具（A4）→ a2a 桥委派（A2）。

---

## 六、没有改动的部分（零改动保证）

- **VM 侧**：`install-vm.mjs`、ps-bridge、`.cmd` 启动器（VM 仍是 Windows）——零改动。
- **Windows / macOS 宿主**：隧道仍走 `spawn('ssh')`；PATH 仍走 PowerShell；`.cmd` 仍写；回收站仍走 Shell.Application；沙箱注入在 win32 无字段时为 no-op。
- **ssh2 隧道（T01–T05）**：19/19 离线测试绿，本轮未触碰。

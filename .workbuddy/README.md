# .workbuddy · 工作区记忆与迁移交接

> 本目录有两类内容：
> 1. **工作记忆**（`memory/`）—— WorkBuddy 在本项目上的私人记忆，会被自动加载，**不入库**。
> 2. **迁移交接档案**（`README.md` + `handover/`）—— 本项目从一台机器迁到另一台 Machine 时，
>    供**继任 WorkBuddy** 快速接手继续开发的完整说明，**随仓库入库**。
>
> 生成时间：2026-09-10 · 交接基线：`main` @ `acc966b`

---

## 🚨 继任 WorkBuddy：先读这一段（30 秒版）

1. 你是接手一个**已完成 14 轮 / 18 次提交**的成熟项目，**不是从零开始**。
2. 项目是**为宿主机 WorkBuddy 做的插件**，让它能完整操作一台 Windows 虚拟机（54 项能力）。
3. **先跑基线再改码**：`npm run build` + 逐文件单测（当前 214/214）+ `vm-service --self-test`。
4. **单测必须逐文件跑**，整批跑会「假全红」（环境问题，见 `06-lessons-learned.md` D1）。
5. 很多看起来像 bug 的现象其实是**环境限制**（锁屏 → `degraded`、RDP 会话 env 陈旧、
   SSH 下回收站不可见）。**先判定归属再动手**，别把环境现象改出真 bug。
6. 完整交接档案在 `handover/`，**按 `07-migration-checklist.md` 顺序**在新机落地。

---

## 一、本目录结构与索引

```
.workbuddy/
├── README.md                     ← 本文件：目录说明 + handover 总纲（入库）
├── handover/                     ← 迁移交接档案（入库）
│   ├── 01-project-overview.md            项目定位 / 架构 / 能力域 / 硬约束
│   ├── 02-development-history.md         14 轮 / 18 次提交脉络 + 6 个转折点
│   ├── 03-current-status.md              当前基线、验证命令、真机未验证项
│   ├── 04-known-issues-and-roadmap.md    已知问题、环境限制、完善方向与优先级
│   ├── 05-environment-and-tools.md       环境依赖、工具脚本、7 个 Skills、环境怪癖
│   ├── 06-lessons-learned.md             ★ 踩坑集（按领域归类，症状→根因→解法）
│   └── 07-migration-checklist.md         ★ 新机落地 Check List（按顺序执行）
├── memory/                       ← WorkBuddy 工作记忆（不入库，跨机靠 cp）
│   ├── MEMORY.md                 项目长期记忆（每次会话自动注入，勿堆临时信息）
│   ├── 2026-08-28.md …           每日工作日志（append-only，记当轮做了什么/为什么）
│   └── （其余日期文件）          缺日期 = 那天没做实质性工作
├── clean_user_path.ps1           本机 User PATH 修复脚本（清理双反斜杠/垃圾项）
├── tmp_path_raw_backup.txt       PATH 原始值备份（回滚用）
└── commit_msg.txt                git 提交信息临时文件（heredoc 被安全策略拦截，改用文件提交）
```

**各文件一句话说明**

| 文件 | 作用 | 何时看 |
|---|---|---|
| `README.md` | 目录索引 + handover 总纲 | **接手第一眼** |
| `handover/01` | 项目是什么、怎么搭的 | 建立整体认知 |
| `handover/02` | 14 轮怎么走过来的 | 理解为什么现在是这个样子 |
| `handover/03` | 当前基线 + 怎么验证 | 跑基线、判断改动是否回归 |
| `handover/04` | 已知问题与下一步 | 决定先做什么 |
| `handover/05` | 环境 / 工具 / Skills | 配环境、找脚本 |
| `handover/06` | **踩坑集** | **改码前扫一遍，能省几小时** |
| `handover/07` | **新机落地清单** | **换机后照做** |
| `memory/MEMORY.md` | 跨会话长期记忆 | 自动加载，无需主动读 |
| `memory/YYYY-MM-DD.md` | 每日工作日志 | 追溯某轮细节时 |

> ⚠️ `.gitignore` 第 10 行起为 `.workbuddy/*` + 精确放行 `README.md` 与 `handover/`。
> **改动前须知**：不能写回 `.workbuddy/` 再取反子项——目录被排除后 Git 不再下钻，取反无效。

---

## 二、Handover：继任 WorkBuddy 如何继续开发

### 0. 先建立 6 条正确认知

1. **这是双端项目**：宿主侧（WorkBuddy 插件 + A2A 桥）与 VM 侧（vm-service + ps-bridge）
   是两套东西，用 `delivery/setup.mjs` 一键部署两端。改任一端都要想清楚另一端是否受影响。
2. **VM 服务强制只监听 `127.0.0.1`** —— 安全红线。任何放开绑定的改动都会被 `install-vm.mjs` 中止。
3. **能力是注册表驱动的**：新增能力只需改
   `packages/vm-capabilities/src/registry/definitions.ts` + 对应 `psmod/*.ps1`。**不要绕过注册表硬编码**。
4. **VM 内 Agent 是可替换的**：`workbuddy-deterministic` / `workbuddy` / `hermes-agent`
   实现同一桥接 SPI，切换靠 `WINVM_VM_PROVIDER`，**Skills 与协议层零改动**。
5. **GUI 能力受会话约束**：必须在**未锁屏 + Explorer 在跑**的交互式会话里，否则 `degraded`。
   这是刻意设计的安全门禁，**不要放宽判定**。
6. **文档与代码必须同源**：改行为前先改文档（DDD 原则 7）。

### 1. 开工前的阅读顺序

```
README.md（本文件）           ← 你已经在这
  → handover/01-project-overview.md      建立整体认知
  → .dev/README.md + .dev/docs-index.md  按 DDD 六索引进入权威细节
  → handover/06-lessons-learned.md       ★ 改码前必扫，能省几小时
  → handover/03-current-status.md        跑基线
  → handover/04-known-issues-and-roadmap.md  决定先做什么
```

需要深挖时：`docs/02-design/ARCHITECTURE.md` / `CAPABILITY-MODEL.md` / `SECURITY-GOVERNANCE.md`，
部署细节在 `docs/05-peripherals/DEPLOYMENT.md`。

### 2. 开发纪律（必须延续，否则会重复踩坑）

| 纪律 | 说明 |
|---|---|
| **DDD + plan-first** | 先规划任务树（执行-验证-反馈闭环）；改码前先改文档 |
| **单测逐文件跑** | 整批跑会假全红。命令见 `handover/03` |
| **`node --check`** | 交付脚本改后必做（但注意它查不出未定义引用） |
| **隔离验证** | 用 `--home <临时目录>` / `--root <假仓库>` / `mkdtemp` 跑真实安装，不污染本机 |
| **原子提交** | 一个逻辑改动一次提交；message 用 Write 写文件 + `git commit -F` |
| **同步 `.dev/` 六索引** | 每轮收尾更新 changed-log / docs-index / project-dev-status / project-dir-file-index |
| **诚实输出** | 宁可报真实错误，也不要「假阳性 ✅」 |

### 3. 动手前：先确认环境基线

```bash
npm ci && npm run build
for f in tests/unit/*.test.js; do node --test "$f"; done   # 期望 214/214
node packages/vm-service/dist/cli.js --self-test            # 期望 54 能力 + ps-bridge OK
```

基线不过就**先别改码**——大概率是新机环境问题（见 `handover/07`）。

### 4. 常见误判（别把环境现象当 bug）

| 看到 | 先怀疑 |
|---|---|
| `health` 里 `state:"degraded"` | VM 锁屏 / Explorer 未跑 / 服务不是在交互式会话起的 |
| `check` 报端口未监听但 `health` 正常 | 旧副本的探测假阴性（已修），或 VM 上跑的是旧部署 |
| RDP 里命令找不到、SSH 里能跑 | 陈旧会话 env 未刷新，新开终端或注销重连 |
| VM 卸载后回收站空 | SSH 下系统回收站不可见，东西在 `<repoRoot>/.uninstall-trash/<ts>/` |
| 本地 curl 经隧道不通 | 代理 TUN 拦截回环，加 `--noproxy` 或用 `localhost` |

### 5. 本项目「什么算完成」

一次改动完成 = ① 代码改完 ② `node --check` 通过 ③ 逐文件单测全绿
④ **文档同步**（`docs/` 相关章节 + `.dev/` 四份索引）⑤ 原子提交。
涉及部署行为的，还要在真 VM 上跑一次 `setup.mjs --apply` 验证。

### 6. 提交与推送

```bash
# message 用文件提交（heredoc 被安全策略拦截）
# 1) Write 写 .workbuddy/commit_msg.txt
# 2)
git add <范围> && git commit -F .workbuddy/commit_msg.txt
git push   # 远端：https://github.com/athronix/workbuddy-virtual-win-plugin（PRIVATE）
```

⚠️ 推送前**必做脱敏扫描**（命令见 `handover/06` D6）。真实 IP / 凭据一律进 `.env` 而非代码。

### 7. 接手后建议优先做什么

按 `handover/04` 的 E 节：

1. 跑通基线（不需要真 VM）
2. 重建 `.env` + 授权新机 SSH 公钥
3. **A1 真机 `--self-test`** + **A4 SSH 隧道端到端调一次工具** ← 决定「能不能用」
4. **A5 双连接器是否同时生效** ← 决定宿主侧架构要不要改
5. 再处理 A2 / A3 / A6 与 C 类增强（能力广度、更多宿主/VM Agent 适配）

---

## 三、权威细节在别处

本目录是**导航与提炼**，不是替代。权威信息：

| 内容 | 位置 |
|---|---|
| DDD 六索引（目录地图 / 文档清单 / 开发状态 / 变更记录 / 待定项） | `.dev/` |
| 调研、13 篇设计文档、部署与用户手册 | `docs/` |
| 逐轮详细变更记录（462 行） | `.dev/changed-log.md` |
| 进行中 / 待定 / 未做清单 | `.dev/changing-log.md` |
| 各包与模块开发状态 | `.dev/project-dev-status.md` |

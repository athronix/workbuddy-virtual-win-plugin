# 铠大师 app 移植指南（PORTING-GUIDE）

> 目的：把 `feature/winvm-onetap` 一键部署能力移植进铠大师 app。
> demo 工程按「**框架与功能完全解耦**」设计：HAP 壳（`product/phone`）只负责挂载，
> 全部业务在独立 HAR（`feature/winvm-onetap`）中，不依赖 demo 的任何资源、包名、签名。

---

## 1. 解耦边界（先读这个）

```
deploy-demo-app/
├── AppScope/                     ← demo 专属（bundleName 等），移植时**丢弃**
├── product/phone/                ← 框架壳层：EntryAbility + Index 页挂载，移植时**替换**
│   ├── ets/entryability/EntryAbility.ets   （标准生命周期，无业务）
│   ├── ets/pages/Index.ets                 （仅 import DeployPage 并挂载）
│   ├── src/main/module.json5               （权限声明：INTERNET + READ_WRITE_DOWNLOAD_DIRECTORY）
│   └── resources/                          （图标/文案，壳层资源）
└── feature/winvm-onetap/          ← 功能层：**整目录即移植单元**
    ├── Index.ets                           （唯一出口，按需 re-export）
    ├── src/main/ets/domain/DeployModels.ts （纯契约类型，零平台 import）
    ├── src/main/ets/data/                   （GitHub 取包 / sha256 / 解压 / 共享目录 / 剪贴板）
    ├── src/main/ets/data/DeployEngine.ts    （编排引擎，**不 import 任何 ArkUI**）
    ├── src/main/ets/prompt/InstallPromptBuilder.ts
    ├── src/main/ets/ui/DeployPage.ets       （V1 页面；如目标工程用 V2 需重写）
    └── src/main/ets/util/Logger.ts
```

**移植单元 = `feature/winvm-onetap/` 整目录**。它不引用 HAP 的任何资源/包名；
HAP 也不反向引用 HAR 内部路径（只经 `Index.ets` 出口 import）。

## 2. 移植方式 A：Har 依赖接入（推荐）

1. 拷贝 `feature/winvm-onetap/` 至铠大师工程（如 `feature/winvm-onetap/`）。
2. 在**宿主 HAP 的** `oh-package.json5` 加依赖：
   ```json5
   { "dependencies": { "winvm_onetap": "file:../../feature/winvm-onetap" } }
   ```
3. 宿主 `module.json5` 补齐权限（缺一不可）：
   - `ohos.permission.INTERNET`（下载发布包）
   - `ohos.permission.READ_WRITE_DOWNLOAD_DIRECTORY`（落共享目录；`reason`/`usedScene` 按平台规范写）
4. 宿主页面挂载（任选一）：
   - 整页：`import { DeployPage } from 'winvm_onetap';` 后 `<DeployPage/>`
   - 嵌入自有页：页面结构自绘，调用 `DeployEngine`（见 §4）自行编排
5. `DeployPage` 内 VM Host/User 默认值按铠大师实际环境改（当前默认 `172.16.100.10`/`User`，演示用）。

## 3. 移植方式 B：源码合并

若铠大师不想引入 HAR：把 `src/main/ets/{domain,data,prompt,util}` 四个目录并入自有
`ets` 树，`ui/DeployPage.ets` 仅作参考实现。需自行处理：
- 与铠大师工程内可能同名的 Logger/TAG（本 HAR 用 hilog domain 0xF822 + TAG `WinVMOnetap`）；
- 目录即类型名唯一性（`WinvmConfig`/`DeployReport` 等契约类型勿重名）。

## 4. 引擎 API（自绘 UI 用）

```ts
import { DeployEngine, DeployEngineCallbacks, WinvmConfig, ResolvedRelease, DeployReport }
  from 'winvm_onetap';

const engine = new DeployEngine(uiAbilityContext, {
  onLog: (entry) => { /* UI 日志列表 */ },
  onStage: (stage, text) => { /* 状态机文案 */ },
  onProgress: (received, total) => { /* 进度条 */ },
  onReport: (report) => { /* report 读回渲染；undefined=未采信 */ }
});

await engine.resolveRelease(config);   // 权限 + latest 解析
await engine.fetchPackage(config);     // 全链：下载→校验→解压→落共享目录（含权限申请）
await engine.copyPrompt(config, release); // 生成安装 prompt 并复制到剪贴板
engine.startReportPolling();           // 10s 轮询 report 副本，采信即停（30min 超时）
engine.readReportNow();                // 手动刷新（同步）
engine.stopReportPolling();            // 页面销毁时务必调用
```

`DeployEngine` 零 ArkUI import，可在 ServiceAbility/后台任务中直接复用。

## 5. 铠大师侧需自行补齐的能力边界

| 能力 | demo 状态 | 移植后 |
|---|---|---|
| ① 发布包下载/校验/落共享目录 | ✅ 已实现 | 直接复用 |
| ② VM 环境准备（推送 tools/winvm-prepare.ps1） | ❌ 演示版不实现（需铠大师既有 VM 软件安装通道） | 由铠大师 app 的既有通道执行，脚本**引用父仓库 `tools/winvm-prepare.ps1` 同一资产，勿 fork** |
| ③ prompt 生成与复制 | ✅ 已实现 | 直接复用 |
| ④ report 读回 | ✅ 共享目录副本轮询 | 直接复用（依赖 prompt 步骤 9 的旁写副本；见 issues ID-2） |
| WorkBuddy 安装检测 | 文案引导降级 | 若铠大师为系统预置可申请权限精确检测（issues ID-3） |

## 6. 移植检查清单

- [ ] HAR 目录整体拷贝，`Index.ets` 出口未改
- [ ] 两项权限 + `reason`/`usedScene` 声明
- [ ] `oh-package.json5` 依赖路径指向新位置
- [ ] `DeployPage` 默认 VM 地址按实际环境调整
- [ ] 编译 SDK 版本基线：compile/target `6.1.0(23)`、compatible `6.0.0(20)`（API 23）
- [ ] prompt 模板与父项目 §5.2 同步（若父项目修订了模板/或纳入步骤 9 正式版，需同步 `InstallPromptBuilder`）
- [ ] 旁挂 `.sha256` 解析口径保持「空白分隔首 token」（静态验证 D1，勿回退）
- [ ] 页面销毁调用 `stopReportPolling()`
- [ ] 若有自定义 UI：引擎回调 + `FetchStage` 状态机自绘

## 7. 契约依赖（父项目变更时需联动）

prompt 模板、zip/sha256 命名与 URL、deploy-report JSON 结构均以父项目
`docs/deploy/` 与 `delivery/pack-release.mjs` 为真相源。父项目发布 REL 新版本时：
1. 核对 §5.2 prompt 步骤措辞是否变化（InstallPromptBuilder 逐字对齐）；
2. 核对 zipNameFor / sha256SidecarContent 契约（pack-release.mjs）；
3. 核对 deploy-report 字段（docs/deploy §5.3）。

# PROJECT-OVERVIEW — 项目概况理解

> DDD Phase 1 Step 1.1 调研产物 · 版本 v1.0.0 · 2026-10-20
> 项目：`workbuddy-virtual-win-plugin/deploy-demo-app`（demo 子项目，鸿蒙 native app）

---

## 1. 本子项目定位

`deploy-demo-app` 是 `workbuddy-virtual-win-plugin`（下称 **父项目**，仓库
`/storage/Users/currentUser/Documents/projects/workbuddy-virtual-win-plugin`，**只读**）的
**演示性子项目**：开发一个极简鸿蒙 native app（ArkTS），在真机环境实现父项目的
**一键下载安装部署及验证**功能（含生成 WorkBuddy prompt 与复制按钮），用于：

1. 验证「一键安装逻辑」在鸿蒙真机上的真实可行性；
2. 为铠大师 App 团队移植该功能提供**参考实现**。

父项目本体是一个跨 5 个环境层的部署体系；本 demo 只实现其中**鸿蒙普通 App 权限可达**的部分，
其余（VM 侧 OS 级前置、WorkBuddy 沙箱内执行）由既有链路承担。边界见 §5。

## 2. 父项目部署体系（调研结论摘要）

### 2.1 五层环境模型（源自 `docs/deploy/通过铠大师app安装部署.md` §1）

| 层 | 说明 | WorkBuddy 可达性 | 本 demo 可达性 |
|----|------|------------------|----------------|
| L1 鸿蒙宿主 OS | HarmonyOS NEXT，每 App 独立沙箱 + HMMAC，无 root 概念 | ❌ 仅 $HOME（hmdfs 共享目录） | 同左（普通三方 App） |
| L2 WorkBuddy App 沙箱 | `com.tencent.workbuddy`，自带 node/electron | ✅ 本尊 | ❌ |
| L3 用户共享数据目录 | `/storage/Users/currentUser/`（hmdfs），含 `Download/` | ✅ 读写 | ✅（经 `READ_WRITE_DOWNLOAD_DIRECTORY` 权限，PC/2in1 端） |
| L4 VM Windows 系统层 | OpenSSH Server / 防火墙 / Node 等 OS 级前置 | ⚠️ 仅 SSH 之后 | ❌（需铠大师 VM 通道） |
| L5 VM↔宿主 SSH/隧道 | ssh/scp 免密通道 + tunnel-daemon | ✅ 通道建立后 | ❌ |

### 2.2 一键部署四方职责（§2 职责矩阵）

- **铠大师 App**（鸿蒙端高权限）：L3 落包 + L4 前置 + prompt 生成 + 结果读回。
- **WorkBuddy**（宿主沙箱）：L5 通道 + 插件安装 + VM 服务部署 + 功能验证，全部由 prompt 驱动。
- **用户**：点 3 下 + 粘贴 1 次。
- **本 demo App**（普通三方）：复刻铠大师侧**权限可达**的三件半——
  ① L3 落包（下载+校验+解压）、② VM 前置（不可达，仅留界面对照说明）、
  ③ prompt 生成复制、（自动）deploy-report 读回。

### 2.3 发布链与分发事实（REL-11 起，§4.4 + 实测核实）

- 仓库已 public：`github.com/athronix/workbuddy-virtual-win-plugin`。
- 分发单元：GitHub Release 匿名资产 `winvm-overall-<version>.zip`（+ 旁挂 `.zip.sha256`）。
- 实测（2026-10-20）：latest = **V1.4.0**；资产 `winvm-overall-V1.4.0.zip` = 2,701,725 bytes，
  旁挂 `winvm-overall-V1.4.0.zip.sha256` = 91 bytes。
- latest tag 解析 API：`https://api.github.com/repos/athronix/workbuddy-virtual-win-plugin/releases/latest`
  返回紧凑 JSON，取 `tag_name`；**解析为空必须停下报错**，绝不带空 tag 拼 URL（§5.2 Q-5）。
- 包形态：overall 目录含 `deploy-all.sh` / `MANIFEST.txt` / `.env.example` / `README.md`
  + host/vm 子包；`deploy-all.sh --wipe` = 双端清场 → HOST→VM→VM-START→TUNNEL→TEST→QA-PROBE→HEALTH 七相位。

### 2.4 验证与交回接口

- 验证矩阵 7 项（health / capabilities / systeminfo / a2a / gui / audit / bothends，§6）。
- 唯一交接口：`/storage/Users/currentUser/.workbuddy/winvm/deploy-report.json`
  （写完 stat 二次确认 >0B 防假空；`finishedAt` 字段存在才采信，§5.3 G10）。

### 2.5 鸿蒙侧关键技术事实（全部经官方文档/实测核实，非记忆）

| # | 事实 | 结论 | 依据 |
|---|------|------|------|
| F1 | 共享目录名 | 本机为 `Download`（**单数**）；父文档一律写 `~/Downloads`（复数）——不一致，登记 issues | `ls /storage/Users/currentUser` 实测 |
| F2 | `READ_WRITE_DOWNLOAD_DIRECTORY` | normal 级、user_grant、API 12+；PC/2in1 可遍历整个 Download 目录及子目录；上架不需 ACL | 官方权限列表 + 社区实测 |
| F3 | `Environment.getUserDownloadDir()` | `@kit.CoreFileKit`；PC/2in1 API 13+ 正常；API 12+ 取路径本身不需权限（读写才需） | 官方 API ref |
| F4 | `zlib.decompressFile(inFile, outFile, options?)` | inFile 须 `.zip` 结尾且为**沙箱路径**；outFile 目录必须**已存在**；返回 Promise | 官方 API ref |
| F5 | `http.requestInStream(url, opts)` | 流式下载；`on('dataReceive'/'dataReceiveProgress'/'dataEnd')` 事件；落盘用 `fs.writeSync(fd, buf)` 不传 offset（文件指针自然前进） | 官方指南 + 社区实战 |
| F6 | sha256 | `cryptoFramework.createMd('SHA256')` → `update({data})` 分段 → `await digest()` → `.data`（hex 化需自写） | 官方加解密指南 |
| F7 | 剪贴板写入 | `pasteboard.createData(MIMETYPE_TEXT_PLAIN, text)` + `getSystemPasteboard().setData(data)`；**写剪贴板不需权限**（读才需 READ_PASTEBOARD） | 官方架构指南 |
| F8 | Toast | `this.getUIContext().getPromptAction().showToast(...)`；API 18 起静态 `promptAction.showToast` 已废弃 | 官方社区 |
| F9 | 版本基线 | 本机 HarmonyOS 6.1.0 = **API 23**（`6.1.0(23)`）；版本串新格式 `6.1.0(23)`；API 20=6.0.0、API 22=6.0.2 | 官方兼容性说明 |
| F10 | 跨应用检测不可行 | 查其它 App 是否安装需 `GET_BUNDLE_INFO_PRIVILEGED`（system_basic），普通三方拿不到 → demo 无法检测 WorkBuddy 安装态 | 官方 API ref |

## 3. 既有参考工程

- `app-shell-bridge`（同用户目录 `/storage/Users/currentUser/Documents/projects/app-shell-bridge`）：
  鸿蒙侧与 host 侧桥接的先例，可作为 ArkTS 工程组织风格参考（不构成依赖）。
- 本仓 `tools/winvm-prepare.ps1`：VM 前置单一真相源（ASCII/CRLF/无 BOM，八核心键 KV 契约），
  demo 不做 VM 通道，仅在 UI 与文档中对其引用说明。

## 4. 工具链现状（影响验证策略）

- 本开发环境（HarmonyOS PC 上的 WorkBuddy 沙箱）**无 DevEco Studio / hvigorw / SDK**，
  不能执行编译与真机安装。
- 因此本 demo 的验证方式 = **静态自审**（对照 hmos-arkui-develop-skill quick-rules 逐条过）
  + API 签名全部有官方文档依据 + 提供**用户可执行的 DevEco 构建/运行步骤清单**。
  交付物中必须明确标注「未执行编译/设备验证」。

## 5. demo 功能边界（与铠大师能力的分界）

| 铠大师能力（§4） | demo 实现 | 说明 |
|------------------|-----------|------|
| ① 获取发布包（curl 下载+sha256+unzip 落 L3） | ✅ 完整实现 | 沙箱内下载/校验/解压 → 真实目录复制到 `Download/winvm-release/`（F4/F5 + G7 铁律） |
| ② VM 环境准备（执行 winvm-prepare.ps1） | ❌ 不实现 | 需铠大师 VM 软件安装通道（普通 App 无能力）；UI 保留禁用态按钮 + 文档说明单真相源位置 |
| ③ 复制安装指令（prompt 生成+复制） | ✅ 完整实现 | 按 §5.2 模板参数化生成，剪贴板写入 |
| 状态读回（轮询 deploy-report.json） | ✅ 实现（镜像路径） | 规范路径 `.workbuddy/winvm/` 普通 App 不可读；由 prompt 追加旁写副本到 `Download/winvm-release/` 供读回；差异登记 issues |
| WorkBuddy 安装检测（G11） | ❌ 不实现 | F10：普通三方无法跨应用查询；改为界面文字提示 |

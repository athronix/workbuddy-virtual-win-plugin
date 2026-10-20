# TEST-PLAN — 测试方案设计

> DDD Phase 2.3 产物 · 版本 v1.0.0 · 2026-10-20
> 前提约束：本开发环境无 DevEco/hvigor/设备 → 不执行编译与真机运行；
> 本文档 = 静态验证方案 + **交由用户在 DevEco 执行**的真机验证方案。

---

## 1. 测试策略

- **策略 S1（静态门禁，本环境可执行）**：quick-rules 规则逐条自审 + API 签名核对表 +
  工程结构核对（对照 DevEco 多模块模板）。
- **策略 S2（真机验证，用户执行）**：给出可照做的步骤清单与预期判据（见 §5），
  覆盖 FR-1..FR-7 全功能面。
- **策略 S3（降级预演，用户执行）**：断网/坏包/拒权限三条异常路径。

## 2. 系统级测试方案（S2 入口）

| 用例 | 步骤 | 预期判据 |
|------|------|----------|
| TC-E2E-01 | 填 VM 信息 → ④一键部署 | ①步全绿：日志四阶段、`Download/winvm-release/winvm-overall-V1.4.0.zip` 与 overall/ 目录存在 |
| TC-E2E-02 | ③复制安装指令 → 任意输入框粘贴 | prompt 逐字含 V1.4.0、VM_HOST、VM_USER、provider、步骤 1–8 + 步骤 9 |
| TC-E2E-03 | 切 WorkBuddy 粘贴 prompt 发送 → 回 demo 等状态 | 10s 内开始轮询；WB 完成后 report 副本被采信；面板 ok=true + 7 checks |

## 3. 模块级测试方案（S1 静态 + S2 真机抽查）

| 模块 | 静态核对 | 真机判据 |
|------|----------|----------|
| GitHubReleaseClient | URL 模板/MANIFEST 一致；200 判定；destroy 调用 | latest 解析得 V1.4.0；下载进度条有推进 |
| Sha256Verifier | 分片循环边界；hex 小写；旁挂解析 | 与 `sha256sum -c` 结果一致（用户可对照） |
| ZipExtractor | outDir 预创建；level 参数正确 | overall/ 内 deploy-all.sh、MANIFEST.txt 在册 |
| SharedDirStore | 递归复制覆盖语义；无 link；句柄 close | L3 文件数与 staging 一致 |
| ClipboardService | 写剪贴板无权限依赖；异常 try/catch | 粘贴文本 == 生成文本 |
| InstallPromptBuilder | 占位符防呆；步骤 9 位置 | TC-E2E-02 |
| DeployEngine | 无 ArkUI import；回调单向 | 轮询 30min 超时提示出现 |

## 4. 单元级（逻辑）测试用例（S1 走查清单）

- UT-01 latest 空 tag → resolveLatest 抛 E1001（代码路径核对：无空串继续分支）。
- UT-02 旁挂解析：`"abc…(64)  winvm-overall-V1.4.0.zip\n"` → 取 64 hex；大小写归一。
- UT-03 sha256 比对失败 → 错误信息含 actual/expected 双值。
- UT-04 report 假空（0B 或非法 JSON）→ 不采信不崩、记录 E6001、继续轮询。
- UT-05 版本手填 `V1.4.0` 与 latest 解析路径 → URL 组装相同（同一资产）。
- UT-06 表单缺 VM_HOST → 按钮禁用态与提示出现（不发起任何请求）。

## 5. 用户可执行的 DevEco 真机验证步骤（S2/S3 操作单）

```
前置：DevEco Studio 6.1.0（API 23 SDK）· 鸿蒙 PC 真机（开发者模式 + hdc 连接）· 已装 WorkBuddy
1. File > Open 选 deploy-demo-app → Sync 成功（oh_package 解析无误）。
2. Product default → Sign in 自动 debug 签名（自动生成）。
3. Run 'phone' 到真机：App 图标启动，进入「WinVM Bridge 部署助手」页。
4. TC-E2E-01/02 按 §2 执行。
5. 异常预演：
   a. 断网点① → 预期 E1002 + .part 清理 + 可重试；
   b. 手动改坏 staging 内 zip 再触发校验（或用旧版包冒用）→ E2001 弃包；
   c. 系统设置撤掉 Download 目录权限 → ① 置灰 + 引导（恢复后可重试）。
6. 证据留存：截图 + hilog（TAG=WinVMOnetap）。
```

## 6. 回归范围

- 版本号只改 tag：UT-05 覆盖。
- prompt 模板变更：必须同步父文档 §5.2 并登记 issues（防模板漂移）。

## 7. 通过标准

- S1：规则自审 0 违规、API 签名核对率 100%、工程结构核对通过。
- S2：TC-E2E-01..03 全过 + 异常预演三条符合预期（由用户回填结果）。

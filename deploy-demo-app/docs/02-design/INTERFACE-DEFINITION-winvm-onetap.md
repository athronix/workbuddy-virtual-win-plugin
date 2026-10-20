# INTERFACE-DEFINITION — 接口定义（对外契约）

> DDD Phase 2.2 Step 2.2.5 产物 · 版本 v1.0.0 · 2026-10-20

---

## 1. HAR 对外 API（`Index.ets` 出口）

```ts
export { DeployPage } from './src/main/ets/ui/DeployPage';          // 挂载即用页面
export { DeployEngine } from './src/main/ets/data/DeployEngine';
export type { DeployEngineCallbacks } from './src/main/ets/data/DeployEngine';
export type { WinvmConfig, DeployReport, ReportCheck, ResolvedRelease, FetchStage }
  from './src/main/ets/domain/DeployModels';
export { GitHubReleaseClient, Sha256Verifier, ZipExtractor, SharedDirStore, ClipboardService }
  from './src/main/ets/data/...';
```

宿主最小接线（移植契约）：
```ts
// pages/Index.ets
import { DeployPage } from 'winvm_onetap';

@Entry
@Component
struct Index {
  build(): void {
    Column() {
      DeployPage()          // 页面内部经 getUIContext().getHostContext() 自取 context
    }
  }
}
```
宿主职责（缺一不可）：module.json5 声明
`ohos.permission.INTERNET` + `ohos.permission.READ_WRITE_DOWNLOAD_DIRECTORY`；
deviceTypes 含 `PC` 或 `2in1`。

## 2. GitHub Release 下载协议（外部接口）

| 项 | 值 |
|----|----|
| latest 解析 | `GET https://api.github.com/repos/athronix/workbuddy-virtual-win-plugin/releases/latest` → `tag_name` |
| zip 资产 | `GET .../releases/download/<V>/winvm-overall-<V>.zip` |
| 校验旁挂 | `GET .../releases/download/<V>/winvm-overall-<V>.zip.sha256`（一行 `<hex>  <name>`） |
| 认证 | 无（匿名） |
| 期望状态码 | 200（requestInStream 返回码） |
| 版本空值纪律 | latest 解析为空 → 中止，禁止拼 URL |

## 3. install prompt 契约（与 WorkBuddy 的接口）

- 模板来源：父项目 `docs/deploy/通过铠大师app安装部署.md` §5.2，**逐字一致**，
  仅做 `{VERSION}/{VM_HOST}/{VM_USER}/{WINVM_VM_PROVIDER}` 参数代入。
- demo 唯一追加 = **步骤 9**（旁写副本）：
  ```
  9. 部署状态旁写副本（部署助手读回用）：将第 7 步写出的 deploy-report.json 复制一份到
     /storage/Users/currentUser/Download/winvm-release/deploy-report.json
     （mkdir -p 确保目录存在；不影响第 7 步规范路径本身）
  ```
- 产出目标：系统剪贴板（MIMETYPE_TEXT_PLAIN）。
- 防呆：生成结果不得含 `{` 占位残留。

## 4. deploy-report 读回契约

- 读回路径：`<Environment.getUserDownloadDir()>/winvm-release/deploy-report.json`。
- 采信条件（全部满足）：字节数 > 0、JSON.parse 成功、`finishedAt` 非空字符串。
- 字段口径：`version/ok/finishedAt/phases/checks[].{id,pass,evidence}/failures[]`
  （父文档 §5.3，demo 只读不写）。
- 轮询：10s 间隔；30min（180 次）无采信 → 「尚未开始」态并继续轮询（由用户手动停止）。

## 5. 错误码约定（界面/日志可见）

| 码 | 含义 | 触发点 |
|----|------|--------|
| E1001 | latest 解析失败 | GitHubReleaseClient.resolveLatest |
| E1002 | 下载非 200 / 网络错误 | download |
| E2001 | sha256 不匹配 | Sha256Verifier.verify |
| E3001 | 解压失败 | ZipExtractor.extract |
| E4001 | 权限被拒 | SharedDirStore.ensureDownloadPermission |
| E4002 | L3 复制失败 | exportTree |
| E5001 | prompt 占位符残留 | InstallPromptBuilder.build |
| E6001 | report JSON 非法/窗口假空 | readReportMirror（不中止，仅记录） |

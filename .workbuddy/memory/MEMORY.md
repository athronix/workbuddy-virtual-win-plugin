# 项目长期记忆 · winvm-virtual-win-plugin
> 跨会话事实。交接=`.workbuddy/README.md`；批次细节=`docs/archive/changes/`、`qa/p3-batch-sweep/`；决策台账=`~/winvm-deploy/deploy-session.md`（新会话先读）。

## 架构与拓扑
- 宿主 WB 插件操作 Win11 VM `172.16.100.2`：54 能力（system14/app8/appops5/storage13/gui11/meta3；L0:27/L1:19/L2:7/L3:1），工具名点分 `winvm__system.info.get`。双通道 `/mcp`（直调）+ `/a2a`（委派，审批流）同进程同隧道。VM 服务只听 `127.0.0.1:18443`，计划任务 `WinVMBridge.Service` 托管 `ps-bridge.ps1`（改 psmod/*.ps1 必重启）。
- VM：ssh 用户=**User**（非 towyq），密码非空**不落库**；Node=nvm-windows（prefix `%LOCALAPPDATA%\Author Software\nvm\installs\vXX`；**切版本→全局 CLI 消失需重装**；`npm i -g` 免提权；**winget 经 ssh=MSIX 空壳不可用**）。`C:/WinVMBridge` 程序、`C:/WinVMWorkspace` 工作区、`~/.workbuddy/winvm/side.json`。
- 宿主（鸿蒙沙箱 uid 20020171，$HOME 唯一跨 App 通道）：插件缓存 `~/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0/`＝运行态真相源（单文件白名单 9 件；**winvm-plugin.mjs 新增相对 import 必须同进 install-host extraFiles + buildIntegrityFilePairs** 再 `--check-fresh` 对账）；skills 缓存 `~/.workbuddy/connectors/skills/connector-winvm/`（**7 个 winvm-*；hos-win-skill host-only 在 `~/.workbuddy/skills/`；仓库共 8 Skill**）；`~/.workbuddy/winvm/{vm-conn.json,tunnel.*}`；`disabledTools` 落点=**全局 `~/.workbuddy/mcp.json`**。
- provider：默认 `workbuddy`+`WINVM_WORKBUDDY_CLI=codebuddy`（stream-json 常驻非 ACP）；对照档 `workbuddy-deterministic`；`hermes-agent`。ACP 方案=CL-WBNATIVE **DEFERRED**（取证在 archive）。安装一律 **@latest 不锁版本**。npm workspaces 12 包 TS ESM：`tsc -b tsconfig.build.json`；**单测禁整批**→`node --test <单文件>`。

## 关键坑（改码前必扫）
- MSYS：远端逻辑 `.ps1→scp→powershell -File`；ASCII 载荷；`$_` 内联必坏；公钥等参数 **base64 单参**传；杀隧道直 kill PID 勿 pkill -f。
- **空密码网络登录=两层串联**（PermitEmptyPasswords 默认 no + LimitBlankPasswordUse=1），只改一层必败；两层同改后建好免密**立即回滚**（deploy-strategy §2.1-B）。
- **大文档多轮 Edit 必静默缩水/回退（10-26 两次）**：改前 `git show HEAD:` 留基线；批量改动=一次性脚本+每处 assert count==1+不匹配整体拒写；写后立即 `wc -l`+锚点 grep+扫控制字符（python 普通串写 Win 路径 `\n\v` 会转义！）；commit 前后各核一次。
- - 版本升版批**必须 grep 全仓旧 tag 清点同步面**（10-27 案：v2.9 变更行宣称"RELEASE_TAG 升 V1.4.4"但 strategy §0.5-B/§7 与 deploy-prompts §2.2 仍写 V1.4.3——声称≠已改；pack V7 断言同款思路=机械化替代人肉声称）。
- 搜索假阴性：**Grep 工具与 `git grep` 都漏过** →清点用文件系统 `grep -rn` 交叉；仓库清点 `git ls-files`。
- provider=workbuddy **禁批量 tasks/cancel**（真机红线）。ssh `cmd &` 脱管、schtasks 拖死通道→轮询 /health。VM-START bind EACCES=socket 未 drain→清持有者+等待重试。
- 沙箱路径：git/node/python3 全路径（`.harmonybrew/opt/git` / `el1/bundle/libs/arm64/node` / `/data/service/hnp`）；/tmp 只读→`$HOME/wbtmp`；rm shim 坏→fs.unlinkSync；getcwd 异常→绝对路径。
- 隧道黑洞判据 ping 100% 丢；tunnel-daemon.mjs + HOURLY watchdog `aaa87da4`。版本指纹>uptime。改源必即 tsc -b；守卫经 dist 消费；**注释文本也是守卫输入面**。spawn 必挂 exit+error。GitHub 与 VM **两把密钥**（id_ed25519_github）。PS5.1 Sort-Object 裸键失效。GUI 依赖 LogonTrigger 已登录会话，锁屏不可解。

## 口径与纪律
- 测试基线权威=`qa/p3-batch-sweep/` 最新 gate-*.txt 汇总行（现 2280 GREEN；文档禁硬编码）。门禁 `npm run gate`。
- 发布：旧包 `release/V<ver>.superseded-itN`；台账 `docs/release/ISSUES.md`（迭代6=V1.4.3 / 迭代7=V1.4.4 / 迭代8=V1.4.5 / 迭代9=V1.4.6 / 迭代10=V1.4.7 完善版，均开账即关）；每迭代 --wipe 重验；完成必 push origin。**V1.4.7=当前线上**（10-29 迭代10 完善版：文档自指根除=校验面权威源口径 `MANIFEST-sidecar-authoritative` 不再硬编码逐版本值，运行码同 V1.4.6；zip `a5ac52b7…`、tag@edd7e78、881/7613230/`09e2c953…`；包内 uninstall 19/19+38/38）。发布链断言面=**V1–V8**（V5 NON_ACCOUNT_DIRS/V6 cbSize/V7 cleanGlobalMcpJson/V8 文档权威口径标记）。发布探针判据面=包内 verify-release.mjs --expect-nonaccount-guard。
- 文档：导航权威 `.dev/docs-index.md`；归档 `docs/archive/{changes,audit,test}`+legacy-*（10-26 两次归位：OPS-OVERVIEW/INSTALL-VERIFY/根 overview/V1.0.0 notes；铠大师中文名保留——活引用+契约锚点）；**qa/ 保原位**（setup/pack-release 活引用）；改路径前先查活引用。证据每轮一份 real-test-<date>-runN.md；FAIL 四元组；裁决落档再引用。⚠ hmdfs `core.ignorecase=true`：git mv 改大小写**磁盘名可能不变**（ISSUES.md 案，10-26 两步 rename 实修），大小写敏感 glob/脚本会踩空。
- 团队派发：fresh Agent+窄任务书+即 commit+按 HEAD 独立核验；worker 静默 20min 熔断（主理人巡检 mtime+探针）。

## backlog（P2）
- **I-6.4 探针面双缺陷（10-29 第三轮往返 run2 发现并已修 HEAD）**：D-1 verify-manifest.py/verify-release.mjs 对**已装态包根**假 FAIL（安装体系运行期自写产物 `.env`/`delivery/winvm-plugin(.cmd)` 被判多余——前两轮 Step 2.3 从未在此场景跑，本轮按 .prompt 直跑路径首触）；修复=runtime 白名单三条+四场景回归（含 canary 负例仍 FAIL=检出力未削）。D-2 vmcheck.ps1 GBK 双坑（PS5.1 Content 无 charset JSON 按 GBK 解码+重定向 stdout 控制台码页）→ RawContentStream 显式 UTF-8+`[Console]::OutputEncoding=UTF8`，**探针 ASCII-only 二次坐实**。⚠ 晚于 V1.4.7 打包→随下迭代收编；建议下迭代给 pack 加 **V9 断言**（包内 verify-manifest 必含 RUNTIME_OK）待裁定。教训：**探针判据要跑遍已装态/纯净态两场景**。
- ~~`.prompt` 纯脚本入包与否~~ → **10-29 用户裁定并入包（迭代9/V1.4.6）**：OVERALL_DOCS+PACKAGE_REQUIRED 收编两脚本；README §5.4 配置用法说明。时序教训沿用：**pack 前一切文档改动先 commit**（V1.4.5 superseded-it1 案）。
- ~~打包 docs 面口径疑点~~ → **10-28 裁定并入包（V1.4.5/迭代8）**：OVERALL_DOCS 增 `docs/deploy/` 三篇（子目录化拷贝+PACKAGE_REQUIRED 断言）；三元组随之=879/7580107/88fd11c1…。注意时序教训：**pack 前一切文档改动先 commit**（首打包早于 docs 同步=superseded-it1 重打案例）。
- ~~I-6.3 uninstall.mjs 镜像不对称~~ → **10-28 随 V1.4.5 入包关闭（迭代8）**：cleanGlobalMcpJson+markers 补名；V7 断言首战通过+包内 uninstall 实弹拆除 19/19。教训留册：自报全绿≠拆干净，不对称靠**独立复核面**抓（undeploy U4.2）。
- **I-6.1 gui.ps1 PS5.1 `Marshal::SizeOf([Type])` 真 bug（10-27 发现并已修）**：键鼠输入自上线从未真跑通（20 项验收不含键鼠写面）；修复=实例重载 `SizeOf($arr[0])`+防回归钉 example-probe E11。已随 V1.4.4（2789957，2026-10-27）关闭：修复入包 + pack V6 断言钉死 cbSize + 清场重装 25/25 + example 13/13（ISSUES 迭代6 追加/迭代7、strategy §9.3）。教训：**能力写面必须真跑**，静态核对会漏 P1。**
- ~~G-1/G-2/G-3~~ → **10-26 销账（V1.4.3 发布闭环）**：G-1 修复入包+pack V5 硬断言（host/overall 包内 install-host 必含 NON_ACCOUNT_DIRS≥3）；G-2 `delivery/verify-release.mjs`（=verify-manifest.py 四判据+V5）入包；G-3 六探针+diagnose-connectors 入 overall（PACKAGE_REQUIRED 兜底）。复验：非账户零污染、连接器 8 skill、run2 25/25。github.com 直连不稳→切 **api.github.com asset 端点**取旁挂（三向对账）。
- 其他：冷启动 49.3s TTL 保持 5min；teams 残骸永久不动；GUI preflight P2 观察。~~VM 不可达~~ → 10-26 19:3x 恢复（三探针 25/25 + example 8/8；example-probe 修 3 缺陷：timeout 形参/E2b path+白名单目标/E6 断言读宿主 mcp.json disabledTools——勿再断原始 tools/list）。

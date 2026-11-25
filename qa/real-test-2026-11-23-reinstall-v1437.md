# 真机实测：按 Gitee INSTALL_PROMPT 装技能 → 彻底卸载 → 重新安装并验证

- 日期：2026-11-23
- 源：`https://gitee.com/sanway-tech/skills/raw/main/winvm-plugin-deploy.link.json`（用户裁定收口到 `sanway-tech` 账号，Gitee 优先 / GitHub 兜底）
- 技能版本：`winvm-plugin-deploy v2.6.0`
- 母项目发布版本：`V1.4.37`
- VM：`172.16.100.2` / 用户 `User`（Windows 11 家庭版 26200 / ARM64 / StratoVirt 6 核 8G）

---

## 一、技能安装（INSTALL_PROMPT 五步协议）

| 步 | 动作 | 结果 |
|---|---|---|
| §1 | 读 `<skill>.link.json` | HTTP 200；`repo=github.com/sanway-tech/winvm-plugin-deploy`、`visibility=public`、`version=2.6.0` |
| §2 | 凭据 | **整节跳过**（`visibility==public` ⇒ 全程匿名，无 token） |
| §3 | 取产物 | 方式 A（release zip）；HTTP=200、SIZE=**246987**、sha256 与 release asset 一致 |
| §4 | 装载 | 先判 `[ -L ]` → `IS_SYMLINK=yes`；包内 33 文件 vs 链接目标 **SAME=33 / DIFF=0**（逐字节相同）⇒ **只核指向、不 `cp -r`**，保留软链 |
| §5 | 验证 | `name==winvm-plugin-deploy`、`version==2.6.0`（== link.json）、`scripts/` 26 件 / `references/` 5 件 / root 6 件 |

安装路径：`~/.workbuddy/skills/winvm-plugin-deploy` → `/storage/Users/currentUser/Documents/Projects/skills/winvm-plugin-deploy`
备份：无（软链未被改动，无需备份）

> 保留软链而非改指缓存目录的理由：若改指向 `$TMPDIR` 解包目录，技能会随缓存清理而消失。

---

## 二、彻底卸载

命令：`VM_HOST=172.16.100.2 bash scripts/undeploy.sh`
结果：**UNDEPLOY=PASS**，`host=clean vm=clean tunnel=no`，WALL_S=**118**

| 步 | 耗时 | rc |
|---|---|---|
| 2a 通道状态（只判不建） | 1s | 0 |
| 1a 停 winvm-tunnel service | 3s | 0 |
| 1b 卸 host 端插件（uninstall.mjs host-only） | 2s | 0 |
| 2b 推 VM 侧卸载脚本 | 4s | 0 |
| 1c host 端清空复核 | 1s | 0 |
| 2c 停服务 + 卸模块（vm-remove-local.ps1 -Apply） | 96s | 0 |
| 2d VM 终态五点（+上游） | 15s | 0 |
| 3a SSH 通道处理（`--remove-ssh-tunnel no`，保留） | 0s | 0 |

### 卸载终态独立取证（不采信脚本自报）

```
① host mcp.json      .workbuddy / 8dd0df6a / default 三处 winvm_hits=0
② 裸 TCP 18443        ECONNREFUSED
③ VM 侧六点            bridge_dir=False
                      task_rc=1（schtasks 查不到 WinVMBridge.Service）
                      svc_count=0
                      port18443=False
                      node_left=False（C:\nodejs 已删）
                      upstream_npm=False（agent-browser/agent-desktop 已删）
                      workspace=True（未加 --purge-workspace，按设计保留）
④ 宿主残留进程         PID 33170 = a2a-bridge cli.js --endpoint http://127.0.0.1:18443
                      父进程 33133 = 当前 codebuddy --serve 会话
                      ⇒ WorkBuddy 作为 MCP 客户端拉起的 stdio 子进程残留，
                        端口已拒绝连接、纯空转，不属部署物
```

---

## 三、重新安装

命令：`VM_HOST=172.16.100.2 bash scripts/deploy.sh`
结果：**DEPLOY=PASS**，`ALL_DONE=1`，WALL_S=**418**

| 步 | 耗时 | 关键输出 |
|---|---|---|
| 1a 判断免密通道 | 1s | `channel=READY key=id_ed25519_winvm` → 1b~1d SKIP |
| 2a 取发布包 | 1s | `ver=V1.4.37`，sha256 校验通过 |
| 2b MANIFEST 对账 | 1s | `RESULT: PASS` |
| 2c 两端结构就位 | 0s | host 4 件齐；`.env` 就位 |
| 2d install-host | 2s | H1 加固断言：活跃账户 `8dd0df6a` 与 `default` 的 mcp.json 均含 `connector:winvm` / `connector:winvm-a2a` ✓ |
| 2e host 交付判据 | 0s | `skills=10`（≥8） |
| 3a 对齐 identityFile | 0s | `id_ed25519_winvm` |
| 3b 起隧道服务 | 1s | `127.0.0.1:18443 → User@172.16.100.2:22 → 127.0.0.1:18443` |
| 4.0 通道门禁 | 1s | `channel=READY` |
| 3c 验证隧道 | 0s | `listen=yes daemon=yes(pid=20847) health=000`（VM 端未装＝从零合法中间态） |
| 4a prepare-vm | 93s | codebuddy OK / agent-desktop OK / agent-browser OK |
| 4b setup --only-vm | 201s | 部署全部完成；QA 探针夹具分发 18.2s |
| 4c vmcheck 七判据 | 44s | `task_state=Running listen_count=1 side_json=true bridge_dir=true health_http=200 browser=33 desktop=25` |
| 5 三探针 | 51s | mcp-probe **20/20 PASS**、a2a-probe **4/4 PASS +1 SKIP**、example-probe **10/10 +3 SKIP** ⇒ 合计 **34/34** |
| 5d 终态矩阵 | 18s | FRESH：缓存与仓库构建物逐文件 SHA256 全一致；`winvm disabledTools=8` / `winvm-a2a=0`；health=200；skills=10 |

### 重装后独立取证

```
① 裸 TCP 18443        OPEN
② health 正文         HTTP=200 SIZE=2311（非仅状态码）
                      provider=workbuddy/ready，approvalTruth.mode=on
                      psBridge.state=ready  uptimeMs=161648  pending=0  restarts=0
                      llmSession.state=ready pid=11584 restarts=0
                      session=healthy interactive=true locked=false
                      capabilities.count=54 available=54
                      audit.chainValid=true  entries=16
                      security.loopbackOnly=true boundLoopback=true
③ host mcp.json       三处均含 winvm / winvm-a2a / winvm-bridge / winvm-browser / winvm-desktop
④ 隧道 daemon         pid 20847（10:43:49 起，父进程 1）
```

### 实弹工具调用（排除"通而不通语义"的假通过）

| 通道 | 调用 | 结果 |
|---|---|---|
| direct MCP | `system.info.get` | `ok=true`、`traceId=tr_mwso5gke_15`、`auditRef=aud_c9d9e9b629644e39b8c0`、`WIN-HOS-YWANG-S`、Windows 11 26200、ARM64、6 核 8187MB、`isAdmin=true`、1553ms |
| A2A 委派 | `a2a.health` | VM Agent「WinVM Bridge Agent」v0.1.0 可达（`http://127.0.0.1:18443/a2a`），声明 5 技能：system-admin / app-manager / storage-manager / gui-automation / app-operation |

---

## 四、结论

| 项 | 结论 |
|---|---|
| 技能安装（五步协议） | ✅ 全通过；§2 因 public 仓整节跳过，全程匿名 |
| 彻底卸载 | ✅ host / VM 双端 clean，18443 ECONNREFUSED |
| 从零重装 | ✅ 5 步全绿，34/34 探针，FRESH 逐文件 SHA256 一致 |
| direct MCP 路径 | ✅ 实弹返回真实 VM 系统信息 |
| A2A 委派路径 | ✅ VM Agent Card 可达，5 技能齐 |
| 遗留 | 无阻塞项 |

### 观察项（非缺陷）

1. **卸载后宿主残留 stdio 子进程**：`a2a-bridge/cli.js` 由 WorkBuddy 会话持有，卸载不会（也不应）杀它——它属 MCP 客户端侧生命周期，端口断后纯空转。重装后同一 PID 33170 仍存，不影响新 daemon。
2. **`C:\WinVMWorkspace` 保留**：未加 `--purge-workspace`，符合默认语义（保留用户工作区数据）。
3. **4a 的 npm warn**：`install-scripts` 提示可再 apply 一次以允许脚本，本次两上游均 OK，不阻断。
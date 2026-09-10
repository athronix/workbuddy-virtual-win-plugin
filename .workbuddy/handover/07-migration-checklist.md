# 07 · 迁移落地清单（新机 Check List）

> 把项目 `cp` 到新机器后，**按顺序**执行。每步都有验证点，过不了别往下走。

## 0. 迁移前（本机已完成，供核对）

- [x] 全量推送到 GitHub 私有仓库 `athronix/workbuddy-virtual-win-plugin`（18 提交，`main` = `acc966b`）
- [x] 推送前脱敏：真实内网 IP 从受跟踪文件移除，改由 `.env` 提供
- [x] 交接文档落盘 `.workbuddy/README.md` + `.workbuddy/handover/*.md`
- [x] `.workbuddy/memory/MEMORY.md` 顶部加入迁移指针（保证新机 WorkBuddy 自动发现）

## 1. 代码就位（二选一）

**A. 整个目录 cp 过去**（推荐，含未入库的 `.env` 与 `.workbuddy`）
```bash
# 建议排除 node_modules / dist（内含 junction，跨机易失效）
rsync -a --exclude node_modules --exclude '*/dist' <源> <目标>
# 或 Windows: robocopy <源> <目标> /E /XD node_modules dist /XJ
```

**B. git clone**（干净，但 `.env` 不会跟过来）
```bash
git clone https://github.com/athronix/workbuddy-virtual-win-plugin
# 需要 gh 已登录；私有仓库需有权限
```

> ⚠️ `.env` 已被 `.gitignore` 排除（第 15 行）。走 B 方案**必须**重建（见第 3 步）。

## 2. 依赖与构建

```bash
cd workbuddy-virtual-win-plugin
npm ci                 # 或 npm install（registry 已配 npmmirror）
npm run build          # tsc -b，12 包
```
- 验证：`npm run build` 无错误退出。

## 3. 重建 `.env`

```bash
cp .env.example .env   # 然后按新环境填写
```

必填项：

| 键 | 说明 |
|---|---|
| `VM_HOST` | VM 地址。旧机填在 `.env` 里（未入库，需从旧机 `.env` 抄或按新网络重取）；如仍走 Tailscale，填**新机网络下**的 VM Tailscale IP |
| `VM_USER` | VM 登录用户（原 `User`） |
| `VM_SSH_PORT` | 默认 22 |
| `VM_DEPLOY_DIR` | VM 内部署根目录（原 `C:/Users/User/.WinVMBridge`） |
| `WINVM_SERVICE_PORT` | 默认 18443 |
| `WINVM_VM_PROVIDER` | `workbuddy-deterministic`（默认）/ `workbuddy` / `hermes-agent` |
| `HOST_DEPLOY` / `VM_DEPLOY` | 是否部署对应端 |

> 其余键见 `.env.example` 注释。**`.env` 含连接信息，确认它仍在 `.gitignore` 内，别提交。**

## 4. SSH 公钥（新机 → VM）

新机的公钥**不在** VM 的 `authorized_keys` 里，需补：

```bash
# 新机生成（若没有）
ssh-keygen -t ed25519
# 把公钥追加到 VM 的 %USERPROFILE%\.ssh\authorized_keys 并修 ACL
# 详见 docs/05-peripherals/DEPLOYMENT.md §8 / SECURITY-GOVERNANCE §6
ssh <user>@<vm>        # 验证免密可达
```

## 5. 基线验证（不需要真 VM）

```bash
# 单测：必须逐文件跑（整批会因 link-workspace junction 假全红）
for f in tests/unit/*.test.js; do node --test "$f"; done
# 期望：214/214

# VM 服务自检（本地即可跑）
node packages/vm-service/dist/cli.js --self-test
# 期望：6 能力域 / 54 能力 / ps-bridge 模块加载正常 / 各模块 L0 探针 OK
```

## 6. 部署（需要真 VM）

```bash
node delivery/setup.mjs           # 先 dry-run（默认），确认七阶段计划
node delivery/setup.mjs --apply   # 真执行
```

- 部署完**宿主侧**还需：WorkBuddy「连接器管理页」对 `connector:winvm` 与 `connector:winvm-a2a` 点 **Trust**。
- 重启一次 WorkBuddy 让其干净读取注册表。

## 7. 管理 CLI 可用性

```bash
winvm-plugin check           # 宿主侧查验
winvm-plugin health          # 走 SSH 读 VM /health
```
- 若报「命令找不到」：安装时会把插件缓存根加入用户 PATH，**新开终端**生效（新版本部署后会广播 `WM_SETTINGCHANGE`）。

## 8. 交接后优先补的真机验证

按 `04-known-issues-and-roadmap.md` 的 **E 节**顺序推进，优先 A1（真机 `--self-test`）与 A4（SSH 隧道端到端调一次工具）——这两个决定「能不能用」。

---

## 迁移后容易忘的三件事

1. **`.env` 不会跟 git 走** —— `git clone` 方案必做第 3 步。
2. **新机 SSH 公钥没在 VM 上授权** —— 否则 `ssh` 相关阶段全部失败。
3. **连接器要手动 Trust** —— 不点 Trust，WorkBuddy 不会激活 `connector:winvm` / `connector:winvm-a2a`。

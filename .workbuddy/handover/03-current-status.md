# 03 · 当前状态与验证方式

> 截至 2026-09-09（commit `acc966b`）。**交接时的确切基线与复现命令**都在这里。

## 代码状态

| 项 | 状态 |
|---|---|
| 12 个包 `npm run build`（`tsc -b`，TS strict ESM） | ✅ 全部通过 |
| 单元测试 | ✅ **214/214**（逐文件跑，16 个 `tests/unit/*.test.js`） |
| 设计文档（docs/ 全 13 篇） | ✅ 齐备 |
| Skills | ✅ 7 个（1 总控 + 5 领域 + mcp-reference） |
| 部署脚本 | ✅ host / VM / 双端一键 / 管理 CLI 全部可跑 |

## ⚠️ 运行单测的硬约束（必读）

**绝对不要**整批跑 `node --test tests/unit/*.test.js`。

- 原因：`link-workspace.test.js` 里的 `symlink(..., 'junction')` 在本沙箱触发 Node 进程访问违例（`exitCode 2147483651` / `0xC0000005`），会**打崩共享 runner**，导致同进程所有文件被连带判死、呈「整批假全红」且无汇总计数——**代码其实一行没坏**。
- 正确做法：

```bash
NODE=<node 绝对路径>
for f in tests/unit/*.test.js; do
  echo "=== $f ==="
  "$NODE" --test "$f" 2>&1 | grep -E '^# (pass|fail)'
done
```

- 单跑 `link-workspace.test.js` 是 16/16 正常的。改动后复核一律沿用此法，否则极易误判回归。

## 常用验证命令

```bash
# 1) 语法快检（交付脚本改动后必做）
node --check delivery/<script>.mjs

# 2) 构建
npm run build

# 3) 单测（逐文件，见上）
for f in tests/unit/*.test.js; do node --test "$f"; done

# 4) VM 服务自检（本地即可跑，不需真 VM）
node packages/vm-service/dist/cli.js --self-test
#    期望：6 能力域 / 54 能力 / ps-bridge 模块加载正常 / 各模块 L0 探针 OK

# 5) 双端一键部署（默认 dry-run，--apply 才真执行）
node delivery/setup.mjs            # 只规划，零改动
node delivery/setup.mjs --apply    # 真执行

# 6) 管理 CLI（host / VM 同一份，自动识别上下文）
winvm-plugin check          # 查验部署完整性
winvm-plugin health         # /health（VM 内自动走本地，宿主走 SSH）
winvm-plugin list mcp-tools # 54 项按域分组
winvm-plugin server restart # 重启 VM 服务（启用 GUI 需在交互式会话内执行）
```

## 真机已验证（2026-09-02 ~ 09-03，远端 Tailscale Windows VM）

- `setup.mjs --apply` 全绿：BUILD / HOST / VM / TUNNEL / TEST 五阶段 `SETUP_EXIT=0`
- 远端 self-test：能力域 6 / 能力 **54 项**、`ps-bridge 已启动，模块加载正常`、system/gui/storage/appops 探针 OK
- `/health` 端到端首次跑通：`ok=true` / `provider=workbuddy ready` / `psBridge ready` / `capabilities 54/54 available` / `audit chainValid`
- 三处远程分发修复在真机落地：junction 软链 12/12、psmod/schemas 随行、ps-bridge BOM 化后正常启动
- ⚠️ 当时 `session.state=degraded`（远端锁屏 / 非 WinSta0），属**预期环境限制**，非部署故障

## 真机**未**验证（交接后优先补，详见 04）

1. `codebuddy` CLI 参数契约（`--goal/--system-prompt/--mcp/--output`）
2. `hermes` 真机 CLI 拉起 + MCP 自动加载
3. SSH 隧道端到端调一次工具闭环
4. 双连接器在宿主侧同时生效
5. 真机 A2A 委派 + 共享 Skills 下发
6. 真实 GUI 自动化点击回归

## Git 与远端

- 远端：**https://github.com/athronix/workbuddy-virtual-win-plugin**（**PRIVATE**，默认分支 `main`）
- 交接时 `main` = `acc966b`，本地与远端 `0 0` 无差异，共 **18 个提交**
- `.env` 已被 `.gitignore` 排除（第 15 行），**真实连接信息不入库**；模板为 `.env.example`
- ⚠️ 迁移到新机后 `.env` **不会**跟过去（未入库），需按 `.env.example` 重建

## 环境依赖（新机需具备）

| 依赖 | 要求 | 备注 |
|---|---|---|
| Node | ≥ 22（实测 v22 / v24 均可） | VM 侧远端实测 v24.18.0 |
| npm | workspace（12 包） | registry 已配 npmmirror |
| PowerShell | 5.1（VM 侧硬要求） | 宿主可为 pwsh7 |
| OpenSSH | 宿主 `ssh`/`scp`，VM 开 22 | 仅公钥认证，无密码字段 |
| Tailscale / 内网 | 宿主可达 VM | 旧机为 Tailscale 内网地址，见旧机 `.env` 的 `VM_HOST`（不入库） |
| `codebuddy` CLI | 仅 `workbuddy` provider 需要 | `npm i -g @tencent-ai/codebuddy-code` |
| `gh` CLI | 推送 GitHub 用 | 已登录账号 `athronix` |

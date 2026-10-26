# CL-015 交付报告 · 鸿蒙宿主「最后一公里」收口（T11–T16）

> 变更标识：`CL-015` ｜ 场景：宿主 = 本机鸿蒙（HMOS），VM = 本机 Windows（`ssh User@172.16.100.2`）
> 性质：不新增产品能力，只补「鸿蒙宿主装完即可用」链上的三处断点（**依赖 / 常驻 / shell**）+ 文档债
> 不变量：**VM 侧（Windows）零改动；Windows/macOS 宿主零行为变化；不改 MCP/A2A 契约**
> 守卫：`process.platform==='ohos' || WINVM_TUNNEL_BACKEND==='ssh2'`（所有新增副作用均包在此守卫内）

## TL;DR
宿主 = 鸿蒙场景下，安装后隧道「装完即用」链路已打通：ssh2 离线分发 → 安装尾零人工拉起常驻隧道 daemon（detached + pidfile 幂等，`--no-tunnel` 可跳过）→ 卸载自停 → POSIX 启动器/PATH 兼容 `/bin/sh`。T11–T16 全部落地，离线单测 4 文件全绿（共 42 用例）。

## 交付概览
| 维度 | 状态 |
|---|---|
| 实现 | T11–T16 ✅ 全部落地 |
| 离线单测 | 42/42 通过（ssh2-resolve 8、tunnel-daemon 10、launcher-posix 5、oh-tunnel 19） |
| 文档 | `oh-adaptation-plan.md` §7 翻 ✅；`DEPLOYMENT.md` T11 订正补落地 |
| 仓库卫生 | 清理 `vm-probe*.ps1` / `vm-probe-out.txt` 临时探测文件 |
| 已知问题 | 0（代码层）；真机复核项 3（见下） |

## 文件清单（新增 / 修改）
**新增**
- `delivery/ssh2-resolve.mjs` — ssh2 确定性解析链（注入 → 裸 `import('ssh2')` → `createRequire` 绝对兜底 → 三要素引导错误）
- `delivery/tunnel-daemon.mjs` — 常驻隧道守护（pidfile 原子写、状态机、SIGTERM/exit 清理、凭据仅经 env/`--key`）
- `tests/unit/ssh2-resolve.test.mjs`（8 用例）
- `tests/unit/tunnel-daemon.test.mjs`（10 用例，含凭据哨兵）
- `tests/unit/launcher-posix.test.mjs`（5 用例）

**修改**
- `delivery/oh-tunnel.mjs` — 内联 `import('ssh2')` 改经 `loadSsh2Client()`
- `delivery/winvm-plugin.mjs` — 新增 `tunnel start|status|stop` 命令 + 三态判定（RUNNING/DEGRADED/STOPPED，退出码 0/4/3）+ `cmdCheck` 主机段隧道行 + USAGE
- `delivery/install-host.mjs` — `copySsh2Runtime()` 离线分发；安装尾 detach 拉起 daemon；卸载 `tunnel stop --force`；`--no-tunnel` 参数
- `delivery/deploy-winvm-plugin.mjs` — `extraFiles=[]`（默认空，VM 侧零改动）；平台化 shebang + 纯 POSIX 启动器体
- `delivery/path-util.mjs` — profile 标记块 `.` 替代 `source`（POSIX 安全）
- `tests/unit/oh-tunnel.test.mjs` — 补「password+privateKey 不进 console/原始 stdout/stderr 流」强化哨兵
- `docs/oh-adaptation-plan.md` — §7 CL-015 表翻 ✅ + 收口小结
- `docs/05-peripherals/DEPLOYMENT.md` — T11 订正补「已落地」

## 三设计点（唯一结论）
1. **ssh2 落点**：扁平落地 `<pluginRoot>/node_modules/ssh2` 顶层，覆盖 `oh-tunnel.mjs` 与 `a2a-bridge/node_modules/@winvm/core/dist/*` 两条 ESM 向上查找路径；传递依赖 asn1/bcrypt-pbkdf/tweetnacl 同落；optional 原生依赖（cpu-features/nan）缺失即降级。
2. **常驻 daemon**：`install-host.mjs` 安装尾 `spawnSync(process.execPath, [wvPlugin,'tunnel','start'])`（detached+unref，父退出后存活）；`winvm-plugin tunnel start` 幂等（pidfile + 进程存活探测，不重复拉起）；`status` 人读/`--json`，退出码 0/4/3；卸载经 `tunnel stop --force` 自停。
3. **POSIX 启动器**：`#!/bin/sh` + `case "$0" in */*) d=${0%/*};; *) d=.;; esac` + `exec "${WINVM_NODE:-node}" "$d/winvm-plugin.mjs" "$@"`；profile 标记块用 `.` 替代 `source`，引 `$HOME` 兼容 `/bin/sh`。

## 验证结果
- `node --check` 全部改动 `.mjs` 通过。
- 离线逐文件 `node --test`（按项目硬约束不整批跑）：4 文件全绿，共 42 用例，含凭据哨兵（pidfile/日志绝不含量据明文）。

## 用户下一步建议
1. **真机构建复核**：联网机执行 `npm i && npm run build`，再逐文件复跑全部 `tests/unit/*.test.mjs`（离线沙箱无法复现含 `@winvm/*` 的 9 文件基线）。
2. **端到端真机验证**：VM 侧先 `install-vm.mjs`（P0-R0）+ 装 node，宿主侧 `node delivery/install-host.mjs --apply`，验证 A4/A5/A2。
3. **HMOS 沙箱限额**：`docs/oh-host-selfcheck.md` §5 三命令验证沙箱是否限出站 TCP/进程 spawn（FAIL 属 OS 权限，非改插件可绕）。
4. **运维命令**：装完 `winvm-plugin tunnel status` 看常驻隧道；必要时 `winvm-plugin tunnel start/stop`。

## 遗留 / 未决
- 真机端到端（A4/A5/A2）、`npm i && npm run build` 全量测试、HMOS 沙箱出站限额——均待用户在联网真机执行；离线沙箱 TS 仅静态审查。
- 仓库内无 `.dev/` 六索引实体、`06-OVERVIEW.md` 未追踪 CL-015 → 该分工项(T16)为空操作。

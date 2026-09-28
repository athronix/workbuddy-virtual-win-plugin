# CL-020 · F2 完善 + 隧道生产化（增量修正）

> 变更标识：`CL-020` ｜ 性质：**增量修正**（不改协议方法名 / 端点 / 字段名；修正既有采集路径覆盖缺陷 + 补齐宿主平台判定）
> 范围：2 项（A = F2 让 A2A 通道也刷新 `/health.netCfg.ageMs`；B = 生产化 `tunnel-daemon` 在鸿蒙 `openharmony` 上真正生效）

---

## 1. 变更概述

**一句话**：① 把 `system.network.config` 采集时间戳的捕获上移到 provider 的 `execute`（经注入的 `reportNetCfg` 回调），让 **A2A 通道** 也能刷新 `/health.cache.netCfg.ageMs`（CL-019 遗留 advisory）；② 补齐 `install-host.mjs` / `winvm-plugin.mjs` 的平台判断为 `ohos || openharmony` 双兼容，并把修复版 `tunnel-daemon.mjs`（成功路径不自杀、含 `keepAlive`、断线自愈）同步到插件缓存根，使常驻隧道在实机 HMOS（`openharmony`）真正生产化。

**两项来源**：

| 项 | 来源 | 性质 | 处置状态 |
|---|---|---|---|
| A（F2） | CL-019 交付后记入的 **advisory**：CL-019 项① 把采集时间戳捕获写在 `server.ts` 的 **MCP handler 层**，但 A2A 通道走 `provider.runGoal → provider.execute`，**不经过该 handler**，导致 A2A refresh 后 `/health.netCfg.ageMs` 不回落 | 采集路径覆盖缺陷（非回归；MCP 路径原已正确） | 本变更修正 |
| B（生产化） | CL-015（常驻隧道 daemon）/ CL-018（C5 缓存 + 隧道平台判定）时期，`install-host.mjs` 与 `winvm-plugin.mjs` 两处平台判断**漏改 `openharmony`**；且缓存根 `tunnel-daemon.mjs` 仍为「成功即 `process.exit(code)`」自杀版 | 平台判定漏改 + 运行态文件陈旧 | 本变更修正 |

---

## 2. 需求池

### A 项 · F2 让 A2A 通道也刷新 `/health.netCfg.ageMs`

**优先级**：**P0**（采集新鲜度在 A2A 委派路径失真，影响 `/health` 判据可靠性）。

**现状与根因**：
- CL-019 项① 把 `system.network.config` 的 `collectedAt` 捕获写进 `packages/vm-service/src/server.ts` 的 **MCP handler 闭包**（约 L325-345 的 `if (res.ok && cap.id === 'system.network.config')`）。
- 但 `/a2a` 通道的 `provider.runGoal` 内部直接调用 `provider.execute(req)`，**不经由 MCP handler**，因此 A2A 路径的 refresh 永远不会触发该捕获 → `/health.cache.netCfg.ageMs` 在 A2A 委派后不回落（仍为预热/上一次 MCP 调用的值）。
- 双写风险：若两处都写 `netCfgCache`，会出现两个写入数据源，语义易漂移。

**用户故事**：As a 通过 `/health` 判断网络配置缓存新鲜度的调用方（含 A2A 委派场景），I want 无论调用经 **MCP 还是 A2A** 通道，`ageMs` 都能随最近一次成功采集回落，so that 缓存新鲜度判据全通道一致。

**验收标准（可机器判定）**：
- **AC-A.1 单一数据源**：`server.ts` MCP handler 层**不再**含 `res.ok && cap.id === 'system.network.config'` 重复捕获分支（锁定禁双写）。
- **AC-A.2 注入点**：`server.ts` 的 `bridgeCtx` 注入 `reportNetCfg(collectedAt: string): void` 回调（cast 模式，不扩 `BridgeContext` 契约接口），写入 `netCfgCache`（单一数据源）。
- **AC-A.3 全通道覆盖**：`adapter-agent-workbuddy` 的 `execute` 在 `system.network.config` 成功返回前，经注入的 `reportNetCfg` 上抛 `collectedAt`；hermes / workbuddy-llm 的 execute 为 `this.executor.execute(req)` 委托 → 单 hook 覆盖 MCP + A2A + 两 LLM provider。
- **AC-A.4 零副作用**：`req.capabilityId` 非 `system.network.config` 时 `reportNetCfg` 不被调用。
- **AC-A.5 集成验证**：mock `BridgeContext` 直接调 `provider.execute({capabilityId:'system.network.config',...})` → `res.ok===true` 且 `reportNetCfg` 收到 `collectedAt`、写入 server 侧镜像。

### B 项 · 隧道生产化（鸿蒙 `openharmony` 真正生效）

**优先级**：**P0**（实机 HMOS 报 `openharmony`，漏改会导致真机隧道静默回落系统 ssh / 安装尾不自动拉起）。

**现状与根因**：
- 实机 HMOS（Node v24.13.0）`process.platform` 实报 **`openharmony`**，而非规格假设的 `ohos`（QA E-4 实证）。
- `delivery/install-host.mjs:876` 与 `delivery/winvm-plugin.mjs:223` 两处平台判断仅判 `process.platform === 'ohos'`，漏 `'openharmony'` → 鸿蒙实机隧道逻辑错误回落系统 ssh（或安装尾不自动拉起）。
- `delivery/setup.mjs:744` 与 `delivery/bootstrap.mjs:56` 已双兼容（范本）；缓存根 `~/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0/tunnel-daemon.mjs` 仍是「成功即 `process.exit(code)`」自杀版（进程在 ready 后立即退出，隧道随亡）。

**用户故事**：As a 鸿蒙 WorkBuddy 宿主，I want 安装后隧道在实机 `openharmony` 上**自动拉起且常驻存活**，so that VM 内服务可持续经进程内 ssh2 隧道访问，无需手工补救。

**验收标准（可机器判定）**：
- **AC-B.1 双兼容**：`install-host.mjs` 与 `winvm-plugin.mjs` 的平台判断均含 `=== 'ohos' || === 'openharmony'`（且保留 `WINVM_TUNNEL_BACKEND === 'ssh2'` 强制）。
- **AC-B.2 无裸 `ohos` 单判**：除双兼容行外，不得再出现单独的 `process.platform === 'ohos'`（作为隧道启用条件）。
- **AC-B.3 缓存根修复版**：缓存根 `tunnel-daemon.mjs` 不再含自杀文本 `runDaemon(...).then((code)=>process.exit(code))`，且含 `keepAlive`（常驻保活）。
- **AC-B.4 鸿蒙实测（可选不阻断）**：`node delivery/winvm-plugin.mjs tunnel status` 显示 `RUNNING`、`curl -s http://127.0.0.1:18443/health` 返回 200。

---

## 3. 裁定（已裁定决策）

- hook 命名 `reportNetCfg(collectedAt: string): void`。
- 注入采用 **cast 模式**（不扩 `BridgeContext` 接口）：server 侧把回调塞进 `bridgeCtx` 对象，provider 侧用 `as unknown as {...}` 强转读取（与既有 `healthSnapshot` / `sessionProbe` / `capabilityDefs` 注入约定一致）。
- **只在 `adapter-agent-workbuddy/src/index.ts` 的 `execute` 一处加 hook**（hermes / workbuddy-llm 的 execute 是 `this.executor.execute(req)` 委托，自动受益；`bridge.ts` 无独立 execute，不改）。
- B 项平台判断统一补 `openharmony`，与 `setup.mjs` / `bootstrap.mjs` 既范本一致；缓存根 daemon 用 `cp` 同步修复版（**不重跑 `install-host.mjs`、不杀/重启当前运行隧道 pid 4791**）。

---

## 4. 影响范围

| 文件 | 类型 | 影响 |
|---|---|---|
| `packages/vm-service/src/server.ts` | 源码（TS） | `bridgeCtx` 注入 `reportNetCfg`；删除 MCP handler 层重复捕获分支 |
| `packages/adapter-agent-workbuddy/src/index.ts` | 源码（TS） | `execute` 内新增 `reportNetCfg` 上抛 hook（cast 模式） |
| `tests/unit/cl019-health-ageMs.test.js` | 测试 | 反向守卫（禁双写）+ 正向守卫（注入/reportNetCfg/委托） |
| `tests/unit/cl020-f2-a2a-netcfg-capture.test.js` | 测试（新增） | 静态守卫 + A2A 集成断言 |
| `delivery/install-host.mjs` | 交付脚本（mjs） | T12 平台判断补 `openharmony` |
| `delivery/winvm-plugin.mjs` | 交付脚本（mjs） | `withTunnel` 平台判断补 `openharmony` |
| `~/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0/tunnel-daemon.mjs` | 运行态缓存（mjs） | 同步修复版（无自杀 bug + keepAlive） |
| `docs/INSTALL-GUIDE.md` | 文档 | §7.1 隧道生产化小节 |
| `docs/changes/CL-020/REQUIREMENT.md` | 文档（新增） | 本文件 |
| `docs/changes/CL-020/TECHNICAL-SOLUTION.md` | 文档（新增） | 技术方案与验证 |

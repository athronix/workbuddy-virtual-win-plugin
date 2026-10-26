# CL-020 · 技术方案（TECHNICAL-SOLUTION）

> 对应 `REQUIREMENT.md`。含 A 项的 `reportNetCfg` 注入机制与数据流对照、B 项的双兼容修正清单与缓存根同步、以及验证方法。

---

## A 项 · F2 采集时间戳全通道覆盖（hook 注入机制）

### A.1 设计原则

CL-019 项① 把 `collectedAt` 捕获写死在 `server.ts` 的 **MCP handler 闭包**，但 A2A 通道的 `provider.runGoal` 直接调 `provider.execute(req)`，**不经过 MCP handler** → A2A refresh 后 `/health.cache.netCfg.ageMs` 不回落。

修复思路：**把捕获上移到 provider 的 `execute` 内部**，经一个 server 侧注入的回调上抛。这样：

- **单一数据源**：`netCfgCache` 只由 `reportNetCfg` 回调（运行态成功采集）与预热直连调用两处写入 —— 二者语义不同（预热走 `runtime.bridge.call('system','Get-NetworkConfig')` 直接调用，不经 `provider.execute`，故保留），MCP handler 不再写。
- **全通道覆盖**：MCP 与 A2A 两条通道**共用同一个 `provider.execute`**；hermes / workbuddy-llm 的 execute 仅是 `this.executor.execute(req)` 委托（其内部 `this.executor` 即 `DeterministicAgentProvider`），因此**单 hook 覆盖全部 4 个入口**。
- **契约零改动**：采用既有「cast 模式」注入（与 `healthSnapshot` / `sessionProbe` / `capabilityDefs` 同约定）—— 不扩 `BridgeContext` 接口，provider 侧用 `as unknown as {...}` 强转读取。

### A.2 注入点确认（与 `loader.ts` 对齐）

`packages/core/src/bridge/loader.ts:73/106`：

```ts
export async function loadProvider(cfg, ctx: BridgeContext): Promise<AgentServiceProvider> {
  ...
  const provider = await factory(entry.options);
  await provider.init(ctx);   // ← ctx 即 server 侧构造的 bridgeCtx 对象
  return provider;
}
```

- server 侧 `createService` 中 `bridgeCtx` 是普通对象字面量，经 `as unknown as BridgeContext` 注入 provider；本变更在其中新增 `reportNetCfg` 字段（闭包捕获同作用域的 `netCfgCache`）。
- provider 的 `init(ctx)` 把 `ctx` 存为 `this.ctx`（`adapter-agent-workbuddy/src/index.ts:201`）；`execute` 内通过 `this.ctx` 读取注入回调。
- `netCfgCache` 在 `bridgeCtx` 字面量**之后**声明（`server.ts:208` 区域），但 `reportNetCfg` 是**箭头函数闭包**，仅在实际调用时访问 `netCfgCache`（调用发生在服务启动且经 execute 之后，TDZ 已过），故无运行期 / 编译期问题（已通过 `tsc -b` 验证）。

### A.3 代码变更

**① `packages/vm-service/src/server.ts` —— `bridgeCtx` 注入 `reportNetCfg`（紧邻 `healthSnapshot` 之后）：**

```ts
// CL-020 F2：system.network.config 采集时间戳经此回调上抛写入 netCfgCache（单一数据源）。
// provider.execute 内部成功采集后调用；MCP 与 A2A 两条路径共用同一 execute → 全覆盖。
reportNetCfg: (collectedAt: string): void => {
  netCfgCache.collectedAt = collectedAt;
  netCfgCache.ok = true;
},
```

**② `packages/vm-service/src/server.ts` —— 删除 MCP handler 层重复捕获整段：**

删除原 `if (res.ok && cap.id === 'system.network.config') { const collectedAt = ...; netCfgCache.collectedAt = collectedAt; netCfgCache.ok = true; }` 分支（避免双写）。预热处对 `netCfgCache.collectedAt` 的直接写入**保留**（其走 `runtime.bridge.call` 直连，不经 provider.execute）。

**③ `packages/adapter-agent-workbuddy/src/index.ts` —— `execute` 成功返回前插入 hook：**

```ts
// CL-020 F2：采集时间戳经注入的 reportNetCfg 上抛（覆盖 MCP + A2A 两条路径）。
if (req.capabilityId === 'system.network.config') {
  const ca = (data as { collectedAt?: unknown } | undefined)?.collectedAt;
  if (typeof ca === 'string') {
    (this.ctx as unknown as { reportNetCfg?: (collectedAt: string) => void } | undefined)
      ?.reportNetCfg?.(ca);
  }
}
```

> `data` 此处为 `system.network.config` 顶层 `obj`（`normalizeListOutput` 对该非列表能力原样返回），`data.collectedAt` 直接可取（PS 侧 `ConvertTo-Json` 保持 camelCase `collectedAt`）。

### A.4 数据流对照

```
                     ┌─────────────── provider.execute(req) ───────────────┐
                     │   bridge.call('system','Get-NetworkConfig')          │
                     │        → data = { ..., collectedAt: <ISO> }          │
                     │   if req.capabilityId === 'system.network.config':   │
[server bridgeCtx]   │     (this.ctx as ...).reportNetCfg(data.collectedAt) │
  reportNetCfg ──────┴──────────────────►  netCfgCache.collectedAt = <ISO>  │
       │                                                          netCfgCache.ok = true
       │ (闭包写入)                                                       │
       ▼                                                                │
  netCfgCache  ─────────────────────────────────────────────────────────┘
       │
       ▼  buildHealth() 读 netCfgCache.collectedAt
  /health.cache.netCfg = { cached, ageMs = now - Date.parse(collectedAt), ttlMs }

调用入口（全部汇入 execute）：
  MCP  → mcp handler → provider.execute(req)                  ✓ 经 hook
  A2A  → a2a handler → provider.runGoal → provider.execute(req) ✓ 经 hook
  hermes / workbuddy-llm → this.executor.execute(req)         ✓ 经 hook（executor 即上述 provider）
```

---

## B 项 · 隧道生产化（鸿蒙 `openharmony` 双兼容 + 缓存根修复版）

### B.1 双兼容修正清单

实机 HMOS（Node v24.13.0）`process.platform` 实报 **`openharmony`**。两处隧道启用判定补 `openharmony`（与 `delivery/setup.mjs:744`、`delivery/bootstrap.mjs:56` 既范本一致）：

| 文件:行 | 修正前 | 修正后 |
|---|---|---|
| `delivery/install-host.mjs:876`（T12 安装尾拉起） | `process.platform === 'ohos' \|\| process.env['WINVM_TUNNEL_BACKEND'] === 'ssh2'` | `process.platform === 'ohos' \|\| process.platform === 'openharmony' \|\| process.env['WINVM_TUNNEL_BACKEND'] === 'ssh2'` |
| `delivery/winvm-plugin.mjs:223`（`withTunnel` 临时隧道） | `process.platform === 'ohos' \|\| process.env['WINVM_TUNNEL_BACKEND'] === 'ssh2'` | `process.platform === 'ohos' \|\| process.platform === 'openharmony' \|\| process.env['WINVM_TUNNEL_BACKEND'] === 'ssh2'` |

> **平台判定硬纪律**：此后任何「宿主平台判断是否走 ssh2 隧道」的分支都必须写 `=== 'ohos' || === 'openharmony'` 双兼容，不得只判 `ohos`。

### B.2 缓存根 daemon 同步（运行态动作，非源码编辑）

把修复版 `delivery/tunnel-daemon.mjs`（含 `keepAlive`、成功路径不 `process.exit`、断线自愈、状态机 `RUNNING/DEGRADED`）同步到插件缓存根：

```bash
cp delivery/tunnel-daemon.mjs \
   ~/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0/tunnel-daemon.mjs
```

- **不重跑 `install-host.mjs`**（避免对当前已部署状态产生副作用）。
- **不杀/重启当前运行中的隧道进程**（pid 4791 从 delivery 路径手拉，`cp` 改文件不影响运行中进程）。
- 同步后校验：缓存根那份**不应**再含自杀 bug 文本 `runDaemon(...).then((code)=>process.exit(code))`；**应**含 `keepAlive`。

### B.3 隧道生命周期（生产化后）

- **安装尾自动拉起**：`install-host.mjs` T12（OH / ssh2 后端且非 `--no-tunnel`）以 `spawn(process.execPath, [winvm-plugin, 'tunnel', 'start'], { stdio:'inherit' })` 零人工动作拉起。
- **管理命令**（宿主侧）：`node delivery/winvm-plugin.mjs tunnel start|status|stop`。
- **进程内 ssh2 隧道**：`delivery/tunnel-daemon.mjs` 以 `detached + unref` 拉起，父退出存活；`OhSshTunnel` 监听 `127.0.0.1` 仅回环、断线自愈、状态机 `STARTING→RUNNING/DEGRADED→STOPPING`，心跳写 `tunnel.state.json`。
- **HOURLY watchdog 自动化兜底**：自动化 `aaa87da4`（每小时）探测 `tunnel.status`，进程死亡时自动 `tunnel start` 重启。

---

## 验证方法

### 1. 构建（TS 改动必须经 build 验证）

```bash
/data/storage/el1/bundle/libs/arm64/node/bin/node node_modules/.bin/tsc -b tsconfig.build.json
# 或 npm run build —— 期望 EXIT=0，无类型错误
```

### 2. 逐文件单测（禁整批）

```bash
NODE=/data/storage/el1/bundle/libs/arm64/node/bin/node
$NODE --test tests/unit/cl020-f2-a2a-netcfg-capture.test.js   # 新建：静态守卫 + A2A 集成
$NODE --test tests/unit/cl019-health-ageMs.test.js            # 修正后应通过（反向守卫 + 正向守卫）
$NODE --test tests/unit/cl018-psmod-c456.test.js              # 回归
```

### 3. B-T1 文本校验（grep）

```bash
grep -n "openharmony" delivery/install-host.mjs delivery/winvm-plugin.mjs   # 两处均应命中
# 除双兼容行外，不得再出现单独的 process.platform === 'ohos' 作为隧道启用条件
```

### 4. B-T2 缓存根校验

```bash
grep -n "runDaemon(process.argv.slice(2)).then((code) => process.exit(code))" \
  ~/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0/tunnel-daemon.mjs   # 应无命中（自杀 bug 已消除）
grep -n "keepAlive" \
  ~/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0/tunnel-daemon.mjs   # 应命中
```

### 5. 鸿蒙实测（可选，不阻断）

```bash
node delivery/winvm-plugin.mjs tunnel status   # 应显示 RUNNING
curl -s http://127.0.0.1:18443/health          # 应 200（当前 pid 4791 在跑）
```

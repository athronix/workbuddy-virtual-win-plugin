# CL-019 · 技术方案（两项 P3 契约修正）

> 对应需求：`docs/changes/CL-019/REQUIREMENT.md`
> 性质：**增量修正**（零破坏——不改字段名 / 方法名 / 端点）
> 作者：高见远（Architect）｜ 实现：寇豆码（Engineer）

---

## 0. 结论摘要

| 项 | 修正 | 改前 | 改后 | 落点 |
|---|---|---|---|---|
| ① `ageMs` 语义 | 真实缓存新鲜度 | `now - warmedAtMs`（≈ 进程 uptime） | `now - Date.parse(collectedAt)`（无采集 → -1） | `packages/vm-service/src/server.ts` |
| ② `routes[]` 字段名 | 统一为 `routeMetric` | `{destination, nextHop, metric}` | `{destination, nextHop, routeMetric}` | `packages/vm-capabilities/psmod/system.ps1` |

**核心取舍（项①）**：采「修正语义」而非「新增字段名」。理由：`bridge.ts:105` **既有契约**已把 `ageMs` 定义为「缓存年龄（毫秒；无缓存为 -1）」，当前实现是**违反契约**；修正语义即**对齐契约**、零破坏（非契约变更）。新增字段会扩契约面，超 P3 修正范围。

**捕获时机（项①）**：**预热 + 每次正常 `system.network.config` 调用成功**（**MCP 通道 handler**，见 §5 F2）均写入 `collectedAt`。理由：仅预热写入时，用户 `refresh:true` 后 `ageMs` 不会回落（仍指向前次预热时刻）；捕获每次成功调用即可保证 refresh 后**立刻回落**，语义为「真实新鲜度」。

---

## 1. 事项①：`/health.cache.netCfg.ageMs` 语义修正

### 1.1 数据流（改后）

```
                         ┌────────────────────────────────────────────┐
 启动预热 (fire-and-forget)│ runtime.bridge.call('system','Get-NetworkConfig')  │
                         └───────────────────┬────────────────────────┘
                                             │ 返回 { adapters, routes?, cached, cacheAgeMs, collectedAt }
                                             ▼
                              netCfgCache.collectedAt = res.collectedAt
                              netCfgCache.ok          = true

 正常 system.network.config        ┌────────────────────────────────────┐
 (仅 MCP capability handler)  ────▶│ provider.execute(...) → res.data    │
                                   └───────────────────┬────────────────┘
                                                       │ res.data.collectedAt (PS 原样回传)
                                                       ▼
                              if (res.ok && cap.id === 'system.network.config')
                                  netCfgCache.collectedAt = res.data.collectedAt
                                  netCfgCache.ok          = true

 GET /health  ──▶ cache.netCfg = { cached: ok,
                                    ageMs: Number.isFinite(Date.parse(collectedAt))
                                             ? max(0, now - Date.parse(collectedAt))
                                             : ok ? 0 : -1,
                                    ttlMs }
```

> **捕获点归属（F2 更正）**：正常调用的捕获点位于 **MCP capability handler**（`server.ts` 的 `mcpTools[].handler`）。
> **A2A 通道不经过该 handler** —— A2A 走 `provider.runGoal()`，其内部直接调用 `provider.execute()`，
> 不触发 `/health` 的 `netCfgCache` 更新。故**纯 A2A 刷新不会更新 `/health.netCfg`**（仅 /health 观测口径受影响；
> ps-bridge 侧进程内 TTL 缓存本身仍正常刷新，`system.network.config` 的 `routes/gateway` 数据仍正确）。详见 §5。

### 1.2 字段对照

| 位置 | 字段 | 改前语义 | 改后语义 |
|---|---|---|---|
| `bridge.ts` `CacheHealth.netCfg.ageMs` | `ageMs` | 契约：缓存年龄（无缓存 -1） | **不变**（仅澄清注释：自 `collectedAt` 起算的真实新鲜度） |
| `server.ts` `netCfgCache` 本地态 | `warmedAtMs` | 参与 `ageMs` 计算 | **保留但不参与 `ageMs`**（仍记录预热时刻，供日志/未来用） |
| `server.ts` `netCfgCache` 本地态 | `collectedAt?` | 不存在 | **新增**（PS 回传采集时间戳） |
| `/health` 输出 | `cache.netCfg.ageMs` | `now - warmedAtMs`（≈ uptime） | `now - Date.parse(collectedAt)`（**F1：`Number.isFinite` 兜底**）；无采集或非法 `collectedAt` → `ok ? 0 : -1` |

### 1.3 实现要点（`packages/vm-service/src/server.ts`）

1. **本地态类型扩展**（原 `:204`）：
   ```ts
   const netCfgCache: { warmedAtMs: number; ok: boolean; error?: string; collectedAt?: string } = {
     warmedAtMs: 0,
     ok: false,
   };
   ```
2. **预热捕获**（原 `:213`）：捕获返回值 `collectedAt`：
   ```ts
   const prewarmRes = await runtime.bridge.call('system', 'Get-NetworkConfig', {}, prewarmTimeoutMs);
   netCfgCache.warmedAtMs = Date.now();
   netCfgCache.ok = true;
   const prewarmCollectedAt = (prewarmRes as { collectedAt?: unknown } | undefined)?.collectedAt;
   if (typeof prewarmCollectedAt === 'string') netCfgCache.collectedAt = prewarmCollectedAt;
   ```
3. **正常调用捕获**（**MCP capability handler** 内，`provider.execute` 之后）：放在「`res` 已获得且 `res.ok`」处——此处**未走审批拦截**（拦截分支更早 `return`），且涵盖**审批续跑成功路径**：
   ```ts
   if (res.ok && cap.id === 'system.network.config') {
     const collectedAt = (res.data as { collectedAt?: unknown } | undefined)?.collectedAt;
     if (typeof collectedAt === 'string') {
       netCfgCache.collectedAt = collectedAt;
       netCfgCache.ok = true;
     }
   }
   ```
   > ⚠ **仅 MCP 通道**：A2A 走 `provider.runGoal()`（内部直接 `provider.execute()`），**不经过**该 handler，
   > 故纯 A2A 刷新不更新 `/health.netCfg`（F2）。
4. **`/health` 聚合**（原 `:596`；F1 硬化后）：
   ```ts
   const parsedAt = netCfgCache.collectedAt ? Date.parse(netCfgCache.collectedAt) : Number.NaN;
   // …cache.netCfg.ageMs:
   ageMs: Number.isFinite(parsedAt)
     ? Math.max(0, Date.now() - parsedAt)
     : netCfgCache.ok
       ? 0
       : -1,
   ```

### 1.4 字段名大小写说明（重要）

`runtime.bridge.call` 返回的 PS 对象经 `ps-bridge.ps1` 的 `Write-ProtocolLine`（`ConvertTo-Json -Depth 30 -Compress`）序列化。PowerShell **原样**序列化 ordered hashtable 的键名 → 键为 camelCase `collectedAt`（**未**做 PascalCase 转换）。已在代码注释中记录；若未来 PS 侧改为 `CollectedAt`，需同步改用对应键。

---

## 2. 事项②：`routes[].metric` → `routeMetric`

### 2.1 字段对照

| 投影 | 改前 | 改后 | 取值来源 |
|---|---|---|---|
| `adapters[].gateway[]` | `{nextHop, routeMetric}` | 不变 | `$_.RouteMetric` |
| `routes[]` | `{destination, nextHop, **metric**}` | `{destination, nextHop, **routeMetric**}` | `$_.RouteMetric`（同源） |

### 2.2 实现要点

- `packages/vm-capabilities/psmod/system.ps1`：`routes[]` 投影 `metric = $_.RouteMetric` → `routeMetric = $_.RouteMetric`（+ CL-019 注释）。
- `packages/vm-capabilities/src/registry/definitions.ts`：`system.network.config` 出参 `routes` 补全内层 shape 文档（**仅文档**，不改运行时行为）：
  - `routes` 描述注明内层为 `{ destination, nextHop, routeMetric }`。

### 2.3 部署纪律

`psmod/*.ps1` 改动**必须重启服务**（ps-bridge 启动时 dot-source 全部模块、不可热更）。

---

## 3. 验证方法

### 3.1 构建

```bash
npm run build           # tsc -b tsconfig.build.json，须无类型错误
```

### 3.2 单测（逐文件跑，勿整批）

```bash
node --test tests/unit/cl019-routes-routeMetric.test.js
node --test tests/unit/cl019-health-ageMs.test.js
```

- `cl019-routes-routeMetric.test.js`：断言 `system.ps1` 的 `routes[]` 投影含 `routeMetric` 且不含 `metric =`；`definitions.ts` 的 `routes` 描述含内层 shape。用静态样例对象断言字段名同源一致。
- `cl019-health-ageMs.test.js`：断言 `server.ts` 的 `ageMs` 由 `collectedAt` 计算（非 `warmedAtMs`）；以样例（模拟）验证 `ageMs` 反映真实缓存龄、refresh 后回落。

### 3.3 真机观测 `ageMs` 随 refresh 回落（可选，需 VM）

1. 服务启动后读 `GET /health` → 记 `cache.netCfg.ageMs`（≈ 距最近采集时长）。
2. 等待若干秒（`ageMs` 增大）。
3. 以 `includeRoutes:false` 调用 `system.network.config`（或 `refresh:true` 强制重采）。
4. 再读 `GET /health` → `ageMs` **回落**至接近 0。
5. 对照：改前 `ageMs` 只随进程 uptime 单调增、refresh 不回。

---

## 4. 影响面与兼容性

- **契约**：`bridge.ts` 字段名**不变**（仅注释澄清）；`definitions.ts` 输出描述**仅补全**。→ 零破坏。
- **运行时**：`routes[]` 字段名变更（`metric` → `routeMetric`）；`ageMs` 语义修正。→ 无已知消费者依赖旧 `metric`。
- **文档**：CL-018 `TECHNICAL-SOLUTION.md` §458/§701/§702 追加「P3 已于 CL-019 解决」交叉引用；`skills/winvm-mcp-reference/SKILL.md` 澄清 `ageMs` 语义。

---

## 5. 遗留 / 已知限制

- **F2（QA advisory，文档更正）· 纯 A2A 刷新不更新 `/health.netCfg`**：
  - **事实**：`/health.cache.netCfg` 的 `collectedAt` 捕获点位于 **MCP capability handler**（`server.ts` `mcpTools[].handler` 内、`provider.execute` 之后）。**A2A 通道不经过该 handler** —— A2A 请求走 `provider.runGoal()`，其内部直接调用 `provider.execute()`，**不会**写回 `netCfgCache`。
  - **影响面**：**仅 `/health.cache.netCfg.ageMs`（及 `cached`）在「纯 A2A 通道刷新」下不随之更新**（会停留在 MCP 侧最近一次采集 / 预热时刻）。**ps-bridge 侧进程内 TTL 缓存本身不受影响** —— 无论 MCP 还是 A2A，`system.network.config` 返回值（`adapters`/`routes`/`gateway` 数据、`cached`、`cacheAgeMs`、`collectedAt`）均正确。
  - **定位**：纯观测口径问题，**非数据正确性缺陷**。修正需在 A2A/`provider.runGoal` 路径补捕获点，**超出本次 P3 修正范围**，记 backlog。
- **F1（已硬化，非遗留）**：`ageMs` 已加 `Number.isFinite` 兜底，`collectedAt` 非法/缺失时恒为有限 number，杜绝 `NaN → null` 违反 `bridge.ts` 契约。现实不可达（PS 恒回合法 ISO），属防御性硬化。

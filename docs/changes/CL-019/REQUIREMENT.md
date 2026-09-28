# CL-019 · 两项 P3 契约修正（增量 PRD）

> 变更标识：`CL-019` ｜ 性质：**增量修正**（不改协议方法名 / 端点 / 字段名；修正既有字段语义与同义字段命名）
> 来源：CL-018 `TECHNICAL-SOLUTION.md` §10.6.5（§701 / §702）两条 P3 backlog 项
> 范围：2 项（项① `/health.cache.netCfg.ageMs` 语义；项② `routes[].metric` 字段名统一）

---

## 1. 变更概述

**一句话**：把 CL-018 复核阶段记入 backlog 的 2 项 P3「同义/歧义」缺陷转成可机器验收的增量修正——项①修正 `/health.cache.netCfg.ageMs` 为**真实缓存新鲜度**，项②统一 `system.network.config` 的 `routes[]` 路由度量字段名为 `routeMetric`。

**背景**：CL-018 交付后复核发现两处**契约一致性问题**（均判**非回归**、纯语义/命名层）：

| 项 | 现象 | 契约依据 | 处置状态 |
|---|---|---|---|
| ① | `/health.cache.netCfg.ageMs` 实现用 `Date.now() - netCfgCache.warmedAtMs`，量的是「距启动预热时长 ≈ 进程 uptime」，**非真实缓存新鲜度** | `packages/contracts/src/bridge.ts:105` 定义 `ageMs = "缓存年龄（毫秒；无缓存为 -1）"` | 本变更修正 |
| ② | `system.ps1` 的 `routes[]` 投影用 `metric = $_.RouteMetric`，而 `adapters[].gateway[]` 用 `routeMetric = $_.RouteMetric`（**同源不同名**） | CL-017/CL-018 §6 场景 **S15** 写明 `routes` 投影 `[{nextHop, routeMetric}]` | 本变更统一 |

**与 CL-018 的关系**：CL-018（`docs/changes/CL-018/`）为「遗留建议逐项完善」，其 §10.6.5 明确将上述两项列为 **P3、非阻塞、本轮不改**，并记入 backlog。本变更**只做增量修正**：不改协议方法名 / 端点 / 既有字段名，旧调用方行为不变。

---

## 2. 需求池

> 每项含 `ID / 名称 / 优先级 / 用户故事 / 验收标准（可机器判定）/ 依赖与风险`

### 项① · `/health.cache.netCfg.ageMs` 语义修正为真实缓存新鲜度

**优先级**：**P3**（契约一致性修正；零破坏——字段名不变，仅语义对齐既有契约）。

**现状与根因**：
- 契约：`packages/contracts/src/bridge.ts:105` 定义 `ageMs = "缓存年龄（毫秒；无缓存为 -1）"`。
- 实现（修正前）：`packages/vm-service/src/server.ts` 用 `Date.now() - netCfgCache.warmedAtMs`，`warmedAtMs` 只在 **启动预热**时写入一次 → `ageMs` 实为「距启动预热时长 ≈ 进程 uptime」，与「缓存年龄」语义背离。CL-018 复核实测 `/health` 报 `{cached:false, ageMs:-1}` 而同一时刻实时缓存已命中（`cached=true, cacheAgeMs≈2000`），二者可背离。
- 数据源：PS 侧 `packages/vm-capabilities/psmod/system.ps1` **已回传** `collectedAt`（ISO8601 UTC）——冷采集路径与缓存命中路径均写入；VM 内 `Get-NetworkConfig` 出参契约（capability id = `system.network.config`）已声明 `collectedAt`。但 vm-service **从未捕获**它（预热调用丢弃返回值、正常调用只回传客户端）。

**用户故事**：As a 通过 `/health` 判断网络配置缓存是否陈旧的调用方，I want `ageMs` 反映**自最近一次采集起算的真实缓存新鲜度**，so that 我能据此判断缓存是否需要 refresh，而非被「进程 uptime」误导。

**验收标准（可机器判定）**：
- **AC1.1 语义对齐契约**：`ageMs` = `now - Date.parse(collectedAt)`（有成功采集时）；字段名**不变**（`bridge.ts` 契约零改动）。
- **AC1.2 无采集口径**：无成功采集（`ok=false`）时 `ageMs = -1`（契约约定）。
- **AC1.3 回落语义**：用户以 `refresh:true` 调用 `system.network.config` 成功后，`ageMs` **立刻回落**（因 `collectedAt` 被刷新为当前时刻）。
- **AC1.4 捕获时机**：**预热**（启动异步预热一次）+ **每次正常 `system.network.config` 调用成功**均写入 `collectedAt`。
- **AC1.5 非 uptime**：`ageMs` 不得等于「距服务/预热启动时长」；静态断言实现不再使用 `warmedAtMs` 参与 `ageMs` 计算。
- **AC1.6 有限性兜底（F1 硬化 · QA advisory）**：`collectedAt` **非空但非法**（`Date.parse → NaN`）时，`ageMs` **必须仍为有限 number**（回落 `ok ? 0 : -1`），**不得**为 `NaN`（JSON 会序列化成 `null`，违反 `bridge.ts` 的 `ageMs: number` 契约）。现实不可达（PS 恒回合法 ISO），属**防御性硬化**。验收：单测覆盖「非法 `collectedAt` → 有限 number」。

**依赖与风险**：
- **依赖**：`system.network.config` 出参 `collectedAt`（CL-018 C5 已交付，PS 侧已回传）。
- **风险**：无破坏性风险（字段名不变）。仅需注意字段名大小写（PS `ConvertTo-Json` 原样序列化 ordered hashtable → `collectedAt` camelCase）。

### 项② · `routes[].metric` 字段名统一为 `routeMetric`

**优先级**：**P3**（命名一致性修正；非回归）。

**现状与根因**：`packages/vm-capabilities/psmod/system.ps1` 的 `routes[]`（`includeRoutes` 时的附加载荷）投影为 `{destination, nextHop, metric}`，而 `adapters[].gateway[]` 投影为 `{nextHop, routeMetric}`——**同源（`$_.RouteMetric`）不同名**。CL-017 §2 D12 / CL-018 §6 S15 均写明 `routes` 投影应为 `[{nextHop, routeMetric}]`，故 `metric` 违反既有契约。

**用户故事**：As a 消费 `system.network.config` 的调用方，I want `gateway[]` 与 `routes[]` 的路由度量字段**同名**（`routeMetric`），so that 我可用同一字段名解析两类投影，无需针对 `routes[]` 特判。

**验收标准（可机器判定）**：
- **AC2.1 统一命名**：`routes[]` 每项含 `routeMetric` 字段，取值为 `$_.RouteMetric`。
- **AC2.2 同源一致**：`routes[].routeMetric` 与 `adapters[].gateway[].routeMetric` 同源同名。
- **AC2.3 契约补全**：`definitions.ts` 的 `system.network.config` 出参 `routes` 补全内层 shape 文档（`{destination, nextHop, routeMetric}`）。
- **AC2.4 不改运行时行为**：仅改字段名与文档，不改投影去重语义、不改 `dnsServers` 去重、不新增/删除路由条目。

**依赖与风险**：
- **风险**：若有调用方已依赖 `routes[].metric`——据 CL-018 复核，`routes[]` 属附加载荷、无已知消费者依赖 `metric`；字段名对齐契约属**修正**。
- **部署纪律**：`psmod/*.ps1` 改动须**重启服务**（ps-bridge 不可热更）。

---

## 3. 非功能要求

- **兼容性**：**不改协议方法名 / 端点 / 字段名**；`ageMs` 仅修正语义，`routes[]` 仅重命名同义字段。旧调用方行为不变。
- **测试纪律**：单测**逐文件** `node --test <file>`，**绝不整批跑**（junction symlink 会打崩共享 runner）。
- **构建纪律**：改动后 `npm run build`（`tsc -b`）必须无类型错误。

---

## 4. 明确不纳入本轮

| 事项 | 说明 | 不纳入理由 |
|---|---|---|
| 为 `system.network.config` 增加「实时候选缓存状态」独立字段 | CL-018 §701 曾建议「增/改字段名以区分预热态与实时态」 | 属**新增字段**（超 P3 修正范围）；本变更采「修正 `ageMs` 语义」这一零破坏路径 |
| 其它 psmod 领域码 / 字段命名治理 | —— | 本变更**不扩围**；若后续要修须**另开变更** |

---

## 5. 验收场景清单

| # | 对应 | 场景 | 步骤 | 期望（可判定） |
|---|---|---|---|---|
| S1 | 项① AC1.1–1.4 | `ageMs` 真实新鲜度 | 服务启动（预热成功）后读 `/health.cache.netCfg` | `ageMs ≈ now - Date.parse(collectedAt)`（非 uptime）；`cached=true` |
| S2 | 项① AC1.3 | refresh 后回落 | 等待若干秒使 `ageMs` 增大 → 以 `refresh:true` 调用 → 再读 `/health` | `ageMs` **回落**至接近 0 |
| S3 | 项① AC1.2 | 无采集口径 | 预热失败且未成功调用 | `cached=false`、`ageMs=-1` |
| S4 | 项② AC2.1/2.2 | 字段统一 | 调用 `system.network.config`（`includeRoutes:true`） | `routes[]` 每项含 `routeMetric`；与 `gateway[].routeMetric` 同源同名 |
| S5 | 项② AC2.3 | 契约补全 | 读取 `definitions.ts` | `routes` 出参描述含内层 `{destination, nextHop, routeMetric}` |

> **通用纪律（沿用 CL-017/CL-018）**：声明"已修"须附**可机器判定证据**（单测 / 静态扫描）；单测逐文件跑。

---

## 6. 修订记录（QA 独立验证后收尾）

| # | 类型 | 内容 | 依据 |
|---|---|---|---|
| F1 | **硬化（改码）** | `ageMs` 加有限性兜底（`Number.isFinite`）：`collectedAt` 非法/缺失时回落 `ok ? 0 : -1`，杜绝 `NaN → null` 违反 `bridge.ts` 契约。对应 **AC1.6**。 | QA 严过关 advisory |
| F2 | **文档更正（不改运行时）** | 更正设计文档对被捕获通道的描述：捕获点在 **MCP capability handler**；**A2A 走 `provider.runGoal`，不经该 handler** → 纯 A2A 刷新不更新 `/health.netCfg`（仅观测口径；PS 侧 TTL 缓存与 `routes/gateway` 数据不受影响）。详见 `TECHNICAL-SOLUTION.md` §5。 | QA 严过关 advisory |

# P2-T11 设计定稿（工程师 Alex）

依据：`docs/archive/changes/phase2-arch-design.md` §308（P2-T11 行）+ §267（A-4 段）+ §251-262（§4.4 F-1 四条设计要求）+ §365（PR9）+ §13 Q7/Q8 裁决 + §13.2-②（policy 全键集白名单 ⇒ gate 候选判据）+ §3.4（E-3 锁屏前置探针）。

---

## 1. 分层图（dep-lint 判据 A 的事实源）

设计 §254 原文 = ARCHITECTURE.md §2.1 依赖铁律。rank 数值化（**低 rank 不得被高 rank… 反过来：高 rank 包 import 低 rank 包合法；低 rank import 高 rank 违规**）：

| rank | 层 | 包 |
|---|---|---|
| 0 | L0 规范层 | `contracts` |
| 10 | L1a 核心模块 | `core` |
| 20 | L1b 协议框架 | `mcp-framework`、`a2a-framework` |
| 30 | L1c 宿主 SDK | `host-sdk` |
| 40 | L2 适配/能力层 | `vm-capabilities`、`adapter-agent-workbuddy`、`adapter-agent-hermes`、`adapter-host-workbuddy` |
| 45 | L2 编排（同层可依赖 L2 被依赖项） | `adapter-agent-workbuddy-llm`、`vm-service` |
| 50 | L3 宿主桥 | `host-a2a-bridge` |

> rank 相等不判违规（同层互依属允许：`adapter-agent-workbuddy-llm` → `adapter-agent-workbuddy` 实测存在且 package.json 已声明）。
> 设计 §254 的 `contracts←core←frameworks←vm-capabilities/adapters←vm-service` 与实况差：`vm-service` 与 `host-a2a-bridge` 分层在 ARCHITECTURE.md 表中 `vm-service`=L2、`host-a2a-bridge`=L2（包清单）但 package.json `layer` 字段记 `L3-host-bridge`。**取 package.json `layer` 字段为准**（机检事实源单一），rank 50。

## 2. 审计边表（判据 C 事实源，**不硬编码符号清单**）

设计 §258「`a2a-framework`/`mcp-framework` import `vm-service`/审计语义 ⇒ 红」+「框架层永不 import 审计语义」。硬编码符号名会在 `core` 新增 `audit/*` 导出时静默失效（正是 Phase 2 命题反对的第四种状态）。⇒ **派生式**：

- 读 `packages/core/dist/index.js` 中**源路径含 `audit`** 的具名再导出语句（`export { … } from './audit/chain.js'`）⇒ 当前实测 = `HashChainAuditSink, canonicalJson, sha256, computeRecordHash, redact, ARCHIVE_VERIFY_MAX_SHARDS`。
- 读 `packages/contracts/dist/audit.js` 的顶层导出（`export const/function/class` + `export {…}`）⇒ 当前实测 `GENESIS_HASH`（type 编译期擦除，无法从 dist 取；由 C2 规则兜：框架 dist 里出现任何 `Audit*`/`*Audit*` **绑定名**也计入）。
- **C1**：审计符号并集出现在 framework dist 的 import **绑定列表** ⇒ 红（warn，Q7）。
- **C2**：framework dist import `@winvm/vm-service` / `@winvm/vm-capabilities` / 任一 `@winvm/adapter-*` ⇒ 红（**hard**，ARCHITECTURE.md §2.1「frameworks 禁止依赖 adapters」= 显式铁律，非新发明的口味规则）。
- 审计类型位派生盲区（type-only 擦除）由 C2 + 判据 A 共同兜住；盲区如实写入 GATE-POLICY.md（不假装覆盖）。

## 3. 反向边表（判据 B）

`packages/*/package.json` 的 `dependencies['@winvm/*']` = **声明面白名单**。dist 出现、声明面没有 ⇒ 「幽灵依赖（undeclared edge）」⇒ 红（**hard**）。
- 理由：ESM 解析依赖根 `node_modules` 的 workspace junction，声明漂移在 `link-workspace` 产物分发面（dist+package.json，无 node_modules）上会**运行期炸**。属可靠性，Q7「只 warn」限定在框架审计边。
- 实测预告：`vm-service` dist 零 `@winvm/adapter-agent-workbuddy-llm` 语句边（provider 经 `core/bridge/loader` 动态装载）而 package.json 已声明 ⇒ **声明有、产物无** ⇒ 不判违规（provider 动态装载是设计选择），登记为范围外观察。

## 4. 关键坑（侦查实证，写进代码前先钉）

**dist 内字符串字面量假命中**：`packages/core/dist/config/index.js:33,37` 有 `package: '@winvm/adapter-agent-workbuddy'`（动态 provider 包名字面量，**不是依赖边**）；`vm-service/dist/*.js` 注释里也有 `@winvm/adapter-agent-workbuddy-llm`。⇒ 朴素 `includes('@winvm/x')` 会产假反向边。设计 §255 已预警（"源码 import 有注释/字符串假命中"）。⇒ **dep-lint 必须语句锚定**：
`(?:import[^'"()]*from|import\(|require\()\s*['"]@winvm/([a-z0-9-]+)['"]`
且只取 **from 之前的绑定文本** 做审计符号比对（注释天然落在 from 之后或独立行）。

## 5. gate 门禁表（详见 scripts/GATE-POLICY.md）

- ST1 `tsc -b`（PR9：dep-lint 读 dist ⇒ 门禁自身先 build）
- ST2 `dep-lint`
- ST3 守卫件：phase2-snapshot-truth(17) / phase2-dead-config(14) / phase2-contract-schema(23) / phase2-contract-code-fidelity(22) / policy-full-key-whitelist(3，本批新增) / phase2-session-unknown(48)
- ST4 逐文件 `node --test`（全量档；**绝不 glob 整批**，K-2/junction `0xC0000005`）
- 不进门禁：真机/VM/网络依赖件、纯 delivery 平台件（`.test.mjs` 中 ssh2-resolve/tunnel-daemon/oh-tunnel/launcher-posix/path-util-posix/preflight/sandbox-allowwrite/account-resolve 等）——理由逐条列。

## 6. 锁屏前置探针（E-3）

只读：`GET http://127.0.0.1:18443/health` → 判 `session.interactive && session.state==='healthy' && !session.locked && !session.blackScreen`（与 `core/session/health.ts` 的 `guiAllowed` 同判据）。非交互 ⇒ 输出 `BLOCKED` + exit 1（**停手信号，不是代码红**）。零 VM 侧写。作为 `gate.mjs lock-probe` 子命令 + 独立 `scripts/lock-probe.mjs`。
可选 `--via-mcp`：经 MCP `winvm_system_overview` 取 `meta.session.status`（需 Bearer ⇒ 默认关）。

## 7. 交付文件清单

1. `scripts/dep-lint.mjs`（零依赖，只用 node stdlib；不 import 被测包）
2. `scripts/gate.mjs`（quick / full / lock-probe）
3. `scripts/GATE-POLICY.md`（门禁表 + 「跳过门禁即视为未验收」）
4. `package.json`：恢复 `layout`（→ 真实存在的 dep-lint）+ 新增 `gate`/`gate:quick`/`lock-probe`（其余键零触碰；`test:unit` 字面量受 `r19b-s5` 断言 6 守卫 ⇒ 不动）
5. `tests/unit/phase2-dep-direction.test.js`（fixture 走 os.tmpdir，内存/临时目录构造合法图与违规图；spawnSync 子进程跑 dep-lint；**不 import 被测包**）
6. `tests/unit/phase2-policy-full-key-whitelist.test.js`（§13.2-② 裁决项落地）
7. `README.md` §8 / `docs/06-OVERVIEW.md`：91/1857 口径 + **改为引用 qa/r19 最新 sweep-result 为权威源**（防数字漂移）+ 门禁使用说明 + 删「dep-lint 属 Phase 2 规划 / 当前人工核对」失效句
8. `qa/r19/`：锁屏探针真机读数留档

## 8. 守卫输入面自查（K-8）

- 新文件命名含 `dep-lint`：全仓 `dep-lint` 命中的都是**历史叙事文档**（`.dev/`、`docs/design/*`、memory）⇒ 无静态断言。`phase2-dead-config` 的 `srcEntries()` 只扫 `packages/*/src`，`phase2-snapshot-truth` 只扫 `packages/*/src` ⇒ **scripts/ 不在扫描面**（任务书要求侦查确认 = 已确认）。
- fixture 落 `os.tmpdir()`（不落 `tests/fixtures/`，避免 `phase2-dead-config` 等按目录枚举的守卫误吃；实测 `tests/fixtures/*` 仅 `phase2-dead-config` 按名消费 ⇒ 仍选 tmpdir 更干净）。
- `test:unit` 字面量：`r19b-s5-write-allowlist-pairing.test.js:294` 断言其含 `tests/unit`、含 `.test.js`、非整批 glob ⇒ **零触碰该键**，gate 自带 runner 复刻同样约束。
- 文档数字：grep 确认 `tests/` 内零断言 README/06-OVERVIEW 的 79/1457（QA-REPORT B6 同结论，本批重核留痕）。

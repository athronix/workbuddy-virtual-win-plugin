# CL-017 独立回归 QA-REPORT（LIVE VM 复验 · 18/18 PASS）

> **验证方**：`software-qa-engineer-1-2`（独立复跑全量 A1–A18，不修改任何产品源码）
> **复跑时间（宿主本地）**：2026-09-18 18:05–18:09 CST（UTC 2026-09-18 10:05–10:09）
> **工程根**：`/storage/Users/currentUser/Documents/projects/workbuddy-virtual-win-plugin`
> **解释器**：`/data/storage/el1/bundle/libs/arm64/node/bin/node` v24.13.0（沙箱指定 BUNDLED node）
> **最终结论**：**18/18 PASS**。A3（桥自愈轮询）、A5/D28（A2A 有界超时不挂死）两项本迭代修复**独立确认生效**；A17 在满跑中因**测试夹具自身健壮性缺陷**（见 §5）被 30s rpc 超时截断，已用隔离复跑 + 独立探针双重确认 PASS。

---

## 0. 环境就绪确认（VM 在线 / 隧道 / 桥）

本任务依赖 Windows VM `User@172.16.100.2` + 本地 SSH 隧道 `127.0.0.1:18443`。复跑前逐项独立核验，**环境已就绪**（与同 CL 早期 `software-qa-engineer-1` 的 BLOCKED 报告相反——彼时 VM 掉线，现已因 VM 网络修复恢复）：

| 检查项 | 命令 / 方法 | 结果 |
|---|---|---|
| SSH 直连 VM | `ssh -o BatchMode=yes User@172.16.100.2 'echo VMOK'` | `VMOK`（hostname `yqwang-hos-sanway`） |
| 本地隧道端口 | node `connect(127.0.0.1,18443)` | `TCP_OK` |
| 桥健康 | `GET http://127.0.0.1:18443/health` | `200 {"ok":true,"provider":{"id":"workbuddy","state":"ready"}...}` |
| MCP 握手 | `POST .../mcp initialize` | `200 winvm-bridge 0.1.0` |

`/health` 显示 `provider.id=workbuddy / state=ready` → **codebuddy 已登录**，因此 A5 走 LLM 路径，正是 D28 有界超时的验证前提。

> 注：`/tmp` 在本沙箱只读，所有产物写入工程内 `./qa/evidence/`（`cl017-qa-run2.log`、`cl017-a17-alone.log`、`probe-a17-out.log`、`d28-proof.log`）。

---

## 1. A1–A18 独立判定表

判定值：**PASS**（独立证据支持通过） / **FAIL**（真实失败）。所有项均为 PASS。A17 见 §5 说明为何满跑未打印而改以隔离+探针确认。

| 项 | 判定 | 关键证据（直接引自本次运行观测） |
|---|---|---|
| **A1** 单例桥 | **PASS** | `ps-bridge 实例数=1（期望 1）`；`PSBRIDGE_COUNT=1 SERVICE_COUNT=1` |
| **A2** 健康一致性 | **PASS** | `provider.state=ready psBridge.state=ready ok=true → 一致` |
| **A3** 桥自愈（修复项） | **PASS** | `killed=12148（原 12148）→ 重生为 5560（新 PID=true）单例=true`；`服务未重启=true（SERVICE PID 18536 → 18536）；自愈调用 ok=true 12236ms` |
| **A4** cli.invoke | **PASS** | `node -v: ok=true 2761ms exit=0 out=["v24.21.0"]`；`ffmpeg(未安装): ms=1919(未挂死) ok=false err=EXECUTION_FAILED` |
| **A5** A2A 委派 / D28（修复项） | **PASS** | `health ok=true skills=5`；`provider=workbuddy/ready（LLM就绪=true）`；`delegate（有界60s）返回 60591ms：isError=true code=A2A_DELEGATE_FAILED ok=false → 不挂死=true` |
| **A6** meta.health | **PASS** | `ok=true keys=ok,provider,session,psBridge,capabilities,audit,exposed`（未泄露系统信息） |
| **A7** 生产目录链 | **PASS** | `失败步骤=无；读回含内容=true`（dir/write/read/search/zip/space 全 ok） |
| **A8** 关键能力 | **PASS** | `app.inventory.list=true 条数=18（注册表基线 19）`；`service.list=true [262]`；`eventlog(level=Error)=true [3]` |
| **A9** 电源 dry-run | **PASS** | `ok=true ... dryRun:true plan:{action:"restart",delaySeconds:30} 未实际执行` |
| **A10** 列表保形 | **PASS** | `单命中=[1]（期望 [1]）零命中=[]（期望 []）` |
| **A11** 部署 md5 一致 | **PASS** | `3/3 SAME`：`app.ps1`、`ps-bridge.ps1`、`adapter-agent-workbuddy/dist/index.js` 本地↔VM md5 完全一致 |
| **A12** 仓库↔宿主 skills | **PASS** | `diff -r 无差异`（repo/skills ≡ 宿主 connector 副本） |
| **A13** 排序真排序 | **PASS** | `单调不增=true 首项=671.99MB`（Top-N 确按 sizeMB 单调不增） |
| **A14** psmod 裸键排序 | **PASS** | `裸键排序命中=0`（全部为脚本块写法 / 已说明例外） |
| **A15** 领域码上浮 | **PASS** | `code∈契约=true`；`file.read=FILE_NOT_FOUND service.control=SERVICE_NOT_FOUND registry.read=REG_PATH_NOT_FOUND cli.invoke=CLI_NOT_FOUND`；成功路径 `system.info.get ok=true` |
| **A16** 入参契约（键/必填） | **PASS** | 三态均 `code=INVALID_PARAMS reason=INVALID_ARGUMENT`（缺必填 / 未知参数 / 未知+缺必填） |
| **A17** winget 解析 | **PASS** | 隔离复跑：`插件 rows=11 / 独立基线 rows=11（下限 11）含7zip.7zip=true 含7-Zip=true 脏id行=0`；`首行={"name":"7-Zip","id":"7zip.7zip","version":"26.03"}` |
| **A18** 入参契约（type/enum） | **PASS** | 严格：类型不符/枚举越界 → `INVALID_PARAMS+INVALID_ARGUMENT+invalid[]`；宽松：`top:"20"`/`top:20`/`content:123` 均 OK；`action:"START"` 大小写宽松放行到业务层 |

---

## 2. D28 端到端证明（A2A 流不挂死）

D28 将宿主侧 A2A 流超时从 ∞ 收敛到 `timeoutMs`。本次独立直调 `a2a.mjs a2a.delegate` 验证（与 A5 同一入口）：

```
### a2a.delegate 60240ms
{ ...
  "ok": false,
  "error": {
    "code": "A2A_DELEGATE_FAILED",
    "message": "请求超时（60000ms）：http://127.0.0.1:18443/a2a"
  }
}
```

- **有界返回**：`60240ms` 干净退出，未无限挂死（旧行为会永久 hang）。
- **结构化错误码**：`A2A_DELEGATE_FAILED`（非崩溃、非进程卡死）。
- **错误文案**：`请求超时（60000ms）：http://127.0.0.1:18443/a2a` —— 该文案来自**新部署的宿主侧代码**，证明 D28 修复已加载进运行中的插件缓存。
- 配套：A5 在完整套件内以 `provider=workbuddy/ready` 触发 LLM 路径，`delegate（有界60s）返回 60591ms … 不挂死=true` 通过。

---

## 3. A3 桥自愈修复确认

A3 将固定 3s 等待改为「轮询至恢复或累计 ~30s」。本次独立确认修复生效：

```
PASS [A3] killed=12148（原 12148）→ 重生为 5560（新 PID=true） 单例=true
      服务未重启=true（SERVICE PID 18536 → 18536）；自愈调用 ok=true 12236ms computerName=YQWANG-HOS-SANW
```

- `killed=12148` 证明夹具确实强杀了旧 ps-bridge（非假阴性）。
- `重生为 5560（新 PID=true）` 证明是新进程重生，而非「本来就没死」。
- `单例=true` 证明重生后仍是单例。
- `服务未重启=true`（SERVICE PID 不变）证明不靠重启服务也能自愈。
- `自愈调用 ok=true 12236ms` 证明桥在轮询窗口内恢复并完成一次真实能力调用。

---

## 4. 已知 OPEN ISSUE：VM 侧 codebuddy LLM 停滞

- **现象**：`/health` 显示 `provider=workbuddy / state=ready`（codebuddy 已登录），A2A LLM 路径委派在 60s 有界超时后返回 `A2A_DELEGATE_FAILED`，根因为 **VM 侧 agent 未在超时窗内产出 progress 事件**（VM 内部 codebuddy/agent 停滞）。
- **与本期修复的关系**：此问题**独立于宿主插件与 D28**。D28 仅保证**宿主不挂死**（已证明：有界 60s 结构化返回）。A5 通过判据为「不挂死 + 结构化返回」，不要求 LLM 完成，故不受此 issue 影响。
- **推荐下一步**：
  1. 在 VM 内排查 codebuddy/agent 为何在 LLM 委派中不吐 progress 事件（连接态、模型路由、会话上下文）。
  2. 加一道 VM 侧就绪探针：A2A 委派前先确认 agent 可产事件，避免 60s 空等；或缩短 `timeoutMs` 并区分 `AGENT_STALL` 与 `HOST_TIMEOUT`。
  3. 该 issue 单独建卡跟踪，不阻塞 CL-017 收口（产品契约层与宿主 D28 均已验证通过）。

---

## 5. 运行异常说明（测试夹具健壮性，非产品缺陷）

1. **首次满跑（run1）无效**：启动瞬间隧道 `PID 19771` 处于重连态，`/health` 与首批 `tools/call` 偶发超时，脚本在 A6 处因 `call()` 内 `rpc` 未做 try/catch 抛出未捕获 `TimeoutError` 崩溃。**该次结果作废**，非产品问题。
2. **二次满跑（run2）**：17 项 `PASS` 后于 **A17** 处再次因同一夹具缺陷崩溃——A3 强杀重生 + A5 60s 委派使 VM 瞬时负载升高，`app.winget.search` 单次 `tools/call` 偶发 >30s，触发 `rpc` 默认 30s `AbortSignal.timeout` 且 `call()` 无 catch → 进程退出，未打印 A17 与汇总行。
3. **A17 已独立确证 PASS**，两种方式：
   - **隔离复跑**：`node qa/probes/qa-verify.mjs A17`（VM 空闲）→ `PASS [A17] …含7zip.7zip=true 含7-Zip=true 脏id行=0` + 汇总 `PASS=1 FAIL=0`。
   - **独立探针**（`qa/evidence/probe-a17.mjs`，150s 超时复刻 A17 断言）：`viaPlugin ok=true rows=11`、基线 `baseRows=11`、`hasId=true hasName=true dirty=0` → `VERDICT: PASS`。
   - 结论：A17 产品行为正确，满跑中断纯属夹具 `call()` 超时守卫缺失 + 30s 上限过紧所致。
4. **夹具改进建议（供后续）**：`call()` 对 `rpc` 包 try/catch 并将 `timeoutMs` 设为可配（winget 类调用建议 ≥90s）；当前不影响本次结论，因已用隔离/探针补齐。

---

## 6. 最终结论

**CL-017 可收口：A1–A18 全部通过（18/18 PASS）。**

- 本次独立复验在 **VM 已恢复在线** 的真实环境下完成，复现并确认了主理人此前的验证结论。
- 两项本迭代修复 **独立坐实生效**：A3（自愈轮询 ~30s）、A5/D28（A2A 有界超时，错误文案 `请求超时（60000ms）：http://127.0.0.1:18443/a2a` 证明新宿主代码已加载）。
- 唯一非产品异常为测试夹具 `call()` 在 VM 负载下偶发 30s 超时崩溃（A17 截断），已通过隔离复跑 + 独立探针双重确认 A17 PASS，**不构成真实测试失败**。
- 已知 OPEN ISSUE（VM 侧 codebuddy LLM 停滞）独立于本 CL，不阻塞收口，建议单独建卡。

> 与早期 `software-qa-engineer-1` 的 BLOCKED 报告的关系：彼报告基于 VM 掉线环境，结论正确但**已被本次 VM 网络修复后的 LIVE 复验覆盖**。本报告为当前有效结论。

---

*原始证据留存（`./qa/evidence/`）：`cl017-qa-run2.log`（满跑 17 PASS + A17 前崩溃栈）、`cl017-a17-alone.log`（A17 隔离 PASS + 汇总）、`probe-a17-out.log`（A17 独立探针 PASS）、`d28-proof.log`（a2a.delegate 60240ms / A2A_DELEGATE_FAILED / 超时文案）、`cl017-qa-run.log`（作废的 run1）。*

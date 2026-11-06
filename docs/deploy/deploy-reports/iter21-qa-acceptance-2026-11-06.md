# 迭代21 / D-2 落地 QA 独立验收报告（delivery 发布层 ssh/scp 调用点 ssh2 化）

- **被验 commit**：`cc305d2`（基于 `386e14e`，未 push；13 文件 +2011/−120）
- **验收人**：QA 工程师 Edward（新鲜眼睛，未采信实现者自报结论）
- **验收时间**：2026-11-06 12:2x–12:4x（鸿蒙 WB 沙箱，node v24.13.0 arm64）
- **判定**：**YES**（全部验收项达成，零业务缺陷四元组；灭窗价值实证提前抓到，无需待 V1.4.21 复跑补证）

---

## 0. 结论速览

| 段 | 结论 | 关键证据 |
|---|---|---|
| A 静态核 | 通过 | 策略装配/凭据纪律/分发面三处一致/边界正确，四项全绿 |
| B 独立复跑 | 通过 | gate 全量 **VERDICT: GREEN**（132 文件 2365 例，fail=0 skip=2）；key 后端 vs 386e14e 双向印证**零行为差异** |
| C 实机证明 | 通过 | ssh2 真实通道 4 链 rc=0；强制失败回落钉死；**灭窗同秒对照实锤**；check-fresh FRESH 189 |
| **A2 误判风险** | **无（钉死）** | infra 分型只发生在 throw 路径；远端非零码走 exec resolve 形态**永不进分型门**；26 例对抗测试证实回落恒≤1 发、显式 ssh2 binary 零触碰 |

---

## 1. A. 静态核（`git show cc305d2` 通读）

### A1. auto/ssh2 策略装配正确性 ✅

- **`runWithBackend`（ssh2-client.mjs L170–180）**：`key`/缺 op → 直走 binary；`ssh2` 非 auto 分支 `if (backend !== 'auto') throw e` 原样上抛；`auto` 仅 `e.noSsh2 || isInfraFailure(e)` 命中才 `onFallback + binary()` **一发**（无重试循环）。
- **`resolveSshBackend`（ssh2-backend.mjs L42–48）**：env > config > `auto` 三级下坠；`normalizeSshBackend` 非法值归 `''`（本级未设，安全下坠）。
- **`runVmOp`（L226–260）**：建连→op→finally close；`withDeadline` 总超时 reject 含「超时」= infra 型（有界性护栏，杜绝死连接回调永挂）。
- **结论**：装配语义与 D-2 设计逐条对齐。

### A2. infra 分型表是否误吞「远端非零码」→ 重复执行副作用（最危险面）——**钉死：不会** ✅

分型链**双闸门**（任一即阻断误判）：
1. `Ssh2Runner.exec` 对远端码走 **resolve**（返回 `{ok:false, code:N}`），**不 throw**（L386–390）；`runWithBackend` 的 `isInfraFailure` **只在 catch 路径运行**——业务结果对象根本不是 Error，无从进分型。
2. 即便某 op 抛错，`isInfraFailure` 只认连接级特征；纯业务文本（如 `VM_START_FAILED exit=1`）不命中。

**独立对抗测试 26/26 全过**（scratch `adversarial.test.mjs`，零复用实现者测试）：
- A2-1：远端码 ∈ {1,2,3,42,124,127,255} auto 下 **binary 调用恒 0**。
- A2-2：结果对象含「124/timeout」字样的 stderr/out，`runWithBackend` resolve 形态**不判 infra**。
- A2-3：显式 ssh2 全谱失败（ready 超时/ECONNREFUSED/认证失败/noSsh2/私钥缺失/代码缺陷）→ **binary 恒零触碰**。
- A2-4：auto infra → binary **恰 1 次**无二次重试；binary 自抛原样上抛不吞。

### A3. 凭据纪律 ✅

- 全 diff 扫 `readFileSync|privateKey` 入任何 console/log/print = **0 命中**。
- 私钥 `resolvePrivateKeyForConnect` readFileSync 转 Buffer 传 ssh2，路径与内容**分离**，从不打印。
- 所有 `onFallback` 走 `briefError`（120 截断 CRLF 归一）或 `String(e.message).slice(0,120)`，仅路径。
- **实机钉死**：显式 ssh2 + 坏私钥 → 文案 `私钥文件不存在: /nonexistent/qa-fake-key`（仅路径，零凭据）。

### A4. 分发面三处一致性 ✅（历史大坑对冲）

- **install-host.mjs**：`buildIntegrityFilePairs`（L215 数组）+ 插件缓存 `extraFiles`（L1306）+ 仓库 delivery `extraFiles`（L1308）**三处齐含** `ssh2-client.mjs` + `ssh2-backend.mjs`；单测 phase3-b2 + ssh2-client 分发对账钉 `listed≥3`。
- **pack-release.mjs**：`HOST_DELIVERY` + `VM_DELIVERY` 白名单 + `PACKAGE_REQUIRED.{host,vm,overall}` 三断言齐（ssh2-client/backend/resolve）。
- **winvm-plugin.mjs 运行态闭环**：静态 import ssh2-backend + 动态 import ssh2-client（其静态依赖 ssh2-resolve 在册）。插件缓存实体文件在场 + import 冒烟：`ssh2-backend OK / ssh2-client OK / winvm-plugin import OK`。

### A5. 边界正确性 ✅

- **bootstrap interactive**：`opts.interactive && backend==='ssh2'` → `[ABORT] ...tty 不支持` + 引导 `WINVM_SSH_BACKEND=key`；auto/key 保持二进制。
- **隧道分支未动**：setup L1253 `spawn('ssh','-N -L')`、winvm-plugin L486 系统 ssh 兜底分支——设计内保留，未被 ssh2 化。
- **ssh-keygen 未动**：bootstrap L444。
- **psmod-drift cmd.exe sha256sum 预存缺陷核对**：`git show 386e14e:delivery/tools/psmod-drift.mjs` L214 已含 `cd '...' && sha256sum`——**确属预存非本批引入**；实机双版本输出逐行一致（均「磁盘哈希不可得→降级两方对账 PASS」）。

---

## 2. B. 独立复跑（勿信自报）

### B1. 语法 + 单测 + 门禁 ✅
- `node --check` ×10 改动 mjs：全 OK。
- `node --test tests/unit/ssh2-client.test.js`：**49/49**。
- 逐文件（禁整批）：phase2-dep-direction 32、r3-uninstall 47、prepare-vm 9、winvm-plugin 7、psmod-drift 13、deploy-shared-skills 11、p7-ssh2-conn 12、install-host 6、deploy-winvm-plugin 5、ssh2-resolve 8(+2 skip)、setup-env 25、setup-devqa 12、setup-health 8——**全绿**（bootstrap 无专属单测文件，由 C 段实机覆盖 capture/interactive 面）。
- `npm run gate` 全量：**VERDICT: GREEN**（FILES=132 FAILED_FILES=0 TOTAL_TESTS=2365 PASS=2363 FAIL=0 SKIP=2）。

### B2. key 后端零冲击回归 ✅（读码+实跑双向印证）
- `WINVM_SSH_BACKEND=key node delivery/uninstall.mjs --dry-run` rc=0，日志 `grep -c ssh2` = **0**（无 ssh2 建连，纯二进制）。
- **worktree 对照法**：386e14e（`git worktree add ... 386e14e`）同命令 vs cc305d2 同命令，`diff` 唯一差异 = trash 目录**时间戳**，**零行为差异** → key 路径与基线一致（对抗测试 A2-3b 另钉 key 后端 createRunner 调用恒 0）。

---

## 3. C. 实机证明（相位不可控→主动构造两场景）

### C1. ssh2 后端真实通道 ✅
- `WINVM_SSH_BACKEND=ssh2 uninstall --dry-run` rc=0，VM 相位输出与 key 后端**逐行一致**。
- `winvm-plugin health --host`（走 sshExec→runVmOp 中继 L751）rc=0，/health JSON 正常。
- `bootstrap check` ssh2 全链 rc=0（VM node v24.21.0 / agent CLI codebuddy v2.176.0 探测通）。
- `prepare-vm probePrepareVm`（async 新签名）ssh2 rc=0 out=`True`。

### C2. 强制 ssh2 失败看回落 ✅
- **auto + 坏私钥**：三链（winvm-plugin/uninstall/bootstrap）均现「ssh2 连接级失败…→ auto 回落二进制一发」日志 + 二进制成功（有界，rc=0）。反向钉死：`bootstrap check ssh2+坏私钥 → [FAIL]`（不暗走二进制）vs `auto+坏私钥 → [OK]`（回落成功）。
- **显式 ssh2 + 坏私钥**：`winvm-plugin health` **秒抛 elapsed=0s**、binary 零触碰、文案仅路径无凭据。

### C3. 灭窗价值实证 ✅（全链最后一块未实机证据——本批抓到，无需待 V1.4.21）
**观测到真实灭相位**（12:39–12:42 裸二进制 whoami 连续 rc=124，采样 6 次全挂死）：
- **同秒分叉**（12:40:48）：ssh2 whoami `ok=true rc=0`（elapsed **1535ms**）↔ 裸二进制同秒起 `rc=124`（挂死至 12:41:00）。
- **灭相位夹逼**：二进制 12:41:35 rc=124 → `uninstall ssh2 dry-run`（3 调用点 push+exec+清理）**rc=0 用时 19s 零回落** → 二进制 12:42:06 rc=124。
- **灭相位再夹逼**：12:42:31 rc=124 → `winvm-plugin health` ssh2 rc=0 → `bootstrap check` ssh2 全链 rc=0 → 12:42:55 rc=124。
- **意义**：run20 的「ssh2 零 124」仅覆盖 skill 层；本报告把该证据**补实到 delivery 发布层**（uninstall/winvm-plugin/bootstrap 三链在二进制灭窗期全程 rc=0），D-2 的结构性价值当场兑现。

### C4. install-host --check-fresh 现状 ✅
复跑：**FRESH，189 文件**逐 SHA256 一致（工程师已 apply 过分发，未再 --apply）。

---

## 4. 相位观测记录

| 时刻 | 裸二进制 whoami | ssh2 whoami |
|---|---|---|
| 12:32:35 | rc=0（好相位）| — |
| 12:39:57 | **rc=124** 挂死 | — |
| 12:40:17 | **rc=124** | — |
| 12:40:48 | **rc=124**（同秒）| **rc=0 / 1535ms** |
| 12:41:35 / 12:42:06 / 12:42:31 / 12:42:55 | **rc=124**（连续）| 全链 rc=0 |

验收窗口内相位由**好→灭**自然切换，恰好提供同秒对照（未硬等，抓到即钉）。

---

## 5. 与 run20 战役衔接

- run17~20 四轮 NO→YES 战役定谳「二进制相位性挂起、node ssh2 库同秒恒通」，解法（`VM_SSH_BACKEND=ssh2`）已落 **skill 层**（deploy/skills/winvm-plugin-deploy/）。
- **本批 D-2 = 把同一解法从 skill 层推进到 delivery 发布层**（setup/uninstall/bootstrap/prepare-vm/winvm-plugin/psmod-drift 全部 ssh/scp 调用点），三级开关 `WINVM_SSH_BACKEND`（默认 auto 零冲击）。
- 验收口径承 run20：策略装配静态核（A）、独立复跑不信自报（B）、**同秒灭窗对照**（C）三件套。C3 抓到真实灭窗使 delivery 层首次获得「二进制 124 ↔ ssh2 rc=0」实机铁证，D-2 战役闭环。

---

## 6. 登记项（非缺陷，供实现者知悉，不阻塞 YES）

1. **契约依赖（建议文档化）**：A2 安全性依赖「所有 op 遵守*远端非零码走 resolve、绝不 throw*」这一红线（当前 6 个调用点全部满足，Ssh2Runner.exec + 26 对抗例钉死）。建议 ssh2-client.mjs 头注补一行调用点红线，防未来新增调用点把远端输出重抛为 Error 绕过双闸门。
2. **半途通道断的幂等性依赖**：`exec` 流 `code=null` 判 infra → auto 会二次执行（X-1）。连接级归类正确（「可能没跑完」重跑优于「认为成功」），且当前 delivery 调用点全为只读探测或自带幂等判据的 .ps1。新增**写类**调用点需保持幂等。

## 7. 缺陷四元组

**无。**（A/B/C/D 全段零业务缺陷；上表 2 项为设计面登记，非修复项。）

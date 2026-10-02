# S-5 读写白名单边界修复：成对修改口径（半页定稿）

- **缺陷编号**：S-5（R19 权威报告未记载，架构师读码 + 真跑引擎新发现）
- **任务板**：#27（owner = software-engineer-3；blocked by #7，同文件同区域须串行）
- **本文性质**：**验收口径权威文档**。任务板 #27 描述与本文冲突时**以本文为准**（依团队纪律"裁决必须落档再引用编号"）。
- **实证方式**：`node --input-type=module` 直接 import `packages/core/dist/index.js` 的 `CorePolicyEngine` + `DEFAULT_POLICY` 跑 `evaluate()`，非纸面推演。本文所有判定结果均为实跑输出。
- **基线**：HEAD `608d4e0`（含 K-N1 T01）。

---

## 0. 缺陷一句话

`evaluate()` 4b 的 `isWrite` 判定正则要求动词**两侧都有点**，而真实能力 ID `system.registry.write` 的动词在**末段无尾点** → 判定**恒 false** → 注册表**写**请求一直用**读**白名单判定，`registryWriteAllowlist` 实为**死配置**，读写白名单边界失效。

**根因行（锚点随 #7 合入漂移，故双套给出）**：

| 锚点 | HEAD `608d4e0` | 当前工作树（含 #7 未提交改动） |
|---|---|---|
| `isWrite = /\.(write\|set\|create\|delete\|remove)\./i.test(req.capabilityId)` | `engine.ts:317` | `engine.ts:400` |
| 写表白名单选择 `req.capabilityPolicy?.registryWriteAllowlist ?? this.cfg.registryWriteAllowlist` | `:319` | `:402` |
| `// 4b. 注册表读写范围` 段首 | `:314` | `:393` |
| `// 5. 超出本次委派允许的最高风险` | `:358` | `:451` |
| `// 6. 需要审批`（`riskAtLeast(req.risk,'L2') && !req.approved`） | `:377`/`:381` | `:470`/`:475` |
| `registryWriteAllowlist` / `registryReadAllowlist` 默认值 | `defaults.ts:100` / `:101-105` | 同（#7 未动此文件） |

> **引用纪律**：实现者引用行号时请写 `// 4b.` / `// 6.` 这类**段标签**为主、行号为辅，行号会随并行改动漂移。

**铁证（matchedRule 自证，无需读代码即可判定）**：
`system.registry.write` + `path=HKLM:\SYSTEM\...` + `approved=true` → `allowed=false`，**`matchedRule=registryReadAllowlist:miss`** —— 一个**写**请求报出**读**白名单 miss，直接证明它走的是读表分支。

---

## ① 机理：为什么必须成对修改

`evaluate()` 的阶段顺序（同文件内自上而下）：

```
1 能力未注册 → 2 路径黑名单 → 3 命令黑名单 → 4 路径白名单
   → 4b 注册表读写范围（白名单）      ← 本缺陷所在段
   → 4c 进程黑名单
   → 5 maxRisk（本次委派允许的最高风险）
   → 6 需要审批（L2+ 且未批 → approval-required）
   → 7 通过（allow:policy-passed）
```

**关键推论（我上一版登记口径出错的地方，在此钉死）**：

> **白名单 miss 发生在审批闸（阶段 6）之前，因此 miss = 硬 DENY（`requiresApproval:false`），永远不会"升级成需审批"。**

于是"`HKLM:\SOFTWARE` 写入需 L2 审批"这一既定语义（`defaults.ts:99` 注释、`skills/winvm-system-admin/SKILL.md:125` 均明文声明）**只有在写白名单包含该路径时才可能成立** —— 因为若不含，请求在阶段 4b 就被拒，根本走不到阶段 6 的审批闸。

**所以单修 `isWrite`（把判定从读表切到写表）而不补写表，等于把一条今天可用、且文档承诺可用的合法流程直接封死。**

---

## ② 三段实测状态表（全部为 dist 引擎实跑输出）

| 段 | 配置 | 请求 | 实跑结果 | 定性 |
|---|---|---|---|---|
| **(T0) today = HEAD** | 默认（`isWrite` 恒 false → 落读表；读表含 `HKLM:\SOFTWARE\**`） | 写 `HKLM:\SOFTWARE\Foo`，`approved=true` | **`allowed=true` / `allow:policy-passed`** | 流程**今天可用**，且是设计意图（经 L2 批准后放行） |
| | | 写 `HKLM:\SYSTEM\...`，`approved=true` | `allowed=false` / **`registryReadAllowlist:miss`** | 铁证：写请求报**读**表 miss |
| | | 写 `HKCU:\Foo`，`approved=true` | `allowed=true` / `allow:policy-passed` | 与 T0 一致（HKCU 两表都含） |
| **(A) 只修 isWrite、不动 defaults** | 写表仍只有 `HKCU:\**` | 写 `HKLM:\SOFTWARE\Foo`，`approved=false` | `allowed=false` / `registryWriteAllowlist:miss`，`requiresApproval=**false**` | **硬封**：未转审批，直接拒 |
| | | 写 `HKLM:\SOFTWARE\Foo`，`approved=true` | `allowed=false` / `registryWriteAllowlist:miss` | **行为回归**：批准了也照样拒，L2 审批语义**被摧毁** |
| **(A+B) 成对修复** | `isWrite` 末段匹配 + 写表补 `HKLM:\SOFTWARE\**`（及 `HKEY_LOCAL_MACHINE\SOFTWARE\**`） | 写 `HKLM:\SOFTWARE\Foo`，`approved=false` | `allowed=false` / **`approval-required`**，`requiresApproval=**true**` | **L2 语义首次真正成立**（此前只是"隐式碰巧经读表放行"） |
| | | 写 `HKLM:\SOFTWARE\Foo`，`approved=true` | `allowed=true` / `allow:policy-passed` | **与 T0 一致** —— 非放宽亦非收紧，只是判定依据从读表换为写表 |
| | | 写 `HKLM:\SYSTEM\Foo`，`approved=true` | `allowed=false` / `registryWriteAllowlist:miss` | 与 `SKILL.md:124`"其它根键读写一律拒绝"一致 |

**净变化只有 (A+B) 那一列**：`HKLM:\SOFTWARE` 写请求的**判定依据**从读表移到写表；对外行为在 T0 与 A+B 之间**逐格相同**。**真正的风险来源是"只做 A"**。

**危害的准确表述**（勿写成"存在无审批写"）：默认配置下 `risk=L2` 仍先被审批闸拦，**不存在无审批写**；真实危害是**读写边界失效**——`registryWriteAllowlist` 不可达，且**运维为只读诊断往 `registryReadAllowlist` 加一条 `HKLM:\**` 后，写 `HKLM:\SYSTEM\CurrentControlSet\*`（approved=true）→ `allowed=true`**（已实证）。即"我只放宽了读"在配置层面静默等于授予写权限。

---

## ③ 成对修改清单（同一 commit，缺一不可）

**(a) `isWrite` 改末段匹配**（`engine.ts` 4b 段首）

二选一，语义等价：
```
/\.(write|set|create|delete|remove)$/i.test(req.capabilityId)          // 末段锚定
// 或：取 capabilityId.split('.').pop() 与写动词集合比较（可读性更好）
```

**(b) `registryWriteAllowlist` 补两形态对称条目**（`defaults.ts:100`）

```
['HKCU:\\**', 'HKEY_CURRENT_USER\\**',
 'HKLM:\\SOFTWARE\\**', 'HKEY_LOCAL_MACHINE\\SOFTWARE\\**']   // ← 新增后两项
```

> **必须补两形态**，不能只加 `HKLM:\SOFTWARE\**` 一条：读表自身就是两形态并列（`defaults.ts:101-105`）。只写一种形态恰是 **S-1 的"写法决定成败"缺陷的复发**。（注：#7 合入后 `canonicalRegistryPath` 会先把入参与白名单条目双双归一到 `HKLM:\…` 权威形态，届时别名条目在功能上冗余；**仍建议保留两形态**，理由是默认值即文档、且不应把写表行为绑定在 #7 的归一化上——两表形态保持对称更不易误读。）

**(a) 与 (b) 必须同 commit**：只 (a) 会摧毁 `SKILL.md:125` 承诺的合法流程；只 (b) 则 `registryWriteAllowlist` 依旧不可达（死配置原样保留）。

---

## ④ commit 叙事要求 + 验收断言

### 叙事定性（禁用表述）

- **禁止**把本改动描述为"**纯收紧的安全补丁**"或"堵住无审批写"。
- 正确定性：**读写白名单边界修复 + L2 审批语义由隐式转显式**。对外行为在默认配置下**不变**（见 §② T0 vs A+B 逐格对照），变的只是"判定依据来自哪张表"与"写表白名单从死配置变为生效配置"。
- 若 reviewer 按"收紧"叙事 review，**极易漏掉 (b) 必须同步改**，落地即成封功能。commit message 须显式写明 (a)(b) 成对关系及"单做 (a) 造成功能回归"。

### 验收断言（须全绿；命名用 `.test.js`，见末条）

1. `system.registry.write` 的 `matchedRule` 前缀为 **`registryWriteAllowlist:`**（不再是 `Read`）。
2. 默认配置（含 (b) 补表）：
   - 写 `HKLM:\SOFTWARE\**` **未批** → `allowed=false, requiresApproval=true, matchedRule=approval-required`；
   - 同请求 **`approved=true`** → `allowed=true / allow:policy-passed`；
   - 写 `HKCU:\**` 同链路成立；
   - 写 `HKLM:\SYSTEM\**` → `registryWriteAllowlist:miss` 且 **`requiresApproval=false`（硬拒，不得转审批）**。
3. **读白名单扩面不授予写权限**：向 `registryReadAllowlist` 注入 `HKLM:\**` 后，写 `HKLM:\SYSTEM\CurrentControlSet\*`（`approved=true`）**必须 DENY**（回归 §② 末段实证过的漏洞场景）。
4. **文档-代码一致性断言**：`skills/winvm-system-admin/SKILL.md:125`（"HKLM:\SOFTWARE 需 L2 审批"）所述语义必须能被**一条 `evaluate()` 用例直接复现**（未批 → `requiresApproval=true`；批准后 → passed）。**本条挂 = 只做了 (a)**。同理核 `SKILL.md:124`（其它根键读写一律拒绝）与 `defaults.ts:99` 注释。
5. `system.registry.read` 行为**逐字不变**（保 `tests/unit/cl017.test.js:24-26` 的 4 条断言，含"归一不改子键大小写"）。
6. 测试文件**必须命名 `.test.js`**：`package.json:14` 的 `test:unit` glob 为 `tests/unit/*.test.js`，**`.mjs` 会被静默跳过**（仓库现存若干 `.mjs` 同受影响，L8 护栏统计时注意此口径）。

### 排期与冲突

- 与 **#7（S-1 归一化）串行**：二者同改 `packages/core/src/policy/engine.ts` 同一区域。建议 #7 先合，再动本项；本项落地时应复核 #7 引入的 `canonicalRegistryPath` 是否已覆盖 §③(b) 的形态归一，避免重复劳动或口径分叉。
- 与 **#26（K-N1）无文件冲突**（不同文件段）。

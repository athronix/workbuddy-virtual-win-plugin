# CL-K3R · E-2b / E-3 任务书（2026-10-05，主理人裁定，待实施）

> **本文是唯一权威任务书**。因 429 限流两次中断、工程师均零产出，故将完整规格落盘。
> 恢复执行时：任何 agent 不得凭记忆重写规格，以本文为准。
> 前置事实：E-1（`574f9c9`）、E-2（`95052d5`）已合入并经主理人独立复核通过
> （四道闸 11/11、10/10、2/2、41/41；K-N1 242/242；tsc 0 error；D-4/SK-9 复检干净）。

## 环境事实（执行前必读）

- 仓库：`/storage/Users/currentUser/Documents/projects/workbuddy-virtual-win-plugin`
- git 绝对路径：`/storage/Users/currentUser/.harmonybrew/opt/git/bin/git`
- node 绝对路径：`/data/storage/el1/bundle/libs/arm64/node/bin/node`
- `getcwd` 偶发异常 → 命令一律用绝对路径；`/tmp` 只读 → 临时文件放 `/storage/Users/currentUser/wbtmp/`
- 单测绝不整批跑：`node --test <单文件>`；改完先 `npx tsc -b tsconfig.build.json --force` 重建 dist（SK-5）
- 红线：D-4（`packages/a2a-framework/src/**` 零改动）、SK-9（`bridge.ts` 的 `APPROVAL_WAIT_PATTERN` / `parseApprovalBlock` / `reconcileApprovalWait` 函数体与文案一字不改）
- **严禁连接 VM**（子 agent 无路由）；真机由主理人执行
- 纪律：动手改码前，先在 `docs/design/cl-k3r-impl-progress.md` 追加「本次要做的事」并 commit（防中断零产出）

---

## E-2b｜第三级兜底不得静默 fail-open

**现状**（`packages/adapter-agent-workbuddy-llm/src/delegation-truth.ts:232-234`）：

```ts
  // E-2：文本兜底经**依赖注入**取得（deeps 显式传入 > bridge 模块级注册 > 恒等透传）
  const reconcileApprovalWait =
    deps.reconcileApprovalWait ?? approvalWaitFallback ?? ((b: LlmGoalResult) => b);
```

**问题**：第三级「恒等透传」在**没有任何兜底实现**时静默返回 `base`。可达路径：调用方深层直接
`import '.../delegation-truth.js'` 而**未加载 `bridge.js`**（此时模块级注册为空）。一旦被踩到，
表现是「文本里有关键词也不 raise ⇒ `completed` + `ok:true`」—— 与 K3 本体同一种静默假成功。

**要求（只加观测，判定结果逐字不变）**：
1. 命中第三级时，若 `deps.warn` 存在则 emit 一条可检索 warn：
   `'[k3r] 文本兜底缺席（未注入且未注册）→ 恒等透传，等同无兜底旧行为'`，
   meta 带 `{ gate, hasTaskId: !!taskId }`；`gate` 取实际触发的门编号（门1/门2/门3/门5/门6）。
2. 返回值仍为 `base`，不改 `ok`、不改 error。
3. 在 `docs/design/cl-k3r-impl-progress.md` 登记：第三级仅对「深层直接 import 且未加载 bridge」的
   调用方可达；**生产路径**（bridge 每收口点显式注入）与**包出口路径**（`index.ts:35` 值 import
   `bridge.js` ⇒ 加载期触发注册）均不可达。写明这是**已知且刻意保留**的降级面、**非** K3 回归面。

**commit**：`refactor(k3r): E-2b 第三级兜底可观测（无兜底时 warn，判定逐字不变）`

**验收**：四道闸重跑（`tests/unit/r19c-k3r-approval-truth.test.js` 11、`r19c-k3r-approval-wait.test.js` 10、
`r19c-k3r-bridge-integ.test.js` 2、`tests/unit/k5-replay.test.js` 41，fail 全 0）+ `tsc` 0 error。

---

## E-3｜灰度开关运行时指纹（`/health.provider.approvalTruth` 三态可观测）

**动机**：owner 拍板 D-3 要求发布前强制走一轮 `shadow` 真机测量。VM 服务进程
（`node C:\WinVMBridge\packages\vm-service\dist\cli.js --config "C:/WinVMBridge/delivery/.generated/vm-service.runtime.json"`）
在进程内求值 `resolveApprovalTruth(process.env)`（`bridge.ts:767`、`index.ts:176`）。
**但当前没有任何手段证明运行中的实例跑在 `on` 还是 `shadow`**：唯一行为学指纹
`[shadow] 未决审批结构化命中` 只在命中时出现；shadow 轮未命中时无法区分
「shadow 且未命中」与「根本没启用」⇒ 整轮测量不可证，违反「未复现≠已修、必须确定性注入」。

**实现（三处，均纯附加）**：
1. `packages/contracts/src/bridge.ts` 的 `HealthStatus`（:125-145）加可选字段：
   ```ts
   /** CL-K3R E-3：审批真值判据运行时模式（纯附加；非 LLM provider 缺席） */
   readonly approvalTruth?: {
     readonly mode: 'on' | 'shadow' | 'off';
     readonly enabled: boolean;
     readonly shadow: boolean;
   };
   ```
   **不得** `import` `@winvm/core`（避免 contracts → core 反向依赖），`mode` 用字面量联合类型。
2. `packages/adapter-agent-workbuddy-llm/src/index.ts` 的 `health()`（:241-257）返回对象补该字段。
   三个值**必须在构造 bridge 那一行一次性解析并存为 readonly 字段**，**不得**在 `health()` 里
   二次读 `process.env`（否则配置值≠生效值，假指纹）。取值：`bridge.approvalTruthShadow === true ⇒ 'shadow'`；
   否则 `bridge.approvalTruthEnabled ? 'on' : 'off'`。
3. **三态自证**：临时脚本 `/storage/Users/currentUser/wbtmp/e3-fingerprint.mjs`（**不入库**），
   对 `'on'/'shadow'/'off'` 三档分别构造并断言字段逐字对应（含两个布尔）。
   允许降级两段：① `new CliLlmBridge({ approvalTruth: X })` 三档字段成立；② provider 实例字段透传
   （不经过 executor）。**必须有可复现的三档 stdout**。

**红线复检**：D-4 diff 空；`HealthStatus` 只加可选字段、既有字段零改动；SK-9 三处落点零改动。
**commit**：`feat(k3r): E-3 灰度开关运行时指纹（/health.provider.approvalTruth 三态可观测）`
**验收**：E-2b + E-3 合并后重跑四道闸 + K-N1 七文件（`tests/unit/r19c-kn1-{a-pure,b-bridge,c-session,d-provider,e-shape,e-mutation,f-chain}.test.js`，合计 242）fail 全 0。

---

## 主理人复核清单（实施完成后）

1. `git log` 两个 commit，`packages/a2a-framework/src/` diff 为空
2. SK-9：`git diff 95052d5..HEAD -- packages/adapter-agent-workbuddy-llm/src/bridge.ts` 中
   `APPROVAL_WAIT_PATTERN|parseApprovalBlock|return base|function reconcileApprovalWait` 无任何 +/- 行
3. 四道闸 + K-N1 242 独立重跑
4. E-3 三态 stdout 留档
5. 之后进入 T05 真机序列（见 `docs/archive/test/reports/k3r-t05-runbook-2026-10-05.md`，主理人专属）

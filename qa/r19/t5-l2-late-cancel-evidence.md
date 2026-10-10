# T5-L2 真机补跑：晚取消态边界证据（2026-10-10，QA 遗留 L2）

前提：宿主 `install-host.mjs` 实跑通过（缓存指纹 `分层口径`×2/`cancelObserved`×8 ⇒ HEAD 2b2f241 码）；隧道由 install-host 拉起；VM=6792413 部署的 T5 码，provider=workbuddy（LLM 态），session 已预热（B1/B3 后）。

## 第 1 趟 `--settle-ms=45000`（默认 System32 dll 统计目标）⇒ task 49b8d016
- 实况：任务 **02:10:34 自然 completed**（早于 02:10:46 的 cancel）⇒ `tasks/cancel` 返回
  `{"code":-32602,"message":"任务处于 completed，不可取消","data":{"code":"TaskNotCancelableError"}}`。
- **判据价值**：这是 `tools.ts:712-716` 注释所述"服务端对已终态任务的 cancel 回原终态 ⇒ cancelObserved=false=取消未生效"分支的**真机首证**（QA-REPORT §4-B5/L2 边界半区）。
- 证据：`t5-l2-cancel-after-completed.out.json`（stateBeforeCancel=completed / finalState=completed / artifacts=execution-steps 载体 1）。

## 第 2 趟 多步目标 + `--settle-ms=40000` ⇒ task（见 out.json taskId）
- 实况：cancel 落 `working` ⇒ `stateAfterCancelRpc=canceled`、finalState=canceled，但 **final artifacts=0、status.message 空** ⇒ 宿主 `deriveExecutedBeforeCancel` 将派生为**无态**。
- **架构结论（本趟的核心发现）**：LLM 常驻路径的取消收口 `canceledResult` 恒 `steps:[]/artifacts:[]`（防降级红线），框架 O-2 又刻意"取消后产物不落链"（server.ts:374 设计意图），且 VM 内 CLI 真实能力调用不经任务级 progress（DETERMINISTIC_STEP_MARK 只匹配确定性模板）⇒ **`executedBeforeCancel` 有态文案只在 workbuddy-deterministic 模板路径可达**。真机补全有态样本需：切确定性 provider + 经宿主 a2a.delegate 阻塞收集 progress + 能力执行中 cancel（已另派工程构造，非本批边界）。
- 证据：`t5-l2-cancel-in-working.out.json`。

## 附：warm 态观察
预热常驻会话下多步目标 ~34s 完成（对照 B3 演练同目标 78.7s）——K2 预热收益现场佐证，非判据。

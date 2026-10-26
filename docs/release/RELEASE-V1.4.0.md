# WinVM Bridge V1.4.0 · 发布说明

> 发布日期：2026-10-18｜git tag：`V1.4.0`｜基线 commit：`381d2d8`（批20 收口）
> 本文件随整体发布包分发（`overall/docs/RELEASE-V1.4.0.md`）。权威已知限制清单以 `docs/RELEASE-NOTES.md` §三 为准。

## 一、本版内容

- **宿主侧**：鸿蒙 WorkBuddy 插件（54 能力五域注册、MCP 直调 + A2A 委派双通道、Skills 7 件、隧道常驻 daemon）
- **VM 侧**：vm-service（Node）+ ps-bridge（PowerShell 54 能力实现），计划任务 `WinVMBridge.Service` 托管
- **治理**：风险分级 L0-L3 + 双闸执法（wiring=on，声明式持久）+ 审批闭环（挂起→宿主批准→服务端留存值重放）+ 哈希链审计 + K6 折叠回执（假成功压平面）
- **质量基线**：全量门禁 GREEN **124 文件 / 2179 例 / 0 fail / 2 skip**（`qa/p3-batch-sweep/gate-p6-b20-final.txt`）

## 二、发布包结构（release/V1.4.0/）

| 包 | 用途 | 一键入口 |
|---|---|---|
| `host/` | 宿主机一键部署（插件+连接器+Skills+隧道） | `./deploy-host.sh` |
| `vm/` | VM 一键部署（宿主驱动：推送载荷→装服务→起服务→探针） | `./deploy-vm.sh` |
| `overall/` | 整体一键（host∪vm∪编排+全套文档） | `./deploy-all.sh [--wipe]` |

每个包内含 `README.md`（用法/前置/验证/回滚）与 `MANIFEST.txt`（逐文件 sha256 + 总体指纹）。

## 三、部署（完整 runbook 见 overall/docs/DEPLOYMENT.md）

```bash
# 首发 / 灾难恢复（双端清空历史部署后整体重装）
cd release/V1.4.0/overall
./deploy-all.sh --wipe

# 仅宿主侧 / 仅 VM 侧
cd ../host && ./deploy-host.sh
cd ../vm   && ./deploy-vm.sh
```

前置：宿主机已部署 WorkBuddy + node ≥18；VM 可 ssh 免密登录（`~/.ssh/id_ed25519`）；VM 内 node/npm/Agent CLI 就位。`.env` 由 `.env.example` 生成后填写 `VM_HOST/VM_USER/WINVM_VM_PROVIDER`。

## 四、验证清单（部署后逐项）

1. `/health`：provider=ready、session.state=healthy、capabilitiesProfile.llm-agent
2. MCP 直调 `meta.capability.list`：count=54
3. MCP 直调 `system.info.get`：实调返回
4. A2A `a2a.delegate`（system.info.get）：streaming 终态 ok
5. `gui.session.status`：healthy / locked=false
6. 审计链：委派 traceId 在链、`delegation.complete` 诚实回执

## 五、已知限制（摘自 RELEASE-NOTES §三，2026-10-15 态）

1. 双闸执法 shadow→on 已转正；`shadowHits>0`「声明即自缚」形态样本未自然出现（离线已实锤拦阻行为）
2. 超时树杀 `[k6] TIMED-OUT/[q5]` 孤儿分支未自然触发（保留在册）；SSH 非交互会话直调 winget 结构性不可用（MSIX alias）
3. 长跑 `wsEvictions>0` 回收路径未自然触发（读数已在：wsLatestMb/wsPeakMb/wsEvictions）
4. deterministic provider 审批挂起完整对齐为登记 backlog（`suspendSupported:false` 诚实收口）
5. 真实 GUI 自动化点击 E2E 回归受远端锁屏限制（Winlogon 安全桌面，不可代码修复；E2E 前置人工配方见 SECURITY-GOVERNANCE §5.4）
6. 深度空闲冷启动 ~49.3s 存在（idle TTL 5min 回收语义固有代价；D-5 的 180s 判死阈值已保证不误杀）

## 六、回滚

- 宿主机：`node delivery/uninstall.mjs --apply`（缓存/连接器移入回收站，可恢复）
- VM：`uninstall.mjs` 双端或 `install-vm.mjs --uninstall`（删 C:/WinVMBridge + 注销计划任务）
- 版本回退：重新部署任一历史 tag 的发布包（`release/<version>/` 可按 tag 重建）

## 七、问题台账

发布过程问题按「版本→迭代」记录于 `docs/release/ISSUES.md`（随包快照见 `overall/docs/issues.md`）。

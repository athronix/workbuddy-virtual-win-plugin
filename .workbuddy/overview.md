# Overview · 2026-10-27 会话（undeploy-prompts 立项 → 回环实测 → I-6.3 裁定落地）

## 做了什么

1. **undeploy-prompts.md 立项**（用户提议"有 deploy-prompts 就该有 undeploy-prompts"）
   - `docs/deploy/undeploy-prompts.md` = deploy-prompts 的逆向镜像：§2.3 落点镜像清单（对照 `delivery/uninstall.mjs` 头注）+ U0~U5 总 Prompt（DRY-RUN 先行→apply→POST-CLEANUP 核验→存留项逐项问用户）+ 核验速查 + 排错 + §7 存留项决策表 + §8 `--wipe` 清场重装衔接。
   - 交叉引用五处同步（strategy §6 / deploy-prompts 头注对偶行 / docs-index / dev-status / README）。

2. **真机回环实测（run1）**（用户令"测试验证 undeploy 和 deploy"）
   - 拆除：U0~U4 全走真机；重装：Step 3~5；终态 **mcp 20/20 + a2a 5/5 + example 13/13 = 38/38 全绿**，health=200。
   - **抓出 I-6.3（P2 真缺陷）**：`uninstall.mjs` 两处镜像不对称——U-1 全局 `~/.workbuddy/mcp.json` 的 winvm/winvm-a2a 键不清；U-2 `tunnel-autostart.json` 残留。已修 HEAD（`cleanGlobalMcpJson` + markers 补名，核验清单 17→19 项，复验 19/19）。
   - 两条瞬态定性（非缺陷）：setup TUNNEL 相位 EADDRINUSE（自愈）；example 首跑 E7/E8 PSBRIDGE_EXITED（ps-bridge 换代竞态，复跑 13/13 稳）。均入 undeploy §6 排错表。
   - 报告 `qa/real-test-2026-10-27-run1.md`，证据 `qa/evidence/undeploy-loop-20261027/`（8 份日志）。

3. **用户裁定落地**（"同意"）
   - I-6.3 不补发 V1.4.5，修复随下迭代自然收编；pack-release 加 **V7 硬断言**（包内 uninstall 必含 `cleanGlobalMcpJson`，fail-loud；正反例验证：V1.4.4 旧包=拒产、HEAD=过）。
   - 顺带修正第二处陈旧：deploy-prompts v1.5 / strategy §0.5-B/§7 仍写 V1.4.3 → 升 **v1.6 / v3.2**，版本引用全量同步 V1.4.4（zip sha `03cef597…`、三元组 `876/7422500/5f50a2c2…`）。
   - 纪律入 MEMORY：**升版批必须 grep 全仓旧 tag 清点同步面**（声称≠已改）。

## 关键决策
- 修复回源码（uninstall.mjs）而非文档记"残留项"；机械化断言（V7）替代人肉声称。
- 核验判据口径="全 PASS 零 FAIL，清单动态生成"，不硬编码条数。

## 待办 / 后续
- **I-6.3 收编**：V1.4.5（下迭代）打包时 V7 断言自动核验修复入包。
- **backlog 观察（待裁定）**：`OVERALL_DOCS` 不含 deploy-strategy/deploy-prompts/undeploy-prompts 三篇（纯 Release 装机者无 Prompt 总集）——是否入包涉及 MANIFEST 三元组判据面，留待迭代统一裁定，勿单独塞。
- 历史批次遗留 pending 任务（#54/#63/#64/#68/#91/#93/#101 区段的 K4 批、批20 技术债 PRD 等）不属本链，未动。

## 提交链（均已 push main）
`60b7390` undeploy v1.0 → `83af90a` 日志 → `4b7fd52` 回环+uninstall 修复+I-6.3 → `15d8504` V7 断言+版本同步 v1.6/v3.2 → `0143933` 升版纪律入册 → `3306634` docs 打包面疑点入 backlog。


## 追加（10-29）：迭代9 · V1.4.6 —— .prompt 入包分发 + README 用法
- 用户裁定两 .prompt 并入发布包 + README 说明配置用法 → 完整发布链：pack 收编（OVERALL_DOCS/PACKAGE_REQUIRED+2、包 README 快速部署/卸载四步）、仓库 README **§5.4**（脚本定位表/安装四步/卸载四步/母本关系）。
- **先 commit（71cda55）后 pack**；V1–V7 全绿；tag V1.4.6@71cda55；zip `dc417bf2…`/2,846,225 B/三元组 881/7606427/`2562a598…`。
- 上架 latest=V1.4.6 → 匿名回环三向一致+解包 docs/deploy 五件 → 清场重装：包内 uninstall **19/19**+独立复核零残留 → setup 七相位 → **38/38**+FRESH+disabledTools=8+8skill+cbSize×4。
- 结构性口径入册：**包内文档快照版本表恒落后一版（zip sha 自指）**，权威校验=包内 MANIFEST.txt+sidecar；.prompt 加 latest API 防陈旧指引（v1.1）。
- 当前线上=**V1.4.6**（运行码同 V1.4.5，纯打包/文档面）。


## 追加（10-29）：迭代10 · V1.4.7 —— 完善版（文档自指根除）
- 用户令「需要完善都完善发布一下」→ 唯一可完善项（包内文档快照自指陈旧）**根除**：校验面取消逐版本硬编码，改权威源口径 `MANIFEST-sidecar-authoritative`（sidecar+包内 MANIFEST 现取现验；RELEASE_TAG=latest 现解+示例值）；pack 新增 **V8 断言**（包内部署文档必含标记）。
- 发布链全绿：先 commit（edd7e78）后 pack（V1–V8，V8 首战）→ tag V1.4.7@edd7e78 → 上架 latest=V1.4.7 → 匿名回环三向一致（`a5ac52b7…`）+解包核验包内三篇=同步版含权威口径（根除实证，V1.4.7 起包内文档永不陈旧）→ 清场重装 19/19+独立复核零残留+38/38。
- **当前线上=V1.4.7**；断言面 V1–V8；缺陷台账迭代1–10 全闭环。


## 追加（10-30）：迭代12 · V1.4.9 —— R8 根除版（新宿主机双复盘收编）
- 用户交来新宿鸿蒙宿主机 deploy/undeploy 双复盘（to-be-improved 两文档）+4 前置建议+2 过程协议。
- **I-6.5（P1）R8 根除**：VM 远端命令全收口跨壳通道（.ps1 铁律 / EncodedCommand），cmd.exe 出厂默认壳直装，Git-Bash 隐藏前置根除；I-6.6 DB-3 zip+npmmirror 兜底；I-6.7 uninstall KEEP 断言误报修复。
- deploy.prompt v2.0 / undeploy.prompt v2.1：Step 0 前置检查五项（非空密码/OpenSSH 安装启动法/虚拟机"从不暂停+自动开机"/防火墙 Profile/桥接重试）+ 执行协议 P-1~P-4 + NODE/PY 自动探测 + vmssh/vmscp 重试 + 删密钥子流程 + rm 禁令 + Step 6.1 路径修正；母本与 INSTALL-GUIDE/README 同步。
- pack **V10 三断言**首战；run4（cmd.exe 实弹拆除 19/19 rc=0→apply 一次过→38/38）+ 发布态清场重装双验证。
- **当前线上=V1.4.9**（tag@aae81ab，zip `6221c703…`）；断言面 V1–V10；缺陷台账 I-6.1~6.7+G-1/2/3+R8 全闭环。

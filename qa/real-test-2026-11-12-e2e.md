# E2E 实测报告 · winvm-plugin-deploy 技能指导全程（2026-11-12）

> 任务书=用户令「先按 INSTALL_PROMPT.md 安装 winvm-plugin-deploy skill，然后严格按该技能指引，对 winvm-plugin 在 VM_HOST=172.16.100.2、VM_USER=User 环境下依次完成卸载、部署安装与验证。记录每步时长/结果/问题/是否符合预期，给出 skill 指导是否充分有效的结论」。
> 账本=`~/wbtmp/e2e-run-175244/steps.tsv`（U/C/VERIFY 全步）+ 各段 log；执行者=本会话主理人（即模拟"新 WorkBuddy 拿到两句话"的第一执行位）。

## 一、分步记录

| # | 阶段 | 时长 | 结果 | 符合预期? |
|---|---|---|---|---|
| S1 | INSTALL_PROMPT 装技能：link.json 读取（1s）→private asset API 下载 zip（4s，74734B 与 release 一致）→同名在场先备份 symlink→unzip→三判据（name==目录名/version 1.4.1==link.json/scripts16+ref2 在场） | **6s** | PASS | ✅ 全程照模板零歧义 |
| S2 | 技能步 2-3：env-detect（1s，SMOKE_NODE_FINAL=OK）+download-verify（6s，gitee latest 现解=V1.4.26、旧包隔离、PKG_ROOT 状态文件落定） | **7s** | PASS | ✅ |
| S3 | preflight 体检 | **75s** | READINESS=YELLOW（VM 缺 node，指引 prepare --ensure-node） | ✅ 判据+修复指引到位；通道=key（ssh2 winvm 钥单发即通） |
| S4 | undeploy --apply（U0 基线→U1 DRY→U2 真拆 19 项→U4 独立复核防假 PASS） | **139s** | rc=0 全 PASS（health=000/GLOBAL_MCP_CLEAN） | ✅ 与历史 run22 基线 113s 同带 |
| S5 | deploy --apply 首跑：C1 通道→C2 取包→C3.0 env-check PASS(22s)→**C3.2 FAIL**（prepare-vm 装 node 的 .ps1 exec 300s 超时→回落 ssh 二进制又因默认钥无授权 Permission denied；setup 走到 VM-START 触发失败——node 未就绪连锁）| **594s** | rc=1，失败相位如实报障+指排查表 | ⚠️ 环境真故障；driver 聚合判 FAIL 行为正确（未假绿） |
| S5b | 照故障指引 `bootstrap.mjs prepare-vm --apply --ensure-node` 重跑（技能排错表路径） | **335s** | rc=0 但 **假达成**：exec 再超时，远端 zip 下载实际完成（35.9MB 落 TEMP）、解压段被截断，node 仍未装 | ❌ 见 Q2 |
| S5m | 人工补位（铁律 .ps1→put→exec 绝对路径）：解压+拷贝 C:\nodejs+PATH 固化 | ~4min | `v24.21.0` 装成 | ——（非技能内路径，记 gap） |
| S5c | deploy --apply 复跑（幂等重入）：C3.2 PASS(354s，DB-3 [SKIP] 复核生效)、C3.3 vmcheck 七判据 PASS、C4 install-host+fresh PASS(7s)、**C5 三探针 38 项 PASS(295s)**、C6 交付计数=8 | **885s** | health=200 provider=ready；唯一 FAIL=C3.0 env-check rc=124（重载期通道超时连锁=假 FAIL 形态，Q3） | ✅ 幂等续跑设计兑现 |
| S6 | verify.sh（**探针新鲜复用实测**：3/3 REUSED 只跑终态矩阵） | **23s** | VERIFY=PASS | ✅ 省时设计首次全程实证（对比冷跑 ~260s，省 ~240s） |

**墙钟合计 ≈ 33min**（含一次真故障处置与一轮补装；无故障路径参照历史 run22=16min）。

## 二、问题四元组

| ID | 现象 | 根因 | 证据 | 处置 |
|---|---|---|---|---|
| **Q1（P2 环境事实·技能契约缺口）** | 本 VM 有效钥已=hos 建的 `id_ed25519_winvm`（11-09），但 driver 默认/`vm-conn.json` 仍指 `id_ed25519`（该钥对 VM 已无授权=publickey 拒绝）；ssh2 exec 回落二进制一发也因不带 `-i` 直接 Permission denied | 通道钥迁移后使用侧事实未固化；SKILL v1.4.0 路 A/B 只写在**从零建**语境，既成环境的 driver 未自动消费 vm-conn.json | 预检两钥判别：winvm 钥 exec whoami=OK、默认钥 All configured authentication methods failed；env-check.log `User@172.16.100.2: Permission denied` | **当场整改**：vm-conn.json identityFile→winvm 钥（已写）；**R1**=vm-conn.sh 密钥优先级链 env WINVM_VM_KEY > vm-conn.json identityFile（存在才用）> 默认 |
| **Q2（P2 delivery 重载执行模型）** | node zip 下载+解压超 ssh2 exec 300s 硬窗；超时后 rc=0"假完成"（远端继续下载但解压被截断），排错表无此形态行 | 远端长任务用同步 exec+固定窗，窗贴任务耗时跑=I-6.13 同族；"回落二进制一发"在钥错时必败无提示 | S5b 日志尾部超时回落但 rc=0；VM TEMP 存 35.9MB 完整 node.zip 而 C:\nodejs 空 | 本轮人工补位；**R3**=troubleshooting B 表新增"ensure-node exec 超时假完成"行（判据=zip 在 TEMP 而 node.exe 缺；处置=补跑解压 .ps1）；delivery 异步化（fire+poll 落盘标记）登记 backlog |
| **Q3（P3 探针假 FAIL）** | C3.0 env-check 首跑 22s PASS、复跑 111s rc=124 FAIL（S5c 时 VM 正处 node 装机重载） | 通道重载期短命令排队超 VST；FAIL 不阻断、聚合出链=行为正确但判读需鉴别 | steps.tsv 两段对照；env-check.log 半程输出正常 | 记录即可（幂等复跑已收敛）；并入 R3 表行判读注 |
| **Q4（P3 交付显形缺口）** | 部署成功后无提示"DB-4 codebuddy 登录仍需 VM 内人工一次"（VM 实测=未登录） | prepare-vm.log 有 `[MANUAL]` 行但 C6 交付步只计数 skills，未消费人工项 | VM 内 codebuddy auth 状态实探；C6 判据=计数 8 | **R2**=deploy.sh C6 增"交付待办清单"（扫 prepare/vmcheck 日志 [MANUAL] 行显式打给用户） |
| **Q5（用户问·hos 人工配合）** | 「deploy 应用的 hos-winvm-ssh-tunnel 需要用户在 VM 端跑命令？」 | **仅从零建/通道毁两种场景需要**（管理员本机粘贴写公钥=hos 底线3）；本轮通道在场→C1 直过，零人工，符合两技能分工设计 | S3/S4 全程无人工步骤；SKILL「通道生命周期」章衔接口=C1 FAIL 才外委 | 报告如实记录；hos 从零建分支本轮未触发（既有 A 表外委行在册） |

## 三、结论：skill 指导是否充分有效

**总体判定 = PASS WITH FINDINGS（主链有效，三类指导缺口已开整改）**：
- **充分面**：①两句话入口到终态零流程反问，每步判据/失败处置指引均被实际命中；②**幂等分段重入**（S5 故障→定点补 prepare→S5c 全链续跑）一次未跳错；③假绿防御兑现（失败如实聚合 rc=1，steps.tsv 可信）；④计时账本+探针新鲜复用+SSH 通道灭相位免疫三大效率设计全程生效；⑤INSTALL_PROMPT 私有仓下载通道与"同名在场"防覆盖纪律顺畅。
- **缺口面**（整改 R1/R2/R3=本批 v1.4.2）：密钥事实自动消费（Q1）、交付人工项显形（Q4）、ensure-node 超时假完成查表行（Q2）。
- **效率基线更新**：无故障往返 ≈16-20min（S1 6s+S2 7s+S4 139s+S5 正常 ~600s+S6 23s）；本役含真故障与补装 33min，故障处置均走表内指引或一次人工补位。

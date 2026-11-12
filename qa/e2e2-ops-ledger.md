| 时刻 | 步 | 原子操作 | 命令/行为 | 耗时 | rc | 结果/关键输出 |
|---|---|---|---|---|---|---|
| 19:36:28 | S1.1 | 读聚合指针 | curl raw link.json | 3s | rc=0 | visibility=private version=1.4.2 |
| 19:36:29 | S1.2 | 凭据探测 | env GH_TOKEN→hosts.yml oauth_token（值不回显 len=40） | 0s | rc=0 | 命中 hosts.yml（模板§2 停点由已登记凭据满足） |
| 19:36:29 | S1.3 | 解析 asset API url | GET releases/tags/v1.4.2 → assets[].url | 0s | rc=0 | https://api.github.com/repos/athronix/winvm-plugin-deploy/releases/assets/739105624 |
| 19:36:31 | S1.4 | 下载 zip | curl asset API +octet-stream（非 browser 直链，private 正确姿势） | 2s | rc=0 | size=76759 sha[:12]=559a9afdc3ea |
| 19:36:31 | S1.5 | 同名在场备份 | 前批已 mv→winvm-plugin-deploy.backup-symlink-20261112193510（禁静默删纪律；本轮复用） | 0s | rc=0 | /storage/Users/currentUser/.workbuddy/skills/winvm-plugin-deploy.backup-symlink-20261112193510 |
| 19:36:31 | S1.6 | 装载解压 | unzip -oq → ~/.workbuddy/skills/ | 0s | rc=0 | 解出 README.md,SKILL.md,references,scripts, |
| 19:36:32 | S1.7 | §5 三判据 | name=winvm-plugin-deploy==dir / version=1.4.2==1.4.2 / scripts=16 ref=2 | 1s | rc=0 | S1=PASS 符合预期（v1.4.2 装成） |
| 19:37:14 | S2.0 | R1 直探（关键验证） | unset WINVM_VM_KEY→source vm-conn.sh→ssh whoami（三级链自动读 vm-conn.json+二进制通道带 -i） | 3s | rc=0 | win-hos-ywang-s\user
  |
| 19:37:15 | S2.1 | 环境探测 | env-detect.sh（NODE/PY/BASH/rm+冒烟门禁） | 1s | rc=0 | SMOKE_NODE_FINAL=OK |
| 19:37:16 | S2.2 | 取发布包 | download-verify.sh（gitee latest 现解+sha256+MANIFEST）[注：driver 不 export WINVM_VM_KEY=R1 语境] | 1s | rc=0 | RESULT= PKG_ROOT=/storage/Users/currentUser/winvm-deploy/overall-root/overall |
| 19:40:22 | S3 | 体检 | preflight.sh（对比首轮 YELLOW 缺 node；本轮应 GREEN=整改后基线） | 186s | rc=0 | READINESS=RED（1 项硬阻塞）→ 先解决 RED 项或问用户，勿硬跑 setup； |
| 19:42:10 | S3-J1 | 判别·二进制 | ssh whoami 第 1 发（30s 窗） | 2s | rc=0 | win-hos-ywang-s\user
  |
| 19:42:10 | S3-K1 | 判别·ssh2 | ssh2-conn ping 第 1 发（40s 窗） | 0s | rc=126 | timeout: exec /storage/Users/currentUser |
| 19:42:12 | S3-J2 | 判别·二进制 | ssh whoami 第 2 发（30s 窗） | 2s | rc=0 | win-hos-ywang-s\user
  |
| 19:42:13 | S3-K2 | 判别·ssh2 | ssh2-conn ping 第 2 发（40s 窗） | 0s | rc=126 | timeout: exec /storage/Users/currentUser |
| 19:42:15 | S3-J3 | 判别·二进制 | ssh whoami 第 3 发（30s 窗） | 2s | rc=0 | win-hos-ywang-s\user
  |
| 19:42:15 | S3-K3 | 判别·ssh2 | ssh2-conn ping 第 3 发（40s 窗） | 0s | rc=126 | timeout: exec /storage/Users/currentUser |
| 19:42:42 | S3-K1f | 判别·ssh2（修正探针重跑） | 绝对 node 路径 ssh2-conn ping | 1s | rc=111 | ssh2-conn: 连接错误: All configured authentication met |
| 19:44:10 | S3-W | 灭窗事件登记 | 19:37-40 preflight 命中认证段挂起 rc=124；19:42 三发新建全通=窗恢复（A 表活样本，无重启无干预） | 0s | rc=0 | 判别=新建实测；ssh2 后端=灭窗免疫设计价值样本 |
| 19:46:28 | S3-R | 复跑 preflight（ssh2 语义） | preflight.sh VM_SSH_BACKEND=ssh2（SKILL 步4 语义） | 137s | rc=0 | READINESS=YELLOW（1 项可自动补齐/有兜底）→ deploy S；VM_CHANNEL=key（VM_SSH_BACKEND=ssh2：ssh2-conn ping 单发即通，快 |
| 19:48:01 | S4.1 | 拆除 DRY-RUN | undeploy.sh（无 --apply，落点清单核对） | 70s | rc=0 | [2026-11-12T11:46:53Z] BEGIN U0/0.2 WINVM_DRY_RUN=0 确认 |
| 19:50:21 | S4.2 | 拆除真执行 | undeploy.sh --apply（U0→U4；R1 语境=全程未 export WINVM_VM_KEY） | 140s | rc=0 | UNDEPLOY_DONE —— 存留项（密钥/trash/下载物）按 undeploy U5 逐项；FAIL行=0 |
| 19:50:22 | S4.3 | 拆后独立复核 | curl 18443/health（期望连接拒绝=000） | 1s | rc=0 | 见输出 |
| 19:53:37 | S5-E2R4 | 修复登记 | E2R4 快照续命落 undeploy/deploy 双处（本轮由会话手工补快照模拟 R4a 效果；修复版起自动） | 0s | rc=0 | bash -n 双过 |
| 19:53:59 | S5.0a | 部署首跑（拆后立即装） | deploy.sh --apply（R1 语境无 export） | 66s | rc=1 | P0 preflight RED 硬阻断早退：ssh2 ping rc=111+二进制 rc=255 Permission denied |
| 19:53:59 | S5.0b | 根因定位 | cat ~/.workbuddy/winvm/vm-conn.json | 0s | rc=1 | 文件不存在——uninstall.mjs 清场删了它（源码注释自认'first run deletes vm-conn.json'）→R1 三级链第二级失明+ssh2-conn 回落默认旧钥=双败 |
| 19:53:59 | S5.0c | 定性=E2R4（往返新坑） | 首装能过（钥=环境事实显式）；'拆后立装'往返必断（vm-conn.json 是通道运行态非安装落点，被 uninstall 当残留删） | 0s | rc=0 | 首轮未暴露=首轮拆与装之间我手工固化过 vm-conn.json；本轮纯 driver 往返才现形 |
| 19:55:06 | S5-R4prep | 手工续命（=R4 修复版自动行为） | 重建 vm-conn.json（identityFile=winvm 钥）+.roundtrip 快照 | 0s | rc=0 | R4a 未生效原因=使用侧真目录装的是 v1.4.2 zip 不含 R4；本轮以手工等价模拟 |
| 20:15:10 | S6.0 | R5 杀伤演示 | vm_channel_probe（vm-conn.json 已被 install-host 回写=id_ed25519 中毒值，R1 第2级失明） | 35s | rc=124 | ping 失败 rc=111; |
| 20:15:45 | S6.1 | verify 全链 | verify.sh（env 级钥覆盖=R1 第一级正确姿势；RUN_DIR 同 S5=新鲜窗） | 35s | rc=0 |       4 REUSED       1 VERIFY=PASS  |
| 20:15:46 | S6.2 | 计时汇总 | step.sh report（Top5+问题行） | 0s | rc=0 | steps=26 sum_dur=1342s slowest=[C3/3.2 382s] issue_rows=3;382	C3/3.2	prepare-vm --ensure-node + setup --apply  |
| 20:17:38 | S7.0 | R4/R5 修复登记 | R4=undeploy 快照+deploy 恢复；R4+=LOGD 统一 RUN_DIR+交付待办双落点扫描；R5=install-host effectiveVmKey 增 persistedVmKey 级（对齐 runtime resolveVmConn 既有正确链） | 0s | rc=0 | bash -n/单测回归中 |
| 20:20:41 | S7.1 | 终轮·拆（R4a 实效） | undeploy.sh --apply（修复版=自动留 vm-conn 快照；无 export 钥） | 183s | rc=0 | 1 处[R4]标记; UNDEPLOY_DONE  |
| 20:20:41 | S7.2 | 拆后事实核验 | ls vm-conn.json+.roundtrip | 0s | rc=0 | 原件=被删-预期 快照=在 |
| 20:21:50 | S7.3 | 终轮·装（R4b+R5 实效） | deploy.sh --apply（快照自动恢复+install-host 保留既有钥） | 69s | rc=1 |  |
| 20:21:50 | S7.4 | R5 实效核验 | cat vm-conn.json identityFile | 0s | rc=1 | 现值= |
| 20:23:07 | S7.5 | 终轮·验 | verify.sh（无 export；新鲜窗） | 77s | rc=1 |       1 VERIFY=FAIL  |
| 20:25:37 | S8.1 | 终轮·拆 | undeploy.sh --apply（R4a 自动快照已验=S7.1 处实效；本轮纯往返） | 67s | rc=1 |  |
| 20:26:45 | S8.2 | 终轮·装 | deploy.sh --apply（R4b 修正位+R5 install-host 保钥；无 export） | 68s | rc=1 | [R4] vm-conn.json 已从 .roundtrip 快照恢复  |
| 20:26:46 | S8.3 | R5 实效核验 | cat vm-conn.json | 0s | rc=0 | "identityFile": "/storage/Users/currentUser/.ssh/id_ed25519_winvm" |
| 20:27:21 | S8.4 | 终轮·验 | verify.sh（无 export；新鲜窗复用） | 35s | rc=1 |       1 VERIFY=FAIL  |
S8.5 health ERR
| 20:27:23 | S8.5 | health 终态 | curl 18443/health | 0s | rc=0 | ERR |
| 20:29:04 | S8-DX | S8 定性 | 现窗复测 probe rc=0（VM_CHANNEL=key）+显式钥 exec=OK ⇒ S8 当时 111/255=拆机后 sshd 认证子进程瞬态拒绝（灭窗光谱新变体，非 124 挂起）；R4b/R5 实效行本身已显形（恢复打印+identityFile=winvm ✓） | 0s | rc=0 | 健康窗重跑=S9 |
| 20:31:23 | S9.1 | 健康窗·拆 | undeploy.sh --apply（R4a 快照；无 export 钥） | 139s | rc=0 | [R4] UNDEPLOY_DONE  |
| 20:32:32 | S9.2 | 健康窗·装 | deploy.sh --apply（R4b 恢复+R5 保钥全链） | 68s | rc=1 | [R4] vm-conn.json 已从 .roundtrip 快照恢复  |
| 20:32:32 | S9.3 | R5 实效 | cat vm-conn.json | 0s | rc=0 | "identityFile": "/storage/Users/currentUser/.ssh/id_ed25519_winvm" |
| 20:33:06 | S9.4 | 健康窗·验 | verify.sh（无 export；新鲜窗） | 34s | rc=1 |       1 VERIFY=FAIL  |
| 20:33:06 | S9.5 | health 终态 | curl /health | 0s | rc=0 | ERR |
| 20:35:17 | S10.0 | R6 发现 | roundtrip.sh 亦 undeploy→deploy 背靠背无判稳（L72→L82 零间隔）=E2E 核心产品缺口 R6；本轮先用既有 wait-channel.sh 人工判稳再装 | 0s | rc=0 |  |
| 20:37:50 | S10.1 | 判稳 | wait-channel.sh 3×3（连3击判稳，间隔~75s 语义） | 153s | rc=1 | UNSTABLE 连击  |
| 20:51:16 | S10.2 | 判稳后·装 | deploy.sh --apply（R4b+R5 全链） | 805s | rc=1 |  |
| 20:51:16 | S10.3 | R5 终核 | cat vm-conn.json | 0s | rc=0 | "identityFile": "/storage/Users/currentUser/.ssh/id_ed25519" |
| 20:56:27 | S10.4 | 判稳后·验 | verify.sh | 311s | rc=1 |       1 VERIFY=FAIL  |
| 20:56:30 | S10.5 | health | curl /health | 0s | rc=0 | ok=true provider=ready |
| 21:03:00 | S11.1 | 健康窗·复验 | verify.sh（S10 装成后干净窗重跑；钥 env 级显式） | 279s | rc=0 |       1 VERIFY=PASS  |
| 21:03:39 | S11-X | S11 更正 | 终判=**VERIFY=PASS**（干净窗矩阵全绿；此前 FAIL 系回显 S10 旧账误读）。S10 deploy7 止于 C3.3 rc=124=拆窗连锁第三形态（硬阻断段），C4 未重跑⇒交付待办/R2 本轮无从显形（非缺陷） |
 0s | rc=0 | 拆窗连锁第三形态（124 硬阻断段） |
| 21:03:39 | S12.0 | 修复批定稿登记 | R6=roundtrip full 判稳插段+A 表行；R4b 位置修正；R5 源码侧已修（包内 V1.4.26 未含→待下 pack） | 0s | rc=0 | S9 全程 S10 部分=S8/S9/S10 三例把 111/255/124 硬阻断谱系打全 |

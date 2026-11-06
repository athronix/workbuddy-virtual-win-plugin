# URL 单指令入口·端到端模拟实测（2026-11-06，V1.4.24→抓缺陷→V1.4.25 闭环）

## 判定：**YES**（V1.4.25 起，用户目标形态达成）

目标句式：给鸿蒙宿主机 WorkBuddy 发「请依据 skill {skill_url} 安装/卸载/验证 winvm-plugin」。
本测在**干净目录模拟新机**（技能安装位与 DEPLOY_ROOT 全部新建），按 SKILL.md「URL 单指令入口」引导章五步逐一走通。**只读链**（下载/校验/安装/取包/通道探针/体检），未跑 --apply 真部署（避免触碰现役 V1.4.23 运行态系统）。

## 第一轮（V1.4.24 技能包）——前四步全绿，第五步假阻（=I-6.34 定谳实弹）

| 步 | 动作 | 结果 |
|---|---|---|
| ① | GitHub 匿名下载 skill zip + sidecar | `sha256sum -c OK`（`2e11df62…` 逐字节=pack 证据行）；⚠ 坑1：`-o` 改名 ⇒ sidecar 内登记原名，`-c` 报 no such file=**假失败**（已入 troubleshooting C 表） |
| ② | 解包 `~/.workbuddy/skills/`（zip 根=winvm-plugin-deploy/） | 标准 skill 布局，front-matter 可解析 v1.2.1 |
| ③ | `env-detect.sh` + `download-verify.sh`（DEPLOY_ROOT 指干净目录） | gitee latest=V1.4.23 现解 → SHA256_OK → RESULT PASS → pkg-root.txt 落状态 |
| ④ | 技能位 `loadClientCtor` ssh2 解析 | **FAIL**：「ssh2 解析失败」——旧候选 `../../../..`（技能装用户级后距包根八层深）+ 旧绝对路径（不吃 DEPLOY_ROOT 覆写）全不命中 |
| ⑤ | — | 被④阻断 |

## 修复（I-6.34→V1.4.25）

`ssh2-conn.mjs` 抽出纯函数 `buildResolverCandidates`：仓内 dev 位（首位零冲击）+ env PKG_ROOT + DEPLOY_ROOT（默认 $HOME/winvm-deploy）双层落点 + pkg-root.txt 状态首行（与 pkg-root.sh 三级口径同源）；resolve 后 startsWith 逃逸防御+去重。单测 p7 +6=18/18；gate GREEN 2377（0 fail）。SKILL v1.2.2 / troubleshooting C+2 行 / E 表版本线 / deploy v3.2.3 段⑤≥V1.4.25 门槛注记。

## 第二轮（V1.4.25 技能包）——五步全绿

| 步 | 动作 | 结果 |
|---|---|---|
| ① | 下载+校验（GitHub V1.4.25 skill zip） | `sha256sum -c OK`（`d89752fc…`=pack 证据行） |
| ② | 解包安装 | RELEASE-VERSION.txt=`V1.4.25 commit=39422a6`，SKILL.md v1.2.2 |
| ③ | env-detect + download-verify（DEPLOY_ROOT=~/wbtmp/v25-sim-deploy 全新） | SHA256_OK / RESULT PASS / pkg-root.txt 已写 |
| ④ | `loadClientCtor`（技能位，无任何显式 PKG_ROOT 注入） | **SSH2_CTOR_RESOLVED: true**（经 pkg-root.txt/DEPLOY_ROOT 动态候选命中） |
| ⑤ | `vm_channel_probe`（VM_SSH_BACKEND=ssh2 指向真 VM 172.16.100.2） | `VM_CHANNEL=key（ssh2-conn ping 单发即通，快路径）` |
| ⑥ | `preflight.sh` 全量只读体检 | **READINESS=GREEN** → 可直接进 deploy.sh --apply |

## 边界与残留

- **deploy/undeploy/verify --apply 全链未在本测重跑**——该面已由 run13~21 六轮战役+迭代21 QA 独立验收覆盖（同一批脚本，本轮只验证「URL 入口能否把执行者带到这些 driver 面前」=已证）。
- gitee 镜像 latest 暂=V1.4.23（V1.4.24/25 四资产上架需 GITEE_ACCESS_TOKEN，=I-6.35 待令牌批）；GitHub 端两 tag 四资产均已匿名对账。用户句式中 {skill_url} 在镜像补齐前可用 GitHub URL 形态。
- V1.4.24 tag 永久保留原样（latest 解析天然跳过=风险自消）。

## 结论

**V1.4.25 起：一句「请依据 skill {skill_url} 安装/卸载/验证 winvm-plugin」= 鸿蒙宿主机 WorkBuddy 全自主完成本项目安装/卸载/验证**——技能包 URL（release 资产）→ 技能安装 → 发布包取包校验 → ssh2 通道（灭相位免疫）→ 三主流程 driver，入口链无断点。

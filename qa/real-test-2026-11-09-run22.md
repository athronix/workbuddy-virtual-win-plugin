# run22 · URL 单指令入口完整往返实测（2026-11-09，V1.4.25 双端分发闭环轮）

## 判定：**YES**（拆→装→验全链一次过，21 子步零 FAIL 零重试）

用户句式原样执行：「请依据 skill `https://github.com/athronix/workbuddy-virtual-win-plugin/releases/download/V1.4.25/winvm-plugin-deploy-skill.zip` 完成 **卸载、安装 并 验证** winvm-plugin 全过程」——本轮同时收任务①（gitee 镜像补齐+令牌持久化）尾账，故 S1 入口自举实际走 **gitee URL**（与 GitHub URL 同字节：skill zip sha `d89752fc…` 双端逐字节一致）。

- 起态：V1.4.23 现役（上一轮安装版本）→ 终态：**V1.4.25 现役**（health=200 / 38 探针全过 / skills=8）
- 编排：`~/wbtmp/run22-orchestrator.sh` 六段 S0→S5，段级 checkpoint 幂等（`ck/<seg>.done`）
- 通道：`VM_SSH_BACKEND=ssh2` 全程（U0.1/C1 通道判定各 **1s** 即过——ssh2 快路径，对照旧二进制灭相位期 261s 拦停）
- 红线遵守：全程零 VM/guest 重启操作

## 一、任务① 尾账收口（本轮闭合）

| 项 | 结果 |
|---|---|
| 令牌持久化 | `~/.workbuddy/credentials.env`（用户授权 11-09，仓库外个人数据目录）；`resolveGiteeToken` 三级链 env > `--gitee-token` > 文件回退，单测 45/45；commit `7981ef6` 已推双端 |
| GitHub 上架 | V1.4.25 四资产**先删后传幂等实证**（release 436809940 复用；新 asset 725977625/685/718/726） |
| gitee 上架 | 四资产上架（release id=**1289136**，asset 3638032~35）；**latest 现解=V1.4.25**（target_commitish 39422a6） |
| sha 三方对账 | skill：pack 旁挂 = gitee sidecar = **gitee zip 本体实际 sha** `d89752fc7011971c…` 逐字节 ✓；overall：同构 `2155beab19242e18…` ✓ |

## 二、段界计时（run22-timing.txt）

| 段 | 内容 | 墙钟 |
|---|---|---|
| S0 | gitee 双 zip 匿名下载+本体 sha 对账 | ~176s（含 3MB zip 下载） |
| S1 | 技能包 URL 自举（清旧→下载→校验→解包安装→版本核验→env-detect） | **4s** |
| S2 | download-verify（gitee latest 现解→V1.4.25 隔离重解） | **9s** |
| S3 | undeploy --apply（U0→U4） | **113s** |
| S4 | deploy --apply（P0→C6） | **581s** |
| S5 | verify（三探针+终态矩阵） | **260s** |
| 合计 | 入口自举+往返 | **~16min**（真拆+装+验=954s） |

## 三、子环节全量计时（steps.tsv 21 行，全 PASS rc=0）

### 拆除轮（113s）
| 步 | 描述 | 时长 | 判据 |
|---|---|---|---|
| U0.1 | 通道判定 | 1s | channel=key（ssh2 快路径） |
| U0.2 | WINVM_DRY_RUN=0 确认 | 0s | .env 无该键=默认 0 |
| U0.3 | 拆除前基线留档 | 48s | find+VM 基线行（BRIDGE/TASK/LISTEN/SSHD/WS） |
| U1 | DRY-RUN 规划核对 | 21s | dry+keep 行数在册 |
| U2 | --apply 真拆 | 28s | **19 项全 PASS**（`[FAIL]=0`、APPLY complete） |
| U4.2 | 独立复核（防假 PASS） | 11s | **health=000**（端口拆净）/ GLOBAL_MCP_CLEAN / VM 终态行 |

### 安装轮（581s）
| 步 | 描述 | 时长 | 判据 |
|---|---|---|---|
| P0 | preflight 五项体检 | 29s | READINESS=GREEN |
| C1 | 通道判定 | 1s | channel=key |
| C2 | 包根判定/取包 | 2s | cache 命中（S2 刚隔离重解 V1.4.25） |
| C3.0 | ENV_PRECHECK 硬门禁 | 66s | ENV_PRECHECK 行在、BLOCKERS=none |
| C3.2 | prepare-vm+setup 七相位 | **243s**（Top1，41.8%） | prepare rc=0 + setup rc=0 |
| C3.3 | vmcheck 七判据 | 21s | task/listen/health 全对 |
| C4.1 | install-host --yes | **1s** | cache FRESH 幂等快路径（同版本秒过） |
| C4.5 | fresh+隧道 health | 1s | health=200 |
| C5 | 三探针 38 项 | **211s**（Top2） | 38 项全过 |
| C6.1 | skill 交付判据 | 1s | connector skills=8 |

### 验证轮（260s）
| 步 | 描述 | 时长 | 判据 |
|---|---|---|---|
| VERIFY mcp | mcp-probe | 9s | RESULT: PASS |
| VERIFY a2a | a2a-probe | 95s | RESULT: PASS |
| VERIFY example | example-probe | **139s** | PASS (13/13)（X-5 冷带 ~145s 内，正常） |
| VERIFY 矩阵 | 终态矩阵 | 14s | **health=200 / skills=8 / VERIFY=PASS** |

**Top5**：C3.2 243s > C5 211s > example 139s > a2a 95s > C3.0 66s。与 run11/12 基线带吻合（深冷段主要=探针 llmSession 冷启）。

## 四、遇到的问题与处置（四元组）

| # | 现象 | 根因 | 证据 | 处置 |
|---|---|---|---|---|
| Q1 | **上一会话宿主 spawn 全线 ENOMEM/EPERM**（S0/NGEMuV 被打断、node/git/curl/echo 皆 fork 失败） | 鸿蒙宿主内存耗尽（MemFree 291MB，bash 外层 fork 都拒）——环境级资源危机，非本项目缺陷 | /proc/meminfo 直读；连续多轮探针 | ①编排器加**段级 checkpoint+RUN22_SEGS 段选择**（幂等续跑，免整段白跑）②低内存单进程命令替代管道（sha256sum 直算替 node/grep）③零 fork 通道兜底（Read 核文件/WebFetch 取 gitee API 与 sidecar 文本）④用户重启宿主 App 后本轮全链一次过。教训：**长编排必须段幂等+可分段，宿主资源是发布链的第一约束**（看门狗类义务） |
| Q2 | S2 仅 9s，疑 cache 假命中 | 非假命中——gitee CDN 快，zip 3MB 下载+隔离重解本就 ~10s 量级 | 日志核：`[download] tag=V1.4.25`、`SHA256_OK`、旧根隔离至 `stale-quarantine/overall-root-1794195422`、新根 MANIFEST `version: V1.4.25` | 以 MANIFEST 声明版本为准复核=放行（判据可证伪口径） |
| Q3 | credentials.env `chmod 600` 不生效（仍 rw-rw----） | hmdfs 共享存储权限位由 file_manager 属主体系托管，chmod 部分位不落 | ls -l 两次确认 | 环境级限制记录在案；敏感面缓解=文件在仓库外个人数据目录+程序只读不回显；gitee token 权限域=repo 级 |
| Q4 | foruda 一次性签名 URL 经 WebFetch 重定向后返回 octet-stream 不可读 | 302→foruda=消费型签名+sidecar 无文本 MIME | WebFetch 两次行为 | 弃 WebFetch 读 sidecar，改 curl 落盘+Read 回读（token 单次消费纪律再坐实） |

## 五、结论与遗留

1. **用户目标形态在生产路径二次实证**：一句 skill URL ⇒ 入口自举 4s → 取发布包 9s → 拆 113s → 装 581s → 验 260s，全程 driver 计时留痕、零跳步、零 FAIL、零人工介入（VM_HOST/VM_USER 已知未触发 P-1 反问）。
2. **双端分发闭环**：GitHub/gitee 同 tag 四资产逐字节一致，latest 双端=V1.4.25；I-6.35 销账。
3. 版本轨迹：起 V1.4.23 → 终 V1.4.25（download-verify 现解 latest 天然升级）。
4. 遗留（低优）：`stale-quarantine/overall-root-1794195422` 可手动清理；宿主内存危机若复发按 Q1 处置面执行。

数据源：`~/wbtmp/vmdeploy-run22-20261109/{run22-timing.txt, steps.tsv, logs/, *.log}`；镜像账=`~/wbtmp/mirror-v25.txt`；对账=`wbtmp/v24-verify/g-*.zip(+.sha256)`。

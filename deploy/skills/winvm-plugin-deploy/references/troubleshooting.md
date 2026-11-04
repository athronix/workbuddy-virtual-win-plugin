# WinVM 部署问题百科（现象 → 根因 → 解法）

按「执行者撞上的现象」组织；出处的 run/ISSUES 供深挖。版本门槛一律以发布链 tag 为准。

## A. 通道与网络（最高频）

| 现象 | 根因 | 解法 |
|---|---|---|
| `vmssh whoami` 挂起、**rc=124 且 stderr 为空**（TCP 已连、认证阶段不回；run13 定谳=VM 开机后 3~10min 挂起期+密集重试自毒半开槽） | sshd 连接位被占满/开机期 auth 挂起（Windows OpenSSH 开机负载+域解析慢；BatchMode/ConnectTimeout 救不了 TCP 层挂起） | ①ssh/scp 外层必包 `timeout`；②**probe 三试间隔 15s**（run13 起；3s 太密会自毒）；③调用方 timeout 预算 ≥3×(VM_SSH_TIMEOUT+15)+余量（如 35s×3+30≈150s 起，**外层小于内层=白跑**）；④冷开机期判 RED 前至少等 5 分钟再单发复测；⑤>10min 仍挂=VM 内管理员 `Restart-Service sshd`；⑥禁并发多轨同 VM |
| **ssh 新连持续 rc=124 全灭，但 tunnel health 稳定 200**（6×60s 交替采样指纹；`self-rescue.sh rhythm-check` 一键判） | **hypervisor 自动暂停反复挂起 VM**（guest 每次被冻/解冻，sshd 监听栈随之坏死；restart sshd/reboot guest 均短暂复活再犯） | **根治只在虚拟机管理端：自动暂停=从不 + 开机自启**（deploy.prompt Step 0.3 人工点）；确认设置前勿起 driver（必半途而废），自救仅用于拿通道快照 |\n| 偶发一两次 `Permission denied`/超时，复跑即好 | 桥接链路抖动（R4） | `vmssh/vmscp` 三试+2s；勿当配置错误排查 |
| `Permission denied (publickey)`（明明免密在） | 宿主 `~/.ssh` 属主随 uid 漂移（沙箱 uid 跨调用变化），known_hosts/id_ed25519 权限位失效 | 编排走独立选项 `-F /dev/null -o UserKnownHostsFile=/dev/null`（vm-conn 密码通道已内建）；长期=两把密钥分开（GitHub 用 id_ed25519_github，VM 通道重建用默认键） |
| sshd 在跑、端口在听，但 TCP 超时 | 防火墙规则 Profile 与网卡 Profile 不匹配（R3） | VM 管理员：`Set-NetFirewallRule -Name OpenSSH-Server-In-TCP -Profile Any`；诊断见 preflight FW= 行 |
| 连不上且 ping 通 | VM 被 hypervisor 暂停/睡眠 | VM 管理端设「自动暂停=从不 + 开机自启」；guest 内电源只是部分（prepare-vm DB-5） |
| **ping 100% 丢包** | VM 整机离线（hypervisor 关机/暂停/网络断开） | **P-4 人工点：非任何脚本可解**——用户在 VM 管理端开机/恢复后重试；期间 skill 离线件（env-detect/download-verify/pack 校验）不受阻可先行 |
| ssh 传 `/End` 变 `C:/.../End`、`$_` 变路径 | 远端默认壳=Git-Bash/MSYS 改写 | 铁律通道（见 B 首行） |
| 内联 PowerShell 报 ParserError/怪值 | 双引号命令串里 `$_`/`$p` 被**本地** bash 先展开（run11 0.4 实测） | 与远端同权对待：单引号 heredoc 写 `.ps1` → ps-run；短片段 `-c` 走 EncodedCommand |

## B. 安装/拆除流程

| 现象 | 根因 | 解法 |
|---|---|---|
| Step3 apply「cd C:/WinVMBridge 找不到路径」反复失败（上百次） | ≤V1.4.8 安装载荷=Git-Bash 专属语法而 sshd 默认壳 cmd.exe（R8 隐藏前置） | ≥V1.4.9 已根除（跨壳 .ps1/EncodedCommand）；**不需要**装 Git for Windows/改 DefaultShell |
| apply 报 420s 未监听，服务像没起 | 首实例「僵而不绑」（8K 工作集不占端口）；端口反查对其全盲 | ≥V1.4.15 VM-START 命令行签名清扫根治（I-6.16）+V1.4.16 修击杀实现（I-6.17：PS5.1 CMSL 无 `.Terminate()`→Invoke-CimMethod）；旧包=按脚本重跑本步 |
| 拆除 rc=1，FAIL=C:/WinVMBridge absent(observed:True)+no vm-service process(True) | 残留僵尸 node：8K/无子/不绑端口，**管理员三式强杀全免疫**（taskkill /F、Process.Kill、CIM Terminate 皆无效） | 终极解=VM 内 `shutdown /r /t 5 /f` 重启 guest（~60s sshd 恢复）→ 复跑 undeploy（19/19 rc=0） |
| uninstall rc=1 但自报 0 failure 且唯一 FAIL=workspace kept | ≤V1.4.8 已知保留项断言误报（I-6.7） | 以 U4 独立复核为准继续；V1.4.9+ 已修 |
| task_state=Ready 但服务其实在跑 / GUI 能力报 SESSION_UNAVAILABLE | schtasks 包装器退出后任务态=Ready；实例落 Session 0 | deploy.prompt 3.3 兜底判据（Ready+listen=1+200=可继续）；GUI 需 `schtasks /End+/Run` 重触发落交互会话（run9/10 实测） |
| E7 `EXC timed out` | 探针客户端窗 ≤V1.4.15 硬编码 120s（I-6.13） | ≥V1.4.16 包内探针 330s；旧包换仓库 HEAD 探针跑 |
| E7 `EXECUTION_TIMEOUT` 且 durationMs≈120000 | 服务端能力闸 120s（I-6.14，客户端修好后露出的下一层） | ≥V1.4.17 盘扫族 300s；勿再当"瞬态"复跑放行 |
| 探针链总时长比基线慢 ~50-100s | 冷启带宽：llmSession/ps-bridge starting 拖慢 E4/E7 首批（run12：深冷 239s vs 热 97s） | 判据=零超时零复跑；X-5 三档带（~97/~145/≤250s）内勿误判回归 |
| BUILD 相位 exit 127 整链 rc=1 | 发布包不随发 typescript（白名单本意），纯净宿主无法 npm run build；且 dist 预构建其实可用（X-7 假败） | ≥V1.4.20 自动降级 SKIP；或恒用 `--skip-build`（发布包标准入口） |
| `.env` 填了 WINVM_VM_PASSWORD 隧道仍要密码失败 | ≤V1.4.19 setup 只读 process.env 不回注（X-6） | ≥V1.4.20 凭据自动回注（白名单+env 优先）；旧版=运行前 source 一个含 export 的 env.sh |
| 隧道段 V8 FATAL errno=12 | $NODE 选中脆弱 hnp node（.mjs 执行崩、-e 正常） | v3.0.x 探测冒烟门禁自动避开；旧版手动 export NODE 到 bundle node 再 `tunnel ensure` |
| deploy 中途 VM 重启/断电后一切卡住 | sshd 未起+hypervisor 层状态 | 恢复 VM → vm_channel_probe → 从失败相位重跑（全链幂等；setup 重试吸收此类瞬态） |
| 想彻底拆干净重灌 | —— | 标准流程=undeploy（U0→U5）→ deploy（Step 0→6）；两 driver 幂等，可反复 |

## C. 宿主环境特例（鸿蒙沙箱）

| 现象 | 根因 | 解法 |
|---|---|---|
| `/bin/bash` bad interpreter / heredoc 误解析 | 系统 shim 损坏 | `env-detect.sh` 探测健康 bash（含"能执行带 shebang 的脚本文件"冒烟）；退化路径=node -e / 写文件执行 |
| `rm` bad interpreter | 同上 | `fs_rm`（node fs）；日日志/证据目录勿 rm -rf |
| shell-init getcwd 警告刷屏 | 沙箱固有 | 判据字段 ASCII 不受影响；X-4 放行（capture 用 2>/dev/null） |
| 大文档批量 Edit 后内容缩水/出现字面 `\n` | python 普通串转义 | 每处 assert count==1 + 写后 grep 扫 `|\n|` 字面（项目铁律） |
| 明文密码落 .env | 交付残留风险 | env.example 注释化该键；部署完删行（deploy-reports 提醒） |
| 一行式内嵌 python/sed 报 syntax error/rc=127 撕碎整链 | 双引号里嵌套单引号被 shell eval 拆坏（run13 实证：token 提取一行式炸整链；与「禁内联含 $」同源的第二形态） | 复杂逻辑一律 `cat > x.py <<'EOF'` 落盘再跑；令牌经文件/环境变量中转并即删；同族=python 普通串 `\n`/路径转义坑 |

## D. gitee 发布面（取包主源特有）

| 现象 | 根因 | 解法 |
|---|---|---|
| gitee 下载二次续传 403 | 302→foruda 是**一次性签名** URL | 失败=整文件重试（勿 `-C -`）；github 备源可续传（deploy.prompt v3.1.0 已按此写） |
| `sha256sum -c` 报 no such file winvm-overall-... | sidecar 内是相对名 | 判据①必须 `cd pkg/` 后跑（driver 已内建） |
| gitee API 建 release 422 / 改库 400 | POST /releases 必带 `target_commitish`；PATCH /repos 必带 `name` | publish-release.mjs --mirror-gitee 已内建；手工调 API 时记住 | / 改库 400 | POST /releases 必带 `target_commitish`；PATCH /repos 必带 `name` | publish-release.mjs --mirror-gitee 已内建；手工调 API 时记住 |
| 附件"删了又出现"重复 | attach_files 无 upsert 且落盘名会小写化 | 同名判定要大小写不敏感；先 DELETE 再 POST（mirror 逻辑已处理） |

## E. 版本门槛速查（问题 ↔ 修复起始版本）

R8 跨壳=V1.4.9 · KEEP 误报=V1.4.9 · 探测冒烟/僵尸重启=V1.4.16（D1/I-6.15b 文案） · VM-START 清扫=V1.4.15、击杀生效=V1.4.16 · 服务端闸 300s=V1.4.17 · 探针窗 330s=V1.4.17 · 避坑清单 X-1~X-6=v3.0.6~v3.0.7 · gitee 主源=v3.1.0 · .env 凭据回注+BUILD 降级=V1.4.20。

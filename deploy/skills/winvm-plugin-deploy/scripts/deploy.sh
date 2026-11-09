#!/usr/bin/env bash
# winvm-plugin-deploy · 主部署 driver（对应 deploy.prompt Step 0→6）
# 用法：VM_HOST=<ip> [VM_USER=User] bash deploy.sh [--apply] [--pkg <PKG_ROOT>] [--tag V1.4.x]
# 默认 DRY-RUN=只体检+出计划不写任何东西；--apply 才真执行。全程 step.sh 计时留痕，
# 判据不过即停（打印后退出），绝不跳步硬推。
set -u
_here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
: "${VMDEPLOY_ENV_SH:=${HOME}/wbtmp/vmdeploy-env.sh}"; [ -f "$VMDEPLOY_ENV_SH" ] && . "$VMDEPLOY_ENV_SH"
# shellcheck disable=SC1090
. "$_here/vm-conn.sh"
# shellcheck disable=SC1090
. "$_here/pkg-root.sh"   # run19 R-1：三 driver 选根共享事实源（_pick_pkg_root/resolve_pkg_root/pkg_root_usage_error）
STEP() { bash "$_here/step.sh" "$@"; }
APPLY=0; PKG="${PKG_ROOT:-$HOME/winvm-deploy/overall-root}"; TAG="${RELEASE_TAG:-}"
# 包根显式来源（env PKG_ROOT 或 --pkg）=跳过自动取最新；未显式=C2 走 download-verify 取最新
PKG_EXPLICIT="${PKG_ROOT:+1}"; PKG_EXPLICIT="${PKG_EXPLICIT:-0}"
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --pkg) PKG="$2"; PKG_EXPLICIT=1; shift ;;
    --tag) TAG="$2"; shift ;;
    *) echo "未知参数 $1" >&2; exit 2 ;;
  esac; shift
done
: "${VM_HOST:?VM_HOST 未设 → 执行协议 P-1：问用户}"
: "${VM_USER:=User}"; : "${VM_SSH_PORT:=22}"
NODE="${NODE:?缺少健康 node → 先跑 scripts/env-detect.sh}"
LOGD="${VMDEPLOY_LOG_DIR:-$HOME/wbtmp/vmdeploy-run-default}"; mkdir -p "$LOGD"

_step_log() { STEP log "$1" < "$2" 2>/dev/null || true; }
# run17 D-3 假绿止血：不即时阻断的段失败（如实记 FAIL 后仍按原流程走完）汇入 FAILED_STEPS，
# 末尾聚合出链非零——steps.tsv 判定列必须可信；硬阻断段（C1/C2 取包/C3.2/C3.3/C4.1）维持即时 exit 1 不变。
FAILED_STEPS=""
_fail_note() { FAILED_STEPS="$FAILED_STEPS $1"; }

# ── Step 0 体检 ──
STEP begin P0 0 "preflight 五项体检"
bash "$_here/preflight.sh" > "$LOGD/preflight.log" 2>&1; PRC=$?
tail -12 "$LOGD/preflight.log"; _step_log preflight "$LOGD/preflight.log"
grep -q "READINESS=RED" "$LOGD/preflight.log" && { STEP end P0 0 $PRC FAIL "READINESS=RED" "按 preflight 输出的修复指引处置后重跑；勿硬跑"; exit 1; }
STEP end P0 0 0 PASS "GREEN/YELLOW" "none"

[ $APPLY -eq 0 ] && { echo "DRY-RUN：体检通过，加 --apply 执行 通道→取包→prepare→setup→vmcheck→host→探针→交付 全链。"; STEP report; exit 0; }

# ── Step 1 通道 ──
STEP begin C1 1.5 "免密/密码通道判定"
vm_channel_probe || { STEP end C1 1.5 1 FAIL "无通道" "现象=both fail/证据=probe 输出/处置=deploy.prompt Step 1 建免密（密码仅 env 注入）"; exit 1; }
STEP end C1 1.5 0 PASS "channel=${VM_CHANNEL}" "none"

# ── Step 2 取包/校验 ──
STEP begin C2 2 "包根判定/取包三件套"
if [ -f "$PKG/MANIFEST.txt" ] && [ -d "$PKG/delivery" ] && [ "$PKG_EXPLICIT" = "1" ]; then
  echo "[PKG] root=$PKG（来源=显式 env PKG_ROOT/--pkg，跳过取包）"
else
  # run18 P-1 定谳：overall-root 曾双层并存（陈旧层永不被扫出=882 undeclared），且旧条件
  # 「外层有 MANIFEST 即跳过下载」使最新 release 永不落地。默认路径=download-verify 取最新
  # （隔离重解+version==TAG 选根），离线回退现存包根（如实告警版本或陈旧）。
  # run19 R-2：旧=`… 2>&1 | tail -1` 只留末行，[cache]/[quarantine]/verify-manifest 信息行
  # 全丢（run19 grep 实锤排障失明）。现全量落 $LOGD/download-verify.log，仅从中取 PKG_ROOT 末行。
  bash "$_here/download-verify.sh" ${TAG:+--tag "$TAG"} > "$LOGD/download-verify.log" 2>&1 || true
  _step_log download-verify "$LOGD/download-verify.log"
  grep -E '^\[(cache|quarantine|pkg-root|download)\]|^SHA256_|^RESULT|^⚠' "$LOGD/download-verify.log" | head -8
  LAST_DV="$(grep -E '^PKG_ROOT=' "$LOGD/download-verify.log" | tail -1)"
  if [ -n "$LAST_DV" ] && [ -f "${LAST_DV#PKG_ROOT=}/MANIFEST.txt" ]; then
    PKG="${LAST_DV#PKG_ROOT=}"; echo "[PKG] root=$PKG（来源=download-verify 最新判定）"
  elif resolve_pkg_root; then
    # 回退三级链的「状态文件>现探」（pkg-root.sh）；download-verify 失败但本地已有合法层
    PKG="$PKG_RESOLVED"; echo "[PKG] root=$PKG（来源=回退 $PKG_SOURCE；download-verify 失败见 $LOGD/download-verify.log 末行=$(tail -1 "$LOGD/download-verify.log")）"
  elif [ -f "$PKG/MANIFEST.txt" ] && [ -d "$PKG/delivery" ]; then
    echo "[PKG] root=$PKG（来源=保底旧默认，download-verify 失败且无可探层，版本或陈旧——C3 用包内代码注意）"
  else
    echo "[PKG] 取包失败：download-verify 无 PKG_ROOT 输出且无任何合法包根" >&2
    pkg_root_usage_error
    STEP end C2 2 1 FAIL "取包失败" "$(tail -1 "$LOGD/download-verify.log" 2>/dev/null || echo 无输出)；三 driver 包根未定"; exit 1
  fi
fi
# run19 R-1：C2 定根后落状态文件（显式/自动两分支统一在此写）——undeploy/verify 默认值三级链第 2 级来源
{ echo "$PKG"; } > "$PKG_ROOT_STATE" 2>/dev/null && echo "[PKG] 状态文件已写 $PKG_ROOT_STATE" || echo "⚠ pkg-root.txt 写入失败（undeploy/verify 将走现探回退）" >&2
( cd "$PKG" && "${PY:-python3}" qa/deploy-probes/verify-manifest.py . > "$LOGD/manifest.log" 2>&1 ); MRC=$?
tail -1 "$LOGD/manifest.log"; _step_log manifest "$LOGD/manifest.log"
# run17 D-3：manifest rc 入判定（旧=无条件 PASS，882 undeclared 假绿）；不即时阻断（发布面
# 已知漂移史未定谳），如实 FAIL + 聚合出链非零，人工对照 manifest.log 处置。
if [ $MRC -ne 0 ]; then
  STEP end C2 2 $MRC FAIL "manifest rc=$MRC pkg=$PKG" "RESULT: FAIL 见 $LOGD/manifest.log（undeclared=陈旧层/发布清单漂移，对照 publish 链）"
  _fail_note "C2/2-manifest"
else
  STEP end C2 2 0 PASS "MANIFEST 见日志 pkg=$PKG" "none"
fi

# ── Step 3 VM 侧（prepare-vm 补齐 + setup 七相位；X-6/X-7 修复后 .env/密码/BUILD 均免手工） ──
STEP begin C3 3.0 "ENV_PRECHECK 硬门禁"
# run17 D-3：旧=`|| true` 吞非零后无条件 PASS（run17 活体假绿：env-check.log=VMS scp 失败仍 PASS）。
# 现 capture rc 入判定；判据=rc≠0 或日志缺 ENV_PRECHECK 行 → FAIL（不即时阻断，聚合出链非零）。
( cd "$PKG" && "${BASH_OK:-bash}" "$_here/ps-run.sh" "$PKG/qa/deploy-probes/vm-env-check.ps1" > "$LOGD/env-check.log" 2>&1 ); ERC=$?
grep -E "ENV_PRECHECK|BLOCKERS|NODE_OK|CLI_OK" "$LOGD/env-check.log" | head -5; _step_log env-check "$LOGD/env-check.log"
if [ $ERC -ne 0 ] || ! grep -q "ENV_PRECHECK" "$LOGD/env-check.log" 2>/dev/null; then
  STEP end C3 3.0 "$([ $ERC -ne 0 ] && echo $ERC || echo 1)" FAIL "env-check rc=$ERC/无 ENV_PRECHECK 行" "照 troubleshooting P-2 处置（BLOCKERS≠none 或通道失败=先修通道重跑）"
  _fail_note "C3/3.0-env-check"
else
  STEP end C3 3.0 0 PASS "见日志（BLOCKERS≠none 时照 troubleshooting P-2 处置）" "none"
fi

STEP begin C3 3.2 "prepare-vm --ensure-node + setup --apply --skip-build"
( cd "$PKG" && "$NODE" delivery/bootstrap.mjs prepare-vm --apply --ensure-node \
    --vm-host "$VM_HOST" --vm-user "$VM_USER" --vm-ssh-port "$VM_SSH_PORT" > "$LOGD/prepare.log" 2>&1 ); PRC2=$?
tail -4 "$LOGD/prepare.log"; _step_log prepare-vm "$LOGD/prepare.log"
# run17 D-3：prepare rc 旧仅展示在 PASS 判据里=吞没；现入聚合（不阻断：setup 成功可覆盖补齐面，人工对照 prepare.log）
if [ $PRC2 -ne 0 ]; then _fail_note "C3/3.2-prepare(rc=$PRC2)"; fi
# .env 就位（缺失→从样本生成骨架；字段核对仍按 deploy.prompt 3.1 人工过目）
[ -f "$PKG/.env" ] || cp "$PKG/delivery/env.example" "$PKG/.env" 2>/dev/null || echo "⚠ 无 .env 也无 env.example→按 prompt 3.1 手建"
( cd "$PKG" && "$NODE" delivery/setup.mjs --apply --skip-build > "$LOGD/setup.log" 2>&1 ); SRC=$?
grep -E "部署全部完成|个步骤失败|降级 SKIP|凭据回注|VM_START_SWEEP" "$LOGD/setup.log" | head -6
_step_log setup "$LOGD/setup.log"
if [ $SRC -ne 0 ]; then
  STEP end C3 3.2 $SRC FAIL "setup rc=$SRC" "失败相位名在 setup.log；对照 troubleshooting（BUILD 假败≤V1.4.18 已修/420s 未监听=僵尸行/僵尸=shutdown /r 重启行）"
  exit 1
fi
STEP end C3 3.2 $PRC2 "$([ $PRC2 -eq 0 ] && echo PASS || echo FAIL)" "prepare rc=$PRC2 + setup rc=0" "$([ $PRC2 -eq 0 ] && echo none || echo 'prepare-vm 非零，对照 prepare.log')"

STEP begin C3 3.3 "vmcheck 七判据"
( cd "$PKG" && "${BASH_OK:-bash}" "$_here/ps-run.sh" "$PKG/qa/deploy-probes/vmcheck.ps1" > "$LOGD/vmcheck.log" 2>&1 ); VC=$?
grep -E "task_state|listen_addr|listen_count|health_http|ok" "$LOGD/vmcheck.log" | head -8; _step_log vmcheck "$LOGD/vmcheck.log"
# N1 兜底判据：task_state=Ready 但 listen_count=1 且 health=200 ⇒ 可继续
if [ $VC -ne 0 ]; then STEP end C3 3.3 $VC FAIL "vmcheck rc=$VC" "Ready+GUI SESSION_UNAVAILABLE→schtasks /End+/Run 重触发；僵而不绑=420s 僵尸处置"; exit 1; fi
STEP end C3 3.3 0 PASS "七判据见日志" "none"

# ── Step 4 宿主插件+隧道 ──
# run18 P-5：旧=begin 4.1 成功路径无 end、health 用 4.5 end 但从未 begin 4.5（steps.tsv
# dur 空白/孤儿行）。现两段各自 begin/end 成对：4.1=install-host，4.5=fresh+health。
STEP begin C4 4.1 "install-host --yes（插件+隧道装）"
( cd "$PKG" && "$NODE" delivery/install-host.mjs --yes --vm-host "$VM_HOST" --vm-user "$VM_USER" --vm-ssh-port "$VM_SSH_PORT" > "$LOGD/host.log" 2>&1 ); HC=$?
tail -3 "$LOGD/host.log"; _step_log install-host "$LOGD/host.log"
[ $HC -eq 0 ] || { STEP end C4 4.1 $HC FAIL "install-host rc=$HC" "connector-states ⚠=平台账户噪声（X-4 放行）；真败查 errno=12=脆弱 node 行"; exit 1; }
STEP end C4 4.1 0 PASS "install-host rc=0" "none"
STEP begin C4 4.5 "fresh + 隧道 health"
( cd "$PKG" && "$NODE" delivery/install-host.mjs --check-fresh 2>&1 | tail -1 )
# run17 D-3：隧道 health curl rc+码入判定（旧=输出后无条件 PASS）；health 非 200 记 FAIL 聚合出链
HEALTH_CODE="$(curl -sS --noproxy 127.0.0.1 -o /dev/null -w '%{http_code}' --max-time 15 "http://127.0.0.1:${WINVM_TUNNEL_LOCAL_PORT:-18443}/health" 2>/dev/null)"; HCRC=$?
echo "health=$HEALTH_CODE (curl rc=$HCRC)"
if [ $HCRC -ne 0 ] || [ "$HEALTH_CODE" != "200" ]; then
  STEP end C4 4.5 1 FAIL "health=$HEALTH_CODE rc=$HCRC" "隧道 daemon 未就绪：查 delivery/tunnel-daemon.mjs 状态与 ~/.workbuddy/winvm 日志"
  _fail_note "C4/4.5-health"
else
  STEP end C4 4.5 0 PASS "fresh/health=$HEALTH_CODE 见日志" "none"
fi

# ── Step 5 三探针 ──
STEP begin C5 5 "三探针 38 项（X-5 带宽：冷 ~145s / 深冷 ≤250s）"
PROBLEMS=""
PRC_ALL=0
for pr in mcp-probe a2a-probe example-probe; do
  ( cd "$PKG" && "${PY:-python3}" "qa/deploy-probes/$pr.py" > "$LOGD/$pr.log" 2>&1 ); RC=$?
  echo "[$pr rc=$RC] $(grep -E 'SUMMARY|RESULT' "$LOGD/$pr.log" | tail -1)"
  _step_log "$pr" "$LOGD/$pr.log"
  [ $RC -ne 0 ] && { PROBLEMS="$PROBLEMS $pr:FAIL"; [ $PRC_ALL -eq 0 ] && PRC_ALL=$RC; }
done
# run17 D-3：探针 rc 入 steps.tsv rc 列（旧=恒 0 只 judgment 显 FAIL）+ 聚合出链非零
# run18 P-5：end id 与 begin 对齐（旧 end 5.3 无 begin → dur 空）
STEP end C5 5 $PRC_ALL "$([ -z "$PROBLEMS" ] && echo PASS || echo FAIL)" "38 项见日志" "${PROBLEMS:-none}"
[ -z "$PROBLEMS" ] || _fail_note "C5/5-probes($PROBLEMS)"
[ -z "$PROBLEMS" ] || { echo "⚠ 探针失败:$PROBLEMS —— 按 troubleshooting 对应行处置（EXECUTION_TIMEOUT vs timed out 两形态勿混）"; }
# v1.3.0 时间预算战役（run22 账本=装完立即 verify 会把同 3 探针冷跑第二遍，浪费 ~240s）：
# C5 全过 ⇒ 落「探针新鲜 stamp」，verify.sh 在新鲜窗（PROBE_FRESH_BUDGET_S 默认 600s）且同包根时
# 复用结果只跑终态矩阵。防假绿三防线=①时效窗②同 PKG ③VERIFY_FORCE_PROBE=1 可强制冷跑。
PROBE_STAMP="${VMDEPLOY_PROBE_STAMP:-$HOME/wbtmp/vmdeploy-probes-stamp.txt}"
if [ -z "$PROBLEMS" ]; then
  mkdir -p "$(dirname "$PROBE_STAMP")" 2>/dev/null || true
  printf 'epoch=%s\npkg=%s\nrun=%s\n' "$(date +%s)" "$PKG" "${VMDEPLOY_RUN_DIR:-}" > "$PROBE_STAMP" 2>/dev/null || true
  echo "[probe-stamp] 新鲜标记已落 $PROBE_STAMP（verify 600s 内同包根将复用 3 探针结果）"
fi

# ── Step 6 交付 ──
STEP begin C6 6.1 "skill 交付判据"
SKCNT="$(ls "$HOME/.workbuddy/connectors/skills/connector-winvm/" 2>/dev/null | wc -l)"
echo "connector-winvm skills=$SKCNT"
# run17 D-3：计数判据入判定（旧=无条件 PASS）；≠8 记 FAIL 聚合出链（口径见 deploy.prompt Step 6）
if [ "$SKCNT" -lt 8 ]; then
  STEP end C6 6.1 1 FAIL "skills=$SKCNT（期望≥8）" "skill 交付缺口：重跑 delivery/deploy-shared-skills.mjs 或对照 deploy.prompt Step 6"
  _fail_note "C6/6.1-skills"
else
  STEP end C6 6.1 0 PASS "计数=$SKCNT" "none"
fi

STEP report
# run17 D-3 聚合出链：非硬阻断段失败（FAILED_STEPS 在场）→ 如实非零退出（旧=恒 0 假绿）
if [ -n "$FAILED_STEPS" ]; then
  echo "DEPLOY_APPLY_WITH_FAILURES:$FAILED_STEPS PKG_ROOT=$PKG"
  echo "⚠ steps.tsv 判定列含 FAIL（硬阻断段已过；失败段明细见上与 logs/），出链 rc=1"
  exit 1
fi
echo "DEPLOY_APPLY_DONE PKG_ROOT=$PKG"

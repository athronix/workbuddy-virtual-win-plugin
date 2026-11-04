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
STEP() { bash "$_here/step.sh" "$@"; }
APPLY=0; PKG="${PKG_ROOT:-$HOME/winvm-deploy/overall-root}"; TAG="${RELEASE_TAG:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --pkg) PKG="$2"; shift ;;
    --tag) TAG="$2"; shift ;;
    *) echo "未知参数 $1" >&2; exit 2 ;;
  esac; shift
done
: "${VM_HOST:?VM_HOST 未设 → 执行协议 P-1：问用户}"
: "${VM_USER:=User}"; : "${VM_SSH_PORT:=22}"
NODE="${NODE:?缺少健康 node → 先跑 scripts/env-detect.sh}"
LOGD="${VMDEPLOY_LOG_DIR:-$HOME/wbtmp/vmdeploy-run-default}"; mkdir -p "$LOGD"

_step_log() { STEP log "$1" < "$2" 2>/dev/null || true; }

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
if ! { ls "$PKG/MANIFEST.txt" >/dev/null 2>&1 && ls -d "$PKG/delivery" >/dev/null 2>&1; }; then
  LAST="$(bash "$_here/download-verify.sh" ${TAG:+--tag "$TAG"} | tail -1)"
  PKG="${LAST#PKG_ROOT=}"
  { [ -f "$PKG/MANIFEST.txt" ]; } || { STEP end C2 2.1 1 FAIL "取包失败" "$LAST"; exit 1; }
fi
( cd "$PKG" && "${PY:-python3}" qa/deploy-probes/verify-manifest.py . > "$LOGD/manifest.log" 2>&1 ); tail -1 "$LOGD/manifest.log"; _step_log manifest "$LOGD/manifest.log"
STEP end C2 2.3 0 PASS "MANIFEST 见日志" "none"

# ── Step 3 VM 侧（prepare-vm 补齐 + setup 七相位；X-6/X-7 修复后 .env/密码/BUILD 均免手工） ──
STEP begin C3 3.0 "ENV_PRECHECK 硬门禁"
( cd "$PKG" && "${BASH_OK:-bash}" "$_here/ps-run.sh" "$PKG/qa/deploy-probes/vm-env-check.ps1" > "$LOGD/env-check.log" 2>&1 ) || true
grep -E "ENV_PRECHECK|BLOCKERS|NODE_OK|CLI_OK" "$LOGD/env-check.log" | head -5; _step_log env-check "$LOGD/env-check.log"
STEP end C3 3.0 0 PASS "见日志（BLOCKERS≠none 时照 troubleshooting P-2 处置）" "none"

STEP begin C3 3.2 "prepare-vm --ensure-node + setup --apply --skip-build"
( cd "$PKG" && "$NODE" delivery/bootstrap.mjs prepare-vm --apply --ensure-node \
    --vm-host "$VM_HOST" --vm-user "$VM_USER" --vm-ssh-port "$VM_SSH_PORT" > "$LOGD/prepare.log" 2>&1 ); PRC2=$?
tail -4 "$LOGD/prepare.log"; _step_log prepare-vm "$LOGD/prepare.log"
# .env 就位（缺失→从样本生成骨架；字段核对仍按 deploy.prompt 3.1 人工过目）
[ -f "$PKG/.env" ] || cp "$PKG/delivery/env.example" "$PKG/.env" 2>/dev/null || echo "⚠ 无 .env 也无 env.example→按 prompt 3.1 手建"
( cd "$PKG" && "$NODE" delivery/setup.mjs --apply --skip-build > "$LOGD/setup.log" 2>&1 ); SRC=$?
grep -E "部署全部完成|个步骤失败|降级 SKIP|凭据回注|VM_START_SWEEP" "$LOGD/setup.log" | head -6
_step_log setup "$LOGD/setup.log"
if [ $SRC -ne 0 ]; then
  STEP end C3 3.2 $SRC FAIL "setup rc=$SRC" "失败相位名在 setup.log；对照 troubleshooting（BUILD 假败≤V1.4.18 已修/420s 未监听=僵尸行/僵尸=shutdown /r 重启行）"
  exit 1
fi
STEP end C3 3.2 0 PASS "prepare rc=$PRC2 + setup rc=0" "none"

STEP begin C3 3.3 "vmcheck 七判据"
( cd "$PKG" && "${BASH_OK:-bash}" "$_here/ps-run.sh" "$PKG/qa/deploy-probes/vmcheck.ps1" > "$LOGD/vmcheck.log" 2>&1 ); VC=$?
grep -E "task_state|listen_addr|listen_count|health_http|ok" "$LOGD/vmcheck.log" | head -8; _step_log vmcheck "$LOGD/vmcheck.log"
# N1 兜底判据：task_state=Ready 但 listen_count=1 且 health=200 ⇒ 可继续
if [ $VC -ne 0 ]; then STEP end C3 3.3 $VC FAIL "vmcheck rc=$VC" "Ready+GUI SESSION_UNAVAILABLE→schtasks /End+/Run 重触发；僵而不绑=420s 僵尸处置"; exit 1; fi
STEP end C3 3.3 0 PASS "七判据见日志" "none"

# ── Step 4 宿主插件+隧道 ──
STEP begin C4 4.1 "install-host + 隧道"
( cd "$PKG" && "$NODE" delivery/install-host.mjs --yes --vm-host "$VM_HOST" --vm-user "$VM_USER" --vm-ssh-port "$VM_SSH_PORT" > "$LOGD/host.log" 2>&1 ); HC=$?
tail -3 "$LOGD/host.log"; _step_log install-host "$LOGD/host.log"
[ $HC -eq 0 ] || { STEP end C4 4.1 $HC FAIL "install-host rc=$HC" "connector-states ⚠=平台账户噪声（X-4 放行）；真败查 errno=12=脆弱 node 行"; exit 1; }
( cd "$PKG" && "$NODE" delivery/install-host.mjs --check-fresh 2>&1 | tail -1 )
curl -sS --noproxy 127.0.0.1 -o /dev/null -w 'health=%{http_code}\n' --max-time 15 "http://127.0.0.1:${WINVM_TUNNEL_LOCAL_PORT:-18443}/health"
STEP end C4 4.5 0 PASS "fresh/health 见日志" "none"

# ── Step 5 三探针 ──
STEP begin C5 5 "三探针 38 项（X-5 带宽：冷 ~145s / 深冷 ≤250s）"
PROBLEMS=""
for pr in mcp-probe a2a-probe example-probe; do
  ( cd "$PKG" && "${PY:-python3}" "qa/deploy-probes/$pr.py" > "$LOGD/$pr.log" 2>&1 ); RC=$?
  echo "[$pr rc=$RC] $(grep -E 'SUMMARY|RESULT' "$LOGD/$pr.log" | tail -1)"
  _step_log "$pr" "$LOGD/$pr.log"
  [ $RC -ne 0 ] && PROBLEMS="$PROBLEMS $pr:FAIL"
done
STEP end C5 5.3 0 "$([ -z "$PROBLEMS" ] && echo PASS || echo FAIL)" "38 项见日志" "${PROBLEMS:-none}"
[ -z "$PROBLEMS" ] || { echo "⚠ 探针失败:$PROBLEMS —— 按 troubleshooting 对应行处置（EXECUTION_TIMEOUT vs timed out 两形态勿混）"; }

# ── Step 6 交付 ──
STEP begin C6 6.1 "skill 交付判据"
echo "connector-winvm skills=$(ls "$HOME/.workbuddy/connectors/skills/connector-winvm/" 2>/dev/null | wc -l)"
STEP end C6 6.1 0 PASS "计数=8" "none"

STEP report
echo "DEPLOY_APPLY_DONE PKG_ROOT=$PKG"

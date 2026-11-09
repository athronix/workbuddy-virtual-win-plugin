#!/usr/bin/env bash
# winvm-plugin-deploy · 一键往返模板 driver（v1.3.0 时间预算战役产物，run22 账本驱动）
#
# 设计=用户裁定 11-09：「相连固定的操作提取动态参数连成一脚本；LLM 只在取必要信息、
# 探环境、做必要决策处介入，其余全交给模板脚本」。本脚本把 取包→拆→装→验 固定链一次跑完：
#   - 动态参数（仅这四个）：VM_HOST(必填) / VM_USER(默认 User) / ACTION / RELEASE_TAG(默认现解 latest)
#   - 固定操作=下方序列，全部复用既有 driver（deploy.sh/undeploy.sh/verify.sh，单一事实源不复制逻辑）
#   - 探针新鲜复用：deploy C5 通过后落 stamp，verify 在同包根 600s 内跳过重跑（省 ~240s）
#   - 全程 ssh2 后端（灭相位免疫）；steps.tsv 子步计时统一进 RUN_DIR；机器可读末块供 LLM 一次解析
#   - 失败即停+定点报障（对照 troubleshooting.md），不做无谓续跑
#
# 用法：
#   VM_HOST=172.16.100.2 bash roundtrip.sh                    # 默认 ACTION=full（取包+拆+装+验）
#   VM_HOST=... ACTION=deploy bash roundtrip.sh               # 只装+验（现役不动）
#   VM_HOST=... ACTION=undeploy bash roundtrip.sh            # 只拆
#   VM_HOST=... ACTION=verify bash roundtrip.sh              # 只验（探针新鲜则复用，VERIFY_FORCE_PROBE=1 强制重跑）
#   RELEASE_TAG=V1.4.99 SKIP_DOWNLOAD=1 ... 等微调见下参数表。
# 建议后台跑（Bash run_in_background）：完成后读末块 ROUNDTRIP_RESULT 即可，勿轮询中间态。
set -u
_here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
: "${VMDEPLOY_ENV_SH:=${HOME}/wbtmp/vmdeploy-env.sh}"; [ -f "$VMDEPLOY_ENV_SH" ] && . "$VMDEPLOY_ENV_SH"

# ── 动态参数（唯一需要 LLM/用户提供的面） ─────────────────────────────
: "${ACTION:=full}"                       # full|deploy|undeploy|verify|cycle(=full 别名)
: "${VM_USER:=User}"
: "${RELEASE_TAG:=}"                       # 空=download-verify 现解 gitee latest
: "${SKIP_DOWNLOAD:=0}"                    # 1=用当前 pkg-root.txt 包根（不重取包）
: "${DEPLOY_ROOT:=${HOME}/winvm-deploy}"
: "${PROBE_FRESH_BUDGET_S:=600}"           # 探针复用新鲜窗
export VM_SSH_BACKEND="${VM_SSH_BACKEND:-ssh2}"
export DEPLOY_ROOT PROBE_FRESH_BUDGET_S
: "${VM_HOST:?VM_HOST 未设（P-1：这是本脚本唯一必问参数）}"

RUN_DIR="${VMDEPLOY_RUN_DIR:-$HOME/wbtmp/rt-$(date +%Y%m%d-%H%M)}"
mkdir -p "$RUN_DIR"
export VMDEPLOY_RUN_DIR="$RUN_DIR"   # 关键接缝：子 driver（deploy/undeploy/verify）的 LOGD/steps.tsv 全认这个变量
# stamp 走全局共享位（=deploy.sh/verify.sh 的默认路径）：roundtrip 只统一 RUN_DIR，
# 让「本轮 deploy 写→本轮 verify 读」与「手动 deploy→稍后手动 verify」两场景同径。
STAMP="${VMDEPLOY_PROBE_STAMP:-$HOME/wbtmp/vmdeploy-probes-stamp.txt}"
export VMDEPLOY_PROBE_STAMP="$STAMP"
T0=$(date +%s)
say(){ echo "[$(date +%H:%M:%S)] $*"; }
_step(){ say "RT-STEP $*"; }

case "$ACTION" in cycle) ACTION=full;; esac
case "$ACTION" in full|deploy|undeploy|verify) ;; *) echo "ACTION 非法：$ACTION（full|deploy|undeploy|verify）" >&2; exit 2;; esac

# 前置：env-detect 缺位则自跑（探测=脚本活，不问 LLM）
if [ -z "${NODE:-}" ] || [ ! -x "${NODE:-/nonexistent}" ]; then
  _step "P-ENV 环境探测（env-detect.sh 自举）"
  bash "$_here/env-detect.sh" > "$RUN_DIR/env-detect.log" 2>&1 || { say "FATAL env-detect rc=$?"; exit 3; }
  . "$VMDEPLOY_ENV_SH"
fi

FAILED=""
RES_U="SKIP"; RES_D="SKIP"; RES_V="SKIP"; PKG_NOTE="(当前包根)"

# ── 序列一：取发布包（RELEASE_TAG 现解+隔离重解+校验，全固定） ──────
if [ "$ACTION" = full ] || { [ "$ACTION" = deploy ] && [ "$SKIP_DOWNLOAD" != 1 ]; }; then
  _step "R1 download-verify（tag=${RELEASE_TAG:-latest 现解}）"
  RT=0
  if [ -n "$RELEASE_TAG" ]; then RELEASE_TAG="$RELEASE_TAG" bash "$_here/download-verify.sh" > "$RUN_DIR/download-verify.log" 2>&1 || RT=$?
  else bash "$_here/download-verify.sh" > "$RUN_DIR/download-verify.log" 2>&1 || RT=$?; fi
  if [ $RT -ne 0 ]; then say "FAIL R1 download-verify rc=$RT → 查 $RUN_DIR/download-verify.log（troubleshooting A/D 族）"; exit 4; fi
  PKG_NOTE="$(grep -E '^PKG_ROOT=' "$RUN_DIR/download-verify.log" | tail -1)"
  say "OK R1 $PKG_NOTE（$(grep -E '^\[download\] tag=' "$RUN_DIR/download-verify.log" | tail -1)）"
fi

# ── 序列二：拆除 ──────────────────────────────────────────────────────
if [ "$ACTION" = full ] || [ "$ACTION" = undeploy ]; then
  _step "R2 undeploy --apply"
  bash "$_here/undeploy.sh" --apply > "$RUN_DIR/undeploy.log" 2>&1; RC=$?
  RES_U=$([ $RC -eq 0 ] && echo PASS || echo "FAIL(rc=$RC)")
  [ $RC -ne 0 ] && { FAILED="$FAILED undeploy"; say "FAIL R2 → 查 $RUN_DIR/undeploy.log（troubleshooting kept/僵尸行）"; }
  say "R2 $RES_U"
  [ -n "$FAILED" ] && { echo "== ROUNDTRIP_RESULT =="; echo "ACTION=$ACTION UNDEPLOY=$RES_U DEPLOY=SKIP VERIFY=SKIP WALL_S=$(( $(date +%s) - T0 ))"; echo "RUN_DIR=$RUN_DIR"; echo "VERDICT=NO FAILED:$FAILED"; exit 5; }
fi

# ── 序列三：安装（C5 通过会写探针 stamp 供 R4 复用） ─────────────────
if [ "$ACTION" = full ] || [ "$ACTION" = deploy ]; then
  _step "R3 deploy --apply"
  VMDEPLOY_PROBE_STAMP="$STAMP" bash "$_here/deploy.sh" --apply > "$RUN_DIR/deploy.log" 2>&1; RC=$?
  RES_D=$([ $RC -eq 0 ] && echo PASS || echo "FAIL(rc=$RC)")
  [ $RC -ne 0 ] && { FAILED="$FAILED deploy"; say "FAIL R3 → 查 $RUN_DIR/deploy.log + steps.tsv（ENV_PRECHECK/P-2 口径）"; }
  say "R3 $RES_D"
fi

# ── 序列四：验证（新鲜窗内且刚装过 ⇒ 探针复用只跑矩阵） ───────────────
if [ "$ACTION" = full ] || [ "$ACTION" = verify ] || [ "$ACTION" = deploy ]; then
  if [ -n "$FAILED" ]; then
    say "R4 SKIP（前序已败，不浪费探针带宽）"
    RES_V=SKIP
  else
    _step "R4 verify"
    bash "$_here/verify.sh" > "$RUN_DIR/verify.log" 2>&1; RC=$?
    RES_V=$([ $RC -eq 0 ] && echo PASS || echo "FAIL(rc=$RC)")
    [ $RC -ne 0 ] && FAILED="$FAILED verify"
    say "R4 $RES_V（探针复用=$(grep -c 'REUSED' "$RUN_DIR/verify.log" 2>/dev/null || echo 0)/3）"
  fi
fi

WALL=$(( $(date +%s) - T0 ))
# 末块=机器可读，LLM 一次解析定全局（勿再分段问）
echo ""
echo "== ROUNDTRIP_RESULT =="
echo "ACTION=$ACTION UNDEPLOY=$RES_U DEPLOY=$RES_D VERIFY=$RES_V WALL_S=$WALL"
echo "RUN_DIR=$RUN_DIR PKG=$PKG_NOTE"
echo "TIMINGS_TOP5:"; "${NODE:-node}" -e "
const fs=require('fs');const p='$RUN_DIR/steps.tsv';
try{const rows=fs.readFileSync(p,'utf8').trim().split('\n').slice(1).map(l=>l.split('\t'));
rows.sort((a,b)=>(+b[5]||0)-(+a[5]||0));
for(const r of rows.slice(0,5))console.log('  '+r[5]+'s '+r[0]+'/'+r[1]+' '+r[2].slice(0,28)+' '+r[7]);}catch(e){console.log('  (steps.tsv 缺)')}" 2>/dev/null || true
[ -z "$FAILED" ] && { echo "VERDICT=YES"; exit 0; } || { echo "VERDICT=NO FAILED:$FAILED"; exit 1; }

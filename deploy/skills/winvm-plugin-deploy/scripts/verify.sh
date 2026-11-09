#!/usr/bin/env bash
# winvm-plugin-deploy · 验证 driver（Step 5+6 独立可跑：三探针 38 项 + 终态矩阵 + 计时报告）
# 用法：[PKG_ROOT=<dir>] bash verify.sh   # 装完/修完随时跑；也用作安装后独立复核
set -u
_here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
: "${VMDEPLOY_ENV_SH:=${HOME}/wbtmp/vmdeploy-env.sh}"; [ -f "$VMDEPLOY_ENV_SH" ] && . "$VMDEPLOY_ENV_SH"
NODE="${NODE:-$(command -v node || true)}"; PY="${PY:-$(command -v python3 || true)}"
# run19 R-1：选根三级默认（env PKG_ROOT > pkg-root.txt 状态 > 现探 > 保底旧默认），
# 与 deploy/undeploy 共享 pkg-root.sh 事实源——旧硬指外层在隔离重解现场=空壳（run19 VER=2 实锤）。
# shellcheck disable=SC1090
. "$_here/pkg-root.sh"
if resolve_pkg_root; then
  PKG="$PKG_RESOLVED"; echo "[PKG] root=$PKG（来源=$PKG_SOURCE）"
else
  PKG="$HOME/winvm-deploy/overall-root"
  echo "⚠ [PKG] env/状态文件/现探三皆空，保底旧默认 $PKG" >&2
fi
LOGD="${VMDEPLOY_LOG_DIR:-$HOME/wbtmp/vmdeploy-verify-$(date +%Y%m%d-%H%M)}"; mkdir -p "$LOGD"
STEP() { bash "$_here/step.sh" "$@"; }
[ -d "$PKG/qa/deploy-probes" ] || { echo "包根缺 qa/deploy-probes：$PKG（PKG_ROOT=<dir> bash verify.sh 显式指定，或先跑 deploy/download-verify 落 pkg-root.txt）" >&2; pkg_root_usage_error; exit 2; }

# ── v1.3.0 探针新鲜复用（run22 账本：deploy C5 刚过再冷跑=+240s）──
# 判定=probe-fresh.sh 单一事实源（与单测共用；三防线=时效窗/同包根/强制冷跑，缺 stamp 保守不复用）。
# 矩阵段不受复用影响恒跑（便宜且是独立复核面）。
PROBE_STAMP="${VMDEPLOY_PROBE_STAMP:-$HOME/wbtmp/vmdeploy-probes-stamp.txt}"
FRESH="${PROBE_FRESH_BUDGET_S:-600}"
_PF_OUT="$(VMDEPLOY_PROBE_STAMP="$PROBE_STAMP" PROBE_PKG="$PKG" PROBE_FRESH_BUDGET_S="$FRESH" "${BASH_OK:-bash}" "$_here/probe-fresh.sh" 2>/dev/null)"
REUSE=0; REASON=""
case "$_PF_OUT" in *"REUSE=1"*) REUSE=1;; esac
REASON="$(printf '%s\n' "$_PF_OUT" | sed -n 's/^REASON=//p' | head -1)"
[ $REUSE -eq 1 ] && echo "[probe-fresh] $REASON"

echo "== 探针（X-5 带宽：全链 97~250s 属正常带；判据=零超时零复跑） =="
FAILS=""
for pr in mcp-probe a2a-probe example-probe; do
  STEP begin VERIFY "5-$pr" "$pr 20/5/13"
  if [ $REUSE -eq 1 ]; then
    echo "[$pr REUSED] 新鲜窗 ${FRESH}s 内复用 deploy C5 结果（stamp=$PROBE_STAMP；强制冷跑=VERIFY_FORCE_PROBE=1）"
    "$_here/step.sh" log "$pr" < /dev/null >/dev/null 2>&1 || true
    STEP end VERIFY "5-$pr" 0 PASS "REUSED(deploy C5 fresh)" "none"
    continue
  fi
  ( cd "$PKG" && "$PY" "qa/deploy-probes/$pr.py" > "$LOGD/$pr.log" 2>&1 ); RC=$?
  LINE="$(grep -E 'SUMMARY|RESULT' "$LOGD/$pr.log" | tail -1)"
  echo "[$pr rc=$RC] $LINE"; "$_here/step.sh" log "$pr" < "$LOGD/$pr.log" >/dev/null || true
  if [ $RC -ne 0 ]; then FAILS="$FAILS $pr"; STEP end VERIFY "5-$pr" $RC FAIL "$pr" "$LINE"; else STEP end VERIFY "5-$pr" 0 PASS "${LINE:-ok}" "none"; fi
done
[ $REUSE -eq 1 ] && echo "[probe-reuse] 3/3 REUSED（deploy 完 600s 内同包根=同一事实，矩阵段仍独立复核）"

echo "== 终态矩阵 =="
STEP begin VERIFY 6 "终态矩阵"
# run17 D-3：矩阵各行 rc 入 VRC 聚合（旧=&& 短路吞 ps-run 失败后恒 0 PASS，VM 行空转假绿）
VRC=0
"$NODE" "$PKG/delivery/install-host.mjs" --check-fresh 2>&1 | tail -1 > "$LOGD/fresh.txt"; cat "$LOGD/fresh.txt"
"$NODE" -e "const j=require(process.env.HOME+'/.workbuddy/mcp.json');for(const k of Object.keys(j.mcpServers||{}))if(/winvm/i.test(k))console.log(k,'disabledTools='+(j.mcpServers[k].disabledTools||[]).length)" | tee "$LOGD/disabled.txt" | head -2
curl -sS --noproxy 127.0.0.1 -o /dev/null -w 'health=%{http_code}\n' --max-time 15 "http://127.0.0.1:18443/health" | tee "$LOGD/health.txt"
# 管道末级 tee 恒 0，判据取内容：装完态 health=200（非 200=如实计失败）
grep -q "health=200" "$LOGD/health.txt" 2>/dev/null || VRC=1
echo "connector skills=$(ls "$HOME/.workbuddy/connectors/skills/connector-winvm/" 2>/dev/null | wc -l)" | tee -a "$LOGD/health.txt"
if [ -n "${VM_HOST:-}" ]; then
  # shellcheck disable=SC1090
  . "$_here/vm-conn.sh" 2>/dev/null
  if vm_channel_probe >/dev/null 2>&1; then
    # run18 P-3：旧=`ps-run … | tr … || VRC=1` 被管道末级 tr 恒 0 吞（与 health 行同坑）。
    # 现 PIPESTATUS 取 ps-run 真 rc + 内容判据（VM: task= 行必须在场），对齐同文件 health 行判法。
    "${BASH_OK:-bash}" "$_here/ps-run.sh" -c '$t=(Get-ScheduledTask -TaskName WinVMBridge.Service -EA SilentlyContinue).State; $l=@(Get-NetTCPConnection -LocalPort 18443 -State Listen -EA SilentlyContinue).Count; $s=(Get-Service sshd).Status; Write-Output ("VM: task=" + $t + " listen=" + $l + " sshd=" + $s)' | tr -d '\r' > "$LOGD/vm-terminal.txt"; VTRC=${PIPESTATUS[0]}
    cat "$LOGD/vm-terminal.txt"
    if [ $VTRC -ne 0 ] || ! grep -q "VM: task=" "$LOGD/vm-terminal.txt" 2>/dev/null; then
      echo "⚠ VM 终态行失败 rc=$VTRC（如实计败，勿被管道吞）" >&2; VRC=1
    fi
  else
    echo "⚠ VM 通道不可用：VM 终态行缺失（如实计失败，勿吞）" >&2; VRC=1
  fi
fi
STEP end VERIFY 6 $VRC "$([ $VRC -eq 0 ] && echo PASS || echo FAIL)" "矩阵见 $LOGD" "$([ $VRC -eq 0 ] && echo none || echo '终态矩阵有行失败，对照 '$LOGD)"

STEP report
[ $VRC -ne 0 ] && FAILS="$FAILS matrix"
[ -z "$FAILS" ] && echo "VERIFY=PASS" || { echo "VERIFY=FAIL:$FAILS（对照 troubleshooting.md 处置后只重跑失败探针即可）"; exit 1; }

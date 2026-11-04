#!/usr/bin/env bash
# winvm-plugin-deploy · 验证 driver（Step 5+6 独立可跑：三探针 38 项 + 终态矩阵 + 计时报告）
# 用法：[PKG_ROOT=<dir>] bash verify.sh   # 装完/修完随时跑；也用作安装后独立复核
set -u
_here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
: "${VMDEPLOY_ENV_SH:=${HOME}/wbtmp/vmdeploy-env.sh}"; [ -f "$VMDEPLOY_ENV_SH" ] && . "$VMDEPLOY_ENV_SH"
NODE="${NODE:-$(command -v node || true)}"; PY="${PY:-$(command -v python3 || true)}"
PKG="${PKG_ROOT:-$HOME/winvm-deploy/overall-root}"
LOGD="${VMDEPLOY_LOG_DIR:-$HOME/wbtmp/vmdeploy-verify-$(date +%Y%m%d-%H%M)}"; mkdir -p "$LOGD"
STEP() { bash "$_here/step.sh" "$@"; }
[ -d "$PKG/qa/deploy-probes" ] || { echo "包根缺 qa/deploy-probes：$PKG（download-verify 或 --pkg 修正）" >&2; exit 2; }

echo "== 探针（X-5 带宽：全链 97~250s 属正常带；判据=零超时零复跑） =="
FAILS=""
for pr in mcp-probe a2a-probe example-probe; do
  STEP begin VERIFY "5-$pr" "$pr 20/5/13"
  ( cd "$PKG" && "$PY" "qa/deploy-probes/$pr.py" > "$LOGD/$pr.log" 2>&1 ); RC=$?
  LINE="$(grep -E 'SUMMARY|RESULT' "$LOGD/$pr.log" | tail -1)"
  echo "[$pr rc=$RC] $LINE"; "$_here/step.sh" log "$pr" < "$LOGD/$pr.log" >/dev/null || true
  if [ $RC -ne 0 ]; then FAILS="$FAILS $pr"; STEP end VERIFY "5-$pr" $RC FAIL "$pr" "$LINE"; else STEP end VERIFY "5-$pr" 0 PASS "${LINE:-ok}" "none"; fi
done

echo "== 终态矩阵 =="
STEP begin VERIFY 6 "终态矩阵"
"$NODE" "$PKG/delivery/install-host.mjs" --check-fresh 2>&1 | tail -1 > "$LOGD/fresh.txt"; cat "$LOGD/fresh.txt"
"$NODE" -e "const j=require(process.env.HOME+'/.workbuddy/mcp.json');for(const k of Object.keys(j.mcpServers||{}))if(/winvm/i.test(k))console.log(k,'disabledTools='+(j.mcpServers[k].disabledTools||[]).length)" | tee "$LOGD/disabled.txt" | head -2
curl -sS --noproxy 127.0.0.1 -o /dev/null -w 'health=%{http_code}\n' --max-time 15 "http://127.0.0.1:18443/health" | tee "$LOGD/health.txt"
echo "connector skills=$(ls "$HOME/.workbuddy/connectors/skills/connector-winvm/" 2>/dev/null | wc -l)" | tee -a "$LOGD/health.txt"
if [ -n "${VM_HOST:-}" ]; then
  # shellcheck disable=SC1090
  . "$_here/vm-conn.sh" 2>/dev/null; vm_channel_probe >/dev/null 2>&1 && \
  "${BASH_OK:-bash}" "$_here/ps-run.sh" -c '$t=(Get-ScheduledTask -TaskName WinVMBridge.Service -EA SilentlyContinue).State; $l=@(Get-NetTCPConnection -LocalPort 18443 -State Listen -EA SilentlyContinue).Count; $s=(Get-Service sshd).Status; Write-Output ("VM: task=" + $t + " listen=" + $l + " sshd=" + $s)' | tr -d '\r'
fi
STEP end VERIFY 6 0 PASS "矩阵见 $LOGD" "none"

STEP report
[ -z "$FAILS" ] && echo "VERIFY=PASS" || echo "VERIFY=FAIL:$FAILS（对照 troubleshooting.md 处置后只重跑失败探针即可）"

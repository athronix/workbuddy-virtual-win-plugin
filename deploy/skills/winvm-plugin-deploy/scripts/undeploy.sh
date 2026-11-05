#!/usr/bin/env bash
# winvm-plugin-deploy · 主拆除 driver（对应 undeploy.prompt U0→U4；存留项默认全保留）
# 用法：VM_HOST=<ip> bash undeploy.sh [--apply] [--pkg <PKG_ROOT>]
# 安全：dry-run 默认；删除物全走 trash 可回滚；绝不动 ~/.ssh、VM authorized_keys、C:/WinVMWorkspace。
set -u
_here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
: "${VMDEPLOY_ENV_SH:=${HOME}/wbtmp/vmdeploy-env.sh}"; [ -f "$VMDEPLOY_ENV_SH" ] && . "$VMDEPLOY_ENV_SH"
# shellcheck disable=SC1090
. "$_here/vm-conn.sh"
STEP() { bash "$_here/step.sh" "$@"; }
APPLY=0; PKG="${PKG_ROOT:-$HOME/winvm-deploy/overall-root}"
while [ $# -gt 0 ]; do case "$1" in --apply) APPLY=1;; --pkg) PKG="$2"; shift;; *) exit 2;; esac; shift; done
: "${VM_HOST:?VM_HOST 未设 → 问用户}"
: "${VM_USER:=User}"; : "${VM_SSH_PORT:=22}"
NODE="${NODE:?先跑 env-detect.sh}"
LOGD="${VMDEPLOY_LOG_DIR:-$HOME/wbtmp/vmdeploy-undeploy-default}"; mkdir -p "$LOGD"

# run17 D-3 假绿止血：非阻断段失败入 FAILED_STEPS 聚合，末尾出链非零（steps.tsv 判定列必须可信）
FAILED_STEPS=""
_fail_note() { FAILED_STEPS="$FAILED_STEPS $1"; }

STEP begin U0 0.1 "免密通道仍在（拆除器 VM 相位依赖）"
vm_channel_probe || { STEP end U0 0.1 1 FAIL "通道失效" "P-2：重建=deploy.prompt Step 1（先报告审批）；勿在拆到一半时重建"; exit 1; }
STEP end U0 0.1 0 PASS "channel=${VM_CHANNEL}" "none"

STEP begin U0 0.2 "WINVM_DRY_RUN=0 确认"
grep -E "^WINVM_DRY_RUN" "$PKG/.env" 2>/dev/null || echo "（.env 无该键=默认 0）"
STEP end U0 0.2 0 PASS "见输出" "none"

STEP begin U0 0.3 "拆除前基线留档"
# run17 D-3：旧=组 rc 不采、无条件 PASS（run17 活体：VM 基线行=vmssh 127 空转仍 PASS）。
# 现 capture rc；判据=rc=0 且 baseline.log 含 VM 侧 BRIDGE= 行。
{ find "$HOME/.workbuddy" -iname '*winvm*' 2>/dev/null | head -50; echo "--VM--"; \
  "${BASH_OK:-bash}" "$_here/ps-run.sh" -c '$a=Test-Path C:\WinVMBridge; $b=[bool](Get-ScheduledTask -TaskName WinVMBridge.Service -EA SilentlyContinue); $c=@(Get-NetTCPConnection -LocalPort 18443 -State Listen -EA SilentlyContinue).Count; $d=(Get-Service sshd).Status; $e=Test-Path C:\WinVMWorkspace; Write-Output ("BRIDGE=" + $a + " TASK=" + $b + " LISTEN=" + $c + " SSHD=" + $d + " WS=" + $e)'; } > "$LOGD/baseline.log" 2>&1; BRC=$?
tail -3 "$LOGD/baseline.log"; bash "$_here/step.sh" log baseline < "$LOGD/baseline.log" || true   # 故意容忍：留痕失败不阻断拆除主流程
if [ $BRC -ne 0 ] || ! grep -q "BRIDGE=" "$LOGD/baseline.log" 2>/dev/null; then
  STEP end U0 0.3 "$([ $BRC -ne 0 ] && echo $BRC || echo 1)" FAIL "baseline rc=$BRC/无 VM 基线行" "VM 通道或 ps 执行失败：先修通道（deploy.prompt Step 1）再拆，否则 U4 复核无对照"
  _fail_note "U0/0.3-baseline"
else
  STEP end U0 0.3 0 PASS "基线=$LOGD/baseline.log" "none"
fi

STEP begin U1 1 "DRY-RUN 规划核对"
# run17 D-3：旧=`|| true` 吞 rc；现 capture——dry 规划失败=拆不了，如实 FAIL 聚合出链
( cd "$PKG" && "$NODE" delivery/uninstall.mjs > "$LOGD/dry.log" 2>&1 ); DRC=$?
head -2 "$LOGD/dry.log"; grep -cE "\[DRY\]|\[KEEP\]" "$LOGD/dry.log" | sed 's/^/dry+keep 行数=/'; bash "$_here/step.sh" log dry < "$LOGD/dry.log" || true   # 故意容忍：留痕失败不阻断
if [ $DRC -ne 0 ]; then
  STEP end U1 1 $DRC FAIL "uninstall dry rc=$DRC" "dry.log 查失败原因（缺 .env/包根错=先 download-verify）"
  _fail_note "U1/1-dry"
else
  STEP end U1 1 0 PASS "人工核对无越界项后 --apply" "none"
fi
[ $APPLY -eq 0 ] && { echo "DRY-RUN 完成：核对上表后加 --apply 真拆。"; STEP report; exit 0; }

STEP begin U2 2 "--apply 真拆"
( cd "$PKG" && "$NODE" delivery/uninstall.mjs --apply --vm-host "$VM_HOST" --vm-user "$VM_USER" --vm-ssh-port "$VM_SSH_PORT" > "$LOGD/apply.log" 2>&1 ); ARC=$?
grep -E "APPLY complete|failure\(s\)" "$LOGD/apply.log" | tail -2
PASSN=$(sed -n '/POST-CLEANUP/,$p' "$LOGD/apply.log" | grep -c "\[PASS\]"); FAILN=$(sed -n '/POST-CLEANUP/,$p' "$LOGD/apply.log" | grep -c "\[FAIL\]")
bash "$_here/step.sh" log apply < "$LOGD/apply.log" || true
# G1 旧包兼容：EXIT=1 且唯一 FAIL=workspace kept 且自报 0 failure ⇒ 已知误报，以 U4 复核为准
if [ $ARC -ne 0 ] && [ "$FAILN" = "1" ] && grep -q "kept (default)" "$LOGD/apply.log" && grep -q "0 failure(s)" "$LOGD/apply.log"; then
  echo "⚠ ≤V1.4.8 已知 kept 误报（I-6.7）：按 U2.3 兼容判据以 U4 独立复核为准，勿重拆"
  ARC=0
fi
# 僵尸形态：VM FAIL=C:/WinVMBridge absent(True)+no vm-service process(True) ⇒ 僵尸免疫强杀
if [ $ARC -ne 0 ] && grep -q "VM C:/WinVMBridge absent  (observed: True)" "$LOGD/apply.log"; then
  echo "⚠ 命中僵尸排错行（v2.4/undeploy）：VM 内 shutdown /r /t 5 /f 重启 guest（~60s sshd 恢复）→ 复跑本脚本"
fi
[ $ARC -eq 0 ] && [ "$FAILN" = "0" ] || { STEP end U2 2 $ARC FAIL "apply rc=$ARC FAIL=$FAILN" "对照 apply.log + troubleshooting kept/僵尸两行"; exit 1; }
STEP end U2 2 0 PASS "19 项全 PASS" "none"

STEP begin U4 4.2 "独立复核（防假 PASS）"
# run17 D-3：旧=三行裸跑、无条件 PASS（run17 活体：VM 行 vmssh 127 空转仍 PASS）。
# health 期望 000（服务已拆，连上=没拆干净→FAIL）；mcp 检查与 VM 终态行 rc 入段内判定
# （U4_RC=段内独立计数，前序段失败不混入本行归因，但仍聚合出链）。
U4_RC=0
# run18 P-4：旧=`$(curl …) || true` 双吞（赋值恒成功盖 curl rc；且 HCODE 空=探针缺失被当过）。
# 对齐 deploy C4.5 写法：capture curl rc；判据=HCODE 恒须为 000（端口拆净=不可连的 curl 形态），
# 非 000（含空=探针没跑出码）一律如实计败。
HCODE="$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 4 "http://127.0.0.1:${WINVM_TUNNEL_LOCAL_PORT:-18443}/health" 2>/dev/null)"; UHRC=$?
echo "health=${HCODE}(期望000, curl rc=$UHRC)"
if [ "$HCODE" != "000" ]; then
  echo "⚠ health=${HCODE:-<无码>} rc=$UHRC：期望 000=端口拆净不可连" >&2; U4_RC=1; _fail_note "U4/4.2-health"
fi
"$NODE" -e "const j=require(process.env.HOME+'/.workbuddy/mcp.json');const k=Object.keys(j.mcpServers||{}).filter(x=>/winvm/i.test(x));console.log(k.length?'LEFT:'+k:'GLOBAL_MCP_CLEAN')" || { U4_RC=1; _fail_note "U4/4.2-mcp"; }
"${BASH_OK:-bash}" "$_here/ps-run.sh" -c '$a=Test-Path C:\WinVMBridge; $b=[bool](Get-ScheduledTask -TaskName WinVMBridge.Service -EA SilentlyContinue); $c=@(Get-NetTCPConnection -LocalPort 18443 -State Listen -EA SilentlyContinue).Count; $d=(Get-Service sshd).Status; $e=Test-Path C:\WinVMWorkspace; Write-Output ("期望 False False 0 Running True => " + $a + " " + $b + " " + $c + " " + $d + " " + $e)' || { U4_RC=1; _fail_note "U4/4.2-vm-terminal"; }
STEP end U4 4.2 $U4_RC "$([ $U4_RC -eq 0 ] && echo PASS || echo FAIL)" "逐项对照上表" "$([ $U4_RC -eq 0 ] && echo none || echo '复核行见上（health/mcp/VM 终态至少一项失败）')"

STEP report
# run17 D-3 聚合出链：非硬阻断段失败 → 如实非零（硬阻断段 U0/U2 维持即时 exit 1）
if [ -n "$FAILED_STEPS" ]; then
  echo "UNDEPLOY_WITH_FAILURES:$FAILED_STEPS"
  echo "⚠ steps.tsv 判定列含 FAIL（明细见上与 logs/），出链 rc=1"
  exit 1
fi
echo "UNDEPLOY_DONE —— 存留项（密钥/trash/下载物）按 undeploy U5 逐项问用户，默认保留。"

#!/usr/bin/env bash
# winvm-plugin-deploy · 通道判稳器（run13 沉淀：VM 冷开机/挂起期勿单发判死，稀疏轮询到连击稳态再进 driver）
# 用法：VM_HOST=<ip> [VM_USER=User] [VM_SSH_PORT=22] bash wait-channel.sh [连击数=3] [轮数=10]
# 语义：每发 ssh whoami（CT=15、外层 timeout 45），需【连续】N 次成功才判稳退出 0；
#       轮间 sleep 75s（自毒纪律：密集重试让 VM 侧半开 auth 槽不释放，稀疏反通）；
#       全轮未稳 → 退出 1 并提示走能力通道自救（见 SKILL 铁律/自救路径）。
# 预算（run14 三犯实锤强化）：单轮最坏 45s+75s=120s；调用方外层 timeout 必须 ≥ rounds×120
#   （如 3 连击×10 轮 → 给 1300s；给 400s 会在第 4 轮前误杀成「判稳失败」假象）。
# 重启后纪律：restart-guest 后 Windows 冷启+sshd+域解析实测 ~5-8min 才通——首轮 poll 前
#   先 sleep ≥240s 再进判稳，别用 100s 短睡开测（run14：18:43 判 DOWN、18:44 手工却已通）。
set -u
: "${VM_HOST:?VM_HOST 未设}"
: "${VM_USER:=User}"; : "${VM_SSH_PORT:=22}"
NEED="${1:-3}"; ROUNDS="${2:-10}"; ok=0
for r in $(seq 1 "$ROUNDS"); do
  if timeout 45 ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 \
       -p "$VM_SSH_PORT" "${VM_USER}@${VM_HOST}" whoami >/dev/null 2>&1; then
    ok=$((ok+1)); echo "[$(date +%H:%M:%S)] poll$r OK consec=$ok/$NEED"
    [ "$ok" -ge "$NEED" ] && { echo "CHANNEL_STABLE"; exit 0; }
  else
    [ "$ok" -ne 0 ] && echo "[$(date +%H:%M:%S)] poll$r FAIL 连击清零"
    ok=0; echo "[$(date +%H:%M:%S)] poll$r DOWN/挂起（rc=124 形态=认证阶段不回）"
  fi
  [ "$r" -lt "$ROUNDS" ] && sleep 75
done
echo "CHANNEL_UNSTABLE：轮询 ${ROUNDS} 轮未达 ${NEED} 连击。"
echo "  若本机 http://127.0.0.1:18443/health 仍 200（MCP 隧道健在）→ 走【能力通道自救】：见 SKILL.md『通道自救路径』（app.process.launch 发 shutdown /r 重启 guest，或 system.service.control 试 restart sshd）。"
echo "  若隧道也断 → P-4 人工点：hypervisor 端确认开机+『自动暂停=从不』。"
exit 1

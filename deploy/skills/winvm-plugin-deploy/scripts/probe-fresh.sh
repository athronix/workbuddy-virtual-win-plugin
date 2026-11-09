#!/usr/bin/env bash
# probe-fresh.sh · 探针新鲜复用判定（纯函数式，零网络零副作用；供 verify.sh 与单测共用事实源）
#
# v1.3.0 时间预算战役（run22 账本=装完立即 verify 把同 3 探针冷跑第二遍，+~240s）。
# deploy C5 全过落 stamp；verify 调本判定决定 REUSE。防假绿三防线：
#   ① 时效窗：stamp.epoch 距今 < PROBE_FRESH_BUDGET_S（默认 600）
#   ② 同包根：stamp.pkg == 当前 PKG（换了包根=不同事实，绝不复用）
#   ③ 强制冷跑：VERIFY_FORCE_PROBE=1 直接 REUSE=0
# 另：stamp 缺失/损坏/epoch 非法 ⇒ REUSE=0（保守=宁可多跑探针，不可假绿复用）。
#
# 输入（env）：VMDEPLOY_PROBE_STAMP（stamp 路径）/ PROBE_PKG（当前包根）/
#             VERIFY_FORCE_PROBE / PROBE_FRESH_BUDGET_S / PROBE_FRESH_NOW（注入当前秒，单测用）
# 输出：stdout 两行 "REUSE=0|1" 与 "REASON=..."；exit 恒 0（判定不是错误源，调用方读 REUSE）。
set -u
STAMP="${VMDEPLOY_PROBE_STAMP:-$HOME/wbtmp/vmdeploy-probes-stamp.txt}"
PKG="${PROBE_PKG:-}"
FORCE="${VERIFY_FORCE_PROBE:-0}"
BUDGET="${PROBE_FRESH_BUDGET_S:-600}"
NOW="${PROBE_FRESH_NOW:-$(date +%s)}"

if [ "$FORCE" = "1" ]; then echo "REUSE=0"; echo "REASON=VERIFY_FORCE_PROBE=1（强制冷跑）"; exit 0; fi
if [ ! -f "$STAMP" ]; then echo "REUSE=0"; echo "REASON=stamp 缺失 $STAMP（首跑/未装态）"; exit 0; fi

SE="$(sed -n 's/^epoch=//p' "$STAMP" 2>/dev/null | head -1 | tr -d ' \r')"
SP="$(sed -n 's/^pkg=//p' "$STAMP" 2>/dev/null | head -1 | tr -d '\r')"

if [ -z "$SE" ] || ! echo "$SE" | grep -qE '^[0-9]+$'; then echo "REUSE=0"; echo "REASON=stamp epoch 非法/缺（$SE）"; exit 0; fi
AGE=$(( NOW - SE ))
if [ "$AGE" -lt 0 ]; then echo "REUSE=0"; echo "REASON=stamp 时钟超未来 age=$AGE（异常，不复用）"; exit 0; fi
if [ "$AGE" -ge "$BUDGET" ]; then echo "REUSE=0"; echo "REASON=超新鲜窗 age=${AGE}s>=budget=${BUDGET}s"; exit 0; fi
if [ -z "$PKG" ] || [ "$SP" != "$PKG" ]; then echo "REUSE=0"; echo "REASON=包根不匹配 stamp.pkg=[$SP] != 当前=[$PKG]"; exit 0; fi
echo "REUSE=1"; echo "REASON=fresh age=${AGE}s<${BUDGET}s 且同包根"
exit 0

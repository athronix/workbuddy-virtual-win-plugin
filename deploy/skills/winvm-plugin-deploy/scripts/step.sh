#!/usr/bin/env bash
# winvm-plugin-deploy · 分步计时/留痕器（满足「每个细分环节：运行时长 + 问题 + 解决方案」的采集底座）
# 用法：
#   step.sh begin <phase> <step-id> "<desc>"                     # 记开始时间
#   step.sh end   <phase> <step-id> <rc> <PASS|FAIL|SKIP> "<判据>" ["<问题/解决方案>"]
#   step.sh log   <step-id>            # 从 stdin 收该步原始输出存 logs/<step>.log
#   step.sh report                     # 汇总：总时长/Top5/问题清单/产物路径
# 产物：$RUN_DIR/steps.tsv（列见头）、$RUN_DIR/logs/*.log、$RUN_DIR/summary.txt
set -u
RUN_DIR="${VMDEPLOY_RUN_DIR:-${HOME}/wbtmp/vmdeploy-run-$(date +%Y%m%d)}"
mkdir -p "$RUN_DIR/logs" "$RUN_DIR/stamps"
TSV="$RUN_DIR/steps.tsv"
: "${NODE:=$(command -v node || true)}"
[ -f "$TSV" ] || printf 'phase\tstep\tdesc\tbegin_utc\tend_utc\tdur_s\trc\tresult\tjudged\tissues_solution\n' > "$TSV"
now_iso() { date -u +%FT%TZ; }

cmd="${1:-report}"; shift || true
case "$cmd" in
  begin)
    step="${2:?step-id}"; desc="${3:-}"
    date -u +%s > "$RUN_DIR/stamps/$step"
    printf '%s\t%s\t%s\n' "${1:?phase}" "$(now_iso)" "$desc" > "$RUN_DIR/stamps/$step.meta"
    echo "[$(now_iso)] BEGIN ${1}/${step} ${desc}"
    ;;
  end)
    phase="${1:?}"; step="${2:?}"; rc="${3:-0}"; result="${4:-PASS}"; judged="${5:-}"; issue="${6:-none}"
    st="$RUN_DIR/stamps/$step"; b=$( [ -f "$st" ] && cat "$st" || echo "")
    e=$(date -u +%s)
    dur=$([ -n "$b" ] && echo $((e - b)) || echo "")
    meta="$RUN_DIR/stamps/$step.meta"; b_iso=$( [ -f "$meta" ] && cut -f2 "$meta" || echo ""); desc=$( [ -f "$meta" ] && cut -f3 "$meta" || echo "")
    _safe() { printf '%s' "${1:-}" | tr '\t\n\r' '   '; }
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$phase" "$step" "$(_safe "$desc")" "$b_iso" "$(now_iso)" "${dur:-}" \
      "$rc" "$result" "$(_safe "$judged")" "$(_safe "$issue")" >> "$TSV"
    echo "[$(now_iso)] END ${phase}/${step} rc=${rc} ${result} dur=${dur}s"
    ;;
  log)
    step="${1:?step-id}"; cat > "$RUN_DIR/logs/$step.log"; echo "LOG_SAVED=$RUN_DIR/logs/$step.log"
    ;;
  report)
    awk -F'\t' 'NR>1{n++; if($6!=""){s+=$6; if($6>max){max=$6;mrow=$1"/"$2" "$6"s"}} if($10!="none"&&$10!="")iss++}
      END{printf "steps=%d sum_dur=%ds slowest=[%s] issue_rows=%d\n", n+0, s+0, mrow, iss+0}' "$TSV"
    echo "--- Top5 by dur ---"
    awk -F'\t' 'NR>1 && $6!=""{print $6"\t"$1"/"$2"\t"$3}' "$TSV" | sort -rn | head -5
    echo "--- 问题行 ---"
    awk -F'\t' 'NR>1 && $10!="none" && $10!=""{print "· "$1"/"$2": "$10}' "$TSV"
    echo "--- 失败/跳过 ---"
    awk -F'\t' 'NR>1 && ($7!="0" || $8!="PASS"){print "· "$1"/"$2" rc="$7" "$8" "$10}' "$TSV"
    cp "$TSV" "$RUN_DIR/summary.txt" 2>/dev/null
    echo "TSV=$TSV"; echo "LOGS=$RUN_DIR/logs"
    ;;
  *) echo "用法：step.sh begin|end|log|report …" >&2; exit 2 ;;
esac

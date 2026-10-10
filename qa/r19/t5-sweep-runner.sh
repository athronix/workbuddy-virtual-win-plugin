#!/bin/bash
# P2-T5 full-repo per-file sweep (baseline reconciliation: 85 files / 1612 cases must only improve).
# Discipline: NEVER glob-batch; spawn one `node --test <file>` per file (same as npm run test:unit).
cd /storage/Users/currentUser/Documents/projects/workbuddy-virtual-win-plugin || exit 1
NODE=/data/storage/el1/bundle/libs/arm64/node/bin/node
OUT=/storage/Users/currentUser/wbtmp/p2t5-sweep-result.txt
{
  echo "sweep_started=$(date '+%Y-%m-%dT%H:%M:%S+08:00')"
  echo "node=$($NODE --version)"
  files=0; failed=0; total_tests=0; total_pass=0; total_fail=0
  for f in tests/unit/*.test.js tests/unit/*.test.mjs; do
    [ -e "$f" ] || continue
    files=$((files+1))
    out=$($NODE --test "$f" 2>&1); rc=$?
    t=$(printf '%s' "$out" | grep -a '^ℹ tests ' | tail -1 | awk '{print $3}')
    p=$(printf '%s' "$out" | grep -a '^ℹ pass ' | tail -1 | awk '{print $3}')
    fl=$(printf '%s' "$out" | grep -a '^ℹ fail ' | tail -1 | awk '{print $3}')
    t=${t:-0}; p=${p:-0}; fl=${fl:-0}
    total_tests=$((total_tests+t)); total_pass=$((total_pass+p)); total_fail=$((total_fail+fl))
    # RED 判定：exit≠0 或 fail≠0 或压根没有汇总行（崩溃/超时）
    if [ "$rc" -ne 0 ] || [ "$fl" != "0" ] || ! printf '%s' "$out" | grep -qaE '^ℹ pass [0-9]+'; then
      failed=$((failed+1))
      echo "RED   $f rc=$rc tests=$t pass=$p fail=$fl"
    else
      echo "GREEN $f rc=$rc tests=$t pass=$p fail=$fl"
    fi
  done
  echo "sweep_finished=$(date '+%Y-%m-%dT%H:%M:%S+08:00')"
  echo "FILES=$files FAILED_FILES=$failed TOTAL_TESTS=$total_tests TOTAL_PASS=$total_pass TOTAL_FAIL=$total_fail"
  echo "BASELINE: files=85 tests=1612 (must only improve)"
} > "$OUT" 2>&1
echo "SWEEP_EXIT_RECORD_DONE rc_files_summary:"
tail -3 "$OUT"

#!/bin/bash
# ============================================================================
# build.sh — WinVM Bridge 演示 App 构建包装
# 供 CodeArts Agent（鸿蒙 PC 内置 DevEco CLI）或标准 DevEco Studio 执行。
#
# 用法:
#   bash tools/build.sh lint     # 仅跑 ArkTS codelinter 规则检查
#   bash tools/build.sh build    # 仅构建 HAP
#   bash tools/build.sh all      # lint + build（默认）
#
# 所有输出同时落盘到 .codeart-out/ (供 WorkBuddy 回读分析)
# 退出码: 0=成功, 非0=有错误/未找到工具
# ============================================================================

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/.codeart-out"
mkdir -p "$OUT"
TS="$(date +%Y%m%d-%H%M%S)"

log() { echo "[$(date +%H:%M:%S)] $*"; }

ACTION="${1:-all}"

# ---------------------------------------------------------------------------
# 1) ArkTS 规则检查 (codelinter)
# ---------------------------------------------------------------------------
run_lint() {
  log "==> [1/2] codelinter (ArkTS 规则检查)"
  local out="$OUT/codelinter-$TS.log"
  : > "$out"

  # 策略 1: 直接用 codelinter CLI（DevEco command-line-tools / CodeArts Agent 内置）
  if command -v codelinter >/dev/null 2>&1; then
    log "    使用 codelinter CLI"
    codelinter --project "$ROOT" 2>&1 | tee -a "$out"
    return ${PIPESTATUS[0]}
  fi

  # 策略 2: 走 hvigorw 的 code-linter 任务（若 wrapper 已生成）
  if [ -f "$ROOT/hvigorw" ]; then
    log "    使用 ./hvigorw code-linter"
    bash "$ROOT/hvigorw" code-linter --project "$ROOT" 2>&1 | tee -a "$out"
    return ${PIPESTATUS[0]}
  fi

  log "ERR: 未找到 codelinter / hvigorw。"
  log "     请在 CodeArts Agent 中用内置 DevEco CLI 执行 Code Linter，并把完整输出贴到: $out"
  return 2
}

# ---------------------------------------------------------------------------
# 2) 构建 HAP (assembleHap)
# ---------------------------------------------------------------------------
run_build() {
  log "==> [2/2] assembleHap (构建 HAP)"
  local out="$OUT/assembleHap-$TS.log"
  : > "$out"

  if [ -f "$ROOT/hvigorw" ]; then
    log "    使用 ./hvigorw assembleHap"
    bash "$ROOT/hvigorw" assembleHap 2>&1 | tee -a "$out"
    return ${PIPESTATUS[0]}
  fi

  log "ERR: 未找到 hvigorw wrapper。"
  log "     请在 CodeArts Agent 中: 1) Sync / ohpm install  2) 用内置 DevEco CLI 构建 HAP"
  log "     并把完整输出贴到: $out"
  return 2
}

# ---------------------------------------------------------------------------
# 分发
# ---------------------------------------------------------------------------
case "$ACTION" in
  lint)
    run_lint; rc=$?
    ;;
  build)
    run_build; rc=$?
    ;;
  all)
    run_lint; r1=$?
    run_build; r2=$?
    rc=$(( r1 + r2 ))
    ;;
  *)
    log "未知动作: $ACTION （请用 lint | build | all）"
    rc=3
    ;;
esac

log "==> 完成, rc=$rc ; 日志/产物见 $OUT"
exit $rc

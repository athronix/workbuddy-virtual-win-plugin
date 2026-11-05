#!/usr/bin/env bash
# winvm-plugin-deploy · 包根选根共享探测（run19 R-1 传导缺口——deploy/undeploy/verify 三 driver 统一事实源）
# 背景：run18 P-1 隔离重解后，overall-root 外层可能只剩「.env+overall/」空壳（真包根=内层 zip
# 原始布局）；旧 undeploy.sh/verify.sh 的 PKG 默认值硬指外层 ⇒ Cannot find module/缺 qa 假阻。
# 本文件 source 即用（零副作用），提供：
#   _pkg_layer_valid  $1=层路径         → MANIFEST.txt+delivery 双在=合法层
#   _pkg_layer_version $1=层路径         → echo 声明版本（CRLF 容错；空=无 MANIFEST）
#   _pick_pkg_root    [TAG] [strict]    → echo 选中层路径 rc=0 / rc=1 无合法层
#       优先版本匹配层（内层优先）；非 strict 回退任一层（内层优先）；strict=仅认版本匹配。
#   resolve_pkg_root  [TAG]             → 三级默认：env PKG_ROOT > $PKG_ROOT_STATE 状态文件 >
#       _pick_pkg_root 现探；产物写 PKG_RESOLVED/PKG_SOURCE，全落空 rc=1（调用方报错含人工处置提示）。
#       保底兼容：旧单平面布局（仅外层合法）经「现探」自然命中；「旧默认」本体不再被静默使用。
: "${DEPLOY_ROOT:=${HOME}/winvm-deploy}"
PKG_ROOT_STATE="${PKG_ROOT_STATE_FILE:-$DEPLOY_ROOT/pkg-root.txt}"

_pkg_layer_valid() { [ -f "${1:-}/MANIFEST.txt" ] && [ -d "${1:-}/delivery" ]; }

_pkg_layer_version() {
  [ -f "${1:-}/MANIFEST.txt" ] || { echo ""; return 0; }
  tr -d '\r' < "$1/MANIFEST.txt" | sed -n 's/^version:[[:space:]]*//p' | head -1
}

_pick_pkg_root() {
  local tag="${1:-}" strict="${2:-}" r
  local _inner="$DEPLOY_ROOT/overall-root/overall" _outer="$DEPLOY_ROOT/overall-root"
  if [ -n "$tag" ]; then
    for r in "$_inner" "$_outer"; do
      _pkg_layer_valid "$r" && [ "$(_pkg_layer_version "$r")" = "$tag" ] && { echo "$r"; return 0; }
    done
  fi
  [ "$strict" = "strict" ] && return 1
  for r in "$_inner" "$_outer"; do
    _pkg_layer_valid "$r" && { echo "$r"; return 0; }
  done
  return 1
}

resolve_pkg_root() {
  local tag="${1:-}" s p
  if [ -n "${PKG_ROOT:-}" ]; then PKG_RESOLVED="$PKG_ROOT"; PKG_SOURCE="env PKG_ROOT"; return 0; fi
  if [ -f "$PKG_ROOT_STATE" ]; then
    s="$(head -1 "$PKG_ROOT_STATE" | tr -d '\r\n')"
    if [ -n "$s" ] && _pkg_layer_valid "$s"; then PKG_RESOLVED="$s"; PKG_SOURCE="state($PKG_ROOT_STATE)"; return 0; fi
  fi
  if p="$(_pick_pkg_root "$tag")"; then PKG_RESOLVED="$p"; PKG_SOURCE="probe"; return 0; fi
  PKG_RESOLVED=""; PKG_SOURCE=""
  return 1
}

# pkg_root_usage_error：三 driver 共用的「找不到合法包根」报错文案（含人工处置，勿静默空壳）
pkg_root_usage_error() {
  echo "PKG_ROOT_NOT_FOUND：$DEPLOY_ROOT/overall-root 下无合法包根（层=MANIFEST.txt+delivery 双在；可能被隔离/半解/空壳）。处置三选一：" >&2
  echo "  ① 显式覆盖：PKG_ROOT=<包根> bash <driver>.sh 或 --pkg <包根>（undeploy 拆除场景包根或已被移走=指回 stale-quarantine/ 内恢复的完整层）" >&2
  echo "  ② 重取包：bash download-verify.sh（隔离重解后自动写 pkg-root.txt）" >&2
  echo "  ③ P-4 类人工处置：检查 $DEPLOY_ROOT/stale-quarantine/ 与 overall-root 现状，必要时手工摆放后再跑" >&2
}

# 非 source 直跑=自测模式（三场景快速自检）
if [ "${BASH_SOURCE[0]:-$0}" = "${0}" ]; then
  _pick_pkg_root "${1:-}" || echo "NO_ROOT"
fi

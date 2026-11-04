#!/usr/bin/env bash
# winvm-plugin-deploy · Step 0 之一：宿主运行时探测（冒烟门禁，D1/I-6.11 教训产品化）
# 用途：产出 $OUT（默认 ~/wbtmp/vmdeploy-env.sh）——后续所有脚本与手工命令 source 它。
# 纪律：绝不硬编码路径；每个候选必须通过对应冒烟（node 跑 .mjs、python 跑 -c、bash 跑 true）
#       才算可用——部分鸿蒙宿主 /data/service/hnp 系 node、/bin/bash、/bin/rm 是损坏/脆弱 shim。
# 用法：bash env-detect.sh [--out <path>]
set -u
OUT="${HOME}/wbtmp/vmdeploy-env.sh"
[ "${1:-}" = "--out" ] && OUT="${2:?--out 需要路径}"

probe_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
mkdir -p "$(dirname "$OUT")"
SMOKE_MJS="${HOME}/wbtmp/.vmdeploy-node-smoke.mjs"
printf 'console.log("NODE_SMOKE_OK")\n' > "$SMOKE_MJS" 2>/dev/null || { echo "SMOKE_DIR_WRITE_FAILED dir=$HOME/wbtmp（改 --out 到可写目录并先建父目录）" >&2; exit 1; }

pick_node() {
  local c
  for c in "$(command -v node 2>/dev/null || true)" /data/storage/el1/bundle/libs/arm64/node/bin/node /data/service/hnp/bin/node; do
    [ -n "$c" ] && [ -x "$c" ] || continue
    [ "$("$c" "$SMOKE_MJS" 2>/dev/null)" = "NODE_SMOKE_OK" ] || continue
    echo "$c"; return 0
  done; return 1
}
pick_py() {
  local c
  for c in "$(command -v python3 2>/dev/null || true)" /data/service/hnp/bin/python3 /data/storage/el1/bundle/libs/arm64/python/bin/python3; do
    [ -n "$c" ] && [ -x "$c" ] || continue
    "$c" -c 'print(1)' >/dev/null 2>&1 || continue
    echo "$c"; return 0
  done; return 1
}
pick_bash() {
  local c
  for c in "$(command -v bash 2>/dev/null || true)" /data/storage/el1/bundle/libs/arm64/bash/bin/bash /bin/bash; do
    [ -n "$c" ] && [ -x "$c" ] || continue
    "$c" -c 'true' >/dev/null 2>&1 || continue          # X-1/D-1：/bin/bash 可能是 bad interpreter
    printf '#!/bin/sh\necho BASH_SPAWN_OK\n' > "${HOME}/wbtmp/.vmdeploy-bash-probe.sh"
    chmod +x "${HOME}/wbtmp/.vmdeploy-bash-probe.sh" 2>/dev/null
    # 关键：要能执行带 shebang 的脚本文件（askpass/wrapper 依赖这一点，不止 -c）
    "$c" "${HOME}/wbtmp/.vmdeploy-bash-probe.sh" 2>/dev/null | grep -q BASH_SPAWN_OK || continue
    echo "$c"; return 0
  done; return 1
}
pick_rm() {  # X-2：/bin/rm 常为坏 shim → 提供 node fs 删除函数替代
  local c
  for c in "$(command -v rm 2>/dev/null || true)" /usr/bin/rm; do
    [ -n "$c" ] && [ -x "$c" ] || continue
    touch "${HOME}/wbtmp/.vmdeploy-rm-probe" && "$c" -f "${HOME}/wbtmp/.vmdeploy-rm-probe" 2>/dev/null \
      && [ ! -e "${HOME}/wbtmp/.vmdeploy-rm-probe" ] && { echo "$c"; return 0; }
  done; return 1
}

NODE="$(pick_node)"   || { echo "NO_HEALTHY_NODE（逐个候选 .mjs 冒烟全挂）" >&2; exit 1; }
PY="$(pick_py)"       || { echo "NO_HEALTHY_PYTHON3" >&2; exit 1; }
BASH_OK="$(pick_bash)" || BASH_OK="$NODE"   # 无健康 bash 时后续脚本改走 $NODE -e 兜底
RM_OK="$(pick_rm)"    || RM_OK=""

cat > "$OUT" <<EOF
# 由 scripts/env-detect.sh 生成于 $(date -u +%FT%TZ)——冒烟通过后才登记
export NODE='${NODE}'
export PY='${PY}'
export BASH_OK='${BASH_OK}'
export VMDEPLOY_PROBE_DIR='${probe_dir}'
export VMDEPLOY_ENV_SH='${OUT}'
EOF
chmod 644 "$OUT"

echo "ENV_WRITTEN=$OUT"
echo "NODE=$NODE"
echo "PY=$PY"
echo "BASH_OK=${BASH_OK}"
echo "RM_USABLE=${RM_OK:-none（用 fs_rm 函数：$NODE -e fs.rmSync）}"
"$NODE" -e 'console.log("SELF_CHECK_OK")' >/dev/null 2>&1 && echo "SMOKE_NODE_FINAL=OK"

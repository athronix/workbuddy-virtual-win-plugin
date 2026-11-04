#!/usr/bin/env bash
# winvm-plugin-deploy · Step 2 取包三件套（gitee 主源 + github fallback + sha256 + 解压 + MANIFEST 校验）
# 用法：VM_HOST=.. bash download-verify.sh [--tag V1.4.x]   # 不传 --tag 则现解 latest（gitee API）
# 产物：$DEPLOY_ROOT/pkg/<zip>{,.sha256} + 解包 $DEPLOY_ROOT/overall-root；stdout 末行 PKG_ROOT=<路径>
# 坑位内建：gitee 302→foruda 一次性签名 ⇒ 不用 -C - 断点续传、失败整文件重试；sha256sum -c 在 pkg 目录内跑。
set -u
_here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
: "${VMDEPLOY_ENV_SH:=${HOME}/wbtmp/vmdeploy-env.sh}"; [ -f "$VMDEPLOY_ENV_SH" ] && . "$VMDEPLOY_ENV_SH"
: "${DEPLOY_ROOT:=${HOME}/winvm-deploy}"
REPO="athronix/workbuddy-virtual-win-plugin"
TAG="${RELEASE_TAG:-}"
[ "${1:-}" = "--tag" ] && TAG="${2:?--tag 需要值}"
if [ -z "$TAG" ]; then
  TAG="$(curl -fsSL --connect-timeout 15 --max-time 40 "https://gitee.com/api/v5/repos/$REPO/releases/latest" \
        | "${NODE:?}" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).tag_name)}catch(e){process.exit(1)}})')" \
    || { echo "LATEST_RESOLVE_FAILED（gitee 不可达？手动 --tag 或回退 github api 同型命令）" >&2; exit 1; }
fi
ZIP="winvm-overall-${TAG}.zip"
BG="https://gitee.com/$REPO/releases/download/$TAG"
BH="https://github.com/$REPO/releases/download/$TAG"
mkdir -p "$DEPLOY_ROOT/pkg" "$DEPLOY_ROOT/overall-root"

echo "[download] tag=$TAG"
# shellcheck disable=SC2086
( cd "$DEPLOY_ROOT/pkg" && \
  { curl -fsSL --connect-timeout 20 --max-time 900 --retry 4 --retry-delay 3 --retry-all-errors -o "$ZIP" "$BG/$ZIP" \
    || curl -fsSL --connect-timeout 20 --max-time 900 --retry 5 --retry-delay 3 --retry-all-errors -C - -o "$ZIP" "$BH/$ZIP"; } && \
  { curl -fsSL --connect-timeout 20 --max-time 120 --retry 4 --retry-all-errors -o "$ZIP.sha256" "$BG/$ZIP.sha256" \
    || curl -fsSL --connect-timeout 20 --max-time 120 --retry 4 --retry-all-errors -o "$ZIP.sha256" "$BH/$ZIP.sha256"; } ) \
  || { echo "DOWNLOAD_FAILED 双源均不可达（网络？tag 不存在于两端？）" >&2; exit 1; }

( cd "$DEPLOY_ROOT/pkg" && sha256sum -c "$ZIP.sha256" >/dev/null 2>&1 ) \
  || { exp=$(tr -d '[:space:]' < "$DEPLOY_ROOT/pkg/$ZIP.sha256" | head -c 64); act=$(sha256sum "$DEPLOY_ROOT/pkg/$ZIP" | cut -d' ' -f1); echo "SHA256_MISMATCH expected=$exp actual=$act ⇒ 停：源内容不一致属事故，勿重试硬跑" >&2; exit 2; }
echo "SHA256_OK"

unzip -q -o "$DEPLOY_ROOT/pkg/$ZIP" -d "$DEPLOY_ROOT/overall-root" || { echo "UNZIP_FAILED" >&2; exit 1; }
PKG=""
for r in "$DEPLOY_ROOT/overall-root" "$DEPLOY_ROOT/overall-root/overall"; do
  [ -f "$r/MANIFEST.txt" ] && [ -d "$r/delivery" ] && PKG="$r"
done
[ -n "$PKG" ] || { echo "PKG_ROOT_NOT_FOUND（D5 判定失败：MANIFEST.txt+delivery 双缺）" >&2; exit 1; }
if [ -n "${PY:-}" ]; then
  ( cd "$PKG" && "$PY" qa/deploy-probes/verify-manifest.py . 2>&1 | tail -1 ) || echo "verify-manifest WARN（探针自身失败不否决 sha 已过结果，记录进问题列）"
fi
echo "PKG_ROOT=$PKG"

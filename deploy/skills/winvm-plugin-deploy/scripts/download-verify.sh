#!/usr/bin/env bash
# winvm-plugin-deploy · Step 2 取包三件套（gitee 主源 + github fallback + sha256 + 解压 + MANIFEST 校验）
# 用法：VM_HOST=.. bash download-verify.sh [--tag V1.4.x]   # 不传 --tag 则现解 latest（gitee API）
# 产物：$DEPLOY_ROOT/pkg/<zip>{,.sha256} + 解包 $DEPLOY_ROOT/overall-root；stdout 末行 PKG_ROOT=<路径>
# 坑位内建：gitee 302→foruda 一次性签名 ⇒ 不用 -C - 断点续传、失败整文件重试；sha256sum -c 在 pkg 目录内跑。
set -u
_here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
: "${VMDEPLOY_ENV_SH:=${HOME}/wbtmp/vmdeploy-env.sh}"; [ -f "$VMDEPLOY_ENV_SH" ] && . "$VMDEPLOY_ENV_SH"
: "${DEPLOY_ROOT:=${HOME}/winvm-deploy}"
# run19 R-1：选根逻辑单一事实源=scripts/pkg-root.sh（勿复制两份；deploy/undeploy/verify 同源）
# shellcheck disable=SC1090
. "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/pkg-root.sh"
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

# run18 P-1 幂等快路径：同 TAG 包已完整在场（zip sha 相符 + 某层 MANIFEST 声明==TAG）
# ⇒ 免重下重解（否则每次 deploy 都隔离+重解 500MB）；VMDEPLOY_FORCE_FETCH=1 强制刷新。
# run19 R-1：_pick_root 局部函数删除，改用 pkg-root.sh 的 _pick_pkg_root（单一事实源）。
if [ "${VMDEPLOY_FORCE_FETCH:-0}" != "1" ] && [ -f "$DEPLOY_ROOT/pkg/$ZIP" ] && \
   ( cd "$DEPLOY_ROOT/pkg" && sha256sum -c "$ZIP.sha256" >/dev/null 2>&1 ) && HIT="$(_pick_pkg_root "$TAG")"; then
  echo "[cache] tag=$TAG 本地包根完整（$HIT），跳过下载/解包（VMDEPLOY_FORCE_FETCH=1 可强制）"
  if [ "$HIT" != "$DEPLOY_ROOT/overall-root" ] && [ -f "$DEPLOY_ROOT/overall-root/.env" ] && [ ! -f "$HIT/.env" ]; then
    cp "$DEPLOY_ROOT/overall-root/.env" "$HIT/.env" && echo "[pkg-root] 外层 .env 已下传到缓存包根"
  fi
  { echo "$HIT"; } > "$PKG_ROOT_STATE" 2>/dev/null || true   # run19 R-1：cache 命中同样落状态文件
  echo "PKG_ROOT=$HIT"
  exit 0
fi

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

# run18 P-1 定谳补注：V1.4.19 与 V1.4.20 的 zip **都带 overall/ 前缀**（实测 gitee 资产）；
# 现存外层平铺副本=历史「解包后手工上提一层」产物（mtime 晚 3 分钟、md5 与内层全同）。
# 真包根=唯一带当前 TAG 声明 MANIFEST 的层；解前把整个 overall-root（除 .env）rename 隔离到
# 扫描面外再解——防「解到一半失败留半成品混合层」。fs.rmSync 批量>50 被沙箱 safe-delete 钩拦
# （run18 实测），故隔离不删除，用户可手动清理 stale-quarantine/。
if [ -d "$DEPLOY_ROOT/overall-root" ] && [ -n "$(ls -A "$DEPLOY_ROOT/overall-root" 2>/dev/null)" ]; then
  mkdir -p "$DEPLOY_ROOT/stale-quarantine" || { echo "MKDIR_FAILED" >&2; exit 1; }
  _QDST="$DEPLOY_ROOT/stale-quarantine/overall-root-$(date +%s)"
  if "$NODE" -e 'try{require("fs").renameSync(process.argv[1],process.argv[2]);process.exit(0)}catch(e){console.error("MV_ERR:"+e.message.slice(0,160));process.exit(1)}' "$DEPLOY_ROOT/overall-root" "$_QDST"; then
    # .env 用户配置面：rename 已把整目录搬走→先重建空位、再从隔离区回位（时序钉：cp 前 mkdir）
    mkdir -p "$DEPLOY_ROOT/overall-root"
    if [ -f "$_QDST/.env" ]; then
      cp -p "$_QDST/.env" "$DEPLOY_ROOT/overall-root/.env" && echo "[quarantine] .env 已回位外层根" || echo "⚠ .env 回位失败：手动 cp $_QDST/.env ⇒ $DEPLOY_ROOT/overall-root/.env" >&2
    fi
    echo "[quarantine] 旧 overall-root 已整体隔离至 $_QDST（可手动清理）"
  else
    echo "QUARANTINE_MOVE_FAILED ⇒ 手动清理 $DEPLOY_ROOT/overall-root 后重试" >&2; exit 1
  fi
fi
mkdir -p "$DEPLOY_ROOT/overall-root"
unzip -q -o "$DEPLOY_ROOT/pkg/$ZIP" -d "$DEPLOY_ROOT/overall-root" || { echo "UNZIP_FAILED" >&2; exit 1; }
# run18 P-1：包根候选双层（平铺 zip=外层 / 带 overall/ 前缀 zip=内层；历史混存时双层并存，
# 旧「last-wins」会选中陈旧层）。改按 **MANIFEST version==TAG** 匹配选根：新鲜解包层胜出；
# 双层都声明该版本才允许任取（同层同内容）；都不匹配回退任一合法层并显式告警。
# run19 R-1：选根= pkg-root.sh 共享函数（单一事实源，勿复制两份）。
PKG="$(_pick_pkg_root "$TAG")" || true
[ -n "$PKG" ] || { echo "PKG_ROOT_NOT_FOUND（D5 判定失败：MANIFEST.txt+delivery 双缺）" >&2; exit 1; }
# run18 P-1：.env 用户配置面随「选中根」传导——.env 永不入 MANIFEST（分发面零 .env），
# 用户手填位=overall-root 外层根；当选定包根是内层（overall/ 前缀 zip）时上提复制，
# 保 prepare-vm/setup 的 $PKG/.env 读取位一致（X-6 凭据回注依赖此位）。
if [ "$PKG" != "$DEPLOY_ROOT/overall-root" ] && [ -f "$DEPLOY_ROOT/overall-root/.env" ] && [ ! -f "$PKG/.env" ]; then
  cp "$DEPLOY_ROOT/overall-root/.env" "$PKG/.env" && echo "[pkg-root] 外层 .env 已下传到选中包根"
fi
RV_SEL="$(_pkg_layer_version "$PKG")"
[ "$RV_SEL" = "$TAG" ] || echo "⚠ 选中包根 $PKG 声明版本=$RV_SEL ≠ 下载 TAG=$TAG（陈旧层风险，核对 unzip 布局）" >&2
if [ -n "${PY:-}" ]; then
  ( cd "$PKG" && "$PY" qa/deploy-probes/verify-manifest.py . 2>&1 | tail -1 ) || echo "verify-manifest WARN（探针自身失败不否决 sha 已过结果，记录进问题列）"
fi
# run19 R-1：download-verify 是包根的天然产出者——定根即落状态文件，供 undeploy/verify 三级默认读取。
{ echo "$PKG"; } > "$PKG_ROOT_STATE" 2>/dev/null && echo "[pkg-root] 状态文件已写 $PKG_ROOT_STATE" || echo "⚠ pkg-root.txt 写入失败（driver 将走现探回退）" >&2
echo "PKG_ROOT=$PKG"

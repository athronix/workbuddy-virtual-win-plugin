#!/data/storage/el1/bundle/libs/arm64/bash/bin/bash
HP=/storage/Users/currentUser
source "$HP/wbtmp/env.sh" 2>/dev/null
mkdir -p "$DEPLOY_ROOT/pkg"
cd "$DEPLOY_ROOT/pkg" || exit 1
BASE_GITEE=https://gitee.com/$REPO/releases/download/$RELEASE_TAG
BASE_GH=https://github.com/$REPO/releases/download/$RELEASE_TAG

echo "[$(date)] downloading zip (gitee primary)..."
curl -fsSL --connect-timeout 20 --max-time 900 --retry 4 --retry-delay 3 --retry-all-errors \
  -o "$ZIP" "$BASE_GITEE/$ZIP" \
  || curl -fsSL --connect-timeout 20 --max-time 900 --retry 5 --retry-delay 3 --retry-all-errors -C - \
  -o "$ZIP" "$BASE_GH/$ZIP"
echo "[$(date)] zip bytes: $(wc -c < "$ZIP" 2>/dev/null)"

echo "[$(date)] downloading sha256 (gitee primary)..."
curl -fsSL --connect-timeout 20 --max-time 120 --retry 4 --retry-delay 3 --retry-all-errors \
  -o "$ZIP.sha256" "$BASE_GITEE/$ZIP.sha256" \
  || curl -fsSL --connect-timeout 20 --max-time 120 --retry 4 --retry-all-errors \
  -o "$ZIP.sha256" "$BASE_GH/$ZIP.sha256"
echo "[$(date)] sha256 sidecar content:"; cat "$ZIP.sha256"

echo "[$(date)] sha256 verify..."
if sha256sum -c "$ZIP.sha256" 2>/dev/null; then
  echo "SHA256_OK"
else
  echo "[warn] sha256sum -c 未直接通过，手动比对..."
  exp=$(cat "$ZIP.sha256" | tr -d '[:space:]' | head -c 64)
  act=$(sha256sum "$ZIP" | cut -d' ' -f1)
  echo "expected=$exp"; echo "actual=$act"
  [ "$exp" = "$act" ] && echo "SHA256_MATCH_MANUAL" || echo "SHA256_MISMATCH"
fi

echo "[$(date)] unzip..."
mkdir -p "$DEPLOY_ROOT/overall-root"
unzip -q -o "$ZIP" -d "$DEPLOY_ROOT/overall-root"
echo "[$(date)] unzip done. top-level:"
ls -la "$DEPLOY_ROOT/overall-root" | head -20
echo "PKG_ROOT_CANDIDATES:"
for r in "$DEPLOY_ROOT/overall-root" "$DEPLOY_ROOT/overall-root/overall"; do
  if [ -f "$r/MANIFEST.txt" ] && [ -d "$r/delivery" ]; then echo "  MATCH: $r"; fi
done
echo "[$(date)] STEP2_DOWNLOAD_DONE"
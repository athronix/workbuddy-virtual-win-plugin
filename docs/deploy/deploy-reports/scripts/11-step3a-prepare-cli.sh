#!/data/storage/el1/bundle/libs/arm64/bash/bin/bash
# Step3a：VM 运行时补齐（已获用户授权 P-2a）+ 修复 prepare-vm 嵌套数组 bug
cd /storage/Users/currentUser 2>/dev/null || cd / 2>/dev/null
source /storage/Users/currentUser/wbtmp/env.sh 2>/dev/null
HP=/storage/Users/currentUser
export PATH="$HP/wbtmp/bin:$PATH"
export WINVM_SSH_PASSWORD=123456
cd "$PKG_ROOT" || { echo "PKG_ROOT 不存在: $PKG_ROOT"; exit 1; }
log() { echo "[$(date +%H:%M:%S)] $*"; }

log "=== [1/3] prepare-vm --apply --ensure-node ==="
"$NODE" delivery/bootstrap.mjs prepare-vm --apply --ensure-node \
  --vm-host 172.16.100.2 --vm-user User --vm-ssh-port 22 > /storage/Users/currentUser/wbtmp/prepare.log 2>&1
pv_rc=$?
log "prepare-vm rc=$pv_rc"
tail -40 /storage/Users/currentUser/wbtmp/prepare.log

log "=== [2/3] 安装 codebuddy CLI (npm i -g) ==="
vmssh 'npm i -g @tencent-ai/codebuddy-code@latest' > /storage/Users/currentUser/wbtmp/cb.log 2>&1
log "codebuddy install rc=$?"

log "=== [3/3] 重跑 3.0 环境探针 ==="
vmscp "$PKG_ROOT/qa/deploy-probes/vm-env-check.ps1" "$VM_USER@$VM_HOST:C:/Users/$VM_USER/vm-env-check.ps1" 2>&1 | tail -2
vmssh 'powershell -NoProfile -ExecutionPolicy Bypass -File C:/Users/'$VM_USER'/vm-env-check.ps1' > /storage/Users/currentUser/wbtmp/probe3.log 2>&1
log "=== STEP3A DONE ==="
tail -25 /storage/Users/currentUser/wbtmp/probe3.log

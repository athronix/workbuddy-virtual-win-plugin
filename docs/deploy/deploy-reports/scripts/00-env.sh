#!/bin/sh
# WinVM Bridge deploy · 运行期注入落盘（X-1）
# 注：本文件为临时 scratch（~/wbtmp），含明文密码，部署完成后应清理。
# 环境特例（本宿主）：rm 是坏 shim、uid 跨调用漂移 → ~/.ssh 属主/权限会冲突。
# 处置：① 编排用 ssh/scp 一律 -F /dev/null + StrictHostKeyChecking=no + UserKnownHostsFile=/dev/null，
#        且改用【密码认证 askpass】绕开密钥属主问题；② 密钥推送仍做（终态免密），不阻塞编排。
export VM_HOST=172.16.100.2
export VM_USER=User
export VM_SSH_PORT=22
export WINVM_SSH_PASSWORD=123456
# 供 setup.mjs TUNNEL 相位 ssh2 后端使用（该相位只读 process.env.WINVM_VM_PASSWORD，
# 不会从 .env 文件回填，故必须在此显式 export）。
export WINVM_VM_PASSWORD=123456
export DEPLOY_ROOT=$HOME/winvm-deploy
export PKG_ROOT=$HOME/winvm-deploy/overall-root/overall
export NODE=/data/storage/el1/bundle/libs/arm64/node/bin/node
export PY=/data/storage/el1/bundle/libs/arm64/python/bin/python3
export RELEASE_TAG=V1.4.19
export ZIP=winvm-overall-V1.4.19.zip
export REPO=athronix/workbuddy-virtual-win-plugin
export WINVM_DRY_RUN=0
export ASKPASS=$HOME/wbtmp/askpass.sh
# 包装器目录前置：让包内脚本(bootstrap/deploy/install)内部调用的 ssh/scp 也走密码通道，
# 绕开密钥属主/uid 漂移（包装器见 ~/wbtmp/bin/{ssh,scp}）
export PATH="$HOME/wbtmp/bin:$PATH"

# 编排用 ssh/scp：密码认证（askpass），绕过 ~/.ssh 属主/uid 漂移；带重试（R4 抖動韧性）
_vm_ssh_base() {
  WINVM_SSH_PASSWORD="$WINVM_SSH_PASSWORD" DISPLAY=:0 \
  SSH_ASKPASS="$ASKPASS" SSH_ASKPASS_REQUIRE=force \
  ssh -F /dev/null -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
      -o PubkeyAuthentication=no -o PreferredAuthentications=password \
      -o NumberOfPasswordPrompts=1 -o ConnectTimeout=10 -o ServerAliveInterval=15 "$@"
}
vmssh()  { for i in 1 2 3; do _vm_ssh_base -p $VM_SSH_PORT $VM_USER@$VM_HOST "$@" && return 0; sleep 2; done; return 1; }
vmscp()  { for i in 1 2 3; do WINVM_SSH_PASSWORD="$WINVM_SSH_PASSWORD" DISPLAY=:0 \
            SSH_ASKPASS="$ASKPASS" SSH_ASKPASS_REQUIRE=force \
            scp -F /dev/null -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
              -o PubkeyAuthentication=no -o PreferredAuthentications=password -o NumberOfPasswordPrompts=1 \
              -o ConnectTimeout=10 -P $VM_SSH_PORT "$@" && return 0; sleep 2; done; return 1; }

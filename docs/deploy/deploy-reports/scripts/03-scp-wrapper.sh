#!/data/storage/el1/bundle/libs/arm64/bash/bin/bash
# 密码认证 scp 包装器 + 重试（R4 桥接抖动韧性），绕开密钥属主/uid 漂移
for n in 1 2 3 4 5; do
  WINVM_SSH_PASSWORD="$WINVM_SSH_PASSWORD" DISPLAY=:0 \
  SSH_ASKPASS="$ASKPASS" SSH_ASKPASS_REQUIRE=force \
  /usr/bin/scp -F /dev/null -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o PubkeyAuthentication=no -o PreferredAuthentications=password -o NumberOfPasswordPrompts=1 \
    -o ConnectTimeout=10 "$@" && exit 0
  sleep 3
done
exit 1

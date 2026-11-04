#!/usr/bin/env bash
# winvm-plugin-deploy · 双通道 VM 连接层（X-3/密钥优先、密码兜底；R4 重试韧性）
# source 本文件获得：vmssh / vmscp / vm_channel_probe / fs_rm
# 通道选择（vm_channel_probe 自动判定并设 VM_CHANNEL=key|password）：
#   1) 免密在（BatchMode 可达）           → key   通道（最简，历轮标准拓扑）
#   2) 免密不在 + WINVM_SSH_PASSWORD 在场 → password 通道（askpass，绕开 uid 漂移/密钥缺失）
#   3) 都不满足                            → 返回 1：按执行协议 P-1 问用户建通道（deploy.prompt Step 1）
# 密码纪律：只经环境变量传递，绝不写入文件/命令行参数/日志（askpass 子进程从 env 取）。
set -u
# 硬超时纪律：本宿主 ssh 在 sshd 连接位占满时会【无限挂起】（连 BatchMode 也不退，2026-11-03 实测卡 8 分钟）
# ——所有远端调用必须包 timeout；VM_SSH_TIMEOUT 可调（默认 25s/次）。
VM_SSH_TIMEOUT="${VM_SSH_TIMEOUT:-25}"
_ssh_t() { timeout "$VM_SSH_TIMEOUT" "$@"; }
: "${VMDEPLOY_ENV_SH:=${HOME}/wbtmp/vmdeploy-env.sh}"; [ -f "$VMDEPLOY_ENV_SH" ] && . "$VMDEPLOY_ENV_SH"
: "${VM_HOST:=}"; : "${VM_USER:=User}"; : "${VM_SSH_PORT:=22}"
VM_CHANNEL="${VM_CHANNEL:-}"

_ssh_common=(-o ConnectTimeout=10 -o ServerAliveInterval=15 -o StrictHostKeyChecking=no)

# key 通道：BatchMode（无交互）；部分沙箱 ~/.ssh 属主漂移 → 用独立 UserKnownHosts 文件避免权限类失败
vmssh() {
  local i
  for i in 1 2 3; do
    case "${VM_CHANNEL:-key}" in
      key) _ssh_t ssh -o BatchMode=yes "${_ssh_common[@]}" -p "$VM_SSH_PORT" "${VM_USER}@${VM_HOST}" "$@" && return 0 ;;
      password) _ssh_t _askpass_env ssh -F /dev/null -o UserKnownHostsFile=/dev/null -o PubkeyAuthentication=no \
                  -o PreferredAuthentications=password -o NumberOfPasswordPrompts=1 "${_ssh_common[@]}" \
                  -p "$VM_SSH_PORT" "${VM_USER}@${VM_HOST}" "$@" && return 0 ;;
      *) echo "VM_CHANNEL 未定：先 vm_channel_probe" >&2; return 2 ;;
    esac
    sleep 2   # R4：桥接抖动重试，非配置错误
  done; return 1
}
vmscp() {
  local i
  for i in 1 2 3; do
    case "${VM_CHANNEL:-key}" in
      key) _ssh_t scp -o BatchMode=yes -o ConnectTimeout=10 "${_ssh_common[@]}" -P "$VM_SSH_PORT" "$@" && return 0 ;;
      password) _ssh_t _askpass_env scp -F /dev/null -o UserKnownHostsFile=/dev/null -o PubkeyAuthentication=no \
                  -o PreferredAuthentications=password -o NumberOfPasswordPrompts=1 -o ConnectTimeout=10 \
                  -P "$VM_SSH_PORT" "$@" && return 0 ;;
      *) echo "VM_CHANNEL 未定：先 vm_channel_probe" >&2; return 2 ;;
    esac
    sleep 2
  done; return 1
}
_askpass_env() {
  local ap="${HOME}/wbtmp/askpass.sh"
  if [ ! -x "$ap" ]; then
    printf '#!/bin/sh\nprintf "%%s\\n" "$WINVM_SSH_PASSWORD"\n' > "$ap" && chmod 700 "$ap"
  fi
  WINVM_SSH_PASSWORD="$WINVM_SSH_PASSWORD" DISPLAY=:0 SSH_ASKPASS="$ap" SSH_ASKPASS_REQUIRE=force "$@"
}
vm_channel_probe() {
  [ -n "$VM_HOST" ] || { echo "VM_HOST 未设（问用户）" >&2; return 2; }
  if _ssh_t ssh -o BatchMode=yes -o ConnectTimeout=8 "${_ssh_common[@]}" -p "$VM_SSH_PORT" "${VM_USER}@${VM_HOST}" whoami >/dev/null 2>&1; then
    export VM_CHANNEL=key; echo "VM_CHANNEL=key（免密通道在）"; return 0
  fi
  if [ -n "${WINVM_SSH_PASSWORD:-}" ] && _ssh_t _askpass_env ssh -F /dev/null -o UserKnownHostsFile=/dev/null \
      -o PubkeyAuthentication=no -o PreferredAuthentications=password -o NumberOfPasswordPrompts=1 \
      "${_ssh_common[@]}" -p "$VM_SSH_PORT" "${VM_USER}@${VM_HOST}" whoami >/dev/null 2>&1; then
    export VM_CHANNEL=password; echo "VM_CHANNEL=password（askpass 通道可用；建议事后补建免密=deploy.prompt Step 1）"; return 0
  fi
  echo "NO_CHANNEL：免密不在且密码登录失败/未提供 → P-1 问用户（IP/账号/密码），或按 Step 1 建立免密"; return 1
}
# fs_rm：X-2 教训——宿主 rm 可能是坏 shim；一律 node fs（rm -rf 语义的安全版：仅限显式路径）。
fs_rm() {
  "${NODE:?需先 source vmdeploy-env.sh}" -e 'for (const p of process.argv.slice(1)) require("fs").rmSync(p, {recursive:true, force:true})' "$@"
}

# 非 source 直跑时=探测模式
if [ "${BASH_SOURCE[0]:-$0}" = "${0}" ]; then
  vm_channel_probe
fi

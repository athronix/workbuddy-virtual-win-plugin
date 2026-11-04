#!/usr/bin/env bash
# winvm-plugin-deploy · Step 0 一键前置体检（把「信息不足/VM 配置难/通道不稳」一次判定）
# 用法：VM_HOST=<ip> [VM_USER=User] [VM_SSH_PORT=22] bash preflight.sh
# 输出：分级 readiness（GREEN / YELLOW=有兜底可继续 / RED=必须人工或问用户）+ 逐项修复指引。
# 不改动任何东西（纯只读探测）；密码仅从环境变量读，绝不落盘。
set -u
_here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
VM_HOST="${VM_HOST:-}"; VM_USER="${VM_USER:-User}"; VM_SSH_PORT="${VM_SSH_PORT:-22}"
RED=0; YELLOW=0; note(){ echo "  - $*"; }
echo "==== WinVM deploy preflight (host=${VM_HOST:-未设}) ===="

# 1) 必要信息
if [ -z "$VM_HOST" ]; then echo "RED: VM_HOST 未设 → 执行协议 P-1 问用户"; RED=$((RED+1)); else echo "OK: VM_HOST=$VM_HOST"; fi

# 2) 宿主运行时（冒烟探测）
if [ -f "$HOME/wbtmp/vmdeploy-env.sh" ]; then . "$HOME/wbtmp/vmdeploy-env.sh"; echo "OK: NODE=${NODE:-?}"; else
  bash "$_here/env-detect.sh" >/tmp/pf-node.$$ 2>&1 && . "$HOME/wbtmp/vmdeploy-env.sh" && echo "OK: 运行时探测通过 NODE=${NODE:-?}" || { echo "RED: 无健康 node/python（见 env-detect 输出）"; cat /tmp/pf-node.$$ | tail -3; RED=$((RED+1)); }
fi
NODE="${NODE:-$(command -v node || true)}"

# 3) VM 通道（免密优先、密码兜底）
. "$_here/vm-conn.sh"
if vm_channel_probe; then
  echo "OK: 通道=${VM_CHANNEL}"
  [ "$VM_CHANNEL" = password ] && { echo "  note: 走密码通道；建议 deploy Step 1 建免密（长期更稳）"; YELLOW=$((YELLOW+1)); }
else
  echo "RED: 无法连 VM（免密不在且密码失败）→ 逐项排查见下"; RED=$((RED+1))
  # TCP 22 可达性
  if command -v nc >/dev/null 2>&1; then
    nc -z -w5 "$VM_HOST" "$VM_SSH_PORT" 2>/dev/null && note "TCP $VM_HOST:$VM_SSH_PORT 可达 → 问题在认证（VM_USER/密码/authorized_keys）" \
      || { note "TCP 不可达 → VM 可能未开机/被暂停/掉网（hypervisor 管理端确认开机+从不自动暂停+固定 IP/桥接）"; YELLOW=$((YELLOW+1)); }
  fi
fi

# 4) 若通道在，探 VM 侧关键前置
if [ -n "${VM_CHANNEL:-}" ]; then
  echo "-- VM 内前置（heredoc 写 .ps1 → ps-run 铁律通道）--"
  _pfps="$HOME/wbtmp/vmdeploy-preflight.ps1"; mkdir -p "$HOME/wbtmp"
  cat > "$_pfps" <<'PS1'
$s = ""
$s += "OS=" + (Get-CimInstance Win32_OperatingSystem).Version + "`r`n"
$ss = Get-Service sshd -ErrorAction SilentlyContinue
$s += "SSHD=" + $(if ($ss) { $ss.Status } else { "ABSENT" }) + "`r`n"
$st = Get-Service WinVMBridge -ErrorAction SilentlyContinue
$s += "BRIDGE_SVC=" + $(if ($st) { $st.Status } else { "none" }) + "`r`n"
$s += "LISTEN18443=" + @(Get-NetTCPConnection -LocalPort 18443 -State Listen -ErrorAction SilentlyContinue).Count + "`r`n"
try { $n = node -v } catch { $n = "absent" }
$s += "NODE=" + $n + "`r`n"
try { $c = (codebuddy --version 2>$null | Select-Object -First 1) } catch { $c = "absent" }
$s += "CLI=" + $(if ($c) { $c } else { "absent" }) + "`r`n"
$w = Get-NetConnectionProfile | Select-Object -First 1
$s += "NETCAT=" + $(if ($w) { $w.NetworkCategory } else { "?" }) + "`r`n"
$fr = Get-NetFirewallRule -Name OpenSSH-Server-In-TCP -ErrorAction SilentlyContinue
$s += "FW=" + $(if ($fr) { "" + $fr.Enabled + "/" + $fr.Profile } else { "norule" }) + "`r`n"
$s
PS1
  out="$(bash "$_here/ps-run.sh" "$_pfps" 2>&1)"; rc=$?
  echo "$out" | tr -d '\r'
  [ $rc -ne 0 ] && { note "preflight PS 执行 rc=$rc（通道问题优先回查 vm_channel_probe）"; YELLOW=$((YELLOW+1)); }
  echo "$out" | grep -q "SSHD=ABSENT\|SSHD=Stopped" && { note "sshd 未运行 → VM 管理员 PS：Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 ; Start-Service sshd ; Set-Service sshd -StartupType Automatic"; YELLOW=$((YELLOW+1)); }
  echo "$out" | grep -q "NODE=absent" && { note "VM 缺 node → bootstrap.mjs prepare-vm --apply --ensure-node 自动补（winget→zip+镜像兜底）"; YELLOW=$((YELLOW+1)); }
  echo "$out" | grep -q "FW=False" && { note "防火墙规则禁用 → VM 管理员：Set-NetFirewallRule -Name OpenSSH-Server-In-TCP -Enabled True -Profile Any"; YELLOW=$((YELLOW+1)); }
  echo "$out" | grep -q "FW=norule" && { note "无 OpenSSH 防火墙规则 → New-NetFirewallRule -Name sshd -Group 'OpenSSH Firewall Rules' -Enable True -Service sshd -Protocol TCP -LocalPort 22 -Profile Any"; YELLOW=$((YELLOW+1)); }
fi

echo "==== 结论 ===="
if [ "$RED" -gt 0 ]; then echo "READINESS=RED（$RED 项硬阻塞）→ 先解决 RED 项或问用户，勿硬跑 setup"; 
elif [ "$YELLOW" -gt 0 ]; then echo "READINESS=YELLOW（$YELLOW 项可自动补齐/有兜底）→ deploy Step 3 prepare-vm --ensure-node 处理，或按需审批";
else echo "READINESS=GREEN → 可直接进 deploy.prompt Step 1→6 / scripts/deploy.sh"; fi

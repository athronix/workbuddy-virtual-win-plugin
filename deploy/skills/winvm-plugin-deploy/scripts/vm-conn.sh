#!/usr/bin/env bash
# winvm-plugin-deploy · 双通道 VM 连接层（X-3/密钥优先、密码兜底；R4 重试韧性）
# source 本文件获得：vmssh / vmscp / vm_channel_probe / fs_rm
# 通道选择（vm_channel_probe 自动判定并设 VM_CHANNEL=key|password）：
#   1) 免密在（BatchMode 可达）           → key   通道（最简，历轮标准拓扑）
#   2) 免密不在 + WINVM_SSH_PASSWORD 在场 → password 通道（askpass，绕开 uid 漂移/密钥缺失）
#   3) 都不满足                            → 返回 1：按执行协议 P-1 问用户建通道（deploy.prompt Step 1）
# 密码纪律：只经环境变量传递，绝不写入文件/命令行参数/日志（askpass 子进程从 env 取）。
# run16 新增：VM_SSH_BACKEND=key|ssh2|auto 后端开关（ssh2 走 ssh2-conn.mjs，绕开 OpenSSH 二进制相位挂）。
set -u
# 硬超时纪律：本宿主 ssh 在 sshd 连接位占满时会【无限挂起】（连 BatchMode 也不退，2026-11-03 实测卡 8 分钟）
# ——所有远端调用必须包 timeout；VM_SSH_TIMEOUT 可调（默认 25s/次）。
VM_SSH_TIMEOUT="${VM_SSH_TIMEOUT:-25}"
_ssh_t() { timeout "$VM_SSH_TIMEOUT" "$@"; }
: "${VMDEPLOY_ENV_SH:=${HOME}/wbtmp/vmdeploy-env.sh}"; [ -f "$VMDEPLOY_ENV_SH" ] && . "$VMDEPLOY_ENV_SH"
: "${VM_HOST:=}"; : "${VM_USER:=User}"; : "${VM_SSH_PORT:=22}"
VM_CHANNEL="${VM_CHANNEL:-}"

# ── run16 定谳：node ssh2 后端（VM_SSH_BACKEND=key|ssh2|auto，默认 key=现状零冲击）──
# OpenSSH 二进制对 VM 相位性挂起（raw TCP+banner 通、认证段随机死 rc=124；同秒对照
# ssh2 READY 654ms rc=0 vs 二进制 rc=124 实锤；tunnel-daemon 靠 ssh2 全天恒通）。
#   key  = 只走 ssh/scp 二进制（原路径，发布面默认）
#   ssh2 = 走 ssh2-conn.mjs（exec/put/get/ping），失败兜底二进制（保险丝）
#   auto = ssh2 优先、二进制作 fallback（同 ssh2；二进制不可靠已由同秒对照定谳）
# 启用方式：调用方（driver/编排）显式 export VM_SSH_BACKEND=ssh2。
VM_SSH_BACKEND="${VM_SSH_BACKEND:-key}"
# 专属变量名：不覆盖调用方（deploy/ps-run/verify 等）的 _here；同 scripts/ 目录，pwd 归一化后一致
_vmconn_here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
_ssh2n="${VMDEPLOY_NODE:-${NODE:-}}"
[ -n "$_ssh2n" ] && [ -x "$_ssh2n" ] || _ssh2n="/data/storage/el1/bundle/libs/arm64/node/bin/node"
[ -x "$_ssh2n" ] || _ssh2n="$(command -v node 2>/dev/null || true)"
SSH2_CONN_SH="$_vmconn_here/ssh2-conn.mjs"
# 后端就绪判定：ssh2/auto 且 node+ssh2-conn.mjs 在场 → 0（vmssh/vmscp 走 ssh2 分支）
_use_ssh2() {
  case "$VM_SSH_BACKEND" in
    ssh2|auto) [ -x "$_ssh2n" ] && [ -f "$SSH2_CONN_SH" ] ;;
    *) return 1 ;;
  esac
}
# ssh2 传输层失败退出码（ssh2-conn.mjs RC_INFRA=111；124=外层 timeout 杀；2=用法错）
_ssh2_infra_rc() { [ "$1" -eq 111 ] || [ "$1" -eq 124 ]; }
# scp 参→ssh2 put/get 适配：剥 user@host: 前缀（与 scp 语义一致：剥后裸文件名=远端 home 相对）
_strip_scp_target() {
  local s="$1" p="${VM_USER}@${VM_HOST}:"
  if [ "${s#"$p"}" != "$s" ]; then printf '%s\n' "${s#"$p"}"; return 0; fi
  printf '%s\n' "$s"   # 无本 VM 前缀：绝对路径/相对路径原样；异形 host: 交 ssh2 侧显式报错
}
# vmscp 判形（run17 D-8）：委托 ssh2-conn.mjs shape 子命令（classifyScpShape 纯函数=单一事实源）；
# node 异常/输出非法 → unknown（调用方显式处理，勿静默错传）。
_scp_shape() { # $1=a1 $2=a2 → stdout put|get|unknown
  local e1=0 e2=0 out=""
  [ -f "$1" ] && e1=1
  [ -f "$2" ] && e2=1
  out="$("$_ssh2n" "$SSH2_CONN_SH" shape "$e1" "$e2" "$1" "$2" "${VM_USER}@${VM_HOST}:" 2>/dev/null)" || true
  case "$out" in put|get) printf '%s\n' "$out" ;; *) printf 'unknown\n' ;; esac
}

_ssh_common=(-o ConnectTimeout=15 -o ServerAliveInterval=15 -o StrictHostKeyChecking=no)

# key 通道：BatchMode（无交互）；部分沙箱 ~/.ssh 属主漂移 → 用独立 UserKnownHosts 文件避免权限类失败
# 二进制兜底一发（ssh2/auto 三试尽后走；VM_CHANNEL 未定时按 key 形态——ssh2 通道本就密钥，兜底同理）
_ssh_bin_one() {
  case "${VM_CHANNEL:-key}" in
    key) _ssh_t ssh -o BatchMode=yes "${_ssh_common[@]}" -p "$VM_SSH_PORT" "${VM_USER}@${VM_HOST}" "$@" ;;
    password) _ssh_t _askpass_env ssh -F /dev/null -o UserKnownHostsFile=/dev/null -o PubkeyAuthentication=no \
                -o PreferredAuthentications=password -o NumberOfPasswordPrompts=1 "${_ssh_common[@]}" \
                -p "$VM_SSH_PORT" "${VM_USER}@${VM_HOST}" "$@" ;;
    *) return 2 ;;
  esac
}
_scp_bin_one() {
  case "${VM_CHANNEL:-key}" in
    key) _ssh_t scp -o BatchMode=yes -o ConnectTimeout=10 "${_ssh_common[@]}" -P "$VM_SSH_PORT" "$@" ;;
    password) _ssh_t _askpass_env scp -F /dev/null -o UserKnownHostsFile=/dev/null -o PubkeyAuthentication=no \
                -o PreferredAuthentications=password -o NumberOfPasswordPrompts=1 -o ConnectTimeout=10 \
                -P "$VM_SSH_PORT" "$@" ;;
    *) return 2 ;;
  esac
}
vmssh() {
  local i rc
  # ── ssh2 后端（run17 D-4 定序）：三试（间隔 5s）→ 皆 111/124 → 二进制兜底一发 → 仍败透传 rc ──
  # 远端非零码（∉{111,124}）直通不重试不兜底（R8 语义与 key 通道一致）；timeout 外层包 node。
  if _use_ssh2; then
    for i in 1 2 3; do
      timeout $(( VM_SSH_TIMEOUT + 5 )) "$_ssh2n" "$SSH2_CONN_SH" exec "$@"; rc=$?
      [ "$rc" -eq 0 ] && return 0
      _ssh2_infra_rc "$rc" || return "$rc"
      [ "$i" -lt 3 ] && sleep 5
    done
    echo "vmssh: ssh2 传输层失败 rc=$rc（3 试尽）→ 二进制兜底一发" >&2
    _ssh_bin_one "$@" && return 0
    return "$rc"
  fi
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
  local i rc a1 a2 _mode
  # ── ssh2 后端（run17 D-4/D-8）：判形一次（shape 纯函数）→ 三试（间隔 5s）→ 兜底一发 → 透传 ──
  if _use_ssh2; then
    local _args=("$@") _explicit="" _rest=() _a
    for _a in "${_args[@]}"; do
      case "$_a" in
        -u) _explicit="u" ;;
        -g) _explicit="g" ;;
        -*) ;;                     # scp flag（-P/-o/-r 等）ssh2 侧不需要，吞掉
        *) _rest+=("$_a") ;;
      esac
    done
    if [ "${#_rest[@]}" -gt 2 ]; then
      echo "vmscp(ssh2)：暂不支持 >2 位置参数（scp 多目标）；请用 -u/-g 显式形态" >&2; return 2
    fi
    a1="${_rest[0]:-}"; a2="${_rest[1]:-}"
    _mode="${_explicit:-}"
    if [ -z "$_mode" ]; then
      case "$(_scp_shape "$a1" "$a2")" in
        put) _mode=u ;;
        get) _mode=g ;;
        *) _mode="" ;;
      esac
    fi
    if [ "$_mode" != u ] && [ "$_mode" != g ]; then
      echo "vmscp(ssh2)：无法判形：[$a1] [$a2]（D-5：目录名/异形前缀不猜）；支持 vmscp -u <local> <remote> / -g <remote> <local> 或 scp 原生形态" >&2
      # auto：判形不了 → 走下方二进制兜底路径；ssh2 纯后端：显式报错即停
      [ "$VM_SSH_BACKEND" = ssh2 ] && return 2
    else
      local _op _src _dst
      if [ "$_mode" = u ]; then _op=put; _src="$a1"; _dst="$(_strip_scp_target "$a2")"; else _op=get; _src="$(_strip_scp_target "$a1")"; _dst="$a2"; fi
      for i in 1 2 3; do
        timeout $(( VM_SSH_TIMEOUT + 10 )) "$_ssh2n" "$SSH2_CONN_SH" "$_op" "$_src" "$_dst"; rc=$?
        [ "$rc" -eq 0 ] && return 0
        _ssh2_infra_rc "$rc" || { echo "vmscp(ssh2): $_op 失败 rc=$rc（非传输层，不重试不兜底）" >&2; return "$rc"; }
        [ "$i" -lt 3 ] && sleep 5
      done
      echo "vmscp: ssh2 传输层失败 rc=$rc（3 试尽）→ 二进制兜底一发" >&2
      _scp_bin_one "$@" && return 0
      return "$rc"
    fi
  fi
  for i in 1 2 3; do
    case "${VM_CHANNEL:-key}" in
      key) _ssh_t scp -o BatchMode=yes -o ConnectTimeout=10 "${_ssh_common[@]}" -P "$VM_SSH_PORT" "$@" && return 0 ;;
      password) _ssh_t _askpass_env scp -F /dev/null -o UserKnownHostsFile=/dev/null -o PubkeyAuthentication=no \
                  -o PreferredAuthentications=password -o NumberOfPasswordPrompts=1 -o ConnectTimeout=10 \
                  -P "$VM_SSH_PORT" "$@" && return 0 ;;
      *) [ "$VM_SSH_BACKEND" = ssh2 ] || { echo "VM_CHANNEL 未定：先 vm_channel_probe" >&2; return 2; } ;;
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
  # run16：ssh2 后端快路径——VM_SSH_BACKEND=ssh2|auto 时先 ssh2-conn.mjs ping 一次
  # （ready 即通，绕开二进制认证段相位挂）；OK 即 export VM_CHANNEL=key 返回 0
  # （ssh2 分支的 vmssh/vmscp 不依赖 VM_CHANNEL，置 key 仅为兼容既有调用方判定与兜底路径）。
  # run17 D-8：失败四元组纪律——打印 rc+stderr 前 120 字符；ping 超时秒数 clamp ≥1。
  if [ "$VM_SSH_BACKEND" != key ] && _use_ssh2; then
    local _pt=$(( ${VM_SSH_READY_TIMEOUT_MS:-15000} / 1000 + 5 )); [ "$_pt" -lt 1 ] && _pt=1
    local _perr="" _prc=0
    _perr=$(timeout "$_pt" "$_ssh2n" "$SSH2_CONN_SH" ping 2>&1 >/dev/null); _prc=$?
    if [ "$_prc" -eq 0 ]; then
      export VM_CHANNEL=key
      echo "VM_CHANNEL=key（VM_SSH_BACKEND=$VM_SSH_BACKEND：ssh2-conn ping 单发即通，快路径）"; return 0
    fi
    echo "VM_SSH_BACKEND=$VM_SSH_BACKEND 但 ssh2-conn ping 失败 rc=${_prc} stderr=[$(printf '%s' "$_perr" | tr -d '\r' | head -c 120)] → 回退二进制探测" >&2
  fi
  # run15 定谳（17:34 密测 12/12 全通 vs 五试 40s 内全灭）：窗好时连发全过、【重试无自毒】；
  # 五试×15s 间隔的真正代价=健康窗被 ~261s 探测程序耗尽。⇒ 调用方已裁定通道时走快路径：
  # export VM_CHANNEL=key（或 password）后本函数只做单发验证（8s 内定成败），失败才回退五试全探。
  if [ "${VM_CHANNEL:-}" = key ]; then
    if _ssh_t ssh -o BatchMode=yes -o ConnectTimeout=8 "${_ssh_common[@]}" -p "$VM_SSH_PORT" "${VM_USER}@${VM_HOST}" whoami >/dev/null 2>&1; then
      echo "VM_CHANNEL=key 复用（预置通道单发验证过，快路径）"; return 0
    fi
    echo "VM_CHANNEL=key 预置单发失败 → 回退五试全探" >&2
  fi
  # run13 定谳：VM 开机 auth 慢期里 ConnectTimeout=8 成临界（probe 8s×3 全灭 vs 单发 15s 三连通）；
  # 五试、15s 间隔、CT=15；失败诊断无条件打印（rc+末次 stderr）。
  # 【run15 17:34 更正】旧『密集重试自毒』判已被密测证伪：窗开时 12 连发/2s 间隔全通。
  # 五试间隔的真实意义=给『环境相位切换』留观察窗，不是防自毒；窗闭相位下怎么退避都白搭。
  local i last_err="" last_rc=0
  for i in 1 2 3 4 5; do
    last_err=$(timeout "${VM_SSH_TIMEOUT:-25}" ssh -o BatchMode=yes "${_ssh_common[@]}" -p "$VM_SSH_PORT" "${VM_USER}@${VM_HOST}" whoami 2>&1 >/dev/null); last_rc=$?
    [ $last_rc -eq 0 ] && { export VM_CHANNEL=key; echo "VM_CHANNEL=key（免密通道在；第 ${i} 试命中）"; return 0; }
    # 间隔 15s（run15 更正：非防自毒——密测证明窗开时连发无害；此间隔=相位切换观察节拍）。
    [ $i -lt 5 ] && sleep 15
  done
  if [ -n "${WINVM_SSH_PASSWORD:-}" ]; then
    for i in 1 2 3; do
      _ssh_t _askpass_env ssh -F /dev/null -o UserKnownHostsFile=/dev/null \
        -o PubkeyAuthentication=no -o PreferredAuthentications=password -o NumberOfPasswordPrompts=1 \
        "${_ssh_common[@]}" -p "$VM_SSH_PORT" "${VM_USER}@${VM_HOST}" whoami >/dev/null 2>&1 && \
        { export VM_CHANNEL=password; echo "VM_CHANNEL=password（第 ${i} 试命中；建议事后建免密）"; return 0; }
      [ $i -lt 5 ] && sleep 15
    done
  fi
  # 四元组纪律：RED 必须带证据（末次 rc+stderr 无条件打印；124=timeout 杀即挂起形态）
  echo "NO_CHANNEL：免密不在且密码登录失败/未提供 → P-1 问用户（IP/账号/密码），或按 Step 1 建立免密"
  echo "  末次 key 通道证据: rc=${last_rc} stderr=[$(printf '%s' "$last_err" | tr -d '\r' | head -c 160)]（124=认证阶段挂起→VM 开机期，等 2-3 分钟再试）"
  return 1
}
# fs_rm：X-2 教训——宿主 rm 可能是坏 shim；一律 node fs（rm -rf 语义的安全版：仅限显式路径）。
fs_rm() {
  "${NODE:?需先 source vmdeploy-env.sh}" -e 'for (const p of process.argv.slice(1)) require("fs").rmSync(p, {recursive:true, force:true})' "$@"
}

# 非 source 直跑时=探测模式
if [ "${BASH_SOURCE[0]:-$0}" = "${0}" ]; then
  vm_channel_probe
fi

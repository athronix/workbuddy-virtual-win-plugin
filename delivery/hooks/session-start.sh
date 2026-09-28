#!/bin/sh
# WinVM Bridge —— WorkBuddy SessionStart 钩子：幂等确保宿主侧 SSH 隧道守护进程在线。
#
# 机制（CL-020 / D16）：插件清单（.codebuddy-plugin/plugin.json）以顶层
#   "hooks": "./hooks/hooks.json"
# 声明本文件为 SessionStart 钩子；平台在**插件启用**时自动合并该 hooks，
# 每次新会话启动触发一次，从而「随 WorkBuddy 启动」拉起隧道守护进程。
#
# 设计约束（硬要求，任一不满足即可能拖垮会话启动）：
#   1) POSIX sh 兼容：本机宿主 shell 为 /bin/sh，**没有 /bin/bash**（已知坑：safe-bin 的
#      `rm` shim 因缺 /bin/bash 而 exit 126），故本脚本不得使用任何 bashism。
#   2) 绝不阻塞会话：由 hooks.json 以 `... &` 后台异步调用；本脚本自身也尽快返回。
#   3) 幂等：调用 `winvm-plugin tunnel ensure`（已在运行则秒回 0，不产生第二个 daemon 实例）。
#   4) 失败不影响会话：一切错误一律吞掉（含 stderr），仅把痕迹追加到 tunnel.log；恒以 0 退出。
#   5) 不硬编码路径：插件根经 ${CODEBUDDY_PLUGIN_ROOT} 解析（平台注入）。

set -u

# ---- 解析插件根：优先平台注入的 CODEBUDDY_PLUGIN_ROOT；缺失时按脚本自身位置兜底推导 ----
plugin_root="${CODEBUDDY_PLUGIN_ROOT:-}"
if [ -z "$plugin_root" ]; then
  case "$0" in
    */*) script_dir=${0%/*} ;;
    *)   script_dir=. ;;
  esac
  # hooks/session-start.sh → 上一级即插件根
  plugin_root="${script_dir%/*}"
  [ -n "$plugin_root" ] || plugin_root=.
fi

launcher="${plugin_root}/winvm-plugin"
launcher_mjs="${plugin_root}/winvm-plugin.mjs"

log_dir="${HOME:-.}/.workbuddy/winvm"
log_file="${log_dir}/tunnel.log"

# 日志目录/文件不可写也不能影响会话：全部 best-effort。
mkdir -p "$log_dir" 2>/dev/null || true

# 启动器缺失（插件未完整部署）→ 静默退出，绝不报错。
if [ ! -f "$launcher" ] && [ ! -f "$launcher_mjs" ]; then
  exit 0
fi

# 追加一行启动痕迹（失败时静默）。
{
  printf '[%s] [SessionStart] winvm-bridge tunnel ensure (hook)\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} >>"$log_file" 2>/dev/null || true

# 幂等 ensure：优先用可执行的 sh 启动器；否则回落到 node + .mjs（不依赖文件可执行位）。
# stdout/stderr 全部重定向到日志；任何非零退出码均被 `|| true` 吞掉。
if [ -x "$launcher" ]; then
  "$launcher" tunnel ensure >>"$log_file" 2>&1 </dev/null || true
elif [ -f "$launcher_mjs" ]; then
  "${WINVM_NODE:-node}" "$launcher_mjs" tunnel ensure >>"$log_file" 2>&1 </dev/null || true
fi

exit 0

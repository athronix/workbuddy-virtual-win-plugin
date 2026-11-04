#!/usr/bin/env bash
# winvm-plugin-deploy · 铁律通道执行器（R8/X-3/D-2 教训产品化）
# 用法：
#   ps-run.sh <local.ps1> [输出文件]        # 推送并执行 .ps1，stdout 落文件+回显
#   ps-run.sh -c '<powershell 单行>'        # 短片段走 EncodedCommand（base64 UTF-16LE，零引号/零本地展开面）
# 为什么必须这样：VM sshd 默认壳=cmd.exe（Windows OpenSSH 出厂默认），Git-Bash 拓扑亦常见；
#   含 $_ / $p / 引号 / 反斜杠的内联命令串会被某一边壳吞改（R8：安装链 183 次失败根因）。
#   复合逻辑 → 文件推送 -File；短片段 → EncodedCommand（单 token，cmd/bash/pwsh 通吃）。
set -u
: "${VMDEPLOY_ENV_SH:=${HOME}/wbtmp/vmdeploy-env.sh}"; [ -f "$VMDEPLOY_ENV_SH" ] && . "$VMDEPLOY_ENV_SH"
NODE="${NODE:-$(command -v node || true)}"
_here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
if [ -z "${VM_CHANNEL:-}" ]; then . "$_here/vm-conn.sh"; vm_channel_probe || exit 1; fi

_ps_cmd() { vmssh "$1"; }   # $1=已确保零本地展开的命令串

if [ "${1:-}" = "-c" ]; then
  PS_LINE="${2:?-c 需要 PowerShell 语句}"
  ENC="$("$NODE" -e 'process.stdout.write(Buffer.from(process.argv[1],"utf16le").toString("base64"))' "$PS_LINE")"
  _ps_cmd "powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${ENC}"; exit $?
fi

PS_LOCAL="${1:?用法：ps-run.sh <file.ps1> [out] 或 ps-run.sh -c '<line>'}"
OUT="${2:-}"
[ -f "$PS_LOCAL" ] || { echo "PS 文件不存在：$PS_LOCAL" >&2; exit 2; }
base="$(basename "$PS_LOCAL")"
# ASCII 载荷纪律：非 ASCII → 远端 GBK 码页乱码（判据字段虽 ASCII，日志不可读仍拖慢诊断）
"$NODE" -e 'for(const x of require("fs").readFileSync(process.argv[1])) if(x>127){console.error("NON_ASCII_PAYLOAD：改英文/ASCII 标记");process.exit(3)}' "$PS_LOCAL" || exit 3

vmscp "$PS_LOCAL" "${VM_USER}@${VM_HOST}:${base}" >/dev/null 2>&1 || { echo "VMS scp 失败（先查 VM_CHANNEL）" >&2; exit 1; }
_tmp="$(mktemp)"
_ps_cmd "powershell -NoProfile -ExecutionPolicy Bypass -File ${base}" > "$_tmp" 2>&1; rc=$?
# 清理远端临时件走 EncodedCommand（Remove-Item 含 -LiteralPath，避免壳吞参）
_enc="$("$NODE" -e 'process.stdout.write(Buffer.from(`Remove-Item -LiteralPath "${base}" -Force -ErrorAction SilentlyContinue`,"utf16le").toString("base64"))')"
_ps_cmd "powershell -NoProfile -NonInteractive -EncodedCommand ${_enc}" >/dev/null 2>&1 || true
[ -n "$OUT" ] && cat "$_tmp" > "$OUT"
cat "$_tmp"; rm -f "$_tmp" 2>/dev/null || "$NODE" -e 'require("fs").unlinkSync(process.argv[1])' "$_tmp" 2>/dev/null
exit $rc

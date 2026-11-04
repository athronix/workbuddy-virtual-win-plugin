#!/usr/bin/env bash
# winvm-plugin-deploy · 通道自救（run13 定谳：ssh 通道挂起/banner 不吐，但 MCP 隧道健在时的救援路径）
# 原理：VM 内服务与宿主间的既有隧道长连接不依赖新 ssh 连接 ⇒ 用能力通道执行 guest 重启/服务操作，
#       比 hypervisor 手动快且全程 traceId/auditRef 审计。
# 用法：
#   bash self-rescue.sh check                      # 体检：health+sshd 实况+banner 探针（判是否挂起形态）
#   bash self-rescue.sh restart-guest [延迟秒=8]   # app.process.launch shutdown /r（危险度低=发布包标准应急）
#   bash self-rescue.sh restart-service sshd       # system.service.control restart（L1，轻量首选试一次即可）
# 之后：bash wait-channel.sh 3 10 判稳，再回 driver 主流程。
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
: "${VMDEPLOY_ENV_SH:=${HOME}/wbtmp/vmdeploy-env.sh}"; [ -f "$VMDEPLOY_ENV_SH" ] && . "$VMDEPLOY_ENV_SH"
PY="${PY:-$(command -v python3 || true)}"; NODE="${NODE:-$(command -v node || true)}"
ENDPOINT="${VMDEPLOY_ENDPOINT:-http://127.0.0.1:18443}"
[ -n "$PY" ] || { echo "缺 PY：先跑 env-detect.sh" >&2; exit 2; }

_mcp_call() {  # $1=tool $2=json-args  → stdout=结果 JSON 文本
  "$PY" - "$ENDPOINT" "$1" "$2" <<'PYX'
import sys, json, urllib.request
ep, tool, args = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
url = ep.rstrip("/") + "/mcp"
def post(payload, sid=None, timeout=120):
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), method="POST")
    req.add_header("Content-Type", "application/json"); req.add_header("Accept", "application/json, text/event-stream")
    if sid: req.add_header("Mcp-Session-Id", sid)
    r = urllib.request.urlopen(req, timeout=timeout)
    sid2 = r.headers.get("Mcp-Session-Id"); raw = r.read().decode("utf-8", "replace")
    if "text/event-stream" in r.headers.get("Content-Type", ""):
        msgs = [json.loads(l[5:].strip()) for l in raw.splitlines() if l.startswith("data:") and l[5:].strip()]
        return (msgs[-1] if msgs else {}), sid2
    return (json.loads(raw) if raw.strip() else {}), sid2
init, sid = post({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"self-rescue","version":"1"}}})
res, sid = post({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":tool,"arguments":args}}, sid, timeout=180)
txt = "".join(c.get("text","") for c in (res.get("result") or {}).get("content", []))
print(txt if txt else json.dumps(res)[:400])
PYX
}

case "${1:-check}" in
  check)
    RC=$(curl -sS --noproxy 127.0.0.1 -o /dev/null -w '%{http_code}' --max-time 10 "$ENDPOINT/health" 2>/dev/null || echo 000)
    echo "health=$RC（200=隧道健在可自救；000=隧道也断 → P-4 人工）"
    [ "$RC" != "200" ] && exit 1
    echo "-- sshd 实况（能力通道）--"; _mcp_call "system.service.list" '{"name":"sshd"}'
    echo "-- banner 探针（TCP 秒连但 8s 不吐=挂起形态）--"
    "$NODE" -e 'const net=require("net");const[h,p]=[(process.argv[1]||"172.16.100.2"),22];const s=net.connect({host:h,port:p});s.setTimeout(8000);let g="";s.on("data",d=>{g+=d;if(g.length>30){console.log("BANNER_OK ["+g.split("\r\n")[0]+"]");s.destroy()}});s.on("timeout",()=>{console.log("NO_BANNER_8S=挂起形态成立");s.destroy()});s.on("error",e=>console.log("TCP_ERR",e.message));' "${VM_HOST:-172.16.100.2}"
    ;;
  restart-guest)
    D="${2:-8}"
    echo "经能力通道重启 guest：shutdown /r /t $D /f （traceId+auditRef 见返回）"
    _mcp_call "app.process.launch" "{\"target\":\"shutdown\",\"arguments\":\"/r /t $D /f\"}"
    echo "→ 等 ~90s 后 bash $HERE/wait-channel.sh 3 10 判稳；隧道若 DEGRADED：node delivery/winvm-plugin.mjs tunnel ensure"
    ;;
  restart-service)
    SVC="${2:-sshd}"
    _mcp_call "system.service.control" "{\"name\":\"$SVC\",\"action\":\"restart\"}"
    ;;
  *) echo "用法：self-rescue.sh check | restart-guest [秒] | restart-service [sshd]" >&2; exit 2 ;;
esac

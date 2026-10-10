probe_at=2026-10-11T03:36:31+08:00
tunnel_check: curl http://127.0.0.1:18443/health ok; ping 172.16.100.2 0% loss
== security block ==
{
  "loopbackOnly": true,
  "boundLoopback": true,
  "authMode": "loopback-only",
  "bearerSelfCheck": {
    "code": "not-mounted",
    "ok": true,
    "reason": "bearer 守卫未挂载（authMode≠bearer-enforced），跳过挂载求值"
  },
  "innerReconnect": {
    "status": "unverified",
    "reason": "authMode=loopback-only：守卫未挂载 ⇒ 回连通路无判定意义（只观测不改判，默认态恒不拒启）"
  }
}

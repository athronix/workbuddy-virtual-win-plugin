#!/usr/bin/env python3
"""WinVM Bridge 部署后全维度验收探针（MCP over HTTP tunnel）。

用法: python3 mcp-probe.py [--endpoint http://127.0.0.1:18443]
退出码: 0 全 PASS / 1 有 FAIL
"""
import argparse
import json
import sys
import urllib.error
import urllib.request

RESULTS = []


def rec(name, ok, detail=""):
    RESULTS.append((name, ok, detail))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f"  :: {detail}" if detail else ""))


class Mcp:
    def __init__(self, endpoint: str):
        self.url = endpoint.rstrip("/") + "/mcp"
        self.session = None
        self.sid = 1

    def _post(self, payload, timeout=120):
        data = json.dumps(payload).encode()
        req = urllib.request.Request(self.url, data=data, method="POST")
        req.add_header("Content-Type", "application/json")
        req.add_header("Accept", "application/json, text/event-stream")
        if self.session:
            req.add_header("Mcp-Session-Id", self.session)
        try:
            resp = urllib.request.urlopen(req, timeout=timeout)
        except urllib.error.HTTPError as e:
            body = e.read()[:400].decode("utf-8", "replace")
            raise RuntimeError(f"HTTP {e.code} {body}") from None
        sid = resp.headers.get("Mcp-Session-Id")
        if sid:
            self.session = sid
        raw = resp.read().decode("utf-8", "replace")
        ctype = resp.headers.get("Content-Type", "")
        if "text/event-stream" in ctype:
            msgs = []
            for line in raw.splitlines():
                if line.startswith("data:"):
                    chunk = line[5:].strip()
                    if chunk:
                        try:
                            msgs.append(json.loads(chunk))
                        except json.JSONDecodeError:
                            pass
            return msgs[-1] if msgs else {}
        txt = raw.strip()
        return json.loads(txt) if txt else {}

    def rpc(self, method, params=None):
        self.sid += 1
        payload = {"jsonrpc": "2.0", "id": self.sid, "method": method}
        if params is not None:
            payload["params"] = params
        return self._post(payload)

    def notify(self, method, params=None):
        payload = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            payload["params"] = params
        try:
            self._post(payload)
        except Exception:
            pass

    def initialize(self):
        r = self.rpc("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "winvm-deploy-probe", "version": "1.0"},
        })
        self.notify("notifications/initialized")
        return r


def check_disabled_tools():
    """宿主 mcp.json 的 disabledTools 才是高危工具的真实闸门（/mcp 原始面必然列全 54）。"""
    import glob
    import os
    want = {
        "system.service.configure", "system.process.terminate", "system.registry.write",
        "system.power.control", "app.winget.uninstall", "storage.file.delete",
        "storage.link.manage", "appops.gui.produce",
    }
    home = os.path.expanduser("~")
    candidates = [os.path.join(home, ".workbuddy/mcp.json")]
    candidates += glob.glob(os.path.join(home, ".workbuddy/connectors/*/mcp.json"))
    found = None
    for p in candidates:
        try:
            with open(p, "r", encoding="utf-8") as f:
                cfg = json.load(f)
        except Exception:
            continue
        for name, srv in (cfg.get("mcpServers") or {}).items():
            if name == "winvm" and (srv.get("disabledTools") or []):
                found = (p, srv.get("disabledTools") or [])
                break
        if found:
            break
    if not found:
        rec("B7 宿主 mcp.json disabledTools 8 条", False, "未找到含 disabledTools 的 winvm 条目")
        return
    p, dis = found
    rel = p.replace(home + "/", "")
    rec("B7 宿主 mcp.json disabledTools 8 条", len(set(dis)) == 8 and want <= set(dis),
        f"count={len(set(dis))} file={rel}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--endpoint", default="http://127.0.0.1:18443")
    args = ap.parse_args()

    # A. 健康与版本指纹
    try:
        with urllib.request.urlopen(args.endpoint.rstrip("/") + "/health", timeout=20) as r:
            health = json.loads(r.read().decode())
        ok = bool(health.get("ok"))
        rec("A1 /health ok:true", ok, f"provider={health.get('provider', {}).get('id')} state={health.get('provider', {}).get('state')}")
        rec("A2 能力数 54", health.get("capabilities", {}).get("count") == 54,
            f"count={health.get('capabilities', {}).get('count')} avail={health.get('capabilities', {}).get('available')}")
        rec("A3 会话健康", health.get("session", {}).get("state") == "healthy",
            f"state={health.get('session', {}).get('state')} locked={health.get('session', {}).get('locked')}")
        rec("A4 仅回环绑定", bool(health.get("security", {}).get("loopbackOnly")),
            f"authMode={health.get('security', {}).get('authMode')}")
        rec("A5 审计链完整", bool(health.get("audit", {}).get("chainValid")),
            f"entries={health.get('audit', {}).get('entries')}")
        rec("A6 审批闸在线", bool(health.get("policyGate", {}).get("delegationRequiredPolicy")),
            f"wiring={health.get('policyGate', {}).get('wiring')}")
    except Exception as e:
        rec("A1 /health ok:true", False, f"ERR {e}")
        print("RESULT: FAIL (health 不可达，后续跳过)")
        return 1

    # B. MCP 握手 + 能力枚举
    mcp = Mcp(args.endpoint)
    try:
        init = mcp.initialize()
        srv = init.get("result", {}).get("serverInfo", {})
        rec("B1 MCP initialize", bool(srv), f"server={srv.get('name')} v={srv.get('version')}")
    except Exception as e:
        rec("B1 MCP initialize", False, f"ERR {e}")
        print("RESULT: FAIL (MCP 不可用)")
        return 1

    try:
        tl = mcp.rpc("tools/list")
        tools = tl.get("result", {}).get("tools", [])
        names = [t.get("name", "") for t in tools]
        dotted = [n for n in names if "." in n]
        rec("B2 tools/list 非空", len(tools) > 0, f"total={len(tools)}")
        rec("B3 工具名为点分形态", len(dotted) == len(tools), f"dotted={len(dotted)}/{len(tools)}")
        rec("B4 工具数 54", len(tools) == 54, f"total={len(tools)}")
        disabled = {
            "system.service.configure", "system.process.terminate", "system.registry.write",
            "system.power.control", "app.winget.uninstall", "storage.file.delete",
            "storage.link.manage", "appops.gui.produce",
        }
        present = sorted(disabled & set(names))
        rec("B5 /mcp 原始面含全 54（disabledTools 是宿主侧过滤）", len(present) == 8,
            f"raw 面暴露={len(present)}（预期 8，由宿主 mcp.json 过滤）")
        missing = sorted({"system.info.get", "storage.disk.list", "app.inventory.list",
                          "gui.session.status", "meta.capability.list"} - set(names))
        rec("B6 关键抽样工具在册", not missing, f"缺失={missing}")
        check_disabled_tools()
    except Exception as e:
        rec("B2 tools/list", False, f"ERR {e}")

    # C. 跨域功能抽样
    def call(tool, arguments=None, label=None):
        try:
            r = mcp.rpc("tools/call", {"name": tool, "arguments": arguments or {}})
            res = r.get("result", {})
            if r.get("error"):
                rec(label or tool, False, f"rpc_error={r['error']}")
                return None
            is_err = bool(res.get("isError"))
            content = res.get("content", [])
            text = ""
            for c in content:
                if c.get("type") == "text":
                    text = c.get("text", "")
                    break
            rec(label or tool, not is_err, (text[:160].replace("\n", " ")))
            return text
        except Exception as e:
            rec(label or tool, False, f"ERR {e}")
            return None

    call("meta.capability.list", {}, "C1 meta.capability.list")
    call("system.info.get", {}, "C2 system.info.get")
    call("storage.disk.list", {}, "C3 storage.disk.list")
    call("app.inventory.list", {}, "C4 app.inventory.list")
    call("gui.session.status", {}, "C5 gui.session.status")

    # D. A2A 面：RFC 8615 发现端点（http-guard 豁免表内，无需 bearer）
    card_url = args.endpoint.rstrip("/") + "/.well-known/agent-card.json"
    try:
        with urllib.request.urlopen(card_url, timeout=30) as r:
            card = json.loads(r.read().decode("utf-8", "replace"))
        rec("D1 A2A agent-card 发现", bool(card.get("name") or card.get("url")),
            f"name={card.get('name')} skills={len(card.get('skills') or [])}")
    except Exception as e:
        rec("D1 A2A agent-card 发现", False, f"ERR {e}")

    # D2: POST /a2a 必须存在（405/400 均算端点存活；404 才算缺失）
    try:
        req = urllib.request.Request(args.endpoint.rstrip("/") + "/a2a",
                                     data=b'{"jsonrpc":"2.0","id":1,"method":"nope","params":{}}',
                                     method="POST")
        req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                rec("D2 POST /a2a 端点存活", True, f"HTTP {r.status}")
        except urllib.error.HTTPError as e:
            rec("D2 POST /a2a 端点存活", e.code != 404, f"HTTP {e.code}")
    except Exception as e:
        rec("D2 POST /a2a 端点存活", False, f"ERR {e}")

    fails = [r for r in RESULTS if not r[1]]
    print()
    print(f"SUMMARY: {len(RESULTS) - len(fails)}/{len(RESULTS)} PASS, {len(fails)} FAIL")
    print("RESULT:", "FAIL" if fails else "PASS")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Validate the Step-6 example prompts: do the referenced capabilities actually work?

One case per example in docs/deploy/deploy-strategy.md Step 6.3.
Read-only: L2/L3 examples are asserted to be ABSENT from the direct-call surface
(that is exactly why they must go through a2a.delegate).

Usage: python3 example-probe.py [--endpoint http://127.0.0.1:18443]
Exit: 0 all PASS / 1 any FAIL / 2 endpoint unreachable
"""
import argparse
import importlib.util
import sys

PROBE = "/storage/Users/currentUser/Documents/projects/workbuddy-virtual-win-plugin/qa/deploy-probes/mcp-probe.py"
_spec = importlib.util.spec_from_file_location("mcp_probe", PROBE)
_m = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_m)
Mcp = _m.Mcp

ap = argparse.ArgumentParser()
ap.add_argument("--endpoint", default="http://127.0.0.1:18443")
args = ap.parse_args()

cli = Mcp(args.endpoint)
try:
    cli.rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                           "clientInfo": {"name": "example-probe", "version": "1.0"}})
except Exception as e:
    print("ENDPOINT_UNREACHABLE:", e)
    sys.exit(2)

results = []


def rec(name, ok, detail=""):
    results.append(ok)
    print(("[PASS] " if ok else "[FAIL] ") + name + ("  :: " + detail if detail else ""))


def call(tool, arguments, label):
    """MCP tools/call with the bare dotted capability id (host prefixes winvm__)."""
    try:
        r = cli.rpc("tools/call", {"name": tool, "arguments": arguments}, timeout=240)
        if r.get("error"):
            rec(label, False, "ERR " + str(r["error"])[:120])
            return
        res = r.get("result") or {}
        body = str(res.get("content", res))[:150].replace("\n", " ")
        rec(label, not res.get("isError"), body)
    except Exception as e:
        rec(label, False, "EXC " + str(e)[:120])


# E1 只读盘点：「列出所有已安装软件，只查不改」
call("app.inventory.list", {}, "E1 app.inventory.list")
# E2 空间分析：「C 盘占用，前 10 大目录，只读」
call("storage.disk.list", {}, "E2a storage.disk.list")
call("storage.space.analyze", {"target": r"C:\"}, "E2b storage.space.analyze")
# E3 看屏幕：「截一张桌面图，告诉我开着哪些窗口」
call("gui.session.status", {}, "E3a gui.session.status")
call("gui.window.list", {}, "E3b gui.window.list")
call("gui.screen.capture", {}, "E3c gui.screen.capture")
# E5 排障第一步：服务清单
call("system.service.list", {}, "E5 system.service.list")

# --- L2/L3 必须不在直调面（证明只能走 a2a.delegate）---
names = set()
try:
    tl = cli.rpc("tools/list", {})
    for t in (tl.get("result") or {}).get("tools", []):
        names.add(t["name"].replace("winvm__", ""))
except Exception as e:
    print("tools/list failed:", e)

high = ["storage.file.delete", "app.winget.uninstall", "appops.gui.produce",
        "system.power.control", "system.registry.write", "system.process.terminate",
        "system.service.configure", "storage.link.manage"]
exposed = [n for n in high if n in names]
rec("E6 L2/L3 共 8 项均不在直调面", not exposed, "仍在直调面=" + (",".join(exposed) or "无"))

print("\nRESULT: %s (%d/%d)" % ("PASS" if all(results) else "FAIL", sum(results), len(results)))
sys.exit(0 if all(results) else 1)

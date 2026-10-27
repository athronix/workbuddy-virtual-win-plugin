#!/usr/bin/env python3
"""Validate the Step-6 example prompts: do the referenced capabilities actually work?

One case per example in docs/deploy/deploy-strategy.md Step 6.3.
Read-only capability calls; the L2/L3 gate check asserts the HOST-SIDE disabledTools
surface in ~/.workbuddy/mcp.json (the raw /mcp tools/list always lists all 54 —
asserting absence there is a known false-claim trap, see deploy-strategy Step 5 pitfall 1).

Usage: python3 example-probe.py [--endpoint http://127.0.0.1:18443] [--home <dir>]
Exit: 0 all PASS / 1 any FAIL / 2 endpoint unreachable
"""
import argparse
import importlib.util
import json
import os
import sys

PROBE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mcp-probe.py")
_spec = importlib.util.spec_from_file_location("mcp_probe", PROBE)
_m = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_m)
Mcp = _m.Mcp

ap = argparse.ArgumentParser()
ap.add_argument("--endpoint", default="http://127.0.0.1:18443")
ap.add_argument("--home", default=os.path.expanduser("~"))
args = ap.parse_args()

cli = Mcp(args.endpoint)
try:
    cli.rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                           "clientInfo": {"name": "example-probe", "version": "1.1"}})
except Exception as e:
    print("ENDPOINT_UNREACHABLE:", e)
    sys.exit(2)

results = []


def rec(name, ok, detail=""):
    results.append(ok)
    print(("[PASS] " if ok else "[FAIL] ") + name + ("  :: " + detail if detail else ""))


def call(tool, arguments, label):
    try:
        r = cli.rpc("tools/call", {"name": tool, "arguments": arguments})
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
call("storage.space.analyze", {"path": "C:\\Users\\User", "depth": 1, "top": 10}, "E2b storage.space.analyze")
# E3 看屏幕：「截一张桌面图，告诉我开着哪些窗口」
call("gui.session.status", {}, "E3a gui.session.status")
call("gui.window.list", {}, "E3b gui.window.list")
call("gui.screen.capture", {}, "E3c gui.screen.capture")
# E5 排障第一步：服务清单
call("system.service.list", {}, "E5 system.service.list")
# ---- 2026-10-27 Step 6.3 全矩阵补测新增（保持只读/零副作用口径）----
# E7 清理建议分析（cleanup.analyze：仅分析不删，L0）
call("storage.cleanup.analyze", {"topLargeFiles": 5}, "E7 storage.cleanup.analyze")
# E8 事件日志（排障场景 S5 只读面）
call("system.eventlog.query", {"logName": "System", "maxEvents": 5, "level": "Error"}, "E8 system.eventlog.query")
# E9 文件搜索（跨端取文件链 S9 第一环，只读）
call("storage.search.query", {"path": "C:\\Users\\User\\Desktop", "pattern": "*", "maxResults": 5}, "E9 storage.search.query")
# E10 winget 安装 dry-run（装软件场景 S4 语义面：supportsDryRun=true，零安装副作用；
#     判据=能力层如实回报——ok:true 或带 exitCode 的如实失败均算链路通，winget=MSIX 空壳约束见 MEMORY）
try:
    r = cli.rpc("tools/call", {"name": "app.winget.install", "arguments": {"id": "7zip.7zip", "dryRun": True}})
    res = r.get("result") or {}
    body0 = str(res.get("content", ""))
    reported = ('"ok": true' in body0.replace("\\", "").replace(" ", "").lower()) or ("exitcode" in body0.lower())
    rec("E10 app.winget.install(dryRun) 如实回报", reported, body0[:120].replace("\n", " "))
except Exception as e:
    rec("E10 app.winget.install(dryRun)", False, "EXC " + str(e)[:100])
# E11 GUI 键盘输入回归（2026-10-27 发现并修复 PS5.1 Marshal::SizeOf([Type]) 真 bug 的防回归钉；
#     判据=sent>0；输入落在无焦点桌面不产生实际文本副作用）
try:
    r = cli.rpc("tools/call", {"name": "gui.input.keyboard", "arguments": {"text": " ", "delayMs": 10}})
    res = r.get("result") or {}
    jtxt = ""
    try:
        jtxt = (res.get("content") or [{}])[0].get("text", "")
        jb = json.loads(jtxt)
        sent = (jb.get("data") or {}).get("sent", 0)
        rec("E11 gui.input.keyboard sent>0（SizeOf 修复防回归）", bool(jb.get("ok")) and sent > 0, "sent=%s" % sent)
    except Exception:
        rec("E11 gui.input.keyboard", False, jtxt[:110])
except Exception as e:
    rec("E11 gui.input.keyboard", False, "EXC " + str(e)[:100])

# E6 高危闸门：读宿主全局 mcp.json 的 disabledTools（正确断言面，非 /mcp tools/list）
HIGH = {"system.service.configure", "system.process.terminate", "system.registry.write",
        "app.winget.uninstall", "storage.file.delete", "storage.link.manage",
        "appops.gui.produce", "system.power.control"}
path = os.path.join(args.home, ".workbuddy", "mcp.json")
try:
    with open(path, encoding="utf-8") as f:
        mcpjson = json.load(f)
except Exception as e:
    rec("E6 disabledTools 闸门", False, "READ-FAIL " + str(e)[:100])
else:
    entry = None
    for key, val in (mcpjson.get("mcpServers") or {}).items():
        if "winvm" in key and isinstance(val, dict) and val.get("disabledTools") is not None:
            entry = (key, val["disabledTools"])
            break
    if not entry:
        rec("E6 disabledTools 闸门", False, "connector:winvm 条目缺 disabledTools")
    else:
        key, dis = entry
        norm = {str(t).split("__", 1)[-1] for t in dis}  # winvm__x.y.z -> x.y.z
        missing = sorted(HIGH - norm)
        rec("E6 disabledTools 覆盖全部 L2/L3（8 项）", len(missing) == 0 and len(dis) == 8,
            "entry=%s count=%d missing=%s" % (key, len(dis), missing or "none"))

print("\nRESULT: %s (%d/%d)" % ("PASS" if all(results) else "FAIL", sum(results), len(results)))
sys.exit(0 if all(results) else 1)

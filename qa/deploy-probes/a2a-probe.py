#!/usr/bin/env python3
"""A2A 委派冒烟：经 winvm-a2a stdio 桥（cli.js）做 a2a.health + a2a.delegate 真调用。

用法: python3 a2a-probe.py [--cli <cli.js>] [--endpoint http://127.0.0.1:18443]
退出码: 0 全 PASS / 1 有 FAIL
"""
import argparse
import json
import os
import subprocess
import sys
import time

RESULTS = []


def rec(name, ok, detail=""):
    RESULTS.append((name, ok, detail))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f"  :: {detail}" if detail else ""), flush=True)


class StdioMcp:
    def __init__(self, cmd):
        self.proc = subprocess.Popen(
            cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, bufsize=1,
        )
        self.sid = 0

    def rpc(self, method, params=None, timeout=240):
        self.sid += 1
        msg = {"jsonrpc": "2.0", "id": self.sid, "method": method}
        if params is not None:
            msg["params"] = params
        self.proc.stdin.write(json.dumps(msg) + "\n")
        self.proc.stdin.flush()
        deadline = time.time() + timeout
        while time.time() < deadline:
            line = self.proc.stdout.readline()
            if not line:
                raise RuntimeError("stdout EOF")
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if obj.get("id") == self.sid:
                return obj
        raise TimeoutError(f"{method} 超时 {timeout}s")

    def notify(self, method, params=None):
        self.sid += 1
        msg = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            msg["params"] = params
        self.proc.stdin.write(json.dumps(msg) + "\n")
        self.proc.stdin.flush()

    def close(self):
        try:
            self.proc.stdin.close()
        except Exception:
            pass
        try:
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cli", default=os.path.expanduser(
        "~/.workbuddy/plugins/cache/winvm/winvm-bridge/0.1.0/a2a-bridge/cli.js"))
    ap.add_argument("--endpoint", default="http://127.0.0.1:18443")
    ap.add_argument("--node", default="/data/storage/el1/bundle/libs/arm64/node/bin/node")
    args = ap.parse_args()

    if not os.path.isfile(args.cli):
        rec("E0 a2a-bridge cli 存在", False, args.cli)
        print("RESULT: FAIL")
        return 1
    rec("E0 a2a-bridge cli 存在", True, args.cli)

    cli = StdioMcp([args.node, args.cli, "--endpoint", args.endpoint, "--timeout", "240000"])
    try:
        init = cli.rpc("initialize", {
            "protocolVersion": "2024-11-05", "capabilities": {},
            "clientInfo": {"name": "a2a-probe", "version": "1.0"},
        }, timeout=60)
        rec("E1 stdio 桥 initialize", bool(init.get("result")), str(init.get("result", {}).get("serverInfo")))
        cli.notify("notifications/initialized")

        tl = cli.rpc("tools/list", {}, timeout=60)
        names = [t.get("name") for t in tl.get("result", {}).get("tools", [])]
        rec("E2 a2a 工具在册", "a2a.delegate" in names, f"tools={names}")

        h = cli.rpc("tools/call", {"name": "a2a.health", "arguments": {}}, timeout=120)
        hres = h.get("result", {})
        htext = "".join(c.get("text", "") for c in hres.get("content", []) if c.get("type") == "text")
        rec("E3 a2a.health", not hres.get("isError"), htext[:200].replace("\n", " "))

        d = cli.rpc("tools/call", {
            "name": "a2a.delegate",
            "arguments": {
                "goal": "查询当前 Windows 机器的系统信息：主机名、当前登录用户、操作系统版本。只读，不要修改任何设置。",
                "maxRisk": "L1",
            },
        }, timeout=240)
        dres = d.get("result", {})
        dtext = "".join(c.get("text", "") for c in dres.get("content", []) if c.get("type") == "text")
        ok = (not dres.get("isError")) and ('"ok": true' in dtext or '"ok":true' in dtext)
        rec("E4 a2a.delegate system.info.get", ok, dtext[:260].replace("\n", " "))
    except Exception as e:
        rec("E1~E4 A2A 冒烟", False, f"ERR {type(e).__name__}: {e}")
    finally:
        cli.close()

    fails = [r for r in RESULTS if not r[1]]
    print()
    print(f"SUMMARY: {len(RESULTS) - len(fails)}/{len(RESULTS)} PASS, {len(fails)} FAIL")
    print("RESULT:", "FAIL" if fails else "PASS")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())

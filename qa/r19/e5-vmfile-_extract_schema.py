import json
p = r"C:/Users/User/WinVMWorkspace/out/body_list.txt"
j = json.loads(open(p, encoding="utf-8").read())
tools = {t["name"]: t for t in j["result"]["tools"]}
for n in ("app.winget.uninstall", "app.winget.install", "app.winget.search"):
    t = tools[n]
    print("===" + n + "===")
    print("TITLE:", t.get("title"))
    print("DESC:", t.get("description"))
    print("SCHEMA:", json.dumps(t.get("inputSchema", {}), ensure_ascii=False))
    print("ANNOT:", json.dumps(t.get("annotations", {}), ensure_ascii=False))

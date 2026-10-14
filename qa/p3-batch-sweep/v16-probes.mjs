const B = "http://127.0.0.1:18443";
let sid = null;
async function call(m, p, id) {
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(B + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(sid ? { "mcp-session-id": sid } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id, method: m, params: p }), signal: AbortSignal.timeout(45000) });
      const s = r.headers.get("mcp-session-id"); if (s) sid = s;
      const t = await r.text();
      return t.includes("data: ") ? JSON.parse(t.split(/\r?\n/).filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("")) : JSON.parse(t);
    } catch (e) { if (a === 2) return { netErr: String(e).slice(0, 60) }; await new Promise((r) => setTimeout(r, 1500)); }
  }
}
const sc = (x) => x?.result?.structuredContent ?? x;
await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "v16", version: "1" } }, 1);
// P1: M3 探测证据源——registry 能否探到 ffmpeg/magick（VM 装了 w64devkit 便携 ffmpeg，或无）
for (const probe of ["ffmpeg", "imagemagick"]) {
  const d = sc(await call("tools/call", { name: "app.inventory.list", arguments: { name: probe } }, 40));
  const rows = Array.isArray(d?.data) ? d.data : null;
  console.log(`V16-P1 inventory(${probe}): ok=${d?.ok} 命中=${rows ? rows.length : JSON.stringify(d).slice(0, 80)}` + (rows && rows.length ? " :: " + rows.map((r) => r.name).join(";").slice(0, 100) : ""));
}
// P2: 直调可达性（引导文案承诺的现实依据）——用 python（VM 已装）
const cli = sc(await call("tools/call", { name: "appops.cli.invoke", arguments: { app: "python", command: "--version" } }, 41));
console.log("V16-P2 cli.invoke(python --version): ok=" + cli?.ok + " exit=" + JSON.stringify(cli?.data?.exitCode) + " out=" + JSON.stringify(cli?.data?.output?.slice(0, 1) ?? cli?.error?.message ?? "").slice(0, 100));

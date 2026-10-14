const B = "http://127.0.0.1:18443";
let sid = null;
async function call(m, p, id) {
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(B + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(sid ? { "mcp-session-id": sid } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id, method: m, params: p }), signal: AbortSignal.timeout(30000) });
      const s = r.headers.get("mcp-session-id"); if (s) sid = s;
      const t = await r.text();
      return t.includes("data: ") ? JSON.parse(t.split(/\r?\n/).filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("")) : JSON.parse(t);
    } catch (e) { if (a === 2) return { netErr: String(e).slice(0, 60) }; await new Promise((r) => setTimeout(r, 1500)); }
  }
}
const sc = (x) => x?.result?.structuredContent ?? x;
await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "m6v2", version: "1" } }, 1);

// clipboard 写侧全错误取证
const cbW = sc(await call("tools/call", { name: "gui.clipboard.manage", arguments: { text: "M6-V2-CLIP" } }, 11));
console.log("CLIP-WRITE:", JSON.stringify(cbW).slice(0, 400));
const cbR = sc(await call("tools/call", { name: "gui.clipboard.manage", arguments: {}, }, 12));
console.log("CLIP-READ:", JSON.stringify(cbR?.data ?? cbR).slice(0, 160));

// archive 正斜杠路径（PS 原生可处理，免转义坑）
const src = "C:/WinVMWorkspace/out/m6src2.txt";
const fw = sc(await call("tools/call", { name: "storage.file.write", arguments: { path: src, content: "m6-roundtrip-v2" } }, 30));
console.log("WRITE-SRC ok=" + fw?.ok + (fw?.ok ? "" : " err=" + JSON.stringify(fw?.error ?? "").slice(0, 120)));
const cz = sc(await call("tools/call", { name: "storage.archive.manage", arguments: { path: src, destination: "C:/WinVMWorkspace/out/m6pack2.zip" } }, 31));
console.log("ARCHIVE-COMPRESS ok=" + cz?.ok + " bytes=" + JSON.stringify(cz?.data?.bytes ?? cz?.error?.message ?? "").slice(0, 120));
const ex = sc(await call("tools/call", { name: "storage.archive.manage", arguments: { path: "C:/WinVMWorkspace/out/m6pack2.zip", destination: "C:/WinVMWorkspace/out/m6ex2", mode: "expand" } }, 32));
console.log("ARCHIVE-EXPAND ok=" + ex?.ok + " extracted=" + JSON.stringify(ex?.data?.extracted ?? ex?.error?.message ?? "").slice(0, 120));

// QA 独立行为级复算（五携带面）——不照抄 cl026 守卫写法，最小 mock 直接调 dist handler
import assert from "node:assert/strict";
const mod = await import("../../packages/host-a2a-bridge/dist/index.js");
const { APPROVAL_PRESENTATION_DIRECTIVE, createA2aBridgeTools } = mod;
const D = APPROVAL_PRESENTATION_DIRECTIVE;
function ap(id = "apr_qa") {
  return { kind: "status-update", taskId: "t_qa", contextId: "c_qa", final: true,
    status: { state: "input-required", message: { kind: "message", role: "agent", messageId: "m",
      parts: [{ kind: "data", data: { type: "approval-request", approvalId: id, risk: "L2",
        message: "需确认", impact: ["i1"], preview: { p: 1 },
        underlying: { capabilityId: "app.x", goalText: "G" } } }] } } };
}
function st(state, text, extra = {}) {
  return { kind: "status-update", taskId: "t_qa", contextId: "c_qa", final: false,
    status: { state, ...(text ? { message: { kind: "message", role: "agent", messageId: "m", parts: [{ kind: "text", text }] } } : {}) }, ...extra };
}
const client = { async *streamMessage() { yield st("working", "准备"); yield ap(); },
  async getTask(id) { return { kind: "task", id, contextId: "c_qa", status: ap("apr_get").status, artifacts: [] }; },
  async close() {} };
const tools = createA2aBridgeTools({ clientProvider: { get: async () => client } });
// 工具数恒 6（L4/L5 面存在的前提）
assert.equal(tools.length, 6);
const del = tools.find(t => t.name === "a2a.delegate");
const reply = tools.find(t => t.name === "a2a.approval.reply");
const tget = tools.find(t => t.name === "a2a.task.get");
// L4 / L5 description 面
assert.ok(del.description.includes("呈现要求") && del.description.includes("show_widget") && del.description.includes("AskUserQuestion"), "L4");
assert.ok(reply.description.includes("AskUserQuestion") && reply.description.includes("show_widget"), "L5");
// L1 summary + content[0].text（尾部追加、前缀逐字）
const res = await del.handler({ goal: "G" }, { traceId: "tr_qa" });
assert.ok(res.structuredContent.summary.startsWith("任务挂起等待审批："), "L1 前缀逐字");
assert.ok(res.structuredContent.summary.includes(D), "L1 summary 追加");
assert.ok(res.content[0].text.includes(D), "L1 content text 追加");
// L2 字段面
assert.equal(res.structuredContent.approval.presentationDirective, D, "L2");
// L3 task.get 两路
const got = await tget.handler({ taskId: "t_qa" }, { traceId: "tr_qa" });
assert.equal(got.structuredContent.approval.presentationDirective, D, "L3 字段");
assert.ok(got.content[0].text.includes(D), "L3 文案");
// 无审批 ⇒ 零携带
const c2 = { async *streamMessage() { yield st("working", "x"); yield st("completed", "ok", { final: true }); }, async getTask() { return { kind: "task", id: "t", contextId: "c", status: { state: "completed" }, artifacts: [] }; }, async close() {} };
const t2 = createA2aBridgeTools({ clientProvider: { get: async () => c2 } });
const r2 = await t2.find(t => t.name === "a2a.delegate").handler({ goal: "x" }, { traceId: "tr" });
assert.ok(!JSON.stringify(r2).includes("presentationDirective"), "纯附加：无载荷零键");
assert.ok(!r2.structuredContent.summary.includes("呈现要求"), "纯附加：无载荷零文案");
console.log("V2-BEHAVIOR: ALL 5 FACES INDEPENDENTLY CONFIRMED");

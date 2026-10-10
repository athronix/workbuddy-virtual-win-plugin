/**
 * MCP HTTP 传输层 —— 宿主断连侦测（ARCH-29 / P2-T4）
 *
 * **为什么单独成文件**（而不是写进 `server.ts`）：
 * `packages/vm-service/src/server.ts` 是 Phase 2 的**单写者文件**（设计 §6 冲突表：只有 P2-T5
 * 可写）。把断连侦测拆成独立模块后，`server.ts` 侧只需要**两行接线**（取 signal、装配 reqCtx），
 * 且这两行可以并入 T5 的执行窗口或由主理人即刻落；本模块自身零单写者冲突、可独立单测。
 *
 * **为什么 signal 在这里构造、而不在 `mcp-framework` 构造**（分层铁律）：
 * 「响应流是否已经正常写完」＝ `res.writableEnded`，这是 **HTTP 层独有的事实**。
 * `mcp-framework` 按设计不感知 `ServerResponse`，只**消费** `McpRequestContext.signal`。
 * 故本文件是「传输层事实 → 框架可懂的中止信号」的**唯一转换点**。
 *
 * ⚠ 中止强度（如实陈述，不得加码）：abort 只能让**本地**停止等待与停止发起后续副作用；
 * VM 内已下发的命令**无法强杀**（cmd.exe 家族无信号透传）。取消口径见
 * `docs/02-design/SECURITY-GOVERNANCE.md` §2.2。
 */

import type { ServerResponse } from 'node:http';

/**
 * 本模块真正需要的响应面能力（比 `ServerResponse` 小得多）：
 * 抽出来是为了**能脱离真 HTTP 服务器单测** —— 测试传一个 `EventEmitter + writableEnded`
 * 的替身即可覆盖 close/正常写完两条分支，不必起服务（沙箱内起 `createService` 会 spawn
 * ps-bridge 并触发原生 fatal，见 `k5-replay.test.js` 头注的同类纪律）。
 */
export interface DisconnectWatchable {
  /** 响应是否已正常写完（`res.end()` 之后为 true） */
  readonly writableEnded: boolean;
  on(event: 'close', listener: () => void): unknown;
  removeListener(event: 'close', listener: () => void): unknown;
}

export interface DisconnectWatch {
  /**
   * 交给框架的中止信号：宿主**异常**断开时 `aborted === true`。
   * 正常写完响应 ⇒ 永不 abort（见下面的判据说明）。
   */
  readonly signal: AbortSignal;
  /** 摘除 `close` 监听器。路由收口后**必须**调用，否则长连接上会残留闭包。 */
  dispose(): void;
}

/**
 * 侦测客户端（宿主）断连，产出 `AbortSignal`。
 *
 * **判据 = `res.on('close')` 且 `!res.writableEnded`**，两个条件缺一不可：
 *  - Node 的 HTTP 响应流在**正常结束时同样触发 `close`**（`IncomingMessage`/`ServerResponse`
 *    自 Node 16 起在请求完成后统一 close）。只挂 `close` ⇒ 每一次**成功**的 MCP 调用结束后
 *    都会 abort，框架层据此把「已正常返回的结果」读成取消 —— 这是**假取消**，比漏报严重；
 *  - `writableEnded === true` 表示我们已经把响应写完了 ⇒ 这次 `close` 是善终，不是断连。
 *
 * 因此本函数的语义是「**只在宿主没收到完整响应就走了时** abort」。
 */
export function watchClientDisconnect(res: DisconnectWatchable | ServerResponse): DisconnectWatch {
  const controller = new AbortController();
  const onClose = (): void => {
    // 正常写完（含 chunked 收尾）⇒ 不是断连，绝不 abort。
    if ((res as DisconnectWatchable).writableEnded) return;
    controller.abort();
  };
  res.on('close', onClose);
  return {
    signal: controller.signal,
    dispose: () => {
      res.removeListener('close', onClose);
    },
  };
}

/**
 * 装配 `handleRequest` 的第二参（`McpRequestContext`）。
 *
 * 存在性纪律（K-13 纯附加）：**两个可选字段都只在有值时才进对象** ——
 *  - `dtid` 缺席（纯宿主直调）⇒ 不写 `delegationId` 键；
 *  - 不传 `signal`（stdio / 未接断连侦测的调用方）⇒ 不写 `signal` 键；
 *  - **两者都缺席 ⇒ 返回 `undefined`**，使 `mcp.handleRequest(parsed, undefined)` 与
 *    接通前的调用形态**逐字节等价**（这是 `r19c-kn1-e` 系双参守卫所钉的旧形态）。
 */
export function buildMcpRequestContext(
  dtid?: string,
  signal?: AbortSignal,
): { delegationId?: string; signal?: AbortSignal } | undefined {
  if (!dtid && !signal) return undefined;
  return {
    ...(dtid ? { delegationId: dtid } : {}),
    ...(signal ? { signal } : {}),
  };
}

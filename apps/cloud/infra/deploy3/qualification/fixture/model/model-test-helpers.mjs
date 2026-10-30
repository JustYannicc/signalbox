import * as NodeAssert from "node:assert/strict";
import { afterAll } from "vite-plus/test";
import * as NodeCrypto from "node:crypto";
import { createCombinedCodexModelPeer } from "./modelPeer.mjs";

class Socket extends EventTarget {
  readyState = 1;
  frames = [];
  accept() {}
  send(data) {
    if (this.readyState !== 1) throw new Error("Socket is closed");
    queueMicrotask(() => this.partner.dispatchEvent(new MessageEvent("message", { data })));
  }
  close(code = 1000, reason = "") {
    if (this.readyState === 3) return;
    this.readyState = this.partner.readyState = 3;
    for (const socket of [this, this.partner]) {
      const event = new Event("close");
      Object.assign(event, { code, reason });
      socket.dispatchEvent(event);
    }
  }
}
function Pair() {
  const first = new Socket();
  const second = new Socket();
  first.partner = second;
  second.partner = first;
  return { 0: first, 1: second };
}

// Node rejects HTTP 101 Responses. The offline transport stub supplies only that
// workerd-owned constructor behavior; every model request still uses the real adapter.
const RealResponse = globalThis.Response;
globalThis.Response = class extends RealResponse {
  constructor(body, options = {}) {
    super(body, { ...options, status: options.status === 101 ? 200 : options.status });
    this.webSocket = options.webSocket;
  }
};

afterAll(() => {
  globalThis.Response = RealResponse;
});

const session = "80bf94d3-a8cf-442c-90f1-4feb645610cc";
function setup({ bind = true, verifyPhysicalRecovery } = {}) {
  const records = [];
  const peer = createCombinedCodexModelPeer({
    WebSocketPair: Pair,
    verifyPhysicalRecovery,
    persistModelRecord: async (record) => {
      NodeAssert.equal(record.sequence, records.length + 1);
      NodeAssert.equal(
        record.sha256,
        NodeCrypto.createHash("sha256").update(record.raw).digest("hex"),
      );
      NodeAssert.equal(record.byteLengthUtf8, Buffer.byteLength(record.raw));
      NodeAssert.equal(typeof record.incarnation, "string");
      records.push(record);
    },
    verifyNativeTerminal: async ({ nativeSessionId }) => {
      NodeAssert.equal(nativeSessionId, session);
      return { durable: true, terminalCount: 1 };
    },
    verifyReplacement: async ({ modelSocketDrain }) => {
      NodeAssert.equal(modelSocketDrain.closedAndJoined, true);
      return { durable: true, stopConfirmed: true, joinConfirmed: true, oldWriterFenced: true };
    },
  });
  peer.prepareIncarnation("A");
  if (bind) peer.bindNativeSession(session);
  return { peer, records };
}
function socketFor(peer) {
  const socket = peer.fetch(
    new Request("http://model.invalid/v1/responses", {
      headers: { upgrade: "websocket" },
    }),
  ).webSocket;
  return socket;
}
function exchange(socket, input, extra = {}) {
  const result = Promise.withResolvers();
  const events = [];
  const onMessage = (event) => {
    const value = JSON.parse(event.data);
    events.push(value);
    if (value.type === "response.completed") {
      cleanup();
      // The adapter must finish its message handler before the next request.
      queueMicrotask(() => queueMicrotask(() => result.resolve(events)));
    }
  };
  const onClose = (event) => {
    cleanup();
    result.reject(new Error(event.reason));
  };
  function cleanup() {
    socket.removeEventListener("message", onMessage);
    socket.removeEventListener("close", onClose);
  }
  socket.addEventListener("message", onMessage);
  socket.addEventListener("close", onClose);
  socket.send(
    JSON.stringify({
      type: "response.create",
      model: "controlled",
      input,
      tools: [{ name: "exec_command" }, { name: "apply_patch" }],
      ...extra,
    }),
  );
  return result.promise;
}
function output(action) {
  if (action.kind === "apply_patch")
    return {
      type: "custom_tool_call_output",
      call_id: action.callId,
      output: `Exit code: 0\nWall time: 0.1 seconds\nOutput:\n${action.expectedOutput}`,
    };
  return {
    type: "function_call_output",
    call_id: action.callId,
    output: `Chunk ID: chunk-${action.callId}\nWall time: 0.1 seconds\nProcess exited with code 0\nOriginal token count: 1\nOutput:\n${action.expectedOutput}`,
  };
}
async function driveTurn(peer, socket, turn, history = []) {
  history.push({ role: "user", content: turn.prompt });
  for (const action of turn.actions) {
    const events = await exchange(socket, history);
    NodeAssert.equal(events[0].response.id, action.responseId);
    NodeAssert.deepEqual(
      events.map((event) => event.type),
      ["response.created", "response.output_item.done", "response.completed"],
    );
    history.push(events[1].item);
    if (action.kind !== "assistant_final") history.push(output(action));
  }
  await peer.completeNativeTurn({ turn: turn.turn, receipt: { offlineStub: true } });
  return history;
}

export { Pair, Socket, setup, socketFor, exchange, output, driveTurn, session };

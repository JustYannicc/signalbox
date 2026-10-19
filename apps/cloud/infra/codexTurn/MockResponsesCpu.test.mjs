import * as NodeAssert from "node:assert/strict";
import { test } from "vite-plus/test";

import { createMockResponsesWebSocket } from "./MockResponsesWebSocket.mjs";
import { CPU_ONLY_MESSAGE, createMockResponsesCpu } from "./MockResponsesCpu.mjs";

class FakeWebSocket extends EventTarget {
  peer;
  readyState = 0;

  accept() {
    this.readyState = 1;
  }

  send(data) {
    NodeAssert.equal(this.readyState, 1);
    NodeAssert.equal(this.peer.readyState, 1);
    const event = new Event("message");
    Object.defineProperty(event, "data", { value: data });
    this.peer.dispatchEvent(event);
  }

  close(code = 1000, reason = "") {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.peer.readyState = 3;
    for (const socket of [this, this.peer]) {
      const event = new Event("close");
      Object.defineProperties(event, {
        code: { value: code },
        reason: { value: reason },
      });
      socket.dispatchEvent(event);
    }
  }
}

class FakeWebSocketPair {
  0 = new FakeWebSocket();
  1 = new FakeWebSocket();

  constructor() {
    this[0].peer = this[1];
    this[1].peer = this[0];
  }
}

test("emits one nine-frame assistant response with exact text and no tools", () => {
  const mock = createMockResponsesCpu();
  const peer = createMockResponsesWebSocket({ mock, WebSocketPair: FakeWebSocketPair });
  const result = peer.route({
    request: new Request("http://mock.invalid/v1/responses", {
      method: "GET",
      headers: { upgrade: "websocket" },
    }),
  });
  result.webSocket.accept();
  const received = [];
  result.webSocket.addEventListener("message", (event) => received.push(JSON.parse(event.data)));

  result.webSocket.send(JSON.stringify({ type: "response.create", input: [] }));

  const expectedTypes = [
    "response.created",
    "response.output_item.added",
    "response.content_part.added",
    "response.output_text.delta",
    "response.output_text.delta",
    "response.output_text.done",
    "response.content_part.done",
    "response.output_item.done",
    "response.completed",
  ];
  NodeAssert.deepEqual(
    received.map(({ type }) => type),
    expectedTypes,
  );
  NodeAssert.equal(peer.metrics.frames.filter(({ direction }) => direction === "out").length, 9);
  NodeAssert.deepEqual(
    peer.metrics.frames
      .filter(({ direction }) => direction === "out")
      .map(({ data }) => JSON.parse(data).type),
    expectedTypes,
  );
  NodeAssert.equal(
    received.filter(
      ({ item }) => item?.type === "function_call" || item?.type === "custom_tool_call",
    ).length,
    0,
  );
  NodeAssert.equal(
    received
      .filter(({ type }) => type === "response.output_text.delta")
      .map(({ delta }) => delta)
      .join(""),
    CPU_ONLY_MESSAGE,
  );
  NodeAssert.equal(
    received.find(({ type }) => type === "response.output_item.done").item.content[0].text,
    CPU_ONLY_MESSAGE,
  );
  NodeAssert.deepEqual(received.at(-1).response.usage, {
    input_tokens: 0,
    input_tokens_details: null,
    output_tokens: 0,
    output_tokens_details: null,
    total_tokens: 0,
  });
  NodeAssert.equal(mock.phase, "complete");
  NodeAssert.equal(mock.requests.length, 1);
  NodeAssert.equal(peer.metrics.mockCalls, 1);
});

test("CPU-only mock rejects invalid input without consuming its single response", () => {
  const mock = createMockResponsesCpu();

  NodeAssert.throws(() => mock.respond({ input: "not-an-array" }), /input array/);
  NodeAssert.equal(mock.phase, "awaiting-response");
  NodeAssert.equal(mock.requests.length, 0);

  mock.respond({ input: [] });
  NodeAssert.throws(() => mock.respond({ input: [] }), /exactly one real Responses request/);
  NodeAssert.equal(mock.requests.length, 1);
});

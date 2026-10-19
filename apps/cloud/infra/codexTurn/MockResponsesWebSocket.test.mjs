import * as NodeAssert from "node:assert/strict";
import { test } from "vite-plus/test";

import { createMockResponses } from "./MockResponses.mjs";
import { createMockResponsesWebSocket } from "./MockResponsesWebSocket.mjs";

const EXEC_CALL_ID = "call-1069-exec";
const PATCH_CALL_ID = "call-1069-apply-patch";
const EXEC_OUTPUT =
  "Chunk ID: exec-1069\n" +
  "Wall Time: 0.0001 seconds\n" +
  "Process exited with code 0\n" +
  "Original token count: 1\n" +
  "Output:\n" +
  "codex-exec-proof\n";
const PATCH_OUTPUT =
  "Exit code: 0\n" +
  "Wall time: 0 seconds\n" +
  "Output:\n" +
  "Success. Updated the following files:\n" +
  "A /workspace/proof.txt\n";

class FakeWebSocket extends EventTarget {
  peer;
  readyState = 0;

  accept() {
    this.readyState = 1;
  }

  send(data) {
    NodeAssert.equal(this.readyState, 1, "socket must be accepted before sending");
    NodeAssert.equal(this.peer.readyState, 1, "peer socket must be accepted before sending");
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

function createRoute(mock = createMockResponses(), faults = {}) {
  return createMockResponsesWebSocket({ mock, WebSocketPair: FakeWebSocketPair, faults });
}

function openSocket(peer) {
  const result = peer.route({
    request: new Request("http://mock.invalid/v1/responses", {
      method: "GET",
      headers: { upgrade: "websocket" },
    }),
  });
  NodeAssert.equal(result.status, 101);
  NodeAssert.deepEqual(result.headers, []);
  NodeAssert.ok(result.webSocket);
  result.webSocket.accept();
  return result.webSocket;
}

function observe(socket) {
  const events = [];
  const closes = [];
  socket.addEventListener("message", (event) => events.push(JSON.parse(event.data)));
  socket.addEventListener("close", (event) =>
    closes.push({ code: event.code, reason: event.reason }),
  );
  return { events, closes };
}

function createResponseSender() {
  let requestNumber = 0;
  return (socket, response) => {
    const currentRequest = requestNumber++;
    socket.send(
      JSON.stringify({
        type: "response.create",
        model: "gpt-6",
        stream: true,
        input: [],
        tool_choice: "auto",
        parallel_tool_calls: true,
        store: false,
        include: [],
        client_metadata: {
          session_id: `session-${currentRequest}`,
          thread_id: "thread-1069",
          turn_id: "turn-1069",
          "x-codex-ws-stream-request-start-ms": String(1_000 + currentRequest),
          traceparent: `trace-${currentRequest}`,
        },
        ...response,
      }),
    );
  };
}

function userInput() {
  return [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Do the proof." }],
    },
  ];
}

function execOutput() {
  return [
    {
      type: "function_call_output",
      call_id: EXEC_CALL_ID,
      output: EXEC_OUTPUT,
    },
  ];
}

function patchOutput() {
  return [
    {
      type: "custom_tool_call_output",
      call_id: PATCH_CALL_ID,
      name: "apply_patch",
      output: PATCH_OUTPUT,
    },
  ];
}

test("serves JSON events and reconstructs warmup and previous-response input", () => {
  const mock = createMockResponses();
  const peer = createRoute(mock);
  const socket = openSocket(peer);
  const observed = observe(socket);
  const createResponse = createResponseSender();

  createResponse(socket, { input: userInput(), generate: false });
  NodeAssert.deepEqual(
    observed.events.map(({ type }) => type),
    ["response.created", "response.completed"],
  );
  NodeAssert.equal(observed.events[0].response.id, "resp-1069-warmup-0");
  NodeAssert.equal(mock.phase, "awaiting-exec-request");
  NodeAssert.equal(mock.requests.length, 0);
  NodeAssert.equal(peer.metrics.warmups, 1);

  createResponse(socket, {
    previous_response_id: "resp-1069-warmup-0",
    input: [],
  });
  NodeAssert.equal(observed.events.at(-2).item.type, "function_call");

  createResponse(socket, {
    previous_response_id: "resp-1069-exec",
    input: execOutput(),
  });
  NodeAssert.equal(observed.events.at(-2).item.type, "custom_tool_call");

  createResponse(socket, {
    previous_response_id: "resp-1069-patch",
    input: patchOutput(),
  });
  NodeAssert.equal(observed.events.at(-2).item.type, "message");
  NodeAssert.equal(mock.phase, "complete");
  NodeAssert.equal(mock.requests.length, 3);
  NodeAssert.deepEqual(
    mock.requests.map(({ input }) => input.map(({ type }) => type)),
    [
      ["message"],
      ["message", "function_call", "function_call_output"],
      [
        "message",
        "function_call",
        "function_call_output",
        "custom_tool_call",
        "custom_tool_call_output",
      ],
    ],
  );
  NodeAssert.equal(peer.metrics.opens, 1);
  NodeAssert.equal(peer.metrics.requests.length, 4);
  NodeAssert.equal(peer.metrics.mockCalls, 3);
  NodeAssert.equal(peer.metrics.httpFallbacks, 0);
  NodeAssert.deepEqual(
    peer.metrics.frames
      .filter(({ direction }) => direction === "out")
      .map(({ data }) => {
        NodeAssert.equal(data.includes("event:"), false);
        return JSON.parse(data).type;
      }),
    observed.events.map(({ type }) => type),
  );
  NodeAssert.equal(peer.metrics.closes.length, 0);
});

test("replays an incremental request after reconnect with full input and fresh metadata", () => {
  const mock = createMockResponses();
  const peer = createRoute(mock, {
    closeBeforeCompletedOnce: true,
    closeBeforeCompletedOnCall: 2,
  });
  const firstSocket = openSocket(peer);
  const first = observe(firstSocket);
  const createResponse = createResponseSender();
  createResponse(firstSocket, { input: userInput() });
  createResponse(firstSocket, {
    previous_response_id: "resp-1069-exec",
    input: execOutput(),
  });

  NodeAssert.deepEqual(
    first.events.map(({ type }) => type),
    [
      "response.created",
      "response.output_item.done",
      "response.completed",
      "response.created",
      "response.output_item.done",
    ],
  );
  NodeAssert.deepEqual(first.closes, [
    { code: 1012, reason: "Injected close before response.completed" },
  ]);

  const secondSocket = openSocket(peer);
  const second = observe(secondSocket);
  createResponse(secondSocket, {
    previous_response_id: null,
    input: [...userInput(), first.events[1].item, ...execOutput()],
  });

  NodeAssert.deepEqual(
    second.events.map(({ type }) => type),
    ["response.created", "response.output_item.done", "response.completed"],
  );
  createResponse(secondSocket, {
    previous_response_id: "resp-1069-patch",
    input: patchOutput(),
  });
  NodeAssert.equal(second.events.at(-2).item.type, "message");
  NodeAssert.equal(mock.requests.length, 3);
  NodeAssert.equal(peer.metrics.mockCalls, 3);
  NodeAssert.equal(peer.metrics.opens, 2);
  NodeAssert.deepEqual(
    peer.metrics.requests.map(({ replay }) => replay),
    [false, false, true, false],
  );
  NodeAssert.equal(peer.metrics.closes.length, 1);
  NodeAssert.equal(peer.metrics.httpFallbacks, 0);
  NodeAssert.deepEqual(
    mock.requests[1].input.map(({ type }) => type),
    ["message", "function_call", "function_call_output"],
  );
  NodeAssert.deepEqual(peer.metrics.requests[2].mockRequest.input, mock.requests[1].input);
  const inboundFrames = peer.metrics.frames
    .filter(({ direction }) => direction === "in")
    .map(({ data }) => JSON.parse(data));
  NodeAssert.deepEqual(
    inboundFrames.map(({ type, stream, client_metadata }) => [
      type,
      stream,
      client_metadata["x-codex-ws-stream-request-start-ms"],
    ]),
    [
      ["response.create", true, "1000"],
      ["response.create", true, "1001"],
      ["response.create", true, "1002"],
      ["response.create", true, "1003"],
    ],
  );
  NodeAssert.equal(inboundFrames[1].client_metadata.session_id, "session-1");
  NodeAssert.equal(inboundFrames[2].client_metadata.session_id, "session-2");
  NodeAssert.deepEqual(
    peer.metrics.events.map(({ type, replay }) => [type, replay]),
    [
      ["response.created", false],
      ["response.output_item.done", false],
      ["response.completed", false],
      ["response.created", false],
      ["response.output_item.done", false],
      ["response.created", true],
      ["response.output_item.done", true],
      ["response.completed", true],
      ["response.created", false],
      ["response.output_item.done", false],
      ["response.completed", false],
    ],
  );
});

test("replays the same response when reconnect follows response.created", () => {
  const mock = createMockResponses();
  NodeAssert.throws(
    () => createMockResponsesWebSocket({ mock, faults: { closeBeforeOutputOnce: "yes" } }),
    /closeBeforeOutputOnce must be a boolean/,
  );

  const peer = createRoute(mock, { closeBeforeOutputOnce: true });
  const createResponse = createResponseSender();
  const firstSocket = openSocket(peer);
  const first = observe(firstSocket);
  createResponse(firstSocket, { input: userInput() });

  NodeAssert.deepEqual(
    first.events.map(({ type }) => type),
    ["response.created"],
  );
  NodeAssert.deepEqual(first.closes, [
    { code: 1012, reason: "Injected close before response.output_item.done" },
  ]);
  const originalResponseId = first.events[0].response.id;
  NodeAssert.equal(mock.phase, "awaiting-exec-output");
  NodeAssert.equal(mock.requests.length, 1);

  const secondSocket = openSocket(peer);
  const second = observe(secondSocket);
  createResponse(secondSocket, { previous_response_id: null, input: userInput() });

  NodeAssert.deepEqual(
    second.events.map(({ type }) => type),
    ["response.created", "response.output_item.done", "response.completed"],
  );
  NodeAssert.equal(second.events[0].response.id, originalResponseId);
  NodeAssert.equal(second.events[1].item.call_id, EXEC_CALL_ID);
  NodeAssert.equal(mock.phase, "awaiting-exec-output");
  NodeAssert.equal(mock.requests.length, 1);
  NodeAssert.equal(peer.metrics.mockCalls, 1);
  NodeAssert.deepEqual(
    peer.metrics.requests.map(({ replay }) => replay),
    [false, true],
  );
  NodeAssert.equal(peer.metrics.opens, 2);
  NodeAssert.equal(peer.metrics.closes.length, 1);

  const inboundFrames = peer.metrics.frames
    .filter(({ direction }) => direction === "in")
    .map(({ data }) => JSON.parse(data));
  NodeAssert.deepEqual(
    inboundFrames.map(({ previous_response_id, input, client_metadata }) => [
      previous_response_id ?? null,
      input.length,
      client_metadata["x-codex-ws-stream-request-start-ms"],
      client_metadata.traceparent,
      client_metadata.session_id,
    ]),
    [
      [null, 1, "1000", "trace-0", "session-0"],
      [null, 1, "1001", "trace-1", "session-1"],
    ],
  );
  NodeAssert.deepEqual(peer.metrics.requests[1].mockRequest.input, mock.requests[0].input);
});

test("holds before output, then releases the remaining response events once", async () => {
  const mock = createMockResponses();
  NodeAssert.throws(
    () => createRoute(mock, { holdBeforeOutputOnce: 1 }),
    /holdBeforeOutputOnce must be a boolean/,
  );
  const peer = createRoute(mock, { holdBeforeOutputOnce: true });
  const createResponse = createResponseSender();
  const socket = openSocket(peer);
  const observed = observe(socket);
  const held = peer.waitForHold();

  createResponse(socket, { input: userInput(), generate: false });
  NodeAssert.deepEqual(
    observed.events.map(({ type }) => type),
    ["response.created", "response.completed"],
    "warmup completes normally without consuming the hold fault",
  );
  NodeAssert.equal(peer.metrics.held, 0);
  NodeAssert.equal(mock.requests.length, 0);

  createResponse(socket, { previous_response_id: "resp-1069-warmup-0", input: [] });
  NodeAssert.deepEqual(await held, {
    socketId: 0,
    requestNumber: 1,
    responseId: "resp-1069-exec",
  });
  NodeAssert.deepEqual(
    observed.events.map(({ type }) => type),
    ["response.created", "response.completed", "response.created"],
  );
  NodeAssert.equal(peer.metrics.held, 1);
  NodeAssert.equal(peer.metrics.released, 0);
  NodeAssert.equal(peer.releaseHeld(), true);
  NodeAssert.equal(peer.releaseHeld(), false);
  NodeAssert.deepEqual(
    observed.events.map(({ type }) => type),
    [
      "response.created",
      "response.completed",
      "response.created",
      "response.output_item.done",
      "response.completed",
    ],
  );
  NodeAssert.equal(peer.metrics.released, 1);
  NodeAssert.deepEqual(
    peer.metrics.events.map(({ type }) => type),
    [
      "response.created",
      "response.completed",
      "response.created",
      "response.output_item.done",
      "response.completed",
    ],
  );
});

test("drops a held response when its socket closes", async () => {
  const peer = createRoute(createMockResponses(), { holdBeforeOutputOnce: true });
  const socket = openSocket(peer);
  const observed = observe(socket);
  const held = peer.waitForHold();
  const createResponse = createResponseSender();
  createResponse(socket, { input: userInput() });
  await held;

  socket.close(1000, "Engine interrupted");

  NodeAssert.deepEqual(
    observed.events.map(({ type }) => type),
    ["response.created"],
  );
  NodeAssert.equal(peer.releaseHeld(), false);
  NodeAssert.equal(peer.metrics.held, 1);
  NodeAssert.equal(peer.metrics.released, 0);
  NodeAssert.equal(peer.metrics.closes.length, 1);
});

test("paces warmup and response events behind proof acknowledgements", async () => {
  const mock = createMockResponses();
  const peer = createRoute(mock, { paceFrames: true });
  const socket = openSocket(peer);
  const observed = observe(socket);
  const createResponse = createResponseSender();
  const acknowledge = async () => {
    socket.send("signalbox-proof-frame-ack");
    await Promise.resolve();
  };

  createResponse(socket, { input: userInput(), generate: false });
  NodeAssert.deepEqual(
    observed.events.map(({ type }) => type),
    ["response.created"],
  );
  NodeAssert.equal(peer.metrics.warmups, 1);
  NodeAssert.equal(peer.metrics.acks, 0);
  await acknowledge();
  NodeAssert.deepEqual(
    observed.events.map(({ type }) => type),
    ["response.created", "response.completed"],
  );

  createResponse(socket, { previous_response_id: "resp-1069-warmup-0", input: [] });
  NodeAssert.deepEqual(
    observed.events.slice(2).map(({ type }) => type),
    ["response.created"],
  );
  NodeAssert.equal(peer.metrics.acks, 1);
  await acknowledge();
  NodeAssert.deepEqual(
    observed.events.slice(2).map(({ type }) => type),
    ["response.created", "response.output_item.done"],
  );
  await acknowledge();
  NodeAssert.deepEqual(
    observed.events.slice(2).map(({ type }) => type),
    ["response.created", "response.output_item.done", "response.completed"],
  );

  NodeAssert.equal(peer.metrics.acks, 3);
  NodeAssert.equal(peer.metrics.requests.length, 2, "ACKs bypass response.create handling");
  NodeAssert.equal(peer.metrics.mockCalls, 1);
  NodeAssert.equal(mock.requests.length, 1);
  NodeAssert.equal(
    peer.metrics.frames.filter(({ direction, type }) => direction === "in" && type === undefined)
      .length,
    2,
  );
});

test("rejects unsolicited acknowledgements, overlapping requests, and incompatible faults", () => {
  const mock = createMockResponses();
  NodeAssert.throws(() => createRoute(mock, { paceFrames: "yes" }), /paceFrames must be a boolean/);
  NodeAssert.throws(
    () => createRoute(mock, { paceFrames: true, closeBeforeOutputOnce: true }),
    /cannot be combined with hold or disconnect faults/,
  );
  NodeAssert.throws(
    () => createRoute(mock, { paceFrames: true, holdBeforeOutputOnce: true }),
    /cannot be combined with hold or disconnect faults/,
  );

  const unsolicitedPeer = createRoute(mock, { paceFrames: true });
  const unsolicitedSocket = openSocket(unsolicitedPeer);
  const unsolicited = observe(unsolicitedSocket);
  unsolicitedSocket.send("signalbox-proof-frame-ack");
  NodeAssert.deepEqual(unsolicited.closes, [
    { code: 1008, reason: "Unsolicited proof frame acknowledgement" },
  ]);
  NodeAssert.equal(unsolicitedPeer.metrics.acks, 0);
  NodeAssert.equal(unsolicitedPeer.metrics.requests.length, 0);

  const concurrentPeer = createRoute(mock, { paceFrames: true });
  const concurrentSocket = openSocket(concurrentPeer);
  const concurrent = observe(concurrentSocket);
  const createResponse = createResponseSender();
  createResponse(concurrentSocket, { input: userInput() });
  NodeAssert.deepEqual(
    concurrent.events.map(({ type }) => type),
    ["response.created"],
  );
  createResponse(concurrentSocket, { input: userInput() });
  NodeAssert.deepEqual(concurrent.closes, [
    { code: 1008, reason: "Expected signalbox-proof-frame-ack while pacing response frames" },
  ]);
  NodeAssert.equal(concurrentPeer.metrics.requests.length, 1);
  NodeAssert.equal(concurrentPeer.metrics.acks, 0);
});

test("clears a pending pace acknowledgement when the socket closes", () => {
  const peer = createRoute(createMockResponses(), { paceFrames: true });
  const socket = openSocket(peer);
  const observed = observe(socket);
  createResponseSender()(socket, { input: userInput() });

  NodeAssert.deepEqual(
    observed.events.map(({ type }) => type),
    ["response.created"],
  );
  socket.close(1000, "Engine interrupted");
  NodeAssert.deepEqual(observed.closes, [{ code: 1000, reason: "Engine interrupted" }]);
  NodeAssert.equal(peer.metrics.acks, 0);
  NodeAssert.equal(peer.metrics.closes.length, 1);
});

test("closes on an SSE event whose JSON type disagrees with its event name", () => {
  const mock = {
    respond() {
      return 'event: response.created\ndata: {"type":"response.completed","response":{"id":"resp-bad"}}\n\n';
    },
  };
  const peer = createRoute(mock);
  const socket = openSocket(peer);
  const observed = observe(socket);
  const createResponse = createResponseSender();

  createResponse(socket, { input: [] });

  NodeAssert.deepEqual(observed.events, []);
  NodeAssert.deepEqual(observed.closes, [{ code: 1011, reason: "Mock Responses peer failed" }]);
  NodeAssert.equal(peer.metrics.mockCalls, 1);
  NodeAssert.equal(peer.metrics.frames.filter(({ direction }) => direction === "out").length, 0);
});

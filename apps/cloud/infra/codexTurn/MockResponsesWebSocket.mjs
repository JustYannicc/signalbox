import {
  cloneJson,
  closeReason,
  isRecord,
  logicalRequestKey,
  parseResponseCreate,
  parseSse,
  peerError,
  requestText,
  routeResult,
  stableJson,
  warmupResponse,
} from "./MockResponsesWebSocketCodec.mjs";

const PROOF_FRAME_ACK = "signalbox-proof-frame-ack";

/**
 * Creates an in-process Responses WebSocket peer for the deterministic mock.
 * `route` has the raw status/header/socket shape expected by KernelWebSocketHost.
 */
export function createMockResponsesWebSocket({
  mock,
  WebSocketPair: WebSocketPairConstructor = globalThis.WebSocketPair,
  faults = {},
} = {}) {
  if (!mock || typeof mock.respond !== "function") throw new TypeError("mock must expose respond");
  if (!isRecord(faults)) throw new TypeError("faults must be an object");
  for (const fault of [
    "closeBeforeCompletedOnce",
    "closeBeforeOutputOnce",
    "holdBeforeOutputOnce",
    "paceFrames",
  ]) {
    if (faults[fault] !== undefined && typeof faults[fault] !== "boolean") {
      throw new TypeError(`faults.${fault} must be a boolean`);
    }
  }
  if (
    faults.closeBeforeCompletedOnCall !== undefined &&
    (!Number.isSafeInteger(faults.closeBeforeCompletedOnCall) ||
      faults.closeBeforeCompletedOnCall < 1)
  ) {
    throw new TypeError("faults.closeBeforeCompletedOnCall must be a positive integer");
  }
  if (
    faults.paceFrames === true &&
    (faults.closeBeforeCompletedOnce === true ||
      faults.closeBeforeOutputOnce === true ||
      faults.holdBeforeOutputOnce === true)
  ) {
    throw new TypeError("faults.paceFrames cannot be combined with hold or disconnect faults");
  }

  const metrics = {
    opens: 0,
    requests: [],
    events: [],
    closes: [],
    frames: [],
    mockCalls: 0,
    warmups: 0,
    held: 0,
    released: 0,
    acks: 0,
    httpFallbacks: 0,
  };
  const replayByRawRequest = new Map();
  const replayByLogicalRequest = new Map();
  let nextSocketId = 0;
  let nextWarmupId = 0;
  let injectedCloseBeforeCompleted = false;
  let injectedCloseBeforeOutput = false;
  let injectedHoldBeforeOutput = false;
  let pendingHold;
  const pendingAcks = new Map();
  let holdReached = false;
  let holdDetails;
  let resolveHold;
  const holdPromise = new Promise((resolve) => {
    resolveHold = resolve;
  });

  function recordFrame(socketId, direction, data, type) {
    metrics.frames.push({
      order: metrics.frames.length,
      socketId,
      direction,
      ...(type === undefined ? {} : { type }),
      data,
    });
  }

  function mockRequestFor(request, contexts) {
    if (!Array.isArray(request.input)) {
      throw peerError(1002, "response.create input must be an array");
    }

    let previous = { input: [], output: [] };
    if (request.previous_response_id !== undefined && request.previous_response_id !== null) {
      const id = request.previous_response_id;
      if (typeof id !== "string" || id.length === 0) {
        throw peerError(1002, "previous_response_id must be a non-empty string");
      }
      previous = contexts.get(id);
      if (!previous) throw peerError(1008, "Unknown previous_response_id on this socket");
    }

    return {
      ...cloneJson(request),
      input: [...previous.input, ...previous.output, ...request.input].map(cloneJson),
    };
  }

  async function sendResponseEvents(pending, startAt = 0) {
    const { server, socketId, requestNumber, replay, responseRecord } = pending;
    for (let eventIndex = startAt; eventIndex < responseRecord.events.length; eventIndex++) {
      const event = responseRecord.events[eventIndex];
      if (
        faults.holdBeforeOutputOnce === true &&
        !injectedHoldBeforeOutput &&
        event.type === "response.output_item.done" &&
        responseRecord.warmup !== true &&
        responseRecord.mockCall === 1
      ) {
        injectedHoldBeforeOutput = true;
        pendingHold = { ...pending, eventIndex };
        metrics.held++;
        holdDetails = { socketId, requestNumber, responseId: responseRecord.id };
        holdReached = true;
        resolveHold(holdDetails);
        return;
      }

      if (
        faults.closeBeforeOutputOnce === true &&
        !injectedCloseBeforeOutput &&
        event.type === "response.output_item.done" &&
        responseRecord.warmup !== true &&
        responseRecord.mockCall === 1
      ) {
        injectedCloseBeforeOutput = true;
        server.close(1012, "Injected close before response.output_item.done");
        return;
      }

      if (
        faults.closeBeforeCompletedOnce === true &&
        !injectedCloseBeforeCompleted &&
        event.type === "response.completed" &&
        responseRecord.output.length > 0 &&
        responseRecord.mockCall === (faults.closeBeforeCompletedOnCall ?? 1)
      ) {
        injectedCloseBeforeCompleted = true;
        server.close(1012, "Injected close before response.completed");
        return;
      }

      const frame = JSON.stringify(event);
      recordFrame(socketId, "out", frame, event.type);
      metrics.events.push({
        order: metrics.events.length,
        socketId,
        requestNumber,
        replay,
        type: event.type,
        payload: cloneJson(event),
      });
      let acknowledgement;
      if (faults.paceFrames === true && eventIndex < responseRecord.events.length - 1) {
        acknowledgement = new Promise((resolve) => {
          pendingAcks.set(socketId, resolve);
        });
      }
      server.send(frame);
      if (acknowledgement && (!(await acknowledgement) || server.readyState !== 1)) return;
    }
  }

  function startResponseEvents(pending, startAt = 0) {
    void sendResponseEvents(pending, startAt).catch(() => {
      if (pending.server.readyState === 1) {
        pending.server.close(1011, "Mock Responses peer failed");
      }
    });
  }

  function waitForHold() {
    return holdReached ? Promise.resolve(holdDetails) : holdPromise;
  }

  function releaseHeld() {
    if (!pendingHold) return false;
    const pending = pendingHold;
    pendingHold = undefined;
    if (pending.server.readyState !== 1) return false;
    metrics.released++;
    startResponseEvents(pending, pending.eventIndex);
    return true;
  }

  function route({ request }) {
    if (!(request instanceof Request)) throw new TypeError("route requires a Request");
    const url = new URL(request.url);
    if (url.pathname !== "/v1/responses") return routeResult(404, "Not Found\n");
    if (request.method !== "GET") return routeResult(405, "Method Not Allowed\n");
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return routeResult(426, "Expected a WebSocket upgrade\n", [["Upgrade", "websocket"]]);
    }
    if (typeof WebSocketPairConstructor !== "function") {
      throw new TypeError("WebSocketPair is unavailable; inject it when running outside workerd");
    }

    const pair = new WebSocketPairConstructor();
    const client = pair[0];
    const server = pair[1];
    if (!client || !server || typeof server.accept !== "function") {
      throw new TypeError("WebSocketPair must provide client and server sockets");
    }

    const socketId = nextSocketId++;
    const contexts = new Map();
    let requestNumber = 0;
    metrics.opens++;

    server.accept();
    server.addEventListener("message", (messageEvent) => {
      if (pendingHold) {
        server.close(1013, "Mock Responses peer has a held response");
        return;
      }
      let text;
      try {
        text = requestText(messageEvent.data);
        recordFrame(socketId, "in", text, text === PROOF_FRAME_ACK ? "proof_ack" : undefined);
      } catch (error) {
        if (error instanceof Error && typeof error.closeCode === "number") {
          server.close(error.closeCode, closeReason(error));
        } else {
          server.close(1002, "Invalid response.create frame");
        }
        return;
      }

      const acknowledge = pendingAcks.get(socketId);
      if (acknowledge) {
        if (text !== PROOF_FRAME_ACK) {
          server.close(1008, `Expected ${PROOF_FRAME_ACK} while pacing response frames`);
          return;
        }
        pendingAcks.delete(socketId);
        metrics.acks++;
        acknowledge(true);
        return;
      }
      if (text === PROOF_FRAME_ACK) {
        server.close(1008, "Unsolicited proof frame acknowledgement");
        return;
      }

      let requestBody;
      try {
        requestBody = parseResponseCreate(text);
      } catch (error) {
        if (error instanceof Error && typeof error.closeCode === "number") {
          server.close(error.closeCode, closeReason(error));
        } else {
          server.close(1002, "Invalid response.create frame");
        }
        return;
      }

      const currentRequest = requestNumber++;
      const rawKey = stableJson(requestBody);
      let responseRecord = replayByRawRequest.get(rawKey);
      let replay = responseRecord !== undefined;
      let mockRequest;
      try {
        if (responseRecord === undefined) {
          mockRequest = mockRequestFor(requestBody, contexts);
          const logicalKey = logicalRequestKey(requestBody, mockRequest.input);
          responseRecord = replayByLogicalRequest.get(logicalKey);
          if (responseRecord === undefined) {
            if (requestBody.generate === false) {
              const id = `resp-1069-warmup-${nextWarmupId++}`;
              responseRecord = {
                ...warmupResponse(id),
                input: mockRequest.input,
                output: [],
                mockCall: 0,
                warmup: true,
              };
              metrics.warmups++;
            } else {
              metrics.mockCalls++;
              const parsed = parseSse(mock.respond(mockRequest));
              const output = parsed.events
                .filter((event) => event.type === "response.output_item.done")
                .map((event) => cloneJson(event.item));
              responseRecord = {
                id: parsed.id,
                events: parsed.events,
                input: mockRequest.input,
                output,
                mockCall: metrics.mockCalls,
                warmup: false,
              };
            }
            replayByLogicalRequest.set(logicalKey, responseRecord);
          } else {
            replay = true;
            mockRequest = { ...cloneJson(requestBody), input: responseRecord.input.map(cloneJson) };
          }
          replayByRawRequest.set(rawKey, responseRecord);
        } else {
          mockRequest = {
            ...cloneJson(requestBody),
            input: responseRecord.input.map(cloneJson),
          };
        }
        contexts.set(responseRecord.id, {
          input: responseRecord.input.map(cloneJson),
          output: responseRecord.output.map(cloneJson),
        });
      } catch (error) {
        metrics.requests.push({
          socketId,
          requestNumber: currentRequest,
          replay,
          request: cloneJson(requestBody),
          ...(mockRequest === undefined ? {} : { mockRequest }),
          error: String(error),
        });
        server.close(1011, "Mock Responses peer failed");
        return;
      }

      metrics.requests.push({
        socketId,
        requestNumber: currentRequest,
        replay,
        warmup: responseRecord.warmup === true,
        request: cloneJson(requestBody),
        mockRequest: cloneJson(mockRequest),
      });

      startResponseEvents({
        server,
        socketId,
        requestNumber: currentRequest,
        replay,
        responseRecord,
      });
    });
    server.addEventListener("close", (event) => {
      if (pendingHold?.socketId === socketId) pendingHold = undefined;
      const acknowledge = pendingAcks.get(socketId);
      if (acknowledge) {
        pendingAcks.delete(socketId);
        acknowledge(false);
      }
      metrics.closes.push({
        socketId,
        code: Number.isInteger(event.code) ? event.code : 1000,
        reason: typeof event.reason === "string" ? event.reason : "",
      });
    });
    server.addEventListener("error", () => {
      server.close(1011, "Mock Responses socket error");
    });

    return { status: 101, headers: [], webSocket: client };
  }

  return { route, metrics, waitForHold, releaseHeld };
}

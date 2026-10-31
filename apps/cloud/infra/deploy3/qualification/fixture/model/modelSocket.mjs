import {
  cloneJson,
  isRecord,
  parseResponseCreate,
  parseSse,
  peerError,
} from "./MockResponsesWebSocketCodec.mjs";

const RESPONSE_URL = "http://model.invalid/v1/responses";
const encoder = new TextEncoder();

function responseItemEvents(events) {
  return events.filter((event) => event.type === "response.output_item.done");
}

function assertTerminalOnce(events, responseId) {
  const created = events.filter((event) => event.type === "response.created");
  const completed = events.filter((event) => event.type === "response.completed");
  const failed = events.filter(
    (event) => event.type === "response.failed" || event.type === "response.incomplete",
  );
  if (created.length !== 1 || created[0].response?.id !== responseId) {
    throw new Error("Responses stream must create its declared response exactly once");
  }
  if (
    completed.length !== 1 ||
    completed[0].response?.id !== responseId ||
    events.at(-1) !== completed[0]
  ) {
    throw new Error("Responses stream must complete its declared response exactly once, last");
  }
  if (failed.length !== 0)
    throw new Error("Responses stream cannot contain a failed or incomplete terminal");
}

export function createCombinedCodexModelSocket({
  WebSocketPair: WebSocketPairConstructor = globalThis.WebSocketPair,
  onRawRequest,
  ownerForSocket = () => undefined,
  respond,
  onRawResponseFrame = async () => {},
  onFailure = () => {},
} = {}) {
  if (typeof onRawRequest !== "function") throw new TypeError("onRawRequest is required");
  if (typeof ownerForSocket !== "function")
    throw new TypeError("ownerForSocket must be a function");
  if (typeof respond !== "function") throw new TypeError("respond is required");
  if (typeof WebSocketPairConstructor !== "function") {
    throw new TypeError("WebSocketPair is unavailable; inject it when running outside workerd");
  }

  const sockets = new Map();
  const closePromises = [];
  const closePromiseById = new Map();
  const socketOwnerById = new Map();
  const responseContexts = new Map();
  const responseIds = new Set();
  const jobsBySocket = new Map();
  const metrics = {
    opens: 0,
    rawRequests: 0,
    responses: 0,
    responseTerminals: 0,
    frames: [],
    closes: [],
    failures: [],
    httpFallbacks: 0,
  };
  let disposed = false;
  const retiredIncarnations = new Set();

  function failSocket(server, cause) {
    const error =
      cause instanceof Error ? cause : new Error("Combined Codex model socket failed.", { cause });
    metrics.failures.push({ message: error.message, code: error.closeCode ?? 1011 });
    try {
      onFailure(error);
    } finally {
      if (server.readyState === 1 || server.readyState === 0) {
        server.close(
          error.closeCode ?? 1011,
          error.closeCode ? error.message : "Combined Codex model peer failed",
        );
      }
    }
  }

  function route({ request }) {
    if (disposed) throw new Error("Combined Codex model socket owner is disposed");
    if (!(request instanceof Request)) throw new TypeError("route requires a Request");
    if (request.url !== RESPONSE_URL) {
      metrics.httpFallbacks++;
      throw new Error(`Unexpected model route ${request.method} ${request.url}`);
    }
    if (request.method !== "GET") {
      metrics.httpFallbacks++;
      throw new Error("Combined Codex fixture only accepts the Responses WebSocket route");
    }
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      metrics.httpFallbacks++;
      throw new Error("Combined Codex fixture refuses HTTP Responses fallback");
    }

    const pair = new WebSocketPairConstructor();
    const client = pair[0];
    const server = pair[1];
    if (!client || !server || typeof server.accept !== "function") {
      throw new TypeError("WebSocketPair must provide client and server sockets");
    }

    const socketId = metrics.opens++;
    const initialOwner = ownerForSocket({ socketId });
    if (
      initialOwner !== undefined &&
      initialOwner !== null &&
      (typeof initialOwner !== "string" || initialOwner.length === 0)
    ) {
      throw new TypeError("ownerForSocket must return a nonempty identity or undefined");
    }
    socketOwnerById.set(socketId, initialOwner ?? null);
    let requestOrdinal = 0;
    let processing = false;
    const closed = new Promise((resolve) => {
      server.addEventListener(
        "close",
        (event) => {
          sockets.delete(socketId);
          metrics.closes.push({
            socketId,
            code: Number.isInteger(event.code) ? event.code : 1000,
            reason: typeof event.reason === "string" ? event.reason : "",
          });
          resolve();
        },
        { once: true },
      );
    });
    closePromises.push(closed);
    closePromiseById.set(socketId, closed);
    sockets.set(socketId, server);
    jobsBySocket.set(socketId, new Set());
    server.accept();

    server.addEventListener("message", (messageEvent) => {
      // Retired sockets can still deliver queued events after their physical owner was fenced.
      if (server.readyState !== 1 || retiredIncarnations.has(socketOwnerById.get(socketId))) return;
      if (processing) {
        failSocket(
          server,
          peerError(1013, "Only one Responses request may be in flight per socket"),
        );
        return;
      }
      processing = true;
      const currentRequestOrdinal = requestOrdinal++;
      const job = (async () => {
        if (typeof messageEvent.data !== "string") {
          throw peerError(1003, "Expected a text frame");
        }
        const rawRequestText = messageEvent.data;
        metrics.rawRequests++;
        const requestReceipt = await onRawRequest({
          rawRequestText,
          socketId,
          requestOrdinal: currentRequestOrdinal,
        });
        if (!isRecord(requestReceipt) || typeof requestReceipt.incarnation !== "string") {
          throw new Error("Model request has no root-captured process incarnation owner");
        }
        const socketOwner = socketOwnerById.get(socketId);
        if (socketOwner === null) socketOwnerById.set(socketId, requestReceipt.incarnation);
        else if (socketOwner !== requestReceipt.incarnation)
          throw new Error("A Responses socket crossed process incarnations");
        const request = parseResponseCreate(rawRequestText);
        if (!Array.isArray(request.input))
          throw peerError(1002, "response.create input must be an array");

        let previous = { input: [], output: [] };
        if (request.previous_response_id !== undefined && request.previous_response_id !== null) {
          if (
            typeof request.previous_response_id !== "string" ||
            request.previous_response_id.length === 0
          ) {
            throw peerError(1002, "previous_response_id must be a non-empty string");
          }
          previous = responseContexts.get(request.previous_response_id);
          if (!previous) throw peerError(1008, "Unknown previous_response_id in this model peer");
        }
        const effectiveRequest = {
          ...cloneJson(request),
          input: [...previous.input, ...previous.output, ...request.input].map(cloneJson),
        };
        const rawResponseText = await respond({
          requestReceipt,
          rawRequestText,
          request: cloneJson(request),
          effectiveRequest,
          socketId,
          requestOrdinal: currentRequestOrdinal,
        });
        const parsed = parseSse(rawResponseText);
        assertTerminalOnce(parsed.events, parsed.id);
        if (responseIds.has(parsed.id)) throw new Error(`Duplicate model response id ${parsed.id}`);
        responseIds.add(parsed.id);

        const output = responseItemEvents(parsed.events).map((event) => cloneJson(event.item));
        responseContexts.set(parsed.id, {
          input: effectiveRequest.input.map(cloneJson),
          output,
        });
        metrics.responses++;
        metrics.responseTerminals++;
        for (const event of parsed.events) {
          const frame = JSON.stringify(event);
          const frameRecord = {
            sequence: metrics.frames.length + 1,
            socketId,
            requestOrdinal: currentRequestOrdinal,
            eventType: event.type,
            raw: frame,
            bytes: encoder.encode(frame).byteLength,
          };
          await onRawResponseFrame(frameRecord, requestReceipt);
          metrics.frames.push(frameRecord);
          server.send(frame);
        }
      })()
        .catch((cause) => failSocket(server, cause))
        .finally(() => {
          processing = false;
          jobsBySocket.get(socketId).delete(job);
        });
      jobsBySocket.get(socketId).add(job);
    });
    server.addEventListener("error", (event) => {
      failSocket(server, event.error ?? new Error("Combined Codex model socket error"));
    });

    return { status: 101, headers: [], webSocket: client };
  }

  async function joinClosed() {
    await Promise.all(closePromises);
    await Promise.all([...jobsBySocket.values()].flatMap((jobs) => [...jobs]));
    return { activeSockets: sockets.size, closedSockets: closePromises.length };
  }

  async function closeIncarnationAndJoin(incarnation) {
    if (typeof incarnation !== "string" || incarnation.length === 0)
      throw new TypeError("incarnation is required");
    retiredIncarnations.add(incarnation);
    const selectedIds = [...socketOwnerById.entries()]
      .filter(([, owner]) => owner === incarnation)
      .map(([socketId]) => socketId);
    const active = selectedIds
      .map((socketId) => [socketId, sockets.get(socketId)])
      .filter(([, socket]) => socket !== undefined);
    for (const [, socket] of active) {
      if (socket.readyState === 1 || socket.readyState === 0)
        socket.close(1000, "Completed incarnation model socket drained");
    }
    await Promise.all(selectedIds.map((socketId) => closePromiseById.get(socketId)));
    await Promise.all(selectedIds.flatMap((socketId) => [...jobsBySocket.get(socketId)]));
    const stillActive = selectedIds.filter((socketId) => sockets.has(socketId));
    if (stillActive.length !== 0)
      throw new Error(`Model sockets for incarnation ${incarnation} did not join`);
    return {
      incarnation,
      socketCount: selectedIds.length,
      alreadyClosed: selectedIds.length - active.length,
      closedAndJoined: true,
    };
  }

  async function closeAndJoin() {
    disposed = true;
    const active = [...sockets.values()];
    for (const socket of active) {
      if (socket.readyState === 1 || socket.readyState === 0)
        socket.close(1000, "Combined Codex fixture owner closed");
    }
    await joinClosed();
    if (sockets.size !== 0)
      throw new Error("Model WebSocket owner returned before all sockets closed");
    return { closedSockets: closePromises.length };
  }

  return {
    route,
    metrics,
    joinClosed,
    closeIncarnationAndJoin,
    closeAndJoin,
    get activeSockets() {
      return sockets.size;
    },
    get disposed() {
      return disposed;
    },
  };
}

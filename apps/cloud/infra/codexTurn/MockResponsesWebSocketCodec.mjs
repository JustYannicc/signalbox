const encoder = new TextEncoder();

const MAX_REQUEST_FRAME_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_RESPONSE_EVENTS = 64;

export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function peerError(code, message) {
  return Object.assign(new Error(message), { closeCode: code });
}

export function requestText(data) {
  if (typeof data !== "string") throw peerError(1003, "Expected a text frame");
  if (encoder.encode(data).byteLength > MAX_REQUEST_FRAME_BYTES) {
    throw peerError(1009, "Request frame is too large");
  }
  return data;
}

export function parseResponseCreate(text) {
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw peerError(1007, "Expected JSON");
  }
  if (!isRecord(envelope) || envelope.type !== "response.create") {
    throw peerError(1002, "Expected response.create");
  }
  return envelope;
}

export function parseSse(sse) {
  if (typeof sse !== "string") throw new TypeError("mock.respond must return an SSE string");
  if (encoder.encode(sse).byteLength > MAX_RESPONSE_BYTES) {
    throw new RangeError("mock Responses event stream is too large");
  }
  if (!sse.endsWith("\n\n")) throw new Error("mock Responses event stream is incomplete");

  const blocks = sse.slice(0, -2).split("\n\n");
  if (blocks.length > MAX_RESPONSE_EVENTS) throw new RangeError("too many mock Responses events");
  const events = blocks.map((block) => {
    const lines = block.split("\n");
    if (lines.length !== 2) throw new Error("mock Responses event must have event and data lines");
    const event = /^event: ([a-z][a-z0-9_.]*)$/.exec(lines[0])?.[1];
    const data = /^data: (.+)$/.exec(lines[1])?.[1];
    if (!event || data === undefined) throw new Error("invalid mock Responses SSE event");

    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      throw new Error("mock Responses SSE data is not JSON");
    }
    if (!isRecord(payload) || payload.type !== event) {
      throw new Error("mock Responses SSE event type does not match its data");
    }
    return payload;
  });

  if (events.length < 2 || events[0].type !== "response.created") {
    throw new Error("mock Responses stream must start with response.created");
  }
  const createdId = events[0].response?.id;
  const completed = events.at(-1);
  if (
    typeof createdId !== "string" ||
    completed?.type !== "response.completed" ||
    completed.response?.id !== createdId
  ) {
    throw new Error("mock Responses stream must complete the created response");
  }
  for (const event of events.slice(1, -1)) {
    if (event.type !== "response.output_item.done" || !isRecord(event.item)) {
      throw new Error("mock Responses stream contains an unexpected event");
    }
  }
  return { id: createdId, events };
}

export function routeResult(status, body = "", headers = []) {
  return { status, headers, body: encoder.encode(body) };
}

export function logicalRequestKey(request, fullInput) {
  const logicalRequest = { ...cloneJson(request), input: fullInput.map(cloneJson) };
  delete logicalRequest.previous_response_id;
  delete logicalRequest.client_metadata;
  return stableJson(logicalRequest);
}

export function warmupResponse(id) {
  return {
    id,
    events: [
      { type: "response.created", response: { id } },
      {
        type: "response.completed",
        response: {
          id,
          usage: {
            input_tokens: 0,
            input_tokens_details: null,
            output_tokens: 0,
            output_tokens_details: null,
            total_tokens: 0,
          },
        },
      },
    ],
  };
}

export function closeReason(error) {
  return typeof error?.closeCode === "number" ? error.message : "Mock Responses peer failed";
}

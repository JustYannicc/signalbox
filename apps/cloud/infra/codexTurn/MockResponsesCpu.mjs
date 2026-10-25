import { isRecord } from "./MockResponsesWebSocketCodec.mjs";

export const CPU_ONLY_MESSAGE = "CPU proof complete.";

const RESPONSE_ID = "resp-1270-cpu-only";
const MESSAGE_ID = "msg-1270-cpu-only";
const FIRST_DELTA = "CPU proof ";
const SECOND_DELTA = "complete.";

function responseEvents() {
  const message = {
    id: MESSAGE_ID,
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: CPU_ONLY_MESSAGE, annotations: [] }],
    status: "completed",
  };
  const textPart = { type: "output_text", text: CPU_ONLY_MESSAGE, annotations: [] };
  const events = [
    {
      type: "response.created",
      sequence_number: 0,
      response: { id: RESPONSE_ID, status: "in_progress" },
    },
    {
      type: "response.output_item.added",
      sequence_number: 1,
      output_index: 0,
      item: {
        id: MESSAGE_ID,
        type: "message",
        role: "assistant",
        content: [],
        status: "in_progress",
      },
    },
    {
      type: "response.content_part.added",
      sequence_number: 2,
      item_id: MESSAGE_ID,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_text.delta",
      sequence_number: 3,
      item_id: MESSAGE_ID,
      output_index: 0,
      content_index: 0,
      delta: FIRST_DELTA,
    },
    {
      type: "response.output_text.delta",
      sequence_number: 4,
      item_id: MESSAGE_ID,
      output_index: 0,
      content_index: 0,
      delta: SECOND_DELTA,
    },
    {
      type: "response.output_text.done",
      sequence_number: 5,
      item_id: MESSAGE_ID,
      output_index: 0,
      content_index: 0,
      text: CPU_ONLY_MESSAGE,
    },
    {
      type: "response.content_part.done",
      sequence_number: 6,
      item_id: MESSAGE_ID,
      output_index: 0,
      content_index: 0,
      part: textPart,
    },
    {
      type: "response.output_item.done",
      sequence_number: 7,
      output_index: 0,
      item: message,
    },
    {
      type: "response.completed",
      sequence_number: 8,
      response: {
        id: RESPONSE_ID,
        status: "completed",
        output: [message],
        usage: {
          input_tokens: 0,
          input_tokens_details: null,
          output_tokens: 0,
          output_tokens_details: null,
          total_tokens: 0,
        },
      },
    },
  ];
  return events;
}

function toSse(events) {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

/** Returns one plain assistant message for the isolated model CPU proof. */
export function createMockResponsesCpu() {
  const requests = [];
  let phase = "awaiting-response";

  function respond(requestBody) {
    if (phase !== "awaiting-response") {
      throw new Error("CPU-only mock allows exactly one real Responses request");
    }
    let body = requestBody;
    if (typeof body === "string") body = JSON.parse(body);
    if (!isRecord(body) || !Array.isArray(body.input)) {
      throw new Error("CPU-only Responses request requires an input array");
    }

    requests.push(structuredClone(body));
    phase = "complete";
    return toSse(responseEvents());
  }

  return {
    respond,
    requests,
    get phase() {
      return phase;
    },
  };
}

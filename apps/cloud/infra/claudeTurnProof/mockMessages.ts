const MOCK_ORIGIN = "http://mock.anthropic.invalid";
const MESSAGE_PATH = "/v1/messages";
const COUNT_TOKENS_PATH = "/v1/messages/count_tokens";
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_REQUESTS = 64;
const MAX_SCRIPTED_TOOLS = 32;
const MAX_ESTIMATED_TOKENS = Math.ceil(MAX_REQUEST_BYTES / 4);

export type MockMessagesToolName = "Read" | "Edit" | "Write" | "Grep" | "Glob" | "Bash";

export interface ScriptedMockTool {
  readonly name: MockMessagesToolName;
  readonly input: Readonly<Record<string, unknown>>;
}

export interface MockMessagesOptions {
  /** Text Claude sees before the first scripted tool call, or the whole reply with no tools. */
  readonly bootText?: string;
  readonly tools?: readonly ScriptedMockTool[];
  readonly finalText?: string;
  readonly recordRequestBodies?: boolean;
}

export interface MockMessagesRequest {
  readonly url: string;
  readonly method: string;
  readonly bodyBytes: number;
  readonly estimatedInputTokens: number;
  readonly body?: unknown;
}

export interface MockToolResult {
  readonly toolUseId: string;
  readonly name: MockMessagesToolName;
  readonly content: unknown;
  readonly is_error: boolean;
  readonly raw: unknown;
}

export interface MockMessagesApi {
  readonly fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly requests: readonly MockMessagesRequest[];
  readonly toolResults: readonly MockToolResult[];
  readonly deniedRequests: readonly string[];
  readonly complete: boolean;
}

interface MessagesRequestBody {
  readonly model?: unknown;
  readonly messages?: unknown;
  readonly stream?: unknown;
}

interface ToolUseBlock {
  readonly type: "tool_use";
  readonly id: string;
  readonly name: MockMessagesToolName;
  readonly input: Readonly<Record<string, unknown>>;
}

type ResponseBlock = { readonly type: "text"; readonly text: string } | ToolUseBlock;

interface MockMessage {
  readonly id: string;
  readonly type: "message";
  readonly role: "assistant";
  readonly model: string;
  readonly content: readonly ResponseBlock[];
  readonly stop_reason: "tool_use" | "end_turn";
  readonly stop_sequence: null;
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function estimateTokens(value: unknown): number {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  return Math.min(MAX_ESTIMATED_TOKENS, Math.max(1, Math.ceil(encoded.byteLength / 4)));
}

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "application/json; charset=utf-8");
  responseHeaders.set("x-signalbox-mock-token-counts", "estimated");
  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
}

function mockError(type: string, message: string, status: number): Response {
  return jsonResponse({ type: "error", error: { type, message } }, status);
}

async function boundedBody(request: Request): Promise<{ text: string; byteLength: number }> {
  const reader = request.body?.getReader();
  if (!reader) return { text: "", byteLength: 0 };
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new RangeError("mock Messages request exceeded its size limit");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(body), byteLength: length };
}

function collectToolResults(
  messages: unknown,
  toolUseId: string,
): Record<string, unknown> | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "user")
      continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "tool_result" &&
        (block as { tool_use_id?: unknown }).tool_use_id === toolUseId
      )
        return block as Record<string, unknown>;
    }
  }
  return undefined;
}

function event(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

function sseResponse(message: MockMessage): Response {
  const events = [
    event("message_start", {
      message: {
        ...message,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: message.usage.input_tokens, output_tokens: 0 },
      },
    }),
  ];
  message.content.forEach((block, index) => {
    if (block.type === "text") {
      events.push(
        event("content_block_start", { index, content_block: { type: "text", text: "" } }),
      );
      events.push(
        event("content_block_delta", { index, delta: { type: "text_delta", text: block.text } }),
      );
    } else {
      events.push(
        event("content_block_start", {
          index,
          content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
        }),
      );
      events.push(
        event("content_block_delta", {
          index,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
        }),
      );
    }
    events.push(event("content_block_stop", { index }));
  });
  events.push(
    event("message_delta", {
      delta: { stop_reason: message.stop_reason, stop_sequence: null },
      usage: { output_tokens: message.usage.output_tokens },
    }),
  );
  events.push(event("message_stop", {}));
  return new Response(events.join(""), {
    headers: {
      "cache-control": "no-cache",
      "content-type": "text/event-stream; charset=utf-8",
      "x-signalbox-mock-token-counts": "estimated",
    },
  });
}

/** In-process Anthropic Messages API fixture. It has no network or model fallback. */
export function createMockMessagesApi(options: MockMessagesOptions = {}): MockMessagesApi {
  const script = (options.tools ?? []).map((tool) => cloneJson(tool));
  if (script.length > MAX_SCRIPTED_TOOLS) throw new RangeError("mock tool script is too long");

  const requestLog: MockMessagesRequest[] = [];
  const resultLog: MockToolResult[] = [];
  const deniedLog: string[] = [];
  let toolIndex = 0;
  let messageCount = 0;
  let currentTool: ToolUseBlock | undefined;
  let complete = false;

  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let request: Request;
    try {
      const url = input instanceof Request ? input.url : new URL(String(input), MOCK_ORIGIN).href;
      request =
        input instanceof Request
          ? init
            ? new Request(input, init)
            : input
          : new Request(url, init);
    } catch {
      const denied = String(input);
      deniedLog.push(denied);
      return mockError("not_found_error", "mock Messages endpoint not found", 404);
    }

    let bodyText = "";
    let bodyBytes = 0;
    let body: MessagesRequestBody = {};
    try {
      const bounded = await boundedBody(request);
      bodyText = bounded.text;
      bodyBytes = bounded.byteLength;
      if (bodyText) body = JSON.parse(bodyText) as MessagesRequestBody;
    } catch (error) {
      if (error instanceof RangeError)
        return mockError("invalid_request_error", "mock request exceeded its size limit", 413);
      return mockError("invalid_request_error", "mock request body must be JSON", 400);
    }

    const inputTokens = estimateTokens(body);
    if (requestLog.length < MAX_REQUESTS)
      requestLog.push({
        url: request.url,
        method: request.method,
        bodyBytes,
        estimatedInputTokens: inputTokens,
        ...(options.recordRequestBodies === false ? {} : { body: cloneJson(body) }),
      });
    else return mockError("rate_limit_error", "mock request limit reached", 429);

    const url = new URL(request.url);
    if (
      url.origin !== MOCK_ORIGIN ||
      (url.pathname !== MESSAGE_PATH && url.pathname !== COUNT_TOKENS_PATH)
    ) {
      deniedLog.push(request.url);
      return mockError("not_found_error", "mock Messages endpoint not found", 404);
    }
    if (request.method !== "POST")
      return mockError("invalid_request_error", "POST is required", 405);

    if (url.pathname === COUNT_TOKENS_PATH)
      return jsonResponse({ input_tokens: inputTokens }, 200, {
        "x-signalbox-mock-count-tokens": "estimated",
      });
    messageCount += 1;

    if (currentTool) {
      const rawResult = collectToolResults(body.messages, currentTool.id);
      if (!rawResult)
        return mockError(
          "invalid_request_error",
          `mock is waiting for tool_result ${currentTool.id}`,
          409,
        );
      const result = cloneJson(rawResult);
      resultLog.push({
        toolUseId: currentTool.id,
        name: currentTool.name,
        content: result.content,
        is_error: result.is_error === true,
        raw: result,
      });
      toolIndex += 1;
      currentTool = undefined;
    }

    const content: ResponseBlock[] = [];
    if (toolIndex < script.length) {
      if (messageCount === 1 && options.bootText)
        content.push({ type: "text", text: options.bootText });
      const nextTool = script[toolIndex]!;
      currentTool = {
        type: "tool_use",
        id: `toolu_mock_${toolIndex + 1}`,
        name: nextTool.name,
        input: nextTool.input,
      };
      content.push(currentTool);
    } else {
      const hasFailure = resultLog.some((result) => result.is_error);
      const finalText = hasFailure
        ? `Mock received ${resultLog.length} scripted tool result(s), including an error result.${options.finalText ? ` ${options.finalText}` : ""}`
        : (options.finalText ??
          (resultLog.length > 0
            ? `Mock received ${resultLog.length} scripted tool result(s).`
            : (options.bootText ?? "Mock reply (no tools scripted).")));
      content.push({ type: "text", text: finalText });
      complete = true;
    }

    const stopReason = currentTool ? "tool_use" : "end_turn";
    const response: MockMessage = {
      id: `msg_mock_${messageCount}`,
      type: "message",
      role: "assistant",
      model: typeof body.model === "string" ? body.model : "mock-claude",
      content,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: estimateTokens(content) },
    };
    return body.stream === true ? sseResponse(response) : jsonResponse(response);
  };

  return {
    fetch,
    get requests() {
      return cloneJson(requestLog);
    },
    get toolResults() {
      return cloneJson(resultLog);
    },
    get deniedRequests() {
      return cloneJson(deniedLog);
    },
    get complete() {
      return complete;
    },
  };
}

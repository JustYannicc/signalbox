import * as Schema from "effect/Schema";
import type { HarnessRuntimeReporter } from "../HarnessProcessLifetime.ts";

const initialized = Schema.is(
  Schema.Struct({
    jsonrpc: Schema.Literal("2.0"),
    id: Schema.Union([Schema.String, Schema.Number]),
    result: Schema.Struct({
      protocolVersion: Schema.String,
      capabilities: Schema.Record(Schema.String, Schema.Unknown),
      serverInfo: Schema.Struct({ name: Schema.String, version: Schema.String }),
    }),
  }),
);

/** Registration ACKs and tools/list cannot establish a protocol initialization response. */
export function observeClaudeMcpResponse(
  response: Response,
  report: HarnessRuntimeReporter["turnMilestone"],
  expectedId?: string | number,
  accepted?: () => void,
): Response {
  if (!response.ok || response.body === null || report === undefined) return response;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const sse = response.headers.get("content-type")?.includes("text/event-stream") === true;
  let retained = "";
  let bytes = 0;
  let done = false;
  const inspect = (text: string) => {
    if (done) return;
    try {
      const value: unknown = JSON.parse(text);
      if (!initialized(value) || (expectedId !== undefined && value.id !== expectedId)) return;
      done = true;
      accepted?.();
      report("mcp-initialize-response");
    } catch {
      // Non-JSON SSE fields and incomplete frames are not initialization results.
    }
  };
  const accept = (chunk?: Uint8Array) => {
    if (done) return;
    bytes += chunk?.byteLength ?? 0;
    if (bytes > 32_768) {
      retained = "";
      done = true;
      return;
    }
    retained += decoder.decode(chunk, { stream: chunk !== undefined });
    if (!sse) {
      if (chunk === undefined) inspect(retained);
      return;
    }
    let boundary: RegExpExecArray | null;
    while ((boundary = /\r?\n\r?\n/.exec(retained)) !== null) {
      const event = retained.slice(0, boundary.index);
      retained = retained.slice(boundary.index + boundary[0].length);
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      inspect(data);
    }
  };
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const next = await reader.read();
          accept(next.done ? undefined : next.value);
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        } catch (error) {
          controller.error(error);
        }
      },
      cancel: (reason) => reader.cancel(reason),
    },
    { highWaterMark: 0 },
  );
  return new Response(body, response);
}

const requestMessage = Schema.is(
  Schema.Struct({
    jsonrpc: Schema.Literal("2.0"),
    method: Schema.Literals(["initialize", "notifications/initialized"]),
    id: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  }),
);

async function inspectRequest(request: Request) {
  if (request.method !== "POST" || request.body === null) return;
  const reader = request.clone().body!.getReader();
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  request.signal.addEventListener("abort", abort, { once: true });
  if (request.signal.aborted) abort();
  let text = "";
  let bytes = 0;
  const decoder = new TextDecoder();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 32_768) return;
      text += decoder.decode(chunk.value, { stream: true });
    }
    const value: unknown = JSON.parse(text + decoder.decode());
    if (requestMessage(value)) return value;
  } catch {
    // Observation cannot reject an otherwise valid forwarded request.
  } finally {
    request.signal.removeEventListener("abort", abort);
    // A tee cancellation waits for the original body; forwarding still owns that branch.
    void reader.cancel().catch(() => undefined);
  }
}

/** A route is initialized only after its matched reply and successful final notification. */
export function createClaudeMcpTransport(
  transport: (request: Request) => Promise<Response>,
  report: HarnessRuntimeReporter["turnMilestone"],
) {
  const exchanges = new Map<string, { readonly id: string | number; replied: boolean }>();
  return async (request: Request): Promise<Response> => {
    if (report === undefined) return transport(request);
    const message = await inspectRequest(request);
    const key = request.url;
    if (message?.method === "initialize" && message.id !== undefined) {
      const exchange = { id: message.id, replied: false };
      if (exchanges.size < 32 || exchanges.has(key)) exchanges.set(key, exchange);
      const response = await transport(request);
      return observeClaudeMcpResponse(response, report, exchange.id, () => {
        if (exchanges.get(key) === exchange) exchange.replied = true;
      });
    }
    const exchange = exchanges.get(key);
    const completesExchange =
      message?.method === "notifications/initialized" &&
      message.id === undefined &&
      exchange?.replied === true;
    const response = await transport(request);
    if (completesExchange && exchanges.get(key) === exchange && response.ok) {
      exchanges.delete(key);
      report("mcp-initialized");
    }
    return response;
  };
}

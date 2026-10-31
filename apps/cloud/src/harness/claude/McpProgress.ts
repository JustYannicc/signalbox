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
      if (!initialized(value)) return;
      done = true;
      report("mcp-initialized");
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

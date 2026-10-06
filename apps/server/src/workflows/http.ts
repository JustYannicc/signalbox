import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { jsonOrText } from "./json.ts";
import { AUTOMATION_WEBHOOK_ROUTE } from "./views.ts";
import { WorkflowEngine } from "./WorkflowEngine.ts";

const MAX_BODY_BYTES = 1024 * 1024;
/** Credentials meant for this server, never handed to automation code. */
const PRIVATE_HEADERS = new Set(["cookie", "authorization", "proxy-authorization"]);

class TooLarge extends Data.TaggedError("TooLarge")<{}> {}

/** Request headers as the run sees them: lowercased, without credentials. */
export function webhookHeaders(headers: Readonly<Record<string, string | undefined>>) {
  const visible: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (value !== undefined && !PRIVATE_HEADERS.has(key)) visible[key] = value;
  }
  return visible;
}

/** Reads the body up to MAX_BODY_BYTES, refusing a larger one before buffering it where possible. */
const readBody = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const declared = Number(request.headers["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return yield* new TooLarge();
    const chunks: Uint8Array[] = [];
    let size = 0;
    yield* Stream.runForEach(request.stream, (chunk) => {
      size += chunk.byteLength;
      if (size > MAX_BODY_BYTES) return Effect.fail(new TooLarge());
      chunks.push(chunk);
      return Effect.void;
    }).pipe(
      // Some servers have no stream for a request without a body; that's an empty body.
      Effect.catchIf(
        (error) => error._tag !== "TooLarge" && size === 0,
        () => request.text.pipe(Effect.filterOrFail((text) => text === "")),
      ),
    );
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  });

/**
 * `POST` starts a run with the body (parsed when it's JSON) as the run's
 * input; headers and the raw body reach the workflow's third argument. A
 * repeated `Idempotency-Key` or `X-Request-Id` within a day answers with the
 * first delivery's run instead of starting another.
 */
export const layer = HttpRouter.add(
  "POST",
  AUTOMATION_WEBHOOK_ROUTE,
  Effect.gen(function* () {
    const engine = yield* WorkflowEngine;
    const { token } = yield* HttpRouter.params;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* readBody(request).pipe(
      Effect.catchTag("TooLarge", () => Effect.succeed(null)),
      Effect.orElseSucceed(() => undefined),
    );
    if (body === null) return HttpServerResponse.text("Payload too large.", { status: 413 });
    if (body === undefined)
      return HttpServerResponse.text("Couldn't read the request body.", { status: 400 });
    const headers = webhookHeaders(request.headers);
    const requestKey = headers["idempotency-key"] ?? headers["x-request-id"];
    const started = yield* engine
      .startFromWebhook({
        token: token ?? "",
        payload: body ? jsonOrText(body) : null,
        headers,
        rawBody: body,
        ...(requestKey ? { requestKey } : {}),
      })
      .pipe(
        Effect.tapError((error) =>
          Effect.logWarning("Automation webhook couldn't start a run", { error }),
        ),
        Effect.option,
      );
    if (started._tag === "None")
      return HttpServerResponse.text("Couldn't start the automation.", { status: 500 });
    if (started.value === null)
      return HttpServerResponse.text("No automation is listening on this webhook.", {
        status: 404,
      });
    return HttpServerResponse.jsonUnsafe(
      { runId: started.value.runId, ...(started.value.duplicate ? { duplicate: true } : {}) },
      { status: 202 },
    );
  }),
);

import { AuthOrchestrationReadScope, AuthSessionId, EnvironmentHttpApi } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ClientIssues from "./ClientIssues.ts";
import * as ClientIssuesHttp from "./ClientIssuesHttp.ts";

class ClientIssuesTestApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.clientIssues,
) {}

const sessionId = AuthSessionId.make("client-issue-http-session");
const traceId = "0123456789abcdef0123456789abcdef";
const spanId = "0123456789abcdef";
const principal = {
  sessionId,
  subject: "local-user",
  method: "browser-session-cookie" as const,
  scopes: [AuthOrchestrationReadScope],
};

const authenticatedLayer = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
  authenticateHttpRequest: () => Effect.succeed(principal),
});

const handlerFor = (
  report: ClientIssues.ClientIssues["Service"]["report"],
  auth = authenticatedLayer,
) => {
  const routes = HttpApiBuilder.layer(ClientIssuesTestApi).pipe(
    Layer.provide(ClientIssuesHttp.layer),
    Layer.provide(auth),
    Layer.provide(Layer.mock(ClientIssues.ClientIssues)({ report })),
    Layer.provide(
      HttpPlatform.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(Etag.layerWeak),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );
  return HttpRouter.toWebHandler(routes, { disableLogger: true });
};

const request = (body: string, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/observability/client-issues", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      traceparent: `00-${traceId}-${spanId}-01`,
      ...headers,
    },
    body,
  });

it.effect("authenticates reports and strips uncontracted error content before the service", () =>
  Effect.gen(function* () {
    const reports: Array<Parameters<ClientIssues.ClientIssues["Service"]["report"]>[0]> = [];
    const { handler, dispose } = handlerFor((input) =>
      Effect.sync(() => {
        reports.push(input);
      }),
    );
    yield* Effect.addFinalizer(() => Effect.promise(dispose));

    const response = yield* Effect.promise(() =>
      handler(
        request(
          JSON.stringify({
            code: "console.error",
            severity: "error",
            source: "console",
            client: "web",
            release: "9.8.7",
            threadId: null,
            folderId: null,
            environmentId: "caller-value",
            traceId,
            spanId,
            method: "projects.list",
            durationMs: 17,
            message: "CANARY-RAW-MESSAGE",
            stack: "CANARY-RAW-STACK",
            content: "CANARY-RAW-CONTENT",
          }),
        ),
      ),
    );

    expect(response.status).toBe(204);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toEqual({
      issue: {
        code: "console.error",
        severity: "error",
        source: "console",
        client: "web",
        release: "9.8.7",
        threadId: null,
        folderId: null,
        environmentId: "caller-value",
        traceId,
        spanId,
        method: "projects.list",
        durationMs: 17,
      },
      sessionId,
    });
    expect(JSON.stringify(reports)).not.toContain("CANARY-RAW");
  }),
);

it.effect("caps streamed request bodies and reports a trace-correlated rejection", () =>
  Effect.gen(function* () {
    let reportCount = 0;
    const { handler, dispose } = handlerFor(() =>
      Effect.sync(() => {
        reportCount += 1;
      }),
    );
    yield* Effect.addFinalizer(() => Effect.promise(dispose));

    const response = yield* Effect.promise(() =>
      handler(request("x".repeat(ClientIssuesHttp.CLIENT_ISSUE_MAX_BODY_BYTES + 1))),
    );

    expect(response.status).toBe(413);
    const body = yield* Effect.promise(() => response.json());
    expect(body).toEqual({
      code: "client_issue_rejected",
      traceId,
    });
    expect(reportCount).toBe(0);
  }),
);

it.effect("rejects unsupported content encodings before reading the body", () =>
  Effect.gen(function* () {
    let reportCount = 0;
    const { handler, dispose } = handlerFor(() =>
      Effect.sync(() => {
        reportCount += 1;
      }),
    );
    yield* Effect.addFinalizer(() => Effect.promise(dispose));

    const response = yield* Effect.promise(() =>
      handler(request("{}", { "content-encoding": "gzip" })),
    );

    expect(response.status).toBe(415);
    expect(reportCount).toBe(0);
  }),
);

it.effect("returns 408 when a streamed request body does not arrive within five seconds", () =>
  Effect.gen(function* () {
    let reportCount = 0;
    const { handler, dispose } = handlerFor(() =>
      Effect.sync(() => {
        reportCount += 1;
      }),
    );
    yield* Effect.addFinalizer(() => Effect.promise(dispose));

    const body = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
    });
    const stalledRequest = new Request("http://localhost/api/observability/client-issues", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        traceparent: `00-${traceId}-${spanId}-01`,
      },
      body,
      duplex: "half",
    });
    const response = yield* Effect.promise(() => handler(stalledRequest));

    expect(response.status).toBe(408);
    const responseBody = yield* Effect.promise(() => response.json());
    expect(responseBody).toEqual({ code: "client_issue_rejected", traceId });
    expect(reportCount).toBe(0);
  }),
);

it.effect("requires traceparent trace and span IDs to match the reported issue", () =>
  Effect.gen(function* () {
    let reportCount = 0;
    const { handler, dispose } = handlerFor(() =>
      Effect.sync(() => {
        reportCount += 1;
      }),
    );
    yield* Effect.addFinalizer(() => Effect.promise(dispose));

    const body = JSON.stringify({
      code: "console.error",
      severity: "error",
      source: "console",
      client: "web",
      release: "9.8.7",
      threadId: null,
      folderId: null,
      environmentId: null,
      traceId,
      spanId,
    });
    const otherTraceId = "abcdef0123456789abcdef0123456789";
    const otherSpanId = "abcdef0123456789";
    const traceMismatch = yield* Effect.promise(() =>
      handler(request(body, { traceparent: `00-${otherTraceId}-${spanId}-01` })),
    );
    const spanMismatch = yield* Effect.promise(() =>
      handler(request(body, { traceparent: `00-${traceId}-${otherSpanId}-01` })),
    );
    const malformedTraceparent = yield* Effect.promise(() =>
      handler(request(body, { traceparent: "not-a-traceparent" })),
    );

    expect(traceMismatch.status).toBe(400);
    expect(spanMismatch.status).toBe(400);
    expect(malformedTraceparent.status).toBe(400);
    expect(reportCount).toBe(0);
  }),
);

it.effect("maps standard authentication failures without exposing their details", () =>
  Effect.gen(function* () {
    const { handler, dispose } = handlerFor(
      () => Effect.void,
      Layer.mock(EnvironmentAuth.EnvironmentAuth)({
        authenticateHttpRequest: () =>
          Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError({})),
      }),
    );
    yield* Effect.addFinalizer(() => Effect.promise(dispose));

    const response = yield* Effect.promise(() => handler(request("{}")));
    expect(response.status).toBe(401);
    const body = yield* Effect.promise(() => response.json());
    expect(body).toEqual({
      code: "client_issue_rejected",
      traceId,
    });
  }),
);

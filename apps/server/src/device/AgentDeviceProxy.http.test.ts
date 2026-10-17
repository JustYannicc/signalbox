// @effect-diagnostics nodeBuiltinImport:off - the test hosts an ephemeral HTTP server around the router's web handler.
import { expect, it } from "@effect/vitest";
import {
  DeviceHostId,
  DeviceId,
  ProviderSessionId,
  ThreadId,
  type DeviceAgentCommandFailure,
  type DeviceServiceState,
} from "@t3tools/contracts";
import * as NodeHttp from "node:http";
import * as NodeStream from "node:stream";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import * as AgentDeviceProxy from "./AgentDeviceProxy.ts";
import * as AgentDeviceProxyRegistry from "./AgentDeviceProxyRegistry.ts";
import * as DeviceAgentDiagnostics from "./DeviceAgentDiagnostics.ts";
import type { AgentDeviceSession } from "./AgentDeviceSession.ts";
import * as DeviceService from "./DeviceService.ts";

const PROXY_TOKEN = "proxy-token";
const DAEMON_TOKEN = "daemon-token";
const liveSession: AgentDeviceSession = {
  sessionId: "agent-session",
  leaseId: "lease-1",
  ownerKind: "agent",
  providerSessionId: ProviderSessionId.make("provider-session"),
  threadId: ThreadId.make("thread-1"),
  hostId: DeviceHostId.make("local"),
  deviceId: DeviceId.make("device-1"),
  platform: "ios",
};

const stateWith = (sessions: ReadonlyArray<unknown>) =>
  ({ sessions }) as unknown as DeviceServiceState;

const requestBody = (command: string, sessionId = liveSession.sessionId) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id: `request-${command}`,
    method: "agent_device.command",
    params: { session: sessionId, command },
  });

const typedFailure = JSON.stringify({
  jsonrpc: "2.0",
  id: "request-large",
  error: {
    code: -32001,
    message: "Runner failed",
    data: {
      message: "The simulator service could not start.",
      details: { reason: "simulator_service_hub_unavailable" },
      diagnosticId: "diag-typed",
    },
  },
});

const unknownFailure = JSON.stringify({
  jsonrpc: "2.0",
  id: "request-unknown",
  error: {
    code: -32002,
    message: "A newer daemon failure.",
    data: { message: "The daemon reported a new failure shape." },
  },
});

const readBody = async (request: NodeHttp.IncomingMessage) => {
  const chunks: Array<Uint8Array> = [];
  for await (const chunk of request) {
    chunks.push(Uint8Array.from(chunk as Uint8Array));
  }
  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const listen = async (handler: (request: Request) => Promise<Response>) => {
  const server = NodeHttp.createServer((incoming, outgoing) => {
    void (async () => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      const body = await readBody(incoming);
      const request = new Request(
        new URL(incoming.url ?? "/", `http://${incoming.headers.host}`).toString(),
        {
          method: incoming.method ?? "GET",
          headers,
          ...(body.byteLength > 0 ? { body: new TextDecoder().decode(body) } : {}),
        },
      );
      const response = await handler(request);
      outgoing.statusCode = response.status;
      response.headers.forEach((value, name) => outgoing.setHeader(name, value));
      if (response.body === null) {
        outgoing.end();
      } else {
        await response.body.pipeTo(NodeStream.Writable.toWeb(outgoing));
      }
    })().catch((error: unknown) => {
      if (!outgoing.headersSent) outgoing.statusCode = 500;
      outgoing.end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind TCP");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
};

it.effect("observes authenticated daemon failures across the real HTTP proxy boundary", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const daemonRequests: Array<{
        readonly headers: Readonly<Record<string, string | string[] | undefined>>;
        readonly body: string;
      }> = [];
      const encoder = new TextEncoder();
      const releaseClosedResponse = yield* Deferred.make<void>();
      const releaseReplacedResponse = yield* Deferred.make<void>();
      const progressRecord = `${JSON.stringify({ type: "progress", text: "x".repeat(2 * 1024 * 1024) })}\n`;
      const typedResponse = `${JSON.stringify({ type: "response", response: JSON.parse(typedFailure) })}\n`;
      const successResponse = `${JSON.stringify({
        type: "response",
        response: { jsonrpc: "2.0", id: "request-large-success", result: { ok: true } },
      })}\n`;
      const progressOnlyBody = `${JSON.stringify({ type: "progress", event: { stage: "runner" } })}\n`;
      const invalidFinalBody = `${JSON.stringify({ type: "response", response: null })}\n`;
      const oversizedNdjsonSuccessRecord = JSON.stringify({
        type: "response",
        response: {
          jsonrpc: "2.0",
          id: "request-oversized-success",
          result: { payload: "x".repeat(70 * 1024) },
        },
      });
      const oversizedJsonSuccess = JSON.stringify({
        jsonrpc: "2.0",
        id: "request-oversized-json-success",
        result: { payload: "x".repeat(2 * 1024 * 1024) },
      });
      const daemonRoute = HttpRouter.add(
        "POST",
        "/rpc",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const body = yield* request.text;
          daemonRequests.push({ headers: request.headers, body });
          if (
            request.headers.authorization !== `Bearer ${DAEMON_TOKEN}` ||
            request.headers["x-agent-device-token"] !== DAEMON_TOKEN
          ) {
            return HttpServerResponse.text("Unauthorized", { status: 401 });
          }
          const command = (JSON.parse(body) as { params: { command: string } }).params.command;
          const responseBody =
            command === "large" || command === "large-success"
              ? Stream.fromIterable([
                  encoder.encode(progressRecord),
                  encoder.encode(command === "large" ? typedResponse : successResponse),
                ])
              : command === "progress-only"
                ? Stream.make(encoder.encode(progressOnlyBody))
                : command === "invalid-final"
                  ? Stream.make(encoder.encode(invalidFinalBody))
                  : command === "oversized-ndjson-newline"
                    ? Stream.make(encoder.encode(`${oversizedNdjsonSuccessRecord}\n`))
                    : command === "oversized-ndjson-no-newline"
                      ? Stream.make(encoder.encode(oversizedNdjsonSuccessRecord))
                      : command === "oversized-json"
                        ? Stream.make(encoder.encode(oversizedJsonSuccess))
                        : command === "close" || command === "replace"
                          ? Stream.concat(
                              Stream.make(encoder.encode('{"type":"progress"}\n')),
                              Stream.fromEffect(
                                Deferred.await(
                                  command === "close"
                                    ? releaseClosedResponse
                                    : releaseReplacedResponse,
                                ).pipe(Effect.as(encoder.encode(typedResponse))),
                              ),
                            )
                          : Stream.make(
                              encoder.encode(
                                JSON.stringify({
                                  type: "response",
                                  response:
                                    command === "unknown"
                                      ? JSON.parse(unknownFailure)
                                      : {
                                          jsonrpc: "2.0",
                                          id: "request-success",
                                          result: { ok: true },
                                        },
                                }),
                              ),
                            );
          return HttpServerResponse.stream(responseBody, {
            status: command === "large" ? 207 : 200,
            headers: {
              "content-type":
                command === "oversized-json" ? "application/json" : "application/x-ndjson",
              "x-daemon-response": "kept",
            },
          });
        }),
      );
      const { handler: daemonHandler } = yield* Effect.acquireRelease(
        Effect.sync(() => HttpRouter.toWebHandler(daemonRoute, { disableLogger: true })),
        ({ dispose }) => Effect.promise(() => dispose()),
      );
      const daemonServer = yield* Effect.acquireRelease(
        Effect.promise(() => listen(daemonHandler)),
        (server) => Effect.promise(() => server.close()),
      );

      const deviceState = yield* SynchronizedRef.make(stateWith([liveSession]));
      const deviceChanges = yield* PubSub.unbounded<DeviceServiceState>();
      const deviceService = DeviceService.DeviceService.of({
        state: SynchronizedRef.get(deviceState),
        subscribe: PubSub.subscribe(deviceChanges),
      } as DeviceService.DeviceService["Service"]);
      const dependencyServices = yield* Layer.build(
        DeviceAgentDiagnostics.layer.pipe(
          Layer.provideMerge(Layer.succeed(DeviceService.DeviceService, deviceService)),
        ),
      );
      const diagnostics = Context.get(
        dependencyServices,
        DeviceAgentDiagnostics.DeviceAgentDiagnostics,
      );
      const panelSubscription = yield* diagnostics.subscribe;
      const registryServices = yield* Layer.build(AgentDeviceProxyRegistry.layer);
      const registry = Context.get(
        registryServices,
        AgentDeviceProxyRegistry.AgentDeviceProxyRegistry,
      );
      const registrationInput = {
        session: liveSession,
        configPath: "/state/agent-session-proxy-token.json",
        proxyToken: PROXY_TOKEN,
        endpoint: {
          baseUrl: `${daemonServer.url}/`,
          token: DAEMON_TOKEN,
          entryPath: "/agent-device.mjs",
        },
      };
      const registration = yield* registry.register(registrationInput);
      const fetchClientServices = yield* Layer.build(FetchHttpClient.layer);
      const fetchClient = Context.get(fetchClientServices, HttpClient.HttpClient);
      const { handler: proxyHandler } = yield* Effect.acquireRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(
            AgentDeviceProxy.routeLayer.pipe(
              Layer.provideMerge(Layer.succeed(DeviceService.DeviceService, deviceService)),
              Layer.provideMerge(
                Layer.succeed(DeviceAgentDiagnostics.DeviceAgentDiagnostics, diagnostics),
              ),
              Layer.provideMerge(
                Layer.succeed(AgentDeviceProxyRegistry.AgentDeviceProxyRegistry, registry),
              ),
              Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, fetchClient)),
            ),
            { disableLogger: true },
          ),
        ),
        ({ dispose }) => Effect.promise(() => dispose()),
      );
      const proxyServer = yield* Effect.acquireRelease(
        Effect.promise(() => listen(proxyHandler)),
        (server) => Effect.promise(() => server.close()),
      );
      const send = (command: string, bodySession = liveSession.sessionId) =>
        fetchClient.execute(
          HttpClientRequest.make("POST")(
            `${proxyServer.url}/api/agent-device/${liveSession.sessionId}/rpc`,
          ).pipe(
            HttpClientRequest.setHeaders({
              authorization: `Bearer ${PROXY_TOKEN}`,
              "x-agent-device-token": PROXY_TOKEN,
              "content-type": "application/json",
              cookie: "browser-session=secret",
              dpop: "browser-proof",
              "x-request-id": `from-client-${command}`,
            }),
            HttpClientRequest.bodyText(requestBody(command, bodySession)),
          ),
        );

      const typed = yield* send("large");
      const typedBody = yield* typed.text;
      if (typed.status !== 207) throw new Error(`Proxy returned ${typed.status}: ${typedBody}`);
      expect(typed.status).toBe(207);
      expect(typed.headers["x-daemon-response"]).toBe("kept");
      expect(typedBody).toBe(`${progressRecord}${typedResponse}`);
      expect(daemonRequests[0]?.headers.authorization).toBe(`Bearer ${DAEMON_TOKEN}`);
      expect(daemonRequests[0]?.headers["x-agent-device-token"]).toBe(DAEMON_TOKEN);
      expect(daemonRequests[0]?.headers.cookie).toBeUndefined();
      expect(daemonRequests[0]?.headers.dpop).toBeUndefined();
      expect(daemonRequests[0]?.headers["x-request-id"]).toBe("from-client-large");
      expect(daemonRequests[0]?.body).toBe(requestBody("large"));
      expect(yield* diagnostics.snapshot).toMatchObject([
        {
          sessionId: liveSession.sessionId,
          reason: "simulator_service_hub_unavailable",
          diagnosticId: "diag-typed",
        },
      ] satisfies ReadonlyArray<Partial<DeviceAgentCommandFailure>>);
      expect(
        Option.getOrNull(yield* Stream.runHead(Stream.fromSubscription(panelSubscription))),
      ).toMatchObject([
        {
          sessionId: liveSession.sessionId,
          reason: "simulator_service_hub_unavailable",
          diagnosticId: "diag-typed",
        },
      ]);

      const oversizedSuccessCases = [
        {
          command: "oversized-ndjson-newline",
          body: `${oversizedNdjsonSuccessRecord}\n`,
        },
        {
          command: "oversized-ndjson-no-newline",
          body: oversizedNdjsonSuccessRecord,
        },
        { command: "oversized-json", body: oversizedJsonSuccess },
      ] as const;
      const typedDiagnostics = yield* diagnostics.snapshot;
      for (const testCase of oversizedSuccessCases) {
        const response = yield* send(testCase.command);
        expect(response.status).toBe(200);
        expect(yield* response.text).toBe(testCase.body);
        expect(yield* diagnostics.snapshot).toEqual(typedDiagnostics);
      }

      for (const testCase of [
        { command: "progress-only", body: progressOnlyBody },
        { command: "invalid-final", body: invalidFinalBody },
      ] as const) {
        const response = yield* send(testCase.command);
        expect(response.status).toBe(200);
        expect(yield* response.text).toBe(testCase.body);
        expect(yield* diagnostics.snapshot).toMatchObject([
          {
            sessionId: liveSession.sessionId,
            command: testCase.command,
            message: "Agent-device returned an invalid command response.",
          },
        ]);
      }

      const largeSuccess = yield* send("large-success");
      expect(largeSuccess.status).toBe(200);
      expect(yield* largeSuccess.text).toBe(`${progressRecord}${successResponse}`);
      expect(yield* diagnostics.snapshot).toEqual([]);

      const unknown = yield* send("unknown");
      expect(yield* unknown.text).toContain(unknownFailure);
      expect(yield* diagnostics.snapshot).toMatchObject([
        {
          sessionId: liveSession.sessionId,
          message: "The daemon reported a new failure shape.",
        },
      ]);
      expect((yield* diagnostics.snapshot)[0]?.reason).toBeUndefined();
      expect((yield* diagnostics.snapshot)[0]?.hint).toBeUndefined();

      const success = yield* send("success");
      yield* success.text;
      expect(yield* diagnostics.snapshot).toEqual([]);

      for (const testCase of oversizedSuccessCases) {
        const response = yield* send(testCase.command);
        expect(response.status).toBe(200);
        expect(yield* response.text).toBe(testCase.body);
        expect(yield* diagnostics.snapshot).toEqual([]);
      }

      const closed = yield* send("close");
      yield* SynchronizedRef.set(deviceState, stateWith([]));
      yield* PubSub.publish(deviceChanges, stateWith([]));
      yield* Deferred.succeed(releaseClosedResponse, undefined);
      yield* closed.text;
      expect(yield* diagnostics.snapshot).toEqual([]);

      yield* SynchronizedRef.set(deviceState, stateWith([liveSession]));
      yield* PubSub.publish(deviceChanges, stateWith([liveSession]));
      const beforeMismatch = daemonRequests.length;
      const mismatched = yield* send("success", "different-session");
      expect(mismatched.status).toBe(409);
      yield* mismatched.text;
      expect(daemonRequests).toHaveLength(beforeMismatch);

      const replaced = yield* send("replace");
      const replacementRegistration = yield* registry.register({
        ...registrationInput,
        configPath: "/state/agent-session-new-token.json",
        proxyToken: "new-proxy-token",
      });
      yield* Deferred.succeed(releaseReplacedResponse, undefined);
      expect(yield* replaced.text).toContain(typedFailure);
      expect(yield* diagnostics.snapshot).toEqual([]);
      expect(yield* registry.isCurrent(registration)).toBe(false);
      expect(yield* registry.isCurrent(replacementRegistration)).toBe(true);
    }),
  ),
);

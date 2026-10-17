import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  EnvironmentId,
  WS_METHODS,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import type { FromServerEncoded } from "effect/rpc/RpcMessage";

import { makeMemoryCloud } from "../testing.ts";
import { openConnection } from "../user/connection.ts";
import * as ClientRpcTracing from "./clientRpcTracing.ts";

const TRACE_ID = "0123456789abcdef0123456789abcdef";
const CLIENT_SPAN_ID = "0123456789abcdef";
const userId = "user_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const identity = { environmentId: EnvironmentId.make("cloud-test"), label: "Cloud" };
const scopes = [
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthProvidersManageScope,
];
const CANARY = "a pool name that must not leave this RPC";

describe("Cloud client RPC tracing", () => {
  it.effect("bounds queued spans while a slow collector is still receiving a batch", () => {
    let started!: () => void;
    const exportStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const bodies: Array<string> = [];
    const retained: Array<Promise<unknown>> = [];
    return Effect.gen(function* () {
      const sink = yield* ClientRpcTracing.ClientRpcTraceSink;
      const span: ClientRpcTracing.RpcSpan = {
        traceId: TRACE_ID,
        spanId: CLIENT_SPAN_ID,
        name: WS_METHODS.accountPoolCreate,
        kind: 2,
        startTimeUnixNano: "1",
        endTimeUnixNano: "2",
        attributes: [],
        status: { code: 1 },
      };
      for (let i = 0; i < 1000; i++) sink.submit(span);
      yield* Effect.promise(() => exportStarted);
      for (let i = 0; i < 1000; i++) sink.submit(span);
      expect(retained).toHaveLength(1);
      expect(bodies).toHaveLength(1);
      expect(JSON.parse(bodies[0]!).resourceSpans[0].scopeSpans[0].spans).toHaveLength(128);
      release(new Response(null, { status: 200 }));
      yield* Effect.promise(() => retained[0]!);
      sink.submit(span);
      yield* Effect.promise(() => retained[1]!);
      expect(bodies).toHaveLength(2);
      expect(JSON.parse(bodies[1]!).resourceSpans[0].scopeSpans[0].spans).toHaveLength(1);
    }).pipe(
      Effect.provide(
        ClientRpcTracing.layer(
          {
            TRACE_EXPORT_TOKEN: "trace-test-token",
            TRACE_EXPORT: {
              fetch: async (input, init) => {
                const request = input instanceof Request ? input : new Request(input, init);
                bodies.push(await request.text());
                started();
                return response;
              },
            },
          },
          (promise) => retained.push(promise),
        ),
      ),
    );
  });

  it.effect("exports a joined server span without holding the RPC open", () =>
    Effect.gen(function* () {
      const cloud = makeMemoryCloud();
      yield* cloud.userDirectory.forUser(userId).recordSignIn({
        id: userId,
        email: "trace@example.com",
      });

      let resolveExportStarted!: (value: {
        readonly request: Request;
        readonly body: string;
      }) => void;
      const exportStarted = new Promise<{ readonly request: Request; readonly body: string }>(
        (resolve) => {
          resolveExportStarted = resolve;
        },
      );
      let releaseExport!: (response: Response) => void;
      let exportPending = true;
      const exportResponse = new Promise<Response>((resolve) => {
        releaseExport = (response) => {
          exportPending = false;
          resolve(response);
        };
      });
      const retained: Array<Promise<unknown>> = [];
      const traceExport = {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = input instanceof Request ? input : new Request(input, init);
          resolveExportStarted({ request, body: await request.clone().text() });
          return exportResponse;
        },
      };
      const context = yield* Layer.build(
        Layer.mergeAll(
          cloud.layerFor(userId),
          ClientRpcTracing.layer(
            {
              TRACE_EXPORT: traceExport,
              TRACE_EXPORT_TOKEN: "trace-test-token",
              SIGNALBOX_STAGE: "trace-test-stage",
              APP_VERSION: "trace-test-version",
            },
            (promise) => retained.push(promise),
          ),
        ),
      );

      const scope = Scope.makeUnsafe();
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
      let resolveRpc!: (message: FromServerEncoded) => void;
      const rpcResponse = new Promise<FromServerEncoded>((resolve) => {
        resolveRpc = resolve;
      });
      const connection = yield* openConnection({
        identity,
        userId,
        sid: "trace-session",
        scopes,
        send: (_frame, message) => {
          if (message._tag === "Exit" && message.requestId === "trace-request") {
            resolveRpc(message);
          }
        },
      }).pipe(Scope.provide(scope), Effect.provideContext(context));

      yield* connection.receive(
        JSON.stringify({
          _tag: "Request",
          id: "trace-request",
          tag: WS_METHODS.accountPoolCreate,
          payload: { name: CANARY },
          headers: [],
          traceId: TRACE_ID,
          spanId: CLIENT_SPAN_ID,
          sampled: true,
        }),
      );

      const response = yield* Effect.promise(() => rpcResponse);
      expect(response).toMatchObject({ _tag: "Exit", exit: { _tag: "Success" } });

      const exported = yield* Effect.promise(() => exportStarted);
      expect(retained).toHaveLength(1);
      expect(exported.request.url).toBe("https://trace-export/v1/traces");
      expect(exported.request.headers.get("authorization")).toBe("Bearer trace-test-token");
      expect(exported.body).not.toContain(CANARY);
      expect(exportPending).toBe(true);

      const document = JSON.parse(exported.body);
      expect(document.resourceSpans[0].resource.attributes).toContainEqual({
        key: "service.name",
        value: { stringValue: "signalbox-cloud" },
      });
      expect(document.resourceSpans[0].resource.attributes).toContainEqual({
        key: "deployment.environment",
        value: { stringValue: "trace-test-stage" },
      });
      expect(document.resourceSpans[0].resource.attributes).toContainEqual({
        key: "service.version",
        value: { stringValue: "trace-test-version" },
      });
      const spans = document.resourceSpans[0].scopeSpans[0].spans;
      expect(spans).toHaveLength(1);
      expect(spans[0]).toMatchObject({
        traceId: TRACE_ID,
        parentSpanId: CLIENT_SPAN_ID,
        name: WS_METHODS.accountPoolCreate,
        kind: 2,
        status: { code: 1 },
      });
      expect(spans[0].spanId).toMatch(/^[a-f0-9]{16}$/i);
      expect(spans[0].attributes).toContainEqual({
        key: "rpc.method",
        value: { stringValue: WS_METHODS.accountPoolCreate },
      });
      expect(spans[0].attributes).toContainEqual({
        key: "person.id",
        value: { stringValue: userId },
      });

      releaseExport(new Response(null, { status: 200 }));
      yield* Effect.promise(() => retained[0]!);
    }).pipe(Effect.scoped),
  );
});

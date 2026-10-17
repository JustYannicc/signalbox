import { afterEach, describe, expect, it } from "@effect/vitest";
import {
  DeviceHostId,
  DeviceId,
  ProviderSessionId,
  ThreadId,
  type DeviceAgentCommandFailure,
  type DeviceServiceState,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpRouter } from "effect/http";

import * as AgentDeviceProxy from "./AgentDeviceProxy.ts";
import { decodeAgentDeviceRpcRequest } from "./AgentDeviceRpc.ts";
import * as AgentDeviceProxyRegistry from "./AgentDeviceProxyRegistry.ts";
import * as DeviceAgentDiagnostics from "./DeviceAgentDiagnostics.ts";
import type { AgentDeviceSession } from "./AgentDeviceSession.ts";
import * as DeviceService from "./DeviceService.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

const TOKEN = "proxy-secret";
const proxyTokenFor = (sessionId: string) => `${TOKEN}-${sessionId}`;

const session = (id: string, host = "local", thread = `thread-${id}`): AgentDeviceSession => ({
  sessionId: id,
  ownerKind: "agent",
  providerSessionId: ProviderSessionId.make(`provider-${id}`),
  threadId: ThreadId.make(thread),
  hostId: DeviceHostId.make(host),
  deviceId: DeviceId.make(`device-${id}`),
});

const stateWith = (sessions: ReadonlyArray<unknown>) =>
  ({ sessions }) as unknown as DeviceServiceState;

const rpc = (sessionId: string, command = "press") =>
  JSON.stringify({
    jsonrpc: "2.0",
    id: "request-1",
    method: "agent_device.command",
    params: { session: sessionId, command, positionals: ["200", "300"] },
  });

const headers = (token = proxyTokenFor("session-1")) => ({
  authorization: `Bearer ${token}`,
  "x-agent-device-token": token,
  "content-type": "application/json",
});

const typedFailure = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id: "request-1",
    error: {
      code: -32001,
      message: "Runner did not accept connection",
      data: {
        code: "COMMAND_FAILED",
        message:
          "Runner did not accept connection: this Xcode cannot start its simulator service on this macOS",
        details: { reason: "simulator_service_hub_unavailable" },
        hint: "Select an Xcode that supports this macOS with xcode-select -s, or set DEVELOPER_DIR for the daemon process.",
        diagnosticId: "diag-1",
        logPath: "/tmp/agent-device/runner.log",
      },
    },
    ...overrides,
  });

const createFixture = (options: {
  readonly sessions: ReadonlyArray<AgentDeviceSession>;
  readonly reply: (url: string) => {
    readonly body: string;
    readonly status?: number;
    readonly contentType?: string;
  };
  readonly beforeReply?: (url: string) => void;
  readonly beforeRegistryReply?: () => void;
}) => {
  let state = stateWith(options.sessions);
  const requests: Array<{
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
  }> = [];
  const failures = new Map<string, DeviceAgentCommandFailure>();
  const endpoints = new Map(
    options.sessions.map((current, index) => [
      current.sessionId,
      {
        sessionId: current.sessionId,
        hostId: current.hostId,
        configPath: `/state/${current.sessionId}.json`,
        proxyToken: proxyTokenFor(current.sessionId),
        endpoint: {
          baseUrl: `http://daemon-${index}.test`,
          token: `daemon-secret-${index}`,
          entryPath: "/tools/agent-device.mjs",
        },
      },
    ]),
  );
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      const webRequest = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie);
      requests.push({
        url: request.url,
        headers: request.headers,
        body: yield* Effect.promise(() => webRequest.text()),
      });
      options.beforeReply?.(request.url);
      const reply = options.reply(request.url);
      return HttpClientResponse.fromWeb(
        request,
        new Response(reply.body, {
          status: reply.status ?? 200,
          headers: { "content-type": reply.contentType ?? "application/json" },
        }),
      );
    }),
  );
  const deviceService = {
    state: Effect.sync(() => state),
  } as unknown as DeviceService.DeviceService["Service"];
  const diagnostics = {
    recordFailure: (
      current: AgentDeviceSession,
      input: Omit<
        DeviceAgentCommandFailure,
        "sessionId" | "threadId" | "hostId" | "deviceId" | "occurredAt"
      >,
    ) =>
      Effect.sync(() => {
        failures.set(current.sessionId, {
          ...input,
          sessionId: current.sessionId,
          threadId: current.threadId,
          hostId: current.hostId,
          deviceId: current.deviceId,
          occurredAt: "2026-10-17T12:00:00.000Z",
        });
      }),
    clearSessionFailure: (current: AgentDeviceSession) =>
      Effect.sync(() => void failures.delete(current.sessionId)),
    snapshot: Effect.sync(() => Array.from(failures.values())),
  } as unknown as DeviceAgentDiagnostics.DeviceAgentDiagnostics["Service"];
  const registry = {
    get: (sessionId: string) =>
      Effect.sync(() => {
        options.beforeRegistryReply?.();
        return endpoints.get(sessionId) ?? null;
      }),
  } as unknown as AgentDeviceProxyRegistry.AgentDeviceProxyRegistry["Service"];
  const { handler, dispose } = HttpRouter.toWebHandler(
    AgentDeviceProxy.routeLayer.pipe(
      Layer.provideMerge(Layer.succeed(DeviceService.DeviceService, deviceService)),
      Layer.provideMerge(Layer.succeed(DeviceAgentDiagnostics.DeviceAgentDiagnostics, diagnostics)),
      Layer.provideMerge(
        Layer.succeed(AgentDeviceProxyRegistry.AgentDeviceProxyRegistry, registry),
      ),
      Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, client)),
    ),
    { disableLogger: true },
  );
  disposers.push(dispose);

  return {
    handler,
    requests,
    failures,
    setSessions: (sessions: ReadonlyArray<unknown>) => {
      state = stateWith(sessions);
    },
  };
};

const commandRequest = (
  sessionId: string,
  token = proxyTokenFor(sessionId),
  body = rpc(sessionId),
) =>
  new Request(`http://t3.test/api/agent-device/${sessionId}/rpc`, {
    method: "POST",
    headers: headers(token),
    body,
  });

const replaceSessionField = (
  session: AgentDeviceSession,
  field: "sessionId" | "ownerKind" | "providerSessionId" | "threadId" | "hostId" | "deviceId",
): unknown => {
  switch (field) {
    case "sessionId":
      return { ...session, sessionId: "replacement-session" };
    case "ownerKind":
      return { ...session, ownerKind: "panel" };
    case "providerSessionId":
      return { ...session, providerSessionId: ProviderSessionId.make("replacement-provider") };
    case "threadId":
      return { ...session, threadId: ThreadId.make("replacement-thread") };
    case "hostId":
      return { ...session, hostId: DeviceHostId.make("replacement-host") };
    case "deviceId":
      return { ...session, deviceId: DeviceId.make("replacement-device") };
  }
};

describe("agent-device proxy", () => {
  it("forwards the daemon response unchanged and publishes the typed Xcode failure", async () => {
    const body = typedFailure();
    const requestBody = JSON.stringify({
      ...JSON.parse(rpc("session-1")),
      futureExtension: { version: "agent-device/v2" },
    });
    const fixture = createFixture({ sessions: [session("session-1")], reply: () => ({ body }) });
    expect(decodeAgentDeviceRpcRequest(JSON.parse(requestBody))).not.toBeNull();

    const response = await fixture.handler(
      commandRequest("session-1", proxyTokenFor("session-1"), requestBody),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(body);
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]?.url).toBe("http://daemon-0.test/rpc");
    expect(fixture.requests[0]?.headers.authorization).toBe("Bearer daemon-secret-0");
    expect(fixture.requests[0]?.headers["x-agent-device-token"]).toBe("daemon-secret-0");
    expect(fixture.requests[0]?.body).toBe(requestBody);
    expect(fixture.failures.get("session-1")).toMatchObject({
      command: "press",
      reason: "simulator_service_hub_unavailable",
      message:
        "Runner did not accept connection: this Xcode cannot start its simulator service on this macOS",
      hint: "Select an Xcode that supports this macOS with xcode-select -s, or set DEVELOPER_DIR for the daemon process.",
      diagnosticId: "diag-1",
      logPath: "/tmp/agent-device/runner.log",
    });
    expect(JSON.stringify(fixture.failures.get("session-1"))).not.toContain(TOKEN);
    expect(JSON.stringify(fixture.failures.get("session-1"))).not.toContain("daemon-secret-0");
  });

  it("keeps unknown typed failures readable without applying the Xcode hint", async () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: "request-1",
      error: {
        code: -32001,
        message: "New runner failure",
        data: {
          message: "The runner returned a new failure.",
          details: { reason: "runner_failure_added_later" },
          diagnosticId: "diag-new",
        },
      },
    });
    const fixture = createFixture({ sessions: [session("session-1")], reply: () => ({ body }) });

    await (await fixture.handler(commandRequest("session-1"))).text();

    expect(fixture.failures.get("session-1")).toMatchObject({
      message: "The runner returned a new failure.",
      reason: "runner_failure_added_later",
      diagnosticId: "diag-new",
    });
    expect(fixture.failures.get("session-1")?.hint).toBeUndefined();
  });

  it("recognizes a typed failure in the final NDJSON response envelope", async () => {
    const response = JSON.parse(typedFailure());
    const body = [
      JSON.stringify({ type: "progress", event: { stage: "runner" } }),
      JSON.stringify({ type: "response", response }),
      "",
    ].join("\n");
    const fixture = createFixture({
      sessions: [session("session-1")],
      reply: () => ({ body, contentType: "application/x-ndjson" }),
    });

    await (await fixture.handler(commandRequest("session-1"))).text();

    expect(fixture.failures.get("session-1")).toMatchObject({
      reason: "simulator_service_hub_unavailable",
      hint: expect.stringContaining("xcode-select -s"),
      diagnosticId: "diag-1",
    });
  });

  it("redacts both session and daemon tokens from panel diagnostics", async () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: "request-1",
      error: {
        code: -32001,
        data: {
          message: `Failure echoed ${proxyTokenFor("session-1")} and daemon-secret-0`,
        },
      },
    });
    const fixture = createFixture({ sessions: [session("session-1")], reply: () => ({ body }) });

    await (await fixture.handler(commandRequest("session-1"))).text();

    expect(fixture.failures.get("session-1")?.message).toBe(
      "Failure echoed [redacted] and [redacted]",
    );
    expect(JSON.stringify(fixture.failures.get("session-1"))).not.toContain(
      proxyTokenFor("session-1"),
    );
    expect(JSON.stringify(fixture.failures.get("session-1"))).not.toContain("daemon-secret-0");
  });

  it("keeps concurrent agent sessions isolated", async () => {
    const sessions = [session("session-1"), session("session-2", "ssh-mac")];
    const fixture = createFixture({
      sessions,
      reply: (url) => ({
        body: url.includes("daemon-0")
          ? typedFailure()
          : typedFailure({
              error: {
                code: -32001,
                message: "Second failure",
                data: {
                  message: "Second session failed.",
                  diagnosticId: "diag-2",
                },
              },
            }),
      }),
    });

    await Promise.all([
      fixture.handler(commandRequest("session-1")).then((response) => response.text()),
      fixture.handler(commandRequest("session-2")).then((response) => response.text()),
    ]);

    expect(fixture.failures.size).toBe(2);
    expect(fixture.failures.get("session-1")?.diagnosticId).toBe("diag-1");
    expect(fixture.failures.get("session-2")?.diagnosticId).toBe("diag-2");
  });

  it("preserves direct artifact uploads and downloads", async () => {
    const fixture = createFixture({
      sessions: [session("session-1")],
      reply: (url) =>
        url.includes("upload/direct")
          ? { body: "upload accepted", status: 201 }
          : { body: "artifact bytes", status: 206 },
    });
    const upload = await fixture.handler(
      new Request("http://t3.test/api/agent-device/session-1/upload/direct/upload-1", {
        method: "PUT",
        headers: headers(),
        body: "artifact payload",
      }),
    );
    const download = await fixture.handler(
      new Request("http://t3.test/api/agent-device/session-1/artifacts/artifact-1?download=1", {
        headers: headers(),
      }),
    );

    expect(upload.status).toBe(201);
    expect(await upload.text()).toBe("upload accepted");
    expect(download.status).toBe(206);
    expect(await download.text()).toBe("artifact bytes");
    expect(fixture.requests.map((request) => [request.url, request.body])).toEqual([
      ["http://daemon-0.test/upload/direct/upload-1", "artifact payload"],
      ["http://daemon-0.test/artifacts/artifact-1?download=1", ""],
    ]);
  });

  it("rejects a bad token and a mismatched RPC session before forwarding", async () => {
    const fixture = createFixture({
      sessions: [session("session-1"), session("session-2", "ssh-mac")],
      reply: () => ({ body: "{}" }),
    });
    const unauthorized = await fixture.handler(commandRequest("session-1", "wrong-token"));
    const crossSession = await fixture.handler(
      commandRequest("session-2", proxyTokenFor("session-1")),
    );
    const mismatched = await fixture.handler(
      new Request("http://t3.test/api/agent-device/session-1/rpc", {
        method: "POST",
        headers: headers(),
        body: rpc("session-2"),
      }),
    );

    expect(unauthorized.status).toBe(401);
    expect(crossSession.status).toBe(401);
    expect(mismatched.status).toBe(409);
    expect(fixture.requests).toHaveLength(0);
    expect(fixture.failures.size).toBe(0);
  });

  it.each([
    "sessionId",
    "ownerKind",
    "providerSessionId",
    "threadId",
    "hostId",
    "deviceId",
  ] as const)(
    "does not publish a failure when the session's %s changes after response",
    async (change) => {
      const current = session("session-1");
      let setSessions: (sessions: ReadonlyArray<unknown>) => void = () => {};
      const fixture = createFixture({
        sessions: [current],
        reply: () => ({ body: typedFailure() }),
        beforeReply: () => setSessions([replaceSessionField(current, change)]),
      });
      setSessions = fixture.setSessions;

      await (await fixture.handler(commandRequest("session-1"))).text();

      expect(fixture.failures.size).toBe(0);
    },
  );

  it("does not bind the agent session identity to the lease generation", async () => {
    const current = session("session-1");
    let setSessions: (sessions: ReadonlyArray<unknown>) => void = () => {};
    const fixture = createFixture({
      sessions: [current],
      reply: () => ({ body: typedFailure() }),
      beforeReply: () => setSessions([{ ...current, leaseId: "new-lease" }]),
    });
    setSessions = fixture.setSessions;

    await (await fixture.handler(commandRequest("session-1"))).text();

    expect(fixture.failures.get("session-1")?.reason).toBe("simulator_service_hub_unavailable");
  });

  it("rejects a stale session tuple before forwarding", async () => {
    const current = session("session-1");
    let setSessions: (sessions: ReadonlyArray<unknown>) => void = () => {};
    const fixture = createFixture({
      sessions: [current],
      reply: () => ({ body: typedFailure() }),
      beforeRegistryReply: () =>
        setSessions([{ ...current, providerSessionId: ProviderSessionId.make("replacement") }]),
    });
    setSessions = fixture.setSessions;

    const response = await fixture.handler(commandRequest("session-1"));

    expect(response.status).toBe(409);
    expect(fixture.requests).toHaveLength(0);
    expect(fixture.failures.size).toBe(0);
  });

  it("clears the displayed failure after a successful command", async () => {
    let next = 0;
    const fixture = createFixture({
      sessions: [session("session-1")],
      reply: () => ({
        body:
          next++ === 0 ? typedFailure() : '{"jsonrpc":"2.0","id":"request-1","result":{"ok":true}}',
      }),
    });

    await (await fixture.handler(commandRequest("session-1"))).text();
    expect(fixture.failures.has("session-1")).toBe(true);
    const success = await fixture.handler(commandRequest("session-1"));
    expect(success.status).toBe(200);
    await success.text();

    expect(fixture.failures.has("session-1")).toBe(false);
  });

  it.effect("publishes the typed daemon failure on the live panel diagnostics stream", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const liveSession = session("session-1");
        const deviceLayer = Layer.effect(
          DeviceService.DeviceService,
          Effect.gen(function* () {
            const state = yield* SynchronizedRef.make(stateWith([liveSession]));
            const changes = yield* PubSub.unbounded<DeviceServiceState>();
            return DeviceService.DeviceService.of({
              state: SynchronizedRef.get(state),
              subscribe: PubSub.subscribe(changes),
            } as DeviceService.DeviceService["Service"]);
          }),
        );
        const services = yield* Layer.build(
          DeviceAgentDiagnostics.layer.pipe(Layer.provideMerge(deviceLayer)),
        );
        const diagnostics = Context.get(services, DeviceAgentDiagnostics.DeviceAgentDiagnostics);
        const subscription = yield* diagnostics.subscribe;
        const deviceService = Context.get(services, DeviceService.DeviceService);
        const endpoint = {
          sessionId: liveSession.sessionId,
          hostId: liveSession.hostId,
          configPath: "/state/session-1.json",
          proxyToken: proxyTokenFor(liveSession.sessionId),
          endpoint: {
            baseUrl: "http://daemon.test",
            token: "daemon-secret",
            entryPath: "/tools/agent-device.mjs",
          },
        };
        const client = HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(typedFailure(), {
                headers: { "content-type": "application/json" },
              }),
            ),
          ),
        );
        const registry = Layer.succeed(AgentDeviceProxyRegistry.AgentDeviceProxyRegistry, {
          get: (sessionId: string) =>
            Effect.succeed(sessionId === endpoint.sessionId ? endpoint : null),
        } as AgentDeviceProxyRegistry.AgentDeviceProxyRegistry["Service"]);
        const { handler, dispose } = HttpRouter.toWebHandler(
          AgentDeviceProxy.routeLayer.pipe(
            Layer.provideMerge(Layer.succeed(DeviceService.DeviceService, deviceService)),
            Layer.provideMerge(
              Layer.succeed(DeviceAgentDiagnostics.DeviceAgentDiagnostics, diagnostics),
            ),
            Layer.provideMerge(registry),
            Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, client)),
          ),
          { disableLogger: true },
        );
        disposers.push(dispose);

        const response = yield* Effect.promise(() =>
          handler(commandRequest(liveSession.sessionId)),
        );
        expect(response.status).toBe(200);
        yield* Effect.promise(() => response.text());

        const panelPayload = Option.getOrNull(
          yield* Stream.runHead(Stream.fromSubscription(subscription)),
        ) as ReadonlyArray<DeviceAgentCommandFailure> | null;
        expect(panelPayload).toEqual([
          expect.objectContaining({
            sessionId: liveSession.sessionId,
            threadId: liveSession.threadId,
            hostId: liveSession.hostId,
            deviceId: liveSession.deviceId,
            command: "press",
            reason: "simulator_service_hub_unavailable",
            message:
              "Runner did not accept connection: this Xcode cannot start its simulator service on this macOS",
            hint: "Select an Xcode that supports this macOS with xcode-select -s, or set DEVELOPER_DIR for the daemon process.",
            diagnosticId: "diag-1",
            logPath: "/tmp/agent-device/runner.log",
          }),
        ]);
      }),
    ),
  );
});

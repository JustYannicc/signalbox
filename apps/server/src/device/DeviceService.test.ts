import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  DeviceId,
  DeviceOperationError,
  LOCAL_DEVICE_HOST_ID,
  ProviderSessionId,
  ThreadId,
  type DeviceServiceState,
  type ServerSettings as Settings,
  type SshDeviceHostConfig,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as DeviceHost from "./DeviceHost.ts";
import { NodeRuntimeUnavailableError } from "@t3tools/shared/nodeRuntime";

import * as DeviceService from "./DeviceService.ts";
import * as DeviceAgentLiveness from "./DeviceAgentLiveness.ts";
import * as AgentDeviceProxyRegistry from "./AgentDeviceProxyRegistry.ts";
import {
  deviceLeaseDirectory,
  makeFileDeviceLeaseStore,
  makeMemoryDeviceLeaseStore,
  type DeviceLeaseStore,
} from "./DeviceLeaseStore.ts";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const baseState: DeviceServiceState = {
  hosts: [],
  hostStatus: "idle",
  hostStatuses: {},
  devices: [],
  sessions: [],
  onboardingCompleted: false,
  agentAccessEnabled: false,
  hubBasePath: "/api/device-hub",
  revision: 0,
};

describe("DeviceService.stateStream", () => {
  it.effect("emits the current snapshot and then every published change", () =>
    Effect.gen(function* () {
      const pubsub = yield* PubSub.unbounded<DeviceServiceState>();
      const current = yield* Ref.make(baseState);
      const service: Pick<DeviceService.DeviceService["Service"], "state" | "subscribe"> = {
        state: Ref.get(current),
        subscribe: PubSub.subscribe(pubsub),
      };

      const collected = yield* DeviceService.stateStream(
        service as DeviceService.DeviceService["Service"],
      ).pipe(Stream.take(3), Stream.runCollect, Effect.forkChild);
      yield* Effect.yieldNow;
      for (const revision of [1, 2]) {
        const next = { ...baseState, revision, hostStatus: "ready" as const };
        yield* Ref.set(current, next);
        yield* PubSub.publish(pubsub, next);
      }
      const seen = yield* Fiber.join(collected);
      expect(seen.map((state) => state.revision)).toEqual([0, 1, 2]);
    }),
  );
});

const makeFixture = Effect.fn("fixture")(function* (
  onBoot: Effect.Effect<void> = Effect.void,
  bootError?: string,
  failListAfterShutdown = false,
  runtimeFailure?:
    | NodeRuntimeUnavailableError
    | DeviceHost.DeviceHostError
    | DeviceHost.AgentDeviceStartError,
  inspectError = false,
  installTool?: Parameters<typeof DeviceService.makeWithHosts>[3],
  leaseRuntime: DeviceService.DeviceLeaseRuntime = {},
  initiallyBooted = false,
  productionConfigBaseDir?: string,
  hostHomeDirectory?: string,
  onShutdown: Effect.Effect<void> = Effect.void,
  onDeviceHostReady: Effect.Effect<void> = Effect.void,
) {
  const agentDeviceProxyRegistry = yield* AgentDeviceProxyRegistry.AgentDeviceProxyRegistry;
  const settings = yield* Ref.make(DEFAULT_SERVER_SETTINGS);
  const starts: string[] = [];
  const agentStarts: string[] = [];
  const agentStops: string[] = [];
  const requests: string[] = [];
  let booted = initiallyBooted;
  let shutDown = false;
  const ready: DeviceHost.DeviceHostReady = {
    nodePath: process.execPath,
    hub: { origin: "http://device.test" },
    helpers: { serveSimAxSettings: null, serveSimCli: null },
    run: () => Effect.succeed({ code: 0, stdout: "Pixel_API_35\n", stderr: "" }),
  };
  const host: DeviceHost.DeviceHost["Service"] = {
    ...(inspectError
      ? {
          inspect: Effect.fail(
            new DeviceHost.DeviceHostError({
              hostId: LOCAL_DEVICE_HOST_ID,
              step: "probe",
              cause: new Error("offline"),
            }),
          ),
        }
      : {}),
    id: LOCAL_DEVICE_HOST_ID,
    summary: Effect.succeed({
      id: LOCAL_DEVICE_HOST_ID,
      kind: "local",
      label: "Test server",
      platforms: [{ platform: "android", available: true }],
      hubInstalled: true,
      agentDeviceInstalled: false,
    }),
    platformAvailability: (platform) => Effect.succeed({ platform, available: true }),
    ensureReady: (onPhase) =>
      Effect.gen(function* () {
        if (runtimeFailure && runtimeFailure._tag !== "AgentDeviceStartError")
          return yield* runtimeFailure;
        yield* onDeviceHostReady;
        starts.push("start");
        yield* onPhase("installing", "Updating device hub from 0.9.0 to 0.10.1…");
        return ready;
      }),
    ensureAgentReady: (onPhase) =>
      Effect.gen(function* () {
        if (runtimeFailure) return yield* runtimeFailure;
        agentStarts.push("start");
        yield* onPhase("starting");
        return {
          ...ready,
          agentDevice: { baseUrl: "http://agent.test", token: "test", entryPath: "/agent" },
        };
      }),
    current: Effect.succeed(null),
    stopAgent: Effect.sync(() => {
      agentStops.push("stop");
    }),
    stop: Effect.sync(() => {
      starts.push("stop");
    }),
  };
  const settingsService = ServerSettings.ServerSettingsService.of({
    updateProviderInstance: () => Effect.die("Unexpected provider mutation"),
    withSettingsSnapshot: (use) => Effect.flatMap(Ref.get(settings), use),
    start: Effect.void,
    ready: Effect.void,
    getSettings: Ref.get(settings),
    updateSettings: (patch) =>
      Ref.updateAndGet(settings, (current) => ({
        ...current,
        enableDeviceSupport: patch.enableDeviceSupport ?? current.enableDeviceSupport,
        enableAgentDeviceAccess: patch.enableAgentDeviceAccess ?? current.enableAgentDeviceAccess,
        deviceOnboardingCompleted:
          patch.deviceOnboardingCompleted ?? current.deviceOnboardingCompleted,
      })),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.succeed(Stream.empty),
  });
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      requests.push(request.url);
      if (request.url.includes("/api/screenshot")) {
        return HttpClientResponse.fromWeb(request, new Response(new Uint8Array([137, 80, 78, 71])));
      }
      if (request.url.endsWith("/shutdown")) {
        yield* onShutdown;
        shutDown = true;
        booted = false;
        return HttpClientResponse.fromWeb(request, Response.json({ ok: true }));
      }
      if (shutDown && failListAfterShutdown) {
        return HttpClientResponse.fromWeb(request, new Response("Discovery busy", { status: 503 }));
      }
      if (request.url.endsWith("/boot")) {
        yield* onBoot;
        booted = true;
        return HttpClientResponse.fromWeb(
          request,
          Response.json(
            bootError ? { ok: false, error: bootError } : { ok: true, serial: "emulator-5554" },
          ),
        );
      }
      return HttpClientResponse.fromWeb(
        request,
        Response.json({
          simulators: [],
          emulators: booted
            ? [
                {
                  id: "emulator-5554",
                  name: "Pixel_API_35",
                  platform: "android",
                  version: "Android 15",
                  booted: true,
                  physical: false,
                },
              ]
            : [],
        }),
      );
    }),
  );
  let service: DeviceService.DeviceService["Service"];
  if (productionConfigBaseDir === undefined) {
    service = yield* DeviceService.makeWithHosts(
      new Map([[host.id, host]]),
      undefined,
      undefined,
      installTool,
      leaseRuntime,
    ).pipe(
      Effect.provide(NodeCrypto.layer),
      Effect.provideService(DeviceHost.DeviceHost, host),
      Effect.provideService(ServerSettings.ServerSettingsService, settingsService),
      Effect.provideService(HttpClient.HttpClient, http),
    );
  } else {
    const runtimeLayer = Layer.mergeAll(
      NodeCrypto.layer,
      Layer.succeed(DeviceHost.DeviceHost, host),
      Layer.succeed(ServerSettings.ServerSettingsService, settingsService),
      Layer.succeed(ProcessRunner.ProcessRunner, {
        run: () => Effect.die("Unexpected process"),
      }),
      Layer.succeed(HttpClient.HttpClient, http),
      ServerConfig.layerTest(process.cwd(), productionConfigBaseDir),
      NetService.layer,
      Layer.succeed(HostProcess.HomeDirectory, hostHomeDirectory ?? process.cwd()),
      Layer.succeed(
        DeviceAgentLiveness.DeviceAgentLiveness,
        DeviceAgentLiveness.DeviceAgentLiveness.of({
          bind: () => Effect.void,
          isLive: (providerSessionId: ProviderSessionId) =>
            leaseRuntime.isProviderSessionLive?.(providerSessionId) ?? Effect.succeed(true),
        }),
      ),
    ).pipe(Layer.provideMerge(NodeServices.layer));
    service = yield* DeviceService.make({
      automaticCleanup: leaseRuntime.automaticCleanup ?? false,
      ...(leaseRuntime.waitForLeaseRetry === undefined
        ? {}
        : { waitForLeaseRetry: leaseRuntime.waitForLeaseRetry }),
    }).pipe(
      Effect.provide(runtimeLayer),
      Effect.provideService(
        AgentDeviceProxyRegistry.AgentDeviceProxyRegistry,
        agentDeviceProxyRegistry,
      ),
    );
  }
  return { service, starts, agentStarts, agentStops, requests, settings, agentDeviceProxyRegistry };
});

const fixture = (...args: Parameters<typeof makeFixture>) =>
  makeFixture(...args).pipe(Effect.provide(AgentDeviceProxyRegistry.layer));

describe("agent device targets", () => {
  it.effect("binds CLI configs to the current agent lease and isolates later providers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agent-target-service-" });
        const { service, agentDeviceProxyRegistry: registry } = yield* fixture(
          Effect.void,
          undefined,
          false,
          undefined,
          false,
          undefined,
          { automaticCleanup: false },
          true,
          baseDir,
          baseDir,
        );
        yield* service.configure({ enabled: true, agentAccessEnabled: true });
        yield* service.list;

        const threadId = ThreadId.make("agent-target-service-test");
        const deviceId = DeviceId.make("emulator-5554");
        const firstProvider = ProviderSessionId.make("provider-one");
        const firstOwner = { kind: "agent" as const, providerSessionId: firstProvider };
        const firstSession = yield* service.open(
          { threadId, hostId: LOCAL_DEVICE_HOST_ID, deviceId, platform: "android" },
          firstOwner,
        );
        const firstTarget = yield* service.agentTarget({
          threadId,
          hostId: firstSession.hostId,
          deviceId: firstSession.deviceId,
          sessionId: firstSession.sessionId,
          leaseId: firstSession.leaseId,
          providerSessionId: firstProvider,
        });
        const firstRegistration = yield* registry.get(firstSession.sessionId);
        expect((yield* service.state).sessions).toContainEqual(firstSession);
        expect(firstRegistration).toMatchObject({
          session: {
            sessionId: firstSession.sessionId,
            leaseId: firstSession.leaseId,
            ownerKind: "agent",
            providerSessionId: firstProvider,
            threadId,
            hostId: LOCAL_DEVICE_HOST_ID,
            deviceId,
            platform: "android",
          },
          endpoint: {
            baseUrl: "http://agent.test",
            token: "test",
          },
        });
        expect(firstRegistration).not.toBeNull();
        expect(firstTarget).toEqual({
          args: ["--config", firstRegistration!.configPath, "--session", firstSession.sessionId],
          sessionId: firstSession.sessionId,
        });
        const firstConfigText = yield* fs.readFileString(firstRegistration!.configPath);
        const firstConfig = JSON.parse(firstConfigText) as {
          readonly daemonBaseUrl: string;
          readonly daemonAuthToken: string;
        };
        expect(firstConfig.daemonBaseUrl).toMatch(
          new RegExp(
            `^http://127\\.0\\.0\\.1:\\d+/api/agent-device/${encodeURIComponent(firstSession.sessionId)}/$`,
          ),
        );
        expect(firstConfig.daemonAuthToken).toBe(firstRegistration!.proxyToken);
        expect(firstRegistration!.proxyToken).not.toBe(firstRegistration!.endpoint.token);

        yield* service.close(
          {
            threadId,
            hostId: firstSession.hostId,
            deviceId: firstSession.deviceId,
            sessionId: firstSession.sessionId,
            leaseId: firstSession.leaseId,
          },
          firstOwner,
        );
        const staleTarget = yield* Effect.exit(
          service.agentTarget({
            threadId,
            hostId: firstSession.hostId,
            deviceId: firstSession.deviceId,
            sessionId: firstSession.sessionId,
            leaseId: firstSession.leaseId,
            providerSessionId: firstProvider,
          }),
        );
        expect(Exit.isFailure(staleTarget)).toBe(true);
        expect(yield* fs.readFileString(firstRegistration!.configPath)).toBe(firstConfigText);

        const nextProvider = ProviderSessionId.make("provider-two");
        const nextOwner = { kind: "agent" as const, providerSessionId: nextProvider };
        const nextSession = yield* service.open(
          { threadId, hostId: LOCAL_DEVICE_HOST_ID, deviceId, platform: "android" },
          nextOwner,
        );
        const nextTarget = yield* service.agentTarget({
          threadId,
          hostId: nextSession.hostId,
          deviceId: nextSession.deviceId,
          sessionId: nextSession.sessionId,
          leaseId: nextSession.leaseId,
          providerSessionId: nextProvider,
        });
        const nextRegistration = yield* registry.get(nextSession.sessionId);
        expect(nextRegistration?.session).toMatchObject({
          sessionId: nextSession.sessionId,
          leaseId: nextSession.leaseId,
          ownerKind: "agent",
          providerSessionId: nextProvider,
          threadId,
          hostId: LOCAL_DEVICE_HOST_ID,
          deviceId,
        });
        expect(nextRegistration!.configPath).not.toBe(firstRegistration!.configPath);
        expect(nextRegistration!.proxyToken).not.toBe(firstRegistration!.proxyToken);
        expect(nextTarget.args).toEqual([
          "--config",
          nextRegistration!.configPath,
          "--session",
          nextSession.sessionId,
        ]);
        expect(yield* fs.readFileString(firstRegistration!.configPath)).toBe(firstConfigText);

        yield* service.close(
          {
            threadId,
            hostId: firstSession.hostId,
            deviceId: firstSession.deviceId,
            sessionId: firstSession.sessionId,
            leaseId: firstSession.leaseId,
          },
          firstOwner,
        );
        expect((yield* service.state).sessions.map((session) => session.sessionId)).toContain(
          nextSession.sessionId,
        );
        yield* service.close(
          {
            threadId,
            hostId: nextSession.hostId,
            deviceId: nextSession.deviceId,
            sessionId: nextSession.sessionId,
            leaseId: nextSession.leaseId,
          },
          nextOwner,
        );
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
});

describe("device setup consent", () => {
  it.effect("exposes daemon startup diagnostics through agent readiness and host status", () =>
    Effect.gen(function* () {
      const startupError = new DeviceHost.AgentDeviceStartError({
        hostId: LOCAL_DEVICE_HOST_ID,
        stateDir: "/test/device/agent-device",
        exitCode: 1,
        reason: "daemon_lock_not_directory",
        cause: { stdout: "private startup diagnostics", code: 1 },
      });
      const { service, settings } = yield* fixture(Effect.void, undefined, false, startupError);
      yield* Ref.update(settings, (current) => ({
        ...current,
        enableDeviceSupport: true,
        enableAgentDeviceAccess: true,
      }));
      const error = yield* service.agentReadinessIfSupported().pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "DeviceHostUnavailableError",
        reason: startupError.message,
        cause: startupError,
      });
      expect(error.message).toContain("daemon.lock is not a directory");
      expect(error.message).not.toContain("private startup diagnostics");
      expect((yield* service.state).hostStatuses[LOCAL_DEVICE_HOST_ID]).toEqual({
        status: "failed",
        detail: startupError.message,
      });
    }).pipe(Effect.scoped),
  );

  it.effect(
    "preserves missing-runtime guidance and causes through manual and agent readiness",
    () =>
      Effect.gen(function* () {
        const underlying = new Error("private lookup diagnostics");
        const runtimeFailure = new NodeRuntimeUnavailableError({
          feature: "Local device support",
          cause: underlying,
        });
        const { service, settings, requests } = yield* fixture(
          Effect.void,
          undefined,
          false,
          runtimeFailure,
        );
        yield* Ref.update(settings, (current) => ({
          ...current,
          enableDeviceSupport: true,
          enableAgentDeviceAccess: true,
        }));
        for (const readiness of [service.readiness(), service.agentReadinessIfSupported()]) {
          const error = yield* readiness.pipe(Effect.flip);
          expect(error).toMatchObject({
            _tag: "DeviceHostUnavailableError",
            reason: expect.stringContaining("Install Node.js"),
            cause: runtimeFailure,
          });
          expect(error.message).not.toContain(underlying.message);
        }
        expect((yield* service.state).hostStatuses[LOCAL_DEVICE_HOST_ID]).toMatchObject({
          status: "failed",
          detail: expect.stringContaining("Install Node.js"),
        });
        expect(requests).toEqual([]);
      }).pipe(Effect.scoped),
  );

  it.effect("listing and provider startup do not start helpers before consent", () =>
    Effect.gen(function* () {
      const { service, starts, requests } = yield* fixture();
      expect((yield* service.list).hostStatus).toBe("disabled");
      expect(yield* service.readinessIfSupported()).toBeNull();
      const readiness = yield* service.readiness().pipe(Effect.result);
      expect(readiness._tag).toBe("Failure");
      expect(starts).toEqual([]);
      expect(requests).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "explicit setup discovers never-booted AVDs; disabling stops helpers and blocks agents",
    () =>
      Effect.gen(function* () {
        const { service, starts, settings } = yield* fixture();
        const state = yield* service.configure({ enabled: true });
        expect((yield* Ref.get(settings)).enableDeviceSupport).toBe(true);
        expect(state.devices.map((device) => [device.id, device.booted])).toEqual([
          ["Pixel_API_35", false],
        ]);
        expect(starts).toEqual(["start"]);
        const disabled = yield* service.configure({ enabled: false });
        expect(disabled.hostStatus).toBe("disabled");
        expect(disabled.devices).toEqual([]);
        expect((yield* Ref.get(settings)).enableDeviceSupport).toBe(false);
        expect(yield* service.readinessIfSupported()).toBeNull();
        expect(starts).toEqual(["start", "stop"]);
      }).pipe(Effect.scoped),
  );

  it.effect("boots a stopped Android AVD and uses its emulator serial without duplicating it", () =>
    Effect.gen(function* () {
      const { service, requests } = yield* fixture();
      yield* service.configure({ enabled: true });
      const session = yield* service.open({
        threadId: ThreadId.make("thread-1"),
        deviceId: "Pixel_API_35",
        platform: "android",
      });
      expect(session.deviceId).toBe("emulator-5554");
      expect(requests.filter((url) => url.endsWith("/boot"))).toHaveLength(1);
      const state = yield* service.state;
      expect(state.devices.map((device) => device.id)).toEqual(["emulator-5554"]);
      expect(state.bootingDevices).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("installs agent support only after the separate agent permission", () =>
    Effect.gen(function* () {
      const { service, agentStarts, agentStops, settings } = yield* fixture();
      yield* service.configure({ enabled: true });
      expect(agentStarts).toEqual([]);
      expect(yield* service.agentReadinessIfSupported()).toBeNull();

      yield* service.configure({ agentAccessEnabled: true });
      expect(agentStarts).toEqual(["start"]);
      expect((yield* Ref.get(settings)).enableAgentDeviceAccess).toBe(true);
      expect((yield* service.state).agentAccessEnabled).toBe(true);

      yield* service.configure({ agentAccessEnabled: false, onboardingCompleted: true });
      expect(agentStops).toEqual(["stop"]);
      expect((yield* service.state).onboardingCompleted).toBe(true);
      expect((yield* Ref.get(settings)).deviceOnboardingCompleted).toBe(true);
    }).pipe(Effect.scoped),
  );
});

it.effect("cancels a queued open without leaving a panel status behind", () =>
  Effect.gen(function* () {
    const { service } = yield* fixture();
    yield* service.configure({ enabled: true });
    const threadId = ThreadId.make("queued-open-cancel");
    const firstOwner = {
      kind: "agent" as const,
      providerSessionId: ProviderSessionId.make("provider-first-walk"),
    };
    const secondOwner = {
      kind: "agent" as const,
      providerSessionId: ProviderSessionId.make("provider-second-walk"),
    };
    const first = yield* service.open(
      {
        threadId,
        hostId: LOCAL_DEVICE_HOST_ID,
        deviceId: DeviceId.make("Pixel_API_35"),
        platform: "android",
      },
      firstOwner,
    );
    const queuedState = yield* DeviceService.stateStream(service).pipe(
      Stream.filter(
        (state) => state.queuedDevices?.some((entry) => entry.threadId === threadId) === true,
      ),
      Stream.runHead,
      Effect.forkChild,
    );
    const waitingOpen = yield* Effect.forkChild(
      service.open(
        {
          threadId,
          hostId: LOCAL_DEVICE_HOST_ID,
          deviceId: first.deviceId,
          platform: "android",
        },
        secondOwner,
      ),
    );
    const status = yield* Fiber.join(queuedState);
    expect(status._tag).toBe("Some");

    yield* Fiber.interrupt(waitingOpen);
    const interrupted = yield* Fiber.await(waitingOpen);
    expect(Exit.isFailure(interrupted)).toBe(true);
    expect((yield* service.state).queuedDevices ?? []).toEqual([]);

    yield* service.close(
      {
        threadId,
        hostId: LOCAL_DEVICE_HOST_ID,
        deviceId: first.deviceId,
        sessionId: first.sessionId,
        leaseId: first.leaseId,
      },
      firstOwner,
    );
  }).pipe(Effect.scoped),
);

it.effect("cancels only the committed open request while its client response is unavailable", () =>
  Effect.gen(function* () {
    const committed = yield* Deferred.make<void>();
    const sendResponse = yield* Deferred.make<void>();
    const { service } = yield* fixture();
    yield* service.configure({ enabled: true });
    const threadId = ThreadId.make("device-open-response-unavailable");
    const hostId = LOCAL_DEVICE_HOST_ID;
    const deviceId = DeviceId.make("Pixel_API_35");
    const firstRequestId = "open-request-first";
    const opening = yield* Effect.forkChild(
      service
        .open({
          threadId,
          hostId,
          deviceId,
          platform: "android",
          requestId: firstRequestId,
        })
        .pipe(
          Effect.tap(() => Deferred.succeed(committed, undefined)),
          Effect.tap(() => Deferred.await(sendResponse)),
        ),
    );
    yield* Deferred.await(committed);
    const first = (yield* service.state).sessions.find(
      (session) => session.requestId === firstRequestId,
    );
    expect(first).toBeDefined();

    const second = yield* service.open({
      threadId,
      hostId,
      deviceId: first!.deviceId,
      platform: "android",
      requestId: "open-request-second",
    });
    const agent = yield* service.open(
      {
        threadId,
        hostId,
        deviceId: first!.deviceId,
        platform: "android",
      },
      { kind: "agent", providerSessionId: ProviderSessionId.make("device-open-agent") },
    );

    yield* service.cancelOpen({ threadId, hostId, deviceId, requestId: firstRequestId });
    const surviving = (yield* service.state).sessions;
    expect(surviving.some((session) => session.requestId === firstRequestId)).toBe(false);
    expect(surviving.some((session) => session.sessionId === second.sessionId)).toBe(true);
    expect(surviving.some((session) => session.sessionId === agent.sessionId)).toBe(true);

    yield* Deferred.succeed(sendResponse, undefined);
    const lateResponse = yield* Fiber.join(opening);
    expect(lateResponse.requestId).toBe(firstRequestId);
    yield* service.close({
      threadId,
      hostId,
      deviceId: lateResponse.deviceId,
      sessionId: lateResponse.sessionId,
      leaseId: lateResponse.leaseId,
    });
    expect((yield* service.state).sessions.map((session) => session.sessionId).toSorted()).toEqual(
      [second.sessionId, agent.sessionId].toSorted(),
    );
  }).pipe(Effect.scoped),
);

it.effect("fences a late device open after cancellation arrived before dispatch", () =>
  Effect.gen(function* () {
    const { service, starts, requests } = yield* fixture();
    const input = {
      threadId: ThreadId.make("device-open-cancel-before-dispatch"),
      hostId: LOCAL_DEVICE_HOST_ID,
      deviceId: DeviceId.make("Pixel_API_35"),
      platform: "android" as const,
      requestId: "open-request-cancel-before-dispatch",
    };
    yield* service.cancelOpen({ ...input, requestId: input.requestId });
    const result = yield* Effect.exit(service.open(input));
    const retry = yield* Effect.exit(service.open(input));

    expect(Exit.isFailure(result)).toBe(true);
    expect(Exit.isFailure(retry)).toBe(true);
    expect(starts).toEqual([]);
    expect(requests).toEqual([]);
    expect((yield* service.state).sessions).toEqual([]);
  }).pipe(Effect.scoped),
);

it.effect("keeps cancellation while host readiness is delayed", () =>
  Effect.gen(function* () {
    const deviceListStarted = yield* Deferred.make<void>();
    const finishDeviceList = yield* Deferred.make<void>();
    let delayHostReady = false;
    const onDeviceHostReady = Effect.gen(function* () {
      if (!delayHostReady) return;
      delayHostReady = false;
      yield* Deferred.succeed(deviceListStarted, undefined);
      yield* Deferred.await(finishDeviceList);
    });
    const { service, requests } = yield* fixture(
      Effect.void,
      undefined,
      false,
      undefined,
      false,
      undefined,
      {},
      true,
      undefined,
      undefined,
      undefined,
      onDeviceHostReady,
    );
    yield* service.configure({ enabled: true });
    const requestsBeforeOpen = requests.length;
    delayHostReady = true;
    const input = {
      threadId: ThreadId.make("device-open-cancel-during-discovery"),
      hostId: LOCAL_DEVICE_HOST_ID,
      deviceId: DeviceId.make("Pixel_API_35"),
      platform: "android" as const,
      requestId: "open-request-cancel-during-discovery",
    };
    const opening = yield* Effect.forkChild(service.open(input));
    yield* Deferred.await(deviceListStarted);

    yield* service.cancelOpen({ ...input, requestId: input.requestId });
    const cancelledAt = yield* Clock.currentTimeMillis;
    yield* TestClock.adjust("11 minutes");
    expect(yield* Clock.currentTimeMillis).toBeGreaterThanOrEqual(cancelledAt + 11 * 60_000);
    yield* Deferred.succeed(finishDeviceList, undefined);
    const result = yield* Fiber.await(opening);

    expect(Exit.isFailure(result)).toBe(true);
    expect((yield* service.state).sessions).toEqual([]);
    expect(requests).toHaveLength(requestsBeforeOpen);
    expect(requests.some((request) => request.endsWith("/boot"))).toBe(false);
  }).pipe(Effect.scoped),
);

it.effect("shuts down a provisional device when its panel request is cancelled during boot", () =>
  Effect.gen(function* () {
    const bootStarted = yield* Deferred.make<void>();
    const finishBoot = yield* Deferred.make<void>();
    const onBoot = Effect.gen(function* () {
      yield* Deferred.succeed(bootStarted, undefined);
      yield* Deferred.await(finishBoot);
    });
    const { service, requests } = yield* fixture(onBoot);
    yield* service.configure({ enabled: true });
    const input = {
      threadId: ThreadId.make("device-open-cancel-during-boot"),
      hostId: LOCAL_DEVICE_HOST_ID,
      deviceId: DeviceId.make("Pixel_API_35"),
      platform: "android" as const,
      requestId: "open-request-cancel-during-boot",
    };
    const opening = yield* Effect.forkChild(service.open(input));
    yield* Deferred.await(bootStarted);

    yield* service.cancelOpen({ ...input, requestId: input.requestId });
    yield* Deferred.succeed(finishBoot, undefined);
    const result = yield* Fiber.await(opening);

    expect(Exit.isFailure(result)).toBe(true);
    expect((yield* service.state).sessions).toEqual([]);
    expect(requests.some((url) => url.endsWith("/api/devices/shutdown"))).toBe(true);
  }).pipe(Effect.scoped),
);

it.effect("releases a provisional owner when open is interrupted just after reservation", () =>
  Effect.gen(function* () {
    const baseStore = yield* makeMemoryDeviceLeaseStore;
    const reservationPersisted = yield* Deferred.make<void>();
    const finishReservationWrite = yield* Deferred.make<void>();
    let holdReservation = true;
    const store: DeviceLeaseStore = {
      ...baseStore,
      write: (key, lease) =>
        baseStore.write(key, lease).pipe(
          Effect.tap(() =>
            holdReservation && lease?.state === "opening"
              ? Effect.gen(function* () {
                  holdReservation = false;
                  yield* Deferred.succeed(reservationPersisted, undefined);
                  yield* Deferred.await(finishReservationWrite);
                })
              : Effect.void,
          ),
        ),
    };
    const { service } = yield* fixture(Effect.void, undefined, false, undefined, false, undefined, {
      store,
      automaticCleanup: false,
    });
    yield* service.configure({ enabled: true });
    const opening = yield* Effect.forkChild(
      service.open({
        threadId: ThreadId.make("interrupted-provisional-open"),
        hostId: LOCAL_DEVICE_HOST_ID,
        deviceId: DeviceId.make("Pixel_API_35"),
        platform: "android",
      }),
    );
    yield* Deferred.await(reservationPersisted);
    expect((yield* baseStore.list).flatMap((entry) => entry.lease?.owners ?? [])).toHaveLength(1);
    const interruption = yield* Effect.forkChild(Fiber.interrupt(opening));
    yield* Effect.yieldNow;
    expect(opening.pollUnsafe()).toBeUndefined();
    yield* Deferred.succeed(finishReservationWrite, undefined);
    const exit = yield* Fiber.await(opening);
    yield* Fiber.join(interruption);
    expect(Exit.isFailure(exit)).toBe(true);
    expect((yield* baseStore.list).flatMap((entry) => entry.lease?.owners ?? [])).toEqual([]);
  }).pipe(Effect.scoped),
);

it.effect("releases a persisted shutdown claim when cancellation is interrupted", () =>
  Effect.gen(function* () {
    const baseStore = yield* makeMemoryDeviceLeaseStore;
    const shutdownClaimPersisted = yield* Deferred.make<void>();
    const finishShutdownClaimWrite = yield* Deferred.make<void>();
    let holdShutdownClaimWrite = false;
    const store: DeviceLeaseStore = {
      ...baseStore,
      write: (key, lease) =>
        baseStore.write(key, lease).pipe(
          Effect.tap(() =>
            Effect.gen(function* () {
              if (!holdShutdownClaimWrite || lease?.state !== "shutting_down") return;
              holdShutdownClaimWrite = false;
              yield* Deferred.succeed(shutdownClaimPersisted, undefined);
              yield* Deferred.await(finishShutdownClaimWrite);
            }),
          ),
        ),
    };
    const blockedOpen = yield* Deferred.make<void>();
    const waitForBlockedOpen = yield* Deferred.make<void>();
    const first = yield* fixture(Effect.void, undefined, false, undefined, false, undefined, {
      store,
      automaticCleanup: false,
    });
    const second = yield* fixture(
      Effect.void,
      undefined,
      false,
      undefined,
      false,
      undefined,
      {
        store,
        automaticCleanup: false,
        waitForLeaseRetry: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(blockedOpen, undefined);
            yield* Deferred.await(waitForBlockedOpen);
          }),
      },
      true,
    );
    yield* first.service.configure({ enabled: true });
    yield* second.service.configure({ enabled: true });

    const ownerThreadId = ThreadId.make("interrupt-shutdown-claim-owner");
    const session = yield* first.service.open({
      threadId: ownerThreadId,
      hostId: LOCAL_DEVICE_HOST_ID,
      deviceId: DeviceId.make("Pixel_API_35"),
      platform: "android",
      requestId: "interrupt-shutdown-claim-request",
    });
    const canceling = first.service.cancelOpen({
      threadId: ownerThreadId,
      hostId: LOCAL_DEVICE_HOST_ID,
      deviceId: DeviceId.make("Pixel_API_35"),
      requestId: "interrupt-shutdown-claim-request",
    });
    holdShutdownClaimWrite = true;
    const cancellation = yield* Effect.forkChild(canceling);
    yield* Deferred.await(shutdownClaimPersisted);

    const interruption = yield* Effect.forkChild(Fiber.interrupt(cancellation));
    yield* Effect.yieldNow;
    expect(cancellation.pollUnsafe()).toBeUndefined();
    yield* Deferred.succeed(finishShutdownClaimWrite, undefined);
    yield* Fiber.join(interruption);
    expect(Exit.isFailure(yield* Fiber.await(cancellation))).toBe(true);

    const contender = Effect.map(
      second.service.open({
        threadId: ThreadId.make("interrupt-shutdown-claim-contender"),
        hostId: LOCAL_DEVICE_HOST_ID,
        deviceId: session.deviceId,
        platform: "android",
      }),
      () => "opened" as const,
    );
    const outcome = yield* Effect.race(
      contender,
      Deferred.await(blockedOpen).pipe(Effect.as("blocked" as const)),
    );
    expect(outcome).toBe("opened");
  }).pipe(Effect.scoped),
);

it.effect("releases a cancelled request retry after readiness without touching other owners", () =>
  Effect.gen(function* () {
    const baseStore = yield* makeMemoryDeviceLeaseStore;
    const requestId = "device-open-retry-cancelled";
    const siblingRequestId = "device-open-retry-sibling";
    const retryReadinessStarted = yield* Deferred.make<void>();
    const finishRetryReadiness = yield* Deferred.make<void>();
    const exactReadinessStarted = yield* Deferred.make<void>();
    const finishExactReadiness = yield* Deferred.make<void>();
    const ownerReleaseStarted = yield* Deferred.make<void>();
    const finishOwnerRelease = yield* Deferred.make<void>();
    const blockedOpen = yield* Deferred.make<void>();
    const waitForBlockedOpen = yield* Deferred.make<void>();
    let pauseOwnerRelease = false;
    let nextReadinessGate:
      | {
          readonly started: typeof retryReadinessStarted;
          readonly resume: typeof finishRetryReadiness;
        }
      | {
          readonly started: typeof exactReadinessStarted;
          readonly resume: typeof finishExactReadiness;
        }
      | undefined;
    const store: DeviceLeaseStore = {
      ...baseStore,
      write: (key, lease) =>
        Effect.gen(function* () {
          if (pauseOwnerRelease) {
            const current = yield* baseStore.read(key);
            if (
              current?.owners.some((owner) => owner.requestId === requestId) &&
              !lease?.owners.some((owner) => owner.requestId === requestId)
            ) {
              pauseOwnerRelease = false;
              yield* Deferred.succeed(ownerReleaseStarted, undefined);
              yield* Deferred.await(finishOwnerRelease);
            }
          }
          yield* baseStore.write(key, lease);
        }),
    };
    const onDeviceHostReady = Effect.gen(function* () {
      const gate = nextReadinessGate;
      if (gate === undefined) return;
      nextReadinessGate = undefined;
      yield* Deferred.succeed(gate.started, undefined);
      yield* Deferred.await(gate.resume);
    });
    const threadId = ThreadId.make("device-open-retry-cancel");
    const hostId = LOCAL_DEVICE_HOST_ID;
    const input = {
      threadId,
      hostId,
      deviceId: DeviceId.make("Pixel_API_35"),
      platform: "android" as const,
      requestId,
    };
    const { service } = yield* fixture(
      Effect.void,
      undefined,
      false,
      undefined,
      false,
      undefined,
      { store, automaticCleanup: false },
      true,
      undefined,
      undefined,
      undefined,
      onDeviceHostReady,
    );
    const contender = yield* fixture(
      Effect.void,
      undefined,
      false,
      undefined,
      false,
      undefined,
      {
        store,
        automaticCleanup: false,
        waitForLeaseRetry: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(blockedOpen, undefined);
            yield* Deferred.await(waitForBlockedOpen);
          }),
      },
      true,
    );
    yield* service.configure({ enabled: true });
    yield* contender.service.configure({ enabled: true });

    const original = yield* service.open(input);
    const sibling = yield* service.open({
      ...input,
      deviceId: original.deviceId,
      requestId: siblingRequestId,
    });
    const agentOwner = {
      kind: "agent" as const,
      providerSessionId: ProviderSessionId.make("device-open-retry-agent"),
    };
    const agent = yield* service.open(
      {
        threadId,
        hostId,
        deviceId: original.deviceId,
        platform: "android",
      },
      agentOwner,
    );

    nextReadinessGate = { started: retryReadinessStarted, resume: finishRetryReadiness };
    pauseOwnerRelease = true;
    const retry = yield* Effect.forkChild(service.open(input));
    yield* Deferred.await(retryReadinessStarted);
    const cancelling = yield* Effect.forkChild(service.cancelOpen(input));
    yield* Deferred.await(ownerReleaseStarted);
    yield* Deferred.succeed(finishOwnerRelease, undefined);
    yield* Fiber.join(cancelling);
    expect((yield* service.state).sessions.map((session) => session.sessionId).toSorted()).toEqual(
      [sibling.sessionId, agent.sessionId].toSorted(),
    );
    yield* Deferred.succeed(finishRetryReadiness, undefined);
    expect(Exit.isFailure(yield* Fiber.await(retry))).toBe(true);

    const newerRequestId = "device-open-retry-newer";
    const newer = yield* service.open({
      ...input,
      deviceId: original.deviceId,
      requestId: newerRequestId,
    });
    const lease = (yield* baseStore.list).flatMap((entry) => (entry.lease ? [entry.lease] : []))[0];
    expect(lease?.owners.some((owner) => owner.requestId === requestId)).toBe(false);
    expect(lease?.owners.some((owner) => owner.requestId === siblingRequestId)).toBe(true);
    expect(lease?.owners.some((owner) => owner.requestId === newerRequestId)).toBe(true);
    expect(
      lease?.owners.some((owner) => owner.providerSessionId === agentOwner.providerSessionId),
    ).toBe(true);
    expect(lease?.waiters?.some((waiter) => waiter.waiterId === requestId) ?? false).toBe(false);

    nextReadinessGate = { started: exactReadinessStarted, resume: finishExactReadiness };
    const exactRenewal = yield* Effect.forkChild(
      service.open({
        ...input,
        deviceId: sibling.deviceId,
        sessionId: sibling.sessionId,
        leaseId: sibling.leaseId,
        requestId: siblingRequestId,
      }),
    );
    yield* Deferred.await(exactReadinessStarted);
    yield* service.cancelOpen({
      ...input,
      deviceId: sibling.deviceId,
      requestId: siblingRequestId,
    });
    yield* Deferred.succeed(finishExactReadiness, undefined);
    expect(Exit.isFailure(yield* Fiber.await(exactRenewal))).toBe(true);
    expect((yield* service.state).sessions.map((session) => session.sessionId).toSorted()).toEqual(
      [sibling.sessionId, agent.sessionId, newer.sessionId].toSorted(),
    );

    yield* service.close({
      threadId,
      hostId,
      deviceId: sibling.deviceId,
      sessionId: sibling.sessionId,
      leaseId: sibling.leaseId,
    });
    yield* service.close(
      {
        threadId,
        hostId,
        deviceId: agent.deviceId,
        sessionId: agent.sessionId,
        leaseId: agent.leaseId,
      },
      agentOwner,
    );
    yield* service.close({
      threadId,
      hostId,
      deviceId: newer.deviceId,
      sessionId: newer.sessionId,
      leaseId: newer.leaseId,
    });
    const anotherWalk = Effect.map(
      contender.service.open({
        threadId: ThreadId.make("device-open-retry-after-cancel"),
        hostId,
        deviceId: original.deviceId,
        platform: "android",
      }),
      () => "opened" as const,
    );
    const outcome = yield* Effect.race(
      anotherWalk,
      Deferred.await(blockedOpen).pipe(Effect.as("blocked" as const)),
    );
    expect(outcome).toBe("opened");
  }).pipe(Effect.scoped),
);

it.effect("releases a renewed owner cancelled before its retried session is published", () =>
  Effect.gen(function* () {
    const baseStore = yield* makeMemoryDeviceLeaseStore;
    const requestId = "device-open-retry-before-publish";
    const renewalPersisted = yield* Deferred.make<void>();
    const finishRenewal = yield* Deferred.make<void>();
    const cancelWaiterLockRequested = yield* Deferred.make<void>();
    let pauseNextRenewal = false;
    let watchNextLock = false;
    const store: DeviceLeaseStore = {
      ...baseStore,
      withLock: (key, use) =>
        Effect.gen(function* () {
          if (watchNextLock) {
            watchNextLock = false;
            yield* Deferred.succeed(cancelWaiterLockRequested, undefined);
          }
          return yield* baseStore.withLock(key, use);
        }),
      write: (key, lease) =>
        Effect.gen(function* () {
          const before = yield* baseStore.read(key);
          const isRetryOwnerRenewal =
            before?.owners.some((owner) => owner.requestId === requestId) === true &&
            lease?.owners.some((owner) => owner.requestId === requestId) === true;
          yield* baseStore.write(key, lease);
          if (pauseNextRenewal && isRetryOwnerRenewal) {
            pauseNextRenewal = false;
            yield* Deferred.succeed(renewalPersisted, undefined);
            yield* Deferred.await(finishRenewal);
          }
        }),
    };
    const { service } = yield* fixture(Effect.void, undefined, false, undefined, false, undefined, {
      store,
      automaticCleanup: false,
    });
    yield* service.configure({ enabled: true });
    const threadId = ThreadId.make("device-open-retry-before-publish");
    const input = {
      threadId,
      hostId: LOCAL_DEVICE_HOST_ID,
      deviceId: DeviceId.make("Pixel_API_35"),
      platform: "android" as const,
      requestId,
    };
    const original = yield* service.open(input);
    const siblingRequestId = "device-open-retry-before-publish-sibling";
    const sibling = yield* service.open({
      ...input,
      deviceId: original.deviceId,
      requestId: siblingRequestId,
    });
    const agentOwner = {
      kind: "agent" as const,
      providerSessionId: ProviderSessionId.make("device-open-before-publish-agent"),
    };
    const agent = yield* service.open(
      { threadId, hostId: LOCAL_DEVICE_HOST_ID, deviceId: original.deviceId, platform: "android" },
      agentOwner,
    );

    pauseNextRenewal = true;
    const retry = yield* Effect.forkChild(service.open(input));
    yield* Deferred.await(renewalPersisted);
    watchNextLock = true;
    const cancelling = yield* Effect.forkChild(service.cancelOpen(input));
    yield* Deferred.await(cancelWaiterLockRequested);
    yield* Deferred.succeed(finishRenewal, undefined);
    expect(Exit.isFailure(yield* Fiber.await(retry))).toBe(true);
    yield* Fiber.join(cancelling);

    const lease = (yield* baseStore.list).flatMap((entry) => (entry.lease ? [entry.lease] : []))[0];
    expect(lease?.owners.some((owner) => owner.requestId === requestId)).toBe(false);
    expect(lease?.owners.some((owner) => owner.requestId === siblingRequestId)).toBe(true);
    expect(
      lease?.owners.some((owner) => owner.providerSessionId === agentOwner.providerSessionId),
    ).toBe(true);
    expect(lease?.waiters?.some((waiter) => waiter.waiterId === requestId) ?? false).toBe(false);
    expect((yield* service.state).sessions.map((session) => session.sessionId).toSorted()).toEqual(
      [sibling.sessionId, agent.sessionId].toSorted(),
    );
  }).pipe(Effect.scoped),
);

it.effect("keeps one device lease across production services and worktree state dirs", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const homeDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "device-host-home-" });
    const path = yield* Path.Path;
    const firstBaseDir = path.join(homeDirectory, "worktree-one", ".t3");
    const secondBaseDir = path.join(homeDirectory, "worktree-two", ".t3");
    const firstStateDir = path.join(firstBaseDir, "userdata");
    const secondStateDir = path.join(secondBaseDir, "userdata");
    const sharedLeaseDirectory = deviceLeaseDirectory(homeDirectory);
    const retryWaiting = yield* Deferred.make<void>();
    const resumeRetry = yield* Deferred.make<void>();
    expect(firstStateDir).not.toBe(secondStateDir);
    expect(sharedLeaseDirectory).not.toBe(path.join(firstStateDir, "device-leases"));
    expect(sharedLeaseDirectory).not.toBe(path.join(secondStateDir, "device-leases"));

    const firstFixture = yield* fixture(
      Effect.void,
      undefined,
      false,
      undefined,
      false,
      undefined,
      {},
      true,
      firstBaseDir,
      homeDirectory,
    );
    const secondFixture = yield* fixture(
      Effect.void,
      undefined,
      false,
      undefined,
      false,
      undefined,
      {
        waitForLeaseRetry: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(retryWaiting, undefined);
            yield* Deferred.await(resumeRetry);
          }),
      },
      true,
      secondBaseDir,
      homeDirectory,
    );
    const observerStore = makeFileDeviceLeaseStore(sharedLeaseDirectory);
    yield* firstFixture.service.configure({ enabled: true });
    yield* secondFixture.service.configure({ enabled: true });

    const firstThreadId = ThreadId.make("first-worktree-walk");
    const secondThreadId = ThreadId.make("second-worktree-walk");
    const firstOwner = {
      kind: "agent" as const,
      providerSessionId: ProviderSessionId.make("first-production-provider"),
    };
    const secondOwner = {
      kind: "agent" as const,
      providerSessionId: ProviderSessionId.make("second-production-provider"),
    };
    const firstSession = yield* firstFixture.service.open(
      {
        threadId: firstThreadId,
        hostId: LOCAL_DEVICE_HOST_ID,
        deviceId: DeviceId.make("emulator-5554"),
        platform: "android",
      },
      firstOwner,
    );
    const queuedState = yield* DeviceService.stateStream(secondFixture.service).pipe(
      Stream.filter(
        (state) => state.queuedDevices?.some((entry) => entry.threadId === secondThreadId) === true,
      ),
      Stream.runHead,
      Effect.forkChild,
    );
    const secondOpen = yield* Effect.forkChild(
      secondFixture.service.open(
        {
          threadId: secondThreadId,
          hostId: LOCAL_DEVICE_HOST_ID,
          deviceId: DeviceId.make("Pixel_API_35"),
          platform: "android",
        },
        secondOwner,
      ),
    );
    expect((yield* Fiber.join(queuedState))._tag).toBe("Some");
    expect(secondOpen.pollUnsafe()).toBeUndefined();

    const activeLease = (yield* observerStore.list)[0]?.lease;
    expect(activeLease?.owners).toHaveLength(1);
    expect(activeLease?.owners[0]?.providerSessionId).toBe(firstOwner.providerSessionId);
    expect(activeLease?.waiters).toMatchObject([
      { providerSessionId: secondOwner.providerSessionId },
    ]);
    yield* Deferred.await(retryWaiting);
    expect(secondOpen.pollUnsafe()).toBeUndefined();

    yield* firstFixture.service.close(
      {
        threadId: firstThreadId,
        hostId: LOCAL_DEVICE_HOST_ID,
        deviceId: firstSession.deviceId,
        sessionId: firstSession.sessionId,
        leaseId: firstSession.leaseId,
      },
      firstOwner,
    );
    yield* Deferred.succeed(resumeRetry, undefined);
    const secondSession = yield* Fiber.join(secondOpen);
    expect(secondSession.providerSessionId).toBe(secondOwner.providerSessionId);
    const transferredLease = (yield* observerStore.list)[0]?.lease;
    expect(transferredLease?.owners).toHaveLength(1);
    expect(transferredLease?.owners[0]?.providerSessionId).toBe(secondOwner.providerSessionId);

    yield* secondFixture.service.close(
      {
        threadId: secondThreadId,
        hostId: LOCAL_DEVICE_HOST_ID,
        deviceId: secondSession.deviceId,
        sessionId: secondSession.sessionId,
        leaseId: secondSession.leaseId,
      },
      secondOwner,
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("automatically shuts down an idle device after its provider session ends", () =>
  Effect.gen(function* () {
    const shutdownStarted = yield* Deferred.make<void>();
    const { service, requests } = yield* fixture(
      Effect.void,
      undefined,
      false,
      undefined,
      false,
      undefined,
      { isProviderSessionLive: () => Effect.succeed(false) },
      false,
      undefined,
      undefined,
      Deferred.succeed(shutdownStarted, undefined),
    );
    yield* service.configure({ enabled: true });
    const threadId = ThreadId.make("idle-cleanup-walk");
    const session = yield* service.open(
      {
        threadId,
        hostId: LOCAL_DEVICE_HOST_ID,
        deviceId: DeviceId.make("Pixel_API_35"),
        platform: "android",
      },
      {
        kind: "agent",
        providerSessionId: ProviderSessionId.make("idle-cleanup-provider"),
      },
    );
    const releasedSession = yield* DeviceService.stateStream(service).pipe(
      Stream.filter(
        (state) => !state.sessions.some((candidate) => candidate.sessionId === session.sessionId),
      ),
      Stream.runHead,
      Effect.forkChild,
    );
    expect(requests.some((url) => url.endsWith("/api/devices/shutdown"))).toBe(false);

    yield* TestClock.adjust("35 minutes");
    yield* Deferred.await(shutdownStarted);
    expect(requests.filter((url) => url.endsWith("/api/devices/shutdown"))).toHaveLength(1);
    expect((yield* Fiber.join(releasedSession))._tag).toBe("Some");
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer()))),
);

it.effect("publishes boot progress and does not restore sessions after support is disabled", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const { service } = yield* fixture(
      Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(finish))),
    );
    yield* service.configure({ enabled: true });
    const opening = yield* service
      .open({ threadId: ThreadId.make("thread-1"), deviceId: "Pixel_API_35", platform: "android" })
      .pipe(Effect.result, Effect.forkChild);
    yield* Deferred.await(started);
    expect((yield* service.state).bootingDevices?.map((device) => device.name)).toEqual([
      "Pixel_API_35",
    ]);
    yield* service.configure({ enabled: false });
    yield* Deferred.succeed(finish, undefined);
    expect((yield* Fiber.join(opening))._tag).toBe("Failure");
    const state = yield* service.state;
    expect(state.hostStatus).toBe("disabled");
    expect(state.devices).toEqual([]);
    expect(state.sessions).toEqual([]);
    expect(state.bootingDevices).toEqual([]);
  }).pipe(Effect.scoped),
);

it.effect(
  "production device composition releases an agent owner when its provider session ends",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const homeDirectory = yield* fs.makeTempDirectoryScoped({
        prefix: "device-provider-liveness-",
      });
      const baseDir = (yield* Path.Path).join(homeDirectory, "worktree", ".t3");
      const live = yield* Ref.make(true);
      const { service } = yield* fixture(
        Effect.void,
        undefined,
        false,
        undefined,
        false,
        undefined,
        {
          automaticCleanup: false,
          isProviderSessionLive: () => Ref.get(live),
        },
        true,
        baseDir,
        homeDirectory,
      );
      yield* service.configure({ enabled: true });
      const threadId = ThreadId.make("provider-session-ended");
      const providerSessionId = ProviderSessionId.make("ended-provider-session");
      yield* service.open(
        {
          threadId,
          hostId: LOCAL_DEVICE_HOST_ID,
          deviceId: DeviceId.make("emulator-5554"),
          platform: "android",
        },
        { kind: "agent", providerSessionId },
      );

      yield* Ref.set(live, false);
      const panel = yield* service.open({
        threadId,
        hostId: LOCAL_DEVICE_HOST_ID,
        deviceId: DeviceId.make("emulator-5554"),
        platform: "android",
      });
      const leases = yield* makeFileDeviceLeaseStore(deviceLeaseDirectory(homeDirectory)).list;
      expect(leases.flatMap((entry) => entry.lease?.owners ?? [])).toMatchObject([
        { kind: "panel", sessionId: panel.sessionId, observer: false },
      ]);
      expect(
        leases
          .flatMap((entry) => entry.lease?.owners ?? [])
          .some((owner) => owner.providerSessionId === providerSessionId),
      ).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

describe("device discovery after server restart", () => {
  it.effect("captures an explicit device before any client lists devices", () =>
    Effect.gen(function* () {
      const { service, settings, requests } = yield* fixture();
      yield* Ref.update(settings, (current) => ({ ...current, enableDeviceSupport: true }));
      expect((yield* service.state).devices).toEqual([]);
      const capture = yield* service.screenshot({ deviceId: DeviceId.make("Pixel_API_35") });
      expect(capture.device.id).toBe("Pixel_API_35");
      expect(Array.from(capture.png)).toEqual([137, 80, 78, 71]);
      expect(requests.some((url) => url.endsWith("/api/devices"))).toBe(true);
    }).pipe(Effect.scoped),
  );
});

it.effect.each([
  {
    diagnostic: "Insufficient disk space at /private/user/path",
    reason: "disk_space",
    message: "not enough free disk space",
  },
  {
    diagnostic: "Timed out spawning /private/user/command",
    reason: "timeout",
    message: "did not become ready in time",
  },
  {
    diagnostic: "Unexpected failure: secret-token",
    reason: "launch_failed",
    message: "could not start",
  },
] as const)("normalizes boot failure: $reason", ({ diagnostic, message }) =>
  Effect.gen(function* () {
    const { service } = yield* fixture(Effect.void, diagnostic);
    yield* service.configure({ enabled: true });
    const error = yield* service
      .open({
        threadId: ThreadId.make("boot-failure"),
        deviceId: "Pixel_API_35",
        platform: "android",
      })
      .pipe(Effect.flip);
    expect(error._tag).toBe("DeviceBootError");
    expect(error.message).toContain(message);
    expect(error.message).not.toContain(diagnostic);
    expect((yield* service.state).bootingDevices).toEqual([]);
  }).pipe(Effect.scoped),
);

it.effect("keeps shutdown successful when subsequent discovery fails", () =>
  Effect.gen(function* () {
    const { service } = yield* fixture(Effect.void, undefined, true);
    yield* service.configure({ enabled: true });
    const threadId = ThreadId.make("shutdown-refresh");
    const session = yield* service.open({
      threadId,
      deviceId: "Pixel_API_35",
      platform: "android",
    });
    yield* service.close({ threadId, deviceId: session.deviceId, shutdown: true });
    const state = yield* service.state;
    expect(state.sessions).toEqual([]);
    expect(state.devices.find((device) => device.id === session.deviceId)?.booted).toBe(false);
  }).pipe(Effect.scoped),
);

it.effect("closing releases iOS capture so reopening uses a fresh session", () =>
  Effect.gen(function* () {
    const deviceId = DeviceId.make("11111111-1111-1111-1111-111111111111");
    const threadId = ThreadId.make("capture-recovery");
    let booted = true;
    let capture: number | null = null;
    let generation = 0;
    const ready: DeviceHost.DeviceHostReady = {
      nodePath: process.execPath,
      hub: { origin: "http://device.test" },
      helpers: { serveSimAxSettings: null, serveSimCli: null },
      run: () => Effect.succeed({ code: 0, stdout: "", stderr: "" }),
    };
    const host: DeviceHost.DeviceHost["Service"] = {
      id: LOCAL_DEVICE_HOST_ID,
      summary: Effect.succeed({
        id: LOCAL_DEVICE_HOST_ID,
        kind: "local",
        label: "Simulator host",
        platforms: [{ platform: "ios", available: true }],
        hubInstalled: true,
        agentDeviceInstalled: false,
      }),
      platformAvailability: (platform) => Effect.succeed({ platform, available: true }),
      ensureReady: () => Effect.succeed(ready),
      ensureAgentReady: () => Effect.die("Agent access is not used in this test"),
      current: Effect.succeed(ready),
      stopAgent: Effect.void,
      stop: Effect.void,
    };
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        const path = new URL(request.url).pathname;
        if (path === "/api/devices") {
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              emulators: [],
              simulators: [
                {
                  id: deviceId,
                  name: "iPhone",
                  platform: "ios",
                  version: "26",
                  physical: false,
                  booted,
                },
              ],
            }),
          );
        }
        if (path === "/vendor/serve-sim/grid/api/start") capture ??= ++generation;
        else if (path === "/vendor/serve-sim/grid/api/shutdown") {
          if (request.body._tag !== "Uint8Array") throw new Error("Missing shutdown body");
          expect(decodeJson(new TextDecoder().decode(request.body.body))).toEqual({
            udid: deviceId,
          });
          capture = null;
          booted = false;
        } else if (path === "/api/devices/shutdown") {
          // This route powers off without releasing serve-sim's cached capture.
          booted = false;
        } else if (path === "/api/devices/boot") booted = true;
        else throw new Error(`Unexpected hub path: ${path}`);
        return HttpClientResponse.fromWeb(request, Response.json({ ok: true, id: deviceId }));
      }),
    );
    const service = yield* DeviceService.makeWithHosts(new Map([[host.id, host]])).pipe(
      Effect.provide(NodeCrypto.layer),
      Effect.provideService(HttpClient.HttpClient, http),
    );
    const input = { threadId, deviceId, platform: "ios" as const };
    yield* service.open(input);
    expect(capture).toBe(1);
    yield* service.close({ threadId, deviceId, shutdown: true });
    expect(capture).toBeNull();
    expect((yield* service.state).sessions).toEqual([]);
    yield* service.open(input);
    expect(capture).toBe(2);
    expect((yield* service.state).sessions).toHaveLength(1);
  }).pipe(Effect.provide(ServerSettings.layerTest({ enableDeviceSupport: true })), Effect.scoped),
);

it.effect("refuses unowned shutdown while a device lease is active", () =>
  Effect.gen(function* () {
    const { service, requests } = yield* fixture();
    yield* service.configure({ enabled: true });
    const session = yield* service.open({
      threadId: ThreadId.make("explicit-shutdown"),
      deviceId: "Pixel_API_35",
      platform: "android",
    });
    const result = yield* Effect.exit(
      service.shutdown({ deviceId: session.deviceId, platform: session.platform }),
    );
    expect(Exit.isFailure(result)).toBe(true);
    expect((yield* service.state).sessions).toHaveLength(1);
    expect(requests.some((url) => url.endsWith("/api/devices/shutdown"))).toBe(false);
  }).pipe(Effect.scoped),
);

it.effect.each([
  { hubReports: "off", outcome: "succeeds" },
  { hubReports: "booted", outcome: "fails" },
  { hubReports: "missing", outcome: "fails" },
] as const)(
  "iOS shutdown $outcome when serve-sim rejects it and the hub reports the simulator $hubReports",
  ({ hubReports, outcome }) =>
    Effect.gen(function* () {
      const deviceId = DeviceId.make("22222222-2222-2222-2222-222222222222");
      const paths: string[] = [];
      let listed: "booted" | "off" | "missing" = "booted";
      const ready: DeviceHost.DeviceHostReady = {
        nodePath: process.execPath,
        hub: { origin: "http://device.test" },
        helpers: { serveSimAxSettings: null, serveSimCli: null },
        run: () => Effect.succeed({ code: 0, stdout: "", stderr: "" }),
      };
      const host: DeviceHost.DeviceHost["Service"] = {
        id: LOCAL_DEVICE_HOST_ID,
        summary: Effect.succeed({
          id: LOCAL_DEVICE_HOST_ID,
          kind: "local",
          label: "Simulator host",
          platforms: [{ platform: "ios", available: true }],
          hubInstalled: true,
          agentDeviceInstalled: false,
        }),
        platformAvailability: (platform) => Effect.succeed({ platform, available: true }),
        ensureReady: () => Effect.succeed(ready),
        ensureAgentReady: () => Effect.die("Agent access is not used in this test"),
        current: Effect.succeed(ready),
        stopAgent: Effect.void,
        stop: Effect.void,
      };
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          const path = new URL(request.url).pathname;
          paths.push(path);
          if (path === "/api/devices") {
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                emulators: [],
                simulators:
                  listed === "missing"
                    ? []
                    : [
                        {
                          id: deviceId,
                          name: "iPhone",
                          platform: "ios",
                          version: "26",
                          physical: false,
                          booted: listed === "booted",
                        },
                      ],
                errors: listed === "missing" ? [{ message: "simctl list failed" }] : [],
              }),
            );
          }
          if (path === "/vendor/serve-sim/grid/api/shutdown") {
            // serve-sim runs `simctl shutdown` bare and returns its failure as-is.
            listed = hubReports;
            return HttpClientResponse.fromWeb(
              request,
              Response.json(
                { ok: false, error: "Unable to shutdown device in current state: Shutdown" },
                { status: 500 },
              ),
            );
          }
          throw new Error(`Unexpected hub path: ${path}`);
        }),
      );
      const service = yield* DeviceService.makeWithHosts(new Map([[host.id, host]])).pipe(
        Effect.provide(NodeCrypto.layer),
        Effect.provideService(HttpClient.HttpClient, http),
      );
      yield* service.list;
      const exit = yield* Effect.exit(service.shutdown({ deviceId, platform: "ios" }));
      expect(paths.filter((path) => path.endsWith("shutdown"))).toEqual([
        "/vendor/serve-sim/grid/api/shutdown",
      ]);
      if (outcome === "succeeds") {
        expect(Exit.isSuccess(exit)).toBe(true);
        expect(
          (yield* service.state).devices.find((device) => device.id === deviceId)?.booted,
        ).toBe(false);
      } else {
        expect(Exit.isFailure(exit)).toBe(true);
        expect(
          (yield* service.state).devices.find((device) => device.id === deviceId)?.booted,
        ).toBe(true);
      }
    }).pipe(Effect.provide(ServerSettings.layerTest({ enableDeviceSupport: true })), Effect.scoped),
);

it.effect("retry keeps device and agent consent unchanged", () =>
  Effect.gen(function* () {
    const { service, starts, agentStarts } = yield* fixture();
    yield* service.retryHost(LOCAL_DEVICE_HOST_ID);
    expect(starts).toEqual([]);
    expect(agentStarts).toEqual([]);
    yield* service.configure({ enabled: true });
    yield* service.retryHost(LOCAL_DEVICE_HOST_ID);
    expect(agentStarts).toEqual([]);
    yield* service.configure({ agentAccessEnabled: true });
    const before = agentStarts.length;
    yield* service.retryHost(LOCAL_DEVICE_HOST_ID);
    expect(agentStarts.length).toBe(before + 1);
  }).pipe(Effect.scoped),
);

it.effect("publishes update detail for the correct host", () =>
  Effect.gen(function* () {
    const { service } = yield* fixture();
    const changes = yield* service.subscribe;
    yield* service.configure({ enabled: true });
    const states = yield* PubSub.takeAll(changes);
    expect(
      states.some(
        (state) => state.hostStatuses.local?.detail === "Updating device hub from 0.9.0 to 0.10.1…",
      ),
    ).toBe(true);
  }).pipe(Effect.scoped),
);

it.effect("host retry exposes actionable failure without internal IDs or diagnostics", () =>
  Effect.gen(function* () {
    const { service, settings } = yield* fixture(
      Effect.void,
      undefined,
      false,
      new DeviceHost.DeviceHostError({
        hostId: LOCAL_DEVICE_HOST_ID,
        step: "probe",
        cause: "private diagnostics",
      }),
    );
    yield* Ref.update(settings, (current) => ({ ...current, enableDeviceSupport: true }));
    const state = yield* service.retryHost(LOCAL_DEVICE_HOST_ID);
    expect(state.supportsHostRetry).toBe(true);
    expect(state.hostStatuses[LOCAL_DEVICE_HOST_ID]).toEqual({
      status: "failed",
      detail: "Could not connect to this host over SSH.",
    });
  }).pipe(Effect.scoped),
);

it.effect("version discovery does not grant consent or start device tools", () =>
  Effect.gen(function* () {
    const { service, starts, agentStarts, requests } = yield* fixture();
    const state = yield* service.inspect;
    expect(state.supportsToolInspection).toBe(true);
    expect(state.hostStatus).toBe("disabled");
    expect(state.hosts).toHaveLength(1);
    expect(starts).toEqual([]);
    expect(agentStarts).toEqual([]);
    expect(requests).toEqual([]);
  }).pipe(Effect.scoped),
);

it.effect("failed read-only discovery preserves lifecycle status and installed inventory", () =>
  Effect.gen(function* () {
    const { service, starts } = yield* fixture(Effect.void, undefined, false, undefined, true);
    const state = yield* service.inspect;
    expect(state.supportsToolInspection).toBe(true);
    expect(state.hostStatus).toBe("disabled");
    expect(state.hosts[0]?.hubInstalled).toBe(true);
    expect(state.hosts[0]?.toolInspectionError).toContain("Reconnect the host");
    expect(starts).toEqual([]);
  }).pipe(Effect.scoped),
);

it.effect(
  "manual updates install only the selected tool without enabling access or starting helpers",
  () =>
    Effect.gen(function* () {
      const installed: string[] = [];
      const { service, starts, agentStarts, requests } = yield* fixture(
        Effect.void,
        undefined,
        false,
        undefined,
        false,
        (tool) =>
          Effect.sync(() => {
            installed.push(tool);
          }),
      );
      const before = yield* service.state;
      const state = yield* service.updateTool("agent");
      expect(installed).toEqual(["agent"]);
      expect(state.supportsToolUpdate).toBe(true);
      expect(state.hostStatus).toBe(before.hostStatus);
      expect(state.agentAccessEnabled).toBe(before.agentAccessEnabled);
      expect(state.revision).toBeGreaterThan(before.revision);
      expect(starts).toEqual([]);
      expect(agentStarts).toEqual([]);
      expect(requests).toEqual([]);
      yield* service.updateTool("hub");
      expect(installed).toEqual(["agent", "hub"]);
    }).pipe(Effect.scoped),
);

it.effect("failed manual installation leaves lifecycle state unchanged and can be retried", () =>
  Effect.gen(function* () {
    let attempts = 0;
    const { service, starts, agentStarts } = yield* fixture(
      Effect.void,
      undefined,
      false,
      undefined,
      false,
      () =>
        Effect.suspend(() =>
          ++attempts === 1
            ? Effect.fail(
                new DeviceOperationError({
                  operation: "update device tool",
                  reason: "command_failed",
                  cause: new Error("offline"),
                }),
              )
            : Effect.void,
        ),
    );
    const before = yield* service.state;
    const result = yield* service.updateTool("agent").pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    expect(yield* service.state).toEqual(before);
    yield* service.updateTool("agent");
    expect(attempts).toBe(2);
    expect(starts).toEqual([]);
    expect(agentStarts).toEqual([]);
  }).pipe(Effect.scoped),
);

it.effect("reconciles SSH host settings without publishing no-op changes", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-device-reconcile-" });
    const settings = yield* ServerSettings.ServerSettingsService;
    // Each change is acknowledged after reconciliation consumed it, so no-ops are observable.
    const changes = yield* Queue.unbounded<{ value: Settings; done: Deferred.Deferred<void> }>();
    const removedFiles: string[] = [];
    const localHost: DeviceHost.DeviceHost["Service"] = {
      id: LOCAL_DEVICE_HOST_ID,
      summary: Effect.succeed({
        id: LOCAL_DEVICE_HOST_ID,
        label: "Local",
        kind: "local",
        platforms: [],
        hubInstalled: false,
        agentDeviceInstalled: false,
      }),
      platformAvailability: (platform) => Effect.succeed({ platform, available: false }),
      current: Effect.succeed(null),
      ensureReady: () => Effect.die("Unexpected device launch"),
      ensureAgentReady: () => Effect.die("Unexpected agent launch"),
      stop: Effect.void,
      stopAgent: Effect.void,
    };
    const service = yield* DeviceService.make().pipe(
      Effect.provideService(DeviceHost.DeviceHost, localHost),
      Effect.provideService(ServerSettings.ServerSettingsService, {
        ...settings,
        subscribeChanges: Effect.succeed(
          Stream.fromQueue(changes).pipe(
            Stream.flatMap(({ value, done }) =>
              Stream.make(value).pipe(
                Stream.concat(
                  Stream.fromEffect(Deferred.succeed(done, undefined)).pipe(Stream.drain),
                ),
              ),
            ),
          ),
        ),
      }),
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          remove: (file) => Effect.sync(() => void removedFiles.push(file)),
        }),
      ),
      Effect.provideService(ProcessRunner.ProcessRunner, {
        run: () => Effect.die("Unexpected helper launch"),
      }),
      Effect.provideService(
        DeviceAgentLiveness.DeviceAgentLiveness,
        DeviceAgentLiveness.DeviceAgentLiveness.of({
          bind: () => Effect.void,
          isLive: () => Effect.succeed(true),
        }),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Unexpected HTTP request")),
      ),
      // `ssh -G` resolves the target to a non-local address.
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(123),
              stdout: Stream.make(new TextEncoder().encode("hostname 192.0.2.1\nport 22\n")),
              stderr: Stream.empty,
              all: Stream.empty,
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              stdin: Sink.drain,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
              unref: Effect.succeed(Effect.void),
            }),
          ),
        ),
      ),
      Effect.provide(Layer.mergeAll(ServerConfig.layerTest(baseDir, baseDir), NetService.layer)),
    );
    const update = Effect.fnUntraced(function* (deviceHosts: ReadonlyArray<SshDeviceHostConfig>) {
      const value = yield* settings.updateSettings({ deviceHosts: [...deviceHosts] });
      const done = yield* Deferred.make<void>();
      yield* Queue.offer(changes, { value, done });
      yield* Deferred.await(done);
      return yield* service.state;
    });

    const initial = yield* service.state;
    expect(yield* update([])).toEqual(initial);

    const host: SshDeviceHostConfig = { id: "remote", label: "Remote", target: "remote-fixture" };
    const added = yield* update([host]);
    expect(added.hosts.map((entry) => entry.id)).toEqual([LOCAL_DEVICE_HOST_ID, host.id]);
    expect(yield* update([{ ...host }])).toEqual(added);

    yield* service.setHostStatus(host.id, { status: "failed", detail: "stale" });
    const removed = yield* update([]);
    expect(removed.hosts.map((entry) => entry.id)).toEqual([LOCAL_DEVICE_HOST_ID]);
    expect(removed.hostStatuses[host.id]).toBeUndefined();
    expect(removedFiles).toHaveLength(1);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        ServerSettings.layerTest(),
        NodeServices.layer,
        AgentDeviceProxyRegistry.layer,
      ),
    ),
  ),
);

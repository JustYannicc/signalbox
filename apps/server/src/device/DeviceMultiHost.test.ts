import { expect, it } from "@effect/vitest";
import { DeviceHostId, DeviceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ServerSettings from "../serverSettings.ts";
import * as DeviceHost from "./DeviceHost.ts";
import * as DeviceService from "./DeviceService.ts";

it.effect("keeps hosts independent when serials collide and another host fails", () =>
  Effect.gen(function* () {
    const host = (id: string, failed = false): DeviceHost.DeviceHost["Service"] => {
      const ready = {
        nodePath: process.execPath,
        hub: { origin: `http://${id}` },
        agentDevice: { baseUrl: `http://${id}`, token: "test", entryPath: "/agent-device" },
        run: () => Effect.succeed({ stdout: "", stderr: "", code: 0 }),
        helpers: { serveSimAxSettings: null, serveSimCli: null },
      };
      return {
        id,
        summary: Effect.succeed({
          id,
          label: id,
          kind: id === "b" ? "ssh" : "local",
          hubInstalled: true,
          agentDeviceInstalled: true,
          platforms: id === "b" ? [] : [{ platform: "android", available: true }],
        }),
        platformAvailability: (platform) => Effect.succeed({ platform, available: true }),
        ensureReady: () =>
          failed
            ? Effect.fail(
                new DeviceHost.DeviceHostError({
                  hostId: id,
                  step: "connect",
                  cause: new Error("offline"),
                }),
              )
            : Effect.succeed(ready),
        ensureAgentReady: () => Effect.succeed(ready),
        current: Effect.succeed(ready),
        stopAgent: Effect.void,
        stop: Effect.void,
      };
    };
    const http = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            simulators: [],
            emulators: [
              {
                id: "emulator-5554",
                name: "Pixel",
                version: "36",
                platform: "android",
                booted: true,
                physical: false,
              },
            ],
          }),
        ),
      ),
    );
    const hosts = new Map(["a", "b", "offline"].map((id) => [id, host(id, id === "offline")]));
    const writeStarted = yield* Deferred.make<void>();
    const finishWrite = yield* Deferred.make<void>();
    const order: string[] = [];
    const service = yield* DeviceService.makeWithHosts(hosts, undefined, () =>
      Effect.gen(function* () {
        order.push("write started");
        yield* Deferred.succeed(writeStarted, undefined);
        yield* Deferred.await(finishWrite);
        order.push("write finished");
        return "/host-config.json";
      }),
    ).pipe(Effect.provide(NodeCrypto.layer), Effect.provideService(HttpClient.HttpClient, http));
    expect(yield* service.agentReadinessIfSupported("b")).not.toBeNull();
    const listed = yield* service.list;
    expect(listed.devices.map((device) => device.hostId).sort()).toEqual(["a", "b"]);
    expect(listed.hostStatuses.offline?.status).toBe("failed");
    const threadId = ThreadId.make("thread");
    for (const hostId of ["a", "b"])
      yield* service.open({ threadId, hostId, deviceId: "emulator-5554", platform: "android" });
    yield* service.close({ threadId, hostId: "a", deviceId: "emulator-5554" });
    const state = yield* service.state;
    expect(state.devices).toHaveLength(2);
    expect(state.sessions.map((session) => session.hostId)).toEqual(["b"]);
    expect(state.hostStatuses.a?.status).toBe("ready");
    expect(state.hostStatuses.offline?.status).toBe("failed");
    const panelSession = state.sessions[0]!;
    yield* service.close({
      threadId,
      hostId: panelSession.hostId,
      deviceId: panelSession.deviceId,
      sessionId: panelSession.sessionId,
      leaseId: panelSession.leaseId,
    });
    const providerSessionId = ProviderSessionId.make("provider-session-b");
    const agentSession = yield* service.open(
      { threadId, hostId: "b", deviceId: "emulator-5554", platform: "android" },
      { kind: "agent", providerSessionId },
    );
    const targeting = yield* service
      .agentTarget({
        threadId,
        hostId: "b",
        deviceId: "emulator-5554",
        sessionId: agentSession.sessionId,
        leaseId: agentSession.leaseId,
        providerSessionId,
      })
      .pipe(Effect.forkChild);
    yield* Deferred.await(writeStarted);
    const replacing = yield* service
      .withLifecycleLock(
        Effect.gen(function* () {
          order.push("replace");
          hosts.set("b", host("b"));
          yield* service.refreshHosts;
        }),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.succeed(finishWrite, undefined);
    yield* Fiber.join(targeting);
    yield* Fiber.join(replacing);
    expect(order).toEqual(["write started", "write finished", "replace"]);
    const replaced = yield* service.state;
    expect(replaced.sessions).toEqual([]);
    expect(replaced.devices.map((device) => device.hostId)).toEqual(["a"]);
    expect(replaced.hostStatuses.b).toBeUndefined();
    yield* service.open({ threadId, hostId: "b", deviceId: "emulator-5554", platform: "android" });
    hosts.delete("b");
    yield* service.refreshHosts;
    yield* service.setHostStatus("b", { status: "ready" });
    expect((yield* service.state).hostStatuses.b).toBeUndefined();
    expect((yield* service.state).sessions).toEqual([]);
    yield* service.agentReadinessIfSupported("a");
    expect((yield* service.state).hostStatuses.a?.status).toBe("ready");
    yield* service.configure({ enabled: false });
    expect((yield* service.state).hostStatuses).toEqual({});
  }).pipe(
    Effect.provide(
      ServerSettings.layerTest({
        enableDeviceSupport: true,
        enableAgentDeviceAccess: true,
      }),
    ),
  ),
);

it.effect("uses the refreshed SSH endpoint when readiness returns a stale snapshot", () =>
  Effect.gen(function* () {
    const hostId = DeviceHostId.make("ssh-reconnect");
    const deviceId = DeviceId.make("emulator-5554");
    const threadId = ThreadId.make("ssh-reconnect-race");
    const providerSessionId = ProviderSessionId.make("provider-reconnect-race");
    const makeReady = (baseUrl: string): DeviceHost.DeviceHostAgentReady => ({
      nodePath: process.execPath,
      hub: { origin: "http://device.test" },
      agentDevice: { baseUrl, token: `${baseUrl}-token`, entryPath: "/agent-device" },
      run: () => Effect.succeed({ stdout: "", stderr: "", code: 0 }),
      helpers: { serveSimAxSettings: null, serveSimCli: null },
    });
    const oldReady = makeReady("http://agent-old.test");
    const reconnectedReady = makeReady("http://agent-new.test");
    const targetReadinessCaptured = yield* Deferred.make<void>();
    const allowTargetReadinessReturn = yield* Deferred.make<void>();
    const currentReadinessPublished = yield* Deferred.make<void>();
    let captureTargetReadiness = false;
    let currentReady = oldReady;
    const configuredEndpoints: Array<string> = [];
    const refreshedEndpoints: Array<string> = [];
    const host: DeviceHost.DeviceHost["Service"] = {
      id: hostId,
      summary: Effect.succeed({
        id: hostId,
        label: "SSH host",
        kind: "ssh",
        hubInstalled: true,
        agentDeviceInstalled: true,
        platforms: [{ platform: "android", available: true }],
      }),
      platformAvailability: (platform) => Effect.succeed({ platform, available: true }),
      ensureReady: () => Effect.succeed(oldReady),
      ensureAgentReady: () =>
        Effect.gen(function* () {
          const ready = oldReady;
          if (captureTargetReadiness) {
            captureTargetReadiness = false;
            yield* Deferred.succeed(targetReadinessCaptured, undefined);
            yield* Deferred.await(allowTargetReadinessReturn);
            currentReady = reconnectedReady;
            yield* Deferred.succeed(currentReadinessPublished, undefined);
          }
          return ready;
        }),
      current: Effect.sync(() => currentReady),
      stopAgent: Effect.void,
      stop: Effect.void,
    };
    const http = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            simulators: [],
            emulators: [
              {
                id: deviceId,
                name: "Pixel",
                version: "36",
                platform: "android",
                booted: true,
                physical: false,
              },
            ],
          }),
        ),
      ),
    );
    const service = yield* DeviceService.makeWithHosts(
      new Map([[hostId, host]]),
      undefined,
      (_hostId, ready) =>
        Effect.sync(() => {
          configuredEndpoints.push(ready.agentDevice.baseUrl);
          return "/agent-config.json";
        }),
      undefined,
      { automaticCleanup: false },
      (_hostId, ready, session) =>
        Effect.sync(() => {
          refreshedEndpoints.push(`${session.sessionId}:${ready.agentDevice.baseUrl}`);
        }),
    ).pipe(Effect.provide(NodeCrypto.layer), Effect.provideService(HttpClient.HttpClient, http));

    const session = yield* service.open(
      { threadId, hostId, deviceId, platform: "android" },
      { kind: "agent", providerSessionId },
    );
    const target = {
      threadId,
      hostId,
      deviceId,
      sessionId: session.sessionId,
      leaseId: session.leaseId,
      providerSessionId,
    };
    yield* service.agentTarget(target);
    expect(configuredEndpoints).toEqual(["http://agent-old.test"]);

    captureTargetReadiness = true;
    const targetFiber = yield* service.agentTarget(target).pipe(Effect.forkChild);
    yield* Deferred.await(targetReadinessCaptured);
    // The host still exposes its previous readiness while its reconnect callback commits the new endpoint.
    yield* service.refreshAgentEndpoints(host, reconnectedReady);
    expect(refreshedEndpoints).toEqual([`${session.sessionId}:http://agent-new.test`]);
    yield* Deferred.succeed(allowTargetReadinessReturn, undefined);
    yield* Deferred.await(currentReadinessPublished);
    expect(currentReady.agentDevice.baseUrl).toBe("http://agent-new.test");
    yield* Fiber.join(targetFiber);

    expect(configuredEndpoints).toEqual(["http://agent-old.test", "http://agent-new.test"]);
  }).pipe(
    Effect.provide(
      ServerSettings.layerTest({ enableDeviceSupport: true, enableAgentDeviceAccess: true }),
    ),
    Effect.scoped,
  ),
);

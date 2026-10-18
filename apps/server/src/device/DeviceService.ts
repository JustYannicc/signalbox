import {
  type DeviceActionInput,
  type DeviceCancelOpenInput,
  type DeviceCloseInput,
  type DeviceConfigureInput,
  type DeviceDetail,
  type DeviceDetailInput,
  type DeviceError,
  type DeviceHostId,
  type DeviceId,
  DeviceBootError,
  DeviceHostUnavailableError,
  DeviceNotFoundError,
  DeviceOperationError,
  type DeviceOpenInput,
  type DevicePlatform,
  DevicePlatformUnavailableError,
  type DeviceServiceState,
  type DeviceSession,
  type DeviceShutdownInput,
  type DeviceSummary,
  type SshDeviceHostConfig,
  type DeviceHostSummary,
  LOCAL_DEVICE_HOST_ID,
  type ProviderSessionId,
  type ThreadId,
} from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
import { resolveNodeExecutable, nodeRuntimeUnavailableMessage } from "@t3tools/shared/nodeRuntime";
import * as Path from "effect/Path";
import { ensureAgentDevice, ensureDeviceHub } from "./DeviceToolchain.ts";
import * as ServerConfig from "../config.ts";
import {
  agentDeviceConfigDir,
  configureAgentDeviceSession,
  refreshAgentDeviceSession,
} from "./AgentDeviceTarget.ts";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpServer } from "effect/http";

import * as ServerSettings from "../serverSettings.ts";
import { isLocalSshDeviceHost, remoteSshDeviceHosts } from "./localSshDeviceHost.ts";
import * as DeviceAgentLiveness from "./DeviceAgentLiveness.ts";
import * as AgentDeviceProxyRegistry from "./AgentDeviceProxyRegistry.ts";
import { listAgentDeviceSessions, type AgentDeviceSession } from "./AgentDeviceSession.ts";

import { readDeviceDetail, runDeviceAction } from "./DeviceActions.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as DeviceHost from "./DeviceHost.ts";
import * as SshDeviceHost from "./SshDeviceHost.ts";
import * as Exit from "effect/Exit";
import * as LocalDeviceHost from "./LocalDeviceHost.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  canonicalDeviceId,
  DEVICE_CLEANUP_INTERVAL,
  DEVICE_LEASE_WAIT_TIMEOUT_MS,
  DEVICE_LEASE_WAIT_INTERVAL,
  DEVICE_LEASE_WAIT_ATTEMPTS,
  deviceAliases,
  type DeviceLeaseTarget,
  type DeviceOwnerLiveness,
} from "./DeviceLease.ts";
import {
  makeDeviceLeaseCoordinator,
  type DeviceLeaseCaller,
  type DeviceLeaseShutdownClaim,
  type DeviceLeaseSession,
} from "./DeviceLeaseCoordinator.ts";
import { makeDeviceLeaseAccess } from "./DeviceLeaseAccess.ts";
import { makeDeviceLeaseJanitor, type DeviceJanitorItem } from "./DeviceLeaseJanitor.ts";
import {
  type DeviceLeaseStore,
  currentDeviceLeaseProcessId,
  currentDeviceLeaseProcessIdentity,
  deviceLeaseProcessLiveness,
  deviceLeaseDirectory,
  makeFileDeviceLeaseStore,
  makeMemoryDeviceLeaseStore,
} from "./DeviceLeaseStore.ts";

export const DEVICE_HUB_ROUTE_PREFIX = "/api/device-hub";

const BOOT_TIMEOUT = Duration.minutes(3);
const SCREENSHOT_TIMEOUT = Duration.seconds(20);
const OPEN_REQUEST_CANCEL_TTL_MS = DEVICE_LEASE_WAIT_TIMEOUT_MS * 2;

const HubDevice = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  version: Schema.String,
  platform: Schema.Literals(["ios", "android"]),
  booted: Schema.Boolean,
  physical: Schema.Boolean,
});
const HubDeviceList = Schema.Struct({
  simulators: Schema.Array(HubDevice),
  emulators: Schema.Array(HubDevice),
  errors: Schema.optional(Schema.Array(Schema.Struct({ message: Schema.String }))),
});
const HubActionResult = Schema.Struct({
  ok: Schema.Boolean,
  id: Schema.optional(Schema.String),
  serial: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});

export interface DeviceScreenshot {
  readonly device: DeviceSummary;
  readonly png: Uint8Array;
}

export interface DeviceReadiness extends DeviceHost.DeviceHostReady {
  readonly hostId: DeviceHostId;
}

export interface DeviceAgentReadiness extends DeviceReadiness {
  readonly agentDevice: DeviceHost.AgentDeviceEndpoint;
}

export type DeviceOpenOwner =
  | { readonly kind: "panel"; readonly sessionId?: string; readonly leaseId?: string }
  | { readonly kind: "agent"; readonly providerSessionId: ProviderSessionId };

export interface DeviceLeaseRuntime {
  readonly store?: DeviceLeaseStore;
  readonly processId?: number;
  readonly processIdentity?: string;
  readonly isOwnerProcessLive?: (processId: number, processIdentity: string) => DeviceOwnerLiveness;
  readonly isProviderSessionLive?: (
    providerSessionId: ProviderSessionId,
  ) => Effect.Effect<boolean | null>;
  readonly waitForLeaseRetry?: () => Effect.Effect<void>;
  readonly automaticCleanup?: boolean;
}

export class DeviceService extends Context.Service<
  DeviceService,
  {
    readonly agentCli: Effect.Effect<string, DeviceError>;
    readonly testHost: (
      config: SshDeviceHostConfig,
    ) => Effect.Effect<DeviceHostSummary, DeviceError>;
    readonly agentTarget: (input: {
      threadId: ThreadId;
      hostId: DeviceHostId;
      deviceId: DeviceId;
      sessionId: string;
      leaseId: string;
      providerSessionId: ProviderSessionId;
    }) => Effect.Effect<
      { readonly args: ReadonlyArray<string>; readonly sessionId: string },
      DeviceError
    >;
    readonly state: Effect.Effect<DeviceServiceState>;
    readonly subscribe: Effect.Effect<PubSub.Subscription<DeviceServiceState>, never, Scope.Scope>;
    readonly configure: (
      input: DeviceConfigureInput,
    ) => Effect.Effect<DeviceServiceState, DeviceError>;
    readonly list: Effect.Effect<DeviceServiceState, DeviceError>;
    readonly updateTool: (tool: "hub" | "agent") => Effect.Effect<DeviceServiceState, DeviceError>;
    readonly inspect: Effect.Effect<DeviceServiceState>;
    readonly retryHost: (hostId: DeviceHostId) => Effect.Effect<DeviceServiceState, DeviceError>;
    readonly open: (
      input: DeviceOpenInput,
      owner?: DeviceOpenOwner,
    ) => Effect.Effect<DeviceSession, DeviceError>;
    readonly cancelOpen: (input: DeviceCancelOpenInput) => Effect.Effect<void, DeviceError>;
    readonly close: (
      input: DeviceCloseInput,
      owner?: DeviceOpenOwner,
    ) => Effect.Effect<void, DeviceError>;
    readonly shutdown: (input: DeviceShutdownInput) => Effect.Effect<void, DeviceError>;
    /** Exact-ID maintenance seam used by the operator CLI. */
    readonly janitor: (input: {
      readonly hostId: DeviceHostId;
      readonly deviceId: DeviceId;
      readonly apply: boolean;
    }) => Effect.Effect<ReadonlyArray<DeviceJanitorItem>, DeviceError>;
    readonly detail: (input: DeviceDetailInput) => Effect.Effect<DeviceDetail, DeviceError>;
    readonly action: (input: DeviceActionInput) => Effect.Effect<DeviceDetail, DeviceError>;
    readonly screenshot: (input: {
      readonly hostId?: DeviceHostId | undefined;
      readonly deviceId: DeviceId;
    }) => Effect.Effect<DeviceScreenshot, DeviceError>;
    readonly readiness: (hostId?: DeviceHostId) => Effect.Effect<DeviceReadiness, DeviceError>;
    readonly readinessIfSupported: (
      hostId?: DeviceHostId,
    ) => Effect.Effect<DeviceReadiness | null, DeviceError>;
    readonly agentReadinessIfSupported: (
      hostId?: DeviceHostId,
    ) => Effect.Effect<DeviceAgentReadiness | null, DeviceError>;
    readonly currentReadiness: (hostId?: DeviceHostId) => Effect.Effect<DeviceReadiness | null>;
    readonly sessionsForThread: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<DeviceSession>>;
  }
>()("t3/device/DeviceService") {}

interface ServiceState {
  readonly state: DeviceServiceState;
}

interface DeviceOpenRequestState {
  readonly requestId: string;
  readonly threadId: ThreadId;
  readonly hostId: DeviceHostId;
  readonly deviceId: DeviceId;
  readonly canReleaseOwner: boolean;
  started: boolean;
  cancelled: boolean;
  cancelledAt?: number;
  target?: DeviceLeaseTarget;
  phase: "waiting" | "opening" | "renewing" | "committed";
}

const vendorPrefix = (platform: DevicePlatform) =>
  platform === "ios" ? "/vendor/serve-sim" : "/vendor/serve-emu";

const agentSessionFor = (
  state: DeviceServiceState,
  input: {
    readonly threadId: ThreadId;
    readonly hostId: DeviceHostId;
    readonly deviceId: DeviceId;
    readonly sessionId: string;
    readonly leaseId: string;
    readonly providerSessionId: ProviderSessionId;
  },
): AgentDeviceSession | undefined => {
  const session = state.sessions.find(
    (candidate) =>
      candidate.sessionId === input.sessionId &&
      candidate.leaseId === input.leaseId &&
      candidate.ownerKind === "agent" &&
      candidate.providerSessionId === input.providerSessionId &&
      candidate.threadId === input.threadId &&
      candidate.hostId === input.hostId &&
      candidate.deviceId === input.deviceId,
  );
  if (!session || session.providerSessionId === undefined) return undefined;
  return {
    sessionId: session.sessionId,
    leaseId: session.leaseId,
    ownerKind: "agent",
    providerSessionId: session.providerSessionId,
    threadId: session.threadId,
    hostId: session.hostId,
    deviceId: session.deviceId,
    platform: session.platform,
  };
};

const staleAgentTarget = () =>
  new DeviceOperationError({
    operation: "agent target",
    reason: "stale_session",
    cause: new Error("The requested agent device session is no longer current."),
  });

export const makeWithHosts = Effect.fn("DeviceService.makeWithHosts")(function* (
  hosts: ReadonlyMap<DeviceHostId, DeviceHost.DeviceHost["Service"]>,
  testHost: DeviceService["Service"]["testHost"] = (host) =>
    Effect.fail(
      new DeviceHostUnavailableError({
        hostId: host.id,
        reason: "SSH probing is unavailable in this device service.",
      }),
    ),
  configureAgent: (
    hostId: DeviceHostId,
    ready: DeviceHost.DeviceHostAgentReady,
    session: AgentDeviceSession,
  ) => Effect.Effect<string, DeviceError> = (hostId) =>
    Effect.fail(
      new DeviceHostUnavailableError({
        hostId,
        reason: "Agent configuration is unavailable in this device service.",
      }),
    ),
  installTool?: (tool: "hub" | "agent") => Effect.Effect<unknown, DeviceError>,
  leaseRuntime: DeviceLeaseRuntime = {},
  refreshAgent: (
    hostId: DeviceHostId,
    ready: DeviceHost.DeviceHostAgentReady,
    session: AgentDeviceSession,
  ) => Effect.Effect<void, DeviceError> = () => Effect.void,
) {
  const settings = yield* ServerSettings.ServerSettingsService;
  const crypto = yield* Crypto.Crypto;
  const lifecycleLock = yield* Semaphore.make(1);
  const sessionStateLock = yield* Semaphore.make(1);
  const readDeviceSettings = settings.getSettings.pipe(
    Effect.map((value) => ({
      enabled: value.enableDeviceSupport,
      agentAccessEnabled: value.enableAgentDeviceAccess,
      onboardingCompleted: value.deviceOnboardingCompleted,
    })),
    Effect.mapError(
      (cause) =>
        new DeviceOperationError({ operation: "settings", reason: "settings_failed", cause }),
    ),
  );
  const initialSettings = yield* readDeviceSettings;
  const leaseStore = leaseRuntime.store ?? (yield* makeMemoryDeviceLeaseStore);
  const processId = leaseRuntime.processId ?? currentDeviceLeaseProcessId;
  const processIdentity = leaseRuntime.processIdentity ?? currentDeviceLeaseProcessIdentity;
  const isOwnerProcessLive = leaseRuntime.isOwnerProcessLive ?? deviceLeaseProcessLiveness;
  const isProviderSessionLive = leaseRuntime.isProviderSessionLive;
  const leaseAccess = makeDeviceLeaseAccess({
    store: leaseStore,
    processId,
    processIdentity,
    isOwnerProcessLive,
    ...(isProviderSessionLive === undefined ? {} : { isProviderSessionLive }),
  });
  const leases = yield* makeDeviceLeaseCoordinator({ access: leaseAccess });
  const openRequests = new Map<string, DeviceOpenRequestState>();

  const pruneOpenRequestCancellations = (now: number) => {
    for (const [requestId, request] of openRequests) {
      if (
        !request.started &&
        request.cancelled &&
        request.cancelledAt !== undefined &&
        now - request.cancelledAt > OPEN_REQUEST_CANCEL_TTL_MS
      )
        openRequests.delete(requestId);
    }
  };

  const finishOpenRequest = (request: DeviceOpenRequestState | undefined) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (!request || openRequests.get(request.requestId) !== request) return;
        if (request.cancelled && request.canReleaseOwner) {
          yield* sessionStateLock
            .withPermit(
              Effect.gen(function* () {
                if (openRequests.get(request.requestId) !== request) return [];
                const claims = yield* leases.release({
                  threadId: request.threadId,
                  hostId: request.hostId,
                  deviceId: request.deviceId,
                  requestId: request.requestId,
                  caller: { kind: "panel", threadId: request.threadId },
                });
                yield* publish((state) => ({
                  ...state,
                  sessions: state.sessions.filter(
                    (session) => session.requestId !== request.requestId,
                  ),
                }));
                return claims;
              }),
            )
            .pipe(
              Effect.flatMap((claims) =>
                withShutdownClaims(claims, () =>
                  Effect.forEach(claims, (claim) => restore(runShutdownClaim(claim)), {
                    discard: true,
                  }),
                ),
              ),
              Effect.catch((cause) =>
                Effect.logWarning("Could not release a cancelled device open owner", {
                  hostId: request.hostId,
                  deviceId: request.deviceId,
                  cause,
                }),
              ),
            );
        }
        request.started = false;
        if (!request.cancelled) openRequests.delete(request.requestId);
      }),
    );

  const openRequestMatches = (
    request: DeviceOpenRequestState,
    input: Pick<DeviceOpenInput | DeviceCancelOpenInput, "threadId" | "hostId" | "deviceId">,
  ) =>
    request.threadId === input.threadId &&
    request.hostId === (input.hostId ?? LOCAL_DEVICE_HOST_ID) &&
    request.deviceId === input.deviceId;

  const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.withScope);
  const statePubSub = yield* PubSub.unbounded<DeviceServiceState>();
  const initialHosts = yield* Effect.forEach(hosts.values(), (host) => host.summary);
  let publishedHosts = new Map(hosts);
  const stateRef = yield* SynchronizedRef.make<ServiceState>({
    state: {
      supportsHostRetry: true,
      supportsToolUpdate: installTool !== undefined,
      supportsToolInspection: true,
      hosts: initialHosts,
      hostStatus: initialSettings.enabled ? "idle" : "disabled",
      hostStatuses: {},
      devices: [],
      sessions: [],
      onboardingCompleted: initialSettings.onboardingCompleted,
      agentAccessEnabled: initialSettings.agentAccessEnabled,
      hubBasePath: DEVICE_HUB_ROUTE_PREFIX,
      revision: 0,
    },
  });

  // SSH publishes onReady before its public current readiness, so retain the callback's source.
  const latestAgentReadyByHost = new WeakMap<
    DeviceHost.DeviceHost["Service"],
    DeviceHost.DeviceHostAgentReady
  >();
  const refreshAgentEndpoints = (
    host: DeviceHost.DeviceHost["Service"],
    ready: DeviceHost.DeviceHostAgentReady,
  ) =>
    SynchronizedRef.modifyEffect(stateRef, ({ state }) => {
      if (hosts.get(host.id) !== host) return Effect.succeed([undefined, { state }] as const);
      return Effect.forEach(
        listAgentDeviceSessions(state).filter((session) => session.hostId === host.id),
        (session) => refreshAgent(host.id, ready, session),
        { discard: true },
      ).pipe(
        Effect.tap(() => Effect.sync(() => latestAgentReadyByHost.set(host, ready))),
        Effect.as([undefined, { state }] as const),
      );
    });

  const publish = (update: (state: DeviceServiceState) => DeviceServiceState) =>
    SynchronizedRef.updateAndGetEffect(stateRef, ({ state }) => {
      const next = { ...update(state), revision: state.revision + 1 };
      return PubSub.publish(statePubSub, next).pipe(Effect.as({ state: next }));
    }).pipe(Effect.map(({ state }) => state));

  const resolveHost = (hostId: DeviceHostId | undefined) =>
    Effect.gen(function* () {
      const id = hostId ?? LOCAL_DEVICE_HOST_ID;
      const host = hosts.get(id);
      if (!host) {
        return yield* new DeviceHostUnavailableError({ hostId: id, reason: "Unknown host." });
      }
      return host;
    });

  const setHostStatus = (
    hostId: DeviceHostId,
    status: DeviceServiceState["hostStatuses"][string],
  ) =>
    Effect.suspend(() =>
      !hosts.has(hostId)
        ? SynchronizedRef.get(stateRef).pipe(Effect.map(({ state }) => state))
        : publish((state) => ({
            ...state,
            ...(hostId === LOCAL_DEVICE_HOST_ID
              ? { hostStatus: status.status, hostStatusDetail: status.detail }
              : {}),
            hostStatuses: { ...state.hostStatuses, [hostId]: status },
          })),
    );

  const readiness: DeviceService["Service"]["readiness"] = Effect.fn("DeviceService.readiness")(
    function* (hostId) {
      const host = yield* resolveHost(hostId);
      if (!(yield* readDeviceSettings).enabled) {
        return yield* new DeviceHostUnavailableError({
          hostId: host.id,
          reason:
            "Device support is off. Enable it in the Device panel before installing or starting device tools.",
        });
      }
      const ready = yield* host
        .ensureReady((status, detail) =>
          setHostStatus(host.id, { status, detail }).pipe(Effect.asVoid),
        )
        .pipe(
          Effect.tapError((error) =>
            setHostStatus(host.id, { status: "failed", detail: error.message }),
          ),
          Effect.mapError(
            (error) =>
              new DeviceHostUnavailableError({
                hostId: host.id,
                reason:
                  error._tag === "NodeRuntimeUnavailableError"
                    ? nodeRuntimeUnavailableMessage("Local device support")
                    : error.step === "probe"
                      ? "Could not connect to this host over SSH."
                      : `Device support failed during ${error.step}.`,
                cause: error,
              }),
          ),
        );
      if (hosts.get(host.id) !== host)
        return yield* new DeviceHostUnavailableError({
          hostId: host.id,
          reason: "Host configuration changed. Retry the operation.",
        });
      const { state } = yield* SynchronizedRef.get(stateRef);
      if (state.hostStatuses[host.id]?.status !== "ready") {
        yield* setHostStatus(host.id, { status: "ready" });
      }
      return { hostId: host.id, ...ready };
    },
    lifecycleLock.withPermit,
  );

  const readinessIfSupported: DeviceService["Service"]["readinessIfSupported"] = Effect.fn(
    "DeviceService.readinessIfSupported",
  )(function* (hostId) {
    if (!(yield* readDeviceSettings).enabled) return null;
    const host = yield* resolveHost(hostId);
    const summary = yield* host.summary;
    if (summary.kind === "local" && !summary.platforms.some((platform) => platform.available))
      return null;
    return yield* readiness(host.id);
  });

  const agentReadinessIfSupported: DeviceService["Service"]["agentReadinessIfSupported"] =
    Effect.fn("DeviceService.agentReadinessIfSupported")(function* (hostId) {
      const deviceSettings = yield* readDeviceSettings;
      if (!deviceSettings.enabled || !deviceSettings.agentAccessEnabled) return null;
      const host = yield* resolveHost(hostId);
      const summary = yield* host.summary;
      if (summary.kind === "local" && !summary.platforms.some((platform) => platform.available))
        return null;
      const ready = yield* host
        .ensureAgentReady((phase, detail) =>
          setHostStatus(host.id, { status: phase, detail }).pipe(Effect.asVoid),
        )
        .pipe(
          Effect.tapError((error) =>
            setHostStatus(host.id, { status: "failed", detail: error.message }),
          ),
          Effect.mapError(
            (error) =>
              new DeviceHostUnavailableError({
                hostId: host.id,
                reason:
                  error._tag === "NodeRuntimeUnavailableError"
                    ? nodeRuntimeUnavailableMessage("Local device support")
                    : error._tag === "DeviceHostTimeoutError"
                      ? `Agent tools did not start within ${error.timeoutMs} ms.`
                      : error._tag === "AgentDeviceStartError"
                        ? error.message
                        : error.step === "probe"
                          ? "Could not connect to this host over SSH."
                          : `Device support failed during ${error.step}.`,
                cause: error,
              }),
          ),
        );
      const hostSummaries = yield* Effect.forEach(hosts.values(), (candidate) => candidate.summary);
      yield* publish((state) => ({ ...state, hosts: hostSummaries }));
      yield* setHostStatus(host.id, { status: "ready" });
      return { hostId: host.id, ...ready };
    }, lifecycleLock.withPermit);

  const currentReadiness: DeviceService["Service"]["currentReadiness"] = (hostId) =>
    resolveHost(hostId).pipe(
      Effect.flatMap((host) =>
        host.current.pipe(Effect.map((ready) => (ready ? { hostId: host.id, ...ready } : null))),
      ),
      Effect.orElseSucceed(() => null),
    );

  const hubJson = <A, I>(
    request: HttpClientRequest.HttpClientRequest,
    schema: Schema.Codec<A, I>,
    operation: string,
    timeout: Duration.Input = Duration.seconds(15),
  ) =>
    httpClient.execute(request).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
      Effect.scoped,
      Effect.timeout(timeout),
      Effect.mapError(
        (cause) =>
          new DeviceOperationError({
            operation,
            reason: "request_failed",
            cause,
          }),
      ),
    );

  const leaseTarget = (device: DeviceSummary): DeviceLeaseTarget => ({
    hostId: device.hostId,
    platform: device.platform,
    id: device.id,
    name: device.name,
    booted: device.booted,
    physical: device.physical,
  });

  const findCanonicalDevice = (target: DeviceLeaseTarget, devices: ReadonlyArray<DeviceSummary>) =>
    devices.find(
      (candidate) =>
        candidate.hostId === target.hostId &&
        candidate.platform === target.platform &&
        deviceAliases(leaseTarget(candidate)).includes(canonicalDeviceId(target)),
    );

  const fetchDevices = Effect.fn("DeviceService.fetchDevices")(function* (ready: DeviceReadiness) {
    const list = yield* hubJson(
      HttpClientRequest.get(`${ready.hub.origin}/api/devices`),
      HubDeviceList,
      "list",
    );
    const toSummary = (device: typeof HubDevice.Type): DeviceSummary => ({
      hostId: ready.hostId,
      id: device.id,
      platform: device.platform,
      name: device.name,
      version: device.version,
      booted: device.booted,
      physical: device.physical,
    });
    const devices = [...list.simulators, ...list.emulators].map(toSummary);
    const host = yield* resolveHost(ready.hostId);
    if ((yield* host.platformAvailability("android")).available) {
      const avds = yield* ready.run("emulator", ["-list-avds"]);
      if (avds.code !== 0) {
        return yield* new DeviceOperationError({
          operation: "list",
          reason: "command_failed",
          exitCode: avds.code,
          cause: avds,
        });
      }
      for (const name of avds.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)) {
        if (!devices.some((device) => device.platform === "android" && device.name === name)) {
          devices.push({
            hostId: ready.hostId,
            id: name,
            name,
            platform: "android",
            version: "Android",
            booted: false,
            physical: false,
          });
        }
      }
    }
    return { devices, detail: list.errors?.map((error) => error.message).join("\n") || undefined };
  });

  const discoverTarget = (target: DeviceLeaseTarget) =>
    readiness(target.hostId).pipe(
      Effect.flatMap((ready) =>
        fetchDevices(ready).pipe(
          Effect.map((discovery) => ({
            ready,
            ...discovery,
            device: findCanonicalDevice(target, discovery.devices),
          })),
        ),
      ),
    );

  const deviceJanitor = makeDeviceLeaseJanitor(leaseAccess, {
    reconcileDevice: (target) =>
      discoverTarget(target).pipe(
        Effect.map(({ detail, device }) => (detail === undefined ? device?.booted : undefined)),
        Effect.catch(() => Effect.succeed(undefined)),
      ),
  });

  const refresh = Effect.fn("DeviceService.refresh")(function* (ready: DeviceReadiness) {
    const host = hosts.get(ready.hostId);
    const { devices, detail } = yield* fetchDevices(ready);
    const hostSummaries = yield* Effect.forEach(hosts.values(), (host) => host.summary);
    return yield* lifecycleLock.withPermit(
      Effect.gen(function* () {
        if (!(yield* readDeviceSettings).enabled || !host || hosts.get(ready.hostId) !== host)
          return (yield* SynchronizedRef.get(stateRef)).state;
        return yield* publish((state) => ({
          ...state,
          hosts: hostSummaries,
          ...(ready.hostId === LOCAL_DEVICE_HOST_ID ? { hostStatusDetail: detail } : {}),
          devices: [
            ...state.devices.filter((device) => device.hostId !== ready.hostId),
            ...devices,
          ],
          hostStatuses: {
            ...state.hostStatuses,
            [ready.hostId]: { status: "ready", ...(detail ? { detail } : {}) },
          },
        }));
      }),
    );
  });

  const list: DeviceService["Service"]["list"] = Effect.gen(function* () {
    if (!(yield* readDeviceSettings).enabled) return (yield* SynchronizedRef.get(stateRef)).state;
    yield* Effect.forEach(
      hosts.values(),
      (host) =>
        Effect.gen(function* () {
          const ready = yield* readinessIfSupported(host.id);
          if (ready) yield* refresh(ready);
        }).pipe(
          Effect.catch((error) =>
            setHostStatus(host.id, {
              status: "failed",
              detail: error._tag === "DeviceHostUnavailableError" ? error.reason : error.message,
            }),
          ),
        ),
      { concurrency: 4 },
    );
    return (yield* SynchronizedRef.get(stateRef)).state;
  }).pipe(Effect.withSpan("DeviceService.list"));

  const inspect = Effect.gen(function* () {
    yield* Effect.forEach(
      hosts.values(),
      (host) =>
        Effect.gen(function* () {
          const result = yield* (host.inspect ?? host.summary).pipe(Effect.result);
          if (hosts.get(host.id) !== host) return;
          if (result._tag === "Failure") {
            yield* publish((state) => ({
              ...state,
              hosts: state.hosts.map((value) =>
                value.id === host.id
                  ? {
                      ...value,
                      toolInspectionError:
                        "Cannot check versions. Reconnect the host and check again. Installed tools have not been changed.",
                    }
                  : value,
              ),
            }));
            return;
          }
          yield* publish((state) => ({
            ...state,
            hosts: state.hosts.map((value) => (value.id === host.id ? result.success : value)),
          }));
        }),
      { concurrency: 4 },
    );
    return (yield* SynchronizedRef.get(stateRef)).state;
  });

  const retryHost: DeviceService["Service"]["retryHost"] = Effect.fn("DeviceService.retryHost")(
    function* (hostId) {
      yield* resolveHost(hostId);
      if (!(yield* readDeviceSettings).enabled) return (yield* SynchronizedRef.get(stateRef)).state;
      yield* Effect.gen(function* () {
        const ready =
          (yield* agentReadinessIfSupported(hostId)) ?? (yield* readinessIfSupported(hostId));
        if (ready) yield* refresh(ready);
      }).pipe(
        Effect.catch((error) =>
          setHostStatus(hostId, {
            status: "failed",
            detail: error._tag === "DeviceHostUnavailableError" ? error.reason : error.message,
          }),
        ),
      );
      return (yield* SynchronizedRef.get(stateRef)).state;
    },
  );

  const configure: DeviceService["Service"]["configure"] = Effect.fn("DeviceService.configure")(
    function* (input) {
      const currentSettings = yield* readDeviceSettings;
      const nextEnabled = input.enabled ?? currentSettings.enabled;
      const nextAgentAccess = input.agentAccessEnabled ?? currentSettings.agentAccessEnabled;
      yield* lifecycleLock.withPermit(
        Effect.gen(function* () {
          yield* settings
            .updateSettings({
              ...(input.enabled === undefined ? {} : { enableDeviceSupport: input.enabled }),
              ...(input.agentAccessEnabled === undefined
                ? {}
                : { enableAgentDeviceAccess: input.agentAccessEnabled }),
              ...(input.onboardingCompleted === undefined
                ? {}
                : { deviceOnboardingCompleted: input.onboardingCompleted }),
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new DeviceOperationError({
                    operation: "configure",
                    reason: "settings_failed",
                    cause,
                  }),
              ),
            );
          if (!nextEnabled) {
            yield* Effect.forEach(hosts.values(), (host) => host.stop, { discard: true });
          } else if (input.agentAccessEnabled === false) {
            yield* Effect.forEach(hosts.values(), (host) => host.stopAgent, { discard: true });
          }
          yield* publish((state) => ({
            ...state,
            hostStatus: nextEnabled ? "idle" : "disabled",
            hostStatusDetail: undefined,
            hostStatuses: {},
            devices: nextEnabled ? state.devices : [],
            sessions: nextEnabled ? state.sessions : [],
            bootingDevices: nextEnabled ? state.bootingDevices : [],
            agentAccessEnabled: nextAgentAccess,
            onboardingCompleted: input.onboardingCompleted ?? state.onboardingCompleted,
          }));
        }),
      );
      if (nextEnabled && nextAgentAccess && input.agentAccessEnabled === true) {
        yield* agentReadinessIfSupported();
      }
      return yield* list;
    },
  );

  const findDevice = (
    state: DeviceServiceState,
    hostId: DeviceHostId,
    deviceId: DeviceId,
  ): DeviceSummary | undefined =>
    state.devices.find((device) => device.hostId === hostId && device.id === deviceId);

  const ensurePlatform = Effect.fn("DeviceService.ensurePlatform")(function* (
    host: DeviceHost.DeviceHost["Service"],
    platform: DevicePlatform,
  ) {
    const availability = yield* host.platformAvailability(platform);
    if (!availability.available) {
      return yield* new DevicePlatformUnavailableError({
        hostId: host.id,
        platform,
        reason: availability.reason ?? "Platform toolchain missing.",
      });
    }
  });

  /**
   * Android AVDs change id when they boot (AVD name to emulator serial), so the
   * returned id is authoritative.
   */
  const boot = Effect.fn("DeviceService.boot")(function* (
    ready: DeviceReadiness,
    device: DeviceSummary,
  ) {
    const result = yield* HttpClientRequest.post(`${ready.hub.origin}/api/devices/boot`).pipe(
      HttpClientRequest.bodyJson({ platform: device.platform, id: device.id, name: device.name }),
      Effect.mapError(
        (cause) =>
          new DeviceOperationError({ operation: "boot", reason: "invalid_payload", cause }),
      ),
      Effect.flatMap((request) => hubJson(request, HubActionResult, "boot", BOOT_TIMEOUT)),
    );
    if (!result.ok) {
      return yield* new DeviceBootError({
        hostId: ready.hostId,
        deviceId: device.id,
        reason: /insufficient.*(?:disk|space)|not enough.*(?:disk|space)|no space left/i.test(
          result.error ?? "",
        )
          ? "disk_space"
          : /timed? out|timeout/i.test(result.error ?? "")
            ? "timeout"
            : "launch_failed",
        cause: result,
      });
    }
    if (device.platform === "ios") {
      // Booting alone does not attach a serve-sim helper; the grid start
      // does both and is idempotent for a booted simulator.
      yield* HttpClientRequest.post(
        `${ready.hub.origin}${vendorPrefix("ios")}/grid/api/start`,
      ).pipe(
        HttpClientRequest.bodyJson({ udid: device.id }),
        Effect.mapError(
          (cause) =>
            new DeviceOperationError({ operation: "boot", reason: "invalid_payload", cause }),
        ),
        Effect.flatMap((request) =>
          hubJson(request, HubActionResult, "attach stream", BOOT_TIMEOUT),
        ),
      );
    }
    return result.serial ?? result.id ?? device.id;
  });

  const open: DeviceService["Service"]["open"] = Effect.fn("DeviceService.open")(
    function* (input, requestedOwner) {
      const requestId = requestedOwner?.kind === "agent" ? undefined : input.requestId;
      const owner = requestedOwner ?? { kind: "panel" as const };
      const panelSessionId =
        owner.kind === "panel" ? (owner.sessionId ?? input.sessionId) : undefined;
      const panelLeaseId = owner.kind === "panel" ? (owner.leaseId ?? input.leaseId) : undefined;
      const canReleaseRequestOwner =
        owner.kind === "panel" && panelSessionId === undefined && panelLeaseId === undefined;
      let requestState: DeviceOpenRequestState | undefined;
      if (requestId !== undefined) {
        const now = yield* Clock.currentTimeMillis;
        pruneOpenRequestCancellations(now);
        const existing = openRequests.get(requestId);
        if (existing && !openRequestMatches(existing, input)) {
          return yield* new DeviceOperationError({
            operation: "open",
            reason: "invalid_payload",
            cause: new Error("The open request ID is already bound to another target."),
          });
        }
        if (existing?.cancelled) return yield* Effect.interrupt;
        if (existing) {
          return yield* new DeviceOperationError({
            operation: "open",
            reason: "busy",
            cause: new Error("This device open request is already in progress."),
          });
        }
        requestState = {
          requestId,
          threadId: input.threadId,
          hostId: input.hostId ?? LOCAL_DEVICE_HOST_ID,
          deviceId: input.deviceId,
          canReleaseOwner: canReleaseRequestOwner,
          started: true,
          cancelled: false,
          phase: "waiting",
        };
        openRequests.set(requestId, requestState);
      }
      const ensureRequestActive = () => (requestState?.cancelled ? Effect.interrupt : Effect.void);
      const { host, ready, initialDevice, initialTarget } = yield* Effect.gen(function* () {
        yield* ensureRequestActive();
        const host = yield* resolveHost(input.hostId);
        yield* ensureRequestActive();
        yield* ensurePlatform(host, input.platform);
        yield* ensureRequestActive();
        const ready = yield* readiness(host.id);
        yield* ensureRequestActive();
        const initialState = yield* refresh(ready);
        yield* ensureRequestActive();
        const initialDevice =
          findDevice(initialState, host.id, input.deviceId) ??
          initialState.devices.find(
            (candidate) =>
              candidate.hostId === host.id &&
              deviceAliases(leaseTarget(candidate)).includes(input.deviceId),
          );
        if (!initialDevice) {
          return yield* new DeviceNotFoundError({ hostId: host.id, deviceId: input.deviceId });
        }
        const initialTarget = leaseTarget(initialDevice);
        if (requestState) requestState.target = initialTarget;
        return { host, ready, initialDevice, initialTarget };
      }).pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit) ? finishOpenRequest(requestState) : Effect.void,
        ),
      );
      const queueEntry = { ...initialDevice, threadId: input.threadId };
      const caller: DeviceLeaseCaller =
        owner.kind === "agent"
          ? {
              kind: "agent" as const,
              threadId: input.threadId,
              providerSessionId: owner.providerSessionId,
            }
          : {
              kind: "panel" as const,
              threadId: input.threadId,
              ...(panelSessionId === undefined ? {} : { sessionId: panelSessionId }),
              ...(panelLeaseId === undefined ? {} : { leaseId: panelLeaseId }),
              ...(canReleaseRequestOwner && requestId !== undefined ? { requestId } : {}),
            };
      const waiterId =
        requestId ??
        (yield* crypto.randomUUIDv4().pipe(
          Effect.map(String),
          Effect.mapError(
            (cause) =>
              new DeviceOperationError({
                operation: "open",
                reason: "request_failed",
                cause,
              }),
          ),
        ));
      let queueVisible = false;
      const markQueued = () => {
        if (queueVisible) return Effect.void;
        queueVisible = true;
        return publish((state) => ({
          ...state,
          queuedDevices: [
            ...(state.queuedDevices ?? []).filter(
              (entry) =>
                entry.hostId !== queueEntry.hostId ||
                entry.id !== queueEntry.id ||
                entry.threadId !== queueEntry.threadId,
            ),
            queueEntry,
          ],
        }));
      };

      const clearQueue = () =>
        publish((state) => ({
          ...state,
          queuedDevices: (state.queuedDevices ?? []).filter(
            (entry) =>
              entry.hostId !== queueEntry.hostId ||
              entry.id !== queueEntry.id ||
              entry.threadId !== queueEntry.threadId,
          ),
        }));
      const toDeviceSession = ({
        leaseKey: _leaseKey,
        ...session
      }: DeviceLeaseSession): DeviceSession => session;
      const saveSession = (session: DeviceSession) =>
        publish((state) => ({
          ...state,
          sessions: [
            ...state.sessions
              .filter((existing) => existing.sessionId !== session.sessionId)
              .map((existing) =>
                session.ownerKind === "agent" &&
                existing.ownerKind === "panel" &&
                existing.threadId === session.threadId &&
                existing.hostId === session.hostId &&
                existing.deviceId === session.deviceId
                  ? { ...existing, observer: true }
                  : existing,
              ),
            session,
          ],
        }));

      const cleanupProvisional = (session: DeviceLeaseSession, target: DeviceLeaseTarget) => {
        const currentTarget = target.booted
          ? Effect.succeed(target)
          : refresh(ready).pipe(
              Effect.map((state) => {
                const aliases = new Set(deviceAliases(target));
                const current = state.devices.find(
                  (device) =>
                    device.hostId === host.id &&
                    device.booted &&
                    deviceAliases(leaseTarget(device)).some((alias) => aliases.has(alias)),
                );
                return current ? leaseTarget(current) : target;
              }),
              Effect.orElseSucceed(() => target),
            );
        return currentTarget.pipe(
          Effect.flatMap((shutdownTarget) =>
            leases.abortOpen({
              key: session.leaseKey,
              sessionId: session.sessionId,
              leaseId: session.leaseId,
              target: shutdownTarget,
            }),
          ),
          Effect.flatMap((claim) =>
            claim === undefined
              ? Effect.void
              : shutdownDevice(
                  claim.target.hostId,
                  claim.target.id as DeviceId,
                  claim.target.platform,
                ).pipe(
                  Effect.tap(() => leases.finishShutdown(claim, true)),
                  Effect.catch((error) =>
                    leases
                      .finishShutdown(claim, false)
                      .pipe(
                        Effect.andThen(
                          Effect.logWarning("Could not clean up a failed device open", { error }),
                        ),
                      ),
                  ),
                ),
          ),
          Effect.andThen(
            publish((state) => ({
              ...state,
              sessions: state.sessions.filter(
                (existing) => existing.sessionId !== session.sessionId,
              ),
            })),
          ),
        );
      };

      const publishOpenedSession = (session: DeviceLeaseSession, target: DeviceLeaseTarget) =>
        sessionStateLock.withPermit(
          Effect.gen(function* () {
            yield* ensureRequestActive();
            const currentOwner: DeviceLeaseCaller =
              caller.kind === "panel"
                ? {
                    ...caller,
                    sessionId: session.sessionId,
                    leaseId: session.leaseId,
                  }
                : caller;
            const refreshed = yield* leases.acquire({
              target,
              caller: currentOwner,
              waiterId,
              shouldBoot: false,
            });
            if (refreshed._tag === "Waiting") {
              return yield* new DeviceOperationError({
                operation: "open",
                reason: "busy",
                cause: new Error("Device ownership changed while the panel was opening."),
              });
            }
            yield* ensureRequestActive();
            if (requestState?.canReleaseOwner) requestState.phase = "committed";
            const publicSession = toDeviceSession(refreshed.session);
            yield* saveSession(publicSession);
            return publicSession;
          }),
        );

      const performOpen = (
        reserved: DeviceLeaseSession,
        shouldBoot: boolean,
        created: boolean,
        deviceToOpen: DeviceSummary,
        target: DeviceLeaseTarget,
      ) => {
        let cleanupTarget = target;
        return Effect.gen(function* () {
          yield* ensureRequestActive();
          if (!created) {
            return yield* publishOpenedSession(reserved, target);
          }
          if (hosts.get(host.id) !== host) {
            return yield* new DeviceHostUnavailableError({
              hostId: host.id,
              reason: "Host configuration changed. Retry the operation.",
            });
          }
          if (!(yield* readDeviceSettings).enabled) {
            return yield* new DeviceHostUnavailableError({
              hostId: host.id,
              reason: "Device support was turned off while the device was opening.",
            });
          }
          let session = reserved;
          if (shouldBoot) {
            const booting = { ...deviceToOpen, threadId: input.threadId };
            yield* publish((state) => ({
              ...state,
              bootingDevices: [
                ...(state.bootingDevices ?? []).filter(
                  (entry) => entry.hostId !== booting.hostId || entry.id !== booting.id,
                ),
                booting,
              ],
            }));
            const bootedId = yield* boot(ready, deviceToOpen).pipe(
              Effect.ensuring(
                publish((state) => ({
                  ...state,
                  bootingDevices: (state.bootingDevices ?? []).filter(
                    (entry) => entry.hostId !== booting.hostId || entry.id !== booting.id,
                  ),
                })),
              ),
            );
            cleanupTarget = { ...target, id: bootedId, booted: true };
            if (hosts.get(host.id) !== host || !(yield* readDeviceSettings).enabled) {
              return yield* new DeviceHostUnavailableError({
                hostId: host.id,
                reason:
                  "Device support changed while the device was starting. Retry the operation.",
              });
            }
            yield* refresh(ready);
            const current = (yield* SynchronizedRef.get(stateRef)).state.devices.find(
              (device) => device.hostId === host.id && device.id === bootedId,
            ) ?? { ...deviceToOpen, id: bootedId, booted: true };
            cleanupTarget = leaseTarget(current);
            yield* ensureRequestActive();
            session = yield* leases.finishOpen({
              key: reserved.leaseKey,
              sessionId: reserved.sessionId,
              leaseId: reserved.leaseId,
              target: leaseTarget(current),
            });
          } else if (deviceToOpen.platform === "ios" && deviceToOpen.booted) {
            yield* HttpClientRequest.post(
              `${ready.hub.origin}${vendorPrefix("ios")}/grid/api/start`,
            ).pipe(
              HttpClientRequest.bodyJson({ udid: deviceToOpen.id }),
              Effect.mapError(
                (cause) =>
                  new DeviceOperationError({ operation: "open", reason: "invalid_payload", cause }),
              ),
              Effect.flatMap((request) =>
                hubJson(request, HubActionResult, "attach stream", BOOT_TIMEOUT),
              ),
            );
          }
          yield* ensureRequestActive();
          return yield* publishOpenedSession(session, target);
        }).pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit) && created
              ? cleanupProvisional(reserved, cleanupTarget)
              : Effect.void,
          ),
        );
      };

      type DeviceLeaseOpenAttempt =
        | { readonly _tag: "Waiting" }
        | { readonly _tag: "Opened"; readonly session: DeviceSession };
      const waitForLease = (remaining: number): Effect.Effect<DeviceSession, DeviceError> =>
        Effect.gen(function* () {
          yield* ensureRequestActive();
          if (hosts.get(host.id) !== host) {
            return yield* new DeviceHostUnavailableError({
              hostId: host.id,
              reason: "Host configuration changed. Retry the operation.",
            });
          }
          const enabled = yield* readDeviceSettings;
          if (!enabled.enabled) {
            return yield* new DeviceHostUnavailableError({
              hostId: host.id,
              reason: "Device support was turned off while the device was opening.",
            });
          }
          const currentState = yield* refresh(ready);
          const deviceToOpen =
            findDevice(currentState, host.id, input.deviceId) ??
            currentState.devices.find(
              (candidate) =>
                candidate.hostId === host.id &&
                deviceAliases(leaseTarget(candidate)).some((alias) =>
                  deviceAliases(initialTarget).includes(alias),
                ),
            );
          if (!deviceToOpen) {
            return yield* new DeviceNotFoundError({ hostId: host.id, deviceId: input.deviceId });
          }
          const target = leaseTarget(deviceToOpen);
          yield* ensureRequestActive();
          const result = yield* Effect.uninterruptibleMask((restore) =>
            Effect.acquireUseRelease(
              leases.acquire({
                target,
                caller,
                waiterId,
                shouldBoot: !deviceToOpen.booted && !deviceToOpen.physical && input.boot !== false,
              }),
              (acquired): Effect.Effect<DeviceLeaseOpenAttempt, DeviceError> => {
                if (acquired._tag === "Waiting") return restore(Effect.succeed(acquired));
                if (requestState) {
                  requestState.phase = acquired.created ? "opening" : "renewing";
                }
                if (requestState?.cancelled) return restore(Effect.interrupt);
                return restore(
                  performOpen(
                    acquired.session,
                    acquired.shouldBoot,
                    acquired.created,
                    deviceToOpen,
                    target,
                  ).pipe(Effect.map((session) => ({ _tag: "Opened" as const, session }))),
                );
              },
              (acquired, exit) =>
                acquired._tag === "Acquired" && acquired.created && Exit.isFailure(exit)
                  ? cleanupProvisional(acquired.session, target)
                  : Effect.void,
            ),
          );
          if (result._tag === "Opened") return result.session;
          if (requestState?.cancelled) {
            yield* leases.cancelWaiter({ target, waiterId }).pipe(Effect.ignore);
            return yield* Effect.interrupt;
          }
          yield* markQueued();
          if (remaining <= 0) {
            return yield* new DeviceOperationError({
              operation: "open",
              reason: "busy",
              cause: new Error("Another live walk still owns this device."),
            });
          }
          yield* leaseRuntime.waitForLeaseRetry?.() ?? Effect.sleep(DEVICE_LEASE_WAIT_INTERVAL);
          return yield* waitForLease(remaining - 1);
        });

      return yield* waitForLease(DEVICE_LEASE_WAIT_ATTEMPTS).pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : leases.cancelWaiter({ target: initialTarget, waiterId }).pipe(Effect.ignore),
        ),
        Effect.ensuring(clearQueue()),
        Effect.ensuring(finishOpenRequest(requestState)),
      );
    },
  );

  const publishShutdownComplete = (ready: DeviceReadiness, deviceId: DeviceId) =>
    publish((state) => ({
      ...state,
      devices: state.devices.map((device) =>
        device.hostId === ready.hostId && device.id === deviceId
          ? { ...device, booted: false }
          : device,
      ),
      sessions: state.sessions.filter(
        (session) => !(session.hostId === ready.hostId && session.deviceId === deviceId),
      ),
    })).pipe(
      Effect.asVoid,
      Effect.andThen(
        // Discovery can stall while an emulator saves its snapshot. A failed
        // refresh must not turn an accepted shutdown into an action failure.
        refresh(ready).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Device discovery unavailable after shutdown", { cause }),
          ),
        ),
      ),
    );

  const shutdownDevice = Effect.fn("DeviceService.shutdownDevice")(function* (
    hostId: DeviceHostId,
    deviceId: DeviceId,
    platform: DevicePlatform,
  ) {
    const ready = yield* readiness(hostId);
    const postShutdown = (path: string, body: Record<string, string>) =>
      HttpClientRequest.post(`${ready.hub.origin}${path}`).pipe(
        HttpClientRequest.bodyJson(body),
        Effect.mapError(
          (cause) =>
            new DeviceOperationError({ operation: "shutdown", reason: "invalid_payload", cause }),
        ),
        // The Android hub allows 30s for adb to confirm the emulator has exited.
        Effect.flatMap((request) =>
          hubJson(request, HubActionResult, "shutdown", Duration.seconds(60)),
        ),
        Effect.flatMap((result) =>
          result.ok
            ? Effect.void
            : Effect.fail(
                new DeviceOperationError({
                  operation: "shutdown",
                  reason: "hub_rejected",
                  cause: result,
                }),
              ),
        ),
      );
    // serve-sim's shutdown closes its in-process capture session before it runs
    // `simctl shutdown`; the hub's generic shutdown can leave that session cached
    // across a reboot. serve-sim runs simctl bare, though, so a simulator that is
    // already off fails there.
    yield* platform === "ios"
      ? postShutdown(`${vendorPrefix("ios")}/grid/api/shutdown`, { udid: deviceId }).pipe(
          Effect.catch((cause) =>
            fetchDevices(ready).pipe(
              Effect.flatMap(({ devices }) =>
                devices.find((device) => device.id === deviceId)?.booted === false
                  ? Effect.logInfo("iOS simulator was already shut down", { deviceId })
                  : Effect.fail(cause),
              ),
            ),
          ),
        )
      : postShutdown("/api/devices/shutdown", { platform, id: deviceId });
    yield* publishShutdownComplete(ready, deviceId);
  });

  const runShutdownClaim = (claim: DeviceLeaseShutdownClaim) => {
    const recoverAndroidAlreadyOff = (cause: DeviceError) =>
      claim.target.platform === "android"
        ? discoverTarget(claim.target).pipe(
            Effect.catch(() => Effect.succeed(undefined)),
            Effect.flatMap((discovery) =>
              discovery !== undefined &&
              discovery.detail === undefined &&
              discovery.device?.booted === false
                ? publishShutdownComplete(discovery.ready, claim.target.id as DeviceId)
                : Effect.fail(cause),
            ),
          )
        : Effect.fail(cause);

    return shutdownDevice(
      claim.target.hostId,
      claim.target.id as DeviceId,
      claim.target.platform,
    ).pipe(
      Effect.catch(recoverAndroidAlreadyOff),
      Effect.onExit((exit) => leases.finishShutdown(claim, Exit.isSuccess(exit))),
    );
  };

  const withShutdownClaims = <A, E>(
    claims: ReadonlyArray<DeviceLeaseShutdownClaim>,
    use: () => Effect.Effect<A, E>,
  ) =>
    Effect.acquireUseRelease(Effect.succeed(claims), use, (pending) =>
      Effect.forEach(
        pending,
        (claim) =>
          leases.finishShutdown(claim, false).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Could not release an unfinished device shutdown claim", {
                hostId: claim.target.hostId,
                deviceId: claim.target.id,
                cause,
              }),
            ),
          ),
        { discard: true },
      ),
    );

  const cancelOpen: DeviceService["Service"]["cancelOpen"] = Effect.fn("DeviceService.cancelOpen")(
    function* (input) {
      const now = yield* Clock.currentTimeMillis;
      pruneOpenRequestCancellations(now);
      const existing = openRequests.get(input.requestId);
      if (existing && !openRequestMatches(existing, input)) {
        return yield* new DeviceOperationError({
          operation: "open",
          reason: "invalid_payload",
          cause: new Error("The open request ID is bound to another target."),
        });
      }
      const request: DeviceOpenRequestState = existing ?? {
        requestId: input.requestId,
        threadId: input.threadId,
        hostId: input.hostId,
        deviceId: input.deviceId,
        canReleaseOwner: true,
        started: false,
        cancelled: true,
        cancelledAt: now,
        phase: "waiting",
      };
      request.cancelled = true;
      request.cancelledAt = now;
      if (!existing) {
        openRequests.set(input.requestId, request);
      }

      yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const claims = yield* sessionStateLock.withPermit(
            Effect.gen(function* () {
              if (request.target) {
                yield* leases
                  .cancelWaiter({ target: request.target, waiterId: request.requestId })
                  .pipe(
                    Effect.tapError((cause) =>
                      Effect.logWarning("Could not remove a cancelled device waiter", { cause }),
                    ),
                    Effect.ignore,
                  );
              }
              const canRelease = request.canReleaseOwner && request.phase !== "opening";
              const claims = canRelease
                ? yield* leases.release({
                    threadId: request.threadId,
                    hostId: request.hostId,
                    deviceId: request.deviceId,
                    requestId: request.requestId,
                    caller: { kind: "panel", threadId: request.threadId },
                  })
                : [];
              yield* publish((state) => ({
                ...state,
                sessions: request.canReleaseOwner
                  ? state.sessions.filter((session) => session.requestId !== request.requestId)
                  : state.sessions,
              }));
              return claims;
            }),
          );
          yield* withShutdownClaims(claims, () =>
            Effect.forEach(claims, (claim) => restore(runShutdownClaim(claim)), {
              discard: true,
            }),
          );
        }),
      );
    },
  );

  const close: DeviceService["Service"]["close"] = Effect.fn("DeviceService.close")(
    function* (input, requestedCaller) {
      if (input.sessionId !== undefined && input.leaseId === undefined) {
        return yield* new DeviceOperationError({
          operation: "close",
          reason: "stale_session",
          cause: new Error("Both sessionId and leaseId are required for exact release."),
        });
      }
      const caller =
        requestedCaller === undefined
          ? undefined
          : {
              kind: requestedCaller.kind,
              threadId: input.threadId,
              ...(requestedCaller.kind === "agent"
                ? { providerSessionId: requestedCaller.providerSessionId }
                : {}),
              ...(requestedCaller.kind === "panel" && requestedCaller.sessionId !== undefined
                ? { sessionId: requestedCaller.sessionId }
                : {}),
              ...(requestedCaller.kind === "panel" && requestedCaller.leaseId !== undefined
                ? { leaseId: requestedCaller.leaseId }
                : {}),
            };
      const ownerKind = requestedCaller?.kind ?? "panel";
      yield* Effect.uninterruptibleMask((restore) =>
        leases
          .release({
            threadId: input.threadId,
            ...(input.hostId === undefined ? {} : { hostId: input.hostId }),
            ...(input.deviceId === undefined ? {} : { deviceId: input.deviceId }),
            ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
            ...(input.leaseId === undefined ? {} : { leaseId: input.leaseId }),
            ...(caller === undefined ? {} : { caller }),
            ...(input.shutdown === undefined ? {} : { shutdown: input.shutdown }),
          })
          .pipe(
            Effect.flatMap((claims) =>
              withShutdownClaims(claims, () =>
                Effect.gen(function* () {
                  yield* publish((state) => ({
                    ...state,
                    sessions: state.sessions.filter((session) => {
                      if (input.sessionId !== undefined) {
                        return (
                          session.sessionId !== input.sessionId || session.leaseId !== input.leaseId
                        );
                      }
                      return (
                        session.threadId !== input.threadId ||
                        (input.hostId !== undefined && session.hostId !== input.hostId) ||
                        (input.deviceId !== undefined && session.deviceId !== input.deviceId) ||
                        session.ownerKind !== ownerKind ||
                        (requestedCaller?.kind === "agent" &&
                          session.providerSessionId !== requestedCaller.providerSessionId)
                      );
                    }),
                  }));
                  for (const claim of claims) yield* restore(runShutdownClaim(claim));
                }),
              ),
            ),
          ),
      );
    },
  );

  const shutdown: DeviceService["Service"]["shutdown"] = Effect.fn("DeviceService.shutdown")(
    function* (input) {
      const host = yield* resolveHost(input.hostId);
      const { device } = yield* resolveDevice(host.id, input.deviceId);
      if (device.platform !== input.platform) {
        return yield* new DeviceOperationError({
          operation: "shutdown",
          reason: "invalid_payload",
          cause: new Error("The requested platform does not match the device."),
        });
      }
      const leaseId = yield* crypto.randomUUIDv4().pipe(
        Effect.map(String),
        Effect.mapError(
          (cause) =>
            new DeviceOperationError({ operation: "shutdown", reason: "request_failed", cause }),
        ),
      );
      yield* Effect.uninterruptibleMask((restore) =>
        deviceJanitor
          .prepareExplicitShutdown({
            target: leaseTarget(device),
            leaseId,
          })
          .pipe(
            Effect.flatMap((claim) =>
              withShutdownClaims([claim], () => restore(runShutdownClaim(claim))),
            ),
          ),
      );
      yield* publish((state) => ({
        ...state,
        sessions: state.sessions.filter(
          (session) => !(session.hostId === host.id && session.deviceId === input.deviceId),
        ),
      }));
    },
  );

  const sweepIdleDevices = Effect.fn("DeviceService.sweepIdleDevices")(function* () {
    const reported = new Set<string>();
    yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        while (true) {
          const items = yield* deviceJanitor.planIdleCleanup({ apply: true });
          const pending = items.find((item) => item.claim !== undefined);
          for (const item of items) {
            if (item.reason === undefined) continue;
            const key = `${item.hostId}\u0000${item.deviceId}\u0000${item.reason}`;
            if (reported.has(key)) continue;
            reported.add(key);
            yield* Effect.logInfo("Device janitor skipped a lease", {
              hostId: item.hostId,
              deviceId: item.deviceId,
              reason: item.reason,
            });
          }
          if (!pending?.claim) return;
          const claim = pending.claim;
          const succeeded = yield* withShutdownClaims([claim], () =>
            restore(runShutdownClaim(claim)).pipe(
              Effect.as(true),
              Effect.catch((cause) =>
                Effect.logWarning("Device idle cleanup left the device for the next sweep", {
                  hostId: pending.hostId,
                  deviceId: pending.deviceId,
                  cause,
                }).pipe(Effect.as(false)),
              ),
            ),
          );
          if (!succeeded) return;
        }
      }),
    );
  });

  const janitor: DeviceService["Service"]["janitor"] = Effect.fn("DeviceService.janitor")(
    function* (input) {
      return yield* Effect.uninterruptibleMask((restore) =>
        deviceJanitor.planIdleCleanup(input).pipe(
          Effect.flatMap((items) => {
            if (items.length === 0) {
              return Effect.succeed([
                {
                  hostId: input.hostId,
                  deviceId: input.deviceId,
                  status: "skipped" as const,
                  reason: "not_found" as const,
                },
              ]);
            }
            const claims = items.flatMap((item) => (item.claim === undefined ? [] : [item.claim]));
            return withShutdownClaims(claims, () =>
              Effect.forEach(items, (item) =>
                item.claim === undefined
                  ? Effect.succeed(item)
                  : restore(runShutdownClaim(item.claim)).pipe(
                      Effect.as({
                        hostId: item.hostId,
                        deviceId: item.deviceId,
                        status: "shutdown" as const,
                      }),
                    ),
              ),
            );
          }),
        ),
      );
    },
  );

  if (leaseRuntime.automaticCleanup !== false) {
    yield* Effect.forever(
      Effect.sleep(DEVICE_CLEANUP_INTERVAL).pipe(Effect.andThen(sweepIdleDevices)),
    ).pipe(Effect.forkScoped);
  }

  const screenshot: DeviceService["Service"]["screenshot"] = Effect.fn("DeviceService.screenshot")(
    function* (input) {
      const { ready, device } = yield* resolveDevice(input.hostId, input.deviceId);
      const url = `${ready.hub.origin}${vendorPrefix(device.platform)}/api/screenshot?device=${encodeURIComponent(device.id)}`;
      const png = yield* httpClient.execute(HttpClientRequest.post(url)).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.arrayBuffer),
        Effect.map((buffer) => new Uint8Array(buffer)),
        Effect.scoped,
        Effect.timeout(SCREENSHOT_TIMEOUT),
        Effect.mapError(
          (cause) =>
            new DeviceOperationError({
              operation: "screenshot",
              reason: "request_failed",
              cause,
            }),
        ),
      );
      return { device, png };
    },
  );

  const resolveDevice = Effect.fn("DeviceService.resolveDevice")(function* (
    hostId: DeviceHostId | undefined,
    deviceId: DeviceId,
  ) {
    const host = yield* resolveHost(hostId);
    const ready = yield* readiness(host.id);
    const { state } = yield* SynchronizedRef.get(stateRef);
    const device =
      findDevice(state, host.id, deviceId) ?? findDevice(yield* refresh(ready), host.id, deviceId);
    if (!device) return yield* new DeviceNotFoundError({ hostId: host.id, deviceId });
    return { ready, device };
  });

  const detail: DeviceService["Service"]["detail"] = Effect.fn("DeviceService.detail")(
    function* (input) {
      const { ready, device } = yield* resolveDevice(input.hostId, input.deviceId);
      const read = yield* readDeviceDetail(ready, device.platform, device.id);
      return {
        hostId: ready.hostId,
        deviceId: device.id,
        settings: read.settings,
        foregroundApp: read.foregroundApp,
        readAt: DateTime.formatIso(yield* DateTime.now),
      };
    },
  );

  const action: DeviceService["Service"]["action"] = Effect.fn("DeviceService.action")(
    function* (input) {
      const { ready, device } = yield* resolveDevice(input.hostId, input.deviceId);
      yield* runDeviceAction(ready, device.platform, input);
      return yield* detail({ hostId: ready.hostId, deviceId: device.id });
    },
  );

  const sessionsForThread: DeviceService["Service"]["sessionsForThread"] = (threadId) =>
    SynchronizedRef.get(stateRef).pipe(
      Effect.map(({ state }) => state.sessions.filter((session) => session.threadId === threadId)),
    );

  return {
    ...DeviceService.of({
      testHost,
      updateTool: (tool) =>
        lifecycleLock.withPermit(
          Effect.gen(function* () {
            if (!installTool)
              return yield* new DeviceOperationError({
                operation: "update device tool",
                reason: "request_failed",
                cause: new Error("Tool installation is unavailable in this device service."),
              });
            yield* installTool(tool);
            return yield* inspect;
          }),
        ),
      retryHost,
      inspect,
      agentCli: Effect.fail(
        new DeviceHostUnavailableError({
          hostId: LOCAL_DEVICE_HOST_ID,
          reason: "Agent CLI installation is unavailable in this device service.",
        }),
      ),
      agentTarget: (input) =>
        Effect.gen(function* () {
          if (!agentSessionFor((yield* SynchronizedRef.get(stateRef)).state, input))
            return yield* staleAgentTarget();
          const host = yield* resolveHost(input.hostId);
          const ready = yield* agentReadinessIfSupported(input.hostId);
          if (!ready)
            return yield* new DeviceHostUnavailableError({
              hostId: input.hostId,
              reason:
                "Agent device access requires enabled device support, agent access, and an available simulator platform on this host.",
            });
          const target = yield* lifecycleLock.withPermit(
            SynchronizedRef.modifyEffect(stateRef, ({ state }) => {
              if (hosts.get(host.id) !== host)
                return Effect.fail(
                  new DeviceHostUnavailableError({
                    hostId: host.id,
                    reason: "Host configuration changed. Retry the operation.",
                  }),
                );
              const session = agentSessionFor(state, input);
              if (!session) return Effect.fail(staleAgentTarget());
              const latestReady = latestAgentReadyByHost.get(host) ?? ready;
              return configureAgent(input.hostId, latestReady, session).pipe(
                Effect.map((configPath) => [{ configPath, session }, { state }] as const),
              );
            }),
          );
          return {
            args: ["--config", target.configPath, "--session", target.session.sessionId],
            sessionId: target.session.sessionId,
          };
        }),
      state: SynchronizedRef.get(stateRef).pipe(Effect.map(({ state }) => state)),
      subscribe: PubSub.subscribe(statePubSub),
      configure,
      list,
      open,
      cancelOpen,
      close,
      shutdown,
      janitor,
      detail,
      action,
      screenshot,
      readiness,
      readinessIfSupported,
      agentReadinessIfSupported,
      currentReadiness,
      sessionsForThread,
    }),
    setHostStatus,
    withLifecycleLock: lifecycleLock.withPermit,
    refreshAgentEndpoints,
    refreshHosts: Effect.gen(function* () {
      const summaries = yield* Effect.forEach(hosts.values(), (host) => host.summary);
      const unchanged = (id: DeviceHostId) =>
        hosts.has(id) && hosts.get(id) === publishedHosts.get(id);
      yield* publish((state) => ({
        ...state,
        hosts: summaries,
        hostStatuses: Object.fromEntries(
          Object.entries(state.hostStatuses).filter(([id]) => unchanged(id)),
        ),
        devices: state.devices.filter((device) => unchanged(device.hostId)),
        sessions: state.sessions.filter((session) => unchanged(session.hostId)),
      }));
      publishedHosts = new Map(hosts);
    }),
  };
});

/** @public */
/** @public Service construction is part of the canonical Effect module API. */
export const make = (
  options: {
    readonly automaticCleanup?: boolean;
    readonly waitForLeaseRetry?: () => Effect.Effect<void>;
  } = {},
) =>
  Effect.gen(function* () {
    const localHost = yield* DeviceHost.DeviceHost;
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runner = yield* ProcessRunner.ProcessRunner;
    const settings = yield* ServerSettings.ServerSettingsService;
    const agentLiveness = yield* DeviceAgentLiveness.DeviceAgentLiveness;
    const agentDeviceProxyRegistry = yield* AgentDeviceProxyRegistry.AgentDeviceProxyRegistry;
    const httpServer = yield* HttpServer.HttpServer;
    const scope = yield* Scope.Scope;
    const hosts = new Map<DeviceHostId, DeviceHost.DeviceHost["Service"]>([
      [localHost.id, localHost],
    ]);
    const crypto = yield* Crypto.Crypto;
    const configDir = (hostId: DeviceHostId) =>
      agentDeviceConfigDir(config.stateDir, hostId, path).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
      );
    const configureAgent = (
      hostId: DeviceHostId,
      ready: DeviceHost.DeviceHostAgentReady,
      session: AgentDeviceSession,
    ) => {
      if (session.hostId !== hostId) return Effect.fail(staleAgentTarget());
      return configureAgentDeviceSession({
        stateDir: config.stateDir,
        serverAddress: httpServer.address,
        session,
        endpoint: ready.agentDevice,
      }).pipe(
        Effect.provideService(
          AgentDeviceProxyRegistry.AgentDeviceProxyRegistry,
          agentDeviceProxyRegistry,
        ),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.mapError(
          (cause) =>
            new DeviceOperationError({
              operation: "configure agent",
              reason: "settings_failed",
              cause,
            }),
        ),
      );
    };
    const refreshAgent = (
      hostId: DeviceHostId,
      ready: DeviceHost.DeviceHostAgentReady,
      session: AgentDeviceSession,
    ) => {
      if (session.hostId !== hostId) return Effect.void;
      return refreshAgentDeviceSession({
        serverAddress: httpServer.address,
        session,
        endpoint: ready.agentDevice,
      }).pipe(
        Effect.asVoid,
        Effect.provideService(
          AgentDeviceProxyRegistry.AgentDeviceProxyRegistry,
          agentDeviceProxyRegistry,
        ),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.mapError(
          (cause) =>
            new DeviceOperationError({
              operation: "refresh agent endpoint",
              reason: "settings_failed",
              cause,
            }),
        ),
      );
    };
    const probeContext =
      yield* Effect.context<Effect.Services<ReturnType<typeof SshDeviceHost.probe>>>();
    const localTargetContext =
      yield* Effect.context<Effect.Services<ReturnType<typeof isLocalSshDeviceHost>>>();
    const serviceWithAgentRefresh = yield* makeWithHosts(
      hosts,
      (host) =>
        Effect.gen(function* () {
          if (yield* isLocalSshDeviceHost(host).pipe(Effect.provide(localTargetContext))) {
            return yield* localHost.summary;
          }
          return yield* SshDeviceHost.probe(host).pipe(Effect.provide(probeContext));
        }).pipe(
          Effect.mapError(
            (error) =>
              new DeviceOperationError({
                operation: "probe host",
                reason: "request_failed",
                cause: error,
              }),
          ),
        ),
      configureAgent,
      (tool) =>
        (tool === "hub" ? ensureDeviceHub(config.baseDir) : ensureAgentDevice(config.baseDir)).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.provideService(ProcessRunner.ProcessRunner, runner),
          Effect.mapError(
            (cause) =>
              new DeviceOperationError({
                operation: "update device tool",
                reason: "command_failed",
                cause,
              }),
          ),
        ),
      {
        store: makeFileDeviceLeaseStore(deviceLeaseDirectory(yield* HostProcess.HomeDirectory)),
        isProviderSessionLive: agentLiveness.isLive,
        ...(options.automaticCleanup === undefined
          ? {}
          : { automaticCleanup: options.automaticCleanup }),
        ...(options.waitForLeaseRetry === undefined
          ? {}
          : { waitForLeaseRetry: options.waitForLeaseRetry }),
      },
      refreshAgent,
    );
    const { refreshAgentEndpoints, ...service } = serviceWithAgentRefresh;
    const hostContext =
      yield* Effect.context<Effect.Services<ReturnType<typeof SshDeviceHost.make>>>();
    const configured = new Map<string, { config: SshDeviceHostConfig; scope: Scope.Closeable }>();
    const reconcile = (configuredHosts: ReadonlyArray<SshDeviceHostConfig>) =>
      Effect.gen(function* () {
        const next = yield* remoteSshDeviceHosts(configuredHosts).pipe(
          Effect.provide(localTargetContext),
        );
        const removed = yield* service.withLifecycleLock(
          Effect.gen(function* () {
            const removed: Array<{ id: string; scope: Scope.Closeable }> = [];
            for (const [id, previous] of configured) {
              if (
                next.some(
                  (host) =>
                    host.id === id &&
                    host.label === previous.config.label &&
                    host.target === previous.config.target &&
                    host.port === previous.config.port &&
                    host.identityFile === previous.config.identityFile,
                )
              )
                continue;
              hosts.delete(id);
              configured.delete(id);
              removed.push({ id, scope: previous.scope });
            }
            if (removed.length > 0) yield* service.refreshHosts;
            return removed;
          }),
        );
        // Stop old writers before deleting config files or publishing replacements, without blocking healthy hosts.
        yield* Effect.forEach(
          removed,
          ({ id, scope }) =>
            Effect.gen(function* () {
              yield* Scope.close(scope, Exit.void);
              yield* fs
                .remove(yield* configDir(id), { force: true, recursive: true })
                .pipe(Effect.ignore);
            }),
          { concurrency: 4, discard: true },
        );
        yield* service.withLifecycleLock(
          Effect.gen(function* () {
            let added = false;
            for (const host of next) {
              if (configured.has(host.id)) continue;
              added = true;
              const hostScope = yield* Scope.fork(scope);
              let instance: DeviceHost.DeviceHost["Service"] | undefined;
              instance = yield* SshDeviceHost.make(
                host,
                (ready) =>
                  instance === undefined
                    ? Effect.void
                    : refreshAgentEndpoints(instance, ready).pipe(
                        Effect.asVoid,
                        Effect.mapError(
                          (error) =>
                            new DeviceHost.DeviceHostError({
                              hostId: host.id,
                              step: "configuring agent access",
                              cause: error,
                            }),
                        ),
                      ),
                (status, detail) =>
                  service
                    .setHostStatus(host.id, { status, ...(detail ? { detail } : {}) })
                    .pipe(Effect.asVoid),
              ).pipe(Effect.provideService(Scope.Scope, hostScope), Effect.provide(hostContext));
              hosts.set(host.id, instance);
              configured.set(host.id, { config: host, scope: hostScope });
            }
            // Refresh again after removed scopes closed so a late status write from an old host cannot linger.
            if (added || removed.length > 0) yield* service.refreshHosts;
          }),
        );
      });
    const changes = yield* settings.subscribeChanges;
    yield* reconcile((yield* settings.getSettings).deviceHosts);
    yield* changes.pipe(
      Stream.runForEach((value) => reconcile(value.deviceHosts)),
      Effect.forkIn(scope),
    );
    yield* Effect.addFinalizer(() =>
      Effect.forEach(configured.values(), (value) => Scope.close(value.scope, Exit.void), {
        discard: true,
        concurrency: 4,
      }),
    );
    return {
      ...service,
      agentCli: resolveNodeExecutable("Device automation").pipe(
        Effect.andThen(ensureAgentDevice(config.baseDir)),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ProcessRunner.ProcessRunner, runner),
        Effect.map((tool) => tool.entryPath),
        Effect.mapError((error) =>
          error._tag === "NodeRuntimeUnavailableError"
            ? new DeviceHostUnavailableError({
                hostId: LOCAL_DEVICE_HOST_ID,
                reason: nodeRuntimeUnavailableMessage("Device automation"),
                cause: error,
              })
            : new DeviceOperationError({
                operation: "install agent CLI",
                reason: "command_failed",
                cause: error,
              }),
        ),
      ),
    };
  });

export const layer = Layer.effect(DeviceService, make()).pipe(Layer.provide(LocalDeviceHost.layer));

const makeForJanitor = Effect.gen(function* () {
  const localHost = yield* DeviceHost.DeviceHost;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  return yield* makeWithHosts(
    new Map([[localHost.id, localHost]]),
    undefined,
    undefined,
    undefined,
    {
      store: makeFileDeviceLeaseStore(deviceLeaseDirectory(homeDirectory)),
      automaticCleanup: false,
    },
  );
});

export const maintenanceLayer = Layer.effect(DeviceService, makeForJanitor).pipe(
  Layer.provide(LocalDeviceHost.layer),
);

export const stateStream = (service: DeviceService["Service"]): Stream.Stream<DeviceServiceState> =>
  Stream.unwrap(
    Effect.gen(function* () {
      // Subscribe before reading the snapshot so no change between the two
      // is lost; the scope lives as long as the stream does.
      const subscription = yield* service.subscribe;
      const initial = yield* service.state;
      return Stream.concat(Stream.make(initial), Stream.fromSubscription(subscription));
    }),
  ).pipe(Stream.scoped);

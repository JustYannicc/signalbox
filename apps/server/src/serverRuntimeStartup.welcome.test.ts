import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { DEFAULT_SIGNAL_EXPORT } from "@t3tools/shared/observability";
import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ServiceLauncherClient from "./cloud/serviceLauncherClient.ts";
import * as ServerConfig from "./config.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as Keybindings from "./keybindings.ts";
import * as EffectWorker from "./orchestration-v2/EffectWorker.ts";
import * as LegacyV1ThreadImporter from "./orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as ProviderRuntimeRecovery from "./orchestration-v2/ProviderRuntimeRecoveryService.ts";
import * as ProviderSessionManager from "./orchestration-v2/ProviderSessionManager.ts";
import * as ThreadLaunch from "./orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as ProjectService from "./project/ProjectService.ts";
import * as AgentAwarenessRelay from "./relay/AgentAwarenessRelay.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";

it.effect("keeps startup ready when automatic welcome thread creation needs a model choice", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = "/welcome-project";
      const projectId = ProjectId.make("welcome-project");
      const updatedAt = "2026-01-01T00:00:00.000Z";
      const project = {
        id: projectId,
        title: "Welcome project",
        workspaceRoot: cwd,
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
        createdAt: updatedAt,
        updatedAt,
        deletedAt: null,
      };
      const snapshot = { projects: [project], updatedAt };
      const recovery = {
        terminalizedRuns: 0,
        stoppedSessions: 0,
        closedRequests: 0,
        retiredEffects: 0,
        requeuedEffects: 0,
      };
      const importSummary = { importedThreadCount: 0, importedMessageCount: 0 };
      const launchCalls = yield* Ref.make(0);
      const readyPublished = yield* Deferred.make<void>();
      const publishedEvents = yield* Ref.make<
        ReadonlyArray<{ readonly type: string; readonly payload: unknown }>
      >([]);
      const dependencies: Layer.Layer<
        Layer.Services<ReturnType<typeof ServerRuntimeStartup.layerWithOptions>>
      > = Layer.mergeAll(
        Layer.mock(ServerConfig.ServerConfig)({
          ...(yield* ServerConfig.deriveServerPaths(cwd, undefined).pipe(
            Effect.provide(Path.layer),
          )),
          baseDir: cwd,
          logLevel: "Error",
          traceMinLevel: "Info",
          traceTimingEnabled: false,
          traceBatchWindowMs: 200,
          traceMaxBytes: 1024,
          traceMaxFiles: 1,
          otlpTracesUrl: undefined,
          otlpMetricsUrl: undefined,
          otlpLogsUrl: undefined,
          otlpTracesExport: DEFAULT_SIGNAL_EXPORT,
          otlpMetricsExport: DEFAULT_SIGNAL_EXPORT,
          otlpLogsExport: DEFAULT_SIGNAL_EXPORT,
          otelEnvironment: OtelEnvironment.none,
          staticDir: undefined,
          devAllowedOrigins: [],
          desktopBootstrapToken: undefined,
          logWebSocketEvents: false,
          tailscaleServeEnabled: false,
          tailscaleServePort: 443,
          mode: "desktop",
          cwd,
          host: "localhost",
          port: 3773,
          devUrl: undefined,
          noBrowser: true,
          startupPresentation: "browser",
          autoBootstrapProjectFromCwd: true,
        }),
        Layer.mock(Keybindings.Keybindings)({ start: Effect.void }),
        Layer.mock(LegacyV1ThreadImporter.LegacyV1ThreadImporter)({
          pendingThreadCount: Effect.succeed(0),
          reconcileShells: Effect.succeed(importSummary),
          importPendingTranscripts: Effect.succeed(importSummary),
        }),
        Layer.mock(ProviderRuntimeRecovery.ProviderRuntimeRecoveryService)({
          recover: Effect.succeed(recovery),
          prepareForShutdown: Effect.void,
          reconcile: () => Effect.succeed(recovery),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({ recoverDelegatedTasks: Effect.void }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({ shutdown: Effect.void }),
        Layer.mock(AgentAwarenessRelay.AgentAwarenessRelay)({ start: () => Effect.void }),
        Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({ runOnce: Effect.never }),
        Layer.mock(ServerLifecycleEvents.ServerLifecycleEvents)({
          publish: (event) =>
            Ref.update(publishedEvents, (events) => [...events, event]).pipe(
              Effect.andThen(
                event.type === "ready" ? Deferred.succeed(readyPublished, undefined) : Effect.void,
              ),
              Effect.as({ ...event, sequence: 1 }),
            ),
        }),
        Layer.mock(ServerSettings.ServerSettingsService)({
          start: Effect.void,
          getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        }),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getDescriptor: Effect.succeed({
            environmentId: EnvironmentId.make("welcome-environment"),
            label: "Test environment",
            platform: { os: "darwin", arch: "arm64" },
            serverVersion: "0.0.0-test",
            capabilities: { repositoryIdentity: true },
          }),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          listShells: () => Effect.succeed(snapshot.projects),
        }),
        Layer.mock(ProjectService.ProjectService)({
          bootstrap: () => Effect.succeed({ project, created: true }),
          snapshot: Effect.succeed(snapshot),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getShellSnapshot: () =>
            Effect.succeed({
              schemaVersion: 1,
              snapshotSequence: 0,
              threads: [],
              archivedThreads: [],
            }),
        }),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({
          launch: (input) =>
            Ref.update(launchCalls, (count) => count + 1).pipe(
              Effect.andThen(
                Effect.fail(
                  new ThreadLaunch.ThreadLaunchError({
                    operation: "resolve-model",
                    commandId: input.commandId,
                    projectId: input.projectId,
                    cause: new Error("No model is available."),
                  }),
                ),
              ),
            ),
        }),
        Layer.mock(ServiceLauncherClient.ServiceLauncherClient)({
          managed: true,
          prepareTrial: Effect.succeed(undefined),
        }),
        Layer.mock(GitVcsDriver.GitVcsDriver)({}),
        Layer.mock(AnalyticsService.AnalyticsService)({ record: () => Effect.void }),
        NodeCrypto.layer,
        Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
        Layer.mock(ExternalLauncher.ExternalLauncher)({}),
        Layer.mock(HttpServer.HttpServer)({
          address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 3773),
        }),
        Path.layer,
      );

      yield* Effect.gen(function* () {
        const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
        yield* startup.markHttpListening;
        yield* startup.awaitCommandReady;
        yield* Deferred.await(readyPublished);

        expect(yield* Ref.get(launchCalls)).toBe(1);
        const events = yield* Ref.get(publishedEvents);
        expect(events.map((event) => event.type)).toContain("welcome");
        expect(events.map((event) => event.type)).toContain("ready");
        const welcome = events.find((event) => event.type === "welcome")?.payload;
        expect(welcome).toMatchObject({ bootstrapProjectId: projectId });
        expect(welcome).not.toHaveProperty("bootstrapThreadId");
      }).pipe(
        Effect.provide(
          ServerRuntimeStartup.layerWithOptions({
            awaitAuxiliaryParked: Effect.void,
          }).pipe(Layer.provide(dependencies)),
        ),
      );
    }),
  ),
);

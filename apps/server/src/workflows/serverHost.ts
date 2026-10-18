import {
  ProjectId,
  type AutomationError,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import { setThreadMonitorSource } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { createFsDrain } from "evlog/fs";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { ServerConfig } from "../config.ts";
import { ThreadLaunchService } from "../orchestration-v2/ThreadLaunchService.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../processRunner.ts";
import { ProjectService } from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import {
  ScheduledTaskWebhookOrigin,
  type WebhookTriggerRequest,
  type WebhookTriggerResult,
} from "../scheduledTasks/ScheduledTaskService.ts";
import { Scheduler } from "../scheduling/Scheduler.ts";
import { ServerActivation } from "../serverActivation.ts";
import { makeCallbacks } from "./callbacks.ts";
import * as ProjectAutomations from "./ProjectAutomations.ts";
import { compileWorkflow } from "@signalbox/automation-compiler/compileWorkflow";
import { automationError, fail } from "@signalbox/automations/errors";
import * as ExecutorSettings from "./executorSettings.ts";
import {
  AutomationActivation,
  AutomationCompiler,
  AutomationFunctions,
  AutomationIngress,
  AutomationModels,
  AutomationRunLogSink,
  AutomationThreads,
  type ThreadMonitor,
} from "@signalbox/automations/host";
import { setPullRequestWatchHandler } from "./pullRequestWatchHook.ts";
import { makeRunFunction } from "./runFunction.ts";
import { makeWebhooks } from "./webhooks.ts";
import * as WorkflowEngine from "@signalbox/automations/WorkflowEngine";

/**
 * The automation engine on a self-hosted server: host.ts's services from the
 * server's threads, processes, compiler and files, and the engine's tick on
 * the server's scheduler.
 */

const LOG_FILES = 14;
const LOG_FILE_BYTES = 10 * 1024 * 1024;

const hostError = (message: string) => (cause: { readonly message: string }) =>
  automationError(message ? `${message}: ${cause.message}` : cause.message, { cause });

const layerThreads = Layer.effect(
  AutomationThreads,
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService;
    const launcher = yield* ThreadLaunchService;
    // Upstream's pending background work pulls attached runs from here when it reads a shell.
    const monitors = new Map<string, ReadonlyArray<ThreadMonitor>>();
    setThreadMonitorSource((threadId) =>
      (monitors.get(threadId) ?? []).map((monitor) => ({ ...monitor, kind: "monitor" as const })),
    );
    return AutomationThreads.of({
      getThreadShell: (threadId) =>
        threads.getThreadShell(threadId).pipe(Effect.mapError(hostError(""))),
      getThreadRecords: (threadId, fields, filter) =>
        threads.getThreadRecords(threadId, fields, filter).pipe(Effect.mapError(hostError(""))),
      initialModelSelection: (projectId) =>
        launcher.initialModelSelection(projectId).pipe(Effect.mapError(hostError(""))),
      launch: (input) =>
        launcher
          .launch({
            commandId: input.commandId,
            projectId: input.projectId,
            title: input.title,
            generateTitle: false,
            modelSelection: input.modelSelection,
            runtimeMode: input.runtimeMode,
            interactionMode: input.interactionMode,
            workspaceStrategy: input.workspace,
            initialMessage: { ...input.message, attachments: [] },
            createdBy: "system",
            creationSource: "server",
          })
          .pipe(
            Effect.map(({ threadId }) => ({ threadId })),
            Effect.mapError(hostError("")),
          ),
      send: (input) =>
        threads.sendToThread({ ...input, mode: "queue" }).pipe(
          Effect.map(({ run }) => ({ run })),
          Effect.mapError(hostError("")),
        ),
      interrupt: (input) =>
        threads.interruptThread(input).pipe(Effect.asVoid, Effect.mapError(hostError(""))),
      settle: (input) =>
        threads
          .dispatch({ type: "thread.settle", ...input } satisfies OrchestrationV2ServerCommand)
          .pipe(Effect.asVoid, Effect.mapError(hostError(""))),
      domainEvents: threads.streamDomainEvents.pipe(Stream.mapError(hostError(""))),
      monitorsChanged: (threadId, next) =>
        Effect.sync(() => {
          if (next.length === 0) monitors.delete(threadId);
          else monitors.set(threadId, next);
        }),
    });
  }),
);

const layerFunctions = Layer.effect(
  AutomationFunctions,
  Effect.gen(function* () {
    const runFunction = yield* makeRunFunction;
    const projects = yield* ProjectService;
    return AutomationFunctions.of({
      run: ({ projectId, ...input }) =>
        Effect.gen(function* () {
          const project = yield* projects
            .getById(ProjectId.make(projectId))
            .pipe(
              Effect.mapError((cause) => automationError("Couldn't read the project.", { cause })),
            );
          if (Option.isNone(project)) return yield* fail("This automation's project is gone.");
          return yield* runFunction.run({ ...input, cwd: project.value.workspaceRoot });
        }),
      remove: (automationId) =>
        runFunction
          .remove(automationId)
          .pipe(Effect.mapError(hostError("Couldn't delete the automation's files"))),
      prune: (automationId, keep) =>
        runFunction
          .prune(automationId, keep)
          .pipe(Effect.mapError(hostError("Couldn't delete old automation versions"))),
    });
  }),
).pipe(Layer.provide(ProcessRunner.layer));

/** Each run's wide event as NDJSON under `<stateDir>/logs/automations/`, pretty in dev. */
const layerRunLogSink = Layer.effect(
  AutomationRunLogSink,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const path = yield* Path.Path;
    return AutomationRunLogSink.of({
      pretty: config.devUrl !== undefined,
      drain: createFsDrain({
        dir: path.join(config.stateDir, "logs", "automations"),
        maxFiles: LOG_FILES,
        maxSizePerFile: LOG_FILE_BYTES,
        pretty: false,
      }),
    });
  }),
);

/** Model option names from the provider catalog, when the server has one (tests don't). */
const layerModels = Layer.effectContext(
  Effect.gen(function* () {
    const registry = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
    if (Option.isNone(registry)) return Context.empty();
    return Context.make(
      AutomationModels,
      AutomationModels.of({
        effortOption: (instanceId, model) =>
          registry.value.getProviders.pipe(
            Effect.map((providers) => {
              const descriptors =
                providers
                  .find((provider) => provider.instanceId === instanceId)
                  ?.models.find((candidate) => candidate.slug === model)?.capabilities
                  ?.optionDescriptors ?? [];
              const descriptor = descriptors.find(
                (candidate) => candidate.type === "select" && /effort/i.test(candidate.id),
              );
              if (descriptor?.type !== "select") return null;
              return {
                id: descriptor.id,
                values: descriptor.options.map((option) => option.id),
              };
            }),
          ),
      }),
    );
  }),
);

/** Requests to `automation_…` and `callback_…` hooks, for upstream's webhook route (see http.ts). */
export class AutomationHooks extends Context.Service<
  AutomationHooks,
  {
    readonly receiveWebhook: (
      request: WebhookTriggerRequest,
    ) => Effect.Effect<WebhookTriggerResult, AutomationError>;
    readonly receiveCallback: (
      request: WebhookTriggerRequest,
    ) => Effect.Effect<WebhookTriggerResult, AutomationError>;
  }
>()("t3/workflows/serverHost/AutomationHooks") {}

/**
 * Webhooks and callback links ride upstream's webhook route (see webhooks.ts
 * and callbacks.ts). The engine builds them once its run core exists; the
 * route waits for that.
 */
const layerIngress = Layer.effectContext(
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const origin = yield* ScheduledTaskWebhookOrigin;
    const hookBaseUrl = origin.pipe(Effect.map((value) => value.relayHookBaseUrl));
    const built = yield* Deferred.make<{
      readonly webhooks: Effect.Success<ReturnType<typeof makeWebhooks>>;
      readonly callbacks: ReturnType<typeof makeCallbacks>;
    }>();
    const ingress = AutomationIngress.of({
      make: (deps) =>
        Effect.gen(function* () {
          const webhooks = yield* makeWebhooks(deps).pipe(
            Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
          );
          const callbacks = makeCallbacks({ ...deps, relayHookBaseUrl: hookBaseUrl });
          yield* Deferred.succeed(built, { webhooks, callbacks });
          return {
            hookBaseUrl,
            createCallback: callbacks.create,
            runEnded: callbacks.ended,
            forget: webhooks.forget,
            setSecret: webhooks.setSecret,
          };
        }),
    });
    const hooks = AutomationHooks.of({
      receiveWebhook: (request) =>
        Deferred.await(built).pipe(Effect.flatMap(({ webhooks }) => webhooks.receive(request))),
      receiveCallback: (request) =>
        Deferred.await(built).pipe(Effect.flatMap(({ callbacks }) => callbacks.receive(request))),
    });
    return Context.make(AutomationIngress, ingress).pipe(Context.add(AutomationHooks, hooks));
  }),
).pipe(Layer.provide(ServerSecretStore.layer));

/** Engine fibers wait for the server's activation, like its other long-lived roots. */
const layerActivation = Layer.effect(
  AutomationActivation,
  Effect.gen(function* () {
    return yield* ServerActivation;
  }),
);

/** The engine's due work on the server's scheduler, and upstream's PR watch through its waits. */
const layerSchedule = Layer.effectDiscard(
  Effect.gen(function* () {
    const engine = yield* WorkflowEngine.WorkflowEngine;
    const scheduler = yield* Scheduler;
    yield* scheduler.register("automations", engine.tick);
    setPullRequestWatchHandler(engine.watchPullRequest);
    yield* Effect.addFinalizer(() => Effect.sync(() => setPullRequestWatchHandler(undefined)));
  }),
);

const layerHost = Layer.mergeAll(
  layerThreads,
  layerFunctions,
  layerRunLogSink,
  layerModels,
  layerIngress,
  layerActivation,
  ExecutorSettings.layer,
  Layer.succeed(AutomationCompiler, AutomationCompiler.of({ compile: compileWorkflow })),
);

/** The engine with the server as its host. */
export const layer = Layer.merge(layerSchedule, ProjectAutomations.layer).pipe(
  Layer.provideMerge(WorkflowEngine.layer),
  Layer.provideMerge(layerHost),
);

import type {
  AutomationError,
  ChatAttachment,
  CommandId,
  MessageId,
  ModelSelection,
  OrchestrationV2Actor,
  OrchestrationV2ConversationMessage,
  OrchestrationV2CreationSource,
  OrchestrationV2DomainEvent,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadShell,
  OrchestrationV2TurnItem,
  ProjectId,
  ProviderInteractionMode,
  RunId,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";
import type { DrainContext } from "evlog";

import type { WorkflowCompileResult } from "./compiled.ts";
import type { LaunchRun } from "./engineTypes.ts";
import type { Envelope } from "./events/eventTriggers.ts";
import type { WorkflowStore } from "./WorkflowStore.ts";

/**
 * What the automation engine needs from the environment hosting it: a
 * self-hosted server (`serverHost.ts`) or a user's cloud object. The engine
 * reaches threads, the machine, compiling and its log sink only through
 * these, so each host decides how they work there.
 */

export type ThreadRecordField = "runs" | "messages" | "turnItems";

/** A thread's records of the kinds asked for, as the engine reads them. */
export type ThreadRecords<K extends ThreadRecordField> = Pick<
  OrchestrationV2ThreadProjection,
  "thread" | K
>;

/** Narrows the records read; every field is optional. */
export interface ThreadRecordFilter {
  readonly messageRoles?: ReadonlyArray<OrchestrationV2ConversationMessage["role"]>;
  readonly messageRunIds?: ReadonlyArray<RunId>;
  readonly turnItemRunId?: RunId;
  readonly turnItemTypes?: ReadonlyArray<OrchestrationV2TurnItem["type"]>;
}

/** Where an agent step's new thread works: the project's checkout or a fresh worktree. */
export type AgentWorkspace =
  | { readonly type: "root" }
  | {
      readonly type: "worktree";
      readonly baseRef: string;
      readonly branch?: string | undefined;
      readonly startFromOrigin?: boolean | undefined;
    };

/** A thread an automation step starts. */
export interface AutomationThreadLaunch {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly workspace: AgentWorkspace;
  readonly message: {
    readonly messageId: MessageId;
    readonly text: string;
  };
}

/** A message an automation sends to an existing thread, queued behind any turn it runs. */
export interface AutomationThreadSend {
  readonly projectId: ProjectId;
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly modelSelection?: ModelSelection;
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
}

/** What a thread lists for an attached run while it runs, so it stays in Working. */
export interface ThreadMonitor {
  readonly taskId: string;
  readonly description: string;
}

export interface AutomationThreadsShape {
  readonly getThreadShell: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationV2ThreadShell | null, AutomationError>;
  readonly getThreadRecords: <K extends ThreadRecordField>(
    threadId: ThreadId,
    fields: ReadonlyArray<K>,
    filter?: ThreadRecordFilter,
  ) => Effect.Effect<ThreadRecords<K>, AutomationError>;
  readonly launch: (
    input: AutomationThreadLaunch,
  ) => Effect.Effect<{ readonly threadId: ThreadId }, AutomationError>;
  readonly send: (
    input: AutomationThreadSend,
  ) => Effect.Effect<{ readonly run: OrchestrationV2Run }, AutomationError>;
  /** Interrupts the thread's running turn, if any. */
  readonly interrupt: (input: {
    readonly projectId: ProjectId;
    readonly commandId: CommandId;
    readonly threadId: ThreadId;
    readonly reason: string;
  }) => Effect.Effect<void, AutomationError>;
  readonly settle: (input: {
    readonly commandId: CommandId;
    readonly threadId: ThreadId;
  }) => Effect.Effect<void, AutomationError>;
  /** Every domain event of the host's threads, live from when it's run. */
  readonly domainEvents: Stream.Stream<OrchestrationV2DomainEvent, AutomationError>;
  /** The attached runs a thread lists now; an empty list clears them. */
  readonly monitorsChanged: (
    threadId: string,
    monitors: ReadonlyArray<ThreadMonitor>,
  ) => Effect.Effect<void>;
}

/** The host's threads: the agents automations start, wake and wait on. */
export class AutomationThreads extends Context.Service<AutomationThreads, AutomationThreadsShape>()(
  "signalbox/automations/AutomationThreads",
) {}

/**
 * Compiles a saved file. Read when a save happens, so a host may provide it
 * per request: the cloud compiles on the thread's machine, which has Node.
 */
export class AutomationCompiler extends Context.Service<
  AutomationCompiler,
  { readonly compile: (source: string) => WorkflowCompileResult }
>()("signalbox/automations/AutomationCompiler") {}

/** `w.run`: a function from the file, run where the host runs code. */
export class AutomationFunctions extends Context.Service<
  AutomationFunctions,
  {
    readonly run: (input: {
      readonly automationId: string;
      readonly projectId: string;
      readonly version: number;
      readonly module: string | null;
      readonly name: string;
      readonly args: ReadonlyArray<unknown>;
      readonly resultName: string;
    }) => Effect.Effect<unknown, AutomationError>;
    /** Deletes everything the automation installed. */
    readonly remove: (automationId: string) => Effect.Effect<void, AutomationError>;
    /** Deletes installed versions other than `keep`. */
    readonly prune: (
      automationId: string,
      keep: ReadonlySet<number>,
    ) => Effect.Effect<void, AutomationError>;
  }
>()("signalbox/automations/AutomationFunctions") {}

/** What `w.hook` returns: `url` once the host has a public address, else the path on it. */
export interface CallbackLink {
  readonly hookId: string;
  readonly url: string | null;
  readonly path: string;
}

/** The engine internals requests from outside start runs and deliver events through. */
export interface IngressDependencies {
  readonly store: WorkflowStore;
  readonly newId: (prefix: string) => Effect.Effect<string, AutomationError>;
  readonly launchRun: LaunchRun;
  /** Delivers an event to one run's waiting steps. */
  readonly deliverTo: (runId: string, envelope: Envelope) => Effect.Effect<void>;
}

/** Automation webhooks and `w.hook` callback links, as the engine drives them. */
export interface AutomationIngressShape {
  /** The public prefix hook URLs start with, read per view since it can change. */
  readonly hookBaseUrl: Effect.Effect<string | null>;
  /** A callback link for the run; `hookId` when the caller named it before the run started. */
  readonly createCallback: (
    runId: string,
    hookId?: string,
  ) => Effect.Effect<CallbackLink, AutomationError>;
  /** A run ended: its links stop answering. */
  readonly runEnded: (runId: string) => Effect.Effect<void, AutomationError>;
  /** An automation was deleted, with its webhook state. */
  readonly forget: (automationId: string) => Effect.Effect<void, AutomationError>;
  /** Sets or clears (null) an automation's webhook signing secret. */
  readonly setSecret: (
    automationId: string,
    secret: string | null,
  ) => Effect.Effect<void, AutomationError>;
}

/**
 * Requests from outside the host reaching automations. The host receives
 * them on its own routes; the engine builds its side once its run core exists.
 */
export class AutomationIngress extends Context.Service<
  AutomationIngress,
  {
    readonly make: (
      deps: IngressDependencies,
    ) => Effect.Effect<AutomationIngressShape, never, Scope.Scope>;
  }
>()("signalbox/automations/AutomationIngress") {}

/** Where each run's wide event goes when it ends (see runLog.ts); null keeps none. */
export class AutomationRunLogSink extends Context.Service<
  AutomationRunLogSink,
  {
    readonly drain: ((context: DrainContext) => void | Promise<void>) | null;
    /** Pretty-prints events in the terminal, for development. */
    readonly pretty: boolean;
  }
>()("signalbox/automations/AutomationRunLogSink") {}

/** The effective reasoning-effort option of a model, when the host has a provider catalog. */
export class AutomationModels extends Context.Service<
  AutomationModels,
  {
    /** Null when the model has none. */
    readonly effortOption: (
      instanceId: string,
      model: string,
    ) => Effect.Effect<{
      readonly id: string;
      readonly values: ReadonlyArray<string> | null;
    } | null>;
  }
>()("signalbox/automations/AutomationModels") {}

/**
 * Held until the host is ready to run work, when it has such a moment (a
 * server activates after startup commits). Long-lived engine fibers start
 * parked behind it.
 */
export class AutomationActivation extends Context.Reference<Effect.Effect<void> | undefined>(
  "signalbox/automations/AutomationActivation",
  { defaultValue: () => undefined },
) {}

/** Forks a long-lived engine fiber, parked until the host activates. */
export const forkRoot = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<void, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const activation = yield* AutomationActivation;
    if (activation === undefined) return yield* Effect.forkScoped(effect).pipe(Effect.asVoid);
    const parked = yield* Deferred.make<void>();
    yield* Effect.forkScoped(
      Deferred.succeed(parked, undefined).pipe(Effect.andThen(activation), Effect.andThen(effect)),
    );
    yield* Deferred.await(parked);
  });

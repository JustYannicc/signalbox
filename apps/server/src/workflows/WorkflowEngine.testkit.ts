// @effect-diagnostics nodeBuiltinImport:off
import * as NodeProcess from "node:process";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AutomationError,
  ProjectId,
  ThreadId,
  type AutomationDefaults,
  type AutomationSaveResult,
} from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import {
  ThreadLaunchService,
  type ThreadLaunchInput,
} from "../orchestration-v2/ThreadLaunchService.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectService } from "../project/ProjectService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { fromJson, toJson } from "./json.ts";
import { WorkflowEngine, layer as engineLayer } from "./WorkflowEngine.ts";

/** Shared fakes for the engine tests: threads, HTTP and Executor, and a real in-memory database. */

export const DEFAULTS: AutomationDefaults = {
  modelSelection: { instanceId: "codex" as never, model: "gpt-6-astra" },
  runtimeMode: "approval-required",
  interactionMode: "default",
};
export const PROJECT = ProjectId.make("project-automations");
export const PROJECT_ROOT = import.meta.dirname;

/** Fake agent threads `thread-1`, `thread-2`, … that finish when the test says so. */
export function fakeThreads() {
  const launches: ThreadLaunchInput[] = [];
  const interrupts: Array<{ readonly threadId: string; readonly commandId: string }> = [];
  const state = {
    finished: false,
    reply: "Fixed it in PR #12.",
    /** Per-thread replies, else `reply`. */
    replies: {} as Record<string, string>,
    deleted: new Set<string>(),
    /** Make reading threads fail, like a broken projection. */
    broken: false,
    dispatched: [] as string[],
    /** Follow-ups sent to existing threads, and which of their runs have finished. */
    sends: [] as Array<{
      readonly threadId: string;
      readonly text: string;
      readonly runId: string;
    }>,
    finishedSends: new Set<string>(),
    /** Per-thread shell fields over the defaults, e.g. another project or a system thread. */
    shells: {} as Record<string, Record<string, unknown>>,
    /** Per-thread runs, replacing the default ones. */
    threadRuns: {} as Record<string, ReadonlyArray<Record<string, unknown>>>,
  };
  // Domain events the test emits. `emit` returns once the engine has handled the event and
  // asked for the next one, so a following `engine.drain` covers whatever it started.
  const inbox =
    Deferred.makeUnsafe<
      Queue.Queue<{ readonly event: unknown; readonly handled: Deferred.Deferred<void> }>
    >();
  let pending: Deferred.Deferred<void> | undefined;
  const domainEvents = Stream.unwrap(
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<{
        readonly event: unknown;
        readonly handled: Deferred.Deferred<void>;
      }>();
      yield* Deferred.succeed(inbox, queue);
      return Stream.fromEffectRepeat(
        Effect.gen(function* () {
          if (pending) yield* Deferred.succeed(pending, undefined);
          const next = yield* Queue.take(queue);
          pending = next.handled;
          return next.event;
        }),
      );
    }),
  );
  const emit = (event: unknown) =>
    Effect.gen(function* () {
      const queue = yield* Deferred.await(inbox);
      const handled = yield* Deferred.make<void>();
      yield* Queue.offer(queue, { event, handled });
      yield* Deferred.await(handled);
    });
  let ended = 0;
  /** Tells the engine a thread's run ended, as the domain event stream does when a turn finishes. */
  const runEnded = (threadId: string, runId = "run-1") =>
    emit({
      id: `run-ended-${++ended}`,
      type: "run.updated",
      threadId,
      runId,
      occurredAt: DateTime.makeUnsafe("2026-10-05T09:00:00.000Z"),
      payload: {
        id: runId,
        threadId,
        ordinal: 1,
        status: "completed",
        providerInstanceId: "codex",
        modelSelection: { instanceId: "codex", model: "gpt-6-astra" },
        userMessageId: `automation:${threadId}`,
        startedAt: DateTime.makeUnsafe("2026-10-05T09:00:00.000Z"),
        completedAt: DateTime.makeUnsafe("2026-10-05T09:00:00.000Z"),
      },
    });
  const run = (status: string) => ({ id: "run-1", status, ordinal: 1 });
  const runsFor = (threadId: string) =>
    state.threadRuns[threadId] ?? [
      run(state.finished ? "completed" : "running"),
      ...state.sends
        .filter((send) => send.threadId === threadId)
        .map((send, index) => ({
          id: send.runId,
          status: state.finishedSends.has(send.runId) ? "completed" : "running",
          ordinal: index + 2,
        })),
    ];
  const launch = Layer.mock(ThreadLaunchService)({
    launch: (input) => {
      launches.push(input);
      return Effect.succeed({
        threadId: ThreadId.make(`thread-${launches.length}`),
        projection: {} as never,
        resumed: false,
      });
    },
  });
  const management = Layer.mock(ThreadManagementService)({
    streamDomainEvents: domainEvents as never,
    dispatch: ((command: { type: string }) => {
      state.dispatched.push(command.type);
      return Effect.succeed({ sequence: 1 });
    }) as never,
    getThreadShell: ((threadId: string) =>
      Effect.succeed({
        projectId: PROJECT,
        deletedAt: state.deleted.has(threadId) ? "2026-10-05T09:00:00.000Z" : null,
        branch: `branch-of-${threadId}`,
        worktreePath: `/worktrees/${threadId}`,
        branchPullRequest: null,
        title: `Title of ${threadId}`,
        createdBy: "user",
        ...state.shells[threadId],
      })) as never,
    sendToThread: ((input: { threadId: string; text: string }) => {
      const runId = `sent-${state.sends.length + 1}`;
      state.sends.push({ threadId: input.threadId, text: input.text, runId });
      return Effect.succeed({ run: { id: runId, status: "queued" } });
    }) as never,
    interruptThread: ((input: { threadId: string; commandId: string }) => {
      interrupts.push({ threadId: input.threadId, commandId: input.commandId });
      return Effect.succeed({ type: "no_active_run" });
    }) as never,
    getThreadRecords: ((
      threadId: string,
      fields: ReadonlyArray<string>,
      filter?: { readonly messageRunIds?: ReadonlyArray<string> },
    ) =>
      state.broken
        ? Effect.fail(new AutomationError({ message: "projection unavailable" }))
        : Effect.succeed(
            fields.includes("runs")
              ? { runs: runsFor(threadId) }
              : {
                  messages: [
                    {
                      runId: filter?.messageRunIds?.[0] ?? "run-1",
                      role: "assistant",
                      text:
                        state.replies[filter?.messageRunIds?.[0] ?? threadId] ??
                        state.replies[threadId] ??
                        state.reply,
                      updatedAt: "2026-10-05T09:00:00.000Z",
                      id: "m1",
                    },
                  ],
                  turnItems: [],
                },
          )) as never,
  });
  return {
    launches,
    interrupts,
    state,
    emit,
    runEnded,
    layer: Layer.mergeAll(launch, management),
  };
}

export interface SentRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

/**
 * Answers http steps and Executor calls like live services would. `routes`
 * overrides answers by URL; without one, Executor completes and anything
 * else answers `{ items: 3 }`.
 */
export function fakeHttp(
  routes: Record<
    string,
    (request: HttpClientRequest.HttpClientRequest) => Effect.Effect<Response>
  > = {},
) {
  const sent: SentRequest[] = [];
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        const body =
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
        sent.push({
          url: request.url,
          headers: request.headers,
          body: body ? fromJson(body) : null,
        });
        const route = routes[request.url];
        if (route) return HttpClientResponse.fromWeb(request, yield* route(request));
        const payload = request.url.endsWith("/api/executions")
          ? {
              status: "completed",
              structured: {
                status: "completed",
                result: { ok: true, value: { labels: ["home"] } },
              },
            }
          : { items: 3 };
        return HttpClientResponse.fromWeb(request, jsonResponse(payload));
      }),
    ),
  );
  return { sent, layer };
}

export const jsonResponse = (payload: unknown, init: ResponseInit = {}) =>
  new Response(toJson(payload), {
    status: 200,
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });

export interface EngineOptions {
  readonly threads?: ReturnType<typeof fakeThreads>;
  readonly http?: ReturnType<typeof fakeHttp>;
  readonly environment?: NodeJS.ProcessEnv;
}

const makeDependencies = (options: EngineOptions) =>
  Layer.mergeAll(
    NodeCrypto.layer,
    Scheduler.layer,
    (options.threads ?? fakeThreads()).layer,
    (options.http ?? fakeHttp()).layer,
    SqlitePersistenceMemory,
    ServerConfig.layerTest(PROJECT_ROOT, { prefix: "signalbox-automations-test-" }),
    Layer.mock(ProjectService)({
      getById: () => Effect.succeedSome({ workspaceRoot: PROJECT_ROOT } as never),
    }),
  ).pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(
      Layer.succeed(HostProcessEnvironment, options.environment ?? NodeProcess.env),
    ),
  );

/** Runs `body` with a real engine over the fakes, and the services under it for direct checks. */
export function withEngine<A, E>(
  options: EngineOptions,
  body: Effect.Effect<A, E, WorkflowEngine | Layer.Success<ReturnType<typeof makeDependencies>>>,
) {
  return body.pipe(Effect.provide(engineLayer.pipe(Layer.provideMerge(makeDependencies(options)))));
}

/** Saves `source`, failing the test with its diagnostics when it doesn't compile. */
export const saveOk = (
  source: string,
  options: { readonly projectId?: ProjectId; readonly defaults?: AutomationDefaults } = {},
) =>
  Effect.gen(function* () {
    const engine = yield* WorkflowEngine;
    const saved: AutomationSaveResult = yield* engine.save({
      source,
      projectId: options.projectId ?? PROJECT,
      defaults: options.defaults ?? DEFAULTS,
    });
    if (!saved.ok)
      throw new Error(saved.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
    return saved.automation;
  });

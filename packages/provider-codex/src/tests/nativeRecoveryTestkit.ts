import {
  makeCodexAdapterV2,
  prepareCodexNativeAdmission,
  type CodexNativeReceipt,
  type CodexNativeRecoveryBinding,
} from "@signalbox/provider-codex/runtime";
import { CodexSettings, ProviderSessionId } from "@t3tools/contracts";
import {
  ProviderAdapterProtocolError,
  type ProviderAdapterV2Event,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as CodexClient from "effect-codex-app-server/client";
import type * as CodexErrors from "effect-codex-app-server/errors";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Scope from "effect/Scope";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { recoveryTurn } from "./nativeRecoveryTestData.ts";

const decodeSettings = Schema.decodeEffect(CodexSettings);
const isGoalContinuation = Schema.is(
  Schema.Struct({
    turn: Schema.Struct({ id: Schema.Literal("goal-next") }),
  }),
);
const decode = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.Union([Schema.String, Schema.Number]),
      method: Schema.String,
      params: Schema.Unknown,
    }),
  ),
);

export function fixture(
  options: {
    fresh?: boolean;
    denyReservation?: boolean;
    loseReply?: boolean;
    delayedStart?: boolean;
    earlyStart?: boolean;
    earlyGoalCompletion?: boolean;
    delayGoalPause?: boolean;
    delayAcceptanceReply?: boolean;
    rejectReceipt?: CodexNativeReceipt["status"];
  } = {},
) {
  return Effect.gen(function* () {
    const scope = yield* Scope.Scope;
    const turn = recoveryTurn();
    const inbound = yield* Queue.unbounded<Uint8Array>();
    const continued = yield* Deferred.make<void>();
    const completionHandled = yield* Deferred.make<Exit.Exit<void, unknown>>();
    const goalReleased = yield* Deferred.make<Exit.Exit<void, unknown>>();
    const goalContinued = yield* Deferred.make<Exit.Exit<void, unknown>>();
    const goalPauseRequested = yield* Deferred.make<void>();
    const goalPauseReply = yield* Deferred.make<void>();
    const acceptanceReply = yield* Deferred.make<void>();
    const receipts: CodexNativeReceipt[] = [];
    const receiptAttempts: CodexNativeReceipt[] = [];
    const receiptFailure = new Error("receipt write rejected");
    const reservationFailure = new ProviderAdapterProtocolError({
      driver: turn.providerThread.driver,
      detail: "reservation rejected",
    });
    const requestFailures: CodexErrors.CodexAppServerError[] = [];
    const requests: { method: string; params: unknown }[] = [];
    const order: string[] = [];
    const send = (frame: unknown) =>
      Queue.offer(inbound, new TextEncoder().encode(JSON.stringify(frame) + "\n"));
    const nativeTurn = {
      id: "replacement-native-turn",
      status: "inProgress",
      items: [],
      startedAt: options.delayedStart ? null : 1,
    };
    const client = yield* CodexClient.make(
      Stdio.make({
        args: Effect.succeed([]),
        stdin: Stream.fromQueue(inbound),
        stderr: () => Sink.drain,
        stdout: () =>
          Sink.forEach((chunk: string | Uint8Array) =>
            Effect.gen(function* () {
              const request = decode(
                typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
              );
              requests.push(request);
              order.push(request.method);
              if (request.method === "thread/resume") {
                yield* send({
                  id: request.id,
                  result: { thread: { id: "native-session", updatedAt: 1 } },
                });
              } else if (request.method === "turn/start") {
                if (options.earlyGoalCompletion || options.delayGoalPause)
                  yield* send({
                    method: "thread/goal/updated",
                    params: {
                      threadId: "native-session",
                      goal: {
                        threadId: "native-session",
                        objective: "goal",
                        status: "active",
                        createdAt: 1,
                        updatedAt: 1,
                        tokensUsed: 0,
                        timeUsedSeconds: 0,
                      },
                    },
                  });
                if (options.earlyStart || options.earlyGoalCompletion) {
                  yield* send({
                    method: "turn/started",
                    params: { threadId: "native-session", turn: { ...nativeTurn, startedAt: 1 } },
                  });
                  yield* Deferred.await(continued);
                }
                if (options.earlyGoalCompletion) {
                  yield* send({
                    method: "turn/completed",
                    params: {
                      threadId: "native-session",
                      turn: { ...nativeTurn, status: "completed", completedAt: 2 },
                    },
                  });
                  yield* Deferred.await(completionHandled);
                }
                const reply = send(
                  options.loseReply
                    ? { id: request.id, error: { code: -1, message: "reply lost after dispatch" } }
                    : { id: request.id, result: { turn: nativeTurn } },
                );
                if (options.delayAcceptanceReply)
                  yield* Deferred.await(acceptanceReply).pipe(
                    Effect.andThen(reply),
                    Effect.forkIn(scope),
                  );
                else yield* reply;
              } else if (request.method === "thread/goal/set") {
                if (options.delayGoalPause) {
                  yield* Deferred.succeed(goalPauseRequested, undefined);
                  yield* Deferred.await(goalPauseReply);
                }
                yield* send({
                  id: request.id,
                  result: {
                    goal: {
                      threadId: "native-session",
                      objective: "goal",
                      status: "paused",
                      createdAt: 1,
                      updatedAt: 2,
                      tokensUsed: 0,
                      timeUsedSeconds: 0,
                    },
                  },
                });
              } else
                return yield* Effect.die(new Error(`Unexpected native request ${request.method}`));
            }),
          ),
      }),
    );
    const admission = prepareCodexNativeAdmission({
      logicalRunId: turn.runId,
      nativeIncarnationId: "boot-2",
      nativeSessionId: "native-session",
      nativeFiles: { filesystemId: "files", home: "/codex" },
      providerRelease: "R8",
      inputId: turn.message.messageId,
    });
    const reference = { id: "file", bytes: 1, sha256: "1".repeat(64) };
    const mode: CodexNativeRecoveryBinding["mode"] = options.fresh
      ? { type: "new-turn", admission }
      : {
          type: "resume-unfinished",
          plan: {
            status: "ready",
            admission: {
              ...admission,
              nativeTurnId: "old-native-turn",
              inputDurability: "native-file",
            },
            evidence: {
              file: { path: "/codex/session.jsonl", reference },
              stopped: { nativeIncarnationId: "boot-1", reference },
              nativeSessionId: "native-session",
              nativeTurnId: "old-native-turn",
              nativeInputId: admission.nativeInputId,
              headLine: 3,
              inputLine: 3,
              pendingNativeCallIds: [],
              state: "unfinished",
            },
          },
        };
    const adapter = yield* makeCodexAdapterV2({
      nativeRecovery: {
        mode,
        beforeNativeStart: () =>
          Effect.suspend(() => {
            order.push("reserve");
            return options.denyReservation ? Effect.fail(reservationFailure) : Effect.void;
          }),
        observe: (receipt) =>
          Effect.gen(function* () {
            receiptAttempts.push(receipt);
            if (receipt.status === options.rejectReceipt) return yield* Effect.fail(receiptFailure);
            receipts.push(receipt);
            if (receipt.status === "continued") yield* Deferred.succeed(continued, undefined);
          }),
      },
      defaultCwd: "/workspace",
      instanceId: turn.modelSelection.instanceId,
      settings: yield* decodeSettings({}),
      environment: {},
      clientFactory: {
        open: () =>
          Effect.succeed({
            ...client,
            preinitialized: Effect.void,
            request: (method, payload) =>
              client.request(method, payload).pipe(
                Effect.tapError((error) =>
                  Effect.sync(() => {
                    requestFailures.push(error);
                  }),
                ),
              ),
            handleServerNotification: (method, handler) =>
              client.handleServerNotification(method, (payload) =>
                handler(payload).pipe(
                  Effect.onExit((exit) => {
                    if (method === "turn/completed")
                      return Deferred.succeed(completionHandled, exit);
                    if (method === "thread/goal/cleared")
                      return Deferred.succeed(goalReleased, exit);
                    if (method === "turn/started" && isGoalContinuation(payload))
                      return Deferred.succeed(goalContinued, exit);
                    return Effect.void;
                  }),
                ),
              ),
          }),
      },
      crypto: Crypto.make({
        randomBytes: (size) => new Uint8Array(size),
        digest: (_algorithm, bytes) => Effect.succeed(bytes),
      }),
      fileSystem: FileSystem.makeNoop({ exists: () => Effect.succeed(false) }),
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      attachmentsDir: "/attachments",
      attachments: {
        resolvePath: () => null,
        resolvePathById: () => null,
        snapshotMcpApp: () => Effect.succeed(undefined),
      },
      clientInfo: { name: "recovery-contract-test", version: "1" },
    });
    const runtime = yield* adapter.openSession({
      threadId: turn.threadId,
      providerSessionId: ProviderSessionId.make("provider-session"),
      modelSelection: turn.modelSelection,
      runtimePolicy: turn.runtimePolicy,
    });
    return {
      runtime,
      turn,
      requests,
      receipts,
      receiptAttempts,
      receiptFailure,
      reservationFailure,
      requestFailures,
      order,
      continued,
      completionHandled,
      goalPauseRequested: Deferred.await(goalPauseRequested),
      replyToGoalPause: Deferred.succeed(goalPauseReply, undefined),
      replyToStart: Deferred.succeed(acceptanceReply, undefined),
      releaseGoal: send({
        method: "thread/goal/cleared",
        params: { threadId: "native-session" },
      }).pipe(Effect.andThen(Deferred.await(goalReleased))),
      continueGoal: send({
        method: "turn/started",
        params: {
          threadId: "native-session",
          turn: { ...nativeTurn, id: "goal-next", startedAt: 3 },
        },
      }).pipe(Effect.andThen(Deferred.await(goalContinued))),
      readEvents: Effect.gen(function* () {
        const events: ProviderAdapterV2Event[] = [];
        // The native callback has settled; drain its buffered events before interrupting the reader.
        const reader = yield* runtime.events.pipe(
          Stream.runForEach((event) => Effect.sync(() => events.push(event))),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Fiber.interrupt(reader);
        return events;
      }),
      started: send({
        method: "turn/started",
        params: { threadId: "native-session", turn: { ...nativeTurn, startedAt: 1 } },
      }),
      completed: send({
        method: "turn/completed",
        params: {
          threadId: "native-session",
          turn: { ...nativeTurn, status: "completed", completedAt: 2 },
        },
      }),
    };
  });
}
export const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | IdAllocator.IdAllocatorV2
    | McpProviderSessions.McpProviderSessions
    | import("effect/Scope").Scope
  >,
) =>
  effect.pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer)),
  );

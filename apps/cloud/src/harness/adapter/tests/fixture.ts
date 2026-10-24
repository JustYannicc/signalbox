import type { RunnerItem } from "@signalbox/runner-protocol/RunnerProtocol";
import {
  ProviderDriverKind,
  ProviderTurnId,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import {
  ProviderAdapterReadThreadSnapshotError,
  ProviderAdapterResumeThreadError,
  ProviderAdapterEventStreamError,
  type ProviderAdapterV2Error,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2SessionRuntime,
  type ProviderAdapterV2ThreadSnapshot,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as AdapterHarness from "../../AdapterHarness.ts";
import type { HarnessOpenInput } from "../../Harness.ts";
import type {
  HarnessRuntimeReporter,
  ReleaseModuleOmittedEvent,
} from "../../HarnessProcessLifetime.ts";

import { dataForDriver } from "./data.ts";

export const fixtureForDriver = (selectedDriver: ProviderDriverKind) =>
  Effect.gen(function* () {
    const {
      now,
      threadId,
      instanceId,
      driver,
      providerSessionId,
      providerThread,
      providerSession,
      modelSelection,
      turn,
    } = yield* dataForDriver(selectedDriver);
    const incoming = yield* Queue.unbounded<ProviderAdapterV2Event, ProviderAdapterV2Error>();
    const started =
      yield* Queue.unbounded<Parameters<ProviderAdapterV2SessionRuntime["startTurn"]>[0]>();
    const interrupted =
      yield* Queue.unbounded<Parameters<ProviderAdapterV2SessionRuntime["interruptTurn"]>[0]>();
    const calls: string[] = [];
    const controls: unknown[] = [];
    const opened: HarnessOpenInput[] = [];
    let runtimeReporter: HarnessRuntimeReporter | undefined;
    let snapshot: ProviderAdapterV2ThreadSnapshot = {
      providerThread,
      providerTurns: [],
      messages: [],
      runtimeRequests: [],
    };
    let saveFailure: Error | undefined;
    let snapshotFailure = false;
    let pendingBackground = false;
    let resumeFailure = false;
    let startGate: Effect.Effect<void> = Effect.void;
    let responseEffect: Effect.Effect<void, ProviderAdapterV2Error> = Effect.void;
    let interruptEffect: Effect.Effect<void, ProviderAdapterV2Error> = Effect.void;
    let cleanup: Effect.Effect<void> = Effect.void;
    let saveGate: Promise<void> = Promise.resolve();
    let saving = Promise.withResolvers<void>();
    const runtime: ProviderAdapterV2SessionRuntime = {
      instanceId,
      driver,
      providerSessionId,
      providerSession,
      events: Stream.fromQueue(incoming),
      ensureThread: () =>
        Effect.gen(function* () {
          calls.push("ensure");
          yield* Queue.offer(incoming, { type: "provider_thread.updated", driver, providerThread });
          return providerThread;
        }),
      resumeThread: (input) =>
        Effect.suspend(() => {
          calls.push("resume");
          return resumeFailure
            ? Effect.fail(
                new ProviderAdapterResumeThreadError({
                  driver,
                  providerSessionId,
                  providerThreadId: providerThread.id,
                }),
              )
            : Effect.succeed(input.providerThread);
        }),
      startTurn: (input) =>
        Effect.gen(function* () {
          calls.push("start");
          yield* Queue.offer(started, input);
          yield* startGate;
        }),
      steerTurn: (input) =>
        Effect.sync(() => {
          controls.push(input);
        }),
      interruptTurn: (input) =>
        Effect.gen(function* () {
          controls.push(input);
          yield* Queue.offer(interrupted, input);
          yield* interruptEffect;
        }),
      respondToRuntimeRequest: (input) =>
        Effect.sync(() => {
          controls.push(input);
        }).pipe(Effect.andThen(Effect.suspend(() => responseEffect))),
      readThreadSnapshot: () =>
        Effect.suspend(() => {
          calls.push("snapshot");
          return snapshotFailure
            ? Effect.fail(
                new ProviderAdapterReadThreadSnapshotError({
                  driver,
                  providerThreadId: providerThread.id,
                }),
              )
            : Effect.succeed(snapshot);
        }),
      hasPendingBackgroundWork: Effect.sync(() => pendingBackground),
      rollbackThread: () => Effect.die("unused rollback"),
      forkThread: () => Effect.die("unused fork"),
    };
    const input: HarnessOpenInput = {
      release: {
        harness: "codex",
        version: "1",
        manifestSha256: "manifest",
        modules: { entry: { bytes: 1, sha256: "entry" } },
      },
      session: {
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: "/workspace",
        },
      },
      computer: {
        threadId,
        get files(): never {
          throw new Error("unused files");
        },
        exec: async () => {
          throw new Error("unused exec");
        },
        port: async () => {
          throw new Error("unused port");
        },
        save: async (signal) => {
          calls.push("save");
          saving.resolve();
          await saveGate;
          signal.throwIfAborted();
          if (saveFailure !== undefined) throw saveFailure;
          calls.push("saved");
          return { commit: "computer-revision" };
        },
      },
      modelTransport: async () => new Response("model"),
      hooks: () => Promise.resolve({}),
    };
    const service = yield* AdapterHarness.AdapterHarness.pipe(
      Effect.provide(
        AdapterHarness.layer.pipe(
          Layer.provide(
            Layer.succeed(AdapterHarness.AdapterRuntimeFactory, {
              open: (supplied, reporter) =>
                Effect.gen(function* () {
                  runtimeReporter = reporter;
                  opened.push(supplied);
                  yield* Effect.addFinalizer(() =>
                    Effect.sync(() => {
                      calls.push("cleanup:start");
                    }).pipe(
                      Effect.andThen(Effect.suspend(() => cleanup)),
                      Effect.andThen(
                        Effect.sync(() => {
                          calls.push("cleanup:end");
                        }),
                      ),
                    ),
                  );
                  return runtime;
                }),
            }),
          ),
        ),
      ),
    );
    const native = (
      input = turn,
      ordinal = input.providerTurnOrdinal,
    ): OrchestrationV2ProviderTurn => ({
      id: ProviderTurnId.make(`native-${input.runId}-${ordinal}`),
      providerThreadId: providerThread.id,
      nodeId: input.rootNodeId,
      runAttemptId: input.attemptId,
      nativeTurnRef: { driver, nativeId: `native-${ordinal}`, strength: "strong" },
      ordinal,
      status: "running",
      startedAt: now,
      completedAt: null,
    });
    const emit = (event: ProviderAdapterV2Event) => Queue.offer(incoming, event);
    const named = (input = turn, ordinal = input.providerTurnOrdinal) =>
      emit({ type: "provider_turn.updated", driver, providerTurn: native(input, ordinal) });
    const terminal = (input = turn) =>
      Effect.gen(function* () {
        const completed = { ...native(input), status: "completed" as const, completedAt: now };
        snapshot = { ...snapshot, providerTurns: [completed] };
        yield* emit({ type: "provider_turn.updated", driver, providerTurn: completed });
        yield* emit({
          type: "turn.terminal",
          driver,
          providerThreadId: providerThread.id,
          providerTurnId: completed.id,
          runOrdinal: input.runOrdinal,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
      });
    const open = (supplied = input) =>
      Effect.gen(function* () {
        const session = yield* service.open(supplied);
        const events: RunnerItem[] = [];
        const delivered = yield* Queue.unbounded<RunnerItem>();
        const collector = yield* session.events.pipe(
          Stream.runForEach((item) =>
            Effect.gen(function* () {
              events.push(item);
              calls.push(`publish:${item.kind === "provider" ? item.event.type : item.kind}`);
              yield* Queue.offer(delivered, item);
            }),
          ),
          Effect.exit,
          Effect.forkScoped,
        );
        return { session, events, collector, next: Queue.take(delivered) };
      });
    return {
      input,
      turn,
      runtime,
      open,
      service,
      opened,
      calls,
      controls,
      emit,
      named,
      native,
      terminal,
      nextStart: Queue.take(started),
      nextInterrupt: Queue.take(interrupted),
      saving: Effect.promise(() => saving.promise),
      setSaveFailure: (error: Error) => {
        saveFailure = error;
      },
      setSnapshotFailure: () => {
        snapshotFailure = true;
      },
      setSnapshot: (next: ProviderAdapterV2ThreadSnapshot) => {
        snapshot = next;
      },
      setPendingBackground: (value: boolean) => {
        pendingBackground = value;
      },
      setResumeFailure: () => {
        resumeFailure = true;
      },
      setStartGate: (gate: Effect.Effect<void>) => {
        startGate = gate;
      },
      setSaveGate: (gate: Promise<void>) => {
        saveGate = gate;
        saving = Promise.withResolvers<void>();
      },
      setResponseEffect: (effect: Effect.Effect<void, ProviderAdapterV2Error>) => {
        responseEffect = effect;
      },
      setInterruptEffect: (effect: Effect.Effect<void, ProviderAdapterV2Error>) => {
        interruptEffect = effect;
      },
      setCleanup: (effect: Effect.Effect<void>) => {
        cleanup = effect;
      },
      endEvents: Queue.fail(
        incoming,
        new ProviderAdapterEventStreamError({ driver, providerSessionId }),
      ),
      reportReleaseModuleOmitted(event: ReleaseModuleOmittedEvent) {
        if (runtimeReporter === undefined)
          throw new Error("Harness runtime reporter is unavailable");
        runtimeReporter.releaseModuleOmitted(event);
      },
    };
  });

export const fixture = fixtureForDriver(ProviderDriverKind.make("codex"));

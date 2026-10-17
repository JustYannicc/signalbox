import { CommandId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import { PERSONAL_POOL_ID } from "@t3tools/contracts/accountHub";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import { layerThreadObject } from "../testing.ts";
import { scriptedModelSelection } from "./scriptedProvider.ts";
import { ThreadEngine, layer as engineLayer } from "./ThreadEngine.ts";
import { ThreadStore } from "./ThreadStore.ts";

const owner = { userId: "user_1", contextIds: [PERSONAL_CONTEXT_ID] };
const creation = {
  place: { contextId: PERSONAL_CONTEXT_ID, driveId: "my/personal/user_1" },
  pools: { top: PERSONAL_POOL_ID, projects: {} },
};
const threadId = ThreadId.make("thread-1");
const launch = (engine: ThreadEngine["Service"], withMessage: boolean) =>
  engine.launch(
    owner,
    {
      commandId: CommandId.make("launch"),
      threadId,
      projectId: ProjectId.make("scratch"),
      title: "Original",
      modelSelection: scriptedModelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      ...(withMessage
        ? {
            initialMessage: {
              messageId: MessageId.make("message-1"),
              text: "Hello",
              attachments: [],
            },
          }
        : {}),
    },
    creation,
  );

describe("summary confirmation revisions", () => {
  it.effect.each(["summary", "pendingSummary"] as const)(
    "%s waits for the state matching a newly committed revision",
    (read) =>
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const storageCommitted = yield* Deferred.make<void>();
        const finishCommit = yield* Deferred.make<void>();
        const outboxRead = yield* Deferred.make<void>();
        const gatedStore = {
          ...store,
          commit: (input: Parameters<typeof store.commit>[0]) =>
            store
              .commit(input)
              .pipe(
                Effect.tap(() =>
                  input.command?.id === "rename"
                    ? Effect.andThen(
                        Deferred.succeed(storageCommitted, undefined),
                        Deferred.await(finishCommit),
                      )
                    : Effect.void,
                ),
              ),
          outbox: Effect.andThen(Deferred.succeed(outboxRead, undefined), store.outbox),
        };
        const context = yield* Layer.build(Layer.fresh(engineLayer)).pipe(
          Effect.provideService(ThreadStore, gatedStore),
        );
        const engine = Context.get(context, ThreadEngine);
        yield* launch(engine, false);
        const before = yield* Effect.orDie(store.outbox);
        const writer = yield* engine
          .dispatch(
            owner,
            {
              type: "thread.metadata.update",
              commandId: CommandId.make("rename"),
              threadId,
              title: "Renamed",
            },
            creation,
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(storageCommitted);
        expect((yield* Effect.orDie(store.outbox)).revision).toBeGreaterThan(before.revision);

        // The commit has written SQLite but has not yet replaced the engine's state.
        const reading =
          read === "summary"
            ? engine.summary(owner)
            : Effect.map(engine.pendingSummary, (pending) => pending?.summary ?? null);
        const reader = yield* reading.pipe(Effect.forkChild({ startImmediately: true }));
        const readBeforeCommitFinished = yield* Deferred.isDone(outboxRead);
        yield* Deferred.succeed(finishCommit, undefined);
        expect(readBeforeCommitFinished).toBe(false);
        const receipt = yield* Fiber.join(writer);
        const summary = yield* Fiber.join(reader);
        expect(summary?.shell).toMatchObject({
          title: "Renamed",
          summaryRevision: receipt.summaryRevision,
        });
        expect(summary?.revision).toBe(receipt.summaryRevision);
      }).pipe(Effect.scoped, Effect.provide(layerThreadObject(":memory:"))),
  );

  it.effect(
    "confirms no-ops and replays after detail-only events without publishing a summary",
    () =>
      Effect.gen(function* () {
        const engine = yield* ThreadEngine;
        const store = yield* ThreadStore;
        yield* launch(engine, true);
        yield* engine.step;
        const rename = {
          type: "thread.metadata.update" as const,
          commandId: CommandId.make("rename"),
          threadId,
          title: "Renamed",
        };
        const accepted = yield* engine.dispatch(owner, rename, creation);
        const summary = (yield* engine.summary(owner))!;
        expect(summary.shell.title).toBe("Renamed");
        expect(accepted.summaryRevision).toBe(summary.revision);
        expect(summary.shell.summaryRevision).toBe(summary.revision);
        expect((yield* engine.pendingSummary)?.summary.shell.summaryRevision).toBe(
          summary.revision,
        );
        yield* engine.acknowledgeSummary(summary.revision);

        yield* engine.step;
        const { snapshotSequence: head } = yield* engine.snapshot(owner);
        expect(head).toBeGreaterThan(summary.revision);
        expect(yield* engine.pendingSummary).toBeNull();
        const noop = {
          type: "thread.metadata.update" as const,
          commandId: CommandId.make("noop"),
          threadId,
        };
        const nooped = yield* engine.dispatch(owner, noop, creation);
        expect(nooped).toEqual({ sequence: head, summaryRevision: summary.revision });
        expect(yield* engine.dispatch(owner, noop, creation)).toEqual(nooped);
        expect(yield* engine.dispatch(owner, rename, creation)).toEqual(accepted);
        expect((yield* engine.snapshot(owner)).snapshotSequence).toBe(head);
        expect((yield* Effect.orDie(store.outbox)).revision).toBe(summary.revision);
        expect(yield* engine.pendingSummary).toBeNull();

        const replacement = yield* engine.dispatch(
          owner,
          { ...rename, commandId: CommandId.make("rename-again"), title: "Replacement" },
          creation,
        );
        expect(replacement.summaryRevision).toBeGreaterThan(summary.revision);
        const replayed = yield* engine.dispatch(owner, rename, creation);
        expect(replayed).toEqual({
          sequence: accepted.sequence,
          summaryRevision: replacement.summaryRevision,
        });
        expect((yield* engine.summary(owner))?.shell).toMatchObject({
          title: "Replacement",
          summaryRevision: replayed.summaryRevision,
        });
      }).pipe(Effect.provide(layerThreadObject(":memory:"))),
  );

  it.effect("confirms monitor-only summary changes independently of the event head", () =>
    Effect.gen(function* () {
      const engine = yield* ThreadEngine;
      yield* launch(engine, false);
      const initial = (yield* engine.summary(owner))!;
      const { snapshotSequence: head } = yield* engine.snapshot(owner);
      const noop = {
        type: "thread.metadata.update" as const,
        commandId: CommandId.make("noop"),
        threadId,
      };
      const accepted = yield* engine.dispatch(owner, noop, creation);
      expect(accepted.summaryRevision).toBe(initial.revision);

      yield* engine.setMonitors(owner, [{ taskId: "monitor-1", description: "Watching" }]);
      const monitored = (yield* engine.summary(owner))!;
      expect(monitored.revision).toBe(initial.revision + 1);
      expect(monitored.revision).toBeGreaterThan(head);
      expect(monitored.shell.summaryRevision).toBe(monitored.revision);
      expect((yield* engine.snapshot(owner)).snapshotSequence).toBe(head);
      expect(yield* engine.dispatch(owner, noop, creation)).toEqual({
        sequence: accepted.sequence,
        summaryRevision: monitored.revision,
      });

      yield* engine.setMonitors(owner, []);
      const cleared = (yield* engine.summary(owner))!;
      expect(cleared.revision).toBe(monitored.revision + 1);
      expect(cleared.shell.summaryRevision).toBe(cleared.revision);
      yield* engine.acknowledgeSummary(cleared.revision);
      expect(
        yield* engine.dispatch(owner, { ...noop, commandId: CommandId.make("noop-2") }, creation),
      ).toEqual({ sequence: head, summaryRevision: cleared.revision });
      expect(yield* engine.pendingSummary).toBeNull();
    }).pipe(Effect.provide(layerThreadObject(":memory:"))),
  );
});

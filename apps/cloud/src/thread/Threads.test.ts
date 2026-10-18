import {
  CommandId,
  MessageId,
  type OrchestrationV2ThreadStreamItem,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import { describe, expect, it } from "@effect/vitest";
import { applyOrchestrationV2ProjectionEvent } from "@t3tools/client-runtime/state/orchestration-v2-projection";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { makeMemoryObjects } from "../attachments/attachmentTesting.ts";
import * as Environment from "../environment.ts";
import * as Platform from "../platform.ts";
import { layerAttachments, layerPersonalThreadContexts, makeMemoryCloud } from "../testing.ts";
import { scriptedModelSelection } from "./scriptedProvider.ts";
import * as ThreadDirectory from "./ThreadDirectory.ts";
import * as Threads from "./Threads.ts";
import * as ThreadsLive from "./ThreadsLive.ts";
import { jsonLine, wire } from "./threadWire.ts";

const actor = { userId: "user_1", contextIds: [PERSONAL_CONTEXT_ID] };
const threadId = ThreadId.make("thread-1");

describe("Threads", () => {
  it.effect("fails a lost output stream but completes after its final frame", () =>
    Effect.gen(function* () {
      const cloud = makeMemoryCloud();
      for (const running of [true, false]) {
        const transport = ThreadDirectory.handleFor({
          commandOutput: async () =>
            new ReadableStream({
              start: (controller) => {
                controller.enqueue(
                  jsonLine(wire.commandOutputFrame)({
                    kind: "replace",
                    text: "retained output",
                    truncated: false,
                    running,
                    sequence: 7,
                  }),
                );
                controller.close();
              },
            }),
        } as Partial<ThreadDirectory.ThreadObjectApi> as ThreadDirectory.ThreadObjectApi);
        const service = yield* Threads.Threads.pipe(
          Effect.provide(
            Layer.fresh(ThreadsLive.layer).pipe(
              Layer.provide(
                Layer.succeed(ThreadDirectory.ThreadDirectory, {
                  forThread: (id) => ({
                    ...cloud.threadDirectory.forThread(id),
                    commandOutput: transport.commandOutput,
                  }),
                }),
              ),
              Layer.provide(layerPersonalThreadContexts("user_1")),
              Layer.provide(Platform.layerCrypto),
              Layer.provide(layerAttachments(makeMemoryObjects())),
            ),
          ),
        );
        const received: Array<string> = [];
        const result = yield* service
          .commandOutput(actor, {
            threadId,
            itemId: TurnItemId.make("command-1"),
          })
          .pipe(
            Stream.runForEach((frame) => Effect.sync(() => received.push(frame.text))),
            Effect.exit,
          );
        expect(received).toEqual(["retained output"]);
        expect(Exit.isFailure(result)).toBe(running);
        if (Exit.isFailure(result)) {
          expect(Exit.findErrorOption(result)).toMatchObject({
            value: {
              _tag: "OrchestrationV2CommandOutputError",
              message: "Lost the command output stream. Reopen it to read the retained output.",
            },
          });
        }
      }
    }),
  );
  it.effect("resumes a subscription whose thread object went away, with no gap or repeat", () =>
    Effect.gen(function* () {
      const cloud = makeMemoryCloud();
      // The first subscription dies after two batches, as when its object is evicted.
      let subscriptions = 0;
      const subscribed = yield* Deferred.make<void>();
      const disconnected = yield* Deferred.make<void>();
      const flaky: ThreadDirectory.ThreadDirectory["Service"] = {
        forThread: (id) => {
          const handle = cloud.threadDirectory.forThread(id);
          return {
            ...handle,
            subscribe: (who, input) => {
              subscriptions += 1;
              const stream = handle.subscribe(who, input);
              return subscriptions === 1
                ? stream.pipe(
                    Stream.tap(() => Deferred.succeed(subscribed, undefined)),
                    Stream.take(2),
                    Stream.ensuring(Deferred.succeed(disconnected, undefined)),
                  )
                : stream;
            },
          };
        },
      };
      const service = yield* Threads.Threads.pipe(
        Effect.provide(
          // The memory cloud has a reliable transport; this layer injects its eviction failure.
          Layer.fresh(ThreadsLive.layer).pipe(
            Layer.provide(Layer.succeed(ThreadDirectory.ThreadDirectory, flaky)),
            Layer.provide(layerPersonalThreadContexts("user_1")),
            Layer.provide(Platform.layerCrypto),
            Layer.provide(layerAttachments(makeMemoryObjects())),
          ),
        ),
      );

      yield* service.launch(actor, {
        commandId: CommandId.make("launch-1"),
        threadId,
        projectId: Environment.SCRATCH_PROJECT_ID,
        title: "Hello",
        modelSelection: scriptedModelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        initialMessage: { messageId: MessageId.make("message-1"), text: "Hello", attachments: [] },
      });
      const watching = yield* service.subscribe(actor, { threadId }).pipe(
        // Whole batches, through the one that completes the run.
        Stream.takeUntil((batch) =>
          batch.some(
            (item) =>
              item.kind === "event" &&
              item.event.type === "run.updated" &&
              item.event.payload.status === "completed",
          ),
        ),
        Stream.flattenIterable,
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(subscribed);
      yield* cloud.settle;
      yield* Deferred.await(disconnected);
      yield* TestClock.adjust(250);
      const items: ReadonlyArray<OrchestrationV2ThreadStreamItem> = yield* Fiber.join(watching);

      expect(subscriptions).toBeGreaterThan(1);
      const [first, ...rest] = items;
      if (first?.kind !== "snapshot") throw new Error("expected a snapshot first");
      const sequences = rest.flatMap((item) => (item.kind === "event" ? [item.sequence] : []));
      expect(sequences).toEqual(
        Array.from({ length: sequences.length }, (_, index) => first.snapshotSequence + index + 1),
      );
      // Folding what the client received gives the thread object's own projection.
      let projection: typeof first.projection | null = first.projection;
      for (const item of rest) {
        if (item.kind === "event")
          projection = applyOrchestrationV2ProjectionEvent(projection, item.event);
      }
      const snapshot = yield* service.snapshot(actor, threadId);
      expect(projection).toEqual(snapshot.projection);
    }),
  );

  it.effect("gives a launch without a thread id the same thread on every retry", () =>
    Effect.gen(function* () {
      const cloud = makeMemoryCloud();
      const service = yield* Threads.Threads.pipe(Effect.provide(cloud.layerPersonal("user_1")));
      const launch = () =>
        service.launch(actor, {
          commandId: CommandId.make("launch-no-id"),
          projectId: Environment.SCRATCH_PROJECT_ID,
          title: "Hello",
          modelSelection: scriptedModelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          initialMessage: { text: "Hello", attachments: [] },
        });
      const first = yield* launch();
      const retried = yield* launch();
      expect(retried.threadId).toBe(first.threadId);
      expect(retried.resumed).toBe(true);
      expect(retried.projection.runs).toHaveLength(1);
      // Another user's identical command id is a different thread.
      const other = yield* service.launch(
        { userId: "user_2", contextIds: [PERSONAL_CONTEXT_ID] },
        {
          commandId: CommandId.make("launch-no-id"),
          projectId: Environment.SCRATCH_PROJECT_ID,
          title: "Hello",
          modelSelection: scriptedModelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
        },
      );
      expect(other.threadId).not.toBe(first.threadId);
    }),
  );

  it.effect("replays a committed dispatch once and keeps catch-up and access semantics", () =>
    Effect.gen(function* () {
      const cloud = makeMemoryCloud();
      const service = yield* Threads.Threads.pipe(Effect.provide(cloud.layerPersonal("user_1")));
      yield* service.launch(actor, {
        commandId: CommandId.make("launch-empty"),
        threadId,
        projectId: Environment.SCRATCH_PROJECT_ID,
        title: "Before",
        modelSelection: scriptedModelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
      });
      const before = yield* service.snapshot(actor, threadId);
      const command = {
        type: "thread.metadata.update" as const,
        commandId: CommandId.make("rename-once"),
        threadId,
        title: "After",
      };
      const committed = yield* service.dispatch(actor, command);
      expect(yield* service.dispatch(actor, command)).toEqual(committed);
      const snapshot = yield* service.snapshot(actor, threadId);
      expect(snapshot.snapshotSequence).toBe(committed.sequence);
      expect(snapshot.projection.thread.title).toBe("After");

      const replay = yield* service
        .subscribe(actor, {
          threadId,
          afterSequence: before.snapshotSequence,
          requestCompletionMarker: true,
        })
        .pipe(
          Stream.flattenIterable,
          Stream.takeUntil((item) => item.kind === "synchronized"),
          Stream.runCollect,
        );
      expect(replay).toMatchObject([
        { kind: "event", sequence: committed.sequence, event: { type: "thread.metadata-updated" } },
        { kind: "synchronized" },
      ]);
      expect(yield* service.history(actor, threadId)).toMatchObject({
        snapshotSequence: committed.sequence,
        items: [],
        nextCursor: null,
        hasMoreHistory: false,
      });

      const outside = { ...actor, userId: "user_2" };
      expect((yield* Effect.flip(service.snapshot(outside, threadId)))._tag).toBe(
        "ThreadNotFoundError",
      );
      expect(
        (yield* Effect.flip(service.subscribe(outside, { threadId }).pipe(Stream.runCollect)))._tag,
      ).toBe("ThreadNotFoundError");
    }),
  );
});

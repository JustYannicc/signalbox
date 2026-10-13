import {
  CommandId,
  MessageId,
  type OrchestrationV2ThreadStreamItem,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { applyOrchestrationV2ProjectionEvent } from "@t3tools/client-runtime/state/orchestration-v2-projection";

import * as Environment from "../environment.ts";
import * as Platform from "../platform.ts";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import { layerPersonalThreadContexts, makeMemoryCloud } from "../testing.ts";
import * as CloudThreadService from "./CloudThreadService.ts";
import { scriptedModelSelection } from "./scriptedProvider.ts";
import * as ThreadDirectory from "./ThreadDirectory.ts";

const actor = { userId: "user_1", contextIds: [PERSONAL_CONTEXT_ID] };
const threadId = ThreadId.make("thread-1");

describe("CloudThreadService", () => {
  // Live clock: the resume waits a real moment before reconnecting.
  it.live("resumes a subscription whose thread object went away, with no gap or repeat", () =>
    Effect.gen(function* () {
      const cloud = makeMemoryCloud();
      // The first subscription dies after two batches, as when its object is evicted.
      let subscriptions = 0;
      const flaky: ThreadDirectory.ThreadDirectory["Service"] = {
        forThread: (id) => {
          const handle = cloud.threadDirectory.forThread(id);
          return {
            ...handle,
            subscribe: (who, input) => {
              subscriptions += 1;
              const stream = handle.subscribe(who, input);
              return subscriptions === 1 ? Stream.take(stream, 2) : stream;
            },
          };
        },
      };
      const service = yield* CloudThreadService.CloudThreadService.pipe(
        Effect.provide(
          // Fresh: the cloud's own layer already built one over the reliable directory.
          Layer.fresh(CloudThreadService.layer).pipe(
            Layer.provide(Layer.succeed(ThreadDirectory.ThreadDirectory, flaky)),
            Layer.provide(layerPersonalThreadContexts("user_1")),
            Layer.provide(Platform.layerCrypto),
          ),
        ),
      );

      yield* service.launchThread(actor, {
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
      const watching = yield* service.subscribeThread(actor, { threadId }).pipe(
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
      yield* Effect.yieldNow;
      yield* cloud.settle;
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
      const snapshot = yield* service.threadSnapshot(actor, threadId);
      expect(projection).toEqual(snapshot.projection);
    }),
  );

  it.effect("gives a launch without a thread id the same thread on every retry", () =>
    Effect.gen(function* () {
      const cloud = makeMemoryCloud();
      const service = yield* CloudThreadService.CloudThreadService.pipe(
        Effect.provide(cloud.layerPersonal("user_1")),
      );
      const launch = () =>
        service.launchThread(actor, {
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
      const other = yield* service.launchThread(
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
});

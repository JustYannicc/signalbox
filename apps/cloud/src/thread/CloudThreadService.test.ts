import {
  ChatAttachmentId,
  CommandId,
  MessageId,
  type OrchestrationV2ThreadStreamItem,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { applyOrchestrationV2ProjectionEvent } from "@t3tools/client-runtime/state/orchestration-v2-projection";

import { makeMemoryObjects } from "../attachments/attachmentTesting.ts";
import { CloudAttachments } from "../attachments/CloudAttachments.ts";
import * as Environment from "../environment.ts";
import * as Platform from "../platform.ts";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import { layerAttachments, layerPersonalThreadContexts, makeMemoryCloud } from "../testing.ts";
import * as CloudThreadService from "./CloudThreadService.ts";
import { scriptedModelSelection } from "./scriptedProvider.ts";
import * as ThreadDirectory from "./ThreadDirectory.ts";
import { browserBehindLine, browserUpdateLine, previewsLine } from "./threadWire.ts";

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
            Layer.provide(layerAttachments(makeMemoryObjects())),
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

  it.effect("claims queued-edit attachments for their uploader and releases stale copies", () =>
    Effect.gen(function* () {
      const cloud = makeMemoryCloud();
      const service = yield* CloudThreadService.CloudThreadService.pipe(
        Effect.provide(cloud.layerPersonal(actor.userId)),
      );
      const uploads = yield* CloudAttachments.use((service) => Effect.succeed(service)).pipe(
        Effect.provide(layerAttachments(cloud.attachmentObjects)),
      );
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
      const upload = (userId: string, name: string) =>
        Effect.gen(function* () {
          const minted = yield* uploads.issueUpload(userId, {
            name,
            mimeType: "image/png",
            sizeBytes: bytes.length,
          });
          const token = minted.relativeUrl.split("/").at(-1) ?? "";
          const stored = yield* uploads.storeUpload(
            token,
            new Blob([bytes.slice()]).stream(),
            bytes.length,
          );
          if (stored._tag !== "stored") throw new Error("expected the image upload to be stored");
          return {
            type: "image" as const,
            id: ChatAttachmentId.make(minted.attachmentId),
            name,
            mimeType: "image/png",
            sizeBytes: bytes.length,
          };
        });

      const launched = yield* service.launchThread(actor, {
        commandId: CommandId.make("queue-edit-launch"),
        threadId: ThreadId.make("thread-queue-attachments"),
        projectId: Environment.SCRATCH_PROJECT_ID,
        title: "Queued attachment",
        modelSelection: scriptedModelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        initialMessage: { text: "Active", attachments: [] },
      });
      yield* service.dispatchCommand(actor, {
        type: "message.dispatch",
        commandId: CommandId.make("queue-attachment-message"),
        createdBy: "user",
        creationSource: "web",
        threadId: launched.threadId,
        messageId: MessageId.make("queue-attachment-message"),
        text: "Queued message",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        deliveryIntent: "auto",
      });
      const queued = (yield* service.threadSnapshot(actor, launched.threadId)).projection.runs.find(
        (run) => run.status === "queued",
      );
      if (queued === undefined) throw new Error("expected a queued run");

      const owned = yield* upload(actor.userId, "owned.png");
      yield* service.dispatchCommand(actor, {
        type: "queued-run.edit",
        commandId: CommandId.make("queue-edit-owned-attachment"),
        threadId: launched.threadId,
        runId: queued.id,
        text: "Edited with owned attachment",
        attachments: [owned],
      });
      const edited = (yield* service.threadSnapshot(actor, launched.threadId)).projection;
      const editedMessage = edited.messages.find((message) => message.id === queued.userMessageId);
      const copied = editedMessage?.attachments[0];
      if (copied === undefined) throw new Error("expected the owned attachment to be copied");
      expect(editedMessage?.text).toBe("Edited with owned attachment");
      expect(copied.id).not.toBe(owned.id);
      expect(edited.visibleTurnItems).not.toContainEqual(
        expect.objectContaining({
          item: expect.objectContaining({ messageId: queued.userMessageId }),
        }),
      );

      const foreign = yield* upload("user_2", "foreign.png");
      const foreignEdit = yield* Effect.flip(
        service.dispatchCommand(actor, {
          type: "queued-run.edit",
          commandId: CommandId.make("queue-edit-foreign-attachment"),
          threadId: launched.threadId,
          runId: queued.id,
          text: "Should not land",
          attachments: [foreign],
        }),
      );
      expect(foreignEdit).toMatchObject({ _tag: "ThreadCommandRejectedError" });

      const stale = yield* upload(actor.userId, "stale.png");
      yield* service.dispatchCommand(actor, {
        type: "queued-run.cancel",
        commandId: CommandId.make("queue-attachment-cancel"),
        threadId: launched.threadId,
        runId: queued.id,
      });
      const keysBeforeStaleEdit = cloud.attachmentObjects.keys();
      const staleEdit = yield* Effect.flip(
        service.dispatchCommand(actor, {
          type: "queued-run.edit",
          commandId: CommandId.make("queue-edit-stale-attachment"),
          threadId: launched.threadId,
          runId: queued.id,
          text: "Should remain cancelled",
          attachments: [stale],
        }),
      );
      expect(staleEdit).toMatchObject({
        _tag: "ThreadCommandRejectedError",
        reason: `Run ${queued.id} is not queued.`,
      });
      expect(cloud.attachmentObjects.keys()).toEqual(keysBeforeStaleEdit);
      expect(
        (yield* service.threadSnapshot(actor, launched.threadId)).projection.messages.find(
          (message) => message.id === queued.userMessageId,
        ),
      ).toMatchObject({ text: "Edited with owned attachment", attachments: [copied] });
    }),
  );

  it.effect("doesn't reopen a watch whose viewer fell behind the browser", () =>
    Effect.gen(function* () {
      const cloud = makeMemoryCloud();
      let watches = 0;
      const behind = ThreadDirectory.handleFor({
        browserWatch: async () => {
          watches += 1;
          return new ReadableStream({
            start: (controller) => {
              const encoder = new TextEncoder();
              controller.enqueue(encoder.encode(`${browserUpdateLine({ _tag: "offline" })}\n`));
              controller.enqueue(encoder.encode(`${browserBehindLine}\n`));
              controller.close();
            },
          });
        },
      } as Partial<ThreadDirectory.ThreadObjectApi> as ThreadDirectory.ThreadObjectApi);
      const directory: ThreadDirectory.ThreadDirectory["Service"] = {
        forThread: (id) => ({
          ...cloud.threadDirectory.forThread(id),
          browserWatch: behind.browserWatch,
        }),
      };
      const service = yield* CloudThreadService.CloudThreadService.pipe(
        Effect.provide(
          Layer.fresh(CloudThreadService.layer).pipe(
            Layer.provide(Layer.succeed(ThreadDirectory.ThreadDirectory, directory)),
            Layer.provide(layerPersonalThreadContexts("user_1")),
            Layer.provide(Platform.layerCrypto),
            Layer.provide(layerAttachments(makeMemoryObjects())),
          ),
        ),
      );
      const updates: Array<unknown> = [];
      const exit = yield* service.browserWatch(actor, threadId, null).pipe(
        Stream.runForEach((update) => Effect.sync(() => updates.push(update))),
        Effect.exit,
      );
      expect(updates).toEqual([{ _tag: "offline" }]);
      expect(Exit.isFailure(exit) && Exit.findErrorOption(exit)).toMatchObject({
        value: { _tag: "BrowserWatchBehindError" },
      });
      expect(watches).toBe(1);
    }),
  );

  it.effect("reads whether the agent has browsed from the previews stream", () =>
    Effect.gen(function* () {
      const handle = ThreadDirectory.handleFor({
        previews: async () =>
          new ReadableStream({
            start: (controller) => {
              const encoder = new TextEncoder();
              controller.enqueue(encoder.encode(`${previewsLine([], false)}\n`));
              controller.enqueue(encoder.encode(`${previewsLine([], true)}\n`));
              controller.close();
            },
          }),
      } as Partial<ThreadDirectory.ThreadObjectApi> as ThreadDirectory.ThreadObjectApi);
      const seen = yield* Stream.runCollect(handle.previews(actor));
      expect(seen).toEqual([
        { ports: [], browsed: false },
        { ports: [], browsed: true },
      ]);
    }),
  );
});

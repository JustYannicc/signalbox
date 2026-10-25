import { ChatAttachmentId, CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import { CloudAttachments } from "../attachments/CloudAttachments.ts";
import * as Environment from "../environment.ts";
import * as Platform from "../platform.ts";
import { layerPersonalThreadContexts, makeMemoryCloud } from "../testing.ts";
import { scriptedModelSelection } from "./scriptedProvider.ts";
import * as ThreadDirectory from "./ThreadDirectory.ts";
import * as Threads from "./Threads.ts";
import * as ThreadsLive from "./ThreadsLive.ts";

const actor = { userId: "user_1", contextIds: [PERSONAL_CONTEXT_ID] };
const threadId = ThreadId.make("queue-race");

describe("an edit racing a queue transition", () => {
  it.effect.each(["cancel", "start"] as const)(
    "rejects an in-flight attachment edit after %s and releases only its new copies",
    (transition) =>
      Effect.gen(function* () {
        const cloud = makeMemoryCloud();
        const layer = cloud.layerPersonal(actor.userId);
        const service = yield* Threads.Threads.pipe(Effect.provide(layer));
        const attachments = yield* CloudAttachments.pipe(Effect.provide(layer));
        yield* service.launch(actor, {
          commandId: CommandId.make("launch"),
          threadId,
          projectId: Environment.SCRATCH_PROJECT_ID,
          title: "Race",
          modelSelection: scriptedModelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          initialMessage: { text: "Live", attachments: [] },
        });
        yield* service.dispatch(actor, {
          type: "message.dispatch",
          commandId: CommandId.make("queue"),
          createdBy: "user",
          creationSource: "web",
          threadId,
          messageId: MessageId.make("queued-message"),
          text: "Keep this",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
        });
        const queued = (yield* service.snapshot(actor, threadId)).projection.runs[1]!;
        const upload = yield* attachments.issueUpload(actor.userId, {
          type: "file",
          name: "edit.txt",
          mimeType: "text/plain",
          sizeBytes: 1,
        });
        expect(
          yield* attachments.storeUpload(
            upload.relativeUrl.split("/").at(-1)!,
            new Blob(["x"]).stream(),
            1,
          ),
        ).toMatchObject({ _tag: "stored" });
        const keys = cloud.attachmentObjects.keys().toSorted();
        const claimed = yield* Deferred.make<void>();
        const proceed = yield* Deferred.make<void>();
        const gated: ThreadDirectory.ThreadDirectory["Service"] = {
          forThread: (id) => {
            const handle = cloud.threadDirectory.forThread(id);
            return {
              ...handle,
              dispatch: (who, command, creation) =>
                command.type === "queued-run.edit"
                  ? Deferred.succeed(claimed, undefined).pipe(
                      Effect.andThen(Deferred.await(proceed)),
                      Effect.andThen(handle.dispatch(who, command, creation)),
                    )
                  : handle.dispatch(who, command, creation),
            };
          },
        };
        const editor = yield* Threads.Threads.pipe(
          Effect.provide(
            ThreadsLive.layer.pipe(
              Layer.provide(Layer.succeed(ThreadDirectory.ThreadDirectory, gated)),
              Layer.provide(layerPersonalThreadContexts(actor.userId)),
              Layer.provide(Platform.layerCrypto),
              Layer.provide(Layer.succeed(CloudAttachments, attachments)),
            ),
          ),
        );
        const editing = yield* editor
          .dispatch(actor, {
            type: "queued-run.edit",
            commandId: CommandId.make("racing-edit"),
            threadId,
            runId: queued.id,
            text: "Must not replace the delivered message",
            attachments: [
              {
                type: "file",
                id: ChatAttachmentId.make(upload.attachmentId),
                name: "edit.txt",
                mimeType: "text/plain",
                sizeBytes: 1,
              },
            ],
          })
          .pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(claimed);
        expect(cloud.attachmentObjects.keys()).toHaveLength(keys.length + 1);
        if (transition === "cancel") {
          yield* service.dispatch(actor, {
            type: "queued-run.cancel",
            commandId: CommandId.make("cancel"),
            threadId,
            runId: queued.id,
          });
        } else {
          yield* cloud.settle;
        }
        const afterTransition = yield* service.snapshot(actor, threadId);
        yield* Deferred.succeed(proceed, undefined);
        const rejected = yield* Fiber.join(editing);
        expect(rejected).toMatchObject({
          _tag: "ThreadCommandRejectedError",
          commandType: "queued-run.edit",
        });
        expect(cloud.attachmentObjects.keys().toSorted()).toEqual(keys);
        expect((yield* service.snapshot(actor, threadId)).projection.messages).toEqual(
          afterTransition.projection.messages,
        );
        expect(
          afterTransition.projection.messages.find((message) => message.id === "queued-message")
            ?.text,
        ).toBe("Keep this");
      }),
  );
});

import { describe, expect, it } from "@effect/vitest";
import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { makeMemoryObjects } from "../attachments/attachmentTesting.ts";
import * as Environment from "../environment.ts";
import * as Platform from "../platform.ts";
import { layerAttachments } from "../testing.ts";
import { ThreadContexts, ThreadFolderTrashedError } from "../user/threadContexts.ts";
import { scriptedModelSelection } from "./scriptedProvider.ts";
import * as ThreadDirectory from "./ThreadDirectory.ts";
import * as ThreadKindTurns from "./ThreadKindTurns.ts";
import * as Threads from "./Threads.ts";
import * as ThreadsLive from "./ThreadsLive.ts";

const actor = { userId: "user_1", contextIds: [PERSONAL_CONTEXT_ID] };
const threadId = ThreadId.make("blocked-thread");
const commandId = CommandId.make("blocked-command");
const launch = {
  commandId,
  threadId,
  projectId: Environment.SCRATCH_PROJECT_ID,
  title: "Blocked",
  modelSelection: scriptedModelSelection,
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  workspaceStrategy: { type: "root" as const },
};

const cases = [
  { type: "thread.create", checkpoint: "place" },
  { type: "thread.create", checkpoint: "turn" },
  { type: "thread.launch", checkpoint: "place" },
  { type: "thread.launch", checkpoint: "turn" },
  { type: "message.dispatch", checkpoint: "turn" },
  { type: "thread.model-selection.set", checkpoint: "turn" },
] as const;

const attempt = (service: Threads.Threads["Service"], type: (typeof cases)[number]["type"]) => {
  switch (type) {
    case "thread.launch":
      return service.launch(actor, launch).pipe(Effect.asVoid);
    case "thread.create":
      return service
        .dispatch(actor, {
          ...launch,
          type,
          createdBy: "user",
          creationSource: "web",
          branch: null,
          worktreePath: null,
        })
        .pipe(Effect.asVoid);
    case "message.dispatch":
      return service
        .dispatch(actor, {
          type,
          commandId,
          threadId,
          createdBy: "user",
          creationSource: "web",
          messageId: MessageId.make("blocked-message"),
          text: "Blocked",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          deliveryIntent: "auto",
        })
        .pipe(Effect.asVoid);
    case "thread.model-selection.set":
      return service
        .dispatch(actor, {
          type,
          commandId,
          threadId,
          modelSelection: scriptedModelSelection,
        })
        .pipe(Effect.asVoid);
  }
};

describe("Threads with a home in Trash", () => {
  it.effect.each(cases)("rejects $type at its $checkpoint before reaching the thread", (input) =>
    Effect.gen(function* () {
      const contexts = ThreadContexts.of({
        placeOfProject: () =>
          input.checkpoint === "place"
            ? Effect.fail(new ThreadFolderTrashedError())
            : Effect.succeed(null),
        turn: () => Effect.fail(new ThreadFolderTrashedError()),
      });
      const directory = ThreadDirectory.ThreadDirectory.of({
        forThread: () => {
          throw new Error("A blocked command must not reach the thread transport.");
        },
      });
      const service = yield* Threads.Threads.pipe(
        Effect.provide(
          ThreadsLive.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(ThreadContexts, contexts),
                Layer.succeed(ThreadDirectory.ThreadDirectory, directory),
                ThreadKindTurns.layerNone,
                Platform.layerCrypto,
                layerAttachments(makeMemoryObjects()),
              ),
            ),
          ),
        ),
      );

      expect(yield* Effect.flip(attempt(service, input.type))).toMatchObject({
        _tag: "ThreadCommandRejectedError",
        commandId,
        commandType: input.type,
        reason: "This thread's folder is in Trash.",
      });
    }),
  );
});

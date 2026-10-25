import { PERSONAL_POOL_ID } from "@t3tools/contracts/accountHub";
import {
  CommandId,
  MessageId,
  type OrchestrationV2Command,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { layerThreadObject } from "../testing.ts";
import { checkpointEvents } from "./driveEvents.ts";
import { scriptedModelSelection } from "./scriptedProvider.ts";
import * as ThreadEngine from "./ThreadEngine.ts";

/**
 * What a cloud thread does for chats and tasks (#46): archiving and bringing
 * back, which restarts an idle chat's wait, and the summary saying when a
 * turn first changed files.
 */

const owner = { userId: "user_1", contextIds: [PERSONAL_CONTEXT_ID] };
const personal = {
  place: { contextId: PERSONAL_CONTEXT_ID, driveId: "my/personal/user_1" },
  pools: { top: PERSONAL_POOL_ID, projects: {} },
};
const threadId = ThreadId.make("thread-kinds");

const withEngine = <A, E>(
  use: (engine: ThreadEngine.ThreadEngine["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    Layer.build(layerThreadObject(":memory:")).pipe(
      Effect.flatMap((context) => use(Context.get(context, ThreadEngine.ThreadEngine))),
    ),
  );

const launched = (engine: ThreadEngine.ThreadEngine["Service"]) =>
  engine.launch(
    owner,
    {
      commandId: CommandId.make("launch"),
      threadId,
      projectId: ProjectId.make("scratch"),
      title: "Kinds",
      modelSelection: scriptedModelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      initialMessage: { messageId: MessageId.make("message-1"), text: "Hi", attachments: [] },
    },
    personal,
  );

const toIdle = (engine: ThreadEngine.ThreadEngine["Service"]) =>
  Effect.gen(function* () {
    for (let steps = 0; steps < 200; steps++) if (!(yield* engine.step)) return;
    throw new Error("the scripted turn never settled");
  });

let commands = 0;
const command = (type: "thread.archive" | "thread.unarchive"): OrchestrationV2Command => ({
  type,
  commandId: CommandId.make(`${type}-${++commands}`),
  threadId,
});

const rejection = (
  engine: ThreadEngine.ThreadEngine["Service"],
  type: "thread.archive" | "thread.unarchive",
  creation: ThreadEngine.ThreadCreation = personal,
) =>
  engine.dispatch(owner, command(type), creation).pipe(
    Effect.flip,
    Effect.map((error) =>
      error._tag === "ThreadCommandRejectedError" ? error.reason : error._tag,
    ),
  );

const shellOf = (engine: ThreadEngine.ThreadEngine["Service"]) =>
  Effect.map(engine.summary(owner), (summary) => summary!.shell);

describe("cloud thread archive", () => {
  it.effect("archives an idle thread and brings it back, each moving its updatedAt", () =>
    withEngine((engine) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-10-01T00:00:00Z"));
        yield* launched(engine);
        expect(yield* rejection(engine, "thread.archive")).toMatch(/still working/);
        yield* toIdle(engine);
        expect(yield* rejection(engine, "thread.unarchive")).toBe("This thread is not archived.");

        yield* TestClock.setTime(Date.parse("2026-10-08T00:00:00Z"));
        yield* engine.dispatch(owner, command("thread.archive"), personal);
        const archived = yield* shellOf(engine);
        expect(archived.archivedAt).toEqual(DateTime.makeUnsafe("2026-10-08T00:00:00Z"));
        expect(archived.updatedAt).toEqual(DateTime.makeUnsafe("2026-10-08T00:00:00Z"));
        expect(yield* rejection(engine, "thread.archive")).toBe("This thread is already archived.");

        yield* TestClock.setTime(Date.parse("2026-10-09T00:00:00Z"));
        yield* engine.dispatch(owner, command("thread.unarchive"), personal);
        const back = yield* shellOf(engine);
        expect(back.archivedAt).toBeNull();
        // The idle wait counts from here.
        expect(back.updatedAt).toEqual(DateTime.makeUnsafe("2026-10-09T00:00:00Z"));
      }),
    ),
  );

  it.effect("archives an idle chat for the sweep only if nothing changed since it judged", () =>
    withEngine((engine) =>
      Effect.gen(function* () {
        yield* launched(engine);
        yield* toIdle(engine);
        const idleSince = DateTime.toEpochMillis((yield* shellOf(engine)).updatedAt);
        // The sweep saw an older index row: the thread moved on since.
        expect(
          yield* rejection(engine, "thread.archive", { ...personal, idleSinceMs: idleSince - 1 }),
        ).toBe("This thread changed since it went idle.");
        expect((yield* shellOf(engine)).archivedAt).toBeNull();
        yield* engine.dispatch(owner, command("thread.archive"), {
          ...personal,
          idleSinceMs: idleSince,
        });
        expect((yield* shellOf(engine)).archivedAt).not.toBeNull();
      }),
    ),
  );

  it.effect("summarizes when a turn first changed files, and only then", () =>
    withEngine((engine) =>
      Effect.gen(function* () {
        yield* launched(engine);
        yield* toIdle(engine);
        const checkpoint = (files: number) =>
          engine.apply((projection, ctx) =>
            Effect.succeed({
              events: checkpointEvents(
                projection!,
                projection!.runs[0]!,
                {
                  kind: "drive.checkpoint",
                  runId: projection!.runs[0]!.id,
                  start: null,
                  commit: "a".repeat(40),
                  files: Array.from({ length: files }, (_, index) => ({
                    path: `file-${index}.ts`,
                    kind: "modified",
                    additions: 1,
                    deletions: 0,
                  })),
                },
                ctx,
              ),
              result: undefined,
            }),
          );
        // A turn that saved nothing started no work.
        yield* checkpoint(0);
        expect((yield* engine.summary(owner))?.workStartedAt).toBeUndefined();
        const delivered = yield* engine.pendingSummary;
        yield* engine.acknowledgeSummary(delivered!.summary.revision);

        yield* TestClock.setTime(Date.parse("2026-10-02T00:00:00Z"));
        yield* checkpoint(2);
        expect((yield* engine.summary(owner))?.workStartedAt).toEqual(
          DateTime.makeUnsafe("2026-10-02T00:00:00Z"),
        );
        // A new revision for the owner's index, whether or not the sidebar row changed.
        const pending = yield* engine.pendingSummary;
        expect(pending?.summary.revision).toBeGreaterThan(delivered!.summary.revision);
        expect(pending?.summary.workStartedAt).toBeDefined();
      }),
    ),
  );
});

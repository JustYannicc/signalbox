// @effect-diagnostics nodeBuiltinImport:off - the eviction test needs a database file that outlives one object.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import { PERSONAL_POOL_ID } from "@t3tools/contracts/accountHub";
import { CommandId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { layerThreadObject } from "../../testing.ts";
import { scriptedModelSelection } from "../scriptedProvider.ts";
import * as ThreadEngine from "../ThreadEngine.ts";
import { StatusNoteModel } from "./StatusNoteModel.ts";
import * as ThreadStatusNotes from "./ThreadStatusNotes.ts";

/**
 * A thread's status note in its object (#670): the agent's note gives the
 * sidebar row a new summary revision carrying it, survives the object going
 * away, and turns the runtime writes for never ask a model for a turn the
 * agent covered or one that ran on no pool.
 */

const owner = { userId: "user_1", contextIds: [PERSONAL_CONTEXT_ID] };
const threadId = ThreadId.make("thread-status");
const note = {
  nextStep: "You: say whether the draft can go out.",
  whereItGotTo: "The draft is written and checked against last year's numbers.",
};

const directories: Array<string> = [];
afterEach(() => {
  for (const directory of directories.splice(0)) NodeFS.rmSync(directory, { recursive: true });
});
const freshDatabase = () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "thread-status-"));
  directories.push(directory);
  return NodePath.join(directory, "thread.sqlite");
};

/** Every model call the runtime made; none should happen here. */
const modelCalls: Array<string> = [];
const recordingModel = Layer.succeed(
  StatusNoteModel,
  StatusNoteModel.of({
    complete: (request) =>
      Effect.sync(() => {
        modelCalls.push(request.threadId);
        return JSON.stringify(note);
      }),
  }),
);

const withObject = <A, E>(
  filename: string,
  use: (
    engine: ThreadEngine.ThreadEngine["Service"],
    notes: ThreadStatusNotes.ThreadStatusNotes["Service"],
  ) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    Layer.build(layerThreadObject(filename, undefined, { statusNoteModel: recordingModel })).pipe(
      Effect.flatMap((context) =>
        use(
          Context.get(context, ThreadEngine.ThreadEngine),
          Context.get(context, ThreadStatusNotes.ThreadStatusNotes),
        ),
      ),
    ),
  );

const launchAndSettle = (engine: ThreadEngine.ThreadEngine["Service"]) =>
  Effect.gen(function* () {
    yield* engine.launch(
      owner,
      {
        commandId: CommandId.make("launch-1"),
        threadId,
        projectId: ProjectId.make("scratch"),
        title: "Quarterly report",
        modelSelection: scriptedModelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        initialMessage: {
          messageId: MessageId.make("message-1"),
          text: "Draft it",
          attachments: [],
        },
      },
      {
        place: { contextId: PERSONAL_CONTEXT_ID, driveId: "my/personal/user_1" },
        pools: { top: PERSONAL_POOL_ID, projects: {} },
      },
    );
    while (yield* engine.step) {
      // The scripted turn, to its end.
    }
  });

describe("thread status notes", () => {
  it.effect("the agent's note joins the summary under a new revision, and stays", () =>
    Effect.gen(function* () {
      const filename = freshDatabase();
      const delivered = yield* withObject(filename, (engine, notes) =>
        Effect.gen(function* () {
          yield* launchAndSettle(engine);
          const before = (yield* engine.pendingSummary)!.summary;
          expect(before.statusNote).toBeUndefined();
          yield* engine.acknowledgeSummary(before.revision);

          const written = yield* notes.write(note);
          const [run] = (yield* engine.projection)!.runs;
          expect(written).toMatchObject({ ...note, writtenBy: "agent", runId: run!.id });
          const after = (yield* engine.pendingSummary)!.summary;
          expect(after.revision).toBeGreaterThan(before.revision);
          expect(after.statusNote).toEqual(written);

          // A changed note moves the row again.
          yield* engine.acknowledgeSummary(after.revision);
          const changed = yield* notes.write({ ...note, nextStep: "Agent: send it out." });
          const next = (yield* engine.pendingSummary)!.summary;
          expect(next.revision).toBeGreaterThan(after.revision);
          expect(next.statusNote).toEqual(changed);
          yield* notes.write(note);

          expect(yield* notes.line).toMatchObject({
            threadId,
            title: "Quarterly report",
            state: "idle",
            headline: "Idle",
            waitingOn: null,
            note: { ...note, writtenBy: "agent" },
          });
          return yield* engine.statusNote;
        }),
      );
      // The object went away; its note didn't.
      yield* withObject(filename, (engine) =>
        Effect.gen(function* () {
          expect(yield* engine.statusNote).toEqual(delivered);
          expect((yield* engine.summary(owner))?.statusNote).toEqual(delivered);
        }),
      );
    }),
  );

  it.effect("the runtime asks no model for a turn that ran on no pool", () =>
    withObject(":memory:", (engine, notes) =>
      Effect.gen(function* () {
        modelCalls.length = 0;
        yield* launchAndSettle(engine);
        expect(yield* notes.dueAt(0)).toBe(0);
        expect(yield* notes.tend(0)).toBeNull();
        expect(yield* notes.dueAt(0)).toBeNull();
        expect(modelCalls).toEqual([]);
        expect(yield* engine.statusNote).toBeNull();
      }),
    ),
  );

  it.effect("drops the runtime's note once a newer turn is live", () =>
    withObject(":memory:", (engine) =>
      Effect.gen(function* () {
        yield* launchAndSettle(engine);
        const [run] = (yield* engine.projection)!.runs;
        expect(
          yield* engine.writeStatusNote(note, { author: "runtime", runId: run!.id }),
        ).toMatchObject({ writtenBy: "runtime", runId: run!.id });
        yield* engine.dispatch(
          owner,
          {
            type: "message.dispatch",
            commandId: CommandId.make("send-2"),
            createdBy: "user",
            creationSource: "web",
            threadId,
            messageId: MessageId.make("message-2"),
            text: "Shorter, please",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            deliveryIntent: "auto",
          },
          { place: null, pools: { top: PERSONAL_POOL_ID, projects: {} } },
        );
        expect(
          yield* engine.writeStatusNote(note, { author: "runtime", runId: run!.id }),
        ).toBeNull();
      }),
    ),
  );
});

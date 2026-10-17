import { makeSecretScrubber } from "@signalbox/runner-protocol/SecretScrubber";
import type { ThreadStatusAnswer } from "@signalbox/runner-protocol/StatusLineProtocol";
import {
  threadStatusHeadline,
  threadStatusLine,
} from "@t3tools/client-runtime/state/threadStatusLine";
import type { OrchestrationV2Run, OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import type {
  ThreadStatusNote,
  ThreadStatusNoteInput,
} from "@t3tools/contracts/signalboxStatusLine";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { poolIdOfInstance } from "../providerCatalog.ts";
import * as ThreadEngine from "../ThreadEngine.ts";
import * as ThreadStore from "../ThreadStore.ts";
import { StatusNoteModel } from "./StatusNoteModel.ts";
import {
  afterFailedAttempt,
  afterWrite,
  decideStatusNote,
  MAX_NOTE_ATTEMPTS,
  noteView,
  type StatusNoteStep,
} from "./statusNotePolicy.ts";
import { NOTE_SYSTEM, notePrompt, parseNote } from "./statusNotePrompt.ts";
import { readCursor, type StatusNoteCursor, writeCursor } from "./statusNoteTables.ts";

/**
 * A thread's status note in its object (#670): the line its agent reads and
 * writes through the Runner's tools (`drive/statusLineRoutes.ts`), and the
 * runtime's enforcement. After every turn that ends without the agent writing
 * the note, the object's alarm writes one from the turn with a short model
 * call (`StatusNoteModel`), at least once, retried with a backoff and given
 * up after a few tries (`statusNotePolicy.ts`). Spans carry ids only, never
 * what the note or the turn says.
 */

export class ThreadStatusNotes extends Context.Service<
  ThreadStatusNotes,
  {
    /** The thread's line as its agent reads it; null before the thread exists. */
    readonly line: Effect.Effect<ThreadStatusAnswer | null>;
    /** The agent's own note, for the run that's live (else the latest). */
    readonly write: (
      input: ThreadStatusNoteInput,
    ) => Effect.Effect<ThreadStatusNote, ThreadEngine.ThreadNotFoundError>;
    /** When the runtime has work: now, or when a failed write's backoff ends. Null: none. */
    readonly dueAt: (now: number) => Effect.Effect<number | null>;
    /** Does the runtime's work; answers when to look again. */
    readonly tend: (now: number) => Effect.Effect<number | null>;
  }
>()("@signalbox/cloud/thread/statusLine/ThreadStatusNotes") {}

interface Situation {
  readonly projection: OrchestrationV2ThreadProjection;
  readonly note: ThreadStatusNote | null;
  readonly stored: StatusNoteCursor | null;
  readonly step: StatusNoteStep;
}

/** Steps one `tend` takes at most: moving past skipped runs, then one write. */
const MAX_STEPS = 8;

const make = Effect.gen(function* () {
  const engine = yield* ThreadEngine.ThreadEngine;
  const store = yield* ThreadStore.ThreadStore;
  const model = yield* StatusNoteModel;
  const sql = yield* SqlClient.SqlClient;
  const cursor = Effect.orDie(readCursor.pipe(Effect.provideService(SqlClient.SqlClient, sql)));
  const saveCursor = (next: Parameters<typeof writeCursor>[0]) =>
    Effect.orDie(writeCursor(next).pipe(Effect.provideService(SqlClient.SqlClient, sql)));

  /** What the runtime should do now; null before the thread exists. */
  const step = (now: number): Effect.Effect<Situation | null> =>
    Effect.gen(function* () {
      const projection = yield* engine.projection;
      if (projection === null) return null;
      const note = yield* engine.statusNote;
      const stored = yield* cursor;
      return { projection, note, stored, step: decideStatusNote(projection, note, stored, now) };
    });

  const line: ThreadStatusNotes["Service"]["line"] = Effect.gen(function* () {
    // A thread not created yet has no tables to read.
    if ((yield* engine.projection) === null) return null;
    const owner = yield* Effect.orDie(store.owner);
    if (owner === null) return null;
    // Its owner's summary: the same shell and note the sidebar has.
    const summary = yield* engine.summary({ userId: owner.userId, contextIds: [] });
    if (summary === null) return null;
    const statusLine = threadStatusLine(summary.shell, summary.statusNote);
    return {
      threadId: summary.threadId,
      title: summary.shell.title,
      state: statusLine.state,
      headline: threadStatusHeadline(statusLine),
      waitingOn: statusLine.waitingOn,
      note: statusLine.note === null ? null : noteView(statusLine.note),
    };
  });

  const write: ThreadStatusNotes["Service"]["write"] = (input) =>
    engine.writeStatusNote(input, { author: "agent" }).pipe(
      // Only the runtime's write is ever dropped.
      Effect.filterOrElse(
        (note): note is ThreadStatusNote => note !== null,
        () => Effect.die("An agent's note was dropped."),
      ),
    );

  const dueAt: ThreadStatusNotes["Service"]["dueAt"] = (now) =>
    Effect.map(step(now), (current) => {
      if (current === null) return null;
      switch (current.step._tag) {
        case "none":
          return null;
        case "wait":
          return current.step.at;
        case "advance":
        case "write":
          return now;
      }
    });

  /** Asks the pool's model for `run`'s note and writes it. Fails with why it couldn't. */
  const attempt = (current: Situation, run: OrchestrationV2Run) =>
    Effect.gen(function* () {
      const owner = yield* Effect.orDie(store.owner);
      const poolId = poolIdOfInstance(run.providerInstanceId);
      if (owner === null || poolId === undefined) return yield* Effect.fail("no pool");
      // The model never sees the thread's secrets (#591), as no turn's request does.
      const scrubber = makeSecretScrubber((yield* Effect.orDie(store.secretValues)).values);
      const answer = yield* model
        .complete({
          ownerId: owner.userId,
          poolId,
          threadId: current.projection.thread.id,
          runModel: run.modelSelection.model,
          system: NOTE_SYSTEM,
          prompt: scrubber.text(notePrompt(current.projection, run, current.note)),
        })
        .pipe(Effect.mapError((error) => error.reason));
      const input = parseNote(answer);
      if (input === null) return yield* Effect.fail("the model's answer wasn't a note");
      // Null: a newer turn started meanwhile, and its end decides the note.
      yield* engine.writeStatusNote(input, { author: "runtime", runId: run.id });
    }).pipe(Effect.catchTags({ ThreadNotFoundError: () => Effect.fail("the thread is gone") }));

  const tend: ThreadStatusNotes["Service"]["tend"] = (now) =>
    Effect.gen(function* () {
      for (let taken = 0; taken < MAX_STEPS; taken++) {
        const current = yield* step(now);
        if (current === null) return null;
        const next = current.step;
        switch (next._tag) {
          case "none":
            return null;
          case "wait":
            return next.at;
          case "advance":
            yield* saveCursor(next.cursor);
            continue;
          case "write": {
            const { run, attempt: tries } = next;
            const failed = yield* attempt(current, run).pipe(
              Effect.as(null),
              Effect.catch((reason) => Effect.succeed(reason)),
              Effect.withSpan("ThreadStatusNotes.runtimeNote", {
                attributes: {
                  "thread.id": current.projection.thread.id,
                  "run.id": run.id,
                  attempt: tries,
                },
              }),
            );
            if (failed === null) {
              yield* saveCursor(afterWrite(run));
              continue;
            }
            const after = afterFailedAttempt(current.stored, run, tries, now);
            yield* saveCursor(after);
            yield* Effect.logWarning("runtime status note failed", {
              threadId: current.projection.thread.id,
              runId: run.id,
              attempt: tries,
              reason: failed,
            });
            // Out of tries: the next step moves on to later runs.
            if (tries >= MAX_NOTE_ATTEMPTS) continue;
            return after.nextAt;
          }
        }
      }
      return now;
    });

  return ThreadStatusNotes.of({ line, write, dueAt, tend });
});

export const layer = Layer.effect(ThreadStatusNotes, make);

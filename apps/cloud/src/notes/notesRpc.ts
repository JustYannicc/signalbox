import type { ModelSelection, ProjectId } from "@t3tools/contracts";
import {
  type NoteAcceptInput,
  type NoteCreateInput,
  type NoteIdInput,
  type NoteUpdateInput,
  SIGNALBOX_NOTES_WS_METHODS,
  SignalboxNoteError,
} from "@t3tools/contracts/signalboxNotes";
import * as Effect from "effect/Effect";
import type { SqlError } from "effect/sql/SqlError";
import * as Stream from "effect/Stream";

import { NoteRefusedError, UserNotes } from "./UserNotes.ts";

/** The notes RPCs a client calls on the user's object (`user/rpc.ts`). */
export const NOTES_METHODS = Object.values(SIGNALBOX_NOTES_WS_METHODS);

/** A notes call as an RPC answers it: refusals for the user, storage failures logged. */
const noteCall = <A>(
  effect: Effect.Effect<A, NoteRefusedError | SqlError>,
): Effect.Effect<A, SignalboxNoteError> =>
  effect.pipe(
    Effect.catchTags({
      NoteRefusedError: (error) => Effect.fail(new SignalboxNoteError({ message: error.message })),
      SqlError: (cause) =>
        Effect.logError("cloud notes storage failed", { cause }).pipe(
          Effect.andThen(
            Effect.fail(new SignalboxNoteError({ message: "Could not load or change notes." })),
          ),
        ),
    }),
  );

/**
 * `newThreadModel` is what a new thread of the person's starts on, which an
 * accepted note's task runs on when the client names no model.
 */
export const makeNotesHandlers = Effect.fn("makeNotesHandlers")(function* (options: {
  readonly newThreadModel: (projectId?: ProjectId) => Effect.Effect<ModelSelection | null>;
}) {
  const notes = yield* UserNotes;
  const methods = SIGNALBOX_NOTES_WS_METHODS;
  return {
    [methods.subscribe]: () =>
      notes.changes.pipe(
        Stream.tapError((cause) => Effect.logError("cloud notes stream failed", { cause })),
        Stream.mapError(() => new SignalboxNoteError({ message: "Could not load your notes." })),
      ),
    [methods.create]: (request: NoteCreateInput) => noteCall(notes.create(request)),
    [methods.update]: (request: NoteUpdateInput) => noteCall(notes.update(request)),
    [methods.delete]: (request: NoteIdInput) => noteCall(notes.delete(request)),
    [methods.readAgain]: (request: NoteIdInput) => noteCall(notes.readAgain(request)),
    [methods.dismissReading]: (request: NoteIdInput) => noteCall(notes.dismissReading(request)),
    [methods.accept]: (request: NoteAcceptInput) =>
      noteCall(
        Effect.gen(function* () {
          const modelSelection = request.modelSelection ?? (yield* options.newThreadModel());
          if (modelSelection === null) {
            return yield* new NoteRefusedError({
              message: "Add an account to a pool first: the task runs on your pool.",
            });
          }
          return yield* notes.accept({ id: request.id, modelSelection });
        }),
      ),
  };
});

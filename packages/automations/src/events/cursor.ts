import { AutomationError, RunId, WorkflowEventCursor } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const invalidCursor = () =>
  new AutomationError({
    message: "w.waitFor `after` must be an event cursor captured by this run.",
  });
const decodeCursor = Schema.decodeUnknownEffect(WorkflowEventCursor);

/** Validates both the cursor shape and its owner before it can filter a run's inbox. */
export const eventCursorForRun = (value: unknown, runId: string) =>
  decodeCursor(value).pipe(
    Effect.mapError(invalidCursor),
    Effect.flatMap((cursor) =>
      cursor.runId === RunId.make(runId) ? Effect.succeed(cursor) : Effect.fail(invalidCursor()),
    ),
  );

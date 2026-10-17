import { RunId, TurnItemId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import {
  appendRetainedOutput,
  type CommandOutputDelta,
  type CommandOutputKey,
  MAX_COMMAND_OUTPUT_TAILS,
  type RetainedCommandOutput,
} from "./retainedOutput.ts";

export const migrateCommandOutput = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE command_output_cursor (id INTEGER PRIMARY KEY CHECK (id = 1), sequence INTEGER NOT NULL)`;
  yield* sql`INSERT INTO command_output_cursor (id, sequence) VALUES (1, 0)`;
  yield* sql`CREATE TABLE command_output (
    item_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    resume_text TEXT NOT NULL,
    truncated INTEGER NOT NULL,
    has_chunks INTEGER NOT NULL,
    revision INTEGER NOT NULL
  )`;
});

const decodeSequence = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ sequence: Schema.Number })),
);

export const readCommandOutputSequence = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return (
    decodeSequence(yield* sql`SELECT sequence FROM command_output_cursor WHERE id = 1`)[0]
      ?.sequence ?? 0
  );
});

export const advanceCommandOutputSequence = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE command_output_cursor SET sequence = sequence + 1 WHERE id = 1`;
});

const decodeRows = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      item_id: TurnItemId,
      run_id: RunId,
      resume_text: Schema.String,
      truncated: Schema.Number,
      has_chunks: Schema.Number,
    }),
  ),
);

export const readCommandOutput = (key: CommandOutputKey) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = decodeRows(
      yield* sql`SELECT item_id, run_id, resume_text, truncated, has_chunks FROM command_output
        WHERE item_id = ${key.itemId} AND run_id = ${key.runId}`,
    );
    return row === undefined
      ? null
      : { text: row.resume_text, truncated: row.truncated !== 0, hasChunks: row.has_chunks !== 0 };
  });

/** The caller's transaction also commits the Runner batch acknowledgement. */
export const writeCommandOutput = (
  seeds: ReadonlyArray<CommandOutputKey>,
  deltas: ReadonlyArray<CommandOutputDelta>,
) =>
  Effect.gen(function* () {
    if (seeds.length === 0 && deltas.length === 0) return;
    const sql = yield* SqlClient.SqlClient;
    const write = (key: CommandOutputKey, output: RetainedCommandOutput) =>
      sql`INSERT INTO command_output (item_id, run_id, resume_text, truncated, has_chunks, revision)
        SELECT ${key.itemId}, ${key.runId}, ${output.text}, ${output.truncated ? 1 : 0}, ${output.hasChunks ? 1 : 0},
          COALESCE(MAX(revision), 0) + 1 FROM command_output WHERE true
        ON CONFLICT (item_id) DO UPDATE SET run_id = excluded.run_id,
          resume_text = excluded.resume_text, truncated = excluded.truncated, has_chunks = excluded.has_chunks,
          revision = excluded.revision`;
    for (const key of seeds) yield* write(key, { text: "", truncated: false });
    for (const delta of deltas) {
      const previous = yield* readCommandOutput(delta);
      yield* write(delta, appendRetainedOutput(previous, delta.chunk));
    }
    yield* sql`DELETE FROM command_output WHERE item_id NOT IN (
      SELECT item_id FROM command_output ORDER BY revision DESC LIMIT ${MAX_COMMAND_OUTPUT_TAILS}
    )`;
  });
